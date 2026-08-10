import type { Group, Item, LayoutV2, SplitNode, Tab } from "../layout";

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
  overrides?: Partial<Pick<Tab, "title" | "color" | "fill">>,
): Tab {
  return {
    id,
    title: overrides?.title ?? null,
    color: overrides?.color ?? "blue",
    fill: overrides?.fill ?? "off",
    split: typeof splitOrSession === "number"
      ? pane(splitOrSession)
      : splitOrSession,
  };
}

/// Group holding tabs only; nested fixtures build `items` by hand.
export function group(
  id: string,
  name: string,
  tabIds: string[],
  collapsed = false,
): Group {
  return {
    id,
    name,
    collapsed,
    color: null,
    items: tabIds.map((tabId): Item => ({ kind: "tab", id: tabId })),
  };
}

export function tabItem(id: string): Item {
  return { kind: "tab", id };
}

export function groupItem(id: string): Item {
  return { kind: "group", id };
}

/// t1(session 1), t2(session 2) at the root; g1 "Servers" holds t3(session 3).
export function baseLayout(): LayoutV2 {
  return {
    version: 2,
    groups: { g1: group("g1", "Servers", ["t3"]) },
    rootItems: [tabItem("t1"), tabItem("t2"), groupItem("g1")],
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
