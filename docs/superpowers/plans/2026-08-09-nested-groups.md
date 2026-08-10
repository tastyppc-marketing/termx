# Nested Groups (layout_v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sidebar groups can nest to a user-configurable depth (default 3) via a new layout_v2 schema that also carries the group-color and tab-fill fields the theme batch will render.

**Architecture:** layout_v2 keeps flat maps (`groups`, `tabs`) with ordered `Item` reference lists (`rootItems`, `GroupV2.items`) so nesting is references, not physical containment. All mutation goes through `WorkspaceController`; the daemon stores the layout as an opaque JSON blob, so this is UI-only. v1 blobs migrate one-way at parse time.

**Tech Stack:** TypeScript (React 19), vitest + @testing-library/react, existing parse-gate philosophy in `ui/src/state/layout.ts`.

**Spec:** `docs/superpowers/specs/2026-08-09-nested-groups-design.md` — read it first; it is authoritative on invariants.

## Global Constraints

- `exactOptionalPropertyTypes` is ON: never assign `undefined` to an optional prop — spread conditionally: `{...(x ? { x } : {})}`.
- Parse gate: `parseLayout` returns `null` on ANY violation, never throws into UI code.
- Hard parse cap `MAX_GROUP_DEPTH = 8`; user setting `maxGroupDepth` (default 3) gates creation/movement only, never parsing.
- Existing v1 rules unchanged: names 1..64 chars, split depth ≤ 4, 256 KiB blob cap.
- No hardcoded absolute machine paths anywhere.
- Gates before finishing: `cd ui && npx tsc -b` clean; `npx vitest run --reporter=dot` all green (baseline 751 + new); e2e suite still 5 green.
- Never `git stash`; never create junctions/symlinks into the main repo; commit per task on your branch.

## File Structure

- `ui/src/state/layout.ts` — becomes the v2 module. Canonical exports keep the names consumers already import (`Tab`, `Group`, plus new `LayoutV2` exported as `Layout`); v1 shapes remain internal for migration only.
- `ui/src/workspace/WorkspaceController.ts` — all new mutations.
- `ui/src/sidebar/Sidebar.tsx` / `Sidebar.css` — recursive rendering, menus, drag/drop.
- `ui/src/settings/settings.ts` + `SettingsDialog` — `maxGroupDepth`.
- `docs/superpowers/specs/2026-08-09-termx-layout-v2.md` — the schema spec doc (Task 1 deliverable; mirror the style of `2026-07-22-termx-layout-v1.md` and update the mirror comment at layout.ts:3).

---

### Task 1: layout_v2 schema, validation, migration, spec doc

**Files:**
- Modify: `ui/src/state/layout.ts`
- Test: `ui/src/state/__tests__/layout.test.ts` (extend existing)
- Create: `docs/superpowers/specs/2026-08-09-termx-layout-v2.md`

**Interfaces (Produces — later tasks and the theme batch rely on these exact names):**

```ts
export const FILL_STRENGTHS = ["off", "subtle", "strong"] as const;
export type FillStrength = (typeof FILL_STRENGTHS)[number];

export type Item = { kind: "tab"; id: string } | { kind: "group"; id: string };

export interface Tab {           // v2 shape under the existing name
  id: string;
  title: string | null;
  color: PaletteId;
  fill: FillStrength;
  split: SplitNode;
}

export interface Group {         // v2 shape under the existing name
  id: string;
  name: string;
  collapsed: boolean;
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
export type Layout = LayoutV2;

export const MAX_GROUP_DEPTH = 8;

export function emptyLayout(): LayoutV2;                      // { version: 2, groups: {}, rootItems: [], tabs: {}, activeTabId: null }
export function parseLayout(value: unknown): LayoutV2 | null; // accepts v1 AND v2 blobs; v1 → migrated v2
export function migrateV1(v1: LayoutV1): LayoutV2;            // exported for tests
export function validateInvariants(layout: LayoutV2): string[];
export function serializeLayout(layout: LayoutV2): JsonValue;

// Pure helpers (unit-tested here, consumed by Tasks 2/4/5):
export function groupDepth(layout: LayoutV2, groupId: string): number;        // root-level group = 1
export function subtreeDepth(layout: LayoutV2, groupId: string): number;      // group with no subgroups = 1
export function findContainer(layout: LayoutV2, item: Item): string | null;   // parent group id, null = root
export function collectSubtreeTabIds(layout: LayoutV2, groupId: string): string[]; // depth-first order
export function canMoveItem(
  layout: LayoutV2, item: Item, targetGroupId: string | null, maxDepth: number,
): boolean;
```

`canMoveItem` rules: target must exist (or be root); a group may not move into itself or its own subtree; for a group item, `(targetGroupId ? groupDepth(layout, targetGroupId) : 0) + subtreeDepth(layout, item.id) <= maxDepth`; for a tab item, target depth alone must be `<= maxDepth`. Moving within the same container (reorder) is always legal.

Migration mapping (spec §2): v1 group → `Group` with `color: null`, `items: tabIds.map(id => ({kind:"tab",id}))`, appearing in `rootItems` in v1 order; then `ungroupedTabIds` as root tab items; every tab gains `fill: "off"`.

New invariants (spec §1) added to `validateInvariants`: every tab/group id referenced by exactly one container; every group in `groups` reachable from `rootItems`; no cycles; nesting depth ≤ `MAX_GROUP_DEPTH`; `groups` map keys match `Group.id` (same pattern as tabs at layout.ts:192).

- [ ] **Step 1: Write failing tests** — in `layout.test.ts`, at minimum:

```ts
describe("layout v2", () => {
  it("parses a valid v2 blob round-trip", () => {
    const layout: LayoutV2 = {
      version: 2,
      groups: {
        g1: { id: "g1", name: "Marketing", collapsed: false, color: "blue",
              items: [{ kind: "group", id: "g2" }, { kind: "tab", id: "t1" }] },
        g2: { id: "g2", name: "Clients", collapsed: true, color: null,
              items: [{ kind: "tab", id: "t2" }] },
      },
      rootItems: [{ kind: "group", id: "g1" }, { kind: "tab", id: "t3" }],
      tabs: {
        t1: { id: "t1", title: null, color: "red", fill: "off", split: { kind: "pane", sessionId: 1 } },
        t2: { id: "t2", title: "api", color: "green", fill: "subtle", split: { kind: "pane", sessionId: 2 } },
        t3: { id: "t3", title: null, color: "slate", fill: "strong", split: { kind: "pane", sessionId: 3 } },
      },
      activeTabId: "t1",
    };
    expect(parseLayout(JSON.parse(JSON.stringify(serializeLayout(layout))))).toEqual(layout);
  });

  it("migrates a v1 blob preserving order and defaulting fill/color", () => {
    const v2 = parseLayout({
      version: 1,
      groups: [{ id: "g1", name: "Work", collapsed: false, tabIds: ["t1"] }],
      ungroupedTabIds: ["t2"],
      tabs: {
        t1: { id: "t1", title: null, color: "blue", split: { kind: "pane", sessionId: 1 } },
        t2: { id: "t2", title: null, color: "red", split: { kind: "pane", sessionId: 2 } },
      },
      activeTabId: "t2",
    });
    expect(v2).not.toBeNull();
    expect(v2!.rootItems).toEqual([{ kind: "group", id: "g1" }, { kind: "tab", id: "t2" }]);
    expect(v2!.groups.g1!.color).toBeNull();
    expect(v2!.tabs.t1!.fill).toBe("off");
  });

  it("rejects a group cycle", () => { /* g1.items contains g2, g2.items contains g1; also neither reachable twice — expect null */ });
  it("rejects an orphan group (in groups map, unreachable from rootItems)", () => { /* expect null */ });
  it("rejects a group referenced by two containers", () => { /* expect null */ });
  it("rejects nesting depth 9 and accepts depth 8", () => { /* build a chain of 9 groups; expect null; 8 → non-null */ });
  it("canMoveItem forbids moving a group into its own subtree", () => { /* expect false */ });
  it("canMoveItem enforces target depth + subtree depth against maxDepth", () => {
    /* g1>g2 (subtreeDepth(g1)=2); moving g1 under a depth-2 group with maxDepth 3 → false; maxDepth 4 → true */
  });
  it("canMoveItem always allows reorder within the same container", () => { /* even at maxDepth already reached */ });
});
```

- [ ] **Step 2:** Run `npx vitest run src/state/__tests__/layout.test.ts` — new tests FAIL (missing exports).
- [ ] **Step 3:** Implement in `layout.ts`: rename the current public shapes to internal `TabV1`/`GroupV1`/`LayoutV1` and keep their parsers as `parseLayoutV1` (private); add the v2 types/parsers/validators/helpers above; `parseLayout` dispatches on `value.version` (1 → `parseLayoutV1` then `migrateV1`; 2 → v2 parser; anything else → null). Reachability + cycle check: iterative DFS from `rootItems` counting visits; any group visited twice, or in `groups` but never visited, is a violation.
- [ ] **Step 4:** Full state suite green: `npx vitest run src/state`.
- [ ] **Step 5:** Write `docs/superpowers/specs/2026-08-09-termx-layout-v2.md` (schema, invariants, migration table, wire examples) and update the mirror comment at layout.ts:3 to point at it.
- [ ] **Step 6:** Commit: `feat(layout): layout_v2 schema with nested groups, group color, tab fill`.

Note: `tsc -b` will now fail in consumers (`WorkspaceController`, `Sidebar`, tests) that use `tabIds`/`ungroupedTabIds` — that is expected mid-plan; Tasks 2 and 4 restore it. Run targeted vitest files until Task 4, then the full gate.

### Task 2: WorkspaceController mutations

**Files:**
- Modify: `ui/src/workspace/WorkspaceController.ts` (port existing group/tab ops to v2 shapes; the hardcoded "slate" at WorkspaceController.ts:362 becomes `color: null`)
- Test: `ui/src/workspace/__tests__/WorkspaceController.test.ts`

**Interfaces:**
- Consumes: everything in Task 1's Produces block.
- Produces (Sidebar calls these in Tasks 4–5):

```ts
createGroup(parentGroupId: string | null, name?: string): string | null;  // returns new group id; null if depth-gated
moveItem(item: Item, targetGroupId: string | null, index: number): boolean; // false = rejected (canMoveItem)
deleteGroup(groupId: string, mode: "keep-children" | "close-tabs"): Promise<void>;
recolorGroup(groupId: string, color: PaletteId | null): void;
setTabFill(tabId: string, fill: FillStrength): void;
```

Every mutation follows the controller's existing pattern: build the next layout, `validateInvariants` (abort + log on any problem), persist via `setLayout` with the existing rollback discipline. `deleteGroup("keep-children")` splices the group's `items` into its parent container at the group's position; `"close-tabs"` closes every session in `collectSubtreeTabIds` via the existing close path, then removes the whole subtree from `groups`.

- [ ] **Step 1:** Write failing tests (extend the existing controller test harness/fakes): createGroup nests under parent and returns id; createGroup at `maxGroupDepth` returns null and does not call setLayout; moveItem tab into group / group into group / reorder / illegal cycle move returns false; deleteGroup keep-children splices at position; deleteGroup close-tabs closes all subtree sessions (assert on the fake host) then persists; recolorGroup + setTabFill round-trip through the persisted blob; failed setLayout rolls back state (existing rollback-test pattern).
- [ ] **Step 2:** Run the controller test file — FAIL.
- [ ] **Step 3:** Port controller internals to v2 (`items`/`rootItems` walks replace `tabIds`/`ungroupedTabIds`) and implement the five mutations. `maxGroupDepth` arrives via the controller's existing settings access (Task 3 adds the field; until then hardcode `DEFAULT_SETTINGS.maxGroupDepth` reference so the two tasks are order-independent within the branch).
- [ ] **Step 4:** Controller suite green.
- [ ] **Step 5:** Commit: `feat(workspace): v2 layout mutations — nested groups, group color, tab fill`.

### Task 3: `maxGroupDepth` setting

**Files:**
- Modify: `ui/src/settings/settings.ts`, `ui/src/settings/SettingsDialog.tsx`
- Test: `ui/src/settings/__tests__/settings.test.ts`, `SettingsDialog.test.tsx`

**Interfaces — Produces:**

```ts
export const MAX_GROUP_DEPTH_OPTIONS = [1, 2, 3, 4, 5] as const;
export type MaxGroupDepthOption = (typeof MAX_GROUP_DEPTH_OPTIONS)[number];
// TermxSettings gains: readonly maxGroupDepth: MaxGroupDepthOption;   default 3
```

- [ ] **Step 1:** Failing tests: default is 3; `7`/`"deep"`/missing → 3 (tolerant per-field parse, same pattern as every existing field); round-trips when set to 5; dialog renders the control and persists a change.
- [ ] **Step 2:** FAIL → **Step 3:** implement (follow the exact guard-function pattern used by `sleepHiddenTerminals`) → **Step 4:** settings suite green → **Step 5:** Commit: `feat(settings): maxGroupDepth (default 3)`.

### Task 4: Recursive sidebar rendering

**Files:**
- Modify: `ui/src/sidebar/Sidebar.tsx`, `ui/src/sidebar/Sidebar.css`
- Test: `ui/src/sidebar/__tests__/Sidebar.test.tsx` (extend existing)

**Interfaces:** Consumes Task 1 helpers + v2 shapes. The flat `groups.map(...)` + `ungroupedTabIds` render becomes: render `rootItems` via a recursive `SidebarItems({ items, depth })` helper; group rows recurse into `group.items` when not collapsed.

- Indent: `padding-left: calc(var(--sidebar-indent, 12px) * depth)`; a 1 px indent guide per level (`border-left: 1px solid var(--border, #2a3040)` on the nested container — literal fallback until the theme batch defines tokens).
- `aria-level={depth + 1}` on rows; keyboard/focus order unchanged from the flat implementation.
- Group color dot: hardcoded slate at Sidebar.tsx:622 becomes `group.color ?? "slate"` (full color *rendering* — frames/washes/stripes — belongs to the theme batch; the dot is just kept truthful).
- Collapse behavior per group as today.

- [ ] **Step 1:** Failing tests: a 3-level layout renders nested rows with correct `aria-level`s; collapsing a middle group hides its subtree only; tabs inside a nested group activate on click (existing activation assertion pattern).
- [ ] **Step 2:** FAIL → **Step 3:** implement recursion + CSS → **Step 4:** sidebar suite green, and now `npx tsc -b` must be clean repo-wide (all v1 consumers ported) → **Step 5:** Commit: `feat(sidebar): recursive nested-group rendering`.

### Task 5: Context menus + drag & drop nesting

**Files:**
- Modify: `ui/src/sidebar/Sidebar.tsx` (menus + DnD), `ui/src/workspace/WorkspaceController.ts` only if a menu needs a query helper
- Test: `ui/src/sidebar/__tests__/Sidebar.test.tsx`

Menus (extend the existing context-menu implementation):
- Group menu: **New subgroup** (disabled with title tooltip `Max group depth is N — change it in Settings` when `groupDepth + 1 > maxGroupDepth`), **Move to…** submenu listing root + every eligible group (filtered by `canMoveItem`), **Delete group** → the two-mode choice (keep tabs / close tabs), **Rename**, existing entries preserved.
- Tab menu: **Move to…** with the same eligible-group list.

Drag & drop (extend the existing flat DnD): dropping on a group header appends into it; dropping between rows inserts at that index in that row's container; targets that fail `canMoveItem` never render a drop indicator (compute eligibility on drag-start against the dragged item).

- [ ] **Step 1:** Failing tests: New-subgroup disabled at the depth limit; Move-to list excludes the group's own subtree; drop onto own subtree shows no indicator and is a no-op; drop between rows calls `moveItem` with the right container + index.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** green → **Step 5:** Commit: `feat(sidebar): subgroup menus and nested drag-drop`.

### Task 6: new-tab policy with nesting + full gates

**Files:**
- Modify: `ui/src/workspace/WorkspaceController.ts` (new-tab target resolution)
- Test: `ui/src/workspace/__tests__/WorkspaceController.test.ts`

`newTabPolicy: "group-active"` resolves to the active tab's **immediate parent group** (`findContainer`); a new-tab action invoked from a group row's context menu creates inside that group. No settings change.

- [ ] **Step 1:** Failing tests: active tab nested two deep → new tab lands in its immediate parent; active tab at root → new tab at root; group-row new-tab lands in that group.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** green.
- [ ] **Step 5: Full gates** — `cd ui && npx tsc -b` clean; `npx vitest run --reporter=dot` all green (≥ 751 + new); `npx vitest run -c vitest.e2e.config.ts` 5 green.
- [ ] **Step 6:** Commit: `feat(workspace): nesting-aware new-tab policy` then a final `git log --oneline` in your report.

## Self-Review (done at plan time)

Spec coverage: §1→T1, §2→T1, §3→T3+T2 gate, §4→T2, §5→T4+T5, §6→T6, error handling→T1/T2 invariant-abort tests, testing list→mapped 1:1. No placeholders; names cross-checked (`canMoveItem`, `moveItem`, `FillStrength`, `MAX_GROUP_DEPTH_OPTIONS` consistent throughout).
