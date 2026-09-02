/**
 * The rail's hover preview: what is actually INSIDE a tab.
 *
 * A rail row can only afford one line, so a tab holding three panes reads as
 * one name — and the name of a split tab is the name of the group, not of the
 * work in it. This panel answers "what is in there?" without a click, a focus
 * change, or a layout change: rest the pointer on the row and the panes are
 * named beside it.
 *
 * Presentational and inert on purpose. It has nothing to click, takes no
 * focus, and is described by the row that owns it — the Sidebar owns the dwell
 * timer, the anchor and every dismissal.
 */

import { useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { clampMenuPoint } from "./ContextMenu";
import "./PaneFlyout.css";

/**
 * How long the pointer must rest on a rail row before the panel appears.
 *
 * 800 ms: the platform tooltip delay (Windows ToolTip InitialDelay, 500 ms)
 * plus a deliberate 300 ms margin, which also lands on Chrome's tab hover-card
 * delay — the closest analogue to "hover a tab, see what's in it". Long enough
 * that crossing the rail to reorder rows or reach the terminal does not flash
 * a panel on every pass; short enough that a pause reads as intent without
 * feeling like waiting. (Shipped first at 3000 ms; Michael found that too
 * long.) One constant so the dwell can be retuned in one place.
 */
export const HOVER_PANES_FLYOUT_MS = 800;

/** The id the owning row points at with `aria-describedby`. */
export const PANE_FLYOUT_ID = "sidebar-pane-flyout";

export interface PaneFlyoutPane {
  sessionId: number;
  /** The name this pane wears in its own pane header. */
  name: string;
  /**
   * The folder this pane's shell is standing in. A name is a profile and a
   * folder TAIL, so two panes deep in one repo read almost identically — the
   * path is what separates them.
   *
   * Null or absent draws no second line: a dash in a path's place would read
   * as a path, and "we do not know" is better said with silence.
   */
  cwd?: string | null;
}

export interface PaneFlyoutProps {
  /** The rail row this hangs off — the pointer may travel back into it. */
  tabId: string;
  /** The tab's rail title, heading the panel. */
  title: string;
  panes: readonly PaneFlyoutPane[];
  /** Viewport coordinates of the anchoring row. */
  anchor: { top: number; right: number };
  /** The pointer left both the row and this panel. */
  onDismiss(): void;
}

export function PaneFlyout({ tabId, title, panes, anchor, onDismiss }: PaneFlyoutProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(() =>
    place(anchor, { width: 0, height: 0 }),
  );

  // Measured, then clamped: a row near the bottom of the window would hang its
  // panel off the edge, so the panel rides up until it fits. Deps stay
  // primitive and the update is skipped when nothing moved — `panes` is a
  // fresh array on every parent render, and depending on it would loop.
  useLayoutEffect(() => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const next = place(anchor, rect);
    setPosition((current) =>
      current.x === next.x && current.y === next.y ? current : next,
    );
  }, [anchor.top, anchor.right, panes.length]);

  return (
    <div
      ref={panelRef}
      id={PANE_FLYOUT_ID}
      className="pane-flyout"
      data-pane-flyout=""
      data-testid="pane-flyout"
      role="tooltip"
      style={{ position: "fixed", left: position.x, top: position.y }}
      onPointerLeave={(event: ReactPointerEvent<HTMLDivElement>) => {
        // Travelling back into the owning row is not leaving: the row and the
        // panel share an edge precisely so the pointer can cross between them.
        if (!withinRow(event.relatedTarget, tabId)) {
          onDismiss();
        }
      }}
    >
      <div className="pane-flyout__title">{title}</div>
      <ul className="pane-flyout__list">
        {panes.map((pane) => (
          <li
            key={pane.sessionId}
            className="pane-flyout__pane"
            data-session-id={pane.sessionId}
          >
            <span className="pane-flyout__name">{pane.name}</span>
            {pane.cwd ? (
              // The line ellipsizes from the left, so the whole path stays
              // reachable in the tooltip.
              <span className="pane-flyout__cwd" title={pane.cwd}>
                {pane.cwd}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Top-left corner for the panel: off the row's right edge, kept on screen. */
function place(
  anchor: { top: number; right: number },
  size: { width: number; height: number },
) {
  return clampMenuPoint({ x: anchor.right, y: anchor.top }, size, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
}

function withinRow(target: EventTarget | null, tabId: string): boolean {
  return (
    target instanceof Element &&
    target.closest("[data-tab-id]")?.getAttribute("data-tab-id") === tabId
  );
}
