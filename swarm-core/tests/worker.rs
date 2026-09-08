mod support;
use termx_swarm_core::{model::*, worker::*};
async fn admit(client: &Client, make: impl Fn() -> Command) -> Pending {
    loop {
        match client.submit(make()) {
            Ok(p) => return p,
            Err(AdmissionError::Contended) => tokio::task::yield_now().await,
            Err(e) => panic!("admission: {e}"),
        }
    }
}
#[tokio::test(flavor = "current_thread")]
async fn abandoned_reply_commits_and_shutdown_drains() {
    let worker = Worker::open(
        support::retained_db("worker-drain"),
        WorkerConfig::default(),
    )
    .await
    .unwrap();
    let client = worker.client();
    let Response::Owner(owner) = admit(&client, || Command::TrustedOwner)
        .await
        .await
        .unwrap()
    else {
        panic!("owner")
    };
    let mut peers = Vec::new();
    for name in ["sender", "recipient"] {
        let binding = VerifiedBinding::trusted(
            LaunchId::generate().as_str().into(),
            name.into(),
            "synthetic".into(),
            name.into(),
            None,
            1,
            1,
            true,
        )
        .unwrap();
        let Response::Enrolled(peer) =
            admit(&client, || Command::Enroll(owner.clone(), binding.clone()))
                .await
                .await
                .unwrap()
        else {
            panic!("peer")
        };
        peers.push(peer);
    }
    let Response::Group(group) = admit(&client, || {
        Command::CreateGroup(
            owner.clone(),
            "group".into(),
            peers.iter().map(|p| p.record.peer_id.clone()).collect(),
        )
    })
    .await
    .await
    .unwrap() else {
        panic!("group")
    };
    let request = SendMessageRequest {
        group_id: group.group_id,
        client_key: "lost-reply".into(),
        recipients: [peers[1].record.peer_id.clone()].into(),
        body: "synthetic".into(),
        topic: None,
        reply_to: None,
        attachments: Vec::new(),
    };
    drop(
        admit(&client, || {
            Command::Send(peers[0].principal.clone(), request.clone())
        })
        .await,
    );
    let retry = admit(&client, || {
        Command::Send(peers[0].principal.clone(), request.clone())
    })
    .await;
    worker.shutdown().await.unwrap();
    let Response::Saved(receipt) = retry.await.unwrap() else {
        panic!("saved")
    };
    assert_eq!(receipt.group_sequence, 1);
    assert!(matches!(
        client.submit(Command::TrustedOwner),
        Err(AdmissionError::Closed)
    ));
    let metrics = client.metrics();
    assert_eq!(metrics.accepted, metrics.completed);
    assert_eq!(metrics.request_bytes, 0);
}
