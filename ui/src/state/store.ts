import {
  canMoveItem,
  collectSubtreeTabIds,
  emptyLayout,
  isFillStrength,
  isPaletteId,
  MAIN_WINDOW_ID,
  MAX_GROUP_DEPTH,
  MAX_NAME_LENGTH,
  MAX_SPLIT_DEPTH,
  MIN_PANE_FRACTION,
  sessionIdsInLayout,
  validateInvariants,
} from "./layout";
import type {
  AuxWindowSlot,
  FillStrength,
  Group,
  Item,
  Layout,
  PaletteId,
  SplitDir,
  SplitNode,
  Tab,
  WindowBounds,
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
  /// `windowId` names whose active tab moves; default the main window's.
  setActiveTab(tabId: string | null, windowId?: string): Layout;

  /// Drag-drop commit: remove from the current container, then insert at
  /// `index` in the target (index applies AFTER removal; clamped).
  moveTab(tabId: string, target: ContainerRef, index: number): Layout;
  /// moveTab for any item, subgroups included. Refused when the move would
  /// break an invariant (a group into its own subtree, past the depth cap).
  /// A null `targetGroupId` is the root of `windowId` (default main).
  moveItem(
    item: Item,
    targetGroupId: string | null,
    index: number,
    windowId?: string,
  ): Layout;
  reorderWithinContainer(
    groupId: string | null,
    fromIndex: number,
    toIndex: number,
    windowId?: string,
  ): Layout;

  /// Re-parent an item into another window's root (multi-window spec): removed
  /// from wherever it sits — any window's root or any group — and appended to
  /// `targetWindowId`'s rootItems. A missing aux slot is created empty first.
  /// Each affected window's active tab is kept coherent. Refused (previous
  /// state returned) for unknown items or a no-op move.
  moveItemToWindow(item: Item, targetWindowId: string): Layout;
  /// Close-of-an-aux-window: its root items append to the main window's root
  /// and the slot is deleted. Unknown windows are a no-op.
  returnWindowToMain(windowId: string): Layout;
  /// Record an aux window's outer bounds (debounced upstream) so relaunch
  /// restores its position. Unknown windows, main, and invalid bounds are
  /// no-ops.
  setWindowBounds(windowId: string, bounds: WindowBounds): Layout;
  /// The window's own display name — the label over its top-left corner, and
  /// the one thing that distinguishes two windows at a glance. `null` (or a
  /// blank string) clears it back to the default. Main and aux windows alike;
  /// a window this layout does not know is a no-op.
  setWindowName(windowId: string, name: string | null): Layout;

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
  /// Which window's root a null groupId means; default the main window's.
  windowId?: string;
}

export interface CreateTabOptions {
  id: string;
  sessionId: number;
  title?: string | null;
  color?: PaletteId;
  fill?: FillStrength;
  groupId?: string | null;
  index?: number;
  /// Which window's root a null/absent groupId means; default main.
  windowId?: string;
}

export interface CreateGroupOptions {
  id: string;
  name: string;
  color?: PaletteId | null;
  /// Container the new group lands in; null (the default) = the root.
  parentGroupId?: string | null;
  index?: number;
  /// Which window's root a null parentGroupId means; default main.
  windowId?: string;
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

/// A container address: a group, or one window's root (groupId null).
interface ContainerKey {
  windowId: string;
  groupId: string | null;
}

function sameContainer(a: ContainerKey, b: ContainerKey): boolean {
  return a.groupId === b.groupId &&
    (a.groupId !== null || a.windowId === b.windowId);
}

/// One window's root item list; undefined for a window with no slot.
function rootsOf(layout: Layout, windowId: string): readonly Item[] | undefined {
  return windowId === MAIN_WINDOW_ID
    ? layout.rootItems
    : layout.auxWindows[windowId]?.rootItems;
}

function withRoots(layout: Layout, windowId: string, items: Item[]): Layout {
  if (windowId === MAIN_WINDOW_ID) {
    return { ...layout, rootItems: items };
  }
  const slot = layout.auxWindows[windowId];
  if (!slot) {
    return layout;
  }
  return {
    ...layout,
    auxWindows: { ...layout.auxWindows, [windowId]: { ...slot, rootItems: items } },
  };
}

/// One window's active tab (undefined for a window with no slot).
function activeTabOf(layout: Layout, windowId: string): string | null | undefined {
  return windowId === MAIN_WINDOW_ID
    ? layout.activeTabId
    : layout.auxWindows[windowId]?.activeTabId;
}

function withActiveTabIn(
  layout: Layout,
  windowId: string,
  activeTabId: string | null,
): Layout {
  if (windowId === MAIN_WINDOW_ID) {
    return { ...layout, activeTabId };
  }
  const slot = layout.auxWindows[windowId];
  if (!slot) {
    return layout;
  }
  return {
    ...layout,
    auxWindows: { ...layout.auxWindows, [windowId]: { ...slot, activeTabId } },
  };
}

/// Ordered children of a container. Undefined means the group (or the window
/// slot) does not exist.
function itemsOf(
  layout: Layout,
  key: ContainerKey,
): readonly Item[] | undefined {
  return key.groupId === null
    ? rootsOf(layout, key.windowId)
    : findGroup(layout, key.groupId)?.items;
}

/// The container currently holding `item`: some window's root, or a group.
function containerOf(
  layout: Layout,
  item: Item,
): { key: ContainerKey; list: readonly Item[] } | undefined {
  if (layout.rootItems.some((candidate) => isItem(candidate, item.kind, item.id))) {
    return {
      key: { windowId: MAIN_WINDOW_ID, groupId: null },
      list: layout.rootItems,
    };
  }
  for (const [windowId, slot] of Object.entries(layout.auxWindows)) {
    if (slot.rootItems.some((candidate) => isItem(candidate, item.kind, item.id))) {
      return { key: { windowId, groupId: null }, list: slot.rootItems };
    }
  }
  for (const group of Object.values(layout.groups)) {
    if (group.items.some((candidate) => isItem(candidate, item.kind, item.id))) {
      // A group container's windowId is immaterial to same-container edits.
      return {
        key: { windowId: MAIN_WINDOW_ID, groupId: group.id },
        list: group.items,
      };
    }
  }
  return undefined;
}

function withContainerItems(
  layout: Layout,
  key: ContainerKey,
  items: Item[],
): Layout {
  if (key.groupId === null) {
    return withRoots(layout, key.windowId, items);
  }
  const group = layout.groups[key.groupId];
  if (!group) {
    return layout;
  }
  return {
    ...layout,
    groups: { ...layout.groups, [key.groupId]: { ...group, items } },
  };
}

/// Sidebar render order of ONE window's rail: every container's items in
/// order, subgroups walked where they sit.
function flattenedTabOrder(layout: Layout, windowId: string): string[] {
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
  walk(rootsOf(layout, windowId) ?? []);
  return out;
}

/// The window whose root reaches the container `key` (a root key names it
/// directly; a group key is chased up through the layout).
function windowOfContainer(layout: Layout, key: ContainerKey): string {
  if (key.groupId === null) {
    return key.windowId;
  }
  for (const [windowId, slot] of [
    [MAIN_WINDOW_ID, { rootItems: layout.rootItems }] as const,
    ...Object.entries(layout.auxWindows),
  ]) {
    const seen = new Set<string>();
    const stack = [...slot.rootItems];
    while (stack.length > 0) {
      const item = stack.pop()!;
      if (item.kind !== "group" || seen.has(item.id)) {
        continue;
      }
      if (item.id === key.groupId) {
        return windowId;
      }
      seen.add(item.id);
      stack.push(...(layout.groups[item.id]?.items ?? []));
    }
  }
  return MAIN_WINDOW_ID;
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
    const owningWindow = windowOfContainer(state, container.key);

    const tabs = { ...state.tabs };
    delete tabs[tabId];
    let next = withContainerItems(
      state,
      container.key,
      container.list.filter((item) => !isItem(item, "tab", tabId)),
    );
    next = { ...next, tabs };
    // Every window whose active tab this was moves on: the owning window to
    // its own next-in-rail tab, any other (a stale pointer) to null.
    for (const windowId of [MAIN_WINDOW_ID, ...Object.keys(state.auxWindows)]) {
      if (activeTabOf(state, windowId) !== tabId) {
        continue;
      }
      let replacement: string | null = null;
      if (windowId === owningWindow) {
        const order = flattenedTabOrder(state, windowId);
        const at = order.indexOf(tabId);
        replacement = order[at + 1] ?? order[at - 1] ?? null;
      }
      next = withActiveTabIn(next, windowId, replacement);
    }
    return commit(next);
  }

  /// Shared move engine: pull the item out of its container, drop it back in
  /// at `index` of the target (clamped, applied AFTER the removal).
  function moveItemImpl(
    item: Item,
    target: ContainerKey,
    index: number,
  ): Layout {
    const source = containerOf(state, item);
    if (source === undefined || itemsOf(state, target) === undefined) {
      return state;
    }
    // The hard cap guards the blob; the user setting gates the UI upstream.
    if (!canMoveItem(state, item, target.groupId, MAX_GROUP_DEPTH)) {
      return state;
    }

    const removed = withContainerItems(
      state,
      source.key,
      source.list.filter((candidate) => !isItem(candidate, item.kind, item.id)),
    );
    const listAfterRemoval = itemsOf(removed, target)!;
    const at = clampIndex(index, listAfterRemoval.length);
    const next = withContainerItems(
      removed,
      target,
      insertAt(listAfterRemoval, at, item),
    );

    if (
      sameContainer(source.key, target) &&
      sameItems(source.list, itemsOf(next, target)!)
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
      const target: ContainerKey = {
        windowId: opts.windowId ?? MAIN_WINDOW_ID,
        groupId: opts.groupId ?? null,
      };
      const targetList = itemsOf(state, target);
      if (targetList === undefined) {
        return state;
      }

      const tab: Tab = { id, title, color, fill, split: { kind: "pane", sessionId } };
      const index = clampIndex(opts.index ?? targetList.length, targetList.length);
      const next = withContainerItems(
        state,
        target,
        insertAt(targetList, index, { kind: "tab", id }),
      );
      return commit(withActiveTabIn(
        { ...next, tabs: { ...next.tabs, [id]: tab } },
        windowOfContainer(state, target),
        id,
      ));
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

    setActiveTab(tabId, windowId = MAIN_WINDOW_ID) {
      if (tabId !== null && !(tabId in state.tabs)) {
        return state;
      }
      const current = activeTabOf(state, windowId);
      if (current === undefined || tabId === current) {
        return state;
      }
      return commit(withActiveTabIn(state, windowId, tabId));
    },

    moveTab(tabId, target, index) {
      if (!(tabId in state.tabs)) {
        return state;
      }
      return moveItemImpl(
        { kind: "tab", id: tabId },
        { windowId: target.windowId ?? MAIN_WINDOW_ID, groupId: target.groupId },
        index,
      );
    },

    moveItem(item, targetGroupId, index, windowId = MAIN_WINDOW_ID) {
      return moveItemImpl(item, { windowId, groupId: targetGroupId }, index);
    },

    reorderWithinContainer(groupId, fromIndex, toIndex, windowId = MAIN_WINDOW_ID) {
      const key: ContainerKey = { windowId, groupId };
      const list = itemsOf(state, key);
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
      return commit(withContainerItems(state, key, next));
    },

    moveItemToWindow(item, targetWindowId) {
      const exists = item.kind === "tab"
        ? item.id in state.tabs
        : item.id in state.groups;
      if (!exists || targetWindowId.length === 0) {
        return state;
      }
      const source = containerOf(state, item);
      if (source === undefined) {
        return state;
      }
      if (
        source.key.groupId === null &&
        source.key.windowId === targetWindowId
      ) {
        return state; // already at that window's root
      }
      const sourceWindow = windowOfContainer(state, source.key);

      // A fresh aux slot appears the moment something moves into it; main
      // always exists. (Pruning an emptied slot is the CLOSE path's job.)
      let next: Layout = state;
      if (targetWindowId !== MAIN_WINDOW_ID && !state.auxWindows[targetWindowId]) {
        const slot: AuxWindowSlot = {
          rootItems: [],
          activeTabId: null,
          bounds: null,
        };
        next = {
          ...next,
          auxWindows: { ...next.auxWindows, [targetWindowId]: slot },
        };
      }
      next = withContainerItems(
        next,
        source.key,
        source.list.filter((candidate) => !isItem(candidate, item.kind, item.id)),
      );
      const targetList = rootsOf(next, targetWindowId)!;
      next = withRoots(next, targetWindowId, [...targetList, item]);

      // Active-tab coherence: the tabs that moved are the item itself or the
      // group's whole subtree.
      const movedTabs = new Set(
        item.kind === "tab" ? [item.id] : collectSubtreeTabIds(state, item.id),
      );
      const sourceActive = activeTabOf(next, sourceWindow);
      if (
        sourceWindow !== targetWindowId &&
        sourceActive != null && movedTabs.has(sourceActive)
      ) {
        const order = flattenedTabOrder(next, sourceWindow)
          .filter((id) => !movedTabs.has(id));
        next = withActiveTabIn(next, sourceWindow, order[0] ?? null);
      }
      const targetActive = activeTabOf(next, targetWindowId);
      if (targetActive === null && movedTabs.size > 0) {
        const first = flattenedTabOrder(next, targetWindowId)
          .find((id) => movedTabs.has(id));
        next = withActiveTabIn(next, targetWindowId, first ?? null);
      }
      return validateInvariants(next).length === 0 ? commit(next) : state;
    },

    setWindowBounds(windowId, bounds) {
      const slot = state.auxWindows[windowId];
      if (slot === undefined) {
        return state;
      }
      const { x, y, width, height } = bounds;
      if (
        ![x, y, width, height].every((v) => Number.isFinite(v)) ||
        width <= 0 || height <= 0
      ) {
        return state;
      }
      if (
        slot.bounds !== null &&
        slot.bounds.x === x && slot.bounds.y === y &&
        slot.bounds.width === width && slot.bounds.height === height
      ) {
        return state;
      }
      return commit({
        ...state,
        auxWindows: {
          ...state.auxWindows,
          [windowId]: { ...slot, bounds: { x, y, width, height } },
        },
      });
    },

    setWindowName(windowId, name) {
      if (windowId !== MAIN_WINDOW_ID && state.auxWindows[windowId] === undefined) {
        return state;
      }
      const current = state.windowNames[windowId];
      // Blank is not a name, it is the request to stop having one — which is
      // what an empty inline-rename commit means.
      const trimmed = name === null ? "" : name.trim();
      if (trimmed.length === 0) {
        if (current === undefined) {
          return state;
        }
        const windowNames = { ...state.windowNames };
        delete windowNames[windowId];
        return commit({ ...state, windowNames });
      }
      const next = normalizeName(trimmed);
      if (next === null || next === current) {
        return state;
      }
      return commit({
        ...state,
        windowNames: { ...state.windowNames, [windowId]: next },
      });
    },

    returnWindowToMain(windowId) {
      const slot = state.auxWindows[windowId];
      if (windowId === MAIN_WINDOW_ID || slot === undefined) {
        return state;
      }
      const auxWindows = { ...state.auxWindows };
      delete auxWindows[windowId];
      // The label goes with the window. Ids are reused, so a name left behind
      // would surface on whatever window next takes this slot.
      const windowNames = { ...state.windowNames };
      delete windowNames[windowId];
      const next: Layout = {
        ...state,
        auxWindows,
        windowNames,
        rootItems: [...state.rootItems, ...slot.rootItems],
        // Main keeps its own active tab; it only adopts the slot's when it
        // had none to show.
        activeTabId: state.activeTabId ?? slot.activeTabId,
      };
      return validateInvariants(next).length === 0 ? commit(next) : state;
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
      const target: ContainerKey = {
        windowId: opts.windowId ?? MAIN_WINDOW_ID,
        groupId: opts.parentGroupId ?? null,
      };
      const targetList = itemsOf(state, target);
      if (targetList === undefined) {
        return state;
      }
      const group: Group = { id: opts.id, name, collapsed: false, color, items: [] };
      const index = clampIndex(opts.index ?? targetList.length, targetList.length);
      const next = withContainerItems(
        { ...state, groups: { ...state.groups, [opts.id]: group } },
        target,
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
      return commit(withContainerItems({ ...state, groups }, container.key, items));
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
