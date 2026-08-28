import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Layout } from "../state/layout";
import type {
  SidebarTabModel,
  WorkspaceSnapshot,
} from "../workspace/WorkspaceController";
import type { BootstrappedWorkspace } from "../workspace/bootstrapWorkspace";

const { requestUserAttention } = vi.hoisted(() => ({
  requestUserAttention: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    requestUserAttention,
    close: vi.fn(async () => undefined),
    onCloseRequested: vi.fn(async () => () => undefined),
  }),
  UserAttentionType: { Critical: 1, Informational: 2 },
}));
vi.mock("../sidebar/Sidebar", () => ({
  Sidebar: () => <div data-testid="workspace-sidebar" />,
}));
vi.mock("../terminal/TerminalPane", () => ({
  TerminalPane: ({ sessionId }: { sessionId: number }) => (
    <div data-session-id={sessionId} data-testid="workspace-terminal" />
  ),
}));

import App from "../App";

function tab(id: string, activity: SidebarTabModel["activity"]): SidebarTabModel {
  return {
    id,
    groupId: null,
    title: `Tab ${id}`,
    color: "blue",
    fill: "off",
    primarySessionId: Number(id.replace(/\D/g, "")) || 1,
    sessionIds: [Number(id.replace(/\D/g, "")) || 1],
    status: "live",
    activity,
    profile: "powershell",
    cwd: "C:\\work\\project",
  };
}

function snapshot(tabs: readonly SidebarTabModel[]): WorkspaceSnapshot {
  const layoutTabs: Layout["tabs"] = {};
  for (const entry of tabs) {
    layoutTabs[entry.id] = {
      id: entry.id,
      title: entry.title,
      color: entry.color,
      fill: entry.fill,
      split: { kind: "pane" as const, sessionId: entry.primarySessionId },
    };
  }
  const layout: Layout = {
    version: 3,
    auxWindows: {},
    groups: {},
    rootItems: tabs.map((entry) => ({ kind: "tab" as const, id: entry.id })),
    tabs: layoutTabs,
    activeTabId: tabs[0]?.id ?? null,
  };
  const paneStates: Record<number, { status: "live"; exitCode: null }> = {};
  for (const entry of tabs) {
    paneStates[entry.primarySessionId] = { status: "live", exitCode: null };
  }
  return {
    layout,
    rootItems: tabs.map((entry) => ({ kind: "tab" as const, tab: entry })),
    ungroupedTabs: [...tabs],
    groups: [],
    paneStates,
    activeTabId: tabs[0]?.id ?? null,
    activeSessionId: tabs[0]?.primarySessionId ?? null,
    persistence: { saving: false, error: null },
    notice: null,
  };
}

function harness(initial: WorkspaceSnapshot) {
  let current = initial;
  const listeners = new Set<() => void>();
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
    dispose: vi.fn(),
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
    paneTitles: vi.fn(() => ({})),
    sessionCwd: vi.fn(() => null),
    resumedSessionKeyForTab: vi.fn(() => null),
    resumedEntries: vi.fn(() => []),
    rebindResumedTab: vi.fn(),
    setResumeBootListener: vi.fn(),
    noteBell: vi.fn(),
    markTabSeen: vi.fn(),
  };
  return {
    workspace: {
      controller,
      client: { close: vi.fn() },
    } as unknown as BootstrappedWorkspace,
    publish(next: WorkspaceSnapshot) {
      current = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

async function mount(workspace: BootstrappedWorkspace): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<App bootstrap={async () => workspace} />));
  return container;
}

/** jsdom reports the window as focused; blur/focus drive App's own flag. */
async function blur(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event("blur"));
  });
}

async function focus(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
}

beforeEach(() => {
  requestUserAttention.mockClear();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("finished-work attention", () => {
  it("flashes the taskbar when a pane finishes while the window is in the background", async () => {
    const { workspace, publish } = harness(snapshot([tab("tab-1", "active")]));
    await mount(workspace);
    await blur();
    expect(requestUserAttention).not.toHaveBeenCalled();

    await act(async () => publish(snapshot([tab("tab-1", "attention")])));

    // Critical, not Informational: Informational blinks four times and stops,
    // so it is gone long before the user glances at the taskbar.
    expect(requestUserAttention).toHaveBeenCalledWith(1);
  });

  it(
    "keeps flashing for each later tab that finishes, even while an earlier " +
      "unvisited tab still holds its mark",
    async () => {
      const { workspace, publish } = harness(snapshot([tab("tab-1", "active")]));
      await mount(workspace);
      await blur();

      await act(async () =>
        publish(snapshot([tab("tab-1", "attention"), tab("tab-2", "active")])),
      );
      expect(requestUserAttention).toHaveBeenCalledTimes(1);

      // tab-1 was never visited, so it is still attentive. A global "any tab
      // needs attention" flag would be latched high here and tab-2's finish
      // would pass in silence — the bug that made this feature look dead.
      await act(async () =>
        publish(snapshot([tab("tab-1", "attention"), tab("tab-2", "attention")])),
      );
      expect(requestUserAttention).toHaveBeenCalledTimes(2);
    },
  );

  it("stays quiet while the user is looking at the window", async () => {
    const { workspace, publish } = harness(snapshot([tab("tab-1", "active")]));
    await mount(workspace);
    await focus();

    await act(async () => publish(snapshot([tab("tab-1", "attention")])));
    expect(requestUserAttention).not.toHaveBeenCalled();

    // And alt-tabbing away afterwards must not fire for work the user already
    // watched finish.
    await blur();
    expect(requestUserAttention).not.toHaveBeenCalled();
  });

  it("does not re-flash a tab it has already announced", async () => {
    const { workspace, publish } = harness(snapshot([tab("tab-1", "active")]));
    await mount(workspace);
    await blur();

    await act(async () => publish(snapshot([tab("tab-1", "attention")])));
    expect(requestUserAttention).toHaveBeenCalledTimes(1);

    await act(async () => publish(snapshot([tab("tab-1", "attention")])));
    expect(requestUserAttention).toHaveBeenCalledTimes(1);
  });
});
