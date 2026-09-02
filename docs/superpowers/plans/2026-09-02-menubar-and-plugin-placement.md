# Menubar + plugin placement + autostart — implementation plan

> **For agentic workers:** two disjoint lanes run in parallel; every commit goes through the orchestrator's hash-guarded `gate-commit.sh`. Steps use `- [ ]` for tracking.

**Goal:** Workspace · View · Plugins · Settings menubar in every window; a plugin launcher whose rows carry each plugin's declared surfaces; a per-plugin "Start with TermX" toggle; a size rule so splits never cram.

**Spec:** `docs/superpowers/specs/2026-09-02-menubar-and-plugin-placement-design.md` — read it first; this plan argues from it.

**Gates (every task):** from `ui\`: `npx tsc -p tsconfig.app.json --noEmit --incremental false` (exit 0) + `npx vitest run` (baseline **2095/2095**, 142 files); `cargo test` from `ui\src-tauri` only if Rust touched (221). Never run/kill TermX binaries; never `tauri build/dev`; never commit — report `git hash-object` lines and hard-stop.

## Global constraints (from spec)

- Direction B chrome only: square, hairline, `--shadow-overlay`, tokens never raw colours. Copy `PaneFlyout.css` recipes.
- The menu prints ONLY existing shortcuts: Ctrl+Shift+D/E/W (SplitLayout), Ctrl+Shift+O (folder search), Ctrl+Shift+R (conversations palette), F2 (rename window). No new bindings.
- Interface pinned for both lanes: `controller.openPlugin(pluginId: string, surface?: "tab" | "split" | "window"): Promise<void>`; manifest `surfaces?: { default: Surface; allowed: Surface[] }`, `minSize?: { width: number; height: number }`; registry `autostart: boolean`.
- Single-writer rule: aux windows forward; only main autostarts.

## File ownership

**Lane P (impl-placement)** — `ui/src/plugins/manifest.ts`, `ui/src/plugins/registry.ts`, `ui/src/plugins/PluginPane.tsx`, `ui/src/settings/PluginsPanel.tsx`, `ui/src/workspace/WorkspaceController.ts`, `ui/src/workspace/bootstrapWorkspace.ts` (boot autostart only), `ui/src/sidebar/Sidebar.tsx` (ONLY the two plugin-submenu call sites → `openPlugin`), their tests.

**Lane M (impl-menubar)** — NEW `ui/src/menubar/*`, `ui/src/App.tsx`, `ui/src/settings/settings.ts`, `ui/src/settings/sections.ts`, `ui/src/styles.css` (header rules only), their tests. Lane M builds the Plugins menu against the pinned `openPlugin` signature using a stub in tests; integration test lands after P1 merges.

---

### Task P1 — manifest `surfaces` + `minSize` and `openPlugin` policy
**Files:** manifest.ts, WorkspaceController.ts, tests.
- [ ] Failing tests: parse defaults (absent → tab/[tab,split], 320×200); `default ∉ allowed` → registry `problem` warning + fallback to first allowed; bad shapes tolerated.
- [ ] Implement parse + types (`Surface` union exported from manifest.ts).
- [ ] Failing tests for `openPlugin`: `tab` → `openPluginTab`; `split` → `openPluginSplit` on focused pane; `window` → tab + `moveItemToWindow(item,"new")` as ONE structural mutate (one bus forward from aux — use the loopback harness in `windowBus.test.ts`); no surface → manifest default; surface not allowed → notice, no-op; already open anywhere (via bindings) → focus, not a second pane; singleton always focuses.
- [ ] Implement `openPlugin`. Route Sidebar's two plugin submenus and PluginsPanel's `onOpen` through it (default surface; behaviour unchanged).
- [ ] Gates → report (hashes) → hard stop.

### Task P2 — size rule + `data-compact`
**Files:** WorkspaceController.ts, PluginPane.tsx, SplitLayout box accessor if needed, tests.
- [ ] Failing tests for the rule table (≥ minSize splits; too narrow but tall → splits down; neither → tab + notice text exactly `"<Name> needs <w>×<h> to split — opened as a tab."`). Inject a measurer `(sessionId) => {width,height} | null`; null measurer → treat as fits (never block on a missing box).
- [ ] Implement measurer seam (production reads the pane element's `getBoundingClientRect`) and the rule inside `openPlugin("split")`.
- [ ] Failing tests: `PluginPane` sets `data-compact` = `width` / `height` / `both` under minSize, clears when it grows (ResizeObserver stub).
- [ ] Implement. Gates → report → hard stop.

### Task P3 — autostart
**Files:** registry.ts, PluginsPanel.tsx, bootstrapWorkspace.ts / WorkspaceController.ts, tests.
- [ ] Failing tests: registry parse `autostart` (absent → false, non-boolean → false); `setAutostart` persists through the store's save chain; PluginsPanel shows "Start with TermX" toggle with the same enable predicate as Enabled; toggling calls `setAutostart`.
- [ ] Failing tests: at boot MAIN calls `ensureUp` for each enabled+autostart entry after boot prune; aux never; an autostarted plugin is in `pluginsRenderedHere()` so it is health-polled/healed.
- [ ] Implement. Gates → report → hard stop.

### Task M1 — menubar chrome + Workspace/View/Settings
**Files:** NEW `ui/src/menubar/Menubar.tsx`, `Menubar.css`, `menus.ts`; App.tsx; settings.ts; sections.ts; styles.css (header only); tests.
- [ ] Failing tests: settings `sideRail`, `statusBar` parse (default true) + `sections.test.ts` completeness (Appearance).
- [ ] Failing tests (`Menubar.test.tsx`): renders four items; click opens; hover-switch while open; Esc / click-outside / item-pick closes; Arrow keys + Enter; `aria-haspopup`/`aria-expanded`/`role="menu"`/`role="menuitem"`; open item carries the register-mark class; Settings is a plain item that fires `onOpenSettings`.
- [ ] Failing tests: Workspace rows call the pinned controller actions with the right args (`createTab({groupId: active group, profile: null})`, folder-search handler, `splitPane(tab, focused, "row"|"col")`, close pane action, `moveItemToWindow(activeTab,"new")`, rename window → focuses the header editor (dispatch the same path as F2), save session → existing `onSaveConversation`); splits/close disabled without a live focused pane; shortcut column prints only the existing bindings listed in Global constraints.
- [ ] Failing tests: View rows toggle `sideRail` / `conversationsRail` / `statusBar` via the settings store and print `on`/`off`; App hides the rail / status bar when false.
- [ ] Implement `menus.ts` (pure item models: `{ id, label, shortcut?, disabled, onSelect }`), `Menubar.tsx`, CSS per spec, mount in App.tsx after the window name with the hairline `.vr` divider. Header height stays `--row-chrome`.
- [ ] Gates → report → hard stop.

### Task M2 — Plugins menu
**Files:** NEW `ui/src/menubar/PluginsMenu.tsx`; tests. Consumes `controller.openPlugin` (pinned) + registry rows + manifests (`subscribeManifests`, plugin health from the snapshot).
- [ ] Failing tests: one row per registry entry with icon/name; status dot classes for up / down / disabled; chips = manifest `allowed` with `default` filled (absent manifest field → Tab + Split, Tab filled); disabled row shows "Enable in Settings…" and opens Settings → Plugins; `· starts with TermX` when `autostart`; "Manage plugins…" → Settings; click row → `openPlugin(id)`; click chip → `openPlugin(id, surface)`; keyboard: Enter on row = default, Left/Right within a row moves across chips.
- [ ] Implement against a stubbed `openPlugin` in tests. After P1 merges: one integration test through the real controller + loopback bus (aux menu click → main opens).
- [ ] Gates → report → hard stop.

### Task R — review + stage
- [ ] Grok + Codex whole-diff review (from `cfc0522`), fixes red-first, Grok re-verify.
- [ ] `build-stage.sh` with slot `.prev28`; register nothing new (Recall already registered); Michael's click-test: menubar in main + aux, Plugins menu opens Recall split / window, Showroom "Start with TermX" on → up at launch, flyout 800 ms + cwd line.

### Lane B follow-up (outside TermX, after R)
- [ ] Recall + template: add `surfaces`/`minSize` to manifests and a `[data-compact]` stylesheet that restacks the panel.
