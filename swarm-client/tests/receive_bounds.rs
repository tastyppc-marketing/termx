use std::time::{Duration, SystemTime, UNIX_EPOCH};
use termx_swarm_client::{
    DiscoveryRecord, FrameBudget, PeerClient, PipeServer, TransportOptions, VerifiedPipe,
    VerifiedProcess, WireError, MAX_FRAME_BYTES, MAX_HANDSHAKE_FRAME_BYTES,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::ServerOptions;

fn name(label: &str) -> String {
    format!(
        r"\\.\pipe\termx-receive-bound-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}

async fn pair(label: &str, budget: FrameBudget) -> (VerifiedPipe, VerifiedPipe) {
    let name = name(label);
    let mut listener = PipeServer::bind(&name, FrameBudget::new(4096)).unwrap();
    let client = VerifiedPipe::connect_with_options_and_budget(
        &name,
        listener.identity(),
        TransportOptions::default(),
        budget,
    )
    .await
    .unwrap();
    let accepted = listener.accept().await.unwrap();
    (client, accepted)
}

#[tokio::test]
async fn bounded_native_receive_keeps_credit_until_frame_drop() {
    let budget = FrameBudget::with_limits(68, 1);
    let (client, server) = pair("exact", budget.clone()).await;
    assert_eq!(budget.connection_usage(), 1);
    server.send_bytes(&[42; 64]).await.unwrap();
    let frame = client.recv_bytes_with_limit(64).await.unwrap();
    assert_eq!(frame.as_ref(), &[42; 64]);
    assert_eq!(budget.usage(), (68, 1));
    drop(frame);
    assert_eq!(budget.usage(), (0, 0));
    assert!(!client.is_poisoned());
    drop(client);
    assert_eq!(budget.connection_usage(), 0);
}

#[tokio::test]
async fn bounded_native_receive_rejects_oversize_and_never_reads_next_frame() {
    let budget = FrameBudget::new(4096);
    let (client, server) = pair("oversize", budget.clone()).await;
    server.send_bytes(&[17; 65]).await.unwrap();
    server.send_bytes(b"next").await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(2), client.recv_bytes_with_limit(64))
        .await
        .unwrap();
    assert!(matches!(result, Err(WireError::FrameTooLarge)));
    assert_eq!(budget.usage(), (0, 0));
    assert!(client.is_poisoned());
    assert!(matches!(
        client.recv_bytes().await,
        Err(WireError::ConnectionPoisoned)
    ));
}

#[tokio::test]
async fn invalid_receive_limit_does_not_consume_or_poison_a_connection() {
    let budget = FrameBudget::new(4096);
    let (client, server) = pair("invalid", budget.clone()).await;
    server.send_bytes(b"later").await.unwrap();
    for limit in [0, MAX_FRAME_BYTES + 1, usize::MAX] {
        assert!(matches!(
            client.recv_bytes_with_limit(limit).await,
            Err(WireError::InvalidFrame)
        ));
        assert!(!client.is_poisoned());
        assert_eq!(budget.usage(), (0, 0));
    }
    assert_eq!(
        client.recv_bytes_with_limit(5).await.unwrap().as_ref(),
        b"later"
    );
}

#[tokio::test]
async fn supplied_native_connection_budget_is_shared_and_released_on_drop() {
    let pipe_name = name("connections");
    let mut listener = PipeServer::bind(&pipe_name, FrameBudget::new(4096)).unwrap();
    let budget = FrameBudget::with_limits(4096, 1);
    let first = VerifiedPipe::connect_with_options_and_budget(
        &pipe_name,
        listener.identity(),
        TransportOptions::default(),
        budget.clone(),
    )
    .await
    .unwrap();
    let _accepted = listener.accept().await.unwrap();
    let second = VerifiedPipe::connect_with_options_and_budget(
        &pipe_name,
        listener.identity(),
        TransportOptions::default(),
        budget.clone(),
    )
    .await;
    assert!(matches!(second, Err(WireError::Capacity)));
    assert_eq!(budget.connection_usage(), 1);
    assert_eq!(budget.usage(), (0, 0));
    drop(first);
    assert_eq!(budget.connection_usage(), 0);
}

#[tokio::test]
async fn native_oversized_prefix_is_rejected_without_waiting_for_or_allocating_body() {
    let pipe_name = name("prefix-only");
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&pipe_name)
        .unwrap();
    let owner = VerifiedProcess::open(std::process::id()).unwrap();
    let budget = FrameBudget::new(4096);
    let client = VerifiedPipe::connect_with_options_and_budget(
        &pipe_name,
        owner.identity(),
        TransportOptions::default(),
        budget.clone(),
    )
    .await
    .unwrap();
    server.connect().await.unwrap();
    server.write_all(&65_u32.to_le_bytes()).await.unwrap();
    // Keep the native writer open and send no body. The receive must fail on
    // the prefix rather than allocate and block for the declared body bytes.
    let result = tokio::time::timeout(Duration::from_secs(2), client.recv_bytes_with_limit(64))
        .await
        .unwrap();
    assert!(matches!(result, Err(WireError::FrameTooLarge)));
    assert_eq!(budget.usage(), (0, 0));
    assert!(client.is_poisoned());
}

#[tokio::test]
async fn peer_hello_uses_supplied_budget_and_releases_temporary_frame_credit() {
    let pipe_name = name("peer-hello");
    let mut listener = PipeServer::bind(&pipe_name, FrameBudget::new(4096)).unwrap();
    let discovery = DiscoveryRecord::new(
        "authority",
        "boot",
        listener.identity(),
        format!("{pipe_name}-owner"),
        &pipe_name,
    );
    let budget = FrameBudget::with_limits(4096, 1);
    let accept = async {
        let peer = listener.accept().await.unwrap();
        peer.authenticate_peer("boot").await.unwrap();
        peer
    };
    let connect = PeerClient::connect_with_options_and_budget(
        &discovery,
        TransportOptions::default(),
        budget.clone(),
    );
    let (server, client) = tokio::join!(accept, connect);
    let client = client.unwrap();
    assert_eq!(budget.usage(), (0, 0));
    assert_eq!(budget.connection_usage(), 1);
    server.send_bytes(b"ready").await.unwrap();
    let frame = client.pipe().recv_bytes_with_limit(5).await.unwrap();
    assert_eq!(budget.usage(), (9, 1));
    drop(client);
    assert_eq!(budget.connection_usage(), 0);
    assert_eq!(frame.as_ref(), b"ready");
    assert_eq!(budget.usage(), (9, 1));
    drop(frame);
    assert_eq!(budget.usage(), (0, 0));
}

#[tokio::test]
async fn peer_hello_rejects_an_oversized_native_prefix_before_receiving_body() {
    let pipe_name = name("hello-prefix");
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&pipe_name)
        .unwrap();
    let owner = VerifiedProcess::open(std::process::id()).unwrap();
    let discovery = DiscoveryRecord::new(
        "authority",
        "boot",
        owner.identity(),
        format!("{pipe_name}-owner"),
        &pipe_name,
    );
    let budget = FrameBudget::new(1024 * 1024);
    let accept = async {
        server.connect().await.unwrap();
        let length = server.read_u32_le().await.unwrap();
        assert!(length <= 1024);
        let mut hello = vec![0; length as usize];
        server.read_exact(&mut hello).await.unwrap();
        server
            .write_all(&((MAX_HANDSHAKE_FRAME_BYTES + 1) as u32).to_le_bytes())
            .await
            .unwrap();
        // Retain the writer open until the client returns without any body.
        server
    };
    let connect = PeerClient::connect_with_options_and_budget(
        &discovery,
        TransportOptions::default(),
        budget.clone(),
    );
    let (_server, result) = tokio::join!(accept, connect);
    assert!(matches!(result, Err(WireError::FrameTooLarge)));
    assert_eq!(budget.usage(), (0, 0));
    assert_eq!(budget.connection_usage(), 0);
}
