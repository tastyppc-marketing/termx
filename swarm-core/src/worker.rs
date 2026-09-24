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
    NoticeGaps(OwnerPrincipal, Option<NoticeGapCursor>, usize),
    BeginNotice(OwnerPrincipal, NoticeCandidate),
    NoticeAttempt(OwnerPrincipal, NoticeAttemptId),
    CompleteNotice(OwnerPrincipal, NoticeAttemptId, AttemptOutcome),
    ReconcileNotice(OwnerPrincipal, VerifiedNoticeNotSubmitted),
    RecordNoticeReceipt(OwnerPrincipal, VerifiedNoticeReceipt),
    Continue(
        OwnerPrincipal,
        VerifiedContinuation,
        String,
        BTreeMap<GroupId, Revision>,
    ),
    // Task 2 companion integration.
    WhoAmI(PeerPrincipal, WhoAmIRequest),
    ListPeers(PeerPrincipal, ListPeersRequest),
    PublishStatus(PeerPrincipal, StatusRequest),
    ReadMailboxAfter(PeerPrincipal, MailboxAfterRequest),
    ReadThread(PeerPrincipal, ThreadPageRequest),
    ReadOutgoing(PeerPrincipal, OutgoingPageRequest),
    ResolveAttachment(PeerPrincipal, GroupId, SourceReferenceId),
    RegisterSource(OwnerPrincipal, VerifiedSourceDescriptor),
    TransitionSource(OwnerPrincipal, SourceTransition),
    AcquireContextGrant(PeerPrincipal, GroupId, SourceId),
    ValidateContextGrant(PeerPrincipal, PreparedPublication),
    OwnerSnapshot(OwnerPrincipal, OwnerSnapshotRequest),
    StateRevisions(OwnerPrincipal),
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
    NoticeCandidates(NoticeCandidatePage),
    NoticeTicket(NoticeTicket),
    NoticeAttempt(NoticeAttemptStatus),
    SelfView(SelfView),
    Peers(PeerPage),
    Status(StatusRecord),
    Thread(ThreadPage),
    Outgoing(OutgoingPage),
    Attachment(AttachmentView),
    Source(SourceRegistration),
    Lease(ContextGrantLease),
    CommittedPublication(CommittedPublication),
    Snapshot(OwnerSnapshotPage),
    Revisions(StateRevisions),
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
#[derive(Clone, Debug)]
pub struct OperationLatencyBuckets([[u64; 8]; 37]);
impl Default for OperationLatencyBuckets {
    fn default() -> Self {
        Self([[0; 8]; 37])
    }
}
impl std::ops::Index<usize> for OperationLatencyBuckets {
    type Output = [u64; 8];
    fn index(&self, index: usize) -> &Self::Output {
        &self.0[index]
    }
}
impl std::ops::IndexMut<usize> for OperationLatencyBuckets {
    fn index_mut(&mut self, index: usize) -> &mut Self::Output {
        &mut self.0[index]
    }
}
impl serde::Serialize for OperationLatencyBuckets {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serde::Serialize::serialize(self.0.as_slice(), serializer)
    }
}

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
    /// Notice submissions fenced as uncertain by explicit trusted recovery.
    pub notice_attempts_recovered_uncertain: u64,
    /// End-to-end latency buckets: <=1,4,16,64,256,1024,4096ms, overflow.
    pub latency_buckets: [u64; 8],
    /// Same buckets partitioned by `OPERATION_NAMES`; fixed storage.
    pub operation_latency_buckets: OperationLatencyBuckets,
}
pub const OPERATION_NAMES: [&str; 37] = [
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
    "whoami",
    "list_peers",
    "publish_status",
    "mailbox_after",
    "thread",
    "outgoing",
    "resolve_attachment",
    "register_source",
    "transition_source",
    "acquire_context_grant",
    "validate_context_grant",
    "owner_snapshot",
    "state_revisions",
    "notice_gaps",
    "begin_notice",
    "notice_attempt",
    "complete_notice",
    "reconcile_notice",
    "record_notice_receipt",
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
        Self::open_with_lifetime(path, config, Arc::new(())).await
    }

    /// Retains an external lifetime until the SQLite store has been dropped
    /// and its native join reaper has finished cleaning up queued work.
    ///
    /// Dropping this worker, or cancelling open/shutdown, closes admission but
    /// does not release the lifetime while native work can still run. Client
    /// clones and replies already handed to callers do not retain the lifetime.
    /// As with `open`, dropping an accepted reply does not roll back its work.
    pub async fn open_with_lifetime<T: Send + Sync + 'static>(
        path: PathBuf,
        config: WorkerConfig,
        lifetime: Arc<T>,
    ) -> Result<Self, WorkerError> {
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
        let thread_lifetime = Arc::clone(&lifetime);
        let thread = std::thread::Builder::new()
            .name("swarm-sqlite".into())
            .spawn(move || {
                // Declaration order matters: the Store (and its connection)
                // must drop before this guard on return or unwind.
                let _lifetime = thread_lifetime;
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
                // Independent of Worker/open/shutdown future ownership, and
                // retained through the join and queued-response cleanup below.
                let lifetime = lifetime;
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
                // Release the lifetime BEFORE proving exit. A caller resuming
                // from shutdown() re-claims the authority at once; if this
                // copy were still alive, that claim would see the lock file
                // held and fail with Busy (seen on a loaded CI runner).
                drop(lifetime);
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
        let is_recover = matches!(&envelope.command, Command::Recover(..));
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
            if is_recover && result.is_ok() {
                m.notice_attempts_recovered_uncertain = m
                    .notice_attempts_recovered_uncertain
                    .saturating_add(store.last_notice_recovered() as u64);
            }
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
                |size, entry| size.saturating_add(message_bytes(&entry.message)),
            ),
            Self::Candidates(candidates) => candidates.capacity().saturating_mul(512),
            Self::Ticket(ticket) => record_bytes(ticket.recipient_binding()),
            Self::NoticeCandidates(page) => page.estimated_retained_bytes(),
            Self::NoticeTicket(ticket) => ticket
                .candidate
                .estimated_retained_bytes()
                .saturating_add(record_bytes(ticket.recipient_binding())),
            Self::NoticeAttempt(status) => status.receipt().map_or(0, |receipt| {
                receipt
                    .native_record_kind
                    .capacity()
                    .saturating_add(receipt.provenance_reference.capacity())
                    .saturating_add(receipt.enrolled_source_identity.capacity())
                    .saturating_add(receipt.enrolled_generation.capacity())
                    .saturating_add(receipt.native_item_identity.capacity())
            }),
            Self::Thread(page) => page.messages.iter().fold(
                page.messages.capacity().saturating_mul(4096),
                |size, entry| size.saturating_add(message_bytes(&entry.message)),
            ),
            Self::Outgoing(page) => state_entries_bytes(&page.messages),
            Self::SelfView(view) => view.memberships.iter().fold(
                view.memberships
                    .capacity()
                    .saturating_mul(1024)
                    .saturating_add(view.harness.capacity())
                    .saturating_add(option_capacity(&view.model_metadata)),
                |size, membership| {
                    size.saturating_add(membership.label.capacity())
                        .saturating_add(status_bytes(&membership.status))
                },
            ),
            Self::Peers(page) => {
                page.peers
                    .iter()
                    .fold(page.peers.capacity().saturating_mul(1024), |size, peer| {
                        size.saturating_add(peer.harness.capacity())
                            .saturating_add(option_capacity(&peer.model_metadata))
                            .saturating_add(status_bytes(&peer.status))
                            .saturating_add(peer.sources.capacity().saturating_mul(512))
                    })
            }
            Self::Status(status) => option_capacity(&status.status),
            Self::Attachment(view) => option_capacity(&view.attachment.snapshot_reference)
                .saturating_add(view.attachment.source_kind.capacity()),
            Self::Source(registration) => registration_bytes(registration),
            Self::Lease(lease) => lease.estimated_bytes(),
            Self::CommittedPublication(committed) => committed.estimated_bytes(),
            Self::Snapshot(OwnerSnapshotPage::Peers(page)) => page
                .peers
                .iter()
                .fold(page.peers.capacity().saturating_mul(2048), |size, peer| {
                    size.saturating_add(record_bytes(&peer.binding))
                }),
            Self::Snapshot(OwnerSnapshotPage::Groups(page)) => page.groups.iter().fold(
                page.groups.capacity().saturating_mul(1024),
                |size, group| size.saturating_add(group.group.label.capacity()),
            ),
            Self::Snapshot(OwnerSnapshotPage::PeerMemberships(page)) => {
                page.memberships.iter().fold(
                    page.memberships.capacity().saturating_mul(512),
                    |size, m| size.saturating_add(status_bytes(&m.status)),
                )
            }
            Self::Snapshot(OwnerSnapshotPage::PeerSources(page)) => page
                .sources
                .iter()
                .fold(page.sources.capacity().saturating_mul(1024), |size, s| {
                    size.saturating_add(registration_bytes(s))
                }),
            Self::Snapshot(OwnerSnapshotPage::GroupMembers(page)) => {
                page.members.capacity().saturating_mul(64)
            }
            Self::Snapshot(OwnerSnapshotPage::Messages(page)) => {
                state_entries_bytes(&page.messages)
            }
            Self::Inspection(i) => {
                i.sqlite_version.capacity() + i.journal_mode.capacity() + i.synchronous.capacity()
            }
            _ => 0,
        };
        4096usize.saturating_add(extra)
    }
}
fn message_bytes(message: &MessageRecord) -> usize {
    message
        .body
        .capacity()
        .saturating_add(message.client_key.capacity())
        .saturating_add(option_capacity(&message.topic))
        .saturating_add(message.attachments.iter().fold(
            message.attachments.capacity().saturating_mul(256),
            |size, attachment| {
                size.saturating_add(attachment.source_kind.capacity())
                    .saturating_add(option_capacity(&attachment.snapshot_reference))
            },
        ))
}
fn state_entries_bytes(entries: &[MessageStateEntry]) -> usize {
    entries
        .iter()
        .fold(entries.len().saturating_mul(4096), |size, entry| {
            size.saturating_add(message_bytes(&entry.message))
                .saturating_add(entry.recipients.capacity().saturating_mul(256))
        })
}
fn registration_bytes(registration: &SourceRegistration) -> usize {
    registration
        .conversation_id
        .capacity()
        .saturating_add(registration.source_kind.capacity())
        .saturating_add(registration.object_identity.capacity())
        .saturating_add(registration.evidence_reference.capacity())
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
            Self::WhoAmI(..) => 18,
            Self::ListPeers(..) => 19,
            Self::PublishStatus(..) => 20,
            Self::ReadMailboxAfter(..) => 21,
            Self::ReadThread(..) => 22,
            Self::ReadOutgoing(..) => 23,
            Self::ResolveAttachment(..) => 24,
            Self::RegisterSource(..) => 25,
            Self::TransitionSource(..) => 26,
            Self::AcquireContextGrant(..) => 27,
            Self::ValidateContextGrant(..) => 28,
            Self::OwnerSnapshot(..) => 29,
            Self::StateRevisions(..) => 30,
            Self::NoticeGaps(..) => 31,
            Self::BeginNotice(..) => 32,
            Self::NoticeAttempt(..) => 33,
            Self::CompleteNotice(..) => 34,
            Self::ReconcileNotice(..) => 35,
            Self::RecordNoticeReceipt(..) => 36,
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
            Self::NoticeGaps(owner, cursor, limit) => {
                Response::NoticeCandidates(store.notice_gaps(&owner, cursor.as_ref(), limit)?)
            }
            Self::BeginNotice(owner, candidate) => {
                Response::NoticeTicket(store.begin_notice(&owner, &candidate)?)
            }
            Self::NoticeAttempt(owner, attempt) => {
                Response::NoticeAttempt(store.notice_attempt(&owner, &attempt)?)
            }
            Self::CompleteNotice(owner, attempt, outcome) => {
                Response::NoticeAttempt(store.complete_notice(&owner, &attempt, outcome)?)
            }
            Self::ReconcileNotice(owner, evidence) => {
                store.reconcile_notice_not_submitted(&owner, evidence)?;
                Response::Unit
            }
            Self::RecordNoticeReceipt(owner, evidence) => {
                Response::NoticeAttempt(store.record_notice_receipt(&owner, evidence)?)
            }
            Self::Continue(o, e, i, p) => Response::Enrolled(store.continue_peer(&o, e, &i, p)?),
            Self::WhoAmI(p, r) => Response::SelfView(store.whoami(&p, r)?),
            Self::ListPeers(p, r) => Response::Peers(store.list_peers(&p, r)?),
            Self::PublishStatus(p, r) => Response::Status(store.publish_status(&p, r)?),
            Self::ReadMailboxAfter(p, r) => Response::Mailbox(store.read_mailbox_after(&p, r)?),
            Self::ReadThread(p, r) => Response::Thread(store.read_thread(&p, r)?),
            Self::ReadOutgoing(p, r) => Response::Outgoing(store.read_outgoing(&p, r)?),
            Self::ResolveAttachment(p, g, s) => {
                Response::Attachment(store.resolve_attachment(&p, &g, &s)?)
            }
            Self::RegisterSource(o, d) => Response::Source(store.register_source(&o, d)?),
            Self::TransitionSource(o, t) => Response::Source(store.transition_source(&o, t)?),
            Self::AcquireContextGrant(p, g, s) => {
                Response::Lease(store.acquire_context_grant(&p, &g, &s)?)
            }
            Self::ValidateContextGrant(p, prepared) => {
                Response::CommittedPublication(store.validate_context_grant(&p, prepared)?)
            }
            Self::OwnerSnapshot(o, r) => Response::Snapshot(store.owner_snapshot(&o, r)?),
            Self::StateRevisions(o) => Response::Revisions(store.state_revisions(&o)?),
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
                .saturating_add(r.recipients.len().saturating_mul(256))
                .saturating_add(
                    r.attachments
                        .iter()
                        .fold(r.attachments.capacity().saturating_mul(128), |size, a| {
                            size.saturating_add(option_capacity(&a.snapshot_reference))
                        }),
                ),
            Self::PublishStatus(_, r) => option_capacity(&r.status),
            Self::RegisterSource(_, d) => d.estimated_bytes(),
            Self::TransitionSource(
                _,
                SourceTransition::Reestablish { descriptor, .. }
                | SourceTransition::Replace { descriptor, .. },
            ) => descriptor.estimated_bytes(),
            // The real body and the destination guard's cached metadata travel
            // with the command and are retained by the committed response;
            // charge them in both accounting domains.
            Self::ValidateContextGrant(_, prepared) => prepared.estimated_bytes(),
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
            Self::NoticeGaps(_, cursor, _) => cursor.as_ref().map_or(0, |cursor| {
                cursor
                    .after_peer
                    .as_str()
                    .len()
                    .saturating_add(cursor.after_group.as_str().len())
                    .saturating_add(128)
            }),
            Self::BeginNotice(_, candidate) => candidate.estimated_retained_bytes(),
            Self::ReconcileNotice(_, evidence) => evidence.evidence_reference.capacity(),
            Self::RecordNoticeReceipt(_, evidence) => record_bytes(&evidence.recipient_binding)
                .saturating_add(evidence.native_record_kind.capacity())
                .saturating_add(evidence.provenance_reference.capacity())
                .saturating_add(evidence.enrolled_source_identity.capacity())
                .saturating_add(evidence.enrolled_generation.capacity())
                .saturating_add(evidence.native_item_identity.capacity()),
            _ => 0,
        };
        4096usize.saturating_add(extra)
    }
    fn response_bytes(&self) -> usize {
        match self {
            Self::Mailbox(..)
            | Self::ReadMailboxAfter(..)
            | Self::ReadThread(..)
            | Self::ReadOutgoing(..)
            | Self::OwnerSnapshot(_, OwnerSnapshotRequest::Messages { .. }) => 32 * 1024 * 1024,
            Self::WhoAmI(..) | Self::ListPeers(..) | Self::OwnerSnapshot(..) => 8 * 1024 * 1024,
            Self::Send(..) => 2 * 1024 * 1024,
            Self::Candidates(..) => 128 * 1024,
            Self::ValidateContextGrant(_, prepared) => {
                prepared.estimated_bytes().saturating_add(64 * 1024)
            }
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
