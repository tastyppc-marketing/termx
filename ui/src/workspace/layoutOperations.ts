import {
  collectSubtreeTabIds,
  MAX_SPLIT_DEPTH,
  PALETTE_IDS,
  sessionIdsInSplit,
  splitDepth,
  validateInvariants,
  type Group,
  type Item,
  type LayoutV2,
  type PaletteId,
  type SplitNode,
  type Tab,
} from "../state/layout";

/// The container holding `item` (null groupId = the sidebar root) and its
/// ordered contents. Undefined when nothing references the item.
function containerOf(
  layout: LayoutV2,
  item: Item,
): { groupId: string | null; items: readonly Item[] } | undefined {
  if (layout.rootItems.some((candidate) => sameItem(candidate, item))) {
    return { groupId: null, items: layout.rootItems };
  }
  for (const group of Object.values(layout.groups)) {
    if (group.items.some((candidate) => sameItem(candidate, item))) {
      return { groupId: group.id, items: group.items };
    }
  }
  return undefined;
}

function sameItem(a: Item, b: Item): boolean {
  return a.kind === b.kind && a.id === b.id;
}

function withContainerItems(
  layout: LayoutV2,
  groupId: string | null,
  items: Item[],
): LayoutV2 {
  if (groupId === null) {
    return { ...layout, rootItems: items };
  }
  const group = layout.groups[groupId];
  if (!group) {
    return layout;
  }
  return { ...layout, groups: { ...layout.groups, [groupId]: { ...group, items } } };
}

/// Drops every listed tab id from every container, leaving groups in place.
function withoutTabItems(layout: LayoutV2, removed: ReadonlySet<string>): LayoutV2 {
  const keep = (items: readonly Item[]): Item[] =>
    items.filter((item) => !(item.kind === "tab" && removed.has(item.id)));
  const groups: Record<string, Group> = {};
  for (const [id, group] of Object.entries(layout.groups)) {
    const items = keep(group.items);
    groups[id] = items.length === group.items.length ? group : { ...group, items };
  }
  return { ...layout, groups, rootItems: keep(layout.rootItems) };
}

/// Every group id at or under `groupId`, itself included.
function subtreeGroupIds(layout: LayoutV2, groupId: string): Set<string> {
  const ids = new Set<string>([groupId]);
  const walk = (id: string): void => {
    for (const item of layout.groups[id]?.items ?? []) {
      if (item.kind === "group" && !ids.has(item.id)) {
        ids.add(item.id);
        walk(item.id);
      }
    }
  };
  walk(groupId);
  return ids;
}

export function firstSessionId(node: SplitNode): number {
  return node.kind === "pane" ? node.sessionId : firstSessionId(node.children[0]);
}

/// Child-index path from `node` to the pane holding `sessionId`, or null when
/// the pane is not in this tree.
export function pathToPaneNode(
  node: SplitNode,
  sessionId: number,
  path: number[] = [],
): number[] | null {
  if (node.kind === "pane") {
    return node.sessionId === sessionId ? path : null;
  }
  return (
    pathToPaneNode(node.children[0], sessionId, [...path, 0]) ??
    pathToPaneNode(node.children[1], sessionId, [...path, 1])
  );
}

/// Mirrors the store's splitPane depth guard (splitting a pane whose path has
/// length d creates a node at depth d + 1) so the UI can disable split
/// affordances instead of discovering refusal after creating a session.
export function canSplitPane(root: SplitNode, sessionId: number): boolean {
  const path = pathToPaneNode(root, sessionId);
  return path !== null && path.length + 1 <= MAX_SPLIT_DEPTH;
}

export function sessionIdsInTab(tab: Tab): number[] {
  return sessionIdsInSplit(tab.split);
}

/// Every tab id in sidebar order: each container's items in order, subgroups
/// walked where they sit.
export function flattenTabIds(layout: LayoutV2): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (items: readonly Item[]): void => {
    for (const item of items) {
      if (item.kind === "tab") {
        out.push(item.id);
      } else if (!seen.has(item.id)) {
        seen.add(item.id);
        walk(layout.groups[item.id]?.items ?? []);
      }
    }
  };
  walk(layout.rootItems);
  return out;
}

export function nextTabColor(layout: LayoutV2): PaletteId {
  const order = flattenTabIds(layout);
  const last = order.length === 0 ? undefined : layout.tabs[order[order.length - 1]!];
  if (!last) {
    return PALETTE_IDS[0];
  }
  const index = PALETTE_IDS.indexOf(last.color);
  return PALETTE_IDS[(index + 1) % PALETTE_IDS.length];
}

/// Reposition a group inside the container it already sits in. Nesting is
/// `moveItem`'s job; this is the sibling-order drag.
export function reorderGroup(
  layout: LayoutV2,
  groupId: string,
  targetIndex: number,
): LayoutV2 {
  const item: Item = { kind: "group", id: groupId };
  const container = containerOf(layout, item);
  if (container === undefined || !Number.isInteger(targetIndex)) {
    return layout;
  }
  const items = [...container.items];
  const fromIndex = items.findIndex((candidate) => sameItem(candidate, item));
  const [moved] = items.splice(fromIndex, 1);
  const at = Math.min(Math.max(targetIndex, 0), items.length);
  items.splice(at, 0, moved!);
  if (items.every((candidate, index) => candidate === container.items[index])) {
    return layout;
  }
  return admit(layout, withContainerItems(layout, container.groupId, items));
}

export function pruneSessionIds(
  layout: LayoutV2,
  sessionIds: ReadonlySet<number>,
): LayoutV2 {
  if (sessionIds.size === 0) {
    return layout;
  }

  let changed = false;
  const tabs: Record<string, Tab> = {};
  const removedTabs = new Set<string>();
  for (const [tabId, tab] of Object.entries(layout.tabs)) {
    const split = pruneNode(tab.split, sessionIds);
    if (split === null) {
      changed = true;
      removedTabs.add(tabId);
      continue;
    }
    if (split !== tab.split) {
      changed = true;
      tabs[tabId] = { ...tab, split };
    } else {
      tabs[tabId] = tab;
    }
  }
  if (!changed) {
    return layout;
  }

  const activeTabId = layout.activeTabId && removedTabs.has(layout.activeTabId)
    ? nextActiveTab(layout, removedTabs)
    : layout.activeTabId;
  return admit(
    layout,
    withoutTabItems({ ...layout, tabs, activeTabId }, removedTabs),
  );
}

/// Close-tabs group delete: the group, every subgroup under it, and every tab
/// in that subtree leave the layout together.
export function removeGroupAndTabs(layout: LayoutV2, groupId: string): LayoutV2 {
  const item: Item = { kind: "group", id: groupId };
  const container = containerOf(layout, item);
  if (!layout.groups[groupId] || container === undefined) {
    return layout;
  }
  const removedGroups = subtreeGroupIds(layout, groupId);
  const removedTabs = new Set(collectSubtreeTabIds(layout, groupId));
  const tabs = { ...layout.tabs };
  for (const tabId of removedTabs) {
    delete tabs[tabId];
  }
  const groups = { ...layout.groups };
  for (const id of removedGroups) {
    delete groups[id];
  }
  const activeTabId = layout.activeTabId && removedTabs.has(layout.activeTabId)
    ? nextActiveTab(layout, removedTabs)
    : layout.activeTabId;
  return admit(
    layout,
    withContainerItems(
      { ...layout, groups, tabs, activeTabId },
      container.groupId,
      container.items.filter((candidate) => !sameItem(candidate, item)),
    ),
  );
}

/// Spec §16 merge ("Side-by-side with active tab"): the SOURCE tab's entire
/// split subtree becomes the TARGET root's new right-hand sibling, sizes
/// rebalanced equally at that graft point only, and the source tab leaves its
/// container. Pure layout surgery — session ids only change tree position, so
/// nothing is created, killed, attached, or detached.
///
/// Returns null (a refusal the caller surfaces as a notice) when either tab is
/// unknown, both ids are the same tab, or the grafted tree would exceed the
/// MAX_SPLIT_DEPTH cap this module already mirrors for splits.
export function mergeTabIntoTab(
  layout: LayoutV2,
  sourceTabId: string,
  targetTabId: string,
): LayoutV2 | null {
  const source = layout.tabs[sourceTabId];
  const target = layout.tabs[targetTabId];
  if (!source || !target || sourceTabId === targetTabId) {
    return null;
  }

  const split: SplitNode = {
    kind: "split",
    dir: "row",
    sizes: [0.5, 0.5],
    children: [target.split, source.split],
  };
  if (splitDepth(split) > MAX_SPLIT_DEPTH) {
    return null;
  }

  const tabs: Record<string, Tab> = { ...layout.tabs, [targetTabId]: { ...target, split } };
  delete tabs[sourceTabId];
  return admitOrNull(withoutTabItems(
    {
      ...layout,
      tabs,
      // The merge happens INTO the active tab, and it stays active afterwards
      // (the source tab is gone, so an active source would dangle).
      activeTabId: targetTabId,
    },
    new Set([sourceTabId]),
  ));
}

/// Spec §16 extract ("Pop out to own tab"), the undo of a merge: one session's
/// pane leaves its split — the parent split collapses into the sibling through
/// the same pruning path close uses — and becomes its own tab immediately
/// AFTER the source tab, in the same container. Sessions are untouched.
///
/// Returns null when the tab is unknown, `newTabId` is unusable, the session is
/// not in this tab, or it is the tab's ONLY pane (already its own tab).
export function extractSessionToTab(
  layout: LayoutV2,
  tabId: string,
  sessionId: number,
  newTabId: string,
): LayoutV2 | null {
  const tab = layout.tabs[tabId];
  if (!tab || newTabId.length === 0 || newTabId in layout.tabs) {
    return null;
  }
  if (pathToPaneNode(tab.split, sessionId) === null) {
    return null;
  }
  const remaining = pruneNode(tab.split, new Set([sessionId]));
  if (remaining === null) {
    return null;
  }
  const source: Item = { kind: "tab", id: tabId };
  const container = containerOf(layout, source);
  if (container === undefined) {
    return null;
  }

  const extracted: Tab = {
    id: newTabId,
    title: null,
    color: nextTabColor(layout),
    fill: tab.fill,
    split: { kind: "pane", sessionId },
  };
  return admitOrNull(withContainerItems(
    {
      ...layout,
      tabs: {
        ...layout.tabs,
        [tabId]: { ...tab, split: remaining },
        [newTabId]: extracted,
      },
    },
    container.groupId,
    insertAfter(
      container.items,
      container.items.findIndex((candidate) => sameItem(candidate, source)),
      { kind: "tab", id: newTabId },
    ),
  ));
}

/// Dead-pane relaunch: swap one pane's session id in place, leaving the tab's
/// split geometry (and every other tab) untouched. Pure layout surgery — the
/// caller owns creating the replacement session and closing the old one.
///
/// Returns null (a refusal the caller surfaces) when the tab is unknown, the
/// old session is not one of its panes, or the swap would violate an invariant
/// (e.g. the new session id already lives in another pane).
export function replaceSessionInTab(
  layout: LayoutV2,
  tabId: string,
  oldSessionId: number,
  newSessionId: number,
): LayoutV2 | null {
  const tab = layout.tabs[tabId];
  if (!tab || oldSessionId === newSessionId) {
    return null;
  }
  const split = replaceInNode(tab.split, oldSessionId, newSessionId);
  if (split === null) {
    return null;
  }
  return admitOrNull({
    ...layout,
    tabs: { ...layout.tabs, [tabId]: { ...tab, split } },
  });
}

function replaceInNode(
  node: SplitNode,
  oldSessionId: number,
  newSessionId: number,
): SplitNode | null {
  if (node.kind === "pane") {
    return node.sessionId === oldSessionId
      ? { ...node, sessionId: newSessionId }
      : null;
  }
  const first = replaceInNode(node.children[0], oldSessionId, newSessionId);
  if (first !== null) {
    return { ...node, children: [first, node.children[1]] };
  }
  const second = replaceInNode(node.children[1], oldSessionId, newSessionId);
  if (second !== null) {
    return { ...node, children: [node.children[0], second] };
  }
  return null;
}

function insertAfter(list: readonly Item[], index: number, item: Item): Item[] {
  const next = [...list];
  next.splice(index + 1, 0, item);
  return next;
}

function pruneNode(node: SplitNode, sessionIds: ReadonlySet<number>): SplitNode | null {
  if (node.kind === "pane") {
    return sessionIds.has(node.sessionId) ? null : node;
  }
  const first = pruneNode(node.children[0], sessionIds);
  const second = pruneNode(node.children[1], sessionIds);
  if (first === null) {
    return second;
  }
  if (second === null) {
    return first;
  }
  if (first === node.children[0] && second === node.children[1]) {
    return node;
  }
  return { ...node, children: [first, second] };
}

function nextActiveTab(layout: LayoutV2, removedTabs: ReadonlySet<string>): string | null {
  if (!layout.activeTabId) {
    return null;
  }
  const order = flattenTabIds(layout);
  const at = order.indexOf(layout.activeTabId);
  for (let index = at + 1; index < order.length; index += 1) {
    if (!removedTabs.has(order[index]!)) {
      return order[index]!;
    }
  }
  for (let index = at - 1; index >= 0; index -= 1) {
    if (!removedTabs.has(order[index]!)) {
      return order[index]!;
    }
  }
  return null;
}

function admit(previous: LayoutV2, candidate: LayoutV2): LayoutV2 {
  return validateInvariants(candidate).length === 0 ? candidate : previous;
}

/// admit() for operations whose refusal the caller must SEE (spec §16): an
/// invariant violation is a refusal, never a silently unchanged layout.
function admitOrNull(candidate: LayoutV2): LayoutV2 | null {
  return validateInvariants(candidate).length === 0 ? candidate : null;
}
