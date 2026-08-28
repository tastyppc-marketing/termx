# Multi-Window Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution — the tasks are tightly coupled through one layout model; judgment stays in the main thread per Michael's standing routing). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Move to new window" — a tab or group re-parents into its own OS window; sessions never restart; windows restore on relaunch; closing a window returns its items to main.

**Architecture:** `layout_v3` adds window slots over the unchanged tab/group pools. The main window is the only `SetLayout` writer; aux windows forward mutations over the Tauri event bus. Each window runs the full existing UI, filtered to its slot.

**Tech Stack:** existing — React 19 / TS, Tauri 2 (`WebviewWindow`, `emit`/`listen`), daemon untouched.

**Spec:** `docs/superpowers/specs/2026-08-26-multi-window-design.md`

## Global Constraints

- Daemon and wire protocol: zero changes.
- No absolute machine paths in code (portability rule).
- Gates per task: `npx tsc -b` and the affected vitest files; full `npx vitest run` before each commit.
- Existing v2 blobs must load losslessly into `windows.main`.
- A v3 blob failing to parse falls back exactly like any malformed layout today (orphan adoption) — never a crash, never session loss.

---

### Task 1: `layout_v3` model, migration, validation

**Files:**
- Modify: `ui/src/state/layout.ts`
- Test: `ui/src/state/__tests__/layout.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  export interface WindowSlot {
    rootItems: Item[];
    activeTabId: string | null;
    bounds: { x: number; y: number; width: number; height: number } | null;
  }
  export interface LayoutV3 {
    version: 3;
    groups: Record<string, Group>;
    tabs: Record<string, Tab>;
    windows: Record<string, WindowSlot>; // always contains "main"
  }
  export type Layout = LayoutV3;
  export const MAIN_WINDOW_ID = "main";
  export function emptyLayout(): LayoutV3; // { windows: { main: emptySlot } }
  export function windowIds(layout: Layout): string[]; // "main" first, aux sorted
  ```
- Compat shims so the diff stays reviewable: `layout.rootItems` / `layout.activeTabId` accessors are REMOVED, and every call site is repointed at an explicit slot (Task 2 does the repointing; this task keeps both worlds compiling via exported helpers `slotOf(layout, windowId)` returning the `WindowSlot`).

- [ ] Failing tests first: v2 blob parses into `windows.main` verbatim (rootItems, activeTabId preserved; groups/tabs untouched); v3 round-trips; unknown window ids survive; a v3 blob missing `main` gains an empty main slot; malformed windows record → parse failure (existing malformed path).
- [ ] Implement: `LayoutV3` shapes, `migrateV2toV3`, `parseLayout` accepting v1→v2→v3 chain, `serializeLayout` writing v3, validation (every `rootItems` item id must exist exactly once across ALL slots + group items — the existing uniqueness walk widened to iterate slots).
- [ ] Full layout test file green; commit.

### Task 2: WorkspaceController learns which window it is

**Files:**
- Modify: `ui/src/workspace/WorkspaceController.ts`, `ui/src/workspace/bootstrapWorkspace.ts`, `ui/src/workspace/layoutOperations.ts`
- Test: `ui/src/workspace/__tests__/WorkspaceController.test.ts` (extend)

**Interfaces:**
- `bootstrapWorkspace(options)` gains `windowId?: string` (default `MAIN_WINDOW_ID`), stored on the controller as `readonly windowId`.
- Every read of `layout.rootItems` / `layout.activeTabId` becomes `slotOf(this.layout, this.windowId)`. The controller's snapshot (`ungroupedTabs`, `groups`, `activeTabId`) reflects ONLY this window's slot. Sessions in other slots are not attached by this window (attach-active-first walks this slot only).
- New mutations: `moveItemToWindow(item: Item, targetWindowId: string | "new"): string` (returns the target window id; allocates `aux-<n>` on "new"; removes from the source slot, appends to the target slot's rootItems); `returnWindowToMain(windowId)` (Task 4 uses it).

- [ ] Failing tests: controller with `windowId: "aux-1"` snapshots only that slot; `moveItemToWindow` moves a tab out of main's slot into a fresh `aux-1` and out again; groups move whole; moving the last item of an aux slot leaves an empty slot (pruning happens on close, not on move).
- [ ] Implement; run controller tests + full suite; commit.

### Task 3: single-writer mutation routing

**Files:**
- Create: `ui/src/workspace/windowBus.ts`
- Test: `ui/src/workspace/__tests__/windowBus.test.ts`
- Modify: `ui/src/workspace/WorkspaceController.ts` (persist path)

**Interfaces:**
- ```ts
  export interface WindowBus {
    /** Aux → main: apply this mutation to the shared layout. */
    forwardMutation(mutation: LayoutMutation): void;
    /** Main → all: the layout changed; here is the new blob. */
    broadcastLayout(layout: JsonValue): void;
    onMutation(handler: (mutation: LayoutMutation) => void): () => void;
    onLayout(handler: (layout: JsonValue) => void): () => void;
  }
  export type LayoutMutation = { kind: "setLayout"; layout: JsonValue };
  export function tauriWindowBus(): WindowBus; // emit/listen on "termx:layout-mutation" / "termx:layout-state"
  export function loopbackBus(): WindowBus;    // in-process, for tests and single-window
  ```
- v1 of the mutation protocol is deliberately coarse: an aux window sends its ENTIRE proposed layout (it holds the full model; it edited its own slot). Main validates (parse) and persists. Coarse is safe because slots partition ownership: aux only ever rewrites its own slot plus explicit cross-window moves, and simultaneous edits to different slots converge because main re-broadcasts the merged truth. (Finer-grained ops are a v2 refinement if drift is ever observed.)
- Controller: `persistLayout()` branches — main window: `client.setLayout` + `bus.broadcastLayout`; aux window: `bus.forwardMutation` only. Main subscribes `onMutation` → adopt (parse, replace NON-own slots? no — replace whole model, then re-broadcast). Aux subscribes `onLayout` → adopt without persisting.

- [ ] Failing tests with `loopbackBus`: aux mutation reaches main and main persists once; main broadcast reaches aux and aux does NOT persist; malformed forwarded blob is dropped (main keeps its model).
- [ ] Implement; gates; commit.

### Task 4: window lifecycle — spawn, adopt at boot, close-returns-to-main

**Files:**
- Create: `ui/src/workspace/windowManager.ts`
- Test: `ui/src/workspace/__tests__/windowManager.test.ts`
- Modify: `ui/src/App.tsx` (main window: adopt-at-boot effect), `ui/src/main.tsx` (read `?window=` from location.search → pass to bootstrap)

**Interfaces:**
- ```ts
  export interface WindowFactory {  // injected; real impl wraps WebviewWindow
    open(windowId: string, bounds: WindowSlot["bounds"]): Promise<void>;
    onCloseRequested(windowId: string, handler: () => Promise<void>): void;
  }
  export function adoptWindows(layout: Layout, factory: WindowFactory): Promise<void>; // opens every aux slot
  ```
- Real factory: `new WebviewWindow(windowId, { url: `index.html?window=${windowId}`, ...bounds })`. Close-requested on an aux window: forward a `returnWindowToMain` mutation, await the layout broadcast, then destroy. Main window close keeps today's CloseGuard behavior (app exit).
- Bounds recording: aux windows debounce `onMoved`/`onResized` into their slot via the bus (500ms).

- [ ] Failing tests with a fake factory: boot with two aux slots opens both at recorded bounds; close-requested returns items to main slot and deletes the slot; a crash-left slot (no window ever opened) still opens next boot.
- [ ] Implement; gates; commit.

### Task 5: UI surface — context-menu entries

**Files:**
- Modify: `ui/src/sidebar/Sidebar.tsx` (+ `SidebarActions`), `ui/src/App.tsx` (action wiring)
- Test: `ui/src/sidebar/__tests__/Sidebar.test.tsx` (extend)

**Interfaces:**
- `SidebarActions` += `moveToWindow(item: Item, targetWindowId: string | "new"): void`; sidebar props += `otherWindowIds: readonly string[]`.
- Tab context menu and group context menu gain: **"Move to new window"** always; **"Move to <window label>"** per other window (label: "Main window" / "Window 2"…).

- [ ] Failing tests: menu shows the entries; clicking calls `moveToWindow` with the right item; entries absent when the feature callback is not provided (legacy fixtures).
- [ ] Implement; gates; full suite; commit.

### Task 6: live verification + staging

- [ ] Manual live check (with Michael or scripted probe): move a running Claude tab to a new window — stream continues; close the window — tab returns to main alive; relaunch — both windows restore.
- [ ] `npx tauri build --no-bundle` from `ui/`, fingerprint check, stage with next `.prevN` rotation, handoff delta.

## Self-review notes
- Spec coverage: layout v3 (T1), single-writer (T3), lifecycle/restore/close-return (T4), menu surface (T5), phase-2 drag explicitly out.
- Type consistency: `WindowSlot`/`MAIN_WINDOW_ID`/`slotOf` defined in T1 and consumed by name in T2–T4.
- Risk log: attach-active-first currently attaches ALL sessions from one connection at boot; with aux windows each window attaches only its slot (T2) — double-attach of a session by two windows is prevented structurally, but the transition of a MOVED tab must detach-in-source-before-attach-in-target: the move mutation lands via broadcast, source window's snapshot loses the tab → its pane unmounts → detach; target window's snapshot gains it → attach. Ordering is eventually consistent and the daemon tolerates overlap (broadcast output), so a brief double-attach is benign.
