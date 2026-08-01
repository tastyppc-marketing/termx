//! "Files touched" harvesting from a Claude session transcript (spec §11).
//!
//! A transcript is jsonl — one JSON object per line — and every `Write`,
//! `Edit`, `MultiEdit` and `NotebookEdit` tool call records the path it wrote
//! to. Transcripts routinely reach hundreds of megabytes, so the whole file is
//! streamed one line at a time and nothing here ever holds more than a single
//! line (over-long lines are discarded as they stream, not buffered).
//!
//! Like every viewer command this one cannot fail: an unreadable, missing or
//! malformed transcript yields an empty list, because "no files recorded" is
//! exactly what the detail pane should render either way.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

/// Tool calls that name a file they produced. Anything else in the transcript
/// (`Read`, `Bash`, tool *results*) is not an artifact.
const EDIT_TOOLS: [&str; 4] = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/// The only tool that can bring a file into existence; everything else in
/// `EDIT_TOOLS` modifies one that was already there.
const CREATE_TOOL: &str = "Write";

/// A transcript line above this is not a tool call worth trusting — a single
/// jsonl record that large is a pasted blob or corruption. Capping the buffer
/// is what keeps peak memory independent of the file's contents.
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// One file a session created or edited, as the detail pane renders it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub path: String,
    /// `"created"` if any `Write` targeted this path, else `"edited"`.
    pub kind: String,
    /// Stat at harvest time — vanished files still list, grayed out.
    pub exists: bool,
}

/// Tauri command: files touched by the session at `file_path`. Never errors.
#[tauri::command]
pub async fn list_session_artifacts(file_path: String) -> Vec<Artifact> {
    // Scanning a 100 MB transcript plus one stat per distinct path is far too
    // much work for the IPC thread; the pane expands asynchronously anyway.
    tauri::async_runtime::spawn_blocking(move || list_session_artifacts_at(Path::new(&file_path)))
        .await
        .unwrap_or_default()
}

/// Command body against the real filesystem.
pub fn list_session_artifacts_at(transcript: &Path) -> Vec<Artifact> {
    let Ok(file) = std::fs::File::open(transcript) else {
        return Vec::new();
    };
    let reader = BufReader::with_capacity(64 * 1024, file);
    artifacts_from(reader, |path| Path::new(path).exists())
}

/// Pure over the reader and the existence probe so tests need neither a real
/// transcript nor the files it mentions.
pub(crate) fn artifacts_from<R: BufRead>(
    mut reader: R,
    exists: impl Fn(&str) -> bool,
) -> Vec<Artifact> {
    // Dedupe is case-insensitive (Windows paths differ in case between tool
    // calls constantly), but the FIRST spelling seen is the one shown — it is
    // the one the model actually used.
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut order: Vec<(String, bool)> = Vec::new();
    let mut line = Vec::new();
    let mut targets = Vec::new();

    while read_capped_line(&mut reader, &mut line, MAX_LINE_BYTES).unwrap_or(false) {
        if line.is_empty() {
            continue; // blank, or a line dropped for being over the cap
        }
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            continue; // a truncated or non-JSON line is not worth complaining about
        };
        targets.clear();
        collect_tool_targets(&value, &mut targets);
        for (path, created) in targets.drain(..) {
            match seen.get(&path.to_lowercase()) {
                // `created` wins over `edited` no matter which order the calls
                // appear in: a file written once and edited later was created
                // by this session.
                Some(&idx) => order[idx].1 |= created,
                None => {
                    seen.insert(path.to_lowercase(), order.len());
                    order.push((path, created));
                }
            }
        }
    }

    order
        .into_iter()
        .map(|(path, created)| Artifact {
            exists: exists(&path),
            kind: if created { "created" } else { "edited" }.to_string(),
            path,
        })
        .collect()
}

/// Walk the whole JSON value looking for tool calls rather than assuming one
/// envelope shape: the same `tool_use` block sits under `message.content` in
/// today's transcripts and has moved before. Depth is bounded by serde_json's
/// own 128-level recursion limit, so this cannot blow the stack on hostile
/// input.
fn collect_tool_targets(value: &Value, out: &mut Vec<(String, bool)>) {
    match value {
        Value::Object(map) => {
            if let (Some(Value::String(name)), Some(input)) = (map.get("name"), map.get("input")) {
                if EDIT_TOOLS.contains(&name.as_str()) {
                    let target = input
                        .get("file_path")
                        .or_else(|| input.get("notebook_path"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|p| !p.is_empty());
                    if let Some(path) = target {
                        out.push((path.to_string(), name == CREATE_TOOL));
                    }
                }
            }
            for nested in map.values() {
                collect_tool_targets(nested, out);
            }
        }
        Value::Array(items) => {
            for nested in items {
                collect_tool_targets(nested, out);
            }
        }
        _ => {}
    }
}

/// Read one newline-terminated line into `buf`, *discarding* rather than
/// buffering anything past `cap` — the difference between a bounded scan and
/// loading a newline-free 100 MB file into RAM. A dropped line arrives as an
/// empty `buf`, which the caller already treats as "nothing to parse".
///
/// Returns `Ok(false)` only at end of input.
fn read_capped_line<R: BufRead>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    cap: usize,
) -> std::io::Result<bool> {
    buf.clear();
    let mut dropped = false;
    let mut any = false;
    loop {
        // `fill_buf` borrows the reader, so decide how much to consume inside
        // the block and release the borrow before consuming it.
        let (used, complete) = {
            let chunk = match reader.fill_buf() {
                Ok(chunk) => chunk,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            };
            if chunk.is_empty() {
                if dropped {
                    buf.clear();
                }
                return Ok(any);
            }
            any = true;
            match chunk.iter().position(|&b| b == b'\n') {
                Some(idx) => {
                    append_capped(buf, &chunk[..idx], cap, &mut dropped);
                    (idx + 1, true)
                }
                None => {
                    let len = chunk.len();
                    append_capped(buf, chunk, cap, &mut dropped);
                    (len, false)
                }
            }
        };
        reader.consume(used);
        if complete {
            if dropped {
                buf.clear();
            }
            return Ok(true);
        }
    }
}

fn append_capped(buf: &mut Vec<u8>, more: &[u8], cap: usize, dropped: &mut bool) {
    if *dropped || buf.len() + more.len() > cap {
        *dropped = true;
        return;
    }
    buf.extend_from_slice(more);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `tool_use` block in the shape today's transcripts write. Windows
    /// separators are JSON-escaped, exactly as a real transcript stores them.
    fn tool_line(name: &str, key: &str, path: &str) -> String {
        let path = path.replace('\\', r"\\");
        format!(
            r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"working"}},{{"type":"tool_use","id":"t1","name":"{name}","input":{{"{key}":"{path}"}}}}]}}}}"#
        )
    }

    fn harvest(lines: &[String]) -> Vec<Artifact> {
        let body = lines.join("\n");
        artifacts_from(body.as_bytes(), |_| true)
    }

    fn shape(artifacts: &[Artifact]) -> Vec<(&str, &str, bool)> {
        artifacts
            .iter()
            .map(|a| (a.path.as_str(), a.kind.as_str(), a.exists))
            .collect()
    }

    #[test]
    fn write_and_edit_dedupe_to_one_row_each_in_first_seen_order() {
        let got = harvest(&[
            tool_line("Write", "file_path", r"C:\p\a.rs"),
            tool_line("Edit", "file_path", r"C:\p\b.rs"),
            tool_line("Edit", "file_path", r"C:\p\a.rs"),
        ]);
        assert_eq!(
            shape(&got),
            vec![
                (r"C:\p\a.rs", "created", true),
                (r"C:\p\b.rs", "edited", true)
            ]
        );
    }

    #[test]
    fn created_beats_edited_whichever_call_came_first() {
        for order in [["Edit", "Write"], ["Write", "Edit"]] {
            let got = harvest(&[
                tool_line(order[0], "file_path", r"C:\p\a.rs"),
                tool_line(order[1], "file_path", r"C:\p\a.rs"),
            ]);
            assert_eq!(
                shape(&got),
                vec![(r"C:\p\a.rs", "created", true)],
                "{order:?}"
            );
        }
    }

    #[test]
    fn dedupe_is_case_insensitive_and_keeps_the_first_spelling() {
        let got = harvest(&[
            tool_line("Edit", "file_path", r"C:\Proj\App.tsx"),
            tool_line("Write", "file_path", r"c:\proj\app.tsx"),
            tool_line("Edit", "file_path", r"C:\PROJ\APP.TSX"),
        ]);
        assert_eq!(shape(&got), vec![(r"C:\Proj\App.tsx", "created", true)]);
    }

    #[test]
    fn multi_edit_and_notebook_edit_are_recognized() {
        let got = harvest(&[
            tool_line("MultiEdit", "file_path", r"C:\p\multi.rs"),
            tool_line("NotebookEdit", "notebook_path", r"C:\p\book.ipynb"),
        ]);
        assert_eq!(
            shape(&got),
            vec![
                (r"C:\p\multi.rs", "edited", true),
                (r"C:\p\book.ipynb", "edited", true)
            ]
        );
    }

    #[test]
    fn other_tools_and_malformed_lines_contribute_nothing() {
        let got = harvest(&[
            tool_line("Read", "file_path", r"C:\p\read-only.rs"),
            tool_line("Bash", "file_path", r"C:\p\bash.rs"),
            tool_line("Write", "file_path", "   "),
            "not json at all".to_string(),
            "{\"type\":\"assistant\",".to_string(),
            String::new(),
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#
                .to_string(),
            r#"{"name":"Write"}"#.to_string(),
            r#"{"name":"Write","input":{}}"#.to_string(),
        ]);
        assert!(got.is_empty(), "expected no artifacts, got {got:?}");
    }

    #[test]
    fn a_malformed_line_does_not_stop_the_scan() {
        let got = harvest(&[
            "{ broken".to_string(),
            tool_line("Write", "file_path", r"C:\p\after.rs"),
        ]);
        assert_eq!(shape(&got), vec![(r"C:\p\after.rs", "created", true)]);
    }

    #[test]
    fn tool_calls_are_found_wherever_they_sit_in_the_envelope() {
        // Bare block, and one nested two envelopes deeper than today's shape.
        let got = harvest(&[
            r#"{"type":"tool_use","name":"Write","input":{"file_path":"C:\\p\\bare.rs"}}"#
                .to_string(),
            r#"{"a":{"b":{"c":[{"name":"Edit","input":{"file_path":"C:\\p\\deep.rs"}}]}}}"#
                .to_string(),
        ]);
        assert_eq!(
            shape(&got),
            vec![
                (r"C:\p\bare.rs", "created", true),
                (r"C:\p\deep.rs", "edited", true)
            ]
        );
    }

    #[test]
    fn exists_reflects_the_filesystem_at_harvest_time() {
        let tmp = tempfile::tempdir().unwrap();
        let present = tmp.path().join("present.rs");
        let vanished = tmp.path().join("vanished.rs");
        std::fs::write(&present, b"fn main() {}").unwrap();

        let transcript = tmp.path().join("session.jsonl");
        std::fs::write(
            &transcript,
            format!(
                "{}\n{}\n",
                tool_line("Write", "file_path", &present.to_string_lossy()),
                tool_line("Edit", "file_path", &vanished.to_string_lossy())
            ),
        )
        .unwrap();

        let got = list_session_artifacts_at(&transcript);
        assert_eq!(
            shape(&got),
            vec![
                (present.to_string_lossy().as_ref(), "created", true),
                (vanished.to_string_lossy().as_ref(), "edited", false),
            ]
        );
    }

    #[test]
    fn missing_or_unreadable_transcripts_yield_no_artifacts() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(list_session_artifacts_at(&tmp.path().join("nope.jsonl")).is_empty());
        // A directory is openable on some platforms but never readable as jsonl.
        assert!(list_session_artifacts_at(tmp.path()).is_empty());
    }

    #[test]
    fn a_transcript_with_no_trailing_newline_still_yields_its_last_call() {
        let line = tool_line("Write", "file_path", r"C:\p\last.rs");
        let got = artifacts_from(line.as_bytes(), |_| true);
        assert_eq!(shape(&got), vec![(r"C:\p\last.rs", "created", true)]);
    }

    #[test]
    fn over_cap_lines_are_discarded_without_being_buffered() {
        let input = b"short\nthis line is far too long\nlast\n";
        let mut reader = &input[..];
        let mut buf = Vec::new();

        assert!(read_capped_line(&mut reader, &mut buf, 8).unwrap());
        assert_eq!(buf, b"short");
        assert!(read_capped_line(&mut reader, &mut buf, 8).unwrap());
        assert!(buf.is_empty(), "over-cap line must arrive empty");
        assert!(
            buf.capacity() <= 16,
            "over-cap bytes must never be buffered"
        );
        assert!(read_capped_line(&mut reader, &mut buf, 8).unwrap());
        assert_eq!(buf, b"last");
        assert!(!read_capped_line(&mut reader, &mut buf, 8).unwrap());
    }

    #[test]
    fn blank_lines_and_crlf_endings_do_not_derail_the_scan() {
        let body = format!(
            "\n\n{}\r\n\n",
            tool_line("Write", "file_path", r"C:\p\crlf.rs")
        );
        // The trailing \r makes the line invalid JSON only if serde is strict
        // about it; either way the scan must survive and find what it can.
        let got = artifacts_from(body.as_bytes(), |_| true);
        assert_eq!(shape(&got), vec![(r"C:\p\crlf.rs", "created", true)]);
    }
}
