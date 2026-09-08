import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SplitNode } from "../../state/layout";
import { SleepController } from "../../terminal/sleep";
import type { PaneHostClient } from "../../terminal/TerminalPane";
import type { PaneActivityModel } from "../../workspace/paneActivity";
import type { PaneSessionState } from "../../workspace/WorkspaceController";
import { SplitLayout, type SplitLayoutActions } from "../SplitLayout";

// xterm requires canvas/PTY access. Keep its editable DOM boundary so a
// remount or misplaced focus loses real input state and fails these tests.
vi.mock("../../terminal/TerminalPane", () => ({
  TerminalPane: ({ sessionId }: { sessionId: number }) => (
    <div className="terminal-pane">
      <textarea className="xterm-helper-textarea" aria-label={`Terminal ${sessionId}`} />
    </div>
  ),
}));

const TREE: SplitNode = {
  kind: "split", dir: "row", sizes: [0.35, 0.65],
  children: [{ kind: "pane", sessionId: 1 }, {
    kind: "split", dir: "col", sizes: [0.4, 0.6],
    children: [{ kind: "pane", sessionId: 2 }, { kind: "pane", sessionId: 3 }],
  }],
};
const LIVE: Record<number, PaneSessionState> = {
  1: { status: "live", exitCode: null },
  2: { status: "live", exitCode: null },
  3: { status: "live", exitCode: null },
};
let container: HTMLDivElement;
let root: Root;
let actions: SplitLayoutActions;
const visibility = vi.fn();

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
  visibility.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

interface Options {
  tree?: SplitNode;
  states?: Record<number, PaneSessionState>;
  focused?: number;
  visible?: boolean;
  tabId?: string;
  activity?: Record<number, PaneActivityModel>;
  sleep?: SleepController;
}

function Harness(options: Options) {
  const [focused, setFocused] = useState(1);
  return (
    <SplitLayout
      tabId={options.tabId ?? "tab-1"} root={options.tree ?? TREE}
      client={{} as PaneHostClient} paneStates={options.states ?? LIVE}
      focusedSessionId={options.focused ?? focused} onFocusPane={setFocused}
      dismissingSessionIds={new Set()} actions={actions}
      paneTitles={{ 1: "API", 2: "Web", 3: "Logs" }}
      visible={options.visible ?? true} sleep={options.sleep ?? null}
      paneActivity={options.activity} onVisiblePanesChange={visibility}
    />
  );
}

async function render(options: Options = {}) {
  await act(async () => root.render(<Harness {...options} />));
}

function pane(id: number, within: ParentNode = container): HTMLElement {
  return within.querySelector<HTMLElement>(`[data-testid='split-pane-${id}']`)!;
}

function button(label: string, within: ParentNode = container): HTMLButtonElement {
  const found = within.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`);
  expect(found, `button ${label} exists`).not.toBeNull();
  return found!;
}

async function click(label: string, within: ParentNode = container) {
  await act(async () => button(label, within).click());
}

function chip(id: number, within: ParentNode = container): HTMLButtonElement {
  const found = within.querySelector<HTMLButtonElement>(`[data-testid='restore-pane-${id}']`);
  expect(found, `restore chip ${id} exists`).not.toBeNull();
  return found!;
}

async function restore(id: number) {
  await act(async () => chip(id).click());
}

function pointer(type: string, y: number): Event {
  const event = new MouseEvent(type, { bubbles: true, clientY: y, button: 0 });
  Object.defineProperties(event, {
    pointerId: { value: 7 }, isPrimary: { value: true },
  });
  return event;
}

describe("minimized pane shelf", () => {
  it("fills the remaining split, keeps terminal input mounted, and restores the saved position", async () => {
    await render();
    const original = structuredClone(TREE);
    const section = pane(1);
    const terminal = section.querySelector("textarea")!;
    terminal.value = "unfinished input";
    await click("Minimize pane", section);

    expect(section.getAttribute("aria-hidden")).toBe("true");
    expect(section.hasAttribute("inert")).toBe(true);
    expect(section.style.visibility).toBe("hidden");
    expect(section.querySelector("textarea")).toBe(terminal);
    expect(pane(2).style.width).toBe("100%");
    expect(pane(2).style.height).toBe("40%");
    expect(pane(3).style.top).toBe("40%");
    expect(document.activeElement).toBe(pane(2).querySelector("textarea"));
    expect(chip(1).textContent).toContain("API");
    expect(visibility).toHaveBeenLastCalledWith([2, 3]);

    await restore(1);
    expect(pane(1)).toBe(section);
    expect(section.querySelector("textarea")).toBe(terminal);
    expect(terminal.value).toBe("unfinished input");
    expect(section.style.width).toBe("35%");
    expect(pane(2).style.left).toBe("35%");
    expect(section.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(terminal);
    expect(container.querySelector("[aria-label='Minimized panes']")).toBeNull();
    expect(visibility).toHaveBeenLastCalledWith([1, 2, 3]);
    expect(TREE).toEqual(original);
    expect(actions.resizePane).not.toHaveBeenCalled();
    expect(actions.closePane).not.toHaveBeenCalled();
  });

  it("freezes a minimized pane's measured dimensions when the shelf and visible geometry change", async () => {
    await render();
    vi.spyOn(pane(1), "getBoundingClientRect").mockReturnValue({
      width: 350, height: 500, left: 0, top: 0,
    } as DOMRect);
    await click("Minimize pane", pane(1));
    expect(pane(1).style.width).toBe("350px");
    expect(pane(1).style.height).toBe("500px");
    await click("Minimize pane", pane(2));
    expect(pane(1).style.width).toBe("350px");
    expect(pane(1).style.height).toBe("500px");
    expect(pane(3).style.width).toBe("100%");
    expect(pane(3).style.height).toBe("100%");
  });

  it("protects the last unminimized pane and reveals a survivor when the visible pane is removed", async () => {
    await render();
    await click("Minimize pane", pane(1));
    await click("Minimize pane", pane(2));
    expect(button("Minimize pane", pane(3)).disabled).toBe(true);
    await click("Minimize pane", pane(3));
    expect(visibility).toHaveBeenLastCalledWith([3]);
    await render({ tree: {
      kind: "split", dir: "row", sizes: [0.5, 0.5],
      children: [{ kind: "pane", sessionId: 1 }, { kind: "pane", sessionId: 2 }],
    } });
    expect(pane(1).hasAttribute("inert")).toBe(false);
    expect(pane(1).style.width).toBe("100%");
    expect(visibility).toHaveBeenLastCalledWith([1]);
    expect(chip(2)).not.toBeNull();
  });

  it("keeps each mounted tab's shelf independent and reports no visible panes for a hidden tab", async () => {
    const renderTabs = async (secondVisible: boolean) => act(async () => root.render(<>
      <Harness tabId="first" visible={!secondVisible} />
      <Harness tabId="second" visible={secondVisible} />
    </>));
    await renderTabs(false);
    const first = container.querySelector("[data-testid='split-layout-first']")!;
    const second = container.querySelector("[data-testid='split-layout-second']")!;
    await click("Minimize pane", pane(1, first));
    expect(chip(1, first)).not.toBeNull();
    expect(second.querySelector("[aria-label='Minimized panes']")).toBeNull();
    await renderTabs(true);
    expect(chip(1, first)).not.toBeNull();
    expect(pane(1, second).hasAttribute("inert")).toBe(false);
    expect(visibility.mock.calls.some(([ids]) => ids.length === 0)).toBe(true);
    await renderTabs(false);
    expect(chip(1, first)).not.toBeNull();
    expect(pane(2, first).style.width).toBe("100%");
  });

  it("restores only the requested survivor when tree order differs from session ID order", async () => {
    await render({ tree: {
      kind:"split",dir:"row",sizes:[0.5,0.5],children:[{kind:"pane",sessionId:2},{
        kind:"split",dir:"col",sizes:[0.5,0.5],children:[{kind:"pane",sessionId:1},{kind:"pane",sessionId:3}],
      }],
    } });
    await click("Minimize pane",pane(2)); await click("Minimize pane",pane(1));
    visibility.mockClear();
    await render({ focused:2,tree:{kind:"split",dir:"row",sizes:[0.5,0.5],children:[
      {kind:"pane",sessionId:2},{kind:"pane",sessionId:1},
    ]} });
    expect(pane(1).hasAttribute("inert")).toBe(true);
    expect(chip(1)).not.toBeNull();
    expect(visibility.mock.calls.every(([ids])=>!ids.includes(1))).toBe(true);
    expect(visibility).toHaveBeenLastCalledWith([2]);
  });

  it("updates a minimized pane's finished indicator without revealing or focusing it", async () => {
    await render({ activity: { 1: { activity: "active", attentionSince: null } } });
    await click("Minimize pane", pane(1));
    expect(chip(1).getAttribute("aria-label")).toContain("Terminal active");
    await render({ activity: { 1: { activity: "attention", attentionSince: 1_700_000_000_000 } } });
    expect(chip(1).querySelector("[data-activity='attention']")).not.toBeNull();
    expect(chip(1).getAttribute("aria-label")).toContain("Finished");
    expect(chip(1).textContent).toContain("Finished");
    expect(pane(1).hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(pane(2).querySelector("textarea"));
    expect(visibility).toHaveBeenLastCalledWith([2, 3]);
  });

  it("retains minimized panes across maximize, then restores a shelf selection into the maximized view", async () => {
    await render();
    await click("Minimize pane", pane(1));
    await click("Maximize pane", pane(2));
    expect(visibility).toHaveBeenLastCalledWith([2]);
    expect(chip(1)).not.toBeNull();
    await restore(1);
    expect(pane(1).style.width).toBe("100%");
    expect(pane(1).hasAttribute("inert")).toBe(false);
    expect(visibility).toHaveBeenLastCalledWith([1]);
    await click("Restore split view");
    expect(pane(1).style.width).toBe("35%");
    expect(visibility).toHaveBeenLastCalledWith([1, 2, 3]);
  });

  it("can minimize a maximized pane and continue in the remaining split", async () => {
    await render();
    await click("Maximize pane", pane(1));
    await click("Minimize pane", pane(1));
    expect(container.querySelector("select[aria-label='Switch pane']")).toBeNull();
    expect(pane(2).style.width).toBe("100%");
    expect(pane(3).style.width).toBe("100%");
    expect(document.activeElement).toBe(pane(2).querySelector("textarea"));
    expect(visibility).toHaveBeenLastCalledWith([2, 3]);
  });

  it("reveals and focuses a minimized pane selected externally", async () => {
    await render();
    await click("Minimize pane", pane(1));
    await render({ focused: 1 });
    expect(pane(1).hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(pane(1).querySelector("textarea"));
    expect(container.querySelector("[data-testid='restore-pane-1']")).toBeNull();
    expect(visibility).toHaveBeenLastCalledWith([1, 2, 3]);
  });

  it("ignores focus events from minimized content until the pane is explicitly restored", async () => {
    await render();
    await click("Minimize pane", pane(1));
    await act(async () => pane(1).querySelector("textarea")!.dispatchEvent(
      new FocusEvent("focusin", { bubbles: true }),
    ));
    expect(pane(1).hasAttribute("inert")).toBe(true);
    expect(pane(2).classList.contains("split-pane--focused")).toBe(true);
    expect(visibility).toHaveBeenLastCalledWith([2, 3]);
  });

  it("cancels a projected divider drag when external focus restores a hidden branch", async () => {
    await render();
    await click("Minimize pane", pane(1));
    const divider = container.querySelector<HTMLElement>("[data-testid='split-divider-1']")!;
    await act(async () => divider.dispatchEvent(pointer("pointerdown", 200)));
    await render({ focused: 1 });
    await act(async () => divider.dispatchEvent(pointer("pointerup", 300)));
    expect(pane(1).hasAttribute("inert")).toBe(false);
    expect(actions.resizePane).not.toHaveBeenCalled();
  });

  it("reveals a minimized pane chosen from the maximized pane picker", async () => {
    await render();
    await click("Minimize pane", pane(1));
    await click("Maximize pane", pane(2));
    const picker = container.querySelector<HTMLSelectElement>("select[aria-label='Switch pane']")!;
    await act(async () => {
      picker.value = "1";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(pane(1).hasAttribute("inert")).toBe(false);
    expect(pane(1).style.width).toBe("100%");
    expect(container.querySelector("[data-testid='restore-pane-1']")).toBeNull();
    expect(document.activeElement).toBe(pane(1).querySelector("textarea"));
    expect(visibility).toHaveBeenLastCalledWith([1]);
  });

  it("discards removed minimized IDs so a later pane with that ID is visible", async () => {
    await render();
    await click("Minimize pane", pane(1));
    await render({ tree: TREE.kind === "split" ? TREE.children[1] : TREE });
    expect(container.querySelector("[data-testid='restore-pane-1']")).toBeNull();
    await render();
    expect(pane(1).hasAttribute("inert")).toBe(false);
    expect(pane(1).style.width).toBe("35%");
  });

  it("resizes the original nested split path after projection for keys and pointer drags", async () => {
    await render();
    await click("Minimize pane", pane(1));
    const divider = container.querySelector<HTMLElement>("[data-testid='split-divider-1']")!;
    expect(container.querySelector("[data-testid='split-divider-root']")).toBeNull();
    await act(async () => divider.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowDown", bubbles: true,
    })));
    expect(actions.resizePane).toHaveBeenLastCalledWith([1], [0.42000000000000004, 0.58]);
    vi.spyOn(container.querySelector<HTMLElement>(".split-layout__panes")!, "getBoundingClientRect")
      .mockReturnValue({ left: 0, top: 0, width: 1000, height: 500 } as DOMRect);
    await act(async () => {
      divider.dispatchEvent(pointer("pointerdown", 200));
      divider.dispatchEvent(pointer("pointermove", 350));
    });
    expect(pane(2).style.height).toBe("70%");
    await act(async () => divider.dispatchEvent(pointer("pointerup", 350)));
    expect(actions.resizePane).toHaveBeenLastCalledWith([1], [0.7, 0.30000000000000004]);
  });

  it("keeps the actual plugin iframe mounted and lets dead panes minimize", async () => {
    await render({ states: {
      ...LIVE, 1: { status: "plugin", exitCode: null, pluginId: "showroom",
        pluginHealth: "up", pluginUrl: "http://127.0.0.1:7345" },
      2: { status: "dead", exitCode: 1 },
    } });
    const frame = pane(1).querySelector("iframe");
    expect(frame).not.toBeNull();
    await click("Minimize pane", pane(1));
    await click("Minimize pane", pane(2));
    expect(pane(1).querySelector("iframe")).toBe(frame);
    expect(chip(1).textContent).toContain("showroom");
    await restore(1);
    expect(pane(1).querySelector("iframe")).toBe(frame);
    expect(document.activeElement).toBe(frame);
    expect(actions.restartPane).not.toHaveBeenCalled();
  });

  it("keeps minimized terminals awake while the tab is visible", async () => {
    vi.useFakeTimers();
    const sleep = new SleepController({ option: "5" });
    await render({ sleep });
    const terminal = pane(1).querySelector("textarea");
    await click("Minimize pane", pane(1));
    await act(async () => vi.advanceTimersByTime(30 * 60_000));
    expect([...sleep.getSnapshot()]).toEqual([]);
    expect(pane(1).querySelector("textarea")).toBe(terminal);
  });
});
