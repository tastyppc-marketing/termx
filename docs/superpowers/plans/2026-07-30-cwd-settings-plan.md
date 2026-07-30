# CWD/Settings/Searcher/Jump/Toolbar Implementation Plan

> **For agentic workers:** Executed by the main session (Fable) with Rust tasks
> delegated to Opus subagents. Spec: `docs/superpowers/specs/2026-07-30-termx-cwd-settings-design.md`.

**Goal:** New tabs open in the group's tracked directory with zero prompting; a
Warp-style folder searcher, a settings subsystem, jump-to-last-input, and the
pane-toolbar overlap fix.

## Global constraints

- No literal machine paths in code. Suites stay green: host `cargo test`
  (105), ui `npm test` (289) + `npm run test:e2e` (5), `tsc`, `npm run build`.
- No layout_v1 schema change. Host protocol change limited to ONE optional
  field. Workers do NOT commit — main session reviews and commits scoped.
- UI visual language: existing tokens (#0f1115/#1b202a surfaces, #7aa2f7
  accent, 7-8px radii); full keyboard + aria parity with existing dialogs.

---

## Task R1 (delegate: Opus) — host shell integration

**Files:** `host/src/profiles.rs`, `host/src/protocol.rs`, `host/src/server.rs`,
`host/src/session.rs`, `host/src/registry.rs` (as needed by call sites), tests
in place.

**Contract (later tasks rely on exactly this):**
- `Profile` gains `pub env: Vec<(String, String)>` (empty when integration off).
- Profile resolution takes a `shell_integration: bool`. On:
  - powershell args: `-NoLogo -NoExit -Command "<hook>"`. Hook (single arg):
    capture `$function:prompt` into `$global:__termxPrompt`; new global prompt
    captures `$?` FIRST, writes `ESC]9;9;<CurrentFileSystemLocation.ProviderPath>ESC\`
    via `[Console]::Write`, restores a false `$?` (Write-Error
    `-ErrorAction SilentlyContinue` trick or equivalent — verify empirically),
    then `& $global:__termxPrompt`. `$LASTEXITCODE` must be untouched.
  - cmd: env `PROMPT` = `$E]9;9;$P$E\$P$G`.
- `session.rs` spawn applies `profile.env` via `CommandBuilder::env`.
- `protocol.rs` CreateSession params: `shell_integration: bool` with
  `#[serde(default)] = true` semantics — an OLD client omitting the field gets
  `true`. Server threads it to resolution.
- Tests: (a) profiles unit tests both shells × on/off (exact args/env);
  (b) protocol deserialization defaults test; (c) REAL spawn e2e test in the
  existing harness style: spawn powershell with integration, send `cd ..\r`,
  assert an `ESC]9;9;` sequence with an absolute path appears in output; same
  smoke for cmd. (d) Manually verify in a real interactive PowerShell 5.1 that
  `$?` shows correctly after a failing command with the hook installed —
  paste transcript in report.

## Task R2 (delegate: Opus) — Tauri data commands

**Files:** `ui/src-tauri/src/bootstrap.rs` (refactor only),
`ui/src-tauri/src/storage.rs` (new), `ui/src-tauri/src/folders.rs` (new),
`ui/src-tauri/src/lib.rs`, `ui/src-tauri/capabilities/default.json`.

**Contract:**
- Extract the existing data-dir logic into `pub fn resolve_data_dir() -> Result<PathBuf, ...>`
  (portable.flag beside exe → `data\`; else `%APPDATA%\TermX`; existing debug
  behavior preserved). `bootstrap_host` keeps identical behavior.
- `#[tauri::command] read_app_file(name: String) -> Result<Option<String>, String>`
  and `write_app_file(name: String, contents: String) -> Result<(), String>`:
  name MUST be in allowlist `["settings_v1.json", "ui_state_v1.json"]` (reject
  otherwise); write = create data dir, tmp file + rename (atomic); read =
  `Ok(None)` when missing.
- `#[tauri::command] list_dirs(prefix: String) -> Vec<String>` (never errors):
  expand leading `~` to the user profile dir; empty/short (<2 chars) or
  non-absolute input → existing drive roots (`A:\`..`Z:\` probed); else split
  at last `\`/`/`: read_dir(parent), directories only, case-insensitive
  substring match of the final segment (empty segment = all), skip
  dot-prefixed names, absolute paths out, cap 100, name-prefix matches sorted
  first then alphabetical.
- Register all three commands; add capability permissions following the
  existing `allow-bootstrap-host` pattern. Unit tests with tempdirs for
  storage allowlist/atomicity/missing-file and list_dirs matching/caps/junk
  input. `cargo test` in ui/src-tauri green; do not touch tauri.conf.json.

## Task U1 (main) — F5 toolbar overlap fix

`SplitLayout.css`: `.split-pane:has(.terminal-search) .split-pane__toolbar { top: 48px; }`
(+ comment stating the never-overlap rule). Sweep other floaters; visual
verify with a screenshot at the end (V1).

## Task U2 (main) — settings subsystem + dialog (F3)

**Files:** `ui/src/settings/settings.ts` (types/defaults/parse),
`ui/src/settings/SettingsStore.ts`, `ui/src/settings/SettingsDialog.tsx` +
CSS, `ui/src/native/appFiles.ts` (invoke wrappers), Sidebar footer gear,
tests.

- `TermxSettings = { newTabPolicy: "group-active"|"active-tab"|"first-terminal"|"ask-searcher"|"ask-native", shellIntegration: boolean, defaultProfile: "powershell"|"cmd" }`,
  defaults `group-active / true / powershell`. Per-field validation; malformed
  file → defaults, file untouched until a user mutation.
- Store: subscribe/getSnapshot/update (useSyncExternalStore), injected
  read/write (prod = `read_app_file`/`write_app_file`), debounced persist.
- Dialog: focus-trapped modal (existing dialog patterns), radios for policy,
  toggle for shell integration, select for default profile.

## Task U3 (main) — scope paths + OSC cwd + createTab policy (F1)

**Files:** `ui/src/workspace/scopePaths.ts` (new, pure),
`ui/src/workspace/uiState.ts` (new: `{version:1, scopePaths, recentFolders}`
load/save via appFiles), `WorkspaceController.ts`,
`ui/src/terminal/TerminalSessionBinding.ts` (OSC 9 handler + live/replay
flag), `TerminalPane.tsx` (`onCwd` prop), `App.tsx` wiring, tests.

- Scope key = group id, `""` for ungrouped. `reportSessionCwd(sessionId, path, live)`:
  session cwd always updates; scope activePath only when `live`.
- Seed on first session added to a scope (spawn cwd). Deleted group → entry
  dropped. Persist through uiState (debounced).
- `createTab` consults SettingsStore: resolve candidate chain per policy, try
  CreateSession down the chain (invalid-cwd host error → next candidate →
  null), no dialog for the three non-ask policies. `ask-searcher` routes to
  U4's palette, `ask-native` = today's picker. Profile `null` → settings
  defaultProfile. OSC handler disposal on binding dispose; payload must parse
  `9;<path>`, tolerate quoted paths, ignore relative/UNC-invalid junk.

## Task U4 (main) — folder searcher palette (F2)

**Files:** `ui/src/folders/fuzzyScore.ts`, `ui/src/folders/FolderSearch.tsx`
+ CSS, `ui/src/native/folders.ts` (list_dirs wrapper), Sidebar entry points
(icon next to ＋, "New tab in folder…" in tab/group menus), Ctrl+Shift+O,
recents wiring into uiState, tests.

- Palette: input → merged list (matching recents first, then list_dirs
  completions), ArrowUp/Down + Enter + Escape, focus trap, "Browse…" last row
  → native dialog. Picks and CDs feed the MRU (cap 50).

## Task U5 (main) — jump to last input (F4)

**Files:** `ui/src/terminal/inputMarks.ts` (new, pure over an injected marker
factory), `TerminalPane.tsx`/`TerminalSessionBinding.ts` (drop marker on `\r`
in user input; listen for `termx:jump-last-input` window event when the pane
contains `document.activeElement`), SplitLayout/App keyboard capture adds
**Ctrl+Shift+J** (same input-guard rules as D/E/W) dispatching that event,
tests for walk/reset/pruning.

## Task V1 (main) — integration verify + restage

Full gates (host cargo test, ui npm test, tsc, build, e2e), rebuild portable
pair per `docs/RELEASE.md`, restage `dist-portable\TermX\`, launch, PrintWindow
screenshot (no focus stealing), typing smoke deferred to Michael. Update
BACKLOG/handoff; commits per task, standard trailers.

## Order & parallelism

R1 ∥ R2 (Opus agents, no commits) while main does U1 → U2 → U3 (mock-first;
swap in real invokes when R2 lands) → U4 → U5 → review R1/R2 diffs → V1.
