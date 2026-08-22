/**
 * `uiState.hostsCollapsed`: the Hosts section's folded/unfolded state, which
 * has to survive a restart — that is the whole point of collapsing a section
 * that "takes too much space".
 *
 * Only `true` is ever stored. Expanded is both the default and the state of a
 * machine that has never touched the header, so it round-trips as an absent
 * field rather than a stored `false`.
 */

import { describe, expect, it } from "vitest";
import {
  applyTrayConfigure,
  DEFAULT_UI_STATE,
  parseUiState,
  serializeUiState,
  setHostsCollapsed,
  type UiStateV1,
} from "../uiState";

describe("uiState.hostsCollapsed", () => {
  it("stays absent by default and after a round-trip", () => {
    expect(DEFAULT_UI_STATE.hostsCollapsed).toBeUndefined();

    const parsed = parseUiState(serializeUiState(DEFAULT_UI_STATE));

    expect(parsed).toEqual(DEFAULT_UI_STATE);
    expect("hostsCollapsed" in parsed).toBe(false);
  });

  it("round-trips a collapse across a restart without disturbing other state", () => {
    const state: UiStateV1 = {
      ...DEFAULT_UI_STATE,
      recentFolders: ["C:\\Dev"],
      hostsCollapsed: true,
    };

    const parsed = parseUiState(serializeUiState(state));

    expect(parsed).toEqual(state);
    expect(parsed.hostsCollapsed).toBe(true);
    expect(parsed.recentFolders).toEqual(["C:\\Dev"]);
  });

  it("drops anything but a literal true, per field", () => {
    const malformed = [false, null, "true", 1, [], {}];

    for (const hostsCollapsed of malformed) {
      const parsed = parseUiState(
        JSON.stringify({
          recentFolders: ["C:\\Dev"],
          trayChips: { "viewer-header": ["viewer-close"] },
          hostsCollapsed,
        }),
      );

      expect(parsed.hostsCollapsed).toBeUndefined();
      expect(parsed.recentFolders).toEqual(["C:\\Dev"]);
      expect(parsed.trayChips).toEqual({ "viewer-header": ["viewer-close"] });
    }
  });

  it("toggles, and no-ops by reference when the header reports what is stored", () => {
    const collapsed = setHostsCollapsed(DEFAULT_UI_STATE, true);

    expect(collapsed).not.toBe(DEFAULT_UI_STATE);
    expect(collapsed.hostsCollapsed).toBe(true);
    expect(setHostsCollapsed(collapsed, true)).toBe(collapsed);
    expect(setHostsCollapsed(DEFAULT_UI_STATE, false)).toBe(DEFAULT_UI_STATE);
  });

  it("clears the field on expand so the default state round-trips", () => {
    const collapsed = setHostsCollapsed(
      applyTrayConfigure(DEFAULT_UI_STATE, "viewer-header", ["viewer-close"]),
      true,
    );
    expect(collapsed.hostsCollapsed).toBe(true);

    const expanded = setHostsCollapsed(collapsed, false);

    expect("hostsCollapsed" in expanded).toBe(false);
    expect(expanded.hostsCollapsed).toBeUndefined();
    expect(expanded.trayChips).toEqual({ "viewer-header": ["viewer-close"] });
    expect("hostsCollapsed" in parseUiState(serializeUiState(expanded))).toBe(false);
  });
});
