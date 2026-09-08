mod support;
use std::collections::BTreeMap;
use termx_swarm_core::{error::StoreError, model::*, store::Store};

fn binding(name: &str, conversation: &str) -> VerifiedBinding {
    VerifiedBinding::trusted(
        LaunchId::generate().as_str().into(),
        format!("terminal-{name}"),
        "codex".into(),
        conversation.into(),
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
        let alice = store
            .enroll_peer(&owner, binding("alice", "alice-conversation"))
            .unwrap();
        let bob = store
            .enroll_peer(&owner, binding("bob", "bob-conversation"))
            .unwrap();
        let carol = store
            .enroll_peer(&owner, binding("carol", "carol-conversation"))
            .unwrap();
        let group = store
            .create_group(
                &owner,
                "group",
                [
                    alice.record.peer_id.clone(),
                    bob.record.peer_id.clone(),
                    carol.record.peer_id.clone(),
                ]
                .into(),
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
    fn request(&self, key: &str) -> SendMessageRequest {
        SendMessageRequest {
            group_id: self.group.group_id.clone(),
            client_key: key.into(),
            recipients: [self.bob.record.peer_id.clone()].into(),
            body: format!("body-{key}"),
            topic: None,
            reply_to: None,
            attachments: Vec::new(),
        }
    }
    fn send(&mut self, key: &str) -> SendReceipt {
        self.store
            .send_message(&self.alice.principal, self.request(key))
            .unwrap()
    }
    fn candidates(&mut self) -> Vec<DeliveryCandidate> {
        self.store
            .delivery_candidates(
                &self.owner,
                &self.group.group_id,
                &self.bob.record.peer_id,
                self.bob.record.revision,
                128,
            )
            .unwrap()
    }
    fn policies(&self) -> BTreeMap<GroupId, Revision> {
        [(self.group.group_id.clone(), self.group.policy_revision)].into()
    }
    fn continuation(&self, who: &EnrolledPeer, name: &str) -> VerifiedContinuation {
        VerifiedContinuation::trusted(
            &who.record,
            binding(name, &who.record.conversation_id),
            "trusted-source-same-branch".into(),
        )
        .unwrap()
    }
}

#[test]
fn committed_ticket_is_unique_reopen_is_passive_and_explicit_recovery_fences_dispatch() {
    let mut f = Fixture::new("ticket-recovery");
    let saved = f.send("one");
    let candidate = f.candidates().remove(0);
    let ticket = f.store.begin_delivery(&f.owner, &candidate).unwrap();
    assert_eq!(ticket.message_id(), &saved.message_id);
    assert_eq!(ticket.recipient_binding(), &f.bob.record);
    assert!(f.store.begin_delivery(&f.owner, &candidate).is_err());
    let mut second = Store::open(&f.path).unwrap();
    assert_eq!(
        second
            .delivery_attempt(&f.owner, ticket.attempt_id())
            .unwrap()
            .outcome,
        None
    );
    assert!(matches!(
        second.delivery_candidates(
            &f.owner,
            &f.group.group_id,
            &f.bob.record.peer_id,
            f.bob.record.revision,
            1
        ),
        Err(StoreError::RecoveryRequired)
    ));
    assert_eq!(second.recover_trusted_new_run(&f.owner).unwrap(), 1);
    assert_eq!(
        second
            .delivery_attempt(&f.owner, ticket.attempt_id())
            .unwrap()
            .outcome,
        Some(AttemptOutcome::Uncertain)
    );
    assert!(second
        .delivery_candidates(
            &f.owner,
            &f.group.group_id,
            &f.bob.record.peer_id,
            f.bob.record.revision,
            1
        )
        .unwrap()
        .is_empty());
    assert!(matches!(
        f.store.begin_delivery(&f.owner, &candidate),
        Err(StoreError::RecoveryRequired)
    ));
    // A lost completion reply is retried by the exact ID; acceptance remains separate from ACK.
    let completed = second
        .complete_delivery(&f.owner, ticket.attempt_id(), AttemptOutcome::NativeQueued)
        .unwrap();
    assert_eq!(
        second
            .complete_delivery(&f.owner, ticket.attempt_id(), AttemptOutcome::NativeQueued)
            .unwrap(),
        completed
    );
    assert!(matches!(
        second.complete_delivery(
            &f.owner,
            ticket.attempt_id(),
            AttemptOutcome::KnownNotSubmitted
        ),
        Err(StoreError::AttemptConflict)
    ));
    let db = rusqlite::Connection::open(&f.path).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM acknowledgements", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn held_and_offline_peers_do_not_block_siblings_and_pause_keeps_late_evidence() {
    let mut f = Fixture::new("held-pause");
    let mut request = f.request("both");
    request.recipients.insert(f.carol.record.peer_id.clone());
    f.store.send_message(&f.alice.principal, request).unwrap();
    let stale = f.candidates().remove(0);
    let ticket = f.store.begin_delivery(&f.owner, &stale).unwrap();
    f.store
        .complete_delivery(&f.owner, ticket.attempt_id(), AttemptOutcome::Held)
        .unwrap();
    assert!(f.candidates().is_empty());
    let sibling = f
        .store
        .delivery_candidates(
            &f.owner,
            &f.group.group_id,
            &f.carol.record.peer_id,
            f.carol.record.revision,
            1,
        )
        .unwrap()
        .remove(0);
    let sibling_ticket = f.store.begin_delivery(&f.owner, &sibling).unwrap();
    f.group = f
        .store
        .set_group_paused(&f.owner, &f.group.group_id, true, f.group.policy_revision)
        .unwrap();
    f.store
        .complete_delivery(
            &f.owner,
            sibling_ticket.attempt_id(),
            AttemptOutcome::TransportWritten,
        )
        .unwrap();
    assert!(f
        .store
        .delivery_candidates(
            &f.owner,
            &f.group.group_id,
            &f.carol.record.peer_id,
            f.carol.record.revision,
            1
        )
        .unwrap()
        .is_empty());
    assert!(f.store.begin_delivery(&f.owner, &stale).is_err());
    f.group = f
        .store
        .set_group_paused(&f.owner, &f.group.group_id, false, f.group.policy_revision)
        .unwrap();
    f.store
        .reconcile_not_submitted(
            &f.owner,
            VerifiedNotSubmitted::trusted(
                ticket.attempt_id().clone(),
                "verified-native-item-cancelled-before-consumption".into(),
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(f.candidates().len(), 1);
    f.store
        .update_peer_metadata(
            &f.owner,
            &f.bob.record.peer_id,
            f.bob.record.revision,
            PeerMetadataUpdate {
                model_metadata: None,
                is_live: false,
            },
        )
        .unwrap();
    assert!(f.candidates().is_empty());
    f.store
        .set_membership(
            &f.owner,
            &f.group.group_id,
            &f.carol.record.peer_id,
            false,
            f.group.policy_revision,
        )
        .unwrap();
    assert!(f
        .store
        .delivery_candidates(
            &f.owner,
            &f.group.group_id,
            &f.carol.record.peer_id,
            f.carol.record.revision,
            1
        )
        .unwrap()
        .is_empty());
}

#[test]
fn continuation_moves_only_known_unreceived_backlog_and_preserves_original_retry() {
    let mut f = Fixture::new("continuation-history");
    let fetched = f.send("fetched");
    f.store
        .read_mailbox(
            &f.bob.principal,
            MailboxPageRequest {
                group_id: f.group.group_id.clone(),
                cursor: None,
                max_items: 1,
            },
        )
        .unwrap();
    let ack = f.send("ack");
    f.store
        .acknowledge_message(&f.bob.principal, &f.group.group_id, &ack.message_id)
        .unwrap();
    let queued = f.send("queued");
    let c = f.candidates().remove(0);
    let t = f.store.begin_delivery(&f.owner, &c).unwrap();
    f.store
        .complete_delivery(&f.owner, t.attempt_id(), AttemptOutcome::NativeQueued)
        .unwrap();
    let uncertain = f.send("uncertain");
    let c = f.candidates().remove(0);
    let pending_ticket = f.store.begin_delivery(&f.owner, &c).unwrap();
    let rejected = f.send("rejected");
    let c = f.candidates().remove(0);
    let old_ticket = f.store.begin_delivery(&f.owner, &c).unwrap();
    f.store
        .complete_delivery(
            &f.owner,
            old_ticket.attempt_id(),
            AttemptOutcome::KnownNotSubmitted,
        )
        .unwrap();
    let never = f.send("never");
    let evidence = f.continuation(&f.bob, "bob2");
    let policies = f.policies();
    let successor = f
        .store
        .continue_peer(
            &f.owner,
            evidence.clone(),
            "owner-intent-bob",
            policies.clone(),
        )
        .unwrap();
    assert_eq!(
        f.store
            .continue_peer(&f.owner, evidence, "owner-intent-bob", policies)
            .unwrap(),
        successor
    );
    assert!(matches!(
        f.store
            .acknowledge_message(&f.bob.principal, &f.group.group_id, &never.message_id),
        Err(StoreError::StaleBinding)
    ));
    f.store
        .complete_delivery(
            &f.owner,
            pending_ticket.attempt_id(),
            AttemptOutcome::NativeQueued,
        )
        .unwrap();
    assert!(f
        .store
        .complete_delivery(
            &f.owner,
            old_ticket.attempt_id(),
            AttemptOutcome::NativeQueued
        )
        .is_err());
    let page = f
        .store
        .read_mailbox(
            &successor.principal,
            MailboxPageRequest {
                group_id: f.group.group_id.clone(),
                cursor: None,
                max_items: 128,
            },
        )
        .unwrap();
    assert_eq!(
        page.messages
            .iter()
            .map(|e| e.message.message_id.clone())
            .collect::<Vec<_>>(),
        vec![rejected.message_id.clone(), never.message_id.clone()]
    );
    assert!(page
        .messages
        .iter()
        .all(|e| e.receipt.generation.get() == 2));
    let out_of_order = f
        .store
        .acknowledge_message(&successor.principal, &f.group.group_id, &never.message_id)
        .unwrap();
    assert_eq!(out_of_order.contiguous_group_sequence, 0);
    assert_eq!(
        f.store
            .acknowledge_message(
                &successor.principal,
                &f.group.group_id,
                &rejected.message_id
            )
            .unwrap()
            .contiguous_group_sequence,
        6
    );
    let old_reply = SendMessageRequest {
        group_id: f.group.group_id.clone(),
        client_key: "reply-to-predecessor-history".into(),
        recipients: [f.alice.record.peer_id.clone()].into(),
        body: "cannot inherit old context".into(),
        topic: None,
        reply_to: Some(fetched.message_id.clone()),
        attachments: Vec::new(),
    };
    assert!(matches!(
        f.store.send_message(&successor.principal, old_reply),
        Err(StoreError::InvalidReply)
    ));
    let alice2 = f
        .store
        .continue_peer(
            &f.owner,
            f.continuation(&f.alice, "alice2"),
            "owner-intent-alice",
            f.policies(),
        )
        .unwrap();
    assert_eq!(
        f.store
            .send_message(&alice2.principal, f.request("never"))
            .unwrap(),
        never
    );
    let mut changed = f.request("never");
    changed.body.push('!');
    assert!(matches!(
        f.store.send_message(&alice2.principal, changed),
        Err(StoreError::IdempotencyConflict)
    ));
    let db = rusqlite::Connection::open(&f.path).unwrap();
    for original in [&fetched, &ack, &queued, &uncertain] {
        let revision: i64 = db
            .query_row(
                "SELECT recipient_binding_revision FROM current_deliveries WHERE message_id=?1",
                [original.message_id.as_str()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(revision, 1);
    }
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM acknowledgements WHERE binding_revision=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
}

#[test]
fn continuation_requires_complete_fresh_group_set_and_single_global_cas_winner() {
    let mut f = Fixture::new("continuation-cas");
    let saved = f.send("one");
    let other = f
        .store
        .create_group(&f.owner, "other", [f.bob.record.peer_id.clone()].into())
        .unwrap();
    let evidence = f.continuation(&f.bob, "bob2");
    assert!(matches!(
        f.store
            .continue_peer(&f.owner, evidence.clone(), "intent", f.policies()),
        Err(StoreError::ContinuationGroups)
    ));
    let mut policies = f.policies();
    policies.insert(other.group_id.clone(), Revision::new(2).unwrap());
    assert!(matches!(
        f.store
            .continue_peer(&f.owner, evidence.clone(), "intent", policies.clone()),
        Err(StoreError::StalePolicy { .. })
    ));
    policies.insert(other.group_id.clone(), other.policy_revision);
    assert!(VerifiedContinuation::trusted(
        &f.bob.record,
        binding("unrelated", "other-conversation"),
        "branch".into()
    )
    .is_err());
    let second_evidence = f.continuation(&f.bob, "bob3");
    let mut second = Store::open(&f.path).unwrap();
    let owner = f.owner.clone();
    let second_policies = policies.clone();
    let gate = std::sync::Arc::new(std::sync::Barrier::new(2));
    let gate2 = gate.clone();
    let competitor = std::thread::spawn(move || {
        gate2.wait();
        second.continue_peer(&owner, second_evidence, "second", second_policies)
    });
    gate.wait();
    let first = f.store.continue_peer(&f.owner, evidence, "first", policies);
    let second = competitor.join().unwrap();
    assert_ne!(first.is_ok(), second.is_ok());
    let loser = if first.is_ok() { second } else { first };
    assert!(matches!(loser, Err(StoreError::StaleBinding)));
    let db = rusqlite::Connection::open(&f.path).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM continuations", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        f.store
            .send_message(&f.alice.principal, f.request("one"))
            .unwrap(),
        saved
    );
}

#[test]
fn continuation_does_not_transfer_a_native_hold_without_matching_reconciliation() {
    let mut f = Fixture::new("held-continuation");
    f.send("held");
    let c = f.candidates().remove(0);
    let t = f.store.begin_delivery(&f.owner, &c).unwrap();
    f.store
        .complete_delivery(&f.owner, t.attempt_id(), AttemptOutcome::Held)
        .unwrap();
    let successor = f
        .store
        .continue_peer(
            &f.owner,
            f.continuation(&f.bob, "bob2"),
            "continue",
            f.policies(),
        )
        .unwrap();
    let work = f
        .store
        .delivery_candidates(
            &f.owner,
            &f.group.group_id,
            &successor.record.peer_id,
            successor.record.revision,
            1,
        )
        .unwrap();
    assert!(work.is_empty());
    let page = f
        .store
        .read_mailbox(
            &successor.principal,
            MailboxPageRequest {
                group_id: f.group.group_id.clone(),
                cursor: None,
                max_items: 128,
            },
        )
        .unwrap();
    assert!(
        page.messages.is_empty(),
        "native Held can still arrive later and must stay historical"
    );
    assert_eq!(
        f.store
            .delivery_attempt(&f.owner, t.attempt_id())
            .unwrap()
            .outcome,
        Some(AttemptOutcome::Held)
    );
}

#[test]
fn matching_reconciliation_preserves_native_hold_and_makes_only_current_delivery_retryable() {
    let mut f = Fixture::new("held-reconciliation");
    f.send("held");
    let c = f.candidates().remove(0);
    let t = f.store.begin_delivery(&f.owner, &c).unwrap();
    let held = f
        .store
        .complete_delivery(&f.owner, t.attempt_id(), AttemptOutcome::Held)
        .unwrap();
    let evidence = VerifiedNotSubmitted::trusted(
        t.attempt_id().clone(),
        "native-proof-never-delivered-and-no-longer-queued".into(),
    )
    .unwrap();
    f.store
        .reconcile_not_submitted(&f.owner, evidence.clone())
        .unwrap();
    f.store
        .reconcile_not_submitted(&f.owner, evidence.clone())
        .unwrap();
    let status = f.store.delivery_attempt(&f.owner, t.attempt_id()).unwrap();
    assert_eq!(status.outcome, Some(AttemptOutcome::Held));
    assert_eq!(status.completed_at_millis, held.completed_at_millis);
    assert!(status.reconciled_not_submitted_at_millis.is_some());
    let new = f.candidates().remove(0);
    let retry = f.store.begin_delivery(&f.owner, &new).unwrap();
    assert_ne!(retry.attempt_id(), t.attempt_id());
    assert_eq!(retry.attempt_number(), 2);
    f.store.reconcile_not_submitted(&f.owner, evidence).unwrap();
    assert!(f.candidates().is_empty());
    assert_eq!(
        f.store
            .delivery_attempt(&f.owner, retry.attempt_id())
            .unwrap()
            .outcome,
        None
    );
}

#[test]
fn committed_recipient_delivery_survives_sender_removal_but_recipient_removal_blocks_dispatch() {
    let mut f = Fixture::new("sender-removal");
    f.send("one");
    let before = f.candidates().remove(0);
    f.group = f
        .store
        .set_membership(
            &f.owner,
            &f.group.group_id,
            &f.alice.record.peer_id,
            false,
            f.group.policy_revision,
        )
        .unwrap();
    assert!(matches!(
        f.store.begin_delivery(&f.owner, &before),
        Err(StoreError::StalePolicy { .. })
    ));
    let after = f.candidates().remove(0);
    let ticket = f.store.begin_delivery(&f.owner, &after).unwrap();
    assert!(f
        .store
        .send_message(&f.alice.principal, f.request("two"))
        .is_err());
    f.group = f
        .store
        .set_membership(
            &f.owner,
            &f.group.group_id,
            &f.bob.record.peer_id,
            false,
            f.group.policy_revision,
        )
        .unwrap();
    f.store
        .complete_delivery(
            &f.owner,
            ticket.attempt_id(),
            AttemptOutcome::KnownNotSubmitted,
        )
        .unwrap();
    assert!(f.candidates().is_empty());
}

#[test]
fn ack_before_native_completion_stays_acknowledged_and_fetched_candidates_are_stale() {
    let mut f = Fixture::new("ack-native-independence");
    let saved = f.send("ack-first");
    let c = f.candidates().remove(0);
    let t = f.store.begin_delivery(&f.owner, &c).unwrap();
    let first = f
        .store
        .acknowledge_message(&f.bob.principal, &f.group.group_id, &saved.message_id)
        .unwrap();
    f.store
        .complete_delivery(&f.owner, t.attempt_id(), AttemptOutcome::KnownNotSubmitted)
        .unwrap();
    assert!(f.candidates().is_empty());
    assert_eq!(
        f.store
            .acknowledge_message(&f.bob.principal, &f.group.group_id, &saved.message_id)
            .unwrap(),
        first
    );
    f.send("fetch-first");
    let stale = f.candidates().remove(0);
    f.store
        .read_mailbox(
            &f.bob.principal,
            MailboxPageRequest {
                group_id: f.group.group_id.clone(),
                cursor: None,
                max_items: 128,
            },
        )
        .unwrap();
    assert!(matches!(
        f.store.begin_delivery(&f.owner, &stale),
        Err(StoreError::StaleCandidate)
    ));
}

#[test]
fn continuation_covers_paused_groups_and_rejects_extra_groups_and_stale_cursors() {
    let mut f = Fixture::new("paused-continuation");
    f.send("one");
    f.send("two");
    let cursor = f
        .store
        .read_mailbox(
            &f.bob.principal,
            MailboxPageRequest {
                group_id: f.group.group_id.clone(),
                cursor: None,
                max_items: 1,
            },
        )
        .unwrap()
        .next_cursor
        .unwrap();
    let extra = f
        .store
        .create_group(
            &f.owner,
            "unrelated",
            [f.alice.record.peer_id.clone()].into(),
        )
        .unwrap();
    let evidence = f.continuation(&f.bob, "bob2");
    let mut extra_map = f.policies();
    extra_map.insert(extra.group_id, extra.policy_revision);
    assert!(matches!(
        f.store
            .continue_peer(&f.owner, evidence.clone(), "intent", extra_map),
        Err(StoreError::ContinuationGroups)
    ));
    f.group = f
        .store
        .set_group_paused(&f.owner, &f.group.group_id, true, f.group.policy_revision)
        .unwrap();
    assert!(matches!(
        f.store
            .continue_peer(&f.owner, evidence.clone(), "intent", BTreeMap::new()),
        Err(StoreError::ContinuationGroups)
    ));
    let successor = f
        .store
        .continue_peer(&f.owner, evidence, "intent", f.policies())
        .unwrap();
    assert!(f
        .store
        .delivery_candidates(
            &f.owner,
            &f.group.group_id,
            &successor.record.peer_id,
            successor.record.revision,
            1
        )
        .unwrap()
        .is_empty());
    f.group = f
        .store
        .set_group_paused(&f.owner, &f.group.group_id, false, f.group.policy_revision)
        .unwrap();
    assert!(matches!(
        f.store.read_mailbox(
            &successor.principal,
            MailboxPageRequest {
                group_id: f.group.group_id.clone(),
                cursor: Some(cursor),
                max_items: 1
            }
        ),
        Err(StoreError::StaleCursor)
    ));
    let page = f
        .store
        .read_mailbox(
            &successor.principal,
            MailboxPageRequest {
                group_id: f.group.group_id.clone(),
                cursor: None,
                max_items: 128,
            },
        )
        .unwrap();
    assert_eq!(page.messages.len(), 1);
    assert_eq!(page.messages[0].message.group_sequence, 2);
}

#[test]
fn historical_attempt_generation_cannot_be_orphaned_after_continuation() {
    let mut f = Fixture::new("history-foreign-key");
    let saved = f.send("one");
    let c = f.candidates().remove(0);
    let t = f.store.begin_delivery(&f.owner, &c).unwrap();
    f.store
        .complete_delivery(&f.owner, t.attempt_id(), AttemptOutcome::KnownNotSubmitted)
        .unwrap();
    f.store
        .continue_peer(
            &f.owner,
            f.continuation(&f.bob, "bob2"),
            "continue",
            f.policies(),
        )
        .unwrap();
    let db = rusqlite::Connection::open(&f.path).unwrap();
    db.pragma_update(None, "foreign_keys", true).unwrap();
    assert!(
        db.execute(
            "DELETE FROM delivery_generations WHERE message_id=?1 AND binding_revision=1",
            [saved.message_id.as_str()]
        )
        .is_err(),
        "historical attempt must retain its actual binding/generation through a foreign key"
    );
}

#[test]
fn delivery_and_continuation_require_the_store_owner_authority() {
    let mut f = Fixture::new("delivery-authority");
    f.send("one");
    let c = f.candidates().remove(0);
    let t = f.store.begin_delivery(&f.owner, &c).unwrap();
    let alien = Store::open(support::retained_db("alien-delivery-owner"))
        .unwrap()
        .trusted_owner();
    assert!(matches!(
        f.store.recover_trusted_new_run(&alien),
        Err(StoreError::AuthorityMismatch)
    ));
    assert!(matches!(
        f.store.delivery_candidates(
            &alien,
            &f.group.group_id,
            &f.bob.record.peer_id,
            f.bob.record.revision,
            1
        ),
        Err(StoreError::AuthorityMismatch)
    ));
    assert!(matches!(
        f.store.begin_delivery(&alien, &c),
        Err(StoreError::AuthorityMismatch)
    ));
    assert!(matches!(
        f.store
            .complete_delivery(&alien, t.attempt_id(), AttemptOutcome::KnownNotSubmitted),
        Err(StoreError::AuthorityMismatch)
    ));
    assert!(matches!(
        f.store.delivery_attempt(&alien, t.attempt_id()),
        Err(StoreError::AuthorityMismatch)
    ));
    assert!(matches!(
        f.store.reconcile_not_submitted(
            &alien,
            VerifiedNotSubmitted::trusted(t.attempt_id().clone(), "proof".into()).unwrap()
        ),
        Err(StoreError::AuthorityMismatch)
    ));
    assert!(matches!(
        f.store.continue_peer(
            &alien,
            f.continuation(&f.bob, "bob2"),
            "intent",
            f.policies()
        ),
        Err(StoreError::AuthorityMismatch)
    ));
    assert_eq!(
        f.store
            .delivery_attempt(&f.owner, t.attempt_id())
            .unwrap()
            .outcome,
        None
    );
}

#[test]
fn unrelated_new_pane_occupant_gets_no_grants_or_historical_backlog() {
    let mut f = Fixture::new("unrelated-pane");
    f.send("one");
    let newcomer = f
        .store
        .enroll_peer(&f.owner, binding("bob", "new-conversation"))
        .unwrap();
    let request = MailboxPageRequest {
        group_id: f.group.group_id.clone(),
        cursor: None,
        max_items: 128,
    };
    assert!(matches!(
        f.store.read_mailbox(&newcomer.principal, request.clone()),
        Err(StoreError::Unauthorized { .. })
    ));
    f.store
        .set_membership(
            &f.owner,
            &f.group.group_id,
            &newcomer.record.peer_id,
            true,
            f.group.policy_revision,
        )
        .unwrap();
    assert!(f
        .store
        .read_mailbox(&newcomer.principal, request)
        .unwrap()
        .messages
        .is_empty());
}

#[test]
fn successive_continuations_keep_logical_generations_separate_from_binding_revisions() {
    let mut f = Fixture::new("multiple-continuations");
    let old = f.send("old");
    let old_candidate = f.candidates().remove(0);
    let bob2 = f
        .store
        .continue_peer(
            &f.owner,
            f.continuation(&f.bob, "bob2"),
            "first",
            f.policies(),
        )
        .unwrap();
    assert!(matches!(
        f.store.begin_delivery(&f.owner, &old_candidate),
        Err(StoreError::StaleBinding)
    ));
    let fresh = f.send("fresh");
    assert_eq!(fresh.recipients[0].binding_revision.get(), 2);
    assert_eq!(fresh.recipients[0].generation.get(), 1);
    let bob3 = f
        .store
        .continue_peer(
            &f.owner,
            f.continuation(&bob2, "bob3"),
            "second",
            f.policies(),
        )
        .unwrap();
    let page = f
        .store
        .read_mailbox(
            &bob3.principal,
            MailboxPageRequest {
                group_id: f.group.group_id.clone(),
                cursor: None,
                max_items: 128,
            },
        )
        .unwrap();
    assert_eq!(
        page.messages
            .iter()
            .map(|e| (e.receipt.binding_revision.get(), e.receipt.generation.get()))
            .collect::<Vec<_>>(),
        vec![(3, 3), (3, 2)]
    );
    assert_eq!(
        f.store
            .send_message(&f.alice.principal, f.request("old"))
            .unwrap(),
        old
    );
    assert_eq!(
        f.store
            .send_message(&f.alice.principal, f.request("fresh"))
            .unwrap(),
        fresh
    );
    assert_eq!(
        f.store
            .acknowledge_message(&bob3.principal, &f.group.group_id, &old.message_id)
            .unwrap()
            .generation
            .get(),
        3
    );
    assert_eq!(
        f.store
            .acknowledge_message(&bob3.principal, &f.group.group_id, &fresh.message_id)
            .unwrap()
            .generation
            .get(),
        2
    );
}

#[test]
fn delayed_native_completion_preserves_reconciled_candidates_and_continuation() {
    for outcome in [
        AttemptOutcome::Held,
        AttemptOutcome::NativeQueued,
        AttemptOutcome::TransportWritten,
    ] {
        let mut f = Fixture::new("reconciliation-late-completion");
        let saved = f.send("one");
        let candidate = f.candidates().remove(0);
        let ticket = f.store.begin_delivery(&f.owner, &candidate).unwrap();
        drop(f.store);
        f.store = Store::open(&f.path).unwrap();
        assert_eq!(f.store.recover_trusted_new_run(&f.owner).unwrap(), 1);
        let proof = VerifiedNotSubmitted::trusted(
            ticket.attempt_id().clone(),
            "verified-cancellation-after-native-observation".into(),
        )
        .unwrap();
        f.store
            .reconcile_not_submitted(&f.owner, proof.clone())
            .unwrap();
        let reconciled = f
            .store
            .delivery_attempt(&f.owner, ticket.attempt_id())
            .unwrap();
        assert!(reconciled.recovered_uncertain_at_millis.is_some());
        assert!(reconciled.reconciled_not_submitted_at_millis.is_some());
        assert_eq!(f.candidates().len(), 1);
        let completed = f
            .store
            .complete_delivery(&f.owner, ticket.attempt_id(), outcome)
            .unwrap();
        assert_eq!(
            f.candidates().len(),
            1,
            "delayed {outcome:?} must not override later verified cancellation"
        );
        f.store
            .reconcile_not_submitted(&f.owner, proof.clone())
            .unwrap();
        assert_eq!(
            f.candidates().len(),
            1,
            "same-proof replay after {outcome:?} must remain eligible"
        );
        assert_eq!(completed.outcome, Some(outcome));
        assert_eq!(
            completed.recovered_uncertain_at_millis,
            reconciled.recovered_uncertain_at_millis
        );
        assert_eq!(
            completed.reconciled_not_submitted_at_millis,
            reconciled.reconciled_not_submitted_at_millis
        );
        assert_eq!(
            f.store
                .delivery_attempt(&f.owner, ticket.attempt_id())
                .unwrap(),
            completed
        );
        let successor = f
            .store
            .continue_peer(
                &f.owner,
                f.continuation(&f.bob, "bob2"),
                "continue-reconciled",
                f.policies(),
            )
            .unwrap();
        let candidates = f
            .store
            .delivery_candidates(
                &f.owner,
                &f.group.group_id,
                &successor.record.peer_id,
                successor.record.revision,
                1,
            )
            .unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].generation().get(), 2);
        assert_eq!(
            f.store
                .send_message(&f.alice.principal, f.request("one"))
                .unwrap(),
            saved
        );
        assert_eq!(
            f.store
                .complete_delivery(&f.owner, ticket.attempt_id(), outcome)
                .unwrap(),
            completed
        );
        f.store.reconcile_not_submitted(&f.owner, proof).unwrap();
        let successor_ticket = f.store.begin_delivery(&f.owner, &candidates[0]).unwrap();
        assert_ne!(successor_ticket.attempt_id(), ticket.attempt_id());
        let db = rusqlite::Connection::open(&f.path).unwrap();
        assert_eq!(db.query_row("SELECT count(*) FROM attempt_not_submitted_reconciliations WHERE evidence_reference='verified-cancellation-after-native-observation'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(
            db.query_row("SELECT count(*) FROM acknowledgements", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
    }
}

#[test]
fn delayed_reconciled_completion_cannot_change_a_new_attempt_or_successor_generation() {
    for outcome in [
        AttemptOutcome::Held,
        AttemptOutcome::NativeQueued,
        AttemptOutcome::TransportWritten,
    ] {
        for transfer in [false, true] {
            let mut f = Fixture::new("reconciliation-completion-fences");
            let saved = f.send("one");
            let candidate = f.candidates().remove(0);
            let old_ticket = f.store.begin_delivery(&f.owner, &candidate).unwrap();
            drop(f.store);
            f.store = Store::open(&f.path).unwrap();
            f.store.recover_trusted_new_run(&f.owner).unwrap();
            let proof = VerifiedNotSubmitted::trusted(
                old_ticket.attempt_id().clone(),
                "verified-not-delivered".into(),
            )
            .unwrap();
            f.store
                .reconcile_not_submitted(&f.owner, proof.clone())
                .unwrap();
            let current = if transfer {
                f.store
                    .continue_peer(
                        &f.owner,
                        f.continuation(&f.bob, "bob2"),
                        "transfer-before-late-observation",
                        f.policies(),
                    )
                    .unwrap()
            } else {
                f.bob.clone()
            };
            let candidate = f
                .store
                .delivery_candidates(
                    &f.owner,
                    &f.group.group_id,
                    &current.record.peer_id,
                    current.record.revision,
                    1,
                )
                .unwrap()
                .remove(0);
            let new_ticket = f.store.begin_delivery(&f.owner, &candidate).unwrap();
            f.store
                .complete_delivery(&f.owner, old_ticket.attempt_id(), outcome)
                .unwrap();
            f.store.reconcile_not_submitted(&f.owner, proof).unwrap();
            assert!(
                f.store
                    .delivery_candidates(
                        &f.owner,
                        &f.group.group_id,
                        &current.record.peer_id,
                        current.record.revision,
                        1
                    )
                    .unwrap()
                    .is_empty(),
                "historical {outcome:?} must not ready a newer attempt; transfer={transfer}"
            );
            assert_eq!(
                f.store
                    .delivery_attempt(&f.owner, new_ticket.attempt_id())
                    .unwrap()
                    .outcome,
                None
            );
            assert_eq!(
                f.store
                    .delivery_attempt(&f.owner, old_ticket.attempt_id())
                    .unwrap()
                    .outcome,
                Some(outcome)
            );
            assert_eq!(
                f.store
                    .send_message(&f.alice.principal, f.request("one"))
                    .unwrap(),
                saved
            );
        }
    }
}

#[test]
fn mailbox_projection_keeps_mixed_generations_acks_and_frozen_snapshot() {
    let mut f = Fixture::new("mailbox-mixed-generations");
    let historical = f.send("historical");
    f.store
        .acknowledge_message(&f.bob.principal, &f.group.group_id, &historical.message_id)
        .unwrap();
    let old = f.send("old");
    let bob2 = f
        .store
        .continue_peer(
            &f.owner,
            f.continuation(&f.bob, "bob2"),
            "first",
            f.policies(),
        )
        .unwrap();
    let fresh = f.send("fresh");
    let bob3 = f
        .store
        .continue_peer(
            &f.owner,
            f.continuation(&bob2, "bob3"),
            "second",
            f.policies(),
        )
        .unwrap();
    let future = f.send("future");
    f.store
        .acknowledge_message(&bob3.principal, &f.group.group_id, &fresh.message_id)
        .unwrap();
    let request = MailboxPageRequest {
        group_id: f.group.group_id.clone(),
        cursor: None,
        max_items: 1,
    };
    assert!(matches!(
        f.store.read_mailbox(&f.bob.principal, request.clone()),
        Err(StoreError::StaleBinding)
    ));
    let first = f
        .store
        .read_mailbox(&bob3.principal, request.clone())
        .unwrap();
    assert_eq!(first.snapshot_high_sequence, 4);
    assert_eq!(first.messages.len(), 1);
    assert_eq!(first.messages[0].message.message_id, old.message_id);
    assert_eq!(first.messages[0].receipt.generation.get(), 3);
    assert!(first.messages[0].receipt.acknowledged_at_millis.is_none());
    f.send("after-snapshot");
    let second = f
        .store
        .read_mailbox(
            &bob3.principal,
            MailboxPageRequest {
                cursor: first.next_cursor,
                ..request.clone()
            },
        )
        .unwrap();
    assert_eq!(second.snapshot_high_sequence, 4);
    assert_eq!(second.messages.len(), 1);
    assert_eq!(second.messages[0].message.message_id, fresh.message_id);
    assert_eq!(second.messages[0].receipt.generation.get(), 2);
    assert!(second.messages[0].receipt.acknowledged_at_millis.is_some());
    let third = f
        .store
        .read_mailbox(
            &bob3.principal,
            MailboxPageRequest {
                cursor: second.next_cursor,
                ..request
            },
        )
        .unwrap();
    assert_eq!(third.snapshot_high_sequence, 4);
    assert_eq!(third.messages.len(), 1);
    assert_eq!(third.messages[0].message.message_id, future.message_id);
    assert_eq!(third.messages[0].receipt.generation.get(), 1);
    assert!(third.next_cursor.is_none());
    assert_eq!(
        f.store
            .send_message(&f.alice.principal, f.request("old"))
            .unwrap(),
        old
    );
}

#[test]
fn mixed_generation_ack_gap_spans_current_binding_and_old_ack_replay_never_regresses() {
    let mut f = Fixture::new("mixed-generation-watermark");
    let old = f.send("old");
    let bob2 = f
        .store
        .continue_peer(
            &f.owner,
            f.continuation(&f.bob, "bob2"),
            "first",
            f.policies(),
        )
        .unwrap();
    let fresh = f.send("fresh");
    let bob3 = f
        .store
        .continue_peer(
            &f.owner,
            f.continuation(&bob2, "bob3"),
            "second",
            f.policies(),
        )
        .unwrap();
    let second = f
        .store
        .acknowledge_message(&bob3.principal, &f.group.group_id, &fresh.message_id)
        .unwrap();
    assert_eq!(second.generation.get(), 2);
    assert_eq!(
        second.contiguous_group_sequence, 0,
        "sequence 1/generation 3 still blocks sequence 2/generation 2 for the same current binding"
    );
    let first = f
        .store
        .acknowledge_message(&bob3.principal, &f.group.group_id, &old.message_id)
        .unwrap();
    assert_eq!(first.generation.get(), 3);
    assert_eq!(first.contiguous_group_sequence, 2);
    let future = f.send("future");
    let third = f
        .store
        .acknowledge_message(&bob3.principal, &f.group.group_id, &future.message_id)
        .unwrap();
    assert_eq!(third.generation.get(), 1);
    assert_eq!(third.contiguous_group_sequence, 3);
    let replay = f
        .store
        .acknowledge_message(&bob3.principal, &f.group.group_id, &old.message_id)
        .unwrap();
    assert_eq!(replay.generation.get(), 3);
    assert_eq!(replay.acknowledged_at_millis, first.acknowledged_at_millis);
    assert_eq!(
        replay.contiguous_group_sequence, 3,
        "replaying an older generation must use the binding-wide lower bound"
    );
}
