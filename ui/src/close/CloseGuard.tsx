import { useEffect, useRef, useState } from "react";
import type { CloseDecision } from "./closeBehavior";
import "./CloseGuard.css";

export interface CloseGuardProps {
  /** Whether the dialog is showing. Renders nothing when false. */
  open: boolean;
  /** Fired when the user picks an outcome; `remember` reflects the checkbox. */
  onDecide(decision: CloseDecision, remember: boolean): void;
}

/**
 * The spec §15 "window close" dialog: shown when `onWindowClose` is "ask"
 * and at least one session is alive. Makes it unmissable that closing the
 * window does not stop anything running in the background daemon. Clones
 * the app's modal focus-trap pattern (see `FeaturesDock`).
 */
export function CloseGuard({ open, onDecide }: CloseGuardProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    if (open) {
      dialogRef.current?.focus();
    } else {
      setRemember(false);
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div className="close-guard-backdrop">
      <div
        ref={dialogRef}
        className="close-guard"
        role="dialog"
        aria-modal="true"
        aria-label="Your terminals keep running in the background"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onDecide("keep-running", false);
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
        <h2>Your terminals keep running in the background</h2>
        <p className="close-guard__body">
          Closing this window does not stop anything. Every terminal — and
          any agent running inside one — keeps running in the background
          daemon. Reopening TermX restores them exactly where you left them.
          Choose "Stop everything" below if you want to end all of it now.
        </p>

        <label className="close-guard__remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.currentTarget.checked)}
          />
          <span>Remember my choice</span>
        </label>

        <div className="close-guard__actions">
          <button
            type="button"
            className="close-guard__keep"
            onClick={() => onDecide("keep-running", remember)}
          >
            Keep running
          </button>
          <button
            type="button"
            className="close-guard__stop"
            onClick={() => onDecide("stop-all", remember)}
          >
            Stop everything
          </button>
        </div>
      </div>
    </div>
  );
}
