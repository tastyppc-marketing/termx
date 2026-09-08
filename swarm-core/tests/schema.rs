mod support;

use std::fs;

use rusqlite::Connection;
use termx_swarm_core::error::StoreError;
use termx_swarm_core::model::{
    sqlite_i64, AuthorityId, GroupId, PeerId, SendMessageRequest, MAX_MESSAGE_BODY_BYTES,
};
use termx_swarm_core::store::{Store, APPLICATION_ID, SCHEMA_VERSION};

#[test]
fn new_store_initializes_complete_schema_and_authority() {
    let path = support::retained_db("new-store");
    let store = Store::open(&path).expect("initialize store");
    let inspection = store.inspect().expect("inspect initialized store");

    assert_eq!(inspection.application_id, APPLICATION_ID);
    assert_eq!(inspection.schema_version, SCHEMA_VERSION);
    assert_eq!(inspection.table_count, 10);
    assert!(inspection.integrity_ok);
    assert_ne!(inspection.authority_id.as_str(), "");
}

#[test]
fn reopen_preserves_authority_identity() {
    let path = support::retained_db("reopen");
    let first = Store::open(&path)
        .expect("initialize")
        .inspect()
        .expect("inspect")
        .authority_id;
    let second = Store::open(&path)
        .expect("reopen")
        .inspect()
        .expect("inspect")
        .authority_id;

    assert_eq!(first, second);
}

#[test]
fn unrelated_database_is_rejected_without_mutation() {
    let path = support::retained_db("unrelated");
    let connection = Connection::open(&path).expect("create unrelated database");
    connection
        .execute_batch(
            "CREATE TABLE user_content(value TEXT); INSERT INTO user_content VALUES ('keep');",
        )
        .expect("seed unrelated database");
    drop(connection);
    let before = fs::read(&path).expect("read before");

    assert!(matches!(
        Store::open(&path),
        Err(StoreError::UnrecognizedDatabase { .. })
    ));
    assert_eq!(fs::read(&path).expect("read after"), before);
}

#[test]
fn future_schema_is_rejected_without_mutation() {
    let path = support::retained_db("future");
    let connection = Connection::open(&path).expect("create future database");
    connection
        .pragma_update(None, "application_id", APPLICATION_ID)
        .expect("set application id");
    connection
        .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
        .expect("set future version");
    connection
        .execute_batch("CREATE TABLE future_data(value BLOB);")
        .expect("seed future schema");
    drop(connection);
    let before = fs::read(&path).expect("read before");

    assert!(matches!(
        Store::open(&path),
        Err(StoreError::FutureSchema { .. })
    ));
    assert_eq!(fs::read(&path).expect("read after"), before);
}

#[test]
fn store_verifies_explicit_durability_pragmas() {
    let path = support::retained_db("durability");
    let inspection = Store::open(&path)
        .expect("open")
        .inspect()
        .expect("inspect");

    assert!(inspection.foreign_keys);
    assert_eq!(inspection.journal_mode, "wal");
    assert_eq!(inspection.synchronous, "FULL");
    assert!(inspection.busy_timeout_millis > 0);
}

#[test]
fn failed_migration_rolls_back_schema_changes_and_preserves_existing_state() {
    let path = support::retained_db("migration-failure");
    let connection = Connection::open(&path).expect("create recognized database");
    connection
        .pragma_update(None, "application_id", APPLICATION_ID)
        .expect("set identity");
    connection
        .execute_batch(
            "CREATE TABLE authority_metadata(marker TEXT NOT NULL);\n             INSERT INTO authority_metadata VALUES ('preserve-me');",
        )
        .expect("create incompatible prior state");
    drop(connection);

    assert!(Store::open(&path).is_err());
    let connection = Connection::open(&path).expect("reopen fixture");
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row("SELECT marker FROM authority_metadata", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "preserve-me"
    );
    let created: i64 = connection
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='peers'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(created, 0);
}

#[test]
fn bundled_sqlite_meets_wal_fix_baseline() {
    let path = support::retained_db("sqlite-version");
    let inspection = Store::open(&path)
        .expect("open")
        .inspect()
        .expect("inspect");

    assert!(
        inspection.sqlite_version_number >= 3_051_003,
        "compiled SQLite {} is older than 3.51.3",
        inspection.sqlite_version
    );
}

#[test]
fn validated_authority_ids_reject_wrong_kind_and_malformed_values() {
    let generated = AuthorityId::generate();
    assert_eq!(generated.as_str().len(), 34);
    assert!(AuthorityId::parse(generated.as_str()).is_ok());
    assert!(AuthorityId::parse("peer_00112233445566778899aabbccddeeff").is_err());
    assert!(AuthorityId::parse("authority_not-hex").is_err());
}

#[test]
fn recognized_current_schema_without_authority_is_rejected_on_open() {
    let path = support::retained_db("missing-authority");
    let connection = Connection::open(&path).expect("create malformed recognized database");
    connection
        .pragma_update(None, "application_id", APPLICATION_ID)
        .unwrap();
    connection
        .pragma_update(None, "user_version", SCHEMA_VERSION)
        .unwrap();
    connection
        .execute_batch("CREATE TABLE unrelated(value TEXT);")
        .unwrap();
    drop(connection);

    assert!(matches!(
        Store::open(&path),
        Err(StoreError::MissingAuthority)
    ));
}

#[test]
fn schema_enforces_binding_and_delivery_invariants_in_sqlite() {
    let path = support::retained_db("sql-invariants");
    drop(Store::open(&path).expect("initialize"));
    let connection = Connection::open(&path).expect("open fixture directly");
    connection
        .pragma_update(None, "foreign_keys", true)
        .unwrap();

    assert!(connection.execute("INSERT INTO peer_bindings(peer_id,binding_revision,launch_id,terminal_id,harness,conversation_id,process_id,process_creation_filetime,live,bound_at_millis) VALUES ('p_00000000000000000000000000000000',1,'l_00000000000000000000000000000000','terminal','codex','conversation',1,1,1,1)", []).is_err());
    assert!(connection.execute("INSERT INTO groups(group_id,authority_id,policy_revision,label,paused,created_at_millis) VALUES ('g_00000000000000000000000000000000','a_00000000000000000000000000000000',1,'group',2,1)", []).is_err());
    let oversized_label = "x".repeat(257);
    let authority_id: String = connection
        .query_row("SELECT authority_id FROM authority_metadata", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(connection.execute("INSERT INTO groups(group_id,authority_id,policy_revision,label,paused,created_at_millis) VALUES ('g_00000000000000000000000000000001',?1,1,?2,0,1)", [&authority_id, &oversized_label]).is_err());

    let columns: Vec<String> = connection
        .prepare("SELECT name FROM pragma_table_info('delivery_attempts') ORDER BY cid")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(columns.contains(&"generation".to_owned()));
    assert!(columns.contains(&"attempt_number".to_owned()));
    assert!(columns.contains(&"outcome".to_owned()));
}

#[test]
fn serialized_send_request_rejects_sender_claims_and_validates_limits() {
    let group_id = GroupId::generate();
    let peer_id = PeerId::generate();
    let with_sender = serde_json::json!({
        "group_id": group_id,
        "client_key": "retry-1",
        "recipients": [peer_id],
        "body": "hello",
        "topic": null,
        "reply_to": null,
        "sender": "p_00000000000000000000000000000000"
    });
    assert!(serde_json::from_value::<SendMessageRequest>(with_sender).is_err());

    let request = SendMessageRequest {
        group_id: GroupId::generate(),
        client_key: "retry-2".to_owned(),
        recipients: [PeerId::generate()].into_iter().collect(),
        body: "x".repeat(MAX_MESSAGE_BODY_BYTES + 1),
        topic: None,
        reply_to: None,
    };
    assert!(request.validate().is_err());
}

#[test]
fn unsigned_values_cannot_overflow_sqlite_integer_fields() {
    assert_eq!(sqlite_i64("sequence", i64::MAX as u64).unwrap(), i64::MAX);
    assert!(sqlite_i64("sequence", i64::MAX as u64 + 1).is_err());
}
