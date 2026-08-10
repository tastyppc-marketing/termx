import { useEffect, useRef } from "react";
import { deriveTokens } from "../theme/deriveTokens";
import { THEME_IDS, THEMES } from "../theme/themes";
import {
  MAX_GROUP_DEPTH_OPTIONS,
  type CloseBehavior,
  type MaxGroupDepthOption,
  type NewTabPolicy,
  type SleepOption,
  type SummaryContent,
  type SummaryDisplay,
  type SummaryEngine,
  type TermxSettings,
} from "./settings";
import "./SettingsDialog.css";

export interface SettingsDialogProps {
  settings: TermxSettings;
  onChange(patch: Partial<TermxSettings>): void;
  onClose(): void;
}

const POLICY_OPTIONS: ReadonlyArray<{
  value: NewTabPolicy;
  label: string;
  hint: string;
}> = [
  {
    value: "group-active",
    label: "Group's current folder",
    hint: "Follows cd in the group's terminals; the first terminal seeds it.",
  },
  {
    value: "active-tab",
    label: "Focused terminal's folder",
    hint: "Wherever the terminal you're using right now is.",
  },
  {
    value: "first-terminal",
    label: "Group's first terminal folder",
    hint: "The folder the group started in; cds don't move it.",
  },
  {
    value: "ask-searcher",
    label: "Ask every time — folder search",
    hint: "Opens the folder search palette for each new terminal.",
  },
  {
    value: "ask-native",
    label: "Ask every time — system dialog",
    hint: "Opens the Windows folder browser for each new terminal.",
  },
];

const SUMMARY_ENGINE_OPTIONS: ReadonlyArray<{
  value: SummaryEngine;
  label: string;
  hint: string;
}> = [
  {
    value: "disk-first",
    label: "Disk first",
    hint: "Harvested data wins; the LLM fills in only missing summaries/recaps.",
  },
  {
    value: "disk-only",
    label: "Disk only",
    hint: "Only what's already on disk. No LLM calls; gaps stay empty.",
  },
  {
    value: "llm",
    label: "LLM",
    hint: "The LLM (re)generates both kinds for every session as they go stale.",
  },
];

const SUMMARY_CONTENT_OPTIONS: ReadonlyArray<{
  value: SummaryContent;
  label: string;
  hint: string;
}> = [
  { value: "summary", label: "Summary only", hint: "A short one-line description." },
  { value: "recap", label: "Recap only", hint: "A multi-line \"what was going on\"." },
  { value: "both", label: "Summary and recap", hint: "Shows both, where available." },
  { value: "none", label: "None", hint: "Rows show just the title and path." },
];

const SUMMARY_DISPLAY_OPTIONS: ReadonlyArray<{
  value: SummaryDisplay;
  label: string;
  hint: string;
}> = [
  {
    value: "hover",
    label: "On hover",
    hint: "Shows as a tooltip when you hover the row.",
  },
  {
    value: "under-title",
    label: "Under the title",
    hint: "Shows as a secondary line under the title (recap clamps to 3 lines).",
  },
];

const SLEEP_OPTIONS_LIST: ReadonlyArray<{
  value: SleepOption;
  label: string;
  hint: string;
}> = [
  { value: "off", label: "Never", hint: "Hidden terminals never sleep." },
  {
    value: "5",
    label: "After 5 minutes",
    hint: "Hidden terminals sleep after 5 minutes of being out of view.",
  },
  {
    value: "15",
    label: "After 15 minutes",
    hint: "Hidden terminals sleep after 15 minutes of being out of view.",
  },
  {
    value: "60",
    label: "After 60 minutes",
    hint: "Hidden terminals sleep after 60 minutes of being out of view.",
  },
];

const GROUP_DEPTH_OPTIONS: ReadonlyArray<{
  value: MaxGroupDepthOption;
  label: string;
  hint: string;
}> = MAX_GROUP_DEPTH_OPTIONS.map((value) => ({
  value,
  label: value === 1 ? "No subgroups" : `${value} levels`,
  hint: value === 1
    ? "Groups stay flat, as they were before nesting."
    : `Groups may be nested ${value} levels deep. Deeper layouts built elsewhere still open.`,
}));

const CLOSE_BEHAVIOR_OPTIONS: ReadonlyArray<{
  value: CloseBehavior;
  label: string;
  hint: string;
}> = [
  {
    value: "ask",
    label: "Ask every time",
    hint: "Shows a dialog when you close the window while terminals or agents are running, so you can choose what happens.",
  },
  {
    value: "keep-running",
    label: "Keep running",
    hint: "Closes immediately. Closing the window keeps terminals and agents running in the background — reopening TermX restores them.",
  },
  {
    value: "stop-all",
    label: "Stop everything",
    hint: "Closes immediately and stops every terminal and agent process.",
  },
];

/** Settings apply instantly (the store is live); the dialog is only a view. */
export function SettingsDialog({ settings, onChange, onClose }: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div className="settings-dialog-backdrop">
      <div
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="TermX settings"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key !== "Tab") {
            return;
          }
          const focusables = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              "input:not(:disabled), select:not(:disabled), button:not(:disabled)",
            ),
          );
          if (focusables.length === 0) {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.focus();
            return;
          }
          const index = focusables.indexOf(document.activeElement as HTMLElement);
          const leavingStart = event.shiftKey && index <= 0;
          const leavingEnd = !event.shiftKey && index === focusables.length - 1;
          if (leavingStart || leavingEnd) {
            event.preventDefault();
            event.stopPropagation();
            focusables[leavingStart ? focusables.length - 1 : 0]?.focus();
          }
        }}
      >
        <h2>Settings</h2>

        <fieldset className="settings-section">
          <legend>Theme</legend>
          <div className="settings-themes">
            {THEME_IDS.map((id) => {
              const theme = THEMES[id];
              const tokens = deriveTokens(theme);
              return (
                <label className="settings-theme" key={id}>
                  <input
                    type="radio"
                    name="theme"
                    value={id}
                    checked={settings.theme === id}
                    onChange={() => onChange({ theme: id })}
                  />
                  <span
                    className="settings-theme__swatch"
                    aria-hidden="true"
                    style={{
                      background: theme.bg,
                      borderColor: tokens["--divider"],
                      color: tokens["--text-main"],
                    }}
                  >
                    Aa
                    <span
                      className="settings-theme__accent"
                      style={{ background: tokens["--accent"] }}
                    />
                  </span>
                  <span className="settings-theme__name">{theme.name}</span>
                </label>
              );
            })}
          </div>
          <p className="settings-section__note">
            Switches instantly — running terminals retint as you click.
          </p>
        </fieldset>

        <fieldset className="settings-section">
          <legend>New terminals open in</legend>
          {POLICY_OPTIONS.map((option) => (
            <label className="settings-radio" key={option.value}>
              <input
                type="radio"
                name="newTabPolicy"
                value={option.value}
                checked={settings.newTabPolicy === option.value}
                onChange={() => onChange({ newTabPolicy: option.value })}
              />
              <span className="settings-radio__text">
                <span className="settings-radio__label">{option.label}</span>
                <span className="settings-radio__hint">{option.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="settings-section">
          <legend>Shell</legend>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={settings.shellIntegration}
              onChange={(event) =>
                onChange({ shellIntegration: event.currentTarget.checked })}
            />
            <span className="settings-radio__text">
              <span className="settings-radio__label">Track directory changes</span>
              <span className="settings-radio__hint">
                Adds a small prompt hook to shells TermX starts. Required for
                "follows cd". Applies to new terminals.
              </span>
            </span>
          </label>
          <label className="settings-row">
            <span className="settings-row__label">Default shell</span>
            <select
              value={settings.defaultProfile}
              onChange={(event) =>
                onChange({
                  defaultProfile:
                    event.currentTarget.value === "cmd" ? "cmd" : "powershell",
                })}
            >
              <option value="powershell">Windows PowerShell</option>
              <option value="cmd">Command Prompt</option>
            </select>
          </label>
        </fieldset>

        <fieldset className="settings-section">
          <legend>Conversations</legend>
          <label className="settings-check">
            <input
              type="checkbox"
              name="conversationsRail"
              checked={settings.conversationsRail}
              onChange={(event) =>
                onChange({ conversationsRail: event.currentTarget.checked })}
            />
            <span className="settings-radio__text">
              <span className="settings-radio__label">Show the Conversations rail</span>
              <span className="settings-radio__hint">
                Adds a Terminals | Conversations switch to the sidebar.
              </span>
            </span>
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              name="conversationsPalette"
              checked={settings.conversationsPalette}
              onChange={(event) =>
                onChange({ conversationsPalette: event.currentTarget.checked })}
            />
            <span className="settings-radio__text">
              <span className="settings-radio__label">Enable the session palette</span>
              <span className="settings-radio__hint">
                Ctrl+Shift+R opens quick search across all sessions.
              </span>
            </span>
          </label>

          <div className="settings-subsection">
            <div className="settings-subsection__title">Summary source</div>
            {SUMMARY_ENGINE_OPTIONS.map((option) => (
              <label className="settings-radio" key={option.value}>
                <input
                  type="radio"
                  name="summaryEngine"
                  value={option.value}
                  checked={settings.summaryEngine === option.value}
                  onChange={() => onChange({ summaryEngine: option.value })}
                />
                <span className="settings-radio__text">
                  <span className="settings-radio__label">{option.label}</span>
                  <span className="settings-radio__hint">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="settings-subsection">
            <div className="settings-subsection__title">Summary content</div>
            {SUMMARY_CONTENT_OPTIONS.map((option) => (
              <label className="settings-radio" key={option.value}>
                <input
                  type="radio"
                  name="summaryContent"
                  value={option.value}
                  checked={settings.summaryContent === option.value}
                  onChange={() => onChange({ summaryContent: option.value })}
                />
                <span className="settings-radio__text">
                  <span className="settings-radio__label">{option.label}</span>
                  <span className="settings-radio__hint">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="settings-subsection">
            <div className="settings-subsection__title">Summary display</div>
            {SUMMARY_DISPLAY_OPTIONS.map((option) => (
              <label className="settings-radio" key={option.value}>
                <input
                  type="radio"
                  name="summaryDisplay"
                  value={option.value}
                  checked={settings.summaryDisplay === option.value}
                  onChange={() => onChange({ summaryDisplay: option.value })}
                />
                <span className="settings-radio__text">
                  <span className="settings-radio__label">{option.label}</span>
                  <span className="settings-radio__hint">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="settings-section">
          <legend>Terminals</legend>
          <div className="settings-subsection">
            <div className="settings-subsection__title">Sleep hidden terminals</div>
            {SLEEP_OPTIONS_LIST.map((option) => (
              <label className="settings-radio" key={option.value}>
                <input
                  type="radio"
                  name="sleepHiddenTerminals"
                  value={option.value}
                  checked={settings.sleepHiddenTerminals === option.value}
                  onChange={() =>
                    onChange({ sleepHiddenTerminals: option.value })}
                />
                <span className="settings-radio__text">
                  <span className="settings-radio__label">{option.label}</span>
                  <span className="settings-radio__hint">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="settings-subsection">
            <div className="settings-subsection__title">Group nesting depth</div>
            {GROUP_DEPTH_OPTIONS.map((option) => (
              <label className="settings-radio" key={option.value}>
                <input
                  type="radio"
                  name="maxGroupDepth"
                  value={option.value}
                  checked={settings.maxGroupDepth === option.value}
                  onChange={() => onChange({ maxGroupDepth: option.value })}
                />
                <span className="settings-radio__text">
                  <span className="settings-radio__label">{option.label}</span>
                  <span className="settings-radio__hint">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="settings-subsection">
            <div className="settings-subsection__title">When closing the window</div>
            {CLOSE_BEHAVIOR_OPTIONS.map((option) => (
              <label className="settings-radio" key={option.value}>
                <input
                  type="radio"
                  name="onWindowClose"
                  value={option.value}
                  checked={settings.onWindowClose === option.value}
                  onChange={() => onChange({ onWindowClose: option.value })}
                />
                <span className="settings-radio__text">
                  <span className="settings-radio__label">{option.label}</span>
                  <span className="settings-radio__hint">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="settings-dialog__actions">
          <button type="button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
