use std::path::Path;

use rusqlite::{Connection, TransactionBehavior};

use crate::error::StoreError;
use crate::model::AuthorityId;

pub const APPLICATION_ID: i64 = 0x5458_4d31;
pub const SCHEMA_VERSION: i64 = 1;

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
    if identity.schema_version > SCHEMA_VERSION {
        return Err(StoreError::FutureSchema {
            found: identity.schema_version,
            supported: SCHEMA_VERSION,
        });
    }
    Ok(())
}

pub(super) fn migrate(
    connection: &mut Connection,
    identity: DatabaseIdentity,
) -> Result<(), StoreError> {
    if identity.schema_version == SCHEMA_VERSION {
        return Ok(());
    }
    let authority_id = AuthorityId::generate();
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(SCHEMA_V1)?;
    transaction.execute(
        "INSERT INTO authority_metadata(singleton, authority_id, created_at_millis) VALUES (1, ?1, unixepoch('subsec') * 1000)",
        [authority_id.as_str()],
    )?;
    transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
    transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
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
    semantic_payload_json TEXT NOT NULL CHECK (length(CAST(semantic_payload_json AS BLOB)) BETWEEN 1 AND 1052672),
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
