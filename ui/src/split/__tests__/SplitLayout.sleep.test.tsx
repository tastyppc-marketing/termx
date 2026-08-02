import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SplitNode } from "../../state/layout";
import { SleepController } from "../../terminal/sleep";
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

const MINUTE = 60_000;

const ROW_TREE: SplitNode = {
  kind: "split",
  dir: "row",
  sizes: [0.5, 0.5],
  children: [
    { kind: "pane", sessionId: 1 },
    { kind: "pane", sessionId: 2 },
  ],
};

const PANE_STATES: Record<number, PaneSessionState> = {
  1: { status: "live", exitCode: null },
  2: { status: "live", exitCode: null },
};

let container: HTMLDivElement;
let root: Root;

function actions(): SplitLayoutActions {
  return {
    splitPane: vi.fn(),
    closePane: vi.fn(async () => undefined),
    dismissPane: vi.fn(async () => undefined),
    restartPane: vi.fn(async () => undefined),
    resizePane: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  terminalRender.mockClear();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

interface RenderOptions {
  visible?: boolean;
  sleep?: SleepController | null;
  layoutActions?: SplitLayoutActions;
}

async function renderLayout(options: RenderOptions = {}) {
  await act(async () => {
    root.render(
      <SplitLayout
        tabId="tab-1"
        root={ROW_TREE}
        client={{} as PaneHostClient}
        paneStates={PANE_STATES}
        focusedSessionId={1}
        dismissingSessionIds={new Set()}
        onFocusPane={() => undefined}
        actions={options.layoutActions ?? actions()}
        visible={options.visible ?? true}
        sleep={options.sleep ?? null}
      />,
    );
  });
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

function present(testId: string): boolean {
  return container.querySelector(`[data-testid='${testId}']`) !== null;
}

describe("SplitLayout terminal sleep", () => {
  it("swaps a hidden pane for the placeholder once the idle threshold passes", async () => {
    const sleep = new SleepController({ option: "15" });
    const layoutActions = actions();
    await renderLayout({ sleep, visible: false, layoutActions });

    expect(present("terminal-1")).toBe(true);
    await advance(15 * MINUTE - 1_000);
    expect(present("terminal-1")).toBe(true);

    await advance(1_000);

    expect(present("terminal-1")).toBe(false);
    expect(present("terminal-2")).toBe(false);
    expect(present("sleeping-pane-1")).toBe(true);
    expect(present("sleeping-pane-2")).toBe(true);
    // The panes themselves survive: sleep releases the renderer, never the
    // session. Nothing that could end a session was invoked.
    expect(present("split-pane-1")).toBe(true);
    expect(present("split-pane-2")).toBe(true);
    expect(layoutActions.closePane).not.toHaveBeenCalled();
    expect(layoutActions.dismissPane).not.toHaveBeenCalled();
  });

  it("never sleeps a visible layout", async () => {
    const sleep = new SleepController({ option: "5" });
    await renderLayout({ sleep, visible: true });

    await advance(60 * MINUTE);

    expect(present("terminal-1")).toBe(true);
    expect(present("sleeping-pane-1")).toBe(false);
    expect([...sleep.getSnapshot()]).toEqual([]);
  });

  it("never sleeps while the setting is off", async () => {
    const sleep = new SleepController({ option: "off" });
    await renderLayout({ sleep, visible: false });

    await advance(120 * MINUTE);

    expect(present("terminal-1")).toBe(true);
    expect(present("sleeping-pane-1")).toBe(false);
  });

  it("never sleeps when no sleep controller is supplied", async () => {
    await renderLayout({ visible: false });

    await advance(120 * MINUTE);

    expect(present("terminal-1")).toBe(true);
    expect(present("sleeping-pane-1")).toBe(false);
  });

  it("remounts the terminal when the tab is revealed", async () => {
    const sleep = new SleepController({ option: "15" });
    const layoutActions = actions();
    await renderLayout({ sleep, visible: false, layoutActions });
    await advance(15 * MINUTE);
    expect(present("sleeping-pane-1")).toBe(true);
    terminalRender.mockClear();

    await renderLayout({ sleep, visible: true, layoutActions });

    expect(present("terminal-1")).toBe(true);
    expect(present("terminal-2")).toBe(true);
    expect(present("sleeping-pane-1")).toBe(false);
    // A fresh mount is what runs the normal attach + replay restore.
    expect(terminalRender).toHaveBeenCalledWith(1);
    expect(terminalRender).toHaveBeenCalledWith(2);
    // Sleeping and waking must never touch the session itself.
    expect(layoutActions.closePane).not.toHaveBeenCalled();
    expect(layoutActions.dismissPane).not.toHaveBeenCalled();
    expect(layoutActions.splitPane).not.toHaveBeenCalled();
  });

  it("wakes only the clicked pane and lets it sleep again after a full idle period", async () => {
    const sleep = new SleepController({ option: "5" });
    await renderLayout({ sleep, visible: false });
    await advance(5 * MINUTE);
    expect(present("sleeping-pane-1")).toBe(true);

    const placeholder = container.querySelector<HTMLButtonElement>(
      "[data-testid='sleeping-pane-1']",
    );
    await act(async () => {
      placeholder?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(present("terminal-1")).toBe(true);
    expect(present("sleeping-pane-2")).toBe(true);

    await advance(5 * MINUTE);

    expect(present("sleeping-pane-1")).toBe(true);
  });

  it("releases its panes from the shared sleep state when it unmounts", async () => {
    const sleep = new SleepController({ option: "5" });
    await renderLayout({ sleep, visible: false });
    await advance(5 * MINUTE);
    expect([...sleep.getSnapshot()].sort()).toEqual([1, 2]);

    await act(async () => root.unmount());

    expect([...sleep.getSnapshot()]).toEqual([]);
  });
});
