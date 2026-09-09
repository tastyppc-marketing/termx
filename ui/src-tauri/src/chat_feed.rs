//! Chat view feed: Claude JSONL → a normalized `ChatEntry` stream, plus the
//! tail-polling commands the renderer drives while a chat view is mounted
//! (chat-view spec §3).
//!
//! Two rules shape everything here. The chat is READ-ONLY — nothing in this
//! module ever writes a transcript — and it must never panic on input, because
//! the file it reads is being appended to by another process and every window
//! boundary produces a half-written line. Unparseable lines are skipped and
//! counted, and the count is surfaced as one trailing `System` entry per batch
//! rather than lost.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use termx_swarm_context::owner::{
    OwnerBodyKind, OwnerBodyOrigin, OwnerLineDisposition, OwnerParser, OwnerRecord,
};
use termx_swarm_context::Provider;

/// Initial window: the last 256 KiB of the transcript (spec §3).
pub const WINDOW_BYTES: u64 = 256 * 1024;

/// Bytes one poll may consume. A transcript can gain megabytes between two
/// ticks (a big tool result); the rest simply arrives on the next tick, which
/// keeps a poll's cost bounded instead of letting one call read the world.
pub const POLL_MAX_BYTES: u64 = 1024 * 1024;

/// A tool's expandable body is for reading, not for shipping a whole file to
/// the renderer.
const DETAIL_MAX_CHARS: usize = 20_000;

/// System notices (compaction recaps) are shown as a chip, not a document.
const SYSTEM_MAX_CHARS: usize = 2_000;

/// Chip lines are one row: an action and a short right-hand detail.
const TITLE_MAX_CHARS: usize = 120;
const SUMMARY_MAX_CHARS: usize = 80;

/// How many un-echoed queued prompts to remember. Claude Code writes a typed
/// message as a `queue-operation` AND (sometimes) as a `user` line; the buffer
/// is what lets the second one be recognized as the echo of the first.
const PENDING_USER_CAP: usize = 32;

/// How many unanswered tool calls to remember across polls, so a `tool_result`
/// that lands in a later batch than its `tool_use` still knows its own name.
const OPEN_TOOLS_CAP: usize = 512;

/// Where a tool call stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Running,
    Ok,
    Error,
}

/// One rendered row of the chat. The wire shape the renderer's `types.ts`
/// mirrors: a `kind` discriminator plus that kind's fields.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatEntry {
    User {
        id: String,
        ts: i64,
        text: String,
    },
    Assistant {
        id: String,
        ts: i64,
        markdown: String,
    },
    Thinking {
        id: String,
        ts: i64,
        text: String,
    },
    Tool {
        id: String,
        ts: i64,
        name: String,
        title: String,
        summary: String,
        status: ToolStatus,
        detail: String,
    },
    System {
        id: String,
        ts: i64,
        text: String,
    },
}

/// A tool call waiting for its result.
#[derive(Debug, Clone)]
struct OpenTool {
    name: String,
    title: String,
    summary: String,
    ts: i64,
}

/// Incremental Claude-JSONL → `ChatEntry` conversion.
///
/// Stateful on purpose: a feed reads a transcript in batches, and both of the
/// format's cross-line relationships — a queued prompt echoed as a later
/// `user` line, and a `tool_use` answered by a later `tool_result` — routinely
/// straddle a batch boundary. Structural JSON parsing is delegated to the
/// identity-free owner parser; queue/tool maps, IDs, timestamps, and
/// presentation stay here.
#[derive(Debug)]
pub struct ChatNormalizer {
    seq: u64,
    pending_user: VecDeque<String>,
    open_tools: HashMap<String, OpenTool>,
    open_order: VecDeque<String>,
    parser: OwnerParser,
}

impl Default for ChatNormalizer {
    fn default() -> Self {
        Self {
            seq: 0,
            pending_user: VecDeque::new(),
            open_tools: HashMap::new(),
            open_order: VecDeque::new(),
            parser: OwnerParser::strict(Provider::Claude),
        }
    }
}

impl ChatNormalizer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Synthesized id for a record that carries no uuid of its own.
    fn next_id(&mut self) -> String {
        self.seq += 1;
        format!("g{}", self.seq)
    }

    fn remember_pending(&mut self, text: &str) {
        if self.pending_user.len() >= PENDING_USER_CAP {
            self.pending_user.pop_front();
        }
        self.pending_user.push_back(text.to_string());
    }

    /// True when this text is the echo of a prompt already shown from the
    /// queue, which is what stops the same message rendering twice.
    fn claim_pending(&mut self, text: &str) -> bool {
        if let Some(index) = self.pending_user.iter().position(|t| t == text) {
            self.pending_user.remove(index);
            return true;
        }
        false
    }

    fn remember_tool(&mut self, id: &str, tool: OpenTool) {
        if self.open_tools.len() >= OPEN_TOOLS_CAP {
            if let Some(oldest) = self.open_order.pop_front() {
                self.open_tools.remove(&oldest);
            }
        }
        self.open_order.push_back(id.to_string());
        self.open_tools.insert(id.to_string(), tool);
    }

    fn take_tool(&mut self, id: &str) -> Option<OpenTool> {
        if let Some(index) = self.open_order.iter().position(|t| t == id) {
            self.open_order.remove(index);
        }
        self.open_tools.remove(id)
    }

    /// Convert one batch of complete lines.
    pub fn push_lines(&mut self, lines: &[&str]) -> Vec<ChatEntry> {
        let mut out: Vec<ChatEntry> = Vec::new();
        // Where in `out` a tool call opened in THIS batch sits, so its result
        // patches the same row instead of appending a second one.
        let mut batch_tools: HashMap<String, usize> = HashMap::new();
        let mut unreadable = 0usize;

        for line in lines {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let outcome = self.parser.project_line(line);
            self.consume_outcome(outcome, &mut out, &mut batch_tools, &mut unreadable);
        }

        if unreadable > 0 {
            let id = self.next_id();
            out.push(ChatEntry::System {
                id,
                ts: 0,
                text: unreadable_notice(unreadable),
            });
        }
        out
    }

    fn consume_outcome(
        &mut self,
        outcome: termx_swarm_context::owner::OwnerLineOutcome,
        out: &mut Vec<ChatEntry>,
        batch_tools: &mut HashMap<String, usize>,
        unreadable: &mut usize,
    ) {
        if matches!(outcome.disposition, OwnerLineDisposition::KnownIgnored(_)) {
            return;
        }

        let ts = parse_timestamp(outcome.source.timestamp.as_deref());
        let uuid = outcome.source.native_record_id.clone();
        match outcome.source.native_kind.as_deref() {
            Some("queue-operation") => {
                for block in &outcome.records {
                    if let OwnerRecord::QueuedUser { text } = &block.record {
                        let trimmed = text.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        self.remember_pending(trimmed);
                        let id = self.next_id();
                        out.push(ChatEntry::User {
                            id,
                            ts,
                            text: trimmed.to_string(),
                        });
                    }
                }
            }
            Some("user") => {
                if outcome.source.body_origin != Some(OwnerBodyOrigin::NestedContent) {
                    *unreadable += 1;
                    return;
                }
                match outcome.source.body_kind {
                    Some(OwnerBodyKind::String) => {
                        // A native string body is usable even when trimming leaves
                        // nothing to render.
                        for block in &outcome.records {
                            match &block.record {
                                OwnerRecord::UserText { text } => {
                                    self.emit_user_text(text, ts, uuid.clone(), false, out);
                                }
                                OwnerRecord::Compaction { text, recap: true } => {
                                    self.emit_user_text(text, ts, uuid.clone(), true, out);
                                }
                                _ => {}
                            }
                        }
                    }
                    Some(OwnerBodyKind::Array) => {
                        // Legacy chat counts a native text block with a string
                        // field as used even when the string is empty.
                        let mut used = outcome.present_text_string_blocks > 0;
                        for block in &outcome.records {
                            match (block.native_kind.as_deref(), &block.record) {
                                (Some("text"), OwnerRecord::UserText { text }) => {
                                    self.emit_user_text(text, ts, uuid.clone(), false, out);
                                }
                                (Some("text"), OwnerRecord::Compaction { text, recap: true }) => {
                                    self.emit_user_text(text, ts, uuid.clone(), true, out);
                                }
                                (Some("tool_result"), record @ OwnerRecord::ToolResult { .. }) => {
                                    used |=
                                        self.apply_owner_tool_result(record, ts, out, batch_tools);
                                }
                                _ => {}
                            }
                        }
                        if !used {
                            *unreadable += 1;
                        }
                    }
                    _ => *unreadable += 1,
                }
            }
            Some("assistant") => {
                if outcome.source.body_origin != Some(OwnerBodyOrigin::NestedContent)
                    || outcome.source.body_kind != Some(OwnerBodyKind::Array)
                {
                    return;
                }
                for block in &outcome.records {
                    match (block.native_kind.as_deref(), &block.record) {
                        (Some("text"), OwnerRecord::AssistantText { text }) => {
                            if text.trim().is_empty() {
                                continue;
                            }
                            let id = block_id(&uuid, block.index.unwrap_or(0), || self.next_id());
                            out.push(ChatEntry::Assistant {
                                id,
                                ts,
                                markdown: text.to_string(),
                            });
                        }
                        (Some("thinking"), OwnerRecord::Thinking { text }) => {
                            if text.trim().is_empty() {
                                continue;
                            }
                            let id = block_id(&uuid, block.index.unwrap_or(0), || self.next_id());
                            out.push(ChatEntry::Thinking {
                                id,
                                ts,
                                text: text.to_string(),
                            });
                        }
                        (
                            Some("tool_use"),
                            OwnerRecord::ToolCall {
                                native_id,
                                native_name,
                                native_input_json,
                                ..
                            },
                        ) => {
                            let name = native_name.as_deref().unwrap_or("tool").to_string();
                            let id = native_id.clone().unwrap_or_else(|| {
                                block_id(&uuid, block.index.unwrap_or(0), || self.next_id())
                            });
                            let input = native_input_json.as_ref().unwrap_or(&Value::Null);
                            let (title, summary) = tool_chip(&name, input);
                            self.remember_tool(
                                &id,
                                OpenTool {
                                    name: name.clone(),
                                    title: title.clone(),
                                    summary: summary.clone(),
                                    ts,
                                },
                            );
                            batch_tools.insert(id.clone(), out.len());
                            out.push(ChatEntry::Tool {
                                id,
                                ts,
                                name,
                                title,
                                summary,
                                status: ToolStatus::Running,
                                detail: String::new(),
                            });
                        }
                        _ => {}
                    }
                }
            }
            Some("system") | Some("summary") => {
                for block in &outcome.records {
                    let text = match &block.record {
                        OwnerRecord::SystemNotice { text } => {
                            text.as_deref().unwrap_or("System notice")
                        }
                        OwnerRecord::Compaction { text, .. } => text.as_str(),
                        _ => continue,
                    };
                    let id = uuid.clone().unwrap_or_else(|| self.next_id());
                    out.push(ChatEntry::System {
                        id,
                        ts,
                        text: cap_chars(text, SYSTEM_MAX_CHARS),
                    });
                }
            }
            _ if matches!(outcome.disposition, OwnerLineDisposition::Unreadable(_)) => {
                *unreadable += 1
            }
            _ => {}
        }
    }

    fn emit_user_text(
        &mut self,
        text: &str,
        ts: i64,
        uuid: Option<String>,
        is_recap: bool,
        out: &mut Vec<ChatEntry>,
    ) {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return;
        }
        if is_recap {
            let id = uuid.unwrap_or_else(|| self.next_id());
            out.push(ChatEntry::System {
                id,
                ts,
                text: cap_chars(trimmed, SYSTEM_MAX_CHARS),
            });
            return;
        }
        if self.claim_pending(trimmed) {
            return; // already shown when it was queued
        }
        let id = uuid.unwrap_or_else(|| self.next_id());
        out.push(ChatEntry::User {
            id,
            ts,
            text: trimmed.to_string(),
        });
    }

    /// Close out a tool call. Returns false for a result whose call is unknown
    /// — that is a hole in the window, and the caller counts it.
    fn apply_owner_tool_result(
        &mut self,
        record: &OwnerRecord,
        ts: i64,
        out: &mut Vec<ChatEntry>,
        batch_tools: &mut HashMap<String, usize>,
    ) -> bool {
        let OwnerRecord::ToolResult {
            content_json,
            raw_result_json,
            native_tool_use_id,
            native_is_error,
            ..
        } = record
        else {
            return false;
        };
        let tool_id = native_tool_use_id.as_deref();
        let raw_result = raw_result_json.as_deref();
        let Some(tool_id) = tool_id else {
            return false;
        };
        let status = if *native_is_error == Some(true)
            || raw_result
                .and_then(Value::as_str)
                .is_some_and(|s| s.starts_with("Error:"))
        {
            ToolStatus::Error
        } else {
            ToolStatus::Ok
        };
        let detail = cap_chars(
            &result_detail(content_json.as_ref(), raw_result),
            DETAIL_MAX_CHARS,
        );

        if let Some(index) = batch_tools.remove(tool_id) {
            self.take_tool(tool_id);
            if let Some(ChatEntry::Tool {
                name,
                summary,
                status: slot_status,
                detail: slot_detail,
                ..
            }) = out.get_mut(index)
            {
                if summary.is_empty() {
                    *summary = result_summary(name, raw_result, &detail);
                }
                *slot_status = status;
                *slot_detail = detail;
            }
            return true;
        }

        // The call opened in an earlier batch: re-emit the row whole, keyed by
        // the same id, so the renderer replaces its running predecessor.
        let Some(open) = self.take_tool(tool_id) else {
            return false;
        };
        let summary = if open.summary.is_empty() {
            result_summary(&open.name, raw_result, &detail)
        } else {
            open.summary
        };
        out.push(ChatEntry::Tool {
            id: tool_id.to_string(),
            ts: if ts == 0 { open.ts } else { ts },
            name: open.name,
            title: open.title,
            summary,
            status,
            detail,
        });
        true
    }
}

/// One batch, no carried state — the pure entry point fixtures drive. A feed
/// uses `ChatNormalizer` directly, because it reads a file in pieces and the
/// format's relationships straddle them; nothing in production wants the
/// stateless form.
#[cfg_attr(not(test), allow(dead_code))]
pub fn normalize_claude_lines(lines: &[&str]) -> Vec<ChatEntry> {
    ChatNormalizer::new().push_lines(lines)
}

fn unreadable_notice(count: usize) -> String {
    if count == 1 {
        "1 entry unreadable".to_string()
    } else {
        format!("{count} entries unreadable")
    }
}

/// A block's id: the record's uuid plus the block's position, so two blocks of
/// one assistant message never share an identity.
fn block_id(uuid: &Option<String>, index: usize, fallback: impl FnOnce() -> String) -> String {
    match uuid {
        Some(uuid) => format!("{uuid}#{index}"),
        None => fallback(),
    }
}

/// Readable body of a tool result: the block's own content when it is text,
/// otherwise whatever the harness recorded alongside it.
fn result_detail(content: Option<&Value>, raw_result: Option<&Value>) -> String {
    if let Some(content) = content {
        let text = value_text(content);
        if !text.trim().is_empty() {
            return text;
        }
    }
    match raw_result {
        Some(Value::String(text)) => text.clone(),
        Some(other) => value_text(other),
        None => String::new(),
    }
}

/// Flatten a JSON value into something a `<pre>` can show.
fn value_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item.get("text").and_then(Value::as_str) {
                Some(text) => text.to_string(),
                None => value_text(item),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// The chip's right-hand detail once the result is in: edit sizes for the file
/// tools, the first line of output for a command, nothing for the rest (a file
/// read's "summary" would just be the file again).
fn result_summary(name: &str, raw_result: Option<&Value>, detail: &str) -> String {
    if let Some(patch) = raw_result.and_then(|r| r.get("structuredPatch")) {
        if let Some(counts) = patch_counts(patch) {
            return counts;
        }
    }
    if name == "Bash" {
        if let Some(first) = detail.lines().find(|line| !line.trim().is_empty()) {
            return cap_chars(first.trim(), SUMMARY_MAX_CHARS);
        }
    }
    String::new()
}

/// `"+12 −3"` from a structured patch, or None when there is no patch to read.
fn patch_counts(patch: &Value) -> Option<String> {
    let hunks = patch.as_array()?;
    let mut added = 0usize;
    let mut removed = 0usize;
    for hunk in hunks {
        let Some(lines) = hunk.get("lines").and_then(Value::as_array) else {
            continue;
        };
        for line in lines {
            match line.as_str().and_then(|l| l.chars().next()) {
                Some('+') => added += 1,
                Some('-') => removed += 1,
                _ => {}
            }
        }
    }
    if added == 0 && removed == 0 {
        return None;
    }
    Some(format!("+{added} −{removed}"))
}

/// The chip line for a call: what it did, and a short detail when the call
/// itself already says one.
fn tool_chip(name: &str, input: &Value) -> (String, String) {
    let arg = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("");
    let title = match name {
        "Edit" | "NotebookEdit" => format!("Edited {}", basename(arg("file_path"))),
        "Write" => format!("Wrote {}", basename(arg("file_path"))),
        "Read" => format!("Read {}", basename(arg("file_path"))),
        "Bash" => first_line(arg("command")),
        "Grep" => format!("Searched {}", arg("pattern")),
        "Glob" => format!("Globbed {}", arg("pattern")),
        "Task" => format!("Agent: {}", arg("description")),
        "TodoWrite" => "Updated todos".to_string(),
        "WebFetch" => format!("Fetched {}", arg("url")),
        "WebSearch" => format!("Searched the web for {}", arg("query")),
        other => match first_string_arg(input) {
            Some(value) => format!("{other} {}", first_line(&value)),
            None => other.to_string(),
        },
    };
    let summary = match name {
        "Bash" => arg("description").to_string(),
        "Grep" | "Glob" => basename(arg("path")),
        _ => String::new(),
    };
    (
        cap_chars(title.trim(), TITLE_MAX_CHARS),
        cap_chars(summary.trim(), SUMMARY_MAX_CHARS),
    )
}

fn first_string_arg(input: &Value) -> Option<String> {
    input
        .as_object()?
        .values()
        .find_map(|value| value.as_str().map(str::to_string))
}

fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or("").trim().to_string()
}

/// Last path component of a Windows or POSIX path; the whole string when it
/// has no separator (so a bare name, or an empty argument, survives as-is).
fn basename(path: &str) -> String {
    path.rsplit(['\\', '/'])
        .find(|part| !part.is_empty())
        .unwrap_or(path)
        .to_string()
}

/// Truncate by characters, never by bytes: a chip must not cut a glyph in two.
fn cap_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

/// `2026-07-23T09:03:08.502Z` → epoch millis. Zero when the stamp is missing
/// or unreadable, which sorts such an entry to the start of the day rather
/// than dropping it. A non-UTC offset is read as UTC: the renderer shows
/// relative times, and no Claude build writes one.
fn parse_timestamp(text: Option<&str>) -> i64 {
    let Some(text) = text else {
        return 0;
    };
    let bytes = text.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return 0;
    }
    let num = |range: std::ops::Range<usize>| text.get(range).and_then(|s| s.parse::<i64>().ok());
    let (Some(year), Some(month), Some(day)) = (num(0..4), num(5..7), num(8..10)) else {
        return 0;
    };
    let (Some(hour), Some(minute), Some(second)) = (num(11..13), num(14..16), num(17..19)) else {
        return 0;
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return 0;
    }
    let millis = text
        .get(19..20)
        .filter(|dot| *dot == ".")
        .and_then(|_| text.get(20..23))
        .and_then(|frac| frac.parse::<i64>().ok())
        .unwrap_or(0);
    let days = days_from_civil(year, month, day);
    ((days * 24 + hour) * 60 + minute) * 60_000 + second * 1_000 + millis
}

/// Days since 1970-01-01 for a proleptic-Gregorian date (Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

// ---------------------------------------------------------------------------
// Feed state + commands
// ---------------------------------------------------------------------------

/// One window of the feed, in the shape the renderer consumes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedWindow {
    pub feed_id: u64,
    pub entries: Vec<ChatEntry>,
    pub offset: u64,
    /// The file was replaced or truncated (a compaction rewrite); the renderer
    /// must drop what it has and start from these entries.
    pub reset: bool,
}

/// An open tail on one transcript.
struct Feed {
    path: PathBuf,
    /// First byte not yet consumed.
    offset: u64,
    /// Bytes of a line the file has not finished writing. Held as bytes, not
    /// text: a poll boundary can fall inside a multi-byte character.
    partial: Vec<u8>,
    normalizer: ChatNormalizer,
}

static FEEDS: Mutex<Option<HashMap<u64, Feed>>> = Mutex::new(None);
static NEXT_FEED_ID: AtomicU64 = AtomicU64::new(1);

fn with_feeds<T>(action: impl FnOnce(&mut HashMap<u64, Feed>) -> T) -> T {
    let mut guard = FEEDS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    action(guard.get_or_insert_with(HashMap::new))
}

/// Only a transcript inside a provider's own store may be tailed. Without this
/// the command surface would be an arbitrary-file reader for anything that can
/// reach the renderer. Roots are passed in so tests can point them at a
/// tempdir; production always passes the signed-in user's.
fn allowed(roots: Option<&crate::llm_sessions::Roots>, path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    roots.is_some_and(|roots| crate::llm_sessions::note_target_allowed(roots, path))
}

/// Offset just past the transcript's last newline: the point up to which the
/// file consists of whole lines.
///
/// `None` when the tail window holds no newline at all — a single line longer
/// than the window. Callers treat that as "already caught up", which skips
/// that one pathological line rather than re-reading a 100 MB file to find its
/// start.
fn last_line_boundary(path: &Path, len: u64) -> Option<u64> {
    use std::io::{Read, Seek, SeekFrom};

    if len == 0 {
        return Some(0);
    }
    let start = len.saturating_sub(WINDOW_BYTES);
    let mut file = std::fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut chunk = Vec::new();
    file.take(len - start).read_to_end(&mut chunk).ok()?;
    let index = chunk.iter().rposition(|byte| *byte == b'\n')?;
    Some(start + index as u64 + 1)
}

/// Read `[from, from + max)`, returning the bytes actually read.
fn read_range(path: &Path, from: u64, max: u64) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(from)).ok()?;
    let mut chunk = Vec::new();
    file.take(max).read_to_end(&mut chunk).ok()?;
    Some(chunk)
}

/// Build the initial window: the last whole lines of the file, up to 256 KiB.
fn open_window(path: &Path, normalizer: &mut ChatNormalizer) -> Option<(Vec<ChatEntry>, u64)> {
    let len = std::fs::metadata(path).ok()?.len();
    let boundary = last_line_boundary(path, len).unwrap_or(len);
    let window = crate::transcript::read_window_at(
        path,
        Some(boundary),
        u32::try_from(WINDOW_BYTES).unwrap_or(u32::MAX),
    );
    let lines: Vec<&str> = window.lines.iter().map(String::as_str).collect();
    Some((normalizer.push_lines(&lines), boundary))
}

/// Command body for `chat_feed_open`, against a real path.
pub fn open_feed(
    roots: Option<&crate::llm_sessions::Roots>,
    path: &Path,
) -> Result<FeedWindow, String> {
    if !allowed(roots, path) {
        return Err("That transcript is outside the session folders.".to_string());
    }
    let mut normalizer = ChatNormalizer::new();
    let (entries, offset) = open_window(path, &mut normalizer)
        .ok_or_else(|| "The transcript could not be read.".to_string())?;
    let feed_id = NEXT_FEED_ID.fetch_add(1, Ordering::Relaxed);
    with_feeds(|feeds| {
        feeds.insert(
            feed_id,
            Feed {
                path: path.to_path_buf(),
                offset,
                partial: Vec::new(),
                normalizer,
            },
        );
    });
    Ok(FeedWindow {
        feed_id,
        entries,
        offset,
        reset: true,
    })
}

/// Command body for `chat_feed_poll`.
pub fn poll_feed(feed_id: u64) -> Result<FeedWindow, String> {
    with_feeds(|feeds| {
        let Some(feed) = feeds.get_mut(&feed_id) else {
            return Err("That chat feed is closed.".to_string());
        };
        let len = std::fs::metadata(&feed.path)
            .map_err(|_| "The transcript could not be read.".to_string())?
            .len();

        // Shrunk below where we were reading: the file was rewritten (a
        // compaction) and every offset we hold is meaningless.
        if len < feed.offset {
            let mut normalizer = ChatNormalizer::new();
            let path = feed.path.clone();
            let (entries, offset) = open_window(&path, &mut normalizer)
                .ok_or_else(|| "The transcript could not be read.".to_string())?;
            feed.normalizer = normalizer;
            feed.partial.clear();
            feed.offset = offset;
            return Ok(FeedWindow {
                feed_id,
                entries,
                offset,
                reset: true,
            });
        }

        if len == feed.offset {
            return Ok(FeedWindow {
                feed_id,
                entries: Vec::new(),
                offset: feed.offset,
                reset: false,
            });
        }

        let chunk = read_range(&feed.path, feed.offset, POLL_MAX_BYTES)
            .ok_or_else(|| "The transcript could not be read.".to_string())?;
        feed.offset += chunk.len() as u64;

        let mut buffer = std::mem::take(&mut feed.partial);
        buffer.extend_from_slice(&chunk);
        let complete_to = match buffer.iter().rposition(|byte| *byte == b'\n') {
            Some(index) => index + 1,
            None => {
                // Still one unfinished line; nothing to render yet.
                feed.partial = buffer;
                return Ok(FeedWindow {
                    feed_id,
                    entries: Vec::new(),
                    offset: feed.offset,
                    reset: false,
                });
            }
        };
        feed.partial = buffer[complete_to..].to_vec();
        let text = String::from_utf8_lossy(&buffer[..complete_to]).into_owned();
        let lines: Vec<&str> = text.lines().collect();
        let entries = feed.normalizer.push_lines(&lines);
        Ok(FeedWindow {
            feed_id,
            entries,
            offset: feed.offset,
            reset: false,
        })
    })
}

/// Command body for `chat_feed_close`.
pub fn close_feed(feed_id: u64) {
    with_feeds(|feeds| {
        feeds.remove(&feed_id);
    });
}

/// Tauri command: open a tail on one transcript and return its last window.
#[tauri::command]
pub async fn chat_feed_open(path: String) -> Result<FeedWindow, String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_feed(
            crate::llm_sessions::default_roots().as_ref(),
            Path::new(&path),
        )
    })
    .await
    .unwrap_or_else(|_| Err("The transcript could not be read.".to_string()))
}

/// Tauri command: whatever has been appended since the last call.
#[tauri::command]
pub async fn chat_feed_poll(feed_id: u64) -> Result<FeedWindow, String> {
    tauri::async_runtime::spawn_blocking(move || poll_feed(feed_id))
        .await
        .unwrap_or_else(|_| Err("The transcript could not be read.".to_string()))
}

/// Tauri command: drop a feed's state. Idempotent — closing twice is normal
/// when a pane unmounts while a poll is in flight.
#[tauri::command]
pub fn chat_feed_close(feed_id: u64) {
    close_feed(feed_id);
}

#[cfg(test)]
#[path = "legacy_chat_oracle.rs"]
mod legacy_chat_oracle;

#[cfg(test)]
#[path = "chat_owner_parity.rs"]
mod chat_owner_parity;

#[cfg(test)]
mod tests {
    use super::*;

    /// Real excerpts from a live Claude Code transcript
    /// (`~/.claude/projects/C--Dev-TermX/74d3b4a9-…jsonl`, lines 0–876), with
    /// long string bodies trimmed. Structure is untouched.
    const SESSION: &str = include_str!("../tests/fixtures/chat/claude_session.jsonl");
    /// Hand-built companions in the same shape: a future record type, a line
    /// clipped by a window boundary, a blank line, an orphaned tool result.
    const EDGES: &str = include_str!("../tests/fixtures/chat/edge_cases.jsonl");

    fn normalize(text: &str) -> Vec<ChatEntry> {
        let lines: Vec<&str> = text.lines().collect();
        normalize_claude_lines(&lines)
    }

    fn entry_id(entry: &ChatEntry) -> &str {
        match entry {
            ChatEntry::User { id, .. }
            | ChatEntry::Assistant { id, .. }
            | ChatEntry::Thinking { id, .. }
            | ChatEntry::Tool { id, .. }
            | ChatEntry::System { id, .. } => id,
        }
    }

    fn kinds(entries: &[ChatEntry]) -> Vec<&'static str> {
        entries
            .iter()
            .map(|entry| match entry {
                ChatEntry::User { .. } => "user",
                ChatEntry::Assistant { .. } => "assistant",
                ChatEntry::Thinking { .. } => "thinking",
                ChatEntry::Tool { .. } => "tool",
                ChatEntry::System { .. } => "system",
            })
            .collect()
    }

    fn tool<'a>(entries: &'a [ChatEntry], title_prefix: &str) -> &'a ChatEntry {
        entries
            .iter()
            .find(|entry| {
                matches!(entry, ChatEntry::Tool { title, .. } if title.starts_with(title_prefix))
            })
            .unwrap_or_else(|| panic!("no tool chip titled {title_prefix:?}"))
    }

    #[test]
    fn the_real_session_normalizes_to_the_expected_stream() {
        let entries = normalize(SESSION);
        assert_eq!(
            kinds(&entries),
            [
                "user", // the queued prompt
                "thinking",
                "assistant", // opening turn
                "tool",      // Edit + its result
                "tool",      // Grep + its result
                "thinking",
                "assistant",
                "tool",   // Bash that failed
                "system", // compact boundary
                "system", // the compaction recap turn
                "user",   // a queued message with no echoed user line
                "tool",   // Read + its result
            ],
            "{:#?}",
            kinds(&entries)
        );
    }

    #[test]
    fn a_queued_prompt_and_its_echoed_user_line_render_once() {
        let entries = normalize(SESSION);
        let prompts: Vec<&str> = entries
            .iter()
            .filter_map(|entry| match entry {
                ChatEntry::User { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(prompts.len(), 2, "{prompts:#?}");
        assert!(prompts[0].starts_with("# T5"), "{:?}", prompts[0]);
        assert!(
            prompts[1].starts_with("<task-notification>"),
            "{:?}",
            prompts[1]
        );
    }

    #[test]
    fn a_tool_use_and_its_result_are_one_entry_carrying_the_calls_identity() {
        let entries = normalize(SESSION);
        let ChatEntry::Tool {
            id,
            name,
            title,
            summary,
            status,
            detail,
            ts,
        } = tool(&entries, "Edited")
        else {
            unreachable!()
        };
        assert_eq!(id, "call_N36vynMuWhMm06MsT6yf76Yq");
        assert_eq!(name, "Edit");
        assert_eq!(title, "Edited 2026-07-23-termx-t5-sidebar.md");
        assert_eq!(summary, "+1 −1", "counted from the structured patch");
        assert_eq!(*status, ToolStatus::Ok);
        assert!(detail.contains("has been updated successfully"), "{detail}");
        assert!(*ts > 0, "the result's timestamp is carried");
    }

    #[test]
    fn a_failed_tool_result_marks_the_chip_as_an_error() {
        let entries = normalize(SESSION);
        let ChatEntry::Tool {
            name,
            title,
            summary,
            status,
            detail,
            ..
        } = tool(&entries, "npx --prefix ui vitest")
        else {
            unreachable!()
        };
        assert_eq!(name, "Bash");
        assert_eq!(
            title,
            "npx --prefix ui vitest run src/workspace/__tests__/AttachmentHub.test.ts"
        );
        assert_eq!(
            summary,
            "Confirm AttachmentHub tests fail before implementation"
        );
        assert_eq!(*status, ToolStatus::Error);
        assert!(detail.contains("Exit code 1"), "{detail}");
    }

    #[test]
    fn thinking_blocks_and_assistant_markdown_keep_their_own_identities() {
        let entries = normalize(SESSION);
        let thinking: Vec<&str> = entries
            .iter()
            .filter_map(|entry| match entry {
                ChatEntry::Thinking { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(thinking[0], "**Planning initial skill pickup**");

        let markdown: Vec<&str> = entries
            .iter()
            .filter_map(|entry| match entry {
                ChatEntry::Assistant { markdown, .. } => Some(markdown.as_str()),
                _ => None,
            })
            .collect();
        assert!(markdown[0].contains("**EA-pickup**"), "{:?}", markdown[0]);

        let ids: Vec<&str> = entries.iter().map(entry_id).collect();
        let mut unique = ids.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(ids.len(), unique.len(), "ids collide: {ids:#?}");
    }

    #[test]
    fn a_compaction_boundary_and_its_recap_become_system_entries() {
        let entries = normalize(SESSION);
        let system: Vec<&str> = entries
            .iter()
            .filter_map(|entry| match entry {
                ChatEntry::System { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(system[0], "Conversation compacted");
        assert!(
            system[1].starts_with("This session is being continued"),
            "{:?}",
            system[1]
        );
    }

    #[test]
    fn unreadable_lines_are_counted_once_per_batch_and_never_stop_the_rest() {
        let entries = normalize(EDGES);
        // Unknown record type, clipped line, orphaned tool result = 3.
        assert_eq!(
            entries,
            vec![ChatEntry::System {
                id: "g1".to_string(),
                ts: 0,
                text: "3 entries unreadable".to_string(),
            }]
        );

        let single = normalize_claude_lines(&["not json at all"]);
        assert_eq!(
            single,
            vec![ChatEntry::System {
                id: "g1".to_string(),
                ts: 0,
                text: "1 entry unreadable".to_string(),
            }]
        );

        // A bad line in the middle must not swallow the good ones around it.
        let mixed: Vec<&str> = SESSION.lines().chain(["{ broken"]).collect();
        let with_junk = normalize_claude_lines(&mixed);
        assert_eq!(with_junk.len(), normalize(SESSION).len() + 1);
    }

    #[test]
    fn a_result_whose_call_arrived_in_an_earlier_batch_re_emits_the_whole_chip() {
        let lines: Vec<&str> = SESSION.lines().collect();
        let call = lines
            .iter()
            .position(|line| {
                line.contains("call_N36vynMuWhMm06MsT6yf76Yq") && line.contains("tool_use")
            })
            .expect("the Edit call");
        let result = lines
            .iter()
            .position(|line| {
                line.contains("call_N36vynMuWhMm06MsT6yf76Yq") && line.contains("tool_result")
            })
            .expect("the Edit result");

        let mut normalizer = ChatNormalizer::new();
        let first = normalizer.push_lines(&lines[call..=call]);
        assert!(
            matches!(&first[0], ChatEntry::Tool { status, .. } if *status == ToolStatus::Running),
            "{first:#?}"
        );

        let second = normalizer.push_lines(&lines[result..=result]);
        let [ChatEntry::Tool {
            id,
            name,
            title,
            summary,
            status,
            ..
        }] = &second[..]
        else {
            panic!("expected exactly one replacement chip: {second:#?}");
        };
        assert_eq!(
            id,
            entry_id(&first[0]),
            "same identity, so the row is replaced"
        );
        assert_eq!(name, "Edit");
        assert_eq!(title, "Edited 2026-07-23-termx-t5-sidebar.md");
        assert_eq!(summary, "+1 −1");
        assert_eq!(*status, ToolStatus::Ok);
    }

    #[test]
    fn a_queued_prompt_echoed_in_a_later_batch_still_renders_once() {
        let lines: Vec<&str> = SESSION.lines().collect();
        let mut normalizer = ChatNormalizer::new();
        let queued = normalizer.push_lines(&lines[0..1]);
        assert!(matches!(&queued[0], ChatEntry::User { .. }), "{queued:#?}");
        let echoed = normalizer.push_lines(&lines[3..4]);
        assert!(echoed.is_empty(), "{echoed:#?}");
    }

    #[test]
    fn chip_lines_are_composed_per_tool() {
        let chip = |name: &str, input: serde_json::Value| tool_chip(name, &input);
        assert_eq!(
            chip(
                "Write",
                serde_json::json!({ "file_path": "C:\\Dev\\a\\App.tsx" })
            ),
            ("Wrote App.tsx".to_string(), String::new())
        );
        assert_eq!(
            chip(
                "Read",
                serde_json::json!({ "file_path": "/home/me/notes.md" })
            ),
            ("Read notes.md".to_string(), String::new())
        );
        assert_eq!(
            chip(
                "Bash",
                serde_json::json!({ "command": "cargo test\n--quiet", "description": "Run tests" })
            ),
            ("cargo test".to_string(), "Run tests".to_string())
        );
        assert_eq!(
            chip("Glob", serde_json::json!({ "pattern": "**/*.rs" })),
            ("Globbed **/*.rs".to_string(), String::new())
        );
        assert_eq!(
            chip("Mystery", serde_json::json!({ "target": "the moon" })),
            ("Mystery the moon".to_string(), String::new())
        );
        assert_eq!(
            chip("Mystery", serde_json::json!({})),
            ("Mystery".to_string(), String::new())
        );
    }

    #[test]
    fn timestamps_parse_to_epoch_millis_and_degrade_to_zero() {
        assert_eq!(parse_timestamp(Some("1970-01-01T00:00:00.000Z")), 0);
        assert_eq!(parse_timestamp(Some("1970-01-01T00:00:01.500Z")), 1_500);
        // Cross-checked against an independent epoch conversion of
        // 2026-07-23T09:03:08.502Z.
        assert_eq!(
            parse_timestamp(Some("2026-07-23T09:03:08.502Z")),
            1_784_797_388_502
        );
        assert_eq!(
            parse_timestamp(Some("2026-07-23T09:03:08Z")),
            1_784_797_388_000
        );
        for junk in ["", "yesterday", "2026-07-23", "20260723T090308Z"] {
            assert_eq!(parse_timestamp(Some(junk)), 0, "{junk:?}");
        }
        assert_eq!(parse_timestamp(None), 0);
    }

    #[test]
    fn long_bodies_are_capped_without_splitting_a_glyph() {
        assert_eq!(cap_chars("héllo", 80), "héllo");
        assert_eq!(cap_chars("héllo", 3), "hél…");
    }

    // -----------------------------------------------------------------------
    // Feed: open / poll / truncation / lifetime
    // -----------------------------------------------------------------------

    use crate::llm_sessions::Roots;
    use std::io::Write;

    /// A home directory holding a Claude project folder, plus the transcript
    /// path inside it. Everything the feed touches lives under the tempdir.
    struct Store {
        _dir: tempfile::TempDir,
        roots: Roots,
        transcript: PathBuf,
    }

    fn store() -> Store {
        let dir = tempfile::Builder::new()
            .prefix("termx-chat-feed-")
            .tempdir()
            .unwrap();
        let project = dir.path().join(".claude").join("projects").join("C--Dev-X");
        std::fs::create_dir_all(&project).unwrap();
        let transcript = project.join("11112222-3333.jsonl");
        std::fs::write(&transcript, "").unwrap();
        Store {
            roots: Roots::under_home(dir.path()),
            transcript,
            _dir: dir,
        }
    }

    fn user_line(text: &str) -> String {
        format!(
            "{{\"type\":\"user\",\"uuid\":\"{text}\",\"message\":{{\"role\":\"user\",\"content\":{}}}}}\n",
            serde_json::to_string(text).unwrap()
        )
    }

    fn append(path: &Path, text: &str) {
        let mut file = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        file.write_all(text.as_bytes()).unwrap();
    }

    fn texts(entries: &[ChatEntry]) -> Vec<&str> {
        entries
            .iter()
            .filter_map(|entry| match entry {
                ChatEntry::User { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_poll_returns_exactly_what_was_appended_since_the_last_one() {
        let store = store();
        std::fs::write(&store.transcript, user_line("first")).unwrap();

        let opened = open_feed(Some(&store.roots), &store.transcript).unwrap();
        assert!(opened.reset, "the first window is always a fresh start");
        assert_eq!(texts(&opened.entries), ["first"]);
        assert_eq!(
            opened.offset,
            std::fs::metadata(&store.transcript).unwrap().len()
        );

        append(&store.transcript, &user_line("second"));
        let polled = poll_feed(opened.feed_id).unwrap();
        assert!(!polled.reset);
        assert_eq!(
            texts(&polled.entries),
            ["second"],
            "no re-delivery of 'first'"
        );

        let idle = poll_feed(opened.feed_id).unwrap();
        assert!(idle.entries.is_empty(), "{:#?}", idle.entries);
        assert_eq!(idle.offset, polled.offset);

        close_feed(opened.feed_id);
    }

    #[test]
    fn a_half_written_line_is_held_back_until_its_newline_arrives() {
        let store = store();
        std::fs::write(&store.transcript, user_line("first")).unwrap();
        let opened = open_feed(Some(&store.roots), &store.transcript).unwrap();

        let whole = user_line("second");
        let (head, tail) = whole.split_at(whole.len() / 2);
        append(&store.transcript, head);
        let partial = poll_feed(opened.feed_id).unwrap();
        assert!(
            partial.entries.is_empty(),
            "a clipped line must not be parsed: {:#?}",
            partial.entries
        );

        append(&store.transcript, tail);
        let complete = poll_feed(opened.feed_id).unwrap();
        assert_eq!(texts(&complete.entries), ["second"]);

        // The common shape in a live session: one poll's chunk ends mid-line,
        // so it must deliver the whole lines AND keep the remainder for the
        // next tick rather than dropping it.
        let third = user_line("third");
        let fourth = user_line("fourth");
        let (fourth_head, fourth_tail) = fourth.split_at(fourth.len() / 2);
        append(&store.transcript, &format!("{third}{fourth_head}"));
        let mixed = poll_feed(opened.feed_id).unwrap();
        assert_eq!(texts(&mixed.entries), ["third"]);

        append(&store.transcript, fourth_tail);
        let rest = poll_feed(opened.feed_id).unwrap();
        assert_eq!(
            texts(&rest.entries),
            ["fourth"],
            "the held remainder survived"
        );
        close_feed(opened.feed_id);
    }

    #[test]
    fn an_unterminated_last_line_is_excluded_from_the_opening_window() {
        let store = store();
        let mut body = user_line("first");
        body.push_str("{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"half");
        std::fs::write(&store.transcript, &body).unwrap();

        let opened = open_feed(Some(&store.roots), &store.transcript).unwrap();
        assert_eq!(texts(&opened.entries), ["first"]);
        assert_eq!(
            opened.offset,
            user_line("first").len() as u64,
            "the window ends at the last newline"
        );

        append(&store.transcript, " a message\"}}\n");
        let completed = poll_feed(opened.feed_id).unwrap();
        assert_eq!(texts(&completed.entries), ["half a message"]);
        close_feed(opened.feed_id);
    }

    #[test]
    fn a_rewritten_file_reopens_the_tail_and_reports_a_reset() {
        let store = store();
        std::fs::write(
            &store.transcript,
            format!("{}{}", user_line("first"), user_line("second")),
        )
        .unwrap();
        let opened = open_feed(Some(&store.roots), &store.transcript).unwrap();
        assert_eq!(texts(&opened.entries), ["first", "second"]);

        // A compaction rewrites the file shorter than where we were reading.
        std::fs::write(&store.transcript, user_line("after")).unwrap();
        let reset = poll_feed(opened.feed_id).unwrap();
        assert!(reset.reset, "the renderer must drop what it holds");
        assert_eq!(texts(&reset.entries), ["after"]);
        assert_eq!(
            reset.offset,
            std::fs::metadata(&store.transcript).unwrap().len()
        );
        close_feed(opened.feed_id);
    }

    #[test]
    fn only_transcripts_inside_the_session_folders_may_be_opened() {
        let store = store();
        std::fs::write(&store.transcript, user_line("first")).unwrap();

        let outside = tempfile::Builder::new()
            .prefix("termx-chat-outside-")
            .tempdir()
            .unwrap();
        let secret = outside.path().join("secrets.jsonl");
        std::fs::write(&secret, user_line("not yours")).unwrap();

        assert!(open_feed(Some(&store.roots), &secret).is_err());
        assert!(
            open_feed(None, &store.transcript).is_err(),
            "no roots means nothing is readable"
        );
        assert!(
            open_feed(Some(&store.roots), store.transcript.parent().unwrap()).is_err(),
            "a directory is not a transcript"
        );
        assert!(open_feed(Some(&store.roots), &store.transcript).is_ok());
    }

    #[test]
    fn closing_a_feed_frees_it_and_polling_it_afterwards_is_an_error() {
        let store = store();
        std::fs::write(&store.transcript, user_line("first")).unwrap();
        let opened = open_feed(Some(&store.roots), &store.transcript).unwrap();

        assert!(poll_feed(opened.feed_id).is_ok());
        close_feed(opened.feed_id);
        assert!(poll_feed(opened.feed_id).is_err());
        close_feed(opened.feed_id); // idempotent: a pane may unmount twice
    }

    #[test]
    fn two_feeds_on_one_transcript_keep_separate_cursors() {
        let store = store();
        std::fs::write(&store.transcript, user_line("first")).unwrap();
        let a = open_feed(Some(&store.roots), &store.transcript).unwrap();
        append(&store.transcript, &user_line("second"));
        let b = open_feed(Some(&store.roots), &store.transcript).unwrap();

        assert_ne!(a.feed_id, b.feed_id);
        assert_eq!(texts(&b.entries), ["first", "second"]);
        assert_eq!(texts(&poll_feed(a.feed_id).unwrap().entries), ["second"]);
        assert!(poll_feed(b.feed_id).unwrap().entries.is_empty());
        close_feed(a.feed_id);
        close_feed(b.feed_id);
    }
}
