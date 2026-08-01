/**
 * Viewer placement, as a pure state machine (spec §12).
 *
 * The host owns no geometry of its own: every surface change goes through
 * `transitionViewerGeometry`, which returns the SAME object when nothing
 * moved. That reference-equality discipline is what lets the caller pipe
 * `onGeometry` straight into `ui_state_v1.json` without debouncing a storm of
 * identical writes, and it matches `uiState.ts`'s own updater contract.
 */

export interface ViewerGeometry {
  dock: "right" | "bottom";
  sizePx: number;
  state: "hidden" | "docked" | "overlay" | "tray";
}

/** Spec §12: docked to the right at 380 px, closed until something opens it. */
export const DEFAULT_VIEWER_GEOMETRY: ViewerGeometry = {
  dock: "right",
  sizePx: 380,
  state: "hidden",
};

/** Drag limits. Below the minimum a markdown line stops being readable. */
export const VIEWER_MIN_SIZE_PX = 240;
export const VIEWER_MAX_SIZE_PX = 1200;

export type ViewerGeometryEvent =
  | { type: "show" }
  | { type: "toggle-overlay" }
  | { type: "minimize" }
  | { type: "restore" }
  | { type: "close" }
  | { type: "dock"; dock: ViewerGeometry["dock"] }
  | { type: "resize"; sizePx: number };

function clampSize(sizePx: number): number {
  if (!Number.isFinite(sizePx)) {
    return DEFAULT_VIEWER_GEOMETRY.sizePx;
  }
  return Math.min(VIEWER_MAX_SIZE_PX, Math.max(VIEWER_MIN_SIZE_PX, Math.round(sizePx)));
}

/**
 * Apply one surface event. Transitions that do not apply to the current state
 * (minimizing a hidden viewer, restoring a docked one) are no-ops and return
 * the input object unchanged.
 */
export function transitionViewerGeometry(
  geometry: ViewerGeometry,
  event: ViewerGeometryEvent,
): ViewerGeometry {
  switch (event.type) {
    case "show":
      // Opening a second file while maximized keeps the reading surface.
      return geometry.state === "hidden" || geometry.state === "tray"
        ? { ...geometry, state: "docked" }
        : geometry;
    case "toggle-overlay":
      if (geometry.state === "docked") {
        return { ...geometry, state: "overlay" };
      }
      if (geometry.state === "overlay") {
        return { ...geometry, state: "docked" };
      }
      return geometry;
    case "minimize":
      return geometry.state === "docked" || geometry.state === "overlay"
        ? { ...geometry, state: "tray" }
        : geometry;
    case "restore":
      return geometry.state === "tray"
        ? { ...geometry, state: "docked" }
        : geometry;
    case "close":
      return geometry.state === "hidden"
        ? geometry
        : { ...geometry, state: "hidden" };
    case "dock":
      // Dock side survives minimize/close: the pill and the next open reuse it.
      return geometry.dock === event.dock
        ? geometry
        : { ...geometry, dock: event.dock };
    case "resize": {
      const sizePx = clampSize(event.sizePx);
      return geometry.sizePx === sizePx ? geometry : { ...geometry, sizePx };
    }
  }
}

/**
 * Flex direction the container holding [terminal area, viewer] must use for
 * the docked viewer to RESERVE space instead of covering the terminal
 * (§12 layout rule). Exported so the App can wire the slot without knowing
 * the viewer's internals.
 */
export function viewerLayoutDirection(
  geometry: ViewerGeometry,
): "row" | "column" {
  return geometry.dock === "right" ? "row" : "column";
}
