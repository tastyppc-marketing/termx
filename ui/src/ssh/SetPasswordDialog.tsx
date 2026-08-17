/**
 * The SSH set-password dialog (ssh-sessions spec §6).
 *
 * Pure presentation: it is handed an alias and whether that alias already has
 * a stored password, and reports a new value, a removal, or nothing. It never
 * receives — and therefore can never show — the stored password itself.
 *
 * Modal manners are cloned from `SaveSessionDialog`: a backdrop, a
 * focus-trapped `role="dialog"`, Escape to cancel, Enter to save.
 *
 * Secret hygiene, deliberately: the typed value lives in component state and
 * reaches `onSave` verbatim. It is never trimmed (a password may end in a
 * space), never written into an attribute (`title`, `aria-*`, `value=`), never
 * logged, and it dies with the unmount below.
 */

import { useEffect, useRef, useState } from "react";
import "./SetPasswordDialog.css";

export interface SetPasswordDialogProps {
  open: boolean;
  /** The `~/.ssh/config` alias the password belongs to. */
  alias: string;
  /** True when a password is already stored: adds the replace copy + Remove. */
  hasExisting: boolean;
  /** Non-empty, NOT trimmed. */
  onSave(password: string): void;
  /** Absent hides Remove even for a host that has one stored. */
  onRemove?(): void;
  onCancel(): void;
}

const FOCUSABLE = "input:not(:disabled), button:not(:disabled)";

/**
 * Closing UNMOUNTS the form, which is what guarantees a reopened dialog starts
 * empty: the typed secret is not merely cleared, it never survives the close.
 */
export function SetPasswordDialog({
  open,
  alias,
  hasExisting,
  onSave,
  onRemove,
  onCancel,
}: SetPasswordDialogProps) {
  if (!open) {
    return null;
  }
  return (
    <SetPasswordForm
      alias={alias}
      hasExisting={hasExisting}
      onSave={onSave}
      onCancel={onCancel}
      {...(onRemove ? { onRemove } : {})}
    />
  );
}

function SetPasswordForm({
  alias,
  hasExisting,
  onSave,
  onRemove,
  onCancel,
}: Omit<SetPasswordDialogProps, "open">) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [password, setPassword] = useState("");
  const title = `Password for ${alias}`;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /// Length, not blankness: "  " is a password like any other.
  const valid = password.length > 0;

  const commit = () => {
    if (!valid) {
      return;
    }
    onSave(password);
  };

  return (
    <div className="ssh-password-backdrop">
      <div
        className="ssh-password"
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

        <label className="ssh-password__field" htmlFor="ssh-password-input">
          <span className="ssh-password__label">
            {hasExisting ? "Replace stored password" : "Password"}
          </span>
          <input
            ref={inputRef}
            id="ssh-password-input"
            data-testid="ssh-password-input"
            className="ssh-password__input"
            type="password"
            /// Uncontrolled on purpose: React reflects a controlled `value`
            /// into the DOM `value=` ATTRIBUTE, which would put the secret into
            /// the markup — visible to any innerHTML dump, snapshot or devtools
            /// copy. With defaultValue the attribute stays empty and the typed
            /// characters live only in the element's property and in state.
            defaultValue=""
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setPassword(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                commit();
              }
            }}
          />
        </label>

        <p className="ssh-password__note">
          {hasExisting
            ? "The stored password is never shown — type the new one to replace it."
            : `TermX types it at the ${alias} password prompt; it is never echoed to the terminal.`}
        </p>

        <div className="ssh-password__actions">
          {hasExisting && onRemove ? (
            <button
              type="button"
              data-testid="ssh-password-remove"
              className="ssh-password__remove"
              onClick={onRemove}
            >
              Remove
            </button>
          ) : null}
          <button
            type="button"
            data-testid="ssh-password-cancel"
            className="ssh-password__cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="ssh-password-save"
            className="ssh-password__save"
            disabled={!valid}
            {...(valid ? {} : { title: "Type a password to store it" })}
            onClick={commit}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
