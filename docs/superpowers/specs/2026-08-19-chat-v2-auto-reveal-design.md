# Chat v2 — Auto-Reveal (Layout B) Design

Approved by Michael 2026-08-19 after a guided visual tour of three layouts
(A live-dock / B auto-reveal / C split). Decision: **build B now, evolve into A
later** ("I like A the most, but let's go ahead and do B since that's the lower
risk option. Once we've got it down, we can start working on A"). C rejected.

## Problem (verbatim intent)

The current chat is "not workable":

1. **Resume doesn't resume.** "When I hit Resume Session … it'll open up the
   chat interface, but it's not actually resuming, like doing a `cd code` if it
   needs to, or resuming at all."
2. **No way back to chat.** "If I hit the terminal button to go to the
   terminal, there's no way for me to actually get back into the chat mode."
   (Root: the Chat toggle only renders while linkage re-derives successfully,
   and pane hover buttons sit on top of it.)
3. **Full Claude Code parity.** "I need to be able to have access to all the
   functions that I do in the terminal, the slash commands. … I essentially
   want to copy the UI that Claude Code has, except that it's going to be
   running the terminal in the background … everything should work exactly the
   same way."

## Decisions (user-confirmed)

- **Layout B — auto-reveal**: bubbles + a clean native input box; the pane's
  REAL claude terminal reveals as a green-framed bottom dock exactly when
  claude's own UI is needed. A is the follow-up; C is dead.
- **Auto-hide**: the dock hides itself once claude is back to quietly waiting
  at its empty input box; manual hide always available.
- **Resume lands in chat with the boot visible**: dock revealed from the start
  so cd → `claude --resume` → trust prompt → ready happens on screen, then
  auto-hides.
- **v1 scope: local claude panes.** Codex chat and SSH-pane chat are later
  batches (their transcripts are not locally tailable the same way). SSH and
  codex panes keep terminal-only, unchanged.
- **Prompt cards are retired.** Claude's real UI in the dock replaces them; the
  prompt DETECTOR survives as the dock's reveal trigger.

## §1 Architecture: the dock is the real terminal, clipped

The pane's terminal already stays mounted and attached underneath the chat
overlay (existing architecture — `TerminalPane` renders `ChatOverlay` over
`.terminal-pane__surface`). The dock is a **window onto the bottom rows of that
live xterm**, where claude draws its input box, slash menus, and question
prompts.

- The PTY is **never resized** by reveal/hide. The terminal keeps its full pane
  dimensions; the dock clips to its bottom slice (terminal absolutely
  positioned, bottom-aligned inside the dock viewport; xterm scrolled to
  bottom on reveal).
- Dock height: `0` hidden; revealed `min(45% of pane, content need)`, constant
  while revealed (no live resize thrash).
- The dock carries the green frame treatment from the mockups (Michael: "I like
  the green box … it just looks nice"): 1.5px `#3fb950` border, dark green
  fill behind the terminal slice, small uppercase caption ("live · claude"),
  soft outer glow.
- Everything interactive is claude's genuine UI — zero re-implementation, which
  is the entire point of B.

## §2 Reveal/hide state machine

One module owns this: `chat/revealController.ts` (new), pure + injectable
timers, unit-tested. States: `hidden` | `revealed(reason)` with
`reason ∈ slash | prompt | boot | manual`.

Reveal triggers:

- **slash** — the user types `/` as the FIRST character of the empty native
  input box. The `/` is forwarded raw to the PTY and the dock opens with
  claude's real command menu.
- **prompt** — the existing prompt detector (`chat/promptDetector.ts`, today
  feeding PromptCard) reports claude is asking. Trust prompts, pickers, plan
  approvals — anything.
- **boot** — the pane was just opened by a resume (rail, palette, or saved
  session). Dock starts revealed so the whole boot is visible.
- **manual** — a chevron control on the native input box.

Hide:

- **auto** — transcript quiet ≥ 2s (reuse `TRANSCRIPT_IDLE_MS`) AND the screen
  tail matches claude's idle state: an empty input line and no menu/question
  rows. The idle heuristic lives in `chat/idleDetector.ts` (new), separate and
  unit-tested, reading the same `visibleLines()` snapshot the prompt detector
  reads.
- **manual** — a "▾ hide" control on the dock frame. Manual hide while claude
  is mid-menu is allowed (the user can always flip to full terminal).
- A `manual` reveal only hides manually (the user asked for it; the idle
  detector doesn't get to close it).

## §3 Input routing

- **Dock hidden**: the native box behaves as today — Enter sends text then
  `\r` (bracketed paste for multiline), local per-pane history on ↑/↓.
- **`/` at position 0**: box empties, `/` goes to the PTY, dock reveals, focus
  moves INTO the xterm (its helper textarea). From here every keystroke —
  letters, arrows, Tab, Enter, Esc, Ctrl+C — is real claude interaction.
- **Dock revealed**: xterm has focus; the native box is visually muted.
- **On hide**: focus returns to the native box.
- The header's Esc / Ctrl+C buttons remain (they already send raw keys).

## §4 Resume actually resumes — two root causes fixed

**Root cause 1 — invisible boot blockers.** A resumed pane opening in chat mode
hides claude's trust prompt (and any boot-time picker) behind the bubbles; the
boot silently stalls and "nothing resumed." Fixed by definition via the boot
reveal (§2). `resumeSession`'s outcome gains the created ids
(`{kind:"opened", tabId, sessionId}`) so the App can start that pane revealed.

**Root cause 2 — stale transcript tail.** `claude --resume <id>` continues the
conversation in a **new transcript file** (new session id, same folder). The
chat kept tailing the OLD file, so nothing new ever appeared. Fix: **linkage
handoff** —

- `WorkspaceController` records, per resumed tab, the resumed key and a
  `resumedAtMs` stamp, and exposes them (`resumedEntries()`) plus
  `rebindResumedTab(oldKey, newKey)`.
- On conversations-store updates, the App checks each resumed tab: a record in
  the SAME normalized folder, with `updatedAtMs > resumedAtMs`, and a different
  id than the original, is the successor. The tab rebinds to it (explicit key
  update), and the open feed re-tails the new `filePath`. Newest-wins if
  several qualify; a successor is only ever adopted for a tab this controller
  resumed (no cross-pane guessing).

## §5 The chat toggle stops vanishing (sticky links)

- `uiState.chatPanes[sessionKey]` gains an optional persisted
  `link: {provider, id, filePath, title}`. Whenever live linkage resolves (or
  hands off per §4), the stored link updates; when live resolution FAILS but a
  stored link exists, the pane stays chat-capable using the stored link. The
  Chat button therefore never silently disappears from a pane that ever had a
  conversation.
- If the stored link's `filePath` no longer exists on disk, the chat shows its
  existing "transcript could not be read" state with the Terminal button — a
  visible dead-end beats a vanished button.
- Placement fix now (full declutter belongs to the window-chrome batch): the
  Chat toggle moves to the pane's bottom-right, out from under the ⚑/×/split
  hover cluster that was covering it.

## §6 What is removed / unchanged

- **Removed**: `PromptCard` usage in `ChatView` (component + its chat-input
  hint path). The detector (`promptDetector.ts` / `promptWatcher.ts`) is
  repurposed as the reveal trigger's eyes.
- **Unchanged**: bubbles/feed rendering, density modes, Thoughts toggle,
  transcript tailing (`chat/feed.ts`), the full Terminal flip (Ctrl+Shift+A and
  header button), `agentPaneDefaultView` setting semantics, terminal-only
  panes, SSH panes, codex panes.

## §7 Verification

- Unit: reveal state machine (every trigger × hide path, incl. manual-reveal
  never auto-hides), idle detector against captured claude screen tails (idle
  box, open menu, question, mid-stream), linkage successor rules (same-cwd,
  newer-only, resumed-tabs-only, newest-wins).
- Integration (App-level, jsdom): resume opens chat with dock revealed; typing
  `/` in the box forwards to PTY and reveals; successor record rebinds the feed
  (file path swap observed); Chat toggle survives a linkage dropout via stored
  link.
- Gates: `npx tsc -b` clean; full vitest solo; `cargo test -q -p termx-ui`
  (untouched, must stay green).
- Live CDP gate on the staged build: resume a real conversation from the rail →
  watch boot in the dock (trust prompt answered IN the dock) → dock auto-hides
  → send a message from the box and see the reply arrive as bubbles (proves
  handoff) → type `/model` → real menu in the dock → pick with arrows+Enter →
  dock auto-hides → flip to Terminal and back via the toggle.
