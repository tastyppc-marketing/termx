/**
 * Prompt detection (chat-view spec §5).
 *
 * The transcript never records a TUI prompt — a permission dialog, an
 * AskUserQuestion menu, a plan approval — because the agent draws it on the
 * screen and waits. The pane's live xterm buffer, however, holds exactly what
 * was drawn, so this module classifies that screen into something the chat can
 * render as an answerable card.
 *
 * It is a pure function over lines and nothing else: no timers, no buffer, no
 * knowledge of when output stopped. The caller supplies the stall signal by
 * choosing when to ask. And it NEVER answers anything — it only describes.
 */

export interface PromptOption {
  label: string;
  /** Position in the menu, zero-based. */
  index: number;
}

export type DetectedPrompt =
  | {
      kind: "menu";
      question: string;
      options: PromptOption[];
      selectedIndex: number;
      raw: string[];
    }
  | { kind: "confirm"; question: string; raw: string[] }
  | { kind: "unknown"; raw: string[] };

/** The fallback card shows this much of the screen, verbatim (spec §5). */
export const FALLBACK_LINES = 12;

/** Arrow keys and Enter — what a selector menu understands. */
export const KEY_DOWN = "\x1b[B";
export const KEY_UP = "\x1b[A";
export const KEY_ENTER = "\r";

/** The selector glyphs Claude Code and friends draw. */
const SELECTORS = ["❯", "›", ">"];

/** `1. Yes` / `2) No`, with or without a leading selector. */
const NUMBERED = /^(\d+)[.)]\s+(.*\S)\s*$/;

/** A y/N-style question, whichever bracket style. */
const YES_NO = /\((y(?:es)?)\s*\/\s*(n(?:o)?)\)|\[(y(?:es)?)\s*\/\s*(n(?:o)?)\]/i;

/** A line that asks for something typed rather than chosen. */
const ASKS_FOR_INPUT = /\b(enter|type|choose|select|input|provide|name|path|password|continue|proceed)\b/i;

/** A shell's own prompt is not a question, however much it looks like one. */
const SHELL_PROMPT = /^(?:PS\s+)?(?:[A-Za-z]:[\\/].*|~.*|\/.*)?[$#>❯]\s*$/;

/**
 * Dialogs draw key-hint rows UNDER their options — the live /model picker
 * ends in "● High effort (default) ←/→ to adjust" and "Enter to set as
 * default · s to use this session only · Esc to cancel". At most this many
 * are stepped over before the option run. Only rows that TALK ABOUT KEYS are
 * skipped: an unnumbered menu's own trailing options (which are unselected
 * and unmarked too) must not be eaten.
 */
const FOOTER_SKIP = 3;
const FOOTER_HINT = /[·↑↓←→]|\b(esc|enter|tab|space|shift\+\w|ctrl\+\w)\b/i;

/** Box-drawing chrome the dialogs are wrapped in. */
const BOX_EDGE = /^[╭╰╞╡├┤┌└╔╚┏┗│┃║]+|[│┃║╮╯┐┘╗╝┓┛]+$/g;
const BOX_ONLY = /^[\s─━═╌╍│┃║╭╮╰╯┌┐└┘╔╗╚╝┏┓┗┛├┤┬┴┼]*$/;

/**
 * Strip the frame from a line, leaving what was written inside it. A line that
 * is nothing BUT frame — a dialog's top or bottom border — reads as blank, so
 * it separates a menu from whatever is drawn around it instead of joining it.
 */
function clean(line: string): string {
  const bare = line.replace(/\r/g, "");
  if (BOX_ONLY.test(bare)) {
    return "";
  }
  return bare.replace(BOX_EDGE, "").trim();
}

interface Row {
  /** The line with its frame removed. */
  text: string;
  /** Whether the line carried a selector glyph before its content. */
  selected: boolean;
}

function toRow(line: string): Row {
  const text = clean(line);
  const selector = SELECTORS.find((glyph) => text.startsWith(glyph));
  if (selector === undefined) {
    return { text, selected: false };
  }
  return { text: text.slice(selector.length).trim(), selected: true };
}

/**
 * The option list at the tail of the screen, or null when there is not one.
 *
 * Options are read bottom-up so that only the LAST menu on screen is answered
 * — a scrollback holding three earlier dialogs must not resurrect any of them.
 * The run is numbered (`1.`, `2.`) or selector-marked, never a mix of neither.
 */
function readOptions(rows: Row[]): { options: PromptOption[]; selectedIndex: number; top: number } | null {
  let end = rows.length - 1;
  while (end >= 0 && rows[end]?.text.length === 0) {
    end -= 1;
  }
  if (end < 0) {
    return null;
  }

  // Step over a dialog's key-hint footer to reach the options above it.
  let skipped = 0;
  while (end >= 0 && skipped < FOOTER_SKIP) {
    const row = rows[end];
    if (!row || row.text.length === 0) {
      return null; // hints with nothing above them are not a menu
    }
    if (NUMBERED.test(row.text) || row.selected || !FOOTER_HINT.test(row.text)) {
      break; // the run — or ordinary prose — starts here
    }
    end -= 1;
    skipped += 1;
  }

  const labels: string[] = [];
  const selectedFlags: boolean[] = [];
  let numbered: boolean | null = null;
  let index = end;
  for (; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) {
      break;
    }
    if (row.text.length === 0) {
      // A blank line inside a menu ends it; Claude never splits its options.
      break;
    }
    const match = NUMBERED.exec(row.text);
    const isNumbered = match !== null;
    // The last row on screen decides the run's shape; a numbered list and an
    // unnumbered one are never the same menu.
    if (numbered === null) {
      numbered = isNumbered;
    } else if (numbered !== isNumbered) {
      break;
    }
    // An unnumbered row only belongs to a menu if a selector marks the block
    // it sits in — otherwise it is prose, and prose is not a menu.
    if (!isNumbered && !row.selected && !hasSelectorAbove(rows, index)) {
      break;
    }
    labels.push(isNumbered ? (match?.[2] ?? "") : row.text);
    selectedFlags.push(row.selected);
  }

  labels.reverse();
  selectedFlags.reverse();
  if (labels.length < 2) {
    return null;
  }
  const selectedIndex = selectedFlags.indexOf(true);
  if (selectedIndex === -1 && numbered !== true) {
    return null; // an unnumbered list with no selector is prose
  }
  return {
    options: labels.map((label, position) => ({ label, index: position })),
    selectedIndex: selectedIndex === -1 ? 0 : selectedIndex,
    top: index + 1,
  };
}

/** Whether a selector-marked row sits within the contiguous block above. */
function hasSelectorAbove(rows: Row[], from: number): boolean {
  for (let index = from - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || row.text.length === 0) {
      return false;
    }
    if (row.selected) {
      return true;
    }
  }
  return false;
}

/** The question above an option run: the nearest line that reads like one. */
function readQuestion(rows: Row[], top: number): string {
  let fallback = "";
  for (let index = top - 1; index >= 0; index -= 1) {
    const text = rows[index]?.text ?? "";
    if (text.length === 0) {
      continue;
    }
    if (text.endsWith("?")) {
      return text;
    }
    if (fallback.length === 0) {
      fallback = text;
    }
  }
  return fallback;
}

/** The last `FALLBACK_LINES` non-empty lines, framing removed. */
function tailLines(lines: string[]): string[] {
  const kept: string[] = [];
  for (let index = lines.length - 1; index >= 0 && kept.length < FALLBACK_LINES; index -= 1) {
    const text = clean(lines[index] ?? "");
    if (text.length === 0) {
      continue;
    }
    kept.push(text);
  }
  return kept.reverse();
}

/**
 * Classify a screen. `null` means ordinary output — the caller shows no card.
 *
 * `unknown` is deliberately the last resort: the screen ends in something that
 * reads like a request (a question mark, a y/N token, a bare selector, or a
 * short line asking for a value) that no pattern above could parse. The caller
 * only asks once output has stalled, which is what keeps a mid-stream log line
 * from raising a card.
 */
export function detectPrompt(visibleLines: string[]): DetectedPrompt | null {
  const rows = visibleLines.map(toRow);
  const raw = tailLines(visibleLines);
  if (raw.length === 0) {
    return null;
  }

  const menu = readOptions(rows);
  if (menu) {
    return {
      kind: "menu",
      question: readQuestion(rows, menu.top),
      options: menu.options,
      selectedIndex: menu.selectedIndex,
      raw,
    };
  }

  const last = raw[raw.length - 1] ?? "";
  if (YES_NO.test(last)) {
    return { kind: "confirm", question: last, raw };
  }

  if (SHELL_PROMPT.test(last)) {
    return null;
  }
  const interactive =
    last.endsWith("?") ||
    SELECTORS.some((glyph) => last.endsWith(glyph)) ||
    (last.endsWith(":") && last.length <= 80 && ASKS_FOR_INPUT.test(last));
  return interactive ? { kind: "unknown", raw } : null;
}

/**
 * The keystrokes that move a menu's selector to `targetIndex` and confirm it.
 * Arrows rather than the digit shortcut: every menu shape supports them,
 * including the ones drawn without numbers.
 */
export function keysForMenuAnswer(
  prompt: { selectedIndex: number },
  targetIndex: number,
): string {
  const delta = targetIndex - prompt.selectedIndex;
  const key = delta > 0 ? KEY_DOWN : KEY_UP;
  return key.repeat(Math.abs(delta)) + KEY_ENTER;
}
