import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutV1 } from "../state/layout";
import type {
  SidebarTabModel,
  WorkspaceSnapshot,
} from "../workspace/WorkspaceController";
import type { BootstrappedWorkspace } from "../workspace/bootstrapWorkspace";

const terminalRender = vi.hoisted(() => vi.fn());

vi.mock("../sidebar/Sidebar", () => ({
  Sidebar: ({ snapshot }: { snapshot: WorkspaceSnapshot }) => (
    <div data-active-tab={snapshot.activeTabId ?? ""} data-testid="workspace-sidebar" />
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
          split: { kind: "pane" as const, sessionId: activeTab.primarySessionId },
        },
      }
    : {};
  const layout: LayoutV1 = {
    version: 1,
    groups: [],
    ungroupedTabIds: activeTab ? [activeTab.id] : [],
    tabs,
    activeTabId: activeTab?.id ?? null,
  };
  return {
    layout,
    ungroupedTabs: activeTab ? [activeTab] : [],
    groups: [],
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

  it("renders intentional empty and dead-active workspace panels", async () => {
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
    expect(deadContainer.querySelector("[data-testid='workspace-ended']")).not.toBeNull();
    expect(deadContainer.querySelector("[data-testid='workspace-terminal']")).toBeNull();
    await act(async () => deadRoot.unmount());
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
