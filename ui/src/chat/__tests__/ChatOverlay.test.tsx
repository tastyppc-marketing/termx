import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTO_HIDE_POLL_MS,
  BOOT_CARD_MAX_MS,
  ChatOverlay,
} from "../ChatOverlay";
import { SLASH } from "../ChatInput";
import type { ChatFeed } from "../feed";
import { KEY_ENTER } from "../promptDetector";
import { DETECT_INTERVAL_MS, type ScheduleFn } from "../promptWatcher";
import type { SlashCommand } from "../slashCommands";
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

const QUIET_SCREEN = [
  "● Done.",
  "╭──────────────────────────────╮",
  "│ >                            │",
  "╰──────────────────────────────╯",
];

const PROMPT_SCREEN = permissionBash.split("\n");

/** A screen that is plainly still working: the boot card must not clear. */
const BUSY_SCREEN = ["✻ Booting… (12s · esc to interrupt)"];

const COMMANDS: readonly SlashCommand[] = [
  { name: "model", description: "Choose the model" },
  { name: "rename", description: "Rename this conversation" },
];

async function mount(options: { bootReveal?: boolean; screen?: string[] } = {}) {
  const clock = testScheduler();
  const sent: string[] = [];
  const learned: SlashCommand[][] = [];
  let screen = options.screen ?? QUIET_SCREEN;
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
        slashCommands={COMMANDS}
        onCommandsLearned={(commands) => learned.push(commands)}
        schedule={clock.schedule}
        {...(options.bootReveal === undefined ? {} : { bootReveal: options.bootReveal })}
      />,
    ),
  );
  return {
    clock,
    sent,
    learned,
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

function box(): HTMLTextAreaElement {
  const found = container.querySelector("textarea");
  if (!found) {
    throw new Error("no input box");
  }
  return found;
}

/** Drive the real box, so the palette state machine is the one under test. */
async function type(value: string): Promise<void> {
  const input = box();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.selectionStart = value.length;
    input.selectionEnd = value.length;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(key: string): Promise<void> {
  await act(async () => {
    box().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
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

// Spec §2: the hidden claude is both the executor and the teacher, so every
// palette transition owes it a keystroke — and exactly one.
describe("ChatOverlay slash choreography", () => {
  it("sends the slash to claude when the palette opens", async () => {
    const harness = await mount();
    await type("/");
    expect(harness.sent).toEqual([SLASH]);
    expect(query("chat-slash")).not.toBeNull();
  });

  it("completes a picked command without repeating the slash", async () => {
    const harness = await mount();
    await type("/");
    await type("/mod");
    await press("Enter");
    // claude's box already holds the "/": sending it again would type "//".
    expect(harness.sent).toEqual([SLASH, `model${KEY_ENTER}`]);
    expect(query("chat-slash")).toBeNull();
  });

  it("clears claude's menu with Escape when the palette is cancelled", async () => {
    const harness = await mount();
    await type("/");
    await press("Escape");
    expect(harness.sent).toEqual([SLASH, "\x1b"]);
    expect(query("chat-slash")).toBeNull();
  });

  it("sends a command with arguments as one line, minus the leading slash", async () => {
    const harness = await mount();
    await type("/");
    await type("/rename gate-renamed");
    await press("Enter");
    expect(harness.sent).toEqual([SLASH, `rename gate-renamed${KEY_ENTER}`]);
  });

  it("hides prompt cards while the palette is up, and keeps detecting underneath", async () => {
    const harness = await mount();
    await type("/");
    // claude drew its own command menu in response — which reads exactly like
    // a menu prompt. It must not surface as a card on top of our palette.
    harness.setScreen(PROMPT_SCREEN);
    await harness.advance(DETECT_INTERVAL_MS);
    await harness.advance(DETECT_INTERVAL_MS);
    expect(query("prompt-card")).toBeNull();

    // Cancelling puts the card back without re-running the detector.
    await press("Escape");
    expect(query("prompt-card")).not.toBeNull();
  });
});

// Spec §4: a resume boots behind a status card, never behind a dock.
describe("ChatOverlay boot card", () => {
  it("shows nothing for an ordinary open", async () => {
    await mount();
    expect(query("boot-card")).toBeNull();
  });

  it("pins the card while the session is starting", async () => {
    const harness = await mount({ bootReveal: true, screen: BUSY_SCREEN });
    expect(query("boot-card")?.textContent).toContain("Resuming session");
    await harness.advance(AUTO_HIDE_POLL_MS * 3);
    expect(query("boot-card")).not.toBeNull();
  });

  it("raises the card when the boot signal lands after mount", async () => {
    // The pane links (and this mounts) when the tab opens; the boot is only
    // announced once the resume command is typed, seconds later.
    const clock = testScheduler();
    const render = async (bootReveal: boolean | undefined) =>
      act(async () =>
        root.render(
          <ChatOverlay
            filePath="C:\\transcripts\\session.jsonl"
            header={{ title: "Session", onFlipToTerminal: () => undefined }}
            density="chips"
            onDensityChange={() => undefined}
            showThinking={false}
            onShowThinkingChange={() => undefined}
            sendKeys={() => undefined}
            terminalSnapshot={() => BUSY_SCREEN}
            openFeed={() => Promise.resolve(emptyFeed)}
            slashCommands={COMMANDS}
            onCommandsLearned={() => undefined}
            schedule={clock.schedule}
            {...(bootReveal === undefined ? {} : { bootReveal })}
          />,
        ),
      );

    await render(undefined);
    expect(query("boot-card")).toBeNull();
    await render(true);
    expect(query("boot-card")).not.toBeNull();
  });

  it("clears the card once the screen and the transcript are both quiet", async () => {
    const harness = await mount({ bootReveal: true });
    expect(query("boot-card")).not.toBeNull();
    await harness.advance(AUTO_HIDE_POLL_MS);
    expect(query("boot-card")).toBeNull();
  });

  it("clears the card when a prompt takes over the story", async () => {
    const harness = await mount({ bootReveal: true, screen: BUSY_SCREEN });
    harness.setScreen(PROMPT_SCREEN);
    await harness.advance(DETECT_INTERVAL_MS);
    await harness.advance(DETECT_INTERVAL_MS);
    expect(query("prompt-card")).not.toBeNull();
    expect(query("boot-card")).toBeNull();
  });

  it("gives up after a minute rather than wedging on a hung boot", async () => {
    const harness = await mount({ bootReveal: true, screen: BUSY_SCREEN });
    await harness.advance(BOOT_CARD_MAX_MS - 1);
    expect(query("boot-card")).not.toBeNull();
    await harness.advance(1);
    expect(query("boot-card")).toBeNull();
  });

  it("does not raise the card again once it has been cleared", async () => {
    const harness = await mount({ bootReveal: true });
    await harness.advance(AUTO_HIDE_POLL_MS);
    expect(query("boot-card")).toBeNull();
    // A parent re-render re-asserting the same prop is not a new boot.
    await harness.advance(AUTO_HIDE_POLL_MS * 4);
    expect(query("boot-card")).toBeNull();
  });
});
