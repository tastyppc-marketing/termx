/**
 * Section data is the settings surface's layout contract. The completeness
 * test below is deliberately a guard future batches trip over: add a field to
 * TermxSettings without placing it in a section and this suite fails.
 */

import { describe, expect, it } from "vitest";
import { SETTINGS_SECTIONS } from "../sections";
import { DEFAULT_SETTINGS, type TermxSettings } from "../settings";

describe("SETTINGS_SECTIONS", () => {
  it("lists the seven sections in spec order with their labels", () => {
    expect(SETTINGS_SECTIONS.map((section) => [section.id, section.label])).toEqual([
      ["general", "General"],
      ["appearance", "Appearance"],
      ["terminal", "Terminal"],
      ["groups", "Groups & Tabs"],
      ["conversations", "Conversations"],
      ["chat", "Chat View"],
      ["saved", "Saved sessions"],
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
    expect(byId.general).toEqual(["onWindowClose", "sleepHiddenTerminals"]);
    expect(byId.appearance).toEqual(["theme"]);
    expect(byId.terminal).toEqual(["defaultProfile", "shellIntegration"]);
    expect(byId.groups).toEqual(["newTabPolicy", "maxGroupDepth"]);
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
  });
});
