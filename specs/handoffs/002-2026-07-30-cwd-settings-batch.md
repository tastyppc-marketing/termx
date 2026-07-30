# Session Handoff - 2026-07-30 (living; append as work lands)

## Context
Post-release feature batch from Michael's smoke feedback. Spec
`docs\superpowers\specs\2026-07-30-termx-cwd-settings-design.md` (approved,
committed `79aede3`), plan `docs\superpowers\plans\2026-07-30-cwd-settings-plan.md`
(`37f9a3a`). Five features: F1 group-active-path new tabs (no prompt), F2
Warp-style folder searcher, F3 settings subsystem, F4 jump-to-last-input
(Ctrl+Shift+J), F5 pane toolbar overlap fix. Task tracking in the session task
list (#1–#8, R1/R2/U1–U5/V1).

## Completed
- U1/F5 `77efbf0`: `.split-pane:has(.terminal-search)` drops the hover toolbar
  below the open search bar (they shared the top-right corner).
- U2/F3 `bb7a529`: `ui\src\settings\` (types/parse, live SettingsStore,
  SettingsDialog, useSettings), `ui\src\native\appFiles.ts` (read_app_file /
  write_app_file invoke wrappers), sidebar gear (reuses
  `sidebar-create__options` class), App renders dialog,
  `BootstrappedWorkspace.settings?` (optional so legacy fixtures pass; App
  falls back to in-memory store). Settings: newTabPolicy (5 values),
  shellIntegration, defaultProfile. Suite green + tsc clean at commit.

## In Progress
- **R1 agent `r1-host-integration`** (Opus): host OSC 9;9 prompt hooks —
  Profile.env, powershell -Command wrapper preserving $?, cmd PROMPT env,
  CreateSession `shell_integration` (serde default TRUE), real-spawn e2e
  tests. NO commits; main reviews. Contract = plan Task R1.
- **R2 agent `r2-tauri-commands`** (Opus): ui/src-tauri resolve_data_dir
  refactor + read_app_file/write_app_file (allowlist settings_v1.json /
  ui_state_v1.json, atomic tmp+rename) + list_dirs (completion backend,
  never-errors) + capabilities entries + tests. NO commits. Contract = plan
  Task R2. **Agents idle without reporting — SendMessage them to deliver to
  "main" if nothing heard.**
- U3 (main thread, task #5): scopePaths pure module, uiState persistence, OSC
  handler in TerminalSessionBinding (live vs replay: scope activePath moves
  ONLY on live reports), controller reportSessionCwd + policy createTab with
  cwd fallback chain (active → seed → null; host reject → next).

## Next Steps
1. Finish U3, then U4 (FolderSearch palette + entry points + recents MRU),
   U5 (inputMarks + Ctrl+Shift+J), each committed separately.
2. Review R1/R2 diffs line-by-line, run their suites independently, commit
   scoped with agent attribution.
3. V1: all gates (host cargo test ~105+, ui npm test 300+, tsc, build, e2e
   5) → rebuild via `npx tauri build --no-bundle` (NEVER bare cargo — see
   docs\RELEASE.md) → restage `C:\Dev\TermX\dist-portable\TermX\` → PrintWindow
   screenshot (no focus steal; Michael may be at the machine) → report with
   his smoke list.

## Key Files
- `C:\Dev\TermX\docs\superpowers\specs\2026-07-30-termx-cwd-settings-design.md` — spec (contracts!)
- `C:\Dev\TermX\docs\superpowers\plans\2026-07-30-cwd-settings-plan.md` — plan + R1/R2 agent contracts
- `C:\Dev\TermX\ui\src\settings\` — new settings subsystem
- `C:\Dev\TermX\ui\src\workspace\WorkspaceController.ts` — createTab policy lands here
- `C:\Dev\TermX\docs\RELEASE.md` — build procedure for V1

## Blockers / Notes
- Vitest 4: `--reporter=basic` is gone, use `--reporter=dot`. PostToolUse hook
  runs the full ui suite on every src write — treat its PASS/FAIL as the gate.
- Shell cwd in Bash tool drifts; use `git -C /c/Dev/TermX` for commits.
- Commit trailers required (Co-Authored-By Fable + Claude-Session URL of this
  session). Michael's standing bar: UI must feel great, not just good.
