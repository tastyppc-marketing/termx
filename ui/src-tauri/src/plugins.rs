//! Native process and health-probe primitives for local panel plugins.
//!
//! Plugins remain standalone processes. TermX only ensures they are up, reads
//! their small runtime discovery file, and probes an explicitly loopback HTTP
//! endpoint; it never owns or kills the process after spawning it.
//!
//! TermX is a Windows-only application, so the process handling here is tuned
//! for Windows semantics (children outlive their parent, no zombie reaping)
//! and the non-Windows compile path exists only to keep `cargo check` honest.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const RUNTIME_MAX_BYTES: u64 = 64 * 1024;
/// The probe body is bounded to the same 64 KiB as the runtime file: both are
/// tiny JSON documents by contract, and ureq's own `into_string` cap is 10 MiB
/// — enough for a buggy plugin to make T6's 15 s health poller buffer 10 MiB
/// every tick.
const PROBE_MAX_BODY_BYTES: u64 = 64 * 1024;
const STDERR_TAIL_MAX_BYTES: u64 = 8 * 1024;
const PROBE_MIN_TIMEOUT_MS: u64 = 200;
const PROBE_MAX_TIMEOUT_MS: u64 = 5_000;
/// pid → log-path entries retained. Each is a pid plus a short path, so the
/// map is bytes-per-entry; the bound exists so relaunch loops (T5's relaunch,
/// T6's health-driven restart on a flapping plugin) cannot grow it forever.
const LOG_PATHS_MAX: usize = 32;
/// Stderr log files kept on disk. Pruned after every successful spawn so the
/// directory cannot accumulate across relaunches and app restarts.
const LOG_FILES_KEEP: usize = 16;
const LOG_DIR_NAME: &str = "plugin-logs";
const LOG_FILE_PREFIX: &str = "plugin-";
const LOG_FILE_SUFFIX: &str = ".stderr.log";

/// CREATE_NO_WINDOW — the plugin gets its own HIDDEN console: no window flash,
/// and the console still delivers ctrl_close/ctrl_logoff/ctrl_shutdown, which
/// is a plugin's only chance to release its port and delete its runtime file
/// at logoff/shutdown. Deliberately NOT combined with DETACHED_PROCESS: per
/// MSDN that flag makes CREATE_NO_WINDOW a no-op, it strips the console so
/// those events never fire, and it buys nothing — Windows children already
/// outlive their parents and dropping `Child` does not kill. Same reasoning,
/// written out at length, in `bootstrap.rs` for the host spawn.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Monotonic suffix so two spawns inside the same millisecond cannot collide
/// on a log file name.
static LOG_SEQ: AtomicU64 = AtomicU64::new(0);

/// pid → stderr log file, bounded and insertion-ordered.
///
/// A file, not a pipe: TermX holding the read end of a plugin's stderr pipe
/// for its whole life would give a plugin that outlives TermX a broken pipe on
/// its next stderr write (Node can surface EPIPE and die), which contradicts
/// this module's "never owns the process" contract. A file has no lifetime
/// coupling to TermX at all.
static LOG_PATHS: LazyLock<Mutex<LogPaths>> = LazyLock::new(|| Mutex::new(LogPaths::default()));

#[derive(Default)]
struct LogPaths {
    by_pid: HashMap<u32, PathBuf>,
    order: VecDeque<u32>,
}

impl LogPaths {
    /// Record `pid`, evicting the oldest entries past `LOG_PATHS_MAX`. Windows
    /// reuses pids, so a repeat pid replaces its previous entry rather than
    /// leaving a stale duplicate in the order queue.
    fn insert(&mut self, pid: u32, path: PathBuf) {
        if self.by_pid.insert(pid, path).is_some() {
            self.order.retain(|recorded| *recorded != pid);
        }
        self.order.push_back(pid);
        while self.order.len() > LOG_PATHS_MAX {
            if let Some(evicted) = self.order.pop_front() {
                self.by_pid.remove(&evicted);
            }
        }
    }

    fn get(&self, pid: u32) -> Option<PathBuf> {
        self.by_pid.get(&pid).cloned()
    }
}

/// Accept only an explicit TCP port on one of the two loopback hosts the
/// plugin contract names. Keeping this parser deliberately narrower than a
/// general URL parser prevents userinfo, alternate IP spellings, and remote
/// hosts from turning the native probe into an arbitrary network request.
fn validate_probe_url(url: &str) -> Result<(), String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| "plugin probe URL must use http".to_string())?;
    // The authority ends at the first path, query or fragment delimiter. `?`
    // and `#` matter as well as `/`: without them `http://127.0.0.1:8080?x=1`
    // puts the query string in the port field and a legitimate health URL is
    // rejected. Backslash is deliberately NOT a delimiter — browsers treat it
    // as `/`, but here leaving it inside the authority is what makes
    // `http://127.0.0.1:80\@evil.com` fail the port parse.
    let authority = match rest.find(['/', '?', '#']) {
        Some(end) => &rest[..end],
        None => rest,
    };
    let (host, port) = authority
        .rsplit_once(':')
        .ok_or_else(|| "plugin probe URL must include an explicit port".to_string())?;
    if host != "127.0.0.1" && !host.eq_ignore_ascii_case("localhost") {
        return Err("plugin probe URL must use a loopback host".to_string());
    }
    // `u16::from_str` also accepts a leading `+`; requiring plain digits keeps
    // the accepted set exactly what a plugin runtime file can produce.
    if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
        return Err("plugin probe URL has an invalid port".to_string());
    }
    let port = port
        .parse::<u16>()
        .map_err(|_| "plugin probe URL has an invalid port".to_string())?;
    if port == 0 {
        return Err("plugin probe URL has an invalid port".to_string());
    }
    Ok(())
}

/// Read a plugin-owned runtime discovery file without widening the app-data
/// storage allowlist. A missing file is normal while a plugin is starting.
#[tauri::command]
pub fn plugin_read_runtime(path: String) -> Result<Option<String>, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("plugin runtime path must be absolute".to_string());
    }

    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("reading {}: {error}", path.display())),
    };
    let mut bytes = Vec::new();
    file.take(RUNTIME_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("reading {}: {error}", path.display()))?;
    if bytes.len() as u64 > RUNTIME_MAX_BYTES {
        return Err(format!(
            "reading {}: plugin runtime file exceeds 64 KiB",
            path.display()
        ));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|error| format!("reading {} as UTF-8: {error}", path.display()))
}

/// GET one loopback health endpoint on a blocking worker so the Tauri async
/// executor stays responsive. Redirects are disabled because validating only
/// the first URL would otherwise let a local response redirect the probe to a
/// non-loopback host.
#[tauri::command]
pub async fn plugin_probe(url: String, timeout_ms: u64) -> Result<String, String> {
    validate_probe_url(&url)?;
    let timeout =
        Duration::from_millis(timeout_ms.clamp(PROBE_MIN_TIMEOUT_MS, PROBE_MAX_TIMEOUT_MS));
    tauri::async_runtime::spawn_blocking(move || {
        // `.timeout()` alone is NOT a bound on the call: ureq documents it as
        // taking precedence over read/write but NOT over `.timeout_connect()`,
        // whose default is 30 s. A filtered port or a black-holed `localhost`
        // would then hold a blocking-pool thread for 30 s while T3's ensure-up
        // poll and T6's health poller are built on the advertised <=5 s. Every
        // phase gets the clamp explicitly.
        let agent = ureq::AgentBuilder::new()
            .timeout(timeout)
            .timeout_connect(timeout)
            .timeout_read(timeout)
            .timeout_write(timeout)
            .redirects(0)
            .build();
        let response = agent
            .get(&url)
            .call()
            .map_err(|error| format!("probing {url}: {error}"))?;
        let mut body = String::new();
        response
            .into_reader()
            .take(PROBE_MAX_BODY_BYTES)
            .read_to_string(&mut body)
            .map_err(|error| format!("reading probe response from {url}: {error}"))?;
        Ok(body)
    })
    .await
    .map_err(|_| "the plugin probe could not be started".to_string())?
}

/// Spawn a plugin independently of TermX, sending its stderr to a per-spawn log
/// file whose most recent 8 KiB back the failure UI. Dropping `Child` does not
/// terminate it; that is intentional for plugins that also run outside TermX or
/// exit quickly after finding a singleton already alive.
///
/// `async` so the macro runs it on the blocking pool rather than inline on the
/// invoke thread: `CreateProcess` on a cold `node.exe` with Defender in the
/// path is a tens-to-hundreds-of-ms stall, and every other process-touching
/// command in this shell (`bootstrap_host`, `ssh_probe`) is already async.
///
/// `env` entries are ADDED to the inherited environment (spec §2 requires
/// `TERMX=1` and `TERMX_PLUGIN_ID=<manifest id>` so a process can tell it was
/// started by TermX). It is `Option` so an older caller that omits the
/// argument entirely still deserializes.
#[tauri::command(async)]
pub fn plugin_spawn(
    command: String,
    args: Vec<String>,
    cwd: String,
    env: Option<HashMap<String, String>>,
) -> Result<u32, String> {
    plugin_spawn_in(&log_dir()?, command, args, cwd, env)
}

/// The spawn itself, taking the log directory so tests never write into the
/// real data dir (which a running TermX shares).
fn plugin_spawn_in(
    log_dir: &Path,
    command: String,
    args: Vec<String>,
    cwd: String,
    env: Option<HashMap<String, String>>,
) -> Result<u32, String> {
    let log_path = new_log_path_in(log_dir)?;
    let log_file = std::fs::File::create(&log_path)
        .map_err(|error| format!("creating {}: {error}", log_path.display()))?;
    let child_stderr = log_file
        .try_clone()
        .map_err(|error| format!("preparing {}: {error}", log_path.display()))?;

    let mut process = Command::new(&command);
    process
        .args(args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(child_stderr));
    if let Some(env) = env {
        process.envs(env);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => {
            // Nothing ever wrote to it; do not leave an empty file behind.
            let _ = std::fs::remove_file(&log_path);
            return Err(format!(
                "spawning plugin command {command} in {cwd}: {error}"
            ));
        }
    };
    let pid = child.id();

    // Any failure AFTER spawn must kill the child. T3's ensure-up retries on
    // Err, and a surviving unrecorded process would mean two plugins racing
    // for the same port with no pid known for the first.
    match LOG_PATHS.lock() {
        Ok(mut paths) => paths.insert(pid, log_path),
        Err(_) => {
            let _ = child.kill();
            return Err("plugin stderr logs are unavailable".to_string());
        }
    }

    prune_log_files_in(log_dir);
    Ok(pid)
}

/// `<log dir>\plugin-<unix millis>-<seq>.stderr.log`, with the directory
/// created. The pid is unknown before `spawn()`, hence a monotonic name rather
/// than a pid-based one.
fn new_log_path_in(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|error| format!("creating {}: {error}", dir.display()))?;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or(0);
    let seq = LOG_SEQ.fetch_add(1, Ordering::Relaxed);
    Ok(dir.join(format!("{LOG_FILE_PREFIX}{millis}-{seq}{LOG_FILE_SUFFIX}")))
}

fn log_dir() -> Result<PathBuf, String> {
    Ok(crate::paths::resolve_data_dir(None)?.join(LOG_DIR_NAME))
}

/// Keep only the newest `LOG_FILES_KEEP` stderr logs. Best-effort throughout:
/// a log still held open by a running plugin fails to delete on Windows, which
/// is the behaviour we want, and a prune failure must never fail a spawn.
fn prune_log_files_in(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut logs: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with(LOG_FILE_PREFIX) || !name.ends_with(LOG_FILE_SUFFIX) {
                return None;
            }
            let modified = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(UNIX_EPOCH);
            Some((modified, entry.path()))
        })
        .collect();
    if logs.len() <= LOG_FILES_KEEP {
        return;
    }
    // Newest first, path as a stable tiebreaker for same-millisecond writes.
    logs.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    for (_, path) in logs.iter().skip(LOG_FILES_KEEP) {
        let _ = std::fs::remove_file(path);
    }
}

/// Return the lossy UTF-8 rendering of the last 8 KiB of `pid`'s stderr log.
///
/// An unknown pid, an evicted entry or an unreadable log is an EMPTY string,
/// not an error: this only ever feeds a diagnostic panel, and T3/T6 call it on
/// the failure path where a second failure would replace a real reason with a
/// meaningless one.
#[tauri::command]
pub fn plugin_stderr_tail(pid: u32) -> Result<String, String> {
    let Some(path) = LOG_PATHS.lock().ok().and_then(|paths| paths.get(pid)) else {
        return Ok(String::new());
    };
    Ok(read_tail(&path))
}

fn read_tail(path: &Path) -> String {
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    if file
        .seek(SeekFrom::Start(len.saturating_sub(STDERR_TAIL_MAX_BYTES)))
        .is_err()
    {
        return String::new();
    }
    let mut bytes = Vec::new();
    if file
        .take(STDERR_TAIL_MAX_BYTES)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return String::new();
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Poll `plugin_stderr_tail` until `done` accepts it or the deadline
    /// passes. A fixed sleep flakes on a loaded box; a deadline does not.
    #[cfg(windows)]
    fn tail_until(pid: u32, done: impl Fn(&str) -> bool) -> String {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let tail = plugin_stderr_tail(pid).unwrap();
            if done(&tail) || std::time::Instant::now() >= deadline {
                return tail;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn probe_rejects_non_loopback() {
        // Every entry here must fail a naive `url.contains("127.0.0.1")`
        // implementation, so a wrong rewrite of the validator cannot pass.
        for url in [
            "http://example.com/",
            // Loopback as a LABEL of a remote name.
            "http://127.0.0.1.evil.com:80/",
            "http://localhost.evil.com:80/",
            // Loopback in the path, not the authority.
            "http://evil.com/127.0.0.1:80",
            "http://evil.com/?next=http://127.0.0.1:80/",
            // Userinfo: the authority's host is what follows the '@'.
            "http://user@127.0.0.1:80/",
            "http://localhost@evil.com:80/",
            "http://127.0.0.1:80@evil.com/",
            "http://evil.com:80@127.0.0.1:81/",
            "http://127.0.0.1:80\\@evil.com/",
            // Scheme.
            "https://127.0.0.1:80/",
            "HTTP://127.0.0.1:80/",
            "ws://127.0.0.1:80/",
            "file://127.0.0.1:80/",
            "127.0.0.1:80",
            // Port: absent, zero, out of range, non-numeric.
            "http://127.0.0.1/",
            "http://localhost/",
            "http://127.0.0.1:0/",
            "http://localhost:65536/",
            "http://127.0.0.1:+80/",
            "http://127.0.0.1: 80/",
            "http://127.0.0.1:80 /",
            // Alternate spellings of loopback the contract does not name.
            "http://2130706433:80/",
            "http://127.1:80/",
            "http://127.000.000.001:80/",
            "http://0.0.0.0:80/",
            "http://[::1]:80/",
            "http://localhost.:80/",
        ] {
            assert!(
                validate_probe_url(url).is_err(),
                "{url:?} is not a loopback health URL"
            );
        }

        for url in [
            "http://127.0.0.1:7345/api/health",
            "http://localhost:7345/api/health",
            "http://LOCALHOST:7345/",
            "http://127.0.0.1:1/",
            "http://127.0.0.1:65535/api/health?x=1",
            // Authority ends at the first '/', '?' or '#'.
            "http://127.0.0.1:8080?x=1",
            "http://127.0.0.1:8080#frag",
            "http://127.0.0.1:8080",
        ] {
            assert!(
                validate_probe_url(url).is_ok(),
                "{url:?} is a loopback health URL"
            );
        }
    }

    #[test]
    fn read_runtime_requires_absolute() {
        assert!(plugin_read_runtime("relative\\runtime.json".into()).is_err());
    }

    #[test]
    fn read_runtime_missing_is_none() {
        let p = std::env::temp_dir().join("termx-no-such-runtime.json");
        // The shared temp dir is not ours; a stray file with this name would
        // otherwise turn the test red.
        let _ = std::fs::remove_file(&p);
        assert_eq!(
            plugin_read_runtime(p.to_string_lossy().into()).unwrap(),
            None
        );
    }

    #[test]
    fn stderr_tail_for_unknown_pid_is_empty() {
        // Diagnostic-only: never an Err that would mask the real failure.
        assert_eq!(plugin_stderr_tail(u32::MAX).unwrap(), "");
    }

    #[test]
    #[cfg(windows)]
    fn spawn_records_stderr_tail() {
        // Every spawn test goes through a tempdir: `cargo test` must never
        // write into the data dir a running TermX shares.
        let logs = tempfile::tempdir().unwrap();
        let pid = plugin_spawn_in(
            logs.path(),
            "cmd".into(),
            vec!["/c".into(), "echo boom 1>&2".into()],
            std::env::temp_dir().to_string_lossy().into(),
            None,
        )
        .unwrap();
        let tail = tail_until(pid, |tail| tail.contains("boom"));
        assert!(tail.contains("boom"), "tail was {tail:?}");
    }

    #[test]
    #[cfg(windows)]
    fn spawn_passes_env_to_the_child() {
        // Spec §2: a plugin must be able to tell TermX started it.
        let logs = tempfile::tempdir().unwrap();
        let env = HashMap::from([
            ("TERMX".to_string(), "1".to_string()),
            ("TERMX_PLUGIN_ID".to_string(), "showroom".to_string()),
        ]);
        let pid = plugin_spawn_in(
            logs.path(),
            "cmd".into(),
            vec![
                "/c".into(),
                "echo id=%TERMX_PLUGIN_ID% termx=%TERMX% 1>&2".into(),
            ],
            std::env::temp_dir().to_string_lossy().into(),
            Some(env),
        )
        .unwrap();
        let tail = tail_until(pid, |tail| tail.contains("id="));
        assert!(
            tail.contains("id=showroom") && tail.contains("termx=1"),
            "tail was {tail:?}"
        );
    }

    #[test]
    #[cfg(windows)]
    fn spawn_without_env_still_inherits_the_parent_environment() {
        // `envs` ADDS; it must not clear what the child would inherit anyway.
        let logs = tempfile::tempdir().unwrap();
        let pid = plugin_spawn_in(
            logs.path(),
            "cmd".into(),
            vec!["/c".into(), "echo path=%PATH% 1>&2".into()],
            std::env::temp_dir().to_string_lossy().into(),
            None,
        )
        .unwrap();
        let tail = tail_until(pid, |tail| tail.contains("path="));
        assert!(
            tail.contains("path=") && !tail.contains("path=%PATH%"),
            "PATH was not inherited: {tail:?}"
        );
    }

    #[test]
    #[cfg(windows)]
    fn stderr_tail_is_bounded() {
        // ~24 KiB of stderr; only the last 8 KiB may come back.
        let logs = tempfile::tempdir().unwrap();
        let pid = plugin_spawn_in(
            logs.path(),
            "cmd".into(),
            vec![
                "/c".into(),
                "for /L %i in (1,1,300) do @echo 0123456789012345678901234567890123456789012345678901234567890123456789 1>&2".into(),
            ],
            std::env::temp_dir().to_string_lossy().into(),
            None,
        )
        .unwrap();
        let tail = tail_until(pid, |tail| tail.len() as u64 >= STDERR_TAIL_MAX_BYTES);
        assert!(
            tail.len() as u64 >= STDERR_TAIL_MAX_BYTES,
            "child wrote less than the bound: {} bytes",
            tail.len()
        );
        assert!(
            tail.len() as u64 <= STDERR_TAIL_MAX_BYTES,
            "tail exceeded the 8 KiB bound: {} bytes",
            tail.len()
        );
    }

    #[test]
    fn log_paths_evict_oldest_beyond_the_bound() {
        let mut paths = LogPaths::default();
        for pid in 0..(LOG_PATHS_MAX as u32 + 5) {
            paths.insert(pid, PathBuf::from(format!("log-{pid}")));
        }
        assert_eq!(paths.by_pid.len(), LOG_PATHS_MAX);
        assert_eq!(paths.order.len(), LOG_PATHS_MAX);
        assert_eq!(paths.get(0), None, "the oldest pid is evicted");
        assert_eq!(
            paths.get(LOG_PATHS_MAX as u32 + 4),
            Some(PathBuf::from(format!("log-{}", LOG_PATHS_MAX + 4))),
            "the newest pid is retained"
        );
    }

    #[test]
    fn log_paths_reinsert_does_not_leak_order_entries() {
        // Windows reuses pids; a repeat must replace, not duplicate.
        let mut paths = LogPaths::default();
        paths.insert(7, PathBuf::from("first"));
        paths.insert(7, PathBuf::from("second"));
        assert_eq!(paths.order.len(), 1);
        assert_eq!(paths.get(7), Some(PathBuf::from("second")));
    }

    #[test]
    fn a_failed_spawn_leaves_no_empty_log_behind() {
        let logs = tempfile::tempdir().unwrap();
        let result = plugin_spawn_in(
            logs.path(),
            "termx-no-such-plugin-binary".into(),
            vec![],
            std::env::temp_dir().to_string_lossy().into(),
            None,
        );
        assert!(result.is_err());
        assert_eq!(
            std::fs::read_dir(logs.path()).unwrap().count(),
            0,
            "the log file created before the failed spawn must be removed"
        );
    }

    #[test]
    fn prune_keeps_the_newest_logs_and_ignores_other_files() {
        let dir = tempfile::tempdir().unwrap();
        for index in 0..(LOG_FILES_KEEP + 4) {
            // Zero-padded so name order matches age order: the prune sorts by
            // mtime with the path as tiebreaker, and files written this fast
            // can share an mtime.
            let path = dir
                .path()
                .join(format!("{LOG_FILE_PREFIX}{index:04}-0{LOG_FILE_SUFFIX}"));
            std::fs::write(&path, b"x").unwrap();
        }
        let bystander = dir.path().join("runtime.json");
        std::fs::write(&bystander, b"{}").unwrap();

        prune_log_files_in(dir.path());

        let remaining: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(LOG_FILE_PREFIX))
            .collect();
        assert_eq!(remaining.len(), LOG_FILES_KEEP);
        for index in 0..4 {
            assert!(
                !remaining.contains(&format!("{LOG_FILE_PREFIX}{index:04}-0{LOG_FILE_SUFFIX}")),
                "the oldest logs should be gone: {remaining:?}"
            );
        }
        assert!(bystander.is_file(), "prune only touches its own log files");
    }

    #[test]
    fn prune_below_the_bound_deletes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        for index in 0..LOG_FILES_KEEP {
            std::fs::write(
                dir.path()
                    .join(format!("{LOG_FILE_PREFIX}{index:04}-0{LOG_FILE_SUFFIX}")),
                b"x",
            )
            .unwrap();
        }
        prune_log_files_in(dir.path());
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            LOG_FILES_KEEP
        );
    }

    #[test]
    fn tail_of_a_missing_log_is_empty() {
        let missing = std::env::temp_dir().join("termx-no-such-plugin-log.stderr.log");
        let _ = std::fs::remove_file(&missing);
        assert_eq!(read_tail(&missing), "");
    }
}
