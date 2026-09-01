# Batch 2: UI trio + Recall plugin — 2026-09-01

**Approved by Michael 2026-09-01** ("I do want us to go ahead and start making the changes… I would like to start working on those [plugin concepts] as well. Perhaps we could do it in parallel.")

**Gates (every commit):** non-incremental tsc (`npx tsc -p tsconfig.app.json --noEmit --incremental false`) + full `npx vitest run` from `ui\` (2020 at start), `cargo test` from `ui\src-tauri` (216) when Rust touched. All commits via scratchpad `gate-commit.sh`; agents report `git hash-object` lines and hard-stop. Stage via `build-stage.sh` (slot `.prev27`). Never touch Michael's live TermX (pid 12632) or `termx-host.exe`.

## Lane A — TermX UI trio (agent: impl-ui2)

Decisions locked by Michael:
- Rail-tab hover flyout delay ≈ 3 s ("hover over it for like three seconds") — single exported constant so it's tunable.
- Double-click the top-left window name to rename that window.
- Setting "Renaming a window also renames its rail tab" — **default OFF**. His reasoning: the window name can serve as a group label over 2–3 panes while the rail tab keeps its own identity.
- Status bar: the cwd StatusBar already shipped (src/statusbar/); remaining ask = make it actionable (click cwd → open that folder in Explorer).

- [ ] A1 — StatusBar: click the cwd → open the folder in Explorer (callback prop; wiring in App; StatusBar stays presentational). Tests.
- [ ] A2 — Rail hover flyout: hover a rail tab `HOVER_PANES_FLYOUT_MS` (3000) → flyout right of the rail listing that tab's panes with their display names; leaves cleanly; no interference with drag/context-menu/keyboard flows. New `src/sidebar/PaneFlyout.tsx` + css. Tests.
- [ ] A3 — Window rename: double-click the header name (top-left) → inline edit (Enter commits, Esc cancels honoring `data-esc-guard` ownership); per-window custom names persist across restarts; OS window title follows. New setting `syncWindowRenameToTab` (default **false**) in settings.ts + SettingsSurface; when ON a committed window rename also renames that window's active rail tab. Tests.
- [ ] A4 — Cross-model review (Grok + Codex whole-diff) → fixes → re-verify.
- [ ] A5 — Stage build at green HEAD via build-stage.sh (`.prev27`).

## Lane B — Recall plugin (agent: impl-recall) — NEW repo `C:\Users\mjfos\code\recall`

One search box over: (a) Showroom artifact index (`http://127.0.0.1:7345/api/artifacts?q=…&client=…`), (b) TermX conversation captures (`%APPDATA%\TermX\conversation_captures_v1.jsonl`). Results grouped by source; artifacts open in Explorer/default app; captures surface a copyable `claude --resume` line. Drafting-Table-sharp styling. Portable — zero hardcoded machine paths.

- [ ] B1 — Learn the plugin contract from `ui/src/plugins/*` + Showroom's manifest; scaffold repo (manifest, node server with /health, panel UI).
- [ ] B2 — Search: merged, debounced, graceful when Showroom is down or captures file absent.
- [ ] B3 — Open/copy actions + polish pass.
- [ ] B4 — Review lane (Grok) → fixes; register for Michael via Settings → Plugins (his click) or plugins_v1.json.
- [ ] B5 — Extract the **starter template** repo from Recall's structure (queued concept #4).

Then (sequential in lane B, after Recall lands): Client Cockpit, Design Guard.
