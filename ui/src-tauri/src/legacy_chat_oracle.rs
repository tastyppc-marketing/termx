//! TEST-ONLY. Frozen pre-adapter Claude chat normalizer.
//!
//! Never production. Source provenance:
//! path: C:/Dev/TermX/.worktrees/swarm-context-parser/retired/test-artifacts/swarm-context/task-5-phase-b2-20260908T233828380123Z/00-before/ui/src-tauri/src/chat_feed.rs
//! sha256: d981f55933f02889cac60abe93cf1d98c260c31716591ef1bd6431b32cc68bf5
//! bytes: 52800
//!
//! Algorithm is the archived ChatNormalizer plus its presentation helpers.

use std::collections::{HashMap, VecDeque};

use serde_json::Value;

use super::{ChatEntry, ToolStatus};

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

/// Top-level record types that are real and deliberately not rendered. Listed
/// so that a genuinely unknown type still counts as unreadable.
const IGNORED_TYPES: [&str; 4] = [
    "attachment",
    "last-prompt",
    "file-history-snapshot",
    "x-command",
];
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
/// straddle a batch boundary.
#[derive(Debug, Default)]
pub struct LegacyChatNormalizer {
    seq: u64,
    pending_user: VecDeque<String>,
    open_tools: HashMap<String, OpenTool>,
    open_order: VecDeque<String>,
}

impl LegacyChatNormalizer {
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
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                unreadable += 1;
                continue;
            };
            let ts = parse_timestamp(value.get("timestamp").and_then(Value::as_str));
            let uuid = value
                .get("uuid")
                .and_then(Value::as_str)
                .map(str::to_string);

            match value.get("type").and_then(Value::as_str) {
                Some("queue-operation") => {
                    self.push_queue_operation(&value, ts, &mut out);
                }
                Some("user") => {
                    if !self.push_user(&value, ts, uuid, &mut out, &mut batch_tools) {
                        unreadable += 1;
                    }
                }
                Some("assistant") => {
                    self.push_assistant(&value, ts, uuid, &mut out, &mut batch_tools);
                }
                Some("system") => {
                    let text = value
                        .get("content")
                        .and_then(Value::as_str)
                        .or_else(|| value.get("subtype").and_then(Value::as_str))
                        .unwrap_or("System notice");
                    let id = uuid.unwrap_or_else(|| self.next_id());
                    out.push(ChatEntry::System {
                        id,
                        ts,
                        text: cap_chars(text, SYSTEM_MAX_CHARS),
                    });
                }
                Some("summary") => {
                    if let Some(text) = value.get("summary").and_then(Value::as_str) {
                        let id = uuid.unwrap_or_else(|| self.next_id());
                        out.push(ChatEntry::System {
                            id,
                            ts,
                            text: cap_chars(text, SYSTEM_MAX_CHARS),
                        });
                    }
                }
                Some(other) if IGNORED_TYPES.contains(&other) => {}
                _ => unreadable += 1,
            }
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

    fn push_queue_operation(&mut self, value: &Value, ts: i64, out: &mut Vec<ChatEntry>) {
        if value.get("operation").and_then(Value::as_str) != Some("enqueue") {
            return;
        }
        let Some(content) = value.get("content").and_then(Value::as_str) else {
            return;
        };
        let text = content.trim();
        if text.is_empty() {
            return;
        }
        self.remember_pending(text);
        let id = self.next_id();
        out.push(ChatEntry::User {
            id,
            ts,
            text: text.to_string(),
        });
    }

    /// A `user` record: the person speaking, a tool answering, or a compaction
    /// recap. Returns false when the record carried nothing usable at all.
    fn push_user(
        &mut self,
        value: &Value,
        ts: i64,
        uuid: Option<String>,
        out: &mut Vec<ChatEntry>,
        batch_tools: &mut HashMap<String, usize>,
    ) -> bool {
        // Meta turns are hook output and command echoes wearing a user role.
        if value.get("isMeta").and_then(Value::as_bool) == Some(true) {
            return true;
        }
        let Some(content) = value.get("message").and_then(|m| m.get("content")) else {
            return false;
        };

        // The post-compaction recap is a boundary marker, not a thing the user
        // said; rendering it as a prompt bubble buries the real conversation.
        let is_recap = value.get("isCompactSummary").and_then(Value::as_bool) == Some(true);

        if let Some(text) = content.as_str() {
            self.emit_user_text(text, ts, uuid, is_recap, out);
            return true;
        }
        let Some(blocks) = content.as_array() else {
            return false;
        };
        let mut used = false;
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        self.emit_user_text(text, ts, uuid.clone(), is_recap, out);
                        used = true;
                    }
                }
                Some("tool_result") => {
                    used |= self.apply_tool_result(value, block, ts, out, batch_tools);
                }
                _ => {}
            }
        }
        used
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
    fn apply_tool_result(
        &mut self,
        record: &Value,
        block: &Value,
        ts: i64,
        out: &mut Vec<ChatEntry>,
        batch_tools: &mut HashMap<String, usize>,
    ) -> bool {
        let Some(tool_id) = block.get("tool_use_id").and_then(Value::as_str) else {
            return false;
        };
        let raw_result = record.get("toolUseResult");
        let status = if block.get("is_error").and_then(Value::as_bool) == Some(true)
            || raw_result
                .and_then(Value::as_str)
                .is_some_and(|s| s.starts_with("Error:"))
        {
            ToolStatus::Error
        } else {
            ToolStatus::Ok
        };
        let detail = cap_chars(&result_detail(block, raw_result), DETAIL_MAX_CHARS);

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

    fn push_assistant(
        &mut self,
        value: &Value,
        ts: i64,
        uuid: Option<String>,
        out: &mut Vec<ChatEntry>,
        batch_tools: &mut HashMap<String, usize>,
    ) {
        let Some(blocks) = value
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        else {
            return;
        };
        for (index, block) in blocks.iter().enumerate() {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let Some(text) = block.get("text").and_then(Value::as_str) else {
                        continue;
                    };
                    if text.trim().is_empty() {
                        continue;
                    }
                    let id = block_id(&uuid, index, || self.next_id());
                    out.push(ChatEntry::Assistant {
                        id,
                        ts,
                        markdown: text.to_string(),
                    });
                }
                Some("thinking") => {
                    let Some(text) = block.get("thinking").and_then(Value::as_str) else {
                        continue;
                    };
                    if text.trim().is_empty() {
                        continue;
                    }
                    let id = block_id(&uuid, index, || self.next_id());
                    out.push(ChatEntry::Thinking {
                        id,
                        ts,
                        text: text.to_string(),
                    });
                }
                Some("tool_use") => {
                    let name = block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string();
                    let id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| block_id(&uuid, index, || self.next_id()));
                    let input = block.get("input").unwrap_or(&Value::Null);
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
fn result_detail(block: &Value, raw_result: Option<&Value>) -> String {
    if let Some(content) = block.get("content") {
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
