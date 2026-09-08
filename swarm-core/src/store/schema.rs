use std::path::Path;

use rusqlite::{Connection, TransactionBehavior};

use crate::error::StoreError;
use crate::model::AuthorityId;

pub const APPLICATION_ID: i64 = 0x5458_4d31;
pub const SCHEMA_VERSION: i64 = 6;

pub(super) struct DatabaseIdentity {
    pub application_id: i64,
    pub schema_version: i64,
    pub has_objects: bool,
}

impl DatabaseIdentity {
    pub(super) fn new() -> Self {
        Self {
            application_id: 0,
            schema_version: 0,
            has_objects: false,
        }
    }
}

pub(super) fn validate_identity(
    path: &Path,
    identity: &DatabaseIdentity,
) -> Result<(), StoreError> {
    if identity.application_id == 0 && identity.schema_version == 0 && !identity.has_objects {
        return Ok(());
    }
    if identity.application_id != APPLICATION_ID {
        return Err(StoreError::UnrecognizedDatabase {
            path: path.to_path_buf(),
            application_id: identity.application_id,
            schema_version: identity.schema_version,
        });
    }
    if identity.schema_version < 0 || (identity.schema_version == 0 && identity.has_objects) {
        return Err(StoreError::UnrecognizedDatabase {
            path: path.to_path_buf(),
            application_id: identity.application_id,
            schema_version: identity.schema_version,
        });
    }
    if identity.schema_version > SCHEMA_VERSION {
        return Err(StoreError::FutureSchema {
            found: identity.schema_version,
            supported: SCHEMA_VERSION,
        });
    }
    Ok(())
}

pub(super) fn validate_recognized_schema(
    connection: &Connection,
    path: &Path,
    identity: &DatabaseIdentity,
) -> Result<(), StoreError> {
    if identity.schema_version == 0 {
        return Ok(());
    }

    let authority = connection
        .query_row(
            "SELECT authority_id FROM authority_metadata WHERE singleton = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows | rusqlite::Error::SqliteFailure(_, _) => {
                StoreError::MissingAuthority
            }
            other => StoreError::Sqlite(other),
        })?;
    AuthorityId::parse(&authority)?;

    let expected = Connection::open_in_memory()?;
    expected.execute_batch(SCHEMA_V1)?;
    if identity.schema_version >= 2 {
        expected.execute_batch(MIGRATION_V2)?;
    }
    if identity.schema_version >= 3 {
        expected.execute_batch(MIGRATION_V3)?;
    }
    if identity.schema_version >= 4 {
        expected.execute_batch(MIGRATION_V4)?;
    }
    if identity.schema_version >= 5 {
        expected.execute_batch(MIGRATION_V5)?;
    }
    if identity.schema_version >= 6 {
        expected.execute_batch(MIGRATION_V6)?;
    }
    if schema_manifest(connection)? != schema_manifest(&expected)? {
        return Err(StoreError::UnrecognizedDatabase {
            path: path.to_path_buf(),
            application_id: identity.application_id,
            schema_version: identity.schema_version,
        });
    }
    Ok(())
}

fn schema_manifest(connection: &Connection) -> Result<Vec<(String, String, String)>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT type, name, sql FROM sqlite_schema \
         WHERE name NOT GLOB 'sqlite_*' AND sql IS NOT NULL \
         ORDER BY type, name",
    )?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub(super) fn migrate(
    connection: &mut Connection,
    identity: DatabaseIdentity,
) -> Result<(), StoreError> {
    migrate_with_final_sql(connection, identity, None)
}

fn migrate_with_final_sql(
    connection: &mut Connection,
    identity: DatabaseIdentity,
    final_sql: Option<&str>,
) -> Result<(), StoreError> {
    if identity.schema_version == SCHEMA_VERSION {
        return Ok(());
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if identity.schema_version == 0 {
        let authority_id = AuthorityId::generate();
        transaction.execute_batch(SCHEMA_V1)?;
        transaction.execute(
            "INSERT INTO authority_metadata(singleton, authority_id, created_at_millis) VALUES (1, ?1, unixepoch('subsec') * 1000)",
            [authority_id.as_str()],
        )?;
        transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
    }
    if identity.schema_version < 2 {
        transaction.execute_batch(MIGRATION_V2)?;
    }
    if identity.schema_version < 3 {
        transaction.execute_batch(MIGRATION_V3)?;
    }
    if identity.schema_version < 4 {
        transaction.execute_batch(MIGRATION_V4)?;
    }
    if identity.schema_version < 5 {
        transaction.execute_batch(MIGRATION_V5)?;
    }
    if identity.schema_version < 6 {
        transaction.execute_batch(MIGRATION_V6)?;
    }
    transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    if let Some(sql) = final_sql {
        transaction.execute_batch(sql)?;
    }
    transaction.commit()?;
    Ok(())
}

const SCHEMA_V1: &str = r#"
CREATE TABLE authority_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    authority_id TEXT NOT NULL UNIQUE,
    created_at_millis INTEGER NOT NULL
) STRICT;

CREATE TABLE peers (
    peer_id TEXT PRIMARY KEY,
    current_binding_revision INTEGER NOT NULL CHECK (current_binding_revision >= 1),
    created_at_millis INTEGER NOT NULL,
    FOREIGN KEY (peer_id, current_binding_revision) REFERENCES peer_bindings(peer_id, binding_revision) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE peer_bindings (
    peer_id TEXT NOT NULL REFERENCES peers(peer_id),
    binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
    launch_id TEXT NOT NULL,
    terminal_id TEXT NOT NULL CHECK (length(CAST(terminal_id AS BLOB)) BETWEEN 1 AND 4096),
    harness TEXT NOT NULL CHECK (length(CAST(harness AS BLOB)) BETWEEN 1 AND 256),
    conversation_id TEXT NOT NULL CHECK (length(CAST(conversation_id AS BLOB)) BETWEEN 1 AND 4096),
    model_metadata_json TEXT CHECK (length(CAST(model_metadata_json AS BLOB)) <= 4096),
    process_id INTEGER NOT NULL CHECK (process_id >= 0 AND process_id <= 4294967295),
    process_creation_filetime INTEGER NOT NULL CHECK (process_creation_filetime >= 0),
    live INTEGER NOT NULL CHECK (live IN (0, 1)),
    bound_at_millis INTEGER NOT NULL,
    PRIMARY KEY (peer_id, binding_revision),
    UNIQUE (launch_id),
    UNIQUE (terminal_id, launch_id)
) STRICT;

CREATE TABLE groups (
    group_id TEXT PRIMARY KEY,
    authority_id TEXT NOT NULL REFERENCES authority_metadata(authority_id),
    policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
    next_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_sequence >= 1),
    label TEXT NOT NULL CHECK (length(CAST(label AS BLOB)) BETWEEN 1 AND 256),
    paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
    created_at_millis INTEGER NOT NULL
) STRICT;

CREATE TABLE group_memberships (
    group_id TEXT NOT NULL REFERENCES groups(group_id),
    peer_id TEXT NOT NULL REFERENCES peers(peer_id),
    added_policy_revision INTEGER NOT NULL CHECK (added_policy_revision >= 1),
    removed_policy_revision INTEGER CHECK (removed_policy_revision IS NULL OR removed_policy_revision >= added_policy_revision),
    PRIMARY KEY (group_id, peer_id, added_policy_revision)
) STRICT;

CREATE TABLE messages (
    message_id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(group_id),
    group_sequence INTEGER NOT NULL CHECK (group_sequence >= 1),
    sender_peer_id TEXT NOT NULL REFERENCES peers(peer_id),
    sender_binding_revision INTEGER NOT NULL,
    client_key TEXT NOT NULL CHECK (length(CAST(client_key AS BLOB)) BETWEEN 1 AND 256),
    semantic_payload_json TEXT NOT NULL CHECK (length(CAST(semantic_payload_json AS BLOB)) BETWEEN 1 AND 8388608),
    body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) BETWEEN 1 AND 1048576),
    topic TEXT CHECK (length(CAST(topic AS BLOB)) BETWEEN 1 AND 512),
    reply_to_message_id TEXT REFERENCES messages(message_id),
    committed_at_millis INTEGER NOT NULL,
    UNIQUE (group_id, group_sequence),
    UNIQUE (group_id, sender_peer_id, client_key),
    FOREIGN KEY (sender_peer_id, sender_binding_revision) REFERENCES peer_bindings(peer_id, binding_revision)
) STRICT;

CREATE TABLE recipient_deliveries (
    message_id TEXT NOT NULL REFERENCES messages(message_id),
    recipient_peer_id TEXT NOT NULL REFERENCES peers(peer_id),
    recipient_binding_revision INTEGER NOT NULL,
    saved_at_millis INTEGER NOT NULL,
    fetched_generation INTEGER CHECK (fetched_generation IS NULL OR fetched_generation >= 1),
    fetched_at_millis INTEGER,
    acknowledged_generation INTEGER CHECK (acknowledged_generation IS NULL OR acknowledged_generation >= 1),
    acknowledged_at_millis INTEGER,
    replied_by_message_id TEXT REFERENCES messages(message_id),
    PRIMARY KEY (message_id, recipient_peer_id),
    FOREIGN KEY (recipient_peer_id, recipient_binding_revision) REFERENCES peer_bindings(peer_id, binding_revision),
    CHECK ((fetched_generation IS NULL) = (fetched_at_millis IS NULL)),
    CHECK ((acknowledged_generation IS NULL) = (acknowledged_at_millis IS NULL))
) STRICT;

CREATE TABLE acknowledgements (
    message_id TEXT NOT NULL,
    recipient_peer_id TEXT NOT NULL,
    binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    fetched_at_millis INTEGER,
    acknowledged_at_millis INTEGER,
    PRIMARY KEY (message_id, recipient_peer_id, binding_revision, generation),
    FOREIGN KEY (message_id, recipient_peer_id) REFERENCES recipient_deliveries(message_id, recipient_peer_id),
    CHECK (fetched_at_millis IS NOT NULL OR acknowledged_at_millis IS NOT NULL)
) STRICT;

CREATE TABLE delivery_attempts (
    attempt_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    recipient_peer_id TEXT NOT NULL,
    binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    started_at_millis INTEGER NOT NULL,
    completed_at_millis INTEGER,
    outcome TEXT CHECK (length(CAST(outcome AS BLOB)) <= 4096),
    native_reference TEXT CHECK (length(CAST(native_reference AS BLOB)) <= 4096),
    UNIQUE (message_id, recipient_peer_id, binding_revision, generation, attempt_number),
    FOREIGN KEY (message_id, recipient_peer_id) REFERENCES recipient_deliveries(message_id, recipient_peer_id),
    CHECK ((completed_at_millis IS NULL AND outcome IS NULL) OR (completed_at_millis IS NOT NULL AND outcome IS NOT NULL))
) STRICT;

CREATE TABLE continuations (
    peer_id TEXT NOT NULL REFERENCES peers(peer_id),
    predecessor_binding_revision INTEGER NOT NULL,
    successor_binding_revision INTEGER NOT NULL,
    group_id TEXT NOT NULL REFERENCES groups(group_id),
    policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
    intent_reference TEXT NOT NULL CHECK (length(CAST(intent_reference AS BLOB)) BETWEEN 1 AND 4096),
    committed_at_millis INTEGER NOT NULL,
    PRIMARY KEY (peer_id, predecessor_binding_revision, successor_binding_revision, group_id),
    UNIQUE (peer_id, predecessor_binding_revision, group_id),
    FOREIGN KEY (peer_id, predecessor_binding_revision) REFERENCES peer_bindings(peer_id, binding_revision),
    FOREIGN KEY (peer_id, successor_binding_revision) REFERENCES peer_bindings(peer_id, binding_revision),
    CHECK (successor_binding_revision > predecessor_binding_revision)
) STRICT;

CREATE INDEX membership_active_by_peer ON group_memberships(peer_id, group_id) WHERE removed_policy_revision IS NULL;
CREATE INDEX messages_by_group_sequence ON messages(group_id, group_sequence);
CREATE INDEX deliveries_by_recipient ON recipient_deliveries(recipient_peer_id, message_id);
CREATE INDEX attempts_unfinished ON delivery_attempts(recipient_peer_id, started_at_millis) WHERE completed_at_millis IS NULL;
"#;

const MIGRATION_V2: &str = r#"
ALTER TABLE recipient_deliveries ADD COLUMN delivery_generation INTEGER NOT NULL DEFAULT 1 CHECK (delivery_generation >= 1);

CREATE TABLE mailbox_cursors (
    cursor_id TEXT PRIMARY KEY,
    authority_id TEXT NOT NULL REFERENCES authority_metadata(authority_id),
    group_id TEXT NOT NULL REFERENCES groups(group_id),
    peer_id TEXT NOT NULL REFERENCES peers(peer_id),
    binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
    policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
    snapshot_high_sequence INTEGER NOT NULL CHECK (snapshot_high_sequence >= 0),
    position_sequence INTEGER NOT NULL CHECK (position_sequence >= 0 AND position_sequence <= snapshot_high_sequence),
    created_at_millis INTEGER NOT NULL,
    expires_at_millis INTEGER NOT NULL CHECK (expires_at_millis >= created_at_millis),
    FOREIGN KEY (peer_id, binding_revision) REFERENCES peer_bindings(peer_id, binding_revision)
) STRICT;

CREATE INDEX mailbox_cursors_by_scope ON mailbox_cursors(group_id, peer_id, expires_at_millis);
"#;

const MIGRATION_V3: &str = r#"
CREATE TABLE recipient_ack_order (
    message_id TEXT NOT NULL,
    recipient_peer_id TEXT NOT NULL,
    group_id TEXT NOT NULL REFERENCES groups(group_id),
    group_sequence INTEGER NOT NULL CHECK (group_sequence >= 1),
    binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    acknowledged INTEGER NOT NULL CHECK (acknowledged IN (0, 1)),
    PRIMARY KEY (message_id, recipient_peer_id),
    UNIQUE (group_id, recipient_peer_id, binding_revision, generation, group_sequence),
    FOREIGN KEY (message_id, recipient_peer_id) REFERENCES recipient_deliveries(message_id, recipient_peer_id),
    FOREIGN KEY (recipient_peer_id, binding_revision) REFERENCES peer_bindings(peer_id, binding_revision)
) STRICT;

CREATE INDEX recipient_ack_unresolved ON recipient_ack_order(group_id, recipient_peer_id, binding_revision, generation, group_sequence) WHERE acknowledged = 0;
CREATE INDEX recipient_ack_sequence ON recipient_ack_order(group_id, recipient_peer_id, binding_revision, generation, group_sequence);

CREATE TABLE acknowledgement_watermarks (
    group_id TEXT NOT NULL REFERENCES groups(group_id),
    recipient_peer_id TEXT NOT NULL,
    binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    contiguous_group_sequence INTEGER NOT NULL CHECK (contiguous_group_sequence >= 0),
    updated_at_millis INTEGER NOT NULL,
    PRIMARY KEY (group_id, recipient_peer_id, binding_revision, generation),
    FOREIGN KEY (recipient_peer_id, binding_revision) REFERENCES peer_bindings(peer_id, binding_revision)
) STRICT;

INSERT INTO recipient_ack_order(message_id,recipient_peer_id,group_id,group_sequence,binding_revision,generation,acknowledged)
SELECT d.message_id,d.recipient_peer_id,m.group_id,m.group_sequence,d.recipient_binding_revision,d.delivery_generation,
       EXISTS(SELECT 1 FROM acknowledgements a WHERE a.message_id=d.message_id AND a.recipient_peer_id=d.recipient_peer_id AND a.binding_revision=d.recipient_binding_revision AND a.generation=d.delivery_generation AND a.acknowledged_at_millis IS NOT NULL)
FROM recipient_deliveries d
JOIN messages m ON m.message_id=d.message_id
WHERE m.sender_peer_id <> d.recipient_peer_id;
"#;

const MIGRATION_V4: &str = r#"
CREATE TABLE delivery_generations (
 message_id TEXT NOT NULL,
 recipient_peer_id TEXT NOT NULL,
 binding_revision INTEGER NOT NULL,
 generation INTEGER NOT NULL CHECK(generation >= 1),
 PRIMARY KEY(message_id,recipient_peer_id,binding_revision,generation),
 FOREIGN KEY(message_id,recipient_peer_id) REFERENCES recipient_deliveries(message_id,recipient_peer_id),
 FOREIGN KEY(recipient_peer_id,binding_revision) REFERENCES peer_bindings(peer_id,binding_revision)
) STRICT;
INSERT INTO delivery_generations
 SELECT message_id,recipient_peer_id,recipient_binding_revision,delivery_generation FROM recipient_deliveries
 UNION SELECT message_id,recipient_peer_id,binding_revision,generation FROM acknowledgements
 UNION SELECT message_id,recipient_peer_id,binding_revision,generation FROM delivery_attempts;

-- Keep the exact predecessor evidence tables as migration archives. New active
-- history tables reference real immutable generation identities, not latest rows.
ALTER TABLE acknowledgements RENAME TO acknowledgements_v3_archive;
CREATE TABLE acknowledgements (
 message_id TEXT NOT NULL,
 recipient_peer_id TEXT NOT NULL,
 binding_revision INTEGER NOT NULL CHECK(binding_revision >= 1),
 generation INTEGER NOT NULL CHECK(generation >= 1),
 fetched_at_millis INTEGER,
 acknowledged_at_millis INTEGER,
 PRIMARY KEY(message_id,recipient_peer_id,binding_revision,generation),
 FOREIGN KEY(message_id,recipient_peer_id,binding_revision,generation) REFERENCES delivery_generations(message_id,recipient_peer_id,binding_revision,generation),
 CHECK(fetched_at_millis IS NOT NULL OR acknowledged_at_millis IS NOT NULL)
) STRICT;
INSERT INTO acknowledgements SELECT * FROM acknowledgements_v3_archive;
ALTER TABLE delivery_attempts RENAME TO delivery_attempts_v3_archive;
CREATE TABLE delivery_attempts (
 attempt_id TEXT PRIMARY KEY,
 message_id TEXT NOT NULL,
 recipient_peer_id TEXT NOT NULL,
 binding_revision INTEGER NOT NULL CHECK(binding_revision >= 1),
 generation INTEGER NOT NULL CHECK(generation >= 1),
 attempt_number INTEGER NOT NULL CHECK(attempt_number >= 1),
 started_at_millis INTEGER NOT NULL,
 completed_at_millis INTEGER,
 outcome TEXT CHECK(length(CAST(outcome AS BLOB)) <= 4096),
 native_reference TEXT CHECK(length(CAST(native_reference AS BLOB)) <= 4096),
 recovered_uncertain_at_millis INTEGER,
 UNIQUE(message_id,recipient_peer_id,binding_revision,generation,attempt_number),
 FOREIGN KEY(message_id,recipient_peer_id,binding_revision,generation) REFERENCES delivery_generations(message_id,recipient_peer_id,binding_revision,generation),
 CHECK((completed_at_millis IS NULL AND outcome IS NULL) OR (completed_at_millis IS NOT NULL AND outcome IS NOT NULL))
) STRICT;
INSERT INTO delivery_attempts(attempt_id,message_id,recipient_peer_id,binding_revision,generation,attempt_number,started_at_millis,completed_at_millis,outcome,native_reference) SELECT * FROM delivery_attempts_v3_archive;
CREATE INDEX active_attempts_unfinished ON delivery_attempts(started_at_millis) WHERE completed_at_millis IS NULL;

CREATE TABLE current_deliveries (
 message_id TEXT NOT NULL,
 recipient_peer_id TEXT NOT NULL,
 recipient_binding_revision INTEGER NOT NULL,
 delivery_generation INTEGER NOT NULL CHECK(delivery_generation >= 1),
 group_id TEXT NOT NULL REFERENCES groups(group_id),
 group_sequence INTEGER NOT NULL CHECK(group_sequence >= 1),
 notification_revision INTEGER NOT NULL DEFAULT 1 CHECK(notification_revision >= 1),
 route_state TEXT NOT NULL DEFAULT 'ready' CHECK(route_state IN ('ready','held','in_flight','transport_written','native_queued','uncertain')),
 last_attempt_id TEXT REFERENCES delivery_attempts(attempt_id),
 fetched_generation INTEGER,
 fetched_at_millis INTEGER,
 acknowledged_generation INTEGER,
 acknowledged_at_millis INTEGER,
 replied_by_message_id TEXT REFERENCES messages(message_id),
 PRIMARY KEY(message_id,recipient_peer_id),
 FOREIGN KEY(message_id,recipient_peer_id,recipient_binding_revision,delivery_generation) REFERENCES delivery_generations(message_id,recipient_peer_id,binding_revision,generation),
 CHECK((fetched_generation IS NULL) = (fetched_at_millis IS NULL)),
 CHECK((acknowledged_generation IS NULL) = (acknowledged_at_millis IS NULL))
) STRICT;
INSERT INTO current_deliveries(message_id,recipient_peer_id,recipient_binding_revision,delivery_generation,group_id,group_sequence,route_state,fetched_generation,fetched_at_millis,acknowledged_generation,acknowledged_at_millis,replied_by_message_id)
 SELECT d.message_id,d.recipient_peer_id,d.recipient_binding_revision,d.delivery_generation,m.group_id,m.group_sequence,
 CASE WHEN EXISTS(SELECT 1 FROM delivery_attempts a WHERE a.message_id=d.message_id AND a.recipient_peer_id=d.recipient_peer_id) THEN 'uncertain' ELSE 'ready' END,
 d.fetched_generation,d.fetched_at_millis,d.acknowledged_generation,d.acknowledged_at_millis,d.replied_by_message_id
 FROM recipient_deliveries d JOIN messages m ON m.message_id=d.message_id;
CREATE INDEX current_delivery_candidates ON current_deliveries(group_id,recipient_peer_id,recipient_binding_revision,group_sequence) WHERE route_state='ready' AND fetched_at_millis IS NULL AND acknowledged_at_millis IS NULL AND replied_by_message_id IS NULL;
CREATE INDEX current_delivery_binding ON current_deliveries(recipient_peer_id,recipient_binding_revision,group_id);
CREATE INDEX current_delivery_attempt ON current_deliveries(last_attempt_id);
CREATE TRIGGER original_delivery_identity_immutable BEFORE UPDATE OF recipient_binding_revision,delivery_generation ON recipient_deliveries
 BEGIN SELECT RAISE(ABORT,'original delivery identity is immutable'); END;
CREATE TRIGGER initialize_current_delivery AFTER INSERT ON recipient_deliveries BEGIN
 INSERT INTO delivery_generations VALUES(NEW.message_id,NEW.recipient_peer_id,NEW.recipient_binding_revision,NEW.delivery_generation);
 INSERT INTO current_deliveries(message_id,recipient_peer_id,recipient_binding_revision,delivery_generation,group_id,group_sequence,fetched_generation,fetched_at_millis,acknowledged_generation,acknowledged_at_millis,replied_by_message_id)
 SELECT NEW.message_id,NEW.recipient_peer_id,NEW.recipient_binding_revision,NEW.delivery_generation,m.group_id,m.group_sequence,NEW.fetched_generation,NEW.fetched_at_millis,NEW.acknowledged_generation,NEW.acknowledged_at_millis,NEW.replied_by_message_id FROM messages m WHERE m.message_id=NEW.message_id;
 END;
CREATE TRIGGER preserve_original_generation_evidence AFTER UPDATE OF fetched_at_millis,acknowledged_at_millis,replied_by_message_id ON current_deliveries BEGIN
 UPDATE recipient_deliveries SET fetched_generation=NEW.fetched_generation,fetched_at_millis=NEW.fetched_at_millis,acknowledged_generation=NEW.acknowledged_generation,acknowledged_at_millis=NEW.acknowledged_at_millis,replied_by_message_id=NEW.replied_by_message_id
 WHERE message_id=NEW.message_id AND recipient_peer_id=NEW.recipient_peer_id AND recipient_binding_revision=NEW.recipient_binding_revision AND delivery_generation=NEW.delivery_generation;
 END;
CREATE TABLE broker_runs (
 run_revision INTEGER PRIMARY KEY CHECK(run_revision >= 1),
 recovered_at_millis INTEGER NOT NULL
) STRICT;
CREATE TABLE delivery_tickets (
 attempt_id TEXT PRIMARY KEY REFERENCES delivery_attempts(attempt_id),
 authority_id TEXT NOT NULL REFERENCES authority_metadata(authority_id),
 group_id TEXT NOT NULL REFERENCES groups(group_id),
 policy_revision INTEGER NOT NULL CHECK(policy_revision >= 1),
 notification_revision INTEGER NOT NULL CHECK(notification_revision >= 1),
 run_revision INTEGER NOT NULL REFERENCES broker_runs(run_revision),
 binding_snapshot_json TEXT NOT NULL
) STRICT;
CREATE TABLE attempt_not_submitted_reconciliations (
 attempt_id TEXT PRIMARY KEY REFERENCES delivery_attempts(attempt_id),
 evidence_reference TEXT NOT NULL CHECK(length(CAST(evidence_reference AS BLOB)) BETWEEN 1 AND 4096),
 reconciled_at_millis INTEGER NOT NULL
) STRICT;
CREATE TABLE continuation_intents (
 peer_id TEXT NOT NULL,
 predecessor_binding_revision INTEGER NOT NULL,
 successor_binding_revision INTEGER NOT NULL,
 intent_reference TEXT NOT NULL CHECK(length(CAST(intent_reference AS BLOB)) BETWEEN 1 AND 4096),
 branch_evidence TEXT NOT NULL CHECK(length(CAST(branch_evidence AS BLOB)) BETWEEN 1 AND 4096),
 semantic_json TEXT NOT NULL,
 committed_at_millis INTEGER NOT NULL,
 PRIMARY KEY(peer_id,predecessor_binding_revision),
 FOREIGN KEY(peer_id,predecessor_binding_revision) REFERENCES peer_bindings(peer_id,binding_revision),
 FOREIGN KEY(peer_id,successor_binding_revision) REFERENCES peer_bindings(peer_id,binding_revision),
 CHECK(successor_binding_revision > predecessor_binding_revision)
) STRICT;
"#;

const MIGRATION_V5: &str = r#"
CREATE TABLE binding_acknowledgement_watermarks (
    group_id TEXT NOT NULL REFERENCES groups(group_id),
    recipient_peer_id TEXT NOT NULL,
    binding_revision INTEGER NOT NULL CHECK(binding_revision >= 1),
    contiguous_group_sequence INTEGER NOT NULL CHECK(contiguous_group_sequence >= 0),
    updated_at_millis INTEGER NOT NULL,
    PRIMARY KEY(group_id,recipient_peer_id,binding_revision),
    FOREIGN KEY(recipient_peer_id,binding_revision) REFERENCES peer_bindings(peer_id,binding_revision)
) STRICT;
CREATE INDEX recipient_ack_binding_unresolved ON recipient_ack_order(group_id,recipient_peer_id,binding_revision,group_sequence) WHERE acknowledged=0;
CREATE INDEX recipient_ack_binding_sequence ON recipient_ack_order(group_id,recipient_peer_id,binding_revision,group_sequence);
-- Retain historical per-generation watermarks verbatim. They cannot safely seed
-- a binding-wide lower bound: another generation may contain an earlier gap.
-- The first current ACK starts at zero and resolves its bound with indexed seeks.
"#;

// Versions 4 and 5 may have materialized the pre-fix I1 ordering: a delayed
// native observation replaced ready routing after trusted cancellation. Repair
// only its exact still-current projection; keep both historical facts intact.
const MIGRATION_V6: &str = r#"
UPDATE current_deliveries SET route_state='ready'
WHERE route_state IN ('held','native_queued','transport_written','uncertain')
  AND fetched_at_millis IS NULL
  AND acknowledged_at_millis IS NULL
  AND replied_by_message_id IS NULL
  AND EXISTS (
      SELECT 1 FROM delivery_attempts a
      JOIN attempt_not_submitted_reconciliations r ON r.attempt_id=a.attempt_id
      WHERE a.attempt_id=current_deliveries.last_attempt_id
        AND a.message_id=current_deliveries.message_id
        AND a.recipient_peer_id=current_deliveries.recipient_peer_id
        AND a.binding_revision=current_deliveries.recipient_binding_revision
        AND a.generation=current_deliveries.delivery_generation
  )
  AND NOT EXISTS (
      SELECT 1 FROM acknowledgements a
      WHERE a.message_id=current_deliveries.message_id
        AND a.recipient_peer_id=current_deliveries.recipient_peer_id
        AND a.binding_revision=current_deliveries.recipient_binding_revision
        AND a.generation=current_deliveries.delivery_generation
        AND (a.fetched_at_millis IS NOT NULL OR a.acknowledged_at_millis IS NOT NULL)
  );
"#;

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::time::{SystemTime, UNIX_EPOCH};

    use rusqlite::params;

    use crate::model::{
        FrozenRecipient, GroupId, MessageCommitOutcome, MessageId, PeerId, Revision,
        SendMessageRequest, SendReceipt, VerifiedBinding,
    };

    use super::*;

    fn retained_path(name: &str) -> std::path::PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("retired")
            .join("test-artifacts")
            .join("swarm-core")
            .join(format!("{name}-{timestamp}"));
        std::fs::create_dir_all(&directory).unwrap();
        directory.join("swarm.sqlite")
    }

    fn migrated_binding(name: &str, launch_id: &str, process_id: u32) -> VerifiedBinding {
        VerifiedBinding::trusted(
            launch_id.to_owned(),
            format!("{name}-terminal"),
            "codex".to_owned(),
            format!("{name}-conversation"),
            None,
            process_id,
            u64::from(process_id),
            true,
        )
        .unwrap()
    }

    #[test]
    fn failure_after_authority_and_version_updates_rolls_back_entire_migration() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE late_conflict(marker TEXT NOT NULL);\
                 INSERT INTO late_conflict VALUES ('preserve-me');",
            )
            .unwrap();
        let identity = DatabaseIdentity::new();

        assert!(migrate_with_final_sql(
            &mut connection,
            identity,
            Some("CREATE TABLE late_conflict(value TEXT);")
        )
        .is_err());

        assert_eq!(
            connection
                .pragma_query_value(None, "application_id", |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT marker FROM late_conflict", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "preserve-me"
        );
        let migrated_tables: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name = 'authority_metadata'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(migrated_tables, 0);
    }

    #[test]
    fn recognized_version_one_migrates_transactionally_without_losing_data() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(SCHEMA_V1).unwrap();
        connection
            .execute(
                "INSERT INTO authority_metadata(singleton,authority_id,created_at_millis) VALUES (1,'a_00112233445566778899aabbccddeeff',1)",
                [],
            )
            .unwrap();
        connection
            .execute_batch(
                "BEGIN;
                 INSERT INTO peers(peer_id,current_binding_revision,created_at_millis) VALUES ('p_00000000000000000000000000000001',1,1);
                 INSERT INTO peer_bindings(peer_id,binding_revision,launch_id,terminal_id,harness,conversation_id,process_id,process_creation_filetime,live,bound_at_millis) VALUES ('p_00000000000000000000000000000001',1,'l_00000000000000000000000000000001','sender-terminal','codex','sender-conversation',1,1,1,1);
                 INSERT INTO peers(peer_id,current_binding_revision,created_at_millis) VALUES ('p_00000000000000000000000000000002',1,1);
                 INSERT INTO peer_bindings(peer_id,binding_revision,launch_id,terminal_id,harness,conversation_id,process_id,process_creation_filetime,live,bound_at_millis) VALUES ('p_00000000000000000000000000000002',1,'l_00000000000000000000000000000002','recipient-terminal','codex','recipient-conversation',2,2,1,1);
                 INSERT INTO groups(group_id,authority_id,policy_revision,next_sequence,label,paused,created_at_millis) VALUES ('g_00000000000000000000000000000001','a_00112233445566778899aabbccddeeff',1,2,'migrated',0,1);
                 INSERT INTO group_memberships(group_id,peer_id,added_policy_revision) VALUES ('g_00000000000000000000000000000001','p_00000000000000000000000000000001',1);
                 INSERT INTO group_memberships(group_id,peer_id,added_policy_revision) VALUES ('g_00000000000000000000000000000001','p_00000000000000000000000000000002',1);
                 COMMIT;",
            )
            .unwrap();
        let preserved_body = "preserve \"quoted\"\n\u{0001}";
        connection
            .execute(
                "INSERT INTO messages(message_id,group_id,group_sequence,sender_peer_id,sender_binding_revision,client_key,semantic_payload_json,body,committed_at_millis) VALUES ('m_00000000000000000000000000000001','g_00000000000000000000000000000001',1,'p_00000000000000000000000000000001',1,'migration-key','{}',?1,1)",
                [preserved_body],
            )
            .unwrap();
        connection
            .execute_batch(
                "INSERT INTO recipient_deliveries(message_id,recipient_peer_id,recipient_binding_revision,saved_at_millis,fetched_generation,fetched_at_millis,acknowledged_generation,acknowledged_at_millis) VALUES ('m_00000000000000000000000000000001','p_00000000000000000000000000000002',1,1,1,2,1,3);
                 INSERT INTO acknowledgements(message_id,recipient_peer_id,binding_revision,generation,fetched_at_millis,acknowledged_at_millis) VALUES ('m_00000000000000000000000000000001','p_00000000000000000000000000000002',1,1,2,3);",
            )
            .unwrap();
        connection
            .pragma_update(None, "application_id", APPLICATION_ID)
            .unwrap();
        connection.pragma_update(None, "user_version", 1).unwrap();
        let identity = DatabaseIdentity {
            application_id: APPLICATION_ID,
            schema_version: 1,
            has_objects: true,
        };

        migrate(&mut connection, identity).unwrap();

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            connection
                .query_row("SELECT authority_id FROM authority_metadata", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "a_00112233445566778899aabbccddeeff"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM pragma_table_info('recipient_deliveries') WHERE name='delivery_generation'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='mailbox_cursors'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT body FROM messages WHERE message_id='m_00000000000000000000000000000001'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            preserved_body
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT delivery_generation FROM recipient_deliveries WHERE message_id='m_00000000000000000000000000000001'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT generation,acknowledged FROM recipient_ack_order WHERE message_id='m_00000000000000000000000000000001'",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, bool>(1)?)),
                )
                .unwrap(),
            (1, true)
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT fetched_at_millis,acknowledged_at_millis FROM acknowledgements WHERE message_id='m_00000000000000000000000000000001'",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )
                .unwrap(),
            (2, 3)
        );
    }

    #[test]
    fn migrated_v2_self_delivery_retry_preserves_receipt_without_reopening_ack_gap() {
        let path = retained_path("v2-self-retry");
        let authority_id = "a_00112233445566778899aabbccddeeff";
        let group_id = GroupId::parse("g_00000000000000000000000000000001").unwrap();
        let alice_id = PeerId::parse("p_00000000000000000000000000000001").unwrap();
        let legacy_message_id = MessageId::parse("m_00000000000000000000000000000001").unwrap();
        let legacy_request = SendMessageRequest {
            group_id: group_id.clone(),
            client_key: "legacy-self".to_owned(),
            recipients: BTreeSet::from([alice_id.clone()]),
            body: "accepted by schema v2".to_owned(),
            topic: Some("preserved".to_owned()),
            reply_to: None,
        };
        let canonical_payload =
            String::from_utf8(legacy_request.canonical_json().unwrap()).unwrap();
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(SCHEMA_V1).unwrap();
        connection.execute_batch(MIGRATION_V2).unwrap();
        connection
            .execute(
                "INSERT INTO authority_metadata(singleton,authority_id,created_at_millis) VALUES (1,?1,1)",
                [authority_id],
            )
            .unwrap();
        connection
            .execute_batch(
                "BEGIN;
                 INSERT INTO peers(peer_id,current_binding_revision,created_at_millis) VALUES ('p_00000000000000000000000000000001',1,1);
                 INSERT INTO peer_bindings(peer_id,binding_revision,launch_id,terminal_id,harness,conversation_id,process_id,process_creation_filetime,live,bound_at_millis) VALUES ('p_00000000000000000000000000000001',1,'l_00000000000000000000000000000001','alice-terminal','codex','alice-conversation',1,1,1,1);
                 INSERT INTO peers(peer_id,current_binding_revision,created_at_millis) VALUES ('p_00000000000000000000000000000002',1,1);
                 INSERT INTO peer_bindings(peer_id,binding_revision,launch_id,terminal_id,harness,conversation_id,process_id,process_creation_filetime,live,bound_at_millis) VALUES ('p_00000000000000000000000000000002',1,'l_00000000000000000000000000000002','bob-terminal','codex','bob-conversation',2,2,1,1);
                 INSERT INTO groups(group_id,authority_id,policy_revision,next_sequence,label,paused,created_at_millis) VALUES ('g_00000000000000000000000000000001','a_00112233445566778899aabbccddeeff',1,2,'migrated-v2',0,1);
                 INSERT INTO group_memberships(group_id,peer_id,added_policy_revision) VALUES ('g_00000000000000000000000000000001','p_00000000000000000000000000000001',1);
                 INSERT INTO group_memberships(group_id,peer_id,added_policy_revision) VALUES ('g_00000000000000000000000000000001','p_00000000000000000000000000000002',1);
                 COMMIT;",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO messages(message_id,group_id,group_sequence,sender_peer_id,sender_binding_revision,client_key,semantic_payload_json,body,topic,committed_at_millis) VALUES (?1,?2,1,?3,1,?4,?5,?6,?7,11)",
                params![
                    legacy_message_id.as_str(),
                    group_id.as_str(),
                    alice_id.as_str(),
                    legacy_request.client_key,
                    canonical_payload,
                    legacy_request.body,
                    legacy_request.topic,
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO recipient_deliveries(message_id,recipient_peer_id,recipient_binding_revision,saved_at_millis,delivery_generation) VALUES (?1,?2,1,11,1)",
                params![legacy_message_id.as_str(), alice_id.as_str()],
            )
            .unwrap();
        connection
            .pragma_update(None, "application_id", APPLICATION_ID)
            .unwrap();
        connection.pragma_update(None, "user_version", 2).unwrap();
        drop(connection);

        let mut store = crate::store::Store::open(&path).unwrap();
        let alice = store
            .authenticate_peer(&migrated_binding(
                "alice",
                "l_00000000000000000000000000000001",
                1,
            ))
            .unwrap();
        let bob = store
            .authenticate_peer(&migrated_binding(
                "bob",
                "l_00000000000000000000000000000002",
                2,
            ))
            .unwrap();
        let expected_receipt = SendReceipt {
            message_id: legacy_message_id.clone(),
            group_id: group_id.clone(),
            group_sequence: 1,
            sender_peer_id: alice_id.clone(),
            sender_binding_revision: Revision::new(1).unwrap(),
            recipients: vec![FrozenRecipient {
                peer_id: alice_id.clone(),
                binding_revision: Revision::new(1).unwrap(),
                generation: Revision::new(1).unwrap(),
            }],
            committed_at_millis: 11,
            outcome: MessageCommitOutcome::Saved,
        };

        assert_eq!(
            store.send_message(&alice, legacy_request.clone()).unwrap(),
            expected_receipt
        );
        let mut changed = legacy_request.clone();
        changed.body = "changed retry".to_owned();
        assert!(matches!(
            store.send_message(&alice, changed),
            Err(StoreError::IdempotencyConflict)
        ));
        let rejected_new_self = SendMessageRequest {
            client_key: "new-self".to_owned(),
            body: "must reject".to_owned(),
            topic: None,
            ..legacy_request.clone()
        };
        assert!(matches!(
            store.send_message(&alice, rejected_new_self),
            Err(StoreError::Unauthorized { .. })
        ));
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT (SELECT count(*) FROM messages),(SELECT count(*) FROM recipient_deliveries),(SELECT next_sequence FROM groups WHERE group_id=?1)",
                    [group_id.as_str()],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
                )
                .unwrap(),
            (1, 1, 2)
        );
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT count(*) FROM recipient_ack_order WHERE message_id=?1",
                    [legacy_message_id.as_str()],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );

        let legitimate = store
            .send_message(
                &bob,
                SendMessageRequest {
                    group_id: group_id.clone(),
                    client_key: "legitimate".to_owned(),
                    recipients: BTreeSet::from([alice_id.clone()]),
                    body: "acknowledge me".to_owned(),
                    topic: None,
                    reply_to: None,
                },
            )
            .unwrap();
        assert_eq!(legitimate.group_sequence, 2);
        let acknowledgement = store
            .acknowledge_message(&alice, &group_id, &legitimate.message_id)
            .unwrap();
        assert_eq!(acknowledgement.contiguous_group_sequence, 2);
        assert!(matches!(
            store.acknowledge_message(&alice, &group_id, &legacy_message_id),
            Err(StoreError::Unauthorized { .. })
        ));
        assert_eq!(
            store.send_message(&alice, legacy_request).unwrap(),
            expected_receipt
        );
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT recipient_binding_revision,delivery_generation,saved_at_millis FROM recipient_deliveries WHERE message_id=?1 AND recipient_peer_id=?2",
                    params![legacy_message_id.as_str(), alice_id.as_str()],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
                )
                .unwrap(),
            (1, 1, 11)
        );
    }
}

#[cfg(test)]
mod v3_migration_tests {
    use super::*;
    use crate::{model::*, store::Store};
    use rusqlite::params;

    pub(super) fn fixture(name: &str) -> (std::path::PathBuf, Connection) {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../retired/test-artifacts/swarm-core")
            .join(format!("{name}-{}", LaunchId::generate().as_str()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("swarm.sqlite");
        let mut connection = Connection::open(&path).unwrap();
        super::super::configure_connection(&connection).unwrap();
        connection.execute_batch(SCHEMA_V1).unwrap();
        connection.execute_batch(MIGRATION_V2).unwrap();
        connection.execute_batch(MIGRATION_V3).unwrap();
        connection
            .pragma_update(None, "application_id", APPLICATION_ID)
            .unwrap();
        connection.pragma_update(None, "user_version", 3).unwrap();
        let tx = connection.transaction().unwrap();
        tx.execute(
            "INSERT INTO authority_metadata VALUES(1,'a_00000000000000000000000000000001',1)",
            [],
        )
        .unwrap();
        for n in 1..=2 {
            let peer = format!("p_{n:032x}");
            let launch = format!("l_{n:032x}");
            tx.execute("INSERT INTO peers VALUES(?1,1,1)", [&peer])
                .unwrap();
            tx.execute(
                "INSERT INTO peer_bindings VALUES(?1,1,?2,?3,'codex',?3,NULL,100,1000,1,1)",
                params![peer, launch, format!("peer-{n}")],
            )
            .unwrap();
        }
        tx.execute("INSERT INTO groups VALUES('g_00000000000000000000000000000001','a_00000000000000000000000000000001',1,3,'v3',0,1)",[]).unwrap();
        for n in 1..=2 {
            tx.execute("INSERT INTO group_memberships VALUES('g_00000000000000000000000000000001',?1,1,NULL)",[format!("p_{n:032x}")]).unwrap();
            let message = format!("m_{n:032x}");
            tx.execute("INSERT INTO messages VALUES(?1,'g_00000000000000000000000000000001',?2,'p_00000000000000000000000000000001',1,?3,'{}',?4,NULL,NULL,1)",params![message,n,format!("key-{n}"),"preserved \"body\"\n\u{1}"]).unwrap();
            tx.execute("INSERT INTO recipient_deliveries(message_id,recipient_peer_id,recipient_binding_revision,saved_at_millis,delivery_generation) VALUES(?1,'p_00000000000000000000000000000002',1,1,1)",[&message]).unwrap();
            tx.execute("INSERT INTO recipient_ack_order VALUES(?1,'p_00000000000000000000000000000002','g_00000000000000000000000000000001',?2,1,1,?3)",params![message,n,n==1]).unwrap();
        }
        tx.execute("UPDATE recipient_deliveries SET fetched_generation=1,fetched_at_millis=2,acknowledged_generation=1,acknowledged_at_millis=3 WHERE message_id='m_00000000000000000000000000000001'",[]).unwrap();
        tx.execute("INSERT INTO acknowledgements VALUES('m_00000000000000000000000000000001','p_00000000000000000000000000000002',1,1,2,3)",[]).unwrap();
        tx.execute("INSERT INTO delivery_attempts VALUES('d_00000000000000000000000000000001','m_00000000000000000000000000000002','p_00000000000000000000000000000002',1,1,1,4,NULL,NULL,'legacy-native-reference')",[]).unwrap();
        tx.commit().unwrap();
        (path, connection)
    }

    #[test]
    fn populated_exact_v3_reopens_with_preserved_evidence_and_live_history_foreign_keys() {
        let (path, connection) = fixture("populated-v3");
        drop(connection);
        let mut store = Store::open(&path).unwrap();
        let owner = store.trusted_owner();
        let id = DeliveryAttemptId::parse("d_00000000000000000000000000000001").unwrap();
        assert_eq!(store.delivery_attempt(&owner, &id).unwrap().outcome, None);
        let db = &store.connection;
        assert_eq!(
            db.query_row("SELECT body FROM messages LIMIT 1", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "preserved \"body\"\n\u{1}"
        );
        assert_eq!(db.query_row("SELECT count(*) FROM acknowledgements WHERE fetched_at_millis=2 AND acknowledged_at_millis=3",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM acknowledgements_v3_archive",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(db.query_row("SELECT count(*) FROM delivery_attempts_v3_archive WHERE outcome IS NULL AND native_reference='legacy-native-reference'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        for table in [
            "acknowledgements",
            "delivery_attempts",
            "current_deliveries",
            "delivery_tickets",
            "attempt_not_submitted_reconciliations",
        ] {
            let references: Vec<String> = db
                .prepare("SELECT \"table\" FROM pragma_foreign_key_list(?1)")
                .unwrap()
                .query_map([table], |r| r.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            assert!(!references.is_empty());
            assert!(
                references.iter().all(|r| !r.ends_with("_archive")),
                "live table {table} points at archive: {references:?}"
            );
        }
        assert_eq!(store.recover_trusted_new_run(&owner).unwrap(), 1);
        assert_eq!(
            store.delivery_attempt(&owner, &id).unwrap().outcome,
            Some(AttemptOutcome::Uncertain)
        );
        assert!(store
            .delivery_candidates(
                &owner,
                &GroupId::parse("g_00000000000000000000000000000001").unwrap(),
                &PeerId::parse("p_00000000000000000000000000000002").unwrap(),
                Revision::new(1).unwrap(),
                128
            )
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
        drop(store);
        assert!(Store::open(path).unwrap().inspect().unwrap().integrity_ok);
    }

    #[test]
    fn late_v3_migration_failure_keeps_exact_previous_schema_and_evidence_usable() {
        let (path, mut connection) = fixture("v3-rollback");
        let before = schema_manifest(&connection).unwrap();
        let identity = DatabaseIdentity {
            application_id: APPLICATION_ID,
            schema_version: 3,
            has_objects: true,
        };
        assert!(migrate_with_final_sql(
            &mut connection,
            identity,
            Some("INSERT INTO deliberately_missing_migration_target VALUES(1)")
        )
        .is_err());
        assert_eq!(schema_manifest(&connection).unwrap(), before);
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert_eq!(connection.query_row("SELECT count(*) FROM delivery_attempts WHERE outcome IS NULL AND native_reference='legacy-native-reference'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(
            connection
                .query_row(
                    "SELECT acknowledged_at_millis FROM acknowledgements",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            3
        );
        drop(connection);
        let mut store = Store::open(path).unwrap();
        let owner = store.trusted_owner();
        assert_eq!(store.recover_trusted_new_run(&owner).unwrap(), 1);
        assert!(store.inspect().unwrap().integrity_ok);
    }
}

#[cfg(test)]
mod v4_migration_tests {
    use super::*;
    use crate::{model::*, store::Store};
    use rusqlite::params;

    #[test]
    fn exact_v4_mixed_generation_migration_preserves_history_and_rolls_back_late_failure() {
        let (path, mut connection) =
            super::v3_migration_tests::fixture("v4-mixed-generation-migration");
        connection.execute_batch(MIGRATION_V4).unwrap();
        connection.pragma_update(None, "user_version", 4).unwrap();
        let tx = connection.transaction().unwrap();
        let peer = "p_00000000000000000000000000000002";
        let group = "g_00000000000000000000000000000001";
        for revision in [2, 3] {
            tx.execute("INSERT INTO peer_bindings VALUES(?1,?2,?3,'peer-2','codex','peer-2',NULL,100,1000,1,1)", params![peer, revision, format!("l_{:032x}", revision+10)]).unwrap();
        }
        tx.execute(
            "UPDATE peers SET current_binding_revision=3 WHERE peer_id=?1",
            [peer],
        )
        .unwrap();
        for (sequence, generation) in [(3, 3), (4, 2)] {
            let message = format!("m_{sequence:032x}");
            tx.execute("INSERT INTO messages VALUES(?1,?2,?3,'p_00000000000000000000000000000001',1,?4,'{}','preserved v4 mixed generation',NULL,NULL,1)", params![message, group, sequence, format!("mixed-{sequence}")]).unwrap();
            tx.execute("INSERT INTO recipient_deliveries(message_id,recipient_peer_id,recipient_binding_revision,saved_at_millis,delivery_generation) VALUES(?1,?2,1,1,1)", params![message, peer]).unwrap();
            tx.execute(
                "INSERT INTO delivery_generations VALUES(?1,?2,3,?3)",
                params![message, peer, generation],
            )
            .unwrap();
            tx.execute("UPDATE current_deliveries SET recipient_binding_revision=3,delivery_generation=?1 WHERE message_id=?2", params![generation, message]).unwrap();
            tx.execute(
                "INSERT INTO recipient_ack_order VALUES(?1,?2,?3,?4,3,?5,?6)",
                params![message, peer, group, sequence, generation, sequence == 4],
            )
            .unwrap();
        }
        tx.execute("INSERT INTO acknowledgements VALUES('m_00000000000000000000000000000004',?1,3,2,NULL,41)", [peer]).unwrap();
        tx.execute("UPDATE current_deliveries SET acknowledged_generation=2,acknowledged_at_millis=41 WHERE message_id='m_00000000000000000000000000000004'", []).unwrap();
        tx.execute(
            "INSERT INTO acknowledgement_watermarks VALUES(?1,?2,3,2,4,42)",
            params![group, peer],
        )
        .unwrap();
        tx.execute(
            "UPDATE groups SET next_sequence=5 WHERE group_id=?1",
            [group],
        )
        .unwrap();
        tx.commit().unwrap();
        let before = schema_manifest(&connection).unwrap();
        let identity = DatabaseIdentity {
            application_id: APPLICATION_ID,
            schema_version: 4,
            has_objects: true,
        };
        assert!(migrate_with_final_sql(
            &mut connection,
            identity,
            Some("INSERT INTO deliberately_missing_v5_target VALUES(1)")
        )
        .is_err());
        assert_eq!(schema_manifest(&connection).unwrap(), before);
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            4
        );
        assert_eq!(connection.query_row("SELECT contiguous_group_sequence FROM acknowledgement_watermarks WHERE binding_revision=3", [], |r| r.get::<_,i64>(0)).unwrap(), 4);
        drop(connection);
        let mut store = Store::open(&path).unwrap();
        let principal = PeerPrincipal::new(
            store.authority_id.clone(),
            PeerId::parse(peer).unwrap(),
            Revision::new(3).unwrap(),
        );
        let group_id = GroupId::parse(group).unwrap();
        let second_id = MessageId::parse("m_00000000000000000000000000000004").unwrap();
        let first_id = MessageId::parse("m_00000000000000000000000000000003").unwrap();
        let second = store
            .acknowledge_message(&principal, &group_id, &second_id)
            .unwrap();
        assert_eq!(second.generation.get(), 2);
        assert_eq!(second.acknowledged_at_millis, 41);
        assert_eq!(
            second.contiguous_group_sequence, 0,
            "v4 generation-specific frontier 4 is not a valid binding-wide lower bound"
        );
        assert_eq!(
            store
                .acknowledge_message(&principal, &group_id, &first_id)
                .unwrap()
                .contiguous_group_sequence,
            4
        );
        assert_eq!(
            store
                .acknowledge_message(&principal, &group_id, &first_id)
                .unwrap()
                .contiguous_group_sequence,
            4
        );
        assert_eq!(store.connection.query_row("SELECT contiguous_group_sequence,updated_at_millis FROM acknowledgement_watermarks WHERE binding_revision=3", [], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?))).unwrap(), (4,42));
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT count(*) FROM acknowledgements_v3_archive",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
        drop(store);
        assert_eq!(
            Store::open(path).unwrap().inspect().unwrap().schema_version,
            SCHEMA_VERSION
        );
    }
}

#[cfg(test)]
mod reconciled_projection_migration_tests {
    use super::*;
    use crate::{model::*, store::Store};
    use rusqlite::params;

    const PEER: &str = "p_00000000000000000000000000000002";
    const MESSAGE: &str = "m_00000000000000000000000000000002";
    const GROUP: &str = "g_00000000000000000000000000000001";
    const ATTEMPT: &str = "d_00000000000000000000000000000001";
    const PROOF: &str = "verified-cancelled-after-native-observation";

    fn fixture(
        version: i64,
        outcome: AttemptOutcome,
        guard: &str,
    ) -> (std::path::PathBuf, Connection) {
        let (path, mut connection) =
            super::v3_migration_tests::fixture("stranded-reconciliation-migration");
        connection.execute_batch(MIGRATION_V4).unwrap();
        if version == 5 {
            connection.execute_batch(MIGRATION_V5).unwrap();
        }
        connection
            .pragma_update(None, "user_version", version)
            .unwrap();
        // Materialize exactly the old I1 result: recovery, trusted cancellation,
        // then an older native observation overwrites the current routing state.
        let tx = connection.transaction().unwrap();
        tx.execute("UPDATE delivery_attempts SET outcome=?1,completed_at_millis=30,recovered_uncertain_at_millis=10 WHERE attempt_id=?2", params![outcome.as_str(), ATTEMPT]).unwrap();
        tx.execute(
            "INSERT INTO attempt_not_submitted_reconciliations VALUES(?1,?2,20)",
            params![ATTEMPT, PROOF],
        )
        .unwrap();
        tx.execute(
            "UPDATE current_deliveries SET last_attempt_id=?1,route_state=?2 WHERE message_id=?3",
            params![ATTEMPT, outcome.as_str(), MESSAGE],
        )
        .unwrap();
        match guard {
            "newer_attempt" => {
                tx.execute("INSERT INTO delivery_attempts(attempt_id,message_id,recipient_peer_id,binding_revision,generation,attempt_number,started_at_millis,completed_at_millis,outcome) VALUES('d_00000000000000000000000000000002',?1,?2,1,1,2,35,40,'native_queued')", params![MESSAGE, PEER]).unwrap();
                tx.execute("UPDATE current_deliveries SET last_attempt_id='d_00000000000000000000000000000002',route_state='native_queued' WHERE message_id=?1", [MESSAGE]).unwrap();
            }
            "successor" | "binding_only" | "generation_only" => {
                let binding = if guard == "generation_only" { 1 } else { 2 };
                let generation = if guard == "binding_only" { 1 } else { 2 };
                if binding == 2 {
                    tx.execute("INSERT INTO peer_bindings VALUES(?1,2,'l_00000000000000000000000000000012','peer-2','codex','peer-2',NULL,100,1000,1,1)", [PEER]).unwrap();
                    tx.execute(
                        "UPDATE peers SET current_binding_revision=2 WHERE peer_id=?1",
                        [PEER],
                    )
                    .unwrap();
                }
                tx.execute(
                    "INSERT INTO delivery_generations VALUES(?1,?2,?3,?4)",
                    params![MESSAGE, PEER, binding, generation],
                )
                .unwrap();
                tx.execute("UPDATE current_deliveries SET recipient_binding_revision=?1,delivery_generation=?2 WHERE message_id=?3", params![binding, generation, MESSAGE]).unwrap();
                tx.execute("UPDATE recipient_ack_order SET binding_revision=?1,generation=?2 WHERE message_id=?3", params![binding, generation, MESSAGE]).unwrap();
            }
            "fetched" => {
                tx.execute("UPDATE current_deliveries SET fetched_generation=1,fetched_at_millis=21 WHERE message_id=?1", [MESSAGE]).unwrap();
                tx.execute(
                    "INSERT INTO acknowledgements VALUES(?1,?2,1,1,21,NULL)",
                    params![MESSAGE, PEER],
                )
                .unwrap();
            }
            "acknowledged" => {
                tx.execute("UPDATE current_deliveries SET acknowledged_generation=1,acknowledged_at_millis=21 WHERE message_id=?1", [MESSAGE]).unwrap();
                tx.execute(
                    "INSERT INTO acknowledgements VALUES(?1,?2,1,1,NULL,21)",
                    params![MESSAGE, PEER],
                )
                .unwrap();
                tx.execute(
                    "UPDATE recipient_ack_order SET acknowledged=1 WHERE message_id=?1",
                    [MESSAGE],
                )
                .unwrap();
            }
            "replied" => {
                tx.execute("UPDATE current_deliveries SET replied_by_message_id='m_00000000000000000000000000000001' WHERE message_id=?1", [MESSAGE]).unwrap();
            }
            "paused" => {
                tx.execute("UPDATE groups SET paused=1 WHERE group_id=?1", [GROUP])
                    .unwrap();
            }
            "offline" => {
                tx.execute(
                    "UPDATE peer_bindings SET live=0 WHERE peer_id=?1 AND binding_revision=1",
                    [PEER],
                )
                .unwrap();
            }
            "removed" => {
                tx.execute(
                    "UPDATE group_memberships SET removed_policy_revision=1 WHERE peer_id=?1",
                    [PEER],
                )
                .unwrap();
            }
            "none" => {}
            _ => panic!("unknown fixture guard"),
        }
        tx.commit().unwrap();
        (path, connection)
    }

    fn history(connection: &Connection) -> (String, i64, i64, String, i64) {
        connection.query_row("SELECT a.outcome,a.completed_at_millis,a.recovered_uncertain_at_millis,r.evidence_reference,r.reconciled_at_millis FROM delivery_attempts a JOIN attempt_not_submitted_reconciliations r ON r.attempt_id=a.attempt_id WHERE a.attempt_id=?1", [ATTEMPT], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap()
    }

    fn candidates(store: &mut Store, binding: u64) -> Vec<DeliveryCandidate> {
        store
            .delivery_candidates(
                &store.trusted_owner(),
                &GroupId::parse(GROUP).unwrap(),
                &PeerId::parse(PEER).unwrap(),
                Revision::new(binding).unwrap(),
                128,
            )
            .unwrap()
    }

    #[test]
    fn stranded_exact_v4_and_v5_reconciliation_is_repaired_with_history_replays_and_rollback() {
        for version in [4, 5] {
            for outcome in [
                AttemptOutcome::Held,
                AttemptOutcome::NativeQueued,
                AttemptOutcome::TransportWritten,
            ] {
                let (path, mut connection) = fixture(version, outcome, "none");
                let before_schema = schema_manifest(&connection).unwrap();
                let before_history = history(&connection);
                let identity = DatabaseIdentity {
                    application_id: APPLICATION_ID,
                    schema_version: version,
                    has_objects: true,
                };
                assert!(migrate_with_final_sql(
                    &mut connection,
                    identity,
                    Some("INSERT INTO deliberately_missing_projection_migration_target VALUES(1)")
                )
                .is_err());
                assert_eq!(schema_manifest(&connection).unwrap(), before_schema);
                assert_eq!(
                    connection
                        .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                        .unwrap(),
                    version
                );
                assert_eq!(
                    connection
                        .query_row(
                            "SELECT route_state FROM current_deliveries WHERE message_id=?1",
                            [MESSAGE],
                            |r| r.get::<_, String>(0)
                        )
                        .unwrap(),
                    outcome.as_str()
                );
                assert_eq!(history(&connection), before_history);
                drop(connection);
                let mut store = Store::open(&path).unwrap();
                let owner = store.trusted_owner();
                store.recover_trusted_new_run(&owner).unwrap();
                assert_eq!(
                    candidates(&mut store, 1).len(),
                    1,
                    "v{version} stranded {outcome:?} must be repaired by migration"
                );
                let attempt = DeliveryAttemptId::parse(ATTEMPT).unwrap();
                store.complete_delivery(&owner, &attempt, outcome).unwrap();
                assert_eq!(candidates(&mut store, 1).len(), 1);
                store
                    .reconcile_not_submitted(
                        &owner,
                        VerifiedNotSubmitted::trusted(attempt, PROOF.into()).unwrap(),
                    )
                    .unwrap();
                assert_eq!(candidates(&mut store, 1).len(), 1);
                assert_eq!(history(&store.connection), before_history);
                assert_eq!(store.connection.query_row("SELECT recipient_binding_revision,delivery_generation FROM recipient_deliveries WHERE message_id=?1", [MESSAGE], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?))).unwrap(), (1,1));
                drop(store);
                let mut reopened = Store::open(path).unwrap();
                reopened
                    .recover_trusted_new_run(&reopened.trusted_owner())
                    .unwrap();
                assert_eq!(candidates(&mut reopened, 1).len(), 1);
                assert_eq!(history(&reopened.connection), before_history);
                let tx = reopened.connection.transaction().unwrap();
                let predecessor =
                    super::super::policy::read_binding(&tx, &PeerId::parse(PEER).unwrap(), 1)
                        .unwrap();
                tx.commit().unwrap();
                let next = VerifiedBinding::trusted(
                    LaunchId::generate().as_str().into(),
                    "continued-peer-2".into(),
                    "codex".into(),
                    "peer-2".into(),
                    None,
                    101,
                    1001,
                    true,
                )
                .unwrap();
                let evidence = VerifiedContinuation::trusted(
                    &predecessor,
                    next,
                    "verified-same-branch".into(),
                )
                .unwrap();
                let successor = reopened
                    .continue_peer(
                        &reopened.trusted_owner(),
                        evidence,
                        "continue-migrated-reconciled-backlog",
                        [(GroupId::parse(GROUP).unwrap(), Revision::new(1).unwrap())].into(),
                    )
                    .unwrap();
                let transferred = candidates(&mut reopened, successor.record.revision.get());
                assert_eq!(transferred.len(), 1);
                assert_eq!(transferred[0].generation().get(), 2);
                assert_eq!(history(&reopened.connection), before_history);
            }
        }
    }

    #[test]
    fn reconciliation_projection_migration_respects_attempt_binding_receipt_and_policy_guards() {
        for version in [4, 5] {
            for guard in [
                "newer_attempt",
                "successor",
                "binding_only",
                "generation_only",
                "fetched",
                "acknowledged",
                "replied",
                "paused",
                "offline",
                "removed",
            ] {
                let (path, connection) = fixture(version, AttemptOutcome::Held, guard);
                let before_history = history(&connection);
                let before_route: String = connection
                    .query_row(
                        "SELECT route_state FROM current_deliveries WHERE message_id=?1",
                        [MESSAGE],
                        |r| r.get(0),
                    )
                    .unwrap();
                drop(connection);
                let mut store = Store::open(path).unwrap();
                let authorized_later = matches!(guard, "paused" | "offline" | "removed");
                let expected_route = if authorized_later {
                    "ready"
                } else {
                    before_route.as_str()
                };
                assert_eq!(
                    store
                        .connection
                        .query_row(
                            "SELECT route_state FROM current_deliveries WHERE message_id=?1",
                            [MESSAGE],
                            |r| r.get::<_, String>(0)
                        )
                        .unwrap(),
                    expected_route,
                    "v{version} guard {guard}"
                );
                store
                    .recover_trusted_new_run(&store.trusted_owner())
                    .unwrap();
                let binding = if matches!(guard, "successor" | "binding_only") {
                    2
                } else {
                    1
                };
                assert!(
                    candidates(&mut store, binding).is_empty(),
                    "v{version} repair must not bypass {guard}"
                );
                assert_eq!(history(&store.connection), before_history);
                assert_eq!(
                    store
                        .connection
                        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                            .get::<_, i64>(
                            0
                        ))
                        .unwrap(),
                    0
                );
            }
        }
    }
}
