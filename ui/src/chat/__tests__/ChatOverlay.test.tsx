import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatOverlay } from "../ChatOverlay";
import type { ChatFeed } from "../feed";
import { type ScheduleFn } from "../promptWatcher";

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

const QUIET_SCREEN = [
  "● Done.",
  "╭──────────────────────────────╮",
  "│ >                            │",
  "╰──────────────────────────────╯",
];

async function mount(options: { bootReveal?: boolean } = {}) {
  const clock = testScheduler();
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
        schedule={clock.schedule}
        {...(options.bootReveal === undefined ? {} : { bootReveal: options.bootReveal })}
      />,
    ),
  );
  return {
    clock,
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
  it("shows the chat and nothing that could reveal the terminal", async () => {
    await mount();
    expect(query("chat-view")).not.toBeNull();
    expect(query("chat-reveal")).toBeNull();
    expect(query("chat-reveal-hide")).toBeNull();
  });

  it("stays terminal-free even when the pane booted from a resume", async () => {
    // v3 §4 replaces the boot dock with a card; A3 adds it. What must never
    // come back is the dock itself, initial value or later rising edge.
    const harness = await mount({ bootReveal: true });
    expect(query("chat-reveal-hide")).toBeNull();
    await harness.advance(1_000);
    expect(query("chat-reveal-hide")).toBeNull();
  });

  it("stops its controllers when the chat unmounts", async () => {
    const harness = await mount();
    expect(harness.clock.pendingCount).toBeGreaterThan(0);
    await act(async () => root.unmount());
    expect(harness.clock.pendingCount).toBe(0);
    root = createRoot(container);
  });
});
