//! Discovery version 2 compatibility: ordinary readers accept only v2, the
//! exclusive publisher recognizes an exact secure legacy v1 or v2
//! predecessor, malformed/insecure/future/wrong-type objects are preserved
//! untouched, publication retries bounded sharing violations, and v2
//! discovery interoperates with frame version 1 endpoints.

#![cfg(windows)]

use std::{
    fs,
    os::windows::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use termx_swarm_client::{
    AuthorityClaim, AuthorityError, ClientBootstrap, DiscoveryRecord, FrameBudget, OwnerClient,
    PeerClient, PipeServer, ProcessIdentity, TransportOptions, VerifiedProcess, WireError,
    DISCOVERY_VERSION, WIRE_VERSION,
};

const FILE_SHARE_READ: u32 = 0x0000_0001;
type RejectedDiscoveryCase = (&'static str, Vec<u8>, fn(&AuthorityError) -> bool);

/// Exclusive retained container; the returned `authority` child does not
/// exist yet so that `AuthorityClaim::claim` creates it with its private ACL.
fn retained(name: &str) -> PathBuf {
    let container = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../retired/test-artifacts/swarm-client")
        .join(format!(
            "discovery-v2-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    fs::create_dir_all(&container).unwrap();
    container.join("authority")
}

fn pipe(label: &str) -> String {
    format!(
        r"\\.\pipe\termx-swarm-disc2-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}

fn identity() -> ProcessIdentity {
    VerifiedProcess::open(std::process::id())
        .unwrap()
        .identity()
}

fn record(label: &str) -> DiscoveryRecord {
    DiscoveryRecord::new(
        "authority-1",
        "boot-1",
        identity(),
        format!(r"\\.\pipe\termx-{label}-owner"),
        format!(r"\\.\pipe\termx-{label}-peer"),
    )
}

fn legacy_v1_bytes(server: ProcessIdentity) -> Vec<u8> {
    format!(
        concat!(
            r#"{{"version":1,"authorityId":"authority-legacy","bootId":"boot-legacy","#,
            r#""server":{{"pid":{},"creationFiletime":"{}"}},"#,
            r#""pipeName":"\\\\.\\pipe\\termx-legacy"}}"#
        ),
        server.pid, server.creation_filetime
    )
    .into_bytes()
}

/// Retired predecessor objects (`retired/discovery.json.*`), excluding any
/// retired unpublished pending object of our own.
fn retired_files(root: &Path) -> Vec<Vec<u8>> {
    retired_entries(root)
        .into_iter()
        .filter(|(name, _)| name.starts_with("discovery.json"))
        .map(|(_, bytes)| bytes)
        .collect()
}

fn retired_entries(root: &Path) -> Vec<(String, Vec<u8>)> {
    match fs::read_dir(root.join("retired")) {
        Ok(entries) => entries
            .map(|entry| {
                let entry = entry.unwrap();
                (
                    entry.file_name().to_string_lossy().into_owned(),
                    fs::read(entry.path()).unwrap(),
                )
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Seeds a *secure* current object with exact `bytes`: the private file is
/// created by a real publication and then rewritten in place, so its ACL is
/// the publisher's own. A file created any other way is an insecure object
/// (covered by the ownership suite) rather than a recognized predecessor.
fn seed_secure(root: &Path, claim: &AuthorityClaim, bytes: &[u8]) {
    claim.publish_discovery(&record("seed")).unwrap();
    fs::write(root.join("discovery.json"), bytes).unwrap();
    assert!(retired_files(root).is_empty());
}

#[test]
fn discovery_version_is_independent_of_frame_version() {
    assert_eq!(DISCOVERY_VERSION, 2);
    assert_eq!(WIRE_VERSION, 1);
    let value = serde_json::to_value(record("versions")).unwrap();
    assert_eq!(value["version"], 2);
    assert!(value.get("ownerPipeName").is_some());
    assert!(value.get("peerPipeName").is_some());
    assert!(value.get("pipeName").is_none(), "v1 field must not survive");
}

#[test]
fn ordinary_readers_reject_exact_legacy_v1_without_modifying_it() {
    let root = retained("legacy-read");
    let claim = AuthorityClaim::claim(&root).unwrap();
    let bytes = legacy_v1_bytes(identity());
    seed_secure(&root, &claim, &bytes);

    assert!(matches!(
        claim.read_discovery(),
        Err(AuthorityError::InvalidDiscovery)
    ));
    let bootstrap = ClientBootstrap::open(&root).unwrap();
    assert!(matches!(
        bootstrap.read_discovery(),
        Err(AuthorityError::InvalidDiscovery)
    ));
    assert_eq!(fs::read(root.join("discovery.json")).unwrap(), bytes);
    assert!(retired_files(&root).is_empty());
}

#[test]
fn exclusive_publisher_migrates_exact_legacy_v1_and_retires_its_bytes() {
    let root = retained("legacy-migrate");
    let claim = AuthorityClaim::claim(&root).unwrap();
    let legacy = legacy_v1_bytes(identity());
    seed_secure(&root, &claim, &legacy);

    let current = record("migrated");
    claim.publish_discovery(&current).unwrap();

    assert_eq!(claim.read_discovery().unwrap(), current);
    assert_eq!(
        ClientBootstrap::open(&root)
            .unwrap()
            .read_discovery()
            .unwrap(),
        current
    );
    assert_eq!(retired_files(&root), vec![legacy]);
    fs::write(
        root.join("result.json"),
        br#"{"legacy_v1_recognized_by_publisher_only":true,"exact_bytes_retired":true}"#,
    )
    .unwrap();
}

#[test]
fn exclusive_publisher_replaces_secure_v2_predecessor_and_retires_it() {
    let root = retained("v2-replace");
    let claim = AuthorityClaim::claim(&root).unwrap();
    let first = record("first");
    claim.publish_discovery(&first).unwrap();
    let first_bytes = fs::read(root.join("discovery.json")).unwrap();

    let second = record("second");
    claim.publish_discovery(&second).unwrap();

    assert_eq!(claim.read_discovery().unwrap(), second);
    assert_eq!(retired_files(&root), vec![first_bytes]);
}

#[test]
fn malformed_future_and_wrong_shape_objects_block_publication_unchanged() {
    let server = identity();
    let cases: Vec<RejectedDiscoveryCase> = vec![
        ("malformed", b"{legacy".to_vec(), |error| {
            matches!(error, AuthorityError::InvalidDiscovery)
        }),
        (
            "legacy-extra-field",
            {
                let mut text = String::from_utf8(legacy_v1_bytes(server)).unwrap();
                text.insert_str(text.len() - 1, r#","extra":true"#);
                text.into_bytes()
            },
            |error| matches!(error, AuthorityError::InvalidDiscovery),
        ),
        (
            "legacy-version-with-v2-shape",
            {
                let mut value = serde_json::to_value(record("shape")).unwrap();
                value["version"] = serde_json::json!(1);
                serde_json::to_vec(&value).unwrap()
            },
            |error| matches!(error, AuthorityError::InvalidDiscovery),
        ),
        (
            "v2-with-equal-endpoints",
            {
                let mut value = serde_json::to_value(record("equal")).unwrap();
                value["peerPipeName"] = value["ownerPipeName"].clone();
                serde_json::to_vec(&value).unwrap()
            },
            |error| matches!(error, AuthorityError::InvalidDiscovery),
        ),
        (
            "future-v3-with-unknown-fields",
            {
                let mut value = serde_json::to_value(record("future")).unwrap();
                value["version"] = serde_json::json!(3);
                value["futureField"] = serde_json::json!("x");
                serde_json::to_vec(&value).unwrap()
            },
            |error| matches!(error, AuthorityError::FutureDiscovery),
        ),
        (
            "unknown-version-zero",
            {
                let mut value = serde_json::to_value(record("zero")).unwrap();
                value["version"] = serde_json::json!(0);
                serde_json::to_vec(&value).unwrap()
            },
            |error| matches!(error, AuthorityError::InvalidDiscovery),
        ),
    ];
    let mut evidence = Vec::new();
    for (label, bytes, expected) in cases {
        let root = retained(&format!("blocked-{label}"));
        let claim = AuthorityClaim::claim(&root).unwrap();
        seed_secure(&root, &claim, &bytes);
        let error = claim
            .publish_discovery(&record("replacement"))
            .expect_err(label);
        assert!(expected(&error), "{label}: {error:?}");
        let read = claim.read_discovery().expect_err(label);
        assert!(
            matches!(
                read,
                AuthorityError::InvalidDiscovery | AuthorityError::FutureDiscovery
            ),
            "{label}: {read:?}"
        );
        assert_eq!(
            fs::read(root.join("discovery.json")).unwrap(),
            bytes,
            "{label}"
        );
        assert!(retired_files(&root).is_empty(), "{label}");
        assert!(
            !fs::read_dir(&root).unwrap().any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("discovery.pending")),
            "{label}: no pending object may be left beside a blocked predecessor"
        );
        evidence.push(format!("{label}:{error:?}"));
    }
    let root = retained("blocked-directory");
    let claim = AuthorityClaim::claim(&root).unwrap();
    fs::create_dir(root.join("discovery.json")).unwrap();
    assert!(claim.publish_discovery(&record("dir")).is_err());
    assert!(root.join("discovery.json").is_dir());
    evidence.push("directory:blocked".into());
    fs::write(root.join("result.txt"), evidence.join("\n")).unwrap();
}

#[test]
fn equal_endpoint_names_are_rejected_before_publication() {
    let root = retained("equal-names");
    let claim = AuthorityClaim::claim(&root).unwrap();
    let same = DiscoveryRecord::new(
        "authority-1",
        "boot-1",
        identity(),
        r"\\.\pipe\termx-same",
        r"\\.\pipe\termx-same",
    );
    assert!(!same.validate());
    assert!(matches!(
        claim.publish_discovery(&same),
        Err(AuthorityError::InvalidDiscovery)
    ));
    assert!(!root.join("discovery.json").exists());
}

#[test]
fn case_alias_endpoint_names_are_rejected_before_publication() {
    let root = retained("case-alias-names");
    let claim = AuthorityClaim::claim(&root).unwrap();
    let same = DiscoveryRecord::new(
        "authority-1",
        "boot-1",
        identity(),
        r"\\.\pipe\termx-same",
        r"\\.\pipe\TERMX-SAME",
    );
    assert!(!same.validate(), "Windows pipe names are case insensitive");
    assert!(matches!(
        claim.publish_discovery(&same),
        Err(AuthorityError::InvalidDiscovery)
    ));
    assert!(!root.join("discovery.json").exists());
}

fn hold_shared_read(path: &Path, duration: Duration) -> thread::JoinHandle<()> {
    let file = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
        .unwrap();
    thread::spawn(move || {
        thread::sleep(duration);
        drop(file);
    })
}

#[test]
fn held_reader_publication_succeeds_after_release_within_bound() {
    let root = retained("held-reader-release");
    let claim = AuthorityClaim::claim(&root).unwrap();
    let first = record("held-first");
    claim.publish_discovery(&first).unwrap();
    let first_bytes = fs::read(root.join("discovery.json")).unwrap();
    let holder = hold_shared_read(&root.join("discovery.json"), Duration::from_millis(400));

    let started = Instant::now();
    let second = record("held-second");
    claim.publish_discovery(&second).unwrap();
    let elapsed = started.elapsed();
    holder.join().unwrap();

    assert!(
        elapsed >= Duration::from_millis(250),
        "publication must have waited for the held reader: {elapsed:?}"
    );
    assert_eq!(claim.read_discovery().unwrap(), second);
    assert_eq!(retired_files(&root), vec![first_bytes]);
    fs::write(
        root.join("result.json"),
        format!(r#"{{"waited_millis":{}}}"#, elapsed.as_millis()),
    )
    .unwrap();
}

#[test]
fn held_reader_past_bound_returns_contended_with_predecessor_intact() {
    let root = retained("held-reader-timeout");
    let claim = AuthorityClaim::claim(&root).unwrap();
    let first = record("held-first");
    claim.publish_discovery(&first).unwrap();
    let first_bytes = fs::read(root.join("discovery.json")).unwrap();
    let holder = hold_shared_read(&root.join("discovery.json"), Duration::from_secs(6));

    let started = Instant::now();
    let error = claim
        .publish_discovery(&record("held-second"))
        .expect_err("held past the bound");
    let elapsed = started.elapsed();

    assert!(matches!(error, AuthorityError::Contended), "{error:?}");
    assert!(
        elapsed < Duration::from_secs(5),
        "retry must stay bounded: {elapsed:?}"
    );
    assert_eq!(fs::read(root.join("discovery.json")).unwrap(), first_bytes);
    assert_eq!(claim.read_discovery().unwrap(), first);
    assert!(
        retired_files(&root).is_empty(),
        "predecessor was not retired"
    );
    let entries = retired_entries(&root);
    assert_eq!(
        entries.len(),
        1,
        "only our own pending object is moved aside"
    );
    assert!(entries[0].0.starts_with("discovery.pending"));
    assert!(
        !fs::read_dir(&root).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("discovery.pending")),
        "no pending object may be left beside the intact predecessor"
    );
    holder.join().unwrap();
    fs::write(
        root.join("result.json"),
        format!(
            r#"{{"error":"{error:?}","bounded_millis":{}}}"#,
            elapsed.as_millis()
        ),
    )
    .unwrap();
}

#[tokio::test]
async fn owner_and_peer_clients_select_only_their_own_endpoint() {
    let budget = FrameBudget::new(1024 * 1024);
    let owner_name = pipe("owner");
    let peer_name = pipe("peer");
    let mut owner_server = PipeServer::bind(&owner_name, budget.clone()).unwrap();
    let mut peer_server = PipeServer::bind(&peer_name, budget.clone()).unwrap();
    let discovery = DiscoveryRecord::new(
        "authority-1",
        "boot-1",
        owner_server.identity(),
        &owner_name,
        &peer_name,
    );
    assert_eq!(discovery.version, DISCOVERY_VERSION);
    let root = retained("interop");
    let claim = AuthorityClaim::claim(&root).unwrap();
    let credential = claim.load_or_create_owner_credential().unwrap();
    claim.publish_discovery(&discovery).unwrap();
    let published = ClientBootstrap::open(&root)
        .unwrap()
        .read_discovery()
        .unwrap();

    let owner_side = tokio::spawn(async move {
        let pipe = owner_server.accept().await.unwrap();
        pipe.authenticate_owner("boot-1", &credential)
            .await
            .unwrap();
        pipe.connecting_client_identity().unwrap()
    });
    let peer_side = tokio::spawn(async move {
        let pipe = peer_server.accept().await.unwrap();
        pipe.authenticate_peer("boot-1").await.unwrap();
        pipe.connecting_client_identity().unwrap()
    });
    let client_credential = ClientBootstrap::open(&root)
        .unwrap()
        .load_owner_credential()
        .unwrap();
    let owner = OwnerClient::connect(&published, &client_credential)
        .await
        .unwrap();
    let peer = PeerClient::connect(&published).await.unwrap();
    assert_eq!(owner.server_identity(), discovery.server);
    assert_eq!(peer.server_identity(), discovery.server);
    assert_eq!(owner_side.await.unwrap(), identity());
    assert_eq!(peer_side.await.unwrap(), identity());

    // Neither client opens the other endpoint: with only the owner pipe
    // bound, the peer client fails natively and vice versa.
    let owner_only = DiscoveryRecord::new(
        "authority-1",
        "boot-1",
        identity(),
        &owner_name,
        pipe("unbound-peer"),
    );
    let options = TransportOptions {
        connect_timeout: Duration::from_millis(200),
        ..TransportOptions::default()
    };
    assert!(matches!(
        PeerClient::connect_with_options(&owner_only, options).await,
        Err(WireError::Native(2))
    ));
}
