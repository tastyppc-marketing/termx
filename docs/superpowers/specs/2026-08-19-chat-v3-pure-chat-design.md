# Chat v3 — Pure Chat (design)

Date: 2026-08-19. Supersedes the UI half of `2026-08-19-chat-v2-auto-reveal-design.md`.

## §0 The rule this exists to enforce

Michael saw the v2 auto-reveal dock running and rejected it outright:
"completely unacceptable… Everything needs to live inside of the chat UI. I
don't want it to be displaying the terminal." **No terminal pixels are ever
drawn in chat mode.** Not a dock, not a split, not a reveal — layouts A, B,
and C are all dead. The full terminal remains reachable exactly one way: the
explicit Terminal toggle.

What the chat must still deliver (his standing requirement): Claude Code
parity — slash commands, interactive prompts, everything — rendered as
chat-native UI, with the real terminal doing the work invisibly underneath.

The v2 batch's plumbing is UI-agnostic and **stays unchanged**: resume boot
signal (`setResumeBootListener`, `bootReveal`), transcript-successor handoff
(`successorRecord`, `resumedEntries`, `rebindResumedTab`, one-shot bounded
adoption), sticky `ChatPaneLink`s, recycled-session-id purge, forced
post-resume rescans, `isIdleScreen`.

## §1 Removals (the dock dies)

- `ui/src/chat/revealController.ts` and its test file: **deleted**. Nothing
  else decides "show the terminal" because nothing shows the terminal.
- `TerminalPane.tsx`: `dockRevealed` state, the mode-reset effect, the
  focus-swap/scroll effect, the `--chat-dock` style, the
  `terminal-pane__dock` chrome element, and the `onRevealChange` wiring are
  removed. `bootReveal` stays on `PaneChatProps` and is passed through — the
  chat still needs the boot signal (§4). The chat-switch button stays where
  v2 moved it (bottom-right, terminal mode only).
- `TerminalPane.css`: `.terminal-pane__dock` / `__dock-caption` rules removed.
- `ChatView.tsx` / `ChatView.css`: the reveal chevron (`chat-reveal`,
  `chat-reveal--hide`), `RevealState` props (`reveal`, `onManualReveal`,
  `onManualHide`), and the `--chat-dock` inset var are removed (`.chat-view`
  returns to `inset: 0`). `ChatInput`'s `muted` prop dies with the dock — the
  chat box always owns the keyboard in chat mode.
- `idleDetector.ts` **stays** (the boot card and card lifecycles need it).
- `promptWatcher.ts` / `promptDetector.ts` / `PromptCard.tsx` stay and return
  to active duty (§3).

## §2 Slash commands — instant palette, self-healing from claude itself

Michael's requirements verbatim: mirror claude's real command list, but
"self-healing so we don't ever have to manually patch it" and "fast enough to
feel natural/native". The hybrid:

**UX (in `ChatInput`).** Typing `/` as the first character of an empty box no
longer forwards to the PTY. It opens a TermX-drawn palette (`SlashPalette`)
above the input row, instantly, from the cached command list. Further typing
filters locally (prefix + substring, name first). `↑`/`↓` move the selection,
`Enter` picks, `Esc` cancels, clicking a row picks. If the typed text
contains a space (`/rename my session`), the palette closes and the box is in
passthrough mode: `Enter` sends the whole line + `\r` to the PTY as one
command. Deleting back to an empty box cancels (as Esc).

**PTY choreography (in `ChatOverlay`).** The hidden claude is both the
executor and the teacher:
- On palette OPEN: `sendKeys("/")` — claude draws its own full command menu
  (that unfiltered menu is the best learning sample) — and start the learner.
- On PICK of `/name`: `sendKeys("name" + "\r")` — claude's box already holds
  the `/`; the completed name runs the command. Stop the learner.
- On CANCEL: `sendKeys("\x1b")` (Escape clears claude's menu and box). Stop
  the learner.
- Passthrough send (line with args): the palette was open, so claude already
  has `/`; send `text.slice(1) + "\r"`.

**The learner (`createSlashLearner`, in `slashCommands.ts`).** While started,
it samples `snapshot()` every `DETECT_INTERVAL_MS` and runs `parseSlashMenu`
over the visible lines. Rows matching claude's menu shape —
`/name  two-or-more-spaces  description` (name: `[\w][\w:-]*`, optional
args-hint tokens after the name are folded into the name column's display but
the NAME is the bare `/word`) — are collected; a parse with **fewer than 3
rows is discarded** (too little evidence; never learn from noise). Each
accepted parse is reported via `onLearned(commands)`.

**The cache.** `UiStateV1.slashCommands?: readonly SlashCommand[]` (parsed
defensively like every other uiState field; entries need a nonempty `/`-less
`name` and a string `description`). Merging is **upsert-by-name only — never
delete**: claude's menu is scrollable, so an absent row proves nothing.
`SEED_COMMANDS` ships a curated snapshot of claude's built-ins so the palette
is useful on first ever open; the first real learn overwrites descriptions
in place. `mergeCommands` returns the same reference when nothing changed so
an unchanged learn never schedules a uiState save.

This is the self-healing loop: every palette open re-teaches the cache from
the live claude, one use behind at worst, no manual patching. A parse failure
costs nothing — the palette still runs from the last-known-good cache.

## §3 Interactive prompts — cards, and the combined fallback card

`createPromptController`'s answer paths (`answerMenu`, `answerConfirm`,
`sendText`) are rewired to the REAL `sendKeys` (v2 made them a no-op;
`PromptCard` was left unmounted). `ChatView` mounts `PromptCard` above the
input row again, driven by the controller's state, exactly as pre-v2 —
answered cards collapse to the "Answered: …" chip.

**Known shapes** (`detectPrompt` kinds `menu` / `confirm`): rendered as
clickable option cards; clicking sends the arrow/enter or y/n keys via
`keysForMenuAnswer`. This covers the trust prompt, permission asks, and
`/model`-style menus.

**Unknown shapes** (kind `unknown`) become the **combined fallback card**
Michael asked for ("a best-effort text card… with the terminal button mixed
in") — one card containing all three:
1. the screen excerpt (`FALLBACK_LINES` tail) — and it must **live-update**
   while the card is showing: the watcher already re-detects on screen
   change (`samePrompt` compares raw tails), which replaces the card state;
2. inline controls: the free-text box (send + `\r`) PLUS a key row of four
   buttons — `↑` `↓` `Enter` `Esc` — sending `KEY_UP`/`KEY_DOWN`/
   `KEY_ENTER`/`"\x1b"` respectively, one keypress per click, so arrow-key
   menus are answerable without leaving chat;
3. an **Open Terminal** button (`onOpenTerminal` → `header.onFlipToTerminal`).

Suppression rule: while the slash palette is open, prompt detection is
paused (claude's own slash menu on screen would otherwise read as a prompt).
The controller keeps running; `ChatOverlay` simply gates card rendering and
answers on `paletteOpen`.

## §4 Resume boot — a status card, not a dock

`bootReveal` still arrives (same plumbing, same rising-edge semantics that v2
fixed). In pure chat it renders a pinned system-style card above the input:
"Resuming session — claude is starting…". It clears when ANY of:
- the screen goes idle (`isIdleScreen`) AND the transcript is quiet (the
  same `settled` predicate v2 used), polled at `AUTO_HIDE_POLL_MS`;
- a prompt card appears (the trust prompt takes over the story);
- 60 s elapse (never wedge a card on a hung boot).

The transcript handoff (v2 plumbing) swaps the feed to the successor file
underneath; the first reply lands as ordinary bubbles.

## §5 Contracts (frozen for the lanes)

```ts
// slashCommands.ts (new, lane B)
export interface SlashCommand { readonly name: string; readonly description: string }
export const SEED_COMMANDS: readonly SlashCommand[];
export function parseSlashMenu(visibleLines: string[]): SlashCommand[]; // [] = no accepted parse
export function mergeCommands(cache: readonly SlashCommand[], learned: readonly SlashCommand[]): readonly SlashCommand[]; // upsert by name; same ref when unchanged
export function filterCommands(commands: readonly SlashCommand[], query: string): SlashCommand[]; // query without the leading "/"
export function createSlashLearner(options: {
  snapshot(): string[];
  onLearned(commands: SlashCommand[]): void;
  schedule?: ScheduleFn;                    // from promptWatcher
}): { start(): void; stop(): void; dispose(): void };

// SlashPalette.tsx (new, lane B) — pure presentational
export interface SlashPaletteProps {
  commands: readonly SlashCommand[];        // already filtered
  selectedIndex: number;
  onPick(name: string): void;               // full "/name"
  onHover(index: number): void;
}
export function SlashPalette(props: SlashPaletteProps): JSX.Element;

// uiState.ts (lane B adds)
// UiStateV1.slashCommands?: readonly SlashCommand[]
export function setSlashCommands(state: UiStateV1, commands: readonly SlashCommand[]): UiStateV1; // same ref when unchanged

// ChatInput props AFTER lane A (replaces onSlash/muted)
export interface ChatInputProps {
  sendKeys(data: string): void;             // unchanged
  slashCommands: readonly SlashCommand[];
  onSlashOpen(): void;
  onSlashPick(name: string): void;          // "/name" picked from the palette
  onSlashCancel(): void;
  onSlashPassthrough(line: string): void;   // full "/cmd args" line, Enter pressed
}

// ChatOverlay props delta AFTER lane A (reveal props die)
//   - removed: onRevealChange
//   + slashCommands: readonly SlashCommand[]
//   + onCommandsLearned(commands: SlashCommand[]): void
//   (bootReveal stays)

// PaneChatProps delta AFTER lane C (mirror of the overlay's)
//   + slashCommands, + onCommandsLearned; bootReveal stays; nothing else changes
```

## §6 Focus

The chat box owns the keyboard in chat mode, always. No focus swapping, no
`document.activeElement` choreography beyond what existed pre-v2. Card
buttons and palette rows are ordinary clickable controls.

## §7 Verification

Unit: `slashCommands` (parser fixtures from a real claude menu capture, merge
upsert/no-delete/same-ref, filter ranking), `SlashPalette` render/pick,
learner start/stop/discard-small-parses; ChatInput palette state machine
(open/filter/pick/cancel/passthrough/backspace-to-empty); ChatOverlay
choreography (open sends "/", pick sends completion, cancel sends Esc,
palette suppresses prompt cards, boot card lifecycle); PromptCard fallback
(key-row buttons send the right sequences; live screen refresh); removal
regressions (no `--chat-dock`, no reveal chevron, `.chat-view` full-bleed).

Integration (`App.chatResume.test.tsx` continues to pass unchanged — the
plumbing is untouched).

Live CDP gate (staged build, isolated profile): resume a real conversation →
boot card visible → trust/permission prompt (if any) answerable as a card →
boot card clears → send a message from chat, reply arrives as bubbles →
type `/` → palette appears instantly → pick `/model` → model menu arrives as
a CARD, answer it with the card's controls → cache in uiState grew from the
learn → type `/rename gate-renamed` (passthrough) → verify claude ran it →
flip Terminal → back to Chat. At no point is any terminal row visible in
chat mode.
