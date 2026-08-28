import { describe, expect, it } from "vitest";
import { groupDepth, MAX_GROUP_DEPTH, validateInvariants } from "../layout";
import type { FillStrength, Layout, PaletteId, SplitNode } from "../layout";
import { createLayoutStore } from "../store";
import { baseLayout, groupItem, tabItem } from "./helpers";

function store(initial: Layout = baseLayout()) {
  return createLayoutStore(initial);
}

function rootSplit(state: Layout, tabId: string): SplitNode {
  return state.tabs[tabId].split;
}

/// Ids of a container's items in order, tabs and subgroups alike.
function itemIds(state: Layout, groupId: string | null): string[] {
  const items = groupId === null ? state.rootItems : state.groups[groupId]!.items;
  return items.map((item) => item.id);
}

describe("createTab", () => {
  it("appends ungrouped by default and focuses the new tab", () => {
    const s = store();
    const next = s.createTab({ id: "t9", sessionId: 9 });
    expect(next.rootItems).toEqual([
      tabItem("t1"),
      tabItem("t2"),
      groupItem("g1"),
      tabItem("t9"),
    ]);
    expect(next.activeTabId).toBe("t9");
    expect(next.tabs.t9).toEqual({
      id: "t9",
      title: null,
      color: "slate",
      fill: "off",
      split: { kind: "pane", sessionId: 9 },
    });
  });

  it("inserts into a group at a clamped index", () => {
    const s = store();
    const next = s.createTab({ id: "t9", sessionId: 9, groupId: "g1", index: 99 });
    expect(itemIds(next, "g1")).toEqual(["t3", "t9"]);
  });

  it("trims a provided title", () => {
    const s = store();
    const next = s.createTab({ id: "t9", sessionId: 9, title: "  build  " });
    expect(next.tabs.t9.title).toBe("build");
  });

  it("rejects a session id already shown somewhere", () => {
    const s = store();
    expect(s.createTab({ id: "t9", sessionId: 3 })).toBe(s.getState());
  });

  it("rejects duplicate tab ids, unknown groups, and bad titles", () => {
    const s = store();
    const before = s.getState();
    expect(s.createTab({ id: "t1", sessionId: 9 })).toBe(before);
    expect(s.createTab({ id: "t9", sessionId: 9, groupId: "nope" })).toBe(before);
    expect(s.createTab({ id: "t9", sessionId: 9, title: "   " })).toBe(before);
    expect(s.createTab({ id: "", sessionId: 9 })).toBe(before);
    expect(s.createTab({ id: "t9", sessionId: -1 })).toBe(before);
  });
});

describe("closeTab", () => {
  it("activates the next tab in render order", () => {
    const s = store();
    const next = s.closeTab("t1");
    expect(itemIds(next, null)).toEqual(["t2", "g1"]);
    expect(next.activeTabId).toBe("t2");
    expect(next.tabs).not.toHaveProperty("t1");
  });

  it("falls back to the previous tab at the end of the order", () => {
    const s = store();
    s.setActiveTab("t3");
    expect(s.closeTab("t3").activeTabId).toBe("t2");
  });

  it("keeps the active tab when closing another", () => {
    const s = store();
    expect(s.closeTab("t3").activeTabId).toBe("t1");
  });

  it("clears activeTabId when the last tab closes", () => {
    const s = store();
    s.closeTab("t1");
    s.closeTab("t2");
    const next = s.closeTab("t3");
    expect(next.activeTabId).toBeNull();
    expect(next.tabs).toEqual({});
  });

  it("ignores unknown tabs", () => {
    const s = store();
    expect(s.closeTab("ghost")).toBe(s.getState());
  });
});

describe("renameTab", () => {
  it("trims and applies", () => {
    const s = store();
    expect(s.renameTab("t1", "  deploy  ").tabs.t1.title).toBe("deploy");
  });

  it("null resets to the derived title", () => {
    const s = store();
    s.renameTab("t1", "deploy");
    expect(s.renameTab("t1", null).tabs.t1.title).toBeNull();
  });

  it("rejects empty, whitespace-only, and over-long titles", () => {
    const s = store();
    const before = s.getState();
    expect(s.renameTab("t1", "")).toBe(before);
    expect(s.renameTab("t1", "   ")).toBe(before);
    expect(s.renameTab("t1", "x".repeat(65))).toBe(before);
    expect(s.renameTab("ghost", "x")).toBe(before);
  });

  it("is a no-op for the unchanged value", () => {
    const s = store();
    s.renameTab("t1", "deploy");
    expect(s.renameTab("t1", " deploy ")).toBe(s.getState());
  });
});

describe("recolorTab / setActiveTab", () => {
  it("applies palette colors only", () => {
    const s = store();
    expect(s.recolorTab("t1", "magenta").tabs.t1.color).toBe("magenta");
    const before = s.getState();
    expect(s.recolorTab("t1", "purple" as PaletteId)).toBe(before);
    expect(s.recolorTab("t1", "magenta")).toBe(before);
    expect(s.recolorTab("ghost", "red")).toBe(before);
  });

  it("activates valid tabs and null, rejects ghosts", () => {
    const s = store();
    expect(s.setActiveTab("t3").activeTabId).toBe("t3");
    expect(s.setActiveTab(null).activeTabId).toBeNull();
    const before = s.getState();
    expect(s.setActiveTab("ghost")).toBe(before);
    expect(s.setActiveTab(null)).toBe(before);
  });
});

describe("moveTab / reorderWithinContainer", () => {
  it("moves ungrouped → group at an index", () => {
    const s = store();
    const next = s.moveTab("t1", { groupId: "g1" }, 0);
    expect(itemIds(next, null)).toEqual(["t2", "g1"]);
    expect(itemIds(next, "g1")).toEqual(["t1", "t3"]);
    expect(validateInvariants(next)).toEqual([]);
  });

  it("moves group → ungrouped", () => {
    const s = store();
    const next = s.moveTab("t3", { groupId: null }, 1);
    expect(itemIds(next, null)).toEqual(["t1", "t3", "t2", "g1"]);
    expect(itemIds(next, "g1")).toEqual([]);
  });

  it("repositions within the same container (index after removal)", () => {
    const s = store();
    expect(itemIds(s.moveTab("t1", { groupId: null }, 1), null))
      .toEqual(["t2", "t1", "g1"]);
  });

  it("is identity for a drop on the same position", () => {
    const s = store();
    expect(s.moveTab("t1", { groupId: null }, 0)).toBe(s.getState());
  });

  it("rejects unknown tabs and targets, clamps wild indices", () => {
    const s = store();
    const before = s.getState();
    expect(s.moveTab("ghost", { groupId: null }, 0)).toBe(before);
    expect(s.moveTab("t1", { groupId: "nope" }, 0)).toBe(before);
    expect(itemIds(s.moveTab("t1", { groupId: "g1" }, 99), "g1"))
      .toEqual(["t3", "t1"]);
  });

  it("reorders inside ungrouped and inside a group", () => {
    const s = store();
    expect(itemIds(s.reorderWithinContainer(null, 0, 1), null))
      .toEqual(["t2", "t1", "g1"]);
    const before = s.getState();
    expect(s.reorderWithinContainer(null, 5, 0)).toBe(before);
    expect(s.reorderWithinContainer("nope", 0, 0)).toBe(before);
    expect(s.reorderWithinContainer(null, 0, 0)).toBe(before);
    expect(s.reorderWithinContainer("g1", 0, 0)).toBe(before);
  });
});

describe("groups", () => {
  it("creates, renames, collapses, deletes", () => {
    const s = store();
    s.createGroup({ id: "g2", name: "  Builds " });
    expect(s.getState().groups.g2.name).toBe("Builds");
    expect(itemIds(s.getState(), null)).toEqual(["t1", "t2", "g1", "g2"]);

    s.createGroup({ id: "g3", name: "Top", index: 0 });
    expect(itemIds(s.getState(), null)).toEqual(["g3", "t1", "t2", "g1", "g2"]);

    expect(s.renameGroup("g2", " CI ").groups.g2.name).toBe("CI");
    expect(s.toggleGroupCollapsed("g1").groups.g1.collapsed).toBe(true);
    expect(s.toggleGroupCollapsed("g1").groups.g1.collapsed).toBe(false);
  });

  it("rejects bad names and duplicate ids", () => {
    const s = store();
    const before = s.getState();
    expect(s.createGroup({ id: "g1", name: "Dup" })).toBe(before);
    expect(s.createGroup({ id: "", name: "X" })).toBe(before);
    expect(s.createGroup({ id: "g2", name: "  " })).toBe(before);
    expect(s.renameGroup("g1", "")).toBe(before);
    expect(s.renameGroup("ghost", "X")).toBe(before);
    expect(s.toggleGroupCollapsed("ghost")).toBe(before);
    expect(s.deleteGroup("ghost")).toBe(before);
  });

  it("deleteGroup splices its items into its own container in order", () => {
    const s = store();
    s.createTab({ id: "t9", sessionId: 9, groupId: "g1", index: 0 });
    const next = s.deleteGroup("g1");
    expect(next.groups).toEqual({});
    expect(itemIds(next, null)).toEqual(["t1", "t2", "t9", "t3"]);
    expect(validateInvariants(next)).toEqual([]);
  });

  it("creates a subgroup inside a parent and refuses an unknown parent", () => {
    const s = store();
    const next = s.createGroup({ id: "g2", name: "Nested", parentGroupId: "g1" });
    expect(itemIds(next, "g1")).toEqual(["t3", "g2"]);
    expect(validateInvariants(next)).toEqual([]);
    expect(s.createGroup({ id: "g3", name: "Nope", parentGroupId: "ghost" }))
      .toBe(s.getState());
  });

  it("refuses a subgroup past the hard depth cap", () => {
    const s = store();
    let parent: string | null = null;
    for (let level = 1; level <= MAX_GROUP_DEPTH; level++) {
      s.createGroup({ id: `d${level}`, name: `level ${level}`, parentGroupId: parent });
      parent = `d${level}`;
    }
    const atCap = s.getState();
    expect(groupDepth(atCap, `d${MAX_GROUP_DEPTH}`)).toBe(MAX_GROUP_DEPTH);
    expect(s.createGroup({ id: "over", name: "Over", parentGroupId: parent })).toBe(atCap);
  });

  it("recolors a group and rejects unknown colors", () => {
    const s = store();
    expect(s.recolorGroup("g1", "magenta").groups.g1.color).toBe("magenta");
    const before = s.getState();
    expect(s.recolorGroup("g1", "purple" as PaletteId)).toBe(before);
    expect(s.recolorGroup("g1", "magenta")).toBe(before);
    expect(s.recolorGroup("ghost", null)).toBe(before);
    expect(s.recolorGroup("g1", null).groups.g1.color).toBeNull();
  });

  it("moveItem nests a group and refuses its own subtree", () => {
    const s = store();
    s.createGroup({ id: "g2", name: "Builds" });
    const next = s.moveItem({ kind: "group", id: "g2" }, "g1", 0);
    expect(itemIds(next, "g1")).toEqual(["g2", "t3"]);
    expect(itemIds(next, null)).toEqual(["t1", "t2", "g1"]);
    expect(validateInvariants(next)).toEqual([]);
    expect(s.moveItem({ kind: "group", id: "g1" }, "g2", 0)).toBe(next);
    expect(s.moveItem({ kind: "group", id: "ghost" }, null, 0)).toBe(next);
  });
});

describe("setTabFill", () => {
  it("applies known strengths only", () => {
    const s = store();
    expect(s.setTabFill("t1", "strong").tabs.t1.fill).toBe("strong");
    const before = s.getState();
    expect(s.setTabFill("t1", "loud" as FillStrength)).toBe(before);
    expect(s.setTabFill("t1", "strong")).toBe(before);
    expect(s.setTabFill("ghost", "off")).toBe(before);
  });
});

describe("splitPane / closePane / resizePane", () => {
  it("splits a pane 50/50 and keeps invariants", () => {
    const s = store();
    const next = s.splitPane("t1", 1, "row", 10);
    expect(rootSplit(next, "t1")).toEqual({
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        { kind: "pane", sessionId: 1 },
        { kind: "pane", sessionId: 10 },
      ],
    });
    expect(validateInvariants(next)).toEqual([]);
  });

  it("enforces the depth-4 cap at the deepest allowed split", () => {
    const s = store();
    s.splitPane("t1", 1, "row", 10);
    s.splitPane("t1", 10, "col", 11);
    s.splitPane("t1", 11, "row", 12);
    const atCap = s.splitPane("t1", 12, "col", 13);
    expect(validateInvariants(atCap)).toEqual([]);
    expect(s.splitPane("t1", 13, "row", 14)).toBe(atCap);
  });

  it("rejects reused sessions, unknown panes, unknown tabs", () => {
    const s = store();
    const before = s.getState();
    expect(s.splitPane("t1", 1, "row", 2)).toBe(before);
    expect(s.splitPane("t1", 1, "row", 1)).toBe(before);
    expect(s.splitPane("t1", 99, "row", 10)).toBe(before);
    expect(s.splitPane("ghost", 1, "row", 10)).toBe(before);
    expect(s.splitPane("t1", 1, "row", -5)).toBe(before);
  });

  it("closePane promotes the sibling", () => {
    const s = store();
    s.splitPane("t1", 1, "row", 10);
    s.splitPane("t1", 10, "col", 11);
    const next = s.closePane("t1", 10);
    expect(rootSplit(next, "t1")).toEqual({
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        { kind: "pane", sessionId: 1 },
        { kind: "pane", sessionId: 11 },
      ],
    });
    expect(validateInvariants(next)).toEqual([]);
  });

  it("closing the last pane closes the tab", () => {
    const s = store();
    const next = s.closePane("t1", 1);
    expect(next.tabs).not.toHaveProperty("t1");
    expect(next.activeTabId).toBe("t2");
    expect(s.closePane("t2", 99)).toBe(next);
  });

  it("resizes with clamping and normalization", () => {
    const s = store();
    s.splitPane("t1", 1, "row", 10);
    expect((rootSplit(s.resizePane("t1", [], [0.3, 0.7]), "t1") as { sizes: [number, number] }).sizes)
      .toEqual([0.3, 0.7]);
    expect((rootSplit(s.resizePane("t1", [], [0.01, 0.99]), "t1") as { sizes: [number, number] }).sizes)
      .toEqual([0.1, 0.9]);
    expect((rootSplit(s.resizePane("t1", [], [1, 3]), "t1") as { sizes: [number, number] }).sizes)
      .toEqual([0.25, 0.75]);
    // 1 - 0.9 lands just below the minimum in floating point: both sides are
    // clamped, so the extreme drag still parses back.
    expect((rootSplit(s.resizePane("t1", [], [0.99, 0.01]), "t1") as { sizes: [number, number] }).sizes)
      .toEqual([0.9, 0.1]);
    expect(validateInvariants(s.getState())).toEqual([]);
  });

  it("resize is identity on no change, bad paths, and bad sizes", () => {
    const s = store();
    s.splitPane("t1", 1, "row", 10);
    s.splitPane("t1", 10, "col", 11);
    const before = s.getState();
    expect(s.resizePane("t1", [1], [0.5, 0.5])).toBe(before);
    expect(s.resizePane("t1", [0], [0.3, 0.7])).toBe(before);
    expect(s.resizePane("t1", [9], [0.3, 0.7])).toBe(before);
    expect(s.resizePane("t1", [], [Number.NaN, 0.5])).toBe(before);
    expect(s.resizePane("t1", [], [0, 0])).toBe(before);
    expect(s.resizePane("ghost", [], [0.3, 0.7])).toBe(before);
  });
});

describe("store mechanics", () => {
  it("notifies once per real change and never on no-ops", () => {
    const s = store();
    const seen: Layout[] = [];
    const unsubscribe = s.subscribe((state) => seen.push(state));

    s.renameTab("t1", "deploy");
    s.renameTab("t1", "deploy");
    s.setActiveTab("ghost");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(s.getState());

    unsubscribe();
    s.renameTab("t1", "other");
    expect(seen).toHaveLength(1);
  });

  it("never mutates a previous state object", () => {
    const s = store();
    const before = s.getState();
    const snapshot = JSON.stringify(before);
    s.splitPane("t1", 1, "row", 10);
    s.moveTab("t1", { groupId: "g1" }, 0);
    s.closeTab("t2");
    s.deleteGroup("g1");
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("replaceState adopts valid layouts and rejects invariant violations", () => {
    const s = store();
    const fresh = baseLayout();
    fresh.activeTabId = "t2";
    expect(s.replaceState(fresh)).toBe(fresh);

    const broken = baseLayout();
    broken.activeTabId = "ghost";
    expect(s.replaceState(broken)).toBe(fresh);
  });
});

/// baseLayout with t2 already torn out into aux-1.
function withAux(): Layout {
  const layout = baseLayout();
  layout.rootItems = [tabItem("t1"), groupItem("g1")];
  layout.auxWindows["aux-1"] = {
    rootItems: [tabItem("t2")],
    activeTabId: "t2",
    bounds: null,
  };
  return layout;
}

describe("window slots", () => {
  it("moveItemToWindow tears a tab out into a fresh aux slot", () => {
    const s = store();
    const next = s.moveItemToWindow(tabItem("t2"), "aux-1");
    expect(next.rootItems).toEqual([tabItem("t1"), groupItem("g1")]);
    expect(next.auxWindows["aux-1"]).toEqual({
      rootItems: [tabItem("t2")],
      activeTabId: "t2",
      bounds: null,
    });
    expect(next.activeTabId).toBe("t1");
    expect(validateInvariants(next)).toEqual([]);
  });

  it("moveItemToWindow keeps the source window's active tab when it did not move", () => {
    const s = store();
    const next = s.moveItemToWindow(tabItem("t2"), "aux-1");
    expect(next.activeTabId).toBe("t1"); // t1 was active and stayed home
  });

  it("moveItemToWindow moves the source active pointer when its tab leaves", () => {
    const s = store();
    s.setActiveTab("t2");
    const next = s.moveItemToWindow(tabItem("t2"), "aux-1");
    expect(next.activeTabId).not.toBe("t2");
    expect(next.activeTabId).not.toBeNull();
  });

  it("moveItemToWindow moves a group with its whole subtree", () => {
    const s = store();
    const next = s.moveItemToWindow(groupItem("g1"), "aux-1");
    expect(next.rootItems).toEqual([tabItem("t1"), tabItem("t2")]);
    expect(next.auxWindows["aux-1"]!.rootItems).toEqual([groupItem("g1")]);
    expect(next.auxWindows["aux-1"]!.activeTabId).toBe("t3");
    expect(validateInvariants(next)).toEqual([]);
  });

  it("moveItemToWindow brings a tab back to main", () => {
    const s = store(withAux());
    const next = s.moveItemToWindow(tabItem("t2"), "main");
    expect(next.rootItems).toEqual([tabItem("t1"), groupItem("g1"), tabItem("t2")]);
    expect(next.auxWindows["aux-1"]).toEqual({
      rootItems: [],
      activeTabId: null,
      bounds: null,
    });
  });

  it("moveItemToWindow refuses unknown items and no-op moves", () => {
    const s = store(withAux());
    const before = s.getState();
    expect(s.moveItemToWindow(tabItem("ghost"), "aux-1")).toBe(before);
    expect(s.moveItemToWindow(tabItem("t2"), "aux-1")).toBe(before);
    expect(s.moveItemToWindow(tabItem("t1"), "")).toBe(before);
  });

  it("returnWindowToMain appends the slot's items and deletes the slot", () => {
    const s = store(withAux());
    const next = s.returnWindowToMain("aux-1");
    expect(next.rootItems).toEqual([tabItem("t1"), groupItem("g1"), tabItem("t2")]);
    expect(next.auxWindows).toEqual({});
    expect(next.activeTabId).toBe("t1");
  });

  it("returnWindowToMain hands main the slot's active tab when main had none", () => {
    const layout = withAux();
    layout.activeTabId = null;
    layout.rootItems = [];
    layout.tabs = { t2: layout.tabs.t2 };
    layout.groups = {};
    const s = store(layout);
    const next = s.returnWindowToMain("aux-1");
    expect(next.activeTabId).toBe("t2");
  });

  it("returnWindowToMain ignores unknown windows and main itself", () => {
    const s = store(withAux());
    const before = s.getState();
    expect(s.returnWindowToMain("ghost")).toBe(before);
    expect(s.returnWindowToMain("main")).toBe(before);
  });

  it("setActiveTab targets the named window's slot", () => {
    const s = store(withAux());
    const next = s.setActiveTab(null, "aux-1");
    expect(next.auxWindows["aux-1"]!.activeTabId).toBeNull();
    expect(next.activeTabId).toBe("t1");
    expect(s.setActiveTab("t1", "ghost")).toBe(next); // unknown window: no-op
  });

  it("createTab lands in the named window's root and focuses there", () => {
    const s = store(withAux());
    const next = s.createTab({ id: "t9", sessionId: 9, windowId: "aux-1" });
    expect(next.auxWindows["aux-1"]!.rootItems).toEqual([
      tabItem("t2"),
      tabItem("t9"),
    ]);
    expect(next.auxWindows["aux-1"]!.activeTabId).toBe("t9");
    expect(next.activeTabId).toBe("t1");
  });

  it("closeTab in an aux window fixes that window's active tab only", () => {
    const s = store(withAux());
    const next = s.closeTab("t2");
    expect(next.auxWindows["aux-1"]!.rootItems).toEqual([]);
    expect(next.auxWindows["aux-1"]!.activeTabId).toBeNull();
    expect(next.activeTabId).toBe("t1");
    expect(validateInvariants(next)).toEqual([]);
  });

  it("moveItem with a windowId drops at that window's root", () => {
    const s = store(withAux());
    const next = s.moveItem(tabItem("t1"), null, 0, "aux-1");
    expect(next.auxWindows["aux-1"]!.rootItems).toEqual([
      tabItem("t1"),
      tabItem("t2"),
    ]);
    expect(next.rootItems).toEqual([groupItem("g1")]);
    expect(validateInvariants(next)).toEqual([]);
  });
});
