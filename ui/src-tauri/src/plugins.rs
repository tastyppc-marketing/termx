//! Native process and health-probe primitives for local panel plugins.
//!
//! Plugins remain standalone processes. TermX only ensures they are up, reads
//! their small runtime discovery file, and probes an explicitly loopback HTTP
//! endpoint; it never owns or kills the process after spawning it.

use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

const RUNTIME_MAX_BYTES: u64 = 64 * 1024;
const STDERR_TAIL_MAX_BYTES: usize = 8 * 1024;
const PROBE_MIN_TIMEOUT_MS: u64 = 200;
const PROBE_MAX_TIMEOUT_MS: u64 = 5_000;

static TAILS: LazyLock<Mutex<HashMap<u32, VecDeque<u8>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Accept only an explicit TCP port on one of the two loopback hosts the
/// plugin contract names. Keeping this parser deliberately narrower than a
/// general URL parser prevents userinfo, alternate IP spellings, and remote
/// hosts from turning the native probe into an arbitrary network request.
fn validate_probe_url(url: &str) -> Result<(), String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| "plugin probe URL must use http".to_string())?;
    let authority = rest.split_once('/').map_or(rest, |(value, _)| value);
    let (host, port) = authority
        .rsplit_once(':')
        .ok_or_else(|| "plugin probe URL must include an explicit port".to_string())?;
    if host != "127.0.0.1" && !host.eq_ignore_ascii_case("localhost") {
        return Err("plugin probe URL must use a loopback host".to_string());
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
        let agent = ureq::AgentBuilder::new()
            .timeout(timeout)
            .redirects(0)
            .build();
        agent
            .get(&url)
            .call()
            .map_err(|error| format!("probing {url}: {error}"))?
            .into_string()
            .map_err(|error| format!("reading probe response from {url}: {error}"))
    })
    .await
    .map_err(|_| "the plugin probe could not be started".to_string())?
}

/// Spawn a plugin independently of TermX and retain only the most recent 8 KiB
/// of stderr. Dropping `Child` does not terminate it; that is intentional for
/// plugins that also run outside TermX or exit quickly after finding a
/// singleton already alive.
#[tauri::command]
pub fn plugin_spawn(command: String, args: Vec<String>, cwd: String) -> Result<u32, String> {
    let mut process = Command::new(&command);
    process
        .args(args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x0800_0000 | 0x0000_0008);
    }

    let mut child = process
        .spawn()
        .map_err(|error| format!("spawning plugin command {command}: {error}"))?;
    let pid = child.id();
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "capturing plugin stderr failed".to_string())?;

    TAILS
        .lock()
        .map_err(|_| "plugin stderr tails are unavailable".to_string())?
        .insert(pid, VecDeque::with_capacity(STDERR_TAIL_MAX_BYTES));
    std::thread::spawn(move || drain_stderr(pid, stderr));
    Ok(pid)
}

fn drain_stderr(pid: u32, mut stderr: impl Read) {
    let mut chunk = [0_u8; 1024];
    loop {
        let count = match stderr.read(&mut chunk) {
            Ok(0) => return,
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        };
        let Ok(mut tails) = TAILS.lock() else {
            return;
        };
        let Some(tail) = tails.get_mut(&pid) else {
            return;
        };
        for byte in &chunk[..count] {
            if tail.len() == STDERR_TAIL_MAX_BYTES {
                tail.pop_front();
            }
            tail.push_back(*byte);
        }
    }
}

/// Return the lossy UTF-8 rendering of the stderr bytes retained for `pid`.
#[tauri::command]
pub fn plugin_stderr_tail(pid: u32) -> Result<String, String> {
    let tails = TAILS
        .lock()
        .map_err(|_| "plugin stderr tails are unavailable".to_string())?;
    let tail = tails
        .get(&pid)
        .ok_or_else(|| format!("no stderr tail recorded for plugin process {pid}"))?;
    let bytes: Vec<u8> = tail.iter().copied().collect();
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_rejects_non_loopback() {
        assert!(validate_probe_url("http://example.com/").is_err());
        assert!(validate_probe_url("http://127.0.0.1:7345/api/health").is_ok());
    }

    #[test]
    fn read_runtime_requires_absolute() {
        assert!(plugin_read_runtime("relative\\runtime.json".into()).is_err());
    }

    #[test]
    fn read_runtime_missing_is_none() {
        let p = std::env::temp_dir().join("termx-no-such-runtime.json");
        assert_eq!(
            plugin_read_runtime(p.to_string_lossy().into()).unwrap(),
            None
        );
    }

    #[test]
    fn spawn_records_stderr_tail() {
        let pid = plugin_spawn(
            "cmd".into(),
            vec!["/c".into(), "echo boom 1>&2".into()],
            std::env::temp_dir().to_string_lossy().into(),
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert!(plugin_stderr_tail(pid).unwrap().contains("boom"));
    }
}
