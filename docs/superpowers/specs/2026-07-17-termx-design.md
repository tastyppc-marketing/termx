# TermX — Design Spec

**Date:** 2026-07-17
**Status:** Approved design (brainstorming complete), pending implementation plan
**Location:** `C:\Dev\TermX`

## 1. Purpose

TermX ("Terminal X") is a Warp-like terminal manager for Windows whose #1 requirement is **stability**: it must not crash or lose running sessions under memory pressure. Warp's failure mode — the app dies when RAM gets tight, killing in-progress work (e.g. a running Claude Code session) — is the problem this project exists to solve.

**Success criteria:**

1. A UI crash or window close never kills a running shell session; reopening reattaches with scrollback intact.
2. Idle footprint well under 100 MB total; memory bounded by design (capped scrollback, flow control) no matter how much output a session produces.
3. Daily-driver feature set: colored tabs in collapsible groups, folder picker that cd's, Warp-style blocks (better), rich clickability, split panes, command palette, snippets.
4. Fully portable: the app folder can move to another PC and run without any code or config edits.

## 2. Stack

- **UI:** Tauri 2 window (WebView2) + React + TypeScript + Vite + xterm.js (WebGL renderer, DOM fallback).
- **Session host:** `termx-host` — a separate compiled Rust daemon using ConPTY via the `portable-pty` crate. No GC, no runtime.
- **Why:** two-process split gives tmux-style crash survival; Rust host gives a tiny, predictable memory footprint. Electron (the Warp/Tabby pattern) was rejected as it carries the exact memory profile we're escaping.

## 3. Disk layout & portability

```
C:\Dev\TermX\
├─ host\                  Rust crate: termx-host (session daemon)
├─ ui\                    Tauri 2 app (src-tauri Rust shell + src React frontend)
├─ shell-integration\     Per-shell snippets emitting OSC 133/7 markers (ps1, sh)
├─ scripts\               dev.ps1 / build.ps1 — paths derived from $PSScriptRoot
├─ docs\superpowers\specs\
├─ BACKLOG.md
└─ README.md
```

**Portability rules (per global CLAUDE.md):**

- Zero hardcoded absolute paths in source. All runtime paths derive from the exe location or environment variables resolved at runtime.
- Config/state default to `%APPDATA%\TermX\` (config.json, state.json, snippets.json, history.sqlite, logs\).
- **Portable mode:** a `portable.flag` file next to `termx-ui.exe` switches all storage to `<exe dir>\data\` — copy the folder to another machine and everything travels with it.
- Shell executables (PowerShell 5.1, pwsh 7, Git Bash, cmd, WSL distros) are **discovered at runtime** (PATH, registry, well-known install dirs, `wsl -l`) and listed as profiles; config can override any path.

## 4. Architecture

### 4.1 Processes

- **`termx-host.exe`** (Rust daemon, target ~10 MB RSS): owns every ConPTY session. Started on demand by the UI if not running. Survives UI exit/crash. Shuts down only on explicit "Quit TermX" (or OS shutdown).
- **`termx-ui.exe`** (Tauri window): rendering and interaction only; fully disposable. Auto-respawns/reconnects to the host with exponential backoff.

### 4.2 Host ↔ UI protocol

- Localhost WebSocket on a random port; port + auth token written to a runtime file in the data dir; token required on connect.
- JSON control messages (create/close/resize/attach/detach session, cd-inject, list, block events, cwd/title updates, history queries, snippet CRUD) + binary frames for PTY I/O throughput.
- Version handshake on connect; mismatch prompts a clean restart of the stale side.

### 4.3 Memory & stability engineering

- **Ring-buffer scrollback per session**, hard cap (default 10,000 lines, configurable per profile) — memory bounded by design.
- **Flow control:** PTY reads pause when the UI consumer lags (xterm.js flow-control handshake), so output firehoses throttle instead of ballooning RAM.
- Per-session isolation in the host (a wedged session never blocks others).
- Host writes layout/session metadata to `state.json` continuously (debounced), so even a host restart or machine reboot restores the full layout — tabs, groups, colors, cwd — with fresh shells. (Honest limit: OS processes cannot survive a reboot or host kill; only UI-side death is fully transparent.)
- Rotating logs in the data dir for both processes.

## 5. UI layout

Single window, three regions:

1. **Top bar:** a **"Search sessions and files"** search input (global), plus window controls. Typing filters the sidebar tree live (sessions, groups, folder-tree files); Enter jumps to the best match. Ctrl+K opens the command palette (see §10).
2. **Left sidebar** with two panels (icon-switched or stacked): **Sessions** and **Folders**. There is **no top tab strip** — all session navigation lives in the sidebar.
3. **Main area:** the active tab's pane grid (see §11).

### 5.1 Sessions panel (tabs, colors, groups)

- Tree of **collapsible groups** (folder-like), each containing session tabs; ungrouped sessions sit at root level. Collapsing a group hides its sessions.
- Each session row: color dot/bar, editable name (auto-named from shell title/cwd until renamed), activity indicator, close button on hover.
- Right-click session → rename, change color (preset palette + custom hex), move to group, duplicate (same profile+cwd), close.
- Right-click group → rename, recolor, collapse/expand, close all, new session here.
- Drag-and-drop sessions between groups and to reorder; drag to create a group.
- "+" button: new session (default profile) or long-press/split-button for profile choice (PowerShell 5.1 default, pwsh, Git Bash, cmd, WSL distros).
- All of it persists (names, colors, order, grouping, collapse state).

## 6. Folder picker ("Folders" panel)

- **Scoped tree**: rooted at the active session's current directory by default — with **easy parent navigation**: a clickable breadcrumb path plus a ".." row, so walking up to `C:\` (and across to other drives via a drives shortcut in the breadcrumb) is one click per level. Re-rooting the tree is instant; it is never locked to the starting scope (the Warp complaint).
- The tree live-highlights the active session's cwd (tracked via OSC 7 from shell integration).
- **Two ways to cd:**
  1. Double-click a folder in the tree (or its "cd to directory" context item) → injects a properly quoted, shell-appropriate `cd` into the active terminal (`cd "C:\path"` for PowerShell/cmd; `cd /c/path` for Git Bash; `cd /mnt/c/path` for WSL).
  2. **"Open Folder" button** → native Windows folder-picker dialog; choosing a folder cd's the active terminal into it (and re-roots the tree there).
- **Context menu** (files and folders, mirroring the approved screenshot):
  - **New file** (creates in that folder, inline name edit)
  - **cd to directory** (folders; for a file, cd's to its parent)
  - **Open in new tab** (new session whose cwd is that folder, same profile as active)
  - **Reveal in Explorer**
  - **Rename**
  - **Delete** (to Recycle Bin, with confirm)
  - **Attach as context** (types the quoted path into the active terminal at the cursor without executing — for handing files/folders to a running Claude/Codex prompt)
  - **Copy path** (absolute) / **Copy relative path** (relative to the active session's cwd)

## 7. Blocks (Warp-style, better)

- Shell-integration snippets (installed per profile, opt-out in config) emit **OSC 133 A/B/C/D** command boundaries + exit codes, and **OSC 7** cwd reports. Supported: PowerShell 5.1/7 (profile hook), Git Bash & WSL bash/zsh (PROMPT_COMMAND/precmd). **cmd.exe has no prompt hooks — no blocks there** (documented limitation; terminal still works normally).
- Each command+output is a block: gutter hover highlights it; click selects; actions: **copy command / copy output / copy both**; re-run command. Failed commands get a red exit-code stripe; Ctrl+Up/Down jumps between blocks.
- **Better than Warp:** one keystroke copies the last command's output (default Ctrl+Shift+O), and block-aware search (below).

## 8. In-terminal search (Ctrl+F)

- Ctrl+F opens a search bar on the focused pane: incremental highlight of all matches in scrollback, Enter/Shift+Enter to cycle, match counter, case/regex toggles (xterm.js search addon).
- Block-aware filter: toggle to search **only command outputs** or **only commands**, and jump result-by-result across blocks.

## 9. Clickable everything

- URLs → default browser.
- Windows paths in output — absolute (`C:\...`), UNC, and relative (resolved against the session's live cwd): click a folder → opens in Explorer; click a file → default app; modifier-click → reveal in Explorer. Also `file://` URIs.
- OSC 8 hyperlinks from modern CLIs fully supported.

## 10. Command palette, history, snippets

- **Ctrl+K palette:** fuzzy search over actions (new tab/split/recolor/cd/etc.), open sessions (jump), snippets (insert), and **cross-session command history**.
- History: host records commands (+ cwd, exit code, timestamp, session) from block markers into `history.sqlite`; palette queries it; inserting types the command without executing.
- **Snippets:** named saved commands in `snippets.json`; insert types them (never auto-runs unless the snippet is explicitly flagged "run immediately"); managed via palette + a simple editor UI.

## 11. Split panes & pane management

- Each tab holds a **pane grid**; each pane is one session view.
- **Per-pane title strip** with buttons: split horizontal, split vertical, **maximize** (pane fills the tab; toggle back), **minimize** (collapse to title strip, space redistributes; click restores), **pop out to its own window** (new Tauri window adopts the pane — trivial under the host architecture since sessions are window-independent), close.
- **Drag to rearrange:** drag a pane by its strip; drop zones highlight (left/right/top/bottom of any pane, or tab edges) — grid-style tiling, not a rigid binary tree.
- **Resize semantics:**
  - Dragging a divider **without Alt**: space redistributes proportionally across all panes along that axis (neighbors cascade).
  - Dragging **with Alt held**: only the two panes adjacent to the divider change; all other pane sizes stay fixed.
- Keyboard: split/close/focus-move shortcuts (defaults documented in README; rebindable in config later).

## 12. UI quality bar

Dark-first, GPU-rendered, designed — not default-CSS. A deliberate design pass using the frontend-design skill is part of v1 scope (typography, spacing, motion, hover states, empty states). Target feel: Warp-level polish, faster.

## 13. Config & data

| File | Purpose |
|---|---|
| `config.json` | Profiles (auto-discovered + overrides), default profile, scrollback cap, keybindings, theme, block/shell-integration toggles |
| `state.json` | Groups, sessions, names, colors, order, collapse state, pane layouts, cwd per session |
| `snippets.json` | Saved commands |
| `history.sqlite` | Cross-session command history |
| `logs\` | Rotating host + UI logs |

All JSON human-editable; live-reloaded where safe.

## 14. Error handling

- UI ↔ host disconnect: auto-reconnect with backoff; toast shows state; host auto-spawned if missing.
- Session spawn failure (bad shell path): inline error pane with the exact command tried and a "fix profile" shortcut — never a silent dead tab.
- Host refuses to exceed memory caps; oldest scrollback drops silently (by design), never the session.
- Renderer failure: WebGL → DOM fallback automatically.

## 15. Testing & verification

- **Rust host:** unit tests (ring buffer, protocol framing, session registry, state persistence) + integration tests spawning real ConPTY shells (echo round-trip, resize, reattach-with-replay, kill-UI-survive test).
- **UI:** component tests for grid-layout math (split/resize/Alt-resize invariants) and linkifier regexes.
- **End-to-end smoke** (scripted): launch host+UI, create session, run command, assert output rendered, kill UI process, relaunch, assert reattach + scrollback intact.
- **Memory soak:** `yes`-style firehose for N minutes; assert host RSS stays under cap.
- Manual checklist: clickables, blocks in each shell, folder-picker cd in each shell, Alt-resize, pop-out window.

## 16. Milestones

1. **Host core** — sessions, ConPTY, WS protocol, ring buffer, reattach; kill-UI-survive test green.
2. **UI shell** — window, xterm.js wired to host, sidebar sessions panel, tabs + colors + groups, persistence.
3. **Folder picker** — scoped tree + breadcrumb, Open Folder dialog, cd injection, context menu, cwd tracking.
4. **Shell integration + blocks** — OSC 133/7 snippets, block UI, Ctrl+F search.
5. **Clickables** — links, paths, OSC 8.
6. **Panes** — splits, strip buttons, drag grid, Alt-resize, pop-out, maximize/minimize.
7. **Palette + history + snippets.**
8. **Polish + hardening** — frontend-design pass, memory soak, e2e suite, README.

## 17. Backlog (explicitly deferred to later sessions)

1. **Terminal-to-terminal messaging** — sessions can send messages to each other (the "smart team" idea, rebuilt properly: less cumbersome, reliable).
2. **`/forkit`** — command that opens a split pane, cd's into the right directory, and launches `claude` or `codex` with requested flags (`--flex`, `--verbose`, etc.).
3. **LLM cross-session context sharing** — a session's LLM can gather context from another session's LLM.
4. Blocks for cmd.exe via heuristics; rebindable keys UI; installer.

## 18. Out of scope for v1

AI features (Warp AI equivalent), themes marketplace, SSH/remote sessions, macOS/Linux builds (architecture doesn't preclude them; Windows first).
