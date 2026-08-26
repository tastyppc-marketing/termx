/**
 * Full-screen settings surface. Takes over the workspace area (the
 * `ConversationsFullscreen` pattern) instead of piling every control into one
 * modal: a section sidebar on the left, the active section's controls on the
 * right. Sections are data (`SETTINGS_SECTIONS`) so a future batch adds one
 * without layout surgery.
 *
 * The store is live — every control writes through `store.update` and applies
 * instantly. The surface is only a view; it owns no settings state. The
 * controls themselves moved here verbatim from the retired settings modal.
 */

import { useEffect, useRef, useState } from "react";
import { deriveTokens } from "../theme/deriveTokens";
import { THEME_IDS, THEMES } from "../theme/themes";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./sections";
import type { SettingsStore } from "./SettingsStore";
import {
  MAX_GROUP_DEPTH_OPTIONS,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  type AgentPaneView,
  type ChatDensity,
  type CloseBehavior,
  type MaxGroupDepthOption,
  type NewTabPolicy,
  type SleepOption,
  type SshPasswordPolicy,
  type SummaryContent,
  type SummaryDisplay,
  type SummaryEngine,
  type TermxSettings,
} from "./settings";
import { useSettings } from "./useSettings";
import "./SettingsSurface.css";

export interface SettingsSurfaceProps {
  store: SettingsStore;
  onClose(): void;
}

interface LadderOption<T> {
  readonly value: T;
  readonly label: string;
  readonly hint: string;
}

const POLICY_OPTIONS: ReadonlyArray<LadderOption<NewTabPolicy>> = [
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

const SUMMARY_ENGINE_OPTIONS: ReadonlyArray<LadderOption<SummaryEngine>> = [
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

const SUMMARY_CONTENT_OPTIONS: ReadonlyArray<LadderOption<SummaryContent>> = [
  { value: "summary", label: "Summary only", hint: "A short one-line description." },
  { value: "recap", label: "Recap only", hint: "A multi-line \"what was going on\"." },
  { value: "both", label: "Summary and recap", hint: "Shows both, where available." },
  { value: "none", label: "None", hint: "Rows show just the title and path." },
];

const SUMMARY_DISPLAY_OPTIONS: ReadonlyArray<LadderOption<SummaryDisplay>> = [
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

const SLEEP_OPTIONS_LIST: ReadonlyArray<LadderOption<SleepOption>> = [
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

const GROUP_DEPTH_OPTIONS: ReadonlyArray<LadderOption<MaxGroupDepthOption>> =
  MAX_GROUP_DEPTH_OPTIONS.map((value) => ({
    value,
    label: value === 1 ? "No subgroups" : `${value} levels`,
    hint: value === 1
      ? "Groups stay flat, as they were before nesting."
      : `Groups may be nested ${value} levels deep. Deeper layouts built elsewhere still open.`,
  }));

const CLOSE_BEHAVIOR_OPTIONS: ReadonlyArray<LadderOption<CloseBehavior>> = [
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

const AGENT_PANE_VIEW_OPTIONS: ReadonlyArray<LadderOption<AgentPaneView>> = [
  {
    value: "terminal",
    label: "Terminal",
    hint: "Agent panes open on the raw terminal, exactly as they do today.",
  },
  {
    value: "chat",
    label: "Chat view",
    hint: "Agent panes open on the parsed conversation; the terminal is a toggle away.",
  },
];

const CHAT_DENSITY_OPTIONS: ReadonlyArray<LadderOption<ChatDensity>> = [
  {
    value: "chips",
    label: "Chips",
    hint: "Everything collapses to one-line chips; expand what you want to read.",
  },
  {
    value: "smart",
    label: "Smart",
    hint: "Prose stays open, tool traffic collapses. The everyday setting.",
  },
  {
    value: "full",
    label: "Full",
    hint: "Nothing collapses — every message and tool result shown in full.",
  },
];

const SSH_PASSWORD_POLICY_OPTIONS: ReadonlyArray<
  LadderOption<SshPasswordPolicy>
> = [
  {
    value: "store",
    label: "Remember passwords",
    hint: "TermX can save a password per host and type it for you on connect.",
  },
  {
    value: "never",
    label: "Keys and agent only",
    hint: "No password is ever stored or used; any already saved is ignored.",
  },
];

export function SettingsSurface({ store, onClose }: SettingsSurfaceProps) {
  const settings = useSettings(store);
  const rootRef = useRef<HTMLElement | null>(null);
  const [activeId, setActiveId] = useState<SettingsSectionId>(
    SETTINGS_SECTIONS[0]!.id,
  );

  // Focus moves into the surface on mount (so Esc works immediately and the
  // keydown guard has something inside to match on) and returns to whatever
  // opened it — the gear, the chip — when the surface goes away.
  useEffect(() => {
    const opener = document.activeElement;
    rootRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
      }
    };
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      // Scoped, never a global hotkey: Esc closes only while focus is inside
      // the surface, so a dialog or palette layered on top keeps its own Esc.
      const root = rootRef.current;
      if (!root || !root.contains(document.activeElement)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose]);

  const active =
    SETTINGS_SECTIONS.find((section) => section.id === activeId) ??
    SETTINGS_SECTIONS[0]!;

  return (
    <section
      ref={rootRef}
      className="settings-surface"
      aria-label="TermX settings"
      tabIndex={-1}
    >
      <header className="settings-surface__header">
        <h2 className="settings-surface__title">Settings</h2>
        <span className="settings-surface__hint">Esc</span>
        <button
          type="button"
          className="settings-surface__back"
          aria-label="Close settings"
          title="Close settings (Esc)"
          onClick={onClose}
        >
          ✕
        </button>
      </header>
      <div className="settings-surface__body">
        <nav
          className="settings-surface__nav"
          role="tablist"
          aria-label="Settings sections"
          aria-orientation="vertical"
        >
          {SETTINGS_SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              role="tab"
              className="settings-surface__tab"
              data-section={section.id}
              aria-selected={section.id === active.id}
              aria-controls="settings-surface-panel"
              onClick={() => setActiveId(section.id)}
            >
              {section.label}
            </button>
          ))}
        </nav>
        <div
          className="settings-surface__panel"
          id="settings-surface-panel"
          role="tabpanel"
          aria-label={active.label}
        >
          <h3 className="settings-surface__panel-title">{active.label}</h3>
          {active.fields.map((field) => (
            <div className="settings-field" data-field={field} key={field}>
              <SettingsControl
                field={field}
                settings={settings}
                onChange={store.update}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function RadioLadder<T extends string | number>({
  name,
  title,
  options,
  value,
  onPick,
}: {
  name: string;
  title: string;
  options: ReadonlyArray<LadderOption<T>>;
  value: T;
  onPick(value: T): void;
}) {
  return (
    <div className="settings-subsection">
      <div className="settings-subsection__title">{title}</div>
      {options.map((option) => (
        <label className="settings-radio" key={String(option.value)}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onPick(option.value)}
          />
          <span className="settings-radio__text">
            <span className="settings-radio__label">{option.label}</span>
            <span className="settings-radio__hint">{option.hint}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function Toggle({
  name,
  label,
  hint,
  checked,
  onToggle,
}: {
  name: string;
  label: string;
  hint: string;
  checked: boolean;
  onToggle(checked: boolean): void;
}) {
  return (
    <label className="settings-check">
      <input
        type="checkbox"
        name={name}
        checked={checked}
        onChange={(event) => onToggle(event.currentTarget.checked)}
      />
      <span className="settings-radio__text">
        <span className="settings-radio__label">{label}</span>
        <span className="settings-radio__hint">{hint}</span>
      </span>
    </label>
  );
}

/** One control per settings field — the dialog's markup, moved as-is. */
function SettingsControl({
  field,
  settings,
  onChange,
}: {
  field: keyof TermxSettings;
  settings: TermxSettings;
  onChange(patch: Partial<TermxSettings>): void;
}) {
  switch (field) {
    case "onWindowClose":
      return (
        <RadioLadder
          name="onWindowClose"
          title="When closing the window"
          options={CLOSE_BEHAVIOR_OPTIONS}
          value={settings.onWindowClose}
          onPick={(value) => onChange({ onWindowClose: value })}
        />
      );
    case "sleepHiddenTerminals":
      return (
        <RadioLadder
          name="sleepHiddenTerminals"
          title="Sleep hidden terminals"
          options={SLEEP_OPTIONS_LIST}
          value={settings.sleepHiddenTerminals}
          onPick={(value) => onChange({ sleepHiddenTerminals: value })}
        />
      );
    case "theme":
      return (
        <div className="settings-subsection">
          <div className="settings-subsection__title">Theme</div>
          {/* Six cards, each previewing its OWN palette (never the running
              one) so the choice is legible before it is made. */}
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
        </div>
      );
    case "defaultProfile":
      return (
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
      );
    case "terminalFontSize":
      return (
        <div>
          <label className="settings-row">
            <span className="settings-row__label">Terminal text size</span>
            <input
              type="number"
              min={TERMINAL_FONT_SIZE_MIN}
              max={TERMINAL_FONT_SIZE_MAX}
              value={settings.terminalFontSize}
              onChange={(event) => {
                const raw = Number(event.currentTarget.value);
                if (!Number.isFinite(raw)) {
                  return;
                }
                onChange({
                  terminalFontSize: Math.min(
                    TERMINAL_FONT_SIZE_MAX,
                    Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(raw)),
                  ),
                });
              }}
            />
          </label>
          <p className="settings-section__note">
            Ctrl+scroll over any terminal zooms too — changes apply instantly.
          </p>
        </div>
      );
    case "shellIntegration":
      return (
        <Toggle
          name="shellIntegration"
          label="Track directory changes"
          hint={'Adds a small prompt hook to shells TermX starts. Required for "follows cd". Applies to new terminals.'}
          checked={settings.shellIntegration}
          onToggle={(checked) => onChange({ shellIntegration: checked })}
        />
      );
    case "newTabPolicy":
      return (
        <RadioLadder
          name="newTabPolicy"
          title="New terminals open in"
          options={POLICY_OPTIONS}
          value={settings.newTabPolicy}
          onPick={(value) => onChange({ newTabPolicy: value })}
        />
      );
    case "maxGroupDepth":
      return (
        <RadioLadder
          name="maxGroupDepth"
          title="Group nesting depth"
          options={GROUP_DEPTH_OPTIONS}
          value={settings.maxGroupDepth}
          onPick={(value) => onChange({ maxGroupDepth: value })}
        />
      );
    case "conversationsRail":
      return (
        <Toggle
          name="conversationsRail"
          label="Show the Conversations rail"
          hint="Adds a Terminals | Conversations switch to the sidebar."
          checked={settings.conversationsRail}
          onToggle={(checked) => onChange({ conversationsRail: checked })}
        />
      );
    case "conversationsPalette":
      return (
        <Toggle
          name="conversationsPalette"
          label="Enable the session palette"
          hint="Ctrl+Shift+R opens quick search across all sessions."
          checked={settings.conversationsPalette}
          onToggle={(checked) => onChange({ conversationsPalette: checked })}
        />
      );
    case "summaryEngine":
      return (
        <RadioLadder
          name="summaryEngine"
          title="Summary source"
          options={SUMMARY_ENGINE_OPTIONS}
          value={settings.summaryEngine}
          onPick={(value) => onChange({ summaryEngine: value })}
        />
      );
    case "summaryContent":
      return (
        <RadioLadder
          name="summaryContent"
          title="Summary content"
          options={SUMMARY_CONTENT_OPTIONS}
          value={settings.summaryContent}
          onPick={(value) => onChange({ summaryContent: value })}
        />
      );
    case "summaryDisplay":
      return (
        <RadioLadder
          name="summaryDisplay"
          title="Summary display"
          options={SUMMARY_DISPLAY_OPTIONS}
          value={settings.summaryDisplay}
          onPick={(value) => onChange({ summaryDisplay: value })}
        />
      );
    case "agentPaneDefaultView":
      return (
        <RadioLadder
          name="agentPaneDefaultView"
          title="Agent panes open in"
          options={AGENT_PANE_VIEW_OPTIONS}
          value={settings.agentPaneDefaultView}
          onPick={(value) => onChange({ agentPaneDefaultView: value })}
        />
      );
    case "chatDefaultDensity":
      return (
        <RadioLadder
          name="chatDefaultDensity"
          title="Default chat density"
          options={CHAT_DENSITY_OPTIONS}
          value={settings.chatDefaultDensity}
          onPick={(value) => onChange({ chatDefaultDensity: value })}
        />
      );
    case "savedPaneButton":
      return (
        <Toggle
          name="savedPaneButton"
          label="Save button on panes"
          hint="Adds a pin button to the pane toolbar, next to split and close."
          checked={settings.savedPaneButton}
          onToggle={(checked) => onChange({ savedPaneButton: checked })}
        />
      );
    case "savedSidebarList":
      return (
        <Toggle
          name="savedSidebarList"
          label="Show the Saved list in the sidebar"
          hint="Lists saved sessions above the terminals; click a row to resume it."
          checked={settings.savedSidebarList}
          onToggle={(checked) => onChange({ savedSidebarList: checked })}
        />
      );
    case "savedConversationsRail":
      return (
        <Toggle
          name="savedConversationsRail"
          label="Save from conversation rows"
          hint="Adds a save action to rows in the Conversations rail (folder only, no terminal)."
          checked={settings.savedConversationsRail}
          onToggle={(checked) => onChange({ savedConversationsRail: checked })}
        />
      );
    case "sshHostsSidebar":
      return (
        <Toggle
          name="sshHostsSidebar"
          label="Show Hosts in the sidebar"
          hint="Lists the hosts from your SSH config; click a row to connect in a new tab."
          checked={settings.sshHostsSidebar}
          onToggle={(checked) => onChange({ sshHostsSidebar: checked })}
        />
      );
    case "sshHostsMenu":
      return (
        <Toggle
          name="sshHostsMenu"
          label="Offer hosts in the new-terminal menu"
          hint="Adds each host as a connect target alongside the shell profiles."
          checked={settings.sshHostsMenu}
          onToggle={(checked) => onChange({ sshHostsMenu: checked })}
        />
      );
    case "sshPasswordPolicy":
      return (
        <RadioLadder
          name="sshPasswordPolicy"
          title="SSH passwords"
          options={SSH_PASSWORD_POLICY_OPTIONS}
          value={settings.sshPasswordPolicy}
          onPick={(value) => onChange({ sshPasswordPolicy: value })}
        />
      );
    case "sshEncryptPasswords":
      return (
        <Toggle
          name="sshEncryptPasswords"
          label="Encrypt stored passwords"
          // Says exactly what off means (spec §6): no euphemism for plaintext.
          hint="Windows encrypts them for your account, with no passphrase to remember. Off means they sit in plain text in TermX's data folder."
          checked={settings.sshEncryptPasswords}
          onToggle={(checked) => onChange({ sshEncryptPasswords: checked })}
        />
      );
    default: {
      // Exhaustive: a new field without a control fails the build here, and
      // `sections.test.ts` fails if it has no section at all.
      const unreachable: never = field;
      return <>{unreachable}</>;
    }
  }
}
