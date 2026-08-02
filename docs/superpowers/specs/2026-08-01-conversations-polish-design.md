# TermX Conversations Polish — Design (2026-08-01)

Follow-up batch to `2026-07-31-termx-conversations-design.md`, driven by
Michael's first live session with the shipped Conversations build. Six
features. Michael's words are quoted where they are the requirement.

## P1. Intent-aware note digest (Rust)

Today's digest feeds Haiku only the newest turns of a 512KB tail read. The
result misses what the session *set out to do*. Per Michael: "take the first
two or three messages that the user sent, and then the last message that the
user and AI had sent, and then use that to compile the written summary."

- New head read: first 64KB of the transcript (`head_excerpt`), parsed with
  the same tolerant `dialogue_turn` machinery; keep the **first 3 user
  turns** (each clipped to 700 chars). Budget ≤ 2,000 chars.
- Tail digest as today (newest-first within budget), budget ≤ 4,000 chars.
- Combined stdin format (labels help the model separate intent from state):

```
[How the session started]
user: ...
user: ...

[Latest exchange]
user: ...
assistant: ...
```

- Raw-tail fallback unchanged (only when NOTHING parses in head or tail).

## P2. Generated titles + one-call bundle (Rust + TS)

"Because I forget to name a session… when you click on it, it has a
generated title… If the chat already has a given title and not only a
session ID, then it should be ignored (that should be the set title)."

- **Title provenance.** `SessionRecord` gains `titleSource:
  "named" | "derived"` (serde camelCase).
  - Claude: the `type:"summary"` JSONL line is the session's given title
    (it is what Claude Code itself displays). When present → `title` = that
    line, source `named`. Otherwise (first-user-text fragment or bare id)
    → `derived`.
  - Codex: a non-empty title from the Codex index → `named`; otherwise
    `derived`.
  - TS parse is tolerant: missing field → `"named"` (conservative: never
    replace a title we are not sure is derived).
- **One generation call per session.** New Tauri command
  `generate_session_bundle(filePath) -> Option<{title, summary, recap}>`
  (all fields `string | null`). One Haiku call produces all three, mutually
  consistent, at a third of the cost. The old `generate_session_note`
  command stays (compat + tests) but the scheduler switches to the bundle.
- **Bundle output contract** (system prompt instructs; Rust parses):

```
TITLE: <at most 60 chars, a name for the session>
DESCRIPTION: <two short sentences, three max, ≤360 chars: what the session
was about and where it ended up>
RECAP:
- <3 to 5 bullets: what was happening and where it stands>
```

  Parsing is tolerant: missing sections yield `null` for that field only;
  shaping rules per field match today's `shape_note` (title: one line ≤60
  chars; summary: joined paragraph ≤360; recap ≤5 bullets).
- **Display rule (UI).** Effective title =
  `record.titleSource === "derived" && generated.title ? generated.title
  : record.title`. Applies to the rail rows, detail pane header, and the
  session palette. The generated title never overwrites the record.

## P3. Description as its own field (TS UI)

"On the transcript desc, I want that to be apart from the recap
summarization and title." Detail pane order: **effective title** →
**Description** (the two-sentence generated summary) → **Recap** (bullets)
→ Files touched. Description and recap are visually distinct sections with
their own headers, not one merged note blob.

## P4. Output pane — explicit deliverables, zero mining (Rust + TS + hook)

Michael rejected extension heuristics ("there will be times where I'm
asking it deliberately to generate code") in favor of explicit signals,
"a lot like how the Claude Code UI will give you an output file section."
Decided (all three layers + dismissal):

- **`termx-output` helper**: a small CLI staged beside the exes.
  `termx-output <path> [--label "text"]` appends
  `{sessionKey?, termxSession?, path, label?, atMs}` to
  `%APPDATA%\TermX\outputs_v1.jsonl` (append-only; TERMX_SESSION read
  from env; Claude session id accepted via `--session <id>`), and when
  stdout is a TermX pane also emits the private OSC
  `ESC ] 9 ; 77 ; output ; <path> ST` so the app registers it live.
- **Claude Code hook** (installed via harness-lab deploy, NOT a direct
  `~/.claude` edit): PostToolUse on SendUserFile + Artifact publishes →
  calls `termx-output` with the delivered path(s) and the hook's session
  id.
- **Output-ish folder rule**: the hook also fires on Write/Edit whose
  path contains a segment named `output`, `outputs`, `dist`,
  `deliverables`, or `exports`.
- **CLAUDE.md convention** (harness-lab deploy): every session is told to
  run `termx-output` on each deliverable it produces — covers Codex and
  any other CLI.
- **UI**: a right-side dockable **Output pane** (reuses the viewer's
  dock/geometry system) listing the active session's outputs live (OSC +
  sidecar); click opens the native viewer. The Conversations detail pane
  gains an **Outputs** section above "Files touched" showing the selected
  session's sidecar records.
- **Dismissal (Michael)**: every entry has a remove affordance ("if it
  does catch an intermediary… easily remove it from that list without
  deleting the file"). Dismissals persist (a `dismissed: true` tombstone
  appended to the sidecar; the file itself is never touched) so removed
  entries stay gone across restarts and rescans.
- **Files touched is unchanged and complete** — all files including
  helper scripts; Outputs sits above it as the headline section.

## P5. Sidebar breathing room (TS UI)

"Everything in the sidebar… seems too crammed."

- **Resizable sidebar**: a drag handle on the sidebar's right edge; width
  clamped 200–480px; persisted as `uiState.sidebarWidth` (number, px);
  double-click resets to default (260). Pointer-event drag identical in
  spirit to SplitLayout's divider.
- **Full-screen conversations**: a maximize control (⛶) in the rail header
  expands Conversations over the entire TermX window: list left, detail
  pane right (two-pane layout, wide rows, full-width description/recap).
  Esc or the restore control returns to the sidebar. Ephemeral App state —
  not persisted. Terminals keep running underneath (never unmounted —
  same display:none discipline as hidden tabs).

## P6. Resume dedupe (TS)

"If I hit resume, it should see if that tab is already open… with a pop up
that says 'already open, switch to tab?'"

- The controller records, per resume, `sessionKey → tabId` (runtime map;
  entries dropped when the tab closes or its pane dies).
- `resumeSession(record)` when the key maps to a live tab returns
  `{ kind: "already-open", tabId }` instead of opening; otherwise resumes
  as today and returns `{ kind: "opened" }`.
- App shows a small dialog: "This session is already open. Switch to that
  tab?" → **Switch** (activates the tab) / **Open anyway**
  (`resumeSession(record, { force: true })`). Esc = cancel.
- Applies to every resume entry point (rail, palette).

## P7. Grouping parity with tabs (TS UI)

"I would like the conversations to be able to be grouped like the tabs
are, without changing the path location." The rail's folders already do
path-independent grouping (assignments live in `conversations_v1.json`;
files never move) — this item brings them to tab-group ergonomics:

- Right-click a conversation row → "Move to group ▸" listing existing
  folders + "New group…" (same menu pattern as tabs).
- Folders collapse/expand with a chevron and remember their open state
  (persisted with the folder).
- A row can be dragged onto a folder header to assign it (same
  drag-affordance class as sidebar tab drags); drag out to ungrouped.
- Folder rename/delete via right-click on the folder header (delete only
  unassigns — sessions are never touched).
- Works identically in the full-screen view (P5).

## Non-goals

- No changes to the transcript viewer, sleep, trays, or close behavior.
- No regeneration of notes when a valid bundle exists (staleness rule
  unchanged: regenerate when `updatedAtMs` moves past the stored note).
- The old per-kind note command's engine-mode settings semantics are
  unchanged; the bundle honors the same `summaryEngine` gate.
