pub mod agent_launch;
pub mod config;
pub mod history;
pub mod paths;
pub mod profiles;
pub mod protocol;
pub mod registry;
pub mod ring;
pub mod server;
pub mod session;

#[cfg(test)]
#[path = "../tests/support/mod.rs"]
pub(crate) mod test_support;

/// Serializes the firehose-class PTY tests: several concurrent multi-thousand
/// -line conhost sessions starve each other under the parallel test runner
/// and blow per-test deadlines. Heavy tests take this lock (`.lock().await`
/// in async tests, `.blocking_lock()` in sync ones); light tests don't.
#[cfg(test)]
pub(crate) static HEAVY_PTY_TEST: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
