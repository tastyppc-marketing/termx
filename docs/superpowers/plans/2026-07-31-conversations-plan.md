# TermX Conversations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LLM session manager (discover/organize/resume Claude+Codex sessions), native file+transcript viewer, action-registry trays, terminal semi-sleep, window-close safety — per spec `docs/superpowers/specs/2026-07-31-termx-conversations-design.md` (THE contract; this plan adds interfaces and task boundaries).

**Architecture:** Rust harvesting/commands in `ui/src-tauri` (adapters, incremental index, windowed transcript IO), host env stamp in `host/`, React UI stores/components in `ui/src` following the existing `useSyncExternalStore` + injected-dependency patterns.

**Tech Stack:** Rust (Tauri 2), React 19 + TypeScript, vitest 4 (`--reporter=dot`; `basic` is gone), cargo test.

## Global Constraints

- Read the spec section named in your task FIRST. Spec wins over this plan on conflict; report the conflict rather than guessing.
- NEVER touch: `ui/src-tauri/src/lib.rs`, `ui/src-tauri/build.rs`, `ui/src-tauri/capabilities/default.json`, `ui/src/App.tsx`, `ui/src/sidebar/Sidebar.tsx`, `ui/src/split/SplitLayout.tsx` — unless your task EXPLICITLY lists the file. Main thread owns registration/wiring hotspots to prevent cross-agent conflicts.
- No hardcoded absolute machine paths in code (derive at runtime: `%USERPROFILE%`, exe dir, etc.).
- Commands that read user files NEVER error to the caller: missing/unreadable/malformed → empty/None. Heavy IO runs on `tauri::async_runtime::spawn_blocking`.
- All new serde structs crossing the wire use `#[serde(rename_all = "camelCase")]`.
- The WS auth token is never logged, rendered, or persisted anywhere new.
- UI suite: `npx vitest run --reporter=dot` from `C:\Dev\TermX\ui` must stay green; typecheck `npx tsc -b`. Rust: `cargo test -p termx-ui` (tauri crate) / `cargo test -p termx-host` from repo root. PostToolUse hook runs the ui suite on every src write — treat its PASS/FAIL as a gate.
- NO commits by agents. Deliver working tree changes + a report; main reviews line-by-line and commits with attribution.
- Layout rule: no control may ever overlap another (spec §12); new UI matches the existing dark aesthetic and class-naming conventions.
- Tests use the existing harness patterns: see `ui/src/workspace/__tests__/WorkspaceController.test.ts` (fixture harness), `ui/src/settings/__tests__/settings.test.ts` (tolerant parse), `ui/src-tauri/src/folders.rs` (pure-fn + tempdir Rust tests).

## Model routing & waves

| Wave | Task | Model / lane | Files root |
|---|---|---|---|
| A | R3 adapters+index | Opus (Agent tool) | `ui/src-tauri/src/llm_sessions/`, `storage.rs` |
| A | R4 TERMX env | Sonnet (Agent tool) | `host/src/registry.rs`, `host/src/session.rs` tests |
| A | R5 viewer/transcript commands | Opus (Agent tool) | `ui/src-tauri/src/{artifacts,file_view,transcript}.rs` |
| A | U6 settings fields | Sonnet (Agent tool) | `ui/src/settings/` |
| A | U15 action registry | Opus (Agent tool) | `ui/src/actions/` (new), `ui/src/workspace/uiState.ts` |
| B | U7 rail+store+folders | Opus | `ui/src/conversations/` (new), `Sidebar.tsx` (EXPLICIT exception) |
| B | U12 file viewer | GPT-5.6-sol (claude-x worktree; fallback Opus) | `ui/src/viewer/` (new), `uiState.ts` |
| B | U13 semi-sleep | Opus | `ui/src/terminal/`, `SplitLayout.tsx` (EXPLICIT exception) |
| C | U8 session palette | Grok-4.5 (claude-x; fallback Sonnet) | `ui/src/conversations/palette/` |
| C | U9 resume flow | Opus | `ui/src/workspace/WorkspaceController.ts`, `ui/src/conversations/resume.ts` |
| C | U10 note scheduler | Opus | `ui/src/conversations/noteScheduler.ts` |
| C | U11 artifacts UI | Grok-4.5 (fallback Sonnet) | `ui/src/conversations/DetailPane*` |
| C | U14 transcript mode | GPT-5.6-sol (fallback Opus) | `ui/src/viewer/transcript/` |
| C | U16 close behavior | Sonnet | `ui/src/close/` (new) |
| — | Reviews | Gemini-3.1-pro second-opinion on R3+U7; GPT-5.6-sol adversarial on U13; main line-by-line on ALL | — |
| — | Integration + V2 | Fable (main) | registration files, App.tsx, tray adoption, link action |

Wave N+1 dispatches only after every Wave N task is reviewed and committed. Within a wave, file roots are disjoint — run all in parallel.

---

### Task R3: llm_sessions adapters + incremental index (spec §1, §2)

**Files:**
- Create: `ui/src-tauri/src/llm_sessions/mod.rs` (+ `claude.rs`, `codex.rs`, `index.rs`, `note.rs` submodules as sensible)
- Modify: `ui/src-tauri/src/storage.rs` (ALLOWED_FILES += `"sessions_index_v1.json"`, `"conversations_v1.json"`)
- Do NOT touch lib.rs/build.rs/capabilities (main wires registration).

**Interfaces (Produces):**
```rust
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub provider: String,        // "claude" | "codex"
    pub id: String,
    pub title: String,           // never empty
    pub cwd: Option<String>,
    pub file_path: String,
    pub updated_at_ms: u64,
    pub summary: Option<String>,
    pub recap: Option<String>,
}
#[tauri::command] pub async fn list_llm_sessions(force: bool) -> Vec<SessionRecord>
#[tauri::command] pub async fn generate_session_note(file_path: String, kind: String) -> Option<String>
```
Pure cores for tests: `harvest_claude_file(path, head: &str, tail: &str) -> Option<SessionRecord>`-style functions taking injected content/roots so tempdir fixtures drive everything.

**Behavior:** exactly spec §1 (bounded 256 KB head+tail reads; cwd from content, slug fallback; LAST summary line; NEWEST compaction block trimmed to 2,000 chars for recap; title chain first-user-message → summary → id) and §2 (index file via the same read/write path storage.rs uses — stat-compare mtime+size, re-harvest changed, drop vanished, sorted desc, `force` bypass). `generate_session_note`: spawn `claude` (`-p`, `--model claude-haiku-4-5-20251001`) with instruction as the prompt arg and the last 8 KB of the transcript piped to stdin; 30 s timeout then kill; `kind` = `"summary"` (one line, ≤120 chars) or `"recap"` (3–5 bullets); ANY failure → `None`. Never log transcript content.

- [ ] Tests (tempdir fixtures): summary-line wins-last; recap = newest compaction block; cwd from content beats ambiguous slug; slug decode fallback works when no cwd line; malformed lines skipped; title fallback chain; codex index parse + rollout cwd lookup + missing rollout → cwd None; index incrementality (unchanged file NOT re-read — probe via a read counter or a poisoned file that would fail if read); vanished file dropped; force re-reads; allowlist additions accepted by storage read/write; note timeout/absent-binary → None (don't invoke real `claude` in tests — inject the command name).
- [ ] `cargo test -p termx-ui` green, `cargo clippy --all-targets -p termx-ui` clean, `cargo fmt`.
- [ ] Report: exact public signatures, fixture inventory, test count.

### Task R4: TERMX env stamp (spec §7)

**Files:** Modify `host/src/registry.rs` (append to resolved profile env before spawn), test in `host/src/session.rs` or registry tests.

**Behavior:** In `Registry::create_session`, after `profiles::resolve`, push `("TERMX", "1")` and `("TERMX_SESSION_ID", <id>.to_string())` onto `prof.env` (id already assigned). Independent of `shell_integration`.

- [ ] Test: real spawn of cmd with args `/c echo TX:%TERMX_SESSION_ID%:%TERMX%` via the registry (so the id is stamped); pump output; assert `TX:<id>:1` appears. Plus a unit assert that both vars are present in the env the registry builds (refactor a pure helper if needed).
- [ ] `cargo test -p termx-host` all green (~116+), clippy clean. Report exact new test names.

### Task R5: artifacts + file/transcript commands (spec §11, §12)

**Files:** Create `ui/src-tauri/src/artifacts.rs`, `ui/src-tauri/src/file_view.rs`, `ui/src-tauri/src/transcript.rs`. Do NOT touch lib.rs/build.rs/capabilities/storage.rs.

**Interfaces (Produces):**
```rust
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct Artifact { pub path: String, pub kind: String /* "created"|"edited" */, pub exists: bool }
#[tauri::command] pub async fn list_session_artifacts(file_path: String) -> Vec<Artifact>

#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct FileText { pub content: String, pub truncated: bool }
#[tauri::command] pub async fn read_text_file(path: String) -> Option<FileText>

#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct TranscriptWindow { pub lines: Vec<String>, pub next_before_offset: Option<u64> }
#[tauri::command] pub async fn read_transcript_window(file_path: String, before_offset: Option<u64>, max_bytes: u32) -> TranscriptWindow

#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct TranscriptMatch { pub offset: u64, pub snippet: String }
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct SearchResult { pub matches: Vec<TranscriptMatch>, pub truncated: bool }
#[tauri::command] pub async fn search_transcript(file_path: String, query: String, mode: String /* "substring"|"regex"|"fuzzy" */, filter: String /* "all"|"user" */, max_results: u32) -> SearchResult
```

**Behavior:** artifacts per spec §11 (streamed line scan; tool names Write/Edit/MultiEdit/NotebookEdit; `input.file_path` or `input.notebook_path`; dedupe by case-insensitive path; created beats edited; stat exists). `read_text_file` per §12 (2 MB cap → truncated:true; NUL in first 8 KB → None; missing/unreadable → None). `read_transcript_window` per §12 transcript mode (chunk ends at before_offset or EOF; drop leading partial line; its start offset = next cursor; next=None at offset 0; max_bytes clamped to [4 KB, 4 MB]). `search_transcript` per §12 (streamed; substring case-insensitive; regex via `regex` crate — invalid pattern → empty result with truncated:false, never a panic; fuzzy = case-insensitive subsequence; filter "user" = only lines whose JSON has `"type":"user"` (tolerant contains-check acceptable if a parse fails); snippet ≤200 chars around the match, control chars stripped; cap max_results (default clamp 1..=1000), truncated flag when more exist).

- [ ] Tests (tempdir fixtures, real multi-MB synthetic file for windowing): artifact dedupe/kind/exists; NUL-sniff; cap+truncated flag; window pagination walks backward through a file whose every line is numbered (assert exact reconstruction, no lost/duplicated lines across cursors); partial-line discipline; search: all three modes, user filter, offset correctness (byte offset of line start), invalid regex safe, truncation flag.
- [ ] `cargo test -p termx-ui` green, clippy clean, fmt. Report exact signatures + test names.

### Task U6: settings fields (spec §8)

**Files:** Modify `ui/src/settings/settings.ts`, `SettingsStore.ts` (no-op detection), `SettingsDialog.tsx` (+`.css` minimal), tests in `ui/src/settings/__tests__/`.

**Interfaces (Produces):** `TermxSettings` gains EXACTLY:
```ts
conversationsRail: boolean;               // default true
conversationsPalette: boolean;            // default true
summaryEngine: "disk-first" | "disk-only" | "llm";       // default "disk-first"
summaryContent: "summary" | "recap" | "both" | "none";   // default "summary"
summaryDisplay: "hover" | "under-title";  // default "hover"
sleepHiddenTerminals: "off" | "5" | "15" | "60";         // default "15"
onWindowClose: "ask" | "keep-running" | "stop-all";      // default "ask"
```
Exported unions: `SUMMARY_ENGINES`, `SUMMARY_CONTENTS`, `SUMMARY_DISPLAYS`, `SLEEP_OPTIONS`, `CLOSE_BEHAVIORS` (as const arrays, same pattern as `NEW_TAB_POLICIES`).

**Behavior:** tolerant per-field parse (invalid → default, preserve other fields); serialize round-trips; dialog gains a "Conversations" section (rail/palette toggles + three radios) and a "Terminals" section (sleep radio + close-behavior radio with the §15 explanation copy: closing the window keeps terminals and agents running in the background). Instant-apply like existing controls; focus-trap untouched.

- [ ] Tests: defaults; each field tolerant-parse (wrong type → default); round-trip; dialog fires onChange with exact patch per new control (extend the existing dialog test pattern).
- [ ] `npx vitest run --reporter=dot` + `npx tsc -b` green. Report: exact field/union names.

### Task U15: action registry + trays + Features dock (spec §14)

**Files:** Create `ui/src/actions/registry.ts`, `ui/src/actions/Tray.tsx`, `ui/src/actions/FeaturesDock.tsx` (+css), tests under `ui/src/actions/__tests__/`. Modify `ui/src/workspace/uiState.ts` (add `trayChips`).

**Interfaces (Produces):**
```ts
export interface ActionChip { id: string; icon: string; label: string; run: (ctx: ActionContext) => void }
export interface ActionContext { [key: string]: unknown }   // opaque bag App supplies
export function registerAction(chip: ActionChip): void       // idempotent by id (last wins)
export function getAction(id: string): ActionChip | undefined
export function allActions(): readonly ActionChip[]
export type TrayId = "sidebar-footer" | "pane-toolbar" | "viewer-header";
export const DEFAULT_TRAYS: Record<TrayId, readonly string[]>;   // empty arrays for now; App fills at adoption
// uiState: UiStateV1 gains trayChips?: Partial<Record<TrayId, string[]>>  (tolerant parse; absent → undefined)
export function trayChipIds(state: UiStateV1, tray: TrayId): readonly string[]  // config ?? DEFAULT_TRAYS, unknown ids filtered
<Tray trayId=... context=... uiState=... onConfigure(trayId, ids)/>          // renders chips, right-click menu → "Remove from tray"
<FeaturesDock open onClose uiState onConfigure/>                              // lists allActions() with "Add to <tray>" per tray + "Reset layout"
```

**Behavior:** registry is module-level and side-effect-free to import; Tray renders buttons with the existing `sidebar-create__options`-style visuals; remove/add/reset write through `onConfigure` (caller persists via UiStateStore); unknown ids in persisted config are silently dropped; duplicate add is a no-op. Do NOT rewire any existing surface (adoption happens later, by main).

- [ ] Tests: register/override/all; trayChipIds fallback + unknown-id filtering; uiState round-trip with trayChips + tolerance (garbage → undefined); Tray renders chips from config, remove fires onConfigure minus the id; FeaturesDock lists actions, add fires onConfigure plus id (no dupes), reset fires with null/default sentinel.
- [ ] Suite + tsc green. Report exact exports.

### Task U7: ConversationsStore + rail + folders + detail shell (spec §3)

**Files:** Create `ui/src/conversations/{types.ts,store.ts,storage.ts,ConversationsRail.tsx,DetailPane.tsx,folderOps.ts}` (+css, tests). Modify `ui/src/sidebar/Sidebar.tsx` (mode switch ONLY — EXPLICIT exception; keep Terminals mode byte-identical) and `ui/src/workspace/bootstrapWorkspace.ts` (load conversations_v1 + expose store — follow the settings/uiState optional-field pattern).

**Interfaces (Consumes):** R3's `LlmSessionRecord` wire shape (camelCase, §R3), U6 settings, U15 Tray for the rail's footer controls.
**Interfaces (Produces):**
```ts
export interface LlmSessionRecord { provider: "claude"|"codex"; id: string; title: string; cwd: string|null; filePath: string; updatedAtMs: number; summary: string|null; recap: string|null }
export type SessionKey = string; // `${provider}:${id}`
export interface ConversationsV1 { version: 1; folders: {id:string;name:string}[]; assignments: Record<SessionKey,string>; generated: Record<SessionKey,{summary:string|null;recap:string|null;generatedAtMs:number;sourceMtimeMs:number}>; artifacts?: Record<SessionKey,{sourceMtimeMs:number;files:{path:string;kind:"created"|"edited";exists:boolean}[]}> }
export class ConversationsStore { /* useSyncExternalStore shape: getSnapshot/subscribe; actions: */
  refresh(force: boolean): Promise<void>;                     // invokes list_llm_sessions
  createFolder(name: string): void; renameFolder(id, name): void; deleteFolder(id): void;
  assign(key: SessionKey, folderId: string | null): void;
  select(key: SessionKey | null): void;
  noteFor(record, settings): { summary: string|null; recap: string|null };  // disk vs generated per summaryEngine
}
export function parseConversations(text: string | null): ConversationsV1;   // tolerant
export function serializeConversations(v: ConversationsV1): string;
<ConversationsRail store settings onResume(record) onOpenTranscript(record)/>
<DetailPane record note onResume onOpenTranscript/>   // Files-touched section = placeholder slot for U11
```
**Behavior:** spec §3 exactly — chips, debounced search over title+cwd+summary+recap, folder tree with Unfiled, right-click move/remove, row anatomy with §6 display settings (hover = title attr/tooltip; under-title = clamped secondary line; content per summaryContent incl. "both" and "none"), footer count + refreshed-ago + refresh button, detail pane fields + Resume + Open transcript buttons (callbacks provided by App later; render + fire only). Persistence through the injected app-file reader/writer exactly like `uiState` (debounced save, atomic, never throws). Deleting a folder unfiles.

- [ ] Tests: parse/serialize tolerance + round-trip; folder ops incl. delete-unfiles; assignment; noteFor honors all three engines (generated fills gaps only in disk-first; llm prefers generated when fresh); rail renders rows/filters/search (fake records); display-mode variants render/hide as specced; refresh invokes injected lister and sorts desc.
- [ ] Suite + tsc green. Report store API + any Sidebar diff summary (must be additive only).

### Task U12: file viewer (spec §12, minus transcript mode)

**Files:** Create `ui/src/viewer/{Viewer.tsx,ViewerHost.tsx,markdown.ts,viewerState.ts}` (+css, tests). Modify `ui/src/workspace/uiState.ts` (add `viewerGeometry`). Do NOT wire terminal links or App (main does).

**Interfaces (Consumes):** R5 `read_text_file` wire shape; U15 Tray (`viewer-header` tray hosts its controls as registered actions).
**Interfaces (Produces):**
```ts
export interface ViewerGeometry { dock: "right"|"bottom"; sizePx: number; state: "hidden"|"docked"|"overlay"|"tray" }
// uiState.viewerGeometry?: ViewerGeometry (tolerant)
export interface ViewerApi { openFile(path: string): void; openTranscript(record: LlmSessionRecord): void; close(): void }
<ViewerHost readFile={injected} geometry onGeometry(g) registerTranscript?/>  // renders dock/overlay/tray states
```
`openTranscript` renders a "transcript mode goes here" stub panel that U14 replaces (define the mount seam: `viewer/transcript/TranscriptView` lazy import with a graceful fallback if absent).

**Behavior:** markdown rendering WITHOUT new runtime deps — write a small renderer in `markdown.ts` covering: #–#### headings, paragraphs, bold/italic/inline code, fenced code blocks (monospace, no highlighting), unordered/ordered lists, links (render as text + href title, NEVER navigate), tables (GFM pipes), blockquotes; everything through React elements (no dangerouslySetInnerHTML, no HTML passthrough — raw HTML renders as literal text). Non-`.md` files → monospace `<pre>`. Truncated flag → banner "File truncated at 2 MB". Binary/missing (None) → inline notice. Dock right default 380 px, drag-resize handle, dock-to-bottom control, `Ctrl+Shift+M` toggles docked↔overlay (window-level listener only while viewer visible), minimize→tray pill (filename, click restores), close. Geometry persists via onGeometry (caller saves to uiState). Never overlaps: docked mode reserves layout space (flex sibling, not absolute).

- [ ] Tests: markdown.ts unit coverage per construct incl. raw-HTML-as-text and link-no-navigate; viewer state machine transitions (docked↔overlay↔tray↔hidden); truncated banner; None → notice; Ctrl+Shift+M only when visible; geometry callback fires on dock/resize changes; uiState viewerGeometry tolerant parse.
- [ ] Suite + tsc green. Report exports + the transcript mount seam contract.

### Task U13: terminal semi-sleep + reattach dims (spec §13)

**Files:** Modify `ui/src/terminal/TerminalPane.tsx`, `ui/src/split/SplitLayout.tsx` (EXPLICIT exception), create `ui/src/terminal/sleep.ts` (+tests). Consumes U6 `sleepHiddenTerminals`.

**Behavior:**
1. **Sleep:** a pure `SleepTracker` (in `sleep.ts`) tracks per-session last-visible timestamps (injected clock); when a hidden pane's idle exceeds the setting, SplitLayout renders a lightweight placeholder instead of TerminalPane (presentation + attachment fully disposed via existing cleanup); revealing the tab (or clicking the placeholder) remounts TerminalPane → normal attach+replay restores. Visible/active panes NEVER sleep. Setting "off" disables. Sidebar/UI badge: sleeping panes report state so the tab row can show a "zZ" marker — expose via a callback or store field consumed later by main (document the exact seam).
2. **Reattach dims:** on EVERY TerminalPane attach where the session's host-reported cols/rows are known (SessionInfo has them), size the xterm to those dims BEFORE replay, and only after `replayFinished` run fit + host resize. Assert the ordering with a fake presentation that records `(resize-to-recorded → replay → fit-resize)`.

- [ ] Tests: SleepTracker pure logic (thresholds, off, visible-never-sleeps, wake resets); SplitLayout swaps pane↔placeholder per tracker verdict (fake timer); remount on reveal; dim-ordering test as above; existing 361+ suite untouched.
- [ ] Suite + tsc green. Report the sleep-state seam + any SplitLayout structural changes.

### Task U8: session palette (spec §4)

**Files:** Create `ui/src/conversations/palette/SessionPalette.tsx` (+css, tests). Consumes ConversationsStore (U7), fuzzy helpers from `ui/src/folders/fuzzyScore.ts` where reusable.

**Behavior:** overlay clone of FolderSearch's interaction contract (combobox, ArrowUp/Down wrap, Enter, Esc, pointer, race-free since data is local); query fuzzy-matches over title+cwd+summary; rows: provider badge, title, shortened cwd, relative time; Enter/click fires `onResume(record)`; cap 12 rows; empty-query shows most recent. No window-shortcut wiring (main wires Ctrl+Shift+R + the `conversationsPalette` setting gate).

- [ ] Tests mirroring `FolderSearch.test.tsx`: keyboard walk, Enter fires with the highlighted record, Esc closes, filtering correctness.
- [ ] Suite + tsc green.

### Task U9: resume flow (spec §5)

**Files:** Create `ui/src/conversations/resume.ts` (+tests). Modify `ui/src/workspace/WorkspaceController.ts`.

**Interfaces (Produces):**
```ts
export function resumeCommand(record: { provider: string; id: string }): string | null;
// "claude --resume <id>" | "codex resume <id>" | null when id fails /^[A-Za-z0-9-]+$/ or provider unknown
// WorkspaceController gains:
resumeSession(record: LlmSessionRecord): Promise<void>;
```
**Behavior:** spec §5 — Claude with missing/nonexistent cwd → notice + stop (inject a `dirExists(path): Promise<boolean>` dependency, default via the existing list_dirs-style probe or a tiny injected fn; tests fake it); Codex missing cwd → null-cwd tab. Create tab via `createTabWithCwd`/down-chain; then wait for that session's first LIVE OSC 9;9 report (controller already receives `reportSessionCwd(sessionId, path, live)` — add a one-shot waiter keyed by session id) with 15 s timeout; shell-integration-off setting → fixed 1.5 s delay instead; then send `<command>\r` as input through the attachment hub's `attach`/sendInput seam (document exactly which seam you use; add one if the hub lacks a direct write — smallest possible surface). Never build the command from anything but validated fields.

- [ ] Tests: resumeCommand validation matrix (valid uuids, `../evil`, empty, unknown provider); claude-missing-dir refusal notice; codex fallback; OSC-ready path sends exact bytes `claude --resume X\r` (fake hub records writes); timeout path sends anyway; integration-off delay path (fake timers).
- [ ] Suite + tsc green. Report the input seam used.

### Task U10: LLM note scheduler (spec §6)

**Files:** Create `ui/src/conversations/noteScheduler.ts` (+tests). Consumes ConversationsStore + settings.

**Interfaces (Produces):**
```ts
export class NoteScheduler {
  constructor(deps: { generate(filePath: string, kind: "summary"|"recap"): Promise<string|null>; store: /* minimal store facade */; settings: SettingsReaderLike; now(): number });
  reconcile(visibleKeys: SessionKey[]): void;  // called by rail/palette on visibility changes
  dispose(): void;
}
```
**Behavior:** spec §6 — engine `disk-only` → never generate; `disk-first` → only missing kinds; `llm` → regenerate stale; stale = record.updatedAtMs > generated.sourceMtimeMs AND now − generatedAtMs ≥ 10 min; concurrency 1 (queue, FIFO by most-recently-updated first); only keys in the latest `reconcile` set; failures cached-untouched and eligible again after the window; results written to store.generated with sourceMtimeMs = record.updatedAtMs at generation start.

- [ ] Tests (fake timers + injected generate): engine matrix; staleness math; concurrency-1 ordering; visibility gating (hidden key never generated, even mid-queue); failure leaves cache and retries after window; dispose cancels pending.
- [ ] Suite + tsc green.

### Task U11: artifacts UI in detail pane (spec §11)

**Files:** Modify `ui/src/conversations/DetailPane.tsx` (fill the U7 placeholder), create `ui/src/conversations/artifacts.ts` (+tests).

**Behavior:** collapsed "Files touched" section; on first expand call injected `listArtifacts(filePath)` (R5 wire shape), cache in ConversationsStore per spec (`artifacts` map keyed by sourceMtimeMs = record.updatedAtMs; refetch only when record newer); render created/edited groups with leaf-preserving truncation (reuse `splitForDisplay` from `ui/src/folders/fuzzyScore.ts`), gray `exists:false` rows; click → `onOpenFile(path)` (App wires to viewer); right-click → "Open folder in new tab" → `onOpenFolder(parentDir)`. Loading + empty states ("No files recorded").

- [ ] Tests: lazy fetch only on expand; cache honored / invalidated by newer mtime; grouping, gray state; callbacks fire with exact paths; parent-dir derivation Windows-correct (`C:\a\b.md` → `C:\a`).
- [ ] Suite + tsc green.

### Task U14: transcript mode (spec §12 transcript + search)

**Files:** Create `ui/src/viewer/transcript/{TranscriptView.tsx,transcriptModel.ts,TranscriptSearch.tsx}` (+css, tests), mounting into U12's documented seam.

**Behavior:** spec §12 — open at end via `read_transcript_window` (injected invoke wrappers); "Load earlier" pages backward with `nextBeforeOffset`; parse lines tolerantly: user/assistant text rendered (assistant text through U12's `markdown.ts`), tool calls/results as one-line expandable stubs (`tool: <name> <primary arg>`), unknown lines skipped; ~10 MB parsed guard drops farthest chunks (offsets retained for reload). Search bar (Ctrl+F when transcript focused): mode selector substring/regex/fuzzy → `search_transcript`, next/prev walks matches, selecting a match loads its chunk and highlights the line; invalid regex → inline error from the command's empty result + local validation. Jump-to-last-user (button + Ctrl+Shift+J when focused): `search_transcript(filter:"user")` most-recent first; repeats walk earlier; bottom-scroll resets. Loading/error states minimal and non-blocking.

- [ ] Tests (injected fake commands): pagination reconstructs ordered turns across cursors; stub collapse/expand; markdown routing for assistant text only; memory-guard eviction + reload; search mode switch calls with right args, match selection loads chunk + highlights; jump walk + reset semantics; Ctrl+F/Ctrl+Shift+J scoped to focus.
- [ ] Suite + tsc green. Report the invoke-wrapper module path (`ui/src/native/transcript.ts` expected).

### Task U16: window-close behavior (spec §15)

**Files:** Create `ui/src/close/{CloseGuard.tsx,closeBehavior.ts}` (+tests). Consumes U6 `onWindowClose`.

**Interfaces (Produces):**
```ts
export type CloseDecision = "keep-running" | "stop-all";
export function decideOnClose(setting: TermxSettings["onWindowClose"], anyAlive: boolean): CloseDecision | "ask" | "silent";
<CloseGuard open onDecide(decision, remember: boolean) />  // the §15 dialog, focus-trapped like SettingsDialog
```
**Behavior:** pure `decideOnClose`: no alive sessions → "silent"; setting keep-running/stop-all → that; ask → "ask". Dialog copy per §15 ("Your terminals keep running in the background", body explains agents keep running and reopening restores, Keep running / Stop everything buttons, Remember checkbox). No Tauri close-event wiring (main wires `onCloseRequested` + client.shutdown()).

- [ ] Tests: decideOnClose matrix; dialog renders copy, buttons fire (decision, remember) pairs, focus trap, Esc = Keep running without remember.
- [ ] Suite + tsc green.

### Integration (main thread, after each wave)

- [ ] After Wave A: wire R3+R5 commands into lib.rs/build.rs/capabilities (one commit); verify `gen/schemas/acl-manifests.json` resolves all five new permissions; ui suite + cargo green.
- [ ] After Wave B: App.tsx renders ViewerHost + Conversations mode plumbing; Sidebar tray adoption for existing footer buttons (register gear/⌕/new-tab as actions; `sidebar-footer` DEFAULT_TRAYS filled); path-link "view file" action; sleep badge in sidebar rows.
- [ ] After Wave C: Ctrl+Shift+R wiring gated on `conversationsPalette`; resume/transcript/artifact callbacks; CloseGuard + Tauri `onCloseRequested` + `HostClient.shutdown()` for stop-all; NoteScheduler instantiation gated on engine setting.
- [ ] Reviews: dispatch Gemini-3.1-pro on R3+U7 diffs and GPT-5.6-sol adversarially on U13 (prompt: try to break the lifecycle — leaks, double-dispose, replay-dim races); triage their findings, fix what's real.

### Task V2: verify + restage (main)

- [ ] All gates: `cargo test -p termx-host`, `cargo test -p termx-ui`, ui `npx vitest run --reporter=dot`, `npx tsc -b`, `npm run build`, `npm run test:e2e`.
- [ ] Rebuild: `npx tauri build --no-bundle` from `C:\Dev\TermX\ui` (NEVER bare cargo — docs/RELEASE.md) + `cargo build --release -p termx-host`; restage `C:\Dev\TermX\dist-portable\TermX\` (all three exe names); relaunch; PrintWindow screenshot (no focus steal).
- [ ] Live checks: rail lists real sessions with sane titles/cwds; transcript of THIS repo's biggest session opens instantly and pages; resume smoke on a throwaway Claude session; sleep wake with correct dims after a window resize (spec §13 smoke: resize mid-generation, scroll up).
- [ ] Report to Michael with his interactive smoke list.
