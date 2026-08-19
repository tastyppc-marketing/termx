/**
 * Idle-screen detection (chat v2 auto-reveal spec §2).
 *
 * PROVENANCE. The shapes below are transcriptions of Claude Code's TUI with the
 * fullscreen renderer OFF — the mode this app drives — taken from the same
 * published layouts the `fixtures/prompts/*.txt` files came from: the rounded
 * input box, the status footer under it, the permission menu, and the working
 * spinner that sits ABOVE the box while an answer is being written.
 *
 * The bias is deliberate: being wrong about "idle" closes the dock while claude
 * is still asking something, so anything unrecognised reads as NOT idle.
 */

import { describe, expect, it } from "vitest";
import { isIdleScreen } from "../idleDetector";

/** Claude waiting at an empty box, with its status footer under it. */
const IDLE_WITH_FOOTER = [
  "● Applied the change to ChatView.tsx.",
  "",
  "╭──────────────────────────────────────────────────────────────╮",
  "│ >                                                            │",
  "╰──────────────────────────────────────────────────────────────╯",
  "  ⏵⏵ auto-accept edits on (shift+tab to cycle)",
];

/** The same screen with no footer drawn yet. */
const IDLE_BARE = [
  "● Done.",
  "",
  "╭──────────────────────────────────────────────────────────────╮",
  "│ ❯                                                            │",
  "╰──────────────────────────────────────────────────────────────╯",
];

/** The slash menu claude opens under the box once "/" is typed. */
const SLASH_MENU = [
  "╭──────────────────────────────────────────────────────────────╮",
  "│ > /mo                                                        │",
  "╰──────────────────────────────────────────────────────────────╯",
  "  /model      Set the AI model for this session",
  "  /monitor    Watch the current run",
];

/** A permission question, selector on the first option. */
const TRUST_QUESTION = [
  " Do you trust the files in this folder?",
  "",
  " C:\\Dev\\TermX",
  "",
  " ❯ 1. Yes, proceed",
  "   2. No, exit",
  "",
  " Enter to confirm · Esc to exit",
];

/** Mid-work: the spinner sits above an input box that still looks empty. */
const WORKING = [
  "● Reading ChatOverlay.tsx",
  "",
  "✻ Working… (12s · esc to interrupt)",
  "",
  "╭──────────────────────────────────────────────────────────────╮",
  "│ >                                                            │",
  "╰──────────────────────────────────────────────────────────────╯",
];

/** The user is mid-sentence in claude's own box. */
const TYPED_INTO_BOX = [
  "╭──────────────────────────────────────────────────────────────╮",
  "│ > fix the reveal controller                                  │",
  "╰──────────────────────────────────────────────────────────────╯",
  "  ⏵⏵ auto-accept edits on (shift+tab to cycle)",
];

/**
 * Captured verbatim from a live TermX pane (2026-08-19 CDP gate): claude
 * v2.1.235 idle after a resume, with a USER-CONFIGURED statusline under the
 * box. The statusline can say anything, so idle detection must not depend on
 * recognising it — this exact screen once read as "not idle" and pinned the
 * dock open forever.
 */
const IDLE_LIVE_STATUSLINE = [
  "❯ Reply with exactly TERMX-CHATV2-GATE-9K1 and nothing else.",
  "● TERMX-CHATV2-GATE-9K1",
  // A FINISHED spinner line: claude leaves this on screen after every answer
  // (the verb is random — Brewed, Crunched, …). It must not read as busy.
  "✻ Brewed for 2s",
  "                                                                    71834 tokens",
  "─────────────────────────────────────────────────────────────────────────────────",
  "❯  ",
  "─────────────────────────────────────────────────────────────────────────────────",
  "  Opus 5 (1M context) · 1M · high | chatv2-gate | 🧠 7.2% (72k) | ⏳ 5h 14% · 7d 33% | $0.72 | ⏱️ -… ───",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
  "                                                                              /rc",
];

describe("isIdleScreen", () => {
  it("reads an empty prompt box as idle, footer or not", () => {
    expect(isIdleScreen(IDLE_WITH_FOOTER)).toBe(true);
    expect(isIdleScreen(IDLE_BARE)).toBe(true);
  });

  it("reads the live claude chrome — custom statusline included — as idle", () => {
    expect(isIdleScreen(IDLE_LIVE_STATUSLINE)).toBe(true);
  });

  it("is still not idle when text sits in the box above that same statusline", () => {
    const typed = IDLE_LIVE_STATUSLINE.map((row) =>
      row === "❯  " ? "❯ fix the reveal controller" : row,
    );
    expect(isIdleScreen(typed)).toBe(false);
  });

  it("treats box-drawing separators as chrome, not content", () => {
    expect(
      isIdleScreen([
        "● Done.",
        "────────────────────────────────",
        "│ >                            │",
        "────────────────────────────────",
      ]),
    ).toBe(true);
  });

  it("is not idle while a slash menu is open", () => {
    expect(isIdleScreen(SLASH_MENU)).toBe(false);
  });

  it("is not idle while a question is waiting", () => {
    expect(isIdleScreen(TRUST_QUESTION)).toBe(false);
  });

  it("is not idle while the spinner is running above the box", () => {
    expect(isIdleScreen(WORKING)).toBe(false);
  });

  it("is not idle while the user is typing in the box", () => {
    expect(isIdleScreen(TYPED_INTO_BOX)).toBe(false);
  });

  it("is not idle without evidence — no screen is not a quiet screen", () => {
    expect(isIdleScreen([])).toBe(false);
    expect(isIdleScreen(["", "   ", ""])).toBe(false);
  });

  it("is not idle at a plain shell prompt: the boot has not reached claude yet", () => {
    expect(isIdleScreen(["PS C:\\Dev\\TermX> cd code", "PS C:\\Dev\\code>"])).toBe(false);
  });

  it("looks only at the tail, so a finished run's spinner cannot keep it awake", () => {
    const scrolledAway = [
      "✻ Working… (2s · esc to interrupt)",
      ...Array.from({ length: 20 }, (_, index) => `  updated file ${index}`),
    ];
    expect(
      isIdleScreen([
        ...scrolledAway,
        "╭──────────────────────────────╮",
        "│ >                            │",
        "╰──────────────────────────────╯",
      ]),
    ).toBe(true);
  });
});
