/**
 * The saved-sessions save dialog (saved-sessions spec §"Save flow").
 *
 * Pure presentation: it is handed a prefill (name, description, folder, and a
 * line describing what a resume would do) and reports the edited values back.
 * Nothing in here touches the store, the controller or settings — the caller
 * decides where the prefill came from and what `onSave` writes.
 *
 * Modal manners are cloned from `CloseGuard`: a backdrop, a focus-trapped
 * `role="dialog"`, Escape to cancel.
 */

import { useEffect, useRef, useState } from "react";
import "./SaveSessionDialog.css";

export interface SaveSessionPrefill {
  readonly name: string;
  readonly description: string;      // "" when none
  readonly cwd: string;
  /** Line describing what resume will do; null = bare-shell save. */
  readonly conversationLabel: string | null;
  /** True when this save will UPDATE an existing entry (upsert). */
  readonly updatesExisting: boolean;
}

export interface SaveSessionDialogProps {
  open: boolean;
  prefill: SaveSessionPrefill;
  onSave(result: { name: string; description: string; cwd: string }): void;
  onCancel(): void;
}

const FOCUSABLE =
  "input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)";

/**
 * Closing UNMOUNTS the form below, so every open starts from the prefill it was
 * given and nothing needs to be copied into state by an effect — a prefill that
 * changes while the dialog is open never clobbers what the user is typing.
 */
export function SaveSessionDialog({
  open,
  prefill,
  onSave,
  onCancel,
}: SaveSessionDialogProps) {
  if (!open) {
    return null;
  }
  return <SaveSessionForm prefill={prefill} onSave={onSave} onCancel={onCancel} />;
}

function SaveSessionForm({
  prefill,
  onSave,
  onCancel,
}: Omit<SaveSessionDialogProps, "open">) {
  const nameRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState(prefill.name);
  const [description, setDescription] = useState(prefill.description);
  const [cwd, setCwd] = useState(prefill.cwd);
  const title = prefill.updatesExisting ? "Update saved session" : "Save this session";

  // Selected, not just focused: the prefilled name is usually right, and when
  // it is not the first keystroke replaces it whole.
  useEffect(() => {
    const field = nameRef.current;
    field?.focus();
    field?.select();
  }, []);

  const trimmedName = name.trim();
  const valid = trimmedName.length > 0;

  const commit = () => {
    if (!valid) {
      return;
    }
    onSave({
      name: trimmedName,
      description: description.trim(),
      cwd: cwd.trim(),
    });
  };

  return (
    <div className="save-session-backdrop">
      <div
        className="save-session"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
            return;
          }
          if (event.key !== "Tab") {
            return;
          }
          const focusables = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE),
          );
          if (focusables.length === 0) {
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
        <h2>{title}</h2>

        <label className="save-session__field" htmlFor="save-session-name">
          <span className="save-session__label">Name</span>
          <input
            ref={nameRef}
            id="save-session-name"
            data-testid="save-session-name"
            className="save-session__input"
            type="text"
            value={name}
            spellCheck={false}
            onChange={(event) => setName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                commit();
              }
            }}
          />
        </label>

        <label className="save-session__field" htmlFor="save-session-description">
          <span className="save-session__label">
            Description <span className="save-session__optional">optional</span>
          </span>
          <textarea
            id="save-session-description"
            data-testid="save-session-description"
            className="save-session__textarea"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
        </label>

        <label className="save-session__field" htmlFor="save-session-cwd">
          <span className="save-session__label">Folder</span>
          <input
            id="save-session-cwd"
            data-testid="save-session-cwd"
            className="save-session__input"
            type="text"
            value={cwd}
            spellCheck={false}
            onChange={(event) => setCwd(event.currentTarget.value)}
          />
        </label>

        <p className="save-session__conversation" data-testid="save-session-conversation">
          {prefill.conversationLabel === null
            ? "No conversation — restores the folder only"
            : `Resumes: ${prefill.conversationLabel}`}
        </p>

        {prefill.updatesExisting ? (
          <p className="save-session__note">
            This conversation is already saved — saving replaces that entry
            instead of adding a second one.
          </p>
        ) : null}

        <div className="save-session__actions">
          <button
            type="button"
            data-testid="save-session-cancel"
            className="save-session__cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="save-session-save"
            className="save-session__save"
            disabled={!valid}
            {...(valid ? {} : { title: "A saved session needs a name" })}
            onClick={commit}
          >
            {prefill.updatesExisting ? "Update" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
