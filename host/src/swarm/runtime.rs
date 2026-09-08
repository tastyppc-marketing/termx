//! The broker runtime: one native authority claim, one SQLite worker, the
//! current boot generation, refreshed persisted bindings, two first-instance
//! pipe endpoints sharing one frame budget, fixed-policy accept loops,
//! discovery version 2 publication, and the dispatch gate.
//!
//! Startup order (each step's failure releases only this runtime's own
//! endpoints, tasks and worker, and preserves any predecessor discovery):
//! claim -> store/worker open -> trusted owner -> trusted new-run recovery
//! -> exact-process refresh of persisted live bindings -> bind owner then
//! peer endpoint -> accept loops -> publish discovery -> open the gate.

use crate::swarm::events::{EventHub, DEFAULT_EVENT_CAPACITY};
use crate::swarm::output::{
    OutputBudget, DEFAULT_OUTPUT_BUDGET_BYTES, DEFAULT_OUTPUT_HEADROOM_BYTES,
};
use crate::swarm::rpc;
use crate::swarm::{lifetime, BrokerArgs, EXIT_START_FAILED};
use rand::RngCore;
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use termx_swarm_client::{
    AuthorityClaim, AuthorityError, DiscoveryRecord, FrameBudget, OwnerCredential, PipeServer,
    ProcessIdentity, VerifiedPipe, VerifiedProcess, WireError,
};
use termx_swarm_core::model::{
    ContextGrantLease, OwnerPrincipal, OwnerSnapshotPage, OwnerSnapshotRequest, PeerMetadataUpdate,
    PeerPrincipal, PublicationCommitment, VerifiedBinding, MAX_PUBLICATION_BYTES,
};
#[cfg(feature = "swarm-test-seams")]
use termx_swarm_core::model::{EnrolledPeer, SourceRegistration, VerifiedSourceDescriptor};
use termx_swarm_core::worker::{
    AdmissionError, Client, Command, OperationError, Pending, Response, Worker, WorkerConfig,
    WorkerError,
};
use tokio::sync::{watch, Semaphore};
use tokio::task::{JoinHandle, JoinSet};

pub const SWARM_DIRECTORY: &str = "swarm";
pub const STORE_FILE: &str = "state.sqlite";
pub const DEFAULT_FRAME_BUDGET_BYTES: usize = 64 * 1024 * 1024;
pub const DEFAULT_MAX_CONNECTIONS: usize = 64;
pub const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const REFRESH_PAGE_ITEMS: usize = 64;
const ADMISSION_TIMEOUT: Duration = Duration::from_secs(1);
const ACCEPT_FAILURE_BACKOFF: Duration = Duration::from_millis(50);
const SHUTDOWN_DRAIN: Duration = Duration::from_secs(3);
pub const DEFAULT_SOURCE_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Concurrent source operations, independently of pipe/request admission.
pub const MAX_CONCURRENT_SOURCE_READS: usize = 2;
/// Bounded wait for blocking-pool threads when `--swarm-broker` exits.
const BROKER_MODE_RUNTIME_SHUTDOWN: Duration = Duration::from_secs(5);

/// Trusted bounded source I/O under one lease. The production reader is
/// unavailable until the verified source adapter exists (Task 4); tests may
/// install a fixture reader through the library seam.
pub type SourceReadFuture<'a> =
    Pin<Box<dyn Future<Output = Result<SourceSnapshot, SourceReadError>> + Send + 'a>>;

/// An adapter must perform bounded work per poll. Dropping its future cancels
/// all owned work; it must not hide detached tasks or blocking-pool operations.
/// Native I/O adapters must retain their operation/credits through cancellation
/// acknowledgment. The caller separately owns the snapshot/output byte budget.
/// The adapter must not retain more than `MAX_PUBLICATION_BYTES` of body
/// allocation (including spare Vec capacity), plus bounded source metadata,
/// and must reject oversized input without first allocating the full input.
pub trait SourceReader: Send + Sync + 'static {
    fn read<'a>(&'a self, lease: &'a ContextGrantLease) -> SourceReadFuture<'a>;

    /// Called after final validation committed the response and before the
    /// wire write. Default: nothing.
    #[cfg(feature = "swarm-test-seams")]
    fn observe_commit<'a>(
        &'a self,
        _record: &'a PublicationCommitment,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async {})
    }
}

pub struct SourceSnapshot {
    pub snapshot_identity: String,
    pub captured_through: Option<u64>,
    pub body: Vec<u8>,
}

#[derive(Debug)]
pub enum SourceReadError {
    Unavailable(&'static str),
    TooLarge,
    Io(String),
}

/// Identifies an already encoded, owned output at the fixture observation
/// boundary. This does not represent send success or grant output capacity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputKind {
    Response,
    Event,
    Publication,
}

/// Library-only async fixture barrier. It receives metadata, never an output
/// buffer or a reusable credit. The output owner stays with the RPC future.
#[cfg(feature = "swarm-test-seams")]
pub trait OutputObserver: Send + Sync + 'static {
    fn before_write(
        &self,
        kind: OutputKind,
        encoded_bytes: usize,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

/// Production reader: no source adapter exists in this build.
pub struct UnavailableSourceReader;

impl SourceReader for UnavailableSourceReader {
    fn read<'a>(&'a self, _lease: &'a ContextGrantLease) -> SourceReadFuture<'a> {
        Box::pin(async {
            Err(SourceReadError::Unavailable(
                "the trusted source reader is not available in this build",
            ))
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateState {
    /// Endpoints are bound and accepting, discovery is not yet published.
    Pending,
    Open,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EndpointPolicy {
    Owner,
    Peer,
}

/// Identity of one authenticated connection, decided from native evidence.
#[derive(Clone, Debug)]
pub(crate) enum ConnectionRole {
    Owner,
    Peer(PeerPrincipal),
    /// Boot-verified same-account process without a verified enrollment.
    Unenrolled,
}

#[derive(Default)]
pub(crate) struct Counters {
    pub accepted: AtomicU64,
    pub accept_failures: AtomicU64,
    pub rejected_handshakes: AtomicU64,
    pub owner_sessions: AtomicU64,
    pub peer_sessions: AtomicU64,
    pub unenrolled_peer_sessions: AtomicU64,
    pub active_sessions: AtomicU64,
    pub malformed_frames: AtomicU64,
    pub unenrolled_refusals: AtomicU64,
    pub dispatched: AtomicU64,
}

pub(crate) struct Shared {
    pub boot_id: String,
    pub authority_id: String,
    pub client: Client,
    pub owner: OwnerPrincipal,
    pub events: EventHub,
    pub gate: watch::Sender<GateState>,
    pub budget: FrameBudget,
    pub output: OutputBudget,
    pub max_connections: usize,
    pub handshake_timeout: Duration,
    pub source_read_timeout: Duration,
    pub source_reader: Arc<dyn SourceReader>,
    #[cfg(feature = "swarm-test-seams")]
    output_observer: Option<Arc<dyn OutputObserver>>,
    source_slots: Semaphore,
    pub bindings: Mutex<HashMap<ProcessIdentity, VerifiedBinding>>,
    pub counters: Counters,
    /// Every session task this runtime spawned; aborted and joined before
    /// the worker and the authority claim are released.
    pub sessions: Mutex<JoinSet<()>>,
    /// Last field: contained resources drop before this authority owner.
    _claim: Arc<AuthorityClaim>,
}

/// Field order makes the authority outlive the complete future, including
/// native endpoint destruction on abort, unpolled Drop or panic. A separate
/// capture inside an async block does not establish that destruction order.
pub(crate) struct ClaimedTask<F> {
    future: Pin<Box<F>>,
    _claim: Arc<AuthorityClaim>,
}

impl<F: Future<Output = ()>> Future for ClaimedTask<F> {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        self.future.as_mut().poll(context)
    }
}

impl Shared {
    pub(crate) fn own_task<F: Future<Output = ()>>(&self, future: F) -> ClaimedTask<F> {
        ClaimedTask {
            future: Box::pin(future),
            _claim: self._claim.clone(),
        }
    }

    /// Called only while an encoded output and all of its credits remain
    /// owned. Ordinary builds perform no observation or await here.
    pub(crate) async fn observe_output(&self, kind: OutputKind, encoded_bytes: usize) {
        #[cfg(feature = "swarm-test-seams")]
        if let Some(observer) = &self.output_observer {
            let mut gate = self.gate.subscribe();
            if matches!(*gate.borrow(), GateState::Closed) {
                return;
            }
            tokio::select! {
                biased;
                _ = gate.changed() => {},
                _ = tokio::time::sleep(self.source_read_timeout) => {},
                _ = observer.before_write(kind, encoded_bytes) => {},
            }
        }
        #[cfg(not(feature = "swarm-test-seams"))]
        let _ = (kind, encoded_bytes);
    }

    pub(crate) async fn read_source(
        &self,
        lease: &ContextGrantLease,
    ) -> Result<SourceSnapshot, SourceReadError> {
        let _permit = self.source_slots.try_acquire().map_err(|_| {
            SourceReadError::Unavailable("source I/O capacity is currently occupied")
        })?;
        let mut gate = self.gate.subscribe();
        if !matches!(*gate.borrow(), GateState::Open) {
            return Err(SourceReadError::Unavailable("the broker is closing"));
        }
        tokio::select! {
            biased;
            _ = gate.changed() => Err(SourceReadError::Unavailable("the broker is closing")),
            _ = tokio::time::sleep(self.source_read_timeout) => {
                Err(SourceReadError::Unavailable("source read exceeded its deadline"))
            }
            result = self.source_reader.read(lease) => result,
        }
    }

    /// Test-only post-commit observation never blocks production publication.
    /// The fixture future is cancellation-aware and acquires no output capacity.
    pub(crate) async fn observe_commit(&self, record: &PublicationCommitment) {
        #[cfg(feature = "swarm-test-seams")]
        {
            let mut gate = self.gate.subscribe();
            if matches!(*gate.borrow(), GateState::Closed) {
                return;
            }
            tokio::select! {
                biased;
                _ = gate.changed() => {},
                _ = tokio::time::sleep(self.source_read_timeout) => {},
                _ = self.source_reader.observe_commit(record) => {},
            }
        }
        #[cfg(not(feature = "swarm-test-seams"))]
        let _ = record;
    }

    /// Bounded admission with retry only on momentary contention. The
    /// command is rebuilt for each attempt because rejection consumes it.
    pub(crate) async fn submit(
        &self,
        make: impl Fn() -> Command,
    ) -> Result<Response, rpc::ErrorPayload> {
        retry_admission(|| self.client.submit(make()))
            .await
            .map_err(rpc::ErrorPayload::from)?
            .await
            .map_err(Into::into)
    }

    /// Single-attempt admission for commands that cannot be rebuilt.
    pub(crate) async fn submit_once(
        &self,
        command: Command,
    ) -> Result<Response, rpc::ErrorPayload> {
        match self.client.submit(command) {
            Ok(pending) => pending.await.map_err(Into::into),
            Err(error) => Err(error.into()),
        }
    }
}

pub struct BrokerConfig {
    pub data_dir: PathBuf,
    pub owner_pipe_name: Option<String>,
    pub peer_pipe_name: Option<String>,
    pub frame_budget_bytes: usize,
    pub max_connections: usize,
    pub worker: WorkerConfig,
    pub handshake_timeout: Duration,
    pub event_capacity: usize,
    /// Aggregate host output ownership (decoded responses, DTOs and encoded
    /// frames held until written) and the control headroom kept inside it.
    pub output_budget_bytes: usize,
    pub output_headroom_bytes: usize,
    /// Bound on one trusted source read. Expiry drops its cancellable future
    /// and releases the source slot; no abandoned blocking result exists.
    pub source_read_timeout: Duration,
    source_reader: Arc<dyn SourceReader>,
    #[cfg(feature = "swarm-test-seams")]
    output_observer: Option<Arc<dyn OutputObserver>>,
}

impl BrokerConfig {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            owner_pipe_name: None,
            peer_pipe_name: None,
            frame_budget_bytes: DEFAULT_FRAME_BUDGET_BYTES,
            max_connections: DEFAULT_MAX_CONNECTIONS,
            worker: WorkerConfig::default(),
            handshake_timeout: DEFAULT_HANDSHAKE_TIMEOUT,
            event_capacity: DEFAULT_EVENT_CAPACITY,
            output_budget_bytes: DEFAULT_OUTPUT_BUDGET_BYTES,
            output_headroom_bytes: DEFAULT_OUTPUT_HEADROOM_BYTES,
            source_read_timeout: DEFAULT_SOURCE_READ_TIMEOUT,
            source_reader: Arc::new(UnavailableSourceReader),
            #[cfg(feature = "swarm-test-seams")]
            output_observer: None,
        }
    }

    /// Library seam for tests: a fixture source reader for exact owned
    /// synthetic sources. Not reachable from the wire or the command line.
    #[cfg(feature = "swarm-test-seams")]
    pub fn with_source_reader(mut self, reader: Arc<dyn SourceReader>) -> Self {
        self.source_reader = reader;
        self
    }

    #[cfg(feature = "swarm-test-seams")]
    pub fn with_output_observer(mut self, observer: Arc<dyn OutputObserver>) -> Self {
        self.output_observer = Some(observer);
        self
    }

    pub fn swarm_root(&self) -> PathBuf {
        self.data_dir.join(SWARM_DIRECTORY)
    }
}

#[derive(Debug)]
pub enum BrokerError {
    /// Another runtime owns the authority; no recovery was attempted.
    Busy,
    Authority(AuthorityError),
    Worker(WorkerError),
    Operation(OperationError),
    Admission(AdmissionError),
    Bind {
        endpoint: &'static str,
        error: WireError,
    },
    Publish(AuthorityError),
    Io(std::io::Error),
    Rpc(rpc::ErrorPayload),
    UnexpectedResponse(&'static str),
}

impl std::fmt::Display for BrokerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy => write!(f, "another swarm broker owns this data directory"),
            Self::Authority(error) => write!(f, "authority: {error}"),
            Self::Worker(error) => write!(f, "store worker: {error}"),
            Self::Operation(error) => write!(f, "store operation: {error}"),
            Self::Admission(error) => write!(f, "store admission: {error}"),
            Self::Bind { endpoint, error } => write!(f, "binding the {endpoint} endpoint: {error}"),
            Self::Publish(error) => write!(f, "publishing discovery: {error}"),
            Self::Io(error) => write!(f, "I/O: {error}"),
            Self::Rpc(error) => write!(
                f,
                "{}: {}",
                serde_json::to_string(&error.code).unwrap_or_default(),
                error.message
            ),
            Self::UnexpectedResponse(step) => write!(f, "unexpected core response during {step}"),
        }
    }
}

impl std::error::Error for BrokerError {}

impl From<WorkerError> for BrokerError {
    fn from(error: WorkerError) -> Self {
        Self::Worker(error)
    }
}

impl From<std::io::Error> for BrokerError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<rpc::ErrorPayload> for BrokerError {
    fn from(error: rpc::ErrorPayload) -> Self {
        Self::Rpc(error)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StartReport {
    pub recovered_attempts: usize,
    pub live_bindings_checked: usize,
    pub bindings_marked_offline: usize,
}

pub struct BrokerRuntime {
    shared: Arc<Shared>,
    claim: Option<Arc<AuthorityClaim>>,
    worker: Option<Worker>,
    discovery: DiscoveryRecord,
    accept_tasks: Vec<JoinHandle<()>>,
    report: StartReport,
}

fn random_id(prefix: &str) -> String {
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let mut value = String::with_capacity(prefix.len() + 33);
    value.push_str(prefix);
    value.push('-');
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    value
}

async fn submit_start(
    client: &Client,
    make: impl Fn() -> Command,
) -> Result<Response, BrokerError> {
    retry_admission(|| client.submit(make()))
        .await
        .map_err(BrokerError::Admission)?
        .await
        .map_err(BrokerError::Operation)
}

async fn retry_admission(
    mut submit: impl FnMut() -> Result<Pending, AdmissionError>,
) -> Result<Pending, AdmissionError> {
    // Tokio yields do not guarantee that the native SQLite thread runs. Use
    // elapsed time with capped backoff; only Contended is safe to retry, since
    // it proves no command was enqueued. Capacity/closed refusals stay immediate.
    let deadline = tokio::time::Instant::now() + ADMISSION_TIMEOUT;
    let mut spins = 0;
    let mut backoff = Duration::from_millis(1);
    loop {
        match submit() {
            Err(AdmissionError::Contended) if tokio::time::Instant::now() < deadline => {
                if spins < 8 {
                    spins += 1;
                    tokio::task::yield_now().await;
                } else {
                    tokio::time::sleep_until((tokio::time::Instant::now() + backoff).min(deadline))
                        .await;
                    backoff = (backoff * 2).min(Duration::from_millis(16));
                }
            }
            result => return result,
        }
    }
}

/// Exact-process refresh: every persisted binding recorded live is verified
/// against its exact PID and creation FILETIME; a stale, gone or exited
/// generation is marked offline. Each page is bounded; startup reaches the
/// actual end of persisted history before advertising readiness.
async fn refresh_bindings(
    client: &Client,
    owner: &OwnerPrincipal,
) -> Result<(usize, usize), BrokerError> {
    let mut after = None;
    let mut expected_inventory_revision = None;
    let mut checked = 0;
    let mut offline = 0;
    loop {
        let after_peer = after.clone();
        let page = match submit_start(client, || {
            Command::OwnerSnapshot(
                owner.clone(),
                OwnerSnapshotRequest::Peers {
                    expected_inventory_revision,
                    after_peer: after_peer.clone(),
                    max_items: REFRESH_PAGE_ITEMS,
                },
            )
        })
        .await?
        {
            Response::Snapshot(OwnerSnapshotPage::Peers(page)) => page,
            _ => return Err(BrokerError::UnexpectedResponse("binding refresh")),
        };
        let offline_before_page = offline;
        for view in page.peers {
            let binding = view.binding;
            if !binding.is_live {
                continue;
            }
            checked += 1;
            let alive = VerifiedProcess::verify(ProcessIdentity::new(
                binding.process_id,
                binding.process_creation_filetime,
            ))
            .ok()
            .and_then(|process| process.is_alive().ok())
            .unwrap_or(false);
            if alive {
                continue;
            }
            let peer_id = binding.peer_id.clone();
            let revision = binding.revision;
            let model_metadata = binding.model_metadata.clone();
            submit_start(client, || {
                Command::UpdatePeer(
                    owner.clone(),
                    peer_id.clone(),
                    revision,
                    PeerMetadataUpdate {
                        model_metadata: model_metadata.clone(),
                        is_live: false,
                    },
                )
            })
            .await?;
            offline += 1;
        }
        match page.next_after_peer {
            Some(next) => {
                if after.as_ref().is_some_and(|previous| &next <= previous) {
                    return Err(BrokerError::UnexpectedResponse("refresh cursor progress"));
                }
                // Startup exclusively owns the writer and the dispatch gate is
                // still closed. Our metadata-only updates preserve peer keys,
                // but advance inventory_revision. Rebase this traversal only
                // after those updates; never reuse a stale snapshot revision.
                expected_inventory_revision = Some(if offline != offline_before_page {
                    match submit_start(client, || Command::StateRevisions(owner.clone())).await? {
                        Response::Revisions(revisions) => revisions.inventory_revision,
                        _ => return Err(BrokerError::UnexpectedResponse("refresh revisions")),
                    }
                } else {
                    page.revisions.inventory_revision
                });
                after = Some(next);
            }
            None => break,
        }
    }
    Ok((checked, offline))
}

impl BrokerRuntime {
    /// Starts the runtime in the approved order. Must run inside a Tokio
    /// multi-thread or current-thread runtime that outlives the value.
    pub async fn start(config: BrokerConfig) -> Result<Self, BrokerError> {
        std::fs::create_dir_all(&config.data_dir)?;
        let root = config.swarm_root();
        let claim = Arc::new(AuthorityClaim::claim(&root).map_err(|error| match error {
            AuthorityError::Busy => BrokerError::Busy,
            other => BrokerError::Authority(other),
        })?);
        let credential = Arc::new(
            claim
                .load_or_create_owner_credential()
                .map_err(BrokerError::Authority)?,
        );

        let worker =
            Worker::open_with_lifetime(root.join(STORE_FILE), config.worker.clone(), claim.clone())
                .await?;
        let client = worker.client();
        let started = async {
            let owner = match submit_start(&client, || Command::TrustedOwner).await? {
                Response::Owner(owner) => owner,
                _ => return Err(BrokerError::UnexpectedResponse("trusted owner")),
            };
            let recovered = match submit_start(&client, || Command::Recover(owner.clone())).await? {
                Response::Recovered(count) => count,
                _ => return Err(BrokerError::UnexpectedResponse("recovery")),
            };
            let (checked, offline) = refresh_bindings(&client, &owner).await?;
            Ok((
                owner,
                StartReport {
                    recovered_attempts: recovered,
                    live_bindings_checked: checked,
                    bindings_marked_offline: offline,
                },
            ))
        }
        .await;
        let (owner, report) = match started {
            Ok(value) => value,
            Err(error) => {
                let _ = worker.shutdown().await;
                return Err(error);
            }
        };

        let boot_id = random_id("boot");
        let authority_id = owner.authority_id().as_str().to_owned();
        let owner_pipe_name = config
            .owner_pipe_name
            .clone()
            .unwrap_or_else(|| format!(r"\\.\pipe\{}", random_id("termx-swarm-owner")));
        let peer_pipe_name = config
            .peer_pipe_name
            .clone()
            .unwrap_or_else(|| format!(r"\\.\pipe\{}", random_id("termx-swarm-peer")));
        let budget = FrameBudget::with_limits(config.frame_budget_bytes, config.max_connections);

        let owner_server = match PipeServer::bind(&owner_pipe_name, budget.clone()) {
            Ok(server) => server,
            Err(error) => {
                let _ = worker.shutdown().await;
                return Err(BrokerError::Bind {
                    endpoint: "owner",
                    error,
                });
            }
        };
        let peer_server = match PipeServer::bind(&peer_pipe_name, budget.clone()) {
            Ok(server) => server,
            Err(error) => {
                drop(owner_server);
                let _ = worker.shutdown().await;
                return Err(BrokerError::Bind {
                    endpoint: "peer",
                    error,
                });
            }
        };
        let server_identity = owner_server.identity();

        let (gate, _) = watch::channel(GateState::Pending);
        let shared = Arc::new(Shared {
            _claim: claim.clone(),
            boot_id: boot_id.clone(),
            authority_id: authority_id.clone(),
            client,
            owner,
            events: EventHub::new(boot_id.clone(), config.event_capacity),
            gate,
            budget,
            output: OutputBudget::new(config.output_budget_bytes, config.output_headroom_bytes),
            max_connections: config.max_connections,
            handshake_timeout: config.handshake_timeout,
            source_read_timeout: config.source_read_timeout,
            source_reader: config.source_reader.clone(),
            #[cfg(feature = "swarm-test-seams")]
            output_observer: config.output_observer.clone(),
            source_slots: Semaphore::new(MAX_CONCURRENT_SOURCE_READS),
            bindings: Mutex::new(HashMap::new()),
            counters: Counters::default(),
            sessions: Mutex::new(JoinSet::new()),
        });
        let accept_tasks = vec![
            tokio::spawn(shared.own_task(accept_loop(
                owner_server,
                EndpointPolicy::Owner,
                shared.clone(),
                credential.clone(),
            ))),
            tokio::spawn(shared.own_task(accept_loop(
                peer_server,
                EndpointPolicy::Peer,
                shared.clone(),
                credential,
            ))),
        ];

        let discovery = DiscoveryRecord::new(
            authority_id,
            boot_id,
            server_identity,
            owner_pipe_name,
            peer_pipe_name,
        );
        let runtime = Self {
            shared,
            claim: Some(claim),
            worker: Some(worker),
            discovery,
            accept_tasks,
            report,
        };
        if let Err(error) = runtime
            .claim
            .as_ref()
            .expect("claim held during start")
            .publish_discovery(&runtime.discovery)
        {
            // Predecessor discovery stays as it was; only our own endpoints,
            // tasks and worker are released.
            let _ = runtime.shutdown().await;
            return Err(BrokerError::Publish(error));
        }
        runtime.shared.gate.send_replace(GateState::Open);
        Ok(runtime)
    }

    pub fn discovery(&self) -> &DiscoveryRecord {
        &self.discovery
    }

    pub fn boot_id(&self) -> &str {
        &self.shared.boot_id
    }

    pub fn authority_id(&self) -> &str {
        &self.shared.authority_id
    }

    pub fn report(&self) -> StartReport {
        self.report
    }

    pub fn gate(&self) -> GateState {
        *self.shared.gate.borrow()
    }

    /// Shared frame budget usage: (bytes, frames).
    pub fn budget_usage(&self) -> (usize, usize) {
        self.shared.budget.usage()
    }

    /// Aggregate host output ownership currently held.
    pub fn output_usage(&self) -> usize {
        self.shared.output.usage()
    }

    pub fn output_high_water(&self) -> usize {
        self.shared.output.high_water()
    }

    pub fn output_rejected(&self) -> u64 {
        self.shared.output.rejected()
    }

    pub fn active_source_reads(&self) -> usize {
        MAX_CONCURRENT_SOURCE_READS - self.shared.source_slots.available_permits()
    }

    pub fn active_sessions(&self) -> u64 {
        self.shared.counters.active_sessions.load(Ordering::Relaxed)
    }

    pub fn worker_metrics(&self) -> termx_swarm_core::worker::Metrics {
        self.shared.client.metrics()
    }

    /// Library seam for tests: enrolls a trusted binding for an exact owned
    /// process generation and lets that generation authenticate on the
    /// peer endpoint. Never reachable from the wire or the command line.
    #[cfg(feature = "swarm-test-seams")]
    pub async fn enroll_trusted_binding(
        &self,
        identity: ProcessIdentity,
        binding: VerifiedBinding,
    ) -> Result<EnrolledPeer, BrokerError> {
        let owner = self.shared.owner.clone();
        let enrolled = match self
            .shared
            .submit(|| Command::Enroll(owner.clone(), binding.clone()))
            .await?
        {
            Response::Enrolled(enrolled) => enrolled,
            _ => return Err(BrokerError::UnexpectedResponse("enroll")),
        };
        self.shared
            .bindings
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(identity, binding);
        Ok(enrolled)
    }

    /// Library seam for tests: binds an exact process generation to an
    /// already persisted trusted binding (for example after a restart).
    #[cfg(feature = "swarm-test-seams")]
    pub fn bind_trusted_identity(&self, identity: ProcessIdentity, binding: VerifiedBinding) {
        self.shared
            .bindings
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(identity, binding);
    }

    /// Library seam for tests: registers a trusted synthetic source.
    #[cfg(feature = "swarm-test-seams")]
    pub async fn register_trusted_source(
        &self,
        descriptor: VerifiedSourceDescriptor,
    ) -> Result<SourceRegistration, BrokerError> {
        let owner = self.shared.owner.clone();
        match self
            .shared
            .submit(|| Command::RegisterSource(owner.clone(), descriptor.clone()))
            .await?
        {
            Response::Source(registration) => Ok(registration),
            _ => Err(BrokerError::UnexpectedResponse("register source")),
        }
    }

    /// Library seam for tests: the worker client for direct core commands.
    #[cfg(feature = "swarm-test-seams")]
    pub fn core_client(&self) -> Client {
        self.shared.client.clone()
    }

    #[cfg(feature = "swarm-test-seams")]
    pub fn owner_principal(&self) -> OwnerPrincipal {
        self.shared.owner.clone()
    }

    /// Closes the gate, stops accepting, drains sessions for a bounded time,
    /// shuts the worker down and releases the authority claim last. The
    /// discovery document is left in place; clients reject its stale
    /// generation.
    pub async fn shutdown(mut self) -> Result<(), BrokerError> {
        self.stop_serving().await;
        let mut result = Ok(());
        if let Some(worker) = self.worker.take() {
            result = worker.shutdown().await.map_err(BrokerError::Worker);
        }
        drop(self.claim.take());
        result
    }

    /// Closes the gate, stops accepting, lets sessions observe the gate for
    /// a bounded time, then aborts and joins every remaining session task
    /// this runtime owns (including ones blocked in slow writes). Nothing of
    /// this generation survives into the next claim.
    async fn stop_serving(&mut self) {
        self.shared.gate.send_replace(GateState::Closed);
        // Abort every listener before the first join can yield. Cancelling
        // a drain iterator would otherwise drop remaining JoinHandles without
        // aborting their still-live tasks or releasing their native listeners.
        for task in &self.accept_tasks {
            task.abort();
        }
        for task in self.accept_tasks.drain(..) {
            let _ = task.await;
        }
        let deadline = Instant::now() + SHUTDOWN_DRAIN;
        while self.shared.counters.active_sessions.load(Ordering::Relaxed) > 0
            && Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let mut sessions = std::mem::take(
            &mut *self
                .shared
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
        sessions.abort_all();
        while sessions.join_next().await.is_some() {}
    }
}

impl Drop for BrokerRuntime {
    fn drop(&mut self) {
        self.shared.gate.send_replace(GateState::Closed);
        self.shared.client.close();
        for task in self.accept_tasks.drain(..) {
            task.abort();
        }
        self.shared
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .abort_all();
        // Shared tasks and the native worker/reaper retain their claim copies
        // until their actual resources exit, even if an async shutdown is dropped.
    }
}

async fn accept_loop(
    mut server: PipeServer,
    policy: EndpointPolicy,
    shared: Arc<Shared>,
    credential: Arc<OwnerCredential>,
) {
    loop {
        if matches!(*shared.gate.borrow(), GateState::Closed) {
            break;
        }
        match server.accept().await {
            Ok(pipe) => {
                shared.counters.accepted.fetch_add(1, Ordering::Relaxed);
                let mut sessions = shared
                    .sessions
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                // Reap finished sessions so the set stays bounded by live ones.
                while sessions.try_join_next().is_some() {}
                sessions.spawn(shared.own_task(serve_connection(
                    pipe,
                    policy,
                    shared.clone(),
                    credential.clone(),
                )));
            }
            Err(_) => {
                shared
                    .counters
                    .accept_failures
                    .fetch_add(1, Ordering::Relaxed);
                tokio::time::sleep(ACCEPT_FAILURE_BACKOFF).await;
            }
        }
    }
}

/// Fixed per-endpoint authentication, then the gate, then native identity
/// evidence decides the role. The hello never chooses a principal.
async fn serve_connection(
    pipe: VerifiedPipe,
    policy: EndpointPolicy,
    shared: Arc<Shared>,
    credential: Arc<OwnerCredential>,
) {
    let authenticated = match policy {
        EndpointPolicy::Owner => {
            pipe.authenticate_owner_with_timeout(
                &shared.boot_id,
                &credential,
                shared.handshake_timeout,
            )
            .await
        }
        EndpointPolicy::Peer => {
            pipe.authenticate_peer_with_timeout(&shared.boot_id, shared.handshake_timeout)
                .await
        }
    };
    if authenticated.is_err() {
        shared
            .counters
            .rejected_handshakes
            .fetch_add(1, Ordering::Relaxed);
        return;
    }
    if !wait_for_gate(&shared).await {
        return;
    }
    let Ok(identity) = pipe.connecting_client_identity() else {
        return;
    };
    let role = match policy {
        EndpointPolicy::Owner => {
            shared
                .counters
                .owner_sessions
                .fetch_add(1, Ordering::Relaxed);
            ConnectionRole::Owner
        }
        EndpointPolicy::Peer => {
            let binding = shared
                .bindings
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(&identity)
                .cloned();
            match binding {
                Some(binding) => match shared
                    .submit(|| Command::Authenticate(binding.clone()))
                    .await
                {
                    Ok(Response::Principal(principal)) => {
                        shared
                            .counters
                            .peer_sessions
                            .fetch_add(1, Ordering::Relaxed);
                        ConnectionRole::Peer(principal)
                    }
                    _ => {
                        shared
                            .counters
                            .unenrolled_peer_sessions
                            .fetch_add(1, Ordering::Relaxed);
                        ConnectionRole::Unenrolled
                    }
                },
                None => {
                    shared
                        .counters
                        .unenrolled_peer_sessions
                        .fetch_add(1, Ordering::Relaxed);
                    ConnectionRole::Unenrolled
                }
            }
        }
    };
    rpc::run_session(Arc::new(pipe), role, shared).await;
}

/// Waits until the gate opens; `false` when it closed first.
async fn wait_for_gate(shared: &Shared) -> bool {
    let mut gate = shared.gate.subscribe();
    loop {
        match *gate.borrow_and_update() {
            GateState::Open => return true,
            GateState::Closed => return false,
            GateState::Pending => {}
        }
        if gate.changed().await.is_err() {
            return false;
        }
    }
}

/// Entry point of `--swarm-broker`. Runs the broker until its lifetime
/// policy ends, then shuts it down. Nothing here touches ordinary host logs,
/// history or PTY state.
pub fn run_broker_mode(args: BrokerArgs) -> i32 {
    let data_dir = match crate::paths::resolve_data_dir(args.data_dir.as_deref()) {
        Ok(dir) => dir,
        Err(error) => {
            eprintln!("TermX swarm broker: {error:#}");
            return EXIT_START_FAILED;
        }
    };
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("TermX swarm broker: tokio runtime: {error}");
            return EXIT_START_FAILED;
        }
    };
    let code = runtime.block_on(async move {
        let broker = match BrokerRuntime::start(BrokerConfig::new(data_dir)).await {
            Ok(broker) => broker,
            Err(error) => {
                eprintln!("TermX swarm broker: {error}");
                return EXIT_START_FAILED;
            }
        };
        // Printed only after discovery is published and the gate is open.
        println!("swarm-broker ready");
        lifetime::wait_for_exit(&args.lifetime).await;
        match broker.shutdown().await {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("TermX swarm broker: shutdown: {error}");
                1
            }
        }
    });
    // Bounded: a launcher still holding stdin open or a slow blocking read
    // cannot keep the exiting process alive indefinitely.
    runtime.shutdown_timeout(BROKER_MODE_RUNTIME_SHUTDOWN);
    code
}

#[allow(dead_code)]
fn _publication_bound_matches_core() {
    const _: () = assert!(
        rpc::PUBLICATION_HEADER_ALLOWANCE + 4
            < termx_swarm_core::model::MAX_PUBLICATION_RESERVATION_OVERHEAD_BYTES
    );
    let _ = MAX_PUBLICATION_BYTES;
    let _: Option<&Path> = None;
}

#[cfg(test)]
mod ownership_tests {
    use super::*;
    use crate::test_support as ownership_support;
    use std::sync::atomic::AtomicBool;

    /// A native worker can be descheduled while holding its short queue lock.
    /// Model that admission boundary with an independently timed native thread,
    /// then require a real worker request to complete after it becomes available.
    #[tokio::test]
    async fn startup_admission_waits_for_native_scheduling_instead_of_counting_yields() {
        let fixture = ownership_support::retained_dir().unwrap();
        let worker = Worker::open(
            fixture.path().join("admission.sqlite"),
            WorkerConfig::default(),
        )
        .await
        .unwrap();
        let client = worker.client();
        let available = Arc::new(AtomicBool::new(false));
        let ready = available.clone();
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(40));
            ready.store(true, Ordering::SeqCst);
        });
        let result = retry_admission(|| {
            if available.load(Ordering::SeqCst) {
                client.submit(Command::TrustedOwner)
            } else {
                Err(AdmissionError::Contended)
            }
        })
        .await;
        release.join().unwrap();
        let response = match result {
            Ok(pending) => Some(pending.await.unwrap()),
            Err(_) => None,
        };
        worker.shutdown().await.unwrap();
        assert!(
            matches!(response, Some(Response::Owner(_))),
            "momentary native scheduling contention must not exhaust a yield counter"
        );
    }

    #[tokio::test]
    async fn admission_contention_is_bounded_and_capacity_refusals_are_immediate() {
        let mut attempts = 0;
        let started = Instant::now();
        assert!(matches!(
            retry_admission(|| {
                attempts += 1;
                Err(AdmissionError::Contended)
            })
            .await,
            Err(AdmissionError::Contended)
        ));
        assert!(started.elapsed() >= ADMISSION_TIMEOUT);
        assert!(attempts < 128, "bounded backoff must avoid busy polling");
        for error in [
            AdmissionError::Closed,
            AdmissionError::Requests,
            AdmissionError::ResponseBytes,
        ] {
            let mut attempts = 0;
            assert!(retry_admission(|| {
                attempts += 1;
                Err(error)
            })
            .await
            .is_err());
            assert_eq!(attempts, 1, "only momentary lock contention is retried");
        }
    }

    struct ResourceDropProbe {
        root: PathBuf,
        claim_was_held: Arc<AtomicBool>,
    }

    impl Drop for ResourceDropProbe {
        fn drop(&mut self) {
            self.claim_was_held.store(
                matches!(AuthorityClaim::claim(&self.root), Err(AuthorityError::Busy)),
                Ordering::SeqCst,
            );
        }
    }

    #[tokio::test]
    async fn owned_future_destroys_resources_before_releasing_native_claim() {
        for polled in [false, true] {
            let fixture = ownership_support::retained_dir().unwrap();
            let root = fixture.path().join("authority");
            let claim = Arc::new(AuthorityClaim::claim(&root).unwrap());
            let observed = Arc::new(AtomicBool::new(false));
            let probe = ResourceDropProbe {
                root: root.clone(),
                claim_was_held: observed.clone(),
            };
            let mut owned = ClaimedTask {
                future: Box::pin(async move {
                    let _probe = probe;
                    std::future::pending::<()>().await;
                }),
                _claim: claim,
            };
            if polled {
                let result =
                    std::future::poll_fn(|context| Poll::Ready(Pin::new(&mut owned).poll(context)))
                        .await;
                assert!(result.is_pending());
            }
            drop(owned);
            assert!(
                observed.load(Ordering::SeqCst),
                "resource destructor must still see the native claim held"
            );
            drop(AuthorityClaim::claim(&root).expect("claim released after resources"));
        }
    }

    #[tokio::test]
    async fn owned_future_panic_keeps_claim_through_resource_unwind() {
        let fixture = ownership_support::retained_dir().unwrap();
        let root = fixture.path().join("authority");
        let claim = Arc::new(AuthorityClaim::claim(&root).unwrap());
        let observed = Arc::new(AtomicBool::new(false));
        let probe = ResourceDropProbe {
            root: root.clone(),
            claim_was_held: observed.clone(),
        };
        let task = tokio::spawn(ClaimedTask {
            future: Box::pin(async move {
                let _probe = probe;
                panic!("owned synthetic task panic");
            }),
            _claim: claim,
        });
        assert!(task.await.unwrap_err().is_panic());
        assert!(observed.load(Ordering::SeqCst));
        drop(AuthorityClaim::claim(&root).expect("claim released after unwind"));
    }

    struct HeldTaskDrop {
        entered: Arc<tokio::sync::Notify>,
        release: std::sync::mpsc::Receiver<()>,
    }

    impl Drop for HeldTaskDrop {
        fn drop(&mut self) {
            self.entered.notify_one();
            let _ = self.release.recv_timeout(Duration::from_secs(5));
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancelling_shutdown_during_first_accept_join_aborts_all_owned_listeners() {
        use crate::swarm::rpc::{Empty, OwnerOperation, TypedConnection};
        use termx_swarm_client::{ClientBootstrap, OwnerClient, PeerClient};
        let fixture = ownership_support::retained_dir().unwrap();
        let config = BrokerConfig::new(fixture.path().join("data"));
        let root = config.swarm_root();
        let mut broker = BrokerRuntime::start(config).await.unwrap();
        let credential = ClientBootstrap::open(&root)
            .unwrap()
            .load_owner_credential()
            .unwrap();
        let mut owner = TypedConnection::owner(
            OwnerClient::connect(broker.discovery(), &credential)
                .await
                .unwrap(),
        );
        owner
            .call_owner(OwnerOperation::Health(Empty {}))
            .await
            .unwrap();
        let peer = PeerClient::connect(broker.discovery()).await.unwrap();
        drop(owner);
        drop(peer);
        tokio::time::sleep(Duration::from_millis(30)).await;

        // Delay destruction of the first owned task while the real owner and
        // peer listeners remain pending. This makes cancellation at the first
        // join deterministic rather than relying on executor timing.
        let entered = Arc::new(tokio::sync::Notify::new());
        let (release, held) = std::sync::mpsc::channel();
        let (ready, started) = tokio::sync::oneshot::channel();
        let drop_guard = HeldTaskDrop {
            entered: entered.clone(),
            release: held,
        };
        let first = tokio::spawn(broker.shared.own_task(async move {
            let _drop_guard = drop_guard;
            let _ = ready.send(());
            std::future::pending::<()>().await;
        }));
        started.await.unwrap();
        broker.accept_tasks.insert(0, first);
        let aborts: Vec<_> = broker
            .accept_tasks
            .iter()
            .map(JoinHandle::abort_handle)
            .collect();
        let mut shutting = Box::pin(broker.shutdown());
        let initial = std::future::poll_fn(|cx| Poll::Ready(shutting.as_mut().poll(cx))).await;
        assert!(initial.is_pending());
        tokio::time::timeout(Duration::from_secs(2), entered.notified())
            .await
            .unwrap();
        drop(shutting);
        release.send(()).unwrap();
        let released = tokio::time::timeout(Duration::from_millis(500), async {
            loop {
                match AuthorityClaim::claim(&root) {
                    Ok(claim) => {
                        drop(claim);
                        break;
                    }
                    Err(AuthorityError::Busy) => {
                        tokio::time::sleep(Duration::from_millis(10)).await
                    }
                    Err(error) => panic!("claim: {error:?}"),
                }
            }
        })
        .await
        .is_ok();
        // Cleanup only the exact handles retained above even on the RED path;
        // a failing assertion must not leave the fixture's listeners orphaned.
        for abort in aborts {
            abort.abort();
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match AuthorityClaim::claim(&root) {
                    Ok(claim) => {
                        drop(claim);
                        break;
                    }
                    Err(AuthorityError::Busy) => {
                        tokio::time::sleep(Duration::from_millis(10)).await
                    }
                    Err(error) => panic!("cleanup claim: {error:?}"),
                }
            }
        })
        .await
        .unwrap();
        assert!(
            released,
            "cancelling a join must not detach the remaining live listeners"
        );
    }
}
