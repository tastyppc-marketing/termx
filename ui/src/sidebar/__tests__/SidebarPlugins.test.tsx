/**
 * Sidebar plugin entry points (plugin spec §4, Phase 1 T8): the "New <plugin>
 * tab" entries in every menu that creates a tab, the "Split with <plugin>"
 * entries in a tab's menu, and the manifest glyph a plugin tab wears on the
 * rail.
 *
 * Modelled on SidebarHosts.test.tsx — plugin entries are the SSH hosts' twin:
 * caller-supplied, listed under their own overline after the built-ins, and
 * absent entirely when the caller wires nothing.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyLayout } from "../../state/layout";
import type {
  SidebarItemModel,
  SidebarTabModel,
  WorkspaceSnapshot,
} from "../../workspace/WorkspaceController";
import {
  Sidebar,
  type SidebarActions,
  type SidebarPlugin,
  type SidebarProps,
} from "../Sidebar";

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

const SHOWROOM: SidebarPlugin = {
  id: "showroom",
  name: "Showroom",
  icon: "🖼",
  enabled: true,
};

const NOTES: SidebarPlugin = {
  id: "notes",
  name: "Notes",
  icon: "🗒",
  enabled: false,
};

function tabModel(
  id: string,
  overrides: Partial<SidebarTabModel> = {},
): SidebarTabModel {
  return {
    id,
    groupId: null,
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

/// One ungrouped tab plus one group holding a second tab: enough shape to open
/// all four menus (tab, group, background, create).
function snapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  const grouped = tabModel("tab-2", { groupId: "group-1", primarySessionId: 2, sessionIds: [2] });
  const rootItems: SidebarItemModel[] = [
    { kind: "tab", tab: tabModel("tab-1") },
    {
      kind: "group",
      group: {
        id: "group-1",
        parentGroupId: null,
        name: "Work",
        collapsed: false,
        color: null,
        depth: 1,
        items: [{ kind: "tab", tab: grouped }],
        tabs: [grouped],
      },
    },
  ];
  return {
    layout: emptyLayout(),
    rootItems,
    ungroupedTabs: [rootItems[0]!.kind === "tab" ? rootItems[0]!.tab : tabModel("tab-1")],
    groups: rootItems.flatMap((item) => item.kind === "group" ? [item.group] : []),
    paneStates: {
      1: { status: "live", exitCode: null },
      2: { status: "live", exitCode: null },
    },
    activeTabId: "tab-1",
    activeSessionId: 1,
    persistence: { saving: false, error: null },
    notice: null,
    ...overrides,
  };
}

function actions(overrides: Partial<SidebarActions> = {}): SidebarActions {
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
    ...overrides,
  };
}

async function renderSidebar(
  props: Partial<SidebarProps> = {},
  sidebarActions: SidebarActions = actions(),
) {
  await act(async () =>
    root.render(
      <Sidebar snapshot={snapshot()} actions={sidebarActions} {...props} />,
    )
  );
  return sidebarActions;
}

async function click(element: Element): Promise<void> {
  await act(async () =>
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
  );
}

async function openMenuOn(element: Element): Promise<void> {
  await act(async () =>
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))
  );
}

async function openCreateMenu(): Promise<void> {
  await click(
    container.querySelector<HTMLButtonElement>("[aria-label='New terminal options']")!,
  );
}

function tabRow(tabId: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-tab-id='${tabId}']`)!;
}

function groupHeader(groupId: string): HTMLElement {
  return container.querySelector<HTMLElement>(
    `[data-group-id='${groupId}'] .sidebar-group__header`,
  )!;
}

function menu(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".context-menu");
}

function item(testid: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`[data-testid='${testid}']`);
}

/// Menu contents in render order, headings included — the order convention
/// ("built-ins first, contributions under their own overline") is the thing
/// under test, not just the presence of an entry.
function menuOrder(): string[] {
  return [
    ...(menu()?.querySelectorAll<HTMLElement>(
      "[role='menuitem'], .context-menu__group",
    ) ?? []),
  ].map((element) => element.textContent ?? "");
}

describe("Sidebar plugin menu entries", () => {
  it("offers nothing when the caller wires no plugins", async () => {
    await renderSidebar();
    await openCreateMenu();

    expect(item("create-menu-plugin-showroom")).toBeNull();
    expect(menu()?.querySelector(".context-menu__group")).toBeNull();
  });

  it("offers nothing when the plugins are listed but the action is unwired", async () => {
    await renderSidebar({ plugins: [SHOWROOM] });
    await openCreateMenu();

    expect(item("create-menu-plugin-showroom")).toBeNull();
  });

  it("offers nothing when every listed plugin is disabled", async () => {
    await renderSidebar({ plugins: [NOTES] }, actions({ openPlugin: vi.fn() }));
    await openCreateMenu();

    expect(item("create-menu-plugin-notes")).toBeNull();
    // No plugins to head: the overline goes with the entries.
    expect(menuOrder()).not.toContain("Plugins");
  });

  it("lists enabled plugins under their own overline, after the built-ins", async () => {
    await renderSidebar(
      { plugins: [SHOWROOM, NOTES] },
      actions({ openPlugin: vi.fn() }),
    );
    await openCreateMenu();

    const order = menuOrder();
    expect(order).toContain("Plugins");
    // Disabled plugins are omitted outright, never greyed.
    expect(item("create-menu-plugin-notes")).toBeNull();
    const heading = order.indexOf("Plugins");
    expect(order.indexOf("Default")).toBeLessThan(heading);
    expect(order.indexOf("🖼New Showroom tab")).toBeGreaterThan(heading);
  });

  it("opens a plugin tab from the create menu and closes the menu first", async () => {
    const openPlugin = vi.fn();
    await renderSidebar({ plugins: [SHOWROOM] }, actions({ openPlugin }));
    await openCreateMenu();
    await click(item("create-menu-plugin-showroom")!);

    // "New Showroom tab" names its surface: the rail asks for a TAB, never the
    // manifest default, or the entry would stop meaning what it says the day a
    // plugin declares itself a split.
    expect(openPlugin).toHaveBeenCalledTimes(1);
    expect(openPlugin).toHaveBeenCalledWith("showroom", "tab", { groupId: null });
    expect(menu()).toBeNull();
  });

  it("opens a plugin tab from the sidebar background menu", async () => {
    const openPlugin = vi.fn();
    await renderSidebar({ plugins: [SHOWROOM] }, actions({ openPlugin }));
    await openMenuOn(container.querySelector(".sidebar")!);
    await click(item("create-menu-plugin-showroom")!);

    expect(openPlugin).toHaveBeenCalledWith("showroom", "tab", { groupId: null });
  });

  it("opens a plugin tab inside the group whose menu was used", async () => {
    const openPlugin = vi.fn();
    await renderSidebar({ plugins: [SHOWROOM] }, actions({ openPlugin }));
    await openMenuOn(groupHeader("group-1"));

    expect(item("create-menu-plugin-showroom")?.textContent).toBe(
      "🖼New Showroom tab in group",
    );
    await click(item("create-menu-plugin-showroom")!);

    // The group survives the trip through `openPlugin`: the controller has no
    // way to guess which group's menu the click came from.
    expect(openPlugin).toHaveBeenCalledWith("showroom", "tab", {
      groupId: "group-1",
    });
  });
});

describe("Sidebar plugin split entries", () => {
  it("offers no split when the action is unwired", async () => {
    await renderSidebar({ plugins: [SHOWROOM] }, actions({}));
    await openMenuOn(tabRow("tab-1"));

    expect(item("tab-menu-plugin-split-showroom")).toBeNull();
  });

  it("splits the tab's active pane to the right, before the destructive entry", async () => {
    const openPlugin = vi.fn();
    await renderSidebar({ plugins: [SHOWROOM, NOTES] }, actions({ openPlugin }));
    await openMenuOn(tabRow("tab-1"));

    const order = menuOrder();
    expect(item("tab-menu-plugin-split-notes")).toBeNull();
    expect(order).toContain("🖼Split with Showroom");
    // The destructive entry stays last, exactly as it does without plugins.
    expect(order.indexOf("🖼Split with Showroom")).toBeLessThan(order.indexOf("Close"));

    await click(item("tab-menu-plugin-split-showroom")!);

    expect(openPlugin).toHaveBeenCalledTimes(1);
    expect(openPlugin).toHaveBeenCalledWith("showroom", "split", {
      pane: { tabId: "tab-1", sessionId: 1 },
    });
    expect(menu()).toBeNull();
  });

  it("anchors on the tab's own first pane when the focus is in another tab", async () => {
    const openPlugin = vi.fn();
    await renderSidebar({ plugins: [SHOWROOM] }, actions({ openPlugin }));
    // tab-2 holds pane 2; the active pane (1) belongs to tab-1.
    await openMenuOn(tabRow("tab-2"));
    await click(item("tab-menu-plugin-split-showroom")!);

    // The pane travels with the call. Without it the controller would split
    // whatever has focus, which here is a pane in a different tab entirely.
    expect(openPlugin).toHaveBeenCalledWith("showroom", "split", {
      pane: { tabId: "tab-2", sessionId: 2 },
    });
  });

  it("anchors on the focused pane of a split tab", async () => {
    const openPlugin = vi.fn();
    const split = tabModel("tab-1", { primarySessionId: 1, sessionIds: [1, 5] });
    await act(async () =>
      root.render(
        <Sidebar
          snapshot={snapshot({
            rootItems: [{ kind: "tab", tab: split }],
            ungroupedTabs: [split],
            groups: [],
            activeSessionId: 5,
            paneStates: {
              1: { status: "live", exitCode: null },
              5: { status: "live", exitCode: null },
            },
          })}
          actions={actions({ openPlugin })}
          plugins={[SHOWROOM]}
        />,
      )
    );
    await openMenuOn(tabRow("tab-1"));
    await click(item("tab-menu-plugin-split-showroom")!);

    expect(openPlugin).toHaveBeenCalledWith("showroom", "split", {
      pane: { tabId: "tab-1", sessionId: 5 },
    });
  });
});

describe("Sidebar plugin tab rows", () => {
  it("marks a plugin tab with its manifest glyph", async () => {
    const panel = tabModel("tab-1", { title: "Showroom", primarySessionId: 9, sessionIds: [9] });
    await act(async () =>
      root.render(
        <Sidebar
          snapshot={snapshot({
            rootItems: [{ kind: "tab", tab: panel }],
            ungroupedTabs: [panel],
            groups: [],
            activeSessionId: null,
            paneStates: {
              9: {
                status: "plugin",
                exitCode: null,
                pluginId: "showroom",
                pluginUrl: null,
                pluginHealth: "up",
              },
            },
          })}
          actions={actions()}
          plugins={[SHOWROOM]}
        />,
      )
    );

    const glyph = tabRow("tab-1").querySelector(".sidebar-tab__glyph");
    expect(glyph?.textContent).toBe("🖼");
    // Decoration only — the tab's title already says "Showroom".
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
  });

  // The whole reason disabled plugins stay in the list: a pane bound to one the
  // user has since switched off must keep its identity on the rail, while the
  // menus that would open ANOTHER one stay shut.
  it("keeps the glyph on a pane whose plugin was switched off, and offers no entry", async () => {
    const panel = tabModel("tab-1", { title: "Showroom", primarySessionId: 9, sessionIds: [9] });
    await act(async () =>
      root.render(
        <Sidebar
          snapshot={snapshot({
            rootItems: [{ kind: "tab", tab: panel }],
            ungroupedTabs: [panel],
            groups: [],
            activeSessionId: null,
            paneStates: {
              9: {
                status: "plugin",
                exitCode: null,
                pluginId: "showroom",
                pluginUrl: null,
                pluginHealth: "up",
              },
            },
          })}
          actions={actions({ openPlugin: vi.fn() })}
          plugins={[{ ...SHOWROOM, enabled: false }]}
        />,
      )
    );

    expect(tabRow("tab-1").querySelector(".sidebar-tab__glyph")?.textContent).toBe("🖼");

    await openCreateMenu();
    expect(item("create-menu-plugin-showroom")).toBeNull();
    expect(menuOrder()).not.toContain("Plugins");
  });

  it("leaves a terminal tab unmarked", async () => {
    await renderSidebar({ plugins: [SHOWROOM] });

    expect(tabRow("tab-1").querySelector(".sidebar-tab__glyph")).toBeNull();
  });
});
