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

#[cfg(test)]
mod tests {
    use super::*;

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
