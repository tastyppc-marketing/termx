# TermX M2 — Terminal UI Implementation Plan (revised scope)

**Goal:** A usable, stable terminal window on the M1 host: Tauri 2 + React + xterm.js with reattach-on-restart, colored/grouped tabs, a folder picker that cd's, split panes, and persisted layout.

**Scope ruling (2026-07-22, Michael-approved):** The 2026-07-18 ui-shell architecture (AI session recovery, storage repair, structured provider bridges, TXAU audit transport, protocol v2) is **parked for M3+**, checkpointed intact at commit `1a43977`. M2 builds directly against the shipped M1 protocol (`host/src/protocol.rs`) with **zero expected host changes** — the UI attaches to every live session over one WebSocket, so no unsolicited-lifecycle-event protocol work is needed for a single-client v1. Rationale: two days of planning loop produced no runnable UI; every v1 terminal feature is implementable against M1 as it stands (105 tests green).

**Execution model:** external workers via claude-x (`gemini-3.1`, `grok-4.5`/`grok-fast`, `gpt-5.6` Sol) run the bulk implementation on Michael's other subscriptions; any Claude-side subagents are **Opus 4.8**. Fable supervises: writes/routes task briefs, reviews every diff, runs verify commands, commits (workers never commit), and performs the final cleanup + adversarial audit.

## Global constraints

- **Portability:** no absolute paths in code or config, ever. Resolve everything at runtime from the app/project location or standard OS env vars.
- **Pinned stack** (officially verified 2026-07-19 — do not "upgrade"): `tauri 2.11.5`, `tauri-build 2.6.3`, `@tauri-apps/api 2.11.1`, `@tauri-apps/cli 2.11.4`, `tauri-plugin-dialog 2.7.2`, React `19.2.7`, Vite `8.1.5`, TypeScript `6.0.3`, `@xterm/xterm 6.0.0` (+ fit/web-links/search addons), Vitest `4.1.10`, jsdom `29.1.1`. Node `v24.14.1` / npm `11.11.0`. Rust `stable-x86_64-pc-windows-msvc`.
- **Token hygiene:** the WS auth token is read from `runtime.json` and held in memory only — never logged, never persisted elsewhere, never rendered.
- **Disposable UI:** a UI crash must lose zero session state. The M1 host guarantees this; the UI must not undermine it (all durable terminal state lives host-side; layout via `SetLayout` only).
- **Per task:** tests (Vitest or `cargo test`) plus the task's verify command green **before** Fable commits. Conventional commit messages.
- `host/src/**` is read-only for workers. Docs/specs/handoffs are Fable-only.
- Source of truth for wire behavior is `host/src/protocol.rs` module docs + `server.rs` contract comments (Replay is NOT one-shot; offsets may jump forward past ring eviction; input >256 KiB → graceful Error, >1 MiB → connection drop).

## Tasks

### T1 — Scaffold `ui/` (suggested: gemini-3.1)
Tauri 2 + React + TS + Vite app at `C:\Dev\TermX\ui\` using the pinned versions, created manually (no interactive scaffolders). Dark shell, window title "TermX", 1280×800. One local-echo xterm demo pane proving xterm bundles and renders (no host connection yet). Vitest wired with one trivial passing test.
**Verify:** `npm run build` green; `cargo check` green in `ui/src-tauri`; `npx vitest run` green.

### T2 — Host bootstrap, native side (suggested: gpt-5.6 or Fable)
Tauri command `bootstrap_host` in `ui/src-tauri`: resolve the host data dir (mirror `host/src/paths.rs` resolution incl. portable.flag), read + liveness-check `runtime.json` (TCP probe), spawn `termx-host.exe` if absent/dead (bundled-sidecar path first, dev fallback `target/debug/termx-host.exe` resolved at runtime relative to the workspace — no literal paths), `CREATE_NO_WINDOW` + detached, poll `runtime.json` up to 10 s. Returns `{port, token}` to the renderer once.
**Verify:** `cargo test` in `ui/src-tauri` (temp data dirs via `--data-dir`).

### T3 — Transport, TS side (suggested: gpt-5.6)
`ui/src/host/`: `protocol.ts` (types mirroring `HostMsg`/`ClientMsg`), `frames.ts` (binary codec — byte layout exactly per `protocol.rs`, fixtures cross-checked against the Rust tests), `client.ts` (`HostClient`: connect/auth, request-response correlation, per-session attach handles with replay decode, offset-gap = lost-scrollback signal, unsolicited resync handling).
**Verify:** `npx vitest run` green incl. codec fixtures.

### T4 — Terminal pane (suggested: gpt-5.6)
`ui/src/terminal/`: `TerminalPane` binding one xterm instance to one attach handle — replay then live output, input→frames, fit-addon + `Resize`, web-links addon (clickable URLs/paths), search addon behind Ctrl+F overlay, exit banner on `SessionExited`.
**Verify:** Vitest (jsdom + fake HostClient); manual `npm run tauri dev` smoke against the real host.

### T5 — Sessions sidebar (owner: gpt-5.6, design brief from Fable)
The centerpiece. Colored session tabs in collapsible groups with **daily-driver interaction polish**:
- **Drag and drop** — reorder within a group and move across groups with a pointer-based implementation (no DnD library): drag ghost with subtle elevation, live drop indicator, spring-free 120–150 ms transitions, Escape cancels.
- **Double-click to rename** — inline input swap (Enter commits, Escape reverts, blur commits), no modal.
- **Right-click context menu** — Rename, color palette (8 swatches), Duplicate (same profile+cwd), Move to group, Close; dead sessions get Dismiss.
- Create button with profile menu (powershell/cmd); activity pulse + exited badge via the attach-all model; close-on-hover ×; collapsible group headers with animated chevron; keyboard: Up/Down to switch, F2 rename, Del close (confirm if live).
State serialized as the `SetLayout` blob (`layout_v1` JSON), restored via `GetState`.
**Verify:** Vitest for store/serialization + rename/drag state machines; Fable screenshot review of the running app against the UI quality bar before commit.

### T6 — Folder picker (suggested: grok)
`tauri-plugin-dialog` open-folder → `CreateSession` with that cwd (the v1 headline: pick any folder, get a shell there). Context menu: "Open folder here", "Duplicate tab" (same profile+cwd).
**Verify:** Vitest for the wiring; manual smoke.

### T7 — Split panes (suggested: gpt-5.6)
Recursive H/V split tree per view; each leaf hosts a `TerminalPane`; draggable dividers; tree persisted in the layout blob.
**Verify:** Vitest for tree ops + serialization; manual smoke.

### T8 — Restore & resilience e2e (suggested: gpt-5.6, reviewed hard)
Boot flow: `bootstrap_host` → auth → `ListSessions` + `GetState` → rebuild tabs/groups/splits → reattach with replay. The flagship demo as an automated e2e: create sessions, kill the UI process, relaunch, assert sessions reattach with scrollback. Dismissing a dead tab sends `CloseSession` (the BACKLOG §5 M2 obligation — frees the host-side ring).
**Verify:** e2e green; M1 suite still green (`cargo test -p termx-host`).

### T9 — Cleanup + adversarial audit (Fable + Opus 4.8)
ESLint/clippy/fmt across `ui/`, full Vitest + cargo suites, orphan-process scan after e2e, then an adversarial audit of all worker-written code (token leaks, absolute paths, state-loss paths, replay/resync misuse, xterm write-backpressure) with a fix pass. Final report + handoff update.

## UI quality bar (Michael, 2026-07-22 — binding for every UI task)

Not "good enough for a test app" — **great**: the app should feel so intuitive, powerful, and lightweight that it wins daily-driver status on ease alone. Concretely:
- **One design language everywhere**: near-black surface `#0f1115` (panels `#161a22`, borders `#232a36`), text `#e6e6e6`/muted `#8b93a7`, accent `#7aa2f7`, per-session colors from an 8-swatch palette; UI chrome in the system UI font stack, terminals in Consolas/Cascadia Mono; 8 px spacing grid; 6–8 px radii; hover/active states on every interactive element with 120–150 ms ease transitions; visible focus rings for keyboard use.
- **Interactions are direct**: drag-drop, double-click rename, right-click menus, hover affordances — never a settings page where a gesture would do.
- **Lightweight is a feature**: no UI framework/component libraries, no DnD or animation deps — hand-rolled, small, fast. Cold start must feel instant; zero jank while dragging or streaming terminal output.
- **Acceptance question for every UI diff** (Fable applies it at review, with screenshots of the running app): "would this make someone switch terminals?" — not "does it render."

## Worker protocol

Headless one-shot runs: `claude-x <alias> -p <brief> --dangerously-skip-permissions --max-turns <cap>` in `C:\Dev\TermX`, logged to the session scratchpad. One writer at a time unless tasks touch disjoint directories (T2 `ui/src-tauri` ∥ T3 `ui/src`). Workers do not commit, do not touch `host/src`, docs, or specs, and end by printing changed files + verify output. Fable reviews the diff, runs verify independently, then commits or bounces with feedback (max two bounces, then reassign or do it inline). Hook failures mentioning pytest are environmental noise for this repo.

## Order

T1 → (T2 ∥ T3) → T4 → (T5 ∥ T6) → T7 → T8 → T9. Ship gate: T8's kill-and-relaunch e2e green — that is the v1 stability promise made observable.
