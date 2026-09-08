use super::*;
#[path = "../../tests/support/mod.rs"]
mod support;

#[derive(Debug)]
struct Gate {
    reached: oneshot::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
    panic: bool,
}
impl TestHook for Gate {
    fn run(self: Box<Self>, _: &mut Store) {
        let _ = self.reached.send(());
        self.release.recv().unwrap();
        assert!(!self.panic, "owned test worker panic");
    }
}
async fn gate(client: &Client, panic: bool) -> (Pending, std::sync::mpsc::Sender<()>) {
    loop {
        let (reached, wait) = oneshot::channel();
        let (release, receiver) = std::sync::mpsc::channel();
        let pending = client.submit(Command::TestHook(Box::new(Gate {
            reached,
            release: receiver,
            panic,
        })));
        let pending = match pending {
            Ok(p) => p,
            Err(AdmissionError::Contended) => {
                tokio::task::yield_now().await;
                continue;
            }
            Err(e) => panic!("gate admission: {e}"),
        };
        wait.await.unwrap();
        return (pending, release);
    }
}
async fn submit(client: &Client, command: impl FnMut() -> Command) -> Pending {
    admit(client, command)
        .await
        .unwrap_or_else(|e| panic!("admission: {e}"))
}
async fn admit(
    client: &Client,
    mut command: impl FnMut() -> Command,
) -> Result<Pending, AdmissionError> {
    loop {
        match client.submit(command()) {
            Err(AdmissionError::Contended) => tokio::task::yield_now().await,
            result => return result,
        }
    }
}
#[tokio::test]
async fn admission_retry_ignores_only_contention_and_preserves_capacity_rejection() {
    let worker = Worker::open(
        support::retained_db("admission-retry"),
        WorkerConfig {
            max_responses: 1,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let client = worker.client();
    let held = submit(&client, || Command::TrustedOwner).await;
    let mut attempts = 0;
    let mut retry = Box::pin(admit(&client, || {
        attempts += 1;
        Command::TrustedOwner
    }));
    {
        // A real held admission mutex deterministically supplies Contended.
        // Poll once without awaiting while holding the lock.
        let _guard = lock(&client.shared);
        let mut context = Context::from_waker(std::task::Waker::noop());
        assert!(retry.as_mut().poll(&mut context).is_pending());
    }
    // The held reply deterministically exhausts response credits. A deadline is
    // only a watchdog against incorrectly retrying permanent capacity errors.
    assert!(matches!(
        tokio::time::timeout(std::time::Duration::from_secs(1), retry)
            .await
            .unwrap(),
        Err(AdmissionError::Responses)
    ));
    assert!(attempts >= 2);
    held.await.unwrap();
    worker.shutdown().await.unwrap();
}
#[tokio::test]
async fn full_queue_close_drains_and_unread_response_reserves_capacity() {
    let worker = Worker::open(
        support::retained_db("full-queue"),
        WorkerConfig {
            max_requests: 2,
            max_responses: 3,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let client = worker.client();
    let (held, release) = gate(&client, false).await;
    let queued = client.submit(Command::TrustedOwner).unwrap();
    assert!(matches!(
        client.submit(Command::TrustedOwner),
        Err(AdmissionError::Requests)
    ));
    client.close();
    release.send(()).unwrap();
    worker.shutdown().await.unwrap();
    assert_eq!(client.metrics().completed, 2);
    assert_eq!(client.metrics().responses, 2);
    assert!(matches!(held.await.unwrap(), Response::Unit));
    assert!(matches!(queued.await.unwrap(), Response::Owner(_)));
    assert_eq!(client.metrics().responses, 0);
}
#[tokio::test]
async fn panic_resolves_all_waiters_unknown_and_reports_join_failure() {
    let worker = Worker::open(
        support::retained_db("worker-panic"),
        WorkerConfig::default(),
    )
    .await
    .unwrap();
    let client = worker.client();
    let (held, release) = gate(&client, true).await;
    let queued = client.submit(Command::TrustedOwner).unwrap();
    release.send(()).unwrap();
    assert!(matches!(
        worker.shutdown().await,
        Err(WorkerError::Panicked)
    ));
    assert!(matches!(held.await, Err(OperationError::OutcomeUnknown)));
    assert!(matches!(queued.await, Err(OperationError::OutcomeUnknown)));
    assert_eq!(client.metrics().responses, 0);
    assert_eq!(client.metrics().outcome_unknown, 2);
}
#[tokio::test]
async fn unpolled_replies_do_not_block_writer_and_response_limits_reject_before_enqueue() {
    let worker = Worker::open(
        support::retained_db("slow-client"),
        WorkerConfig {
            max_responses: 3,
            max_response_bytes: 3 * 65536,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let client = worker.client();
    let slow = submit(&client, || Command::TrustedOwner).await;
    let progress = submit(&client, || Command::TrustedOwner).await;
    assert!(matches!(progress.await.unwrap(), Response::Owner(_)));
    let (held, release) = gate(&client, false).await;
    let third = client.submit(Command::TrustedOwner).unwrap();
    assert!(matches!(
        client.submit(Command::TrustedOwner),
        Err(AdmissionError::Responses)
    ));
    drop(slow);
    drop(third);
    release.send(()).unwrap();
    drop(held);
    worker.shutdown().await.unwrap();
    assert_eq!(client.metrics().responses, 0);
}
#[tokio::test]
async fn aggregate_request_capacity_and_owned_string_capacity_are_accounted() {
    let worker = Worker::open(
        support::retained_db("bytes"),
        WorkerConfig {
            max_request_bytes: 20 * 1024,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let client = worker.client();
    let Response::Owner(owner) = submit(&client, || Command::TrustedOwner)
        .await
        .await
        .unwrap()
    else {
        panic!()
    };
    let (held, release) = gate(&client, false).await;
    let mut label = String::with_capacity(19000);
    label.push('g');
    assert!(matches!(
        client.submit(Command::CreateGroup(owner, label, BTreeSet::new())),
        Err(AdmissionError::RequestBytes)
    ));
    release.send(()).unwrap();
    held.await.unwrap();
    worker.shutdown().await.unwrap();
}
#[tokio::test]
async fn large_moved_binding_capacity_reserves_response_bytes_before_enqueue() {
    let worker = Worker::open(
        support::retained_db("response-capacity"),
        WorkerConfig {
            max_response_bytes: 128 * 1024,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let client = worker.client();
    let Response::Owner(owner) = submit(&client, || Command::TrustedOwner)
        .await
        .await
        .unwrap()
    else {
        panic!()
    };
    assert!(matches!(
        admit(&client, || {
            // Rebuild on contention: cloning would discard the spare capacity
            // that this test is specifically intended to measure.
            let mut terminal = String::with_capacity(256 * 1024);
            terminal.push('t');
            let binding = VerifiedBinding::trusted(
                LaunchId::generate().as_str().into(),
                terminal,
                "synthetic".into(),
                "conversation".into(),
                None,
                1,
                1,
                true,
            )
            .unwrap();
            Command::Enroll(owner.clone(), binding)
        })
        .await,
        Err(AdmissionError::ResponseBytes)
    ));
    worker.shutdown().await.unwrap();
}

async fn fixture(
    name: &str,
) -> (
    Worker,
    Client,
    OwnerPrincipal,
    EnrolledPeer,
    EnrolledPeer,
    GroupRecord,
) {
    let worker = Worker::open(support::retained_db(name), WorkerConfig::default())
        .await
        .unwrap();
    let client = worker.client();
    let Response::Owner(owner) = submit(&client, || Command::TrustedOwner)
        .await
        .await
        .unwrap()
    else {
        panic!()
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
            submit(&client, || Command::Enroll(owner.clone(), binding.clone()))
                .await
                .await
                .unwrap()
        else {
            panic!()
        };
        peers.push(peer);
    }
    let Response::Group(group) = submit(&client, || {
        Command::CreateGroup(
            owner.clone(),
            "group".into(),
            peers.iter().map(|p| p.record.peer_id.clone()).collect(),
        )
    })
    .await
    .await
    .unwrap() else {
        panic!()
    };
    (
        worker,
        client,
        owner,
        peers.remove(0),
        peers.remove(0),
        group,
    )
}
#[derive(Debug)]
enum Fault {
    Full,
    Writable,
    ReadOnly,
}
impl TestHook for Fault {
    fn run(self: Box<Self>, store: &mut Store) {
        match *self {
            Self::Full => {
                let pages: i64 = store
                    .connection
                    .pragma_query_value(None, "page_count", |r| r.get(0))
                    .unwrap();
                store
                    .connection
                    .pragma_update(None, "max_page_count", pages)
                    .unwrap();
            }
            Self::Writable => {
                store
                    .connection
                    .pragma_update(None, "query_only", false)
                    .unwrap();
                store
                    .connection
                    .pragma_update(None, "max_page_count", 1073741823)
                    .unwrap();
            }
            Self::ReadOnly => store
                .connection
                .pragma_update(None, "query_only", true)
                .unwrap(),
        }
    }
}
#[tokio::test]
async fn sqlite_full_and_readonly_never_claim_saved_or_acknowledged() {
    let (worker, client, owner, sender, recipient, group) = fixture("storage-faults").await;
    let mut request = SendMessageRequest {
        group_id: group.group_id.clone(),
        client_key: "full-key".into(),
        recipients: [recipient.record.peer_id.clone()].into(),
        body: "x".repeat(1024 * 1024),
        topic: None,
        reply_to: None,
        attachments: Vec::new(),
    };
    submit(&client, || Command::TestHook(Box::new(Fault::Full)))
        .await
        .await
        .unwrap();
    let error = submit(&client, || {
        Command::Send(sender.principal.clone(), request.clone())
    })
    .await
    .await
    .unwrap_err();
    assert!(
        matches!(error,OperationError::Store(StoreError::Sqlite(rusqlite::Error::SqliteFailure(e,_))) if e.code==rusqlite::ErrorCode::DiskFull)
    );
    submit(&client, || Command::TestHook(Box::new(Fault::Writable)))
        .await
        .await
        .unwrap();
    let Response::Saved(saved) = submit(&client, || {
        Command::Send(sender.principal.clone(), request.clone())
    })
    .await
    .await
    .unwrap() else {
        panic!()
    };
    assert_eq!(saved.group_sequence, 1);
    submit(&client, || Command::TestHook(Box::new(Fault::ReadOnly)))
        .await
        .await
        .unwrap();
    request.client_key = "readonly-key".into();
    request.body = "synthetic".into();
    let error = submit(&client, || {
        Command::Send(sender.principal.clone(), request.clone())
    })
    .await
    .await
    .unwrap_err();
    assert!(
        matches!(error,OperationError::Store(StoreError::Sqlite(rusqlite::Error::SqliteFailure(e,_))) if e.code==rusqlite::ErrorCode::ReadOnly)
    );
    let error = submit(&client, || {
        Command::Acknowledge(
            recipient.principal.clone(),
            group.group_id.clone(),
            saved.message_id.clone(),
        )
    })
    .await
    .await
    .unwrap_err();
    assert!(
        matches!(error,OperationError::Store(StoreError::Sqlite(rusqlite::Error::SqliteFailure(e,_))) if e.code==rusqlite::ErrorCode::ReadOnly)
    );
    submit(&client, || Command::TestHook(Box::new(Fault::Writable)))
        .await
        .await
        .unwrap();
    let Response::Mailbox(page) = submit(&client, || {
        Command::Mailbox(
            recipient.principal.clone(),
            MailboxPageRequest {
                group_id: group.group_id.clone(),
                cursor: None,
                max_items: 128,
            },
        )
    })
    .await
    .await
    .unwrap() else {
        panic!()
    };
    assert_eq!(page.messages.len(), 1);
    assert_eq!(page.messages[0].receipt.acknowledged_at_millis, None);
    let Response::Saved(second) = submit(&client, || {
        Command::Send(sender.principal.clone(), request.clone())
    })
    .await
    .await
    .unwrap() else {
        panic!()
    };
    assert_eq!(second.group_sequence, 2);
    let Response::Inspection(inspection) =
        submit(&client, || Command::Inspect).await.await.unwrap()
    else {
        panic!()
    };
    assert!(inspection.integrity_ok);
    assert_eq!(inspection.synchronous, "FULL");
    let _ = owner;
    worker.shutdown().await.unwrap();
}
#[tokio::test]
async fn timeout_after_enqueue_is_unknown_but_does_not_cancel_send() {
    let (worker, client, _owner, sender, recipient, group) = fixture("timeout-after-enqueue").await;
    let request = SendMessageRequest {
        group_id: group.group_id,
        client_key: "same-timeout-key".into(),
        recipients: [recipient.record.peer_id].into(),
        body: "synthetic".into(),
        topic: None,
        reply_to: None,
        attachments: Vec::new(),
    };
    let (held, release) = gate(&client, false).await;
    let pending = client
        .submit(Command::Send(sender.principal.clone(), request.clone()))
        .unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(10), pending)
            .await
            .is_err()
    );
    release.send(()).unwrap();
    held.await.unwrap();
    let Response::Saved(receipt) = submit(&client, || {
        Command::Send(sender.principal.clone(), request.clone())
    })
    .await
    .await
    .unwrap() else {
        panic!()
    };
    assert_eq!(receipt.group_sequence, 1);
    worker.shutdown().await.unwrap();
    assert_eq!(client.metrics().accepted, client.metrics().completed);
}
#[tokio::test]
async fn large_reply_admission_leaves_a_small_response_slot() {
    let (worker, client, _owner, _sender, recipient, group) =
        fixture("reserved-small-response").await;
    // Default response budget is 64 MiB. One 32 MiB reservation must leave
    // enough room for small unrelated operations even if another read arrives.
    let first = submit(&client, || {
        Command::Mailbox(
            recipient.principal.clone(),
            MailboxPageRequest {
                group_id: group.group_id.clone(),
                cursor: None,
                max_items: 1,
            },
        )
    })
    .await;
    submit(&client, || Command::TrustedOwner)
        .await
        .await
        .unwrap();
    assert!(matches!(
        admit(&client, || Command::Mailbox(
            recipient.principal.clone(),
            MailboxPageRequest {
                group_id: group.group_id.clone(),
                cursor: None,
                max_items: 1
            }
        ))
        .await,
        Err(AdmissionError::ResponseBytes)
    ));
    let small = submit(&client, || Command::TrustedOwner).await;
    small.await.unwrap();
    drop(first);
    worker.shutdown().await.unwrap();
}
#[tokio::test]
async fn near_limit_escaped_unicode_pages_stay_within_response_reservations() {
    let (worker, client, _owner, sender, recipient, group) = fixture("bounded-frames").await;
    let bodies = [
        "\u{0000}".repeat(MAX_MESSAGE_BODY_BYTES),
        "\u{1f980}".repeat(MAX_MESSAGE_BODY_BYTES / 4),
    ];
    for (i, body) in bodies.iter().enumerate() {
        assert_eq!(body.len(), MAX_MESSAGE_BODY_BYTES);
        let request = SendMessageRequest {
            group_id: group.group_id.clone(),
            client_key: format!("near-limit-{i}"),
            recipients: [recipient.record.peer_id.clone()].into(),
            body: body.clone(),
            topic: None,
            reply_to: None,
            attachments: Vec::new(),
        };
        let Response::Saved(saved) = submit(&client, || {
            Command::Send(sender.principal.clone(), request.clone())
        })
        .await
        .await
        .unwrap() else {
            panic!()
        };
        assert_eq!(saved.group_sequence, i as u64 + 1);
    }
    let mut cursor = None;
    let mut count = 0;
    loop {
        let response = submit(&client, || {
            Command::Mailbox(
                recipient.principal.clone(),
                MailboxPageRequest {
                    group_id: group.group_id.clone(),
                    cursor: cursor.clone(),
                    max_items: 128,
                },
            )
        })
        .await
        .await
        .unwrap();
        assert!(response.estimated_retained_bytes() <= 32 * 1024 * 1024);
        let Response::Mailbox(page) = response else {
            panic!()
        };
        assert!(serde_json::to_vec(&page).unwrap().len() <= MAX_MAILBOX_PAGE_BYTES);
        for entry in page.messages {
            assert!(
                entry.message.body == bodies[count],
                "synthetic payload mismatch (redacted)"
            );
            count += 1;
        }
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(count, 2);
    worker.shutdown().await.unwrap();
    let metrics = client.metrics();
    assert!(metrics.max_response_estimated_bytes <= metrics.max_response_reservation);
    assert_eq!(metrics.outcome_unknown, 0);
}
#[tokio::test]
async fn eight_clients_serialize_atomic_sends_and_deduplicated_retries() {
    let (worker, client, _owner, sender, recipient, group) = fixture("eight-clients").await;
    let mut tasks = tokio::task::JoinSet::new();
    for i in 0..8 {
        let client = client.clone();
        let principal = sender.principal.clone();
        let group = group.group_id.clone();
        let recipient = recipient.record.peer_id.clone();
        tasks.spawn(async move {
            let mut results = Vec::new();
            for j in 0..16 {
                let request = SendMessageRequest {
                    group_id: group.clone(),
                    client_key: format!("client-{i}-send-{j}"),
                    recipients: [recipient.clone()].into(),
                    body: "synthetic concurrent message".into(),
                    topic: None,
                    reply_to: None,
                    attachments: Vec::new(),
                };
                let mut original = None;
                for _ in 0..2 {
                    let pending = loop {
                        match client.submit(Command::Send(principal.clone(), request.clone())) {
                            Ok(p) => break p,
                            Err(AdmissionError::Closed) => panic!("unexpected shutdown"),
                            Err(_) => tokio::task::yield_now().await,
                        }
                    };
                    let Response::Saved(saved) = pending.await.unwrap() else {
                        panic!()
                    };
                    if let Some(first) = &original {
                        assert_eq!(&saved, first)
                    } else {
                        original = Some(saved);
                    }
                }
                results.push(original.unwrap());
            }
            results
        });
    }
    let mut sequences = BTreeSet::new();
    let mut ids = BTreeSet::new();
    while let Some(result) = tasks.join_next().await {
        for receipt in result.unwrap() {
            assert!(sequences.insert(receipt.group_sequence));
            assert!(ids.insert(receipt.message_id));
        }
    }
    assert_eq!(sequences, (1..=128).collect());
    worker.shutdown().await.unwrap();
    let metrics = client.metrics();
    assert_eq!(metrics.accepted, metrics.completed);
    assert_eq!(metrics.requests, 0);
    assert_eq!(metrics.responses, 0);
    assert_eq!(
        metrics.operation_latency_buckets[9].iter().sum::<u64>(),
        256
    );
    assert!(metrics.request_high_water <= 64);
    assert!(metrics.request_bytes_high_water <= 32 * 1024 * 1024);
    assert!(metrics.response_bytes_high_water <= 64 * 1024 * 1024);
}
#[derive(Debug)]
struct Locate {
    reply: oneshot::Sender<(PathBuf, std::thread::ThreadId)>,
}
impl TestHook for Locate {
    fn run(self: Box<Self>, store: &mut Store) {
        let _ = self.reply.send((
            PathBuf::from(store.connection.path().unwrap()),
            std::thread::current().id(),
        ));
    }
}
#[tokio::test]
async fn worker_reopen_is_passive_and_explicit_recovery_runs_on_owned_thread() {
    let (worker, client, owner, sender, recipient, group) = fixture("worker-recovery").await;
    let mut location = None;
    submit(&client, || {
        let (reply, receiver) = oneshot::channel();
        location = Some(receiver);
        Command::TestHook(Box::new(Locate { reply }))
    })
    .await
    .await
    .unwrap();
    let (path, thread) = location.unwrap().await.unwrap();
    assert_ne!(thread, std::thread::current().id());
    let request = SendMessageRequest {
        group_id: group.group_id.clone(),
        client_key: "unfinished-ticket".into(),
        recipients: [recipient.record.peer_id.clone()].into(),
        body: "synthetic".into(),
        topic: None,
        reply_to: None,
        attachments: Vec::new(),
    };
    submit(&client, || {
        Command::Send(sender.principal.clone(), request.clone())
    })
    .await
    .await
    .unwrap();
    let candidates = || {
        Command::Candidates(
            owner.clone(),
            group.group_id.clone(),
            recipient.record.peer_id.clone(),
            recipient.record.revision,
            1,
        )
    };
    assert!(matches!(
        submit(&client, candidates).await.await,
        Err(OperationError::Store(StoreError::RecoveryRequired))
    ));
    submit(&client, || Command::Recover(owner.clone()))
        .await
        .await
        .unwrap();
    let Response::Candidates(items) = submit(&client, candidates).await.await.unwrap() else {
        panic!()
    };
    let Response::Ticket(ticket) =
        submit(&client, || Command::Begin(owner.clone(), items[0].clone()))
            .await
            .await
            .unwrap()
    else {
        panic!()
    };
    worker.shutdown().await.unwrap();
    let reopened = Worker::open(path, WorkerConfig::default()).await.unwrap();
    let next = reopened.client();
    let Response::Attempt(status) = submit(&next, || {
        Command::Attempt(owner.clone(), ticket.attempt_id().clone())
    })
    .await
    .await
    .unwrap() else {
        panic!()
    };
    assert_eq!(status.outcome, None);
    assert!(matches!(
        submit(&next, candidates).await.await,
        Err(OperationError::Store(StoreError::RecoveryRequired))
    ));
    let Response::Recovered(count) = submit(&next, || Command::Recover(owner.clone()))
        .await
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(count, 1);
    let Response::Attempt(status) = submit(&next, || {
        Command::Attempt(owner.clone(), ticket.attempt_id().clone())
    })
    .await
    .await
    .unwrap() else {
        panic!()
    };
    assert_eq!(status.outcome, Some(AttemptOutcome::Uncertain));
    reopened.shutdown().await.unwrap();
}
#[tokio::test]
async fn companion_reads_reserve_their_page_bound_and_leave_a_small_response_slot() {
    let (worker, client, owner, sender, recipient, group) = fixture("companion-reservations").await;
    assert_eq!(OPERATION_NAMES.len(), 31);
    // A 32 MiB message-page reservation plus an 8 MiB metadata-page
    // reservation, both unpolled, leave the default 64 MiB response budget
    // unable to admit a second message page but still able to admit small
    // control operations.
    let thread = submit(&client, || {
        Command::ReadThread(
            recipient.principal.clone(),
            ThreadPageRequest {
                group_id: group.group_id.clone(),
                root: MessageId::generate(),
                navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
                max_items: 1,
            },
        )
    })
    .await;
    let peers = submit(&client, || {
        Command::ListPeers(
            recipient.principal.clone(),
            ListPeersRequest {
                group_id: group.group_id.clone(),
                after_peer: None,
                max_items: 8,
            },
        )
    })
    .await;
    submit(&client, || Command::TrustedOwner)
        .await
        .await
        .unwrap();
    assert!(matches!(
        admit(&client, || Command::ReadMailboxAfter(
            recipient.principal.clone(),
            MailboxAfterRequest {
                group_id: group.group_id.clone(),
                navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
                max_items: 1
            }
        ))
        .await,
        Err(AdmissionError::ResponseBytes)
    ));
    let metrics = client.metrics();
    assert_eq!(metrics.max_response_reservation, 32 * 1024 * 1024);
    assert!(metrics.response_reserved_bytes >= 40 * 1024 * 1024);
    let Response::SelfView(view) = submit(&client, || {
        Command::WhoAmI(
            sender.principal.clone(),
            WhoAmIRequest {
                after_group: None,
                max_items: 8,
            },
        )
    })
    .await
    .await
    .unwrap() else {
        panic!("self view")
    };
    assert_eq!(view.memberships.len(), 1);
    assert!(matches!(
        thread.await,
        Err(OperationError::Store(StoreError::NotFound { .. }))
    ));
    let Response::Peers(page) = peers.await.unwrap() else {
        panic!("peer page")
    };
    assert_eq!(page.peers.len(), 2);
    let Response::Revisions(revisions) = submit(&client, || Command::StateRevisions(owner.clone()))
        .await
        .await
        .unwrap()
    else {
        panic!("revisions")
    };
    assert!(revisions.inventory_revision.get() > 1);
    worker.shutdown().await.unwrap();
    let metrics = client.metrics();
    assert_eq!(metrics.responses, 0);
    assert_eq!(metrics.response_reserved_bytes, 0);
    for (index, name) in [
        (18, "whoami"),
        (19, "list_peers"),
        (22, "thread"),
        (30, "state_revisions"),
    ] {
        assert_eq!(OPERATION_NAMES[index], name);
        assert_eq!(
            metrics.operation_latency_buckets[index].iter().sum::<u64>(),
            1,
            "{name}"
        );
    }
    assert_eq!(
        metrics.operation_latency_buckets[21].iter().sum::<u64>(),
        0,
        "rejected read never ran"
    );
}
