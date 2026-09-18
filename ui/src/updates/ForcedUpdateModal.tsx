/**
 * The forced-update modal. Shown for any state whose result is a forced,
 * available release, and it cannot be dismissed: Escape is swallowed, Tab
 * cycles inside, and the only way out is "Update now". The button follows
 * the updater's state so a failed download shows its message inline and
 * turns into "Retry" rather than leaving the user stranded.
 *
 * Focus trap cloned from `CloseGuard`, minus the Escape exit.
 */

import { useEffect, useRef } from "react";
import type { UpdateState } from "./types";
import "./updates.css";

export interface ForcedUpdateModalProps {
  update: UpdateState;
  /** Titles of the live terminals that will close when the daemon changes. */
  sessionTitles: readonly string[];
  /** "Update now" / "Retry": install when ready, download again on error. */
  onInstall(): void;
  onNotes(): void;
}

export function ForcedUpdateModal({ update, sessionTitles, onInstall, onNotes }: ForcedUpdateModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const result = "result" in update ? update.result : undefined;
  const open = result !== undefined && result.forced && result.status === "available";

  useEffect(() => {
    if (open) {
      dialogRef.current?.focus();
    }
  }, [open]);

  if (!open || !result) {
    return null;
  }

  const busy = update.kind === "downloading" || update.kind === "installing";
  const label = update.kind === "error" ? "Retry"
    : update.kind === "ready" ? "Update now"
    : update.kind === "installing" ? "Installing…"
    : "Downloading…";
  const listsSessions = result.hostChanged && sessionTitles.length > 0;

  return (
    <div className="forced-update-backdrop">
      <div
        ref={dialogRef}
        className="forced-update"
        role="dialog"
        aria-modal="true"
        aria-label={`TermX ${result.latestVersion} is required`}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (event.key !== "Tab") {
            return;
          }
          const focusables = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled)"),
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
        <h2>TermX {result.latestVersion} is required</h2>
        <p className="forced-update__body">
          This release has to be installed before TermX can continue. Work continues after the update.
        </p>
        {listsSessions ? (
          <div className="forced-update__sessions">
            <p className="forced-update__body">These terminals will close:</p>
            <ul>
              {sessionTitles.map((title, index) => (
                <li key={`${index}-${title}`}>{title}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {update.kind === "error" ? (
          <p className="forced-update__error" role="alert">{update.message}</p>
        ) : null}
        <div className="forced-update__actions">
          <button
            type="button"
            className="forced-update__primary"
            data-testid="update-now"
            disabled={busy}
            onClick={onInstall}
          >
            {label}
          </button>
          <button type="button" className="update-link" data-testid="update-notes" onClick={onNotes}>
            What's new
          </button>
        </div>
      </div>
    </div>
  );
}
