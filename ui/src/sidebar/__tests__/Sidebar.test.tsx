import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Layout } from "../../state/layout";
import type {
  SidebarGroupModel,
  SidebarItemModel,
  SidebarTabModel,
  WorkspaceSnapshot,
} from "../../workspace/WorkspaceController";
import { Sidebar, type SidebarActions, type SidebarProps } from "../Sidebar";

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

function tabModel(
  id: string,
  groupId: string | null,
  overrides: Partial<SidebarTabModel> = {},
): SidebarTabModel {
  return {
    id,
    groupId,
    title: id,
    color: "blue",
    fill: "off",
    primarySessionId: 1,
    sessionIds: [1],
    status: "live",
    activity: "idle",
    profile: "powershell",
    cwd: "C:\\one",
    ...overrides,
  };
}

function groupModel(
  id: string,
  name: string,
  items: readonly SidebarItemModel[],
  overrides: Partial<SidebarGroupModel> = {},
): SidebarGroupModel {
  return {
    id,
    parentGroupId: null,
    name,
    collapsed: false,
    color: null,
    depth: 1,
    items,
    tabs: items.flatMap((item) => item.kind === "tab" ? [item.tab] : []),
    ...overrides,
  };
}

/// Every group model reachable from `rootItems`, depth-first — the flat list
/// the controller publishes alongside the tree.
function flatGroups(items: readonly SidebarItemModel[]): SidebarGroupModel[] {
  return items.flatMap((item) =>
    item.kind === "group" ? [item.group, ...flatGroups(item.group.items)] : []
  );
}

function fromRoot(rootItems: readonly SidebarItemModel[], layout: Layout): WorkspaceSnapshot {
  return {
    layout,
    rootItems,
    ungroupedTabs: rootItems.flatMap((item) => item.kind === "tab" ? [item.tab] : []),
    groups: flatGroups(rootItems),
    paneStates: {
      1: { status: "live", exitCode: null },
      2: { status: "dead", exitCode: 0 },
      3: { status: "live", exitCode: null },
    },
    activeTabId: layout.activeTabId,
    activeSessionId: 1,
    persistence: { saving: false, error: null },
    notice: null,
  };
}

function workspace(): WorkspaceSnapshot {
  const layout: Layout = {
    version: 3,
    auxWindows: {},
    groups: {
      "group-1": {
        id: "group-1",
        name: "Work",
        collapsed: false,
        color: null,
        items: [{ kind: "tab", id: "tab-2" }],
      },
      "group-2": {
        id: "group-2",
        name: "Hidden",
        collapsed: true,
        color: null,
        items: [{ kind: "tab", id: "tab-3" }],
      },
    },
    rootItems: [
      { kind: "tab", id: "tab-1" },
      { kind: "group", id: "group-1" },
      { kind: "group", id: "group-2" },
    ],
    tabs: {
      "tab-1": {
        id: "tab-1",
        title: null,
        color: "blue",
        fill: "off",
        split: { kind: "pane", sessionId: 1 },
      },
      "tab-2": {
        id: "tab-2",
        title: "Exited shell",
        color: "red",
        fill: "off",
        split: { kind: "pane", sessionId: 2 },
      },
      "tab-3": {
        id: "tab-3",
        title: "Collapsed shell",
        color: "green",
        fill: "off",
        split: { kind: "pane", sessionId: 3 },
      },
    },
    activeTabId: "tab-1",
  };
  const rootItems: SidebarItemModel[] = [
    {
      kind: "tab",
      tab: tabModel("tab-1", null, {
        title: "powershell · one",
        activity: "unread",
      }),
    },
    {
      kind: "group",
      group: groupModel("group-1", "Work", [{
        kind: "tab",
        tab: tabModel("tab-2", "group-1", {
          title: "Exited shell",
          color: "red",
          primarySessionId: 2,
          sessionIds: [2],
          status: "dead",
          cwd: "C:\\two",
        }),
      }]),
    },
    {
      kind: "group",
      group: groupModel("group-2", "Hidden", [{
        kind: "tab",
        tab: tabModel("tab-3", "group-2", {
          title: "Collapsed shell",
          color: "green",
          primarySessionId: 3,
          sessionIds: [3],
          activity: "active",
          profile: "cmd",
          cwd: "C:\\three",
        }),
      }], { collapsed: true }),
    },
  ];
  return fromRoot(rootItems, layout);
}

function actions(): SidebarActions {
  return {
    activateTab: vi.fn(),
    renameTab: vi.fn(),
    recolorTab: vi.fn(),
    setTabFill: vi.fn(),
    recolorGroup: vi.fn(),
    moveItem: vi.fn(() => true),
    createGroup: vi.fn(() => "new-group"),
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

async function renderSidebar(
  snapshot = workspace(),
  sidebarActions = actions(),
  props: Partial<SidebarProps> = {},
) {
  await act(async () =>
    root.render(<Sidebar snapshot={snapshot} actions={sidebarActions} {...props} />)
  );
  return sidebarActions;
}

function menuItems(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
}

function menuItem(label: string): HTMLButtonElement {
  const found = menuItems().find((button) => button.textContent === label);
  if (!found) {
    throw new Error(`no menu item ${label}`);
  }
  return found;
}

async function openMenuOn(element: Element): Promise<void> {
  await act(async () => element.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  })));
}

function groupHeader(groupId: string): HTMLElement {
  return container.querySelector<HTMLElement>(
    `[data-group-id='${groupId}'] .sidebar-group__header`,
  )!;
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
    // The palette shows as the row's stripe colour, not a dot.
    expect(active.style.getPropertyValue("--tab-color")).toMatch(/^#[0-9a-f]{6}$/);
    expect(active.querySelector("[data-activity='unread']")).not.toBeNull();
    expect(active.querySelector("[aria-label='Close powershell · one']")).not.toBeNull();
    expect(dead.classList.contains("sidebar-tab--ended")).toBe(true);
    expect(dead.textContent).toContain("Exited");
    expect(group.querySelector("[data-color='slate']")).not.toBeNull();
  });

  it("renders the attention mark with its finished-needs-a-look label", async () => {
    const snapshot = workspace();
    const first = snapshot.rootItems[0];
    if (first?.kind !== "tab") throw new Error("fixture changed");
    Object.assign(first.tab, { activity: "attention" });
    await renderSidebar(snapshot);

    const row = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;
    const mark = row.querySelector("[data-activity='attention']");
    expect(mark).not.toBeNull();
    expect(mark!.getAttribute("aria-label")).toBe("Finished - needs a look");
  });

  it("says when the work finished, so a tab cannot sit done for an unknown age", async () => {
    const snapshot = workspace();
    const first = snapshot.rootItems[0];
    if (first?.kind !== "tab") throw new Error("fixture changed");
    const finishedAt = new Date(2026, 7, 25, 14, 32).getTime();
    Object.assign(first.tab, { activity: "attention", attentionSince: finishedAt });
    await renderSidebar(snapshot);

    const row = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;
    const badge = row.querySelector<HTMLElement>(".sidebar-tab__badge--done");
    expect(badge?.textContent).toBe("14:32");
    expect(badge?.getAttribute("title")).toBe("Finished at 14:32 and still waiting");
    expect(
      row.querySelector("[data-activity='attention']")!.getAttribute("aria-label"),
    ).toBe("Finished at 14:32 - needs a look");
  });

  it("shows no finished-at badge on a tab that is not waiting", async () => {
    await renderSidebar();
    const row = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;
    expect(row.querySelector(".sidebar-tab__badge--done")).toBeNull();
  });
});

/// Marketing > Clients > Acme, one tab at each level plus a root tab.
function nestedWorkspace(): WorkspaceSnapshot {
  const layout: Layout = {
    version: 3,
    auxWindows: {},
    groups: {
      marketing: {
        id: "marketing",
        name: "Marketing",
        collapsed: false,
        color: "blue",
        items: [{ kind: "tab", id: "tab-2" }, { kind: "group", id: "clients" }],
      },
      clients: {
        id: "clients",
        name: "Clients",
        collapsed: false,
        color: null,
        items: [{ kind: "group", id: "acme" }],
      },
      acme: {
        id: "acme",
        name: "Acme",
        collapsed: false,
        color: null,
        items: [{ kind: "tab", id: "tab-3" }],
      },
    },
    rootItems: [{ kind: "tab", id: "tab-1" }, { kind: "group", id: "marketing" }],
    tabs: {
      "tab-1": {
        id: "tab-1",
        title: null,
        color: "blue",
        fill: "off",
        split: { kind: "pane", sessionId: 1 },
      },
      "tab-2": {
        id: "tab-2",
        title: "Campaign",
        color: "red",
        fill: "off",
        split: { kind: "pane", sessionId: 2 },
      },
      "tab-3": {
        id: "tab-3",
        title: "Acme shell",
        color: "green",
        fill: "off",
        split: { kind: "pane", sessionId: 3 },
      },
    },
    activeTabId: "tab-1",
  };
  const acme = groupModel("acme", "Acme", [{
    kind: "tab",
    tab: tabModel("tab-3", "acme", { title: "Acme shell", primarySessionId: 3, sessionIds: [3] }),
  }], { parentGroupId: "clients", depth: 3 });
  const clients = groupModel("clients", "Clients", [{ kind: "group", group: acme }], {
    parentGroupId: "marketing",
    depth: 2,
  });
  const marketing = groupModel(
    "marketing",
    "Marketing",
    [
      {
        kind: "tab",
        tab: tabModel("tab-2", "marketing", {
          title: "Campaign",
          primarySessionId: 2,
          sessionIds: [2],
        }),
      },
      { kind: "group", group: clients },
    ],
    { color: "blue" },
  );
  return fromRoot(
    [
      { kind: "tab", tab: tabModel("tab-1", null, { title: "powershell · one" }) },
      { kind: "group", group: marketing },
    ],
    layout,
  );
}

describe("Sidebar nested groups", () => {
  it("renders a three-level tree with per-level aria-levels and group colors", async () => {
    await renderSidebar(nestedWorkspace());

    expect([...container.querySelectorAll("section[data-group-id]")]
      .map((node) => node.getAttribute("data-group-depth")))
      .toEqual(["1", "2", "3"]);
    expect(
      container.querySelector("[data-group-id='acme'] .sidebar-group__header")
        ?.getAttribute("aria-level"),
    ).toBe("3");
    expect(container.querySelector<HTMLElement>("[data-tab-id='tab-3']")
      ?.getAttribute("aria-level")).toBe("4");
    expect(container.querySelector<HTMLElement>("[data-tab-id='tab-1']")
      ?.getAttribute("aria-level")).toBe("1");
    // Subgroups nest inside their parent's container, not beside it.
    expect(container.querySelector(
      "[data-group-id='marketing'] [data-group-id='clients'] [data-group-id='acme']",
    )).not.toBeNull();
    expect(container.querySelector("[data-group-id='marketing'] [data-color='blue']"))
      .not.toBeNull();
  });

  it("collapsing a middle group hides only its own subtree", async () => {
    const base = nestedWorkspace();
    const marketing = base.rootItems[1]!;
    if (marketing.kind !== "group") {
      throw new Error("fixture");
    }
    const clients = marketing.group.items[1]!;
    if (clients.kind !== "group") {
      throw new Error("fixture");
    }
    const collapsed = fromRoot(
      [
        base.rootItems[0]!,
        {
          kind: "group",
          group: {
            ...marketing.group,
            items: [
              marketing.group.items[0]!,
              { kind: "group", group: { ...clients.group, collapsed: true } },
            ],
          },
        },
      ],
      base.layout,
    );

    await renderSidebar(collapsed);

    expect([...container.querySelectorAll("[data-tab-id]")]
      .map((node) => node.getAttribute("data-tab-id")))
      .toEqual(["tab-1", "tab-2"]);
    expect(container.querySelector("[data-group-id='acme']")).toBeNull();
    expect(container.querySelector("[data-group-id='clients']")).not.toBeNull();
  });

  it("activates a deeply nested tab on click", async () => {
    const sidebarActions = await renderSidebar(nestedWorkspace());
    const deep = container.querySelector<HTMLElement>("[data-tab-id='tab-3']")!;

    await act(async () => deep.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(sidebarActions.activateTab).toHaveBeenCalledWith("tab-3");
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

  it("opens a new terminal on a double-click of empty rail space", async () => {
    const sidebarActions = await renderSidebar();
    const scroll = container.querySelector<HTMLElement>(".sidebar__scroll")!;

    await act(async () =>
      scroll.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));

    expect(sidebarActions.createTab).toHaveBeenCalledWith({
      groupId: null,
      profile: null,
    });
  });

  it("keeps a double-click on a row meaning rename, never a new terminal", async () => {
    const sidebarActions = await renderSidebar();
    const tab = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;

    await act(async () => tab.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));

    expect(sidebarActions.createTab).not.toHaveBeenCalled();
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

    const base = workspace();
    const collapsed = fromRoot(
      base.rootItems.map((item) =>
        item.kind === "group" && item.group.id === "group-1"
          ? { kind: "group", group: { ...item.group, collapsed: true } }
          : item
      ),
      {
        ...base.layout,
        groups: {
          ...base.layout.groups,
          "group-1": { ...base.layout.groups["group-1"]!, collapsed: true },
        },
      },
    );
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
    expect(sidebarActions.moveItem).not.toHaveBeenCalled();

    await act(async () => row.dispatchEvent(pointer("pointermove", { x: 20, y: 25 })));
    expect(container.querySelector(".sidebar-drag-ghost")?.textContent).toContain("powershell · one");
    expect(container.querySelector(".sidebar-drag-indicator")).not.toBeNull();
    expect(sidebarActions.moveItem).not.toHaveBeenCalled();

    await act(async () => row.dispatchEvent(pointer("pointerup", { x: 20, y: 25 })));
    expect(sidebarActions.moveItem).toHaveBeenCalledTimes(1);
    expect(sidebarActions.moveItem)
      .toHaveBeenCalledWith({ kind: "tab", id: "tab-1" }, "group-1", 0);
    expect(container.querySelector(".sidebar-drag-ghost")).toBeNull();
  });

  it("moves a grouped tab to the root when the root holds no tabs", async () => {
    const base = workspace();
    const emptyRoot = fromRoot(
      base.rootItems.filter((item) => item.kind === "group"),
      {
        ...base.layout,
        rootItems: base.layout.rootItems.filter((item) => item.kind === "group"),
        activeTabId: "tab-2",
      },
    );
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

    // The root container appends at its tail — past the two group rows.
    expect(sidebarActions.moveItem)
      .toHaveBeenCalledWith({ kind: "tab", id: "tab-2" }, null, 2);
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
    expect(sidebarActions.moveItem).not.toHaveBeenCalled();

    await act(async () => title.dispatchEvent(pointer("pointerdown")));
    await act(async () => row.dispatchEvent(pointer("pointermove", { x: 10 })));
    await act(async () => key(window.document.body, "Escape"));
    await act(async () => row.dispatchEvent(pointer("pointerup", { x: 10 })));

    await act(async () => title.dispatchEvent(pointer("pointerdown")));
    await act(async () => row.dispatchEvent(pointer("pointermove", { x: 10 })));
    await act(async () => row.dispatchEvent(pointer("pointercancel", { x: 10 })));
    expect(sidebarActions.moveItem).not.toHaveBeenCalled();
  });
});

/// Rects the nested fixture's rows would have on screen: 40 px tall, stacked in
/// render order. jsdom lays nothing out, so drops need them stubbed.
function stubRow(selector: string, top: number): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector)!;
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 0, y: top, width: 200, height: 40, top, right: 200, bottom: top + 40, left: 0,
    toJSON: () => ({}),
  });
  return element;
}

function dropOn(target: HTMLElement): void {
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(() => target),
  });
}

describe("Sidebar nested drag and drop", () => {
  it("nests a tab into a group dropped on the middle of its header", async () => {
    const sidebarActions = await renderSidebar(nestedWorkspace());
    const row = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;
    const title = row.querySelector<HTMLElement>(".sidebar-tab__title")!;
    dropOn(stubRow("[data-group-id='marketing'] > .sidebar-group__header", 40));

    await act(async () => title.dispatchEvent(pointer("pointerdown", { x: 10, y: 10 })));
    await act(async () => row.dispatchEvent(pointer("pointermove", { x: 10, y: 60 })));
    expect(container.querySelector(".sidebar-drag-indicator")).not.toBeNull();
    await act(async () => row.dispatchEvent(pointer("pointerup", { x: 10, y: 60 })));

    // Marketing already holds a tab and a subgroup, so nesting appends at 2.
    expect(sidebarActions.moveItem)
      .toHaveBeenCalledWith({ kind: "tab", id: "tab-1" }, "marketing", 2);
  });

  it("inserts between rows into the row's own container", async () => {
    const sidebarActions = await renderSidebar(nestedWorkspace());
    const row = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;
    const title = row.querySelector<HTMLElement>(".sidebar-tab__title")!;
    dropOn(stubRow("[data-tab-id='tab-3']", 120));

    await act(async () => title.dispatchEvent(pointer("pointerdown", { x: 10, y: 10 })));
    // Below the midpoint of Acme's only tab: the slot after it.
    await act(async () => row.dispatchEvent(pointer("pointermove", { x: 10, y: 150 })));
    await act(async () => row.dispatchEvent(pointer("pointerup", { x: 10, y: 150 })));

    expect(sidebarActions.moveItem)
      .toHaveBeenCalledWith({ kind: "tab", id: "tab-1" }, "acme", 1);
  });

  it("shows no indicator and moves nothing when a group is dropped in its own subtree", async () => {
    const sidebarActions = await renderSidebar(nestedWorkspace());
    const header = container.querySelector<HTMLElement>(
      "[data-group-id='clients'] > .sidebar-group__header",
    )!;
    const name = container.querySelector<HTMLElement>("[data-group-name='clients']")!;
    dropOn(stubRow("[data-group-id='acme'] > .sidebar-group__header", 120));

    await act(async () => name.dispatchEvent(pointer("pointerdown", { x: 10, y: 90 })));
    await act(async () => header.dispatchEvent(pointer("pointermove", { x: 10, y: 140 })));
    expect(container.querySelector(".sidebar-drag-ghost")).not.toBeNull();
    expect(container.querySelector(".sidebar-drag-indicator")).toBeNull();

    await act(async () => header.dispatchEvent(pointer("pointerup", { x: 10, y: 140 })));
    expect(sidebarActions.moveItem).not.toHaveBeenCalled();
  });

  it("reorders a group inside its own container from a header edge", async () => {
    const sidebarActions = await renderSidebar(nestedWorkspace());
    const header = container.querySelector<HTMLElement>(
      "[data-group-id='marketing'] > .sidebar-group__header",
    )!;
    const name = container.querySelector<HTMLElement>("[data-group-name='marketing']")!;
    dropOn(stubRow("[data-tab-id='tab-1']", 0));

    await act(async () => name.dispatchEvent(pointer("pointerdown", { x: 10, y: 50 })));
    // Above the midpoint of the root tab: the slot before it.
    await act(async () => header.dispatchEvent(pointer("pointermove", { x: 10, y: 10 })));
    await act(async () => header.dispatchEvent(pointer("pointerup", { x: 10, y: 10 })));

    expect(sidebarActions.moveItem)
      .toHaveBeenCalledWith({ kind: "group", id: "marketing" }, null, 0);
  });
});

describe("Sidebar nesting menus", () => {
  it("gates New subgroup on the depth setting with a settings tooltip", async () => {
    await renderSidebar(nestedWorkspace());

    await openMenuOn(groupHeader("clients"));
    expect(menuItem("New subgroup").disabled).toBe(false);

    await openMenuOn(groupHeader("acme"));
    const blocked = menuItem("New subgroup");
    expect(blocked.disabled).toBe(true);
    expect(blocked.title).toBe("Max group depth is 3 — change it in Settings");
  });

  it("honors a raised depth setting", async () => {
    await renderSidebar(nestedWorkspace(), actions(), { maxGroupDepth: 4 });

    await openMenuOn(groupHeader("acme"));
    expect(menuItem("New subgroup").disabled).toBe(false);
  });

  it("creates a subgroup under the group its menu came from", async () => {
    const sidebarActions = await renderSidebar(nestedWorkspace());
    await openMenuOn(groupHeader("clients"));

    await act(async () => menuItem("New subgroup").click());
    const input = container.querySelector<HTMLInputElement>("input[aria-label='Name new group']")!;
    await act(async () => {
      input.value = "Globex";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      key(input, "Enter");
    });

    expect(sidebarActions.createGroup).toHaveBeenCalledWith("clients", "Globex");
  });

  it("offers a group only the move targets outside its own subtree", async () => {
    const sidebarActions = await renderSidebar(nestedWorkspace());
    await openMenuOn(groupHeader("clients"));

    await act(async () => menuItem("Move to…").click());
    // Marketing is Clients' own container; Clients and Acme are its subtree.
    expect(menuItems().map((button) => button.textContent))
      .toEqual(["← Back", "Top level"]);

    await act(async () => menuItem("Top level").click());
    expect(sidebarActions.moveItem)
      .toHaveBeenCalledWith({ kind: "group", id: "clients" }, null, 2);
  });

  it("offers a tab every group but its own", async () => {
    const sidebarActions = await renderSidebar(nestedWorkspace());
    await openMenuOn(container.querySelector("[data-tab-id='tab-3']")!);

    await act(async () => menuItem("Move to…").click());
    expect(menuItems().map((button) => button.textContent))
      .toEqual(["← Back", "Ungrouped", "Marketing", "Clients"]);

    await act(async () => menuItem("Clients").click());
    expect(sidebarActions.moveItem)
      .toHaveBeenCalledWith({ kind: "tab", id: "tab-3" }, "clients", 1);
  });

  it("creates a new tab inside the nested group its menu came from", async () => {
    const sidebarActions = await renderSidebar(nestedWorkspace());
    await openMenuOn(groupHeader("acme"));

    await act(async () => menuItem("New tab in group").click());

    expect(sidebarActions.createTab).toHaveBeenCalledWith({
      groupId: "acme",
      profile: null,
    });
  });

  it("deletes a group keeping or closing its terminals", async () => {
    const sidebarActions = await renderSidebar();

    await openMenuOn(groupHeader("group-1"));
    await act(async () => menuItem("Delete group").click());
    const dialog = container.querySelector<HTMLElement>("[role='dialog']")!;
    expect(dialog.textContent).toContain("Delete group?");
    const keep = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Keep terminals")!;
    await act(async () => keep.click());
    expect(sidebarActions.deleteGroup).toHaveBeenCalledWith("group-1", "keep-children");

    await openMenuOn(groupHeader("group-1"));
    await act(async () => menuItem("Delete group").click());
    const close = [...container.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")]
      .find((button) => button.textContent === "Close terminals")!;
    await act(async () => close.click());
    expect(sidebarActions.deleteGroup).toHaveBeenLastCalledWith("group-1", "close-tabs");
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
    expect(container.querySelector("[role='menu']")?.textContent).toContain("Move to…");
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
      .find((button) => button.textContent === "Move to…")!;
    await act(async () => move.click());
    expect(container.querySelector("[role='menu']")?.textContent).toContain("Work");
    const work = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
      .find((button) => button.textContent === "Work")!;
    await act(async () => work.click());
    expect(sidebarActions.moveItem)
      .toHaveBeenCalledWith({ kind: "tab", id: "tab-1" }, "group-1", 1);
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

  it("renders the exact group menu, colour action included", async () => {
    const sidebarActions = await renderSidebar();
    const header = container.querySelector<HTMLElement>("[data-group-id='group-1'] .sidebar-group__header")!;
    await act(async () => header.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));

    const text = container.querySelector("[role='menu']")?.textContent ?? "";
    expect(text).toContain("Rename");
    expect(text).toContain("New tab in group");
    expect(text).toContain("New subgroup");
    expect(text).toContain("Move to…");
    expect(text).toContain("Collapse");
    expect(text).toContain("Delete group");
    // Groups are colourable now (theme spec §5); the panel itself is covered
    // in SidebarColors.test.tsx.
    expect(text).toContain("Color");
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
    expect(sidebarActions.createGroup).toHaveBeenCalledWith(null, "Infrastructure");
  });

  it("refuses to offer a new terminal while the host connection is down", async () => {
    await act(async () =>
      root.render(<Sidebar snapshot={workspace()} actions={actions()} hostConnected={false} />),
    );

    const primary = container.querySelector<HTMLButtonElement>("[aria-label='New terminal']")!;
    const options = container.querySelector<HTMLButtonElement>(
      "[aria-label='New terminal options']",
    )!;
    expect(primary.disabled).toBe(true);
    expect(primary.title).toBe("Waiting for host…");
    expect(options.disabled).toBe(true);
    expect(options.title).toBe("Waiting for host…");
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

  it("confirms group deletion and enters a pending state before dispatch completes", async () => {
    let resolve!: () => void;
    const sidebarActions = actions();
    sidebarActions.deleteGroup = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    await renderSidebar(workspace(), sidebarActions);
    const header = container.querySelector<HTMLElement>("[data-group-id='group-1'] .sidebar-group__header")!;
    const groupName = container.querySelector<HTMLElement>("[data-group-name='group-1']")!;
    groupName.focus();
    await act(async () => header.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));
    const close = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
      .find((button) => button.textContent === "Delete group")!;
    await act(async () => close.click());
    const dialog = container.querySelector<HTMLElement>("[role='dialog']")!;
    expect(dialog.textContent).toContain("Delete group?");
    const cancel = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Cancel")!;
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Close terminals")!;
    expect(document.activeElement).toBe(cancel);

    await act(async () => { confirm.click(); });
    expect(sidebarActions.deleteGroup).toHaveBeenCalledWith("group-1", "close-tabs");
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

describe("move to window (multi-window Phase 1)", () => {
  function menuItems(): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
  }

  it("offers new-window and other-window entries on the tab menu", async () => {
    const sidebarActions = {
      ...actions(),
      moveItemToWindow: vi.fn(() => "aux-1"),
    };
    await renderSidebar(
      { ...workspace(), windowIds: ["main", "aux-1"] },
      sidebarActions,
    );
    const tab = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;
    await act(async () => tab.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));

    const labels = menuItems().map((button) => button.textContent);
    expect(labels).toContain("Move to new window");
    expect(labels).toContain("Move to Window 2");
    expect(labels).not.toContain("Move to Main window"); // it IS the main window

    const entry = menuItems().find((button) =>
      button.textContent === "Move to new window"
    )!;
    await act(async () => entry.click());
    expect(sidebarActions.moveItemToWindow).toHaveBeenCalledWith(
      { kind: "tab", id: "tab-1" },
      "new",
    );
  });

  it("moves a group to an existing window from its menu", async () => {
    const sidebarActions = {
      ...actions(),
      moveItemToWindow: vi.fn(() => "aux-1"),
    };
    await renderSidebar(
      { ...workspace(), windowIds: ["main", "aux-1"] },
      sidebarActions,
    );
    await act(async () => groupHeader("group-1").dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));

    const entry = menuItems().find((button) =>
      button.textContent === "Move to Window 2"
    )!;
    await act(async () => entry.click());
    expect(sidebarActions.moveItemToWindow).toHaveBeenCalledWith(
      { kind: "group", id: "group-1" },
      "aux-1",
    );
  });

  it("offers Main window from an aux window's sidebar", async () => {
    const sidebarActions = {
      ...actions(),
      moveItemToWindow: vi.fn(() => "main"),
    };
    await renderSidebar(
      { ...workspace(), windowIds: ["main", "aux-1"] },
      sidebarActions,
      { windowId: "aux-1" },
    );
    const tab = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;
    await act(async () => tab.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));

    const labels = menuItems().map((button) => button.textContent);
    expect(labels).toContain("Move to Main window");
    expect(labels).not.toContain("Move to Window 2"); // its own window

    const entry = menuItems().find((button) =>
      button.textContent === "Move to Main window"
    )!;
    await act(async () => entry.click());
    expect(sidebarActions.moveItemToWindow).toHaveBeenCalledWith(
      { kind: "tab", id: "tab-1" },
      "main",
    );
  });

  it("hides the entries when the action is not provided", async () => {
    await renderSidebar({ ...workspace(), windowIds: ["main", "aux-1"] });
    const tab = container.querySelector<HTMLElement>("[data-tab-id='tab-1']")!;
    await act(async () => tab.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));
    const labels = menuItems().map((button) => button.textContent);
    expect(labels).not.toContain("Move to new window");
    expect(labels).not.toContain("Move to Window 2");
  });
});
