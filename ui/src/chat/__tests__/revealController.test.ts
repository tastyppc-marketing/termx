import { describe, expect, it } from "vitest";
import {
  AUTO_HIDE_POLL_MS,
  createRevealController,
  type RevealState,
} from "../revealController";
import type { ScheduleFn } from "../promptWatcher";

/** A hand-driven clock so every poll is a deliberate step. */
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

/** Claude waiting at an empty box — what auto-hide is allowed to close on. */
const QUIET_SCREEN = [
  "● Done.",
  "╭──────────────────────────────╮",
  "│ >                            │",
  "╰──────────────────────────────╯",
];

/** A question on screen — auto-hide must never close on this. */
const ASKING_SCREEN = [" ❯ 1. Yes, proceed", "   2. No, exit"];

interface Harness {
  clock: ReturnType<typeof testScheduler>;
  changes: RevealState[];
  setScreen(lines: string[]): void;
  setTranscriptIdle(idle: boolean): void;
}

function build(initial?: { boot?: boolean }) {
  const clock = testScheduler();
  const changes: RevealState[] = [];
  let screen = QUIET_SCREEN;
  let transcriptIdle = true;
  const controller = createRevealController(
    {
      snapshot: () => screen,
      isTranscriptIdle: () => transcriptIdle,
      onChange: (state) => changes.push(state),
      schedule: clock.schedule,
    },
    initial,
  );
  const harness: Harness = {
    clock,
    changes,
    setScreen(lines) {
      screen = lines;
    },
    setTranscriptIdle(idle) {
      transcriptIdle = idle;
    },
  };
  return { controller, ...harness };
}

describe("createRevealController", () => {
  it("starts hidden and says nothing", () => {
    const { controller, changes } = build();
    expect(controller.state()).toEqual({ revealed: false, reason: null });
    expect(changes).toEqual([]);
  });

  it("starts revealed for a boot, and reports it", () => {
    const { controller, changes } = build({ boot: true });
    expect(controller.state()).toEqual({ revealed: true, reason: "boot" });
    expect(changes).toEqual([{ revealed: true, reason: "boot" }]);
  });

  it("reveals for a typed slash and for a detected prompt", () => {
    const slash = build();
    slash.controller.userTypedSlash();
    expect(slash.controller.state()).toEqual({ revealed: true, reason: "slash" });

    const prompt = build();
    prompt.controller.notePromptDetected();
    expect(prompt.controller.state()).toEqual({ revealed: true, reason: "prompt" });
  });

  it("keeps the FIRST cause: a second trigger changes nothing", () => {
    const { controller, changes } = build();
    controller.userTypedSlash();
    controller.notePromptDetected();
    controller.userTypedSlash();
    expect(controller.state()).toEqual({ revealed: true, reason: "slash" });
    expect(changes).toHaveLength(1);
  });

  it("toggles both ways by hand", () => {
    const { controller, changes } = build();
    controller.manualToggle();
    expect(controller.state()).toEqual({ revealed: true, reason: "manual" });
    controller.manualToggle();
    expect(controller.state()).toEqual({ revealed: false, reason: null });
    expect(changes).toEqual([
      { revealed: true, reason: "manual" },
      { revealed: false, reason: null },
    ]);
  });

  it("hides on demand from any reason, and stays quiet when already hidden", () => {
    const { controller, changes } = build({ boot: true });
    controller.manualHide();
    expect(controller.state()).toEqual({ revealed: false, reason: null });
    controller.manualHide();
    expect(changes).toHaveLength(2);
  });

  it("auto-hides only once BOTH the transcript and the screen are quiet", () => {
    const harness = build();
    harness.controller.notePromptDetected();

    // Screen still asking: the poll must leave it open.
    harness.setScreen(ASKING_SCREEN);
    harness.clock.advance(AUTO_HIDE_POLL_MS * 4);
    expect(harness.controller.state().revealed).toBe(true);

    // Screen quiet but the transcript is still writing: still open.
    harness.setScreen(QUIET_SCREEN);
    harness.setTranscriptIdle(false);
    harness.clock.advance(AUTO_HIDE_POLL_MS * 4);
    expect(harness.controller.state().revealed).toBe(true);

    harness.setTranscriptIdle(true);
    harness.clock.advance(AUTO_HIDE_POLL_MS);
    expect(harness.controller.state()).toEqual({ revealed: false, reason: null });
    expect(harness.changes).toEqual([
      { revealed: true, reason: "prompt" },
      { revealed: false, reason: null },
    ]);
  });

  it("never auto-hides a reveal the user asked for", () => {
    const harness = build();
    harness.controller.manualToggle();
    harness.clock.advance(AUTO_HIDE_POLL_MS * 10);
    expect(harness.controller.state()).toEqual({ revealed: true, reason: "manual" });
    // Nothing is even scheduled: a manual dock has no clock to fight.
    expect(harness.clock.pendingCount).toBe(0);
  });

  it("auto-hides a boot reveal once the boot settles", () => {
    const harness = build({ boot: true });
    harness.clock.advance(AUTO_HIDE_POLL_MS);
    expect(harness.controller.state()).toEqual({ revealed: false, reason: null });
  });

  it("reveals for a LATE boot signal, with the same auto-hide as an initial one", () => {
    // A real resume announces its boot only after the resume command is typed
    // — after the controller was built. The late signal must behave exactly
    // like `initial.boot`: reveal as "boot", then settle away.
    const harness = build();
    harness.setScreen(ASKING_SCREEN);
    harness.controller.noteBoot();
    expect(harness.controller.state()).toEqual({ revealed: true, reason: "boot" });

    harness.clock.advance(AUTO_HIDE_POLL_MS);
    expect(harness.controller.state().revealed).toBe(true); // still booting

    harness.setScreen(QUIET_SCREEN);
    harness.clock.advance(AUTO_HIDE_POLL_MS);
    expect(harness.controller.state()).toEqual({ revealed: false, reason: null });
  });

  it("stops polling once hidden, and again once disposed", () => {
    const harness = build();
    harness.controller.userTypedSlash();
    expect(harness.clock.pendingCount).toBe(1);

    harness.controller.manualHide();
    harness.clock.advance(AUTO_HIDE_POLL_MS * 3);
    expect(harness.clock.pendingCount).toBe(0);

    harness.controller.userTypedSlash();
    harness.controller.dispose();
    harness.clock.advance(AUTO_HIDE_POLL_MS * 3);
    expect(harness.clock.pendingCount).toBe(0);
    expect(harness.controller.state().revealed).toBe(true);
  });
});
