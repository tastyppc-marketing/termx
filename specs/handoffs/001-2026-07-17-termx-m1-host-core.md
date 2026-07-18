# Session Handoff - 2026-07-17

## DELTA 2026-07-18 (same session, post-M1 quality loop) — READ THIS FIRST AFTER COMPACTION

Michael's latest instruction: **"Go end to end please, lint, find bugs, fix, repeat until done."** Loop = lint → multi-agent bug hunt → fix → test → repeat until dry. Ultracode is ON (use Workflow tool for review rounds).

(Refreshed at the ~365k compact-guard line; everything below is current as of that moment. Repo is clean and committed — nothing half-applied. The ONLY in-flight work is the round-2 Workflow; when its task notification arrives, pick up at NEXT STEPS item 1.)

State right now:
- M1 was completed + merged to `main` (34/34 tests). Then quality loop started ON MAIN (no feature branch — direct commits, Michael's standing "go").
- Lint round 1: clippy `-D warnings` CLEAN; `cargo fmt` applied + committed ("style: cargo fmt across host crate").
- Bug-hunt round 1 (Workflow `wf_3b6afa2d-d85`, 109 agents): **32 confirmed findings** (2 critical, 15 major, 15 minor) — full list in `C:\Users\mjfos\AppData\Local\Temp\claude\C--Dev\7e673402-8c77-471b-bbda-fa825fd7a42e\scratchpad\confirmed-findings.json`. Criticals: (1) SessionExited never emitted; (2) one accept() error killed the daemon.
- **Fix pass COMMITTED to main as `525f628`** ("fix(host): resolve 32 confirmed review findings from adversarial bug hunt"). Verified green first: clippy `-D warnings` clean, `cargo fmt --check` clean, 60 lib tests + 1 e2e all pass. Rewrote: session.rs (exit watch via tokio watch channel; waiter drops slave→master→input-sender then fires watch; DSR strip-and-answer via strip_dsr(); bounded sync_channel(256) input; taskkill /T tree-kill; +11 new tests), server.rs (forward_session() with exit select + drain + SessionExited + registry.persist_logged(); accept-loop survives errors; 10s handshake timeout; auth ignores non-text frames; lag-resync advances replay_end; abort-old-forwarder-first on re-attach; errors surfaced for input/resize/close-unknown; +10 new tests), registry.rs (persist lock + pid-unique tmp; persist_logged; id seeding from state.json max; update_dims; corrupt-state warn; +4 tests), config.rs (0-scrollback clamp + test), paths.rs (choose_data_dir pure fn + portable.flag tests), main.rs (real startup error propagation).
- **Bug-hunt ROUND 2 IN FLIGHT**: fresh Workflow run `wf_c3d1b117-ea9` (task `w66qndfvb`), same 6-lens script, launched after the 525f628 commit. Transcript dir: `C:\Users\mjfos\.claude\projects\C--Dev\7e673402-8c77-471b-bbda-fa825fd7a42e\subagents\workflows\wf_c3d1b117-ea9`.
- Accepted-not-fixed (documented in code comments — round-2 findings that re-flag these are NOT new work): start-start TOCTOU single-instance race (M1, single user); exited-but-unclosed sessions keep ring until CloseSession (deliberate: M2 shows last output of dead shells).

NEXT STEPS (in order):
1. Read round-2 workflow results (task `w66qndfvb` / run `wf_c3d1b117-ea9`). Filter out the two accepted-as-designed items. If confirmed findings remain → fix → verify (clippy + full suite, file-redirect rule) → commit → launch round 3 (fresh run again). Loop is DONE when a round yields zero confirmed non-accepted findings.
2. Report to Michael: findings fixed, rounds run, final state. Remind: MSVC UAC still pending for M2.

Gotchas that survive compaction: every Bash needs `export PATH="$HOME/tools/mingw64/bin:$HOME/.cargo/bin:$PATH"`; cargo runs → background + file redirect (pipes wedge via ConPTY handle inheritance); real-check/task-gate hooks fail on cargo/pytest — environmental, state it and move on; MinGW links take 3-6 min.

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
