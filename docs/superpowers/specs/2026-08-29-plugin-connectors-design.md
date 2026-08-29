# TermX Plugin & Connector System — Design Spec

Date: 2026-08-29 · Status: awaiting Michael's review
Evidence: three code scouts (daemon, UI, Showroom) with file:line citations; load-bearing claims re-verified in source where scouts disagreed.

## 0. Vision

Plugins make TermX extensible in three directions — **web panels** living as workspace citizens, **declarative chrome** (rail buttons, status widgets, menu entries), and **terminal automation** — all built on ONE connector model rather than three runtimes. A plugin is a separate local process in any language; TermX ensures it is running, embeds its web UI, and exchanges capability-gated messages with it. First plugins: **Showroom** (artifact hub, already half-wired), then a page-design workflow plugin and a visual email manager (each will get its own spec; this spec only ensures the platform can host them).

**Non-goals (explicitly out):** a VS Code-style JS extension host inside TermX's renderer (revisit only if declarative chrome proves insufficient); a plugin marketplace; cross-machine plugins; sandboxing beyond process isolation + capability gating (plugins are Michael's own local tools).

## 1. Architecture: one connector model, three phases

```
Phase 1  PANELS      manifest + registry + ensure-up lifecycle + iframe panes.
                     Zero daemon changes; the only native work is four small
                     src-tauri commands (§3a). Showroom embedded.
Phase 2  CONNECTORS  UI <-> plugin WebSocket (UI connects as client), request-id
                     envelope, capability grants: terminal.open, path.open/reveal,
                     notify, sessions.list/focus. Declarative rail chips + status
                     widgets. Still zero daemon changes.
Phase 3  AUTOMATION  daemon-side plugin principals (built ON the shared-sessions
                     spec's Phase 0, never beside it), per-plugin tokens, terminals
                     read/write with writer lease, daemon event stream, MCP adapter.
```

The load-bearing insight from scouting: **Phases 1–2 need no daemon work at all** (the UI's Rust shell does gain four small commands — §3a — because today it can neither spawn a process, read a file outside its own data dir, nor make an HTTP request). The UI's CSP already allows `ws://127.0.0.1:*`, Showroom already serves an embeddable UI and a WS endpoint, and a single WebSocket is bidirectional — the plugin can call TermX over the same socket TermX opened to it. The daemon enters the picture only when plugins need raw terminal I/O and events, and that lands on the same per-connection Principal substrate the teams spec (2026-08-23, Phase 0) already requires. One implementation, two consumers.

## 2. Plugin registry & manifest

**Registry file:** `<TermX data dir>\plugins_v1.json` (same tolerant, all-optional parsing idiom as `ui_state_v1.json`):

```json
{ "plugins": { "showroom": {
    "path": "C:\\Users\\mjfos\\code\\showroom",
    "enabled": true,
    "grants": ["terminal.open", "path.open", "notify"]
} } }
```

External absolute paths live HERE (user data, machine-specific by nature) — never in code, honoring the portability rule. Adding a plugin = "Add plugin folder…" in Settings pointing at a directory containing `termx-plugin.json`.

**Manifest: `termx-plugin.json` at the plugin root.** TermX's own schema — deliberately NOT Showroom's existing `plugin.json`, whose `capabilities` field means "methods I provide" (the opposite of a permission request) and whose `standaloneUrl` hardcodes a port that walks. Both files can coexist; ours is authoritative for TermX.

```json
{
  "manifest": 1,
  "id": "showroom",
  "name": "Showroom",
  "icon": "🖼",
  "start": { "command": "node", "args": ["server/showroom.js"] },
  "singleton": true,
  "discovery": { "runtimeFile": "%APPDATA%\\Showroom\\runtime.json",
                 "healthPath": "/api/health" },
  "panel": { "path": "/" },
  "connector": { "wsPath": "/plugin" },
  "requests": ["terminal.open", "path.open", "notify", "sessions.read"],
  "chrome": { "chips": [{ "id": "showroom.open", "tray": "sidebar-footer", "icon": "🖼", "label": "Showroom" }] }
}
```

- `start.command`/`args` run with cwd = plugin root. Env additions: `TERMX=1`, `TERMX_PLUGIN_ID`.
- `singleton: true` means "one PROCESS system-wide": ensure-up never spawns while the health probe passes, and a spawned process exiting 0 quickly is expected (§3). It says nothing about panes — any number of panes may show the same plugin.
- `%VAR%` in `discovery.runtimeFile` is expanded by TermX, Windows-style, at read time. v1 is Windows-only, like the rest of TermX.
- `requests` = capabilities the plugin ASKS FOR (granted per-plugin in Settings; `grants` in the registry records the decision). Vocabulary is fixed by this spec, extended only by future specs.
- `chrome` is declarative — TermX renders it natively (§6); no plugin code runs in TermX.

## 3. Lifecycle: "ensure up", not "own the process"

Scouting verdict: Showroom is an always-on singleton (autostart entry, exits 0 within ~1s if an instance already runs). So TermX's contract is **ensure-up**:

1. Read `discovery.runtimeFile` → `{ port, token, pid, version }`. Probe `http://127.0.0.1:<port><healthPath>` expecting `{ok: true}` AND a string `version` — the version string is what makes the probe identity-aware; a foreign app on a recorded port must not read as "up" (Showroom's own `server/runtime.js:41` requires exactly this pair).
2. Healthy → use it. Not healthy → spawn `start.command`, then poll the runtime file + health (fresh timestamp) up to 10s. **A fast exit-0 is NOT a crash** — it is the singleton saying "already running"; only a failed health poll after spawn is a launch failure.
3. On launch failure the panel pane renders the existing DeadPane affordance with "Relaunch" (maps onto `restartPane`'s existing restart path) and the captured stderr tail.
4. TermX never kills a plugin process on exit (they are standalone tools). A per-plugin "Stop" action in Settings may POST a plugin-provided shutdown route later; v1 omits it.
5. `discovery.runtimeFile` is re-read on every (re)connect — Showroom rotates its token per boot, so cached tokens are wrong by design.

### 3a. Native commands (src-tauri), Phase 1

The UI's Rust shell cannot do ANY of the lifecycle today — its dependency set is tauri + the dialog plugin, its commands include no process spawn, no HTTP, and `read_app_file` is pinned to the app data dir (storage.rs `data_dir_for`). Phase 1 therefore adds four commands, granted in `capabilities/default.json` for `main` and `aux-*`:

- `plugin_spawn { command, args, cwd }` — detached spawn, returns pid; captures a bounded stderr tail for the failure UI.
- `plugin_read_runtime { path }` — reads the plugin's runtime file at an arbitrary (registry-validated) absolute path; deliberately NOT `read_app_file`.
- `plugin_probe { url }` — HTTP GET from Rust with a short timeout. Doing the probe in Rust is a design choice, not a convenience: a webview `fetch` to `http://127.0.0.1:*` violates the CSP's `connect-src`, and we widen `frame-src` only (§4), never `connect-src`.
- `open_path { path } / reveal_path { path }` — OS-default open / Explorer reveal, backing §5's `path.open`/`path.reveal` (may land with Phase 2).

## 4. Panels (Phase 1)

**Decision: out-of-band pane binding ("a2"), not a new layout node kind.** The scout confirmed the alternative is catastrophic on downgrade: `parseLayout` is all-or-nothing (`parseSplit` returns null on an unknown `kind`, layout.ts:593 → whole layout null → reconcile rule 3 rebuilds a flat layout from live sessions; nothing is written at that moment, but the very next structural mutation persists the flattened layout, and the loss is permanent). An old build opening a new-style blob would silently destroy the workspace. Out-of-band binding keeps the serialized blob's shape byte-identical, which the codebase already documents as its idiom twice (reconcile.ts:6-11, uiState.ts:29-32).

Mechanics:

- A plugin pane is a normal `{ kind: "pane", sessionId }` leaf whose id comes from a **reserved range: `sessionId >= 0x8000_0000`** (2^31). Daemon ids are small sequential u32s; `validateSplit` only requires u32 + global uniqueness, so reserved ids are valid today. Allocation: random in-range with collision re-roll against `sessionIdsInLayout`.
- **The binding lives in its OWN file, `<TermX data dir>\plugin_panes_v1.json`: `Record<string, { pluginId: string; path?: string }>`** (string keys — JSON object keys are strings, matching the file idiom of `chatPanes`/`sshPanes`). NOT in `ui_state_v1.json`, for two reasons the adversarial review proved: (a) `parseUiState` whitelists known fields and `serializeUiState` writes exactly that, so one boot of an OLD build plus any ui-state write would DELETE an unknown key — a separate file is invisible to old builds and survives downgrade untouched; (b) every window rewrites `ui_state_v1.json` whole from its own in-memory snapshot with no single-writer discipline, so cross-window clobbering would silently drop bindings. The bindings file gets the layout's discipline instead: **the MAIN window is its only writer**, aux windows receive binding updates over the windowBus (a new `pluginPanes` broadcast message kind riding alongside `termx:layout-state`) and never persist them.
- `SplitLayout.tsx`'s pane branch (currently a hardcoded Terminal/Sleeping/Dead three-way at :346-455) gains a fourth: plugin binding present → `<iframe src="http://127.0.0.1:<port><panel.path>">` with the pane chrome (title bar, focus ring) TermX already draws.
- `reconcile` and the `paneStates` builder (WorkspaceController.ts:679-701) are taught the reserved range: a reserved-id pane WITH a binding is never marked dead by the host-session sweep; its liveness comes from the plugin health probe (plugin down → DeadPane with "Relaunch"). A reserved-id pane WITHOUT a binding (the binding file was lost or never synced) is REQUIRED to render as an ordinary dismissible DeadPane — never an undefined ghost. "Relaunch" on a plugin pane is a NEW handler that re-runs ensure-up keeping the pane id; it must NOT reuse `restartPane`, which creates a real host session and swaps the pane's id out of the layout (WorkspaceController.ts:1658-1760), destroying the binding.
- Binding cleanup: dismissing a plugin pane, or closing the tab holding it, deletes its `plugin_panes_v1.json` entry (alongside the `applyClosedSessions` path, WorkspaceController.ts:2464-2470) so orphan bindings never accumulate.
- **Downgrade audit (the correctness bar for this whole section, verified end-to-end by the adversarial review):** an OLD build loading a layout containing a plugin pane sees a valid pane whose id matches no host session → `reconcile` never prunes panes (dead ids are reported out-of-band) → DeadPane ("session ended") → Dismiss prunes locally WITHOUT hitting the daemon, because `closeSessions` early-succeeds for ids the UI's session map doesn't know (WorkspaceController.ts:2443-2447). That guard is load-bearing — a regression test must pin it, since without it Dismiss would fail on the daemon's "no session" error and the pane would be undismissable. The bindings file is untouched by old builds entirely (separate file), so upgrading back restores the panel. Degraded, visible, recoverable — never silent loss. Aux-window forwarding on mixed builds parses fine for the same reason (the blob shape never changed).
- **CSP:** add `frame-src http://127.0.0.1:* http://localhost:*` to `tauri.conf.json` (today framing falls to `default-src 'self'` and every plugin URL is blocked). This widens framing to any localhost port; acceptable for a local single-user tool, and a daemon-side reverse proxy consolidating plugin UIs under one port is noted as later hardening if it ever isn't.
- "Open as tab" = a new tab whose split is a single plugin pane; "open as split" falls out for free (any pane can be a plugin pane).
- Every tab stays mounted (App.tsx:1147-1158), so N plugin tabs = N live iframes. v1 accepts this (plugin count is small); the terminal sleep machinery's plugin analogue (unmount iframe for hidden plugin panes after a timeout) is a fast-follow, not v1.
- Known embedded-Showroom papercuts, accepted for v1: iframe-in-iframe for its previews; `navigator.clipboard` may be denied in the webview (Showroom already has a fallback message); its bare single-key shortcuts (e.g. `c`) only fire when the iframe has focus.

## 5. Connector protocol v1 (Phase 2)

**Transport:** TermX's MAIN window opens one WebSocket per enabled plugin to `ws://127.0.0.1:<port><connector.wsPath>` (for Showroom this is its existing `/plugin` channel — TermX-as-client is the direction Showroom already shipped). **Auth is a first frame `{"auth": "<token>"}`** with the token freshly read from the runtime file — specified here because it is what Showroom's `/plugin` already expects (ws.js:81); the manifest can later name other schemes via `connector.auth`. Only the main window holds connector sockets. Plugin-triggered actions that concern an aux window (a panel living there calls `sessions.focus`) travel main→aux over the windowBus, which today carries ONLY whole-layout messages — Phase 2 adds command message kinds (`focusSession`, `openTerminal`) to it; this is real windowBus work, not a free ride.

**Envelope:** requests `{ id, method, params }` ↔ replies `{ id, result | error: { code, message } }`, correlated by `id` in BOTH directions (the daemon protocol's lack of request ids is a lesson, not a template) — plus id-less **notifications `{ event, data }`** for pushes (Showroom's existing `{event: "fresh", artifact}` broadcast maps onto this form nearly as-is). Unknown methods return an error; unknown notifications are ignored — both sides must tolerate vocabulary they don't know, because plugin and TermX versions move independently.

**Calls TermX serves (capability-gated by `grants`):**

| method | gate | behaviour |
|---|---|---|
| `terminal.open` `{cwd, command?, target?: "tab"\|"split"}` | terminal.open | New terminal at `cwd`; if `command` present, typed + submitted after shell-ready. THE killer feature: Showroom's "copy `cd …; claude --resume …` to clipboard" ritual becomes one click. |
| `path.open` `{path}` / `path.reveal` `{path}` | path.open | Open file with OS default / reveal in Explorer — via TermX, replacing Showroom's only Windows-only code path. |
| `notify` `{title, body?}` | notify | Rides the existing attention machinery (taskbar flash + rail badge), same rules as a session bell. |
| `sessions.list` `{}` | sessions.read | `[{ sessionId, cwd, profile, alive, tabId, tabTitle }]` — joined from the UI's snapshot (the UI already holds all of this; no daemon change). NO `busy` field in v1: busy exists only as an on-demand probe RPC, and per-session fan-out probing is not worth it yet. |
| `sessions.focus` `{sessionId}` | sessions.read | Activate the tab/pane holding that session (turns Showroom's Conversations view into a live switcher). |

**Calls the plugin serves (optional, plugin-defined):** TermX forwards user intents — v1 defines only `openPath {path}` (user asks the plugin to show something, e.g. a context-menu "Show in Showroom"). Showroom's manifest `events.consumes: ["termx:open-path"]` was aspirational; this makes it real under our envelope.

**Grant UX:** first enable of a plugin shows its `requests` list with per-capability toggles; decisions persist to `grants` in `plugins_v1.json`. Ungranted calls fail with a distinct error code so plugins can degrade gracefully.

## 6. Declarative chrome (Phase 2)

- **Chips:** the existing action registry is the extension point (`actions/registry.ts`: `ActionChip`, `registerAction` idempotent by id, tray persistence that silently drops unknown ids). The manifest field is `chrome.chips` with a real `tray` value from `TrayId` (`"sidebar-footer" | "pane-toolbar" | "viewer-header"` — there is no tray literally called "rail"; sidebar-footer is the one Michael means). Registration alone is NOT enough to render: `trayChipIds` resolves either the static `DEFAULT_TRAYS` or a user-persisted list, and neither ever contains a new plugin id. So the spec defines the missing rules — **on first enable, the plugin's chip ids are APPENDED to the persisted tray list (creating it from defaults if absent); on disable/removal they are removed**. Unknown-id filtering already handles the crash-left cases. Small but real work, not free.
- **Status-bar widgets:** `StatusBar.tsx` has a closed prop set today; it gains `widgets?: ReactNode` and plugins contribute small text/icon widgets via manifest. Small new seam, real change — Phase 2.
- **Context-menu entries:** menu content is hand-authored inside Sidebar.tsx with no registry; a menu-contribution registry is Phase 2.5 at the earliest and only if a plugin actually needs it (YAGNI).

## 7. Settings & permissions surface

`TermxSettings` is a flat static interface (its tests pin the exact section list and one-section-per-key), so per-plugin state cannot be settings fields. A new `"plugins"` settings SECTION renders a custom panel branch (SettingsSurface gains its first non-field section) backed by `plugins_v1.json`: list of plugins with enable toggle, grant toggles, health dot, "Add plugin folder…", stderr tail on launch failure. Section-list test updated accordingly.

## 8. Daemon bus & automation (Phase 3)

Only when a plugin needs raw terminal I/O or push events does the daemon change — and then strictly ON the teams spec's Phase 0 substrate (per-connection Principal, capability gating, generalized `handle_conn`). Build once, serve both specs. Requirements pinned by scouting:

- **Auth:** extend `ClientMsg::Auth` with optional `role`/`plugin_id` (serde defaults keep the shipped UI wire-compatible, same trick as `shell_integration`). Per-plugin tokens are SEPARATE secrets in a daemon-owned file — never the `runtime.json` token, which currently grants everything including `Shutdown`. Token comparison becomes constant-time while in there.
- **Version wall (verified in source, scouts disagreed):** `parseHostMessage` THROWS on any unknown message type and that throw terminates the whole socket (client.ts:985 → terminate at :620-621). Therefore the daemon may only push new message types to clients that opted in at Auth (e.g. `Auth { proto: 2 }`). No new tag ships without that negotiation.
- **Gates day one:** `Shutdown` and `Resize` UI-only, ever. `CloseSession` UI-only by default. `Frame::Input` = `terminals.write` AND a **writer lease** (one writer per session at a time; input has no arbitration today and interleaves at chunk granularity mid-escape-sequence). `SetLayout` never granted to plugins — layout ops forward to the UI (single-writer rule), and SetLayout is last-writer-wins with no notification.
- **Relay machinery must be built, not borrowed:** the daemon has no connection registry and no unsolicited-push path to the UI. A `Mutex<HashMap<ClientId, Sender<Outbound>>>` beside (not inside) `Registry`, request-id envelope for forwarded requests.
- **Backpressure policy:** the "our own UI always drains" assumption (server.rs:445-447) is retired for plugin principals — `try_send` and disconnect the plugin on a full queue; bound concurrent plugin attaches (replay amplification is per-connection ring-size bytes).
- **Events group** (bell, title, command boundaries) requires new daemon-side OSC scanning beside `CwdScanner` — only OSC 9;9 (cwd) is parsed daemon-side today. Scoped to its own task within Phase 3.
- **MCP face:** a thin adapter process exposing granted connector methods as MCP tools, so Claude inside TermX can drive TermX (open tabs, arrange panes, focus sessions). It authenticates as a plugin; zero new capability semantics.

## 9. Showroom as plugin #1

Works embedded TODAY (no frame restrictions; loopback HTTP; same-origin relative fetches). TermX side: manifest above + ensure-up + panel + connector client. Showroom side is MICHAEL'S list (he refines Showroom himself — noted, not scheduled here):

- `plugin.json`'s `standaloneUrl` hardcodes port 7345 but the port walks 7345→7355 — worth fixing or dropping in favor of the runtime file.
- Its `/plugin` WS methods (`query`/`get`/`open`) predate this envelope, its errors are bare strings, and — the material gap — its handler is request-only: it has NO pending-request table, so Showroom cannot CALL TermX over the socket today. The Phase-2 killer feature (`terminal.open` from a Showroom button) therefore requires either a small Showroom-side client addition or a TermX-shipped compat shim. Joint call at Phase-2 time; §12's P2 criterion is explicitly gated on it.
- The env contract is `TERMX_SESSION_ID` (the `_ID` form is authoritative; Showroom's CLAUDE.md notes the spec/code mismatch).

## 10. Security model (v1 posture, stated plainly)

Localhost is the trust boundary, as it already is for the daemon (`runtime.json` readable = full daemon authority) and Showroom (`/api/session` hands its token to any localhost caller). Plugins are Michael's own tools. What the design still enforces: per-plugin capability grants with explicit UX; plugins NEVER receive the daemon token in Phases 1–2 (they can't touch the daemon at all); Phase 3 plugin tokens are separate, scoped, and stored daemon-side; resize/shutdown/layout are permanently UI-only. Hardening beyond that (proxying panel origins, constant-time compares) is noted where it belongs and none of it blocks v1.

## 11. Risks

| risk | mitigation |
|---|---|
| Old build + plugin-pane layout | a2 binding: blob shape unchanged; degrades to a dismissible DeadPane, never silent loss (§4 audit) |
| Plugin process dies under an open panel | health probe flips pane to DeadPane + Relaunch |
| Plugin flood/stall (P3) | try_send + disconnect; writer lease; attach bounds |
| New daemon msg kills old UI (P3) | proto negotiation at Auth, pinned in §8 |
| iframe resource creep | small plugin count v1; sleep-analogue fast-follow |
| Capability vocab drift vs Showroom's `capabilities` | our manifest uses `requests`/`provides` naming; Showroom's file untouched |

## 12. Success criteria

- P1: Showroom opens as a TermX tab AND as a split pane; survives TermX relaunch; plugin down renders recoverable DeadPane; downgrade test proves an old build shows DeadPane and loses nothing.
- P2: one click in embedded Showroom opens a terminal cd'd to an artifact with `claude --resume <id>` typed and run (DEPENDS on the named Showroom-side change or compat shim, §9); grant toggles actually gate; the sidebar-footer chip opens the panel.
- P3: an MCP-connected Claude lists sessions and focuses one; a plugin holding `terminals.write` cannot type while the user's writer lease is active; `Shutdown` from a plugin principal is refused.
