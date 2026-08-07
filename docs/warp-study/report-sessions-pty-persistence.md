# Warp Terminal — Session Lifecycle, PTY, Persistence & Resilience
### Agent study report (Opus, 2026-08-07) · verbatim archive · source: C:\Dev\warp-study

## 0. LICENSING (read first)

`Cargo.toml:26` sets `license = "AGPL-3.0-only"` for the whole workspace via `license.workspace = true`.

- **MIT (safe to reference closely):** `crates/warpui` and `crates/warpui_core` ONLY (the GPUI-like UI framework). Confirmed `README.md:56-58`.
- **AGPL-3.0-only (concepts only, no code copying):** everything else, including all crates relevant to this study — `app/` (terminal, PTY, persistence, blocks), `crates/persistence`, `crates/local_control`, `crates/websocket`, `crates/ipc`, `crates/prevent_sleep`, `crates/warp_terminal`, `crates/remote_server`.

Two third-party carve-outs cover the most TermX-relevant material and are independently obtainable under permissive terms:

- `app/src/terminal/local_tty/mod.rs:1-2` — the PTY event-loop and `EventedPty`/`EventedReadWrite` traits are adapted from **alacritty_terminal under Apache-2.0** (`crates/warp_terminal/src/model/LICENSE-ALACRITTY`). Take that design from Alacritty upstream.
- `app/src/terminal/local_tty/windows/pipes.rs:1-6` — async anonymous-pipe creation is adapted from **Microsoft Windows Terminal under MIT** (`app/assets/windows/LICENSE-WINDOWS-TERMINAL`). Take it from the MIT upstream.

## 1. Process model — Warp is NOT a daemon/client split

**Warp is one process; the GUI owns every PTY directly.** No persistent host daemon, no detach/reattach, no tmux-like session survival.

There IS a subprocess called a "terminal server" — it is not a daemon:
- `app/src/terminal/local_tty/server/mod.rs:1-19` — purpose is **fork hygiene**: spawn a helper before the app opens GPU handles/sockets/fonts so fork/exec can't leak fds into the user's shell.
- **Unix-only** (`local_tty/mod.rs:10-11`). Windows has no equivalent.
- `server/mod.rs:214-220` — `Drop` kills and reaps it; dies with the app.
- `server/mod.rs:108-118` — PTY fds passed back over `SCM_RIGHTS` so the app talks to the PTY directly. A spawner, not an owner.
- Told its expected parent PID so it self-terminates if reparented (`server/mod.rs:186-188`).

**Who owns PTYs:** `TerminalManager<S>` (`app/src/terminal/local_tty/terminal_manager.rs`), one per pane, with a dedicated `"PTY reader"` OS thread (`local_tty/event_loop.rs:327-329`), mio-polled.

**Window close vs app quit — both kill shells:**
- Pane close: `TerminalManager::drop` → `shutdown_event_loop()` → sends `Message::Shutdown` and joins the thread; event loop exit calls `self.pty.kill()` (`event_loop.rs:482-488`).
- App quit (`on_will_terminate`, `app/src/lib.rs:2624-2684`) ordering: notebooks flushed → persistence writer terminated and joined → LSP servers → PtySpawner prep → Windows-only `shutdown_all_pty_event_loops`.
- Comment at `lib.rs:2649-2653`: PTY teardown must come AFTER persistence shutdown "so we don't keep track of the fact that the shell sessions terminated" — clean quit is recorded as a live session and restores as one.

**Implication for TermX:** no prior art for daemon-owned session survival; TermX's model is strictly more ambitious. Warp's contribution is "how to make a restart feel seamless without a daemon" (§3).

## 2. ConPTY / Windows PTY — the richest vein for TermX

`app/src/terminal/local_tty/windows/` is ~1,200 lines of hard-won Windows knowledge.

### They ship their own ConPTY
`windows/conpty_api.rs:54-118` — `LoadLibraryW("conpty.dll")` + `GetProcAddress` for five entry points. `ConptyShowHidePseudoConsole` and `ConptyReleasePseudoConsole` are OpenConsole-only exports (not in kernel32). `app/assets/windows/{x64,arm64}/` bundles `conpty.dll` + `OpenConsole.exe` (MIT from Windows Terminal). Decouples from the user's Windows build.

### Pipe creation below Win32
`windows/pipes.rs` — opens `\Device\NamedPipe\` once via `NtCreateFile`, then creates unnamed **overlapped/async, bidirectional, byte-stream** pipe pairs via `ntdll!NtCreateNamedPipeFile` (128 KB buffers). Win32 `CreatePipe` cannot produce an async pipe; mio needs one.

### Spawn sequence (`windows/mod.rs:164-273`)
1. Load ConPTY, build env block. 2. Duplex async pipe. 3. `CreatePseudoConsole(size, client, client, 0)` — same handle both directions; caller's copy freed immediately. 4. `ShowHidePseudoConsole(hpc, true)`. 5. `STARTUPINFOEXW` + `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`. 6. `CreateProcessW` with `bInheritHandles=false`, `EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_BREAKAWAY_FROM_JOB`. 7. **`ReleasePseudoConsole` immediately after spawn** so a later Close doesn't block. 8. Wrap server end as `mio::windows::NamedPipe`; attach `ChildExitWatcher`.

`start_dir` falls back to `%USERPROFILE%`, both `is_dir()`-checked — a stale cwd never fails the spawn. Command-line quoting hand-rolled per "Everyone quotes command line arguments the wrong way"; embedded NUL rejected.

### Child-exit notification without polling
`windows/child.rs` — `RegisterWaitForSingleObject` on the process handle (`WT_EXECUTEINWAITTHREAD | WT_EXECUTEONLYONCE`); callback re-`Box::from_raw`s context first so it can't leak; `Drop` calls `UnregisterWait`. Windows analogue of SIGCHLD.

### Shutdown ordering — the part people get wrong
`close_pseudoconsole()` (`windows/mod.rs:426-453`), idempotent, in order: 1. `ClosePseudoConsole(hpc)`. 2. **Drain the pipe to EOF** — skip this and the console host blocks flushing and never exits. 3. `pipe.disconnect()`.

`PseudoConsoleChild::kill` terminates only the root shell (closing the pseudoconsole ends the session and the host kills attached clients — mirrors Windows Terminal's `ConptyConnection::Close()`); `WaitForSingleObject` with a 1000 ms budget, timeout reported not hung. `Drop` closes both `hProcess` AND `hThread` (classic leak). `shutdown_all_pty_event_loops` runs **only on Windows** at quit: "needed to ensure all OpenConsole processes are cleaned up before the main thread exits."

**TermX action item:** if termx-host exits without joining every PTY event loop and draining every pipe, you accumulate orphaned OpenConsole processes across restarts.

### ConPTY correctness tripwire
Private `OSC 9279` "reset grid" marker emitted by the shell bootstrap around each prompt cycle; on Windows debug builds a `debug_assert!` fires if printable output arrives before the marker — catches model/ConPTY grid desync in dev (`app/src/terminal/model/ansi/mod.rs:56`, `grid/ansi_handler.rs:150-196, 1278-1289`).

## 3. Persistence & restore — "restore" means replaying bytes into a fresh shell

**Storage:** SQLite via Diesel, bundled SQLite, migrations embedded and run at startup in a transaction. 139 dated migration dirs, mostly single-column additive.

**Location:** `warp.sqlite` under `secure_state_dir()`. **Three separate DB files** keyed by `PersistenceScope` (`App`, `Tui`, `RemoteServerDaemon`) — a newer binary must never migrate a shared DB under an older one; version skew sidestepped by file separation (`paths.rs:297-308`).

**Serialized:** full window→tab→pane-split tree, plus a `blocks` table holding per block: `stylized_command`/`stylized_output` **as raw bytes with ANSI escapes intact**, exit_code, pwd, git head/branch, virtualenv/conda, timestamps, ps1, shell/user/host. History in a separate `commands` table. **Not persisted:** env vars (restore passes empty map); secrets land on disk in plaintext.

**Write path — most worth stealing.** One `enum ModelEvent` (~50 variants) is the whole write API, fed through a bounded `SyncSender` (1024) to a single named `"SQLite Writer"` thread with the only write connection; all else reads `mode=ro`. Batching is **coalesce-by-drain**: block on `recv()`, `extend(rx.try_iter())`, dedup (keep only last Snapshot). The busier the writer, the more redundant work it sheds; no timer. Snapshots on every layout mutation (never a timer), with an explicit guard against persisting during cross-window tab drags (transiently empty tree would wipe the session).

**Restore:** rebuild layout, spawn a REAL new PTY per pane; cwd restored only if the dir still exists; old blocks made visible by **feeding stored bytes back through the same VT parser**, timestamps overridden; `BlockType::Restored` suppresses side effects; blocks lacking timestamps (in-flight) never restore. Same replay primitive serves shared sessions and agent-conversation restore.

**Bounds (insert-time, single offset DELETE, no GC thread, no VACUUM anywhere):** 100 blocks/pane · 5,000 lines/block · 10,000 history rows · 200 agent conversations · WAL autocheckpoint 500 pages.

**Crash vs clean quit:** no distinction, and none needed — every write commits immediately. (`crash_recovery.rs` is a GPU-fallback supervisor, unrelated.)

**Concurrency:** WAL, `busy_timeout=1000`, FKs on. Single writer, many readers. Windows single-instance via named mutex, deliberately falling back to running a second instance (WAL is the net). `SQLITE_CONFIG_LOG` FFI callback, catch_unwind-wrapped, per-error-code dedup bitmask.

**The one unbounded path:** `blocks.pane_leaf_uuid` has no FK; orphaned block rows after a crash are invisible to restore and never collected; no VACUUM. Close this in TermX.

## 4. Connection resilience — where the WS-reconnect patterns live

**Blunt finding:** `crates/websocket`, `crates/ipc`, `crates/local_control`, `crates/jsonrpc` contain **no reconnect logic**. Also: Warp has no local WebSocket between processes — local IPC is Unix socket / Windows named pipe with **length-prefixed bincode** (8-byte BE length + payload, ~50 lines), immune to WS upgrade/idle-timeout failure modes.

### 4a. The sleep/wake bug — Warp hit it and documented it
`app/src/server/cloud_objects/listener.rs:169-173`:

> the future that should resolve when the websocket is finished is _not_ polled when the websocket is closed by the server and the CPU is asleep. To get around this, we manually abort the future (effectively closing the websocket) when the CPU goes to sleep and restart it when it's awakened.

On `CpuWillSleep`: abort the live subscription, record `last_disconnected_at`. On `CpuWasAwakened`: abort again defensively, start fresh — NOT touching `last_disconnected_at` so the gap calc sees the whole sleep. Identical shape duplicated for network-change events.

**Gap: no Windows suspend/resume hook exists in the codebase.** TermX needs `WM_POWERBROADCAST` (`PBT_APMSUSPEND` / `PBT_APMRESUMEAUTOMATIC`) or `PowerRegisterSuspendResumeNotification` wired to the same shape. Warp's Windows network listener (COM `INetworkListManagerEvents::ConnectivityChanged` tested against `NLM_CONNECTIVITY_IPV4_INTERNET|IPV6_INTERNET`) is a useful partial substitute.

**Core lesson: do not expect the socket to notice sleep. Proactively tear it down on the power event.**

### 4b. Best reconnect driver — `app/src/ai/agent_events/driver.rs`
- Backoff is a **step table** `[1, 2, 5, 10]s`, `steps[min(failures-1, len-1)]`. Separate `[30]s` schedule for permanent errors.
- **Proactive reconnect at 14 min** — recycle a healthy stream before the 20-min upstream idle timeout.
- Log severity escalates after 5 failures; give-up bounded by auth-failure count (3) AND wall clock (30 min).
- **Don't count a lazy connect as success** — wait for the first real `Open` item before resetting the failure counter.
- **Track auth-failure streaks separately** so "500, 500, 401" doesn't trip the auth give-up.
- Published state: `Connected | RetryScheduled{consecutive_failures, backoff, is_initial_connect} | ProactiveReconnect`.

### 4c. Resync after reconnect — four strategies
1. **Sequence cursor** (right answer for PTY output): `since_sequence` into `open_stream`; server replays from cursor; client double-filters; cursor advances only after the consumer handles the event.
2. **Monotonic revision gate for snapshots** — reject `<=` highest accepted; clear map on disconnect.
3. **Replay connection-scoped setup**: `SessionBootstrapInfo` always persisted ("so we can re-send after a reconnect"), re-sent on every (re)connect; dedup caches cleared on disconnect.
4. **Time-gated refetch**: gap <60s → skip (periodic poll covers it); longer → refetch after `rand()*30s` to spread the herd.

No resume token, no replay of in-flight requests.

### 4d. Pending requests while disconnected
Dropped and errored, never queued. `DashMap<RequestId, oneshot::Sender>`; on death, clear the map so every await resolves Err. **Insert-then-check ordering**: insert oneshot FIRST, then check `disconnected: AtomicBool` — the map lock is the synchronization edge. Request timeout 120 s; on expiry remove entry AND send an `Abort` so the server stops working. `Disconnected` documented as always the final event on the channel. (The old `ipc` crate is the anti-pattern: no timeout, admitted response-before-registration race.)

### 4e. Error classification before retry
Split by **stream alignment**: decode error = recoverable (stream aligned at next length prefix); I/O error/EOF/oversize = fatal. `is_reconnectable(exit_status)` false for 255/signal-kill, optimistically true when unknown. Generic `RetryOption` with linear/exponential + additive one-sided jitter; no max-delay cap (bounded by attempt count). **Anti-flap floor:** `WAIT_PERIOD_BETWEEN_SUCCESSFUL_RECONNECTS = 30s` — wait `30s − connection_lifetime` after a successful connection ends.

## 5. Long-uptime hygiene

- PTY/handle lifecycle: §2.
- Scrollback: per-grid rows, default **50,000** (min 100, max 1M), FIFO front-truncation with a running `num_truncated_rows` so coordinates stay stable. Text in a **chunked flat buffer** (`BTreeMap<ByteOffset, Chunk>`, "a non-circular circular buffer") with styling in separate RLE interval maps; front-trim drops whole chunks. `sum_tree` used for layout only (O(log n) scroll seeks).
- **Block count unbounded in memory** — a real gap; TermX should cap it.
- `crates/prevent_sleep`: refcounted guard → `SetThreadExecutionState(ES_CONTINUOUS|ES_AWAYMODE_REQUIRED|ES_SYSTEM_REQUIRED)` on first, `ES_CONTINUOUS` on last; reasons logged. Used ONLY for in-flight AI/HTTP requests — Warp does not keep the machine awake for long shell commands (product decision TermX could make differently; this guard is the right shape).

## 6. The block model

- **Delimitation is entirely shell-integration-driven; no heuristic fallback.** Bootstrap typed into the PTY with a leading space (or temp-file-sourced for Fish/PowerShell/MSYS2).
- Wire: **DCS** `ESC P $ d <hex-JSON> ESC \` on Unix; **OSC 9278** on Windows ConPTY/WSL/PowerShell (selected by `WARP_USING_WINDOWS_CON_PTY`). Payloads hex-encoded so JSON can never contain ST/CAN/SUB/ESC.
- The cut is ONE hook: `CommandFinished{exit_code, next_block_id}`. **The shell supplies the next block's ID** (`precmd-{WARP_SESSION_ID}-{N}`, N incremented in the shell — UUID gen in shell too expensive), so the app never guesses identity and IDs survive restart.
- Lifecycle splits cheap cut from expensive context: `Preexec` carries command text; `CommandFinished` closes instantly; `Precmd` arrives later with pwd/git/venv/PS1. UI never waits on `git branch`. Git runs `GIT_OPTIONAL_LOCKS=0`.
- **OSC 133 is parsed but NOT used to delimit blocks** — only intra-block prompt geometry. Private protocol does segmentation.
- **Every hook carries a session ID; state-mutating hooks rejected unless the session is registered** — prevents nested shells or `cat`ing a hostile file from forging boundaries.
- Three timestamps (creation/start/completed) make "Enter on empty prompt" representable. Ownerless output classified as typeahead or a `Background` block — never invents a boundary. Alt screen (vim/less) is a peer object outside the blocklist; writes nothing to flat storage.

## 7. Ranked takeaways for TermX

**WS-reconnect (Task #9):** 1. Tear down proactively on Windows power events (Warp has no Windows impl — build fresh; shape at `listener.rs:174-202`). 2. Step-table backoff + separate permanent-error schedule. 3. Reset failures only on a proven Open frame. 4. `disconnected` AtomicBool + clear-pending-on-death + insert-then-check. 5. Per-request timeout that cancels server-side. 6. Anti-flap floor 30s. 7. Per-pane `since_sequence` cursor replay + snapshot revision gate + re-send connection-scoped setup every connect. 8. Surface `Connecting|Connected|Reconnecting{attempt,next_delay,is_initial}|Failed` to React. 9. Consider length-prefixed named pipe.

**ConPTY/long-uptime:** 10. Bundle OpenConsole + conpty.dll. 11. Close → drain → disconnect. 12. Join every PTY loop before host exit. 13. RegisterWaitForSingleObject for child exit. 14. Cap total block count.

**Persistence:** 15. ModelEvent enum → bounded channel → single writer. 16. Coalesce by draining. 17. Persist ANSI bytes, replay through parser. 18. Bound at insert + add the VACUUM Warp lacks. 19. Separate DB files per front-end.

**Blocks:** 20. Segment on an explicit shell hook carrying exit code AND next block ID; OSC on Windows; hex payloads; session-ID gate. 21. Split cheap cut from expensive context. 22. OSC grid-sync tripwire with debug_assert.
