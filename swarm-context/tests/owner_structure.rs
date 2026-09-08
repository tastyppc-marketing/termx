use std::sync::Arc;

use serde_json::{json, Value};
use termx_swarm_context::owner::{
    OwnerBlock, OwnerFamily, OwnerIgnoreReason, OwnerLineDisposition, OwnerLineOutcome,
    OwnerParseMode, OwnerParser, OwnerRecord, OwnerUnreadableReason,
};
use termx_swarm_context::{
    JsonlScanner, PeerRecord, Provider, ProviderParser, ToolStatus, UnavailableReason,
    MAX_PROJECTED_BLOCKS,
};

fn fallback(provider: Provider) -> OwnerParser {
    OwnerParser::new(provider)
}

fn strict(provider: Provider) -> OwnerParser {
    OwnerParser::strict(provider)
}

fn project(provider: Provider, line: &str) -> OwnerLineOutcome {
    fallback(provider).project_line(line)
}

fn project_strict(provider: Provider, line: &str) -> OwnerLineOutcome {
    strict(provider).project_line(line)
}

fn line(value: Value) -> String {
    value.to_string()
}

fn records_of(outcome: &OwnerLineOutcome) -> Vec<&OwnerRecord> {
    outcome.records.iter().map(|block| &block.record).collect()
}

fn peer_project(provider: Provider, conversation: &str, bytes: &[u8]) -> Vec<PeerRecord> {
    let mut parser = ProviderParser::new(provider, conversation).unwrap();
    let mut scanner = JsonlScanner::new(0);
    let mut projected = Vec::new();
    scanner
        .push_chunk(bytes, |item| {
            projected.extend(parser.project_peer(item).records().iter().cloned())
        })
        .unwrap();
    projected
}

#[test]
fn event_message_selector_matches_nullish_transcript_precedence() {
    for kind in ["user_message", "agent_message"] {
        for value in [json!(false), json!(0), json!([]), json!({}), json!("")] {
            let raw = line(json!({"type":"event_msg","payload":{
                "type":kind,"message":value,"content":"must not fall through"
            }}));
            let outcome = project_strict(Provider::Codex, &raw);
            assert!(
                outcome.records.is_empty(),
                "non-null message takes precedence"
            );
        }
        for message in [None, Some(Value::Null), Some(json!("primary"))] {
            let mut payload = json!({"type":kind,"content":"fallback"});
            if let Some(value) = &message {
                payload["message"] = value.clone();
            }
            let raw = line(json!({"type":"event_msg","payload":payload}));
            let outcome = project_strict(Provider::Codex, &raw);
            let expected = if message == Some(json!("primary")) {
                "primary"
            } else {
                "fallback"
            };
            assert_eq!(outcome.records.len(), 1);
            match &outcome.records[0].record {
                OwnerRecord::UserText { text } | OwnerRecord::AssistantText { text } => {
                    assert_eq!(text, expected)
                }
                other => panic!("unexpected structural variant: {other:?}"),
            }
        }
    }
}

fn claude_user(content: Value) -> String {
    line(json!({
        "type": "user",
        "uuid": "user-record",
        "timestamp": "2026-01-01T00:00:00.000Z",
        "sessionId": "other-session",
        "message": {"role": "user", "content": content}
    }))
}

fn claude_assistant(blocks: Vec<Value>) -> String {
    line(json!({
        "type": "assistant",
        "uuid": "asst-record",
        "timestamp": "2026-01-01T00:00:01.000Z",
        "sessionId": "other-session",
        "message": {
            "id": "msg-1",
            "type": "message",
            "role": "assistant",
            "content": blocks
        }
    }))
}

fn codex_item(payload: Value) -> String {
    line(json!({
        "timestamp": "2026-01-01T00:00:02.000Z",
        "type": "response_item",
        "payload": payload
    }))
}

fn assert_rendered(outcome: &OwnerLineOutcome) {
    assert_eq!(
        outcome.disposition,
        OwnerLineDisposition::Rendered,
        "{outcome:?}"
    );
}

fn assert_ignored(outcome: &OwnerLineOutcome, reason: OwnerIgnoreReason) {
    assert_eq!(
        outcome.disposition,
        OwnerLineDisposition::KnownIgnored(reason),
        "{outcome:?}"
    );
    assert!(outcome.records.is_empty(), "{outcome:?}");
}

fn assert_unreadable(outcome: &OwnerLineOutcome, reason: OwnerUnreadableReason) {
    assert_eq!(
        outcome.disposition,
        OwnerLineDisposition::Unreadable(reason),
        "{outcome:?}"
    );
    assert!(outcome.records.is_empty(), "{outcome:?}");
}

#[test]
fn construction_takes_provider_only_and_defaults_to_family_fallback() {
    let parser = OwnerParser::new(Provider::Claude);
    assert_eq!(parser.provider(), Provider::Claude);
    assert_eq!(parser.mode(), OwnerParseMode::ProviderFamilyFallback);
    let strict_parser = OwnerParser::strict(Provider::Codex);
    assert_eq!(strict_parser.provider(), Provider::Codex);
    assert_eq!(strict_parser.mode(), OwnerParseMode::Strict);
    let switched = OwnerParser::new(Provider::Claude).with_mode(OwnerParseMode::Strict);
    assert_eq!(switched.mode(), OwnerParseMode::Strict);
}

#[test]
fn claude_queue_operation_enqueue_is_queued_user() {
    let outcome = project(
        Provider::Claude,
        &line(json!({
            "type": "queue-operation",
            "operation": "enqueue",
            "uuid": "queue-1",
            "timestamp": "2026-01-01T00:00:00.000Z",
            "content": "  queued prompt  "
        })),
    );
    assert_rendered(&outcome);
    assert_eq!(outcome.source.native_record_id.as_deref(), Some("queue-1"));
    assert_eq!(
        outcome.source.timestamp.as_deref(),
        Some("2026-01-01T00:00:00.000Z")
    );
    assert_eq!(outcome.matched_family, Some(OwnerFamily::Claude));
    assert_eq!(
        outcome.records,
        vec![OwnerBlock {
            index: None,
            record: OwnerRecord::QueuedUser {
                text: "  queued prompt  ".to_owned()
            }
        }]
    );
}

#[test]
fn claude_queue_operation_non_enqueue_and_empty_content_are_known_ignored() {
    assert_ignored(
        &project(
            Provider::Claude,
            &line(json!({"type":"queue-operation","operation":"dequeue","content":"x"})),
        ),
        OwnerIgnoreReason::NonEnqueueQueueOperation,
    );
    assert_ignored(
        &project(
            Provider::Claude,
            &line(json!({"type":"queue-operation","operation":"enqueue","content":"   "})),
        ),
        OwnerIgnoreReason::EmptyQueueContent,
    );
}

#[test]
fn claude_user_and_assistant_text_keep_native_source_and_block_index() {
    let user = project(Provider::Claude, &claude_user(json!("plain user")));
    assert_rendered(&user);
    assert_eq!(user.source.native_record_id.as_deref(), Some("user-record"));
    assert_eq!(
        user.records,
        vec![OwnerBlock {
            index: None,
            record: OwnerRecord::UserText {
                text: "plain user".to_owned()
            }
        }]
    );

    let blocks = project(
        Provider::Claude,
        &claude_user(json!([
            {"type":"text","text":"first"},
            {"type":"text","text":"second"}
        ])),
    );
    assert_eq!(
        blocks.records,
        vec![
            OwnerBlock {
                index: Some(0),
                record: OwnerRecord::UserText {
                    text: "first".to_owned()
                }
            },
            OwnerBlock {
                index: Some(1),
                record: OwnerRecord::UserText {
                    text: "second".to_owned()
                }
            }
        ]
    );

    let assistant = project(
        Provider::Claude,
        &claude_assistant(vec![
            json!({"type":"text","text":"alpha"}),
            json!({"type":"text","text":"beta"}),
        ]),
    );
    assert_eq!(
        assistant.records,
        vec![
            OwnerBlock {
                index: Some(0),
                record: OwnerRecord::AssistantText {
                    text: "alpha".to_owned()
                }
            },
            OwnerBlock {
                index: Some(1),
                record: OwnerRecord::AssistantText {
                    text: "beta".to_owned()
                }
            }
        ]
    );
}

#[test]
fn claude_thinking_is_representable_and_empty_thinking_is_unusable_not_fabricated() {
    let outcome = project(
        Provider::Claude,
        &claude_assistant(vec![
            json!({"type":"thinking","thinking":"**plan**"}),
            json!({"type":"thinking","thinking":"   "}),
            json!({"type":"redacted_thinking","thinking":"secret"}),
            json!({"type":"text","text":"visible"}),
        ]),
    );
    assert_rendered(&outcome);
    assert_eq!(outcome.unknown_block_count, 1);
    assert_eq!(outcome.unusable_block_count, 1);
    assert_eq!(
        records_of(&outcome),
        vec![
            &OwnerRecord::Thinking {
                text: "**plan**".to_owned()
            },
            &OwnerRecord::AssistantText {
                text: "visible".to_owned()
            }
        ]
    );
}

#[test]
fn claude_tool_call_keeps_optional_identity_and_structured_input() {
    let present = project(
        Provider::Claude,
        &claude_assistant(vec![json!({
            "type": "tool_use",
            "id": "call-1",
            "name": "Write",
            "input": {"file_path": "ui/src/App.tsx", "content": "body"}
        })]),
    );
    assert_eq!(
        present.records[0],
        OwnerBlock {
            index: Some(0),
            record: OwnerRecord::ToolCall {
                call_id: Some("call-1".to_owned()),
                tool_name: Some("Write".to_owned()),
                status: ToolStatus::Running,
                input_json: Some(json!({"file_path":"ui/src/App.tsx","content":"body"})),
            }
        }
    );

    let missing = project(
        Provider::Claude,
        &claude_assistant(vec![json!({"type":"tool_use","input":{"q":1}})]),
    );
    match &missing.records[0].record {
        OwnerRecord::ToolCall {
            call_id,
            tool_name,
            input_json,
            ..
        } => {
            assert_eq!(call_id, &None);
            assert_eq!(tool_name, &None);
            assert_eq!(input_json, &Some(json!({"q":1})));
        }
        other => panic!("expected tool call, got {other:?}"),
    }
}

#[test]
fn claude_tool_result_stays_grouped_with_raw_patch_and_error_shape() {
    let patch = json!([{
        "oldStart": 1,
        "newStart": 1,
        "lines": ["-old", "+new"]
    }]);
    let nested = json!([
        {"type":"text","text":"updated successfully"},
        {"type":"text","text":"second nested"}
    ]);
    let outcome = project(
        Provider::Claude,
        &line(json!({
            "type": "user",
            "uuid": "result-record",
            "message": {
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "call-1",
                    "is_error": false,
                    "content": nested
                }]
            },
            "toolUseResult": {
                "structuredPatch": patch,
                "stdout": "ok"
            }
        })),
    );
    assert_eq!(outcome.records.len(), 1);
    match &outcome.records[0].record {
        OwnerRecord::ToolResult {
            call_id,
            status,
            content_json,
            input_json,
            raw_result_json,
        } => {
            assert_eq!(call_id.as_deref(), Some("call-1"));
            assert_eq!(*status, ToolStatus::Completed);
            assert_eq!(content_json.as_ref(), Some(&nested));
            assert_eq!(input_json.as_ref(), Some(&nested));
            assert_eq!(
                raw_result_json.as_deref(),
                Some(&json!({"structuredPatch": patch, "stdout": "ok"}))
            );
        }
        other => panic!("expected grouped tool result, got {other:?}"),
    }

    let failed = project(
        Provider::Claude,
        &line(json!({
            "type": "user",
            "message": {
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "call-err",
                    "is_error": true,
                    "content": "Exit code 1"
                }]
            },
            "toolUseResult": "Error: boom"
        })),
    );
    match &failed.records[0].record {
        OwnerRecord::ToolResult {
            status,
            content_json,
            raw_result_json,
            ..
        } => {
            assert_eq!(*status, ToolStatus::Failed);
            assert_eq!(content_json.as_ref(), Some(&json!("Exit code 1")));
            assert_eq!(raw_result_json.as_deref(), Some(&json!("Error: boom")));
        }
        other => panic!("expected failed tool result, got {other:?}"),
    }

    let missing_id = project(
        Provider::Claude,
        &line(json!({
            "type": "user",
            "message": {
                "content": [{"type":"tool_result","content":"orphaned"}]
            }
        })),
    );
    match &missing_id.records[0].record {
        OwnerRecord::ToolResult { call_id, .. } => assert_eq!(call_id, &None),
        other => panic!("expected tool result with missing id, got {other:?}"),
    }
}

#[test]
fn claude_system_summary_and_compaction_forms() {
    let system = project(
        Provider::Claude,
        &line(json!({
            "type": "system",
            "uuid": "sys-1",
            "content": "generic notice",
            "subtype": "info"
        })),
    );
    assert_eq!(
        records_of(&system),
        vec![&OwnerRecord::SystemNotice {
            text: Some("generic notice".to_owned())
        }]
    );

    let subtype_only = project(
        Provider::Claude,
        &line(json!({"type":"system","subtype":"status"})),
    );
    assert_eq!(
        records_of(&subtype_only),
        vec![&OwnerRecord::SystemNotice {
            text: Some("status".to_owned())
        }]
    );

    let summary = project(
        Provider::Claude,
        &line(json!({"type":"summary","uuid":"sum-1","summary":"top-level summary"})),
    );
    assert_eq!(
        records_of(&summary),
        vec![&OwnerRecord::SystemNotice {
            text: Some("top-level summary".to_owned())
        }]
    );

    let boundary = project(
        Provider::Claude,
        &line(json!({
            "type": "system",
            "subtype": "compact_boundary",
            "content": "Conversation compacted"
        })),
    );
    assert_eq!(
        records_of(&boundary),
        vec![&OwnerRecord::Compaction {
            text: "Conversation compacted".to_owned(),
            recap: false
        }]
    );

    let recap = project(
        Provider::Claude,
        &line(json!({
            "type": "user",
            "isCompactSummary": true,
            "message": {"content": "This session is being continued"}
        })),
    );
    assert_eq!(
        records_of(&recap),
        vec![&OwnerRecord::Compaction {
            text: "This session is being continued".to_owned(),
            recap: true
        }]
    );
}

#[test]
fn claude_known_ignored_versus_unknown_malformed_and_unusable() {
    for bookkeeping in [
        "attachment",
        "last-prompt",
        "file-history-snapshot",
        "x-command",
    ] {
        assert_ignored(
            &project(Provider::Claude, &line(json!({"type": bookkeeping}))),
            OwnerIgnoreReason::BookkeepingRecordType,
        );
    }
    assert_ignored(
        &project(
            Provider::Claude,
            &line(json!({
                "type": "user",
                "isMeta": true,
                "message": {"content": "hook output"}
            })),
        ),
        OwnerIgnoreReason::MetaUser,
    );
    assert_ignored(
        &project(Provider::Claude, "   "),
        OwnerIgnoreReason::EmptyLine,
    );
    assert_unreadable(
        &project(Provider::Claude, "{broken"),
        OwnerUnreadableReason::MalformedJson,
    );
    assert_unreadable(
        &project(Provider::Claude, "[1,2]"),
        OwnerUnreadableReason::NotAnObject,
    );
    assert_unreadable(
        &project(
            Provider::Claude,
            &line(json!({"type":"x-future-record","payload":{"note":"unknown"}})),
        ),
        OwnerUnreadableReason::UnknownRecordType,
    );
    assert_unreadable(
        &project(Provider::Claude, &line(json!({"type":"user","uuid":"u"}))),
        OwnerUnreadableReason::UnusableUser,
    );
    assert_ignored(
        &project(
            Provider::Claude,
            &line(json!({"type":"summary","uuid":"empty"})),
        ),
        OwnerIgnoreReason::EmptySummary,
    );
}

#[test]
fn mixed_known_and_unknown_blocks_keep_recognized_owner_records() {
    let outcome = project(
        Provider::Claude,
        &claude_assistant(vec![
            json!({"type":"text","text":"keep me"}),
            json!({"type":"mystery","text":"do not invent"}),
            json!({"type":"tool_use","id":"call-mix","name":"Read","input":{"path":"a.rs"}}),
        ]),
    );
    assert_rendered(&outcome);
    assert_eq!(outcome.unknown_block_count, 1);
    assert_eq!(outcome.records.len(), 2);
    assert!(matches!(
        outcome.records[0].record,
        OwnerRecord::AssistantText { ref text } if text == "keep me"
    ));
    assert!(matches!(
        outcome.records[1].record,
        OwnerRecord::ToolCall { ref call_id, .. } if call_id.as_deref() == Some("call-mix")
    ));
    let texts: Vec<&str> = outcome
        .records
        .iter()
        .filter_map(|block| match &block.record {
            OwnerRecord::AssistantText { text } | OwnerRecord::UserText { text } => {
                Some(text.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(texts, ["keep me"]);
}

#[test]
fn unknown_shapes_never_become_fabricated_messages() {
    let outcome = project(
        Provider::Claude,
        &claude_assistant(vec![json!({"type":"image","source":"xyz"})]),
    );
    assert_ignored(
        &outcome,
        OwnerIgnoreReason::AssistantWithoutRenderableBlocks,
    );
    assert_eq!(outcome.unknown_block_count, 1);
}

#[test]
fn claude_content_union_includes_transcript_block_types() {
    let outcome = project(
        Provider::Claude,
        &claude_assistant(vec![
            json!({"type":"input_text","text":"in"}),
            json!({"type":"output_text","text":"out"}),
            json!({"type":"function_call","id":"fn-1","name":"lookup","arguments":"{\"q\":1}"}),
            json!({"type":"custom_tool_call","call_id":"custom-1","name":"custom","input":{"a":true}}),
        ]),
    );
    assert_eq!(outcome.records.len(), 4);
    assert!(matches!(
        outcome.records[0].record,
        OwnerRecord::AssistantText { ref text } if text == "in"
    ));
    assert!(matches!(
        outcome.records[1].record,
        OwnerRecord::AssistantText { ref text } if text == "out"
    ));
    match &outcome.records[2].record {
        OwnerRecord::ToolCall {
            call_id,
            tool_name,
            input_json,
            ..
        } => {
            assert_eq!(call_id.as_deref(), Some("fn-1"));
            assert_eq!(tool_name.as_deref(), Some("lookup"));
            assert_eq!(input_json, &Some(json!("{\"q\":1}")));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn missing_or_mismatched_claude_identity_and_invalid_native_id_remain_viewable() {
    let missing = project(
        Provider::Claude,
        &line(json!({
            "type": "user",
            "uuid": "has space!",
            "message": {"content": "no session"}
        })),
    );
    assert_rendered(&missing);
    assert_eq!(
        missing.source.native_record_id.as_deref(),
        Some("has space!")
    );
    assert!(matches!(
        missing.records[0].record,
        OwnerRecord::UserText { ref text } if text == "no session"
    ));

    let mismatched = project(Provider::Claude, &claude_user(json!("still visible")));
    assert_rendered(&mismatched);
    assert_eq!(
        mismatched.source.native_record_id.as_deref(),
        Some("user-record")
    );
}

#[test]
fn headerless_codex_and_session_meta_are_viewable_without_identity() {
    let headerless = project(
        Provider::Codex,
        &codex_item(json!({
            "type": "message",
            "role": "user",
            "id": "m1",
            "content": [{"type":"input_text","text":"inspect it"}]
        })),
    );
    assert_rendered(&headerless);
    assert_eq!(headerless.matched_family, Some(OwnerFamily::Codex));
    assert_eq!(headerless.source.native_record_id.as_deref(), Some("m1"));
    assert!(matches!(
        headerless.records[0].record,
        OwnerRecord::UserText { ref text } if text == "inspect it"
    ));

    let meta = project(
        Provider::Codex,
        &line(json!({"type":"session_meta","payload":{"id":"session","cwd":"C:\\work"}})),
    );
    assert_ignored(&meta, OwnerIgnoreReason::SessionMeta);
    assert_eq!(meta.matched_family, Some(OwnerFamily::Codex));
}

#[test]
fn codex_function_custom_shell_and_web_search_calls_and_outputs() {
    let function_call = project(
        Provider::Codex,
        &codex_item(json!({
            "type": "function_call",
            "id": "item-1",
            "call_id": "call-fn",
            "name": "lookup",
            "arguments": {"query": "alpha"}
        })),
    );
    match &function_call.records[0].record {
        OwnerRecord::ToolCall {
            call_id,
            tool_name,
            input_json,
            status,
        } => {
            assert_eq!(call_id.as_deref(), Some("item-1"));
            assert_eq!(tool_name.as_deref(), Some("lookup"));
            assert_eq!(input_json, &Some(json!({"query":"alpha"})));
            assert_eq!(*status, ToolStatus::Running);
        }
        other => panic!("{other:?}"),
    }

    let custom = project(
        Provider::Codex,
        &codex_item(json!({
            "type": "custom_tool_call",
            "id": "item-2",
            "call_id": "call-custom",
            "name": "Synthetic",
            "status": "completed",
            "input": "{\"target\":\"owner-only\"}"
        })),
    );
    match &custom.records[0].record {
        OwnerRecord::ToolCall {
            tool_name,
            status,
            input_json,
            ..
        } => {
            assert_eq!(tool_name.as_deref(), Some("Synthetic"));
            assert_eq!(*status, ToolStatus::Completed);
            assert_eq!(
                input_json,
                &Some(json!("{\"target\":\"owner-only\"}")),
                "native JSON string is stored without reparse"
            );
        }
        other => panic!("{other:?}"),
    }

    let shell = project(
        Provider::Codex,
        &codex_item(json!({
            "type": "local_shell_call",
            "call_id": "call-2",
            "action": {"type":"exec","command":"npm run build"}
        })),
    );
    match &shell.records[0].record {
        OwnerRecord::ToolCall {
            call_id,
            tool_name,
            input_json,
            ..
        } => {
            assert_eq!(call_id.as_deref(), Some("call-2"));
            assert_eq!(tool_name.as_deref(), Some("shell"));
            assert_eq!(
                input_json,
                &Some(json!({"type":"exec","command":"npm run build"}))
            );
        }
        other => panic!("{other:?}"),
    }

    let search = project(
        Provider::Codex,
        &codex_item(json!({
            "type": "web_search_call",
            "call_id": "call-web",
            "action": {"query": "termx owner parser"}
        })),
    );
    match &search.records[0].record {
        OwnerRecord::ToolCall { tool_name, .. } => {
            assert_eq!(tool_name.as_deref(), Some("web_search"));
        }
        other => panic!("{other:?}"),
    }

    let fn_out = project(
        Provider::Codex,
        &codex_item(json!({
            "type": "function_call_output",
            "call_id": "call-fn",
            "output": [{"type":"input_text","text":"one"},{"type":"input_text","text":"two"}]
        })),
    );
    match &fn_out.records[0].record {
        OwnerRecord::ToolResult {
            call_id,
            content_json,
            input_json,
            raw_result_json,
            status,
        } => {
            assert_eq!(call_id.as_deref(), Some("call-fn"));
            assert_eq!(*status, ToolStatus::Completed);
            assert_eq!(content_json, &None, "Codex output is not a content field");
            assert_eq!(
                input_json,
                &Some(json!([
                    {"type":"input_text","text":"one"},
                    {"type":"input_text","text":"two"}
                ]))
            );
            assert_eq!(raw_result_json, &None);
            assert_eq!(fn_out.records.len(), 1, "grouped per native payload");
        }
        other => panic!("{other:?}"),
    }

    let custom_out = project(
        Provider::Codex,
        &codex_item(json!({
            "type": "custom_tool_call_output",
            "call_id": "call-custom",
            "output": "done"
        })),
    );
    match &custom_out.records[0].record {
        OwnerRecord::ToolResult {
            content_json,
            input_json,
            call_id,
            ..
        } => {
            assert_eq!(call_id.as_deref(), Some("call-custom"));
            assert_eq!(content_json, &None);
            assert_eq!(input_json, &Some(json!("done")));
        }
        other => panic!("{other:?}"),
    }

    let shell_out = project(
        Provider::Codex,
        &codex_item(json!({
            "type": "local_shell_call_output",
            "call_id": "call-2",
            "output": "build ok"
        })),
    );
    match &shell_out.records[0].record {
        OwnerRecord::ToolResult {
            content_json,
            input_json,
            ..
        } => {
            assert_eq!(content_json, &None);
            assert_eq!(input_json, &Some(json!("build ok")));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn codex_messages_and_event_msg_user_and_agent() {
    let assistant = project(
        Provider::Codex,
        &codex_item(json!({
            "type": "message",
            "role": "assistant",
            "id": "a1",
            "content": [{"type":"output_text","text":"answer"}]
        })),
    );
    assert!(matches!(
        assistant.records[0].record,
        OwnerRecord::AssistantText { ref text } if text == "answer"
    ));

    let event_user = project(
        Provider::Codex,
        &line(json!({
            "type": "event_msg",
            "payload": {"type":"user_message","message":"from event"}
        })),
    );
    assert!(matches!(
        event_user.records[0].record,
        OwnerRecord::UserText { ref text } if text == "from event"
    ));

    let event_agent = project(
        Provider::Codex,
        &line(json!({
            "type": "event_msg",
            "payload": {"type":"agent_message","content":"agent says"}
        })),
    );
    assert!(matches!(
        event_agent.records[0].record,
        OwnerRecord::AssistantText { ref text } if text == "agent says"
    ));

    let instruction = project(
        Provider::Codex,
        &codex_item(json!({
            "type": "message",
            "role": "developer",
            "content": [{"type":"input_text","text":"secret instruction"}]
        })),
    );
    assert_ignored(&instruction, OwnerIgnoreReason::CodexInstruction);

    let reasoning = project(
        Provider::Codex,
        &codex_item(json!({"type":"reasoning","summary":"hidden"})),
    );
    assert_ignored(&reasoning, OwnerIgnoreReason::CodexReasoning);
}

#[test]
fn fallback_uses_selected_family_first_then_the_other_known_family() {
    let claude_line = claude_user(json!("plain user"));
    let codex_line = codex_item(json!({
        "type": "message",
        "role": "user",
        "content": [{"type":"input_text","text":"inspect it"}]
    }));

    let claude_on_codex = project(Provider::Claude, &codex_line);
    assert_rendered(&claude_on_codex);
    assert_eq!(claude_on_codex.matched_family, Some(OwnerFamily::Codex));
    assert!(matches!(
        claude_on_codex.records[0].record,
        OwnerRecord::UserText { ref text } if text == "inspect it"
    ));

    let codex_on_claude = project(Provider::Codex, &claude_line);
    assert_rendered(&codex_on_claude);
    assert_eq!(codex_on_claude.matched_family, Some(OwnerFamily::Claude));
    assert!(matches!(
        codex_on_claude.records[0].record,
        OwnerRecord::UserText { ref text } if text == "plain user"
    ));

    let selected_wins = project(Provider::Claude, &claude_line);
    assert_eq!(selected_wins.matched_family, Some(OwnerFamily::Claude));
}

#[test]
fn strict_mode_does_not_fall_back_to_the_other_family() {
    let claude_line = claude_user(json!("plain user"));
    let codex_line = codex_item(json!({
        "type": "message",
        "role": "user",
        "content": [{"type":"input_text","text":"inspect it"}]
    }));

    assert_unreadable(
        &project_strict(Provider::Claude, &codex_line),
        OwnerUnreadableReason::UnknownRecordType,
    );
    assert_unreadable(
        &project_strict(Provider::Codex, &claude_line),
        OwnerUnreadableReason::UnknownRecordType,
    );

    let still_claude = project_strict(Provider::Claude, &claude_line);
    assert_eq!(still_claude.matched_family, Some(OwnerFamily::Claude));
    assert_rendered(&still_claude);
}

#[test]
fn independent_peer_parser_still_refuses_mismatches_and_headerless_codex() {
    let claude = br#"{"sessionId":"other-session","uuid":"user-record","type":"user","message":{"content":"still visible"}}"#;
    let peer_claude = peer_project(
        Provider::Claude,
        "expected",
        &[claude.as_slice(), b"\n"].concat(),
    );
    assert!(matches!(
        peer_claude.first(),
        Some(PeerRecord::Unavailable {
            reason: UnavailableReason::ConflictingConversationIdentity,
            ..
        })
    ));

    let missing = br#"{"uuid":"user-record","type":"user","message":{"content":"no session"}}"#;
    let peer_missing = peer_project(
        Provider::Claude,
        "expected",
        &[missing.as_slice(), b"\n"].concat(),
    );
    assert!(matches!(
        peer_missing.first(),
        Some(PeerRecord::Unavailable {
            reason: UnavailableReason::MissingConversationIdentity,
            ..
        })
    ));

    let headerless = br#"{"type":"response_item","payload":{"type":"message","role":"user","id":"m1","content":[{"type":"input_text","text":"inspect it"}]}}"#;
    let peer_codex = peer_project(
        Provider::Codex,
        "session",
        &[headerless.as_slice(), b"\n"].concat(),
    );
    assert!(matches!(
        peer_codex.first(),
        Some(PeerRecord::Unavailable {
            reason: UnavailableReason::MissingConversationIdentity,
            ..
        })
    ));
}

#[test]
fn owner_parsing_does_not_establish_or_change_peer_identity() {
    let owner = OwnerParser::new(Provider::Codex);
    let meta = owner.project_line(r#"{"type":"session_meta","payload":{"id":"session"}}"#);
    assert_ignored(&meta, OwnerIgnoreReason::SessionMeta);
    let visible = owner.project_line(
        r#"{"type":"response_item","payload":{"type":"message","role":"user","id":"m1","content":[{"type":"input_text","text":"hello"}]}}"#,
    );
    assert_rendered(&visible);

    let mut peer = ProviderParser::new(Provider::Codex, "session").unwrap();
    let mut scanner = JsonlScanner::new(0);
    let mut projected = Vec::new();
    scanner
        .push_chunk(
            br#"{"type":"response_item","payload":{"type":"message","role":"user","id":"m1","content":[{"type":"input_text","text":"hello"}]}}"#,
            |item| projected.push(peer.project_peer(item)),
        )
        .unwrap();
    assert!(projected.is_empty(), "no LF so peer scanner yields no item");
    scanner
        .push_chunk(b"\n", |item| projected.push(peer.project_peer(item)))
        .unwrap();
    assert!(matches!(
        projected[0].records().first(),
        Some(PeerRecord::Unavailable {
            reason: UnavailableReason::MissingConversationIdentity,
            ..
        })
    ));
}

#[test]
fn owner_record_over_peer_block_cap_preserves_all_recognized_blocks() {
    let blocks: Vec<Value> = (0..=MAX_PROJECTED_BLOCKS)
        .map(|index| json!({"type":"text","text":format!("owner-{index}")}))
        .collect();
    let outcome = project(Provider::Claude, &claude_assistant(blocks));
    assert_rendered(&outcome);
    assert_eq!(outcome.records.len(), MAX_PROJECTED_BLOCKS + 1);
    assert!(matches!(
        outcome.records.last().map(|block| &block.record),
        Some(OwnerRecord::AssistantText { text })
            if text == &format!("owner-{MAX_PROJECTED_BLOCKS}")
    ));
}

#[test]
fn owner_accepts_complete_string_without_lf_and_peer_lf_behavior_is_untouched() {
    let raw = r#"{"type":"user","uuid":"nl","message":{"content":"no newline"}}"#;
    let outcome = project(Provider::Claude, raw);
    assert_rendered(&outcome);
    assert!(!raw.ends_with('\n'));

    let mut parser = ProviderParser::new(Provider::Claude, "session").unwrap();
    let mut scanner = JsonlScanner::new(0);
    let mut peer = Vec::new();
    scanner
        .push_chunk(raw.as_bytes(), |item| peer.push(parser.project_peer(item)))
        .unwrap();
    assert!(peer.is_empty());
    assert!(scanner.lag().is_some());
}

#[test]
fn owner_field_inspection_positive_control_observes_namespaced_records() {
    let outcome = OwnerParser::new(Provider::Claude).project_line(
        r#"{"type":"user","uuid":"rec","timestamp":"t0","message":{"content":"text"}}"#,
    );
    assert_eq!(outcome.source.native_record_id.as_deref(), Some("rec"));
    assert_eq!(outcome.source.timestamp.as_deref(), Some("t0"));
    assert_eq!(outcome.source.native_kind.as_deref(), Some("user"));
    assert_eq!(outcome.source.nested_message_role.as_deref(), None);
    assert_eq!(outcome.records[0].index, None);
    assert!(matches!(
        outcome.records[0].record,
        OwnerRecord::UserText { ref text } if text == "text"
    ));
}

#[test]
fn top_level_owner_projection_api_remains_available_and_separate() {
    let mut parser = ProviderParser::new(Provider::Claude, "session").unwrap();
    let compatibility = parser
        .project_owner_line(
            r#"{"sessionId":"session","uuid":"record","type":"user","message":{"role":"user","content":"text"}}"#,
        )
        .unwrap();
    assert_eq!(compatibility.provider(), Provider::Claude);
    assert!(matches!(
        compatibility.records().first(),
        Some(termx_swarm_context::OwnerRecord::UserText { text }) if text == "text"
    ));
}

fn tool_result_raw_ptrs(outcome: &OwnerLineOutcome) -> Vec<*const Value> {
    outcome
        .records
        .iter()
        .map(|block| match &block.record {
            OwnerRecord::ToolResult {
                raw_result_json: Some(value),
                ..
            } => Arc::as_ptr(value),
            other => panic!("expected tool result with raw_result_json, got {other:?}"),
        })
        .collect()
}

fn tool_result_raw_arcs(outcome: &OwnerLineOutcome) -> Vec<&Arc<Value>> {
    outcome
        .records
        .iter()
        .map(|block| match &block.record {
            OwnerRecord::ToolResult {
                raw_result_json: Some(value),
                ..
            } => value,
            other => panic!("expected tool result with raw_result_json, got {other:?}"),
        })
        .collect()
}

#[test]
fn r1_raw_tool_use_result_is_one_allocation_per_record_user_and_assistant() {
    let blob = "x".repeat(4096);
    let raw = json!({
        "structuredPatch": [{"oldStart": 1, "newStart": 1, "lines": ["-old", "+new"]}],
        "blob": blob,
        "error": {"message": "kept"}
    });
    let blocks = |prefix: &str, count: usize| -> Vec<Value> {
        (0..count)
            .map(|index| {
                json!({
                    "type": "tool_result",
                    "tool_use_id": format!("{prefix}-{index}"),
                    "content": format!("{prefix}-body-{index}")
                })
            })
            .collect()
    };

    let user = project(
        Provider::Claude,
        &line(json!({
            "type": "user",
            "uuid": "user-many-results",
            "message": {"role": "user", "content": blocks("user", 16)},
            "toolUseResult": raw
        })),
    );
    assert_rendered(&user);
    assert_eq!(user.records.len(), 16);
    let user_ptrs = tool_result_raw_ptrs(&user);
    let user_arcs = tool_result_raw_arcs(&user);
    assert_eq!(user_ptrs.len(), 16);
    for (index, ptr) in user_ptrs.iter().enumerate() {
        assert_eq!(
            *ptr, user_ptrs[0],
            "user result {index} must share one record-level raw allocation"
        );
        assert!(
            Arc::ptr_eq(user_arcs[index], user_arcs[0]),
            "user result {index} Arc must clone the same allocation"
        );
        assert_eq!(user_arcs[index].as_ref(), &raw);
    }
    match &user.records[0].record {
        OwnerRecord::ToolResult {
            content_json,
            raw_result_json,
            ..
        } => {
            assert_eq!(content_json.as_ref(), Some(&json!("user-body-0")));
            assert_eq!(raw_result_json.as_deref(), Some(&raw));
        }
        other => panic!("{other:?}"),
    }
    match &user.records[15].record {
        OwnerRecord::ToolResult { content_json, .. } => {
            assert_eq!(content_json.as_ref(), Some(&json!("user-body-15")));
        }
        other => panic!("{other:?}"),
    }

    let assistant = project(
        Provider::Claude,
        &line(json!({
            "type": "assistant",
            "uuid": "asst-many-results",
            "message": {"role": "assistant", "content": blocks("asst", 12)},
            "toolUseResult": raw
        })),
    );
    assert_rendered(&assistant);
    let assistant_ptrs = tool_result_raw_ptrs(&assistant);
    let assistant_arcs = tool_result_raw_arcs(&assistant);
    assert_eq!(assistant_ptrs.len(), 12);
    for (index, ptr) in assistant_ptrs.iter().enumerate() {
        assert_eq!(
            *ptr, assistant_ptrs[0],
            "assistant result {index} must share one record-level raw allocation"
        );
        assert!(Arc::ptr_eq(assistant_arcs[index], assistant_arcs[0]));
        assert_eq!(assistant_arcs[index].as_ref(), &raw);
    }
    assert_ne!(
        user_ptrs[0], assistant_ptrs[0],
        "distinct native records must not share one raw allocation"
    );
    assert!(!Arc::ptr_eq(user_arcs[0], assistant_arcs[0]));
}

#[test]
fn r2_nested_message_text_and_null_content_select_text() {
    let nested_user = project(
        Provider::Claude,
        &line(json!({
            "type": "user",
            "uuid": "nested-user-text",
            "message": {"text": "hello"}
        })),
    );
    assert_rendered(&nested_user);
    assert!(matches!(
        nested_user.records[0].record,
        OwnerRecord::UserText { ref text } if text == "hello"
    ));

    let nested_assistant = project(
        Provider::Claude,
        &line(json!({
            "type": "assistant",
            "uuid": "nested-asst-text",
            "message": {"text": "from-nested"}
        })),
    );
    assert_rendered(&nested_assistant);
    assert!(matches!(
        nested_assistant.records[0].record,
        OwnerRecord::AssistantText { ref text } if text == "from-nested"
    ));

    let null_then_text = project(
        Provider::Claude,
        &line(json!({
            "type": "user",
            "message": {"content": null, "text": "from-text"}
        })),
    );
    assert_rendered(&null_then_text);
    assert!(matches!(
        null_then_text.records[0].record,
        OwnerRecord::UserText { ref text } if text == "from-text"
    ));

    let payload_text = project(
        Provider::Codex,
        &codex_item(json!({
            "type": "message",
            "role": "assistant",
            "text": "hello"
        })),
    );
    assert_rendered(&payload_text);
    assert!(matches!(
        payload_text.records[0].record,
        OwnerRecord::AssistantText { ref text } if text == "hello"
    ));

    let payload_null_content = project(
        Provider::Codex,
        &codex_item(json!({
            "type": "message",
            "role": "user",
            "content": null,
            "text": "payload-text"
        })),
    );
    assert_rendered(&payload_null_content);
    assert!(matches!(
        payload_null_content.records[0].record,
        OwnerRecord::UserText { ref text } if text == "payload-text"
    ));
}

#[test]
fn r2_non_null_wrong_type_content_does_not_select_unrelated_text() {
    let object_content = project(
        Provider::Claude,
        &line(json!({
            "type": "user",
            "message": {"content": {"not": "text"}, "text": "hello"}
        })),
    );
    assert_unreadable(&object_content, OwnerUnreadableReason::UnusableUser);

    let empty_string_content = project(
        Provider::Claude,
        &line(json!({
            "type": "user",
            "message": {"content": "", "text": "hello"}
        })),
    );
    assert_unreadable(&empty_string_content, OwnerUnreadableReason::UnusableUser);

    let false_content = project(
        Provider::Claude,
        &line(json!({
            "type": "user",
            "message": {"content": false, "text": "hello"}
        })),
    );
    assert_unreadable(&false_content, OwnerUnreadableReason::UnusableUser);

    let zero_content = project(
        Provider::Codex,
        &codex_item(json!({
            "type": "message",
            "role": "assistant",
            "content": 0,
            "text": "hello"
        })),
    );
    assert_ignored(
        &zero_content,
        OwnerIgnoreReason::AssistantWithoutRenderableBlocks,
    );
}

#[test]
fn r2_tool_input_nullish_retains_arguments_when_input_is_null() {
    let null_input = project(
        Provider::Codex,
        &codex_item(json!({
            "type": "function_call",
            "call_id": "call-null-input",
            "name": "lookup",
            "input": null,
            "arguments": {"command": "echo"}
        })),
    );
    match &null_input.records[0].record {
        OwnerRecord::ToolCall { input_json, .. } => {
            assert_eq!(input_json, &Some(json!({"command": "echo"})));
        }
        other => panic!("{other:?}"),
    }

    let absent_input = project(
        Provider::Codex,
        &codex_item(json!({
            "type": "function_call",
            "name": "lookup",
            "arguments": {"command": "echo"}
        })),
    );
    match &absent_input.records[0].record {
        OwnerRecord::ToolCall { input_json, .. } => {
            assert_eq!(input_json, &Some(json!({"command": "echo"})));
        }
        other => panic!("{other:?}"),
    }

    let false_input = project(
        Provider::Codex,
        &codex_item(json!({
            "type": "function_call",
            "name": "lookup",
            "input": false,
            "arguments": {"command": "echo"}
        })),
    );
    match &false_input.records[0].record {
        OwnerRecord::ToolCall { input_json, .. } => {
            assert_eq!(input_json, &Some(json!(false)));
        }
        other => panic!("{other:?}"),
    }

    let zero_input = project(
        Provider::Codex,
        &codex_item(json!({
            "type": "function_call",
            "name": "lookup",
            "input": 0,
            "arguments": {"command": "echo"}
        })),
    );
    match &zero_input.records[0].record {
        OwnerRecord::ToolCall { input_json, .. } => {
            assert_eq!(input_json, &Some(json!(0)));
        }
        other => panic!("{other:?}"),
    }

    let empty_input = project(
        Provider::Codex,
        &codex_item(json!({
            "type": "function_call",
            "name": "lookup",
            "input": "",
            "arguments": {"command": "echo"}
        })),
    );
    match &empty_input.records[0].record {
        OwnerRecord::ToolCall { input_json, .. } => {
            assert_eq!(input_json, &Some(json!("")));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn r2_recognized_system_without_text_is_retained_structurally() {
    let outcome = project(Provider::Claude, &line(json!({"type": "system"})));
    assert_rendered(&outcome);
    assert_eq!(outcome.records.len(), 1);
    assert_eq!(outcome.source.native_kind.as_deref(), Some("system"));
    match &outcome.records[0].record {
        OwnerRecord::SystemNotice { text } => {
            assert_eq!(text, &None, "parser must not invent a display string")
        }
        other => panic!("expected SystemNotice without text, got {other:?}"),
    }
}

#[test]
fn source_retains_outer_native_kind_and_nested_role_without_inferring_authority() {
    let outcome = project(
        Provider::Claude,
        include_str!("fixtures/owner/nested-role-override.json"),
    );
    assert_rendered(&outcome);
    assert_eq!(outcome.source.native_kind.as_deref(), Some("user"));
    assert_eq!(
        outcome.source.nested_message_role.as_deref(),
        Some("assistant")
    );
    assert!(
        matches!(
            &outcome.records[0].record,
            OwnerRecord::UserText { text } if text == "hello"
        ),
        "parser must not reclassify by nested role"
    );

    let codex = project(
        Provider::Codex,
        include_str!("fixtures/owner/codex-payload-text.json"),
    );
    assert_eq!(codex.source.native_kind.as_deref(), Some("response_item"));
    assert_eq!(
        codex.source.nested_message_role.as_deref(),
        Some("assistant")
    );
}

#[test]
fn content_text_oracle_absent_null_wrong_type_nested_and_top_level_precedence() {
    let nested_user = project(
        Provider::Claude,
        include_str!("fixtures/owner/nested-claude-user-text.json"),
    );
    assert!(matches!(
        nested_user.records[0].record,
        OwnerRecord::UserText { ref text } if text == "hello"
    ));

    let nested_assistant = project(
        Provider::Claude,
        include_str!("fixtures/owner/nested-claude-assistant-text.json"),
    );
    assert!(matches!(
        nested_assistant.records[0].record,
        OwnerRecord::AssistantText { ref text } if text == "from-nested"
    ));

    let null_content = project(
        Provider::Claude,
        include_str!("fixtures/owner/claude-null-content-text.json"),
    );
    assert!(matches!(
        null_content.records[0].record,
        OwnerRecord::UserText { ref text } if text == "from-text"
    ));

    assert_unreadable(
        &project(
            Provider::Claude,
            include_str!("fixtures/owner/claude-wrong-type-content.json"),
        ),
        OwnerUnreadableReason::UnusableUser,
    );

    let content_beats_text = project(
        Provider::Claude,
        &line(json!({
            "type": "user",
            "message": {"content": "from-content", "text": "from-text"}
        })),
    );
    assert!(matches!(
        content_beats_text.records[0].record,
        OwnerRecord::UserText { ref text } if text == "from-content"
    ));

    let top_level_text = project(
        Provider::Claude,
        &line(json!({"type": "user", "text": "top-level"})),
    );
    assert!(matches!(
        top_level_text.records[0].record,
        OwnerRecord::UserText { ref text } if text == "top-level"
    ));

    let nested_beats_top_level = project(
        Provider::Claude,
        &line(json!({
            "type": "user",
            "text": "top-level",
            "content": "top-content",
            "message": {"content": "nested"}
        })),
    );
    assert!(matches!(
        nested_beats_top_level.records[0].record,
        OwnerRecord::UserText { ref text } if text == "nested"
    ));

    let payload_text = project(
        Provider::Codex,
        include_str!("fixtures/owner/codex-payload-text.json"),
    );
    assert!(matches!(
        payload_text.records[0].record,
        OwnerRecord::AssistantText { ref text } if text == "hello"
    ));
}

#[test]
fn tool_result_keeps_block_content_and_transcript_input_independently() {
    let outcome = project(
        Provider::Claude,
        include_str!("fixtures/owner/tool-result-content-and-output.json"),
    );
    assert_rendered(&outcome);
    match &outcome.records[0].record {
        OwnerRecord::ToolResult {
            content_json,
            input_json,
            raw_result_json,
            ..
        } => {
            assert_eq!(content_json.as_ref(), Some(&json!("chat-body")));
            assert_eq!(input_json.as_ref(), Some(&json!("transcript-body")));
            assert_eq!(raw_result_json, &None);
        }
        other => panic!("{other:?}"),
    }

    let null_content_output = project(
        Provider::Claude,
        &line(json!({
            "type": "user",
            "message": {
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "call-2",
                    "content": null,
                    "output": "from-output"
                }]
            }
        })),
    );
    match &null_content_output.records[0].record {
        OwnerRecord::ToolResult {
            content_json,
            input_json,
            ..
        } => {
            assert_eq!(content_json.as_ref(), Some(&Value::Null));
            assert_eq!(input_json.as_ref(), Some(&json!("from-output")));
        }
        other => panic!("{other:?}"),
    }

    let call_null_input = project(
        Provider::Codex,
        include_str!("fixtures/owner/function-call-null-input.json"),
    );
    match &call_null_input.records[0].record {
        OwnerRecord::ToolCall { input_json, .. } => {
            assert_eq!(input_json, &Some(json!({"command": "echo"})));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn r1_many_results_over_peer_block_cap_still_share_one_raw_allocation() {
    let blob = "y".repeat(2048);
    let raw = json!({"blob": blob, "structuredPatch": [{"lines": ["+a"]}]});
    let count = MAX_PROJECTED_BLOCKS + 8;
    let blocks: Vec<Value> = (0..count)
        .map(|index| {
            json!({
                "type": "tool_result",
                "tool_use_id": format!("cap-{index}"),
                "content": format!("body-{index}")
            })
        })
        .collect();
    let outcome = project(
        Provider::Claude,
        &line(json!({
            "type": "user",
            "uuid": "over-cap-results",
            "message": {"content": blocks},
            "toolUseResult": raw
        })),
    );
    assert_rendered(&outcome);
    assert_eq!(outcome.records.len(), count);
    let arcs = tool_result_raw_arcs(&outcome);
    assert_eq!(arcs.len(), count);
    for (index, shared) in arcs.iter().enumerate() {
        assert!(
            Arc::ptr_eq(shared, arcs[0]),
            "result {index} must clone Arc, not Value"
        );
        assert_eq!(shared.as_ref(), &raw);
        match &outcome.records[index].record {
            OwnerRecord::ToolResult { content_json, .. } => {
                assert_eq!(content_json.as_ref(), Some(&json!(format!("body-{index}"))));
            }
            other => panic!("{other:?}"),
        }
    }
}

#[test]
fn fixture_system_without_text_matches_structural_marker() {
    let outcome = project(
        Provider::Claude,
        include_str!("fixtures/owner/system-without-text.json"),
    );
    assert_rendered(&outcome);
    assert!(matches!(
        &outcome.records[0].record,
        OwnerRecord::SystemNotice { text: None }
    ));
}
