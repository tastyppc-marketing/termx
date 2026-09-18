/**
 * First-run modal: pick the workspace folder every new terminal opens in.
 *
 * Not dismissable by Escape or the backdrop. Skip is the explicit way out,
 * and it still persists the settings file so the screen never comes back.
 */

import { useEffect, useRef, useState } from "react";
import type { FolderPicker } from "../native/dialog";
import "./Welcome.css";

export interface WelcomeProps {
  open: boolean;
  pickFolder: FolderPicker;
  onStart(root: string): void;
  onSkip(): void;
}

export function Welcome({ open, pickFolder, onStart, onSkip }: WelcomeProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [root, setRoot] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      ref.current?.focus();
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div className="welcome-backdrop">
      <div
        ref={ref}
        className="welcome"
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to TermX"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <h1 className="welcome__title">Welcome to TermX</h1>
        <p className="welcome__body">
          Pick the folder your work lives in. New terminals open there. You can
          change it any time in Settings.
        </p>
        <div className="welcome__row">
          <span className="welcome__path" data-testid="welcome-path">
            {root ?? "No folder chosen"}
          </span>
          <button
            type="button"
            className="welcome__choose"
            data-testid="welcome-choose"
            onClick={() => {
              void pickFolder({ title: "Choose your workspace folder" }).then(
                (picked) => {
                  if (picked) {
                    setRoot(picked);
                  }
                },
              );
            }}
          >
            Choose folder…
          </button>
        </div>
        <div className="welcome__actions">
          <button type="button" data-testid="welcome-skip" onClick={onSkip}>
            Skip
          </button>
          <button
            type="button"
            className="welcome__primary"
            data-testid="welcome-start"
            disabled={root === null}
            onClick={() => {
              if (root) {
                onStart(root);
              }
            }}
          >
            Start
          </button>
        </div>
        <p className="welcome__hint">
          Updates come from GitHub. Run <code>gh auth login</code> once so TermX
          can fetch them.
        </p>
      </div>
    </div>
  );
}
