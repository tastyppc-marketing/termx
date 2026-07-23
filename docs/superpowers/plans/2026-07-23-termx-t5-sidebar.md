# TermX T5 Sessions Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the daily-driver TermX sessions sidebar: persisted groups and colored tabs, attach-all activity state, pointer drag-and-drop, inline rename, custom context menus, keyboard navigation, live close confirmation, and dead-session Dismiss.

**Architecture:** `App` owns one `HostClient`, one reconciled `LayoutStore`, one `AttachmentHub`, one `LayoutPersistence`, and one `WorkspaceController`. The controller is the sole action/mutation boundary; `Sidebar` is presentational. The hub attaches every live host session sequentially over the existing WebSocket, retains a bounded replay tail, and exposes virtual `AttachmentClient` handles to the unchanged `TerminalPane`.

**Tech Stack:** React 19.2.7, TypeScript 6.0.3 strict mode, Vitest 4.1.10/jsdom, existing Tauri/HostClient/layout-v1 APIs, CSS transitions, native Pointer Events.

## Global Constraints

- Do not modify `C:\Dev\TermX\host\`, `C:\Dev\TermX\ui\src\host\`, `C:\Dev\TermX\ui\src\state\`, `C:\Dev\TermX\ui\src\terminal\` production files, or `C:\Dev\TermX\ui\src-tauri\`.
- A narrow update to `C:\Dev\TermX\ui\src\terminal\__tests__\App.integration.test.tsx` is permitted because it tests `App`, whose ownership model changes in T5. Do not alter terminal-specific assertions.
- Add no npm dependencies and do not change `C:\Dev\TermX\ui\package.json` or its lockfile.
- Persist only the exact `layout_v1` schema. Group headers use fixed slate presentation because `Group` has no color field; do not add a group-color menu or local persistence side channel.
- Use one App-owned WebSocket. Physically attach each live session once, sequentially awaiting every `HostClient.attach()` call.
- Keep drag state ephemeral. Mutate and persist only on a successful pointer release; Escape and `pointercancel` produce no write.
- Persist structural changes immediately and active-tab-only changes after a trailing 2-second debounce. Await `LayoutSaved`; retry a failed write exactly once and expose a non-blocking notice.
- Live close is pessimistic: close host sessions first, then prune successful panes/tabs and persist. Dead Dismiss calls `CloseSession` only when the exited host record still exists.
- Use the approved colors: app `#0f1115`, sidebar `#161a22`, hover/raised `#232a36`, text `#e6e6e6`, muted `#8b93a7`, accent `#7aa2f7`, and the eight `layout_v1` palette values.
- Use 120–150 ms spring-free CSS transitions, visible focus rings, an 8 px spacing grid, 6–8 px radii, and `prefers-reduced-motion` fallbacks.
- Never log, render, persist, or copy the host token outside the connection bootstrap call.

## File Map

### Create

- `C:\Dev\TermX\ui\src\workspace\AttachmentHub.ts` — sequential physical attachments, bounded replay, activity/unread, and virtual terminal attachments.
- `C:\Dev\TermX\ui\src\workspace\LayoutPersistence.ts` — serialized/coalesced layout writes, active-tab debounce, one retry, and notice state.
- `C:\Dev\TermX\ui\src\workspace\layoutOperations.ts` — pure missing operations: group reorder, group/tab removal, pane pruning, title/session helpers, and palette rotation.
- `C:\Dev\TermX\ui\src\workspace\WorkspaceController.ts` — canonical session/layout projection and every sidebar action.
- `C:\Dev\TermX\ui\src\workspace\bootstrapWorkspace.ts` — native bootstrap, host connect, GetState/parse/reconcile, and workspace construction.
- `C:\Dev\TermX\ui\src\workspace\useWorkspace.ts` — React `useSyncExternalStore` binding for controller snapshots.
- `C:\Dev\TermX\ui\src\workspace\__tests__\*.test.ts` — focused workspace unit tests.
- `C:\Dev\TermX\ui\src\sidebar\InlineRename.tsx` — inline editor with commit/cancel semantics.
- `C:\Dev\TermX\ui\src\sidebar\ContextMenu.tsx` — custom accessible menu, focus navigation, dismissal, and viewport clamping.
- `C:\Dev\TermX\ui\src\sidebar\pointerDrag.ts` — pure threshold and drop-command math.
- `C:\Dev\TermX\ui\src\sidebar\Sidebar.tsx` — presentational sidebar, menus, keyboard, confirmation, and pointer orchestration.
- `C:\Dev\TermX\ui\src\sidebar\Sidebar.css` — sidebar visuals and motion.
- `C:\Dev\TermX\ui\src\sidebar\__tests__\*.test.ts(x)` — component and pure-interaction tests.
- `C:\Dev\TermX\ui\src\__tests__\App.workspace.test.tsx` — App lifecycle integration.

### Modify

- `C:\Dev\TermX\ui\src\App.tsx` — own asynchronous workspace bootstrap and render sidebar plus active terminal.
- `C:\Dev\TermX\ui\src\styles.css` — header/sidebar/terminal shell layout and loading/error/empty states.
- `C:\Dev\TermX\ui\src\terminal\__tests__\App.integration.test.tsx` — replace the obsolete synchronous TerminalPane smoke assertion with the new App loading boundary; no terminal production edits.

---

### Task 1: Build the bounded sequential attachment hub

**Files:**
- Create: `C:\Dev\TermX\ui\src\workspace\AttachmentHub.ts`
- Test: `C:\Dev\TermX\ui\src\workspace\__tests__\AttachmentHub.test.ts`

**Interfaces:**

```ts
export const ATTACHMENT_REPLAY_CAP_BYTES = 8 * 1024 * 1024;
export const ATTACHMENT_REPLAY_MAX_CHUNKS = 512;
export const ACTIVITY_PULSE_MS = 1_200;

export interface HubSessionSnapshot {
  sessionId: number;
  hostAttached: boolean;
  terminalAttached: boolean;
  active: boolean;
  unread: boolean;
  exited: boolean;
  exitCode: number | null;
  lostScrollback: boolean;
  attachError: string | null;
}

export interface AttachmentHubSnapshot {
  sessions: Readonly<Record<number, HubSessionSnapshot>>;
}

export type AttachmentHostClient = Pick<
  HostClient,
  "attach" | "onError" | "onSessionClosed"
>;

export class AttachmentHub implements AttachmentClient {
  constructor(client: AttachmentHostClient);
  getSnapshot(): AttachmentHubSnapshot;
  subscribe(listener: () => void): () => void;
  attachAll(sessionIds: readonly number[], prioritySessionId?: number | null): Promise<void>;
  attachSession(sessionId: number): Promise<void>;
  markExited(sessionId: number, exitCode: number | null): void;
  forgetSession(sessionId: number): void;
  attach(
    sessionId: number,
    callbacks?: SessionAttachmentCallbacks,
    replay?: boolean,
  ): Promise<SessionAttachment>;
  onError(listener: (error: Error) => void): () => void;
  close(): void;
}
```

- [ ] **Step 1: Write RED tests for sequential attach and lifecycle.**

Use deferred physical-attach promises and assert the exact order `priority, remaining input order`:

```ts
const pending = new Map<number, ReturnType<typeof deferred<SessionAttachment>>>();
const client = fakeAttachmentClient((sessionId) => pending.get(sessionId)!.promise);
const hub = new AttachmentHub(client);
const result = hub.attachAll([7, 8, 9], 8);
expect(client.attachCalls).toEqual([8]);
pending.get(8)!.resolve(fakePhysicalAttachment(8));
await Promise.resolve();
expect(client.attachCalls).toEqual([8, 7]);
```

Cover physical failure continuation, duplicate IDs, `markExited`, host close, and idempotent `close()`.

- [ ] **Step 2: Run the RED lifecycle subset.**

Run from `C:\Dev\TermX\ui`:

```bash
npx vitest run src/workspace/__tests__/AttachmentHub.test.ts
```

Expected: FAIL because `AttachmentHub.ts` does not exist.

- [ ] **Step 3: Implement sequential physical attachment state.**

Use one internal record per session and this explicit ordering shape:

```ts
const ordered = prioritySessionId == null
  ? [...new Set(sessionIds)]
  : [prioritySessionId, ...sessionIds.filter((id) => id !== prioritySessionId)];
for (const sessionId of ordered) {
  await this.attachSession(sessionId);
}
```

Record attach errors per session and continue; never start the next physical attach before the prior promise settles.

- [ ] **Step 4: Write RED tests for replay bounds and virtual attachments.**

Cover: 8 MiB and 512-chunk eviction, oldest-complete-chunk removal, lost-scrollback state, one virtual subscriber maximum, replay delivery before resolution, forwarding `sendInput`/`resize`, virtual detach leaving the physical attachment alive, unread/activity behavior, and late exit replay.

- [ ] **Step 5: Implement the replay tail and virtual handle.**

Retain `{offset, data}` chunks. On virtual attach, deliver retained bytes with `source: "replay"`, then deliver a zero-byte virtual `source: "live"` event at the next offset. That boundary causes the unchanged `TerminalSessionBinding` to end replay suppression without writing content. Return a structural `SessionAttachment` whose `sendInput`/`resize` forward to the physical handle and whose `detach` only unregisters the virtual terminal subscriber.

- [ ] **Step 6: Run the Task 1 suite.**

```bash
npx vitest run src/workspace/__tests__/AttachmentHub.test.ts
```

Expected: all AttachmentHub tests PASS with no unhandled rejections or fake-timer leaks.

---

### Task 2: Add pure layout operations and serialized persistence

**Files:**
- Create: `C:\Dev\TermX\ui\src\workspace\layoutOperations.ts`
- Create: `C:\Dev\TermX\ui\src\workspace\LayoutPersistence.ts`
- Test: `C:\Dev\TermX\ui\src\workspace\__tests__\layoutOperations.test.ts`
- Test: `C:\Dev\TermX\ui\src\workspace\__tests__\LayoutPersistence.test.ts`

**Interfaces:**

```ts
export function firstSessionId(node: SplitNode): number;
export function sessionIdsInTab(tab: Tab): number[];
export function flattenTabIds(layout: LayoutV1): string[];
export function nextTabColor(layout: LayoutV1): PaletteId;
export function reorderGroup(layout: LayoutV1, groupId: string, targetIndex: number): LayoutV1;
export function pruneSessionIds(layout: LayoutV1, sessionIds: ReadonlySet<number>): LayoutV1;
export function removeGroupAndTabs(layout: LayoutV1, groupId: string): LayoutV1;

export const ACTIVE_TAB_PERSIST_DEBOUNCE_MS = 2_000;
export type LayoutChangeKind = "structural" | "active_tab";
export interface LayoutPersistenceSnapshot { saving: boolean; error: string | null }
export class LayoutPersistence {
  constructor(writer: Pick<HostClient, "setLayout">);
  getSnapshot(): LayoutPersistenceSnapshot;
  subscribe(listener: () => void): () => void;
  record(layout: LayoutV1, kind: LayoutChangeKind): void;
  flush(): Promise<void>;
  dispose(): void;
}
```

- [ ] **Step 1: Write RED pure-operation tests.**

Cover depth-first first session, rendered tab order, palette wraparound, clamped group reorder, invariant preservation, recursive pane pruning with split collapse, removal of empty tabs, and true group+tab removal rather than `LayoutStore.deleteGroup()` ungrouping.

- [ ] **Step 2: Run the RED pure suite.**

```bash
npx vitest run src/workspace/__tests__/layoutOperations.test.ts
```

Expected: FAIL on unresolved module.

- [ ] **Step 3: Implement immutable operations.**

Construct new arrays/records only. Validate complex results with a temporary `createLayoutStore(layout).replaceState(candidate)` and return the original layout by identity if the candidate is invalid or unchanged.

- [ ] **Step 4: Write RED persistence tests with fake timers and deferred writers.**

Prove: structural writes start immediately; active-only writes wait 2,000 ms; structural changes cancel an active timer; in-flight writes coalesce to the latest state; each failed state retries once; second failure exposes a notice; success clears a prior notice; `dispose()` cancels timers; and `flush()` drains both in-flight and queued state.

- [ ] **Step 5: Implement one serialized write pump.**

Store only `latestPendingLayout`, `inFlight`, `activeTimer`, and snapshot state. Serialize through `serializeLayout(layout)` at dispatch time. Never issue two `setLayout` requests concurrently.

- [ ] **Step 6: Run both Task 2 suites.**

```bash
npx vitest run src/workspace/__tests__/layoutOperations.test.ts src/workspace/__tests__/LayoutPersistence.test.ts
```

Expected: both files PASS; fake-timer count returns to zero after disposal.

---

### Task 3: Build workspace bootstrap and the controller

**Files:**
- Create: `C:\Dev\TermX\ui\src\workspace\bootstrapWorkspace.ts`
- Create: `C:\Dev\TermX\ui\src\workspace\WorkspaceController.ts`
- Test: `C:\Dev\TermX\ui\src\workspace\__tests__\bootstrapWorkspace.test.ts`
- Test: `C:\Dev\TermX\ui\src\workspace\__tests__\WorkspaceController.test.ts`

**Interfaces:**

```ts
export interface SidebarTabModel {
  id: string;
  groupId: string | null;
  title: string;
  color: PaletteId;
  primarySessionId: number;
  sessionIds: readonly number[];
  status: "live" | "dead" | "missing" | "attach_error";
  activity: "idle" | "active" | "unread";
  profile: string | null;
  cwd: string | null;
}

export interface SidebarGroupModel {
  id: string;
  name: string;
  collapsed: boolean;
  color: "slate";
  tabs: readonly SidebarTabModel[];
}

export interface WorkspaceSnapshot {
  layout: LayoutV1;
  ungroupedTabs: readonly SidebarTabModel[];
  groups: readonly SidebarGroupModel[];
  activeTabId: string | null;
  activeSessionId: number | null;
  persistence: LayoutPersistenceSnapshot;
  notice: string | null;
}

export interface BootstrappedWorkspace {
  client: HostClient;
  controller: WorkspaceController;
}

export function parseBootstrapHostResult(value: unknown): HostClientConnectOptions;
export async function bootstrapWorkspace(
  dependencies?: BootstrapWorkspaceDependencies,
): Promise<BootstrappedWorkspace>;
```

- [ ] **Step 1: Write RED bootstrap tests.**

Assert this exact sequence: native `bootstrap_host`, `HostClient.connect`, `getState`, `parseLayout`, `reconcile`, construct store/persistence/hub/controller, then `attachAll(liveIds, activeSessionId)`. Malformed layout must create a reachable flat fallback but must not immediately call `setLayout`. A valid layout with an orphan live session adopts it and records one structural write. Any post-connect failure closes the client; errors do not include the token.

- [ ] **Step 2: Implement bootstrap validation and construction.**

Validate `{port, token}` from `unknown` with integer range `1..65535` and non-empty token. Pass the token directly to `HostClient.connect`; do not store it on the returned workspace/controller.

- [ ] **Step 3: Write RED controller projection tests.**

Cover derived title `profile · cwd-tail`, profile-only fallback, fixed `color: "slate"` group projection with no layout field, live/dead/missing/attach-error status, active/unread activity, and first-depth-pane active session selection.

- [ ] **Step 4: Implement the controller snapshot boundary.**

Subscribe once to layout store, hub, and persistence. Recompute one immutable snapshot and notify React subscribers only when an owned dependency changes. Keep the host-session index out of `layout_v1`.

- [ ] **Step 5: Write RED mutation/action tests.**

Cover activate (active-tab persistence), rename/recolor/collapse/move/group reorder/group creation (structural persistence), folder-picker cancellation, palette rotation, creation in a target group, duplicate/open-folder source profile+cwd, sequential close of every pane, partial close retention, close-group removal, dead-host Dismiss calling `closeSession`, and missing-host Dismiss pruning without a host call.

- [ ] **Step 6: Implement controller actions.**

Use `crypto.randomUUID()` for caller-supplied group/tab IDs. Register newly created sessions in the host-session index and attach hub before making their tab active. For live close, await each `closeSession`; prune only successful IDs, persist the resulting layout once, retain failed panes, and set a bounded notice.

- [ ] **Step 7: Run Task 3 suites.**

```bash
npx vitest run src/workspace/__tests__/bootstrapWorkspace.test.ts src/workspace/__tests__/WorkspaceController.test.ts
```

Expected: both files PASS; no token appears in snapshots, errors, or logged test output.

---

### Task 4: Build inline rename and context-menu primitives

**Files:**
- Create: `C:\Dev\TermX\ui\src\sidebar\InlineRename.tsx`
- Create: `C:\Dev\TermX\ui\src\sidebar\ContextMenu.tsx`
- Test: `C:\Dev\TermX\ui\src\sidebar\__tests__\InlineRename.test.tsx`
- Test: `C:\Dev\TermX\ui\src\sidebar\__tests__\ContextMenu.test.tsx`

**Interfaces:**

```ts
export interface InlineRenameProps {
  value: string;
  ariaLabel: string;
  onCommit(value: string): void;
  onCancel(): void;
}

export interface MenuPoint { x: number; y: number }
export function clampMenuPoint(
  point: MenuPoint,
  menuSize: { width: number; height: number },
  viewport: { width: number; height: number },
  padding?: number,
): MenuPoint;

export interface ContextMenuProps {
  label: string;
  point: MenuPoint;
  onClose(): void;
  children: ReactNode;
}
```

- [ ] **Step 1: Write RED rename tests.**

Assert select-all on focus, Enter and blur committing a trimmed 1–64-character value exactly once, Escape canceling without a later blur commit, empty/whitespace reverting, and `maxLength={64}`.

- [ ] **Step 2: Implement `InlineRename`.**

Use a ref-backed settled flag so Enter/Escape followed by blur cannot double-dispatch. Stop propagation for editor keys so sidebar shortcuts do not fire.

- [ ] **Step 3: Write RED menu tests.**

Assert `role="menu"`, first-enabled-item focus, Arrow Up/Down focus movement, Enter/Space activation through native buttons, Escape close, outside-pointer close, inside-pointer retention, focus restoration, and eight-pixel viewport clamping.

- [ ] **Step 4: Implement `ContextMenu`.**

Render in the existing React tree with fixed positioning. Measure in a layout effect and clamp against `window.innerWidth/innerHeight`; no portal or dependency is required.

- [ ] **Step 5: Run Task 4 suites.**

```bash
npx vitest run src/sidebar/__tests__/InlineRename.test.tsx src/sidebar/__tests__/ContextMenu.test.tsx
```

Expected: both files PASS with no React act warnings.

---

### Task 5: Render structure, state, rename, and keyboard navigation

**Files:**
- Create: `C:\Dev\TermX\ui\src\sidebar\Sidebar.tsx`
- Create: `C:\Dev\TermX\ui\src\sidebar\Sidebar.css`
- Test: `C:\Dev\TermX\ui\src\sidebar\__tests__\Sidebar.test.tsx`

**Interfaces:**

```ts
export interface SidebarActions {
  activateTab(tabId: string): void;
  renameTab(tabId: string, title: string | null): void;
  recolorTab(tabId: string, color: PaletteId): void;
  moveTab(tabId: string, groupId: string | null, index: number): void;
  reorderGroup(groupId: string, targetIndex: number): void;
  createGroup(name: string): void;
  renameGroup(groupId: string, name: string): void;
  toggleGroup(groupId: string): void;
  createTab(options: { groupId: string | null; profile: string | null }): Promise<void>;
  duplicateTab(tabId: string): Promise<void>;
  openFolderHere(tabId: string): Promise<void>;
  closeLiveTab(tabId: string): Promise<void>;
  closeGroup(groupId: string): Promise<void>;
  dismissDeadTab(tabId: string): Promise<void>;
}

export interface SidebarProps {
  snapshot: WorkspaceSnapshot;
  actions: SidebarActions;
}
```

- [ ] **Step 1: Write RED structure/state tests.**

Assert ungrouped-first order, ordered groups, collapsed tabs absent from DOM, slate group marker, palette tab dots, active `aria-selected`, raised/left-edge classes, close-on-hover/focus affordance, active/unread activity distinctions, dimmed dead/missing rows, and `Exited` badge.

- [ ] **Step 2: Implement the presentational tree and visual state.**

Use semantic buttons for rows/actions and stable `data-*` attributes for later DnD. Keep menu/rename/confirmation/drag state local; do not copy layout state into component state.

- [ ] **Step 3: Write RED rename and keyboard tests.**

Cover double-click rename, group rename, Up/Down through visible tabs without wrapping, Enter activate, F2 rename, Delete opening live close confirmation, Delete directly dismissing a dead tab, Escape cancellation, and ignoring shortcuts from inputs/menu controls.

- [ ] **Step 4: Implement keyboard and local editor state.**

Keep a focused tab ID rather than a numeric index so reorder/collapse cannot strand focus. Restore focus to the originating row/header after editor close.

- [ ] **Step 5: Add baseline sidebar CSS.**

Implement the binding tokens, 8 px rhythm, fixed 252 px sidebar width with narrow fallback, 6–8 px radii, 120–150 ms transitions, `:focus-visible` ring, hover/active states, chevron rotation, and reduced-motion override.

- [ ] **Step 6: Run Task 5 suite.**

```bash
npx vitest run src/sidebar/__tests__/Sidebar.test.tsx
```

Expected: all structure, visual-state, rename, and keyboard tests PASS.

---

### Task 6: Add pure pointer drag-and-drop

**Files:**
- Create: `C:\Dev\TermX\ui\src\sidebar\pointerDrag.ts`
- Test: `C:\Dev\TermX\ui\src\sidebar\__tests__\pointerDrag.test.ts`
- Modify: `C:\Dev\TermX\ui\src\sidebar\Sidebar.tsx`
- Modify: `C:\Dev\TermX\ui\src\sidebar\Sidebar.css`

**Interfaces:**

```ts
export const POINTER_DRAG_THRESHOLD_PX = 4;
export type DragSource =
  | { kind: "tab"; tabId: string; groupId: string | null; index: number }
  | { kind: "group"; groupId: string; index: number };
export type DropTarget =
  | { kind: "tab"; groupId: string | null; index: number }
  | { kind: "group"; index: number };
export type SidebarDropCommand =
  | { kind: "move_tab"; tabId: string; groupId: string | null; index: number }
  | { kind: "reorder_group"; groupId: string; index: number };
export function crossedDragThreshold(origin: MenuPoint, current: MenuPoint): boolean;
export function commitDrop(source: DragSource, target: DropTarget): SidebarDropCommand | null;
```

- [ ] **Step 1: Write exhaustive RED pure tests.**

Cover below/exact/above 4 px Euclidean threshold; same-container post-removal index; cross-group/root moves; group reorder; source/target kind mismatch; clamped edge positions; and no-op drops.

- [ ] **Step 2: Implement pure drag math.**

Return commands only; never mutate layout. For same-container moves, interpret the target index after source removal to match `LayoutStore.moveTab()`.

- [ ] **Step 3: Write RED DOM drag tests.**

Assert primary-pointer-only start, control/input exclusion, pointer capture, no action below threshold, floating ghost during drag, 2 px insertion indicator, exactly one action on drop, no action on unchanged drop, and no action after Escape or `pointercancel`.

- [ ] **Step 4: Integrate pointer orchestration into `Sidebar`.**

Use fixed-position ghost translation and `data-drop-*` targets. During pointer move update local drag state only. On pointer up convert state to one controller action, then clear state.

- [ ] **Step 5: Add drag CSS.**

Use `transform` and opacity only for the ghost; add shadow, approximately 0.9 opacity, and 2 px accent insertion line. Disable transitions under reduced motion.

- [ ] **Step 6: Run drag and sidebar suites.**

```bash
npx vitest run src/sidebar/__tests__/pointerDrag.test.ts src/sidebar/__tests__/Sidebar.test.tsx
```

Expected: both files PASS and persistence spies remain untouched during pointer movement/cancel.

---

### Task 7: Complete context menus, creation, close, and Dismiss

**Files:**
- Modify: `C:\Dev\TermX\ui\src\sidebar\Sidebar.tsx`
- Modify: `C:\Dev\TermX\ui\src\sidebar\Sidebar.css`
- Test: `C:\Dev\TermX\ui\src\sidebar\__tests__\Sidebar.test.tsx`
- Test: `C:\Dev\TermX\ui\src\workspace\__tests__\WorkspaceController.test.ts`

**Exact menus:**

- Tab: Rename, Duplicate tab, Open folder here, Color submenu with eight palette swatches, Move to group submenu, and Close or Dismiss according to status.
- Group: Rename, New tab in group, Collapse/Expand, Close group. No group-color item.
- Sidebar background: New tab, New group.
- Bottom creation split control: primary default-profile folder-picker flow plus Default, Windows PowerShell, and Command Prompt options (`null`, `"powershell"`, `"cmd"`).

- [ ] **Step 1: Write RED context-menu tests.**

Assert native menu suppression, exact action dispatch, dead/live Close-versus-Dismiss exclusivity, eight `PALETTE_HEX` swatches, move-target filtering, group menu without Color, outside/Escape dismissal, viewport clamping, and focus restoration.

- [ ] **Step 2: Implement tab/group/background menus.**

Use `ContextMenu` with semantic menuitem buttons. Submenus may be adjacent in-tree panels but must retain keyboard focus and remain viewport-clamped.

- [ ] **Step 3: Write RED creation and confirmation tests.**

Assert exact profile values, folder-picker cancellation no-op, inline new-group editor, live tab confirmation, live group confirmation, pending/busy state, cancel path, dead Dismiss without live confirmation, and error notice retention.

- [ ] **Step 4: Implement creation controls and inline confirmation.**

Never call `window.confirm`. Disable duplicate submissions while the action promise is pending. Keep the affected title and action label visible in the local confirmation panel.

- [ ] **Step 5: Run all sidebar/workspace tests.**

```bash
npx vitest run src/sidebar src/workspace
```

Expected: all files PASS with no unhandled promise rejections, timer leaks, or `act()` warnings.

---

### Task 8: Integrate the App-owned workspace

**Files:**
- Create: `C:\Dev\TermX\ui\src\workspace\useWorkspace.ts`
- Create: `C:\Dev\TermX\ui\src\__tests__\App.workspace.test.tsx`
- Modify: `C:\Dev\TermX\ui\src\App.tsx`
- Modify: `C:\Dev\TermX\ui\src\styles.css`
- Modify: `C:\Dev\TermX\ui\src\terminal\__tests__\App.integration.test.tsx` (test-only exception)

**App state:**

```ts
type AppState =
  | { type: "loading" }
  | { type: "ready"; workspace: BootstrappedWorkspace }
  | { type: "error"; message: string };
```

- [ ] **Step 1: Write RED App lifecycle tests.**

Cover loading-before-bootstrap, ready sidebar/terminal composition, active session switching, empty layout, dead active placeholder, bounded bootstrap failure, no token leakage, canceled late bootstrap cleanup, and unmount order `controller.dispose()` before `client.close()`.

- [ ] **Step 2: Implement `useWorkspace`.**

Use `useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)` with bound/stable callbacks; do not create a React-owned copy of the layout.

- [ ] **Step 3: Replace self-bootstrapping App ownership.**

Call `bootstrapWorkspace()` once per effect generation. Render no self-owned `TerminalPane` during loading. In ready state pass `controller.attachments` and `activeSessionId` to `TerminalPane`, keyed by session ID. Never call `HostClient.shutdown()`.

- [ ] **Step 4: Update the shell CSS.**

Lay out header over sidebar+terminal; keep terminal min-width/min-height zero; add intentional loading/error/empty/dead panels; preserve 1280×800 usability and avoid sidebar overlay.

- [ ] **Step 5: Update the stale App integration test only.**

Change `C:\Dev\TermX\ui\src\terminal\__tests__\App.integration.test.tsx` to assert the App loading boundary before bootstrap resolves. Keep all `TerminalPane` behavior tests unchanged in their existing files.

- [ ] **Step 6: Run App, type, and production-build gates.**

```bash
npx vitest run src/__tests__/App.workspace.test.tsx src/terminal/__tests__/App.integration.test.tsx
npx tsc --noEmit
npm run build
```

Expected: both test files PASS; TypeScript exits 0; Vite production build exits 0.

---

### Task 9: Full verification and real-app quality gate

**Files:**
- Modify only files already owned above if verification finds a T5 defect.

- [ ] **Step 1: Run focused T5 verification.**

```bash
npx vitest run src/workspace src/sidebar src/__tests__/App.workspace.test.tsx
npx tsc --noEmit
npm run build
```

Expected: all focused tests PASS, TypeScript exits 0, build exits 0.

- [ ] **Step 2: Run full renderer and real-host regression gates.**

```bash
npm test
npm run test:e2e
```

Expected: all renderer tests PASS and the real-host reattach E2E passes all cases, including dead-session CloseSession cleanup.

- [ ] **Step 3: Run diff hygiene.**

From `C:\Dev\TermX`:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; no dependency, host, state, terminal-production, Tauri, or unrelated files changed.

- [ ] **Step 4: Run the real app.**

From `C:\Dev\TermX\ui`:

```bash
npm run tauri dev
```

Inspect the real Tauri window at 1280×800. Do not use headless browser automation.

- [ ] **Step 5: Complete the manual acceptance matrix.**

Verify: populated and empty states; restored order; one host connection; complete initial replay; smooth tab switching with no duplicate input; inactive activity/unread; exited badge; dead Dismiss; live tab/group inline confirmation; fixed slate groups; eight tab colors; double-click/Enter/blur/Escape rename; Up/Down/Enter/F2/Delete/Escape keyboard flow; viewport-safe menus; same-group/cross-group/root/group DnD; sub-4 px click protection; Escape drag cancellation; exactly one SetLayout on drop; structural restore; 2-second active persistence; one retry/toast; reduced motion; smooth terminal streaming during drag; and closing the UI without host shutdown.

- [ ] **Step 6: Update the living handoff with exact evidence.**

Append changed absolute paths, test counts/commands, manual observations, known warnings, and remaining T7/T8 handoff constraints to `C:\Dev\TermX\specs\handoffs\001-2026-07-17-termx-m1-host-core.md`. Keep `C:\Dev\TermX\specs\handoffs\INDEX.md` newest-first and do not create a second handoff.

## Self-Review Result

- Spec coverage: structure, creation, rename, pointer DnD, custom menus, dead sessions, keyboard operation, persistence timing/retry, visual tokens, and App integration each map to an executable task.
- Schema consistency: group color remains presentation-only; no `layout_v1` field is invented. Tab color uses `PaletteId` and `PALETTE_HEX` from the existing state module.
- Boundary consistency: production files under host/state/terminal/Tauri remain unchanged. The sole forbidden-tree exception is the App-owned stale integration test.
- Attachment feasibility: the virtual zero-byte live event is internal to `AttachmentHub`; it is not sent over the host protocol and writes no terminal bytes.
- Scope: T7 split rendering remains deferred. T5 deterministically uses the first depth-first pane as a tab’s active source until T7 introduces focused-pane state out of band.
- Placeholder scan: no incomplete or deferred implementation markers remain.
