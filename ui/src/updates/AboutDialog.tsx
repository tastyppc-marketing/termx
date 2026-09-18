/**
 * "About TermX…": the four facts a support question needs. UI version and
 * daemon version come from the caller; the two folders are read from Tauri's
 * path API when the dialog opens, and print "unavailable" when the runtime
 * cannot answer (a browser preview, a test).
 */

import { useEffect, useState } from "react";
import { appDataDir, resourceDir } from "@tauri-apps/api/path";
import "./updates.css";

export interface AboutDialogProps {
  open: boolean;
  onClose(): void;
  uiVersion: string | undefined;
  hostVersion: string | null;
}

const UNAVAILABLE = "unavailable";

async function readDir(read: () => Promise<string>): Promise<string> {
  try {
    const value = await read();
    return value || UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

export function AboutDialog({ open, onClose, uiVersion, hostVersion }: AboutDialogProps) {
  const [installDir, setInstallDir] = useState<string | null>(null);
  const [dataDir, setDataDir] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    let live = true;
    void readDir(resourceDir).then((value) => { if (live) setInstallDir(value); });
    void readDir(appDataDir).then((value) => { if (live) setDataDir(value); });
    return () => { live = false; };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div className="about-backdrop" onClick={onClose}>
      <div
        className="about-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="About TermX"
        tabIndex={-1}
        ref={(node) => node?.focus()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h2>About TermX</h2>
        <dl className="about-dialog__facts">
          <dt>UI version</dt>
          <dd data-testid="about-ui-version">{uiVersion ?? UNAVAILABLE}</dd>
          <dt>Terminal daemon version</dt>
          <dd data-testid="about-host-version">{hostVersion ?? "not connected"}</dd>
          <dt>Install folder</dt>
          <dd data-testid="about-install-dir">{installDir ?? "…"}</dd>
          <dt>Data folder</dt>
          <dd data-testid="about-data-dir">{dataDir ?? "…"}</dd>
        </dl>
        <div className="about-dialog__actions">
          <button type="button" className="about-dialog__close" data-testid="about-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
