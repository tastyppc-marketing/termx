import {
  MAX_SPLIT_DEPTH,
  PALETTE_IDS,
  sessionIdsInSplit,
  splitDepth,
  validateInvariants,
  type LayoutV1,
  type PaletteId,
  type SplitNode,
  type Tab,
} from "../state/layout";

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

export function flattenTabIds(layout: LayoutV1): string[] {
  return [...layout.ungroupedTabIds, ...layout.groups.flatMap((group) => group.tabIds)];
}

export function nextTabColor(layout: LayoutV1): PaletteId {
  const order = flattenTabIds(layout);
  const last = order.length === 0 ? undefined : layout.tabs[order[order.length - 1]!];
  if (!last) {
    return PALETTE_IDS[0];
  }
  const index = PALETTE_IDS.indexOf(last.color);
  return PALETTE_IDS[(index + 1) % PALETTE_IDS.length];
}

export function reorderGroup(
  layout: LayoutV1,
  groupId: string,
  targetIndex: number,
): LayoutV1 {
  const fromIndex = layout.groups.findIndex((group) => group.id === groupId);
  if (fromIndex < 0 || !Number.isInteger(targetIndex)) {
    return layout;
  }
  const groups = [...layout.groups];
  const [group] = groups.splice(fromIndex, 1);
  const at = Math.min(Math.max(targetIndex, 0), groups.length);
  groups.splice(at, 0, group!);
  if (groups.every((candidate, index) => candidate === layout.groups[index])) {
    return layout;
  }
  return admit(layout, { ...layout, groups });
}

export function pruneSessionIds(
  layout: LayoutV1,
  sessionIds: ReadonlySet<number>,
): LayoutV1 {
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

  const ungroupedTabIds = layout.ungroupedTabIds.filter((id) => !removedTabs.has(id));
  const groups = layout.groups.map((group) => {
    const tabIds = group.tabIds.filter((id) => !removedTabs.has(id));
    return tabIds.length === group.tabIds.length ? group : { ...group, tabIds };
  });
  const activeTabId = layout.activeTabId && removedTabs.has(layout.activeTabId)
    ? nextActiveTab(layout, removedTabs)
    : layout.activeTabId;
  return admit(layout, { ...layout, tabs, ungroupedTabIds, groups, activeTabId });
}

export function removeGroupAndTabs(layout: LayoutV1, groupId: string): LayoutV1 {
  const group = layout.groups.find((candidate) => candidate.id === groupId);
  if (!group) {
    return layout;
  }
  const removedTabs = new Set(group.tabIds);
  const tabs = { ...layout.tabs };
  for (const tabId of removedTabs) {
    delete tabs[tabId];
  }
  const activeTabId = layout.activeTabId && removedTabs.has(layout.activeTabId)
    ? nextActiveTab(layout, removedTabs)
    : layout.activeTabId;
  return admit(layout, {
    ...layout,
    groups: layout.groups.filter((candidate) => candidate.id !== groupId),
    tabs,
    activeTabId,
  });
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
  layout: LayoutV1,
  sourceTabId: string,
  targetTabId: string,
): LayoutV1 | null {
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
  return admitOrNull({
    ...layout,
    tabs,
    ungroupedTabIds: layout.ungroupedTabIds.filter((id) => id !== sourceTabId),
    groups: layout.groups.map((group) =>
      group.tabIds.includes(sourceTabId)
        ? { ...group, tabIds: group.tabIds.filter((id) => id !== sourceTabId) }
        : group
    ),
    // The merge happens INTO the active tab, and it stays active afterwards
    // (the source tab is gone, so an active source would dangle).
    activeTabId: targetTabId,
  });
}

/// Spec §16 extract ("Pop out to own tab"), the undo of a merge: one session's
/// pane leaves its split — the parent split collapses into the sibling through
/// the same pruning path close uses — and becomes its own tab immediately
/// AFTER the source tab, in the same container. Sessions are untouched.
///
/// Returns null when the tab is unknown, `newTabId` is unusable, the session is
/// not in this tab, or it is the tab's ONLY pane (already its own tab).
export function extractSessionToTab(
  layout: LayoutV1,
  tabId: string,
  sessionId: number,
  newTabId: string,
): LayoutV1 | null {
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

  let ungroupedTabIds = layout.ungroupedTabIds;
  let groups = layout.groups;
  const ungroupedAt = layout.ungroupedTabIds.indexOf(tabId);
  if (ungroupedAt >= 0) {
    ungroupedTabIds = insertAfter(layout.ungroupedTabIds, ungroupedAt, newTabId);
  } else {
    const group = layout.groups.find((candidate) => candidate.tabIds.includes(tabId));
    if (!group) {
      return null;
    }
    groups = layout.groups.map((candidate) =>
      candidate === group
        ? {
          ...candidate,
          tabIds: insertAfter(
            candidate.tabIds,
            candidate.tabIds.indexOf(tabId),
            newTabId,
          ),
        }
        : candidate
    );
  }

  const extracted: Tab = {
    id: newTabId,
    title: null,
    color: nextTabColor(layout),
    split: { kind: "pane", sessionId },
  };
  return admitOrNull({
    ...layout,
    ungroupedTabIds,
    groups,
    tabs: {
      ...layout.tabs,
      [tabId]: { ...tab, split: remaining },
      [newTabId]: extracted,
    },
  });
}

function insertAfter(list: readonly string[], index: number, id: string): string[] {
  const next = [...list];
  next.splice(index + 1, 0, id);
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

function nextActiveTab(layout: LayoutV1, removedTabs: ReadonlySet<string>): string | null {
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

function admit(previous: LayoutV1, candidate: LayoutV1): LayoutV1 {
  return validateInvariants(candidate).length === 0 ? candidate : previous;
}

/// admit() for operations whose refusal the caller must SEE (spec §16): an
/// invariant violation is a refusal, never a silently unchanged layout.
function admitOrNull(candidate: LayoutV1): LayoutV1 | null {
  return validateInvariants(candidate).length === 0 ? candidate : null;
}
