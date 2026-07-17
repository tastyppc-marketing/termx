//! Session registry + state persistence. The registry is the ONLY owner of
//! Session objects — client connections borrow Arc clones and may die freely.

use crate::config::Config;
use crate::profiles;
use crate::protocol::{SessionId, SessionInfo};
use crate::session::Session;
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

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
}

impl Registry {
    pub fn new(data_dir: PathBuf, config: Config) -> Registry {
        // Load prior state: layout blob + the highest session id ever persisted,
        // so ids never recycle across restarts (persisted layouts reference them).
        let mut layout = serde_json::Value::Null;
        let mut max_seen_id: u32 = 0;
        match std::fs::read_to_string(data_dir.join("state.json")) {
            Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(v) => {
                    layout = v.get("layout").cloned().unwrap_or(serde_json::Value::Null);
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
        }
    }

    pub fn create_session(
        &self,
        profile: Option<&str>,
        cwd: Option<&Path>,
        cols: u16,
        rows: u16,
    ) -> Result<(SessionInfo, Arc<Session>)> {
        let name = profile.unwrap_or(&self.config.default_profile);
        let prof = profiles::resolve(name)?;
        let session = Arc::new(Session::spawn(
            &prof,
            cwd,
            cols,
            rows,
            self.config.scrollback_bytes,
        )?);
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let info = SessionInfo {
            id,
            profile: name.to_string(),
            cwd: cwd.map(|p| p.display().to_string()),
            cols,
            rows,
            alive: true,
        };
        self.entries.lock().unwrap().insert(
            id,
            Entry {
                session: Arc::clone(&session),
                info: info.clone(),
            },
        );
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
        let removed = self.entries.lock().unwrap().remove(&id);
        match removed {
            Some(entry) => {
                entry.session.kill();
                self.persist_logged();
                true
            }
            None => false,
        }
    }

    pub fn update_dims(&self, id: SessionId, cols: u16, rows: u16) {
        if let Some(entry) = self.entries.lock().unwrap().get_mut(&id) {
            entry.info.cols = cols;
            entry.info.rows = rows;
        }
        self.persist_logged();
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        let mut infos: Vec<SessionInfo> = self
            .entries
            .lock()
            .unwrap()
            .values()
            .map(|e| {
                let mut info = e.info.clone();
                info.alive = e.session.exited().is_none();
                info
            })
            .collect();
        infos.sort_by_key(|i| i.id);
        infos
    }

    pub fn set_layout(&self, layout: serde_json::Value) {
        *self.layout.lock().unwrap() = layout;
        self.persist_logged();
    }

    pub fn layout(&self) -> serde_json::Value {
        self.layout.lock().unwrap().clone()
    }

    /// Atomic + serialized: a per-registry lock and a per-process tmp name so
    /// concurrent persist() calls can neither interleave writes nor collide on
    /// the tmp file; rename keeps crash-consistency.
    pub fn persist(&self) -> Result<()> {
        let _guard = self.persist_lock.lock().unwrap();
        let state = serde_json::json!({
            "layout": self.layout(),
            "sessions": self.list(),
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
        // Capture the final state (with alive flags) BEFORE killing everything.
        self.persist_logged();
        for (_, entry) in self.entries.lock().unwrap().drain() {
            entry.session.kill();
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
        let (info, _s) = reg.create_session(Some("cmd"), None, 80, 25).unwrap();
        assert_eq!(info.id, 1);
        assert_eq!(info.profile, "cmd");
        let listed = reg.list();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].alive);
        assert!(reg.close_session(info.id));
        assert!(reg.list().is_empty());
        assert!(!reg.close_session(999), "unknown id -> false");
    }

    #[test]
    fn ids_are_unique_and_increasing() {
        let (_tmp, reg) = test_registry();
        let (a, _sa) = reg.create_session(Some("cmd"), None, 80, 25).unwrap();
        let (b, _sb) = reg.create_session(Some("cmd"), None, 80, 25).unwrap();
        assert!(b.id > a.id);
        reg.close_session(a.id);
        reg.close_session(b.id);
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
        let (info, _s) = reg.create_session(Some("cmd"), None, 80, 25).unwrap();
        assert!(
            info.id > 41,
            "new ids must not collide with persisted layout references (got {})",
            info.id
        );
        reg.close_session(info.id);
    }

    #[test]
    fn unknown_profile_is_an_error() {
        let (_tmp, reg) = test_registry();
        assert!(reg.create_session(Some("nope"), None, 80, 25).is_err());
    }

    #[test]
    fn layout_blob_persists_across_instances() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let reg = Registry::new(tmp.path().to_path_buf(), Config::default());
            reg.set_layout(serde_json::json!({"groups": [{"name": "client work"}]}));
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
    fn update_dims_reflected_in_list() {
        let (_tmp, reg) = test_registry();
        let (info, _s) = reg.create_session(Some("cmd"), None, 80, 25).unwrap();
        reg.update_dims(info.id, 132, 43);
        let listed = reg.list();
        assert_eq!((listed[0].cols, listed[0].rows), (132, 43));
        reg.close_session(info.id);
    }

    #[test]
    fn persist_writes_sessions_snapshot() {
        let (tmp, reg) = test_registry();
        let (info, _s) = reg.create_session(Some("cmd"), None, 80, 25).unwrap();
        reg.persist().unwrap();
        let text = std::fs::read_to_string(tmp.path().join("state.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["sessions"][0]["id"], info.id);
        reg.close_session(info.id);
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
    }
}
