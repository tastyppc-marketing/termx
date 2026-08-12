import { describe, expect, it } from "vitest";
import {
  DEFAULT_UI_STATE,
  parseUiState,
  serializeUiState,
  setChatPaneState,
} from "../uiState";

describe("chat pane state in ui-state", () => {
  it("round-trips a pane's mode, density and thinking preference", () => {
    const stored = setChatPaneState(DEFAULT_UI_STATE, "7", {
      mode: "chat",
      density: "full",
      showThinking: false,
    });
    expect(stored.chatPanes).toEqual({
      7: { mode: "chat", density: "full", showThinking: false },
    });

    const reloaded = parseUiState(serializeUiState(stored));
    expect(reloaded.chatPanes).toEqual({
      7: { mode: "chat", density: "full", showThinking: false },
    });
  });

  it("keeps panes apart", () => {
    let state = setChatPaneState(DEFAULT_UI_STATE, "7", {
      mode: "chat",
      density: "smart",
      showThinking: true,
    });
    state = setChatPaneState(state, "8", {
      mode: "terminal",
      density: "chips",
      showThinking: false,
    });
    expect(state.chatPanes).toEqual({
      7: { mode: "chat", density: "smart", showThinking: true },
      8: { mode: "terminal", density: "chips", showThinking: false },
    });
  });

  it("returns the same state when nothing changed", () => {
    const state = setChatPaneState(DEFAULT_UI_STATE, "7", {
      mode: "chat",
      density: "smart",
      showThinking: true,
    });
    expect(
      setChatPaneState(state, "7", {
        mode: "chat",
        density: "smart",
        showThinking: true,
      }),
    ).toBe(state);
    expect(setChatPaneState(DEFAULT_UI_STATE, "7", null)).toBe(DEFAULT_UI_STATE);
  });

  it("stores a thinking flip on its own", () => {
    const state = setChatPaneState(DEFAULT_UI_STATE, "7", {
      mode: "chat",
      density: "smart",
      showThinking: true,
    });
    const flipped = setChatPaneState(state, "7", {
      mode: "chat",
      density: "smart",
      showThinking: false,
    });
    expect(flipped).not.toBe(state);
    expect(flipped.chatPanes?.["7"]?.showThinking).toBe(false);
  });

  it("drops a pane's entry, and the whole field once the last one goes", () => {
    let state = setChatPaneState(DEFAULT_UI_STATE, "7", {
      mode: "chat",
      density: "smart",
      showThinking: true,
    });
    state = setChatPaneState(state, "8", {
      mode: "chat",
      density: "full",
      showThinking: true,
    });
    state = setChatPaneState(state, "7", null);
    expect(state.chatPanes).toEqual({
      8: { mode: "chat", density: "full", showThinking: true },
    });
    state = setChatPaneState(state, "8", null);
    expect(state.chatPanes).toBeUndefined();
    expect("chatPanes" in state).toBe(false);
  });

  it("degrades junk to the defaults rather than losing the file", () => {
    const parsed = parseUiState(
      JSON.stringify({
        chatPanes: {
          good: { mode: "chat", density: "full", showThinking: false },
          halfGood: { mode: "chat", density: "sideways", showThinking: "yes" },
          empty: { mode: "nonsense", density: 42, showThinking: 1 },
          notAnObject: "chat",
        },
      }),
    );
    expect(parsed.chatPanes).toEqual({
      good: { mode: "chat", density: "full", showThinking: false },
      halfGood: { mode: "chat", density: "smart", showThinking: true },
    });

    for (const junk of ["[]", '{"chatPanes":[]}', '{"chatPanes":null}', "{}"]) {
      expect(parseUiState(junk).chatPanes).toBeUndefined();
    }
  });

  it("defaults a pre-thinking file to thoughts open", () => {
    const parsed = parseUiState(
      JSON.stringify({ chatPanes: { 7: { mode: "chat", density: "full" } } }),
    );
    expect(parsed.chatPanes).toEqual({
      7: { mode: "chat", density: "full", showThinking: true },
    });
  });

  it("leaves the rest of the ui state alone", () => {
    const withWidth = { ...DEFAULT_UI_STATE, sidebarWidth: 300 };
    const state = setChatPaneState(withWidth, "7", {
      mode: "chat",
      density: "smart",
      showThinking: true,
    });
    expect(state.sidebarWidth).toBe(300);
    expect(setChatPaneState(state, "7", null).sidebarWidth).toBe(300);
  });
});
