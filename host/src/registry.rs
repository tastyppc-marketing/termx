//! Session registry + state persistence. The registry is the ONLY owner of
//! Session objects — client connections borrow Arc clones and may die freely.

use crate::config::Config;
use crate::profiles;
use crate::protocol::{SessionId, SessionInfo};
use crate::session::Session;
use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

// DESIGN, not a leak: exited sessions stay registered (ring intact) until a
// client sends CloseSession — the M2 UI shows a dead shell's final output and
// must explicitly close a dismissed tab. Memory is bounded by sessions the
// user has actually opened, each capped at scrollback_bytes.
struct Entry {
    session: Arc<Session>,
    info: SessionInfo,
}

pub struct Registry {
    data_dir: PathBuf,
    config: Config,
    next_id: AtomicU32,
    entries: Mutex<HashMap<SessionId, Entry>>,
    layout: Mutex<serde_json::Value>,
    persist_lock: Mutex<()>,
    spawn_lock: Mutex<()>,
    // Set (under the entries lock) by shutdown_all; create_session checks it
    // under the same lock, so a session can never slip in after the drain and
    // outlive the daemon as an orphan conhost tree.
    shutting_down: AtomicBool,
    // Closed sessions whose ConPTY teardown may still be in flight. If the
    // process exits before a waiter thread drops the PTY master, the orphaned
    // OpenConsole can spin at 100% CPU forever (observed saturating this
    // machine). shutdown_all waits on these too; pruned once exited.
    graveyard: Mutex<Vec<Arc<Session>>>,
}

/// Terminal dims a real UI can produce. 0 panics conhost math; huge axes or
/// cell areas make conhost allocate screen buffers outside the memory bound.
const MAX_COLS: u16 = 1000;
const MAX_ROWS: u16 = 500;
const MAX_CELLS: u32 = 250_000;

fn validate_dims(cols: u16, rows: u16) -> Result<()> {
    let cells = u32::from(cols) * u32::from(rows);
    if cols == 0 || rows == 0 || cols > MAX_COLS || rows > MAX_ROWS || cells > MAX_CELLS {
        bail!("invalid terminal size {cols}x{rows} (max {MAX_COLS}x{MAX_ROWS}, {MAX_CELLS} cells)");
    }
    Ok(())
}

fn validate_cwd(cwd: Option<&Path>) -> Result<Option<PathBuf>> {
    let Some(cwd) = cwd else {
        return Ok(None);
    };
    if !cwd.is_absolute() {
        bail!("session cwd must be an absolute path: {}", cwd.display());
    }
    let metadata = std::fs::metadata(cwd)
        .with_context(|| format!("resolving session cwd {}", cwd.display()))?;
    if !metadata.is_dir() {
        bail!("session cwd is not a directory: {}", cwd.display());
    }
    Ok(Some(cwd.to_path_buf()))
}

impl Registry {
    pub fn new(data_dir: PathBuf, config: Config) -> Registry {
        // Load prior state: layout blob + the id watermark, so ids never
        // recycle across restarts (persisted layouts reference them). The
        // explicit next_id field is authoritative — deriving only from the
        // sessions list would reset the counter whenever the last persist
        // happened to have zero sessions open.
        let mut layout = serde_json::Value::Null;
        let mut max_seen_id: u32 = 0;
        match std::fs::read_to_string(data_dir.join("state.json")) {
            Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(v) => {
                    layout = v.get("layout").cloned().unwrap_or(serde_json::Value::Null);
                    if let Some(next) = v.get("next_id").and_then(|n| n.as_u64()) {
                        max_seen_id = max_seen_id.max((next as u32).saturating_sub(1));
                    }
                    if let Some(sessions) = v.get("sessions").and_then(|s| s.as_array()) {
                        for s in sessions {
                            if let Some(id) = s.get("id").and_then(|i| i.as_u64()) {
                                max_seen_id = max_seen_id.max(id as u32);
                            }
                        }
                    }
                }
                Err(e) => {
                    // Never silently reset a corrupt state file — say so.
                    tracing::warn!("state.json is corrupt, starting with empty layout: {e}");
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!("state.json unreadable, starting with empty layout: {e}"),
        }
        Registry {
            data_dir,
            config,
            next_id: AtomicU32::new(max_seen_id + 1),
            entries: Mutex::new(HashMap::new()),
            layout: Mutex::new(layout),
            persist_lock: Mutex::new(()),
            spawn_lock: Mutex::new(()),
            shutting_down: AtomicBool::new(false),
            graveyard: Mutex::new(Vec::new()),
        }
    }

    pub fn create_session(
        &self,
        profile: Option<&str>,
        cwd: Option<&Path>,
        cols: u16,
        rows: u16,
    ) -> Result<(SessionInfo, Arc<Session>)> {
        validate_dims(cols, rows)?;
        let cwd = validate_cwd(cwd)?;
        let name = profile.unwrap_or(&self.config.default_profile);
        let prof = profiles::resolve(name)?;
        // Serialize spawn+registration with shutdown's transition. Once
        // shutdown_all holds this lock and flips the flag, no late ConPTY can
        // appear after its entries/graveyard drain.
        let _spawn = self.spawn_lock.lock().unwrap();
        if self.shutting_down.load(Ordering::SeqCst) {
            bail!("host is shutting down");
        }
        let session = Arc::new(Session::spawn(
            &prof,
            cwd.as_deref(),
            cols,
            rows,
            self.config.scrollback_bytes,
        )?);
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let info = SessionInfo {
            id,
            profile: name.to_string(),
            cwd: cwd.as_deref().map(|p| p.display().to_string()),
            cols,
            rows,
            alive: true,
            pid: session.pid(),
        };
        {
            let mut entries = self.entries.lock().unwrap();
            if self.shutting_down.load(Ordering::SeqCst) {
                drop(entries);
                session.kill();
                bail!("host is shutting down");
            }
            entries.insert(
                id,
                Entry {
                    session: Arc::clone(&session),
                    info: info.clone(),
                },
            );
        }
        self.persist_logged();
        Ok((info, session))
    }

    pub fn get(&self, id: SessionId) -> Option<Arc<Session>> {
        self.entries
            .lock()
            .unwrap()
            .get(&id)
            .map(|e| Arc::clone(&e.session))
    }

    pub fn close_session(&self, id: SessionId) -> bool {
        // Remove and graveyard-register under ONE entries critical section
        // (graveyard locked inside — same order as shutdown_all): a session
        // must never be in neither set, or a concurrent shutdown_all's
        // teardown wait can miss it and the daemon exits mid-teardown.
        let entry = {
            let mut entries = self.entries.lock().unwrap();
            let Some(entry) = entries.remove(&id) else {
                return false;
            };
            let mut graveyard = self.graveyard.lock().unwrap();
            graveyard.retain(|s| s.exited().is_none());
            graveyard.push(Arc::clone(&entry.session));
            entry
        };
        entry.session.kill();
        self.persist_logged();
        true
    }

    /// Resize the PTY and the recorded dims under ONE lock, so two concurrent
    /// resizes can't leave the PTY at A's size and the registry at B's.
    ///
    /// Deliberately does NOT persist: resize storms (every drag tick in M2)
    /// must not hammer state.json with synchronous writes. Dims land on disk
    /// with the next lifecycle persist (create/close/layout/exit/shutdown).
    pub fn resize_session(&self, id: SessionId, cols: u16, rows: u16) -> Result<()> {
        validate_dims(cols, rows)?;
        let mut entries = self.entries.lock().unwrap();
        let Some(entry) = entries.get_mut(&id) else {
            bail!("no session {id}");
        };
        entry.session.resize(cols, rows)?;
        entry.info.cols = cols;
        entry.info.rows = rows;
        Ok(())
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        // Opportunistic graveyard prune: without this, the LAST closed
        // session's ring would linger until the next close or shutdown.
        self.graveyard
            .lock()
            .unwrap()
            .retain(|s| s.exited().is_none());
        let shutting_down = self.shutting_down.load(Ordering::SeqCst);
        let mut infos: Vec<SessionInfo> = self
            .entries
            .lock()
            .unwrap()
            .values()
            .map(|e| {
                let mut info = e.info.clone();
                info.alive = !shutting_down && e.session.exited().is_none();
                info
            })
            .collect();
        infos.sort_by_key(|i| i.id);
        infos
    }

    /// Returns the persist result so callers can tell the client whether the
    /// layout is actually durable (a silent persist failure here would lose
    /// the user's tab/group arrangement on the next restart).
    pub fn set_layout(&self, layout: serde_json::Value) -> Result<()> {
        let _persist = self.persist_lock.lock().unwrap();
        let previous = {
            let mut current = self.layout.lock().unwrap();
            std::mem::replace(&mut *current, layout)
        };
        if let Err(error) = self.persist_unlocked() {
            *self.layout.lock().unwrap() = previous;
            return Err(error);
        }
        Ok(())
    }

    pub fn layout(&self) -> serde_json::Value {
        self.layout.lock().unwrap().clone()
    }

    /// Atomic + serialized: a per-registry lock and a per-process tmp name so
    /// concurrent persist() calls can neither interleave writes nor collide on
    /// the tmp file; rename keeps crash-consistency.
    pub fn persist(&self) -> Result<()> {
        let _guard = self.persist_lock.lock().unwrap();
        self.persist_unlocked()
    }

    fn persist_unlocked(&self) -> Result<()> {
        let state = serde_json::json!({
            "layout": self.layout(),
            "sessions": self.list(),
            "next_id": self.next_id.load(Ordering::SeqCst),
        });
        let path = self.data_dir.join("state.json");
        let tmp = self
            .data_dir
            .join(format!("state.json.tmp.{}", std::process::id()));
        std::fs::write(&tmp, serde_json::to_string_pretty(&state)?)
            .with_context(|| format!("writing {}", tmp.display()))?;
        std::fs::rename(&tmp, &path).with_context(|| format!("renaming to {}", path.display()))?;
        Ok(())
    }

    /// persist() with the error surfaced to the log instead of dropped —
    /// callers on hot paths must not fail the session operation over it.
    pub fn persist_logged(&self) {
        if let Err(e) = self.persist() {
            tracing::warn!("state persist failed: {e:#}");
        }
    }

    pub fn shutdown_all(&self) {
        // Wait for any spawn already in progress, then prevent every later spawn
        // before taking the final registry/graveyard snapshot.
        let _spawn = self.spawn_lock.lock().unwrap();
        // Mark every session dead in the final durable snapshot. A fresh daemon
        // cannot recover ConPTY processes owned by the old process, so persisting
        // alive:true here would advertise sessions that no longer exist.
        // Set the shutdown flag under the same entries lock create_session uses,
        // then persist before draining so the final session metadata is retained.
        {
            let mut entries = self.entries.lock().unwrap();
            if self.shutting_down.swap(true, Ordering::SeqCst) {
                return;
            }
            for entry in entries.values_mut() {
                entry.info.alive = false;
            }
        }
        self.persist_logged();
        let drained: Vec<Entry> = self
            .entries
            .lock()
            .unwrap()
            .drain()
            .map(|(_, e)| e)
            .collect();
        for entry in &drained {
            entry.session.kill();
        }
        // kill() runs its tree-kill on a detached thread, and each session's
        // waiter thread still has to drop the PTY master; the daemon is about
        // to exit and MUST NOT take either down mid-teardown — an OpenConsole
        // orphaned with broken pipes spins at 100% CPU forever. Bounded wait
        // covers live sessions AND the graveyard (recently closed, teardown
        // in flight): every one observes its exit watch (which fires only
        // after the master is dropped), or 5s total elapse.
        // (close_session registers into the graveyard under the entries lock,
        // so any close that got its entry out before OUR drain above has its
        // session in the graveyard by the time we drain it here.)
        let parting: Vec<Arc<Session>> = drained
            .iter()
            .map(|e| Arc::clone(&e.session))
            .chain(self.graveyard.lock().unwrap().drain(..))
            .collect();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        for session in &parting {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                tracing::warn!("shutdown kill wait exhausted; exiting anyway");
                break;
            }
            session.wait_exit_blocking(left);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_registry() -> (tempfile::TempDir, Registry) {
        let tmp = tempfile::tempdir().unwrap();
        let reg = Registry::new(tmp.path().to_path_buf(), Config::default());
        (tmp, reg)
    }

    #[test]
    fn create_list_close_lifecycle() {
        let (_tmp, reg) = test_registry();
        let (info, s) = reg.create_session(Some("cmd"), None, 80, 25).unwrap();
        assert_eq!(info.id, 1);
        assert_eq!(info.profile, "cmd");
        let listed = reg.list();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].alive);
        assert!(reg.close_session(info.id));
        assert!(reg.list().is_empty());
        assert!(!reg.close_session(999), "unknown id -> false");
        assert!(s.wait_exit_blocking(std::time::Duration::from_secs(10)));
    }

    #[test]
    fn ids_are_unique_and_increasing() {
        let (_tmp, reg) = test_registry();
        let (a, sa) = reg.create_session(Some("cmd"), None, 80, 25).unwrap();
        let (b, sb) = reg.create_session(Some("cmd"), None, 80, 25).unwrap();
        assert!(b.id > a.id);
        reg.close_session(a.id);
        reg.close_session(b.id);
        for s in [sa, sb] {
            assert!(s.wait_exit_blocking(std::time::Duration::from_secs(10)));
        }
    }

    #[test]
    fn ids_do_not_recycle_across_restarts() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("state.json"),
            r#"{"layout": {"keep": true}, "sessions": [{"id": 41, "profile": "cmd", "cwd": null, "cols": 80, "rows": 25, "alive": false}]}"#,
        )
        .unwrap();
        let reg = Registry::new(tmp.path().to_path_buf(), Config::default());
        let (info, s) = reg.create_session(Some("cmd"), None, 80, 25).unwrap();
        assert!(
            info.id > 41,
            "new ids must not collide with persisted layout references (got {})",
            info.id
        );
        reg.close_session(info.id);
        assert!(s.wait_exit_blocking(std::time::Duration::from_secs(10)));
    }

    #[test]
    fn unknown_profile_is_an_error() {
        let (_tmp, reg) = test_registry();
        assert!(reg.create_session(Some("nope"), None, 80, 25).is_err());
    }

    #[test]
    fn configured_default_profile_applies_when_profile_omitted() {
        let tmp = tempfile::tempdir().unwrap();
        let reg = Registry::new(
            tmp.path().to_path_buf(),
            Config {
                default_profile: "cmd".into(),
                ..Config::default()
            },
        );
        let (info, s) = reg.create_session(None, None, 80, 25).unwrap();
        assert_eq!(info.profile, "cmd", "config.json default_profile must win");
        assert!(info.pid.is_some(), "spawned session must report its pid");
        reg.close_session(info.id);
        assert!(s.wait_exit_blocking(std::time::Duration::from_secs(10)));
    }

    #[test]
    fn concurrent_failed_layout_updates_cannot_rollback_each_other() {
        let tmp = tempfile::tempdir().unwrap();
        let reg = Arc::new(Registry::new(tmp.path().to_path_buf(), Config::default()));
        let original = serde_json::json!({"groups": ["original"]});
        reg.set_layout(original.clone()).unwrap();
        std::fs::remove_file(tmp.path().join("state.json")).unwrap();
        std::fs::create_dir(tmp.path().join("state.json")).unwrap();

        let persist_guard = reg.persist_lock.lock().unwrap();
        let reg_a = Arc::clone(&reg);
        let update_a =
            std::thread::spawn(move || reg_a.set_layout(serde_json::json!({"groups": ["a"]})));
        std::thread::sleep(std::time::Duration::from_millis(50));
        let reg_b = Arc::clone(&reg);
        let update_b =
            std::thread::spawn(move || reg_b.set_layout(serde_json::json!({"groups": ["b"]})));
        std::thread::sleep(std::time::Duration::from_millis(50));
        drop(persist_guard);

        assert!(update_a.join().unwrap().is_err());
        assert!(update_b.join().unwrap().is_err());
        assert_eq!(reg.layout(), original);
    }

    #[test]
    fn failed_layout_persist_rolls_back_in_memory_state() {
        let tmp = tempfile::tempdir().unwrap();
        let reg = Registry::new(tmp.path().to_path_buf(), Config::default());
        reg.set_layout(serde_json::json!({"groups": ["durable"]}))
            .unwrap();
        std::fs::remove_file(tmp.path().join("state.json")).unwrap();
        std::fs::create_dir(tmp.path().join("state.json")).unwrap();

        assert!(reg
            .set_layout(serde_json::json!({"groups": ["not-durable"]}))
            .is_err());

        assert_eq!(reg.layout(), serde_json::json!({"groups": ["durable"]}));
    }

    #[test]
    fn layout_blob_persists_across_instances() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let reg = Registry::new(tmp.path().to_path_buf(), Config::default());
            reg.set_layout(serde_json::json!({"groups": [{"name": "client work"}]}))
                .unwrap();
        }
        let reg2 = Registry::new(tmp.path().to_path_buf(), Config::default());
        assert_eq!(reg2.layout()["groups"][0]["name"], "client work");
    }

    #[test]
    fn corrupt_state_json_degrades_to_empty_layout() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("state.json"), "{ not json at all").unwrap();
        let reg = Registry::new(tmp.path().to_path_buf(), Config::default());
        assert_eq!(reg.layout(), serde_json::Value::Null);
    }

    #[test]
    fn resize_session_updates_pty_and_dims_atomically() {
        let (_tmp, reg) = test_registry();
        let (info, s) = reg.create_session(Some("cmd"), None, 80, 25).unwrap();
        reg.resize_session(info.id, 132, 43).unwrap();
        let listed = reg.list();
        assert_eq!((listed[0].cols, listed[0].rows), (132, 43));
        assert!(
            reg.resize_session(9999, 80, 25).is_err(),
            "unknown id errors"
        );
        reg.close_session(info.id);
        assert!(s.wait_exit_blocking(std::time::Duration::from_secs(10)));
    }

    #[test]
    fn close_then_immediate_shutdown_waits_for_full_teardown() {
        // The close-last-tab-then-quit flow: shutdown must not let the daemon
        // exit while the just-closed session's ConPTY teardown is in flight.
        let (_tmp, reg) = test_registry();
        let (info, s) = reg.create_session(Some("cmd"), None, 80, 25).unwrap();
        assert!(reg.close_session(info.id));
        reg.shutdown_all();
        assert!(
            s.exited().is_some(),
            "shutdown_all returned before the closed session finished teardown"
        );
    }

    #[test]
    fn absurd_dims_are_rejected() {
        let (_tmp, reg) = test_registry();
        assert!(reg.create_session(Some("cmd"), None, 0, 25).is_err());
        assert!(reg.create_session(Some("cmd"), None, 80, 0).is_err());
        assert!(reg.create_session(Some("cmd"), None, 65535, 25).is_err());
        assert!(
            reg.create_session(Some("cmd"), None, 1000, 500).is_err(),
            "individually plausible axes must still respect the cell-area cap"
        );
        let (info, s) = reg.create_session(Some("cmd"), None, 80, 25).unwrap();
        assert!(reg.resize_session(info.id, 0, 25).is_err());
        assert!(reg.resize_session(info.id, 80, 65535).is_err());
        assert!(reg.resize_session(info.id, 1000, 500).is_err());
        reg.close_session(info.id);
        assert!(s.wait_exit_blocking(std::time::Duration::from_secs(10)));
    }

    #[test]
    fn validated_cwd_preserves_user_selected_path() {
        let tmp = tempfile::tempdir().unwrap();
        let selected = tmp.path().to_path_buf();

        let validated = validate_cwd(Some(&selected)).unwrap().unwrap();

        assert_eq!(
            validated, selected,
            "cwd metadata must not expose canonicalized Windows path syntax"
        );
    }

    #[test]
    fn cwd_must_be_an_existing_absolute_directory() {
        let (_tmp, reg) = test_registry();
        assert!(
            reg.create_session(Some("cmd"), Some(Path::new("relative")), 80, 25)
                .is_err(),
            "relative cwd must never resolve against the daemon's own cwd"
        );
        let missing = std::env::temp_dir().join("termx-definitely-missing-cwd");
        assert!(reg
            .create_session(Some("cmd"), Some(&missing), 80, 25)
            .is_err());
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(reg
            .create_session(Some("cmd"), Some(file.path()), 80, 25)
            .is_err());
    }

    #[test]
    fn ids_do_not_recycle_even_when_no_sessions_were_persisted() {
        // Close-everything-then-restart: the sessions list persists as empty,
        // so the watermark must come from the explicit next_id field.
        let tmp = tempfile::tempdir().unwrap();
        let first_id = {
            let reg = Registry::new(tmp.path().to_path_buf(), Config::default());
            let (info, s) = reg.create_session(Some("cmd"), None, 80, 25).unwrap();
            reg.close_session(info.id); // persists with sessions: []
            assert!(s.wait_exit_blocking(std::time::Duration::from_secs(10)));
            info.id
        };
        let reg2 = Registry::new(tmp.path().to_path_buf(), Config::default());
        let (info2, s2) = reg2.create_session(Some("cmd"), None, 80, 25).unwrap();
        assert!(
            info2.id > first_id,
            "id {} recycled after empty-list persist (first was {})",
            info2.id,
            first_id
        );
        reg2.close_session(info2.id);
        assert!(s2.wait_exit_blocking(std::time::Duration::from_secs(10)));
    }

    #[test]
    fn create_session_after_shutdown_is_refused() {
        let (_tmp, reg) = test_registry();
        reg.shutdown_all();
        let err = match reg.create_session(Some("cmd"), None, 80, 25) {
            Ok(_) => panic!("create after shutdown must fail"),
            Err(e) => e,
        };
        assert!(err.to_string().contains("shutting down"), "{err:#}");
        assert!(reg.list().is_empty(), "no orphan entry may remain");
    }

    #[test]
    fn shutdown_persists_sessions_as_not_alive() {
        let tmp = tempfile::tempdir().unwrap();
        let reg = Registry::new(tmp.path().to_path_buf(), Config::default());
        let (_info, session) = reg.create_session(Some("cmd"), None, 80, 25).unwrap();

        reg.shutdown_all();

        let state: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(tmp.path().join("state.json")).unwrap())
                .unwrap();
        assert!(
            state["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .all(|info| info["alive"] == false),
            "a stopped daemon must never persist sessions as alive: {state}"
        );
        assert!(session.exited().is_some());
    }

    #[test]
    fn repeated_shutdown_preserves_final_session_metadata() {
        let tmp = tempfile::tempdir().unwrap();
        let reg = Registry::new(tmp.path().to_path_buf(), Config::default());
        let (info, _session) = reg.create_session(Some("cmd"), None, 80, 25).unwrap();

        reg.shutdown_all();
        reg.shutdown_all();

        let state: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(tmp.path().join("state.json")).unwrap())
                .unwrap();
        assert_eq!(state["sessions"][0]["id"], info.id);
        assert_eq!(state["sessions"][0]["alive"], false);
    }

    #[test]
    fn persist_writes_sessions_snapshot() {
        let (tmp, reg) = test_registry();
        let (info, s) = reg.create_session(Some("cmd"), None, 80, 25).unwrap();
        reg.persist().unwrap();
        let text = std::fs::read_to_string(tmp.path().join("state.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["sessions"][0]["id"], info.id);
        reg.close_session(info.id);
        assert!(s.wait_exit_blocking(std::time::Duration::from_secs(10)));
    }

    #[test]
    fn tiny_scrollback_config_bounds_the_ring() {
        let tmp = tempfile::tempdir().unwrap();
        let reg = Registry::new(
            tmp.path().to_path_buf(),
            Config {
                scrollback_bytes: 2048,
                ..Config::default()
            },
        );
        let (_info, session) = reg
            .create_session(Some("cmd"), None, 80, 25)
            .expect("spawn");
        // Interactive cmd emits a banner + prompt; whatever arrives, the ring
        // must never exceed the configured cap.
        std::thread::sleep(std::time::Duration::from_secs(2));
        let (_, bytes) = session.snapshot();
        assert!(bytes.len() <= 2048, "ring exceeded configured cap");
        session.kill();
        assert!(session.wait_exit_blocking(std::time::Duration::from_secs(10)));
    }
}
