import { describe, expect, it } from "vitest";
import { validateInvariants } from "../layout";
import type { LayoutV1, PaletteId, SplitNode } from "../layout";
import { createLayoutStore } from "../store";
import { baseLayout } from "./helpers";

function store(initial: LayoutV1 = baseLayout()) {
  return createLayoutStore(initial);
}

function rootSplit(state: LayoutV1, tabId: string): SplitNode {
  return state.tabs[tabId].split;
}

describe("createTab", () => {
  it("appends ungrouped by default and focuses the new tab", () => {
    const s = store();
    const next = s.createTab({ id: "t9", sessionId: 9 });
    expect(next.ungroupedTabIds).toEqual(["t1", "t2", "t9"]);
    expect(next.activeTabId).toBe("t9");
    expect(next.tabs.t9).toEqual({
      id: "t9",
      title: null,
      color: "slate",
      split: { kind: "pane", sessionId: 9 },
    });
  });

  it("inserts into a group at a clamped index", () => {
    const s = store();
    const next = s.createTab({ id: "t9", sessionId: 9, groupId: "g1", index: 99 });
    expect(next.groups[0].tabIds).toEqual(["t3", "t9"]);
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
    expect(next.ungroupedTabIds).toEqual(["t2"]);
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
    expect(next.ungroupedTabIds).toEqual(["t2"]);
    expect(next.groups[0].tabIds).toEqual(["t1", "t3"]);
    expect(validateInvariants(next)).toEqual([]);
  });

  it("moves group → ungrouped", () => {
    const s = store();
    const next = s.moveTab("t3", { groupId: null }, 1);
    expect(next.ungroupedTabIds).toEqual(["t1", "t3", "t2"]);
    expect(next.groups[0].tabIds).toEqual([]);
  });

  it("repositions within the same container (index after removal)", () => {
    const s = store();
    expect(s.moveTab("t1", { groupId: null }, 1).ungroupedTabIds)
      .toEqual(["t2", "t1"]);
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
    expect(s.moveTab("t1", { groupId: "g1" }, 99).groups[0].tabIds)
      .toEqual(["t3", "t1"]);
  });

  it("reorders inside ungrouped and inside a group", () => {
    const s = store();
    expect(s.reorderWithinContainer(null, 0, 1).ungroupedTabIds)
      .toEqual(["t2", "t1"]);
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
    expect(s.getState().groups.map((g) => g.name)).toEqual(["Servers", "Builds"]);

    s.createGroup({ id: "g3", name: "Top", index: 0 });
    expect(s.getState().groups.map((g) => g.id)).toEqual(["g3", "g1", "g2"]);

    expect(s.renameGroup("g2", " CI ").groups[2].name).toBe("CI");
    expect(s.toggleGroupCollapsed("g1").groups[1].collapsed).toBe(true);
    expect(s.toggleGroupCollapsed("g1").groups[1].collapsed).toBe(false);
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

  it("deleteGroup drops tabs to the ungrouped tail in order", () => {
    const s = store();
    s.createTab({ id: "t9", sessionId: 9, groupId: "g1", index: 0 });
    const next = s.deleteGroup("g1");
    expect(next.groups).toEqual([]);
    expect(next.ungroupedTabIds).toEqual(["t1", "t2", "t9", "t3"]);
    expect(validateInvariants(next)).toEqual([]);
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
    const seen: LayoutV1[] = [];
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
