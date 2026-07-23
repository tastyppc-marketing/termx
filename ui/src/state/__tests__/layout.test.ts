import { describe, expect, it } from "vitest";
import {
  parseLayout,
  serializeLayout,
  splitDepth,
  validateInvariants,
} from "../layout";
import type { LayoutV1, SplitNode } from "../layout";
import { baseLayout, group, pane, split, tab } from "./helpers";

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

  it.each<[string, (l: LayoutV1) => void]>([
    ["container references a missing tab", (l) => {
      l.ungroupedTabIds.push("ghost");
    }],
    ["tab is in no container", (l) => {
      l.ungroupedTabIds = ["t1"];
    }],
    ["tab appears in two containers", (l) => {
      l.groups[0].tabIds.push("t1");
    }],
    ["duplicate group id", (l) => {
      l.groups.push(group("g1", "Dup", []));
    }],
    ["empty group name", (l) => {
      l.groups[0].name = "";
    }],
    ["group name over 64 chars", (l) => {
      l.groups[0].name = "x".repeat(65);
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
      layout.ungroupedTabIds.push(id);
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
    ["version 2", { ...serializeLayout(baseLayout()) as object, version: 2 }],
    ["groups not an array", {
      ...serializeLayout(baseLayout()) as object,
      groups: {},
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
    twoContainers.ungroupedTabIds = ["t1", "t2", "t3"];
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
    ];
    for (const value of garbage) {
      expect(parseLayout(value)).toBeNull();
    }
  });
});
