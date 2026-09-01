/**
 * The sidebar's Terminals | Conversations switch (spec §3). Lives here rather
 * than in `sidebar/__tests__` because the switch is this feature's only claim
 * on Sidebar.tsx: Terminals mode must render exactly as before.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type TermxSettings } from "../../settings/settings";
import { Sidebar, type SidebarActions } from "../../sidebar/Sidebar";
import type {
  SidebarTabModel,
  WorkspaceSnapshot,
} from "../../workspace/WorkspaceController";
import { ConversationsStore } from "../store";
import type { LlmSessionRecord } from "../types";

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

function rootTab(): SidebarTabModel {
  return {
    id: "tab-1",
    groupId: null,
    title: "powershell · one",
    color: "blue",
    fill: "off",
    primarySessionId: 1,
    sessionIds: [1],
    status: "live",
    activity: "idle",
    profile: "powershell",
    cwd: "C:\\one",
  };
}

function snapshot(): WorkspaceSnapshot {
  return {
    layout: {
      version: 3,
      auxWindows: {},
      windowNames: {},
      groups: {},
      rootItems: [{ kind: "tab", id: "tab-1" }],
      tabs: {
        "tab-1": {
          id: "tab-1",
          title: null,
          color: "blue",
          fill: "off",
          split: { kind: "pane", sessionId: 1 },
        },
      },
      activeTabId: "tab-1",
    },
    rootItems: [{ kind: "tab", tab: rootTab() }],
    ungroupedTabs: [rootTab()],
    groups: [],
    paneStates: { 1: { status: "live", exitCode: null } },
    activeTabId: "tab-1",
    activeSessionId: 1,
    persistence: { saving: false, error: null },
    notice: null,
  };
}

function actions(): SidebarActions {
  return {
    activateTab: vi.fn(),
    renameTab: vi.fn(),
    recolorTab: vi.fn(),
    setTabFill: vi.fn(),
    recolorGroup: vi.fn(),
    moveItem: vi.fn(() => true),
    createGroup: vi.fn(() => 'new-group'),
    renameGroup: vi.fn(),
    toggleGroup: vi.fn(),
    createTab: vi.fn(async () => undefined),
    mergeTabs: vi.fn(),
    duplicateTab: vi.fn(async () => undefined),
    openFolderHere: vi.fn(async () => undefined),
    closeLiveTab: vi.fn(async () => undefined),
    deleteGroup: vi.fn(async () => undefined),
    dismissDeadTab: vi.fn(async () => undefined),
  };
}

const RECORD: LlmSessionRecord = {
  provider: "claude",
  id: "a",
  title: "Parser work",
  cwd: "C:\\Dev\\TermX",
  filePath: "C:\\a.jsonl",
  updatedAtMs: 10,
  summary: null,
  recap: null,
};

async function renderSidebar(settings?: Partial<TermxSettings>) {
  const list = vi.fn(async () => [RECORD]);
  const store = new ConversationsStore({ list, debounceMs: 0 });
  await act(async () => {
    root.render(
      <Sidebar
        snapshot={snapshot()}
        actions={actions()}
        conversations={{
          store,
          settings: { ...DEFAULT_SETTINGS, ...settings },
          onResume: vi.fn(),
          onOpenTranscript: vi.fn(),
        }}
      />,
    );
  });
  return { store, list };
}

function modeButton(label: string): HTMLButtonElement {
  const found = [
    ...container.querySelectorAll<HTMLButtonElement>(".sidebar__mode"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) {
    throw new Error(`no mode button ${label}`);
  }
  return found;
}

describe("Sidebar mode switch", () => {
  it("renders no switch and no rail without a conversations store", async () => {
    await act(async () => {
      root.render(<Sidebar snapshot={snapshot()} actions={actions()} />);
    });
    expect(container.querySelector(".sidebar__modes")).toBeNull();
    expect(container.querySelector(".conversations")).toBeNull();
    expect(container.querySelector(".sidebar__scroll")).not.toBeNull();
  });

  it("hides the switch when conversationsRail is off", async () => {
    await renderSidebar({ conversationsRail: false });
    expect(container.querySelector(".sidebar__modes")).toBeNull();
    expect(container.querySelector(".sidebar__scroll")).not.toBeNull();
  });

  it("starts in Terminals mode with the rail unmounted (nothing scans)", async () => {
    const { list } = await renderSidebar();
    expect(modeButton("Terminals").getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".conversations")).toBeNull();
    expect(container.querySelector(".sidebar__scroll")).not.toBeNull();
    expect(container.querySelector(".sidebar-create")).not.toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it("swaps the terminals body for the rail and back", async () => {
    const { list } = await renderSidebar();
    await act(async () => {
      modeButton("Conversations").dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await act(async () => {});

    expect(container.querySelector(".conversations")).not.toBeNull();
    expect(container.querySelector(".sidebar__scroll")).toBeNull();
    expect(container.querySelector(".sidebar-create")).toBeNull();
    expect(container.textContent).toContain("Parser work");
    expect(list).toHaveBeenCalledWith(false);

    await act(async () => {
      modeButton("Terminals").dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    expect(container.querySelector(".conversations")).toBeNull();
    expect(container.querySelector(".sidebar__scroll")).not.toBeNull();
    expect(container.querySelector(".sidebar-create")).not.toBeNull();
  });
});
