use termx_swarm_client::{
    resolve_enrolled_ancestor, resolve_verified_enrolled_ancestor, AncestryError, ProcessIdentity,
    ProcessSnapshot, VerifiedProcess,
};

#[test]
fn ancestry_rejects_cycles_ambiguity_and_stale_generations() {
    let p = |pid, parent, time| ProcessSnapshot {
        identity: ProcessIdentity::new(pid, time),
        parent_pid: parent,
    };
    assert!(matches!(
        resolve_enrolled_ancestor(3, &[p(3, 2, 30), p(2, 3, 20)], &[p(2, 1, 20).identity], 32),
        Err(AncestryError::Cycle)
    ));
    assert!(matches!(
        resolve_enrolled_ancestor(
            3,
            &[p(3, 2, 30), p(2, 1, 20), p(1, 0, 10)],
            &[p(2, 1, 20).identity, p(1, 0, 10).identity],
            32
        ),
        Err(AncestryError::Ambiguous)
    ));
    assert!(matches!(
        resolve_enrolled_ancestor(
            3,
            &[p(3, 2, 30), p(2, 1, 20), p(1, 0, 10)],
            &[ProcessIdentity::new(2, 21)],
            32
        ),
        Err(AncestryError::NotFound)
    ));
    assert!(matches!(
        resolve_enrolled_ancestor(3, &[p(3, 2, 20), p(2, 0, 30)], &[p(2, 0, 30).identity], 32),
        Err(AncestryError::NotFound)
    ));
    assert!(matches!(
        resolve_enrolled_ancestor(
            3,
            &[p(3, 2, 30), p(2, 0, 20), p(2, 0, 21)],
            &[p(2, 0, 20).identity],
            32
        ),
        Err(AncestryError::Unavailable)
    ));
    assert_eq!(
        resolve_enrolled_ancestor(
            3,
            &[p(3, 2, 30), p(2, 1, 20), p(1, 0, 10)],
            &[p(2, 1, 20).identity],
            32
        )
        .unwrap()
        .pid,
        2
    );

    // A complete snapshot can conclusively show that the next parent is gone or
    // that its PID has been reused by a generation newer than its child. Either
    // boundary preserves one already verified enrolled runtime below it.
    assert_eq!(
        resolve_enrolled_ancestor(
            3,
            &[p(3, 2, 30), p(2, 99, 20)],
            &[p(2, 99, 20).identity],
            32,
        )
        .unwrap()
        .pid,
        2
    );
    assert_eq!(
        resolve_enrolled_ancestor(
            3,
            &[p(3, 2, 30), p(2, 1, 20), p(1, 0, 40)],
            &[p(2, 1, 20).identity],
            32,
        )
        .unwrap()
        .pid,
        2
    );
    assert!(matches!(
        resolve_enrolled_ancestor(99, &[p(3, 0, 30)], &[p(3, 0, 30).identity], 32),
        Err(AncestryError::Unavailable)
    ));
    assert!(matches!(
        resolve_enrolled_ancestor(
            3,
            &[p(3, 2, 30), p(2, 1, 20), p(1, 0, 10)],
            &[p(2, 1, 20).identity],
            1,
        ),
        Err(AncestryError::Depth)
    ));
}

#[test]
fn native_ancestry_resolves_owned_child_to_one_enrolled_parent() {
    use std::{fs, path::PathBuf, process::Command, time::SystemTime};

    let retained = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../retired/test-artifacts/swarm-client")
        .join(format!(
            "native-ancestry-positive-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    fs::create_dir_all(&retained).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "native_ancestry_child", "--nocapture"])
        .env("TERMX_SWARM_ANCESTRY_CHILD", "1")
        .spawn()
        .unwrap();
    let child_identity = VerifiedProcess::open(child.id()).unwrap().identity();
    let parent_identity = VerifiedProcess::open(std::process::id())
        .unwrap()
        .identity();
    let resolved =
        resolve_verified_enrolled_ancestor(child_identity.pid, &[parent_identity], 64).unwrap();
    assert_eq!(resolved.identity(), parent_identity);
    assert!(resolved.is_alive().unwrap());
    let status = child.wait().unwrap();
    fs::write(
        retained.join("result.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "child": child_identity,
            "parent": parent_identity,
            "resolved": resolved.identity(),
            "resolved_live": true,
            "native_exit": status.code(),
        }))
        .unwrap(),
    )
    .unwrap();
    assert!(status.success());
}

#[test]
fn retained_process_verification_rejects_stale_generation() {
    let current = VerifiedProcess::open(std::process::id()).unwrap();
    assert!(current.is_alive().unwrap());
    let exact = current.identity();
    assert_eq!(VerifiedProcess::verify(exact).unwrap().identity(), exact);
    let stale = ProcessIdentity::new(exact.pid, exact.creation_filetime.get() + 1);
    assert!(VerifiedProcess::verify(stale).is_err());
}

#[test]
fn native_ancestry_child() {
    if std::env::var_os("TERMX_SWARM_EXIT_STILL_ACTIVE").is_some() {
        std::thread::sleep(std::time::Duration::from_millis(200));
        std::process::exit(259);
    }
    if std::env::var_os("TERMX_SWARM_ANCESTRY_CHILD").is_some() {
        std::thread::sleep(std::time::Duration::from_secs(2));
    }
}

#[test]
fn retained_handle_does_not_treat_exit_code_259_as_live() {
    let retained_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../retired/test-artifacts/swarm-client")
        .join(format!(
            "exit-259-liveness-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    std::fs::create_dir_all(&retained_dir).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "native_ancestry_child", "--nocapture"])
        .env("TERMX_SWARM_EXIT_STILL_ACTIVE", "1")
        .spawn()
        .unwrap();
    let retained = VerifiedProcess::open(child.id()).unwrap();
    let identity = retained.identity();
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(259));
    assert!(!retained.is_alive().unwrap());
    std::fs::write(
        retained_dir.join("result.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "child": identity,
            "native_exit": status.code(),
            "live_after_exit": false,
        }))
        .unwrap(),
    )
    .unwrap();
}

#[test]
fn native_ancestry_rejects_multiple_exact_enrolled_ancestors() {
    use std::{fs, path::PathBuf, process::Command, time::SystemTime};

    let retained = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../retired/test-artifacts/swarm-client")
        .join(format!(
            "native-ancestry-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    fs::create_dir_all(&retained).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "native_ancestry_child", "--nocapture"])
        .env("TERMX_SWARM_ANCESTRY_CHILD", "1")
        .spawn()
        .unwrap();
    let child_identity = VerifiedProcess::open(child.id()).unwrap().identity();
    let parent_identity = VerifiedProcess::open(std::process::id())
        .unwrap()
        .identity();
    match resolve_verified_enrolled_ancestor(
        child_identity.pid,
        &[child_identity, parent_identity],
        64,
    ) {
        Err(AncestryError::Ambiguous) => {}
        Err(other) => panic!("unexpected ancestry error: {other:?}"),
        Ok(_) => panic!("multiple enrolled ancestors were accepted"),
    }
    let status = child.wait().unwrap();
    fs::write(
        retained.join("result.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "child": child_identity,
            "parent": parent_identity,
            "ambiguous_rejected": true,
            "native_exit": status.code(),
        }))
        .unwrap(),
    )
    .unwrap();
    assert!(status.success());
}
