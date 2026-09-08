#[path = "support/credits.rs"]
mod credits;
mod support;

use std::collections::BTreeSet;

use credits::TestBudget;
use termx_swarm_core::error::{StoreError, ValidationError};
use termx_swarm_core::model::*;
use termx_swarm_core::store::Store;
use termx_swarm_core::worker::*;

fn binding(name: &str) -> VerifiedBinding {
    VerifiedBinding::trusted(
        LaunchId::generate().as_str().into(),
        format!("terminal-{name}"),
        "codex".to_owned(),
        format!("conversation-{name}"),
        None,
        100,
        10_000,
        true,
    )
    .unwrap()
}

fn members(ids: &[&PeerId]) -> BTreeSet<PeerId> {
    ids.iter().map(|id| (*id).clone()).collect()
}

fn descriptor(peer: &EnrolledPeer, key: &str) -> VerifiedSourceDescriptor {
    VerifiedSourceDescriptor::trusted(
        peer.record.peer_id.clone(),
        peer.record.revision,
        peer.record.conversation_id.clone(),
        "codex-jsonl".into(),
        format!("C:\\secret\\resolver\\{key}.jsonl"),
        format!("volume:1 file:{key}"),
        format!("task4-evidence-{key}"),
    )
    .unwrap()
}

fn rebind(peer: &EnrolledPeer, terminal: &str) -> VerifiedContinuation {
    VerifiedContinuation::trusted(
        &peer.record,
        VerifiedBinding::trusted(
            LaunchId::generate().as_str().into(),
            terminal.into(),
            "codex".into(),
            peer.record.conversation_id.clone(),
            None,
            101,
            10_001,
            true,
        )
        .unwrap(),
        "same-branch".into(),
    )
    .unwrap()
}

struct Fixture {
    store: Store,
    owner: OwnerPrincipal,
    alice: EnrolledPeer,
    bob: EnrolledPeer,
    carol: EnrolledPeer,
    group: GroupRecord,
    source: SourceRegistration,
    budget: TestBudget,
    destination: PublicationDestinationId,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let mut store = Store::open(support::retained_db(name)).unwrap();
        let owner = store.trusted_owner();
        let alice = store.enroll_peer(&owner, binding("alice")).unwrap();
        let bob = store.enroll_peer(&owner, binding("bob")).unwrap();
        let carol = store.enroll_peer(&owner, binding("carol")).unwrap();
        let group = store
            .create_group(
                &owner,
                "pair",
                members(&[
                    &alice.record.peer_id,
                    &bob.record.peer_id,
                    &carol.record.peer_id,
                ]),
            )
            .unwrap();
        let source = store
            .register_source(&owner, descriptor(&bob, "bob"))
            .unwrap();
        Self {
            store,
            owner,
            alice,
            bob,
            carol,
            group,
            source,
            budget: TestBudget::new(1 << 20),
            destination: PublicationDestinationId::generate(),
        }
    }
    fn acquire(&mut self) -> ContextGrantLease {
        self.store
            .acquire_context_grant(
                &self.alice.principal,
                &self.group.group_id,
                &self.source.source_id,
            )
            .unwrap()
    }
    fn acquire_for(&mut self, who: &EnrolledPeer) -> ContextGrantLease {
        self.store
            .acquire_context_grant(&who.principal, &self.group.group_id, &self.source.source_id)
            .unwrap()
    }
    /// Source I/O and credit reservation happen here, outside the writer.
    fn prepare(&self, lease: ContextGrantLease, body: &str) -> PreparedPublication {
        let observation =
            SourceSnapshotObservation::trusted(&lease, format!("snapshot:{body}"), Some(40))
                .unwrap();
        let reservation = DestinationReservation::from_owned(
            self.destination.clone(),
            self.budget.reserve(4096).expect("budget"),
        )
        .unwrap();
        PreparedPublication::prepare(lease, observation, body.as_bytes().to_vec(), reservation)
            .unwrap()
    }
    fn validate(
        &mut self,
        principal: &PeerPrincipal,
        lease: ContextGrantLease,
        body: &str,
    ) -> Result<CommittedPublication, StoreError> {
        let prepared = self.prepare(lease, body);
        self.store.validate_context_grant(principal, prepared)
    }
}

#[test]
fn lease_binds_every_authorization_fact_and_each_barrier_rejects_validation() {
    // Policy change (membership added).
    let mut f = Fixture::new("lease-barrier-policy");
    let lease = f.acquire();
    assert_eq!(lease.source_id(), &f.source.source_id);
    assert_eq!(lease.group_id(), &f.group.group_id);
    assert_eq!(lease.policy_revision(), f.group.policy_revision);
    assert_eq!(lease.registration_epoch(), f.source.registration_epoch);
    assert_eq!(lease.source_kind(), "codex-jsonl");
    assert_eq!(lease.resolver_key(), "C:\\secret\\resolver\\bob.jsonl");
    let dave = f.store.enroll_peer(&f.owner, binding("dave")).unwrap();
    f.store
        .set_membership(
            &f.owner,
            &f.group.group_id,
            &dave.record.peer_id,
            true,
            f.group.policy_revision,
        )
        .unwrap();
    let alice = f.alice.principal.clone();
    assert!(matches!(
        f.validate(&alice, lease, "policy"),
        Err(StoreError::StalePolicy { .. })
    ));
    assert_eq!(f.budget.usage(), 0, "every rejection releases the credits");

    // Pause before validation.
    let mut f = Fixture::new("lease-barrier-pause");
    let lease = f.acquire();
    f.store
        .set_group_paused(&f.owner, &f.group.group_id, true, f.group.policy_revision)
        .unwrap();
    let alice = f.alice.principal.clone();
    assert!(matches!(
        f.validate(&alice, lease, "pause"),
        Err(StoreError::GroupPaused)
    ));
    assert_eq!(f.budget.usage(), 0);

    // Caller removed.
    let mut f = Fixture::new("lease-barrier-caller-removed");
    let lease = f.acquire();
    f.store
        .set_membership(
            &f.owner,
            &f.group.group_id,
            &f.alice.record.peer_id,
            false,
            f.group.policy_revision,
        )
        .unwrap();
    let alice = f.alice.principal.clone();
    assert!(matches!(
        f.validate(&alice, lease, "caller-removed"),
        Err(StoreError::Unauthorized { .. })
    ));
    assert_eq!(f.budget.usage(), 0);

    // Source owner removed.
    let mut f = Fixture::new("lease-barrier-owner-removed");
    let lease = f.acquire();
    f.store
        .set_membership(
            &f.owner,
            &f.group.group_id,
            &f.bob.record.peer_id,
            false,
            f.group.policy_revision,
        )
        .unwrap();
    let alice = f.alice.principal.clone();
    assert!(matches!(
        f.validate(&alice, lease, "owner-removed"),
        Err(StoreError::StalePolicy { .. }) | Err(StoreError::Unauthorized { .. })
    ));
    assert_eq!(f.budget.usage(), 0);

    // Caller rebinding.
    let mut f = Fixture::new("lease-barrier-caller-rebind");
    let lease = f.acquire();
    let alice2 = f
        .store
        .continue_peer(
            &f.owner,
            rebind(&f.alice, "terminal-alice-2"),
            "continue",
            [(f.group.group_id.clone(), f.group.policy_revision)].into(),
        )
        .unwrap();
    assert!(matches!(
        f.validate(&alice2.principal, lease, "caller-rebind"),
        Err(StoreError::Unauthorized { .. })
    ));
    let lease = f.acquire_for(&alice2);
    let alice = f.alice.principal.clone();
    assert!(matches!(
        f.validate(&alice, lease, "caller-stale"),
        Err(StoreError::Unauthorized { .. })
    ));
    assert_eq!(f.budget.usage(), 0);

    // Source owner rebinding without re-establishment.
    let mut f = Fixture::new("lease-barrier-owner-rebind");
    let lease = f.acquire();
    f.store
        .continue_peer(
            &f.owner,
            rebind(&f.bob, "terminal-bob-2"),
            "continue",
            [(f.group.group_id.clone(), f.group.policy_revision)].into(),
        )
        .unwrap();
    let alice = f.alice.principal.clone();
    assert!(matches!(
        f.validate(&alice, lease, "owner-rebind"),
        Err(StoreError::SourceUnavailable { .. })
    ));
    assert_eq!(f.budget.usage(), 0);

    // Withdrawal, re-establishment and replacement.
    let mut f = Fixture::new("lease-barrier-withdraw");
    let lease = f.acquire();
    let withdrawn = f
        .store
        .transition_source(
            &f.owner,
            SourceTransition::Withdraw {
                source_id: f.source.source_id.clone(),
                expected_epoch: f.source.registration_epoch,
            },
        )
        .unwrap();
    let alice = f.alice.principal.clone();
    assert!(matches!(
        f.validate(&alice, lease, "withdrawn"),
        Err(StoreError::SourceUnavailable { .. })
    ));
    assert!(matches!(
        f.store
            .acquire_context_grant(&f.alice.principal, &f.group.group_id, &f.source.source_id),
        Err(StoreError::SourceUnavailable { .. })
    ));
    let reestablished = f
        .store
        .transition_source(
            &f.owner,
            SourceTransition::Reestablish {
                source_id: f.source.source_id.clone(),
                expected_epoch: withdrawn.registration_epoch,
                descriptor: descriptor(&f.bob, "bob-again"),
            },
        )
        .unwrap();
    let lease = f.acquire();
    assert_eq!(lease.registration_epoch(), reestablished.registration_epoch);
    assert_eq!(
        lease.resolver_key(),
        "C:\\secret\\resolver\\bob-again.jsonl"
    );
    let stale_epoch_lease = f.acquire();
    let replacement = f
        .store
        .transition_source(
            &f.owner,
            SourceTransition::Replace {
                source_id: f.source.source_id.clone(),
                expected_epoch: reestablished.registration_epoch,
                descriptor: descriptor(&f.bob, "bob-v2"),
            },
        )
        .unwrap();
    assert!(matches!(
        f.validate(&alice, lease, "replaced"),
        Err(StoreError::SourceUnavailable { .. })
    ));
    assert!(matches!(
        f.validate(&alice, stale_epoch_lease, "replaced-2"),
        Err(StoreError::SourceUnavailable { .. })
    ));
    let fresh = f
        .store
        .acquire_context_grant(
            &f.alice.principal,
            &f.group.group_id,
            &replacement.source_id,
        )
        .unwrap();
    assert_eq!(fresh.resolver_key(), "C:\\secret\\resolver\\bob-v2.jsonl");
    let committed = f.validate(&alice, fresh, "fresh").unwrap();
    assert_eq!(committed.record().source_id(), &replacement.source_id);
    assert_eq!(committed.record().reserved_bytes(), 4096);
    assert_eq!(committed.record().body_bytes(), "fresh".len() as u64);
    assert_eq!(committed.record().snapshot_identity(), "snapshot:fresh");
    assert_eq!(
        f.budget.usage(),
        4096,
        "the committed response holds its credits"
    );
    drop(committed);
    assert_eq!(f.budget.usage(), 0);

    // A lease from another authority or a forged principal is rejected.
    let mut other = Store::open(support::retained_db("lease-other-authority")).unwrap();
    let other_owner = other.trusted_owner();
    let alien = other.enroll_peer(&other_owner, binding("alien")).unwrap();
    let lease = f
        .store
        .acquire_context_grant(
            &f.alice.principal,
            &f.group.group_id,
            &replacement.source_id,
        )
        .unwrap();
    let prepared = f.prepare(lease, "alien");
    assert!(matches!(
        other.validate_context_grant(&alien.principal, prepared),
        Err(StoreError::AuthorityMismatch)
    ));
    let lease = f
        .store
        .acquire_context_grant(
            &f.alice.principal,
            &f.group.group_id,
            &replacement.source_id,
        )
        .unwrap();
    let carol = f.carol.principal.clone();
    assert!(matches!(
        f.validate(&carol, lease, "carol-steals"),
        Err(StoreError::Unauthorized { .. })
    ));
    assert_eq!(f.budget.usage(), 0);

    // Prepared bounds: credits and a non-empty body are required; a claimed
    // reference string is no longer an input at all.
    let lease = f
        .store
        .acquire_context_grant(
            &f.alice.principal,
            &f.group.group_id,
            &replacement.source_id,
        )
        .unwrap();
    let observation = SourceSnapshotObservation::trusted(&lease, "s".into(), None).unwrap();
    let reservation =
        DestinationReservation::from_owned(f.destination.clone(), f.budget.reserve(1).unwrap())
            .unwrap();
    assert!(matches!(
        PreparedPublication::prepare(lease, observation, Vec::new(), reservation),
        Err(ValidationError::Empty { field: "body" })
    ));
    assert_eq!(f.budget.usage(), 0);

    // Non-members cannot acquire; a lease is not a source id.
    assert!(matches!(
        f.store
            .acquire_context_grant(&f.carol.principal, &f.group.group_id, &f.source.source_id),
        Err(StoreError::SourceUnavailable { .. })
    ));
    let eve = f.store.enroll_peer(&f.owner, binding("eve")).unwrap();
    assert!(matches!(
        f.store
            .acquire_context_grant(&eve.principal, &f.group.group_id, &replacement.source_id),
        Err(StoreError::Unauthorized { .. })
    ));
    assert!(matches!(
        f.store
            .acquire_context_grant(&f.alice.principal, &f.group.group_id, &SourceId::generate()),
        Err(StoreError::NotFound { .. })
    ));
}

#[test]
fn committed_response_is_single_use_and_survives_later_revocation_only_for_itself() {
    let mut f = Fixture::new("lease-single-use");
    let lease = f.acquire();
    let lease_id = lease.lease_id().clone();
    let alice = f.alice.principal.clone();
    let committed = f.validate(&alice, lease, "response-1").unwrap();
    assert_eq!(committed.record().lease_id(), &lease_id);
    assert_eq!(committed.record().caller_peer_id(), &f.alice.record.peer_id);
    assert_eq!(committed.body(), b"response-1");

    let commitment_id = committed.record().commitment_id().clone();
    let record = committed.into_send(&f.destination).unwrap().finish();
    assert_eq!(record.commitment_id(), &commitment_id);
    assert_eq!(f.budget.usage(), 0);

    // Later revocation is nonretroactive to the committed response itself.
    let paused = f
        .store
        .set_group_paused(&f.owner, &f.group.group_id, true, f.group.policy_revision)
        .unwrap();
    assert_eq!(record.policy_revision(), f.group.policy_revision);
    assert!(f
        .store
        .publication_committed(&f.owner, record.commitment_id())
        .unwrap());
    // Every new read checks current state.
    assert!(matches!(
        f.store
            .acquire_context_grant(&f.alice.principal, &f.group.group_id, &f.source.source_id),
        Err(StoreError::GroupPaused)
    ));
    f.store
        .set_group_paused(&f.owner, &f.group.group_id, false, paused.policy_revision)
        .unwrap();
    // A fresh lease under the current policy is a distinct response.
    let second = f.acquire();
    let next = f.validate(&alice, second, "response-2").unwrap();
    assert_ne!(next.record().commitment_id(), record.commitment_id());
    drop(next);
    // Publication is neither delivery nor ACK: no delivery rows or receipts exist.
    let candidates = {
        f.store.recover_trusted_new_run(&f.owner).unwrap();
        f.store
            .delivery_candidates(
                &f.owner,
                &f.group.group_id,
                &f.alice.record.peer_id,
                f.alice.record.revision,
                8,
            )
            .unwrap()
    };
    assert!(candidates.is_empty());
    let page = f
        .store
        .read_mailbox(
            &f.alice.principal,
            MailboxPageRequest {
                group_id: f.group.group_id.clone(),
                cursor: None,
                max_items: 8,
            },
        )
        .unwrap();
    assert!(page.messages.is_empty());
}

async fn call(client: &Client, make: impl Fn() -> Command) -> Result<Response, OperationError> {
    loop {
        match client.submit(make()) {
            Ok(pending) => return pending.await,
            Err(AdmissionError::Contended) => tokio::task::yield_now().await,
            Err(error) => panic!("admission: {error}"),
        }
    }
}

#[tokio::test]
async fn unpolled_validation_result_stays_consumable_after_pause_and_rebind_through_the_worker() {
    let worker = Worker::open(
        support::retained_db("lease-unpolled"),
        WorkerConfig::default(),
    )
    .await
    .unwrap();
    let client = worker.client();
    let Response::Owner(owner) = call(&client, || Command::TrustedOwner).await.unwrap() else {
        panic!()
    };
    let mut peers = Vec::new();
    for name in ["alice", "bob"] {
        let binding = binding(name);
        let Response::Enrolled(peer) =
            call(&client, || Command::Enroll(owner.clone(), binding.clone()))
                .await
                .unwrap()
        else {
            panic!()
        };
        peers.push(peer);
    }
    let (alice, bob) = (peers.remove(0), peers.remove(0));
    let Response::Group(group) = call(&client, || {
        Command::CreateGroup(
            owner.clone(),
            "pair".into(),
            members(&[&alice.record.peer_id, &bob.record.peer_id]),
        )
    })
    .await
    .unwrap() else {
        panic!()
    };
    let Response::Source(source) = call(&client, || {
        Command::RegisterSource(owner.clone(), descriptor(&bob, "bob"))
    })
    .await
    .unwrap() else {
        panic!()
    };
    let Response::Lease(lease) = call(&client, || {
        Command::AcquireContextGrant(
            alice.principal.clone(),
            group.group_id.clone(),
            source.source_id.clone(),
        )
    })
    .await
    .unwrap() else {
        panic!()
    };
    // Source I/O happens here, outside the writer, then credits are reserved
    // by the consumer before final validation.
    let budget = TestBudget::new(1 << 20);
    let destination = PublicationDestinationId::generate();
    let prepare = |lease: ContextGrantLease, body: &str| {
        let observation =
            SourceSnapshotObservation::trusted(&lease, "snapshot".into(), Some(7)).unwrap();
        let reservation =
            DestinationReservation::from_owned(destination.clone(), budget.reserve(4096).unwrap())
                .unwrap();
        PreparedPublication::prepare(lease, observation, body.as_bytes().to_vec(), reservation)
            .unwrap()
    };
    let validation = client
        .submit(Command::ValidateContextGrant(
            alice.principal.clone(),
            prepare(lease.clone(), "unpolled-response"),
        ))
        .unwrap();
    // Pause and rebind before the validation result is polled.
    let Response::Group(paused) = call(&client, || {
        Command::Pause(
            owner.clone(),
            group.group_id.clone(),
            true,
            group.policy_revision,
        )
    })
    .await
    .unwrap() else {
        panic!()
    };
    let Response::Enrolled(alice2) = call(&client, || {
        Command::Continue(
            owner.clone(),
            rebind(&alice, "terminal-alice-2"),
            "continue".into(),
            [(group.group_id.clone(), paused.policy_revision)].into(),
        )
    })
    .await
    .unwrap() else {
        panic!()
    };
    let Response::CommittedPublication(committed) = validation.await.unwrap() else {
        panic!("the already committed response remains consumable exactly once")
    };
    assert_eq!(committed.body(), b"unpolled-response");
    assert_eq!(
        committed.record().caller_binding_revision(),
        alice.record.revision
    );
    assert_eq!(budget.usage(), 4096);
    // A second or new read fails current authorization.
    let outcome = client
        .submit(Command::ValidateContextGrant(
            alice.principal.clone(),
            prepare(lease.clone(), "second-buffer"),
        ))
        .unwrap()
        .await;
    assert!(matches!(
        outcome,
        Err(OperationError::Store(StoreError::StaleBinding))
    ));
    assert_eq!(
        budget.usage(),
        4096,
        "the rejected second buffer released its credits"
    );
    assert!(matches!(
        call(&client, || Command::AcquireContextGrant(
            alice2.principal.clone(),
            group.group_id.clone(),
            source.source_id.clone()
        ))
        .await,
        Err(OperationError::Store(StoreError::GroupPaused))
    ));
    drop(committed);
    assert_eq!(budget.usage(), 0);
    worker.shutdown().await.unwrap();
}

#[test]
fn historical_v7_retry_encoding_is_preserved_and_attachment_changes_conflict() {
    let mut f = Fixture::new("historical-retry");
    let request = SendMessageRequest {
        group_id: f.group.group_id.clone(),
        client_key: "legacy".into(),
        recipients: members(&[&f.bob.record.peer_id]),
        body: "quote \"x\"\n\u{0001}\u{1f980}".into(),
        topic: Some("t".into()),
        reply_to: None,
        attachments: Vec::new(),
    };
    // Exact schema v7 canonical encoding: no attachments field at all.
    let expected = format!(
        "{{\"group_id\":\"{}\",\"client_key\":\"legacy\",\"recipients\":[\"{}\"],\"body\":\"quote \\\"x\\\"\\n\\u0001\u{1f980}\",\"topic\":\"t\",\"reply_to\":null}}",
        f.group.group_id.as_str(),
        f.bob.record.peer_id.as_str()
    );
    assert_eq!(
        String::from_utf8(request.canonical_json().unwrap()).unwrap(),
        expected
    );
    let saved = f
        .store
        .send_message(&f.alice.principal, request.clone())
        .unwrap();
    assert_eq!(
        f.store
            .send_message(&f.alice.principal, request.clone())
            .unwrap(),
        saved
    );
    let mut with_attachment = request.clone();
    with_attachment.attachments.push(SourceAttachment {
        source_id: f.source.source_id.clone(),
        snapshot_reference: None,
    });
    assert!(matches!(
        f.store.send_message(&f.alice.principal, with_attachment),
        Err(StoreError::IdempotencyConflict)
    ));
    let cited = f
        .store
        .send_message(
            &f.alice.principal,
            SendMessageRequest {
                client_key: "cited".into(),
                attachments: vec![SourceAttachment {
                    source_id: f.source.source_id.clone(),
                    snapshot_reference: Some("r".into()),
                }],
                ..request.clone()
            },
        )
        .unwrap();
    let mut different_attachment = SendMessageRequest {
        client_key: "cited".into(),
        attachments: vec![SourceAttachment {
            source_id: f.source.source_id.clone(),
            snapshot_reference: Some("different".into()),
        }],
        ..request.clone()
    };
    assert!(matches!(
        f.store
            .send_message(&f.alice.principal, different_attachment.clone()),
        Err(StoreError::IdempotencyConflict)
    ));
    different_attachment.attachments[0].snapshot_reference = Some("r".into());
    assert_eq!(
        f.store
            .send_message(&f.alice.principal, different_attachment)
            .unwrap(),
        cited
    );
    // Attachment validation: duplicates and over-limit lists are rejected.
    let duplicate = SendMessageRequest {
        client_key: "dup".into(),
        attachments: vec![
            SourceAttachment {
                source_id: f.source.source_id.clone(),
                snapshot_reference: None,
            },
            SourceAttachment {
                source_id: f.source.source_id.clone(),
                snapshot_reference: Some("x".into()),
            },
        ],
        ..request.clone()
    };
    assert!(matches!(
        f.store.send_message(&f.alice.principal, duplicate),
        Err(StoreError::Validation(_))
    ));
    let too_many = SendMessageRequest {
        client_key: "many".into(),
        attachments: (0..=MAX_ATTACHMENTS_PER_MESSAGE)
            .map(|_| SourceAttachment {
                source_id: SourceId::generate(),
                snapshot_reference: None,
            })
            .collect(),
        ..request
    };
    assert!(matches!(
        f.store.send_message(&f.alice.principal, too_many),
        Err(StoreError::Validation(_))
    ));
    let _ = &f.carol;
}
