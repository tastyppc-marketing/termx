/**
 * A tray renders the persisted, ordered chip list for one slot (spec §14)
 * instead of hardcoded buttons. Customization v1 is menu-driven and
 * dependency-free: right-click a chip → "Remove from tray". Every edit goes
 * out through `onConfigure`; the caller persists it via `UiStateStore`.
 */

import { useState } from "react";
import { ContextMenu, type MenuPoint } from "../sidebar/ContextMenu";
import type { UiStateV1 } from "../workspace/uiState";
import {
  getAction,
  trayChipIds,
  TRAY_LABELS,
  type ActionChip,
  type ActionContext,
  type TrayId,
} from "./registry";
import "./Tray.css";

export interface TrayProps {
  trayId: TrayId;
  /** Opaque bag handed to the chip's `run`; the App owns its shape. */
  context: ActionContext;
  uiState: UiStateV1;
  /** `null` = restore this tray's default layout. */
  onConfigure(trayId: TrayId, ids: readonly string[] | null): void;
}

export function Tray({ trayId, context, uiState, onConfigure }: TrayProps) {
  const [menu, setMenu] = useState<{ chipId: string; point: MenuPoint } | null>(
    null,
  );

  const ids = trayChipIds(uiState, trayId);
  const chips = ids.flatMap((id): ActionChip[] => {
    const chip = getAction(id);
    return chip ? [chip] : [];
  });

  return (
    <div className="tray" role="toolbar" aria-label={`${TRAY_LABELS[trayId]} actions`}>
      {chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          className="tray__chip"
          aria-label={chip.label}
          title={chip.label}
          onClick={() => chip.run(context)}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({
              chipId: chip.id,
              point: { x: event.clientX, y: event.clientY },
            });
          }}
        >
          <span aria-hidden="true">{chip.icon}</span>
        </button>
      ))}
      {menu ? (
        <ContextMenu
          label="Chip actions"
          point={menu.point}
          onClose={() => setMenu(null)}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onConfigure(trayId, ids.filter((id) => id !== menu.chipId));
              setMenu(null);
            }}
          >
            Remove from tray
          </button>
        </ContextMenu>
      ) : null}
    </div>
  );
}
