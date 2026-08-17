import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import {
  ConversationsRail,
  type ConversationsRailProps,
} from "../conversations/ConversationsRail";
import type { ConversationsStore } from "../conversations/store";
import type { LlmSessionRecord } from "../conversations/types";
import type { SavedSession } from "../saved/types";
import { DEFAULT_SETTINGS, type TermxSettings } from "../settings/settings";
import {
  canMoveItem,
  PALETTE_IDS,
  type FillStrength,
  type Item,
  type PaletteId,
} from "../state/layout";
import { useThemeId } from "../theme/ThemeProvider";
import { resolveTabColor, themeById } from "../theme/themes";
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH } from "../workspace/uiState";
import type {
  SidebarGroupModel,
  SidebarItemModel,
  SidebarTabModel,
  WorkspaceSnapshot,
} from "../workspace/WorkspaceController";
import { ContextMenu, type MenuPoint } from "./ContextMenu";
import { InlineRename } from "./InlineRename";
import {
  commitDrop,
  crossedDragThreshold,
  type DragSource,
  type DropTarget,
} from "./pointerDrag";
import "./Sidebar.css";

export interface SidebarActions {
  activateTab(tabId: string): void;
  renameTab(tabId: string, title: string | null): void;
  recolorTab(tabId: string, color: PaletteId): void;
  /** How strongly the tab's colour washes its row: off | subtle | strong. */
  setTabFill(tabId: string, fill: FillStrength): void;
  /** `null` returns the group to the neutral look. */
  recolorGroup(groupId: string, color: PaletteId | null): void;
  /** Tabs and subgroups alike (layout_v2); false = the move was refused. */
  moveItem(item: Item, targetGroupId: string | null, index: number): boolean;
  /** `parentGroupId` null = a root group; null back = the depth cap refused it. */
  createGroup(parentGroupId: string | null, name?: string): string | null;
  renameGroup(groupId: string, name: string): void;
  toggleGroup(groupId: string): void;
  createTab(options: { groupId: string | null; profile: string | null }): Promise<void>;
  /** Spec §16: graft `sourceTabId`'s panes into `targetTabId` side-by-side. */
  mergeTabs(sourceTabId: string, targetTabId: string): void;
  duplicateTab(tabId: string): Promise<void>;
  openFolderHere(tabId: string): Promise<void>;
  closeLiveTab(tabId: string): Promise<void>;
  /** Keep-children lifts the group's items into its own container. */
  deleteGroup(groupId: string, mode: "keep-children" | "close-tabs"): Promise<void>;
  dismissDeadTab(tabId: string): Promise<void>;
}

/**
 * Conversations mode (spec §3). Omitted — or disabled in settings — means the
 * sidebar is Terminals-only and renders exactly as it always has: no mode
 * switch, no rail, nothing mounted.
 */
export interface SidebarConversations {
  store: ConversationsStore;
  settings: TermxSettings;
  onResume(record: LlmSessionRecord): void;
  onOpenTranscript(record: LlmSessionRecord): void;
  /** Detail-pane artifacts IO (§11), forwarded verbatim to the rail. */
  listArtifacts?: ConversationsRailProps["listArtifacts"];
  onOpenFile?(path: string): void;
  onOpenFolder?(parentDir: string): void;
  /** NoteScheduler visibility feed (§6), forwarded verbatim to the rail. */
  onVisibleRecords?: ConversationsRailProps["onVisibleRecords"];
  /** Detail-pane outputs IO (polish P4), forwarded verbatim to the rail. */
  listOutputs?: ConversationsRailProps["listOutputs"];
  dismissOutput?: ConversationsRailProps["dismissOutput"];
}

/**
 * Saved sessions (saved-sessions spec §"Resume flow"): the pinned folder +
 * conversation pairs, listed above the terminal groups. `enabled` carries
 * `settings.savedSidebarList`, so the section is gated one prop away from the
 * render — an App that persists saves but has the list switched off passes the
 * entries and simply gets no section.
 */
export interface SidebarSaved {
  enabled: boolean;
  entries: readonly SavedSession[];
  /** Row click: reattach if the daemon still runs it, else restore it. */
  onResume(entry: SavedSession): void;
  /** Inline rename. Description edits belong to the save dialog. */
  onRename(id: string, name: string): void;
  onDelete(id: string): void;
}

export interface SidebarProps {
  snapshot: WorkspaceSnapshot;
  actions: SidebarActions;
  /** UI chrome, not a workspace action: opens the app settings dialog. */
  onOpenSettings?: () => void;
  /** Opens the folder-search palette targeting the given group. */
  onOpenFolderSearch?: (groupId: string | null) => void;
  /**
   * `settings.maxGroupDepth` (nesting spec §3) — it gates creation and
   * movement only, never rendering, so an unwired caller just gets the
   * default.
   */
  maxGroupDepth?: number;
  conversations?: SidebarConversations;
  /**
   * Saved sessions section (saved-sessions spec). Omitted — or disabled in
   * settings — leaves the sidebar exactly as it was.
   */
  saved?: SidebarSaved;
  /**
   * Persisted sidebar width in px (polish P5), already clamped by
   * `uiState.setSidebarWidth`. Absent = the stylesheet's own width, so a
   * caller that does not persist a width gets the sidebar exactly as it was.
   */
  width?: number;
  /**
   * Reports a new width from the right-edge drag handle; `null` is the
   * double-click reset sentinel (back to `DEFAULT_SIDEBAR_WIDTH`). Absent
   * hides the handle — an unpersisted width is not resizable.
   */
  onResize?(width: number | null): void;
  /**
   * Opens the full-screen Conversations surface (polish P5). The ⛶ control
   * renders only when this is wired AND the rail is on screen — the App owns
   * the surface, the sidebar only asks for it.
   */
  onExpandConversations?(): void;
  /** Sessions currently asleep (spec §13) — tabs holding one show a zZ badge. */
  sleeping?: ReadonlySet<number>;
  /**
   * False while the host connection is down. Creating a terminal needs a live
   * socket, and a request issued without one fails fast by design — better to
   * say "not yet" on the button than to hand the user an error. Defaults to
   * true so callers that do not track a connection are unaffected.
   */
  hostConnected?: boolean;
  /**
   * Action tray for the footer (spec §14). When provided it REPLACES the
   * hardcoded folder-search/settings chrome buttons; the New-terminal button
   * and its options menu stay native (they carry busy state a chip cannot).
   */
  footerTray?: ReactNode;
}

/** Tooltip on the creation controls while the host connection is down. */
const WAITING_FOR_HOST = "Waiting for host…";

type SidebarMode = "terminals" | "conversations";

type RenameTarget =
  | { kind: "tab"; id: string }
  | { kind: "group"; id: string };

type ConfirmClose =
  | { kind: "tab"; id: string; title: string }
  | { kind: "group"; id: string; title: string }
  | { kind: "saved"; id: string; title: string };

type SidebarMenu =
  | { kind: "tab"; id: string; point: MenuPoint }
  | { kind: "group"; id: string; point: MenuPoint }
  | { kind: "background"; point: MenuPoint }
  | { kind: "create"; point: MenuPoint };

type MenuPanel = "root" | "color" | "move";

/** Right-edge width drag (polish P5) — same pointer-capture shape as the
 *  SplitLayout divider, but reporting px instead of a fraction. */
interface ResizeDragState {
  pointerId: number;
  startX: number;
  startWidth: number;
}

/** Arrow-key step for the resize handle, matching the divider's nudge idiom. */
const SIDEBAR_RESIZE_STEP = 16;

/** How hard the tab colour washes its row (theme spec §5). */
const FILL_OPTIONS: ReadonlyArray<{ value: FillStrength; label: string }> = [
  { value: "off", label: "Off" },
  { value: "subtle", label: "Subtle" },
  { value: "strong", label: "Strong" },
];

interface PointerDragState {
  pointerId: number;
  source: DragSource;
  origin: { x: number; y: number };
  current: { x: number; y: number };
  active: boolean;
  target: DropTarget | null;
  label: string;
  indicator: { left: number; top: number; width: number } | null;
  /**
   * Containers this item may land in, resolved once at drag start (nesting
   * spec §5): an illegal drop never renders a target in the first place.
   */
  eligible: ReadonlySet<string | null>;
}

export function Sidebar({
  snapshot,
  actions,
  onOpenSettings,
  onOpenFolderSearch,
  maxGroupDepth = DEFAULT_SETTINGS.maxGroupDepth,
  conversations,
  saved,
  width,
  onResize,
  onExpandConversations,
  sleeping,
  footerTray,
  hostConnected = true,
}: SidebarProps) {
  const theme = themeById(useThemeId());
  const [mode, setMode] = useState<SidebarMode>("terminals");
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  /// Id of the saved row whose name is being edited inline, if any.
  const [savedRenameId, setSavedRenameId] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState<ConfirmClose | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [dismissingTabIds, setDismissingTabIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /// Non-null while the inline name editor is open; it carries the parent the
  /// new group belongs to (null = a root group).
  const [creatingGroup, setCreatingGroup] = useState<
    { parentGroupId: string | null } | null
  >(null);
  const [menu, setMenu] = useState<SidebarMenu | null>(null);
  const [menuPanel, setMenuPanel] = useState<MenuPanel>("root");
  const [focusedTabId, setFocusedTabId] = useState<string | null>(snapshot.activeTabId);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const groupRefs = useRef(new Map<string, HTMLElement>());
  const restoreFocusRef = useRef<RenameTarget | null>(null);
  const dragRef = useRef<PointerDragState | null>(null);
  const [drag, setDrag] = useState<PointerDragState | null>(null);
  const suppressClickRef = useRef(false);
  const dismissingTabIdsRef = useRef(new Set<string>());
  const dialogOpenerRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const dialogCancelRef = useRef<HTMLButtonElement | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  const resizeRef = useRef<ResizeDragState | null>(null);

  /// Rendered top-to-bottom order of the rows a user can actually reach:
  /// a collapsed group hides its whole subtree, not just its own tabs.
  const visibleTabs = useMemo(() => {
    const out: SidebarTabModel[] = [];
    const walk = (items: readonly SidebarItemModel[]): void => {
      for (const item of items) {
        if (item.kind === "tab") {
          out.push(item.tab);
        } else if (!item.group.collapsed) {
          walk(item.group.items);
        }
      }
    };
    walk(snapshot.rootItems);
    return out;
  }, [snapshot.rootItems]);
  const visibleTabIds = useMemo(() => visibleTabs.map((tab) => tab.id), [visibleTabs]);

  /// Saved rows, most recently touched first — a resume or a re-save is what
  /// the user is working on, so it rises. Names break ties so the order is
  /// stable across renders of a freshly imported list.
  const savedRows = useMemo(() => {
    const entries = saved?.entries ?? [];
    return [...entries].sort((left, right) =>
      right.updatedAtMs - left.updatedAtMs || left.name.localeCompare(right.name)
    );
  }, [saved?.entries]);

  useLayoutEffect(() => {
    if (focusedTabId && visibleTabIds.includes(focusedTabId)) {
      return;
    }
    const nextFocusedId = snapshot.activeTabId && visibleTabIds.includes(snapshot.activeTabId)
      ? snapshot.activeTabId
      : (visibleTabIds[0] ?? null);
    const activeElement = document.activeElement;
    const shouldRestoreDomFocus = focusedTabId !== null && (
      activeElement === null ||
      activeElement === document.body ||
      !activeElement.isConnected
    );
    if (nextFocusedId !== focusedTabId) {
      setFocusedTabId(nextFocusedId);
    }
    if (shouldRestoreDomFocus && nextFocusedId) {
      tabRefs.current.get(nextFocusedId)?.focus();
    }
  }, [focusedTabId, snapshot.activeTabId, visibleTabIds]);

  useLayoutEffect(() => {
    if (confirmClose) {
      if (busy) {
        dialogRef.current?.focus();
      } else {
        dialogCancelRef.current?.focus();
      }
    } else if (dialogOpenerRef.current?.isConnected) {
      dialogOpenerRef.current.focus();
      dialogOpenerRef.current = null;
    }
  }, [busy, confirmClose]);

  useLayoutEffect(() => {
    const target = restoreFocusRef.current;
    if (!target || renameTarget) {
      return;
    }
    restoreFocusRef.current = null;
    if (target.kind === "tab") {
      tabRefs.current.get(target.id)?.focus();
    } else {
      groupRefs.current.get(target.id)?.focus();
    }
  });

  const installDrag = (next: PointerDragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const cancelDrag = () => {
    const current = dragRef.current;
    if (current) {
      releaseDragCapture(current, tabRefs.current, groupRefs.current);
    }
    installDrag(null);
  };

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && dragRef.current) {
        event.preventDefault();
        cancelDrag();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, []);

  /// Every container `item` is allowed into, the root included — the depth
  /// setting and the no-cycle rule both live in `canMoveItem`.
  const eligibleContainers = (item: Item): ReadonlySet<string | null> => {
    const out = new Set<string | null>();
    if (canMoveItem(snapshot.layout, item, null, maxGroupDepth)) {
      out.add(null);
    }
    for (const group of snapshot.groups) {
      if (canMoveItem(snapshot.layout, item, group.id, maxGroupDepth)) {
        out.add(group.id);
      }
    }
    return out;
  };

  const startDrag = (
    event: ReactPointerEvent<HTMLElement>,
    source: DragSource,
    label: string,
  ) => {
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      (event.target instanceof HTMLElement &&
        event.target.closest("button, input, [role='menuitem']"))
    ) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    installDrag({
      pointerId: event.pointerId,
      source,
      origin: { x: event.clientX, y: event.clientY },
      current: { x: event.clientX, y: event.clientY },
      active: false,
      target: null,
      label,
      indicator: null,
      eligible: eligibleContainers(source.item),
    });
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) {
      return;
    }
    const point = { x: event.clientX, y: event.clientY };
    const active = current.active || crossedDragThreshold(current.origin, point);
    if (!active) {
      if (point.x !== current.current.x || point.y !== current.current.y) {
        installDrag({ ...current, current: point });
      }
      return;
    }
    const resolved = resolveDropTarget(point, current.eligible);
    installDrag({
      ...current,
      current: point,
      active: true,
      target: resolved?.target ?? null,
      indicator: resolved?.indicator ?? null,
    });
  };

  const finishDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) {
      return;
    }
    releaseDragCapture(current, tabRefs.current, groupRefs.current);
    const command = current.active && current.target
      ? commitDrop(current.source, current.target)
      : null;
    suppressClickRef.current = current.active;
    installDrag(null);
    if (command) {
      actions.moveItem(command.item, command.groupId, command.index);
    }
  };

  /**
   * The width a drag starts from: the persisted value when there is one, else
   * the rendered width, else the default (a layout that has not been measured
   * — jsdom, or a display:none sidebar — reports 0 and must not collapse the
   * handle to the minimum on the first pointer move).
   */
  const currentWidth = (): number => {
    if (width !== undefined) {
      return width;
    }
    const measured = asideRef.current?.getBoundingClientRect().width ?? 0;
    return measured > 0 ? measured : DEFAULT_SIDEBAR_WIDTH;
  };

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onResize || event.button !== 0 || !event.isPrimary) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Environments without pointer capture still get move/up on the element.
    }
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: currentWidth(),
    };
  };

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = resizeRef.current;
    if (!current || current.pointerId !== event.pointerId) {
      return;
    }
    event.stopPropagation();
    // Reported live (the ui-state store debounces its own disk writes), so the
    // sidebar tracks the pointer instead of jumping on release.
    onResize?.(clampSidebarWidth(current.startWidth + (event.clientX - current.startX)));
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = resizeRef.current;
    if (!current || current.pointerId !== event.pointerId) {
      return;
    }
    event.stopPropagation();
    resizeRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Capture may already be gone.
    }
  };

  const finishRename = (target: RenameTarget) => {
    restoreFocusRef.current = target;
    setRenameTarget(null);
  };

  const beginTabRename = (tab: SidebarTabModel) => {
    setRenameTarget({ kind: "tab", id: tab.id });
  };

  const openConfirmation = (next: ConfirmClose, opener?: HTMLElement | null) => {
    dialogOpenerRef.current = opener ?? (
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    );
    setConfirmClose(next);
  };

  const closeConfirmation = () => {
    setConfirmClose(null);
  };

  /// Every confirmation button runs the same way: the dialog stays up, busy,
  /// until the workspace call settles.
  const runConfirmation = async (run: () => Promise<void>) => {
    setBusy(true);
    try {
      await run();
      closeConfirmation();
    } finally {
      setBusy(false);
    }
  };

  const openMenu = (next: SidebarMenu) => {
    setMenuPanel("root");
    setMenu(next);
  };

  const closeMenu = () => {
    setMenu(null);
    setMenuPanel("root");
  };

  const createTab = async (groupId: string | null, profile: string | null) => {
    if (creating) {
      return;
    }
    setCreating(true);
    try {
      await actions.createTab({ groupId, profile });
    } finally {
      setCreating(false);
    }
  };

  const dismissDeadTab = async (tabId: string) => {
    if (dismissingTabIdsRef.current.has(tabId)) {
      return;
    }
    dismissingTabIdsRef.current.add(tabId);
    setDismissingTabIds(new Set(dismissingTabIdsRef.current));
    try {
      await actions.dismissDeadTab(tabId);
    } finally {
      dismissingTabIdsRef.current.delete(tabId);
      setDismissingTabIds(new Set(dismissingTabIdsRef.current));
    }
  };

  const requestTabClose = (tab: SidebarTabModel, opener?: HTMLElement | null) => {
    if (tab.status === "live" || tab.status === "attach_error") {
      openConfirmation({ kind: "tab", id: tab.id, title: tab.title }, opener);
    } else {
      void dismissDeadTab(tab.id);
    }
  };

  const handleTabKey = (event: KeyboardEvent<HTMLDivElement>, tab: SidebarTabModel) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    const index = visibleTabIds.indexOf(tab.id);
    if (event.key === "ArrowDown" && index >= 0 && index < visibleTabIds.length - 1) {
      event.preventDefault();
      const nextId = visibleTabIds[index + 1]!;
      setFocusedTabId(nextId);
      tabRefs.current.get(nextId)?.focus();
    } else if (event.key === "ArrowUp" && index > 0) {
      event.preventDefault();
      const previousId = visibleTabIds[index - 1]!;
      setFocusedTabId(previousId);
      tabRefs.current.get(previousId)?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      actions.activateTab(tab.id);
    } else if (event.key === "F2") {
      event.preventDefault();
      beginTabRename(tab);
    } else if (event.key === "Delete") {
      event.preventDefault();
      requestTabClose(tab);
    }
  };

  /// `index` is the row's position among its container's ITEMS (tabs and
  /// subgroups alike) — the index every move/drop command speaks in — and
  /// `depth` is its nesting level, 1 at the root.
  const renderTab = (tab: SidebarTabModel, index: number, depth: number) => {
    const active = tab.id === snapshot.activeTabId;
    const ended = tab.status === "dead" || tab.status === "missing";
    const renaming = renameTarget?.kind === "tab" && renameTarget.id === tab.id;
    return (
      <div
        key={tab.id}
        aria-level={depth}
        ref={(node) => {
          if (node) tabRefs.current.set(tab.id, node);
          else tabRefs.current.delete(tab.id);
        }}
        className={[
          "sidebar-tab",
          active ? "sidebar-tab--active" : "",
          ended ? "sidebar-tab--ended" : "",
          tab.status === "attach_error" ? "sidebar-tab--error" : "",
          tab.fill === "off" ? "" : `sidebar-tab--fill-${tab.fill}`,
        ].filter(Boolean).join(" ")}
        /// The stripe is solid and never blended, so it reads at full strength
        /// against any group wash behind it.
        style={{ "--tab-color": resolveTabColor(theme, tab.color) } as CSSProperties}
        role="tab"
        aria-selected={active}
        tabIndex={focusedTabId === tab.id || (!focusedTabId && active) ? 0 : -1}
        data-tab-id={tab.id}
        data-group-id={tab.groupId ?? ""}
        data-drop-kind="tab"
        data-drop-index={index}
        onPointerDown={(event) => startDrag(event, {
          item: { kind: "tab", id: tab.id },
          containerId: tab.groupId,
          index,
        }, tab.title)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openMenu({
            kind: "tab",
            id: tab.id,
            point: { x: event.clientX, y: event.clientY },
          });
        }}
        onFocus={() => setFocusedTabId(tab.id)}
        onClick={(event) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            event.preventDefault();
            return;
          }
          if (event.target === event.currentTarget || !(event.target as HTMLElement).closest("button")) {
            actions.activateTab(tab.id);
          }
        }}
        onDoubleClick={(event: MouseEvent<HTMLDivElement>) => {
          if (!(event.target as HTMLElement).closest("button")) {
            event.preventDefault();
            beginTabRename(tab);
          }
        }}
        onKeyDown={(event) => handleTabKey(event, tab)}
      >
        <span className="sidebar-tab__content">
          {renaming ? (
            <InlineRename
              value={tab.title}
              ariaLabel={`Rename ${tab.title}`}
              onCommit={(value) => {
                actions.renameTab(tab.id, value);
                finishRename({ kind: "tab", id: tab.id });
              }}
              onCancel={() => finishRename({ kind: "tab", id: tab.id })}
            />
          ) : (
            <span className="sidebar-tab__title">{tab.title}</span>
          )}
          {ended ? <span className="sidebar-tab__badge">Exited</span> : null}
          {tab.status === "attach_error" ? (
            <span className="sidebar-tab__badge sidebar-tab__badge--error">Attach error</span>
          ) : null}
          {!ended && sleeping && tab.sessionIds.some((id) => sleeping.has(id)) ? (
            <span
              className="sidebar-tab__badge sidebar-tab__badge--sleep"
              title="Sleeping — the terminal keeps running"
            >
              zZ
            </span>
          ) : null}
        </span>
        <span
          className="sidebar-tab__activity"
          data-activity={tab.activity}
          aria-label={activityLabel(tab.activity)}
        />
        <button
          type="button"
          className="sidebar-tab__close"
          aria-label={`${ended ? "Dismiss" : "Close"} ${tab.title}`}
          disabled={ended && dismissingTabIds.has(tab.id)}
          onClick={(event) => {
            event.stopPropagation();
            requestTabClose(tab);
          }}
        >
          ×
        </button>
      </div>
    );
  };

  const renderItems = (items: readonly SidebarItemModel[], depth: number) =>
    items.map((item, index) =>
      item.kind === "tab"
        ? renderTab(item.tab, index, depth)
        : renderGroup(item.group, index, depth)
    );

  const renderGroup = (
    group: SidebarGroupModel,
    groupIndex: number,
    depth: number,
  ) => {
    const renaming = renameTarget?.kind === "group" && renameTarget.id === group.id;
    return (
      <section
        className={`sidebar-group${group.color ? " sidebar-group--colored" : ""}`}
        data-group-id={group.id}
        data-group-depth={depth}
        key={group.id}
        /// A coloured group frames and washes its whole region, so the colour
        /// is visible between and beside its tabs — not just on the header.
        {...(group.color
          ? {
            style: {
              "--group-color": resolveTabColor(theme, group.color),
            } as CSSProperties,
          }
          : {})}
      >
        <div
          className="sidebar-group__header"
          aria-level={depth}
          data-drop-kind="group"
          data-drop-group-id={group.id}
          data-drop-parent-id={group.parentGroupId ?? ""}
          data-drop-index={groupIndex}
          data-drop-tab-count={group.items.length}
          onPointerDown={(event) => startDrag(event, {
            item: { kind: "group", id: group.id },
            containerId: group.parentGroupId,
            index: groupIndex,
          }, group.name)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openMenu({
              kind: "group",
              id: group.id,
              point: { x: event.clientX, y: event.clientY },
            });
          }}
        >
          <button
            type="button"
            className="sidebar-group__toggle"
            aria-label={`${group.collapsed ? "Expand" : "Collapse"} ${group.name}`}
            aria-expanded={!group.collapsed}
            onClick={() => actions.toggleGroup(group.id)}
          >
            <span className="sidebar-group__chevron" aria-hidden="true">›</span>
          </button>
          <span
            className="sidebar-group__color"
            data-color={group.color ?? "slate"}
            style={{ backgroundColor: resolveTabColor(theme, group.color ?? "slate") }}
            aria-hidden="true"
          />
          <span
            ref={(node) => {
              if (node) groupRefs.current.set(group.id, node);
              else groupRefs.current.delete(group.id);
            }}
            className="sidebar-group__name"
            data-group-name={group.id}
            tabIndex={0}
            onDoubleClick={() => setRenameTarget({ kind: "group", id: group.id })}
            onKeyDown={(event) => {
              if (event.key === "F2") {
                event.preventDefault();
                setRenameTarget({ kind: "group", id: group.id });
              }
            }}
          >
            {renaming ? (
              <InlineRename
                value={group.name}
                ariaLabel={`Rename ${group.name}`}
                onCommit={(value) => {
                  actions.renameGroup(group.id, value);
                  finishRename({ kind: "group", id: group.id });
                }}
                onCancel={() => finishRename({ kind: "group", id: group.id })}
              />
            ) : group.name}
          </span>
          <span className="sidebar-group__count">{group.items.length}</span>
        </div>
        {!group.collapsed ? (
          <div
            className="sidebar-group__tabs"
            role="tablist"
            aria-label={`${group.name} terminals`}
            data-drop-kind="tab-container"
            data-drop-group-id={group.id}
            data-drop-index={group.items.length}
          >
            {renderItems(group.items, depth + 1)}
          </div>
        ) : null}
      </section>
    );
  };

  const requestSavedDelete = (entry: SavedSession, opener?: HTMLElement | null) => {
    openConfirmation({ kind: "saved", id: entry.id, title: entry.name }, opener);
  };

  /// One saved session: the name it was pinned under, the folder it restores,
  /// and the provider badge when a conversation rides along. The whole row is
  /// the resume affordance; rename and delete sit in the hover tray, exactly
  /// like a tab's close button.
  const renderSavedRow = (entry: SavedSession) => {
    const renaming = savedRenameId === entry.id;
    const provider = entry.conversation?.provider ?? null;
    const resume = () => {
      if (!renaming) {
        saved?.onResume(entry);
      }
    };
    return (
      <div
        key={entry.id}
        className="sidebar-saved__row"
        data-testid="saved-row"
        data-saved-id={entry.id}
        role="button"
        tabIndex={0}
        /// The description is the row's tooltip; without one the full path is
        /// more use than repeating the truncated tail.
        title={entry.description ?? entry.cwd}
        onClick={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("button") || target.closest("input")) {
            return;
          }
          resume();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) {
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            resume();
          } else if (event.key === "F2") {
            event.preventDefault();
            setSavedRenameId(entry.id);
          } else if (event.key === "Delete") {
            event.preventDefault();
            requestSavedDelete(entry);
          }
        }}
      >
        <span className="sidebar-saved__content">
          {renaming ? (
            <InlineRename
              value={entry.name}
              ariaLabel={`Rename ${entry.name}`}
              onCommit={(value) => {
                saved?.onRename(entry.id, value);
                setSavedRenameId(null);
              }}
              onCancel={() => setSavedRenameId(null)}
            />
          ) : (
            <span className="sidebar-saved__title">
              <span className="sidebar-saved__name">{entry.name}</span>
              {provider ? (
                <span className="sidebar-saved__badge" data-provider={provider}>
                  {provider}
                </span>
              ) : null}
            </span>
          )}
          <span className="sidebar-saved__folder">{folderTail(entry.cwd)}</span>
        </span>
        {/* Hidden while renaming: the editor already owns the row, and a second
            "Rename …" control would duplicate its label. */}
        {renaming ? null : (
          <span className="sidebar-saved__actions">
            <button
              type="button"
              className="sidebar-saved__action"
              aria-label={`Rename ${entry.name}`}
              title="Rename"
              onClick={(event) => {
                event.stopPropagation();
                setSavedRenameId(entry.id);
              }}
            >
              ✎
            </button>
            <button
              type="button"
              className="sidebar-saved__action sidebar-saved__action--danger"
              aria-label={`Delete ${entry.name}`}
              title="Delete saved session"
              onClick={(event) => {
                event.stopPropagation();
                requestSavedDelete(entry, event.currentTarget);
              }}
            >
              ×
            </button>
          </span>
        )}
      </div>
    );
  };

  /// The section stays on screen while the setting is on even with nothing in
  /// it: the one-line hint is how the feature explains itself, and an empty
  /// list that vanishes teaches nobody where saves land.
  const savedSection = saved?.enabled ? (
    <section
      className="sidebar-saved"
      data-testid="saved-section"
      aria-label="Saved sessions"
    >
      <div className="sidebar-saved__header">
        <span className="sidebar-saved__label">Saved</span>
        <span className="sidebar-saved__count">{savedRows.length}</span>
      </div>
      {savedRows.length === 0 ? (
        <p className="sidebar-saved__empty">
          Pin a terminal to keep its folder and conversation here.
        </p>
      ) : (
        <div className="sidebar-saved__rows">{savedRows.map(renderSavedRow)}</div>
      )}
    </section>
  ) : null;

  /// Containers the item may move into, minus the one it already sits in —
  /// the menu twin of the drag eligibility set, each with the append index for
  /// that container.
  const moveTargets = (
    item: Item,
    containerId: string | null,
  ): { id: string | null; name: string; index: number }[] => {
    const targets: { id: string | null; name: string; index: number }[] = [];
    if (
      containerId !== null &&
      canMoveItem(snapshot.layout, item, null, maxGroupDepth)
    ) {
      targets.push({
        id: null,
        name: item.kind === "tab" ? "Ungrouped" : "Top level",
        index: snapshot.rootItems.length,
      });
    }
    for (const group of snapshot.groups) {
      if (
        group.id === containerId ||
        !canMoveItem(snapshot.layout, item, group.id, maxGroupDepth)
      ) {
        continue;
      }
      targets.push({ id: group.id, name: group.name, index: group.items.length });
    }
    return targets;
  };

  const renderMovePanel = (
    label: string,
    item: Item,
    containerId: string | null,
  ) => (
    <ContextMenu label={label} point={menu!.point} onClose={closeMenu}>
      <button type="button" role="menuitem" onClick={() => setMenuPanel("root")}>← Back</button>
      {moveTargets(item, containerId).map((target) => (
        <button
          type="button"
          role="menuitem"
          key={target.id ?? "root"}
          onClick={() => {
            actions.moveItem(item, target.id, target.index);
            closeMenu();
          }}
        >
          {target.name}
        </button>
      ))}
    </ContextMenu>
  );

  /// Swatches paint from `resolveTabColor`, so what the menu shows is exactly
  /// what the stripe will be under the running theme.
  const renderSwatchGrid = (label: string, onPick: (color: PaletteId) => void) => (
    <div className="sidebar-color-grid" aria-label={label}>
      {PALETTE_IDS.map((color) => (
        <button
          type="button"
          role="menuitem"
          className="sidebar-color-swatch"
          aria-label={`Set color ${color}`}
          title={color}
          key={color}
          style={{ backgroundColor: resolveTabColor(theme, color) }}
          onClick={() => {
            onPick(color);
            closeMenu();
          }}
        />
      ))}
    </div>
  );

  const renderedMenu = (() => {
    if (!menu) {
      return null;
    }
    if (menu.kind === "tab") {
      const tab = [...snapshot.ungroupedTabs, ...snapshot.groups.flatMap((group) => group.tabs)]
        .find((candidate) => candidate.id === menu.id);
      if (!tab) {
        return null;
      }
      if (menuPanel === "color") {
        return (
          <ContextMenu label={`Color for ${tab.title}`} point={menu.point} onClose={closeMenu}>
            <button type="button" role="menuitem" onClick={() => setMenuPanel("root")}>← Back</button>
            {renderSwatchGrid("Tab colors", (color) => actions.recolorTab(tab.id, color))}
            <div className="sidebar-fill-row" aria-label="Tab fill">
              {FILL_OPTIONS.map((option) => (
                <button
                  type="button"
                  role="menuitem"
                  className="sidebar-fill-option"
                  key={option.value}
                  aria-pressed={tab.fill === option.value}
                  onClick={() => {
                    actions.setTabFill(tab.id, option.value);
                    closeMenu();
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </ContextMenu>
        );
      }
      if (menuPanel === "move") {
        return renderMovePanel(
          `Move ${tab.title}`,
          { kind: "tab", id: tab.id },
          tab.groupId,
        );
      }
      const ended = tab.status === "dead" || tab.status === "missing";
      return (
        <ContextMenu label={`Actions for ${tab.title}`} point={menu.point} onClose={closeMenu}>
          <button type="button" role="menuitem" onClick={() => {
            closeMenu();
            beginTabRename(tab);
          }}>Rename</button>
          <button type="button" role="menuitem" onClick={() => {
            closeMenu();
            void actions.duplicateTab(tab.id);
          }}>Duplicate tab</button>
          <button type="button" role="menuitem" onClick={() => {
            closeMenu();
            void actions.openFolderHere(tab.id);
          }}>Open folder here</button>
          <button type="button" role="menuitem" onClick={() => setMenuPanel("color")}>Color</button>
          <button type="button" role="menuitem" onClick={() => setMenuPanel("move")}>Move to…</button>
          <button
            type="button"
            role="menuitem"
            disabled={snapshot.activeTabId === null || tab.id === snapshot.activeTabId}
            onClick={() => {
              const target = snapshot.activeTabId;
              closeMenu();
              if (target !== null && target !== tab.id) {
                actions.mergeTabs(tab.id, target);
              }
            }}
          >
            Side-by-side with active tab
          </button>
          <button type="button" role="menuitem" className="context-menu__danger" onClick={() => {
            closeMenu();
            requestTabClose(tab, tabRefs.current.get(tab.id));
          }}>{ended ? "Dismiss" : "Close"}</button>
        </ContextMenu>
      );
    }

    if (menu.kind === "group") {
      const group = snapshot.groups.find((candidate) => candidate.id === menu.id);
      if (!group) {
        return null;
      }
      if (menuPanel === "move") {
        return renderMovePanel(
          `Move ${group.name}`,
          { kind: "group", id: group.id },
          group.parentGroupId,
        );
      }
      if (menuPanel === "color") {
        return (
          <ContextMenu label={`Color for ${group.name}`} point={menu.point} onClose={closeMenu}>
            <button type="button" role="menuitem" onClick={() => setMenuPanel("root")}>← Back</button>
            {renderSwatchGrid("Group colors", (color) => actions.recolorGroup(group.id, color))}
            <button
              type="button"
              role="menuitem"
              aria-pressed={group.color === null}
              onClick={() => {
                actions.recolorGroup(group.id, null);
                closeMenu();
              }}
            >None</button>
          </ContextMenu>
        );
      }
      const nestingBlocked = group.depth + 1 > maxGroupDepth;
      return (
        <ContextMenu label={`Actions for ${group.name}`} point={menu.point} onClose={closeMenu}>
          <button type="button" role="menuitem" onClick={() => {
            closeMenu();
            setRenameTarget({ kind: "group", id: group.id });
          }}>Rename</button>
          <button
            type="button"
            role="menuitem"
            disabled={nestingBlocked}
            {...(nestingBlocked
              ? { title: `Max group depth is ${maxGroupDepth} — change it in Settings` }
              : {})}
            onClick={() => {
              closeMenu();
              setCreatingGroup({ parentGroupId: group.id });
            }}
          >New subgroup</button>
          <button type="button" role="menuitem" onClick={() => {
            closeMenu();
            void createTab(group.id, null);
          }}>New tab in group</button>
          {onOpenFolderSearch ? (
            <button type="button" role="menuitem" onClick={() => {
              closeMenu();
              onOpenFolderSearch(group.id);
            }}>New tab in folder…</button>
          ) : null}
          <button type="button" role="menuitem" onClick={() => setMenuPanel("color")}>Color</button>
          <button type="button" role="menuitem" onClick={() => setMenuPanel("move")}>Move to…</button>
          <button type="button" role="menuitem" onClick={() => {
            actions.toggleGroup(group.id);
            closeMenu();
          }}>{group.collapsed ? "Expand" : "Collapse"}</button>
          <button type="button" role="menuitem" className="context-menu__danger" onClick={() => {
            closeMenu();
            openConfirmation(
              { kind: "group", id: group.id, title: group.name },
              groupRefs.current.get(group.id),
            );
          }}>Delete group</button>
        </ContextMenu>
      );
    }

    if (menu.kind === "background") {
      return (
        <ContextMenu label="Sidebar actions" point={menu.point} onClose={closeMenu}>
          <button type="button" role="menuitem" onClick={() => {
            closeMenu();
            void createTab(null, null);
          }}>New tab</button>
          {onOpenFolderSearch ? (
            <button type="button" role="menuitem" onClick={() => {
              closeMenu();
              onOpenFolderSearch(null);
            }}>New tab in folder…</button>
          ) : null}
          <button type="button" role="menuitem" onClick={() => {
            closeMenu();
            setCreatingGroup({ parentGroupId: null });
          }}>New group</button>
        </ContextMenu>
      );
    }

    return (
      <ContextMenu label="New terminal profile" point={menu.point} onClose={closeMenu}>
        {onOpenFolderSearch ? (
          <button type="button" role="menuitem" onClick={() => {
            closeMenu();
            onOpenFolderSearch(null);
          }}>New tab in folder…</button>
        ) : null}
        <button type="button" role="menuitem" onClick={() => {
          closeMenu();
          void createTab(null, null);
        }}>Default</button>
        <button type="button" role="menuitem" onClick={() => {
          closeMenu();
          void createTab(null, "powershell");
        }}>Windows PowerShell</button>
        <button type="button" role="menuitem" onClick={() => {
          closeMenu();
          void createTab(null, "cmd");
        }}>Command Prompt</button>
      </ContextMenu>
    );
  })();

  // The switch (and therefore the rail) only exists when the App supplies a
  // conversations store and the setting is on; otherwise this is the sidebar
  // exactly as it was.
  const railEnabled = conversations !== undefined && conversations.settings.conversationsRail;
  const showConversations = railEnabled && mode === "conversations";

  return (
    <aside
      ref={asideRef}
      className="sidebar"
      aria-label="Terminal sessions"
      {...(width !== undefined
        ? { style: { flexBasis: `${width}px`, width: `${width}px` } }
        : {})}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={cancelDrag}
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu({
          kind: "background",
          point: { x: event.clientX, y: event.clientY },
        });
      }}
    >
      <header className="sidebar__header">
        <span className="sidebar__mark" aria-hidden="true">T</span>
        <span>Sessions</span>
        {snapshot.persistence.saving ? <span className="sidebar__saving">Saving…</span> : null}
        {showConversations && onExpandConversations ? (
          <button
            type="button"
            className="sidebar__expand"
            aria-label="Conversations full screen"
            title="Conversations full screen"
            onClick={onExpandConversations}
          >
            ⛶
          </button>
        ) : null}
      </header>
      {railEnabled ? (
        <div className="sidebar__modes" role="tablist" aria-label="Sidebar mode">
          <button
            type="button"
            role="tab"
            className={`sidebar__mode${mode === "terminals" ? " sidebar__mode--active" : ""}`}
            aria-selected={mode === "terminals"}
            onClick={() => setMode("terminals")}
          >
            Terminals
          </button>
          <button
            type="button"
            role="tab"
            className={`sidebar__mode${mode === "conversations" ? " sidebar__mode--active" : ""}`}
            aria-selected={mode === "conversations"}
            onClick={() => setMode("conversations")}
          >
            Conversations
          </button>
        </div>
      ) : null}
      {showConversations && conversations ? (
        <ConversationsRail
          store={conversations.store}
          settings={conversations.settings}
          onResume={conversations.onResume}
          onOpenTranscript={conversations.onOpenTranscript}
          {...(conversations.listArtifacts
            ? { listArtifacts: conversations.listArtifacts }
            : {})}
          {...(conversations.onOpenFile
            ? { onOpenFile: conversations.onOpenFile }
            : {})}
          {...(conversations.onOpenFolder
            ? { onOpenFolder: conversations.onOpenFolder }
            : {})}
          {...(conversations.onVisibleRecords
            ? { onVisibleRecords: conversations.onVisibleRecords }
            : {})}
          {...(conversations.listOutputs
            ? { listOutputs: conversations.listOutputs }
            : {})}
          {...(conversations.dismissOutput
            ? { dismissOutput: conversations.dismissOutput }
            : {})}
        />
      ) : (
      <>
      <div className="sidebar__scroll">
        {savedSection}
        <div
          className="sidebar__root"
          role="tablist"
          aria-label="Terminals"
          data-drop-kind="tab-container"
          data-drop-group-id=""
          data-drop-index={snapshot.rootItems.length}
          data-empty={snapshot.rootItems.length === 0 ? "true" : undefined}
        >
          {renderItems(snapshot.rootItems, 1)}
        </div>
      </div>
      {creatingGroup ? (
        <div className="sidebar-new-group">
          <InlineRename
            value="New group"
            ariaLabel="Name new group"
            onCommit={(name) => {
              actions.createGroup(creatingGroup.parentGroupId, name);
              setCreatingGroup(null);
            }}
            onCancel={() => setCreatingGroup(null)}
          />
        </div>
      ) : null}
      <div className="sidebar-create">
        <button
          type="button"
          className="sidebar-create__primary"
          aria-label="New terminal"
          disabled={creating || !hostConnected}
          {...(hostConnected ? {} : { title: WAITING_FOR_HOST })}
          onClick={() => void createTab(null, null)}
        >
          <span aria-hidden="true">＋</span>
          {creating ? "Creating…" : "New terminal"}
        </button>
        <button
          type="button"
          className="sidebar-create__options"
          aria-label="New terminal options"
          disabled={creating || !hostConnected}
          {...(hostConnected ? {} : { title: WAITING_FOR_HOST })}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu({
              kind: "create",
              point: { x: rect.right, y: rect.bottom },
            });
          }}
        >
          ▴
        </button>
        {footerTray ?? (
          <>
            {onOpenFolderSearch ? (
              <button
                type="button"
                className="sidebar-create__options"
                aria-label="New terminal in folder"
                title="New terminal in folder (Ctrl+Shift+O)"
                onClick={() => onOpenFolderSearch(null)}
              >
                ⌕
              </button>
            ) : null}
            {onOpenSettings ? (
              <button
                type="button"
                className="sidebar-create__options"
                aria-label="Settings"
                title="Settings"
                onClick={onOpenSettings}
              >
                ⚙
              </button>
            ) : null}
          </>
        )}
      </div>
      </>
      )}
      {snapshot.notice || snapshot.persistence.error ? (
        <div className="sidebar__notice" role="status">
          {snapshot.notice ?? snapshot.persistence.error}
        </div>
      ) : null}
      {renderedMenu}
      {drag?.active ? (
        <>
          <div
            className="sidebar-drag-ghost"
            style={{
              transform: `translate3d(${drag.current.x + 12}px, ${drag.current.y + 12}px, 0)`,
            }}
          >
            {drag.label}
          </div>
          {drag.indicator ? (
            <div
              className="sidebar-drag-indicator"
              style={{
                left: drag.indicator.left,
                top: drag.indicator.top,
                width: drag.indicator.width,
              }}
            />
          ) : null}
        </>
      ) : null}
      {confirmClose ? (
        <div className="sidebar-dialog-backdrop">
          <div
            ref={dialogRef}
            className="sidebar-dialog"
            role="dialog"
            aria-modal="true"
            aria-busy={busy}
            aria-label={CONFIRM_LABELS[confirmClose.kind].dialog}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (!busy) {
                  closeConfirmation();
                }
                return;
              }
              if (event.key !== "Tab") {
                return;
              }
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
              );
              if (buttons.length === 0) {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.focus();
                return;
              }
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const leavingStart = event.shiftKey && index <= 0;
              const leavingEnd = !event.shiftKey && index === buttons.length - 1;
              if (leavingStart || leavingEnd) {
                event.preventDefault();
                event.stopPropagation();
                buttons[leavingStart ? buttons.length - 1 : 0]?.focus();
              }
            }}
          >
            <h2>{CONFIRM_LABELS[confirmClose.kind].heading}</h2>
            <p>{confirmPrompt(confirmClose)}</p>
            <div className="sidebar-dialog__actions">
              <button
                ref={dialogCancelRef}
                type="button"
                disabled={busy}
                onClick={closeConfirmation}
              >Cancel</button>
              {confirmClose.kind === "group" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runConfirmation(
                    () => actions.deleteGroup(confirmClose.id, "keep-children"),
                  )}
                >Keep terminals</button>
              ) : null}
              <button
                type="button"
                className="sidebar-dialog__danger"
                disabled={busy}
                onClick={() => void runConfirmation(async () => {
                  if (confirmClose.kind === "tab") {
                    await actions.closeLiveTab(confirmClose.id);
                  } else if (confirmClose.kind === "group") {
                    await actions.deleteGroup(confirmClose.id, "close-tabs");
                  } else {
                    saved?.onDelete(confirmClose.id);
                  }
                })}
              >
                {busy
                  ? CONFIRM_LABELS[confirmClose.kind].busy
                  : CONFIRM_LABELS[confirmClose.kind].confirm}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {onResize ? (
        <div
          className="sidebar__resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize — double-click to reset"
          tabIndex={0}
          data-testid="sidebar-resize"
          onPointerDown={beginResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onResize(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
              return;
            }
            event.preventDefault();
            const step = event.key === "ArrowRight" ? SIDEBAR_RESIZE_STEP : -SIDEBAR_RESIZE_STEP;
            onResize(clampSidebarWidth(currentWidth() + step));
          }}
        />
      ) : null}
    </aside>
  );
}

/** Wording per destructive confirmation, so the dialog stays one component. */
const CONFIRM_LABELS: Record<
  ConfirmClose["kind"],
  { dialog: string; heading: string; confirm: string; busy: string }
> = {
  tab: {
    dialog: "Close terminal",
    heading: "Close terminal?",
    confirm: "Close terminal",
    busy: "Closing…",
  },
  group: {
    dialog: "Delete group",
    heading: "Delete group?",
    confirm: "Close terminals",
    busy: "Closing…",
  },
  saved: {
    dialog: "Delete saved session",
    heading: "Delete saved session?",
    confirm: "Delete",
    busy: "Deleting…",
  },
};

function confirmPrompt(confirm: ConfirmClose): string {
  if (confirm.kind === "tab") {
    return `Close “${confirm.title}” and end its running shell?`;
  }
  if (confirm.kind === "group") {
    return `Delete “${confirm.title}”? Its terminals move up a level, or close with it.`;
  }
  // Deleting a save throws away a bookmark, never a terminal or a transcript.
  return `Remove “${confirm.title}” from Saved? Its terminal and conversation are left alone.`;
}

/** Last path segment of a folder — the row's secondary line. */
function folderTail(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function activityLabel(activity: SidebarTabModel["activity"]): string {
  if (activity === "unread") return "Unread output";
  if (activity === "active") return "Terminal active";
  return "No recent output";
}

/**
 * The slot under the pointer, or null when there is no legal one. Rows and
 * containers speak positions in their own container's ITEMS; a group header
 * means "nest into me" through its middle band and "before/after me" at its
 * edges, so a group can be both a destination and a neighbour.
 */
function resolveDropTarget(
  point: { x: number; y: number },
  eligible: ReadonlySet<string | null>,
): {
  target: DropTarget;
  indicator: { left: number; top: number; width: number };
} | null {
  const hit = document.elementFromPoint(point.x, point.y);
  if (!(hit instanceof HTMLElement)) {
    return null;
  }
  const candidate = hit.closest<HTMLElement>("[data-drop-kind]");
  if (!candidate) {
    return null;
  }
  const kind = candidate.dataset.dropKind;
  const rect = candidate.getBoundingClientRect();

  if (kind === "tab") {
    const containerId = nullableGroupId(candidate.dataset.groupId);
    if (!eligible.has(containerId)) {
      return null;
    }
    const baseIndex = numberAttribute(candidate.dataset.dropIndex);
    const after = point.y >= rect.top + rect.height / 2;
    return {
      target: { containerId, index: baseIndex + (after ? 1 : 0) },
      indicator: {
        left: rect.left + 8,
        top: after ? rect.bottom : rect.top,
        width: Math.max(0, rect.width - 16),
      },
    };
  }

  if (kind === "tab-container") {
    const containerId = nullableGroupId(candidate.dataset.dropGroupId);
    if (!eligible.has(containerId)) {
      return null;
    }
    return {
      target: {
        containerId,
        index: numberAttribute(candidate.dataset.dropIndex),
      },
      indicator: {
        left: rect.left + 8,
        top: rect.bottom,
        width: Math.max(0, rect.width - 16),
      },
    };
  }

  if (kind === "group") {
    const offset = (point.y - rect.top) / (rect.height || 1);
    if (offset > 0.25 && offset < 0.75) {
      const containerId = nullableGroupId(candidate.dataset.dropGroupId);
      if (containerId === null || !eligible.has(containerId)) {
        return null;
      }
      return {
        target: {
          containerId,
          index: numberAttribute(candidate.dataset.dropTabCount),
        },
        indicator: {
          left: rect.left + 8,
          top: rect.bottom,
          width: Math.max(0, rect.width - 16),
        },
      };
    }
    const containerId = nullableGroupId(candidate.dataset.dropParentId);
    if (!eligible.has(containerId)) {
      return null;
    }
    const after = offset >= 0.75;
    return {
      target: {
        containerId,
        index: numberAttribute(candidate.dataset.dropIndex) + (after ? 1 : 0),
      },
      indicator: {
        left: rect.left,
        top: after ? rect.bottom : rect.top,
        width: rect.width,
      },
    };
  }
  return null;
}

function numberAttribute(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function nullableGroupId(value: string | undefined): string | null {
  return value ? value : null;
}

function releaseDragCapture(
  drag: PointerDragState,
  tabRefs: ReadonlyMap<string, HTMLDivElement>,
  groupRefs: ReadonlyMap<string, HTMLElement>,
): void {
  const element = drag.source.item.kind === "tab"
    ? tabRefs.get(drag.source.item.id)
    : groupRefs.get(drag.source.item.id)?.closest<HTMLElement>(".sidebar-group__header");
  try {
    element?.releasePointerCapture(drag.pointerId);
  } catch {
    // Pointer capture may already be released by the browser.
  }
}
