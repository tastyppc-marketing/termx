# TermX `layout_v2` — the SetLayout blob schema

Authoritative schema for the JSON value the UI persists via `SetLayout` and restores via `GetState`. Supersedes `2026-07-22-termx-layout-v1.md`: v1 blobs are still *read* (migrated at parse time, see below) but nothing writes them again. Nobody invents fields outside this document; changes go through the supervisor.

## Model

**Tab = a split tree of sessions**, unchanged from v1. What changes is the container model: groups nest. A group holds an ordered list of `Item` *references* — tabs and subgroups alike — while the groups and tabs themselves live in flat maps. Nesting is therefore a reference graph, not physical containment: lookups stay O(1), mutations shallow-copy one container, and the cycle check is a single walk.

Two cosmetic fields land in the same version bump so the serialized format changes exactly once: `Group.color` and `Tab.fill` (both rendered by the theme/tab-color spec, `2026-08-09-theme-engine-tab-colors-design.md`).

## Schema (TypeScript)

```ts
interface LayoutV2 {
  version: 2;
  groups: Record<string, Group>;   // keyed by Group.id; nesting lives in `items`
  rootItems: Item[];               // ordered top level of the sidebar
  tabs: Record<string, Tab>;       // keyed by Tab.id
  activeTabId: string | null;
}

type Item =
  | { kind: "tab"; id: string }    // → tabs[id]
  | { kind: "group"; id: string }; // → groups[id]

interface Group {
  id: string;                      // uuid, UI-generated
  name: string;                    // 1..64 chars
  collapsed: boolean;
  color: string | null;            // palette id, or null = neutral (the v1 look)
  items: Item[];                   // ordered children: tabs and subgroups
}

interface Tab {
  id: string;                      // uuid, UI-generated
  title: string | null;            // null => derive from active pane's session (profile + cwd tail)
  color: string;                   // one of the 8 palette ids
  fill: "off" | "subtle" | "strong";  // how strongly `color` washes the tab chrome
  split: SplitNode;
}

type SplitNode =
  | { kind: "pane"; sessionId: number }                 // host SessionId (u32)
  | { kind: "split"; dir: "row" | "col";
      sizes: [number, number];                          // fractions, sum ≈ 1, each ≥ 0.1
      children: [SplitNode, SplitNode] };
```

## Invariants

- Every `Item` resolves: `kind: "tab"` to a key in `tabs`, `kind: "group"` to a key in `groups`.
- Every tab id and every group id is referenced by **exactly one** container (`rootItems` or one group's `items`).
- Every group in `groups` is **reachable** from `rootItems` — no orphans.
- **No cycles.** (A cycle shows up as a group referenced by two containers, or as an unreachable group, so it is caught by the two rules above.)
- Group nesting depth ≤ **8** (`MAX_GROUP_DEPTH`, a hard parse cap). The user-facing `maxGroupDepth` setting (default 3) gates *creation and movement* only; a deeper layout built earlier or elsewhere still parses and renders.
- `groups[key].id === key` and `tabs[key].id === key`.
- A `sessionId` appears in at most one pane across ALL tabs (a session is never shown twice).
- `activeTabId` is null or a valid tab id.
- Split depth ≤ 4 (unchanged); `Tab.fill` is one of the three strengths; `Group.color` is a palette id or null.
- Serialization is plain JSON, ≤ 256 KiB.

`validateInvariants(layout)` reports every violation; `parseLayout(value)` returns `null` on any of them (or on any shape or version problem) and never throws.

## Migration v1 → v2 (one-way, at parse time)

`parseLayout` dispatches on `version`:

| v1 | v2 |
| --- | --- |
| `version: 1` | `version: 2` |
| `groups: Group[]` (ordered) | one `groups[id]` entry each, `{ kind: "group", id }` at the head of `rootItems` in the same order |
| `Group.tabIds` | `Group.items` as `{ kind: "tab", id }`, same order |
| (no group color) | `Group.color: null` |
| `ungroupedTabIds` | `{ kind: "tab", id }` appended to `rootItems` **after** the groups |
| `Tab` (no fill) | same tab plus `fill: "off"` |
| `activeTabId` | unchanged |

A v1 blob is shape-parsed, migrated, and then validated **as v2** — there is exactly one validator. The first subsequent `SetLayout` persists v2.

There is no downgrade path, consistent with the parse-gate philosophy: an older UI reading a v2 blob falls back to an empty layout (restore rule 3) rather than corrupting it, and the daemon keeps the sessions alive regardless — the blob is opaque to the host.

## Restore reconciliation (normative, unchanged from v1 except for wording)

On boot the UI has `GetState` → `{layout, sessions}`:

1. **Session in layout but not alive in `sessions`** (or absent entirely): its pane renders a *dead placeholder* ("session ended — Dismiss"); Dismiss prunes the pane from the tree (collapsing single-child splits) and, if the session STILL exists host-side as exited-but-unclosed, sends `CloseSession` to free the host ring. A tab whose whole tree is dead placeholders shows as a dead tab; dismissing it removes the tab.
2. **Live session on the host but referenced by no tab**: never orphaned — auto-append a new one-pane tab (root level, tail position, color `slate`, `fill: "off"`, derived title). A live session must always be reachable in the UI.
3. **Malformed/unknown layout** (bad version, invariant violation): do not crash, do not overwrite immediately — fall back to rule 2 for all live sessions (fresh flat layout) and only persist once the user makes a layout change. The host's blob is treated as opaque and never "migrated" silently, v1 → v2 excepted (it is a total, lossless mapping, applied only after a full parse succeeds).
4. Persist via `SetLayout` on: structural change (create/close/move/split/rename/recolor/collapse/reorder/nest), active-tab change debounced 2 s, drag operations only on drop (never mid-drag), split resize only on release. Await `LayoutSaved`; on `Error{context:"set_layout"}` show a non-blocking toast and retry once.

## Palette (the 8 color ids → hex, from the UI quality bar)

blue `#7aa2f7` · cyan `#7dcfff` · green `#9ece6a` · yellow `#e0af68` · orange `#ff9e64` · red `#f7768e` · magenta `#bb9af7` · slate `#565f89`
