use anyhow::{bail, Context, Result};
use std::sync::Arc;
use termx_host::{config, history, paths, registry::Registry, server};

#[cfg(test)]
#[path = "../tests/support/mod.rs"]
mod test_support;

/// Strict CLI parse: `--data-dir <path>` only. A typo'd flag or a missing
/// value is an error, not a silent fall-through to the default data dir
/// (which would quietly run against the wrong state).
fn parse_args_from(mut args: impl Iterator<Item = String>) -> Result<Option<std::path::PathBuf>> {
    let mut dir = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir" => {
                let value = args.next().context("--data-dir requires a value")?;
                dir = Some(std::path::PathBuf::from(value));
            }
            other => bail!("unknown argument: {other} (usage: termx-host [--data-dir <path>])"),
        }
    }
    Ok(dir)
}

/// Is the pid recorded in runtime.json a live termx-host process?
/// Some(false) means verified NOT ours (dead pid, or reused by a stranger);
/// None means tasklist itself failed and we could not verify either way.
/// A bare TCP probe alone is not enough: after a crash the port can be
/// reused by ANY process, and a stale runtime.json would then brick startup
/// forever ("already running" against a stranger's socket).
fn pid_is_termx_host(pid: u32) -> Option<bool> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW: headless daemon
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&out.stdout)
            .to_ascii_lowercase()
            .contains("termx-host"),
    )
}

fn runtime_owner_is_reachable(pid_matches: Option<bool>, port_reachable: bool) -> bool {
    pid_matches != Some(false) && port_reachable
}

/// Whether a live host already serves this data dir. Unreadable or malformed
/// discovery state fails closed, but an unreachable recorded listener is stale:
/// Windows can reuse the old pid for another termx-host serving another data dir.
fn already_running(data_dir: &std::path::Path) -> Result<Option<server::RuntimeInfo>> {
    let path = paths::runtime_file(data_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    let info: server::RuntimeInfo =
        serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
    let pid_matches = pid_is_termx_host(info.pid);
    let port_reachable = std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], info.port)),
        std::time::Duration::from_millis(500),
    )
    .is_ok();
    if runtime_owner_is_reachable(pid_matches, port_reachable) {
        Ok(Some(info))
    } else {
        Ok(None)
    }
}

/// Delete aged rotated logs (host.log.YYYY-MM-DD): a daemon that runs for
/// months must not grow an unbounded logs dir. Age = file mtime.
fn clean_old_logs(dir: &std::path::Path, keep: std::time::Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().starts_with("host.log") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|mtime| now.duration_since(mtime).ok())
            .is_some_and(|age| age > keep);
        if stale {
            #[cfg(test)]
            test_support::preserve_before_remove_if_needed(&entry.path(), "old-host-log-cleanup")
                .expect("preserve or validate synthetic host log before cleanup");
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn main() -> Result<()> {
    // Agent helpers inherit the user's terminal handles and must run before
    // daemon argument parsing or logging. In particular, capture hooks are a
    // silent interface and launch argv must never enter host diagnostics.
    if let Some(code) = termx_host::agent_launch::dispatch_early(std::env::args_os().skip(1)) {
        std::process::exit(code);
    }
    let override_dir = parse_args_from(std::env::args().skip(1))?;
    let data_dir = paths::resolve_data_dir(override_dir.as_deref())?;

    let logs = paths::logs_dir(&data_dir);
    std::fs::create_dir_all(&logs).context("creating logs dir")?;
    clean_old_logs(&logs, std::time::Duration::from_secs(14 * 24 * 3600));
    let file_appender = tracing_appender::rolling::daily(&logs, "host.log");
    let (file_writer, _guard) = tracing_appender::non_blocking(file_appender);
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(file_writer)
                .with_ansi(false),
        )
        .init();

    // Panics in session threads (reader/writer/waiter) or detached tasks
    // otherwise vanish — stderr is discarded when the UI spawns the daemon.
    // Log them before the default handler runs.
    let default_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        tracing::error!("panic: {info}");
        default_panic(info);
    }));

    // Keep the logging guard alive while the whole host body runs, then log
    // the complete anyhow chain before returning it. The UI launches this
    // daemon with stderr discarded, so an unlogged startup/runtime error is
    // otherwise indistinguishable from "nothing happened."
    let result = (|| -> Result<()> {
        if let Some(info) = already_running(&data_dir)? {
            println!(
                "termx-host already running (pid {}, port {})",
                info.pid, info.port
            );
            return Ok(());
        }
        let cfg = config::load_or_create(&data_dir)?;
        // ConPTY sessions cannot outlive the daemon that owns them, so every
        // spill file on disk belongs to a session that no longer exists.
        // Sweeping here (after already_running proved we are the only host for
        // this data dir) keeps a machine that crashes often from accumulating
        // orphaned history forever.
        history::sweep_all(&data_dir);
        tracing::info!("termx-host starting; data dir {}", data_dir.display());

        let runtime = tokio::runtime::Runtime::new().context("tokio runtime")?;
        runtime.block_on(async {
            let reg = Arc::new(Registry::new(data_dir.clone(), cfg));
            let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
            let shutdown_for_signals = shutdown_tx.clone();
            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            let server_task = tokio::spawn(server::run(
                Arc::clone(&reg),
                data_dir.clone(),
                shutdown_tx,
                ready_tx,
            ));
            match ready_rx.await {
                Ok(info) => tracing::info!("listening on 127.0.0.1:{}", info.port),
                Err(_) => {
                    // Surface the ACTUAL failure (bind error, runtime.json write...)
                    // instead of a generic "failed before ready".
                    let cause = match server_task.await {
                        Ok(Err(e)) => format!("{e:#}"),
                        Ok(Ok(())) => "server exited before signaling ready".to_string(),
                        Err(join_err) => format!("server task panicked: {join_err}"),
                    };
                    anyhow::bail!("server failed to start: {cause}");
                }
            }
            // Wait for the shutdown-flag flip (client Shutdown) OR a console
            // control event. Ctrl+C, window close, logoff, and system shutdown
            // must run the SAME teardown as a client Shutdown — skipping
            // shutdown_all orphans OpenConsole processes that spin at 100% CPU.
            // Windows grants close/logoff handlers ~5s, matching shutdown_all's
            // bounded wait; the session teardown runs first, cosmetics last.
            let console_shutdown = |why: &str| {
                tracing::info!("console control event ({why}); tearing sessions down");
                reg.shutdown_all();
                let _ = shutdown_for_signals.send(true);
            };
            let mut ctrl_c = tokio::signal::windows::ctrl_c().context("ctrl_c handler")?;
            let mut ctrl_break =
                tokio::signal::windows::ctrl_break().context("ctrl_break handler")?;
            let mut ctrl_close =
                tokio::signal::windows::ctrl_close().context("ctrl_close handler")?;
            let mut ctrl_logoff =
                tokio::signal::windows::ctrl_logoff().context("ctrl_logoff handler")?;
            let mut ctrl_shutdown =
                tokio::signal::windows::ctrl_shutdown().context("ctrl_shutdown handler")?;
            loop {
                tokio::select! {
                    changed = shutdown_rx.changed() => {
                        if changed.is_err() || *shutdown_rx.borrow() {
                            break;
                        }
                    }
                    _ = ctrl_c.recv() => { console_shutdown("ctrl_c"); break; }
                    _ = ctrl_break.recv() => { console_shutdown("ctrl_break"); break; }
                    _ = ctrl_close.recv() => { console_shutdown("window close"); break; }
                    _ = ctrl_logoff.recv() => { console_shutdown("logoff"); break; }
                    _ = ctrl_shutdown.recv() => { console_shutdown("system shutdown"); break; }
                }
            }
            match server_task.await {
                Ok(Ok(())) => {
                    tracing::info!("termx-host exiting cleanly");
                    Ok(())
                }
                Ok(Err(error)) => Err(error).context("server stopped after startup"),
                Err(error) => Err(error).context("server task panicked after startup"),
            }
        })
    })();
    if let Err(error) = &result {
        tracing::error!("fatal host error: {error:#}");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> impl Iterator<Item = String> {
        list.iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn parse_args_accepts_data_dir_and_rejects_garbage() {
        assert_eq!(parse_args_from(args(&[])).unwrap(), None);
        assert_eq!(
            parse_args_from(args(&["--data-dir", r"C:\x"])).unwrap(),
            Some(std::path::PathBuf::from(r"C:\x"))
        );
        assert!(
            parse_args_from(args(&["--data-dir"])).is_err(),
            "missing value must error"
        );
        assert!(
            parse_args_from(args(&["--dtaa-dir", r"C:\x"])).is_err(),
            "typo'd flag must error, not silently use the default dir"
        );
    }

    #[test]
    fn stale_runtime_json_with_foreign_listener_is_not_already_running() {
        // A dead pid + a random process listening on the recorded port is the
        // post-crash port-reuse scenario; startup must NOT be blocked.
        let tmp = test_support::retained_dir().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // A REAL dead pid: spawn-and-reap a throwaway process. (An absurd
        // out-of-range pid makes tasklist error, which correctly takes the
        // conservative can't-verify path instead of the stale path.)
        let dead_pid = {
            let mut child = std::process::Command::new("cmd")
                .args(["/c", "exit"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let pid = child.id();
            child.wait().unwrap();
            pid
        };
        let stale = server::RuntimeInfo {
            port,
            token: "dead".into(),
            pid: dead_pid,
            version: "0.0.0".into(),
        };
        std::fs::write(
            paths::runtime_file(tmp.path()),
            serde_json::to_string(&stale).unwrap(),
        )
        .unwrap();
        assert!(
            already_running(tmp.path()).unwrap().is_none(),
            "foreign listener + dead pid must be treated as stale"
        );
    }

    #[test]
    fn reused_termx_host_pid_with_unreachable_port_is_stale() {
        assert!(
            !runtime_owner_is_reachable(Some(true), false),
            "same executable name cannot prove ownership after Windows reuses a PID"
        );
    }

    #[test]
    fn missing_runtime_json_is_not_already_running() {
        let tmp = test_support::retained_dir().unwrap();
        assert!(already_running(tmp.path()).unwrap().is_none());
    }

    #[test]
    fn malformed_runtime_json_fails_closed() {
        let tmp = test_support::retained_dir().unwrap();
        std::fs::write(paths::runtime_file(tmp.path()), "{ not json").unwrap();
        let err = already_running(tmp.path()).unwrap_err();
        assert!(
            err.to_string().contains("parsing"),
            "corrupt discovery state must stop startup, not launch a second host: {err:#}"
        );
    }

    #[test]
    fn clean_old_logs_removes_only_stale_host_logs() {
        let tmp = test_support::retained_dir().unwrap();
        let log = tmp.path().join("host.log.2020-01-01");
        let other = tmp.path().join("keep-me.txt");
        std::fs::write(&log, "old").unwrap();
        std::fs::write(&other, "unrelated").unwrap();
        // Generous window: nothing qualifies as stale.
        clean_old_logs(tmp.path(), std::time::Duration::from_secs(3600));
        assert!(log.exists() && other.exists());
        // Zero window: any measurable age is stale — but only host.log files.
        std::thread::sleep(std::time::Duration::from_millis(50));
        clean_old_logs(tmp.path(), std::time::Duration::ZERO);
        assert!(!log.exists(), "stale rotated log must be removed");
        assert!(other.exists(), "non-log files must never be touched");
    }

    #[test]
    fn test_log_cleanup_refuses_to_delete_when_preservation_rejects_a_reparse_subject() {
        let tmp = test_support::retained_dir().unwrap();
        let target = tmp.path().join("outside-log.txt");
        std::fs::write(&target, b"log bytes must survive").unwrap();
        let link = tmp.path().join("host.log.linked");
        std::os::windows::fs::symlink_file(&target, &link).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));

        let outcome =
            std::panic::catch_unwind(|| clean_old_logs(tmp.path(), std::time::Duration::ZERO));

        assert!(outcome.is_err(), "test log cleanup must fail closed");
        assert!(link.exists(), "the unpreserved log link was removed");
        assert_eq!(std::fs::read(target).unwrap(), b"log bytes must survive");
    }
}
