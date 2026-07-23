import {
  emptyLayout,
  isPaletteId,
  MAX_NAME_LENGTH,
  MAX_SPLIT_DEPTH,
  MIN_PANE_FRACTION,
  sessionIdsInLayout,
  validateInvariants,
} from "./layout";
import type { Group, LayoutV1, PaletteId, SplitDir, SplitNode, Tab } from "./layout";

/// Framework-free layout store. React binds via useSyncExternalStore later;
/// nothing in here may import react.
///
/// Contract: every mutator returns the store's state AFTER the call. A
/// rejected or no-op mutation returns the PREVIOUS state object unchanged
/// (compare by identity to detect it) and does not notify subscribers. State
/// objects are immutable — mutations build new objects with structural
/// sharing. Ids for new tabs/groups are caller-supplied uuids (the spec says
/// ids are UI-generated), which keeps the store deterministic under test.
export interface LayoutStore {
  getState(): LayoutV1;
  subscribe(listener: (state: LayoutV1) => void): () => void;
  /// Wholesale adoption (e.g. the reconciled boot layout). Rejected if the
  /// candidate violates any spec invariant.
  replaceState(layout: LayoutV1): LayoutV1;

  createTab(opts: CreateTabOptions): LayoutV1;
  closeTab(tabId: string): LayoutV1;
  renameTab(tabId: string, title: string | null): LayoutV1;
  recolorTab(tabId: string, color: PaletteId): LayoutV1;
  setActiveTab(tabId: string | null): LayoutV1;

  /// Drag-drop commit: remove from the current container, then insert at
  /// `index` in the target (index applies AFTER removal; clamped).
  moveTab(tabId: string, target: ContainerRef, index: number): LayoutV1;
  reorderWithinContainer(
    groupId: string | null,
    fromIndex: number,
    toIndex: number,
  ): LayoutV1;

  createGroup(opts: CreateGroupOptions): LayoutV1;
  renameGroup(groupId: string, name: string): LayoutV1;
  toggleGroupCollapsed(groupId: string): LayoutV1;
  /// Tabs fall back to the ungrouped list (which renders above all groups),
  /// appended at its tail in their existing order.
  deleteGroup(groupId: string): LayoutV1;

  splitPane(
    tabId: string,
    paneSessionId: number,
    dir: SplitDir,
    newSessionId: number,
  ): LayoutV1;
  /// Prunes the pane and collapses its parent split into the sibling. Closing
  /// a tab's last pane closes the tab.
  closePane(tabId: string, sessionId: number): LayoutV1;
  /// `path` walks child indices (0|1) from the tab's root to a split node.
  /// Sizes are normalized to sum 1 with each side clamped to ≥ 0.1.
  resizePane(tabId: string, path: number[], sizes: [number, number]): LayoutV1;
}

export interface ContainerRef {
  groupId: string | null;
}

export interface CreateTabOptions {
  id: string;
  sessionId: number;
  title?: string | null;
  color?: PaletteId;
  groupId?: string | null;
  index?: number;
}

export interface CreateGroupOptions {
  id: string;
  name: string;
  index?: number;
}

const MAX_SESSION_ID = 0xffffffff;

function isValidSessionId(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_SESSION_ID;
}

function normalizeName(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    return null;
  }
  return name;
}

function clampIndex(index: number, length: number): number {
  if (!Number.isInteger(index)) {
    return length;
  }
  return Math.min(Math.max(index, 0), length);
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function insertAt<T>(list: readonly T[], index: number, item: T): T[] {
  const next = [...list];
  next.splice(index, 0, item);
  return next;
}

function findGroup(layout: LayoutV1, groupId: string): Group | undefined {
  return layout.groups.find((g) => g.id === groupId);
}

/// The container currently holding `tabId`: null groupId = ungrouped.
function containerOf(
  layout: LayoutV1,
  tabId: string,
): { groupId: string | null; list: readonly string[] } | undefined {
  if (layout.ungroupedTabIds.includes(tabId)) {
    return { groupId: null, list: layout.ungroupedTabIds };
  }
  const group = layout.groups.find((g) => g.tabIds.includes(tabId));
  return group ? { groupId: group.id, list: group.tabIds } : undefined;
}

function withContainerList(
  layout: LayoutV1,
  groupId: string | null,
  list: string[],
): LayoutV1 {
  if (groupId === null) {
    return { ...layout, ungroupedTabIds: list };
  }
  return {
    ...layout,
    groups: layout.groups.map((g) => (g.id === groupId ? { ...g, tabIds: list } : g)),
  };
}

/// Sidebar render order: ungrouped tabs first, then each group's tabs.
function flattenedTabOrder(layout: LayoutV1): string[] {
  return [...layout.ungroupedTabIds, ...layout.groups.flatMap((g) => g.tabIds)];
}

function nodeAtPath(
  node: SplitNode,
  path: readonly number[],
): SplitNode | undefined {
  let current = node;
  for (const step of path) {
    if (current.kind !== "split" || (step !== 0 && step !== 1)) {
      return undefined;
    }
    current = current.children[step];
  }
  return current;
}

function replaceAtPath(
  node: SplitNode,
  path: readonly number[],
  replace: (target: SplitNode) => SplitNode | null,
): SplitNode | null {
  if (path.length === 0) {
    return replace(node);
  }
  const [head, ...rest] = path;
  if (node.kind !== "split" || (head !== 0 && head !== 1)) {
    return null;
  }
  const child = replaceAtPath(node.children[head], rest, replace);
  if (child === null) {
    return null;
  }
  const children: [SplitNode, SplitNode] = head === 0
    ? [child, node.children[1]]
    : [node.children[0], child];
  return { ...node, children };
}

/// Path of child indices from root to the pane holding `sessionId`.
function pathToPane(node: SplitNode, sessionId: number): number[] | undefined {
  if (node.kind === "pane") {
    return node.sessionId === sessionId ? [] : undefined;
  }
  const left = pathToPane(node.children[0], sessionId);
  if (left !== undefined) {
    return [0, ...left];
  }
  const right = pathToPane(node.children[1], sessionId);
  return right !== undefined ? [1, ...right] : undefined;
}

/// Remove the pane holding `sessionId`; the parent split collapses into the
/// sibling. Returns null when the pane is the whole tree (caller closes the
/// tab) or the session is not in this tree (caller treats as no-op).
function prunePane(
  node: SplitNode,
  sessionId: number,
): { tree: SplitNode } | "whole-tree" | "not-found" {
  if (node.kind === "pane") {
    return node.sessionId === sessionId ? "whole-tree" : "not-found";
  }
  for (const side of [0, 1] as const) {
    const child = node.children[side];
    const sibling = node.children[side === 0 ? 1 : 0];
    const result = prunePane(child, sessionId);
    if (result === "whole-tree") {
      return { tree: sibling };
    }
    if (result !== "not-found") {
      const children: [SplitNode, SplitNode] = side === 0
        ? [result.tree, sibling]
        : [sibling, result.tree];
      return { tree: { ...node, children } };
    }
  }
  return "not-found";
}

export function createLayoutStore(initial?: LayoutV1): LayoutStore {
  let state: LayoutV1 = initial ?? emptyLayout();
  const listeners = new Set<(state: LayoutV1) => void>();

  function commit(next: LayoutV1): LayoutV1 {
    if (next === state) {
      return state;
    }
    state = next;
    for (const listener of [...listeners]) {
      listener(state);
    }
    return state;
  }

  function closeTabImpl(tabId: string): LayoutV1 {
    const container = containerOf(state, tabId);
    if (container === undefined || !(tabId in state.tabs)) {
      return state;
    }

    let activeTabId = state.activeTabId;
    if (activeTabId === tabId) {
      const order = flattenedTabOrder(state);
      const at = order.indexOf(tabId);
      activeTabId = order[at + 1] ?? order[at - 1] ?? null;
    }

    const tabs = { ...state.tabs };
    delete tabs[tabId];
    const next = withContainerList(
      state,
      container.groupId,
      container.list.filter((id) => id !== tabId),
    );
    return commit({ ...next, tabs, activeTabId });
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    replaceState(layout) {
      if (validateInvariants(layout).length > 0) {
        return state;
      }
      return commit(layout);
    },

    createTab(opts) {
      const { id, sessionId } = opts;
      if (id.length === 0 || id in state.tabs) {
        return state;
      }
      if (!isValidSessionId(sessionId) || sessionIdsInLayout(state).includes(sessionId)) {
        return state;
      }
      const color = opts.color ?? "slate";
      if (!isPaletteId(color)) {
        return state;
      }
      let title: string | null = null;
      if (opts.title != null) {
        const normalized = normalizeName(opts.title);
        if (normalized === null) {
          return state;
        }
        title = normalized;
      }
      const groupId = opts.groupId ?? null;
      const targetList = groupId === null
        ? state.ungroupedTabIds
        : findGroup(state, groupId)?.tabIds;
      if (targetList === undefined) {
        return state;
      }

      const tab: Tab = { id, title, color, split: { kind: "pane", sessionId } };
      const index = clampIndex(opts.index ?? targetList.length, targetList.length);
      const next = withContainerList(state, groupId, insertAt(targetList, index, id));
      return commit({
        ...next,
        tabs: { ...next.tabs, [id]: tab },
        activeTabId: id,
      });
    },

    closeTab: closeTabImpl,

    renameTab(tabId, title) {
      const tab = state.tabs[tabId] as Tab | undefined;
      if (tab === undefined) {
        return state;
      }
      let nextTitle: string | null = null;
      if (title !== null) {
        const normalized = normalizeName(title);
        if (normalized === null) {
          return state;
        }
        nextTitle = normalized;
      }
      if (nextTitle === tab.title) {
        return state;
      }
      return commit({
        ...state,
        tabs: { ...state.tabs, [tabId]: { ...tab, title: nextTitle } },
      });
    },

    recolorTab(tabId, color) {
      const tab = state.tabs[tabId] as Tab | undefined;
      if (tab === undefined || !isPaletteId(color) || tab.color === color) {
        return state;
      }
      return commit({
        ...state,
        tabs: { ...state.tabs, [tabId]: { ...tab, color } },
      });
    },

    setActiveTab(tabId) {
      if (tabId !== null && !(tabId in state.tabs)) {
        return state;
      }
      if (tabId === state.activeTabId) {
        return state;
      }
      return commit({ ...state, activeTabId: tabId });
    },

    moveTab(tabId, target, index) {
      const source = containerOf(state, tabId);
      if (source === undefined) {
        return state;
      }
      const targetList = target.groupId === null
        ? state.ungroupedTabIds
        : findGroup(state, target.groupId)?.tabIds;
      if (targetList === undefined) {
        return state;
      }

      const removed = withContainerList(
        state,
        source.groupId,
        source.list.filter((id) => id !== tabId),
      );
      const listAfterRemoval = target.groupId === null
        ? removed.ungroupedTabIds
        : findGroup(removed, target.groupId)!.tabIds;
      const at = clampIndex(index, listAfterRemoval.length);
      const next = withContainerList(
        removed,
        target.groupId,
        insertAt(listAfterRemoval, at, tabId),
      );

      if (
        source.groupId === target.groupId &&
        sameOrder(source.list, target.groupId === null
          ? next.ungroupedTabIds
          : findGroup(next, target.groupId)!.tabIds)
      ) {
        return state;
      }
      return commit(next);
    },

    reorderWithinContainer(groupId, fromIndex, toIndex) {
      const list = groupId === null
        ? state.ungroupedTabIds
        : findGroup(state, groupId)?.tabIds;
      if (list === undefined) {
        return state;
      }
      if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= list.length) {
        return state;
      }
      const next = [...list];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(clampIndex(toIndex, next.length), 0, moved);
      if (sameOrder(list, next)) {
        return state;
      }
      return commit(withContainerList(state, groupId, next));
    },

    createGroup(opts) {
      const name = normalizeName(opts.name);
      if (name === null || opts.id.length === 0 || findGroup(state, opts.id)) {
        return state;
      }
      const group: Group = { id: opts.id, name, collapsed: false, tabIds: [] };
      const index = clampIndex(opts.index ?? state.groups.length, state.groups.length);
      return commit({ ...state, groups: insertAt(state.groups, index, group) });
    },

    renameGroup(groupId, name) {
      const group = findGroup(state, groupId);
      const normalized = normalizeName(name);
      if (group === undefined || normalized === null || group.name === normalized) {
        return state;
      }
      return commit({
        ...state,
        groups: state.groups.map((g) =>
          g.id === groupId ? { ...g, name: normalized } : g
        ),
      });
    },

    toggleGroupCollapsed(groupId) {
      if (findGroup(state, groupId) === undefined) {
        return state;
      }
      return commit({
        ...state,
        groups: state.groups.map((g) =>
          g.id === groupId ? { ...g, collapsed: !g.collapsed } : g
        ),
      });
    },

    deleteGroup(groupId) {
      const group = findGroup(state, groupId);
      if (group === undefined) {
        return state;
      }
      return commit({
        ...state,
        groups: state.groups.filter((g) => g.id !== groupId),
        ungroupedTabIds: [...state.ungroupedTabIds, ...group.tabIds],
      });
    },

    splitPane(tabId, paneSessionId, dir, newSessionId) {
      const tab = state.tabs[tabId] as Tab | undefined;
      if (tab === undefined) {
        return state;
      }
      if (
        !isValidSessionId(newSessionId) ||
        newSessionId === paneSessionId ||
        sessionIdsInLayout(state).includes(newSessionId)
      ) {
        return state;
      }
      const path = pathToPane(tab.split, paneSessionId);
      if (path === undefined || path.length + 1 > MAX_SPLIT_DEPTH) {
        return state;
      }
      const split = replaceAtPath(tab.split, path, (pane) => ({
        kind: "split",
        dir,
        sizes: [0.5, 0.5],
        children: [pane, { kind: "pane", sessionId: newSessionId }],
      }));
      if (split === null) {
        return state;
      }
      return commit({
        ...state,
        tabs: { ...state.tabs, [tabId]: { ...tab, split } },
      });
    },

    closePane(tabId, sessionId) {
      const tab = state.tabs[tabId] as Tab | undefined;
      if (tab === undefined) {
        return state;
      }
      const result = prunePane(tab.split, sessionId);
      if (result === "not-found") {
        return state;
      }
      if (result === "whole-tree") {
        return closeTabImpl(tabId);
      }
      return commit({
        ...state,
        tabs: { ...state.tabs, [tabId]: { ...tab, split: result.tree } },
      });
    },

    resizePane(tabId, path, sizes) {
      const tab = state.tabs[tabId] as Tab | undefined;
      if (tab === undefined) {
        return state;
      }
      const [a, b] = sizes;
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0 || a + b <= 0) {
        return state;
      }
      const first = Math.min(
        Math.max(a / (a + b), MIN_PANE_FRACTION),
        1 - MIN_PANE_FRACTION,
      );
      const target = nodeAtPath(tab.split, path);
      if (target === undefined || target.kind !== "split") {
        return state;
      }
      if (target.sizes[0] === first && target.sizes[1] === 1 - first) {
        return state;
      }
      const split = replaceAtPath(tab.split, path, (node) =>
        node.kind === "split" ? { ...node, sizes: [first, 1 - first] } : null
      );
      if (split === null) {
        return state;
      }
      return commit({
        ...state,
        tabs: { ...state.tabs, [tabId]: { ...tab, split } },
      });
    },
  };
}
