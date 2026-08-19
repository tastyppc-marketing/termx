/**
 * The prompt controller, driven directly.
 *
 * These assertions used to run through the prompt CARD; the card is retired
 * (chat v2 spec §6) and claude's real UI answers questions in the dock now, so
 * the controller is tested where it lives. Its detection half is what tells
 * the reveal controller to open that dock, which is why it still matters.
 */

import { describe, expect, it } from "vitest";
import { ENTER_DELAY_MS } from "../ChatInput";
import {
  createPromptController,
  DETECT_INTERVAL_MS,
  PROMPT_RETRY_MS,
  type ScheduleFn,
} from "../promptWatcher";
import permissionBash from "./fixtures/prompts/permission-bash.txt?raw";

/** A hand-driven clock so every detection tick is a deliberate step. */
function testScheduler() {
  const pending = new Map<number, { at: number; run: () => void }>();
  let nextId = 1;
  let now = 0;
  const schedule: ScheduleFn = (callback, delayMs) => {
    const id = nextId++;
    pending.set(id, { at: now + delayMs, run: callback });
    return () => {
      pending.delete(id);
    };
  };
  return {
    schedule,
    get pendingCount() {
      return pending.size;
    },
    advance(delayMs: number) {
      now += delayMs;
      for (const [id, timer] of [...pending]) {
        if (timer.at <= now) {
          pending.delete(id);
          timer.run();
        }
      }
    },
  };
}

const PROMPT_SCREEN = permissionBash.split("\n");
const QUIET_SCREEN = ["$ npm run build", "building…"];

function build(options: { idle?: boolean } = {}) {
  const clock = testScheduler();
  const sent: string[] = [];
  const changes: number[] = [];
  let screen = QUIET_SCREEN;
  const idle = options.idle ?? true;
  const controller = createPromptController({
    snapshot: () => screen,
    isIdle: () => idle,
    sendKeys: (data) => sent.push(data),
    onChange: () => changes.push(changes.length),
    schedule: clock.schedule,
  });
  return {
    controller,
    clock,
    sent,
    changes,
    setScreen(lines: string[]) {
      screen = lines;
    },
    /** Two ticks: one to sample, one to confirm the screen settled. */
    settle() {
      clock.advance(DETECT_INTERVAL_MS);
      clock.advance(DETECT_INTERVAL_MS);
    },
  };
}

describe("createPromptController", () => {
  it("says nothing while the screen is ordinary output", () => {
    const harness = build();
    harness.settle();
    expect(harness.controller.state().prompt).toBeNull();
    expect(harness.sent).toEqual([]);
  });

  it("reports a menu once the screen settles on one, and sends nothing by itself", () => {
    const harness = build();
    harness.setScreen(PROMPT_SCREEN);
    harness.settle();

    const prompt = harness.controller.state().prompt;
    expect(prompt?.kind).toBe("menu");
    expect(prompt?.kind === "menu" && prompt.question).toBe("Do you want to proceed?");
    expect(harness.changes).toHaveLength(1);
    expect(harness.sent).toEqual([]);
  });

  it("stays quiet while the transcript is still producing entries", () => {
    const harness = build({ idle: false });
    harness.setScreen(PROMPT_SCREEN);
    harness.settle();
    expect(harness.controller.state().prompt).toBeNull();
  });

  it("drops the prompt once the screen moves on", () => {
    const harness = build();
    harness.setScreen(PROMPT_SCREEN);
    harness.settle();
    harness.setScreen(QUIET_SCREEN);
    harness.settle();
    expect(harness.controller.state().prompt).toBeNull();
  });

  it("sends exactly the keystrokes for the option chosen, Enter as its own write", () => {
    const harness = build();
    harness.setScreen(PROMPT_SCREEN);
    harness.settle();

    harness.controller.answerMenu(2);
    // One chunk with a trailing \r reads as a paste on the far side and never
    // submits, so the Enter follows a beat later.
    expect(harness.sent).toEqual(["\x1b[B\x1b[B"]);
    harness.clock.advance(ENTER_DELAY_MS);
    expect(harness.sent).toEqual(["\x1b[B\x1b[B", "\r"]);

    harness.setScreen(QUIET_SCREEN);
    harness.clock.advance(PROMPT_RETRY_MS);
    expect(harness.controller.state()).toMatchObject({
      prompt: null,
      status: "answered",
      answeredLabel: "No, and tell Claude what to do differently (esc)",
    });
    expect(harness.sent).toHaveLength(2);
  });

  it("retries once against the screen as it stands, then degrades", () => {
    const harness = build();
    harness.setScreen(PROMPT_SCREEN);
    harness.settle();

    // "Yes" is already selected: the answer is a bare Enter, delayed.
    harness.controller.answerMenu(0);
    harness.clock.advance(ENTER_DELAY_MS);
    expect(harness.sent).toEqual(["\r"]);

    // Nothing moved: one re-derived retry.
    harness.clock.advance(PROMPT_RETRY_MS);
    harness.clock.advance(ENTER_DELAY_MS);
    expect(harness.sent).toEqual(["\r", "\r"]);
    expect(harness.controller.state().prompt?.kind).toBe("menu");

    // Still nothing: it gives up rather than argue with a button.
    harness.clock.advance(PROMPT_RETRY_MS);
    expect(harness.sent).toHaveLength(2);
    expect(harness.controller.state().prompt?.kind).toBe("unknown");
  });

  it("answers a y/N confirm with the key it showed", () => {
    const harness = build();
    harness.setScreen(["Removing 3 stale worktrees.", "Continue? (y/N)"]);
    harness.settle();
    expect(harness.controller.state().prompt?.kind).toBe("confirm");

    harness.controller.answerConfirm(true);
    expect(harness.sent).toEqual(["y"]);
    harness.clock.advance(ENTER_DELAY_MS);
    expect(harness.sent).toEqual(["y", "\r"]);
  });

  it("sends free text only when asked, and nothing for an empty string", () => {
    const harness = build();
    harness.setScreen(["Restoring the workspace…", "Enter the profile name to use:"]);
    harness.settle();
    expect(harness.controller.state().prompt?.kind).toBe("unknown");

    harness.controller.sendText("");
    expect(harness.sent).toEqual([]);

    harness.controller.sendText("default");
    expect(harness.sent).toEqual(["default"]);
    harness.clock.advance(ENTER_DELAY_MS);
    expect(harness.sent).toEqual(["default", "\r"]);
  });

  it("drops the prompt on dismiss without sending anything", () => {
    const harness = build();
    harness.setScreen(PROMPT_SCREEN);
    harness.settle();
    harness.controller.dismiss();
    expect(harness.controller.state().prompt).toBeNull();
    expect(harness.sent).toEqual([]);
  });

  it("stops watching once disposed", () => {
    const harness = build();
    harness.settle();
    expect(harness.clock.pendingCount).toBeGreaterThan(0);
    harness.controller.dispose();
    harness.clock.advance(DETECT_INTERVAL_MS * 3);
    expect(harness.clock.pendingCount).toBe(0);
  });
});
