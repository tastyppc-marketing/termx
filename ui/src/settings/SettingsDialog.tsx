import { useEffect, useRef } from "react";
import {
  type NewTabPolicy,
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

        <div className="settings-dialog__actions">
          <button type="button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
