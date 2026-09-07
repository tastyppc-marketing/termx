//! Session registry + state persistence. The registry is the ONLY owner of
//! Session objects — client connections borrow Arc clones and may die freely.

use crate::config::Config;
use crate::history::{self, HistoryWriter};
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
    // Sessions a PREVIOUS daemon ran, read back from state.json at startup.
    // The daemon dies (a reboot, a crash) but the panes' cwd and profile are
    // what makes "Restart" restart THE pane rather than a default shell — so
    // the records outlive the processes. A corpse is a record only: it cannot
    // be attached, written to, or resized; it can be listed and closed.
    corpses: Mutex<HashMap<SessionId, SessionInfo>>,
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

/// Stamps `TERMX=1` and `TERMX_SESSION_ID=<id>` onto a resolved profile's env
/// so CLIs, CLAUDE.md rules, and hooks running inside the spawned shell can
/// detect they are inside TermX (spec §7). Independent of
/// `shell_integration` — this always runs, unlike the cmd PROMPT hook above.
fn stamp_termx_env(
    env: &mut Vec<(String, String)>,
    id: SessionId,
    host_exe: &Path,
    data_dir: &Path,
) {
    env.push(("TERMX".to_string(), "1".to_string()));
    env.push(("TERMX_SESSION_ID".to_string(), id.to_string()));
    // The cross-tool convention on top of the TERMX-specific pair: CLIs that
    // ask "which terminal am I in?" read TERM_PROGRAM (Claude Code's terminal
    // detection among them), and conditional CLAUDE.md rules key off it.
    env.push(("TERM_PROGRAM".to_string(), "TermX".to_string()));
    env.push((
        "TERM_PROGRAM_VERSION".to_string(),
        env!("CARGO_PKG_VERSION").to_string(),
    ));
    env.push((
        "TERMX_HOST_EXE".to_string(),
        host_exe.display().to_string(),
    ));
    env.push((
        "TERMX_DATA_DIR".to_string(),
        data_dir.display().to_string(),
    ));
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
        let mut corpses: HashMap<SessionId, SessionInfo> = HashMap::new();
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
                            // The previous daemon's sessions become corpse
                            // records: dead, but their cwd/profile survive so
                            // a dead pane can be restarted where it stood.
                            // A record that does not parse is dropped, never
                            // an error — restore must not fail on one row.
                            if let Ok(mut info) = serde_json::from_value::<SessionInfo>(s.clone()) {
                                info.alive = false;
                                info.pid = None;
                                corpses.insert(info.id, info);
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
            corpses: Mutex::new(corpses),
            graveyard: Mutex::new(Vec::new()),
        }
    }

    pub fn create_session(
        self: &Arc<Self>,
        profile: Option<&str>,
        cwd: Option<&Path>,
        cols: u16,
        rows: u16,
        shell_integration: bool,
    ) -> Result<(SessionInfo, Arc<Session>)> {
        validate_dims(cols, rows)?;
        let cwd = validate_cwd(cwd)?;
        let name = profile.unwrap_or(&self.config.default_profile);
        let mut prof = profiles::resolve(name, shell_integration)?;
        // Serialize spawn+registration with shutdown's transition. Once
        // shutdown_all holds this lock and flips the flag, no late ConPTY can
        // appear after its entries/graveyard drain.
        let _spawn = self.spawn_lock.lock().unwrap();
        if self.shutting_down.load(Ordering::SeqCst) {
            bail!("host is shutting down");
        }
        // Assigned before spawn (moved earlier than the old post-spawn id
        // allocation) so it can be stamped into the child's own env below:
        // CLIs/hooks that read TERMX_SESSION_ID must see it from process
        // birth, independent of shell_integration (spec §7).
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let host_exe = std::env::current_exe().context("resolving termx-host executable")?;
        stamp_termx_env(&mut prof.env, id, &host_exe, &self.data_dir);
        // history_bytes: 0 means no writer at all, so the eviction path keeps
        // its pre-history cost. A spill file we cannot create costs history,
        // never the session.
        let history = match self.config.history_bytes {
            0 => None,
            cap => match HistoryWriter::open(&self.data_dir, id, cap) {
                Ok(writer) => Some(writer),
                Err(error) => {
                    tracing::warn!("scrollback history unavailable for session {id}: {error:#}");
                    None
                }
            },
        };
        // The reader thread reports the shell's own cwd (OSC 9;9) back here so
        // the record FOLLOWS the shell. Weak: a session must never keep its
        // registry alive.
        let on_cwd: crate::session::CwdCallback = {
            let weak = Arc::downgrade(self);
            Box::new(move |reported: &str| {
                if let Some(registry) = weak.upgrade() {
                    registry.note_session_cwd(id, reported);
                }
            })
        };
        let session = Arc::new(Session::spawn_with_history(
            &prof,
            cwd.as_deref(),
            cols,
            rows,
            self.config.scrollback_bytes,
            history,
            Some(on_cwd),
        )?);
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

    /// A cwd the session's shell reported for itself (OSC 9;9, parsed by the
    /// reader thread). The recorded cwd follows the shell so a corpse record
    /// restarts — and resumes its conversation — where the shell LAST stood,
    /// not where it was created; before this, a pane created without a folder
    /// persisted `cwd: null` forever and reboot recovery had nothing to work
    /// with. Stored verbatim (an ssh launcher pane reports its REMOTE path —
    /// still the most truthful answer to "where was this pane"); validation
    /// happens where it matters, on the next create's cwd. Persisted only on
    /// change: the reader thread dedupes same-cwd prompt reports, so this
    /// fires on actual `cd`s.
    fn note_session_cwd(&self, id: SessionId, reported: &str) {
        {
            let mut entries = self.entries.lock().unwrap();
            let Some(entry) = entries.get_mut(&id) else {
                return; // closed while the report was in flight
            };
            if entry.info.cwd.as_deref() == Some(reported) {
                return;
            }
            entry.info.cwd = Some(reported.to_string());
        }
        self.persist_logged();
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
                // Closing a corpse is how a dead pane is dismissed after the
                // daemon that ran it died: drop the record, reap any spilled
                // history, persist. There is no process to kill.
                if self.corpses.lock().unwrap().remove(&id).is_some() {
                    drop(entries);
                    history::delete(&self.data_dir, id);
                    self.persist_logged();
                    return true;
                }
                return false;
            };
            let mut graveyard = self.graveyard.lock().unwrap();
            graveyard.retain(|s| s.exited().is_none());
            graveyard.push(Arc::clone(&entry.session));
            entry
        };
        entry.session.kill();
        // Rust opens files with FILE_SHARE_DELETE, so this succeeds even while
        // the dying session's reader thread still holds the writer handle:
        // Windows unlinks the name now and reclaims the blocks at last close.
        history::delete(&self.data_dir, id);
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

    /// Page backward through a session's spilled scrollback. Absence and
    /// corruption both degrade to `None` — the caller answers "no history",
    /// which is exactly what a client can act on. Deliberately does not require
    /// a live session: a just-exited tab's history is still readable.
    pub fn read_history(
        &self,
        id: SessionId,
        before_offset: u64,
        max_bytes: u32,
    ) -> Option<history::HistorySlice> {
        match history::read_history(&self.data_dir, id, before_offset, max_bytes) {
            Ok(slice) => slice,
            Err(error) => {
                tracing::warn!("history unreadable for session {id}: {error:#}");
                None
            }
        }
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
        // Corpse records ride along so clients can restore dead panes with
        // their real cwd/profile. Ids never collide with live entries — the
        // next_id watermark starts past every persisted id — but guard anyway:
        // a live session is always the truth about its own id.
        {
            let live: std::collections::HashSet<SessionId> =
                infos.iter().map(|i| i.id).collect();
            let corpses = self.corpses.lock().unwrap();
            infos.extend(corpses.values().filter(|c| !live.contains(&c.id)).cloned());
        }
        infos.sort_by_key(|i| i.id);
        infos
    }

    /// Point-in-time answer for ClientMsg::ProbeSession: is this session
    /// alive, and is anything running inside its shell? Unknown ids are
    /// `(false, false)` — a vanished session is a normal answer, not an error.
    pub fn probe(&self, id: SessionId) -> (bool, bool) {
        let session = {
            let entries = self.entries.lock().unwrap();
            match entries.get(&id) {
                Some(entry) => Arc::clone(&entry.session),
                None => return (false, false),
            }
        };
        // The busy check walks the OS process snapshot — do it OUTSIDE the
        // entries lock so a slow snapshot never stalls create/close/list.
        let alive =
            !self.shutting_down.load(Ordering::SeqCst) && session.exited().is_none();
        let busy = alive && session.has_child_processes();
        (alive, busy)
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

    fn test_registry() -> (tempfile::TempDir, Arc<Registry>) {
        let tmp = tempfile::tempdir().unwrap();
        let reg = Arc::new(Registry::new(tmp.path().to_path_buf(), Config::default()));
        (tmp, reg)
    }

    /// The daemon dies (a reboot); its state.json still names the sessions
    /// it ran. The NEXT daemon must serve those as corpse records — dead,
    /// with their cwd and profile intact — so a client can restart a dead
    /// pane where it stood instead of in the default directory. Closing a
    /// corpse drops the record and persists.
    #[test]
    fn corpse_records_survive_a_daemon_death_until_closed() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("state.json"),
            serde_json::json!({
                "layout": {"v": 2},
                "next_id": 42,
                "sessions": [
                    {"id": 7, "profile": "powershell", "cwd": "C:\\Dev\\TermX",
                     "cols": 120, "rows": 30, "alive": true, "pid": 4321},
                    {"id": 9, "profile": "cmd", "cwd": null,
                     "cols": 80, "rows": 24, "alive": false, "pid": null},
                    {"not": "a session record"}
                ],
            })
            .to_string(),
        )
        .unwrap();

        let reg = Arc::new(Registry::new(tmp.path().to_path_buf(), Config::default()));
        let listed = reg.list();
        assert_eq!(listed.len(), 2, "both parseable records survive, junk is dropped");
        let corpse = listed.iter().find(|s| s.id == 7).unwrap();
        assert!(!corpse.alive, "a corpse is never alive, whatever the file said");
        assert_eq!(corpse.cwd.as_deref(), Some(r"C:\Dev\TermX"));
        assert_eq!(corpse.profile, "powershell");
        assert_eq!(corpse.pid, None, "a dead record must not point at a live pid");

        // Corpses ride through persist, so a second restart still knows them.
        reg.persist().unwrap();
        let reg2 = Arc::new(Registry::new(tmp.path().to_path_buf(), Config::default()));
        assert_eq!(reg2.list().len(), 2);

        // Closing a corpse dismisses it durably.
        assert!(reg2.close_session(7), "a corpse can be closed");
        assert!(reg2.list().iter().all(|s| s.id != 7));
        let reg3 = Arc::new(Registry::new(tmp.path().to_path_buf(), Config::default()));
        assert!(reg3.list().iter().all(|s| s.id != 7), "the dismissal persisted");

        // The id watermark still respects corpse ids: nothing recycles 41.
        let (info, s) = reg3.create_session(Some("cmd"), None, 80, 25, false).unwrap();
        assert!(info.id >= 42, "new ids start past the persisted watermark");
        reg3.close_session(info.id);
        assert!(s.wait_exit_blocking(std::time::Duration::from_secs(10)));
    }

    /// The defect behind "only one pane resumed after my reboot": the
    /// recorded cwd was frozen at creation, so a pane opened without a folder
    /// persisted `cwd: null` forever and its corpse had nothing to restart
    /// into. The record must FOLLOW the shell: cd, and the registry — and
    /// state.json, and the corpse the NEXT daemon serves — all know the new
    /// folder.
    #[test]
    fn recorded_cwd_follows_the_shell_into_state_json_and_the_corpse() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("termx_cd_target");
        std::fs::create_dir(&target).unwrap();
        let target_str = target.to_string_lossy().to_string();

        let reg = Arc::new(Registry::new(tmp.path().to_path_buf(), Config::default()));
        // Created WITHOUT a cwd — exactly the pane shape that used to persist
        // null forever. shell_integration on: the prompt hook is the channel.
        let (info, s) = reg
            .create_session(Some("cmd"), None, 80, 25, true)
            .unwrap();
        assert_eq!(info.cwd, None, "creation records what was asked: nothing");

        s.write_input(format!("cd /d \"{target_str}\"\r\n").as_bytes())
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let listed = reg.list();
            let cwd = listed
                .iter()
                .find(|row| row.id == info.id)
                .and_then(|row| row.cwd.clone());
            if cwd.as_deref() == Some(target_str.as_str()) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "recorded cwd never followed the cd; last saw {cwd:?}"
            );
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        // The change persisted on its own — no lifecycle event in between.
        let state: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(tmp.path().join("state.json")).unwrap(),
        )
        .unwrap();
        let row = state["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == info.id)
            .expect("session row persisted");
        assert_eq!(row["cwd"], serde_json::json!(target_str));

        // A daemon death (no shutdown, no close — the reboot case): the next
        // daemon's corpse stands in the folder the shell LAST stood in.
        drop(reg);
        let reg2 = Arc::new(Registry::new(tmp.path().to_path_buf(), Config::default()));
        let corpse = reg2
            .list()
            .into_iter()
            .find(|row| row.id == info.id)
            .expect("corpse served");
        assert!(!corpse.alive);
        assert_eq!(corpse.cwd.as_deref(), Some(target_str.as_str()));

        s.kill();
        assert!(s.wait_exit_blocking(std::time::Duration::from_secs(10)));
    }

    #[test]
    fn create_list_close_lifecycle() {
        let (_tmp, reg) = test_registry();
        let (info, s) = reg
            .create_session(Some("cmd"), None, 80, 25, false)
            .unwrap();
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

    /// Long-uptime hygiene: closing the same session twice must be a no-op the
    /// second time — no second kill, no second graveyard entry keeping a dead
    /// session's ring alive, and no complaint about history that is already
    /// gone. A UI that double-fires a close (double-click, retry after a
    /// reconnect) must not leak a session's worth of memory per attempt.
    #[test]
    fn closing_a_session_twice_is_a_no_op_the_second_time() {
        let (tmp, reg) = test_registry();
        let (info, session) = reg
            .create_session(Some("cmd"), None, 80, 25, false)
            .unwrap();
        assert!(reg.close_session(info.id), "first close does the work");
        let after_first = reg.graveyard.lock().unwrap().len();

        assert!(
            !reg.close_session(info.id),
            "a session already closed cannot be closed again"
        );

        assert!(
            reg.graveyard.lock().unwrap().len() <= after_first,
            "a repeated close must not re-register the session for teardown"
        );
        assert!(!history::session_file(tmp.path(), info.id).exists());
        assert!(session.wait_exit_blocking(std::time::Duration::from_secs(10)));
    }

    #[test]
    fn ids_are_unique_and_increasing() {
        let (_tmp, reg) = test_registry();
        let (a, sa) = reg
            .create_session(Some("cmd"), None, 80, 25, false)
            .unwrap();
        let (b, sb) = reg
            .create_session(Some("cmd"), None, 80, 25, false)
            .unwrap();
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
        let reg = Arc::new(Registry::new(tmp.path().to_path_buf(), Config::default()));
        let (info, s) = reg
            .create_session(Some("cmd"), None, 80, 25, false)
            .unwrap();
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
        assert!(reg
            .create_session(Some("nope"), None, 80, 25, false)
            .is_err());
    }

    #[test]
    fn configured_default_profile_applies_when_profile_omitted() {
        let tmp = tempfile::tempdir().unwrap();
        let reg = Arc::new(Registry::new(
            tmp.path().to_path_buf(),
            Config {
                default_profile: "cmd".into(),
                ..Config::default()
            },
        ));
        let (info, s) = reg.create_session(None, None, 80, 25, false).unwrap();
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
        let reg = Arc::new(Registry::new(tmp.path().to_path_buf(), Config::default()));
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
            let reg = Arc::new(Registry::new(tmp.path().to_path_buf(), Config::default()));
            reg.set_layout(serde_json::json!({"groups": [{"name": "client work"}]}))
                .unwrap();
        }
        let reg2 = Arc::new(Registry::new(tmp.path().to_path_buf(), Config::default()));
        assert_eq!(reg2.layout()["groups"][0]["name"], "client work");
    }

    #[test]
    fn corrupt_state_json_degrades_to_empty_layout() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("state.json"), "{ not json at all").unwrap();
        let reg = Arc::new(Registry::new(tmp.path().to_path_buf(), Config::default()));
        assert_eq!(reg.layout(), serde_json::Value::Null);
    }

    #[test]
    fn resize_session_updates_pty_and_dims_atomically() {
        let (_tmp, reg) = test_registry();
        let (info, s) = reg
            .create_session(Some("cmd"), None, 80, 25, false)
            .unwrap();
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
        let (info, s) = reg
            .create_session(Some("cmd"), None, 80, 25, false)
            .unwrap();
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
        assert!(reg.create_session(Some("cmd"), None, 0, 25, false).is_err());
        assert!(reg.create_session(Some("cmd"), None, 80, 0, false).is_err());
        assert!(reg
            .create_session(Some("cmd"), None, 65535, 25, false)
            .is_err());
        assert!(
            reg.create_session(Some("cmd"), None, 1000, 500, false)
                .is_err(),
            "individually plausible axes must still respect the cell-area cap"
        );
        let (info, s) = reg
            .create_session(Some("cmd"), None, 80, 25, false)
            .unwrap();
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
            reg.create_session(Some("cmd"), Some(Path::new("relative")), 80, 25, false)
                .is_err(),
            "relative cwd must never resolve against the daemon's own cwd"
        );
        let missing = std::env::temp_dir().join("termx-definitely-missing-cwd");
        assert!(reg
            .create_session(Some("cmd"), Some(&missing), 80, 25, false)
            .is_err());
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(reg
            .create_session(Some("cmd"), Some(file.path()), 80, 25, false)
            .is_err());
    }

    #[test]
    fn ids_do_not_recycle_even_when_no_sessions_were_persisted() {
        // Close-everything-then-restart: the sessions list persists as empty,
        // so the watermark must come from the explicit next_id field.
        let tmp = tempfile::tempdir().unwrap();
        let first_id = {
            let reg = Arc::new(Registry::new(tmp.path().to_path_buf(), Config::default()));
            let (info, s) = reg
                .create_session(Some("cmd"), None, 80, 25, false)
                .unwrap();
            reg.close_session(info.id); // persists with sessions: []
            assert!(s.wait_exit_blocking(std::time::Duration::from_secs(10)));
            info.id
        };
        let reg2 = Arc::new(Registry::new(tmp.path().to_path_buf(), Config::default()));
        let (info2, s2) = reg2
            .create_session(Some("cmd"), None, 80, 25, false)
            .unwrap();
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
        let err = match reg.create_session(Some("cmd"), None, 80, 25, false) {
            Ok(_) => panic!("create after shutdown must fail"),
            Err(e) => e,
        };
        assert!(err.to_string().contains("shutting down"), "{err:#}");
        assert!(reg.list().is_empty(), "no orphan entry may remain");
    }

    #[test]
    fn shutdown_persists_sessions_as_not_alive() {
        let tmp = tempfile::tempdir().unwrap();
        let reg = Arc::new(Registry::new(tmp.path().to_path_buf(), Config::default()));
        let (_info, session) = reg
            .create_session(Some("cmd"), None, 80, 25, false)
            .unwrap();

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
        let reg = Arc::new(Registry::new(tmp.path().to_path_buf(), Config::default()));
        let (info, _session) = reg
            .create_session(Some("cmd"), None, 80, 25, false)
            .unwrap();

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
        let (info, s) = reg
            .create_session(Some("cmd"), None, 80, 25, false)
            .unwrap();
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
        let reg = Arc::new(Registry::new(
            tmp.path().to_path_buf(),
            Config {
                scrollback_bytes: 2048,
                ..Config::default()
            },
        ));
        let (_info, session) = reg
            .create_session(Some("cmd"), None, 80, 25, false)
            .expect("spawn");
        // Interactive cmd emits a banner + prompt; whatever arrives, the ring
        // must never exceed the configured cap.
        std::thread::sleep(std::time::Duration::from_secs(2));
        let (_, bytes) = session.snapshot();
        assert!(bytes.len() <= 2048, "ring exceeded configured cap");
        session.kill();
        assert!(session.wait_exit_blocking(std::time::Duration::from_secs(10)));
    }

    /// The whole point of the spill file: what the ring forgets, disk keeps —
    /// at the SAME absolute offsets, so the two windows meet without a gap.
    #[test]
    fn ring_eviction_spills_to_the_history_file() {
        let tmp = tempfile::tempdir().unwrap();
        let reg = Arc::new(Registry::new(
            tmp.path().to_path_buf(),
            Config {
                scrollback_bytes: 2048,
                ..Config::default()
            },
        ));
        let (info, session) = reg
            .create_session(Some("cmd"), None, 80, 25, false)
            .unwrap();
        session
            .write_input(b"for /L %i in (1,1,400) do @echo history_line_%i\r\n")
            .unwrap();

        // The ring is updated before the spill append, so a snapshot taken
        // between the two can briefly show the file lagging. Poll until the
        // shell falls quiet and the two windows meet exactly.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        let (ring_start, page) = loop {
            assert!(
                std::time::Instant::now() < deadline,
                "ring never evicted into history"
            );
            let (ring_start, _) = session.snapshot();
            let page = history::read_history(tmp.path(), info.id, ring_start, 512 * 1024)
                .unwrap()
                .expect("history file must exist once a session is created");
            if ring_start > 0 && page.start_offset + page.data.len() as u64 == ring_start {
                break (ring_start, page);
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        };
        assert_eq!(page.start_offset, 0, "nothing was truncated at this size");
        assert!(page.at_start);
        assert_eq!(page.data.len() as u64, ring_start);
        assert!(
            String::from_utf8_lossy(&page.data).contains("history_line_"),
            "the spill must hold the real evicted stream"
        );

        reg.close_session(info.id);
        assert!(
            !history::session_file(tmp.path(), info.id).exists(),
            "closing a session forgets its history"
        );
        assert!(session.wait_exit_blocking(std::time::Duration::from_secs(10)));
    }

    #[test]
    fn zero_history_bytes_creates_no_spill_file() {
        let tmp = tempfile::tempdir().unwrap();
        let reg = Arc::new(Registry::new(
            tmp.path().to_path_buf(),
            Config {
                history_bytes: 0,
                ..Config::default()
            },
        ));
        let (info, session) = reg
            .create_session(Some("cmd"), None, 80, 25, false)
            .unwrap();
        assert!(
            !history::session_file(tmp.path(), info.id).exists(),
            "history off must cost nothing, not an empty file"
        );
        reg.close_session(info.id);
        assert!(session.wait_exit_blocking(std::time::Duration::from_secs(10)));
    }

    #[test]
    fn stamp_termx_env_appends_marker_and_session_id() {
        let mut env = vec![("PROMPT".to_string(), "$P$G".to_string())];
        stamp_termx_env(
            &mut env,
            42,
            Path::new(r"C:\TermX\termx-host.exe"),
            Path::new(r"D:\TermXData"),
        );
        assert_eq!(
            env,
            vec![
                ("PROMPT".to_string(), "$P$G".to_string()),
                ("TERMX".to_string(), "1".to_string()),
                ("TERMX_SESSION_ID".to_string(), "42".to_string()),
                ("TERM_PROGRAM".to_string(), "TermX".to_string()),
                (
                    "TERM_PROGRAM_VERSION".to_string(),
                    env!("CARGO_PKG_VERSION").to_string(),
                ),
                (
                    "TERMX_HOST_EXE".to_string(),
                    r"C:\TermX\termx-host.exe".to_string(),
                ),
                ("TERMX_DATA_DIR".to_string(), r"D:\TermXData".to_string()),
            ],
            "TERMX vars must be appended, not replace existing profile env"
        );
    }

    #[test]
    fn termx_env_reaches_a_real_spawned_session() {
        // Registry::create_session doesn't expose custom argv (profiles own
        // their args), so the only way to observe the stamped env in a real
        // child process is the same pattern the other registry tests use:
        // spawn interactive cmd for real, then drive it with write_input and
        // read back what the live process actually saw.
        let (_tmp, reg) = test_registry();
        let (info, s) = reg
            .create_session(Some("cmd"), None, 80, 25, false)
            .unwrap();
        s.write_input(b"echo TX:%TERMX_SESSION_ID%:%TERMX%\r\n")
            .unwrap();
        let marker = format!("TX:{}:1", info.id);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut seen = String::new();
        while std::time::Instant::now() < deadline && !seen.contains(&marker) {
            seen = String::from_utf8_lossy(&s.snapshot().1).into_owned();
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(
            seen.contains(&marker),
            "TERMX/TERMX_SESSION_ID not observed in real spawned session; saw {seen:?}"
        );
        reg.close_session(info.id);
        assert!(s.wait_exit_blocking(std::time::Duration::from_secs(10)));
    }

    #[test]
    fn launcher_paths_reach_a_real_spawned_session() {
        let (tmp, reg) = test_registry();
        let (info, s) = reg
            .create_session(Some("cmd"), None, 80, 25, false)
            .unwrap();
        s.write_input(b"echo HX:%TERMX_HOST_EXE%\r\necho DD:%TERMX_DATA_DIR%\r\n")
            .unwrap();
        let host = std::env::current_exe().unwrap().display().to_string();
        let data = tmp.path().display().to_string();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut seen = String::new();
        while std::time::Instant::now() < deadline
            && !(seen.contains(&format!("HX:{host}")) && seen.contains(&format!("DD:{data}")))
        {
            seen = String::from_utf8_lossy(&s.snapshot().1).into_owned();
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(seen.contains(&format!("HX:{host}")), "host exe stamp missing: {seen:?}");
        assert!(seen.contains(&format!("DD:{data}")), "data dir stamp missing: {seen:?}");
        reg.close_session(info.id);
        assert!(s.wait_exit_blocking(std::time::Duration::from_secs(10)));
    }
}
