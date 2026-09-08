use std::collections::BTreeSet;

use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};

use crate::error::ValidationError;

pub const MAX_LABEL_BYTES: usize = 256;
pub const MAX_METADATA_BYTES: usize = 4 * 1024;
pub const MAX_CLIENT_KEY_BYTES: usize = 256;
pub const MAX_TOPIC_BYTES: usize = 512;
pub const MAX_MESSAGE_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_CANONICAL_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_RECIPIENTS_PER_MESSAGE: usize = 4096;

pub fn sqlite_i64(field: &'static str, value: u64) -> Result<i64, ValidationError> {
    i64::try_from(value).map_err(|_| ValidationError::IntegerRange { field })
}

macro_rules! opaque_id {
    ($name:ident, $prefix:literal) => {
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn generate() -> Self {
                let mut bytes = [0_u8; 16];
                OsRng.fill_bytes(&mut bytes);
                let mut value = String::with_capacity($prefix.len() + 32);
                value.push_str($prefix);
                for byte in bytes {
                    use std::fmt::Write as _;
                    write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
                }
                Self(value)
            }

            pub fn parse(value: &str) -> Result<Self, ValidationError> {
                let suffix = value
                    .strip_prefix($prefix)
                    .ok_or(ValidationError::InvalidId {
                        kind: stringify!($name),
                    })?;
                if suffix.len() != 32 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    return Err(ValidationError::InvalidId {
                        kind: stringify!($name),
                    });
                }
                Ok(Self(value.to_ascii_lowercase()))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::parse(&value).map_err(serde::de::Error::custom)
            }
        }
    };
}

/// Serialize-only opaque local identity. Values are minted in-process and
/// never accepted from a wire: there is deliberately no `Deserialize`.
macro_rules! opaque_local_id {
    ($name:ident, $prefix:literal) => {
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn generate() -> Self {
                let mut bytes = [0_u8; 16];
                OsRng.fill_bytes(&mut bytes);
                let mut value = String::with_capacity($prefix.len() + 32);
                value.push_str($prefix);
                for byte in bytes {
                    use std::fmt::Write as _;
                    write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
                }
                Self(value)
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}

opaque_id!(AuthorityId, "a_");
opaque_id!(PeerId, "p_");
opaque_id!(LaunchId, "l_");
opaque_id!(GroupId, "g_");
opaque_id!(MessageId, "m_");
opaque_id!(DeliveryAttemptId, "d_");
opaque_id!(SourceReferenceId, "s_");
opaque_id!(MailboxCursor, "c_");
opaque_local_id!(NoticeAttemptId, "n_");
impl NoticeAttemptId {
    pub(crate) fn parse(value: &str) -> Result<Self, ValidationError> {
        let suffix = value.strip_prefix("n_").ok_or(ValidationError::InvalidId {
            kind: "NoticeAttemptId",
        })?;
        if suffix.len() != 32 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ValidationError::InvalidId {
                kind: "NoticeAttemptId",
            });
        }
        Ok(Self(value.to_ascii_lowercase()))
    }
}

mod publication;
mod views;
pub use publication::*;
pub use views::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct Revision(u64);

impl Revision {
    pub fn new(value: u64) -> Result<Self, ValidationError> {
        if value == 0 {
            return Err(ValidationError::Empty { field: "revision" });
        }
        sqlite_i64("revision", value)?;
        Ok(Self(value))
    }

    pub fn get(self) -> u64 {
        self.0
    }

    pub fn as_sql_i64(self) -> i64 {
        i64::try_from(self.0).expect("validated revision fits in i64")
    }
}

impl<'de> Deserialize<'de> for Revision {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = u64::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug)]
pub struct OwnerPrincipal {
    pub(crate) authority_id: AuthorityId,
}

impl OwnerPrincipal {
    pub(crate) fn new(authority_id: AuthorityId) -> Self {
        Self { authority_id }
    }

    pub fn authority_id(&self) -> &AuthorityId {
        &self.authority_id
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeerPrincipal {
    pub(crate) authority_id: AuthorityId,
    pub(crate) peer_id: PeerId,
    pub(crate) binding_revision: Revision,
}

impl PeerPrincipal {
    pub(crate) fn new(
        authority_id: AuthorityId,
        peer_id: PeerId,
        binding_revision: Revision,
    ) -> Self {
        Self {
            authority_id,
            peer_id,
            binding_revision,
        }
    }

    pub fn peer_id(&self) -> &PeerId {
        &self.peer_id
    }

    pub fn binding_revision(&self) -> Revision {
        self.binding_revision
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SendMessageRequest {
    pub group_id: GroupId,
    pub client_key: String,
    pub recipients: BTreeSet<PeerId>,
    pub body: String,
    pub topic: Option<String>,
    pub reply_to: Option<MessageId>,
    /// Source-reference attachments. Serialized only when non-empty so that
    /// every canonical payload committed before schema 8 keeps its exact bytes
    /// and historical retries still compare equal.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<SourceAttachment>,
}

/// Process identity evidence accepted by the trusted broker boundary.
///
/// This type deliberately has no `Deserialize` implementation. `trusted` is a
/// library entry point for a caller that has already authenticated the native
/// process; constructing this value does not itself verify a process.
#[derive(Clone, Debug)]
pub struct VerifiedBinding {
    pub(crate) launch_id: LaunchId,
    pub(crate) terminal_id: String,
    pub(crate) harness: String,
    pub(crate) conversation_id: String,
    pub(crate) model_metadata: Option<String>,
    pub(crate) process_id: u32,
    pub(crate) process_creation_filetime: u64,
    pub(crate) is_live: bool,
}

impl VerifiedBinding {
    #[allow(clippy::too_many_arguments)]
    pub fn trusted(
        launch_id: String,
        terminal_id: String,
        harness: String,
        conversation_id: String,
        model_metadata: Option<String>,
        process_id: u32,
        process_creation_filetime: u64,
        is_live: bool,
    ) -> Result<Self, ValidationError> {
        let value = Self {
            launch_id: LaunchId::parse(&launch_id)?,
            terminal_id,
            harness,
            conversation_id,
            model_metadata,
            process_id,
            process_creation_filetime,
            is_live,
        };
        value.validate()?;
        Ok(value)
    }

    fn validate(&self) -> Result<(), ValidationError> {
        validate_nonempty("terminal_id", &self.terminal_id, MAX_METADATA_BYTES)?;
        validate_nonempty("harness", &self.harness, MAX_LABEL_BYTES)?;
        validate_nonempty("conversation_id", &self.conversation_id, MAX_METADATA_BYTES)?;
        sqlite_i64("process_creation_filetime", self.process_creation_filetime)?;
        if let Some(metadata) = &self.model_metadata {
            validate_max("model_metadata", metadata, MAX_METADATA_BYTES)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeerMetadataUpdate {
    pub model_metadata: Option<String>,
    pub is_live: bool,
}

impl PeerMetadataUpdate {
    pub(crate) fn validate(&self) -> Result<(), ValidationError> {
        if let Some(metadata) = &self.model_metadata {
            validate_max("model_metadata", metadata, MAX_METADATA_BYTES)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnrolledPeer {
    pub record: PeerBindingRecord,
    pub principal: PeerPrincipal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrozenRecipient {
    pub peer_id: PeerId,
    pub binding_revision: Revision,
    pub generation: Revision,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendReceipt {
    pub message_id: MessageId,
    pub group_id: GroupId,
    pub group_sequence: u64,
    pub sender_peer_id: PeerId,
    pub sender_binding_revision: Revision,
    pub recipients: Vec<FrozenRecipient>,
    pub committed_at_millis: i64,
    pub outcome: MessageCommitOutcome,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageCommitOutcome {
    Saved,
}

pub const MAX_MAILBOX_PAGE_ITEMS: usize = 128;
pub const MAX_MAILBOX_PAGE_BYTES: usize = MAX_CANONICAL_PAYLOAD_BYTES;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MailboxPageRequest {
    pub group_id: GroupId,
    pub cursor: Option<MailboxCursor>,
    pub max_items: usize,
}

impl MailboxPageRequest {
    pub(crate) fn validate(&self) -> Result<(), ValidationError> {
        if self.max_items == 0 {
            return Err(ValidationError::Empty { field: "max_items" });
        }
        if self.max_items > MAX_MAILBOX_PAGE_ITEMS {
            return Err(ValidationError::TooLarge {
                field: "max_items",
                max: MAX_MAILBOX_PAGE_ITEMS,
            });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailboxEntry {
    pub message: MessageRecord,
    pub receipt: ReceiptRecord,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailboxPage {
    pub messages: Vec<MailboxEntry>,
    pub next_cursor: Option<MailboxCursor>,
    /// Store-built position to continue this reader's mailbox after this page
    /// under a fresh watermark: the last included item of a partial page, or
    /// the frozen high watermark of a complete one. Navigation only.
    pub resume_position: NavigationPosition,
    pub snapshot_high_sequence: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcknowledgementResult {
    pub message_id: MessageId,
    pub generation: Revision,
    pub acknowledged_at_millis: i64,
    pub contiguous_group_sequence: u64,
}

impl SendMessageRequest {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_nonempty("client_key", &self.client_key, MAX_CLIENT_KEY_BYTES)?;
        if self.recipients.is_empty() {
            return Err(ValidationError::Empty {
                field: "recipients",
            });
        }
        if self.recipients.len() > MAX_RECIPIENTS_PER_MESSAGE {
            return Err(ValidationError::TooLarge {
                field: "recipients",
                max: MAX_RECIPIENTS_PER_MESSAGE,
            });
        }
        validate_nonempty("body", &self.body, MAX_MESSAGE_BODY_BYTES)?;
        if let Some(topic) = &self.topic {
            validate_nonempty("topic", topic, MAX_TOPIC_BYTES)?;
        }
        validate_attachments(&self.attachments)?;
        self.canonical_json()?;
        Ok(())
    }

    pub fn canonical_json(&self) -> Result<Vec<u8>, ValidationError> {
        let encoded = serde_json::to_vec(self)
            .map_err(|error| ValidationError::CanonicalSerialization(error.to_string()))?;
        if encoded.len() > MAX_CANONICAL_PAYLOAD_BYTES {
            return Err(ValidationError::TooLong {
                field: "canonical_payload",
                max: MAX_CANONICAL_PAYLOAD_BYTES,
            });
        }
        Ok(encoded)
    }
}

impl PeerBindingRecord {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_nonempty("terminal_id", &self.terminal_id, MAX_METADATA_BYTES)?;
        validate_nonempty("harness", &self.harness, MAX_LABEL_BYTES)?;
        validate_nonempty("conversation_id", &self.conversation_id, MAX_METADATA_BYTES)?;
        sqlite_i64("process_creation_filetime", self.process_creation_filetime)?;
        if let Some(metadata) = &self.model_metadata {
            validate_max("model_metadata", metadata, MAX_METADATA_BYTES)?;
        }
        Ok(())
    }
}

impl GroupRecord {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_nonempty("label", &self.label, MAX_LABEL_BYTES)
    }
}

impl MessageRecord {
    pub fn validate(&self) -> Result<(), ValidationError> {
        sqlite_i64("group_sequence", self.group_sequence)?;
        validate_nonempty("client_key", &self.client_key, MAX_CLIENT_KEY_BYTES)?;
        validate_nonempty("body", &self.body, MAX_MESSAGE_BODY_BYTES)?;
        if let Some(topic) = &self.topic {
            validate_nonempty("topic", topic, MAX_TOPIC_BYTES)?;
        }
        Ok(())
    }
}

impl DeliveryAttemptRecord {
    pub fn validate(&self) -> Result<(), ValidationError> {
        sqlite_i64("attempt_number", self.attempt_number)?;
        if let Some(outcome) = &self.outcome {
            validate_max("outcome", outcome, MAX_METADATA_BYTES)?;
        }
        Ok(())
    }
}

impl SourceReferenceRecord {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_nonempty("source_kind", &self.source_kind, MAX_LABEL_BYTES)?;
        validate_nonempty(
            "opaque_reference",
            &self.opaque_reference,
            MAX_METADATA_BYTES,
        )
    }
}

pub(crate) fn validate_nonempty(
    field: &'static str,
    value: &str,
    max: usize,
) -> Result<(), ValidationError> {
    if value.is_empty() {
        return Err(ValidationError::Empty { field });
    }
    if value.len() > max {
        return Err(ValidationError::TooLong { field, max });
    }
    Ok(())
}

pub(crate) fn validate_max(
    field: &'static str,
    value: &str,
    max: usize,
) -> Result<(), ValidationError> {
    if value.len() > max {
        return Err(ValidationError::TooLong { field, max });
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerBindingRecord {
    pub peer_id: PeerId,
    pub revision: Revision,
    pub launch_id: LaunchId,
    pub terminal_id: String,
    pub harness: String,
    pub conversation_id: String,
    pub model_metadata: Option<String>,
    pub process_id: u32,
    pub process_creation_filetime: u64,
    pub is_live: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupRecord {
    pub group_id: GroupId,
    pub policy_revision: Revision,
    pub label: String,
    pub paused: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageRecord {
    pub message_id: MessageId,
    pub group_id: GroupId,
    pub group_sequence: u64,
    pub sender_peer_id: PeerId,
    pub sender_binding_revision: Revision,
    pub client_key: String,
    pub body: String,
    pub topic: Option<String>,
    pub reply_to: Option<MessageId>,
    /// Immutable opaque source references attached at commit time.
    pub attachments: Vec<AttachmentRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeliveryRecord {
    pub message_id: MessageId,
    pub recipient_peer_id: PeerId,
    pub recipient_binding_revision: Revision,
    pub fetched_generation: Option<Revision>,
    pub acknowledged_generation: Option<Revision>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceiptRecord {
    pub message_id: MessageId,
    pub recipient_peer_id: PeerId,
    pub binding_revision: Revision,
    pub generation: Revision,
    pub fetched_at_millis: Option<i64>,
    pub acknowledged_at_millis: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeliveryAttemptRecord {
    pub attempt_id: DeliveryAttemptId,
    pub message_id: MessageId,
    pub recipient_peer_id: PeerId,
    pub binding_revision: Revision,
    pub generation: Revision,
    pub attempt_number: u64,
    pub outcome: Option<String>,
}

#[derive(Clone, Debug)]
pub struct SourceReferenceRecord {
    pub source_reference_id: SourceReferenceId,
    pub message_id: MessageId,
    pub source_kind: String,
    pub(crate) opaque_reference: String,
}

pub const MAX_DELIVERY_CANDIDATES: usize = 128;

/// A store-issued candidate, never accepted from peer deserialization.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DeliveryCandidate {
    pub(crate) authority_id: AuthorityId,
    pub(crate) group_id: GroupId,
    pub(crate) policy_revision: Revision,
    pub(crate) message_id: MessageId,
    pub(crate) recipient_peer_id: PeerId,
    pub(crate) binding_revision: Revision,
    pub(crate) generation: Revision,
    pub(crate) notification_revision: Revision,
    pub(crate) last_attempt_id: Option<DeliveryAttemptId>,
}
impl DeliveryCandidate {
    pub fn authority_id(&self) -> &AuthorityId {
        &self.authority_id
    }
    pub fn group_id(&self) -> &GroupId {
        &self.group_id
    }
    pub fn policy_revision(&self) -> Revision {
        self.policy_revision
    }
    pub fn recipient_peer_id(&self) -> &PeerId {
        &self.recipient_peer_id
    }
    pub fn binding_revision(&self) -> Revision {
        self.binding_revision
    }
    pub fn notification_revision(&self) -> Revision {
        self.notification_revision
    }
    pub fn message_id(&self) -> &MessageId {
        &self.message_id
    }
    pub fn generation(&self) -> Revision {
        self.generation
    }
}

/// Durable authority and immutable process/message evidence for a future adapter.
/// Native I/O must happen after `begin_delivery` returns, outside any transaction.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DeliveryTicket {
    pub(crate) attempt_id: DeliveryAttemptId,
    pub(crate) candidate: DeliveryCandidate,
    pub(crate) recipient_binding: PeerBindingRecord,
    pub(crate) attempt_number: u64,
    pub(crate) run_revision: Revision,
}
impl DeliveryTicket {
    pub fn run_revision(&self) -> Revision {
        self.run_revision
    }
    pub fn attempt_id(&self) -> &DeliveryAttemptId {
        &self.attempt_id
    }
    pub fn message_id(&self) -> &MessageId {
        &self.candidate.message_id
    }
    pub fn recipient_binding(&self) -> &PeerBindingRecord {
        &self.recipient_binding
    }
    pub fn candidate(&self) -> &DeliveryCandidate {
        &self.candidate
    }
    pub fn attempt_number(&self) -> u64 {
        self.attempt_number
    }
}

/// Transport evidence only. None of these outcomes constitutes recipient ACK.
/// `KnownNotSubmitted` is positive pre-submission failure evidence. `Held` may
/// represent a native queued item that can arrive later and is NOT retryable.
/// `TransportWritten`, `NativeQueued`, and `Uncertain` also block automatic retry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AttemptOutcome {
    KnownNotSubmitted,
    Held,
    TransportWritten,
    NativeQueued,
    Uncertain,
}
impl AttemptOutcome {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::KnownNotSubmitted => "known_not_submitted",
            Self::Held => "held",
            Self::TransportWritten => "transport_written",
            Self::NativeQueued => "native_queued",
            Self::Uncertain => "uncertain",
        }
    }
    pub(crate) fn from_stored(value: &str) -> Self {
        match value {
            "known_not_submitted" => Self::KnownNotSubmitted,
            "held" => Self::Held,
            "transport_written" => Self::TransportWritten,
            "native_queued" => Self::NativeQueued,
            _ => Self::Uncertain,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AttemptStatus {
    pub attempt_id: DeliveryAttemptId,
    pub outcome: Option<AttemptOutcome>,
    pub completed_at_millis: Option<i64>,
    pub recovered_uncertain_at_millis: Option<i64>,
    pub reconciled_not_submitted_at_millis: Option<i64>,
}

pub const MAX_NOTICE_EXAMINED_SCOPES: usize = 128;
pub const MAX_NOTICE_GAP_ITEMS: usize = 8;
pub const MAX_NOTICE_GROUPS_PER_ITEM: usize = 16;
pub const MAX_NOTICE_GAP_REQUEST_LIMIT: usize = 8;

/// Store-issued continuation over the ordered notice-coverage primary key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NoticeGapCursor {
    pub(crate) after_peer: PeerId,
    pub(crate) after_binding: Revision,
    pub(crate) after_group: GroupId,
}
impl NoticeGapCursor {
    pub fn after_peer(&self) -> &PeerId {
        &self.after_peer
    }
    pub fn after_binding(&self) -> Revision {
        self.after_binding
    }
    pub fn after_group(&self) -> &GroupId {
        &self.after_group
    }
}

/// Current per-group authority and coverage frozen into a store candidate.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NoticeGroupWatermark {
    pub(crate) group_id: GroupId,
    pub(crate) policy_revision: Revision,
    pub(crate) covered_through_sequence: u64,
    pub(crate) last_attempt_id: Option<NoticeAttemptId>,
}
impl NoticeGroupWatermark {
    pub fn group_id(&self) -> &GroupId {
        &self.group_id
    }
    pub fn policy_revision(&self) -> Revision {
        self.policy_revision
    }
    pub fn covered_through_sequence(&self) -> u64 {
        self.covered_through_sequence
    }
}

/// Compact store-issued slice for one exact current binding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NoticeCandidate {
    pub(crate) authority_id: AuthorityId,
    pub(crate) recipient_peer_id: PeerId,
    pub(crate) binding_revision: Revision,
    pub(crate) run_revision: Revision,
    pub(crate) groups: Vec<NoticeGroupWatermark>,
    pub(crate) more_groups: bool,
}
impl NoticeCandidate {
    pub fn recipient_peer_id(&self) -> &PeerId {
        &self.recipient_peer_id
    }
    pub fn binding_revision(&self) -> Revision {
        self.binding_revision
    }
    pub fn run_revision(&self) -> Revision {
        self.run_revision
    }
    pub fn groups(&self) -> &[NoticeGroupWatermark] {
        &self.groups
    }
    pub fn more_groups(&self) -> bool {
        self.more_groups
    }

    pub(crate) fn estimated_retained_bytes(&self) -> usize {
        1024usize
            .saturating_add(self.authority_id.0.capacity())
            .saturating_add(self.recipient_peer_id.0.capacity())
            .saturating_add(self.groups.iter().fold(
                self.groups.capacity().saturating_mul(256),
                |bytes, group| {
                    bytes
                        .saturating_add(group.group_id.0.capacity())
                        .saturating_add(
                            group
                                .last_attempt_id
                                .as_ref()
                                .map_or(0, |attempt| attempt.0.capacity()),
                        )
                },
            ))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NoticeCandidatePage {
    pub(crate) candidates: Vec<NoticeCandidate>,
    pub(crate) next: Option<NoticeGapCursor>,
    pub(crate) examined_scopes: usize,
}
impl NoticeCandidatePage {
    pub fn candidates(&self) -> &[NoticeCandidate] {
        &self.candidates
    }
    pub fn next(&self) -> Option<&NoticeGapCursor> {
        self.next.as_ref()
    }
    pub fn examined_scopes(&self) -> usize {
        self.examined_scopes
    }

    pub fn estimated_retained_bytes(&self) -> usize {
        let candidates = self.candidates.iter().fold(
            self.candidates.capacity().saturating_mul(128),
            |bytes, candidate| bytes.saturating_add(candidate.estimated_retained_bytes()),
        );
        4096usize
            .saturating_add(candidates)
            .saturating_add(self.next.as_ref().map_or(0, |cursor| {
                cursor
                    .after_peer
                    .0
                    .capacity()
                    .saturating_add(cursor.after_group.0.capacity())
                    .saturating_add(128)
            }))
    }
}

/// Durable ticket committed before native notice I/O begins.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NoticeTicket {
    pub(crate) attempt_id: NoticeAttemptId,
    pub(crate) candidate: NoticeCandidate,
    pub(crate) recipient_binding: PeerBindingRecord,
    pub(crate) attempt_number: u64,
    pub(crate) run_revision: Revision,
}
impl NoticeTicket {
    pub fn attempt_id(&self) -> &NoticeAttemptId {
        &self.attempt_id
    }
    pub fn candidate(&self) -> &NoticeCandidate {
        &self.candidate
    }
    pub fn recipient_binding(&self) -> &PeerBindingRecord {
        &self.recipient_binding
    }
    pub fn attempt_number(&self) -> u64 {
        self.attempt_number
    }
    pub fn run_revision(&self) -> Revision {
        self.run_revision
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NoticeReceiptRecord {
    pub native_record_kind: String,
    pub provenance_reference: String,
    pub enrolled_source_identity: String,
    pub enrolled_generation: String,
    pub native_item_identity: String,
    pub received_at_millis: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NoticeAttemptStatus {
    pub(crate) attempt_id: NoticeAttemptId,
    pub(crate) outcome: Option<AttemptOutcome>,
    pub(crate) completed_at_millis: Option<i64>,
    pub(crate) recovered_uncertain_at_millis: Option<i64>,
    pub(crate) reconciled_not_submitted_at_millis: Option<i64>,
    pub(crate) receipt: Option<NoticeReceiptRecord>,
}
impl NoticeAttemptStatus {
    pub fn attempt_id(&self) -> &NoticeAttemptId {
        &self.attempt_id
    }
    pub fn outcome(&self) -> Option<AttemptOutcome> {
        self.outcome
    }
    pub fn completed_at_millis(&self) -> Option<i64> {
        self.completed_at_millis
    }
    pub fn recovered_uncertain_at_millis(&self) -> Option<i64> {
        self.recovered_uncertain_at_millis
    }
    pub fn reconciled_not_submitted_at_millis(&self) -> Option<i64> {
        self.reconciled_not_submitted_at_millis
    }
    pub fn receipt(&self) -> Option<&NoticeReceiptRecord> {
        self.receipt.as_ref()
    }
}

/// Trusted proof that one exact notice attempt was not submitted. This type
/// deliberately has no `Deserialize`; construction is not native verification.
#[derive(Clone, Debug)]
pub struct VerifiedNoticeNotSubmitted {
    pub(crate) attempt_id: NoticeAttemptId,
    pub(crate) evidence_reference: String,
}
impl VerifiedNoticeNotSubmitted {
    pub fn trusted(
        attempt_id: NoticeAttemptId,
        evidence_reference: String,
    ) -> Result<Self, ValidationError> {
        validate_nonempty(
            "notice_not_submitted_evidence",
            &evidence_reference,
            MAX_METADATA_BYTES,
        )?;
        Ok(Self {
            attempt_id,
            evidence_reference,
        })
    }
}

/// Trusted positive native receipt for one exact ticket target. This type has
/// no `Deserialize`; an adapter must authenticate all evidence before calling.
#[derive(Clone, Debug)]
pub struct VerifiedNoticeReceipt {
    pub(crate) attempt_id: NoticeAttemptId,
    pub(crate) recipient_binding: PeerBindingRecord,
    pub(crate) native_record_kind: String,
    pub(crate) provenance_reference: String,
    pub(crate) enrolled_source_identity: String,
    pub(crate) enrolled_generation: String,
    pub(crate) native_item_identity: String,
}
impl VerifiedNoticeReceipt {
    #[allow(clippy::too_many_arguments)]
    pub fn trusted(
        attempt_id: NoticeAttemptId,
        recipient_binding: &PeerBindingRecord,
        native_record_kind: String,
        provenance_reference: String,
        enrolled_source_identity: String,
        enrolled_generation: String,
        native_item_identity: String,
    ) -> Result<Self, ValidationError> {
        recipient_binding.validate()?;
        validate_nonempty("native_record_kind", &native_record_kind, MAX_LABEL_BYTES)?;
        for (field, value) in [
            ("provenance_reference", &provenance_reference),
            ("enrolled_source_identity", &enrolled_source_identity),
            ("enrolled_generation", &enrolled_generation),
            ("native_item_identity", &native_item_identity),
        ] {
            validate_nonempty(field, value, MAX_METADATA_BYTES)?;
        }
        Ok(Self {
            attempt_id,
            recipient_binding: recipient_binding.clone(),
            native_record_kind,
            provenance_reference,
            enrolled_source_identity,
            enrolled_generation,
            native_item_identity,
        })
    }
}

/// Trusted source-binder assertion of the same conversation AND branch.
/// No Deserialize: constructing this is not OS/process/source authentication.
/// `branch_evidence` identifies already-verified evidence; equality of conversation
/// names, a pane, or this string alone never establishes continuity in the core.
#[derive(Clone, Debug)]
pub struct VerifiedContinuation {
    pub(crate) predecessor: PeerBindingRecord,
    pub(crate) successor: VerifiedBinding,
    pub(crate) branch_evidence: String,
}
impl VerifiedContinuation {
    pub fn trusted(
        predecessor: &PeerBindingRecord,
        successor: VerifiedBinding,
        branch_evidence: String,
    ) -> Result<Self, ValidationError> {
        predecessor.validate()?;
        validate_nonempty("branch_evidence", &branch_evidence, MAX_METADATA_BYTES)?;
        if predecessor.conversation_id != successor.conversation_id
            || predecessor.harness != successor.harness
            || predecessor.launch_id == successor.launch_id
        {
            return Err(ValidationError::InvalidContinuation);
        }
        Ok(Self {
            predecessor: predecessor.clone(),
            successor,
            branch_evidence,
        })
    }
}

/// Trusted binder proof for this exact attempt that the native item has never
/// been delivered and cannot arrive later. Merely clicking release, seeing a
/// warning, or observing no ACK is not this evidence. No OS verification or
/// authentication is performed by this non-deserializable library constructor.
#[derive(Clone, Debug)]
pub struct VerifiedNotSubmitted {
    pub(crate) attempt_id: DeliveryAttemptId,
    pub(crate) evidence_reference: String,
}
impl VerifiedNotSubmitted {
    pub fn trusted(
        attempt_id: DeliveryAttemptId,
        evidence_reference: String,
    ) -> Result<Self, ValidationError> {
        validate_nonempty(
            "not_submitted_evidence",
            &evidence_reference,
            MAX_METADATA_BYTES,
        )?;
        Ok(Self {
            attempt_id,
            evidence_reference,
        })
    }
}
