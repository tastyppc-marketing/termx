import { describe, expect, it } from "vitest";
import {
  applyTrayConfigure,
  DEFAULT_UI_STATE,
  parseUiState,
  serializeUiState,
  setViewerGeometry,
  type UiStateV1,
} from "../../workspace/uiState";

describe("uiState.viewerGeometry", () => {
  it("stays absent by default and after a round-trip", () => {
    expect(DEFAULT_UI_STATE.viewerGeometry).toBeUndefined();

    const parsed = parseUiState(serializeUiState(DEFAULT_UI_STATE));

    expect(parsed).toEqual(DEFAULT_UI_STATE);
    expect("viewerGeometry" in parsed).toBe(false);
  });

  it("round-trips valid viewer geometry without disturbing tray chips", () => {
    const state: UiStateV1 = {
      ...DEFAULT_UI_STATE,
      trayChips: { "viewer-header": ["viewer-close"] },
      viewerGeometry: { dock: "bottom", sizePx: 420, state: "overlay" },
    };

    const parsed = parseUiState(serializeUiState(state));

    expect(parsed).toEqual(state);
    expect(parsed.trayChips).toEqual({ "viewer-header": ["viewer-close"] });
  });

  it("drops malformed geometry per field while preserving unrelated state", () => {
    const malformed = [
      null,
      [],
      "bottom",
      { dock: "left", sizePx: 380, state: "docked" },
      { dock: "right", sizePx: "380", state: "docked" },
      { dock: "right", sizePx: 0, state: "docked" },
      { dock: "right", sizePx: 380, state: "maximized" },
    ];

    for (const viewerGeometry of malformed) {
      const parsed = parseUiState(
        JSON.stringify({
          recentFolders: ["C:\\Dev"],
          trayChips: { "viewer-header": ["viewer-close"] },
          viewerGeometry,
        }),
      );

      expect(parsed.viewerGeometry).toBeUndefined();
      expect(parsed.recentFolders).toEqual(["C:\\Dev"]);
      expect(parsed.trayChips).toEqual({ "viewer-header": ["viewer-close"] });
    }
  });

  it("stores geometry with a reference-equality no-op for an unchanged report", () => {
    const stored = setViewerGeometry(DEFAULT_UI_STATE, {
      dock: "right",
      sizePx: 380,
      state: "docked",
    });

    expect(stored).not.toBe(DEFAULT_UI_STATE);
    expect(stored.viewerGeometry).toEqual({
      dock: "right",
      sizePx: 380,
      state: "docked",
    });
    expect(
      setViewerGeometry(stored, { dock: "right", sizePx: 380, state: "docked" }),
    ).toBe(stored);
    expect(
      setViewerGeometry(stored, { dock: "right", sizePx: 420, state: "docked" })
        .viewerGeometry?.sizePx,
    ).toBe(420);
  });

  it("survives a tray reset that drops the whole trayChips field", () => {
    const configured = applyTrayConfigure(
      setViewerGeometry(DEFAULT_UI_STATE, {
        dock: "bottom",
        sizePx: 300,
        state: "tray",
      }),
      "viewer-header",
      ["viewer-close"],
    );
    expect(configured.trayChips).toEqual({ "viewer-header": ["viewer-close"] });

    const reset = applyTrayConfigure(configured, "viewer-header", null);

    expect("trayChips" in reset).toBe(false);
    expect(reset.viewerGeometry).toEqual({
      dock: "bottom",
      sizePx: 300,
      state: "tray",
    });
  });
});
