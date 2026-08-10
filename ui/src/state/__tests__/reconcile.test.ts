import { describe, expect, it } from "vitest";
import { validateInvariants } from "../layout";
import { reconcile } from "../reconcile";
import type { SessionLike } from "../reconcile";
import { baseLayout, groupItem, tabItem } from "./helpers";

function ids(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${n++}`;
}

function session(id: number, alive = true): SessionLike {
  return { id, alive };
}

describe("reconcile rule 1 — dead sessions in the layout", () => {
  it("flags panes whose sessions are dead or missing, keeps the layout", () => {
    const layout = baseLayout();
    const result = reconcile(layout, [session(1), session(2, false)]);

    expect(result.layout).toBe(layout);
    expect(result.deadSessionIds.sort()).toEqual([2, 3]);
    expect(result.orphanAdoptedIds).toEqual([]);
    expect(result.unreferencedDeadSessionIds).toEqual([]);
  });
});

describe("reconcile rule 2 — live sessions never orphaned", () => {
  it("adopts unreferenced live sessions as tail slate tabs", () => {
    const layout = baseLayout();
    const result = reconcile(
      layout,
      [session(1), session(2), session(3), session(7)],
      { generateId: ids("new") },
    );

    expect(result.orphanAdoptedIds).toEqual([7]);
    expect(result.layout.rootItems).toEqual([
      tabItem("t1"),
      tabItem("t2"),
      groupItem("g1"),
      tabItem("new0"),
    ]);
    expect(result.layout.tabs.new0).toEqual({
      id: "new0",
      title: null,
      color: "slate",
      fill: "off",
      split: { kind: "pane", sessionId: 7 },
    });
    expect(result.layout.activeTabId).toBe("t1");
    expect(result.deadSessionIds).toEqual([]);
    expect(validateInvariants(result.layout)).toEqual([]);
  });

  it("survives an id generator that collides with existing tabs", () => {
    const result = reconcile(baseLayout(), [
      session(1),
      session(2),
      session(3),
      session(7),
      session(8),
    ], { generateId: () => "t1" });

    expect(result.orphanAdoptedIds).toEqual([7, 8]);
    expect(validateInvariants(result.layout)).toEqual([]);
  });
});

describe("reconcile rule 3 — malformed or absent layout", () => {
  it("builds a flat fresh layout from live sessions only", () => {
    const result = reconcile(
      null,
      [session(1), session(2, false), session(3)],
      { generateId: ids("f") },
    );

    expect(result.layout.groups).toEqual({});
    expect(result.layout.rootItems).toEqual([tabItem("f0"), tabItem("f1")]);
    expect(result.layout.tabs.f0.split).toEqual({ kind: "pane", sessionId: 1 });
    expect(result.layout.tabs.f1.split).toEqual({ kind: "pane", sessionId: 3 });
    expect(result.layout.tabs.f0.color).toBe("slate");
    expect(result.layout.activeTabId).toBe("f0");
    expect(result.orphanAdoptedIds).toEqual([1, 3]);
    expect(result.deadSessionIds).toEqual([]);
    expect(result.unreferencedDeadSessionIds).toEqual([2]);
    expect(validateInvariants(result.layout)).toEqual([]);
  });

  it("handles an empty host with no layout", () => {
    const result = reconcile(null, []);
    expect(result.layout.tabs).toEqual({});
    expect(result.layout.activeTabId).toBeNull();
    expect(result.deadSessionIds).toEqual([]);
    expect(result.orphanAdoptedIds).toEqual([]);
  });
});

describe("reconcile — mixed case", () => {
  it("flags dead, adopts orphans, and reports unreferenced dead at once", () => {
    const layout = baseLayout();
    const result = reconcile(layout, [
      session(1),
      session(3, false),
      session(7),
      session(9, false),
    ], { generateId: ids("m") });

    expect(result.deadSessionIds.sort()).toEqual([2, 3]);
    expect(result.orphanAdoptedIds).toEqual([7]);
    expect(result.unreferencedDeadSessionIds).toEqual([9]);
    expect(result.layout.rootItems).toEqual([
      tabItem("t1"),
      tabItem("t2"),
      groupItem("g1"),
      tabItem("m0"),
    ]);
    expect(result.layout.groups).toEqual(layout.groups);
    expect(validateInvariants(result.layout)).toEqual([]);
  });
});
