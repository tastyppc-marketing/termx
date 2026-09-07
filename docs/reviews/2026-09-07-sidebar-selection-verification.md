# Sidebar selection verification — 2026-09-07

## Scope

Shift-click ranges and Ctrl/Command-click toggles in the terminal sidebar,
with visible highlights independent of the currently open terminal. Selection
uses visible tree order, preserves an anchor for successive ranges, and is
local to this UI. Ctrl+Shift adds a range; plain click/Enter opens one tab.
Shift+Up/Down and Ctrl/Command+Space provide keyboard access.

## Automated checks

- Added 15 component regression cases; initial checks failed for the missing behavior.
- All 10 sidebar test files pass: 168 tests, including existing drag, rename,
  close, color, preview, resize, and nested-group coverage.
- Full UI suite passes: 153 files, 2,412 tests.
- TypeScript application check passes.
- `git diff --check` passes.

Coverage includes upward/downward ranges, shrinking/growing a range, disjoint
toggles, additive ranges, external activation, ordinary workspace refreshes,
hidden/removed anchors, editor and close-button interaction, keyboard access,
and group/tab drag gestures whose trailing click never reaches its old row.

## Browser verification

Ran the actual Sidebar component and production styles in a temporary Vite
preview with a controlled workspace; no live terminal host was involved.
Verified with browser input and accessibility state:

- Shift-click selected five rows across an expanded group while keeping the
  original terminal open.
- Ctrl-click removed an intermediate row and added a disjoint row.
- Plain click switched the open terminal and reset selection.
- Shift+Down twice selected a keyboard range; Ctrl+Space removed its last row.
- Screenshots confirmed selection tint, preserved palette stripes, and the
  open-terminal marker in gunmetal-brass and paper-light themes.

The browser automation timed out during an extra drag gesture; Escape
cancelled it. Drag-followed-by-selection and collapsed/removed row cases are
covered by component tests rather than a completed browser drag check.
The temporary preview files were removed after verification. Native desktop
automation was unavailable, so this does not claim a fresh packaged-app UI smoke test.

## Independent review

A read-only reviewer identified stale post-drag click suppression, missing
multi-select semantics on nested tablists, and missing keyboard access. Added
regressions and corrected all three. The follow-up review found no remaining
actionable issues.

## Release

Build the portable UI through `npx.cmd tauri build --no-bundle`, as required by
`docs/RELEASE.md`. Stage `TermX.exe` and `termx-ui.exe` with matching hashes and
dated backups. This feature requires reopening the UI; it makes no host changes.
The original GitHub backup branch remains `backup/pre-stability-2026-09-04`.
