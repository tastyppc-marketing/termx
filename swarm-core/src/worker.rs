//! Dedicated SQLite ownership with immediate, bounded admission.
//!
//! `submit` never waits for SQLite or queue space. Admission rejection means no
//! execution; a cancelled/dropped `Pending` after acceptance means outcome unknown.
//! Retry mutations with the original idempotency key. Replies never block the writer.
//! Request accounting conservatively estimates owned heap capacity (including BTree
//! nodes); response reservations remain charged until consumed or dropped. Once a
//! response is handed to its caller, retaining it is that caller's responsibility.
//! The single active operation additionally allocates canonical/page encode buffers
//! bounded by core frame limits. SQLite cache/query memory is separate and is not
//! part of the queue-memory accounting. These are resource controls, not quotas.
use crate::{
    error::StoreError,
    model::*,
    store::{Store, StoreInspection},
};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex, MutexGuard,
    },
    task::{Context, Poll},
    time::Instant,
};
use tokio::sync::oneshot;

/// Trusted internal commands. Deliberately no Deserialize or arbitrary SQL/closure.
#[derive(Debug)]
pub enum Command {
    TrustedOwner,
    Inspect,
    Recover(OwnerPrincipal),
    Enroll(OwnerPrincipal, VerifiedBinding),
    Authenticate(VerifiedBinding),
    UpdatePeer(OwnerPrincipal, PeerId, Revision, PeerMetadataUpdate),
    CreateGroup(OwnerPrincipal, String, BTreeSet<PeerId>),
    Membership(OwnerPrincipal, GroupId, PeerId, bool, Revision),
    Pause(OwnerPrincipal, GroupId, bool, Revision),
    Send(PeerPrincipal, SendMessageRequest),
    Mailbox(PeerPrincipal, MailboxPageRequest),
    Acknowledge(PeerPrincipal, GroupId, MessageId),
    Candidates(OwnerPrincipal, GroupId, PeerId, Revision, usize),
    Begin(OwnerPrincipal, DeliveryCandidate),
    Attempt(OwnerPrincipal, DeliveryAttemptId),
    Complete(OwnerPrincipal, DeliveryAttemptId, AttemptOutcome),
    Reconcile(OwnerPrincipal, VerifiedNotSubmitted),
    Continue(
        OwnerPrincipal,
        VerifiedContinuation,
        String,
        BTreeMap<GroupId, Revision>,
    ),
    #[cfg(test)]
    #[allow(private_interfaces)]
    TestHook(Box<dyn TestHook>),
}
#[derive(Debug)]
pub enum Response {
    Owner(OwnerPrincipal),
    Inspection(StoreInspection),
    Recovered(usize),
    Enrolled(EnrolledPeer),
    Principal(PeerPrincipal),
    Binding(PeerBindingRecord),
    Group(GroupRecord),
    Saved(SendReceipt),
    Mailbox(MailboxPage),
    Acknowledged(AcknowledgementResult),
    Candidates(Vec<DeliveryCandidate>),
    Ticket(DeliveryTicket),
    Attempt(AttemptStatus),
    Unit,
}
#[derive(Clone, Debug, serde::Serialize)]
pub struct WorkerConfig {
    /// Includes the operation currently executing. One slot is reserved for small
    /// commands when this is greater than one.
    pub max_requests: usize,
    pub max_request_bytes: usize,
    /// Outstanding replies, including completed values not yet consumed. Large
    /// responses leave one slot and 64 KiB available to small control operations.
    pub max_responses: usize,
    pub max_response_bytes: usize,
}
impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            max_requests: 64,
            max_request_bytes: 32 * 1024 * 1024,
            max_responses: 64,
            max_response_bytes: 64 * 1024 * 1024,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AdmissionError {
    #[error("worker admission is closed; request was not enqueued")]
    Closed,
    #[error("admission is contended; request was not enqueued")]
    Contended,
    #[error("request capacity exhausted; request was not enqueued")]
    Requests,
    #[error("request byte capacity exhausted; request was not enqueued")]
    RequestBytes,
    #[error("response capacity exhausted; request was not enqueued")]
    Responses,
    #[error("response byte capacity exhausted; request was not enqueued")]
    ResponseBytes,
}
#[derive(Debug, thiserror::Error)]
pub enum OperationError {
    /// The store returned this error. I/O errors are not a general guarantee of
    /// rollback; reconcile/retry using the original idempotency identity.
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("accepted operation outcome unknown because the worker exited")]
    OutcomeUnknown,
}
#[derive(Debug, thiserror::Error)]
pub enum WorkerError {
    #[error("worker resource limits must be positive")]
    InvalidConfig,
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Spawn(#[from] std::io::Error),
    #[error("worker panicked; accepted operations without replies have unknown outcomes")]
    Panicked,
}
/// Lightweight counters only: no integrity scan and no retained per-operation log.
#[derive(Default, Clone, Debug, serde::Serialize)]
pub struct Metrics {
    pub accepted: u64,
    pub completed: u64,
    pub store_errors: u64,
    pub abandoned_replies: u64,
    pub rejected: u64,
    pub admission_contended: u64,
    /// Accepted requests left without a result when the worker exited.
    pub outcome_unknown: u64,
    pub requests: usize,
    pub request_bytes: usize,
    pub responses: usize,
    pub response_reserved_bytes: usize,
    pub request_high_water: usize,
    pub request_bytes_high_water: usize,
    pub response_bytes_high_water: usize,
    pub max_response_reservation: usize,
    /// Largest delivered value's conservative heap-capacity estimate, distinct
    /// from its worst-case reservation and from serialized wire length.
    pub max_response_estimated_bytes: usize,
    /// End-to-end latency buckets: <=1,4,16,64,256,1024,4096ms, overflow.
    pub latency_buckets: [u64; 8],
    /// Same buckets partitioned by `OPERATION_NAMES`; fixed storage.
    pub operation_latency_buckets: [[u64; 8]; 18],
}
pub const OPERATION_NAMES: [&str; 18] = [
    "trusted_owner",
    "inspect",
    "recover",
    "enroll",
    "authenticate",
    "update_peer",
    "create_group",
    "membership",
    "pause",
    "send",
    "mailbox",
    "acknowledge",
    "candidates",
    "begin",
    "attempt",
    "complete",
    "reconcile",
    "continue",
];
struct State {
    queue: VecDeque<Envelope>,
    closed: bool,
    metrics: Metrics,
}
struct Shared {
    state: Mutex<State>,
    wake: Condvar,
    config: WorkerConfig,
    admission_contended: AtomicU64,
}
fn lock(shared: &Shared) -> MutexGuard<'_, State> {
    shared.state.lock().unwrap_or_else(|e| e.into_inner())
}
struct Envelope {
    command: Command,
    reply: oneshot::Sender<Reply>,
    request_bytes: usize,
    reservation: Reservation,
    started: Instant,
}
struct Reservation {
    shared: Arc<Shared>,
    bytes: usize,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        let mut state = lock(&self.shared);
        state.metrics.responses -= 1;
        state.metrics.response_reserved_bytes -= self.bytes;
    }
}
struct Reply {
    result: Result<Response, OperationError>,
    _reservation: Reservation,
}
/// Dropping this future never cancels an accepted operation. A timeout means the
/// caller must reconcile committed state; it must not assume rollback.
pub struct Pending {
    receiver: oneshot::Receiver<Reply>,
}
impl Future for Pending {
    type Output = Result<Response, OperationError>;
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match Pin::new(&mut self.receiver).poll(cx) {
            Poll::Ready(Ok(reply)) => Poll::Ready(reply.result),
            Poll::Ready(Err(_)) => Poll::Ready(Err(OperationError::OutcomeUnknown)),
            Poll::Pending => Poll::Pending,
        }
    }
}
#[derive(Clone)]
pub struct Client {
    shared: Arc<Shared>,
}
impl Client {
    /// Immediate admission; successful return is the exact enqueue boundary.
    /// The owned command is dropped on rejection; callers retain retry identity.
    pub fn submit(&self, command: Command) -> Result<Pending, AdmissionError> {
        let bytes = command.request_bytes();
        let response_bytes = command.response_bytes().max(bytes);
        let mut state = self.shared.state.try_lock().map_err(|_| {
            self.shared
                .admission_contended
                .fetch_add(1, Ordering::Relaxed);
            AdmissionError::Contended
        })?;
        let config = &self.shared.config;
        let large = bytes > 64 * 1024;
        let request_limit = config
            .max_requests
            .saturating_sub(usize::from(large && config.max_requests > 1));
        let byte_limit = config
            .max_request_bytes
            .saturating_sub(if large { 64 * 1024 } else { 0 });
        let large_response = response_bytes > 64 * 1024;
        let response_limit = config
            .max_responses
            .saturating_sub(usize::from(large_response && config.max_responses > 1));
        let response_byte_limit =
            config
                .max_response_bytes
                .saturating_sub(if large_response { 64 * 1024 } else { 0 });
        let rejection = if state.closed {
            Some(AdmissionError::Closed)
        } else if state.metrics.requests >= request_limit {
            Some(AdmissionError::Requests)
        } else if bytes > byte_limit.saturating_sub(state.metrics.request_bytes) {
            Some(AdmissionError::RequestBytes)
        } else if state.metrics.responses >= response_limit {
            Some(AdmissionError::Responses)
        } else if response_bytes
            > response_byte_limit.saturating_sub(state.metrics.response_reserved_bytes)
        {
            Some(AdmissionError::ResponseBytes)
        } else {
            None
        };
        if let Some(error) = rejection {
            state.metrics.rejected += 1;
            return Err(error);
        }
        let (sender, receiver) = oneshot::channel();
        let m = &mut state.metrics;
        m.accepted += 1;
        m.requests += 1;
        m.request_bytes += bytes;
        m.responses += 1;
        m.response_reserved_bytes += response_bytes;
        m.request_high_water = m.request_high_water.max(m.requests);
        m.request_bytes_high_water = m.request_bytes_high_water.max(m.request_bytes);
        m.response_bytes_high_water = m.response_bytes_high_water.max(m.response_reserved_bytes);
        m.max_response_reservation = m.max_response_reservation.max(response_bytes);
        state.queue.push_back(Envelope {
            command,
            reply: sender,
            request_bytes: bytes,
            reservation: Reservation {
                shared: self.shared.clone(),
                bytes: response_bytes,
            },
            started: Instant::now(),
        });
        drop(state);
        self.shared.wake.notify_one();
        Ok(Pending { receiver })
    }
    pub fn metrics(&self) -> Metrics {
        let mut metrics = lock(&self.shared).metrics.clone();
        metrics.admission_contended = self.shared.admission_contended.load(Ordering::Relaxed);
        metrics
    }
    /// Closes admission independently of queue capacity. Accepted work drains.
    pub fn close(&self) {
        lock(&self.shared).closed = true;
        self.shared.wake.notify_one();
    }
}
/// Opening and migrations occur on the owned thread. Open is passive: explicit
/// `Command::Recover` with trusted ownership assertion is required for dispatch.
pub struct Worker {
    client: Client,
    exited: Option<oneshot::Receiver<Result<(), WorkerError>>>,
}
impl Worker {
    pub async fn open(path: PathBuf, config: WorkerConfig) -> Result<Self, WorkerError> {
        if config.max_requests == 0
            || config.max_request_bytes == 0
            || config.max_responses == 0
            || config.max_response_bytes == 0
        {
            return Err(WorkerError::InvalidConfig);
        }
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                queue: VecDeque::new(),
                closed: false,
                metrics: Metrics::default(),
            }),
            wake: Condvar::new(),
            config,
            admission_contended: AtomicU64::new(0),
        });
        let client = Client {
            shared: shared.clone(),
        };
        let (ready_tx, ready_rx) = oneshot::channel();
        let (exit_tx, exit_rx) = oneshot::channel();
        let thread_shared = shared.clone();
        let thread = std::thread::Builder::new()
            .name("swarm-sqlite".into())
            .spawn(move || {
                let mut store = match Store::open(path) {
                    Ok(store) => store,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                if ready_tx.send(Ok(())).is_err() {
                    return;
                }
                run(&thread_shared, &mut store);
            })?;
        // Joining is blocking, so a separate native reaper provides an awaitable
        // notification that proves actual exit (including SQLite connection drop).
        let reaper = std::thread::Builder::new()
            .name("swarm-sqlite-join".into())
            .spawn(move || {
                let result = thread.join().map_err(|_| WorkerError::Panicked);
                let queued = {
                    let mut state = lock(&shared);
                    state.closed = true;
                    state.metrics.outcome_unknown =
                        state.metrics.accepted - state.metrics.completed;
                    state.metrics.requests = 0;
                    state.metrics.request_bytes = 0;
                    std::mem::take(&mut state.queue)
                };
                drop(queued);
                let _ = exit_tx.send(result);
            });
        // Even cancelled open futures close admission; no detached waiting worker.
        let worker = Self {
            client,
            exited: Some(exit_rx),
        };
        reaper?;
        match ready_rx.await {
            Ok(Ok(())) => Ok(worker),
            Ok(Err(error)) => {
                worker.shutdown().await?;
                Err(error.into())
            }
            Err(_) => {
                worker.shutdown().await?;
                Err(WorkerError::Panicked)
            }
        }
    }
    pub fn client(&self) -> Client {
        self.client.clone()
    }
    pub async fn shutdown(mut self) -> Result<(), WorkerError> {
        self.client.close();
        self.exited
            .take()
            .expect("single shutdown")
            .await
            .unwrap_or(Err(WorkerError::Panicked))
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.client.close();
    }
}
fn run(shared: &Arc<Shared>, store: &mut Store) {
    loop {
        let envelope = {
            let mut state = lock(shared);
            loop {
                if let Some(envelope) = state.queue.pop_front() {
                    break Some(envelope);
                }
                if state.closed {
                    break None;
                }
                state = shared.wake.wait(state).unwrap_or_else(|e| e.into_inner());
            }
        };
        let Some(envelope) = envelope else { return };
        let operation = envelope.command.operation_index();
        let result = envelope
            .command
            .execute(store)
            .map_err(OperationError::Store);
        let response_bytes = result
            .as_ref()
            .map_or(0, Response::estimated_retained_bytes);
        debug_assert!(
            response_bytes <= envelope.reservation.bytes,
            "response reservation must cover owned capacity"
        );
        {
            let mut state = lock(shared);
            let m = &mut state.metrics;
            m.completed += 1;
            m.requests -= 1;
            m.request_bytes -= envelope.request_bytes;
            m.store_errors += u64::from(result.is_err());
            m.max_response_estimated_bytes = m.max_response_estimated_bytes.max(response_bytes);
            let millis = envelope.started.elapsed().as_millis();
            let bucket = [1, 4, 16, 64, 256, 1024, 4096]
                .iter()
                .position(|bound| millis <= *bound)
                .unwrap_or(7);
            m.latency_buckets[bucket] += 1;
            if let Some(operation) = operation {
                m.operation_latency_buckets[operation][bucket] += 1;
            }
        }
        if envelope
            .reply
            .send(Reply {
                result,
                _reservation: envelope.reservation,
            })
            .is_err()
        {
            lock(shared).metrics.abandoned_replies += 1;
        }
    }
}
impl Response {
    /// Conservative heap-capacity estimate; no serialization or integrity scan.
    /// The caller owns this memory once its pending result has been consumed.
    pub fn estimated_retained_bytes(&self) -> usize {
        let extra = match self {
            Self::Enrolled(peer) => record_bytes(&peer.record),
            Self::Binding(record) => record_bytes(record),
            Self::Group(group) => group.label.capacity(),
            Self::Saved(receipt) => receipt.recipients.capacity().saturating_mul(256),
            Self::Mailbox(page) => page.messages.iter().fold(
                page.messages.capacity().saturating_mul(4096),
                |size, entry| {
                    size.saturating_add(entry.message.body.capacity())
                        .saturating_add(entry.message.client_key.capacity())
                        .saturating_add(option_capacity(&entry.message.topic))
                },
            ),
            Self::Candidates(candidates) => candidates.capacity().saturating_mul(512),
            Self::Ticket(ticket) => record_bytes(ticket.recipient_binding()),
            Self::Inspection(i) => {
                i.sqlite_version.capacity() + i.journal_mode.capacity() + i.synchronous.capacity()
            }
            _ => 0,
        };
        4096usize.saturating_add(extra)
    }
}
fn record_bytes(record: &PeerBindingRecord) -> usize {
    record
        .terminal_id
        .capacity()
        .saturating_add(record.conversation_id.capacity())
        .saturating_add(record.harness.capacity())
        .saturating_add(option_capacity(&record.model_metadata))
}
impl Command {
    fn operation_index(&self) -> Option<usize> {
        Some(match self {
            Self::TrustedOwner => 0,
            Self::Inspect => 1,
            Self::Recover(..) => 2,
            Self::Enroll(..) => 3,
            Self::Authenticate(..) => 4,
            Self::UpdatePeer(..) => 5,
            Self::CreateGroup(..) => 6,
            Self::Membership(..) => 7,
            Self::Pause(..) => 8,
            Self::Send(..) => 9,
            Self::Mailbox(..) => 10,
            Self::Acknowledge(..) => 11,
            Self::Candidates(..) => 12,
            Self::Begin(..) => 13,
            Self::Attempt(..) => 14,
            Self::Complete(..) => 15,
            Self::Reconcile(..) => 16,
            Self::Continue(..) => 17,
            #[cfg(test)]
            Self::TestHook(..) => return None,
        })
    }
    fn execute(self, store: &mut Store) -> Result<Response, StoreError> {
        Ok(match self {
            Self::TrustedOwner => Response::Owner(store.trusted_owner()),
            Self::Inspect => Response::Inspection(store.inspect()?),
            Self::Recover(o) => Response::Recovered(store.recover_trusted_new_run(&o)?),
            Self::Enroll(o, b) => Response::Enrolled(store.enroll_peer(&o, b)?),
            Self::Authenticate(b) => Response::Principal(store.authenticate_peer(&b)?),
            Self::UpdatePeer(o, p, r, u) => {
                Response::Binding(store.update_peer_metadata(&o, &p, r, u)?)
            }
            Self::CreateGroup(o, l, m) => Response::Group(store.create_group(&o, &l, m)?),
            Self::Membership(o, g, p, a, r) => {
                Response::Group(store.set_membership(&o, &g, &p, a, r)?)
            }
            Self::Pause(o, g, p, r) => Response::Group(store.set_group_paused(&o, &g, p, r)?),
            Self::Send(p, r) => Response::Saved(store.send_message(&p, r)?),
            Self::Mailbox(p, r) => Response::Mailbox(store.read_mailbox(&p, r)?),
            Self::Acknowledge(p, g, m) => {
                Response::Acknowledged(store.acknowledge_message(&p, &g, &m)?)
            }
            Self::Candidates(o, g, p, r, l) => {
                Response::Candidates(store.delivery_candidates(&o, &g, &p, r, l)?)
            }
            Self::Begin(o, c) => Response::Ticket(store.begin_delivery(&o, &c)?),
            Self::Attempt(o, a) => Response::Attempt(store.delivery_attempt(&o, &a)?),
            Self::Complete(o, a, r) => Response::Attempt(store.complete_delivery(&o, &a, r)?),
            Self::Reconcile(o, e) => {
                store.reconcile_not_submitted(&o, e)?;
                Response::Unit
            }
            Self::Continue(o, e, i, p) => Response::Enrolled(store.continue_peer(&o, e, &i, p)?),
            #[cfg(test)]
            Self::TestHook(hook) => {
                hook.run(store);
                Response::Unit
            }
        })
    }
    fn request_bytes(&self) -> usize {
        // 4 KiB covers enum/channel/fixed IDs/principals and small allocator
        // overhead. Strings use capacity, not length. 256 bytes per BTree entry
        // covers node slack, links, ID strings and values conservatively.
        let extra = match self {
            Self::Send(_, r) => r
                .body
                .capacity()
                .saturating_add(r.client_key.capacity())
                .saturating_add(option_capacity(&r.topic))
                .saturating_add(r.recipients.len().saturating_mul(256)),
            Self::CreateGroup(_, label, members) => label
                .capacity()
                .saturating_add(members.len().saturating_mul(256)),
            Self::Enroll(_, b) | Self::Authenticate(b) => binding_bytes(b),
            Self::UpdatePeer(_, _, _, u) => option_capacity(&u.model_metadata),
            Self::Continue(_, e, intent, policies) => binding_bytes(&e.successor)
                .saturating_add(e.predecessor.terminal_id.capacity())
                .saturating_add(e.predecessor.conversation_id.capacity())
                .saturating_add(e.predecessor.harness.capacity())
                .saturating_add(option_capacity(&e.predecessor.model_metadata))
                .saturating_add(e.branch_evidence.capacity())
                .saturating_add(intent.capacity())
                .saturating_add(policies.len().saturating_mul(256)),
            Self::Reconcile(_, e) => e.evidence_reference.capacity(),
            _ => 0,
        };
        4096usize.saturating_add(extra)
    }
    fn response_bytes(&self) -> usize {
        match self {
            Self::Mailbox(..) => 32 * 1024 * 1024,
            Self::Send(..) => 2 * 1024 * 1024,
            Self::Candidates(..) => 128 * 1024,
            _ => 64 * 1024,
        }
    }
}
fn option_capacity(value: &Option<String>) -> usize {
    value.as_ref().map_or(0, String::capacity)
}
fn binding_bytes(b: &VerifiedBinding) -> usize {
    b.terminal_id
        .capacity()
        .saturating_add(b.harness.capacity())
        .saturating_add(b.conversation_id.capacity())
        .saturating_add(option_capacity(&b.model_metadata))
}
#[cfg(test)]
trait TestHook: std::fmt::Debug + Send {
    fn run(self: Box<Self>, store: &mut Store);
}
#[cfg(test)]
mod tests;
