/**
 * The optional-update banner across the top of the workspace. It appears only
 * once the installer is downloaded and verified, and only for a release the
 * user may decline; forced releases go through `ForcedUpdateModal` instead.
 */

import type { UpdateState } from "./types";
import "./updates.css";

export interface UpdateBannerProps {
  update: UpdateState;
  /** The version "Later" was pressed on; the banner stays hidden for it. */
  snoozedVersion: string | null;
  onInstall(): void;
  /** "Later": snooze this version until a newer one appears. */
  onLater(): void;
  /** "What's new": open the release page. */
  onNotes(): void;
}

export function UpdateBanner({ update, snoozedVersion, onInstall, onLater, onNotes }: UpdateBannerProps) {
  if (update.kind !== "ready" || update.result.forced || update.result.latestVersion === snoozedVersion) {
    return null;
  }
  return (
    <div className="update-banner" role="status" data-testid="update-banner">
      <span className="update-banner__text">
        TermX {update.result.latestVersion} is ready. It installs in a few seconds and reopens where you left off.
      </span>
      <span className="update-banner__actions">
        <button type="button" className="update-banner__install" data-testid="update-install" onClick={onInstall}>
          Install now
        </button>
        <button type="button" className="update-banner__later" data-testid="update-later" onClick={onLater}>
          Later
        </button>
        <button type="button" className="update-link" data-testid="update-notes" onClick={onNotes}>
          What's new
        </button>
      </span>
    </div>
  );
}
