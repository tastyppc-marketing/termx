use termx_swarm_context::{
    IdentityError, JsonlScanner, NativeId, OmissionCounts, OwnerRecord, PeerBatch, PeerBatchPush,
    PeerRecord, Provider, ProviderParser, ToolStatus, UnavailableReason, MAX_ENCODED_PEER_BYTES,
    MAX_PROJECTED_BLOCKS,
};

const CLAUDE: &[u8] =
    include_bytes!("fixtures/adversarial/original/fixtures/claude-adversarial.jsonl");
const CODEX: &[u8] =
    include_bytes!("fixtures/adversarial/original/fixtures/codex-adversarial.jsonl");
const PROVENANCE: &str =
    include_str!("fixtures/adversarial/original/fixtures/provenance-adversarial.jsonl");

fn project(
    provider: Provider,
    conversation: &str,
    bytes: &[u8],
) -> Vec<termx_swarm_context::PeerProjection> {
    let mut parser = ProviderParser::new(provider, conversation).unwrap();
    let mut scanner = JsonlScanner::new(0);
    let mut projected = Vec::new();
    scanner
        .push_chunk(bytes, |item| projected.push(parser.project_peer(item)))
        .unwrap();
    projected
}

fn flattened(projections: &[termx_swarm_context::PeerProjection]) -> Vec<&PeerRecord> {
    projections
        .iter()
        .flat_map(|projection| projection.records().iter())
        .collect()
}

fn summed_omissions(projections: &[termx_swarm_context::PeerProjection]) -> OmissionCounts {
    projections
        .iter()
        .fold(OmissionCounts::default(), |mut sum, projection| {
            sum.checked_add_assign(projection.omissions()).unwrap();
            sum
        })
}

#[test]
fn claude_peer_projection_preserves_blocks_and_excludes_private_content() {
    let projections = project(
        Provider::Claude,
        "11111111-1111-4111-8111-111111111111",
        CLAUDE,
    );
    let records = flattened(&projections);
    assert_eq!(records.len(), 7);

    let text_records: Vec<_> = records
        .iter()
        .filter_map(|record| match record {
            PeerRecord::AssistantText { identity, text, .. } => Some((identity, text)),
            _ => None,
        })
        .collect();
    assert_eq!(text_records.len(), 2);
    assert_eq!(
        text_records[0].0.native_response_id().unwrap().as_str(),
        text_records[1].0.native_response_id().unwrap().as_str()
    );
    assert_ne!(
        text_records[0].0.native_record_id().as_str(),
        text_records[1].0.native_record_id().as_str()
    );
    assert_eq!(text_records[0].1, "CLAUDE_PUBLIC_TEXT_ALPHA");
    assert_eq!(text_records[1].1, "CLAUDE_PUBLIC_TEXT_BETA");

    let call = records
        .iter()
        .find_map(|record| match record {
            PeerRecord::ToolCall {
                call_id,
                tool_name,
                status,
                ..
            } => Some((call_id, tool_name, status)),
            _ => None,
        })
        .unwrap();
    assert_eq!(call.0.as_str(), "toolu_fixture_claude_001");
    assert_eq!(call.1, "SyntheticLookup");
    assert_eq!(*call.2, ToolStatus::Running);
    assert!(matches!(records[5], PeerRecord::CompactionBoundary { .. }));
    assert!(matches!(records[6], PeerRecord::CompactionSummary { .. }));

    let encoded = serde_json::to_string(&projections).unwrap();
    for private in [
        "SECRET_CLAUDE_THINKING_ALPHA",
        "SECRET_CLAUDE_THINKING_SIGNATURE",
        "SECRET_CLAUDE_REDACTED_THINKING",
        "SECRET_CLAUDE_UNKNOWN_SENSITIVE",
        "SYNTHETIC_SAFE_QUERY",
    ] {
        assert!(!encoded.contains(private), "peer output leaked {private}");
    }
    assert!(!encoded.contains("\"summary\":"));

    let omissions = summed_omissions(&projections);
    assert_eq!(omissions.provider_records(), 3);
    assert_eq!(omissions.blocks(), 3);
    assert_eq!(omissions.private_reasoning_blocks(), 2);
    assert_eq!(omissions.unknown_sensitive_blocks(), 1);
    let omission_json = serde_json::to_string(&omissions).unwrap();
    assert!(!omission_json.contains("native"));
    assert!(!omission_json.contains("sha256"));
    assert!(!omission_json.contains("range"));
}

#[test]
fn owner_projection_is_typed_separately_and_retains_owner_only_fields() {
    let mut parser =
        ProviderParser::new(Provider::Claude, "11111111-1111-4111-8111-111111111111").unwrap();
    let lines: Vec<&str> = std::str::from_utf8(CLAUDE).unwrap().lines().collect();
    let thinking = parser.project_owner_line(lines[3]).unwrap();
    assert!(matches!(
        thinking.records().first(),
        Some(OwnerRecord::Thinking { text, .. }) if text == "SECRET_CLAUDE_THINKING_ALPHA"
    ));
    let call = parser.project_owner_line(lines[6]).unwrap();
    assert!(matches!(
        call.records().first(),
        Some(OwnerRecord::ToolCall { input_json, .. }) if input_json.contains("SYNTHETIC_SAFE_QUERY")
    ));

    let peer = project(
        Provider::Claude,
        "11111111-1111-4111-8111-111111111111",
        format!("{}\n", lines[3]).as_bytes(),
    );
    assert!(peer[0].records().is_empty());
    assert_eq!(peer[0].omissions().private_reasoning_blocks(), 1);
    assert_eq!(thinking.provider(), Provider::Claude);
    assert_eq!(peer[0].provider(), Provider::Claude);
}

#[test]
fn owner_entry_does_not_inherit_the_peer_record_byte_limit() {
    let text = "o".repeat(termx_swarm_context::MAX_RECORD_BYTES + 1);
    let line = serde_json::json!({
        "sessionId": "session",
        "uuid": "record",
        "type": "user",
        "message": {"role": "user", "content": text}
    })
    .to_string();
    let mut parser = ProviderParser::new(Provider::Claude, "session").unwrap();
    let owner = parser.project_owner_line(&line).unwrap();
    assert!(matches!(
        owner.records().first(),
        Some(OwnerRecord::UserText { text }) if text.len() == termx_swarm_context::MAX_RECORD_BYTES + 1
    ));

    let mut scanner = JsonlScanner::new(0);
    let mut peer = Vec::new();
    scanner
        .push_chunk(format!("{line}\n").as_bytes(), |item| {
            peer.push(parser.project_peer(item))
        })
        .unwrap();
    assert!(matches!(
        peer[0].records().first(),
        Some(PeerRecord::Unavailable {
            reason: UnavailableReason::RecordTooLarge,
            ..
        })
    ));
}

#[test]
fn owner_entry_does_not_inherit_the_peer_projected_block_limit() {
    let blocks: Vec<_> = (0..=MAX_PROJECTED_BLOCKS)
        .map(|index| serde_json::json!({"type":"text", "text":format!("owner-{index}")}))
        .collect();
    let line = serde_json::json!({
        "sessionId":"session",
        "uuid":"record",
        "type":"assistant",
        "message":{"id":"response", "type":"message", "role":"assistant", "content":blocks}
    })
    .to_string();
    let mut owner_parser = ProviderParser::new(Provider::Claude, "session").unwrap();
    let owner = owner_parser.project_owner_line(&line).unwrap();
    assert_eq!(owner.records().len(), MAX_PROJECTED_BLOCKS + 1);

    let mut peer_parser = ProviderParser::new(Provider::Claude, "session").unwrap();
    let mut peer = Vec::new();
    JsonlScanner::new(0)
        .push_chunk(format!("{line}\n").as_bytes(), |item| {
            peer.push(peer_parser.project_peer(item));
        })
        .unwrap();
    assert!(matches!(
        peer[0].records().first(),
        Some(PeerRecord::Unavailable {
            reason: UnavailableReason::TooManyProjectedBlocks,
            ..
        })
    ));
}

#[test]
fn codex_owner_tool_input_keeps_the_native_json_string_without_double_encoding() {
    let mut parser = ProviderParser::new(Provider::Codex, "session").unwrap();
    parser
        .project_owner_line(r#"{"type":"session_meta","payload":{"id":"session"}}"#)
        .unwrap();
    let owner = parser
        .project_owner_line(
            r#"{"type":"response_item","payload":{"type":"custom_tool_call","id":"item","status":"completed","call_id":"call","name":"Synthetic","input":"{\"target\":\"owner-only\"}"}}"#,
        )
        .unwrap();
    assert!(matches!(
        owner.records().first(),
        Some(OwnerRecord::ToolCall { input_json, .. }) if input_json == r#"{"target":"owner-only"}"#
    ));
}

#[test]
fn codex_requires_private_session_evidence_and_allowlists_only_sanctioned_shapes() {
    let projections = project(
        Provider::Codex,
        "22222222-2222-4222-8222-222222222222",
        CODEX,
    );
    let records = flattened(&projections);
    assert_eq!(records.len(), 5);
    assert!(
        matches!(records[0], PeerRecord::UserText { text, .. } if text == "CODEX_PUBLIC_USER_ALPHA")
    );
    assert!(
        matches!(records[1], PeerRecord::AssistantText { phase, .. } if phase.as_str() == "commentary")
    );
    assert!(matches!(
        records[2],
        PeerRecord::ToolCall { tool_name, status: ToolStatus::Completed, .. }
            if tool_name == "SyntheticInspect"
    ));
    assert!(
        matches!(records[4], PeerRecord::AssistantText { phase, .. } if phase.as_str() == "final_answer")
    );

    let encoded = serde_json::to_string(&projections).unwrap();
    for private in [
        "SECRET_CODEX_DEVELOPER_INSTRUCTION",
        "SECRET_CODEX_SYSTEM_INSTRUCTION",
        "SECRET_CODEX_REASONING_SUMMARY",
        "SECRET_CODEX_ENCRYPTED_REASONING",
        "SYNTHETIC_SAFE_TARGET",
        "C:\\\\synthetic\\\\codex-project",
    ] {
        assert!(!encoded.contains(private), "peer output leaked {private}");
    }
    assert!(!encoded.contains("session_meta"));
    assert!(!encoded.contains("\"summary\":"));

    let omissions = summed_omissions(&projections);
    assert_eq!(omissions.metadata_records(), 1);
    assert_eq!(omissions.instruction_records(), 2);
    assert_eq!(omissions.private_reasoning_blocks(), 1);
}

#[test]
fn unknown_codex_tool_status_does_not_fall_back_to_running() {
    let input = b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"session\"}}\n{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"id\":\"item\",\"status\":\"vendor_unknown\",\"call_id\":\"call\",\"name\":\"Synthetic\",\"input\":\"{}\"}}\n";
    let projected = project(Provider::Codex, "session", input);
    assert!(matches!(
        projected[1].records().first(),
        Some(PeerRecord::Unavailable {
            reason: UnavailableReason::UnsupportedProviderShape,
            ..
        })
    ));
}

#[test]
fn missing_or_conflicting_conversation_evidence_is_explicit_and_sticky() {
    let response = b"{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"m1\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hello\"}]}}\n";
    let before_header = project(Provider::Codex, "expected", response);
    assert!(matches!(
        before_header[0].records().first(),
        Some(PeerRecord::Unavailable {
            reason: UnavailableReason::MissingConversationIdentity,
            ..
        })
    ));

    let input = [
        b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"wrong\"}}\n".as_slice(),
        response,
    ]
    .concat();
    let conflict = project(Provider::Codex, "expected", &input);
    assert!(conflict.iter().all(|projection| matches!(
        projection.records().first(),
        Some(PeerRecord::Unavailable {
            reason: UnavailableReason::ConflictingConversationIdentity,
            ..
        })
    )));
}

#[test]
fn owner_identity_observations_cannot_grant_or_poison_peer_projection() {
    let response = b"{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"m1\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"peer\"}]}}\n";
    let mut parser = ProviderParser::new(Provider::Codex, "session").unwrap();
    parser
        .project_owner_line(r#"{"type":"session_meta","payload":{"id":"wrong","id":"session"}}"#)
        .unwrap();
    let mut scanner = JsonlScanner::new(0);
    let mut projected = Vec::new();
    scanner
        .push_chunk(response, |item| {
            projected.push(parser.project_peer(item));
        })
        .unwrap();
    assert!(matches!(
        projected[0].records().first(),
        Some(PeerRecord::Unavailable {
            reason: UnavailableReason::MissingConversationIdentity,
            ..
        })
    ));

    let mut parser = ProviderParser::new(Provider::Claude, "session").unwrap();
    assert!(parser
        .project_owner_line(
            r#"{"sessionId":"wrong","uuid":"owner","type":"user","message":{"role":"user","content":"owner"}}"#,
        )
        .is_err());
    let peer = b"{\"sessionId\":\"session\",\"uuid\":\"peer\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"peer\"}}\n";
    let mut projected = Vec::new();
    JsonlScanner::new(0)
        .push_chunk(peer, |item| {
            projected.push(parser.project_peer(item));
        })
        .unwrap();
    assert!(matches!(
        projected[0].records().first(),
        Some(PeerRecord::UserText { text, .. }) if text == "peer"
    ));
}

#[test]
fn conflicting_identity_cannot_be_repaired_by_a_later_matching_header_or_record() {
    let input = b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"wrong\"}}\n{\"type\":\"session_meta\",\"payload\":{\"id\":\"expected\"}}\n{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"m1\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"must stay unavailable\"}]}}\n";
    let projected = project(Provider::Codex, "expected", input);
    assert!(projected.iter().all(|projection| matches!(
        projection.records().first(),
        Some(PeerRecord::Unavailable {
            reason: UnavailableReason::ConflictingConversationIdentity,
            ..
        })
    )));

    let claude = b"{\"sessionId\":\"wrong\",\"uuid\":\"one\",\"type\":\"user\",\"message\":{\"content\":\"wrong\"}}\n{\"sessionId\":\"expected\",\"uuid\":\"two\",\"type\":\"user\",\"message\":{\"content\":\"must stay unavailable\"}}\n";
    let projected = project(Provider::Claude, "expected", claude);
    assert!(projected.iter().all(|projection| matches!(
        projection.records().first(),
        Some(PeerRecord::Unavailable {
            reason: UnavailableReason::ConflictingConversationIdentity,
            ..
        })
    )));
}

#[test]
fn claude_meta_user_records_are_aggregated_as_omissions_without_content() {
    let input = b"{\"sessionId\":\"session\",\"uuid\":\"meta\",\"type\":\"user\",\"isMeta\":true,\"message\":{\"content\":\"PRIVATE_HOOK_OUTPUT\"}}\n";
    let projected = project(Provider::Claude, "session", input);
    assert!(projected[0].records().is_empty());
    assert_eq!(projected[0].omissions().metadata_records(), 1);
    assert!(!serde_json::to_string(&projected)
        .unwrap()
        .contains("PRIVATE_HOOK_OUTPUT"));
}

#[test]
fn tool_results_preserve_each_sanctioned_text_block_in_order() {
    let codex = b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"session\"}}\n{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call_output\",\"id\":\"item\",\"call_id\":\"call\",\"output\":[{\"type\":\"input_text\",\"text\":\"first\"},{\"type\":\"input_text\",\"text\":\"second\"}]}}\n";
    let projected = project(Provider::Codex, "session", codex);
    let texts: Vec<_> = projected[1]
        .records()
        .iter()
        .map(|record| match record {
            PeerRecord::ToolResult { text, .. } => text.as_str(),
            other => panic!("unexpected record: {other:?}"),
        })
        .collect();
    assert_eq!(texts, ["first", "second"]);

    let claude = b"{\"sessionId\":\"session\",\"uuid\":\"record\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"call\",\"content\":[{\"type\":\"text\",\"text\":\"first\"},{\"type\":\"text\",\"text\":\"second\"}],\"is_error\":false}]}}\n";
    let projected = project(Provider::Claude, "session", claude);
    let texts: Vec<_> = projected[0]
        .records()
        .iter()
        .map(|record| match record {
            PeerRecord::ToolResult { text, .. } => text.as_str(),
            other => panic!("unexpected record: {other:?}"),
        })
        .collect();
    assert_eq!(texts, ["first", "second"]);
}

#[test]
fn provider_projection_is_identical_across_every_byte_chunk_boundary() {
    fn encoded(chunks: &[&[u8]]) -> String {
        let mut parser =
            ProviderParser::new(Provider::Claude, "11111111-1111-4111-8111-111111111111").unwrap();
        let mut scanner = JsonlScanner::new(31);
        let mut projections = Vec::new();
        for chunk in chunks {
            scanner
                .push_chunk(chunk, |item| projections.push(parser.project_peer(item)))
                .unwrap();
        }
        serde_json::to_string(&projections).unwrap()
    }

    let whole = encoded(&[CLAUDE]);
    let chunks: Vec<&[u8]> = CLAUDE.chunks(1).collect();
    assert_eq!(encoded(&chunks), whole);
}

#[test]
fn structural_native_id_validation_is_bounded_but_does_not_claim_provider_syntax() {
    assert!(NativeId::new("synthetic_fixture_id-1:part").is_ok());
    assert_eq!(NativeId::new(""), Err(IdentityError::Empty));
    assert_eq!(
        NativeId::new("has space"),
        Err(IdentityError::InvalidCharacter)
    );
    assert_eq!(NativeId::new("a".repeat(257)), Err(IdentityError::TooLong));

    let missing_id = b"{\"sessionId\":\"session\",\"type\":\"assistant\",\"message\":{\"id\":\"response\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}\n";
    let projected = project(Provider::Claude, "session", missing_id);
    assert!(matches!(
        projected[0].records().first(),
        Some(PeerRecord::Unavailable {
            reason: UnavailableReason::MissingNativeId,
            ..
        })
    ));

    let malformed_id = b"{\"sessionId\":\"session\",\"uuid\":\"has space\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n";
    let projected = project(Provider::Claude, "session", malformed_id);
    assert!(matches!(
        projected[0].records().first(),
        Some(PeerRecord::Unavailable {
            reason: UnavailableReason::InvalidNativeId,
            ..
        })
    ));
}

#[test]
fn sidechain_and_unknown_provider_shapes_are_unavailable_without_fallback() {
    let input = b"{\"sessionId\":\"session\",\"uuid\":\"one\",\"isSidechain\":true,\"type\":\"assistant\",\"message\":{\"id\":\"response\",\"content\":[{\"type\":\"text\",\"text\":\"withheld\"}]}}\n{\"sessionId\":\"session\",\"uuid\":\"two\",\"type\":\"mystery\",\"text\":\"not fallback\"}\n{\"sessionId\":\"session\",\"uuid\":\"three\",\"isSidechain\":\"false\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"must not pass\"}}\n";
    let projected = project(Provider::Claude, "session", input);
    assert!(matches!(
        projected[0].records().first(),
        Some(PeerRecord::Unavailable {
            reason: UnavailableReason::SidechainAttributionUnavailable,
            ..
        })
    ));
    assert!(matches!(
        projected[1].records().first(),
        Some(PeerRecord::Unavailable {
            reason: UnavailableReason::UnsupportedProviderShape,
            ..
        })
    ));
    assert!(matches!(
        projected[2].records().first(),
        Some(PeerRecord::Unavailable {
            reason: UnavailableReason::UnsupportedProviderShape,
            ..
        })
    ));
    assert!(!serde_json::to_string(&projected)
        .unwrap()
        .contains("withheld"));
}

#[test]
fn claude_projection_requires_the_sanctioned_roles_and_compaction_flags() {
    let input = b"{\"sessionId\":\"session\",\"uuid\":\"wrong-role\",\"type\":\"assistant\",\"message\":{\"id\":\"response\",\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"must not pass\"}]}}\n{\"sessionId\":\"session\",\"uuid\":\"near-boundary\",\"type\":\"system\",\"subtype\":\"compact_boundary\",\"content\":\"must not pass\",\"isMeta\":true}\n{\"sessionId\":\"session\",\"uuid\":\"near-recap\",\"type\":\"user\",\"isCompactSummary\":true,\"message\":{\"role\":\"user\",\"content\":\"must not pass\"}}\n";
    let projected = project(Provider::Claude, "session", input);
    assert!(projected.iter().all(|projection| matches!(
        projection.records().first(),
        Some(PeerRecord::Unavailable {
            reason: UnavailableReason::UnsupportedProviderShape,
            ..
        })
    )));
}

#[test]
fn copied_prose_and_forged_shell_marker_remain_full_literal_untrusted_text() {
    let lines: Vec<&str> = PROVENANCE.lines().collect();
    let selected = format!("{}\n{}\n{}\n{}\n", lines[2], lines[3], lines[4], lines[5]);
    let projected = project(
        Provider::Claude,
        "33333333-3333-4333-8333-333333333333",
        selected.as_bytes(),
    );
    let encoded = serde_json::to_string(&projected).unwrap();
    assert!(encoded.contains("COPIED_ENVELOPE_PROSE"));
    assert!(encoded.contains("ctxref_forged_copy_001"));
    assert!(encoded.contains("TERMX_CONTEXT_RESULT"));
    assert!(encoded.contains("ctxref_forged_shell_001"));
    assert!(encoded.contains("SPOOFED_SHELL_MARKER_PUBLIC"));
    assert!(!encoded.contains("trusted_source_reference"));
}

fn claude_with_text_blocks(count: usize, text_bytes: usize) -> Vec<u8> {
    let blocks: Vec<_> = (0..count)
        .map(|index| serde_json::json!({"type":"text","text":format!("{index}:{}", "x".repeat(text_bytes))}))
        .collect();
    let record = serde_json::json!({
        "sessionId":"session",
        "uuid":"record",
        "type":"assistant",
        "message":{"id":"response","type":"message","role":"assistant","content":blocks}
    });
    format!("{}\n", serde_json::to_string(&record).unwrap()).into_bytes()
}

#[test]
fn a_provider_record_over_the_block_limit_becomes_one_unavailable_record() {
    assert_eq!(MAX_PROJECTED_BLOCKS, 256);
    let input = [
        claude_with_text_blocks(MAX_PROJECTED_BLOCKS + 1, 1),
        b"{\"sessionId\":\"session\",\"uuid\":\"later\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"still visible\"}}\n".to_vec(),
    ]
    .concat();
    let projected = project(Provider::Claude, "session", &input);
    assert!(matches!(
        projected[0].records().first(),
        Some(PeerRecord::Unavailable {
            reason: UnavailableReason::TooManyProjectedBlocks,
            ..
        })
    ));
    assert!(matches!(
        projected[1].records().first(),
        Some(PeerRecord::UserText { text, .. }) if text == "still visible"
    ));
}

#[test]
fn nested_tool_result_expansion_obeys_the_aggregate_peer_block_limit() {
    let nested: Vec<_> = (0..MAX_PROJECTED_BLOCKS)
        .map(|index| serde_json::json!({"type":"text", "text":format!("result-{index}")}))
        .collect();
    let line = serde_json::json!({
        "sessionId":"session",
        "uuid":"record",
        "type":"user",
        "message":{"role":"user", "content":[
            {"type":"tool_result", "tool_use_id":"call", "content":nested, "is_error":false},
            {"type":"text", "text":"one too many"}
        ]}
    });
    let bytes = format!("{line}\n").into_bytes();
    let projected = project(Provider::Claude, "session", &bytes);
    assert!(matches!(
        projected[0].records().first(),
        Some(PeerRecord::Unavailable {
            reason: UnavailableReason::TooManyProjectedBlocks,
            ..
        })
    ));
    assert_eq!(projected[0].records().len(), 1);
}

#[test]
fn bounded_batch_never_clips_a_record_or_exceeds_its_complete_encoding_limit() {
    assert_eq!(MAX_ENCODED_PEER_BYTES, 2 * 1024 * 1024);
    let one = project(
        Provider::Claude,
        "session",
        &claude_with_text_blocks(1, 900_000),
    )
    .pop()
    .unwrap();
    let two = one.clone();
    let three = one.clone();
    let mut batch = PeerBatch::new();
    assert_eq!(batch.try_push(one), PeerBatchPush::Accepted);
    assert_eq!(batch.try_push(two), PeerBatchPush::Accepted);
    let rejected = match batch.try_push(three) {
        PeerBatchPush::Full(projection) => projection,
        other => panic!("expected intact full result, got {other:?}"),
    };
    assert_eq!(rejected.records().len(), 1);
    assert!(batch.encoded_len() <= MAX_ENCODED_PEER_BYTES);
    assert_eq!(batch.projected_blocks(), 2);
    assert_eq!(
        batch.encoded_len(),
        serde_json::to_vec(&batch).unwrap().len()
    );
}

#[test]
fn metadata_only_batch_entries_do_not_consume_block_count_and_full_rolls_back() {
    let mut metadata_parser = ProviderParser::new(Provider::Codex, "session").unwrap();
    let metadata = b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"session\"}}\n";
    let mut metadata_projection = Vec::new();
    JsonlScanner::new(0)
        .push_chunk(metadata, |item| {
            metadata_projection.push(metadata_parser.project_peer(item));
        })
        .unwrap();
    let metadata_projection = metadata_projection.pop().unwrap();
    assert!(metadata_projection.records().is_empty());

    let full_projection = project(
        Provider::Claude,
        "session",
        &claude_with_text_blocks(MAX_PROJECTED_BLOCKS, 1),
    )
    .pop()
    .unwrap();
    let rejected = project(Provider::Claude, "session", &claude_with_text_blocks(1, 1))
        .pop()
        .unwrap();
    let mut batch = PeerBatch::new();
    assert_eq!(batch.try_push(metadata_projection), PeerBatchPush::Accepted);
    assert_eq!(batch.projected_blocks(), 0);
    assert_eq!(batch.try_push(full_projection), PeerBatchPush::Accepted);
    assert_eq!(batch.projected_blocks(), MAX_PROJECTED_BLOCKS);
    let before_len = batch.encoded_len();
    let before_entries = batch.projections().len();
    assert!(matches!(batch.try_push(rejected), PeerBatchPush::Full(_)));
    assert_eq!(batch.projected_blocks(), MAX_PROJECTED_BLOCKS);
    assert_eq!(batch.encoded_len(), before_len);
    assert_eq!(batch.projections().len(), before_entries);
}

#[test]
fn public_byte_offsets_serialize_as_exact_decimal_strings() {
    let input = b"{\"sessionId\":\"session\",\"uuid\":\"record\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"text\"}}\n";
    let projected = project(Provider::Claude, "session", input);
    let encoded = serde_json::to_value(&projected).unwrap();
    let source = &encoded[0]["records"][0]["identity"]["source"];
    assert_eq!(source["start"], "0");
    assert_eq!(source["end"], input.len().to_string());
}
