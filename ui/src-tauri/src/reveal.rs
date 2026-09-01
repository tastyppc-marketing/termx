//! "Show me this folder" — the status bar's working directory, opened in the
//! OS file manager.
//!
//! The path arrives from the renderer, where a live shell reported it as its
//! cwd. Between that report and the click the directory may have been renamed,
//! deleted, or hosted on a share that has since gone away, and Explorer's
//! answer to a path it cannot resolve is a modal error box — or, worse, a
//! window onto Documents, which reads as "TermX opened the wrong folder".
//! So the command validates first and simply answers `false` when there is
//! nothing to open; the renderer treats that as a no-op.
//!
//! Requiring an *absolute* path is the second job of that validation: it is
//! also what stops a cwd-shaped string like `/select,...` from reaching
//! `explorer.exe` as a switch rather than as a destination.

use std::path::{Path, PathBuf};

/// Tauri command: open `path` in the OS file manager. Returns whether a window
/// was actually asked for. Never errors.
#[tauri::command]
pub async fn open_folder(path: String) -> bool {
    // Probing a path can block for seconds on a disconnected network share and
    // spawning a process is not instant either: neither belongs on the IPC
    // thread, where it would freeze the window mid-click.
    tauri::async_runtime::spawn_blocking(move || open_folder_at(Path::new(&path)))
        .await
        .unwrap_or(false)
}

/// Command body against the real environment.
pub fn open_folder_at(path: &Path) -> bool {
    match folder_to_open(path) {
        Some(dir) => launch_file_manager(&dir),
        None => false,
    }
}

/// The directory this path names, or `None` when it is not an absolute path to
/// an existing directory. `metadata` follows links, so a junction onto a real
/// folder — `C:\Users\All Users` and friends — passes like the folder it is.
pub(crate) fn folder_to_open(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    std::fs::metadata(path).ok().filter(|meta| meta.is_dir())?;
    Some(path.to_path_buf())
}

/// Ask the shell for a window and stop caring. `explorer.exe` hands the path
/// to the already-running desktop shell and exits non-zero even when that
/// worked, so waiting on it would report failure for every success.
#[cfg(windows)]
fn launch_file_manager(dir: &Path) -> bool {
    std::process::Command::new("explorer.exe")
        .arg(dir)
        .spawn()
        .is_ok()
}

/// The same job away from Windows, where two things differ: macOS has no
/// `xdg-open` (asking for it there is a silent no-op, not a folder), and a
/// spawned child has to be reaped or it stays a zombie until TermX exits.
/// Waiting does the reaping, costs nothing — we are already on a blocking
/// thread and both openers hand off to the desktop session and exit at once —
/// and unlike `explorer.exe` both report their success honestly.
#[cfg(not(windows))]
fn launch_file_manager(dir: &Path) -> bool {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    std::process::Command::new(opener)
        .arg(dir)
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Only the decision is tested. `launch_file_manager` is deliberately left
    // alone: a test that exercised it would open real Explorer windows on the
    // machine running the suite.

    #[test]
    fn an_existing_directory_is_the_one_opened() {
        let tmp = tempfile::tempdir().unwrap();
        let nested = tmp.path().join("project");
        std::fs::create_dir(&nested).unwrap();

        assert_eq!(folder_to_open(tmp.path()), Some(tmp.path().to_path_buf()));
        assert_eq!(folder_to_open(&nested), Some(nested.clone()));
    }

    #[test]
    fn a_file_is_not_a_folder_and_opens_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("notes.txt");
        std::fs::write(&file, b"not a directory").unwrap();

        assert_eq!(folder_to_open(&file), None);
    }

    #[test]
    fn a_cwd_that_no_longer_exists_opens_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(folder_to_open(&tmp.path().join("deleted")), None);
        assert_eq!(folder_to_open(&tmp.path().join("a").join("b")), None);
        assert!(!open_folder_at(&tmp.path().join("deleted")));
    }

    #[test]
    fn relative_and_empty_paths_are_refused_before_any_filesystem_touch() {
        for junk in ["", " ", ".", "..", "project", "./project"] {
            assert_eq!(folder_to_open(Path::new(junk)), None, "{junk:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn an_explorer_switch_can_never_reach_explorer() {
        // `/select,<path>` is how you ask Explorer to highlight an item rather
        // than open a folder. It is not an absolute Windows path, so the
        // absolute-path gate refuses it before it becomes an argument.
        for switch in ["/select,C:\\Windows", "/n", "/e,C:\\"] {
            assert_eq!(folder_to_open(Path::new(switch)), None, "{switch:?}");
        }
    }
}
