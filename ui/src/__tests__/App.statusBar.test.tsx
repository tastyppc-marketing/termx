/**
 * The status bar's cwd is wired to the real file manager here, at the mount
 * site — StatusBar itself only reports the click. What this file protects is
 * the join: the path App shows and the path App opens must be the same one.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Layout } from "../state/layout";
import type {
  SidebarTabModel,
  WorkspaceSnapshot,
} from "../workspace/WorkspaceController";
import { fixtureWorkspace } from "./fixtureWorkspace";

const { openFolder } = vi.hoisted(() => ({ openFolder: vi.fn(async () => true) }));
vi.mock("../native/openFolder", () => ({ tauriOpenFolder: openFolder }));

vi.mock("../sidebar/Sidebar", () => ({
  Sidebar: () => <div data-testid="workspace-sidebar" />,
}));
vi.mock("../terminal/TerminalPane", () => ({
  TerminalPane: ({ sessionId }: { sessionId: number }) => (
    <div data-session-id={sessionId} data-testid="workspace-terminal" />
  ),
}));

import App from "../App";

const CWD = "C:\\Dev\\TermX\\ui";

function tab(): SidebarTabModel {
  return {
    id: "tab-1",
    groupId: null,
    title: "PowerShell · ui",
    color: "blue",
    fill: "off",
    primarySessionId: 1,
    sessionIds: [1],
    status: "live",
    activity: "idle",
    profile: "powershell",
    cwd: CWD,
  } as SidebarTabModel;
}

function snapshot(): WorkspaceSnapshot {
  const active = tab();
  const layout: Layout = {
    version: 3,
    auxWindows: {},
    windowNames: {},
    groups: {},
    rootItems: [{ kind: "tab", id: active.id }],
    tabs: {
      [active.id]: {
        id: active.id,
        title: active.title,
        color: active.color,
        fill: active.fill,
        split: { kind: "pane" as const, sessionId: active.primarySessionId },
      },
    },
    activeTabId: active.id,
  };
  return {
    layout,
    rootItems: [{ kind: "tab", tab: active }],
    ungroupedTabs: [active],
    groups: [],
    paneStates: { 1: { status: "live", exitCode: null } },
    activeTabId: active.id,
    activeSessionId: 1,
    persistence: { saving: false, error: null },
    notice: null,
  } as unknown as WorkspaceSnapshot;
}

/** A controller that knows exactly one live local pane, standing in `CWD`. */
function harness(overrides: Record<string, unknown> = {}) {
  const current = snapshot();
  const controller = {
    attachments: { attach: vi.fn(), onError: vi.fn(() => () => undefined), close: vi.fn() },
    getSnapshot: () => current,
    subscribe: () => () => undefined,
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
    sessionCwd: vi.fn(() => CWD),
    sessionProfile: vi.fn(() => "powershell"),
    sshPaneInfo: vi.fn(() => null),
    resumedSessionKeyForTab: vi.fn(() => null),
    resumedEntries: vi.fn(() => []),
    rebindResumedTab: vi.fn(),
    setResumeBootListener: vi.fn(),
    setFocusedPane: vi.fn(),
    ...overrides,
  };
  return fixtureWorkspace({ controller, client: { close: vi.fn() } });
}

let container: HTMLDivElement;

beforeEach(() => {
  openFolder.mockClear();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  document.body.replaceChildren();
});

async function mount(workspace = harness()) {
  const root = createRoot(container);
  await act(async () => root.render(<App bootstrap={async () => workspace} />));
  return root;
}

function pathButton(): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-testid='status-bar-open-cwd']");
}

describe("App — opening the focused pane's folder from the status bar", () => {
  it("opens the exact path the bar is displaying", async () => {
    await mount();

    const button = pathButton();
    expect(button?.textContent).toBe(CWD);
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(openFolder).toHaveBeenCalledExactlyOnceWith(CWD);
  });

  it(
    "leaves a remote pane's path as plain text — that directory lives on the " +
      "far side of an ssh hop, where local Explorer cannot follow",
    async () => {
      await mount(
        harness({
          sessionCwd: vi.fn(() => "/srv/app"),
          sshPaneInfo: vi.fn(() => ({ host: "myvps" })),
        }),
      );

      expect(container.querySelector(".status-bar__cwd")?.textContent).toBe("/srv/app");
      expect(pathButton()).toBeNull();
      expect(openFolder).not.toHaveBeenCalled();
    },
  );
});
