/**
 * Machine-written UI state (`ui_state_v1.json`): scope paths + recent
 * folders. Distinct from user settings — this file is ours to overwrite, but
 * parsing is still per-field tolerant so a corrupt file degrades to empty
 * state instead of crashing the workspace.
 *
 * CD reports arrive on every shell prompt, so the store deduplicates by
 * reference (pure updaters return the same object for no-ops) and debounces
 * disk writes.
 */

import { DEFAULT_TRAYS, type TrayId } from "../actions/registry";
import {
  DEFAULT_CHAT_DENSITY,
  DEFAULT_CHAT_VIEW_MODE,
  parseChatDensity,
  parseChatViewMode,
} from "../chat/chatDefaults";
import type { ChatDensity, ChatViewMode } from "../chat/types";
import type { ViewerGeometry } from "../viewer/viewerState";
import { EMPTY_SCOPE_PATHS, type ScopePathsState } from "./scopePaths";

export const RECENT_FOLDERS_CAP = 50;

/**
 * A pane's chat view state (chat-view spec §1), keyed by host session id.
 * Machine-written like the rest of this file, and deliberately NOT part of
 * `layout_v2` — flipping a pane into chat is not a layout change.
 */
export interface ChatPaneState {
  mode: ChatViewMode;
  density: ChatDensity;
}

export interface UiStateV1 {
  readonly scopePaths: ScopePathsState;
  readonly recentFolders: readonly string[];
  /**
   * Per-tray chip order (spec §14). Absent — or unparseable — means "use the
   * registry defaults"; a tray missing from the record falls back on its own.
   */
  readonly trayChips?: Partial<Record<TrayId, readonly string[]>>;
  /** Native viewer placement and visibility. Absent means the viewer defaults. */
  readonly viewerGeometry?: ViewerGeometry;
  /**
   * Sidebar width in px (polish P5). Absent — or unusable — means
   * `DEFAULT_SIDEBAR_WIDTH`; stored values are clamped to
   * [`MIN_SIDEBAR_WIDTH`, `MAX_SIDEBAR_WIDTH`] on parse AND on write, so a
   * hand-edited file can never wedge the sidebar off screen.
   */
  readonly sidebarWidth?: number;
  /**
   * Per-pane chat view state, keyed by session id. Absent — or unparseable —
   * means every pane starts on the defaults from `chatDefaults.ts`.
   */
  readonly chatPanes?: Readonly<Record<string, ChatPaneState>>;
}

export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 480;
export const DEFAULT_SIDEBAR_WIDTH = 260;

export const DEFAULT_UI_STATE: UiStateV1 = {
  scopePaths: EMPTY_SCOPE_PATHS,
  recentFolders: [],
};

function parsePathRecord(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, path] of Object.entries(value)) {
    if (typeof path === "string" && path.length > 0) {
      result[key] = path;
    }
  }
  return result;
}

/**
 * Tray config is optional: anything that is not an object of known tray ids
 * mapping to string arrays degrades to `undefined` (= registry defaults),
 * and junk entries inside a good array are dropped.
 */
function parseTrayChips(
  value: unknown,
): Partial<Record<TrayId, readonly string[]>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const result: Partial<Record<TrayId, readonly string[]>> = {};
  let found = false;
  for (const tray of Object.keys(DEFAULT_TRAYS) as TrayId[]) {
    const ids = record[tray];
    if (!Array.isArray(ids)) {
      continue;
    }
    result[tray] = ids.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    found = true;
  }
  return found ? result : undefined;
}

function parseViewerGeometry(value: unknown): ViewerGeometry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const dock = record.dock;
  const sizePx = record.sizePx;
  const state = record.state;
  if (
    (dock !== "right" && dock !== "bottom") ||
    typeof sizePx !== "number" ||
    !Number.isFinite(sizePx) ||
    sizePx <= 0 ||
    (state !== "hidden" &&
      state !== "docked" &&
      state !== "overlay" &&
      state !== "tray")
  ) {
    return undefined;
  }
  return { dock, sizePx, state };
}

/** Round and pin a width into the resizable range. */
export function clampSidebarWidth(width: number): number {
  return Math.min(
    Math.max(Math.round(width), MIN_SIDEBAR_WIDTH),
    MAX_SIDEBAR_WIDTH,
  );
}

/**
 * Width is optional: anything that is not a finite number degrades to
 * `undefined` (= the default width), and an out-of-range number is clamped
 * rather than dropped — the user did resize, the file is just stale or edited.
 */
function parseSidebarWidth(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return clampSidebarWidth(value);
}

/**
 * Chat state is optional per pane and per field: a record whose mode or
 * density is junk keeps whichever half parsed, and a pane with neither
 * disappears entirely rather than persisting an empty object.
 */
function parseChatPanes(
  value: unknown,
): Readonly<Record<string, ChatPaneState>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, ChatPaneState> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const mode = parseChatViewMode(record.mode);
    const density = parseChatDensity(record.density);
    if (mode === undefined && density === undefined) {
      continue;
    }
    result[key] = {
      mode: mode ?? DEFAULT_CHAT_VIEW_MODE,
      density: density ?? DEFAULT_CHAT_DENSITY,
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Store one pane's chat state. `null` is the reset sentinel — it drops the
 * pane's key so it falls back on the defaults, and the whole field disappears
 * once no pane is configured. Same-ref return when nothing changed: the pane
 * writes on every flip and an unchanged write must not schedule a save.
 */
export function setChatPaneState(
  state: UiStateV1,
  sessionId: string,
  chat: ChatPaneState | null,
): UiStateV1 {
  const current = state.chatPanes?.[sessionId];
  if (chat === null) {
    if (current === undefined) {
      return state;
    }
    const rest: Record<string, ChatPaneState> = {};
    for (const [key, value] of Object.entries(state.chatPanes ?? {})) {
      if (key !== sessionId) {
        rest[key] = value;
      }
    }
    if (Object.keys(rest).length > 0) {
      return { ...state, chatPanes: rest };
    }
    // Spread-then-delete keeps any unrelated fields this state may carry.
    const next: { -readonly [K in keyof UiStateV1]: UiStateV1[K] } = { ...state };
    delete next.chatPanes;
    return next;
  }
  if (current?.mode === chat.mode && current.density === chat.density) {
    return state;
  }
  return { ...state, chatPanes: { ...state.chatPanes, [sessionId]: chat } };
}

/** Parse ui-state text (null = missing file). Never throws. */
export function parseUiState(text: string | null): UiStateV1 {
  if (text === null) {
    return DEFAULT_UI_STATE;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return DEFAULT_UI_STATE;
  }
  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_UI_STATE;
  }
  const record = raw as Record<string, unknown>;
  const scopePathsRaw =
    typeof record.scopePaths === "object" && record.scopePaths !== null
      ? (record.scopePaths as Record<string, unknown>)
      : {};
  const recents = Array.isArray(record.recentFolders)
    ? record.recentFolders
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        .slice(0, RECENT_FOLDERS_CAP)
    : [];
  const trayChips = parseTrayChips(record.trayChips);
  const viewerGeometry = parseViewerGeometry(record.viewerGeometry);
  const sidebarWidth = parseSidebarWidth(record.sidebarWidth);
  const chatPanes = parseChatPanes(record.chatPanes);
  return {
    scopePaths: {
      seeds: parsePathRecord(scopePathsRaw.seeds),
      active: parsePathRecord(scopePathsRaw.active),
    },
    recentFolders: recents,
    ...(trayChips ? { trayChips } : {}),
    ...(viewerGeometry ? { viewerGeometry } : {}),
    ...(sidebarWidth !== undefined ? { sidebarWidth } : {}),
    ...(chatPanes ? { chatPanes } : {}),
  };
}

export function serializeUiState(state: UiStateV1): string {
  return `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`;
}

/** Move a folder to the front of the MRU. Same-ref when already at head. */
export function touchRecentFolder(state: UiStateV1, path: string): UiStateV1 {
  if (path.length === 0) {
    return state;
  }
  const normalized = path.toLowerCase();
  if (state.recentFolders[0]?.toLowerCase() === normalized) {
    return state;
  }
  const rest = state.recentFolders.filter(
    (entry) => entry.toLowerCase() !== normalized,
  );
  return {
    ...state,
    recentFolders: [path, ...rest].slice(0, RECENT_FOLDERS_CAP),
  };
}

export function updateScopePaths(
  state: UiStateV1,
  update: (paths: ScopePathsState) => ScopePathsState,
): UiStateV1 {
  const next = update(state.scopePaths);
  return next === state.scopePaths ? state : { ...state, scopePaths: next };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((id, index) => id === right[index])
  );
}

/**
 * Write one tray's chip list (spec §14). This is the only correct way to
 * apply a `Tray`/`FeaturesDock` `onConfigure` callback: `null` is the reset
 * sentinel — it deletes that tray's key so `trayChipIds` falls back on
 * `DEFAULT_TRAYS`, and the whole `trayChips` field disappears once no tray is
 * configured (a full "Reset layout" round-trips as an absent field). An empty
 * array is a real configuration ("user emptied this tray"), not a reset.
 * Same-ref return when the stored config already matches.
 */
export function applyTrayConfigure(
  state: UiStateV1,
  tray: TrayId,
  ids: readonly string[] | null,
): UiStateV1 {
  const current = state.trayChips?.[tray];

  if (ids === null) {
    if (current === undefined) {
      return state;
    }
    const rest: Partial<Record<TrayId, readonly string[]>> = {};
    for (const key of Object.keys(state.trayChips ?? {}) as TrayId[]) {
      const value = state.trayChips?.[key];
      if (key !== tray && value !== undefined) {
        rest[key] = value;
      }
    }
    if (Object.keys(rest).length > 0) {
      return { ...state, trayChips: rest };
    }
    // Spread-then-delete keeps any unrelated fields this state may carry.
    const next: { -readonly [K in keyof UiStateV1]: UiStateV1[K] } = { ...state };
    delete next.trayChips;
    return next;
  }

  if (current !== undefined && sameIds(current, ids)) {
    return state;
  }
  return { ...state, trayChips: { ...state.trayChips, [tray]: [...ids] } };
}

/**
 * Store the viewer's placement (spec §12). Same-ref when nothing actually
 * moved: the viewer reports geometry on every surface change, and an
 * unchanged report must not schedule a disk write.
 */
export function setViewerGeometry(
  state: UiStateV1,
  geometry: ViewerGeometry,
): UiStateV1 {
  const current = state.viewerGeometry;
  if (
    current !== undefined &&
    current.dock === geometry.dock &&
    current.sizePx === geometry.sizePx &&
    current.state === geometry.state
  ) {
    return state;
  }
  return { ...state, viewerGeometry: geometry };
}

/**
 * Store the sidebar width (polish P5). `null` is the reset sentinel — the
 * double-click on the drag handle — and deletes the field so the sidebar falls
 * back on `DEFAULT_SIDEBAR_WIDTH`; a number is clamped before it is stored, so
 * the store never holds a width the sidebar would not honour. Same-ref return
 * when nothing changes: a drag reports on every pointer move and an unchanged
 * report must not schedule a disk write. Junk (NaN/Infinity) is ignored rather
 * than treated as a reset — it must never destroy a stored width.
 */
export function setSidebarWidth(
  state: UiStateV1,
  width: number | null,
): UiStateV1 {
  if (width === null) {
    if (state.sidebarWidth === undefined) {
      return state;
    }
    // Spread-then-delete keeps any unrelated fields this state may carry.
    const next: { -readonly [K in keyof UiStateV1]: UiStateV1[K] } = { ...state };
    delete next.sidebarWidth;
    return next;
  }
  if (!Number.isFinite(width)) {
    return state;
  }
  const clamped = clampSidebarWidth(width);
  if (state.sidebarWidth === clamped) {
    return state;
  }
  return { ...state, sidebarWidth: clamped };
}

export interface UiStateStoreOptions {
  initial?: UiStateV1;
  save?: (text: string) => Promise<void>;
  onSaveError?: (error: unknown) => void;
  /** Trailing debounce for disk writes; CD reports fire every prompt. */
  debounceMs?: number;
}

export class UiStateStore {
  private current: UiStateV1;
  private readonly save?: (text: string) => Promise<void>;
  private readonly onSaveError?: (error: unknown) => void;
  private readonly debounceMs: number;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(options: UiStateStoreOptions = {}) {
    this.current = options.initial ?? DEFAULT_UI_STATE;
    if (options.save) {
      this.save = options.save;
    }
    if (options.onSaveError) {
      this.onSaveError = options.onSaveError;
    }
    this.debounceMs = options.debounceMs ?? 800;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): UiStateV1 => this.current;

  update = (mutation: (state: UiStateV1) => UiStateV1): void => {
    const next = mutation(this.current);
    if (next === this.current) {
      return;
    }
    this.current = next;
    for (const listener of [...this.listeners]) {
      listener();
    }
    this.scheduleSave();
  };

  /** Runs any pending save immediately and awaits the chain. */
  flush = async (): Promise<void> => {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.enqueueSave();
    }
    await this.saveChain;
  };

  private scheduleSave(): void {
    if (!this.save) {
      return;
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueueSave();
    }, this.debounceMs);
  }

  private enqueueSave(): void {
    const save = this.save;
    if (!save) {
      return;
    }
    const text = serializeUiState(this.current);
    this.saveChain = this.saveChain
      .then(() => save(text))
      .catch((error) => {
        this.onSaveError?.(error);
      });
  }
}

/** Load persisted ui state; a failed read yields empty state, never a throw. */
export async function loadUiStateStore(options: {
  read: () => Promise<string | null>;
  save?: (text: string) => Promise<void>;
  onSaveError?: (error: unknown) => void;
  debounceMs?: number;
}): Promise<UiStateStore> {
  let text: string | null = null;
  try {
    text = await options.read();
  } catch {
    text = null;
  }
  return new UiStateStore({
    initial: parseUiState(text),
    ...(options.save ? { save: options.save } : {}),
    ...(options.onSaveError ? { onSaveError: options.onSaveError } : {}),
    ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
  });
}
