import { describe, expect, it } from "vitest";
import {
  canMoveItem,
  collectSubtreeTabIds,
  findContainer,
  groupDepth,
  parseLayout,
  serializeLayout,
  splitDepth,
  subtreeDepth,
  validateInvariants,
} from "../layout";
import type { Item, LayoutV2, SplitNode } from "../layout";
import { baseLayout, groupItem, pane, split, tab, tabItem } from "./helpers";

function chain(depth: number, firstSession: number): SplitNode {
  let node: SplitNode = pane(firstSession + depth);
  for (let i = depth - 1; i >= 0; i--) {
    node = split("row", pane(firstSession + i), node);
  }
  return node;
}

describe("validateInvariants", () => {
  it("accepts the base fixture", () => {
    expect(validateInvariants(baseLayout())).toEqual([]);
  });

  it("accepts a depth-4 split tree", () => {
    const layout = baseLayout();
    layout.tabs.t1 = tab("t1", chain(4, 100));
    expect(splitDepth(layout.tabs.t1.split)).toBe(4);
    expect(validateInvariants(layout)).toEqual([]);
  });

  it.each<[string, (l: LayoutV2) => void]>([
    ["container references a missing tab", (l) => {
      l.rootItems.push(tabItem("ghost"));
    }],
    ["container references a missing group", (l) => {
      l.rootItems.push(groupItem("ghost"));
    }],
    ["tab is in no container", (l) => {
      l.rootItems = [tabItem("t1"), groupItem("g1")];
    }],
    ["tab appears in two containers", (l) => {
      l.groups.g1.items.push(tabItem("t1"));
    }],
    ["group key mismatched with group id", (l) => {
      l.groups.g1 = { ...l.groups.g1, id: "other" };
    }],
    ["empty group name", (l) => {
      l.groups.g1.name = "";
    }],
    ["group name over 64 chars", (l) => {
      l.groups.g1.name = "x".repeat(65);
    }],
    ["unknown group color", (l) => {
      l.groups.g1 = { ...l.groups.g1, color: "purple" as never };
    }],
    ["unknown tab fill", (l) => {
      l.tabs.t1 = { ...l.tabs.t1, fill: "loud" as never };
    }],
    ["tab key mismatched with tab id", (l) => {
      l.tabs.t1 = { ...l.tabs.t1, id: "other" };
    }],
    ["empty tab title", (l) => {
      l.tabs.t1 = { ...l.tabs.t1, title: "" };
    }],
    ["tab title over 64 chars", (l) => {
      l.tabs.t1 = { ...l.tabs.t1, title: "x".repeat(65) };
    }],
    ["session duplicated across tabs", (l) => {
      l.tabs.t2 = tab("t2", 1, { color: "green" });
    }],
    ["session duplicated inside one split", (l) => {
      l.tabs.t1 = tab("t1", split("row", pane(1), pane(1)));
    }],
    ["split depth over 4", (l) => {
      l.tabs.t1 = tab("t1", chain(5, 100));
    }],
    ["split size below 0.1", (l) => {
      l.tabs.t1 = tab("t1", split("row", pane(10), pane(11), [0.05, 0.95]));
    }],
    ["split sizes not summing to 1", (l) => {
      l.tabs.t1 = tab("t1", split("row", pane(10), pane(11), [0.6, 0.6]));
    }],
    ["activeTabId pointing nowhere", (l) => {
      l.activeTabId = "ghost";
    }],
  ])("flags: %s", (_label, mutate) => {
    const layout = baseLayout();
    mutate(layout);
    expect(validateInvariants(layout).length).toBeGreaterThan(0);
  });

  it("flags a serialized layout above 256 KiB", () => {
    const layout = baseLayout();
    for (let i = 0; i < 3000; i++) {
      const id = `bulk-${i}`;
      layout.tabs[id] = tab(id, 1000 + i, { title: "t".repeat(64) });
      layout.rootItems.push(tabItem(id));
    }
    expect(validateInvariants(layout)).toContainEqual(
      expect.stringContaining("cap"),
    );
  });
});

describe("parseLayout / serializeLayout", () => {
  it("round-trips a layout with nested splits", () => {
    const layout = baseLayout();
    layout.tabs.t1 = tab(
      "t1",
      split("col", pane(1), split("row", pane(10), pane(11), [0.3, 0.7])),
      { title: "work" },
    );
    expect(parseLayout(serializeLayout(layout))).toEqual(layout);
  });

  it("returns a copy detached from the input", () => {
    const layout = baseLayout();
    const blob = serializeLayout(layout) as { activeTabId: string | null };
    const parsed = parseLayout(blob)!;
    blob.activeTabId = "tampered";
    expect(parsed.activeTabId).toBe("t1");
    expect(layout.activeTabId).toBe("t1");
  });

  it.each<[string, unknown]>([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["a string", "layout"],
    ["an array", []],
    ["an empty object", {}],
    ["version 3", { ...serializeLayout(baseLayout()) as object, version: 3 }],
    ["groups as an array", {
      ...serializeLayout(baseLayout()) as object,
      groups: [],
    }],
    ["rootItems not an array", {
      ...serializeLayout(baseLayout()) as object,
      rootItems: {},
    }],
    ["an item without a kind", {
      ...serializeLayout(baseLayout()) as object,
      rootItems: [{ id: "t1" }],
    }],
    ["tabs as an array", {
      ...serializeLayout(baseLayout()) as object,
      tabs: [],
    }],
    ["numeric activeTabId", {
      ...serializeLayout(baseLayout()) as object,
      activeTabId: 5,
    }],
  ])("rejects %s without throwing", (_label, value) => {
    expect(parseLayout(value)).toBeNull();
  });

  it("rejects malformed split nodes without throwing", () => {
    const cases: unknown[] = [
      { kind: "pane", sessionId: -1 },
      { kind: "pane", sessionId: 1.5 },
      { kind: "pane", sessionId: 2 ** 32 },
      { kind: "pane", sessionId: "7" },
      { kind: "diagonal", sessionId: 7 },
      { kind: "split", dir: "up", sizes: [0.5, 0.5], children: [pane(1), pane(2)] },
      { kind: "split", dir: "row", sizes: [0.5], children: [pane(1), pane(2)] },
      { kind: "split", dir: "row", sizes: ["a", "b"], children: [pane(1), pane(2)] },
      { kind: "split", dir: "row", sizes: [0.5, 0.5], children: [pane(1)] },
      { kind: "split", dir: "row", sizes: [Number.NaN, 0.5], children: [pane(1), pane(2)] },
    ];
    for (const badSplit of cases) {
      const layout = serializeLayout(baseLayout()) as Record<string, unknown>;
      const tabs = layout.tabs as Record<string, Record<string, unknown>>;
      tabs.t1 = { ...tabs.t1, split: badSplit };
      expect(parseLayout(layout)).toBeNull();
    }
  });

  it("rejects invariant violations, not just bad shapes", () => {
    const twoContainers = serializeLayout(baseLayout()) as Record<string, unknown>;
    twoContainers.rootItems = [
      tabItem("t1"),
      tabItem("t2"),
      tabItem("t3"),
      groupItem("g1"),
    ];
    expect(parseLayout(twoContainers)).toBeNull();

    const badColor = serializeLayout(baseLayout()) as Record<string, unknown>;
    const tabs = badColor.tabs as Record<string, Record<string, unknown>>;
    tabs.t1 = { ...tabs.t1, color: "purple" };
    expect(parseLayout(badColor)).toBeNull();
  });

  it("drops unknown extra fields instead of failing", () => {
    const blob = serializeLayout(baseLayout()) as Record<string, unknown>;
    blob.futureTopLevel = { anything: true };
    const tabs = blob.tabs as Record<string, Record<string, unknown>>;
    tabs.t1 = { ...tabs.t1, futureTabField: "x" };

    const parsed = parseLayout(blob);
    expect(parsed).toEqual(baseLayout());
    expect(parsed).not.toHaveProperty("futureTopLevel");
    expect(parsed!.tabs.t1).not.toHaveProperty("futureTabField");
  });

  it("survives deeply weird garbage without throwing", () => {
    const garbage: unknown[] = [
      { version: 1, groups: [null], ungroupedTabIds: [], tabs: {}, activeTabId: null },
      { version: 1, groups: [], ungroupedTabIds: [1], tabs: {}, activeTabId: null },
      { version: 1, groups: [], ungroupedTabIds: [], tabs: { a: null }, activeTabId: null },
      { version: 1, groups: [], ungroupedTabIds: [], tabs: { a: { id: "a" } }, activeTabId: null },
      {
        version: 1,
        groups: [{ id: "g", name: "n", collapsed: "yes", tabIds: [] }],
        ungroupedTabIds: [],
        tabs: {},
        activeTabId: null,
      },
      { version: 2, groups: {}, rootItems: [], tabs: { a: null }, activeTabId: null },
      { version: 2, groups: { g: null }, rootItems: [], tabs: {}, activeTabId: null },
      {
        version: 2,
        groups: { g: { id: "g", name: "n", collapsed: false, color: null, items: "x" } },
        rootItems: [{ kind: "group", id: "g" }],
        tabs: {},
        activeTabId: null,
      },
    ];
    for (const value of garbage) {
      expect(parseLayout(value)).toBeNull();
    }
  });
});

/// g1 > g2 > … > gN, the deepest holding the fixture's only tab.
function nestedChain(depth: number): LayoutV2 {
  const groups: LayoutV2["groups"] = {};
  for (let level = 1; level <= depth; level++) {
    groups[`g${level}`] = {
      id: `g${level}`,
      name: `level ${level}`,
      collapsed: false,
      color: null,
      items: level === depth
        ? [{ kind: "tab", id: "t1" }]
        : [{ kind: "group", id: `g${level + 1}` }],
    };
  }
  return {
    version: 2,
    groups,
    rootItems: [{ kind: "group", id: "g1" }],
    tabs: {
      t1: { id: "t1", title: null, color: "slate", fill: "off", split: pane(1) },
    },
    activeTabId: "t1",
  };
}

describe("layout v2", () => {
  it("parses a valid v2 blob round-trip", () => {
    const layout: LayoutV2 = {
      version: 2,
      groups: {
        g1: {
          id: "g1",
          name: "Marketing",
          collapsed: false,
          color: "blue",
          items: [{ kind: "group", id: "g2" }, { kind: "tab", id: "t1" }],
        },
        g2: {
          id: "g2",
          name: "Clients",
          collapsed: true,
          color: null,
          items: [{ kind: "tab", id: "t2" }],
        },
      },
      rootItems: [{ kind: "group", id: "g1" }, { kind: "tab", id: "t3" }],
      tabs: {
        t1: { id: "t1", title: null, color: "red", fill: "off", split: pane(1) },
        t2: { id: "t2", title: "api", color: "green", fill: "subtle", split: pane(2) },
        t3: { id: "t3", title: null, color: "slate", fill: "strong", split: pane(3) },
      },
      activeTabId: "t1",
    };
    expect(parseLayout(serializeLayout(layout))).toEqual(layout);
  });

  it("migrates a v1 blob preserving order and defaulting fill/color", () => {
    const v2 = parseLayout({
      version: 1,
      groups: [{ id: "g1", name: "Work", collapsed: false, tabIds: ["t1"] }],
      ungroupedTabIds: ["t2"],
      tabs: {
        t1: { id: "t1", title: null, color: "blue", split: { kind: "pane", sessionId: 1 } },
        t2: { id: "t2", title: null, color: "red", split: { kind: "pane", sessionId: 2 } },
      },
      activeTabId: "t2",
    });
    expect(v2).not.toBeNull();
    expect(v2!.version).toBe(2);
    expect(v2!.rootItems).toEqual([{ kind: "group", id: "g1" }, { kind: "tab", id: "t2" }]);
    expect(v2!.groups.g1!.items).toEqual([{ kind: "tab", id: "t1" }]);
    expect(v2!.groups.g1!.color).toBeNull();
    expect(v2!.tabs.t1!.fill).toBe("off");
    expect(v2!.activeTabId).toBe("t2");
  });

  it("rejects a group cycle", () => {
    const layout = nestedChain(2);
    layout.groups.g2!.items = [{ kind: "group", id: "g1" }, { kind: "tab", id: "t1" }];
    expect(validateInvariants(layout).length).toBeGreaterThan(0);
    expect(parseLayout(serializeLayout(layout))).toBeNull();
  });

  it("rejects an orphan group unreachable from rootItems", () => {
    const layout = nestedChain(1);
    layout.groups.orphan = {
      id: "orphan",
      name: "Orphan",
      collapsed: false,
      color: null,
      items: [],
    };
    expect(parseLayout(serializeLayout(layout))).toBeNull();
  });

  it("rejects a group referenced by two containers", () => {
    const layout = nestedChain(2);
    layout.rootItems = [{ kind: "group", id: "g1" }, { kind: "group", id: "g2" }];
    expect(parseLayout(serializeLayout(layout))).toBeNull();
  });

  it("rejects a tab referenced by two containers", () => {
    const layout = nestedChain(2);
    layout.rootItems = [{ kind: "group", id: "g1" }, { kind: "tab", id: "t1" }];
    expect(parseLayout(serializeLayout(layout))).toBeNull();
  });

  it("rejects nesting depth 9 and accepts depth 8", () => {
    expect(parseLayout(serializeLayout(nestedChain(8)))).not.toBeNull();
    expect(parseLayout(serializeLayout(nestedChain(9)))).toBeNull();
  });

  it("rejects unknown fill strengths and group colors", () => {
    const badFill = serializeLayout(nestedChain(1)) as Record<string, unknown>;
    const tabs = badFill.tabs as Record<string, Record<string, unknown>>;
    tabs.t1 = { ...tabs.t1, fill: "loud" };
    expect(parseLayout(badFill)).toBeNull();

    const badColor = serializeLayout(nestedChain(1)) as Record<string, unknown>;
    const groups = badColor.groups as Record<string, Record<string, unknown>>;
    groups.g1 = { ...groups.g1, color: "purple" };
    expect(parseLayout(badColor)).toBeNull();
  });

  it("reports depth, subtree depth, container, and subtree tabs", () => {
    const layout = nestedChain(3);
    expect(groupDepth(layout, "g1")).toBe(1);
    expect(groupDepth(layout, "g3")).toBe(3);
    expect(groupDepth(layout, "ghost")).toBe(0);
    expect(subtreeDepth(layout, "g1")).toBe(3);
    expect(subtreeDepth(layout, "g3")).toBe(1);
    expect(findContainer(layout, { kind: "group", id: "g1" })).toBeNull();
    expect(findContainer(layout, { kind: "group", id: "g2" })).toBe("g1");
    expect(findContainer(layout, { kind: "tab", id: "t1" })).toBe("g3");
    expect(collectSubtreeTabIds(layout, "g1")).toEqual(["t1"]);
  });

  it("canMoveItem forbids moving a group into its own subtree", () => {
    const layout = nestedChain(3);
    const g1: Item = { kind: "group", id: "g1" };
    expect(canMoveItem(layout, g1, "g2", 8)).toBe(false);
    expect(canMoveItem(layout, g1, "g1", 8)).toBe(false);
    expect(canMoveItem(layout, g1, "ghost", 8)).toBe(false);
  });

  it("canMoveItem enforces target depth + subtree depth against maxDepth", () => {
    const layout = nestedChain(2);
    layout.groups.host = {
      id: "host",
      name: "Host",
      collapsed: false,
      color: null,
      items: [{ kind: "group", id: "inner" }],
    };
    layout.groups.inner = {
      id: "inner",
      name: "Inner",
      collapsed: false,
      color: null,
      items: [],
    };
    layout.rootItems = [{ kind: "group", id: "g1" }, { kind: "group", id: "host" }];
    expect(validateInvariants(layout)).toEqual([]);

    // g1 > g2 is 2 levels tall; "inner" already sits at depth 2.
    expect(canMoveItem(layout, { kind: "group", id: "g1" }, "inner", 3)).toBe(false);
    expect(canMoveItem(layout, { kind: "group", id: "g1" }, "inner", 4)).toBe(true);
    expect(canMoveItem(layout, { kind: "tab", id: "t1" }, "inner", 2)).toBe(true);
    expect(canMoveItem(layout, { kind: "tab", id: "t1" }, "inner", 1)).toBe(false);
  });

  it("canMoveItem always allows reorder within the same container", () => {
    const layout = nestedChain(3);
    expect(canMoveItem(layout, { kind: "group", id: "g3" }, "g2", 1)).toBe(true);
    expect(canMoveItem(layout, { kind: "tab", id: "t1" }, "g3", 1)).toBe(true);
  });
});
