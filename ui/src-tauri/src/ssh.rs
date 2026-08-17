//! SSH-side host commands (ssh-sessions spec §1).
//!
//! `~/.ssh/config` lives outside the app data dir, so it cannot go through the
//! `storage` allowlist. It gets its own command instead of a general "read any
//! file" one: the renderer names no path at all, which is what keeps this from
//! being an arbitrary-read hole. The file is only ever read — TermX never
//! writes the user's ssh config.

use std::path::{Path, PathBuf};

/// Read `<base>/.ssh/config`. Missing file or missing `.ssh` dir → `Ok(None)`:
/// a machine with no ssh config is not an error, it is an empty inventory.
/// Present-but-unreadable is an error, because silently showing no hosts would
/// misrepresent a config the user knows they have.
pub fn read_config_at(base: &Path) -> Result<Option<String>, String> {
    let path = base.join(".ssh").join("config");
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("reading {}: {e}", path.display())),
    }
}

/// The user profile dir, resolved at runtime — never a baked-in path. Windows
/// sets `USERPROFILE`; `HOME` is the fallback so the tests and any non-Windows
/// build resolve too.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Tauri command: the raw text of the user's ssh config, or `None` when there
/// is none (or no resolvable home dir). Parsing happens in the renderer.
#[tauri::command]
pub fn read_ssh_config() -> Result<Option<String>, String> {
    match home_dir() {
        Some(base) => read_config_at(&base),
        None => Ok(None),
    }
}

/// One DPAPI call, in either direction. The out blob is allocated by the API
/// with `LocalAlloc`, so it is copied out and freed here rather than leaked.
///
/// User-scoped and passphrase-free by design (spec §6): the key is the logged-in
/// Windows account, so a stolen credentials file is useless on another machine
/// or under another user, and Michael is never asked to type a master password.
fn crypt_blob(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    // The in blob wants a *mut even though the call only reads it.
    let mut source = input.to_vec();
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: source.len() as u32,
        pbData: source.as_mut_ptr(),
    };
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: `in_blob` points into `source`, which outlives the call; the null
    // entropy / reserved / prompt-struct arguments are the documented "no extra
    // secret, no UI" form; `out` is written by the API and freed below.
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &in_blob,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                &mut out,
            )
        } else {
            CryptUnprotectData(
                &in_blob,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                &mut out,
            )
        }
    };
    if ok == 0 {
        // The OS error only ever describes the failure, never the secret.
        let verb = if protect { "encrypting" } else { "decrypting" };
        return Err(format!("{verb} failed: {}", std::io::Error::last_os_error()));
    }
    let bytes = if out.pbData.is_null() {
        Vec::new()
    } else {
        // SAFETY: the call succeeded, so pbData/cbData describe an initialized
        // buffer we own until LocalFree.
        unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec()
    };
    if !out.pbData.is_null() {
        // SAFETY: freeing exactly the LocalAlloc'd pointer the API handed back.
        unsafe { LocalFree(out.pbData as *mut core::ffi::c_void) };
    }
    Ok(bytes)
}

/// Tauri command: DPAPI-encrypt `plain`, returned base64 so it can live in a
/// JSON file. Errors are surfaced — a silent failure would let the renderer
/// store a "protected" password that was never protected.
#[tauri::command]
pub fn protect_secret(plain: String) -> Result<String, String> {
    use base64::Engine as _;
    let blob = crypt_blob(plain.as_bytes(), true)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(blob))
}

/// Tauri command: reverse of `protect_secret`. A blob from another user or
/// machine, or one that is not a DPAPI blob at all, is an error — which the
/// credentials store reads as "no usable password for this host".
#[tauri::command]
pub fn unprotect_secret(data: String) -> Result<String, String> {
    use base64::Engine as _;
    let blob = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|_| "stored secret is not valid base64".to_string())?;
    let plain = crypt_blob(&blob, false)?;
    String::from_utf8(plain).map_err(|_| "decrypted secret is not valid UTF-8".to_string())
}

/// How often the probe's timeout loop checks on the child.
const PROBE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(25);

/// Upper bound on a probe's wall clock, whatever the renderer asks for: a probe
/// is a "while you wait" lookup behind an already-open dialog (spec §3).
const PROBE_MAX_TIMEOUT_MS: u64 = 30_000;
const PROBE_MIN_TIMEOUT_MS: u64 = 250;

/// A config alias is a NAME. Validated here as well as in the renderer, because
/// this is the side that hands it to a process.
fn alias_is_plain_name(alias: &str) -> bool {
    !alias.is_empty()
        // A leading dash is the one shape that turns a "name" into an option:
        // ssh has no `--` end-of-options marker for its host argument, so
        // `-oProxyCommand=…` would be honoured as a flag. Refused outright.
        && !alias.starts_with('-')
        && alias
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// The exact argv for a probe, or an error for an alias that is not a name.
///
/// `BatchMode=yes` is what makes this a health check rather than a login: ssh
/// fails instead of prompting, so a probe can never sit waiting for a password
/// nobody is there to type. The remote `command` is passed as ONE argv entry —
/// the remote shell is what interprets it, exactly as with a hand-typed ssh.
fn probe_args(alias: &str, command: &str) -> Result<Vec<String>, String> {
    if !alias_is_plain_name(alias) {
        return Err(format!("{alias:?} is not a plain ssh config alias"));
    }
    Ok(vec![
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=5".to_string(),
        alias.to_string(),
        command.to_string(),
    ])
}

/// Run a probe child and return its stdout, or an error for a spawn failure, a
/// non-zero exit, or a child that outlived `timeout` (which is killed).
///
/// stdout is drained on its own thread: a child that fills the pipe would
/// otherwise block forever while we block on `try_wait`.
fn run_probe(
    mut command: std::process::Command,
    timeout: std::time::Duration,
) -> Result<String, String> {
    use std::io::Read as _;
    use std::process::Stdio;

    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // The UI is a windowed app with no console, so a console child would flash
    // a terminal window on screen for every probe.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|e| format!("running ssh: {e}"))?;
    let reader = child.stdout.take().map(|mut stdout| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stdout.read_to_end(&mut buf);
            buf
        })
    });

    let deadline = std::time::Instant::now() + timeout;
    let finished = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(PROBE_POLL_INTERVAL)
            }
            Ok(None) => break None,
            Err(_) => break None,
        }
    };

    let Some(status) = finished else {
        // Kill and reap; the reader thread ends by itself once the pipe closes,
        // so it is left detached rather than joined.
        let _ = child.kill();
        let _ = child.wait();
        return Err("the ssh probe timed out".to_string());
    };
    if !status.success() {
        return Err("the ssh probe failed".to_string());
    }
    let bytes = reader
        .map(|handle| handle.join().unwrap_or_default())
        .unwrap_or_default();
    // Remote output is whatever the far end sent; lossy decoding keeps a stray
    // byte from turning a title into an error.
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Tauri command: run one short command on a host over ssh and hand back its
/// stdout (ssh-sessions spec §3 — reading a remote conversation's current
/// title at pin time, and the health check that comes with it).
///
/// Every failure is an `Err` the renderer degrades from; it never blocks a
/// dialog, and the probe is bounded so a wedged network cannot hold a thread.
#[tauri::command]
pub async fn ssh_probe(
    alias: String,
    command: String,
    timeout_ms: u64,
) -> Result<String, String> {
    let args = probe_args(&alias, &command)?;
    let timeout = std::time::Duration::from_millis(
        timeout_ms.clamp(PROBE_MIN_TIMEOUT_MS, PROBE_MAX_TIMEOUT_MS),
    );
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = std::process::Command::new("ssh");
        child.args(&args);
        run_probe(child, timeout)
    })
    .await
    .map_err(|_| "the ssh probe could not be started".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::Duration;

    #[test]
    fn a_probe_alias_must_be_a_plain_name() {
        for alias in [
            "myvps",
            "my.vps-01",
            "TastyVPS",
            "a_b",
        ] {
            assert!(probe_args(alias, "true").is_ok(), "{alias:?} is a name");
        }
        for alias in [
            "",
            "evil; calc",
            "a b",
            "$(id)",
            "a|b",
            "a&b",
            "a\nb",
            "vps:22",
            "vps/../x",
            // A leading dash would be read by ssh as an OPTION, not a host —
            // the one shape that turns a "name" into an argument injection.
            "-oProxyCommand=calc",
            "-v",
        ] {
            assert!(probe_args(alias, "true").is_err(), "{alias:?} is not a name");
        }
    }

    #[test]
    fn a_probe_runs_batch_mode_with_a_short_connect_timeout() {
        // BatchMode is what keeps a probe from ever blocking on a password
        // prompt: it is a health check, not a login.
        assert_eq!(
            probe_args("myvps", "echo hi").unwrap(),
            vec![
                "-o".to_string(),
                "BatchMode=yes".to_string(),
                "-o".to_string(),
                "ConnectTimeout=5".to_string(),
                "myvps".to_string(),
                "echo hi".to_string(),
            ]
        );
    }

    #[cfg(windows)]
    fn printing(text: &str) -> Command {
        let mut command = Command::new("cmd");
        command.args(["/c", &format!("echo {text}")]);
        command
    }
    #[cfg(not(windows))]
    fn printing(text: &str) -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", &format!("printf '%s' {text}")]);
        command
    }

    /// Outlives any test timeout.
    #[cfg(windows)]
    fn slow() -> Command {
        let mut command = Command::new("ping");
        command.args(["-n", "20", "127.0.0.1"]);
        command
    }
    #[cfg(not(windows))]
    fn slow() -> Command {
        let mut command = Command::new("sleep");
        command.arg("20");
        command
    }

    #[cfg(windows)]
    fn failing() -> Command {
        let mut command = Command::new("cmd");
        command.args(["/c", "exit 1"]);
        command
    }
    #[cfg(not(windows))]
    fn failing() -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", "exit 1"]);
        command
    }

    #[test]
    fn a_successful_probe_returns_its_stdout() {
        let out = run_probe(printing("hello"), Duration::from_secs(10)).unwrap();
        assert_eq!(out.trim(), "hello");
    }

    #[test]
    fn a_probe_that_fails_is_an_error() {
        assert!(run_probe(failing(), Duration::from_secs(10)).is_err());
    }

    #[test]
    fn a_missing_ssh_binary_is_an_error_not_a_panic() {
        assert!(run_probe(
            Command::new("termx-no-such-binary-8f3a1c"),
            Duration::from_secs(10)
        )
        .is_err());
    }

    #[test]
    fn a_hung_probe_is_killed_at_the_timeout() {
        let started = std::time::Instant::now();
        assert!(run_probe(slow(), Duration::from_millis(150)).is_err());
        // Proof it did not wait out the child: the stub runs for ~20 s.
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_missing_config_reads_as_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(read_config_at(tmp.path()).unwrap(), None);
    }

    #[test]
    fn a_present_config_reads_its_contents() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".ssh");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config"), "Host myvps\n  HostName 10.0.0.1\n").unwrap();
        assert_eq!(
            read_config_at(tmp.path()).unwrap().as_deref(),
            Some("Host myvps\n  HostName 10.0.0.1\n")
        );
    }

    /// DPAPI is a Windows facility and these tests call it for real (no mock is
    /// worth anything here — the point is that the OS can read back what it
    /// wrote), so they only run where it exists.
    #[cfg(windows)]
    #[test]
    fn a_protected_secret_round_trips_through_dpapi() {
        // Not a real credential: a literal chosen to exercise spaces, unicode
        // and a trailing space (passwords may end in one).
        let plain = "not-a-real-password ✓ ";
        let blob = protect_secret(plain.to_string()).unwrap();
        assert!(!blob.contains("not-a-real"), "the blob must not be plaintext");
        assert_eq!(unprotect_secret(blob).unwrap(), plain);
    }

    #[cfg(windows)]
    #[test]
    fn an_empty_secret_round_trips_too() {
        let blob = protect_secret(String::new()).unwrap();
        assert_eq!(unprotect_secret(blob).unwrap(), "");
    }

    #[cfg(windows)]
    #[test]
    fn unprotecting_something_dpapi_did_not_write_is_an_error() {
        for bad in ["", "not base64 at all !!", "aGVsbG8gd29ybGQ="] {
            assert!(
                unprotect_secret(bad.to_string()).is_err(),
                "{bad:?} must not decrypt"
            );
        }
    }

    #[test]
    fn a_present_but_unreadable_config_is_an_error() {
        // A directory where the config should be: present, so "no hosts" would
        // be a lie, and unreadable, so the renderer must hear about it.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".ssh").join("config")).unwrap();
        assert!(read_config_at(tmp.path()).is_err());
    }
}
