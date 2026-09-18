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
  | "chat"
  | "saved"
  | "ssh"
  | "plugins";

export interface SettingsSection {
  readonly id: SettingsSectionId;
  readonly label: string;
  /** Fields this section owns, in the order the panel renders them. */
  readonly fields: readonly (keyof TermxSettings)[];
  /**
   * A section whose state is NOT in `TermxSettings` renders a component of its
   * own instead of the field list. Per-plugin enable/paths live in
   * `plugins_v1.json` (spec §7), which the flat settings interface cannot hold,
   * so the surface branches on this marker before mapping `fields`.
   */
  readonly panel?: "plugins";
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "general",
    label: "General",
    fields: ["workspaceRoot", "updatePolicy", "onWindowClose", "sleepHiddenTerminals"],
  },
  {
    id: "appearance",
    label: "Appearance",
    // The two chrome toggles the View menu drives live here, next to the
    // theme: what the window LOOKS like, in one place, however it is reached.
    fields: ["theme", "sideRail", "statusBar"],
  },
  {
    id: "terminal",
    label: "Terminal",
    fields: ["defaultProfile", "terminalFontSize", "shellIntegration"],
  },
  {
    id: "groups",
    label: "Groups & Tabs",
    fields: ["newTabPolicy", "maxGroupDepth", "syncWindowRenameToTab"],
  },
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
  {
    id: "saved",
    label: "Saved sessions",
    fields: ["savedPaneButton", "savedSidebarList", "savedConversationsRail"],
  },
  {
    id: "ssh",
    label: "SSH",
    fields: [
      "sshHostsSidebar",
      "sshHostsMenu",
      "sshPasswordPolicy",
      "sshEncryptPasswords",
    ],
  },
  { id: "plugins", label: "Plugins", fields: [], panel: "plugins" },
];
