mod support;

use std::future::{poll_fn, Future};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::Duration;

use termx_swarm_core::{model::OwnerPrincipal, store::Store, worker::*};
use tokio::sync::oneshot;

struct LifetimeProbe {
    released: Mutex<Option<oneshot::Sender<()>>>,
}

impl Drop for LifetimeProbe {
    fn drop(&mut self) {
        if let Some(sender) = self.released.lock().unwrap().take() {
            let _ = sender.send(());
        }
    }
}

fn lifetime() -> (Arc<LifetimeProbe>, oneshot::Receiver<()>) {
    let (sender, receiver) = oneshot::channel();
    (
        Arc::new(LifetimeProbe {
            released: Mutex::new(Some(sender)),
        }),
        receiver,
    )
}

async fn open_guarded(
    path: PathBuf,
    config: WorkerConfig,
    lifetime: Arc<LifetimeProbe>,
) -> Result<Worker, WorkerError> {
    Worker::open_with_lifetime(path, config, lifetime).await
}

async fn released(receiver: oneshot::Receiver<()>) {
    tokio::time::timeout(Duration::from_secs(10), receiver)
        .await
        .expect("actual worker/reaper exit releases lifetime")
        .expect("probe release signal");
}

async fn admit(client: &Client, make: impl Fn() -> Command) -> Pending {
    loop {
        match client.submit(make()) {
            Ok(pending) => return pending,
            Err(AdmissionError::Contended) => tokio::task::yield_now().await,
            Err(error) => panic!("admission: {error}"),
        }
    }
}

async fn owner(client: &Client) -> OwnerPrincipal {
    match admit(client, || Command::TrustedOwner).await.await.unwrap() {
        Response::Owner(owner) => owner,
        other => panic!("unexpected owner response: {other:?}"),
    }
}

async fn poll_once<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
    let mut future = future;
    poll_fn(|cx| Poll::Ready(future.as_mut().poll(cx))).await
}

fn write_lock(path: &PathBuf) -> rusqlite::Connection {
    let connection = rusqlite::Connection::open(path).unwrap();
    connection.execute_batch("BEGIN IMMEDIATE").unwrap();
    connection
}

fn unlock(connection: rusqlite::Connection) {
    connection.execute_batch("ROLLBACK").unwrap();
    drop(connection);
}

#[tokio::test(flavor = "current_thread")]
async fn invalid_config_releases_lifetime_without_opening_database() {
    let path = support::retained_db("life-invalid");
    let (guard, signal) = lifetime();
    let config = WorkerConfig {
        max_requests: 0,
        ..WorkerConfig::default()
    };
    assert!(matches!(
        open_guarded(path.clone(), config, guard).await,
        Err(WorkerError::InvalidConfig)
    ));
    released(signal).await;
    assert!(!path.exists());
}

#[tokio::test(flavor = "current_thread")]
async fn store_open_error_releases_lifetime_after_worker_exits() {
    let path = support::retained_db("life-open-error");
    std::fs::write(&path, b"retained invalid database").unwrap();
    let (guard, signal) = lifetime();
    assert!(open_guarded(path.clone(), WorkerConfig::default(), guard)
        .await
        .is_err());
    released(signal).await;
    assert_eq!(std::fs::read(path).unwrap(), b"retained invalid database");
}

#[tokio::test(flavor = "current_thread")]
async fn worker_drop_keeps_lifetime_through_accepted_sqlite_work() {
    let path = support::retained_db("life-worker-drop");
    let (guard, mut signal) = lifetime();
    let worker = open_guarded(path.clone(), WorkerConfig::default(), guard.clone())
        .await
        .unwrap();
    let client = worker.client();
    let owner = owner(&client).await;
    let lock = write_lock(&path);
    let pending = admit(&client, || Command::Recover(owner.clone())).await;
    assert_eq!(client.metrics().requests, 1);
    drop(worker);
    drop(guard);
    // An accepted Recover cannot finish while this independent SQLite writer
    // owns the lock. The worker may be executing it or about to execute it;
    // either way its accepted database work must outlive the caller's handle.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let premature = signal.try_recv().is_ok();
    assert_eq!(client.metrics().requests, 1);
    unlock(lock);
    assert!(matches!(pending.await.unwrap(), Response::Recovered(0)));
    if !premature {
        released(signal).await;
    }
    assert_eq!(client.metrics().accepted, client.metrics().completed);
    assert_eq!(client.metrics().requests, 0);
    assert!(matches!(
        client.submit(Command::TrustedOwner),
        Err(AdmissionError::Closed)
    ));
    assert!(
        !premature,
        "caller Drop released lifetime before accepted SQLite work exited"
    );
    assert!(Store::open(path).unwrap().inspect().unwrap().integrity_ok);
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_shutdown_keeps_lifetime_until_actual_exit() {
    let path = support::retained_db("life-cancel-shutdown");
    let (guard, mut signal) = lifetime();
    let worker = open_guarded(path.clone(), WorkerConfig::default(), guard.clone())
        .await
        .unwrap();
    let client = worker.client();
    let owner = owner(&client).await;
    let lock = write_lock(&path);
    let pending = admit(&client, || Command::Recover(owner.clone())).await;
    let mut shutdown = Box::pin(worker.shutdown());
    assert!(poll_once(shutdown.as_mut()).await.is_pending());
    drop(shutdown);
    drop(guard);
    let premature = signal.try_recv().is_ok();
    assert_eq!(client.metrics().requests, 1);
    unlock(lock);
    assert!(matches!(pending.await.unwrap(), Response::Recovered(0)));
    if !premature {
        released(signal).await;
    }
    assert!(
        !premature,
        "cancelling shutdown released authority before SQLite drained"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_open_keeps_lifetime_while_store_open_is_blocked() {
    let path = support::retained_db("life-cancel-open");
    // A new, empty WAL database needs the real migration write transaction.
    // Current-schema open does not write, so it is not an opening barrier.
    let lock = rusqlite::Connection::open(&path).unwrap();
    lock.pragma_update(None, "journal_mode", "WAL").unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
    let (guard, mut signal) = lifetime();
    let mut opening = Box::pin(open_guarded(path.clone(), WorkerConfig::default(), guard));
    assert!(poll_once(opening.as_mut()).await.is_pending());
    // The held writer prevents migration/readiness until released.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(poll_once(opening.as_mut()).await.is_pending());
    drop(opening);
    let premature = signal.try_recv().is_ok();
    unlock(lock);
    if !premature {
        released(signal).await;
    }
    assert!(
        !premature,
        "cancelled open released lifetime before Store::open returned"
    );
    assert!(Store::open(path).unwrap().inspect().unwrap().integrity_ok);
}

#[tokio::test(flavor = "current_thread")]
async fn normal_shutdown_releases_lifetime_without_retained_client_keeping_it_alive() {
    let path = support::retained_db("life-normal");
    let (guard, mut signal) = lifetime();
    let worker = open_guarded(path, WorkerConfig::default(), guard.clone())
        .await
        .unwrap();
    let client = worker.client();
    let _owner = owner(&client).await;
    let unconsumed = admit(&client, || Command::TrustedOwner).await;
    drop(guard);
    let premature = signal.try_recv().is_ok();
    worker.shutdown().await.unwrap();
    if !premature {
        released(signal).await;
    }
    assert_eq!(client.metrics().requests, 0);
    assert!(matches!(unconsumed.await.unwrap(), Response::Owner(_)));
    assert!(
        !premature,
        "a live idle SQLite owner must retain its lifetime"
    );
}

/// A lifetime whose release takes real time, so a shutdown that resolves
/// before the reaper has dropped its copy is caught every run, not only on a
/// loaded machine.
struct SlowProbe {
    released: Mutex<Option<oneshot::Sender<()>>>,
}

impl Drop for SlowProbe {
    fn drop(&mut self) {
        std::thread::sleep(Duration::from_millis(150));
        if let Some(sender) = self.released.lock().unwrap().take() {
            let _ = sender.send(());
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn completed_shutdown_has_already_released_the_lifetime() {
    let path = support::retained_db("life-shutdown-released");
    let (sender, mut signal) = oneshot::channel();
    let guard = Arc::new(SlowProbe {
        released: Mutex::new(Some(sender)),
    });
    let worker = Worker::open_with_lifetime(path, WorkerConfig::default(), guard.clone())
        .await
        .unwrap();
    drop(guard);
    worker.shutdown().await.unwrap();
    // The broker re-claims its authority the moment shutdown resolves; the
    // reaper must have dropped the last lifetime copy before signalling exit.
    assert!(
        signal.try_recv().is_ok(),
        "shutdown resolved while the reaper still held the lifetime"
    );
}
