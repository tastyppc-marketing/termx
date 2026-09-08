mod message;
mod policy;
mod query;
mod schema;

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction};

use crate::error::StoreError;
use crate::model::{AuthorityId, GroupId, PeerPrincipal, Revision};

pub use schema::{APPLICATION_ID, SCHEMA_VERSION};

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub struct Store {
    pub(super) connection: Connection,
    pub(super) authority_id: AuthorityId,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoreInspection {
    pub application_id: i64,
    pub schema_version: i64,
    pub authority_id: AuthorityId,
    pub sqlite_version: String,
    pub sqlite_version_number: i32,
    pub foreign_keys: bool,
    pub journal_mode: String,
    pub synchronous: String,
    pub busy_timeout_millis: u64,
    pub integrity_ok: bool,
    pub table_count: u32,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = path.as_ref().to_path_buf();
        let identity = inspect_existing_identity(&path)?;

        let mut connection = Connection::open(&path)?;
        configure_connection(&connection)?;
        schema::migrate(&mut connection, identity)?;
        let authority_id = validate_authority(&connection)?;
        verify_pragmas(&connection)?;
        Ok(Self {
            connection,
            authority_id,
        })
    }

    pub fn inspect(&self) -> Result<StoreInspection, StoreError> {
        let application_id = pragma_i64(&self.connection, "application_id")?;
        let schema_version = pragma_i64(&self.connection, "user_version")?;
        let authority: String = self.connection.query_row(
            "SELECT authority_id FROM authority_metadata WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        let sqlite_version: String =
            self.connection
                .query_row("SELECT sqlite_version()", [], |row| row.get(0))?;
        let foreign_keys = pragma_i64(&self.connection, "foreign_keys")? == 1;
        let journal_mode = pragma_string(&self.connection, "journal_mode")?.to_ascii_lowercase();
        let synchronous_number = pragma_i64(&self.connection, "synchronous")?;
        let synchronous = match synchronous_number {
            2 => "FULL".to_owned(),
            other => other.to_string(),
        };
        let busy_timeout_millis = u64::try_from(pragma_i64(&self.connection, "busy_timeout")?)
            .map_err(|_| StoreError::DurabilityMismatch {
                setting: "busy_timeout",
                expected: "nonnegative".to_owned(),
                actual: "negative".to_owned(),
            })?;
        let integrity: String = self
            .connection
            .query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        let table_count = self.connection.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*'",
            [],
            |row| row.get::<_, u32>(0),
        )?;

        Ok(StoreInspection {
            application_id,
            schema_version,
            authority_id: AuthorityId::parse(&authority)?,
            sqlite_version,
            sqlite_version_number: rusqlite::version_number(),
            foreign_keys,
            journal_mode,
            synchronous,
            busy_timeout_millis,
            integrity_ok: integrity == "ok",
            table_count,
        })
    }
}

fn inspect_existing_identity(path: &Path) -> Result<schema::DatabaseIdentity, StoreError> {
    if !path.exists() || std::fs::metadata(path)?.len() == 0 {
        return Ok(schema::DatabaseIdentity::new());
    }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let application_id = pragma_i64(&connection, "application_id")?;
    let schema_version = pragma_i64(&connection, "user_version")?;
    let object_count: i64 = connection.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
        [],
        |row| row.get(0),
    )?;
    let identity = schema::DatabaseIdentity {
        application_id,
        schema_version,
        has_objects: object_count != 0,
    };
    schema::validate_identity(path, &identity)?;
    schema::validate_recognized_schema(&connection, path, &identity)?;
    Ok(identity)
}

fn configure_connection(connection: &Connection) -> Result<(), StoreError> {
    connection.busy_timeout(BUSY_TIMEOUT)?;
    connection.pragma_update(None, "foreign_keys", true)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    Ok(())
}

fn validate_authority(connection: &Connection) -> Result<AuthorityId, StoreError> {
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
    Ok(AuthorityId::parse(&authority)?)
}

pub(super) struct AuthorizedPeer {
    pub policy_revision: Revision,
}

pub(super) fn authorize_peer(
    transaction: &Transaction<'_>,
    authority_id: &AuthorityId,
    principal: &PeerPrincipal,
    group_id: &GroupId,
) -> Result<AuthorizedPeer, StoreError> {
    if principal.authority_id != *authority_id {
        return Err(StoreError::AuthorityMismatch);
    }
    let binding = transaction
        .query_row(
            "SELECT p.current_binding_revision, b.live FROM peers p JOIN peer_bindings b ON b.peer_id=p.peer_id AND b.binding_revision=p.current_binding_revision WHERE p.peer_id=?1",
            [principal.peer_id.as_str()],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()?;
    let Some((current_revision, live)) = binding else {
        return Err(StoreError::Unauthorized {
            reason: "unknown peer",
        });
    };
    if current_revision != principal.binding_revision.as_sql_i64() {
        return Err(StoreError::StaleBinding);
    }
    if !live {
        return Err(StoreError::BindingOffline);
    }
    let group = transaction
        .query_row(
            "SELECT policy_revision, paused FROM groups WHERE group_id=?1 AND authority_id=?2",
            [group_id.as_str(), authority_id.as_str()],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()?;
    let Some((policy_revision, paused)) = group else {
        return Err(StoreError::NotFound { kind: "group" });
    };
    if paused {
        return Err(StoreError::GroupPaused);
    }
    let member = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM group_memberships WHERE group_id=?1 AND peer_id=?2 AND removed_policy_revision IS NULL)",
        [group_id.as_str(), principal.peer_id.as_str()],
        |row| row.get::<_, bool>(0),
    )?;
    if !member {
        return Err(StoreError::Unauthorized {
            reason: "peer is not an active group member",
        });
    }
    Ok(AuthorizedPeer {
        policy_revision: Revision::new(u64::try_from(policy_revision).map_err(|_| {
            StoreError::Unauthorized {
                reason: "invalid stored policy revision",
            }
        })?)?,
    })
}

pub(super) fn now_millis(transaction: &Transaction<'_>) -> Result<i64, StoreError> {
    Ok(transaction.query_row(
        "SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)",
        [],
        |row| row.get(0),
    )?)
}

fn verify_pragmas(connection: &Connection) -> Result<(), StoreError> {
    check_pragma(
        connection,
        "foreign_keys",
        "1",
        pragma_i64(connection, "foreign_keys")?.to_string(),
    )?;
    check_pragma(
        connection,
        "journal_mode",
        "wal",
        pragma_string(connection, "journal_mode")?.to_ascii_lowercase(),
    )?;
    check_pragma(
        connection,
        "synchronous",
        "2",
        pragma_i64(connection, "synchronous")?.to_string(),
    )?;
    Ok(())
}

fn check_pragma(
    _connection: &Connection,
    setting: &'static str,
    expected: &str,
    actual: String,
) -> Result<(), StoreError> {
    if actual != expected {
        return Err(StoreError::DurabilityMismatch {
            setting,
            expected: expected.to_owned(),
            actual,
        });
    }
    Ok(())
}

fn pragma_i64(connection: &Connection, name: &str) -> rusqlite::Result<i64> {
    connection.pragma_query_value(None, name, |row| row.get(0))
}

fn pragma_string(connection: &Connection, name: &str) -> rusqlite::Result<String> {
    connection.pragma_query_value(None, name, |row| row.get(0))
}
