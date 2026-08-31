# Plugin System Phase 1 (Panels) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution — the tasks share one binding model and the layout invariants; judgment stays in the main thread per Michael's standing routing). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A plugin (Showroom first) declared by a manifest opens as a real TermX tab or split pane, survives relaunch, degrades to a recoverable dead pane when its process is down, and cannot damage the workspace on downgrade.

**Architecture:** Plugin panes are ordinary `{kind:"pane", sessionId}` leaves with ids in a reserved range (≥ 2^31); the plugin binding lives out-of-band in a main-window-owned `plugin_panes_v1.json`, synced to aux windows over the windowBus. The UI's Rust shell gains three small commands (spawn, read runtime file, HTTP probe). The daemon is untouched.

**Tech Stack:** existing — React 19 / TS / vitest; Tauri 2.11.5 Rust shell (+ `ureq` for the probe); no daemon changes.

**Spec:** `docs/superpowers/specs/2026-08-29-plugin-connectors-design.md` (§2 registry/manifest, §3 + §3a lifecycle/native, §4 panels, §7 settings, §9 Showroom, §12 P1 criteria).

## Global Constraints

- Daemon and wire protocol: zero changes.
- The serialized layout blob's SHAPE never changes (no new node kinds, no new fields) — spec §4.
- Plugin pane ids: `sessionId >= 0x8000_0000`, u32, unique across the layout (`validateSplit` already enforces u32 + uniqueness).
- Bindings file `plugin_panes_v1.json`: MAIN window is the only writer; aux windows adopt via bus, never persist.
- A reserved-id pane WITHOUT a binding renders a dismissible DeadPane (spec §4 required rule).
- No absolute machine paths in code; plugin folder paths live only in `plugins_v1.json` (user data).
- CSP: widen `frame-src` only; `connect-src` untouched (probe runs in Rust).
- Gates per task from `C:\Dev\TermX\ui`: `npx tsc -b`, affected vitest files; full `npx vitest run` before each commit. Rust: `cargo test` from `C:\Dev\TermX\ui\src-tauri` for T2.
- Never touch Michael's running TermX/daemon; staging is a `.prevN` rename rotation (next `.prev25`).

---

### Task 1: Manifest parsing + plugin registry store

**Files:**
- Create: `ui/src/plugins/manifest.ts`, `ui/src/plugins/registry.ts`, `ui/src/plugins/bundled.ts`
- Modify: `ui/src/native/appFiles.ts` (AppFileName union), `ui/src-tauri/src/storage.rs:20-27` (ALLOWED_FILES)
- Test: `ui/src/plugins/__tests__/manifest.test.ts`, `ui/src/plugins/__tests__/registry.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PluginManifest {
    manifest: 1; id: string; name: string; icon: string;
    start: { command: string; args: string[] };
    singleton: boolean;
    discovery: { runtimeFile: string; healthPath: string };
    panel: { path: string };
  }
  export function parseManifest(value: unknown): PluginManifest | null;   // null = malformed; reasons via parseManifestErrors(value): string[]
  export function expandEnv(path: string, env: Record<string, string | undefined>): string; // %VAR% → value, unknown VAR left verbatim
  export interface PluginEntry { path: string; enabled: boolean; grants: string[] }
  export interface PluginsV1 { plugins: Record<string, PluginEntry> }
  export function parsePluginsFile(text: string | null): PluginsV1;        // tolerant: bad → { plugins: {} }
  export function serializePluginsFile(state: PluginsV1): string;
  export const BUNDLED_MANIFESTS: Record<string, PluginManifest>;         // "showroom" (spec §2 example, minus chrome/requests/connector — those are P2)
  export function manifestFor(id: string, fileText: string | null): PluginManifest | null; // file wins; bundled fallback by id
  ```
- The registry deliberately ignores `requests`, `chrome`, and `connector` keys in Phase 1 (unknown keys tolerated, not validated).

- [x] **Step 1: Failing tests** — `manifest.test.ts`:
  ```ts
  it("parses the Showroom manifest", () => {
    expect(parseManifest(showroomJson)).toMatchObject({ id: "showroom", singleton: true, discovery: { healthPath: "/api/health" } });
  });
  it("rejects a manifest missing start.command or with a non-1 version", () => {
    expect(parseManifest({ ...showroomJson, manifest: 2 })).toBeNull();
    expect(parseManifestErrors({ ...showroomJson, start: {} })).toContain("start.command");
  });
  it("expands %APPDATA% Windows-style and leaves unknown vars alone", () => {
    expect(expandEnv("%APPDATA%\\Showroom\\runtime.json", { APPDATA: "C:\\U\\x\\AppData\\Roaming" })).toBe("C:\\U\\x\\AppData\\Roaming\\Showroom\\runtime.json");
    expect(expandEnv("%NOPE%\\a", {})).toBe("%NOPE%\\a");
  });
  ```
  `registry.test.ts`: tolerant parse (`null`, garbage, missing `plugins` → empty), round-trip, `manifestFor("showroom", null)` returns the bundled manifest, `manifestFor("showroom", fileText)` prefers the file, `manifestFor("unknown", null)` is null.
- [x] **Step 2: Run** `npx vitest run src/plugins` — FAIL (modules missing).
- [x] **Step 3: Implement** the four exports + bundled Showroom manifest:
  ```ts
  export const BUNDLED_MANIFESTS: Record<string, PluginManifest> = {
    showroom: {
      manifest: 1, id: "showroom", name: "Showroom", icon: "🖼",
      start: { command: "node", args: ["server/showroom.js"] },
      singleton: true,
      discovery: { runtimeFile: "%APPDATA%\\Showroom\\runtime.json", healthPath: "/api/health" },
      panel: { path: "/" },
    },
  };
  ```
  Add `"plugins_v1.json" | "plugin_panes_v1.json"` to `AppFileName` and to `ALLOWED_FILES` (array length 6 → 8).
- [x] **Step 4: Run** the two test files + `npx tsc -b` — PASS. `cargo test` in `ui/src-tauri` still green (ALLOWED_FILES is a const; any pinning test updates its count).
- [x] **Step 5: Commit** `feat(plugins): manifest parsing + registry store (P1 T1)`.
> **As built (2026-08-31):** initial T1 commit + review fixes 9037dd6. `readManifest(folder)` added to `PluginNative` later (T5/T7) so a plugin folder's own `termx-plugin.json` overrides the bundled table when it parses and its id matches; bundled stays the fallback.

### Task 2: Native commands — spawn, read runtime file, HTTP probe

**Files:**
- Create: `ui/src-tauri/src/plugins.rs`
- Modify: `ui/src-tauri/src/lib.rs:30-51` (register), `ui/src-tauri/Cargo.toml` (add `ureq = { version = "2", default-features = false }`), `ui/src-tauri/capabilities/default.json` (`allow-plugin-spawn`, `allow-plugin-read-runtime`, `allow-plugin-probe`)
- Test: `ui/src-tauri/src/plugins.rs` `#[cfg(test)]`; `ui/src/__tests__/capabilities.test.ts` (extend pin)

**Interfaces:**
- Produces (Tauri commands, all `Result<_, String>`):
  ```rust
  #[tauri::command] pub fn plugin_read_runtime(path: String) -> Result<Option<String>, String>
      // absolute path required; None when missing; bounded to 64 KiB
  #[tauri::command] pub async fn plugin_probe(url: String, timeout_ms: u64) -> Result<String, String>
      // GET; only http://127.0.0.1:<port>/... or http://localhost:<port>/... accepted; body returned; timeout clamped 200..5000
  #[tauri::command] pub fn plugin_spawn(command: String, args: Vec<String>, cwd: String) -> Result<u32, String>
      // detached (CREATE_NO_WINDOW | DETACHED_PROCESS), stdio null except stderr → bounded 8 KiB tail kept in a process-local map keyed by pid; returns pid
  #[tauri::command] pub fn plugin_stderr_tail(pid: u32) -> Result<String, String>
  ```
- TS wrapper produced for T3: `ui/src/plugins/native.ts` — `PluginNative { readRuntime(path): Promise<string|null>; probe(url, timeoutMs): Promise<string>; spawn(command, args, cwd): Promise<number>; stderrTail(pid): Promise<string> }` + `tauriPluginNative`.

- [x] **Step 1: Failing Rust tests** in `plugins.rs`:
  ```rust
  #[test] fn probe_rejects_non_loopback() { assert!(validate_probe_url("http://example.com/").is_err()); assert!(validate_probe_url("http://127.0.0.1:7345/api/health").is_ok()); }
  #[test] fn read_runtime_requires_absolute() { assert!(plugin_read_runtime("relative\\runtime.json".into()).is_err()); }
  #[test] fn read_runtime_missing_is_none() { let p = std::env::temp_dir().join("termx-no-such-runtime.json"); assert_eq!(plugin_read_runtime(p.to_string_lossy().into()).unwrap(), None); }
  #[test] fn spawn_records_stderr_tail() { let pid = plugin_spawn("cmd".into(), vec!["/c".into(), "echo boom 1>&2".into()], std::env::temp_dir().to_string_lossy().into()).unwrap(); std::thread::sleep(std::time::Duration::from_millis(500)); assert!(plugin_stderr_tail(pid).unwrap().contains("boom")); }
  ```
  `capabilities.test.ts`: `expect(capability.permissions).toContain("allow-plugin-spawn")` (+ read-runtime, probe, stderr-tail).
- [x] **Step 2: Run** `cargo test plugins` — FAIL (module missing); vitest capabilities — FAIL.
- [x] **Step 3: Implement.** Probe uses `ureq::AgentBuilder::new().timeout(...)` inside `tauri::async_runtime::spawn_blocking` (same shape as `ssh_probe`, ssh.rs:244-257). Spawn uses `std::process::Command` with `creation_flags(0x08000000 | 0x00000008)` on Windows, `.stderr(Stdio::piped())`, a thread draining stderr into `static TAILS: Mutex<HashMap<u32, VecDeque<u8>>>` capped at 8 KiB. Register the four commands in `generate_handler!`, add the four `allow-*` grants.
- [x] **Step 4: Run** `cargo test` (all), `npx tsc -b`, capabilities test — PASS.
- [x] **Step 5: Commit** `feat(plugins): native spawn/read-runtime/probe commands (P1 T2)`.
> **As built:** commits a188faa / bff7170 / 04ba5b0 / daaafb1 / 3fd66fe. Stderr goes to a per-spawn log file under `<data dir>\plugin-logs` (pruned to 16 files) instead of a pipe + 8 KiB ring — a drained pipe EPIPEs the plugin when TermX exits; `plugin_stderr_tail` reads the last 8 KiB with `SeekFrom::End`. Runtime/manifest reads and spawn are `spawn_blocking`/async commands. `read_manifest_in`: missing folder = Err, missing file = Ok(None). Per-spawn logs have no byte cap (deferred).

### Task 3: Ensure-up lifecycle

**Files:**
- Create: `ui/src/plugins/lifecycle.ts`, `ui/src/plugins/native.ts`
- Test: `ui/src/plugins/__tests__/lifecycle.test.ts`

**Interfaces:**
- Consumes: `PluginManifest` (T1), `PluginNative` (T2 wrapper).
- Produces:
  ```ts
  export interface PluginRuntime { port: number; token: string; version: string; url: string /* http://127.0.0.1:<port> */ }
  export type EnsureUpResult = { ok: true; runtime: PluginRuntime } | { ok: false; reason: string; stderrTail: string };
  export function ensureUp(manifest: PluginManifest, pluginPath: string, deps: { native: PluginNative; env: Record<string,string|undefined>; now: () => number; sleep: (ms: number) => Promise<void>; spawnTimeoutMs?: number /* 10000 */ }): Promise<EnsureUpResult>;
  export function parseRuntimeFile(text: string | null): { port: number; token: string; version?: string } | null;
  export function isHealthy(body: string): boolean;   // JSON with ok === true AND typeof version === "string"
  ```
- Algorithm (spec §3): read runtime → if parse ok, probe `${url}${healthPath}` → healthy → return. Else spawn (`command`, `args`, cwd = pluginPath) → poll every 250 ms: re-read runtime file, probe; stop at first healthy or when `spawnTimeoutMs` elapses → `{ok:false, reason:"health probe never passed", stderrTail}`. A spawn that throws → `{ok:false, reason: error}`. **Never treat a fast process exit as failure** (there is no exit signal at all — only the probe decides).

- [x] **Step 1: Failing tests** with a fake native (scripted runtime-file/probe answers + a call log) and fake timers:
  - already healthy → no spawn call, returns runtime with url from the port.
  - runtime missing → spawn once → healthy on 3rd poll → ok; spawn args `("node", ["server/showroom.js"], "<pluginPath>")`.
  - probe body `{ok:true}` WITHOUT version → treated unhealthy (identity rule).
  - never healthy → `{ok:false}` after 10 s with the stderr tail included; exactly one spawn.
  - token is re-read: two successive `ensureUp` calls with a rotated token return the new one.
- [x] **Step 2: Run** `npx vitest run src/plugins/__tests__/lifecycle.test.ts` — FAIL.
- [x] **Step 3: Implement** per the algorithm; `native.ts` wraps the four `invoke`s.
- [x] **Step 4: Run** tests + `npx tsc -b` — PASS.
- [x] **Step 5: Commit** `feat(plugins): ensure-up lifecycle (P1 T3)`.
> **As built:** commits cb0cce8 / f4d2348; `PROBE_TIMEOUT_MS`, `DEFAULT_SPAWN_TIMEOUT_MS`, `POLL_INTERVAL_MS` exported (fa0cdfa) so the aux observe loop shares the beat. Lifecycle is MAIN-ONLY: an aux window's `ensureUp` observes (runtime file + probe, never spawns) and answers "The plugin is not running. Relaunch it from the main window."

### Task 4: Pane bindings store + cross-window sync

**Files:**
- Create: `ui/src/plugins/paneBindings.ts`
- Modify: `ui/src/workspace/windowBus.ts` (new event + methods), `ui/src/workspace/bootstrapWorkspace.ts` (wire main-only writer; aux adopts)
- Test: `ui/src/plugins/__tests__/paneBindings.test.ts`, `ui/src/workspace/__tests__/windowBus.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  export interface PluginPaneBinding { pluginId: string; path?: string }
  export type PluginPanesV1 = Record<string, PluginPaneBinding>;   // key = String(sessionId)
  export function parsePluginPanes(text: string | null): PluginPanesV1;  // tolerant
  export class PaneBindingsStore {
    constructor(opts: { initial: PluginPanesV1; save: ((text: string) => Promise<void>) | null /* null = aux window: never persists */; onBroadcast?: (state: PluginPanesV1) => void });
    getSnapshot(): PluginPanesV1; subscribe(l: () => void): () => void;
    bind(sessionId: number, binding: PluginPaneBinding): void;   // persists (main) + broadcasts
    unbind(sessionIds: readonly number[]): void;
    adopt(state: PluginPanesV1): void;                            // from bus; never persists
  }
  export const PLUGIN_PANE_MIN_ID = 0x8000_0000;
  export function isPluginPaneId(id: number): boolean;
  export function allocatePluginPaneId(taken: ReadonlySet<number>, random?: () => number): number; // re-roll on collision
  ```
- windowBus: `PLUGIN_PANES_EVENT = "termx:plugin-panes"`; `WindowBus.broadcastPluginPanes(state: JsonValue): Promise<void>`; `WindowBus.onPluginPanes(handler)`. Loopback + tauri implementations both.
- bootstrapWorkspace: main → `new PaneBindingsStore({ initial: parsed, save: (t) => appFiles.write("plugin_panes_v1.json", t), onBroadcast: (s) => bus.broadcastPluginPanes(s) })`; aux → `save: null`, subscribes `bus.onPluginPanes` → `adopt`. Exposed on `BootstrappedWorkspace.pluginPanes`.

- [x] **Step 1: Failing tests** — store: bind persists exactly once with string keys and broadcasts; unbind removes; aux store (`save: null`) never calls save even after bind; adopt replaces state without persisting; `allocatePluginPaneId` returns ≥ 2^31, re-rolls when the first roll is taken (inject `random`), throws only after 64 collisions. windowBus: loopback delivers plugin-panes to subscribers; tauri fake transport uses `termx:plugin-panes`; `pair()` harness: main bind → aux adopts (`auxFake` never writes the file).
- [x] **Step 2: Run** — FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** the two test files + windowBus + bootstrapWorkspace tests + `npx tsc -b` — PASS.
- [x] **Step 5: Commit** `feat(plugins): pane bindings store synced over the window bus (P1 T4)`.
> **As built:** commits 705f0ee / 106372f / db59e6a; `PaneBindingsStore.flush()` rejects with the first failed save/forward and clears it on the next success; main broadcasts a binding only AFTER its save resolves; `normalizePluginPath` (leading `/` required — T5 addendum). Aux registry replica (main→aux `plugins` channel) deferred to Phase C.

### Task 5: Layout integration — reserved ids, reconcile, pane states, cleanup

**Files:**
- Modify: `ui/src/state/reconcile.ts:105-120` (dead-id sweep), `ui/src/workspace/WorkspaceController.ts` (PaneSessionState union :188, paneStates builder :679-701, new `openPluginTab`/`openPluginSplit`/`relaunchPlugin`, cleanup in `applyClosedSessions` :2464-2470), `ui/src/workspace/bootstrapWorkspace.ts` (pass `pluginPaneIds` to reconcile; hand the store + lifecycle to the controller)
- Test: `ui/src/state/__tests__/reconcile.test.ts`, `ui/src/workspace/__tests__/WorkspaceController.test.ts` (extend)

**Interfaces:**
- `ReconcileOptions` += `pluginPaneIds?: ReadonlySet<number>` — ids in the set are excluded from `deadSessionIds` (they have no host session by design) and never adopted as orphans.
- `PaneSessionState.status` += `"plugin"`; new optional fields `pluginId?: string; pluginUrl?: string | null; pluginHealth?: "starting" | "up" | "down"; pluginError?: string`.
- paneStates builder rule: `isPluginPaneId(id)` AND binding present → `{ status: "plugin", pluginId, pluginUrl: runtime?.url ?? null, pluginHealth, exitCode: null }`; reserved id WITHOUT binding → `{ status: "missing" }` (→ DeadPane, dismissible — spec's required rule).
- Controller (options gain `pluginPanes: PaneBindingsStore`, `plugins: { manifestFor(id), pathFor(id), ensureUp(id): Promise<EnsureUpResult> }`):
  ```ts
  openPluginTab(pluginId: string, groupId?: string | null): string | null;         // allocates id, binds, creates tab { split: { kind:"pane", sessionId } } in this window; kicks ensureUp; returns tabId
  openPluginSplit(tabId: string, anchorSessionId: number, pluginId: string, dir: "row"|"column"): number | null; // reuses the existing split-insertion path (find `splitPane`/`canSplitPane`), binds, kicks ensureUp
  relaunchPlugin(sessionId: number): Promise<void>;  // re-runs ensureUp for the pane's plugin; keeps the id; NEVER restartPane
  ```
  Runtime cache: `pluginRuntimes: Map<pluginId, EnsureUpResult>` published into paneStates; `ensureUp` runs once per plugin per boot (dedup in-flight promise), re-run on relaunch.
- Cleanup: `applyClosedSessions` also calls `pluginPanes.unbind(closedIds)` for reserved ids; `dismissPane` on a reserved id prunes the pane locally and unbinds — must NOT send `CloseSession` (pin the existing early-success guard at WorkspaceController.ts:2443-2447 with a test).

- [ ] **Step 1: Failing tests** — reconcile: a layout referencing reserved id 2147483648 with `pluginPaneIds` containing it → not in `deadSessionIds`, layout returned by identity; WITHOUT the option → reported dead (old-build behaviour pinned). Controller (harness gains `pluginPanes` + fake `plugins`): `openPluginTab("showroom")` creates a tab with one reserved pane, binds it, calls `ensureUp("showroom")` once, snapshot pane state `status:"plugin"`, and persists the layout structurally; a second `openPluginTab` reuses the cached runtime (ensureUp still called once); reserved pane with no binding → `status:"missing"`; `dismissPane(reservedId)` removes the pane, unbinds, and `client.closeSession` is never called; `openPluginSplit` on tab-1 inserts a second pane; `relaunchPlugin` calls ensureUp again and does not change the pane id.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** reconcile + controller tests, then full `npx vitest run` + `npx tsc -b` — PASS (fixtures untouched: new fields optional).
- [ ] **Step 5: Commit** `feat(plugins): reserved plugin panes in the layout model (P1 T5)`.

### Task 6: PluginPane rendering, CSP, health-driven DeadPane

**Files:**
- Create: `ui/src/split/PluginPane.tsx`, `ui/src/split/PluginPane.css`
- Modify: `ui/src/split/SplitLayout.tsx:346-458` (fourth branch), `ui/src-tauri/tauri.conf.json:23` (CSP), `ui/src/App.tsx` (pass `relaunchPlugin` in SplitLayout actions)
- Test: `ui/src/split/__tests__/PluginPane.test.tsx`, `ui/src/split/__tests__/SplitLayout.test.tsx` (extend), `ui/src/__tests__/csp.test.ts` (new pin, same style as capabilities.test.ts)

**Interfaces:**
- `SplitLayoutActions` += `relaunchPlugin?(sessionId: number): void | Promise<void>` (optional so fixtures type-check).
- `<PluginPane state={PaneSessionState /* status "plugin" */} name={string} icon={string} onRelaunch={() => void} />`: `pluginHealth === "up"` → `<iframe src={pluginUrl + panel.path} title={name} sandbox=... />` — NO sandbox attribute (Showroom needs same-origin scripts + clipboard); `"starting"` → spinner card "Starting <name>…"; `"down"` → DeadPane-styled card with the `pluginError` text and a **Relaunch** button (this is the new handler, not restartPane).
- CSP becomes: `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* http://ipc.localhost; frame-src http://127.0.0.1:* http://localhost:*`.
- Health polling: while any plugin pane for a plugin is mounted and `up`, the controller re-probes every 15 s (T3's `native.probe`); a failed probe flips `pluginHealth` to `"down"`. Lives in the controller (one poller per plugin), not per pane.

- [x] **Step 1: Failing tests** — PluginPane: renders an iframe with the exact URL when up; renders "Starting" when starting; renders the error + a Relaunch button when down and clicking calls `onRelaunch`. SplitLayout: a paneStates entry with `status:"plugin"` renders `<iframe>` inside the pane section with the pane title chrome and no terminal. csp.test: `frame-src` present with both hosts; `connect-src` unchanged.
- [x] **Step 2: Run** — FAIL.
- [x] **Step 3: Implement** (branch order in SplitLayout: live terminal → sleeping → plugin → dead).
- [x] **Step 4: Run** split tests + full suite + `npx tsc -b` — PASS.
- [x] **Step 5: Commit** `feat(plugins): iframe plugin panes with health-driven relaunch (P1 T6)`.
> **As built:** commits ecc379c / 48a9642 / 0b59df4. PluginPane branches on `status === "plugin"` (manifest only dresses: name, icon "?", panelPath "/"); `panelSrc(origin, panelPath)` roots the path and guards same-origin via `new URL`; loopback-only origin regex; `allow="clipboard-write"`, no sandbox, `referrerpolicy="no-referrer"`; 4-side 1px hairline matching TerminalPane.css; status "missing" → dismiss-only DeadPane. Gemini final design pass PASS.

### Task 7: Settings "Plugins" section

**Files:**
- Create: `ui/src/settings/PluginsPanel.tsx`
- Modify: `ui/src/settings/sections.ts` (add `{ id: "plugins", label: "Plugins", fields: [] }`), `ui/src/settings/SettingsSurface.tsx:295-305` (custom branch for `active.id === "plugins"`), `ui/src/settings/__tests__/sections.test.ts` (nine sections; the one-section-per-key assertion is unaffected by an empty `fields`)
- Test: `ui/src/settings/__tests__/PluginsPanel.test.tsx`

**Interfaces:**
- `<PluginsPanel store={PluginsStore} health={Record<string, "starting"|"up"|"down"|"unknown">} onOpenTab={(id) => void} onAddFolder={() => Promise<void>} />` — rows: icon + name + folder path + health dot; toggle `enabled`; "Open as tab"; "Remove"; footer "Add plugin folder…" (uses the existing `dialog:allow-open` grant via the folder picker seam `pickFolder` already injected into the controller; reads `<folder>\termx-plugin.json` else bundled by folder name; malformed → inline error listing `parseManifestErrors`).
- `PluginsStore` (add to T1's registry.ts if not yet): `getSnapshot(): PluginsV1; subscribe; setEnabled(id, bool); add(id, path); remove(id)` persisting via `appFiles.write("plugins_v1.json", …)` with the UiStateStore-style debounce.

- [x] **Step 1: Failing tests** — renders one row per plugin with its health dot; toggling enabled calls `store.setEnabled`; "Open as tab" calls `onOpenTab("showroom")`; "Add plugin folder…" with a folder lacking a manifest and an unknown id shows "No termx-plugin.json found"; sections.test expects nine sections including `plugins`.
- [x] **Step 2: Run** — FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** settings tests + full suite + `npx tsc -b` — PASS.
- [x] **Step 5: Commit** `feat(plugins): Plugins settings section (P1 T7)`.
> **As built:** commits e34e3a1 / 3fd66fe / 6db1169 / c6094f4. Props `{ store; native; onOpen?; health? }`; `Toggle` in its own module (aria-label + aria-hidden label); Remove is confirm-in-place ("Confirm remove", blur/Esc/4 s reset; Esc ownership via `data-esc-guard`); "Change folder…" on bundled rows; scoped `addFolder(expectedId)` refuses a folder holding another id; manifest id ≠ registry key shown inline; middle-truncated paths; per-row health mark (no blink). Copy differs from the plan's draft strings — see the panel.

### Task 8: Entry points in the sidebar menus

**Files:**
- Modify: `ui/src/sidebar/Sidebar.tsx` (SidebarActions optional `openPluginTab?(pluginId, groupId)`, `openPluginSplit?(tabId, pluginId)`; SidebarProps optional `plugins?: readonly { id: string; name: string; icon: string }[]`), `ui/src/App.tsx` (pass enabled plugins + `windowId` already wired)
- Test: `ui/src/sidebar/__tests__/Sidebar.test.tsx` (extend, same conventions as the multi-window T5 tests)

**Interfaces:**
- Background menu gains "New <icon> <name> tab" per enabled plugin (hidden when `plugins` is empty/absent or the action is unwired). Tab menu gains "Split with <name>" per enabled plugin (calls `openPluginSplit(tab.id, pluginId)`; the controller splits the tab's focused pane, falling back to its first pane). Group menu gains "New <name> tab in group".
- App: `plugins={enabledPlugins}` derived from the PluginsStore snapshot joined with manifests; `openPluginSplit` in App adapts to the controller's `(tabId, anchorSessionId, pluginId, dir)` using the tab's focused pane.

- [x] **Step 1: Failing tests** — with `plugins=[showroom]` and `openPluginTab: vi.fn()`, the background menu shows "New 🖼 Showroom tab" and clicking calls `openPluginTab("showroom", null)`; the tab menu shows "Split with Showroom" → `openPluginSplit("tab-1","showroom")`; legacy fixture (no plugins prop) shows neither.
- [x] **Step 2: Run** — FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** Sidebar tests + full suite + `npx tsc -b` — PASS.
- [x] **Step 5: Commit** `feat(plugins): sidebar entry points for plugin tabs and splits (P1 T8)`.
> **As built:** commits c7348f8 / 72d32ce / bc6a20b / 3e56e7d / 8027832 / fa0cdfa. Sidebar list = registry ∪ bundled, sorted by name; "Split with <plugin>" anchors on `resolveFocusedSession(tab.split, focusByTab[tabId])`; App resolves names through `BootstrappedWorkspace.pluginManifestFor` and re-renders on `subscribeManifests` (manifestRevision); Settings bundle main-window only with health = worst on-screen reading; presence gate kept (a removed plugin keeps its rail glyph — deliberate). `fixtureWorkspace()` for App test fixtures.

### Task 9: Live verification, downgrade test, staging

- [ ] **Step 1: Build** `cd /c/Dev/TermX/ui && npx tauri build --no-bundle`; fingerprint `grep -c "rustc-cfg=dev" .../termx-ui-7eeca0bc08b4a715/output` must be 0 (grep exits 1 on zero matches — do not chain with `&&`).
- [ ] **Step 2: Stage** into `C:\Dev\TermX\dist-portable\TermX\` via rename rotation `.prev25` (TermX.exe + termx-ui.exe; daemon unchanged).
- [ ] **Step 3: Michael's live checks** (cannot be run against his running instance by the agent): Settings → Plugins → Add plugin folder → `C:\Users\mjfos\code\showroom` (bundled manifest kicks in; no file needed in his repo) → enable. Background menu → "New Showroom tab": Showroom renders in a tab within ~1–2 s (ensure-up spawns it if down). Tab menu → "Split with Showroom" beside a terminal. Relaunch TermX: both panes return. Kill `node server/showroom.js` from Task Manager: panes flip to the down card; Relaunch brings it back. Downgrade test: with a plugin pane in the layout, launch `TermX.exe.prev25` (the pre-plugin build): the pane shows a dismissible "session ended" DeadPane, nothing else changes; relaunch the new build: the panel is back. Dismiss a plugin pane on the new build: no daemon error notice.
- [ ] **Step 4: Handoff delta** in `specs\handoffs\002-...md` + plan checkboxes updated as-built.

## Self-review notes

- Spec coverage: §2 (T1, T7), §3 + §3a (T2, T3), §4 incl. bindings file, reserved ids, no-binding rule, Relaunch-not-restartPane, cleanup, CSP (T4, T5, T6), §7 (T7), §9 Showroom via bundled manifest — zero Showroom-repo changes (T1), §12 P1 criteria (T9). §5/§6/§8 are Phase 2/3 and intentionally absent.
- Type consistency: `PluginManifest`, `PluginNative`, `EnsureUpResult`, `PaneBindingsStore`, `isPluginPaneId`, `PaneSessionState.status "plugin"` are each defined once (T1/T2/T3/T4/T5) and consumed by the same names in later tasks.
- Open judgment call surfaced for execution: the iframe carries NO `sandbox` attribute in v1 (Showroom needs same-origin scripts and clipboard); revisit when a third-party plugin exists.

---

### Task C: Local conversation capture (Michael's "Resume conversation" gap) — runs after T4, before T5

**Diagnosis (2026-08-31):** "Resume conversation" on a dead LOCAL pane is chosen by `latestForCwd(dead.cwd)` (WorkspaceController.ts:1635-1645 → bootstrapWorkspace.ts:367-378): the NEWEST conversation in the pane's recorded folder. Exact per-pane pairing (OSC `9;78` conversation capture) exists ONLY for SSH panes — the remote bash bootstrap emits it; nothing emits it on Windows. Consequences: (1) corpses with `cwd: null` (pre-cwd-tracking daemon) get no Resume at all; (2) N panes in one folder all resume the same newest conversation; (3) a pane whose recorded cwd differs from where Claude ran resumes a stranger. Fix = record the pairing at the source.

**Files:**
- Create: `tools/claude-hooks/termx-capture.py` (Claude Code SessionStart hook; Python 3, stdlib only), `ui/src/conversations/captures.ts`, `ui/src/conversations/__tests__/captures.test.ts`
- Modify: `ui/src-tauri/src/storage.rs` (ALLOWED_FILES += `conversation_captures_v1.jsonl`), `ui/src/native/appFiles.ts` (AppFileName), `ui/src/workspace/bootstrapWorkspace.ts` (load captures; hand `capturedConversationFor` to the controller), `ui/src/workspace/WorkspaceController.ts` (`deadPaneConversation` prefers the capture; restart/resume cwd falls back to the capture's cwd when the corpse has none)
- Test: `ui/src/workspace/__tests__/WorkspaceController.test.ts` (extend)

**Hook contract:** Claude Code runs `python <repo>\tools\claude-hooks\termx-capture.py` on `SessionStart` (matcher `startup|resume|clear|compact`) with JSON on stdin `{ session_id, cwd, transcript_path, hook_event_name, source }`. If `TERMX_SESSION_ID` is absent → exit 0 silently. Else append ONE JSON line to `%APPDATA%\TermX\conversation_captures_v1.jsonl`: `{"v":1,"termxSessionId":<int>,"provider":"claude","id":"<session_id>","cwd":"<cwd>","atMs":<epoch ms>}`. Validate `id` against `^[A-Za-z0-9-]+$` before writing (same rule `resumeCommand` enforces — the id becomes a shell command later). Never raise; never print (stdout would land in Claude's context). File is append-only; the UI dedupes (latest `atMs` per `termxSessionId` wins). Installation into `~/.claude/settings.json` is a surgical edit WITH a dated backup (same precedent as the terminal-awareness section); the hook path is derived from the TermX repo location the installer is run from — the settings entry is the ONE place an absolute path is allowed, because settings.json is user config, not code.

**UI:**
```ts
export interface ConversationCapture { termxSessionId: number; provider: "claude" | "codex"; id: string; cwd: string | null; atMs: number }
export function parseCaptures(text: string | null): Map<number, ConversationCapture>; // tolerant per line; latest atMs wins; invalid ids dropped
```
- bootstrap reads `conversation_captures_v1.jsonl` at boot AND re-reads it whenever a session exits (`onSessionExited`) — cheap, and it is exactly when the dead pane appears.
- `deadPaneConversation(id)`: capture for `id` → matching index record by provider+id (title for the tooltip) or, if the index has not scanned it yet, a synthesized record `{ provider, id, cwd, title: "Captured conversation" }` → Resume is EXACT. No capture → today's `latestForCwd` fallback.
- `restartPane` cwd: `dead?.cwd ?? capture?.cwd ?? null` — a null-cwd corpse still restarts in the right folder when a capture exists.

- [x] Failing tests: parseCaptures (tolerant lines, latest wins, bad id dropped); controller: dead pane with a capture resolves Resume to that exact id even when three newer conversations exist in the same folder; null-cwd corpse + capture → restart uses the capture cwd; no capture → fallback unchanged (existing tests still pass).
- [x] Implement; gates; commit `feat(conversations): local conversation capture for exact dead-pane resume`.
- [x] Hook installed with backup; verify by starting `claude` in a TermX pane and checking the JSONL gains a line with the right TERMX_SESSION_ID.
> **As built:** commits 32ccfa9 / badcdda / 839a181 / c555321 / de6f251; hook `tools\claude-hooks\termx-capture.py`; captures in `<data dir>\conversation_captures_v1.jsonl`; SessionStart hook (`startup|resume|clear`) installed in `%USERPROFILE%\.claude\settings.json` with backup `settings.json.bak-2026-08-31-termx-capture`; post-reboot MISSING sessions now resume (de6f251: `deadPaneConversation` disqualifies only a LIVE session); captures compacted against the layout keep-set only when the layout parsed; `notifyCapturesChanged()` repaints (test de-tautologised in T5 addendum).
