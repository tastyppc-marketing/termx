//! Native host bootstrap: discover a live M1 host via `runtime.json`, or spawn
//! one and wait until it becomes discoverable.
//!
//! Returns `{port, token}` to the renderer once. The token is held in memory only
//! for the invoke result — never logged, never written elsewhere by this module.

use crate::paths::{self, runtime_file};
use serde::{Deserialize, Serialize};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// CREATE_NO_WINDOW — no console flash when the UI spawns the daemon.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// DETACHED_PROCESS — host outlives the UI.
#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;

/// Serializes bootstrap attempts so two concurrent invokes do not race-spawn.
static BOOTSTRAP_LOCK: Mutex<()> = Mutex::new(());

/// Discovery document written by `termx-host` (M1 `RuntimeInfo` shape).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub version: String,
}

/// Closed renderer bootstrap result: loopback port + bearer token only.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BootstrapResult {
    pub port: u16,
    pub token: String,
}

impl From<RuntimeInfo> for BootstrapResult {
    fn from(info: RuntimeInfo) -> Self {
        Self {
            port: info.port,
            token: info.token,
        }
    }
}

/// Options for tests and future config; production uses defaults.
#[derive(Clone, Debug, Default)]
pub struct BootstrapOptions {
    /// When set, both discovery and spawn use this data dir (`--data-dir`).
    pub data_dir: Option<PathBuf>,
    /// Override host executable (tests inject a known binary path).
    pub host_exe: Option<PathBuf>,
    /// How long to wait for `runtime.json` after spawn (default 10s).
    pub ready_timeout: Option<Duration>,
}

/// Tauri command: discover or start the host and return port+token once.
/// Async: the spawn+poll path can block for up to 10s (TCP probes, tasklist,
/// readiness loop) and must never run on the main/IPC thread — a frozen
/// window on cold start is exactly the "test app" feel we're avoiding.
#[tauri::command]
pub async fn bootstrap_host() -> Result<BootstrapResult, String> {
    tauri::async_runtime::spawn_blocking(|| bootstrap_with(BootstrapOptions::default()))
        .await
        .map_err(|e| format!("bootstrap task failed: {e}"))?
}

/// Core bootstrap used by the command and by unit/integration tests.
pub fn bootstrap_with(opts: BootstrapOptions) -> Result<BootstrapResult, String> {
    let _guard = BOOTSTRAP_LOCK
        .lock()
        .map_err(|_| "bootstrap lock poisoned".to_string())?;

    let data_dir = paths::resolve_data_dir(opts.data_dir.as_deref())?;
    let timeout = opts.ready_timeout.unwrap_or(Duration::from_secs(10));

    if let Some(info) = read_live_runtime(&data_dir)? {
        return Ok(info.into());
    }

    let host_exe = match opts.host_exe {
        Some(p) => p,
        None => resolve_host_exe()?,
    };
    spawn_host(&host_exe, &data_dir)?;
    let info = wait_for_live_runtime(&data_dir, timeout)?;
    Ok(info.into())
}

/// Read `runtime.json` if present and parse it. Missing file → `Ok(None)`.
/// Malformed JSON fails closed (caller must not spawn a second host on garbage).
pub fn read_runtime(data_dir: &Path) -> Result<Option<RuntimeInfo>, String> {
    let path = runtime_file(data_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("reading {}: {e}", path.display())),
    };
    let info: RuntimeInfo = serde_json::from_str(&text)
        .map_err(|e| format!("parsing {}: {e}", path.display()))?;
    Ok(Some(info))
}

/// Live host = parseable runtime + TCP accepts + pid is not proven foreign.
pub fn read_live_runtime(data_dir: &Path) -> Result<Option<RuntimeInfo>, String> {
    let Some(info) = read_runtime(data_dir)? else {
        return Ok(None);
    };
    if runtime_is_live(&info) {
        Ok(Some(info))
    } else {
        Ok(None)
    }
}

fn runtime_is_live(info: &RuntimeInfo) -> bool {
    let port_reachable = tcp_probe(info.port);
    let pid_matches = pid_is_termx_host(info.pid);
    // Mirror host `already_running`: fail open on tasklist errors, fail closed
    // when the pid is proven not to be termx-host (stale + foreign listener).
    pid_matches != Some(false) && port_reachable
}

fn tcp_probe(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(500),
    )
    .is_ok()
}

/// Some(false) = verified not ours; None = could not verify; Some(true) = ours.
#[cfg(windows)]
fn pid_is_termx_host(pid: u32) -> Option<bool> {
    use std::os::windows::process::CommandExt;
    let out = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
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

#[cfg(not(windows))]
fn pid_is_termx_host(_pid: u32) -> Option<bool> {
    None
}

/// Locate `termx-host.exe`: bundled sidecar beside the UI first, then the
/// workspace `target/{debug,release}` artifact for dev. Never searches PATH.
pub fn resolve_host_exe() -> Result<PathBuf, String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in [
                "termx-host.exe",
                "termx-host-x86_64-pc-windows-msvc.exe",
                "termx-host-x86_64-pc-windows-gnu.exe",
            ] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }

    // Dev-only fallback: workspace target next to this crate (ui/src-tauri →
    // ../..). CARGO_MANIFEST_DIR is a compile-time absolute path from the
    // build machine — it must never be baked into (or probed by) release
    // builds, where the sidecar beside the UI is the only legitimate source.
    #[cfg(debug_assertions)]
    {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let workspace = manifest
            .join("..")
            .join("..")
            .canonicalize()
            .unwrap_or_else(|_| manifest.join("../.."));

        let mut candidates = vec![
            workspace.join("target").join("debug").join("termx-host.exe"),
            workspace
                .join("target")
                .join("release")
                .join("termx-host.exe"),
        ];

        // Honor an explicit Cargo target dir when the host was built elsewhere.
        if let Ok(td) = std::env::var("CARGO_TARGET_DIR") {
            let td = PathBuf::from(td);
            candidates.push(td.join("debug").join("termx-host.exe"));
            candidates.push(td.join("release").join("termx-host.exe"));
        }

        for c in candidates {
            if c.is_file() {
                return Ok(c);
            }
        }
    }

    Err("termx-host.exe not found beside the UI executable (dev builds also probe workspace target/{debug,release})".into())
}

fn spawn_host(host_exe: &Path, data_dir: &Path) -> Result<(), String> {
    if !host_exe.is_file() {
        return Err(format!("host executable missing: {}", host_exe.display()));
    }
    let data_dir_str = data_dir
        .to_str()
        .ok_or_else(|| "data dir path is not valid UTF-8".to_string())?;

    let mut cmd = Command::new(host_exe);
    cmd.args(["--data-dir", data_dir_str])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }

    cmd.spawn()
        .map_err(|e| format!("spawning {}: {e}", host_exe.display()))?;
    Ok(())
}

fn wait_for_live_runtime(data_dir: &Path, timeout: Duration) -> Result<RuntimeInfo, String> {
    let deadline = Instant::now() + timeout;
    let mut last_err: Option<String> = None;
    loop {
        match read_live_runtime(data_dir) {
            Ok(Some(info)) => return Ok(info),
            Ok(None) => {}
            Err(e) => {
                // Malformed mid-write is unlikely (atomic rename), but keep
                // the last parse error for the timeout message.
                last_err = Some(e);
            }
        }
        if Instant::now() >= deadline {
            let detail = last_err
                .map(|e| format!(" last error: {e}"))
                .unwrap_or_default();
            return Err(format!(
                "host did not become ready within {}s{detail}",
                timeout.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    fn write_runtime(dir: &Path, info: &RuntimeInfo) {
        let path = runtime_file(dir);
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(serde_json::to_string_pretty(info).unwrap().as_bytes())
            .unwrap();
    }

    #[test]
    fn missing_runtime_is_not_live() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_live_runtime(tmp.path()).unwrap().is_none());
    }

    #[test]
    fn malformed_runtime_fails_closed() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(runtime_file(tmp.path()), b"{ not json").unwrap();
        let err = read_runtime(tmp.path()).unwrap_err();
        assert!(
            err.contains("parsing"),
            "corrupt discovery must not look like 'missing': {err}"
        );
    }

    #[test]
    fn live_runtime_requires_tcp_listener() {
        let tmp = tempfile::tempdir().unwrap();
        // Bound port with no matching process image still fails if port dead.
        let dead = RuntimeInfo {
            port: 1, // almost certainly closed on loopback
            token: "deadbeef".into(),
            pid: 1,
            version: "0.0.0".into(),
        };
        write_runtime(tmp.path(), &dead);
        assert!(
            read_live_runtime(tmp.path()).unwrap().is_none(),
            "closed port must not count as live"
        );

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // Spawn a short-lived process so we have a real pid; image is not termx-host.
        let mut child = Command::new("cmd")
            .args(["/c", "ping", "127.0.0.1", "-n", "30", ">", "nul"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let foreign = RuntimeInfo {
            port,
            token: "tok".into(),
            pid: child.id(),
            version: "0.0.0".into(),
        };
        write_runtime(tmp.path(), &foreign);
        // Port open but pid is cmd.exe → proven foreign → not live.
        assert!(
            read_live_runtime(tmp.path()).unwrap().is_none(),
            "foreign listener must not count as live host"
        );
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn bootstrap_result_serializes_snake_port_token_only() {
        let r = BootstrapResult {
            port: 4242,
            token: "abc".into(),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["port"], 4242);
        assert_eq!(v["token"], "abc");
        assert!(v.as_object().unwrap().keys().all(|k| k == "port" || k == "token"));
    }

    #[test]
    fn resolve_host_exe_finds_workspace_debug_binary() {
        // Requires a prior `cargo build -p termx-host` (present in this repo).
        match resolve_host_exe() {
            Ok(p) => {
                assert!(p.is_file(), "{}", p.display());
                assert!(
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("termx-host")),
                    "unexpected name: {}",
                    p.display()
                );
            }
            Err(e) => {
                // Soft skip only when the artifact truly is absent.
                eprintln!("skip resolve_host_exe: {e}");
            }
        }
    }

    #[test]
    fn bootstrap_spawns_host_into_temp_data_dir_and_returns_port_token() {
        let host = match resolve_host_exe() {
            Ok(p) => p,
            Err(e) => {
                eprintln!("skip integration bootstrap: {e}");
                return;
            }
        };
        let tmp = tempfile::tempdir().unwrap();
        let result = bootstrap_with(BootstrapOptions {
            data_dir: Some(tmp.path().to_path_buf()),
            host_exe: Some(host),
            ready_timeout: Some(Duration::from_secs(15)),
        })
        .expect("bootstrap must succeed against real host");

        assert!(result.port > 0);
        assert!(!result.token.is_empty());
        assert!(
            result.token.chars().all(|c| c.is_ascii_hexdigit()),
            "token should be hex like M1 host mint"
        );

        // Second call must reattach, not spawn a second host.
        let again = bootstrap_with(BootstrapOptions {
            data_dir: Some(tmp.path().to_path_buf()),
            host_exe: None, // should not need spawn
            ready_timeout: Some(Duration::from_secs(2)),
        })
        .expect("second bootstrap against live host");
        assert_eq!(again.port, result.port);
        assert_eq!(again.token, result.token);

        // Tear down: kill the host recorded in runtime.json.
        if let Ok(Some(info)) = read_runtime(tmp.path()) {
            let _ = Command::new("taskkill")
                .args(["/PID", &info.pid.to_string(), "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }

    #[test]
    fn bootstrap_times_out_when_host_exe_is_bogus() {
        let tmp = tempfile::tempdir().unwrap();
        // A real file that is not a host (cmd will exit immediately if invoked wrong).
        // Use a non-existent path so spawn fails fast.
        let missing = tmp.path().join("no-such-termx-host.exe");
        let err = bootstrap_with(BootstrapOptions {
            data_dir: Some(tmp.path().to_path_buf()),
            host_exe: Some(missing),
            ready_timeout: Some(Duration::from_secs(1)),
        })
        .unwrap_err();
        assert!(
            err.contains("missing") || err.contains("spawning") || err.contains("ready"),
            "expected spawn/ready failure, got: {err}"
        );
    }
}
