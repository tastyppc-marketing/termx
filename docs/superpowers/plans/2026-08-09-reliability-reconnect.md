# Reliability: Reconnect, Power Events, Lazy Scrollback History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The UI reconnects to the daemon automatically (including across Windows sleep/wake), resyncs only unseen output, surfaces a visible reconnecting state, and old scrollback spills to disk and lazy-loads — so TermX can stay open for weeks with flat memory and zero "unable to open a terminal" errors.

**Architecture:** A `ReconnectingHostClient` wrapper owns the one-shot `HostClient` lifecycle with a step-table backoff state machine, driven proactively by Windows power broadcasts from a new Tauri-side listener. Resync rides the protocol's existing absolute byte offsets via a new optional `since_offset` on `attach`. The daemon appends ring-evicted bytes to a per-session spill file served by a new `read_history` request.

**Tech Stack:** TypeScript (React 19, vitest, FakeWebSocket harness), Rust (termx-host tokio/tungstenite; ui/src-tauri Tauri 2 + windows-sys).

**Spec:** `docs/superpowers/specs/2026-08-09-reliability-reconnect-design.md` — read it first; authoritative.

## Global Constraints

- Backoff tables verbatim from spec: normal `[1_000, 2_000, 5_000, 10_000]` ms (stays at 10 s); permanent-ish (auth_err) `[5_000, 15_000, 30_000]` ms; anti-flap floor `30_000` ms since last successful connect; request timeout `120_000` ms; history request cap `512 * 1024` bytes; `history_bytes` default `64 * 1024 * 1024`, `0` disables.
- Only `auth_ok` resets the attempt counter — a TCP connect that never completes auth is a failure.
- Requests fail fast while disconnected (`HostDisconnectedError`) — never queue.
- The reconnect machine never permanently stops retrying; `failed` is only for an unusable bootstrap (daemon unspawnable) and offers a manual retry action.
- Live panes must NOT become `DeadPane` on disconnect — only a daemon-confirmed exit kills a pane.
- `exactOptionalPropertyTypes` ON: `{...(x ? { x } : {})}` for optional props.
- Cargo builds from repo root; in Git Bash first run `export PATH="$HOME/tools/mingw64/bin:$HOME/.cargo/bin:$PATH"`.
- No Warp (AGPL) code transliteration — concepts only. No hardcoded absolute machine paths.
- Gates: `cd ui && npx tsc -b` clean; `npx vitest run --reporter=dot` ≥ 751 + new, all green; e2e 5 + new; `cargo test -q -p termx-host` 130 + new; `cargo test -q -p termx-ui` 157 + new.
- Never `git stash`; never junction/symlink into the main repo; commit per task.

## File Structure

- Host: `host/src/protocol.rs` (attach.since_offset, ReadHistory/History), `host/src/config.rs` (history_bytes), new `host/src/history.rs` (spill file), session/server wiring where the ring lives.
- Tauri shell: new `ui/src-tauri/src/power.rs`, registered from `lib.rs`.
- UI: new `ui/src/host/reconnect.ts` (+ `HostDisconnectedError`), `ui/src/host/client.ts` (sinceOffset param), `ui/src/workspace/AttachmentHub.ts` (suspend/resync), `ui/src/workspace/bootstrapWorkspace.ts` (wrapper integration), new `ui/src/connection/ConnectionBanner.tsx` (+ css), `ui/src/App.tsx`, `ui/src/terminal/TerminalPane.tsx` (reconnect chip + history bar), `ui/src/viewer/` (history view).

---

### Task 1: Host — `attach` gains optional `since_offset`

**Files:**
- Modify: `host/src/protocol.rs` (ClientMsg::Attach), the attach/replay handler (find it: `rg -n "replay" host/src` — the code that snapshots the ring into one Replay message)
- Test: alongside the existing replay tests in the same module + `host/tests/e2e.rs` style if present

**Interfaces — Produces (wire):** `{"type":"attach","session_id":N,"replay":true,"since_offset":123}` — `since_offset` optional (`#[serde(default)] since_offset: Option<u64>`). Host replays bytes from `max(since_offset, ring_start_offset)`; omitted → today's behavior (replay whole ring). The Replay message's `start_offset` already tells the client where the data begins — no reply change.

- [ ] **Step 1:** Failing Rust test: fill a ring past eviction; attach with `since_offset` mid-ring → Replay `start_offset == since_offset` and payload is exactly the tail; `since_offset` older than `ring_start_offset` → Replay starts at `ring_start_offset` (client's existing gap logic handles it); `since_offset` beyond ring end → empty Replay at ring end.
- [ ] **Step 2:** `cargo test -q -p termx-host` — FAIL.
- [ ] **Step 3:** Implement: deserialize the field; slice the ring snapshot before base64-encoding.
- [ ] **Step 4:** Tests green (130 + new).
- [ ] **Step 5:** Commit: `feat(host): attach since_offset for reconnect resync`.

### Task 2: Host — history spill file

**Files:**
- Create: `host/src/history.rs`
- Modify: `host/src/config.rs` (field + clamp), the ring-eviction site (`rg -n "RingBuffer" host/src` — wherever bytes are dropped from the front), session close path, daemon boot (sweep)
- Test: `host/src/history.rs` unit tests + an integration test at the eviction site

**Interfaces — Produces:**

```rust
// config.rs
#[serde(default = "default_history_bytes")] pub history_bytes: u64,   // 64 MiB; 0 disables
pub const MAX_HISTORY_BYTES: u64 = 512 * 1024 * 1024;                  // clamp, same pattern as scrollback_bytes

// history.rs — file format: [8-byte LE u64 start_offset][raw evicted PTY bytes...]
pub struct HistoryWriter { /* session_id, path, cap */ }
impl HistoryWriter {
    pub fn open(data_dir: &Path, session_id: u32, cap: u64) -> Result<Self>; // creates <data>/history/<id>.bin
    pub fn append(&mut self, evicted: &[u8]) -> Result<()>;  // truncates oldest half (rewrite keeping newer half + new header) when file body would exceed cap
    pub fn start_offset(&self) -> u64;                       // absolute offset of first stored byte
    pub fn end_offset(&self) -> u64;
}
pub fn read_history(data_dir: &Path, session_id: u32, before_offset: u64, max_bytes: u32)
    -> Result<Option<HistorySlice>>;                          // None = no file
pub struct HistorySlice { pub start_offset: u64, pub data: Vec<u8>, pub at_start: bool }
pub fn delete(data_dir: &Path, session_id: u32);              // close_session
pub fn sweep_all(data_dir: &Path);                            // daemon boot: sessions never survive a daemon restart, so ALL history files are stale — remove the dir contents
```

The writer's first `append` records the absolute offset the ring evicted from (caller passes it via `open`/first append — pick one and document it in the module header). Eviction hook: where the ring drops N front bytes, call `writer.append(dropped_bytes)` — the ring code must hand the evicted bytes out rather than discarding them (small refactor of the ring's push path). `history_bytes == 0` → no writer constructed, zero overhead.

- [ ] **Step 1:** Failing unit tests: append/read round-trip; truncation keeps the newer half and updates `start_offset`/header; `read_history` pages backward correctly (`before_offset` at file end, mid-file, before `start_offset` → `at_start:true` + empty/partial); `sweep_all` empties the dir; `delete` removes the file. Integration: ring eviction lands bytes in the file with matching offsets.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** green → **Step 5:** Commit: `feat(host): disk-spill scrollback history with cap and sweep`.

### Task 3: Host — `read_history` protocol request

**Files:**
- Modify: `host/src/protocol.rs`, the server request dispatcher (where `list_sessions`/`get_state` are handled)
- Test: protocol/server tests alongside existing request tests

**Interfaces — Produces (wire):**
Request `{"type":"read_history","session_id":N,"before_offset":123,"max_bytes":65536}` (max_bytes clamped to 524288).
Reply `{"type":"history","session_id":N,"start_offset":100,"data_b64":"...","at_start":false}`.
Unknown session or no history file → `history` with empty `data_b64`, `at_start:true` (never an `error` — history absence is normal).

- [ ] **Step 1:** Failing tests: round-trip through the dispatcher against a seeded spill file; clamping; unknown-session behavior.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** `cargo test -q -p termx-host` green → **Step 5:** Commit: `feat(host): read_history request`.

### Task 4: Host — long-uptime hygiene audit

**Files:** audit `host/src` (PTY loop joins, ConPTY close order, child-exit wait, close-guard idempotence); fix + test only what's actually missing.

- [ ] **Step 1:** For each spec §6 item, locate the code (`rg -n "ClosePseudoConsole|JoinHandle|WaitForSingleObject|RegisterWait" host/src`) and record PASS/FIX in the commit message.
- [ ] **Step 2:** For each FIX: failing test where testable (e.g. drain-to-EOF order via the existing pipe fakes), then the fix. Do not rewrite working code.
- [ ] **Step 3:** `cargo test -q -p termx-host` green → Commit: `fix(host): long-uptime hygiene audit (list findings here)`.

### Task 5: Tauri — Windows power broadcast events

**Files:**
- Create: `ui/src-tauri/src/power.rs`
- Modify: `ui/src-tauri/src/lib.rs` (spawn on setup), `ui/src-tauri/Cargo.toml` (add `windows-sys` features `Win32_Foundation`, `Win32_UI_WindowsAndMessaging` — check what's already there first)
- Test: `cargo test -q -p termx-ui` compile-level + a unit test for the wparam→event mapping

**Interfaces — Produces:** Tauri events `termx://power-suspend` and `termx://power-resume` emitted app-wide.

Implementation shape: a dedicated thread creates a message-only window (`CreateWindowExW` with parent `HWND_MESSAGE`, own registered class) and runs a `GetMessageW` loop; the wndproc on `WM_POWERBROADCAST` matches `wParam` `PBT_APMSUSPEND (0x0004)` → emit suspend, `PBT_APMRESUMEAUTOMATIC (0x0012)` → emit resume, via an `AppHandle` smuggled through a `OnceLock`/userdata. Extract the pure mapping `fn power_event(wparam: usize) -> Option<PowerEvent>` so it's unit-testable without a window.

- [ ] **Step 1:** Failing test for `power_event` mapping (both constants + unknown → None).
- [ ] **Step 2:** FAIL → **Step 3:** implement module + registration → **Step 4:** `cargo test -q -p termx-ui` green (157 + new) and `cargo build -p termx-ui` clean → **Step 5:** Commit: `feat(tauri): WM_POWERBROADCAST suspend/resume events`.

### Task 6: UI — `HostClient.attach` sinceOffset + request timeout groundwork

**Files:**
- Modify: `ui/src/host/client.ts` (attach signature + wire field), `ui/src/host/protocol.ts` (ClientMsg attach type)
- Test: `ui/src/host/__tests__/client.test.ts`

**Interfaces — Produces:** `attach(sessionId, callbacks = {}, replay = true, sinceOffset?: bigint)` — when provided, the attach message carries `since_offset: Number(sinceOffset)` (offsets are far below 2^53; assert and throw past `Number.MAX_SAFE_INTEGER`).

- [ ] **Step 1:** Failing tests (FakeWebSocket harness in client.test.ts): attach with sinceOffset sends the field; without it the field is absent; oversized bigint throws.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** host suite green → **Step 5:** Commit: `feat(ui): attach sinceOffset`.

### Task 7: UI — `ReconnectingHostClient` state machine

**Files:**
- Create: `ui/src/host/reconnect.ts`
- Test: `ui/src/host/__tests__/reconnect.test.ts`

**Interfaces — Produces (Tasks 8–10 consume exactly these):**

```ts
export class HostDisconnectedError extends Error { readonly kind = "host-disconnected"; }

export type ConnectionState =
  | { phase: "connecting"; isInitial: boolean }
  | { phase: "connected" }
  | { phase: "reconnecting"; attempt: number; nextDelayMs: number }
  | { phase: "failed"; reason: string };

export interface ReconnectOptions {
  connect: () => Promise<HostClient>;      // the FULL bootstrap chain: re-reads runtime.json each call (port/token may change), spawns daemon if needed
  now?: () => number;                       // injectable clock (default Date.now)
  schedule?: (fn: () => void, ms: number) => () => void;  // injectable timer (default setTimeout/clearTimeout)
}

export class ReconnectingHostClient {
  static start(options: ReconnectOptions): ReconnectingHostClient;
  readonly state: ConnectionState;
  onStateChange(l: (s: ConnectionState) => void): () => void;
  onConnected(l: (client: HostClient, isReconnect: boolean) => void): () => void;
  request<T>(fn: (client: HostClient) => Promise<T>): Promise<T>;  // HostDisconnectedError when not connected; 120s local timeout
  notifySuspend(): void;   // close current client, freeze retries
  notifyResume(): void;    // attempt immediately (respect anti-flap floor)
  retryNow(): void;        // manual action from the failed banner
  dispose(): void;
}
```

Behavior (spec §1): backoff tables per Global Constraints; an `auth_err`-shaped failure (`connect` rejects with message containing "authentication rejected") switches to the slow table; only a resolved `connect()` (which requires auth_ok) resets `attempt`; on the wrapped client's `onError`-terminate/`onDisconnect` (detect via a client-level hook: wrap `client.onError` + attachment-independent close — use the client's `onError` listener plus a probe `onSessionClosed`? No: `HostClient` fires ALL attachment `onDisconnect`s and rejects pending on terminate; the wrapper detects death by registering `client.onError` AND by any `request` rejecting with "Host connection closed/failed" — centralize with `isTerminalClientError(e)`), transition to `reconnecting` and schedule per table; anti-flap: on entering `connected` record `now()`; a reconnect attempt after a death waits `max(tableDelay, 30_000 − lifetime)` for its FIRST retry; suspend freezes the timer, resume cancels the pending timer and attempts immediately.

- [ ] **Step 1:** Failing tests with injected clock/timers and a scripted `connect` (resolve/reject sequences): walks 1s→2s→5s→10s→10s; success resets to 1s next time; auth-rejected → 5s/15s/30s table; request during `reconnecting` rejects with `HostDisconnectedError` immediately; request timeout at 120s rejects; suspend closes client + no retries fire while frozen; resume attempts immediately; anti-flap: connect succeeded then died 5s later → first retry waits ≥25s; `retryNow` from any non-connected phase attempts immediately; state-change listener sequence is exactly as specified; dispose cancels timers.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** green → **Step 5:** Commit: `feat(ui): reconnecting host client state machine`.

### Task 8: UI — AttachmentHub suspend/resync

**Files:**
- Modify: `ui/src/workspace/AttachmentHub.ts`, `ui/src/workspace/bootstrapWorkspace.ts`
- Test: `ui/src/workspace/__tests__/AttachmentHub.test.ts`

**Interfaces:** Consumes Task 7's wrapper + Task 6's `sinceOffset`. Produces: hub records/status gain `suspended: boolean` (pane-visible via the existing status snapshot, next to `lostScrollback` at AttachmentHub.ts:446); hub construction takes the `ReconnectingHostClient` instead of a raw client.

Flow: on wrapper state → non-connected: snapshot each live record's `handle.nextOffset`, mark `suspended: true`, notify subscribers (panes render the chip — Task 10). On `onConnected(client, isReconnect=true)`: `getState()` → existing reconcile path (`ui/src/state/reconcile.ts` — reuse, do not fork); re-attach every still-alive session **sequentially** (client.ts:291 constraint) passing the snapshotted offset as `sinceOffset`; replayed bytes flow through existing `deliverOutput` overlap-trim; clear `suspended`; sessions the daemon no longer knows become dead panes through the existing reconcile behavior. Re-send current dims (`resize`) per pane after its attach.

- [ ] **Step 1:** Failing tests (extend the hub's fake-host harness): disconnect marks all records suspended and notifies; resync re-attaches sequentially with the right sinceOffsets and resizes; a session missing after resync goes through the dead path; a mid-resync second disconnect leaves a consistent suspended state (no orphan attach).
- [ ] **Step 2:** FAIL → **Step 3:** implement (bootstrapWorkspace builds the wrapper with its existing connect chain as `ReconnectOptions.connect`) → **Step 4:** workspace suite green → **Step 5:** Commit: `feat(workspace): attachment resync across reconnects`.

### Task 9: UI — ConnectionBanner, pane chip, gated actions, power wiring

**Files:**
- Create: `ui/src/connection/ConnectionBanner.tsx`, `ConnectionBanner.css`
- Modify: `ui/src/App.tsx` (mount banner; subscribe Tauri power events → `notifySuspend`/`notifyResume` via `@tauri-apps/api/event` `listen`), `ui/src/terminal/TerminalPane.tsx` (suspended chip), the new-tab/new-session action sources (disable + tooltip while not connected)
- Test: `ui/src/connection/__tests__/ConnectionBanner.test.tsx`, extend `SplitLayout`/`TerminalPane` and sidebar action tests

Banner rendering by state: `connecting{isInitial:true}` → nothing; `reconnecting` → `Reconnecting to host… (attempt N)`, after 2 min of continuous reconnecting append `— still trying`; `failed` → `Host connection failed` + a `Restart host` button calling `retryNow()`. Suspended panes: existing pane chrome gets a small `reconnecting` chip (reuse DeadPane's css vocabulary, new `.pane-chip--reconnecting`); pane does NOT become DeadPane. New-tab/new-session controls disabled with `title="Waiting for host…"` when not connected.

- [ ] **Step 1:** Failing tests: banner per state incl. initial-connect silence; chip renders when status.suspended; new-tab disabled when disconnected.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** green + `npx tsc -b` clean → **Step 5:** Commit: `feat(ui): connection banner, pane reconnect chip, gated actions, power wiring`.

### Task 10: UI — lazy history viewer

**Files:**
- Modify: `ui/src/terminal/TerminalPane.tsx` (top-of-scrollback bar), `ui/src/host/client.ts` (+`readHistory` request method), `ui/src/viewer/` (history mode)
- Test: extend client tests (readHistory round-trip), viewer tests (paging), TerminalPane test (bar visibility)

**Interfaces:** `client.readHistory(sessionId: number, beforeOffset: bigint, maxBytes: number): Promise<{ startOffset: bigint; data: Uint8Array; atStart: boolean }>` (new entry in `REQUEST_CONTEXTS`/reply plumbing mirroring `get_state`). TerminalPane tracks `firstReplayOffset` (offset of the first replay event it saw); if `> 0n` and the xterm viewport scrolls to the very top, render a slim `Load earlier output` bar; clicking opens the Viewer in history mode for that session, which pages backward with `readHistory` (page size 64 KiB, newest page first, `Load older` button until `atStart`). ANSI → rendered through the Viewer's existing VT/text path; on a page starting mid-sequence drop bytes to the first `\x1b` or `\n` boundary.

- [ ] **Step 1:** Failing tests: client readHistory wire round-trip (FakeWebSocket); viewer history mode renders pages and stops at `atStart`; bar appears only when `firstReplayOffset > 0` and scrolled to top.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** green → **Step 5:** Commit: `feat(ui): lazy scrollback history viewer`.

### Task 11: e2e reconnect test + full gates

**Files:**
- Create/extend: `ui/src/host/__tests__/reconnect.e2e.test.ts` (copy the real-WS-server harness pattern from `reattach.e2e.test.ts`)

- [ ] **Step 1:** Test: start harness server, connect wrapper, stream bytes; kill the server socket (no close frame); restart server on the same port with more bytes in the ring; assert the wrapper reconnects, re-attaches with `since_offset`, and the pane callback receives only unseen bytes with no duplicates.
- [ ] **Step 2:** Green under `npx vitest run -c vitest.e2e.config.ts` (5 + 1).
- [ ] **Step 3: Full gates** — ui `npx tsc -b` clean; `npx vitest run --reporter=dot` ≥ 751 + new; e2e green; `cargo test -q -p termx-host` (130 + new); `cargo test -q -p termx-ui` (157 + new).
- [ ] **Step 4:** Commit: `test(e2e): reconnect resync end-to-end`. Final report lists every commit SHA + test counts.

## Self-Review (done at plan time)

Spec coverage: §1→T7, §2→T5+T9 wiring, §3→T1+T6+T8, §4→T2+T3+T10, §5→T9, §6→T4, error handling→T2/T3 absence-is-normal + T7 tables, testing→mapped 1:1. Type consistency: `sinceOffset: bigint` (T6) ↔ snapshotted `nextOffset` (T8); `readHistory` name consistent T3 wire ↔ T10 client. No placeholders.
