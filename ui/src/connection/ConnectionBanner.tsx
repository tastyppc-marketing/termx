import { useEffect, useState } from "react";
import type { ConnectionState } from "../host/reconnect";
import "./ConnectionBanner.css";

/**
 * After this long without a connection the banner stops implying it is about
 * to succeed. The machine keeps retrying regardless — this is a label, not a
 * give-up.
 */
export const STILL_TRYING_MS = 120_000;

export interface ConnectionBannerProps {
  state: ConnectionState;
  /** The "Restart host" action: re-runs the bootstrap immediately. */
  onRetry: () => void;
}

/**
 * Says out loud that the host connection is gone and being rebuilt.
 *
 * Silent during the ordinary startup connect: the first thing a user sees on
 * launch must not be an error flash for a connection that is simply not
 * finished yet.
 */
export function ConnectionBanner({ state, onRetry }: ConnectionBannerProps) {
  const offline = isOffline(state);
  const [stillTrying, setStillTrying] = useState(false);

  useEffect(() => {
    if (!offline) {
      setStillTrying(false);
      return;
    }
    // Keyed on `offline` alone, so individual retry attempts do not restart
    // the clock — this measures one CONTINUOUS outage.
    const handle = setTimeout(() => setStillTrying(true), STILL_TRYING_MS);
    return () => clearTimeout(handle);
  }, [offline]);

  if (!offline) {
    return null;
  }

  const failed = state.phase === "failed";
  return (
    <div
      className={`connection-banner${failed ? " connection-banner--failed" : ""}`}
      role="status"
      aria-live="polite"
      data-testid="connection-banner"
    >
      <span className="connection-banner__text">
        {bannerText(state, stillTrying)}
      </span>
      {failed ? (
        <button type="button" className="connection-banner__action" onClick={onRetry}>
          Restart host
        </button>
      ) : null}
    </div>
  );
}

function isOffline(state: ConnectionState): boolean {
  if (state.phase === "connected") {
    return false;
  }
  // The very first connect of the session is normal startup, not an outage.
  return !(state.phase === "connecting" && state.isInitial);
}

function bannerText(state: ConnectionState, stillTrying: boolean): string {
  if (state.phase === "failed") {
    return `Host connection failed — ${state.reason}`;
  }
  const suffix = stillTrying ? " — still trying" : "";
  if (state.phase === "reconnecting") {
    return `Reconnecting to host… (attempt ${state.attempt})${suffix}`;
  }
  return `Reconnecting to host…${suffix}`;
}
