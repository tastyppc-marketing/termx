# TermX: New-tab CWD, Folder Searcher, Settings, Jump-to-Input, Toolbar Fix

Approved by Michael 2026-07-30 (design presented in chat; "go"). Follow-up batch
from the first release smoke. Five features, build order F5 → F1 → F3 → F2 → F4.

## Motivation (Michael's words, paraphrased)

- "I really don't like how opening a new terminal asks me what folder. It
  should default to the default directory for the given group — set by the
  first terminal, changing on CDs."
- Folder browsing should be an *option*, plus a Warp-style folder *searcher*.
- Settings should exist so policy choices can be changed on the fly.
- "Scroll up to the last message I sent" after a lot of generation.
- Split-pane hover buttons overlap other buttons — "should never hover over
  each other."

## F1. New-tab directory: group active path + CD tracking

### Behavior

- Plain "new tab" (＋ button, `New tab` / `New tab in group` menu items)
  **never prompts**. It opens instantly in the target scope's **active path**.
- A *scope* is a group, or the ungrouped list (key `null`). Each scope carries:
  - `seedPath` — spawn cwd of the first session created in the scope.
  - `activePath` — last observed CD in any of the scope's live terminals
    (most recent wins). Unset until a CD is observed; falls back to seed.
- Resolution for a new tab (policy `group-active`, the default):
  `activePath` → `seedPath` → `null` (host default = home). If the host
  rejects the cwd (deleted dir), retry down the chain — never surface an
  error for a stale path.
- Policy is a setting (see F3): `group-active` (default) | `active-tab` (cwd
  of the most-recently-focused tab in the scope, falling back to
  `group-active` chain) | `first-terminal` (seed only) | `ask-searcher` |
  `ask-native` (today's behavior).

### CD tracking mechanism (shell integration)

Host injects a prompt hook at spawn (`host/src/profiles.rs`), emitting the
standard **OSC 9;9 working-directory sequence** each prompt (the Windows
Terminal convention):

- **powershell**: args become `-NoLogo -NoExit -Command "<hook>"`. The hook
  captures the profile-defined prompt (profile has already run), wraps it:
  emit `ESC]9;9;<CurrentFileSystemLocation.ProviderPath>ESC\` then call the
  original. `$?` is preserved via the capture-and-restore trick (capture `$?`
  first; on false, restore with `Write-Error -ErrorAction SilentlyContinue`
  before delegating) so posh-git-style prompts keep their success state.
- **cmd**: spawn env `PROMPT=$E]9;9;$P$E\$P$G` (VT `$E` escape; keeps the
  default visible prompt).
- `CreateSession` gains optional `shell_integration: bool` (default `true`,
  omitted = true — wire-compatible). Settings toggle maps to it.

UI side: `TerminalPort.parser` already exists — register an OSC 9 handler;
payload `9;<path>` reports cwd. Rules:

- Per-session cwd updates on every report (including replay — replayed
  scrollback re-derives it for free after relaunch).
- **Scope `activePath` only moves on LIVE reports** (after attach completes),
  never during replay — otherwise an old session's replayed CD clobbers the
  persisted newer value on relaunch.
- Seeding: first session created into a scope with no `seedPath` sets it from
  its spawn cwd. Moving a tab between groups does not move paths; paths
  belong to scopes, not tabs.
- Scope paths + recents persist in `ui_state_v1.json` (F3 storage); groups
  deleted → their entry dropped.

## F2. Folder searcher (Warp-style palette)

A modal palette (`ui/src/folders/FolderSearch.tsx`), NOT the OS dialog:

- Text input; below it a keyboard-navigable list (ArrowUp/Down, Enter opens a
  terminal in the highlighted dir, Escape closes; focus-trapped like existing
  dialogs).
- Empty input → recent folders (MRU). Typed input → merged results:
  matching recents first, then **live path completion**: resolve the typed
  text's parent directory and list matching subdirectories
  (case-insensitive; simple fuzzy scoring with segment-boundary bonus, no new
  dependency). `~` expands to home. Short/empty absolute input lists drive
  roots.
- Last row is always **"Browse…"** → the existing native dialog (old
  behavior stays reachable).
- Entry points: a folder-search icon next to the sidebar ＋ button; tab and
  group context-menu item "New tab in folder…"; global **Ctrl+Shift+O**.
  Group context → new tab lands in that group.
- Backend: Tauri command `list_dirs(prefix: string) -> string[]` in
  `ui/src-tauri` (std::fs read_dir, directories only, cap 100, never errors —
  bad input returns `[]`; drive-root enumeration for empty/short input).
  Capability entry follows the existing `allow-bootstrap-host` pattern.
- Recents MRU (cap 50, deduped, most-recent first) updates on: searcher pick,
  native-dialog pick, session created with explicit cwd, live CD reports.
  Stored in `ui_state_v1.json`.

## F3. Settings subsystem

- **Two files** in the resolved data dir (same `%APPDATA%\TermX` /
  `portable.flag` logic the app already uses — the resolution fn in
  `ui/src-tauri/src/bootstrap.rs` is refactored for shared use):
  - `settings_v1.json` — user-edited preferences.
  - `ui_state_v1.json` — machine-written state (scope paths, recents MRU).
- Tauri commands: `read_settings` / `write_settings` / `read_ui_state` /
  `write_ui_state` (strings in/out; atomic tmp+rename writes). UI validates
  with per-field defaults; a malformed file yields defaults and is NOT
  overwritten until the user actually changes a setting (mirrors the layout
  parse-gate philosophy: never destroy data on a parse bug).
- `ui/src/settings/`: typed store (`useSyncExternalStore` pattern, like the
  layout store), debounced persist, defaults module.
- **SettingsDialog** (gear button in the sidebar footer; focus-trapped modal
  matching existing dialog styling). v1 contents:
  - New tab opens in: the five F1 policies (radio, plain-language labels).
  - Shell integration (cd tracking): on/off. Off also stops OSC-based scope
    updates; new sessions spawn without the hook.
  - Default profile for new tabs: powershell | cmd.
- All new behavior reads live from the store — no restart required.

## F4. Jump to last input

- Whenever the user's keystrokes into a pane contain **Enter** (`\r`), drop
  an xterm marker at the current buffer line (`registerMarker(0)`), pushed to
  a per-pane list (cap 100; disposed markers are pruned — xterm auto-disposes
  markers that scroll out of the 10k ring).
- **Ctrl+Shift+J** (window-capture, same guard rules as Ctrl+Shift+D/E/W:
  ignored in rename/search inputs, allowed from xterm's helper textarea)
  targets the focused pane: first press scrolls to the most recent marker;
  repeated presses walk to older markers. New input or scroll-to-bottom
  resets the walk. No-op when the alternate screen buffer is active.
- `TerminalPort`/presentation gain `registerMarker()` and `scrollToLine()`;
  logic lives in a small testable module (`ui/src/terminal/inputMarks.ts`)
  driven by the existing `onData` path.

## F5. Pane floating-control overlap (bug)

`.split-pane__toolbar` (SplitLayout.css, top-right, z6) and `.terminal-search`
(TerminalPane.css, same corner, z3) collide whenever search is open in a
hovered/focused pane. Rule: **floating pane controls never overlap.**

- Fix: `.split-pane:has(.terminal-search) .split-pane__toolbar` shifts below
  the search bar (`top: 48px`); search keeps the prime corner while in use.
  `:has()` is safe in WebView2.
- Sweep the other floaters for the same class of bug: bottom notices already
  stack (`__notice + __status` offset exists); verify link-notice vs status.
- Verified visually (screenshot) since CSS is untestable in jsdom.

## Cross-cutting

- No layout_v1 schema change; no new host protocol messages beyond the
  optional `shell_integration` field. Host stays UI-agnostic.
- Portability rules hold: no literal paths; data via the resolved data dir.
- Quality bar: palette/settings visuals match the existing token language
  (#0f1115 / #1b202a surfaces, #7aa2f7 accent, existing radius/shadow
  patterns); full keyboard support; aria labels like existing dialogs.
- Tests: vitest for policy resolution, settings/ui-state parsing, marker
  walk, fuzzy scoring, controller wiring; Rust unit tests for profile
  injection, `shell_integration` protocol default, `list_dirs`; suites stay
  green (289 unit + 5 e2e + 105 host at start).
