/**
 * TermX user settings: types, defaults, tolerant parsing.
 *
 * Settings persist as `settings_v1.json` in the app data dir. Parsing is
 * per-field tolerant (layout parse-gate philosophy): a malformed file yields
 * defaults for the broken fields and the file is NOT rewritten until the user
 * actually changes a setting — a parser bug must never destroy the file.
 */

import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from "../theme/themes";

export const NEW_TAB_POLICIES = [
  "group-active",
  "active-tab",
  "first-terminal",
  "ask-searcher",
  "ask-native",
] as const;

export type NewTabPolicy = (typeof NEW_TAB_POLICIES)[number];

export const DEFAULT_PROFILES = ["powershell", "cmd"] as const;

export type DefaultProfile = (typeof DEFAULT_PROFILES)[number];

export const SUMMARY_ENGINES = ["disk-first", "disk-only", "llm"] as const;

export type SummaryEngine = (typeof SUMMARY_ENGINES)[number];

export const SUMMARY_CONTENTS = ["summary", "recap", "both", "none"] as const;

export type SummaryContent = (typeof SUMMARY_CONTENTS)[number];

export const SUMMARY_DISPLAYS = ["hover", "under-title"] as const;

export type SummaryDisplay = (typeof SUMMARY_DISPLAYS)[number];

export const SLEEP_OPTIONS = ["off", "5", "15", "60"] as const;

export type SleepOption = (typeof SLEEP_OPTIONS)[number];

export const CLOSE_BEHAVIORS = ["ask", "keep-running", "stop-all"] as const;

export type CloseBehavior = (typeof CLOSE_BEHAVIORS)[number];

/** 1 = flat (the pre-nesting behavior). The parse cap is 8 regardless. */
export const MAX_GROUP_DEPTH_OPTIONS = [1, 2, 3, 4, 5] as const;

export type MaxGroupDepthOption = (typeof MAX_GROUP_DEPTH_OPTIONS)[number];

export const AGENT_PANE_VIEWS = ["terminal", "chat"] as const;

export type AgentPaneView = (typeof AGENT_PANE_VIEWS)[number];

export const CHAT_DENSITIES = ["chips", "smart", "full"] as const;

export type ChatDensity = (typeof CHAT_DENSITIES)[number];

/** "never" is keys/agent-only mode: TermX stores and uses no passwords at all. */
export const SSH_PASSWORD_POLICIES = ["store", "never"] as const;

export type SshPasswordPolicy = (typeof SSH_PASSWORD_POLICIES)[number];

export interface TermxSettings {
  /** Where a plain "new tab" opens. Default: follow the group's CDs. */
  readonly newTabPolicy: NewTabPolicy;
  /** Inject the OSC 9;9 prompt hook into spawned shells (cd tracking). */
  readonly shellIntegration: boolean;
  /** Profile used when a create action doesn't name one. */
  readonly defaultProfile: DefaultProfile;
  /** Show the sidebar's Terminals | Conversations mode switch. */
  readonly conversationsRail: boolean;
  /** Enable the Ctrl+Shift+R session palette. */
  readonly conversationsPalette: boolean;
  /** Where session summaries/recaps come from: disk, disk+LLM gap-fill, or LLM. */
  readonly summaryEngine: SummaryEngine;
  /** Which note kind(s) a conversation row shows. */
  readonly summaryContent: SummaryContent;
  /** Whether the note shows on hover or as a line under the title. */
  readonly summaryDisplay: SummaryDisplay;
  /** Minutes a hidden terminal may sit idle before its presentation sleeps. */
  readonly sleepHiddenTerminals: SleepOption;
  /** What happens to running sessions when the TermX window closes. */
  readonly onWindowClose: CloseBehavior;
  /** How deep sidebar groups may be nested by creation or drag. */
  readonly maxGroupDepth: MaxGroupDepthOption;
  /**
   * Whether renaming a WINDOW also renames that window's active rail tab.
   *
   * Off by design, not by caution. A window name is a label over the two or
   * three panes it holds — a group name — while a rail tab names one terminal.
   * Tying them together would overwrite the tab's own identity every time the
   * group is labelled, which is the opposite of what the name is for.
   */
  readonly syncWindowRenameToTab: boolean;
  /** Colour theme. Applies live — no restart, no confirmation. */
  readonly theme: ThemeId;
  /** Which view an agent pane opens in: the raw terminal or the chat view. */
  readonly agentPaneDefaultView: AgentPaneView;
  /** How much of each chat message the chat view shows by default. */
  readonly chatDefaultDensity: ChatDensity;
  /** Show the save (pin) button in the split-pane floating toolbar. */
  readonly savedPaneButton: boolean;
  /** Show the Saved section at the top of the sidebar. */
  readonly savedSidebarList: boolean;
  /** Offer a save action on conversation rows in the Conversations rail. */
  readonly savedConversationsRail: boolean;
  /** Show the Hosts section (from `~/.ssh/config`) in the sidebar. */
  readonly sshHostsSidebar: boolean;
  /** Offer the same hosts as connect targets in the new-terminal menu. */
  readonly sshHostsMenu: boolean;
  /** Whether TermX may store SSH passwords at all. */
  readonly sshPasswordPolicy: SshPasswordPolicy;
  /** Encrypt stored passwords at rest (Windows DPAPI, no passphrase). */
  readonly sshEncryptPasswords: boolean;
  /** Terminal text size in px. Ctrl+scroll over any pane adjusts it live. */
  readonly terminalFontSize: number;
  /**
   * Show the side rail (the sidebar with tabs, groups, plugins and hosts).
   *
   * A View-menu toggle rather than a hidden trick, and on by default: the
   * rail is how a workspace is navigated, so hiding it is a deliberate
   * "give me the whole window for one terminal" move, never a default.
   */
  readonly sideRail: boolean;
  /** Show the status bar along the bottom (cwd, profile, ssh host). */
  readonly statusBar: boolean;
}

export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;

export const DEFAULT_SETTINGS: TermxSettings = {
  newTabPolicy: "group-active",
  shellIntegration: true,
  defaultProfile: "powershell",
  conversationsRail: true,
  conversationsPalette: true,
  summaryEngine: "disk-first",
  summaryContent: "summary",
  summaryDisplay: "hover",
  sleepHiddenTerminals: "15",
  onWindowClose: "ask",
  maxGroupDepth: 3,
  syncWindowRenameToTab: false,
  theme: DEFAULT_THEME_ID,
  agentPaneDefaultView: "terminal",
  chatDefaultDensity: "smart",
  savedPaneButton: true,
  savedSidebarList: true,
  savedConversationsRail: false,
  sshHostsSidebar: true,
  sshHostsMenu: true,
  sshPasswordPolicy: "store",
  sshEncryptPasswords: true,
  terminalFontSize: 14,
  sideRail: true,
  statusBar: true,
};

/** Any finite number is honoured, rounded and clamped to the legible range;
 * anything else falls back to the default. */
function parseTerminalFontSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.terminalFontSize;
  }
  return Math.min(
    TERMINAL_FONT_SIZE_MAX,
    Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(value)),
  );
}

function isNewTabPolicy(value: unknown): value is NewTabPolicy {
  return (NEW_TAB_POLICIES as readonly unknown[]).includes(value);
}

function isDefaultProfile(value: unknown): value is DefaultProfile {
  return (DEFAULT_PROFILES as readonly unknown[]).includes(value);
}

function isSummaryEngine(value: unknown): value is SummaryEngine {
  return (SUMMARY_ENGINES as readonly unknown[]).includes(value);
}

function isSummaryContent(value: unknown): value is SummaryContent {
  return (SUMMARY_CONTENTS as readonly unknown[]).includes(value);
}

function isSummaryDisplay(value: unknown): value is SummaryDisplay {
  return (SUMMARY_DISPLAYS as readonly unknown[]).includes(value);
}

function isSleepOption(value: unknown): value is SleepOption {
  return (SLEEP_OPTIONS as readonly unknown[]).includes(value);
}

function isCloseBehavior(value: unknown): value is CloseBehavior {
  return (CLOSE_BEHAVIORS as readonly unknown[]).includes(value);
}

function isMaxGroupDepth(value: unknown): value is MaxGroupDepthOption {
  return (MAX_GROUP_DEPTH_OPTIONS as readonly unknown[]).includes(value);
}

function isAgentPaneView(value: unknown): value is AgentPaneView {
  return (AGENT_PANE_VIEWS as readonly unknown[]).includes(value);
}

function isChatDensity(value: unknown): value is ChatDensity {
  return (CHAT_DENSITIES as readonly unknown[]).includes(value);
}

function isSshPasswordPolicy(value: unknown): value is SshPasswordPolicy {
  return (SSH_PASSWORD_POLICIES as readonly unknown[]).includes(value);
}

/** Parse settings text (null = missing file). Never throws. */
export function parseSettings(text: string | null): TermxSettings {
  if (text === null) {
    return DEFAULT_SETTINGS;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_SETTINGS;
  }
  const record = raw as Record<string, unknown>;
  return {
    newTabPolicy: isNewTabPolicy(record.newTabPolicy)
      ? record.newTabPolicy
      : DEFAULT_SETTINGS.newTabPolicy,
    shellIntegration:
      typeof record.shellIntegration === "boolean"
        ? record.shellIntegration
        : DEFAULT_SETTINGS.shellIntegration,
    defaultProfile: isDefaultProfile(record.defaultProfile)
      ? record.defaultProfile
      : DEFAULT_SETTINGS.defaultProfile,
    conversationsRail:
      typeof record.conversationsRail === "boolean"
        ? record.conversationsRail
        : DEFAULT_SETTINGS.conversationsRail,
    conversationsPalette:
      typeof record.conversationsPalette === "boolean"
        ? record.conversationsPalette
        : DEFAULT_SETTINGS.conversationsPalette,
    summaryEngine: isSummaryEngine(record.summaryEngine)
      ? record.summaryEngine
      : DEFAULT_SETTINGS.summaryEngine,
    summaryContent: isSummaryContent(record.summaryContent)
      ? record.summaryContent
      : DEFAULT_SETTINGS.summaryContent,
    summaryDisplay: isSummaryDisplay(record.summaryDisplay)
      ? record.summaryDisplay
      : DEFAULT_SETTINGS.summaryDisplay,
    sleepHiddenTerminals: isSleepOption(record.sleepHiddenTerminals)
      ? record.sleepHiddenTerminals
      : DEFAULT_SETTINGS.sleepHiddenTerminals,
    onWindowClose: isCloseBehavior(record.onWindowClose)
      ? record.onWindowClose
      : DEFAULT_SETTINGS.onWindowClose,
    maxGroupDepth: isMaxGroupDepth(record.maxGroupDepth)
      ? record.maxGroupDepth
      : DEFAULT_SETTINGS.maxGroupDepth,
    syncWindowRenameToTab:
      typeof record.syncWindowRenameToTab === "boolean"
        ? record.syncWindowRenameToTab
        : DEFAULT_SETTINGS.syncWindowRenameToTab,
    theme: isThemeId(record.theme) ? record.theme : DEFAULT_SETTINGS.theme,
    agentPaneDefaultView: isAgentPaneView(record.agentPaneDefaultView)
      ? record.agentPaneDefaultView
      : DEFAULT_SETTINGS.agentPaneDefaultView,
    chatDefaultDensity: isChatDensity(record.chatDefaultDensity)
      ? record.chatDefaultDensity
      : DEFAULT_SETTINGS.chatDefaultDensity,
    savedPaneButton:
      typeof record.savedPaneButton === "boolean"
        ? record.savedPaneButton
        : DEFAULT_SETTINGS.savedPaneButton,
    savedSidebarList:
      typeof record.savedSidebarList === "boolean"
        ? record.savedSidebarList
        : DEFAULT_SETTINGS.savedSidebarList,
    savedConversationsRail:
      typeof record.savedConversationsRail === "boolean"
        ? record.savedConversationsRail
        : DEFAULT_SETTINGS.savedConversationsRail,
    sshHostsSidebar:
      typeof record.sshHostsSidebar === "boolean"
        ? record.sshHostsSidebar
        : DEFAULT_SETTINGS.sshHostsSidebar,
    sshHostsMenu:
      typeof record.sshHostsMenu === "boolean"
        ? record.sshHostsMenu
        : DEFAULT_SETTINGS.sshHostsMenu,
    sshPasswordPolicy: isSshPasswordPolicy(record.sshPasswordPolicy)
      ? record.sshPasswordPolicy
      : DEFAULT_SETTINGS.sshPasswordPolicy,
    sshEncryptPasswords:
      typeof record.sshEncryptPasswords === "boolean"
        ? record.sshEncryptPasswords
        : DEFAULT_SETTINGS.sshEncryptPasswords,
    terminalFontSize: parseTerminalFontSize(record.terminalFontSize),
    sideRail:
      typeof record.sideRail === "boolean"
        ? record.sideRail
        : DEFAULT_SETTINGS.sideRail,
    statusBar:
      typeof record.statusBar === "boolean"
        ? record.statusBar
        : DEFAULT_SETTINGS.statusBar,
  };
}

export function serializeSettings(settings: TermxSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
