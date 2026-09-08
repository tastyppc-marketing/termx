#![cfg(windows)]
use std::time::{SystemTime, UNIX_EPOCH};
use termx_swarm_client::{
    AuthorityClaim, ClientBootstrap, DiscoveryRecord, FrameBudget, Hello, OwnerClient, PeerClient,
    PipeServer, ProcessIdentity, RequestEnvelope, ResponseEnvelope, TransportOptions, VerifiedPipe,
    WireError,
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
    let accepted = server.accept().await.unwrap();
    client.send_bytes(b"one").await.unwrap();
    assert_eq!(accepted.recv_bytes().await.unwrap().as_ref(), b"one");
    let client2 = VerifiedPipe::connect(&name, server.identity())
        .await
        .unwrap();
    let accepted2 = server.accept().await.unwrap();
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
    let accepted = accepting.await.unwrap().unwrap();
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
    let evidence = retained("owner-auth");
    let root = evidence.join("authority");
    let claim = AuthorityClaim::claim(&root).unwrap();
    let credential = claim.load_or_create_owner_credential().unwrap();
    let name = pipe("auth");
    let mut server = PipeServer::bind(&name, FrameBudget::new(1024 * 1024)).unwrap();
    let discovery = DiscoveryRecord::new("authority-1", "boot-1", server.identity(), &name);
    let serving = tokio::spawn(async move {
        let accepted = server.accept().await?;
        accepted.authenticate_owner("boot-1", &credential).await
    });
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
    let evidence = retained("external-owner-bootstrap");
    let root = evidence.join("authority");
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
    let authenticating = async {
        let accepted = server.accept().await?;
        let client_identity = accepted.connecting_client_identity()?;
        accepted.authenticate_owner("boot-1", &credential).await?;
        Ok::<_, WireError>((client_identity, accepted))
    };
    let (accepted, status) = tokio::join!(authenticating, waiting);
    let (accepted_identity, accepted) = accepted.unwrap();
    assert_eq!(accepted_identity, child_identity);
    let status = status.unwrap();
    assert!(status.success());
    assert!(!accepted.connecting_client_is_alive().unwrap());
    assert!(matches!(
        AuthorityClaim::claim(&root),
        Err(termx_swarm_client::AuthorityError::Busy)
    ));
    std::fs::write(
        evidence.join("external-bootstrap-result.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "child": child_identity,
            "native_exit": status.code(),
            "broker_claim_remained_held": true,
            "credential_in_argv_or_environment": false,
            "authenticated": true,
            "retained_client_identity_live_after_exit": false,
        }))
        .unwrap(),
    )
    .unwrap();
}

#[tokio::test]
async fn rejected_boot_sends_zero_owner_credential_bytes() {
    let evidence = retained("wrong-boot");
    let root = evidence.join("authority");
    let claim = AuthorityClaim::claim(&root).unwrap();
    let credential = claim.load_or_create_owner_credential().unwrap();
    let name = pipe("wrong-boot");
    let mut server = PipeServer::bind(&name, FrameBudget::new(1024 * 1024)).unwrap();
    let discovery = DiscoveryRecord::new("authority-1", "wrong-boot", server.identity(), &name);
    let observed = tokio::spawn(async move {
        let accepted = server.accept().await.unwrap();
        let hello = accepted.recv_request().await.unwrap();
        accepted
            .send_response(&ResponseEnvelope::new(hello.correlation_id(), false))
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
        evidence.join("result.json"),
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
    let serving = tokio::spawn(async move {
        let accepted = server.accept().await?;
        accepted.authenticate_peer("boot-1").await
    });
    let raw = VerifiedPipe::connect(&name, identity).await.unwrap();
    let invalid = serde_json::to_vec(&serde_json::json!({
        "version": 1,
        "correlationId": "boot-1",
        "kind": "hello",
        "payload": {"bootId": boot},
    }))
    .unwrap();
    let _ = raw.send_bytes(&invalid).await;
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
    let serving = tokio::spawn(async move {
        let accepted = server.accept().await?;
        accepted.authenticate_peer("boot-1").await
    });
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
        let accepted = server.accept().await?;
        accepted.authenticate_peer("boot-1").await?;
        let request = accepted.recv_request().await?;
        assert_eq!(request.correlation_id(), "correlation-1");
        accepted
            .send_response(&ResponseEnvelope::new("correlation-1", true))
            .await
    });
    let client = PeerClient::connect(&discovery).await.unwrap();
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
async fn idle_handshake_does_not_block_later_accept_and_authentication() {
    let evidence = retained("idle-handshake-rotation");
    let name = pipe("idle-handshake");
    let mut server = PipeServer::bind(&name, FrameBudget::with_limits(1024 * 1024, 2)).unwrap();
    let idle_client = VerifiedPipe::connect(&name, server.identity())
        .await
        .unwrap();
    let idle = server.accept().await.unwrap();
    let stalled = tokio::spawn(async move {
        idle.authenticate_peer_with_timeout("boot-1", std::time::Duration::from_millis(75))
            .await
    });

    let discovery = DiscoveryRecord::new("authority-1", "boot-1", server.identity(), &name);
    let serving = tokio::spawn(async move {
        let accepted = server.accept().await?;
        accepted.authenticate_peer("boot-1").await
    });
    let client = PeerClient::connect(&discovery).await.unwrap();
    assert!(serving.await.unwrap().is_ok());
    assert!(matches!(
        stalled.await.unwrap(),
        Err(WireError::HandshakeTimeout)
    ));
    drop(client);
    drop(idle_client);
    std::fs::write(
        evidence.join("result.json"),
        br#"{"idle_handshake_timed_out":true,"later_accept_authenticated":true,"listener_not_held_by_authentication":true}"#,
    )
    .unwrap();
}

#[tokio::test]
async fn one_connection_makes_independent_read_and_write_progress() {
    let evidence = retained("full-duplex");
    let name = pipe("full-duplex");
    let mut server = PipeServer::bind(&name, FrameBudget::new(1024 * 1024)).unwrap();
    let client = std::sync::Arc::new(
        VerifiedPipe::connect(&name, server.identity())
            .await
            .unwrap(),
    );
    let accepted = std::sync::Arc::new(server.accept().await.unwrap());
    assert!(matches!(
        client.connecting_client_identity(),
        Err(WireError::WrongEndpoint)
    ));

    let pending_read = {
        let accepted = accepted.clone();
        tokio::spawn(async move { accepted.recv_bytes().await.map(|frame| frame.to_vec()) })
    };
    tokio::task::yield_now().await;
    let (sent, event) = tokio::join!(accepted.send_bytes(b"event"), client.recv_bytes());
    sent.unwrap();
    assert_eq!(event.unwrap().as_ref(), b"event");
    client.send_bytes(b"request").await.unwrap();
    assert_eq!(pending_read.await.unwrap().unwrap(), b"request");
    std::fs::write(
        evidence.join("result.json"),
        br#"{"write_completed_while_same_endpoint_read_pending":true,"per_direction_order_preserved":true,"client_identity_wrong_direction_rejected":true}"#,
    )
    .unwrap();
}

#[tokio::test]
async fn pipe_busy_retry_has_bounded_deadline_and_later_progress() {
    let evidence = retained("pipe-busy-retry");
    let name = pipe("busy-retry");
    let mut server = PipeServer::bind(&name, FrameBudget::new(1024 * 1024)).unwrap();
    let identity = server.identity();
    let first = VerifiedPipe::connect(&name, identity).await.unwrap();
    let short = TransportOptions {
        connect_timeout: std::time::Duration::from_millis(60),
        connect_retry_interval: std::time::Duration::from_millis(5),
        ..TransportOptions::default()
    };
    assert!(matches!(
        VerifiedPipe::connect_with_options(&name, identity, short).await,
        Err(WireError::ConnectTimeout)
    ));

    let retry = VerifiedPipe::connect_with_options(
        &name,
        identity,
        TransportOptions {
            connect_timeout: std::time::Duration::from_millis(500),
            connect_retry_interval: std::time::Duration::from_millis(5),
            ..TransportOptions::default()
        },
    );
    let rotate = async {
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        server.accept().await
    };
    let (second, accepted_first) = tokio::join!(retry, rotate);
    let second = second.unwrap();
    let accepted_first = accepted_first.unwrap();
    let accepted_second = server.accept().await.unwrap();
    drop(accepted_second);
    drop(accepted_first);
    drop(second);
    drop(first);
    std::fs::write(
        evidence.join("result.json"),
        br#"{"busy_deadline_returned_connect_timeout":true,"retry_used_async_sleep":true,"connection_progressed_after_acceptor_rotation":true}"#,
    )
    .unwrap();
}

#[tokio::test]
async fn owner_connect_requires_server_acceptance_and_rejects_wrong_credential() {
    let evidence = retained("owner-auth-acceptance");
    let authority_one = evidence.join("authority-one");
    let authority_two = evidence.join("authority-two");
    let claim_one = AuthorityClaim::claim(&authority_one).unwrap();
    let claim_two = AuthorityClaim::claim(&authority_two).unwrap();
    let expected = claim_one.load_or_create_owner_credential().unwrap();
    let wrong = claim_two.load_or_create_owner_credential().unwrap();
    let name = pipe("owner-auth-acceptance");
    let mut server = PipeServer::bind(&name, FrameBudget::new(1024 * 1024)).unwrap();
    let discovery = DiscoveryRecord::new("authority-1", "boot-1", server.identity(), &name);
    let serving = tokio::spawn(async move {
        let accepted = server.accept().await?;
        accepted.authenticate_owner("boot-1", &expected).await
    });
    assert!(matches!(
        OwnerClient::connect(&discovery, &wrong).await,
        Err(WireError::AuthenticationRejected)
    ));
    assert!(matches!(
        serving.await.unwrap(),
        Err(WireError::AuthenticationRejected)
    ));
    std::fs::write(
        evidence.join("result.json"),
        br#"{"wrong_credential_rejected_by_server":true,"client_waited_for_negative_auth_result":true}"#,
    )
    .unwrap();
}

#[tokio::test]
async fn owner_connect_times_out_when_auth_reply_is_held() {
    let evidence = retained("owner-auth-reply-timeout");
    let authority = evidence.join("authority");
    let claim = AuthorityClaim::claim(&authority).unwrap();
    let credential = claim.load_or_create_owner_credential().unwrap();
    let name = pipe("owner-auth-held");
    let mut server = PipeServer::bind(&name, FrameBudget::new(1024 * 1024)).unwrap();
    let discovery = DiscoveryRecord::new("authority-1", "boot-1", server.identity(), &name);
    let holding = tokio::spawn(async move {
        let accepted = server.accept().await.unwrap();
        let hello = accepted.recv_request().await.unwrap();
        accepted
            .send_response(&ResponseEnvelope::new(hello.correlation_id(), true))
            .await
            .unwrap();
        let _auth = accepted.recv_bytes().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    });
    let options = TransportOptions {
        handshake_timeout: std::time::Duration::from_millis(50),
        ..TransportOptions::default()
    };
    assert!(matches!(
        OwnerClient::connect_with_options(&discovery, &credential, options).await,
        Err(WireError::HandshakeTimeout)
    ));
    holding.await.unwrap();
    std::fs::write(
        evidence.join("result.json"),
        br#"{"credential_written_after_verified_hello":true,"held_auth_reply_timed_out":true,"client_did_not_report_authenticated":true}"#,
    )
    .unwrap();
}

#[tokio::test]
async fn owner_connect_fails_when_auth_reply_connection_is_dropped() {
    let evidence = retained("owner-auth-reply-dropped");
    let authority = evidence.join("authority");
    let claim = AuthorityClaim::claim(&authority).unwrap();
    let credential = claim.load_or_create_owner_credential().unwrap();
    let name = pipe("owner-auth-dropped");
    let mut server = PipeServer::bind(&name, FrameBudget::new(1024 * 1024)).unwrap();
    let discovery = DiscoveryRecord::new("authority-1", "boot-1", server.identity(), &name);
    let dropping = tokio::spawn(async move {
        let accepted = server.accept().await.unwrap();
        let hello = accepted.recv_request().await.unwrap();
        accepted
            .send_response(&ResponseEnvelope::new(hello.correlation_id(), true))
            .await
            .unwrap();
        let _auth = accepted.recv_bytes().await.unwrap();
        drop(accepted);
    });
    assert!(matches!(
        OwnerClient::connect(&discovery, &credential).await,
        Err(WireError::Disconnected)
    ));
    dropping.await.unwrap();
    std::fs::write(
        evidence.join("result.json"),
        br#"{"credential_written_after_verified_hello":true,"auth_reply_connection_dropped":true,"client_did_not_report_authenticated":true}"#,
    )
    .unwrap();
}

#[tokio::test]
async fn received_frame_and_connection_capacity_remain_reserved_until_drop() {
    let name = pipe("capacity");
    let budget = FrameBudget::with_limits(1024, 1);
    let mut server = PipeServer::bind(&name, budget.clone()).unwrap();
    let client = VerifiedPipe::connect(&name, server.identity())
        .await
        .unwrap();
    let accepted = server.accept().await.unwrap();
    client.send_bytes(b"held").await.unwrap();
    let frame = accepted.recv_bytes().await.unwrap();
    assert_eq!(frame.as_ref(), b"held");
    assert_eq!(budget.usage(), (8, 1));
    assert_eq!(budget.connection_usage(), 1);

    let client2 = VerifiedPipe::connect(&name, server.identity())
        .await
        .unwrap();
    assert!(matches!(server.accept().await, Err(WireError::Capacity)));
    drop(frame);
    assert_eq!(budget.usage(), (0, 0));
    drop(accepted);
    assert_eq!(budget.connection_usage(), 0);

    let accepted2 = server.accept().await.unwrap();
    drop(accepted2);
    drop(client2);

    let _client3 = VerifiedPipe::connect(&name, server.identity())
        .await
        .unwrap();
    let _accepted3 = server.accept().await.unwrap();
}

#[tokio::test]
async fn owner_handshake_rejects_duplicate_auth_discriminants() {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let evidence = retained("strict-owner-auth");
    let root = evidence.join("authority");
    let claim = AuthorityClaim::claim(&root).unwrap();
    let credential = claim.load_or_create_owner_credential().unwrap();
    let credential_text = STANDARD.encode(std::fs::read(root.join("owner.credential")).unwrap());
    let name = pipe("strict-owner-auth");
    let mut server = PipeServer::bind(&name, FrameBudget::new(1024 * 1024)).unwrap();
    let identity = server.identity();
    let serving = tokio::spawn(async move {
        let accepted = server.accept().await?;
        accepted.authenticate_owner("boot-1", &credential).await
    });
    let raw = VerifiedPipe::connect(&name, identity).await.unwrap();
    raw.send_request(&RequestEnvelope::hello("boot-1", Hello::new("boot-1")))
        .await
        .unwrap();
    assert!(raw.recv_response().await.unwrap().accepted());
    let duplicate =
        format!("{{\"credential\":\"{credential_text}\",\"credential\":\"{credential_text}\"}}");
    raw.send_bytes(duplicate.as_bytes()).await.unwrap();
    assert!(matches!(
        serving.await.unwrap(),
        Err(WireError::InvalidFrame)
    ));
    std::fs::write(
        evidence.join("auth-result.json"),
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
