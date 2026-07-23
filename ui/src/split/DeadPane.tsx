export interface DeadPaneProps {
  exitCode: number | null;
  known: boolean;
  dismissing: boolean;
  onDismiss(): void;
}

/// Placeholder for a pane whose session is no longer alive (layout_v1
/// restore rule 1). Dismiss prunes the pane and, when the host still knows
/// the session, frees its scrollback ring via CloseSession.
export function DeadPane({ exitCode, known, dismissing, onDismiss }: DeadPaneProps) {
  return (
    <div className="dead-pane" data-testid="dead-pane" role="status">
      <div className="dead-pane__mark" aria-hidden="true">›_</div>
      <div className="dead-pane__title">Session ended</div>
      <div className="dead-pane__detail">
        {known && exitCode !== null
          ? `The shell exited with code ${exitCode}.`
          : "This terminal is no longer running."}
      </div>
      <button
        type="button"
        className="dead-pane__dismiss"
        disabled={dismissing}
        onClick={onDismiss}
      >
        {dismissing ? "Dismissing…" : "Dismiss"}
      </button>
    </div>
  );
}
