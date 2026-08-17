import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SplitNode } from "../../state/layout";
import type { PaneHostClient } from "../../terminal/TerminalPane";
import type { PaneSessionState } from "../../workspace/WorkspaceController";
import { SplitLayout, type SplitLayoutActions } from "../SplitLayout";

vi.mock("../../terminal/TerminalPane", () => ({
  TerminalPane: ({ sessionId }: { sessionId: number }) => (
    <div data-testid={`terminal-${sessionId}`} />
  ),
}));

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

function actions(overrides: Partial<SplitLayoutActions> = {}): SplitLayoutActions {
  return {
    splitPane: vi.fn(),
    closePane: vi.fn(async () => undefined),
    dismissPane: vi.fn(async () => undefined),
    restartPane: vi.fn(async () => undefined),
    resizePane: vi.fn(),
    ...overrides,
  };
}

async function renderLayout(
  layoutActions: SplitLayoutActions,
  states?: Record<number, PaneSessionState>,
) {
  await act(async () =>
    root.render(
      <SplitLayout
        tabId="tab-1"
        root={ROW_TREE}
        client={{} as PaneHostClient}
        paneStates={
          states ?? {
            1: { status: "live", exitCode: null },
            2: { status: "live", exitCode: null },
          }
        }
        focusedSessionId={1}
        dismissingSessionIds={new Set()}
        onFocusPane={() => undefined}
        actions={layoutActions}
      />,
    ),
  );
  return layoutActions;
}

function saveButtons(): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>("[data-testid='pane-save']"),
  );
}

describe("SplitLayout pane save button", () => {
  it("renders no save button without the callback", async () => {
    await renderLayout(actions());
    expect(saveButtons()).toHaveLength(0);
    // The rest of the toolbar is untouched.
    expect(
      container.querySelectorAll("[data-testid='split-pane-1'] .split-pane__toolbar button"),
    ).toHaveLength(3);
  });

  it("renders one save button per live pane when the callback is given", async () => {
    await renderLayout(actions({ savePane: vi.fn() }));
    expect(saveButtons()).toHaveLength(2);

    const button = container.querySelector<HTMLButtonElement>(
      "[data-testid='split-pane-1'] [data-testid='pane-save']",
    )!;
    expect(button.title).toBe("Save this session…");
    expect(button.getAttribute("aria-label")).toBe("Save this session");
    expect(button.closest(".split-pane__toolbar")).not.toBeNull();
  });

  it("fires the callback with that pane's session id", async () => {
    const savePane = vi.fn();
    await renderLayout(actions({ savePane }));

    const second = container.querySelector<HTMLButtonElement>(
      "[data-testid='split-pane-2'] [data-testid='pane-save']",
    )!;
    await act(async () => second.click());
    expect(savePane).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("leaves the split and close actions working alongside it", async () => {
    const layoutActions = await renderLayout(actions({ savePane: vi.fn() }));
    const split = container.querySelector<HTMLButtonElement>(
      "[data-testid='split-pane-1'] button[aria-label='Split right']",
    )!;
    await act(async () => split.click());
    expect(layoutActions.splitPane).toHaveBeenCalledWith(1, "row");

    const close = container.querySelector<HTMLButtonElement>(
      "[data-testid='split-pane-1'] button[aria-label='Close pane']",
    )!;
    await act(async () => close.click());
    expect(container.querySelector(".split-dialog")).not.toBeNull();
  });

  it("offers nothing to save on a dead pane", async () => {
    await renderLayout(actions({ savePane: vi.fn() }), {
      1: { status: "dead", exitCode: 1 },
      2: { status: "live", exitCode: null },
    });
    expect(
      container.querySelector("[data-testid='split-pane-1'] [data-testid='pane-save']"),
    ).toBeNull();
    expect(saveButtons()).toHaveLength(1);
  });
});
