//! Owner snapshots: trusted, revision-coherent, side-effect free.
//!
//! These views are for the broker's own owner authority. They must never be
//! routed to a peer: `OwnerPeerView` carries the full binding record. Owner
//! reads never record fetch or ACK evidence and never advance any revision.
//!
//! Every collection is its own bounded page keyed by an opaque identity:
//! peers, groups, one peer's memberships, one peer's registrations and one
//! group's members. No page materializes a nested collection, so the work per
//! page is bounded by `max_items` and the envelope bound rather than by the
//! size of any peer's or group's history. Continuation keys are only valid at
//! the inventory revision that produced them.

use rusqlite::{params, OptionalExtension, Transaction};

use crate::error::StoreError;
use crate::model::{
    GroupId, GroupRecord, OwnerGroupMemberPage, OwnerGroupPage, OwnerGroupView,
    OwnerMembershipView, OwnerMessagePage, OwnerPeerMembershipPage, OwnerPeerPage,
    OwnerPeerSourcePage, OwnerPeerView, OwnerPrincipal, OwnerSnapshotPage, OwnerSnapshotRequest,
    PeerId, Revision, SourceId, StateRevisions, MAX_MAILBOX_PAGE_BYTES, MAX_METADATA_PAGE_BYTES,
};

use super::discovery::load_status;
use super::navigation::recipient_states;
use super::page_size::PageSize;
use super::policy::{read_binding, revision_from_sql};
use super::query::{message_record, message_row, page_limit, sequence_from_sql};
use super::revision::read_revisions;
use super::source::registration_page;
use super::Store;

impl Store {
    pub fn state_revisions(&self, owner: &OwnerPrincipal) -> Result<StateRevisions, StoreError> {
        self.ensure_owner(owner)?;
        read_revisions(&self.connection)
    }

    pub fn owner_snapshot(
        &mut self,
        owner: &OwnerPrincipal,
        request: OwnerSnapshotRequest,
    ) -> Result<OwnerSnapshotPage, StoreError> {
        self.ensure_owner(owner)?;
        request.validate()?;
        let transaction = self.connection.transaction()?;
        let revisions = read_revisions(&transaction)?;
        let page = match request {
            OwnerSnapshotRequest::Peers {
                expected_inventory_revision,
                after_peer,
                max_items,
            } => {
                require_inventory(revisions, expected_inventory_revision)?;
                OwnerSnapshotPage::Peers(peers_page(
                    &transaction,
                    revisions,
                    after_peer.as_ref(),
                    max_items,
                )?)
            }
            OwnerSnapshotRequest::Groups {
                expected_inventory_revision,
                after_group,
                max_items,
            } => {
                require_inventory(revisions, expected_inventory_revision)?;
                OwnerSnapshotPage::Groups(groups_page(
                    &transaction,
                    revisions,
                    after_group.as_ref(),
                    max_items,
                )?)
            }
            OwnerSnapshotRequest::PeerMemberships {
                peer_id,
                expected_inventory_revision,
                after_group,
                max_items,
            } => {
                require_inventory(revisions, expected_inventory_revision)?;
                OwnerSnapshotPage::PeerMemberships(peer_memberships_page(
                    &transaction,
                    revisions,
                    peer_id,
                    after_group.as_ref(),
                    max_items,
                )?)
            }
            OwnerSnapshotRequest::PeerSources {
                peer_id,
                expected_inventory_revision,
                after_source,
                max_items,
            } => {
                require_inventory(revisions, expected_inventory_revision)?;
                OwnerSnapshotPage::PeerSources(peer_sources_page(
                    &transaction,
                    revisions,
                    peer_id,
                    after_source.as_ref(),
                    max_items,
                )?)
            }
            OwnerSnapshotRequest::GroupMembers {
                group_id,
                expected_inventory_revision,
                after_peer,
                max_items,
            } => {
                require_inventory(revisions, expected_inventory_revision)?;
                OwnerSnapshotPage::GroupMembers(group_members_page(
                    &transaction,
                    revisions,
                    group_id,
                    after_peer.as_ref(),
                    max_items,
                )?)
            }
            OwnerSnapshotRequest::Messages {
                group_id,
                after_sequence,
                through_sequence,
                max_items,
            } => OwnerSnapshotPage::Messages(messages_page(
                &transaction,
                revisions,
                group_id,
                after_sequence,
                through_sequence,
                max_items,
            )?),
        };
        transaction.commit()?;
        Ok(page)
    }
}

fn require_inventory(
    revisions: StateRevisions,
    expected: Option<Revision>,
) -> Result<(), StoreError> {
    if let Some(expected) = expected {
        if expected != revisions.inventory_revision {
            return Err(StoreError::StaleSnapshot {
                expected: expected.get(),
                actual: revisions.inventory_revision.get(),
            });
        }
    }
    Ok(())
}

fn require_peer(transaction: &Transaction<'_>, peer_id: &PeerId) -> Result<i64, StoreError> {
    transaction
        .query_row(
            "SELECT current_binding_revision FROM peers WHERE peer_id=?1",
            [peer_id.as_str()],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .ok_or(StoreError::NotFound { kind: "peer" })
}

fn require_group(transaction: &Transaction<'_>, group_id: &GroupId) -> Result<(), StoreError> {
    let exists = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM groups WHERE group_id=?1)",
        [group_id.as_str()],
        |row| row.get::<_, bool>(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(StoreError::NotFound { kind: "group" })
    }
}

/// Shared page loop: `rows` yields at most `max_items + 1` candidates in key
/// order; entries are sized pessimistically against an envelope that already
/// carries a full-width continuation key.
fn fill_page<T: serde::Serialize>(
    rows: impl Iterator<Item = Result<T, StoreError>>,
    max_items: usize,
    bound: usize,
    sizing: &mut PageSize,
    items: &mut Vec<T>,
) -> Result<bool, StoreError> {
    let mut more_exists = false;
    for row in rows {
        if items.len() == max_items {
            more_exists = true;
            break;
        }
        let entry = row?;
        let page_bytes = sizing.with_entry(&entry)?;
        if page_bytes > bound {
            if items.is_empty() {
                return Err(StoreError::PageItemTooLarge);
            }
            more_exists = true;
            break;
        }
        sizing.accept(page_bytes);
        items.push(entry);
    }
    Ok(more_exists)
}

fn peers_page(
    transaction: &Transaction<'_>,
    revisions: StateRevisions,
    after_peer: Option<&PeerId>,
    max_items: usize,
) -> Result<OwnerPeerPage, StoreError> {
    let mut statement = transaction.prepare(
        "SELECT peer_id,current_binding_revision FROM peers WHERE peer_id>?1 ORDER BY peer_id LIMIT ?2",
    )?;
    let rows = statement
        .query_map(
            params![after_peer.map_or("", PeerId::as_str), page_limit(max_items)],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )?
        .map(|row| {
            let (peer, binding) = row?;
            let peer_id = PeerId::parse(&peer)?;
            Ok(OwnerPeerView {
                binding: read_binding(transaction, &peer_id, binding)?,
            })
        });
    let mut page = OwnerPeerPage {
        revisions,
        peers: Vec::new(),
        next_after_peer: Some(PeerId::generate()),
    };
    let mut sizing = PageSize::new(&page)?;
    let more_exists = fill_page(
        rows,
        max_items,
        MAX_METADATA_PAGE_BYTES,
        &mut sizing,
        &mut page.peers,
    )?;
    page.next_after_peer = if more_exists {
        page.peers.last().map(|p| p.binding.peer_id.clone())
    } else {
        None
    };
    Ok(page)
}

fn groups_page(
    transaction: &Transaction<'_>,
    revisions: StateRevisions,
    after_group: Option<&GroupId>,
    max_items: usize,
) -> Result<OwnerGroupPage, StoreError> {
    let mut statement = transaction.prepare(
        "SELECT group_id,policy_revision,label,paused,next_sequence FROM groups WHERE group_id>?1 ORDER BY group_id LIMIT ?2",
    )?;
    let rows = statement
        .query_map(
            params![
                after_group.map_or("", GroupId::as_str),
                page_limit(max_items)
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, bool>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )?
        .map(|row| {
            let (group, policy, label, paused, next_sequence) = row?;
            Ok(OwnerGroupView {
                group: GroupRecord {
                    group_id: GroupId::parse(&group)?,
                    policy_revision: revision_from_sql(policy)?,
                    label,
                    paused,
                },
                high_sequence: sequence_from_sql(next_sequence - 1)?,
            })
        });
    let mut page = OwnerGroupPage {
        revisions,
        groups: Vec::new(),
        next_after_group: Some(GroupId::generate()),
    };
    let mut sizing = PageSize::new(&page)?;
    let more_exists = fill_page(
        rows,
        max_items,
        MAX_METADATA_PAGE_BYTES,
        &mut sizing,
        &mut page.groups,
    )?;
    page.next_after_group = if more_exists {
        page.groups.last().map(|g| g.group.group_id.clone())
    } else {
        None
    };
    Ok(page)
}

fn peer_memberships_page(
    transaction: &Transaction<'_>,
    revisions: StateRevisions,
    peer_id: PeerId,
    after_group: Option<&GroupId>,
    max_items: usize,
) -> Result<OwnerPeerMembershipPage, StoreError> {
    let binding = require_peer(transaction, &peer_id)?;
    let mut statement = transaction.prepare(
        "SELECT group_id,added_policy_revision FROM group_memberships INDEXED BY membership_active_by_peer WHERE peer_id=?1 AND removed_policy_revision IS NULL AND group_id>?2 ORDER BY group_id LIMIT ?3",
    )?;
    let rows = statement
        .query_map(
            params![
                peer_id.as_str(),
                after_group.map_or("", GroupId::as_str),
                page_limit(max_items)
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )?
        .map(|row| {
            let (group, added) = row?;
            let group_id = GroupId::parse(&group)?;
            let status = load_status(transaction, &group_id, &peer_id, binding)?;
            Ok(OwnerMembershipView {
                group_id,
                added_policy_revision: revision_from_sql(added)?,
                status,
            })
        });
    let mut page = OwnerPeerMembershipPage {
        peer_id: peer_id.clone(),
        revisions,
        memberships: Vec::new(),
        next_after_group: Some(GroupId::generate()),
    };
    let mut sizing = PageSize::new(&page)?;
    let more_exists = fill_page(
        rows,
        max_items,
        MAX_METADATA_PAGE_BYTES,
        &mut sizing,
        &mut page.memberships,
    )?;
    page.next_after_group = if more_exists {
        page.memberships.last().map(|m| m.group_id.clone())
    } else {
        None
    };
    Ok(page)
}

fn peer_sources_page(
    transaction: &Transaction<'_>,
    revisions: StateRevisions,
    peer_id: PeerId,
    after_source: Option<&SourceId>,
    max_items: usize,
) -> Result<OwnerPeerSourcePage, StoreError> {
    require_peer(transaction, &peer_id)?;
    let mut page = OwnerPeerSourcePage {
        peer_id: peer_id.clone(),
        revisions,
        sources: Vec::new(),
        next_after_source: Some(SourceId::generate()),
    };
    let mut sizing = PageSize::new(&page)?;
    let more_exists = registration_page(
        transaction,
        &peer_id,
        after_source,
        max_items,
        revisions.inventory_revision,
        |rows| {
            fill_page(
                rows,
                max_items,
                MAX_METADATA_PAGE_BYTES,
                &mut sizing,
                &mut page.sources,
            )
        },
    )?;
    page.next_after_source = if more_exists {
        page.sources.last().map(|s| s.source_id.clone())
    } else {
        None
    };
    Ok(page)
}

fn group_members_page(
    transaction: &Transaction<'_>,
    revisions: StateRevisions,
    group_id: GroupId,
    after_peer: Option<&PeerId>,
    max_items: usize,
) -> Result<OwnerGroupMemberPage, StoreError> {
    require_group(transaction, &group_id)?;
    let mut statement = transaction.prepare(
        "SELECT peer_id FROM group_memberships INDEXED BY membership_active_by_group WHERE group_id=?1 AND removed_policy_revision IS NULL AND peer_id>?2 ORDER BY peer_id LIMIT ?3",
    )?;
    let rows = statement
        .query_map(
            params![
                group_id.as_str(),
                after_peer.map_or("", PeerId::as_str),
                page_limit(max_items)
            ],
            |row| row.get::<_, String>(0),
        )?
        .map(|row| Ok(PeerId::parse(&row?)?));
    let mut page = OwnerGroupMemberPage {
        group_id: group_id.clone(),
        revisions,
        members: Vec::new(),
        next_after_peer: Some(PeerId::generate()),
    };
    let mut sizing = PageSize::new(&page)?;
    let more_exists = fill_page(
        rows,
        max_items,
        MAX_METADATA_PAGE_BYTES,
        &mut sizing,
        &mut page.members,
    )?;
    page.next_after_peer = if more_exists {
        page.members.last().cloned()
    } else {
        None
    };
    Ok(page)
}

fn messages_page(
    transaction: &Transaction<'_>,
    revisions: StateRevisions,
    group_id: GroupId,
    after_sequence: u64,
    through_sequence: Option<u64>,
    max_items: usize,
) -> Result<OwnerMessagePage, StoreError> {
    let next_sequence = transaction
        .query_row(
            "SELECT next_sequence FROM groups WHERE group_id=?1",
            [group_id.as_str()],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => StoreError::NotFound { kind: "group" },
            other => StoreError::Sqlite(other),
        })?;
    let current_high = sequence_from_sql(next_sequence - 1)?;
    let snapshot_high = match through_sequence {
        Some(through) if through > current_high => {
            return Err(StoreError::InvalidPosition {
                position: through,
                snapshot_high: current_high,
            })
        }
        Some(through) => through,
        None => current_high,
    };
    if after_sequence > snapshot_high {
        return Err(StoreError::InvalidPosition {
            position: after_sequence,
            snapshot_high,
        });
    }
    let mut statement = transaction.prepare(
        "SELECT m.message_id,m.group_sequence,m.sender_peer_id,m.sender_binding_revision,m.client_key,m.body,m.topic,m.reply_to_message_id FROM messages m INDEXED BY messages_by_group_sequence WHERE m.group_id=?1 AND m.group_sequence>?2 AND m.group_sequence<=?3 ORDER BY m.group_sequence LIMIT ?4",
    )?;
    let rows = statement
        .query_map(
            params![
                group_id.as_str(),
                after_sequence as i64,
                snapshot_high as i64,
                page_limit(max_items)
            ],
            message_row,
        )?
        .map(|row| {
            let row = row?;
            let message = message_record(transaction, &group_id, &row)?;
            let recipients = recipient_states(transaction, &message.message_id)?;
            Ok(crate::model::MessageStateEntry {
                message,
                recipients,
            })
        });
    let mut page = OwnerMessagePage {
        group_id: group_id.clone(),
        revisions,
        snapshot_high_sequence: snapshot_high,
        messages: Vec::new(),
        // Widest possible continuation sequence for pessimistic sizing.
        next_after_sequence: Some(i64::MAX as u64),
    };
    let mut sizing = PageSize::new(&page)?;
    let more_exists = fill_page(
        rows,
        max_items,
        MAX_MAILBOX_PAGE_BYTES,
        &mut sizing,
        &mut page.messages,
    )?;
    page.next_after_sequence = if more_exists {
        page.messages.last().map(|e| e.message.group_sequence)
    } else {
        None
    };
    Ok(page)
}
