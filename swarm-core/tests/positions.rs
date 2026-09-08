//! I3 and I4: navigation positions are scoped to the exact reader, binding,
//! policy and read kind; every page returns a store-built resume position;
//! reset is explicit; and the mailbox envelope is sized with the maximal
//! position width plus a continuation cursor.
mod support;

use std::collections::BTreeSet;

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
                "positions",
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

    fn mailbox(
        &mut self,
        principal: &PeerPrincipal,
        navigation: MailboxNavigation,
        max_items: usize,
    ) -> Result<MailboxPage, StoreError> {
        self.store.read_mailbox_after(
            principal,
            MailboxAfterRequest {
                group_id: self.group.group_id.clone(),
                navigation,
                max_items,
            },
        )
    }

    fn bob_reset(&mut self, after_sequence: u64, max_items: usize) -> MailboxPage {
        let principal = self.bob.principal.clone();
        self.mailbox(
            &principal,
            MailboxNavigation::ResetAfter { after_sequence },
            max_items,
        )
        .unwrap()
    }

    fn bob_position(
        &mut self,
        position: NavigationPosition,
        max_items: usize,
    ) -> Result<MailboxPage, StoreError> {
        let principal = self.bob.principal.clone();
        self.mailbox(&principal, MailboxNavigation::Position(position), max_items)
    }
}

fn sequences(page: &MailboxPage) -> Vec<u64> {
    page.messages
        .iter()
        .map(|entry| entry.message.group_sequence)
        .collect()
}

#[test]
fn resume_positions_advance_to_the_last_included_item_or_the_frozen_high_watermark() {
    let mut f = Fixture::new("positions-advance");
    // An empty group: the resume position is the frozen high (zero).
    let empty = f.bob_reset(0, 8);
    assert!(empty.messages.is_empty() && empty.next_cursor.is_none());
    assert_eq!(empty.resume_position.after_sequence(), 0);
    assert_eq!(empty.resume_position.scope(), &NavigationScope::Mailbox);
    assert_eq!(empty.resume_position.group_id(), &f.group.group_id);
    assert_eq!(empty.resume_position.peer_id(), &f.bob.record.peer_id);
    assert_eq!(
        empty.resume_position.binding_revision(),
        f.bob.record.revision
    );
    assert_eq!(
        empty.resume_position.policy_revision(),
        f.group.policy_revision
    );

    f.send_to_bob("one");
    f.send_to_bob("two");
    f.send_to_bob("three");
    // Partial page: resume at the last included item, never the watermark.
    let partial = f.bob_reset(0, 2);
    assert_eq!(sequences(&partial), vec![1, 2]);
    assert!(partial.next_cursor.is_some());
    assert_eq!(partial.resume_position.after_sequence(), 2);
    assert_eq!(partial.snapshot_high_sequence, 3);
    // Complete page: resume at the frozen high watermark.
    let complete = f.bob_reset(0, 8);
    assert_eq!(sequences(&complete), vec![1, 2, 3]);
    assert!(complete.next_cursor.is_none());
    assert_eq!(complete.resume_position.after_sequence(), 3);
    // Empty tail after the watermark: still the watermark.
    let tail = f.bob_reset(3, 8);
    assert!(tail.messages.is_empty());
    assert_eq!(tail.resume_position.after_sequence(), 3);
    // The partial resume position continues exactly after item two, under a
    // fresh watermark, and sees later sends.
    f.send_to_bob("four");
    let continued = f.bob_position(partial.resume_position.clone(), 8).unwrap();
    assert_eq!(sequences(&continued), vec![3, 4]);
    assert_eq!(continued.snapshot_high_sequence, 4);
    assert_eq!(continued.resume_position.after_sequence(), 4);
    // A stored complete position resumes at the new tail only.
    let later = f.bob_position(complete.resume_position.clone(), 8).unwrap();
    assert_eq!(sequences(&later), vec![4]);
    // A position beyond the current watermark is an explicit error, exactly as
    // an explicit reset would be.
    let json = serde_json::to_value(&later.resume_position).unwrap();
    let mut beyond = json.clone();
    beyond["after_sequence"] = serde_json::json!(5);
    let beyond: NavigationPosition = serde_json::from_value(beyond).unwrap();
    assert!(matches!(
        f.bob_position(beyond, 8),
        Err(StoreError::InvalidPosition {
            position: 5,
            snapshot_high: 4
        })
    ));
    assert!(matches!(
        f.mailbox(
            &f.bob.principal.clone(),
            MailboxNavigation::ResetAfter { after_sequence: 5 },
            8
        ),
        Err(StoreError::InvalidPosition {
            position: 5,
            snapshot_high: 4
        })
    ));
    // Positions never fetch beyond the page and never acknowledge.
    let receipt = &later.messages[0].receipt;
    assert!(receipt.fetched_at_millis.is_some());
    assert!(receipt.acknowledged_at_millis.is_none());
}

#[test]
fn predecessor_positions_are_rejected_and_explicit_reset_exposes_transferred_backlog() {
    let mut f = Fixture::new("positions-predecessor");
    f.send_to_bob("one");
    f.send_to_bob("two");
    f.send_to_bob("three");
    // The predecessor reads past sequence 2 without fetching 1 and 2.
    let page = f.bob_reset(2, 8);
    assert_eq!(sequences(&page), vec![3]);
    let predecessor = page.resume_position.clone();
    assert_eq!(predecessor.after_sequence(), 3);
    let bob2 = f
        .store
        .continue_peer(
            &f.owner,
            rebind(&f.bob, "terminal-bob-2"),
            "continue",
            [(f.group.group_id.clone(), f.group.policy_revision)].into(),
        )
        .unwrap();
    // The predecessor's position under the successor is an explicit
    // rejection, never a silent empty page that skips the transferred rows.
    let reused = f.mailbox(
        &bob2.principal,
        MailboxNavigation::Position(predecessor.clone()),
        8,
    );
    assert!(
        matches!(reused, Err(StoreError::StalePosition)),
        "predecessor position was reused: {reused:?}"
    );
    // The predecessor principal itself is no longer current.
    assert!(matches!(
        f.mailbox(
            &f.bob.principal.clone(),
            MailboxNavigation::Position(predecessor.clone()),
            8
        ),
        Err(StoreError::StaleBinding)
    ));
    // Bare sequence reset is deliberate and exposes the transferred backlog.
    let reset = f
        .mailbox(
            &bob2.principal,
            MailboxNavigation::ResetAfter { after_sequence: 0 },
            8,
        )
        .unwrap();
    assert_eq!(sequences(&reset), vec![1, 2]);
    assert_eq!(
        reset.resume_position.binding_revision(),
        bob2.record.revision
    );
    assert_eq!(reset.resume_position.after_sequence(), 3);
    // The successor's own resume position works; the transferred rows are
    // exactly the unfetched ones (3 was fetched by the predecessor).
    f.send_to_bob("four");
    let next = f
        .mailbox(
            &bob2.principal,
            MailboxNavigation::Position(reset.resume_position.clone()),
            8,
        )
        .unwrap();
    assert_eq!(sequences(&next), vec![4]);
}

#[test]
fn positions_are_scoped_to_reader_group_read_kind_selector_binding_and_policy() {
    let mut f = Fixture::new("positions-scope");
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
    let mut reply = send(
        &f.group.group_id,
        "reply",
        &[&f.bob.record.peer_id],
        "reply",
    );
    reply.reply_to = Some(root.message_id.clone());
    f.store.send_message(&f.alice.principal, reply).unwrap();
    let mut other_root = send(
        &f.group.group_id,
        "other",
        &[&f.bob.record.peer_id],
        "other",
    );
    other_root.topic = Some("other".into());
    let other_root = f
        .store
        .send_message(&f.alice.principal, other_root)
        .unwrap();
    let other = f
        .store
        .create_group(
            &f.owner,
            "other",
            members(&[&f.alice.record.peer_id, &f.bob.record.peer_id]),
        )
        .unwrap();

    let mailbox = f.bob_reset(0, 8).resume_position;
    let thread = f
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
    assert_eq!(thread.messages.len(), 2);
    assert_eq!(
        thread.resume_position.scope(),
        &NavigationScope::Thread {
            root: root.message_id.clone()
        }
    );
    assert_eq!(thread.resume_position.after_sequence(), 3);
    let thread = thread.resume_position;
    let outgoing = f
        .store
        .read_outgoing(
            &f.alice.principal,
            OutgoingPageRequest {
                group_id: f.group.group_id.clone(),
                navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
                max_items: 8,
            },
        )
        .unwrap();
    assert_eq!(outgoing.messages.len(), 3);
    assert_eq!(outgoing.resume_position.scope(), &NavigationScope::Outgoing);
    let outgoing = outgoing.resume_position;

    // Another reader.
    assert!(matches!(
        f.mailbox(
            &f.alice.principal.clone(),
            MailboxNavigation::Position(mailbox.clone()),
            8
        ),
        Err(StoreError::PositionScope)
    ));
    // Another group.
    assert!(matches!(
        f.store.read_mailbox_after(
            &f.bob.principal,
            MailboxAfterRequest {
                group_id: other.group_id.clone(),
                navigation: MailboxNavigation::Position(mailbox.clone()),
                max_items: 8,
            }
        ),
        Err(StoreError::PositionScope)
    ));
    // Thread and outgoing positions in the mailbox, and the mailbox position in
    // thread and outgoing reads.
    for foreign in [thread.clone(), outgoing.clone()] {
        assert!(matches!(
            f.mailbox(
                &f.bob.principal.clone(),
                MailboxNavigation::Position(foreign),
                8
            ),
            Err(StoreError::PositionScope)
        ));
    }
    assert!(matches!(
        f.store.read_thread(
            &f.bob.principal,
            ThreadPageRequest {
                group_id: f.group.group_id.clone(),
                root: root.message_id.clone(),
                navigation: MailboxNavigation::Position(mailbox.clone()),
                max_items: 8,
            }
        ),
        Err(StoreError::PositionScope)
    ));
    // A thread position under a different root.
    assert!(matches!(
        f.store.read_thread(
            &f.bob.principal,
            ThreadPageRequest {
                group_id: f.group.group_id.clone(),
                root: other_root.message_id.clone(),
                navigation: MailboxNavigation::Position(thread.clone()),
                max_items: 8,
            }
        ),
        Err(StoreError::PositionScope)
    ));
    assert!(matches!(
        f.store.read_outgoing(
            &f.alice.principal,
            OutgoingPageRequest {
                group_id: f.group.group_id.clone(),
                navigation: MailboxNavigation::Position(mailbox.clone()),
                max_items: 8,
            }
        ),
        Err(StoreError::PositionScope)
    ));
    // The matching scopes still work.
    assert!(f
        .store
        .read_thread(
            &f.bob.principal,
            ThreadPageRequest {
                group_id: f.group.group_id.clone(),
                root: root.message_id.clone(),
                navigation: MailboxNavigation::Position(thread.clone()),
                max_items: 8,
            }
        )
        .unwrap()
        .messages
        .is_empty());
    assert!(f
        .store
        .read_outgoing(
            &f.alice.principal,
            OutgoingPageRequest {
                group_id: f.group.group_id.clone(),
                navigation: MailboxNavigation::Position(outgoing.clone()),
                max_items: 8,
            }
        )
        .unwrap()
        .messages
        .is_empty());

    // A policy change makes every earlier position stale; reset recovers.
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
    assert!(matches!(
        f.bob_position(mailbox.clone(), 8),
        Err(StoreError::StalePosition)
    ));
    assert!(matches!(
        f.store.read_thread(
            &f.bob.principal,
            ThreadPageRequest {
                group_id: f.group.group_id.clone(),
                root: root.message_id.clone(),
                navigation: MailboxNavigation::Position(thread.clone()),
                max_items: 8,
            }
        ),
        Err(StoreError::StalePosition)
    ));
    assert!(matches!(
        f.store.read_outgoing(
            &f.alice.principal,
            OutgoingPageRequest {
                group_id: f.group.group_id.clone(),
                navigation: MailboxNavigation::Position(outgoing),
                max_items: 8,
            }
        ),
        Err(StoreError::StalePosition)
    ));
    let fresh = f.bob_reset(0, 8);
    assert_eq!(
        fresh.resume_position.policy_revision(),
        group.policy_revision
    );
    assert_eq!(sequences(&fresh), vec![1, 2, 3]);
    // Cursors and positions are mutually exclusive by type: a cursor from a
    // partial page continues the frozen watermark, the position of the same
    // page does not freeze anything.
    f.send_to_bob("late");
    let partial = f.bob_reset(0, 1);
    let cursor = partial.next_cursor.clone().unwrap();
    let via_cursor = f
        .mailbox(
            &f.bob.principal.clone(),
            MailboxNavigation::Cursor(cursor),
            8,
        )
        .unwrap();
    assert_eq!(via_cursor.snapshot_high_sequence, 4);
    f.send_to_bob("later");
    let via_position = f.bob_position(partial.resume_position.clone(), 8).unwrap();
    assert_eq!(via_position.snapshot_high_sequence, 5);
    assert_eq!(sequences(&via_position), vec![2, 3, 4, 5]);
}

#[test]
fn positions_round_trip_as_bounded_json_and_grant_nothing_when_retagged() {
    let mut f = Fixture::new("positions-json");
    f.send_to_bob("one");
    f.send_to_bob("two");
    let carol_only = f
        .store
        .send_message(
            &f.alice.principal,
            send(&f.group.group_id, "carol", &[&f.carol.record.peer_id], "c"),
        )
        .unwrap();
    let page = f.bob_reset(0, 1);
    let position = page.resume_position.clone();
    let json = serde_json::to_string(&position).unwrap();
    let round: NavigationPosition = serde_json::from_str(&json).unwrap();
    assert_eq!(round, position);
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["after_sequence"], serde_json::json!(1));
    assert_eq!(value["scope"], serde_json::json!("mailbox"));
    assert_eq!(
        value["group_id"],
        serde_json::json!(f.group.group_id.as_str())
    );
    assert_eq!(
        value["peer_id"],
        serde_json::json!(f.bob.record.peer_id.as_str())
    );
    // Unknown fields are rejected, as is a malformed identity.
    let mut extra = value.clone();
    extra["cursor_id"] = serde_json::json!("c_0");
    assert!(serde_json::from_value::<NavigationPosition>(extra).is_err());
    let mut malformed = value.clone();
    malformed["peer_id"] = serde_json::json!("not-a-peer");
    assert!(serde_json::from_value::<NavigationPosition>(malformed).is_err());
    let mut wide = value.clone();
    wide["after_sequence"] = serde_json::json!(u64::MAX);
    let wide: NavigationPosition = serde_json::from_value(wide).unwrap();
    assert!(matches!(
        f.bob_position(wide, 8),
        Err(StoreError::Validation(ValidationError::IntegerRange {
            field: "after_sequence"
        }))
    ));
    let navigation: MailboxNavigation =
        serde_json::from_str(&format!("{{\"position\":{json}}}")).unwrap();
    assert_eq!(navigation, MailboxNavigation::Position(position.clone()));
    let reset: MailboxNavigation =
        serde_json::from_str("{\"reset_after\":{\"after_sequence\":0}}").unwrap();
    assert_eq!(reset, MailboxNavigation::ResetAfter { after_sequence: 0 });
    assert!(
        serde_json::from_str::<MailboxNavigation>("{\"after\":{\"after_sequence\":0}}").is_err()
    );

    // Carol retags bob's position with her own identity: it is accepted as
    // her own navigation and grants nothing about bob's rows.
    let mut retagged = value.clone();
    retagged["peer_id"] = serde_json::json!(f.carol.record.peer_id.as_str());
    let retagged: NavigationPosition = serde_json::from_value(retagged).unwrap();
    let carol_page = f
        .mailbox(
            &f.carol.principal.clone(),
            MailboxNavigation::Position(retagged),
            8,
        )
        .unwrap();
    assert_eq!(sequences(&carol_page), vec![carol_only.group_sequence]);
    // Carol using bob's position untouched is a scope error.
    assert!(matches!(
        f.mailbox(
            &f.carol.principal.clone(),
            MailboxNavigation::Position(position),
            8
        ),
        Err(StoreError::PositionScope)
    ));
}

#[test]
fn positions_beyond_2_pow_53_stay_exact() {
    let mut f = Fixture::new("positions-2p53");
    const HIGH: u64 = (1_u64 << 53) + 1;
    let connection = Connection::open(&f.path).unwrap();
    connection
        .execute(
            "UPDATE groups SET next_sequence=?1 WHERE group_id=?2",
            params![HIGH as i64, f.group.group_id.as_str()],
        )
        .unwrap();
    drop(connection);
    assert_eq!(f.send_to_bob("a").group_sequence, HIGH);
    f.send_to_bob("b");
    let page = f.bob_reset(HIGH - 1, 1);
    assert_eq!(sequences(&page), vec![HIGH]);
    assert_eq!(page.resume_position.after_sequence(), HIGH);
    let json = serde_json::to_value(&page).unwrap();
    assert_eq!(
        json["resume_position"]["after_sequence"],
        serde_json::json!(HIGH)
    );
    let next = f.bob_position(page.resume_position.clone(), 8).unwrap();
    assert_eq!(sequences(&next), vec![HIGH + 1]);
    assert_eq!(next.resume_position.after_sequence(), HIGH + 1);
    assert!(matches!(
        f.mailbox(
            &f.bob.principal.clone(),
            MailboxNavigation::ResetAfter {
                after_sequence: i64::MAX as u64 + 1
            },
            8
        ),
        Err(StoreError::Validation(ValidationError::IntegerRange {
            field: "after_sequence"
        }))
    ));
}

#[test]
fn mailbox_final_envelope_includes_cursor_and_maximal_position_width() {
    let mut f = Fixture::new("positions-envelope");
    const FIRST: u64 = (1_u64 << 53) + 1;
    let connection = Connection::open(&f.path).unwrap();
    connection
        .execute(
            "UPDATE groups SET next_sequence=?1 WHERE group_id=?2",
            params![FIRST as i64, f.group.group_id.as_str()],
        )
        .unwrap();
    drop(connection);
    let nul = |chars: usize| "\u{0}".repeat(chars);
    let m1 = f
        .store
        .send_message(
            &f.alice.principal,
            send(
                &f.group.group_id,
                "m1",
                &[&f.bob.record.peer_id],
                &nul(MAX_MESSAGE_BODY_BYTES),
            ),
        )
        .unwrap();
    assert_eq!(m1.group_sequence, FIRST);
    // Measured: the empty envelope and one maximal entry, both already carrying
    // a 16-digit resume position and 16-digit watermark.
    let empty = serde_json::to_vec(&f.bob_reset(FIRST, 1)).unwrap().len();
    let one = serde_json::to_vec(&f.bob_reset(FIRST - 1, 1))
        .unwrap()
        .len();
    let entry_one = one - empty;
    let entry_base = entry_one - (6 * MAX_MESSAGE_BODY_BYTES + 2);
    // The cursor replaces `null` by a quoted opaque identity of fixed width.
    let cursor_growth = serde_json::to_vec(&MailboxCursor::generate())
        .unwrap()
        .len()
        - 4;
    let target = MAX_MAILBOX_PAGE_BYTES + 8;
    let entry_two = target - (one + cursor_growth) - 1;
    let content = entry_two - entry_base - 2;
    let nuls = content / 6;
    let ascii = content - 6 * nuls;
    assert!(nuls + ascii <= MAX_MESSAGE_BODY_BYTES);
    let body_two = format!("{}{}", nul(nuls), "x".repeat(ascii));
    f.store
        .send_message(
            &f.alice.principal,
            send(&f.group.group_id, "m2", &[&f.bob.record.peer_id], &body_two),
        )
        .unwrap();
    f.send_to_bob("m3");
    // Two entries fit without the cursor, and overflow by at most eight bytes
    // with it: a sizer that omits the cursor or shortens the position width
    // returns an oversized page here.
    assert!(one + 1 + entry_two <= MAX_MAILBOX_PAGE_BYTES);
    assert!(one + cursor_growth + 1 + entry_two > MAX_MAILBOX_PAGE_BYTES);

    let first = f.bob_reset(FIRST - 1, 2);
    let bytes = serde_json::to_vec(&first).unwrap().len();
    assert!(
        bytes <= MAX_MAILBOX_PAGE_BYTES,
        "first page is {bytes} bytes"
    );
    assert!(bytes > MAX_MAILBOX_PAGE_BYTES - 2 * 1024 * 1024);
    assert_eq!(sequences(&first), vec![FIRST]);
    assert_eq!(first.resume_position.after_sequence(), FIRST);
    let cursor = first.next_cursor.clone().unwrap();
    // Lossless through the cursor.
    let rest = f
        .mailbox(
            &f.bob.principal.clone(),
            MailboxNavigation::Cursor(cursor),
            2,
        )
        .unwrap();
    assert_eq!(sequences(&rest), vec![FIRST + 1, FIRST + 2]);
    assert!(serde_json::to_vec(&rest).unwrap().len() <= MAX_MAILBOX_PAGE_BYTES);
    // Lossless through the position.
    let rest = f.bob_position(first.resume_position.clone(), 2).unwrap();
    assert_eq!(sequences(&rest), vec![FIRST + 1, FIRST + 2]);
    assert_eq!(rest.resume_position.after_sequence(), FIRST + 2);
    assert!(rest.next_cursor.is_none());
}
