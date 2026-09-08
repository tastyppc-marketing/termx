import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  DEFAULT_PLUGIN_MIN_SIZE,
  minSizeOf,
  type PluginManifest,
} from "../plugins/manifest";
import { PluginPane } from "../plugins/PluginPane";
import { InlineRename } from "../sidebar/InlineRename";
import type { SplitDir, SplitNode } from "../state/layout";
import { SleepingPane } from "../terminal/SleepingPane";
import { useSleepingSessions, type SleepController } from "../terminal/sleep";
import type {
  ConversationCaptureReporter,
  PaneHostClient,
  TerminalDimensions,
} from "../terminal/TerminalPane";
import { TerminalPane } from "../terminal/TerminalPane";
import { canSplitPane } from "../workspace/layoutOperations";
import type { PaneActivityModel } from "../workspace/paneActivity";
import type { PaneSessionState } from "../workspace/WorkspaceController";
import { DeadPane } from "./DeadPane";
import { dividerFraction, sizesFromFraction } from "./splitMath";
import {
  computeRects,
  pathToSplitNode,
  type DividerRect,
  type FractionBox,
  type SplitBranch,
} from "./splitRects";
import "./SplitLayout.css";

export interface SplitLayoutActions {
  splitPane(paneSessionId: number, dir: SplitDir): void;
  closePane(paneSessionId: number): void | Promise<void>;
  dismissPane(paneSessionId: number): void | Promise<void>;
  /**
   * Dead-pane relaunch: "restart" reuses the dead session's profile + cwd,
   * "fresh" launches workspace defaults, both in this pane's slot.
   */
  restartPane(paneSessionId: number, mode: "restart" | "fresh" | "resume"): void | Promise<void>;
  /** Title of the conversation a dead pane's Resume would bring back, or
   * null/absent for none — gates the DeadPane's Resume button. */
  deadPaneResumeTitle?(paneSessionId: number): string | null;
  resizePane(path: number[], sizes: [number, number]): void;
  /** Spec §16: extract this pane into its own tab. Absent hides the chip. */
  popOutPane?(paneSessionId: number): void;
  /**
   * Saved sessions: pin this pane's session (name + folder + linked
   * conversation) so it can be resumed later. Absent hides the button, which
   * is how the `savedPaneButton` setting turns the surface off.
   */
  savePane?(paneSessionId: number): void;
  /**
   * A plugin pane's Relaunch: re-run the plugin's ensure-up, keeping the pane
   * and its binding. Deliberately NOT `restartPane`, which would create a host
   * session and swap the reserved id out of the layout — the panel would
   * become a terminal. Optional so every pre-plugin fixture type-checks.
   */
  relaunchPlugin?(paneSessionId: number): void | Promise<void>;
}

export interface SplitLayoutProps {
  tabId: string;
  root: SplitNode;
  client: PaneHostClient;
  paneStates: Readonly<Record<number, PaneSessionState>>;
  focusedSessionId: number;
  dismissingSessionIds: ReadonlySet<number>;
  /** Dead panes with a relaunch in flight; defaults to none. */
  restartingSessionIds?: ReadonlySet<number>;
  onFocusPane(sessionId: number): void;
  /** Session activity for minimized restore chips; viewing siblings does not acknowledge it. */
  paneActivity?: Readonly<Record<number, PaneActivityModel>>;
  /** Panes actually on screen, excluding minimized/maximized-away panes and hidden tabs. */
  onVisiblePanesChange?: (sessionIds: readonly number[]) => void;
  onSessionCwd?: (sessionId: number, path: string, live: boolean) => void;
  /** OSC 9;77 deliverable report (polish P4); fires for live output only. */
  onSessionOutput?: (sessionId: number, path: string) => void;
  /** A pane's terminal rang its bell (attention wiring). */
  onSessionBell?: (sessionId: number) => void;
  /** Remote conversation-id capture from an SSH pane (ssh-sessions spec §2). */
  onConversationCaptured?: ConversationCaptureReporter;
  actions: SplitLayoutActions;
  /**
   * Whether this layout's tab is on screen. Panes of a visible layout NEVER
   * sleep. Defaults to true, so a caller that does not track tab visibility
   * keeps every pane awake.
   */
  visible?: boolean;
  /**
   * Window-wide sleep state (spec §13). Without it nothing sleeps. The layout
   * only REPORTS its panes' visibility here and reads the verdict back.
   */
  sleep?: SleepController | null;
  /**
   * Host-recorded cols/rows per session (SessionInfo), used to size a
   * terminal before replay on every attach.
   */
  sessionDims?: Readonly<Record<number, TerminalDimensions>>;
  /**
   * Open the host's spilled scrollback for a session, from `beforeOffset`
   * backward. Absent hides the earlier-output bar entirely.
   */
  onLoadEarlier?: (sessionId: number, beforeOffset: bigint) => void;
  /**
   * Display name per pane for the pane title bars. Panes in a split share one
   * tab title, so the tab cannot tell them apart; absent titles simply render
   * no bar.
   */
  paneTitles?: Readonly<Record<number, string>>;
  /**
   * Name the terminal in a pane (Michael: "I want to change the terminal
   * name"). Absent leaves the title bars as plain labels, which is what every
   * caller that has nowhere to put a name wants.
   *
   * Double-click only, deliberately: F2 inside a terminal belongs to whatever
   * TUI is running in it, and claiming it would break `less`, `htop` and every
   * file manager for a rename nobody asked to reach that way.
   */
  onRenamePane?: (sessionId: number, name: string) => void;
  /**
   * Manifest lookup for plugin panes — their name, icon and panel path all come
   * from it. Absent (or null for an id) renders the pane as the dismissible
   * dead pane instead: a binding whose plugin is no longer installed degrades
   * exactly the way an older build's unreadable binding does (spec §4).
   */
  pluginManifestFor?: (pluginId: string) => PluginManifest | null;
  /** Terminal text size in px for every pane (settings.terminalFontSize). */
  fontSize?: number;
  /** Ctrl+wheel zoom from any pane: +1 in, -1 out (App clamps and persists). */
  onFontSizeWheel?: (delta: 1 | -1) => void;
}

interface DividerDrag {
  pointerId: number;
  /// The dragged split node BY REFERENCE — a concurrent structural change can
  /// alias a positional path onto a different split, so preview and commit
  /// both resolve through this node instead.
  node: SplitBranch;
  dir: SplitDir;
  box: FractionBox;
  fraction: number;
  /// The capturing divider element, so Escape can release pointer capture.
  element: HTMLElement;
}

const MISSING_PANE: PaneSessionState = { status: "missing", exitCode: null };
const KEYBOARD_RESIZE_STEP = 0.02;

/// Renders the active tab's layout_v1 split tree as one flat container of
/// absolutely-positioned panes (see computeRects for why flat), with 6px
/// divider hit areas between siblings. Divider drags preview locally and
/// commit through actions.resizePane ONLY on release (persistence rule 4).
/// Split/close shortcuts listen on window capture so xterm's textarea never
/// swallows them.
export function SplitLayout({
  tabId,
  root,
  client,
  paneStates,
  focusedSessionId,
  dismissingSessionIds,
  restartingSessionIds,
  onFocusPane,
  paneActivity,
  onVisiblePanesChange,
  onSessionCwd,
  onSessionOutput,
  onSessionBell,
  onConversationCaptured,
  actions,
  visible = true,
  sleep,
  sessionDims,
  onLoadEarlier,
  paneTitles,
  onRenamePane,
  pluginManifestFor,
  fontSize,
  onFontSizeWheel,
}: SplitLayoutProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DividerDrag | null>(null);
  const dragRef = useRef<DividerDrag | null>(null);
  const [confirmClose, setConfirmClose] = useState<number | null>(null);
  /// The pane whose title bar is currently an editor, if any.
  const [renaming, setRenaming] = useState<number | null>(null);
  const [closing, setClosing] = useState(false);
  // Maximize is local presentation, never a replacement for the saved tree.
  // Keeping the pane sections mounted preserves terminal and iframe state.
  const [maximizedSessionId, setMaximizedSessionId] = useState<number | null>(null);
  // Freeze each minimized pane at its last measured size. Its terminal or
  // iframe stays mounted and attached even as siblings and the shelf resize.
  const [minimizedPanes, setMinimizedPanes] = useState<ReadonlyMap<number, CSSProperties>>(
    () => new Map(),
  );
  const pendingFocusRef = useRef<number | null>(null);
  const dialogOpenerRef = useRef<HTMLElement | null>(null);
  const dialogCancelRef = useRef<HTMLButtonElement | null>(null);
  const dialogConfirmRef = useRef<HTMLButtonElement | null>(null);

  const installDrag = (next: DividerDrag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const cancelActiveDrag = () => {
    const current = dragRef.current;
    if (current) {
      try {
        current.element.releasePointerCapture(current.pointerId);
      } catch {
        // Capture may already be gone.
      }
      installDrag(null);
    }
  };

  const revealPane = (sessionId: number) => {
    setMinimizedPanes((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });
  };

  const maximizePane = (sessionId: number) => {
    cancelActiveDrag();
    revealPane(sessionId);
    onFocusPane(sessionId);
    setMaximizedSessionId(sessionId);
  };

  const restoreSplit = (focusContents = false) => {
    if (focusContents) pendingFocusRef.current = maximizedSessionId;
    setMaximizedSessionId(null);
  };

  const splitPane = (sessionId: number, dir: SplitDir) => {
    restoreSplit();
    actions.splitPane(sessionId, dir);
  };

  const minimizePane = (sessionId: number) => {
    const remaining = paneSessionIds.filter((id) => id !== sessionId && !minimizedIds.has(id));
    if (remaining.length === 0 || minimizedIds.has(sessionId)) return;
    const pane = containerRef.current?.querySelector<HTMLElement>(`[data-session-id='${sessionId}']`);
    const measured = pane?.getBoundingClientRect();
    cancelActiveDrag();
    setMinimizedPanes((current) => new Map(current).set(sessionId, {
      left: 0, top: 0, width: measured?.width ?? 0, height: measured?.height ?? 0,
      visibility: "hidden", pointerEvents: "none",
    }));
    setMaximizedSessionId(null);
    const nextFocus = remaining.includes(focusedSessionId) ? focusedSessionId : remaining[0];
    pendingFocusRef.current = nextFocus;
    onFocusPane(nextFocus);
  };

  const restorePane = (sessionId: number) => {
    cancelActiveDrag();
    revealPane(sessionId);
    pendingFocusRef.current = sessionId;
    onFocusPane(sessionId);
    if (maximized) setMaximizedSessionId(sessionId);
  };

  const requestClose = (sessionId: number) => {
    const state = paneStates[sessionId] ?? MISSING_PANE;
    if (state.status === "live") {
      dialogOpenerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setConfirmClose(sessionId);
    } else {
      void actions.dismissPane(sessionId);
    }
  };

  useEffect(() => {
    if (confirmClose !== null) {
      dialogCancelRef.current?.focus();
    } else if (dialogOpenerRef.current?.isConnected) {
      dialogOpenerRef.current.focus();
      dialogOpenerRef.current = null;
    }
  }, [confirmClose]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      // Every tab's layout stays mounted for the sleep lifecycle (spec §13),
      // and each mounts this window listener — only the on-screen layout may
      // act on shortcuts, or a hidden tab would split/close its own panes.
      if (!visible) {
        return;
      }
      if (event.key === "Escape") {
        const current = dragRef.current;
        if (current) {
          try {
            current.element.releasePointerCapture(current.pointerId);
          } catch {
            // Capture may already be gone.
          }
          installDrag(null);
        }
        return;
      }
      if (confirmClose !== null) {
        return;
      }
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key !== "d" && key !== "e" && key !== "w" && key !== "j" && key !== "enter") {
        return;
      }
      if (key === "enter" && paneSessionIds.length < 2) return;
      // Shortcuts stay live inside xterm (its hidden textarea IS the terminal)
      // but must not fire from rename fields, search boxes, or other editors —
      // opening the confirm dialog from a rename would blur-commit it.
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.closest("[role='dialog'], [data-esc-guard]") ||
          (!active.classList.contains("xterm-helper-textarea") &&
            (active instanceof HTMLInputElement ||
              active instanceof HTMLTextAreaElement ||
              active.isContentEditable)))
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // Holding the shortcut must neither toggle repeatedly nor leak Enter
      // into xterm, where the repeated key could submit unfinished input.
      if (key === "enter" && event.repeat) return;
      const focusedState = paneStates[focusedSessionId] ?? MISSING_PANE;
      if (key === "enter") {
        if (maximizedSessionId === null) maximizePane(focusedSessionId);
        else restoreSplit(active instanceof HTMLElement && !!active.closest(".split-maximized-bar"));
      } else if (key === "j") {
        // The focused pane's TerminalPane owns the input marks; route by id.
        window.dispatchEvent(
          new CustomEvent("termx:jump-last-input", {
            detail: { sessionId: focusedSessionId },
          }),
        );
      } else if (key === "w") {
        requestClose(focusedSessionId);
      } else if (focusedState.status === "live") {
        splitPane(focusedSessionId, key === "d" ? "row" : "col");
      }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  });

  const beginDividerDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    divider: DividerRect,
  ) => {
    if (event.button !== 0 || !event.isPrimary) {
      return;
    }
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Environments without pointer capture still get move/up on the element.
    }
    installDrag({
      pointerId: event.pointerId,
      node: divider.node,
      dir: divider.dir,
      box: divider.box,
      fraction: divider.sizes[0],
      element: event.currentTarget,
    });
  };

  const moveDividerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    const container = containerRef.current;
    if (!current || current.pointerId !== event.pointerId || !container) {
      return;
    }
    const rect = container.getBoundingClientRect();
    const fraction =
      current.dir === "row"
        ? dividerFraction(
            event.clientX,
            rect.left + current.box.left * rect.width,
            current.box.width * rect.width,
          )
        : dividerFraction(
            event.clientY,
            rect.top + current.box.top * rect.height,
            current.box.height * rect.height,
          );
    installDrag({ ...current, fraction });
  };

  const releaseCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Capture may already be gone.
    }
  };

  const finishDividerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) {
      return;
    }
    releaseCapture(event);
    installDrag(null);
    // Resolve the node's CURRENT path at release: if the tree changed
    // mid-drag the commit follows the dragged split, and if that split is
    // gone the drag is discarded rather than resizing whatever now sits at
    // the stale path.
    const path = pathToSplitNode(root, current.node);
    if (path !== null) {
      actions.resizePane(path, sizesFromFraction(current.fraction));
    }
  };

  const cancelDividerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) {
      return;
    }
    releaseCapture(event);
    installDrag(null);
  };

  const nudgeDivider = (divider: DividerRect, direction: -1 | 1) => {
    const first = Math.min(Math.max(divider.sizes[0] + direction * KEYBOARD_RESIZE_STEP, 0.1), 0.9);
    actions.resizePane(divider.path, sizesFromFraction(first));
  };

  const allRects = useMemo(() => computeRects(root), [root]);
  const paneSessionIds = useMemo(
    () => allRects.panes.map((pane) => pane.sessionId),
    [allRects],
  );
  const minimizedIds = useMemo(() => {
    const ids = new Set(paneSessionIds.filter((id) => minimizedPanes.has(id)));
    // A remote close can remove the last visible pane. Reveal one survivor
    // immediately, before effects, so a tab never renders an empty workspace.
    if (ids.size === paneSessionIds.length) {
      ids.delete(paneSessionIds.includes(focusedSessionId) ? focusedSessionId : paneSessionIds[0]);
    }
    return ids;
  }, [paneSessionIds, minimizedPanes, focusedSessionId]);
  const rects = useMemo(
    () =>
      computeRects(
        root,
        drag !== null ? { node: drag.node, fraction: drag.fraction } : undefined,
        minimizedIds,
      ),
    [root, drag, minimizedIds],
  );
  const projectedBoxes = useMemo(
    () => new Map(rects.panes.map((pane) => [pane.sessionId, pane.box])),
    [rects],
  );
  const sleepingSessions = useSleepingSessions(sleep, paneSessionIds, visible);
  const previousPaneIdsRef = useRef(paneSessionIds);
  const maximized = maximizedSessionId !== null && paneSessionIds.length > 1 &&
    paneSessionIds.includes(maximizedSessionId) && paneSessionIds.includes(focusedSessionId) &&
    !minimizedIds.has(maximizedSessionId);

  useEffect(() => {
    // Prune removed IDs and permanently reveal the fallback survivor. This
    // prevents a future split/restart from reviving old minimization state.
    setMinimizedPanes((current) => {
      if (current.size === minimizedIds.size) return current;
      return new Map([...current].filter(([id]) => minimizedIds.has(id)));
    });
  }, [minimizedIds]);

  useEffect(() => {
    if (minimizedPanes.has(focusedSessionId)) {
      cancelActiveDrag();
      pendingFocusRef.current = focusedSessionId;
      revealPane(focusedSessionId);
    }
    // Only a changed focus request reveals a minimized pane. Activity and
    // unrelated parent renders must never acknowledge or restore one.
  }, [focusedSessionId]);

  useEffect(() => {
    if (paneSessionIds.includes(focusedSessionId)) return;
    const survivor = rects.panes[0]?.sessionId;
    if (survivor === undefined) return;
    pendingFocusRef.current = survivor;
    onFocusPane(survivor);
  }, [focusedSessionId, paneSessionIds]);

  const visibleKey = !visible ? "" : maximized
    ? String(maximizedSessionId) : rects.panes.map((pane) => pane.sessionId).join(",");
  const visibleIds = useMemo(() => visibleKey === "" ? [] : visibleKey.split(",").map(Number), [visibleKey]);
  useEffect(() => {
    onVisiblePanesChange?.(visibleIds);
  }, [visibleIds, onVisiblePanesChange]);

  useEffect(() => {
    const addedPane = paneSessionIds.some((id) => !previousPaneIdsRef.current.includes(id));
    previousPaneIdsRef.current = paneSessionIds;
    if (maximizedSessionId !== null && maximizedSessionId !== focusedSessionId &&
        !addedPane && paneSessionIds.includes(maximizedSessionId) &&
        paneSessionIds.includes(focusedSessionId)) {
      // App may have tried to focus this pane while it was still inert. Focus
      // its contents after the selected section has actually been revealed.
      pendingFocusRef.current = focusedSessionId;
    }
    setMaximizedSessionId((current) => {
      if (current === null) return null;
      // A close/restart or a layout received from another window may remove
      // the selected pane. Reveal the resulting tree instead of hiding it.
      if (addedPane || paneSessionIds.length < 2 || !paneSessionIds.includes(current) ||
          !paneSessionIds.includes(focusedSessionId)) return null;
      return focusedSessionId;
    });
  }, [focusedSessionId, paneSessionIds]);

  useEffect(() => {
    const sessionId = pendingFocusRef.current;
    if (!visible || sessionId === null || minimizedIds.has(sessionId) ||
        (maximizedSessionId !== null && maximizedSessionId !== sessionId)) return;
    pendingFocusRef.current = null;
    const pane = containerRef.current?.querySelector<HTMLElement>(
      `[data-session-id='${sessionId}']`,
    );
    const contents = pane?.querySelector<HTMLElement>(
      ".xterm-helper-textarea, iframe, .dead-pane__action, .plugin-pane__action",
    );
    (contents ?? pane)?.focus();
  }, [maximizedSessionId, minimizedIds, focusedSessionId, visible]);

  const paneLabel = (sessionId: number) => {
    const state = paneStates[sessionId];
    if (state?.status === "plugin" && state.pluginId) {
      return pluginManifestFor?.(state.pluginId)?.name ?? state.pluginId;
    }
    return paneTitles?.[sessionId] || `Pane ${sessionId}`;
  };

  return (
    <div
      className="split-layout"
      data-testid={`split-layout-${tabId}`}
      data-pane-count={paneSessionIds.length}
      data-maximized={maximized || undefined}
    >
      {maximized ? (
        <div className="split-maximized-bar" aria-label="Maximized pane controls">
          <span className="split-maximized-bar__label">Maximized</span>
          <select
            aria-label="Switch pane"
            title="Switch pane"
            value={maximizedSessionId}
            onChange={(event) => {
              const sessionId = Number(event.currentTarget.value);
              pendingFocusRef.current = sessionId;
              maximizePane(sessionId);
            }}
          >
            {paneSessionIds.map((sessionId) => (
              <option key={sessionId} value={sessionId}>{paneLabel(sessionId)}</option>
            ))}
          </select>
          <button
            type="button"
            aria-label="Restore split view"
            title="Restore split view (Ctrl+Shift+Enter)"
            onClick={() => restoreSplit(true)}
          >Restore split view</button>
        </div>
      ) : null}
      <div className="split-layout__panes" ref={containerRef}>
      {allRects.panes.map(({ sessionId, box }) => {
        const state = paneStates[sessionId] ?? MISSING_PANE;
        const focused = sessionId === focusedSessionId;
        const splittable = state.status === "live" && canSplitPane(root, sessionId);
        // A bound plugin pane is ALWAYS a panel, manifest or no manifest. The
        // manifest only dresses it: without one there is no display name, icon
        // or panel path, and the pane falls back to its plugin id and its
        // origin's root. It must never fall through to DeadPane — DeadPane
        // offers Restart / New session, and `restartPane` creates a host
        // session and swaps the reserved id out of the layout, which destroys
        // the binding and turns the panel into a terminal (spec §4). The
        // dead-pane path is for a reserved id with NO binding, which the
        // controller already projects as "missing".
        const plugin = state.status === "plugin";
        const manifest =
          plugin && state.pluginId !== undefined
            ? pluginManifestFor?.(state.pluginId) ?? null
            : null;
        const minimized = minimizedIds.has(sessionId);
        const hidden = minimized || (maximized && sessionId !== maximizedSessionId);
        const minimizeButton = paneSessionIds.length > 1 ? (
          <button
            type="button"
            aria-label="Minimize pane"
            title={minimizedIds.size < paneSessionIds.length - 1 ? "Minimize pane" : "Keep at least one pane visible"}
            disabled={minimizedIds.size >= paneSessionIds.length - 1}
            onClick={() => minimizePane(sessionId)}
          >−</button>
        ) : null;
        const maximizeButton = paneSessionIds.length > 1 ? (
          <button
            type="button"
            aria-label={maximized ? "Restore split view" : "Maximize pane"}
            title={maximized ? "Restore split view (Ctrl+Shift+Enter)" : "Maximize pane (Ctrl+Shift+Enter)"}
            aria-pressed={maximized && sessionId === maximizedSessionId}
            onClick={() => maximized ? restoreSplit() : maximizePane(sessionId)}
          >{maximized ? "▧" : "⛶"}</button>
        ) : null;
        return (
          <section
            key={sessionId}
            className={`split-pane${focused ? " split-pane--focused" : ""}`}
            style={minimized ? minimizedPanes.get(sessionId) : hidden ? { display: "none" } : maximized
              ? boxStyle({ left: 0, top: 0, width: 1, height: 1 }) : boxStyle(projectedBoxes.get(sessionId) ?? box)}
            data-testid={`split-pane-${sessionId}`}
            data-session-id={sessionId}
            aria-hidden={hidden || undefined}
            inert={hidden}
            tabIndex={-1}
            aria-label={
              plugin
                ? `${manifest?.name ?? state.pluginId ?? "Plugin"} pane`
                : `Terminal pane ${sessionId}`
            }
            onFocusCapture={() => { if (!hidden) onFocusPane(sessionId); }}
            onPointerDownCapture={() => { if (!hidden) onFocusPane(sessionId); }}
          >
            {state.status === "live" ? (
              <>
                {paneTitles?.[sessionId] ? (
                  renaming === sessionId && onRenamePane ? (
                    // Esc belongs to the editor while it is open - the same
                    // claim the window name and the settings surface make, so
                    // cancelling a rename never also closes a menu behind it.
                    <div
                      className="split-pane__title split-pane__title--editing"
                      data-testid={`split-pane-rename-${sessionId}`}
                      data-esc-guard=""
                    >
                      <InlineRename
                        value={paneTitles[sessionId]}
                        ariaLabel="Name this terminal"
                        onCommit={(value) => {
                          setRenaming(null);
                          onRenamePane(sessionId, value);
                        }}
                        onCancel={() => setRenaming(null)}
                      />
                    </div>
                  ) : (
                    <div
                      className="split-pane__title"
                      data-testid={`split-pane-title-${sessionId}`}
                      title={paneTitles[sessionId]}
                      {...(onRenamePane
                        ? { onDoubleClick: () => setRenaming(sessionId) }
                        : {})}
                    >
                      {paneTitles[sessionId]}
                    </div>
                  )
                ) : null}
                {sleepingSessions.has(sessionId) ? (
                  // Presentation + attachment released by unmounting the pane;
                  // the host session itself keeps running untouched.
                  <SleepingPane
                    sessionId={sessionId}
                    onWake={() => sleep?.wake(sessionId)}
                  />
                ) : (
                  <TerminalPane
                    client={client}
                    sessionId={sessionId}
                    suspended={state.suspended ?? false}
                    attachGeneration={state.attachGeneration ?? 0}
                    historyBefore={state.historyBefore ?? 0n}
                    {...(onLoadEarlier
                      ? {
                        onLoadEarlier: (beforeOffset: bigint) =>
                          onLoadEarlier(sessionId, beforeOffset),
                      }
                      : {})}
                    recordedDims={sessionDims?.[sessionId] ?? null}
                    onCwd={(path, live) => onSessionCwd?.(sessionId, path, live)}
                    onOutput={(path) => onSessionOutput?.(sessionId, path)}
                    onBell={() => onSessionBell?.(sessionId)}
                    {...(onConversationCaptured
                      ? { onConversationCaptured }
                      : {})}
                    {...(fontSize !== undefined ? { fontSize } : {})}
                    {...(onFontSizeWheel ? { onFontSizeWheel } : {})}
                  />
                )}
                <div className="split-pane__toolbar" role="toolbar" aria-label="Pane actions">
                  {minimizeButton}
                  {maximizeButton}
                  <button
                    type="button"
                    aria-label="Split right"
                    title={splittable ? "Split right (Ctrl+Shift+D)" : "Split limit reached"}
                    disabled={!splittable}
                    onClick={() => splitPane(sessionId, "row")}
                  >◫</button>
                  <button
                    type="button"
                    aria-label="Split down"
                    title={splittable ? "Split down (Ctrl+Shift+E)" : "Split limit reached"}
                    disabled={!splittable}
                    onClick={() => splitPane(sessionId, "col")}
                  >⊟</button>
                  {actions.popOutPane && root.kind === "split" ? (
                    <button
                      type="button"
                      aria-label="Pop out to own tab"
                      title="Pop out to own tab"
                      onClick={() => actions.popOutPane?.(sessionId)}
                    >⇱</button>
                  ) : null}
                  {actions.savePane ? (
                    <button
                      type="button"
                      data-testid="pane-save"
                      aria-label="Save this session"
                      title="Save this session…"
                      onClick={() => actions.savePane?.(sessionId)}
                    >⚑</button>
                  ) : null}
                  <button
                    type="button"
                    aria-label="Close pane"
                    title="Close pane (Ctrl+Shift+W)"
                    onClick={() => requestClose(sessionId)}
                  >✕</button>
                </div>
              </>
            ) : plugin ? (
              <>
                <PluginPane
                  state={state}
                  name={manifest?.name ?? state.pluginId ?? "Plugin"}
                  icon={manifest?.icon ?? "?"}
                  panelPath={manifest?.panel.path ?? "/"}
                  minSize={
                    manifest === null ? DEFAULT_PLUGIN_MIN_SIZE : minSizeOf(manifest)
                  }
                  onRelaunch={() => void actions.relaunchPlugin?.(sessionId)}
                  onDismiss={() => void actions.dismissPane(sessionId)}
                />
                {/* A panel has no shell to end and cannot be split.
                    `requestClose` dismisses it directly, with no dialog. */}
                <div className="split-pane__toolbar" role="toolbar" aria-label="Pane actions">
                  {minimizeButton}
                  {maximizeButton}
                  <button
                    type="button"
                    aria-label="Close pane"
                    title="Close pane (Ctrl+Shift+W)"
                    onClick={() => requestClose(sessionId)}
                  >✕</button>
                </div>
              </>
            ) : (
              <>
              <DeadPane
                exitCode={state.exitCode}
                known={state.status === "dead"}
                dismissing={dismissingSessionIds.has(sessionId)}
                restarting={restartingSessionIds?.has(sessionId) ?? false}
                resumeTitle={actions.deadPaneResumeTitle?.(sessionId) ?? null}
                onDismiss={() => void actions.dismissPane(sessionId)}
                onRestart={() => void actions.restartPane(sessionId, "restart")}
                onResume={() => void actions.restartPane(sessionId, "resume")}
                onNewSession={() => void actions.restartPane(sessionId, "fresh")}
              />
              {maximizeButton || minimizeButton ? (
                <div className="split-pane__toolbar" role="toolbar" aria-label="Pane actions">
                  {minimizeButton}
                  {maximizeButton}
                </div>
              ) : null}
              </>
            )}
          </section>
        );
      })}
      {rects.dividers.map((divider) => {
        const dragging = drag !== null && drag.node === divider.node;
        const first = dragging ? drag.fraction : divider.sizes[0];
        const testId = `split-divider-${divider.path.join("-") || "root"}`;
        return (
          <div
            key={testId}
            className={[
              "split-divider",
              `split-divider--${divider.dir}`,
              dragging ? "split-divider--dragging" : "",
            ].filter(Boolean).join(" ")}
            style={maximized ? { display: "none" } : dividerStyle(divider)}
            role="separator"
            tabIndex={maximized ? -1 : 0}
            aria-hidden={maximized || undefined}
            inert={maximized}
            aria-orientation={divider.dir === "row" ? "vertical" : "horizontal"}
            aria-label="Resize panes"
            aria-valuenow={Math.round(first * 100)}
            aria-valuemin={10}
            aria-valuemax={90}
            data-testid={testId}
            onPointerDown={(event) => beginDividerDrag(event, divider)}
            onPointerMove={moveDividerDrag}
            onPointerUp={finishDividerDrag}
            onPointerCancel={cancelDividerDrag}
            onKeyDown={(event) => {
              const grow = divider.dir === "row" ? "ArrowRight" : "ArrowDown";
              const shrink = divider.dir === "row" ? "ArrowLeft" : "ArrowUp";
              if (event.key === grow || event.key === shrink) {
                event.preventDefault();
                nudgeDivider(divider, event.key === grow ? 1 : -1);
              }
            }}
          />
        );
      })}
      </div>
      {minimizedIds.size > 0 ? (
        <div className="split-minimized-shelf" role="toolbar" aria-label="Minimized panes">
          <span className="split-minimized-shelf__label">Minimized</span>
          {paneSessionIds.filter((id) => minimizedIds.has(id)).map((sessionId) => {
            const activity = paneActivity?.[sessionId];
            const status = paneActivityLabel(activity);
            const label = paneLabel(sessionId);
            return (
              <button
                key={sessionId}
                type="button"
                className="split-minimized-shelf__chip"
                data-testid={`restore-pane-${sessionId}`}
                aria-label={`Restore ${label} — ${status}`}
                title={`Restore ${label} — ${status}`}
                onClick={() => restorePane(sessionId)}
              >
                <span className="split-minimized-shelf__activity" data-activity={activity?.activity ?? "idle"} aria-hidden="true" />
                <span className="split-minimized-shelf__name">{label}</span>
                {activity?.activity === "attention" ? (
                  <span className="split-minimized-shelf__finished">{status.replace(" — needs a look", "")}</span>
                ) : null}
                <span aria-hidden="true">↗</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {confirmClose !== null ? (
        <div className="split-dialog-backdrop">
          <div
            className="split-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Close pane"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !closing) {
                event.stopPropagation();
                setConfirmClose(null);
              } else if (event.key === "Tab") {
                event.preventDefault();
                const target = document.activeElement === dialogCancelRef.current
                  ? dialogConfirmRef.current
                  : dialogCancelRef.current;
                target?.focus();
              }
            }}
          >
            <h2>Close pane?</h2>
            <p>Close this pane and end its running shell?</p>
            <div className="split-dialog__actions">
              <button
                ref={dialogCancelRef}
                type="button"
                disabled={closing}
                onClick={() => setConfirmClose(null)}
              >
                Cancel
              </button>
              <button
                ref={dialogConfirmRef}
                type="button"
                className="split-dialog__danger"
                disabled={closing}
                onClick={() => {
                  const sessionId = confirmClose;
                  setClosing(true);
                  void Promise.resolve(actions.closePane(sessionId)).finally(() => {
                    setClosing(false);
                    setConfirmClose(null);
                  });
                }}
              >
                {closing ? "Closing…" : "Close pane"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function paneActivityLabel(state: PaneActivityModel | undefined): string {
  if (state?.activity === "attention") {
    const at = state.attentionSince;
    if (at !== null && Number.isFinite(at)) {
      const when = new Date(at);
      const clock = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
      return `Finished at ${clock} — needs a look`;
    }
    return "Finished — needs a look";
  }
  if (state?.activity === "unread") return "Unread output";
  if (state?.activity === "active") return "Terminal active";
  return "No recent output";
}

function boxStyle(box: FractionBox): CSSProperties {
  return {
    left: `${box.left * 100}%`,
    top: `${box.top * 100}%`,
    width: `${box.width * 100}%`,
    height: `${box.height * 100}%`,
  };
}

function dividerStyle(divider: DividerRect): CSSProperties {
  if (divider.dir === "row") {
    return {
      left: `calc(${divider.position * 100}% - 3px)`,
      top: `${divider.box.top * 100}%`,
      height: `${divider.box.height * 100}%`,
      width: "6px",
    };
  }
  return {
    top: `calc(${divider.position * 100}% - 3px)`,
    left: `${divider.box.left * 100}%`,
    width: `${divider.box.width * 100}%`,
    height: "6px",
  };
}
