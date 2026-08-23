# Adversarial sweep triage (2026-08-22)

Five read-only reviewers swept the subsystems Michael asked to be assured of:
saved/resume, SSH, workspace core, conversations, settings/theme/sidebar.
Findings below are ranked ACROSS subsystems by user impact. Every item carries
the reviewer's confidence as reported (CONFIRMED = code paths read end to end
and agreeing, often with an executed probe; PLAUSIBLE = needs a runtime check).

## P0 — breaks a promise the UI makes to the user

### 1. Saved resume is only HALF fixed — reattach never verifies the agent
`ui/src/workspace/WorkspaceController.ts:882-903`. CONFIRMED (sweep-saved #1).
`resumeSaved` short-circuits to "reattach" whenever `entry.lastDaemonSessionId`
names a session that is still `alive`. It verifies nothing else: not whether
claude is still running in that shell, not whether the shell is still in
`entry.cwd`, not even whether the entry HAS a conversation. Every pane save
pins a session id (`App.tsx:975`), the daemon outlives the app
(`host/src/registry.rs:82-124`), and there is no force-fresh escape hatch —
`resumeSaved` takes no `{force}` and the saved row offers only
rename/describe/delete. So: save a pane running claude, quit claude (or just
work in the shell), click the saved row → TermX focuses that tab, types
nothing, says nothing. **This reproduces "it just opens the directory" with a
perfectly clean conversations store**, independent of the duplicate-record bug
the lane fixed. The tests pin the defect rather than the intent
(`resumeSaved.test.ts:211-225` asserts `writes === []` for an entry that
carries a conversation) — they must be rewritten, not extended.
**Michael's own saved row is in exactly this state**: `saved_sessions_v1.json`
holds one row (`mjfos`, `C:\Users\mjfos`, `lastDaemonSessionId: 68`, no
`conversation`), and session 68 is still alive. He must delete and re-pin it.

### 2. `sshPasswordPolicy: "never"` does not stop stored passwords being used
`bootstrapWorkspace.ts:298`, `WorkspaceController.ts:1752-1765`. CONFIRMED
(sweep-ssh #1). The settings screen says verbatim "No password is ever stored
or used; any already saved is ignored." `storedSshPassword` never consults
settings; only the key button is gated (`App.tsx:902`). The existing test
asserts only that the button hides, pinning the incomplete half of the
contract.

### 3. A daemon restart produces undismissable zombie panes — this IS the pileup
`WorkspaceController.ts:376,416-418`. CONFIRMED with an executed probe
(sweep-core S1/S2). The controller's session map is seeded once and never
resynced; only `AttachmentHub` learns the truth on reconnect and it never
tells the controller. After a daemon restart panes render as live with no
reconnecting chip while their input is dead, and then: Dismiss no-ops
(filters on `alive !== true`), Restart refuses ("This terminal is still
running."), Close fails (new daemon rejects the id). The tab cannot be removed
by ANY affordance until relaunch, where it returns as a persisted corpse —
`reconcile` already computes `deadSessionIds` and `bootstrapWorkspace.ts:319`
throws the list away. Michael's `state.json`: `next_id: 71`, two live
sessions, tabs still pointing at sessions 25 and 26. **Verdict: defect, not
design.** (Design is correct only for the single `exit` case.)

### 4. One-click SSH connect is broken under the `cmd` profile
`ssh/bootstrap.ts:127-135`. CONFIRMED experimentally (sweep-ssh #2). The POSIX
one-liner is single-quoted; cmd.exe does not treat `'` as a quote, so `|` and
`>` execute. Result: no connection, a local `base64` invocation, and a stray
file literally named `$tmp` dropped in the cwd. No notice; the pane is still
registered as an SSH pane.

### 5. A failed connect leaves the password watcher armed over the local shell
`WorkspaceController.ts:1148-1155,1770-1830`. CONFIRMED path / PLAUSIBLE
trigger (sweep-ssh #3). The watcher retires early only on a rooted-Unix cwd
report — i.e. only when the remote bootstrap actually ran. On DNS failure,
auth failure, a remote without bash, or #4 above, it stays armed 60 s over the
**local, echoing** shell. Any output ending `password…:` (a manual
`ssh othervps`, a `git push` over HTTPS) gets the stored password typed and
echoed — and `host/src/history.rs` spills pty bytes verbatim to disk, so it
persists in plaintext.

## P1 — the feature works but lies, or degrades badly at Michael's scale

6. **Claude's real titles are never read.** `llm_sessions/claude.rs:125` looks
   for `type == "summary"`, which current Claude Code no longer writes (0 of
   1,339 files). Meanwhile 161 files carry `ai-title` and 33 carry
   `custom-title` (a name the USER typed). Consequence: all 1,275 titles are
   120-char prompt fragments (69% sit exactly at the cap), slash-command
   invocations become titles, and the note scheduler burned ~1,268 `claude -p`
   subprocesses reinventing names already on disk. CONFIRMED (sweep-convos #1).
7. **The transcript viewer silently drops 21% of assistant turns.**
   `viewer/transcript/transcriptModel.ts:172-186` handles no `thinking` block,
   so thinking-only lines parse to nothing and vanish with no placeholder
   (1,583 of 7,422 renderable assistant lines across the 5 largest real
   transcripts). `image` blocks and 346 `system` lines also vanish. CONFIRMED.
8. **Save records the pane's wandering cwd, not the conversation's project
   dir.** `App.tsx:946,968`. A pane resumed in `C:\Dev\TermX` that later
   `cd ui` saves cwd `...\ui` while still labelling "Resumes: <title>"; the
   restore types `claude --resume` in the wrong directory. A test pins the
   wrong side of this (`App.savedSessions.test.tsx:325-343`). CONFIRMED path.
9. **68% of listed conversations cannot be resumed** (905 of 1,339 cwds no
   longer exist) with no staleness affordance until after the click; a forced
   rescan re-reads 249 MB and runs twice after every resume. CONFIRMED.
10. **Viewer controls are invisible on Paper Light** — `Viewer.css:217`
    hardcodes `#dfe2e8` on a near-white surface: **1.06:1**. The error variant
    is 1.29:1, so the message explaining a failed history load is invisible
    too. CONFIRMED by computation with the project's own contrast math.
11. **Light-theme text ladder collapses and inverts** —
    `deriveTokens.ts:37-39` clamps three independent blends to the same 4.5:1
    floor, so on paper-light `--text-hint` (4.55:1) outranks `--text-sub`
    (4.50:1) and they are visually identical. `deriveTokens.test.ts:140`
    tolerates it with a `+0.05` window. CONFIRMED.
12. **`Include` is not parsed in ssh config**, so whole host sets silently
    vanish behind an empty state that says "you have no hosts". CONFIRMED.
13. **A pane stays an "SSH pane" after ssh exits** — saves can be pinned
    remote with a Windows cwd, and resuming types `cd 'C:\...'` on the VPS.
    CONFIRMED. Same for SSH saves reattaching to the local launcher shell.
14. **Drag-then-click is swallowed; Escape-cancelled drag still activates.**
    `Sidebar.tsx:479,386`. Both CONFIRMED by executed probe. Reads as
    flakiness, the worst kind of bug to report.
15. **Layout changes made while the host is down are lost forever** —
    `LayoutPersistence.ts:89-115` retries twice, both burn instantly while
    disconnected, and nothing re-drives on reconnect. `dispose()` also discards
    a pending write and the close path never flushes. CONFIRMED by probe.

## P2 — cleanup, correctness-adjacent, cheap

16. Right-clicking a Saved session or Host opens the background sidebar menu
    (no `onContextMenu` on those rows) — CONFIRMED by probe.
17. Dead settings: `agentPaneDefaultView` and `chatDefaultDensity` now have
    zero readers (chat scrap) yet render a full radio ladder under Settings →
    "Chat View". Dead uiState: `chatPanes` (24 stale entries for sessions
    29-66), `slashCommands` (42 cached) — zero readers outside `uiState.ts`,
    and the GC that would have pruned them could never fire (ids never
    recycle) and was deleted with the surface anyway.
18. 30 hardcoded colour declarations across `ConnectionBanner.css` (12),
    `TerminalPane.css` (8), `Viewer.css` (5) violate the single-source rule
    stated in `styles.css:7`, which has never had any enforcement.
19. No in-flight guard on any resume entry point; the saved list re-sorts on
    `touchDaemonSession`, so a double-click can resume whichever row slid into
    place. CONFIRMED by reading.
20. Compaction recaps harvested from 7 of 78 sessions (256 KB head/tail window
    misses mid-file blocks); detection uses an English prose prefix while a
    locale-proof `isCompactSummary` flag sits unused.
21. Stale comments asserting the daemon renumbers session ids from 1 after a
    restart (`WorkspaceController.ts:482-484`) — `registry.rs` keeps a
    monotonic watermark precisely so it does not.

## Design-token separation (for the Direction B preset work)

Colour is a real system (3 source colours → 20 tokens, single style write,
WCAG gate before render). Structure is ~one-fifth of one. Measured at HEAD:
radii 97 tokenised / 15 hard zeros; row heights fully tokenised; **spacing 0
tokenised against ~390 literals; typography 0 against ~250 literals; borders 0
against 153 `1px solid`; motion 0 against 24 transitions.** The two layers do
already live in separate blocks and `applyTheme` touches only colour, so they
compose without conflict — the structural half is simply unpopulated. Cheapest
pilot for the whole mechanism: `--sidebar-indent`, which is already read twice
with a fallback and set by nothing.

## Recommended fix order

**Batch 1 (correctness, user-visible):** 1, 2, 3, 4, 5 — plus rewriting the
tests that pin defects 1 and 2. These are the five that make the app do
something other than what it says.
**Batch 2 (Michael-scale truth):** 6, 7, 8, 9 — titles, viewer completeness,
save cwd, dead-session noise.
**Batch 3 (design template):** 18 first (it is prerequisite #1 in the design
research), then 10, 11, then the spacing/type/stroke token scales that
Direction B needs.
**Anytime:** 14, 16, 17, 21 — small, self-contained, low risk.
