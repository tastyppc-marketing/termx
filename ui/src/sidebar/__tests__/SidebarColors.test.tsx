/**
 * Tab stripe + fill and colourable group frames (theme spec §5).
 *
 * The complaint this closes: a red tab inside a blue group used to muddy into
 * illegibility. The stripe is solid and never blended, so it survives any
 * group wash behind it.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutV2 } from "../../state/layout";
import { applyTheme } from "../../theme/ThemeProvider";
import { DEFAULT_THEME_ID, resolveTabColor, THEMES } from "../../theme/themes";
import type {
  SidebarGroupModel,
  SidebarItemModel,
  SidebarTabModel,
  WorkspaceSnapshot,
} from "../../workspace/WorkspaceController";
import { Sidebar, type SidebarActions } from "../Sidebar";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  applyTheme(DEFAULT_THEME_ID);
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
  applyTheme(DEFAULT_THEME_ID);
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
  items: readonly SidebarItemModel[],
  overrides: Partial<SidebarGroupModel> = {},
): SidebarGroupModel {
  return {
    id,
    parentGroupId: null,
    name: id,
    collapsed: false,
    color: null,
    depth: 1,
    items,
    tabs: items.flatMap((item) => (item.kind === "tab" ? [item.tab] : [])),
    ...overrides,
  };
}

/**
 * The exact shape of Michael's complaint: a BLUE group holding a RED tab, an
 * orange tab with a strong fill, plus a neutral group and a plain root tab.
 */
function coloredWorkspace(): WorkspaceSnapshot {
  const layout: LayoutV2 = {
    version: 2,
    groups: {
      blue: {
        id: "blue",
        name: "blue",
        collapsed: false,
        color: "blue",
        items: [{ kind: "tab", id: "red-tab" }, { kind: "tab", id: "orange-tab" }],
      },
      plain: {
        id: "plain",
        name: "plain",
        collapsed: false,
        color: null,
        items: [{ kind: "tab", id: "green-tab" }],
      },
    },
    rootItems: [
      { kind: "tab", id: "root-tab" },
      { kind: "group", id: "blue" },
      { kind: "group", id: "plain" },
    ],
    tabs: {
      "root-tab": { id: "root-tab", title: null, color: "blue", fill: "off", split: { kind: "pane", sessionId: 1 } },
      "red-tab": { id: "red-tab", title: null, color: "red", fill: "subtle", split: { kind: "pane", sessionId: 1 } },
      "orange-tab": { id: "orange-tab", title: null, color: "orange", fill: "strong", split: { kind: "pane", sessionId: 1 } },
      "green-tab": { id: "green-tab", title: null, color: "green", fill: "off", split: { kind: "pane", sessionId: 1 } },
    },
    activeTabId: "root-tab",
  };
  const rootItems: SidebarItemModel[] = [
    { kind: "tab", tab: tabModel("root-tab", null) },
    {
      kind: "group",
      group: groupModel(
        "blue",
        [
          { kind: "tab", tab: tabModel("red-tab", "blue", { color: "red", fill: "subtle" }) },
          { kind: "tab", tab: tabModel("orange-tab", "blue", { color: "orange", fill: "strong" }) },
        ],
        { color: "blue" },
      ),
    },
    {
      kind: "group",
      group: groupModel("plain", [
        { kind: "tab", tab: tabModel("green-tab", "plain", { color: "green" }) },
      ]),
    },
  ];
  return {
    layout,
    rootItems,
    ungroupedTabs: [tabModel("root-tab", null)],
    groups: rootItems.flatMap((item) => (item.kind === "group" ? [item.group] : [])),
    paneStates: { 1: { status: "live", exitCode: null } },
    activeTabId: "root-tab",
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

async function renderSidebar(sidebarActions = actions()) {
  await act(async () =>
    root.render(<Sidebar snapshot={coloredWorkspace()} actions={sidebarActions} />)
  );
  return sidebarActions;
}

function tabRow(id: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-tab-id='${id}']`)!;
}

function groupSection(id: string): HTMLElement {
  return container.querySelector<HTMLElement>(`section[data-group-id='${id}']`)!;
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
  await act(async () =>
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))
  );
}

describe("tab stripe", () => {
  it("carries the tab's palette colour, resolved through the active theme", async () => {
    await renderSidebar();
    const theme = THEMES[DEFAULT_THEME_ID];

    expect(tabRow("red-tab").style.getPropertyValue("--tab-color"))
      .toBe(resolveTabColor(theme, "red"));
    expect(tabRow("green-tab").style.getPropertyValue("--tab-color"))
      .toBe(resolveTabColor(theme, "green"));
    // Full opacity, never blended: a red tab in a blue group stays red.
    expect(tabRow("red-tab").style.getPropertyValue("--tab-color")).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("re-resolves through the theme's own tab palette when the theme changes", async () => {
    await renderSidebar();
    const before = tabRow("red-tab").style.getPropertyValue("--tab-color");

    await act(async () => applyTheme("paper-light"));

    const after = tabRow("red-tab").style.getPropertyValue("--tab-color");
    expect(after).toBe(resolveTabColor(THEMES["paper-light"], "red"));
    expect(after).not.toBe(before);
  });

  it("replaces the colour dot entirely", async () => {
    await renderSidebar();
    expect(container.querySelector(".sidebar-tab__color")).toBeNull();
    expect(tabRow("red-tab").querySelector("[data-color]")).toBeNull();
  });
});

describe("tab fill", () => {
  it("classes each row by its fill strength", async () => {
    await renderSidebar();
    expect(tabRow("root-tab").className).not.toContain("sidebar-tab--fill");
    expect(tabRow("red-tab").className).toContain("sidebar-tab--fill-subtle");
    expect(tabRow("orange-tab").className).toContain("sidebar-tab--fill-strong");
  });

  it("sets the fill from the colour submenu", async () => {
    const sidebarActions = await renderSidebar();
    await openMenuOn(tabRow("red-tab"));
    await act(async () => menuItem("Color").click());

    expect(menuItems().map((button) => button.textContent)).toEqual(
      expect.arrayContaining(["Off", "Subtle", "Strong"]),
    );
    await act(async () => menuItem("Strong").click());
    expect(sidebarActions.setTabFill).toHaveBeenCalledWith("red-tab", "strong");

    await openMenuOn(tabRow("orange-tab"));
    await act(async () => menuItem("Color").click());
    await act(async () => menuItem("Off").click());
    expect(sidebarActions.setTabFill).toHaveBeenCalledWith("orange-tab", "off");
  });

  it("marks the current fill as the pressed option", async () => {
    await renderSidebar();
    await openMenuOn(tabRow("red-tab"));
    await act(async () => menuItem("Color").click());
    expect(menuItem("Subtle").getAttribute("aria-pressed")).toBe("true");
    expect(menuItem("Off").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("group frame", () => {
  it("frames and washes only a coloured group", async () => {
    await renderSidebar();
    const theme = THEMES[DEFAULT_THEME_ID];

    const blue = groupSection("blue");
    expect(blue.style.getPropertyValue("--group-color")).toBe(resolveTabColor(theme, "blue"));
    expect(blue.className).toContain("sidebar-group--colored");

    const plain = groupSection("plain");
    expect(plain.style.getPropertyValue("--group-color")).toBe("");
    expect(plain.className).not.toContain("sidebar-group--colored");
  });

  it("keeps the header dot, neutral when the group has no colour", async () => {
    await renderSidebar();
    const theme = THEMES[DEFAULT_THEME_ID];

    expect(
      groupSection("blue").querySelector<HTMLElement>(".sidebar-group__color")!.style.backgroundColor,
    ).not.toBe("");
    const plainDot = groupSection("plain")
      .querySelector<HTMLElement>(".sidebar-group__color")!;
    expect(plainDot.dataset.color).toBe("slate");
    expect(plainDot.style.backgroundColor).toBe(hexToRgb(resolveTabColor(theme, "slate")));
  });

  it("recolours a group from its menu, including back to none", async () => {
    const sidebarActions = await renderSidebar();
    await openMenuOn(
      groupSection("plain").querySelector<HTMLElement>(".sidebar-group__header")!,
    );
    await act(async () => menuItem("Color").click());
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[aria-label='Set color magenta']")!.click();
    });
    expect(sidebarActions.recolorGroup).toHaveBeenCalledWith("plain", "magenta");

    await openMenuOn(
      groupSection("blue").querySelector<HTMLElement>(".sidebar-group__header")!,
    );
    await act(async () => menuItem("Color").click());
    await act(async () => menuItem("None").click());
    expect(sidebarActions.recolorGroup).toHaveBeenCalledWith("blue", null);
  });
});

describe("colour swatches", () => {
  it("paints each swatch with the theme-resolved colour, not a fixed hex", async () => {
    await renderSidebar();
    await openMenuOn(tabRow("red-tab"));
    await act(async () => menuItem("Color").click());

    const theme = THEMES[DEFAULT_THEME_ID];
    const green = container.querySelector<HTMLButtonElement>("[aria-label='Set color green']")!;
    expect(green.style.backgroundColor).toBe(hexToRgb(resolveTabColor(theme, "green")));
  });
});

/** jsdom reports inline colours as `rgb(r, g, b)`. */
function hexToRgb(hex: string): string {
  const value = hex.replace("#", "");
  const channel = (index: number) => Number.parseInt(value.slice(index, index + 2), 16);
  return `rgb(${channel(0)}, ${channel(2)}, ${channel(4)})`;
}
