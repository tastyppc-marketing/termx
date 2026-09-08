//! I1 and I4: owner inventory subpages are separate revision-bound bounded
//! collections, and every metadata/owner page sizes its final envelope
//! including the continuation token.
mod support;
#[path = "support/tuning.rs"]
mod tuning;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use rusqlite::{params, Connection};
use termx_swarm_core::error::StoreError;
use termx_swarm_core::model::*;
use termx_swarm_core::store::Store;
use tuning::{nul, tune, Tuner, COARSE_MAX_CHARS};

fn binding_with(terminal: String, conversation: String) -> VerifiedBinding {
    VerifiedBinding::trusted(
        LaunchId::generate().as_str().into(),
        terminal,
        "codex".to_owned(),
        conversation,
        None,
        100,
        10_000,
        true,
    )
    .unwrap()
}

fn binding(name: &str) -> VerifiedBinding {
    binding_with(format!("terminal-{name}"), format!("conversation-{name}"))
}

fn members(ids: &[&PeerId]) -> BTreeSet<PeerId> {
    ids.iter().map(|id| (*id).clone()).collect()
}

fn descriptor_with(
    peer: &EnrolledPeer,
    resolver: &str,
    object: String,
    evidence: String,
) -> VerifiedSourceDescriptor {
    VerifiedSourceDescriptor::trusted(
        peer.record.peer_id.clone(),
        peer.record.revision,
        peer.record.conversation_id.clone(),
        "codex-jsonl".into(),
        format!("C:\\secret\\resolver\\{resolver}.jsonl"),
        object,
        evidence,
    )
    .unwrap()
}

fn descriptor(peer: &EnrolledPeer, key: &str) -> VerifiedSourceDescriptor {
    descriptor_with(
        peer,
        key,
        format!("volume:1 file:{key}"),
        format!("task4-evidence-{key}"),
    )
}

/// Keeps `inventory_revision` at three digits for the whole test so widths
/// inside sized envelopes do not drift between measurement and assertion.
fn pad_inventory(store: &mut Store, owner: &OwnerPrincipal) {
    for index in 0..100 {
        store
            .create_group(owner, &format!("pad-{index}"), BTreeSet::new())
            .unwrap();
    }
    let revisions = store.state_revisions(owner).unwrap();
    assert!((100..900).contains(&revisions.inventory_revision.get()));
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

#[test]
fn nested_owner_pages_are_revision_coherent_and_keep_all_history_reachable() {
    let path = support::retained_db("owner-nested-pages");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let alice = store.enroll_peer(&owner, binding("alice")).unwrap();
    let bob = store.enroll_peer(&owner, binding("bob")).unwrap();
    let carol = store.enroll_peer(&owner, binding("carol")).unwrap();
    let mut groups = Vec::new();
    for label in ["g1", "g2", "g3", "g4", "g5"] {
        groups.push(
            store
                .create_group(
                    &owner,
                    label,
                    members(&[
                        &alice.record.peer_id,
                        &bob.record.peer_id,
                        &carol.record.peer_id,
                    ]),
                )
                .unwrap(),
        );
    }
    groups.sort_by(|a, b| a.group_id.cmp(&b.group_id));
    // Bob leaves two groups (retained removed history) and publishes a status.
    for index in [1, 3] {
        store
            .set_membership(
                &owner,
                &groups[index].group_id,
                &bob.record.peer_id,
                false,
                groups[index].policy_revision,
            )
            .unwrap();
    }
    let status = store
        .publish_status(
            &bob.principal,
            StatusRequest {
                group_id: groups[0].group_id.clone(),
                status: Some("busy".into()),
            },
        )
        .unwrap();
    // Carol leaves g1 too: retained removed member history for the group page.
    let g1 = store
        .set_membership(
            &owner,
            &groups[0].group_id,
            &carol.record.peer_id,
            false,
            groups[0].policy_revision,
        )
        .unwrap();
    // Registrations in every state, including a replaced one and its successor.
    let mut registrations = Vec::new();
    for key in ["s1", "s2", "s3"] {
        registrations.push(
            store
                .register_source(&owner, descriptor(&bob, key))
                .unwrap(),
        );
    }
    let withdrawn = store
        .transition_source(
            &owner,
            SourceTransition::Withdraw {
                source_id: registrations[0].source_id.clone(),
                expected_epoch: registrations[0].registration_epoch,
            },
        )
        .unwrap();
    let replacement = store
        .transition_source(
            &owner,
            SourceTransition::Replace {
                source_id: registrations[1].source_id.clone(),
                expected_epoch: registrations[1].registration_epoch,
                descriptor: descriptor(&bob, "s2-v2"),
            },
        )
        .unwrap();

    // Outer owner views are scalar: no nested collections at all.
    let OwnerSnapshotPage::Peers(peers) = store
        .owner_snapshot(
            &owner,
            OwnerSnapshotRequest::Peers {
                expected_inventory_revision: None,
                after_peer: None,
                max_items: 8,
            },
        )
        .unwrap()
    else {
        panic!()
    };
    let json = serde_json::to_string(&peers).unwrap();
    assert!(
        !json.contains("memberships") && !json.contains("sources"),
        "{json}"
    );
    assert_eq!(peers.peers.len(), 3);
    let OwnerSnapshotPage::Groups(group_page) = store
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
        panic!()
    };
    let json = serde_json::to_string(&group_page).unwrap();
    assert!(!json.contains("members"), "{json}");
    assert_eq!(group_page.groups.len(), 5);
    let captured = peers.revisions;
    assert_eq!(group_page.revisions, captured);

    // Peer memberships: only active rows, one per page, at the captured revision.
    let mut seen = Vec::new();
    let mut after = None;
    loop {
        let OwnerSnapshotPage::PeerMemberships(page) = store
            .owner_snapshot(
                &owner,
                OwnerSnapshotRequest::PeerMemberships {
                    peer_id: bob.record.peer_id.clone(),
                    expected_inventory_revision: Some(captured.inventory_revision),
                    after_group: after.clone(),
                    max_items: 1,
                },
            )
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(page.peer_id, bob.record.peer_id);
        assert_eq!(page.revisions, captured);
        assert!(page.memberships.len() <= 1);
        seen.extend(page.memberships);
        after = page.next_after_group;
        if after.is_none() {
            break;
        }
    }
    assert_eq!(
        seen.iter().map(|m| m.group_id.clone()).collect::<Vec<_>>(),
        vec![
            groups[0].group_id.clone(),
            groups[2].group_id.clone(),
            groups[4].group_id.clone()
        ]
    );
    assert_eq!(
        seen[0].status.as_ref().map(|s| s.status_revision),
        Some(status.status_revision)
    );
    assert!(seen[1].status.is_none());

    // Peer sources: every retained registration in every state.
    let mut sources = Vec::new();
    let mut after = None;
    loop {
        let OwnerSnapshotPage::PeerSources(page) = store
            .owner_snapshot(
                &owner,
                OwnerSnapshotRequest::PeerSources {
                    peer_id: bob.record.peer_id.clone(),
                    expected_inventory_revision: Some(captured.inventory_revision),
                    after_source: after.clone(),
                    max_items: 1,
                },
            )
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(page.peer_id, bob.record.peer_id);
        assert!(page.sources.len() <= 1);
        for source in &page.sources {
            assert_eq!(source.inventory_revision, captured.inventory_revision);
        }
        sources.extend(page.sources);
        after = page.next_after_source;
        if after.is_none() {
            break;
        }
    }
    let by_id: BTreeMap<_, _> = sources.iter().map(|s| (s.source_id.clone(), s)).collect();
    assert_eq!(
        by_id.len(),
        4,
        "s1 withdrawn, s2 replaced, s2-v2 active, s3 active"
    );
    assert_eq!(by_id[&withdrawn.source_id].state, SourceState::Withdrawn);
    assert_eq!(
        by_id[&registrations[1].source_id].state,
        SourceState::Replaced
    );
    assert_eq!(
        by_id[&registrations[1].source_id].replaced_by.as_ref(),
        Some(&replacement.source_id)
    );
    assert_eq!(by_id[&replacement.source_id].state, SourceState::Active);
    assert_eq!(
        by_id[&registrations[2].source_id].state,
        SourceState::Active
    );
    assert!(!serde_json::to_string(&sources).unwrap().contains("secret"));

    // Group members: active only, one per page.
    let mut member_ids = Vec::new();
    let mut after = None;
    loop {
        let OwnerSnapshotPage::GroupMembers(page) = store
            .owner_snapshot(
                &owner,
                OwnerSnapshotRequest::GroupMembers {
                    group_id: groups[0].group_id.clone(),
                    expected_inventory_revision: Some(captured.inventory_revision),
                    after_peer: after.clone(),
                    max_items: 1,
                },
            )
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(page.group_id, groups[0].group_id);
        assert!(page.members.len() <= 1);
        member_ids.extend(page.members);
        after = page.next_after_peer;
        if after.is_none() {
            break;
        }
    }
    let mut expected = vec![alice.record.peer_id.clone(), bob.record.peer_id.clone()];
    expected.sort();
    assert_eq!(member_ids, expected);
    assert_eq!(g1.policy_revision.get(), 2);

    // A continuation key without the captured revision is rejected on every
    // owner inventory page; a stale revision is rejected after any mutation.
    for request in [
        OwnerSnapshotRequest::Peers {
            expected_inventory_revision: None,
            after_peer: Some(alice.record.peer_id.clone()),
            max_items: 1,
        },
        OwnerSnapshotRequest::Groups {
            expected_inventory_revision: None,
            after_group: Some(groups[0].group_id.clone()),
            max_items: 1,
        },
        OwnerSnapshotRequest::PeerMemberships {
            peer_id: bob.record.peer_id.clone(),
            expected_inventory_revision: None,
            after_group: Some(groups[0].group_id.clone()),
            max_items: 1,
        },
        OwnerSnapshotRequest::PeerSources {
            peer_id: bob.record.peer_id.clone(),
            expected_inventory_revision: None,
            after_source: Some(registrations[0].source_id.clone()),
            max_items: 1,
        },
        OwnerSnapshotRequest::GroupMembers {
            group_id: groups[0].group_id.clone(),
            expected_inventory_revision: None,
            after_peer: Some(alice.record.peer_id.clone()),
            max_items: 1,
        },
    ] {
        assert!(
            matches!(
                store.owner_snapshot(&owner, request.clone()),
                Err(StoreError::Validation(_))
            ),
            "{request:?}"
        );
    }
    let dave = store.enroll_peer(&owner, binding("dave")).unwrap();
    assert!(matches!(
        store.owner_snapshot(
            &owner,
            OwnerSnapshotRequest::GroupMembers {
                group_id: groups[0].group_id.clone(),
                expected_inventory_revision: Some(captured.inventory_revision),
                after_peer: Some(alice.record.peer_id.clone()),
                max_items: 1,
            }
        ),
        Err(StoreError::StaleSnapshot { .. })
    ));
    assert!(matches!(
        store.owner_snapshot(
            &owner,
            OwnerSnapshotRequest::PeerMemberships {
                peer_id: PeerId::generate(),
                expected_inventory_revision: None,
                after_group: None,
                max_items: 1,
            }
        ),
        Err(StoreError::NotFound { kind: "peer" })
    ));
    assert!(matches!(
        store.owner_snapshot(
            &owner,
            OwnerSnapshotRequest::GroupMembers {
                group_id: GroupId::generate(),
                expected_inventory_revision: None,
                after_peer: None,
                max_items: 1,
            }
        ),
        Err(StoreError::NotFound { kind: "group" })
    ));
    let other = Store::open(support::retained_db("owner-nested-other")).unwrap();
    assert!(matches!(
        store.owner_snapshot(
            &other.trusted_owner(),
            OwnerSnapshotRequest::PeerSources {
                peer_id: bob.record.peer_id.clone(),
                expected_inventory_revision: None,
                after_source: None,
                max_items: 1,
            }
        ),
        Err(StoreError::AuthorityMismatch)
    ));
    let _ = dave;
}

#[test]
fn nested_pages_perform_bounded_work_after_large_removed_and_withdrawn_prefixes() {
    const HISTORY: i64 = 5_000;
    let path = support::retained_db("owner-nested-bounded");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let alice = store.enroll_peer(&owner, binding("alice")).unwrap();
    let bob = store.enroll_peer(&owner, binding("bob")).unwrap();
    let group = store
        .create_group(
            &owner,
            "history",
            members(&[&alice.record.peer_id, &bob.record.peer_id]),
        )
        .unwrap();
    {
        let connection = Connection::open(&path).unwrap();
        connection
            .pragma_update(None, "foreign_keys", true)
            .unwrap();
        let tx = connection.unchecked_transaction().unwrap();
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
        // Removed members sort before the active ones (leading zeros).
        tx.execute(
            "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<?1) INSERT INTO group_memberships(group_id,peer_id,added_policy_revision,removed_policy_revision) SELECT ?2,printf('p_%032x',n),1,1 FROM seq",
            params![HISTORY, group.group_id.as_str()],
        )
        .unwrap();
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
    let last_withdrawn = SourceId::parse(&format!("src_{HISTORY:032x}")).unwrap();
    let active = store
        .register_source(&owner, descriptor(&bob, "active"))
        .unwrap();

    // Group members: the active tail after a 5000-row removed prefix.
    let (page, members_work) = counted(&mut store, |store| {
        store
            .owner_snapshot(
                &owner,
                OwnerSnapshotRequest::GroupMembers {
                    group_id: group.group_id.clone(),
                    expected_inventory_revision: None,
                    after_peer: None,
                    max_items: 8,
                },
            )
            .unwrap()
    });
    let OwnerSnapshotPage::GroupMembers(page) = page else {
        panic!()
    };
    assert_eq!(page.members.len(), 2);
    // An empty tail beyond the last active member.
    let (tail, tail_work) = counted(&mut store, |store| {
        store
            .owner_snapshot(
                &owner,
                OwnerSnapshotRequest::GroupMembers {
                    group_id: group.group_id.clone(),
                    expected_inventory_revision: Some(page.revisions.inventory_revision),
                    after_peer: Some(page.members[1].clone()),
                    max_items: 8,
                },
            )
            .unwrap()
    });
    let OwnerSnapshotPage::GroupMembers(tail) = tail else {
        panic!()
    };
    assert!(tail.members.is_empty() && tail.next_after_peer.is_none());

    // Peer sources: a one-item page positioned at the end of the retained
    // history performs bounded work and still reaches every retained row.
    let (page, sources_work) = counted(&mut store, |store| {
        store
            .owner_snapshot(
                &owner,
                OwnerSnapshotRequest::PeerSources {
                    peer_id: bob.record.peer_id.clone(),
                    expected_inventory_revision: Some(page.revisions.inventory_revision),
                    after_source: Some(last_withdrawn.clone()),
                    max_items: 1,
                },
            )
            .unwrap()
    });
    let OwnerSnapshotPage::PeerSources(page) = page else {
        panic!()
    };
    assert_eq!(page.sources.len(), 1);
    assert_eq!(page.sources[0].source_id, active.source_id);
    let (count, _) = counted(&mut store, |store| {
        let mut count = 0;
        let mut after = None;
        loop {
            let OwnerSnapshotPage::PeerSources(page) = store
                .owner_snapshot(
                    &owner,
                    OwnerSnapshotRequest::PeerSources {
                        peer_id: bob.record.peer_id.clone(),
                        expected_inventory_revision: Some(page.revisions.inventory_revision),
                        after_source: after.clone(),
                        max_items: MAX_METADATA_PAGE_ITEMS,
                    },
                )
                .unwrap()
            else {
                panic!()
            };
            count += page.sources.len();
            after = page.next_after_source;
            if after.is_none() {
                break count;
            }
        }
    });
    assert_eq!(
        count as i64,
        HISTORY + 1,
        "every retained registration is pageable"
    );

    // Peer memberships for a peer whose only active membership follows a
    // large removed history in other groups.
    {
        let connection = Connection::open(&path).unwrap();
        let authority: String = connection
            .query_row("SELECT authority_id FROM authority_metadata", [], |r| {
                r.get(0)
            })
            .unwrap();
        let tx = connection.unchecked_transaction().unwrap();
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
        tx.commit().unwrap();
    }
    store = Store::open(&path).unwrap();
    let (page, memberships_work) = counted(&mut store, |store| {
        store
            .owner_snapshot(
                &owner,
                OwnerSnapshotRequest::PeerMemberships {
                    peer_id: bob.record.peer_id.clone(),
                    expected_inventory_revision: None,
                    after_group: None,
                    max_items: 8,
                },
            )
            .unwrap()
    });
    let OwnerSnapshotPage::PeerMemberships(page) = page else {
        panic!()
    };
    assert_eq!(page.memberships.len(), 1);
    assert_eq!(page.memberships[0].group_id, group.group_id);
    eprintln!(
        "group members {members_work}, empty tail {tail_work}, peer sources one-item {sources_work}, peer memberships {memberships_work} callbacks (100-opcode interval, {HISTORY}-row histories)"
    );
    for (name, work) in [
        ("group members", members_work),
        ("empty member tail", tail_work),
        ("peer sources", sources_work),
        ("peer memberships", memberships_work),
    ] {
        assert!(
            work <= 20,
            "{name} scanned retained history: {work} callbacks"
        );
    }
}

/// Traverses `page(after)` until exhaustion, asserting every returned page is
/// within `bound` and returning the concatenated keys.
fn traverse<K: Clone, P: serde::Serialize>(
    mut page: impl FnMut(Option<K>) -> P,
    keys: impl Fn(&P) -> Vec<K>,
    next: impl Fn(&P) -> Option<K>,
    bound: usize,
    near: usize,
) -> Vec<K> {
    let mut seen = Vec::new();
    let mut after = None;
    let mut first = true;
    loop {
        let current = page(after.clone());
        let bytes = serde_json::to_vec(&current).unwrap().len();
        if first {
            assert!(
                bytes > bound - near,
                "threshold not exercised: first page is {bytes} bytes"
            );
            first = false;
        }
        assert!(
            bytes <= bound,
            "final serialized page is {bytes} bytes, over {bound}"
        );
        seen.extend(keys(&current));
        after = next(&current);
        if after.is_none() {
            break seen;
        }
    }
}

#[test]
fn whoami_final_envelope_including_continuation_token_stays_within_bound() {
    const GROUPS: usize = 100;
    let path = support::retained_db("whoami-threshold");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    pad_inventory(&mut store, &owner);
    let alice = store.enroll_peer(&owner, binding("alice")).unwrap();
    let bob = store.enroll_peer(&owner, binding("bob")).unwrap();
    let mut groups: Vec<GroupRecord> = (0..GROUPS)
        .map(|index| {
            store
                .create_group(
                    &owner,
                    &format!("group-{index}"),
                    members(&[&alice.record.peer_id, &bob.record.peer_id]),
                )
                .unwrap()
        })
        .collect();
    groups.sort_by(|a, b| a.group_id.cmp(&b.group_id));
    let prefix = GROUPS - 1;
    let publish = |store: &mut Store, index: usize, status: String| {
        store
            .publish_status(
                &alice.principal,
                StatusRequest {
                    group_id: groups[index].group_id.clone(),
                    status: Some(status),
                },
            )
            .unwrap();
    };
    tune(
        &mut store,
        Tuner {
            target: MAX_METADATA_PAGE_BYTES + 8,
            fills: (0..prefix - 3)
                .map(|index| {
                    Box::new(move |store: &mut Store| {
                        publish(store, index, nul(COARSE_MAX_CHARS));
                    }) as Box<dyn FnMut(&mut Store)>
                })
                .collect(),
            coarse: vec![
                Box::new(|store: &mut Store, chars| publish(store, prefix - 3, nul(chars))),
                Box::new(|store: &mut Store, chars| publish(store, prefix - 2, nul(chars))),
            ],
            fine: Box::new(|store: &mut Store, len| publish(store, prefix - 1, "x".repeat(len))),
            measure: Box::new(|store: &mut Store| {
                let view = store
                    .whoami(
                        &alice.principal,
                        WhoAmIRequest {
                            after_group: None,
                            max_items: prefix,
                        },
                    )
                    .unwrap();
                assert_eq!(view.memberships.len(), prefix);
                assert!(view.next_after_group.is_some());
                serde_json::to_vec(&view).unwrap().len()
            }),
        },
    );
    let seen = traverse(
        |after| {
            store
                .whoami(
                    &alice.principal,
                    WhoAmIRequest {
                        after_group: after,
                        max_items: prefix,
                    },
                )
                .unwrap()
        },
        |view| {
            view.memberships
                .iter()
                .map(|m| m.group_id.clone())
                .collect()
        },
        |view| view.next_after_group.clone(),
        MAX_METADATA_PAGE_BYTES,
        6 * COARSE_MAX_CHARS + 4_096 + 512,
    );
    assert_eq!(
        seen,
        groups
            .iter()
            .map(|g| g.group_id.clone())
            .collect::<Vec<_>>()
    );
}

#[test]
fn owner_peer_page_final_envelope_including_continuation_token_stays_within_bound() {
    const PEERS: usize = 36;
    let path = support::retained_db("owner-peers-threshold");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    pad_inventory(&mut store, &owner);
    let mut peers: Vec<EnrolledPeer> = (0..PEERS)
        .map(|_| {
            store
                .enroll_peer(
                    &owner,
                    binding_with(nul(COARSE_MAX_CHARS), nul(COARSE_MAX_CHARS)),
                )
                .unwrap()
        })
        .collect();
    peers.sort_by(|a, b| a.record.peer_id.cmp(&b.record.peer_id));
    let prefix = PEERS - 1;
    let metadata = |store: &mut Store, index: usize, value: String| {
        store
            .update_peer_metadata(
                &owner,
                &peers[index].record.peer_id,
                peers[index].record.revision,
                PeerMetadataUpdate {
                    model_metadata: Some(value),
                    is_live: true,
                },
            )
            .unwrap();
    };
    let page = |store: &mut Store, after: Option<PeerId>, revision: Option<Revision>| {
        let OwnerSnapshotPage::Peers(page) = store
            .owner_snapshot(
                &owner,
                OwnerSnapshotRequest::Peers {
                    expected_inventory_revision: revision,
                    after_peer: after,
                    max_items: prefix,
                },
            )
            .unwrap()
        else {
            panic!()
        };
        page
    };
    tune(
        &mut store,
        Tuner {
            target: MAX_METADATA_PAGE_BYTES + 8,
            fills: (0..prefix - 3)
                .map(|index| {
                    Box::new(move |store: &mut Store| {
                        metadata(store, index, nul(COARSE_MAX_CHARS));
                    }) as Box<dyn FnMut(&mut Store)>
                })
                .collect(),
            coarse: vec![
                Box::new(|store: &mut Store, chars| metadata(store, prefix - 3, nul(chars))),
                Box::new(|store: &mut Store, chars| metadata(store, prefix - 2, nul(chars))),
            ],
            fine: Box::new(|store: &mut Store, len| metadata(store, prefix - 1, "x".repeat(len))),
            measure: Box::new(|store: &mut Store| {
                let current = page(store, None, None);
                assert_eq!(current.peers.len(), prefix);
                assert!(current.next_after_peer.is_some());
                serde_json::to_vec(&current).unwrap().len()
            }),
        },
    );
    let revision = store.state_revisions(&owner).unwrap().inventory_revision;
    let seen = traverse(
        |after| page(&mut store, after, Some(revision)),
        |page| {
            page.peers
                .iter()
                .map(|p| p.binding.peer_id.clone())
                .collect()
        },
        |page| page.next_after_peer.clone(),
        MAX_METADATA_PAGE_BYTES,
        3 * 6 * COARSE_MAX_CHARS + 4_096 + 512,
    );
    assert_eq!(
        seen,
        peers
            .iter()
            .map(|p| p.record.peer_id.clone())
            .collect::<Vec<_>>()
    );
}

#[test]
fn owner_peer_membership_page_final_envelope_including_continuation_token_stays_within_bound() {
    const GROUPS: usize = 100;
    let path = support::retained_db("owner-memberships-threshold");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    pad_inventory(&mut store, &owner);
    let bob = store.enroll_peer(&owner, binding("bob")).unwrap();
    let mut groups: Vec<GroupRecord> = (0..GROUPS)
        .map(|index| {
            store
                .create_group(
                    &owner,
                    &format!("group-{index}"),
                    members(&[&bob.record.peer_id]),
                )
                .unwrap()
        })
        .collect();
    groups.sort_by(|a, b| a.group_id.cmp(&b.group_id));
    let prefix = GROUPS - 1;
    let publish = |store: &mut Store, index: usize, status: String| {
        store
            .publish_status(
                &bob.principal,
                StatusRequest {
                    group_id: groups[index].group_id.clone(),
                    status: Some(status),
                },
            )
            .unwrap();
    };
    let page = |store: &mut Store, after: Option<GroupId>, revision: Option<Revision>| {
        let OwnerSnapshotPage::PeerMemberships(page) = store
            .owner_snapshot(
                &owner,
                OwnerSnapshotRequest::PeerMemberships {
                    peer_id: bob.record.peer_id.clone(),
                    expected_inventory_revision: revision,
                    after_group: after,
                    max_items: prefix,
                },
            )
            .unwrap()
        else {
            panic!()
        };
        page
    };
    tune(
        &mut store,
        Tuner {
            target: MAX_METADATA_PAGE_BYTES + 8,
            fills: (0..prefix - 3)
                .map(|index| {
                    Box::new(move |store: &mut Store| {
                        publish(store, index, nul(COARSE_MAX_CHARS));
                    }) as Box<dyn FnMut(&mut Store)>
                })
                .collect(),
            coarse: vec![
                Box::new(|store: &mut Store, chars| publish(store, prefix - 3, nul(chars))),
                Box::new(|store: &mut Store, chars| publish(store, prefix - 2, nul(chars))),
            ],
            fine: Box::new(|store: &mut Store, len| publish(store, prefix - 1, "x".repeat(len))),
            measure: Box::new(|store: &mut Store| {
                let current = page(store, None, None);
                assert_eq!(current.memberships.len(), prefix);
                assert!(current.next_after_group.is_some());
                serde_json::to_vec(&current).unwrap().len()
            }),
        },
    );
    let revision = store.state_revisions(&owner).unwrap().inventory_revision;
    let seen = traverse(
        |after| page(&mut store, after, Some(revision)),
        |page| {
            page.memberships
                .iter()
                .map(|m| m.group_id.clone())
                .collect()
        },
        |page| page.next_after_group.clone(),
        MAX_METADATA_PAGE_BYTES,
        6 * COARSE_MAX_CHARS + 4_096 + 512,
    );
    assert_eq!(
        seen,
        groups
            .iter()
            .map(|g| g.group_id.clone())
            .collect::<Vec<_>>()
    );
}

#[test]
fn owner_peer_source_page_final_envelope_including_continuation_token_stays_within_bound() {
    let path = support::retained_db("owner-sources-threshold");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    pad_inventory(&mut store, &owner);
    // Every registration carries bob's escape-heavy conversation identity.
    let bob = store
        .enroll_peer(
            &owner,
            binding_with("terminal-bob".into(), nul(COARSE_MAX_CHARS)),
        )
        .unwrap();
    // Six small active candidates; the five smallest by id become knobs.
    let mut candidates: Vec<SourceRegistration> = (0..6)
        .map(|index| {
            store
                .register_source(&owner, descriptor(&bob, &format!("knob-{index}")))
                .unwrap()
        })
        .collect();
    candidates.sort_by(|a, b| a.source_id.cmp(&b.source_id));
    let epochs = std::cell::RefCell::new(
        candidates
            .iter()
            .map(|c| (c.source_id.clone(), c.registration_epoch))
            .collect::<BTreeMap<_, _>>(),
    );
    let total = std::cell::Cell::new(candidates.len());
    let (owner_ref, bob_ref, total_ref) = (&owner, &bob, &total);
    let reestablish = |store: &mut Store, index: usize, object: String, evidence: String| {
        let source_id = candidates[index].source_id.clone();
        let expected = epochs.borrow()[&source_id];
        let updated = store
            .transition_source(
                &owner,
                SourceTransition::Reestablish {
                    source_id: source_id.clone(),
                    expected_epoch: expected,
                    descriptor: descriptor_with(&bob, "knob", object, evidence),
                },
            )
            .unwrap();
        epochs
            .borrow_mut()
            .insert(source_id, updated.registration_epoch);
    };
    let page = |store: &mut Store, after: Option<SourceId>, revision: Option<Revision>| {
        let OwnerSnapshotPage::PeerSources(page) = store
            .owner_snapshot(
                &owner,
                OwnerSnapshotRequest::PeerSources {
                    peer_id: bob.record.peer_id.clone(),
                    expected_inventory_revision: revision,
                    after_source: after,
                    max_items: total.get() - 1,
                },
            )
            .unwrap()
        else {
            panic!()
        };
        page
    };
    tune(
        &mut store,
        Tuner {
            target: MAX_METADATA_PAGE_BYTES + 8,
            fills: (0..40)
                .map(|index| {
                    Box::new(move |store: &mut Store| {
                        // A withdrawn registration with maximal escape-heavy
                        // fields stays retained and pageable.
                        let filler = store
                            .register_source(
                                owner_ref,
                                descriptor_with(
                                    bob_ref,
                                    &format!("fill-{index}"),
                                    nul(COARSE_MAX_CHARS),
                                    nul(COARSE_MAX_CHARS),
                                ),
                            )
                            .unwrap();
                        store
                            .transition_source(
                                owner_ref,
                                SourceTransition::Withdraw {
                                    source_id: filler.source_id,
                                    expected_epoch: filler.registration_epoch,
                                },
                            )
                            .unwrap();
                        total_ref.set(total_ref.get() + 1);
                    }) as Box<dyn FnMut(&mut Store)>
                })
                .collect(),
            coarse: (0..4)
                .map(|index| {
                    Box::new(move |store: &mut Store, chars| {
                        reestablish(store, index, nul(chars), "e".into());
                    }) as Box<dyn FnMut(&mut Store, usize)>
                })
                .collect(),
            fine: Box::new(|store: &mut Store, len| {
                reestablish(store, 4, "o".into(), "x".repeat(len));
            }),
            measure: Box::new(|store: &mut Store| {
                let current = page(store, None, None);
                assert_eq!(current.sources.len(), total.get() - 1);
                assert!(current.next_after_source.is_some());
                serde_json::to_vec(&current).unwrap().len()
            }),
        },
    );
    let revision = store.state_revisions(&owner).unwrap().inventory_revision;
    let seen = traverse(
        |after| page(&mut store, after, Some(revision)),
        |page| page.sources.iter().map(|s| s.source_id.clone()).collect(),
        |page| page.next_after_source.clone(),
        MAX_METADATA_PAGE_BYTES,
        3 * 6 * COARSE_MAX_CHARS + 4_096 + 512,
    );
    assert_eq!(seen.len(), total.get());
    let mut sorted = seen.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted, seen, "lossless, ordered, no duplicates");
}

#[test]
fn group_and_member_pages_are_bounded_by_items_with_pessimistic_token_sizing() {
    let path = support::retained_db("owner-groups-items");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let mut peers: Vec<PeerId> = (0..(MAX_METADATA_PAGE_ITEMS + 2))
        .map(|index| {
            store
                .enroll_peer(&owner, binding(&format!("m-{index}")))
                .unwrap()
                .record
                .peer_id
        })
        .collect();
    peers.sort();
    let mut groups: Vec<GroupId> = (0..(MAX_METADATA_PAGE_ITEMS + 2))
        .map(|index| {
            store
                .create_group(
                    &owner,
                    &nul(MAX_LABEL_BYTES)
                        .replace('\u{0}', if index % 2 == 0 { "\u{0}" } else { "\"" }),
                    peers.iter().cloned().collect(),
                )
                .unwrap()
                .group_id
        })
        .collect();
    groups.sort();
    let revision = store.state_revisions(&owner).unwrap().inventory_revision;
    let seen = traverse(
        |after| {
            let OwnerSnapshotPage::Groups(page) = store
                .owner_snapshot(
                    &owner,
                    OwnerSnapshotRequest::Groups {
                        expected_inventory_revision: Some(revision),
                        after_group: after,
                        max_items: MAX_METADATA_PAGE_ITEMS,
                    },
                )
                .unwrap()
            else {
                panic!()
            };
            page
        },
        |page| {
            page.groups
                .iter()
                .map(|g| g.group.group_id.clone())
                .collect()
        },
        |page| page.next_after_group.clone(),
        MAX_METADATA_PAGE_BYTES,
        MAX_METADATA_PAGE_BYTES,
    );
    assert_eq!(seen, groups);
    let seen = traverse(
        |after| {
            let OwnerSnapshotPage::GroupMembers(page) = store
                .owner_snapshot(
                    &owner,
                    OwnerSnapshotRequest::GroupMembers {
                        group_id: groups[0].clone(),
                        expected_inventory_revision: Some(revision),
                        after_peer: after,
                        max_items: MAX_METADATA_PAGE_ITEMS,
                    },
                )
                .unwrap()
            else {
                panic!()
            };
            page
        },
        |page| page.members.clone(),
        |page| page.next_after_peer.clone(),
        MAX_METADATA_PAGE_BYTES,
        MAX_METADATA_PAGE_BYTES,
    );
    assert_eq!(seen, peers);
}

#[test]
fn owner_message_page_final_envelope_includes_the_continuation_sequence() {
    let path = support::retained_db("owner-messages-threshold");
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let alice = store.enroll_peer(&owner, binding("alice")).unwrap();
    let bob = store.enroll_peer(&owner, binding("bob")).unwrap();
    let group = store
        .create_group(
            &owner,
            "wide",
            members(&[&alice.record.peer_id, &bob.record.peer_id]),
        )
        .unwrap();
    const FIRST: u64 = (1_u64 << 53) + 1;
    {
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "UPDATE groups SET next_sequence=?1 WHERE group_id=?2",
                params![FIRST as i64, group.group_id.as_str()],
            )
            .unwrap();
    }
    let send = |store: &mut Store, key: &str, body: String| {
        store
            .send_message(
                &alice.principal,
                SendMessageRequest {
                    group_id: group.group_id.clone(),
                    client_key: key.to_owned(),
                    recipients: members(&[&bob.record.peer_id]),
                    body,
                    topic: None,
                    reply_to: None,
                    attachments: Vec::new(),
                },
            )
            .unwrap()
    };
    let page = |store: &mut Store, after: u64, max_items: usize| {
        let OwnerSnapshotPage::Messages(page) = store
            .owner_snapshot(
                &owner,
                OwnerSnapshotRequest::Messages {
                    group_id: group.group_id.clone(),
                    after_sequence: after,
                    through_sequence: None,
                    max_items,
                },
            )
            .unwrap()
        else {
            panic!()
        };
        page
    };
    let first = send(&mut store, "m1", nul(MAX_MESSAGE_BODY_BYTES));
    assert_eq!(first.group_sequence, FIRST);
    let empty = serde_json::to_vec(&page(&mut store, FIRST, 1))
        .unwrap()
        .len();
    let one = serde_json::to_vec(&page(&mut store, FIRST - 1, 1))
        .unwrap()
        .len();
    let entry_one = one - empty;
    let entry_base = entry_one - (6 * MAX_MESSAGE_BODY_BYTES + 2);
    // Token width: `null` becomes a 16-digit sequence.
    let token_growth = FIRST.to_string().len() - "null".len();
    let with_token = one + token_growth;
    let target = MAX_MAILBOX_PAGE_BYTES + 8;
    let entry_two = target - with_token - 1;
    let body_two_serialized = entry_two - entry_base;
    let content = body_two_serialized - 2;
    let nuls = content / 6;
    let ascii = content - 6 * nuls;
    assert!(nuls + ascii <= MAX_MESSAGE_BODY_BYTES);
    let body_two = format!("{}{}", nul(nuls), "x".repeat(ascii));
    send(&mut store, "m2", body_two);
    send(&mut store, "m3", "third".into());
    // Without the token the two entries fit; with it they exceed the bound.
    assert!(one + 1 + entry_two <= MAX_MAILBOX_PAGE_BYTES);
    assert!(with_token + 1 + entry_two > MAX_MAILBOX_PAGE_BYTES);

    let mut seen = Vec::new();
    let mut after = FIRST - 1;
    let mut first_page = true;
    loop {
        let current = page(&mut store, after, 2);
        let bytes = serde_json::to_vec(&current).unwrap().len();
        assert!(
            bytes <= MAX_MAILBOX_PAGE_BYTES,
            "owner message page is {bytes} bytes"
        );
        if first_page {
            assert_eq!(
                current.messages.len(),
                1,
                "the sizer must exclude the second entry"
            );
            assert_eq!(current.next_after_sequence, Some(FIRST));
            first_page = false;
        }
        seen.extend(current.messages.iter().map(|m| m.message.group_sequence));
        match current.next_after_sequence {
            Some(next) => after = next,
            None => break,
        }
    }
    assert_eq!(seen, vec![FIRST, FIRST + 1, FIRST + 2]);
}
