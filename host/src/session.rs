//! One ConPTY-backed shell session. The reader thread is the only place PTY
//! output enters the system: ring buffer first (authoritative, capped), then
//! a bounded broadcast for live listeners. No client/socket state lives here.
//!
//! Lifecycle: a waiter thread owns the PTY slave (see spawn), records the exit
//! code, tears down the master (closing ConPTY so conhost + reader wind down),
//! closes the input channel, and fires `exit_watch` so every observer — any
//! client's forwarder on any connection — learns the session ended.

use crate::profiles::Profile;
use crate::ring::RingBuffer;
use anyhow::{bail, Context, Result};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, watch};

/// Strip DSR cursor-position queries (ESC[6n) out of a PTY output chunk.
///
/// The host is the single answerer of these queries (conhost blocks child
/// console init until SOMEONE answers, and headless sessions have no terminal).
/// They are stripped from the stream entirely so an attached real terminal
/// (xterm.js in M2) neither double-answers live queries nor answers stale ones
/// replayed from the ring — and ring/broadcast offsets stay consistent because
/// both sides only ever see the stripped stream.
///
/// Returns (clean bytes, query count, carry) where `carry` is a trailing
/// partial query prefix to prepend to the next chunk.
fn strip_dsr(carry: &[u8], chunk: &[u8]) -> (Vec<u8>, usize, Vec<u8>) {
    const QUERY: &[u8] = b"\x1b[6n";
    let mut scan = Vec::with_capacity(carry.len() + chunk.len());
    scan.extend_from_slice(carry);
    scan.extend_from_slice(chunk);
    let mut clean = Vec::with_capacity(scan.len());
    let mut count = 0usize;
    let mut i = 0usize;
    while i < scan.len() {
        if scan[i] == 0x1b {
            let rest = &scan[i..];
            if rest.len() >= QUERY.len() {
                if &rest[..QUERY.len()] == QUERY {
                    count += 1;
                    i += QUERY.len();
                    continue;
                }
                clean.push(scan[i]);
                i += 1;
            } else if QUERY.starts_with(rest) {
                break; // partial query at the end -> carry it
            } else {
                clean.push(scan[i]);
                i += 1;
            }
        } else {
            clean.push(scan[i]);
            i += 1;
        }
    }
    (clean, count, scan[i..].to_vec())
}

#[derive(Clone, Debug)]
pub struct OutputChunk {
    pub offset: u64,
    pub data: Arc<Vec<u8>>,
}

enum WriterCmd {
    Data(Vec<u8>),
}

/// None while running; Some(exit_code) after the child exits.
pub type ExitState = Option<Option<u32>>;

pub struct Session {
    ring: Arc<Mutex<RingBuffer>>,
    tx_out: broadcast::Sender<OutputChunk>,
    tx_writer: Arc<Mutex<Option<std::sync::mpsc::SyncSender<WriterCmd>>>>,
    master: Arc<Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    child_pid: Option<u32>,
    exit_rx: watch::Receiver<ExitState>,
}

/// Largest single input frame accepted. Input rides a COUNT-bounded channel
/// (256 slots), so per-frame bytes must be capped or one client could park
/// gigabytes of paste data in memory. Clients chunk larger pastes.
pub const MAX_INPUT_FRAME: usize = 256 * 1024;

impl Session {
    pub fn spawn(
        profile: &Profile,
        cwd: Option<&Path>,
        cols: u16,
        rows: u16,
        ring_cap: usize,
    ) -> Result<Session> {
        Self::spawn_with_broadcast_cap(profile, cwd, cols, rows, ring_cap, 256)
    }

    /// `broadcast_cap` is the live-listener chunk buffer (chunks, not bytes);
    /// laggards resync from the ring. Exposed so tests can force the Lagged
    /// path deterministically with a tiny capacity.
    pub(crate) fn spawn_with_broadcast_cap(
        profile: &Profile,
        cwd: Option<&Path>,
        cols: u16,
        rows: u16,
        ring_cap: usize,
        broadcast_cap: usize,
    ) -> Result<Session> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("openpty")?;

        let mut cmd = CommandBuilder::new(profile.command.as_os_str());
        cmd.args(profile.args.iter());
        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }
        let mut child = pair.slave.spawn_command(cmd).context("spawn shell")?;
        let child_pid = child.process_id();
        let killer = child.clone_killer();
        // Windows kills the child with 0xC0000142 (STATUS_DLL_INIT_FAILED) if
        // slave handles close during its initialization (wezterm/wezterm#4674).
        // The waiter thread owns the slave and drops it only after exit.
        let slave = pair.slave;

        let mut reader = pair.master.try_clone_reader().context("clone reader")?;
        let mut writer = pair.master.take_writer().context("take writer")?;
        let master = Arc::new(Mutex::new(Some(pair.master)));

        let ring = Arc::new(Mutex::new(RingBuffer::new(ring_cap)));
        let (tx_out, _) = broadcast::channel::<OutputChunk>(broadcast_cap.max(1));
        let (exit_tx, exit_rx) = watch::channel::<ExitState>(None);

        // Writer thread: serializes all input to the PTY. Client input rides a
        // bounded channel (a child that stops reading -> input errors instead
        // of growing memory). DSR answers ride a DEDICATED unbounded channel
        // drained with priority: a full input channel must never drop a
        // console-init query answer — conhost blocks the spawning child's init
        // until it arrives (invariant #2), so one dropped answer is a
        // permanently wedged shell. The channel is unbounded but tiny: one
        // unit per query, queries are rare and bounded by output volume.
        let (tx_writer, rx_writer) = std::sync::mpsc::sync_channel::<WriterCmd>(256);
        let (tx_dsr, rx_dsr) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            loop {
                while rx_dsr.try_recv().is_ok() {
                    if writer.write_all(b"\x1b[1;1R").is_err() {
                        return; // PTY gone; child exited
                    }
                    let _ = writer.flush();
                }
                // Short timeout so a pending DSR answer is picked up promptly
                // even when no client input is flowing.
                match rx_writer.recv_timeout(Duration::from_millis(10)) {
                    Ok(WriterCmd::Data(data)) => {
                        if writer.write_all(&data).is_err() {
                            break;
                        }
                        let _ = writer.flush();
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        // Reader thread: sole producer into ring + broadcast; also the DSR
        // answerer (see strip_dsr docs).
        let ring_r = Arc::clone(&ring);
        let tx_r = tx_out.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut carry: Vec<u8> = Vec::new();
            let publish = |bytes: Vec<u8>| {
                if bytes.is_empty() {
                    return;
                }
                let mut ring = ring_r.lock().unwrap();
                let offset = ring.end_offset();
                ring.push(&bytes);
                drop(ring);
                // Laggards get Lagged and resync via snapshot(); send() only
                // errors when there are no receivers, which is fine.
                let _ = tx_r.send(OutputChunk {
                    offset,
                    data: Arc::new(bytes),
                });
            };
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        // EOF: flush any held-back partial sequence verbatim.
                        let leftover = std::mem::take(&mut carry);
                        publish(leftover);
                        break;
                    }
                    Ok(n) => {
                        let (clean, queries, new_carry) = strip_dsr(&carry, &buf[..n]);
                        carry = new_carry;
                        for _ in 0..queries {
                            // Unbounded + non-blocking: never stalls the reader,
                            // never drops an answer. Err = writer gone (exit).
                            let _ = tx_dsr.send(());
                        }
                        publish(clean);
                    }
                }
            }
        });

        // Waiter thread: records the exit, releases the slave AND the master
        // (closing ConPTY ends conhost and unblocks the reader at EOF), closes
        // the input channel so write_input fails fast, then fires the exit
        // watch for all observers.
        let master_w = Arc::clone(&master);
        let tx_writer_slot = Arc::new(Mutex::new(Some(tx_writer)));
        let tx_writer_w = Arc::clone(&tx_writer_slot);
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code());
            drop(slave);
            // Give conhost a beat to flush trailing output into the pipe
            // before tearing the console down.
            std::thread::sleep(Duration::from_millis(100));
            *master_w.lock().unwrap() = None;
            *tx_writer_w.lock().unwrap() = None;
            let _ = exit_tx.send(Some(code));
        });

        Ok(Session {
            ring,
            tx_out,
            tx_writer: tx_writer_slot,
            master,
            killer: Mutex::new(killer),
            child_pid,
            exit_rx,
        })
    }

    pub fn write_input(&self, data: &[u8]) -> Result<()> {
        if data.len() > MAX_INPUT_FRAME {
            bail!(
                "input frame too large ({} bytes, max {MAX_INPUT_FRAME}); chunk large pastes",
                data.len()
            );
        }
        // Accepted race: between the child exiting and the waiter clearing this
        // slot (~100ms), a frame can be enqueued to a writer nobody drains and
        // be reported Ok. Input to a dying shell is lost either way.
        let guard = self.tx_writer.lock().unwrap();
        let Some(tx) = guard.as_ref() else {
            bail!("session exited");
        };
        match tx.try_send(WriterCmd::Data(data.to_vec())) {
            Ok(()) => Ok(()),
            Err(std::sync::mpsc::TrySendError::Full(_)) => {
                bail!("input backpressure: session not consuming input")
            }
            Err(std::sync::mpsc::TrySendError::Disconnected(_)) => bail!("session exited"),
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        match self.master.lock().unwrap().as_ref() {
            Some(master) => master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .context("pty resize"),
            None => bail!("session exited"),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<OutputChunk> {
        self.tx_out.subscribe()
    }

    /// Watch that flips to Some(exit_code) when the child exits (any cause).
    pub fn subscribe_exit(&self) -> watch::Receiver<ExitState> {
        self.exit_rx.clone()
    }

    pub fn snapshot(&self) -> (u64, Vec<u8>) {
        self.ring.lock().unwrap().snapshot()
    }

    /// Kill the whole process tree (shells spawn children; killing only the
    /// direct child would orphan grandchildren under ConPTY).
    ///
    /// ORDER MATTERS: taskkill /T must walk the tree WHILE THE ROOT IS STILL
    /// ALIVE — terminate the root first and taskkill finds nothing, orphaning
    /// detached descendants (dev servers, daemons), exactly what /T exists to
    /// catch. So the tree kill runs to completion on its own thread (async
    /// callers never block; the exit watch — not this call — signals
    /// completion), and only then does the direct-child TerminateProcess
    /// fallback fire for anything taskkill missed.
    pub fn kill(&self) {
        let pid = self.child_pid;
        let mut killer = self.killer.lock().unwrap().clone_killer();
        std::thread::spawn(move || {
            if let Some(pid) = pid {
                let _ = std::process::Command::new("taskkill")
                    .args(["/T", "/F", "/PID", &pid.to_string()])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
            }
            let _ = killer.kill();
        });
    }

    /// OS pid of the shell process (None if the platform didn't report one).
    pub fn pid(&self) -> Option<u32> {
        self.child_pid
    }

    pub fn exited(&self) -> ExitState {
        *self.exit_rx.borrow()
    }

    pub fn wait_exit_blocking(&self, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if self.exited().is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles;

    fn collect_output_until_exit(s: &Session) -> String {
        assert!(
            s.wait_exit_blocking(Duration::from_secs(30)),
            "session should exit"
        );
        let (_, bytes) = s.snapshot();
        String::from_utf8_lossy(&bytes).to_string()
    }

    #[test]
    fn strip_dsr_removes_whole_query() {
        let (clean, count, carry) = strip_dsr(b"", b"ab\x1b[6ncd");
        assert_eq!(clean, b"abcd");
        assert_eq!(count, 1);
        assert!(carry.is_empty());
    }

    #[test]
    fn strip_dsr_handles_split_across_chunks() {
        let (clean1, count1, carry1) = strip_dsr(b"", b"hello\x1b[6");
        assert_eq!(clean1, b"hello");
        assert_eq!(count1, 0);
        assert_eq!(carry1, b"\x1b[6");
        let (clean2, count2, carry2) = strip_dsr(&carry1, b"nworld");
        assert_eq!(clean2, b"world");
        assert_eq!(count2, 1);
        assert!(carry2.is_empty());
    }

    #[test]
    fn strip_dsr_passes_similar_sequences_through() {
        let (clean, count, carry) = strip_dsr(b"", b"\x1b[6m\x1b[0m\x1b[2J");
        assert_eq!(clean, b"\x1b[6m\x1b[0m\x1b[2J");
        assert_eq!(count, 0);
        assert!(carry.is_empty());
    }

    #[test]
    fn strip_dsr_partial_esc_prefix_carries_then_resolves_as_literal() {
        let (clean1, _c1, carry1) = strip_dsr(b"", b"x\x1b[");
        assert_eq!(clean1, b"x");
        assert_eq!(carry1, b"\x1b[");
        let (clean2, count2, carry2) = strip_dsr(&carry1, b"7h");
        assert_eq!(clean2, b"\x1b[7h");
        assert_eq!(count2, 0);
        assert!(carry2.is_empty());
    }

    #[test]
    fn cmd_echo_round_trip() {
        let profile = profiles::resolve("cmd").unwrap();
        let mut p = profile.clone();
        p.args = vec!["/c".into(), "echo termx_alive".into()];
        let s = Session::spawn(&p, None, 80, 25, 1024 * 1024).unwrap();
        let out = collect_output_until_exit(&s);
        assert!(out.contains("termx_alive"), "output was: {out:?}");
        assert_eq!(s.exited().unwrap(), Some(0));
    }

    #[test]
    fn exit_code_is_captured() {
        let profile = profiles::resolve("cmd").unwrap();
        let mut p = profile.clone();
        p.args = vec!["/c".into(), "exit 7".into()];
        let s = Session::spawn(&p, None, 80, 25, 1024 * 1024).unwrap();
        assert!(s.wait_exit_blocking(Duration::from_secs(30)));
        assert_eq!(s.exited().unwrap(), Some(7));
    }

    #[test]
    fn exit_watch_fires() {
        let profile = profiles::resolve("cmd").unwrap();
        let mut p = profile.clone();
        p.args = vec!["/c".into(), "echo done".into()];
        let s = Session::spawn(&p, None, 80, 25, 1024 * 1024).unwrap();
        let rx = s.subscribe_exit();
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while rx.borrow().is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "exit watch never fired"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(rx.borrow().unwrap(), Some(0));
    }

    #[test]
    fn respects_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let profile = profiles::resolve("cmd").unwrap();
        let mut p = profile.clone();
        p.args = vec!["/c".into(), "cd".into()]; // `cd` with no args prints cwd
        let s = Session::spawn(&p, Some(tmp.path()), 80, 25, 1024 * 1024).unwrap();
        let out = collect_output_until_exit(&s);
        let tail = tmp
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(out.contains(&tail), "cwd dir name '{tail}' not in: {out:?}");
    }

    #[test]
    fn dsr_queries_never_reach_ring_or_subscribers() {
        let profile = profiles::resolve("cmd").unwrap();
        let mut p = profile.clone();
        p.args = vec!["/c".into(), "echo clean_stream".into()];
        let s = Session::spawn(&p, None, 80, 25, 1024 * 1024).unwrap();
        let out = collect_output_until_exit(&s);
        assert!(out.contains("clean_stream"), "output: {out:?}");
        assert!(
            !out.contains("\x1b[6n"),
            "ESC[6n must be stripped from the ring"
        );
    }

    #[test]
    fn write_input_drives_an_interactive_shell() {
        let profile = profiles::resolve("cmd").unwrap(); // interactive cmd
        let s = Session::spawn(&profile, None, 80, 25, 1024 * 1024).unwrap();
        let mut rx = s.subscribe();
        s.write_input(b"echo in_band_marker\r\n").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        let mut seen = String::new();
        while std::time::Instant::now() < deadline && !seen.contains("in_band_marker") {
            match rx.try_recv() {
                Ok(chunk) => seen.push_str(&String::from_utf8_lossy(&chunk.data)),
                Err(broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                Err(broadcast::error::TryRecvError::Closed) => break,
            }
        }
        assert!(
            seen.contains("in_band_marker"),
            "echo not observed; saw: {seen:?}"
        );
        s.kill();
        assert!(s.wait_exit_blocking(Duration::from_secs(10)));
    }

    #[test]
    fn kill_terminates_and_reports_exit() {
        let profile = profiles::resolve("cmd").unwrap();
        let s = Session::spawn(&profile, None, 80, 25, 1024 * 1024).unwrap();
        assert!(s.exited().is_none(), "fresh interactive session is alive");
        s.kill();
        assert!(
            s.wait_exit_blocking(Duration::from_secs(10)),
            "killed session must exit"
        );
    }

    #[test]
    fn write_input_errors_after_exit() {
        let profile = profiles::resolve("cmd").unwrap();
        let mut p = profile.clone();
        p.args = vec!["/c".into(), "echo bye".into()];
        let s = Session::spawn(&p, None, 80, 25, 1024 * 1024).unwrap();
        assert!(s.wait_exit_blocking(Duration::from_secs(30)));
        // Writer thread winds down after PTY teardown; allow a beat, then
        // input must fail rather than silently vanish.
        std::thread::sleep(Duration::from_millis(500));
        assert!(s.write_input(b"anyone there?\r\n").is_err());
    }

    // NOTE: the reader's EOF flush of a carried partial-query prefix is NOT
    // testable through a real ConPTY — conhost re-renders child output and
    // swallows incomplete escape sequences, so a child can't plant a partial
    // "\x1b[6" at stream end (verified empirically). The carry mechanics are
    // covered by the strip_dsr unit tests above; the EOF flush itself is a
    // two-line take-and-publish.

    #[test]
    fn oversized_input_frame_is_rejected() {
        let profile = profiles::resolve("cmd").unwrap();
        let s = Session::spawn(&profile, None, 80, 25, 1024 * 1024).unwrap();
        let big = vec![b'x'; MAX_INPUT_FRAME + 1];
        assert!(s.write_input(&big).is_err(), "over-cap frame must error");
        assert!(
            s.write_input(b"echo ok\r\n").is_ok(),
            "normal input still works"
        );
        s.kill();
        assert!(s.wait_exit_blocking(Duration::from_secs(10)));
    }

    #[test]
    fn resize_errors_after_exit() {
        let profile = profiles::resolve("cmd").unwrap();
        let mut p = profile.clone();
        p.args = vec!["/c".into(), "echo bye".into()];
        let s = Session::spawn(&p, None, 80, 25, 1024 * 1024).unwrap();
        assert!(s.wait_exit_blocking(Duration::from_secs(30)));
        assert!(s.resize(120, 40).is_err(), "resize after exit must error");
    }

    #[test]
    fn firehose_stays_bounded_real_pty() {
        let _serial = crate::HEAVY_PTY_TEST.blocking_lock();
        // The spec's memory-soak: a real shell floods output; the ring must
        // stay at/under cap while total stream far exceeds it.
        let cap = 64 * 1024;
        let profile = profiles::resolve("cmd").unwrap();
        let mut p = profile.clone();
        p.args = vec![
            "/c".into(),
            "for /L %i in (1,1,20000) do @echo firehose_line_%i".into(),
        ];
        let s = Session::spawn(&p, None, 120, 40, cap).unwrap();
        assert!(
            s.wait_exit_blocking(Duration::from_secs(240)),
            "firehose shell should finish"
        );
        let (start, bytes) = s.snapshot();
        assert!(
            bytes.len() <= cap,
            "ring exceeded cap: {} > {cap}",
            bytes.len()
        );
        let total = start + bytes.len() as u64;
        assert!(
            total > cap as u64,
            "stream should have exceeded cap (total {total})"
        );
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            text.contains("firehose_line_"),
            "tail of stream should be retained"
        );
    }
}
