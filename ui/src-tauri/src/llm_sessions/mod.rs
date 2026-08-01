//! Discovery of local Claude Code and Codex sessions.
//!
//! Two rules shape everything here. First, session stores are read-only user
//! data we do not own: a malformed line, a half-written file or a missing root
//! is normal, so every layer degrades to "fewer records" and the commands
//! cannot fail. Second, transcripts routinely exceed 100 MB, so no code path
//! ever reads a whole one — adapters read a bounded head and tail (256 KB
//! each) and the scan skips files whose size and mtime match the persisted
//! index.
//!
//! Registration lives in `lib.rs` (main thread owns that file): the commands
//! are `llm_sessions::list_llm_sessions` and
//! `llm_sessions::generate_session_note`.

pub mod claude;
pub mod codex;
pub mod index;
pub mod note;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use index::SessionIndex;

/// App file holding the incremental scan results. Must stay in
/// `storage::ALLOWED_FILES` or the index silently stops persisting.
pub const INDEX_FILE: &str = "sessions_index_v1.json";

/// One discovered session, in the shape the renderer consumes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    /// `"claude"` or `"codex"`.
    pub provider: String,
    /// Provider-native session id; the resume command is built from it.
    pub id: String,
    /// Never empty — falls back through summary to the id.
    pub title: String,
    /// Absolute directory the session ran in, when it could be determined.
    pub cwd: Option<String>,
    /// Absolute path of the source transcript. Empty when the provider index
    /// knows a session whose transcript file could not be located; such a
    /// session is still resumable, it just has nothing to open or summarize.
    pub file_path: String,
    pub updated_at_ms: u64,
    pub summary: Option<String>,
    pub recap: Option<String>,
}

/// Where the two providers keep their data. Injected so tests drive whole
/// scans from tempdirs.
#[derive(Clone, Debug)]
pub struct Roots {
    /// `<home>\.claude\projects`
    pub claude_projects: PathBuf,
    /// `<home>\.codex`
    pub codex_home: PathBuf,
}

impl Roots {
    /// Roots under an arbitrary home directory.
    pub fn under_home(home: &Path) -> Self {
        Self {
            claude_projects: home.join(".claude").join("projects"),
            codex_home: home.join(".codex"),
        }
    }
}

/// Real roots for the signed-in user. `None` when the environment names no
/// home at all, which is not an error — it just means nothing to scan.
pub fn default_roots() -> Option<Roots> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(Roots::under_home(Path::new(&home)))
}

/// Milliseconds since the epoch, or 0 when the filesystem will not say.
/// Sorting a whole-list-of-zeros is worse than sorting by a bad clock, but
/// both beat dropping the session.
pub(crate) fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Scan both providers, reusing `index` for files whose size and mtime are
/// unchanged, and leaving `index` holding exactly what was seen (so vanished
/// sessions disappear from disk too). `force` re-harvests everything.
///
/// Codex is only half-cached on purpose: title and recency come from its
/// index file on every scan because they are already parsed, while the
/// expensive part — opening the rollout file for the cwd — is what the cache
/// protects.
pub fn scan_roots(roots: &Roots, index: &mut SessionIndex, force: bool) -> Vec<SessionRecord> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut out: Vec<SessionRecord> = Vec::new();

    scan_claude(&roots.claude_projects, index, force, &mut seen, &mut out);
    scan_codex(&roots.codex_home, index, force, &mut seen, &mut out);

    index.entries.retain(|key, _| seen.contains(key));
    // Newest first; the id tie-break keeps the order stable when a batch of
    // files shares an mtime (common right after a checkout).
    out.sort_by(|a, b| {
        b.updated_at_ms
            .cmp(&a.updated_at_ms)
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

fn scan_claude(
    projects: &Path,
    index: &mut SessionIndex,
    force: bool,
    seen: &mut BTreeSet<String>,
    out: &mut Vec<SessionRecord>,
) {
    let Ok(slugs) = std::fs::read_dir(projects) else {
        return; // no Claude on this machine
    };
    for slug in slugs.flatten() {
        if !slug.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Ok(files) = std::fs::read_dir(slug.path()) else {
            continue;
        };
        for file in files.flatten() {
            // Top-level `.jsonl` only: `tool-results` and friends are
            // subdirectories of supporting data, not sessions.
            if !file.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let path = file.path();
            if !has_jsonl_extension(&path) {
                continue;
            }
            let Ok(meta) = file.metadata() else {
                continue;
            };
            let key = path.to_string_lossy().into_owned();
            let stat = (mtime_ms(&meta), meta.len());
            if !force {
                if let Some(entry) = index.unchanged(&key, stat.0, stat.1) {
                    out.push(entry.record.clone());
                    seen.insert(key);
                    continue;
                }
            }
            let Some(record) = claude::harvest_claude_file(&path) else {
                continue;
            };
            index.put(&key, stat.0, stat.1, record.clone());
            seen.insert(key);
            out.push(record);
        }
    }
}

fn scan_codex(
    codex_home: &Path,
    index: &mut SessionIndex,
    force: bool,
    seen: &mut BTreeSet<String>,
    out: &mut Vec<SessionRecord>,
) {
    let index_path = codex_home.join(codex::INDEX_FILE);
    let Ok(text) = std::fs::read_to_string(&index_path) else {
        return; // no Codex on this machine
    };
    let index_mtime = std::fs::metadata(&index_path)
        .map(|m| mtime_ms(&m))
        .unwrap_or(0);
    let rollouts = codex::rollout_files(&codex_home.join(codex::SESSIONS_DIR));

    for entry in codex::parse_codex_index(&text) {
        let rollout = rollouts.get(&entry.id);
        let (key, stat, file_path) = match rollout {
            Some(path) => {
                let meta = std::fs::metadata(path).ok();
                let stat = meta.map_or((0, 0), |m| (mtime_ms(&m), m.len()));
                (
                    path.to_string_lossy().into_owned(),
                    stat,
                    path.to_string_lossy().into_owned(),
                )
            }
            // No transcript on disk: key the entry by id so it still takes
            // part in the vanished-entry sweep, and stat it against the
            // provider index that produced it.
            None => (
                format!("codex:{}", entry.id),
                (index_mtime, 0),
                String::new(),
            ),
        };

        let cached = if force {
            None
        } else {
            index
                .unchanged(&key, stat.0, stat.1)
                .map(|e| e.record.clone())
        };
        let cwd = match cached {
            Some(record) => record.cwd,
            None => rollout.and_then(|path| codex::rollout_cwd_of(path)),
        };

        let record = SessionRecord {
            provider: "codex".to_string(),
            title: non_empty_title(&entry.title, &entry.id),
            id: entry.id,
            cwd,
            file_path,
            // An unparseable index timestamp falls back to the transcript's
            // mtime so the row still sorts somewhere sensible.
            updated_at_ms: entry.updated_at_ms.unwrap_or(stat.0),
            summary: None,
            recap: None,
        };
        index.put(&key, stat.0, stat.1, record.clone());
        seen.insert(key);
        out.push(record);
    }
}

fn has_jsonl_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
}

fn non_empty_title(candidate: &str, id: &str) -> String {
    let cleaned = claude::clean_text(candidate, claude::TITLE_MAX_CHARS);
    if cleaned.is_empty() {
        id.to_string()
    } else {
        cleaned
    }
}

/// Tauri command: every discovered session, newest first. Never errors.
#[tauri::command]
pub async fn list_llm_sessions(force: bool) -> Vec<SessionRecord> {
    // A cold scan walks a thousand project directories and opens every
    // changed transcript; on the IPC thread that would freeze the window.
    tauri::async_runtime::spawn_blocking(move || list_sessions_now(force))
        .await
        .unwrap_or_default()
}

/// Command body against the real environment: load the index, scan, persist.
/// A failure to load or store the index costs a slower scan, never a result.
pub fn list_sessions_now(force: bool) -> Vec<SessionRecord> {
    let Some(roots) = default_roots() else {
        return Vec::new();
    };
    let data_dir = crate::paths::resolve_data_dir(None).ok();
    let stored = data_dir
        .as_deref()
        .and_then(|dir| crate::storage::read_file_in(dir, INDEX_FILE).ok().flatten());
    let mut index = index::parse_index(stored.as_deref());

    let records = scan_roots(&roots, &mut index, force);

    if let Some(dir) = data_dir {
        let _ = crate::storage::write_file_in(&dir, INDEX_FILE, &index.serialize());
    }
    records
}

/// Only transcripts inside a provider's own store may be summarized. The
/// renderer hands us a path, and without this check the command would read
/// the tail of ANY file and pipe it to the CLI — canonicalize both sides
/// (resolving symlinks and `..`) and require the target to live under
/// `.claude\projects` or `.codex\sessions`.
pub(crate) fn note_target_allowed(roots: &Roots, path: &Path) -> bool {
    let Ok(target) = std::fs::canonicalize(path) else {
        return false; // a transcript that cannot be resolved cannot be noted
    };
    [
        roots.claude_projects.clone(),
        roots.codex_home.join(codex::SESSIONS_DIR),
    ]
    .iter()
    .any(|root| {
        std::fs::canonicalize(root).is_ok_and(|root| target.starts_with(&root))
    })
}

/// Tauri command: an LLM-written note for one session. `kind` is `"summary"`
/// or `"recap"`. Any failure — unknown kind, path outside the provider
/// stores, missing binary, timeout, empty output — is `None`; the caller
/// keeps whatever it already had.
#[tauri::command]
pub async fn generate_session_note(file_path: String, kind: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&file_path);
        let allowed = default_roots()
            .map(|roots| note_target_allowed(&roots, path))
            .unwrap_or(false);
        if !allowed {
            return None;
        }
        note::generate_note_with(
            &note::resolve_program(note::DEFAULT_PROGRAM),
            path,
            &kind,
            note::DEFAULT_TIMEOUT,
        )
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("termx-sessions-")
            .tempdir()
            .unwrap()
    }

    /// Build paths one component at a time: a `join("a/b")` on Windows keeps
    /// the forward slash, and the index is keyed by the string `read_dir`
    /// produces, which uses backslashes throughout.
    fn at(base: &Path, parts: &[&str]) -> PathBuf {
        let mut path = base.to_path_buf();
        for part in parts {
            path.push(part);
        }
        path
    }

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn claude_session(home: &Path) -> PathBuf {
        at(
            home,
            &[".claude", "projects", "C--Dev-Proj", "aaaa-1111.jsonl"],
        )
    }

    fn user_line(text: &str) -> String {
        format!(
            "{{\"type\":\"user\",\"cwd\":\"C:\\\\Dev\\\\Proj\",\"message\":{{\"role\":\"user\",\"content\":{}}}}}",
            serde_json::to_string(text).unwrap()
        )
    }

    /// A home dir with one Claude session and one Codex session.
    fn fixture_home() -> tempfile::TempDir {
        let home = tempdir();
        write(&claude_session(home.path()), &user_line("build the thing"));
        write(
            &at(home.path(), &[".codex", "session_index.jsonl"]),
            "{\"id\":\"019ce354-0101-7a92-9a4d-3123a993d4f9\",\"thread_name\":\"Audit repo\",\"updated_at\":\"2026-03-12T18:34:21.1342818Z\"}\n",
        );
        write(
            &at(
                home.path(),
                &[
                    ".codex",
                    "sessions",
                    "2026",
                    "03",
                    "12",
                    "rollout-2026-03-12T18-34-21-019ce354-0101-7a92-9a4d-3123a993d4f9.jsonl",
                ],
            ),
            "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"C:\\\\Dev\\\\Audit\"}}\n",
        );
        home
    }

    #[test]
    fn scans_both_providers_newest_first() {
        let home = fixture_home();
        let mut index = SessionIndex::empty();
        let got = scan_roots(&Roots::under_home(home.path()), &mut index, false);

        assert_eq!(got.len(), 2, "one session per provider: {got:?}");
        let claude = got.iter().find(|r| r.provider == "claude").unwrap();
        assert_eq!(claude.id, "aaaa-1111");
        assert_eq!(claude.title, "build the thing");
        assert_eq!(claude.cwd.as_deref(), Some(r"C:\Dev\Proj"));

        let codex = got.iter().find(|r| r.provider == "codex").unwrap();
        assert_eq!(codex.title, "Audit repo");
        assert_eq!(codex.cwd.as_deref(), Some(r"C:\Dev\Audit"));
        assert!(codex.file_path.ends_with(".jsonl"));

        // The Claude fixture was written now; the Codex entry is dated 2026-03.
        assert!(
            got[0].updated_at_ms >= got[1].updated_at_ms,
            "sorted desc: {got:?}"
        );
        assert_eq!(index.entries.len(), 2, "both keyed in the index");
    }

    #[test]
    fn missing_roots_yield_no_records_and_no_entries() {
        let empty = tempdir();
        let mut index = SessionIndex::empty();
        let got = scan_roots(&Roots::under_home(empty.path()), &mut index, false);
        assert!(got.is_empty(), "nothing to find: {got:?}");
        assert!(index.entries.is_empty());
    }

    #[test]
    fn unchanged_file_is_served_from_the_index_without_reading_it() {
        let home = fixture_home();
        let path = claude_session(home.path());
        let meta = std::fs::metadata(&path).unwrap();

        // Poison the cache: same stat, deliberately wrong content. Reading the
        // file would produce "build the thing".
        let mut index = SessionIndex::empty();
        let mut poisoned = SessionRecord {
            provider: "claude".to_string(),
            id: "aaaa-1111".to_string(),
            title: "FROM THE INDEX".to_string(),
            cwd: None,
            file_path: path.to_string_lossy().into_owned(),
            updated_at_ms: 42,
            summary: None,
            recap: None,
        };
        index.put(
            &path.to_string_lossy(),
            mtime_ms(&meta),
            meta.len(),
            poisoned.clone(),
        );

        let got = scan_roots(&Roots::under_home(home.path()), &mut index, false);
        let claude = got.iter().find(|r| r.provider == "claude").unwrap();
        assert_eq!(claude.title, "FROM THE INDEX", "unchanged file was re-read");

        // And a stat mismatch alone is enough to invalidate it.
        poisoned.title = "STILL CACHED".to_string();
        index.put(&path.to_string_lossy(), mtime_ms(&meta), 999_999, poisoned);
        let got = scan_roots(&Roots::under_home(home.path()), &mut index, false);
        let claude = got.iter().find(|r| r.provider == "claude").unwrap();
        assert_eq!(claude.title, "build the thing", "changed size must re-read");
    }

    #[test]
    fn force_ignores_a_matching_index_entry() {
        let home = fixture_home();
        let path = claude_session(home.path());
        let meta = std::fs::metadata(&path).unwrap();
        let mut index = SessionIndex::empty();
        index.put(
            &path.to_string_lossy(),
            mtime_ms(&meta),
            meta.len(),
            SessionRecord {
                provider: "claude".to_string(),
                id: "aaaa-1111".to_string(),
                title: "FROM THE INDEX".to_string(),
                cwd: None,
                file_path: path.to_string_lossy().into_owned(),
                updated_at_ms: 42,
                summary: None,
                recap: None,
            },
        );

        let got = scan_roots(&Roots::under_home(home.path()), &mut index, true);
        let claude = got.iter().find(|r| r.provider == "claude").unwrap();
        assert_eq!(claude.title, "build the thing");
    }

    #[test]
    fn vanished_files_leave_the_index() {
        let home = fixture_home();
        let mut index = SessionIndex::empty();
        scan_roots(&Roots::under_home(home.path()), &mut index, false);
        assert_eq!(index.entries.len(), 2);

        std::fs::remove_file(claude_session(home.path())).unwrap();
        let got = scan_roots(&Roots::under_home(home.path()), &mut index, false);

        assert_eq!(got.len(), 1, "only the codex session survives: {got:?}");
        assert_eq!(index.entries.len(), 1);
        assert!(
            index.entries.keys().all(|k| !k.contains("aaaa-1111")),
            "stale entry kept: {:?}",
            index.entries.keys().collect::<Vec<_>>()
        );
    }

    #[test]
    fn codex_session_without_a_rollout_file_still_lists() {
        let home = tempdir();
        write(
            &at(home.path(), &[".codex", "session_index.jsonl"]),
            "{\"id\":\"no-rollout-id\",\"thread_name\":\"\",\"updated_at\":\"2026-03-12T18:34:21Z\"}\n",
        );
        let mut index = SessionIndex::empty();
        let got = scan_roots(&Roots::under_home(home.path()), &mut index, false);

        assert_eq!(got.len(), 1);
        assert_eq!(got[0].cwd, None, "no rollout, no cwd");
        assert_eq!(got[0].file_path, "", "nothing to open");
        assert_eq!(
            got[0].title, "no-rollout-id",
            "blank thread name falls back"
        );
        assert!(index.entries.contains_key("codex:no-rollout-id"));
    }

    #[test]
    fn non_session_files_and_subdirectories_are_ignored() {
        let home = tempdir();
        let project = at(home.path(), &[".claude", "projects", "C--Dev-Proj"]);
        write(&project.join("real.jsonl"), &user_line("hello"));
        write(&project.join("notes.txt"), "not a session");
        write(
            &at(&project, &["tool-results", "inner.jsonl"]),
            &user_line("nested"),
        );
        let mut index = SessionIndex::empty();
        let got = scan_roots(&Roots::under_home(home.path()), &mut index, false);

        assert_eq!(got.len(), 1, "top-level jsonl only: {got:?}");
        assert_eq!(got[0].id, "real");
    }

    #[test]
    fn the_index_file_round_trips_through_the_storage_allowlist() {
        assert!(
            crate::storage::ALLOWED_FILES.contains(&INDEX_FILE),
            "the index cannot persist unless storage allows its name"
        );
        let dir = tempdir();
        let mut index = SessionIndex::empty();
        index.put(
            "key",
            7,
            9,
            SessionRecord {
                provider: "claude".to_string(),
                id: "id".to_string(),
                title: "t".to_string(),
                cwd: None,
                file_path: "p".to_string(),
                updated_at_ms: 5,
                summary: None,
                recap: None,
            },
        );
        crate::storage::write_file_in(dir.path(), INDEX_FILE, &index.serialize()).unwrap();
        let text = crate::storage::read_file_in(dir.path(), INDEX_FILE).unwrap();
        assert_eq!(index::parse_index(text.as_deref()).entries, index.entries);
    }

    #[test]
    fn note_targets_outside_the_provider_stores_are_refused() {
        let home = fixture_home();
        let roots = Roots::under_home(home.path());

        let claude = claude_session(home.path());
        assert!(note_target_allowed(&roots, &claude), "own store is allowed");
        let codex_rollout = at(
            home.path(),
            &[
                ".codex",
                "sessions",
                "2026",
                "03",
                "12",
                "rollout-2026-03-12T18-34-21-019ce354-0101-7a92-9a4d-3123a993d4f9.jsonl",
            ],
        );
        assert!(note_target_allowed(&roots, &codex_rollout));

        // Outside both stores, a traversal that ends outside, the codex index
        // (adjacent to but not inside sessions\), and a missing file.
        let secret = home.path().join("secret.txt");
        std::fs::write(&secret, b"nope").unwrap();
        assert!(!note_target_allowed(&roots, &secret));
        let traversal = at(
            home.path(),
            &[".claude", "projects", "C--Dev-Proj", "..", "..", "..", "secret.txt"],
        );
        assert!(!note_target_allowed(&roots, &traversal), "dot-dot escape");
        assert!(!note_target_allowed(
            &roots,
            &at(home.path(), &[".codex", "session_index.jsonl"])
        ));
        assert!(!note_target_allowed(
            &roots,
            &at(home.path(), &[".claude", "projects", "gone", "x.jsonl"])
        ));
    }

    #[test]
    fn records_serialize_in_camel_case() {
        let json = serde_json::to_string(&SessionRecord {
            provider: "claude".to_string(),
            id: "id".to_string(),
            title: "t".to_string(),
            cwd: Some(r"C:\Dev".to_string()),
            file_path: "p".to_string(),
            updated_at_ms: 5,
            summary: None,
            recap: None,
        })
        .unwrap();
        assert!(json.contains("\"filePath\":\"p\""), "{json}");
        assert!(json.contains("\"updatedAtMs\":5"), "{json}");
        assert!(json.contains("\"summary\":null"), "{json}");
    }
}
