//! Data-dir resolution. NO hardcoded absolute paths — everything derives from
//! the override, the exe location (portable mode), or APPDATA at runtime.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Resolution order: explicit override -> portable.flag beside the exe -> %APPDATA%\TermX.
/// Creates the directory (and parents) before returning it.
pub fn resolve_data_dir(override_dir: Option<&Path>) -> Result<PathBuf> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.to_path_buf()));
    let appdata = std::env::var("APPDATA").ok();
    let dir = choose_data_dir(override_dir, exe_dir.as_deref(), appdata.as_deref())?;
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating data dir {}", dir.display()))?;
    Ok(dir)
}

/// Pure resolution logic, testable without faking the running exe's location.
fn choose_data_dir(
    override_dir: Option<&Path>,
    exe_dir: Option<&Path>,
    appdata: Option<&str>,
) -> Result<PathBuf> {
    if let Some(d) = override_dir {
        return Ok(d.to_path_buf());
    }
    if let Some(portable) = exe_dir.and_then(portable_data_dir) {
        return Ok(portable);
    }
    let appdata = appdata.context("APPDATA not set")?;
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

pub fn logs_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_dir_wins_and_is_created() {
        let tmp = crate::test_support::retained_dir().unwrap();
        let want = tmp.path().join("custom");
        let got = resolve_data_dir(Some(&want)).unwrap();
        assert_eq!(got, want);
        assert!(want.is_dir(), "must create the dir");
    }

    #[test]
    fn appdata_fallback_used_without_override() {
        // Not portable-mode in `cargo test` (no portable.flag beside the test exe),
        // so we must land under %APPDATA%\TermX.
        let appdata = std::env::var("APPDATA").expect("windows test env has APPDATA");
        let got = resolve_data_dir(None).unwrap();
        assert_eq!(got, Path::new(&appdata).join("TermX"));
        assert!(got.is_dir());
    }

    #[test]
    fn portable_flag_beside_exe_wins_over_appdata() {
        let tmp = crate::test_support::retained_dir().unwrap();
        std::fs::write(tmp.path().join("portable.flag"), "").unwrap();
        let got = choose_data_dir(None, Some(tmp.path()), Some(r"X:\FakeAppData")).unwrap();
        assert_eq!(got, tmp.path().join("data"));
    }

    #[test]
    fn no_flag_falls_through_to_appdata() {
        let tmp = crate::test_support::retained_dir().unwrap();
        let got = choose_data_dir(None, Some(tmp.path()), Some(r"X:\FakeAppData")).unwrap();
        assert_eq!(got, Path::new(r"X:\FakeAppData").join("TermX"));
    }

    #[test]
    fn override_beats_portable_flag() {
        let tmp = crate::test_support::retained_dir().unwrap();
        std::fs::write(tmp.path().join("portable.flag"), "").unwrap();
        let want = tmp.path().join("explicit");
        let got = choose_data_dir(Some(&want), Some(tmp.path()), None).unwrap();
        assert_eq!(got, want);
    }

    #[test]
    fn helper_paths_derive_from_data_dir() {
        let tmp = crate::test_support::retained_dir().unwrap();
        let d = resolve_data_dir(Some(tmp.path())).unwrap();
        assert_eq!(runtime_file(&d), d.join("runtime.json"));
        assert_eq!(logs_dir(&d), d.join("logs"));
    }
}
