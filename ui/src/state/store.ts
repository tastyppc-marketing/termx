import {
  canMoveItem,
  emptyLayout,
  isFillStrength,
  isPaletteId,
  MAX_GROUP_DEPTH,
  MAX_NAME_LENGTH,
  MAX_SPLIT_DEPTH,
  MIN_PANE_FRACTION,
  sessionIdsInLayout,
  validateInvariants,
} from "./layout";
import type {
  FillStrength,
  Group,
  Item,
  Layout,
  PaletteId,
  SplitDir,
  SplitNode,
  Tab,
} from "./layout";

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
  getState(): Layout;
  subscribe(listener: (state: Layout) => void): () => void;
  /// Wholesale adoption (e.g. the reconciled boot layout). Rejected if the
  /// candidate violates any spec invariant.
  replaceState(layout: Layout): Layout;

  createTab(opts: CreateTabOptions): Layout;
  closeTab(tabId: string): Layout;
  renameTab(tabId: string, title: string | null): Layout;
  recolorTab(tabId: string, color: PaletteId): Layout;
  setActiveTab(tabId: string | null): Layout;

  /// Drag-drop commit: remove from the current container, then insert at
  /// `index` in the target (index applies AFTER removal; clamped).
  moveTab(tabId: string, target: ContainerRef, index: number): Layout;
  /// moveTab for any item, subgroups included. Refused when the move would
  /// break an invariant (a group into its own subtree, past the depth cap).
  moveItem(item: Item, targetGroupId: string | null, index: number): Layout;
  reorderWithinContainer(
    groupId: string | null,
    fromIndex: number,
    toIndex: number,
  ): Layout;

  createGroup(opts: CreateGroupOptions): Layout;
  renameGroup(groupId: string, name: string): Layout;
  recolorGroup(groupId: string, color: PaletteId | null): Layout;
  toggleGroupCollapsed(groupId: string): Layout;
  /// Keep-children delete: the group's items take its place in its own
  /// container, in order. Closing the tabs first is the caller's business.
  deleteGroup(groupId: string): Layout;

  setTabFill(tabId: string, fill: FillStrength): Layout;

  splitPane(
    tabId: string,
    paneSessionId: number,
    dir: SplitDir,
    newSessionId: number,
  ): Layout;
  /// Prunes the pane and collapses its parent split into the sibling. Closing
  /// a tab's last pane closes the tab.
  closePane(tabId: string, sessionId: number): Layout;
  /// `path` walks child indices (0|1) from the tab's root to a split node.
  /// Sizes are normalized to sum 1 with each side clamped to ≥ 0.1.
  resizePane(tabId: string, path: number[], sizes: [number, number]): Layout;
}

export interface ContainerRef {
  groupId: string | null;
}

export interface CreateTabOptions {
  id: string;
  sessionId: number;
  title?: string | null;
  color?: PaletteId;
  fill?: FillStrength;
  groupId?: string | null;
  index?: number;
}

export interface CreateGroupOptions {
  id: string;
  name: string;
  color?: PaletteId | null;
  /// Container the new group lands in; null (the default) = the root.
  parentGroupId?: string | null;
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

function sameItems(a: readonly Item[], b: readonly Item[]): boolean {
  return a.length === b.length &&
    a.every((item, i) => item.kind === b[i]!.kind && item.id === b[i]!.id);
}

function insertAt<T>(list: readonly T[], index: number, item: T): T[] {
  const next = [...list];
  next.splice(index, 0, item);
  return next;
}

function findGroup(layout: Layout, groupId: string): Group | undefined {
  return layout.groups[groupId];
}

function isItem(item: Item, kind: Item["kind"], id: string): boolean {
  return item.kind === kind && item.id === id;
}

/// Ordered children of a container: null groupId = the sidebar root. Undefined
/// means the group does not exist.
function itemsOf(
  layout: Layout,
  groupId: string | null,
): readonly Item[] | undefined {
  return groupId === null ? layout.rootItems : findGroup(layout, groupId)?.items;
}

/// The container currently holding `item`: null groupId = the root.
function containerOf(
  layout: Layout,
  item: Item,
): { groupId: string | null; list: readonly Item[] } | undefined {
  if (layout.rootItems.some((candidate) => isItem(candidate, item.kind, item.id))) {
    return { groupId: null, list: layout.rootItems };
  }
  for (const group of Object.values(layout.groups)) {
    if (group.items.some((candidate) => isItem(candidate, item.kind, item.id))) {
      return { groupId: group.id, list: group.items };
    }
  }
  return undefined;
}

function withContainerItems(
  layout: Layout,
  groupId: string | null,
  items: Item[],
): Layout {
  if (groupId === null) {
    return { ...layout, rootItems: items };
  }
  const group = layout.groups[groupId];
  if (!group) {
    return layout;
  }
  return {
    ...layout,
    groups: { ...layout.groups, [groupId]: { ...group, items } },
  };
}

/// Sidebar render order: every container's items in order, subgroups walked
/// where they sit.
function flattenedTabOrder(layout: Layout): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (items: readonly Item[]): void => {
    for (const item of items) {
      if (item.kind === "tab") {
        out.push(item.id);
        continue;
      }
      if (seen.has(item.id)) {
        continue;
      }
      seen.add(item.id);
      const group = layout.groups[item.id];
      if (group) {
        walk(group.items);
      }
    }
  };
  walk(layout.rootItems);
  return out;
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

export function createLayoutStore(initial?: Layout): LayoutStore {
  let state: Layout = initial ?? emptyLayout();
  const listeners = new Set<(state: Layout) => void>();

  function commit(next: Layout): Layout {
    if (next === state) {
      return state;
    }
    state = next;
    for (const listener of [...listeners]) {
      listener(state);
    }
    return state;
  }

  function closeTabImpl(tabId: string): Layout {
    const container = containerOf(state, { kind: "tab", id: tabId });
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
    const next = withContainerItems(
      state,
      container.groupId,
      container.list.filter((item) => !isItem(item, "tab", tabId)),
    );
    return commit({ ...next, tabs, activeTabId });
  }

  /// Shared move engine: pull the item out of its container, drop it back in
  /// at `index` of the target (clamped, applied AFTER the removal).
  function moveItemImpl(
    item: Item,
    targetGroupId: string | null,
    index: number,
  ): Layout {
    const source = containerOf(state, item);
    if (source === undefined || itemsOf(state, targetGroupId) === undefined) {
      return state;
    }
    // The hard cap guards the blob; the user setting gates the UI upstream.
    if (!canMoveItem(state, item, targetGroupId, MAX_GROUP_DEPTH)) {
      return state;
    }

    const removed = withContainerItems(
      state,
      source.groupId,
      source.list.filter((candidate) => !isItem(candidate, item.kind, item.id)),
    );
    const listAfterRemoval = itemsOf(removed, targetGroupId)!;
    const at = clampIndex(index, listAfterRemoval.length);
    const next = withContainerItems(
      removed,
      targetGroupId,
      insertAt(listAfterRemoval, at, item),
    );

    if (
      source.groupId === targetGroupId &&
      sameItems(source.list, itemsOf(next, targetGroupId)!)
    ) {
      return state;
    }
    return commit(next);
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
      const fill = opts.fill ?? "off";
      if (!isFillStrength(fill)) {
        return state;
      }
      const groupId = opts.groupId ?? null;
      const targetList = itemsOf(state, groupId);
      if (targetList === undefined) {
        return state;
      }

      const tab: Tab = { id, title, color, fill, split: { kind: "pane", sessionId } };
      const index = clampIndex(opts.index ?? targetList.length, targetList.length);
      const next = withContainerItems(
        state,
        groupId,
        insertAt(targetList, index, { kind: "tab", id }),
      );
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
      if (!(tabId in state.tabs)) {
        return state;
      }
      return moveItemImpl({ kind: "tab", id: tabId }, target.groupId, index);
    },

    moveItem: moveItemImpl,

    reorderWithinContainer(groupId, fromIndex, toIndex) {
      const list = itemsOf(state, groupId);
      if (list === undefined) {
        return state;
      }
      if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= list.length) {
        return state;
      }
      const next = [...list];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(clampIndex(toIndex, next.length), 0, moved!);
      if (sameItems(list, next)) {
        return state;
      }
      return commit(withContainerItems(state, groupId, next));
    },

    createGroup(opts) {
      const name = normalizeName(opts.name);
      if (name === null || opts.id.length === 0 || findGroup(state, opts.id)) {
        return state;
      }
      const color = opts.color ?? null;
      if (color !== null && !isPaletteId(color)) {
        return state;
      }
      const parentGroupId = opts.parentGroupId ?? null;
      const targetList = itemsOf(state, parentGroupId);
      if (targetList === undefined) {
        return state;
      }
      const group: Group = { id: opts.id, name, collapsed: false, color, items: [] };
      const index = clampIndex(opts.index ?? targetList.length, targetList.length);
      const next = withContainerItems(
        { ...state, groups: { ...state.groups, [opts.id]: group } },
        parentGroupId,
        insertAt(targetList, index, { kind: "group", id: opts.id }),
      );
      // A new group is empty, so only the depth cap can refuse it.
      return validateInvariants(next).length === 0 ? commit(next) : state;
    },

    renameGroup(groupId, name) {
      const group = findGroup(state, groupId);
      const normalized = normalizeName(name);
      if (group === undefined || normalized === null || group.name === normalized) {
        return state;
      }
      return commit({
        ...state,
        groups: { ...state.groups, [groupId]: { ...group, name: normalized } },
      });
    },

    recolorGroup(groupId, color) {
      const group = findGroup(state, groupId);
      if (group === undefined || (color !== null && !isPaletteId(color))) {
        return state;
      }
      if (group.color === color) {
        return state;
      }
      return commit({
        ...state,
        groups: { ...state.groups, [groupId]: { ...group, color } },
      });
    },

    toggleGroupCollapsed(groupId) {
      const group = findGroup(state, groupId);
      if (group === undefined) {
        return state;
      }
      return commit({
        ...state,
        groups: {
          ...state.groups,
          [groupId]: { ...group, collapsed: !group.collapsed },
        },
      });
    },

    deleteGroup(groupId) {
      const group = findGroup(state, groupId);
      const container = containerOf(state, { kind: "group", id: groupId });
      if (group === undefined || container === undefined) {
        return state;
      }
      const at = container.list.findIndex((item) => isItem(item, "group", groupId));
      const items = [...container.list];
      items.splice(at, 1, ...group.items);
      const groups = { ...state.groups };
      delete groups[groupId];
      return commit(withContainerItems({ ...state, groups }, container.groupId, items));
    },

    setTabFill(tabId, fill) {
      const tab = state.tabs[tabId] as Tab | undefined;
      if (tab === undefined || !isFillStrength(fill) || tab.fill === fill) {
        return state;
      }
      return commit({
        ...state,
        tabs: { ...state.tabs, [tabId]: { ...tab, fill } },
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
      // `1 - first` at the clamp is 0.09999999999999998 in binary floating
      // point — just under the minimum the invariants enforce — so the second
      // side is clamped in its own right rather than trusted to the subtraction.
      const second = Math.min(
        Math.max(1 - first, MIN_PANE_FRACTION),
        1 - MIN_PANE_FRACTION,
      );
      const target = nodeAtPath(tab.split, path);
      if (target === undefined || target.kind !== "split") {
        return state;
      }
      if (target.sizes[0] === first && target.sizes[1] === second) {
        return state;
      }
      const split = replaceAtPath(tab.split, path, (node) =>
        node.kind === "split" ? { ...node, sizes: [first, second] } : null
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
