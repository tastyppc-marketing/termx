use std::collections::BTreeSet;

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

use crate::error::StoreError;
use crate::model::{
    EnrolledPeer, GroupId, GroupRecord, OwnerPrincipal, PeerBindingRecord, PeerId,
    PeerMetadataUpdate, PeerPrincipal, Revision, VerifiedBinding,
};

use super::{now_millis, Store};

impl Store {
    /// Returns owner authority for calls made after the broker has authenticated
    /// its local owner. This constructor is not an external authentication step.
    pub fn trusted_owner(&self) -> OwnerPrincipal {
        OwnerPrincipal::new(self.authority_id.clone())
    }

    pub fn enroll_peer(
        &mut self,
        owner: &OwnerPrincipal,
        binding: VerifiedBinding,
    ) -> Result<EnrolledPeer, StoreError> {
        self.ensure_owner(owner)?;
        let authority_id = self.authority_id.clone();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_millis(&transaction)?;
        let peer_id = PeerId::generate();
        let revision = Revision::new(1)?;
        transaction.execute(
            "INSERT INTO peers(peer_id,current_binding_revision,created_at_millis) VALUES (?1,?2,?3)",
            params![peer_id.as_str(), revision.as_sql_i64(), now],
        )?;
        transaction.execute(
            "INSERT INTO peer_bindings(peer_id,binding_revision,launch_id,terminal_id,harness,conversation_id,model_metadata_json,process_id,process_creation_filetime,live,bound_at_millis) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                peer_id.as_str(),
                revision.as_sql_i64(),
                binding.launch_id.as_str(),
                binding.terminal_id,
                binding.harness,
                binding.conversation_id,
                binding.model_metadata,
                i64::from(binding.process_id),
                i64::try_from(binding.process_creation_filetime).expect("verified binding fits SQLite"),
                binding.is_live,
                now,
            ],
        )?;
        transaction.commit()?;
        let record = PeerBindingRecord {
            peer_id: peer_id.clone(),
            revision,
            launch_id: binding.launch_id,
            terminal_id: binding.terminal_id,
            harness: binding.harness,
            conversation_id: binding.conversation_id,
            model_metadata: binding.model_metadata,
            process_id: binding.process_id,
            process_creation_filetime: binding.process_creation_filetime,
            is_live: binding.is_live,
        };
        Ok(EnrolledPeer {
            record,
            principal: PeerPrincipal::new(authority_id, peer_id, revision),
        })
    }

    pub fn authenticate_peer(
        &self,
        binding: &VerifiedBinding,
    ) -> Result<PeerPrincipal, StoreError> {
        let row = self
            .connection
            .query_row(
                "SELECT p.peer_id, p.current_binding_revision FROM peers p JOIN peer_bindings b ON b.peer_id=p.peer_id AND b.binding_revision=p.current_binding_revision WHERE b.launch_id=?1 AND b.terminal_id=?2 AND b.harness=?3 AND b.conversation_id=?4 AND b.process_id=?5 AND b.process_creation_filetime=?6",
                params![
                    binding.launch_id.as_str(),
                    binding.terminal_id,
                    binding.harness,
                    binding.conversation_id,
                    i64::from(binding.process_id),
                    i64::try_from(binding.process_creation_filetime).expect("verified binding fits SQLite"),
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;
        let Some((peer_id, revision)) = row else {
            return Err(StoreError::Unauthorized {
                reason: "verified binding does not match a current enrollment",
            });
        };
        Ok(PeerPrincipal::new(
            self.authority_id.clone(),
            PeerId::parse(&peer_id)?,
            revision_from_sql(revision)?,
        ))
    }

    pub fn update_peer_metadata(
        &mut self,
        owner: &OwnerPrincipal,
        peer_id: &PeerId,
        expected_binding_revision: Revision,
        update: PeerMetadataUpdate,
    ) -> Result<PeerBindingRecord, StoreError> {
        self.ensure_owner(owner)?;
        update.validate()?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = transaction
            .query_row(
                "SELECT current_binding_revision FROM peers WHERE peer_id=?1",
                [peer_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .ok_or(StoreError::NotFound { kind: "peer" })?;
        if current != expected_binding_revision.as_sql_i64() {
            return Err(StoreError::StaleBinding);
        }
        transaction.execute(
            "UPDATE peer_bindings SET model_metadata_json=?1, live=?2 WHERE peer_id=?3 AND binding_revision=?4",
            params![
                update.model_metadata,
                update.is_live,
                peer_id.as_str(),
                current
            ],
        )?;
        let record = read_binding(&transaction, peer_id, current)?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn create_group(
        &mut self,
        owner: &OwnerPrincipal,
        label: &str,
        members: BTreeSet<PeerId>,
    ) -> Result<GroupRecord, StoreError> {
        self.ensure_owner(owner)?;
        let group_id = GroupId::generate();
        let record = GroupRecord {
            group_id: group_id.clone(),
            policy_revision: Revision::new(1)?,
            label: label.to_owned(),
            paused: false,
        };
        record.validate()?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for peer_id in &members {
            require_peer(&transaction, peer_id)?;
        }
        let now = now_millis(&transaction)?;
        transaction.execute(
            "INSERT INTO groups(group_id,authority_id,policy_revision,label,paused,created_at_millis) VALUES (?1,?2,1,?3,0,?4)",
            params![group_id.as_str(), self.authority_id.as_str(), label, now],
        )?;
        for peer_id in members {
            transaction.execute(
                "INSERT INTO group_memberships(group_id,peer_id,added_policy_revision) VALUES (?1,?2,1)",
                [group_id.as_str(), peer_id.as_str()],
            )?;
        }
        transaction.commit()?;
        Ok(record)
    }

    pub fn set_membership(
        &mut self,
        owner: &OwnerPrincipal,
        group_id: &GroupId,
        peer_id: &PeerId,
        active: bool,
        expected_policy_revision: Revision,
    ) -> Result<GroupRecord, StoreError> {
        self.ensure_owner(owner)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_peer(&transaction, peer_id)?;
        let group = read_group(&transaction, group_id)?;
        require_policy(&group, expected_policy_revision)?;
        let is_active = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM group_memberships WHERE group_id=?1 AND peer_id=?2 AND removed_policy_revision IS NULL)",
            [group_id.as_str(), peer_id.as_str()],
            |row| row.get::<_, bool>(0),
        )?;
        if is_active == active {
            transaction.commit()?;
            return Ok(group);
        }
        let next = Revision::new(group.policy_revision.get() + 1)?;
        transaction.execute(
            "UPDATE groups SET policy_revision=?1 WHERE group_id=?2 AND policy_revision=?3",
            params![
                next.as_sql_i64(),
                group_id.as_str(),
                expected_policy_revision.as_sql_i64()
            ],
        )?;
        if active {
            transaction.execute(
                "INSERT INTO group_memberships(group_id,peer_id,added_policy_revision) VALUES (?1,?2,?3)",
                params![group_id.as_str(), peer_id.as_str(), next.as_sql_i64()],
            )?;
        } else {
            transaction.execute(
                "UPDATE group_memberships SET removed_policy_revision=?1 WHERE group_id=?2 AND peer_id=?3 AND removed_policy_revision IS NULL",
                params![next.as_sql_i64(), group_id.as_str(), peer_id.as_str()],
            )?;
        }
        let result = GroupRecord {
            policy_revision: next,
            ..group
        };
        transaction.commit()?;
        Ok(result)
    }

    pub fn set_group_paused(
        &mut self,
        owner: &OwnerPrincipal,
        group_id: &GroupId,
        paused: bool,
        expected_policy_revision: Revision,
    ) -> Result<GroupRecord, StoreError> {
        self.ensure_owner(owner)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let group = read_group(&transaction, group_id)?;
        require_policy(&group, expected_policy_revision)?;
        if group.paused == paused {
            transaction.commit()?;
            return Ok(group);
        }
        let next = Revision::new(group.policy_revision.get() + 1)?;
        transaction.execute(
            "UPDATE groups SET policy_revision=?1, paused=?2 WHERE group_id=?3 AND policy_revision=?4",
            params![next.as_sql_i64(), paused, group_id.as_str(), expected_policy_revision.as_sql_i64()],
        )?;
        let result = GroupRecord {
            policy_revision: next,
            paused,
            ..group
        };
        transaction.commit()?;
        Ok(result)
    }

    fn ensure_owner(&self, owner: &OwnerPrincipal) -> Result<(), StoreError> {
        if owner.authority_id != self.authority_id {
            return Err(StoreError::AuthorityMismatch);
        }
        Ok(())
    }
}

fn require_policy(group: &GroupRecord, expected: Revision) -> Result<(), StoreError> {
    if group.policy_revision != expected {
        return Err(StoreError::StalePolicy {
            expected: expected.get(),
            actual: group.policy_revision.get(),
        });
    }
    Ok(())
}

fn require_peer(transaction: &Transaction<'_>, peer_id: &PeerId) -> Result<(), StoreError> {
    let exists = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM peers WHERE peer_id=?1)",
        [peer_id.as_str()],
        |row| row.get::<_, bool>(0),
    )?;
    if !exists {
        return Err(StoreError::NotFound { kind: "peer" });
    }
    Ok(())
}

fn read_group(
    transaction: &Transaction<'_>,
    group_id: &GroupId,
) -> Result<GroupRecord, StoreError> {
    transaction
        .query_row(
            "SELECT policy_revision,label,paused FROM groups WHERE group_id=?1",
            [group_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            },
        )
        .optional()?
        .map(
            |(revision, label, paused)| -> Result<GroupRecord, StoreError> {
                Ok(GroupRecord {
                    group_id: group_id.clone(),
                    policy_revision: revision_from_sql(revision)?,
                    label,
                    paused,
                })
            },
        )
        .transpose()?
        .ok_or(StoreError::NotFound { kind: "group" })
}

fn read_binding(
    transaction: &Transaction<'_>,
    peer_id: &PeerId,
    revision: i64,
) -> Result<PeerBindingRecord, StoreError> {
    let row = transaction.query_row(
        "SELECT launch_id,terminal_id,harness,conversation_id,model_metadata_json,process_id,process_creation_filetime,live FROM peer_bindings WHERE peer_id=?1 AND binding_revision=?2",
        params![peer_id.as_str(), revision],
        |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,row.get::<_, String>(3)?,row.get::<_, Option<String>>(4)?,row.get::<_, u32>(5)?,row.get::<_, i64>(6)?,row.get::<_, bool>(7)?)),
    )?;
    Ok(PeerBindingRecord {
        peer_id: peer_id.clone(),
        revision: revision_from_sql(revision)?,
        launch_id: crate::model::LaunchId::parse(&row.0)?,
        terminal_id: row.1,
        harness: row.2,
        conversation_id: row.3,
        model_metadata: row.4,
        process_id: row.5,
        process_creation_filetime: u64::try_from(row.6).map_err(|_| StoreError::Unauthorized {
            reason: "invalid stored FILETIME",
        })?,
        is_live: row.7,
    })
}

pub(super) fn revision_from_sql(value: i64) -> Result<Revision, StoreError> {
    let value = u64::try_from(value).map_err(|_| StoreError::Unauthorized {
        reason: "invalid stored revision",
    })?;
    Ok(Revision::new(value)?)
}
