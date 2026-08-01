import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { SplitDir, SplitNode } from "../state/layout";
import { SleepingPane } from "../terminal/SleepingPane";
import { useSleepingSessions, type SleepController } from "../terminal/sleep";
import type { PaneHostClient, TerminalDimensions } from "../terminal/TerminalPane";
import { TerminalPane } from "../terminal/TerminalPane";
import { canSplitPane } from "../workspace/layoutOperations";
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
  resizePane(path: number[], sizes: [number, number]): void;
}

export interface SplitLayoutProps {
  tabId: string;
  root: SplitNode;
  client: PaneHostClient;
  paneStates: Readonly<Record<number, PaneSessionState>>;
  focusedSessionId: number;
  dismissingSessionIds: ReadonlySet<number>;
  onFocusPane(sessionId: number): void;
  onSessionCwd?: (sessionId: number, path: string, live: boolean) => void;
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
  onFocusPane,
  onSessionCwd,
  actions,
  visible = true,
  sleep,
  sessionDims,
}: SplitLayoutProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DividerDrag | null>(null);
  const dragRef = useRef<DividerDrag | null>(null);
  const [confirmClose, setConfirmClose] = useState<number | null>(null);
  const [closing, setClosing] = useState(false);
  const dialogOpenerRef = useRef<HTMLElement | null>(null);
  const dialogCancelRef = useRef<HTMLButtonElement | null>(null);
  const dialogConfirmRef = useRef<HTMLButtonElement | null>(null);

  const installDrag = (next: DividerDrag | null) => {
    dragRef.current = next;
    setDrag(next);
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
      if (key !== "d" && key !== "e" && key !== "w" && key !== "j") {
        return;
      }
      // Shortcuts stay live inside xterm (its hidden textarea IS the terminal)
      // but must not fire from rename fields, search boxes, or other editors —
      // opening the confirm dialog from a rename would blur-commit it.
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        !active.classList.contains("xterm-helper-textarea") &&
        (active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          active.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const focusedState = paneStates[focusedSessionId] ?? MISSING_PANE;
      if (key === "j") {
        // The focused pane's TerminalPane owns the input marks; route by id.
        window.dispatchEvent(
          new CustomEvent("termx:jump-last-input", {
            detail: { sessionId: focusedSessionId },
          }),
        );
      } else if (key === "w") {
        requestClose(focusedSessionId);
      } else if (focusedState.status === "live") {
        actions.splitPane(focusedSessionId, key === "d" ? "row" : "col");
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

  const rects = useMemo(
    () =>
      computeRects(
        root,
        drag !== null ? { node: drag.node, fraction: drag.fraction } : undefined,
      ),
    [root, drag],
  );

  const paneSessionIds = useMemo(
    () => rects.panes.map((pane) => pane.sessionId),
    [rects],
  );
  const sleepingSessions = useSleepingSessions(sleep, paneSessionIds, visible);

  return (
    <div
      ref={containerRef}
      className="split-layout"
      data-testid={`split-layout-${tabId}`}
      data-pane-count={rects.panes.length}
    >
      {rects.panes.map(({ sessionId, box }) => {
        const state = paneStates[sessionId] ?? MISSING_PANE;
        const focused = sessionId === focusedSessionId;
        const splittable = state.status === "live" && canSplitPane(root, sessionId);
        return (
          <section
            key={sessionId}
            className={`split-pane${focused ? " split-pane--focused" : ""}`}
            style={boxStyle(box)}
            data-testid={`split-pane-${sessionId}`}
            data-session-id={sessionId}
            aria-label={`Terminal pane ${sessionId}`}
            onFocusCapture={() => onFocusPane(sessionId)}
            onPointerDownCapture={() => onFocusPane(sessionId)}
          >
            {state.status === "live" ? (
              <>
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
                    recordedDims={sessionDims?.[sessionId] ?? null}
                    onCwd={(path, live) => onSessionCwd?.(sessionId, path, live)}
                  />
                )}
                <div className="split-pane__toolbar" role="toolbar" aria-label="Pane actions">
                  <button
                    type="button"
                    aria-label="Split right"
                    title={splittable ? "Split right (Ctrl+Shift+D)" : "Split limit reached"}
                    disabled={!splittable}
                    onClick={() => actions.splitPane(sessionId, "row")}
                  >◫</button>
                  <button
                    type="button"
                    aria-label="Split down"
                    title={splittable ? "Split down (Ctrl+Shift+E)" : "Split limit reached"}
                    disabled={!splittable}
                    onClick={() => actions.splitPane(sessionId, "col")}
                  >⊟</button>
                  <button
                    type="button"
                    aria-label="Close pane"
                    title="Close pane (Ctrl+Shift+W)"
                    onClick={() => requestClose(sessionId)}
                  >✕</button>
                </div>
              </>
            ) : (
              <DeadPane
                exitCode={state.exitCode}
                known={state.status === "dead"}
                dismissing={dismissingSessionIds.has(sessionId)}
                onDismiss={() => void actions.dismissPane(sessionId)}
              />
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
            style={dividerStyle(divider)}
            role="separator"
            tabIndex={0}
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
