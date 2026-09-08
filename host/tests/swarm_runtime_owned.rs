//! Broker ownership regressions using retained synthetic data only.
#![cfg(windows)]

mod support;

use std::future::{poll_fn, Future};
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;
use termx_host::swarm::rpc::{
    Empty, ErrorCode, EventBody, Outcome, OwnerOperation, OwnerRequest, PeerOperation, PeerRequest,
    SnapshotParams, TypedConnection, SWARM_RPC_VERSION,
};
use termx_host::swarm::runtime::{
    BrokerConfig, BrokerError, BrokerRuntime, GateState, OutputKind, OutputObserver,
    SourceReadError, SourceReadFuture, SourceReader, SourceSnapshot,
};
use termx_swarm_client::{
    AuthorityClaim, AuthorityError, ClientBootstrap, DecimalU64, DiscoveryRecord, FrameBudget,
    OwnerClient, PeerClient, PipeServer, VerifiedProcess,
};
use termx_swarm_core::model::VerifiedContinuation;
use termx_swarm_core::model::{
    ContextGrantLease, GroupId, LaunchId, OwnerSnapshotPage, SourceId, SourceTransition,
    VerifiedBinding, VerifiedSourceDescriptor,
};
use termx_swarm_core::worker::{AdmissionError, Client, Command, Pending, Response};
use tokio::sync::Notify;

#[tokio::test]
async fn ready_gate_survives_start_without_any_subscriber() {
    let fixture = support::retained_dir().unwrap();
    let broker = BrokerRuntime::start(BrokerConfig::new(fixture.path().join("data")))
        .await
        .unwrap();
    let gate = broker.gate();
    broker.shutdown().await.unwrap();
    assert_eq!(
        gate,
        GateState::Open,
        "Ready must persist for later clients"
    );
}

async fn owner_connection(broker: &BrokerRuntime, root: &Path) -> TypedConnection {
    let credential = ClientBootstrap::open(root)
        .unwrap()
        .load_owner_credential()
        .unwrap();
    TypedConnection::owner(
        OwnerClient::connect(broker.discovery(), &credential)
            .await
            .unwrap(),
    )
}

async fn admit(client: &Client, make: impl Fn() -> Command) -> Pending {
    loop {
        match client.submit(make()) {
            Ok(pending) => return pending,
            Err(AdmissionError::Contended) => tokio::task::yield_now().await,
            Err(error) => panic!("core admission: {error:?}"),
        }
    }
}

async fn poll_once<F: Future>(mut future: Pin<&mut F>) -> Poll<F::Output> {
    poll_fn(|cx| Poll::Ready(future.as_mut().poll(cx))).await
}

async fn reclaim(root: &Path) -> AuthorityClaim {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match AuthorityClaim::claim(root) {
                Ok(claim) => return claim,
                Err(AuthorityError::Busy) => tokio::time::sleep(Duration::from_millis(10)).await,
                Err(error) => panic!("reclaim: {error:?}"),
            }
        }
    })
    .await
    .expect("actual resource teardown releases the native authority")
}

#[tokio::test]
async fn native_claim_outlives_runtime_drop_while_sqlite_has_accepted_work() {
    let fixture = support::retained_dir().unwrap();
    let config = BrokerConfig::new(fixture.path().join("data"));
    let root = config.swarm_root();
    let broker = BrokerRuntime::start(config).await.unwrap();
    let client = broker.core_client();
    let owner = broker.owner_principal();
    let lock = rusqlite::Connection::open(root.join("state.sqlite")).unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
    let pending = admit(&client, || Command::Recover(owner.clone())).await;
    drop(broker);
    // Aborted accept futures can now drop; the real independent SQLite lock
    // still prevents accepted Recover from completing.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let still_owned = matches!(AuthorityClaim::claim(&root), Err(AuthorityError::Busy));
    let requests = client.metrics().requests;
    lock.execute_batch("ROLLBACK").unwrap();
    drop(lock);
    assert!(matches!(pending.await.unwrap(), Response::Recovered(_)));
    drop(reclaim(&root).await);
    assert_eq!(requests, 1);
    assert!(
        still_owned,
        "dropping the async broker must not release active SQLite authority"
    );
}

#[tokio::test]
async fn cancelling_shutdown_cannot_release_native_claim_before_sqlite_exit() {
    let fixture = support::retained_dir().unwrap();
    let config = BrokerConfig::new(fixture.path().join("data"));
    let root = config.swarm_root();
    let broker = BrokerRuntime::start(config).await.unwrap();
    let client = broker.core_client();
    let owner = broker.owner_principal();
    let lock = rusqlite::Connection::open(root.join("state.sqlite")).unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
    let pending = admit(&client, || Command::Recover(owner.clone())).await;
    let mut shutdown = Box::pin(broker.shutdown());
    assert!(poll_once(shutdown.as_mut()).await.is_pending());
    // Give the accept-task joins a chance to finish, then poll into worker
    // shutdown. The SQLite barrier guarantees that it cannot finish.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(poll_once(shutdown.as_mut()).await.is_pending());
    drop(shutdown);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let still_owned = matches!(AuthorityClaim::claim(&root), Err(AuthorityError::Busy));
    lock.execute_batch("ROLLBACK").unwrap();
    drop(lock);
    assert!(matches!(pending.await.unwrap(), Response::Recovered(_)));
    drop(reclaim(&root).await);
    assert!(
        still_owned,
        "cancelled shutdown must retain the claim until native exit"
    );
}

#[tokio::test]
async fn cancelling_start_keeps_claim_while_real_migration_is_blocked() {
    let fixture = support::retained_dir().unwrap();
    let config = BrokerConfig::new(fixture.path().join("data"));
    let root = config.swarm_root();
    std::fs::create_dir_all(&config.data_dir).unwrap();
    drop(AuthorityClaim::claim(&root).unwrap());
    let lock = rusqlite::Connection::open(root.join("state.sqlite")).unwrap();
    lock.pragma_update(None, "journal_mode", "WAL").unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
    let mut starting = Box::pin(BrokerRuntime::start(config));
    assert!(poll_once(starting.as_mut()).await.is_pending());
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(poll_once(starting.as_mut()).await.is_pending());
    drop(starting);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let still_owned = matches!(AuthorityClaim::claim(&root), Err(AuthorityError::Busy));
    lock.execute_batch("ROLLBACK").unwrap();
    drop(lock);
    drop(reclaim(&root).await);
    assert!(
        still_owned,
        "cancelled startup must retain the claim through Store::open"
    );
    assert!(
        !root.join("discovery.json").exists(),
        "cancelled startup never advertised Ready"
    );
}

#[tokio::test]
async fn competing_start_preserves_live_boot_and_durable_revisions() {
    let fixture = support::retained_dir().unwrap();
    let config = BrokerConfig::new(fixture.path().join("data"));
    let root = config.swarm_root();
    let restart_config = BrokerConfig::new(config.data_dir.clone());
    let broker = BrokerRuntime::start(config).await.unwrap();
    let mut owner = owner_connection(&broker, &root).await;
    let before = owner
        .call_owner(OwnerOperation::Revisions(Empty {}))
        .await
        .unwrap();
    let discovery = std::fs::read(root.join("discovery.json")).unwrap();
    assert!(matches!(
        BrokerRuntime::start(restart_config).await,
        Err(BrokerError::Busy)
    ));
    assert_eq!(
        std::fs::read(root.join("discovery.json")).unwrap(),
        discovery
    );
    let after = owner
        .call_owner(OwnerOperation::Revisions(Empty {}))
        .await
        .unwrap();
    assert_eq!(
        after, before,
        "competing startup must not recover a new run"
    );
    assert!(
        matches!(owner.call_owner(OwnerOperation::Health(Empty {})).await.unwrap(), Outcome::Health(health) if health.boot_id == broker.boot_id())
    );
    drop(owner);
    broker.shutdown().await.unwrap();
}

#[tokio::test]
async fn failed_bind_and_publication_release_only_owned_endpoints_and_preserve_discovery() {
    for fail_publication in [false, true] {
        let fixture = support::retained_dir().unwrap();
        let mut config = BrokerConfig::new(fixture.path().join("data"));
        let root = config.swarm_root();
        std::fs::create_dir_all(&config.data_dir).unwrap();
        let claim = AuthorityClaim::claim(&root).unwrap();
        let suffix = LaunchId::generate();
        let owner_name = format!(r"\\.\pipe\owned-start-owner-{}", suffix.as_str());
        let peer_name = format!(r"\\.\pipe\owned-start-peer-{}", suffix.as_str());
        let old = DiscoveryRecord::new(
            "retained-authority",
            "retained-old-boot",
            VerifiedProcess::open(std::process::id())
                .unwrap()
                .identity(),
            &owner_name,
            &peer_name,
        );
        claim.publish_discovery(&old).unwrap();
        if fail_publication {
            std::fs::write(
                root.join("discovery.json"),
                b"{retained malformed discovery",
            )
            .unwrap();
        }
        let before = std::fs::read(root.join("discovery.json")).unwrap();
        drop(claim);
        let blocker = if fail_publication {
            None
        } else {
            Some(PipeServer::bind(&peer_name, FrameBudget::new(1024 * 1024)).unwrap())
        };
        config.owner_pipe_name = Some(owner_name.clone());
        config.peer_pipe_name = Some(peer_name.clone());
        let result = BrokerRuntime::start(config).await;
        if fail_publication {
            assert!(matches!(
                result,
                Err(BrokerError::Publish(AuthorityError::InvalidDiscovery))
            ));
        } else {
            assert!(matches!(
                result,
                Err(BrokerError::Bind {
                    endpoint: "peer",
                    ..
                })
            ));
        }
        drop(reclaim(&root).await);
        assert_eq!(std::fs::read(root.join("discovery.json")).unwrap(), before);
        let released_owner = PipeServer::bind(&owner_name, FrameBudget::new(1024 * 1024)).unwrap();
        if blocker.is_some() {
            assert!(
                PipeServer::bind(&peer_name, FrameBudget::new(1024 * 1024)).is_err(),
                "preexisting peer listener must remain owned by this fixture"
            );
        }
        drop(released_owner);
        drop(blocker);
        drop(PipeServer::bind(&peer_name, FrameBudget::new(1024 * 1024)).unwrap());
    }
}

struct HeldEventOutput {
    entered: Notify,
    released: tokio::sync::watch::Sender<bool>,
}

impl OutputObserver for HeldEventOutput {
    fn before_write(
        &self,
        kind: OutputKind,
        _encoded_bytes: usize,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            if kind != OutputKind::Event {
                return;
            }
            let mut release = self.released.subscribe();
            self.entered.notify_one();
            while !*release.borrow_and_update() {
                if release.changed().await.is_err() {
                    break;
                }
            }
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn held_event_output_reports_overflow_keeps_idle_requests_alive_and_reconnects_new_boot() {
    let fixture = support::retained_dir().unwrap();
    let observer = Arc::new(HeldEventOutput {
        entered: Notify::new(),
        released: tokio::sync::watch::channel(false).0,
    });
    let mut config =
        BrokerConfig::new(fixture.path().join("data")).with_output_observer(observer.clone());
    config.event_capacity = 2;
    let root = config.swarm_root();
    let restart_config = BrokerConfig::new(config.data_dir.clone());
    let broker = BrokerRuntime::start(config).await.unwrap();
    let old_boot = broker.boot_id().to_owned();
    let authority = broker.authority_id().to_owned();
    let mut subscriber = owner_connection(&broker, &root).await;
    let mut mutator = owner_connection(&broker, &root).await;
    let Outcome::Subscribed(initial) = subscriber
        .call_owner(OwnerOperation::Subscribe(Empty {}))
        .await
        .unwrap()
    else {
        panic!("subscribe response");
    };
    for index in 0..6 {
        assert!(matches!(
            mutator
                .call_owner(OwnerOperation::CreateGroup {
                    label: format!("retained-event-{index}"),
                    members: Default::default()
                })
                .await
                .unwrap(),
            Outcome::Group(_)
        ));
        if index == 0 {
            tokio::time::timeout(Duration::from_secs(5), observer.entered.notified())
                .await
                .expect("encoded event is held before actual write");
        }
    }
    let Outcome::Revisions(latest) = mutator
        .call_owner(OwnerOperation::Revisions(Empty {}))
        .await
        .unwrap()
    else {
        panic!("revision response");
    };
    assert!(latest.inventory_revision.get() > initial.inventory_revision.get());
    observer.released.send_replace(true);
    let first = tokio::time::timeout(Duration::from_secs(5), subscriber.next_event())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(first, EventBody::Revisions(ref value) if value.boot_id == old_boot));
    let overflow = tokio::time::timeout(Duration::from_secs(5), subscriber.next_event())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(overflow, EventBody::Overflow { ref boot_id, skipped } if boot_id == &old_boot && skipped.get() == 3)
    );
    for _ in 0..2 {
        let _ = tokio::time::timeout(Duration::from_secs(5), subscriber.next_event())
            .await
            .unwrap()
            .unwrap();
    }
    // Server-side idle input survived multiple event wakeups; the next actual
    // request and the authorized replacement snapshot must both succeed.
    assert!(matches!(
        subscriber
            .call_owner(OwnerOperation::Health(Empty {}))
            .await
            .unwrap(),
        Outcome::Health(_)
    ));
    let snapshot = subscriber
        .call_owner(OwnerOperation::Snapshot(SnapshotParams::Groups {
            expected_inventory_revision: None,
            after_group: None,
            max_items: 64,
        }))
        .await
        .unwrap();
    assert!(
        matches!(snapshot, Outcome::Snapshot(termx_swarm_core::model::OwnerSnapshotPage::Groups(page)) if page.groups.len() == 6)
    );
    drop(subscriber);
    drop(mutator);
    broker.shutdown().await.unwrap();
    let restarted = BrokerRuntime::start(restart_config).await.unwrap();
    assert_ne!(restarted.boot_id(), old_boot);
    assert_eq!(restarted.authority_id(), authority);
    let mut connection = owner_connection(&restarted, &root).await;
    let Outcome::Subscribed(new) = connection
        .call_owner(OwnerOperation::Subscribe(Empty {}))
        .await
        .unwrap()
    else {
        panic!("new subscribe");
    };
    assert_eq!(new.boot_id, restarted.boot_id());
    assert_ne!(new.run_revision, initial.run_revision);
    drop(connection);
    restarted.shutdown().await.unwrap();
}

#[tokio::test]
async fn startup_refresh_rebases_its_own_metadata_updates_between_pages() {
    let fixture = support::retained_dir().unwrap();
    let config = BrokerConfig::new(fixture.path().join("data"));
    let root = config.swarm_root();
    std::fs::create_dir_all(&config.data_dir).unwrap();
    drop(AuthorityClaim::claim(&root).unwrap());
    let database = root.join("state.sqlite");
    let mut store = termx_swarm_core::store::Store::open(&database).unwrap();
    let owner = store.trusted_owner();
    let identity = VerifiedProcess::open(std::process::id())
        .unwrap()
        .identity();
    let mut checked = 0;
    let mut stale = 0;
    for index in 0..130 {
        let live = index % 3 != 0;
        let correct_generation = index % 2 == 0;
        checked += usize::from(live);
        stale += usize::from(live && !correct_generation);
        let binding = VerifiedBinding::trusted(
            LaunchId::generate().as_str().into(),
            format!("retained-{index}"),
            "synthetic".into(),
            format!("retained-conversation-{index}"),
            None,
            identity.pid,
            identity.creation_filetime.get() + u64::from(!correct_generation),
            live,
        )
        .unwrap();
        store.enroll_peer(&owner, binding).unwrap();
    }
    drop(store);
    let broker = BrokerRuntime::start(config).await.unwrap();
    let report = broker.report();
    broker.shutdown().await.unwrap();
    let check = rusqlite::Connection::open(&database).unwrap();
    let live: i64 = check
        .query_row(
            "SELECT count(*) FROM peer_bindings WHERE live=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(report.live_bindings_checked, checked);
    assert_eq!(report.bindings_marked_offline, stale);
    assert_eq!(live, i64::try_from(checked - stale).unwrap());
}

/// Explicit long-history regression: the old startup stopped successfully at
/// 4,096 pages even when its continuation named more persisted peers. Run with
/// `cargo test -p termx-host --test swarm_runtime_owned startup_refresh_has_no_history_cutoff -- --ignored`.
#[tokio::test]
#[ignore = "large retained 262145-peer fixture; run explicitly for startup-history validation"]
async fn startup_refresh_has_no_history_cutoff() {
    const COUNT: usize = 4096 * 64 + 1;
    let fixture = support::retained_dir().unwrap();
    let config = BrokerConfig::new(fixture.path().join("data"));
    let root = config.swarm_root();
    std::fs::create_dir_all(&config.data_dir).unwrap();
    drop(AuthorityClaim::claim(&root).unwrap());
    let database = root.join("state.sqlite");
    drop(termx_swarm_core::store::Store::open(&database).unwrap());
    let identity = VerifiedProcess::open(std::process::id())
        .unwrap()
        .identity();
    let started = std::time::Instant::now();
    let mut seed = rusqlite::Connection::open(&database).unwrap();
    seed.pragma_update(None, "foreign_keys", "ON").unwrap();
    let transaction = seed.transaction().unwrap();
    {
        let mut peer = transaction
            .prepare("INSERT INTO peers VALUES(?1,1,1)")
            .unwrap();
        let mut binding = transaction.prepare(
            "INSERT INTO peer_bindings(peer_id,binding_revision,launch_id,terminal_id,harness,conversation_id,model_metadata_json,process_id,process_creation_filetime,live,bound_at_millis) VALUES(?1,1,?2,'retained-terminal','synthetic','retained-conversation',NULL,?3,?4,?5,1)"
        ).unwrap();
        for index in 1..=COUNT {
            let peer_id = format!("p_{index:032x}");
            peer.execute([&peer_id]).unwrap();
            // Only the final peer needs native verification. Its PID is ours,
            // but the deliberately different creation time must be offline.
            binding
                .execute(rusqlite::params![
                    peer_id,
                    format!("l_{index:032x}"),
                    identity.pid,
                    i64::try_from(identity.creation_filetime.get() + 1).unwrap(),
                    index == COUNT,
                ])
                .unwrap();
        }
    }
    transaction.commit().unwrap();
    drop(seed);
    let broker = tokio::time::timeout(Duration::from_secs(180), BrokerRuntime::start(config))
        .await
        .expect("bounded fixture startup")
        .unwrap();
    let report = broker.report();
    broker.shutdown().await.unwrap();
    let check = rusqlite::Connection::open(&database).unwrap();
    let live: i64 = check
        .query_row(
            "SELECT count(*) FROM peer_bindings WHERE live=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let count: i64 = check
        .query_row("SELECT count(*) FROM peers", [], |row| row.get(0))
        .unwrap();
    let integrity: String = check
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .unwrap();
    std::fs::write(fixture.path().join("startup-history-result.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "seeded_peers": COUNT, "retained_peers": count, "remaining_live": live,
        "checked": report.live_bindings_checked, "marked_offline": report.bindings_marked_offline,
        "elapsed_millis": started.elapsed().as_millis(), "database_bytes": std::fs::metadata(&database).unwrap().len(),
        "integrity": integrity,
    })).unwrap()).unwrap();
    assert_eq!(count, i64::try_from(COUNT).unwrap());
    assert_eq!(integrity, "ok");
    assert_eq!(
        report.live_bindings_checked, 1,
        "startup must reach the last continuation before Ready"
    );
    assert_eq!(report.bindings_marked_offline, 1);
    assert_eq!(live, 0);
}

async fn peer_source(broker: &BrokerRuntime) -> (TypedConnection, GroupId, SourceId) {
    let identity = VerifiedProcess::open(std::process::id())
        .unwrap()
        .identity();
    let binding = VerifiedBinding::trusted(
        LaunchId::generate().as_str().into(),
        "owned-test-terminal".into(),
        "synthetic".into(),
        "owned-test-conversation".into(),
        None,
        identity.pid,
        identity.creation_filetime.get(),
        true,
    )
    .unwrap();
    let enrolled = broker
        .enroll_trusted_binding(identity, binding)
        .await
        .unwrap();
    let client = broker.core_client();
    let group = loop {
        match client.submit(Command::CreateGroup(
            broker.owner_principal(),
            "owned-source-group".into(),
            [enrolled.record.peer_id.clone()].into(),
        )) {
            Ok(pending) => break pending.await.unwrap(),
            Err(AdmissionError::Contended) => tokio::task::yield_now().await,
            Err(error) => panic!("group admission: {error:?}"),
        }
    };
    let Response::Group(group) = group else {
        panic!("group response")
    };
    let descriptor = VerifiedSourceDescriptor::trusted(
        enrolled.record.peer_id.clone(),
        enrolled.record.revision,
        enrolled.record.conversation_id,
        "synthetic".into(),
        "owned-synthetic-resolver-key".into(),
        "owned-synthetic-object".into(),
        "owned-synthetic-evidence".into(),
    )
    .unwrap();
    let source = broker.register_trusted_source(descriptor).await.unwrap();
    let connection = PeerClient::connect(broker.discovery()).await.unwrap();
    (
        TypedConnection::peer(connection),
        group.group_id,
        source.source_id,
    )
}

struct HeldSource {
    body: Option<Vec<u8>>,
    entered: Notify,
    released: tokio::sync::watch::Sender<bool>,
    active: AtomicUsize,
    dropped: AtomicUsize,
}

impl Default for HeldSource {
    fn default() -> Self {
        Self {
            body: None,
            entered: Notify::new(),
            released: tokio::sync::watch::channel(false).0,
            active: AtomicUsize::new(0),
            dropped: AtomicUsize::new(0),
        }
    }
}

impl HeldSource {
    fn release(&self) {
        self.released.send_replace(true);
    }
}

struct ActiveSource<'a>(&'a HeldSource);
impl Drop for ActiveSource<'_> {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
        self.0.dropped.fetch_add(1, Ordering::SeqCst);
    }
}

impl SourceReader for HeldSource {
    fn read<'a>(&'a self, _lease: &'a ContextGrantLease) -> SourceReadFuture<'a> {
        Box::pin(async {
            self.active.fetch_add(1, Ordering::SeqCst);
            let _active = ActiveSource(self);
            let mut released = self.released.subscribe();
            self.entered.notify_one();
            while !*released.borrow_and_update() {
                if released.changed().await.is_err() {
                    break;
                }
            }
            match &self.body {
                Some(body) => Ok(SourceSnapshot {
                    snapshot_identity: "owned-revocation-snapshot".into(),
                    captured_through: Some(body.len() as u64),
                    body: body.clone(),
                }),
                None => Err(SourceReadError::Unavailable("fixture released")),
            }
        })
    }
}

struct ReleaseSource(Arc<HeldSource>);
impl Drop for ReleaseSource {
    fn drop(&mut self) {
        self.0.release();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn source_deadline_answers_while_the_source_is_still_held() {
    let fixture = support::retained_dir().unwrap();
    let source = Arc::new(HeldSource::default());
    let _release = ReleaseSource(source.clone());
    let mut config =
        BrokerConfig::new(fixture.path().join("data")).with_source_reader(source.clone());
    config.source_read_timeout = Duration::from_millis(30);
    let broker = BrokerRuntime::start(config).await.unwrap();
    let (mut connection, group_id, source_id) = peer_source(&broker).await;
    let mut request = tokio::spawn(async move {
        connection
            .call_peer(PeerOperation::FetchContext {
                group_id,
                source_id,
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), source.entered.notified())
        .await
        .unwrap();
    let early = tokio::time::timeout(Duration::from_millis(500), &mut request).await;
    let answered_before_release = early.is_ok();
    let still_active = source.active.load(Ordering::SeqCst);
    let occupied_slots = broker.active_source_reads();
    source.release();
    let outcome = match early {
        Ok(result) => result.unwrap().unwrap(),
        Err(_) => tokio::time::timeout(Duration::from_secs(5), request)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
    };
    broker.shutdown().await.unwrap();
    let Outcome::Error(error) = outcome else {
        panic!("source error expected")
    };
    assert!(error.message.contains("deadline"));
    assert!(
        answered_before_release,
        "source timeout must answer without waiting for blocked work"
    );
    assert_eq!(
        still_active, 0,
        "expired future must have dropped its owned work"
    );
    assert_eq!(
        occupied_slots, 0,
        "expired source must release its exact slot"
    );
    assert_eq!(source.dropped.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn held_sources_are_bounded_allow_other_clients_and_cancel_on_shutdown() {
    let fixture = support::retained_dir().unwrap();
    let source = Arc::new(HeldSource::default());
    let _release = ReleaseSource(source.clone());
    let mut config =
        BrokerConfig::new(fixture.path().join("data")).with_source_reader(source.clone());
    config.source_read_timeout = Duration::from_secs(30);
    let root = config.swarm_root();
    let broker = BrokerRuntime::start(config).await.unwrap();
    let (first, group_id, source_id) = peer_source(&broker).await;
    let second = TypedConnection::peer(PeerClient::connect(broker.discovery()).await.unwrap());
    let mut third = TypedConnection::peer(PeerClient::connect(broker.discovery()).await.unwrap());
    let mut requests = Vec::new();
    for mut connection in [first, second] {
        let operation = PeerOperation::FetchContext {
            group_id: group_id.clone(),
            source_id: source_id.clone(),
        };
        requests.push(tokio::spawn(async move {
            connection.call_peer(operation).await
        }));
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        while source.active.load(Ordering::SeqCst) != 2 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("both actual sources entered");
    assert_eq!(broker.active_source_reads(), 2);
    let excess = tokio::time::timeout(
        Duration::from_secs(2),
        third.call_peer(PeerOperation::FetchContext {
            group_id,
            source_id,
        }),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(matches!(excess, Outcome::Error(ref error) if error.message.contains("capacity")));
    let mut owner = owner_connection(&broker, &root).await;
    let health = tokio::time::timeout(
        Duration::from_secs(2),
        owner.call_owner(OwnerOperation::Health(Empty {})),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(matches!(health, Outcome::Health(ref health) if health.gate_open));
    drop(owner);
    drop(third);
    tokio::time::timeout(Duration::from_secs(5), broker.shutdown())
        .await
        .unwrap()
        .unwrap();
    // The source's manual release is deliberately still false here. Shutdown
    // must own cancellation, including the source future and its slot.
    assert!(!*source.released.borrow());
    assert_eq!(source.active.load(Ordering::SeqCst), 0);
    assert_eq!(source.dropped.load(Ordering::SeqCst), 2);
    for request in requests {
        let _ = tokio::time::timeout(Duration::from_secs(5), request)
            .await
            .unwrap()
            .unwrap();
    }
    drop(reclaim(&root).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permission_changes_during_source_read_never_publish_or_commit_body() {
    for revoke in ["pause", "remove", "offline", "withdraw", "continue"] {
        let fixture = support::retained_dir().unwrap();
        let source = Arc::new(HeldSource {
            body: Some(b"owned fixture content denied after revocation".to_vec()),
            ..HeldSource::default()
        });
        let _release = ReleaseSource(source.clone());
        let config =
            BrokerConfig::new(fixture.path().join("data")).with_source_reader(source.clone());
        let root = config.swarm_root();
        let broker = BrokerRuntime::start(config).await.unwrap();
        let (mut peer, group_id, source_id) = peer_source(&broker).await;
        let Outcome::SelfView(view) = peer
            .call_peer(PeerOperation::WhoAmI {
                after_group: None,
                max_items: 16,
            })
            .await
            .unwrap()
        else {
            panic!("self view")
        };
        let mut owner = owner_connection(&broker, &root).await;
        let Outcome::Snapshot(OwnerSnapshotPage::PeerSources(sources)) = owner
            .call_owner(OwnerOperation::Snapshot(SnapshotParams::PeerSources {
                peer_id: view.peer_id.clone(),
                expected_inventory_revision: None,
                after_source: None,
                max_items: 16,
            }))
            .await
            .unwrap()
        else {
            panic!("source inventory")
        };
        let Outcome::Snapshot(OwnerSnapshotPage::Peers(peers)) = owner
            .call_owner(OwnerOperation::Snapshot(SnapshotParams::Peers {
                expected_inventory_revision: None,
                after_peer: None,
                max_items: 16,
            }))
            .await
            .unwrap()
        else {
            panic!("peer inventory")
        };
        let predecessor = &peers
            .peers
            .iter()
            .find(|p| p.binding.peer_id == view.peer_id)
            .unwrap()
            .binding;
        let registration = sources
            .sources
            .iter()
            .find(|s| s.source_id == source_id)
            .unwrap();
        let operation = PeerOperation::FetchContext {
            group_id: group_id.clone(),
            source_id: source_id.clone(),
        };
        let request = tokio::spawn(async move { peer.call_peer(operation).await });
        tokio::time::timeout(Duration::from_secs(5), source.entered.notified())
            .await
            .unwrap();
        let expected_policy_revision = DecimalU64::new(view.memberships[0].policy_revision.get());
        let revoked = match revoke {
            "pause" => owner
                .call_owner(OwnerOperation::Pause {
                    group_id: group_id.clone(),
                    paused: true,
                    expected_policy_revision,
                })
                .await
                .unwrap(),
            "remove" => owner
                .call_owner(OwnerOperation::Membership {
                    group_id: group_id.clone(),
                    peer_id: view.peer_id.clone(),
                    active: false,
                    expected_policy_revision,
                })
                .await
                .unwrap(),
            "offline" => owner
                .call_owner(OwnerOperation::UpdatePeer {
                    peer_id: view.peer_id.clone(),
                    expected_binding_revision: DecimalU64::new(view.binding_revision.get()),
                    model_metadata: None,
                    is_live: false,
                })
                .await
                .unwrap(),
            "continue" => {
                let identity = VerifiedProcess::open(std::process::id())
                    .unwrap()
                    .identity();
                let client = broker.core_client();
                let response = admit(&client, || {
                    Command::Continue(
                        broker.owner_principal(),
                        VerifiedContinuation::trusted(
                            predecessor,
                            VerifiedBinding::trusted(
                                LaunchId::generate().as_str().into(),
                                "owned-continuation-terminal".into(),
                                predecessor.harness.clone(),
                                predecessor.conversation_id.clone(),
                                None,
                                identity.pid,
                                identity.creation_filetime.get(),
                                true,
                            )
                            .unwrap(),
                            "owned-fixture-same-branch".into(),
                        )
                        .unwrap(),
                        "explicit owned fixture continuation".into(),
                        view.memberships
                            .iter()
                            .map(|m| (m.group_id.clone(), m.policy_revision))
                            .collect(),
                    )
                })
                .await
                .await
                .unwrap();
                assert!(matches!(response, Response::Enrolled(_)));
                Outcome::Unit(Empty {})
            }
            "withdraw" => {
                let client = broker.core_client();
                let response = admit(&client, || {
                    Command::TransitionSource(
                        broker.owner_principal(),
                        SourceTransition::Withdraw {
                            source_id: source_id.clone(),
                            expected_epoch: registration.registration_epoch,
                        },
                    )
                })
                .await
                .await
                .unwrap();
                assert!(matches!(response, Response::Source(_)));
                Outcome::Unit(Empty {})
            }
            _ => unreachable!(),
        };
        assert!(revoked.error().is_none(), "{revoke}: {revoked:?}");
        source.release();
        let outcome = tokio::time::timeout(Duration::from_secs(5), request)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let Outcome::Error(error) = outcome else {
            panic!("{revoke} exposed context: {outcome:?}")
        };
        let expected = match revoke {
            "pause" => ErrorCode::GroupPaused,
            "remove" => ErrorCode::Unauthorized,
            "offline" => ErrorCode::BindingOffline,
            "withdraw" => ErrorCode::SourceUnavailable,
            "continue" => ErrorCode::StaleBinding,
            _ => unreachable!(),
        };
        assert_eq!(
            error.code, expected,
            "{revoke}: final policy validation must reject"
        );
        if revoke == "withdraw" {
            assert!(error.message.contains("registration changed"));
        }
        assert_eq!(source.dropped.load(Ordering::SeqCst), 1);
        assert_eq!(broker.active_source_reads(), 0);
        drop(owner);
        broker.shutdown().await.unwrap();
        let database = rusqlite::Connection::open(root.join("state.sqlite")).unwrap();
        let commitments: i64 = database
            .query_row("SELECT count(*) FROM publication_commitments", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(commitments, 0, "{revoke}: no final publication commitment");
    }
}

#[tokio::test]
async fn native_endpoints_and_rpc_shapes_never_promote_an_unenrolled_peer() {
    let fixture = support::retained_dir().unwrap();
    let config = BrokerConfig::new(fixture.path().join("data"));
    let root = config.swarm_root();
    let broker = BrokerRuntime::start(config).await.unwrap();
    let mut owner = owner_connection(&broker, &root).await;
    let before = owner
        .call_owner(OwnerOperation::Revisions(Empty {}))
        .await
        .unwrap();
    let credential = ClientBootstrap::open(&root)
        .unwrap()
        .load_owner_credential()
        .unwrap();
    let mut swapped = broker.discovery().clone();
    std::mem::swap(&mut swapped.owner_pipe_name, &mut swapped.peer_pipe_name);
    assert!(tokio::time::timeout(
        Duration::from_secs(5),
        OwnerClient::connect(&swapped, &credential)
    )
    .await
    .unwrap()
    .is_err());
    // The peer hello verifies only the broker boot. The owner endpoint must
    // reject the next non-owner-auth frame before any domain dispatch.
    let wrong_endpoint =
        tokio::time::timeout(Duration::from_secs(5), PeerClient::connect(&swapped))
            .await
            .unwrap();
    if let Ok(connection) = wrong_endpoint {
        let mut wrong_endpoint = TypedConnection::peer(connection);
        assert!(tokio::time::timeout(
            Duration::from_secs(5),
            wrong_endpoint.call_peer(PeerOperation::WhoAmI {
                after_group: None,
                max_items: 16,
            })
        )
        .await
        .unwrap()
        .is_err());
    }
    let mut peer = TypedConnection::peer(PeerClient::connect(broker.discovery()).await.unwrap());
    let outcome = peer
        .call_peer(PeerOperation::WhoAmI {
            after_group: None,
            max_items: 16,
        })
        .await
        .unwrap();
    assert!(
        matches!(outcome, Outcome::Error(ref error) if error.message.contains("not an enrolled peer"))
    );
    let owner_request = OwnerRequest {
        version: SWARM_RPC_VERSION,
        correlation_id: "fake-owner".into(),
        operation: OwnerOperation::Revisions(Empty {}),
    };
    let outcome = peer
        .call_raw(&serde_json::to_vec(&owner_request).unwrap(), "malformed")
        .await
        .unwrap();
    assert!(
        matches!(outcome, Outcome::Error(ref error) if error.code == ErrorCode::InvalidRequest)
    );
    let request = PeerRequest {
        version: SWARM_RPC_VERSION,
        correlation_id: "fake-identity".into(),
        operation: PeerOperation::WhoAmI {
            after_group: None,
            max_items: 16,
        },
    };
    for field in ["role", "senderPid", "principal", "owner"] {
        let mut value = serde_json::to_value(&request).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert(field.into(), serde_json::json!("owner"));
        let outcome = peer
            .call_raw(&serde_json::to_vec(&value).unwrap(), "malformed")
            .await
            .unwrap();
        assert!(
            matches!(outcome, Outcome::Error(ref error) if error.code == ErrorCode::InvalidRequest),
            "{field}"
        );
    }
    let after = owner
        .call_owner(OwnerOperation::Revisions(Empty {}))
        .await
        .unwrap();
    assert_eq!(
        after, before,
        "rejected identity claims have no durable effects"
    );
    assert!(matches!(
        owner
            .call_owner(OwnerOperation::Health(Empty {}))
            .await
            .unwrap(),
        Outcome::Health(_)
    ));
    drop(peer);
    drop(owner);
    broker.shutdown().await.unwrap();
}
