/**
 * Features dock (spec §14): the discovery half of tray customization. Lists
 * every registered action with an "Add to <tray>" button per tray, plus
 * "Reset layout" which restores `DEFAULT_TRAYS` everywhere. Removal lives on
 * the chip itself (right-click a tray chip).
 *
 * Focus trap is the app's modal pattern — Escape closes, Tab wraps inside.
 */

import { useEffect, useRef } from "react";
import type { UiStateV1 } from "../workspace/uiState";
import {
  allActions,
  DEFAULT_TRAYS,
  trayChipIds,
  TRAY_LABELS,
  type TrayId,
} from "./registry";
import "./FeaturesDock.css";

export interface FeaturesDockProps {
  open: boolean;
  onClose(): void;
  uiState: UiStateV1;
  /** `null` = restore that tray's default layout. */
  onConfigure(trayId: TrayId, ids: readonly string[] | null): void;
}

const TRAYS = Object.keys(DEFAULT_TRAYS) as TrayId[];

export function FeaturesDock({
  open,
  onClose,
  uiState,
  onConfigure,
}: FeaturesDockProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      panelRef.current?.focus();
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const chips = allActions();

  const addTo = (tray: TrayId, id: string): void => {
    const ids = trayChipIds(uiState, tray);
    if (ids.includes(id)) {
      return; // already there — adding twice is a no-op
    }
    onConfigure(tray, [...ids, id]);
  };

  return (
    <div className="features-dock-backdrop">
      <div
        ref={panelRef}
        className="features-dock"
        role="dialog"
        aria-modal="true"
        aria-label="Features"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
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
        <h2>Features</h2>
        <p className="features-dock__hint">
          Every action TermX can put in a tray. Right-click a chip in a tray to
          remove it.
        </p>

        {chips.length === 0 ? (
          <p className="features-dock__empty">No actions registered yet.</p>
        ) : (
          <ul className="features-dock__list">
            {chips.map((chip) => (
              <li className="features-dock__row" key={chip.id}>
                <span className="features-dock__icon" aria-hidden="true">
                  {chip.icon}
                </span>
                <span className="features-dock__text">
                  <span className="features-dock__label">{chip.label}</span>
                  <span className="features-dock__id">{chip.id}</span>
                </span>
                <span className="features-dock__trays">
                  {TRAYS.map((tray) => {
                    const present = trayChipIds(uiState, tray).includes(chip.id);
                    const label = present
                      ? `${chip.label} is already in ${TRAY_LABELS[tray]}`
                      : `Add ${chip.label} to ${TRAY_LABELS[tray]}`;
                    return (
                      <button
                        key={tray}
                        type="button"
                        className="features-dock__add"
                        aria-label={label}
                        title={label}
                        {...(present ? { "aria-disabled": "true" } : {})}
                        onClick={() => addTo(tray, chip.id)}
                      >
                        {present
                          ? `✓ In ${TRAY_LABELS[tray]}`
                          : `Add to ${TRAY_LABELS[tray]}`}
                      </button>
                    );
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="features-dock__actions">
          <button
            type="button"
            className="features-dock__reset"
            onClick={() => {
              for (const tray of TRAYS) {
                onConfigure(tray, null);
              }
            }}
          >
            Reset layout
          </button>
          <button type="button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
