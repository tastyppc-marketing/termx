use std::collections::BTreeSet;

use termx_host::swarm::{
    response::{
        inspect_peer_response, peer_response_frame_limit, PeerOutcomeKind, ResponseError,
        CONTROL_RESPONSE_FRAME_BYTES, RESPONSE_WRAPPER_BYTES,
    },
    rpc::{
        ErrorCode, ErrorPayload, Outcome, PeerOperation, ResponseBody, ServerFrame, ServerMessage,
        SWARM_RPC_VERSION,
    },
};
use termx_swarm_core::{
    error::StoreError,
    model::{
        AcknowledgementResult, AttachmentRecord, AttachmentView, FrozenRecipient, GroupId,
        LaunchId, MailboxEntry, MailboxNavigation, MailboxPage, MembershipAvailability,
        MembershipView, MessageCommitOutcome, MessageId, MessageRecord, MessageStateEntry,
        NavigationPosition, NavigationScope, OutgoingPage, PeerId, PeerPage, PeerView,
        ReceiptRecord, RecipientState, Revision, SelfView, SourceAttachment, SourceAvailability,
        SourceId, SourceReferenceId, SourceSummary, StatusRecord, ThreadEntry, ThreadPage,
        MAX_ACTIVE_SOURCES_PER_BINDING, MAX_ATTACHMENTS_PER_MESSAGE, MAX_MAILBOX_PAGE_BYTES,
        MAX_MAILBOX_PAGE_ITEMS, MAX_MESSAGE_BODY_BYTES, MAX_METADATA_PAGE_BYTES,
        MAX_METADATA_PAGE_ITEMS, MAX_RECIPIENTS_PER_MESSAGE,
    },
};

fn peer(value: u128) -> PeerId {
    PeerId::parse(&format!("p_{value:032x}")).unwrap()
}

fn launch(value: u128) -> LaunchId {
    LaunchId::parse(&format!("l_{value:032x}")).unwrap()
}

fn group(value: u128) -> GroupId {
    GroupId::parse(&format!("g_{value:032x}")).unwrap()
}

fn message_id(value: u128) -> MessageId {
    MessageId::parse(&format!("m_{value:032x}")).unwrap()
}

fn source(value: u128) -> SourceId {
    SourceId::parse(&format!("src_{value:032x}")).unwrap()
}

fn source_reference(value: u128) -> SourceReferenceId {
    SourceReferenceId::parse(&format!("s_{value:032x}")).unwrap()
}

fn revision(value: u64) -> Revision {
    Revision::new(value).unwrap()
}

fn status_record(group_id: &GroupId, peer_id: &PeerId, status: Option<&str>) -> StatusRecord {
    StatusRecord {
        group_id: group_id.clone(),
        peer_id: peer_id.clone(),
        binding_revision: revision(9_007_199_254_740_993),
        status: status.map(str::to_owned),
        status_revision: revision(i64::MAX as u64),
        updated_at_millis: i64::MIN,
    }
}

fn attachment_record(value: u128) -> AttachmentRecord {
    AttachmentRecord {
        source_reference_id: source_reference(value),
        source_id: source(value),
        source_kind: "codex_transcript".to_owned(),
        owner_peer_id: peer(value),
        snapshot_reference: Some("turn-你-𝄞".to_owned()),
    }
}

fn message(value: u128, attachments: Vec<AttachmentRecord>) -> MessageRecord {
    MessageRecord {
        message_id: message_id(value),
        group_id: group(1),
        group_sequence: value as u64,
        sender_peer_id: peer(1),
        sender_binding_revision: revision(1),
        client_key: format!("client-{value}"),
        body: "quoted \" body \\ newline \\n Unicode 你𝄞".to_owned(),
        topic: Some("topic".to_owned()),
        reply_to: Some(message_id(99)),
        attachments,
    }
}

fn receipt(value: u128) -> ReceiptRecord {
    ReceiptRecord {
        message_id: message_id(value),
        recipient_peer_id: peer(2),
        binding_revision: revision(2),
        generation: revision(3),
        fetched_at_millis: Some(i64::MIN),
        acknowledged_at_millis: None,
    }
}

fn position(scope: NavigationScope, after_sequence: u64) -> NavigationPosition {
    serde_json::from_value(serde_json::json!({
        "group_id": group(1),
        "peer_id": peer(2),
        "binding_revision": 1,
        "policy_revision": 2,
        "scope": scope,
        "after_sequence": after_sequence,
    }))
    .unwrap()
}

fn frame(correlation_id: &str, outcome: Outcome) -> Vec<u8> {
    serde_json::to_vec(&ServerFrame {
        version: SWARM_RPC_VERSION,
        message: ServerMessage::Response(Box::new(ResponseBody {
            correlation_id: correlation_id.to_owned(),
            outcome,
        })),
    })
    .unwrap()
}

fn assert_success(operation: PeerOperation, outcome: Outcome, expected_kind: PeerOutcomeKind) {
    let expected = serde_json::to_value(&outcome).unwrap()["payload"].clone();
    let bytes = frame("corr_9", outcome);
    let inspected = inspect_peer_response(&bytes, "corr_9", &operation).unwrap();
    assert_eq!(inspected.outcome_kind(), expected_kind);
    assert!(!inspected.is_error());
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(inspected.payload_json()).unwrap(),
        expected
    );
    let start = bytes.as_ptr() as usize;
    let payload = inspected.payload_json().as_ptr() as usize;
    assert!((start..start + bytes.len()).contains(&payload));
}

#[test]
fn typed_self_view_is_borrowed_and_correlated() {
    let view = SelfView {
        peer_id: peer(1),
        binding_revision: Revision::new(9_007_199_254_740_993).unwrap(),
        launch_id: launch(2),
        harness: "codex".to_owned(),
        model_metadata: Some("gpt-5".to_owned()),
        is_live: true,
        memberships: Vec::new(),
        next_after_group: None,
        inventory_revision: Revision::new(i64::MAX as u64).unwrap(),
        run_revision: None,
    };
    let expected_payload = serde_json::to_value(&view).unwrap();
    let bytes = frame("corr_1", Outcome::SelfView(view));
    let operation = PeerOperation::WhoAmI {
        after_group: None,
        max_items: 128,
    };

    let inspected = inspect_peer_response(&bytes, "corr_1", &operation).unwrap();
    assert_eq!(inspected.outcome_kind(), PeerOutcomeKind::SelfView);
    assert!(!inspected.is_error());
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(inspected.payload_json()).unwrap(),
        expected_payload
    );
    let frame_start = bytes.as_ptr() as usize;
    let payload_start = inspected.payload_json().as_ptr() as usize;
    assert!((frame_start..frame_start + bytes.len()).contains(&payload_start));
}

#[test]
fn all_nine_typed_peer_success_outcomes_match_their_operations() {
    let group_id = group(1);
    let sender = peer(1);
    let recipient = peer(2);
    let navigation_mailbox = position(NavigationScope::Mailbox, 7);
    let navigation_thread = position(
        NavigationScope::Thread {
            root: message_id(1),
        },
        8,
    );
    let navigation_outgoing = position(NavigationScope::Outgoing, 9);
    let status = status_record(&group_id, &sender, Some("reviewing 你"));
    let attachment = attachment_record(1);
    let base_message = message(1, vec![attachment.clone()]);

    let self_view = SelfView {
        peer_id: sender.clone(),
        binding_revision: revision(1),
        launch_id: launch(1),
        harness: "codex".to_owned(),
        model_metadata: Some("gpt-5".to_owned()),
        is_live: true,
        memberships: vec![
            MembershipView {
                group_id: group_id.clone(),
                label: "available".to_owned(),
                policy_revision: revision(1),
                paused: false,
                added_policy_revision: revision(1),
                availability: MembershipAvailability::Available,
                status: Some(status.clone()),
            },
            MembershipView {
                group_id: group(2),
                label: "paused".to_owned(),
                policy_revision: revision(2),
                paused: true,
                added_policy_revision: revision(2),
                availability: MembershipAvailability::Paused,
                status: None,
            },
            MembershipView {
                group_id: group(3),
                label: "offline".to_owned(),
                policy_revision: revision(3),
                paused: false,
                added_policy_revision: revision(3),
                availability: MembershipAvailability::BindingOffline,
                status: None,
            },
        ],
        next_after_group: Some(group(3)),
        inventory_revision: revision(9_007_199_254_740_993),
        run_revision: Some(revision(i64::MAX as u64)),
    };
    assert_success(
        PeerOperation::WhoAmI {
            after_group: None,
            max_items: 128,
        },
        Outcome::SelfView(self_view),
        PeerOutcomeKind::SelfView,
    );

    let peer_page = PeerPage {
        group_id: group_id.clone(),
        policy_revision: revision(4),
        inventory_revision: revision(5),
        peers: vec![PeerView {
            peer_id: recipient.clone(),
            binding_revision: revision(6),
            launch_id: launch(2),
            harness: "claude".to_owned(),
            model_metadata: None,
            is_live: true,
            added_policy_revision: revision(7),
            status: Some(status.clone()),
            sources: vec![SourceSummary {
                source_id: source(2),
                source_kind: "transcript".to_owned(),
                registration_epoch: revision(8),
            }],
        }],
        next_after_peer: Some(recipient.clone()),
    };
    assert_success(
        PeerOperation::ListPeers {
            group_id: group_id.clone(),
            after_peer: None,
            max_items: 128,
        },
        Outcome::Peers(peer_page),
        PeerOutcomeKind::Peers,
    );

    assert_success(
        PeerOperation::PublishStatus {
            group_id: group_id.clone(),
            status: Some("reviewing 你".to_owned()),
        },
        Outcome::Status(status.clone()),
        PeerOutcomeKind::Status,
    );

    let send_receipt = termx_swarm_core::model::SendReceipt {
        message_id: message_id(1),
        group_id: group_id.clone(),
        group_sequence: 9_007_199_254_740_993,
        sender_peer_id: sender.clone(),
        sender_binding_revision: revision(9),
        recipients: vec![FrozenRecipient {
            peer_id: recipient.clone(),
            binding_revision: revision(10),
            generation: revision(11),
        }],
        committed_at_millis: i64::MAX,
        outcome: MessageCommitOutcome::Saved,
    };
    assert_success(
        PeerOperation::Send {
            group_id: group_id.clone(),
            client_key: "key".to_owned(),
            recipients: BTreeSet::from([recipient.clone()]),
            body: "body".to_owned(),
            topic: None,
            reply_to: None,
            attachments: Vec::<SourceAttachment>::new(),
        },
        Outcome::Saved(send_receipt),
        PeerOutcomeKind::Saved,
    );

    assert_success(
        PeerOperation::MailboxAfter {
            group_id: group_id.clone(),
            navigation: MailboxNavigation::Position(navigation_mailbox.clone()),
            max_items: 128,
        },
        Outcome::Mailbox(MailboxPage {
            messages: vec![MailboxEntry {
                message: base_message.clone(),
                receipt: receipt(1),
            }],
            next_cursor: None,
            resume_position: navigation_mailbox,
            snapshot_high_sequence: 9_007_199_254_740_993,
        }),
        PeerOutcomeKind::Mailbox,
    );

    assert_success(
        PeerOperation::ReadThread {
            group_id: group_id.clone(),
            root: message_id(1),
            navigation: MailboxNavigation::Position(navigation_thread.clone()),
            max_items: 128,
        },
        Outcome::Thread(ThreadPage {
            root: message_id(1),
            messages: vec![
                ThreadEntry {
                    message: base_message.clone(),
                    receipt: Some(receipt(1)),
                },
                ThreadEntry {
                    message: message(2, Vec::new()),
                    receipt: None,
                },
            ],
            next_cursor: None,
            resume_position: navigation_thread,
            snapshot_high_sequence: i64::MAX as u64,
        }),
        PeerOutcomeKind::Thread,
    );

    assert_success(
        PeerOperation::ReadOutgoing {
            group_id: group_id.clone(),
            navigation: MailboxNavigation::Position(navigation_outgoing.clone()),
            max_items: 128,
        },
        Outcome::Outgoing(OutgoingPage {
            messages: vec![MessageStateEntry {
                message: base_message,
                recipients: vec![RecipientState {
                    peer_id: recipient.clone(),
                    original_binding_revision: revision(1),
                    current_binding_revision: revision(2),
                    generation: revision(3),
                    fetched_at_millis: Some(i64::MIN),
                    acknowledged_at_millis: Some(i64::MAX),
                    replied_by: Some(message_id(2)),
                }],
            }],
            next_cursor: None,
            resume_position: navigation_outgoing,
            snapshot_high_sequence: i64::MAX as u64,
        }),
        PeerOutcomeKind::Outgoing,
    );

    assert_success(
        PeerOperation::Acknowledge {
            group_id: group_id.clone(),
            message_id: message_id(1),
        },
        Outcome::Acknowledged(AcknowledgementResult {
            message_id: message_id(1),
            generation: revision(i64::MAX as u64),
            acknowledged_at_millis: i64::MIN,
            contiguous_group_sequence: 9_007_199_254_740_993,
        }),
        PeerOutcomeKind::Acknowledged,
    );

    assert_success(
        PeerOperation::ResolveAttachment {
            group_id: group_id.clone(),
            source_reference_id: source_reference(1),
        },
        Outcome::Attachment(
            serde_json::to_value(AttachmentView {
                group_id,
                message_id: message_id(1),
                attachment,
                availability: SourceAvailability::Available {
                    registration_epoch: revision(1),
                },
            })
            .unwrap(),
        ),
        PeerOutcomeKind::Attachment,
    );
}

#[test]
fn every_source_availability_variant_uses_the_core_enum_shape() {
    let operation = PeerOperation::ResolveAttachment {
        group_id: group(1),
        source_reference_id: source_reference(1),
    };
    for availability in [
        SourceAvailability::Available {
            registration_epoch: revision(1),
        },
        SourceAvailability::Stale {
            cited_epoch: revision(1),
            current_epoch: revision(2),
        },
        SourceAvailability::Withdrawn,
        SourceAvailability::Replaced,
        SourceAvailability::StaleBinding,
        SourceAvailability::OwnerNotMember,
    ] {
        let payload = serde_json::to_value(AttachmentView {
            group_id: group(1),
            message_id: message_id(1),
            attachment: attachment_record(1),
            availability,
        })
        .unwrap();
        assert_success(
            operation.clone(),
            Outcome::Attachment(payload),
            PeerOutcomeKind::Attachment,
        );
    }
}

fn status_operation() -> PeerOperation {
    PeerOperation::PublishStatus {
        group_id: group(1),
        status: None,
    }
}

fn status_frame_value() -> serde_json::Value {
    serde_json::from_slice(&frame(
        "corr_1",
        Outcome::Status(status_record(&group(1), &peer(1), None)),
    ))
    .unwrap()
}

fn inspect_value(
    value: &serde_json::Value,
    operation: &PeerOperation,
) -> Result<PeerOutcomeKind, ResponseError> {
    let bytes = serde_json::to_vec(value).unwrap();
    inspect_peer_response(&bytes, "corr_1", operation).map(|response| response.outcome_kind())
}

fn payload_object(
    value: &mut serde_json::Value,
) -> &mut serde_json::Map<String, serde_json::Value> {
    value["message"]["body"]["outcome"]["payload"]
        .as_object_mut()
        .unwrap()
}

#[test]
fn closed_envelope_rejects_wrong_source_correlation_kind_and_fields() {
    let operation = status_operation();
    let valid = status_frame_value();

    let mut wrong_version = valid.clone();
    wrong_version["version"] = serde_json::json!(2);
    assert_eq!(
        inspect_value(&wrong_version, &operation),
        Err(ResponseError::InvalidEnvelope)
    );

    let mut event = valid.clone();
    event["message"]["type"] = serde_json::json!("event");
    assert_eq!(
        inspect_value(&event, &operation),
        Err(ResponseError::InvalidEnvelope)
    );

    let mut owner = valid.clone();
    owner["message"]["body"]["outcome"]["kind"] = serde_json::json!("health");
    assert_eq!(
        inspect_value(&owner, &operation),
        Err(ResponseError::UnexpectedOutcome)
    );

    let mut wrong_kind = valid.clone();
    wrong_kind["message"]["body"]["outcome"] = serde_json::json!({
        "kind": "acknowledged",
        "payload": {
            "message_id": message_id(1),
            "generation": 1,
            "acknowledged_at_millis": 0,
            "contiguous_group_sequence": 1
        }
    });
    assert_eq!(
        inspect_value(&wrong_kind, &operation),
        Err(ResponseError::UnexpectedOutcome)
    );

    let bytes = frame(
        "different",
        Outcome::Status(status_record(&group(1), &peer(1), None)),
    );
    assert!(matches!(
        inspect_peer_response(&bytes, "corr_1", &operation),
        Err(ResponseError::CorrelationMismatch)
    ));

    let mut missing = valid.clone();
    missing.as_object_mut().unwrap().remove("version");
    assert_eq!(
        inspect_value(&missing, &operation),
        Err(ResponseError::InvalidEnvelope)
    );
    let mut unknown = valid.clone();
    unknown["message"]["body"]["extra"] = serde_json::json!(true);
    assert_eq!(
        inspect_value(&unknown, &operation),
        Err(ResponseError::InvalidEnvelope)
    );
    let mut wrong_type = valid.clone();
    wrong_type["message"]["body"]["correlationId"] = serde_json::json!(1);
    assert_eq!(
        inspect_value(&wrong_type, &operation),
        Err(ResponseError::InvalidEnvelope)
    );

    assert!(matches!(
        inspect_peer_response(b"{", "corr_1", &operation),
        Err(ResponseError::InvalidJson)
    ));
    assert!(matches!(
        inspect_peer_response(b"{} trailing", "corr_1", &operation),
        Err(ResponseError::InvalidJson)
    ));
    let normal = frame(
        "corr_1",
        Outcome::Status(status_record(&group(1), &peer(1), None)),
    );
    assert!(matches!(
        inspect_peer_response(&normal, "bad correlation!", &operation),
        Err(ResponseError::InvalidExpectedCorrelation)
    ));
    let fetch = PeerOperation::FetchContext {
        group_id: group(1),
        source_id: source(1),
    };
    assert!(matches!(
        inspect_peer_response(&normal, "corr_1", &fetch),
        Err(ResponseError::UnsupportedOperation)
    ));
}

#[test]
fn escaped_keys_are_semantic_and_escaped_duplicates_fail_in_the_shared_scanner() {
    let operation = status_operation();
    let raw = String::from_utf8(frame(
        "corr_1",
        Outcome::Status(status_record(&group(1), &peer(1), Some("你𝄞"))),
    ))
    .unwrap();
    let escaped = raw
        .replacen("\"version\"", "\"ver\\u0073ion\"", 1)
        .replacen("\"correlationId\"", "\"correlation\\u0049d\"", 1)
        .replacen("\"status\"", "\"\\u0073tatus\"", 1);
    let response = inspect_peer_response(escaped.as_bytes(), "corr_1", &operation).unwrap();
    assert_eq!(response.outcome_kind(), PeerOutcomeKind::Status);
    assert!(response.payload_json().contains("你𝄞"));

    let duplicate = raw.replacen("\"version\":1", "\"version\":1,\"ver\\u0073ion\":1", 1);
    assert!(matches!(
        inspect_peer_response(duplicate.as_bytes(), "corr_1", &operation),
        Err(ResponseError::InvalidJson)
    ));
}

#[test]
fn payload_fields_are_required_closed_and_integer_spellings_are_exact() {
    let operation = status_operation();
    let valid = status_frame_value();

    let mut missing_null = valid.clone();
    payload_object(&mut missing_null).remove("status");
    assert_eq!(
        inspect_value(&missing_null, &operation),
        Err(ResponseError::InvalidPayload)
    );
    let mut unknown = valid.clone();
    payload_object(&mut unknown).insert("secret".to_owned(), serde_json::json!(true));
    let error = inspect_value(&unknown, &operation).unwrap_err();
    assert_eq!(error, ResponseError::InvalidPayload);
    assert!(!format!("{error:?} {error}").contains("secret"));

    for invalid_revision in [
        serde_json::json!(0),
        serde_json::json!(9_223_372_036_854_775_808_u64),
        serde_json::json!(1.0),
    ] {
        let mut value = valid.clone();
        payload_object(&mut value).insert("status_revision".to_owned(), invalid_revision);
        assert_eq!(
            inspect_value(&value, &operation),
            Err(ResponseError::InvalidPayload)
        );
    }
    let mut uppercase_id = valid.clone();
    payload_object(&mut uppercase_id).insert(
        "group_id".to_owned(),
        serde_json::json!("g_ABCDEF00000000000000000000000000"),
    );
    assert_eq!(
        inspect_value(&uppercase_id, &operation),
        Err(ResponseError::InvalidPayload)
    );

    let negative_zero = String::from_utf8(frame(
        "corr_1",
        Outcome::Status(status_record(&group(1), &peer(1), None)),
    ))
    .unwrap()
    .replace(
        "\"updated_at_millis\":-9223372036854775808",
        "\"updated_at_millis\":-0",
    );
    assert!(matches!(
        inspect_peer_response(negative_zero.as_bytes(), "corr_1", &operation),
        Err(ResponseError::InvalidPayload)
    ));
}

#[test]
fn currently_emitted_error_shapes_remain_errors_and_arbitrary_details_fail() {
    let operation = PeerOperation::WhoAmI {
        after_group: None,
        max_items: 1,
    };
    for code in [
        ErrorCode::InvalidRequest,
        ErrorCode::Unavailable,
        ErrorCode::Unauthorized,
        ErrorCode::NotFound,
        ErrorCode::StalePolicy,
        ErrorCode::StaleBinding,
        ErrorCode::BindingOffline,
        ErrorCode::GroupPaused,
        ErrorCode::StaleSnapshot,
        ErrorCode::StaleSourceEpoch,
        ErrorCode::SourceUnavailable,
        ErrorCode::LeaseConsumed,
        ErrorCode::Validation,
        ErrorCode::Admission,
        ErrorCode::OutcomeUnknown,
        ErrorCode::Store,
        ErrorCode::Transport,
        ErrorCode::Internal,
    ] {
        let plain = frame("corr_1", Outcome::Error(ErrorPayload::new(code, "later")));
        let inspected = inspect_peer_response(&plain, "corr_1", &operation).unwrap();
        assert_eq!(inspected.outcome_kind(), PeerOutcomeKind::Error);
        assert!(inspected.is_error());
    }

    let detailed = frame(
        "corr_1",
        Outcome::Error(ErrorPayload::from(StoreError::StalePolicy {
            expected: 9_007_199_254_740_993,
            actual: u64::MAX,
        })),
    );
    let inspected = inspect_peer_response(&detailed, "corr_1", &operation).unwrap();
    let payload: serde_json::Value = serde_json::from_str(inspected.payload_json()).unwrap();
    assert_eq!(payload["details"]["expected"], "9007199254740993");
    assert_eq!(payload["details"]["actual"], "18446744073709551615");

    let mut arbitrary: serde_json::Value = serde_json::from_slice(&detailed).unwrap();
    arbitrary["message"]["body"]["outcome"]["payload"]["details"] =
        serde_json::json!({"expected":"1","actual":"2","extra":true});
    assert_eq!(
        inspect_value(&arbitrary, &operation),
        Err(ResponseError::InvalidPayload)
    );
    arbitrary["message"]["body"]["outcome"]["payload"]["details"] = serde_json::Value::Null;
    assert_eq!(
        inspect_value(&arbitrary, &operation),
        Err(ResponseError::InvalidPayload)
    );

    let mut wrong_code: serde_json::Value = serde_json::from_slice(&detailed).unwrap();
    wrong_code["message"]["body"]["outcome"]["payload"]["code"] = serde_json::json!("unavailable");
    assert_eq!(
        inspect_value(&wrong_code, &operation),
        Err(ResponseError::InvalidPayload)
    );
}

#[test]
fn operation_frame_limits_are_exact_and_precede_payload_decoding() {
    let control = status_operation();
    let metadata = PeerOperation::WhoAmI {
        after_group: None,
        max_items: 1,
    };
    let send = PeerOperation::Send {
        group_id: group(1),
        client_key: "k".to_owned(),
        recipients: BTreeSet::from([peer(2)]),
        body: "b".to_owned(),
        topic: None,
        reply_to: None,
        attachments: Vec::new(),
    };
    let messages = PeerOperation::MailboxAfter {
        group_id: group(1),
        navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
        max_items: 1,
    };
    assert_eq!(
        peer_response_frame_limit(&control),
        Some(CONTROL_RESPONSE_FRAME_BYTES)
    );
    assert_eq!(
        peer_response_frame_limit(&metadata),
        Some(MAX_METADATA_PAGE_BYTES + RESPONSE_WRAPPER_BYTES)
    );
    assert_eq!(
        peer_response_frame_limit(&send),
        Some(MAX_MAILBOX_PAGE_BYTES + RESPONSE_WRAPPER_BYTES)
    );
    assert_eq!(
        peer_response_frame_limit(&messages),
        peer_response_frame_limit(&send)
    );

    let self_view = SelfView {
        peer_id: peer(1),
        binding_revision: revision(1),
        launch_id: launch(1),
        harness: "codex".to_owned(),
        model_metadata: None,
        is_live: true,
        memberships: Vec::new(),
        next_after_group: None,
        inventory_revision: revision(1),
        run_revision: None,
    };
    let saved = termx_swarm_core::model::SendReceipt {
        message_id: message_id(1),
        group_id: group(1),
        group_sequence: 1,
        sender_peer_id: peer(1),
        sender_binding_revision: revision(1),
        recipients: vec![FrozenRecipient {
            peer_id: peer(2),
            binding_revision: revision(1),
            generation: revision(1),
        }],
        committed_at_millis: 0,
        outcome: MessageCommitOutcome::Saved,
    };
    for (operation, outcome, limit, kind) in [
        (
            control.clone(),
            Outcome::Status(status_record(&group(1), &peer(1), None)),
            CONTROL_RESPONSE_FRAME_BYTES,
            PeerOutcomeKind::Status,
        ),
        (
            metadata,
            Outcome::SelfView(self_view),
            MAX_METADATA_PAGE_BYTES + RESPONSE_WRAPPER_BYTES,
            PeerOutcomeKind::SelfView,
        ),
        (
            send,
            Outcome::Saved(saved),
            MAX_MAILBOX_PAGE_BYTES + RESPONSE_WRAPPER_BYTES,
            PeerOutcomeKind::Saved,
        ),
    ] {
        let mut exact = frame("corr_1", outcome);
        exact.resize(limit, b' ');
        assert_eq!(
            inspect_peer_response(&exact, "corr_1", &operation)
                .unwrap()
                .outcome_kind(),
            kind
        );
        exact.push(b' ');
        assert!(matches!(
            inspect_peer_response(&exact, "corr_1", &operation),
            Err(ResponseError::FrameTooLarge)
        ));
    }

    let invalid_payload = br#"{"version":1,"message":{"type":"response","body":{"correlationId":"corr_1","outcome":{"kind":"status","payload":null}}}}"#;
    let mut oversized = invalid_payload.to_vec();
    oversized.resize(CONTROL_RESPONSE_FRAME_BYTES + 1, b' ');
    assert!(matches!(
        inspect_peer_response(&oversized, "corr_1", &control),
        Err(ResponseError::FrameTooLarge)
    ));
}

#[test]
fn decoded_utf8_limits_apply_without_materializing_large_strings() {
    let operation = status_operation();
    let exact_status = "🦀".repeat(1024);
    assert_eq!(exact_status.len(), 4096);
    let exact = frame(
        "corr_1",
        Outcome::Status(status_record(&group(1), &peer(1), Some(&exact_status))),
    );
    inspect_peer_response(&exact, "corr_1", &operation).unwrap();

    let mut too_long: serde_json::Value = serde_json::from_slice(&exact).unwrap();
    too_long["message"]["body"]["outcome"]["payload"]["status"] =
        serde_json::json!(format!("{exact_status}x"));
    assert_eq!(
        inspect_value(&too_long, &operation),
        Err(ResponseError::InvalidPayload)
    );

    for body in [
        format!("{}x", "你".repeat((MAX_MESSAGE_BODY_BYTES - 1) / 3)),
        "\\\"".repeat(MAX_MESSAGE_BODY_BYTES / 2),
    ] {
        assert_eq!(body.len(), MAX_MESSAGE_BODY_BYTES);
        let page = MailboxPage {
            messages: vec![MailboxEntry {
                message: MessageRecord {
                    body: body.clone(),
                    ..message(1, Vec::new())
                },
                receipt: receipt(1),
            }],
            next_cursor: None,
            resume_position: position(NavigationScope::Mailbox, 1),
            snapshot_high_sequence: 1,
        };
        let bytes = frame("corr_1", Outcome::Mailbox(page.clone()));
        let mailbox = PeerOperation::MailboxAfter {
            group_id: group(1),
            navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
            max_items: 1,
        };
        inspect_peer_response(&bytes, "corr_1", &mailbox).unwrap();

        let thread = ThreadPage {
            root: message_id(1),
            messages: vec![ThreadEntry {
                message: MessageRecord {
                    body: format!("{body}x"),
                    ..message(1, Vec::new())
                },
                receipt: None,
            }],
            next_cursor: None,
            resume_position: position(
                NavigationScope::Thread {
                    root: message_id(1),
                },
                1,
            ),
            snapshot_high_sequence: 1,
        };
        let bytes = frame("corr_1", Outcome::Thread(thread));
        let read_thread = PeerOperation::ReadThread {
            group_id: group(1),
            root: message_id(1),
            navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
            max_items: 1,
        };
        assert!(matches!(
            inspect_peer_response(&bytes, "corr_1", &read_thread),
            Err(ResponseError::InvalidPayload)
        ));
    }
}

fn assert_invalid_outcome(operation: &PeerOperation, outcome: Outcome) {
    let bytes = frame("corr_1", outcome);
    assert!(matches!(
        inspect_peer_response(&bytes, "corr_1", operation),
        Err(ResponseError::InvalidPayload)
    ));
}

#[test]
fn every_nested_array_rejects_one_over_its_domain_cap() {
    let who = PeerOperation::WhoAmI {
        after_group: None,
        max_items: 128,
    };
    let membership = MembershipView {
        group_id: group(1),
        label: "group".to_owned(),
        policy_revision: revision(1),
        paused: false,
        added_policy_revision: revision(1),
        availability: MembershipAvailability::Available,
        status: None,
    };
    assert_invalid_outcome(
        &who,
        Outcome::SelfView(SelfView {
            peer_id: peer(1),
            binding_revision: revision(1),
            launch_id: launch(1),
            harness: "codex".to_owned(),
            model_metadata: None,
            is_live: true,
            memberships: vec![membership; MAX_METADATA_PAGE_ITEMS + 1],
            next_after_group: None,
            inventory_revision: revision(1),
            run_revision: None,
        }),
    );

    let list = PeerOperation::ListPeers {
        group_id: group(1),
        after_peer: None,
        max_items: 128,
    };
    let summary = SourceSummary {
        source_id: source(1),
        source_kind: "transcript".to_owned(),
        registration_epoch: revision(1),
    };
    assert_invalid_outcome(
        &list,
        Outcome::Peers(PeerPage {
            group_id: group(1),
            policy_revision: revision(1),
            inventory_revision: revision(1),
            peers: vec![PeerView {
                peer_id: peer(1),
                binding_revision: revision(1),
                launch_id: launch(1),
                harness: "codex".to_owned(),
                model_metadata: None,
                is_live: true,
                added_policy_revision: revision(1),
                status: None,
                sources: vec![summary; MAX_ACTIVE_SOURCES_PER_BINDING + 1],
            }],
            next_after_peer: None,
        }),
    );

    let peer_view = PeerView {
        peer_id: peer(1),
        binding_revision: revision(1),
        launch_id: launch(1),
        harness: "codex".to_owned(),
        model_metadata: None,
        is_live: true,
        added_policy_revision: revision(1),
        status: None,
        sources: Vec::new(),
    };
    assert_invalid_outcome(
        &list,
        Outcome::Peers(PeerPage {
            group_id: group(1),
            policy_revision: revision(1),
            inventory_revision: revision(1),
            peers: vec![peer_view; MAX_METADATA_PAGE_ITEMS + 1],
            next_after_peer: None,
        }),
    );

    let mailbox = PeerOperation::MailboxAfter {
        group_id: group(1),
        navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
        max_items: 128,
    };
    let entry = MailboxEntry {
        message: message(1, Vec::new()),
        receipt: receipt(1),
    };
    assert_invalid_outcome(
        &mailbox,
        Outcome::Mailbox(MailboxPage {
            messages: vec![entry; MAX_MAILBOX_PAGE_ITEMS + 1],
            next_cursor: None,
            resume_position: position(NavigationScope::Mailbox, 1),
            snapshot_high_sequence: 1,
        }),
    );

    let attachments = (0..=MAX_ATTACHMENTS_PER_MESSAGE)
        .map(|index| attachment_record(index as u128 + 1))
        .collect();
    assert_invalid_outcome(
        &mailbox,
        Outcome::Mailbox(MailboxPage {
            messages: vec![MailboxEntry {
                message: message(1, attachments),
                receipt: receipt(1),
            }],
            next_cursor: None,
            resume_position: position(NavigationScope::Mailbox, 1),
            snapshot_high_sequence: 1,
        }),
    );

    let send = PeerOperation::Send {
        group_id: group(1),
        client_key: "k".to_owned(),
        recipients: BTreeSet::from([peer(2)]),
        body: "b".to_owned(),
        topic: None,
        reply_to: None,
        attachments: Vec::new(),
    };
    let frozen = FrozenRecipient {
        peer_id: peer(2),
        binding_revision: revision(1),
        generation: revision(1),
    };
    assert_invalid_outcome(
        &send,
        Outcome::Saved(termx_swarm_core::model::SendReceipt {
            message_id: message_id(1),
            group_id: group(1),
            group_sequence: 1,
            sender_peer_id: peer(1),
            sender_binding_revision: revision(1),
            recipients: vec![frozen; MAX_RECIPIENTS_PER_MESSAGE + 1],
            committed_at_millis: 0,
            outcome: MessageCommitOutcome::Saved,
        }),
    );

    let read_thread = PeerOperation::ReadThread {
        group_id: group(1),
        root: message_id(1),
        navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
        max_items: 128,
    };
    let thread_entry = ThreadEntry {
        message: message(1, Vec::new()),
        receipt: None,
    };
    assert_invalid_outcome(
        &read_thread,
        Outcome::Thread(ThreadPage {
            root: message_id(1),
            messages: vec![thread_entry; MAX_MAILBOX_PAGE_ITEMS + 1],
            next_cursor: None,
            resume_position: position(
                NavigationScope::Thread {
                    root: message_id(1),
                },
                1,
            ),
            snapshot_high_sequence: 1,
        }),
    );

    let read_outgoing = PeerOperation::ReadOutgoing {
        group_id: group(1),
        navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
        max_items: 128,
    };
    let recipient = RecipientState {
        peer_id: peer(2),
        original_binding_revision: revision(1),
        current_binding_revision: revision(1),
        generation: revision(1),
        fetched_at_millis: None,
        acknowledged_at_millis: None,
        replied_by: None,
    };
    let state = MessageStateEntry {
        message: message(1, Vec::new()),
        recipients: vec![recipient.clone()],
    };
    assert_invalid_outcome(
        &read_outgoing,
        Outcome::Outgoing(OutgoingPage {
            messages: vec![state; MAX_MAILBOX_PAGE_ITEMS + 1],
            next_cursor: None,
            resume_position: position(NavigationScope::Outgoing, 1),
            snapshot_high_sequence: 1,
        }),
    );
    assert_invalid_outcome(
        &read_outgoing,
        Outcome::Outgoing(OutgoingPage {
            messages: vec![MessageStateEntry {
                message: message(1, Vec::new()),
                recipients: vec![recipient; MAX_RECIPIENTS_PER_MESSAGE + 1],
            }],
            next_cursor: None,
            resume_position: position(NavigationScope::Outgoing, 1),
            snapshot_high_sequence: 1,
        }),
    );
}

fn maximum_outgoing_page() -> OutgoingPage {
    let group_id = group(1);
    let sender = peer(1);
    let one = revision(1);
    let resume_position: NavigationPosition = serde_json::from_value(serde_json::json!({
        "group_id": group_id,
        "peer_id": sender,
        "binding_revision": 1,
        "policy_revision": 8194,
        "scope": "outgoing",
        "after_sequence": 10,
    }))
    .unwrap();
    let recipients = (0..MAX_RECIPIENTS_PER_MESSAGE)
        .map(|index| RecipientState {
            peer_id: peer(index as u128 + 2),
            original_binding_revision: one,
            current_binding_revision: one,
            generation: one,
            fetched_at_millis: None,
            acknowledged_at_millis: None,
            replied_by: None,
        })
        .collect::<Vec<_>>();
    OutgoingPage {
        messages: (0..10)
            .map(|index| MessageStateEntry {
                message: MessageRecord {
                    message_id: message_id(index + 1),
                    group_id: group_id.clone(),
                    group_sequence: index as u64 + 1,
                    sender_peer_id: sender.clone(),
                    sender_binding_revision: one,
                    client_key: index.to_string(),
                    body: "b".into(),
                    topic: None,
                    reply_to: None,
                    attachments: Vec::new(),
                },
                recipients: recipients.clone(),
            })
            .collect(),
        next_cursor: None,
        resume_position,
        snapshot_high_sequence: 10,
    }
}

#[test]
fn actual_8031440_byte_outgoing_page_is_validated_as_one_borrowed_span() {
    let page = maximum_outgoing_page();
    let raw_page = serde_json::to_vec(&page).unwrap();
    assert_eq!(raw_page.len(), 8_031_440);
    let validated = termx_swarm_mcp_protocol::validate_json(&raw_page).unwrap();
    assert_eq!(validated.stats().work_nodes(), 614_671);

    let bytes = frame("corr_1", Outcome::Outgoing(page));
    let operation = PeerOperation::ReadOutgoing {
        group_id: group(1),
        navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
        max_items: 128,
    };
    let inspected = inspect_peer_response(&bytes, "corr_1", &operation).unwrap();
    assert_eq!(inspected.outcome_kind(), PeerOutcomeKind::Outgoing);
    assert_eq!(inspected.payload_json().as_bytes(), raw_page);
    assert_eq!(
        serde_json::from_str::<OutgoingPage>(inspected.payload_json()).unwrap(),
        maximum_outgoing_page()
    );
}
