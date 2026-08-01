import "./SleepingPane.css";

export interface SleepingPaneProps {
  sessionId: number;
  onWake(): void;
}

/// Placeholder shown in place of <TerminalPane> while a hidden pane sleeps
/// (spec §13). The session itself is untouched — the host daemon keeps it
/// running; only this renderer's xterm and its logical attachment were
/// released. Revealing the tab wakes the pane automatically; clicking here
/// wakes it explicitly.
export function SleepingPane({ sessionId, onWake }: SleepingPaneProps) {
  return (
    <button
      type="button"
      className="sleeping-pane"
      data-testid={`sleeping-pane-${sessionId}`}
      aria-label="Sleeping terminal — activate to reattach"
      onClick={onWake}
    >
      <span className="sleeping-pane__mark" aria-hidden="true">zZ</span>
      <span className="sleeping-pane__title">Terminal sleeping</span>
      <span className="sleeping-pane__detail">
        The session keeps running. Reattaches with its scrollback on wake.
      </span>
    </button>
  );
}
