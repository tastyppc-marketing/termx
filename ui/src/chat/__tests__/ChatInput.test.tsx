import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatInput,
  ENTER_DELAY_MS,
  HISTORY_CAP,
  PASTE_END,
  PASTE_START,
} from "../ChatInput";
import type { SlashCommand } from "../slashCommands";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** Let the delayed Enter write fire. */
async function pressLands(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ENTER_DELAY_MS);
  });
}

function box(): HTMLTextAreaElement {
  const found = container.querySelector("textarea");
  if (!found) {
    throw new Error("no input box");
  }
  return found;
}

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

async function press(
  key: string,
  options: { shiftKey?: boolean; caret?: number } = {},
): Promise<void> {
  const input = box();
  if (options.caret !== undefined) {
    input.selectionStart = options.caret;
    input.selectionEnd = options.caret;
  }
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        shiftKey: options.shiftKey ?? false,
      }),
    );
  });
}

/**
 * Three commands that all prefix-match "m", so the palette's order is fixed by
 * the contract (name-prefix matches first, alphabetical) rather than by the
 * list handed in — which is what keeps these assertions true after lane B's
 * real filterCommands replaces the stub.
 */
const COMMANDS: readonly SlashCommand[] = [
  { name: "model", description: "Choose the model" },
  { name: "mcp", description: "Manage MCP servers" },
  { name: "memory", description: "Edit memory files" },
];

interface SlashLog {
  opens: number;
  picks: string[];
  cancels: number;
  passthrough: string[];
}

async function mount(
  props: Partial<React.ComponentProps<typeof ChatInput>> = {},
) {
  const sent: string[] = [];
  await act(async () =>
    root.render(
      <ChatInput
        sendKeys={(data) => sent.push(data)}
        slashCommands={COMMANDS}
        onSlashOpen={() => undefined}
        onSlashPick={() => undefined}
        onSlashCancel={() => undefined}
        onSlashPassthrough={() => undefined}
        {...props}
      />,
    ),
  );
  return sent;
}

/** Mounts with every slash callback recorded. */
async function mountWithSlash(): Promise<{ sent: string[]; log: SlashLog }> {
  const log: SlashLog = { opens: 0, picks: [], cancels: 0, passthrough: [] };
  const sent = await mount({
    onSlashOpen: () => (log.opens += 1),
    onSlashPick: (name) => log.picks.push(name),
    onSlashCancel: () => (log.cancels += 1),
    onSlashPassthrough: (line) => log.passthrough.push(line),
  });
  return { sent, log };
}

function palette(): Element | null {
  return container.querySelector('[data-testid="chat-slash"]');
}

describe("ChatInput", () => {
  it("sends the text, then Enter as its OWN write a beat later", async () => {
    const sent = await mount();
    await type("run the tests");
    await press("Enter");
    // One write would read as a paste on the far side — no submit.
    expect(sent).toEqual(["run the tests"]);
    expect(box().value).toBe("");
    await pressLands();
    expect(sent).toEqual(["run the tests", "\r"]);
  });

  it("sends nothing for an empty box", async () => {
    const sent = await mount();
    await press("Enter");
    await type("   ");
    await press("Enter");
    expect(sent).toEqual([]);
  });

  it("leaves Shift+Enter to the textarea so a newline is just a newline", async () => {
    const sent = await mount();
    await type("first line");
    await press("Enter", { shiftKey: true });
    expect(sent).toEqual([]);
    expect(box().value).toBe("first line");
  });

  it("wraps a multiline send in bracketed paste so the TUI sees one block", async () => {
    const sent = await mount();
    await type("first line\nsecond line");
    await press("Enter");
    await pressLands();
    expect(sent).toEqual([
      `${PASTE_START}first line\nsecond line${PASTE_END}`,
      "\r",
    ]);
  });

  it("cycles history with the arrow keys", async () => {
    const sent = await mount();
    await type("one");
    await press("Enter");
    await pressLands();
    await type("two");
    await press("Enter");
    await pressLands();
    expect(sent).toEqual(["one", "\r", "two", "\r"]);

    await press("ArrowUp", { caret: 0 });
    expect(box().value).toBe("two");
    await press("ArrowUp", { caret: 0 });
    expect(box().value).toBe("one");
    await press("ArrowUp", { caret: 0 });
    expect(box().value).toBe("one");

    await press("ArrowDown");
    expect(box().value).toBe("two");
    await press("ArrowDown");
    expect(box().value).toBe("");
  });

  it("leaves the arrows alone in the middle of a line", async () => {
    await mount();
    await type("halfway");
    await press("ArrowUp", { caret: 3 });
    expect(box().value).toBe("halfway");
  });

  it(`keeps at most ${HISTORY_CAP} entries`, async () => {
    await mount();
    for (let index = 0; index <= HISTORY_CAP; index += 1) {
      await type(`message ${index}`);
      await press("Enter");
    }
    // Walk all the way back: the oldest entry has been dropped.
    for (let index = 0; index < HISTORY_CAP + 5; index += 1) {
      await press("ArrowUp", { caret: 0 });
    }
    expect(box().value).toBe("message 1");
  });

  it("only reacts to a slash that starts an empty box", async () => {
    const { log } = await mountWithSlash();
    await type("cd ui/src");
    expect(log.opens).toBe(0);
    expect(palette()).toBeNull();
    expect(box().value).toBe("cd ui/src");
  });

  it("keeps a PASTED command as ordinary text — claude never got our slash", async () => {
    const { sent, log } = await mountWithSlash();
    await type("/model opus");
    expect(log.opens).toBe(0);
    expect(log.passthrough).toEqual([]);
    await press("Enter");
    await pressLands();
    expect(sent).toEqual(["/model opus", "\r"]);
  });
});

describe("ChatInput slash palette", () => {
  it("opens the palette on a slash and keeps the character in the box", async () => {
    const { sent, log } = await mountWithSlash();
    await type("/");
    expect(log.opens).toBe(1);
    expect(palette()).not.toBeNull();
    // The overlay sends the "/" to the PTY; the box itself writes nothing.
    expect(sent).toEqual([]);
    expect(box().value).toBe("/");
  });

  it("filters as the user types and picks the highlighted row on Enter", async () => {
    const { sent, log } = await mountWithSlash();
    await type("/");
    await type("/mod");
    await press("Enter");
    expect(log.picks).toEqual(["/model"]);
    expect(log.passthrough).toEqual([]);
    // The pick is the overlay's write, not the box's.
    expect(sent).toEqual([]);
    expect(palette()).toBeNull();
    expect(box().value).toBe("");
  });

  it("moves the selection with the arrows instead of walking history", async () => {
    const { log } = await mountWithSlash();
    await type("hello");
    await press("Enter");
    await pressLands();

    await type("/");
    await type("/m");
    // Contract order for a prefix query: mcp, memory, model.
    await press("ArrowDown");
    await press("ArrowDown");
    // Past the end holds at the last row rather than wrapping into history.
    await press("ArrowDown");
    await press("Enter");
    expect(log.picks).toEqual(["/model"]);
    expect(box().value).toBe("");
  });

  it("holds the selection at the top when the user arrows up past it", async () => {
    const { log } = await mountWithSlash();
    await type("/");
    await type("/m");
    await press("ArrowDown");
    await press("ArrowUp");
    await press("ArrowUp");
    await press("Enter");
    expect(log.picks).toEqual(["/mcp"]);
  });

  it("cancels on Escape and clears the box", async () => {
    const { sent, log } = await mountWithSlash();
    await type("/");
    await type("/mo");
    await press("Escape");
    expect(log.cancels).toBe(1);
    expect(log.picks).toEqual([]);
    expect(palette()).toBeNull();
    expect(box().value).toBe("");
    expect(sent).toEqual([]);
  });

  it("cancels when the user deletes back to an empty box", async () => {
    const { log } = await mountWithSlash();
    await type("/");
    await type("/mo");
    await type("/");
    expect(log.cancels).toBe(0);
    await type("");
    expect(log.cancels).toBe(1);
    expect(palette()).toBeNull();
  });

  it("keeps the replacement when the user types clean over the slash line", async () => {
    // Select-all then a keystroke replaces the whole line in one change event.
    // The slash mode ends — but the keystroke that ended it is a message being
    // written, not something to throw away.
    const { log } = await mountWithSlash();
    await type("/");
    await type("/mo");
    await type("hello");
    expect(log.cancels).toBe(1);
    expect(palette()).toBeNull();
    expect(box().value).toBe("hello");
  });

  it("drops into passthrough once the line takes an argument", async () => {
    const { sent, log } = await mountWithSlash();
    await type("/");
    await type("/rename");
    expect(palette()).not.toBeNull();

    await type("/rename gate");
    // The palette closes: this is a command line now, not a name being chosen.
    expect(palette()).toBeNull();
    expect(log.cancels).toBe(0);

    await press("Enter");
    expect(log.passthrough).toEqual(["/rename gate"]);
    expect(log.picks).toEqual([]);
    expect(sent).toEqual([]);
    expect(box().value).toBe("");
  });

  it("re-opens the palette when the argument is deleted again, without a second open", async () => {
    const { log } = await mountWithSlash();
    await type("/");
    await type("/rename gate");
    expect(palette()).toBeNull();

    await type("/rename");
    expect(palette()).not.toBeNull();
    // claude's box still holds the one "/" we sent: opening again would type a
    // second one into it.
    expect(log.opens).toBe(1);
  });

  it("sends an unmatched command as passthrough rather than picking nothing", async () => {
    const { log } = await mountWithSlash();
    await type("/");
    await type("/zzz");
    await press("Enter");
    expect(log.picks).toEqual([]);
    expect(log.passthrough).toEqual(["/zzz"]);
  });

  it("never disables or mutes the box: chat mode always owns the keyboard", async () => {
    await mount();
    expect(container.querySelector(".chat-input--muted")).toBeNull();
    expect(box().getAttribute("aria-disabled")).toBeNull();
    expect(box().disabled).toBe(false);
  });
});
