use super::{
    authorize_peer, now_millis,
    policy::{read_binding, revision_from_sql},
    revision::bump_delivery,
    Store,
};
use crate::{
    error::{StoreError, ValidationError},
    model::*,
};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

const DELIVERY_CANDIDATES_SQL: &str = "SELECT message_id,delivery_generation,notification_revision,last_attempt_id FROM current_deliveries INDEXED BY current_delivery_candidates WHERE group_id=?1 AND recipient_peer_id=?2 AND recipient_binding_revision=?3 AND route_state='ready' AND fetched_at_millis IS NULL AND acknowledged_at_millis IS NULL AND replied_by_message_id IS NULL ORDER BY group_sequence LIMIT ?4";

impl Store {
    /// Explicit trusted broker-run transition. The caller MUST establish exclusive
    /// run ownership and prior process exit before invoking this, and invoke it
    /// before dispatch. The core verifies neither Windows ownership nor exit.
    /// Opening a connection alone never changes attempt uncertainty.
    pub fn recover_trusted_new_run(&mut self, owner: &OwnerPrincipal) -> Result<usize, StoreError> {
        self.ensure_owner(owner)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_millis(&tx)?;
        let next: i64 = tx.query_row(
            "SELECT COALESCE(MAX(run_revision),0)+1 FROM broker_runs",
            [],
            |r| r.get(0),
        )?;
        let revision = revision_from_sql(next)?;
        tx.execute("INSERT INTO broker_runs VALUES (?1,?2)", params![next, now])?;
        tx.execute("UPDATE current_deliveries SET route_state='uncertain' WHERE last_attempt_id IN (SELECT attempt_id FROM delivery_attempts WHERE completed_at_millis IS NULL)",[])?;
        let count=tx.execute("UPDATE delivery_attempts SET outcome='uncertain',completed_at_millis=?1,recovered_uncertain_at_millis=COALESCE(recovered_uncertain_at_millis,?1) WHERE completed_at_millis IS NULL",[now])?;
        let notice_count=tx.execute("UPDATE notice_attempts SET outcome='uncertain',completed_at_millis=?1,recovered_uncertain_at_millis=COALESCE(recovered_uncertain_at_millis,?1) WHERE completed_at_millis IS NULL",[now])?;
        bump_delivery(&tx)?;
        tx.commit()?;
        self.run_revision = Some(revision);
        self.last_notice_recovered = notice_count;
        Ok(count)
    }

    /// Bounded ascending work for one exact live authorized binding. A scheduler
    /// must visit recipient scopes fairly; held/offline scopes return no work.
    pub fn delivery_candidates(
        &mut self,
        owner: &OwnerPrincipal,
        group: &GroupId,
        peer: &PeerId,
        binding: Revision,
        limit: usize,
    ) -> Result<Vec<DeliveryCandidate>, StoreError> {
        self.ensure_owner(owner)?;
        if limit == 0 {
            return Err(ValidationError::Empty {
                field: "candidate_limit",
            }
            .into());
        }
        if limit > MAX_DELIVERY_CANDIDATES {
            return Err(ValidationError::TooLarge {
                field: "candidate_limit",
                max: MAX_DELIVERY_CANDIDATES,
            }
            .into());
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_run(&tx, self.run_revision)?;
        let principal = PeerPrincipal::new(self.authority_id.clone(), peer.clone(), binding);
        let auth = match authorize_peer(&tx, &self.authority_id, &principal, group) {
            Ok(auth) => auth,
            Err(
                StoreError::BindingOffline
                | StoreError::GroupPaused
                | StoreError::Unauthorized { .. },
            ) => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut stmt = tx.prepare(DELIVERY_CANDIDATES_SQL)?;
        let rows = stmt.query_map(
            params![
                group.as_str(),
                peer.as_str(),
                binding.as_sql_i64(),
                limit as i64
            ],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            },
        )?;
        let candidates = rows
            .map(|row| {
                let (message, generation, notification, last) = row?;
                Ok(DeliveryCandidate {
                    authority_id: self.authority_id.clone(),
                    group_id: group.clone(),
                    policy_revision: auth.policy_revision,
                    message_id: MessageId::parse(&message)?,
                    recipient_peer_id: peer.clone(),
                    binding_revision: binding,
                    generation: revision_from_sql(generation)?,
                    notification_revision: revision_from_sql(notification)?,
                    last_attempt_id: last.as_deref().map(DeliveryAttemptId::parse).transpose()?,
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        drop(stmt);
        tx.commit()?;
        Ok(candidates)
    }

    /// Commits the unique ticket before returning it to the adapter boundary.
    pub fn begin_delivery(
        &mut self,
        owner: &OwnerPrincipal,
        candidate: &DeliveryCandidate,
    ) -> Result<DeliveryTicket, StoreError> {
        self.ensure_owner(owner)?;
        if candidate.authority_id != self.authority_id {
            return Err(StoreError::AuthorityMismatch);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let run = require_run(&tx, self.run_revision)?;
        let principal = PeerPrincipal::new(
            self.authority_id.clone(),
            candidate.recipient_peer_id.clone(),
            candidate.binding_revision,
        );
        let auth = authorize_peer(&tx, &self.authority_id, &principal, &candidate.group_id)?;
        if auth.policy_revision != candidate.policy_revision {
            return Err(StoreError::StalePolicy {
                expected: candidate.policy_revision.get(),
                actual: auth.policy_revision.get(),
            });
        }
        let eligible=tx.query_row("SELECT EXISTS(SELECT 1 FROM current_deliveries WHERE message_id=?1 AND recipient_peer_id=?2 AND recipient_binding_revision=?3 AND delivery_generation=?4 AND notification_revision=?5 AND last_attempt_id IS ?6 AND route_state='ready' AND fetched_at_millis IS NULL AND acknowledged_at_millis IS NULL AND replied_by_message_id IS NULL)",params![candidate.message_id.as_str(),candidate.recipient_peer_id.as_str(),candidate.binding_revision.as_sql_i64(),candidate.generation.as_sql_i64(),candidate.notification_revision.as_sql_i64(),candidate.last_attempt_id.as_ref().map(DeliveryAttemptId::as_str)],|r|r.get::<_,bool>(0))?;
        if !eligible {
            return Err(StoreError::StaleCandidate);
        }
        let binding = read_binding(
            &tx,
            &candidate.recipient_peer_id,
            candidate.binding_revision.as_sql_i64(),
        )?;
        let number:i64=tx.query_row("SELECT COALESCE(MAX(attempt_number),0)+1 FROM delivery_attempts WHERE message_id=?1 AND recipient_peer_id=?2 AND binding_revision=?3 AND generation=?4",params![candidate.message_id.as_str(),candidate.recipient_peer_id.as_str(),candidate.binding_revision.as_sql_i64(),candidate.generation.as_sql_i64()],|r|r.get(0))?;
        let attempt_id = DeliveryAttemptId::generate();
        let now = now_millis(&tx)?;
        tx.execute("INSERT INTO delivery_attempts(attempt_id,message_id,recipient_peer_id,binding_revision,generation,attempt_number,started_at_millis) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![attempt_id.as_str(),candidate.message_id.as_str(),candidate.recipient_peer_id.as_str(),candidate.binding_revision.as_sql_i64(),candidate.generation.as_sql_i64(),number,now])?;
        let snapshot = serde_json::to_string(&binding)
            .map_err(|e| ValidationError::CanonicalSerialization(e.to_string()))?;
        tx.execute(
            "INSERT INTO delivery_tickets VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                attempt_id.as_str(),
                self.authority_id.as_str(),
                candidate.group_id.as_str(),
                candidate.policy_revision.as_sql_i64(),
                candidate.notification_revision.as_sql_i64(),
                run.as_sql_i64(),
                snapshot
            ],
        )?;
        tx.execute("UPDATE current_deliveries SET route_state='in_flight',last_attempt_id=?1 WHERE message_id=?2 AND recipient_peer_id=?3",params![attempt_id.as_str(),candidate.message_id.as_str(),candidate.recipient_peer_id.as_str()])?;
        bump_delivery(&tx)?;
        tx.commit()?;
        Ok(DeliveryTicket {
            attempt_id,
            candidate: candidate.clone(),
            recipient_binding: binding,
            attempt_number: number as u64,
            run_revision: run,
        })
    }

    pub fn delivery_attempt(
        &self,
        owner: &OwnerPrincipal,
        id: &DeliveryAttemptId,
    ) -> Result<AttemptStatus, StoreError> {
        self.ensure_owner(owner)?;
        load_status(&self.connection, id)
    }

    /// Reconciles exactly one historical attempt, even after pause or continuation.
    /// Repeated definitive outcomes are idempotent; conflicting outcomes fail.
    /// A recovered uncertainty can be resolved by trusted matching-attempt evidence.
    pub fn complete_delivery(
        &mut self,
        owner: &OwnerPrincipal,
        id: &DeliveryAttemptId,
        outcome: AttemptOutcome,
    ) -> Result<AttemptStatus, StoreError> {
        self.ensure_owner(owner)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = load_status(&tx, id)?;
        if previous.outcome == Some(outcome) {
            tx.commit()?;
            return Ok(previous);
        }
        if previous.outcome.is_some() && previous.outcome != Some(AttemptOutcome::Uncertain) {
            return Err(StoreError::AttemptConflict);
        }
        let now = now_millis(&tx)?;
        tx.execute(
            "UPDATE delivery_attempts SET outcome=?1,completed_at_millis=?2 WHERE attempt_id=?3",
            params![outcome.as_str(), now, id.as_str()],
        )?;
        // A delayed native observation can predate a later verified cancellation.
        // Retain that outcome above, but let the independent reconciliation proof
        // continue to govern eligibility for this exact current attempt.
        let state = if outcome == AttemptOutcome::KnownNotSubmitted
            || previous.reconciled_not_submitted_at_millis.is_some()
        {
            "ready"
        } else {
            outcome.as_str()
        };
        // The latest-attempt AND exact-generation match prevents historical completion
        // from changing a transferred row or a later retry. ACK/fetch evidence is untouched.
        tx.execute("UPDATE current_deliveries SET route_state=?1 WHERE last_attempt_id=?2 AND EXISTS(SELECT 1 FROM delivery_attempts a WHERE a.attempt_id=?2 AND a.message_id=current_deliveries.message_id AND a.recipient_peer_id=current_deliveries.recipient_peer_id AND a.binding_revision=current_deliveries.recipient_binding_revision AND a.generation=current_deliveries.delivery_generation)",params![state,id.as_str()])?;
        let result = load_status(&tx, id)?;
        bump_delivery(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    /// Records trusted, attempt-specific proof independently of prior native
    /// evidence. Reconciliation never reactivates a successor or later attempt.
    pub fn reconcile_not_submitted(
        &mut self,
        owner: &OwnerPrincipal,
        evidence: VerifiedNotSubmitted,
    ) -> Result<(), StoreError> {
        self.ensure_owner(owner)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let status = load_status(&tx, &evidence.attempt_id)?;
        let previous=tx.query_row("SELECT evidence_reference FROM attempt_not_submitted_reconciliations WHERE attempt_id=?1",[evidence.attempt_id.as_str()],|r|r.get::<_,String>(0)).optional()?;
        if let Some(previous) = previous {
            if previous != evidence.evidence_reference {
                return Err(StoreError::AttemptConflict);
            }
            tx.commit()?;
            return Ok(());
        }
        if !matches!(
            status.outcome,
            Some(AttemptOutcome::Held | AttemptOutcome::Uncertain)
        ) {
            return Err(StoreError::AttemptConflict);
        }
        let now = now_millis(&tx)?;
        tx.execute(
            "INSERT INTO attempt_not_submitted_reconciliations VALUES(?1,?2,?3)",
            params![
                evidence.attempt_id.as_str(),
                evidence.evidence_reference,
                now
            ],
        )?;
        tx.execute("UPDATE current_deliveries SET route_state='ready' WHERE last_attempt_id=?1 AND route_state IN ('held','uncertain') AND EXISTS(SELECT 1 FROM delivery_attempts a WHERE a.attempt_id=?1 AND a.message_id=current_deliveries.message_id AND a.recipient_peer_id=current_deliveries.recipient_peer_id AND a.binding_revision=current_deliveries.recipient_binding_revision AND a.generation=current_deliveries.delivery_generation)",[evidence.attempt_id.as_str()])?;
        bump_delivery(&tx)?;
        tx.commit()?;
        Ok(())
    }
}
fn require_run(tx: &Transaction<'_>, expected: Option<Revision>) -> Result<Revision, StoreError> {
    let expected = expected.ok_or(StoreError::RecoveryRequired)?;
    let current: Option<i64> =
        tx.query_row("SELECT MAX(run_revision) FROM broker_runs", [], |r| {
            r.get(0)
        })?;
    if current != Some(expected.as_sql_i64()) {
        return Err(StoreError::RecoveryRequired);
    }
    Ok(expected)
}
fn load_status(
    connection: &rusqlite::Connection,
    id: &DeliveryAttemptId,
) -> Result<AttemptStatus, StoreError> {
    let row=connection.query_row("SELECT outcome,completed_at_millis,recovered_uncertain_at_millis,(SELECT reconciled_at_millis FROM attempt_not_submitted_reconciliations r WHERE r.attempt_id=delivery_attempts.attempt_id) FROM delivery_attempts WHERE attempt_id=?1",[id.as_str()],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<i64>>(1)?,r.get::<_,Option<i64>>(2)?,r.get::<_,Option<i64>>(3)?))).optional()?.ok_or(StoreError::NotFound{kind:"delivery attempt"})?;
    Ok(AttemptStatus {
        attempt_id: id.clone(),
        outcome: row.0.as_deref().map(AttemptOutcome::from_stored),
        completed_at_millis: row.1,
        recovered_uncertain_at_millis: row.2,
        reconciled_not_submitted_at_millis: row.3,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn path(name: &str) -> std::path::PathBuf {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../retired/test-artifacts/swarm-core")
            .join(format!("{name}-{}", LaunchId::generate().as_str()));
        std::fs::create_dir_all(&path).unwrap();
        path.join("swarm.sqlite")
    }
    fn binding(name: &str) -> VerifiedBinding {
        VerifiedBinding::trusted(
            LaunchId::generate().as_str().into(),
            name.into(),
            "codex".into(),
            name.into(),
            None,
            100,
            1000,
            true,
        )
        .unwrap()
    }
    #[test]
    fn rollback_before_commit_and_reopen_after_commit_preserve_transaction_boundaries() {
        let path = path("lifecycle-rollback");
        let mut store = Store::open(&path).unwrap();
        let owner = store.trusted_owner();
        let alice = store.enroll_peer(&owner, binding("alice")).unwrap();
        let bob = store.enroll_peer(&owner, binding("bob")).unwrap();
        let group = store
            .create_group(
                &owner,
                "pair",
                [alice.record.peer_id.clone(), bob.record.peer_id.clone()].into(),
            )
            .unwrap();
        store.recover_trusted_new_run(&owner).unwrap();
        let request = SendMessageRequest {
            group_id: group.group_id.clone(),
            client_key: "one".into(),
            recipients: [bob.record.peer_id.clone()].into(),
            body: "persist".into(),
            topic: None,
            reply_to: None,
            attachments: Vec::new(),
        };
        store.connection.commit_hook(Some(|| true)).unwrap();
        assert!(store
            .send_message(&alice.principal, request.clone())
            .is_err());
        store.connection.commit_hook(None::<fn() -> bool>).unwrap();
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM messages", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        let saved = store
            .send_message(&alice.principal, request.clone())
            .unwrap();
        assert_eq!(saved.group_sequence, 1);
        let candidate = store
            .delivery_candidates(
                &owner,
                &group.group_id,
                &bob.record.peer_id,
                bob.record.revision,
                1,
            )
            .unwrap()
            .remove(0);
        store.connection.commit_hook(Some(|| true)).unwrap();
        assert!(store.begin_delivery(&owner, &candidate).is_err());
        store.connection.commit_hook(None::<fn() -> bool>).unwrap();
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM delivery_attempts", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM delivery_tickets", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let next = binding("bob");
        let evidence =
            VerifiedContinuation::trusted(&bob.record, next, "same-branch".into()).unwrap();
        store.connection.commit_hook(Some(|| true)).unwrap();
        assert!(store
            .continue_peer(
                &owner,
                evidence,
                "intent",
                [(group.group_id.clone(), group.policy_revision)].into()
            )
            .is_err());
        store.connection.commit_hook(None::<fn() -> bool>).unwrap();
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM continuation_intents", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM peer_bindings", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM delivery_generations", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let ticket = store.begin_delivery(&owner, &candidate).unwrap();
        drop(store);
        let mut reopened = Store::open(&path).unwrap();
        assert_eq!(
            reopened.send_message(&alice.principal, request).unwrap(),
            saved
        );
        assert_eq!(
            reopened
                .delivery_attempt(&owner, ticket.attempt_id())
                .unwrap()
                .outcome,
            None
        );
        assert_eq!(reopened.recover_trusted_new_run(&owner).unwrap(), 1);
        assert!(reopened
            .delivery_candidates(
                &owner,
                &group.group_id,
                &bob.record.peer_id,
                bob.record.revision,
                1
            )
            .unwrap()
            .is_empty());
        assert_eq!(reopened.inspect().unwrap().synchronous, "FULL");
        assert_eq!(reopened.inspect().unwrap().journal_mode, "wal");
    }

    #[test]
    fn candidate_seek_skips_large_ineligible_history_with_bounded_indexed_work() {
        let mut store = Store::open(path("candidate-index")).unwrap();
        let owner = store.trusted_owner();
        let alice = store.enroll_peer(&owner, binding("alice")).unwrap();
        let bob = store.enroll_peer(&owner, binding("bob")).unwrap();
        let group = store
            .create_group(
                &owner,
                "pair",
                [alice.record.peer_id.clone(), bob.record.peer_id.clone()].into(),
            )
            .unwrap();
        store.recover_trusted_new_run(&owner).unwrap();
        let tx = store.connection.transaction().unwrap();
        tx.execute("WITH RECURSIVE seq(n) AS(VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<5001) INSERT INTO messages(message_id,group_id,group_sequence,sender_peer_id,sender_binding_revision,client_key,semantic_payload_json,body,committed_at_millis) SELECT printf('m_%032x',n),?1,n,?2,1,printf('key-%d',n),'{}','x',1 FROM seq",params![group.group_id.as_str(),alice.record.peer_id.as_str()]).unwrap();
        tx.execute("INSERT INTO recipient_deliveries(message_id,recipient_peer_id,recipient_binding_revision,saved_at_millis) SELECT message_id,?1,1,1 FROM messages",[bob.record.peer_id.as_str()]).unwrap();
        tx.execute(
            "UPDATE current_deliveries SET route_state='native_queued' WHERE group_sequence<=5000",
            [],
        )
        .unwrap();
        tx.commit().unwrap();
        const ORIGINAL_UNPINNED_SQL: &str = "SELECT message_id,delivery_generation,notification_revision,last_attempt_id FROM current_deliveries WHERE group_id=?1 AND recipient_peer_id=?2 AND recipient_binding_revision=?3 AND route_state='ready' AND fetched_at_millis IS NULL AND acknowledged_at_millis IS NULL AND replied_by_message_id IS NULL ORDER BY group_sequence LIMIT ?4";
        let explain = |sql: &str| {
            let mut statement = store
                .connection
                .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                .unwrap();
            statement
                .query_map(
                    params![
                        group.group_id.as_str(),
                        bob.record.peer_id.as_str(),
                        bob.record.revision.as_sql_i64(),
                        1
                    ],
                    |row| row.get::<_, String>(3),
                )
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        let original_plan = explain(ORIGINAL_UNPINNED_SQL);
        let pinned_plan = explain(DELIVERY_CANDIDATES_SQL);
        eprintln!("original BODY candidate SQL: {ORIGINAL_UNPINNED_SQL}");
        eprintln!("original BODY candidate plan after schema 10: {original_plan:?}");
        eprintln!("pinned BODY candidate SQL: {DELIVERY_CANDIDATES_SQL}");
        eprintln!("pinned BODY candidate plan after schema 10: {pinned_plan:?}");
        assert!(
            pinned_plan
                .iter()
                .any(|detail| detail.contains("current_delivery_candidates")),
            "BODY candidate query did not use its exact eligible-row index: {pinned_plan:?}"
        );
        assert!(
            pinned_plan
                .iter()
                .all(|detail| !detail.contains("TEMP B-TREE")),
            "BODY candidate query introduced temporary ordering: {pinned_plan:?}"
        );
        let count = Arc::new(AtomicUsize::new(0));
        let hook = count.clone();
        store
            .connection
            .progress_handler(
                100,
                Some(move || {
                    hook.fetch_add(1, Ordering::Relaxed);
                    false
                }),
            )
            .unwrap();
        let work = store
            .delivery_candidates(
                &owner,
                &group.group_id,
                &bob.record.peer_id,
                bob.record.revision,
                1,
            )
            .unwrap();
        store
            .connection
            .progress_handler(0, None::<fn() -> bool>)
            .unwrap();
        assert_eq!(work.len(), 1);
        assert_eq!(
            work[0].message_id().as_str(),
            "m_00000000000000000000000000001389"
        );
        let callbacks = count.load(Ordering::Relaxed);
        eprintln!("candidate seek triggered {callbacks} callbacks at 100 SQLite VM opcodes across 5000 ineligible rows");
        assert!(
            callbacks <= 10,
            "candidate query scanned retained ineligible history: {callbacks} callbacks"
        );
        assert!(store
            .delivery_candidates(
                &owner,
                &group.group_id,
                &bob.record.peer_id,
                bob.record.revision,
                0
            )
            .is_err());
        assert!(store
            .delivery_candidates(
                &owner,
                &group.group_id,
                &bob.record.peer_id,
                bob.record.revision,
                MAX_DELIVERY_CANDIDATES + 1
            )
            .is_err());
    }
}
