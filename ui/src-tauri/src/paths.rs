//! Data-dir resolution. Mirrors `host/src/paths.rs` exactly so the UI and
//! host always agree on where `runtime.json` lives.
//!
//! Resolution order: explicit override → portable.flag beside the exe →
//! `%APPDATA%\TermX`. No absolute paths are hardcoded.

use std::path::{Path, PathBuf};

/// Resolve the host data directory, creating it (and parents) first.
pub fn resolve_data_dir(override_dir: Option<&Path>) -> Result<PathBuf, String> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.to_path_buf()));
    let appdata = std::env::var("APPDATA").ok();
    let dir = choose_data_dir(override_dir, exe_dir.as_deref(), appdata.as_deref())?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("creating data dir {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Pure resolution logic (testable without faking the running exe).
pub(crate) fn choose_data_dir(
    override_dir: Option<&Path>,
    exe_dir: Option<&Path>,
    appdata: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(d) = override_dir {
        return Ok(d.to_path_buf());
    }
    if let Some(portable) = exe_dir.and_then(portable_data_dir) {
        return Ok(portable);
    }
    let appdata = appdata.ok_or_else(|| "APPDATA not set".to_string())?;
    Ok(PathBuf::from(appdata).join("TermX"))
}

/// Some(<exe dir>/data) iff a `portable.flag` file sits in `exe_dir`.
fn portable_data_dir(exe_dir: &Path) -> Option<PathBuf> {
    if exe_dir.join("portable.flag").is_file() {
        Some(exe_dir.join("data"))
    } else {
        None
    }
}

pub fn runtime_file(data_dir: &Path) -> PathBuf {
    data_dir.join("runtime.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_dir_wins() {
        let tmp = tempfile::tempdir().unwrap();
        let want = tmp.path().join("custom");
        let got = choose_data_dir(Some(&want), Some(tmp.path()), Some(r"X:\FakeAppData")).unwrap();
        assert_eq!(got, want);
    }

    #[test]
    fn portable_flag_beside_exe_wins_over_appdata() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("portable.flag"), b"").unwrap();
        let got = choose_data_dir(None, Some(tmp.path()), Some(r"X:\FakeAppData")).unwrap();
        assert_eq!(got, tmp.path().join("data"));
    }

    #[test]
    fn no_flag_falls_through_to_appdata() {
        let tmp = tempfile::tempdir().unwrap();
        let got = choose_data_dir(None, Some(tmp.path()), Some(r"X:\FakeAppData")).unwrap();
        assert_eq!(got, Path::new(r"X:\FakeAppData").join("TermX"));
    }

    #[test]
    fn override_beats_portable_flag() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("portable.flag"), b"").unwrap();
        let want = tmp.path().join("explicit");
        let got = choose_data_dir(Some(&want), Some(tmp.path()), None).unwrap();
        assert_eq!(got, want);
    }

    #[test]
    fn resolve_creates_override_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let want = tmp.path().join("nested").join("dir");
        let got = resolve_data_dir(Some(&want)).unwrap();
        assert_eq!(got, want);
        assert!(want.is_dir());
    }

    #[test]
    fn runtime_file_is_under_data_dir() {
        let d = Path::new(r"X:\data");
        assert_eq!(runtime_file(d), d.join("runtime.json"));
    }
}
