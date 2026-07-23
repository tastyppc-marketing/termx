import type { Group, LayoutV1, SplitNode, Tab } from "../layout";

export function pane(sessionId: number): SplitNode {
  return { kind: "pane", sessionId };
}

export function split(
  dir: "row" | "col",
  a: SplitNode,
  b: SplitNode,
  sizes: [number, number] = [0.5, 0.5],
): SplitNode {
  return { kind: "split", dir, sizes, children: [a, b] };
}

export function tab(
  id: string,
  splitOrSession: SplitNode | number,
  overrides?: Partial<Pick<Tab, "title" | "color">>,
): Tab {
  return {
    id,
    title: overrides?.title ?? null,
    color: overrides?.color ?? "blue",
    split: typeof splitOrSession === "number"
      ? pane(splitOrSession)
      : splitOrSession,
  };
}

export function group(
  id: string,
  name: string,
  tabIds: string[],
  collapsed = false,
): Group {
  return { id, name, collapsed, tabIds };
}

/// t1(session 1), t2(session 2) ungrouped; g1 "Servers" holds t3(session 3).
export function baseLayout(): LayoutV1 {
  return {
    version: 1,
    groups: [group("g1", "Servers", ["t3"])],
    ungroupedTabIds: ["t1", "t2"],
    tabs: {
      t1: tab("t1", 1),
      t2: tab("t2", 2, { color: "green" }),
      t3: tab("t3", 3, { color: "red" }),
    },
    activeTabId: "t1",
  };
}

/// Deterministic PRNG (mulberry32) — tests must not touch Math.random.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
