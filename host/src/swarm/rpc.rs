//! Strict typed domain RPC over the version 1 frame transport.
//!
//! Every request is a `deny_unknown_fields` envelope with an explicit
//! version, a bounded correlation identifier and an adjacently tagged
//! operation. Owner and peer operations are separate enums: an owner frame
//! can never name a peer operation and a peer frame can never name an owner
//! operation. Requests never carry caller identity, role, PID or sender
//! fields; identity comes from native connection evidence after the fixed
//! per-endpoint handshake. Large integers cross the wire as exact decimal
//! strings (`DecimalU64`).
//!
//! Each connection has a dedicated reader task feeding a bounded queue of
//! decoded frames; the framed read is never cancelled while idle. Responses
//! and event hints are written by the session task. Context publication uses
//! a private destination token bound to one connection, one request slot
//! and one generated destination identity.

use crate::swarm::events::EventHint;
use crate::swarm::output::{OutputBudget, OutputPermit, CONTROL_OUTPUT_BYTES};
use crate::swarm::runtime::{ConnectionRole, OutputKind, Shared, SourceReadError};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, VecDeque};
use std::io::{self, Write as _};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use termx_swarm_client::{
    DecimalU64, FrameCreditHandle, OwnerClient, PeerClient, ReservedFrameSend, VerifiedPipe,
    WireError,
};
use termx_swarm_core::error::{StoreError, ValidationError};
use termx_swarm_core::model::{
    AcknowledgementResult, CommittedPublication, DestinationReservation, GroupId, GroupRecord,
    MailboxNavigation, MailboxPage, MessageId, OutgoingPage, OwnedDestinationCredits,
    OwnerSnapshotPage, OwnerSnapshotRequest, PeerBindingRecord, PeerId, PeerMetadataUpdate,
    PeerPage, PreparedPublication, PublicationCommitment, PublicationDestinationId, Revision,
    SelfView, SendMessageRequest, SendReceipt, SourceAttachment, SourceId, SourceReferenceId,
    SourceSnapshotObservation, StateRevisions, StatusRecord, ThreadPage, MAX_MAILBOX_PAGE_BYTES,
    MAX_METADATA_PAGE_BYTES, MAX_PUBLICATION_BYTES,
};
use termx_swarm_core::worker::{AdmissionError, Command, OperationError, Response};
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;

pub const SWARM_RPC_VERSION: u16 = 1;
pub const MAX_CORRELATION_ID_BYTES: usize = 128;
/// Decoded-but-unprocessed frames retained per connection.
pub const MAX_PENDING_REQUESTS: usize = 8;
/// Largest request frame a session decodes. Message bodies are bounded to
/// 1 MiB by the core; anything larger is not a legitimate request.
pub const MAX_REQUEST_FRAME_BYTES: usize = 4 * 1024 * 1024;
/// Malformed frames tolerated before a connection is closed.
pub const MAX_MALFORMED_FRAMES: u32 = 8;
pub const MAX_ERROR_MESSAGE_BYTES: usize = 4 * 1024;
const ERROR_TRUNCATION_SUFFIX: &str = "…[truncated]";
const DECODED_REQUEST_BASE_BYTES: usize = 64 * 1024;
const DECODED_REQUEST_EXPANSION: usize = 4;
const RESPONSE_WRAPPER_BYTES: usize = 64 * 1024;
const CONTROL_RETAINED_BYTES: usize = 64 * 1024;
const CONTROL_ENCODED_BYTES: usize = 128 * 1024;
const SEND_RETAINED_BYTES: usize = 2 * 1024 * 1024;
const METADATA_RETAINED_BYTES: usize = 8 * 1024 * 1024;
const MESSAGE_RETAINED_BYTES: usize = 32 * 1024 * 1024;
/// Wire body capacity above the publication bytes. Together with the native
/// four-byte frame prefix this stays within the core's 64 KiB destination
/// reservation overhead.
pub const PUBLICATION_HEADER_ALLOWANCE: usize = 60 * 1024;
const PUBLICATION_METADATA_RETAINED_BYTES: usize = 64 * 1024;
/// Events buffered on the client side while awaiting a response.
pub const MAX_BUFFERED_CLIENT_EVENTS: usize = 256;

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CORRELATION_ID_BYTES
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn decimal(revision: Revision) -> DecimalU64 {
    DecimalU64::new(revision.get())
}

fn revision(value: DecimalU64, field: &'static str) -> Result<Revision, ErrorPayload> {
    Revision::new(value.get())
        .map_err(|_| ErrorPayload::invalid(format!("{field} must be a positive revision")))
}

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OwnerRequest {
    pub version: u16,
    pub correlation_id: String,
    pub operation: OwnerOperation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PeerRequest {
    pub version: u16,
    pub correlation_id: String,
    pub operation: PeerOperation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "params",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OwnerOperation {
    /// Small counters only; never a store read.
    Health(Empty),
    Revisions(Empty),
    /// Registers for revision hints, then returns the current tuple.
    Subscribe(Empty),
    Snapshot(SnapshotParams),
    CreateGroup {
        label: String,
        members: BTreeSet<PeerId>,
    },
    Membership {
        group_id: GroupId,
        peer_id: PeerId,
        active: bool,
        expected_policy_revision: DecimalU64,
    },
    Pause {
        group_id: GroupId,
        paused: bool,
        expected_policy_revision: DecimalU64,
    },
    UpdatePeer {
        peer_id: PeerId,
        expected_binding_revision: DecimalU64,
        model_metadata: Option<String>,
        is_live: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "scope",
    content = "page",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SnapshotParams {
    Peers {
        expected_inventory_revision: Option<DecimalU64>,
        after_peer: Option<PeerId>,
        max_items: u32,
    },
    Groups {
        expected_inventory_revision: Option<DecimalU64>,
        after_group: Option<GroupId>,
        max_items: u32,
    },
    PeerMemberships {
        peer_id: PeerId,
        expected_inventory_revision: Option<DecimalU64>,
        after_group: Option<GroupId>,
        max_items: u32,
    },
    PeerSources {
        peer_id: PeerId,
        expected_inventory_revision: Option<DecimalU64>,
        after_source: Option<SourceId>,
        max_items: u32,
    },
    GroupMembers {
        group_id: GroupId,
        expected_inventory_revision: Option<DecimalU64>,
        after_peer: Option<PeerId>,
        max_items: u32,
    },
    Messages {
        group_id: GroupId,
        after_sequence: DecimalU64,
        through_sequence: Option<DecimalU64>,
        max_items: u32,
    },
}

impl SnapshotParams {
    fn into_request(self) -> Result<OwnerSnapshotRequest, ErrorPayload> {
        let expected = |value: Option<DecimalU64>| -> Result<Option<Revision>, ErrorPayload> {
            value
                .map(|value| revision(value, "expectedInventoryRevision"))
                .transpose()
        };
        Ok(match self {
            Self::Peers {
                expected_inventory_revision,
                after_peer,
                max_items,
            } => OwnerSnapshotRequest::Peers {
                expected_inventory_revision: expected(expected_inventory_revision)?,
                after_peer,
                max_items: max_items as usize,
            },
            Self::Groups {
                expected_inventory_revision,
                after_group,
                max_items,
            } => OwnerSnapshotRequest::Groups {
                expected_inventory_revision: expected(expected_inventory_revision)?,
                after_group,
                max_items: max_items as usize,
            },
            Self::PeerMemberships {
                peer_id,
                expected_inventory_revision,
                after_group,
                max_items,
            } => OwnerSnapshotRequest::PeerMemberships {
                peer_id,
                expected_inventory_revision: expected(expected_inventory_revision)?,
                after_group,
                max_items: max_items as usize,
            },
            Self::PeerSources {
                peer_id,
                expected_inventory_revision,
                after_source,
                max_items,
            } => OwnerSnapshotRequest::PeerSources {
                peer_id,
                expected_inventory_revision: expected(expected_inventory_revision)?,
                after_source,
                max_items: max_items as usize,
            },
            Self::GroupMembers {
                group_id,
                expected_inventory_revision,
                after_peer,
                max_items,
            } => OwnerSnapshotRequest::GroupMembers {
                group_id,
                expected_inventory_revision: expected(expected_inventory_revision)?,
                after_peer,
                max_items: max_items as usize,
            },
            Self::Messages {
                group_id,
                after_sequence,
                through_sequence,
                max_items,
            } => OwnerSnapshotRequest::Messages {
                group_id,
                after_sequence: after_sequence.get(),
                through_sequence: through_sequence.map(DecimalU64::get),
                max_items: max_items as usize,
            },
        })
    }
}

/// Peer operations. Every content operation names its group explicitly;
/// the caller identity is the authenticated connection, never a field.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "params",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PeerOperation {
    WhoAmI {
        after_group: Option<GroupId>,
        max_items: u32,
    },
    ListPeers {
        group_id: GroupId,
        after_peer: Option<PeerId>,
        max_items: u32,
    },
    PublishStatus {
        group_id: GroupId,
        status: Option<String>,
    },
    Send {
        group_id: GroupId,
        client_key: String,
        recipients: BTreeSet<PeerId>,
        body: String,
        topic: Option<String>,
        reply_to: Option<MessageId>,
        #[serde(default)]
        attachments: Vec<SourceAttachment>,
    },
    MailboxAfter {
        group_id: GroupId,
        navigation: MailboxNavigation,
        max_items: u32,
    },
    ReadThread {
        group_id: GroupId,
        root: MessageId,
        navigation: MailboxNavigation,
        max_items: u32,
    },
    ReadOutgoing {
        group_id: GroupId,
        navigation: MailboxNavigation,
        max_items: u32,
    },
    Acknowledge {
        group_id: GroupId,
        message_id: MessageId,
    },
    ResolveAttachment {
        group_id: GroupId,
        source_reference_id: SourceReferenceId,
    },
    /// Lease, bounded trusted source read, destination reservation, final
    /// writer validation, then one protected publication on this connection.
    FetchContext {
        group_id: GroupId,
        source_id: SourceId,
    },
}

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ServerFrame {
    pub version: u16,
    pub message: ServerMessage,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "body",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ServerMessage {
    Response(Box<ResponseBody>),
    Event(EventBody),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResponseBody {
    pub correlation_id: String,
    pub outcome: Outcome,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "payload",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EventBody {
    /// Advisory: durable revisions changed. Compare the boot identifier and
    /// tuple with the last snapshot; resnapshot on any mismatch.
    Revisions(RevisionsPayload),
    /// This subscriber lagged; `skipped` hints were dropped. Resnapshot.
    Overflow {
        boot_id: String,
        skipped: DecimalU64,
    },
}

impl EventBody {
    fn boot_id(&self) -> &str {
        match self {
            Self::Revisions(payload) => &payload.boot_id,
            Self::Overflow { boot_id, .. } => boot_id,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RevisionsPayload {
    pub boot_id: String,
    pub inventory_revision: DecimalU64,
    pub delivery_revision: DecimalU64,
    pub run_revision: Option<DecimalU64>,
}

impl RevisionsPayload {
    pub fn new(boot_id: &str, revisions: StateRevisions) -> Self {
        Self {
            boot_id: boot_id.to_owned(),
            inventory_revision: decimal(revisions.inventory_revision),
            delivery_revision: decimal(revisions.delivery_revision),
            run_revision: revisions.run_revision.map(decimal),
        }
    }

    pub fn from_hint(hint: &EventHint) -> Self {
        Self::new(&hint.boot_id, hint.revisions)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkerCounters {
    pub accepted: DecimalU64,
    pub completed: DecimalU64,
    pub store_errors: DecimalU64,
    pub rejected: DecimalU64,
    pub abandoned_replies: DecimalU64,
    pub outcome_unknown: DecimalU64,
    pub requests: u32,
    pub responses: u32,
    pub request_bytes: DecimalU64,
    pub response_reserved_bytes: DecimalU64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TransportCounters {
    pub frame_bytes: DecimalU64,
    pub frames: DecimalU64,
    pub connections: u32,
    pub max_connections: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConnectionCounters {
    pub accepted: DecimalU64,
    pub rejected_handshakes: DecimalU64,
    pub owner_sessions: DecimalU64,
    pub peer_sessions: DecimalU64,
    pub unenrolled_peer_sessions: DecimalU64,
    pub active_sessions: DecimalU64,
    pub malformed_frames: DecimalU64,
    pub unenrolled_refusals: DecimalU64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EventCounters {
    pub published: DecimalU64,
    pub subscribers: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HealthPayload {
    pub boot_id: String,
    pub authority_id: String,
    pub gate_open: bool,
    pub worker: WorkerCounters,
    pub transport: TransportCounters,
    pub connections: ConnectionCounters,
    pub events: EventCounters,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    Unavailable,
    Unauthorized,
    NotFound,
    StalePolicy,
    StaleBinding,
    BindingOffline,
    GroupPaused,
    StaleSnapshot,
    StaleSourceEpoch,
    SourceUnavailable,
    LeaseConsumed,
    Validation,
    Admission,
    OutcomeUnknown,
    Store,
    Transport,
    Internal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ErrorPayload {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl ErrorPayload {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        let message = bounded_error_message(message.into());
        Self {
            code,
            message,
            details: None,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidRequest, message)
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unavailable, message)
    }

    fn with_expected_actual(mut self, expected: u64, actual: u64) -> Self {
        self.details = Some(serde_json::json!({
            "expected": DecimalU64::new(expected),
            "actual": DecimalU64::new(actual),
        }));
        self
    }
}

fn bounded_error_message(message: String) -> String {
    let (prefix, suffix) = if message.len() <= MAX_ERROR_MESSAGE_BYTES {
        (message.as_str(), "")
    } else {
        let mut end = MAX_ERROR_MESSAGE_BYTES.saturating_sub(ERROR_TRUNCATION_SUFFIX.len());
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        (&message[..end], ERROR_TRUNCATION_SUFFIX)
    };
    let mut bounded = String::with_capacity(prefix.len() + suffix.len());
    bounded.push_str(prefix);
    bounded.push_str(suffix);
    bounded.into_boxed_str().into_string()
}

impl From<StoreError> for ErrorPayload {
    fn from(error: StoreError) -> Self {
        let message = error.to_string();
        match error {
            StoreError::Unauthorized { .. } | StoreError::AuthorityMismatch => {
                Self::new(ErrorCode::Unauthorized, message)
            }
            StoreError::NotFound { .. } => Self::new(ErrorCode::NotFound, message),
            StoreError::StalePolicy { expected, actual } => {
                Self::new(ErrorCode::StalePolicy, message).with_expected_actual(expected, actual)
            }
            StoreError::StaleSnapshot { expected, actual } => {
                Self::new(ErrorCode::StaleSnapshot, message).with_expected_actual(expected, actual)
            }
            StoreError::StaleSourceEpoch { expected, actual } => {
                Self::new(ErrorCode::StaleSourceEpoch, message)
                    .with_expected_actual(expected, actual)
            }
            StoreError::StaleBinding => Self::new(ErrorCode::StaleBinding, message),
            StoreError::BindingOffline => Self::new(ErrorCode::BindingOffline, message),
            StoreError::GroupPaused => Self::new(ErrorCode::GroupPaused, message),
            StoreError::SourceUnavailable { .. } => {
                Self::new(ErrorCode::SourceUnavailable, message)
            }
            StoreError::LeaseConsumed | StoreError::ResponseAlreadyCommitted => {
                Self::new(ErrorCode::LeaseConsumed, message)
            }
            StoreError::Validation(_) => Self::new(ErrorCode::Validation, message),
            _ => Self::new(ErrorCode::Store, message),
        }
    }
}

impl From<ValidationError> for ErrorPayload {
    fn from(error: ValidationError) -> Self {
        Self::new(ErrorCode::Validation, error.to_string())
    }
}

impl From<OperationError> for ErrorPayload {
    fn from(error: OperationError) -> Self {
        match error {
            OperationError::Store(error) => error.into(),
            OperationError::OutcomeUnknown => {
                Self::new(ErrorCode::OutcomeUnknown, error.to_string())
            }
        }
    }
}

impl From<AdmissionError> for ErrorPayload {
    fn from(error: AdmissionError) -> Self {
        Self::new(ErrorCode::Admission, error.to_string())
    }
}

/// Durable audit record of one committed publication, followed on the wire
/// by exactly `body_bytes` raw bytes after a single newline.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ContextPublishedPayload {
    pub commitment_id: String,
    pub lease_id: String,
    pub response_id: String,
    pub destination_id: String,
    pub group_id: GroupId,
    pub policy_revision: DecimalU64,
    pub caller_peer_id: PeerId,
    pub caller_binding_revision: DecimalU64,
    pub source_id: SourceId,
    pub registration_epoch: DecimalU64,
    pub snapshot_identity: String,
    pub captured_through: Option<DecimalU64>,
    pub body_bytes: DecimalU64,
    pub committed_at_millis: i64,
    /// Filled on the client from the raw suffix; never JSON.
    #[serde(skip)]
    pub body: Vec<u8>,
}

impl ContextPublishedPayload {
    fn from_record(record: &PublicationCommitment, destination: &PublicationDestinationId) -> Self {
        Self {
            commitment_id: record.commitment_id().as_str().to_owned(),
            lease_id: record.lease_id().as_str().to_owned(),
            response_id: record.response_id().as_str().to_owned(),
            destination_id: destination.as_str().to_owned(),
            group_id: record.group_id().clone(),
            policy_revision: decimal(record.policy_revision()),
            caller_peer_id: record.caller_peer_id().clone(),
            caller_binding_revision: decimal(record.caller_binding_revision()),
            source_id: record.source_id().clone(),
            registration_epoch: decimal(record.registration_epoch()),
            snapshot_identity: record.snapshot_identity().to_owned(),
            captured_through: record.captured_through().map(DecimalU64::new),
            body_bytes: DecimalU64::new(record.body_bytes()),
            committed_at_millis: record.committed_at_millis(),
            body: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "payload",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Outcome {
    Health(HealthPayload),
    Revisions(RevisionsPayload),
    Subscribed(RevisionsPayload),
    Snapshot(OwnerSnapshotPage),
    Group(GroupRecord),
    Binding(PeerBindingRecord),
    Unit(Empty),
    SelfView(SelfView),
    Peers(PeerPage),
    Status(StatusRecord),
    Saved(SendReceipt),
    Mailbox(MailboxPage),
    Thread(ThreadPage),
    Outgoing(OutgoingPage),
    Acknowledged(AcknowledgementResult),
    /// `AttachmentView` serialized by the core; it has no deserializer.
    Attachment(serde_json::Value),
    ContextPublished(ContextPublishedPayload),
    Error(ErrorPayload),
}

impl Outcome {
    pub fn error(&self) -> Option<&ErrorPayload> {
        match self {
            Self::Error(error) => Some(error),
            _ => None,
        }
    }
}

fn outcome_from(response: Response) -> Outcome {
    match response {
        Response::Binding(binding) => Outcome::Binding(binding),
        Response::Group(group) => Outcome::Group(group),
        Response::Saved(receipt) => Outcome::Saved(receipt),
        Response::Mailbox(page) => Outcome::Mailbox(page),
        Response::Acknowledged(result) => Outcome::Acknowledged(result),
        Response::SelfView(view) => Outcome::SelfView(view),
        Response::Peers(page) => Outcome::Peers(page),
        Response::Status(status) => Outcome::Status(status),
        Response::Thread(page) => Outcome::Thread(page),
        Response::Outgoing(page) => Outcome::Outgoing(page),
        Response::Attachment(view) => match serde_json::to_value(&view) {
            Ok(value) => Outcome::Attachment(value),
            Err(error) => Outcome::Error(ErrorPayload::new(ErrorCode::Internal, error.to_string())),
        },
        Response::Snapshot(page) => Outcome::Snapshot(page),
        Response::Unit => Outcome::Unit(Empty {}),
        other => Outcome::Error(ErrorPayload::new(
            ErrorCode::Internal,
            format!("unexpected core response {}", response_label(&other)),
        )),
    }
}

fn response_label(response: &Response) -> &'static str {
    match response {
        Response::Owner(_) => "owner",
        Response::Inspection(_) => "inspection",
        Response::Recovered(_) => "recovered",
        Response::Enrolled(_) => "enrolled",
        Response::Principal(_) => "principal",
        Response::Binding(_) => "binding",
        Response::Group(_) => "group",
        Response::Saved(_) => "saved",
        Response::Mailbox(_) => "mailbox",
        Response::Acknowledged(_) => "acknowledged",
        Response::Candidates(_) => "candidates",
        Response::Ticket(_) => "ticket",
        Response::Attempt(_) => "attempt",
        Response::SelfView(_) => "self_view",
        Response::Peers(_) => "peers",
        Response::Status(_) => "status",
        Response::Thread(_) => "thread",
        Response::Outgoing(_) => "outgoing",
        Response::Attachment(_) => "attachment",
        Response::Source(_) => "source",
        Response::Lease(_) => "lease",
        Response::CommittedPublication(_) => "committed_publication",
        Response::Snapshot(_) => "snapshot",
        Response::Revisions(_) => "revisions",
        Response::Unit => "unit",
        #[allow(unreachable_patterns)]
        _ => "other",
    }
}

#[cfg(test)]
fn encode_frame(correlation_id: &str, outcome: Outcome) -> Vec<u8> {
    serde_json::to_vec(&ServerFrame {
        version: SWARM_RPC_VERSION,
        message: ServerMessage::Response(Box::new(ResponseBody {
            correlation_id: correlation_id.to_owned(),
            outcome,
        })),
    })
    .expect("server frames serialize")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResponseClass {
    Control,
    SendReceipt,
    MetadataPage,
    MessagePage,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ResponseBound {
    class: ResponseClass,
    retained_bytes: usize,
    encoded_bytes: usize,
}

impl ResponseBound {
    const fn for_class(class: ResponseClass) -> Self {
        match class {
            ResponseClass::Control => Self {
                class,
                retained_bytes: CONTROL_RETAINED_BYTES,
                encoded_bytes: CONTROL_ENCODED_BYTES,
            },
            ResponseClass::SendReceipt => Self {
                class,
                retained_bytes: SEND_RETAINED_BYTES,
                encoded_bytes: MAX_MAILBOX_PAGE_BYTES + RESPONSE_WRAPPER_BYTES,
            },
            ResponseClass::MetadataPage => Self {
                class,
                retained_bytes: METADATA_RETAINED_BYTES,
                encoded_bytes: MAX_METADATA_PAGE_BYTES + RESPONSE_WRAPPER_BYTES,
            },
            ResponseClass::MessagePage => Self {
                class,
                retained_bytes: MESSAGE_RETAINED_BYTES,
                encoded_bytes: MAX_MAILBOX_PAGE_BYTES + RESPONSE_WRAPPER_BYTES,
            },
        }
    }

    const fn total_bytes(self) -> usize {
        self.retained_bytes + self.encoded_bytes
    }
}

fn owner_response_bound(operation: &OwnerOperation) -> ResponseBound {
    let class = match operation {
        OwnerOperation::Snapshot(SnapshotParams::Messages { .. }) => ResponseClass::MessagePage,
        OwnerOperation::Snapshot(_) => ResponseClass::MetadataPage,
        OwnerOperation::Health(_)
        | OwnerOperation::Revisions(_)
        | OwnerOperation::Subscribe(_)
        | OwnerOperation::CreateGroup { .. }
        | OwnerOperation::Membership { .. }
        | OwnerOperation::Pause { .. }
        | OwnerOperation::UpdatePeer { .. } => ResponseClass::Control,
    };
    ResponseBound::for_class(class)
}

fn peer_response_bound(operation: &PeerOperation) -> ResponseBound {
    let class = match operation {
        PeerOperation::WhoAmI { .. } | PeerOperation::ListPeers { .. } => {
            ResponseClass::MetadataPage
        }
        PeerOperation::Send { .. } => ResponseClass::SendReceipt,
        PeerOperation::MailboxAfter { .. }
        | PeerOperation::ReadThread { .. }
        | PeerOperation::ReadOutgoing { .. } => ResponseClass::MessagePage,
        PeerOperation::PublishStatus { .. }
        | PeerOperation::Acknowledge { .. }
        | PeerOperation::ResolveAttachment { .. }
        | PeerOperation::FetchContext { .. } => ResponseClass::Control,
    };
    ResponseBound::for_class(class)
}

fn decoded_request_bound(encoded_bytes: usize) -> Option<usize> {
    encoded_bytes
        .checked_mul(DECODED_REQUEST_EXPANSION)?
        .checked_add(DECODED_REQUEST_BASE_BYTES)
}

fn reserve_decoded_request(output: &OutputBudget, decoded_bytes: usize) -> Option<OutputPermit> {
    if decoded_bytes <= CONTROL_OUTPUT_BYTES {
        output.reserve_control(decoded_bytes)
    } else {
        output.reserve_data(decoded_bytes)
    }
}

fn publication_output_bound(body_bytes: usize) -> Option<usize> {
    body_bytes
        .checked_add(PUBLICATION_HEADER_ALLOWANCE)?
        .checked_add(PUBLICATION_METADATA_RETAINED_BYTES)
}

struct BoundedJsonBuffer {
    bytes: Vec<u8>,
    limit: usize,
}

impl BoundedJsonBuffer {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(limit),
            limit,
        }
    }

    fn into_vec(self) -> Vec<u8> {
        self.bytes
    }
}

impl io::Write for BoundedJsonBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let next = self
            .bytes
            .len()
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::new(io::ErrorKind::WriteZero, "JSON output overflow"))?;
        if next > self.limit {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "JSON output exceeded its reserved representation",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn encode_frame_bounded(
    correlation_id: &str,
    outcome: Outcome,
    encoded_bytes: usize,
) -> Result<Vec<u8>, WireError> {
    let mut output = BoundedJsonBuffer::new(encoded_bytes);
    serde_json::to_writer(
        &mut output,
        &ServerFrame {
            version: SWARM_RPC_VERSION,
            message: ServerMessage::Response(Box::new(ResponseBody {
                correlation_id: correlation_id.to_owned(),
                outcome,
            })),
        },
    )
    .map_err(|_| WireError::FrameTooLarge)?;
    Ok(output.into_vec())
}

struct OutputOwner {
    permit: OutputPermit,
    bound: ResponseBound,
}

impl OutputOwner {
    fn reserve(budget: &OutputBudget, bound: ResponseBound) -> Option<Self> {
        let permit = if bound.class == ResponseClass::Control {
            budget.reserve_control(bound.total_bytes())
        } else {
            budget.reserve_data(bound.total_bytes())
        }?;
        Some(Self { permit, bound })
    }

    fn encode(mut self, correlation_id: &str, outcome: Outcome) -> Result<OwnedFrame, WireError> {
        let bytes = encode_frame_bounded(correlation_id, outcome, self.bound.encoded_bytes)?;
        self.permit
            .shrink_to(bytes.capacity())
            .map_err(|_| WireError::Capacity)?;
        Ok(OwnedFrame {
            bytes,
            _permit: self.permit,
        })
    }

    fn encode_event(mut self, event: EventBody) -> Result<OwnedFrame, WireError> {
        let mut output = BoundedJsonBuffer::new(self.bound.encoded_bytes);
        serde_json::to_writer(
            &mut output,
            &ServerFrame {
                version: SWARM_RPC_VERSION,
                message: ServerMessage::Event(event),
            },
        )
        .map_err(|_| WireError::FrameTooLarge)?;
        let bytes = output.into_vec();
        self.permit
            .shrink_to(bytes.capacity())
            .map_err(|_| WireError::Capacity)?;
        Ok(OwnedFrame {
            bytes,
            _permit: self.permit,
        })
    }
}

struct OwnedFrame {
    bytes: Vec<u8>,
    _permit: OutputPermit,
}

impl OwnedFrame {
    #[cfg(test)]
    fn capacity(&self) -> usize {
        self.bytes.capacity()
    }

    async fn write(
        self,
        pipe: &VerifiedPipe,
        shared: &Shared,
        kind: OutputKind,
    ) -> Result<(), WireError> {
        shared.observe_output(kind, self.bytes.len()).await;
        pipe.send_bytes(&self.bytes).await
    }
}

async fn send_control_response(
    pipe: &VerifiedPipe,
    shared: &Shared,
    correlation_id: &str,
    outcome: Outcome,
) -> Result<(), WireError> {
    let owner = OutputOwner::reserve(
        &shared.output,
        ResponseBound::for_class(ResponseClass::Control),
    )
    .ok_or(WireError::Capacity)?;
    owner
        .encode(correlation_id, outcome)?
        .write(pipe, shared, OutputKind::Response)
        .await
}

async fn send_control_event(
    pipe: &VerifiedPipe,
    shared: &Shared,
    event: EventBody,
) -> Result<(), WireError> {
    let owner = OutputOwner::reserve(
        &shared.output,
        ResponseBound::for_class(ResponseClass::Control),
    )
    .ok_or(WireError::Capacity)?;
    owner
        .encode_event(event)?
        .write(pipe, shared, OutputKind::Event)
        .await
}

// ---------------------------------------------------------------------------
// Protected publication
// ---------------------------------------------------------------------------

/// Host wrapper around the shared frame reservation. Reports the exact
/// reserved bytes and the handle's documented retained-heap bound.
#[derive(Debug)]
struct DestinationCredits(FrameCreditHandle);

impl OwnedDestinationCredits for DestinationCredits {
    fn reserved_bytes(&self) -> usize {
        self.0.reserved_bytes()
    }

    fn owned_heap_bytes(&self) -> usize {
        self.0.owned_heap_bytes()
    }
}

#[derive(Debug)]
pub enum PublicationError {
    Transport(WireError),
    Validation(ValidationError),
    BodyTooLarge,
    EmptyBody,
    OutputCapacity,
    /// The committed response was bound to a different destination.
    DestinationMismatch,
    HeaderTooLarge,
}

impl std::fmt::Display for PublicationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(error) => write!(f, "publication transport error: {error}"),
            Self::Validation(error) => write!(f, "publication validation error: {error}"),
            Self::BodyTooLarge => write!(f, "publication body exceeds the maximum"),
            Self::EmptyBody => write!(f, "publication body is empty"),
            Self::OutputCapacity => write!(f, "publication output capacity is unavailable"),
            Self::DestinationMismatch => {
                write!(f, "committed response is bound to another destination")
            }
            Self::HeaderTooLarge => write!(f, "publication header exceeds its allowance"),
        }
    }
}

impl std::error::Error for PublicationError {}

impl From<PublicationError> for ErrorPayload {
    fn from(error: PublicationError) -> Self {
        match error {
            PublicationError::Transport(inner) => {
                Self::new(ErrorCode::Transport, inner.to_string())
            }
            PublicationError::Validation(inner) => inner.into(),
            PublicationError::DestinationMismatch => {
                Self::new(ErrorCode::Validation, error.to_string())
            }
            _ => Self::new(ErrorCode::Validation, error.to_string()),
        }
    }
}

/// One destination for one publication: the sole send token of a
/// reservation on exactly one connection, the request slot it answers and a
/// generated destination identity. It exposes no token, no replacement and
/// no second reservation; `commit` consumes it.
pub struct ProtectedDestination {
    pipe: Arc<VerifiedPipe>,
    token: ReservedFrameSend,
    output: OutputPermit,
    destination_id: PublicationDestinationId,
    slot: String,
}

impl std::fmt::Debug for ProtectedDestination {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProtectedDestination")
            .field("destination_id", &self.destination_id)
            .field("slot", &self.slot)
            .field("body_capacity", &self.token.body_capacity())
            .finish_non_exhaustive()
    }
}

impl ProtectedDestination {
    /// Reserves `body_bytes` plus the header allowance on `pipe`. The
    /// returned `DestinationReservation` is the only credits guard this
    /// destination ever produces; the core consumes it during preparation.
    pub fn reserve(
        pipe: Arc<VerifiedPipe>,
        output: &OutputBudget,
        slot: &str,
        body_bytes: usize,
    ) -> Result<(Self, DestinationReservation), PublicationError> {
        if body_bytes == 0 {
            return Err(PublicationError::EmptyBody);
        }
        if body_bytes > MAX_PUBLICATION_BYTES {
            return Err(PublicationError::BodyTooLarge);
        }
        let output = output
            .reserve_data(
                publication_output_bound(body_bytes).ok_or(PublicationError::OutputCapacity)?,
            )
            .ok_or(PublicationError::OutputCapacity)?;
        let token = pipe
            .reserve_send(body_bytes + PUBLICATION_HEADER_ALLOWANCE)
            .map_err(PublicationError::Transport)?;
        let destination_id = PublicationDestinationId::generate();
        let reservation = DestinationReservation::from_owned(
            destination_id.clone(),
            DestinationCredits(token.credit_handle()),
        )
        .map_err(PublicationError::Validation)?;
        Ok((
            Self {
                pipe,
                token,
                output,
                destination_id,
                slot: slot.to_owned(),
            },
            reservation,
        ))
    }

    pub fn destination_id(&self) -> &PublicationDestinationId {
        &self.destination_id
    }

    pub fn slot(&self) -> &str {
        &self.slot
    }

    pub fn body_capacity(&self) -> usize {
        self.token.body_capacity()
    }

    /// Binds the committed response to this destination and encodes the
    /// exact immutable wire bytes. A response committed for another
    /// destination is rejected and its credits released; nothing is written.
    pub fn commit(
        self,
        committed: CommittedPublication,
    ) -> Result<ProtectedSend, PublicationError> {
        let send = committed
            .into_send(&self.destination_id)
            .map_err(|_| PublicationError::DestinationMismatch)?;
        let payload = ContextPublishedPayload::from_record(send.record(), &self.destination_id);
        let mut buffer = BoundedJsonBuffer::new(self.token.body_capacity());
        serde_json::to_writer(
            &mut buffer,
            &ServerFrame {
                version: SWARM_RPC_VERSION,
                message: ServerMessage::Response(Box::new(ResponseBody {
                    correlation_id: self.slot,
                    outcome: Outcome::ContextPublished(payload),
                })),
            },
        )
        .map_err(|_| PublicationError::HeaderTooLarge)?;
        buffer
            .write_all(b"\n")
            .and_then(|()| buffer.write_all(send.body()))
            .map_err(|_| PublicationError::HeaderTooLarge)?;
        let buffer = buffer.into_vec();
        // The core's body copy is released now; the send token still holds
        // its transport credit, while the host permit owns the fixed-capacity
        // wire buffer and retained commitment until the write completes or
        // drops.
        let record = send.finish();
        let mut output = self.output;
        output
            .shrink_to(buffer.capacity() + PUBLICATION_METADATA_RETAINED_BYTES)
            .map_err(|_| PublicationError::OutputCapacity)?;
        Ok(ProtectedSend {
            pipe: self.pipe,
            token: self.token,
            payload: PublicationPayload {
                buffer,
                record,
                _output: output,
            },
        })
    }
}

struct PublicationPayload {
    buffer: Vec<u8>,
    record: PublicationCommitment,
    /// Last: the encoded buffer and retained record drop before their owner.
    _output: OutputPermit,
}

/// The single wire write of one committed publication. No accessor can
/// replace or extract the bytes; `write` consumes the send.
pub struct ProtectedSend {
    pipe: Arc<VerifiedPipe>,
    token: ReservedFrameSend,
    payload: PublicationPayload,
}

impl std::fmt::Debug for ProtectedSend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProtectedSend")
            .field("encoded_bytes", &self.payload.buffer.len())
            .field("commitment_id", &self.payload.record.commitment_id())
            .finish_non_exhaustive()
    }
}

impl ProtectedSend {
    pub fn encoded_len(&self) -> usize {
        self.payload.buffer.len()
    }

    pub fn record(&self) -> &PublicationCommitment {
        &self.payload.record
    }

    /// Writes the exact committed bytes with the reserved token. No capacity
    /// wait can occur here: the reservation was taken before validation.
    pub(crate) async fn write(self, shared: &Shared) -> Result<(), WireError> {
        shared
            .observe_output(OutputKind::Publication, self.payload.buffer.len())
            .await;
        let Self {
            pipe,
            token,
            payload,
        } = self;
        let result = pipe.send_reserved(token, &payload.buffer).await;
        drop(payload);
        result
    }
}

// ---------------------------------------------------------------------------
// Server session
// ---------------------------------------------------------------------------

struct ActiveSession(Arc<Shared>);

impl Drop for ActiveSession {
    fn drop(&mut self) {
        self.0
            .counters
            .active_sessions
            .fetch_sub(1, Ordering::Relaxed);
    }
}

struct ReaderTask(Option<JoinHandle<()>>);

impl ReaderTask {
    fn new(handle: JoinHandle<()>) -> Self {
        Self(Some(handle))
    }

    async fn abort_and_join(&mut self) {
        if let Some(handle) = self.0.take() {
            handle.abort();
            let _ = handle.await;
        }
    }
}

impl Drop for ReaderTask {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            handle.abort();
        }
    }
}

/// Serves one authenticated connection until the peer disconnects, the gate
/// closes, or the connection misbehaves beyond the malformed-frame bound.
pub(crate) async fn run_session(
    pipe: Arc<VerifiedPipe>,
    role: ConnectionRole,
    shared: Arc<Shared>,
) {
    shared
        .counters
        .active_sessions
        .fetch_add(1, Ordering::Relaxed);
    let _active = ActiveSession(shared.clone());
    let (tx, mut rx) = mpsc::channel::<termx_swarm_client::ReceivedFrame>(MAX_PENDING_REQUESTS);
    let reader_pipe = pipe.clone();
    let mut reader = ReaderTask::new(tokio::spawn(shared.own_task(async move {
        while let Ok(frame) = reader_pipe.recv_bytes().await {
            if tx.send(frame).await.is_err() {
                break;
            }
        }
    })));

    let mut gate = shared.gate.subscribe();
    let mut events: Option<broadcast::Receiver<EventHint>> = None;
    let mut malformed = 0u32;
    loop {
        let closed = matches!(*gate.borrow(), crate::swarm::runtime::GateState::Closed);
        if closed {
            break;
        }
        let event = async {
            match events.as_mut() {
                Some(receiver) => receiver.recv().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            biased;
            changed = gate.changed() => {
                if changed.is_err() {
                    break;
                }
            }
            frame = rx.recv() => {
                let Some(frame) = frame else { break };
                match handle_frame(&pipe, &role, &shared, &mut events, frame.as_ref()).await {
                    Ok(true) => {}
                    Ok(false) => {
                        malformed += 1;
                        if malformed >= MAX_MALFORMED_FRAMES {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            event = event => {
                let body = match event {
                    Ok(hint) => EventBody::Revisions(RevisionsPayload::from_hint(&hint)),
                    Err(broadcast::error::RecvError::Lagged(skipped)) => EventBody::Overflow {
                        boot_id: shared.boot_id.clone(),
                        skipped: DecimalU64::new(skipped),
                    },
                    Err(broadcast::error::RecvError::Closed) => {
                        events = None;
                        continue;
                    }
                };
                if send_control_event(&pipe, &shared, body).await.is_err() {
                    break;
                }
            }
        }
    }
    reader.abort_and_join().await;
}

/// `Ok(true)`: a well-formed request was answered. `Ok(false)`: malformed
/// request, error answered. `Err`: the connection is unusable.
async fn handle_frame(
    pipe: &Arc<VerifiedPipe>,
    role: &ConnectionRole,
    shared: &Arc<Shared>,
    events: &mut Option<broadcast::Receiver<EventHint>>,
    bytes: &[u8],
) -> Result<bool, WireError> {
    if bytes.len() > MAX_REQUEST_FRAME_BYTES {
        shared
            .counters
            .malformed_frames
            .fetch_add(1, Ordering::Relaxed);
        send_control_response(
            pipe,
            shared,
            "malformed",
            Outcome::Error(ErrorPayload::invalid("request frame exceeds the maximum")),
        )
        .await?;
        return Ok(false);
    }
    let decoded_bytes = decoded_request_bound(bytes.len()).ok_or(WireError::Capacity)?;
    let _decoded_request = match reserve_decoded_request(&shared.output, decoded_bytes) {
        Some(permit) => permit,
        None => {
            send_control_response(
                pipe,
                shared,
                "malformed",
                Outcome::Error(ErrorPayload::new(
                    ErrorCode::Admission,
                    "host request capacity unavailable; request was not dispatched",
                )),
            )
            .await?;
            return Ok(true);
        }
    };
    let (correlation_id, outcome, malformed, output) = match role {
        ConnectionRole::Owner => match classify_request::<OwnerRequest>(bytes) {
            ClassifiedRequest::Valid(request) => {
                let output = match OutputOwner::reserve(
                    &shared.output,
                    owner_response_bound(&request.operation),
                ) {
                    Some(output) => output,
                    None => {
                        refuse_output_capacity(pipe, shared, &request.correlation_id).await?;
                        return Ok(true);
                    }
                };
                let outcome = dispatch_owner(shared, events, request.operation).await;
                (request.correlation_id, outcome, false, output)
            }
            ClassifiedRequest::Malformed(error) => {
                let output = OutputOwner::reserve(
                    &shared.output,
                    ResponseBound::for_class(ResponseClass::Control),
                )
                .ok_or(WireError::Capacity)?;
                (
                    String::from("malformed"),
                    Outcome::Error(error),
                    true,
                    output,
                )
            }
        },
        ConnectionRole::Peer(principal) => match classify_request::<PeerRequest>(bytes) {
            ClassifiedRequest::Valid(request) => {
                let correlation = request.correlation_id.clone();
                let output = match OutputOwner::reserve(
                    &shared.output,
                    peer_response_bound(&request.operation),
                ) {
                    Some(output) => output,
                    None => {
                        refuse_output_capacity(pipe, shared, &correlation).await?;
                        return Ok(true);
                    }
                };
                match request.operation {
                    PeerOperation::FetchContext {
                        group_id,
                        source_id,
                    } => {
                        return fetch_context(
                            pipe,
                            shared,
                            principal,
                            &correlation,
                            group_id,
                            source_id,
                            output,
                        )
                        .await
                        .map(|()| true);
                    }
                    operation => {
                        let outcome = dispatch_peer(shared, principal, operation).await;
                        (correlation, outcome, false, output)
                    }
                }
            }
            ClassifiedRequest::Malformed(error) => {
                let output = OutputOwner::reserve(
                    &shared.output,
                    ResponseBound::for_class(ResponseClass::Control),
                )
                .ok_or(WireError::Capacity)?;
                (
                    String::from("malformed"),
                    Outcome::Error(error),
                    true,
                    output,
                )
            }
        },
        ConnectionRole::Unenrolled => match classify_request::<PeerRequest>(bytes) {
            ClassifiedRequest::Valid(request) => {
                let output = OutputOwner::reserve(
                    &shared.output,
                    ResponseBound::for_class(ResponseClass::Control),
                )
                .ok_or(WireError::Capacity)?;
                shared
                    .counters
                    .unenrolled_refusals
                    .fetch_add(1, Ordering::Relaxed);
                (
                    request.correlation_id,
                    Outcome::Error(ErrorPayload::unavailable(
                        "this connection is not an enrolled peer; verified enrollment is not available in this build",
                    )),
                    false,
                    output,
                )
            }
            ClassifiedRequest::Malformed(error) => {
                let output = OutputOwner::reserve(
                    &shared.output,
                    ResponseBound::for_class(ResponseClass::Control),
                )
                .ok_or(WireError::Capacity)?;
                (
                    String::from("malformed"),
                    Outcome::Error(error),
                    true,
                    output,
                )
            }
        },
    };
    if malformed {
        shared
            .counters
            .malformed_frames
            .fetch_add(1, Ordering::Relaxed);
    } else {
        shared.counters.dispatched.fetch_add(1, Ordering::Relaxed);
    }
    output
        .encode(&correlation_id, outcome)?
        .write(pipe, shared, OutputKind::Response)
        .await?;
    Ok(!malformed)
}

async fn refuse_output_capacity(
    pipe: &VerifiedPipe,
    shared: &Shared,
    correlation_id: &str,
) -> Result<(), WireError> {
    send_control_response(
        pipe,
        shared,
        correlation_id,
        Outcome::Error(ErrorPayload::new(
            ErrorCode::Admission,
            "host output capacity unavailable; request was not dispatched",
        )),
    )
    .await
}

trait Request: serde::de::DeserializeOwned {
    fn version(&self) -> u16;
    fn correlation_id(&self) -> &str;
}

enum ClassifiedRequest<R> {
    Valid(R),
    Malformed(ErrorPayload),
}

fn classify_request<R: Request>(bytes: &[u8]) -> ClassifiedRequest<R> {
    match decode_request(bytes) {
        Ok(request) => ClassifiedRequest::Valid(request),
        Err(error) => ClassifiedRequest::Malformed(error),
    }
}

impl Request for OwnerRequest {
    fn version(&self) -> u16 {
        self.version
    }
    fn correlation_id(&self) -> &str {
        &self.correlation_id
    }
}

impl Request for PeerRequest {
    fn version(&self) -> u16 {
        self.version
    }
    fn correlation_id(&self) -> &str {
        &self.correlation_id
    }
}

fn decode_request<R: Request>(bytes: &[u8]) -> Result<R, ErrorPayload> {
    let request: R = serde_json::from_slice(bytes)
        .map_err(|error| ErrorPayload::invalid(format!("malformed request: {error}")))?;
    if request.version() != SWARM_RPC_VERSION {
        return Err(ErrorPayload::invalid(format!(
            "unsupported request version {}",
            request.version()
        )));
    }
    if !valid_id(request.correlation_id()) {
        return Err(ErrorPayload::invalid("invalid correlation identifier"));
    }
    Ok(request)
}

async fn owner_revisions(shared: &Shared) -> Result<StateRevisions, ErrorPayload> {
    let owner = shared.owner.clone();
    match shared
        .submit(move || Command::StateRevisions(owner.clone()))
        .await?
    {
        Response::Revisions(revisions) => Ok(revisions),
        other => Err(ErrorPayload::new(
            ErrorCode::Internal,
            format!("unexpected core response {}", response_label(&other)),
        )),
    }
}

/// Publishes a revision hint after a successful mutation. Failure to read
/// the tuple is not an operation failure; subscribers resnapshot anyway.
async fn publish_hint(shared: &Shared) {
    if let Ok(revisions) = owner_revisions(shared).await {
        shared.events.publish(revisions);
    }
}

fn health(shared: &Shared) -> HealthPayload {
    let metrics = shared.client.metrics();
    let (frame_bytes, frames) = shared.budget.usage();
    let counters = &shared.counters;
    HealthPayload {
        boot_id: shared.boot_id.clone(),
        authority_id: shared.authority_id.clone(),
        gate_open: matches!(
            *shared.gate.borrow(),
            crate::swarm::runtime::GateState::Open
        ),
        worker: WorkerCounters {
            accepted: DecimalU64::new(metrics.accepted),
            completed: DecimalU64::new(metrics.completed),
            store_errors: DecimalU64::new(metrics.store_errors),
            rejected: DecimalU64::new(metrics.rejected),
            abandoned_replies: DecimalU64::new(metrics.abandoned_replies),
            outcome_unknown: DecimalU64::new(metrics.outcome_unknown),
            requests: metrics.requests as u32,
            responses: metrics.responses as u32,
            request_bytes: DecimalU64::new(metrics.request_bytes as u64),
            response_reserved_bytes: DecimalU64::new(metrics.response_reserved_bytes as u64),
        },
        transport: TransportCounters {
            frame_bytes: DecimalU64::new(frame_bytes as u64),
            frames: DecimalU64::new(frames as u64),
            connections: shared.budget.connection_usage() as u32,
            max_connections: shared.max_connections as u32,
        },
        connections: ConnectionCounters {
            accepted: DecimalU64::new(counters.accepted.load(Ordering::Relaxed)),
            rejected_handshakes: DecimalU64::new(
                counters.rejected_handshakes.load(Ordering::Relaxed),
            ),
            owner_sessions: DecimalU64::new(counters.owner_sessions.load(Ordering::Relaxed)),
            peer_sessions: DecimalU64::new(counters.peer_sessions.load(Ordering::Relaxed)),
            unenrolled_peer_sessions: DecimalU64::new(
                counters.unenrolled_peer_sessions.load(Ordering::Relaxed),
            ),
            active_sessions: DecimalU64::new(counters.active_sessions.load(Ordering::Relaxed)),
            malformed_frames: DecimalU64::new(counters.malformed_frames.load(Ordering::Relaxed)),
            unenrolled_refusals: DecimalU64::new(
                counters.unenrolled_refusals.load(Ordering::Relaxed),
            ),
        },
        events: EventCounters {
            published: DecimalU64::new(shared.events.published()),
            subscribers: shared.events.subscribers() as u32,
        },
    }
}

async fn dispatch_owner(
    shared: &Arc<Shared>,
    events: &mut Option<broadcast::Receiver<EventHint>>,
    operation: OwnerOperation,
) -> Outcome {
    match dispatch_owner_inner(shared, events, operation).await {
        Ok(outcome) => outcome,
        Err(error) => Outcome::Error(error),
    }
}

async fn dispatch_owner_inner(
    shared: &Arc<Shared>,
    events: &mut Option<broadcast::Receiver<EventHint>>,
    operation: OwnerOperation,
) -> Result<Outcome, ErrorPayload> {
    let owner = shared.owner.clone();
    Ok(match operation {
        OwnerOperation::Health(_) => Outcome::Health(health(shared)),
        OwnerOperation::Revisions(_) => Outcome::Revisions(RevisionsPayload::new(
            &shared.boot_id,
            owner_revisions(shared).await?,
        )),
        OwnerOperation::Subscribe(_) => {
            // Subscribe first, then read the tuple the subscriber starts from.
            *events = Some(shared.events.subscribe());
            Outcome::Subscribed(RevisionsPayload::new(
                &shared.boot_id,
                owner_revisions(shared).await?,
            ))
        }
        OwnerOperation::Snapshot(params) => {
            let request = params.into_request()?;
            outcome_from(
                shared
                    .submit(move || Command::OwnerSnapshot(owner.clone(), request.clone()))
                    .await?,
            )
        }
        OwnerOperation::CreateGroup { label, members } => {
            let response = shared
                .submit(move || Command::CreateGroup(owner.clone(), label.clone(), members.clone()))
                .await?;
            publish_hint(shared).await;
            outcome_from(response)
        }
        OwnerOperation::Membership {
            group_id,
            peer_id,
            active,
            expected_policy_revision,
        } => {
            let expected = revision(expected_policy_revision, "expectedPolicyRevision")?;
            let response = shared
                .submit(move || {
                    Command::Membership(
                        owner.clone(),
                        group_id.clone(),
                        peer_id.clone(),
                        active,
                        expected,
                    )
                })
                .await?;
            publish_hint(shared).await;
            outcome_from(response)
        }
        OwnerOperation::Pause {
            group_id,
            paused,
            expected_policy_revision,
        } => {
            let expected = revision(expected_policy_revision, "expectedPolicyRevision")?;
            let response = shared
                .submit(move || Command::Pause(owner.clone(), group_id.clone(), paused, expected))
                .await?;
            publish_hint(shared).await;
            outcome_from(response)
        }
        OwnerOperation::UpdatePeer {
            peer_id,
            expected_binding_revision,
            model_metadata,
            is_live,
        } => {
            let expected = revision(expected_binding_revision, "expectedBindingRevision")?;
            let response = shared
                .submit(move || {
                    Command::UpdatePeer(
                        owner.clone(),
                        peer_id.clone(),
                        expected,
                        PeerMetadataUpdate {
                            model_metadata: model_metadata.clone(),
                            is_live,
                        },
                    )
                })
                .await?;
            publish_hint(shared).await;
            outcome_from(response)
        }
    })
}

async fn dispatch_peer(
    shared: &Arc<Shared>,
    principal: &termx_swarm_core::model::PeerPrincipal,
    operation: PeerOperation,
) -> Outcome {
    match dispatch_peer_inner(shared, principal, operation).await {
        Ok(outcome) => outcome,
        Err(error) => Outcome::Error(error),
    }
}

async fn dispatch_peer_inner(
    shared: &Arc<Shared>,
    principal: &termx_swarm_core::model::PeerPrincipal,
    operation: PeerOperation,
) -> Result<Outcome, ErrorPayload> {
    let principal = principal.clone();
    Ok(match operation {
        PeerOperation::WhoAmI {
            after_group,
            max_items,
        } => outcome_from(
            shared
                .submit(move || {
                    Command::WhoAmI(
                        principal.clone(),
                        termx_swarm_core::model::WhoAmIRequest {
                            after_group: after_group.clone(),
                            max_items: max_items as usize,
                        },
                    )
                })
                .await?,
        ),
        PeerOperation::ListPeers {
            group_id,
            after_peer,
            max_items,
        } => outcome_from(
            shared
                .submit(move || {
                    Command::ListPeers(
                        principal.clone(),
                        termx_swarm_core::model::ListPeersRequest {
                            group_id: group_id.clone(),
                            after_peer: after_peer.clone(),
                            max_items: max_items as usize,
                        },
                    )
                })
                .await?,
        ),
        PeerOperation::PublishStatus { group_id, status } => {
            let response = shared
                .submit(move || {
                    Command::PublishStatus(
                        principal.clone(),
                        termx_swarm_core::model::StatusRequest {
                            group_id: group_id.clone(),
                            status: status.clone(),
                        },
                    )
                })
                .await?;
            publish_hint(shared).await;
            outcome_from(response)
        }
        PeerOperation::Send {
            group_id,
            client_key,
            recipients,
            body,
            topic,
            reply_to,
            attachments,
        } => {
            let request = SendMessageRequest {
                group_id,
                client_key,
                recipients,
                body,
                topic,
                reply_to,
                attachments,
            };
            let response = shared
                .submit(move || Command::Send(principal.clone(), request.clone()))
                .await?;
            publish_hint(shared).await;
            outcome_from(response)
        }
        PeerOperation::MailboxAfter {
            group_id,
            navigation,
            max_items,
        } => outcome_from(
            shared
                .submit(move || {
                    Command::ReadMailboxAfter(
                        principal.clone(),
                        termx_swarm_core::model::MailboxAfterRequest {
                            group_id: group_id.clone(),
                            navigation: navigation.clone(),
                            max_items: max_items as usize,
                        },
                    )
                })
                .await?,
        ),
        PeerOperation::ReadThread {
            group_id,
            root,
            navigation,
            max_items,
        } => outcome_from(
            shared
                .submit(move || {
                    Command::ReadThread(
                        principal.clone(),
                        termx_swarm_core::model::ThreadPageRequest {
                            group_id: group_id.clone(),
                            root: root.clone(),
                            navigation: navigation.clone(),
                            max_items: max_items as usize,
                        },
                    )
                })
                .await?,
        ),
        PeerOperation::ReadOutgoing {
            group_id,
            navigation,
            max_items,
        } => outcome_from(
            shared
                .submit(move || {
                    Command::ReadOutgoing(
                        principal.clone(),
                        termx_swarm_core::model::OutgoingPageRequest {
                            group_id: group_id.clone(),
                            navigation: navigation.clone(),
                            max_items: max_items as usize,
                        },
                    )
                })
                .await?,
        ),
        PeerOperation::Acknowledge {
            group_id,
            message_id,
        } => {
            let response = shared
                .submit(move || {
                    Command::Acknowledge(principal.clone(), group_id.clone(), message_id.clone())
                })
                .await?;
            publish_hint(shared).await;
            outcome_from(response)
        }
        PeerOperation::ResolveAttachment {
            group_id,
            source_reference_id,
        } => outcome_from(
            shared
                .submit(move || {
                    Command::ResolveAttachment(
                        principal.clone(),
                        group_id.clone(),
                        source_reference_id.clone(),
                    )
                })
                .await?,
        ),
        PeerOperation::FetchContext { .. } => {
            return Err(ErrorPayload::new(
                ErrorCode::Internal,
                "fetch_context is dispatched by the session",
            ))
        }
    })
}

/// Approved order: lease -> bounded trusted source I/O -> destination
/// reservation on this connection -> final writer validation -> one
/// protected write. Every failure answers with an error frame and releases
/// the reservation; nothing is written after a failed validation.
async fn fetch_context(
    pipe: &Arc<VerifiedPipe>,
    shared: &Arc<Shared>,
    principal: &termx_swarm_core::model::PeerPrincipal,
    correlation_id: &str,
    group_id: GroupId,
    source_id: SourceId,
    error_output: OutputOwner,
) -> Result<(), WireError> {
    shared.counters.dispatched.fetch_add(1, Ordering::Relaxed);
    match fetch_context_inner(pipe, shared, principal, correlation_id, group_id, source_id).await {
        Ok(send) => {
            drop(error_output);
            send.write(shared).await?;
            publish_hint(shared).await;
            Ok(())
        }
        Err(error) => {
            error_output
                .encode(correlation_id, Outcome::Error(error))?
                .write(pipe, shared, OutputKind::Response)
                .await
        }
    }
}

async fn fetch_context_inner(
    pipe: &Arc<VerifiedPipe>,
    shared: &Arc<Shared>,
    principal: &termx_swarm_core::model::PeerPrincipal,
    correlation_id: &str,
    group_id: GroupId,
    source_id: SourceId,
) -> Result<ProtectedSend, ErrorPayload> {
    let caller = principal.clone();
    let lease = match shared
        .submit(move || {
            Command::AcquireContextGrant(caller.clone(), group_id.clone(), source_id.clone())
        })
        .await?
    {
        Response::Lease(lease) => lease,
        other => {
            return Err(ErrorPayload::new(
                ErrorCode::Internal,
                format!("unexpected core response {}", response_label(&other)),
            ))
        }
    };
    // Own the largest permitted source allocation and bounded lease/source
    // metadata before invoking the reader. Reader implementations must
    // return a Vec whose capacity, as well as length, fits this reservation.
    let _source_output = shared
        .output
        .reserve_data(MAX_PUBLICATION_BYTES + PUBLICATION_METADATA_RETAINED_BYTES)
        .ok_or_else(|| {
            ErrorPayload::new(
                ErrorCode::Admission,
                "host source capacity unavailable; source was not read",
            )
        })?;
    // Shared owns finite source slots, gate cancellation and the read
    // deadline. The adapter future itself owns and drops cancellable I/O.
    let snapshot = shared
        .read_source(&lease)
        .await
        .map_err(|error| match error {
            SourceReadError::Unavailable(reason) => {
                ErrorPayload::new(ErrorCode::SourceUnavailable, reason)
            }
            SourceReadError::TooLarge => ErrorPayload::new(
                ErrorCode::SourceUnavailable,
                "source snapshot exceeds the publication maximum",
            ),
            SourceReadError::Io(message) => {
                ErrorPayload::new(ErrorCode::SourceUnavailable, message)
            }
        })?;
    if snapshot.body.len() > MAX_PUBLICATION_BYTES
        || snapshot.body.capacity() > MAX_PUBLICATION_BYTES
        || snapshot.snapshot_identity.capacity() > PUBLICATION_METADATA_RETAINED_BYTES
    {
        return Err(ErrorPayload::new(
            ErrorCode::SourceUnavailable,
            "source snapshot allocation exceeds the publication ownership bound",
        ));
    }
    let observation = SourceSnapshotObservation::trusted(
        &lease,
        snapshot.snapshot_identity,
        snapshot.captured_through,
    )?;
    let (destination, reservation) = ProtectedDestination::reserve(
        pipe.clone(),
        &shared.output,
        correlation_id,
        snapshot.body.len(),
    )?;
    let prepared = PreparedPublication::prepare(lease, observation, snapshot.body, reservation)?;
    let caller = principal.clone();
    let committed = match shared
        .submit_once(Command::ValidateContextGrant(caller, prepared))
        .await?
    {
        Response::CommittedPublication(committed) => committed,
        other => {
            return Err(ErrorPayload::new(
                ErrorCode::Internal,
                format!("unexpected core response {}", response_label(&other)),
            ))
        }
    };
    shared.observe_commit(committed.record()).await;
    Ok(destination.commit(committed)?)
}

// ---------------------------------------------------------------------------
// Typed client
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum RpcClientError {
    Transport(WireError),
    Malformed(String),
    UnexpectedCorrelation { expected: String, actual: String },
    BodyLengthMismatch { declared: u64, actual: usize },
}

impl std::fmt::Display for RpcClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(error) => write!(f, "transport: {error}"),
            Self::Malformed(error) => write!(f, "malformed server frame: {error}"),
            Self::UnexpectedCorrelation { expected, actual } => {
                write!(f, "response correlation {actual} did not match {expected}")
            }
            Self::BodyLengthMismatch { declared, actual } => {
                write!(
                    f,
                    "publication declared {declared} bytes but carried {actual}"
                )
            }
        }
    }
}

impl std::error::Error for RpcClientError {}

impl From<WireError> for RpcClientError {
    fn from(error: WireError) -> Self {
        Self::Transport(error)
    }
}

/// Decodes one server frame, including the raw publication suffix.
pub fn decode_server_frame(bytes: &[u8]) -> Result<ServerFrame, RpcClientError> {
    let (header, body) = match bytes.iter().position(|byte| *byte == b'\n') {
        Some(index) => (&bytes[..index], Some(&bytes[index + 1..])),
        None => (bytes, None),
    };
    let mut frame: ServerFrame = serde_json::from_slice(header)
        .map_err(|error| RpcClientError::Malformed(error.to_string()))?;
    if frame.version != SWARM_RPC_VERSION {
        return Err(RpcClientError::Malformed(format!(
            "unsupported server frame version {}",
            frame.version
        )));
    }
    match (&mut frame.message, body) {
        (ServerMessage::Response(response), Some(body))
            if matches!(&response.outcome, Outcome::ContextPublished(_)) =>
        {
            let Outcome::ContextPublished(payload) = &mut response.outcome else {
                unreachable!("guard established the publication variant")
            };
            if payload.body_bytes.get() != body.len() as u64 {
                return Err(RpcClientError::BodyLengthMismatch {
                    declared: payload.body_bytes.get(),
                    actual: body.len(),
                });
            }
            payload.body = body.to_vec();
        }
        (_, Some(_)) => {
            return Err(RpcClientError::Malformed(
                "unexpected raw suffix on a non-publication frame".into(),
            ))
        }
        (ServerMessage::Response(response), None)
            if matches!(&response.outcome, Outcome::ContextPublished(_)) =>
        {
            return Err(RpcClientError::Malformed(
                "publication frame without body".into(),
            ))
        }
        (_, None) => {}
    }
    Ok(frame)
}

/// Typed client over one authenticated connection. Events received while
/// waiting for a response are buffered (bounded) for `next_event`.
pub struct TypedConnection {
    pipe: VerifiedPipe,
    events: ClientEventBuffer,
    next_correlation: u64,
}

/// Bounded client event queue. If local buffering loses any event, the next
/// event returned is an explicit overflow marker requiring a resnapshot.
#[derive(Default)]
struct ClientEventBuffer {
    events: VecDeque<EventBody>,
    local_overflow: Option<(String, u64)>,
}

impl ClientEventBuffer {
    fn len(&self) -> usize {
        self.events.len() + usize::from(self.local_overflow.is_some())
    }

    fn push(&mut self, event: EventBody) {
        self.events.push_back(event);
        while self.len() > MAX_BUFFERED_CLIENT_EVENTS {
            let Some(discarded) = self.events.pop_front() else {
                break;
            };
            let boot_id = discarded.boot_id().to_owned();
            let lost = match discarded {
                EventBody::Overflow { skipped, .. } => skipped.get(),
                EventBody::Revisions(_) => 1,
            };
            match &mut self.local_overflow {
                Some((_, skipped)) => *skipped = skipped.saturating_add(lost),
                None => self.local_overflow = Some((boot_id, lost)),
            }
        }
    }

    fn pop(&mut self) -> Option<EventBody> {
        if let Some((boot_id, skipped)) = self.local_overflow.take() {
            return Some(EventBody::Overflow {
                boot_id,
                skipped: DecimalU64::new(skipped),
            });
        }
        self.events.pop_front()
    }
}

impl TypedConnection {
    pub fn owner(client: OwnerClient) -> Self {
        Self::from_pipe(client.into_pipe())
    }

    pub fn peer(client: PeerClient) -> Self {
        Self::from_pipe(client.into_pipe())
    }

    pub fn from_pipe(pipe: VerifiedPipe) -> Self {
        Self {
            pipe,
            events: ClientEventBuffer::default(),
            next_correlation: 1,
        }
    }

    pub fn pipe(&self) -> &VerifiedPipe {
        &self.pipe
    }

    pub fn into_pipe(self) -> VerifiedPipe {
        self.pipe
    }

    fn correlation(&mut self) -> String {
        let id = format!("c-{}", self.next_correlation);
        self.next_correlation += 1;
        id
    }

    pub async fn send_raw(&self, bytes: &[u8]) -> Result<(), WireError> {
        self.pipe.send_bytes(bytes).await
    }

    pub async fn recv_message(&mut self) -> Result<ServerMessage, RpcClientError> {
        let frame = self.pipe.recv_bytes().await?;
        Ok(decode_server_frame(frame.as_ref())?.message)
    }

    /// Sends one owner operation and waits for its correlated response.
    pub async fn call_owner(
        &mut self,
        operation: OwnerOperation,
    ) -> Result<Outcome, RpcClientError> {
        let correlation_id = self.correlation();
        let request = OwnerRequest {
            version: SWARM_RPC_VERSION,
            correlation_id: correlation_id.clone(),
            operation,
        };
        self.send_raw(&serde_json::to_vec(&request).expect("owner requests serialize"))
            .await?;
        self.await_response(&correlation_id).await
    }

    /// Sends one peer operation and waits for its correlated response.
    pub async fn call_peer(&mut self, operation: PeerOperation) -> Result<Outcome, RpcClientError> {
        let correlation_id = self.correlation();
        let request = PeerRequest {
            version: SWARM_RPC_VERSION,
            correlation_id: correlation_id.clone(),
            operation,
        };
        self.send_raw(&serde_json::to_vec(&request).expect("peer requests serialize"))
            .await?;
        self.await_response(&correlation_id).await
    }

    /// Sends arbitrary bytes and waits for the response with `correlation_id`.
    pub async fn call_raw(
        &mut self,
        bytes: &[u8],
        correlation_id: &str,
    ) -> Result<Outcome, RpcClientError> {
        self.send_raw(bytes).await?;
        self.await_response(correlation_id).await
    }

    async fn await_response(&mut self, correlation_id: &str) -> Result<Outcome, RpcClientError> {
        loop {
            match self.recv_message().await? {
                ServerMessage::Event(event) => {
                    self.events.push(event);
                }
                ServerMessage::Response(response) => {
                    if response.correlation_id != correlation_id {
                        return Err(RpcClientError::UnexpectedCorrelation {
                            expected: correlation_id.to_owned(),
                            actual: response.correlation_id,
                        });
                    }
                    return Ok(response.outcome);
                }
            }
        }
    }

    /// Next buffered or incoming event.
    pub async fn next_event(&mut self) -> Result<EventBody, RpcClientError> {
        if let Some(event) = self.events.pop() {
            return Ok(event);
        }
        match self.recv_message().await? {
            ServerMessage::Event(event) => Ok(event),
            ServerMessage::Response(response) => Err(RpcClientError::UnexpectedCorrelation {
                expected: "<event>".into(),
                actual: response.correlation_id,
            }),
        }
    }

    pub fn buffered_events(&self) -> usize {
        self.events.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use termx_swarm_client::{FrameBudget, PipeServer};
    use termx_swarm_core::model::{LaunchId, VerifiedBinding, VerifiedSourceDescriptor};
    use termx_swarm_core::store::Store;

    #[test]
    fn requests_reject_identity_claims_unknown_fields_and_loose_integers() {
        let strict: Result<PeerRequest, _> = serde_json::from_str(
            r#"{"version":1,"correlationId":"c-1","operation":{"kind":"send","params":{"groupId":"g_00000000000000000000000000000001","clientKey":"k","recipients":[],"body":"hi","topic":null,"replyTo":null,"senderPeerId":"p_00000000000000000000000000000002"}}}"#,
        );
        assert!(strict.unwrap_err().to_string().contains("senderPeerId"));
        let role: Result<OwnerRequest, _> = serde_json::from_str(
            r#"{"version":1,"correlationId":"c-1","role":"owner","operation":{"kind":"health","params":{}}}"#,
        );
        assert!(role.unwrap_err().to_string().contains("role"));
        let numeric: Result<OwnerRequest, _> = serde_json::from_str(
            r#"{"version":1,"correlationId":"c-1","operation":{"kind":"pause","params":{"groupId":"g_00000000000000000000000000000001","paused":true,"expectedPolicyRevision":7}}}"#,
        );
        assert!(numeric.is_err(), "revisions must be exact decimal strings");
        let exact: OwnerRequest = serde_json::from_str(
            r#"{"version":1,"correlationId":"c-1","operation":{"kind":"pause","params":{"groupId":"g_00000000000000000000000000000001","paused":true,"expectedPolicyRevision":"9007199254740993"}}}"#,
        )
        .unwrap();
        match exact.operation {
            OwnerOperation::Pause {
                expected_policy_revision,
                ..
            } => assert_eq!(expected_policy_revision.get(), 9_007_199_254_740_993),
            _ => panic!("pause"),
        }
        let peer_on_owner: Result<OwnerRequest, _> = serde_json::from_str(
            r#"{"version":1,"correlationId":"c-1","operation":{"kind":"whoami","params":{"afterGroup":null,"maxItems":1}}}"#,
        );
        assert!(
            peer_on_owner.is_err(),
            "owner frames cannot name peer operations"
        );
        let owner_on_peer: Result<PeerRequest, _> = serde_json::from_str(
            r#"{"version":1,"correlationId":"c-1","operation":{"kind":"pause","params":{"groupId":"g_00000000000000000000000000000001","paused":true,"expectedPolicyRevision":"1"}}}"#,
        );
        assert!(
            owner_on_peer.is_err(),
            "peer frames cannot name owner operations"
        );
    }

    #[test]
    fn server_frames_round_trip_and_publication_suffix_is_exact() {
        let payload = ContextPublishedPayload {
            commitment_id: "pub_x".into(),
            lease_id: "lease_x".into(),
            response_id: "pr_x".into(),
            destination_id: "dst_x".into(),
            group_id: GroupId::generate(),
            policy_revision: DecimalU64::new(1),
            caller_peer_id: PeerId::generate(),
            caller_binding_revision: DecimalU64::new(1),
            source_id: SourceId::generate(),
            registration_epoch: DecimalU64::new(1),
            snapshot_identity: "snap".into(),
            captured_through: Some(DecimalU64::new(u64::MAX)),
            body_bytes: DecimalU64::new(3),
            committed_at_millis: 5,
            body: Vec::new(),
        };
        let mut bytes = encode_frame("c-9", Outcome::ContextPublished(payload.clone()));
        bytes.push(b'\n');
        bytes.extend_from_slice(b"abc");
        let frame = decode_server_frame(&bytes).unwrap();
        match frame.message {
            ServerMessage::Response(response) => match *response {
                ResponseBody {
                    correlation_id,
                    outcome: Outcome::ContextPublished(decoded),
                } => {
                    assert_eq!(correlation_id, "c-9");
                    assert_eq!(decoded.body, b"abc");
                    assert_eq!(decoded.captured_through, payload.captured_through);
                }
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        }
        let mut short = encode_frame("c-9", Outcome::ContextPublished(payload));
        short.push(b'\n');
        short.extend_from_slice(b"ab");
        assert!(matches!(
            decode_server_frame(&short),
            Err(RpcClientError::BodyLengthMismatch {
                declared: 3,
                actual: 2
            })
        ));
        let plain = encode_frame("c-1", Outcome::Unit(Empty {}));
        assert!(decode_server_frame(&plain).is_ok());
        let mut suffixed = plain.clone();
        suffixed.extend_from_slice(b"\nextra");
        assert!(decode_server_frame(&suffixed).is_err());
    }

    #[test]
    fn correlation_identifiers_are_bounded() {
        assert!(valid_id("c-1"));
        assert!(!valid_id(""));
        assert!(!valid_id(&"x".repeat(MAX_CORRELATION_ID_BYTES + 1)));
        assert!(!valid_id("c 1"));
    }

    #[test]
    fn literal_malformed_is_a_valid_correlation_not_a_decode_sentinel() {
        let bytes = br#"{"version":1,"correlationId":"malformed","operation":{"kind":"health","params":{}}}"#;
        match classify_request::<OwnerRequest>(bytes) {
            ClassifiedRequest::Valid(request) => {
                assert_eq!(request.correlation_id, "malformed");
                assert!(matches!(request.operation, OwnerOperation::Health(_)));
            }
            ClassifiedRequest::Malformed(error) => {
                panic!("valid correlation was misclassified: {error:?}")
            }
        }
    }

    #[test]
    fn error_payloads_are_utf8_bounded_before_output_admission() {
        let error = ErrorPayload::new(ErrorCode::Internal, "🦀".repeat(4096));
        assert!(error.message.len() <= MAX_ERROR_MESSAGE_BYTES);
        assert!(error.message.is_char_boundary(error.message.len()));
        assert!(error.message.ends_with(ERROR_TRUNCATION_SUFFIX));
        assert_eq!(error.details, None);
    }

    #[test]
    fn operation_bounds_follow_the_core_response_classes() {
        let metadata = OwnerOperation::Snapshot(SnapshotParams::Peers {
            expected_inventory_revision: None,
            after_peer: None,
            max_items: 128,
        });
        let messages = OwnerOperation::Snapshot(SnapshotParams::Messages {
            group_id: GroupId::generate(),
            after_sequence: DecimalU64::new(0),
            through_sequence: None,
            max_items: 128,
        });
        let send = PeerOperation::Send {
            group_id: GroupId::generate(),
            client_key: "key".into(),
            recipients: BTreeSet::from([PeerId::generate()]),
            body: "body".into(),
            topic: None,
            reply_to: None,
            attachments: Vec::new(),
        };

        assert_eq!(
            owner_response_bound(&OwnerOperation::Health(Empty {})).class,
            ResponseClass::Control
        );
        assert_eq!(
            owner_response_bound(&metadata).class,
            ResponseClass::MetadataPage
        );
        assert_eq!(
            owner_response_bound(&messages).class,
            ResponseClass::MessagePage
        );
        assert_eq!(peer_response_bound(&send).class, ResponseClass::SendReceipt);
        assert!(
            owner_response_bound(&messages).total_bytes()
                > owner_response_bound(&metadata).total_bytes()
        );
        assert_eq!(
            serde_json::to_string(&DecimalU64::new(u64::MAX))
                .unwrap()
                .len(),
            22
        );
    }

    #[test]
    fn bounded_encoder_never_grows_and_reports_an_exact_overflow() {
        let outcome = Outcome::Error(ErrorPayload::new(ErrorCode::Internal, "bounded"));
        let bound = ResponseBound::for_class(ResponseClass::Control);
        let encoded = encode_frame_bounded("c-1", outcome.clone(), bound.encoded_bytes).unwrap();
        assert_eq!(encoded.capacity(), bound.encoded_bytes);
        assert!(encoded.len() < bound.encoded_bytes);
        assert_eq!(
            encode_frame_bounded("c-1", outcome, encoded.len() - 1),
            Err(WireError::FrameTooLarge)
        );
    }

    #[test]
    fn decoded_request_charge_is_checked_before_deserialization() {
        assert_eq!(decoded_request_bound(0), Some(DECODED_REQUEST_BASE_BYTES));
        assert_eq!(
            decoded_request_bound(MAX_REQUEST_FRAME_BYTES),
            Some(MAX_REQUEST_FRAME_BYTES * DECODED_REQUEST_EXPANSION + DECODED_REQUEST_BASE_BYTES)
        );
        assert_eq!(decoded_request_bound(usize::MAX), None);

        let budget = OutputBudget::new(1024, 256);
        let data = budget.reserve_data(768).unwrap();
        let small = reserve_decoded_request(&budget, 128)
            .expect("bounded decoded requests retain control progress");
        assert!(
            reserve_decoded_request(&budget, CONTROL_OUTPUT_BYTES + 1).is_none(),
            "large decoded requests cannot consume control headroom"
        );
        drop(small);
        drop(data);
    }

    #[test]
    fn output_owner_holds_simultaneous_then_exact_buffer_capacity() {
        let budget = OutputBudget::new(1024 * 1024, 256 * 1024);
        let bound = ResponseBound::for_class(ResponseClass::Control);
        let owner = OutputOwner::reserve(&budget, bound).expect("control owner admitted");
        assert_eq!(budget.usage(), bound.total_bytes());
        let frame = owner
            .encode(
                "c-1",
                Outcome::Error(ErrorPayload::new(ErrorCode::Unavailable, "held")),
            )
            .unwrap();
        assert_eq!(frame.capacity(), bound.encoded_bytes);
        assert_eq!(budget.usage(), bound.encoded_bytes);
        drop(frame);
        assert_eq!(budget.usage(), 0);
    }

    #[tokio::test]
    async fn publication_destination_preowns_the_second_body_representation() {
        let name = format!(
            r"\\.\pipe\termx-rpc-output-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let frame_budget = FrameBudget::new(32 * 1024 * 1024);
        let mut server = PipeServer::bind(&name, frame_budget.clone()).unwrap();
        let client = VerifiedPipe::connect(&name, server.identity())
            .await
            .unwrap();
        let pipe = Arc::new(server.accept().await.unwrap());
        let output = OutputBudget::new(32 * 1024 * 1024, 1024 * 1024);
        let body_bytes = 1024 * 1024;

        let (destination, reservation) =
            ProtectedDestination::reserve(pipe, &output, "c-1", body_bytes).unwrap();
        assert_eq!(
            output.usage(),
            publication_output_bound(body_bytes).unwrap(),
            "the second wire representation is owned before core validation"
        );
        assert_eq!(
            frame_budget.usage().0,
            body_bytes + PUBLICATION_HEADER_ALLOWANCE + 4,
            "transport credit includes the native frame prefix"
        );
        drop(destination);
        assert_eq!(output.usage(), 0);
        assert_ne!(
            frame_budget.usage(),
            (0, 0),
            "core reservation still owns transport credit"
        );
        drop(reservation);
        assert_eq!(frame_budget.usage(), (0, 0));
        drop(client);
    }

    #[tokio::test]
    async fn publication_wrong_destination_and_unpolled_send_release_exactly_once_without_writing()
    {
        async fn pipe_pair(
            suffix: &str,
            budget: &FrameBudget,
        ) -> (Arc<VerifiedPipe>, VerifiedPipe) {
            let name = format!(
                r"\\.\pipe\termx-rpc-publication-{suffix}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            let mut server = PipeServer::bind(&name, budget.clone()).unwrap();
            let client = VerifiedPipe::connect(&name, server.identity())
                .await
                .unwrap();
            (Arc::new(server.accept().await.unwrap()), client)
        }

        let fixture = crate::test_support::retained_dir().unwrap();
        let mut store = Store::open(fixture.path().join("publication.sqlite3")).unwrap();
        let owner = store.trusted_owner();
        let binding = |name: &str| {
            VerifiedBinding::trusted(
                LaunchId::generate().as_str().into(),
                format!("rpc-publication-{name}"),
                "synthetic".into(),
                format!("rpc-publication-{name}-conversation"),
                None,
                std::process::id(),
                1,
                true,
            )
            .unwrap()
        };
        let alice = store.enroll_peer(&owner, binding("alice")).unwrap();
        let bob = store.enroll_peer(&owner, binding("bob")).unwrap();
        let group = store
            .create_group(
                &owner,
                "publication destinations",
                BTreeSet::from([alice.record.peer_id.clone(), bob.record.peer_id.clone()]),
            )
            .unwrap();
        let descriptor = VerifiedSourceDescriptor::trusted(
            bob.record.peer_id.clone(),
            bob.record.revision,
            bob.record.conversation_id.clone(),
            "synthetic".into(),
            "retained-rpc-publication-resolver".into(),
            "retained-rpc-publication-object".into(),
            "retained-rpc-publication-evidence".into(),
        )
        .unwrap();
        let source = store.register_source(&owner, descriptor).unwrap();
        let frame_budget = FrameBudget::new(8 * 1024 * 1024);
        let output = OutputBudget::new(8 * 1024 * 1024, 1024 * 1024);
        let body = b"exact protected publication bytes".to_vec();

        let prepare =
            |store: &mut Store, destination: DestinationReservation| -> CommittedPublication {
                let lease = store
                    .acquire_context_grant(&alice.principal, &group.group_id, &source.source_id)
                    .unwrap();
                let observation = SourceSnapshotObservation::trusted(
                    &lease,
                    "snapshot:wrong-destination".into(),
                    Some(1),
                )
                .unwrap();
                let prepared =
                    PreparedPublication::prepare(lease, observation, body.clone(), destination)
                        .unwrap();
                store
                    .validate_context_grant(&alice.principal, prepared)
                    .unwrap()
            };

        let (pipe_a, client_a) = pipe_pair("a", &frame_budget).await;
        let (destination_a, reservation_a) =
            ProtectedDestination::reserve(pipe_a, &output, "c-a", body.len()).unwrap();
        let committed_a = prepare(&mut store, reservation_a);
        let (pipe_b, client_b) = pipe_pair("b", &frame_budget).await;
        let (destination_b, reservation_b) =
            ProtectedDestination::reserve(pipe_b, &output, "c-b", body.len()).unwrap();
        drop(reservation_b);
        drop(destination_a);
        assert!(matches!(
            destination_b.commit(committed_a),
            Err(PublicationError::DestinationMismatch)
        ));
        assert_eq!(output.usage(), 0);
        assert_eq!(frame_budget.usage(), (0, 0));
        for client in [&client_a, &client_b] {
            match tokio::time::timeout(std::time::Duration::from_millis(50), client.recv_bytes())
                .await
            {
                Err(_) | Ok(Err(_)) => {}
                Ok(Ok(bytes)) => panic!("wrong destination wrote {} bytes", bytes.len()),
            }
        }

        let (pipe_c, client_c) = pipe_pair("c", &frame_budget).await;
        let (destination_c, reservation_c) =
            ProtectedDestination::reserve(pipe_c, &output, "c-c", body.len()).unwrap();
        let committed_c = prepare(&mut store, reservation_c);
        let send = destination_c.commit(committed_c).unwrap();
        assert!(output.usage() > 0);
        assert_ne!(frame_budget.usage(), (0, 0));
        drop(send);
        assert_eq!(output.usage(), 0);
        assert_eq!(frame_budget.usage(), (0, 0));
        match tokio::time::timeout(std::time::Duration::from_millis(50), client_c.recv_bytes())
            .await
        {
            Err(_) | Ok(Err(_)) => {}
            Ok(Ok(bytes)) => panic!("unpolled send wrote {} bytes", bytes.len()),
        }
    }

    #[tokio::test]
    async fn reader_task_guard_aborts_owned_work_when_its_parent_is_cancelled() {
        struct DropFlag(Arc<AtomicUsize>);
        impl Drop for DropFlag {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }

        let entered = Arc::new(tokio::sync::Notify::new());
        let dropped = Arc::new(AtomicUsize::new(0));
        let task_entered = entered.clone();
        let task_dropped = dropped.clone();
        let guard = ReaderTask::new(tokio::spawn(async move {
            let _drop = DropFlag(task_dropped);
            task_entered.notify_one();
            std::future::pending::<()>().await;
        }));
        tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        drop(guard);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while dropped.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn local_event_overflow_is_explicit_and_preserves_prior_loss() {
        let mut events = ClientEventBuffer::default();
        events.push(EventBody::Overflow {
            boot_id: "boot-a".into(),
            skipped: DecimalU64::new(7),
        });
        for revision in 1..=MAX_BUFFERED_CLIENT_EVENTS + 8 {
            events.push(EventBody::Revisions(RevisionsPayload {
                boot_id: "boot-a".into(),
                inventory_revision: DecimalU64::new(revision as u64),
                delivery_revision: DecimalU64::new(revision as u64),
                run_revision: None,
            }));
        }
        assert_eq!(events.len(), MAX_BUFFERED_CLIENT_EVENTS);
        let Some(EventBody::Overflow { boot_id, skipped }) = events.pop() else {
            panic!("local overflow must be the next observable event")
        };
        assert_eq!(boot_id, "boot-a");
        assert!(
            skipped.get() >= 8,
            "evicting a server overflow marker must retain its reported loss"
        );
        assert!(events.len() < MAX_BUFFERED_CLIENT_EVENTS);
    }

    #[tokio::test]
    async fn awaiting_response_reports_loss_after_decoding_more_than_the_event_limit() {
        let name = format!(
            r"\\.\pipe\termx-rpc-events-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let mut server = PipeServer::bind(&name, FrameBudget::new(8 * 1024 * 1024)).unwrap();
        let client = VerifiedPipe::connect(&name, server.identity())
            .await
            .unwrap();
        let server_pipe = server.accept().await.unwrap();
        let server_task = tokio::spawn(async move {
            assert_eq!(server_pipe.recv_bytes().await.unwrap().as_ref(), b"request");
            for revision in 1..=MAX_BUFFERED_CLIENT_EVENTS + 9 {
                let event = ServerFrame {
                    version: SWARM_RPC_VERSION,
                    message: ServerMessage::Event(EventBody::Revisions(RevisionsPayload {
                        boot_id: "boot-transport".into(),
                        inventory_revision: DecimalU64::new(revision as u64),
                        delivery_revision: DecimalU64::new(revision as u64),
                        run_revision: None,
                    })),
                };
                server_pipe
                    .send_bytes(&serde_json::to_vec(&event).unwrap())
                    .await
                    .unwrap();
            }
            server_pipe
                .send_bytes(&encode_frame("c-overflow", Outcome::Unit(Empty {})))
                .await
                .unwrap();
        });
        let mut connection = TypedConnection::from_pipe(client);
        assert_eq!(
            connection.call_raw(b"request", "c-overflow").await.unwrap(),
            Outcome::Unit(Empty {})
        );
        server_task.await.unwrap();
        assert_eq!(connection.buffered_events(), MAX_BUFFERED_CLIENT_EVENTS);
        let EventBody::Overflow { boot_id, skipped } = connection.next_event().await.unwrap()
        else {
            panic!("locally dropped decoded events require an overflow marker")
        };
        assert_eq!(boot_id, "boot-transport");
        assert_eq!(skipped.get(), 10);
    }
}
