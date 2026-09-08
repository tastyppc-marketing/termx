//! Focused RPC/output ownership regressions using retained synthetic fixtures.

#![cfg(windows)]

mod support;

use std::collections::BTreeSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use termx_host::swarm::rpc::{
    Empty, ErrorCode, Outcome, OwnerOperation, OwnerRequest, PeerOperation, PeerRequest,
    ServerMessage, SnapshotParams, TypedConnection, MAX_REQUEST_FRAME_BYTES, SWARM_RPC_VERSION,
};
use termx_host::swarm::runtime::{
    BrokerConfig, BrokerRuntime, OutputKind, OutputObserver, SourceReadFuture, SourceReader,
    SourceSnapshot,
};
use termx_swarm_client::{ClientBootstrap, OwnerClient, PeerClient, VerifiedProcess};
use termx_swarm_core::model::{
    ContextGrantLease, GroupId, LaunchId, OwnerSnapshotPage, OwnerSnapshotRequest,
    PublicationCommitment, SourceId, VerifiedBinding, VerifiedSourceDescriptor,
    MAX_PUBLICATION_BYTES,
};
use termx_swarm_core::worker::{AdmissionError, Client, Command, Response};

static RPC_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn submit(client: &Client, make: impl Fn() -> Command) -> Response {
    loop {
        match client.submit(make()) {
            Ok(pending) => return pending.await.unwrap(),
            Err(AdmissionError::Contended) => tokio::task::yield_now().await,
            Err(error) => panic!("core admission: {error:?}"),
        }
    }
}

struct CommitBarrierSource {
    body: Arc<[u8]>,
    committed: tokio::sync::Notify,
    release_commit: tokio::sync::watch::Sender<bool>,
    commit_released: tokio::sync::Notify,
    observations: AtomicUsize,
}

impl CommitBarrierSource {
    fn new(body: Vec<u8>) -> Self {
        Self {
            body: body.into(),
            committed: tokio::sync::Notify::new(),
            release_commit: tokio::sync::watch::channel(false).0,
            commit_released: tokio::sync::Notify::new(),
            observations: AtomicUsize::new(0),
        }
    }

    fn release(&self) {
        self.release_commit.send_replace(true);
    }
}

impl SourceReader for CommitBarrierSource {
    fn read<'a>(&'a self, _lease: &'a ContextGrantLease) -> SourceReadFuture<'a> {
        Box::pin(async {
            Ok(SourceSnapshot {
                snapshot_identity: "owned-commit-barrier-snapshot".into(),
                captured_through: Some(41),
                body: self.body.to_vec(),
            })
        })
    }

    fn observe_commit<'a>(
        &'a self,
        _record: &'a PublicationCommitment,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async {
            self.observations.fetch_add(1, Ordering::SeqCst);
            let mut released = self.release_commit.subscribe();
            self.committed.notify_one();
            while !*released.borrow_and_update() {
                if released.changed().await.is_err() {
                    break;
                }
            }
            self.commit_released.notify_one();
        })
    }
}

struct OutputBarrier {
    kind: OutputKind,
    entered: tokio::sync::Notify,
    release_write: tokio::sync::watch::Sender<bool>,
    observations: AtomicUsize,
    encoded_bytes: AtomicUsize,
}

impl OutputBarrier {
    fn new(kind: OutputKind) -> Self {
        Self {
            kind,
            entered: tokio::sync::Notify::new(),
            release_write: tokio::sync::watch::channel(false).0,
            observations: AtomicUsize::new(0),
            encoded_bytes: AtomicUsize::new(0),
        }
    }

    fn release(&self) {
        self.release_write.send_replace(true);
    }
}

impl OutputObserver for OutputBarrier {
    fn before_write(
        &self,
        kind: OutputKind,
        encoded_bytes: usize,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            if kind != self.kind {
                return;
            }
            let mut released = self.release_write.subscribe();
            self.encoded_bytes.store(encoded_bytes, Ordering::SeqCst);
            self.observations.fetch_add(1, Ordering::SeqCst);
            self.entered.notify_one();
            while !*released.borrow_and_update() {
                if released.changed().await.is_err() {
                    break;
                }
            }
        })
    }
}

struct HeldSource {
    entered: tokio::sync::Notify,
    calls: AtomicUsize,
    cancelled: Arc<AtomicUsize>,
}

impl HeldSource {
    fn new() -> Self {
        Self {
            entered: tokio::sync::Notify::new(),
            calls: AtomicUsize::new(0),
            cancelled: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl SourceReader for HeldSource {
    fn read<'a>(&'a self, _lease: &'a ContextGrantLease) -> SourceReadFuture<'a> {
        struct Cancelled(Arc<AtomicUsize>);
        impl Drop for Cancelled {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }

        Box::pin(async move {
            let _cancelled = Cancelled(self.cancelled.clone());
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.entered.notify_one();
            std::future::pending().await
        })
    }
}

struct OversizedCapacitySource;

impl SourceReader for OversizedCapacitySource {
    fn read<'a>(&'a self, _lease: &'a ContextGrantLease) -> SourceReadFuture<'a> {
        Box::pin(async {
            let mut body = Vec::with_capacity(MAX_PUBLICATION_BYTES + 1);
            body.push(b'x');
            Ok(SourceSnapshot {
                snapshot_identity: "oversized-capacity-snapshot".into(),
                captured_through: Some(1),
                body,
            })
        })
    }
}

async fn peer_source(
    broker: &BrokerRuntime,
) -> (
    TypedConnection,
    GroupId,
    SourceId,
    termx_swarm_core::model::PeerId,
    termx_swarm_core::model::Revision,
) {
    let identity = VerifiedProcess::open(std::process::id())
        .unwrap()
        .identity();
    let binding = VerifiedBinding::trusted(
        LaunchId::generate().as_str().into(),
        "rpc-publication-terminal".into(),
        "synthetic".into(),
        "rpc-publication-conversation".into(),
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
    let peer_id = enrolled.record.peer_id.clone();
    let response = submit(&broker.core_client(), || {
        Command::CreateGroup(
            broker.owner_principal(),
            "publication group".into(),
            BTreeSet::from([peer_id.clone()]),
        )
    })
    .await;
    let Response::Group(group) = response else {
        panic!("group response")
    };
    let descriptor = VerifiedSourceDescriptor::trusted(
        peer_id.clone(),
        enrolled.record.revision,
        enrolled.record.conversation_id,
        "synthetic".into(),
        "owned-publication-resolver".into(),
        "owned-publication-object".into(),
        "owned-publication-evidence".into(),
    )
    .unwrap();
    let source = broker.register_trusted_source(descriptor).await.unwrap();
    let connection = TypedConnection::peer(PeerClient::connect(broker.discovery()).await.unwrap());
    (
        connection,
        group.group_id,
        source.source_id,
        peer_id,
        group.policy_revision,
    )
}

async fn owner_connection(broker: &BrokerRuntime, root: &std::path::Path) -> TypedConnection {
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn output_refusal_happens_before_the_send_side_effect() {
    let _test = RPC_TEST_LOCK.lock().await;
    let fixture = support::retained_dir().unwrap();
    let mut config = BrokerConfig::new(fixture.path().join("data"));
    config.output_budget_bytes = 1024 * 1024;
    config.output_headroom_bytes = 256 * 1024;
    let broker = BrokerRuntime::start(config).await.unwrap();

    let identity = VerifiedProcess::open(std::process::id())
        .unwrap()
        .identity();
    let binding = VerifiedBinding::trusted(
        LaunchId::generate().as_str().into(),
        "rpc-output-terminal".into(),
        "synthetic".into(),
        "rpc-output-conversation".into(),
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
    let peer_id = enrolled.record.peer_id.clone();
    let core = broker.core_client();
    let owner = broker.owner_principal();
    let group = submit(&core, || {
        Command::CreateGroup(
            owner.clone(),
            "output refusal".into(),
            BTreeSet::from([peer_id.clone()]),
        )
    })
    .await;
    let Response::Group(group) = group else {
        panic!("group response")
    };

    let mut peer = TypedConnection::peer(PeerClient::connect(broker.discovery()).await.unwrap());
    let outcome = peer
        .call_peer(PeerOperation::Send {
            group_id: group.group_id.clone(),
            client_key: "must-not-commit".into(),
            recipients: BTreeSet::from([peer_id]),
            body: "side effect sentinel".into(),
            topic: None,
            reply_to: None,
            attachments: Vec::new(),
        })
        .await
        .unwrap();
    let Outcome::Error(error) = outcome else {
        panic!("capacity refusal expected")
    };
    assert_eq!(error.code, ErrorCode::Admission);
    assert!(error.message.contains("not dispatched"));

    let page = submit(&core, || {
        Command::OwnerSnapshot(
            owner.clone(),
            OwnerSnapshotRequest::Messages {
                group_id: group.group_id.clone(),
                after_sequence: 0,
                through_sequence: None,
                max_items: 1,
            },
        )
    })
    .await;
    let Response::Snapshot(OwnerSnapshotPage::Messages(page)) = page else {
        panic!("owner message page")
    };
    assert!(
        page.messages.is_empty(),
        "refused send reached durable storage"
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        while broker.output_usage() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(broker.output_rejected() >= 1);
    std::fs::write(
        fixture.path().join("result.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "case": "output-refusal-before-send",
            "errorCode": "admission",
            "durableMessages": page.messages.len(),
            "outputHighWater": broker.output_high_water(),
            "outputRejected": broker.output_rejected(),
            "outputUsageAfterReply": broker.output_usage(),
        }))
        .unwrap(),
    )
    .unwrap();
    broker.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn source_allocation_is_admitted_before_read_and_gate_cancellation_releases_it() {
    let _test = RPC_TEST_LOCK.lock().await;
    let fixture = support::retained_dir().unwrap();
    let source = Arc::new(HeldSource::new());
    let sample_request = PeerRequest {
        version: SWARM_RPC_VERSION,
        correlation_id: "c-held-source".into(),
        operation: PeerOperation::FetchContext {
            group_id: GroupId::generate(),
            source_id: SourceId::generate(),
        },
    };
    let decoded_request_bytes = serde_json::to_vec(&sample_request).unwrap().len() * 4 + 64 * 1024;
    let source_bytes = MAX_PUBLICATION_BYTES + 64 * 1024;
    let preowned_control_response_bytes = 192 * 1024;
    let headroom_bytes = 1024 * 1024;
    let data_ceiling = source_bytes + decoded_request_bytes + preowned_control_response_bytes;
    let mut config =
        BrokerConfig::new(fixture.path().join("data")).with_source_reader(source.clone());
    config.output_budget_bytes = data_ceiling + headroom_bytes;
    config.output_headroom_bytes = headroom_bytes;
    let root = config.swarm_root();
    let broker = BrokerRuntime::start(config).await.unwrap();
    let (first, group_id, source_id, _, _) = peer_source(&broker).await;
    let first = first;
    let request = PeerRequest {
        version: SWARM_RPC_VERSION,
        correlation_id: "c-held-source".into(),
        operation: PeerOperation::FetchContext {
            group_id: group_id.clone(),
            source_id: source_id.clone(),
        },
    };
    first
        .send_raw(&serde_json::to_vec(&request).unwrap())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), source.entered.notified())
        .await
        .unwrap();
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
    assert_eq!(broker.active_source_reads(), 1);
    assert_eq!(broker.output_usage(), data_ceiling);

    let mut second = TypedConnection::peer(PeerClient::connect(broker.discovery()).await.unwrap());
    let outcome = second
        .call_peer(PeerOperation::FetchContext {
            group_id,
            source_id,
        })
        .await
        .unwrap();
    assert!(matches!(
        outcome,
        Outcome::Error(ref error) if error.code == ErrorCode::Admission
    ));
    assert_eq!(
        source.calls.load(Ordering::SeqCst),
        1,
        "capacity refusal must happen before invoking a second source read"
    );

    let mut owner = owner_connection(&broker, &root).await;
    assert!(matches!(
        owner
            .call_owner(OwnerOperation::Health(Empty {}))
            .await
            .unwrap(),
        Outcome::Health(_)
    ));
    second.send_raw(&vec![b'{'; 64 * 1024]).await.unwrap();
    let ServerMessage::Response(response) = second.recv_message().await.unwrap() else {
        panic!("large request capacity response")
    };
    assert_eq!(response.correlation_id, "malformed");
    assert!(matches!(
        response.outcome,
        Outcome::Error(ref error) if error.code == ErrorCode::Admission
    ));
    let occupied = broker.output_usage();
    drop(first);
    drop(second);
    drop(owner);
    broker.shutdown().await.unwrap();
    assert_eq!(
        source.cancelled.load(Ordering::SeqCst),
        1,
        "gate shutdown must drop the one held reader future"
    );
    std::fs::write(
        fixture.path().join("result.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "case": "source-capacity-before-read",
            "readerCalls": source.calls.load(Ordering::SeqCst),
            "readerFuturesCancelled": source.cancelled.load(Ordering::SeqCst),
            "occupiedOutputBytesBeforeCancellation": occupied,
            "secondRequestRefusedBeforeRead": true,
            "tinyHealthUsedControlHeadroom": true,
            "largeDecodedRequestRefused": true,
        }))
        .unwrap(),
    )
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn source_vec_capacity_must_fit_the_preowned_allocation_bound() {
    let _test = RPC_TEST_LOCK.lock().await;
    let fixture = support::retained_dir().unwrap();
    let config = BrokerConfig::new(fixture.path().join("data"))
        .with_source_reader(Arc::new(OversizedCapacitySource));
    let broker = BrokerRuntime::start(config).await.unwrap();
    let (mut peer, group_id, source_id, _, _) = peer_source(&broker).await;
    let outcome = peer
        .call_peer(PeerOperation::FetchContext {
            group_id,
            source_id,
        })
        .await
        .unwrap();
    assert!(matches!(
        outcome,
        Outcome::Error(ref error) if error.code == ErrorCode::SourceUnavailable
    ));
    tokio::time::timeout(Duration::from_secs(5), async {
        while broker.output_usage() != 0 || broker.budget_usage() != (0, 0) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    std::fs::write(
        fixture.path().join("result.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "case": "source-vec-capacity-bound",
            "bodyLength": 1,
            "bodyCapacity": MAX_PUBLICATION_BYTES + 1,
            "outputUsageAfterRefusal": broker.output_usage(),
            "transportUsageAfterRefusal": broker.budget_usage(),
        }))
        .unwrap(),
    )
    .unwrap();
    broker.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropped_connection_releases_an_encoded_response_and_its_output_owner() {
    let _test = RPC_TEST_LOCK.lock().await;
    let fixture = support::retained_dir().unwrap();
    let output = Arc::new(OutputBarrier::new(OutputKind::Response));
    let config =
        BrokerConfig::new(fixture.path().join("data")).with_output_observer(output.clone());
    let root = config.swarm_root();
    let broker = BrokerRuntime::start(config).await.unwrap();
    let connection = owner_connection(&broker, &root).await;
    let request = OwnerRequest {
        version: SWARM_RPC_VERSION,
        correlation_id: "c-held-response".into(),
        operation: OwnerOperation::Health(Empty {}),
    };
    connection
        .send_raw(&serde_json::to_vec(&request).unwrap())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), output.entered.notified())
        .await
        .unwrap();
    assert_eq!(output.observations.load(Ordering::SeqCst), 1);
    assert!(output.encoded_bytes.load(Ordering::SeqCst) > 0);
    assert!(broker.output_usage() > 0);

    drop(connection);
    output.release();
    tokio::time::timeout(Duration::from_secs(5), async {
        while broker.output_usage() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    std::fs::write(
        fixture.path().join("result.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "case": "dropped-connection-encoded-response",
            "encodedFrameBytes": output.encoded_bytes.load(Ordering::SeqCst),
            "outputObservations": output.observations.load(Ordering::SeqCst),
            "outputUsageAfterDrop": broker.output_usage(),
        }))
        .unwrap(),
    )
    .unwrap();
    broker.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn strict_owner_dtos_reject_spoof_fields_and_oversize_without_side_effects() {
    let _test = RPC_TEST_LOCK.lock().await;
    let fixture = support::retained_dir().unwrap();
    let config = BrokerConfig::new(fixture.path().join("data"));
    let root = config.swarm_root();
    let broker = BrokerRuntime::start(config).await.unwrap();
    let mut owner = owner_connection(&broker, &root).await;

    let valid = OwnerRequest {
        version: SWARM_RPC_VERSION,
        correlation_id: "malformed".into(),
        operation: OwnerOperation::Health(Empty {}),
    };
    assert!(matches!(
        owner
            .call_raw(&serde_json::to_vec(&valid).unwrap(), "malformed")
            .await
            .unwrap(),
        Outcome::Health(_)
    ));

    let spoofed = br#"{"version":1,"correlationId":"c-spoofed","operation":{"kind":"create_group","params":{"label":"must-not-exist","members":[],"callerPid":4242}}}"#;
    owner.send_raw(spoofed).await.unwrap();
    let ServerMessage::Response(response) = owner.recv_message().await.unwrap() else {
        panic!("malformed response")
    };
    assert_eq!(response.correlation_id, "malformed");
    assert!(
        matches!(response.outcome, Outcome::Error(ref error) if error.code == ErrorCode::InvalidRequest)
    );

    owner
        .send_raw(&vec![b'{'; MAX_REQUEST_FRAME_BYTES + 1])
        .await
        .unwrap();
    let ServerMessage::Response(response) = owner.recv_message().await.unwrap() else {
        panic!("oversize response")
    };
    assert_eq!(response.correlation_id, "malformed");
    assert!(
        matches!(response.outcome, Outcome::Error(ref error) if error.code == ErrorCode::InvalidRequest)
    );

    let snapshot = owner
        .call_owner(OwnerOperation::Snapshot(SnapshotParams::Groups {
            expected_inventory_revision: None,
            after_group: None,
            max_items: 1,
        }))
        .await
        .unwrap();
    let Outcome::Snapshot(OwnerSnapshotPage::Groups(page)) = snapshot else {
        panic!("group snapshot")
    };
    assert!(
        page.groups.is_empty(),
        "spoofed group operation was dispatched"
    );
    std::fs::write(
        fixture.path().join("result.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "case": "strict-owner-dto-and-oversize",
            "literalMalformedCorrelationAccepted": true,
            "spoofedGroupCount": page.groups.len(),
            "oversizeBytes": MAX_REQUEST_FRAME_BYTES + 1,
        }))
        .unwrap(),
    )
    .unwrap();
    broker.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn committed_publication_keeps_output_owned_at_the_encoded_output_barrier() {
    let _test = RPC_TEST_LOCK.lock().await;
    let fixture = support::retained_dir().unwrap();
    let body = vec![b'p'; 8 * 1024 * 1024];
    let source = Arc::new(CommitBarrierSource::new(body.clone()));
    let output = Arc::new(OutputBarrier::new(OutputKind::Publication));
    let config = BrokerConfig::new(fixture.path().join("data"))
        .with_source_reader(source.clone())
        .with_output_observer(output.clone());
    let broker = BrokerRuntime::start(config).await.unwrap();
    let (mut peer, group_id, source_id, peer_id, policy_revision) = peer_source(&broker).await;
    let request = PeerRequest {
        version: SWARM_RPC_VERSION,
        correlation_id: "c-publication".into(),
        operation: PeerOperation::FetchContext {
            group_id: group_id.clone(),
            source_id: source_id.clone(),
        },
    };
    peer.send_raw(&serde_json::to_vec(&request).unwrap())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), source.committed.notified())
        .await
        .unwrap();
    assert!(
        broker.output_usage() >= body.len(),
        "the second body representation must be owned before final validation returns"
    );

    let response = submit(&broker.core_client(), || {
        Command::Membership(
            broker.owner_principal(),
            group_id.clone(),
            peer_id.clone(),
            false,
            policy_revision,
        )
    })
    .await;
    assert!(matches!(response, Response::Group(_)));
    source.release();
    tokio::time::timeout(Duration::from_secs(5), source.commit_released.notified())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), output.entered.notified())
        .await
        .unwrap();
    assert!(
        broker.output_usage() >= output.encoded_bytes.load(Ordering::SeqCst) + 64 * 1024,
        "the encoded-output barrier must retain its buffer and bounded commitment metadata"
    );
    assert!(
        output.encoded_bytes.load(Ordering::SeqCst) > body.len(),
        "the observed encoded frame includes the body and response metadata"
    );
    output.release();

    let message = tokio::time::timeout(Duration::from_secs(10), peer.recv_message())
        .await
        .unwrap()
        .unwrap();
    let ServerMessage::Response(response) = message else {
        panic!("publication response")
    };
    assert_eq!(response.correlation_id, "c-publication");
    let Outcome::ContextPublished(published) = response.outcome else {
        panic!("committed publication")
    };
    assert_eq!(published.body, body);
    assert_eq!(source.observations.load(Ordering::SeqCst), 1);

    let second = peer
        .call_peer(PeerOperation::FetchContext {
            group_id,
            source_id,
        })
        .await
        .unwrap();
    assert!(
        matches!(second, Outcome::Error(_)),
        "a new request must revalidate"
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        while broker.output_usage() != 0 || broker.budget_usage() != (0, 0) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    std::fs::write(
        fixture.path().join("result.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "case": "committed-publication-blocked-output",
            "bodyBytes": published.body.len(),
            "observations": source.observations.load(Ordering::SeqCst),
            "encodedOutputObservations": output.observations.load(Ordering::SeqCst),
            "encodedFrameBytes": output.encoded_bytes.load(Ordering::SeqCst),
            "outputHighWater": broker.output_high_water(),
            "outputUsageAfterRead": broker.output_usage(),
            "transportUsageAfterRead": broker.budget_usage(),
            "newRequestRejectedAfterMembershipRemoval": matches!(second, Outcome::Error(_)),
        }))
        .unwrap(),
    )
    .unwrap();
    broker.shutdown().await.unwrap();
}
