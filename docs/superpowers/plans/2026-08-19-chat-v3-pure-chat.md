# Chat v3 Pure Chat Implementation Plan

> **For agentic workers:** execute ONLY your own lane's tasks, in order, TDD
> per task. The cross-lane contracts in this file are FROZEN — implement them
> exactly; do not rename, do not "improve" a signature. If your lane needs to
> touch a file another lane owns, STOP and report instead.

**Goal:** chat mode renders zero terminal pixels — slash commands via an
instant self-healing palette, claude's prompts as interactive cards, resume
boots as a status card — with the real terminal executing invisibly.

**Spec:** `docs/superpowers/specs/2026-08-19-chat-v3-pure-chat-design.md`
(read it first; §5 holds the frozen contracts verbatim).

**Architecture:** three lanes. Lane A reworks the chat internals (cards
return, reveal UI dies, boot card, palette mounting). Lane B builds the slash
subsystem (command cache + parser + learner + palette component + uiState
field). Lane C (integrator, main thread) removes the dock from TerminalPane,
wires App, and gates.

**Tech stack:** React 19 + TypeScript strict (`exactOptionalPropertyTypes`),
vitest + jsdom, no new dependencies.

## Global constraints

- Baselines on main (ab1c8ad): `npx tsc -b` clean; `npx vitest run` =
  1334/1334 across 110 files (run SOLO — overlapping runs phantom-fail; a
  55s-timeout PostToolUse hook runs the suite after every write: ignore its
  timeouts, verify solo yourself).
- Rust untouched. No new npm packages. Existing code style: hairline borders,
  tokens-only CSS, comments explain constraints not narration.
- Never edit files outside your lane's ownership list.
- Ghost TS diagnostics naming `.claude/worktrees/*` paths are stale
  language-server artifacts — always ignore.

## File ownership

| Lane | Owns |
|------|------|
| A | `ui/src/chat/ChatOverlay.tsx`, `ChatView.tsx`, `ChatView.css`, `ChatInput.tsx`, `PromptCard.tsx`, `promptWatcher.ts` (only if a hook is missing), deletion of `revealController.ts`; tests under `ui/src/chat/__tests__/` for those files (incl. deleting `revealController.test.ts`) |
| B | NEW `ui/src/chat/slashCommands.ts`, NEW `ui/src/chat/SlashPalette.tsx`, NEW `ui/src/chat/SlashPalette.css`, `ui/src/workspace/uiState.ts` (add `slashCommands` + `setSlashCommands` only), tests for those |
| C | `ui/src/terminal/TerminalPane.tsx`, `TerminalPane.css`, `ui/src/App.tsx`, `ui/src/split/SplitLayout.tsx` (if needed), integration tests |

Lane A imports lane B's modules BY THE FROZEN NAMES without B's code existing
yet in its worktree — add a minimal local type-only declaration ONLY if the
build gate demands it, and delete it before reporting (expected: implement
against the contract; the merge supplies the real module; run your suite with
a tiny local stub of `slashCommands`/`SlashPalette` if needed and REPORT that
you did).

## Frozen contracts (copy of spec §5 — implement exactly)

```ts
// slashCommands.ts (lane B)
export interface SlashCommand { readonly name: string; readonly description: string }
export const SEED_COMMANDS: readonly SlashCommand[];
export function parseSlashMenu(visibleLines: string[]): SlashCommand[];
export function mergeCommands(cache: readonly SlashCommand[], learned: readonly SlashCommand[]): readonly SlashCommand[];
export function filterCommands(commands: readonly SlashCommand[], query: string): SlashCommand[];
export function createSlashLearner(options: {
  snapshot(): string[];
  onLearned(commands: SlashCommand[]): void;
  schedule?: ScheduleFn; // import type from ./promptWatcher
}): { start(): void; stop(): void; dispose(): void };

// SlashPalette.tsx (lane B)
export interface SlashPaletteProps {
  commands: readonly SlashCommand[]; // already filtered
  selectedIndex: number;
  onPick(name: string): void;        // full "/name"
  onHover(index: number): void;
}
export function SlashPalette(props: SlashPaletteProps): JSX.Element;

// uiState.ts (lane B)
// UiStateV1 gains: readonly slashCommands?: readonly SlashCommand[];
export function setSlashCommands(state: UiStateV1, commands: readonly SlashCommand[]): UiStateV1;

// ChatInput props AFTER lane A (onSlash and muted are REMOVED)
export interface ChatInputProps {
  sendKeys(data: string): void;
  slashCommands: readonly SlashCommand[];
  onSlashOpen(): void;
  onSlashPick(name: string): void;
  onSlashCancel(): void;
  onSlashPassthrough(line: string): void;
}

// ChatOverlay props AFTER lane A:
//   removed: onRevealChange
//   added:   slashCommands: readonly SlashCommand[]
//            onCommandsLearned(commands: SlashCommand[]): void
//   kept:    bootReveal?: boolean (rising-edge semantics preserved)

// PaneChatProps AFTER lane C: + slashCommands, + onCommandsLearned; bootReveal kept.
```

Key sequences (shared): `KEY_UP = "\x1b[A"`, `KEY_DOWN = "\x1b[B"`,
`KEY_ENTER = "\r"` (all already exported from `promptDetector.ts`),
`ESC = "\x1b"`.

---

## Lane A — chat internals (cards, boot card, palette mount, reveal removal)

### Task A1: strip the reveal UI

**Files:** `ChatView.tsx`, `ChatView.css`, `ChatOverlay.tsx`, delete
`revealController.ts` + `__tests__/revealController.test.ts`.

- [ ] Remove `reveal`, `onManualReveal`, `onManualHide`, `onSlash` props from
  `ChatView`; remove the chevron button and `chat-reveal*` CSS; `.chat-view`
  back to `inset: 0` (drop the `--chat-dock` var).
- [ ] `ChatOverlay`: delete the reveal-controller effect, `revealRef`,
  `bootRef`, the `noteBoot` rising-edge effect (replaced in A3), and the
  `onRevealChange` prop. Keep the prompt controller and the
  transcript-idle effect exactly as they are.
- [ ] Delete `revealController.ts` and its test file.
- [ ] Update `ChatOverlay.test.tsx` / `ChatView.test.tsx`: reveal cases die;
  keep and adapt everything else. Suite green, tsc green, commit.

### Task A2: prompt cards return, with the combined fallback card

**Files:** `ChatOverlay.tsx`, `ChatView.tsx`, `PromptCard.tsx`,
`__tests__/PromptCard.test.tsx` (recreate), `__tests__/ChatOverlay.test.tsx`.

- [ ] `ChatOverlay`: the prompt controller's `sendKeys` becomes the REAL
  `sendKeys` again; `onChange` publishes `controller.state()` into React
  state; pass the state + answer callbacks down to `ChatView`, which mounts
  `PromptCard` above the input row (pre-v2 wiring — see git history
  `d5990b7:ui/src/chat/ChatView.tsx` for the exact former shape).
- [ ] `PromptCard` unknown-kind card gains the key row: four buttons `↑` `↓`
  `Enter` `Esc` sending `KEY_UP`/`KEY_DOWN`/`KEY_ENTER`/`"\x1b"` via a new
  `onSendKey(data: string): void` prop (one keypress per click). Keep the
  screen excerpt, free-text box, and the Open Terminal link. Style: existing
  `chat-card__*` classes; the key row reuses `chat-card__option` buttons.
- [ ] Tests: menu card answers via clicks; confirm card; unknown card's key
  row sends exactly one sequence per click; screen excerpt updates when the
  watcher re-detects (drive the schedule fake); answered chip renders.
- [ ] Suppression: `ChatOverlay` gates prompt-card RENDERING and answering on
  `paletteOpen` (A3) — controller keeps running underneath. Test it. Commit.

### Task A3: palette mount + choreography + boot card

**Files:** `ChatInput.tsx`, `ChatOverlay.tsx`, `ChatView.tsx`, tests.

- [ ] `ChatInput` implements the frozen props: local palette state (open,
  query, selectedIndex), renders `SlashPalette` (lane B's component) with
  `filterCommands(slashCommands, query)`; keyboard per spec §2 (open on "/"
  in empty box — the character is NOT forwarded; filter locally; ↑↓/Enter/
  Esc; space → passthrough mode; Enter in passthrough calls
  `onSlashPassthrough(fullLine)` and clears; backspace to empty = cancel).
  `muted` prop removed.
- [ ] `ChatOverlay` choreography: `onSlashOpen` → `sendKeys(SLASH)` + start a
  `createSlashLearner` (snapshot = the existing snapshotRef, onLearned →
  props.onCommandsLearned); `onSlashPick("/name")` → `sendKeys("name" +
  KEY_ENTER)`, stop learner; `onSlashCancel` → `sendKeys("\x1b")`, stop
  learner; `onSlashPassthrough("/cmd args")` → `sendKeys("cmd args" +
  KEY_ENTER)`, stop learner. Learner disposed on unmount.
- [ ] Boot card: `bootReveal` rising edge (mount OR later prop change) sets a
  `booting` state rendering a pinned system card ("Resuming session — claude
  is starting…", class `chat-card chat-card--boot`, testid `boot-card`).
  Cleared by: settled (isIdleScreen(snapshot) && transcript idle, polled at
  `AUTO_HIDE_POLL_MS` — define the constant locally now that
  revealController is gone), OR a prompt appearing, OR 60 s. Tests for all
  three exits and for the late rising edge.
- [ ] Full chat suite green solo, tsc green, commit.

## Lane B — slash subsystem

### Task B1: `slashCommands.ts`

- [ ] `SEED_COMMANDS`: curated claude built-ins (name + one-line description):
  add-dir agents bashes bug clear compact config context cost doctor exit
  export help hooks ide init install-github-app login logout mcp memory
  migrate-installer model output-style permissions pr-comments resume
  release-notes rename review rewind sandbox settings statusline status
  terminal-setup todos upgrade vim. Descriptions ≤60 chars, factual.
- [ ] `parseSlashMenu`: rows shaped `^\s*/([A-Za-z][\w:-]*)(?:\s+\S[^\s].*?)?\s{2,}(\S.*)$`
  — capture bare name + description; ALSO accept the two-column form claude
  draws with the name column padded. Reject a parse with <3 rows (return
  `[]`). Strip box-drawing edges first (reuse the approach in
  `idleDetector.ts` — copy the two regexes locally; do NOT import them).
- [ ] `mergeCommands`: upsert by name, never delete, preserve cache order for
  existing entries, append new ones alphabetically; return the SAME reference
  when nothing changed (field-wise compare).
- [ ] `filterCommands("mo")`: name-prefix matches first (alphabetical), then
  name-substring, then description-substring; empty query = full list.
- [ ] `createSlashLearner`: schedule-driven sampling every 300 ms (import
  `DETECT_INTERVAL_MS` type/value from `./promptWatcher`); on each accepted
  parse call `onLearned`; `start` idempotent; `stop` cancels; `dispose`
  permanent. TDD each; fixture = a verbatim claude v2.1.235 slash menu screen
  (transcribe one, box chrome included). Commit per green step.

### Task B2: `SlashPalette.tsx` + CSS

- [ ] Pure list: rows show `/name` + description, `selectedIndex` row gets
  `aria-current="true"`, click = `onPick("/" + name)`, mouseenter =
  `onHover(index)`. Max-height ~40% with `overflow-y:auto`; keep the selected
  row scrolled into view (`scrollIntoView({block:"nearest"})` in an effect).
  Tokens-only CSS (`--surface-*`, `--border`, `--accent-*`, radius var),
  positioned by the PARENT (`position:absolute; bottom:100%` inside
  `.chat-input-row` which is already the anchor) — document that in the CSS.
- [ ] Tests: render/order, pick, hover, empty list renders "No matching
  commands". Commit.

### Task B3: uiState field

- [ ] `UiStateV1.slashCommands?: readonly SlashCommand[]`; parser accepts
  only `{name: nonempty string, description: string}` entries (drop others,
  drop the field if empty); `setSlashCommands` same-ref when unchanged
  (field-wise). Extend `uiState.test.ts` with parse/set/no-change cases.
  Suite + tsc green, commit.

## Lane C — integration (main thread; after A+B merge)

- Remove the dock from `TerminalPane.tsx`/`.css` (spec §1 list), keep
  `bootReveal` pass-through, extend `PaneChatProps` with `slashCommands` +
  `onCommandsLearned`.
- `App.tsx`: `chatForSession` supplies `slashCommands:
  uiSnapshot.slashCommands ?? SEED_COMMANDS` and `onCommandsLearned` writing
  `setSlashCommands(mergeCommands(current.slashCommands ?? SEED_COMMANDS,
  learned))`.
- Integration tests: `App.chatResume.test.tsx` unchanged-green; new
  assertions that chat props carry `slashCommands`.
- Full gates (tsc, vitest solo, cargo 194 untouched), adversarial review,
  build, stage, live CDP gate per spec §7.

## Self-review notes

- `onSlashPassthrough` slice: ChatInput passes the FULL line including the
  leading `/`; ChatOverlay strips exactly one leading `/` before sending
  (claude's box already holds the typed `/`).
- The palette-open learning sample happens while the USER sees our palette —
  claude's menu is never on screen in chat mode because the terminal is never
  on screen. The learner reads `snapshot()` (the buffer), not pixels.
- Lane A's A3 depends on lane B's names only at import/type level; both lanes
  run in parallel worktrees and merge cleanly because the contracts are
  frozen.
