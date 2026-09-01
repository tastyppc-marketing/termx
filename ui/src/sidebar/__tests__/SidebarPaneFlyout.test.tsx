/**
 * Rail hover flyout: rest the pointer on a tab row for three seconds and the
 * panes inside that tab are listed to the right of the rail.
 *
 * The reason it is a DWELL and not a hover: the rail is dragged across
 * constantly (reordering, dropping into groups, just travelling to the
 * terminal), and a panel that appeared on every pass would be noise. Three
 * seconds is "I stopped here because I want to know what is in this tab".
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Layout } from "../../state/layout";
import type {
  SidebarItemModel,
  SidebarTabModel,
  WorkspaceSnapshot,
} from "../../workspace/WorkspaceController";
import { Sidebar, type SidebarActions, type SidebarProps } from "../Sidebar";
import { HOVER_PANES_FLYOUT_MS } from "../PaneFlyout";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

/** One lone-pane tab and one tab split three ways. */
function workspace(): WorkspaceSnapshot {
  const lone = tabModel("tab-lone", { title: "Notes", primarySessionId: 7, sessionIds: [7] });
  const split = tabModel("tab-split", {
    title: "Build",
    primarySessionId: 1,
    sessionIds: [1, 2, 3],
  });
  const layout: Layout = {
    version: 3,
    auxWindows: {},
    windowNames: {},
    groups: {},
    rootItems: [
      { kind: "tab", id: "tab-lone" },
      { kind: "tab", id: "tab-split" },
    ],
    tabs: {
      "tab-lone": {
        id: "tab-lone",
        title: "Notes",
        color: "blue",
        fill: "off",
        split: { kind: "pane", sessionId: 7 },
      },
      "tab-split": {
        id: "tab-split",
        title: "Build",
        color: "blue",
        fill: "off",
        split: {
          kind: "split",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [
            { kind: "pane", sessionId: 1 },
            {
              kind: "split",
              dir: "col",
              sizes: [0.5, 0.5],
              children: [
                { kind: "pane", sessionId: 2 },
                { kind: "pane", sessionId: 3 },
              ],
            },
          ],
        },
      },
    },
    activeTabId: "tab-lone",
  };
  const rootItems: SidebarItemModel[] = [
    { kind: "tab", tab: lone },
    { kind: "tab", tab: split },
  ];
  return {
    layout,
    rootItems,
    ungroupedTabs: [lone, split],
    groups: [],
    paneStates: {
      1: { status: "live", exitCode: null },
      2: { status: "live", exitCode: null },
      3: { status: "live", exitCode: null },
      7: { status: "live", exitCode: null },
    },
    activeTabId: "tab-lone",
    activeSessionId: 7,
    persistence: { saving: false, error: null },
    notice: null,
  };
}

/** The same names the pane headers show, keyed the way the controller keys them. */
const PANE_TITLES: Record<string, Record<number, string>> = {
  "tab-lone": { 7: "Notes" },
  "tab-split": {
    1: "powershell · ui",
    2: "cmd · src-tauri",
    3: "powershell · docs",
  },
};

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

async function renderSidebar(props: Partial<SidebarProps> = {}) {
  const sidebarActions = actions();
  await act(async () =>
    root.render(
      <Sidebar
        snapshot={workspace()}
        actions={sidebarActions}
        paneTitles={(tabId) => PANE_TITLES[tabId] ?? {}}
        {...props}
      />,
    )
  );
  return sidebarActions;
}

function tabRow(id: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-tab-id='${id}']`)!;
}

function flyout(): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-testid='pane-flyout']");
}

function paneNames(): string[] {
  return [...container.querySelectorAll(".pane-flyout__pane")].map(
    (row) => row.textContent ?? "",
  );
}

async function fire(element: Element, type: string, init: PointerEventInit = {}) {
  await act(async () => {
    element.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, ...init }),
    );
  });
}

/**
 * React does not listen for `pointerenter`/`pointerleave` at all — it derives
 * them from `pointerover`/`pointerout` at the root. Dispatching the enter/leave
 * types directly reaches nothing (measured: zero handler calls), so the tests
 * send what a browser really sends.
 */
async function pointerEnter(element: Element) {
  await fire(element, "pointerover", { relatedTarget: null });
}

async function pointerLeave(element: Element, into: Element | null = null) {
  await fire(element, "pointerout", { relatedTarget: into });
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

/** Rest the pointer on a row long enough for the flyout to earn its place. */
async function dwellOn(id: string) {
  await pointerEnter(tabRow(id));
  await advance(HOVER_PANES_FLYOUT_MS);
}

describe("rail hover flyout — when it appears", () => {
  it("is exported as one tunable dwell constant", () => {
    expect(HOVER_PANES_FLYOUT_MS).toBe(3000);
  });

  it("stays away one millisecond short of the dwell, and arrives on it", async () => {
    await renderSidebar();

    await pointerEnter(tabRow("tab-split"));
    await advance(HOVER_PANES_FLYOUT_MS - 1);
    expect(flyout()).toBeNull();

    await advance(1);
    expect(flyout()).not.toBeNull();
  });

  it("never opens when the sidebar was given no pane-title source", async () => {
    await renderSidebar({ paneTitles: undefined });

    await dwellOn("tab-split");

    expect(flyout()).toBeNull();
  });

  it("does not take focus away from wherever the user was", async () => {
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    elsewhere.focus();
    await renderSidebar();

    await dwellOn("tab-split");

    expect(flyout()).not.toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe("rail hover flyout — what it lists", () => {
  it("names every pane of a split tab, in the order the panes are laid out", async () => {
    await renderSidebar();

    await dwellOn("tab-split");

    expect(paneNames()).toEqual([
      "powershell · ui",
      "cmd · src-tauri",
      "powershell · docs",
    ]);
  });

  it("lists a lone pane too, so the rail behaves the same everywhere", async () => {
    await renderSidebar();

    await dwellOn("tab-lone");

    expect(paneNames()).toEqual(["Notes"]);
  });

  it("falls back to the tab's own name for a pane the titles do not cover", async () => {
    await renderSidebar({ paneTitles: () => ({ 1: "powershell · ui" }) });

    await dwellOn("tab-split");

    expect(paneNames()).toEqual(["powershell · ui", "Build", "Build"]);
  });

  it("opens one flyout at a time, however many rows the pointer rests on", async () => {
    await renderSidebar();

    await dwellOn("tab-split");
    await pointerLeave(tabRow("tab-split"));
    await dwellOn("tab-lone");

    expect(container.querySelectorAll("[data-testid='pane-flyout']")).toHaveLength(1);
    expect(paneNames()).toEqual(["Notes"]);
  });
});

describe("rail hover flyout — everything that calls it off", () => {
  it("cancels when the pointer leaves before the dwell is up", async () => {
    await renderSidebar();

    await pointerEnter(tabRow("tab-split"));
    await advance(HOVER_PANES_FLYOUT_MS - 1);
    await pointerLeave(tabRow("tab-split"));
    await advance(HOVER_PANES_FLYOUT_MS);

    expect(flyout()).toBeNull();
  });

  it("cancels on pointerdown — the row is being clicked or dragged, not read", async () => {
    await renderSidebar();

    await pointerEnter(tabRow("tab-split"));
    await advance(HOVER_PANES_FLYOUT_MS - 1);
    await fire(tabRow("tab-split"), "pointerdown", { button: 0, isPrimary: true });
    await advance(HOVER_PANES_FLYOUT_MS);

    expect(flyout()).toBeNull();
  });

  it("cancels when the context menu takes over the row", async () => {
    await renderSidebar();

    await pointerEnter(tabRow("tab-split"));
    await advance(HOVER_PANES_FLYOUT_MS - 1);
    await act(async () => {
      tabRow("tab-split").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
    });
    await advance(HOVER_PANES_FLYOUT_MS);

    expect(flyout()).toBeNull();
  });

  it("never appears over an inline rename, and leaves if one begins", async () => {
    await renderSidebar();

    // A rename opened while the flyout is already up: it goes.
    await dwellOn("tab-split");
    expect(flyout()).not.toBeNull();
    await act(async () => {
      tabRow("tab-split").dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
      );
    });
    expect(flyout()).toBeNull();

    // And it will not come back while the editor is open.
    await dwellOn("tab-split");
    expect(flyout()).toBeNull();
  });

  it("closes on a click anywhere once it is open", async () => {
    await renderSidebar();
    await dwellOn("tab-split");

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });

    expect(flyout()).toBeNull();
  });

  it(
    "will not open over a drag in progress — the rows the ghost passes are " +
      "drop targets, not something the user is reading",
    async () => {
      await renderSidebar();
      // jsdom lays nothing out and has no hit testing; the drag only needs to
      // become ACTIVE here, not to land anywhere.
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: vi.fn(() => null),
      });
      const source = tabRow("tab-lone");
      const drag = (type: string, x: number, y: number) => {
        const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
        Object.defineProperties(event, {
          pointerId: { value: 7 },
          isPrimary: { value: true },
        });
        return event;
      };

      await act(async () => {
        source
          .querySelector(".sidebar-tab__title")!
          .dispatchEvent(drag("pointerdown", 10, 10));
      });
      await act(async () => source.dispatchEvent(drag("pointermove", 20, 40)));
      expect(container.querySelector(".sidebar-drag-ghost")).not.toBeNull();

      await dwellOn("tab-split");

      expect(flyout()).toBeNull();
    },
  );

  it("closes when the pointer leaves the row", async () => {
    await renderSidebar();
    await dwellOn("tab-split");

    await pointerLeave(tabRow("tab-split"));

    expect(flyout()).toBeNull();
  });
});

describe("rail hover flyout — Escape", () => {
  it("dismisses the flyout and lets nothing else see the key", async () => {
    await renderSidebar();
    await dwellOn("tab-split");
    const seenByEveryoneElse = vi.fn();
    window.addEventListener("keydown", seenByEveryoneElse);

    try {
      // Dispatched at a real element, not at `window`: stopping propagation
      // only means anything if the event has a path to travel.
      await act(async () => {
        tabRow("tab-split").dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      });
    } finally {
      window.removeEventListener("keydown", seenByEveryoneElse);
    }

    expect(flyout()).toBeNull();
    expect(seenByEveryoneElse).not.toHaveBeenCalled();
  });

  it(
    "hands Escape on to whatever already owns it — an armed confirm or an " +
      "open editor cancels itself, and the flyout merely gets out of the way",
    async () => {
      await renderSidebar();
      await dwellOn("tab-split");
      const owner = document.createElement("button");
      owner.setAttribute("data-esc-guard", "");
      document.body.append(owner);
      owner.focus();
      const ownerSaw = vi.fn();
      window.addEventListener("keydown", ownerSaw);

      try {
        await act(async () => {
          owner.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
          );
        });
      } finally {
        window.removeEventListener("keydown", ownerSaw);
        owner.remove();
      }

      expect(flyout()).toBeNull();
      expect(ownerSaw).toHaveBeenCalled();
    },
  );
});

describe("rail hover flyout — where it sits", () => {
  function rect(left: number, top: number, width: number, height: number): DOMRect {
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  }

  it("hangs off the right edge of the hovered row, clamped inside the viewport", async () => {
    // A row near the very bottom of a 768px-tall window, with a panel too tall
    // to hang from it: the panel has to ride up rather than run off the edge.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains("pane-flyout")) {
          return rect(0, 0, 220, 140);
        }
        if (this.classList.contains("sidebar-tab")) {
          return rect(0, 700, 252, 28);
        }
        return rect(0, 0, 0, 0);
      },
    );
    await renderSidebar();

    await dwellOn("tab-split");

    const panel = flyout()!;
    expect(panel.style.position).toBe("fixed");
    expect(panel.style.left).toBe("252px");
    // 768 - 140 - 8 padding = 620, so the panel stops short of the bottom.
    expect(panel.style.top).toBe("620px");
  });
});
