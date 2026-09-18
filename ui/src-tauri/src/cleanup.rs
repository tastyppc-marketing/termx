//! Delete `*.old` sidecars the NSIS pre-install hook left beside the exe. A
//! file still mapped by the old daemon fails to delete; that is fine, the next
//! launch retries.
use std::path::Path;

/// Remove `termx-host*.old` and `termx-output*.old` in `exe_dir`. Never touches
/// anything else and never fails: a locked file is left for the next launch.
pub fn remove_stale_binaries(exe_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(exe_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy().to_ascii_lowercase();
        if name.ends_with(".old")
            && (name.starts_with("termx-host") || name.starts_with("termx-output"))
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_old_sidecars_and_ignores_locked_ones() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("termx-host-x86_64-pc-windows-msvc.exe.old"),
            b"x",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("termx-output-x86_64-pc-windows-msvc.exe.old"),
            b"x",
        )
        .unwrap();
        std::fs::write(dir.path().join("keep.txt"), b"x").unwrap();
        std::fs::write(dir.path().join("TermX.exe.old"), b"x").unwrap();
        std::fs::write(dir.path().join("termx-host-x86_64-pc-windows-msvc.exe"), b"x").unwrap();
        remove_stale_binaries(dir.path());
        assert!(!dir.path().join("termx-host-x86_64-pc-windows-msvc.exe.old").exists());
        assert!(!dir.path().join("termx-output-x86_64-pc-windows-msvc.exe.old").exists());
        assert!(dir.path().join("keep.txt").exists());
        assert!(dir.path().join("TermX.exe.old").exists(), "only sidecars are cleaned");
        assert!(dir.path().join("termx-host-x86_64-pc-windows-msvc.exe").exists());
        // A missing directory is not an error.
        remove_stale_binaries(&dir.path().join("nope"));
    }
}
