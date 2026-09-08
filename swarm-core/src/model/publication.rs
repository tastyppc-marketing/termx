//! Publication ownership types (Task 2 repair C1).
//!
//! A response is published in four owned steps that share one immutable
//! buffer and one destination credit guard:
//!
//! 1. The trusted reader performs source I/O under a lease and records a
//!    [`SourceSnapshotObservation`] bound to that exact lease.
//! 2. The consumer reserves output credits on its destination and wraps the
//!    counted guard in a [`DestinationReservation`].
//! 3. [`PreparedPublication::prepare`] checks the observation against the
//!    lease, bounds the body and requires the reservation to cover it. The
//!    result is not `Clone` and not deserializable: it can be validated once.
//! 4. Writer validation consumes the prepared value and returns a
//!    [`CommittedPublication`] holding the same buffer and guard, which is
//!    turned into exactly one [`PublicationSend`] for its bound destination.
//!
//! Every path (rejection, drop, mismatch, finish) releases the guard exactly
//! once because the guard is owned, never copied. No type here carries a
//! resolver key, delivery evidence or ACK meaning.

use std::fmt;

use rand::{rngs::OsRng, RngCore};
use serde::Serialize;

use super::{
    sqlite_i64, validate_nonempty, AuthorityId, ContextGrantLease, GroupId, LeaseId, PeerId,
    PublicationCommitmentId, Revision, SourceId, MAX_METADATA_BYTES,
};
use crate::error::ValidationError;

/// Largest response body accepted for publication.
pub const MAX_PUBLICATION_BYTES: usize = 8 * 1024 * 1024;
/// Documented allowance for transport framing above the body when a consumer
/// reserves destination credits for one publication.
pub const MAX_PUBLICATION_RESERVATION_OVERHEAD_BYTES: usize = 64 * 1024;
/// Largest destination reservation a single publication may own.
pub const MAX_PUBLICATION_RESERVATION_BYTES: usize =
    MAX_PUBLICATION_BYTES + MAX_PUBLICATION_RESERVATION_OVERHEAD_BYTES;

opaque_local_id!(PublicationResponseId, "pr_");
opaque_local_id!(PublicationDestinationId, "dst_");

/// What the trusted reader observed of one source under one exact lease.
///
/// `trusted` is a library entry point for the reader that performed the I/O;
/// constructing this value does not itself open or authenticate a source.
/// Validation later requires every identity here to match the lease exactly.
#[derive(Clone, Debug)]
pub struct SourceSnapshotObservation {
    lease_id: LeaseId,
    authority_id: AuthorityId,
    source_id: SourceId,
    source_owner_peer_id: PeerId,
    source_owner_binding_revision: Revision,
    registration_epoch: Revision,
    object_identity: String,
    snapshot_identity: String,
    captured_through: Option<u64>,
}

impl SourceSnapshotObservation {
    pub fn trusted(
        lease: &ContextGrantLease,
        snapshot_identity: String,
        captured_through: Option<u64>,
    ) -> Result<Self, ValidationError> {
        validate_nonempty("snapshot_identity", &snapshot_identity, MAX_METADATA_BYTES)?;
        if let Some(through) = captured_through {
            sqlite_i64("captured_through", through)?;
        }
        Ok(Self {
            lease_id: lease.lease_id.clone(),
            authority_id: lease.authority_id.clone(),
            source_id: lease.source_id.clone(),
            source_owner_peer_id: lease.source_owner_peer_id.clone(),
            source_owner_binding_revision: lease.source_owner_binding_revision,
            registration_epoch: lease.registration_epoch,
            object_identity: lease.object_identity.clone(),
            snapshot_identity,
            captured_through,
        })
    }

    pub fn lease_id(&self) -> &LeaseId {
        &self.lease_id
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
    pub fn object_identity(&self) -> &str {
        &self.object_identity
    }
    pub fn snapshot_identity(&self) -> &str {
        &self.snapshot_identity
    }
    pub fn captured_through(&self) -> Option<u64> {
        self.captured_through
    }

    fn require_lease(&self, lease: &ContextGrantLease) -> Result<(), ValidationError> {
        let mismatch = |field| ValidationError::EvidenceMismatch { field };
        if self.lease_id != lease.lease_id {
            return Err(mismatch("lease_id"));
        }
        if self.authority_id != lease.authority_id {
            return Err(mismatch("authority_id"));
        }
        if self.source_id != lease.source_id {
            return Err(mismatch("source_id"));
        }
        if self.source_owner_peer_id != lease.source_owner_peer_id {
            return Err(mismatch("source_owner_peer_id"));
        }
        if self.source_owner_binding_revision != lease.source_owner_binding_revision {
            return Err(mismatch("source_owner_binding_revision"));
        }
        if self.registration_epoch != lease.registration_epoch {
            return Err(mismatch("registration_epoch"));
        }
        if self.object_identity != lease.object_identity {
            return Err(mismatch("object_identity"));
        }
        Ok(())
    }

    pub(crate) fn estimated_bytes(&self) -> usize {
        self.object_identity
            .capacity()
            .saturating_add(self.snapshot_identity.capacity())
    }
}

/// Counted, owned destination credits. Implemented by the consumer's own
/// permit type; dropping the implementor must return exactly its bytes.
/// The core never clones, splits or re-derives a guard.
pub trait OwnedDestinationCredits: Send + fmt::Debug + 'static {
    fn reserved_bytes(&self) -> usize;
}

/// One owned reservation on one opaque destination.
pub struct DestinationReservation {
    destination_id: PublicationDestinationId,
    reserved_bytes: usize,
    /// Held only for its `Drop`: releasing it is the credit return.
    _guard: Box<dyn OwnedDestinationCredits>,
}

impl fmt::Debug for DestinationReservation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DestinationReservation")
            .field("destination_id", &self.destination_id)
            .field("reserved_bytes", &self.reserved_bytes)
            .finish_non_exhaustive()
    }
}

impl DestinationReservation {
    /// Wraps an actually held guard. A zero-byte guard is not a reservation,
    /// and a guard beyond the documented publication maximum is rejected; in
    /// both cases the guard is dropped here and its bytes return to the owner.
    pub fn from_owned(
        destination_id: PublicationDestinationId,
        guard: impl OwnedDestinationCredits,
    ) -> Result<Self, ValidationError> {
        let reserved_bytes = guard.reserved_bytes();
        if reserved_bytes == 0 {
            return Err(ValidationError::Empty {
                field: "reserved_bytes",
            });
        }
        if reserved_bytes > MAX_PUBLICATION_RESERVATION_BYTES {
            return Err(ValidationError::TooLarge {
                field: "reserved_bytes",
                max: MAX_PUBLICATION_RESERVATION_BYTES,
            });
        }
        Ok(Self {
            destination_id,
            reserved_bytes,
            _guard: Box::new(guard),
        })
    }

    pub fn destination_id(&self) -> &PublicationDestinationId {
        &self.destination_id
    }

    pub fn reserved_bytes(&self) -> usize {
        self.reserved_bytes
    }
}

/// One exact immutable response buffer ready for writer validation.
///
/// Not `Clone`, not `Deserialize`: it is consumed by validation exactly once.
///
/// ```
/// use termx_swarm_core::model::PreparedPublication;
/// fn body_bytes(prepared: &PreparedPublication) -> usize {
///     prepared.body().len()
/// }
/// ```
///
/// ```compile_fail
/// use termx_swarm_core::model::PreparedPublication;
/// fn duplicate(prepared: PreparedPublication) -> (PreparedPublication, PreparedPublication) {
///     (prepared.clone(), prepared)
/// }
/// ```
pub struct PreparedPublication {
    lease: ContextGrantLease,
    observation: SourceSnapshotObservation,
    response_id: PublicationResponseId,
    body: Box<[u8]>,
    reservation: DestinationReservation,
}

impl fmt::Debug for PreparedPublication {
    /// The buffer is never printed; the lease redacts its resolver key.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PreparedPublication")
            .field("response_id", &self.response_id)
            .field("destination_id", &self.reservation.destination_id)
            .field("body_bytes", &self.body.len())
            .field("reserved_bytes", &self.reservation.reserved_bytes)
            .field("lease", &self.lease)
            .field("observation", &self.observation)
            .finish()
    }
}

impl PreparedPublication {
    /// Binds the buffer to its lease-scoped observation and owned credits.
    /// Any rejection drops the reservation, returning its bytes.
    pub fn prepare(
        lease: ContextGrantLease,
        observation: SourceSnapshotObservation,
        body: Vec<u8>,
        reservation: DestinationReservation,
    ) -> Result<Self, ValidationError> {
        observation.require_lease(&lease)?;
        if body.is_empty() {
            return Err(ValidationError::Empty { field: "body" });
        }
        if body.len() > MAX_PUBLICATION_BYTES {
            return Err(ValidationError::TooLong {
                field: "body",
                max: MAX_PUBLICATION_BYTES,
            });
        }
        if reservation.reserved_bytes < body.len() {
            return Err(ValidationError::InsufficientReservation {
                reserved: reservation.reserved_bytes,
                required: body.len(),
            });
        }
        Ok(Self {
            lease,
            observation,
            response_id: PublicationResponseId::generate(),
            body: body.into_boxed_slice(),
            reservation,
        })
    }

    pub fn response_id(&self) -> &PublicationResponseId {
        &self.response_id
    }
    pub fn lease(&self) -> &ContextGrantLease {
        &self.lease
    }
    pub fn observation(&self) -> &SourceSnapshotObservation {
        &self.observation
    }
    pub fn body(&self) -> &[u8] {
        &self.body
    }
    pub fn destination_id(&self) -> &PublicationDestinationId {
        &self.reservation.destination_id
    }
    pub fn reserved_bytes(&self) -> usize {
        self.reservation.reserved_bytes
    }

    /// Heap bytes carried through the worker: lease strings, observation
    /// strings and the real body.
    pub(crate) fn estimated_bytes(&self) -> usize {
        self.lease
            .estimated_bytes()
            .saturating_add(self.observation.estimated_bytes())
            .saturating_add(self.body.len())
    }

    pub(crate) fn into_parts(
        self,
    ) -> (
        ContextGrantLease,
        SourceSnapshotObservation,
        PublicationResponseId,
        Box<[u8]>,
        DestinationReservation,
    ) {
        (
            self.lease,
            self.observation,
            self.response_id,
            self.body,
            self.reservation,
        )
    }
}

/// Durable single-use audit record of one committed response.
///
/// Successful writer validation is the authorization linearization point.
/// This is not delivery, not fetch evidence and not an ACK; it names one
/// buffer that was authorized for one destination exactly once.
#[derive(Clone, Debug)]
pub struct PublicationCommitment {
    pub(crate) commitment_id: PublicationCommitmentId,
    pub(crate) lease_id: LeaseId,
    pub(crate) response_id: PublicationResponseId,
    pub(crate) destination_id: PublicationDestinationId,
    pub(crate) group_id: GroupId,
    pub(crate) policy_revision: Revision,
    pub(crate) caller_peer_id: PeerId,
    pub(crate) caller_binding_revision: Revision,
    pub(crate) source_id: SourceId,
    pub(crate) registration_epoch: Revision,
    pub(crate) body_bytes: u64,
    pub(crate) reserved_bytes: u64,
    pub(crate) snapshot_identity: String,
    pub(crate) captured_through: Option<u64>,
    pub(crate) committed_at_millis: i64,
}

impl PublicationCommitment {
    pub fn commitment_id(&self) -> &PublicationCommitmentId {
        &self.commitment_id
    }
    pub fn lease_id(&self) -> &LeaseId {
        &self.lease_id
    }
    pub fn response_id(&self) -> &PublicationResponseId {
        &self.response_id
    }
    pub fn destination_id(&self) -> &PublicationDestinationId {
        &self.destination_id
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
    pub fn body_bytes(&self) -> u64 {
        self.body_bytes
    }
    pub fn reserved_bytes(&self) -> u64 {
        self.reserved_bytes
    }
    pub fn snapshot_identity(&self) -> &str {
        &self.snapshot_identity
    }
    pub fn captured_through(&self) -> Option<u64> {
        self.captured_through
    }
    pub fn committed_at_millis(&self) -> i64 {
        self.committed_at_millis
    }
    pub(crate) fn estimated_bytes(&self) -> usize {
        self.snapshot_identity.capacity()
    }
}

/// A validated response: the same buffer and the same credit guard that were
/// prepared, now durably committed. Not `Clone`; consumed by `into_send`.
///
/// ```
/// use termx_swarm_core::model::{CommittedPublication, PublicationDestinationId};
/// fn send_once(committed: CommittedPublication, destination: &PublicationDestinationId) -> usize {
///     match committed.into_send(destination) {
///         Ok(send) => send.body().len(),
///         Err(_) => 0,
///     }
/// }
/// ```
///
/// ```compile_fail
/// use termx_swarm_core::model::{CommittedPublication, PublicationDestinationId};
/// fn send_twice(committed: CommittedPublication, destination: &PublicationDestinationId) {
///     let _ = committed.into_send(destination);
///     let _ = committed.into_send(destination);
/// }
/// ```
///
/// ```compile_fail
/// use termx_swarm_core::model::CommittedPublication;
/// fn duplicate(committed: CommittedPublication) -> (CommittedPublication, CommittedPublication) {
///     (committed.clone(), committed)
/// }
/// ```
pub struct CommittedPublication {
    record: PublicationCommitment,
    body: Box<[u8]>,
    reservation: DestinationReservation,
}

impl fmt::Debug for CommittedPublication {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CommittedPublication")
            .field("record", &self.record)
            .field("body_bytes", &self.body.len())
            .field("reservation", &self.reservation)
            .finish()
    }
}

impl CommittedPublication {
    pub(crate) fn new(
        record: PublicationCommitment,
        body: Box<[u8]>,
        reservation: DestinationReservation,
    ) -> Self {
        Self {
            record,
            body,
            reservation,
        }
    }

    pub fn record(&self) -> &PublicationCommitment {
        &self.record
    }
    pub fn body(&self) -> &[u8] {
        &self.body
    }
    pub fn destination_id(&self) -> &PublicationDestinationId {
        &self.reservation.destination_id
    }
    pub fn reserved_bytes(&self) -> usize {
        self.reservation.reserved_bytes
    }

    /// Attaches the committed buffer to the exact destination it was reserved
    /// for. A different destination (for example a reconnected output slot)
    /// consumes the object and releases its credits: publishing there needs
    /// fresh validation under a new lease and new ownership.
    pub fn into_send(
        self,
        destination: &PublicationDestinationId,
    ) -> Result<PublicationSend, ValidationError> {
        if self.reservation.destination_id != *destination {
            return Err(ValidationError::DestinationMismatch);
        }
        Ok(PublicationSend {
            record: self.record,
            body: self.body,
            reservation: self.reservation,
        })
    }

    pub(crate) fn estimated_bytes(&self) -> usize {
        self.body
            .len()
            .saturating_add(self.record.estimated_bytes())
    }
}

/// The single send of one committed buffer to its bound destination. The
/// transport reads `body` and then calls `finish`, which releases the credits
/// exactly once; dropping an unsent value releases them too.
///
/// ```compile_fail
/// use termx_swarm_core::model::PublicationSend;
/// fn finish_twice(send: PublicationSend) {
///     let _ = send.finish();
///     let _ = send.finish();
/// }
/// ```
pub struct PublicationSend {
    record: PublicationCommitment,
    body: Box<[u8]>,
    reservation: DestinationReservation,
}

impl fmt::Debug for PublicationSend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PublicationSend")
            .field("record", &self.record)
            .field("body_bytes", &self.body.len())
            .field("reservation", &self.reservation)
            .finish()
    }
}

impl PublicationSend {
    pub fn record(&self) -> &PublicationCommitment {
        &self.record
    }
    pub fn body(&self) -> &[u8] {
        &self.body
    }
    pub fn destination_id(&self) -> &PublicationDestinationId {
        &self.reservation.destination_id
    }
    pub fn reserved_bytes(&self) -> usize {
        self.reservation.reserved_bytes
    }

    /// Ends the send: the buffer and the credit guard are dropped here, and
    /// only the durable audit record remains.
    pub fn finish(self) -> PublicationCommitment {
        let Self {
            record,
            body,
            reservation,
        } = self;
        drop(body);
        drop(reservation);
        record
    }
}
