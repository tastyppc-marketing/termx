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
import { EMPTY_SCOPE_PATHS, type ScopePathsState } from "./scopePaths";

export const RECENT_FOLDERS_CAP = 50;

export interface UiStateV1 {
  readonly scopePaths: ScopePathsState;
  readonly recentFolders: readonly string[];
  /**
   * Per-tray chip order (spec §14). Absent — or unparseable — means "use the
   * registry defaults"; a tray missing from the record falls back on its own.
   */
  readonly trayChips?: Partial<Record<TrayId, readonly string[]>>;
}

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
  return {
    scopePaths: {
      seeds: parsePathRecord(scopePathsRaw.seeds),
      active: parsePathRecord(scopePathsRaw.active),
    },
    recentFolders: recents,
    ...(trayChips ? { trayChips } : {}),
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
