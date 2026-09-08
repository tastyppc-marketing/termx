use super::fixture::*;
use termx_swarm_core::{error::StoreError, model::*, worker::*};

async fn error(client: &Client, make: impl Fn() -> Command, check: impl Fn(&StoreError) -> bool) {
    loop {
        match client.submit(make()) {
            Err(AdmissionError::Contended) => tokio::task::yield_now().await,
            Ok(pending) => {
                assert!(matches!(pending.await,Err(OperationError::Store(ref e)) if check(e)));
                return;
            }
            Err(e) => panic!("transition admission: {e}"),
        }
    }
}
pub async fn run(client: &Client, fixture: &mut Fixture) {
    let Response::Mailbox(frozen) = call(client, || fixture.mailbox(0, None, 128)).await else {
        panic!("snapshot")
    };
    let sequence = fixture.next[0];
    let request = fixture.request(0, sequence);
    // The exact accepted Pending is abandoned. A queued identical retry is the
    // recovery boundary; a second retry must preserve its entire original receipt.
    loop {
        match client.submit(Command::Send(fixture.sender(0), request.clone())) {
            Ok(p) => {
                drop(p);
                break;
            }
            Err(AdmissionError::Contended) => tokio::task::yield_now().await,
            Err(e) => panic!("lost reply admission: {e}"),
        }
    }
    fixture.next[0] += 1;
    let Response::Saved(saved) =
        call(client, || Command::Send(fixture.sender(0), request.clone())).await
    else {
        panic!("lost reply retry")
    };
    check_saved(&saved, &request, sequence, &fixture.sender(0));
    let Response::Saved(retry) =
        call(client, || Command::Send(fixture.sender(0), request.clone())).await
    else {
        panic!("exact retry")
    };
    assert_eq!(saved, retry);
    check_page(&frozen, 0, 0, Some(sequence - 1));
    let mut position = frozen.messages.len() as u64;
    let mut cursor = frozen.next_cursor;
    while cursor.is_some() {
        let Response::Mailbox(page) =
            call(client, || fixture.mailbox(0, cursor.clone(), 128)).await
        else {
            panic!("frozen continuation")
        };
        check_page(&page, 0, position, Some(sequence - 1));
        position += page.messages.len() as u64;
        cursor = page.next_cursor;
    }
    assert_eq!(position, sequence - 1);
    let Response::Mailbox(page) = call(client, || fixture.mailbox(0, None, 1)).await else {
        panic!("page")
    };
    for paused in [true, false] {
        let previous = fixture.groups[0].clone();
        let mut expected = previous.clone();
        expected.paused = paused;
        expected.policy_revision = Revision::new(previous.policy_revision.get() + 1).unwrap();
        let Response::Group(actual) = call(client, || {
            Command::Pause(
                fixture.owner.clone(),
                previous.group_id.clone(),
                paused,
                previous.policy_revision,
            )
        })
        .await
        else {
            panic!("pause")
        };
        assert_eq!(actual, expected);
        fixture.groups[0] = expected;
        if paused {
            error(
                client,
                || fixture.mailbox(0, None, 1),
                |e| matches!(e, StoreError::GroupPaused),
            )
            .await;
        }
    }
    error(
        client,
        || fixture.mailbox(0, page.next_cursor.clone(), 1),
        |e| matches!(e, StoreError::StaleCursor),
    )
    .await;
    for live in [false, true] {
        let mut expected = fixture.peers[1].record.clone();
        expected.is_live = live;
        let Response::Binding(actual) = call(client, || {
            Command::UpdatePeer(
                fixture.owner.clone(),
                expected.peer_id.clone(),
                expected.revision,
                PeerMetadataUpdate {
                    model_metadata: None,
                    is_live: live,
                },
            )
        })
        .await
        else {
            panic!("live")
        };
        assert_eq!(actual, expected);
        fixture.peers[1].record = expected;
        if !live {
            error(
                client,
                || fixture.mailbox(0, None, 1),
                |e| matches!(e, StoreError::BindingOffline),
            )
            .await;
        }
    }
    // Remove/re-add an overlapping member. Dedicated mailbox recipient remains stable.
    for present in [false, true] {
        let previous = fixture.groups[0].clone();
        let mut expected = previous.clone();
        expected.policy_revision = Revision::new(previous.policy_revision.get() + 1).unwrap();
        let Response::Group(actual) = call(client, || {
            Command::Membership(
                fixture.owner.clone(),
                previous.group_id.clone(),
                fixture.peers[3].record.peer_id.clone(),
                present,
                previous.policy_revision,
            )
        })
        .await
        else {
            panic!("membership")
        };
        assert_eq!(actual, expected);
        fixture.groups[0] = expected;
        if !present {
            error(
                client,
                || {
                    Command::Mailbox(
                        fixture.peers[3].principal.clone(),
                        MailboxPageRequest {
                            group_id: previous.group_id.clone(),
                            cursor: None,
                            max_items: 1,
                        },
                    )
                },
                |e| matches!(e, StoreError::Unauthorized { .. }),
            )
            .await;
        }
    }
    let Response::Candidates(candidates) = call(client, || {
        Command::Candidates(
            fixture.owner.clone(),
            fixture.groups[1].group_id.clone(),
            fixture.recipient(1).peer_id().clone(),
            fixture.recipient(1).binding_revision(),
            1,
        )
    })
    .await
    else {
        panic!("candidates")
    };
    if let Some(candidate) = candidates.first() {
        let Response::Ticket(ticket) = call(client, || {
            Command::Begin(fixture.owner.clone(), candidate.clone())
        })
        .await
        else {
            panic!("ticket")
        };
        call(client, || {
            Command::Complete(
                fixture.owner.clone(),
                ticket.attempt_id().clone(),
                AttemptOutcome::Uncertain,
            )
        })
        .await;
        let Response::Attempt(status) = call(client, || {
            Command::Attempt(fixture.owner.clone(), ticket.attempt_id().clone())
        })
        .await
        else {
            panic!("attempt")
        };
        assert_eq!(status.outcome, Some(AttemptOutcome::Uncertain));
        let Response::Mailbox(page) = call(client, || fixture.mailbox(1, None, 1)).await else {
            panic!("page")
        };
        assert!(page.messages[0].receipt.acknowledged_at_millis.is_none());
    }
    // Continue the second group's sender, which has no recipient backlog.
    // The short independent reference model separately covers backlog transfer.
    let old = fixture.peers[4].clone();
    let successor = binding(4);
    let evidence = VerifiedContinuation::trusted(
        &old.record,
        successor,
        "synthetic same-branch evidence".into(),
    )
    .unwrap();
    let Response::Enrolled(new) = call(client, || {
        Command::Continue(
            fixture.owner.clone(),
            evidence.clone(),
            format!("synthetic-intent-{}", old.record.revision.get()),
            [(
                fixture.groups[1].group_id.clone(),
                fixture.groups[1].policy_revision,
            )]
            .into(),
        )
    })
    .await
    else {
        panic!("continue")
    };
    assert_eq!(new.record.peer_id, old.record.peer_id);
    assert_eq!(new.record.revision.get(), old.record.revision.get() + 1);
    assert_eq!(new.record.conversation_id, old.record.conversation_id);
    assert_ne!(new.record.launch_id, old.record.launch_id);
    error(
        client,
        || {
            Command::Mailbox(
                old.principal.clone(),
                MailboxPageRequest {
                    group_id: fixture.groups[1].group_id.clone(),
                    cursor: None,
                    max_items: 1,
                },
            )
        },
        |e| matches!(e, StoreError::StaleBinding),
    )
    .await;
    fixture.peers[4] = new;
    // Bounded burst with unread control replies exercises actual admission.
    let mut pending = Vec::new();
    let mut rejected = [0_u64; 2];
    for _ in 0..128 {
        match client.submit(Command::TrustedOwner) {
            Ok(p) => pending.push(p),
            Err(AdmissionError::Contended) => rejected[0] += 1,
            Err(AdmissionError::Requests | AdmissionError::Responses) => rejected[1] += 1,
            Err(e) => panic!("burst admission: {e}"),
        }
    }
    let admitted = pending.len();
    for p in pending {
        assert!(matches!(p.await.unwrap(), Response::Owner(_)));
    }
    assert_eq!(admitted as u64 + rejected.iter().sum::<u64>(), 128);
    emit(
        serde_json::json!({"event":"lifecycle_barrier","pause_resume":true,"stale_cursor":true,"offline_reconnect":true,"remove_readd":true,"uncertain_no_ack":true,"sender_continuation":true,"lost_reply_stable_retry":true,"snapshot_excludes_append":true,"burst_offered":128,"burst_admitted":admitted,"burst_rejected":rejected}),
    );
}
