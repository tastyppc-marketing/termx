use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

pub fn retained_db(test_name: &str) -> PathBuf {
    let unique = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time after epoch")
        .as_nanos();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("retired")
        .join("test-artifacts")
        .join("swarm-core")
        .join(format!("{test_name}-{timestamp}-{unique}"));
    std::fs::create_dir_all(&root).expect("create retained fixture directory");
    root.join("swarm.sqlite")
}
