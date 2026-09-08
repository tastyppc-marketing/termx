//! Exact-owned Windows process tests for detached broker lifetime handoff.
#![cfg(windows)]

mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};
use termx_host::swarm::lifetime::{
    child_identity, guard_spawned_child_with_verifier, spawn_detached,
    spawn_detached_with_verifier, DetachError,
};
use termx_host::swarm::rpc::{Empty, Outcome, OwnerOperation, TypedConnection};
use termx_swarm_client::{ClientBootstrap, DiscoveryRecord, OwnerClient, ProcessIdentity};

const HELPER_ACTION: &str = "TERMX_SWARM_LIFETIME_HELPER_ACTION";
const HELPER_FIXTURE: &str = "TERMX_SWARM_LIFETIME_HELPER_FIXTURE";
const HELPER_HOST: &str = "TERMX_SWARM_LIFETIME_HELPER_HOST";
const PROCESS_DEADLINE: Duration = Duration::from_secs(15);

fn host_exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_termx-host"))
}

fn write_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn write_identity_record(fixture: &Path, identity: ProcessIdentity) -> std::io::Result<()> {
    write_new(
        &fixture.join("broker.identity"),
        format!("{} {}\n", identity.pid, identity.creation_filetime.get()).as_bytes(),
    )
}

fn write_identity(fixture: &Path, identity: ProcessIdentity) -> std::io::Result<()> {
    write_identity_record(fixture, identity)?;
    write_new(&fixture.join("spawned.ack"), b"ready\n")
}

fn child_in_any_job(child: &std::process::Child) -> std::io::Result<bool> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;

    let mut in_job = 0;
    let checked = unsafe {
        IsProcessInJob(
            child.as_raw_handle() as _,
            std::ptr::null_mut(),
            &mut in_job,
        )
    };
    if checked == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(in_job != 0)
}

fn read_identity(fixture: &Path) -> ProcessIdentity {
    let text = fs::read_to_string(fixture.join("broker.identity")).unwrap();
    let mut fields = text.split_ascii_whitespace();
    let pid = fields.next().unwrap().parse().unwrap();
    let creation_filetime = fields.next().unwrap().parse().unwrap();
    assert!(fields.next().is_none(), "identity record has extra fields");
    ProcessIdentity::new(pid, creation_filetime)
}

fn wait_for_file(path: &Path, launcher: &mut support::OwnedChild) {
    let deadline = Instant::now() + PROCESS_DEADLINE;
    loop {
        if path.is_file() {
            return;
        }
        if let Some(status) = launcher.try_wait().unwrap() {
            let result = fs::read_to_string(path.with_file_name("helper.result"))
                .unwrap_or_else(|_| "no helper result".into());
            panic!(
                "launcher exited before {}: status={status}; result={result}",
                path.display()
            );
        }
        assert!(
            Instant::now() < deadline,
            "launcher did not create {} within {PROCESS_DEADLINE:?}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_ack_or_result(
    fixture: &Path,
    ack_name: &str,
    launcher: &mut support::OwnedChild,
) -> bool {
    let acknowledged = fixture.join(ack_name);
    let result = fixture.join("helper.result");
    let deadline = Instant::now() + PROCESS_DEADLINE;
    loop {
        if acknowledged.is_file() {
            return true;
        }
        if result.is_file() {
            return false;
        }
        if let Some(status) = launcher.try_wait().unwrap() {
            panic!("launcher exited before an outcome was recorded: {status}");
        }
        assert!(
            Instant::now() < deadline,
            "launcher recorded neither {ack_name} nor an unsupported result within {PROCESS_DEADLINE:?}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_discovery(data_dir: &Path) -> (ClientBootstrap, DiscoveryRecord) {
    let root = data_dir.join("swarm");
    let deadline = Instant::now() + PROCESS_DEADLINE;
    loop {
        if let Ok(bootstrap) = ClientBootstrap::open(&root) {
            if let Ok(discovery) = bootstrap.read_discovery() {
                return (bootstrap, discovery);
            }
        }
        assert!(
            Instant::now() < deadline,
            "broker did not publish discovery within {PROCESS_DEADLINE:?}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

async fn owner_health(
    discovery: &DiscoveryRecord,
    bootstrap: &ClientBootstrap,
) -> termx_host::swarm::rpc::HealthPayload {
    let credential = bootstrap.load_owner_credential().unwrap();
    let client = tokio::time::timeout(
        PROCESS_DEADLINE,
        OwnerClient::connect(discovery, &credential),
    )
    .await
    .expect("owner connect deadline")
    .unwrap();
    assert_eq!(client.server_identity(), discovery.server);
    let mut connection = TypedConnection::owner(client);
    let outcome = tokio::time::timeout(
        PROCESS_DEADLINE,
        connection.call_owner(OwnerOperation::Health(Empty {})),
    )
    .await
    .expect("owner health deadline")
    .unwrap();
    let Outcome::Health(health) = outcome else {
        panic!("owner health returned {outcome:?}")
    };
    health
}

fn wait_for_launcher(launcher: &mut support::OwnedChild) -> ExitStatus {
    let deadline = Instant::now() + PROCESS_DEADLINE;
    loop {
        if let Some(status) = launcher.try_wait().unwrap() {
            return status;
        }
        assert!(
            Instant::now() < deadline,
            "owned launcher did not exit within {PROCESS_DEADLINE:?}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn spawn_helper(fixture: &Path, action: &str, breakaway_permitted: bool) -> support::OwnedChild {
    let policy = if breakaway_permitted {
        b"kill_on_close=true\nbreakaway_ok=true\n".as_slice()
    } else {
        b"kill_on_close=true\nbreakaway_ok=false\n".as_slice()
    };
    write_new(&fixture.join("launcher.job-policy"), policy).unwrap();
    let stdout = fs::File::create(fixture.join(format!("{action}.stdout.log"))).unwrap();
    let stderr = fs::File::create(fixture.join(format!("{action}.stderr.log"))).unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--ignored",
            "--exact",
            "detached_launcher_helper",
            "--nocapture",
        ])
        .env(HELPER_ACTION, action)
        .env(HELPER_FIXTURE, fixture)
        .env(HELPER_HOST, host_exe())
        .env_remove("RUST_LOG")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if breakaway_permitted {
        support::OwnedChild::spawn_breakaway_permitted(&mut command, fixture, action).unwrap()
    } else {
        support::OwnedChild::spawn(&mut command, fixture, action).unwrap()
    }
}

fn spawn_guarded_broker(host: &Path, data_dir: &Path) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut command = Command::new(host);
    command
        .arg(termx_host::swarm::BROKER_MODE)
        .arg("--data-dir")
        .arg(data_dir)
        .arg("--lifetime")
        .arg("signal")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    command.spawn()
}

fn launch_and_adopt(
    action: &str,
) -> (
    support::RetainedDir,
    support::OwnedChild,
    support::OwnedProcess,
) {
    let fixture = support::retained_dir().unwrap();
    let mut launcher = spawn_helper(fixture.path(), action, true);
    wait_for_file(&fixture.path().join("spawned.ack"), &mut launcher);
    let identity = read_identity(fixture.path());
    let owner = support::OwnedProcess::adopt(identity.pid, identity.creation_filetime.get())
        .expect("retain exact broker generation before releasing launcher barrier");
    write_new(&fixture.path().join("adopted.ack"), b"owned\n").unwrap();
    (fixture, launcher, owner)
}

#[test]
#[ignore = "subprocess helper selected with exact invocation and an environment marker"]
fn detached_launcher_helper() {
    let Ok(action) = std::env::var(HELPER_ACTION) else {
        return;
    };
    let fixture = PathBuf::from(std::env::var_os(HELPER_FIXTURE).expect("helper fixture"));
    let host = PathBuf::from(std::env::var_os(HELPER_HOST).expect("helper host"));
    let data_dir = fixture.join("data");

    match action.as_str() {
        "verifier-failure" | "verifier-panic" => {
            let child = spawn_guarded_broker(&host, &data_dir).unwrap();
            let result = guard_spawned_child_with_verifier(child, |child| {
                let identity = child_identity(child)?;
                write_identity(&fixture, identity)?;
                let deadline = Instant::now() + PROCESS_DEADLINE;
                while !fixture.join("adopted.ack").is_file() {
                    if Instant::now() >= deadline {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "parent did not acknowledge exact ownership",
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                if action == "verifier-panic" {
                    panic!("injected verifier panic");
                }
                Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "injected verifier rejection",
                ))
            });
            match result {
                Err(DetachError::VerificationFailed(error)) => {
                    write_new(
                        &fixture.join("helper.result"),
                        format!("verification-failed:{error}\n").as_bytes(),
                    )
                    .unwrap();
                }
                Err(other) => panic!("unexpected detached result: {other}"),
                Ok(broker) => {
                    drop(broker);
                    panic!("injected verifier unexpectedly accepted the launch")
                }
            }
        }
        "drop" | "release" => {
            let child = spawn_guarded_broker(&host, &data_dir).unwrap();
            let broker = guard_spawned_child_with_verifier(child, child_identity).unwrap();
            write_identity(&fixture, broker.identity()).unwrap();
            let deadline = Instant::now() + PROCESS_DEADLINE;
            while !fixture.join("adopted.ack").is_file() {
                assert!(
                    Instant::now() < deadline,
                    "parent did not acknowledge exact ownership"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
            if action == "drop" {
                drop(broker);
            } else {
                let identity = broker.identity();
                assert_eq!(broker.release(), identity);
            }
            write_new(
                &fixture.join("helper.result"),
                format!("{action}:done\n").as_bytes(),
            )
            .unwrap();
        }
        "restrictive" => {
            let result = spawn_detached(&host, &data_dir);
            match result {
                Err(DetachError::Unsupported(reason)) => {
                    write_new(
                        &fixture.join("helper.result"),
                        format!("unsupported:{reason}\n").as_bytes(),
                    )
                    .unwrap();
                }
                Err(other) => {
                    write_new(
                        &fixture.join("helper.result"),
                        format!("unexpected-error:{other}\n").as_bytes(),
                    )
                    .unwrap();
                }
                Ok(broker) => {
                    drop(broker);
                    write_new(&fixture.join("helper.result"), b"unexpected-success\n").unwrap();
                }
            }
        }
        "actual-detach" => {
            let result = spawn_detached_with_verifier(&host, &data_dir, |child| {
                let identity = child_identity(child)?;
                write_identity_record(&fixture, identity)?;
                write_new(
                    &fixture.join("child.job-membership"),
                    if child_in_any_job(child)? {
                        b"in-job=true\n"
                    } else {
                        b"in-job=false\n"
                    },
                )?;
                write_new(&fixture.join("spawned.ack"), b"ready\n")?;
                let deadline = Instant::now() + PROCESS_DEADLINE;
                while !fixture.join("adopted.ack").is_file() {
                    if Instant::now() >= deadline {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "parent did not acknowledge exact detached-child ownership",
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Ok(identity)
            });
            match result {
                Err(DetachError::Unsupported(reason)) => {
                    write_new(
                        &fixture.join("helper.result"),
                        format!("unsupported:{reason}\n").as_bytes(),
                    )
                    .unwrap();
                }
                Err(other) => {
                    write_new(
                        &fixture.join("helper.result"),
                        format!("unexpected-error:{other}\n").as_bytes(),
                    )
                    .unwrap();
                }
                Ok(broker) => {
                    write_new(&fixture.join("spawn-returned.ack"), b"detached\n").unwrap();
                    let deadline = Instant::now() + PROCESS_DEADLINE;
                    while !fixture.join("release.ack").is_file() {
                        assert!(
                            Instant::now() < deadline,
                            "parent did not release the detached launcher barrier"
                        );
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    let identity = broker.identity();
                    assert_eq!(broker.release(), identity);
                    write_new(&fixture.join("helper.result"), b"detached:released\n").unwrap();
                }
            }
        }
        other => panic!("unknown helper action {other}"),
    }
}

#[test]
fn verifier_failure_terminates_the_exact_spawned_child_boundedly() {
    let (fixture, mut launcher, owner) = launch_and_adopt("verifier-failure");
    let status = wait_for_launcher(&mut launcher);
    assert!(status.success(), "verifier helper failed: {status}");
    assert!(
        owner.wait_exited(PROCESS_DEADLINE).unwrap(),
        "verification failure must terminate its exact child within the deadline"
    );
    assert!(fs::read_to_string(fixture.path().join("helper.result"))
        .unwrap()
        .starts_with("verification-failed:injected verifier rejection"));
}

#[test]
fn verifier_panic_unwinds_through_exact_child_cleanup() {
    let (_fixture, mut launcher, owner) = launch_and_adopt("verifier-panic");
    let status = wait_for_launcher(&mut launcher);
    assert!(!status.success(), "the injected verifier panic must unwind");
    assert!(
        owner.wait_exited(PROCESS_DEADLINE).unwrap(),
        "panic unwinding must terminate its exact child within the deadline"
    );
}

#[test]
fn dropping_an_unreleased_broker_terminates_its_exact_child() {
    let (_fixture, mut launcher, owner) = launch_and_adopt("drop");
    let status = wait_for_launcher(&mut launcher);
    assert!(status.success(), "drop helper failed: {status}");
    assert!(
        owner.wait_exited(PROCESS_DEADLINE).unwrap(),
        "dropping an unreleased broker must terminate its exact child"
    );
}

#[test]
fn explicit_release_preserves_the_child_until_test_cleanup() {
    let (_fixture, mut launcher, owner) = launch_and_adopt("release");
    let status = wait_for_launcher(&mut launcher);
    assert!(status.success(), "release helper failed: {status}");
    assert!(
        !owner.exited().unwrap(),
        "explicit release must leave the broker generation running"
    );
    assert!(
        owner.terminate().unwrap(),
        "the retained exact owner must terminate the released fixture broker"
    );
    drop(launcher);
}

#[test]
fn restrictive_launcher_job_reports_unsupported_without_publication() {
    let fixture = support::retained_dir().unwrap();
    let mut launcher = spawn_helper(fixture.path(), "restrictive", false);
    let status = wait_for_launcher(&mut launcher);
    assert!(status.success(), "restrictive helper failed: {status}");
    let result = fs::read_to_string(fixture.path().join("helper.result")).unwrap();
    assert!(result.starts_with("unsupported:"), "result was {result:?}");
    assert!(
        !fixture
            .path()
            .join("data")
            .join("swarm")
            .join("discovery.json")
            .exists(),
        "unsupported launch must not advertise a detached broker"
    );
    assert!(
        !fixture.path().join("data").exists(),
        "preflight rejection must not mutate the requested data directory"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_detach_survives_launcher_job_close_or_reports_the_outer_job_limit() {
    let fixture = support::retained_dir().unwrap();
    let data_dir = fixture.path().join("data");
    let mut launcher = spawn_helper(fixture.path(), "actual-detach", true);

    if !wait_for_ack_or_result(fixture.path(), "spawned.ack", &mut launcher) {
        let status = wait_for_launcher(&mut launcher);
        assert!(status.success(), "unsupported helper failed: {status}");
        let result = fs::read_to_string(fixture.path().join("helper.result")).unwrap();
        assert!(result.starts_with("unsupported:"), "result was {result:?}");
        assert!(
            !data_dir.join("swarm").join("discovery.json").exists(),
            "a suspended unsupported child must not publish discovery"
        );
        assert!(
            !data_dir.exists(),
            "a suspended unsupported child must not mutate the requested data directory"
        );
        eprintln!("detached independence unavailable in this outer job: {result}");
        return;
    }

    let identity = read_identity(fixture.path());
    let child_was_in_job = fs::read_to_string(fixture.path().join("child.job-membership"))
        .unwrap()
        .trim()
        == "in-job=true";
    let owner = support::OwnedProcess::adopt(identity.pid, identity.creation_filetime.get())
        .expect("retain exact detached broker cleanup ownership before handoff");
    write_new(&fixture.path().join("adopted.ack"), b"owned\n").unwrap();

    if !wait_for_ack_or_result(fixture.path(), "spawn-returned.ack", &mut launcher) {
        let status = wait_for_launcher(&mut launcher);
        assert!(status.success(), "unsupported helper failed: {status}");
        let result = fs::read_to_string(fixture.path().join("helper.result")).unwrap();
        assert!(result.starts_with("unsupported:"), "result was {result:?}");
        assert!(
            child_was_in_job,
            "post-spawn unsupported must reflect retained-handle job membership"
        );
        assert!(
            owner.wait_exited(PROCESS_DEADLINE).unwrap(),
            "post-spawn unsupported result must terminate the exact suspended child"
        );
        assert!(
            !data_dir.exists(),
            "a suspended unsupported child must not mutate the requested data directory"
        );
        eprintln!("detached independence unavailable in this outer job: {result}");
        return;
    }

    assert!(
        !child_was_in_job,
        "spawn success must not claim independence for a job-bound child"
    );
    let (bootstrap, discovery) = wait_for_discovery(&data_dir);
    assert_eq!(discovery.server, identity);
    let first_health = owner_health(&discovery, &bootstrap).await;
    assert_eq!(first_health.boot_id, discovery.boot_id);
    // The first connection is dropped by owner_health before handoff.
    write_new(&fixture.path().join("release.ack"), b"release\n").unwrap();
    let status = wait_for_launcher(&mut launcher);
    assert!(status.success(), "detached launcher failed: {status}");
    drop(launcher); // closes the exact launcher's owned job
    assert!(
        !owner.exited().unwrap(),
        "the exact detached broker must survive launcher exit and job close"
    );

    let fresh_health = owner_health(&discovery, &bootstrap).await;
    assert_eq!(fresh_health.boot_id, first_health.boot_id);
    assert_eq!(
        discovery.server, identity,
        "fresh RPC must use the same generation"
    );
    assert!(
        owner.terminate().unwrap(),
        "the exact retained owner must terminate the detached fixture broker"
    );
}
