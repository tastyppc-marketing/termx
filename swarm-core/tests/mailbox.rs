mod support;

use std::collections::BTreeSet;
use std::sync::{Arc, Barrier};

use rusqlite::Connection;
use termx_swarm_core::error::StoreError;
use termx_swarm_core::model::{
    GroupId, MailboxPageRequest, MessageCommitOutcome, PeerId, PeerMetadataUpdate, Revision,
    SendMessageRequest, VerifiedBinding,
};
use termx_swarm_core::store::Store;

fn binding(name: &str, live: bool) -> VerifiedBinding {
    VerifiedBinding::trusted(
        format!(
            "l_{:032x}",
            name.bytes().fold(0_u128, |n, b| n * 257 + u128::from(b))
        ),
        format!("terminal-{name}"),
        "codex".to_owned(),
        format!("conversation-{name}"),
        Some(format!(r#"{{"model":"{name}"}}"#)),
        100,
        10_000,
        live,
    )
    .expect("valid trusted binding")
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

#[test]
fn owner_enrollment_and_policy_mutations_use_authority_and_expected_revision() {
    let path = support::retained_db("owner-policy");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let alice = store.enroll_peer(&owner, binding("alice", true)).unwrap();
    let bob = store.enroll_peer(&owner, binding("bob", false)).unwrap();

    let updated = store
        .update_peer_metadata(
            &owner,
            &alice.record.peer_id,
            Revision::new(1).unwrap(),
            PeerMetadataUpdate {
                model_metadata: Some(r#"{"model":"new"}"#.to_owned()),
                is_live: true,
            },
        )
        .unwrap();
    assert_eq!(updated.launch_id, alice.record.launch_id);
    assert_eq!(updated.conversation_id, alice.record.conversation_id);
    assert_eq!(updated.revision, Revision::new(1).unwrap());
    assert_eq!(
        store
            .authenticate_peer(&binding("alice", true))
            .unwrap()
            .binding_revision(),
        Revision::new(1).unwrap()
    );

    let group = store
        .create_group(&owner, "pair", members(&[&alice.record.peer_id]))
        .unwrap();
    let group = store
        .set_membership(
            &owner,
            &group.group_id,
            &bob.record.peer_id,
            true,
            group.policy_revision,
        )
        .unwrap();
    assert_eq!(group.policy_revision, Revision::new(2).unwrap());
    assert!(matches!(
        store.set_group_paused(&owner, &group.group_id, true, Revision::new(1).unwrap()),
        Err(StoreError::StalePolicy { .. })
    ));

    let other_path = support::retained_db("other-authority");
    let mut other_store = Store::open(&other_path).unwrap();
    let other_owner = other_store.trusted_owner();
    let alien = other_store
        .enroll_peer(&other_owner, binding("alien", true))
        .unwrap();
    assert!(matches!(
        store.create_group(&other_owner, "forged", BTreeSet::new()),
        Err(StoreError::AuthorityMismatch)
    ));
    assert!(matches!(
        store.send_message(
            &alien.principal,
            send(&group.group_id, "alien", &[&bob.record.peer_id], "forged")
        ),
        Err(StoreError::AuthorityMismatch)
    ));
}

#[test]
fn send_is_atomic_idempotent_and_freezes_offline_recipients() {
    let path = support::retained_db("send-idempotent");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let alice = store.enroll_peer(&owner, binding("alice2", true)).unwrap();
    let bob = store.enroll_peer(&owner, binding("bob2", false)).unwrap();
    let carol = store.enroll_peer(&owner, binding("carol2", true)).unwrap();
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

    let first = store
        .send_message(
            &alice.principal,
            send(
                &group.group_id,
                "same",
                &[&bob.record.peer_id, &carol.record.peer_id],
                "quote: \"x\"\n\0",
            ),
        )
        .unwrap();
    let retry = store
        .send_message(
            &alice.principal,
            send(
                &group.group_id,
                "same",
                &[&carol.record.peer_id, &bob.record.peer_id],
                "quote: \"x\"\n\0",
            ),
        )
        .unwrap();
    assert_eq!(retry, first);
    assert_eq!(first.group_sequence, 1);
    assert_eq!(first.outcome, MessageCommitOutcome::Saved);
    assert_eq!(first.recipients.len(), 2);
    let frozen_bob = first
        .recipients
        .iter()
        .find(|recipient| recipient.peer_id == bob.record.peer_id)
        .unwrap();
    assert_eq!(frozen_bob.binding_revision, Revision::new(1).unwrap());
    assert_eq!(frozen_bob.generation, Revision::new(1).unwrap());

    let mut changed = send(&group.group_id, "same", &[&bob.record.peer_id], "changed");
    changed.topic = Some("different semantics".to_owned());
    assert!(matches!(
        store.send_message(&alice.principal, changed),
        Err(StoreError::IdempotencyConflict)
    ));

    let outsider = store
        .enroll_peer(&owner, binding("outsider2", true))
        .unwrap();
    assert!(matches!(
        store.send_message(
            &alice.principal,
            send(
                &group.group_id,
                "atomic-failure",
                &[&bob.record.peer_id, &outsider.record.peer_id],
                "must roll back"
            )
        ),
        Err(StoreError::Unauthorized { .. })
    ));
    let next = store
        .send_message(
            &alice.principal,
            send(
                &group.group_id,
                "next",
                &[&bob.record.peer_id],
                "sequence two",
            ),
        )
        .unwrap();
    assert_eq!(next.group_sequence, 2);

    drop(store);
    let mut reopened = Store::open(&path).unwrap();
    let rebound = reopened
        .authenticate_peer(&binding("alice2", true))
        .unwrap();
    assert_eq!(
        reopened
            .send_message(
                &rebound,
                send(
                    &group.group_id,
                    "same",
                    &[&bob.record.peer_id, &carol.record.peer_id],
                    "quote: \"x\"\n\0"
                )
            )
            .unwrap(),
        first
    );
    let reopened_owner = reopened.trusted_owner();
    reopened
        .set_membership(
            &reopened_owner,
            &group.group_id,
            &bob.record.peer_id,
            false,
            group.policy_revision,
        )
        .unwrap();
    assert!(matches!(
        reopened.send_message(
            &rebound,
            send(
                &group.group_id,
                "same",
                &[&bob.record.peer_id, &carol.record.peer_id],
                "quote: \"x\"\n\0"
            )
        ),
        Err(StoreError::Unauthorized { .. })
    ));
}

#[test]
fn retries_are_serialized_across_connections() {
    let path = support::retained_db("concurrent-retry");
    let mut setup = Store::open(&path).unwrap();
    let owner = setup.trusted_owner();
    let alice_binding = binding("race-alice", true);
    let alice = setup.enroll_peer(&owner, alice_binding.clone()).unwrap();
    let bob = setup
        .enroll_peer(&owner, binding("race-bob", true))
        .unwrap();
    let group = setup
        .create_group(
            &owner,
            "race",
            members(&[&alice.record.peer_id, &bob.record.peer_id]),
        )
        .unwrap();
    drop(setup);

    let barrier = Arc::new(Barrier::new(3));
    let mut handles = Vec::new();
    for _ in 0..2 {
        let path = path.clone();
        let barrier = barrier.clone();
        let request = send(&group.group_id, "race-key", &[&bob.record.peer_id], "once");
        let alice_binding = alice_binding.clone();
        handles.push(std::thread::spawn(move || {
            let mut store = Store::open(path).unwrap();
            let principal = store.authenticate_peer(&alice_binding).unwrap();
            barrier.wait();
            store.send_message(&principal, request).unwrap()
        }));
    }
    barrier.wait();
    let left = handles.remove(0).join().unwrap();
    let right = handles.remove(0).join().unwrap();
    assert_eq!(left, right);
    let connection = Connection::open(path).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM messages WHERE group_id=?1 AND client_key='race-key'",
                [group.group_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );
}

#[test]
fn group_authorization_pause_removal_and_reply_access_are_transactional() {
    let path = support::retained_db("authorization");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let alice = store
        .enroll_peer(&owner, binding("auth-alice", true))
        .unwrap();
    let bob = store
        .enroll_peer(&owner, binding("auth-bob", true))
        .unwrap();
    let carol = store
        .enroll_peer(&owner, binding("auth-carol", true))
        .unwrap();
    let dave = store
        .enroll_peer(&owner, binding("auth-dave", true))
        .unwrap();
    let group_one = store
        .create_group(
            &owner,
            "one",
            members(&[
                &alice.record.peer_id,
                &bob.record.peer_id,
                &dave.record.peer_id,
            ]),
        )
        .unwrap();
    let group_two = store
        .create_group(
            &owner,
            "two",
            members(&[&alice.record.peer_id, &carol.record.peer_id]),
        )
        .unwrap();
    assert!(matches!(
        store.send_message(
            &alice.principal,
            send(&group_one.group_id, "cross", &[&carol.record.peer_id], "no")
        ),
        Err(StoreError::Unauthorized { .. })
    ));

    let original = store
        .send_message(
            &alice.principal,
            send(
                &group_one.group_id,
                "original",
                &[&bob.record.peer_id, &dave.record.peer_id],
                "hello",
            ),
        )
        .unwrap();
    let mut accessible_reply = send(
        &group_one.group_id,
        "valid-reply",
        &[&alice.record.peer_id],
        "received",
    );
    accessible_reply.reply_to = Some(original.message_id.clone());
    let reply = store
        .send_message(&bob.principal, accessible_reply)
        .unwrap();
    assert_eq!(reply.sender_peer_id, bob.record.peer_id);
    let connection = Connection::open(&path).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM recipient_deliveries WHERE message_id=?1 AND replied_by_message_id=?2",
                [original.message_id.as_str(), reply.message_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT recipient_peer_id FROM recipient_deliveries WHERE message_id=?1 AND replied_by_message_id=?2",
                [original.message_id.as_str(), reply.message_id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        bob.record.peer_id.as_str()
    );
    drop(connection);
    let mut inaccessible_reply = send(
        &group_two.group_id,
        "bad-reply",
        &[&carol.record.peer_id],
        "reply",
    );
    inaccessible_reply.reply_to = Some(original.message_id.clone());
    assert!(matches!(
        store.send_message(&alice.principal, inaccessible_reply),
        Err(StoreError::InvalidReply)
    ));

    let paused = store
        .set_group_paused(&owner, &group_one.group_id, true, group_one.policy_revision)
        .unwrap();
    assert!(matches!(
        store.send_message(
            &alice.principal,
            send(&group_one.group_id, "paused", &[&bob.record.peer_id], "no")
        ),
        Err(StoreError::GroupPaused)
    ));
    let active = store
        .set_group_paused(&owner, &group_one.group_id, false, paused.policy_revision)
        .unwrap();
    store
        .set_membership(
            &owner,
            &group_one.group_id,
            &alice.record.peer_id,
            false,
            active.policy_revision,
        )
        .unwrap();
    assert!(matches!(
        store.send_message(
            &alice.principal,
            send(&group_one.group_id, "removed", &[&bob.record.peer_id], "no")
        ),
        Err(StoreError::Unauthorized { .. })
    ));
}

#[test]
fn snapshot_pages_are_bounded_frozen_and_reads_only_record_fetched() {
    let path = support::retained_db("snapshot");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let alice = store
        .enroll_peer(&owner, binding("page-alice", true))
        .unwrap();
    let bob_binding = binding("page-bob", true);
    let bob = store.enroll_peer(&owner, bob_binding.clone()).unwrap();
    let carol = store
        .enroll_peer(&owner, binding("page-carol", true))
        .unwrap();
    let group = store
        .create_group(
            &owner,
            "page",
            members(&[
                &alice.record.peer_id,
                &bob.record.peer_id,
                &carol.record.peer_id,
            ]),
        )
        .unwrap();
    store
        .send_message(
            &alice.principal,
            send(&group.group_id, "one", &[&bob.record.peer_id], "one"),
        )
        .unwrap();
    store
        .send_message(
            &alice.principal,
            send(&group.group_id, "gap", &[&carol.record.peer_id], "other"),
        )
        .unwrap();
    store
        .send_message(
            &alice.principal,
            send(&group.group_id, "three", &[&bob.record.peer_id], "three"),
        )
        .unwrap();

    let first = store
        .read_mailbox(
            &bob.principal,
            MailboxPageRequest {
                group_id: group.group_id.clone(),
                cursor: None,
                max_items: 1,
            },
        )
        .unwrap();
    assert_eq!(first.messages.len(), 1);
    assert_eq!(first.messages[0].message.group_sequence, 1);
    assert!(first.messages[0].receipt.fetched_at_millis.is_some());
    assert!(first.messages[0].receipt.acknowledged_at_millis.is_none());
    let cursor = first.next_cursor.clone().unwrap();

    store
        .send_message(
            &alice.principal,
            send(&group.group_id, "late", &[&bob.record.peer_id], "late"),
        )
        .unwrap();
    let second = store
        .read_mailbox(
            &bob.principal,
            MailboxPageRequest {
                group_id: group.group_id.clone(),
                cursor: Some(cursor.clone()),
                max_items: 1,
            },
        )
        .unwrap();
    assert_eq!(second.messages.len(), 1);
    assert_eq!(second.messages[0].message.group_sequence, 3);
    assert!(second.next_cursor.is_none());
    let lost_response_retry = store
        .read_mailbox(
            &bob.principal,
            MailboxPageRequest {
                group_id: group.group_id.clone(),
                cursor: Some(cursor),
                max_items: 1,
            },
        )
        .unwrap();
    assert_eq!(lost_response_retry.messages, second.messages);
    assert_eq!(
        lost_response_retry.snapshot_high_sequence,
        second.snapshot_high_sequence
    );

    let fresh = store
        .read_mailbox(
            &bob.principal,
            MailboxPageRequest {
                group_id: group.group_id.clone(),
                cursor: None,
                max_items: 10,
            },
        )
        .unwrap();
    assert_eq!(
        fresh
            .messages
            .iter()
            .map(|entry| entry.message.group_sequence)
            .collect::<Vec<_>>(),
        vec![1, 3, 4]
    );

    drop(store);
    let mut reopened = Store::open(&path).unwrap();
    let bob_principal = reopened.authenticate_peer(&bob_binding).unwrap();
    let page = reopened
        .read_mailbox(
            &bob_principal,
            MailboxPageRequest {
                group_id: group.group_id,
                cursor: None,
                max_items: 10,
            },
        )
        .unwrap();
    assert_eq!(page.messages[0].message.body, "one");
}

#[test]
fn forged_wrong_peer_and_old_policy_cursors_are_rejected() {
    let path = support::retained_db("cursor-auth");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let alice = store
        .enroll_peer(&owner, binding("cursor-alice", true))
        .unwrap();
    let bob = store
        .enroll_peer(&owner, binding("cursor-bob", true))
        .unwrap();
    let group = store
        .create_group(
            &owner,
            "cursor",
            members(&[&alice.record.peer_id, &bob.record.peer_id]),
        )
        .unwrap();
    for key in ["a", "b"] {
        store
            .send_message(
                &alice.principal,
                send(&group.group_id, key, &[&bob.record.peer_id], key),
            )
            .unwrap();
    }
    let first = store
        .read_mailbox(
            &bob.principal,
            MailboxPageRequest {
                group_id: group.group_id.clone(),
                cursor: None,
                max_items: 1,
            },
        )
        .unwrap();
    let cursor = first.next_cursor.unwrap();
    assert!(matches!(
        store.read_mailbox(
            &alice.principal,
            MailboxPageRequest {
                group_id: group.group_id.clone(),
                cursor: Some(cursor.clone()),
                max_items: 1,
            }
        ),
        Err(StoreError::CursorScope)
    ));
    assert!(matches!(
        store.read_mailbox(
            &bob.principal,
            MailboxPageRequest {
                group_id: group.group_id.clone(),
                cursor: Some(termx_swarm_core::model::MailboxCursor::generate()),
                max_items: 1,
            }
        ),
        Err(StoreError::InvalidCursor)
    ));
    let carol = store
        .enroll_peer(&owner, binding("cursor-carol", true))
        .unwrap();
    store
        .set_membership(
            &owner,
            &group.group_id,
            &carol.record.peer_id,
            true,
            group.policy_revision,
        )
        .unwrap();
    assert!(matches!(
        store.read_mailbox(
            &bob.principal,
            MailboxPageRequest {
                group_id: group.group_id,
                cursor: Some(cursor),
                max_items: 1,
            }
        ),
        Err(StoreError::StaleCursor)
    ));
}

#[test]
fn expired_cursor_is_distinct_from_forgery_and_empty_inbox_is_complete() {
    let path = support::retained_db("cursor-expiry");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let alice = store
        .enroll_peer(&owner, binding("expiry-alice", true))
        .unwrap();
    let bob_binding = binding("expiry-bob", true);
    let bob = store.enroll_peer(&owner, bob_binding.clone()).unwrap();
    let group = store
        .create_group(
            &owner,
            "expiry",
            members(&[&alice.record.peer_id, &bob.record.peer_id]),
        )
        .unwrap();
    let empty = store
        .read_mailbox(
            &bob.principal,
            MailboxPageRequest {
                group_id: group.group_id.clone(),
                cursor: None,
                max_items: 1,
            },
        )
        .unwrap();
    assert!(empty.messages.is_empty());
    assert!(empty.next_cursor.is_none());
    for key in ["one", "two"] {
        store
            .send_message(
                &alice.principal,
                send(&group.group_id, key, &[&bob.record.peer_id], key),
            )
            .unwrap();
    }
    let cursor = store
        .read_mailbox(
            &bob.principal,
            MailboxPageRequest {
                group_id: group.group_id.clone(),
                cursor: None,
                max_items: 1,
            },
        )
        .unwrap()
        .next_cursor
        .unwrap();
    drop(store);
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE mailbox_cursors SET expires_at_millis=created_at_millis WHERE cursor_id=?1",
            [cursor.as_str()],
        )
        .unwrap();
    drop(connection);
    std::thread::sleep(std::time::Duration::from_millis(2));
    let mut reopened = Store::open(&path).unwrap();
    let principal = reopened.authenticate_peer(&bob_binding).unwrap();
    assert!(matches!(
        reopened.read_mailbox(
            &principal,
            MailboxPageRequest {
                group_id: group.group_id,
                cursor: Some(cursor),
                max_items: 1,
            }
        ),
        Err(StoreError::ExpiredCursor)
    ));
}

#[test]
fn maximum_body_is_retrievable_without_truncation() {
    let path = support::retained_db("large-page");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let alice = store
        .enroll_peer(&owner, binding("large-alice", true))
        .unwrap();
    let bob = store
        .enroll_peer(&owner, binding("large-bob", true))
        .unwrap();
    let group = store
        .create_group(
            &owner,
            "large",
            members(&[&alice.record.peer_id, &bob.record.peer_id]),
        )
        .unwrap();
    let body = "\0".repeat(termx_swarm_core::model::MAX_MESSAGE_BODY_BYTES);
    store
        .send_message(
            &alice.principal,
            send(&group.group_id, "large", &[&bob.record.peer_id], &body),
        )
        .unwrap();
    let second_body = "\u{0001}".repeat(termx_swarm_core::model::MAX_MESSAGE_BODY_BYTES);
    store
        .send_message(
            &alice.principal,
            send(
                &group.group_id,
                "large-2",
                &[&bob.record.peer_id],
                &second_body,
            ),
        )
        .unwrap();
    let page = store
        .read_mailbox(
            &bob.principal,
            MailboxPageRequest {
                group_id: group.group_id.clone(),
                cursor: None,
                max_items: 10,
            },
        )
        .unwrap();
    assert_eq!(page.messages.len(), 1);
    assert_eq!(page.messages[0].message.body.as_bytes(), body.as_bytes());
    assert!(
        serde_json::to_vec(&page).unwrap().len() <= termx_swarm_core::model::MAX_MAILBOX_PAGE_BYTES
    );
    let second_page = store
        .read_mailbox(
            &bob.principal,
            MailboxPageRequest {
                group_id: group.group_id,
                cursor: page.next_cursor,
                max_items: 10,
            },
        )
        .unwrap();
    assert_eq!(second_page.messages.len(), 1);
    assert_eq!(
        second_page.messages[0].message.body.as_bytes(),
        second_body.as_bytes()
    );
    assert!(second_page.next_cursor.is_none());
}

#[test]
fn acknowledgements_are_explicit_recipient_specific_and_out_of_order_safe() {
    let path = support::retained_db("ack");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let alice = store
        .enroll_peer(&owner, binding("ack-alice", true))
        .unwrap();
    let bob = store.enroll_peer(&owner, binding("ack-bob", true)).unwrap();
    let carol = store
        .enroll_peer(&owner, binding("ack-carol", true))
        .unwrap();
    let group = store
        .create_group(
            &owner,
            "ack",
            members(&[
                &alice.record.peer_id,
                &bob.record.peer_id,
                &carol.record.peer_id,
            ]),
        )
        .unwrap();
    let one = store
        .send_message(
            &alice.principal,
            send(&group.group_id, "one", &[&bob.record.peer_id], "one"),
        )
        .unwrap();
    store
        .send_message(
            &alice.principal,
            send(&group.group_id, "gap", &[&carol.record.peer_id], "gap"),
        )
        .unwrap();
    assert!(matches!(
        store.send_message(
            &alice.principal,
            send(
                &group.group_id,
                "self-recipient",
                &[&alice.record.peer_id, &bob.record.peer_id],
                "must reject atomically",
            )
        ),
        Err(StoreError::Unauthorized { .. })
    ));
    let three = store
        .send_message(
            &alice.principal,
            send(&group.group_id, "three", &[&bob.record.peer_id], "three"),
        )
        .unwrap();
    assert_eq!(three.group_sequence, 3);

    let later = store
        .acknowledge_message(&bob.principal, &group.group_id, &three.message_id)
        .unwrap();
    assert_eq!(later.contiguous_group_sequence, 0);
    assert!(matches!(
        store.acknowledge_message(&carol.principal, &group.group_id, &three.message_id),
        Err(StoreError::Unauthorized { .. })
    ));
    assert!(matches!(
        store.acknowledge_message(&alice.principal, &group.group_id, &three.message_id),
        Err(StoreError::Unauthorized { .. })
    ));
    let earlier = store
        .acknowledge_message(&bob.principal, &group.group_id, &one.message_id)
        .unwrap();
    assert_eq!(earlier.contiguous_group_sequence, 3);
    assert_eq!(earlier.generation, Revision::new(1).unwrap());

    let four = store
        .send_message(
            &bob.principal,
            send(&group.group_id, "four", &[&alice.record.peer_id], "four"),
        )
        .unwrap();
    assert_eq!(four.group_sequence, 4);
    let alice_ack = store
        .acknowledge_message(&alice.principal, &group.group_id, &four.message_id)
        .unwrap();
    assert_eq!(alice_ack.contiguous_group_sequence, 4);
}

#[test]
fn stale_and_offline_senders_are_denied_while_offline_recipients_remain_pending() {
    let path = support::retained_db("binding-auth");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let alice = store
        .enroll_peer(&owner, binding("bind-alice", true))
        .unwrap();
    let bob = store
        .enroll_peer(&owner, binding("bind-bob", false))
        .unwrap();
    let group = store
        .create_group(
            &owner,
            "binding",
            members(&[&alice.record.peer_id, &bob.record.peer_id]),
        )
        .unwrap();
    store
        .send_message(
            &alice.principal,
            send(&group.group_id, "pending", &[&bob.record.peer_id], "wait"),
        )
        .unwrap();
    store
        .update_peer_metadata(
            &owner,
            &alice.record.peer_id,
            alice.record.revision,
            PeerMetadataUpdate {
                model_metadata: None,
                is_live: false,
            },
        )
        .unwrap();
    assert!(matches!(
        store.send_message(
            &alice.principal,
            send(&group.group_id, "offline", &[&bob.record.peer_id], "no")
        ),
        Err(StoreError::BindingOffline)
    ));

    drop(store);
    let connection = Connection::open(&path).unwrap();
    connection
        .pragma_update(None, "foreign_keys", true)
        .unwrap();
    connection
        .execute(
            "INSERT INTO peer_bindings(peer_id,binding_revision,launch_id,terminal_id,harness,conversation_id,process_id,process_creation_filetime,live,bound_at_millis) VALUES (?1,2,'l_ffffffffffffffffffffffffffffffff','new-terminal','codex','new-conversation',1,2,1,2)",
            [alice.record.peer_id.as_str()],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE peers SET current_binding_revision=2 WHERE peer_id=?1",
            [alice.record.peer_id.as_str()],
        )
        .unwrap();
    drop(connection);
    let mut reopened = Store::open(&path).unwrap();
    assert!(matches!(
        reopened.send_message(
            &alice.principal,
            send(&group.group_id, "stale", &[&bob.record.peer_id], "no")
        ),
        Err(StoreError::StaleBinding)
    ));
}
