//! Bounded self and peer discovery.
//!
//! `whoami` is the only operation that resolves a principal without a group:
//! it authenticates the exact current binding and pages the caller's own
//! current memberships. Everything else still names one explicit group and
//! passes the full per-group authorization.

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

use crate::error::StoreError;
use crate::model::{
    GroupId, LaunchId, ListPeersRequest, MembershipAvailability, MembershipView, PeerId, PeerPage,
    PeerPrincipal, PeerView, SelfView, StatusRecord, StatusRequest, WhoAmIRequest,
    MAX_METADATA_PAGE_BYTES,
};

use super::page_size::PageSize;
use super::policy::revision_from_sql;
use super::query::page_limit;
use super::revision::{bump_inventory, read_revisions};
use super::source::active_source_summaries;
use super::{authenticate_self, authorize_peer, now_millis, Store};

impl Store {
    /// Bootstrap self view for an authenticated current binding. Offline
    /// bindings still resolve themselves; superseded bindings never do. The
    /// view grants no content access and reads no group content.
    pub fn whoami(
        &mut self,
        principal: &PeerPrincipal,
        request: WhoAmIRequest,
    ) -> Result<SelfView, StoreError> {
        request.validate()?;
        let authority_id = self.authority_id.clone();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let authenticated = authenticate_self(&transaction, &authority_id, principal)?;
        let binding = transaction.query_row(
            "SELECT launch_id,harness,model_metadata_json FROM peer_bindings WHERE peer_id=?1 AND binding_revision=?2",
            params![principal.peer_id.as_str(), principal.binding_revision.as_sql_i64()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )?;
        let after = request.after_group.as_ref().map_or("", GroupId::as_str);
        let mut statement = transaction.prepare(
            "SELECT g.group_id,g.label,g.policy_revision,g.paused,gm.added_policy_revision FROM group_memberships gm INDEXED BY membership_active_by_peer JOIN groups g ON g.group_id=gm.group_id WHERE gm.peer_id=?1 AND gm.removed_policy_revision IS NULL AND gm.group_id>?2 ORDER BY gm.group_id LIMIT ?3",
        )?;
        let mut rows = statement.query_map(
            params![
                principal.peer_id.as_str(),
                after,
                page_limit(request.max_items)
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, bool>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )?;
        let revisions = read_revisions(&transaction)?;
        let mut view = SelfView {
            peer_id: principal.peer_id.clone(),
            binding_revision: principal.binding_revision,
            launch_id: LaunchId::parse(&binding.0)?,
            harness: binding.1,
            model_metadata: binding.2,
            is_live: authenticated.live,
            memberships: Vec::new(),
            next_after_group: None,
            inventory_revision: revisions.inventory_revision,
            run_revision: revisions.run_revision,
        };
        let mut sizing = PageSize::new(&view)?;
        let mut more_exists = false;
        for row in &mut rows {
            if view.memberships.len() == request.max_items {
                more_exists = true;
                break;
            }
            let (group, label, policy, paused, added) = row?;
            let group_id = GroupId::parse(&group)?;
            let status = load_status(
                &transaction,
                &group_id,
                &principal.peer_id,
                principal.binding_revision.as_sql_i64(),
            )?;
            let membership = MembershipView {
                group_id,
                label,
                policy_revision: revision_from_sql(policy)?,
                paused,
                added_policy_revision: revision_from_sql(added)?,
                availability: if !authenticated.live {
                    MembershipAvailability::BindingOffline
                } else if paused {
                    MembershipAvailability::Paused
                } else {
                    MembershipAvailability::Available
                },
                status,
            };
            let page_bytes = sizing.with_entry(&membership)?;
            if page_bytes > MAX_METADATA_PAGE_BYTES {
                if view.memberships.is_empty() {
                    return Err(StoreError::PageItemTooLarge);
                }
                more_exists = true;
                break;
            }
            sizing.accept(page_bytes);
            view.memberships.push(membership);
        }
        drop(rows);
        drop(statement);
        if more_exists {
            view.next_after_group = view.memberships.last().map(|m| m.group_id.clone());
        }
        transaction.commit()?;
        Ok(view)
    }

    /// Public projection of one explicit group's active members. Native
    /// binding details, resolver keys and principals are never included.
    pub fn list_peers(
        &mut self,
        principal: &PeerPrincipal,
        request: ListPeersRequest,
    ) -> Result<PeerPage, StoreError> {
        request.validate()?;
        let authority_id = self.authority_id.clone();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let authorized = authorize_peer(&transaction, &authority_id, principal, &request.group_id)?;
        let after = request.after_peer.as_ref().map_or("", PeerId::as_str);
        let mut statement = transaction.prepare(
            "SELECT gm.peer_id,gm.added_policy_revision,p.current_binding_revision,b.launch_id,b.harness,b.model_metadata_json,b.live FROM group_memberships gm JOIN peers p ON p.peer_id=gm.peer_id JOIN peer_bindings b ON b.peer_id=p.peer_id AND b.binding_revision=p.current_binding_revision WHERE gm.group_id=?1 AND gm.removed_policy_revision IS NULL AND gm.peer_id>?2 ORDER BY gm.peer_id LIMIT ?3",
        )?;
        let mut rows = statement.query_map(
            params![
                request.group_id.as_str(),
                after,
                page_limit(request.max_items)
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, bool>(6)?,
                ))
            },
        )?;
        let mut page = PeerPage {
            group_id: request.group_id.clone(),
            policy_revision: authorized.policy_revision,
            inventory_revision: read_revisions(&transaction)?.inventory_revision,
            peers: Vec::new(),
            next_after_peer: None,
        };
        let mut sizing = PageSize::new(&page)?;
        let mut more_exists = false;
        for row in &mut rows {
            if page.peers.len() == request.max_items {
                more_exists = true;
                break;
            }
            let (peer, added, binding, launch, harness, metadata, live) = row?;
            let peer_id = PeerId::parse(&peer)?;
            let status = load_status(&transaction, &request.group_id, &peer_id, binding)?;
            let sources = active_source_summaries(&transaction, &peer_id, binding)?;
            let view = PeerView {
                peer_id,
                binding_revision: revision_from_sql(binding)?,
                launch_id: LaunchId::parse(&launch)?,
                harness,
                model_metadata: metadata,
                is_live: live,
                added_policy_revision: revision_from_sql(added)?,
                status,
                sources,
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
            page.next_after_peer = page.peers.last().map(|p| p.peer_id.clone());
        }
        transaction.commit()?;
        Ok(page)
    }

    /// Caller-owned status text scoped to one explicit group and the caller's
    /// current binding. `None` clears it. Statuses are inventory, not content.
    pub fn publish_status(
        &mut self,
        principal: &PeerPrincipal,
        request: StatusRequest,
    ) -> Result<StatusRecord, StoreError> {
        request.validate()?;
        let authority_id = self.authority_id.clone();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let authorized = authorize_peer(&transaction, &authority_id, principal, &request.group_id)?;
        let now = now_millis(&transaction)?;
        let revision: i64 = transaction.query_row(
            "INSERT INTO peer_statuses(group_id,peer_id,membership_policy_revision,binding_revision,status_text,status_revision,updated_at_millis) VALUES (?1,?2,?3,?4,?5,1,?6) ON CONFLICT(group_id,peer_id) DO UPDATE SET membership_policy_revision=excluded.membership_policy_revision,binding_revision=excluded.binding_revision,status_text=excluded.status_text,status_revision=peer_statuses.status_revision+1,updated_at_millis=excluded.updated_at_millis RETURNING status_revision",
            params![
                request.group_id.as_str(),
                principal.peer_id.as_str(),
                authorized.policy_revision.as_sql_i64(),
                principal.binding_revision.as_sql_i64(),
                request.status,
                now
            ],
            |row| row.get(0),
        )?;
        bump_inventory(&transaction)?;
        transaction.commit()?;
        Ok(StatusRecord {
            group_id: request.group_id,
            peer_id: principal.peer_id.clone(),
            binding_revision: principal.binding_revision,
            status: request.status,
            status_revision: revision_from_sql(revision)?,
            updated_at_millis: now,
        })
    }
}

/// A status belongs to the binding that published it; a superseded binding's
/// status is retained but no longer projected as current.
pub(super) fn load_status(
    transaction: &Transaction<'_>,
    group_id: &GroupId,
    peer_id: &PeerId,
    current_binding: i64,
) -> Result<Option<StatusRecord>, StoreError> {
    let row = transaction
        .query_row(
            "SELECT status_text,status_revision,updated_at_millis FROM peer_statuses WHERE group_id=?1 AND peer_id=?2 AND binding_revision=?3",
            params![group_id.as_str(), peer_id.as_str(), current_binding],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    row.map(|(status, revision, updated)| {
        Ok(StatusRecord {
            group_id: group_id.clone(),
            peer_id: peer_id.clone(),
            binding_revision: revision_from_sql(current_binding)?,
            status,
            status_revision: revision_from_sql(revision)?,
            updated_at_millis: updated,
        })
    })
    .transpose()
}
