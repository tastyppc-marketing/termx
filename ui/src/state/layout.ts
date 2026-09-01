import type { JsonValue } from "../host/protocol";

/// Shapes mirror docs/superpowers/specs/2026-08-09-termx-layout-v2.md plus the
/// multi-window extension in docs/superpowers/specs/2026-08-26-multi-window-design.md.
/// Nothing outside those documents may be added to the serialized blob. The v1
/// and v2 shapes below survive as parse-only stepping stones: an old blob is
/// shape-parsed, migrated, and then validated as v3 — nothing writes them again.

export const PALETTE_IDS = [
  "blue",
  "cyan",
  "green",
  "yellow",
  "orange",
  "red",
  "magenta",
  "slate",
] as const;

export type PaletteId = (typeof PALETTE_IDS)[number];

export const PALETTE_HEX: Record<PaletteId, string> = {
  blue: "#7aa2f7",
  cyan: "#7dcfff",
  green: "#9ece6a",
  yellow: "#e0af68",
  orange: "#ff9e64",
  red: "#f7768e",
  magenta: "#bb9af7",
  slate: "#565f89",
};

/// How strongly a tab's color washes its chrome (rendered by the theme spec).
export const FILL_STRENGTHS = ["off", "subtle", "strong"] as const;

export type FillStrength = (typeof FILL_STRENGTHS)[number];

export const MAX_NAME_LENGTH = 64;
export const MAX_SPLIT_DEPTH = 4;
export const MIN_PANE_FRACTION = 0.1;
export const MAX_LAYOUT_BYTES = 256 * 1024;
/// Hard parse cap on group nesting. The user-facing `maxGroupDepth` setting
/// gates creation and movement; this one only ever rejects a blob.
export const MAX_GROUP_DEPTH = 8;

const MAX_SESSION_ID = 0xffffffff;
const SIZE_SUM_EPSILON = 1e-6;

export type SplitDir = "row" | "col";

export type SplitNode =
  | { kind: "pane"; sessionId: number }
  | {
    kind: "split";
    dir: SplitDir;
    sizes: [number, number];
    children: [SplitNode, SplitNode];
  };

/// One ordered child of a container: nesting lives in these references, not in
/// physically nested objects, so lookups stay O(1) and cycles stay checkable.
export type Item =
  | { kind: "tab"; id: string }
  | { kind: "group"; id: string };

export interface Tab {
  id: string;
  title: string | null;
  color: PaletteId;
  fill: FillStrength;
  split: SplitNode;
}

export interface Group {
  id: string;
  name: string;
  collapsed: boolean;
  /// null = neutral (the pre-v2 look).
  color: PaletteId | null;
  items: Item[];
}

export interface LayoutV2 {
  version: 2;
  groups: Record<string, Group>;
  rootItems: Item[];
  tabs: Record<string, Tab>;
  activeTabId: string | null;
}

export const MAIN_WINDOW_ID = "main";

/// Last recorded outer bounds of an aux window, in physical pixels. Positions
/// may be negative (monitors left of or above the primary).
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/// One secondary OS window's share of the layout. The main window's share
/// stays in the top-level rootItems/activeTabId, so every v2-era call site
/// keeps reading the main window without indirection.
export interface AuxWindowSlot {
  rootItems: Item[];
  activeTabId: string | null;
  /// null until the window first reports its position.
  bounds: WindowBounds | null;
}

export interface LayoutV3 {
  version: 3;
  groups: Record<string, Group>;
  rootItems: Item[];
  tabs: Record<string, Tab>;
  activeTabId: string | null;
  auxWindows: Record<string, AuxWindowSlot>;
  /// What each OS window calls itself, keyed by window id — the main window
  /// included, which is why this is a flat map rather than a field on
  /// `AuxWindowSlot`. Sparse: a window with no entry wears the default name.
  ///
  /// It rides in the layout because the layout is the only per-window model
  /// there is, and because the layout is what crosses the window bus: an aux
  /// window's rename then reaches main through exactly the plumbing that
  /// already carries a tab rename.
  windowNames: Record<string, string>;
}

/// The current layout shape everywhere in the UI.
export type Layout = LayoutV3;

/// Main window first, then aux window ids in stable (sorted) order.
export function windowIds(layout: Layout): string[] {
  return [MAIN_WINDOW_ID, ...Object.keys(layout.auxWindows).sort()];
}

/// Read view of one window's slot; null for an unknown window id. The main
/// view shares the layout's own arrays — treat the result as read-only.
export function slotOf(layout: Layout, windowId: string): AuxWindowSlot | null {
  if (windowId === MAIN_WINDOW_ID) {
    return {
      rootItems: layout.rootItems,
      activeTabId: layout.activeTabId,
      bounds: null,
    };
  }
  return layout.auxWindows[windowId] ?? null;
}

/// What this window calls itself, or null when it has never been named. Null
/// is deliberately not "" — the caller shows its own default for null, and a
/// window named the empty string is not a thing that can exist.
export function windowNameOf(layout: Layout, windowId: string): string | null {
  return layout.windowNames[windowId] ?? null;
}

interface TabV1 {
  id: string;
  title: string | null;
  color: PaletteId;
  split: SplitNode;
}

interface GroupV1 {
  id: string;
  name: string;
  collapsed: boolean;
  tabIds: string[];
}

export interface LayoutV1 {
  version: 1;
  groups: GroupV1[];
  ungroupedTabIds: string[];
  tabs: Record<string, TabV1>;
  activeTabId: string | null;
}

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === "string" &&
    (PALETTE_IDS as readonly string[]).includes(value);
}

export function isFillStrength(value: unknown): value is FillStrength {
  return typeof value === "string" &&
    (FILL_STRENGTHS as readonly string[]).includes(value);
}

export function emptyLayout(): Layout {
  return {
    version: 3,
    groups: {},
    rootItems: [],
    tabs: {},
    activeTabId: null,
    auxWindows: {},
    windowNames: {},
  };
}

/// Number of nested split levels below `node`: a bare pane is 0, one split of
/// two panes is 1. The cap is MAX_SPLIT_DEPTH.
export function splitDepth(node: SplitNode): number {
  if (node.kind === "pane") {
    return 0;
  }
  return 1 + Math.max(splitDepth(node.children[0]), splitDepth(node.children[1]));
}

export function sessionIdsInSplit(node: SplitNode, out: number[] = []): number[] {
  if (node.kind === "pane") {
    out.push(node.sessionId);
    return out;
  }
  sessionIdsInSplit(node.children[0], out);
  sessionIdsInSplit(node.children[1], out);
  return out;
}

export function sessionIdsInLayout(layout: Layout): number[] {
  const out: number[] = [];
  for (const tab of Object.values(layout.tabs)) {
    sessionIdsInSplit(tab.split, out);
  }
  return out;
}

/// Nesting level of `groupId` counted from the sidebar root: a top-level group
/// is 1. Unknown or unreachable groups are 0, so callers can treat "not there"
/// and "no depth" alike.
export function groupDepth(layout: Layout, groupId: string): number {
  return walkGroups(layout).get(groupId) ?? 0;
}

/// Height of the subtree rooted at `groupId`: a group with no subgroups is 1.
/// Unknown groups are 0. Safe on cyclic input (each group counts once).
export function subtreeDepth(layout: Layout, groupId: string): number {
  return subtreeDepthFrom(layout, groupId, new Set());
}

/// The container currently holding `item`: a parent group id, or null for the
/// root — which is also the answer for an item that is nowhere at all.
export function findContainer(layout: Layout, item: Item): string | null {
  for (const [groupId, group] of Object.entries(layout.groups)) {
    if (group.items.some((candidate) => sameItem(candidate, item))) {
      return groupId;
    }
  }
  return null;
}

/// Every tab under `groupId`, its own first then each subgroup's, depth-first
/// in sidebar order. Safe on cyclic input (each group is walked once).
export function collectSubtreeTabIds(layout: Layout, groupId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    const group = layout.groups[id];
    if (!group) {
      return;
    }
    for (const item of group.items) {
      if (item.kind === "tab") {
        out.push(item.id);
      } else {
        walk(item.id);
      }
    }
  };
  walk(groupId);
  return out;
}

/// Whether `item` may be dropped into `targetGroupId` (null = root) under a
/// `maxDepth` ceiling — the user setting for interactive moves, MAX_GROUP_DEPTH
/// for anything that only has to stay parseable. A group may never enter its
/// own subtree, and a moved subtree must fit under the target; reordering
/// inside the container an item already sits in is always legal.
export function canMoveItem(
  layout: Layout,
  item: Item,
  targetGroupId: string | null,
  maxDepth: number,
): boolean {
  const exists = item.kind === "tab"
    ? item.id in layout.tabs
    : item.id in layout.groups;
  if (!exists) {
    return false;
  }
  if (targetGroupId !== null && !(targetGroupId in layout.groups)) {
    return false;
  }
  if (findContainer(layout, item) === targetGroupId) {
    return true;
  }
  const targetDepth = targetGroupId === null ? 0 : groupDepth(layout, targetGroupId);
  if (item.kind === "tab") {
    return targetDepth <= maxDepth;
  }
  if (
    targetGroupId !== null &&
    (targetGroupId === item.id ||
      subtreeGroupIds(layout, item.id).has(targetGroupId))
  ) {
    return false;
  }
  return targetDepth + subtreeDepth(layout, item.id) <= maxDepth;
}

function sameItem(a: Item, b: Item): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/// Depth of every group reachable from any window's root, keyed by id. A group
/// met a second time (a cycle, or a double reference) keeps its first depth and
/// is never re-entered, so this terminates on any input.
function walkGroups(layout: Layout): Map<string, number> {
  const depths = new Map<string, number>();
  const stack: Array<{ items: readonly Item[]; depth: number }> =
    windowRoots(layout);
  while (stack.length > 0) {
    const { items, depth } = stack.pop()!;
    for (const item of items) {
      if (item.kind !== "group" || depths.has(item.id)) {
        continue;
      }
      const group = layout.groups[item.id];
      if (!group) {
        continue;
      }
      depths.set(item.id, depth + 1);
      stack.push({ items: group.items, depth: depth + 1 });
    }
  }
  return depths;
}

/// Every window's root item list at depth 0 — the seed for group walks, so
/// groups torn out into aux windows keep well-defined depths.
function windowRoots(
  layout: Layout,
): Array<{ items: readonly Item[]; depth: number }> {
  return [
    { items: layout.rootItems, depth: 0 },
    ...Object.values(layout.auxWindows).map((slot) => ({
      items: slot.rootItems,
      depth: 0,
    })),
  ];
}

function subtreeDepthFrom(
  layout: Layout,
  groupId: string,
  seen: Set<string>,
): number {
  const group = layout.groups[groupId];
  if (!group || seen.has(groupId)) {
    return 0;
  }
  seen.add(groupId);
  let deepest = 0;
  for (const item of group.items) {
    if (item.kind === "group") {
      deepest = Math.max(deepest, subtreeDepthFrom(layout, item.id, seen));
    }
  }
  return 1 + deepest;
}

function subtreeGroupIds(layout: Layout, groupId: string): Set<string> {
  const out = new Set<string>();
  const walk = (id: string): void => {
    const group = layout.groups[id];
    if (!group) {
      return;
    }
    for (const item of group.items) {
      if (item.kind === "group" && !out.has(item.id)) {
        out.add(item.id);
        walk(item.id);
      }
    }
  };
  walk(groupId);
  return out;
}

function isValidName(name: unknown): name is string {
  return typeof name === "string" &&
    name.length >= 1 &&
    name.length <= MAX_NAME_LENGTH;
}

function isValidSessionId(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_SESSION_ID;
}

function validateSplit(
  node: SplitNode,
  tabId: string,
  seenSessions: Set<number>,
  problems: string[],
): void {
  if (node.kind === "pane") {
    if (!isValidSessionId(node.sessionId)) {
      problems.push(`tab ${tabId}: pane session id ${node.sessionId} is not a u32`);
      return;
    }
    if (seenSessions.has(node.sessionId)) {
      problems.push(`session ${node.sessionId} appears in more than one pane`);
    }
    seenSessions.add(node.sessionId);
    return;
  }

  const [a, b] = node.sizes;
  if (a < MIN_PANE_FRACTION || b < MIN_PANE_FRACTION) {
    problems.push(`tab ${tabId}: split size below ${MIN_PANE_FRACTION}`);
  }
  if (Math.abs(a + b - 1) > SIZE_SUM_EPSILON) {
    problems.push(`tab ${tabId}: split sizes sum to ${a + b}, expected 1`);
  }
  validateSplit(node.children[0], tabId, seenSessions, problems);
  validateSplit(node.children[1], tabId, seenSessions, problems);
}

/// Every spec invariant, as human-readable violations. Empty array = valid.
/// Used by tests and debug assertions; parseLayout rejects on any violation.
export function validateInvariants(layout: Layout): string[] {
  const problems: string[] = [];
  const tabRefs = new Map<string, number>();
  const groupRefs = new Map<string, number>();
  const groupDepths = new Map<string, number>();

  // One DFS seeded from every window's root counts every reference and records
  // nesting depth. A group met twice is counted but never re-entered, so a
  // cycle shows up as a multi-container reference instead of hanging the walk.
  const stack: Array<{ items: readonly Item[]; depth: number }> =
    windowRoots(layout);
  while (stack.length > 0) {
    const { items, depth } = stack.pop()!;
    for (const item of items) {
      if (item.kind === "tab") {
        tabRefs.set(item.id, (tabRefs.get(item.id) ?? 0) + 1);
        continue;
      }
      const refs = (groupRefs.get(item.id) ?? 0) + 1;
      groupRefs.set(item.id, refs);
      if (refs > 1) {
        continue;
      }
      const group = layout.groups[item.id];
      if (group === undefined) {
        problems.push(`group id ${item.id} referenced by a container but missing from groups`);
        continue;
      }
      groupDepths.set(item.id, depth + 1);
      stack.push({ items: group.items, depth: depth + 1 });
    }
  }

  for (const [key, group] of Object.entries(layout.groups)) {
    if (group.id !== key) {
      problems.push(`groups["${key}"] has mismatched id "${group.id}"`);
    }
    if (key.length === 0) {
      problems.push("group with empty id");
    }
    if (!isValidName(group.name)) {
      problems.push(`group ${key}: name must be 1..${MAX_NAME_LENGTH} chars`);
    }
    if (group.color !== null && !isPaletteId(group.color)) {
      problems.push(`group ${key}: unknown color "${group.color}"`);
    }
    const refs = groupRefs.get(key) ?? 0;
    if (refs === 0) {
      problems.push(`group ${key} is not reachable from any window`);
    } else if (refs > 1) {
      problems.push(`group ${key} appears in ${refs} containers, expected 1`);
    }
    const depth = groupDepths.get(key) ?? 0;
    if (depth > MAX_GROUP_DEPTH) {
      problems.push(`group ${key}: nesting depth ${depth} exceeds ${MAX_GROUP_DEPTH}`);
    }
  }

  for (const [id, count] of tabRefs) {
    if (!(id in layout.tabs)) {
      problems.push(`tab id ${id} referenced by a container but missing from tabs`);
    }
    if (count > 1) {
      problems.push(`tab id ${id} appears in ${count} containers, expected 1`);
    }
  }

  const seenSessions = new Set<number>();
  for (const [key, tab] of Object.entries(layout.tabs)) {
    if (tab.id !== key) {
      problems.push(`tabs["${key}"] has mismatched id "${tab.id}"`);
    }
    if (key.length === 0) {
      problems.push("tab with empty id");
    }
    if ((tabRefs.get(key) ?? 0) === 0) {
      problems.push(`tab ${key} is in no container`);
    }
    if (tab.title !== null && !isValidName(tab.title)) {
      problems.push(`tab ${key}: title must be null or 1..${MAX_NAME_LENGTH} chars`);
    }
    if (!isPaletteId(tab.color)) {
      problems.push(`tab ${key}: unknown color "${tab.color}"`);
    }
    if (!isFillStrength(tab.fill)) {
      problems.push(`tab ${key}: unknown fill "${tab.fill}"`);
    }
    const depth = splitDepth(tab.split);
    if (depth > MAX_SPLIT_DEPTH) {
      problems.push(`tab ${key}: split depth ${depth} exceeds ${MAX_SPLIT_DEPTH}`);
    }
    validateSplit(tab.split, key, seenSessions, problems);
  }

  if (layout.activeTabId !== null && !(layout.activeTabId in layout.tabs)) {
    problems.push(`activeTabId ${layout.activeTabId} is not a tab`);
  }

  for (const [windowId, slot] of Object.entries(layout.auxWindows)) {
    if (windowId.length === 0) {
      problems.push("aux window with empty id");
    }
    if (windowId === MAIN_WINDOW_ID) {
      problems.push(`aux window id "${MAIN_WINDOW_ID}" collides with the main window`);
    }
    if (slot.activeTabId !== null && !(slot.activeTabId in layout.tabs)) {
      problems.push(`window ${windowId}: activeTabId ${slot.activeTabId} is not a tab`);
    }
    if (slot.bounds !== null) {
      const { x, y, width, height } = slot.bounds;
      const finite = [x, y, width, height].every((v) => Number.isFinite(v));
      if (!finite || width <= 0 || height <= 0) {
        problems.push(`window ${windowId}: invalid bounds`);
      }
    }
  }

  const bytes = JSON.stringify(layout).length;
  if (bytes > MAX_LAYOUT_BYTES) {
    problems.push(`serialized layout is ${bytes} bytes, cap ${MAX_LAYOUT_BYTES}`);
  }

  return problems;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function parseSplit(value: unknown, depth: number): SplitNode | null {
  if (!isRecord(value) || depth > MAX_SPLIT_DEPTH) {
    return null;
  }
  if (value.kind === "pane") {
    if (!isValidSessionId(value.sessionId)) {
      return null;
    }
    return { kind: "pane", sessionId: value.sessionId };
  }
  if (value.kind === "split") {
    if (value.dir !== "row" && value.dir !== "col") {
      return null;
    }
    const sizes = value.sizes;
    if (
      !Array.isArray(sizes) || sizes.length !== 2 ||
      typeof sizes[0] !== "number" || typeof sizes[1] !== "number" ||
      !Number.isFinite(sizes[0]) || !Number.isFinite(sizes[1])
    ) {
      return null;
    }
    const children = value.children;
    if (!Array.isArray(children) || children.length !== 2) {
      return null;
    }
    const left = parseSplit(children[0], depth + 1);
    const right = parseSplit(children[1], depth + 1);
    if (left === null || right === null) {
      return null;
    }
    return {
      kind: "split",
      dir: value.dir,
      sizes: [sizes[0], sizes[1]],
      children: [left, right],
    };
  }
  return null;
}

function parseItem(value: unknown): Item | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }
  if (value.kind !== "tab" && value.kind !== "group") {
    return null;
  }
  return { kind: value.kind, id: value.id };
}

function parseItems(value: unknown): Item[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const items: Item[] = [];
  for (const raw of value) {
    const item = parseItem(raw);
    if (item === null) {
      return null;
    }
    items.push(item);
  }
  return items;
}

function parseTab(value: unknown): Tab | null {
  const base = parseTabV1(value);
  if (base === null || !isRecord(value) || !isFillStrength(value.fill)) {
    return null;
  }
  return { ...base, fill: value.fill };
}

function parseGroup(value: unknown): Group | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.collapsed !== "boolean" ||
    (value.color !== null && !isPaletteId(value.color))
  ) {
    return null;
  }
  const items = parseItems(value.items);
  if (items === null) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    collapsed: value.collapsed,
    color: value.color,
    items,
  };
}

function parseTabV1(value: unknown): TabV1 | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== "string") {
    return null;
  }
  if (value.title !== null && typeof value.title !== "string") {
    return null;
  }
  if (!isPaletteId(value.color)) {
    return null;
  }
  // Depth 0 = the root node: a pane at depth d has d splits above it, so the
  // deepest legal pane sits at exactly MAX_SPLIT_DEPTH.
  const split = parseSplit(value.split, 0);
  if (split === null) {
    return null;
  }
  return { id: value.id, title: value.title, color: value.color, split };
}

function parseGroupV1(value: unknown): GroupV1 | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.collapsed !== "boolean" ||
    !isStringArray(value.tabIds)
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    collapsed: value.collapsed,
    tabIds: [...value.tabIds],
  };
}

/// Shape-only v1 parse. Invariants are checked once, on the migrated v2 result,
/// so there is exactly one validator in this module.
function parseLayoutV1(value: Record<string, unknown>): LayoutV1 | null {
  if (
    !Array.isArray(value.groups) ||
    !isStringArray(value.ungroupedTabIds) ||
    !isRecord(value.tabs) ||
    (value.activeTabId !== null && typeof value.activeTabId !== "string")
  ) {
    return null;
  }

  const groups: GroupV1[] = [];
  for (const raw of value.groups) {
    const group = parseGroupV1(raw);
    if (group === null) {
      return null;
    }
    groups.push(group);
  }

  const tabs: Record<string, TabV1> = {};
  for (const [key, raw] of Object.entries(value.tabs)) {
    const tab = parseTabV1(raw);
    if (tab === null) {
      return null;
    }
    tabs[key] = tab;
  }

  return {
    version: 1,
    groups,
    ungroupedTabIds: [...value.ungroupedTabIds],
    tabs,
    activeTabId: value.activeTabId,
  };
}

/// One-way v1 → v2 (spec §2): groups keep their order at the root and their
/// tabs in `items`, the ungrouped tabs follow them, every group starts neutral
/// and every tab starts unfilled. Exported for tests; parseLayout applies it.
export function migrateV1(v1: LayoutV1): LayoutV2 {
  const groups: Record<string, Group> = {};
  const rootItems: Item[] = [];
  for (const group of v1.groups) {
    groups[group.id] = {
      id: group.id,
      name: group.name,
      collapsed: group.collapsed,
      color: null,
      items: group.tabIds.map((id): Item => ({ kind: "tab", id })),
    };
    rootItems.push({ kind: "group", id: group.id });
  }
  for (const id of v1.ungroupedTabIds) {
    rootItems.push({ kind: "tab", id });
  }

  const tabs: Record<string, Tab> = {};
  for (const [key, tab] of Object.entries(v1.tabs)) {
    tabs[key] = { ...tab, fill: "off" };
  }

  return { version: 2, groups, rootItems, tabs, activeTabId: v1.activeTabId };
}

/// One-way v2 → v3: everything the v2 blob held becomes the main window's
/// share; there are no aux windows yet. Exported for tests; parseLayout
/// applies it.
export function migrateV2(v2: LayoutV2): Layout {
  return { ...v2, version: 3, auxWindows: {}, windowNames: {} };
}

function parseWindowBounds(value: unknown): WindowBounds | null {
  if (!isRecord(value)) {
    return null;
  }
  const { x, y, width, height } = value;
  if (
    typeof x !== "number" || typeof y !== "number" ||
    typeof width !== "number" || typeof height !== "number" ||
    ![x, y, width, height].every((v) => Number.isFinite(v)) ||
    width <= 0 || height <= 0
  ) {
    return null;
  }
  return { x, y, width, height };
}

function parseAuxWindowSlot(value: unknown): AuxWindowSlot | null {
  if (!isRecord(value)) {
    return null;
  }
  const rootItems = parseItems(value.rootItems);
  if (rootItems === null) {
    return null;
  }
  if (value.activeTabId !== null && typeof value.activeTabId !== "string") {
    return null;
  }
  let bounds: WindowBounds | null = null;
  if (value.bounds !== null) {
    bounds = parseWindowBounds(value.bounds);
    if (bounds === null) {
      return null;
    }
  }
  return { rootItems, activeTabId: value.activeTabId, bounds };
}

/// Window names, parsed leniently where the rest of this file is strict.
///
/// Two reasons for the asymmetry. Every v3 layout written before names existed
/// simply has no field here, so a missing map has to mean "no names" rather
/// than "reject" — otherwise the upgrade empties everyone's workspace. And a
/// name is COSMETIC where a layout is not: rejecting the whole blob over a
/// junk label would trade every tab the user has for a caption. So bad entries
/// are dropped one by one and the workspace comes through intact.
function parseWindowNames(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const names: Record<string, string> = {};
  for (const [windowId, raw] of Object.entries(value)) {
    if (typeof raw !== "string") {
      continue;
    }
    const name = raw.trim();
    if (name.length > 0 && name.length <= MAX_NAME_LENGTH) {
      names[windowId] = name;
    }
  }
  return names;
}

/// Parse an untrusted GetState blob, v1..v3. Returns null on ANY version,
/// shape, or invariant violation — never throws into UI code (restore rule 3:
/// malformed layouts fall back, they don't crash). Old blobs are migrated in
/// place of failing; unknown extra fields are dropped; the result is a fresh
/// deep copy detached from the input.
export function parseLayout(value: unknown): Layout | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.version === 1) {
    const v1 = parseLayoutV1(value);
    if (v1 === null) {
      return null;
    }
    const migrated = migrateV2(migrateV1(v1));
    return validateInvariants(migrated).length === 0 ? migrated : null;
  }
  if (value.version !== 2 && value.version !== 3) {
    return null;
  }
  if (
    !isRecord(value.groups) ||
    !isRecord(value.tabs) ||
    (value.activeTabId !== null && typeof value.activeTabId !== "string")
  ) {
    return null;
  }
  const rootItems = parseItems(value.rootItems);
  if (rootItems === null) {
    return null;
  }

  const groups: Record<string, Group> = {};
  for (const [key, raw] of Object.entries(value.groups)) {
    const group = parseGroup(raw);
    if (group === null) {
      return null;
    }
    groups[key] = group;
  }

  const tabs: Record<string, Tab> = {};
  for (const [key, raw] of Object.entries(value.tabs)) {
    const tab = parseTab(raw);
    if (tab === null) {
      return null;
    }
    tabs[key] = tab;
  }

  const auxWindows: Record<string, AuxWindowSlot> = {};
  if (value.version === 3) {
    if (!isRecord(value.auxWindows)) {
      return null;
    }
    for (const [key, raw] of Object.entries(value.auxWindows)) {
      const slot = parseAuxWindowSlot(raw);
      if (slot === null) {
        return null;
      }
      auxWindows[key] = slot;
    }
  }

  const layout: Layout = {
    version: 3,
    groups,
    rootItems,
    tabs,
    activeTabId: value.activeTabId,
    auxWindows,
    windowNames: parseWindowNames(value.windowNames),
  };

  return validateInvariants(layout).length === 0 ? layout : null;
}

/// Deep-copy into a plain JsonValue for ClientMsg::set_layout. The store never
/// mutates state in place, but the copy keeps the wire payload detached from
/// live state regardless.
export function serializeLayout(layout: Layout): JsonValue {
  return JSON.parse(JSON.stringify(layout)) as JsonValue;
}
