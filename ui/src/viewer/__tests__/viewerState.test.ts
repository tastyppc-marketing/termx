import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEWER_GEOMETRY,
  transitionViewerGeometry,
  VIEWER_MAX_SIZE_PX,
  VIEWER_MIN_SIZE_PX,
  viewerLayoutDirection,
  type ViewerGeometry,
} from "../viewerState";

describe("viewer geometry state machine", () => {
  it("opens hidden viewers with the required right-side default", () => {
    expect(DEFAULT_VIEWER_GEOMETRY).toEqual({
      dock: "right",
      sizePx: 380,
      state: "hidden",
    });

    expect(
      transitionViewerGeometry(DEFAULT_VIEWER_GEOMETRY, { type: "show" }),
    ).toEqual({ dock: "right", sizePx: 380, state: "docked" });
  });

  it("moves through docked, overlay, tray, restored, and hidden states", () => {
    const docked: ViewerGeometry = {
      dock: "bottom",
      sizePx: 340,
      state: "docked",
    };
    const overlay = transitionViewerGeometry(docked, { type: "toggle-overlay" });
    expect(overlay.state).toBe("overlay");
    expect(
      transitionViewerGeometry(overlay, { type: "toggle-overlay" }),
    ).toEqual(docked);

    const tray = transitionViewerGeometry(overlay, { type: "minimize" });
    expect(tray).toEqual({ ...docked, state: "tray" });

    const restored = transitionViewerGeometry(tray, { type: "restore" });
    expect(restored).toEqual(docked);
    expect(transitionViewerGeometry(restored, { type: "close" })).toEqual({
      ...docked,
      state: "hidden",
    });
  });

  it("ignores visibility transitions that do not apply", () => {
    expect(
      transitionViewerGeometry(DEFAULT_VIEWER_GEOMETRY, {
        type: "toggle-overlay",
      }),
    ).toBe(DEFAULT_VIEWER_GEOMETRY);
    expect(
      transitionViewerGeometry(DEFAULT_VIEWER_GEOMETRY, { type: "minimize" }),
    ).toBe(DEFAULT_VIEWER_GEOMETRY);

    const tray: ViewerGeometry = {
      dock: "right",
      sizePx: 380,
      state: "tray",
    };
    expect(
      transitionViewerGeometry(tray, { type: "toggle-overlay" }),
    ).toBe(tray);
    expect(transitionViewerGeometry(tray, { type: "minimize" })).toBe(tray);
  });

  it("updates dock and size with reference-equality no-ops", () => {
    const geometry: ViewerGeometry = {
      dock: "right",
      sizePx: 380,
      state: "docked",
    };

    const bottom = transitionViewerGeometry(geometry, {
      type: "dock",
      dock: "bottom",
    });
    expect(bottom).toEqual({ ...geometry, dock: "bottom" });
    expect(
      transitionViewerGeometry(bottom, { type: "dock", dock: "bottom" }),
    ).toBe(bottom);

    const resized = transitionViewerGeometry(bottom, {
      type: "resize",
      sizePx: 444,
    });
    expect(resized).toEqual({ ...bottom, sizePx: 444 });
    expect(
      transitionViewerGeometry(resized, { type: "resize", sizePx: 444 }),
    ).toBe(resized);
  });

  it("clamps a drag to readable bounds and stops reporting at the edge", () => {
    const geometry: ViewerGeometry = {
      dock: "right",
      sizePx: 380,
      state: "docked",
    };

    const tiny = transitionViewerGeometry(geometry, {
      type: "resize",
      sizePx: -40,
    });
    expect(tiny.sizePx).toBe(VIEWER_MIN_SIZE_PX);
    expect(transitionViewerGeometry(tiny, { type: "resize", sizePx: 10 })).toBe(
      tiny,
    );

    const huge = transitionViewerGeometry(geometry, {
      type: "resize",
      sizePx: 99_000,
    });
    expect(huge.sizePx).toBe(VIEWER_MAX_SIZE_PX);
    expect(
      transitionViewerGeometry(geometry, { type: "resize", sizePx: Number.NaN }),
    ).toEqual({ ...geometry, sizePx: 380 });
  });

  it("maps the dock side to the container direction that reserves space", () => {
    expect(viewerLayoutDirection(DEFAULT_VIEWER_GEOMETRY)).toBe("row");
    expect(
      viewerLayoutDirection({ dock: "bottom", sizePx: 380, state: "docked" }),
    ).toBe("column");
  });
});
