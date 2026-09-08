mod support;

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use rusqlite::{params, Connection};
use termx_swarm_core::error::{StoreError, ValidationError};
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
                "tail",
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
    fn send_to_bob(&mut self, key: &str) -> SendReceipt {
        self.store
            .send_message(
                &self.alice.principal,
                send(&self.group.group_id, key, &[&self.bob.record.peer_id], key),
            )
            .unwrap()
    }
    fn send_to_carol(&mut self, key: &str) -> SendReceipt {
        self.store
            .send_message(
                &self.alice.principal,
                send(
                    &self.group.group_id,
                    key,
                    &[&self.carol.record.peer_id],
                    key,
                ),
            )
            .unwrap()
    }
    fn after(&mut self, after_sequence: u64, max_items: usize) -> Result<MailboxPage, StoreError> {
        self.store.read_mailbox_after(
            &self.bob.principal,
            MailboxAfterRequest {
                group_id: self.group.group_id.clone(),
                navigation: MailboxNavigation::ResetAfter { after_sequence },
                max_items,
            },
        )
    }
    fn cursor(
        &mut self,
        cursor: MailboxCursor,
        max_items: usize,
    ) -> Result<MailboxPage, StoreError> {
        self.store.read_mailbox_after(
            &self.bob.principal,
            MailboxAfterRequest {
                group_id: self.group.group_id.clone(),
                navigation: MailboxNavigation::Cursor(cursor),
                max_items,
            },
        )
    }
}

fn sequences(page: &MailboxPage) -> Vec<u64> {
    page.messages
        .iter()
        .map(|entry| entry.message.group_sequence)
        .collect()
}

#[test]
fn start_after_is_navigation_only_with_frozen_watermark_gaps_and_explicit_invalid_positions() {
    let mut f = Fixture::new("start-after");
    let empty = f.after(0, 8).unwrap();
    assert!(empty.messages.is_empty() && empty.next_cursor.is_none());
    assert_eq!(empty.snapshot_high_sequence, 0);
    assert!(matches!(
        f.after(1, 8),
        Err(StoreError::InvalidPosition {
            position: 1,
            snapshot_high: 0
        })
    ));

    f.send_to_bob("one");
    f.send_to_carol("gap-two");
    f.send_to_bob("three");
    f.send_to_bob("four");
    f.send_to_carol("gap-five");

    // A position is not an ACK and not a fetch of anything before it.
    let page = f.after(1, 1).unwrap();
    assert_eq!(sequences(&page), vec![3]);
    assert_eq!(page.snapshot_high_sequence, 5);
    let cursor = page.next_cursor.clone().expect("four remains");
    f.send_to_bob("six-after-snapshot");
    let rest = f.cursor(cursor.clone(), 8).unwrap();
    assert_eq!(sequences(&rest), vec![4]);
    assert_eq!(
        rest.snapshot_high_sequence, 5,
        "watermark frozen across cursor traversal"
    );
    assert!(rest.next_cursor.is_none());
    let retry = f.cursor(cursor, 8).unwrap();
    assert_eq!(sequences(&retry), vec![4]);

    // The mailbox message before the position was never fetched by navigation.
    let connection = Connection::open(&f.path).unwrap();
    let fetched: i64 = connection
        .query_row(
            "SELECT count(*) FROM current_deliveries WHERE recipient_peer_id=?1 AND fetched_at_millis IS NOT NULL",
            [f.bob.record.peer_id.as_str()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(fetched, 2, "only sequences 3 and 4 were served");
    let acked: i64 = connection
        .query_row(
            "SELECT count(*) FROM acknowledgements WHERE acknowledged_at_millis IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(acked, 0, "an empty or positioned page is never an ACK");
    drop(connection);

    // Gaps belonging to other recipients are not missing mail; an empty tail is valid.
    let tail = f.after(6, 8).unwrap();
    assert!(tail.messages.is_empty() && tail.next_cursor.is_none());
    assert_eq!(tail.snapshot_high_sequence, 6);
    let gap = f.after(4, 8).unwrap();
    assert_eq!(sequences(&gap), vec![6]);
    assert!(matches!(
        f.after(7, 8),
        Err(StoreError::InvalidPosition {
            position: 7,
            snapshot_high: 6
        })
    ));
    assert!(matches!(
        f.after(u64::MAX, 8),
        Err(StoreError::Validation(ValidationError::IntegerRange { .. }))
    ));
    assert!(matches!(
        f.after(i64::MAX as u64 + 1, 8),
        Err(StoreError::Validation(ValidationError::IntegerRange { .. }))
    ));
    assert!(matches!(
        f.after(0, 0),
        Err(StoreError::Validation(ValidationError::Empty { .. }))
    ));
    assert!(matches!(
        f.after(0, MAX_MAILBOX_PAGE_ITEMS + 1),
        Err(StoreError::Validation(ValidationError::TooLarge { .. }))
    ));

    // Explicit old unacknowledged history remains reachable from zero.
    let history = f.after(0, 8).unwrap();
    assert_eq!(sequences(&history), vec![1, 3, 4, 6]);
    assert!(history
        .messages
        .iter()
        .all(|e| e.receipt.acknowledged_at_millis.is_none()));

    // Existing mailbox reads and cursors keep their semantics and interoperate.
    let legacy = f
        .store
        .read_mailbox(
            &f.bob.principal,
            MailboxPageRequest {
                group_id: f.group.group_id.clone(),
                cursor: None,
                max_items: 2,
            },
        )
        .unwrap();
    assert_eq!(sequences(&legacy), vec![1, 3]);
    let legacy_cursor = legacy.next_cursor.unwrap();
    let continued = f.cursor(legacy_cursor.clone(), 8).unwrap();
    assert_eq!(sequences(&continued), vec![4, 6]);
    let continued_legacy = f
        .store
        .read_mailbox(
            &f.bob.principal,
            MailboxPageRequest {
                group_id: f.group.group_id.clone(),
                cursor: Some(legacy_cursor),
                max_items: 8,
            },
        )
        .unwrap();
    assert_eq!(sequences(&continued_legacy), vec![4, 6]);
}

#[test]
fn positioned_cursors_bind_scope_policy_and_binding_and_reset_on_continuation() {
    let mut f = Fixture::new("start-after-scope");
    f.send_to_bob("one");
    f.send_to_bob("two");
    f.send_to_bob("three");
    let page = f.after(1, 1).unwrap();
    let cursor = page.next_cursor.clone().unwrap();
    assert!(matches!(
        f.store.read_mailbox_after(
            &f.alice.principal,
            MailboxAfterRequest {
                group_id: f.group.group_id.clone(),
                navigation: MailboxNavigation::Cursor(cursor.clone()),
                max_items: 1
            }
        ),
        Err(StoreError::CursorScope)
    ));
    let other = f
        .store
        .create_group(
            &f.owner,
            "other",
            members(&[&f.alice.record.peer_id, &f.bob.record.peer_id]),
        )
        .unwrap();
    assert!(matches!(
        f.store.read_mailbox_after(
            &f.bob.principal,
            MailboxAfterRequest {
                group_id: other.group_id.clone(),
                navigation: MailboxNavigation::Cursor(cursor.clone()),
                max_items: 1
            }
        ),
        Err(StoreError::CursorScope)
    ));
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
    assert!(matches!(f.cursor(cursor, 1), Err(StoreError::StaleCursor)));
    let page = f.after(1, 1).unwrap();
    let cursor = page.next_cursor.unwrap();

    // Continuation transfers the unfetched backlog; the predecessor's position
    // and cursor do not carry over and cannot skip transferred lower sequences.
    let bob2 = f
        .store
        .continue_peer(
            &f.owner,
            VerifiedContinuation::trusted(
                &f.bob.record,
                VerifiedBinding::trusted(
                    LaunchId::generate().as_str().into(),
                    "terminal-bob-2".into(),
                    "codex".into(),
                    f.bob.record.conversation_id.clone(),
                    None,
                    101,
                    10_001,
                    true,
                )
                .unwrap(),
                "same-branch".into(),
            )
            .unwrap(),
            "continue",
            [
                (f.group.group_id.clone(), group.policy_revision),
                (other.group_id.clone(), other.policy_revision),
            ]
            .into(),
        )
        .unwrap();
    assert!(matches!(
        f.store.read_mailbox_after(
            &f.bob.principal,
            MailboxAfterRequest {
                group_id: f.group.group_id.clone(),
                navigation: MailboxNavigation::Cursor(cursor.clone()),
                max_items: 1
            }
        ),
        Err(StoreError::StaleBinding)
    ));
    assert!(matches!(
        f.store.read_mailbox_after(
            &bob2.principal,
            MailboxAfterRequest {
                group_id: f.group.group_id.clone(),
                navigation: MailboxNavigation::Cursor(cursor),
                max_items: 1
            }
        ),
        Err(StoreError::StaleCursor)
    ));
    let fresh = f
        .store
        .read_mailbox_after(
            &bob2.principal,
            MailboxAfterRequest {
                group_id: f.group.group_id.clone(),
                navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
                max_items: 8,
            },
        )
        .unwrap();
    assert_eq!(
        sequences(&fresh),
        vec![1, 3],
        "the unfetched backlog, including the sequence skipped by position, moved to the successor binding; the fetched one did not"
    );
}

#[test]
fn navigation_beyond_2_pow_53_uses_exact_integers_and_bounded_indexed_work() {
    let mut f = Fixture::new("start-after-2p53");
    const HIGH: u64 = (1_u64 << 53) + 1;
    let connection = Connection::open(&f.path).unwrap();
    connection
        .pragma_update(None, "foreign_keys", true)
        .unwrap();
    connection
        .execute(
            "UPDATE groups SET next_sequence=?1 WHERE group_id=?2",
            params![HIGH as i64, f.group.group_id.as_str()],
        )
        .unwrap();
    drop(connection);
    let above = f.send_to_bob("above-2p53");
    assert_eq!(above.group_sequence, HIGH);
    let next = f.send_to_bob("above-2p53-next");
    assert_eq!(next.group_sequence, HIGH + 1);
    let page = f.after(HIGH - 1, 8).unwrap();
    assert_eq!(sequences(&page), vec![HIGH, HIGH + 1]);
    assert_eq!(page.snapshot_high_sequence, HIGH + 1);
    let page = f.after(HIGH, 8).unwrap();
    assert_eq!(sequences(&page), vec![HIGH + 1]);
    let empty = f.after(HIGH + 1, 8).unwrap();
    assert!(empty.messages.is_empty());
    assert!(matches!(
        f.after(HIGH + 2, 8),
        Err(StoreError::InvalidPosition {
            position,
            snapshot_high
        }) if position == HIGH + 2 && snapshot_high == HIGH + 1
    ));
    let json = serde_json::to_value(f.after(HIGH - 1, 8).unwrap()).unwrap();
    assert_eq!(json["snapshot_high_sequence"], serde_json::json!(HIGH + 1));
    assert_eq!(
        json["messages"][0]["message"]["group_sequence"],
        serde_json::json!(HIGH)
    );
}

#[test]
fn empty_tail_after_large_visible_prefix_performs_bounded_vm_work() {
    let mut f = Fixture::new("start-after-vm-bound");
    const PREFIX: i64 = 5_000;
    let connection = Connection::open(&f.path).unwrap();
    connection
        .pragma_update(None, "foreign_keys", true)
        .unwrap();
    let tx = connection.unchecked_transaction().unwrap();
    // 5000 visible messages to bob interleaved with 5000 to carol.
    tx.execute(
        "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<?1) INSERT INTO messages(message_id,group_id,group_sequence,sender_peer_id,sender_binding_revision,client_key,semantic_payload_json,body,committed_at_millis) SELECT printf('m_%032x',n),?2,n,?3,1,printf('k-%d',n),'{}','x',1 FROM seq",
        params![PREFIX * 2, f.group.group_id.as_str(), f.alice.record.peer_id.as_str()],
    )
    .unwrap();
    tx.execute(
        "INSERT INTO recipient_deliveries(message_id,recipient_peer_id,recipient_binding_revision,saved_at_millis,delivery_generation) SELECT message_id,CASE WHEN group_sequence%2=1 THEN ?1 ELSE ?2 END,1,1,1 FROM messages WHERE group_id=?3",
        params![f.bob.record.peer_id.as_str(), f.carol.record.peer_id.as_str(), f.group.group_id.as_str()],
    )
    .unwrap();
    tx.execute(
        "INSERT INTO recipient_ack_order(message_id,recipient_peer_id,group_id,group_sequence,binding_revision,generation,acknowledged) SELECT message_id,recipient_peer_id,group_id,group_sequence,1,1,0 FROM current_deliveries WHERE group_id=?1",
        [f.group.group_id.as_str()],
    )
    .unwrap();
    tx.execute(
        "UPDATE groups SET next_sequence=?1 WHERE group_id=?2",
        params![PREFIX * 2 + 1, f.group.group_id.as_str()],
    )
    .unwrap();
    tx.commit().unwrap();
    drop(connection);
    // Reopen so the measured connection is the store's own.
    f.store = Store::open(&f.path).unwrap();

    let callbacks = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&callbacks);
    f.store
        .progress_handler(
            100,
            Some(Box::new(move || {
                counter.fetch_add(1, Ordering::Relaxed);
                false
            })),
        )
        .unwrap();
    let tail = f.after(PREFIX as u64 * 2, 128).unwrap();
    let after_empty = callbacks.swap(0, Ordering::Relaxed);
    let late = f.after(PREFIX as u64 * 2 - 3, 128).unwrap();
    let after_late = callbacks.swap(0, Ordering::Relaxed);
    f.store.progress_handler(0, None).unwrap();
    assert!(tail.messages.is_empty() && tail.next_cursor.is_none());
    assert_eq!(tail.snapshot_high_sequence, PREFIX as u64 * 2);
    assert_eq!(sequences(&late), vec![PREFIX as u64 * 2 - 1]);
    eprintln!(
        "empty tail after {PREFIX} visible + {PREFIX} other messages: {after_empty} callbacks; late page: {after_late} callbacks (100-opcode interval)"
    );
    assert!(
        after_empty <= 12,
        "empty tail examined retained prefix: {after_empty} callbacks"
    );
    assert!(
        after_late <= 20,
        "late positioned page examined retained prefix: {after_late} callbacks"
    );
}

#[test]
fn thread_and_outgoing_reads_authorize_per_message_and_never_leak_private_replies() {
    let mut f = Fixture::new("thread-outgoing");
    let root = f
        .store
        .send_message(
            &f.alice.principal,
            SendMessageRequest {
                topic: Some("shared topic".into()),
                ..send(
                    &f.group.group_id,
                    "root",
                    &[&f.bob.record.peer_id, &f.carol.record.peer_id],
                    "root",
                )
            },
        )
        .unwrap();
    let mut private = send(
        &f.group.group_id,
        "private",
        &[&f.alice.record.peer_id],
        "for alice only",
    );
    private.reply_to = Some(root.message_id.clone());
    private.topic = Some("shared topic".into());
    let private = f.store.send_message(&f.bob.principal, private).unwrap();
    let mut nested = send(
        &f.group.group_id,
        "nested",
        &[&f.bob.record.peer_id],
        "alice replies to bob",
    );
    nested.reply_to = Some(private.message_id.clone());
    let nested = f.store.send_message(&f.alice.principal, nested).unwrap();
    let mut public = send(
        &f.group.group_id,
        "public",
        &[&f.bob.record.peer_id, &f.carol.record.peer_id],
        "everyone",
    );
    public.reply_to = Some(root.message_id.clone());
    let public = f.store.send_message(&f.alice.principal, public).unwrap();
    let unrelated = f.send_to_carol("unrelated");

    // Carol can see the root and the public reply, but not the private branch,
    // through the root, the descendant IDs, outgoing navigation or paging.
    let mut seen = Vec::new();
    let mut navigation = MailboxNavigation::ResetAfter { after_sequence: 0 };
    loop {
        let page = f
            .store
            .read_thread(
                &f.carol.principal,
                ThreadPageRequest {
                    group_id: f.group.group_id.clone(),
                    root: root.message_id.clone(),
                    navigation: navigation.clone(),
                    max_items: 1,
                },
            )
            .unwrap();
        assert_eq!(page.root, root.message_id);
        assert_eq!(page.snapshot_high_sequence, unrelated.group_sequence);
        seen.extend(page.messages);
        match page.next_cursor {
            Some(cursor) => navigation = MailboxNavigation::Cursor(cursor),
            None => break,
        }
    }
    assert_eq!(
        seen.iter()
            .map(|e| e.message.message_id.clone())
            .collect::<Vec<_>>(),
        vec![root.message_id.clone(), public.message_id.clone()]
    );
    assert!(seen.iter().all(|e| e
        .receipt
        .as_ref()
        .is_some_and(|r| r.fetched_at_millis.is_some())));
    for entry in &seen {
        assert!(!entry.message.body.contains("alice only"));
    }
    assert!(matches!(
        f.store.read_thread(
            &f.carol.principal,
            ThreadPageRequest {
                group_id: f.group.group_id.clone(),
                root: private.message_id.clone(),
                navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
                max_items: 8,
            },
        ),
        Err(StoreError::NotFound { .. })
    ));
    let carol_outgoing = f
        .store
        .read_outgoing(
            &f.carol.principal,
            OutgoingPageRequest {
                group_id: f.group.group_id.clone(),
                navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
                max_items: 8,
            },
        )
        .unwrap();
    assert!(carol_outgoing.messages.is_empty());

    // Bob (sender of the private reply) sees the whole branch he participates in.
    let bob_thread = f
        .store
        .read_thread(
            &f.bob.principal,
            ThreadPageRequest {
                group_id: f.group.group_id.clone(),
                root: root.message_id.clone(),
                navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
                max_items: 8,
            },
        )
        .unwrap();
    assert_eq!(
        bob_thread
            .messages
            .iter()
            .map(|e| e.message.message_id.clone())
            .collect::<Vec<_>>(),
        vec![
            root.message_id.clone(),
            private.message_id.clone(),
            nested.message_id.clone(),
            public.message_id.clone()
        ]
    );
    let sent = bob_thread
        .messages
        .iter()
        .find(|e| e.message.message_id == private.message_id)
        .unwrap();
    assert!(
        sent.receipt.is_none(),
        "own sent message carries no recipient receipt"
    );
    let bob_outgoing = f
        .store
        .read_outgoing(
            &f.bob.principal,
            OutgoingPageRequest {
                group_id: f.group.group_id.clone(),
                navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
                max_items: 8,
            },
        )
        .unwrap();
    assert_eq!(bob_outgoing.messages.len(), 1);
    assert_eq!(
        bob_outgoing.messages[0].message.message_id,
        private.message_id
    );
    assert_eq!(bob_outgoing.messages[0].recipients.len(), 1);
    let state = &bob_outgoing.messages[0].recipients[0];
    assert_eq!(state.peer_id, f.alice.record.peer_id);
    assert!(state.fetched_at_millis.is_none());
    assert_eq!(state.replied_by.as_ref(), Some(&nested.message_id));

    // Thread cursors are bound to their read kind and selector.
    let page = f
        .store
        .read_thread(
            &f.bob.principal,
            ThreadPageRequest {
                group_id: f.group.group_id.clone(),
                root: root.message_id.clone(),
                navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
                max_items: 1,
            },
        )
        .unwrap();
    let thread_cursor = page.next_cursor.unwrap();
    assert!(matches!(
        f.store.read_mailbox(
            &f.bob.principal,
            MailboxPageRequest {
                group_id: f.group.group_id.clone(),
                cursor: Some(thread_cursor.clone()),
                max_items: 1
            }
        ),
        Err(StoreError::CursorScope)
    ));
    assert!(matches!(
        f.store.read_outgoing(
            &f.bob.principal,
            OutgoingPageRequest {
                group_id: f.group.group_id.clone(),
                navigation: MailboxNavigation::Cursor(thread_cursor.clone()),
                max_items: 1
            }
        ),
        Err(StoreError::CursorScope)
    ));
    assert!(matches!(
        f.store.read_thread(
            &f.bob.principal,
            ThreadPageRequest {
                group_id: f.group.group_id.clone(),
                root: public.message_id.clone(),
                navigation: MailboxNavigation::Cursor(thread_cursor.clone()),
                max_items: 1
            }
        ),
        Err(StoreError::CursorScope)
    ));
    let mailbox_cursor = f
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
    assert!(matches!(
        f.store.read_thread(
            &f.bob.principal,
            ThreadPageRequest {
                group_id: f.group.group_id.clone(),
                root: root.message_id.clone(),
                navigation: MailboxNavigation::Cursor(mailbox_cursor),
                max_items: 1
            }
        ),
        Err(StoreError::CursorScope)
    ));
    let continued = f
        .store
        .read_thread(
            &f.bob.principal,
            ThreadPageRequest {
                group_id: f.group.group_id.clone(),
                root: root.message_id.clone(),
                navigation: MailboxNavigation::Cursor(thread_cursor),
                max_items: 8,
            },
        )
        .unwrap();
    assert_eq!(continued.messages.len(), 3);

    // Unknown root and cross-group root are not disclosed.
    let other = f
        .store
        .create_group(
            &f.owner,
            "other",
            members(&[&f.alice.record.peer_id, &f.carol.record.peer_id]),
        )
        .unwrap();
    assert!(matches!(
        f.store.read_thread(
            &f.carol.principal,
            ThreadPageRequest {
                group_id: other.group_id.clone(),
                root: root.message_id.clone(),
                navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
                max_items: 8
            }
        ),
        Err(StoreError::NotFound { .. })
    ));
    // Thread pages use bounded indexed ranges after long unrelated history.
    let connection = Connection::open(&f.path).unwrap();
    let plan: Vec<String> = connection
        .prepare("EXPLAIN QUERY PLAN SELECT message_id FROM messages INDEXED BY messages_by_thread WHERE group_id=?1 AND thread_root_message_id=?2 AND group_sequence>?3 AND group_sequence<=?4 ORDER BY group_sequence")
        .unwrap()
        .query_map(params![f.group.group_id.as_str(), root.message_id.as_str(), 0, 100], |r| r.get(3))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(
        plan.iter().any(|d| d.contains("messages_by_thread")),
        "{plan:?}"
    );
    assert!(plan.iter().all(|d| !d.contains("TEMP B-TREE")), "{plan:?}");
}
