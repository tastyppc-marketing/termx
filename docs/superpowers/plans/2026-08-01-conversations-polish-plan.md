# Conversations Polish Implementation Plan (2026-08-01)

> **For agentic workers:** execute per-task briefs; commit ONCE per worktree
> ("wip: <task>"); main thread reviews, cherry-picks, gates, integrates.

**Goal:** Ship spec `2026-08-01-conversations-polish-design.md` (P1–P7).

**Baselines at dispatch:** ui vitest **661**, tauri crate **128**, host 118,
e2e 5. Gates per lane: `npx tsc -b` + `npx vitest run --reporter=dot` from
`ui\`; `cargo test -q -p termx-ui` from `ui\src-tauri`; `cargo test -q` from
repo root for host changes. exactOptionalPropertyTypes discipline applies.

## Global Constraints

- Sleep/terminals invariants untouched. No changes to viewer internals,
  trays, close behavior.
- Notes CLI isolation flags stay verbatim: `-p --model
  claude-haiku-4-5-20251001 --no-session-persistence --safe-mode --tools ""
  --system-prompt <instruction>`; CREATE_NO_WINDOW stays.
- `~/.claude` changes ONLY via harness-lab deploy.ps1 (PH1, main thread).
- Generated titles never overwrite `SessionRecord.title`.

## Task PN1 — Rust: intent digest + bundle + titleSource (worktree pn1-notes)

Files: `ui/src-tauri/src/llm_sessions/{note.rs,claude.rs,codex.rs,mod.rs}`.

- `head_excerpt(path, cap)` (first `cap` bytes, drop trailing partial line).
- `dialogue_digest_v2(head: &str, tail: &str) -> String`: first 3 user turns
  from head (≤2,000 chars, each turn ≤700) under `[How the session started]`,
  then tail digest (existing newest-first logic, budget 4,000) under
  `[Latest exchange]`. Either section absent when empty; both empty → "".
- Bundle: `pub fn bundle_instruction() -> &'static str` (spec P2 output
  contract verbatim: TITLE:/DESCRIPTION:/RECAP: sections, same
  data-not-request guard as today), `pub fn parse_bundle(raw) ->
  BundleNote { title: Option<String>, summary: Option<String>, recap:
  Option<String> }` (tolerant; title one line ≤60 chars via clean_text;
  summary joined ≤360; recap ≤5 "- " bullets; all-None → treated as
  failure), `pub fn generate_bundle_with(program, path, timeout) ->
  Option<BundleNote>`.
- mod.rs: `#[tauri::command] generate_session_bundle(file_path: String) ->
  Option<BundleNote>` (same allowlist/canonicalize guard as
  generate_session_note; BundleNote derives Serialize with camelCase).
  Existing generate_session_note untouched.
- titleSource: `SessionRecord` gains `title_source: String` serde-renamed
  `titleSource`, values `"named"|"derived"`. claude.rs: summary-line
  present → title = summary line, `named`; else first-user-text/id →
  `derived`. codex.rs/mod.rs: non-empty index title → `named`, else
  `derived`. Update adapter tests accordingly.
- Do NOT wire lib.rs/build.rs/capabilities (main thread).

## Task PN2 — Rust: outputs sidecar + helper (worktree pn2-outputs)

Files: `src/bin/termx-output.rs` (new bin in termx-host crate),
`ui/src-tauri/src/outputs.rs` (new), tests beside each.

- Sidecar: `%APPDATA%\TermX\outputs_v1.jsonl`, append-only JSONL:
  `{"sessionKey": "claude:<id>"|null, "termxSession": string|null,
  "path": string, "label": string|null, "atMs": number,
  "dismissed": bool?}`. A later `{sessionKey, path, dismissed: true}`
  tombstones every earlier record with the same (sessionKey, path).
- `termx-output <path> [--label <text>] [--session <claude-session-id>]`:
  resolves `<path>` to absolute; sessionKey = `claude:<id>` when --session
  given else null; termxSession from env TERMX_SESSION; appends record;
  when TERMX_SESSION is set also prints `\x1b]9;77;output;<abs-path>\x07`
  to stdout. Exit 0 even when the sidecar write fails (never break a hook
  chain); data dir resolved like the host does (APPDATA), never hardcoded.
- outputs.rs commands (wiring by main): `list_session_outputs(session_key:
  String) -> Vec<OutputEntry{path, label, atMs, exists}>` (tombstones
  applied, newest first, exists = fs check),
  `dismiss_session_output(session_key: String, path: String) -> bool`
  (appends tombstone). Both tolerate a missing/corrupt sidecar (empty vec /
  false). Path containment NOT required (outputs may live anywhere) but
  entries are data, never executed.

## Task PU2 — Rail/detail UI (worktree pu2-detail)

Files: `ui/src/conversations/{ConversationsRail.tsx,DetailPane.tsx,
folderOps.ts,*.css,__tests__/*}`.

- Effective title: `effectiveTitle(record, generated)` in folderOps.ts =
  generated.title when `record.titleSource === "derived"` and generated
  title non-empty, else record.title. Rows, DetailPane header, search
  matching all use it (search matches BOTH titles).
- DetailPane sections in order: header (effective title; when generated
  title shown, set line `title=` tooltip carries the raw record.title),
  **Description** (generated summary, own h3, pre-wrap), **Recap** (own
  h3), **Outputs** (new, from injected `listOutputs(sessionKey)`, rows like
  files-touched rows + a ✕ dismiss affordance calling injected
  `dismissOutput(sessionKey, path)` then refreshing; empty → section
  hidden), **Files touched** (unchanged, complete).
- P7 folder ergonomics: folders collapse/expand (chevron; open state
  persisted on the folder object via store.updateFolder — add
  `collapsed?: boolean` to FolderV1 tolerant-parsed), "Move to folder ▸"
  gains "New group…" (creates then assigns), row dragging onto a folder
  header assigns (HTML5 drag or pointer, match sidebar tab drag class
  conventions), works identically when rail is rendered with
  `variant="expanded"` (PU3 contract: rail accepts optional
  `variant?: "sidebar" | "expanded"`, default sidebar; expanded = wider
  rows, detail pane beside list — pure CSS/layout, no logic fork).
- Injected props (App wires): `listOutputs`, `dismissOutput`,
  `generatedFor(key) -> GeneratedNote` already flows via store snapshot.

## Task PU3 — Sidebar resize + fullscreen (worktree pu3-layout)

Files: `ui/src/sidebar/{Sidebar.tsx,Sidebar.css}`, `ui/src/workspace/
uiState.ts`, `ui/src/conversations/fullscreen CSS only via rail variant`,
tests.

- uiState: `sidebarWidth?: number` (tolerant parse, clamp 200–480,
  absent = default 260) + `setSidebarWidth`. Sidebar renders drag handle
  (right edge, pointer capture like SplitLayout divider; double-click
  resets by clearing the field). App applies width via style on the
  sidebar container (App wiring: main thread).
- Fullscreen: Sidebar's conversations header gains ⛶ button calling new
  optional prop `onExpandConversations?()`. (The fullscreen surface itself
  is App-rendered: rail `variant="expanded"` inside a window-covering div;
  Esc + restore button call the close callback. Component
  `ui/src/conversations/ConversationsFullscreen.tsx` OWNED BY THIS TASK:
  props `{store, settings, sidebarConversations-like callbacks, onClose}`,
  renders header (restore ⛶ + Esc hint) + `ConversationsRail
  variant="expanded"`. Keyboard: Esc closes, scoped to the overlay.)
- Terminals under the overlay stay mounted (overlay is display-layered,
  never unmounts `.app-main`).

## Task PU4 — Resume dedupe (worktree pu4-dedupe)

Files: `ui/src/workspace/WorkspaceController.ts`, `ui/src/conversations/
resume.ts`, tests.

- Controller keeps `resumedTabs: Map<SessionKey, string>` (tabId).
  Populated on successful resumeSession; entry dropped when that tab
  closes/dies (hook into existing close/dead paths).
- `resumeSession(record, options?: { force?: boolean }) ->
  Promise<ResumeOutcome>` where `ResumeOutcome = { kind: "opened" } |
  { kind: "already-open"; tabId: string } | { kind: "refused" }`
  (refused = existing validation failures; current behavior preserved).
  Without force, a live mapped tab → `already-open` and NO tab creation.
- App dialog (component `ui/src/conversations/AlreadyOpenDialog.tsx`,
  owned here): "This session is already open. Switch to that tab?" —
  buttons Switch / Open anyway / Esc cancels. Pure component; App wires
  outcome→dialog→activateTab or resumeSession(record, {force:true}).

## Task PU5 — Output pane (worktree pu5-outputpane)

Files: `ui/src/outputs/{OutputPane.tsx,OutputPane.css,outputsStore.ts,
__tests__/*}`, `ui/src/terminal/TerminalSessionBinding.ts` (OSC only).

- Binding: parse OSC `9;77;output;<path>` in the existing OSC handler
  path; new optional callback `onOutputRegistered(path: string)` on the
  binding's callbacks (fires live only, never during replay — same
  live-vs-replay discipline as cwd OSC).
- `outputsStore.ts`: tiny subscribable keyed by termx session id:
  `register(sessionId, path)`, `snapshotFor(sessionId): readonly
  {path, atMs}[]` (runtime-only; sidecar is source of truth for history —
  pane merges: injected `listOutputs` for the session's key + live
  registrations, deduped by path).
- OutputPane: right-side dock reusing the viewer geometry pattern
  (`viewerGeometry`-style but its own `uiState.outputPaneGeometry?` —
  tolerant parse, default hidden/tray). Rows: leaf-emphasized path, click
  → injected `onOpenFile(path)`, ✕ dismiss → injected callback. Header
  shows active session context. Empty state: short hint mentioning
  `termx-output`.

## Main thread (serialized, after lanes merge)

1. PU1 plumbing FIRST (before dispatch): TS types (`GeneratedNote` gains
   `title: string | null`; `LlmSessionRecord.titleSource` tolerant default
   "named"; `OutputEntry`), store `setGeneratedBundle(key, bundle)`,
   native wrappers `tauriGenerateBundle`, `tauriListOutputs`,
   `tauriDismissOutput`, NoteScheduler switches to one bundle call per
   record (keeps engine-mode gate + staleness rule).
2. Rust wiring: lib.rs/build.rs/capabilities for
   `generate_session_bundle`, `list_session_outputs`,
   `dismiss_session_output`; commit generated TOMLs; acl-manifests check.
3. Integration pass: App wires sidebar width, fullscreen state +
   ConversationsFullscreen, resume dialog, Output pane + binding callback,
   detail-pane injected outputs props, palette effective titles.
4. PH1: harness-lab deploy — PostToolUse hook (SendUserFile, Artifact,
   Write/Edit under output|outputs|dist|deliverables|exports) calling
   termx-output with session id; CLAUDE.md convention line. Michael
   approves the deploy diff before it lands.
5. V3: full gates, `npx tauri build --no-bundle` + host release build
   (termx-output.exe included), restage 4 exes, live checks (bundle
   quality on 3 real sessions incl. a Codex one; outputs end-to-end via a
   manual termx-output call; resume dedupe; resize + fullscreen), handoff.

## Merge protocol

Unchanged from Wave C: junction-probe (single-quoted PowerShell) before
any worktree removal; line-by-line review; `cherry-pick -n`; independent
gates; attributed commit; worktree remove + branch -D; verify main
ui/node_modules (74 entries).
