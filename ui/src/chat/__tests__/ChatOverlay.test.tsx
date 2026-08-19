import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatOverlay } from "../ChatOverlay";
import type { ChatFeed } from "../feed";
import { DETECT_INTERVAL_MS, type ScheduleFn } from "../promptWatcher";
import { AUTO_HIDE_POLL_MS, type RevealState } from "../revealController";
import permissionBash from "./fixtures/prompts/permission-bash.txt?raw";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** A hand-driven clock so every controller tick is a deliberate step. */
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

const emptyFeed: ChatFeed = {
  entries: [],
  stale: false,
  onUpdate: () => () => undefined,
  onStale: () => () => undefined,
  dispose: () => undefined,
};

const PROMPT_SCREEN = permissionBash.split("\n");
const QUIET_SCREEN = [
  "● Done.",
  "╭──────────────────────────────╮",
  "│ >                            │",
  "╰──────────────────────────────╯",
];

async function mount(options: { bootReveal?: boolean } = {}) {
  const clock = testScheduler();
  const reveals: RevealState[] = [];
  const sent: string[] = [];
  let screen = QUIET_SCREEN;
  await act(async () =>
    root.render(
      <ChatOverlay
        filePath="C:\\transcripts\\session.jsonl"
        header={{ title: "Session", onFlipToTerminal: () => undefined }}
        density="chips"
        onDensityChange={() => undefined}
        showThinking={false}
        onShowThinkingChange={() => undefined}
        sendKeys={(data) => sent.push(data)}
        terminalSnapshot={() => screen}
        openFeed={() => Promise.resolve(emptyFeed)}
        onRevealChange={(state) => reveals.push(state)}
        schedule={clock.schedule}
        {...(options.bootReveal === undefined ? {} : { bootReveal: options.bootReveal })}
      />,
    ),
  );
  return {
    clock,
    reveals,
    sent,
    setScreen(lines: string[]) {
      screen = lines;
    },
    async advance(delayMs: number) {
      await act(async () => clock.advance(delayMs));
    },
  };
}

function query(testid: string): Element | null {
  return container.querySelector(`[data-testid="${testid}"]`);
}

describe("ChatOverlay", () => {
  it("opens with the dock up for a resume boot, and says so", async () => {
    const harness = await mount({ bootReveal: true });
    expect(harness.reveals).toEqual([{ revealed: true, reason: "boot" }]);
    expect(query("chat-reveal-hide")).not.toBeNull();
  });

  it("opens hidden otherwise", async () => {
    const harness = await mount();
    expect(harness.reveals).toEqual([]);
    expect(query("chat-reveal")).not.toBeNull();
  });

  it("raises the dock when the detector sees claude asking", async () => {
    const harness = await mount();
    harness.setScreen(PROMPT_SCREEN);
    // Two ticks: one to sample, one to confirm the screen settled.
    await harness.advance(DETECT_INTERVAL_MS);
    await harness.advance(DETECT_INTERVAL_MS);

    expect(harness.reveals).toEqual([{ revealed: true, reason: "prompt" }]);
    expect(query("chat-reveal-hide")).not.toBeNull();
    // The detector answers nothing: claude's own UI is what the dock shows.
    expect(harness.sent).toEqual([]);
  });

  it("puts the dock away once the transcript and the screen are both quiet", async () => {
    const harness = await mount({ bootReveal: true });
    await harness.advance(AUTO_HIDE_POLL_MS);
    expect(harness.reveals).toEqual([
      { revealed: true, reason: "boot" },
      { revealed: false, reason: null },
    ]);
    expect(query("chat-reveal")).not.toBeNull();
  });

  it("forwards a typed slash to the session and raises the dock for it", async () => {
    const harness = await mount();
    const box = container.querySelector("textarea");
    if (!box) {
      throw new Error("no input box");
    }
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(box, "/");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(harness.sent).toEqual(["/"]);
    expect(box.value).toBe("");
    expect(harness.reveals).toEqual([{ revealed: true, reason: "slash" }]);
  });

  it("opens and closes the dock from the chevron, and never auto-closes that one", async () => {
    const harness = await mount();
    await act(async () => query("chat-reveal")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    ));
    expect(harness.reveals).toEqual([{ revealed: true, reason: "manual" }]);

    // The screen is quiet, but a dock the user asked for stays up.
    await harness.advance(AUTO_HIDE_POLL_MS * 4);
    expect(harness.reveals).toHaveLength(1);

    await act(async () => query("chat-reveal-hide")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    ));
    expect(harness.reveals).toEqual([
      { revealed: true, reason: "manual" },
      { revealed: false, reason: null },
    ]);
  });

  it("stops both controllers when the chat unmounts", async () => {
    const harness = await mount();
    expect(harness.clock.pendingCount).toBeGreaterThan(0);
    await act(async () => root.unmount());
    expect(harness.clock.pendingCount).toBe(0);
    root = createRoot(container);
  });
});
