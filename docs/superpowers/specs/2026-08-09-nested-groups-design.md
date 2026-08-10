# TermX Nested Groups (layout_v2) — Design

**Date:** 2026-08-09 · **Status:** approved in brainstorm, pending spec review
**Companion specs (same batch):** `2026-08-09-reliability-reconnect-design.md`, `2026-08-09-theme-engine-tab-colors-design.md`

## Goal

Sidebar groups can contain subgroups to arbitrary depth (Marketing → Clients →
a specific client → …), gated by a user-configurable max-depth setting
(default 3), so both shallow-and-simple and deep-and-organized workflows work
out of the box. This spec also defines the **layout_v2 schema** — including
the group-color and tab-fill fields the theme/tab-color spec renders — so the
serialized format changes exactly once.

## Background: current state

- `ui/src/state/layout.ts` mirrors the layout_v1 spec
  (`docs/superpowers/specs/2026-07-22-termx-layout-v1.md`) exactly; nothing
  outside that document may enter the serialized blob (layout.ts:3-4).
- v1 shapes: `Group { id, name, collapsed, tabIds: string[] }` (flat, one
  level); `LayoutV1 { version: 1, groups: Group[], ungroupedTabIds, tabs,
  activeTabId }`; `Tab { id, title, color: PaletteId, split }`.
- Validation: `parseLayout` (layout.ts:321) rejects any shape/invariant
  violation and returns null — UI falls back, never crashes. `validateInvariants`
  (layout.ts:157) enforces every-tab-in-exactly-one-container, name/id rules,
  split depth ≤ 4, 256 KiB byte cap.
- The host stores the layout as an **opaque JSON blob** (`set_layout` /
  `get_state` round-trip it verbatim) — the migration is UI-only; the daemon
  needs no change.
- Sidebar rendering: `ui/src/sidebar/Sidebar.tsx` renders `groups` then
  `ungroupedTabIds`; group color is hardcoded "slate" (Sidebar.tsx:622);
  drag/reorder and the group context menu already exist for the flat case.
  `ui/src/workspace/WorkspaceController.ts` owns all layout mutations.

## Design

### 1. layout_v2 schema (new spec doc: `2026-08-09-termx-layout-v2.md`, authored as part of this work)

```ts
type FillStrength = "off" | "subtle" | "strong";
type Item = { kind: "tab"; id: string } | { kind: "group"; id: string };

interface TabV2 {                    // Tab + one field
  id: string;
  title: string | null;
  color: PaletteId;
  fill: FillStrength;                // rendered by the theme spec; default "off"
  split: SplitNode;
}

interface GroupV2 {
  id: string;
  name: string;
  collapsed: boolean;
  color: PaletteId | null;           // null = neutral (today's look)
  items: Item[];                     // ordered children: tabs and subgroups
}

interface LayoutV2 {
  version: 2;
  groups: Record<string, GroupV2>;   // flat map; nesting lives in items
  rootItems: Item[];                 // top level of the sidebar
  tabs: Record<string, TabV2>;
  activeTabId: string | null;
}
```

Flat maps + `Item` references (rather than groups physically containing
groups) keep lookups O(1), keep mutations shallow-copy-friendly, and make the
cycle check trivial.

**Invariants (extends v1's set):** every tab id and group id referenced by
exactly one container (`rootItems` or one group's `items`); every group in
`groups` is reachable from `rootItems` (no orphans); **no cycles**; group
nesting depth ≤ `MAX_GROUP_DEPTH = 8` (hard parse cap, distinct from the user
setting); existing v1 rules (names 1..64, split depth ≤ 4, 256 KiB blob cap)
unchanged. `validateInvariants` reports all violations; `parseLayout` rejects
on any.

### 2. Migration v1 → v2 (one-way, at load)

`parseLayout` accepts both versions. A `version: 1` blob is parsed with the
existing v1 parser, then mapped: each v1 group → root-level `GroupV2` with
`color: null` and `items` from `tabIds`; `ungroupedTabIds` → root tab items
after the groups (preserving today's visual order); every tab gains
`fill: "off"`. The first subsequent `set_layout` persists v2. There is no
downgrade path (consistent with v1's parse-gate philosophy: an old UI reading
a v2 blob falls back to an empty layout rather than corrupting it — and the
daemon keeps sessions alive regardless).

### 3. Max-depth setting

- `TermxSettings` (`ui/src/settings/settings.ts`) gains
  `maxGroupDepth: 1 | 2 | 3 | 4 | 5` (default **3**; 1 = today's flat
  behavior). Tolerant parsing per the settings file's per-field philosophy.
- The setting gates **creation and movement only** (create-subgroup, drag a
  group into another group): operations that would place a group deeper than
  the setting are disabled in menus and rejected as no-op drops with a brief
  tooltip ("Max group depth is 3 — change it in Settings").
- Parsing is NOT gated by the setting: a layout deeper than the current
  setting (built earlier, or on another machine) still renders and works —
  only the hard cap of 8 rejects. Lowering the setting never destroys
  structure.

### 4. Mutations (WorkspaceController)

New/extended operations, each with the same rollback discipline as existing
ones: `createGroup(parentGroupId | null)`, `moveItem(item, targetGroupId |
null, index)` (covers tab-into-group, group-into-group, reorder, out-to-root),
`deleteGroup(id, mode: "keep-children" | "close-tabs")` — keep-children
splices the group's items into its parent at its position; close-tabs walks
the subtree, closes sessions via the existing close path, then removes.
`recolorGroup(id, color | null)` and `setTabFill(id, strength)` mutate the new
fields (rendered by the theme spec). All operations validate depth and
invariants before persisting via `setLayout`.

### 5. Sidebar UI

- Recursive `SidebarGroup` component replacing the flat map: children indent
  by 12 px per level with a 1 px hairline indent guide (token
  `--border` from the theme spec; falls back to current hex until that spec
  lands).
- Collapse state per group as today (`collapsed` persists).
- Context menus: group menu gains "New subgroup" (disabled at depth limit) and
  "Move to…" (submenu of eligible groups); tab menu gains "Move to…" with the
  same eligible-group list.
- Drag and drop: dropping onto a group's header nests into it (append);
  dropping between rows inserts at that index in that container. Eligibility
  (depth, no-cycle: a group cannot drop into its own subtree) computed before
  the drop renders a target indicator, so illegal drops never show a target.
- Keyboard/a11y parity with existing rows (same roles/focus order, one more
  `aria-level`).

### 6. Interaction with new-tab policy

`newTabPolicy: "group-active"` (settings.ts:11) currently means "the active
tab's group." With nesting it means the active tab's **immediate parent
group**; a "new tab" created on a group row's context menu creates inside that
group. No settings change needed.

## Error handling

- Any mutation that would violate invariants (including depth and cycles)
  aborts before `setLayout` and logs; the UI state never diverges from the
  persisted blob.
- A v2 blob that fails validation falls back exactly as v1 does today (empty
  layout + reconcile recovers sessions as ungrouped tabs — existing behavior,
  extended test coverage).

## Testing

- `layout.ts` unit tests: v2 parse round-trip, v1→v2 migration (order
  preservation, fill/color defaults), cycle rejection, orphan-group rejection,
  depth-8 hard cap, byte cap with deep structures.
- `WorkspaceController` tests: each new mutation incl. rollback on setLayout
  failure, deleteGroup both modes, depth-gate enforcement, no-cycle moves.
- `Sidebar` component tests: recursive render, drag-eligibility (no target on
  illegal drops), context-menu gating at depth limit, subgroup collapse.
- Settings tests: `maxGroupDepth` parse/tolerance/default.
- Gates: ui `tsc -b` clean, vitest ≥ 751 baseline, e2e 5, cargo unchanged
  (157/130) — host untouched.

## Out of scope

Rendering of group colors and tab fills (theme spec); cross-window drag;
group-level batch actions (close all, restart all) beyond delete;
import/export of layouts.
