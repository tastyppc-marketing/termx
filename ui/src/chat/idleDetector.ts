/**
 * Is claude quietly waiting? (chat v2 auto-reveal spec §2)
 *
 * The dock closes itself when the real terminal has nothing left to say, and
 * this is the half of that decision that reads the screen — the other half is
 * the transcript going quiet. It is a pure function over the same
 * `visibleLines()` snapshot the prompt detector reads: no timers, no memory.
 *
 * Idle means one exact thing: claude's own input box is on screen and EMPTY,
 * with nothing but its status footer under it. Everything else — a menu, a
 * question, a spinner, a half-typed line, a bare shell prompt — is not idle,
 * because closing the dock on any of those takes the user's UI away mid-answer.
 * No evidence is not idle either.
 */

/** How far back the tail is read. Claude's box + footer never exceed this. */
const TAIL_LINES = 15;

/**
 * Rows claude draws under the box; at most this many are skipped. The strip is
 * NOT matched by shape: its main line is the user's own configurable
 * statusline (model · folder · meters · anything), so any pattern written here
 * would be wrong on somebody's machine. Bounding the walk is what keeps the
 * skip honest — a screen whose empty box sits further from the bottom than a
 * footer ever could is not claude waiting.
 */
const FOOTER_LINES = 4;

/** The prompt glyphs claude draws in its input box. */
const EMPTY_PROMPT = /^[❯›>]$/;

/**
 * Screens that are the opposite of quiet, wherever in the tail they appear:
 * a numbered selector row and a confirm hint are a question; the interrupt
 * hint is work in flight. The input box can look empty under ALL of these,
 * which is exactly why they are checked separately.
 *
 * The ✻ glyph is deliberately NOT here: claude leaves a finished
 * "✻ Brewed for 2s"-style line on screen after every answer (the verb is
 * random), so a bare ✻ is evidence of PAST work. The live spinner always
 * carries "esc to interrupt", and that is the discriminator.
 */
const BUSY = [/^[❯›>]\s*\d+[.)]/, /Enter to confirm/i, /esc to interrupt/i];

/** Box-drawing chrome, matching the prompt detector's framing rules. */
const BOX_EDGE = /^[╭╰╞╡├┤┌└╔╚┏┗│┃║]+|[│┃║╮╯┐┘╗╝┓┛]+$/g;
const BOX_ONLY = /^[\s─━═╌╍│┃║╭╮╰╯┌┐└┘╔╗╚╝┏┓┗┛├┤┬┴┼]*$/;

/** A line with its frame removed; a line that is ONLY frame reads as blank. */
function strip(line: string): string {
  const bare = line.replace(/\r/g, "");
  if (BOX_ONLY.test(bare)) {
    return "";
  }
  return bare.replace(BOX_EDGE, "").trim();
}

/** The last `TAIL_LINES` rows that carry content, oldest first. */
function tail(lines: string[]): string[] {
  const kept: string[] = [];
  for (let index = lines.length - 1; index >= 0 && kept.length < TAIL_LINES; index -= 1) {
    const text = strip(lines[index] ?? "");
    if (text.length > 0) {
      kept.push(text);
    }
  }
  return kept.reverse();
}

export function isIdleScreen(lines: string[]): boolean {
  const rows = tail(lines);
  if (rows.length === 0) {
    return false;
  }
  if (rows.some((row) => BUSY.some((pattern) => pattern.test(row)))) {
    return false;
  }

  // Walk up past the status strip: the empty box must sit within a footer's
  // height of the bottom. No BUSY row exists anywhere in the tail (checked
  // above), so whatever is skipped here is status chrome, not a question.
  const bottom = rows.length - 1;
  for (let offset = 0; offset <= FOOTER_LINES; offset += 1) {
    const row = rows[bottom - offset];
    if (row !== undefined && EMPTY_PROMPT.test(row)) {
      return true;
    }
  }
  return false;
}
