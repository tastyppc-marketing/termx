//! Opt-in synthetic core workload. Never opens an existing fixture.
#[path = "sustained_support/benchmark.rs"]
mod benchmark;
#[path = "sustained_support/fixture.rs"]
mod fixture;
#[path = "sustained_support/load.rs"]
mod load;
#[path = "sustained_support/transitions.rs"]
mod transitions;

use fixture::*;
use std::{path::PathBuf, time::Instant};
use termx_swarm_core::worker::*;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert_eq!(
        args.len(),
        4,
        "sustained NEW_DIRECTORY PRELOAD PHASE_SECONDS (0=bench only)"
    );
    let directory = PathBuf::from(&args[1]);
    std::fs::create_dir(&directory).expect("fixture must be new; preserve previous runs");
    let preload: u64 = args[2].parse().unwrap();
    let seconds: u64 = args[3].parse().unwrap();
    assert!(preload >= 256 && preload.is_multiple_of(2));
    emit(
        serde_json::json!({"event":"start","pid":std::process::id(),"seed":24301,"sqlite":rusqlite::version(),"preload":preload,"phase_seconds":seconds,"clients":8,"peers":6,"groups":2,"worker":WorkerConfig::default()}),
    );
    let worker = Worker::open(directory.join("swarm.sqlite"), WorkerConfig::default())
        .await
        .unwrap();
    let client = worker.client();
    let mut fixture = Fixture::new(&client).await;
    let start = Instant::now();
    fixture.preload(&client, preload).await;
    emit(
        serde_json::json!({"event":"preloaded","messages":preload,"elapsed_ms":start.elapsed().as_millis(),"metrics":client.metrics()}),
    );
    benchmark::run(&client, &fixture).await;
    transitions::run(&client, &mut fixture).await;
    if seconds > 0 {
        load::run(&client, &mut fixture, seconds).await;
    }
    for group in 0..2 {
        benchmark::traverse(&client, &fixture, "final_navigation", group).await;
    }
    let Response::Inspection(inspection) = call(&client, || Command::Inspect).await else {
        panic!("inspection")
    };
    assert!(inspection.integrity_ok && inspection.foreign_keys);
    assert_eq!(inspection.journal_mode.to_lowercase(), "wal");
    assert_eq!(inspection.synchronous, "FULL");
    emit(
        serde_json::json!({"event":"integrity","ok":true,"retained_workload_expected":fixture.next.iter().sum::<u64>() - 2,"retained_boundary_expected":147,"metrics":client.metrics()}),
    );
    worker.shutdown().await.unwrap();
    let metrics = client.metrics();
    assert_eq!(metrics.accepted, metrics.completed);
    assert_eq!(metrics.requests, 0);
    assert_eq!(metrics.responses, 0);
    emit(serde_json::json!({"event":"done","metrics":metrics}));
}
