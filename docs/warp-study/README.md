# Warp Architecture Study — Synthesis for TermX

**Date:** 2026-08-07 · **Source:** `C:\Dev\warp-study` (shallow clone of github.com/warpdotdev/warp, open-sourced May 2026)
**Full reports in this folder:** [sessions/PTY/persistence](report-sessions-pty-persistence.md) · [remote/SSH](report-remote-ssh.md) · [collaboration](report-collaboration.md) · [UI design system](report-ui-design-system.md)

## Licensing rules (binding for all TermX work)

- **Workspace default is AGPL-3.0-only.** Exactly two crates are MIT: `warpui` and `warpui_core` (the Rust GPU UI framework — useless to TermX).
- Everything TermX cares about (terminal, persistence, remote, collab, theme system, chrome) is **AGPL: concepts, numbers, palettes, and wire-protocol semantics only. Never transliterate Rust files into TermX code.**
- Two upstream carve-outs: the PTY event-loop design is adapted from **Alacritty (Apache-2.0)** and the async-pipe code from **Windows Terminal (MIT)** — take those designs from their upstreams.
- Colors, spacing scales, YAML schemas, and icon *names* are facts/functional — free to use. Warp's icon SVGs are AGPL, but they're Untitled UI icons — pull the same names from Untitled UI's own free distribution.

## The four headline findings

1. **Warp has no daemon.** One process; every shell dies on quit. "Restore" = replay persisted ANSI bytes into a fresh shell. TermX's daemon-owns-PTY split is *structurally ahead* of open-source Warp.
2. **Warp's remote sessions don't survive disconnect either.** No remote PTY (tmux flow deleted). Their `remote_server` is a files/git/index sidecar over SSH ControlMaster. The persistent-VPS-session core of TermX's roadmap has **no prior art in Warp** — prior art is tmux/dtach; Warp contributes the layering around it.
3. **Warp shipped full production session-sharing** (~17k lines): snapshot + sequenced deltas, CRDT shared input, presence, roles. All server-relayed; the relay is dumb (sequenced pub/sub + snapshot cache) and easily self-hosted on the TermX VPS daemon.
4. **Warp hit TermX's exact sleep bug and documented the fix**: a WebSocket that dies while the CPU sleeps is *never* noticed by the read loop — you must proactively tear it down on the OS sleep event and reconnect on wake.

---

## Task #9 — WS reconnect resilience (action plan, directly from findings)

Root cause of Michael's 2026-08-06 "can't open a terminal": UI's WS died across sleep cycles; old build has no reconnect. Verified live: daemon healthy, zero established connections.

1. **Windows power events are the trigger Warp never built**: listen for `WM_POWERBROADCAST` (`PBT_APMSUSPEND` → abort the socket; `PBT_APMRESUMEAUTOMATIC` → fresh connect). Never wait for the socket to notice. Add network-change events later (COM `INetworkListManagerEvents`).
2. **Step-table backoff `[1, 2, 5, 10]s`** (not a formula); separate slower table for permanent errors; give-up bounded by count AND wall clock.
3. **Only a proven first frame resets the failure counter** — `connect()` returning Ok is not "connected."
4. **Resync via per-session monotonic byte/event cursor**: UI sends `since_seq` per pane; daemon replays only unseen output. This is where the daemon architecture pays off. Revision-gate full snapshots (reject `<=` last accepted; clear on disconnect).
5. **Re-send connection-scoped setup on every (re)connect** — subscriptions, active panes, dims. Persist it; never send-once. Clear any dedup caches on disconnect.
6. **Pending requests**: insert-into-map-then-check-disconnected-flag ordering; on death, fail all pending (never queue); per-request timeout (~120s) that also sends a cancel to the daemon.
7. **Anti-flap floor**: ≥30s between *successful* connections (wait `30s − connection_lifetime`).
8. **Surface state to React**: `Connecting | Connected | Reconnecting{attempt, next_delay, is_initial} | Failed{reason}` — `is_initial` stops error-flash at startup; reconnect state renders in panes instead of dead silence.
9. Optional: consider length-prefixed framing over a named pipe as the local transport someday — Warp deliberately avoids local WS — but WS + the above is sufficient.

## Long-uptime / ConPTY hygiene (feeds Task #9's "open forever" bar)

- **Bundle OpenConsole.exe + conpty.dll** (MIT, Windows Terminal) and `LoadLibrary` at runtime — decouples from the user's Windows build, adds `ReleasePseudoConsole`.
- **Shutdown order:** `ClosePseudoConsole` → **drain the pipe to EOF** → disconnect. Skipping the drain hangs the console host. Idempotent close guard.
- **Join every PTY event loop before host exit** or you leak OpenConsole processes across restarts (looks like a memory leak over weeks).
- `RegisterWaitForSingleObject` for child exit (no polling); close both hProcess AND hThread; 1s bounded terminate wait; `CREATE_BREAKAWAY_FROM_JOB`.
- Stale cwd must never fail a spawn: `is_dir()`-check then fall back to `%USERPROFILE%` (TermX already does the chain — keep it).
- **Cap total block/scrollback memory per session AND across sessions** — Warp bounds rows per grid (50k) but leaves block count unbounded; don't repeat that.
- Grid-desync tripwire: private OSC "reset grid" marker + debug assert (Warp's OSC 9279 pattern).

## UI hardening — why Warp reads sharp (Michael: current TermX UI is "too soft")

Five concrete levers, in impact order:
1. **Hairline 1px borders at 10% fg opacity instead of shadows** for ALL separation (tabs, panes, blocks, rails). One shadow in the whole app (floating overlays only).
2. **Radii: 4px default, 0 on tabs and blocks** (their newest styling is literally square tabs + 1px side border). Nothing pill-shaped except dots.
3. **Separation by tint, not elevation**: same bg + fg at 5/10/15/20% (surface ramp). No cards, no glow.
4. **Density**: 12px base UI font, 34px chrome rows, 28px list rows, 24px icon buttons, 10px uppercase overline labels (ADD letter-spacing — Warp can't; tracking sells the sign-shop look).
5. **Muted accent ramps** — desaturated brights (Phenomenon's `#AE756F`/`#789B88`/`#BD9F65`), not neon.

Portable systems:
- **Three-color theme derivation** (bg/fg/accent → every surface/border/text via fixed opacity blends: 5/10/15/20/40/60/90). ~20 lines of CSS `color-mix()`. Text ladder: 90/60/40/20% opacity.
- **WCAG contrast auto-correct** (binary-search opacity toward white/black until 4.5:1 text / 3:1 non-text) — makes ANY user theme safe. ~40 lines, reimplement independently.
- **Adopt Warp's theme YAML schema** (`background`/`foreground`/`accent`/`details`/`terminal_colors`, hex-or-gradient union) → instant compatibility with the community theme ecosystem.
- Palettes free to take; **Phenomenon** (`#121212` / `#FAF9F6` / gold `#E5A01A`) is closest to Michael's sign-shop taste.
- Block chrome: 1px divider + 5px colored left stripe for state + 10% red wash for failures; spacing in line-height units (`calc(var(--lh) * 1.1)`); hover reveals an action pill, never tints the block body.

## VPS / SSH roadmap (future major)

- **Warp does NOT solve persistent remote sessions** — build the remote PTY ourselves (TermX daemon on the VPS owning ConPTY/pty + scrollback ring + attach/detach with resume cursors; prior art tmux/dtach). Output must be a *subscription with a cursor*, not a stream.
- **Steal:** OpenSSH ControlMaster as the only transport (one authenticated master, N free channels, zero credential handling — set `PasswordAuthentication=no` on slave channels); ownership tagging (`WarpManaged` vs `UserOwned` masters, only ever tear down your own); `flock` + PID + `setsid()` daemon singleton (~60 lines, survives SSH HUP); dumb per-connection proxy + long-lived daemon (reconnect = new proxy, not rebuilt state; manual stdout flush; shutdown(Both) or the master hangs); host-scoped vs session-scoped request split (any-connection failover vs connection affinity); version-hashed socket names + never-kill-old-daemon (safe autoupdate); preinstall gate that fails open with a *named* degraded tier; client-pushed token rotation (remote never holds a refresh token).
- **Windows caveat:** Win32-OpenSSH has no ControlMaster — the TermX client side needs its own multiplexing plan.
- Shell integration over SSH: inject at shell spawn on the daemon side (easier than Warp's typed-into-the-pty bootstrap since we own the remote PTY). Hex-encoded OSC payloads; session-ID-gate every hook against forgery.

## Collaboration roadmap (future major)

- **The one big idea: build session-attach ONCE — humans joining Michael's session, Michael watching an agent's session, Ibrahim joining either, are all the same viewer mechanism.** (Warp's cloud-agent UI *is* its session-sharing viewer.)
- **TermX's topology is strictly better**: PTY on the VPS daemon makes both humans symmetric viewers — no sharer-goes-offline failure mode, and permissions enforce on the daemon (Warp only enforces client-side — don't copy that).
- Protocol shape: join → one snapshot (structured blocks + dims + participant list + assigned IDs + catch-up seq) → sequenced hybrid delta stream (lz4 raw PTY bytes interleaved with structured events), acks free sender buffer, rejoin resumes from `last_event_no + 1`.
- **Viewer input in semantic channels, never raw keystrokes by default**: shared-input edits / `ExecuteCommand` / gated raw `WriteToPty` / agent prompts. Makes "Reader vs Executor" roles real. Role upgrades via sharer confirmation.
- Minimal rendezvous server = sequenced pub/sub + snapshot cache + ACL table — a natural extension of termx-host on the VPS. Identity at our scale = small token table (no Firebase equivalent needed).
- Agent orchestration ideas: run-ID = task-ID = mailbox address; server mailbox with pointer events + lazy hydration; `wait_for_events` parks idle agents; denial reasons written as corrective instructions to the model.
- **Warp has NO answer for two people's agents colliding on files** (no worktrees, no leases). That's TermX's problem to solve — git worktrees per agent and/or path claims/leases. (We already have worktree discipline from our own merge protocol.)
- Use a permissive CRDT (`loro`/`yrs`/`diamond-types`) for shared input if needed — or let the daemon serialize edits authoritatively and skip the CRDT entirely.

## Persistence lessons (when TermX grows restore-into-fresh-shell or heavier state)

- One `ModelEvent` enum → bounded channel → single named writer thread → single write connection; `mode=ro` readers; WAL + busy_timeout.
- **Coalesce by draining** (`recv()` then `try_iter()` then drop-all-but-last-snapshot) — adaptive batching, no timers.
- Persist ANSI bytes; restore by replaying through the VT parser (same primitive serves restore, sharing, and conversation replay).
- Bound at insert time (blocks/pane 100, lines/block 5k, history 10k); add the VACUUM/orphan sweep Warp lacks; separate DB files per binary to dodge migration skew.
- Freeze persisted state BEFORE killing shells on quit, so clean quit restores as a live session.
- Warp stores commands/output in plaintext — if TermX persists scrollback, decide the secrets story deliberately.

## Explicitly not worth taking

CDN-based remote install (scp our own binary), Firebase/device-flow auth, GraphQL sync surface, cloud-relayed sharing service, telemetry, the notebook "edit baton" (pessimistic lock + silent server-wins conflict UX), unbounded channels with drop-on-failure (add real backpressure).
