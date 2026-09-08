mod support;

use rusqlite::Connection;
use termx_swarm_core::{error::StoreError, model::*, store::Store, worker::*};

fn binding(name: &str) -> VerifiedBinding {
    VerifiedBinding::trusted(
        LaunchId::generate().as_str().into(),
        format!("terminal-{name}"),
        "synthetic".into(),
        format!("conversation-{name}"),
        None,
        100,
        1000,
        true,
    )
    .unwrap()
}

struct Fixture {
    path: std::path::PathBuf,
    store: Store,
    owner: OwnerPrincipal,
    alice: EnrolledPeer,
    bob: EnrolledPeer,
    carol: EnrolledPeer,
    group: GroupRecord,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let path = support::retained_db(name);
        let mut store = Store::open(&path).unwrap();
        let owner = store.trusted_owner();
        let alice = store.enroll_peer(&owner, binding("alice")).unwrap();
        let bob = store.enroll_peer(&owner, binding("bob")).unwrap();
        let carol = store.enroll_peer(&owner, binding("carol")).unwrap();
        let group = store
            .create_group(
                &owner,
                "group",
                [alice.record.peer_id.clone(), bob.record.peer_id.clone()].into(),
            )
            .unwrap();
        store.recover_trusted_new_run(&owner).unwrap();
        Self {
            path,
            store,
            owner,
            alice,
            bob,
            carol,
            group,
        }
    }

    fn send(&mut self, key: &str) -> SendReceipt {
        self.store
            .send_message(
                &self.alice.principal,
                SendMessageRequest {
                    group_id: self.group.group_id.clone(),
                    client_key: key.into(),
                    recipients: [self.bob.record.peer_id.clone()].into(),
                    body: format!("body-{key}"),
                    topic: None,
                    reply_to: None,
                    attachments: Vec::new(),
                },
            )
            .unwrap()
    }

    fn candidate(&mut self) -> NoticeCandidate {
        self.store
            .notice_gaps(&self.owner, None, 8)
            .unwrap()
            .candidates()[0]
            .clone()
    }

    fn ticket(&mut self) -> NoticeTicket {
        let candidate = self.candidate();
        self.store.begin_notice(&self.owner, &candidate).unwrap()
    }
}

fn receipt(ticket: &NoticeTicket, item: &str) -> VerifiedNoticeReceipt {
    VerifiedNoticeReceipt::trusted(
        ticket.attempt_id().clone(),
        ticket.recipient_binding(),
        "synthetic-native-record".into(),
        "synthetic-owned-provenance".into(),
        "synthetic-enrolled-source".into(),
        "synthetic-source-generation".into(),
        item.into(),
    )
    .unwrap()
}

#[test]
fn send_projects_notice_coverage_in_the_same_commit() {
    let path = support::retained_db("notice-red-send-coverage");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let alice = store.enroll_peer(&owner, binding("alice")).unwrap();
    let bob = store.enroll_peer(&owner, binding("bob")).unwrap();
    let group = store
        .create_group(
            &owner,
            "group",
            [alice.record.peer_id.clone(), bob.record.peer_id.clone()].into(),
        )
        .unwrap();
    store.recover_trusted_new_run(&owner).unwrap();
    let saved = store
        .send_message(
            &alice.principal,
            SendMessageRequest {
                group_id: group.group_id.clone(),
                client_key: "one".into(),
                recipients: [bob.record.peer_id.clone()].into(),
                body: "saved before notice scheduling".into(),
                topic: None,
                reply_to: None,
                attachments: Vec::new(),
            },
        )
        .unwrap();
    drop(store);

    let connection = Connection::open(path).unwrap();
    let coverage = connection
        .query_row(
            "SELECT covered_through_sequence, noticed_through_sequence \
             FROM notice_coverage \
             WHERE recipient_peer_id=?1 AND recipient_binding_revision=?2 AND group_id=?3",
            rusqlite::params![
                bob.record.peer_id.as_str(),
                bob.record.revision.as_sql_i64(),
                group.group_id.as_str()
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .unwrap();
    assert_eq!(coverage, (saved.group_sequence as i64, 0));
}

#[test]
fn reopen_requires_explicit_recovery_before_gap_or_begin_dispatch() {
    let mut f = Fixture::new("notice-reopen-recovery-gate");
    f.send("one");
    let candidate = f.candidate();
    drop(f.store);
    let mut reopened = Store::open(&f.path).unwrap();
    assert!(matches!(
        reopened.notice_gaps(&f.owner, None, 8),
        Err(StoreError::RecoveryRequired)
    ));
    assert!(matches!(
        reopened.begin_notice(&f.owner, &candidate),
        Err(StoreError::RecoveryRequired)
    ));
    reopened.recover_trusted_new_run(&f.owner).unwrap();
    assert_eq!(
        reopened
            .notice_gaps(&f.owner, None, 8)
            .unwrap()
            .candidates()
            .len(),
        1
    );
}

#[test]
fn native_queued_advertises_only_the_frozen_group_range_and_remainder_gets_a_new_ticket() {
    let path = support::retained_db("notice-red-native-queued-remainder");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let alice = store.enroll_peer(&owner, binding("alice")).unwrap();
    let bob = store.enroll_peer(&owner, binding("bob")).unwrap();
    let group = store
        .create_group(
            &owner,
            "group",
            [alice.record.peer_id.clone(), bob.record.peer_id.clone()].into(),
        )
        .unwrap();
    store.recover_trusted_new_run(&owner).unwrap();
    for key in ["one", "two"] {
        store
            .send_message(
                &alice.principal,
                SendMessageRequest {
                    group_id: group.group_id.clone(),
                    client_key: key.into(),
                    recipients: [bob.record.peer_id.clone()].into(),
                    body: key.into(),
                    topic: None,
                    reply_to: None,
                    attachments: Vec::new(),
                },
            )
            .unwrap();
    }

    let page = store.notice_gaps(&owner, None, 8).unwrap();
    assert_eq!(page.candidates().len(), 1);
    assert_eq!(
        page.candidates()[0].groups()[0].covered_through_sequence(),
        2
    );
    let first = store.begin_notice(&owner, &page.candidates()[0]).unwrap();
    assert!(store
        .notice_gaps(&owner, None, 8)
        .unwrap()
        .candidates()
        .is_empty());
    let status = store
        .complete_notice(&owner, first.attempt_id(), AttemptOutcome::NativeQueued)
        .unwrap();
    assert_eq!(status.outcome(), Some(AttemptOutcome::NativeQueued));
    assert!(store
        .notice_gaps(&owner, None, 8)
        .unwrap()
        .candidates()
        .is_empty());

    store
        .send_message(
            &alice.principal,
            SendMessageRequest {
                group_id: group.group_id,
                client_key: "three".into(),
                recipients: [bob.record.peer_id.clone()].into(),
                body: "three".into(),
                topic: None,
                reply_to: None,
                attachments: Vec::new(),
            },
        )
        .unwrap();
    let remainder = store.notice_gaps(&owner, None, 8).unwrap();
    assert_eq!(remainder.candidates().len(), 1);
    assert_eq!(
        remainder.candidates()[0].groups()[0].covered_through_sequence(),
        3
    );
    let second = store
        .begin_notice(&owner, &remainder.candidates()[0])
        .unwrap();
    assert_ne!(first.attempt_id(), second.attempt_id());
}

#[test]
fn unresolved_nondefinitive_outcomes_block_a_second_notice_after_new_mail() {
    for outcome in [
        AttemptOutcome::Held,
        AttemptOutcome::TransportWritten,
        AttemptOutcome::Uncertain,
    ] {
        let mut f = Fixture::new("notice-unresolved-outcome");
        f.send("one");
        let ticket = f.ticket();
        f.store
            .complete_notice(&f.owner, ticket.attempt_id(), outcome)
            .unwrap();
        f.send("two");
        assert!(f
            .store
            .notice_gaps(&f.owner, None, 8)
            .unwrap()
            .candidates()
            .is_empty());
    }
}

#[test]
fn new_mail_during_an_unfinished_attempt_waits_through_uncertain_completion() {
    let mut f = Fixture::new("notice-new-mail-during-attempt");
    f.send("one");
    let ticket = f.ticket();
    f.send("two");
    assert!(f
        .store
        .notice_gaps(&f.owner, None, 8)
        .unwrap()
        .candidates()
        .is_empty());
    f.store
        .complete_notice(&f.owner, ticket.attempt_id(), AttemptOutcome::Uncertain)
        .unwrap();
    assert!(f
        .store
        .notice_gaps(&f.owner, None, 8)
        .unwrap()
        .candidates()
        .is_empty());
}

#[test]
fn transport_written_remainder_waits_for_the_exact_attempt_receipt() {
    let mut f = Fixture::new("notice-transport-written-receipt");
    f.send("one");
    let ticket = f.ticket();
    f.store
        .complete_notice(
            &f.owner,
            ticket.attempt_id(),
            AttemptOutcome::TransportWritten,
        )
        .unwrap();
    f.send("two");
    assert!(f
        .store
        .notice_gaps(&f.owner, None, 8)
        .unwrap()
        .candidates()
        .is_empty());
    f.store
        .record_notice_receipt(&f.owner, receipt(&ticket, "synthetic-exact-item"))
        .unwrap();
    let remainder = f.candidate();
    assert_eq!(remainder.groups()[0].covered_through_sequence(), 2);
}

async fn admit(client: &Client, make: impl Fn() -> Command) -> Pending {
    loop {
        match client.submit(make()) {
            Ok(pending) => return pending,
            Err(AdmissionError::Contended) => tokio::task::yield_now().await,
            Err(error) => panic!("admission failed: {error}"),
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn worker_dispatches_and_accounts_for_all_six_notice_operations() {
    let worker = Worker::open(
        support::retained_db("notice-red-worker-operations"),
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
        panic!("owner response")
    };
    let Response::Enrolled(alice) =
        admit(&client, || Command::Enroll(owner.clone(), binding("alice")))
            .await
            .await
            .unwrap()
    else {
        panic!("alice response")
    };
    let Response::Enrolled(bob) = admit(&client, || Command::Enroll(owner.clone(), binding("bob")))
        .await
        .await
        .unwrap()
    else {
        panic!("bob response")
    };
    let Response::Group(group) = admit(&client, || {
        Command::CreateGroup(
            owner.clone(),
            "group".into(),
            [alice.record.peer_id.clone(), bob.record.peer_id.clone()].into(),
        )
    })
    .await
    .await
    .unwrap() else {
        panic!("group response")
    };
    let _ = admit(&client, || Command::Recover(owner.clone()))
        .await
        .await
        .unwrap();
    let request = |key: &str| SendMessageRequest {
        group_id: group.group_id.clone(),
        client_key: key.into(),
        recipients: [bob.record.peer_id.clone()].into(),
        body: key.into(),
        topic: None,
        reply_to: None,
        attachments: Vec::new(),
    };
    let one = request("one");
    let _ = admit(&client, || {
        Command::Send(alice.principal.clone(), one.clone())
    })
    .await
    .await
    .unwrap();
    let Response::NoticeCandidates(page) =
        admit(&client, || Command::NoticeGaps(owner.clone(), None, 8))
            .await
            .await
            .unwrap()
    else {
        panic!("notice gaps response")
    };
    let candidate = page.candidates()[0].clone();
    let Response::NoticeTicket(first) = admit(&client, || {
        Command::BeginNotice(owner.clone(), candidate.clone())
    })
    .await
    .await
    .unwrap() else {
        panic!("notice ticket response")
    };
    let first_id = first.attempt_id().clone();
    let Response::NoticeAttempt(status) = admit(&client, || {
        Command::NoticeAttempt(owner.clone(), first_id.clone())
    })
    .await
    .await
    .unwrap() else {
        panic!("notice attempt response")
    };
    assert_eq!(status.outcome(), None);
    let receipt = VerifiedNoticeReceipt::trusted(
        first_id.clone(),
        first.recipient_binding(),
        "synthetic-record".into(),
        "synthetic-provenance".into(),
        "synthetic-source".into(),
        "synthetic-generation".into(),
        "synthetic-item-1".into(),
    )
    .unwrap();
    let _ = admit(&client, || {
        Command::RecordNoticeReceipt(owner.clone(), receipt.clone())
    })
    .await
    .await
    .unwrap();
    let _ = admit(&client, || {
        Command::CompleteNotice(
            owner.clone(),
            first_id.clone(),
            AttemptOutcome::TransportWritten,
        )
    })
    .await
    .await
    .unwrap();

    let two = request("two");
    let _ = admit(&client, || {
        Command::Send(alice.principal.clone(), two.clone())
    })
    .await
    .await
    .unwrap();
    let Response::NoticeCandidates(page) =
        admit(&client, || Command::NoticeGaps(owner.clone(), None, 8))
            .await
            .await
            .unwrap()
    else {
        panic!("notice remainder response")
    };
    let candidate = page.candidates()[0].clone();
    let Response::NoticeTicket(second) = admit(&client, || {
        Command::BeginNotice(owner.clone(), candidate.clone())
    })
    .await
    .await
    .unwrap() else {
        panic!("second ticket response")
    };
    let second_id = second.attempt_id().clone();
    let _ = admit(&client, || {
        Command::CompleteNotice(owner.clone(), second_id.clone(), AttemptOutcome::Held)
    })
    .await
    .await
    .unwrap();
    let reconcile =
        VerifiedNoticeNotSubmitted::trusted(second_id.clone(), "synthetic-proof".into()).unwrap();
    let _ = admit(&client, || {
        Command::ReconcileNotice(owner.clone(), reconcile.clone())
    })
    .await
    .await
    .unwrap();

    worker.shutdown().await.unwrap();
    let metrics = client.metrics();
    for index in 31..37 {
        assert!(
            metrics.operation_latency_buckets[index].iter().sum::<u64>() >= 1,
            "notice operation {index} was not accounted"
        );
    }
    assert_eq!(metrics.request_bytes, 0);
    assert_eq!(metrics.responses, 0);
    assert!(metrics.max_response_estimated_bytes <= 64 * 1024);
}

#[test]
fn receipt_during_unfinished_submission_keeps_gate_until_compatible_completion() {
    let mut f = Fixture::new("notice-receipt-before-completion");
    f.send("one");
    let ticket = f.ticket();
    let evidence = receipt(&ticket, "native-item-one");
    let status = f
        .store
        .record_notice_receipt(&f.owner, evidence.clone())
        .unwrap();
    assert_eq!(status.outcome(), None);
    assert!(status.receipt().is_some());
    f.send("two");
    assert!(f
        .store
        .notice_gaps(&f.owner, None, 8)
        .unwrap()
        .candidates()
        .is_empty());
    assert!(matches!(
        f.store.complete_notice(
            &f.owner,
            ticket.attempt_id(),
            AttemptOutcome::KnownNotSubmitted
        ),
        Err(StoreError::AttemptConflict)
    ));
    f.store
        .complete_notice(
            &f.owner,
            ticket.attempt_id(),
            AttemptOutcome::TransportWritten,
        )
        .unwrap();
    let remainder = f.store.notice_gaps(&f.owner, None, 8).unwrap();
    assert_eq!(remainder.candidates().len(), 1);
    assert_eq!(
        remainder.candidates()[0].groups()[0].covered_through_sequence(),
        2
    );
}

#[test]
fn receipt_during_unfinished_submission_keeps_gate_until_recovery() {
    let mut f = Fixture::new("notice-receipt-before-recovery");
    f.send("one");
    let ticket = f.ticket();
    f.store
        .record_notice_receipt(&f.owner, receipt(&ticket, "native-item-one"))
        .unwrap();
    f.send("two");
    drop(f.store);
    let mut reopened = Store::open(&f.path).unwrap();
    assert!(matches!(
        reopened.notice_gaps(&f.owner, None, 8),
        Err(StoreError::RecoveryRequired)
    ));
    assert_eq!(reopened.recover_trusted_new_run(&f.owner).unwrap(), 0);
    let status = reopened
        .notice_attempt(&f.owner, ticket.attempt_id())
        .unwrap();
    assert_eq!(status.outcome(), Some(AttemptOutcome::Uncertain));
    assert!(status.recovered_uncertain_at_millis().is_some());
    assert!(status.receipt().is_some());
    let remainder = reopened.notice_gaps(&f.owner, None, 8).unwrap();
    assert_eq!(remainder.candidates().len(), 1);
    assert_eq!(
        remainder.candidates()[0].groups()[0].covered_through_sequence(),
        2
    );
}

#[test]
fn receipt_and_known_not_submitted_conflict_in_both_orders() {
    let mut first = Fixture::new("notice-known-first");
    first.send("one");
    let ticket = first.ticket();
    first
        .store
        .complete_notice(
            &first.owner,
            ticket.attempt_id(),
            AttemptOutcome::KnownNotSubmitted,
        )
        .unwrap();
    assert!(matches!(
        first
            .store
            .record_notice_receipt(&first.owner, receipt(&ticket, "late-item")),
        Err(StoreError::AttemptConflict)
    ));
    assert!(first
        .store
        .notice_attempt(&first.owner, ticket.attempt_id())
        .unwrap()
        .receipt()
        .is_none());

    let mut second = Fixture::new("notice-receipt-first");
    second.send("one");
    let ticket = second.ticket();
    second
        .store
        .record_notice_receipt(&second.owner, receipt(&ticket, "first-item"))
        .unwrap();
    assert!(matches!(
        second.store.complete_notice(
            &second.owner,
            ticket.attempt_id(),
            AttemptOutcome::KnownNotSubmitted
        ),
        Err(StoreError::AttemptConflict)
    ));
    let status = second
        .store
        .notice_attempt(&second.owner, ticket.attempt_id())
        .unwrap();
    assert_eq!(status.outcome(), None);
    assert_eq!(status.receipt().unwrap().native_item_identity, "first-item");
}

#[test]
fn receipt_and_verified_non_submission_conflict_in_both_orders() {
    let mut first = Fixture::new("notice-reconcile-first");
    first.send("one");
    let ticket = first.ticket();
    first
        .store
        .complete_notice(&first.owner, ticket.attempt_id(), AttemptOutcome::Held)
        .unwrap();
    first
        .store
        .reconcile_notice_not_submitted(
            &first.owner,
            VerifiedNoticeNotSubmitted::trusted(ticket.attempt_id().clone(), "proof-one".into())
                .unwrap(),
        )
        .unwrap();
    assert!(matches!(
        first
            .store
            .record_notice_receipt(&first.owner, receipt(&ticket, "late-item")),
        Err(StoreError::AttemptConflict)
    ));

    let mut second = Fixture::new("notice-receipt-before-reconcile");
    second.send("one");
    let ticket = second.ticket();
    second
        .store
        .record_notice_receipt(&second.owner, receipt(&ticket, "first-item"))
        .unwrap();
    second
        .store
        .complete_notice(
            &second.owner,
            ticket.attempt_id(),
            AttemptOutcome::TransportWritten,
        )
        .unwrap();
    assert!(matches!(
        second.store.reconcile_notice_not_submitted(
            &second.owner,
            VerifiedNoticeNotSubmitted::trusted(ticket.attempt_id().clone(), "proof-two".into(),)
                .unwrap()
        ),
        Err(StoreError::AttemptConflict)
    ));
}

#[test]
fn native_queued_and_verified_non_submission_conflict_in_both_orders() {
    let mut queued = Fixture::new("notice-queued-first");
    queued.send("one");
    let ticket = queued.ticket();
    queued
        .store
        .complete_notice(
            &queued.owner,
            ticket.attempt_id(),
            AttemptOutcome::NativeQueued,
        )
        .unwrap();
    assert!(matches!(
        queued.store.reconcile_notice_not_submitted(
            &queued.owner,
            VerifiedNoticeNotSubmitted::trusted(
                ticket.attempt_id().clone(),
                "impossible-cancel".into(),
            )
            .unwrap()
        ),
        Err(StoreError::AttemptConflict)
    ));

    let mut delayed = Fixture::new("notice-reconcile-before-queued");
    delayed.send("one");
    let ticket = delayed.ticket();
    drop(delayed.store);
    let mut store = Store::open(&delayed.path).unwrap();
    store.recover_trusted_new_run(&delayed.owner).unwrap();
    store
        .reconcile_notice_not_submitted(
            &delayed.owner,
            VerifiedNoticeNotSubmitted::trusted(
                ticket.attempt_id().clone(),
                "verified-never-submitted".into(),
            )
            .unwrap(),
        )
        .unwrap();
    assert!(matches!(
        store.complete_notice(
            &delayed.owner,
            ticket.attempt_id(),
            AttemptOutcome::NativeQueued
        ),
        Err(StoreError::AttemptConflict)
    ));
    assert_eq!(
        store
            .notice_attempt(&delayed.owner, ticket.attempt_id())
            .unwrap()
            .outcome(),
        Some(AttemptOutcome::Uncertain)
    );
}

#[test]
fn transport_written_and_held_coexist_with_verified_non_submission() {
    for outcome in [AttemptOutcome::TransportWritten, AttemptOutcome::Held] {
        let mut f = Fixture::new("notice-reconcile-compatible");
        f.send("one");
        let ticket = f.ticket();
        f.store
            .complete_notice(&f.owner, ticket.attempt_id(), outcome)
            .unwrap();
        f.store
            .reconcile_notice_not_submitted(
                &f.owner,
                VerifiedNoticeNotSubmitted::trusted(
                    ticket.attempt_id().clone(),
                    "verified-never-submitted".into(),
                )
                .unwrap(),
            )
            .unwrap();
        let status = f
            .store
            .notice_attempt(&f.owner, ticket.attempt_id())
            .unwrap();
        assert_eq!(status.outcome(), Some(outcome));
        assert!(status.reconciled_not_submitted_at_millis().is_some());
        assert_eq!(
            f.store
                .notice_gaps(&f.owner, None, 8)
                .unwrap()
                .candidates()
                .len(),
            1
        );
    }
}

#[test]
fn receipt_retry_uses_stable_evidence_and_preserves_the_first_observation() {
    let mut f = Fixture::new("notice-receipt-idempotence");
    f.send("one");
    let ticket = f.ticket();
    let same = receipt(&ticket, "native-item");
    let first = f
        .store
        .record_notice_receipt(&f.owner, same.clone())
        .unwrap();
    let repeated = f.store.record_notice_receipt(&f.owner, same).unwrap();
    assert_eq!(first.receipt(), repeated.receipt());
    let original_time = first.receipt().unwrap().received_at_millis;
    for changed in [
        VerifiedNoticeReceipt::trusted(
            ticket.attempt_id().clone(),
            ticket.recipient_binding(),
            "other-kind".into(),
            "synthetic-owned-provenance".into(),
            "synthetic-enrolled-source".into(),
            "synthetic-source-generation".into(),
            "native-item".into(),
        )
        .unwrap(),
        receipt(&ticket, "different-native-item"),
    ] {
        assert!(matches!(
            f.store.record_notice_receipt(&f.owner, changed),
            Err(StoreError::AttemptConflict)
        ));
    }
    assert_eq!(
        f.store
            .notice_attempt(&f.owner, ticket.attempt_id())
            .unwrap()
            .receipt()
            .unwrap()
            .received_at_millis,
        original_time
    );
}

#[test]
fn continuation_projects_only_transferred_rows_and_late_predecessor_receipt_is_isolated() {
    let mut f = Fixture::new("notice-continuation-isolation");
    f.send("one");
    let ticket = f.ticket();
    let successor_binding = VerifiedBinding::trusted(
        LaunchId::generate().as_str().into(),
        "terminal-bob-successor".into(),
        f.bob.record.harness.clone(),
        f.bob.record.conversation_id.clone(),
        None,
        101,
        1001,
        true,
    )
    .unwrap();
    let evidence = VerifiedContinuation::trusted(
        &f.bob.record,
        successor_binding,
        "synthetic-same-branch".into(),
    )
    .unwrap();
    let successor = f
        .store
        .continue_peer(
            &f.owner,
            evidence,
            "continue",
            [(f.group.group_id.clone(), f.group.policy_revision)].into(),
        )
        .unwrap();
    let page = f.store.notice_gaps(&f.owner, None, 8).unwrap();
    assert_eq!(page.candidates().len(), 1);
    assert_eq!(
        page.candidates()[0].binding_revision(),
        successor.record.revision
    );
    f.store
        .record_notice_receipt(&f.owner, receipt(&ticket, "predecessor-item"))
        .unwrap();
    let page = f.store.notice_gaps(&f.owner, None, 8).unwrap();
    assert_eq!(page.candidates().len(), 1);
    assert_eq!(
        page.candidates()[0].binding_revision(),
        successor.record.revision
    );
    assert_eq!(
        page.candidates()[0].groups()[0].covered_through_sequence(),
        1
    );
}

#[test]
fn policy_only_changes_refresh_candidates_without_a_new_send() {
    let mut f = Fixture::new("notice-live-policy");
    f.send("one");
    let stale = f.candidate();
    let paused = f
        .store
        .set_group_paused(&f.owner, &f.group.group_id, true, f.group.policy_revision)
        .unwrap();
    assert!(f
        .store
        .notice_gaps(&f.owner, None, 8)
        .unwrap()
        .candidates()
        .is_empty());
    assert!(matches!(
        f.store.begin_notice(&f.owner, &stale),
        Err(StoreError::GroupPaused | StoreError::StalePolicy { .. })
    ));
    let unpaused = f
        .store
        .set_group_paused(&f.owner, &f.group.group_id, false, paused.policy_revision)
        .unwrap();
    let refreshed = f.candidate();
    assert_eq!(
        refreshed.groups()[0].policy_revision(),
        unpaused.policy_revision
    );

    let changed = f
        .store
        .set_membership(
            &f.owner,
            &f.group.group_id,
            &f.carol.record.peer_id,
            true,
            unpaused.policy_revision,
        )
        .unwrap();
    let refreshed_again = f.candidate();
    assert_eq!(
        refreshed_again.groups()[0].policy_revision(),
        changed.policy_revision
    );
}

#[test]
fn pause_during_an_attempt_allows_late_completion_but_unpause_does_not_retry_it() {
    let mut f = Fixture::new("notice-pause-in-flight");
    f.send("one");
    let ticket = f.ticket();
    let paused = f
        .store
        .set_group_paused(&f.owner, &f.group.group_id, true, f.group.policy_revision)
        .unwrap();
    let status = f
        .store
        .complete_notice(
            &f.owner,
            ticket.attempt_id(),
            AttemptOutcome::TransportWritten,
        )
        .unwrap();
    assert_eq!(status.outcome(), Some(AttemptOutcome::TransportWritten));
    assert!(f
        .store
        .notice_gaps(&f.owner, None, 8)
        .unwrap()
        .candidates()
        .is_empty());
    f.store
        .set_group_paused(&f.owner, &f.group.group_id, false, paused.policy_revision)
        .unwrap();
    assert!(f
        .store
        .notice_gaps(&f.owner, None, 8)
        .unwrap()
        .candidates()
        .is_empty());
}

#[test]
fn partial_fetch_before_notice_keeps_a_gap_but_advertised_suffix_is_not_resent() {
    let mut f = Fixture::new("notice-partial-fetch");
    f.send("one");
    f.send("two");
    let page = f
        .store
        .read_mailbox(
            &f.bob.principal,
            MailboxPageRequest {
                group_id: f.group.group_id.clone(),
                cursor: None,
                max_items: 1,
            },
        )
        .unwrap();
    assert_eq!(page.messages.len(), 1);
    assert_eq!(f.candidate().groups()[0].covered_through_sequence(), 2);
    let ticket = f.ticket();
    f.store
        .complete_notice(&f.owner, ticket.attempt_id(), AttemptOutcome::NativeQueued)
        .unwrap();
    assert!(f
        .store
        .notice_gaps(&f.owner, None, 8)
        .unwrap()
        .candidates()
        .is_empty());
}

#[test]
fn reset_after_a_high_sequence_does_not_hide_lower_unfetched_deliveries() {
    let mut f = Fixture::new("notice-reset-after-future");
    for index in 1..=100 {
        f.send(&format!("reset-{index}"));
    }
    let suffix = f
        .store
        .read_mailbox_after(
            &f.bob.principal,
            MailboxAfterRequest {
                group_id: f.group.group_id.clone(),
                navigation: MailboxNavigation::ResetAfter { after_sequence: 90 },
                max_items: 8,
            },
        )
        .unwrap();
    assert_eq!(suffix.messages.len(), 8);
    assert_eq!(suffix.messages[0].message.group_sequence, 91);
    let candidate = f.candidate();
    assert_eq!(candidate.groups()[0].covered_through_sequence(), 100);
}

#[test]
fn per_group_maxima_do_not_resend_an_already_advertised_group() {
    let mut f = Fixture::new("notice-per-group-maxima");
    let second_group = f
        .store
        .create_group(
            &f.owner,
            "second",
            [f.alice.record.peer_id.clone(), f.bob.record.peer_id.clone()].into(),
        )
        .unwrap();
    for index in 0..100 {
        f.send(&format!("a-{index}"));
    }
    f.store
        .send_message(
            &f.alice.principal,
            SendMessageRequest {
                group_id: second_group.group_id.clone(),
                client_key: "b-1".into(),
                recipients: [f.bob.record.peer_id.clone()].into(),
                body: "b-1".into(),
                topic: None,
                reply_to: None,
                attachments: Vec::new(),
            },
        )
        .unwrap();
    let ticket = f.ticket();
    assert_eq!(ticket.candidate().groups().len(), 2);
    f.store
        .complete_notice(&f.owner, ticket.attempt_id(), AttemptOutcome::NativeQueued)
        .unwrap();
    f.store
        .send_message(
            &f.alice.principal,
            SendMessageRequest {
                group_id: second_group.group_id.clone(),
                client_key: "b-2".into(),
                recipients: [f.bob.record.peer_id.clone()].into(),
                body: "b-2".into(),
                topic: None,
                reply_to: None,
                attachments: Vec::new(),
            },
        )
        .unwrap();
    let remainder = f.candidate();
    assert_eq!(remainder.groups().len(), 1);
    assert_eq!(remainder.groups()[0].group_id(), &second_group.group_id);
    assert_eq!(remainder.groups()[0].covered_through_sequence(), 2);
}

#[test]
fn a_held_binding_does_not_block_another_recipient_binding() {
    let mut f = Fixture::new("notice-held-peer-isolation");
    f.group = f
        .store
        .set_membership(
            &f.owner,
            &f.group.group_id,
            &f.carol.record.peer_id,
            true,
            f.group.policy_revision,
        )
        .unwrap();
    f.store
        .send_message(
            &f.alice.principal,
            SendMessageRequest {
                group_id: f.group.group_id.clone(),
                client_key: "both".into(),
                recipients: [f.bob.record.peer_id.clone(), f.carol.record.peer_id.clone()].into(),
                body: "both".into(),
                topic: None,
                reply_to: None,
                attachments: Vec::new(),
            },
        )
        .unwrap();
    let page = f.store.notice_gaps(&f.owner, None, 8).unwrap();
    let bob = page
        .candidates()
        .iter()
        .find(|candidate| candidate.recipient_peer_id() == &f.bob.record.peer_id)
        .unwrap()
        .clone();
    let ticket = f.store.begin_notice(&f.owner, &bob).unwrap();
    f.store
        .complete_notice(&f.owner, ticket.attempt_id(), AttemptOutcome::Held)
        .unwrap();
    let remaining = f.store.notice_gaps(&f.owner, None, 8).unwrap();
    assert_eq!(remaining.candidates().len(), 1);
    assert_eq!(
        remaining.candidates()[0].recipient_peer_id(),
        &f.carol.record.peer_id
    );
}

#[test]
fn owner_binding_and_candidate_snapshots_are_revalidated() {
    let mut f = Fixture::new("notice-authority-and-binding-revalidation");
    f.send("one");
    let candidate = f.candidate();
    let alien_path = support::retained_db("notice-alien-owner");
    let alien = Store::open(alien_path).unwrap().trusted_owner();
    assert!(matches!(
        f.store.notice_gaps(&alien, None, 8),
        Err(StoreError::AuthorityMismatch)
    ));

    let successor = VerifiedBinding::trusted(
        LaunchId::generate().as_str().into(),
        "terminal-bob-next".into(),
        f.bob.record.harness.clone(),
        f.bob.record.conversation_id.clone(),
        None,
        101,
        1001,
        true,
    )
    .unwrap();
    let evidence =
        VerifiedContinuation::trusted(&f.bob.record, successor, "synthetic-same-branch".into())
            .unwrap();
    f.store
        .continue_peer(
            &f.owner,
            evidence,
            "replace-binding",
            [(f.group.group_id.clone(), f.group.policy_revision)].into(),
        )
        .unwrap();
    assert!(matches!(
        f.store.begin_notice(&f.owner, &candidate),
        Err(StoreError::StaleBinding | StoreError::StaleCandidate)
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn worker_recovery_counts_unfinished_notice_attempts_without_changing_body_count() {
    let path = support::retained_db("notice-worker-recovery-metric");
    let worker = Worker::open(path.clone(), WorkerConfig::default())
        .await
        .unwrap();
    let client = worker.client();
    let Response::Owner(owner) = admit(&client, || Command::TrustedOwner)
        .await
        .await
        .unwrap()
    else {
        panic!("owner response")
    };
    let Response::Enrolled(alice) = admit(&client, || {
        Command::Enroll(owner.clone(), binding("metric-alice"))
    })
    .await
    .await
    .unwrap() else {
        panic!("alice response")
    };
    let Response::Enrolled(bob) = admit(&client, || {
        Command::Enroll(owner.clone(), binding("metric-bob"))
    })
    .await
    .await
    .unwrap() else {
        panic!("bob response")
    };
    let Response::Group(group) = admit(&client, || {
        Command::CreateGroup(
            owner.clone(),
            "metric".into(),
            [alice.record.peer_id.clone(), bob.record.peer_id.clone()].into(),
        )
    })
    .await
    .await
    .unwrap() else {
        panic!("group response")
    };
    let _ = admit(&client, || Command::Recover(owner.clone()))
        .await
        .await
        .unwrap();
    let request = SendMessageRequest {
        group_id: group.group_id,
        client_key: "metric".into(),
        recipients: [bob.record.peer_id.clone()].into(),
        body: "metric".into(),
        topic: None,
        reply_to: None,
        attachments: Vec::new(),
    };
    let _ = admit(&client, || {
        Command::Send(alice.principal.clone(), request.clone())
    })
    .await
    .await
    .unwrap();
    let Response::NoticeCandidates(page) =
        admit(&client, || Command::NoticeGaps(owner.clone(), None, 8))
            .await
            .await
            .unwrap()
    else {
        panic!("notice candidates")
    };
    let candidate = page.candidates()[0].clone();
    let _ = admit(&client, || {
        Command::BeginNotice(owner.clone(), candidate.clone())
    })
    .await
    .await
    .unwrap();
    worker.shutdown().await.unwrap();

    let recovered = Worker::open(path, WorkerConfig::default()).await.unwrap();
    let recovered_client = recovered.client();
    assert!(matches!(
        admit(&recovered_client, || Command::Recover(owner.clone()))
            .await
            .await
            .unwrap(),
        Response::Recovered(0)
    ));
    recovered.shutdown().await.unwrap();
    assert_eq!(
        recovered_client
            .metrics()
            .notice_attempts_recovered_uncertain,
        1
    );
}

#[test]
fn forty_groups_are_reachable_in_slices_without_a_lifetime_quota() {
    let path = support::retained_db("notice-forty-groups");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let alice = store.enroll_peer(&owner, binding("alice-many")).unwrap();
    let bob = store.enroll_peer(&owner, binding("bob-many")).unwrap();
    store.recover_trusted_new_run(&owner).unwrap();
    for index in 0..40 {
        let group = store
            .create_group(
                &owner,
                &format!("group-{index:02}"),
                [alice.record.peer_id.clone(), bob.record.peer_id.clone()].into(),
            )
            .unwrap();
        store
            .send_message(
                &alice.principal,
                SendMessageRequest {
                    group_id: group.group_id,
                    client_key: format!("key-{index}"),
                    recipients: [bob.record.peer_id.clone()].into(),
                    body: "body".into(),
                    topic: None,
                    reply_to: None,
                    attachments: Vec::new(),
                },
            )
            .unwrap();
    }
    let mut cursor = None;
    let mut groups = Vec::new();
    let mut pages = 0;
    loop {
        let page = store.notice_gaps(&owner, cursor.as_ref(), 8).unwrap();
        pages += 1;
        assert!(page.estimated_retained_bytes() <= 64 * 1024);
        assert!(page.candidates().len() <= 8);
        for candidate in page.candidates() {
            assert!(candidate.groups().len() <= 16);
            groups.extend(
                candidate
                    .groups()
                    .iter()
                    .map(|group| group.group_id().clone()),
            );
        }
        cursor = page.next().cloned();
        if cursor.is_none() {
            break;
        }
    }
    groups.sort();
    groups.dedup();
    assert_eq!(groups.len(), 40);
    assert!(pages >= 3);
}
