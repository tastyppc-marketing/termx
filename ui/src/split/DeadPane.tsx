export interface DeadPaneProps {
  exitCode: number | null;
  known: boolean;
  dismissing: boolean;
  restarting: boolean;
  /** Title of the conversation "Resume conversation" would bring back; null
   * hides the button (no directory, no conversation recorded there). */
  resumeTitle?: string | null;
  onDismiss(): void;
  onRestart(): void;
  onResume?(): void;
  onNewSession(): void;
}

/// Placeholder for a pane whose session is no longer alive (layout_v1
/// restore rule 1). Restart relaunches the same profile + cwd in this slot,
/// New session launches workspace defaults here instead, and Dismiss prunes
/// the pane — freeing the scrollback ring via CloseSession when the host
/// still knows the session.
export function DeadPane({
  exitCode,
  known,
  dismissing,
  restarting,
  resumeTitle,
  onDismiss,
  onRestart,
  onResume,
  onNewSession,
}: DeadPaneProps) {
  const busy = dismissing || restarting;
  return (
    <div className="dead-pane" data-testid="dead-pane" role="status">
      <div className="dead-pane__mark" aria-hidden="true">›_</div>
      <div className="dead-pane__title">Session ended</div>
      <div className="dead-pane__detail">
        {known && exitCode !== null
          ? `The shell exited with code ${exitCode}.`
          : "This terminal is no longer running."}
      </div>
      <div className="dead-pane__actions">
        {resumeTitle && onResume ? (
          <button
            type="button"
            className="dead-pane__action dead-pane__action--primary dead-pane__resume"
            disabled={busy}
            title={resumeTitle}
            onClick={onResume}
          >
            {restarting ? "Resuming…" : "Resume conversation"}
          </button>
        ) : null}
        <button
          type="button"
          className={
            resumeTitle && onResume
              ? "dead-pane__action dead-pane__restart"
              : "dead-pane__action dead-pane__action--primary dead-pane__restart"
          }
          disabled={busy}
          onClick={onRestart}
        >
          {restarting ? "Restarting…" : "Restart session"}
        </button>
        <button
          type="button"
          className="dead-pane__action dead-pane__new-session"
          disabled={busy}
          onClick={onNewSession}
        >
          New session
        </button>
        <button
          type="button"
          className="dead-pane__action dead-pane__dismiss"
          disabled={busy}
          onClick={onDismiss}
        >
          {dismissing ? "Dismissing…" : "Dismiss"}
        </button>
      </div>
    </div>
  );
}
