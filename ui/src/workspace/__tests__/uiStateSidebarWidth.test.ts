/**
 * `uiState.sidebarWidth` (polish P5): tolerant parse, clamped on the way in
 * AND on the way out, `null` resets to the default by dropping the field.
 */

import { describe, expect, it } from "vitest";
import {
  applyTrayConfigure,
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  DEFAULT_UI_STATE,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  parseUiState,
  serializeUiState,
  setSidebarWidth,
  type UiStateV1,
} from "../uiState";

describe("uiState.sidebarWidth", () => {
  it("stays absent by default and after a round-trip", () => {
    expect(DEFAULT_UI_STATE.sidebarWidth).toBeUndefined();
    expect(DEFAULT_SIDEBAR_WIDTH).toBe(260);

    const parsed = parseUiState(serializeUiState(DEFAULT_UI_STATE));

    expect(parsed).toEqual(DEFAULT_UI_STATE);
    expect("sidebarWidth" in parsed).toBe(false);
  });

  it("round-trips a stored width without disturbing unrelated state", () => {
    const state: UiStateV1 = {
      ...DEFAULT_UI_STATE,
      recentFolders: ["C:\\Dev"],
      sidebarWidth: 320,
    };

    const parsed = parseUiState(serializeUiState(state));

    expect(parsed).toEqual(state);
    expect(parsed.recentFolders).toEqual(["C:\\Dev"]);
  });

  it("clamps an out-of-range stored width instead of dropping it", () => {
    expect(parseUiState(JSON.stringify({ sidebarWidth: 40 })).sidebarWidth)
      .toBe(MIN_SIDEBAR_WIDTH);
    expect(parseUiState(JSON.stringify({ sidebarWidth: 9000 })).sidebarWidth)
      .toBe(MAX_SIDEBAR_WIDTH);
    expect(parseUiState(JSON.stringify({ sidebarWidth: 300.6 })).sidebarWidth)
      .toBe(301);
  });

  it("drops a non-numeric width per field while preserving unrelated state", () => {
    const malformed = [null, "320", [], {}, true, Number.NaN, Number.POSITIVE_INFINITY];

    for (const sidebarWidth of malformed) {
      const parsed = parseUiState(
        JSON.stringify({
          recentFolders: ["C:\\Dev"],
          trayChips: { "viewer-header": ["viewer-close"] },
          sidebarWidth,
        }),
      );

      expect(parsed.sidebarWidth).toBeUndefined();
      expect(parsed.recentFolders).toEqual(["C:\\Dev"]);
      expect(parsed.trayChips).toEqual({ "viewer-header": ["viewer-close"] });
    }
  });

  it("clamps on write and no-ops by reference for an unchanged report", () => {
    expect(clampSidebarWidth(10)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(1000)).toBe(MAX_SIDEBAR_WIDTH);

    const stored = setSidebarWidth(DEFAULT_UI_STATE, 900);

    expect(stored).not.toBe(DEFAULT_UI_STATE);
    expect(stored.sidebarWidth).toBe(MAX_SIDEBAR_WIDTH);
    expect(setSidebarWidth(stored, MAX_SIDEBAR_WIDTH)).toBe(stored);
    expect(setSidebarWidth(stored, 12).sidebarWidth).toBe(MIN_SIDEBAR_WIDTH);
    expect(setSidebarWidth(stored, Number.NaN)).toBe(stored);
  });

  it("clears the field on null so the sidebar falls back on the default", () => {
    const stored = setSidebarWidth(
      applyTrayConfigure(DEFAULT_UI_STATE, "viewer-header", ["viewer-close"]),
      340,
    );
    expect(stored.sidebarWidth).toBe(340);

    const cleared = setSidebarWidth(stored, null);

    expect("sidebarWidth" in cleared).toBe(false);
    expect(cleared.sidebarWidth).toBeUndefined();
    expect(cleared.trayChips).toEqual({ "viewer-header": ["viewer-close"] });
    expect(setSidebarWidth(cleared, null)).toBe(cleared);
    expect("sidebarWidth" in parseUiState(serializeUiState(cleared))).toBe(false);
  });
});
