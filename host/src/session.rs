//! One ConPTY-backed shell session. The reader thread is the only place PTY
//! output enters the system: ring buffer first (authoritative, capped), then
//! a bounded broadcast for live listeners. No client/socket state lives here.
//!
//! Lifecycle: a waiter thread owns the PTY slave (see spawn), records the exit
//! code, tears down the master (closing ConPTY so conhost + reader wind down),
//! closes the input channel, and fires `exit_watch` so every observer — any
//! client's forwarder on any connection — learns the session ended.

use crate::history::HistoryWriter;
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

/// Called from the reader thread with each NEW working directory the shell
/// reports (OSC 9;9). Same-cwd reports are deduped before the call.
pub type CwdCallback = Box<dyn Fn(&str) + Send + 'static>;

/// Incremental OSC 9;9 (working-directory report) scanner for the reader
/// thread. The daemon injects the prompt hook that emits these reports
/// (profiles.rs) but used to stream them through to clients without reading
/// its own channel — so a session's recorded cwd was frozen at creation, and
/// a reboot restored panes into the folder they were CREATED in (often none)
/// rather than the one the shell last stood in.
///
/// Chunk-boundary safe: a report split across reads is buffered from its
/// intro to its terminator (BEL or ST). An unterminated "report" longer than
/// `MAX_PENDING` is junk and is dropped rather than buffered forever.
struct CwdScanner {
    /// Unconsumed tail: a partial intro at a chunk edge, or an intro whose
    /// terminator has not arrived yet. Empty when idle.
    pending: Vec<u8>,
    intro: Vec<u8>,
}

impl CwdScanner {
    /// Exactly `ESC ] 9 ; 9 ;` — `9;78;` (the conversation-capture channel)
    /// shares the `ESC ] 9 ;` prefix and must not match.
    const INTRO: &'static [u8] = b"\x1b]9;9;";
    const MAX_PENDING: usize = 4096;

    fn new() -> Self {
        Self::with_intro(Self::INTRO.to_vec())
    }

    fn with_intro(intro: Vec<u8>) -> Self {
        Self { pending: Vec::new(), intro }
    }

    /// Feed the next chunk of (DSR-stripped) pty output. Returns the LAST
    /// complete report's payload, when the chunk completed at least one.
    fn feed(&mut self, chunk: &[u8]) -> Option<String> {
        self.feed_all(chunk).pop()
    }

    fn feed_all(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        let mut reports = Vec::new();
        loop {
            let Some(start) = find_subslice(&self.pending, &self.intro) else {
                // No intro: keep only a tail that could be one split mid-way.
                let keep = partial_suffix_len(&self.pending, &self.intro);
                self.pending.drain(..self.pending.len() - keep);
                return reports;
            };
            let body = start + self.intro.len();
            // Scan for the terminator: BEL, or ST (ESC \). Any other ESC in
            // the payload means this was not a well-formed report — abandon
            // the intro and rescan from the ESC that interrupted it.
            let mut outcome: Option<Result<(usize, usize), usize>> = None;
            let mut j = body;
            while j < self.pending.len() {
                match self.pending[j] {
                    0x07 => {
                        outcome = Some(Ok((j, j + 1)));
                        break;
                    }
                    0x1b => {
                        if j + 1 >= self.pending.len() {
                            break; // ESC at the edge: could be ST, wait
                        }
                        outcome = Some(if self.pending[j + 1] == b'\\' {
                            Ok((j, j + 2))
                        } else {
                            Err(j)
                        });
                        break;
                    }
                    _ => j += 1,
                }
            }
            match outcome {
                Some(Ok((payload_end, seq_end))) => {
                    let payload = &self.pending[body..payload_end];
                    if !payload.is_empty() {
                        if let Ok(path) = std::str::from_utf8(payload) {
                            reports.push(path.to_string());
                        }
                    }
                    self.pending.drain(..seq_end);
                }
                Some(Err(resume_at)) => {
                    // Malformed: drop the broken intro, keep the interrupting
                    // ESC — it may begin a real report.
                    self.pending.drain(..resume_at);
                }
                None => {
                    // Unterminated. Wait for more — unless it can no longer be
                    // a real report, in which case it is junk: drop it.
                    if self.pending.len() - start > Self::MAX_PENDING {
                        self.pending.drain(..body);
                    } else {
                        self.pending.drain(..start);
                        return reports;
                    }
                }
            }
        }
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Length of the longest PROPER prefix of `needle` that ends `buf` — the
/// bytes worth carrying because the rest of the needle may be in the next
/// chunk.
fn partial_suffix_len(buf: &[u8], needle: &[u8]) -> usize {
    let max = needle.len().saturating_sub(1).min(buf.len());
    (1..=max)
        .rev()
        .find(|&keep| buf[buf.len() - keep..] == needle[..keep])
        .unwrap_or(0)
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

/// Does this process have any live descendants? The saved-resume flow asks
/// this to tell "the agent is still sitting in that shell" apart from "the
/// shell is idle at its prompt" (adversarial triage P0 #1): a shell with a
/// child — claude, ssh, an editor — must be reattached untouched, while an
/// idle one can safely be typed into.
///
/// Toolhelp parent links are pids, and pids recycle, so a stale link can name
/// a dead parent. That only ever inflates the answer — and every failure path
/// here answers `true` on purpose: "busy" makes the caller reattach and type
/// nothing, which is exactly today's behavior. The probe must never claim an
/// occupied shell is idle.
fn pid_has_descendants(root: u32) -> bool {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return true;
    }
    let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while ok {
        children
            .entry(entry.th32ParentProcessID)
            .or_default()
            .push(entry.th32ProcessID);
        ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe {
        windows_sys::Win32::Foundation::CloseHandle(snapshot);
    }
    // The shell's DIRECT children answer the question — one level is enough,
    // because a descendant implies a child. (Pid 0 is the idle process, whose
    // "children" row would otherwise make everything look busy.)
    root != 0 && !children.get(&root).map(Vec::is_empty).unwrap_or(true)
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

#[derive(Default)]
struct PromptState {
    token: String,
    ready: u64,
    accepted: u64,
    submissions: std::collections::VecDeque<Submission>,
    partial: bool,
    edited: bool,
    cancelled: bool,
    poisoned: bool,
    reading: bool,
}

enum Submission { Text, Edited, Blank(u64) }

impl PromptState {
    fn new(token: String) -> Self { Self { token, ..Self::default() } }
    fn input(&mut self, data: &[u8]) {
        if data.is_empty() { return; }
        self.reading = false;
        self.cancelled = false;
        // PSReadLine's bracketed paste inserts a single editable buffer. Its
        // embedded newlines are not queued command submissions. Only recognize
        // the complete framing while this reader is known to own the input.
        if self.ready > self.accepted && self.submissions.is_empty() && !self.poisoned
            && data.starts_with(b"\x1b[200~") && data.ends_with(b"\x1b[201~") {
            let body = &data[6..data.len() - 6];
            if !body.contains(&0x1b) && !body.contains(&0) {
                self.edited = true; self.partial = true; return;
            }
        }
        // Normal readline navigation edits a line but never accepts it. Keep
        // tracking its eventual Enter rather than disabling this shell forever.
        if matches!(data, b"\x1b[A" | b"\x1b[B" | b"\x1b[C" | b"\x1b[D" | b"\x1b[H" | b"\x1b[F" | b"\x1b[3~") {
            self.edited = true; self.partial = true; return;
        }
        for &byte in data {
            self.cancelled = false;
            match byte {
                b'\r' | b'\n' => {
                    if self.submissions.len() >= 1024 { self.poisoned = true; }
                    else {
                        self.submissions.push_back(if self.edited { Submission::Edited }
                            else if self.partial { Submission::Text }
                            else { Submission::Blank(if self.ready > self.accepted { self.ready } else { 0 }) });
                    }
                    self.partial = false; self.edited = false;
                }
                3 => { self.cancelled = true; self.partial = true; self.edited = true; }
                8 | 9 | 127 => { self.edited = true; self.partial = true; }
                0..=31 => { self.poisoned = true; self.partial = true; }
                _ => self.partial = true,
            }
        }
    }
    fn marker(&mut self, payload: &str) {
        let mut parts = payload.split(';');
        let kind = parts.next().unwrap_or_default();
        let sequence = parts.next().unwrap_or_default();
        let empty = parts.next() == Some("E");
        let Ok(sequence) = sequence.parse::<u64>() else { self.poisoned = true; return; };
        if kind == "R" && self.cancelled && self.submissions.is_empty()
            && self.ready.checked_add(1) == Some(sequence) {
            self.accepted = self.ready;
            self.partial = false; self.edited = false; self.cancelled = false;
        }
        match kind {
            "R" if sequence > 0 && self.accepted.checked_add(1) == Some(sequence)
                && self.ready == self.accepted => {
                self.ready = sequence;
                self.reading = true;
            }
            "A" if sequence == self.ready && sequence > self.accepted => {
                self.accepted = sequence;
                self.reading = false;
                // A clean blank submitted at this observed read generation can
                // reconcile earlier nonblank input consumed by Read-Host. The
                // hook confirms the actual returned command was blank; no old
                // blank/edited submission or later input may impersonate it.
                let blank_recovery = empty && !self.partial
                    && matches!(self.submissions.back(), Some(Submission::Blank(generation)) if *generation == sequence)
                    && self.submissions.iter().take(self.submissions.len().saturating_sub(1))
                        .all(|submission| matches!(submission, Submission::Text));
                if blank_recovery { self.submissions.clear(); }
                else if self.submissions.pop_front().is_none() && !self.cancelled { self.poisoned = true; }
            }
            // Replay/redraw of an already-seen marker cannot clear input.
            "R" if sequence == self.ready => {}
            _ => self.poisoned = true,
        }
    }
    fn identity(&self) -> Option<String> {
        (self.reading && !self.poisoned && !self.partial && self.submissions.is_empty() && self.ready > 0)
            .then(|| format!("{}:{}", self.token, self.ready))
    }
}

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
    prompt: Arc<Mutex<PromptState>>,
    directory_supported: bool,
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

    /// `spawn` plus a disk-spill sink for ring-evicted bytes (`None` keeps the
    /// old behavior exactly: evicted bytes are gone and nothing is written)
    /// and an observer for the shell's own cwd reports (`None`: not watched).
    pub fn spawn_with_history(
        profile: &Profile,
        cwd: Option<&Path>,
        cols: u16,
        rows: u16,
        ring_cap: usize,
        history: Option<HistoryWriter>,
        on_cwd: Option<CwdCallback>,
    ) -> Result<Session> {
        Self::spawn_inner(profile, cwd, cols, rows, ring_cap, 256, history, on_cwd)
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
        Self::spawn_inner(profile, cwd, cols, rows, ring_cap, broadcast_cap, None, None)
    }

    #[allow(clippy::too_many_arguments)] // spawn inputs are intentionally explicit
    fn spawn_inner(
        profile: &Profile,
        cwd: Option<&Path>,
        cols: u16,
        rows: u16,
        ring_cap: usize,
        broadcast_cap: usize,
        history: Option<HistoryWriter>,
        on_cwd: Option<CwdCallback>,
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
        for (key, value) in &profile.env {
            cmd.env(key, value);
        }
        let prompt_token = format!("{:032x}", rand::random::<u128>());
        cmd.env("TERMX_PROMPT_TOKEN", &prompt_token);
        let directory_supported = profile.args.iter().any(|arg| arg.contains("function global:PSConsoleHostReadLine"));
        let prompt = Arc::new(Mutex::new(PromptState::new(prompt_token.clone())));
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
        let prompt_r = Arc::clone(&prompt);
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
            // cwd watching is observation only: it reads the same cleaned
            // bytes the ring gets, never alters them, and dedupes so the
            // registry hears only actual directory CHANGES.
            let mut cwd_scanner = on_cwd.as_ref().map(|_| CwdScanner::new());
            let mut last_cwd: Option<String> = None;
            let mut prompt_scanner = CwdScanner::with_intro(format!("\x1b]9;79;{prompt_token};").into_bytes());
            // RefCell, not a captured `mut`: `publish` is handed to
            // `answer_dsr_then_publish` by value on every read, which requires
            // it to stay Copy — so its spill state is borrowed, not owned.
            let history = std::cell::RefCell::new(history);
            let publish = |bytes: Vec<u8>| {
                if bytes.is_empty() {
                    return;
                }
                let mut writer = history.borrow_mut();
                let mut evicted = Vec::new();
                let mut ring = ring_r.lock().unwrap();
                let offset = ring.end_offset();
                ring.push_evicting(&bytes, writer.as_ref().map(|_| &mut evicted));
                drop(ring);
                if let Some(spill) = writer.as_mut() {
                    if let Err(error) = spill.append(&evicted) {
                        // Losing old scrollback must never cost live output, and
                        // a failing disk must not log on every read: retire the
                        // writer after the first failure.
                        tracing::warn!("scrollback history disabled after failure: {error:#}");
                        *writer = None;
                    }
                }
                drop(writer);
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
                        let markers = prompt_scanner.feed_all(&clean);
                        if !markers.is_empty() {
                            let mut state = prompt_r.lock().unwrap();
                            for marker in markers { state.marker(&marker); }
                        }
                        if let (Some(scanner), Some(report)) =
                            (cwd_scanner.as_mut(), on_cwd.as_ref())
                        {
                            if let Some(path) = scanner.feed(&clean) {
                                if last_cwd.as_deref() != Some(path.as_str()) {
                                    report(&path);
                                    last_cwd = Some(path);
                                }
                            }
                        }
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
            prompt,
            directory_supported,
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
        let mut prompt = self.prompt.lock().unwrap();
        prompt.input(data);
        self.writer_queues.try_send_data(data.to_vec())
    }

    pub fn prompt_status(&self) -> (Option<bool>, Option<String>) {
        if !self.directory_supported { return (None, None); }
        let id = if self.exited().is_none() { self.prompt.lock().unwrap().identity() } else { None };
        (Some(id.is_some()), id)
    }

    /// Guard verification and enqueue share the same lock as every ordinary
    /// terminal input write. The prompt identity is consumed exactly once.
    pub fn change_directory(&self, expected_pid: u32, prompt_id: &str, cwd: &str) -> bool {
        if !self.directory_supported || self.child_pid != Some(expected_pid)
            || cwd.is_empty() || cwd.len() > 24 * 1024 || cwd.chars().any(char::is_control)
            || !Path::new(cwd).is_absolute() || !Path::new(cwd).is_dir() { return false; }
        let command = format!("Microsoft.PowerShell.Management\\Set-Location -LiteralPath '{}'\r", cwd.replace('\'', "''"));
        let mut prompt = self.prompt.lock().unwrap();
        if prompt.identity().as_deref() != Some(prompt_id)
            || self.process_identity.as_ref().is_none_or(|process| !process.is_running())
            || self.has_child_processes() { return false; }
        prompt.input(command.as_bytes());
        self.writer_queues.try_send_data(command.into_bytes()).is_ok()
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

    /// True when something is running INSIDE the shell — an agent, an ssh, an
    /// editor. Unknown always answers busy: the caller's safe move is to
    /// reattach and type nothing.
    pub fn has_child_processes(&self) -> bool {
        match self.child_pid {
            Some(pid) => pid_has_descendants(pid),
            None => true,
        }
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
    #[test]
    fn prompt_guard_tracks_acceptance_and_never_reuses_a_dirty_prompt() {
        let mut prompt = super::PromptState::new("secret".into());
        prompt.marker("R;1");
        assert_eq!(prompt.identity().as_deref(), Some("secret:1"));
        prompt.input(b"Start-Sleep 10\r");
        assert_eq!(prompt.identity(), None);
        prompt.marker("A;1");
        assert_eq!(prompt.identity(), None, "accepted command may be an in-process builtin");
        prompt.marker("R;2");
        assert_eq!(prompt.identity().as_deref(), Some("secret:2"));
        prompt.input(b"Read-Host");
        prompt.marker("R;2");
        assert_eq!(prompt.identity(), None, "a repeated marker cannot erase unfinished input");
    }

    #[test]
    fn prompt_guard_does_not_credit_early_or_multiple_queued_commands_as_idle() {
        let mut prompt = super::PromptState::new("secret".into());
        prompt.input(b"Start-Sleep 1\rRead-Host\r");
        prompt.marker("R;1");
        assert_eq!(prompt.identity(), None);
        prompt.marker("A;1");
        prompt.marker("R;2");
        assert_eq!(prompt.identity(), None, "a second queued command is still pending");
        prompt.marker("A;2");
        assert_eq!(prompt.identity(), None);
        prompt.marker("R;3");
        assert_eq!(prompt.identity().as_deref(), Some("secret:3"));
    }

    #[test]
    fn prompt_guard_refuses_unknown_control_input_and_unmatched_markers() {
        for input in [b"\x00".as_slice(), b"\x04", b"\x1b[unknown"] {
            let mut prompt = super::PromptState::new("secret".into());
            prompt.marker("R;1");
            prompt.input(input);
            prompt.marker("A;1");
            prompt.marker("R;2");
            assert_eq!(prompt.identity(), None);
        }
        let mut prompt = super::PromptState::new("secret".into());
        prompt.marker("R;2");
        assert_eq!(prompt.identity(), None);
    }

    #[test]
    fn prompt_guard_recovers_from_history_edits_and_explicit_cancel_at_a_fresh_prompt() {
        let mut prompt = super::PromptState::new("secret".into());
        prompt.marker("R;1");
        prompt.input(b"\x1b[A");
        assert_eq!(prompt.identity(), None);
        prompt.input(b"\r");
        prompt.marker("A;1;T");
        prompt.marker("R;2");
        assert_eq!(prompt.identity().as_deref(), Some("secret:2"));
        prompt.input(b"claude\r");
        prompt.marker("A;2;T");
        prompt.input(b"\x03");
        assert_eq!(prompt.identity(), None);
        prompt.marker("R;3");
        assert_eq!(prompt.identity().as_deref(), Some("secret:3"));
        prompt.input(b"\x1b[200~Write-Output one\nWrite-Output two\x1b[201~");
        assert_eq!(prompt.identity(), None);
        prompt.input(b"\r"); prompt.marker("A;3;T"); prompt.marker("R;4");
        assert_eq!(prompt.identity().as_deref(), Some("secret:4"));
    }

    #[test]
    fn prompt_guard_blank_recovery_cannot_skip_queued_blank_or_later_input() {
        let mut prompt = super::PromptState::new("secret".into());
        prompt.marker("R;1");
        prompt.input(b"Read-Host\r"); prompt.marker("A;1;T");
        prompt.input(b"answer\r"); prompt.marker("R;2");
        assert_eq!(prompt.identity(), None);
        prompt.input(b"\r"); prompt.marker("A;2;E"); prompt.marker("R;3");
        assert_eq!(prompt.identity().as_deref(), Some("secret:3"));
        let mut prompt = super::PromptState::new("secret".into());
        prompt.input(b"\rRead-Host\r"); prompt.marker("R;1");
        prompt.input(b"\r"); prompt.marker("A;1;E"); prompt.marker("R;2");
        assert_eq!(prompt.identity(), None, "an earlier blank cannot acknowledge the recovery Enter");
    }

    #[test]
    fn prompt_guard_changes_directory_once_and_refuses_running_powershell_builtins() {
        let _serial = crate::HEAVY_PTY_TEST.blocking_lock();
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("folder with ' and [brackets]");
        std::fs::create_dir(&target).unwrap();
        let current = Arc::new(Mutex::new(String::new()));
        let observed = Arc::clone(&current);
        let profile = profiles::resolve("powershell", true).unwrap();
        let s = Session::spawn_with_history(&profile, Some(tmp.path()), 120, 30, 1024 * 1024,
            None, Some(Box::new(move |cwd| *observed.lock().unwrap() = cwd.to_string()))).unwrap();
        fn wait_prompt(s: &Session, after: u64) -> String {
            let deadline = std::time::Instant::now() + Duration::from_secs(25);
            loop {
                if s.prompt.lock().unwrap().ready > after {
                    if let Some(id) = s.prompt_status().1 { return id; }
                }
                assert!(std::time::Instant::now() < deadline,
                    "no trusted prompt; output: {}", String::from_utf8_lossy(&s.snapshot().1));
                std::thread::sleep(Duration::from_millis(30));
            }
        }
        let first = wait_prompt(&s, 0);
        assert!(!s.change_directory(s.pid().unwrap().wrapping_add(1), &first, &target.to_string_lossy()));
        assert!(s.change_directory(s.pid().unwrap(), &first, &target.to_string_lossy()));
        assert!(!s.change_directory(s.pid().unwrap(), &first, &target.to_string_lossy()));
        let second = wait_prompt(&s, 1);
        assert_eq!(*current.lock().unwrap(), target.to_string_lossy());
        s.write_input(b"Start-Sleep -Milliseconds 800\r").unwrap();
        assert!(!s.has_child_processes(), "the builtin is invisible to the child-process probe");
        assert!(!s.change_directory(s.pid().unwrap(), &second, &tmp.path().to_string_lossy()));
        let third = wait_prompt(&s, 2);
        s.write_input(b"Read-Host -Prompt 'TermX read host safety'\r").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while s.prompt.lock().unwrap().accepted < 3 {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(30));
        }
        assert!(!s.has_child_processes());
        assert!(!s.change_directory(s.pid().unwrap(), &third, &tmp.path().to_string_lossy()));
        assert!(s.exited().is_none(), "refusing must leave the original shell running");
        s.write_input(b"answer\r").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while s.prompt.lock().unwrap().ready < 4 {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(30));
        }
        assert_eq!(s.prompt_status().1, None, "builtin-consumed input must not be guessed away");
        s.write_input(b"\r").unwrap();
        wait_prompt(&s, 4);
        // Real history navigation edits the buffer; Enter then a fresh prompt
        // must restore the chooser rather than poison this session permanently.
        s.write_input(b"Write-Output termx_history_recovery\r").unwrap();
        wait_prompt(&s, 5);
        s.write_input(b"\x1b[A").unwrap();
        s.write_input(b"\r").unwrap();
        wait_prompt(&s, 6);
        s.write_input(b"Start-Sleep -Seconds 3\r").unwrap();
        std::thread::sleep(Duration::from_millis(150));
        s.write_input(b"\x03").unwrap();
        wait_prompt(&s, 7);
        assert!(s.exited().is_none());
        s.write_input(b"exit\r").unwrap();
        assert!(s.wait_exit_blocking(Duration::from_secs(20)));
    }

    #[test]
    fn prompt_scanner_keeps_all_ready_and_accepted_markers_in_stream_order() {
        let mut scanner = super::CwdScanner::with_intro(b"\x1b]9;79;secret;".to_vec());
        assert!(scanner.feed_all(b"\x1b]9;79;sec").is_empty());
        assert_eq!(scanner.feed_all(b"ret;R;1\x1b\\noise\x1b]9;79;secret;A;1\x07\x1b]9;79;secret;R;2\x1b\\"),
            vec!["R;1", "A;1", "R;2"]);
    }

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
    fn cwd_scanner_reads_bel_and_st_terminated_reports() {
        let mut scanner = CwdScanner::new();
        assert_eq!(
            scanner.feed(b"junk\x1b]9;9;C:\\Dev\x07more"),
            Some("C:\\Dev".to_string())
        );
        assert_eq!(
            scanner.feed(b"\x1b]9;9;/root/app\x1b\\tail"),
            Some("/root/app".to_string())
        );
    }

    #[test]
    fn cwd_scanner_survives_any_chunk_split() {
        // A report can split ANYWHERE: mid-intro, mid-payload, mid-ST.
        let full = b"prompt\x1b]9;9;C:\\Users\\mjfos\\code\x1b\\after";
        for cut in 1..full.len() {
            let mut scanner = CwdScanner::new();
            let first = scanner.feed(&full[..cut]);
            let second = scanner.feed(&full[cut..]);
            assert_eq!(
                first.or(second).as_deref(),
                Some("C:\\Users\\mjfos\\code"),
                "lost the report when split at byte {cut}"
            );
        }
    }

    #[test]
    fn cwd_scanner_takes_the_last_report_and_ignores_other_osc9_channels() {
        let mut scanner = CwdScanner::new();
        // 9;78 is the conversation-capture channel — same prefix, not a cwd.
        let out = scanner.feed(
            b"\x1b]9;9;C:\\one\x07\x1b]9;78;claude;abc\x07\x1b]9;9;C:\\two\x07",
        );
        assert_eq!(out, Some("C:\\two".to_string()));
    }

    #[test]
    fn cwd_scanner_drops_malformed_and_oversized_reports() {
        let mut scanner = CwdScanner::new();
        // An ESC that is not ST inside the payload: not a real report — and
        // the interrupting ESC may begin a real one, which must still parse.
        assert_eq!(
            scanner.feed(b"\x1b]9;9;bro\x1b[2Jken\x1b]9;9;C:\\ok\x07"),
            Some("C:\\ok".to_string())
        );
        // A never-terminated "report" must not buffer forever.
        let mut scanner = CwdScanner::new();
        assert_eq!(scanner.feed(b"\x1b]9;9;"), None);
        for _ in 0..10 {
            assert_eq!(scanner.feed(&[b'x'; 1024]), None);
        }
        assert!(
            scanner.pending.len() <= CwdScanner::MAX_PENDING + CwdScanner::INTRO.len(),
            "pending grew unbounded: {}",
            scanner.pending.len()
        );
        // And a real report after the junk still lands.
        assert_eq!(
            scanner.feed(b"\x07\x1b]9;9;C:\\after\x07"),
            Some("C:\\after".to_string())
        );
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
        let profile = profiles::resolve("cmd", false).unwrap();
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
        let profile = profiles::resolve("cmd", false).unwrap();
        let mut p = profile.clone();
        p.args = vec!["/c".into(), "exit 7".into()];
        let s = Session::spawn(&p, None, 80, 25, 1024 * 1024).unwrap();
        assert!(s.wait_exit_blocking(Duration::from_secs(30)));
        assert_eq!(s.exited().unwrap(), Some(7));
    }

    #[test]
    fn exit_watch_fires() {
        let profile = profiles::resolve("cmd", false).unwrap();
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
        let profile = profiles::resolve("cmd", false).unwrap();
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
        let profile = profiles::resolve("cmd", false).unwrap();
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
        let profile = profiles::resolve("cmd", false).unwrap(); // interactive cmd
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

    /// Every complete OSC 9;9 payload in `text` (ST- or BEL-terminated). A
    /// trailing partial sequence is ignored so a caller can keep pumping.
    fn osc9_cwd_reports(text: &str) -> Vec<String> {
        const INTRO: &str = "\x1b]9;9;";
        let mut reports = Vec::new();
        let mut rest = text;
        while let Some(start) = rest.find(INTRO) {
            let payload = &rest[start + INTRO.len()..];
            let Some(end) = payload
                .find("\x1b\\")
                .or_else(|| payload.find('\x07'))
                .or_else(|| payload.find("\u{9c}"))
            else {
                break;
            };
            reports.push(payload[..end].trim_matches('"').to_string());
            rest = &payload[end..];
        }
        reports
    }

    /// True when some report is an absolute path whose last segment is `name`.
    fn reported_dir(reports: &[String], name: &str) -> bool {
        reports.iter().any(|path| {
            let path = Path::new(path);
            path.is_absolute()
                && path
                    .file_name()
                    .is_some_and(|last| last.eq_ignore_ascii_case(name))
        })
    }

    /// Drain live output until `pred` holds over everything seen so far, or the
    /// bound expires. Polls the broadcast rather than sleeping a fixed guess.
    fn pump_until(
        rx: &mut broadcast::Receiver<OutputChunk>,
        seen: &mut String,
        secs: u64,
        pred: impl Fn(&str) -> bool,
    ) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(secs);
        loop {
            if pred(seen) {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            match rx.try_recv() {
                Ok(chunk) => seen.push_str(&String::from_utf8_lossy(&chunk.data)),
                Err(broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                Err(broadcast::error::TryRecvError::Closed) => return pred(seen),
            }
        }
    }

    /// Real-shell contract behind F1 cwd tracking: the injected prompt hook must
    /// put an OSC 9;9 report with an ABSOLUTE path on the wire at the first
    /// prompt and again after a `cd` — through ConPTY, which re-renders child
    /// output and is the reason this can only be proven by spawning.
    fn shell_integration_follows_cd(profile_name: &str, ready_secs: u64) {
        let _serial = crate::HEAVY_PTY_TEST.blocking_lock();
        let tmp = tempfile::tempdir().unwrap();
        let child = tmp.path().join("termx_parent").join("termx_child");
        std::fs::create_dir_all(&child).unwrap();

        let profile = profiles::resolve(profile_name, true).unwrap();
        let s = Session::spawn(&profile, Some(&child), 120, 30, 1024 * 1024).unwrap();
        let mut rx = s.subscribe();
        let mut seen = String::new();

        let saw_spawn_cwd = pump_until(&mut rx, &mut seen, ready_secs, |text| {
            reported_dir(&osc9_cwd_reports(text), "termx_child")
        });
        assert!(
            saw_spawn_cwd,
            "{profile_name}: no OSC 9;9 report for the spawn cwd.\nreports={:?}\nraw={seen:?}",
            osc9_cwd_reports(&seen)
        );

        // Only now is the shell known to be at a prompt, so the CD cannot race
        // shell startup.
        s.write_input(b"cd ..\r").unwrap();
        let followed_cd = pump_until(&mut rx, &mut seen, 60, |text| {
            reported_dir(&osc9_cwd_reports(text), "termx_parent")
        });
        assert!(
            followed_cd,
            "{profile_name}: prompt hook did not report the new cwd after `cd ..`.\nreports={:?}\nraw={seen:?}",
            osc9_cwd_reports(&seen)
        );

        s.kill();
        assert!(s.wait_exit_blocking(Duration::from_secs(15)));
    }

    #[test]
    fn powershell_shell_integration_reports_cwd_and_follows_cd() {
        // PowerShell 5.1 startup (profile load + JIT) is the slow part here.
        shell_integration_follows_cd("powershell", 120);
    }

    #[test]
    fn cmd_shell_integration_reports_cwd_and_follows_cd() {
        shell_integration_follows_cd("cmd", 60);
    }

    #[test]
    fn shell_integration_off_emits_no_cwd_reports() {
        let _serial = crate::HEAVY_PTY_TEST.blocking_lock();
        let profile = profiles::resolve("cmd", false).unwrap();
        let s = Session::spawn(&profile, None, 120, 30, 1024 * 1024).unwrap();
        let mut rx = s.subscribe();
        let mut seen = String::new();
        s.write_input(b"echo integration_off_marker\r").unwrap();
        assert!(
            pump_until(&mut rx, &mut seen, 60, |text| text
                .contains("integration_off_marker")),
            "shell never echoed; saw: {seen:?}"
        );
        assert!(
            osc9_cwd_reports(&seen).is_empty(),
            "integration off must stay byte-identical to the old behavior; got {:?}",
            osc9_cwd_reports(&seen)
        );
        s.kill();
        assert!(s.wait_exit_blocking(Duration::from_secs(15)));
    }

    #[test]
    fn osc9_reports_are_extracted_for_both_terminators_and_quoted_paths() {
        assert_eq!(
            osc9_cwd_reports("noise\x1b]9;9;C:\\a\x1b\\more\x1b]9;9;\"C:\\b c\"\x07tail"),
            vec![r"C:\a".to_string(), r"C:\b c".to_string()]
        );
        assert!(
            osc9_cwd_reports("\x1b]9;9;C:\\partial").is_empty(),
            "an unterminated tail is not yet a report"
        );
    }

    /// Is a pid present in tasklist output?
    fn pid_alive(pid: u32) -> bool {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .expect("tasklist");
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    }

    /// The property the saved-resume probe stands on: an idle shell reports
    /// no children, and a shell with something running inside it reports busy.
    /// If a bare cmd under ConPTY ever carries a permanent child, the probe
    /// silently degrades to always-busy (= always reattach), and this test is
    /// the tripwire that says so.
    #[test]
    fn busy_probe_tells_an_idle_shell_from_an_occupied_one() {
        let _serial = crate::HEAVY_PTY_TEST.blocking_lock();
        let profile = profiles::resolve("cmd", false).unwrap();
        let s = Session::spawn(&profile, None, 80, 25, 1024 * 1024).unwrap();
        // Idle: wait out shell startup, which may hold transient children.
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while s.has_child_processes() {
            assert!(
                std::time::Instant::now() < deadline,
                "an idle shell never reported zero children — the probe design is void"
            );
            std::thread::sleep(Duration::from_millis(250));
        }
        // Occupied: a long-running child must flip the answer.
        s.write_input(b"ping -n 60 127.0.0.1 >nul\r\n").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while !s.has_child_processes() {
            assert!(
                std::time::Instant::now() < deadline,
                "a shell running ping never reported busy"
            );
            std::thread::sleep(Duration::from_millis(250));
        }
        s.kill();
        assert!(s.wait_exit_blocking(Duration::from_secs(15)));
    }

    #[test]
    fn kill_reaps_grandchildren_not_just_the_shell() {
        let _serial = crate::HEAVY_PTY_TEST.blocking_lock();
        // The doc-claimed property of the /T tree kill: a process the SHELL
        // spawned (grandchild of the host) must die with the session.
        let profile = profiles::resolve("cmd", false).unwrap();
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
        let profile = profiles::resolve("cmd", false).unwrap();
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
        let profile = profiles::resolve("cmd", false).unwrap();
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
        let profile = profiles::resolve("cmd", false).unwrap();
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
        let profile = profiles::resolve("cmd", false).unwrap();
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
        let profile = profiles::resolve("cmd", false).unwrap();
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
