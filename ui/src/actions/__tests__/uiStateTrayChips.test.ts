import { describe, expect, it } from "vitest";
import {
  applyTrayConfigure,
  DEFAULT_UI_STATE,
  parseUiState,
  serializeUiState,
  type UiStateV1,
} from "../../workspace/uiState";

describe("uiState.trayChips", () => {
  it("is absent by default and survives a round-trip as absent", () => {
    expect(DEFAULT_UI_STATE.trayChips).toBeUndefined();
    const parsed = parseUiState(serializeUiState(DEFAULT_UI_STATE));
    expect(parsed).toEqual(DEFAULT_UI_STATE);
    expect(parsed.trayChips).toBeUndefined();
  });

  it("round-trips a configured layout", () => {
    const state: UiStateV1 = {
      ...DEFAULT_UI_STATE,
      trayChips: {
        "sidebar-footer": ["settings", "features"],
        "viewer-header": [],
      },
    };
    const parsed = parseUiState(serializeUiState(state));
    expect(parsed).toEqual(state);
    expect(parsed.trayChips?.["sidebar-footer"]).toEqual(["settings", "features"]);
    expect(parsed.trayChips?.["viewer-header"]).toEqual([]);
    expect(parsed.trayChips?.["pane-toolbar"]).toBeUndefined();
  });

  it("degrades garbage to undefined instead of throwing", () => {
    for (const garbage of ["nope", 7, [], null, true]) {
      const parsed = parseUiState(JSON.stringify({ trayChips: garbage }));
      expect(parsed.trayChips).toBeUndefined();
    }
    expect(parseUiState("{oops").trayChips).toBeUndefined();
  });

  it("drops junk ids, non-array trays, and unknown tray keys", () => {
    const parsed = parseUiState(
      JSON.stringify({
        trayChips: {
          "sidebar-footer": ["keep", "", 42, null, "also"],
          "pane-toolbar": "not-an-array",
          "made-up-tray": ["nope"],
        },
      }),
    );
    expect(parsed.trayChips).toEqual({ "sidebar-footer": ["keep", "also"] });
    expect(
      (parsed.trayChips as Record<string, unknown>)["made-up-tray"],
    ).toBeUndefined();
  });

  it("applyTrayConfigure sets a tray without disturbing the others", () => {
    const first = applyTrayConfigure(DEFAULT_UI_STATE, "sidebar-footer", [
      "settings",
    ]);
    expect(first.trayChips).toEqual({ "sidebar-footer": ["settings"] });

    const second = applyTrayConfigure(first, "viewer-header", ["search"]);
    expect(second.trayChips).toEqual({
      "sidebar-footer": ["settings"],
      "viewer-header": ["search"],
    });
    expect(second.recentFolders).toBe(DEFAULT_UI_STATE.recentFolders);
    expect(second.scopePaths).toBe(DEFAULT_UI_STATE.scopePaths);

    // An emptied tray is a real configuration, not a reset to defaults.
    const emptied = applyTrayConfigure(second, "sidebar-footer", []);
    expect(emptied.trayChips).toEqual({
      "sidebar-footer": [],
      "viewer-header": ["search"],
    });
  });

  it("applyTrayConfigure(null) deletes just that tray's key", () => {
    const configured = applyTrayConfigure(
      applyTrayConfigure(DEFAULT_UI_STATE, "sidebar-footer", ["settings"]),
      "pane-toolbar",
      ["search"],
    );
    const reset = applyTrayConfigure(configured, "sidebar-footer", null);
    expect(reset.trayChips).toEqual({ "pane-toolbar": ["search"] });
    expect(reset.trayChips?.["sidebar-footer"]).toBeUndefined();
  });

  it("applyTrayConfigure drops the whole field once no tray is configured", () => {
    let state = applyTrayConfigure(DEFAULT_UI_STATE, "sidebar-footer", ["settings"]);
    state = applyTrayConfigure(state, "pane-toolbar", ["search"]);
    state = applyTrayConfigure(state, "sidebar-footer", null);
    state = applyTrayConfigure(state, "pane-toolbar", null);

    expect(state.trayChips).toBeUndefined();
    expect("trayChips" in state).toBe(false);
    expect(state).toEqual(DEFAULT_UI_STATE);
    expect(serializeUiState(state)).toBe(serializeUiState(DEFAULT_UI_STATE));
    expect(parseUiState(serializeUiState(state)).trayChips).toBeUndefined();
  });

  it("applyTrayConfigure preserves unrelated fields when clearing the field", () => {
    const extra = { ...DEFAULT_UI_STATE, recentFolders: ["C:\\Dev"] };
    const state = applyTrayConfigure(
      applyTrayConfigure(extra, "viewer-header", ["search"]),
      "viewer-header",
      null,
    );
    expect(state.trayChips).toBeUndefined();
    expect(state.recentFolders).toEqual(["C:\\Dev"]);
  });

  it("applyTrayConfigure is a reference no-op when nothing changes", () => {
    const configured = applyTrayConfigure(DEFAULT_UI_STATE, "sidebar-footer", [
      "settings",
      "search",
    ]);

    // same ids, fresh array
    expect(
      applyTrayConfigure(configured, "sidebar-footer", ["settings", "search"]),
    ).toBe(configured);
    // reset of a tray that was never configured
    expect(applyTrayConfigure(configured, "pane-toolbar", null)).toBe(configured);
    expect(applyTrayConfigure(DEFAULT_UI_STATE, "viewer-header", null)).toBe(
      DEFAULT_UI_STATE,
    );
    // order and content changes are not no-ops
    expect(
      applyTrayConfigure(configured, "sidebar-footer", ["search", "settings"]),
    ).not.toBe(configured);
    expect(applyTrayConfigure(configured, "sidebar-footer", ["settings"])).not.toBe(
      configured,
    );
  });

  it("leaves the rest of the state intact when trayChips is corrupt", () => {
    const parsed = parseUiState(
      JSON.stringify({
        scopePaths: { seeds: { g1: "C:\\Dev" }, active: {} },
        recentFolders: ["C:\\Dev"],
        trayChips: 5,
      }),
    );
    expect(parsed.scopePaths.seeds).toEqual({ g1: "C:\\Dev" });
    expect(parsed.recentFolders).toEqual(["C:\\Dev"]);
    expect(parsed.trayChips).toBeUndefined();
  });
});
