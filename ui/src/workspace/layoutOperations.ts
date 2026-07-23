import {
  PALETTE_IDS,
  sessionIdsInSplit,
  validateInvariants,
  type LayoutV1,
  type PaletteId,
  type SplitNode,
  type Tab,
} from "../state/layout";

export function firstSessionId(node: SplitNode): number {
  return node.kind === "pane" ? node.sessionId : firstSessionId(node.children[0]);
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
