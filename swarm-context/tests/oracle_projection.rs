use serde_json::Value;
use termx_swarm_context::{
    AssistantPhase, JsonlScanner, OmissionCounts, PeerRecord, Provider, ProviderParser, ToolStatus,
};

const CLAUDE_INPUT: &[u8] =
    include_bytes!("fixtures/adversarial/original/fixtures/claude-adversarial.jsonl");
const CODEX_INPUT: &[u8] =
    include_bytes!("fixtures/adversarial/original/fixtures/codex-adversarial.jsonl");
const CLAUDE_EXPECTED: &[u8] =
    include_bytes!("fixtures/adversarial/derived/expected/claude.expected.json");
const CODEX_EXPECTED: &[u8] =
    include_bytes!("fixtures/adversarial/derived/expected/codex.expected.json");
const PROVENANCE_INPUT: &str =
    include_str!("fixtures/adversarial/original/fixtures/provenance-adversarial.jsonl");
const PROVENANCE_EXPECTED: &[u8] =
    include_bytes!("fixtures/adversarial/original/expected/provenance.expected.json");

#[derive(Clone, Debug, PartialEq, Eq)]
struct SemanticRecord {
    kind: String,
    native_record_id: String,
    native_response_id: Option<String>,
    block_index: Option<u16>,
    subblock_index: Option<u16>,
    text: Option<String>,
    phase: Option<String>,
    call_id: Option<String>,
    tool_name: Option<String>,
    status: Option<String>,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct OmissionSummary {
    provider_records: u64,
    blocks: u64,
    private_reasoning_blocks: u64,
    unknown_sensitive_blocks: u64,
    metadata_records: u64,
    instruction_records: u64,
}

fn project(
    provider: Provider,
    conversation: &str,
    input: &[u8],
) -> Vec<termx_swarm_context::PeerProjection> {
    let mut parser = ProviderParser::new(provider, conversation).unwrap();
    let mut projections = Vec::new();
    JsonlScanner::new(0)
        .push_chunk(input, |item| projections.push(parser.project_peer(item)))
        .unwrap();
    projections
}

fn actual_semantics(
    projections: &[termx_swarm_context::PeerProjection],
) -> Result<Vec<SemanticRecord>, String> {
    projections
        .iter()
        .flat_map(|projection| projection.records())
        .map(|record| match record {
            PeerRecord::UserText { identity, text } => Ok(SemanticRecord {
                kind: "user_text".to_owned(),
                native_record_id: identity.native_record_id().as_str().to_owned(),
                native_response_id: identity
                    .native_response_id()
                    .map(|id| id.as_str().to_owned()),
                block_index: identity.block_index(),
                subblock_index: identity.subblock_index(),
                text: Some(text.clone()),
                phase: None,
                call_id: None,
                tool_name: None,
                status: None,
            }),
            PeerRecord::AssistantText {
                identity,
                phase,
                text,
            } => Ok(SemanticRecord {
                kind: "assistant_text".to_owned(),
                native_record_id: identity.native_record_id().as_str().to_owned(),
                native_response_id: identity
                    .native_response_id()
                    .map(|id| id.as_str().to_owned()),
                block_index: identity.block_index(),
                subblock_index: identity.subblock_index(),
                text: Some(text.clone()),
                phase: Some(phase.as_str().to_owned()),
                call_id: None,
                tool_name: None,
                status: None,
            }),
            PeerRecord::ToolCall {
                identity,
                call_id,
                tool_name,
                status,
            } => Ok(SemanticRecord {
                kind: "tool_call".to_owned(),
                native_record_id: identity.native_record_id().as_str().to_owned(),
                native_response_id: identity
                    .native_response_id()
                    .map(|id| id.as_str().to_owned()),
                block_index: identity.block_index(),
                subblock_index: identity.subblock_index(),
                text: None,
                phase: None,
                call_id: Some(call_id.as_str().to_owned()),
                tool_name: Some(tool_name.clone()),
                status: Some(tool_status(*status).to_owned()),
            }),
            PeerRecord::ToolResult {
                identity,
                call_id,
                text,
                status,
            } => Ok(SemanticRecord {
                kind: "tool_result".to_owned(),
                native_record_id: identity.native_record_id().as_str().to_owned(),
                native_response_id: identity
                    .native_response_id()
                    .map(|id| id.as_str().to_owned()),
                block_index: identity.block_index(),
                subblock_index: identity.subblock_index(),
                text: Some(text.clone()),
                phase: None,
                call_id: Some(call_id.as_str().to_owned()),
                tool_name: None,
                status: Some(tool_status(*status).to_owned()),
            }),
            PeerRecord::CompactionBoundary { identity, text } => Ok(SemanticRecord {
                kind: "compaction_boundary".to_owned(),
                native_record_id: identity.native_record_id().as_str().to_owned(),
                native_response_id: identity
                    .native_response_id()
                    .map(|id| id.as_str().to_owned()),
                block_index: identity.block_index(),
                subblock_index: identity.subblock_index(),
                text: Some(text.clone()),
                phase: None,
                call_id: None,
                tool_name: None,
                status: None,
            }),
            PeerRecord::CompactionSummary { identity, text } => Ok(SemanticRecord {
                kind: "compaction_summary".to_owned(),
                native_record_id: identity.native_record_id().as_str().to_owned(),
                native_response_id: identity
                    .native_response_id()
                    .map(|id| id.as_str().to_owned()),
                block_index: identity.block_index(),
                subblock_index: identity.subblock_index(),
                text: Some(text.clone()),
                phase: None,
                call_id: None,
                tool_name: None,
                status: None,
            }),
            PeerRecord::Unavailable { reason, .. } => {
                Err(format!("unexpected unavailable record: {reason:?}"))
            }
        })
        .collect()
}

fn expected_semantics(provider: Provider, bytes: &[u8]) -> Vec<SemanticRecord> {
    let document: Value = serde_json::from_slice(bytes).unwrap();
    document["records"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(index, record)| {
            assert_eq!(record["order"].as_u64(), Some((index + 1) as u64));
            let kind = required_string(record, "kind");
            let mut semantic = SemanticRecord {
                kind: kind.clone(),
                native_record_id: required_string(record, "native_record_id"),
                native_response_id: optional_string(record, "native_response_id"),
                block_index: optional_u16(record, "block_index"),
                subblock_index: None,
                text: optional_string(record, "text"),
                phase: optional_string(record, "phase"),
                call_id: optional_string(record, "native_call_id"),
                tool_name: optional_string(record, "tool_name"),
                status: None,
            };
            match (provider, kind.as_str()) {
                (_, "assistant_text") if semantic.phase.is_none() => {
                    semantic.phase = Some("unspecified".to_owned());
                }
                (Provider::Claude, "tool_call") => {
                    semantic.block_index = Some(0);
                    semantic.status = Some("running".to_owned());
                }
                (Provider::Codex, "tool_call") => {
                    semantic.status = Some("completed".to_owned());
                }
                (Provider::Claude, "tool_result") => {
                    semantic.block_index = Some(0);
                    semantic.subblock_index = Some(0);
                    semantic.status = Some(
                        if record["is_error"].as_bool() == Some(true) {
                            "failed"
                        } else {
                            "completed"
                        }
                        .to_owned(),
                    );
                }
                (Provider::Codex, "tool_result") => {
                    semantic.block_index = Some(0);
                    semantic.status = Some("completed".to_owned());
                }
                _ => {}
            }
            semantic
        })
        .collect()
}

fn expected_omissions(bytes: &[u8]) -> OmissionSummary {
    let document: Value = serde_json::from_slice(bytes).unwrap();
    let mut expected = OmissionSummary::default();
    if document["conversation_header"]["separate_native_header_record"].as_bool() == Some(true) {
        expected.provider_records += 1;
        expected.metadata_records += 1;
    }
    for omitted in document["excluded"].as_array().unwrap() {
        match omitted["reason"].as_str().unwrap() {
            "private_model_reasoning" | "redacted_private_model_reasoning" => {
                expected.provider_records += 1;
                expected.blocks += 1;
                expected.private_reasoning_blocks += 1;
            }
            "unknown_sensitive_variant" => {
                expected.provider_records += 1;
                expected.blocks += 1;
                expected.unknown_sensitive_blocks += 1;
            }
            "developer_instruction" | "system_instruction" => {
                expected.provider_records += 1;
                expected.instruction_records += 1;
            }
            reason => panic!("unsupported fixture omission reason: {reason}"),
        }
    }
    expected
}

fn actual_omissions(projections: &[termx_swarm_context::PeerProjection]) -> OmissionSummary {
    let mut total = OmissionCounts::default();
    for projection in projections {
        total.checked_add_assign(projection.omissions()).unwrap();
    }
    OmissionSummary {
        provider_records: total.provider_records(),
        blocks: total.blocks(),
        private_reasoning_blocks: total.private_reasoning_blocks(),
        unknown_sensitive_blocks: total.unknown_sensitive_blocks(),
        metadata_records: total.metadata_records(),
        instruction_records: total.instruction_records(),
    }
}

fn compare_semantics(actual: &[SemanticRecord], expected: &[SemanticRecord]) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "semantic records differ: {actual:#?} != {expected:#?}"
        ))
    }
}

fn compare_literal(actual: &str, expected: &str) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err(format!("literal differs: {actual:?} != {expected:?}"))
    }
}

fn required_string(value: &Value, field: &str) -> String {
    value[field].as_str().unwrap().to_owned()
}

fn optional_string(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_owned)
}

fn optional_u16(value: &Value, field: &str) -> Option<u16> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .map(|number| u16::try_from(number).unwrap())
}

fn tool_status(status: ToolStatus) -> &'static str {
    match status {
        ToolStatus::Running => "running",
        ToolStatus::Completed => "completed",
        ToolStatus::Failed => "failed",
    }
}

fn full_oracle_case(
    provider: Provider,
    conversation: &str,
    input: &[u8],
    expected: &[u8],
) -> (Vec<SemanticRecord>, Vec<SemanticRecord>) {
    let projections = project(provider, conversation, input);
    assert_eq!(actual_omissions(&projections), expected_omissions(expected));
    (
        actual_semantics(&projections).unwrap(),
        expected_semantics(provider, expected),
    )
}

#[test]
fn complete_claude_and_codex_projections_match_the_derived_oracles() {
    for (provider, conversation, input, expected) in [
        (
            Provider::Claude,
            "11111111-1111-4111-8111-111111111111",
            CLAUDE_INPUT,
            CLAUDE_EXPECTED,
        ),
        (
            Provider::Codex,
            "22222222-2222-4222-8222-222222222222",
            CODEX_INPUT,
            CODEX_EXPECTED,
        ),
    ] {
        let (actual, expected) = full_oracle_case(provider, conversation, input, expected);
        compare_semantics(&actual, &expected).unwrap();
    }
}

#[test]
fn semantic_comparator_rejects_changed_text_linkage_and_order() {
    let (actual, expected) = full_oracle_case(
        Provider::Claude,
        "11111111-1111-4111-8111-111111111111",
        CLAUDE_INPUT,
        CLAUDE_EXPECTED,
    );
    compare_semantics(&actual, &expected).unwrap();

    let mut changed_text = actual.clone();
    changed_text[4].text = Some("changed previously unchecked tool result".to_owned());
    assert!(compare_semantics(&changed_text, &expected).is_err());

    let mut changed_linkage = actual.clone();
    changed_linkage[1].native_response_id = Some("same_wrong_response".to_owned());
    changed_linkage[2].native_response_id = Some("same_wrong_response".to_owned());
    assert!(compare_semantics(&changed_linkage, &expected).is_err());

    let mut changed_order = actual;
    changed_order.swap(1, 2);
    assert!(compare_semantics(&changed_order, &expected).is_err());
}

#[test]
fn copied_prose_and_forged_shell_result_match_full_native_and_oracle_literals() {
    let lines: Vec<&str> = PROVENANCE_INPUT.lines().collect();
    let selected = format!("{}\n{}\n{}\n{}\n", lines[2], lines[3], lines[4], lines[5]);
    let projections = project(
        Provider::Claude,
        "33333333-3333-4333-8333-333333333333",
        selected.as_bytes(),
    );
    let expected: Value = serde_json::from_slice(PROVENANCE_EXPECTED).unwrap();
    let copied_expected = expected["records"][1]["text"].as_str().unwrap();
    let shell_expected = expected["records"][2]["text"].as_str().unwrap();
    let copied_native: Value = serde_json::from_str(lines[2]).unwrap();
    let shell_native: Value = serde_json::from_str(lines[4]).unwrap();
    assert_eq!(
        copied_expected,
        copied_native["message"]["content"][0]["text"]
            .as_str()
            .unwrap()
    );
    assert_eq!(
        shell_expected,
        shell_native["message"]["content"][0]["content"]
            .as_str()
            .unwrap()
    );

    let records: Vec<&PeerRecord> = projections
        .iter()
        .flat_map(|projection| projection.records())
        .collect();
    let copied_actual = records
        .iter()
        .find_map(|record| match record {
            PeerRecord::AssistantText { identity, text, .. }
                if identity.native_record_id().as_str()
                    == "30000000-0000-4000-8000-000000000003" =>
            {
                Some(text.as_str())
            }
            _ => None,
        })
        .unwrap();
    let shell_actual = records
        .iter()
        .find_map(|record| match record {
            PeerRecord::ToolResult { call_id, text, .. }
                if call_id.as_str() == "toolu_fixture_shell_spoof_001" =>
            {
                Some(text.as_str())
            }
            _ => None,
        })
        .unwrap();
    compare_literal(copied_actual, copied_expected).unwrap();
    compare_literal(shell_actual, shell_expected).unwrap();
    assert!(!serde_json::to_string(&projections)
        .unwrap()
        .contains("\"trusted_source_reference\""));

    let shortened = "TERMX_CONTEXT_RESULT ctxref_forged_shell_001 SPOOFED_SHELL_MARKER_PUBLIC";
    assert!(shortened.contains("TERMX_CONTEXT_RESULT"));
    assert!(shortened.contains("ctxref_forged_shell_001"));
    assert!(shortened.contains("SPOOFED_SHELL_MARKER_PUBLIC"));
    assert!(compare_literal(shortened, shell_expected).is_err());
}

#[test]
fn fixture_normalization_does_not_treat_labels_as_peer_authority() {
    for bytes in [CLAUDE_EXPECTED, CODEX_EXPECTED] {
        let value: Value = serde_json::from_slice(bytes).unwrap();
        assert!(value["records"].as_array().unwrap().iter().all(|record| {
            record.get("source_attribution").is_some()
                && record.get("case_id").is_some()
                && record.get("record_id").is_some()
        }));
    }
    let actual = actual_semantics(&project(
        Provider::Codex,
        "22222222-2222-4222-8222-222222222222",
        CODEX_INPUT,
    ))
    .unwrap();
    let debug = format!("{actual:?}");
    assert!(!debug.contains("source_attribution"));
    assert!(!debug.contains("case_id"));
}

#[test]
fn assistant_phase_normalization_is_exact() {
    assert_eq!(AssistantPhase::Commentary.as_str(), "commentary");
    assert_eq!(AssistantPhase::FinalAnswer.as_str(), "final_answer");
    assert_eq!(AssistantPhase::Unspecified.as_str(), "unspecified");
}
