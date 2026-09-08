#[path = "support/evidence.rs"]
mod evidence;
mod support;
use rusqlite::Connection;
use std::{
    io::{BufRead, Write},
    path::PathBuf,
    process::{Command as ProcessCommand, Stdio},
};
use termx_swarm_core::{
    error::StoreError,
    model::*,
    store::{Store, APPLICATION_ID, SCHEMA_VERSION},
    worker::*,
};

struct OwnedChild {
    child: std::process::Child,
    record: PathBuf,
    finished: bool,
}
impl OwnedChild {
    fn wait(&mut self) -> std::process::ExitStatus {
        let status = self.child.wait().unwrap();
        std::fs::write(
            &self.record,
            format!(
                "owned_handle_pid={}\nexit={status}\nforced=false\n",
                self.child.id()
            ),
        )
        .unwrap();
        self.finished = true;
        status
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if !self.finished {
            // Only this newly spawned Child handle is ever terminated. This is
            // a watchdog/failure path; normal crash tests use child self-exit.
            let _ = self.child.kill();
            let status = self.child.wait();
            let _ = std::fs::write(
                &self.record,
                format!(
                    "owned_handle_pid={}\nexit={status:?}\nforced=true\n",
                    self.child.id()
                ),
            );
        }
    }
}
async fn call(client: &Client, make: impl Fn() -> Command) -> Result<Response, OperationError> {
    loop {
        match client.submit(make()) {
            Ok(p) => return p.await,
            Err(AdmissionError::Contended) => tokio::task::yield_now().await,
            Err(e) => panic!("admission {e}"),
        }
    }
}
fn binding(record: &PeerBindingRecord) -> VerifiedBinding {
    VerifiedBinding::trusted(
        record.launch_id.as_str().into(),
        record.terminal_id.clone(),
        record.harness.clone(),
        record.conversation_id.clone(),
        record.model_metadata.clone(),
        record.process_id,
        record.process_creation_filetime,
        record.is_live,
    )
    .unwrap()
}
fn fresh(name: &str) -> VerifiedBinding {
    VerifiedBinding::trusted(
        LaunchId::generate().as_str().into(),
        name.into(),
        "synthetic".into(),
        name.into(),
        None,
        1,
        1,
        true,
    )
    .unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn actual_busy_does_not_block_executor_and_cannot_report_saved() {
    let path = support::retained_db("actual-busy");
    let worker = Worker::open(path.clone(), WorkerConfig::default())
        .await
        .unwrap();
    let client = worker.client();
    let Response::Owner(owner) = call(&client, || Command::TrustedOwner).await.unwrap() else {
        panic!()
    };
    let connection = Connection::open(path).unwrap();
    connection.execute_batch("BEGIN IMMEDIATE").unwrap();
    let pending = client
        .submit(Command::CreateGroup(
            owner,
            "busy".into(),
            Default::default(),
        ))
        .unwrap();
    // The external immediate transaction is the phase barrier; the timer only
    // demonstrates the executor remains runnable while SQLite waits on its lock.
    tokio::pin!(pending);
    tokio::select! {biased; result=&mut pending=>panic!("completed before executor heartbeat: {result:?}"),_=tokio::time::sleep(std::time::Duration::from_millis(20))=>{}}
    let error = pending.await.unwrap_err();
    assert!(
        matches!(error,OperationError::Store(StoreError::Sqlite(rusqlite::Error::SqliteFailure(e,_))) if e.code==rusqlite::ErrorCode::DatabaseBusy)
    );
    connection.execute_batch("ROLLBACK").unwrap();
    worker.shutdown().await.unwrap();
}
#[tokio::test]
async fn corrupt_future_live_wal_and_unavailable_open_preserve_evidence() {
    let corrupt = support::retained_db("corrupt-worker");
    let data = b"deliberately corrupt retained SQLite fixture";
    std::fs::write(&corrupt, data).unwrap();
    assert!(Worker::open(corrupt.clone(), WorkerConfig::default())
        .await
        .is_err());
    assert_eq!(std::fs::read(corrupt).unwrap(), data);
    let unavailable = support::retained_db("unavailable-worker")
        .join("missing")
        .join("swarm.sqlite");
    assert!(Worker::open(unavailable, WorkerConfig::default())
        .await
        .is_err());
    let path = support::retained_db("future-live-wal");
    let connection = Connection::open(&path).unwrap();
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .unwrap();
    connection
        .pragma_update(None, "wal_autocheckpoint", 0)
        .unwrap();
    connection
        .pragma_update(None, "application_id", APPLICATION_ID)
        .unwrap();
    connection
        .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
        .unwrap();
    connection.execute_batch("CREATE TABLE future_evidence(value TEXT); INSERT INTO future_evidence VALUES('retained-logical-evidence');").unwrap();
    let wal = PathBuf::from(format!("{}-wal", path.display()));
    let before_main = std::fs::read(&path).unwrap();
    let before_wal = std::fs::read(&wal).unwrap();
    // Retain raw byte evidence, not a claimed live-database backup.
    std::fs::write(path.with_extension("logical-main.bin"), &before_main).unwrap();
    std::fs::write(path.with_extension("logical-wal.bin"), &before_wal).unwrap();
    assert_ne!(
        u32::from_be_bytes(before_main[60..64].try_into().unwrap()) as i64,
        SCHEMA_VERSION + 1
    );
    assert!(matches!(
        Worker::open(path.clone(), WorkerConfig::default()).await,
        Err(WorkerError::Store(StoreError::FutureSchema { .. }))
    ));
    assert_eq!(std::fs::read(path).unwrap(), before_main);
    assert_eq!(std::fs::read(wal).unwrap(), before_wal);
    let logical: String = connection
        .query_row("SELECT value FROM future_evidence", [], |r| r.get(0))
        .unwrap();
    assert_eq!(logical, "retained-logical-evidence");
}

// This child entry point exists only in this integration-test executable. No
// production RPC can select a path, SQL, fault or exit operation.
#[test]
#[ignore = "owned parent starts this exact child with a unique retained fixture"]
fn controlled_child() {
    let path = PathBuf::from(std::env::var_os("SWARM_TEST_CHILD_DB").expect("owned child path"));
    let phase = std::env::var("SWARM_TEST_CHILD_PHASE").unwrap();
    let mut store = Store::open(&path).unwrap();
    let owner = store.trusted_owner();
    let sender = store.enroll_peer(&owner, fresh("sender")).unwrap();
    let recipient = store.enroll_peer(&owner, fresh("recipient")).unwrap();
    let group = store
        .create_group(
            &owner,
            "original",
            [
                sender.record.peer_id.clone(),
                recipient.record.peer_id.clone(),
            ]
            .into(),
        )
        .unwrap();
    let request = SendMessageRequest {
        group_id: group.group_id.clone(),
        client_key: "lost-reply".into(),
        recipients: [recipient.record.peer_id.clone()].into(),
        body: "synthetic retained crash message".into(),
        topic: None,
        reply_to: None,
    };
    drop(store);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let (_worker, receipt, attempt) = runtime.block_on(async {
        let worker = Worker::open(path.clone(), WorkerConfig::default())
            .await
            .unwrap();
        let client = worker.client();
        let mut receipt = None;
        let mut attempt = None;
        if phase == "lost-reply" {
            drop(
                client
                    .submit(Command::Send(sender.principal.clone(), request.clone()))
                    .unwrap(),
            );
            // This queued checkpoint observes completion without consuming the
            // send reply. The writer must commit despite its abandoned receiver.
            call(&client, || Command::Inspect).await.unwrap();
        } else if phase != "rollback" {
            let Response::Saved(saved) = call(&client, || {
                Command::Send(sender.principal.clone(), request.clone())
            })
            .await
            .unwrap() else {
                panic!()
            };
            receipt = Some(saved);
        }
        if phase == "ticket" {
            call(&client, || Command::Recover(owner.clone()))
                .await
                .unwrap();
            let Response::Candidates(candidates) = call(&client, || {
                Command::Candidates(
                    owner.clone(),
                    group.group_id.clone(),
                    recipient.record.peer_id.clone(),
                    recipient.record.revision,
                    1,
                )
            })
            .await
            .unwrap() else {
                panic!()
            };
            let Response::Ticket(ticket) = call(&client, || {
                Command::Begin(owner.clone(), candidates[0].clone())
            })
            .await
            .unwrap() else {
                panic!()
            };
            attempt = Some(ticket.attempt_id().clone());
        }
        (worker, receipt, attempt)
    });
    let connection = Connection::open(&path).unwrap();
    let committed_id: Option<String> = connection
        .query_row("SELECT message_id FROM messages LIMIT 1", [], |r| r.get(0))
        .ok();
    std::fs::write(
        path.with_extension("checkpoint.json"),
        serde_json::to_vec(&(
            sender.record,
            recipient.record,
            request,
            receipt,
            attempt,
            committed_id,
        ))
        .unwrap(),
    )
    .unwrap();
    if phase == "rollback" {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE; UPDATE groups SET label='uncommitted', next_sequence=999;",
            )
            .unwrap();
    }
    println!("SWARM_CHECKPOINT {phase}");
    std::io::stdout().flush().unwrap();
    let mut input = String::new();
    std::io::stdin().read_line(&mut input).unwrap();
    assert_eq!(input, "exit\n");
    // Abrupt process exit: no Rust destructors, Store drop or SQLite close.
    std::process::exit(73);
}
#[test]
fn owned_process_exit_recovers_commit_rollback_lost_reply_and_unfinished_ticket() {
    for phase in ["commit", "rollback", "lost-reply", "ticket"] {
        let path = support::retained_db(&format!("crash-{phase}"));
        let executable = std::env::current_exe().unwrap();
        std::fs::write(path.with_extension("sources.txt"), evidence::manifest()).unwrap();
        let stderr = std::fs::File::create(path.with_extension("stderr.log")).unwrap();
        let child = ProcessCommand::new(executable)
            .args(["--ignored", "--exact", "controlled_child", "--nocapture"])
            .env("SWARM_TEST_CHILD_DB", &path)
            .env("SWARM_TEST_CHILD_PHASE", phase)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr)
            .spawn()
            .unwrap();
        let mut child = OwnedChild {
            child,
            record: path.with_extension("exit.txt"),
            finished: false,
        };
        let mut output = std::io::BufReader::new(child.child.stdout.take().unwrap());
        let (checkpoint, reached) = std::sync::mpsc::sync_channel(1);
        let reader = std::thread::spawn(move || {
            let mut observed = String::new();
            loop {
                let mut line = String::new();
                if output.read_line(&mut line).unwrap() == 0 {
                    break;
                }
                if observed.len() < 64 * 1024 {
                    observed.push_str(&line);
                }
                if line.starts_with("SWARM_CHECKPOINT ") {
                    let _ = checkpoint.send(line);
                }
            }
            observed
        });
        let observed_checkpoint = reached
            .recv_timeout(std::time::Duration::from_secs(30))
            .expect("owned child checkpoint before watchdog deadline");
        assert_eq!(
            observed_checkpoint.trim(),
            format!("SWARM_CHECKPOINT {phase}")
        );
        child
            .child
            .stdin
            .take()
            .unwrap()
            .write_all(b"exit\n")
            .unwrap();
        let status = child.wait();
        let observed = reader.join().unwrap();
        std::fs::write(path.with_extension("stdout.log"), &observed).unwrap();
        assert_eq!(status.code(), Some(73));
        // The exact child has exited. Preserve the entire extant raw file set
        // before recovery/checkpointing changes SQLite's transient sidecars.
        for (suffix, label) in [("", "main"), ("-wal", "wal"), ("-shm", "shm")] {
            let source = PathBuf::from(format!("{}{suffix}", path.display()));
            if source.exists() {
                std::fs::write(
                    path.with_extension(format!("pre-recovery-{label}.bin")),
                    std::fs::read(source).unwrap(),
                )
                .unwrap();
            }
        }
        let (sender, recipient, request, receipt, attempt, committed_id): (
            PeerBindingRecord,
            PeerBindingRecord,
            SendMessageRequest,
            Option<SendReceipt>,
            Option<DeliveryAttemptId>,
            Option<String>,
        ) = serde_json::from_slice(&std::fs::read(path.with_extension("checkpoint.json")).unwrap())
            .unwrap();
        let mut recovered = Store::open(&path).unwrap();
        let owner = recovered.trusted_owner();
        let principal = recovered.authenticate_peer(&binding(&sender)).unwrap();
        if let Some(attempt) = attempt {
            assert_eq!(
                recovered
                    .delivery_attempt(&owner, &attempt)
                    .unwrap()
                    .outcome,
                None
            );
            assert!(matches!(
                recovered.delivery_candidates(
                    &owner,
                    &request.group_id,
                    &recipient.peer_id,
                    recipient.revision,
                    1
                ),
                Err(StoreError::RecoveryRequired)
            ));
            assert_eq!(recovered.recover_trusted_new_run(&owner).unwrap(), 1);
            assert_eq!(
                recovered
                    .delivery_attempt(&owner, &attempt)
                    .unwrap()
                    .outcome,
                Some(AttemptOutcome::Uncertain)
            );
        }
        let retry = recovered.send_message(&principal, request).unwrap();
        assert_eq!(retry.group_sequence, 1);
        if let Some(id) = committed_id {
            assert_eq!(retry.message_id.as_str(), id);
        }
        if let Some(receipt) = receipt {
            assert_eq!(retry, receipt);
        }
        let connection = Connection::open(&path).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT label FROM groups", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "original"
        );
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM messages", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(recovered.inspect().unwrap().integrity_ok);
        std::fs::write(
            path.with_extension("recovery.txt"),
            format!(
                "phase={phase}\nsequence={}\nmessage={}\nintegrity=ok\n",
                retry.group_sequence,
                retry.message_id.as_str()
            ),
        )
        .unwrap();
    }
}
#[tokio::test]
async fn readonly_fixture_allows_open_but_rejects_mutation_without_rewriting_data() {
    let path = support::retained_db("readonly-file");
    let store = Store::open(&path).unwrap();
    drop(store);
    let before = std::fs::read(&path).unwrap();
    let mut permissions = std::fs::metadata(&path).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&path, permissions).unwrap();
    let worker = Worker::open(path.clone(), WorkerConfig::default())
        .await
        .unwrap();
    let client = worker.client();
    let Response::Owner(owner) = call(&client, || Command::TrustedOwner).await.unwrap() else {
        panic!()
    };
    let result = call(&client, || {
        Command::CreateGroup(owner.clone(), "readonly-write".into(), Default::default())
    })
    .await;
    assert!(
        matches!(result,Err(OperationError::Store(StoreError::Sqlite(rusqlite::Error::SqliteFailure(e,_)))) if e.code==rusqlite::ErrorCode::ReadOnly)
    );
    worker.shutdown().await.unwrap();
    assert_eq!(std::fs::read(path).unwrap(), before);
}
