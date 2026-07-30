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

export interface TermxSettings {
  /** Where a plain "new tab" opens. Default: follow the group's CDs. */
  readonly newTabPolicy: NewTabPolicy;
  /** Inject the OSC 9;9 prompt hook into spawned shells (cd tracking). */
  readonly shellIntegration: boolean;
  /** Profile used when a create action doesn't name one. */
  readonly defaultProfile: DefaultProfile;
}

export const DEFAULT_SETTINGS: TermxSettings = {
  newTabPolicy: "group-active",
  shellIntegration: true,
  defaultProfile: "powershell",
};

function isNewTabPolicy(value: unknown): value is NewTabPolicy {
  return (NEW_TAB_POLICIES as readonly unknown[]).includes(value);
}

function isDefaultProfile(value: unknown): value is DefaultProfile {
  return (DEFAULT_PROFILES as readonly unknown[]).includes(value);
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
  };
}

export function serializeSettings(settings: TermxSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
