import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SplitNode } from "../../state/layout";
import type { PaneHostClient } from "../../terminal/TerminalPane";
import type { PaneSessionState } from "../../workspace/WorkspaceController";
import { SplitLayout, type SplitLayoutActions } from "../SplitLayout";

const terminalRender = vi.hoisted(() => vi.fn());

vi.mock("../../terminal/TerminalPane", () => ({
  TerminalPane: ({ sessionId }: { sessionId: number }) => {
    terminalRender(sessionId);
    return <div data-testid={`terminal-${sessionId}`} />;
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  terminalRender.mockClear();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

const ROW_TREE: SplitNode = {
  kind: "split",
  dir: "row",
  sizes: [0.5, 0.5],
  children: [
    { kind: "pane", sessionId: 1 },
    { kind: "pane", sessionId: 2 },
  ],
};

function paneStates(
  overrides: Record<number, PaneSessionState> = {},
): Record<number, PaneSessionState> {
  return {
    1: { status: "live", exitCode: null },
    2: { status: "live", exitCode: null },
    ...overrides,
  };
}

function actions(): SplitLayoutActions {
  return {
    splitPane: vi.fn(),
    closePane: vi.fn(async () => undefined),
    dismissPane: vi.fn(async () => undefined),
    restartPane: vi.fn(async () => undefined),
    resizePane: vi.fn(),
  };
}

interface RenderOptions {
  tree?: SplitNode;
  states?: Record<number, PaneSessionState>;
  focused?: number;
  dismissing?: ReadonlySet<number>;
  restarting?: ReadonlySet<number>;
  onFocusPane?: (sessionId: number) => void;
}

async function renderLayout(
  layoutActions = actions(),
  options: RenderOptions = {},
) {
  const client = {} as PaneHostClient;
  await act(async () =>
    root.render(
      <SplitLayout
        tabId="tab-1"
        root={options.tree ?? ROW_TREE}
        client={client}
        paneStates={options.states ?? paneStates()}
        focusedSessionId={options.focused ?? 1}
        dismissingSessionIds={options.dismissing ?? new Set()}
        restartingSessionIds={options.restarting ?? new Set()}
        onFocusPane={options.onFocusPane ?? (() => undefined)}
        actions={layoutActions}
      />,
    ),
  );
  return layoutActions;
}

function pointer(
  type: string,
  options: { x?: number; y?: number; button?: number; pointerId?: number; isPrimary?: boolean } = {},
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX: options.x ?? 0,
    clientY: options.y ?? 0,
    button: options.button ?? 0,
  });
  Object.defineProperties(event, {
    pointerId: { value: options.pointerId ?? 7 },
    isPrimary: { value: options.isPrimary ?? true },
  });
  return event;
}

function key(value: string, modifiers: Partial<KeyboardEventInit> = {}): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: value, bubbles: true, ...modifiers }),
  );
}

function mockContainerRect(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1000,
    bottom: 500,
    width: 1000,
    height: 500,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("SplitLayout rendering", () => {
  it("renders every live pane mounted at once with percentage boxes", async () => {
    await renderLayout();
    const first = container.querySelector<HTMLElement>("[data-testid='split-pane-1']");
    const second = container.querySelector<HTMLElement>("[data-testid='split-pane-2']");
    expect(first?.style.width).toBe("50%");
    expect(second?.style.left).toBe("50%");
    expect(terminalRender).toHaveBeenCalledWith(1);
    expect(terminalRender).toHaveBeenCalledWith(2);
    expect(container.querySelector("[data-testid='split-divider-root']")).not.toBeNull();
  });

  it("keeps existing terminals mounted when the tree gains a split", async () => {
    const layoutActions = actions();
    await renderLayout(layoutActions, { tree: { kind: "pane", sessionId: 1 } });
    const before = container.querySelector("[data-testid='terminal-1']");
    expect(before).not.toBeNull();
    await renderLayout(layoutActions, {
      states: paneStates(),
    });
    expect(container.querySelector("[data-testid='terminal-1']")).toBe(before);
  });

  it("marks the focused pane and reports focus from pointer interactions", async () => {
    const onFocusPane = vi.fn();
    await renderLayout(actions(), { focused: 2, onFocusPane });
    expect(
      container
        .querySelector("[data-testid='split-pane-2']")
        ?.classList.contains("split-pane--focused"),
    ).toBe(true);
    const first = container.querySelector("[data-testid='split-pane-1']")!;
    await act(async () => first.dispatchEvent(pointer("pointerdown")));
    expect(onFocusPane).toHaveBeenCalledWith(1);
  });

  it("renders a dead pane placeholder with exit detail and dismiss wiring", async () => {
    const layoutActions = await renderLayout(actions(), {
      states: paneStates({ 2: { status: "dead", exitCode: 3 } }),
    });
    const dead = container.querySelector("[data-testid='split-pane-2'] [data-testid='dead-pane']");
    expect(dead?.textContent).toContain("exited with code 3");
    const dismiss = container.querySelector<HTMLButtonElement>(".dead-pane__dismiss")!;
    await act(async () => dismiss.click());
    expect(layoutActions.dismissPane).toHaveBeenCalledWith(2);
  });

  it("offers restart and new-session on a dead pane, routed by mode", async () => {
    const layoutActions = await renderLayout(actions(), {
      states: paneStates({ 2: { status: "dead", exitCode: 3 } }),
    });
    const restart = container.querySelector<HTMLButtonElement>(".dead-pane__restart")!;
    await act(async () => restart.click());
    expect(layoutActions.restartPane).toHaveBeenCalledWith(2, "restart");
    const fresh = container.querySelector<HTMLButtonElement>(".dead-pane__new-session")!;
    await act(async () => fresh.click());
    expect(layoutActions.restartPane).toHaveBeenCalledWith(2, "fresh");
  });

  it("offers Resume conversation first when the pane's folder has one", async () => {
    const base = actions();
    const layoutActions = await renderLayout(
      { ...base, deadPaneResumeTitle: (sessionId) => (sessionId === 2 ? "Daemon work" : null) },
      { states: paneStates({ 2: { status: "dead", exitCode: 3 } }) },
    );
    const resume = container.querySelector<HTMLButtonElement>(".dead-pane__resume")!;
    expect(resume.textContent).toBe("Resume conversation");
    expect(resume.title).toBe("Daemon work");
    // Resume takes the primary style; the shell restart steps down to secondary.
    expect(resume.classList.contains("dead-pane__action--primary")).toBe(true);
    const restart = container.querySelector<HTMLButtonElement>(".dead-pane__restart")!;
    expect(restart.classList.contains("dead-pane__action--primary")).toBe(false);
    await act(async () => resume.click());
    expect(layoutActions.restartPane).toHaveBeenCalledWith(2, "resume");
  });

  it("draws no resume button when the folder has no conversation", async () => {
    await renderLayout(
      { ...actions(), deadPaneResumeTitle: () => null },
      { states: paneStates({ 2: { status: "dead", exitCode: 3 } }) },
    );
    expect(container.querySelector(".dead-pane__resume")).toBeNull();
    const restart = container.querySelector<HTMLButtonElement>(".dead-pane__restart")!;
    expect(restart.classList.contains("dead-pane__action--primary")).toBe(true);
  });

  it("disables every dead-pane action while a relaunch is in flight", async () => {
    await renderLayout(actions(), {
      states: paneStates({ 2: { status: "dead", exitCode: 3 } }),
      restarting: new Set([2]),
    });
    const buttons = container.querySelectorAll<HTMLButtonElement>(".dead-pane__action");
    expect(buttons.length).toBe(3);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
    }
    expect(container.querySelector(".dead-pane__restart")?.textContent).toBe("Restarting…");
  });

  it("disables split affordances for panes at the depth cap", async () => {
    // Pane 5 sits at path length 4 (depth cap); pane 1 at path length 1.
    const deep: SplitNode = {
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        { kind: "pane", sessionId: 1 },
        {
          kind: "split",
          dir: "col",
          sizes: [0.5, 0.5],
          children: [
            { kind: "pane", sessionId: 2 },
            {
              kind: "split",
              dir: "row",
              sizes: [0.5, 0.5],
              children: [
                { kind: "pane", sessionId: 3 },
                {
                  kind: "split",
                  dir: "col",
                  sizes: [0.5, 0.5],
                  children: [
                    { kind: "pane", sessionId: 4 },
                    { kind: "pane", sessionId: 5 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    await renderLayout(actions(), {
      tree: deep,
      states: {
        1: { status: "live", exitCode: null },
        2: { status: "live", exitCode: null },
        3: { status: "live", exitCode: null },
        4: { status: "live", exitCode: null },
        5: { status: "live", exitCode: null },
      },
    });
    const cappedSplit = container.querySelector<HTMLButtonElement>(
      "[data-testid='split-pane-5'] button[aria-label='Split right']",
    );
    const openSplit = container.querySelector<HTMLButtonElement>(
      "[data-testid='split-pane-1'] button[aria-label='Split right']",
    );
    expect(cappedSplit?.disabled).toBe(true);
    expect(openSplit?.disabled).toBe(false);
  });
});

describe("SplitLayout actions", () => {
  it("splits from the toolbar in both directions", async () => {
    const layoutActions = await renderLayout();
    const right = container.querySelector<HTMLButtonElement>(
      "[data-testid='split-pane-1'] button[aria-label='Split right']",
    )!;
    const down = container.querySelector<HTMLButtonElement>(
      "[data-testid='split-pane-1'] button[aria-label='Split down']",
    )!;
    await act(async () => right.click());
    await act(async () => down.click());
    expect(layoutActions.splitPane).toHaveBeenNthCalledWith(1, 1, "row");
    expect(layoutActions.splitPane).toHaveBeenNthCalledWith(2, 1, "col");
  });

  it("maps Ctrl+Shift+D/E/W onto the focused pane", async () => {
    const layoutActions = await renderLayout();
    await act(async () => key("d", { ctrlKey: true, shiftKey: true }));
    await act(async () => key("E", { ctrlKey: true, shiftKey: true }));
    expect(layoutActions.splitPane).toHaveBeenNthCalledWith(1, 1, "row");
    expect(layoutActions.splitPane).toHaveBeenNthCalledWith(2, 1, "col");

    await act(async () => key("w", { ctrlKey: true, shiftKey: true }));
    expect(container.querySelector(".split-dialog")).not.toBeNull();
  });

  it("requires the confirm dialog before closing a live pane", async () => {
    const layoutActions = await renderLayout();
    const close = container.querySelector<HTMLButtonElement>(
      "[data-testid='split-pane-1'] button[aria-label='Close pane']",
    )!;
    await act(async () => close.click());
    expect(layoutActions.closePane).not.toHaveBeenCalled();

    const cancel = container.querySelector<HTMLButtonElement>(
      ".split-dialog__actions button:not(.split-dialog__danger)",
    )!;
    await act(async () => cancel.click());
    expect(container.querySelector(".split-dialog")).toBeNull();
    expect(layoutActions.closePane).not.toHaveBeenCalled();

    await act(async () => close.click());
    const confirm = container.querySelector<HTMLButtonElement>(".split-dialog__danger")!;
    await act(async () => confirm.click());
    expect(layoutActions.closePane).toHaveBeenCalledWith(1);
    expect(container.querySelector(".split-dialog")).toBeNull();
  });

  it("dismisses a dead focused pane on Ctrl+Shift+W without a dialog", async () => {
    const layoutActions = await renderLayout(actions(), {
      states: paneStates({ 1: { status: "dead", exitCode: null } }),
      focused: 1,
    });
    await act(async () => key("w", { ctrlKey: true, shiftKey: true }));
    expect(container.querySelector(".split-dialog")).toBeNull();
    expect(layoutActions.dismissPane).toHaveBeenCalledWith(1);
  });

  it("ignores shortcuts while an editable field outside the terminal is focused", async () => {
    const layoutActions = await renderLayout();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await act(async () => key("w", { ctrlKey: true, shiftKey: true }));
    await act(async () => key("d", { ctrlKey: true, shiftKey: true }));
    expect(container.querySelector(".split-dialog")).toBeNull();
    expect(layoutActions.splitPane).not.toHaveBeenCalled();
    input.remove();
  });

  it("keeps shortcuts live from xterm's hidden textarea", async () => {
    const layoutActions = await renderLayout();
    const textarea = document.createElement("textarea");
    textarea.className = "xterm-helper-textarea";
    document.body.append(textarea);
    textarea.focus();
    await act(async () => key("d", { ctrlKey: true, shiftKey: true }));
    expect(layoutActions.splitPane).toHaveBeenCalledWith(1, "row");
    textarea.remove();
  });
});

describe("SplitLayout divider", () => {
  it("previews a drag locally and commits resize only on release", async () => {
    mockContainerRect();
    const layoutActions = await renderLayout();
    const divider = container.querySelector<HTMLElement>("[data-testid='split-divider-root']")!;

    await act(async () => divider.dispatchEvent(pointer("pointerdown", { x: 500 })));
    await act(async () => divider.dispatchEvent(pointer("pointermove", { x: 300 })));
    expect(layoutActions.resizePane).not.toHaveBeenCalled();
    expect(
      container.querySelector<HTMLElement>("[data-testid='split-pane-1']")?.style.width,
    ).toBe("30%");

    await act(async () => divider.dispatchEvent(pointer("pointerup", { x: 300 })));
    expect(layoutActions.resizePane).toHaveBeenCalledTimes(1);
    const [path, sizes] = vi.mocked(layoutActions.resizePane).mock.calls[0]!;
    expect(path).toEqual([]);
    expect(sizes[0]).toBeCloseTo(0.3);
    expect(sizes[1]).toBeCloseTo(0.7);
  });

  it("clamps the drag preview to the minimum pane fraction", async () => {
    mockContainerRect();
    const layoutActions = await renderLayout();
    const divider = container.querySelector<HTMLElement>("[data-testid='split-divider-root']")!;

    await act(async () => divider.dispatchEvent(pointer("pointerdown", { x: 500 })));
    await act(async () => divider.dispatchEvent(pointer("pointermove", { x: -400 })));
    await act(async () => divider.dispatchEvent(pointer("pointerup", { x: -400 })));

    const [, sizes] = vi.mocked(layoutActions.resizePane).mock.calls[0]!;
    expect(sizes[0]).toBeCloseTo(0.1);
  });

  it("cancels the drag on Escape, releasing pointer capture without committing", async () => {
    mockContainerRect();
    const layoutActions = await renderLayout();
    const divider = container.querySelector<HTMLElement>("[data-testid='split-divider-root']")!;

    await act(async () => divider.dispatchEvent(pointer("pointerdown", { x: 500 })));
    await act(async () => divider.dispatchEvent(pointer("pointermove", { x: 300 })));
    await act(async () => key("Escape"));
    expect(
      container.querySelector<HTMLElement>("[data-testid='split-pane-1']")?.style.width,
    ).toBe("50%");
    expect(divider.releasePointerCapture).toHaveBeenCalledWith(7);

    await act(async () => divider.dispatchEvent(pointer("pointerup", { x: 300 })));
    expect(layoutActions.resizePane).not.toHaveBeenCalled();
  });

  it("commits to the dragged split's NEW path after a mid-drag restructure", async () => {
    mockContainerRect();
    const layoutActions = actions();
    // root(row): pane 1 | s1(row): pane 2 | s2(row): pane 3, pane 4
    const s2: SplitNode = {
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        { kind: "pane", sessionId: 3 },
        { kind: "pane", sessionId: 4 },
      ],
    };
    const s1: SplitNode = {
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [{ kind: "pane", sessionId: 2 }, s2],
    };
    const tree: SplitNode = {
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [{ kind: "pane", sessionId: 1 }, s1],
    };
    const states = {
      1: { status: "live", exitCode: null },
      2: { status: "live", exitCode: null },
      3: { status: "live", exitCode: null },
      4: { status: "live", exitCode: null },
    } as const;
    await renderLayout(layoutActions, { tree, states });

    // Drag s1's divider (path [1]); s1 spans x 500..1000 so 800px -> 0.6.
    const divider = container.querySelector<HTMLElement>("[data-testid='split-divider-1']")!;
    await act(async () => divider.dispatchEvent(pointer("pointerdown", { x: 750 })));
    await act(async () => divider.dispatchEvent(pointer("pointermove", { x: 800 })));

    // Pane 1 closes mid-drag: s1 (same node reference) becomes the ROOT, and
    // the DOM element keyed "split-divider-1" now belongs to s2.
    await renderLayout(layoutActions, { tree: s1, states });
    const survivor = container.querySelector<HTMLElement>("[data-testid='split-divider-1']")!;
    await act(async () => survivor.dispatchEvent(pointer("pointerup", { x: 800 })));

    expect(layoutActions.resizePane).toHaveBeenCalledTimes(1);
    const [path, sizes] = vi.mocked(layoutActions.resizePane).mock.calls[0]!;
    expect(path).toEqual([]);
    expect(sizes[0]).toBeCloseTo(0.6);
  });

  it("discards the drag when the dragged split no longer exists at release", async () => {
    mockContainerRect();
    const layoutActions = actions();
    const s1: SplitNode = {
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        { kind: "pane", sessionId: 2 },
        { kind: "pane", sessionId: 3 },
      ],
    };
    const tree: SplitNode = {
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [{ kind: "pane", sessionId: 1 }, s1],
    };
    const states = {
      1: { status: "live", exitCode: null },
      2: { status: "live", exitCode: null },
      3: { status: "live", exitCode: null },
      9: { status: "live", exitCode: null },
      10: { status: "live", exitCode: null },
    } as const;
    await renderLayout(layoutActions, { tree, states });
    const divider = container.querySelector<HTMLElement>("[data-testid='split-divider-1']")!;
    await act(async () => divider.dispatchEvent(pointer("pointerdown", { x: 750 })));
    await act(async () => divider.dispatchEvent(pointer("pointermove", { x: 800 })));

    // A replacement tree keeps the same divider KEY at path [1] but with an
    // entirely new split node; the dragged node is gone.
    const replacement: SplitNode = {
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        { kind: "pane", sessionId: 1 },
        {
          kind: "split",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [
            { kind: "pane", sessionId: 9 },
            { kind: "pane", sessionId: 10 },
          ],
        },
      ],
    };
    await renderLayout(layoutActions, { tree: replacement, states });
    const survivor = container.querySelector<HTMLElement>("[data-testid='split-divider-1']")!;
    await act(async () => survivor.dispatchEvent(pointer("pointerup", { x: 800 })));

    expect(layoutActions.resizePane).not.toHaveBeenCalled();
  });

  it("ignores secondary buttons and non-primary pointers", async () => {
    mockContainerRect();
    const layoutActions = await renderLayout();
    const divider = container.querySelector<HTMLElement>("[data-testid='split-divider-root']")!;

    await act(async () => divider.dispatchEvent(pointer("pointerdown", { x: 500, button: 2 })));
    await act(async () => divider.dispatchEvent(pointer("pointermove", { x: 300 })));
    await act(async () => divider.dispatchEvent(pointer("pointerup", { x: 300 })));
    await act(async () => divider.dispatchEvent(pointer("pointerdown", { x: 500, isPrimary: false })));
    await act(async () => divider.dispatchEvent(pointer("pointerup", { x: 300 })));
    expect(layoutActions.resizePane).not.toHaveBeenCalled();
  });

  it("nudges the split with arrow keys as an accessible resize", async () => {
    const layoutActions = await renderLayout();
    const divider = container.querySelector<HTMLElement>("[data-testid='split-divider-root']")!;
    divider.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(layoutActions.resizePane).toHaveBeenCalledTimes(1);
    const [, sizes] = vi.mocked(layoutActions.resizePane).mock.calls[0]!;
    expect(sizes[0]).toBeCloseTo(0.52);
  });
});
