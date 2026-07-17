//! Data-dir resolution. NO hardcoded absolute paths — everything derives from
//! the override, the exe location (portable mode), or APPDATA at runtime.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Resolution order: explicit override -> portable.flag beside the exe -> %APPDATA%\TermX.
/// Creates the directory (and parents) before returning it.
pub fn resolve_data_dir(override_dir: Option<&Path>) -> Result<PathBuf> {
    let dir = if let Some(d) = override_dir {
        d.to_path_buf()
    } else if let Some(portable) = portable_data_dir() {
        portable
    } else {
        let appdata = std::env::var("APPDATA").context("APPDATA not set")?;
        PathBuf::from(appdata).join("TermX")
    };
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating data dir {}", dir.display()))?;
    Ok(dir)
}

/// Some(<exe dir>/data) iff a `portable.flag` file sits beside the running exe.
fn portable_data_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    if dir.join("portable.flag").is_file() {
        Some(dir.join("data"))
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
        let tmp = tempfile::tempdir().unwrap();
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
    fn helper_paths_derive_from_data_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let d = resolve_data_dir(Some(tmp.path())).unwrap();
        assert_eq!(runtime_file(&d), d.join("runtime.json"));
        assert_eq!(logs_dir(&d), d.join("logs"));
    }
}
