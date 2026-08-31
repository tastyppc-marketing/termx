/**
 * Plugin pane bindings (`plugin_panes_v1.json`) — the out-of-band map from a
 * reserved pane id to the plugin that owns it (plugin spec §4).
 *
 * WHY its own file rather than a field in `ui_state_v1.json`: (a) `parseUiState`
 * whitelists known fields and `serializeUiState` writes exactly those, so one
 * boot of an OLD build plus any ui-state write would DELETE an unknown key —
 * a separate file is invisible to old builds and survives a downgrade
 * untouched; (b) every window rewrites `ui_state_v1.json` whole from its own
 * snapshot with no single-writer discipline, so cross-window clobbering would
 * silently drop bindings.
 *
 * WHY it is not in the layout blob at all: `parseLayout` is all-or-nothing, so
 * a new node kind or field would make an older build read the whole workspace
 * as garbage. A reserved-id pane is an ORDINARY `{kind:"pane", sessionId}`
 * leaf to every build; only the binding tells this build it is a panel, and a
 * build that cannot see the binding degrades to a dismissible dead pane.
 *
 * The file gets the layout's single-writer discipline, in both directions:
 * the MAIN window is its only writer (`save` is `null` in every other window),
 * aux windows adopt main's broadcasts, and an aux window that wants to bind
 * FORWARDS the request to main (`onForward`) exactly as an aux layout edit is
 * forwarded — main applies, persists, and broadcasts the result back.
 */

/** One pane's binding. `path` overrides the manifest's default panel path. */
export interface PluginPaneBinding {
  pluginId: string;
  path?: string;
}

/** Keyed by `String(sessionId)` — JSON object keys are strings. */
export type PluginPanesV1 = Record<string, PluginPaneBinding>;

/**
 * Reserved id floor (2^31). Daemon session ids are small sequential u32s, and
 * `validateSplit` only requires u32 + global uniqueness, so ids in this range
 * are valid layout members today AND can never collide with a real session.
 */
export const PLUGIN_PANE_MIN_ID = 0x8000_0000;

const U32_MAX = 0xffff_ffff;

/** Bounded re-rolls: a collision is a coin flip, so 64 is already absurd. */
const ALLOCATION_ATTEMPTS = 64;

export function isPluginPaneId(id: number): boolean {
  return Number.isInteger(id) && id >= PLUGIN_PANE_MIN_ID && id <= U32_MAX;
}

/**
 * Pick a free reserved id. Random rather than sequential because the layout is
 * the only registry of ids in use and it is edited by several windows — a
 * counter would have to be persisted and reconciled, while a re-roll against
 * the live set needs no state at all.
 */
export function allocatePluginPaneId(
  taken: ReadonlySet<number>,
  random: () => number = Math.random,
): number {
  const span = U32_MAX - PLUGIN_PANE_MIN_ID + 1;
  for (let attempt = 0; attempt < ALLOCATION_ATTEMPTS; attempt += 1) {
    // A degenerate random source (0, 1, negative, NaN) must still yield a u32
    // in range: an out-of-range id would fail `validateSplit` and take the
    // whole layout write down with it.
    const roll = random();
    const offset = Number.isFinite(roll)
      ? Math.min(Math.max(Math.floor(roll * span), 0), span - 1)
      : 0;
    const id = PLUGIN_PANE_MIN_ID + offset;
    if (!taken.has(id)) {
      return id;
    }
  }
  throw new Error("Unable to allocate a free plugin pane id");
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A key is a binding key only if it is the canonical decimal spelling of a
 * RESERVED id. `"7"` (a real daemon session), `"1e9"`, and `"2147483648.0"`
 * are all rejected: the first would attach a plugin to somebody else's
 * terminal, and the other two can never equal `String(sessionId)` for any
 * pane, so they are dead weight that would survive every prune.
 */
function isBindingKey(key: string): boolean {
  const id = Number(key);
  return isPluginPaneId(id) && String(id) === key;
}

/**
 * Per-entry tolerant, like every other user-data parse in this app: a junk
 * entry is dropped rather than propagated, and a junk FILE reads as "no
 * bindings" — which renders every reserved pane as a dismissible dead pane
 * instead of crashing the workspace.
 */
export function parsePluginPanesValue(value: unknown): PluginPanesV1 {
  if (!isRecordObject(value)) {
    return {};
  }
  // Written as `{ version, panes }`; a hand-written bare record (the shape the
  // spec quotes) is read too, so an edited file is never silently ignored.
  const source = isRecordObject(value.panes) ? value.panes : value;
  const result: PluginPanesV1 = {};
  for (const [key, entry] of Object.entries(source)) {
    if (!isBindingKey(key)) {
      continue;
    }
    if (!isRecordObject(entry)) {
      continue;
    }
    const { pluginId, path } = entry;
    if (typeof pluginId !== "string" || pluginId.length === 0) {
      continue;
    }
    result[key] = {
      pluginId,
      ...(typeof path === "string" && path.length > 0 ? { path } : {}),
    };
  }
  return result;
}

/** Parse the bindings file (null = missing). Never throws. */
export function parsePluginPanes(text: string | null): PluginPanesV1 {
  if (text === null || text.length === 0) {
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  return parsePluginPanesValue(raw);
}

export function serializePluginPanes(state: PluginPanesV1): string {
  return `${JSON.stringify({ version: 1, panes: state }, null, 2)}\n`;
}

/**
 * A plain JSON deep copy, for handing the map to the window bus.
 *
 * Two jobs, both load-bearing. (a) It COPIES: `loopbackBus` delivers whatever
 * object it is given by reference, so broadcasting the live map would alias
 * main's state into every aux window — a later in-place edit in either window
 * would silently change the other, with nothing persisted. (b) It re-types:
 * an optional `path` is `string | undefined` under an index signature, which
 * is not a `JsonValue`; building the copy without absent fields makes the
 * value provably JSON instead of leaning on a cast that a future field could
 * quietly falsify.
 */
export function toJsonPluginPanes(
  state: PluginPanesV1,
): Record<string, Record<string, string>> {
  const copy: Record<string, Record<string, string>> = {};
  for (const [key, binding] of Object.entries(state)) {
    const entry: Record<string, string> = { pluginId: binding.pluginId };
    if (typeof binding.path === "string") {
      entry.path = binding.path;
    }
    copy[key] = entry;
  }
  return copy;
}

/** Same copy, typed as the store's own shape (see `toJsonPluginPanes`). */
export function clonePluginPanes(state: PluginPanesV1): PluginPanesV1 {
  const copy: PluginPanesV1 = {};
  for (const [key, binding] of Object.entries(state)) {
    copy[key] = {
      pluginId: binding.pluginId,
      ...(typeof binding.path === "string" ? { path: binding.path } : {}),
    };
  }
  return copy;
}

function sameBinding(
  left: PluginPaneBinding | undefined,
  right: PluginPaneBinding,
): boolean {
  return left?.pluginId === right.pluginId && left?.path === right.path;
}

function sameState(left: PluginPanesV1, right: PluginPanesV1): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) {
    return false;
  }
  return keys.every((key) => {
    const entry = right[key];
    return entry !== undefined && sameBinding(left[key], entry);
  });
}

/**
 * What a replica window asks the main window to do. Deliberately plugin-shaped
 * and transport-free: the bus wraps it in its own envelope, so this file knows
 * nothing about windows or events.
 */
export type PluginPanesRequest =
  | { op: "bind"; sessionId: number; binding: PluginPaneBinding }
  | { op: "unbind"; sessionIds: readonly number[] };

export interface PaneBindingsStoreOptions {
  initial: PluginPanesV1;
  /**
   * `null` in every non-main window: an aux window is a replica of the
   * bindings file and must never write it (single-writer rule).
   */
  save: ((text: string) => Promise<void>) | null;
  /** Main window: fan the new state out to the other windows over the bus. */
  onBroadcast?: (state: PluginPanesV1) => void;
  /**
   * Replica window: forward this change to the main window instead of applying
   * it. Wiring this is what MAKES a store a replica — a store without it edits
   * its own map (and persists if `save` is wired), which is the single-window
   * and legacy-fixture shape.
   *
   * WHY forward instead of edit-then-sync: main's next broadcast REPLACES the
   * replica's whole map, so a local edit here would appear and then snap back
   * the moment anything else changed. Round-tripping through main means the
   * binding the pane sees is the binding that was persisted.
   */
  onForward?: (request: PluginPanesRequest) => void;
}

/**
 * The live bindings map. Writes are NOT debounced (unlike ui-state): binding a
 * pane happens once per plugin pane the user opens, and a binding lost to a
 * crash costs a panel its identity on the next boot.
 */
export class PaneBindingsStore {
  private current: PluginPanesV1;
  private readonly save: ((text: string) => Promise<void>) | null;
  private readonly onBroadcast?: (state: PluginPanesV1) => void;
  private readonly onForward?: (request: PluginPanesRequest) => void;
  private readonly listeners = new Set<() => void>();
  private saveChain: Promise<void> = Promise.resolve();

  constructor(options: PaneBindingsStoreOptions) {
    this.current = options.initial;
    this.save = options.save;
    if (options.onBroadcast) {
      this.onBroadcast = options.onBroadcast;
    }
    if (options.onForward) {
      this.onForward = options.onForward;
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): PluginPanesV1 => this.current;

  /**
   * Bind one reserved pane id to a plugin. Persists (main) + broadcasts, or
   * forwards to main (replica). A non-reserved id is REFUSED: those ids belong
   * to real daemon sessions, and a binding on one would dress somebody's live
   * terminal up as a plugin panel.
   */
  bind = (sessionId: number, binding: PluginPaneBinding): void => {
    if (!isPluginPaneId(sessionId)) {
      return;
    }
    const key = String(sessionId);
    if (sameBinding(this.current[key], binding)) {
      return;
    }
    const normalized: PluginPaneBinding = {
      pluginId: binding.pluginId,
      ...(binding.path !== undefined ? { path: binding.path } : {}),
    };
    if (this.onForward) {
      this.onForward({ op: "bind", sessionId, binding: normalized });
      return;
    }
    this.commit({ ...this.current, [key]: normalized });
  };

  /**
   * Drop bindings for panes that are gone. Takes a list because it runs from
   * the closed-sessions sweep, which reports whole tabs at once; ids that were
   * never bound (ordinary panes) are simply absent and cost nothing.
   */
  unbind = (sessionIds: readonly number[]): void => {
    if (this.onForward) {
      // Forwarded unfiltered: only main knows the current map, and a replica
      // that "helpfully" dropped ids it cannot see would lose real unbinds.
      if (sessionIds.length > 0) {
        this.onForward({ op: "unbind", sessionIds: [...sessionIds] });
      }
      return;
    }
    const doomed = new Set(sessionIds.map((id) => String(id)));
    const next: PluginPanesV1 = {};
    let removed = false;
    for (const [key, binding] of Object.entries(this.current)) {
      if (doomed.has(key)) {
        removed = true;
        continue;
      }
      next[key] = binding;
    }
    if (!removed) {
      return;
    }
    this.commit(next);
  };

  /**
   * Drop every binding whose pane is no longer in the layout. Runs once at
   * main's boot: `bind` writes this file immediately and independently of
   * `LayoutPersistence`, so a crash between the two leaves a binding whose
   * pane never made it into the layout blob — an orphan that would otherwise
   * live forever (spec §4 forbids accumulating them).
   *
   * Replicas ignore it: main prunes and broadcasts the result. Callers must
   * only pass ids from a layout they actually parsed — pruning against an
   * empty fallback layout would delete every binding the user has.
   */
  prune = (keep: ReadonlySet<number>): void => {
    if (this.onForward) {
      return;
    }
    const next: PluginPanesV1 = {};
    let removed = false;
    for (const [key, binding] of Object.entries(this.current)) {
      if (keep.has(Number(key))) {
        next[key] = binding;
      } else {
        removed = true;
      }
    }
    if (!removed) {
      return;
    }
    this.commit(next);
  };

  /**
   * Take the main window's truth off the bus. Never persists and never
   * re-broadcasts — an echo between windows would be an infinite loop. The
   * incoming map is COPIED: `loopbackBus` delivers by reference, and sharing
   * main's object would make an edit in one window mutate the other.
   */
  adopt = (state: PluginPanesV1): void => {
    if (sameState(this.current, state)) {
      return;
    }
    this.current = clonePluginPanes(state);
    this.notify();
  };

  /** Await the pending write chain (the aux close path and tests need this). */
  flush = async (): Promise<void> => {
    await this.saveChain;
  };

  private commit(next: PluginPanesV1): void {
    this.current = next;
    this.notify();
    const save = this.save;
    if (save !== null) {
      const text = serializePluginPanes(next);
      // A failed write costs the binding on the next boot — a dismissible dead
      // pane, never a crash — so it stays contained here like every other
      // store's save path.
      this.saveChain = this.saveChain.then(() => save(text)).catch(() => undefined);
    }
    this.onBroadcast?.(next);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // One bad subscriber must not silence the others.
      }
    }
  }
}
