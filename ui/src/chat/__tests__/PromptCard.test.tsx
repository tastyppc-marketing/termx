import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatView } from "../ChatView";
import type { ChatFeed } from "../feed";
import { ENTER_DELAY_MS } from "../ChatInput";
import { DETECT_INTERVAL_MS, PROMPT_RETRY_MS, type ScheduleFn } from "../promptWatcher";
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

const emptyFeed: ChatFeed = {
  entries: [],
  stale: false,
  onUpdate: () => () => undefined,
  onStale: () => () => undefined,
  dispose: () => undefined,
};

const PROMPT_SCREEN = permissionBash.split("\n");
const QUIET_SCREEN = ["$ npm run build", "building…"];

function button(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!found) {
    throw new Error(`button "${text}" not found`);
  }
  return found;
}

interface Harness {
  clock: ReturnType<typeof testScheduler>;
  sent: string[];
  setScreen(lines: string[]): void;
  /** Two ticks: one to sample, one to confirm the screen settled. */
  settle(): Promise<void>;
}

async function mount(options: { idle?: boolean } = {}): Promise<Harness> {
  const clock = testScheduler();
  const sent: string[] = [];
  let screen = QUIET_SCREEN;
  await act(async () =>
    root.render(
      <ChatView
        feed={emptyFeed}
        density="chips"
        onDensityChange={() => undefined}
        showThinking={false}
        onShowThinkingChange={() => undefined}
        sendKeys={(data) => sent.push(data)}
        header={{ title: "Session", onFlipToTerminal: () => undefined }}
        terminalSnapshot={() => screen}
        transcriptIdle={options.idle ?? true}
        schedule={clock.schedule}
      />,
    ),
  );
  return {
    clock,
    sent,
    setScreen(lines) {
      screen = lines;
    },
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
    expect(container.querySelector('[data-testid="prompt-card"]')).toBeNull();
    expect(harness.sent).toEqual([]);
  });

  it("raises a card once the screen settles on a menu, and sends nothing by itself", async () => {
    const harness = await mount();
    harness.setScreen(PROMPT_SCREEN);
    await harness.settle();

    const card = container.querySelector('[data-testid="prompt-card"]');
    expect(card).not.toBeNull();
    expect(card?.getAttribute("data-kind")).toBe("menu");
    expect(container.textContent).toContain("Do you want to proceed?");
    expect(harness.sent).toEqual([]);
  });

  it("stays quiet while the transcript is still producing entries", async () => {
    const harness = await mount({ idle: false });
    harness.setScreen(PROMPT_SCREEN);
    await harness.settle();
    expect(container.querySelector('[data-testid="prompt-card"]')).toBeNull();
  });

  it("sends exactly the keystrokes for the option clicked, then collapses", async () => {
    const harness = await mount();
    harness.setScreen(PROMPT_SCREEN);
    await harness.settle();

    await act(async () => button("No, and tell Claude what to do differently (esc)").click());
    // The Enter is its own write, a beat after the arrows — one chunk with a
    // trailing \r reads as a paste on the far side and never submits.
    expect(harness.sent).toEqual(["\x1b[B\x1b[B"]);
    await act(async () => harness.clock.advance(ENTER_DELAY_MS));
    expect(harness.sent).toEqual(["\x1b[B\x1b[B", "\r"]);
    expect(container.querySelector('[data-testid="prompt-card"]')).not.toBeNull();

    // The dialog closes; the card confirms the answer took.
    harness.setScreen(QUIET_SCREEN);
    await act(async () => harness.clock.advance(PROMPT_RETRY_MS));
    expect(container.querySelector('[data-testid="prompt-card"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="prompt-answered"]')?.textContent,
    ).toContain("No, and tell Claude what to do differently (esc)");
    expect(harness.sent).toHaveLength(2);
  });

  it("retries once against the screen as it stands, then degrades", async () => {
    const harness = await mount();
    harness.setScreen(PROMPT_SCREEN);
    await harness.settle();

    await act(async () => button("Yes").click());
    // "Yes" is already selected: the answer is a bare Enter, delayed.
    await act(async () => harness.clock.advance(ENTER_DELAY_MS));
    expect(harness.sent).toEqual(["\r"]);

    // Nothing moved: one re-derived retry.
    await act(async () => harness.clock.advance(PROMPT_RETRY_MS));
    await act(async () => harness.clock.advance(ENTER_DELAY_MS));
    expect(harness.sent).toEqual(["\r", "\r"]);
    expect(container.querySelector('[data-testid="prompt-card"]')?.getAttribute("data-kind")).toBe(
      "menu",
    );

    // Still nothing: the card gives up and shows the screen itself.
    await act(async () => harness.clock.advance(PROMPT_RETRY_MS));
    expect(harness.sent).toHaveLength(2);
    const card = container.querySelector('[data-testid="prompt-card"]');
    expect(card?.getAttribute("data-kind")).toBe("unknown");
    expect(
      container.querySelector('[data-testid="prompt-screen"]')?.textContent,
    ).toContain("Do you want to proceed?");
  });

  it("sends free text from the fallback card only when the user presses Enter", async () => {
    const harness = await mount();
    harness.setScreen(["Restoring the workspace…", "Enter the profile name to use:"]);
    await harness.settle();

    const card = container.querySelector('[data-testid="prompt-card"]');
    expect(card?.getAttribute("data-kind")).toBe("unknown");

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

    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(harness.sent).toEqual(["default"]);
    await act(async () => harness.clock.advance(ENTER_DELAY_MS));
    expect(harness.sent).toEqual(["default", "\r"]);
  });

  it("answers a y/N confirm with the key it showed", async () => {
    const harness = await mount();
    harness.setScreen(["Removing 3 stale worktrees.", "Continue? (y/N)"]);
    await harness.settle();
    expect(
      container.querySelector('[data-testid="prompt-card"]')?.getAttribute("data-kind"),
    ).toBe("confirm");

    await act(async () => button("Yes").click());
    expect(harness.sent).toEqual(["y"]);
    await act(async () => harness.clock.advance(ENTER_DELAY_MS));
    expect(harness.sent).toEqual(["y", "\r"]);
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
