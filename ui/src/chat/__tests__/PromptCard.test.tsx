import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatOverlay } from "../ChatOverlay";
import type { ChatFeed } from "../feed";
import { KEY_DOWN, KEY_ENTER, KEY_UP } from "../promptDetector";
import { DETECT_INTERVAL_MS, PROMPT_RETRY_MS, type ScheduleFn } from "../promptWatcher";
import type { ChatEntry } from "../types";
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

/** A feed the test drives by hand, so "the agent is still talking" is sayable. */
function fakeFeed(): ChatFeed & { push(entries: ChatEntry[]): void } {
  const entries: ChatEntry[] = [];
  const updates = new Set<() => void>();
  return {
    get entries() {
      return entries;
    },
    stale: false,
    onUpdate(listener) {
      updates.add(listener);
      return () => updates.delete(listener);
    },
    onStale: () => () => undefined,
    dispose: () => undefined,
    push(next) {
      entries.push(...next);
      for (const listener of [...updates]) listener();
    },
  };
}

const PROMPT_SCREEN = permissionBash.split("\n");
const QUIET_SCREEN = ["$ npm run build", "building…"];
const ASK_SCREEN = ["Restoring the workspace…", "Enter the profile name to use:"];

function card(): Element | null {
  return container.querySelector('[data-testid="prompt-card"]');
}

function button(text: string, within: ParentNode = container): HTMLButtonElement {
  const found = Array.from(within.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!found) {
    throw new Error(`button "${text}" not found`);
  }
  return found;
}

/** The card's own buttons; the header has an "Esc" of its own. */
function keyRowButton(text: string): HTMLButtonElement {
  const row = container.querySelector(".chat-card__keys");
  if (!row) {
    throw new Error("no key row");
  }
  return button(text, row);
}

async function mount(): Promise<{
  clock: ReturnType<typeof testScheduler>;
  sent: string[];
  feed: ReturnType<typeof fakeFeed>;
  flips: number;
  setScreen(lines: string[]): void;
  settle(): Promise<void>;
}> {
  const clock = testScheduler();
  const sent: string[] = [];
  const feed = fakeFeed();
  const state = { flips: 0 };
  let screen = QUIET_SCREEN;
  await act(async () =>
    root.render(
      <ChatOverlay
        filePath="C:\\transcripts\\session.jsonl"
        header={{ title: "Session", onFlipToTerminal: () => (state.flips += 1) }}
        density="chips"
        onDensityChange={() => undefined}
        showThinking={false}
        onShowThinkingChange={() => undefined}
        sendKeys={(data) => sent.push(data)}
        terminalSnapshot={() => screen}
        openFeed={() => Promise.resolve(feed)}
        schedule={clock.schedule}
      />,
    ),
  );
  return {
    clock,
    sent,
    feed,
    get flips() {
      return state.flips;
    },
    setScreen(lines) {
      screen = lines;
    },
    /** Two ticks: one to sample, one to confirm the screen settled. */
    async settle() {
      await act(async () => clock.advance(DETECT_INTERVAL_MS));
      await act(async () => clock.advance(DETECT_INTERVAL_MS));
    },
  };
}

describe("prompt cards", () => {
  it("shows nothing while the screen is ordinary output", async () => {
    const harness = await mount();
    await harness.settle();
    expect(card()).toBeNull();
    expect(harness.sent).toEqual([]);
  });

  it("raises a card once the screen settles on a menu, and sends nothing by itself", async () => {
    const harness = await mount();
    harness.setScreen(PROMPT_SCREEN);
    await harness.settle();

    expect(card()?.getAttribute("data-kind")).toBe("menu");
    expect(container.textContent).toContain("Do you want to proceed?");
    expect(harness.sent).toEqual([]);
  });

  it("stays quiet while the transcript is still producing entries", async () => {
    const harness = await mount();
    await act(async () =>
      harness.feed.push([{ kind: "user", id: "u1", ts: 1, text: "still talking" }]),
    );
    harness.setScreen(PROMPT_SCREEN);
    await harness.settle();
    expect(card()).toBeNull();
  });

  it("sends exactly the keystrokes for the option clicked, then collapses", async () => {
    const harness = await mount();
    harness.setScreen(PROMPT_SCREEN);
    await harness.settle();

    await act(async () =>
      button("No, and tell Claude what to do differently (esc)").click(),
    );
    // The Enter is its own write, a beat after the arrows — one chunk with a
    // trailing \r reads as a paste on the far side and never submits.
    expect(harness.sent).toEqual([`${KEY_DOWN}${KEY_DOWN}`]);
    await act(async () => harness.clock.advance(PROMPT_RETRY_MS));
    expect(harness.sent).toContain(KEY_ENTER);

    harness.setScreen(QUIET_SCREEN);
    await act(async () => harness.clock.advance(PROMPT_RETRY_MS));
    expect(card()).toBeNull();
    expect(
      container.querySelector('[data-testid="prompt-answered"]')?.textContent,
    ).toContain("No, and tell Claude what to do differently (esc)");
  });

  it("answers a y/N confirm with the key it showed", async () => {
    const harness = await mount();
    harness.setScreen(["Removing 3 stale worktrees.", "Continue? (y/N)"]);
    await harness.settle();
    expect(card()?.getAttribute("data-kind")).toBe("confirm");

    await act(async () => button("Yes").click());
    expect(harness.sent).toEqual(["y"]);
  });

  it("sends free text from the fallback card only when the user presses Enter", async () => {
    const harness = await mount();
    harness.setScreen(ASK_SCREEN);
    await harness.settle();
    expect(card()?.getAttribute("data-kind")).toBe("unknown");

    const input = container.querySelector<HTMLInputElement>(".chat-card__input");
    if (!input) {
      throw new Error("no free-text box");
    }
    await act(async () => {
      // React tracks the value itself; a bare assignment is deduplicated away.
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "default");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(harness.sent).toEqual([]);

    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(harness.sent).toEqual(["default"]);
  });

  // v3 §3: the combined fallback card. An arrow-key menu nobody parsed is
  // still answerable from chat — one keypress per click, nothing batched.
  it("sends exactly one sequence per key-row click", async () => {
    const harness = await mount();
    harness.setScreen(ASK_SCREEN);
    await harness.settle();

    await act(async () => keyRowButton("↑").click());
    expect(harness.sent).toEqual([KEY_UP]);
    await act(async () => keyRowButton("↓").click());
    expect(harness.sent).toEqual([KEY_UP, KEY_DOWN]);
    await act(async () => keyRowButton("Enter").click());
    expect(harness.sent).toEqual([KEY_UP, KEY_DOWN, KEY_ENTER]);
    await act(async () => keyRowButton("Esc").click());
    expect(harness.sent).toEqual([KEY_UP, KEY_DOWN, KEY_ENTER, "\x1b"]);
    // The card is still up: a keypress is not an answer.
    expect(card()?.getAttribute("data-kind")).toBe("unknown");
  });

  it("re-reads the screen into the fallback card while it is showing", async () => {
    const harness = await mount();
    harness.setScreen(ASK_SCREEN);
    await harness.settle();
    const excerpt = () =>
      container.querySelector('[data-testid="prompt-screen"]')?.textContent ?? "";
    expect(excerpt()).toContain("Restoring the workspace…");
    expect(excerpt()).not.toContain("Found 2 profiles.");

    harness.setScreen([
      "Restoring the workspace…",
      "Found 2 profiles.",
      "Enter the profile name to use:",
    ]);
    await harness.settle();
    expect(excerpt()).toContain("Found 2 profiles.");
  });

  it("offers the full terminal from the card as the last resort", async () => {
    const harness = await mount();
    harness.setScreen(ASK_SCREEN);
    await harness.settle();
    await act(async () => button("Open terminal", card() ?? container).click());
    expect(harness.flips).toBe(1);
  });

  it("stops watching when the chat unmounts", async () => {
    const harness = await mount();
    await harness.settle();
    expect(harness.clock.pendingCount).toBeGreaterThan(0);
    await act(async () => root.unmount());
    expect(harness.clock.pendingCount).toBe(0);
    root = createRoot(container);
  });
});
