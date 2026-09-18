/**
 * The "finish the update" banner: the UI has already been replaced, but the
 * daemon still running is the old one. Restarting it ends every live
 * terminal, so the banner says how many and waits for a click (the app also
 * restarts on its own once the count reaches zero).
 */

import "./updates.css";

export interface HostRestartBannerProps {
  open: boolean;
  liveCount: number;
  onRestart(): void;
  /** A failed restart keeps the banner and shows why. */
  error?: string | null;
}

export function HostRestartBanner({ open, liveCount, onRestart, error }: HostRestartBannerProps) {
  if (!open) {
    return null;
  }
  return (
    <div className="host-restart-banner" role="status" data-testid="host-restart-banner">
      <span className="host-restart-banner__text">
        Restart terminals to finish the update ({liveCount} will close)
        {error ? <span className="host-restart-banner__error"> {error}</span> : null}
      </span>
      <button type="button" className="host-restart-banner__button" data-testid="host-restart" onClick={onRestart}>
        Restart now
      </button>
    </div>
  );
}
