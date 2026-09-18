/**
 * Live settings store (useSyncExternalStore shape, like the layout store).
 *
 * Updates apply synchronously (every consumer reads the new value on the next
 * render) and persist asynchronously through a serialized save chain — writes
 * never interleave, and a failed save never breaks the in-memory state.
 */

import {
  DEFAULT_SETTINGS,
  parseSettings,
  serializeSettings,
  type TermxSettings,
} from "./settings";

export interface SettingsStoreOptions {
  initial?: TermxSettings;
  /** True when no settings file existed at load (a first run). Default false. */
  wasCreated?: boolean;
  /** Persist serialized settings; omitted = in-memory only (tests, fallback). */
  save?: (text: string) => Promise<void>;
  onSaveError?: (error: unknown) => void;
}

export class SettingsStore {
  /**
   * Whether this store was built from a missing file rather than a saved
   * one. The first-run welcome keys off it; nothing else should.
   */
  readonly wasCreated: boolean;
  private current: TermxSettings;
  private readonly save?: (text: string) => Promise<void>;
  private readonly onSaveError?: (error: unknown) => void;
  private readonly listeners = new Set<() => void>();
  private saveChain: Promise<void> = Promise.resolve();

  constructor(options: SettingsStoreOptions = {}) {
    this.current = options.initial ?? DEFAULT_SETTINGS;
    this.wasCreated = options.wasCreated ?? false;
    if (options.save) {
      this.save = options.save;
    }
    if (options.onSaveError) {
      this.onSaveError = options.onSaveError;
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): TermxSettings => this.current;

  update = (patch: Partial<TermxSettings>): void => {
    const next = { ...this.current, ...patch };
    // Driven by the patch's own keys rather than a hand-listed comparison of
    // every field: `next` can only differ from `current` where the patch
    // touched it, and a field missing from a hand-written list is silently
    // unsaveable (the maxGroupDepth-swallow bug, which every new settings
    // batch would otherwise re-introduce).
    const changed = (Object.keys(patch) as (keyof TermxSettings)[]).some(
      (key) => next[key] !== this.current[key],
    );
    if (!changed) {
      return;
    }
    this.current = next;
    for (const listener of [...this.listeners]) {
      listener();
    }
    this.enqueueSave(next);
  };

  /**
   * Persist the current settings as they are, changed or not. `update`
   * ignores no-op patches by design, so this is the one way to make sure the
   * file exists (the welcome screen's Skip: the file's presence is what stops
   * the screen from returning). Notifies nobody; the value did not change.
   */
  touch = (): void => {
    this.enqueueSave(this.current);
  };

  private enqueueSave(settings: TermxSettings): void {
    const save = this.save;
    if (!save) {
      return;
    }
    const text = serializeSettings(settings);
    this.saveChain = this.saveChain
      .then(() => save(text))
      .catch((error) => {
        this.onSaveError?.(error);
      });
  }

  /** Awaits all queued saves (tests and teardown). */
  flush = (): Promise<void> => this.saveChain;
}

/**
 * Load settings and build the live store. A failed read yields defaults —
 * settings must never block workspace startup.
 */
export async function loadSettingsStore(options: {
  read: () => Promise<string | null>;
  save?: (text: string) => Promise<void>;
  onSaveError?: (error: unknown) => void;
}): Promise<SettingsStore> {
  let text: string | null = null;
  try {
    text = await options.read();
  } catch {
    text = null;
  }
  return new SettingsStore({
    initial: parseSettings(text),
    wasCreated: text === null,
    ...(options.save ? { save: options.save } : {}),
    ...(options.onSaveError ? { onSaveError: options.onSaveError } : {}),
  });
}
