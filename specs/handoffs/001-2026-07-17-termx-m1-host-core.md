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
- **M1 COMPLETE** (all 12 plan tasks; checklist below all verified). Final full-suite run + merge of `feat/m1-host-core` to main happening at session end — confirm `git log main` shows the M1 commits if resuming.

## Next Steps
1. Write M2 plan (Tauri UI shell: window, xterm.js wired to host WS, sidebar sessions panel, tabs+colors+groups, persistence via SetLayout/GetState) against the REAL host interfaces in `host/src/protocol.rs`.
2. **Before M2 build**: MSVC toolchain — needs Michael's UAC approve (see Blockers), then `rustup default stable-x86_64-pc-windows-msvc`.
3. M2 profile discovery: extend `host/src/profiles.rs` (Git Bash registry probe, pwsh PATH probe, `wsl -l -q` distros) per spec §3.
4. (done 2026-07-17) harness-lab queue-inbox proposal re: hook PATH guard.

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
  {"feature": "M1-T7 session.rs ConPTY spawn/io/kill", "passes": true,
   "verified": "2026-07-17 4 passed in 0.42s after slave-lifetime + ESC[6n DSR responder fixes"},
  {"feature": "M1-T8 registry.rs", "passes": true,
   "verified": "2026-07-17 5 passed in 0.20s"},
  {"feature": "M1-T9 server.rs WS auth/dispatch/attach", "passes": true,
   "verified": "2026-07-17 3 passed in 0.13s"},
  {"feature": "M1-T10 kill-UI-survive", "passes": true,
   "verified": "2026-07-17 session_survives_client_death_and_replays ok; full lib 33 passed in 3.74s"},
  {"feature": "M1-T11 main.rs lifecycle", "passes": true,
   "verified": "2026-07-17 e2e spawns real exe, runtime.json written, clean Shutdown exit 0"},
  {"feature": "M1-T12 e2e real exe", "passes": true,
   "verified": "2026-07-17 full_lifecycle_against_real_binary ok in 5.70s"}
]
```
