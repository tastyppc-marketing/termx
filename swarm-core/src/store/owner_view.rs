//! Owner snapshots: trusted, revision-coherent, side-effect free.
//!
//! These views are for the broker's own owner authority. They must never be
//! routed to a peer: `OwnerPeerView` carries the full binding record. Owner
//! reads never record fetch or ACK evidence and never advance any revision.

use rusqlite::{params, Transaction};

use crate::error::StoreError;
use crate::model::{
    GroupId, GroupRecord, OwnerGroupPage, OwnerGroupView, OwnerMembershipView, OwnerMessagePage,
    OwnerPeerPage, OwnerPeerView, OwnerPrincipal, OwnerSnapshotPage, OwnerSnapshotRequest, PeerId,
    Revision, StateRevisions, MAX_MAILBOX_PAGE_BYTES, MAX_METADATA_PAGE_BYTES,
};

use super::discovery::load_status;
use super::navigation::recipient_states;
use super::page_size::PageSize;
use super::policy::{read_binding, revision_from_sql};
use super::query::{message_record, message_row, page_limit, sequence_from_sql};
use super::revision::read_revisions;
use super::source::registrations_for_peer;
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

fn peers_page(
    transaction: &Transaction<'_>,
    revisions: StateRevisions,
    after_peer: Option<&PeerId>,
    max_items: usize,
) -> Result<OwnerPeerPage, StoreError> {
    let mut statement = transaction.prepare(
        "SELECT peer_id,current_binding_revision FROM peers WHERE peer_id>?1 ORDER BY peer_id LIMIT ?2",
    )?;
    let mut rows = statement.query_map(
        params![after_peer.map_or("", PeerId::as_str), page_limit(max_items)],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
    )?;
    let mut page = OwnerPeerPage {
        revisions,
        peers: Vec::new(),
        next_after_peer: None,
    };
    let mut sizing = PageSize::new(&page)?;
    let mut more_exists = false;
    for row in &mut rows {
        if page.peers.len() == max_items {
            more_exists = true;
            break;
        }
        let (peer, binding) = row?;
        let peer_id = PeerId::parse(&peer)?;
        let mut memberships = Vec::new();
        let mut membership_statement = transaction.prepare_cached(
            "SELECT group_id,added_policy_revision FROM group_memberships INDEXED BY membership_active_by_peer WHERE peer_id=?1 AND removed_policy_revision IS NULL ORDER BY group_id",
        )?;
        let membership_rows = membership_statement
            .query_map([peer_id.as_str()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (group, added) in membership_rows {
            let group_id = GroupId::parse(&group)?;
            let status = load_status(transaction, &group_id, &peer_id, binding)?;
            memberships.push(OwnerMembershipView {
                group_id,
                added_policy_revision: revision_from_sql(added)?,
                status,
            });
        }
        let view = OwnerPeerView {
            binding: read_binding(transaction, &peer_id, binding)?,
            memberships,
            sources: registrations_for_peer(transaction, &peer_id)?,
        };
        let page_bytes = sizing.with_entry(&view)?;
        if page_bytes > MAX_METADATA_PAGE_BYTES {
            if page.peers.is_empty() {
                return Err(StoreError::PageItemTooLarge);
            }
            more_exists = true;
            break;
        }
        sizing.accept(page_bytes);
        page.peers.push(view);
    }
    drop(rows);
    drop(statement);
    if more_exists {
        page.next_after_peer = page.peers.last().map(|p| p.binding.peer_id.clone());
    }
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
    let mut rows = statement.query_map(
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
    )?;
    let mut page = OwnerGroupPage {
        revisions,
        groups: Vec::new(),
        next_after_group: None,
    };
    let mut sizing = PageSize::new(&page)?;
    let mut more_exists = false;
    for row in &mut rows {
        if page.groups.len() == max_items {
            more_exists = true;
            break;
        }
        let (group, policy, label, paused, next_sequence) = row?;
        let group_id = GroupId::parse(&group)?;
        let mut member_statement = transaction.prepare_cached(
            "SELECT peer_id FROM group_memberships WHERE group_id=?1 AND removed_policy_revision IS NULL ORDER BY peer_id",
        )?;
        let members = member_statement
            .query_map([group_id.as_str()], |row| row.get::<_, String>(0))?
            .map(|row| Ok(PeerId::parse(&row?)?))
            .collect::<Result<Vec<_>, StoreError>>()?;
        let view = OwnerGroupView {
            group: GroupRecord {
                group_id,
                policy_revision: revision_from_sql(policy)?,
                label,
                paused,
            },
            high_sequence: sequence_from_sql(next_sequence - 1)?,
            members,
        };
        let page_bytes = sizing.with_entry(&view)?;
        if page_bytes > MAX_METADATA_PAGE_BYTES {
            if page.groups.is_empty() {
                return Err(StoreError::PageItemTooLarge);
            }
            more_exists = true;
            break;
        }
        sizing.accept(page_bytes);
        page.groups.push(view);
    }
    drop(rows);
    drop(statement);
    if more_exists {
        page.next_after_group = page.groups.last().map(|g| g.group.group_id.clone());
    }
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
    let mut rows = statement.query_map(
        params![
            group_id.as_str(),
            after_sequence as i64,
            snapshot_high as i64,
            page_limit(max_items)
        ],
        message_row,
    )?;
    let mut page = OwnerMessagePage {
        group_id: group_id.clone(),
        revisions,
        snapshot_high_sequence: snapshot_high,
        messages: Vec::new(),
        next_after_sequence: None,
    };
    let mut sizing = PageSize::new(&page)?;
    let mut more_exists = false;
    for row in &mut rows {
        if page.messages.len() == max_items {
            more_exists = true;
            break;
        }
        let row = row?;
        let message = message_record(transaction, &group_id, &row)?;
        let recipients = recipient_states(transaction, &message.message_id)?;
        let entry = crate::model::MessageStateEntry {
            message,
            recipients,
        };
        let page_bytes = sizing.with_entry(&entry)?;
        if page_bytes > MAX_MAILBOX_PAGE_BYTES {
            if page.messages.is_empty() {
                return Err(StoreError::PageItemTooLarge);
            }
            more_exists = true;
            break;
        }
        sizing.accept(page_bytes);
        page.messages.push(entry);
    }
    drop(rows);
    drop(statement);
    if more_exists {
        page.next_after_sequence = page.messages.last().map(|e| e.message.group_sequence);
    }
    Ok(page)
}
