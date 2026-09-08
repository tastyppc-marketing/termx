//! Source registrations, attachments, context-grant leases and publication
//! commitments.
//!
//! A registration binds trusted native evidence to one exact peer binding and
//! conversation. Its `registration_epoch` is an authorization epoch advanced
//! only by owner transitions; ordinary content appends never touch it. Cited
//! references freeze the epoch they cited and are reported stale rather than
//! redirected. Leases are in-memory evidence acquired before source I/O;
//! validation re-checks every recorded fact under the writer and then commits
//! exactly one response identity durably and single-use.

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

use crate::error::{StoreError, ValidationError};
use crate::model::{
    AttachmentView, CommittedPublication, ContextGrantLease, GroupId, LeaseId, OwnerPrincipal,
    PeerId, PeerPrincipal, PreparedPublication, PublicationCommitment, PublicationCommitmentId,
    Revision, SourceAttachment, SourceAvailability, SourceId, SourceReferenceId,
    SourceRegistration, SourceState, SourceSummary, SourceTransition, VerifiedSourceDescriptor,
    MAX_ACTIVE_SOURCES_PER_BINDING,
};

use super::policy::revision_from_sql;
use super::query::{load_attachments, page_limit};
use super::revision::bump_inventory;
use super::{authorize_peer, now_millis, Store};

/// Stored registration row used by every authorization decision.
pub(super) struct Registration {
    pub source_id: SourceId,
    pub peer_id: PeerId,
    pub binding_revision: i64,
    pub conversation_id: String,
    pub source_kind: String,
    pub resolver_key: String,
    pub object_identity: String,
    pub evidence_reference: String,
    pub state: SourceState,
    pub registration_epoch: i64,
    pub replaced_by: Option<SourceId>,
    pub registered_at_millis: i64,
    pub transitioned_at_millis: i64,
}

/// Authorized attachment ready to be frozen with a message.
pub(super) struct AuthorizedAttachment {
    pub source_id: SourceId,
    pub source_kind: String,
    pub owner_peer_id: PeerId,
    pub registration_epoch: i64,
    pub snapshot_reference: Option<String>,
}

impl Store {
    /// Owner-only registration of trusted native source evidence for the
    /// peer's exact current binding and recorded conversation.
    pub fn register_source(
        &mut self,
        owner: &OwnerPrincipal,
        descriptor: VerifiedSourceDescriptor,
    ) -> Result<SourceRegistration, StoreError> {
        self.ensure_owner(owner)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_current_binding(&transaction, &descriptor)?;
        require_active_capacity(&transaction, &descriptor, None)?;
        let now = now_millis(&transaction)?;
        let source_id = SourceId::generate();
        insert_registration(&transaction, &source_id, &descriptor, now)?;
        let inventory = bump_inventory(&transaction)?;
        let registration = load_registration(&transaction, &source_id)?
            .ok_or(StoreError::NotFound { kind: "source" })?;
        transaction.commit()?;
        registration_view(&registration, inventory)
    }

    /// Owner expected-epoch transitions. Every transition advances the epoch of
    /// the named registration and appends history; nothing is deleted.
    pub fn transition_source(
        &mut self,
        owner: &OwnerPrincipal,
        transition: SourceTransition,
    ) -> Result<SourceRegistration, StoreError> {
        self.ensure_owner(owner)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (source_id, expected_epoch) = match &transition {
            SourceTransition::Withdraw {
                source_id,
                expected_epoch,
            }
            | SourceTransition::Reestablish {
                source_id,
                expected_epoch,
                ..
            }
            | SourceTransition::Replace {
                source_id,
                expected_epoch,
                ..
            } => (source_id.clone(), *expected_epoch),
        };
        let current = load_registration(&transaction, &source_id)?
            .ok_or(StoreError::NotFound { kind: "source" })?;
        if current.registration_epoch != expected_epoch.as_sql_i64() {
            return Err(StoreError::StaleSourceEpoch {
                expected: expected_epoch.get(),
                actual: u64::try_from(current.registration_epoch).unwrap_or(0),
            });
        }
        let now = now_millis(&transaction)?;
        let next_epoch = current.registration_epoch + 1;
        let result_id = match transition {
            SourceTransition::Withdraw { .. } => {
                if current.state != SourceState::Active {
                    return Err(StoreError::SourceUnavailable {
                        reason: "only an active registration can be withdrawn",
                    });
                }
                transaction.execute(
                    "UPDATE source_registrations SET state='withdrawn',registration_epoch=?1,transitioned_at_millis=?2 WHERE source_id=?3",
                    params![next_epoch, now, source_id.as_str()],
                )?;
                source_id.clone()
            }
            SourceTransition::Reestablish { descriptor, .. } => {
                if current.state == SourceState::Replaced {
                    return Err(StoreError::SourceUnavailable {
                        reason: "a replaced registration cannot be re-established",
                    });
                }
                if descriptor.peer_id != current.peer_id {
                    return Err(StoreError::Unauthorized {
                        reason: "fresh evidence names a different peer",
                    });
                }
                require_current_binding(&transaction, &descriptor)?;
                if current.state != SourceState::Active
                    || current.binding_revision != descriptor.binding_revision.as_sql_i64()
                {
                    require_active_capacity(&transaction, &descriptor, Some(&source_id))?;
                }
                transaction.execute(
                    "UPDATE source_registrations SET binding_revision=?1,conversation_id=?2,source_kind=?3,resolver_key=?4,object_identity=?5,evidence_reference=?6,state='active',registration_epoch=?7,transitioned_at_millis=?8 WHERE source_id=?9",
                    params![
                        descriptor.binding_revision.as_sql_i64(),
                        descriptor.conversation_id,
                        descriptor.source_kind,
                        descriptor.resolver_key,
                        descriptor.object_identity,
                        descriptor.evidence_reference,
                        next_epoch,
                        now,
                        source_id.as_str()
                    ],
                )?;
                source_id.clone()
            }
            SourceTransition::Replace { descriptor, .. } => {
                if current.state == SourceState::Replaced {
                    return Err(StoreError::SourceUnavailable {
                        reason: "a replaced registration cannot be replaced again",
                    });
                }
                if descriptor.peer_id != current.peer_id {
                    return Err(StoreError::Unauthorized {
                        reason: "fresh evidence names a different peer",
                    });
                }
                require_current_binding(&transaction, &descriptor)?;
                // The retired registration stops counting before the successor
                // is admitted.
                transaction.execute(
                    "UPDATE source_registrations SET state='replaced',registration_epoch=?1,transitioned_at_millis=?2 WHERE source_id=?3",
                    params![next_epoch, now, source_id.as_str()],
                )?;
                require_active_capacity(&transaction, &descriptor, None)?;
                let replacement = SourceId::generate();
                insert_registration(&transaction, &replacement, &descriptor, now)?;
                transaction.execute(
                    "UPDATE source_registrations SET replaced_by_source_id=?1 WHERE source_id=?2",
                    params![replacement.as_str(), source_id.as_str()],
                )?;
                replacement
            }
        };
        append_history(&transaction, &source_id)?;
        let inventory = bump_inventory(&transaction)?;
        let registration = load_registration(&transaction, &result_id)?
            .ok_or(StoreError::NotFound { kind: "source" })?;
        transaction.commit()?;
        registration_view(&registration, inventory)
    }

    /// Dereferences one public attachment ID for a caller who can see the
    /// citing message in this exact group. Reports current availability of
    /// the cited epoch; never redirects a stale reference to newer content.
    pub fn resolve_attachment(
        &mut self,
        principal: &PeerPrincipal,
        group_id: &GroupId,
        source_reference_id: &SourceReferenceId,
    ) -> Result<AttachmentView, StoreError> {
        let authority_id = self.authority_id.clone();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        authorize_peer(&transaction, &authority_id, principal, group_id)?;
        let row = transaction
            .query_row(
                "SELECT r.message_id,r.ordinal,r.registration_epoch,m.group_id,(m.sender_peer_id=?2 OR EXISTS(SELECT 1 FROM current_deliveries d WHERE d.message_id=m.message_id AND d.recipient_peer_id=?2 AND d.recipient_binding_revision=?3)) FROM message_source_references r JOIN messages m ON m.message_id=r.message_id WHERE r.source_reference_id=?1",
                params![
                    source_reference_id.as_str(),
                    principal.peer_id.as_str(),
                    principal.binding_revision.as_sql_i64()
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, bool>(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((message, ordinal, cited_epoch, message_group, visible)) = row else {
            return Err(StoreError::NotFound { kind: "attachment" });
        };
        if message_group != group_id.as_str() {
            return Err(StoreError::NotFound { kind: "attachment" });
        }
        if !visible {
            return Err(StoreError::Unauthorized {
                reason: "caller cannot see the citing message",
            });
        }
        let message_id = crate::model::MessageId::parse(&message)?;
        let attachment = load_attachments(&transaction, &message_id)?
            .into_iter()
            .nth(
                usize::try_from(ordinal)
                    .map_err(|_| StoreError::NotFound { kind: "attachment" })?,
            )
            .ok_or(StoreError::NotFound { kind: "attachment" })?;
        let registration = load_registration(&transaction, &attachment.source_id)?
            .ok_or(StoreError::NotFound { kind: "source" })?;
        let availability = match registration.state {
            SourceState::Withdrawn => SourceAvailability::Withdrawn,
            SourceState::Replaced => SourceAvailability::Replaced,
            SourceState::Active if registration.registration_epoch != cited_epoch => {
                SourceAvailability::Stale {
                    cited_epoch: revision_from_sql(cited_epoch)?,
                    current_epoch: revision_from_sql(registration.registration_epoch)?,
                }
            }
            SourceState::Active => {
                match owner_authorization(&transaction, &registration, group_id)? {
                    OwnerAuthorization::Current => SourceAvailability::Available {
                        registration_epoch: revision_from_sql(registration.registration_epoch)?,
                    },
                    OwnerAuthorization::StaleBinding => SourceAvailability::StaleBinding,
                    OwnerAuthorization::NotMember => SourceAvailability::OwnerNotMember,
                }
            }
        };
        transaction.commit()?;
        Ok(AttachmentView {
            group_id: group_id.clone(),
            message_id,
            attachment,
            availability,
        })
    }

    /// Acquires in-memory lease evidence for reading one active source in one
    /// explicit group, before any source I/O. A source ID alone is never a
    /// lease; the lease is not deserializable and confers nothing durable.
    pub fn acquire_context_grant(
        &mut self,
        principal: &PeerPrincipal,
        group_id: &GroupId,
        source_id: &SourceId,
    ) -> Result<ContextGrantLease, StoreError> {
        let authority_id = self.authority_id.clone();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let authorized = authorize_peer(&transaction, &authority_id, principal, group_id)?;
        let registration = load_registration(&transaction, source_id)?
            .ok_or(StoreError::NotFound { kind: "source" })?;
        require_available(&transaction, &registration, group_id)?;
        let now = now_millis(&transaction)?;
        transaction.commit()?;
        Ok(ContextGrantLease {
            lease_id: LeaseId::generate(),
            authority_id,
            group_id: group_id.clone(),
            policy_revision: authorized.policy_revision,
            caller_peer_id: principal.peer_id.clone(),
            caller_binding_revision: principal.binding_revision,
            source_id: registration.source_id,
            source_owner_peer_id: registration.peer_id,
            source_owner_binding_revision: revision_from_sql(registration.binding_revision)?,
            registration_epoch: revision_from_sql(registration.registration_epoch)?,
            source_kind: registration.source_kind,
            resolver_key: registration.resolver_key,
            object_identity: registration.object_identity,
            acquired_at_millis: now,
        })
    }

    /// Final writer validation of one exact prepared response.
    ///
    /// The prepared value already binds the buffer to a lease-scoped source
    /// observation and an actually owned destination reservation. Every
    /// authorization fact recorded in the lease and the observation is
    /// re-checked against current state under the writer; success durably
    /// commits the response identity once and returns the same buffer and
    /// guard as a `CommittedPublication`. Any rejection consumes the prepared
    /// value, releasing its credits. Later revocation never retracts a
    /// commitment, and a consumed lease or reused identity never validates.
    pub fn validate_context_grant(
        &mut self,
        principal: &PeerPrincipal,
        prepared: PreparedPublication,
    ) -> Result<CommittedPublication, StoreError> {
        let (lease, observation, response_id, body, reservation) = prepared.into_parts();
        if lease.authority_id != self.authority_id || principal.authority_id != self.authority_id {
            return Err(StoreError::AuthorityMismatch);
        }
        if lease.caller_peer_id != principal.peer_id
            || lease.caller_binding_revision != principal.binding_revision
        {
            return Err(StoreError::Unauthorized {
                reason: "lease was acquired by a different principal",
            });
        }
        let authority_id = self.authority_id.clone();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let authorized = authorize_peer(&transaction, &authority_id, principal, &lease.group_id)?;
        if authorized.policy_revision != lease.policy_revision {
            return Err(StoreError::StalePolicy {
                expected: lease.policy_revision.get(),
                actual: authorized.policy_revision.get(),
            });
        }
        let registration = load_registration(&transaction, &lease.source_id)?
            .ok_or(StoreError::NotFound { kind: "source" })?;
        let lease_matches = registration.registration_epoch
            == lease.registration_epoch.as_sql_i64()
            && registration.binding_revision == lease.source_owner_binding_revision.as_sql_i64()
            && registration.peer_id == lease.source_owner_peer_id
            && registration.object_identity == lease.object_identity;
        let observation_matches = registration.source_id == *observation.source_id()
            && registration.registration_epoch == observation.registration_epoch().as_sql_i64()
            && registration.binding_revision
                == observation.source_owner_binding_revision().as_sql_i64()
            && registration.peer_id == *observation.source_owner_peer_id()
            && registration.object_identity == observation.object_identity();
        if !lease_matches || !observation_matches {
            return Err(StoreError::SourceUnavailable {
                reason: "source registration changed after the lease was acquired",
            });
        }
        require_available(&transaction, &registration, &lease.group_id)?;
        let consumed = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM publication_commitments WHERE lease_id=?1)",
            [lease.lease_id.as_str()],
            |row| row.get::<_, bool>(0),
        )?;
        if consumed {
            return Err(StoreError::LeaseConsumed);
        }
        let committed = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM publication_commitments WHERE response_reference=?1)",
            [response_id.as_str()],
            |row| row.get::<_, bool>(0),
        )?;
        if committed {
            return Err(StoreError::ResponseAlreadyCommitted);
        }
        let now = now_millis(&transaction)?;
        let commitment_id = PublicationCommitmentId::generate();
        let reserved_bytes = u64::try_from(reservation.reserved_bytes()).map_err(|_| {
            ValidationError::IntegerRange {
                field: "reserved_bytes",
            }
        })?;
        let body_bytes = u64::try_from(body.len()).map_err(|_| ValidationError::IntegerRange {
            field: "body_bytes",
        })?;
        transaction.execute(
            "INSERT INTO publication_commitments(commitment_id,lease_id,response_reference,authority_id,group_id,policy_revision,caller_peer_id,caller_binding_revision,source_id,source_owner_binding_revision,registration_epoch,reserved_bytes,committed_at_millis,destination_id,body_bytes,snapshot_identity,captured_through) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
            params![
                commitment_id.as_str(),
                lease.lease_id.as_str(),
                response_id.as_str(),
                authority_id.as_str(),
                lease.group_id.as_str(),
                lease.policy_revision.as_sql_i64(),
                principal.peer_id.as_str(),
                principal.binding_revision.as_sql_i64(),
                lease.source_id.as_str(),
                lease.source_owner_binding_revision.as_sql_i64(),
                lease.registration_epoch.as_sql_i64(),
                crate::model::sqlite_i64("reserved_bytes", reserved_bytes)?,
                now,
                reservation.destination_id().as_str(),
                crate::model::sqlite_i64("body_bytes", body_bytes)?,
                observation.snapshot_identity(),
                observation
                    .captured_through()
                    .map(|through| crate::model::sqlite_i64("captured_through", through))
                    .transpose()?,
            ],
        )?;
        transaction.commit()?;
        let record = PublicationCommitment {
            commitment_id,
            lease_id: lease.lease_id,
            response_id,
            destination_id: reservation.destination_id().clone(),
            group_id: lease.group_id,
            policy_revision: lease.policy_revision,
            caller_peer_id: lease.caller_peer_id,
            caller_binding_revision: lease.caller_binding_revision,
            source_id: lease.source_id,
            registration_epoch: lease.registration_epoch,
            body_bytes,
            reserved_bytes,
            snapshot_identity: observation.snapshot_identity().to_owned(),
            captured_through: observation.captured_through(),
            committed_at_millis: now,
        };
        Ok(CommittedPublication::new(record, body, reservation))
    }

    /// Owner audit: whether a commitment was durably recorded.
    pub fn publication_committed(
        &self,
        owner: &OwnerPrincipal,
        commitment_id: &PublicationCommitmentId,
    ) -> Result<bool, StoreError> {
        self.ensure_owner(owner)?;
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM publication_commitments WHERE commitment_id=?1)",
            [commitment_id.as_str()],
            |row| row.get::<_, bool>(0),
        )?)
    }
}

enum OwnerAuthorization {
    Current,
    StaleBinding,
    NotMember,
}

fn owner_authorization(
    transaction: &Transaction<'_>,
    registration: &Registration,
    group_id: &GroupId,
) -> Result<OwnerAuthorization, StoreError> {
    let current: i64 = transaction.query_row(
        "SELECT current_binding_revision FROM peers WHERE peer_id=?1",
        [registration.peer_id.as_str()],
        |row| row.get(0),
    )?;
    if current != registration.binding_revision {
        return Ok(OwnerAuthorization::StaleBinding);
    }
    let member = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM group_memberships INDEXED BY membership_active_by_group WHERE group_id=?1 AND peer_id=?2 AND removed_policy_revision IS NULL)",
        [group_id.as_str(), registration.peer_id.as_str()],
        |row| row.get::<_, bool>(0),
    )?;
    Ok(if member {
        OwnerAuthorization::Current
    } else {
        OwnerAuthorization::NotMember
    })
}

/// Active, bound to the owner's current binding, and the owner is an active
/// member of the explicit group. Anything else is unavailable for reading.
fn require_available(
    transaction: &Transaction<'_>,
    registration: &Registration,
    group_id: &GroupId,
) -> Result<(), StoreError> {
    if registration.state != SourceState::Active {
        return Err(StoreError::SourceUnavailable {
            reason: "source registration is not active",
        });
    }
    match owner_authorization(transaction, registration, group_id)? {
        OwnerAuthorization::Current => Ok(()),
        OwnerAuthorization::StaleBinding => Err(StoreError::SourceUnavailable {
            reason: "source owner binding changed; re-establishment required",
        }),
        OwnerAuthorization::NotMember => Err(StoreError::SourceUnavailable {
            reason: "source owner is not an active member of this group",
        }),
    }
}

/// Send-time authorization of a citation. Unlike reads, an owner who is not a
/// member of the target group is an authorization failure for the sender.
pub(super) fn authorize_attachment(
    transaction: &Transaction<'_>,
    group_id: &GroupId,
    attachment: &SourceAttachment,
) -> Result<AuthorizedAttachment, StoreError> {
    let registration = load_registration(transaction, &attachment.source_id)?
        .ok_or(StoreError::NotFound { kind: "source" })?;
    if registration.state != SourceState::Active {
        return Err(StoreError::SourceUnavailable {
            reason: "cited source registration is not active",
        });
    }
    match owner_authorization(transaction, &registration, group_id)? {
        OwnerAuthorization::Current => {}
        OwnerAuthorization::StaleBinding => {
            return Err(StoreError::SourceUnavailable {
                reason: "cited source owner binding changed; re-establishment required",
            })
        }
        OwnerAuthorization::NotMember => {
            return Err(StoreError::Unauthorized {
                reason: "cited source owner is not an active member of this group",
            })
        }
    }
    Ok(AuthorizedAttachment {
        source_id: registration.source_id,
        source_kind: registration.source_kind,
        owner_peer_id: registration.peer_id,
        registration_epoch: registration.registration_epoch,
        snapshot_reference: attachment.snapshot_reference.clone(),
    })
}

fn require_current_binding(
    transaction: &Transaction<'_>,
    descriptor: &VerifiedSourceDescriptor,
) -> Result<(), StoreError> {
    let current = transaction
        .query_row(
            "SELECT p.current_binding_revision,b.conversation_id FROM peers p JOIN peer_bindings b ON b.peer_id=p.peer_id AND b.binding_revision=p.current_binding_revision WHERE p.peer_id=?1",
            [descriptor.peer_id.as_str()],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or(StoreError::NotFound { kind: "peer" })?;
    if current.0 != descriptor.binding_revision.as_sql_i64() {
        return Err(StoreError::StaleBinding);
    }
    if current.1 != descriptor.conversation_id {
        return Err(StoreError::Unauthorized {
            reason: "source evidence names a different conversation than the current binding",
        });
    }
    Ok(())
}

fn require_active_capacity(
    transaction: &Transaction<'_>,
    descriptor: &VerifiedSourceDescriptor,
    excluding: Option<&SourceId>,
) -> Result<(), StoreError> {
    let active: i64 = transaction.query_row(
        "SELECT count(*) FROM source_registrations INDEXED BY source_registrations_active_by_binding WHERE peer_id=?1 AND binding_revision=?2 AND state='active' AND source_id IS NOT ?3",
        params![
            descriptor.peer_id.as_str(),
            descriptor.binding_revision.as_sql_i64(),
            excluding.map(SourceId::as_str)
        ],
        |row| row.get(0),
    )?;
    if usize::try_from(active).unwrap_or(usize::MAX) >= MAX_ACTIVE_SOURCES_PER_BINDING {
        return Err(ValidationError::TooLarge {
            field: "active_sources",
            max: MAX_ACTIVE_SOURCES_PER_BINDING,
        }
        .into());
    }
    Ok(())
}

fn insert_registration(
    transaction: &Transaction<'_>,
    source_id: &SourceId,
    descriptor: &VerifiedSourceDescriptor,
    now: i64,
) -> Result<(), StoreError> {
    transaction.execute(
        "INSERT INTO source_registrations(source_id,peer_id,binding_revision,conversation_id,source_kind,resolver_key,object_identity,evidence_reference,state,registration_epoch,replaced_by_source_id,registered_at_millis,transitioned_at_millis) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'active',1,NULL,?9,?9)",
        params![
            source_id.as_str(),
            descriptor.peer_id.as_str(),
            descriptor.binding_revision.as_sql_i64(),
            descriptor.conversation_id,
            descriptor.source_kind,
            descriptor.resolver_key,
            descriptor.object_identity,
            descriptor.evidence_reference,
            now
        ],
    )?;
    append_history(transaction, source_id)
}

fn append_history(transaction: &Transaction<'_>, source_id: &SourceId) -> Result<(), StoreError> {
    transaction.execute(
        "INSERT INTO source_registration_history(source_id,registration_epoch,state,peer_id,binding_revision,resolver_key,object_identity,evidence_reference,transitioned_at_millis) SELECT source_id,registration_epoch,state,peer_id,binding_revision,resolver_key,object_identity,evidence_reference,transitioned_at_millis FROM source_registrations WHERE source_id=?1",
        [source_id.as_str()],
    )?;
    Ok(())
}

pub(super) fn load_registration(
    transaction: &Transaction<'_>,
    source_id: &SourceId,
) -> Result<Option<Registration>, StoreError> {
    let row = transaction
        .query_row(
            "SELECT peer_id,binding_revision,conversation_id,source_kind,resolver_key,object_identity,evidence_reference,state,registration_epoch,replaced_by_source_id,registered_at_millis,transitioned_at_millis FROM source_registrations WHERE source_id=?1",
            [source_id.as_str()],
            registration_row,
        )
        .optional()?;
    row.map(|row| registration_from_row(source_id.clone(), row))
        .transpose()
}

type RegistrationRow = (
    String,
    i64,
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
    Option<String>,
    i64,
    i64,
);

fn registration_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RegistrationRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        row.get(10)?,
        row.get(11)?,
    ))
}

fn registration_from_row(
    source_id: SourceId,
    row: RegistrationRow,
) -> Result<Registration, StoreError> {
    Ok(Registration {
        source_id,
        peer_id: PeerId::parse(&row.0)?,
        binding_revision: row.1,
        conversation_id: row.2,
        source_kind: row.3,
        resolver_key: row.4,
        object_identity: row.5,
        evidence_reference: row.6,
        state: SourceState::from_stored(&row.7).ok_or(StoreError::Unauthorized {
            reason: "invalid stored source state",
        })?,
        registration_epoch: row.8,
        replaced_by: row.9.as_deref().map(SourceId::parse).transpose()?,
        registered_at_millis: row.10,
        transitioned_at_millis: row.11,
    })
}

fn registration_view(
    registration: &Registration,
    inventory: Revision,
) -> Result<SourceRegistration, StoreError> {
    Ok(SourceRegistration {
        source_id: registration.source_id.clone(),
        peer_id: registration.peer_id.clone(),
        binding_revision: revision_from_sql(registration.binding_revision)?,
        conversation_id: registration.conversation_id.clone(),
        source_kind: registration.source_kind.clone(),
        object_identity: registration.object_identity.clone(),
        state: registration.state,
        registration_epoch: revision_from_sql(registration.registration_epoch)?,
        evidence_reference: registration.evidence_reference.clone(),
        replaced_by: registration.replaced_by.clone(),
        registered_at_millis: registration.registered_at_millis,
        transitioned_at_millis: registration.transitioned_at_millis,
        inventory_revision: inventory,
    })
}

/// One bounded key-ordered page of a peer's registrations in every retained
/// state. `consume` receives at most `max_items + 1` rows and reports whether
/// more exist beyond what it accepted.
pub(super) fn registration_page(
    transaction: &Transaction<'_>,
    peer_id: &PeerId,
    after_source: Option<&SourceId>,
    max_items: usize,
    inventory: Revision,
    consume: impl FnOnce(
        &mut dyn Iterator<Item = Result<SourceRegistration, StoreError>>,
    ) -> Result<bool, StoreError>,
) -> Result<bool, StoreError> {
    let mut statement = transaction.prepare_cached(
        "SELECT source_id,peer_id,binding_revision,conversation_id,source_kind,resolver_key,object_identity,evidence_reference,state,registration_epoch,replaced_by_source_id,registered_at_millis,transitioned_at_millis FROM source_registrations INDEXED BY source_registrations_by_peer WHERE peer_id=?1 AND source_id>?2 ORDER BY source_id LIMIT ?3",
    )?;
    let mut rows = statement
        .query_map(
            params![
                peer_id.as_str(),
                after_source.map_or("", SourceId::as_str),
                page_limit(max_items)
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                        row.get(10)?,
                        row.get(11)?,
                        row.get(12)?,
                    ),
                ))
            },
        )?
        .map(|row| {
            let (source_id, row) = row?;
            registration_view(
                &registration_from_row(SourceId::parse(&source_id)?, row)?,
                inventory,
            )
        });
    consume(&mut rows)
}

/// Active registrations bound to the peer's exact current binding.
pub(super) fn active_source_summaries(
    transaction: &Transaction<'_>,
    peer_id: &PeerId,
    current_binding: i64,
) -> Result<Vec<SourceSummary>, StoreError> {
    let mut statement = transaction.prepare_cached(
        "SELECT source_id,source_kind,registration_epoch FROM source_registrations INDEXED BY source_registrations_active_by_binding WHERE peer_id=?1 AND binding_revision=?2 AND state='active' ORDER BY source_id",
    )?;
    let sources = statement
        .query_map(params![peer_id.as_str(), current_binding], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .map(|row| {
            let (source, kind, epoch) = row?;
            Ok(SourceSummary {
                source_id: SourceId::parse(&source)?,
                source_kind: kind,
                registration_epoch: revision_from_sql(epoch)?,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    Ok(sources)
}
