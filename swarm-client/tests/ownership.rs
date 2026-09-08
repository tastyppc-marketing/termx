#![cfg(windows)]
use std::{
    fs,
    path::PathBuf,
    process::Command,
    thread,
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};
use termx_swarm_client::{AuthorityClaim, AuthorityError, DiscoveryRecord, VerifiedProcess};

fn retained_container(name: &str) -> PathBuf {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../retired/test-artifacts/swarm-client")
        .join(format!(
            "{name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    fs::create_dir_all(&p).unwrap();
    p
}

fn retained(name: &str) -> PathBuf {
    retained_container(name).join("authority")
}

#[test]
fn aliases_contend_and_reopen_preserves_lock_and_credential() {
    let dir = retained("authority-alias");
    drop(AuthorityClaim::claim(&dir).unwrap());
    fs::write(dir.join("authority.lock"), b"retained-lock-bytes").unwrap();
    let claim = AuthorityClaim::claim(&dir).unwrap();
    let secret = claim.load_or_create_owner_credential().unwrap();
    let case_alias = dir.with_file_name("AUTHORITY");
    assert!(matches!(
        AuthorityClaim::claim(&case_alias),
        Err(AuthorityError::Busy)
    ));
    drop(claim);
    let reopened = AuthorityClaim::claim(&dir).unwrap();
    assert!(secret.matches(&reopened.load_or_create_owner_credential().unwrap()));
    drop(reopened);
    assert_eq!(
        fs::read(dir.join("authority.lock")).unwrap(),
        b"retained-lock-bytes"
    );
    termx_swarm_client::ClientBootstrap::open(&case_alias).unwrap();
}

#[test]
fn permissive_existing_credential_is_rejected_and_preserved() {
    let dir = retained("credential-reject");
    drop(AuthorityClaim::claim(&dir).unwrap());
    fs::write(dir.join("owner.credential"), [b'x'; 32]).unwrap();
    let claim = AuthorityClaim::claim(&dir).unwrap();
    let before = fs::read(dir.join("owner.credential")).unwrap();
    assert!(matches!(
        claim.load_or_create_owner_credential(),
        Err(AuthorityError::InsecureCredential)
    ));
    assert_eq!(fs::read(dir.join("owner.credential")).unwrap(), before);
}

#[test]
fn insecure_existing_authority_directory_is_rejected_and_preserved() {
    let container = retained_container("authority-directory-reject");
    let dir = container.join("insecure-authority");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("sentinel.txt"), b"preserve-insecure-directory").unwrap();

    assert!(matches!(
        AuthorityClaim::claim(&dir),
        Err(AuthorityError::InsecureAuthority)
    ));
    assert!(matches!(
        termx_swarm_client::ClientBootstrap::open(&dir),
        Err(AuthorityError::InsecureAuthority)
    ));
    assert_eq!(
        fs::read(dir.join("sentinel.txt")).unwrap(),
        b"preserve-insecure-directory"
    );
    fs::write(
        container.join("result.json"),
        br#"{"claim_rejected":true,"client_bootstrap_rejected":true,"insecure_directory_preserved":true}"#,
    )
    .unwrap();
}

#[test]
fn discovery_rejects_malformed_predecessor_and_atomically_retires_valid_one() {
    let dir = retained("discovery");
    let claim = AuthorityClaim::claim(&dir).unwrap();
    let identity = VerifiedProcess::open(std::process::id())
        .unwrap()
        .identity();
    let first = DiscoveryRecord::new(
        "authority-1",
        "boot-1",
        identity,
        r"\\.\pipe\termx-test-discovery",
    );
    claim.publish_discovery(&first).unwrap();
    fs::write(dir.join("discovery.json"), b"{malformed").unwrap();
    assert!(matches!(
        claim.publish_discovery(&first),
        Err(AuthorityError::InvalidDiscovery)
    ));
    assert_eq!(fs::read(dir.join("discovery.json")).unwrap(), b"{malformed");

    let dir2 = retained("discovery-future");
    let claim2 = AuthorityClaim::claim(&dir2).unwrap();
    claim2.publish_discovery(&first).unwrap();
    let mut future = first.clone();
    future.version += 1;
    let future_bytes = serde_json::to_vec(&future).unwrap();
    fs::write(dir2.join("discovery.json"), &future_bytes).unwrap();
    assert!(matches!(
        claim2.publish_discovery(&first),
        Err(AuthorityError::FutureDiscovery)
    ));
    assert_eq!(fs::read(dir2.join("discovery.json")).unwrap(), future_bytes);

    let dir3 = retained("discovery-valid");
    let claim3 = AuthorityClaim::claim(&dir3).unwrap();
    claim3.publish_discovery(&first).unwrap();
    let second = DiscoveryRecord::new(
        "authority-1",
        "boot-2",
        identity,
        r"\\.\pipe\termx-test-discovery-2",
    );
    claim3.publish_discovery(&second).unwrap();
    assert_eq!(claim3.read_discovery().unwrap(), second);
    let retired: Vec<_> = fs::read_dir(dir3.join("retired")).unwrap().collect();
    assert_eq!(retired.len(), 1);
    let retired_record: DiscoveryRecord =
        serde_json::from_slice(&fs::read(retired[0].as_ref().unwrap().path()).unwrap()).unwrap();
    assert_eq!(retired_record, first);
    fs::write(
        dir3.join("result.json"),
        br#"{"malformed_preserved":true,"future_preserved":true,"replacement_atomic_with_retired_predecessor":true}"#,
    )
    .unwrap();
}

#[test]
fn insecure_existing_discovery_is_rejected_and_preserved() {
    let container = retained_container("discovery-acl-reject");
    let dir = container.join("authority");
    let claim = AuthorityClaim::claim(&dir).unwrap();
    let identity = VerifiedProcess::open(std::process::id())
        .unwrap()
        .identity();
    let discovery = DiscoveryRecord::new(
        "authority-1",
        "boot-1",
        identity,
        r"\\.\pipe\termx-test-insecure-discovery",
    );
    let bytes = serde_json::to_vec(&discovery).unwrap();
    fs::write(dir.join("discovery.json"), &bytes).unwrap();
    assert!(matches!(
        claim.read_discovery(),
        Err(AuthorityError::InsecureDiscovery)
    ));
    assert!(matches!(
        claim.publish_discovery(&discovery),
        Err(AuthorityError::InsecureDiscovery)
    ));
    assert_eq!(fs::read(dir.join("discovery.json")).unwrap(), bytes);
    fs::write(
        container.join("result.json"),
        br#"{"read_rejected":true,"publish_rejected":true,"insecure_discovery_preserved":true}"#,
    )
    .unwrap();
}

#[test]
fn wrong_type_credential_is_rejected_and_preserved() {
    let dir = retained("credential-type");
    drop(AuthorityClaim::claim(&dir).unwrap());
    fs::create_dir(dir.join("owner.credential")).unwrap();
    let claim = AuthorityClaim::claim(&dir).unwrap();
    match claim.load_or_create_owner_credential() {
        Err(AuthorityError::ObjectType) => {}
        Err(other) => panic!("unexpected credential error: {other:?}"),
        Ok(_) => panic!("directory was accepted as a credential"),
    }
    assert!(dir.join("owner.credential").is_dir());
}

#[test]
fn reparse_credential_is_rejected_and_preserved() {
    let dir = retained("credential-reparse");
    drop(AuthorityClaim::claim(&dir).unwrap());
    let target = fs::canonicalize(retained_container("credential-reparse-target")).unwrap();
    let link = fs::canonicalize(&dir).unwrap().join("owner.credential");
    let output = Command::new("cmd")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&link)
        .arg(&target)
        .output()
        .unwrap();
    fs::write(
        dir.join("junction-command.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "argv": ["cmd", "/d", "/c", "mklink /J <fixture-link> <fixture-target>"],
            "native_exit": output.status.code(),
            "stdout": String::from_utf8_lossy(&output.stdout),
            "stderr": String::from_utf8_lossy(&output.stderr),
        }))
        .unwrap(),
    )
    .unwrap();
    assert!(output.status.success());
    let claim = AuthorityClaim::claim(&dir).unwrap();
    match claim.load_or_create_owner_credential() {
        Err(AuthorityError::ObjectType) => {}
        Err(other) => panic!("unexpected credential error: {other:?}"),
        Ok(_) => panic!("reparse point was accepted as a credential"),
    }
    assert!(fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
}

#[test]
fn retained_directory_handle_blocks_rename_until_released() {
    let dir = retained("authority-rename");
    let moved = dir.with_extension("released");
    let claim = AuthorityClaim::claim(&dir).unwrap();
    fs::write(dir.join("sentinel.txt"), b"preserve-me").unwrap();
    assert!(fs::rename(&dir, &moved).is_err());
    drop(claim);
    fs::rename(&dir, &moved).unwrap();
    assert_eq!(
        fs::read(moved.join("sentinel.txt")).unwrap(),
        b"preserve-me"
    );
}

#[test]
fn inherited_handle_child() {
    if std::env::var_os("TERMX_SWARM_INHERITED_HANDLE_CHILD").is_some() {
        thread::sleep(Duration::from_secs(2));
    }
}

#[test]
fn authority_handles_are_not_inherited_by_subprocess() {
    let dir = retained("authority-inheritance");
    let claim = AuthorityClaim::claim(&dir).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "inherited_handle_child", "--nocapture"])
        .env("TERMX_SWARM_INHERITED_HANDLE_CHILD", "1")
        .spawn()
        .unwrap();
    let child_identity = VerifiedProcess::open(child.id()).unwrap().identity();
    thread::sleep(Duration::from_millis(200));
    assert!(child.try_wait().unwrap().is_none());
    drop(claim);
    let replacement = AuthorityClaim::claim(&dir).unwrap();
    drop(replacement);
    let status = child.wait().unwrap();
    fs::write(
        dir.join("inherited-handle-result.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "child": child_identity,
            "native_exit": status.code(),
            "reclaimed_while_child_alive": true,
        }))
        .unwrap(),
    )
    .unwrap();
    assert!(status.success());
}
