# TermX Chat View — Design

**Date:** 2026-08-10 · **Status:** approved in brainstorm, pending spec review
**Companion spec (same batch):** `2026-08-10-settings-window-design.md`

## Goal

A pane running Claude Code (or any claude-x fleet lane writing the same
transcript format) can flip into a **Chat view**: the session renders as a
readable conversation — Michael's prompts right-aligned, agent responses as
formatted bubbles, tool activity condensed per a density toggle — with a chat
input box that forwards into the running session, and **interactive prompts
(permission menus, questions, plan approvals) surfaced as answerable cards in
the chat itself**. Purpose: Michael reads 100–200 pages of agent output daily;
this is the fatigue killer.

## Background: what exists (verified 2026-08-10)

- **Session discovery + parsing (Rust, `ui/src-tauri/src/llm_sessions/`)**:
  `scan_roots`/`list_sessions_now` find Claude/Codex session files;
  `claude.rs::harvest_claude_file/harvest_claude_excerpts` parse Claude JSONL.
  Known trap (encoded in existing parser work): Michael's typed messages
  largely live inside `queue-operation` events — a parser must NOT read only
  `type:"user"` entries.
- **Windowed transcript reads**: `transcript.rs::read_window_at(path,
  before_offset, max_bytes)` — byte-offset windows, ideal for tailing.
- **Conversations infra (UI)**: `ui/src/conversations/` — session records,
  resume-into-terminal, `AlreadyOpenDialog` (some pane↔session linkage
  exists), fullscreen surface pattern (`ConversationsFullscreen`).
- **Pane plumbing**: `TerminalPane.tsx` owns the xterm instance (its buffer is
  readable via `term.buffer.active`); input reaches the PTY through the
  pane's session binding (`AttachmentHub`); `SplitLayout`/`WorkspaceController`
  own pane chrome.
- **Theme tokens** (2026-08-09 batch): all chat styling uses `--surface-*`,
  `--text-*`, `--accent-*`, `--border`; works across all six themes.

## Design

### 1. View mode on the pane

Each pane gets `viewMode: "terminal" | "chat"`. Chat renders **over** the
terminal in the same pane; the terminal keeps running underneath (xterm stays
mounted and attached — it is also the prompt detector's data source, §5).
A corner switch on the pane and a keyboard shortcut (Ctrl+Shift+C, subject to
collision check with existing keymap) flip instantly. The switch is only
offered when the pane is linked to a recognized agent session (§2); otherwise
it is absent. `viewMode` persists per pane in ui-state (not in layout_v2 —
no schema change; follow `uiState.ts` patterns). Settings (companion spec)
provide: default view for agent panes (`terminal` | `chat`) and default
density.

### 2. Session linkage

A pane is linked to a transcript file by, in order: (1) the existing
resume/AlreadyOpen linkage when the session was started or resumed through
TermX; (2) automatic match — a session file whose recorded cwd equals the
pane's cwd and whose mtime advances while the pane produces output (the same
signals the conversations feature already harvests); (3) manual — a "Link
conversation…" picker in the chat header listing candidate sessions (reuses
the conversations list). Wrong or dead linkage degrades safely: the chat
shows a stale banner and the terminal is one flip away.

### 3. Live transcript feed

**Rust side:** new tauri command pair built on `read_window_at`:
`chat_feed_open(path) -> { feedId, entries, offset }` (initial window: last
256 KiB, parsed) and `chat_feed_poll(feedId) -> { entries, offset }` (read
bytes appended since the last offset, parse complete lines only, buffer a
trailing partial line). The UI polls every 500 ms **only while a chat view is
mounted**. File replaced/truncated (compaction rewrites) → detected by
size < offset or inode-style mismatch → full re-open of the tail window.

**Normalized model (one renderer, many sources later):**

```ts
type ChatEntry =
  | { kind: "user"; id: string; ts: number; text: string }
  | { kind: "assistant"; id: string; ts: number; markdown: string }
  | { kind: "thinking"; id: string; ts: number; text: string }
  | { kind: "tool"; id: string; ts: number; name: string; title: string;
      summary: string; status: "running" | "ok" | "error"; detail: string }
  | { kind: "system"; id: string; ts: number; text: string }   // compaction, errors, notices
```

The Claude adapter maps JSONL entries (including `queue-operation`-wrapped
user messages, tool_use/tool_result pairing, thinking blocks) to this model.
`title`/`summary` are the chip line ("Edited App.tsx", "+12 −3" / "Ran tests —
914 passed"); `detail` is the expandable body. A Codex-native adapter is an
explicit follow-up — v1 covers the Claude JSONL format, which includes every
claude-x lane.

### 4. Rendering

- Bubbles: user right (accent-tinted surface), assistant left (`--surface-1`),
  max-width ~72ch, 1 px `--border` hairline, radius 4 (hardening rules apply).
- Assistant markdown via `react-markdown` + `rehype-sanitize` (default safe
  schema, raw HTML stripped) — no external network, npm deps only. Code
  blocks in the mono stack with `--surface-2` background.
- Tool chips: one line, status dot (running/ok/error uses `--ok`/`--error`),
  click to expand `detail` (pre-formatted, scrollable, capped height).
- Thinking: collapsed line ("thought for a while — show"), expandable.
- **Density toggle in the chat header** — `chips` (all tools collapsed) /
  `smart` (status "error" tools, edit diffs, and test-run details auto-open) /
  `full` (all `detail` open). Per-pane, persisted in ui-state; default from
  settings.
- Virtualized list (sessions reach thousands of entries); autoscroll pinned to
  bottom with a "jump to latest" pill when scrolled up.
- Header: session title + model, density toggle, link picker, Esc
  (interrupt) and Ctrl+C (stop) buttons that send those keys to the PTY,
  view-flip switch.

### 5. Interactive prompts as chat cards (Michael's amendment — required)

The transcript never records TUI-level prompts, but the pane's live xterm
buffer contains exactly what the agent drew. A **PromptDetector** — a pure
function `detect(visibleLines: string[]) -> DetectedPrompt | null` — runs
against the visible buffer snapshot on a short debounce whenever terminal
output changes while the transcript is idle.

```ts
type DetectedPrompt =
  | { kind: "menu"; question: string; options: { label: string; index: number }[];
      selectedIndex: number; raw: string[] }
  | { kind: "confirm"; question: string; raw: string[] }        // y/N style
  | { kind: "unknown"; raw: string[] };                          // fallback card
```

v1 pattern set (fixture-driven, one module, easy to extend when Claude Code's
UI changes): permission dialogs ("Do you want to …" with a `❯` selector or
numbered options), AskUserQuestion menus, plan-approval prompts, folder-trust
prompts. Every pattern ships with captured-screen fixtures as tests.

**Answering:** the card renders the question + options as buttons. A click
computes keystrokes from the selector position: `(targetIndex −
selectedIndex)` arrow-key presses then Enter (digit shortcut where the menu
shows numbers). After sending, the detector re-runs: prompt gone → card
flips to its answered state; prompt unchanged after ~800 ms → one re-derive
and retry; still unchanged → the card degrades to the fallback.

**Fallback (`unknown`)**: when output stalls into something interactive we
can't classify — card shows the last ~12 non-empty terminal lines verbatim
(read-only, mono), a free-text keystroke box (Enter sends text + `\r`), and
an "Open terminal" button. Even unrecognized prompts stay answerable inside
the chat; the flip is last resort.

**Safety rule:** prompt cards only ever send input the user explicitly
clicked or typed — the detector never auto-answers anything.

### 6. Chat input

Bottom input box; Enter sends `text + \r` to the PTY via the pane's existing
binding; Shift+Enter inserts a newline and multiline sends use bracketed
paste (`ESC[200~ … ESC[201~`) so the TUI receives it as one block. Slash
commands pass through as plain text. While a `menu` prompt card is active the
input box stays enabled (typed keys may be what an unrecognized TUI state
needs) but shows a hint pointing at the card. Input history (up-arrow) local
to the pane, capped at 50 entries, not persisted.

## Error handling

- Unparseable JSONL lines → skipped with a counted "N entries unreadable"
  system chip; never a crash, never blocks later entries.
- Feed poll errors (file locked/vanished) → stale banner with retry; terminal
  unaffected.
- Markdown render failure for one entry → that bubble falls back to plain
  text.
- Detector exceptions → treated as no-detection; card system stays quiet.
- The chat NEVER writes to the transcript file and never blocks the PTY.

## Testing

- Claude adapter: fixture JSONL files (real session excerpts incl.
  queue-operation user messages, tool pairs, thinking, compaction boundary)
  → normalized-entry snapshots; incremental-parse (partial trailing line)
  tests.
- Feed: poll/offset/truncation-reopen unit tests (Rust) against temp files.
- PromptDetector: one fixture per supported prompt shape + negatives (plain
  output, scrolling logs) + keystroke computation tests.
- Components: bubble rendering per entry kind, density policies, prompt-card
  answer flow (fake binding records keystrokes), input box send/multiline.
- Gates: ui tsc clean; vitest ≥ 914 baseline + new; e2e ≥ 6; cargo host 154;
  cargo termx-ui 162 + new (run from ui/src-tauri).
- Manual gate: Michael runs a real Claude Code session in chat view through a
  permission prompt, an AskUserQuestion, and a plan approval.

## Out of scope (this round)

Warp-style blocks for plain shell commands; Codex-native transcript adapter;
rich chat rendering of historical (non-live) sessions beyond the existing
viewer; auto-answering of any prompt; voice/notifications.
