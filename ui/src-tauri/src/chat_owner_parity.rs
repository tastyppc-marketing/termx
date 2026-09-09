//! Synthetic ChatEntry parity: archived legacy normalizer vs owner adapter.
//!
//! Oracle provenance is recorded in `legacy_chat_oracle.rs`. All inputs here
//! are inline synthetic lines. The checked-in session fixture is not copied.

use super::legacy_chat_oracle::LegacyChatNormalizer;
use super::{ChatEntry, ChatNormalizer};

fn json(value: serde_json::Value) -> String {
    value.to_string()
}

fn serialize(entries: &[ChatEntry]) -> serde_json::Value {
    serde_json::to_value(entries).expect("ChatEntry is serializable")
}

fn assert_parity(lines: &[&str]) {
    let mut legacy = LegacyChatNormalizer::new();
    let mut current = ChatNormalizer::new();
    let left = serialize(&legacy.push_lines(lines));
    let right = serialize(&current.push_lines(lines));
    assert_eq!(left, right, "lines={lines:#?}");
}

fn assert_parity_batches(batches: &[&[&str]]) {
    let mut legacy = LegacyChatNormalizer::new();
    let mut current = ChatNormalizer::new();
    for (index, batch) in batches.iter().enumerate() {
        let left = serialize(&legacy.push_lines(batch));
        let right = serialize(&current.push_lines(batch));
        assert_eq!(left, right, "batch {index}: {batch:#?}");
    }
}

fn user_nested_string(text: &str) -> String {
    json(serde_json::json!({
        "type": "user",
        "uuid": "u1",
        "timestamp": "1970-01-01T00:00:01.000Z",
        "message": {"role": "user", "content": text}
    }))
}

fn assistant_blocks(uuid: &str, blocks: Vec<serde_json::Value>) -> String {
    json(serde_json::json!({
        "type": "assistant",
        "uuid": uuid,
        "timestamp": "1970-01-01T00:00:02.000Z",
        "message": {"role": "assistant", "content": blocks}
    }))
}

#[test]
fn same_batch_queue_echo_renders_once() {
    let queue = json(serde_json::json!({
        "type": "queue-operation",
        "operation": "enqueue",
        "content": "  hello world  "
    }));
    let echoed = user_nested_string("hello world");
    assert_parity(&[&queue, &echoed]);
}

#[test]
fn cross_batch_queue_echo_renders_once() {
    let queue = json(serde_json::json!({
        "type": "queue-operation",
        "operation": "enqueue",
        "content": "later echo"
    }));
    let echoed = user_nested_string("later echo");
    assert_parity_batches(&[&[&queue], &[&echoed]]);
}

#[test]
fn repeated_uuid_assistant_blocks_keep_distinct_ids() {
    let line = assistant_blocks(
        "same-uuid",
        vec![
            serde_json::json!({"type": "text", "text": "one"}),
            serde_json::json!({"type": "thinking", "thinking": "plan"}),
            serde_json::json!({"type": "text", "text": "two"}),
        ],
    );
    assert_parity(&[&line]);
}

#[test]
fn missing_and_invalid_ids_and_timestamps_match() {
    let missing = json(serde_json::json!({
        "type": "user",
        "message": {"content": "no id"}
    }));
    let bad_ts = json(serde_json::json!({
        "type": "user",
        "uuid": "has space!",
        "timestamp": "yesterday",
        "message": {"content": "bad ts"}
    }));
    assert_parity(&[&missing, &bad_ts]);
}

#[test]
fn user_text_shape_matrix_nested_outer_absent_null_wrong_type() {
    let nested_string = user_nested_string("nested");
    let nested_array = json(serde_json::json!({
        "type": "user",
        "uuid": "arr",
        "message": {"content": [{"type": "text", "text": "block"}]}
    }));
    let nested_empty = json(serde_json::json!({
        "type": "user",
        "uuid": "empty",
        "message": {"content": "   "}
    }));
    let nested_null = json(serde_json::json!({
        "type": "user",
        "message": {"content": null, "text": "from-text"}
    }));
    let nested_text_only = json(serde_json::json!({
        "type": "user",
        "message": {"text": "from-text"}
    }));
    let outer_content = json(serde_json::json!({
        "type": "user",
        "content": "outer-content"
    }));
    let outer_text = json(serde_json::json!({
        "type": "user",
        "text": "outer-text"
    }));
    let absent = json(serde_json::json!({"type": "user", "uuid": "none"}));
    let wrong_type = json(serde_json::json!({
        "type": "user",
        "message": {"content": {"not": "text"}, "text": "hello"}
    }));
    let empty_text_block = json(serde_json::json!({
        "type": "user",
        "message": {"content": [{"type": "text", "text": ""}]}
    }));
    let missing_text_field = json(serde_json::json!({
        "type": "user",
        "message": {"content": [{"type": "text"}]}
    }));
    assert_parity(&[
        &nested_string,
        &nested_array,
        &nested_empty,
        &nested_null,
        &nested_text_only,
        &outer_content,
        &outer_text,
        &absent,
        &wrong_type,
        &empty_text_block,
        &missing_text_field,
    ]);
}

#[test]
fn assistant_text_shape_matrix_requires_nested_array() {
    let array = assistant_blocks(
        "a1",
        vec![serde_json::json!({"type": "text", "text": "ok"})],
    );
    let string_body = json(serde_json::json!({
        "type": "assistant",
        "uuid": "a2",
        "message": {"content": "string-body"}
    }));
    let outer = json(serde_json::json!({
        "type": "assistant",
        "content": [{"type": "text", "text": "outer"}]
    }));
    let missing = json(serde_json::json!({"type": "assistant", "uuid": "a3"}));
    let null_content = json(serde_json::json!({
        "type": "assistant",
        "message": {"content": null, "text": "from-text"}
    }));
    assert_parity(&[&array, &string_body, &outer, &missing, &null_content]);
}

#[test]
fn native_block_kind_filters_transcript_only_shapes() {
    let user = json(serde_json::json!({
        "type": "user",
        "uuid": "u-kinds",
        "message": {"content": [
            {"type": "text", "text": "keep"},
            {"type": "input_text", "text": "drop-user"},
            {"type": "thinking", "thinking": "drop-user-thinking"},
            {"type": "tool_result", "tool_use_id": "missing-call", "content": "orphan"}
        ]}
    }));
    let assistant = assistant_blocks(
        "a-kinds",
        vec![
            serde_json::json!({"type": "text", "text": "keep-asst"}),
            serde_json::json!({"type": "input_text", "text": "drop-asst"}),
            serde_json::json!({"type": "output_text", "text": "drop-output"}),
            serde_json::json!({"type": "function_call", "id": "fn-1", "name": "lookup", "arguments": {"q": 1}}),
            serde_json::json!({"type": "thinking", "thinking": "keep-thinking"}),
            serde_json::json!({"type": "tool_use", "id": "call-keep", "name": "Read", "input": {"file_path": "a.rs"}}),
        ],
    );
    assert_parity(&[&user, &assistant]);
}

#[test]
fn tool_input_null_does_not_take_arguments_fallback() {
    let call = assistant_blocks(
        "tool-uuid",
        vec![serde_json::json!({
            "type": "tool_use",
            "id": "call-null",
            "name": "Bash",
            "input": null,
            "arguments": {"command": "echo hijack", "description": "nope"}
        })],
    );
    let missing = assistant_blocks(
        "tool-uuid-2",
        vec![serde_json::json!({
            "type": "tool_use",
            "id": "call-missing-input",
            "name": "Bash",
            "arguments": {"command": "echo hijack"}
        })],
    );
    let present = assistant_blocks(
        "tool-uuid-3",
        vec![serde_json::json!({
            "type": "tool_use",
            "id": "call-present",
            "name": "Bash",
            "input": {"command": "cargo test", "description": "Run tests"}
        })],
    );
    assert_parity(&[&call, &missing, &present]);
}

#[test]
fn missing_native_id_and_name_use_local_fallbacks() {
    let aliased = assistant_blocks(
        "alias-uuid",
        vec![serde_json::json!({
            "type": "tool_use",
            "tool_use_id": "from-alias",
            "tool_name": "Aliased",
            "input": {"file_path": "C:\\Dev\\a\\App.tsx"}
        })],
    );
    assert_parity(&[&aliased]);
}

#[test]
fn same_batch_and_prior_batch_tool_results() {
    let call = assistant_blocks(
        "call-rec",
        vec![serde_json::json!({
            "type": "tool_use",
            "id": "call-edit",
            "name": "Edit",
            "input": {"file_path": "notes.md"}
        })],
    );
    let result = json(serde_json::json!({
        "type": "user",
        "uuid": "res-rec",
        "timestamp": "1970-01-01T00:00:03.000Z",
        "message": {"content": [{
            "type": "tool_result",
            "tool_use_id": "call-edit",
            "content": "has been updated successfully"
        }]},
        "toolUseResult": {
            "structuredPatch": [{"lines": ["-old", "+new", "+newer"]}]
        }
    }));
    assert_parity(&[&call, &result]);
    assert_parity_batches(&[&[&call], &[&result]]);
}

#[test]
fn transcript_failed_status_without_native_error_stays_ok_in_chat() {
    let call = assistant_blocks(
        "status-call",
        vec![serde_json::json!({
            "type": "tool_use",
            "id": "call-status",
            "name": "Read",
            "input": {"file_path": "status.txt"}
        })],
    );
    let result = json(serde_json::json!({
        "type": "user",
        "message": {"content": [{
            "type": "tool_result",
            "tool_use_id": "call-status",
            "status": "failed",
            "is_error": false,
            "content": "successful native result"
        }]}
    }));

    assert_parity(&[&call, &result]);
    assert_parity_batches(&[&[&call], &[&result]]);
}

#[test]
fn grouped_results_share_one_raw_result_and_patch_counts() {
    let call_a = assistant_blocks(
        "c-a",
        vec![serde_json::json!({
            "type": "tool_use",
            "id": "g-a",
            "name": "Edit",
            "input": {"file_path": "a.rs"}
        })],
    );
    let call_b = assistant_blocks(
        "c-b",
        vec![serde_json::json!({
            "type": "tool_use",
            "id": "g-b",
            "name": "Edit",
            "input": {"file_path": "b.rs"}
        })],
    );
    let grouped = json(serde_json::json!({
        "type": "user",
        "message": {"content": [
            {"type": "tool_result", "tool_use_id": "g-a", "content": [{"type":"text","text":"first"}]},
            {"type": "tool_result", "tool_use_id": "g-b", "content": [{"type":"text","text":"second"}]}
        ]},
        "toolUseResult": {
            "structuredPatch": [{"lines": ["+a", "-b"]}]
        }
    }));
    assert_parity(&[&call_a, &call_b, &grouped]);
}

#[test]
fn raw_error_detail_caps_and_orphan_result() {
    let call = assistant_blocks(
        "bash",
        vec![serde_json::json!({
            "type": "tool_use",
            "id": "call-bash",
            "name": "Bash",
            "input": {"command": "npx --prefix ui vitest run src/x.test.ts", "description": "Confirm tests fail before implementation"}
        })],
    );
    let failed = json(serde_json::json!({
        "type": "user",
        "message": {"content": [{
            "type": "tool_result",
            "tool_use_id": "call-bash",
            "is_error": false,
            "content": "Exit code 1\nmore"
        }]},
        "toolUseResult": "Error: boom"
    }));
    let long = "é".repeat(20_010);
    let long_system = json(serde_json::json!({
        "type": "system",
        "content": long
    }));
    let orphan = json(serde_json::json!({
        "type": "user",
        "message": {"content": [{
            "type": "tool_result",
            "tool_use_id": "no-such-call",
            "content": "orphan"
        }]}
    }));
    let result_id_only = json(serde_json::json!({
        "type": "user",
        "message": {"content": [{
            "type": "tool_result",
            "id": "not-join",
            "content": "ignored-id"
        }]}
    }));
    assert_parity(&[&call, &failed, &long_system, &orphan, &result_id_only]);
}

#[test]
fn meta_ignore_unknown_malformed_unusable_compaction_system() {
    let meta = json(serde_json::json!({
        "type": "user",
        "isMeta": true,
        "message": {"content": "hook output"}
    }));
    let bookkeeping = json(serde_json::json!({"type": "attachment"}));
    let unknown = json(serde_json::json!({"type": "x-future-record"}));
    let malformed = "{broken";
    let compact = json(serde_json::json!({
        "type": "system",
        "subtype": "compact_boundary",
        "content": "Conversation compacted"
    }));
    let recap = json(serde_json::json!({
        "type": "user",
        "isCompactSummary": true,
        "uuid": "recap",
        "message": {"content": "This session is being continued"}
    }));
    let system_bare = json(serde_json::json!({"type": "system"}));
    let summary = json(serde_json::json!({
        "type": "summary",
        "summary": "top-level summary"
    }));
    let empty_summary = json(serde_json::json!({"type": "summary"}));
    let mixed = assistant_blocks(
        "mix",
        vec![
            serde_json::json!({"type": "text", "text": "keep me"}),
            serde_json::json!({"type": "mystery", "text": "do not invent"}),
        ],
    );
    assert_parity(&[
        &meta,
        &bookkeeping,
        &unknown,
        malformed,
        &compact,
        &recap,
        &system_bare,
        &summary,
        &empty_summary,
        &mixed,
    ]);
}

#[test]
fn title_caps_and_generated_id_order() {
    let long_name = "x".repeat(200);
    let call = assistant_blocks(
        "cap",
        vec![serde_json::json!({
            "type": "tool_use",
            "name": "Mystery",
            "input": {"target": long_name}
        })],
    );
    let user = user_nested_string("after");
    assert_parity(&[&call, &user]);
}
