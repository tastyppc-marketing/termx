//! I2: thread pages are built from two bounded key ranges (messages the caller
//! sent, current deliveries to the caller's exact binding) merged in Rust,
//! backed by a transactional projection that follows send, continuation and
//! rollback. Legacy sender/self rows appear once and stay ACK-ineligible.
mod support;

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use rusqlite::{params, Connection};
use termx_swarm_core::error::StoreError;
use termx_swarm_core::model::*;
use termx_swarm_core::store::Store;

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

fn members(ids: &[&PeerId]) -> BTreeSet<PeerId> {
    ids.iter().map(|id| (*id).clone()).collect()
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

fn reply(
    group_id: &GroupId,
    key: &str,
    recipients: &[&PeerId],
    reply_to: &MessageId,
) -> SendMessageRequest {
    SendMessageRequest {
        reply_to: Some(reply_to.clone()),
        ..send(group_id, key, recipients, key)
    }
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
                "threads",
                members(&[
                    &alice.record.peer_id,
                    &bob.record.peer_id,
                    &carol.record.peer_id,
                ]),
            )
            .unwrap();
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

    fn thread(
        &mut self,
        principal: &PeerPrincipal,
        root: &MessageId,
        navigation: MailboxNavigation,
        max_items: usize,
    ) -> Result<ThreadPage, StoreError> {
        self.store.read_thread(
            principal,
            ThreadPageRequest {
                group_id: self.group.group_id.clone(),
                root: root.clone(),
                navigation,
                max_items,
            },
        )
    }

    fn projection(&self) -> Vec<(String, String, i64, String, i64, String)> {
        let connection = Connection::open(&self.path).unwrap();
        let mut statement = connection
            .prepare("SELECT message_id,recipient_peer_id,recipient_binding_revision,thread_root_message_id,group_sequence,sender_peer_id FROM current_thread_deliveries WHERE group_id=?1 ORDER BY group_sequence,recipient_peer_id")
            .unwrap();
        let rows = statement
            .query_map([self.group.group_id.as_str()], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .unwrap();
        rows.map(Result::unwrap).collect()
    }
}

fn counted<T>(store: &mut Store, operation: impl FnOnce(&mut Store) -> T) -> (T, usize) {
    let callbacks = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&callbacks);
    store
        .progress_handler(
            100,
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

fn sequences(page: &ThreadPage) -> Vec<u64> {
    page.messages
        .iter()
        .map(|entry| entry.message.group_sequence)
        .collect()
}

#[test]
fn projection_follows_send_continuation_and_transactional_rollback() {
    let mut f = Fixture::new("thread-projection");
    let root = f
        .store
        .send_message(
            &f.alice.principal,
            send(
                &f.group.group_id,
                "root",
                &[&f.bob.record.peer_id, &f.carol.record.peer_id],
                "root",
            ),
        )
        .unwrap();
    // Carol answers alice: her root delivery becomes a replied row that stays
    // on her binding; bob's root delivery remains unfetched and unreplied.
    let answer = f
        .store
        .send_message(
            &f.carol.principal,
            reply(
                &f.group.group_id,
                "answer",
                &[&f.alice.record.peer_id],
                &root.message_id,
            ),
        )
        .unwrap();
    let mut expected = vec![
        (
            root.message_id.as_str().to_owned(),
            f.bob.record.peer_id.as_str().to_owned(),
            1,
            root.message_id.as_str().to_owned(),
            1,
            f.alice.record.peer_id.as_str().to_owned(),
        ),
        (
            root.message_id.as_str().to_owned(),
            f.carol.record.peer_id.as_str().to_owned(),
            1,
            root.message_id.as_str().to_owned(),
            1,
            f.alice.record.peer_id.as_str().to_owned(),
        ),
        (
            answer.message_id.as_str().to_owned(),
            f.alice.record.peer_id.as_str().to_owned(),
            1,
            root.message_id.as_str().to_owned(),
            2,
            f.carol.record.peer_id.as_str().to_owned(),
        ),
    ];
    expected[0..2].sort();
    assert_eq!(f.projection(), expected);

    // Carol fetches the root; bob does not. Continuation moves only bob's
    // unfetched, unreplied current delivery, and the projection follows.
    f.thread(
        &f.carol.principal.clone(),
        &root.message_id,
        MailboxNavigation::ResetAfter { after_sequence: 0 },
        8,
    )
    .unwrap();
    let bob2 = f
        .store
        .continue_peer(
            &f.owner,
            rebind(&f.bob, "terminal-bob-2"),
            "continue",
            [(f.group.group_id.clone(), f.group.policy_revision)].into(),
        )
        .unwrap();
    assert_eq!(bob2.record.revision.get(), 2);
    expected
        .iter_mut()
        .find(|row| row.1 == f.bob.record.peer_id.as_str())
        .unwrap()
        .2 = 2;
    assert_eq!(f.projection(), expected);
    let page = f
        .thread(
            &bob2.principal,
            &root.message_id,
            MailboxNavigation::ResetAfter { after_sequence: 0 },
            8,
        )
        .unwrap();
    assert_eq!(sequences(&page), vec![1]);
    assert!(page.messages[0].receipt.is_some());
    assert!(matches!(
        f.thread(
            &f.bob.principal.clone(),
            &root.message_id,
            MailboxNavigation::ResetAfter { after_sequence: 0 },
            8
        ),
        Err(StoreError::StaleBinding)
    ));
    // Carol's replied, fetched root row stayed on her binding and is still
    // visible to her, alongside her own answer through the sender range.
    let page = f
        .thread(
            &f.carol.principal.clone(),
            &root.message_id,
            MailboxNavigation::ResetAfter { after_sequence: 0 },
            8,
        )
        .unwrap();
    assert_eq!(sequences(&page), vec![1, 2]);

    // The projection is transactional with its base rows: a rolled back
    // delivery leaves no projection row, and deleting a current delivery
    // removes its projection row.
    let connection = Connection::open(&f.path).unwrap();
    connection
        .pragma_update(None, "foreign_keys", true)
        .unwrap();
    let tx = connection.unchecked_transaction().unwrap();
    tx.execute(
        "INSERT INTO messages(message_id,group_id,group_sequence,sender_peer_id,sender_binding_revision,client_key,semantic_payload_json,body,reply_to_message_id,committed_at_millis,thread_root_message_id) VALUES ('m_000000000000000000000000000000aa',?1,3,?2,1,'raw','{}','raw',?3,1,?3)",
        params![f.group.group_id.as_str(), f.alice.record.peer_id.as_str(), root.message_id.as_str()],
    )
    .unwrap();
    tx.execute(
        "INSERT INTO recipient_deliveries(message_id,recipient_peer_id,recipient_binding_revision,saved_at_millis,delivery_generation) VALUES ('m_000000000000000000000000000000aa',?1,1,1,1)",
        [f.carol.record.peer_id.as_str()],
    )
    .unwrap();
    let inside: i64 = tx
        .query_row(
            "SELECT count(*) FROM current_thread_deliveries WHERE message_id='m_000000000000000000000000000000aa'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(inside, 1);
    tx.rollback().unwrap();
    assert_eq!(f.projection(), expected);
    let connection = Connection::open(&f.path).unwrap();
    connection
        .pragma_update(None, "foreign_keys", true)
        .unwrap();
    connection
        .execute(
            "DELETE FROM current_deliveries WHERE message_id=?1 AND recipient_peer_id=?2",
            params![root.message_id.as_str(), f.carol.record.peer_id.as_str()],
        )
        .unwrap();
    expected.retain(|row| {
        !(row.0 == root.message_id.as_str() && row.1 == f.carol.record.peer_id.as_str())
    });
    assert_eq!(f.projection(), expected);
}

#[test]
fn thread_merge_orders_dedupes_and_pages_across_sender_and_recipient_ranges() {
    let mut f = Fixture::new("thread-merge");
    let root = f
        .store
        .send_message(
            &f.alice.principal,
            send(
                &f.group.group_id,
                "root",
                &[&f.bob.record.peer_id, &f.carol.record.peer_id],
                "root",
            ),
        )
        .unwrap();
    // 2: alice -> bob (sender range for alice, recipient range for bob).
    f.store
        .send_message(
            &f.alice.principal,
            reply(
                &f.group.group_id,
                "a1",
                &[&f.bob.record.peer_id],
                &root.message_id,
            ),
        )
        .unwrap();
    // 3: bob -> alice (recipient range for alice, sender range for bob).
    f.store
        .send_message(
            &f.bob.principal,
            reply(
                &f.group.group_id,
                "b1",
                &[&f.alice.record.peer_id],
                &root.message_id,
            ),
        )
        .unwrap();
    // 4: carol -> bob (hidden from alice).
    f.store
        .send_message(
            &f.carol.principal,
            reply(
                &f.group.group_id,
                "c1",
                &[&f.bob.record.peer_id],
                &root.message_id,
            ),
        )
        .unwrap();
    // 5, 6, 7: alice -> carol (sender range for alice beyond one page).
    for key in ["a2", "a3", "a4"] {
        f.store
            .send_message(
                &f.alice.principal,
                reply(
                    &f.group.group_id,
                    key,
                    &[&f.carol.record.peer_id],
                    &root.message_id,
                ),
            )
            .unwrap();
    }
    // 8: unrelated message raises the watermark.
    f.store
        .send_message(
            &f.carol.principal,
            send(
                &f.group.group_id,
                "other",
                &[&f.alice.record.peer_id],
                "other",
            ),
        )
        .unwrap();

    let mut seen = Vec::new();
    let mut navigation = MailboxNavigation::ResetAfter { after_sequence: 0 };
    let mut pages = 0;
    loop {
        let page = f
            .thread(&f.alice.principal.clone(), &root.message_id, navigation, 2)
            .unwrap();
        pages += 1;
        assert!(page.messages.len() <= 2);
        assert_eq!(page.snapshot_high_sequence, 8);
        for entry in &page.messages {
            let mine = entry.message.sender_peer_id == f.alice.record.peer_id;
            assert_eq!(entry.receipt.is_some(), !mine, "{entry:?}");
        }
        seen.extend(sequences(&page));
        match page.next_cursor {
            Some(cursor) => navigation = MailboxNavigation::Cursor(cursor),
            None => break,
        }
    }
    assert_eq!(seen, vec![1, 2, 3, 5, 6, 7]);
    assert_eq!(pages, 3);
    // Bob: recipient of 1, 2, 4; sender of 3.
    let page = f
        .thread(
            &f.bob.principal.clone(),
            &root.message_id,
            MailboxNavigation::ResetAfter { after_sequence: 0 },
            3,
        )
        .unwrap();
    assert_eq!(sequences(&page), vec![1, 2, 3]);
    assert_eq!(page.resume_position.after_sequence(), 3);
    let rest = f
        .thread(
            &f.bob.principal.clone(),
            &root.message_id,
            MailboxNavigation::Position(page.resume_position.clone()),
            3,
        )
        .unwrap();
    assert_eq!(sequences(&rest), vec![4]);
    assert!(rest.next_cursor.is_none());
    // Carol: recipient of 1, 5, 6, 7; sender of 4.
    let page = f
        .thread(
            &f.carol.principal.clone(),
            &root.message_id,
            MailboxNavigation::ResetAfter { after_sequence: 1 },
            8,
        )
        .unwrap();
    assert_eq!(sequences(&page), vec![4, 5, 6, 7]);
    // A recipient-only reader with an invisible root still gets NotFound.
    let dave = f.store.enroll_peer(&f.owner, binding("dave")).unwrap();
    let group = f
        .store
        .set_membership(
            &f.owner,
            &f.group.group_id,
            &dave.record.peer_id,
            true,
            f.group.policy_revision,
        )
        .unwrap();
    f.group = group;
    assert!(matches!(
        f.thread(
            &dave.principal,
            &root.message_id,
            MailboxNavigation::ResetAfter { after_sequence: 0 },
            8
        ),
        Err(StoreError::NotFound {
            kind: "thread root"
        })
    ));
}

#[test]
fn legacy_self_recipient_rows_appear_once_with_receipt_and_stay_ack_ineligible() {
    const HISTORY: i64 = 5_000;
    let mut f = Fixture::new("thread-legacy-self");
    let root = f
        .store
        .send_message(
            &f.alice.principal,
            send(&f.group.group_id, "root", &[&f.bob.record.peer_id], "root"),
        )
        .unwrap();
    {
        let connection = Connection::open(&f.path).unwrap();
        connection
            .pragma_update(None, "foreign_keys", true)
            .unwrap();
        let tx = connection.unchecked_transaction().unwrap();
        // Retained v2 sender/self rows: bob is sender and current recipient of
        // every reply, with no ACK-order row.
        tx.execute(
            "WITH RECURSIVE seq(n) AS (VALUES(2) UNION ALL SELECT n+1 FROM seq WHERE n<?1) INSERT INTO messages(message_id,group_id,group_sequence,sender_peer_id,sender_binding_revision,client_key,semantic_payload_json,body,reply_to_message_id,committed_at_millis,thread_root_message_id) SELECT printf('m_%032x',n),?2,n,?3,1,printf('self-%d',n),'{}','self',?4,1,?4 FROM seq",
            params![HISTORY + 1, f.group.group_id.as_str(), f.bob.record.peer_id.as_str(), root.message_id.as_str()],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO recipient_deliveries(message_id,recipient_peer_id,recipient_binding_revision,saved_at_millis,delivery_generation) SELECT message_id,?1,1,1,1 FROM messages WHERE group_id=?2 AND group_sequence>1",
            params![f.bob.record.peer_id.as_str(), f.group.group_id.as_str()],
        )
        .unwrap();
        tx.execute(
            "UPDATE groups SET next_sequence=?1 WHERE group_id=?2",
            params![HISTORY + 2, f.group.group_id.as_str()],
        )
        .unwrap();
        tx.commit().unwrap();
    }
    f.store = Store::open(&f.path).unwrap();
    let high = HISTORY as u64 + 1;

    // Each overlapping row appears exactly once, carries the recipient
    // receipt, and is not ACK-eligible.
    let (late, late_work) = counted(&mut f.store, |store| {
        store
            .read_thread(
                &f.bob.principal,
                ThreadPageRequest {
                    group_id: f.group.group_id.clone(),
                    root: root.message_id.clone(),
                    navigation: MailboxNavigation::ResetAfter {
                        after_sequence: high - 3,
                    },
                    max_items: 8,
                },
            )
            .unwrap()
    });
    assert_eq!(sequences(&late), vec![high - 2, high - 1, high]);
    for entry in &late.messages {
        assert_eq!(entry.message.sender_peer_id, f.bob.record.peer_id);
        let receipt = entry.receipt.as_ref().expect("current self delivery");
        assert!(receipt.fetched_at_millis.is_some());
        assert!(receipt.acknowledged_at_millis.is_none());
        assert!(matches!(
            f.store.acknowledge_message(
                &f.bob.principal,
                &f.group.group_id,
                &entry.message.message_id
            ),
            Err(StoreError::Unauthorized { .. })
        ));
    }
    let (tail, tail_work) = counted(&mut f.store, |store| {
        store
            .read_thread(
                &f.bob.principal,
                ThreadPageRequest {
                    group_id: f.group.group_id.clone(),
                    root: root.message_id.clone(),
                    navigation: MailboxNavigation::ResetAfter {
                        after_sequence: high,
                    },
                    max_items: 8,
                },
            )
            .unwrap()
    });
    assert!(tail.messages.is_empty() && tail.next_cursor.is_none());
    assert_eq!(tail.resume_position.after_sequence(), high);
    eprintln!(
        "overlapping self history of {HISTORY}: late page {late_work}, empty tail {tail_work} callbacks (100-opcode interval)"
    );
    assert!(late_work <= 30, "late page scanned history: {late_work}");
    assert!(tail_work <= 30, "empty tail scanned history: {tail_work}");
    // A full page from the start: 128 distinct rows and a cursor.
    let page = f
        .thread(
            &f.bob.principal.clone(),
            &root.message_id,
            MailboxNavigation::ResetAfter { after_sequence: 0 },
            MAX_MAILBOX_PAGE_ITEMS,
        )
        .unwrap();
    assert_eq!(
        sequences(&page),
        (1..=MAX_MAILBOX_PAGE_ITEMS as u64).collect::<Vec<_>>()
    );
    assert!(page.next_cursor.is_some());
    assert_eq!(
        page.resume_position.after_sequence(),
        MAX_MAILBOX_PAGE_ITEMS as u64
    );
    // Alice sees only the root through the sender range.
    let page = f
        .thread(
            &f.alice.principal.clone(),
            &root.message_id,
            MailboxNavigation::ResetAfter { after_sequence: 0 },
            8,
        )
        .unwrap();
    assert_eq!(sequences(&page), vec![1]);
}

#[test]
fn sender_heavy_threads_page_with_bounded_work_for_every_reader() {
    const HISTORY: i64 = 5_000;
    let mut f = Fixture::new("thread-sender-heavy");
    let root = f
        .store
        .send_message(
            &f.alice.principal,
            send(
                &f.group.group_id,
                "root",
                &[&f.bob.record.peer_id, &f.carol.record.peer_id],
                "root",
            ),
        )
        .unwrap();
    {
        let connection = Connection::open(&f.path).unwrap();
        connection
            .pragma_update(None, "foreign_keys", true)
            .unwrap();
        let tx = connection.unchecked_transaction().unwrap();
        // Alice replies HISTORY times to carol only.
        tx.execute(
            "WITH RECURSIVE seq(n) AS (VALUES(2) UNION ALL SELECT n+1 FROM seq WHERE n<?1) INSERT INTO messages(message_id,group_id,group_sequence,sender_peer_id,sender_binding_revision,client_key,semantic_payload_json,body,reply_to_message_id,committed_at_millis,thread_root_message_id) SELECT printf('m_%032x',n),?2,n,?3,1,printf('to-carol-%d',n),'{}','x',?4,1,?4 FROM seq",
            params![HISTORY + 1, f.group.group_id.as_str(), f.alice.record.peer_id.as_str(), root.message_id.as_str()],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO recipient_deliveries(message_id,recipient_peer_id,recipient_binding_revision,saved_at_millis,delivery_generation) SELECT message_id,?1,1,1,1 FROM messages WHERE group_id=?2 AND group_sequence>1",
            params![f.carol.record.peer_id.as_str(), f.group.group_id.as_str()],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO recipient_ack_order(message_id,recipient_peer_id,group_id,group_sequence,binding_revision,generation,acknowledged) SELECT message_id,recipient_peer_id,group_id,group_sequence,1,1,0 FROM current_deliveries WHERE group_id=?1 AND group_sequence>1",
            [f.group.group_id.as_str()],
        )
        .unwrap();
        tx.execute(
            "UPDATE groups SET next_sequence=?1 WHERE group_id=?2",
            params![HISTORY + 2, f.group.group_id.as_str()],
        )
        .unwrap();
        tx.commit().unwrap();
    }
    f.store = Store::open(&f.path).unwrap();
    let high = HISTORY as u64 + 1;
    let late = f
        .store
        .send_message(
            &f.bob.principal,
            reply(
                &f.group.group_id,
                "late",
                &[&f.alice.record.peer_id],
                &root.message_id,
            ),
        )
        .unwrap();
    assert_eq!(late.group_sequence, high + 1);

    // Bob: only the root and his own late reply, without touching the
    // sender-heavy branch.
    let (page, bob_work) = counted(&mut f.store, |store| {
        store
            .read_thread(
                &f.bob.principal,
                ThreadPageRequest {
                    group_id: f.group.group_id.clone(),
                    root: root.message_id.clone(),
                    navigation: MailboxNavigation::ResetAfter { after_sequence: 1 },
                    max_items: 8,
                },
            )
            .unwrap()
    });
    assert_eq!(sequences(&page), vec![high + 1]);
    // Alice: the sender range positioned near the end.
    let (page, alice_work) = counted(&mut f.store, |store| {
        store
            .read_thread(
                &f.alice.principal,
                ThreadPageRequest {
                    group_id: f.group.group_id.clone(),
                    root: root.message_id.clone(),
                    navigation: MailboxNavigation::ResetAfter {
                        after_sequence: high - 2,
                    },
                    max_items: 8,
                },
            )
            .unwrap()
    });
    assert_eq!(sequences(&page), vec![high - 1, high, high + 1]);
    assert!(page.messages[2].receipt.is_some());
    // Alice: one-item page at the start still stops after two rows per range.
    let (page, alice_first) = counted(&mut f.store, |store| {
        store
            .read_thread(
                &f.alice.principal,
                ThreadPageRequest {
                    group_id: f.group.group_id.clone(),
                    root: root.message_id.clone(),
                    navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
                    max_items: 1,
                },
            )
            .unwrap()
    });
    assert_eq!(sequences(&page), vec![1]);
    assert!(page.next_cursor.is_some());
    // Carol: the recipient range positioned near the end.
    let (page, carol_work) = counted(&mut f.store, |store| {
        store
            .read_thread(
                &f.carol.principal,
                ThreadPageRequest {
                    group_id: f.group.group_id.clone(),
                    root: root.message_id.clone(),
                    navigation: MailboxNavigation::ResetAfter {
                        after_sequence: high - 1,
                    },
                    max_items: 8,
                },
            )
            .unwrap()
    });
    assert_eq!(sequences(&page), vec![high]);
    eprintln!(
        "sender-heavy thread of {HISTORY}: bob {bob_work}, alice late {alice_work}, alice first {alice_first}, carol {carol_work} callbacks (100-opcode interval)"
    );
    for (name, work) in [
        ("bob", bob_work),
        ("alice late", alice_work),
        ("alice first", alice_first),
        ("carol", carol_work),
    ] {
        assert!(work <= 30, "{name} scanned the branch: {work} callbacks");
    }
}
