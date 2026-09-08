use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum ValidationError {
    #[error("{field} must not be empty")]
    Empty { field: &'static str },
    #[error("{field} exceeds its maximum length of {max} bytes")]
    TooLong { field: &'static str, max: usize },
    #[error("invalid {kind} identifier")]
    InvalidId { kind: &'static str },
    #[error("{field} is outside SQLite's signed integer range")]
    IntegerRange { field: &'static str },
    #[error("canonical payload could not be serialized: {0}")]
    CanonicalSerialization(String),
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database at {path:?} belongs to an unrecognized application (application_id={application_id}, schema_version={schema_version})")]
    UnrecognizedDatabase {
        path: PathBuf,
        application_id: i64,
        schema_version: i64,
    },
    #[error("database schema version {found} is newer than supported version {supported}")]
    FutureSchema { found: i64, supported: i64 },
    #[error("database durability setting {setting} was {actual}, expected {expected}")]
    DurabilityMismatch {
        setting: &'static str,
        expected: String,
        actual: String,
    },
    #[error("database contains no authority identity")]
    MissingAuthority,
    #[error("stored authority identity is invalid: {0}")]
    InvalidAuthority(#[from] ValidationError),
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
}
