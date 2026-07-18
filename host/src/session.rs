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
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
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
    Dsr,
    Data(Vec<u8>),
}

/// Byte writes use a small count-bounded queue. DSR replies use a separate
/// bounded priority queue: a flood cannot grow memory without limit, but a
/// reply is never dropped — a full queue blocks the reader, applying
/// backpressure to ConPTY output until the child drains input.
struct WriterQueues {
    state: Mutex<WriterQueueState>,
    ready: std::sync::Condvar,
    data_space: std::sync::Condvar,
    dsr_space: std::sync::Condvar,
    data_cap: usize,
    dsr_cap: usize,
}

struct WriterQueueState {
    data: std::collections::VecDeque<Vec<u8>>,
    dsr: usize,
    closed: bool,
}

fn record_reader_failure(state: &Mutex<Option<String>>, message: String) {
    tracing::warn!("PTY reader failed: {message}");
    *state.lock().unwrap() = Some(message);
}

fn map_terminate_process_result(
    result: i32,
    error: Option<String>,
) -> std::result::Result<(), String> {
    if result != 0 {
        Ok(())
    } else {
        Err(error.unwrap_or_else(|| "TerminateProcess failed".into()))
    }
}

struct ProcessIdentity(windows_sys::Win32::Foundation::HANDLE);

unsafe impl Send for ProcessIdentity {}
unsafe impl Sync for ProcessIdentity {}

impl ProcessIdentity {
    fn open(pid: Option<u32>) -> Result<Option<Self>> {
        let Some(pid) = pid else {
            return Ok(None);
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        };
        let process = unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid) };
        if process.is_null() {
            return Err(std::io::Error::last_os_error())
                .with_context(|| format!("opening shell process {pid}"));
        }
        Ok(Some(Self(process)))
    }

    fn is_running(&self) -> bool {
        use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        unsafe { WaitForSingleObject(self.0, 0) == WAIT_TIMEOUT }
    }

    fn terminate(&self) -> std::result::Result<(), String> {
        use windows_sys::Win32::System::Threading::TerminateProcess;
        let result = unsafe { TerminateProcess(self.0, 1) };
        let error = (result == 0).then(|| std::io::Error::last_os_error().to_string());
        map_terminate_process_result(result, error)
    }
}

impl Drop for ProcessIdentity {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

fn evaluate_kill_results(
    tree_kill: Option<std::result::Result<bool, String>>,
    direct_kill: std::result::Result<(), String>,
) -> std::result::Result<(), String> {
    match (tree_kill, direct_kill) {
        (Some(Ok(true)), _) | (None, Ok(())) => Ok(()),
        (Some(Ok(false)), Ok(())) => Err("taskkill /T exited unsuccessfully".into()),
        (Some(Err(tree)), Ok(())) => Err(tree),
        (Some(Ok(false)), Err(direct)) => Err(format!(
            "taskkill /T exited unsuccessfully; direct kill failed: {direct}"
        )),
        (Some(Err(tree)), Err(direct)) => Err(format!("{tree}; direct kill failed: {direct}")),
        (None, Err(direct)) => Err(format!("direct kill failed: {direct}")),
    }
}

fn close_pty_and_wait_for_reader(
    close_pty: impl FnOnce(),
    reader_done: std::sync::mpsc::Receiver<()>,
) {
    close_pty();
    if reader_done.recv_timeout(Duration::from_secs(5)).is_err() {
        tracing::warn!("PTY reader did not finish within 5s after ConPTY close");
    }
}

fn answer_dsr_then_publish(
    writer_queues: &WriterQueues,
    queries: usize,
    clean: Vec<u8>,
    publish: impl FnOnce(Vec<u8>),
) {
    for _ in 0..queries {
        // Blocking on a full bounded priority queue is intentional while the
        // writer is alive. During teardown the queue is closed; strip unanswered
        // queries and continue draining ConPTY output through EOF.
        if writer_queues.send_dsr().is_err() {
            break;
        }
    }
    publish(clean);
}

impl WriterQueues {
    fn new(data_cap: usize, dsr_cap: usize) -> Self {
        Self {
            state: Mutex::new(WriterQueueState {
                data: std::collections::VecDeque::new(),
                dsr: 0,
                closed: false,
            }),
            ready: std::sync::Condvar::new(),
            data_space: std::sync::Condvar::new(),
            dsr_space: std::sync::Condvar::new(),
            data_cap: data_cap.max(1),
            dsr_cap: dsr_cap.max(1),
        }
    }

    fn try_send_data(&self, data: Vec<u8>) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            bail!("session exited");
        }
        if state.data.len() >= self.data_cap {
            bail!("input backpressure: session not consuming input");
        }
        state.data.push_back(data);
        self.ready.notify_one();
        Ok(())
    }

    fn send_dsr(&self) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        while !state.closed && state.dsr >= self.dsr_cap {
            state = self.dsr_space.wait(state).unwrap();
        }
        if state.closed {
            bail!("session exited");
        }
        state.dsr += 1;
        self.ready.notify_one();
        Ok(())
    }

    fn recv(&self) -> Option<WriterCmd> {
        let mut state = self.state.lock().unwrap();
        loop {
            if state.dsr > 0 {
                state.dsr -= 1;
                self.dsr_space.notify_one();
                return Some(WriterCmd::Dsr);
            }
            if let Some(data) = state.data.pop_front() {
                self.data_space.notify_one();
                return Some(WriterCmd::Data(data));
            }
            if state.closed {
                return None;
            }
            state = self.ready.wait(state).unwrap();
        }
    }

    fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        state.data.clear();
        state.dsr = 0;
        self.ready.notify_all();
        self.data_space.notify_all();
        self.dsr_space.notify_all();
    }
}

/// None while running; Some(exit_code) after the child exits.
pub type ExitState = Option<Option<u32>>;

pub struct Session {
    ring: Arc<Mutex<RingBuffer>>,
    tx_out: broadcast::Sender<OutputChunk>,
    writer_queues: Arc<WriterQueues>,
    master: Arc<Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>>,
    child_pid: Option<u32>,
    process_identity: Option<Arc<ProcessIdentity>>,
    exit_rx: watch::Receiver<ExitState>,
    reader_error: Arc<Mutex<Option<String>>>,
    kill_error: Arc<Mutex<Option<String>>>,
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
        let process_identity = ProcessIdentity::open(child_pid)?.map(Arc::new);
        let kill_error = Arc::new(Mutex::new(None));
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

        // Writer thread: sleeps until either priority DSR or ordinary client
        // input is ready. Both queues are count-bounded; DSR enqueue blocks
        // instead of dropping a reply, so a malicious query flood backpressures
        // ConPTY output rather than consuming unbounded host memory.
        let writer_queues = Arc::new(WriterQueues::new(256, 256));
        let writer_queues_w = Arc::clone(&writer_queues);
        let writer_queues_r = Arc::clone(&writer_queues);
        std::thread::spawn(move || {
            while let Some(cmd) = writer_queues_w.recv() {
                let result = match cmd {
                    WriterCmd::Dsr => writer.write_all(b"\x1b[1;1R"),
                    WriterCmd::Data(data) => writer.write_all(&data),
                };
                if result.is_err() {
                    writer_queues_w.close();
                    break;
                }
                let _ = writer.flush();
            }
        });

        // Reader thread: sole producer into ring + broadcast; also the DSR
        // answerer (see strip_dsr docs).
        let ring_r = Arc::clone(&ring);
        let tx_r = tx_out.clone();
        let reader_error = Arc::new(Mutex::new(None));
        let reader_error_r = Arc::clone(&reader_error);
        let (reader_done_tx, reader_done_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            struct ReaderDone(std::sync::mpsc::Sender<()>);
            impl Drop for ReaderDone {
                fn drop(&mut self) {
                    let _ = self.0.send(());
                }
            }
            let _reader_done = ReaderDone(reader_done_tx);
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
                    Ok(0) => {
                        // EOF: flush any held-back partial sequence verbatim.
                        let leftover = std::mem::take(&mut carry);
                        publish(leftover);
                        break;
                    }
                    Err(error) => {
                        let leftover = std::mem::take(&mut carry);
                        publish(leftover);
                        record_reader_failure(&reader_error_r, error.to_string());
                        break;
                    }
                    Ok(n) => {
                        let (clean, queries, new_carry) = strip_dsr(&carry, &buf[..n]);
                        carry = new_carry;
                        answer_dsr_then_publish(&writer_queues_r, queries, clean, publish);
                    }
                }
            }
        });

        // Waiter thread: records the exit, releases the slave AND the master
        // (closing ConPTY ends conhost and unblocks the reader at EOF), closes
        // the writer queues so write_input fails fast, then fires the exit watch
        // for all observers.
        let master_w = Arc::clone(&master);
        let writer_queues_wait = Arc::clone(&writer_queues);
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code());
            drop(slave);
            writer_queues_wait.close();
            close_pty_and_wait_for_reader(|| *master_w.lock().unwrap() = None, reader_done_rx);
            let _ = exit_tx.send(Some(code));
        });

        Ok(Session {
            ring,
            tx_out,
            writer_queues,
            master,
            child_pid,
            process_identity,
            exit_rx,
            reader_error,
            kill_error,
        })
    }

    pub fn write_input(&self, data: &[u8]) -> Result<()> {
        if data.len() > MAX_INPUT_FRAME {
            bail!(
                "input frame too large ({} bytes, max {MAX_INPUT_FRAME}); chunk large pastes",
                data.len()
            );
        }
        // Accepted race: while the child is dying but before the waiter closes
        // the queues, a frame may still be accepted. Input to a dying shell is
        // lost either way; once teardown begins, enqueue fails immediately.
        self.writer_queues.try_send_data(data.to_vec())
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

    /// Current end of the output stream (total bytes ever produced) without
    /// copying the ring — for attach horizons when no replay is wanted.
    pub fn stream_end(&self) -> u64 {
        self.ring.lock().unwrap().end_offset()
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
        let process_identity = self.process_identity.as_ref().map(Arc::clone);
        let kill_error = Arc::clone(&self.kill_error);
        std::thread::spawn(move || {
            // The retained process handle pins this exact process identity, so
            // Windows cannot recycle `pid` while taskkill walks the tree.
            if process_identity
                .as_ref()
                .is_some_and(|identity| !identity.is_running())
            {
                return;
            }
            let tree_kill = pid.map(|pid| {
                use std::os::windows::process::CommandExt;
                std::process::Command::new("taskkill")
                    .args(["/T", "/F", "/PID", &pid.to_string()])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    // CREATE_NO_WINDOW: a headless daemon must not flash a
                    // console window on every tab close.
                    .creation_flags(0x0800_0000)
                    .status()
                    .map(|status| status.success())
                    .map_err(|error| format!("taskkill /T failed to start: {error}"))
            });
            let direct_kill = process_identity
                .as_ref()
                .ok_or_else(|| "shell process identity unavailable".to_string())
                .and_then(|identity| identity.terminate());
            if let Err(error) = evaluate_kill_results(tree_kill, direct_kill) {
                tracing::warn!("session process-tree kill failed: {error}");
                *kill_error.lock().unwrap() = Some(error);
            }
        });
    }

    /// OS pid of the shell process (None if the platform didn't report one).
    pub fn pid(&self) -> Option<u32> {
        self.child_pid
    }

    pub fn exited(&self) -> ExitState {
        *self.exit_rx.borrow()
    }

    pub fn reader_error(&self) -> Option<String> {
        self.reader_error.lock().unwrap().clone()
    }

    pub fn kill_error(&self) -> Option<String> {
        self.kill_error.lock().unwrap().clone()
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
    fn direct_kill_api_result_mapping_matches_windows_contract() {
        assert!(map_terminate_process_result(1, None).is_ok());
        assert_eq!(
            map_terminate_process_result(0, Some("access denied".into())).unwrap_err(),
            "access denied"
        );
    }

    #[test]
    fn failed_tree_kill_is_reported() {
        let error = evaluate_kill_results(
            Some(Err("taskkill spawn failed".into())),
            Err("direct kill failed".into()),
        )
        .expect_err("both kill mechanisms failing must be observable");
        assert!(error.contains("taskkill spawn failed"), "{error}");
        assert!(error.contains("direct kill failed"), "{error}");
    }

    #[test]
    fn reader_failures_are_recorded_for_observers() {
        let state = Arc::new(Mutex::new(None));
        record_reader_failure(&state, "synthetic read failure".into());
        assert_eq!(
            state.lock().unwrap().as_deref(),
            Some("synthetic read failure")
        );
    }

    #[test]
    fn teardown_closes_pty_before_waiting_for_reader_drain() {
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let closed_for_reader = Arc::clone(&closed);
        let (done_tx, done_rx) = std::sync::mpsc::sync_channel(0);
        let reader = std::thread::spawn(move || {
            while !closed_for_reader.load(std::sync::atomic::Ordering::SeqCst) {
                std::thread::yield_now();
            }
            done_tx.send(()).unwrap();
        });

        close_pty_and_wait_for_reader(
            || closed.store(true, std::sync::atomic::Ordering::SeqCst),
            done_rx,
        );
        reader.join().unwrap();
        assert!(closed.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn closed_dsr_queue_does_not_discard_visible_output() {
        let queue = WriterQueues::new(1, 1);
        queue.close();
        let (clean, queries, _) = strip_dsr(b"", b"LAST\x1b[6nTAIL");
        assert_eq!(queries, 1);

        let mut published = Vec::new();
        answer_dsr_then_publish(&queue, queries, clean, |bytes| published.extend(bytes));
        answer_dsr_then_publish(&queue, 0, b"AFTER".to_vec(), |bytes| {
            published.extend(bytes)
        });

        assert_eq!(published, b"LASTTAILAFTER");
    }

    #[test]
    fn closing_writer_queue_discards_buffered_input() {
        let queue = WriterQueues::new(2, 2);
        queue.try_send_data(vec![b'a']).unwrap();
        queue.send_dsr().unwrap();

        queue.close();

        assert!(
            queue.recv().is_none(),
            "exited sessions must release queued input immediately"
        );
    }

    #[test]
    fn writer_queue_bounds_dsr_and_prioritizes_replies() {
        let queue = Arc::new(WriterQueues::new(1, 1));
        queue.try_send_data(vec![b'x']).unwrap();
        queue.send_dsr().unwrap();

        let queue_for_sender = Arc::clone(&queue);
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let blocked = std::thread::spawn(move || {
            entered_tx.send(()).unwrap();
            queue_for_sender.send_dsr().unwrap();
        });
        entered_rx.recv().unwrap();
        std::thread::sleep(Duration::from_millis(50));
        assert!(
            !blocked.is_finished(),
            "a full DSR queue must backpressure its producer"
        );

        assert!(matches!(queue.recv(), Some(WriterCmd::Dsr)));
        blocked.join().unwrap();
        assert!(matches!(queue.recv(), Some(WriterCmd::Dsr)));
        assert!(matches!(queue.recv(), Some(WriterCmd::Data(data)) if data == vec![b'x']));
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
        assert_eq!(
            s.reader_error(),
            None,
            "normal ConPTY teardown must not be reported as a reader failure"
        );
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

    /// Is a pid present in tasklist output?
    fn pid_alive(pid: u32) -> bool {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .expect("tasklist");
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    }

    #[test]
    fn kill_reaps_grandchildren_not_just_the_shell() {
        let _serial = crate::HEAVY_PTY_TEST.blocking_lock();
        // The doc-claimed property of the /T tree kill: a process the SHELL
        // spawned (grandchild of the host) must die with the session.
        let profile = profiles::resolve("cmd").unwrap();
        let s = Session::spawn(&profile, None, 80, 25, 1024 * 1024).unwrap();
        let shell_pid = s.pid().expect("shell pid");
        s.write_input(b"ping -n 60 127.0.0.1 >nul\r\n").unwrap();
        // Find the ping grandchild via its parent pid.
        let find_ping = || -> Option<u32> {
            let out = std::process::Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-Command",
                    &format!(
                        "(Get-CimInstance Win32_Process -Filter \"ParentProcessId={shell_pid} and Name='PING.EXE'\").ProcessId"
                    ),
                ])
                .output()
                .ok()?;
            String::from_utf8_lossy(&out.stdout).trim().parse().ok()
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let ping_pid = loop {
            if let Some(pid) = find_ping() {
                break pid;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "ping grandchild never appeared under shell {shell_pid}"
            );
            std::thread::sleep(Duration::from_millis(250));
        };
        assert!(pid_alive(ping_pid), "grandchild should be running");
        s.kill();
        assert!(s.wait_exit_blocking(Duration::from_secs(15)));
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while pid_alive(ping_pid) {
            assert!(
                std::time::Instant::now() < deadline,
                "grandchild ping {ping_pid} survived the tree kill"
            );
            std::thread::sleep(Duration::from_millis(250));
        }
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
