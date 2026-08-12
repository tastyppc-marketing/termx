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

async function mount(props: { promptActive?: boolean } = {}) {
  const sent: string[] = [];
  await act(async () =>
    root.render(<ChatInput sendKeys={(data) => sent.push(data)} {...props} />),
  );
  return sent;
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

  it("stays usable while a prompt card is waiting, and says where to look", async () => {
    const sent = await mount({ promptActive: true });
    expect(box().disabled).toBe(false);
    expect(container.textContent).toContain("waiting on the card above");
    await type("something else");
    await press("Enter");
    await pressLands();
    expect(sent).toEqual(["something else", "\r"]);
  });

  it("shows no hint when nothing is waiting", async () => {
    await mount();
    expect(container.textContent).not.toContain("waiting on the card above");
  });
});
