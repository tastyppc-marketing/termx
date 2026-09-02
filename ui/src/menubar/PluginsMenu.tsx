/**
 * The Plugins launcher — the menubar's answer to "open Recall", which until
 * now meant Settings → Plugins → Open, every single time.
 *
 * A row is the plugin: its glyph, its name, and a dot for whether its server
 * is answering. On the right are the PLACEMENT CHIPS, one per surface the
 * plugin's manifest allows, with its default filled. Pressing the row takes
 * the default; pressing a chip takes that surface instead. A surface the
 * plugin refuses is not drawn at all — a chip you cannot press is worse than
 * no chip.
 *
 * Presentational on purpose. What "open" means — focus an existing pane, split
 * beside the focused one, tear a tab out into a window, or refuse because the
 * room is too small — is `openPlugin`'s policy, and the menu holds no second
 * copy of it. That is also why pressing a ROW passes no surface: the default
 * lives in the manifest, and the controller is the one reading it.
 */

import { useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  PLUGIN_SURFACES,
  type PluginSurface,
  type PluginSurfaces,
} from "../plugins/manifest";
import "./PluginsMenu.css";

/** What each surface is called in a 3-letter-ish chip. */
const CHIP_LABEL: Record<PluginSurface, string> = {
  tab: "Tab",
  split: "Split",
  window: "Win",
};

/**
 * A plugin as the launcher sees it.
 *
 * `status` is three-valued on purpose: "registered but not running" and
 * "switched off" are different answers to "why is nothing happening", and the
 * dot is where a user reads which one they are looking at.
 */
export interface PluginsMenuRow {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly status: "up" | "down" | "disabled";
  readonly autostart: boolean;
  /** Resolved placement — `surfacesOf(manifest)`, never the raw field. */
  readonly surfaces: PluginSurfaces;
}

export interface PluginsMenuProps {
  rows: readonly PluginsMenuRow[];
  /** Omit the surface to take the plugin's own default. */
  onOpen(pluginId: string, surface?: PluginSurface): void;
  /** A disabled row and the foot row both lead to Settings › Plugins. */
  onManage(): void;
  /** Dismiss the menu. Called after every action. */
  onDone(): void;
}

export function PluginsMenu({ rows, onOpen, onManage, onDone }: PluginsMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  /**
   * Left and Right walk the controls of ONE row — its name, then its chips.
   *
   * The key is claimed only while there is somewhere to go inside the row. At
   * either end it is let through untouched, so the menubar's own Left/Right
   * still moves to the neighbouring menu instead of the user being trapped in
   * a strip of chips with no way back out to View.
   */
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    const active = document.activeElement;
    const row = active instanceof Element ? active.closest(".plugins-menu__row") : null;
    if (!row) {
      return;
    }
    const controls = [
      ...row.querySelectorAll<HTMLElement>("button[role='menuitem']"),
    ];
    const next = controls.indexOf(active as HTMLElement) +
      (event.key === "ArrowRight" ? 1 : -1);
    const target = next < 0 ? undefined : controls[next];
    if (!target) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    target.focus();
  };

  return (
    <div ref={rootRef} className="plugins-menu" onKeyDown={handleKeyDown}>
      <div className="menubar__section">Registered</div>
      {rows.length === 0 ? (
        <div className="plugins-menu__empty">No plugins registered yet.</div>
      ) : null}
      {rows.map((row) => {
        const off = row.status === "disabled";
        return (
          <div className="plugins-menu__row" data-plugin-id={row.id} key={row.id}>
            <button
              type="button"
              className="menubar__row plugins-menu__open"
              data-row-id={`plugin-${row.id}`}
              role="menuitem"
              onClick={() => {
                onDone();
                if (off) {
                  onManage();
                } else {
                  onOpen(row.id);
                }
              }}
            >
              <span className="plugins-menu__icon" aria-hidden="true">
                {row.icon}
              </span>
              <span
                className={`plugins-menu__dot plugins-menu__dot--${row.status}`}
                aria-hidden="true"
              />
              <span className="menubar__label">
                {row.name}
                {row.autostart ? (
                  <span className="plugins-menu__auto"> · starts with TermX</span>
                ) : null}
              </span>
              {off ? <span className="menubar__key">Enable in Settings…</span> : null}
            </button>
            {off ? null : (
              <span className="plugins-menu__chips">
                {PLUGIN_SURFACES.filter((surface) =>
                  row.surfaces.allowed.includes(surface),
                ).map((surface) => (
                  <button
                    type="button"
                    key={surface}
                    className={`plugins-menu__chip${
                      surface === row.surfaces.default
                        ? " plugins-menu__chip--default"
                        : ""
                    }`}
                    data-row-id={`chip-${row.id}-${surface}`}
                    // The vertical walk steps over these: they sit BESIDE the
                    // row on their own axis, and visiting each of them on the
                    // way down would turn one plugin into four stops.
                    data-menu-skip=""
                    role="menuitem"
                    aria-label={`Open ${row.name} — ${CHIP_LABEL[surface]}`}
                    onClick={() => {
                      onDone();
                      onOpen(row.id, surface);
                    }}
                  >
                    {CHIP_LABEL[surface]}
                  </button>
                ))}
              </span>
            )}
          </div>
        );
      })}
      <div className="menubar__divider" role="separator" />
      <button
        type="button"
        className="menubar__row"
        data-row-id="manage-plugins"
        role="menuitem"
        onClick={() => {
          onDone();
          onManage();
        }}
      >
        <span className="menubar__label">Manage plugins…</span>
        <span className="menubar__key">Settings › Plugins</span>
      </button>
    </div>
  );
}
