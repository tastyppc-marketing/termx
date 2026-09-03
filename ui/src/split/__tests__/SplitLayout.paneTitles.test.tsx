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

async function renderWith(
  paneTitles?: Record<number, string>,
  extra: {
    onRenamePane?: (sessionId: number, name: string) => void;
    actions?: SplitLayoutActions;
  } = {},
) {
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
        actions={extra.actions ?? layoutActions()}
        {...(paneTitles ? { paneTitles } : {})}
        {...(extra.onRenamePane ? { onRenamePane: extra.onRenamePane } : {})}
      />,
    ),
  );
}

/// The rename input a pane header becomes, or null while it is still a label.
function editorFor(sessionId: number): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(
    `[data-testid='split-pane-rename-${sessionId}'] input`,
  );
}

async function doubleClickTitle(sessionId: number): Promise<void> {
  const title = container.querySelector(`[data-testid='split-pane-title-${sessionId}']`);
  await act(async () => {
    title?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
}

async function pressKey(target: EventTarget, init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
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

/**
 * Naming a terminal by hand (Michael: "I want to change the terminal name").
 *
 * Double-click, not F2: F2 inside a terminal belongs to whatever TUI is
 * running in it, and stealing it would break `less`, `htop` and every file
 * manager for a rename nobody asked to reach that way.
 */
describe("renaming a pane from its title bar", () => {
  it("turns the title into an editor on double-click, holding the current name", async () => {
    await renderWith({ 1: "powershell \u00b7 project", 2: "ssh \u00b7 myvps" },
      { onRenamePane: () => undefined });

    await doubleClickTitle(1);

    expect(editorFor(1)?.value).toBe("powershell \u00b7 project");
    // Only the pane that was asked; its sibling is still a label.
    expect(editorFor(2)).toBeNull();
    expect(container.querySelector("[data-testid='split-pane-title-2']")).not.toBeNull();
  });

  it("commits the typed name to the caller and goes back to a label", async () => {
    const onRenamePane = vi.fn();
    await renderWith({ 1: "powershell \u00b7 project" }, { onRenamePane });
    await doubleClickTitle(1);

    const input = editorFor(1)!;
    input.value = "Build";
    await pressKey(input, { key: "Enter" });

    expect(onRenamePane).toHaveBeenCalledWith(1, "Build");
    expect(editorFor(1)).toBeNull();
  });

  it("cancels on Escape without renaming anything", async () => {
    const onRenamePane = vi.fn();
    await renderWith({ 1: "powershell \u00b7 project" }, { onRenamePane });
    await doubleClickTitle(1);

    const input = editorFor(1)!;
    input.value = "Build";
    await pressKey(input, { key: "Escape" });

    expect(onRenamePane).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='split-pane-title-1']")?.textContent)
      .toBe("powershell \u00b7 project");
  });

  it("claims Escape so it does not close a menu or a flyout behind it", async () => {
    // The `data-esc-guard` convention: an open editor owns the press, and the
    // menubar, the settings surface and the sidebar all stand off when the
    // focused element sits inside one.
    await renderWith({ 1: "powershell \u00b7 project" }, { onRenamePane: () => undefined });

    await doubleClickTitle(1);

    const input = editorFor(1);
    expect(input).not.toBeNull();
    expect(input!.closest("[data-esc-guard]")).not.toBeNull();
  });

  it("keeps the pane's own shortcuts out of the editor", async () => {
    // Ctrl+Shift+D from a rename field would split the pane behind the input
    // and blur-commit the half-typed name with it.
    const actions = layoutActions();
    await renderWith({ 1: "powershell \u00b7 project" },
      { onRenamePane: () => undefined, actions });
    await doubleClickTitle(1);
    editorFor(1)!.focus();

    await pressKey(window, { key: "d", ctrlKey: true, shiftKey: true });

    expect(actions.splitPane).not.toHaveBeenCalled();
  });

  it("still splits from the same shortcut when nothing is being renamed", async () => {
    // The control for the test above: without it, a guard that swallowed
    // everything would look identical to a guard that works.
    const actions = layoutActions();
    await renderWith({ 1: "powershell \u00b7 project" },
      { onRenamePane: () => undefined, actions });

    await pressKey(window, { key: "d", ctrlKey: true, shiftKey: true });

    expect(actions.splitPane).toHaveBeenCalledWith(1, "row");
  });

  it("stays a plain label when no rename handler is wired", async () => {
    // Every legacy caller, and the plugin panes that have no name to change.
    await renderWith({ 1: "powershell \u00b7 project" });

    await doubleClickTitle(1);

    expect(editorFor(1)).toBeNull();
  });
});
