import { describe, expect, it } from "vitest";
import { PALETTE_IDS, validateInvariants, type LayoutV1 } from "../../state/layout";
import {
  firstSessionId,
  flattenTabIds,
  nextTabColor,
  pruneSessionIds,
  removeGroupAndTabs,
  reorderGroup,
  sessionIdsInTab,
} from "../layoutOperations";

function layout(): LayoutV1 {
  return {
    version: 1,
    groups: [
      { id: "g1", name: "One", collapsed: false, tabIds: ["t2"] },
      { id: "g2", name: "Two", collapsed: false, tabIds: ["t3"] },
      { id: "g3", name: "Three", collapsed: false, tabIds: [] },
    ],
    ungroupedTabIds: ["t1"],
    tabs: {
      t1: { id: "t1", title: null, color: "blue", split: { kind: "pane", sessionId: 1 } },
      t2: {
        id: "t2",
        title: "Split",
        color: "cyan",
        split: {
          kind: "split",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [
            { kind: "pane", sessionId: 2 },
            {
              kind: "split",
              dir: "col",
              sizes: [0.5, 0.5],
              children: [
                { kind: "pane", sessionId: 3 },
                { kind: "pane", sessionId: 4 },
              ],
            },
          ],
        },
      },
      t3: { id: "t3", title: null, color: "slate", split: { kind: "pane", sessionId: 5 } },
    },
    activeTabId: "t2",
  };
}

describe("layoutOperations", () => {
  it("selects pane sessions depth-first and flattens rendered tab order", () => {
    const state = layout();
    expect(firstSessionId(state.tabs.t2!.split)).toBe(2);
    expect(sessionIdsInTab(state.tabs.t2!)).toEqual([2, 3, 4]);
    expect(flattenTabIds(state)).toEqual(["t1", "t2", "t3"]);
  });

  it("rotates the palette after the final rendered tab and defaults to blue", () => {
    expect(nextTabColor(layout())).toBe("blue");
    const empty = layout();
    empty.groups = [];
    empty.ungroupedTabIds = [];
    empty.tabs = {};
    empty.activeTabId = null;
    expect(nextTabColor(empty)).toBe(PALETTE_IDS[0]);
  });

  it("reorders groups with post-removal clamped indices", () => {
    const state = layout();
    const moved = reorderGroup(state, "g1", 2);
    expect(moved.groups.map((group) => group.id)).toEqual(["g2", "g3", "g1"]);
    expect(validateInvariants(moved)).toEqual([]);
    expect(reorderGroup(moved, "missing", 0)).toBe(moved);
    expect(reorderGroup(moved, "g1", 99)).toBe(moved);
  });

  it("prunes panes recursively, collapses splits, and removes empty tabs", () => {
    const state = layout();
    const pruned = pruneSessionIds(state, new Set([2, 4, 5]));

    expect(pruned.tabs.t2?.split).toEqual({ kind: "pane", sessionId: 3 });
    expect(pruned.tabs.t3).toBeUndefined();
    expect(pruned.groups.find((group) => group.id === "g2")?.tabIds).toEqual([]);
    expect(pruned.activeTabId).toBe("t2");
    expect(validateInvariants(pruned)).toEqual([]);
  });

  it("moves active selection when pruning its final pane", () => {
    const state = layout();
    const pruned = pruneSessionIds(state, new Set([2, 3, 4]));
    expect(pruned.tabs.t2).toBeUndefined();
    expect(pruned.activeTabId).toBe("t3");
    expect(validateInvariants(pruned)).toEqual([]);
  });

  it("removes a group and all its tabs rather than ungrouping them", () => {
    const state = layout();
    const removed = removeGroupAndTabs(state, "g1");
    expect(removed.groups.map((group) => group.id)).toEqual(["g2", "g3"]);
    expect(removed.tabs.t2).toBeUndefined();
    expect(removed.ungroupedTabIds).toEqual(["t1"]);
    expect(removed.activeTabId).toBe("t3");
    expect(validateInvariants(removed)).toEqual([]);
  });
});
