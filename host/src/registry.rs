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
}

impl Registry {
    pub fn new(data_dir: PathBuf, config: Config) -> Registry {
        let layout = std::fs::read_to_string(data_dir.join("state.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .map(|v| v.get("layout").cloned().unwrap_or(serde_json::Value::Null))
            .unwrap_or(serde_json::Value::Null);
        Registry {
            data_dir,
            config,
            next_id: AtomicU32::new(1),
            entries: Mutex::new(HashMap::new()),
            layout: Mutex::new(layout),
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
        let _ = self.persist();
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
                let _ = self.persist();
                true
            }
            None => false,
        }
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
        let _ = self.persist();
    }

    pub fn layout(&self) -> serde_json::Value {
        self.layout.lock().unwrap().clone()
    }

    /// Atomic write: tmp file + rename, so a crash mid-write never corrupts state.
    pub fn persist(&self) -> Result<()> {
        let state = serde_json::json!({
            "layout": self.layout(),
            "sessions": self.list(),
        });
        let path = self.data_dir.join("state.json");
        let tmp = self.data_dir.join("state.json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&state)?)
            .with_context(|| format!("writing {}", tmp.display()))?;
        std::fs::rename(&tmp, &path).with_context(|| format!("renaming to {}", path.display()))?;
        Ok(())
    }

    pub fn shutdown_all(&self) {
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
    fn persist_writes_sessions_snapshot() {
        let (tmp, reg) = test_registry();
        let (info, _s) = reg.create_session(Some("cmd"), None, 80, 25).unwrap();
        reg.persist().unwrap();
        let text = std::fs::read_to_string(tmp.path().join("state.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["sessions"][0]["id"], info.id);
        reg.close_session(info.id);
    }
}
