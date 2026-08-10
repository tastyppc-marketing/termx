/**
 * Settings sections as data: the surface's sidebar, its panels, and the
 * completeness guard all read this one list. A new settings field must be
 * placed in exactly one section — `sections.test.ts` fails otherwise.
 */

import type { TermxSettings } from "./settings";

export type SettingsSectionId =
  | "general"
  | "appearance"
  | "terminal"
  | "groups"
  | "conversations"
  | "chat";

export interface SettingsSection {
  readonly id: SettingsSectionId;
  readonly label: string;
  /** Fields this section owns, in the order the panel renders them. */
  readonly fields: readonly (keyof TermxSettings)[];
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "general",
    label: "General",
    fields: ["onWindowClose", "sleepHiddenTerminals"],
  },
  { id: "appearance", label: "Appearance", fields: ["theme"] },
  {
    id: "terminal",
    label: "Terminal",
    fields: ["defaultProfile", "shellIntegration"],
  },
  { id: "groups", label: "Groups & Tabs", fields: ["newTabPolicy", "maxGroupDepth"] },
  {
    id: "conversations",
    label: "Conversations",
    fields: [
      "conversationsRail",
      "conversationsPalette",
      "summaryEngine",
      "summaryContent",
      "summaryDisplay",
    ],
  },
  {
    id: "chat",
    label: "Chat View",
    fields: ["agentPaneDefaultView", "chatDefaultDensity"],
  },
];
