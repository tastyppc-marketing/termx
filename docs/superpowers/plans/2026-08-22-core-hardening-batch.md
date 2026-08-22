# Core Hardening Batch — coordination plan (2026-08-22)

Owner directives (Michael, verbatim themes): shelve the chat feature ("we will
work on it, but we're going to put this to the very back"); make sure the other
functionalities work well; remove the frame border on right + bottom (left rail
+ top rail only); make the Hosts section collapsible; fix Saved resume ("doesn't
actually resume the chat, it just opens the directory"); name SSH tabs after the
host clicked; adversarial agents on each piece; design research feeding a
reusable "design template" preset (like color themes); shared-terminal +
teams/admin feature researched via one agent per prior-art product, then a
synthesis agent, then implementation agents.

## Decision record

- Chat: SURFACE REMOVED, modules stay dormant in-tree (Michael picked
  "Remove the surface"; "scrape" = shelve, not delete). Layouts A/B/C remain
  dead. Conversations→Resume stays (types `claude --resume` in the terminal).
- Frame: done on main (789a57f) — `.app-main` padding 0; single-pane
  `.terminal-host` borderless; split panes keep divider borders.
- Collab/teams: research fan-out now → synthesis → MICHAEL PICKS the
  architecture (VPS/auth/consent are his calls) → implementation lanes.
  Full-planning-required roadmap item; never one-shot.

## Implementation lanes (worktrees under .claude/worktrees, branched at 916faf7)

| Lane | Branch | Owns | Deliverable |
|---|---|---|---|
| lane-scrap | lane/scrap-chat | App.tsx, TerminalPane, chat tests | chat surface gone, panes pure terminal, resume path intact |
| lane-sidebar | lane/sidebar-batch | sidebar/**, connectSshHost, new uiState field | collapsible Hosts (persisted), SSH tab named after host alias |
| lane-saved | lane/saved-resume | saved/**, WorkspaceController resume paths, TerminalSessionBinding, conversations/resume.ts | root cause + fix: saved resume must resume the conversation |

Merge order: lane-scrap first (biggest App.tsx footprint), then lane-sidebar,
then lane-saved; conflicts resolved by me on main. Gates per merge: `npx tsc -b`
clean + full `npx vitest run` SOLO from ui/ (overlapping runs phantom-fail).
Node_modules are junctions to main's — SEVER with `cmd //c rmdir` before
`git worktree remove` (junction hazard, 2026-08 lesson).

## Verification fleet (read-only reviewers, running)

sweep-saved, sweep-ssh, sweep-core (incl. dead-pane pileup), sweep-convos,
sweep-settings (incl. dead-settings + hardcoded-color inventories + design-token
separation assessment). Findings → triage on main after lane merges.

## Research fleet (running)

- research-design → docs/superpowers/specs/2026-08-22-design-language-research.md
  (2-3 named design directions; Michael picks; winner becomes a structural
  "design template" preset beside color themes).
- research-collab → docs/superpowers/specs/2026-08-22-shared-sessions-research.md
  (TermX attach-point analysis + architecture candidates + phasing).
- Per-product studies → docs/superpowers/research/collab/<product>.md:
  study-warp, study-sshx, study-tmate (named agents) + workflow
  collab-prior-art-fanout (upterm, tty-share, zellij, wave, vscode-liveshare).
- SYNTHESIS agent deploys when all of the above land; its report + the one
  architecture decision go to Michael; implementation lanes follow his pick.

## Standing constraints

No dist-portable staging until lanes merge + gates pass. Never kill TermX/
termx-host without checking whose they are. Chat modules stay green while
 dormant. No Em-Dash in any external-facing copy the design work produces.
