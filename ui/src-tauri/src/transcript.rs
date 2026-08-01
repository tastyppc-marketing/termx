//! Windowed transcript reads and server-side transcript search (spec §12).
//!
//! Transcript mode renders a session's COMPLETE conversation, which means the
//! file is never loaded: a 500 MB transcript must cost the same per page as a
//! 1 MB one. Both commands here are therefore bounded — `read_transcript_window`
//! reads exactly one clamped chunk per call, `search_transcript` streams one
//! line at a time — and neither ever reports an error to the renderer, because
//! a missing or malformed transcript is "nothing to show", not a dialog.
//!
//! **The cursor contract** (the part everything else depends on). A window
//! covers the bytes `[start, before_offset)`. Its leading bytes are almost
//! always the tail of a line that began before `start`, so they are dropped and
//! the offset just past that line's newline — the first byte of the first
//! COMPLETE line in the window — is handed back as `nextBeforeOffset`. The next
//! call ends exactly there, so the line whose tail was dropped is delivered
//! whole by that call and by no other. Walking the cursors backward therefore
//! reconstructs the file exactly: no line is lost, none is delivered twice, and
//! the walk ends when a window reaches offset 0.
//!
//! One line longer than the window cannot honour that (the whole window is one
//! line's middle). Rather than lose those bytes or read unbounded, such a
//! window returns the piece it holds as a "line" and steps the cursor back by
//! the window: the pieces still concatenate to the original line, the UI's
//! tolerant parse skips them, and the cursor still strictly decreases so the
//! walk always terminates.

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use regex::RegexBuilder;
use serde::Serialize;
use serde_json::Value;

/// Window floor: smaller pages cost more round trips than they save.
pub const MIN_WINDOW_BYTES: u32 = 4 * 1024;

/// Window ceiling: the memory the command is allowed to touch per call.
pub const MAX_WINDOW_BYTES: u32 = 4 * 1024 * 1024;

/// `max_results` when the caller expresses no preference (spec §12).
const DEFAULT_MAX_RESULTS: u32 = 200;

/// Hard ceiling on `max_results`: the search bar navigates matches one at a
/// time, so a caller asking for a million rows is a bug, not a use case.
const MAX_MAX_RESULTS: u32 = 1000;

/// Snippet budget, in characters (not bytes — the renderer measures glyphs).
const SNIPPET_MAX_CHARS: usize = 200;

/// How much of the snippet is spent on context before the match.
const SNIPPET_LEAD_CHARS: usize = 40;

/// Matching only ever looks at this much of a line. A jsonl record longer than
/// this is a pasted blob; buffering it whole is how a streaming search turns
/// into an out-of-memory crash.
const MAX_LINE_BYTES: usize = 1024 * 1024;

/// One page of transcript, newest-first paging.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWindow {
    pub lines: Vec<String>,
    /// Where the next "load earlier" call should end, or `None` at the start of
    /// the file.
    pub next_before_offset: Option<u64>,
}

/// A search hit: the byte offset of the LINE START (so the window command can
/// load the chunk containing it) plus a display snippet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMatch {
    pub offset: u64,
    pub snippet: String,
}

/// Search hits plus whether the file held more than were returned.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub matches: Vec<TranscriptMatch>,
    pub truncated: bool,
}

/// Tauri command: one bounded page of transcript ending at `before_offset`
/// (default: end of file). Never errors.
#[tauri::command]
pub async fn read_transcript_window(
    file_path: String,
    before_offset: Option<u64>,
    max_bytes: u32,
) -> TranscriptWindow {
    tauri::async_runtime::spawn_blocking(move || {
        read_window_at(Path::new(&file_path), before_offset, max_bytes)
    })
    .await
    .unwrap_or_default()
}

/// Command body against the real filesystem.
pub fn read_window_at(path: &Path, before_offset: Option<u64>, max_bytes: u32) -> TranscriptWindow {
    let Ok(mut file) = std::fs::File::open(path) else {
        return TranscriptWindow::default();
    };
    let Ok(meta) = file.metadata() else {
        return TranscriptWindow::default();
    };
    if meta.is_dir() {
        return TranscriptWindow::default();
    }

    let len = meta.len();
    // A stale cursor (the file was rotated or replaced) must land inside the
    // file rather than seek past its end.
    let end = before_offset.unwrap_or(len).min(len);
    let span = u64::from(max_bytes.clamp(MIN_WINDOW_BYTES, MAX_WINDOW_BYTES));
    let start = end.saturating_sub(span);

    if file.seek(SeekFrom::Start(start)).is_err() {
        return TranscriptWindow::default();
    }
    let mut chunk = Vec::new();
    // `take` rather than a sized buffer: if the file shrank since the stat, a
    // short read is a smaller page, not a failure.
    if file.take(end - start).read_to_end(&mut chunk).is_err() {
        return TranscriptWindow::default();
    }
    split_window(&chunk, start)
}

/// Pure core: turn the bytes at `start` into a page plus the next cursor. See
/// the module docs for the contract this implements.
pub(crate) fn split_window(chunk: &[u8], start: u64) -> TranscriptWindow {
    if chunk.is_empty() {
        return TranscriptWindow::default();
    }
    // Nothing precedes offset 0, so the first byte starts a real line and there
    // is nothing earlier to page to.
    if start == 0 {
        return TranscriptWindow {
            lines: split_lines(chunk),
            next_before_offset: None,
        };
    }
    match chunk.iter().position(|&b| b == b'\n') {
        // Normal case: drop the partial leading line, report where the first
        // whole line begins.
        Some(idx) if idx + 1 < chunk.len() => TranscriptWindow {
            lines: split_lines(&chunk[idx + 1..]),
            next_before_offset: Some(start + idx as u64 + 1),
        },
        // The only newline is the last byte: the window holds the tail of an
        // over-long line and no complete line at all.
        Some(idx) => TranscriptWindow {
            lines: split_lines(&chunk[..idx]),
            next_before_offset: Some(start),
        },
        // No newline anywhere: the window is the middle of an over-long line.
        None => TranscriptWindow {
            lines: split_lines(chunk),
            next_before_offset: Some(start),
        },
    }
}

/// Split a body on newlines, lossily decoding each line. A trailing newline is
/// a terminator, not an empty final line — but a blank line in the middle is
/// real and is kept.
fn split_lines(body: &[u8]) -> Vec<String> {
    if body.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<String> = body
        .split(|&b| b == b'\n')
        .map(|line| String::from_utf8_lossy(line).into_owned())
        .collect();
    if body.ends_with(b"\n") {
        lines.pop();
    }
    lines
}

/// Tauri command: stream `file_path` for `query`. `mode` is
/// `"substring"` (default, case-insensitive) | `"regex"` | `"fuzzy"`;
/// `filter` is `"all"` | `"user"`. An empty query or an invalid regex is an
/// empty result — the search bar is mid-typing, not broken. Never errors.
#[tauri::command]
pub async fn search_transcript(
    file_path: String,
    query: String,
    mode: String,
    filter: String,
    max_results: u32,
) -> SearchResult {
    tauri::async_runtime::spawn_blocking(move || {
        search_file(Path::new(&file_path), &query, &mode, &filter, max_results)
    })
    .await
    .unwrap_or_default()
}

/// Command body against the real filesystem.
pub fn search_file(
    path: &Path,
    query: &str,
    mode: &str,
    filter: &str,
    max_results: u32,
) -> SearchResult {
    let Ok(file) = std::fs::File::open(path) else {
        return SearchResult::default();
    };
    search_reader(
        BufReader::with_capacity(64 * 1024, file),
        query,
        mode,
        filter,
        max_results,
    )
}

/// Pure over the reader so tests need no file at all.
pub(crate) fn search_reader<R: BufRead>(
    reader: R,
    query: &str,
    mode: &str,
    filter: &str,
    max_results: u32,
) -> SearchResult {
    let Some(matcher) = Matcher::build(mode, query) else {
        return SearchResult::default();
    };
    let cap = effective_max_results(max_results);
    let user_only = filter == "user";
    let needs_lowercase = matcher.needs_lowercase();

    let mut result = SearchResult::default();
    let mut lowered = String::new();

    scan_lines(reader, |offset, bytes| {
        let line = String::from_utf8_lossy(bytes);
        if user_only && !is_user_line(&line) {
            return true;
        }
        if needs_lowercase {
            lowered.clear();
            lowered.extend(line.chars().flat_map(char::to_lowercase));
        }
        let Some(at) = matcher.find(&line, &lowered) else {
            return true;
        };
        // Finding one match past the cap is the cheapest way to know there are
        // more; there is no reason to keep scanning after that.
        if result.matches.len() >= cap {
            result.truncated = true;
            return false;
        }
        result.matches.push(TranscriptMatch {
            offset,
            snippet: snippet_for(&line, at),
        });
        true
    });

    result
}

/// `0` means "no preference" (the spec's default applies); everything else is
/// clamped so one call can never be asked for an unbounded number of rows.
fn effective_max_results(max_results: u32) -> usize {
    let wanted = if max_results == 0 {
        DEFAULT_MAX_RESULTS
    } else {
        max_results
    };
    wanted.min(MAX_MAX_RESULTS) as usize
}

/// The three search modes, pre-compiled once per call.
enum Matcher {
    /// Lowercased needle, matched against a lowercased line.
    Substring(String),
    Regex(regex::Regex),
    /// Lowercased needle characters, matched as a subsequence.
    Fuzzy(Vec<char>),
}

impl Matcher {
    /// `None` for an empty query or a pattern that will not compile — both are
    /// ordinary states of a search bar, and neither may panic.
    fn build(mode: &str, query: &str) -> Option<Self> {
        if query.is_empty() {
            return None;
        }
        Some(match mode {
            "regex" => Matcher::Regex(
                RegexBuilder::new(query)
                    // A pathological pattern must fail to compile rather than
                    // allocate its way through a 100 MB scan.
                    .size_limit(1 << 20)
                    .dfa_size_limit(1 << 20)
                    .build()
                    .ok()?,
            ),
            "fuzzy" => Matcher::Fuzzy(query.to_lowercase().chars().collect()),
            // Substring is both the documented default and the fallback for an
            // unrecognised mode: a typo in the mode string must still search.
            _ => Matcher::Substring(query.to_lowercase()),
        })
    }

    /// Regex patterns are matched as written (use `(?i)` for case folding), so
    /// only the other two modes pay for lowercasing each line.
    fn needs_lowercase(&self) -> bool {
        !matches!(self, Matcher::Regex(_))
    }

    /// Character index of the match start within `line`, or `None`. Character
    /// rather than byte index: the snippet is built from `chars()`, and a byte
    /// offset taken from a lowercased copy is not a valid index into the
    /// original.
    fn find(&self, line: &str, lowered: &str) -> Option<usize> {
        match self {
            Matcher::Substring(needle) => {
                let at = lowered.find(needle.as_str())?;
                Some(lowered[..at].chars().count())
            }
            Matcher::Regex(re) => {
                let found = re.find(line)?;
                Some(line[..found.start()].chars().count())
            }
            Matcher::Fuzzy(needle) => {
                let mut wanted = needle.iter().peekable();
                let mut first = None;
                for (idx, ch) in lowered.chars().enumerate() {
                    if wanted.peek() == Some(&&ch) {
                        first.get_or_insert(idx);
                        wanted.next();
                        if wanted.peek().is_none() {
                            return first;
                        }
                    }
                }
                None
            }
        }
    }
}

/// A window of the line around the match, with control characters removed —
/// ANSI escapes and stray tabs from a captured terminal would otherwise be
/// pasted straight into the results list.
fn snippet_for(line: &str, match_char_idx: usize) -> String {
    line.chars()
        .skip(match_char_idx.saturating_sub(SNIPPET_LEAD_CHARS))
        .filter(|c| !c.is_control())
        .take(SNIPPET_MAX_CHARS)
        .collect()
}

/// Does this jsonl line record a user turn?
fn is_user_line(line: &str) -> bool {
    // Cheap reject first: a user turn always carries the literal `"user"`, so
    // most lines never reach the parser. That is what keeps `filter: user`
    // affordable over a huge transcript.
    if !line.contains("\"user\"") {
        return false;
    }
    match serde_json::from_str::<Value>(line) {
        Ok(value) => value.get("type").and_then(Value::as_str) == Some("user"),
        // A line that will not parse (a truncated final write, a stray embedded
        // newline) still counts if it plainly declares the type.
        Err(_) => line.contains("\"type\":\"user\"") || line.contains("\"type\": \"user\""),
    }
}

/// Stream `reader` line by line, handing `visit` each line's byte offset and
/// bytes; stop early when it returns `false`.
///
/// Offsets count every byte consumed, so they stay exact even for a line whose
/// bytes were dropped: a line longer than `MAX_LINE_BYTES` is passed truncated
/// rather than buffered, which is what bounds this scan's memory regardless of
/// what the transcript contains.
fn scan_lines<R: BufRead>(mut reader: R, mut visit: impl FnMut(u64, &[u8]) -> bool) {
    let mut line = Vec::with_capacity(8 * 1024);
    let mut line_start: u64 = 0;
    let mut consumed: u64 = 0;

    loop {
        // `fill_buf` borrows the reader, so the decision is made inside the
        // block and the borrow released before `consume`.
        let (used, complete) = {
            let chunk = match reader.fill_buf() {
                Ok(chunk) => chunk,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return,
            };
            if chunk.is_empty() {
                // A final line with no trailing newline is still a line.
                if consumed > 0 {
                    visit(line_start, &line);
                }
                return;
            }
            match chunk.iter().position(|&b| b == b'\n') {
                Some(idx) => {
                    append_capped(&mut line, &chunk[..idx]);
                    (idx + 1, true)
                }
                None => {
                    let len = chunk.len();
                    append_capped(&mut line, chunk);
                    (len, false)
                }
            }
        };
        reader.consume(used);
        consumed += used as u64;
        if complete {
            if !visit(line_start, &line) {
                return;
            }
            line_start += consumed;
            consumed = 0;
            line.clear();
        }
    }
}

fn append_capped(line: &mut Vec<u8>, more: &[u8]) {
    let room = MAX_LINE_BYTES.saturating_sub(line.len());
    if room > 0 {
        line.extend_from_slice(&more[..room.min(more.len())]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // ---- windowing -------------------------------------------------------

    /// A synthetic transcript whose every line is numbered, so a walk that
    /// loses or repeats one is caught by an exact comparison. ~110 bytes/line.
    fn numbered_file(dir: &Path, count: usize, trailing_newline: bool) -> (PathBuf, Vec<String>) {
        let mut body = String::new();
        let mut expected = Vec::with_capacity(count);
        for i in 0..count {
            let line = format!(
                r#"{{"i":{i},"type":"assistant","pad":"{}"}}"#,
                "x".repeat(80)
            );
            body.push_str(&line);
            if i + 1 < count || trailing_newline {
                body.push('\n');
            }
            expected.push(line);
        }
        let path = dir.join("transcript.jsonl");
        std::fs::write(&path, &body).unwrap();
        (path, expected)
    }

    /// Page backward to the start of the file, newest page first. Returns the
    /// lines in file order plus every cursor the walk was handed.
    fn walk(path: &Path, max_bytes: u32) -> (Vec<String>, Vec<u64>) {
        let mut cursor: Option<u64> = None;
        let mut pages: Vec<Vec<String>> = Vec::new();
        let mut cursors: Vec<u64> = Vec::new();
        for _ in 0..100_000 {
            let window = read_window_at(path, cursor, max_bytes);
            pages.push(window.lines);
            let Some(next) = window.next_before_offset else {
                pages.reverse();
                return (pages.concat(), cursors);
            };
            if let Some(previous) = cursor {
                assert!(
                    next < previous,
                    "cursor must strictly decrease: {next} >= {previous}"
                );
            }
            cursors.push(next);
            cursor = Some(next);
        }
        panic!("walk did not terminate");
    }

    #[test]
    fn a_backward_walk_reconstructs_a_multi_megabyte_file_exactly() {
        let tmp = tempfile::tempdir().unwrap();
        let (path, expected) = numbered_file(tmp.path(), 20_000, true);
        assert!(
            std::fs::metadata(&path).unwrap().len() > 2 * 1024 * 1024,
            "the fixture must be genuinely multi-megabyte"
        );

        let (lines, cursors) = walk(&path, 64 * 1024);

        assert_eq!(lines.len(), expected.len(), "no lines lost or duplicated");
        assert_eq!(
            lines, expected,
            "every line must land in its original place"
        );
        assert!(
            cursors.len() > 30,
            "the fixture must take many pages: {}",
            cursors.len()
        );
    }

    #[test]
    fn a_file_without_a_trailing_newline_walks_the_same_way() {
        let tmp = tempfile::tempdir().unwrap();
        let (path, expected) = numbered_file(tmp.path(), 5_000, false);
        let (lines, _) = walk(&path, 8 * 1024);
        assert_eq!(lines, expected);
    }

    #[test]
    fn the_leading_partial_line_is_dropped_and_reported_as_the_next_cursor() {
        // The window began 5 bytes into a file, mid-line: "bb\n" is the tail of
        // a line that started earlier and must not be emitted here.
        let window = split_window(b"bb\nccc\nddd\n", 5);
        assert_eq!(window.lines, vec!["ccc", "ddd"]);
        assert_eq!(
            window.next_before_offset,
            Some(8),
            "offset of the 'ccc' line start"
        );

        // Paging to that cursor delivers the dropped tail as part of its line.
        let window = split_window(b"xx\naaabb\n", 0);
        assert_eq!(window.lines, vec!["xx", "aaabb"]);
        assert_eq!(window.next_before_offset, None);
    }

    #[test]
    fn blank_lines_survive_but_the_terminating_newline_is_not_a_line() {
        let window = split_window(b"a\n\nb\n", 0);
        assert_eq!(window.lines, vec!["a", "", "b"]);
        let window = split_window(b"a\n\nb", 0);
        assert_eq!(window.lines, vec!["a", "", "b"]);
    }

    #[test]
    fn a_window_reaching_offset_zero_ends_the_walk() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("small.jsonl");
        std::fs::write(&path, b"one\ntwo\nthree\n").unwrap();

        let window = read_window_at(&path, None, MIN_WINDOW_BYTES);
        assert_eq!(window.lines, vec!["one", "two", "three"]);
        assert_eq!(window.next_before_offset, None);

        // An exhausted cursor asks for nothing and says so.
        let window = read_window_at(&path, Some(0), MIN_WINDOW_BYTES);
        assert!(window.lines.is_empty());
        assert_eq!(window.next_before_offset, None);
    }

    #[test]
    fn missing_empty_and_directory_paths_yield_an_empty_window() {
        let tmp = tempfile::tempdir().unwrap();
        let empty = tmp.path().join("empty.jsonl");
        std::fs::write(&empty, b"").unwrap();

        for path in [
            tmp.path().join("nope.jsonl"),
            empty,
            tmp.path().to_path_buf(),
        ] {
            let window = read_window_at(&path, None, 64 * 1024);
            assert_eq!(window, TranscriptWindow::default(), "{}", path.display());
        }
    }

    #[test]
    fn max_bytes_is_clamped_to_the_documented_window_range() {
        let tmp = tempfile::tempdir().unwrap();
        let (path, expected) = numbered_file(tmp.path(), 20_000, true);
        let len = std::fs::metadata(&path).unwrap().len();

        // Below the floor: clamped up to 4 KB, so the page covers ~4 KB.
        let window = read_window_at(&path, None, 0);
        let covered = len - window.next_before_offset.unwrap();
        assert!(
            covered <= u64::from(MIN_WINDOW_BYTES) && covered > u64::from(MIN_WINDOW_BYTES) - 200,
            "expected a ~4 KB page, covered {covered}"
        );

        // Above the ceiling: clamped down to 4 MB, which swallows this file.
        let window = read_window_at(&path, None, u32::MAX);
        assert_eq!(window.lines, expected);
        assert_eq!(window.next_before_offset, None);
    }

    #[test]
    fn a_stale_cursor_past_the_end_is_clamped_to_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("small.jsonl");
        std::fs::write(&path, b"one\ntwo\n").unwrap();
        let window = read_window_at(&path, Some(9_999_999), MIN_WINDOW_BYTES);
        assert_eq!(window.lines, vec!["one", "two"]);
        assert_eq!(window.next_before_offset, None);
    }

    #[test]
    fn a_line_longer_than_the_window_is_paged_as_fragments_without_losing_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("giant.jsonl");
        let giant = "g".repeat(20 * 1024);
        std::fs::write(&path, format!("{giant}\n")).unwrap();

        let (pieces, cursors) = walk(&path, MIN_WINDOW_BYTES);
        assert!(pieces.len() > 1, "an over-long line must arrive in pieces");
        assert_eq!(pieces.concat(), giant, "no byte may be lost or duplicated");
        assert!(
            cursors.windows(2).all(|w| w[1] < w[0]),
            "cursors must decrease"
        );
    }

    // ---- search ----------------------------------------------------------

    const HAYSTACK: &str = concat!(
        r#"{"type":"user","message":{"content":"Hello WORLD from the user"}}"#,
        "\n",
        r#"{"type":"assistant","message":{"content":"hello world, replying"}}"#,
        "\n",
        r#"{"type": "user","message":{"content":"second question"}}"#,
        "\n",
        r#"{"type":"summary","summary":"World tour"}"#,
        "\n",
    );

    fn search(query: &str, mode: &str, filter: &str) -> SearchResult {
        search_reader(HAYSTACK.as_bytes(), query, mode, filter, 0)
    }

    fn snippets(result: &SearchResult) -> Vec<&str> {
        result.matches.iter().map(|m| m.snippet.as_str()).collect()
    }

    /// Every reported offset must be the first byte of a line.
    fn assert_line_starts(body: &str, result: &SearchResult) {
        for hit in &result.matches {
            let at = hit.offset as usize;
            assert!(at <= body.len(), "offset {at} past the end");
            assert!(
                at == 0 || body.as_bytes()[at - 1] == b'\n',
                "offset {at} is not a line start"
            );
        }
    }

    #[test]
    fn substring_search_is_case_insensitive_and_reports_line_start_offsets() {
        let result = search("world", "substring", "all");
        assert_eq!(result.matches.len(), 3, "WORLD, world and World all match");
        assert!(!result.truncated);
        assert_line_starts(HAYSTACK, &result);

        // The offsets are exactly the starts of lines 1, 2 and 4, in file order.
        let starts: Vec<u64> = result.matches.iter().map(|m| m.offset).collect();
        let expected: Vec<u64> = HAYSTACK
            .match_indices('\n')
            .map(|(i, _)| i as u64 + 1)
            .collect();
        assert_eq!(starts, vec![0, expected[0], expected[2]]);
    }

    #[test]
    fn a_reported_offset_loads_the_window_containing_its_line() {
        let tmp = tempfile::tempdir().unwrap();
        let (path, expected) = numbered_file(tmp.path(), 20_000, true);

        let result = search_file(&path, r#""i":19999,"#, "substring", "all", 0);
        assert_eq!(result.matches.len(), 1);
        let offset = result.matches[0].offset;

        // The window ending one line later must begin with the matched line.
        let line_len = expected[19_999].len() as u64 + 1;
        let window = read_window_at(&path, Some(offset + line_len), 64 * 1024);
        assert_eq!(window.lines.last().unwrap(), &expected[19_999]);
    }

    #[test]
    fn regex_mode_matches_patterns_and_an_invalid_one_is_an_empty_result() {
        let hits = search(r#""content":"[Hh]ello \w+"#, "regex", "all");
        assert_eq!(hits.matches.len(), 2);

        for bad in ["[unclosed", "(", "a{99999999,}", "*", r"\p{NotAClass}"] {
            let result = search(bad, "regex", "all");
            assert_eq!(
                result,
                SearchResult::default(),
                "invalid pattern {bad:?} must be empty, never a panic"
            );
        }
    }

    #[test]
    fn regex_mode_respects_case_unless_the_pattern_says_otherwise() {
        assert_eq!(search("WORLD", "regex", "all").matches.len(), 1);
        assert_eq!(search("(?i)world", "regex", "all").matches.len(), 3);
    }

    #[test]
    fn fuzzy_mode_matches_a_case_insensitive_subsequence_in_order() {
        assert_eq!(search("hlowrd", "fuzzy", "all").matches.len(), 2);
        assert!(
            search("dlrow", "fuzzy", "all").matches.is_empty(),
            "a subsequence must be in order"
        );
    }

    #[test]
    fn an_unknown_mode_falls_back_to_substring() {
        assert_eq!(
            search("world", "banana", "all").matches,
            search("world", "substring", "all").matches
        );
    }

    #[test]
    fn the_user_filter_keeps_only_user_turns() {
        let result = search("o", "substring", "user");
        assert_eq!(
            result.matches.len(),
            2,
            "both user lines, neither of the rest"
        );
        assert!(snippets(&result)[0].contains("Hello WORLD"));
        assert!(
            snippets(&result)[1].contains("second question"),
            "spaced JSON parses too"
        );

        // A line too broken to parse still counts if it declares the type.
        let broken = "{\"type\":\"user\",\"message\":{oops\n";
        let result = search_reader(broken.as_bytes(), "oops", "substring", "user", 0);
        assert_eq!(result.matches.len(), 1);

        // ...and a line merely mentioning the word does not.
        let assistant = "{\"type\":\"assistant\",\"text\":\"the \\\"user\\\" asked\"}\n";
        let result = search_reader(assistant.as_bytes(), "asked", "substring", "user", 0);
        assert!(result.matches.is_empty());
    }

    #[test]
    fn results_are_capped_and_the_truncated_flag_says_more_exist() {
        let body: String = (0..10)
            .map(|i| format!("{{\"type\":\"user\",\"i\":{i},\"text\":\"needle\"}}\n"))
            .collect();

        let capped = search_reader(body.as_bytes(), "needle", "substring", "all", 3);
        assert_eq!(capped.matches.len(), 3);
        assert!(capped.truncated);

        // Exactly as many matches as asked for is not truncation.
        let exact = search_reader(body.as_bytes(), "needle", "substring", "all", 10);
        assert_eq!(exact.matches.len(), 10);
        assert!(!exact.truncated);

        // 0 means the default (200), and an absurd request is clamped to 1000 —
        // both comfortably above this fixture.
        for asked in [0, u32::MAX] {
            let result = search_reader(body.as_bytes(), "needle", "substring", "all", asked);
            assert_eq!(result.matches.len(), 10, "max_results={asked}");
            assert!(!result.truncated);
        }
        assert_eq!(effective_max_results(0), 200);
        assert_eq!(effective_max_results(1), 1);
        assert_eq!(effective_max_results(u32::MAX), 1000);
    }

    #[test]
    fn snippets_strip_control_characters_and_stop_at_two_hundred_chars() {
        let line = format!(
            "prefix\t\u{1b}[31mneedle\u{7}{}\n",
            "y".repeat(SNIPPET_MAX_CHARS * 3)
        );
        let result = search_reader(line.as_bytes(), "needle", "substring", "all", 0);
        let snippet = &result.matches[0].snippet;

        assert_eq!(snippet.chars().count(), SNIPPET_MAX_CHARS);
        assert!(
            !snippet.chars().any(char::is_control),
            "control characters must never reach the results list: {snippet:?}"
        );
        assert!(snippet.starts_with("prefix[31mneedle"), "got {snippet:?}");
    }

    #[test]
    fn a_match_late_in_a_long_line_keeps_context_before_it() {
        let line = format!("{}needle tail\n", "z".repeat(500));
        let result = search_reader(line.as_bytes(), "needle", "substring", "all", 0);
        let snippet = &result.matches[0].snippet;
        assert_eq!(
            snippet.chars().take(SNIPPET_LEAD_CHARS).collect::<String>(),
            "z".repeat(SNIPPET_LEAD_CHARS)
        );
        assert!(snippet.contains("needle tail"));
    }

    #[test]
    fn an_empty_query_or_missing_file_finds_nothing() {
        assert_eq!(search("", "substring", "all"), SearchResult::default());
        assert_eq!(search("", "regex", "all"), SearchResult::default());
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            search_file(&tmp.path().join("nope.jsonl"), "x", "substring", "all", 0),
            SearchResult::default()
        );
        assert_eq!(
            search_file(tmp.path(), "x", "substring", "all", 0),
            SearchResult::default()
        );
    }

    #[test]
    fn a_final_line_without_a_newline_is_still_searched() {
        let result = search_reader(
            &b"{\"type\":\"user\"} needle"[..],
            "needle",
            "substring",
            "all",
            0,
        );
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].offset, 0);
    }

    #[test]
    fn line_offsets_stay_exact_across_buffer_boundaries_and_over_long_lines() {
        // A line far longer than the 8 KB scan buffer, between two short ones:
        // the offsets after it must still point at real line starts.
        let body = format!("first\n{}\nlast needle\n", "q".repeat(200_000));
        let result = search_reader(body.as_bytes(), "needle", "substring", "all", 0);
        assert_eq!(result.matches.len(), 1);
        assert_line_starts(&body, &result);
        assert_eq!(result.matches[0].offset, 6 + 200_000 + 1);
    }
}
