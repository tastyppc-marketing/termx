/**
 * TermX user settings: types, defaults, tolerant parsing.
 *
 * Settings persist as `settings_v1.json` in the app data dir. Parsing is
 * per-field tolerant (layout parse-gate philosophy): a malformed file yields
 * defaults for the broken fields and the file is NOT rewritten until the user
 * actually changes a setting — a parser bug must never destroy the file.
 */

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
}

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
};

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
  };
}

export function serializeSettings(settings: TermxSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
