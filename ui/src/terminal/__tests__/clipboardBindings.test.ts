import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  attachClipboardBindings,
  type ClipboardBridge,
  type ClipboardTerminal,
} from "../clipboardBindings";

class FakeClipboardTerminal implements ClipboardTerminal {
  selection = "";
  readonly pastes: string[] = [];
  keyHandler: ((event: KeyboardEvent) => boolean) | undefined;

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this.keyHandler = handler;
  }
  clearSelection() {
    this.selection = "";
  }
  getSelection() {
    return this.selection;
  }
  hasSelection() {
    return this.selection.length > 0;
  }
  paste(text: string) {
    this.pastes.push(text);
  }
}

/** Let the clipboard promise and its `.then` settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function fixture(clipboardText = "pasted text") {
  const terminal = new FakeClipboardTerminal();
  const element = document.createElement("div");
  const helper = document.createElement("textarea");
  helper.className = "xterm-helper-textarea";
  element.appendChild(helper);
  document.body.appendChild(element);
  const clipboard: ClipboardBridge = {
    readText: vi.fn(async () => clipboardText),
    writeText: vi.fn(async () => undefined),
  };
  const detach = attachClipboardBindings(terminal, element, clipboard);
  return { clipboard, detach, element, helper, terminal };
}

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { cancelable: true, ...init });
}

function injectedInput(inputType: string, data: string, isComposing = false) {
  const event = new Event("input", { bubbles: true });
  Object.defineProperties(event, {
    data: { value: data },
    inputType: { value: inputType },
    isComposing: { value: isComposing },
  });
  return event;
}

describe("clipboard key chords", () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => {
    f = fixture();
  });

  it.each([
    ["Ctrl+V", { ctrlKey: true, key: "v" }],
    ["Ctrl+Shift+V", { ctrlKey: true, shiftKey: true, key: "V" }],
    ["Shift+Insert", { shiftKey: true, key: "Insert" }],
  ])("%s pastes the clipboard into the terminal", async (_name, init) => {
    const event = keydown(init);
    expect(f.terminal.keyHandler?.(event)).toBe(false);
    await settle();
    // terminal.paste, never a raw write: it honours bracketed-paste mode, so a
    // multi-line paste arrives as text instead of executing every line.
    expect(f.terminal.pastes).toEqual(["pasted text"]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves an empty clipboard alone", async () => {
    const empty = fixture("");
    empty.terminal.keyHandler?.(keydown({ ctrlKey: true, key: "v" }));
    await settle();
    expect(empty.terminal.pastes).toEqual([]);
  });

  it("survives a clipboard the webview refuses to read", async () => {
    const terminal = new FakeClipboardTerminal();
    const element = document.createElement("div");
    attachClipboardBindings(terminal, element, {
      readText: vi.fn(async () => {
        throw new Error("Document is not focused");
      }),
      writeText: vi.fn(async () => undefined),
    });
    expect(() =>
      terminal.keyHandler?.(keydown({ ctrlKey: true, key: "v" })),
    ).not.toThrow();
    await settle();
    expect(terminal.pastes).toEqual([]);
  });

  it("keeps Ctrl+C an interrupt when nothing is selected", () => {
    expect(f.terminal.keyHandler?.(keydown({ ctrlKey: true, key: "c" }))).toBe(
      true,
    );
    expect(f.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("copies on Ctrl+C when a selection is active", () => {
    f.terminal.selection = "selected";
    expect(f.terminal.keyHandler?.(keydown({ ctrlKey: true, key: "c" }))).toBe(
      false,
    );
    expect(f.clipboard.writeText).toHaveBeenCalledWith("selected");
    expect(f.terminal.selection).toBe("");
  });

  it("ignores a bare v, and Alt/Meta chords", async () => {
    for (const init of [
      { key: "v" },
      { altKey: true, ctrlKey: true, key: "v" },
      { metaKey: true, key: "v" },
    ]) {
      expect(f.terminal.keyHandler?.(keydown(init))).toBe(true);
    }
    await settle();
    expect(f.terminal.pastes).toEqual([]);
  });

  it("ignores keyup so a chord never pastes twice", async () => {
    const event = new KeyboardEvent("keyup", { ctrlKey: true, key: "v" });
    expect(f.terminal.keyHandler?.(event)).toBe(true);
    await settle();
    expect(f.terminal.pastes).toEqual([]);
  });
});

describe("right-click clipboard route", () => {
  it("pastes when there is no selection", async () => {
    const f = fixture();
    f.element.dispatchEvent(new MouseEvent("contextmenu", { cancelable: true }));
    await settle();
    expect(f.terminal.pastes).toEqual(["pasted text"]);
  });

  it("copies when there is a selection", async () => {
    const f = fixture();
    f.terminal.selection = "selected";
    f.element.dispatchEvent(new MouseEvent("contextmenu", { cancelable: true }));
    await settle();
    expect(f.clipboard.writeText).toHaveBeenCalledWith("selected");
    expect(f.terminal.pastes).toEqual([]);
  });
});

describe("injected text (voice typing, IME replacement, drops)", () => {
  it.each(["insertReplacementText", "insertFromPaste", "insertFromDrop", "insertFromYank"])(
    "forwards %s, which xterm drops on the floor",
    (inputType) => {
      const f = fixture();
      f.helper.value = "dictated";
      f.helper.dispatchEvent(injectedInput(inputType, "dictated"));
      expect(f.terminal.pastes).toEqual(["dictated"]);
      // Cleared, or the next injection would carry the old text along.
      expect(f.helper.value).toBe("");
    },
  );

  it("never forwards insertText — xterm already handles it", () => {
    const f = fixture();
    f.helper.dispatchEvent(injectedInput("insertText", "typed"));
    expect(f.terminal.pastes).toEqual([]);
  });

  it("leaves a live composition to xterm's IME helper", () => {
    const f = fixture();
    f.helper.dispatchEvent(injectedInput("insertReplacementText", "半", true));
    expect(f.terminal.pastes).toEqual([]);
  });

  it("ignores an injection with no data", () => {
    const f = fixture();
    f.helper.dispatchEvent(injectedInput("insertReplacementText", ""));
    expect(f.terminal.pastes).toEqual([]);
  });
});

describe("detach", () => {
  it("stops both DOM routes", async () => {
    const f = fixture();
    f.detach();
    f.element.dispatchEvent(new MouseEvent("contextmenu", { cancelable: true }));
    f.helper.dispatchEvent(injectedInput("insertReplacementText", "dictated"));
    await settle();
    expect(f.terminal.pastes).toEqual([]);
  });
});
