//! Identity-free owner structural parser.
//!
//! This module is the full owner-adapter entry point. The crate-root
//! `OwnerRecord`/`OwnerProjection` and `ProviderParser::project_owner_line`
//! APIs remain for compatibility and are not this adapter surface.
//!
//! Owner projections and records have no `Serialize` implementation. Later
//! chat and transcript adapters map only the fields they need into a private
//! DTO. Native IDs stay optional strings: this parser never validates
//! `NativeId`, synthesizes display IDs, or establishes peer identity.
//!
//! Record-level `toolUseResult` is stored once as `Arc<Value>` and shared by
//! every grouped result on that native record. Block-local `content` and the
//! transcript nullish input selector are stored independently. Message
//! `content ?? text` follows TypeScript nullish coalescing: null/absent
//! content falls through to text; a non-null wrong-type content value does
//! not. Nested `message.role` and outer native kind are retained as raw
//! optional strings; this parser does not infer authority from them.
//!
//! # Provider-family fallback
//!
//! [`OwnerParser::new`] selects [`OwnerParseMode::ProviderFamilyFallback`]:
//! parse the constructor's provider family first. If that family does not
//! match the record (`Unreadable`), try the other known structural family.
//! `Rendered` and `KnownIgnored` count as a match, so bookkeeping records
//! such as Claude `isMeta` users or Codex `session_meta` do not fall through
//! to the other family. This matches `parseTranscriptLine` in the owner
//! transcript viewer.
//!
//! [`OwnerParser::strict`] never tries the other family, matching Claude
//! chat's `ChatNormalizer`. Peer parsing has no fallback.
//!
//! The parser is stateless across lines except for the selected provider and
//! mode. It accepts one complete string and uses serde's ordinary JSON
//! object parse; it does not inherit peer `MAX_PROJECTED_BLOCKS`, the peer
//! LF rule, or the peer scanner's 1 MiB/depth/node/member caps.

use std::sync::Arc;

use serde_json::Value;

use crate::{Provider, ToolStatus};

const CLAUDE_BOOKKEEPING_TYPES: [&str; 4] = [
    "attachment",
    "last-prompt",
    "file-history-snapshot",
    "x-command",
];

const TOOL_INPUT_KEYS: [&str; 6] = ["input", "arguments", "args", "action", "output", "content"];
const TOOL_ID_KEYS: [&str; 3] = ["id", "tool_use_id", "call_id"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerParseMode {
    /// Selected provider family first. If that family does not match the
    /// record (`Unreadable`), try the other known structural family.
    ProviderFamilyFallback,
    /// Only the selected provider family.
    Strict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerFamily {
    Claude,
    Codex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerIgnoreReason {
    EmptyLine,
    BookkeepingRecordType,
    MetaUser,
    SessionMeta,
    NonEnqueueQueueOperation,
    EmptyQueueContent,
    EmptySummary,
    AssistantWithoutRenderableBlocks,
    CodexInstruction,
    CodexReasoning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerUnreadableReason {
    MalformedJson,
    NotAnObject,
    UnknownRecordType,
    UnusableUser,
    UnusableContent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerLineDisposition {
    Rendered,
    KnownIgnored(OwnerIgnoreReason),
    Unreadable(OwnerUnreadableReason),
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct OwnerSource {
    pub native_record_id: Option<String>,
    pub timestamp: Option<String>,
    /// Outer native `type` string. Not an authority enum.
    pub native_kind: Option<String>,
    /// Nested `message.role` / payload `role` string when present. Not an
    /// authority enum: later transcript may honor a nested user/assistant
    /// override and chat may honor the outer kind without reparsing.
    pub nested_message_role: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum OwnerRecord {
    QueuedUser {
        text: String,
    },
    UserText {
        text: String,
    },
    AssistantText {
        text: String,
    },
    Thinking {
        text: String,
    },
    ToolCall {
        call_id: Option<String>,
        tool_name: Option<String>,
        status: ToolStatus,
        input_json: Option<Value>,
    },
    ToolResult {
        call_id: Option<String>,
        status: ToolStatus,
        /// Raw per-block `content` value, including an explicit JSON null.
        content_json: Option<Value>,
        /// Transcript nullish selector: `input ?? arguments ?? args ?? action
        /// ?? output ?? content`. Independent of the raw per-block `content` value.
        input_json: Option<Value>,
        /// Record-level `toolUseResult`, shared across result blocks.
        raw_result_json: Option<Arc<Value>>,
    },
    SystemNotice {
        text: Option<String>,
    },
    Compaction {
        text: String,
        recap: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct OwnerBlock {
    pub index: Option<usize>,
    pub record: OwnerRecord,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OwnerLineOutcome {
    pub source: OwnerSource,
    pub matched_family: Option<OwnerFamily>,
    pub disposition: OwnerLineDisposition,
    pub records: Vec<OwnerBlock>,
    pub unknown_block_count: usize,
    pub unusable_block_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OwnerParser {
    provider: Provider,
    mode: OwnerParseMode,
}

impl OwnerParser {
    /// Identity-free owner parser. Default mode is provider-family fallback.
    pub fn new(provider: Provider) -> Self {
        Self {
            provider,
            mode: OwnerParseMode::ProviderFamilyFallback,
        }
    }

    /// Restrict parsing to the selected provider family only.
    pub fn strict(provider: Provider) -> Self {
        Self {
            provider,
            mode: OwnerParseMode::Strict,
        }
    }

    pub fn with_mode(mut self, mode: OwnerParseMode) -> Self {
        self.mode = mode;
        self
    }

    pub fn provider(&self) -> Provider {
        self.provider
    }

    pub fn mode(&self) -> OwnerParseMode {
        self.mode
    }

    pub fn project_line(&self, line: &str) -> OwnerLineOutcome {
        if line.trim().is_empty() {
            return ignored(OwnerSource::default(), None, OwnerIgnoreReason::EmptyLine);
        }
        let value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => {
                return unreadable(
                    OwnerSource::default(),
                    None,
                    OwnerUnreadableReason::MalformedJson,
                )
            }
        };
        if !value.is_object() {
            return unreadable(
                OwnerSource::default(),
                None,
                OwnerUnreadableReason::NotAnObject,
            );
        }
        let first = parse_family(self.provider, &value);
        if self.mode == OwnerParseMode::Strict
            || !matches!(first.disposition, OwnerLineDisposition::Unreadable(_))
        {
            return first;
        }
        let other = match self.provider {
            Provider::Claude => Provider::Codex,
            Provider::Codex => Provider::Claude,
        };
        let second = parse_family(other, &value);
        if matches!(second.disposition, OwnerLineDisposition::Unreadable(_)) {
            first
        } else {
            second
        }
    }
}

#[derive(Clone, Copy)]
enum BlockRole {
    User,
    Assistant,
}

struct BlockAcc {
    records: Vec<OwnerBlock>,
    unknown: usize,
    unusable: usize,
}

impl BlockAcc {
    fn new() -> Self {
        Self {
            records: Vec::new(),
            unknown: 0,
            unusable: 0,
        }
    }

    fn push(&mut self, index: Option<usize>, record: OwnerRecord) {
        self.records.push(OwnerBlock { index, record });
    }
}

fn parse_family(provider: Provider, value: &Value) -> OwnerLineOutcome {
    match provider {
        Provider::Claude => parse_claude(value),
        Provider::Codex => parse_codex(value),
    }
}

fn parse_claude(value: &Value) -> OwnerLineOutcome {
    let source = claude_source(value);
    let family = Some(OwnerFamily::Claude);
    match str_field(value, "type") {
        Some("queue-operation") => parse_queue_operation(source, family, value),
        Some("user") => parse_claude_user(source, family, value),
        Some("assistant") => parse_claude_assistant(source, family, value),
        Some("system") => parse_claude_system(source, family, value),
        Some("summary") => parse_claude_summary(source, family, value),
        Some(record_type) if CLAUDE_BOOKKEEPING_TYPES.contains(&record_type) => {
            ignored(source, family, OwnerIgnoreReason::BookkeepingRecordType)
        }
        _ => unreadable(source, family, OwnerUnreadableReason::UnknownRecordType),
    }
}

fn claude_source(value: &Value) -> OwnerSource {
    OwnerSource {
        native_record_id: owned_str(value, "uuid"),
        timestamp: owned_str(value, "timestamp"),
        native_kind: owned_str(value, "type"),
        nested_message_role: nested_object(value, "message")
            .and_then(|message| owned_str(message, "role")),
    }
}

fn parse_queue_operation(
    source: OwnerSource,
    family: Option<OwnerFamily>,
    value: &Value,
) -> OwnerLineOutcome {
    if str_field(value, "operation") != Some("enqueue") {
        return ignored(source, family, OwnerIgnoreReason::NonEnqueueQueueOperation);
    }
    match str_field(value, "content") {
        Some(text) if !text.trim().is_empty() => rendered(
            source,
            family,
            vec![OwnerBlock {
                index: None,
                record: OwnerRecord::QueuedUser {
                    text: text.to_owned(),
                },
            }],
            0,
            0,
        ),
        _ => ignored(source, family, OwnerIgnoreReason::EmptyQueueContent),
    }
}

fn parse_claude_user(
    source: OwnerSource,
    family: Option<OwnerFamily>,
    value: &Value,
) -> OwnerLineOutcome {
    if value.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return ignored(source, family, OwnerIgnoreReason::MetaUser);
    }
    let recap = value.get("isCompactSummary").and_then(Value::as_bool) == Some(true);
    match selected_message_body(value) {
        Some(Value::String(text)) => user_text_record(source, family, None, text, recap),
        Some(Value::Array(blocks)) => {
            let raw_result = shared_raw_result(value);
            let mut acc = BlockAcc::new();
            for (index, block) in blocks.iter().enumerate() {
                project_content_block(
                    &mut acc,
                    Some(index),
                    block,
                    BlockRole::User,
                    recap,
                    raw_result.as_ref(),
                );
            }
            finish_user(source, family, acc)
        }
        _ => unreadable(source, family, OwnerUnreadableReason::UnusableUser),
    }
}

fn parse_claude_assistant(
    source: OwnerSource,
    family: Option<OwnerFamily>,
    value: &Value,
) -> OwnerLineOutcome {
    match selected_message_body(value) {
        Some(Value::Array(blocks)) => {
            let raw_result = shared_raw_result(value);
            let mut acc = BlockAcc::new();
            for (index, block) in blocks.iter().enumerate() {
                project_content_block(
                    &mut acc,
                    Some(index),
                    block,
                    BlockRole::Assistant,
                    false,
                    raw_result.as_ref(),
                );
            }
            finish_assistant(source, family, acc)
        }
        Some(Value::String(text)) if !text.trim().is_empty() => rendered(
            source,
            family,
            vec![OwnerBlock {
                index: None,
                record: OwnerRecord::AssistantText {
                    text: text.to_owned(),
                },
            }],
            0,
            0,
        ),
        _ => ignored(
            source,
            family,
            OwnerIgnoreReason::AssistantWithoutRenderableBlocks,
        ),
    }
}

fn parse_claude_system(
    source: OwnerSource,
    family: Option<OwnerFamily>,
    value: &Value,
) -> OwnerLineOutcome {
    let subtype = str_field(value, "subtype");
    let content_text = str_field(value, "content");
    let record = if subtype == Some("compact_boundary") {
        OwnerRecord::Compaction {
            text: content_text.unwrap_or("compact_boundary").to_owned(),
            recap: false,
        }
    } else {
        OwnerRecord::SystemNotice {
            text: content_text.or(subtype).map(str::to_owned),
        }
    };
    rendered(
        source,
        family,
        vec![OwnerBlock {
            index: None,
            record,
        }],
        0,
        0,
    )
}

fn parse_claude_summary(
    source: OwnerSource,
    family: Option<OwnerFamily>,
    value: &Value,
) -> OwnerLineOutcome {
    match str_field(value, "summary") {
        Some(text) => rendered(
            source,
            family,
            vec![OwnerBlock {
                index: None,
                record: OwnerRecord::SystemNotice {
                    text: Some(text.to_owned()),
                },
            }],
            0,
            0,
        ),
        None => ignored(source, family, OwnerIgnoreReason::EmptySummary),
    }
}

fn parse_codex(value: &Value) -> OwnerLineOutcome {
    let payload = nested_object(value, "payload");
    let source = OwnerSource {
        native_record_id: payload
            .and_then(|payload| owned_str(payload, "id"))
            .or_else(|| owned_str(value, "id")),
        timestamp: owned_str(value, "timestamp"),
        native_kind: owned_str(value, "type"),
        nested_message_role: payload.and_then(|payload| owned_str(payload, "role")),
    };
    let family = Some(OwnerFamily::Codex);
    match str_field(value, "type") {
        Some("session_meta") => ignored(source, family, OwnerIgnoreReason::SessionMeta),
        Some("response_item") | Some("event_msg") => match payload {
            Some(payload) => parse_codex_payload(source, family, payload),
            None => unreadable(source, family, OwnerUnreadableReason::UnusableContent),
        },
        _ => unreadable(source, family, OwnerUnreadableReason::UnknownRecordType),
    }
}

fn parse_codex_payload(
    source: OwnerSource,
    family: Option<OwnerFamily>,
    payload: &Value,
) -> OwnerLineOutcome {
    match str_field(payload, "type") {
        Some("message") => parse_codex_message(source, family, payload),
        Some("function_call") => {
            parse_codex_tool_call(source, family, payload, None, ToolStatus::Running)
        }
        Some("custom_tool_call") => {
            parse_codex_tool_call(source, family, payload, None, call_status(payload))
        }
        Some("local_shell_call") => {
            parse_codex_tool_call(source, family, payload, Some("shell"), ToolStatus::Running)
        }
        Some("web_search_call") => parse_codex_tool_call(
            source,
            family,
            payload,
            Some("web_search"),
            ToolStatus::Running,
        ),
        Some("function_call_output")
        | Some("custom_tool_call_output")
        | Some("local_shell_call_output") => parse_codex_tool_result(source, family, payload),
        Some("user_message") => parse_event_message(source, family, payload, BlockRole::User),
        Some("agent_message") => parse_event_message(source, family, payload, BlockRole::Assistant),
        Some("reasoning") => ignored(source, family, OwnerIgnoreReason::CodexReasoning),
        _ => unreadable(source, family, OwnerUnreadableReason::UnknownRecordType),
    }
}

fn parse_codex_message(
    source: OwnerSource,
    family: Option<OwnerFamily>,
    payload: &Value,
) -> OwnerLineOutcome {
    match str_field(payload, "role") {
        Some("developer") | Some("system") => {
            ignored(source, family, OwnerIgnoreReason::CodexInstruction)
        }
        Some("user") => parse_message_content(source, family, payload, BlockRole::User),
        Some("assistant") => parse_message_content(source, family, payload, BlockRole::Assistant),
        _ => unreadable(source, family, OwnerUnreadableReason::UnusableContent),
    }
}

fn parse_message_content(
    source: OwnerSource,
    family: Option<OwnerFamily>,
    payload: &Value,
    role: BlockRole,
) -> OwnerLineOutcome {
    match content_or_text(payload) {
        Some(Value::String(text)) => text_record(source, family, None, text, role, false),
        Some(Value::Array(blocks)) => {
            let mut acc = BlockAcc::new();
            for (index, block) in blocks.iter().enumerate() {
                project_content_block(&mut acc, Some(index), block, role, false, None);
            }
            finish_role(source, family, acc, role)
        }
        _ => empty_for_role(source, family, role),
    }
}

fn parse_event_message(
    source: OwnerSource,
    family: Option<OwnerFamily>,
    payload: &Value,
    role: BlockRole,
) -> OwnerLineOutcome {
    let text = nullish_first(payload, &["message", "content"]).and_then(Value::as_str);
    match text {
        Some(text) if !text.trim().is_empty() => {
            text_record(source, family, None, text, role, false)
        }
        _ => unreadable(source, family, OwnerUnreadableReason::UnusableContent),
    }
}

fn parse_codex_tool_call(
    source: OwnerSource,
    family: Option<OwnerFamily>,
    payload: &Value,
    fallback_name: Option<&str>,
    default_status: ToolStatus,
) -> OwnerLineOutcome {
    rendered(
        source,
        family,
        vec![OwnerBlock {
            index: None,
            record: OwnerRecord::ToolCall {
                call_id: first_str(payload, &TOOL_ID_KEYS).map(str::to_owned),
                tool_name: tool_name(payload, fallback_name),
                status: match str_field(payload, "status") {
                    Some("completed") => ToolStatus::Completed,
                    Some("failed") => ToolStatus::Failed,
                    _ => default_status,
                },
                input_json: nullish_first(payload, &TOOL_INPUT_KEYS).cloned(),
            },
        }],
        0,
        0,
    )
}

fn parse_codex_tool_result(
    source: OwnerSource,
    family: Option<OwnerFamily>,
    payload: &Value,
) -> OwnerLineOutcome {
    rendered(
        source,
        family,
        vec![OwnerBlock {
            index: None,
            record: OwnerRecord::ToolResult {
                call_id: first_str(payload, &TOOL_ID_KEYS).map(str::to_owned),
                status: result_status(payload),
                content_json: payload.get("content").cloned(),
                input_json: nullish_first(payload, &TOOL_INPUT_KEYS).cloned(),
                raw_result_json: None,
            },
        }],
        0,
        0,
    )
}

fn project_content_block(
    acc: &mut BlockAcc,
    index: Option<usize>,
    block: &Value,
    role: BlockRole,
    recap: bool,
    raw_result: Option<&Arc<Value>>,
) {
    if !block.is_object() {
        acc.unknown += 1;
        return;
    }
    match str_field(block, "type") {
        Some("text") | Some("input_text") | Some("output_text") => match str_field(block, "text") {
            Some(text) if !text.trim().is_empty() => match (role, recap) {
                (_, true) => acc.push(
                    index,
                    OwnerRecord::Compaction {
                        text: text.to_owned(),
                        recap: true,
                    },
                ),
                (BlockRole::User, false) => acc.push(
                    index,
                    OwnerRecord::UserText {
                        text: text.to_owned(),
                    },
                ),
                (BlockRole::Assistant, false) => acc.push(
                    index,
                    OwnerRecord::AssistantText {
                        text: text.to_owned(),
                    },
                ),
            },
            _ => acc.unusable += 1,
        },
        Some("thinking") if matches!(role, BlockRole::Assistant) => {
            match str_field(block, "thinking") {
                Some(text) if !text.trim().is_empty() => acc.push(
                    index,
                    OwnerRecord::Thinking {
                        text: text.to_owned(),
                    },
                ),
                _ => acc.unusable += 1,
            }
        }
        Some("tool_use") | Some("function_call") | Some("custom_tool_call") => acc.push(
            index,
            OwnerRecord::ToolCall {
                call_id: first_str(block, &TOOL_ID_KEYS).map(str::to_owned),
                tool_name: tool_name(block, None),
                status: call_status(block),
                input_json: nullish_first(block, &TOOL_INPUT_KEYS).cloned(),
            },
        ),
        Some("tool_result") | Some("function_call_output") | Some("custom_tool_call_output") => {
            acc.push(
                index,
                OwnerRecord::ToolResult {
                    call_id: first_str(block, &TOOL_ID_KEYS).map(str::to_owned),
                    status: result_status(block),
                    content_json: block.get("content").cloned(),
                    input_json: nullish_first(block, &TOOL_INPUT_KEYS).cloned(),
                    raw_result_json: raw_result.cloned(),
                },
            );
        }
        _ => acc.unknown += 1,
    }
}

fn user_text_record(
    source: OwnerSource,
    family: Option<OwnerFamily>,
    index: Option<usize>,
    text: &str,
    recap: bool,
) -> OwnerLineOutcome {
    if text.trim().is_empty() {
        return unreadable(source, family, OwnerUnreadableReason::UnusableUser);
    }
    let record = if recap {
        OwnerRecord::Compaction {
            text: text.to_owned(),
            recap: true,
        }
    } else {
        OwnerRecord::UserText {
            text: text.to_owned(),
        }
    };
    rendered(source, family, vec![OwnerBlock { index, record }], 0, 0)
}

fn text_record(
    source: OwnerSource,
    family: Option<OwnerFamily>,
    index: Option<usize>,
    text: &str,
    role: BlockRole,
    recap: bool,
) -> OwnerLineOutcome {
    if text.trim().is_empty() {
        return empty_for_role(source, family, role);
    }
    let record = match (role, recap) {
        (_, true) => OwnerRecord::Compaction {
            text: text.to_owned(),
            recap: true,
        },
        (BlockRole::User, false) => OwnerRecord::UserText {
            text: text.to_owned(),
        },
        (BlockRole::Assistant, false) => OwnerRecord::AssistantText {
            text: text.to_owned(),
        },
    };
    rendered(source, family, vec![OwnerBlock { index, record }], 0, 0)
}

fn finish_user(
    source: OwnerSource,
    family: Option<OwnerFamily>,
    acc: BlockAcc,
) -> OwnerLineOutcome {
    if acc.records.is_empty() {
        let mut outcome = unreadable(source, family, OwnerUnreadableReason::UnusableUser);
        outcome.unknown_block_count = acc.unknown;
        outcome.unusable_block_count = acc.unusable;
        outcome
    } else {
        rendered(source, family, acc.records, acc.unknown, acc.unusable)
    }
}

fn finish_assistant(
    source: OwnerSource,
    family: Option<OwnerFamily>,
    acc: BlockAcc,
) -> OwnerLineOutcome {
    finish_role(source, family, acc, BlockRole::Assistant)
}

fn finish_role(
    source: OwnerSource,
    family: Option<OwnerFamily>,
    acc: BlockAcc,
    role: BlockRole,
) -> OwnerLineOutcome {
    if acc.records.is_empty() {
        let mut outcome = empty_for_role(source, family, role);
        outcome.unknown_block_count = acc.unknown;
        outcome.unusable_block_count = acc.unusable;
        outcome
    } else {
        rendered(source, family, acc.records, acc.unknown, acc.unusable)
    }
}

fn empty_for_role(
    source: OwnerSource,
    family: Option<OwnerFamily>,
    role: BlockRole,
) -> OwnerLineOutcome {
    match role {
        BlockRole::User => unreadable(source, family, OwnerUnreadableReason::UnusableUser),
        BlockRole::Assistant => ignored(
            source,
            family,
            OwnerIgnoreReason::AssistantWithoutRenderableBlocks,
        ),
    }
}

fn nested_object<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|candidate| candidate.is_object())
}

fn selected_message_body(value: &Value) -> Option<&Value> {
    match nested_object(value, "message") {
        Some(message) => content_or_text(message),
        None => content_or_text(value),
    }
}

fn content_or_text(source: &Value) -> Option<&Value> {
    nullish_field(source, "content").or_else(|| nullish_field(source, "text"))
}

fn tool_name(value: &Value, fallback: Option<&str>) -> Option<String> {
    first_str(value, &["name", "tool_name"])
        .map(str::to_owned)
        .or_else(|| fallback.map(str::to_owned))
}

fn call_status(value: &Value) -> ToolStatus {
    match str_field(value, "status") {
        Some("completed") => ToolStatus::Completed,
        Some("failed") => ToolStatus::Failed,
        _ => ToolStatus::Running,
    }
}

fn result_status(value: &Value) -> ToolStatus {
    if value.get("is_error").and_then(Value::as_bool) == Some(true)
        || str_field(value, "status") == Some("failed")
    {
        ToolStatus::Failed
    } else {
        ToolStatus::Completed
    }
}

fn shared_raw_result(value: &Value) -> Option<Arc<Value>> {
    value.get("toolUseResult").cloned().map(Arc::new)
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn owned_str(value: &Value, key: &str) -> Option<String> {
    str_field(value, key).map(str::to_owned)
}

fn first_str<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().copied().find_map(|key| str_field(value, key))
}

fn nullish_field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value.get(key) {
        None | Some(Value::Null) => None,
        some => some,
    }
}

fn nullish_first<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .copied()
        .find_map(|key| nullish_field(value, key))
}

fn rendered(
    source: OwnerSource,
    family: Option<OwnerFamily>,
    records: Vec<OwnerBlock>,
    unknown_block_count: usize,
    unusable_block_count: usize,
) -> OwnerLineOutcome {
    OwnerLineOutcome {
        source,
        matched_family: family,
        disposition: OwnerLineDisposition::Rendered,
        records,
        unknown_block_count,
        unusable_block_count,
    }
}

fn ignored(
    source: OwnerSource,
    family: Option<OwnerFamily>,
    reason: OwnerIgnoreReason,
) -> OwnerLineOutcome {
    OwnerLineOutcome {
        source,
        matched_family: family,
        disposition: OwnerLineDisposition::KnownIgnored(reason),
        records: Vec::new(),
        unknown_block_count: 0,
        unusable_block_count: 0,
    }
}

fn unreadable(
    source: OwnerSource,
    family: Option<OwnerFamily>,
    reason: OwnerUnreadableReason,
) -> OwnerLineOutcome {
    OwnerLineOutcome {
        source,
        matched_family: family,
        disposition: OwnerLineDisposition::Unreadable(reason),
        records: Vec::new(),
        unknown_block_count: 0,
        unusable_block_count: 0,
    }
}
