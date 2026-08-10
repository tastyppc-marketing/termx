import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutV2 } from "../state/layout";
import type {
  SidebarTabModel,
  WorkspaceSnapshot,
} from "../workspace/WorkspaceController";
import type { BootstrappedWorkspace } from "../workspace/bootstrapWorkspace";

const terminalRender = vi.hoisted(() => vi.fn());

vi.mock("../sidebar/Sidebar", () => ({
  Sidebar: ({
    snapshot,
    onOpenSettings,
  }: {
    snapshot: WorkspaceSnapshot;
    onOpenSettings?: () => void;
  }) => (
    <div data-active-tab={snapshot.activeTabId ?? ""} data-testid="workspace-sidebar">
      <button
        type="button"
        data-testid="sidebar-open-settings"
        onClick={onOpenSettings}
      />
    </div>
  ),
}));
vi.mock("../terminal/TerminalPane", () => ({
  TerminalPane: ({ client, sessionId }: { client: unknown; sessionId: number }) => {
    terminalRender({ client, sessionId });
    return <div data-session-id={sessionId} data-testid="workspace-terminal" />;
  },
}));

import App from "../App";

interface ControllerHarness {
  workspace: BootstrappedWorkspace;
  setSnapshot(snapshot: WorkspaceSnapshot): void;
  emit(): void;
  order: string[];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function tab(overrides: Partial<SidebarTabModel> = {}): SidebarTabModel {
  return {
    id: "tab-1",
    groupId: null,
    title: "PowerShell · project",
    color: "blue",
    fill: "off",
    primarySessionId: 1,
    sessionIds: [1],
    status: "live",
    activity: "idle",
    profile: "powershell",
    cwd: "C:\\work\\project",
    ...overrides,
  };
}

function snapshot(activeTab: SidebarTabModel | null = tab()): WorkspaceSnapshot {
  const tabs = activeTab
    ? {
        [activeTab.id]: {
          id: activeTab.id,
          title: activeTab.title,
          color: activeTab.color,
          fill: activeTab.fill,
          split: { kind: "pane" as const, sessionId: activeTab.primarySessionId },
        },
      }
    : {};
  const layout: LayoutV2 = {
    version: 2,
    groups: {},
    rootItems: activeTab ? [{ kind: "tab", id: activeTab.id }] : [],
    tabs,
    activeTabId: activeTab?.id ?? null,
  };
  const paneStatus = activeTab?.status === "live"
    ? ("live" as const)
    : activeTab?.status === "dead"
      ? ("dead" as const)
      : ("missing" as const);
  return {
    layout,
    rootItems: activeTab ? [{ kind: "tab", tab: activeTab }] : [],
    ungroupedTabs: activeTab ? [activeTab] : [],
    groups: [],
    paneStates: activeTab
      ? { [activeTab.primarySessionId]: { status: paneStatus, exitCode: null } }
      : {},
    activeTabId: activeTab?.id ?? null,
    activeSessionId: activeTab?.primarySessionId ?? null,
    persistence: { saving: false, error: null },
    notice: null,
  };
}

function controllerHarness(initial = snapshot()): ControllerHarness {
  let current = initial;
  const listeners = new Set<() => void>();
  const order: string[] = [];
  const controller = {
    attachments: {
      attach: vi.fn(),
      onError: vi.fn(() => () => undefined),
      close: vi.fn(),
    },
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: vi.fn(() => order.push("controller.dispose")),
    activateTab: vi.fn(),
    renameTab: vi.fn(),
    recolorTab: vi.fn(),
    moveTab: vi.fn(),
    reorderGroup: vi.fn(),
    createGroup: vi.fn(),
    renameGroup: vi.fn(),
    toggleGroup: vi.fn(),
    createTab: vi.fn(),
    duplicateTab: vi.fn(),
    openFolderHere: vi.fn(),
    closeLiveTab: vi.fn(),
    closeGroup: vi.fn(),
    dismissDeadTab: vi.fn(),
    splitPane: vi.fn(async () => null),
    closePane: vi.fn(async () => undefined),
    resizePane: vi.fn(),
    reportSessionCwd: vi.fn(),
    setFolderSearchHandler: vi.fn(),
    createTabWithCwd: vi.fn(async () => undefined),
    createTabViaNativeDialog: vi.fn(async () => undefined),
    mergeTabs: vi.fn(),
    popOutPane: vi.fn(),
    resumeSession: vi.fn(async () => undefined),
    sessionDims: vi.fn(() => ({})),
  };
  const client = {
    close: vi.fn(() => order.push("client.close")),
  };
  return {
    workspace: { controller, client } as unknown as BootstrappedWorkspace,
    setSnapshot(next) {
      current = next;
    },
    emit() {
      for (const listener of listeners) {
        listener();
      }
    },
    order,
  };
}

beforeEach(() => {
  terminalRender.mockClear();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("App workspace lifecycle", () => {
  it("shows a loading boundary until one workspace bootstrap resolves", async () => {
    const pending = deferred<BootstrappedWorkspace>();
    const bootstrap = vi.fn(() => pending.promise);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<App bootstrap={bootstrap} />));

    expect(container.querySelector("[data-testid='workspace-loading']")).not.toBeNull();
    expect(container.querySelector("[data-testid='workspace-terminal']")).toBeNull();
    expect(bootstrap).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it("composes the sidebar with the active terminal and follows active-session changes", async () => {
    const harness = controllerHarness();
    const bootstrap = vi.fn(async () => harness.workspace);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<App bootstrap={bootstrap} />));

    expect(container.querySelector("[data-testid='workspace-sidebar']")).not.toBeNull();
    expect(container.querySelector("[data-testid='workspace-terminal']")?.getAttribute("data-session-id"))
      .toBe("1");
    expect(terminalRender).toHaveBeenLastCalledWith({
      client: harness.workspace.controller.attachments,
      sessionId: 1,
    });

    harness.setSnapshot(snapshot(tab({ id: "tab-2", primarySessionId: 2, sessionIds: [2] })));
    await act(async () => harness.emit());

    expect(container.querySelector("[data-testid='workspace-terminal']")?.getAttribute("data-session-id"))
      .toBe("2");

    await act(async () => root.unmount());
    expect(harness.order).toEqual(["controller.dispose", "client.close"]);
  });

  it("renders the intentional empty panel and a dead-pane placeholder for a dead tab", async () => {
    const emptyHarness = controllerHarness(snapshot(null));
    const emptyContainer = document.createElement("div");
    document.body.append(emptyContainer);
    const emptyRoot = createRoot(emptyContainer);
    await act(async () => emptyRoot.render(<App bootstrap={async () => emptyHarness.workspace} />));
    expect(emptyContainer.querySelector("[data-testid='workspace-empty']")).not.toBeNull();
    expect(emptyContainer.querySelector("[data-testid='workspace-terminal']")).toBeNull();
    await act(async () => emptyRoot.unmount());

    const deadHarness = controllerHarness(snapshot(tab({ status: "dead" })));
    const deadContainer = document.createElement("div");
    document.body.append(deadContainer);
    const deadRoot = createRoot(deadContainer);
    await act(async () => deadRoot.render(<App bootstrap={async () => deadHarness.workspace} />));
    expect(deadContainer.querySelector("[data-testid='dead-pane']")).not.toBeNull();
    expect(deadContainer.querySelector("[data-testid='workspace-terminal']")).toBeNull();
    await act(async () => deadRoot.unmount());
  });

  it("routes dead-pane dismissal through the pessimistic controller close", async () => {
    const harness = controllerHarness(snapshot(tab({ status: "dead" })));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<App bootstrap={async () => harness.workspace} />));

    const dismiss = container.querySelector<HTMLButtonElement>(".dead-pane__dismiss");
    expect(dismiss).not.toBeNull();
    await act(async () => dismiss!.click());

    expect(harness.workspace.controller.closePane).toHaveBeenCalledWith("tab-1", 1);
    await act(async () => root.unmount());
  });

  it("bounds bootstrap failures without exposing internal or token text", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(
      <App bootstrap={async () => { throw new Error("secret-token-value internal host failure"); }} />,
    ));

    expect(container.querySelector("[data-testid='workspace-error']")?.textContent)
      .toContain("Unable to start the TermX workspace.");
    expect(container.textContent).not.toContain("secret-token-value");
    expect(container.textContent).not.toContain("internal host failure");

    await act(async () => root.unmount());
  });

  it("cleans up a workspace that resolves after its effect was canceled", async () => {
    const pending = deferred<BootstrappedWorkspace>();
    const harness = controllerHarness();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<App bootstrap={() => pending.promise} />));
    await act(async () => root.unmount());
    await act(async () => pending.resolve(harness.workspace));

    expect(harness.order).toEqual(["controller.dispose", "client.close"]);
  });

  it("still closes the host client when controller disposal fails", async () => {
    const harness = controllerHarness();
    vi.mocked(harness.workspace.controller.dispose).mockImplementation(() => {
      harness.order.push("controller.dispose");
      throw new Error("cleanup detail");
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<App bootstrap={async () => harness.workspace} />));
    await act(async () => root.unmount());

    expect(harness.order).toEqual(["controller.dispose", "client.close"]);
  });
});

describe("App settings surface", () => {
  it("opens the full-screen settings surface from the sidebar and closes on Esc", async () => {
    const harness = controllerHarness();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<App bootstrap={async () => harness.workspace} />));

    expect(container.querySelector(".settings-surface")).toBeNull();
    // The old modal is gone — no backdrop, ever.
    expect(container.querySelector(".settings-dialog-backdrop")).toBeNull();

    const gear = container.querySelector<HTMLButtonElement>(
      "[data-testid='sidebar-open-settings']",
    )!;
    await act(async () => gear.click());

    const surface = container.querySelector<HTMLElement>(".settings-surface");
    expect(surface).not.toBeNull();
    expect(surface!.getAttribute("aria-label")).toBe("TermX settings");
    // Terminals underneath stay mounted — the surface is a layer, not a route.
    expect(container.querySelector("[data-testid='workspace-terminal']")).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(container.querySelector(".settings-surface")).toBeNull();

    await act(async () => root.unmount());
  });
});

function twoTabSnapshot(activeTabId: "tab-a" | "tab-b"): WorkspaceSnapshot {
  const tabA = tab({ id: "tab-a", primarySessionId: 1, sessionIds: [1] });
  const tabB = tab({ id: "tab-b", primarySessionId: 2, sessionIds: [2] });
  const layout: LayoutV2 = {
    version: 2,
    groups: {},
    rootItems: [{ kind: "tab", id: "tab-a" }, { kind: "tab", id: "tab-b" }],
    tabs: {
      "tab-a": {
        id: "tab-a",
        title: tabA.title,
        color: tabA.color,
        fill: "off",
        split: { kind: "pane", sessionId: 1 },
      },
      "tab-b": {
        id: "tab-b",
        title: tabB.title,
        color: tabB.color,
        fill: "off",
        split: { kind: "pane", sessionId: 2 },
      },
    },
    activeTabId,
  };
  return {
    layout,
    rootItems: [{ kind: "tab", tab: tabA }, { kind: "tab", tab: tabB }],
    ungroupedTabs: [tabA, tabB],
    groups: [],
    paneStates: {
      1: { status: "live", exitCode: null },
      2: { status: "live", exitCode: null },
    },
    activeTabId,
    activeSessionId: activeTabId === "tab-a" ? 1 : 2,
    persistence: { saving: false, error: null },
    notice: null,
  };
}

describe("App sleep lifecycle across hidden tabs (spec §13)", () => {
  // Only what the sleep path touches: SleepController's setTimeout schedule
  // and the tracker's Date.now idle clock. React's own scheduling stays real.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the hidden tab mounted, sleeps it after the threshold, and wakes it on activation", async () => {
    const harness = controllerHarness(twoTabSnapshot("tab-a"));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<App bootstrap={async () => harness.workspace} />));

    // Both tabs are mounted; the inactive one is hidden, never unmounted.
    const terminals = [...container.querySelectorAll("[data-testid='workspace-terminal']")];
    expect(terminals.map((el) => el.getAttribute("data-session-id"))).toEqual(["1", "2"]);
    const wrapperOf = (tabId: string) =>
      container.querySelector(`[data-testid='split-layout-${tabId}']`)?.parentElement as HTMLElement;
    expect(wrapperOf("tab-a").style.display).toBe("contents");
    expect(wrapperOf("tab-b").style.display).toBe("none");
    expect(container.querySelector("[data-testid='sleeping-pane-2']")).toBeNull();

    // 15 idle minutes later (default setting) the hidden pane sleeps; the
    // visible pane never does.
    await act(async () => {
      vi.advanceTimersByTime(15 * 60_000 + 1);
    });
    expect(container.querySelector("[data-testid='sleeping-pane-2']")).not.toBeNull();
    expect(container.querySelector("[data-testid='sleeping-pane-1']")).toBeNull();
    expect(
      container.querySelector("[data-testid='workspace-terminal'][data-session-id='1']"),
    ).not.toBeNull();

    // Activating the tab wakes it: the placeholder yields back to a terminal
    // fed with recorded dims from the controller.
    harness.setSnapshot(twoTabSnapshot("tab-b"));
    await act(async () => harness.emit());
    expect(container.querySelector("[data-testid='sleeping-pane-2']")).toBeNull();
    expect(
      container.querySelector("[data-testid='workspace-terminal'][data-session-id='2']"),
    ).not.toBeNull();
    expect(harness.workspace.controller.sessionDims).toHaveBeenCalled();

    await act(async () => root.unmount());
  });
});
