#![cfg(windows)]
use std::time::{SystemTime, UNIX_EPOCH};
use termx_swarm_client::{
    AuthorityClaim, ClientBootstrap, DiscoveryRecord, FrameBudget, Hello, OwnerClient, PeerClient,
    PipeServer, ProcessIdentity, RequestEnvelope, ResponseEnvelope, VerifiedPipe, WireError,
};

fn pipe(label: &str) -> String {
    format!(
        r"\\.\pipe\termx-swarm-test-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}

fn retained(label: &str) -> std::path::PathBuf {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../retired/test-artifacts/swarm-client")
        .join(format!(
            "{label}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    std::fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn transport_handle_child() {
    if std::env::var_os("TERMX_SWARM_TRANSPORT_HANDLE_CHILD").is_some() {
        std::thread::sleep(std::time::Duration::from_secs(2));
    }
}

#[test]
fn external_owner_client_child() {
    let Some(root) = std::env::var_os("TERMX_SWARM_CLIENT_BOOTSTRAP_ROOT") else {
        return;
    };
    let bootstrap = ClientBootstrap::open(std::path::Path::new(&root)).unwrap();
    let discovery = bootstrap.read_discovery().unwrap();
    let credential = bootstrap.load_owner_credential().unwrap();
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(OwnerClient::connect(&discovery, &credential))
        .unwrap();
}

#[tokio::test]
async fn first_instance_rotates_without_name_gap_and_frames_round_trip() {
    let evidence = retained("first-instance-rotation");
    let name = pipe("rotate");
    let budget = FrameBudget::new(1024 * 1024);
    let mut server = PipeServer::bind(&name, budget.clone()).unwrap();
    assert!(PipeServer::bind(&name, budget.clone()).is_err());
    let client = VerifiedPipe::connect(&name, server.identity())
        .await
        .unwrap();
    let mut accepted = server.accept().await.unwrap();
    client.send_bytes(b"one").await.unwrap();
    assert_eq!(accepted.recv_bytes().await.unwrap().as_ref(), b"one");
    let client2 = VerifiedPipe::connect(&name, server.identity())
        .await
        .unwrap();
    let mut accepted2 = server.accept().await.unwrap();
    client2.send_bytes(b"two").await.unwrap();
    assert_eq!(accepted2.recv_bytes().await.unwrap().as_ref(), b"two");
    assert_eq!(budget.usage(), (0, 0));
    assert_eq!(budget.connection_usage(), 2);
    drop(accepted);
    drop(accepted2);
    assert_eq!(budget.connection_usage(), 0);
    std::fs::write(
        evidence.join("result.json"),
        br#"{"first_instance_contended":true,"rotation_round_trips":2,"final_frame_bytes":0,"final_connections":0}"#,
    )
    .unwrap();
}

#[tokio::test]
async fn wrong_server_identity_sends_zero_application_bytes() {
    let evidence = retained("wrong-server");
    let name = pipe("wrong");
    let mut server = PipeServer::bind(&name, FrameBudget::new(1024)).unwrap();
    let mut wrong = server.identity();
    wrong.creation_filetime =
        termx_swarm_client::DecimalU64::new(wrong.creation_filetime.get() + 1);
    let accepting = tokio::spawn(async move { server.accept().await });
    tokio::task::yield_now().await;
    assert!(VerifiedPipe::connect(&name, wrong).await.is_err());
    let mut accepted = accepting.await.unwrap().unwrap();
    assert!(matches!(
        tokio::time::timeout(std::time::Duration::from_secs(2), accepted.recv_bytes())
            .await
            .unwrap(),
        Err(WireError::Disconnected)
    ));
    std::fs::write(
        evidence.join("result.json"),
        br#"{"native_identity_rejected":true,"application_frames_received":0}"#,
    )
    .unwrap();
}

#[test]
fn current_process_identity_is_not_pid_only() {
    let actual = termx_swarm_client::VerifiedProcess::open(std::process::id())
        .unwrap()
        .identity();
    assert_ne!(
        actual,
        ProcessIdentity::new(actual.pid, actual.creation_filetime.get() + 1)
    );
}

#[tokio::test]
async fn owner_auth_follows_verified_boot_hello() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../retired/test-artifacts/swarm-client")
        .join(format!(
            "owner-auth-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    std::fs::create_dir_all(&root).unwrap();
    let claim = AuthorityClaim::claim(&root).unwrap();
    let credential = claim.load_or_create_owner_credential().unwrap();
    let name = pipe("auth");
    let mut server = PipeServer::bind(&name, FrameBudget::new(1024 * 1024)).unwrap();
    let discovery = DiscoveryRecord::new("authority-1", "boot-1", server.identity(), &name);
    let serving = tokio::spawn(async move { server.accept_owner("boot-1", &credential).await });
    let client = OwnerClient::connect(
        &discovery,
        &claim.load_or_create_owner_credential().unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(client.server_identity(), discovery.server);
    assert!(serving.await.unwrap().is_ok());
}

#[tokio::test]
async fn external_client_bootstraps_while_broker_claim_remains_held() {
    let root = retained("external-owner-bootstrap");
    let claim = AuthorityClaim::claim(&root).unwrap();
    let credential = claim.load_or_create_owner_credential().unwrap();
    let name = pipe("external-owner-bootstrap");
    let mut server = PipeServer::bind(&name, FrameBudget::new(1024 * 1024)).unwrap();
    let discovery = DiscoveryRecord::new("authority-1", "boot-1", server.identity(), &name);
    claim.publish_discovery(&discovery).unwrap();

    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "external_owner_client_child", "--nocapture"])
        .env("TERMX_SWARM_CLIENT_BOOTSTRAP_ROOT", &root)
        .spawn()
        .unwrap();
    let child_identity = termx_swarm_client::VerifiedProcess::open(child.id())
        .unwrap()
        .identity();
    let waiting = tokio::task::spawn_blocking(move || child.wait().unwrap());
    let (accepted, status) = tokio::join!(server.accept_owner("boot-1", &credential), waiting);
    accepted.unwrap();
    let status = status.unwrap();
    assert!(status.success());
    assert!(matches!(
        AuthorityClaim::claim(&root),
        Err(termx_swarm_client::AuthorityError::Busy)
    ));
    std::fs::write(
        root.join("external-bootstrap-result.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "child": child_identity,
            "native_exit": status.code(),
            "broker_claim_remained_held": true,
            "credential_in_argv_or_environment": false,
            "authenticated": true,
        }))
        .unwrap(),
    )
    .unwrap();
}

#[tokio::test]
async fn rejected_boot_sends_zero_owner_credential_bytes() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../retired/test-artifacts/swarm-client")
        .join(format!(
            "wrong-boot-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    std::fs::create_dir_all(&root).unwrap();
    let claim = AuthorityClaim::claim(&root).unwrap();
    let credential = claim.load_or_create_owner_credential().unwrap();
    let name = pipe("wrong-boot");
    let mut server = PipeServer::bind(&name, FrameBudget::new(1024 * 1024)).unwrap();
    let discovery = DiscoveryRecord::new("authority-1", "wrong-boot", server.identity(), &name);
    let observed = tokio::spawn(async move {
        let mut accepted = server.accept().await.unwrap();
        let _hello = accepted.recv_bytes().await.unwrap();
        accepted
            .send_bytes(br#"{"version":1,"bootId":"actual-boot","accepted":false}"#)
            .await
            .unwrap();
        matches!(
            tokio::time::timeout(std::time::Duration::from_secs(2), accepted.recv_bytes())
                .await
                .unwrap(),
            Err(WireError::Disconnected)
        )
    });
    assert!(OwnerClient::connect(&discovery, &credential).await.is_err());
    assert!(observed.await.unwrap());
    std::fs::write(
        root.join("result.json"),
        br#"{"native_identity_verified":true,"boot_rejected":true,"owner_credential_frames":0}"#,
    )
    .unwrap();
}

#[tokio::test]
async fn peer_hello_rejects_oversized_boot_identifier() {
    let name = pipe("oversized-boot");
    let mut server = PipeServer::bind(&name, FrameBudget::new(1024 * 1024)).unwrap();
    let identity = server.identity();
    let boot = "b".repeat(129);
    let server_boot = boot.clone();
    let serving = tokio::spawn(async move { server.accept_peer(&server_boot).await });
    let raw = VerifiedPipe::connect(&name, identity).await.unwrap();
    raw.send_bytes(
        serde_json::to_string(&serde_json::json!({"version": 1, "bootId": boot}))
            .unwrap()
            .as_bytes(),
    )
    .await
    .unwrap();
    assert!(matches!(
        serving.await.unwrap(),
        Err(WireError::InvalidFrame)
    ));
}

#[tokio::test]
async fn peer_client_uses_verified_boot_hello() {
    let name = pipe("peer-auth");
    let mut server = PipeServer::bind(&name, FrameBudget::new(1024 * 1024)).unwrap();
    let discovery = DiscoveryRecord::new("authority-1", "boot-1", server.identity(), &name);
    let serving = tokio::spawn(async move { server.accept_peer("boot-1").await });
    let client = PeerClient::connect(&discovery).await.unwrap();
    assert_eq!(client.server_identity(), discovery.server);
    assert!(serving.await.unwrap().is_ok());
}

#[tokio::test]
async fn typed_client_round_trip_preserves_correlation() {
    let name = pipe("typed-round-trip");
    let mut server = PipeServer::bind(&name, FrameBudget::new(1024 * 1024)).unwrap();
    let discovery = DiscoveryRecord::new("authority-1", "boot-1", server.identity(), &name);
    let serving = tokio::spawn(async move {
        let mut accepted = server.accept_peer("boot-1").await?;
        let request = accepted.recv_request().await?;
        assert_eq!(request.correlation_id(), "correlation-1");
        accepted
            .send_response(&ResponseEnvelope::new("correlation-1", true))
            .await
    });
    let mut client = PeerClient::connect(&discovery).await.unwrap();
    client
        .send_request(&RequestEnvelope::hello(
            "correlation-1",
            Hello::new("boot-1"),
        ))
        .await
        .unwrap();
    let response = client.recv_response().await.unwrap();
    assert_eq!(response.correlation_id(), "correlation-1");
    assert!(response.accepted());
    serving.await.unwrap().unwrap();
}

#[tokio::test]
async fn received_frame_and_connection_capacity_remain_reserved_until_drop() {
    let name = pipe("capacity");
    let budget = FrameBudget::with_limits(1024, 1);
    let mut server = PipeServer::bind(&name, budget.clone()).unwrap();
    let client = VerifiedPipe::connect(&name, server.identity())
        .await
        .unwrap();
    let mut accepted = server.accept().await.unwrap();
    client.send_bytes(b"held").await.unwrap();
    let frame = accepted.recv_bytes().await.unwrap();
    assert_eq!(frame.as_ref(), b"held");
    assert_eq!(budget.usage(), (8, 1));
    assert_eq!(budget.connection_usage(), 1);

    let client2 = VerifiedPipe::connect(&name, server.identity())
        .await
        .unwrap();
    assert!(matches!(server.accept().await, Err(WireError::Capacity)));
    drop(client2);
    drop(frame);
    assert_eq!(budget.usage(), (0, 0));
    drop(accepted);
    assert_eq!(budget.connection_usage(), 0);

    let _client3 = VerifiedPipe::connect(&name, server.identity())
        .await
        .unwrap();
    let _accepted3 = server.accept().await.unwrap();
}

#[tokio::test]
async fn owner_handshake_rejects_duplicate_auth_discriminants() {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let root = retained("strict-owner-auth");
    let claim = AuthorityClaim::claim(&root).unwrap();
    let credential = claim.load_or_create_owner_credential().unwrap();
    let credential_text = STANDARD.encode(std::fs::read(root.join("owner.credential")).unwrap());
    let name = pipe("strict-owner-auth");
    let mut server = PipeServer::bind(&name, FrameBudget::new(1024 * 1024)).unwrap();
    let identity = server.identity();
    let serving = tokio::spawn(async move { server.accept_owner("boot-1", &credential).await });
    let mut raw = VerifiedPipe::connect(&name, identity).await.unwrap();
    raw.send_bytes(br#"{"version":1,"bootId":"boot-1"}"#)
        .await
        .unwrap();
    let _hello = raw.recv_bytes().await.unwrap();
    let duplicate =
        format!("{{\"credential\":\"{credential_text}\",\"credential\":\"{credential_text}\"}}");
    raw.send_bytes(duplicate.as_bytes()).await.unwrap();
    assert!(matches!(
        serving.await.unwrap(),
        Err(WireError::InvalidFrame)
    ));
    std::fs::write(
        root.join("auth-result.json"),
        br#"{"duplicate_credential_field_rejected":true,"credential_value_retained_only_in_acl_file":true}"#,
    )
    .unwrap();
}

#[tokio::test]
async fn pipe_handles_are_not_inherited_by_subprocess() {
    let evidence = retained("pipe-handle-inheritance");
    let name = pipe("inheritance");
    let budget = FrameBudget::new(1024);
    let mut server = PipeServer::bind(&name, budget.clone()).unwrap();
    let client = VerifiedPipe::connect(&name, server.identity())
        .await
        .unwrap();
    let accepted = server.accept().await.unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "transport_handle_child", "--nocapture"])
        .env("TERMX_SWARM_TRANSPORT_HANDLE_CHILD", "1")
        .spawn()
        .unwrap();
    let child_identity = termx_swarm_client::VerifiedProcess::open(child.id())
        .unwrap()
        .identity();
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert!(child.try_wait().unwrap().is_none());
    drop(accepted);
    drop(client);
    drop(server);
    assert_eq!(budget.connection_usage(), 0);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
    let replacement = loop {
        if let Ok(replacement) = PipeServer::bind(&name, FrameBudget::new(1024)) {
            break replacement;
        }
        assert!(child.try_wait().unwrap().is_none());
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    };
    drop(replacement);
    let status = child.wait().unwrap();
    std::fs::write(
        evidence.join("result.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "child": child_identity,
            "native_exit": status.code(),
            "first_instance_reclaimed_while_child_alive": true,
        }))
        .unwrap(),
    )
    .unwrap();
    assert!(status.success());
}
