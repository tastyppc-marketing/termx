# Pane Minimize and Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Minimize running panes into a per-tab shelf and show useful focused-session and release information.
**Architecture:** Keep all pane components mounted, project the existing split tree for visible geometry, and report visible pane IDs to attention handling. Extend status presentation through narrow controller/native seams for safe directory changes, captured model metadata, and GitHub release checks.
**Tech Stack:** React/TypeScript, Vitest, Tauri/Rust, Windows ConPTY.
**Spec:** `docs/pane-minimize-and-status.md`

## Global Constraints

- Work on the existing isolated feature branch `fix/stability-and-resume-config`; baseline `e8ab1ce`.
- Preserve live host processes and terminals. No automatic application restart.
- Retain terminal/plugin DOM identity, saved split topology, and existing maximize/selection behavior.
- No model guessed from a directory or an arbitrary default.
- Directory input targets only a confirmed idle local shell; cancellation sends nothing.
- Update checks distinguish unavailable information from up-to-date status. No automatic install or release publication.
- Tests precede behavioral implementation; verify actual sidebar/split/status UI, appropriate suites, TypeScript, and native tests.
- Build the UI with the Tauri CLI; stage both portable UI aliases with dated backups and verified hashes.

### Task 1: Minimized pane shelf

**Files:** `ui/src/split/SplitLayout.tsx`, `SplitLayout.css`, focused split helpers and tests under `ui/src/split/`.
**Consumes:** `PaneActivityModel` from `ui/src/workspace/paneActivity.ts`: `{ activity: "idle" | "active" | "unread" | "attention"; attentionSince: number | null }`.
**Produces:** optional props `paneActivity?: Readonly<Record<number, PaneActivityModel>>` and `onVisiblePanesChange?: (sessionIds: readonly number[]) => void` on SplitLayout.

- [x] Write regressions for minimizing one of three panes, restoring, last-visible protection, model/terminal DOM retention, per-tab isolation, minimized activity changes, maximize interaction, external focus, pane removal, and resizing projected geometry.
- [x] Add a Minimize pane header control and bottom restore shelf within each tab. Each chip identifies its pane and activity; finished means finished or waiting, following existing rail semantics.
- [x] Project visible geometry without changing persisted root. Dividers must resize the correct original split path when hidden nodes are contracted.
- [x] Keep minimized panes alive/attached like maximized-away panes, retain their dimensions, and prevent focus into hidden components.
- [x] Report the visible pane IDs when visibility changes; restoring or explicitly focusing a hidden pane must reveal/focus it. Do not automatically acknowledge minimized attention.
- [x] Run split tests/typecheck, self-review, and report. Do not edit App/controller/status bar/native files or commit unrelated changes.

### Task 2: Attention and safe directory integration

**Files:** `ui/src/workspace/paneActivity.ts`, `WorkspaceController.ts`, `ui/src/App.tsx`, `ui/src/statusbar/`, focused controller/App tests.

- [x] Project per-pane activity from AttachmentHub and acknowledge only actually visible panes in the active focused window.
- [x] Add a controller operation for picking/changing the focused local shell directory with idle checks before and after picking, session identity revalidation, literal shell quoting, cancellation/error handling, and no optimistic cwd changes.
- [x] Add status-bar folder control with busy/unavailable state and wire native folder picker through the existing seam.
- [x] Verify an occupied shell, dialog race, unsupported profile, cancellation, unsafe path, and disconnected/dead target never receive input.

### Task 3: Exact active-model metadata

**Files owned by implementer:** `host/src/agent_launch.rs`, `ui/src/conversations/captures.ts`, its tests, new `ui/src/native/paneAgentStatus.ts`, new `ui/src-tauri/src/pane_agent_status.rs` and their focused tests. Do not edit App/controller/bootstrap, Cargo.toml, lib.rs, build.rs, or capabilities; coordinator integrates those shared files.
**Interfaces:** Extend `ConversationCapture` with optional `model?: string | null`, `transcriptPath?: string | null`, `launcherPid?: number`, `launcherCreatedAt?: string` (decimal Windows FILETIME, not JS number). Native command `pane_agent_status(shell_pid: u32, capture: AgentCapture) -> Option<PaneAgentStatus>`; TypeScript wrapper `tauriPaneAgentStatus(shellPid: number, capture: ConversationCapture): Promise<PaneAgentStatus | null>`, where `PaneAgentStatus = { provider: "claude" | "codex"; model: string | null }`. Public Rust command/export names match exactly. Report required windows-sys features and ACL command to coordinator.

- [x] Preserve hook model/transcript_path and launcher's process creation identity in native agent capture. Keep launch configuration behavior intact. Treat model as opaque bounded text (128 characters), not provider-name patterns.
- [x] Native status verifies exact captured launcher process identity and that it descends from this pane's shell, using bounded process ancestry, live process handles, parent-before-child creation checks, and a matching provider child. PID reuse, inaccessible process, ambiguity or incomplete legacy identity returns null. SessionInfo.pid supplies shell PID. Directory safety separately extends probe_session with verified PSReadLine readiness and a one-use prompt identity.
- [x] Read at most the last 256 KiB of the exact captured transcript; Claude assistant.message.model excludes sidechains/synthetic messages, Codex turn_context.payload.model. Only records newer than capture time override hook model, so resumed history cannot override the current launch. Preserve hook model if no newer usable model record exists.
- [x] Tests first: capture metadata bounds/legacy records, same-folder pane identity, unrelated/reused PID or recycled parent, stopped launcher/provider, missing identity, model switches, stale resumed transcript records, unknown models. No live process killing in tests.
- [x] Run focused Rust/capture tests/typecheck and self-review; report files and evidence. No subagents, no commits or live-host restart.

### Task 4: Focused status UI and releases

**Files:** controller/bootstrap/App/statusbar, new update modules, native registrations/ACL and version/build files; coordinator owns this task.

- [x] Wire Task 3 through raw per-pane capture metadata, focused polling with stale response guards, and truthful unknown states. A busy shell alone never proves an LLM is running.
- [x] Show running package version and add a bounded GitHub release check suitable for this private repository; use existing GitHub CLI authentication when needed without surfacing credentials.
- [x] Expose available newer installable Windows releases through an explicit action; distinguish no releases, offline/auth failure, checking, available, and current.
- [x] Test parsing/version comparison, timeouts/failure states, status presentation and integration; update native ACL registration consistently.

### Task 5: Review and delivery

- [x] Independent task review and integration review; resolve actionable findings.
- [x] Run full UI suite, relevant native tests, TypeScript, and browser component verification.
- [x] Build/stage portable UI and host, retain dated executable backups, verify hashes and GitHub source.
- [x] Document controls, verification evidence, and any release-catalog/setup limits. Tell the user how to activate the update.

## Review refinements

- Directory changes use a dedicated atomic host operation. A descendant-process check alone cannot detect PowerShell builtins; nonce-bearing PSReadLine markers prove the exact clear prompt, and normal input invalidates it before command enqueue. Both controller and reconnect adapters forward the guarded API.
- Shared transcript writers are marked ambiguous at capture time under a cross-process lock, including writers that exit before UI polling. Legacy/native hook duplicates retain richer metadata only for the same process creation identity. UI capture compaction uses a compare-and-swap under the same lock so concurrent annotations survive.
- Native model probing retains verified process handles and refreshes process ancestry before reading the bounded transcript tail, preventing stale PID snapshots from associating a model with another pane.
- Removing the last visible pane restores the surviving focused pane even when split order differs from numeric session order. Other minimized panes keep their attention.
