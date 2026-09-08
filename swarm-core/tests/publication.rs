//! C1: publication ownership. A committed response is one exact immutable
//! buffer bound to a lease-scoped source observation and an actually owned
//! destination reservation. Every ownership path releases credits exactly once.
#[path = "support/credits.rs"]
mod credits;
mod support;

use std::collections::BTreeSet;

use credits::TestBudget;
use rusqlite::Connection;
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

struct Fixture {
    path: std::path::PathBuf,
    store: Store,
    owner: OwnerPrincipal,
    alice: EnrolledPeer,
    bob: EnrolledPeer,
    group: GroupRecord,
    source: SourceRegistration,
    budget: TestBudget,
}

impl Fixture {
    fn new(name: &str, limit: usize) -> Self {
        let path = support::retained_db(name);
        let mut store = Store::open(&path).unwrap();
        let owner = store.trusted_owner();
        let alice = store.enroll_peer(&owner, binding("alice")).unwrap();
        let bob = store.enroll_peer(&owner, binding("bob")).unwrap();
        let group = store
            .create_group(
                &owner,
                "pair",
                members(&[&alice.record.peer_id, &bob.record.peer_id]),
            )
            .unwrap();
        let source = store
            .register_source(&owner, descriptor(&bob, "bob"))
            .unwrap();
        Self {
            path,
            store,
            owner,
            alice,
            bob,
            group,
            source,
            budget: TestBudget::new(limit),
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

    /// Source I/O happens here in the trusted reader, outside the writer.
    fn observe(lease: &ContextGrantLease, through: u64) -> SourceSnapshotObservation {
        SourceSnapshotObservation::trusted(lease, format!("snapshot:{through}"), Some(through))
            .unwrap()
    }

    fn reserve(
        &self,
        bytes: usize,
        destination: &PublicationDestinationId,
    ) -> DestinationReservation {
        DestinationReservation::from_owned(
            destination.clone(),
            self.budget
                .reserve(bytes)
                .expect("budget covers reservation"),
        )
        .unwrap()
    }

    fn prepare(
        &self,
        lease: ContextGrantLease,
        body: &[u8],
        destination: &PublicationDestinationId,
    ) -> PreparedPublication {
        let observation = Self::observe(&lease, 40);
        let reservation = self.reserve(body.len(), destination);
        PreparedPublication::prepare(lease, observation, body.to_vec(), reservation).unwrap()
    }

    fn commitments(&self) -> i64 {
        Connection::open(&self.path)
            .unwrap()
            .query_row("SELECT count(*) FROM publication_commitments", [], |r| {
                r.get(0)
            })
            .unwrap()
    }
}

#[test]
fn observation_must_match_the_exact_lease_source_epoch_and_object() {
    let mut f = Fixture::new("publication-observation", 1 << 20);
    let destination = PublicationDestinationId::generate();
    let lease = f.acquire();
    let other_lease = f.acquire();
    let body = b"exact response bytes".to_vec();

    // Observation from a different lease of the same source.
    let observation = Fixture::observe(&other_lease, 40);
    let reservation = f.reserve(body.len(), &destination);
    assert!(matches!(
        PreparedPublication::prepare(lease.clone(), observation, body.clone(), reservation),
        Err(ValidationError::EvidenceMismatch { field: "lease_id" })
    ));
    assert_eq!(f.budget.usage(), 0, "rejected prepare released its permit");

    // Observation from a lease on a different source (replacement).
    let replacement = f
        .store
        .transition_source(
            &f.owner,
            SourceTransition::Replace {
                source_id: f.source.source_id.clone(),
                expected_epoch: f.source.registration_epoch,
                descriptor: descriptor(&f.bob, "bob-v2"),
            },
        )
        .unwrap();
    let replacement_lease = f
        .store
        .acquire_context_grant(
            &f.alice.principal,
            &f.group.group_id,
            &replacement.source_id,
        )
        .unwrap();
    let foreign = Fixture::observe(&replacement_lease, 1);
    assert_eq!(foreign.source_id(), &replacement.source_id);
    assert_eq!(foreign.object_identity(), "volume:1 file:bob-v2");
    assert_eq!(foreign.snapshot_identity(), "snapshot:1");
    assert_eq!(foreign.captured_through(), Some(1));
    let reservation = f.reserve(body.len(), &destination);
    assert!(matches!(
        PreparedPublication::prepare(lease.clone(), foreign, body.clone(), reservation),
        Err(ValidationError::EvidenceMismatch { .. })
    ));
    assert_eq!(f.budget.usage(), 0);

    // Structural bounds of the trusted observation constructor: a library
    // assertion, not native source authentication.
    assert!(matches!(
        SourceSnapshotObservation::trusted(&lease, String::new(), None),
        Err(ValidationError::Empty { .. })
    ));
    assert!(matches!(
        SourceSnapshotObservation::trusted(&lease, "x".repeat(MAX_METADATA_BYTES + 1), None),
        Err(ValidationError::TooLong { .. })
    ));
    assert!(matches!(
        SourceSnapshotObservation::trusted(&lease, "s".into(), Some(i64::MAX as u64 + 1)),
        Err(ValidationError::IntegerRange { .. })
    ));
    let without_position = SourceSnapshotObservation::trusted(&lease, "s".into(), None).unwrap();
    assert_eq!(without_position.captured_through(), None);
    assert_eq!(without_position.lease_id(), lease.lease_id());
    assert_eq!(
        without_position.registration_epoch(),
        lease.registration_epoch()
    );
    assert_eq!(
        without_position.source_owner_binding_revision(),
        lease.source_owner_binding_revision()
    );
    assert_eq!(
        without_position.source_owner_peer_id(),
        &f.bob.record.peer_id
    );
    // The replaced source: even a matching-lease observation cannot validate.
    let stale = f.prepare(lease, &body, &destination);
    assert!(matches!(
        f.store.validate_context_grant(&f.alice.principal, stale),
        Err(StoreError::SourceUnavailable { .. })
    ));
    assert_eq!(f.budget.usage(), 0);
    assert_eq!(f.commitments(), 0);
}

#[test]
fn prepare_enforces_body_bounds_and_actually_owned_reservation_coverage() {
    let mut f = Fixture::new("publication-bounds", MAX_PUBLICATION_RESERVATION_BYTES * 2);
    let destination = PublicationDestinationId::generate();
    let body = vec![7_u8; 4096];

    // Under-reserved bytes.
    let lease = f.acquire();
    let reservation = f.reserve(4095, &destination);
    assert!(matches!(
        PreparedPublication::prepare(
            lease.clone(),
            Fixture::observe(&lease, 1),
            body.clone(),
            reservation
        ),
        Err(ValidationError::InsufficientReservation {
            reserved: 4095,
            required: 4096
        })
    ));
    assert_eq!(f.budget.usage(), 0);

    // Empty body and oversized body.
    let reservation = f.reserve(1, &destination);
    assert!(matches!(
        PreparedPublication::prepare(
            lease.clone(),
            Fixture::observe(&lease, 1),
            Vec::new(),
            reservation
        ),
        Err(ValidationError::Empty { field: "body" })
    ));
    let reservation = f.reserve(MAX_PUBLICATION_RESERVATION_BYTES, &destination);
    assert!(matches!(
        PreparedPublication::prepare(
            lease.clone(),
            Fixture::observe(&lease, 1),
            vec![0; MAX_PUBLICATION_BYTES + 1],
            reservation
        ),
        Err(ValidationError::TooLong { field: "body", .. })
    ));
    assert_eq!(f.budget.usage(), 0);

    // A reservation larger than the body (transport framing) is valid; a
    // reservation beyond the documented overhead allowance is not.
    let exact = f.reserve(MAX_PUBLICATION_BYTES + 512, &destination);
    let prepared = PreparedPublication::prepare(
        lease.clone(),
        Fixture::observe(&lease, 1),
        vec![1; MAX_PUBLICATION_BYTES],
        exact,
    )
    .unwrap();
    assert_eq!(prepared.body().len(), MAX_PUBLICATION_BYTES);
    assert_eq!(prepared.reserved_bytes(), MAX_PUBLICATION_BYTES + 512);
    assert_eq!(prepared.destination_id(), &destination);
    assert_eq!(f.budget.usage(), MAX_PUBLICATION_BYTES + 512);
    drop(prepared);
    assert_eq!(
        f.budget.usage(),
        0,
        "dropping an unsent prepared response releases once"
    );
    let over = f
        .budget
        .reserve(MAX_PUBLICATION_RESERVATION_BYTES + 1)
        .unwrap();
    assert!(matches!(
        DestinationReservation::from_owned(destination.clone(), over),
        Err(ValidationError::TooLarge {
            field: "reserved_bytes",
            ..
        })
    ));
    assert_eq!(f.budget.usage(), 0);

    // A zero-bound guard is not a reservation.
    #[derive(Debug)]
    struct Hollow;
    impl OwnedDestinationCredits for Hollow {
        fn reserved_bytes(&self) -> usize {
            0
        }
    }
    assert!(matches!(
        DestinationReservation::from_owned(destination.clone(), Hollow),
        Err(ValidationError::Empty {
            field: "reserved_bytes"
        })
    ));

    // Debug output never prints the buffer or the resolver key.
    let prepared = f.prepare(lease, &body, &destination);
    let debug = format!("{prepared:?}");
    assert!(!debug.contains("secret"), "{debug}");
    assert!(!debug.contains("[7, 7"), "{debug}");
    assert!(debug.contains("body_bytes"), "{debug}");
}

#[test]
fn bounded_budget_exhaustion_and_exact_release_on_every_ownership_path() {
    let mut f = Fixture::new("publication-budget", 4096);
    let destination = PublicationDestinationId::generate();
    let body = vec![3_u8; 4096];

    // The whole budget is one permit; a second reservation fails while held.
    let lease = f.acquire();
    let prepared = f.prepare(lease, &body, &destination);
    assert_eq!(f.budget.usage(), 4096);
    assert!(f.budget.reserve(1).is_none(), "budget exhausted while held");

    // Rejection path: forged principal (bob is not the lease caller).
    assert!(matches!(
        f.store.validate_context_grant(&f.bob.principal, prepared),
        Err(StoreError::Unauthorized { .. })
    ));
    assert_eq!(f.budget.usage(), 0, "rejected validation released once");
    assert_eq!(f.commitments(), 0);

    // Success path: the committed response holds the same permit.
    let lease = f.acquire();
    let prepared = f.prepare(lease, &body, &destination);
    let response_id = prepared.response_id().clone();
    let committed = f
        .store
        .validate_context_grant(&f.alice.principal, prepared)
        .unwrap();
    assert_eq!(committed.body(), body.as_slice());
    assert_eq!(committed.record().response_id(), &response_id);
    assert_eq!(committed.record().destination_id(), &destination);
    assert_eq!(committed.record().body_bytes(), 4096);
    assert_eq!(committed.record().reserved_bytes(), 4096);
    assert_eq!(committed.record().snapshot_identity(), "snapshot:40");
    assert_eq!(committed.record().captured_through(), Some(40));
    assert_eq!(committed.reserved_bytes(), 4096);
    assert_eq!(f.budget.usage(), 4096, "commit keeps the permit");
    assert!(f.budget.reserve(1).is_none());
    assert!(f
        .store
        .publication_committed(&f.owner, committed.record().commitment_id())
        .unwrap());

    // Consume into the send wrapper: still one permit, exact bytes.
    let send = committed.into_send(&destination).unwrap();
    assert_eq!(send.body(), body.as_slice());
    assert_eq!(send.destination_id(), &destination);
    assert_eq!(f.budget.usage(), 4096);
    let record = send.finish();
    assert_eq!(f.budget.usage(), 0, "finishing the send releases once");
    assert_eq!(record.response_id(), &response_id);

    // Drop paths: unsent committed and unsent send wrapper release once; the
    // durable audit row stays, and nothing became delivery, fetch or ACK.
    let lease = f.acquire();
    let prepared = f.prepare(lease, &body, &destination);
    let committed = f
        .store
        .validate_context_grant(&f.alice.principal, prepared)
        .unwrap();
    let id = committed.record().commitment_id().clone();
    drop(committed);
    assert_eq!(f.budget.usage(), 0);
    assert!(f.store.publication_committed(&f.owner, &id).unwrap());
    let lease = f.acquire();
    let prepared = f.prepare(lease, &body, &destination);
    let send = f
        .store
        .validate_context_grant(&f.alice.principal, prepared)
        .unwrap()
        .into_send(&destination)
        .unwrap();
    drop(send);
    assert_eq!(f.budget.usage(), 0);
    assert_eq!(f.commitments(), 3);
    f.store.recover_trusted_new_run(&f.owner).unwrap();
    assert!(f
        .store
        .delivery_candidates(
            &f.owner,
            &f.group.group_id,
            &f.alice.record.peer_id,
            f.alice.record.revision,
            8
        )
        .unwrap()
        .is_empty());
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
    let acknowledgements: i64 = Connection::open(&f.path)
        .unwrap()
        .query_row("SELECT count(*) FROM acknowledgements", [], |r| r.get(0))
        .unwrap();
    assert_eq!(acknowledgements, 0);
}

#[test]
fn destination_mismatch_consumes_the_committed_response_and_releases_credits() {
    let mut f = Fixture::new("publication-destination", 1 << 20);
    let connection_a = PublicationDestinationId::generate();
    let reconnect_b = PublicationDestinationId::generate();
    let body = b"bound to connection a".to_vec();
    let lease = f.acquire();
    let prepared = f.prepare(lease, &body, &connection_a);
    let committed = f
        .store
        .validate_context_grant(&f.alice.principal, prepared)
        .unwrap();
    assert_eq!(committed.destination_id(), &connection_a);
    // The reconnected output slot has a fresh identity: the old committed
    // buffer cannot be attached to it. The attempt consumes the object.
    assert!(matches!(
        committed.into_send(&reconnect_b),
        Err(ValidationError::DestinationMismatch)
    ));
    assert_eq!(f.budget.usage(), 0);
    // Retrying needs fresh validation under a new lease and new ownership;
    // the old lease is consumed by its durable commitment.
    let lease = f.acquire();
    let prepared = f.prepare(lease, &body, &reconnect_b);
    let committed = f
        .store
        .validate_context_grant(&f.alice.principal, prepared)
        .unwrap();
    let send = committed.into_send(&reconnect_b).unwrap();
    assert_eq!(send.body(), body.as_slice());
    assert_eq!(f.commitments(), 2);
}

#[test]
fn same_lease_second_response_is_rejected_and_equal_content_under_a_new_lease_is_allowed() {
    let mut f = Fixture::new("publication-lease-reuse", 1 << 20);
    let destination = PublicationDestinationId::generate();
    let body = b"identical bytes".to_vec();
    let lease = f.acquire();
    let first = f.prepare(lease.clone(), &body, &destination);
    let second = f.prepare(lease, b"different bytes", &destination);
    assert_ne!(first.response_id(), second.response_id());
    let committed = f
        .store
        .validate_context_grant(&f.alice.principal, first)
        .unwrap();
    assert!(matches!(
        f.store.validate_context_grant(&f.alice.principal, second),
        Err(StoreError::LeaseConsumed)
    ));
    assert_eq!(
        f.budget.usage(),
        body.len(),
        "only the committed response holds credits"
    );
    // Equal content under a fresh, currently authorized lease is a new response.
    let lease = f.acquire();
    let again = f.prepare(lease, &body, &destination);
    let again = f
        .store
        .validate_context_grant(&f.alice.principal, again)
        .unwrap();
    assert_ne!(
        again.record().response_id(),
        committed.record().response_id()
    );
    assert_ne!(
        again.record().commitment_id(),
        committed.record().commitment_id()
    );
    assert_eq!(again.body(), committed.body());
    assert_eq!(f.commitments(), 2);
}

#[test]
fn ordinary_append_keeps_the_observation_valid_while_owner_transitions_revoke_it() {
    let mut f = Fixture::new("publication-append", 1 << 20);
    let destination = PublicationDestinationId::generate();
    let lease = f.acquire();
    let early = Fixture::observe(&lease, 40);
    // The source grows (a later observation sees more) without any owner
    // transition: the registration epoch is unchanged and the earlier
    // observation still validates.
    let later = Fixture::observe(&lease, 41);
    assert_eq!(early.registration_epoch(), later.registration_epoch());
    let reservation = f.reserve(3, &destination);
    let prepared =
        PreparedPublication::prepare(lease.clone(), early, b"old".to_vec(), reservation).unwrap();
    let committed = f
        .store
        .validate_context_grant(&f.alice.principal, prepared)
        .unwrap();
    assert_eq!(committed.record().captured_through(), Some(40));
    drop(committed);

    // Withdrawal after observation and before validation rejects and releases.
    let lease = f.acquire();
    let observation = Fixture::observe(&lease, 42);
    f.store
        .transition_source(
            &f.owner,
            SourceTransition::Withdraw {
                source_id: f.source.source_id.clone(),
                expected_epoch: f.source.registration_epoch,
            },
        )
        .unwrap();
    let reservation = f.reserve(3, &destination);
    let prepared =
        PreparedPublication::prepare(lease, observation, b"new".to_vec(), reservation).unwrap();
    assert!(matches!(
        f.store.validate_context_grant(&f.alice.principal, prepared),
        Err(StoreError::SourceUnavailable { .. })
    ));
    assert_eq!(f.budget.usage(), 0);
    assert_eq!(f.commitments(), 1);
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

struct WorkerFixture {
    path: std::path::PathBuf,
    worker: Worker,
    client: Client,
    alice: EnrolledPeer,
    group: GroupRecord,
    source: SourceRegistration,
    budget: TestBudget,
}

impl WorkerFixture {
    async fn new(name: &str, config: WorkerConfig, limit: usize) -> Self {
        let path = support::retained_db(name);
        let worker = Worker::open(path.clone(), config).await.unwrap();
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
        Self {
            path,
            worker,
            client,
            alice,
            group,
            source,
            budget: TestBudget::new(limit),
        }
    }

    async fn lease(&self) -> ContextGrantLease {
        let Response::Lease(lease) = call(&self.client, || {
            Command::AcquireContextGrant(
                self.alice.principal.clone(),
                self.group.group_id.clone(),
                self.source.source_id.clone(),
            )
        })
        .await
        .unwrap() else {
            panic!()
        };
        lease
    }

    fn prepare(
        &self,
        lease: ContextGrantLease,
        body: Vec<u8>,
        destination: &PublicationDestinationId,
    ) -> PreparedPublication {
        let observation = Fixture::observe(&lease, 7);
        let reservation = DestinationReservation::from_owned(
            destination.clone(),
            self.budget.reserve(body.len()).expect("budget"),
        )
        .unwrap();
        PreparedPublication::prepare(lease, observation, body, reservation).unwrap()
    }

    fn commitments(&self) -> i64 {
        Connection::open(&self.path)
            .unwrap()
            .query_row("SELECT count(*) FROM publication_commitments", [], |r| {
                r.get(0)
            })
            .unwrap()
    }
}

#[tokio::test]
async fn accepted_then_dropped_pending_leaves_audit_and_releases_output_credits_without_delivery() {
    let f = WorkerFixture::new(
        "publication-dropped-pending",
        WorkerConfig::default(),
        1 << 20,
    )
    .await;
    let destination = PublicationDestinationId::generate();
    let lease = f.lease().await;
    let prepared = f.prepare(lease.clone(), vec![9; 8192], &destination);
    let pending = f
        .client
        .submit(Command::ValidateContextGrant(
            f.alice.principal.clone(),
            prepared,
        ))
        .unwrap_or_else(|error| panic!("admission: {error}"));
    assert_eq!(f.budget.usage(), 8192, "accepted command owns the credits");
    drop(pending);
    // Accepted work still runs; the abandoned reply drops the committed
    // response and its guard. Outcome for the caller is unknown, not rollback.
    let mut waited = 0;
    while f.client.metrics().abandoned_replies == 0 {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        waited += 1;
        assert!(
            waited < 2_000,
            "worker never finished the accepted validation"
        );
    }
    assert_eq!(
        f.budget.usage(),
        0,
        "abandoned committed response released its credits"
    );
    assert_eq!(f.commitments(), 1, "the durable audit row remains");
    // The consumed lease cannot commit a second buffer. The prepared object is
    // not Clone, so it is submitted exactly once rather than through `call`.
    let again = f.prepare(lease, vec![9; 8192], &destination);
    let outcome = f
        .client
        .submit(Command::ValidateContextGrant(
            f.alice.principal.clone(),
            again,
        ))
        .unwrap()
        .await;
    assert!(matches!(
        outcome,
        Err(OperationError::Store(StoreError::LeaseConsumed))
    ));
    assert_eq!(f.budget.usage(), 0);
    // No delivery, mailbox or ACK evidence came from the commitment.
    let Response::Mailbox(page) = call(&f.client, || {
        Command::Mailbox(
            f.alice.principal.clone(),
            MailboxPageRequest {
                group_id: f.group.group_id.clone(),
                cursor: None,
                max_items: 8,
            },
        )
    })
    .await
    .unwrap() else {
        panic!()
    };
    assert!(page.messages.is_empty());
    f.worker.shutdown().await.unwrap();
}

#[tokio::test]
async fn admission_rejection_before_commit_releases_both_accounting_domains() {
    let f = WorkerFixture::new(
        "publication-admission",
        WorkerConfig {
            max_request_bytes: 2 * 1024 * 1024,
            ..Default::default()
        },
        MAX_PUBLICATION_RESERVATION_BYTES,
    )
    .await;
    let destination = PublicationDestinationId::generate();
    let lease = f.lease().await;
    let prepared = f.prepare(lease.clone(), vec![1; 3 * 1024 * 1024], &destination);
    assert_eq!(f.budget.usage(), 3 * 1024 * 1024);
    let before = f.client.metrics();
    assert!(matches!(
        f.client.submit(Command::ValidateContextGrant(
            f.alice.principal.clone(),
            prepared
        )),
        Err(AdmissionError::RequestBytes)
    ));
    let after = f.client.metrics();
    assert_eq!(after.rejected, before.rejected + 1);
    assert_eq!(after.request_bytes, before.request_bytes);
    assert_eq!(
        after.response_reserved_bytes,
        before.response_reserved_bytes
    );
    assert_eq!(
        f.budget.usage(),
        0,
        "rejected command dropped its reservation"
    );
    assert_eq!(
        f.commitments(),
        0,
        "an admission rejection never implies accepted work"
    );
    // Retry needs fresh ownership; the same immutable observation is reusable
    // without redundant source I/O because the lease was never consumed.
    let retry = f.prepare(lease, vec![1; 1024], &destination);
    let Response::CommittedPublication(committed) = f
        .client
        .submit(Command::ValidateContextGrant(
            f.alice.principal.clone(),
            retry,
        ))
        .unwrap()
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(committed.body().len(), 1024);
    assert_eq!(f.budget.usage(), 1024);
    drop(committed);
    assert_eq!(f.budget.usage(), 0);
    f.worker.shutdown().await.unwrap();
}

#[tokio::test]
async fn maximum_response_pressure_keeps_control_headroom_and_separates_the_two_domains() {
    let f = WorkerFixture::new(
        "publication-pressure",
        WorkerConfig {
            max_response_bytes: 20 * 1024 * 1024,
            ..Default::default()
        },
        3 * MAX_PUBLICATION_RESERVATION_BYTES,
    )
    .await;
    let destination = PublicationDestinationId::generate();
    let body = vec![0xAB; MAX_PUBLICATION_BYTES];
    let first = f.prepare(f.lease().await, body.clone(), &destination);
    let second = f.prepare(f.lease().await, body.clone(), &destination);
    let third = f.prepare(f.lease().await, body.clone(), &destination);
    assert_eq!(f.budget.usage(), 3 * MAX_PUBLICATION_BYTES);
    let pending_first = f
        .client
        .submit(Command::ValidateContextGrant(
            f.alice.principal.clone(),
            first,
        ))
        .unwrap();
    let pending_second = f
        .client
        .submit(Command::ValidateContextGrant(
            f.alice.principal.clone(),
            second,
        ))
        .unwrap();
    let metrics = f.client.metrics();
    assert!(
        metrics.response_reserved_bytes >= 2 * MAX_PUBLICATION_BYTES,
        "each publication reserves at least its real body: {}",
        metrics.response_reserved_bytes
    );
    // Two maximum responses fill the 20 MiB budget past a third, but a small
    // control command still admits through the reserved headroom.
    assert!(matches!(
        f.client.submit(Command::ValidateContextGrant(
            f.alice.principal.clone(),
            third
        )),
        Err(AdmissionError::ResponseBytes)
    ));
    assert_eq!(
        f.budget.usage(),
        2 * MAX_PUBLICATION_BYTES,
        "the rejected third publication released its destination credits"
    );
    call(&f.client, || Command::TrustedOwner).await.unwrap();
    let Response::CommittedPublication(first) = pending_first.await.unwrap() else {
        panic!()
    };
    let Response::CommittedPublication(second) = pending_second.await.unwrap() else {
        panic!()
    };
    assert_eq!(first.body(), body.as_slice());
    assert_eq!(second.body(), body.as_slice());
    // The worker reply reservations are released once polled, while the
    // destination credits stay with the committed responses.
    let mut waited = 0;
    while f.client.metrics().response_reserved_bytes != 0 {
        tokio::task::yield_now().await;
        waited += 1;
        assert!(waited < 1_000);
    }
    assert_eq!(f.budget.usage(), 2 * MAX_PUBLICATION_BYTES);
    let metrics = f.client.metrics();
    assert!(metrics.max_response_estimated_bytes <= metrics.max_response_reservation);
    assert!(metrics.max_response_estimated_bytes >= MAX_PUBLICATION_BYTES);
    drop(first);
    assert_eq!(f.budget.usage(), MAX_PUBLICATION_BYTES);
    let send = second.into_send(&destination).unwrap();
    assert_eq!(send.body().len(), MAX_PUBLICATION_BYTES);
    drop(send);
    assert_eq!(f.budget.usage(), 0);
    f.worker.shutdown().await.unwrap();
    assert_eq!(f.client.metrics().outcome_unknown, 0);
}
