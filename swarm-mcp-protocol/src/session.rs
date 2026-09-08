use std::mem::size_of;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::{LimitsError, RequestId};

/// Admission class supplied by the later adapter after outer envelope checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestClass {
    Initialize,
    Ping,
    ReadyOnly,
}

/// Handshake phase of one helper protocol session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Uninitialized,
    Initializing,
    AwaitingInitialized,
    Ready,
    Closed,
}

/// Finite simultaneous registration capacity, not a conversation quota.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub active: usize,
    pub control_reserve: usize,
}

impl Limits {
    /// Suggested default: 32 active slots with 4 reserved for control work.
    ///
    /// These numbers bound concurrent registrations, not lifetime message
    /// count or conversation length.
    pub fn suggested() -> Self {
        Self {
            active: 32,
            control_reserve: 4,
        }
    }

    fn validate(self) -> Result<Self, LimitsError> {
        if !(2..=64).contains(&self.active) {
            return Err(LimitsError::ActiveOutOfRange);
        }
        if self.control_reserve < 1 || self.control_reserve >= self.active {
            return Err(LimitsError::ControlReserveInvalid);
        }
        Ok(self)
    }
}

/// Pure admission disposition. This is not domain authorization or output credit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    Initialize,
    Ping,
    OrdinaryReady,
    CorrelatedPhaseError,
}

/// Admission rejected without creating a lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmitError {
    Capacity,
    TerminalCollision,
    Closed,
}

impl std::fmt::Display for AdmitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Capacity => "no free registration slot for this request class",
            Self::TerminalCollision => "duplicate active request ID closed the helper",
            Self::Closed => "protocol helper is closed",
        })
    }
}

impl std::error::Error for AdmitError {}

/// Terminal send outcome. Domain completion is not represented.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseOutcome {
    ProtocolComplete,
    InitializeSuccess,
    InitializeError,
}

/// Result of a cancel notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelDisposition {
    Marked,
    IgnoredInitialize,
    Unknown,
}

/// Result of an `initialized` notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InitializedDisposition {
    BecameReady,
    Ignored,
}

/// Bounded ownership counters for later output accounting.
///
/// Fixed-overhead assumptions:
/// - `slot_storage_bytes` is `Vec` capacity times `size_of::<Option<Slot>>`.
///   It excludes the `Vec` allocator header and the `Mutex`/`Arc` headers
///   around shared state.
/// - `request_id_heap_bytes` sums [`RequestId::owned_heap_bytes`] for active
///   slots only. Shared `Arc<str>` payloads are counted once, at the slot.
/// - Allocator headers for those string payloads are excluded.
/// - Integer IDs contribute zero heap.
/// - These counters are not transport or response-memory credits. A later
///   adapter must reserve those before any domain side effect and keep them
///   with this lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AccountingSnapshot {
    pub active_registrations: usize,
    pub slot_capacity: usize,
    pub control_reserve: usize,
    pub ordinary_available: usize,
    pub control_available: usize,
    pub request_id_heap_bytes: usize,
    pub slot_storage_bytes: usize,
    pub shared_state_heap_bytes: usize,
}

struct Slot {
    id: RequestId,
    generation: u64,
    cancel: bool,
    handshake_owner: bool,
    initialize: bool,
    control: bool,
}

struct Inner {
    phase: Phase,
    limits: Limits,
    slots: Vec<Option<Slot>>,
    next_generation: u64,
}

/// Shared bounded registration state. Handles may drop while leases remain.
#[derive(Clone)]
pub struct ProtocolSession {
    inner: Arc<Mutex<Inner>>,
}

/// Move-only exact registration lease.
///
/// Not `Clone` and not deserializable. Move it from handler through queued or
/// blocked output to the writer. Successful terminal send or drop releases
/// only this registration. A stale drop cannot free a later occupant of the
/// same slot.
pub struct ActiveRequest {
    inner: Arc<Mutex<Inner>>,
    id: RequestId,
    index: usize,
    generation: u64,
    armed: bool,
}

impl ProtocolSession {
    pub fn new(limits: Limits) -> Result<Self, LimitsError> {
        let limits = limits.validate()?;
        Ok(Self {
            inner: Arc::new(Mutex::new(Inner {
                phase: Phase::Uninitialized,
                limits,
                slots: (0..limits.active).map(|_| None).collect(),
                next_generation: 0,
            })),
        })
    }

    pub fn phase(&self) -> Phase {
        self.lock().phase
    }

    /// Admit a request ID into the bounded in-flight map.
    ///
    /// Duplicate active typed IDs are detected before capacity or phase
    /// rejection, close this helper, and create no second lease. Completed IDs
    /// are not retained; an invalid later reuse is a new request, and a late
    /// cancel cannot be distinguished from cancellation of that new request.
    pub fn admit(
        &self,
        id: RequestId,
        class: RequestClass,
    ) -> Result<(ActiveRequest, Disposition), AdmitError> {
        let mut inner = self.lock();
        if inner.find(&id).is_some() {
            inner.phase = Phase::Closed;
            return Err(AdmitError::TerminalCollision);
        }
        if inner.phase == Phase::Closed {
            return Err(AdmitError::Closed);
        }

        let used = inner.active_count();
        let free = inner.limits.active - used;
        let control = match class {
            RequestClass::Initialize | RequestClass::Ping => true,
            RequestClass::ReadyOnly => inner.phase != Phase::Ready,
        };
        if free == 0 {
            return Err(AdmitError::Capacity);
        }
        if !control {
            let ordinary_used = inner
                .slots
                .iter()
                .flatten()
                .filter(|slot| !slot.control)
                .count();
            let ordinary_cap = inner.limits.active - inner.limits.control_reserve;
            if ordinary_used >= ordinary_cap {
                return Err(AdmitError::Capacity);
            }
        }

        let index = inner
            .slots
            .iter()
            .position(Option::is_none)
            .expect("capacity check guarantees a free slot");
        inner.next_generation = inner.next_generation.saturating_add(1);
        let generation = inner.next_generation;
        let handshake_owner =
            class == RequestClass::Initialize && inner.phase == Phase::Uninitialized;
        if handshake_owner {
            inner.phase = Phase::Initializing;
        }
        inner.slots[index] = Some(Slot {
            id: id.clone(),
            generation,
            cancel: false,
            handshake_owner,
            initialize: class == RequestClass::Initialize,
            control,
        });
        let disposition = match class {
            RequestClass::Initialize if handshake_owner => Disposition::Initialize,
            RequestClass::Initialize => Disposition::CorrelatedPhaseError,
            RequestClass::Ping => Disposition::Ping,
            RequestClass::ReadyOnly if inner.phase == Phase::Ready => Disposition::OrdinaryReady,
            RequestClass::ReadyOnly => Disposition::CorrelatedPhaseError,
        };
        drop(inner);
        Ok((
            ActiveRequest {
                inner: Arc::clone(&self.inner),
                id,
                index,
                generation,
                armed: true,
            },
            disposition,
        ))
    }

    pub fn initialized_notification(&self) -> InitializedDisposition {
        let mut inner = self.lock();
        if inner.phase == Phase::AwaitingInitialized {
            inner.phase = Phase::Ready;
            InitializedDisposition::BecameReady
        } else {
            InitializedDisposition::Ignored
        }
    }

    /// Mark cancellation for the exact active registration.
    ///
    /// This never releases the ID, slot, or any other request. Every
    /// Initialize-class lease ignores cancellation; handshake ownership is
    /// separate. Unknown or late cancellation is a no-op. Repeated
    /// cancellation is idempotent. After an ID has left the map, a later
    /// cancel cannot be distinguished from cancellation of a new request that
    /// reused that ID.
    pub fn cancel(&self, id: &RequestId) -> CancelDisposition {
        let mut inner = self.lock();
        match inner.find(id) {
            Some(index) => {
                let slot = inner.slots[index].as_mut().expect("find returns occupied");
                if slot.initialize {
                    CancelDisposition::IgnoredInitialize
                } else {
                    slot.cancel = true;
                    CancelDisposition::Marked
                }
            }
            None => CancelDisposition::Unknown,
        }
    }

    /// Prevent new admission. Existing leases and their output owners remain
    /// until they send or drop. Close does not reopen.
    pub fn close(&self) {
        self.lock().phase = Phase::Closed;
    }

    pub fn active_count(&self) -> usize {
        self.lock().active_count()
    }

    pub fn accounting(&self) -> AccountingSnapshot {
        let inner = self.lock();
        let active = inner.active_count();
        let free = inner.limits.active - active;
        let ordinary_used = inner
            .slots
            .iter()
            .flatten()
            .filter(|slot| !slot.control)
            .count();
        let ordinary_cap = inner.limits.active - inner.limits.control_reserve;
        let request_id_heap_bytes = inner
            .slots
            .iter()
            .flatten()
            .map(|slot| slot.id.owned_heap_bytes())
            .sum();
        let slot_storage_bytes = inner.slots.capacity() * size_of::<Option<Slot>>();
        AccountingSnapshot {
            active_registrations: active,
            slot_capacity: inner.limits.active,
            control_reserve: inner.limits.control_reserve,
            ordinary_available: ordinary_cap.saturating_sub(ordinary_used).min(free),
            control_available: free,
            request_id_heap_bytes,
            slot_storage_bytes,
            shared_state_heap_bytes: size_of::<Inner>()
                + slot_storage_bytes
                + request_id_heap_bytes,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Inner {
    fn find(&self, id: &RequestId) -> Option<usize> {
        self.slots
            .iter()
            .position(|slot| slot.as_ref().is_some_and(|occupied| occupied.id == *id))
    }

    fn active_count(&self) -> usize {
        self.slots.iter().filter(|slot| slot.is_some()).count()
    }
}

impl ActiveRequest {
    pub fn id(&self) -> &RequestId {
        &self.id
    }

    pub fn cancellation_requested(&self) -> bool {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner
            .slots
            .get(self.index)
            .and_then(Option::as_ref)
            .is_some_and(|slot| slot.generation == self.generation && slot.cancel)
    }

    /// Record that this request's terminal response was actually sent.
    ///
    /// Only the original initializing registration may advance or retry the
    /// handshake. `InitializeSuccess` advances; `InitializeError` retries;
    /// `ProtocolComplete` on that original lease is an invalid outcome and
    /// closes the helper. A late send after [`ProtocolSession::close`] cannot
    /// reopen Closed. Domain completion is not represented.
    pub fn response_sent(mut self, outcome: ResponseOutcome) {
        self.release(Some(outcome));
    }

    fn release(&mut self, outcome: Option<ResponseOutcome>) {
        if !self.armed {
            return;
        }
        self.armed = false;
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(slot) = inner.slots.get_mut(self.index) else {
            return;
        };
        let Some(occupied) = slot else {
            return;
        };
        if occupied.generation != self.generation {
            return;
        }
        let handshake_owner = occupied.handshake_owner;
        *slot = None;
        if handshake_owner && inner.phase == Phase::Initializing {
            inner.phase = match outcome {
                Some(ResponseOutcome::InitializeError) => Phase::Uninitialized,
                Some(ResponseOutcome::InitializeSuccess) => Phase::AwaitingInitialized,
                Some(ResponseOutcome::ProtocolComplete) | None => Phase::Closed,
            };
        }
    }
}

impl Drop for ActiveRequest {
    fn drop(&mut self) {
        self.release(None);
    }
}

#[cfg(test)]
mod leak_tests {
    use super::*;
    use crate::RequestId;

    fn parse(raw: &[u8]) -> RequestId {
        RequestId::parse_json_token(raw).expect("token")
    }

    fn session() -> ProtocolSession {
        ProtocolSession::new(Limits::suggested()).expect("limits")
    }

    fn ready_session() -> ProtocolSession {
        let session = session();
        let (init, _) = session
            .admit(parse(b"1"), RequestClass::Initialize)
            .unwrap();
        init.response_sent(ResponseOutcome::InitializeSuccess);
        session.initialized_notification();
        session
    }

    fn strong(session: &ProtocolSession) -> usize {
        Arc::strong_count(&session.inner)
    }

    #[test]
    fn sent_ping_does_not_retain_shared_state_arc() {
        let session = session();
        let weak = Arc::downgrade(&session.inner);
        let baseline = strong(&session);
        let (lease, _) = session.admit(parse(b"10"), RequestClass::Ping).unwrap();
        assert_eq!(strong(&session), baseline + 1);
        lease.response_sent(ResponseOutcome::ProtocolComplete);
        assert_eq!(strong(&session), baseline);
        assert_eq!(session.active_count(), 0);
        drop(session);
        assert_eq!(weak.strong_count(), 0);
        assert!(weak.upgrade().is_none());
    }

    #[test]
    fn sent_initialize_success_does_not_retain_shared_state_arc() {
        let session = session();
        let weak = Arc::downgrade(&session.inner);
        let baseline = strong(&session);
        let (lease, _) = session
            .admit(parse(b"\"init-ok\""), RequestClass::Initialize)
            .unwrap();
        assert_eq!(strong(&session), baseline + 1);
        lease.response_sent(ResponseOutcome::InitializeSuccess);
        assert_eq!(strong(&session), baseline);
        assert_eq!(session.active_count(), 0);
        drop(session);
        assert_eq!(weak.strong_count(), 0);
        assert!(weak.upgrade().is_none());
    }

    #[test]
    fn sent_ordinary_and_phase_error_do_not_retain_shared_state_arc() {
        let ready = ready_session();
        let baseline = strong(&ready);
        let (ordinary, _) = ready
            .admit(parse(b"\"ordinary\""), RequestClass::ReadyOnly)
            .unwrap();
        ordinary.response_sent(ResponseOutcome::ProtocolComplete);
        assert_eq!(strong(&ready), baseline);

        let uninitialized = session();
        let baseline = strong(&uninitialized);
        let (phase_error, disposition) = uninitialized
            .admit(parse(b"\"phase\""), RequestClass::ReadyOnly)
            .unwrap();
        assert_eq!(disposition, Disposition::CorrelatedPhaseError);
        phase_error.response_sent(ResponseOutcome::ProtocolComplete);
        assert_eq!(strong(&uninitialized), baseline);
        assert_eq!(uninitialized.active_count(), 0);
    }

    #[test]
    fn repeated_string_sends_do_not_accumulate_shared_state_arcs() {
        let session = ready_session();
        let baseline = strong(&session);
        for n in 0..32 {
            let token = format!("\"s{n}\"");
            let (lease, _) = session
                .admit(parse(token.as_bytes()), RequestClass::ReadyOnly)
                .unwrap();
            assert_eq!(strong(&session), baseline + 1);
            lease.response_sent(ResponseOutcome::ProtocolComplete);
            assert_eq!(strong(&session), baseline);
            assert_eq!(session.active_count(), 0);
        }
        assert_eq!(strong(&session), baseline);
    }

    #[test]
    fn sibling_lease_retains_only_its_own_strong_owner() {
        let session = ready_session();
        let baseline = strong(&session);
        let (a, _) = session
            .admit(parse(b"\"a\""), RequestClass::ReadyOnly)
            .unwrap();
        let (b, _) = session
            .admit(parse(b"\"b\""), RequestClass::ReadyOnly)
            .unwrap();
        assert_eq!(strong(&session), baseline + 2);
        a.response_sent(ResponseOutcome::ProtocolComplete);
        assert_eq!(strong(&session), baseline + 1);
        assert_eq!(session.active_count(), 1);
        b.response_sent(ResponseOutcome::ProtocolComplete);
        assert_eq!(strong(&session), baseline);
        assert_eq!(session.active_count(), 0);
    }

    #[test]
    fn handle_drop_before_send_then_send_drops_last_owner() {
        let session = session();
        let (lease, _) = session
            .admit(parse(b"\"held\""), RequestClass::Initialize)
            .unwrap();
        let weak = Arc::downgrade(&session.inner);
        assert_eq!(weak.strong_count(), 2);
        drop(session);
        assert_eq!(weak.strong_count(), 1);
        assert!(weak.upgrade().is_some());
        lease.response_sent(ResponseOutcome::InitializeSuccess);
        assert_eq!(weak.strong_count(), 0);
        assert!(weak.upgrade().is_none());
    }

    #[test]
    fn close_then_send_drops_lease_owner() {
        let session = session();
        let weak = Arc::downgrade(&session.inner);
        let baseline = strong(&session);
        let (lease, _) = session.admit(parse(b"20"), RequestClass::Ping).unwrap();
        session.close();
        lease.response_sent(ResponseOutcome::ProtocolComplete);
        assert_eq!(strong(&session), baseline);
        drop(session);
        assert_eq!(weak.strong_count(), 0);
        assert!(weak.upgrade().is_none());
    }

    #[test]
    fn unsent_drop_releases_shared_state_owner() {
        let session = session();
        let weak = Arc::downgrade(&session.inner);
        let baseline = strong(&session);
        let (lease, _) = session
            .admit(parse(b"\"unsent\""), RequestClass::Initialize)
            .unwrap();
        assert_eq!(strong(&session), baseline + 1);
        drop(lease);
        assert_eq!(strong(&session), baseline);
        assert_eq!(session.active_count(), 0);
        drop(session);
        assert_eq!(weak.strong_count(), 0);
        assert!(weak.upgrade().is_none());
    }

    #[test]
    fn weak_unupgradeable_after_all_legitimate_owners_end() {
        let session = session();
        let keep = session.clone();
        let weak = Arc::downgrade(&session.inner);
        let (lease, _) = session
            .admit(parse(b"\"last\""), RequestClass::Ping)
            .unwrap();
        drop(session);
        assert!(weak.upgrade().is_some());
        lease.response_sent(ResponseOutcome::ProtocolComplete);
        assert_eq!(weak.strong_count(), 1);
        drop(keep);
        assert_eq!(weak.strong_count(), 0);
        assert!(weak.upgrade().is_none());
    }
}
