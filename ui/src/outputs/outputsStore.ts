/**
 * Live output registrations (spec P4), keyed by termx session id.
 *
 * Runtime-only: the JSONL sidecar written by `termx-output` is the source of
 * truth for history, so this store holds nothing but what arrived over OSC
 * `9;77;output;<path>` during THIS app run. The pane merges the two.
 *
 * `useSyncExternalStore` shape (`subscribe` + a snapshot getter): the array a
 * session's snapshot returns is replaced, never mutated, so an unchanged
 * session keeps returning the identical reference and cannot loop a render.
 */

export interface LiveOutput {
  readonly path: string;
  readonly atMs: number;
}

const EMPTY: readonly LiveOutput[] = Object.freeze([]);

export class OutputsStore {
  private readonly bySession = new Map<number, readonly LiveOutput[]>();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Record one live registration. Empty paths are ignored (a malformed OSC
   * payload must never add a row). A repeat of a known path keeps the NEWEST
   * timestamp of the two and moves the row to the front of its time slot.
   */
  register = (sessionId: number, path: string, atMs: number): void => {
    if (path.length === 0) {
      return;
    }
    const current = this.bySession.get(sessionId) ?? EMPTY;
    const previous = current.find((entry) => entry.path === path);
    const entry: LiveOutput = {
      path,
      atMs: previous && previous.atMs > atMs ? previous.atMs : atMs,
    };
    const rest = current.filter((candidate) => candidate.path !== path);
    // Newest first; an equal timestamp puts the just-registered row first.
    let index = 0;
    while (index < rest.length && rest[index]!.atMs > entry.atMs) {
      index += 1;
    }
    this.bySession.set(sessionId, [...rest.slice(0, index), entry, ...rest.slice(index)]);
    this.notify();
  };

  /** Newest first, deduped by path. Stable reference until the session changes. */
  snapshotFor = (sessionId: number): readonly LiveOutput[] =>
    this.bySession.get(sessionId) ?? EMPTY;

  /** Drop a session's live registrations (tab closed / session gone). */
  clear = (sessionId: number): void => {
    if (this.bySession.delete(sessionId)) {
      this.notify();
    }
  };

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
