import { describe, expect, it } from "vitest";
import {
  DEFAULT_UI_STATE,
  parseUiState,
  serializeUiState,
  setChatPaneState,
} from "../uiState";

describe("chat pane state in ui-state", () => {
  it("round-trips a pane's mode and density", () => {
    const stored = setChatPaneState(DEFAULT_UI_STATE, "7", {
      mode: "chat",
      density: "full",
    });
    expect(stored.chatPanes).toEqual({ 7: { mode: "chat", density: "full" } });

    const reloaded = parseUiState(serializeUiState(stored));
    expect(reloaded.chatPanes).toEqual({ 7: { mode: "chat", density: "full" } });
  });

  it("keeps panes apart", () => {
    let state = setChatPaneState(DEFAULT_UI_STATE, "7", {
      mode: "chat",
      density: "smart",
    });
    state = setChatPaneState(state, "8", { mode: "terminal", density: "chips" });
    expect(state.chatPanes).toEqual({
      7: { mode: "chat", density: "smart" },
      8: { mode: "terminal", density: "chips" },
    });
  });

  it("returns the same state when nothing changed", () => {
    const state = setChatPaneState(DEFAULT_UI_STATE, "7", {
      mode: "chat",
      density: "smart",
    });
    expect(
      setChatPaneState(state, "7", { mode: "chat", density: "smart" }),
    ).toBe(state);
    expect(setChatPaneState(DEFAULT_UI_STATE, "7", null)).toBe(DEFAULT_UI_STATE);
  });

  it("drops a pane's entry, and the whole field once the last one goes", () => {
    let state = setChatPaneState(DEFAULT_UI_STATE, "7", {
      mode: "chat",
      density: "smart",
    });
    state = setChatPaneState(state, "8", { mode: "chat", density: "full" });
    state = setChatPaneState(state, "7", null);
    expect(state.chatPanes).toEqual({ 8: { mode: "chat", density: "full" } });
    state = setChatPaneState(state, "8", null);
    expect(state.chatPanes).toBeUndefined();
    expect("chatPanes" in state).toBe(false);
  });

  it("degrades junk to the defaults rather than losing the file", () => {
    const parsed = parseUiState(
      JSON.stringify({
        chatPanes: {
          good: { mode: "chat", density: "full" },
          halfGood: { mode: "chat", density: "sideways" },
          empty: { mode: "nonsense", density: 42 },
          notAnObject: "chat",
        },
      }),
    );
    expect(parsed.chatPanes).toEqual({
      good: { mode: "chat", density: "full" },
      halfGood: { mode: "chat", density: "smart" },
    });

    for (const junk of ["[]", '{"chatPanes":[]}', '{"chatPanes":null}', "{}"]) {
      expect(parseUiState(junk).chatPanes).toBeUndefined();
    }
  });

  it("leaves the rest of the ui state alone", () => {
    const withWidth = { ...DEFAULT_UI_STATE, sidebarWidth: 300 };
    const state = setChatPaneState(withWidth, "7", {
      mode: "chat",
      density: "smart",
    });
    expect(state.sidebarWidth).toBe(300);
    expect(setChatPaneState(state, "7", null).sidebarWidth).toBe(300);
  });
});
