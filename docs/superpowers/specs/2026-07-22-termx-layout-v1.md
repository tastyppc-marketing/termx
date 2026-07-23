# TermX `layout_v1` — the SetLayout blob schema

Authoritative schema for the JSON value the UI persists via `SetLayout` and restores via `GetState`. T5 (sidebar), T7 (splits), and T8 (restore) all read/write this shape — nobody invents fields outside this document; changes go through the supervisor.

## Model

**Tab = a split tree of sessions.** The sidebar lists *tabs* (in collapsible groups), not raw sessions. A simple tab is a one-pane tree. Sessions are host-side objects; a tab references them by host session id. Per-session cosmetics (color, custom title) live in `sessionMeta` so they survive a session moving between tabs.

## Schema (TypeScript)

```ts
interface LayoutV1 {
  version: 1;
  groups: Group[];              // ordered, as rendered
  ungroupedTabIds: string[];    // ordered tabs outside any group (rendered above groups)
  tabs: Record<string, Tab>;    // keyed by Tab.id
  activeTabId: string | null;
}

interface Group {
  id: string;                   // uuid, UI-generated
  name: string;                 // 1..64 chars
  collapsed: boolean;
  tabIds: string[];             // ordered
}

interface Tab {
  id: string;                   // uuid, UI-generated
  title: string | null;         // null => derive from active pane's session (profile + cwd tail)
  color: string;                // one of the 8 palette ids: "blue"|"cyan"|"green"|"yellow"|"orange"|"red"|"magenta"|"slate"
  split: SplitNode;
}

type SplitNode =
  | { kind: "pane"; sessionId: number }                 // host SessionId (u32)
  | { kind: "split"; dir: "row" | "col";
      sizes: [number, number];                          // fractions, sum ≈ 1, each ≥ 0.1
      children: [SplitNode, SplitNode] };
```

## Invariants

- Every `tabIds` entry resolves to a key in `tabs`; every tab id appears in exactly one of `ungroupedTabIds` or one group's `tabIds`.
- A `sessionId` appears in at most one pane across ALL tabs (a session is never shown twice).
- `activeTabId` is null or a valid tab id.
- Split depth ≤ 4 (v1 cap; deeper trees are a UX failure, not a feature).
- Serialization is plain JSON, ≤ 256 KiB (the host accepts up to the 1 MiB frame cap; we stay far under).

## Restore reconciliation (T8, normative)

On boot the UI has `GetState` → `{layout, sessions}`:

1. **Session in layout but not alive in `sessions`** (or absent entirely): its pane renders a *dead placeholder* ("session ended — Dismiss"); Dismiss prunes the pane from the tree (collapsing single-child splits) and, if the session STILL exists host-side as exited-but-unclosed, sends `CloseSession` to free the host ring. A tab whose whole tree is dead placeholders shows as a dead tab; dismissing it removes the tab.
2. **Live session on the host but referenced by no tab**: never orphaned — auto-append a new one-pane tab (ungrouped, tail position, color `slate`, derived title). A live session must always be reachable in the UI.
3. **Malformed/unknown layout** (bad version, invariant violation): do not crash, do not overwrite immediately — fall back to rule 2 for all live sessions (fresh flat layout) and only persist once the user makes a layout change. The host's blob is treated as opaque and never "migrated" silently.
4. Persist via `SetLayout` on: structural change (create/close/move/split/rename/recolor/collapse/reorder), active-tab change debounced 2 s, drag operations only on drop (never mid-drag), split resize only on release. Await `LayoutSaved`; on `Error{context:"set_layout"}` show a non-blocking toast and retry once.

## Palette (the 8 color ids → hex, from the UI quality bar)

blue `#7aa2f7` · cyan `#7dcfff` · green `#9ece6a` · yellow `#e0af68` · orange `#ff9e64` · red `#f7768e` · magenta `#bb9af7` · slate `#565f89`
