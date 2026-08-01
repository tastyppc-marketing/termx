/**
 * The viewer frame: header controls, drag-resize, and the three visible
 * surfaces (docked / overlay / tray) from spec §12. It renders chrome only —
 * `ViewerHost` decides what goes in the body — and holds no state, so the
 * whole surface is a function of the `ViewerGeometry` handed down.
 *
 * Layout rule (§12, the F5 lesson): a docked viewer RESERVES space as a flex
 * sibling and a minimized one reserves a slim strip. Nothing here is
 * positioned over another control; only the overlay covers anything, and that
 * is the point of it.
 */

import {
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { renderMarkdown } from "./markdown";
import {
  VIEWER_MAX_SIZE_PX,
  VIEWER_MIN_SIZE_PX,
  type ViewerGeometry,
} from "./viewerState";
import "./Viewer.css";

export interface ViewerProps {
  /** Short label for the header and the tray pill (file name, session title). */
  label: string;
  /** Tooltip text — the full path, which rarely fits in the header. */
  detail: string;
  geometry: ViewerGeometry;
  onDock(dock: ViewerGeometry["dock"]): void;
  onToggleOverlay(): void;
  onMinimize(): void;
  onRestore(): void;
  onClose(): void;
  onResize(sizePx: number): void;
  children: ReactNode;
}

/** Last path segment, tolerant of either separator and of trailing slashes. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

const RESIZE_STEP_PX = 16;

export function Viewer({
  label,
  detail,
  geometry,
  onDock,
  onToggleOverlay,
  onMinimize,
  onRestore,
  onClose,
  onResize,
  children,
}: ViewerProps) {
  // A drag that outlives the component would keep moving a dead viewer.
  const stopResize = useRef<(() => void) | null>(null);
  useEffect(() => () => stopResize.current?.(), []);

  if (geometry.state === "hidden") {
    return null;
  }

  if (geometry.state === "tray") {
    return (
      <button
        type="button"
        className={`viewer-tray-pill viewer-tray-pill--${geometry.dock}`}
        aria-label={`Restore ${label}`}
        title={detail}
        onClick={onRestore}
      >
        {label}
      </button>
    );
  }

  const docked = geometry.state === "docked";
  const dockedStyle: CSSProperties | undefined = docked
    ? geometry.dock === "right"
      ? { flex: "0 0 auto", width: geometry.sizePx }
      : { flex: "0 0 auto", height: geometry.sizePx }
    : undefined;

  function resizeBy(deltaPx: number): void {
    onResize(geometry.sizePx + deltaPx);
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    stopResize.current?.();
    const startPoint = geometry.dock === "right" ? event.clientX : event.clientY;
    const startSize = geometry.sizePx;
    // Both docks grow when the pointer moves toward the top-left, because the
    // handle sits on the viewer's inner edge in either orientation.
    const move = (moveEvent: PointerEvent): void => {
      const point =
        geometry.dock === "right" ? moveEvent.clientX : moveEvent.clientY;
      onResize(startSize + startPoint - point);
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      stopResize.current = null;
    };
    stopResize.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function handleResizeKey(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const grow = geometry.dock === "right" ? "ArrowLeft" : "ArrowUp";
    const shrink = geometry.dock === "right" ? "ArrowRight" : "ArrowDown";
    if (event.key === grow) {
      event.preventDefault();
      resizeBy(RESIZE_STEP_PX);
    } else if (event.key === shrink) {
      event.preventDefault();
      resizeBy(-RESIZE_STEP_PX);
    }
  }

  const toBottom = geometry.dock === "right";
  const dockLabel = toBottom ? "Dock viewer to bottom" : "Dock viewer to right";
  const overlayLabel =
    geometry.state === "overlay" ? "Return viewer to dock" : "Maximize viewer";

  return (
    <aside
      className={`viewer viewer--${geometry.state} viewer--dock-${geometry.dock}`}
      style={dockedStyle}
      data-viewer-dock={geometry.dock}
      aria-label="File viewer"
    >
      {docked ? (
        <div
          className="viewer__resize-handle"
          role="separator"
          aria-label="Resize viewer"
          aria-orientation={geometry.dock === "right" ? "vertical" : "horizontal"}
          aria-valuemin={VIEWER_MIN_SIZE_PX}
          aria-valuemax={VIEWER_MAX_SIZE_PX}
          aria-valuenow={geometry.sizePx}
          tabIndex={0}
          onPointerDown={beginResize}
          onKeyDown={handleResizeKey}
        />
      ) : null}
      <header className="viewer__header">
        <span className="viewer__filename" title={detail}>
          {label}
        </span>
        <div
          className="viewer__header-actions"
          role="toolbar"
          aria-label="Viewer actions"
          data-tray-id="viewer-header"
        >
          <button
            type="button"
            className="viewer__action"
            aria-label={dockLabel}
            title={dockLabel}
            onClick={() => onDock(toBottom ? "bottom" : "right")}
          >
            <span aria-hidden="true">{toBottom ? "▤" : "▥"}</span>
          </button>
          <button
            type="button"
            className="viewer__action"
            aria-label={overlayLabel}
            title={`${overlayLabel} (Ctrl+Shift+M)`}
            onClick={onToggleOverlay}
          >
            <span aria-hidden="true">
              {geometry.state === "overlay" ? "◲" : "□"}
            </span>
          </button>
          <button
            type="button"
            className="viewer__action"
            aria-label="Minimize viewer"
            title="Minimize viewer"
            onClick={onMinimize}
          >
            <span aria-hidden="true">─</span>
          </button>
          <button
            type="button"
            className="viewer__action viewer__action--close"
            aria-label="Close viewer"
            title="Close viewer"
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </header>
      <div className="viewer__body">{children}</div>
    </aside>
  );
}

export interface FileReadResult {
  content: string;
  truncated: boolean;
}

export interface FileViewProps {
  path: string;
  /** `undefined` while the read is in flight, `null` when it cannot be read. */
  result: FileReadResult | null | undefined;
}

/**
 * File body: markdown gets the renderer, everything else gets honest
 * monospace. A failed read is a one-line notice inside the frame — never a
 * dialog, never a thrown error (spec §12).
 */
export function FileView({ path, result }: FileViewProps): ReactNode {
  if (result === undefined) {
    return <p className="viewer__notice">Loading file…</p>;
  }
  if (result === null) {
    return (
      <p className="viewer__notice">
        This file is missing, binary, or unreadable.
      </p>
    );
  }
  return (
    <>
      {result.truncated ? (
        <div className="viewer__banner" role="status">
          File truncated at 2 MB
        </div>
      ) : null}
      {/\.md$/i.test(path) ? (
        <article className="viewer-markdown">
          {renderMarkdown(result.content)}
        </article>
      ) : (
        <pre className="viewer__plain-text">{result.content}</pre>
      )}
    </>
  );
}
