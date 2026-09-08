use super::revision::{bump_delivery, bump_inventory};
use super::{now_millis, policy::read_binding, Store};
use crate::{
    error::{StoreError, ValidationError},
    model::*,
};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use std::collections::BTreeMap;

impl Store {
    /// Owner-only explicit global predecessor CAS. `policies` must contain every
    /// active membership, including paused groups, and no other group. Existing
    /// ACK/fetch/native acceptance/uncertainty stays on its historical binding.
    /// Only known-unreceived current backlog in continued groups moves. The new
    /// mailbox exposes transferred rows plus future sends, not predecessor history.
    pub fn continue_peer(
        &mut self,
        owner: &OwnerPrincipal,
        evidence: VerifiedContinuation,
        intent: &str,
        policies: BTreeMap<GroupId, Revision>,
    ) -> Result<EnrolledPeer, StoreError> {
        self.ensure_owner(owner)?;
        if intent.is_empty() {
            return Err(ValidationError::Empty {
                field: "continuation_intent",
            }
            .into());
        }
        if intent.len() > MAX_METADATA_BYTES {
            return Err(ValidationError::TooLong {
                field: "continuation_intent",
                max: MAX_METADATA_BYTES,
            }
            .into());
        }
        let old = &evidence.predecessor;
        let next = Revision::new(old.revision.get() + 1)?;
        let b = &evidence.successor;
        let successor = PeerBindingRecord {
            peer_id: old.peer_id.clone(),
            revision: next,
            launch_id: b.launch_id.clone(),
            terminal_id: b.terminal_id.clone(),
            harness: b.harness.clone(),
            conversation_id: b.conversation_id.clone(),
            model_metadata: b.model_metadata.clone(),
            process_id: b.process_id,
            process_creation_filetime: b.process_creation_filetime,
            is_live: b.is_live,
        };
        let canonical =
            serde_json::to_string(&(&successor, &policies, intent, &evidence.branch_evidence))
                .map_err(|e| ValidationError::CanonicalSerialization(e.to_string()))?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = tx
            .query_row(
                "SELECT current_binding_revision FROM peers WHERE peer_id=?1",
                [old.peer_id.as_str()],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .ok_or(StoreError::NotFound { kind: "peer" })?;
        if current != old.revision.as_sql_i64() {
            let previous=tx.query_row("SELECT successor_binding_revision,semantic_json FROM continuation_intents WHERE peer_id=?1 AND predecessor_binding_revision=?2",params![old.peer_id.as_str(),old.revision.as_sql_i64()],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?))).optional()?;
            if previous != Some((current, canonical)) || current != next.as_sql_i64() {
                return Err(StoreError::StaleBinding);
            }
            // Returning the existing result grants nothing new; all later operations
            // still check current policy and live state.
            let record = read_binding(&tx, &old.peer_id, current)?;
            tx.commit()?;
            return Ok(EnrolledPeer {
                record,
                principal: PeerPrincipal::new(self.authority_id.clone(), old.peer_id.clone(), next),
            });
        }
        let actual = read_binding(&tx, &old.peer_id, current)?;
        // Mutable model/live metadata need not match the old evidence snapshot.
        if actual.launch_id != old.launch_id
            || actual.terminal_id != old.terminal_id
            || actual.harness != old.harness
            || actual.conversation_id != old.conversation_id
            || actual.process_id != old.process_id
            || actual.process_creation_filetime != old.process_creation_filetime
        {
            return Err(StoreError::StaleBinding);
        }
        let mut stmt=tx.prepare("SELECT g.group_id,g.policy_revision FROM group_memberships gm JOIN groups g ON g.group_id=gm.group_id WHERE gm.peer_id=?1 AND gm.removed_policy_revision IS NULL ORDER BY g.group_id")?;
        let rows = stmt.query_map([old.peer_id.as_str()], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        let active = rows
            .map(|r| {
                let (group, revision) = r?;
                Ok((
                    GroupId::parse(&group)?,
                    super::policy::revision_from_sql(revision)?,
                ))
            })
            .collect::<Result<BTreeMap<_, _>, StoreError>>()?;
        drop(stmt);
        if active.keys().ne(policies.keys()) {
            return Err(StoreError::ContinuationGroups);
        }
        for (group, revision) in &active {
            let expected = policies[group];
            if *revision != expected {
                return Err(StoreError::StalePolicy {
                    expected: expected.get(),
                    actual: revision.get(),
                });
            }
        }
        let now = now_millis(&tx)?;
        tx.execute("INSERT INTO peer_bindings(peer_id,binding_revision,launch_id,terminal_id,harness,conversation_id,model_metadata_json,process_id,process_creation_filetime,live,bound_at_millis) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![old.peer_id.as_str(),next.as_sql_i64(),b.launch_id.as_str(),b.terminal_id,b.harness,b.conversation_id,b.model_metadata,i64::from(b.process_id),b.process_creation_filetime as i64,b.is_live,now])?;
        tx.execute("UPDATE peers SET current_binding_revision=?1 WHERE peer_id=?2 AND current_binding_revision=?3",params![next.as_sql_i64(),old.peer_id.as_str(),current])?;
        tx.execute(
            "INSERT INTO continuation_intents VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                old.peer_id.as_str(),
                current,
                next.as_sql_i64(),
                intent,
                evidence.branch_evidence,
                canonical,
                now
            ],
        )?;
        for (group, policy) in &policies {
            tx.execute("INSERT INTO continuations(peer_id,predecessor_binding_revision,successor_binding_revision,group_id,policy_revision,intent_reference,committed_at_millis) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![old.peer_id.as_str(),current,next.as_sql_i64(),group.as_str(),policy.as_sql_i64(),intent,now])?;
            // Preserve old generation rows; the new generation has real binding FKs.
            tx.execute("INSERT INTO delivery_generations(message_id,recipient_peer_id,binding_revision,generation) SELECT message_id,recipient_peer_id,?1,delivery_generation+1 FROM current_deliveries WHERE recipient_peer_id=?2 AND recipient_binding_revision=?3 AND group_id=?4 AND route_state='ready' AND fetched_at_millis IS NULL AND acknowledged_at_millis IS NULL AND replied_by_message_id IS NULL",params![next.as_sql_i64(),old.peer_id.as_str(),current,group.as_str()])?;
            tx.execute("UPDATE current_deliveries SET recipient_binding_revision=?1,delivery_generation=delivery_generation+1,notification_revision=notification_revision+1,last_attempt_id=NULL WHERE recipient_peer_id=?2 AND recipient_binding_revision=?3 AND group_id=?4 AND route_state='ready' AND fetched_at_millis IS NULL AND acknowledged_at_millis IS NULL AND replied_by_message_id IS NULL",params![next.as_sql_i64(),old.peer_id.as_str(),current,group.as_str()])?;
            tx.execute("UPDATE recipient_ack_order SET binding_revision=?1,generation=(SELECT delivery_generation FROM current_deliveries d WHERE d.message_id=recipient_ack_order.message_id AND d.recipient_peer_id=recipient_ack_order.recipient_peer_id) WHERE recipient_peer_id=?2 AND binding_revision=?3 AND group_id=?4 AND EXISTS(SELECT 1 FROM current_deliveries d WHERE d.message_id=recipient_ack_order.message_id AND d.recipient_peer_id=recipient_ack_order.recipient_peer_id AND d.recipient_binding_revision=?1)",params![next.as_sql_i64(),old.peer_id.as_str(),current,group.as_str()])?;
            // Successor scopes are new: no inherited proven prefix. Historical
            // predecessor watermarks remain available for reconciliation/audit.
            tx.execute("INSERT INTO binding_acknowledgement_watermarks(group_id,recipient_peer_id,binding_revision,contiguous_group_sequence,updated_at_millis) SELECT DISTINCT group_id,recipient_peer_id,binding_revision,0,?1 FROM recipient_ack_order WHERE group_id=?2 AND recipient_peer_id=?3 AND binding_revision=?4",params![now,group.as_str(),old.peer_id.as_str(),next.as_sql_i64()])?;
        }
        bump_inventory(&tx)?;
        bump_delivery(&tx)?;
        tx.commit()?;
        Ok(EnrolledPeer {
            record: successor,
            principal: PeerPrincipal::new(self.authority_id.clone(), old.peer_id.clone(), next),
        })
    }
}
