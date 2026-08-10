# TermX Reliability: Reconnect, Power Events, and Lazy Scrollback History — Design

**Date:** 2026-08-09 · **Status:** approved in brainstorm, pending spec review
**Companion specs (same batch):** `2026-08-09-nested-groups-design.md`, `2026-08-09-theme-engine-tab-colors-design.md`

## Goal

TermX must survive being open for weeks — across sleep/wake cycles, daemon
restarts, and network stack hiccups — without the user ever seeing "unable to
open a terminal." When the UI↔daemon connection dies, the UI reconnects
automatically, resyncs missed output, and shows a visible reconnecting state
instead of failing silently. Additionally, scrollback older than the daemon's
in-memory ring is spilled to disk and lazy-loadable, so memory stays flat while
history stays reachable.

## Background: verified failure and current state

**The 2026-08-06 incident (verified live):** Michael's UI (Aug 1 build) had
zero established WebSocket connections while the daemon was healthy (114
handles, port listening, sessions alive). The socket died across multiple
sleep cycles and the UI has no reconnect path — every "new terminal" attempt
failed against a dead socket. Root-cause insight from the Warp study
(`docs/warp-study/README.md` §Task 9): **a socket that dies while the CPU
sleeps is never noticed by the read loop — it must be proactively torn down on
the OS sleep event and reconnected on wake.**

Current code facts:

- `ui/src/host/client.ts` — `HostClient` is **one-shot**: `terminate()`
  (client.ts:770) rejects all pending work, fires `onDisconnect` per
  attachment, clears listeners, and the instance is dead. No retry anywhere.
- Connection is established once at boot in
  `ui/src/workspace/bootstrapWorkspace.ts:83` and consumed by
  `WorkspaceController` through `ui/src/workspace/AttachmentHub.ts`.
  (`ui/src/terminal/TerminalPane.tsx:410` holds a second, dev-harness connect
  path — out of scope.)
- The protocol already has the resync primitive: attachments carry **absolute
  byte offsets** (`nextOffset` cursor per session, client.ts:81; `replay`
  messages carry `start_offset`; gaps surface as `onLostScrollback`). The
  `attach` request currently replays the whole ring from its start.
- Host scrollback: per-session in-memory `RingBuffer`, default 4 MiB, hard max
  8 MiB (`host/src/config.rs:16` — one Replay message must fit the 16 MiB WS
  frame limit). Bytes evicted from the ring are **gone forever**.
- xterm keeps 10 000 lines UI-side (`ui/src/terminal/TerminalPane.tsx:456`).
- Tauri shell (Rust) lives at `ui/src-tauri/src/` — the place to hook Windows
  power notifications.

## Design

### 1. `ReconnectingHostClient` (new: `ui/src/host/reconnect.ts`)

A wrapper that owns the current `HostClient` (unchanged one-shot semantics)
and the reconnect state machine:

```
ConnectionState =
  | { phase: "connecting"; isInitial: boolean }
  | { phase: "connected"; client: HostClient }
  | { phase: "reconnecting"; attempt: number; nextDelayMs: number }
  | { phase: "failed"; reason: string; permanent: boolean }
```

- **Backoff:** step table `[1_000, 2_000, 5_000, 10_000]` ms, then stays at
  10 s. Not a formula — a table (Warp lesson: tables are tunable and legible).
- **Permanent errors:** `auth_err` (token mismatch — daemon restarted with a
  new token, or foreign listener) does NOT retry on the fast table. It refreshes
  the runtime handshake (re-read `runtime.json` via the existing bootstrap
  path — port and token may have changed if the daemon restarted) and retries
  on a slow table `[5_000, 15_000, 30_000]` ms. If the bootstrap itself fails
  (daemon truly gone), state becomes `failed` with a visible "Restart host"
  action that re-runs the daemon-spawn path bootstrap already owns.
- **Success = proven first frame.** Only `auth_ok` (which `HostClient.connect`
  already requires before resolving) resets the attempt counter. A TCP connect
  that never completes auth counts as a failure.
- **Anti-flap floor:** after a successful connection, a subsequent reconnect
  attempt waits `max(0, 30_000 − connectionLifetimeMs)` before trying, so a
  crash-looping daemon can't drive a reconnect storm.
- **Give-up:** bounded by wall clock only for the UI *label* (after 2 minutes
  of reconnecting, the state renders as "Still trying…"); the machine itself
  never stops retrying — Michael's requirement is "open forever."
- **Requests fail, never queue.** While not `connected`, every request-shaped
  call rejects immediately with a typed `HostDisconnectedError`. Callers
  (WorkspaceController) already handle request rejection; the UI surfaces the
  reconnecting state instead of an error toast. Additionally each in-flight
  request gets a 120 s timeout that rejects locally (the daemon is local;
  120 s means something is deeply wrong).

### 2. Windows power events (Tauri shell, `ui/src-tauri/src/`)

New module `power.rs` registered from `lib.rs`: a message-only window whose
wndproc listens for `WM_POWERBROADCAST`:

- `PBT_APMSUSPEND` → emit Tauri event `termx://power-suspend`.
- `PBT_APMRESUMEAUTOMATIC` → emit `termx://power-resume`.

UI side (inside `reconnect.ts`): on **suspend**, proactively `close()` the
current `HostClient` and enter `reconnecting` with attempts frozen (do not
burn retries while asleep). On **resume**, attempt immediately (bypassing the
current backoff delay, still respecting the anti-flap floor). Never wait for
the socket to notice sleep on its own — it won't.

Network-change events (`INetworkListManagerEvents`) are explicitly deferred:
the daemon is loopback-only, so sleep is the dominant killer.

### 3. Resync on reconnect

On each transition to `connected`:

1. `getState()` → reconcile sessions/layout via the existing
   `ui/src/state/reconcile.ts` path (same code the boot flow uses — reuse, not
   a parallel implementation).
2. Re-attach every session the `AttachmentHub` considers live, **sequentially**
   (client.ts:291 constraint), passing the hub's persisted `nextOffset` as a
   new optional `since_offset` field on the `attach` message.
3. **Protocol change (host + UI):** `attach` gains optional
   `since_offset: u64`. The host replays only bytes at
   `max(since_offset, ring_start_offset)`; if `ring_start_offset >
   since_offset` the UI's existing `onLostScrollback` machinery reports the
   gap (and §4's history file usually still has the missing bytes). Omitted
   `since_offset` keeps today's replay-all behavior — old UIs stay compatible.
4. Re-send connection-scoped setup: current dims per pane (`resize` after
   attach), nothing else — layout and sessions are daemon-owned state.
5. `AttachmentHub` keeps attachment records across connection death instead of
   tearing them down: `onDisconnect` marks records `suspended` (panes render
   the reconnect state), and a successful resync flips them back with replayed
   bytes flowing through the existing `deliverOutput` overlap-trim logic.

### 4. Lazy scrollback history (Michael's addition)

Memory stays capped; history moves to disk and loads on demand.

**Daemon:** when bytes are evicted from a session's ring, append them to a
per-session spill file `<data>/history/<session_id>.bin` (raw PTY bytes).
Config: `history_bytes` in `config.json` (default 64 MiB per session, 0
disables; oldest half truncated when the cap is hit — coarse truncation keeps
the write path a plain append). Files are deleted on `close_session` and swept
for orphans at daemon boot.

**Protocol:** new request `read_history { session_id, before_offset, max_bytes }`
→ reply `history { session_id, start_offset, data_b64, at_start }` returning
up to `max_bytes` (cap 512 KiB per request) ending just before
`before_offset`. `at_start: true` means there is nothing older.

**UI:** xterm.js cannot prepend into a live buffer, so in-place infinite
scroll is off the table. Instead: when the user scrolls to the very top of a
pane's scrollback and the daemon reports older history exists, a slim
"Load earlier output" bar appears; clicking opens the session's history in the
existing read-only Viewer (`ui/src/viewer/`), paged lazily via `read_history`
(newest page first, "Load older" fetches backward). ANSI is rendered through
the same VT-to-HTML path the Viewer already uses for output artifacts; if a
page starts mid-escape-sequence the renderer drops bytes up to the first
plausible sequence boundary (ESC or newline) — cosmetic-only risk, documented.

### 5. UI surfacing

- New `ui/src/connection/ConnectionBanner.tsx`: hidden when `connected`;
  "Reconnecting to host… (attempt N)" during `reconnecting`; "Host connection
  failed — Restart host" with the action button in `failed`. `isInitial`
  suppresses the banner during the normal startup connect (no error flash).
- Panes: during `reconnecting`, live panes dim and show a small inline
  "reconnecting" chip — they must NOT convert to `DeadPane` (the session is
  presumed alive; only a daemon-confirmed exit kills a pane).
- "New tab"/"new session" actions while disconnected render disabled with a
  "waiting for host…" tooltip instead of erroring.

### 6. Long-uptime hygiene (host audit, small scope)

From the Warp study, audit-and-fix items in `termx-host` (most may already
hold from M1; each becomes a checked test or a one-line fix, not a rewrite):
join every PTY loop before host exit; `ClosePseudoConsole` → drain-to-EOF →
disconnect order; idempotent close guard; child-exit via
`RegisterWaitForSingleObject` (no polling); stale-cwd spawn fallback chain
(already implemented — keep a regression test).

## Error handling

- All reconnect-machine transitions log via the existing UI logging path with
  timestamps, so a week-old failure is diagnosable from logs.
- A `history` reply that fails to parse or an unreadable spill file degrades
  to "history unavailable" in the Viewer — never a crash, never blocks the
  live pane.
- Malformed `runtime.json` during token refresh → `failed{permanent:false}`,
  slow retry (the daemon may be mid-restart writing the file).

## Testing

- `reconnect.ts` unit tests with the existing `FakeWebSocket` harness
  (client.test.ts pattern): backoff table walk, auth_err→slow-table, counter
  reset only on auth_ok, anti-flap floor, suspend freeze/resume immediate,
  fail-not-queue, 120 s request timeout.
- `AttachmentHub` tests: suspend→resync flow, `since_offset` passed from
  persisted cursor, gap → `onLostScrollback`.
- Host: Rust tests for `since_offset` replay trimming, spill-file append/
  truncate/orphan-sweep, `read_history` paging and `at_start`.
- e2e (reattach.e2e.test.ts pattern): kill the WS server mid-session, restart
  it, assert the client reconnects and replays only unseen bytes.
- Gates: ui `tsc -b` clean, vitest ≥ 751 baseline, e2e 5, cargo host 130 /
  ui 157 baselines.

## Out of scope

Named-pipe transport, network-change events, multi-client daemon access,
in-place xterm history prepend, remote/VPS sessions.
