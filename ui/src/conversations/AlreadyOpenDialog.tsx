import { useEffect, useRef } from "react";
import "./AlreadyOpenDialog.css";

export interface AlreadyOpenDialogProps {
  /** Whether the dialog is showing. Renders nothing when false. */
  open: boolean;
  /** Activate the already-open tab and dismiss the dialog. */
  onSwitch(): void;
  /** Resume anyway (`resumeSession(record, { force: true })`) and dismiss. */
  onOpenAnyway(): void;
  /** Esc, or any other "never mind" affordance. */
  onCancel(): void;
}

/**
 * Resume dedupe dialog (polish spec P6): shown when `resumeSession` answers
 * `already-open` for the record the user just tried to resume. Clones the
 * focus-trap/backdrop pattern from `CloseGuard`.
 */
export function AlreadyOpenDialog({
  open,
  onSwitch,
  onOpenAnyway,
  onCancel,
}: AlreadyOpenDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      dialogRef.current?.focus();
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div className="already-open-dialog-backdrop">
      <div
        ref={dialogRef}
        className="already-open-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="This session is already open"
        tabIndex={-1}
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
            event.currentTarget.querySelectorAll<HTMLElement>(
              "button:not(:disabled)",
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
        <h2>This session is already open</h2>
        <p className="already-open-dialog__body">
          This session is already open. Switch to that tab?
        </p>

        <div className="already-open-dialog__actions">
          <button
            type="button"
            className="already-open-dialog__open-anyway"
            onClick={() => onOpenAnyway()}
          >
            Open anyway
          </button>
          <button
            type="button"
            className="already-open-dialog__switch"
            onClick={() => onSwitch()}
          >
            Switch
          </button>
        </div>
      </div>
    </div>
  );
}
