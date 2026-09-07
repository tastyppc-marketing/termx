import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SplitNode } from "../../state/layout";
import { SleepController } from "../../terminal/sleep";
import type { PaneHostClient } from "../../terminal/TerminalPane";
import type { PaneSessionState } from "../../workspace/WorkspaceController";
import { SplitLayout, type SplitLayoutActions } from "../SplitLayout";

// xterm needs a canvas and host attachment; this boundary double keeps a real
// editable DOM node so replacing a mounted pane loses its identity and input.
vi.mock("../../terminal/TerminalPane", () => ({
  TerminalPane: ({ sessionId }: { sessionId: number }) => (
    <div className="terminal-pane">
      <textarea className="xterm-helper-textarea" aria-label={`Terminal ${sessionId}`} />
    </div>
  ),
}));

const TREE: SplitNode = {
  kind: "split", dir: "row", sizes: [0.35, 0.65],
  children: [{ kind: "pane", sessionId: 1 }, { kind: "pane", sessionId: 2 }],
};
const LIVE: Record<number, PaneSessionState> = {
  1: { status: "live", exitCode: null },
  2: { status: "live", exitCode: null },
  3: { status: "live", exitCode: null },
};
let container: HTMLDivElement;
let root: Root;
let actions: SplitLayoutActions;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  actions = {
    splitPane: vi.fn(), closePane: vi.fn(), dismissPane: vi.fn(),
    restartPane: vi.fn(), resizePane: vi.fn(),
  };
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

interface Options {
  tree?: SplitNode;
  states?: Record<number, PaneSessionState>;
  focused?: number;
  visible?: boolean;
  sleep?: SleepController;
}

function Harness(options: Options) {
  const [focused, setFocused] = useState(1);
  return (
    <SplitLayout
      tabId="tab-1" root={options.tree ?? TREE}
      client={{} as PaneHostClient} paneStates={options.states ?? LIVE}
      focusedSessionId={options.focused ?? focused} onFocusPane={setFocused}
      dismissingSessionIds={new Set()} actions={actions}
      paneTitles={{ 1: "API", 2: "Web", 3: "Logs" }}
      onRenamePane={() => undefined} visible={options.visible ?? true}
      sleep={options.sleep ?? null}
    />
  );
}

async function render(options: Options = {}) {
  await act(async () => root.render(<Harness {...options} />));
}

function pane(id: number): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-testid='split-pane-${id}']`)!;
}

function button(label: string, within: ParentNode = container): HTMLButtonElement {
  const found = within.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`);
  expect(found, `button ${label} exists`).not.toBeNull();
  return found!;
}

async function click(label: string, within: ParentNode = container) {
  await act(async () => button(label, within).click());
}

async function shortcut(target: EventTarget = window, key = "Enter", repeat = false) {
  const event = new KeyboardEvent("keydown", {
    key, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true, repeat,
  });
  await act(async () => target.dispatchEvent(event));
  return event;
}

function picker(): HTMLSelectElement {
  const found = container.querySelector<HTMLSelectElement>("select[aria-label='Switch pane']");
  expect(found, "maximized pane picker exists").not.toBeNull();
  return found!;
}

describe("maximizing panes", () => {
  it("maximizes the clicked pane without replacing terminals or changing split ratios", async () => {
    await render();
    const first = pane(1);
    const second = pane(2);
    const terminal = second.querySelector("textarea")!;
    terminal.value = "unfinished input";
    await click("Maximize pane", second);

    expect(second.style.width).toBe("100%");
    expect(second.style.left).toBe("0%");
    expect(first.style.display).toBe("none");
    expect(first.hasAttribute("inert")).toBe(true);
    expect(first.getAttribute("aria-hidden")).toBe("true");
    expect(picker().value).toBe("2");
    expect(second.querySelector("textarea")).toBe(terminal);
    expect(container.querySelector<HTMLElement>("[role='separator']")?.style.display).toBe("none");

    await click("Restore split view");
    expect(pane(1)).toBe(first);
    expect(pane(2)).toBe(second);
    expect(first.style.width).toBe("35%");
    expect(second.style.left).toBe("35%");
    expect(second.style.width).toBe("65%");
    expect(first.style.display).toBe("");
    expect(first.hasAttribute("inert")).toBe(false);
    expect(first.hasAttribute("aria-hidden")).toBe(false);
    expect(terminal.value).toBe("unfinished input");
    expect(actions.resizePane).not.toHaveBeenCalled();
    expect(actions.splitPane).not.toHaveBeenCalled();
  });

  it("switches maximized panes with the picker and external focus without remounting", async () => {
    await render();
    const terminals = [pane(1).querySelector("textarea"), pane(2).querySelector("textarea")];
    await click("Maximize pane", pane(1));
    const select = picker();
    select.focus();
    await act(async () => {
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(pane(2).style.width).toBe("100%");
    expect(pane(1).style.display).toBe("none");
    expect(document.activeElement).toBe(pane(2).querySelector("textarea"));
    await render({ focused: 1 });
    expect(picker().value).toBe("1");
    expect(pane(1).style.width).toBe("100%");
    expect(document.activeElement).toBe(pane(1).querySelector("textarea"));
    expect(pane(1).querySelector("textarea")).toBe(terminals[0]);
    expect(pane(2).querySelector("textarea")).toBe(terminals[1]);
  });

  it("toggles from the terminal shortcut, preserves terminal focus, and leaves Escape alone", async () => {
    await render();
    const terminal = pane(1).querySelector("textarea")!;
    terminal.focus();
    expect((await shortcut(terminal)).defaultPrevented).toBe(true);
    expect(pane(1).style.width).toBe("100%");
    expect(document.activeElement).toBe(terminal);
    expect((await shortcut(terminal, "Enter", true)).defaultPrevented).toBe(true);
    expect(pane(1).style.width).toBe("100%");
    expect((await shortcut(terminal, "Escape")).defaultPrevented).toBe(false);
    expect(pane(1).style.width).toBe("100%");
    await shortcut(terminal);
    expect(pane(1).style.width).toBe("35%");
    expect(document.activeElement).toBe(terminal);
  });

  it("returns focus to the selected terminal when the restore bar disappears", async () => {
    await render();
    await click("Maximize pane", pane(2));
    const restore = button("Restore split view");
    restore.focus();
    await act(async () => restore.click());
    expect(document.activeElement).toBe(pane(2).querySelector("textarea"));
  });

  it("does not take shortcuts from hidden tabs, editors, or close confirmation", async () => {
    await render({ visible: false });
    expect((await shortcut()).defaultPrevented).toBe(false);
    expect(pane(1).style.width).toBe("35%");
    await render();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect((await shortcut(input)).defaultPrevented).toBe(false);
    expect(pane(1).style.width).toBe("35%");
    input.remove();
    await click("Close pane", pane(1));
    expect((await shortcut()).defaultPrevented).toBe(false);
    expect(pane(1).style.width).toBe("35%");
  });

  it("restores when the maximized pane is removed and does not revive maximize on a later split", async () => {
    await render();
    await click("Maximize pane", pane(2));
    await render({ tree: { kind: "pane", sessionId: 1 } });
    expect(container.querySelector("select[aria-label='Switch pane']")).toBeNull();
    expect(pane(1).style.width).toBe("100%");
    expect(pane(1).style.display).toBe("");
    await render();
    expect(pane(1).style.width).toBe("35%");
    expect(pane(2).style.width).toBe("65%");
  });

  it("restores safely if a remote layout removes the maximized pane but leaves a split", async () => {
    await render();
    await click("Maximize pane", pane(2));
    await render({
      focused: 1,
      tree: { kind: "split", dir: "col", sizes: [0.4, 0.6],
        children: [{ kind: "pane", sessionId: 1 }, { kind: "pane", sessionId: 3 }] },
    });
    expect(container.querySelector("select[aria-label='Switch pane']")).toBeNull();
    expect(pane(1).style.height).toBe("40%");
    expect(pane(3).style.height).toBe("60%");
  });

  it("reveals new panes added through the menu or another window while maximized", async () => {
    await render();
    const terminal = pane(1).querySelector("textarea");
    await click("Maximize pane", pane(1));
    await render({ tree: {
      kind: "split", dir: "row", sizes: [0.35, 0.65],
      children: [{ kind: "pane", sessionId: 1 }, {
        kind: "split", dir: "col", sizes: [0.4, 0.6],
        children: [{ kind: "pane", sessionId: 2 }, { kind: "pane", sessionId: 3 }],
      }],
    } });
    expect(pane(1).style.width).toBe("35%");
    expect(pane(3).style.display).toBe("");
    expect(pane(1).querySelector("textarea")).toBe(terminal);
    expect(container.querySelector("select[aria-label='Switch pane']")).toBeNull();
  });

  it.each(["button", "shortcut"])("reveals the split when splitting a maximized pane via %s", async (source) => {
    await render();
    await click("Maximize pane", pane(2));
    if (source === "button") await click("Split right", pane(2));
    else await shortcut(window, "d");
    expect(actions.splitPane).toHaveBeenCalledWith(2, "row");
    expect(pane(1).style.display).toBe("");
    expect(container.querySelector("select[aria-label='Switch pane']")).toBeNull();
  });

  it("supports plugin and dead panes while preserving the actual plugin iframe", async () => {
    const states: Record<number, PaneSessionState> = {
      1: { status: "dead", exitCode: 1 },
      2: { status: "plugin", exitCode: null, pluginId: "showroom",
        pluginHealth: "up", pluginUrl: "http://127.0.0.1:7345" },
    };
    await render({ states });
    const frame = pane(2).querySelector("iframe");
    expect(frame).not.toBeNull();
    await click("Maximize pane", pane(2));
    expect(pane(2).style.width).toBe("100%");
    await click("Restore split view");
    await click("Maximize pane", pane(1));
    expect(pane(1).style.width).toBe("100%");
    expect(pane(2).querySelector("iframe")).toBe(frame);
    await click("Restore split view");
    expect(pane(2).querySelector("iframe")).toBe(frame);
    expect(actions.restartPane).not.toHaveBeenCalled();
  });

  it("keeps hidden siblings awake while their tab remains visible", async () => {
    vi.useFakeTimers();
    const sleep = new SleepController({ option: "5" });
    await render({ sleep });
    const terminal = pane(2).querySelector("textarea");
    await click("Maximize pane", pane(1));
    await act(async () => vi.advanceTimersByTime(30 * 60_000));
    expect([...sleep.getSnapshot()]).toEqual([]);
    expect(pane(2).querySelector("textarea")).toBe(terminal);
  });
});
