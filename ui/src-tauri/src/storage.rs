//! Renderer-owned app data files (settings and UI state) under the host data
//! dir, exposed as two invoke commands.
//!
//! The filename allowlist is checked before any path is built, so the renderer
//! cannot name a path at all — there is no traversal to sanitize afterwards.
//! Writes go through a temp file + rename so a crash or a full disk can never
//! leave a half-written settings file that then parses as "corrupt, use
//! defaults" and silently loses the user's configuration.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// The only names `read_app_file` / `write_app_file` will accept. Three of them
/// arrived after the originals: `llm_sessions` persists its scan index through
/// this same path, and saved sessions their pinned list, so every side shares
/// one allowlist and one atomic write rather than growing a second storage API.
pub const ALLOWED_FILES: [&str; 5] = [
    "settings_v1.json",
    "ui_state_v1.json",
    "sessions_index_v1.json",
    "conversations_v1.json",
    "saved_sessions_v1.json",
];

/// Keeps concurrent temp files distinct within one process (two debounced
/// writes landing together must not share a temp path and clobber each other).
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn ensure_allowed(name: &str) -> Result<(), String> {
    if ALLOWED_FILES.contains(&name) {
        Ok(())
    } else {
        Err(format!("app file not allowed: {name}"))
    }
}

fn allowed_path(base: &Path, name: &str) -> Result<PathBuf, String> {
    ensure_allowed(name)?;
    Ok(base.join(name))
}

/// Read an allowlisted file from `base`. Missing file (or missing dir) →
/// `Ok(None)`: a first run is not an error. Unreadable-but-present is.
pub fn read_file_in(base: &Path, name: &str) -> Result<Option<String>, String> {
    let path = allowed_path(base, name)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("reading {}: {e}", path.display())),
    }
}

/// Atomically replace an allowlisted file in `base`, creating `base` if needed.
pub fn write_file_in(base: &Path, name: &str, contents: &str) -> Result<(), String> {
    let path = allowed_path(base, name)?;
    std::fs::create_dir_all(base)
        .map_err(|e| format!("creating data dir {}: {e}", base.display()))?;

    // Temp file in the SAME directory: a same-volume rename is one atomic
    // metadata operation. A temp dir elsewhere would make the rename a
    // cross-volume copy+delete, which is exactly the torn write we are
    // avoiding.
    let tmp = base.join(format!(
        "{name}.{}.{}.tmp",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    if let Err(e) = std::fs::write(&tmp, contents.as_bytes()) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("writing {}: {e}", tmp.display()));
    }
    // std::fs::rename replaces an existing destination on Windows
    // (MOVEFILE_REPLACE_EXISTING) as well as on unix.
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("replacing {}: {e}", path.display()));
    }
    Ok(())
}

/// Validate the name BEFORE resolving the data dir, so a rejected name has no
/// filesystem side effects at all (`resolve_data_dir` creates the directory).
fn data_dir_for(name: &str) -> Result<PathBuf, String> {
    ensure_allowed(name)?;
    crate::paths::resolve_data_dir(None)
}

#[tauri::command]
pub fn read_app_file(name: String) -> Result<Option<String>, String> {
    let base = data_dir_for(&name)?;
    read_file_in(&base, &name)
}

#[tauri::command]
pub fn write_app_file(name: String, contents: String) -> Result<(), String> {
    let base = data_dir_for(&name)?;
    write_file_in(&base, &name, &contents)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SETTINGS: &str = "settings_v1.json";

    #[test]
    fn allowlist_is_exactly_the_five_app_files() {
        assert_eq!(
            ALLOWED_FILES,
            [
                "settings_v1.json",
                "ui_state_v1.json",
                "sessions_index_v1.json",
                "conversations_v1.json",
                "saved_sessions_v1.json",
            ]
        );
    }

    #[test]
    fn the_conversations_files_read_and_write_like_the_originals() {
        let tmp = tempfile::tempdir().unwrap();
        for name in ["sessions_index_v1.json", "conversations_v1.json"] {
            assert_eq!(read_file_in(tmp.path(), name).unwrap(), None);
            write_file_in(tmp.path(), name, "{\"version\":1}").unwrap();
            assert_eq!(
                read_file_in(tmp.path(), name).unwrap().as_deref(),
                Some("{\"version\":1}")
            );
        }
    }

    #[test]
    fn rejects_names_outside_the_allowlist_without_touching_disk() {
        let tmp = tempfile::tempdir().unwrap();
        for name in [
            "",
            "settings_v1.JSON",
            "settings_v2.json",
            "layout_v1.json",
            "runtime.json",
            r"..\escape.json",
            "sub/settings_v1.json",
            r"C:\Windows\System32\settings_v1.json",
            "settings_v1.json.tmp",
        ] {
            let read = read_file_in(tmp.path(), name);
            assert!(read.is_err(), "read must reject {name:?}");
            assert!(read.unwrap_err().contains("not allowed"));

            let write = write_file_in(tmp.path(), name, "{}");
            assert!(write.is_err(), "write must reject {name:?}");
            assert!(write.unwrap_err().contains("not allowed"));
        }
        // A rejected name must never have created anything.
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
    }

    #[test]
    fn missing_file_reads_as_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(read_file_in(tmp.path(), SETTINGS).unwrap(), None);
        // Missing directory too — first run, before any write.
        let absent = tmp.path().join("never-created");
        assert_eq!(read_file_in(&absent, "ui_state_v1.json").unwrap(), None);
    }

    #[test]
    fn write_then_read_round_trips_unicode_and_creates_the_data_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().join("nested").join("TermX");
        let body = "{\"newTabPolicy\":\"group-active\",\"note\":\"café ✓\"}";
        write_file_in(&base, SETTINGS, body).unwrap();
        assert!(base.is_dir(), "write must create the data dir");
        assert_eq!(read_file_in(&base, SETTINGS).unwrap().as_deref(), Some(body));
    }

    #[test]
    fn rewrite_replaces_contents_and_leaves_no_temp_files() {
        let tmp = tempfile::tempdir().unwrap();
        write_file_in(tmp.path(), SETTINGS, "first").unwrap();
        write_file_in(tmp.path(), SETTINGS, "second").unwrap();
        write_file_in(tmp.path(), "ui_state_v1.json", "state").unwrap();

        assert_eq!(read_file_in(tmp.path(), SETTINGS).unwrap().unwrap(), "second");

        let mut names: Vec<String> = std::fs::read_dir(tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec!["settings_v1.json".to_string(), "ui_state_v1.json".to_string()],
            "temp files must not survive a successful write"
        );
    }

    #[test]
    fn the_two_files_do_not_share_storage() {
        let tmp = tempfile::tempdir().unwrap();
        write_file_in(tmp.path(), SETTINGS, "settings body").unwrap();
        write_file_in(tmp.path(), "ui_state_v1.json", "state body").unwrap();
        assert_eq!(
            read_file_in(tmp.path(), SETTINGS).unwrap().unwrap(),
            "settings body"
        );
        assert_eq!(
            read_file_in(tmp.path(), "ui_state_v1.json").unwrap().unwrap(),
            "state body"
        );
    }
}
