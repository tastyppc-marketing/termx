//! Declared session outputs (polish spec P4) — the read side of the sidecar
//! `termx-output` writes.
//!
//! The sidecar (`<data dir>\outputs_v1.jsonl`) is an append-only log of two
//! kinds of line, both shaped the same:
//!
//! ```text
//! {"sessionKey":"claude:a1","termxSession":"7","path":"C:\\out\\report.md","label":"Report","atMs":1000}
//! {"sessionKey":"claude:a1","termxSession":null,"path":"C:\\out\\report.md","label":null,"atMs":2000,"dismissed":true}
//! ```
//!
//! The second is a **tombstone**: it hides every earlier record with the same
//! (sessionKey, path). Dismissing an entry never touches the file on disk —
//! Michael's requirement is to get an intermediary out of the list, not to
//! delete his work — and because the log is only ever appended to, a dismissal
//! survives restarts and rescans. A registration appended *after* a tombstone
//! brings the entry back: the newest line about a path always wins.
//!
//! Like every list-feeding command here, this cannot fail: a missing sidecar,
//! a half-written line, a line that is not JSON at all, all mean "nothing to
//! show" rather than an error dialog. Paths are data — they are listed and
//! opened by the viewer, never executed — so entries may point anywhere and no
//! containment check applies.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

/// Sidecar file name inside the resolved data dir. Must match the constant in
/// `host/src/bin/termx-output.rs` (the writer).
pub const SIDECAR_NAME: &str = "outputs_v1.jsonl";

/// A single log line above this is corruption, not a record; skipped without
/// buffering so one hostile line cannot decide our peak memory.
const MAX_LINE_BYTES: usize = 1024 * 1024;

/// One declared output as the detail pane and the output pane render it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputEntry {
    pub path: String,
    pub label: Option<String>,
    pub at_ms: i64,
    /// Stat at list time — a deliverable that has since been moved or deleted
    /// still lists, grayed out (same treatment as "files touched").
    pub exists: bool,
}

/// `<data dir>\outputs_v1.jsonl`, resolved at runtime exactly like the host
/// resolves everything else (override → portable.flag beside the exe →
/// `%APPDATA%\TermX`). Nothing absolute is hardcoded, and unlike
/// `paths::resolve_data_dir` this does not create the directory: reading a
/// list should have no side effects.
fn sidecar_path() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.to_path_buf()));
    let appdata = std::env::var("APPDATA").ok();
    crate::paths::choose_data_dir(None, exe_dir.as_deref(), appdata.as_deref())
        .ok()
        .map(|dir| dir.join(SIDECAR_NAME))
}

/// Tauri command: this session's declared outputs, newest first, tombstones
/// applied. Never errors — an unreadable sidecar is an empty list.
#[tauri::command]
pub async fn list_session_outputs(session_key: String) -> Vec<OutputEntry> {
    tauri::async_runtime::spawn_blocking(move || match sidecar_path() {
        Some(sidecar) => list_session_outputs_at(&sidecar, &session_key),
        None => Vec::new(),
    })
    .await
    .unwrap_or_default()
}

/// Tauri command: hide `path` from `session_key`'s list by appending a
/// tombstone. `false` means nothing was dismissed — no live entry matched, or
/// the sidecar could not be written. The file at `path` is never touched.
#[tauri::command]
pub async fn dismiss_session_output(session_key: String, path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || match sidecar_path() {
        Some(sidecar) => dismiss_session_output_at(&sidecar, &session_key, &path),
        None => false,
    })
    .await
    .unwrap_or(false)
}

/// Command body against a given sidecar file (tests pass a temp path).
pub fn list_session_outputs_at(sidecar: &Path, session_key: &str) -> Vec<OutputEntry> {
    live_entries(sidecar, session_key, |path| Path::new(path).exists())
}

/// Command body against a given sidecar file. Appends the tombstone only when
/// there is something to hide, so a stray dismissal cannot grow the log.
pub fn dismiss_session_output_at(sidecar: &Path, session_key: &str, path: &str) -> bool {
    let live = live_entries(sidecar, session_key, |_| false);
    if !live.iter().any(|entry| same_path(&entry.path, path)) {
        return false;
    }
    append_tombstone(sidecar, session_key, path).is_ok()
}

/// Fold the log into the currently-live entries for one session, newest first.
///
/// Ordering is by `atMs` descending with insertion order as the tie-break, so
/// two records stamped in the same millisecond still come out in a stable,
/// log-faithful order.
fn live_entries(
    sidecar: &Path,
    session_key: &str,
    exists: impl Fn(&str) -> bool,
) -> Vec<OutputEntry> {
    let Ok(file) = std::fs::File::open(sidecar) else {
        return Vec::new(); // no sidecar yet: nothing has ever been declared
    };
    let mut live = entries_from(BufReader::with_capacity(64 * 1024, file), session_key);
    live.sort_by(|a, b| b.1.at_ms.cmp(&a.1.at_ms).then(b.0.cmp(&a.0)));
    live.into_iter()
        .map(|(_, mut entry)| {
            entry.exists = exists(&entry.path);
            entry
        })
        .collect()
}

/// Pure over the reader: (sequence number, entry) for every path of
/// `session_key` still live at the end of the log.
fn entries_from<R: BufRead>(reader: R, session_key: &str) -> Vec<(usize, OutputEntry)> {
    // Keyed case-insensitively — Windows hands out both `C:\Out\a.md` and
    // `c:\out\a.md` for the same file, and a tombstone must catch its record
    // either way — but the spelling the writer used is what gets displayed.
    let mut live: HashMap<String, (usize, OutputEntry)> = HashMap::new();
    for (seq, line) in reader.lines().enumerate() {
        let Ok(line) = line else {
            break; // unreadable mid-file (or invalid UTF-8): stop, keep what we have
        };
        if line.len() > MAX_LINE_BYTES {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue; // blank, truncated, or not JSON — the log is best-effort
        };
        let Some(record) = parse_record(&value, session_key) else {
            continue;
        };
        let key = record.path.to_lowercase();
        if record.dismissed {
            live.remove(&key);
        } else {
            // A re-registration replaces the earlier one (new label, new
            // timestamp) and, after a tombstone, resurrects the entry.
            live.insert(
                key,
                (
                    seq,
                    OutputEntry {
                        path: record.path,
                        label: record.label,
                        at_ms: record.at_ms,
                        exists: false,
                    },
                ),
            );
        }
    }
    live.into_values().collect()
}

struct ParsedRecord {
    path: String,
    label: Option<String>,
    at_ms: i64,
    dismissed: bool,
}

/// Tolerant field read: anything without a non-empty string `path` and a
/// matching `sessionKey` is not a record for this session. `atMs` and `label`
/// are optional (a hand-written line, or a future writer, still lists).
fn parse_record(value: &Value, session_key: &str) -> Option<ParsedRecord> {
    if value.get("sessionKey").and_then(Value::as_str) != Some(session_key) {
        return None;
    }
    let path = value.get("path").and_then(Value::as_str)?.trim().to_string();
    if path.is_empty() {
        return None;
    }
    Some(ParsedRecord {
        path,
        label: value
            .get("label")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        at_ms: value.get("atMs").and_then(Value::as_i64).unwrap_or(0),
        dismissed: value
            .get("dismissed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn same_path(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Append `{sessionKey, termxSession: null, path, label: null, atMs,
/// dismissed: true}` — same shape as a registration so one parser reads both.
fn append_tombstone(sidecar: &Path, session_key: &str, path: &str) -> std::io::Result<()> {
    let record = serde_json::json!({
        "sessionKey": session_key,
        "termxSession": Value::Null,
        "path": path,
        "label": Value::Null,
        "atMs": now_ms(),
        "dismissed": true,
    });
    let mut line = record.to_string();
    line.push('\n');
    if let Some(parent) = sidecar.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(sidecar)?;
    file.write_all(line.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sidecar_with(lines: &[&str]) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(SIDECAR_NAME);
        std::fs::write(&path, lines.join("\n")).unwrap();
        (tmp, path)
    }

    fn record(session: &str, path: &str, at_ms: i64) -> String {
        format!(
            r#"{{"sessionKey":"{session}","termxSession":null,"path":"{path}","label":null,"atMs":{at_ms}}}"#
        )
    }

    fn tombstone(session: &str, path: &str, at_ms: i64) -> String {
        format!(
            r#"{{"sessionKey":"{session}","path":"{path}","atMs":{at_ms},"dismissed":true}}"#
        )
    }

    fn paths(entries: &[OutputEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.path.as_str()).collect()
    }

    #[test]
    fn missing_sidecar_lists_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let sidecar = tmp.path().join(SIDECAR_NAME);
        assert!(list_session_outputs_at(&sidecar, "claude:a").is_empty());
    }

    #[test]
    fn lists_only_the_requested_sessions_records() {
        let (_tmp, sidecar) = sidecar_with(&[
            &record("claude:a", "C:/out/a.md", 10),
            &record("claude:b", "C:/out/b.md", 20),
            r#"{"sessionKey":null,"path":"C:/out/loose.md","atMs":30}"#,
        ]);
        assert_eq!(
            paths(&list_session_outputs_at(&sidecar, "claude:a")),
            vec!["C:/out/a.md"]
        );
    }

    #[test]
    fn newest_first_with_label_and_at_ms() {
        let (_tmp, sidecar) = sidecar_with(&[
            &record("claude:a", "C:/out/old.md", 10),
            r#"{"sessionKey":"claude:a","path":"C:/out/new.md","label":"Deck","atMs":99}"#,
        ]);
        let got = list_session_outputs_at(&sidecar, "claude:a");
        assert_eq!(paths(&got), vec!["C:/out/new.md", "C:/out/old.md"]);
        assert_eq!(got[0].label.as_deref(), Some("Deck"));
        assert_eq!(got[0].at_ms, 99);
        assert_eq!(got[1].label, None);
    }

    #[test]
    fn a_tombstone_hides_the_earlier_record() {
        let (_tmp, sidecar) = sidecar_with(&[
            &record("claude:a", "C:/out/a.md", 10),
            &record("claude:a", "C:/out/keep.md", 11),
            &tombstone("claude:a", "C:/out/a.md", 12),
        ]);
        assert_eq!(
            paths(&list_session_outputs_at(&sidecar, "claude:a")),
            vec!["C:/out/keep.md"]
        );
    }

    #[test]
    fn a_tombstone_matches_case_insensitively() {
        let (_tmp, sidecar) = sidecar_with(&[
            &record("claude:a", "C:/Out/Report.md", 10),
            &tombstone("claude:a", "c:/out/report.md", 12),
        ]);
        assert!(list_session_outputs_at(&sidecar, "claude:a").is_empty());
    }

    #[test]
    fn a_tombstone_is_scoped_to_its_session_and_path() {
        let (_tmp, sidecar) = sidecar_with(&[
            &record("claude:a", "C:/out/a.md", 10),
            &record("claude:b", "C:/out/a.md", 11),
            &tombstone("claude:b", "C:/out/a.md", 12),
            &tombstone("claude:a", "C:/out/other.md", 13),
        ]);
        assert_eq!(
            paths(&list_session_outputs_at(&sidecar, "claude:a")),
            vec!["C:/out/a.md"],
            "another session's dismissal must not hide this one's record"
        );
        assert!(list_session_outputs_at(&sidecar, "claude:b").is_empty());
    }

    #[test]
    fn a_later_registration_resurrects_a_dismissed_path() {
        let (_tmp, sidecar) = sidecar_with(&[
            &record("claude:a", "C:/out/a.md", 10),
            &tombstone("claude:a", "C:/out/a.md", 11),
            r#"{"sessionKey":"claude:a","path":"C:/out/a.md","label":"Final","atMs":12}"#,
        ]);
        let got = list_session_outputs_at(&sidecar, "claude:a");
        assert_eq!(paths(&got), vec!["C:/out/a.md"]);
        assert_eq!(got[0].label.as_deref(), Some("Final"));
    }

    #[test]
    fn a_repeated_registration_lists_once_with_the_newest_label() {
        let (_tmp, sidecar) = sidecar_with(&[
            r#"{"sessionKey":"claude:a","path":"C:/out/a.md","label":"draft","atMs":10}"#,
            r#"{"sessionKey":"claude:a","path":"C:/out/a.md","label":"final","atMs":20}"#,
        ]);
        let got = list_session_outputs_at(&sidecar, "claude:a");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].label.as_deref(), Some("final"));
        assert_eq!(got[0].at_ms, 20);
    }

    #[test]
    fn corrupt_and_partial_lines_are_skipped_not_fatal() {
        let (_tmp, sidecar) = sidecar_with(&[
            "not json at all",
            "",
            r#"{"sessionKey":"claude:a"}"#,   // no path
            r#"{"sessionKey":"claude:a","path":"   "}"#, // blank path
            r#"{"path":"C:/out/nokey.md","atMs":5}"#, // no session key
            &record("claude:a", "C:/out/good.md", 10),
            r#"{"sessionKey":"claude:a","path":"C:/out/trunc"#, // half-written tail
        ]);
        assert_eq!(
            paths(&list_session_outputs_at(&sidecar, "claude:a")),
            vec!["C:/out/good.md"]
        );
    }

    #[test]
    fn a_record_without_at_ms_still_lists() {
        let (_tmp, sidecar) =
            sidecar_with(&[r#"{"sessionKey":"claude:a","path":"C:/out/a.md"}"#]);
        let got = list_session_outputs_at(&sidecar, "claude:a");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].at_ms, 0);
    }

    #[test]
    fn exists_reflects_the_filesystem() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real.md");
        std::fs::write(&real, b"x").unwrap();
        let sidecar = tmp.path().join(SIDECAR_NAME);
        std::fs::write(
            &sidecar,
            format!(
                "{}\n{}\n",
                record("claude:a", &real.display().to_string().replace('\\', "\\\\"), 20),
                record("claude:a", "C:/out/gone.md", 10),
            ),
        )
        .unwrap();
        let got = list_session_outputs_at(&sidecar, "claude:a");
        assert_eq!(got.len(), 2);
        assert!(got[0].exists, "the file that is there");
        assert!(!got[1].exists, "the one that vanished still lists, grayed");
    }

    #[test]
    fn dismiss_appends_a_tombstone_and_hides_the_entry() {
        let (_tmp, sidecar) = sidecar_with(&[&record("claude:a", "C:/out/a.md", 10), ""]);
        assert!(dismiss_session_output_at(&sidecar, "claude:a", "C:/out/a.md"));
        assert!(list_session_outputs_at(&sidecar, "claude:a").is_empty());
        let text = std::fs::read_to_string(&sidecar).unwrap();
        assert!(
            text.contains(&record("claude:a", "C:/out/a.md", 10)),
            "append-only: the original record is still in the log"
        );
        assert!(text.contains(r#""dismissed":true"#));
    }

    #[test]
    fn dismiss_is_false_and_writes_nothing_when_no_entry_matches() {
        let (_tmp, sidecar) = sidecar_with(&[&record("claude:a", "C:/out/a.md", 10)]);
        let before = std::fs::read_to_string(&sidecar).unwrap();
        assert!(!dismiss_session_output_at(
            &sidecar,
            "claude:a",
            "C:/out/never.md"
        ));
        assert!(!dismiss_session_output_at(&sidecar, "claude:z", "C:/out/a.md"));
        assert_eq!(std::fs::read_to_string(&sidecar).unwrap(), before);
    }

    #[test]
    fn dismiss_on_a_missing_sidecar_is_false() {
        let tmp = tempfile::tempdir().unwrap();
        let sidecar = tmp.path().join(SIDECAR_NAME);
        assert!(!dismiss_session_output_at(&sidecar, "claude:a", "C:/out/a.md"));
        assert!(!sidecar.exists());
    }

    #[test]
    fn dismiss_matches_the_path_case_insensitively() {
        let (_tmp, sidecar) = sidecar_with(&[&record("claude:a", "C:/Out/A.md", 10)]);
        assert!(dismiss_session_output_at(&sidecar, "claude:a", "c:/out/a.md"));
        assert!(list_session_outputs_at(&sidecar, "claude:a").is_empty());
    }

    #[test]
    fn entries_serialize_camel_case_for_the_ui() {
        let json = serde_json::to_value(OutputEntry {
            path: "C:/out/a.md".to_string(),
            label: None,
            at_ms: 7,
            exists: true,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "path": "C:/out/a.md",
                "label": Value::Null,
                "atMs": 7,
                "exists": true,
            })
        );
    }
}
