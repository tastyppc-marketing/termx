/**
 * SSH panes in ui-state (ssh-sessions spec §2): which panes are ssh sessions,
 * on which host, and the conversation id last captured in each. Machine-written
 * and per-field tolerant like every other field in this file — a hand-edited or
 * half-written entry degrades, it never throws.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_UI_STATE,
  parseUiState,
  serializeUiState,
  setSshPaneState,
} from "../uiState";

const CLAUDE_ID = "0f4b1c2e-9a77-4d31-8b0e-2c5d6e7f8a90";

describe("ssh pane state in ui-state", () => {
  it("round-trips a host and a captured conversation", () => {
    const stored = setSshPaneState(DEFAULT_UI_STATE, "7", {
      host: "myvps",
      capturedProvider: "claude",
      capturedId: CLAUDE_ID,
    });
    expect(stored.sshPanes).toEqual({
      7: { host: "myvps", capturedProvider: "claude", capturedId: CLAUDE_ID },
    });

    const reloaded = parseUiState(serializeUiState(stored));
    expect(reloaded.sshPanes).toEqual({
      7: { host: "myvps", capturedProvider: "claude", capturedId: CLAUDE_ID },
    });
  });

  it("round-trips a pane with no capture yet", () => {
    const stored = setSshPaneState(DEFAULT_UI_STATE, "7", { host: "myvps" });
    expect(stored.sshPanes).toEqual({ 7: { host: "myvps" } });
    expect(parseUiState(serializeUiState(stored)).sshPanes).toEqual({
      7: { host: "myvps" },
    });
  });

  it("keeps panes apart and returns the same state when nothing changed", () => {
    let state = setSshPaneState(DEFAULT_UI_STATE, "7", { host: "myvps" });
    state = setSshPaneState(state, "8", { host: "other", capturedId: "abc" });
    expect(state.sshPanes).toEqual({
      7: { host: "myvps" },
      8: { host: "other", capturedId: "abc" },
    });
    expect(setSshPaneState(state, "7", { host: "myvps" })).toBe(state);
    expect(
      setSshPaneState(state, "8", { host: "other", capturedId: "abc" }),
    ).toBe(state);
  });

  it("drops one pane on null and the whole field once none are left", () => {
    let state = setSshPaneState(DEFAULT_UI_STATE, "7", { host: "myvps" });
    state = setSshPaneState(state, "8", { host: "other" });

    state = setSshPaneState(state, "7", null);
    expect(state.sshPanes).toEqual({ 8: { host: "other" } });

    state = setSshPaneState(state, "8", null);
    expect(state.sshPanes).toBeUndefined();
    expect("sshPanes" in state).toBe(false);
    // A reset for a pane that was never stored changes nothing.
    expect(setSshPaneState(state, "9", null)).toBe(state);
  });

  it("keeps unrelated fields when the field disappears", () => {
    const withWidth = { ...DEFAULT_UI_STATE, sidebarWidth: 300 };
    const state = setSshPaneState(
      setSshPaneState(withWidth, "7", { host: "myvps" }),
      "7",
      null,
    );
    expect(state.sidebarWidth).toBe(300);
    expect(state.sshPanes).toBeUndefined();
  });

  it("degrades junk entries instead of failing the parse", () => {
    const parsed = parseUiState(
      JSON.stringify({
        sshPanes: {
          "1": { host: "keeper" },
          "2": { host: "" },
          "3": { host: 7 },
          "4": "not an object",
          "5": null,
          "6": {},
        },
      }),
    );
    expect(parsed.sshPanes).toEqual({ 1: { host: "keeper" } });
  });

  it("drops a capture it could not trust, keeping the host", () => {
    const parsed = parseUiState(
      JSON.stringify({
        sshPanes: {
          "1": { host: "a", capturedProvider: "grok", capturedId: "abc" },
          "2": { host: "b", capturedProvider: "claude", capturedId: "../evil" },
          "3": { host: "c", capturedProvider: "claude" },
          "4": { host: "d", capturedId: "abc" },
        },
      }),
    );
    // A half-parsed capture is no capture: the id must be a bare token and the
    // provider one TermX knows, because this id becomes a resume command.
    expect(parsed.sshPanes).toEqual({
      1: { host: "a" },
      2: { host: "b" },
      3: { host: "c" },
      4: { host: "d" },
    });
  });

  it("ignores a field that is not a record of panes", () => {
    expect(parseUiState(JSON.stringify({ sshPanes: [] })).sshPanes).toBeUndefined();
    expect(parseUiState(JSON.stringify({ sshPanes: 7 })).sshPanes).toBeUndefined();
    expect(parseUiState(JSON.stringify({ sshPanes: {} })).sshPanes).toBeUndefined();
  });
});
