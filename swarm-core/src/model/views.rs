//! Task 2 discovery, navigation, source and publication types.
//!
//! Peer projections here carry only explicitly public metadata. Native binding
//! details (terminal, process, FILETIME), resolver keys, authority identity and
//! principals never appear in a peer-facing `Serialize` output. Trusted evidence
//! types deliberately have no `Deserialize`.

use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};

use super::{
    sqlite_i64, validate_nonempty, GroupId, GroupRecord, LaunchId, MailboxCursor, MessageId,
    MessageRecord, PeerBindingRecord, PeerId, ReceiptRecord, Revision, SourceReferenceId,
    MAX_LABEL_BYTES, MAX_MAILBOX_PAGE_ITEMS, MAX_METADATA_BYTES,
};
use crate::error::ValidationError;

opaque_id!(SourceId, "src_");
opaque_id!(LeaseId, "lease_");
opaque_id!(PublicationCommitmentId, "pub_");

/// Attachments per message; each is a bounded reference, never content.
pub const MAX_ATTACHMENTS_PER_MESSAGE: usize = 64;
/// Optional caller-owned status text per explicit group.
pub const MAX_STATUS_BYTES: usize = MAX_METADATA_BYTES;
/// Items per metadata page (WhoAmI, ListPeers, owner peer/group pages).
pub const MAX_METADATA_PAGE_ITEMS: usize = 128;
/// Complete serialized envelope bound for metadata pages.
pub const MAX_METADATA_PAGE_BYTES: usize = 2 * 1024 * 1024;
/// Active registrations per peer binding, bounding nested source metadata.
pub const MAX_ACTIVE_SOURCES_PER_BINDING: usize = 8;

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/// A sender's citation of a registered source. Conveys no authority: the store
/// checks current source authorization at send time and again on dereference.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceAttachment {
    pub source_id: SourceId,
    /// Opaque snapshot/observation reference supplied by the citing caller.
    pub snapshot_reference: Option<String>,
}

impl SourceAttachment {
    pub(crate) fn validate(&self) -> Result<(), ValidationError> {
        if let Some(reference) = &self.snapshot_reference {
            validate_nonempty("snapshot_reference", reference, MAX_METADATA_BYTES)?;
        }
        Ok(())
    }
}

pub(crate) fn validate_attachments(
    attachments: &[SourceAttachment],
) -> Result<(), ValidationError> {
    if attachments.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(ValidationError::TooLarge {
            field: "attachments",
            max: MAX_ATTACHMENTS_PER_MESSAGE,
        });
    }
    for (index, attachment) in attachments.iter().enumerate() {
        attachment.validate()?;
        if attachments[..index]
            .iter()
            .any(|earlier| earlier.source_id == attachment.source_id)
        {
            return Err(ValidationError::InvalidId {
                kind: "duplicate attachment source",
            });
        }
    }
    Ok(())
}

/// Immutable per-message attachment as committed with the message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentRecord {
    pub source_reference_id: SourceReferenceId,
    pub source_id: SourceId,
    pub source_kind: String,
    pub owner_peer_id: PeerId,
    pub snapshot_reference: Option<String>,
}

/// Current availability of a cited source for the resolving caller. A stale or
/// replaced reference is never redirected to newer content.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceAvailability {
    Available {
        registration_epoch: Revision,
    },
    Stale {
        cited_epoch: Revision,
        current_epoch: Revision,
    },
    Withdrawn,
    Replaced,
    /// The owner's current binding differs from the registered binding.
    StaleBinding,
    /// The source owner is not an active member of the explicit group.
    OwnerNotMember,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AttachmentView {
    pub group_id: GroupId,
    pub message_id: MessageId,
    pub attachment: AttachmentRecord,
    pub availability: SourceAvailability,
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/// A fresh position and an existing cursor are mutually exclusive by type. A
/// position is navigation only: not authorization, fetch evidence or ACK.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum MailboxNavigation {
    After { after_sequence: u64 },
    Cursor(MailboxCursor),
}

impl MailboxNavigation {
    pub(crate) fn validate(&self) -> Result<(), ValidationError> {
        if let Self::After { after_sequence } = self {
            sqlite_i64("after_sequence", *after_sequence)?;
        }
        Ok(())
    }
}

fn validate_page_items(max_items: usize, max: usize) -> Result<(), ValidationError> {
    if max_items == 0 {
        return Err(ValidationError::Empty { field: "max_items" });
    }
    if max_items > max {
        return Err(ValidationError::TooLarge {
            field: "max_items",
            max,
        });
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MailboxAfterRequest {
    pub group_id: GroupId,
    pub navigation: MailboxNavigation,
    pub max_items: usize,
}

impl MailboxAfterRequest {
    pub(crate) fn validate(&self) -> Result<(), ValidationError> {
        self.navigation.validate()?;
        validate_page_items(self.max_items, MAX_MAILBOX_PAGE_ITEMS)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThreadPageRequest {
    pub group_id: GroupId,
    /// Thread root selector. Every message in the page is still authorized
    /// individually; a visible root grants nothing about its descendants.
    pub root: MessageId,
    pub navigation: MailboxNavigation,
    pub max_items: usize,
}

impl ThreadPageRequest {
    pub(crate) fn validate(&self) -> Result<(), ValidationError> {
        self.navigation.validate()?;
        validate_page_items(self.max_items, MAX_MAILBOX_PAGE_ITEMS)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutgoingPageRequest {
    pub group_id: GroupId,
    pub navigation: MailboxNavigation,
    pub max_items: usize,
}

impl OutgoingPageRequest {
    pub(crate) fn validate(&self) -> Result<(), ValidationError> {
        self.navigation.validate()?;
        validate_page_items(self.max_items, MAX_MAILBOX_PAGE_ITEMS)
    }
}

/// One thread message visible to the caller. `receipt` is present only when
/// the caller is a current recipient of that exact message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadEntry {
    pub message: MessageRecord,
    pub receipt: Option<ReceiptRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadPage {
    pub root: MessageId,
    pub messages: Vec<ThreadEntry>,
    pub next_cursor: Option<MailboxCursor>,
    pub snapshot_high_sequence: u64,
}

/// Per-recipient durable state of one message. Receipt fields are evidence
/// recorded by the recipient's own fetch/ACK/reply, never inferred.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipientState {
    pub peer_id: PeerId,
    pub original_binding_revision: Revision,
    pub current_binding_revision: Revision,
    pub generation: Revision,
    pub fetched_at_millis: Option<i64>,
    pub acknowledged_at_millis: Option<i64>,
    pub replied_by: Option<MessageId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageStateEntry {
    pub message: MessageRecord,
    pub recipients: Vec<RecipientState>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutgoingPage {
    pub messages: Vec<MessageStateEntry>,
    pub next_cursor: Option<MailboxCursor>,
    pub snapshot_high_sequence: u64,
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WhoAmIRequest {
    pub after_group: Option<GroupId>,
    pub max_items: usize,
}

impl WhoAmIRequest {
    pub(crate) fn validate(&self) -> Result<(), ValidationError> {
        validate_page_items(self.max_items, MAX_METADATA_PAGE_ITEMS)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MembershipAvailability {
    Available,
    Paused,
    BindingOffline,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusRecord {
    pub group_id: GroupId,
    pub peer_id: PeerId,
    pub binding_revision: Revision,
    pub status: Option<String>,
    pub status_revision: Revision,
    pub updated_at_millis: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MembershipView {
    pub group_id: GroupId,
    pub label: String,
    pub policy_revision: Revision,
    pub paused: bool,
    pub added_policy_revision: Revision,
    pub availability: MembershipAvailability,
    pub status: Option<StatusRecord>,
}

/// Bootstrap self view: the authenticated peer, its live binding and a bounded
/// page of current memberships. It grants no content access.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelfView {
    pub peer_id: PeerId,
    pub binding_revision: Revision,
    pub launch_id: LaunchId,
    pub harness: String,
    pub model_metadata: Option<String>,
    pub is_live: bool,
    pub memberships: Vec<MembershipView>,
    pub next_after_group: Option<GroupId>,
    pub inventory_revision: Revision,
    pub run_revision: Option<Revision>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListPeersRequest {
    pub group_id: GroupId,
    pub after_peer: Option<PeerId>,
    pub max_items: usize,
}

impl ListPeersRequest {
    pub(crate) fn validate(&self) -> Result<(), ValidationError> {
        validate_page_items(self.max_items, MAX_METADATA_PAGE_ITEMS)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceSummary {
    pub source_id: SourceId,
    pub source_kind: String,
    pub registration_epoch: Revision,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerView {
    pub peer_id: PeerId,
    pub binding_revision: Revision,
    pub launch_id: LaunchId,
    pub harness: String,
    pub model_metadata: Option<String>,
    pub is_live: bool,
    pub added_policy_revision: Revision,
    pub status: Option<StatusRecord>,
    /// Sources registered against the peer's current binding and active.
    pub sources: Vec<SourceSummary>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerPage {
    pub group_id: GroupId,
    pub policy_revision: Revision,
    pub inventory_revision: Revision,
    pub peers: Vec<PeerView>,
    pub next_after_peer: Option<PeerId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusRequest {
    pub group_id: GroupId,
    /// `None` clears the caller's status in this group.
    pub status: Option<String>,
}

impl StatusRequest {
    pub(crate) fn validate(&self) -> Result<(), ValidationError> {
        if let Some(status) = &self.status {
            validate_nonempty("status", status, MAX_STATUS_BYTES)?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/// Trusted enrollment assertion that a native adapter has verified a recorded
/// source object for exactly this peer binding and conversation.
///
/// No `Deserialize`: constructing this is not OS/file/source authentication.
/// Before constructing it, the trusted adapter (Task 4) must have opened the
/// source through a retained handle, verified its object identity and
/// conversation header, and bound an opaque resolver key that only trusted
/// native code can dereference. The core validates bounded structure only.
#[derive(Clone)]
pub struct VerifiedSourceDescriptor {
    pub(crate) peer_id: PeerId,
    pub(crate) binding_revision: Revision,
    pub(crate) conversation_id: String,
    pub(crate) source_kind: String,
    pub(crate) resolver_key: String,
    pub(crate) object_identity: String,
    pub(crate) evidence_reference: String,
}

impl std::fmt::Debug for VerifiedSourceDescriptor {
    /// The resolver key is never printed; logs and panics must not leak it.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VerifiedSourceDescriptor")
            .field("peer_id", &self.peer_id)
            .field("binding_revision", &self.binding_revision)
            .field("source_kind", &self.source_kind)
            .field("object_identity", &self.object_identity)
            .field("evidence_reference", &self.evidence_reference)
            .field("resolver_key", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl VerifiedSourceDescriptor {
    pub fn trusted(
        peer_id: PeerId,
        binding_revision: Revision,
        conversation_id: String,
        source_kind: String,
        resolver_key: String,
        object_identity: String,
        evidence_reference: String,
    ) -> Result<Self, ValidationError> {
        validate_nonempty("conversation_id", &conversation_id, MAX_METADATA_BYTES)?;
        validate_nonempty("source_kind", &source_kind, MAX_LABEL_BYTES)?;
        validate_nonempty("resolver_key", &resolver_key, MAX_METADATA_BYTES)?;
        validate_nonempty("object_identity", &object_identity, MAX_METADATA_BYTES)?;
        validate_nonempty(
            "evidence_reference",
            &evidence_reference,
            MAX_METADATA_BYTES,
        )?;
        Ok(Self {
            peer_id,
            binding_revision,
            conversation_id,
            source_kind,
            resolver_key,
            object_identity,
            evidence_reference,
        })
    }

    pub fn peer_id(&self) -> &PeerId {
        &self.peer_id
    }

    pub fn binding_revision(&self) -> Revision {
        self.binding_revision
    }

    pub(crate) fn estimated_bytes(&self) -> usize {
        self.conversation_id
            .capacity()
            .saturating_add(self.source_kind.capacity())
            .saturating_add(self.resolver_key.capacity())
            .saturating_add(self.object_identity.capacity())
            .saturating_add(self.evidence_reference.capacity())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceState {
    Active,
    Withdrawn,
    Replaced,
}

impl SourceState {
    pub(crate) fn from_stored(value: &str) -> Option<Self> {
        match value {
            "active" => Some(Self::Active),
            "withdrawn" => Some(Self::Withdrawn),
            "replaced" => Some(Self::Replaced),
            _ => None,
        }
    }
}

/// Owner-facing registration view. The resolver key is intentionally absent
/// from every serialized view; trusted readers obtain it through a lease.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRegistration {
    pub source_id: SourceId,
    pub peer_id: PeerId,
    pub binding_revision: Revision,
    pub conversation_id: String,
    pub source_kind: String,
    pub object_identity: String,
    pub state: SourceState,
    /// Authorization/identity epoch; changes only through owner transitions.
    pub registration_epoch: Revision,
    pub evidence_reference: String,
    pub replaced_by: Option<SourceId>,
    pub registered_at_millis: i64,
    pub transitioned_at_millis: i64,
    /// Owner inventory revision after the transaction that produced this view.
    pub inventory_revision: Revision,
}

/// Owner expected-epoch transitions. Enabling or replacing a registration
/// requires fresh verified evidence; withdrawal does not.
#[derive(Debug)]
pub enum SourceTransition {
    Withdraw {
        source_id: SourceId,
        expected_epoch: Revision,
    },
    Reestablish {
        source_id: SourceId,
        expected_epoch: Revision,
        descriptor: VerifiedSourceDescriptor,
    },
    Replace {
        source_id: SourceId,
        expected_epoch: Revision,
        descriptor: VerifiedSourceDescriptor,
    },
}

// ---------------------------------------------------------------------------
// Publication leases
// ---------------------------------------------------------------------------

/// Immutable internal evidence acquired under the writer before source I/O.
/// Not deserializable and not a caller-supplied ID: a source ID alone is never
/// a lease. Validation later rechecks every fact recorded here.
#[derive(Clone)]
pub struct ContextGrantLease {
    pub(crate) lease_id: LeaseId,
    pub(crate) authority_id: super::AuthorityId,
    pub(crate) group_id: GroupId,
    pub(crate) policy_revision: Revision,
    pub(crate) caller_peer_id: PeerId,
    pub(crate) caller_binding_revision: Revision,
    pub(crate) source_id: SourceId,
    pub(crate) source_owner_peer_id: PeerId,
    pub(crate) source_owner_binding_revision: Revision,
    pub(crate) registration_epoch: Revision,
    pub(crate) source_kind: String,
    pub(crate) resolver_key: String,
    pub(crate) object_identity: String,
    pub(crate) acquired_at_millis: i64,
}

impl std::fmt::Debug for ContextGrantLease {
    /// The resolver key is never printed; logs and panics must not leak it.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ContextGrantLease")
            .field("lease_id", &self.lease_id)
            .field("group_id", &self.group_id)
            .field("policy_revision", &self.policy_revision)
            .field("caller_peer_id", &self.caller_peer_id)
            .field("caller_binding_revision", &self.caller_binding_revision)
            .field("source_id", &self.source_id)
            .field("source_owner_peer_id", &self.source_owner_peer_id)
            .field(
                "source_owner_binding_revision",
                &self.source_owner_binding_revision,
            )
            .field("registration_epoch", &self.registration_epoch)
            .field("source_kind", &self.source_kind)
            .field("resolver_key", &"<redacted>")
            .field("object_identity", &self.object_identity)
            .field("acquired_at_millis", &self.acquired_at_millis)
            .finish()
    }
}

impl ContextGrantLease {
    pub fn lease_id(&self) -> &LeaseId {
        &self.lease_id
    }
    pub fn group_id(&self) -> &GroupId {
        &self.group_id
    }
    pub fn policy_revision(&self) -> Revision {
        self.policy_revision
    }
    pub fn caller_peer_id(&self) -> &PeerId {
        &self.caller_peer_id
    }
    pub fn caller_binding_revision(&self) -> Revision {
        self.caller_binding_revision
    }
    pub fn source_id(&self) -> &SourceId {
        &self.source_id
    }
    pub fn source_owner_peer_id(&self) -> &PeerId {
        &self.source_owner_peer_id
    }
    pub fn source_owner_binding_revision(&self) -> Revision {
        self.source_owner_binding_revision
    }
    pub fn registration_epoch(&self) -> Revision {
        self.registration_epoch
    }
    pub fn source_kind(&self) -> &str {
        &self.source_kind
    }
    /// Opaque native resolver key for the trusted reader only. Never place
    /// this in a peer DTO, event, log or error.
    pub fn resolver_key(&self) -> &str {
        &self.resolver_key
    }
    pub fn object_identity(&self) -> &str {
        &self.object_identity
    }
    pub fn acquired_at_millis(&self) -> i64 {
        self.acquired_at_millis
    }
    pub(crate) fn estimated_bytes(&self) -> usize {
        self.source_kind
            .capacity()
            .saturating_add(self.resolver_key.capacity())
            .saturating_add(self.object_identity.capacity())
    }
}

/// Identity of one exact immutable response buffer whose destination/output
/// credits the consumer has already reserved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicationIdentity {
    /// Exact immutable response/read identity chosen by the trusted consumer.
    pub response_reference: String,
    /// Credits reserved before validation; must be positive.
    pub reserved_bytes: u64,
}

impl PublicationIdentity {
    pub(crate) fn validate(&self) -> Result<(), ValidationError> {
        validate_nonempty(
            "response_reference",
            &self.response_reference,
            MAX_METADATA_BYTES,
        )?;
        if self.reserved_bytes == 0 {
            return Err(ValidationError::Empty {
                field: "reserved_bytes",
            });
        }
        sqlite_i64("reserved_bytes", self.reserved_bytes)?;
        Ok(())
    }
}

/// Durable single-use commitment of one exact response for publication.
/// Successful writer validation is the authorization linearization point.
/// This is not delivery, not fetch evidence and not an ACK, and it is not a
/// reusable capability: it names one buffer that may be published once.
#[derive(Debug)]
pub struct PublicationCommitment {
    pub(crate) commitment_id: PublicationCommitmentId,
    pub(crate) lease_id: LeaseId,
    pub(crate) response_reference: String,
    pub(crate) group_id: GroupId,
    pub(crate) policy_revision: Revision,
    pub(crate) caller_peer_id: PeerId,
    pub(crate) caller_binding_revision: Revision,
    pub(crate) source_id: SourceId,
    pub(crate) registration_epoch: Revision,
    pub(crate) reserved_bytes: u64,
    pub(crate) committed_at_millis: i64,
}

impl PublicationCommitment {
    pub fn commitment_id(&self) -> &PublicationCommitmentId {
        &self.commitment_id
    }
    pub fn lease_id(&self) -> &LeaseId {
        &self.lease_id
    }
    pub fn response_reference(&self) -> &str {
        &self.response_reference
    }
    pub fn group_id(&self) -> &GroupId {
        &self.group_id
    }
    pub fn policy_revision(&self) -> Revision {
        self.policy_revision
    }
    pub fn caller_peer_id(&self) -> &PeerId {
        &self.caller_peer_id
    }
    pub fn caller_binding_revision(&self) -> Revision {
        self.caller_binding_revision
    }
    pub fn source_id(&self) -> &SourceId {
        &self.source_id
    }
    pub fn registration_epoch(&self) -> Revision {
        self.registration_epoch
    }
    pub fn reserved_bytes(&self) -> u64 {
        self.reserved_bytes
    }
    pub fn committed_at_millis(&self) -> i64 {
        self.committed_at_millis
    }
}

// ---------------------------------------------------------------------------
// Owner snapshots
// ---------------------------------------------------------------------------

/// Durable state revisions. `inventory_revision` advances with peers,
/// bindings, groups, memberships, pause state, sources and statuses;
/// `delivery_revision` with messages, fetch/ACK evidence, delivery attempts,
/// reconciliation, continuation transfers and run recovery. `run_revision` is
/// the durable broker boot epoch after trusted recovery. Timestamps are never
/// used as sequence numbers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StateRevisions {
    pub inventory_revision: Revision,
    pub delivery_revision: Revision,
    pub run_revision: Option<Revision>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum OwnerSnapshotRequest {
    Peers {
        expected_inventory_revision: Option<Revision>,
        after_peer: Option<PeerId>,
        max_items: usize,
    },
    Groups {
        expected_inventory_revision: Option<Revision>,
        after_group: Option<GroupId>,
        max_items: usize,
    },
    Messages {
        group_id: GroupId,
        after_sequence: u64,
        /// Frozen high watermark from an earlier page; `None` freezes now.
        through_sequence: Option<u64>,
        max_items: usize,
    },
}

impl OwnerSnapshotRequest {
    pub(crate) fn validate(&self) -> Result<(), ValidationError> {
        match self {
            Self::Peers { max_items, .. } | Self::Groups { max_items, .. } => {
                validate_page_items(*max_items, MAX_METADATA_PAGE_ITEMS)
            }
            Self::Messages {
                after_sequence,
                through_sequence,
                max_items,
                ..
            } => {
                sqlite_i64("after_sequence", *after_sequence)?;
                if let Some(through) = through_sequence {
                    sqlite_i64("through_sequence", *through)?;
                }
                validate_page_items(*max_items, MAX_MAILBOX_PAGE_ITEMS)
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnerMembershipView {
    pub group_id: GroupId,
    pub added_policy_revision: Revision,
    pub status: Option<StatusRecord>,
}

/// Owner view of one peer. The owner is trusted native code, so the full
/// binding record is included; this type must never be routed to a peer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnerPeerView {
    pub binding: PeerBindingRecord,
    pub memberships: Vec<OwnerMembershipView>,
    pub sources: Vec<SourceRegistration>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnerPeerPage {
    pub revisions: StateRevisions,
    pub peers: Vec<OwnerPeerView>,
    pub next_after_peer: Option<PeerId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnerGroupView {
    pub group: GroupRecord,
    pub high_sequence: u64,
    pub members: Vec<PeerId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnerGroupPage {
    pub revisions: StateRevisions,
    pub groups: Vec<OwnerGroupView>,
    pub next_after_group: Option<GroupId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnerMessagePage {
    pub group_id: GroupId,
    pub revisions: StateRevisions,
    pub snapshot_high_sequence: u64,
    pub messages: Vec<MessageStateEntry>,
    pub next_after_sequence: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OwnerSnapshotPage {
    Peers(OwnerPeerPage),
    Groups(OwnerGroupPage),
    Messages(OwnerMessagePage),
}

pub(crate) fn status_bytes(status: &Option<StatusRecord>) -> usize {
    status
        .as_ref()
        .map_or(0, |s| s.status.as_ref().map_or(0, String::capacity))
}
