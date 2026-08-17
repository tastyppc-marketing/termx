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

    #[test]
    fn a_present_but_unreadable_config_is_an_error() {
        // A directory where the config should be: present, so "no hosts" would
        // be a lie, and unreadable, so the renderer must hear about it.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".ssh").join("config")).unwrap();
        assert!(read_config_at(tmp.path()).is_err());
    }
}
