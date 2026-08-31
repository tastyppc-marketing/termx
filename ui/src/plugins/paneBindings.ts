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
 * The ONE rule for an optional panel path, applied identically by `bind`, by
 * the file parse, and by the bus payload parse. It has to be one rule: an
 * empty (or whitespace) path that survived in one place and was dropped in
 * another produced three spellings of the same binding — the main window would
 * hold `{pluginId, path: ""}` until the next boot read it back as `{pluginId}`,
 * while the same call from an aux window produced `{pluginId}` immediately,
 * and `sameBinding` counts those as different (a spurious rebroadcast).
 */
export function normalizePluginPath(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
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
    const panelPath = normalizePluginPath(path);
    result[key] = {
      pluginId,
      ...(panelPath !== undefined ? { path: panelPath } : {}),
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

/**
 * `save` is the discriminant, and it maps 1:1 to the window: a function makes
 * this the WRITER (the main window — it edits its own map, persists, and
 * broadcasts), `null` makes it a REPLICA (any other window — it forwards and
 * adopts, and can never write the file).
 *
 * The union is what stops the two halves being mixed: a writer cannot forward
 * to itself, and a replica cannot broadcast (that would echo main's own truth
 * back at it). A replica with no `onForward` has no channel to main at all, so
 * it is READ-ONLY — `bind`/`unbind` are dropped rather than applied locally,
 * because a local edit in a window that can neither persist nor forward is a
 * binding that exists nowhere else and vanishes at the next broadcast.
 */
export type PaneBindingsStoreOptions =
  | {
      initial: PluginPanesV1;
      save: (text: string) => Promise<void>;
      /** Fan the new state out to the other windows over the bus. */
      onBroadcast?: (state: PluginPanesV1) => void;
      onForward?: never;
    }
  | {
      initial: PluginPanesV1;
      save: null;
      /**
       * Ask the main window to make this change. Returning the delivery
       * promise is what lets `flush()` cover it — an aux window's close path
       * awaits `flush()`, and an unbind that is still in flight dies with the
       * webview.
       *
       * WHY forward instead of edit-then-sync: main's next broadcast REPLACES
       * the replica's whole map, so a local edit would appear and then snap
       * back the moment anything else changed. Round-tripping through main
       * means the binding the pane sees is the binding that was persisted.
       */
      onForward?: (request: PluginPanesRequest) => Promise<void> | void;
      onBroadcast?: never;
    };

/**
 * The live bindings map. Writes are NOT debounced (unlike ui-state): binding a
 * pane happens once per plugin pane the user opens, and a binding lost to a
 * crash costs a panel its identity on the next boot.
 */
export class PaneBindingsStore {
  private current: PluginPanesV1;
  private readonly save: ((text: string) => Promise<void>) | null;
  private readonly onBroadcast?: (state: PluginPanesV1) => void;
  private readonly onForward?: (request: PluginPanesRequest) => Promise<void> | void;
  /** `save === null`. Cached because every mutator branches on it. */
  private readonly replica: boolean;
  private readonly listeners = new Set<() => void>();
  private saveChain: Promise<void> = Promise.resolve();

  constructor(options: PaneBindingsStoreOptions) {
    this.current = options.initial;
    this.save = options.save;
    this.replica = options.save === null;
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
    const path = normalizePluginPath(binding.path);
    const normalized: PluginPaneBinding = {
      pluginId: binding.pluginId,
      ...(path !== undefined ? { path } : {}),
    };
    if (this.replica) {
      // Forwarded UNCONDITIONALLY, without the same-binding short-circuit: a
      // replica's map can be ahead of main's (a broadcast that failed to
      // emit is swallowed by design), and in that state a short-circuit would
      // make re-binding the same plugin silently un-re-assertable. Main
      // de-dupes on arrival, so the cost of a redundant forward is nil.
      this.forward({ op: "bind", sessionId, binding: normalized });
      return;
    }
    const key = String(sessionId);
    if (sameBinding(this.current[key], normalized)) {
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
    if (this.replica) {
      // Forwarded unfiltered: only main knows the current map, and a replica
      // that "helpfully" dropped ids it cannot see would lose real unbinds.
      if (sessionIds.length > 0) {
        this.forward({ op: "unbind", sessionIds: [...sessionIds] });
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
    if (this.replica) {
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

  /**
   * Await everything this store has started, in BOTH window roles: the main
   * window's file writes and a replica's forwarded requests share one chain.
   *
   * This has to cover the forward, not just the write. An aux window's close
   * path flushes before destroying its webview — an unbind still in flight
   * would die with it — and whatever binds a pane must await this before
   * persisting a layout that references the new binding, or the reserved pane
   * reaches the blob while the binding does not (a dismissible dead pane, and
   * the panel's identity is gone). In an aux window, a flush that only covered
   * writes would be a no-op and both guarantees would be fiction.
   */
  flush = async (): Promise<void> => {
    await this.saveChain;
  };

  /**
   * Queue a request to main on the SAME chain as the writer's disk writes, so
   * one `flush()` means "delivered" in either role. Delivery failures are
   * contained like a failed write: main's next broadcast is the truth anyway.
   */
  private forward(request: PluginPanesRequest): void {
    const onForward = this.onForward;
    if (onForward === undefined) {
      // A replica with no channel to main is READ-ONLY. Applying the change
      // locally would create a binding that exists in no file and in no other
      // window, and that main's next broadcast would erase.
      return;
    }
    this.saveChain = this.saveChain
      .then(() => onForward(request))
      .catch(() => undefined);
  }

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
