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
import { isEditableElement } from "../keyboard";
import type { LlmSessionRecord } from "../conversations/types";
import type { SavedSession } from "../saved/types";
import { DEFAULT_SETTINGS, type TermxSettings } from "../settings/settings";
import type { SshHost } from "../ssh/types";
import {
  canMoveItem,
  MAIN_WINDOW_ID,
  PALETTE_IDS,
  type FillStrength,
  type Item,
  type PaletteId,
  type SplitDir,
} from "../state/layout";
import { useThemeId } from "../theme/ThemeProvider";
import { resolveTabColor, themeById } from "../theme/themes";
import type { PluginSurface } from "../plugins/manifest";
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH } from "../workspace/uiState";
import type { PluginOpenTarget } from "../workspace/WorkspaceController";
import type {
  SidebarGroupModel,
  SidebarItemModel,
  SidebarTabModel,
  WorkspaceSnapshot,
} from "../workspace/WorkspaceController";
import { ContextMenu, type MenuPoint } from "./ContextMenu";
import { InlineRename } from "./InlineRename";
import {
  HOVER_PANES_FLYOUT_MS,
  PANE_FLYOUT_ID,
  PaneFlyout,
  type PaneFlyoutPane,
} from "./PaneFlyout";
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
  /**
   * Multi-window Phase 1: tear the item out into `"new"` (a fresh OS window)
   * or an existing window's root. Optional — when absent the window entries
   * simply do not render. Null = the store refused the move.
   */
  moveItemToWindow?(item: Item, target: string | "new"): string | null;
  /**
   * Plugin panels (plugin spec §4, menubar spec). ONE entry point, shared with
   * the menubar's Plugins list and Settings' Open button, so the placement
   * policy - which surfaces a plugin allows, and focusing what is already open
   * rather than opening it twice - is written once and every launcher agrees.
   *
   * Optional and fire-and-forget: a menu cannot wait, and the plugin entries do
   * not render at all when it is unwired, exactly as `moveItemToWindow` does.
   *
   * `at` carries what the rail knows and the controller cannot guess - which
   * group the create menu was opened on, and which pane of which tab the tab
   * menu was opened on, very often not the active one.
   */
  openPlugin?(
    pluginId: string,
    surface?: PluginSurface,
    at?: PluginOpenTarget,
  ): void;
  /**
   * @deprecated Superseded by `openPlugin`, which both plugin submenus now
   * call. Still declared because they remain the controller primitives
   * `openPlugin` is built from, and App hands the sidebar the whole controller.
   */
  openPluginTab?(pluginId: string, groupId: string | null): void;
  /** @deprecated See `openPluginTab`. */
  openPluginSplit?(
    tabId: string,
    anchorSessionId: number,
    pluginId: string,
    dir: SplitDir,
  ): void;
}

/**
 * One installed plugin as the menus need it — a plain snapshot, so the sidebar
 * never reaches into the plugin registry. `enabled` gates the menu entries; a
 * disabled plugin is left OUT rather than greyed, because turning one on is a
 * Settings decision and a menu that offers a dead entry teaches nothing. It
 * still rides in the list, so a pane bound to a plugin the user has since
 * switched off keeps its glyph on the rail.
 */
export interface SidebarPlugin {
  id: string;
  name: string;
  icon: string;
  enabled: boolean;
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
  /** Saved-sessions rail action (saved-sessions spec), forwarded verbatim. */
  onSaveConversation?: ConversationsRailProps["onSaveConversation"];
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
  /** Inline rename. */
  onRename(id: string, name: string): void;
  /** Inline description edit; "" clears it (a bare-shell entry's only path). */
  onDescribe(id: string, description: string): void;
  onDelete(id: string): void;
}

/**
 * SSH hosts (ssh-sessions spec §1): the read-only `~/.ssh/config` inventory,
 * listed under Saved. `enabled` carries `settings.sshHostsSidebar` and
 * `menuEnabled` carries `settings.sshHostsMenu`, so each surface is gated one
 * prop away from the render and the two are independent — the menu can list
 * hosts the section is hiding.
 */
export interface SidebarHosts {
  enabled: boolean;
  menuEnabled: boolean;
  /** Config order: the file is the source of truth, so the file's order is. */
  hosts: readonly SshHost[];
  /** Row click / Enter: connect in a new tab. */
  onConnect(alias: string): void;
  /** Present only when the password policy allows storing. */
  onSetPassword?(alias: string): void;
  /** Aliases that currently have a stored password (badge + "Change password…"). */
  withPassword?: ReadonlySet<string>;
  /**
   * Section folded away, header only. Absent = expanded, which is also what a
   * caller that does not persist the state gets.
   */
  collapsed?: boolean;
  /**
   * Reports the header's new state. Absent leaves the header a plain label —
   * the same bargain `onResize` strikes for the width handle: a state nobody
   * stores is not a state the sidebar offers to change.
   */
  onToggleCollapsed?(collapsed: boolean): void;
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
   * Display names of a tab's panes, keyed by session id — the controller's
   * `paneTitles`, the SAME source the pane headers read, so the hover preview
   * can never contradict what the split view says. Absent switches the preview
   * off entirely: a sidebar with no way to name a pane has no preview to show.
   */
  paneTitles?: (tabId: string) => Readonly<Record<number, string>>;
  /**
   * Where each of a tab's panes is standing, keyed by session id — the
   * controller's `paneCwds`, the same per-session cwd the status bar reads.
   * Absent leaves the preview exactly as it was: names only, no second line.
   */
  paneCwds?: (tabId: string) => Readonly<Record<number, string | null>>;
  /**
   * Saved sessions section (saved-sessions spec). Omitted — or disabled in
   * settings — leaves the sidebar exactly as it was.
   */
  saved?: SidebarSaved;
  /**
   * SSH hosts section and new-terminal menu targets (ssh-sessions spec §1).
   * Omitted — or disabled in settings — leaves the sidebar exactly as it was.
   */
  hosts?: SidebarHosts;
  /**
   * Installed plugin panels (plugin spec §4), newest state each render. Absent
   * — or holding nothing enabled — leaves every menu exactly as it was.
   */
  plugins?: readonly SidebarPlugin[];
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
  /**
   * Which window's sidebar this is (multi-window Phase 1). Drives the
   * "Move to <window>" entries — the current window is never offered as a
   * target. Absent = the main window, so single-window callers are untouched.
   */
  windowId?: string;
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

/** Is the pointer heading into the open pane preview rather than away from it? */
function enteringPaneFlyout(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-pane-flyout]") !== null;
}

/** Human label for a window id: main → "Main window", aux-<n> → "Window <n+1>"
 *  (main counts as window 1). Unrecognized ids fall back to the raw id. */
function windowLabel(windowId: string): string {
  if (windowId === MAIN_WINDOW_ID) {
    return "Main window";
  }
  const match = /^aux-(\d+)$/.exec(windowId);
  return match ? `Window ${Number(match[1]) + 1}` : windowId;
}

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
  paneTitles,
  paneCwds,
  saved,
  hosts,
  plugins,
  width,
  onResize,
  onExpandConversations,
  windowId = MAIN_WINDOW_ID,
  sleeping,
  footerTray,
  hostConnected = true,
}: SidebarProps) {
  const theme = themeById(useThemeId());
  const [mode, setMode] = useState<SidebarMode>("terminals");
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  /// Id of the saved row whose name is being edited inline, if any.
  const [savedRenameId, setSavedRenameId] = useState<string | null>(null);
  const [savedDescribeId, setSavedDescribeId] = useState<string | null>(null);
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
  const [selectedTabIds, setSelectedTabIds] = useState<ReadonlySet<string>>(
    () => new Set(snapshot.activeTabId ? [snapshot.activeTabId] : []),
  );
  const selectionAnchorRef = useRef<string | null>(snapshot.activeTabId);
  const selectionActiveTabRef = useRef(snapshot.activeTabId);
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
  /// Non-null while the pane preview is up: the row it hangs off, and where
  /// that row stood when the dwell completed.
  const [paneFlyout, setPaneFlyout] = useState<
    { tabId: string; anchor: { top: number; right: number } } | null
  >(null);
  const paneFlyoutTimerRef = useRef<number | null>(null);
  const paneFlyoutPendingRef = useRef<string | null>(null);
  /// The dwell outlives the render that started it, so the guards it has to
  /// re-check on firing are read through refs rather than closed over.
  const renameTargetRef = useRef<RenameTarget | null>(null);

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

  useLayoutEffect(() => {
    const visible = new Set(visibleTabIds);
    const activeId = snapshot.activeTabId && visible.has(snapshot.activeTabId)
      ? snapshot.activeTabId
      : null;
    // Tab shortcuts and other launchers start a fresh selection. Ordinary
    // workspace/activity updates must leave the user's selection intact.
    if (selectionActiveTabRef.current !== snapshot.activeTabId) {
      selectionActiveTabRef.current = snapshot.activeTabId;
      selectionAnchorRef.current = activeId;
      setSelectedTabIds(new Set(activeId ? [activeId] : []));
      return;
    }
    if (!selectionAnchorRef.current || !visible.has(selectionAnchorRef.current)) {
      selectionAnchorRef.current = activeId;
    }
    setSelectedTabIds((previous) => {
      const next = new Set([...previous].filter((id) => visible.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [snapshot.activeTabId, visibleTabIds]);

  /// Saved rows, most recently touched first — a resume or a re-save is what
  /// the user is working on, so it rises. Names break ties so the order is
  /// stable across renders of a freshly imported list.
  const savedRows = useMemo(() => {
    const entries = saved?.entries ?? [];
    return [...entries].sort((left, right) =>
      right.updatedAtMs - left.updatedAtMs || left.name.localeCompare(right.name)
    );
  }, [saved?.entries]);

  /// The plugins a menu may offer. Installed-but-off plugins stay in `plugins`
  /// for the rail glyph and drop out here, so "enabled" is asked once.
  const enabledPlugins = useMemo(
    () => (plugins ?? []).filter((plugin) => plugin.enabled),
    [plugins],
  );

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

  /// ── Rail hover preview (pane flyout) ──────────────────────────────────
  /// The dwell timer lives here rather than in the panel, because everything
  /// that calls it off — a drag, a rename, a menu, a click — is the sidebar's
  /// to know about, and only one preview may be up at a time.

  const cancelPaneDwell = () => {
    if (paneFlyoutTimerRef.current !== null) {
      window.clearTimeout(paneFlyoutTimerRef.current);
      paneFlyoutTimerRef.current = null;
    }
    paneFlyoutPendingRef.current = null;
  };

  const closePaneFlyout = () => {
    cancelPaneDwell();
    setPaneFlyout(null);
  };

  const startPaneDwell = (tabId: string) => {
    /// A rail with no way to name a pane has no preview to offer, and a row
    /// being dragged or renamed is not a row being read.
    if (!paneTitles || dragRef.current || renameTargetRef.current) {
      return;
    }
    /// Re-entering the row the clock is already running for must not restart
    /// it — otherwise crossing a badge inside the row resets the dwell.
    if (paneFlyoutPendingRef.current === tabId || paneFlyout?.tabId === tabId) {
      return;
    }
    cancelPaneDwell();
    paneFlyoutPendingRef.current = tabId;
    paneFlyoutTimerRef.current = window.setTimeout(() => {
      paneFlyoutTimerRef.current = null;
      paneFlyoutPendingRef.current = null;
      /// Three seconds is long enough for a drag or a rename to have begun
      /// since the pointer arrived, so the guards are asked again here.
      if (dragRef.current || renameTargetRef.current) {
        return;
      }
      const rect = tabRefs.current.get(tabId)?.getBoundingClientRect();
      if (rect) {
        setPaneFlyout({ tabId, anchor: { top: rect.top, right: rect.right } });
      }
    }, HOVER_PANES_FLYOUT_MS);
  };

  /// Leaving the row ends the preview — unless the pointer is on its way INTO
  /// the panel, which shares the row's right edge exactly so it can be.
  const handleTabPointerLeave = (target: EventTarget | null) => {
    if (enteringPaneFlyout(target)) {
      cancelPaneDwell();
    } else {
      closePaneFlyout();
    }
  };

  useEffect(() => cancelPaneDwell, []);

  useEffect(() => {
    renameTargetRef.current = renameTarget;
    if (renameTarget) {
      closePaneFlyout();
    }
  }, [renameTarget]);

  useEffect(() => {
    if (!paneFlyout) {
      return;
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      closePaneFlyout();
      /// Esc belongs to whoever claimed it first: an open editor or an armed
      /// confirm cancels ITSELF, and the preview merely gets out of the way.
      /// With no such owner the preview is what Esc was for, and nothing else
      /// should act on the same press.
      if (!document.activeElement?.closest("[data-esc-guard]")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const handlePointerDown = () => closePaneFlyout();
    /// An editor taking focus anywhere in the app has taken over from a hover
    /// preview — the window-name rename opened with F2 is the case that
    /// exposed this, since a keyboard route fires no pointerdown to dismiss on.
    ///
    /// Keyed on focus rather than on a bespoke "a rename began" signal so that
    /// EVERY editor counts without each one having to know the rail exists —
    /// and so the terminal does NOT, because `isEditableElement` excludes
    /// xterm's helper textarea. Reading the preview while typing is exactly
    /// what a three-second dwell is for.
    const handleFocusIn = (event: FocusEvent) => {
      if (isEditableElement(event.target instanceof Element ? event.target : null)) {
        closePaneFlyout();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("focusin", handleFocusIn, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("focusin", handleFocusIn, true);
    };
  }, [paneFlyout]);

  /// The panes of `tab` in layout order, wearing the names their own pane
  /// headers wear. A pane the title source does not cover falls back to the
  /// tab's rail name — which is exactly what a lone pane is called anyway.
  const paneRowsFor = (tab: SidebarTabModel): PaneFlyoutPane[] => {
    const titles = paneTitles?.(tab.id) ?? {};
    const cwds = paneCwds?.(tab.id) ?? {};
    return tab.sessionIds.map((sessionId) => ({
      sessionId,
      name: titles[sessionId] ?? tab.title,
      cwd: cwds[sessionId] ?? null,
    }));
  };

  /// The row the preview hangs off — null once that tab leaves the rail, which
  /// takes the panel with it rather than leaving it pointing at nothing.
  const paneFlyoutTab = paneFlyout
    ? visibleTabs.find((tab) => tab.id === paneFlyout.tabId) ?? null
    : null;

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

  // Double-click on the rail's EMPTY space opens a terminal (Michael,
  // 2026-08-26). Guarded to the container itself: a double-click on any row
  // keeps meaning what that row says it means (rename, section behavior),
  // because those land on child elements, never the container.
  const onRailDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || !hostConnected || creating) {
      return;
    }
    void createTab(null, null);
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

  const selectSingleTab = (tabId: string) => {
    selectionAnchorRef.current = tabId;
    setSelectedTabIds(new Set([tabId]));
    actions.activateTab(tabId);
  };

  const selectTab = (
    event: Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">,
    tabId: string,
  ) => {
    const additive = event.ctrlKey || event.metaKey;
    if (event.shiftKey) {
      const anchor = selectionAnchorRef.current ?? tabId;
      const anchorIndex = visibleTabIds.indexOf(anchor);
      const endIndex = visibleTabIds.indexOf(tabId);
      const startIndex = anchorIndex >= 0 ? anchorIndex : endIndex;
      const range = visibleTabIds.slice(
        Math.min(startIndex, endIndex), Math.max(startIndex, endIndex) + 1,
      );
      selectionAnchorRef.current = visibleTabIds[startIndex] ?? tabId;
      setSelectedTabIds((previous) => new Set(additive ? [...previous, ...range] : range));
    } else if (additive) {
      selectionAnchorRef.current = tabId;
      setSelectedTabIds((previous) => {
        const next = new Set(previous);
        if (next.has(tabId)) next.delete(tabId);
        else next.add(tabId);
        return next;
      });
    } else {
      selectSingleTab(tabId);
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
      if (event.shiftKey) selectTab(event, nextId);
      setFocusedTabId(nextId);
      tabRefs.current.get(nextId)?.focus();
    } else if (event.key === "ArrowUp" && index > 0) {
      event.preventDefault();
      const previousId = visibleTabIds[index - 1]!;
      if (event.shiftKey) selectTab(event, previousId);
      setFocusedTabId(previousId);
      tabRefs.current.get(previousId)?.focus();
    } else if (event.key === " " && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      selectTab(event, tab.id);
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectSingleTab(tab.id);
    } else if (event.key === "F2") {
      event.preventDefault();
      beginTabRename(tab);
    } else if (event.key === "Delete") {
      event.preventDefault();
      requestTabClose(tab);
    }
  };

  /// The sidebar's best guess at the pane a split should hang off, and only a
  /// guess: `snapshot.activeSessionId` is the active tab's FIRST pane, not the
  /// one holding focus — that lives in the App, which overrides this anchor
  /// with the real focused pane before the controller sees it. What is left
  /// here is the honest fallback for a tab the layout no longer has.
  const anchorPane = (tab: SidebarTabModel): number =>
    snapshot.activeSessionId !== null && tab.sessionIds.includes(snapshot.activeSessionId)
      ? snapshot.activeSessionId
      : tab.primarySessionId;

  /// The manifest glyph for a tab whose primary pane IS a plugin panel — how a
  /// Showroom tab reads as Showroom in a column of terminals. Read off the pane
  /// projection the controller already publishes, so nothing new has to ride on
  /// the tab model. A terminal tab that merely holds a plugin split keeps its
  /// terminal identity: the glyph marks what the tab IS, not what is in it.
  const pluginGlyph = (tab: SidebarTabModel): string | null => {
    const pane = snapshot.paneStates[tab.primarySessionId];
    if (pane?.status !== "plugin" || pane.pluginId === undefined) {
      return null;
    }
    return plugins?.find((plugin) => plugin.id === pane.pluginId)?.icon ?? null;
  };

  /// `index` is the row's position among its container's ITEMS (tabs and
  /// subgroups alike) — the index every move/drop command speaks in — and
  /// `depth` is its nesting level, 1 at the root.
  const renderTab = (tab: SidebarTabModel, index: number, depth: number) => {
    const active = tab.id === snapshot.activeTabId;
    const selected = selectedTabIds.has(tab.id);
    const glyph = pluginGlyph(tab);
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
          selected ? "sidebar-tab--selected" : "",
          ended ? "sidebar-tab--ended" : "",
          tab.status === "attach_error" ? "sidebar-tab--error" : "",
          tab.fill === "off" ? "" : `sidebar-tab--fill-${tab.fill}`,
        ].filter(Boolean).join(" ")}
        /// The stripe is solid and never blended, so it reads at full strength
        /// against any group wash behind it.
        style={{ "--tab-color": resolveTabColor(theme, tab.color) } as CSSProperties}
        role="tab"
        aria-selected={selected}
        aria-current={active ? "page" : undefined}
        tabIndex={focusedTabId === tab.id || (!focusedTabId && active) ? 0 : -1}
        data-tab-id={tab.id}
        data-group-id={tab.groupId ?? ""}
        data-drop-kind="tab"
        data-drop-index={index}
        {...(paneFlyout?.tabId === tab.id
          ? { "aria-describedby": PANE_FLYOUT_ID }
          : {})}
        onPointerEnter={() => startPaneDwell(tab.id)}
        onPointerLeave={(event) => handleTabPointerLeave(event.relatedTarget)}
        onPointerDown={(event) => {
          /// The row is being clicked or dragged, not read.
          closePaneFlyout();
          // A group drag or reparented row may never deliver its trailing
          // click. Only suppress a click from that gesture, not this new one.
          if (event.button === 0 && event.isPrimary) suppressClickRef.current = false;
          if (event.shiftKey || event.ctrlKey || event.metaKey) return;
          startDrag(event, {
            item: { kind: "tab", id: tab.id },
            containerId: tab.groupId,
            index,
          }, tab.title);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          closePaneFlyout();
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
          if (!(event.target as HTMLElement).closest("button, input, textarea, select, [contenteditable]")) {
            selectTab(event, tab.id);
          }
        }}
        onDoubleClick={(event: MouseEvent<HTMLDivElement>) => {
          if (!event.shiftKey && !event.ctrlKey && !event.metaKey &&
            !(event.target as HTMLElement).closest("button, input, textarea, select, [contenteditable]")) {
            event.preventDefault();
            beginTabRename(tab);
          }
        }}
        onKeyDown={(event) => handleTabKey(event, tab)}
      >
        {glyph ? (
          <span className="sidebar-tab__glyph" aria-hidden="true">{glyph}</span>
        ) : null}
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
          {!ended && tab.activity === "attention" && finishedClock(tab.attentionSince) ? (
            <span
              className="sidebar-tab__badge sidebar-tab__badge--done"
              title={`Finished at ${finishedClock(tab.attentionSince)} and still waiting`}
            >
              {finishedClock(tab.attentionSince)}
            </span>
          ) : null}
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
          aria-label={activityLabel(tab.activity, tab.attentionSince)}
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
            aria-multiselectable="true"
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
    const describing = savedDescribeId === entry.id;
    const editing = renaming || describing;
    const provider = entry.conversation?.provider ?? null;
    const resume = () => {
      if (!editing) {
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
          {describing ? (
            <InlineRename
              value={entry.description ?? ""}
              ariaLabel={`Edit description for ${entry.name}`}
              allowEmpty
              maxLength={200}
              placeholder="Description (empty clears it)"
              onCommit={(value) => {
                saved?.onDescribe(entry.id, value);
                setSavedDescribeId(null);
              }}
              onCancel={() => setSavedDescribeId(null)}
            />
          ) : (
            <span className="sidebar-saved__folder">{folderTail(entry.cwd)}</span>
          )}
        </span>
        {/* Hidden while editing: the editor already owns the row, and a second
            control would duplicate its label. */}
        {editing ? null : (
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
              className="sidebar-saved__action"
              aria-label={`Edit description for ${entry.name}`}
              title="Edit description"
              onClick={(event) => {
                event.stopPropagation();
                setSavedDescribeId(entry.id);
              }}
            >
              ≡
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

  /// One SSH host: the alias it is known by and, muted underneath, where that
  /// alias actually goes. The whole row is the connect affordance, mirroring a
  /// saved row's resume; the key sits in the hover tray, and only when the
  /// password policy allows storing one at all.
  const renderHostRow = (entry: SshHost) => {
    const target = entry.hostName === null
      ? null
      : (entry.user === null ? entry.hostName : `${entry.user}@${entry.hostName}`);
    const stored = hosts?.withPassword?.has(entry.alias) ?? false;
    const connect = () => hosts?.onConnect(entry.alias);
    const setPassword = hosts?.onSetPassword;
    return (
      <div
        key={entry.alias}
        className="sidebar-hosts__row"
        data-testid="host-row"
        data-host-alias={entry.alias}
        role="button"
        tabIndex={0}
        /// What clicking will run — the row is a one-click `ssh <alias>`, and
        /// saying so is how the section explains itself.
        title={`ssh ${entry.alias}`}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button")) {
            return;
          }
          connect();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) {
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            connect();
          }
        }}
      >
        <span className="sidebar-hosts__content">
          <span className="sidebar-hosts__title">
            <span className="sidebar-hosts__alias">{entry.alias}</span>
            {/* Presence only — a stored password is never displayed, anywhere. */}
            {stored ? (
              <span
                className="sidebar-hosts__badge"
                data-testid="host-password-badge"
                title="Password stored"
              >
                pw
              </span>
            ) : null}
          </span>
          {target ? <span className="sidebar-hosts__target">{target}</span> : null}
        </span>
        {setPassword ? (
          <span className="sidebar-hosts__actions">
            <button
              type="button"
              className="sidebar-hosts__action"
              aria-label={`Set password for ${entry.alias}`}
              title={stored ? "Change password…" : "Set password…"}
              onClick={(event) => {
                event.stopPropagation();
                setPassword(entry.alias);
              }}
            >
              🔑
            </button>
          </span>
        ) : null}
      </div>
    );
  };

  /// Like Saved: the section stays while the setting is on even with nothing in
  /// it, because the hint is how a user with no parseable ssh config finds out
  /// where hosts would have come from.
  const hostsSection = hosts?.enabled ? (() => {
    const toggle = hosts.onToggleCollapsed;
    /// Collapsed only counts when the caller can actually store the flip —
    /// otherwise a section could fold with no way back on the next render.
    const collapsed = toggle !== undefined && hosts.collapsed === true;
    const header = toggle === undefined ? (
      <div className="sidebar-hosts__header">
        <span className="sidebar-hosts__label">Hosts</span>
        <span className="sidebar-hosts__count">{hosts.hosts.length}</span>
      </div>
    ) : (
      /// A long inventory is most of the sidebar, so the header is the fold —
      /// a real button, chevron and all, exactly like a tab group's toggle.
      /// The count stays visible while folded: it is what the closed section
      /// still has to say.
      <button
        type="button"
        className="sidebar-hosts__header sidebar-hosts__header--toggle"
        data-testid="hosts-toggle"
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? "Expand" : "Collapse"} hosts`}
        onClick={() => toggle(!collapsed)}
      >
        <span className="sidebar-hosts__chevron" aria-hidden="true">›</span>
        <span className="sidebar-hosts__label">Hosts</span>
        <span className="sidebar-hosts__count">{hosts.hosts.length}</span>
      </button>
    );
    return (
      <section className="sidebar-hosts" data-testid="hosts-section" aria-label="SSH hosts">
        {header}
        {collapsed ? null : (
          hosts.hosts.length === 0 ? (
            <p className="sidebar-hosts__empty">
              Hosts from your SSH config appear here.
            </p>
          ) : (
            <div className="sidebar-hosts__rows">{hosts.hosts.map(renderHostRow)}</div>
          )
        )}
      </section>
    );
  })() : null;

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

  /// Multi-window Phase 1: "Move to new window" plus one entry per OTHER
  /// window. Renders nothing when the action is unwired (legacy callers) —
  /// the sidebar never offers a move it cannot perform.
  const renderWindowEntries = (item: Item) => {
    if (!actions.moveItemToWindow) {
      return null;
    }
    const others = (snapshot.windowIds ?? [MAIN_WINDOW_ID]).filter(
      (id) => id !== windowId,
    );
    return (
      <>
        <button type="button" role="menuitem" onClick={() => {
          actions.moveItemToWindow!(item, "new");
          closeMenu();
        }}>Move to new window</button>
        {others.map((target) => (
          <button
            type="button"
            role="menuitem"
            key={target}
            onClick={() => {
              actions.moveItemToWindow!(item, target);
              closeMenu();
            }}
          >
            Move to {windowLabel(target)}
          </button>
        ))}
      </>
    );
  };

  /// Plugin panels offered as new tabs, under their own overline: built-ins
  /// first, contributions after, the same order the SSH hosts keep. Renders
  /// nothing — heading included — when no plugin is enabled or the action is
  /// unwired, so a sidebar with no plugins is the sidebar as it was.
  const renderPluginTabEntries = (groupId: string | null) => {
    const openPlugin = actions.openPlugin;
    if (!openPlugin || enabledPlugins.length === 0) {
      return null;
    }
    return (
      <>
        <span className="context-menu__group" aria-hidden="true">Plugins</span>
        {enabledPlugins.map((plugin) => (
          <button
            key={plugin.id}
            type="button"
            role="menuitem"
            data-testid={`create-menu-plugin-${plugin.id}`}
            onClick={() => {
              closeMenu();
              openPlugin(plugin.id, "tab", { groupId });
            }}
          >
            <span className="context-menu__glyph" aria-hidden="true">{plugin.icon}</span>
            New {plugin.name} tab{groupId === null ? "" : " in group"}
          </button>
        ))}
      </>
    );
  };

  /// The same panels offered beside an existing pane. Right by default: a
  /// panel is a companion to the terminal it was opened from, and a column
  /// split is the one the user reaches for when they want it below.
  const renderPluginSplitEntries = (tab: SidebarTabModel) => {
    const openPlugin = actions.openPlugin;
    if (!openPlugin || enabledPlugins.length === 0) {
      return null;
    }
    const anchor = anchorPane(tab);
    return (
      <>
        <span className="context-menu__group" aria-hidden="true">Plugins</span>
        {enabledPlugins.map((plugin) => (
          <button
            key={plugin.id}
            type="button"
            role="menuitem"
            data-testid={`tab-menu-plugin-split-${plugin.id}`}
            onClick={() => {
              closeMenu();
              openPlugin(plugin.id, "split", {
                pane: { tabId: tab.id, sessionId: anchor },
              });
            }}
          >
            <span className="context-menu__glyph" aria-hidden="true">{plugin.icon}</span>
            Split with {plugin.name}
          </button>
        ))}
      </>
    );
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
          {renderWindowEntries({ kind: "tab", id: tab.id })}
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
          {renderPluginSplitEntries(tab)}
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
          {renderWindowEntries({ kind: "group", id: group.id })}
          <button type="button" role="menuitem" onClick={() => {
            actions.toggleGroup(group.id);
            closeMenu();
          }}>{group.collapsed ? "Expand" : "Collapse"}</button>
          {renderPluginTabEntries(group.id)}
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
          {renderPluginTabEntries(null)}
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
        {renderPluginTabEntries(null)}
        {/* SSH targets last: they are the exception, a local shell the norm. */}
        {hosts?.menuEnabled && hosts.hosts.length > 0 ? (
          <>
            <span className="context-menu__group" aria-hidden="true">Hosts</span>
            {hosts.hosts.map((entry) => (
              <button
                key={entry.alias}
                type="button"
                role="menuitem"
                data-testid={`create-menu-host-${entry.alias}`}
                onClick={() => {
                  closeMenu();
                  hosts.onConnect(entry.alias);
                }}
              >
                ssh {entry.alias}
              </button>
            ))}
          </>
        ) : null}
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
          {...(conversations.onSaveConversation
            ? { onSaveConversation: conversations.onSaveConversation }
            : {})}
        />
      ) : (
      <>
      <div className="sidebar__scroll" onDoubleClick={onRailDoubleClick}>
        {savedSection}
        {hostsSection}
        <div
          className="sidebar__root"
          role="tablist"
          aria-label="Terminals"
          aria-multiselectable="true"
          data-drop-kind="tab-container"
          data-drop-group-id=""
          data-drop-index={snapshot.rootItems.length}
          data-empty={snapshot.rootItems.length === 0 ? "true" : undefined}
          onDoubleClick={onRailDoubleClick}
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
      {paneFlyout && paneFlyoutTab ? (
        <PaneFlyout
          tabId={paneFlyoutTab.id}
          title={paneFlyoutTab.title}
          panes={paneRowsFor(paneFlyoutTab)}
          anchor={paneFlyout.anchor}
          onDismiss={closePaneFlyout}
        />
      ) : null}
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

function activityLabel(
  activity: SidebarTabModel["activity"],
  attentionSince?: number | null,
): string {
  if (activity === "attention") {
    const at = finishedClock(attentionSince);
    return at === null
      ? "Finished - needs a look"
      : `Finished at ${at} - needs a look`;
  }
  if (activity === "unread") return "Unread output";
  if (activity === "active") return "Terminal active";
  return "No recent output";
}

/**
 * The wall clock the work stopped at, as HH:MM.
 *
 * Deliberately absolute rather than "18m ago": an attentive tab is by
 * definition producing no output, so nothing re-renders the rail while it
 * waits, and a relative label would freeze at the age it had when it was
 * painted — the one number the user is trying to read would be the wrong one.
 */
function finishedClock(at?: number | null): string | null {
  if (at === null || at === undefined || !Number.isFinite(at)) {
    return null;
  }
  const when = new Date(at);
  const hours = String(when.getHours()).padStart(2, "0");
  const minutes = String(when.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
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
