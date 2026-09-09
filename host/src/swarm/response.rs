//! Borrowed validation of one private peer RPC response.
//!
//! This module proves bounded JSON syntax, the closed version-1 response
//! schema, correlation, and operation/outcome agreement. It does not prove
//! native authentication, admission, authorization, or peer receipt.

use std::fmt;

use termx_swarm_core::model::{
    MAX_ACTIVE_SOURCES_PER_BINDING, MAX_ATTACHMENTS_PER_MESSAGE, MAX_CLIENT_KEY_BYTES,
    MAX_LABEL_BYTES, MAX_MAILBOX_PAGE_BYTES, MAX_MAILBOX_PAGE_ITEMS, MAX_MESSAGE_BODY_BYTES,
    MAX_METADATA_BYTES, MAX_METADATA_PAGE_BYTES, MAX_METADATA_PAGE_ITEMS,
    MAX_RECIPIENTS_PER_MESSAGE, MAX_STATUS_BYTES, MAX_TOPIC_BYTES,
};

use super::rpc::{
    PeerOperation, MAX_CORRELATION_ID_BYTES, MAX_ERROR_MESSAGE_BYTES, SWARM_RPC_VERSION,
};

/// Maximum accepted complete control response frame.
pub const CONTROL_RESPONSE_FRAME_BYTES: usize = 128 * 1024;
/// Fixed response wrapper allowance used by the existing RPC response classes.
pub const RESPONSE_WRAPPER_BYTES: usize = 64 * 1024;
/// Conservative analytical allowance for this validator's fixed state.
///
/// The schema walk keeps a two-word cursor, one 64-bit field mask per active
/// object, scalar accumulators, and a four-byte UTF-8 buffer. Arrays stream one
/// element at a time. The deepest closed payload path is page -> entry ->
/// message -> attachment; there is no input-sized recursion or owned buffer.
/// This allowance is separate from the retained frame and the shared JSON
/// validator's sequential scan state, and is not a measured allocation peak.
pub const RESPONSE_VALIDATOR_SCRATCH_BYTES: usize = 8 * 1024;
const MAX_SQL_U64: u64 = i64::MAX as u64;

const _: () = assert!(RESPONSE_VALIDATOR_SCRATCH_BYTES <= 64 * 1024);

/// The closed peer outcome kinds accepted by [`inspect_peer_response`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PeerOutcomeKind {
    SelfView,
    Peers,
    Status,
    Saved,
    Mailbox,
    Thread,
    Outgoing,
    Acknowledged,
    Attachment,
    Error,
}

/// A borrowed, schema-checked peer response payload.
///
/// Fields are private so this value can only be obtained through the checked
/// inspector. The payload is an exact span of the caller's immutable frame.
pub struct BorrowedPeerResponse<'a> {
    payload: &'a str,
    kind: PeerOutcomeKind,
}

impl BorrowedPeerResponse<'_> {
    /// The exact JSON payload span borrowed from the received frame.
    pub fn payload_json(&self) -> &str {
        self.payload
    }

    pub fn outcome_kind(&self) -> PeerOutcomeKind {
        self.kind
    }

    pub fn is_error(&self) -> bool {
        self.kind == PeerOutcomeKind::Error
    }
}

impl fmt::Debug for BorrowedPeerResponse<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BorrowedPeerResponse")
            .field("kind", &self.kind)
            .field("payload_bytes", &self.payload.len())
            .finish()
    }
}

/// Closed response-inspection failures. Diagnostics never contain frame data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResponseError {
    InvalidJson,
    UnsupportedOperation,
    InvalidExpectedCorrelation,
    FrameTooLarge,
    InvalidEnvelope,
    CorrelationMismatch,
    UnexpectedOutcome,
    InvalidPayload,
}

impl fmt::Display for ResponseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidJson => "peer response is not bounded valid JSON",
            Self::UnsupportedOperation => "operation has no ordinary peer response",
            Self::InvalidExpectedCorrelation => "expected correlation identifier is invalid",
            Self::FrameTooLarge => "peer response exceeds its operation-specific limit",
            Self::InvalidEnvelope => "peer response envelope is invalid",
            Self::CorrelationMismatch => "peer response correlation does not match",
            Self::UnexpectedOutcome => "peer response outcome does not match the operation",
            Self::InvalidPayload => "peer response payload schema is invalid",
        })
    }
}

impl std::error::Error for ResponseError {}

/// Complete JSON-frame limit for an ordinary peer operation. `FetchContext`
/// uses the separate protected publication flow and therefore returns `None`.
pub const fn peer_response_frame_limit(operation: &PeerOperation) -> Option<usize> {
    match operation {
        PeerOperation::WhoAmI { .. } | PeerOperation::ListPeers { .. } => {
            Some(MAX_METADATA_PAGE_BYTES + RESPONSE_WRAPPER_BYTES)
        }
        PeerOperation::Send { .. }
        | PeerOperation::MailboxAfter { .. }
        | PeerOperation::ReadThread { .. }
        | PeerOperation::ReadOutgoing { .. } => {
            Some(MAX_MAILBOX_PAGE_BYTES + RESPONSE_WRAPPER_BYTES)
        }
        PeerOperation::PublishStatus { .. }
        | PeerOperation::Acknowledge { .. }
        | PeerOperation::ResolveAttachment { .. } => Some(CONTROL_RESPONSE_FRAME_BYTES),
        PeerOperation::FetchContext { .. } => None,
    }
}

/// Inspect one already-received immutable private peer response.
pub fn inspect_peer_response<'a>(
    frame: &'a [u8],
    expected_correlation: &str,
    operation: &PeerOperation,
) -> Result<BorrowedPeerResponse<'a>, ResponseError> {
    let validated =
        termx_swarm_mcp_protocol::validate_json(frame).map_err(|_| ResponseError::InvalidJson)?;
    let frame_limit =
        peer_response_frame_limit(operation).ok_or(ResponseError::UnsupportedOperation)?;
    if frame.len() > frame_limit {
        return Err(ResponseError::FrameTooLarge);
    }
    if !valid_correlation(expected_correlation) {
        return Err(ResponseError::InvalidExpectedCorrelation);
    }

    let (correlation, outcome) = inspect_envelope(validated.as_str())?;
    if !decoded_string_matches(correlation, expected_correlation) {
        return Err(ResponseError::CorrelationMismatch);
    }
    let (kind, payload) = inspect_outcome(outcome)?;
    if kind != PeerOutcomeKind::Error && kind != expected_kind(operation) {
        return Err(ResponseError::UnexpectedOutcome);
    }
    validate_payload(kind, payload)?;
    Ok(BorrowedPeerResponse { payload, kind })
}

fn valid_correlation(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CORRELATION_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn expected_kind(operation: &PeerOperation) -> PeerOutcomeKind {
    match operation {
        PeerOperation::WhoAmI { .. } => PeerOutcomeKind::SelfView,
        PeerOperation::ListPeers { .. } => PeerOutcomeKind::Peers,
        PeerOperation::PublishStatus { .. } => PeerOutcomeKind::Status,
        PeerOperation::Send { .. } => PeerOutcomeKind::Saved,
        PeerOperation::MailboxAfter { .. } => PeerOutcomeKind::Mailbox,
        PeerOperation::ReadThread { .. } => PeerOutcomeKind::Thread,
        PeerOperation::ReadOutgoing { .. } => PeerOutcomeKind::Outgoing,
        PeerOperation::Acknowledge { .. } => PeerOutcomeKind::Acknowledged,
        PeerOperation::ResolveAttachment { .. } => PeerOutcomeKind::Attachment,
        PeerOperation::FetchContext { .. } => unreachable!("rejected before outcome matching"),
    }
}

fn inspect_envelope(input: &str) -> Result<(&str, &str), ResponseError> {
    let mut parser = Parser::new(input);
    let mut version = None;
    let mut message = None;
    parser.object(
        ["version", "message"],
        all_required(2),
        ResponseError::InvalidEnvelope,
        |field, parser| match field {
            0 => {
                version = Some(parser.unsigned_number(ResponseError::InvalidEnvelope)?);
                Ok(())
            }
            1 => {
                message = Some(parser.value_span(ResponseError::InvalidEnvelope)?);
                Ok(())
            }
            _ => unreachable!(),
        },
    )?;
    parser.finish(ResponseError::InvalidEnvelope)?;
    if version != Some(u64::from(SWARM_RPC_VERSION)) {
        return Err(ResponseError::InvalidEnvelope);
    }
    inspect_message(message.ok_or(ResponseError::InvalidEnvelope)?)
}

fn inspect_message(input: &str) -> Result<(&str, &str), ResponseError> {
    let mut parser = Parser::new(input);
    let mut message_type = None;
    let mut body = None;
    parser.object(
        ["type", "body"],
        all_required(2),
        ResponseError::InvalidEnvelope,
        |field, parser| match field {
            0 => {
                message_type = Some(parser.string(ResponseError::InvalidEnvelope)?);
                Ok(())
            }
            1 => {
                body = Some(parser.value_span(ResponseError::InvalidEnvelope)?);
                Ok(())
            }
            _ => unreachable!(),
        },
    )?;
    parser.finish(ResponseError::InvalidEnvelope)?;
    if !decoded_string_matches(
        message_type.ok_or(ResponseError::InvalidEnvelope)?,
        "response",
    ) {
        return Err(ResponseError::InvalidEnvelope);
    }
    inspect_body(body.ok_or(ResponseError::InvalidEnvelope)?)
}

fn inspect_body(input: &str) -> Result<(&str, &str), ResponseError> {
    let mut parser = Parser::new(input);
    let mut correlation = None;
    let mut outcome = None;
    parser.object(
        ["correlationId", "outcome"],
        all_required(2),
        ResponseError::InvalidEnvelope,
        |field, parser| match field {
            0 => {
                let token = parser.string(ResponseError::InvalidEnvelope)?;
                if !decoded_string_satisfies(token, |index, byte| {
                    index < MAX_CORRELATION_ID_BYTES
                        && (byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                })
                .is_some_and(|length| length != 0 && length <= MAX_CORRELATION_ID_BYTES)
                {
                    return Err(ResponseError::InvalidEnvelope);
                }
                correlation = Some(token);
                Ok(())
            }
            1 => {
                outcome = Some(parser.value_span(ResponseError::InvalidEnvelope)?);
                Ok(())
            }
            _ => unreachable!(),
        },
    )?;
    parser.finish(ResponseError::InvalidEnvelope)?;
    Ok((
        correlation.ok_or(ResponseError::InvalidEnvelope)?,
        outcome.ok_or(ResponseError::InvalidEnvelope)?,
    ))
}

fn inspect_outcome(input: &str) -> Result<(PeerOutcomeKind, &str), ResponseError> {
    let mut parser = Parser::new(input);
    let mut kind = None;
    let mut payload = None;
    parser.object(
        ["kind", "payload"],
        all_required(2),
        ResponseError::InvalidEnvelope,
        |field, parser| match field {
            0 => {
                kind = Some(parse_outcome_kind(
                    parser.string(ResponseError::InvalidEnvelope)?,
                )?);
                Ok(())
            }
            1 => {
                payload = Some(parser.value_span(ResponseError::InvalidEnvelope)?);
                Ok(())
            }
            _ => unreachable!(),
        },
    )?;
    parser.finish(ResponseError::InvalidEnvelope)?;
    Ok((
        kind.ok_or(ResponseError::InvalidEnvelope)?,
        payload.ok_or(ResponseError::InvalidEnvelope)?,
    ))
}

fn parse_outcome_kind(token: &str) -> Result<PeerOutcomeKind, ResponseError> {
    for (name, kind) in [
        ("self_view", PeerOutcomeKind::SelfView),
        ("peers", PeerOutcomeKind::Peers),
        ("status", PeerOutcomeKind::Status),
        ("saved", PeerOutcomeKind::Saved),
        ("mailbox", PeerOutcomeKind::Mailbox),
        ("thread", PeerOutcomeKind::Thread),
        ("outgoing", PeerOutcomeKind::Outgoing),
        ("acknowledged", PeerOutcomeKind::Acknowledged),
        ("attachment", PeerOutcomeKind::Attachment),
        ("error", PeerOutcomeKind::Error),
    ] {
        if decoded_string_matches(token, name) {
            return Ok(kind);
        }
    }
    Err(ResponseError::UnexpectedOutcome)
}

fn validate_payload(kind: PeerOutcomeKind, input: &str) -> Result<(), ResponseError> {
    match kind {
        PeerOutcomeKind::SelfView => validate_self_view(input),
        PeerOutcomeKind::Peers => validate_peer_page(input),
        PeerOutcomeKind::Status => validate_status(input),
        PeerOutcomeKind::Saved => validate_send_receipt(input),
        PeerOutcomeKind::Mailbox => validate_mailbox_page(input),
        PeerOutcomeKind::Thread => validate_thread_page(input),
        PeerOutcomeKind::Outgoing => validate_outgoing_page(input),
        PeerOutcomeKind::Acknowledged => validate_acknowledgement(input),
        PeerOutcomeKind::Attachment => validate_attachment_view(input),
        PeerOutcomeKind::Error => validate_error_payload(input),
    }
}

fn validate_self_view(input: &str) -> Result<(), ResponseError> {
    exact_object(
        input,
        [
            "peer_id",
            "binding_revision",
            "launch_id",
            "harness",
            "model_metadata",
            "is_live",
            "memberships",
            "next_after_group",
            "inventory_revision",
            "run_revision",
        ],
        |field, parser| match field {
            0 => parser.id("p_"),
            1 | 8 => parser.revision(),
            2 => parser.id("l_"),
            3 => parser.text(1, MAX_LABEL_BYTES),
            4 => parser.optional(|parser| parser.text(0, MAX_METADATA_BYTES)),
            5 => parser.boolean(),
            6 => parser.array(MAX_METADATA_PAGE_ITEMS, validate_membership),
            7 => parser.optional(|parser| parser.id("g_")),
            9 => parser.optional(Parser::revision),
            _ => unreachable!(),
        },
    )
}

fn validate_membership(parser: &mut Parser<'_>) -> Result<(), ResponseError> {
    parser.object(
        [
            "group_id",
            "label",
            "policy_revision",
            "paused",
            "added_policy_revision",
            "availability",
            "status",
        ],
        all_required(7),
        ResponseError::InvalidPayload,
        |field, parser| match field {
            0 => parser.id("g_"),
            1 => parser.text(1, MAX_LABEL_BYTES),
            2 | 4 => parser.revision(),
            3 => parser.boolean(),
            5 => parser.one_of(&["available", "paused", "binding_offline"]),
            6 => parser.optional(validate_status_in),
            _ => unreachable!(),
        },
    )?;
    Ok(())
}

fn validate_status(input: &str) -> Result<(), ResponseError> {
    let mut parser = Parser::new(input);
    validate_status_in(&mut parser)?;
    parser.finish(ResponseError::InvalidPayload)
}

fn validate_status_in(parser: &mut Parser<'_>) -> Result<(), ResponseError> {
    parser.object(
        [
            "group_id",
            "peer_id",
            "binding_revision",
            "status",
            "status_revision",
            "updated_at_millis",
        ],
        all_required(6),
        ResponseError::InvalidPayload,
        |field, parser| match field {
            0 => parser.id("g_"),
            1 => parser.id("p_"),
            2 | 4 => parser.revision(),
            3 => parser.optional(|parser| parser.text(1, MAX_STATUS_BYTES)),
            5 => parser.signed_number(),
            _ => unreachable!(),
        },
    )?;
    Ok(())
}

fn validate_peer_page(input: &str) -> Result<(), ResponseError> {
    exact_object(
        input,
        [
            "group_id",
            "policy_revision",
            "inventory_revision",
            "peers",
            "next_after_peer",
        ],
        |field, parser| match field {
            0 => parser.id("g_"),
            1 | 2 => parser.revision(),
            3 => parser.array(MAX_METADATA_PAGE_ITEMS, validate_peer),
            4 => parser.optional(|parser| parser.id("p_")),
            _ => unreachable!(),
        },
    )
}

fn validate_peer(parser: &mut Parser<'_>) -> Result<(), ResponseError> {
    parser.object(
        [
            "peer_id",
            "binding_revision",
            "launch_id",
            "harness",
            "model_metadata",
            "is_live",
            "added_policy_revision",
            "status",
            "sources",
        ],
        all_required(9),
        ResponseError::InvalidPayload,
        |field, parser| match field {
            0 => parser.id("p_"),
            1 | 6 => parser.revision(),
            2 => parser.id("l_"),
            3 => parser.text(1, MAX_LABEL_BYTES),
            4 => parser.optional(|parser| parser.text(0, MAX_METADATA_BYTES)),
            5 => parser.boolean(),
            7 => parser.optional(validate_status_in),
            8 => parser.array(MAX_ACTIVE_SOURCES_PER_BINDING, validate_source_summary),
            _ => unreachable!(),
        },
    )?;
    Ok(())
}

fn validate_source_summary(parser: &mut Parser<'_>) -> Result<(), ResponseError> {
    parser.object(
        ["source_id", "source_kind", "registration_epoch"],
        all_required(3),
        ResponseError::InvalidPayload,
        |field, parser| match field {
            0 => parser.id("src_"),
            1 => parser.text(1, MAX_LABEL_BYTES),
            2 => parser.revision(),
            _ => unreachable!(),
        },
    )?;
    Ok(())
}

fn validate_send_receipt(input: &str) -> Result<(), ResponseError> {
    exact_object(
        input,
        [
            "message_id",
            "group_id",
            "group_sequence",
            "sender_peer_id",
            "sender_binding_revision",
            "recipients",
            "committed_at_millis",
            "outcome",
        ],
        |field, parser| match field {
            0 => parser.id("m_"),
            1 => parser.id("g_"),
            2 => parser.sequence(),
            3 => parser.id("p_"),
            4 => parser.revision(),
            5 => parser.nonempty_array(MAX_RECIPIENTS_PER_MESSAGE, validate_frozen_recipient),
            6 => parser.signed_number(),
            7 => parser.one_of(&["Saved"]),
            _ => unreachable!(),
        },
    )
}

fn validate_frozen_recipient(parser: &mut Parser<'_>) -> Result<(), ResponseError> {
    parser.object(
        ["peer_id", "binding_revision", "generation"],
        all_required(3),
        ResponseError::InvalidPayload,
        |field, parser| match field {
            0 => parser.id("p_"),
            1 | 2 => parser.revision(),
            _ => unreachable!(),
        },
    )?;
    Ok(())
}

fn validate_mailbox_page(input: &str) -> Result<(), ResponseError> {
    exact_object(
        input,
        [
            "messages",
            "next_cursor",
            "resume_position",
            "snapshot_high_sequence",
        ],
        |field, parser| match field {
            0 => parser.array(MAX_MAILBOX_PAGE_ITEMS, validate_mailbox_entry),
            1 => parser.optional(|parser| parser.id("c_")),
            2 => validate_navigation_position(parser),
            3 => parser.sequence(),
            _ => unreachable!(),
        },
    )
}

fn validate_mailbox_entry(parser: &mut Parser<'_>) -> Result<(), ResponseError> {
    parser.object(
        ["message", "receipt"],
        all_required(2),
        ResponseError::InvalidPayload,
        |field, parser| match field {
            0 => validate_message(parser),
            1 => validate_receipt(parser),
            _ => unreachable!(),
        },
    )?;
    Ok(())
}

fn validate_thread_page(input: &str) -> Result<(), ResponseError> {
    exact_object(
        input,
        [
            "root",
            "messages",
            "next_cursor",
            "resume_position",
            "snapshot_high_sequence",
        ],
        |field, parser| match field {
            0 => parser.id("m_"),
            1 => parser.array(MAX_MAILBOX_PAGE_ITEMS, validate_thread_entry),
            2 => parser.optional(|parser| parser.id("c_")),
            3 => validate_navigation_position(parser),
            4 => parser.sequence(),
            _ => unreachable!(),
        },
    )
}

fn validate_thread_entry(parser: &mut Parser<'_>) -> Result<(), ResponseError> {
    parser.object(
        ["message", "receipt"],
        all_required(2),
        ResponseError::InvalidPayload,
        |field, parser| match field {
            0 => validate_message(parser),
            1 => parser.optional(validate_receipt),
            _ => unreachable!(),
        },
    )?;
    Ok(())
}

fn validate_outgoing_page(input: &str) -> Result<(), ResponseError> {
    exact_object(
        input,
        [
            "messages",
            "next_cursor",
            "resume_position",
            "snapshot_high_sequence",
        ],
        |field, parser| match field {
            0 => parser.array(MAX_MAILBOX_PAGE_ITEMS, validate_message_state),
            1 => parser.optional(|parser| parser.id("c_")),
            2 => validate_navigation_position(parser),
            3 => parser.sequence(),
            _ => unreachable!(),
        },
    )
}

fn validate_message_state(parser: &mut Parser<'_>) -> Result<(), ResponseError> {
    parser.object(
        ["message", "recipients"],
        all_required(2),
        ResponseError::InvalidPayload,
        |field, parser| match field {
            0 => validate_message(parser),
            1 => parser.nonempty_array(MAX_RECIPIENTS_PER_MESSAGE, validate_recipient_state),
            _ => unreachable!(),
        },
    )?;
    Ok(())
}

fn validate_message(parser: &mut Parser<'_>) -> Result<(), ResponseError> {
    parser.object(
        [
            "message_id",
            "group_id",
            "group_sequence",
            "sender_peer_id",
            "sender_binding_revision",
            "client_key",
            "body",
            "topic",
            "reply_to",
            "attachments",
        ],
        all_required(10),
        ResponseError::InvalidPayload,
        |field, parser| match field {
            0 => parser.id("m_"),
            1 => parser.id("g_"),
            2 => parser.sequence(),
            3 => parser.id("p_"),
            4 => parser.revision(),
            5 => parser.text(1, MAX_CLIENT_KEY_BYTES),
            6 => parser.text(1, MAX_MESSAGE_BODY_BYTES),
            7 => parser.optional(|parser| parser.text(1, MAX_TOPIC_BYTES)),
            8 => parser.optional(|parser| parser.id("m_")),
            9 => parser.array(MAX_ATTACHMENTS_PER_MESSAGE, validate_attachment_record),
            _ => unreachable!(),
        },
    )?;
    Ok(())
}

fn validate_attachment_record(parser: &mut Parser<'_>) -> Result<(), ResponseError> {
    parser.object(
        [
            "source_reference_id",
            "source_id",
            "source_kind",
            "owner_peer_id",
            "snapshot_reference",
        ],
        all_required(5),
        ResponseError::InvalidPayload,
        |field, parser| match field {
            0 => parser.id("s_"),
            1 => parser.id("src_"),
            2 => parser.text(1, MAX_LABEL_BYTES),
            3 => parser.id("p_"),
            4 => parser.optional(|parser| parser.text(1, MAX_METADATA_BYTES)),
            _ => unreachable!(),
        },
    )?;
    Ok(())
}

fn validate_receipt(parser: &mut Parser<'_>) -> Result<(), ResponseError> {
    parser.object(
        [
            "message_id",
            "recipient_peer_id",
            "binding_revision",
            "generation",
            "fetched_at_millis",
            "acknowledged_at_millis",
        ],
        all_required(6),
        ResponseError::InvalidPayload,
        |field, parser| match field {
            0 => parser.id("m_"),
            1 => parser.id("p_"),
            2 | 3 => parser.revision(),
            4 | 5 => parser.optional(Parser::signed_number),
            _ => unreachable!(),
        },
    )?;
    Ok(())
}

fn validate_recipient_state(parser: &mut Parser<'_>) -> Result<(), ResponseError> {
    parser.object(
        [
            "peer_id",
            "original_binding_revision",
            "current_binding_revision",
            "generation",
            "fetched_at_millis",
            "acknowledged_at_millis",
            "replied_by",
        ],
        all_required(7),
        ResponseError::InvalidPayload,
        |field, parser| match field {
            0 => parser.id("p_"),
            1..=3 => parser.revision(),
            4 | 5 => parser.optional(Parser::signed_number),
            6 => parser.optional(|parser| parser.id("m_")),
            _ => unreachable!(),
        },
    )?;
    Ok(())
}

fn validate_navigation_position(parser: &mut Parser<'_>) -> Result<(), ResponseError> {
    parser.object(
        [
            "group_id",
            "peer_id",
            "binding_revision",
            "policy_revision",
            "scope",
            "after_sequence",
        ],
        all_required(6),
        ResponseError::InvalidPayload,
        |field, parser| match field {
            0 => parser.id("g_"),
            1 => parser.id("p_"),
            2 | 3 => parser.revision(),
            4 => validate_navigation_scope(parser),
            5 => parser.sequence(),
            _ => unreachable!(),
        },
    )?;
    Ok(())
}

fn validate_navigation_scope(parser: &mut Parser<'_>) -> Result<(), ResponseError> {
    if parser.peek() == Some(b'"') {
        return parser.one_of(&["mailbox", "outgoing"]);
    }
    parser.object(
        ["thread"],
        all_required(1),
        ResponseError::InvalidPayload,
        |_, parser| {
            parser.object(
                ["root"],
                all_required(1),
                ResponseError::InvalidPayload,
                |_, parser| parser.id("m_"),
            )?;
            Ok(())
        },
    )?;
    Ok(())
}

fn validate_acknowledgement(input: &str) -> Result<(), ResponseError> {
    exact_object(
        input,
        [
            "message_id",
            "generation",
            "acknowledged_at_millis",
            "contiguous_group_sequence",
        ],
        |field, parser| match field {
            0 => parser.id("m_"),
            1 => parser.revision(),
            2 => parser.signed_number(),
            3 => parser.sequence(),
            _ => unreachable!(),
        },
    )
}

fn validate_attachment_view(input: &str) -> Result<(), ResponseError> {
    exact_object(
        input,
        ["group_id", "message_id", "attachment", "availability"],
        |field, parser| match field {
            0 => parser.id("g_"),
            1 => parser.id("m_"),
            2 => validate_attachment_record(parser),
            3 => validate_source_availability(parser),
            _ => unreachable!(),
        },
    )
}

fn validate_source_availability(parser: &mut Parser<'_>) -> Result<(), ResponseError> {
    if parser.peek() == Some(b'"') {
        return parser.one_of(&["withdrawn", "replaced", "stale_binding", "owner_not_member"]);
    }
    let seen = parser.object(
        ["available", "stale"],
        0,
        ResponseError::InvalidPayload,
        |field, parser| match field {
            0 => {
                parser.object(
                    ["registration_epoch"],
                    all_required(1),
                    ResponseError::InvalidPayload,
                    |_, parser| parser.revision(),
                )?;
                Ok(())
            }
            1 => {
                parser.object(
                    ["cited_epoch", "current_epoch"],
                    all_required(2),
                    ResponseError::InvalidPayload,
                    |_, parser| parser.revision(),
                )?;
                Ok(())
            }
            _ => unreachable!(),
        },
    )?;
    if seen.count_ones() != 1 {
        return Err(ResponseError::InvalidPayload);
    }
    Ok(())
}

fn validate_error_payload(input: &str) -> Result<(), ResponseError> {
    let mut parser = Parser::new(input);
    let mut permits_revision_details = false;
    let seen = parser.object(
        ["code", "message", "details"],
        0b011,
        ResponseError::InvalidPayload,
        |field, parser| match field {
            0 => {
                let code = parser.string(ResponseError::InvalidPayload)?;
                const ERROR_CODES: [&str; 18] = [
                    "invalid_request",
                    "unavailable",
                    "unauthorized",
                    "not_found",
                    "stale_policy",
                    "stale_binding",
                    "binding_offline",
                    "group_paused",
                    "stale_snapshot",
                    "stale_source_epoch",
                    "source_unavailable",
                    "lease_consumed",
                    "validation",
                    "admission",
                    "outcome_unknown",
                    "store",
                    "transport",
                    "internal",
                ];
                if !ERROR_CODES
                    .iter()
                    .any(|candidate| decoded_string_matches(code, candidate))
                {
                    return Err(ResponseError::InvalidPayload);
                }
                permits_revision_details = ["stale_policy", "stale_snapshot", "stale_source_epoch"]
                    .iter()
                    .any(|candidate| decoded_string_matches(code, candidate));
                Ok(())
            }
            1 => parser.text(0, MAX_ERROR_MESSAGE_BYTES),
            2 => parser
                .object(
                    ["expected", "actual"],
                    all_required(2),
                    ResponseError::InvalidPayload,
                    |_, parser| parser.decimal_u64(),
                )
                .map(|_| ()),
            _ => unreachable!(),
        },
    )?;
    if seen & 0b100 != 0 && !permits_revision_details {
        return Err(ResponseError::InvalidPayload);
    }
    parser.finish(ResponseError::InvalidPayload)
}

fn exact_object<const N: usize, F>(
    input: &str,
    fields: [&str; N],
    visit: F,
) -> Result<(), ResponseError>
where
    F: FnMut(usize, &mut Parser<'_>) -> Result<(), ResponseError>,
{
    let mut parser = Parser::new(input);
    parser.object(
        fields,
        all_required(N),
        ResponseError::InvalidPayload,
        visit,
    )?;
    parser.finish(ResponseError::InvalidPayload)
}

const fn all_required(fields: usize) -> u64 {
    if fields == 64 {
        u64::MAX
    } else {
        (1_u64 << fields) - 1
    }
}

struct Parser<'a> {
    input: &'a str,
    position: usize,
}

impl<'a> Parser<'a> {
    fn new(input: &'a str) -> Self {
        Self { input, position: 0 }
    }

    fn finish(&mut self, error: ResponseError) -> Result<(), ResponseError> {
        self.skip_whitespace();
        if self.position == self.input.len() {
            Ok(())
        } else {
            Err(error)
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip_whitespace();
        self.input.as_bytes().get(self.position).copied()
    }

    fn object<const N: usize, F>(
        &mut self,
        fields: [&str; N],
        required: u64,
        error: ResponseError,
        mut visit: F,
    ) -> Result<u64, ResponseError>
    where
        F: FnMut(usize, &mut Self) -> Result<(), ResponseError>,
    {
        self.byte(b'{', error)?;
        let mut seen = 0_u64;
        if self.peek() == Some(b'}') {
            self.position += 1;
            return if seen & required == required {
                Ok(seen)
            } else {
                Err(error)
            };
        }
        loop {
            let key = self.string(error)?;
            let field = fields
                .iter()
                .position(|candidate| decoded_string_matches(key, candidate))
                .ok_or(error)?;
            let bit = 1_u64.checked_shl(field as u32).ok_or(error)?;
            if seen & bit != 0 {
                return Err(error);
            }
            seen |= bit;
            self.byte(b':', error)?;
            visit(field, self)?;
            match self.peek() {
                Some(b',') => self.position += 1,
                Some(b'}') => {
                    self.position += 1;
                    break;
                }
                _ => return Err(error),
            }
        }
        if seen & required != required {
            return Err(error);
        }
        Ok(seen)
    }

    fn array<F>(&mut self, maximum: usize, visit: F) -> Result<(), ResponseError>
    where
        F: FnMut(&mut Self) -> Result<(), ResponseError>,
    {
        self.array_count(maximum, visit).map(|_| ())
    }

    fn nonempty_array<F>(&mut self, maximum: usize, visit: F) -> Result<(), ResponseError>
    where
        F: FnMut(&mut Self) -> Result<(), ResponseError>,
    {
        if self.array_count(maximum, visit)? == 0 {
            Err(ResponseError::InvalidPayload)
        } else {
            Ok(())
        }
    }

    fn array_count<F>(&mut self, maximum: usize, mut visit: F) -> Result<usize, ResponseError>
    where
        F: FnMut(&mut Self) -> Result<(), ResponseError>,
    {
        self.byte(b'[', ResponseError::InvalidPayload)?;
        let mut count = 0_usize;
        if self.peek() == Some(b']') {
            self.position += 1;
            return Ok(0);
        }
        loop {
            if count == maximum {
                return Err(ResponseError::InvalidPayload);
            }
            visit(self)?;
            count += 1;
            match self.peek() {
                Some(b',') => self.position += 1,
                Some(b']') => {
                    self.position += 1;
                    return Ok(count);
                }
                _ => return Err(ResponseError::InvalidPayload),
            }
        }
    }

    fn optional<F>(&mut self, visit: F) -> Result<(), ResponseError>
    where
        F: FnOnce(&mut Self) -> Result<(), ResponseError>,
    {
        if self.literal_if(b"null") {
            Ok(())
        } else {
            visit(self)
        }
    }

    fn id(&mut self, prefix: &str) -> Result<(), ResponseError> {
        let token = self.string(ResponseError::InvalidPayload)?;
        let expected_len = prefix.len() + 32;
        let valid = decoded_string_satisfies(token, |index, byte| {
            if index < prefix.len() {
                prefix.as_bytes().get(index) == Some(&byte)
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        }) == Some(expected_len);
        if valid {
            Ok(())
        } else {
            Err(ResponseError::InvalidPayload)
        }
    }

    fn text(&mut self, minimum: usize, maximum: usize) -> Result<(), ResponseError> {
        let token = self.string(ResponseError::InvalidPayload)?;
        match decoded_string_satisfies(token, |index, _| index < maximum) {
            Some(length) if (minimum..=maximum).contains(&length) => Ok(()),
            _ => Err(ResponseError::InvalidPayload),
        }
    }

    fn one_of(&mut self, values: &[&str]) -> Result<(), ResponseError> {
        let token = self.string(ResponseError::InvalidPayload)?;
        if values
            .iter()
            .any(|value| decoded_string_matches(token, value))
        {
            Ok(())
        } else {
            Err(ResponseError::InvalidPayload)
        }
    }

    fn boolean(&mut self) -> Result<(), ResponseError> {
        if self.literal_if(b"true") || self.literal_if(b"false") {
            Ok(())
        } else {
            Err(ResponseError::InvalidPayload)
        }
    }

    fn revision(&mut self) -> Result<(), ResponseError> {
        match self.unsigned_number(ResponseError::InvalidPayload) {
            Ok(1..=MAX_SQL_U64) => Ok(()),
            _ => Err(ResponseError::InvalidPayload),
        }
    }

    fn sequence(&mut self) -> Result<(), ResponseError> {
        match self.unsigned_number(ResponseError::InvalidPayload) {
            Ok(0..=MAX_SQL_U64) => Ok(()),
            _ => Err(ResponseError::InvalidPayload),
        }
    }

    fn signed_number(&mut self) -> Result<(), ResponseError> {
        let token = self.scalar(ResponseError::InvalidPayload)?;
        if parse_i64(token).is_some() {
            Ok(())
        } else {
            Err(ResponseError::InvalidPayload)
        }
    }

    fn decimal_u64(&mut self) -> Result<(), ResponseError> {
        let token = self.string(ResponseError::InvalidPayload)?;
        let mut value = 0_u64;
        let mut first = None;
        let valid = decoded_string_satisfies(token, |index, byte| {
            if !byte.is_ascii_digit() || index >= 20 {
                return false;
            }
            first.get_or_insert(byte);
            value = match value
                .checked_mul(10)
                .and_then(|current| current.checked_add(u64::from(byte - b'0')))
            {
                Some(value) => value,
                None => return false,
            };
            true
        });
        match valid {
            Some(length) if length != 0 && (length == 1 || first != Some(b'0')) => Ok(()),
            _ => Err(ResponseError::InvalidPayload),
        }
    }

    fn unsigned_number(&mut self, error: ResponseError) -> Result<u64, ResponseError> {
        parse_u64(self.scalar(error)?).ok_or(error)
    }

    fn value_span(&mut self, error: ResponseError) -> Result<&'a str, ResponseError> {
        self.skip_whitespace();
        let start = self.position;
        let bytes = self.input.as_bytes();
        match bytes.get(start).copied().ok_or(error)? {
            b'"' => self.position = string_end(bytes, start).ok_or(error)?,
            b'{' | b'[' => {
                let mut depth = 0_usize;
                let mut index = start;
                while index < bytes.len() {
                    match bytes[index] {
                        b'"' => index = string_end(bytes, index).ok_or(error)?,
                        b'{' | b'[' => {
                            depth += 1;
                            index += 1;
                        }
                        b'}' | b']' => {
                            depth = depth.checked_sub(1).ok_or(error)?;
                            index += 1;
                            if depth == 0 {
                                self.position = index;
                                break;
                            }
                        }
                        _ => index += 1,
                    }
                }
                if depth != 0 {
                    return Err(error);
                }
            }
            _ => {
                while self.position < bytes.len()
                    && !matches!(
                        bytes[self.position],
                        b',' | b'}' | b']' | b' ' | b'\t' | b'\r' | b'\n'
                    )
                {
                    self.position += 1;
                }
            }
        }
        if self.position == start {
            Err(error)
        } else {
            Ok(&self.input[start..self.position])
        }
    }

    fn string(&mut self, error: ResponseError) -> Result<&'a str, ResponseError> {
        self.skip_whitespace();
        let start = self.position;
        if self.input.as_bytes().get(start) != Some(&b'"') {
            return Err(error);
        }
        self.position = string_end(self.input.as_bytes(), start).ok_or(error)?;
        Ok(&self.input[start..self.position])
    }

    fn scalar(&mut self, error: ResponseError) -> Result<&'a str, ResponseError> {
        self.skip_whitespace();
        let start = self.position;
        let bytes = self.input.as_bytes();
        while self.position < bytes.len()
            && !matches!(
                bytes[self.position],
                b',' | b'}' | b']' | b' ' | b'\t' | b'\r' | b'\n'
            )
        {
            self.position += 1;
        }
        if start == self.position {
            Err(error)
        } else {
            Ok(&self.input[start..self.position])
        }
    }

    fn byte(&mut self, expected: u8, error: ResponseError) -> Result<(), ResponseError> {
        self.skip_whitespace();
        if self.input.as_bytes().get(self.position) == Some(&expected) {
            self.position += 1;
            Ok(())
        } else {
            Err(error)
        }
    }

    fn literal_if(&mut self, literal: &[u8]) -> bool {
        self.skip_whitespace();
        let rest = &self.input.as_bytes()[self.position..];
        if rest.starts_with(literal) {
            self.position += literal.len();
            true
        } else {
            false
        }
    }

    fn skip_whitespace(&mut self) {
        while self
            .input
            .as_bytes()
            .get(self.position)
            .is_some_and(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
        {
            self.position += 1;
        }
    }
}

fn string_end(input: &[u8], start: usize) -> Option<usize> {
    if input.get(start) != Some(&b'"') {
        return None;
    }
    let mut index = start + 1;
    while index < input.len() {
        match input[index] {
            b'"' => return Some(index + 1),
            b'\\' => index = index.checked_add(2)?,
            _ => index += 1,
        }
    }
    None
}

fn parse_u64(token: &str) -> Option<u64> {
    let bytes = token.as_bytes();
    if bytes.is_empty() || (bytes.len() > 1 && bytes[0] == b'0') {
        return None;
    }
    bytes.iter().try_fold(0_u64, |value, byte| {
        if !byte.is_ascii_digit() {
            return None;
        }
        value.checked_mul(10)?.checked_add(u64::from(*byte - b'0'))
    })
}

fn parse_i64(token: &str) -> Option<i64> {
    let (negative, digits) = match token.as_bytes().first() {
        Some(b'-') => (true, &token[1..]),
        Some(_) => (false, token),
        None => return None,
    };
    if digits.is_empty() || (digits.len() > 1 && digits.as_bytes()[0] == b'0') {
        return None;
    }
    let magnitude = parse_u64(digits)?;
    if negative {
        if magnitude == 0 {
            return None;
        }
        if magnitude == (i64::MAX as u64) + 1 {
            Some(i64::MIN)
        } else {
            i64::try_from(magnitude).ok().map(|value| -value)
        }
    } else {
        i64::try_from(magnitude).ok()
    }
}

fn decoded_string_matches(token: &str, expected: &str) -> bool {
    decoded_string_satisfies(token, |index, byte| {
        expected.as_bytes().get(index) == Some(&byte)
    }) == Some(expected.len())
}

fn decoded_string_satisfies<F>(token: &str, mut accept: F) -> Option<usize>
where
    F: FnMut(usize, u8) -> bool,
{
    let bytes = token.as_bytes();
    if bytes.len() < 2 || bytes.first() != Some(&b'"') || bytes.last() != Some(&b'"') {
        return None;
    }
    let mut input = 1_usize;
    let end = bytes.len() - 1;
    let mut output = 0_usize;
    while input < end {
        if bytes[input] != b'\\' {
            if !accept(output, bytes[input]) {
                return None;
            }
            output += 1;
            input += 1;
            continue;
        }
        input += 1;
        let escaped = *bytes.get(input)?;
        input += 1;
        let simple = match escaped {
            b'"' | b'\\' | b'/' => Some(escaped),
            b'b' => Some(0x08),
            b'f' => Some(0x0c),
            b'n' => Some(b'\n'),
            b'r' => Some(b'\r'),
            b't' => Some(b'\t'),
            b'u' => None,
            _ => return None,
        };
        if let Some(byte) = simple {
            if !accept(output, byte) {
                return None;
            }
            output += 1;
            continue;
        }
        let high = parse_hex4(bytes.get(input..input + 4)?)?;
        input += 4;
        let scalar = if (0xd800..=0xdbff).contains(&high) {
            if bytes.get(input..input + 2)? != b"\\u" {
                return None;
            }
            input += 2;
            let low = parse_hex4(bytes.get(input..input + 4)?)?;
            input += 4;
            if !(0xdc00..=0xdfff).contains(&low) {
                return None;
            }
            0x1_0000 + (((u32::from(high) - 0xd800) << 10) | (u32::from(low) - 0xdc00))
        } else if (0xdc00..=0xdfff).contains(&high) {
            return None;
        } else {
            u32::from(high)
        };
        let character = char::from_u32(scalar)?;
        let mut encoded = [0_u8; 4];
        for byte in character.encode_utf8(&mut encoded).bytes() {
            if !accept(output, byte) {
                return None;
            }
            output += 1;
        }
    }
    Some(output)
}

fn parse_hex4(bytes: &[u8]) -> Option<u16> {
    if bytes.len() != 4 {
        return None;
    }
    bytes.iter().try_fold(0_u16, |value, byte| {
        let digit = match byte {
            b'0'..=b'9' => u16::from(*byte - b'0'),
            b'a'..=b'f' => u16::from(*byte - b'a' + 10),
            b'A'..=b'F' => u16::from(*byte - b'A' + 10),
            _ => return None,
        };
        value.checked_mul(16)?.checked_add(digit)
    })
}
