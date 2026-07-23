import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutV1 } from "../../state/layout";
import type { WorkspaceSnapshot } from "../../workspace/WorkspaceController";
import { Sidebar, type SidebarActions } from "../Sidebar";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

function workspace(): WorkspaceSnapshot {
  const layout: LayoutV1 = {
    version: 1,
    groups: [
      { id: "group-1", name: "Work", collapsed: false, tabIds: ["tab-2"] },
      { id: "group-2", name: "Hidden", collapsed: true, tabIds: ["tab-3"] },
    ],
    ungroupedTabIds: ["tab-1"],
    tabs: {
      "tab-1": {
        id: "tab-1",
        title: null,
        color: "blue",
        split: { kind: "pane", sessionId: 1 },
      },
      "tab-2": {
        id: "tab-2",
        title: "Exited shell",
        color: "red",
        split: { kind: "pane", sessionId: 2 },
      },
      "tab-3": {
        id: "tab-3",
        title: "Collapsed shell",
        color: "green",
        split: { kind: "pane", sessionId: 3 },
      },
    },
    activeTabId: "tab-1",
  };
  return {
    layout,
    ungroupedTabs: [{
      id: "tab-1",
      groupId: null,
      title: "powershell · one",
      color: "blue",
      primarySessionId: 1,
      sessionIds: [1],
      status: "live",
      activity: "unread",
      profile: "powershell",
      cwd: "C:\\one",
    }],
    groups: [
      {
        id: "group-1",
        name: "Work",
        collapsed: false,
        color: "slate",
        tabs: [{
          id: "tab-2",
          groupId: "group-1",
          title: "Exited shell",
          color: "red",
          primarySessionId: 2,
          sessionIds: [2],
          status: "dead",
          activity: "idle",
          profile: "powershell",
          cwd: "C:\\two",
        }],
      },
      {
        id: "group-2",
        name: "Hidden",
        collapsed: true,
        color: "slate",
        tabs: [{
          id: "tab-3",
          groupId: "group-2",
          title: "Collapsed shell",
          color: "green",
          primarySessionId: 3,
          sessionIds: [3],
          status: "live",
          activity: "active",
          profile: "cmd",
          cwd: "C:\\three",
        }],
      },
    ],
    paneStates: {
      1: { status: "live", exitCode: null },
      2: { status: "dead", exitCode: 0 },
      3: { status: "live", exitCode: null },
    },
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
    moveTab: vi.fn(),
    reorderGroup: vi.fn(),
    createGroup: vi.fn(),
    renameGroup: vi.fn(),
    toggleGroup: vi.fn(),
    createTab: vi.fn(async () => undefined),
    duplicateTab: vi.fn(async () => undefined),
    openFolderHere: vi.fn(async () => undefined),
    closeLiveTab: vi.fn(async () => undefined),
    closeGroup: vi.fn(async () => undefined),
    dismissDeadTab: vi.fn(async () => undefined),
  };
}

async function renderSidebar(snapshot = workspace(), sidebarActions = actions()) {
  await act(async () => root.render(<Sidebar snapshot={snapshot} actions={sidebarActions} />));
  return sidebarActions;
}

function key(element: Element, value: string): void {
  element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
}

function pointer(
  type: string,
  options: {
    x?: number;
    y?: number;
    button?: number;
    pointerId?: number;
    isPrimary?: boolean;
  } = {},
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

describe("Sidebar structure", () => {
  it("renders ungrouped tabs first, then ordered groups, while hiding collapsed tabs", async () => {
    await renderSidebar();

    expect([...container.querySelectorAll("[data-tab-id]")].map((node) => node.getAttribute("data-tab-id")))
      .toEqual(["tab-1", "tab-2"]);
    expect(container.textContent).toContain("Work");
    expect(container.textContent).toContain("Hidden");
    expect(container.textContent).not.toContain("Collapsed shell");
  });

  it("projects active, palette, activity, group, and exited visual states", async () => {
    await renderSidebar();

    const active = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;
    const dead = container.querySelector<HTMLElement>("[data-tab-id='tab-2']")!;
    const group = container.querySelector<HTMLElement>("[data-group-id='group-1']")!;
    expect(active.getAttribute("aria-selected")).toBe("true");
    expect(active.classList.contains("sidebar-tab--active")).toBe(true);
    expect(active.querySelector("[data-color='blue']")).not.toBeNull();
    expect(active.querySelector("[data-activity='unread']")).not.toBeNull();
    expect(active.querySelector("[aria-label='Close powershell · one']")).not.toBeNull();
    expect(dead.classList.contains("sidebar-tab--ended")).toBe(true);
    expect(dead.textContent).toContain("Exited");
    expect(group.querySelector("[data-color='slate']")).not.toBeNull();
  });
});

describe("Sidebar rename and keyboard", () => {
  it("renames tabs and groups inline with double-click", async () => {
    const sidebarActions = await renderSidebar();
    const tab = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;

    await act(async () => tab.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const tabInput = container.querySelector<HTMLInputElement>("input[aria-label='Rename powershell · one']")!;
    await act(async () => {
      tabInput.value = "  New tab  ";
      tabInput.dispatchEvent(new Event("input", { bubbles: true }));
      key(tabInput, "Enter");
    });
    expect(sidebarActions.renameTab).toHaveBeenCalledWith("tab-1", "New tab");

    const groupName = container.querySelector<HTMLElement>("[data-group-name='group-1']")!;
    await act(async () => groupName.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const groupInput = container.querySelector<HTMLInputElement>("input[aria-label='Rename Work']")!;
    await act(async () => {
      groupInput.value = "Team";
      groupInput.dispatchEvent(new Event("input", { bubbles: true }));
      key(groupInput, "Enter");
    });
    expect(sidebarActions.renameGroup).toHaveBeenCalledWith("group-1", "Team");
  });

  it("navigates visible tabs without wrapping and activates with Enter", async () => {
    const sidebarActions = await renderSidebar();
    const first = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;
    const second = container.querySelector<HTMLElement>("[data-tab-id='tab-2']")!;
    first.focus();

    await act(async () => key(first, "ArrowDown"));
    expect(document.activeElement).toBe(second);
    await act(async () => key(second, "ArrowDown"));
    expect(document.activeElement).toBe(second);
    await act(async () => key(second, "Enter"));
    expect(sidebarActions.activateTab).toHaveBeenCalledWith("tab-2");
    await act(async () => key(second, "ArrowUp"));
    expect(document.activeElement).toBe(first);
  });

  it("opens rename with F2, cancels with Escape, and ignores editor shortcuts", async () => {
    const sidebarActions = await renderSidebar();
    const first = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;

    await act(async () => key(first, "F2"));
    const input = container.querySelector<HTMLInputElement>("input[aria-label='Rename powershell · one']")!;
    await act(async () => key(input, "Delete"));
    expect(container.querySelector("[role='dialog']")).toBeNull();
    expect(sidebarActions.dismissDeadTab).not.toHaveBeenCalled();
    await act(async () => key(input, "Escape"));
    expect(sidebarActions.renameTab).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(first);
  });

  it("moves focus into close confirmation, traps Tab, and cancels with Escape", async () => {
    const sidebarActions = await renderSidebar();
    const live = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;
    live.focus();

    await act(async () => key(live, "Delete"));
    const dialog = container.querySelector<HTMLElement>("[role='dialog']")!;
    const buttons = dialog.querySelectorAll<HTMLButtonElement>("button");
    expect(document.activeElement).toBe(buttons[0]);

    buttons[1]!.focus();
    await act(async () => key(buttons[1]!, "Tab"));
    expect(document.activeElement).toBe(buttons[0]);
    await act(async () => key(buttons[0]!, "Escape"));
    expect(container.querySelector("[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(live);
    expect(sidebarActions.closeLiveTab).not.toHaveBeenCalled();
  });

  it("reassigns the roving tab stop when the focused tab becomes hidden", async () => {
    const sidebarActions = actions();
    await renderSidebar(workspace(), sidebarActions);
    const grouped = container.querySelector<HTMLElement>("[data-tab-id='tab-2']")!;
    await act(async () => grouped.focus());
    expect(grouped.tabIndex).toBe(0);

    const collapsed = workspace();
    collapsed.groups = collapsed.groups.map((group) =>
      group.id === "group-1" ? { ...group, collapsed: true } : group
    );
    collapsed.layout = {
      ...collapsed.layout,
      groups: collapsed.layout.groups.map((group) =>
        group.id === "group-1" ? { ...group, collapsed: true } : group
      ),
    };
    await renderSidebar(collapsed, sidebarActions);

    const replacement = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;
    expect(replacement.tabIndex).toBe(0);
    expect(document.activeElement).toBe(replacement);
  });

  it("deduplicates repeated dead-session Dismiss requests", async () => {
    let resolveDismiss!: () => void;
    const sidebarActions = actions();
    sidebarActions.dismissDeadTab = vi.fn(() => new Promise<void>((resolve) => {
      resolveDismiss = resolve;
    }));
    await renderSidebar(workspace(), sidebarActions);
    const dead = container.querySelector<HTMLElement>("[data-tab-id='tab-2']")!;

    await act(async () => {
      key(dead, "Delete");
      key(dead, "Delete");
    });
    expect(sidebarActions.dismissDeadTab).toHaveBeenCalledTimes(1);
    await act(async () => resolveDismiss());
  });

  it("confirms live deletion but dismisses an ended tab immediately", async () => {
    const sidebarActions = await renderSidebar();
    const live = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;
    const dead = container.querySelector<HTMLElement>("[data-tab-id='tab-2']")!;

    await act(async () => key(live, "Delete"));
    expect(container.querySelector("[role='dialog']")?.textContent).toContain("Close terminal?");
    const cancel = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Cancel")!;
    await act(async () => cancel.click());
    expect(sidebarActions.closeLiveTab).not.toHaveBeenCalled();

    await act(async () => key(dead, "Delete"));
    expect(sidebarActions.dismissDeadTab).toHaveBeenCalledWith("tab-2");
  });
});

describe("Sidebar pointer drag", () => {
  it("starts only from a primary row pointer and captures it", async () => {
    await renderSidebar();
    const row = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;
    const title = row.querySelector<HTMLElement>(".sidebar-tab__title")!;
    const close = row.querySelector<HTMLElement>(".sidebar-tab__close")!;

    await act(async () => title.dispatchEvent(pointer("pointerdown", { isPrimary: false })));
    await act(async () => row.dispatchEvent(pointer("pointermove", { x: 20 })));
    expect(container.querySelector(".sidebar-drag-ghost")).toBeNull();

    await act(async () => close.dispatchEvent(pointer("pointerdown")));
    await act(async () => row.dispatchEvent(pointer("pointermove", { x: 20 })));
    expect(container.querySelector(".sidebar-drag-ghost")).toBeNull();

    await act(async () => title.dispatchEvent(pointer("pointerdown")));
    expect(row.setPointerCapture).toHaveBeenCalledWith(7);
  });

  it("does not mutate below threshold, then shows a ghost and commits exactly one drop", async () => {
    const sidebarActions = await renderSidebar();
    const row = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;
    const title = row.querySelector<HTMLElement>(".sidebar-tab__title")!;
    const target = container.querySelector<HTMLElement>("[data-tab-id='tab-2']")!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 20, width: 200, height: 40, top: 20, right: 200, bottom: 60, left: 0,
      toJSON: () => ({}),
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => target),
    });

    await act(async () => title.dispatchEvent(pointer("pointerdown", { x: 10, y: 10 })));
    await act(async () => row.dispatchEvent(pointer("pointermove", { x: 12, y: 10 })));
    expect(container.querySelector(".sidebar-drag-ghost")).toBeNull();
    expect(sidebarActions.moveTab).not.toHaveBeenCalled();

    await act(async () => row.dispatchEvent(pointer("pointermove", { x: 20, y: 25 })));
    expect(container.querySelector(".sidebar-drag-ghost")?.textContent).toContain("powershell · one");
    expect(container.querySelector(".sidebar-drag-indicator")).not.toBeNull();
    expect(sidebarActions.moveTab).not.toHaveBeenCalled();

    await act(async () => row.dispatchEvent(pointer("pointerup", { x: 20, y: 25 })));
    expect(sidebarActions.moveTab).toHaveBeenCalledTimes(1);
    expect(sidebarActions.moveTab).toHaveBeenCalledWith("tab-1", "group-1", 0);
    expect(container.querySelector(".sidebar-drag-ghost")).toBeNull();
  });

  it("moves a grouped tab to the ungrouped root when the root is empty", async () => {
    const emptyRoot = workspace();
    emptyRoot.layout = {
      ...emptyRoot.layout,
      ungroupedTabIds: [],
      activeTabId: "tab-2",
    };
    emptyRoot.ungroupedTabs = [];
    emptyRoot.activeTabId = "tab-2";
    emptyRoot.activeSessionId = 2;
    const sidebarActions = await renderSidebar(emptyRoot);
    const rootTarget = container.querySelector<HTMLElement>(
      "[data-drop-kind='tab-container'][data-drop-group-id='']",
    )!;
    expect(rootTarget).not.toBeNull();
    vi.spyOn(rootTarget, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, width: 200, height: 20, top: 0, right: 200, bottom: 20, left: 0,
      toJSON: () => ({}),
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => rootTarget),
    });
    const row = container.querySelector<HTMLElement>("[data-tab-id='tab-2']")!;
    const title = row.querySelector<HTMLElement>(".sidebar-tab__title")!;

    await act(async () => title.dispatchEvent(pointer("pointerdown", { x: 10, y: 30 })));
    await act(async () => row.dispatchEvent(pointer("pointermove", { x: 10, y: 5 })));
    await act(async () => row.dispatchEvent(pointer("pointerup", { x: 10, y: 5 })));

    expect(sidebarActions.moveTab).toHaveBeenCalledWith("tab-2", null, 0);
  });

  it("does not dispatch unchanged, canceled, or pointer-canceled drops", async () => {
    const sidebarActions = await renderSidebar();
    const row = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;
    const title = row.querySelector<HTMLElement>(".sidebar-tab__title")!;
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, width: 200, height: 40, top: 0, right: 200, bottom: 40, left: 0,
      toJSON: () => ({}),
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => row),
    });

    await act(async () => title.dispatchEvent(pointer("pointerdown")));
    await act(async () => row.dispatchEvent(pointer("pointermove", { x: 10, y: 1 })));
    await act(async () => row.dispatchEvent(pointer("pointerup", { x: 10, y: 1 })));
    expect(sidebarActions.moveTab).not.toHaveBeenCalled();

    await act(async () => title.dispatchEvent(pointer("pointerdown")));
    await act(async () => row.dispatchEvent(pointer("pointermove", { x: 10 })));
    await act(async () => key(window.document.body, "Escape"));
    await act(async () => row.dispatchEvent(pointer("pointerup", { x: 10 })));

    await act(async () => title.dispatchEvent(pointer("pointerdown")));
    await act(async () => row.dispatchEvent(pointer("pointermove", { x: 10 })));
    await act(async () => row.dispatchEvent(pointer("pointercancel", { x: 10 })));
    expect(sidebarActions.moveTab).not.toHaveBeenCalled();
  });
});

describe("Sidebar context menus and creation", () => {
  it("suppresses the native tab menu and dispatches tab actions, colors, and moves", async () => {
    const sidebarActions = await renderSidebar();
    const tab = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;
    const context = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 50,
    });

    await act(async () => tab.dispatchEvent(context));
    expect(context.defaultPrevented).toBe(true);
    expect(container.querySelector("[role='menu']")?.textContent).toContain("Rename");
    expect(container.querySelector("[role='menu']")?.textContent).toContain("Duplicate tab");
    expect(container.querySelector("[role='menu']")?.textContent).toContain("Open folder here");
    expect(container.querySelector("[role='menu']")?.textContent).toContain("Color");
    expect(container.querySelector("[role='menu']")?.textContent).toContain("Move to group");
    expect(container.querySelector("[role='menu']")?.textContent).toContain("Close");

    const duplicate = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
      .find((button) => button.textContent === "Duplicate tab")!;
    await act(async () => duplicate.click());
    expect(sidebarActions.duplicateTab).toHaveBeenCalledWith("tab-1");

    await act(async () => tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    const color = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
      .find((button) => button.textContent === "Color")!;
    await act(async () => color.click());
    expect(container.querySelectorAll(".sidebar-color-swatch")).toHaveLength(8);
    const green = container.querySelector<HTMLButtonElement>("[aria-label='Set color green']")!;
    await act(async () => green.click());
    expect(sidebarActions.recolorTab).toHaveBeenCalledWith("tab-1", "green");

    await act(async () => tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    const move = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
      .find((button) => button.textContent === "Move to group")!;
    await act(async () => move.click());
    expect(container.querySelector("[role='menu']")?.textContent).toContain("Work");
    const work = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
      .find((button) => button.textContent === "Work")!;
    await act(async () => work.click());
    expect(sidebarActions.moveTab).toHaveBeenCalledWith("tab-1", "group-1", 1);
  });

  it("refocuses submenu content and restores the opener after an action", async () => {
    const sidebarActions = await renderSidebar();
    const tab = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;
    tab.focus();
    await act(async () => tab.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));
    const color = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
      .find((button) => button.textContent === "Color")!;

    await act(async () => color.click());
    const back = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
      .find((button) => button.textContent === "← Back")!;
    expect(document.activeElement).toBe(back);

    const green = container.querySelector<HTMLButtonElement>("[aria-label='Set color green']")!;
    await act(async () => green.click());
    expect(sidebarActions.recolorTab).toHaveBeenCalledWith("tab-1", "green");
    expect(document.activeElement).toBe(tab);
  });

  it("keeps focus in a rename editor opened from a context menu", async () => {
    const sidebarActions = await renderSidebar();
    const tab = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;
    tab.focus();
    await act(async () => tab.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));
    const rename = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
      .find((button) => button.textContent === "Rename")!;

    await act(async () => rename.click());

    const input = container.querySelector<HTMLInputElement>("input[aria-label='Rename powershell · one']")!;
    expect(document.activeElement).toBe(input);
    expect(sidebarActions.renameTab).not.toHaveBeenCalled();
  });

  it("shows Dismiss instead of Close for ended tabs", async () => {
    const sidebarActions = await renderSidebar();
    const dead = container.querySelector<HTMLElement>("[data-tab-id='tab-2']")!;
    await act(async () => dead.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));

    const text = container.querySelector("[role='menu']")?.textContent ?? "";
    expect(text).toContain("Dismiss");
    expect(text).not.toContain("Close");
    const dismiss = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
      .find((button) => button.textContent === "Dismiss")!;
    await act(async () => dismiss.click());
    expect(sidebarActions.dismissDeadTab).toHaveBeenCalledWith("tab-2");
  });

  it("renders the exact group menu without a group color action", async () => {
    const sidebarActions = await renderSidebar();
    const header = container.querySelector<HTMLElement>("[data-group-id='group-1'] .sidebar-group__header")!;
    await act(async () => header.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));

    const text = container.querySelector("[role='menu']")?.textContent ?? "";
    expect(text).toContain("Rename");
    expect(text).toContain("New tab in group");
    expect(text).toContain("Collapse");
    expect(text).toContain("Close group");
    expect(text).not.toContain("Color");
    const collapse = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
      .find((button) => button.textContent === "Collapse")!;
    await act(async () => collapse.click());
    expect(sidebarActions.toggleGroup).toHaveBeenCalledWith("group-1");
  });

  it("creates a named group from the sidebar background menu", async () => {
    const sidebarActions = await renderSidebar();
    const sidebar = container.querySelector<HTMLElement>(".sidebar")!;
    await act(async () => sidebar.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 30,
      clientY: 40,
    })));
    expect(container.querySelector("[role='menu']")?.textContent).toContain("New tab");
    const newGroup = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
      .find((button) => button.textContent === "New group")!;
    await act(async () => newGroup.click());

    const input = container.querySelector<HTMLInputElement>("input[aria-label='Name new group']")!;
    expect(document.activeElement).toBe(input);
    await act(async () => {
      input.value = "Infrastructure";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      key(input, "Enter");
    });
    expect(sidebarActions.createGroup).toHaveBeenCalledWith("Infrastructure");
  });

  it("offers the exact default and profile-specific creation actions", async () => {
    const sidebarActions = await renderSidebar();
    const primary = container.querySelector<HTMLButtonElement>("[aria-label='New terminal']")!;
    await act(async () => primary.click());
    expect(sidebarActions.createTab).toHaveBeenCalledWith({ groupId: null, profile: null });

    const options = container.querySelector<HTMLButtonElement>("[aria-label='New terminal options']")!;
    await act(async () => options.click());
    const choose = async (label: string) => {
      const button = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
        .find((candidate) => candidate.textContent === label)!;
      await act(async () => button.click());
    };
    await choose("Windows PowerShell");
    expect(sidebarActions.createTab).toHaveBeenLastCalledWith({ groupId: null, profile: "powershell" });

    await act(async () => options.click());
    await choose("Command Prompt");
    expect(sidebarActions.createTab).toHaveBeenLastCalledWith({ groupId: null, profile: "cmd" });
  });

  it("confirms group close and enters a pending state before dispatch completes", async () => {
    let resolve!: () => void;
    const sidebarActions = actions();
    sidebarActions.closeGroup = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    await renderSidebar(workspace(), sidebarActions);
    const header = container.querySelector<HTMLElement>("[data-group-id='group-1'] .sidebar-group__header")!;
    const groupName = container.querySelector<HTMLElement>("[data-group-name='group-1']")!;
    groupName.focus();
    await act(async () => header.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));
    const close = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
      .find((button) => button.textContent === "Close group")!;
    await act(async () => close.click());
    const dialog = container.querySelector<HTMLElement>("[role='dialog']")!;
    expect(dialog.textContent).toContain("Close group?");
    const cancel = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Cancel")!;
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Close group")!;
    expect(document.activeElement).toBe(cancel);

    await act(async () => { confirm.click(); });
    expect(sidebarActions.closeGroup).toHaveBeenCalledWith("group-1");
    expect(confirm.disabled).toBe(true);
    expect(container.textContent).toContain("Closing…");
    expect(document.activeElement).toBe(dialog);
    await act(async () => key(dialog, "Tab"));
    expect(document.activeElement).toBe(dialog);
    await act(async () => key(dialog, "Escape"));
    expect(container.querySelector("[role='dialog']")).toBe(dialog);
    expect(document.activeElement).toBe(dialog);

    await act(async () => resolve());
    expect(container.querySelector("[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(groupName);
  });
});
