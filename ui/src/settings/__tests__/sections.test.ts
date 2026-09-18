/**
 * Section data is the settings surface's layout contract. The completeness
 * test below is deliberately a guard future batches trip over: add a field to
 * TermxSettings without placing it in a section and this suite fails.
 */

import { describe, expect, it } from "vitest";
import { SETTINGS_SECTIONS } from "../sections";
import { DEFAULT_SETTINGS, type TermxSettings } from "../settings";

describe("SETTINGS_SECTIONS", () => {
  it("lists the nine sections in spec order with their labels", () => {
    expect(SETTINGS_SECTIONS.map((section) => [section.id, section.label])).toEqual([
      ["general", "General"],
      ["appearance", "Appearance"],
      ["terminal", "Terminal"],
      ["groups", "Groups & Tabs"],
      ["conversations", "Conversations"],
      ["chat", "Chat View"],
      ["saved", "Saved sessions"],
      ["ssh", "SSH"],
      ["plugins", "Plugins"],
    ]);
  });

  it("places every settings field in exactly one section", () => {
    const placed = SETTINGS_SECTIONS.flatMap((section) => section.fields);
    const settingsKeys = Object.keys(DEFAULT_SETTINGS) as (keyof TermxSettings)[];

    // No duplicates: a field owned by two sections would render twice.
    expect(new Set(placed).size).toBe(placed.length);
    // No strays: a section may not claim a field that no longer exists.
    for (const field of placed) {
      expect(settingsKeys, `unknown field ${field}`).toContain(field);
    }
    // No orphans: every field must be reachable from the surface.
    for (const key of settingsKeys) {
      expect(placed, `field ${key} is not in any section`).toContain(key);
    }
    expect(placed).toHaveLength(settingsKeys.length);
  });

  it("maps the fields exactly as the spec table does", () => {
    const byId = Object.fromEntries(
      SETTINGS_SECTIONS.map((section) => [section.id, section.fields]),
    );
    expect(byId.general).toEqual([
      "workspaceRoot",
      "updatePolicy",
      "onWindowClose",
      "sleepHiddenTerminals",
    ]);
    expect(byId.appearance).toEqual(["theme", "sideRail", "statusBar"]);
    expect(byId.terminal).toEqual([
      "defaultProfile",
      "terminalFontSize",
      "shellIntegration",
    ]);
    expect(byId.groups).toEqual([
      "newTabPolicy",
      "maxGroupDepth",
      "syncWindowRenameToTab",
    ]);
    expect(byId.conversations).toEqual([
      "conversationsRail",
      "conversationsPalette",
      "summaryEngine",
      "summaryContent",
      "summaryDisplay",
    ]);
    expect(byId.chat).toEqual(["agentPaneDefaultView", "chatDefaultDensity"]);
    expect(byId.saved).toEqual([
      "savedPaneButton",
      "savedSidebarList",
      "savedConversationsRail",
    ]);
    expect(byId.ssh).toEqual([
      "sshHostsSidebar",
      "sshHostsMenu",
      "sshPasswordPolicy",
      "sshEncryptPasswords",
    ]);
    // Plugins is per-plugin state in plugins_v1.json, not TermxSettings, so it
    // owns no fields — the completeness guard above stays satisfied.
    expect(byId.plugins).toEqual([]);
  });

  it("marks Plugins as the one custom-panel section", () => {
    // `panel` is what makes SettingsSurface render a component instead of the
    // field list; a section carrying it by accident would render nothing.
    const custom = SETTINGS_SECTIONS.filter((section) => section.panel !== undefined);
    expect(custom.map((section) => [section.id, section.panel])).toEqual([
      ["plugins", "plugins"],
    ]);
  });
});
