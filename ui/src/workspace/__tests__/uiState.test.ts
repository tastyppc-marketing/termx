/**
 * `uiState.updates`: what the updater remembers across launches. "Later" on
 * an optional update stores the snoozed version; a host-changing install
 * leaves `pendingHostRestart` behind so the next launch knows to finish the
 * job. Parsed per field, like everything else in this file: junk drops the
 * field, never the file.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_UI_STATE,
  parseUiState,
  serializeUiState,
  setPendingHostRestart,
  setUpdateSnooze,
  type UiStateV1,
} from "../uiState";

describe("uiState.updates", () => {
  it("stays absent by default and after a round-trip", () => {
    expect(DEFAULT_UI_STATE.updates).toBeUndefined();
    const parsed = parseUiState(serializeUiState(DEFAULT_UI_STATE));
    expect("updates" in parsed).toBe(false);
  });

  it("round-trips every field without disturbing other state", () => {
    const state: UiStateV1 = {
      ...DEFAULT_UI_STATE,
      recentFolders: ["C:\\Dev"],
      hostsCollapsed: true,
      updates: { lastCheckAt: 1_700_000_000_000, snoozedVersion: "0.3.0", pendingHostRestart: true },
    };
    const parsed = parseUiState(serializeUiState(state));
    expect(parsed).toEqual(state);
  });

  it("drops junk per field and drops the record when nothing survives", () => {
    const parsed = parseUiState(JSON.stringify({
      recentFolders: [],
      updates: { lastCheckAt: "yesterday", snoozedVersion: "0.3.0", pendingHostRestart: "yes" },
    }));
    expect(parsed.updates).toEqual({ snoozedVersion: "0.3.0" });

    for (const updates of [null, "0.3.0", 7, [], { lastCheckAt: Infinity }, { snoozedVersion: "" },
      { snoozedVersion: "x".repeat(33) }, { pendingHostRestart: false }]) {
      const dropped = parseUiState(JSON.stringify({ recentFolders: [], updates }));
      expect("updates" in dropped, JSON.stringify(updates)).toBe(false);
    }
  });

  it("setUpdateSnooze stores the version and returns the same state for a repeat", () => {
    const snoozed = setUpdateSnooze(DEFAULT_UI_STATE, "0.3.0");
    expect(snoozed.updates).toEqual({ snoozedVersion: "0.3.0" });
    expect(setUpdateSnooze(snoozed, "0.3.0")).toBe(snoozed);
    const withOther: UiStateV1 = { ...DEFAULT_UI_STATE, updates: { lastCheckAt: 5 } };
    expect(setUpdateSnooze(withOther, "0.4.0").updates).toEqual({ lastCheckAt: 5, snoozedVersion: "0.4.0" });
  });

  it("setPendingHostRestart stores only true and deletes the field when cleared", () => {
    const pending = setPendingHostRestart(DEFAULT_UI_STATE, true);
    expect(pending.updates).toEqual({ pendingHostRestart: true });
    expect(setPendingHostRestart(pending, true)).toBe(pending);
    const cleared = setPendingHostRestart(pending, false);
    expect("updates" in cleared).toBe(false);
    expect(setPendingHostRestart(DEFAULT_UI_STATE, false)).toBe(DEFAULT_UI_STATE);
    const mixed = setPendingHostRestart({ ...DEFAULT_UI_STATE, updates: { snoozedVersion: "0.3.0", pendingHostRestart: true } }, false);
    expect(mixed.updates).toEqual({ snoozedVersion: "0.3.0" });
  });
});
