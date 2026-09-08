use std::path::Path;

use rusqlite::{Connection, TransactionBehavior};

use crate::error::StoreError;
use crate::model::AuthorityId;

pub const APPLICATION_ID: i64 = 0x5458_4d31;
pub const SCHEMA_VERSION: i64 = 3;

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
