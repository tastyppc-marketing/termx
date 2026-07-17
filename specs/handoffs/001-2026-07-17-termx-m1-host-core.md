# Session Handoff - 2026-07-17

## Context
Building TermX (`C:\Dev\TermX`) — a stable Warp-like terminal manager for Windows. Approved design spec + milestone-based build; currently executing Milestone 1 (Rust session-host daemon) via the M1 plan. This is a MULTI-SESSION mission — Feature Checklist + Init Check below.

## Completed
- Global CLAUDE.md: new "Portability (all projects)" section (no hardcoded absolute paths in code) — `C:\Users\mjfos\.claude\CLAUDE.md`
- Approved design spec: `C:\Dev\TermX\docs\superpowers\specs\2026-07-17-termx-design.md` (v1: colored tabs in collapsible sidebar groups, top "search sessions and files" bar, scoped folder tree + native Open Folder dialog + context menu incl. "Attach as context", OSC-133 blocks, Ctrl+F search, clickable links/paths, split panes w/ per-pane strip + Alt-resize, palette/history/snippets; stability architecture = disposable Tauri UI + crash-surviving Rust host)
- Backlog captured: `C:\Dev\TermX\BACKLOG.md` (terminal-to-terminal messaging, /forkit, LLM context sharing)
- M1 plan: `C:\Dev\TermX\docs\superpowers\plans\2026-07-17-m1-host-core.md` (12 TDD tasks)
- Toolchain: Rust 1.97.1 via rustup; **windows-gnu** target + portable MinGW at `C:\Users\mjfos\tools\mingw64` (on user PATH) because VS Build Tools winget install failed twice (UAC 1602, Michael away). See memory `rust-toolchain-windows-gnu`.
- M1 tasks 1-6 done & committed on branch `feat/m1-host-core`: scaffold, paths.rs, config.rs, ring.rs, protocol.rs, profiles.rs — 20 unit tests green.
- session.rs written; **root-caused + fixed a real bug**: portable-pty children died with 0xC0000142 because `drop(pair.slave)` right after spawn closes handles during child init (wezterm/wezterm#4674). Fix: waiter thread owns slave, drops after child.wait().

## In Progress
- Background run `bwtaze0ci`: `cargo test -p termx-host --lib session -- --test-threads=1` → `/tmp/session-tests.out` (verifying the slave-lifetime fix). If green → commit "feat(host): ConPTY session with ring scrollback + broadcast output".

## Next Steps
1. Confirm session tests green; commit Task 7.
2. Plan tasks 8-12 in order: registry.rs → server.rs → survival test → main.rs → e2e + README (full code in the plan doc; follow TDD cycles).
3. After M1: finishing-a-development-branch skill (merge feat/m1-host-core), then write M2 plan (Tauri UI shell) — needs MSVC, see Blockers.
4. Propose harness fix in `C:\Users\mjfos\code\harness-lab\queue-inbox.md`: hooks calling cargo need a PATH guard (`~/.cargo/bin` + `~/tools/mingw64/bin`).

## Key Files
- `C:\Dev\TermX\docs\superpowers\specs\2026-07-17-termx-design.md` - approved v1 design
- `C:\Dev\TermX\docs\superpowers\plans\2026-07-17-m1-host-core.md` - executable M1 plan (checkboxes)
- `C:\Dev\TermX\host\src\*.rs` - host crate (paths/config/ring/protocol/profiles done; session fixed; registry/server stubs)
- `C:\Dev\TermX\BACKLOG.md` - deferred features Michael explicitly wants later

## Blockers / Notes
- **MSVC missing**: winget VS Build Tools needs Michael to approve UAC. Command: `winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`. After install: `rustup default stable-x86_64-pc-windows-msvc` + full rebuild. Required before M2 (Tauri).
- Session-scoped env needed in every Bash call this session: `export PATH="$HOME/tools/mingw64/bin:$HOME/.cargo/bin:$PATH"` (hooks/other shells started pre-PATH-change will not see cargo — their failures are environmental noise).
- MinGW test-binary links are SLOW (~3-6 min); always run cargo with output redirected to a file (ConPTY children can inherit pipe handles and wedge pipelines), background + generous timeout.
- Windows build 26200.8875 — the ConPTY slave-drop bug bites here; do not "simplify" the slave-lifetime code in session.rs.

## Init Check
`export PATH="$HOME/tools/mingw64/bin:$HOME/.cargo/bin:$PATH" && cd /c/Dev/TermX && cargo test -p termx-host --lib` — all unit tests must pass before new work.

## Feature Checklist
```json
[
  {"feature": "M1-T1..T6 scaffold+paths+config+ring+protocol+profiles", "passes": true,
   "verified": "2026-07-17 cargo test --lib: 20 passed (3+3+5+5+4) before session.rs"},
  {"feature": "M1-T7 session.rs ConPTY spawn/io/kill", "passes": false,
   "verify": "cargo test -p termx-host --lib session -- --test-threads=1 -> 4 passed"},
  {"feature": "M1-T8 registry.rs", "passes": false,
   "verify": "cargo test -p termx-host --lib registry -> 5 passed"},
  {"feature": "M1-T9 server.rs WS auth/dispatch/attach", "passes": false,
   "verify": "cargo test -p termx-host --lib server -> 3 passed"},
  {"feature": "M1-T10 kill-UI-survive", "passes": false,
   "verify": "cargo test -p termx-host session_survives -> 1 passed"},
  {"feature": "M1-T11 main.rs lifecycle", "passes": false,
   "verify": "cargo build + manual boot writes runtime.json"},
  {"feature": "M1-T12 e2e real exe", "passes": false,
   "verify": "cargo test -p termx-host --test e2e -> 1 passed"}
]
```
