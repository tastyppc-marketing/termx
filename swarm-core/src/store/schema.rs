use std::path::Path;

use rusqlite::{Connection, TransactionBehavior};

use crate::error::StoreError;
use crate::model::AuthorityId;

pub const APPLICATION_ID: i64 = 0x5458_4d31;
pub const SCHEMA_VERSION: i64 = 10;

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
    if identity.schema_version >= 7 {
        expected.execute_batch(MIGRATION_V7)?;
    }
    if identity.schema_version >= 8 {
        expected.execute_batch(MIGRATION_V8)?;
    }
    if identity.schema_version >= 9 {
        expected.execute_batch(MIGRATION_V9)?;
    }
    if identity.schema_version >= 10 {
        expected.execute_batch(MIGRATION_V10)?;
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
    if identity.schema_version < 7 {
        transaction.execute_batch(MIGRATION_V7)?;
    }
    if identity.schema_version < 8 {
        transaction.execute_batch(MIGRATION_V8)?;
    }
    if identity.schema_version < 9 {
        transaction.execute_batch(MIGRATION_V9)?;
    }
    if identity.schema_version < 10 {
        transaction.execute_batch(MIGRATION_V10)?;
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

// Mailbox history is broader than ACK eligibility: supported v2 databases may
// retain sender/self deliveries which migration v3 intentionally excluded from
// recipient_ack_order. Index the complete current-delivery projection instead.
const MIGRATION_V7: &str = r#"
CREATE INDEX current_delivery_mailbox ON current_deliveries(group_id,recipient_peer_id,recipient_binding_revision,group_sequence);
"#;

// Task 2: bounded thread/outgoing navigation, read-kind bound cursors, owner
// state revisions, caller-owned status, source registrations with a distinct
// authorization epoch, immutable attachments and single-use publication
// commitments. Additive only; every historical row and cursor keeps its meaning.
const MIGRATION_V8: &str = r#"
ALTER TABLE messages ADD COLUMN thread_root_message_id TEXT;
WITH RECURSIVE roots(message_id, root) AS (
    SELECT message_id, message_id FROM messages WHERE reply_to_message_id IS NULL
    UNION ALL
    SELECT m.message_id, roots.root FROM messages m JOIN roots ON m.reply_to_message_id = roots.message_id
)
UPDATE messages SET thread_root_message_id = (SELECT root FROM roots WHERE roots.message_id = messages.message_id);
UPDATE messages SET thread_root_message_id = message_id WHERE thread_root_message_id IS NULL;
CREATE INDEX messages_by_thread ON messages(group_id, thread_root_message_id, group_sequence);
CREATE INDEX messages_by_sender ON messages(group_id, sender_peer_id, group_sequence);
CREATE INDEX messages_by_reply ON messages(reply_to_message_id);
CREATE TRIGGER messages_thread_root AFTER INSERT ON messages WHEN NEW.thread_root_message_id IS NULL BEGIN
    UPDATE messages SET thread_root_message_id = COALESCE((SELECT p.thread_root_message_id FROM messages p WHERE p.message_id = NEW.reply_to_message_id), NEW.message_id) WHERE message_id = NEW.message_id;
END;

ALTER TABLE mailbox_cursors ADD COLUMN read_kind TEXT NOT NULL DEFAULT 'mailbox' CHECK (read_kind IN ('mailbox', 'thread', 'outgoing'));
ALTER TABLE mailbox_cursors ADD COLUMN selector TEXT CHECK (selector IS NULL OR length(CAST(selector AS BLOB)) BETWEEN 1 AND 256);

CREATE TABLE owner_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    inventory_revision INTEGER NOT NULL CHECK (inventory_revision >= 1),
    delivery_revision INTEGER NOT NULL CHECK (delivery_revision >= 1)
) STRICT;
INSERT INTO owner_state(singleton, inventory_revision, delivery_revision) VALUES (1, 1, 1);

CREATE TABLE peer_statuses (
    group_id TEXT NOT NULL REFERENCES groups(group_id),
    peer_id TEXT NOT NULL REFERENCES peers(peer_id),
    membership_policy_revision INTEGER NOT NULL CHECK (membership_policy_revision >= 1),
    binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
    status_text TEXT CHECK (status_text IS NULL OR length(CAST(status_text AS BLOB)) BETWEEN 1 AND 4096),
    status_revision INTEGER NOT NULL CHECK (status_revision >= 1),
    updated_at_millis INTEGER NOT NULL,
    PRIMARY KEY (group_id, peer_id),
    FOREIGN KEY (peer_id, binding_revision) REFERENCES peer_bindings(peer_id, binding_revision)
) STRICT;

CREATE TABLE source_registrations (
    source_id TEXT PRIMARY KEY,
    peer_id TEXT NOT NULL REFERENCES peers(peer_id),
    binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
    conversation_id TEXT NOT NULL CHECK (length(CAST(conversation_id AS BLOB)) BETWEEN 1 AND 4096),
    source_kind TEXT NOT NULL CHECK (length(CAST(source_kind AS BLOB)) BETWEEN 1 AND 256),
    resolver_key TEXT NOT NULL CHECK (length(CAST(resolver_key AS BLOB)) BETWEEN 1 AND 4096),
    object_identity TEXT NOT NULL CHECK (length(CAST(object_identity AS BLOB)) BETWEEN 1 AND 4096),
    evidence_reference TEXT NOT NULL CHECK (length(CAST(evidence_reference AS BLOB)) BETWEEN 1 AND 4096),
    state TEXT NOT NULL CHECK (state IN ('active', 'withdrawn', 'replaced')),
    registration_epoch INTEGER NOT NULL CHECK (registration_epoch >= 1),
    replaced_by_source_id TEXT REFERENCES source_registrations(source_id),
    registered_at_millis INTEGER NOT NULL,
    transitioned_at_millis INTEGER NOT NULL,
    FOREIGN KEY (peer_id, binding_revision) REFERENCES peer_bindings(peer_id, binding_revision)
) STRICT;
CREATE INDEX source_registrations_by_peer ON source_registrations(peer_id, source_id);

CREATE TABLE source_registration_history (
    source_id TEXT NOT NULL REFERENCES source_registrations(source_id),
    registration_epoch INTEGER NOT NULL CHECK (registration_epoch >= 1),
    state TEXT NOT NULL CHECK (state IN ('active', 'withdrawn', 'replaced')),
    peer_id TEXT NOT NULL REFERENCES peers(peer_id),
    binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
    resolver_key TEXT NOT NULL CHECK (length(CAST(resolver_key AS BLOB)) BETWEEN 1 AND 4096),
    object_identity TEXT NOT NULL CHECK (length(CAST(object_identity AS BLOB)) BETWEEN 1 AND 4096),
    evidence_reference TEXT NOT NULL CHECK (length(CAST(evidence_reference AS BLOB)) BETWEEN 1 AND 4096),
    transitioned_at_millis INTEGER NOT NULL,
    PRIMARY KEY (source_id, registration_epoch)
) STRICT;

CREATE TABLE message_source_references (
    source_reference_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(message_id),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    source_id TEXT NOT NULL REFERENCES source_registrations(source_id),
    source_kind TEXT NOT NULL CHECK (length(CAST(source_kind AS BLOB)) BETWEEN 1 AND 256),
    owner_peer_id TEXT NOT NULL REFERENCES peers(peer_id),
    registration_epoch INTEGER NOT NULL CHECK (registration_epoch >= 1),
    snapshot_reference TEXT CHECK (snapshot_reference IS NULL OR length(CAST(snapshot_reference AS BLOB)) BETWEEN 1 AND 4096),
    attached_at_millis INTEGER NOT NULL,
    UNIQUE (message_id, ordinal)
) STRICT;

CREATE TABLE publication_commitments (
    commitment_id TEXT PRIMARY KEY,
    lease_id TEXT NOT NULL UNIQUE,
    response_reference TEXT NOT NULL UNIQUE CHECK (length(CAST(response_reference AS BLOB)) BETWEEN 1 AND 4096),
    authority_id TEXT NOT NULL REFERENCES authority_metadata(authority_id),
    group_id TEXT NOT NULL REFERENCES groups(group_id),
    policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
    caller_peer_id TEXT NOT NULL REFERENCES peers(peer_id),
    caller_binding_revision INTEGER NOT NULL CHECK (caller_binding_revision >= 1),
    source_id TEXT NOT NULL REFERENCES source_registrations(source_id),
    source_owner_binding_revision INTEGER NOT NULL CHECK (source_owner_binding_revision >= 1),
    registration_epoch INTEGER NOT NULL CHECK (registration_epoch >= 1),
    reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 1),
    committed_at_millis INTEGER NOT NULL
) STRICT;
"#;

// Task 2 fix-1: bounded owner subpages (I1), two-range thread reads (I2) and
// publication ownership audit (C1). Additive only: no historical row changes
// meaning, legacy commitment rows keep NULL in the new columns, and the thread
// projection is derived from current deliveries by transactional triggers.
const MIGRATION_V9: &str = r#"
CREATE INDEX membership_active_by_group ON group_memberships(group_id, peer_id) WHERE removed_policy_revision IS NULL;
CREATE INDEX source_registrations_active_by_binding ON source_registrations(peer_id, binding_revision, source_id) WHERE state = 'active';

CREATE INDEX messages_by_sender_thread ON messages(group_id, sender_peer_id, thread_root_message_id, group_sequence);
CREATE TABLE current_thread_deliveries (
    message_id TEXT NOT NULL,
    recipient_peer_id TEXT NOT NULL,
    recipient_binding_revision INTEGER NOT NULL CHECK (recipient_binding_revision >= 1),
    group_id TEXT NOT NULL REFERENCES groups(group_id),
    thread_root_message_id TEXT NOT NULL REFERENCES messages(message_id),
    group_sequence INTEGER NOT NULL CHECK (group_sequence >= 1),
    sender_peer_id TEXT NOT NULL REFERENCES peers(peer_id),
    PRIMARY KEY (message_id, recipient_peer_id),
    FOREIGN KEY (message_id, recipient_peer_id) REFERENCES current_deliveries(message_id, recipient_peer_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX current_thread_delivery_page ON current_thread_deliveries(group_id, recipient_peer_id, recipient_binding_revision, thread_root_message_id, group_sequence);
INSERT INTO current_thread_deliveries(message_id, recipient_peer_id, recipient_binding_revision, group_id, thread_root_message_id, group_sequence, sender_peer_id)
    SELECT d.message_id, d.recipient_peer_id, d.recipient_binding_revision, d.group_id, COALESCE(m.thread_root_message_id, m.message_id), d.group_sequence, m.sender_peer_id
    FROM current_deliveries d JOIN messages m ON m.message_id = d.message_id;
CREATE TRIGGER project_current_thread_delivery AFTER INSERT ON current_deliveries BEGIN
    INSERT INTO current_thread_deliveries(message_id, recipient_peer_id, recipient_binding_revision, group_id, thread_root_message_id, group_sequence, sender_peer_id)
    SELECT NEW.message_id, NEW.recipient_peer_id, NEW.recipient_binding_revision, NEW.group_id, COALESCE(m.thread_root_message_id, m.message_id), NEW.group_sequence, m.sender_peer_id
    FROM messages m WHERE m.message_id = NEW.message_id;
END;
CREATE TRIGGER rebind_current_thread_delivery AFTER UPDATE OF recipient_binding_revision ON current_deliveries BEGIN
    UPDATE current_thread_deliveries SET recipient_binding_revision = NEW.recipient_binding_revision
    WHERE message_id = NEW.message_id AND recipient_peer_id = NEW.recipient_peer_id;
END;

ALTER TABLE publication_commitments ADD COLUMN destination_id TEXT CHECK (destination_id IS NULL OR length(CAST(destination_id AS BLOB)) BETWEEN 1 AND 256);
ALTER TABLE publication_commitments ADD COLUMN body_bytes INTEGER CHECK (body_bytes IS NULL OR body_bytes BETWEEN 1 AND 8388608);
ALTER TABLE publication_commitments ADD COLUMN snapshot_identity TEXT CHECK (snapshot_identity IS NULL OR length(CAST(snapshot_identity AS BLOB)) BETWEEN 1 AND 4096);
ALTER TABLE publication_commitments ADD COLUMN captured_through INTEGER CHECK (captured_through IS NULL OR captured_through >= 0);
"#;

// Coalesced native-notice coordination. Submission evidence, positive native
// receipt and verified non-submission remain separate durable facts. Coverage
// contains no live policy snapshot; candidates re-read current authority.
const MIGRATION_V10: &str = r#"
CREATE TABLE notice_coverage (
    recipient_peer_id TEXT NOT NULL,
    recipient_binding_revision INTEGER NOT NULL CHECK (recipient_binding_revision >= 1),
    group_id TEXT NOT NULL REFERENCES groups(group_id),
    covered_through_sequence INTEGER NOT NULL CHECK (covered_through_sequence >= 0),
    noticed_through_sequence INTEGER NOT NULL CHECK (noticed_through_sequence >= 0),
    last_attempt_id TEXT,
    updated_at_millis INTEGER NOT NULL,
    PRIMARY KEY (recipient_peer_id, recipient_binding_revision, group_id),
    FOREIGN KEY (recipient_peer_id, recipient_binding_revision)
        REFERENCES peer_bindings(peer_id, binding_revision),
    CHECK (noticed_through_sequence <= covered_through_sequence)
) STRICT;

CREATE TABLE notice_attempts (
    attempt_id TEXT PRIMARY KEY,
    recipient_peer_id TEXT NOT NULL,
    recipient_binding_revision INTEGER NOT NULL CHECK (recipient_binding_revision >= 1),
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    run_revision INTEGER NOT NULL REFERENCES broker_runs(run_revision),
    policy_snapshot_json TEXT NOT NULL,
    binding_snapshot_json TEXT NOT NULL,
    started_at_millis INTEGER NOT NULL,
    completed_at_millis INTEGER,
    outcome TEXT CHECK (length(CAST(outcome AS BLOB)) <= 4096),
    native_reference TEXT CHECK (length(CAST(native_reference AS BLOB)) <= 4096),
    recovered_uncertain_at_millis INTEGER,
    UNIQUE (recipient_peer_id, recipient_binding_revision, attempt_number),
    FOREIGN KEY (recipient_peer_id, recipient_binding_revision)
        REFERENCES peer_bindings(peer_id, binding_revision),
    CHECK ((completed_at_millis IS NULL AND outcome IS NULL)
        OR (completed_at_millis IS NOT NULL AND outcome IS NOT NULL))
) STRICT;

CREATE TABLE notice_tickets (
    attempt_id TEXT PRIMARY KEY REFERENCES notice_attempts(attempt_id),
    authority_id TEXT NOT NULL REFERENCES authority_metadata(authority_id),
    run_revision INTEGER NOT NULL REFERENCES broker_runs(run_revision),
    binding_snapshot_json TEXT NOT NULL
) STRICT;

CREATE TABLE notice_attempt_groups (
    attempt_id TEXT NOT NULL REFERENCES notice_attempts(attempt_id),
    group_id TEXT NOT NULL REFERENCES groups(group_id),
    covered_through_sequence INTEGER NOT NULL CHECK (covered_through_sequence >= 1),
    policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
    PRIMARY KEY (attempt_id, group_id)
) STRICT;

CREATE TABLE notice_not_submitted_reconciliations (
    attempt_id TEXT PRIMARY KEY REFERENCES notice_attempts(attempt_id),
    evidence_reference TEXT NOT NULL
        CHECK (length(CAST(evidence_reference AS BLOB)) BETWEEN 1 AND 4096),
    reconciled_at_millis INTEGER NOT NULL
) STRICT;

CREATE TABLE notice_receipts (
    attempt_id TEXT PRIMARY KEY REFERENCES notice_attempts(attempt_id),
    native_record_kind TEXT NOT NULL
        CHECK (length(CAST(native_record_kind AS BLOB)) BETWEEN 1 AND 256),
    provenance_reference TEXT NOT NULL
        CHECK (length(CAST(provenance_reference AS BLOB)) BETWEEN 1 AND 4096),
    enrolled_source_identity TEXT NOT NULL
        CHECK (length(CAST(enrolled_source_identity AS BLOB)) BETWEEN 1 AND 4096),
    enrolled_generation TEXT NOT NULL
        CHECK (length(CAST(enrolled_generation AS BLOB)) BETWEEN 1 AND 4096),
    native_item_identity TEXT NOT NULL
        CHECK (length(CAST(native_item_identity AS BLOB)) BETWEEN 1 AND 4096),
    received_at_millis INTEGER NOT NULL
) STRICT;

CREATE INDEX notice_attempts_unfinished
    ON notice_attempts(recipient_peer_id, recipient_binding_revision, started_at_millis)
    WHERE completed_at_millis IS NULL;
CREATE INDEX notice_attempts_latest
    ON notice_attempts(recipient_peer_id, recipient_binding_revision, attempt_number);
CREATE INDEX notice_unfetched_eligible
    ON current_deliveries(
        recipient_peer_id,
        recipient_binding_revision,
        group_id,
        group_sequence
    )
    WHERE fetched_at_millis IS NULL;

INSERT INTO notice_coverage(
    recipient_peer_id,
    recipient_binding_revision,
    group_id,
    covered_through_sequence,
    noticed_through_sequence,
    last_attempt_id,
    updated_at_millis
)
SELECT recipient_peer_id,
       recipient_binding_revision,
       group_id,
       MAX(group_sequence),
       0,
       NULL,
       CAST(unixepoch('subsec') * 1000 AS INTEGER)
  FROM current_deliveries
 GROUP BY recipient_peer_id, recipient_binding_revision, group_id;
"#;

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::time::{SystemTime, UNIX_EPOCH};

    use rusqlite::params;

    use crate::model::{
        FrozenRecipient, GroupId, MailboxPageRequest, MessageCommitOutcome, MessageId, PeerId,
        Revision, SendMessageRequest, SendReceipt, VerifiedBinding,
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
            attachments: Vec::new(),
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
                    attachments: Vec::new(),
                },
            )
            .unwrap();
        assert_eq!(legitimate.group_sequence, 2);
        let acknowledgement = store
            .acknowledge_message(&alice, &group_id, &legitimate.message_id)
            .unwrap();
        assert_eq!(acknowledgement.contiguous_group_sequence, 2);
        let first_page = store
            .read_mailbox(
                &alice,
                MailboxPageRequest {
                    group_id: group_id.clone(),
                    cursor: None,
                    max_items: 1,
                },
            )
            .unwrap();
        assert_eq!(
            first_page
                .messages
                .iter()
                .map(|entry| (
                    entry.message.group_sequence,
                    entry.message.client_key.as_str(),
                    entry.message.body.as_str(),
                    entry.receipt.generation.get(),
                    entry.receipt.acknowledged_at_millis.is_some(),
                ))
                .collect::<Vec<_>>(),
            vec![(1, "legacy-self", "accepted by schema v2", 1, false)]
        );
        assert_eq!(first_page.snapshot_high_sequence, 2);
        let cursor = first_page
            .next_cursor
            .expect("sequence 2 remains in snapshot");
        let appended = store
            .send_message(
                &bob,
                SendMessageRequest {
                    group_id: group_id.clone(),
                    client_key: "after-snapshot".to_owned(),
                    recipients: BTreeSet::from([alice_id.clone()]),
                    body: "must remain outside the frozen snapshot".to_owned(),
                    topic: None,
                    reply_to: None,
                    attachments: Vec::new(),
                },
            )
            .unwrap();
        assert_eq!(appended.group_sequence, 3);
        let second_page = store
            .read_mailbox(
                &alice,
                MailboxPageRequest {
                    group_id: group_id.clone(),
                    cursor: Some(cursor),
                    max_items: 1,
                },
            )
            .unwrap();
        assert_eq!(
            second_page
                .messages
                .iter()
                .map(|entry| (
                    entry.message.group_sequence,
                    entry.message.client_key.as_str(),
                    entry.message.body.as_str(),
                    entry.receipt.generation.get(),
                    entry.receipt.acknowledged_at_millis.is_some(),
                ))
                .collect::<Vec<_>>(),
            vec![(2, "legitimate", "acknowledge me", 1, true)]
        );
        assert_eq!(second_page.snapshot_high_sequence, 2);
        assert!(second_page.next_cursor.is_none());
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

#[cfg(test)]
mod v8_migration_tests {
    use super::*;
    use crate::{model::*, store::Store};
    use rusqlite::params;

    const AUTHORITY: &str = "a_00000000000000000000000000000001";
    const GROUP: &str = "g_00000000000000000000000000000001";
    const SENDER: &str = "p_00000000000000000000000000000001";
    const RECIPIENT: &str = "p_00000000000000000000000000000002";
    const ROOT: &str = "m_00000000000000000000000000000001";
    const OTHER_ROOT: &str = "m_00000000000000000000000000000002";
    const REPLY: &str = "m_00000000000000000000000000000003";
    const NESTED: &str = "m_00000000000000000000000000000004";
    const CURSOR: &str = "c_00000000000000000000000000000007";

    /// Exact v7 database with a reply chain and a retained v7 mailbox cursor.
    pub(super) fn fixture(name: &str) -> (std::path::PathBuf, Connection) {
        let (path, mut connection) = super::v3_migration_tests::fixture(name);
        connection.execute_batch(MIGRATION_V4).unwrap();
        connection.execute_batch(MIGRATION_V5).unwrap();
        connection.execute_batch(MIGRATION_V6).unwrap();
        connection.execute_batch(MIGRATION_V7).unwrap();
        connection.pragma_update(None, "user_version", 7).unwrap();
        let tx = connection.transaction().unwrap();
        for (message, sequence, reply_to) in [(REPLY, 3, ROOT), (NESTED, 4, REPLY)] {
            tx.execute(
                "INSERT INTO messages(message_id,group_id,group_sequence,sender_peer_id,sender_binding_revision,client_key,semantic_payload_json,body,topic,reply_to_message_id,committed_at_millis) VALUES(?1,?2,?3,?4,1,?5,'{}','reply',NULL,?6,1)",
                params![message, GROUP, sequence, SENDER, format!("key-{sequence}"), reply_to],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO recipient_deliveries(message_id,recipient_peer_id,recipient_binding_revision,saved_at_millis,delivery_generation) VALUES(?1,?2,1,1,1)",
                params![message, RECIPIENT],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO recipient_ack_order VALUES(?1,?2,?3,?4,1,1,0)",
                params![message, RECIPIENT, GROUP, sequence],
            )
            .unwrap();
        }
        tx.execute(
            "UPDATE groups SET next_sequence=5 WHERE group_id=?1",
            [GROUP],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO mailbox_cursors(cursor_id,authority_id,group_id,peer_id,binding_revision,policy_revision,snapshot_high_sequence,position_sequence,created_at_millis,expires_at_millis) VALUES(?1,?2,?3,?4,1,1,4,1,1,9223372036854775807)",
            params![CURSOR, AUTHORITY, GROUP, RECIPIENT],
        )
        .unwrap();
        tx.commit().unwrap();
        (path, connection)
    }

    #[test]
    fn exact_v7_migrates_to_v8_with_backfilled_thread_roots_and_usable_legacy_cursor() {
        let (path, connection) = fixture("v7-to-v8");
        drop(connection);
        let mut store = Store::open(&path).unwrap();
        let inspection = store.inspect().unwrap();
        assert_eq!(inspection.schema_version, SCHEMA_VERSION);
        assert_eq!(inspection.table_count, 35);
        assert!(inspection.integrity_ok);
        for (message, expected_root) in [
            (ROOT, ROOT),
            (OTHER_ROOT, OTHER_ROOT),
            (REPLY, ROOT),
            (NESTED, ROOT),
        ] {
            let root: String = store
                .connection
                .query_row(
                    "SELECT thread_root_message_id FROM messages WHERE message_id=?1",
                    [message],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(root, expected_root, "{message}");
        }
        let (kind, selector): (String, Option<String>) = store
            .connection
            .query_row(
                "SELECT read_kind,selector FROM mailbox_cursors WHERE cursor_id=?1",
                [CURSOR],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((kind.as_str(), selector), ("mailbox", None));
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT inventory_revision,delivery_revision FROM owner_state",
                    [],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
                )
                .unwrap(),
            (1, 1)
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

        // The retained v7 cursor keeps its exact frozen meaning through the new
        // navigation entry point, and thread reads see backfilled roots.
        let recipient = PeerPrincipal::new(
            AuthorityId::parse(AUTHORITY).unwrap(),
            PeerId::parse(RECIPIENT).unwrap(),
            Revision::new(1).unwrap(),
        );
        let group = GroupId::parse(GROUP).unwrap();
        let page = store
            .read_mailbox_after(
                &recipient,
                MailboxAfterRequest {
                    group_id: group.clone(),
                    navigation: MailboxNavigation::Cursor(MailboxCursor::parse(CURSOR).unwrap()),
                    max_items: 8,
                },
            )
            .unwrap();
        assert_eq!(
            page.messages
                .iter()
                .map(|e| e.message.group_sequence)
                .collect::<Vec<_>>(),
            vec![2, 3, 4]
        );
        assert_eq!(page.snapshot_high_sequence, 4);
        let thread = store
            .read_thread(
                &recipient,
                ThreadPageRequest {
                    group_id: group.clone(),
                    root: MessageId::parse(ROOT).unwrap(),
                    navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
                    max_items: 8,
                },
            )
            .unwrap();
        assert_eq!(
            thread
                .messages
                .iter()
                .map(|e| e.message.message_id.as_str().to_owned())
                .collect::<Vec<_>>(),
            vec![ROOT.to_owned(), REPLY.to_owned(), NESTED.to_owned()]
        );
        // The insert trigger keeps roots for raw inserts without the column.
        store
            .connection
            .execute(
                "INSERT INTO messages(message_id,group_id,group_sequence,sender_peer_id,sender_binding_revision,client_key,semantic_payload_json,body,reply_to_message_id,committed_at_millis) VALUES('m_00000000000000000000000000000005',?1,5,?2,1,'key-5','{}','raw',?3,1)",
                params![GROUP, SENDER, NESTED],
            )
            .unwrap();
        let raw_root: String = store
            .connection
            .query_row(
                "SELECT thread_root_message_id FROM messages WHERE message_id='m_00000000000000000000000000000005'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(raw_root, ROOT);
    }

    #[test]
    fn late_v8_migration_failure_keeps_exact_v7_schema_and_data() {
        let (path, mut connection) = fixture("v7-to-v8-rollback");
        let before = schema_manifest(&connection).unwrap();
        let identity = DatabaseIdentity {
            application_id: APPLICATION_ID,
            schema_version: 7,
            has_objects: true,
        };
        assert!(migrate_with_final_sql(
            &mut connection,
            identity,
            Some("INSERT INTO owner_state(singleton,inventory_revision,delivery_revision) VALUES(1,1,1)")
        )
        .is_err());
        assert_eq!(schema_manifest(&connection).unwrap(), before);
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            7
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE name IN ('owner_state','source_registrations','publication_commitments','messages_by_thread')",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM messages", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            4
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT position_sequence FROM mailbox_cursors WHERE cursor_id=?1",
                    [CURSOR],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        drop(connection);
        let store = Store::open(path).unwrap();
        assert_eq!(store.inspect().unwrap().schema_version, SCHEMA_VERSION);
        assert!(store.inspect().unwrap().integrity_ok);
    }
}

#[cfg(test)]
mod v9_migration_tests {
    use super::*;
    use crate::{model::*, store::Store};
    use rusqlite::params;

    const AUTHORITY: &str = "a_00000000000000000000000000000001";
    const GROUP: &str = "g_00000000000000000000000000000001";
    const OTHER_GROUP: &str = "g_00000000000000000000000000000002";
    const SENDER: &str = "p_00000000000000000000000000000001";
    const RECIPIENT: &str = "p_00000000000000000000000000000002";
    const CONTINUED: &str = "p_00000000000000000000000000000003";
    const ROOT: &str = "m_00000000000000000000000000000001";
    const TRANSFERRED: &str = "m_00000000000000000000000000000005";
    const SELF_ROW: &str = "m_00000000000000000000000000000006";
    const THREAD_CURSOR: &str = "c_00000000000000000000000000000008";
    const ACTIVE_SOURCE: &str = "src_00000000000000000000000000000001";
    const WITHDRAWN_SOURCE: &str = "src_00000000000000000000000000000002";
    const LEGACY_COMMITMENT: &str = "pub_00000000000000000000000000000001";
    const LEGACY_LEASE: &str = "lease_00000000000000000000000000000001";

    /// Exact populated v8 database: legacy commitment row, active and
    /// withdrawn registrations with history, a source reference, a thread
    /// cursor, statuses, a legacy self delivery, a removed membership and a
    /// continuation-transferred current delivery.
    fn fixture(name: &str) -> (std::path::PathBuf, Connection) {
        let (path, mut connection) = super::v8_migration_tests::fixture(name);
        connection.execute_batch(MIGRATION_V8).unwrap();
        connection.pragma_update(None, "user_version", 8).unwrap();
        let tx = connection.transaction().unwrap();
        tx.execute("INSERT INTO peers VALUES(?1,2,1)", [CONTINUED])
            .unwrap();
        for revision in 1..=2 {
            tx.execute(
                "INSERT INTO peer_bindings VALUES(?1,?2,?3,'peer-3','codex','peer-3',NULL,100,1000,1,1)",
                params![CONTINUED, revision, format!("l_{:032x}", 2 + revision)],
            )
            .unwrap();
        }
        tx.execute(
            "INSERT INTO group_memberships VALUES(?1,?2,1,NULL)",
            [GROUP, CONTINUED],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO groups VALUES(?1,?2,2,1,'removed-history',0,1)",
            [OTHER_GROUP, AUTHORITY],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO group_memberships VALUES(?1,?2,1,2)",
            [OTHER_GROUP, CONTINUED],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO group_memberships VALUES(?1,?2,1,NULL)",
            [OTHER_GROUP, SENDER],
        )
        .unwrap();
        // Transferred: the root and a reply delivered to binding 1, moved to
        // binding 2 unfetched by a continuation.
        tx.execute(
            "INSERT INTO messages(message_id,group_id,group_sequence,sender_peer_id,sender_binding_revision,client_key,semantic_payload_json,body,reply_to_message_id,committed_at_millis) VALUES(?1,?2,5,?3,1,'key-5','{}','transferred',?4,1)",
            params![TRANSFERRED, GROUP, SENDER, ROOT],
        )
        .unwrap();
        for (message, sequence) in [(ROOT, 1), (TRANSFERRED, 5)] {
            tx.execute(
                "INSERT INTO recipient_deliveries(message_id,recipient_peer_id,recipient_binding_revision,saved_at_millis,delivery_generation) VALUES(?1,?2,1,1,1)",
                params![message, CONTINUED],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO delivery_generations VALUES(?1,?2,2,2)",
                params![message, CONTINUED],
            )
            .unwrap();
            tx.execute(
                "UPDATE current_deliveries SET recipient_binding_revision=2,delivery_generation=2 WHERE message_id=?1 AND recipient_peer_id=?2",
                params![message, CONTINUED],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO recipient_ack_order VALUES(?1,?2,?3,?4,2,2,0)",
                params![message, CONTINUED, GROUP, sequence],
            )
            .unwrap();
        }
        // Legacy self row: sender is its own current recipient, no ACK order.
        tx.execute(
            "INSERT INTO messages(message_id,group_id,group_sequence,sender_peer_id,sender_binding_revision,client_key,semantic_payload_json,body,reply_to_message_id,committed_at_millis) VALUES(?1,?2,6,?3,1,'key-6','{}','self',?4,1)",
            params![SELF_ROW, GROUP, RECIPIENT, ROOT],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO recipient_deliveries(message_id,recipient_peer_id,recipient_binding_revision,saved_at_millis,delivery_generation) VALUES(?1,?2,1,1,1)",
            params![SELF_ROW, RECIPIENT],
        )
        .unwrap();
        tx.execute(
            "UPDATE groups SET next_sequence=7 WHERE group_id=?1",
            [GROUP],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO mailbox_cursors(cursor_id,authority_id,group_id,peer_id,binding_revision,policy_revision,snapshot_high_sequence,position_sequence,created_at_millis,expires_at_millis,read_kind,selector) VALUES(?1,?2,?3,?4,1,1,6,1,1,9223372036854775807,'thread',?5)",
            params![THREAD_CURSOR, AUTHORITY, GROUP, RECIPIENT, ROOT],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO peer_statuses VALUES(?1,?2,1,1,'legacy status',1,1)",
            [GROUP, RECIPIENT],
        )
        .unwrap();
        for (source, state, epoch) in [
            (ACTIVE_SOURCE, "active", 1),
            (WITHDRAWN_SOURCE, "withdrawn", 2),
        ] {
            tx.execute(
                "INSERT INTO source_registrations VALUES(?1,?2,1,'peer-2','codex-jsonl',?3,?4,?5,?6,?7,NULL,1,1)",
                params![
                    source,
                    RECIPIENT,
                    format!("resolver-{source}"),
                    format!("object-{source}"),
                    format!("evidence-{source}"),
                    state,
                    epoch
                ],
            )
            .unwrap();
            for history_epoch in 1..=epoch {
                tx.execute(
                    "INSERT INTO source_registration_history VALUES(?1,?2,?3,?4,1,?5,?6,?7,1)",
                    params![
                        source,
                        history_epoch,
                        if history_epoch == epoch {
                            state
                        } else {
                            "active"
                        },
                        RECIPIENT,
                        format!("resolver-{source}"),
                        format!("object-{source}"),
                        format!("evidence-{source}")
                    ],
                )
                .unwrap();
            }
        }
        tx.execute(
            "INSERT INTO message_source_references VALUES('s_00000000000000000000000000000001',?1,0,?2,'codex-jsonl',?3,1,'snapshot-1',1)",
            params![TRANSFERRED, ACTIVE_SOURCE, RECIPIENT],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO publication_commitments VALUES(?1,?2,'legacy response reference',?3,?4,1,?5,1,?6,1,1,77,5)",
            params![LEGACY_COMMITMENT, LEGACY_LEASE, AUTHORITY, GROUP, SENDER, ACTIVE_SOURCE],
        )
        .unwrap();
        tx.commit().unwrap();
        (path, connection)
    }

    fn projection(
        connection: &Connection,
    ) -> Vec<(String, String, i64, String, String, i64, String)> {
        let mut statement = connection
            .prepare("SELECT message_id,recipient_peer_id,recipient_binding_revision,group_id,thread_root_message_id,group_sequence,sender_peer_id FROM current_thread_deliveries ORDER BY message_id,recipient_peer_id")
            .unwrap();
        let rows = statement
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            })
            .unwrap();
        rows.map(Result::unwrap).collect()
    }

    fn expected_projection(
        connection: &Connection,
    ) -> Vec<(String, String, i64, String, String, i64, String)> {
        let mut statement = connection
            .prepare("SELECT d.message_id,d.recipient_peer_id,d.recipient_binding_revision,d.group_id,m.thread_root_message_id,d.group_sequence,m.sender_peer_id FROM current_deliveries d JOIN messages m ON m.message_id=d.message_id ORDER BY d.message_id,d.recipient_peer_id")
            .unwrap();
        let rows = statement
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            })
            .unwrap();
        rows.map(Result::unwrap).collect()
    }

    type LegacyCommitment = (
        (String, String, String, String, String, i64),
        (String, i64, String, i64, i64, i64, i64),
    );

    fn legacy_commitment(connection: &Connection) -> LegacyCommitment {
        connection
            .query_row(
                "SELECT commitment_id,lease_id,response_reference,authority_id,group_id,policy_revision,caller_peer_id,caller_binding_revision,source_id,source_owner_binding_revision,registration_epoch,reserved_bytes,committed_at_millis FROM publication_commitments WHERE commitment_id=?1",
                [LEGACY_COMMITMENT],
                |r| {
                    Ok((
                        (
                            r.get(0)?,
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                            r.get(5)?,
                        ),
                        (
                            r.get(6)?,
                            r.get(7)?,
                            r.get(8)?,
                            r.get(9)?,
                            r.get(10)?,
                            r.get(11)?,
                            r.get(12)?,
                        ),
                    ))
                },
            )
            .unwrap()
    }

    fn principal(peer: &str, revision: u64) -> PeerPrincipal {
        PeerPrincipal::new(
            AuthorityId::parse(AUTHORITY).unwrap(),
            PeerId::parse(peer).unwrap(),
            Revision::new(revision).unwrap(),
        )
    }

    #[test]
    fn exact_populated_v8_migrates_to_v9_preserving_rows_and_completing_the_projection() {
        let (path, connection) = fixture("v8-to-v9");
        let before_commitment = legacy_commitment(&connection);
        let before_sources: Vec<(String, String, i64)> = {
            let mut statement = connection
                .prepare("SELECT source_id,state,registration_epoch FROM source_registrations ORDER BY source_id")
                .unwrap();
            let rows = statement
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap();
            rows.map(Result::unwrap).collect()
        };
        let before_deliveries: Vec<(String, String, i64, i64)> = {
            let mut statement = connection
                .prepare("SELECT message_id,recipient_peer_id,recipient_binding_revision,delivery_generation FROM current_deliveries ORDER BY message_id,recipient_peer_id")
                .unwrap();
            let rows = statement
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .unwrap();
            rows.map(Result::unwrap).collect()
        };
        assert_eq!(before_deliveries.len(), 7);
        drop(connection);

        let mut store = Store::open(&path).unwrap();
        let inspection = store.inspect().unwrap();
        assert_eq!(inspection.schema_version, SCHEMA_VERSION);
        assert_eq!(inspection.table_count, 35);
        assert!(inspection.integrity_ok);
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
        // Legacy rows keep their exact bytes; the additive columns are NULL.
        assert_eq!(legacy_commitment(&store.connection), before_commitment);
        assert!(store
            .connection
            .query_row(
                "SELECT destination_id IS NULL AND body_bytes IS NULL AND snapshot_identity IS NULL AND captured_through IS NULL FROM publication_commitments WHERE commitment_id=?1",
                [LEGACY_COMMITMENT],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
        let after_sources: Vec<(String, String, i64)> = {
            let mut statement = store
                .connection
                .prepare("SELECT source_id,state,registration_epoch FROM source_registrations ORDER BY source_id")
                .unwrap();
            let rows = statement
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap();
            rows.map(Result::unwrap).collect()
        };
        assert_eq!(after_sources, before_sources);
        let after_deliveries: Vec<(String, String, i64, i64)> = {
            let mut statement = store
                .connection
                .prepare("SELECT message_id,recipient_peer_id,recipient_binding_revision,delivery_generation FROM current_deliveries ORDER BY message_id,recipient_peer_id")
                .unwrap();
            let rows = statement
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .unwrap();
            rows.map(Result::unwrap).collect()
        };
        assert_eq!(after_deliveries, before_deliveries);
        // The projection is complete and exact, including the transferred
        // binding and the legacy self row.
        let projected = projection(&store.connection);
        assert_eq!(projected, expected_projection(&store.connection));
        assert_eq!(projected.len(), 7);
        assert!(projected
            .iter()
            .any(|row| row.0 == TRANSFERRED && row.1 == CONTINUED && row.2 == 2 && row.4 == ROOT));
        assert!(projected
            .iter()
            .any(|row| row.0 == SELF_ROW && row.1 == RECIPIENT && row.6 == RECIPIENT));
        for object in [
            "current_thread_deliveries",
            "current_thread_delivery_page",
            "messages_by_sender_thread",
            "membership_active_by_group",
            "source_registrations_active_by_binding",
            "project_current_thread_delivery",
            "rebind_current_thread_delivery",
        ] {
            assert_eq!(
                store
                    .connection
                    .query_row(
                        "SELECT count(*) FROM sqlite_schema WHERE name=?1",
                        [object],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                1,
                "{object}"
            );
        }

        // The retained thread cursor keeps its exact frozen meaning.
        let recipient = principal(RECIPIENT, 1);
        let group = GroupId::parse(GROUP).unwrap();
        let root = MessageId::parse(ROOT).unwrap();
        let thread = store
            .read_thread(
                &recipient,
                ThreadPageRequest {
                    group_id: group.clone(),
                    root: root.clone(),
                    navigation: MailboxNavigation::Cursor(
                        MailboxCursor::parse(THREAD_CURSOR).unwrap(),
                    ),
                    max_items: 8,
                },
            )
            .unwrap();
        assert_eq!(
            thread
                .messages
                .iter()
                .map(|e| e.message.group_sequence)
                .collect::<Vec<_>>(),
            vec![3, 4, 6]
        );
        assert_eq!(thread.snapshot_high_sequence, 6);
        let self_entry = &thread.messages[2];
        assert_eq!(self_entry.message.message_id.as_str(), SELF_ROW);
        assert!(self_entry.receipt.is_some());
        assert!(matches!(
            store.acknowledge_message(&recipient, &group, &MessageId::parse(SELF_ROW).unwrap()),
            Err(StoreError::Unauthorized { .. })
        ));
        // The transferred row is visible to the successor binding only.
        let successor = principal(CONTINUED, 2);
        let page = store
            .read_thread(
                &successor,
                ThreadPageRequest {
                    group_id: group.clone(),
                    root: root.clone(),
                    navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
                    max_items: 8,
                },
            )
            .unwrap();
        assert_eq!(
            page.messages
                .iter()
                .map(|e| e.message.group_sequence)
                .collect::<Vec<_>>(),
            vec![1, 5]
        );
        assert!(matches!(
            store.read_thread(
                &principal(CONTINUED, 1),
                ThreadPageRequest {
                    group_id: group.clone(),
                    root: root.clone(),
                    navigation: MailboxNavigation::ResetAfter { after_sequence: 0 },
                    max_items: 8,
                },
            ),
            Err(StoreError::StaleBinding)
        ));

        // New owner subpages read the migrated inventory.
        let owner = store.trusted_owner();
        let OwnerSnapshotPage::PeerSources(sources) = store
            .owner_snapshot(
                &owner,
                OwnerSnapshotRequest::PeerSources {
                    peer_id: PeerId::parse(RECIPIENT).unwrap(),
                    expected_inventory_revision: None,
                    after_source: None,
                    max_items: 8,
                },
            )
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(
            sources
                .sources
                .iter()
                .map(|s| (s.source_id.as_str().to_owned(), s.state))
                .collect::<Vec<_>>(),
            vec![
                (ACTIVE_SOURCE.to_owned(), SourceState::Active),
                (WITHDRAWN_SOURCE.to_owned(), SourceState::Withdrawn)
            ]
        );
        let OwnerSnapshotPage::PeerMemberships(memberships) = store
            .owner_snapshot(
                &owner,
                OwnerSnapshotRequest::PeerMemberships {
                    peer_id: PeerId::parse(CONTINUED).unwrap(),
                    expected_inventory_revision: None,
                    after_group: None,
                    max_items: 8,
                },
            )
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(
            memberships
                .memberships
                .iter()
                .map(|m| m.group_id.as_str().to_owned())
                .collect::<Vec<_>>(),
            vec![GROUP.to_owned()]
        );
        let OwnerSnapshotPage::GroupMembers(members) = store
            .owner_snapshot(
                &owner,
                OwnerSnapshotRequest::GroupMembers {
                    group_id: GroupId::parse(OTHER_GROUP).unwrap(),
                    expected_inventory_revision: None,
                    after_peer: None,
                    max_items: 8,
                },
            )
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(
            members
                .members
                .iter()
                .map(|p| p.as_str().to_owned())
                .collect::<Vec<_>>(),
            vec![SENDER.to_owned()]
        );
        // The migrated database is recognized as the exact current schema on reopen.
        drop(store);
        let reopened = Store::open(&path).unwrap();
        assert_eq!(reopened.inspect().unwrap().schema_version, SCHEMA_VERSION);
    }

    #[test]
    fn late_v9_migration_failure_keeps_exact_v8_schema_and_data() {
        let (path, mut connection) = fixture("v8-to-v9-rollback");
        let before = schema_manifest(&connection).unwrap();
        let before_commitment = legacy_commitment(&connection);
        let identity = DatabaseIdentity {
            application_id: APPLICATION_ID,
            schema_version: 8,
            has_objects: true,
        };
        assert!(migrate_with_final_sql(
            &mut connection,
            identity,
            Some("INSERT INTO owner_state(singleton,inventory_revision,delivery_revision) VALUES(1,1,1)")
        )
        .is_err());
        assert_eq!(schema_manifest(&connection).unwrap(), before);
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            8
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE name IN ('current_thread_deliveries','current_thread_delivery_page','messages_by_sender_thread','membership_active_by_group','source_registrations_active_by_binding')",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(legacy_commitment(&connection), before_commitment);
        assert!(connection
            .query_row(
                "SELECT destination_id FROM publication_commitments LIMIT 1",
                [],
                |r| r.get::<_, Option<String>>(0)
            )
            .is_err());
        // The exact v8 database is still recognized and migrates cleanly.
        let expected = Connection::open_in_memory().unwrap();
        expected.execute_batch(SCHEMA_V1).unwrap();
        for migration in [
            MIGRATION_V2,
            MIGRATION_V3,
            MIGRATION_V4,
            MIGRATION_V5,
            MIGRATION_V6,
            MIGRATION_V7,
            MIGRATION_V8,
        ] {
            expected.execute_batch(migration).unwrap();
        }
        assert_eq!(
            schema_manifest(&connection).unwrap(),
            schema_manifest(&expected).unwrap()
        );
        drop(connection);
        let store = Store::open(path).unwrap();
        assert_eq!(store.inspect().unwrap().schema_version, SCHEMA_VERSION);
        assert!(store.inspect().unwrap().integrity_ok);
        assert_eq!(
            projection(&store.connection),
            expected_projection(&store.connection)
        );
    }

    #[test]
    fn fresh_v9_manifest_matches_the_migrated_manifest_and_unknown_schemas_stay_untouched() {
        let (path, connection) = fixture("v8-to-v9-manifest");
        drop(connection);
        let migrated = Store::open(&path).unwrap();
        let migrated_manifest = schema_manifest(&migrated.connection).unwrap();
        let fresh_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../retired/test-artifacts/swarm-core")
            .join(format!("v9-fresh-{}", LaunchId::generate().as_str()));
        std::fs::create_dir_all(&fresh_dir).unwrap();
        let fresh_path = fresh_dir.join("fresh.sqlite");
        let fresh = Store::open(&fresh_path).unwrap();
        assert_eq!(
            schema_manifest(&fresh.connection).unwrap(),
            migrated_manifest
        );
        assert_eq!(fresh.inspect().unwrap().table_count, 35);
        // A current database with one extra index is not recognized and is left
        // byte-for-byte untouched. (A separately created store, not a file
        // copy: the open store's pages still live in its WAL.)
        let foreign_path = fresh_path.with_file_name("foreign.sqlite");
        drop(Store::open(&foreign_path).unwrap());
        let foreign = Connection::open(&foreign_path).unwrap();
        foreign
            .execute_batch("CREATE INDEX foreign_extra ON messages(client_key);")
            .unwrap();
        drop(foreign);
        let before = std::fs::read(&foreign_path).unwrap();
        assert!(matches!(
            Store::open(&foreign_path),
            Err(StoreError::UnrecognizedDatabase {
                schema_version: SCHEMA_VERSION,
                ..
            })
        ));
        assert_eq!(std::fs::read(&foreign_path).unwrap(), before);
    }

    fn exact_v9_fixture(name: &str) -> (std::path::PathBuf, Connection) {
        let (path, connection) = fixture(name);
        connection.execute_batch(MIGRATION_V9).unwrap();
        connection.pragma_update(None, "user_version", 9).unwrap();
        (path, connection)
    }

    #[test]
    fn exact_populated_v9_migrates_to_v10_with_coverage_only_backfilled() {
        let (path, connection) = exact_v9_fixture("v9-to-v10");
        let before_deliveries: Vec<(String, String, i64, String, i64, Option<i64>)> = {
            let mut statement = connection
                .prepare("SELECT message_id,recipient_peer_id,recipient_binding_revision,group_id,group_sequence,fetched_at_millis FROM current_deliveries ORDER BY message_id,recipient_peer_id")
                .unwrap();
            statement
                .query_map([], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        let expected_coverage: Vec<(String, i64, String, i64)> = {
            let mut statement = connection
                .prepare("SELECT recipient_peer_id,recipient_binding_revision,group_id,MAX(group_sequence) FROM current_deliveries GROUP BY recipient_peer_id,recipient_binding_revision,group_id ORDER BY recipient_peer_id,recipient_binding_revision,group_id")
                .unwrap();
            statement
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        drop(connection);

        let store = Store::open(&path).unwrap();
        assert_eq!(store.inspect().unwrap().schema_version, 10);
        let coverage: Vec<(String, i64, String, i64)> = {
            let mut statement = store
                .connection
                .prepare("SELECT recipient_peer_id,recipient_binding_revision,group_id,covered_through_sequence FROM notice_coverage WHERE noticed_through_sequence=0 AND last_attempt_id IS NULL ORDER BY recipient_peer_id,recipient_binding_revision,group_id")
                .unwrap();
            statement
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(coverage, expected_coverage);
        for table in [
            "notice_attempts",
            "notice_tickets",
            "notice_attempt_groups",
            "notice_receipts",
            "notice_not_submitted_reconciliations",
        ] {
            assert_eq!(
                store
                    .connection
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0,
                "migration must not invent {table} evidence"
            );
        }
        let after_deliveries: Vec<(String, String, i64, String, i64, Option<i64>)> = {
            let mut statement = store
                .connection
                .prepare("SELECT message_id,recipient_peer_id,recipient_binding_revision,group_id,group_sequence,fetched_at_millis FROM current_deliveries ORDER BY message_id,recipient_peer_id")
                .unwrap();
            statement
                .query_map([], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(after_deliveries, before_deliveries);
    }

    #[test]
    fn late_v10_migration_failure_keeps_exact_v9_manifest_and_data() {
        let (_path, mut connection) = exact_v9_fixture("v9-to-v10-rollback");
        let before_manifest = schema_manifest(&connection).unwrap();
        let before_rows: i64 = connection
            .query_row("SELECT count(*) FROM current_deliveries", [], |row| {
                row.get(0)
            })
            .unwrap();
        let identity = DatabaseIdentity {
            application_id: APPLICATION_ID,
            schema_version: 9,
            has_objects: true,
        };

        assert!(migrate_with_final_sql(
            &mut connection,
            identity,
            Some("CREATE TABLE notice_coverage(conflict TEXT);")
        )
        .is_err());

        assert_eq!(schema_manifest(&connection).unwrap(), before_manifest);
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            9
        );
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM current_deliveries", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            before_rows
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE name LIKE 'notice_%'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
}
