mod support;

use std::collections::BTreeSet;

use termx_swarm_core::error::StoreError;
use termx_swarm_core::model::*;
use termx_swarm_core::store::Store;

fn binding(name: &str, live: bool) -> VerifiedBinding {
    VerifiedBinding::trusted(
        LaunchId::generate().as_str().into(),
        format!("terminal-{name}"),
        "codex".to_owned(),
        format!("conversation-{name}"),
        Some(format!(r#"{{"model":"{name}"}}"#)),
        4242,
        133_000_000_000_000_000,
        live,
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

fn rebind(peer: &EnrolledPeer, terminal: &str, pid: u32) -> VerifiedContinuation {
    VerifiedContinuation::trusted(
        &peer.record,
        VerifiedBinding::trusted(
            LaunchId::generate().as_str().into(),
            terminal.into(),
            "codex".into(),
            peer.record.conversation_id.clone(),
            None,
            pid,
            1,
            true,
        )
        .unwrap(),
        "same-branch".into(),
    )
    .unwrap()
}

/// Serialized peer projections must not carry native binding details, resolver
/// paths, authority identity or trusted principals.
fn assert_public(json: &str, forbidden: &[&str]) {
    for needle in forbidden {
        assert!(
            !json.contains(needle),
            "public projection leaked {needle:?}: {json}"
        );
    }
    assert!(!json.contains("terminal-"), "terminal id leaked: {json}");
    assert!(!json.contains(":4242"), "process id leaked: {json}");
    assert!(
        !json.contains("133000000000000000"),
        "FILETIME leaked: {json}"
    );
    assert!(!json.contains("secret"), "resolver key leaked: {json}");
    assert!(!json.contains("authority"), "authority leaked: {json}");
    assert!(!json.contains("\"a_"), "authority id leaked: {json}");
}

#[test]
fn whoami_discovers_bounded_current_memberships_without_a_group_id() {
    let path = support::retained_db("whoami-bootstrap");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let alice = store.enroll_peer(&owner, binding("alice", true)).unwrap();
    let bob = store.enroll_peer(&owner, binding("bob", true)).unwrap();
    let carol = store.enroll_peer(&owner, binding("carol", true)).unwrap();

    // Zero memberships: bootstrap still resolves the authenticated self.
    let none = store
        .whoami(
            &alice.principal,
            WhoAmIRequest {
                after_group: None,
                max_items: 8,
            },
        )
        .unwrap();
    assert_eq!(none.peer_id, alice.record.peer_id);
    assert_eq!(none.binding_revision, alice.record.revision);
    assert!(none.memberships.is_empty());
    assert!(none.next_after_group.is_none());
    assert_public(
        &serde_json::to_string(&none).unwrap(),
        &["conversation-", "resolver"],
    );

    let mut groups = Vec::new();
    for label in ["one", "two", "three"] {
        groups.push(
            store
                .create_group(
                    &owner,
                    label,
                    members(&[&alice.record.peer_id, &bob.record.peer_id]),
                )
                .unwrap(),
        );
    }
    let hidden = store
        .create_group(
            &owner,
            "hidden",
            members(&[&bob.record.peer_id, &carol.record.peer_id]),
        )
        .unwrap();
    let paused = store
        .set_group_paused(&owner, &groups[1].group_id, true, groups[1].policy_revision)
        .unwrap();
    let removed = store
        .set_membership(
            &owner,
            &groups[2].group_id,
            &alice.record.peer_id,
            false,
            groups[2].policy_revision,
        )
        .unwrap();
    assert!(removed.policy_revision > groups[2].policy_revision);

    let mut seen = Vec::new();
    let mut after = None;
    loop {
        let page = store
            .whoami(
                &alice.principal,
                WhoAmIRequest {
                    after_group: after.clone(),
                    max_items: 1,
                },
            )
            .unwrap();
        assert!(page.memberships.len() <= 1);
        seen.extend(page.memberships.clone());
        after = page.next_after_group.clone();
        if after.is_none() {
            break;
        }
    }
    let mut expected = vec![groups[0].group_id.clone(), groups[1].group_id.clone()];
    expected.sort();
    assert_eq!(
        seen.iter().map(|m| m.group_id.clone()).collect::<Vec<_>>(),
        expected
    );
    for membership in &seen {
        assert_ne!(membership.group_id, hidden.group_id);
        assert_ne!(membership.group_id, groups[2].group_id);
        if membership.group_id == paused.group_id {
            assert!(membership.paused);
            assert_eq!(membership.policy_revision, paused.policy_revision);
            assert_eq!(membership.availability, MembershipAvailability::Paused);
        } else {
            assert!(!membership.paused);
            assert_eq!(membership.availability, MembershipAvailability::Available);
        }
    }
    // Position beyond the last group is a valid empty tail.
    let tail = store
        .whoami(
            &alice.principal,
            WhoAmIRequest {
                after_group: Some(expected[1].clone()),
                max_items: 8,
            },
        )
        .unwrap();
    assert!(tail.memberships.is_empty() && tail.next_after_group.is_none());

    // Bounded request validation.
    assert!(matches!(
        store.whoami(
            &alice.principal,
            WhoAmIRequest {
                after_group: None,
                max_items: 0
            }
        ),
        Err(StoreError::Validation(_))
    ));
    assert!(matches!(
        store.whoami(
            &alice.principal,
            WhoAmIRequest {
                after_group: None,
                max_items: MAX_METADATA_PAGE_ITEMS + 1
            }
        ),
        Err(StoreError::Validation(_))
    ));

    // An offline binding still resolves itself and reports unavailable state.
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
    let offline = store
        .whoami(
            &alice.principal,
            WhoAmIRequest {
                after_group: None,
                max_items: 8,
            },
        )
        .unwrap();
    assert!(!offline.is_live);
    assert!(offline
        .memberships
        .iter()
        .all(|m| m.availability != MembershipAvailability::Available));

    // A predecessor binding never discovers current memberships.
    let successor = store
        .continue_peer(
            &owner,
            rebind(&alice, "terminal-alice-2", 4243),
            "continue",
            [
                (groups[0].group_id.clone(), groups[0].policy_revision),
                (paused.group_id.clone(), paused.policy_revision),
            ]
            .into(),
        )
        .unwrap();
    assert!(matches!(
        store.whoami(
            &alice.principal,
            WhoAmIRequest {
                after_group: None,
                max_items: 8
            }
        ),
        Err(StoreError::StaleBinding)
    ));
    let rebound = store
        .whoami(
            &successor.principal,
            WhoAmIRequest {
                after_group: None,
                max_items: 8,
            },
        )
        .unwrap();
    assert_eq!(rebound.binding_revision, successor.record.revision);
    assert_eq!(rebound.memberships.len(), 2);

    // Another authority's principal is rejected before any lookup.
    let mut other = Store::open(support::retained_db("whoami-other-authority")).unwrap();
    let other_owner = other.trusted_owner();
    let alien = other
        .enroll_peer(&other_owner, binding("alien", true))
        .unwrap();
    assert!(matches!(
        store.whoami(
            &alien.principal,
            WhoAmIRequest {
                after_group: None,
                max_items: 8
            }
        ),
        Err(StoreError::AuthorityMismatch)
    ));
}

#[test]
fn list_peers_projects_one_explicit_group_with_public_metadata_only() {
    let path = support::retained_db("list-peers");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let alice = store.enroll_peer(&owner, binding("alice", true)).unwrap();
    let bob = store.enroll_peer(&owner, binding("bob", true)).unwrap();
    let carol = store.enroll_peer(&owner, binding("carol", true)).unwrap();
    let dave = store.enroll_peer(&owner, binding("dave", true)).unwrap();
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
    let other = store
        .create_group(
            &owner,
            "other",
            members(&[&alice.record.peer_id, &dave.record.peer_id]),
        )
        .unwrap();
    let registration = store
        .register_source(&owner, descriptor(&bob, "bob"))
        .unwrap();
    let status = store
        .publish_status(
            &bob.principal,
            StatusRequest {
                group_id: group.group_id.clone(),
                status: Some("reviewing \u{1f980} parser".into()),
            },
        )
        .unwrap();
    assert_eq!(status.status.as_deref(), Some("reviewing \u{1f980} parser"));
    // Status writes need a live authorized binding; the status then survives
    // the binding going offline and is projected with the offline state.
    store
        .update_peer_metadata(
            &owner,
            &bob.record.peer_id,
            bob.record.revision,
            PeerMetadataUpdate {
                model_metadata: Some(r#"{"model":"bob"}"#.into()),
                is_live: false,
            },
        )
        .unwrap();
    assert!(matches!(
        store.publish_status(
            &bob.principal,
            StatusRequest {
                group_id: group.group_id.clone(),
                status: Some("offline write".into()),
            },
        ),
        Err(StoreError::BindingOffline)
    ));

    let group = store
        .set_membership(
            &owner,
            &group.group_id,
            &carol.record.peer_id,
            false,
            group.policy_revision,
        )
        .unwrap();

    let mut listed = Vec::new();
    let mut after = None;
    loop {
        let page = store
            .list_peers(
                &alice.principal,
                ListPeersRequest {
                    group_id: group.group_id.clone(),
                    after_peer: after.clone(),
                    max_items: 1,
                },
            )
            .unwrap();
        assert_eq!(page.group_id, group.group_id);
        assert_eq!(page.policy_revision, group.policy_revision);
        assert!(page.peers.len() <= 1);
        let json = serde_json::to_string(&page).unwrap();
        assert_public(&json, &["conversation-", "resolver", "evidence"]);
        listed.extend(page.peers);
        after = page.next_after_peer;
        if after.is_none() {
            break;
        }
    }
    let mut expected = vec![alice.record.peer_id.clone(), bob.record.peer_id.clone()];
    expected.sort();
    assert_eq!(
        listed.iter().map(|p| p.peer_id.clone()).collect::<Vec<_>>(),
        expected,
        "removed carol and unrelated dave must not appear"
    );
    let bob_view = listed
        .iter()
        .find(|p| p.peer_id == bob.record.peer_id)
        .unwrap();
    assert!(!bob_view.is_live);
    assert_eq!(bob_view.harness, "codex");
    assert_eq!(
        bob_view.model_metadata.as_deref(),
        Some(r#"{"model":"bob"}"#)
    );
    assert_eq!(bob_view.status.as_ref().unwrap().status, status.status);
    assert_eq!(bob_view.sources.len(), 1);
    assert_eq!(bob_view.sources[0].source_id, registration.source_id);
    assert_eq!(
        bob_view.sources[0].registration_epoch,
        registration.registration_epoch
    );

    // The status is scoped to one group and is caller-owned.
    let other_page = store
        .list_peers(
            &alice.principal,
            ListPeersRequest {
                group_id: other.group_id.clone(),
                after_peer: None,
                max_items: 8,
            },
        )
        .unwrap();
    let alice_in_other = other_page
        .peers
        .iter()
        .find(|p| p.peer_id == alice.record.peer_id)
        .unwrap();
    assert!(alice_in_other.status.is_none());
    assert!(matches!(
        store.publish_status(
            &dave.principal,
            StatusRequest {
                group_id: group.group_id.clone(),
                status: Some("not a member".into())
            }
        ),
        Err(StoreError::Unauthorized { .. })
    ));
    // Back online, the same binding owns and may clear its status.
    store
        .update_peer_metadata(
            &owner,
            &bob.record.peer_id,
            bob.record.revision,
            PeerMetadataUpdate {
                model_metadata: Some(r#"{"model":"bob"}"#.into()),
                is_live: true,
            },
        )
        .unwrap();
    assert!(matches!(
        store.publish_status(
            &bob.principal,
            StatusRequest {
                group_id: group.group_id.clone(),
                status: Some("x".repeat(MAX_STATUS_BYTES + 1))
            }
        ),
        Err(StoreError::Validation(_))
    ));
    let cleared = store
        .publish_status(
            &bob.principal,
            StatusRequest {
                group_id: group.group_id.clone(),
                status: None,
            },
        )
        .unwrap();
    assert!(cleared.status.is_none());
    assert!(cleared.status_revision > status.status_revision);

    // Non-members, removed members and paused groups cannot list.
    assert!(matches!(
        store.list_peers(
            &dave.principal,
            ListPeersRequest {
                group_id: group.group_id.clone(),
                after_peer: None,
                max_items: 8
            }
        ),
        Err(StoreError::Unauthorized { .. })
    ));
    assert!(matches!(
        store.list_peers(
            &carol.principal,
            ListPeersRequest {
                group_id: group.group_id.clone(),
                after_peer: None,
                max_items: 8
            }
        ),
        Err(StoreError::Unauthorized { .. })
    ));
    let paused = store
        .set_group_paused(&owner, &group.group_id, true, group.policy_revision)
        .unwrap();
    assert!(matches!(
        store.list_peers(
            &alice.principal,
            ListPeersRequest {
                group_id: group.group_id.clone(),
                after_peer: None,
                max_items: 8
            }
        ),
        Err(StoreError::GroupPaused)
    ));
    let resumed = store
        .set_group_paused(&owner, &group.group_id, false, paused.policy_revision)
        .unwrap();

    // A binding change is visible as a new revision; the old principal is stale.
    let bob2 = store
        .continue_peer(
            &owner,
            rebind(&bob, "terminal-bob-2", 4243),
            "continue",
            [(group.group_id.clone(), resumed.policy_revision)].into(),
        )
        .unwrap();
    let page = store
        .list_peers(
            &alice.principal,
            ListPeersRequest {
                group_id: group.group_id.clone(),
                after_peer: None,
                max_items: 8,
            },
        )
        .unwrap();
    let bob_view = page
        .peers
        .iter()
        .find(|p| p.peer_id == bob.record.peer_id)
        .unwrap();
    assert_eq!(bob_view.binding_revision, bob2.record.revision);
    assert!(bob_view.is_live);
    assert!(
        bob_view.sources.is_empty(),
        "a source bound to the predecessor binding is not current until re-established"
    );
    assert!(matches!(
        store.list_peers(
            &bob.principal,
            ListPeersRequest {
                group_id: group.group_id.clone(),
                after_peer: None,
                max_items: 8
            }
        ),
        Err(StoreError::StaleBinding)
    ));
}

#[test]
fn owner_snapshots_are_owner_authenticated_revision_coherent_and_side_effect_free() {
    let path = support::retained_db("owner-snapshot");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let before = store.state_revisions(&owner).unwrap();
    let alice = store.enroll_peer(&owner, binding("alice", true)).unwrap();
    let bob = store.enroll_peer(&owner, binding("bob", true)).unwrap();
    let after_enroll = store.state_revisions(&owner).unwrap();
    assert!(after_enroll.inventory_revision > before.inventory_revision);
    assert_eq!(after_enroll.delivery_revision, before.delivery_revision);
    let group = store
        .create_group(
            &owner,
            "pair",
            members(&[&alice.record.peer_id, &bob.record.peer_id]),
        )
        .unwrap();
    let after_group = store.state_revisions(&owner).unwrap();
    assert!(after_group.inventory_revision > after_enroll.inventory_revision);
    assert_eq!(
        after_group.delivery_revision,
        after_enroll.delivery_revision
    );
    let saved = store
        .send_message(
            &alice.principal,
            SendMessageRequest {
                group_id: group.group_id.clone(),
                client_key: "one".into(),
                recipients: members(&[&bob.record.peer_id]),
                body: "hello".into(),
                topic: Some("topic".into()),
                reply_to: None,
                attachments: Vec::new(),
            },
        )
        .unwrap();
    let after_send = store.state_revisions(&owner).unwrap();
    assert!(after_send.delivery_revision > after_group.delivery_revision);
    assert_eq!(
        after_send.inventory_revision, after_group.inventory_revision,
        "content appends never advance inventory"
    );

    // Only this store's owner authority can read owner snapshots.
    let other = Store::open(support::retained_db("owner-snapshot-other")).unwrap();
    assert!(matches!(
        store.owner_snapshot(
            &other.trusted_owner(),
            OwnerSnapshotRequest::Peers {
                expected_inventory_revision: None,
                after_peer: None,
                max_items: 8
            }
        ),
        Err(StoreError::AuthorityMismatch)
    ));

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
    assert_eq!(first.peers.len(), 1);
    assert_eq!(
        first.revisions.inventory_revision,
        after_send.inventory_revision
    );
    let next = first.next_after_peer.clone().expect("second peer remains");
    // A mutation between pages invalidates the captured revision.
    let carol = store.enroll_peer(&owner, binding("carol", true)).unwrap();
    assert!(matches!(
        store.owner_snapshot(
            &owner,
            OwnerSnapshotRequest::Peers {
                expected_inventory_revision: Some(first.revisions.inventory_revision),
                after_peer: Some(next.clone()),
                max_items: 1
            }
        ),
        Err(StoreError::StaleSnapshot { .. })
    ));
    // Re-page under the current revision: every page of the traversal proves
    // the same inventory revision, and the pages chain by opaque peer order.
    let current = store.state_revisions(&owner).unwrap();
    let mut views = Vec::new();
    let mut after = None;
    loop {
        let OwnerSnapshotPage::Peers(page) = store
            .owner_snapshot(
                &owner,
                OwnerSnapshotRequest::Peers {
                    expected_inventory_revision: Some(current.inventory_revision),
                    after_peer: after.clone(),
                    max_items: 1,
                },
            )
            .unwrap()
        else {
            panic!("peers page")
        };
        assert_eq!(page.revisions, current);
        assert!(page.peers.len() <= 1);
        views.extend(page.peers);
        after = page.next_after_peer;
        if after.is_none() {
            break;
        }
    }
    let _ = next;
    let all: Vec<_> = views.iter().map(|p| p.binding.peer_id.clone()).collect();
    let mut expected = vec![
        alice.record.peer_id.clone(),
        bob.record.peer_id.clone(),
        carol.record.peer_id.clone(),
    ];
    expected.sort();
    assert_eq!(all, expected);
    assert!(views
        .iter()
        .any(|p| p.binding.peer_id == bob.record.peer_id));
    let OwnerSnapshotPage::PeerMemberships(bob_memberships) = store
        .owner_snapshot(
            &owner,
            OwnerSnapshotRequest::PeerMemberships {
                peer_id: bob.record.peer_id.clone(),
                expected_inventory_revision: Some(current.inventory_revision),
                after_group: None,
                max_items: 8,
            },
        )
        .unwrap()
    else {
        panic!("peer memberships page")
    };
    assert_eq!(bob_memberships.revisions, current);
    assert_eq!(bob_memberships.memberships.len(), 1);
    assert_eq!(bob_memberships.memberships[0].group_id, group.group_id);

    let OwnerSnapshotPage::Groups(groups) = store
        .owner_snapshot(
            &owner,
            OwnerSnapshotRequest::Groups {
                expected_inventory_revision: None,
                after_group: None,
                max_items: 8,
            },
        )
        .unwrap()
    else {
        panic!("groups page")
    };
    assert_eq!(groups.groups.len(), 1);
    assert_eq!(groups.groups[0].group.group_id, group.group_id);
    assert_eq!(groups.groups[0].high_sequence, 1);
    let mut pair = vec![alice.record.peer_id.clone(), bob.record.peer_id.clone()];
    pair.sort();
    let OwnerSnapshotPage::GroupMembers(group_members) = store
        .owner_snapshot(
            &owner,
            OwnerSnapshotRequest::GroupMembers {
                group_id: group.group_id.clone(),
                expected_inventory_revision: Some(groups.revisions.inventory_revision),
                after_peer: None,
                max_items: 8,
            },
        )
        .unwrap()
    else {
        panic!("group members page")
    };
    assert_eq!(group_members.members, pair);

    let OwnerSnapshotPage::Messages(messages) = store
        .owner_snapshot(
            &owner,
            OwnerSnapshotRequest::Messages {
                group_id: group.group_id.clone(),
                after_sequence: 0,
                through_sequence: None,
                max_items: 8,
            },
        )
        .unwrap()
    else {
        panic!("messages page")
    };
    assert_eq!(messages.snapshot_high_sequence, 1);
    assert_eq!(messages.messages.len(), 1);
    assert_eq!(messages.messages[0].message.message_id, saved.message_id);
    assert_eq!(messages.messages[0].message.body, "hello");
    assert_eq!(messages.messages[0].recipients.len(), 1);
    assert_eq!(
        messages.messages[0].recipients[0].peer_id,
        bob.record.peer_id
    );
    assert!(messages.messages[0].recipients[0]
        .fetched_at_millis
        .is_none());
    assert!(messages.next_after_sequence.is_none());

    // Owner reads never manufacture peer fetch or ACK.
    assert_eq!(
        store.state_revisions(&owner).unwrap().delivery_revision,
        after_send.delivery_revision
    );
    store.recover_trusted_new_run(&owner).unwrap();
    let candidates = store
        .delivery_candidates(
            &owner,
            &group.group_id,
            &bob.record.peer_id,
            bob.record.revision,
            8,
        )
        .unwrap();
    assert_eq!(
        candidates.len(),
        1,
        "owner read must leave the delivery eligible"
    );
    let page = store
        .read_mailbox(
            &bob.principal,
            MailboxPageRequest {
                group_id: group.group_id.clone(),
                cursor: None,
                max_items: 8,
            },
        )
        .unwrap();
    assert!(page.messages[0].receipt.acknowledged_at_millis.is_none());
    assert!(page.messages[0].receipt.fetched_at_millis.is_some());
    let after_fetch = store.state_revisions(&owner).unwrap();
    assert!(after_fetch.delivery_revision > after_send.delivery_revision);

    // Position beyond the frozen watermark is explicit, not silently moved.
    assert!(matches!(
        store.owner_snapshot(
            &owner,
            OwnerSnapshotRequest::Messages {
                group_id: group.group_id.clone(),
                after_sequence: 2,
                through_sequence: None,
                max_items: 8
            }
        ),
        Err(StoreError::InvalidPosition { .. })
    ));
    assert!(matches!(
        store.owner_snapshot(
            &owner,
            OwnerSnapshotRequest::Messages {
                group_id: group.group_id.clone(),
                after_sequence: 0,
                through_sequence: Some(5),
                max_items: 8
            }
        ),
        Err(StoreError::InvalidPosition { .. })
    ));
    let run = store.state_revisions(&owner).unwrap().run_revision;
    assert_eq!(run, Some(Revision::new(1).unwrap()));
}

#[test]
fn source_registration_transitions_use_owner_cas_and_preserve_history() {
    let path = support::retained_db("source-registration");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let alice = store.enroll_peer(&owner, binding("alice", true)).unwrap();
    let bob = store.enroll_peer(&owner, binding("bob", true)).unwrap();
    let group = store
        .create_group(
            &owner,
            "pair",
            members(&[&alice.record.peer_id, &bob.record.peer_id]),
        )
        .unwrap();

    // Descriptor invariants are structural; the binding must be current and exact.
    assert!(VerifiedSourceDescriptor::trusted(
        bob.record.peer_id.clone(),
        bob.record.revision,
        bob.record.conversation_id.clone(),
        "".into(),
        "resolver".into(),
        "object".into(),
        "evidence".into(),
    )
    .is_err());
    let wrong_conversation = VerifiedSourceDescriptor::trusted(
        bob.record.peer_id.clone(),
        bob.record.revision,
        "other-conversation".into(),
        "codex-jsonl".into(),
        "resolver".into(),
        "object".into(),
        "evidence".into(),
    )
    .unwrap();
    assert!(matches!(
        store.register_source(&owner, wrong_conversation),
        Err(StoreError::Unauthorized { .. })
    ));
    let wrong_binding = VerifiedSourceDescriptor::trusted(
        bob.record.peer_id.clone(),
        Revision::new(2).unwrap(),
        bob.record.conversation_id.clone(),
        "codex-jsonl".into(),
        "resolver".into(),
        "object".into(),
        "evidence".into(),
    )
    .unwrap();
    assert!(matches!(
        store.register_source(&owner, wrong_binding),
        Err(StoreError::StaleBinding)
    ));

    let inventory_before = store.state_revisions(&owner).unwrap().inventory_revision;
    let registered = store
        .register_source(&owner, descriptor(&bob, "v1"))
        .unwrap();
    assert_eq!(registered.state, SourceState::Active);
    assert_eq!(registered.registration_epoch, Revision::new(1).unwrap());
    assert!(registered.inventory_revision > inventory_before);
    let json = serde_json::to_string(&registered).unwrap();
    assert!(
        !json.contains("secret"),
        "owner DTO must not carry the resolver key: {json}"
    );

    // Sends carry references only while the source is currently authorized.
    store
        .send_message(
            &bob.principal,
            SendMessageRequest {
                group_id: group.group_id.clone(),
                client_key: "cite".into(),
                recipients: members(&[&alice.record.peer_id]),
                body: "see my transcript".into(),
                topic: None,
                reply_to: None,
                attachments: vec![SourceAttachment {
                    source_id: registered.source_id.clone(),
                    snapshot_reference: Some("records 1-40".into()),
                }],
            },
        )
        .unwrap();
    let page = store
        .read_mailbox(
            &alice.principal,
            MailboxPageRequest {
                group_id: group.group_id.clone(),
                cursor: None,
                max_items: 8,
            },
        )
        .unwrap();
    let attachment = page.messages[0].message.attachments[0].clone();
    assert_eq!(attachment.source_id, registered.source_id);
    assert_eq!(attachment.owner_peer_id, bob.record.peer_id);
    assert_eq!(
        attachment.snapshot_reference.as_deref(),
        Some("records 1-40")
    );
    assert_public(
        &serde_json::to_string(&page).unwrap(),
        &["conversation-", "resolver", "evidence"],
    );
    let view = store
        .resolve_attachment(
            &alice.principal,
            &group.group_id,
            &attachment.source_reference_id,
        )
        .unwrap();
    assert_eq!(
        view.availability,
        SourceAvailability::Available {
            registration_epoch: Revision::new(1).unwrap()
        }
    );

    // Stale CAS is rejected; withdrawal needs no fresh evidence.
    assert!(matches!(
        store.transition_source(
            &owner,
            SourceTransition::Withdraw {
                source_id: registered.source_id.clone(),
                expected_epoch: Revision::new(7).unwrap()
            }
        ),
        Err(StoreError::StaleSourceEpoch { .. })
    ));
    let withdrawn = store
        .transition_source(
            &owner,
            SourceTransition::Withdraw {
                source_id: registered.source_id.clone(),
                expected_epoch: registered.registration_epoch,
            },
        )
        .unwrap();
    assert_eq!(withdrawn.state, SourceState::Withdrawn);
    assert_eq!(withdrawn.registration_epoch, Revision::new(2).unwrap());
    assert!(withdrawn.inventory_revision > registered.inventory_revision);
    let view = store
        .resolve_attachment(
            &alice.principal,
            &group.group_id,
            &attachment.source_reference_id,
        )
        .unwrap();
    assert_eq!(view.availability, SourceAvailability::Withdrawn);
    assert!(matches!(
        store.send_message(
            &bob.principal,
            SendMessageRequest {
                group_id: group.group_id.clone(),
                client_key: "cite-withdrawn".into(),
                recipients: members(&[&alice.record.peer_id]),
                body: "cannot cite".into(),
                topic: None,
                reply_to: None,
                attachments: vec![SourceAttachment {
                    source_id: registered.source_id.clone(),
                    snapshot_reference: None
                }],
            },
        ),
        Err(StoreError::SourceUnavailable { .. })
    ));

    // Re-establishment needs fresh evidence and advances the epoch; the old
    // reference cited epoch 1 and stays stale rather than being redirected.
    let reestablished = store
        .transition_source(
            &owner,
            SourceTransition::Reestablish {
                source_id: registered.source_id.clone(),
                expected_epoch: withdrawn.registration_epoch,
                descriptor: descriptor(&bob, "v1-again"),
            },
        )
        .unwrap();
    assert_eq!(reestablished.state, SourceState::Active);
    assert_eq!(reestablished.registration_epoch, Revision::new(3).unwrap());
    assert_eq!(reestablished.evidence_reference, "task4-evidence-v1-again");
    let view = store
        .resolve_attachment(
            &alice.principal,
            &group.group_id,
            &attachment.source_reference_id,
        )
        .unwrap();
    assert_eq!(
        view.availability,
        SourceAvailability::Stale {
            cited_epoch: Revision::new(1).unwrap(),
            current_epoch: Revision::new(3).unwrap()
        }
    );

    // Replacement retains the old registration as replaced and mints a new source.
    let replacement = store
        .transition_source(
            &owner,
            SourceTransition::Replace {
                source_id: registered.source_id.clone(),
                expected_epoch: reestablished.registration_epoch,
                descriptor: descriptor(&bob, "v2"),
            },
        )
        .unwrap();
    assert_ne!(replacement.source_id, registered.source_id);
    assert_eq!(replacement.state, SourceState::Active);
    assert_eq!(replacement.registration_epoch, Revision::new(1).unwrap());
    let old = {
        let OwnerSnapshotPage::PeerSources(page) = store
            .owner_snapshot(
                &owner,
                OwnerSnapshotRequest::PeerSources {
                    peer_id: bob.record.peer_id.clone(),
                    expected_inventory_revision: None,
                    after_source: None,
                    max_items: 8,
                },
            )
            .unwrap()
        else {
            panic!()
        };
        page.sources
    };
    assert_eq!(old.len(), 2, "historical registration is retained");
    let retired = old
        .iter()
        .find(|s| s.source_id == registered.source_id)
        .unwrap();
    assert_eq!(retired.state, SourceState::Replaced);
    assert_eq!(retired.replaced_by.as_ref(), Some(&replacement.source_id));
    assert_eq!(retired.registration_epoch, Revision::new(4).unwrap());
    let view = store
        .resolve_attachment(
            &alice.principal,
            &group.group_id,
            &attachment.source_reference_id,
        )
        .unwrap();
    assert_eq!(view.availability, SourceAvailability::Replaced);
    assert!(matches!(
        store.transition_source(
            &owner,
            SourceTransition::Reestablish {
                source_id: registered.source_id.clone(),
                expected_epoch: Revision::new(4).unwrap(),
                descriptor: descriptor(&bob, "zombie"),
            }
        ),
        Err(StoreError::SourceUnavailable { .. })
    ));

    // Public attachment IDs convey no authority across groups or to non-recipients.
    let carol = store.enroll_peer(&owner, binding("carol", true)).unwrap();
    let other = store
        .create_group(
            &owner,
            "other",
            members(&[&bob.record.peer_id, &carol.record.peer_id]),
        )
        .unwrap();
    assert!(matches!(
        store.resolve_attachment(
            &carol.principal,
            &other.group_id,
            &attachment.source_reference_id
        ),
        Err(StoreError::NotFound { .. })
    ));
    assert!(matches!(
        store.resolve_attachment(
            &carol.principal,
            &group.group_id,
            &attachment.source_reference_id
        ),
        Err(StoreError::Unauthorized { .. })
    ));
    // Citing is allowed only where the source owner is an active member.
    store
        .send_message(
            &carol.principal,
            SendMessageRequest {
                group_id: other.group_id.clone(),
                client_key: "cite-member-source".into(),
                recipients: members(&[&bob.record.peer_id]),
                body: "bob is a member here".into(),
                topic: None,
                reply_to: None,
                attachments: vec![SourceAttachment {
                    source_id: replacement.source_id.clone(),
                    snapshot_reference: None,
                }],
            },
        )
        .unwrap();
    let alice_carol = store
        .create_group(
            &owner,
            "alice-carol",
            members(&[&alice.record.peer_id, &carol.record.peer_id]),
        )
        .unwrap();
    assert!(matches!(
        store.send_message(
            &carol.principal,
            SendMessageRequest {
                group_id: alice_carol.group_id.clone(),
                client_key: "steal".into(),
                recipients: members(&[&alice.record.peer_id]),
                body: "copying an id".into(),
                topic: None,
                reply_to: None,
                attachments: vec![SourceAttachment {
                    source_id: replacement.source_id.clone(),
                    snapshot_reference: None
                }],
            },
        ),
        Err(StoreError::Unauthorized { .. })
    ));

    // Ordinary appends do not touch the registration epoch.
    let epoch_before = replacement.registration_epoch;
    store
        .send_message(
            &alice.principal,
            SendMessageRequest {
                group_id: group.group_id.clone(),
                client_key: "append".into(),
                recipients: members(&[&bob.record.peer_id]),
                body: "append".into(),
                topic: None,
                reply_to: None,
                attachments: Vec::new(),
            },
        )
        .unwrap();
    let page = store
        .list_peers(
            &alice.principal,
            ListPeersRequest {
                group_id: group.group_id.clone(),
                after_peer: None,
                max_items: 8,
            },
        )
        .unwrap();
    let bob_view = page
        .peers
        .iter()
        .find(|p| p.peer_id == bob.record.peer_id)
        .unwrap();
    assert_eq!(bob_view.sources.len(), 1);
    assert_eq!(bob_view.sources[0].registration_epoch, epoch_before);

    // Continuation leaves the source bound to the predecessor until re-established.
    let bob2 = store
        .continue_peer(
            &owner,
            rebind(&bob, "terminal-bob-2", 4243),
            "continue",
            [
                (group.group_id.clone(), group.policy_revision),
                (other.group_id.clone(), other.policy_revision),
            ]
            .into(),
        )
        .unwrap();
    assert!(matches!(
        store.acquire_context_grant(&alice.principal, &group.group_id, &replacement.source_id),
        Err(StoreError::SourceUnavailable { .. })
    ));
    let rebound = store
        .transition_source(
            &owner,
            SourceTransition::Reestablish {
                source_id: replacement.source_id.clone(),
                expected_epoch: replacement.registration_epoch,
                descriptor: descriptor(&bob2, "v2-rebound"),
            },
        )
        .unwrap();
    assert_eq!(rebound.binding_revision, bob2.record.revision);
    assert_eq!(rebound.registration_epoch, Revision::new(2).unwrap());
    store
        .acquire_context_grant(&alice.principal, &group.group_id, &replacement.source_id)
        .unwrap();

    // Bounded active registrations per binding.
    for i in 0..MAX_ACTIVE_SOURCES_PER_BINDING - 1 {
        store
            .register_source(&owner, descriptor(&bob2, &format!("extra-{i}")))
            .unwrap();
    }
    assert!(matches!(
        store.register_source(&owner, descriptor(&bob2, "one-too-many")),
        Err(StoreError::Validation(_))
    ));
}
