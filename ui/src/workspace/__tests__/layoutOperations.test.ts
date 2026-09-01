import { describe, expect, it } from "vitest";
import {
  PALETTE_IDS,
  validateInvariants,
  type Item,
  type Layout,
  type SplitNode,
} from "../../state/layout";
import {
  canSplitPane,
  extractSessionToTab,
  firstSessionId,
  flattenTabIds,
  mergeTabIntoTab,
  nextTabColor,
  pathToPaneNode,
  pruneSessionIds,
  removeGroupAndTabs,
  reorderGroup,
  replaceSessionInTab,
  sessionIdsInTab,
} from "../layoutOperations";

function tabItem(id: string): Item {
  return { kind: "tab", id };
}

function groupItem(id: string): Item {
  return { kind: "group", id };
}

/// Ids of a container's items in order (null = the root).
function itemIds(state: Layout, groupId: string | null): string[] {
  const items = groupId === null ? state.rootItems : state.groups[groupId]!.items;
  return items.map((item) => item.id);
}

function layout(): Layout {
  return {
    version: 3,
    auxWindows: {},
    windowNames: {},
    groups: {
      g1: { id: "g1", name: "One", collapsed: false, color: null, items: [tabItem("t2")] },
      g2: { id: "g2", name: "Two", collapsed: false, color: null, items: [tabItem("t3")] },
      g3: { id: "g3", name: "Three", collapsed: false, color: null, items: [] },
    },
    rootItems: [tabItem("t1"), groupItem("g1"), groupItem("g2"), groupItem("g3")],
    tabs: {
      t1: {
        id: "t1",
        title: null,
        color: "blue",
        fill: "off",
        split: { kind: "pane", sessionId: 1 },
      },
      t2: {
        id: "t2",
        title: "Split",
        color: "cyan",
        fill: "off",
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
      t3: {
        id: "t3",
        title: null,
        color: "slate",
        fill: "off",
        split: { kind: "pane", sessionId: 5 },
      },
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
    empty.groups = {};
    empty.rootItems = [];
    empty.tabs = {};
    empty.activeTabId = null;
    expect(nextTabColor(empty)).toBe(PALETTE_IDS[0]);
  });

  it("reorders groups with post-removal clamped item indices", () => {
    const state = layout();
    const moved = reorderGroup(state, "g1", 2);
    expect(itemIds(moved, null)).toEqual(["t1", "g2", "g1", "g3"]);
    expect(validateInvariants(moved)).toEqual([]);
    expect(reorderGroup(moved, "missing", 0)).toBe(moved);
    expect(reorderGroup(moved, "g1", 2)).toBe(moved);
    expect(itemIds(reorderGroup(moved, "g1", 99), null))
      .toEqual(["t1", "g2", "g3", "g1"]);
  });

  it("reorders a subgroup inside its own parent, not at the root", () => {
    const state = layout();
    state.groups.g1!.items = [tabItem("t2"), groupItem("g3")];
    state.rootItems = [tabItem("t1"), groupItem("g1"), groupItem("g2")];

    const moved = reorderGroup(state, "g3", 0);
    expect(itemIds(moved, "g1")).toEqual(["g3", "t2"]);
    expect(itemIds(moved, null)).toEqual(["t1", "g1", "g2"]);
    expect(validateInvariants(moved)).toEqual([]);
  });

  it("prunes panes recursively, collapses splits, and removes empty tabs", () => {
    const state = layout();
    const pruned = pruneSessionIds(state, new Set([2, 4, 5]));

    expect(pruned.tabs.t2?.split).toEqual({ kind: "pane", sessionId: 3 });
    expect(pruned.tabs.t3).toBeUndefined();
    expect(itemIds(pruned, "g2")).toEqual([]);
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
    expect(Object.keys(removed.groups)).toEqual(["g2", "g3"]);
    expect(removed.tabs.t2).toBeUndefined();
    expect(itemIds(removed, null)).toEqual(["t1", "g2", "g3"]);
    expect(removed.activeTabId).toBe("t3");
    expect(validateInvariants(removed)).toEqual([]);
  });

  it("removes a whole nested subtree, subgroups and their tabs included", () => {
    const state = layout();
    state.groups.g1!.items = [tabItem("t2"), groupItem("g2")];
    state.rootItems = [tabItem("t1"), groupItem("g1"), groupItem("g3")];

    const removed = removeGroupAndTabs(state, "g1");
    expect(Object.keys(removed.groups)).toEqual(["g3"]);
    expect(removed.tabs.t2).toBeUndefined();
    expect(removed.tabs.t3).toBeUndefined();
    expect(itemIds(removed, null)).toEqual(["t1", "g3"]);
    expect(removed.activeTabId).toBe("t1");
    expect(validateInvariants(removed)).toEqual([]);
  });
});

/// Depth fixtures for the §16 cap: "deep" is exactly MAX_SPLIT_DEPTH (4), so
/// grafting anything beside it would make 5; "three" is 3, so a pane grafted
/// beside it lands exactly ON the cap.
function depthLayout(): Layout {
  const depth4: SplitNode = {
    kind: "split",
    dir: "row",
    sizes: [0.5, 0.5],
    children: [
      { kind: "pane", sessionId: 10 },
      {
        kind: "split",
        dir: "col",
        sizes: [0.5, 0.5],
        children: [
          { kind: "pane", sessionId: 11 },
          {
            kind: "split",
            dir: "row",
            sizes: [0.5, 0.5],
            children: [
              { kind: "pane", sessionId: 12 },
              {
                kind: "split",
                dir: "col",
                sizes: [0.5, 0.5],
                children: [
                  { kind: "pane", sessionId: 13 },
                  { kind: "pane", sessionId: 14 },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const depth3: SplitNode = {
    kind: "split",
    dir: "row",
    sizes: [0.5, 0.5],
    children: [
      { kind: "pane", sessionId: 16 },
      {
        kind: "split",
        dir: "col",
        sizes: [0.5, 0.5],
        children: [
          { kind: "pane", sessionId: 17 },
          {
            kind: "split",
            dir: "row",
            sizes: [0.5, 0.5],
            children: [
              { kind: "pane", sessionId: 18 },
              { kind: "pane", sessionId: 19 },
            ],
          },
        ],
      },
    ],
  };
  return {
    version: 3,
    auxWindows: {},
    windowNames: {},
    groups: {},
    rootItems: [tabItem("deep"), tabItem("three"), tabItem("simple")],
    tabs: {
      deep: { id: "deep", title: null, color: "blue", fill: "off", split: depth4 },
      three: { id: "three", title: null, color: "cyan", fill: "off", split: depth3 },
      simple: {
        id: "simple",
        title: null,
        color: "green",
        fill: "off",
        split: { kind: "pane", sessionId: 15 },
      },
    },
    activeTabId: "deep",
  };
}

describe("replaceSessionInTab (dead-pane relaunch)", () => {
  it("swaps a nested pane's session id without touching geometry or other tabs", () => {
    const state = layout();
    const replaced = replaceSessionInTab(state, "t2", 3, 99);
    expect(replaced).not.toBeNull();
    expect(sessionIdsInTab(replaced!.tabs.t2!)).toEqual([2, 99, 4]);
    const split = replaced!.tabs.t2!.split;
    expect(split.kind).toBe("split");
    expect(split.kind === "split" && split.sizes).toEqual([0.5, 0.5]);
    expect(replaced!.tabs.t1).toBe(state.tabs.t1);
    expect(replaced!.tabs.t3).toBe(state.tabs.t3);
    expect(validateInvariants(replaced!)).toEqual([]);
  });

  it("refuses unknown tabs, sessions not in the tab, and no-op swaps", () => {
    const state = layout();
    expect(replaceSessionInTab(state, "missing", 1, 99)).toBeNull();
    expect(replaceSessionInTab(state, "t1", 2, 99)).toBeNull();
    expect(replaceSessionInTab(state, "t1", 1, 1)).toBeNull();
  });

  it("refuses a swap onto a session id already living in another pane", () => {
    expect(replaceSessionInTab(layout(), "t2", 3, 5)).toBeNull();
  });
});

describe("combine tabs side-by-side (spec §16)", () => {
  it("grafts the source subtree as the target root's right-hand sibling", () => {
    const state = layout();
    const merged = mergeTabIntoTab(state, "t3", "t1")!;

    expect(merged.tabs.t1?.split).toEqual({
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        { kind: "pane", sessionId: 1 },
        { kind: "pane", sessionId: 5 },
      ],
    });
    expect(merged.tabs.t3).toBeUndefined();
    expect(merged.activeTabId).toBe("t1");
    expect(validateInvariants(merged)).toEqual([]);
  });

  it("merges into a split target, rebalancing only the graft point", () => {
    const state = layout();
    const merged = mergeTabIntoTab(state, "t1", "t2")!;

    expect(merged.tabs.t2?.split).toEqual({
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [state.tabs.t2!.split, { kind: "pane", sessionId: 1 }],
    });
    expect(sessionIdsInTab(merged.tabs.t2!)).toEqual([2, 3, 4, 1]);
    expect(validateInvariants(merged)).toEqual([]);
  });

  it("removes the source tab from whichever container held it", () => {
    const fromGroup = mergeTabIntoTab(layout(), "t2", "t1")!;
    expect(itemIds(fromGroup, "g1")).toEqual([]);
    expect(itemIds(fromGroup, null)).toEqual(["t1", "g1", "g2", "g3"]);

    const fromRoot = mergeTabIntoTab(layout(), "t1", "t3")!;
    expect(itemIds(fromRoot, null)).toEqual(["g1", "g2", "g3"]);
    expect(itemIds(fromRoot, "g2")).toEqual(["t3"]);
    expect(validateInvariants(fromRoot)).toEqual([]);
  });

  it("refuses a merge past the split-depth cap but allows landing exactly on it", () => {
    expect(mergeTabIntoTab(depthLayout(), "simple", "deep")).toBeNull();
    expect(mergeTabIntoTab(depthLayout(), "deep", "simple")).toBeNull();

    const onCap = mergeTabIntoTab(depthLayout(), "simple", "three")!;
    expect(onCap.tabs.simple).toBeUndefined();
    expect(validateInvariants(onCap)).toEqual([]);
  });

  it("refuses unknown tabs and merging a tab into itself", () => {
    const state = layout();
    expect(mergeTabIntoTab(state, "nope", "t1")).toBeNull();
    expect(mergeTabIntoTab(state, "t1", "nope")).toBeNull();
    expect(mergeTabIntoTab(state, "t1", "t1")).toBeNull();
  });

  it("extracts a merged pane back into its own tab, restoring the shape", () => {
    const state = layout();
    const merged = mergeTabIntoTab(state, "t3", "t1")!;
    const restored = extractSessionToTab(merged, "t1", 5, "t4")!;

    expect(restored.tabs.t1?.split).toEqual(state.tabs.t1!.split);
    expect(restored.tabs.t4?.split).toEqual({ kind: "pane", sessionId: 5 });
    expect(restored.tabs.t4?.title).toBeNull();
    expect(itemIds(restored, null)).toEqual(["t1", "t4", "g1", "g2", "g3"]);
    expect(validateInvariants(restored)).toEqual([]);
  });

  it("collapses the emptied split and lands the new tab after its source in the group", () => {
    const state = layout();
    const extracted = extractSessionToTab(state, "t2", 3, "t4")!;

    expect(extracted.tabs.t2?.split).toEqual({
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        { kind: "pane", sessionId: 2 },
        { kind: "pane", sessionId: 4 },
      ],
    });
    expect(itemIds(extracted, "g1")).toEqual(["t2", "t4"]);
    // New tabs continue the palette rotation, like every other created tab.
    expect(extracted.tabs.t4?.color).toBe(nextTabColor(state));
    expect(validateInvariants(extracted)).toEqual([]);
  });

  it("refuses extracting a tab's only pane, an absent session, or a taken id", () => {
    const state = layout();
    expect(extractSessionToTab(state, "t1", 1, "t4")).toBeNull();
    expect(extractSessionToTab(state, "t2", 99, "t4")).toBeNull();
    expect(extractSessionToTab(state, "nope", 1, "t4")).toBeNull();
    expect(extractSessionToTab(state, "t2", 3, "t1")).toBeNull();
    expect(extractSessionToTab(state, "t2", 3, "")).toBeNull();
  });
});

describe("split depth helpers", () => {
  const deep: SplitNode = {
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
          {
            kind: "split",
            dir: "row",
            sizes: [0.5, 0.5],
            children: [
              { kind: "pane", sessionId: 3 },
              {
                kind: "split",
                dir: "col",
                sizes: [0.5, 0.5],
                children: [
                  { kind: "pane", sessionId: 4 },
                  { kind: "pane", sessionId: 5 },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  it("finds child-index paths to panes", () => {
    expect(pathToPaneNode({ kind: "pane", sessionId: 7 }, 7)).toEqual([]);
    expect(pathToPaneNode(deep, 1)).toEqual([0]);
    expect(pathToPaneNode(deep, 5)).toEqual([1, 1, 1, 1]);
    expect(pathToPaneNode(deep, 99)).toBeNull();
  });

  it("mirrors the store's depth guard for split affordances", () => {
    expect(canSplitPane({ kind: "pane", sessionId: 7 }, 7)).toBe(true);
    expect(canSplitPane(deep, 3)).toBe(true);
    expect(canSplitPane(deep, 4)).toBe(false);
    expect(canSplitPane(deep, 5)).toBe(false);
    expect(canSplitPane(deep, 99)).toBe(false);
  });
});
