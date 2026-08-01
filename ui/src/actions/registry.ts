/**
 * Action registry (spec §14): every toolbar/rail button is an action chip
 * `{ id, icon, label, run }` registered once in this module-level map, and
 * every tray renders a persisted, ordered id list from `ui_state_v1.json`
 * instead of hardcoded buttons.
 *
 * Importing this module is side-effect-free — it registers nothing on its
 * own, so `allActions()` reflects exactly what the app (or a test) put in.
 * Config is a few small string arrays: zero runtime cost, unknown ids in a
 * stale config are ignored, and "Reset layout" restores `DEFAULT_TRAYS`.
 */

import type { UiStateV1 } from "../workspace/uiState";

/** Opaque bag the App supplies to every `run`; each action reads its own keys. */
export interface ActionContext {
  [key: string]: unknown;
}

export interface ActionChip {
  id: string;
  icon: string;
  label: string;
  run: (ctx: ActionContext) => void;
}

export type TrayId = "sidebar-footer" | "pane-toolbar" | "viewer-header";

/**
 * Shipped layout. The sidebar footer mirrors its pre-tray chrome
 * (folder-search + settings); `new-tab` is registered but not shown by
 * default because the footer's primary New-terminal button stays native
 * (it carries busy state a chip cannot) — the Features dock can add it to
 * any tray. The other trays start empty.
 */
export const DEFAULT_TRAYS: Record<TrayId, readonly string[]> = {
  "sidebar-footer": ["folder-search", "settings", "features"],
  "pane-toolbar": [],
  "viewer-header": [],
};

/** User-facing tray names — one source of truth for Tray + Features dock. */
export const TRAY_LABELS: Record<TrayId, string> = {
  "sidebar-footer": "Sidebar footer",
  "pane-toolbar": "Pane toolbar",
  "viewer-header": "Viewer header",
};

const actions = new Map<string, ActionChip>();

/** Idempotent by id: re-registering the same id replaces it (last wins). */
export function registerAction(chip: ActionChip): void {
  actions.set(chip.id, chip);
}

export function getAction(id: string): ActionChip | undefined {
  return actions.get(id);
}

/** Registration order, deduplicated by id. */
export function allActions(): readonly ActionChip[] {
  return [...actions.values()];
}

/**
 * Resolve a tray's chip ids: persisted config when present, otherwise the
 * default layout. Unknown (unregistered) ids and duplicates are dropped so a
 * stale or hand-edited config can never break a render.
 */
export function trayChipIds(state: UiStateV1, tray: TrayId): readonly string[] {
  const configured = state.trayChips?.[tray];
  const ids = Array.isArray(configured) ? configured : DEFAULT_TRAYS[tray];
  const seen = new Set<string>();
  return ids.filter((id) => {
    if (!actions.has(id) || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}
