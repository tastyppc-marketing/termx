//! Task 2 fix 1 regressions for the runtime-observable review defects.
//!
//! RED form (retained evidence `task-2-fix-1-tdd-red-1-*`): written against the
//! frozen Task 2 API, these failed at runtime on the actual defects (I1
//! unbounded nested owner/active scans, I2 hidden-branch thread scans, I3 bare
//! position reuse after continuation, I4 continuation token omitted from page
//! sizing, C1 claimed credits accepted). GREEN form: the same probes on the
//! repaired API; the C1 probe now shows that no unowned path exists.
mod support;

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use rusqlite::{params, Connection};
use termx_swarm_core::error::{StoreError, ValidationError};
use termx_swarm_core::model::*;
use termx_swarm_core::store::Store;

const PROGRESS_INTERVAL: i32 = 100;

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

fn send(group_id: &GroupId, key: &str, recipients: &[&PeerId], body: &str) -> SendMessageRequest {
    SendMessageRequest {
        group_id: group_id.clone(),
        client_key: key.to_owned(),
        recipients: members(recipients),
        body: body.to_owned(),
        topic: None,
        reply_to: None,
        attachments: Vec::new(),
    }
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

/// Runs one store operation under the bundled-SQLite progress handler and
/// returns the number of callbacks at `PROGRESS_INTERVAL` VM instructions.
fn counted<T>(store: &mut Store, operation: impl FnOnce(&mut Store) -> T) -> (T, usize) {
    let callbacks = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&callbacks);
    store
        .progress_handler(
            PROGRESS_INTERVAL,
            Some(Box::new(move || {
                counter.fetch_add(1, Ordering::Relaxed);
                false
            })),
        )
        .unwrap();
    let result = operation(store);
    store.progress_handler(0, None).unwrap();
    (result, callbacks.load(Ordering::Relaxed))
}

#[test]
fn owner_single_item_pages_and_active_lookups_stay_bounded_under_large_retained_history() {
    const HISTORY: i64 = 3_000;
    let path = support::retained_db("owner-bounded-history");
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
    let active = store
        .register_source(&owner, descriptor(&bob, "active"))
        .unwrap();
    let authority: String = {
        let connection = Connection::open(&path).unwrap();
        connection
            .query_row("SELECT authority_id FROM authority_metadata", [], |r| {
                r.get(0)
            })
            .unwrap()
    };
    {
        let connection = Connection::open(&path).unwrap();
        connection
            .pragma_update(None, "foreign_keys", true)
            .unwrap();
        let tx = connection.unchecked_transaction().unwrap();
        // Large removed-member history in the pair group.
        tx.execute(
            "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<?1) INSERT INTO peers(peer_id,current_binding_revision,created_at_millis) SELECT printf('p_%032x',n),1,1 FROM seq",
            [HISTORY],
        )
        .unwrap();
        tx.execute(
            "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<?1) INSERT INTO peer_bindings(peer_id,binding_revision,launch_id,terminal_id,harness,conversation_id,process_id,process_creation_filetime,live,bound_at_millis) SELECT printf('p_%032x',n),1,printf('l_%032x',n),printf('t-%d',n),'codex',printf('c-%d',n),1,1,1,1 FROM seq",
            [HISTORY],
        )
        .unwrap();
        tx.execute(
            "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<?1) INSERT INTO group_memberships(group_id,peer_id,added_policy_revision,removed_policy_revision) SELECT ?2,printf('p_%032x',n),1,1 FROM seq",
            params![HISTORY, group.group_id.as_str()],
        )
        .unwrap();
        // Large removed-membership history for bob across many groups.
        tx.execute(
            "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<?1) INSERT INTO groups(group_id,authority_id,policy_revision,next_sequence,label,paused,created_at_millis) SELECT printf('g_%032x',n),?2,2,1,printf('h-%d',n),0,1 FROM seq",
            params![HISTORY, authority],
        )
        .unwrap();
        tx.execute(
            "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<?1) INSERT INTO group_memberships(group_id,peer_id,added_policy_revision,removed_policy_revision) SELECT printf('g_%032x',n),?2,1,2 FROM seq",
            params![HISTORY, bob.record.peer_id.as_str()],
        )
        .unwrap();
        // Large withdrawn registration history for bob's current binding.
        tx.execute(
            "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<?1) INSERT INTO source_registrations(source_id,peer_id,binding_revision,conversation_id,source_kind,resolver_key,object_identity,evidence_reference,state,registration_epoch,replaced_by_source_id,registered_at_millis,transitioned_at_millis) SELECT printf('src_%032x',n),?2,?3,?4,'codex-jsonl',printf('r-%d',n),printf('o-%d',n),printf('e-%d',n),'withdrawn',2,NULL,1,1 FROM seq",
            params![
                HISTORY,
                bob.record.peer_id.as_str(),
                bob.record.revision.as_sql_i64(),
                bob.record.conversation_id
            ],
        )
        .unwrap();
        tx.commit().unwrap();
    }
    store = Store::open(&path).unwrap();

    // A one-item outer owner page positioned exactly at bob.
    let mut ids: Vec<PeerId> = Vec::new();
    {
        let connection = Connection::open(&path).unwrap();
        let mut statement = connection
            .prepare("SELECT peer_id FROM peers ORDER BY peer_id")
            .unwrap();
        for row in statement.query_map([], |r| r.get::<_, String>(0)).unwrap() {
            ids.push(PeerId::parse(&row.unwrap()).unwrap());
        }
    }
    let position = ids.iter().position(|id| *id == bob.record.peer_id).unwrap();
    let after_peer = position.checked_sub(1).map(|index| ids[index].clone());
    // Continuation keys are only honoured under the captured inventory revision.
    let OwnerSnapshotPage::Peers(first) = store
        .owner_snapshot(
            &owner,
            OwnerSnapshotRequest::Peers {
                expected_inventory_revision: None,
                after_peer: None,
                max_items: 1,
            },
        )
        .unwrap()
    else {
        panic!("peers page")
    };
    let captured = first.revisions.inventory_revision;
    let (page, outer) = counted(&mut store, |store| {
        store
            .owner_snapshot(
                &owner,
                OwnerSnapshotRequest::Peers {
                    expected_inventory_revision: Some(captured),
                    after_peer,
                    max_items: 1,
                },
            )
            .unwrap()
    });
    let OwnerSnapshotPage::Peers(page) = page else {
        panic!("peers page")
    };
    assert_eq!(page.peers[0].binding.peer_id, bob.record.peer_id);

    // Public peer listing of the group with a large removed prefix, including
    // bob's active source summary behind a large withdrawn history.
    let (peers, listing) = counted(&mut store, |store| {
        store
            .list_peers(
                &alice.principal,
                ListPeersRequest {
                    group_id: group.group_id.clone(),
                    after_peer: None,
                    max_items: 8,
                },
            )
            .unwrap()
    });
    assert_eq!(peers.peers.len(), 2);
    let bob_view = peers
        .peers
        .iter()
        .find(|p| p.peer_id == bob.record.peer_id)
        .unwrap();
    assert_eq!(bob_view.sources.len(), 1);
    assert_eq!(bob_view.sources[0].source_id, active.source_id);

    // A capacity decision for one more active registration.
    let (registered, capacity) = counted(&mut store, |store| {
        store
            .register_source(&owner, descriptor(&bob, "second"))
            .unwrap()
    });
    assert_eq!(registered.state, SourceState::Active);

    eprintln!(
        "owner one-item page: {outer} callbacks; list_peers: {listing} callbacks; capacity: {capacity} callbacks ({PROGRESS_INTERVAL}-opcode interval, {HISTORY}-row histories)"
    );
    assert!(
        outer <= 40,
        "outer owner page materialized nested history: {outer} callbacks"
    );
    assert!(
        listing <= 40,
        "list_peers scanned removed/withdrawn history: {listing} callbacks"
    );
    assert!(
        capacity <= 40,
        "active capacity scanned withdrawn history: {capacity} callbacks"
    );
}

#[test]
fn thread_pages_after_large_hidden_branch_perform_bounded_work() {
    const HIDDEN: i64 = 5_000;
    let path = support::retained_db("thread-hidden-branch");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let alice = store.enroll_peer(&owner, binding("alice")).unwrap();
    let bob = store.enroll_peer(&owner, binding("bob")).unwrap();
    let carol = store.enroll_peer(&owner, binding("carol")).unwrap();
    let group = store
        .create_group(
            &owner,
            "thread",
            members(&[
                &alice.record.peer_id,
                &bob.record.peer_id,
                &carol.record.peer_id,
            ]),
        )
        .unwrap();
    let root = store
        .send_message(
            &alice.principal,
            send(
                &group.group_id,
                "root",
                &[&bob.record.peer_id, &carol.record.peer_id],
                "root",
            ),
        )
        .unwrap();
    {
        let connection = Connection::open(&path).unwrap();
        connection
            .pragma_update(None, "foreign_keys", true)
            .unwrap();
        let tx = connection.unchecked_transaction().unwrap();
        // Thousands of same-thread replies addressed only to bob.
        tx.execute(
            "WITH RECURSIVE seq(n) AS (VALUES(2) UNION ALL SELECT n+1 FROM seq WHERE n<?1) INSERT INTO messages(message_id,group_id,group_sequence,sender_peer_id,sender_binding_revision,client_key,semantic_payload_json,body,reply_to_message_id,committed_at_millis,thread_root_message_id) SELECT printf('m_%032x',n),?2,n,?3,1,printf('hidden-%d',n),'{}','private to bob',?4,1,?4 FROM seq",
            params![
                HIDDEN + 1,
                group.group_id.as_str(),
                alice.record.peer_id.as_str(),
                root.message_id.as_str()
            ],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO recipient_deliveries(message_id,recipient_peer_id,recipient_binding_revision,saved_at_millis,delivery_generation) SELECT message_id,?1,1,1,1 FROM messages WHERE group_id=?2 AND group_sequence>1",
            params![bob.record.peer_id.as_str(), group.group_id.as_str()],
        )
        .unwrap();
        tx.execute(
            "UPDATE groups SET next_sequence=?1 WHERE group_id=?2",
            params![HIDDEN + 2, group.group_id.as_str()],
        )
        .unwrap();
        tx.commit().unwrap();
    }
    store = Store::open(&path).unwrap();

    let read = |store: &mut Store, after: u64| {
        store.read_thread(
            &carol.principal,
            ThreadPageRequest {
                group_id: group.group_id.clone(),
                root: root.message_id.clone(),
                navigation: MailboxNavigation::ResetAfter {
                    after_sequence: after,
                },
                max_items: 8,
            },
        )
    };
    let (empty, empty_work) = counted(&mut store, |store| read(store, 1).unwrap());
    assert!(empty.messages.is_empty() && empty.next_cursor.is_none());
    assert_eq!(empty.snapshot_high_sequence, HIDDEN as u64 + 1);

    let mut late = send(
        &group.group_id,
        "late",
        &[&carol.record.peer_id],
        "for carol",
    );
    late.reply_to = Some(root.message_id.clone());
    let late = store.send_message(&alice.principal, late).unwrap();
    let (visible, late_work) = counted(&mut store, |store| read(store, 1).unwrap());
    assert_eq!(
        visible
            .messages
            .iter()
            .map(|e| e.message.message_id.clone())
            .collect::<Vec<_>>(),
        vec![late.message_id.clone()]
    );
    let (tail, tail_work) = counted(&mut store, |store| {
        read(store, late.group_sequence).unwrap()
    });
    assert!(tail.messages.is_empty());
    eprintln!(
        "hidden branch of {HIDDEN}: empty tail {empty_work}, late reply {late_work}, empty tail after reply {tail_work} callbacks ({PROGRESS_INTERVAL}-opcode interval)"
    );
    assert!(
        empty_work <= 30,
        "empty thread tail scanned the hidden branch: {empty_work} callbacks"
    );
    assert!(
        late_work <= 30,
        "late visible reply scanned the hidden branch: {late_work} callbacks"
    );
    assert!(
        tail_work <= 30,
        "empty tail after the reply scanned the hidden branch: {tail_work} callbacks"
    );
}

#[test]
fn predecessor_position_is_rejected_and_explicit_reset_exposes_transferred_backlog() {
    let path = support::retained_db("predecessor-position");
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
    for key in ["one", "two", "three"] {
        store
            .send_message(
                &alice.principal,
                send(&group.group_id, key, &[&bob.record.peer_id], key),
            )
            .unwrap();
    }
    // The predecessor reads past sequence 2 without fetching 1 and 2.
    let page = store
        .read_mailbox_after(
            &bob.principal,
            MailboxAfterRequest {
                group_id: group.group_id.clone(),
                navigation: MailboxNavigation::ResetAfter { after_sequence: 2 },
                max_items: 8,
            },
        )
        .unwrap();
    assert_eq!(
        page.messages
            .iter()
            .map(|e| e.message.group_sequence)
            .collect::<Vec<_>>(),
        vec![3]
    );
    let predecessor_position = page.resume_position.clone();
    assert_eq!(
        predecessor_position.after_sequence(),
        page.snapshot_high_sequence
    );
    let bob2 = store
        .continue_peer(
            &owner,
            rebind(&bob, "terminal-bob-2"),
            "continue",
            [(group.group_id.clone(), group.policy_revision)].into(),
        )
        .unwrap();
    // Reusing the predecessor's store-built position under the successor must
    // be an explicit rejection, never a silent empty page that skips 1 and 2.
    let reused = store.read_mailbox_after(
        &bob2.principal,
        MailboxAfterRequest {
            group_id: group.group_id.clone(),
            navigation: MailboxNavigation::Position(predecessor_position),
            max_items: 8,
        },
    );
    assert!(
        matches!(reused, Err(StoreError::StalePosition)),
        "predecessor position was silently reused: {reused:?}"
    );
    // Only a deliberate bare reset repositions the successor.
    let reset = store
        .read_mailbox_after(
            &bob2.principal,
            MailboxAfterRequest {
                group_id: group.group_id.clone(),
                navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
                max_items: 8,
            },
        )
        .unwrap();
    assert_eq!(
        reset
            .messages
            .iter()
            .map(|e| e.message.group_sequence)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
}

fn nul_status(chars: usize) -> Option<String> {
    Some("\u{0}".repeat(chars))
}

#[test]
fn list_peers_final_envelope_including_continuation_token_stays_within_bound() {
    const PEERS: usize = 100;
    let path = support::retained_db("list-peers-threshold");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let mut peers: Vec<EnrolledPeer> = (0..PEERS)
        .map(|index| {
            store
                .enroll_peer(&owner, binding(&format!("peer-{index}")))
                .unwrap()
        })
        .collect();
    peers.sort_by(|a, b| a.record.peer_id.cmp(&b.record.peer_id));
    let group = store
        .create_group(
            &owner,
            "threshold",
            peers.iter().map(|p| p.record.peer_id.clone()).collect(),
        )
        .unwrap();
    let caller = peers[0].principal.clone();
    let prefix = PEERS - 1;
    let publish = |store: &mut Store, index: usize, status: Option<String>| {
        store
            .publish_status(
                &peers[index].principal,
                StatusRequest {
                    group_id: group.group_id.clone(),
                    status,
                },
            )
            .unwrap();
    };
    let measure = |store: &mut Store| -> usize {
        let page = store
            .list_peers(
                &caller,
                ListPeersRequest {
                    group_id: group.group_id.clone(),
                    after_peer: None,
                    max_items: prefix,
                },
            )
            .unwrap();
        assert_eq!(page.peers.len(), prefix, "prefix must fit while tuning");
        assert!(page.next_after_peer.is_some());
        serde_json::to_vec(&page).unwrap().len()
    };
    // Target: the first `prefix` items plus the continuation token exceed the
    // bound by a few bytes, while the same items without a token fit.
    let target = MAX_METADATA_PAGE_BYTES + 8;
    let coarse = prefix - 2;
    let fine = prefix - 1;
    let mut size = measure(&mut store);
    for index in 0..coarse {
        if target - size <= 24_576 + 4_040 + 400 {
            break;
        }
        publish(&mut store, index, nul_status(MAX_STATUS_BYTES));
        size = measure(&mut store);
    }
    publish(&mut store, coarse, nul_status(1));
    size = measure(&mut store);
    let remaining = target - size;
    let coarse_chars = ((remaining - 2_048) / 6).min(MAX_STATUS_BYTES);
    publish(&mut store, coarse, nul_status(coarse_chars));
    publish(&mut store, fine, Some("x".into()));
    size = measure(&mut store);
    let remaining = target - size;
    assert!(
        (56..=4_040).contains(&remaining),
        "tuning window missed: {remaining}"
    );
    publish(&mut store, fine, Some("x".repeat(1 + remaining)));

    // Final page: the store must return a serialized envelope within the bound
    // and a lossless continuation.
    let mut seen = Vec::new();
    let mut after = None;
    let mut first = true;
    loop {
        let page = store
            .list_peers(
                &caller,
                ListPeersRequest {
                    group_id: group.group_id.clone(),
                    after_peer: after.clone(),
                    max_items: prefix,
                },
            )
            .unwrap();
        let bytes = serde_json::to_vec(&page).unwrap().len();
        if first {
            assert!(
                bytes > MAX_METADATA_PAGE_BYTES - 4_096 - 64,
                "threshold not exercised: first page is {bytes} bytes"
            );
            first = false;
        }
        assert!(
            bytes <= MAX_METADATA_PAGE_BYTES,
            "final serialized page is {bytes} bytes, over the {MAX_METADATA_PAGE_BYTES} bound"
        );
        seen.extend(page.peers.into_iter().map(|p| p.peer_id));
        after = page.next_after_peer;
        if after.is_none() {
            break;
        }
    }
    assert_eq!(
        seen,
        peers
            .iter()
            .map(|p| p.record.peer_id.clone())
            .collect::<Vec<_>>()
    );
}

#[test]
fn publication_validation_rejects_claimed_credits_without_owned_evidence() {
    let path = support::retained_db("claimed-credits");
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
    let lease = store
        .acquire_context_grant(&alice.principal, &group.group_id, &source.source_id)
        .unwrap();
    // RED form: a bare string plus a claimed byte count was committed. GREEN:
    // validation only accepts a prepared response, which cannot exist without
    // an observation bound to this exact lease and an actually held guard.
    #[derive(Debug)]
    struct Claimed(usize);
    impl OwnedDestinationCredits for Claimed {
        fn reserved_bytes(&self) -> usize {
            self.0
        }
        /// A bare integer owns no heap; its inline size is counted once by
        /// the constructor.
        fn owned_heap_bytes(&self) -> usize {
            0
        }
    }
    let destination = PublicationDestinationId::generate();
    assert!(matches!(
        DestinationReservation::from_owned(destination.clone(), Claimed(0)),
        Err(ValidationError::Empty {
            field: "reserved_bytes"
        })
    ));
    let reservation = DestinationReservation::from_owned(destination.clone(), Claimed(1)).unwrap();
    let observation =
        SourceSnapshotObservation::trusted(&lease, "snapshot".into(), Some(1)).unwrap();
    assert!(matches!(
        PreparedPublication::prepare(lease.clone(), observation, vec![0; 4096], reservation),
        Err(ValidationError::InsufficientReservation {
            reserved: 1,
            required: 4096
        })
    ));
    let other = store
        .acquire_context_grant(&alice.principal, &group.group_id, &source.source_id)
        .unwrap();
    let foreign = SourceSnapshotObservation::trusted(&other, "snapshot".into(), Some(1)).unwrap();
    let reservation = DestinationReservation::from_owned(destination, Claimed(4096)).unwrap();
    assert!(matches!(
        PreparedPublication::prepare(lease, foreign, vec![0; 4096], reservation),
        Err(ValidationError::EvidenceMismatch { field: "lease_id" })
    ));
    let commitments: i64 = Connection::open(&path)
        .unwrap()
        .query_row("SELECT count(*) FROM publication_commitments", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(commitments, 0);
}
