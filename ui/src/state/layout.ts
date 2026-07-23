import type { JsonValue } from "../host/protocol";

/// Shapes mirror docs/superpowers/specs/2026-07-22-termx-layout-v1.md exactly.
/// Nothing outside that document may be added to the serialized blob.

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

export const MAX_NAME_LENGTH = 64;
export const MAX_SPLIT_DEPTH = 4;
export const MIN_PANE_FRACTION = 0.1;
export const MAX_LAYOUT_BYTES = 256 * 1024;

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

export interface Tab {
  id: string;
  title: string | null;
  color: PaletteId;
  split: SplitNode;
}

export interface Group {
  id: string;
  name: string;
  collapsed: boolean;
  tabIds: string[];
}

export interface LayoutV1 {
  version: 1;
  groups: Group[];
  ungroupedTabIds: string[];
  tabs: Record<string, Tab>;
  activeTabId: string | null;
}

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === "string" &&
    (PALETTE_IDS as readonly string[]).includes(value);
}

export function emptyLayout(): LayoutV1 {
  return {
    version: 1,
    groups: [],
    ungroupedTabIds: [],
    tabs: {},
    activeTabId: null,
  };
}

/// Number of nested split levels below `node`: a bare pane is 0, one split of
/// two panes is 1. The v1 cap is MAX_SPLIT_DEPTH.
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

export function sessionIdsInLayout(layout: LayoutV1): number[] {
  const out: number[] = [];
  for (const tab of Object.values(layout.tabs)) {
    sessionIdsInSplit(tab.split, out);
  }
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
export function validateInvariants(layout: LayoutV1): string[] {
  const problems: string[] = [];
  const containerRefs = new Map<string, number>();

  for (const id of layout.ungroupedTabIds) {
    containerRefs.set(id, (containerRefs.get(id) ?? 0) + 1);
  }
  const groupIds = new Set<string>();
  for (const group of layout.groups) {
    if (group.id.length === 0) {
      problems.push("group with empty id");
    }
    if (groupIds.has(group.id)) {
      problems.push(`duplicate group id ${group.id}`);
    }
    groupIds.add(group.id);
    if (!isValidName(group.name)) {
      problems.push(`group ${group.id}: name must be 1..${MAX_NAME_LENGTH} chars`);
    }
    for (const id of group.tabIds) {
      containerRefs.set(id, (containerRefs.get(id) ?? 0) + 1);
    }
  }

  for (const [id, count] of containerRefs) {
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
    if ((containerRefs.get(key) ?? 0) === 0) {
      problems.push(`tab ${key} is in no container`);
    }
    if (tab.title !== null && !isValidName(tab.title)) {
      problems.push(`tab ${key}: title must be null or 1..${MAX_NAME_LENGTH} chars`);
    }
    if (!isPaletteId(tab.color)) {
      problems.push(`tab ${key}: unknown color "${tab.color}"`);
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

function parseTab(value: unknown): Tab | null {
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

function parseGroup(value: unknown): Group | null {
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

/// Parse an untrusted GetState blob. Returns null on ANY version, shape, or
/// invariant violation — never throws into UI code (restore rule 3: malformed
/// layouts fall back, they don't crash). Unknown extra fields are dropped;
/// the result is a fresh deep copy detached from the input.
export function parseLayout(value: unknown): LayoutV1 | null {
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }
  if (
    !Array.isArray(value.groups) ||
    !isStringArray(value.ungroupedTabIds) ||
    !isRecord(value.tabs) ||
    (value.activeTabId !== null && typeof value.activeTabId !== "string")
  ) {
    return null;
  }

  const groups: Group[] = [];
  for (const raw of value.groups) {
    const group = parseGroup(raw);
    if (group === null) {
      return null;
    }
    groups.push(group);
  }

  const tabs: Record<string, Tab> = {};
  for (const [key, raw] of Object.entries(value.tabs)) {
    const tab = parseTab(raw);
    if (tab === null) {
      return null;
    }
    tabs[key] = tab;
  }

  const layout: LayoutV1 = {
    version: 1,
    groups,
    ungroupedTabIds: [...value.ungroupedTabIds],
    tabs,
    activeTabId: value.activeTabId,
  };

  return validateInvariants(layout).length === 0 ? layout : null;
}

/// Deep-copy into a plain JsonValue for ClientMsg::set_layout. The store never
/// mutates state in place, but the copy keeps the wire payload detached from
/// live state regardless.
export function serializeLayout(layout: LayoutV1): JsonValue {
  return JSON.parse(JSON.stringify(layout)) as JsonValue;
}
