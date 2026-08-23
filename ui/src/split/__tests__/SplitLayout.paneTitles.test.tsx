/**
 * Pane title bars (Michael, 2026-08-22): "I would like to have a title bar on
 * each pane, to help differentiate between them if it's not immediately clear
 * by looking at it."
 *
 * Panes in a split all sit under ONE tab title, so the tab cannot say which is
 * which. Each pane names itself instead — and a pane with no title supplied
 * draws no bar at all, so the terminal never loses rows for an empty label.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SplitNode } from "../../state/layout";
import type { PaneHostClient } from "../../terminal/TerminalPane";
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

function layoutActions(): SplitLayoutActions {
  return {
    splitPane: vi.fn(),
    closePane: vi.fn(async () => undefined),
    dismissPane: vi.fn(async () => undefined),
    restartPane: vi.fn(async () => undefined),
    resizePane: vi.fn(),
  };
}

async function renderWith(paneTitles?: Record<number, string>) {
  await act(async () =>
    root.render(
      <SplitLayout
        tabId="tab-1"
        root={ROW_TREE}
        client={{} as PaneHostClient}
        paneStates={{
          1: { status: "live", exitCode: null },
          2: { status: "live", exitCode: null },
        }}
        focusedSessionId={1}
        dismissingSessionIds={new Set()}
        onFocusPane={() => undefined}
        actions={layoutActions()}
        {...(paneTitles ? { paneTitles } : {})}
      />,
    ),
  );
}

describe("pane title bars", () => {
  it("names each pane by what it is, so a split is never ambiguous", async () => {
    await renderWith({ 1: "powershell · TermX", 2: "ssh · myvps" });

    const first = container.querySelector("[data-testid='split-pane-title-1']");
    const second = container.querySelector("[data-testid='split-pane-title-2']");
    expect(first?.textContent).toBe("powershell · TermX");
    expect(second?.textContent).toBe("ssh · myvps");
    // The full name is available on hover when the bar has to ellipsize.
    expect(first?.getAttribute("title")).toBe("powershell · TermX");
  });

  it("draws no bar for a pane with no title, rather than an empty strip", async () => {
    await renderWith({ 1: "powershell · TermX" });

    expect(container.querySelector("[data-testid='split-pane-title-1']")).not.toBeNull();
    expect(container.querySelector("[data-testid='split-pane-title-2']")).toBeNull();
  });
});
