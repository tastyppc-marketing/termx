use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

use crate::{
    error::{StoreError, ValidationError},
    model::*,
};

use super::{
    authorize_peer, now_millis,
    policy::{read_binding, revision_from_sql},
    revision::bump_delivery,
    Store,
};

pub(crate) const NOTICE_GAPS_FIRST_SQL: &str = "SELECT recipient_peer_id,recipient_binding_revision,group_id,covered_through_sequence,noticed_through_sequence,last_attempt_id FROM notice_coverage ORDER BY recipient_peer_id,recipient_binding_revision,group_id LIMIT 128";
pub(crate) const NOTICE_GAPS_AFTER_SQL: &str = "SELECT recipient_peer_id,recipient_binding_revision,group_id,covered_through_sequence,noticed_through_sequence,last_attempt_id FROM notice_coverage WHERE (recipient_peer_id,recipient_binding_revision,group_id) > (?1,?2,?3) ORDER BY recipient_peer_id,recipient_binding_revision,group_id LIMIT 128";
const NOTICE_GAPS_LOOKAHEAD_SQL: &str = "SELECT 1 FROM notice_coverage WHERE (recipient_peer_id,recipient_binding_revision,group_id) > (?1,?2,?3) ORDER BY recipient_peer_id,recipient_binding_revision,group_id LIMIT 1";
const NOTICE_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Clone)]
struct CoverageScope {
    peer: PeerId,
    binding: Revision,
    group: GroupId,
    covered: u64,
    noticed: u64,
    last_attempt_id: Option<NoticeAttemptId>,
}

impl CoverageScope {
    fn cursor(&self) -> NoticeGapCursor {
        NoticeGapCursor {
            after_peer: self.peer.clone(),
            after_binding: self.binding,
            after_group: self.group.clone(),
        }
    }
}

impl Store {
    /// Returns a bounded raw-coverage scan filtered through current authority
    /// and exact unfetched ranges. Empty plus `next` is forward progress.
    pub fn notice_gaps(
        &mut self,
        owner: &OwnerPrincipal,
        cursor: Option<&NoticeGapCursor>,
        limit: usize,
    ) -> Result<NoticeCandidatePage, StoreError> {
        self.ensure_owner(owner)?;
        if limit == 0 {
            return Err(ValidationError::Empty {
                field: "notice_gap_limit",
            }
            .into());
        }
        if limit > MAX_NOTICE_GAP_REQUEST_LIMIT {
            return Err(ValidationError::TooLarge {
                field: "notice_gap_limit",
                max: MAX_NOTICE_GAP_REQUEST_LIMIT,
            }
            .into());
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let run = require_notice_run(&tx, self.run_revision)?;
        let mut statement = tx.prepare(if cursor.is_some() {
            NOTICE_GAPS_AFTER_SQL
        } else {
            NOTICE_GAPS_FIRST_SQL
        })?;
        let mut rows = match cursor {
            Some(cursor) => statement.query(params![
                cursor.after_peer.as_str(),
                cursor.after_binding.as_sql_i64(),
                cursor.after_group.as_str()
            ])?,
            None => statement.query([])?,
        };
        let mut candidates = Vec::with_capacity(limit);
        let mut examined = 0usize;
        let mut last_fetched = None;
        let mut last_processed = cursor.cloned();
        let mut stopped_for_output = false;

        while let Some(row) = rows.next()? {
            let scope = CoverageScope {
                peer: PeerId::parse(&row.get::<_, String>(0)?)?,
                binding: revision_from_sql(row.get(1)?)?,
                group: GroupId::parse(&row.get::<_, String>(2)?)?,
                covered: sequence(row.get(3)?)?,
                noticed: sequence(row.get(4)?)?,
                last_attempt_id: row
                    .get::<_, Option<String>>(5)?
                    .as_deref()
                    .map(NoticeAttemptId::parse)
                    .transpose()?,
            };
            examined += 1;
            last_fetched = Some(scope.cursor());
            let Some(policy_revision) = eligible_policy(&tx, &self.authority_id, &scope)? else {
                last_processed = Some(scope.cursor());
                continue;
            };

            let same_binding = candidates
                .last()
                .is_some_and(|candidate: &NoticeCandidate| {
                    candidate.recipient_peer_id == scope.peer
                        && candidate.binding_revision == scope.binding
                });
            if same_binding {
                let candidate = candidates.last_mut().expect("checked above");
                if candidate.groups.len() == MAX_NOTICE_GROUPS_PER_ITEM {
                    candidate.more_groups = true;
                    stopped_for_output = true;
                    break;
                }
                candidate.groups.push(NoticeGroupWatermark {
                    group_id: scope.group.clone(),
                    policy_revision,
                    covered_through_sequence: scope.covered,
                    last_attempt_id: scope.last_attempt_id.clone(),
                });
            } else {
                if candidates.len() == limit {
                    stopped_for_output = true;
                    break;
                }
                let mut groups = Vec::with_capacity(MAX_NOTICE_GROUPS_PER_ITEM);
                groups.push(NoticeGroupWatermark {
                    group_id: scope.group.clone(),
                    policy_revision,
                    covered_through_sequence: scope.covered,
                    last_attempt_id: scope.last_attempt_id.clone(),
                });
                candidates.push(NoticeCandidate {
                    authority_id: self.authority_id.clone(),
                    recipient_peer_id: scope.peer.clone(),
                    binding_revision: scope.binding,
                    run_revision: run,
                    groups,
                    more_groups: false,
                });
            }
            last_processed = Some(scope.cursor());
        }
        drop(rows);
        drop(statement);

        let next = if stopped_for_output {
            last_processed
        } else if examined == MAX_NOTICE_EXAMINED_SCOPES {
            let last = last_fetched.expect("a full window has a final row");
            let more = tx
                .query_row(
                    NOTICE_GAPS_LOOKAHEAD_SQL,
                    params![
                        last.after_peer.as_str(),
                        last.after_binding.as_sql_i64(),
                        last.after_group.as_str()
                    ],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            more.then_some(last_processed.expect("a full window was processed"))
        } else {
            None
        };
        let page = NoticeCandidatePage {
            candidates,
            next,
            examined_scopes: examined,
        };
        debug_assert!(page.estimated_retained_bytes() <= NOTICE_RESPONSE_BYTES);
        tx.commit()?;
        Ok(page)
    }

    /// Commits one exact fixed notice ticket before any native adapter runs.
    pub fn begin_notice(
        &mut self,
        owner: &OwnerPrincipal,
        candidate: &NoticeCandidate,
    ) -> Result<NoticeTicket, StoreError> {
        self.ensure_owner(owner)?;
        if candidate.authority_id != self.authority_id {
            return Err(StoreError::AuthorityMismatch);
        }
        if candidate.groups.is_empty() || candidate.groups.len() > MAX_NOTICE_GROUPS_PER_ITEM {
            return Err(StoreError::StaleCandidate);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let run = require_notice_run(&tx, self.run_revision)?;
        if candidate.run_revision != run {
            return Err(StoreError::StaleCandidate);
        }
        let principal = PeerPrincipal::new(
            self.authority_id.clone(),
            candidate.recipient_peer_id.clone(),
            candidate.binding_revision,
        );
        if has_unfinished_notice(
            &tx,
            &candidate.recipient_peer_id,
            candidate.binding_revision,
        )? || !latest_attempt_permits_work(
            &tx,
            &candidate.recipient_peer_id,
            candidate.binding_revision,
        )? {
            return Err(StoreError::StaleCandidate);
        }
        let mut previous_group: Option<&GroupId> = None;
        for group in &candidate.groups {
            if previous_group.is_some_and(|previous| previous >= &group.group_id) {
                return Err(StoreError::StaleCandidate);
            }
            previous_group = Some(&group.group_id);
            let auth = authorize_peer(&tx, &self.authority_id, &principal, &group.group_id)?;
            if auth.policy_revision != group.policy_revision {
                return Err(StoreError::StalePolicy {
                    expected: group.policy_revision.get(),
                    actual: auth.policy_revision.get(),
                });
            }
            let current = tx
                .query_row(
                    "SELECT covered_through_sequence,noticed_through_sequence,last_attempt_id FROM notice_coverage WHERE recipient_peer_id=?1 AND recipient_binding_revision=?2 AND group_id=?3",
                    params![
                        candidate.recipient_peer_id.as_str(),
                        candidate.binding_revision.as_sql_i64(),
                        group.group_id.as_str()
                    ],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .optional()?;
            let expected_last = group.last_attempt_id.as_ref().map(NoticeAttemptId::as_str);
            let Some((covered, noticed, last)) = current else {
                return Err(StoreError::StaleCandidate);
            };
            if sequence(covered)? != group.covered_through_sequence
                || sequence(noticed)? >= group.covered_through_sequence
                || last.as_deref() != expected_last
                || !has_unfetched_gap(
                    &tx,
                    &candidate.recipient_peer_id,
                    candidate.binding_revision,
                    &group.group_id,
                    sequence(noticed)?,
                    group.covered_through_sequence,
                )?
            {
                return Err(StoreError::StaleCandidate);
            }
        }

        let binding = read_binding(
            &tx,
            &candidate.recipient_peer_id,
            candidate.binding_revision.as_sql_i64(),
        )?;
        let number: i64 = tx.query_row(
            "SELECT COALESCE(MAX(attempt_number),0)+1 FROM notice_attempts WHERE recipient_peer_id=?1 AND recipient_binding_revision=?2",
            params![candidate.recipient_peer_id.as_str(), candidate.binding_revision.as_sql_i64()],
            |row| row.get(0),
        )?;
        let attempt_id = NoticeAttemptId::generate();
        let now = now_millis(&tx)?;
        let policy_snapshot = serde_json::to_string(&candidate.groups)
            .map_err(|error| ValidationError::CanonicalSerialization(error.to_string()))?;
        let binding_snapshot = serde_json::to_string(&binding)
            .map_err(|error| ValidationError::CanonicalSerialization(error.to_string()))?;
        tx.execute(
            "INSERT INTO notice_attempts(attempt_id,recipient_peer_id,recipient_binding_revision,attempt_number,run_revision,policy_snapshot_json,binding_snapshot_json,started_at_millis) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                attempt_id.as_str(),
                candidate.recipient_peer_id.as_str(),
                candidate.binding_revision.as_sql_i64(),
                number,
                run.as_sql_i64(),
                policy_snapshot,
                binding_snapshot,
                now
            ],
        )?;
        tx.execute(
            "INSERT INTO notice_tickets(attempt_id,authority_id,run_revision,binding_snapshot_json) VALUES(?1,?2,?3,?4)",
            params![attempt_id.as_str(), self.authority_id.as_str(), run.as_sql_i64(), binding_snapshot],
        )?;
        for group in &candidate.groups {
            tx.execute(
                "INSERT INTO notice_attempt_groups(attempt_id,group_id,covered_through_sequence,policy_revision) VALUES(?1,?2,?3,?4)",
                params![
                    attempt_id.as_str(),
                    group.group_id.as_str(),
                    sqlite_sequence(group.covered_through_sequence)?,
                    group.policy_revision.as_sql_i64()
                ],
            )?;
            let changed = tx.execute(
                "UPDATE notice_coverage SET last_attempt_id=?1,updated_at_millis=?2 WHERE recipient_peer_id=?3 AND recipient_binding_revision=?4 AND group_id=?5 AND covered_through_sequence=?6 AND last_attempt_id IS ?7",
                params![
                    attempt_id.as_str(),
                    now,
                    candidate.recipient_peer_id.as_str(),
                    candidate.binding_revision.as_sql_i64(),
                    group.group_id.as_str(),
                    sqlite_sequence(group.covered_through_sequence)?,
                    group.last_attempt_id.as_ref().map(NoticeAttemptId::as_str)
                ],
            )?;
            if changed != 1 {
                return Err(StoreError::StaleCandidate);
            }
        }
        bump_delivery(&tx)?;
        tx.commit()?;
        Ok(NoticeTicket {
            attempt_id,
            candidate: candidate.clone(),
            recipient_binding: binding,
            attempt_number: u64::try_from(number).map_err(|_| StoreError::StaleCandidate)?,
            run_revision: run,
        })
    }

    pub fn notice_attempt(
        &self,
        owner: &OwnerPrincipal,
        attempt_id: &NoticeAttemptId,
    ) -> Result<NoticeAttemptStatus, StoreError> {
        self.ensure_owner(owner)?;
        load_notice_status(&self.connection, attempt_id)
    }

    /// Records submission evidence without conflating it with native receipt.
    pub fn complete_notice(
        &mut self,
        owner: &OwnerPrincipal,
        attempt_id: &NoticeAttemptId,
        outcome: AttemptOutcome,
    ) -> Result<NoticeAttemptStatus, StoreError> {
        self.ensure_owner(owner)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = load_notice_status(&tx, attempt_id)?;
        if outcome == AttemptOutcome::KnownNotSubmitted && previous.receipt.is_some() {
            return Err(StoreError::AttemptConflict);
        }
        if outcome == AttemptOutcome::NativeQueued
            && previous.reconciled_not_submitted_at_millis.is_some()
        {
            return Err(StoreError::AttemptConflict);
        }
        if previous.outcome == Some(outcome) {
            tx.commit()?;
            return Ok(previous);
        }
        if previous.outcome.is_some() && previous.outcome != Some(AttemptOutcome::Uncertain) {
            return Err(StoreError::AttemptConflict);
        }
        let now = now_millis(&tx)?;
        tx.execute(
            "UPDATE notice_attempts SET outcome=?1,completed_at_millis=?2 WHERE attempt_id=?3",
            params![outcome.as_str(), now, attempt_id.as_str()],
        )?;
        if outcome == AttemptOutcome::NativeQueued {
            advertise_attempt_coverage(&tx, attempt_id, now)?;
        }
        let result = load_notice_status(&tx, attempt_id)?;
        bump_delivery(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn reconcile_notice_not_submitted(
        &mut self,
        owner: &OwnerPrincipal,
        evidence: VerifiedNoticeNotSubmitted,
    ) -> Result<(), StoreError> {
        self.ensure_owner(owner)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let status = load_notice_status(&tx, &evidence.attempt_id)?;
        if status.receipt.is_some() || status.outcome == Some(AttemptOutcome::NativeQueued) {
            return Err(StoreError::AttemptConflict);
        }
        if let Some(previous) = tx
            .query_row(
                "SELECT evidence_reference FROM notice_not_submitted_reconciliations WHERE attempt_id=?1",
                [evidence.attempt_id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            if previous != evidence.evidence_reference {
                return Err(StoreError::AttemptConflict);
            }
            tx.commit()?;
            return Ok(());
        }
        if !matches!(
            status.outcome,
            Some(
                AttemptOutcome::Held | AttemptOutcome::TransportWritten | AttemptOutcome::Uncertain
            )
        ) {
            return Err(StoreError::AttemptConflict);
        }
        let now = now_millis(&tx)?;
        tx.execute(
            "INSERT INTO notice_not_submitted_reconciliations(attempt_id,evidence_reference,reconciled_at_millis) VALUES(?1,?2,?3)",
            params![evidence.attempt_id.as_str(), evidence.evidence_reference, now],
        )?;
        bump_delivery(&tx)?;
        tx.commit()?;
        Ok(())
    }

    pub fn record_notice_receipt(
        &mut self,
        owner: &OwnerPrincipal,
        evidence: VerifiedNoticeReceipt,
    ) -> Result<NoticeAttemptStatus, StoreError> {
        self.ensure_owner(owner)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let status = load_notice_status(&tx, &evidence.attempt_id)?;
        if status.outcome == Some(AttemptOutcome::KnownNotSubmitted)
            || status.reconciled_not_submitted_at_millis.is_some()
        {
            return Err(StoreError::AttemptConflict);
        }
        let binding_json: String = tx.query_row(
            "SELECT binding_snapshot_json FROM notice_attempts WHERE attempt_id=?1",
            [evidence.attempt_id.as_str()],
            |row| row.get(0),
        )?;
        let binding: PeerBindingRecord = serde_json::from_str(&binding_json)
            .map_err(|error| ValidationError::CanonicalSerialization(error.to_string()))?;
        if binding != evidence.recipient_binding {
            return Err(StoreError::StaleBinding);
        }
        if let Some(previous) = &status.receipt {
            if previous.native_record_kind == evidence.native_record_kind
                && previous.provenance_reference == evidence.provenance_reference
                && previous.enrolled_source_identity == evidence.enrolled_source_identity
                && previous.enrolled_generation == evidence.enrolled_generation
                && previous.native_item_identity == evidence.native_item_identity
            {
                tx.commit()?;
                return Ok(status);
            }
            return Err(StoreError::AttemptConflict);
        }
        let now = now_millis(&tx)?;
        tx.execute(
            "INSERT INTO notice_receipts(attempt_id,native_record_kind,provenance_reference,enrolled_source_identity,enrolled_generation,native_item_identity,received_at_millis) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                evidence.attempt_id.as_str(),
                evidence.native_record_kind,
                evidence.provenance_reference,
                evidence.enrolled_source_identity,
                evidence.enrolled_generation,
                evidence.native_item_identity,
                now
            ],
        )?;
        advertise_attempt_coverage(&tx, &evidence.attempt_id, now)?;
        let result = load_notice_status(&tx, &evidence.attempt_id)?;
        bump_delivery(&tx)?;
        tx.commit()?;
        Ok(result)
    }
}

fn eligible_policy(
    tx: &Transaction<'_>,
    authority_id: &AuthorityId,
    scope: &CoverageScope,
) -> Result<Option<Revision>, StoreError> {
    if scope.covered <= scope.noticed
        || has_unfinished_notice(tx, &scope.peer, scope.binding)?
        || !latest_attempt_permits_work(tx, &scope.peer, scope.binding)?
        || !has_unfetched_gap(
            tx,
            &scope.peer,
            scope.binding,
            &scope.group,
            scope.noticed,
            scope.covered,
        )?
    {
        return Ok(None);
    }
    let policy = tx
        .query_row(
            "SELECT g.policy_revision FROM peers p JOIN peer_bindings b ON b.peer_id=p.peer_id AND b.binding_revision=p.current_binding_revision JOIN groups g ON g.group_id=?3 AND g.authority_id=?4 JOIN group_memberships gm INDEXED BY membership_active_by_group ON gm.group_id=g.group_id AND gm.peer_id=p.peer_id AND gm.removed_policy_revision IS NULL WHERE p.peer_id=?1 AND p.current_binding_revision=?2 AND b.live=1 AND g.paused=0",
            params![
                scope.peer.as_str(),
                scope.binding.as_sql_i64(),
                scope.group.as_str(),
                authority_id.as_str()
            ],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    policy.map(revision_from_sql).transpose()
}

fn has_unfinished_notice(
    tx: &Transaction<'_>,
    peer: &PeerId,
    binding: Revision,
) -> Result<bool, StoreError> {
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM notice_attempts INDEXED BY notice_attempts_unfinished WHERE recipient_peer_id=?1 AND recipient_binding_revision=?2 AND completed_at_millis IS NULL)",
        params![peer.as_str(), binding.as_sql_i64()],
        |row| row.get(0),
    )?)
}

fn latest_attempt_permits_work(
    tx: &Transaction<'_>,
    peer: &PeerId,
    binding: Revision,
) -> Result<bool, StoreError> {
    let latest = tx
        .query_row(
            "SELECT a.outcome,EXISTS(SELECT 1 FROM notice_receipts r WHERE r.attempt_id=a.attempt_id),EXISTS(SELECT 1 FROM notice_not_submitted_reconciliations n WHERE n.attempt_id=a.attempt_id) FROM notice_attempts a INDEXED BY notice_attempts_latest WHERE a.recipient_peer_id=?1 AND a.recipient_binding_revision=?2 ORDER BY a.attempt_number DESC LIMIT 1",
            params![peer.as_str(), binding.as_sql_i64()],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, bool>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((outcome, receipt, reconciled)) = latest else {
        return Ok(true);
    };
    let Some(outcome) = outcome else {
        return Ok(false);
    };
    Ok(match AttemptOutcome::from_stored(&outcome) {
        AttemptOutcome::KnownNotSubmitted | AttemptOutcome::NativeQueued => true,
        AttemptOutcome::Held | AttemptOutcome::TransportWritten | AttemptOutcome::Uncertain => {
            receipt || reconciled
        }
    })
}

fn has_unfetched_gap(
    tx: &Transaction<'_>,
    peer: &PeerId,
    binding: Revision,
    group: &GroupId,
    noticed: u64,
    covered: u64,
) -> Result<bool, StoreError> {
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM current_deliveries INDEXED BY notice_unfetched_eligible WHERE recipient_peer_id=?1 AND recipient_binding_revision=?2 AND group_id=?3 AND fetched_at_millis IS NULL AND group_sequence>?4 AND group_sequence<=?5)",
        params![
            peer.as_str(),
            binding.as_sql_i64(),
            group.as_str(),
            sqlite_sequence(noticed)?,
            sqlite_sequence(covered)?
        ],
        |row| row.get(0),
    )?)
}

fn advertise_attempt_coverage(
    tx: &Transaction<'_>,
    attempt_id: &NoticeAttemptId,
    now: i64,
) -> Result<(), StoreError> {
    tx.execute(
        "UPDATE notice_coverage SET noticed_through_sequence=MAX(noticed_through_sequence,COALESCE((SELECT g.covered_through_sequence FROM notice_attempt_groups g WHERE g.attempt_id=?1 AND g.group_id=notice_coverage.group_id),noticed_through_sequence)),updated_at_millis=?2 WHERE (recipient_peer_id,recipient_binding_revision)=(SELECT recipient_peer_id,recipient_binding_revision FROM notice_attempts WHERE attempt_id=?1) AND last_attempt_id=?1 AND EXISTS(SELECT 1 FROM notice_attempt_groups g WHERE g.attempt_id=?1 AND g.group_id=notice_coverage.group_id)",
        params![attempt_id.as_str(), now],
    )?;
    Ok(())
}

fn load_notice_status(
    connection: &rusqlite::Connection,
    attempt_id: &NoticeAttemptId,
) -> Result<NoticeAttemptStatus, StoreError> {
    let row = connection
        .query_row(
            "SELECT a.outcome,a.completed_at_millis,a.recovered_uncertain_at_millis,n.reconciled_at_millis,r.native_record_kind,r.provenance_reference,r.enrolled_source_identity,r.enrolled_generation,r.native_item_identity,r.received_at_millis FROM notice_attempts a LEFT JOIN notice_not_submitted_reconciliations n ON n.attempt_id=a.attempt_id LEFT JOIN notice_receipts r ON r.attempt_id=a.attempt_id WHERE a.attempt_id=?1",
            [attempt_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                ))
            },
        )
        .optional()?
        .ok_or(StoreError::NotFound {
            kind: "notice attempt",
        })?;
    let receipt = match row.4 {
        Some(native_record_kind) => Some(NoticeReceiptRecord {
            native_record_kind,
            provenance_reference: row.5.ok_or(StoreError::AttemptConflict)?,
            enrolled_source_identity: row.6.ok_or(StoreError::AttemptConflict)?,
            enrolled_generation: row.7.ok_or(StoreError::AttemptConflict)?,
            native_item_identity: row.8.ok_or(StoreError::AttemptConflict)?,
            received_at_millis: row.9.ok_or(StoreError::AttemptConflict)?,
        }),
        None => None,
    };
    Ok(NoticeAttemptStatus {
        attempt_id: attempt_id.clone(),
        outcome: row.0.as_deref().map(AttemptOutcome::from_stored),
        completed_at_millis: row.1,
        recovered_uncertain_at_millis: row.2,
        reconciled_not_submitted_at_millis: row.3,
        receipt,
    })
}

fn require_notice_run(
    tx: &Transaction<'_>,
    expected: Option<Revision>,
) -> Result<Revision, StoreError> {
    let expected = expected.ok_or(StoreError::RecoveryRequired)?;
    let current: Option<i64> =
        tx.query_row("SELECT MAX(run_revision) FROM broker_runs", [], |row| {
            row.get(0)
        })?;
    if current != Some(expected.as_sql_i64()) {
        return Err(StoreError::RecoveryRequired);
    }
    Ok(expected)
}

fn sequence(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value).map_err(|_| StoreError::StaleCandidate)
}

fn sqlite_sequence(value: u64) -> Result<i64, StoreError> {
    crate::model::sqlite_i64("notice_sequence", value).map_err(StoreError::from)
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeSet,
        path::PathBuf,
        sync::{
            atomic::{AtomicU64, AtomicUsize, Ordering},
            Arc,
        },
        time::{SystemTime, UNIX_EPOCH},
    };

    use rusqlite::params;

    use crate::model::{
        GroupId, LaunchId, SendMessageRequest, VerifiedBinding, MAX_NOTICE_EXAMINED_SCOPES,
    };

    use super::{Store, NOTICE_GAPS_AFTER_SQL};

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    fn retained_path(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("retired")
            .join("test-artifacts")
            .join("swarm-core")
            .join(format!("{name}-{stamp}-{sequence}"));
        std::fs::create_dir_all(&directory).expect("create retained notice fixture");
        directory.join("swarm.sqlite")
    }

    fn binding(name: &str) -> VerifiedBinding {
        VerifiedBinding::trusted(
            LaunchId::generate().as_str().into(),
            format!("terminal-{name}"),
            "synthetic".into(),
            format!("conversation-{name}"),
            None,
            100,
            1000,
            true,
        )
        .unwrap()
    }

    #[test]
    fn send_coverage_rolls_back_with_delivery_and_retry_does_not_duplicate_it() {
        let mut store = Store::open(retained_path("notice-send-atomicity")).unwrap();
        let owner = store.trusted_owner();
        let alice = store.enroll_peer(&owner, binding("atomic-alice")).unwrap();
        let bob = store.enroll_peer(&owner, binding("atomic-bob")).unwrap();
        let group = store
            .create_group(
                &owner,
                "atomic",
                BTreeSet::from([alice.record.peer_id.clone(), bob.record.peer_id.clone()]),
            )
            .unwrap();
        store.recover_trusted_new_run(&owner).unwrap();
        let request = SendMessageRequest {
            group_id: group.group_id.clone(),
            client_key: "atomic-key".into(),
            recipients: BTreeSet::from([bob.record.peer_id.clone()]),
            body: "atomic body".into(),
            topic: None,
            reply_to: None,
            attachments: Vec::new(),
        };

        store.connection.commit_hook(Some(|| true)).unwrap();
        assert!(store
            .send_message(&alice.principal, request.clone())
            .is_err());
        store.connection.commit_hook(None::<fn() -> bool>).unwrap();
        for table in [
            "messages",
            "recipient_deliveries",
            "notice_coverage",
            "notice_attempts",
            "notice_receipts",
        ] {
            let count: i64 = store
                .connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "rollback left rows in {table}");
        }

        let first = store
            .send_message(&alice.principal, request.clone())
            .unwrap();
        let retry = store.send_message(&alice.principal, request).unwrap();
        assert_eq!(first, retry);
        let coverage: (i64, i64, i64) = store
            .connection
            .query_row(
                "SELECT count(*),MIN(covered_through_sequence),MAX(covered_through_sequence) FROM notice_coverage",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(coverage, (1, 1, 1));
    }

    #[test]
    fn tuple_seek_and_unfetched_checks_stay_indexed_at_thirty_thousand_scopes() {
        const SCOPES: i64 = 30_000;
        const FETCHED_PREFIX: i64 = 1_000;
        const PROGRESS_INTERVAL: i32 = 100;

        let mut store = Store::open(retained_path("notice-tuple-seek-30000")).unwrap();
        let owner = store.trusted_owner();
        let alice = store.enroll_peer(&owner, binding("scale-alice")).unwrap();
        let bob = store.enroll_peer(&owner, binding("scale-bob")).unwrap();
        store.recover_trusted_new_run(&owner).unwrap();
        let tx = store.connection.transaction().unwrap();
        tx.execute(
            "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<?1) INSERT INTO groups(group_id,authority_id,policy_revision,next_sequence,label,paused,created_at_millis) SELECT printf('g_%032x',n),?2,1,2,printf('scale-%d',n),0,1 FROM seq",
            params![SCOPES, store.authority_id.as_str()],
        )
        .unwrap();
        tx.execute(
            "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<?1) INSERT INTO notice_coverage(recipient_peer_id,recipient_binding_revision,group_id,covered_through_sequence,noticed_through_sequence,updated_at_millis) SELECT ?2,?3,printf('g_%032x',n),1,0,1 FROM seq",
            params![SCOPES, bob.record.peer_id.as_str(), bob.record.revision.as_sql_i64()],
        )
        .unwrap();
        tx.execute(
            "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<?1) INSERT INTO messages(message_id,group_id,group_sequence,sender_peer_id,sender_binding_revision,client_key,semantic_payload_json,body,committed_at_millis) SELECT printf('m_%032x',n),printf('g_%032x',n),1,?2,?3,printf('scale-%d',n),'{}','fetched',1 FROM seq",
            params![FETCHED_PREFIX, alice.record.peer_id.as_str(), alice.record.revision.as_sql_i64()],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO recipient_deliveries(message_id,recipient_peer_id,recipient_binding_revision,saved_at_millis,fetched_generation,fetched_at_millis,delivery_generation) SELECT message_id,?1,?2,1,1,1,1 FROM messages",
            params![bob.record.peer_id.as_str(), bob.record.revision.as_sql_i64()],
        )
        .unwrap();
        let last_group = format!("g_{SCOPES:032x}");
        let last_message = format!("m_{SCOPES:032x}");
        tx.execute(
            "INSERT INTO group_memberships(group_id,peer_id,added_policy_revision) VALUES(?1,?2,1)",
            params![last_group, bob.record.peer_id.as_str()],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO messages(message_id,group_id,group_sequence,sender_peer_id,sender_binding_revision,client_key,semantic_payload_json,body,committed_at_millis) VALUES(?1,?2,1,?3,?4,'last','{}','unfetched',1)",
            params![last_message, last_group, alice.record.peer_id.as_str(), alice.record.revision.as_sql_i64()],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO recipient_deliveries(message_id,recipient_peer_id,recipient_binding_revision,saved_at_millis,delivery_generation) VALUES(?1,?2,?3,1,1)",
            params![last_message, bob.record.peer_id.as_str(), bob.record.revision.as_sql_i64()],
        )
        .unwrap();
        tx.commit().unwrap();

        let after_group = GroupId::parse(&format!("g_{:032x}", SCOPES / 2)).unwrap();
        let plan = {
            let mut statement = store
                .connection
                .prepare(&format!("EXPLAIN QUERY PLAN {NOTICE_GAPS_AFTER_SQL}"))
                .unwrap();
            statement
                .query_map(
                    params![
                        bob.record.peer_id.as_str(),
                        bob.record.revision.as_sql_i64(),
                        after_group.as_str()
                    ],
                    |row| row.get::<_, String>(3),
                )
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert!(
            plan.iter()
                .any(|detail| detail.contains("SEARCH notice_coverage")),
            "tuple seek did not search the coverage primary key: {plan:?}"
        );
        assert!(
            plan.iter().all(|detail| !detail.contains("TEMP B-TREE")),
            "tuple seek introduced temporary ordering: {plan:?}"
        );
        let range_plan = {
            let mut statement = store.connection.prepare(
                "EXPLAIN QUERY PLAN SELECT EXISTS(SELECT 1 FROM current_deliveries INDEXED BY notice_unfetched_eligible WHERE recipient_peer_id=?1 AND recipient_binding_revision=?2 AND group_id=?3 AND fetched_at_millis IS NULL AND group_sequence>?4 AND group_sequence<=?5)",
            ).unwrap();
            statement
                .query_map(
                    params![
                        bob.record.peer_id.as_str(),
                        bob.record.revision.as_sql_i64(),
                        after_group.as_str(),
                        0,
                        1
                    ],
                    |row| row.get::<_, String>(3),
                )
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert!(
            range_plan
                .iter()
                .any(|detail| detail.contains("notice_unfetched_eligible")),
            "unfetched check did not use its partial range index: {range_plan:?}"
        );

        for (label, after) in [
            ("early", 0_i64),
            ("middle", SCOPES / 2),
            ("late", SCOPES - 1),
        ] {
            let cursor = (after != 0).then(|| super::NoticeGapCursor {
                after_peer: bob.record.peer_id.clone(),
                after_binding: bob.record.revision,
                after_group: GroupId::parse(&format!("g_{after:032x}")).unwrap(),
            });
            let callbacks = Arc::new(AtomicUsize::new(0));
            let counter = Arc::clone(&callbacks);
            store
                .connection
                .progress_handler(
                    PROGRESS_INTERVAL,
                    Some(move || {
                        counter.fetch_add(1, Ordering::Relaxed);
                        false
                    }),
                )
                .unwrap();
            let page = store.notice_gaps(&owner, cursor.as_ref(), 8).unwrap();
            store
                .connection
                .progress_handler(0, None::<fn() -> bool>)
                .unwrap();
            assert!(page.examined_scopes() <= MAX_NOTICE_EXAMINED_SCOPES);
            assert!(page.estimated_retained_bytes() <= 64 * 1024);
            if label == "late" {
                assert_eq!(page.candidates().len(), 1);
            } else {
                assert!(page.candidates().is_empty());
                assert!(page.next().is_some());
            }
            let observed = callbacks.load(Ordering::Relaxed);
            eprintln!(
                "notice gaps {label} cursor over {SCOPES} scopes with {FETCHED_PREFIX} fully fetched rows: {observed} callbacks at {PROGRESS_INTERVAL} VM instructions"
            );
            assert!(
                observed <= 350,
                "notice gaps {label} cursor used at least {} VM instructions",
                observed * PROGRESS_INTERVAL as usize
            );
        }

        let mut cursor = Some(super::NoticeGapCursor {
            after_peer: bob.record.peer_id.clone(),
            after_binding: bob.record.revision,
            after_group: GroupId::parse(&format!("g_{:032x}", SCOPES - 257)).unwrap(),
        });
        for expected_end in [SCOPES - 129, SCOPES - 1] {
            let page = store.notice_gaps(&owner, cursor.as_ref(), 8).unwrap();
            assert!(page.candidates().is_empty());
            assert_eq!(page.examined_scopes(), MAX_NOTICE_EXAMINED_SCOPES);
            let next = page.next().expect("empty page must advance").clone();
            assert_eq!(
                next.after_group().as_str(),
                format!("g_{expected_end:032x}")
            );
            cursor = Some(next);
        }
        let final_page = store.notice_gaps(&owner, cursor.as_ref(), 8).unwrap();
        assert_eq!(final_page.examined_scopes(), 1);
        assert_eq!(final_page.candidates().len(), 1);
        assert!(final_page.next().is_none());

        let mut sweep_cursor = None;
        let mut sweep_calls = 0usize;
        let mut found = Vec::new();
        loop {
            let page = store.notice_gaps(&owner, sweep_cursor.as_ref(), 8).unwrap();
            sweep_calls += 1;
            found.extend_from_slice(page.candidates());
            sweep_cursor = page.next().cloned();
            if sweep_cursor.is_none() {
                break;
            }
        }
        assert_eq!(sweep_calls, 235);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].groups()[0].group_id().as_str(), last_group);
    }

    #[test]
    fn thousand_scope_tuple_seek_has_bounded_early_middle_and_late_work() {
        const SCOPES: i64 = 1_000;
        const PROGRESS_INTERVAL: i32 = 100;
        let mut store = Store::open(retained_path("notice-tuple-seek-1000")).unwrap();
        let owner = store.trusted_owner();
        let bob = store.enroll_peer(&owner, binding("thousand-bob")).unwrap();
        store.recover_trusted_new_run(&owner).unwrap();
        let tx = store.connection.transaction().unwrap();
        tx.execute(
            "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<?1) INSERT INTO groups(group_id,authority_id,policy_revision,next_sequence,label,paused,created_at_millis) SELECT printf('g_%032x',n),?2,1,1,printf('thousand-%d',n),0,1 FROM seq",
            params![SCOPES, store.authority_id.as_str()],
        )
        .unwrap();
        tx.execute(
            "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<?1) INSERT INTO notice_coverage(recipient_peer_id,recipient_binding_revision,group_id,covered_through_sequence,noticed_through_sequence,updated_at_millis) SELECT ?2,?3,printf('g_%032x',n),1,0,1 FROM seq",
            params![SCOPES, bob.record.peer_id.as_str(), bob.record.revision.as_sql_i64()],
        )
        .unwrap();
        tx.commit().unwrap();

        for (label, after) in [("early", 0_i64), ("middle", 500), ("late", 999)] {
            let cursor = (after != 0).then(|| super::NoticeGapCursor {
                after_peer: bob.record.peer_id.clone(),
                after_binding: bob.record.revision,
                after_group: GroupId::parse(&format!("g_{after:032x}")).unwrap(),
            });
            let callbacks = Arc::new(AtomicUsize::new(0));
            let counter = Arc::clone(&callbacks);
            store
                .connection
                .progress_handler(
                    PROGRESS_INTERVAL,
                    Some(move || {
                        counter.fetch_add(1, Ordering::Relaxed);
                        false
                    }),
                )
                .unwrap();
            let page = store.notice_gaps(&owner, cursor.as_ref(), 8).unwrap();
            store
                .connection
                .progress_handler(0, None::<fn() -> bool>)
                .unwrap();
            assert!(page.examined_scopes() <= MAX_NOTICE_EXAMINED_SCOPES);
            let observed = callbacks.load(Ordering::Relaxed);
            eprintln!(
                "notice gaps {label} cursor over {SCOPES} ineligible scopes: {observed} callbacks at {PROGRESS_INTERVAL} VM instructions"
            );
            assert!(
                observed <= 350,
                "notice gaps {label} cursor used at least {} VM instructions",
                observed * PROGRESS_INTERVAL as usize
            );
        }
    }
}
