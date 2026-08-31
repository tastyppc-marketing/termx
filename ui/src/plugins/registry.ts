import { BUNDLED_MANIFESTS } from "./bundled";
import {
  isValidPluginId,
  parseManifest,
  type PluginManifest,
} from "./manifest";

export interface PluginEntry {
  path: string;
  enabled: boolean;
  grants: string[];
}

export interface PluginsV1 {
  plugins: Record<string, PluginEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse registry text without letting one damaged entry block startup. */
export function parsePluginsFile(text: string | null): PluginsV1 {
  if (text === null) {
    return { plugins: {} };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { plugins: {} };
  }
  if (!isRecord(raw) || !isRecord(raw.plugins)) {
    return { plugins: {} };
  }

  const entries: [string, PluginEntry][] = [];
  for (const [id, value] of Object.entries(raw.plugins)) {
    // An id outside the manifest's alphabet can never match a manifest, and a
    // case variant would shadow the real entry, so drop it rather than keep it.
    if (
      !isValidPluginId(id) ||
      !isRecord(value) ||
      typeof value.path !== "string" ||
      value.path.length === 0
    ) {
      continue;
    }
    const grants = Array.isArray(value.grants)
      ? [
          ...new Set(
            value.grants.filter(
              (grant): grant is string =>
                typeof grant === "string" && grant.length > 0,
            ),
          ),
        ]
      : [];
    entries.push([
      id,
      {
        path: value.path,
        enabled: typeof value.enabled === "boolean" ? value.enabled : false,
        grants,
      },
    ]);
  }
  return { plugins: Object.fromEntries(entries) };
}

export function serializePluginsFile(state: PluginsV1): string {
  return `${JSON.stringify({ plugins: state.plugins }, null, 2)}\n`;
}

/**
 * The manifest for `id`: the plugin's own file when `fileText` is given, else
 * the bundled table. A malformed file yields null — this function does NOT
 * fall back to the bundled entry, because "the file is authoritative" is only
 * one possible policy and the CALLER owns that choice. Bootstrap, for one,
 * deliberately falls back so a first-party plugin whose repository grew a
 * broken file keeps working.
 */
export function manifestFor(
  id: string,
  fileText: string | null,
): PluginManifest | null {
  if (fileText !== null) {
    try {
      return parseManifest(JSON.parse(fileText));
    } catch {
      return null;
    }
  }
  return BUNDLED_MANIFESTS[id] ?? null;
}

export interface PluginsStoreOptions {
  initial?: PluginsV1;
  save?: (text: string) => Promise<void>;
  onSaveError?: (error: unknown) => void;
  /** Trailing debounce keeps rapid Settings toggles to one app-file write. */
  debounceMs?: number;
}

export class PluginsStore {
  private current: PluginsV1;
  private readonly save?: (text: string) => Promise<void>;
  private readonly onSaveError?: (error: unknown) => void;
  private readonly debounceMs: number;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(options: PluginsStoreOptions = {}) {
    this.current = options.initial ?? { plugins: {} };
    if (options.save) {
      this.save = options.save;
    }
    if (options.onSaveError) {
      this.onSaveError = options.onSaveError;
    }
    this.debounceMs = options.debounceMs ?? 800;
  }

  getSnapshot = (): PluginsV1 => this.current;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setEnabled = (id: string, enabled: boolean): void => {
    const entry = this.current.plugins[id];
    if (!entry || entry.enabled === enabled) {
      return;
    }
    this.replacePlugins({
      ...this.current.plugins,
      [id]: { ...entry, enabled },
    });
  };

  add = (id: string, path: string): void => {
    if (!isValidPluginId(id) || path.length === 0) {
      return;
    }
    const existing = this.current.plugins[id];
    if (existing?.path === path) {
      return;
    }
    this.replacePlugins({
      ...this.current.plugins,
      [id]: existing
        ? { ...existing, path }
        : { path, enabled: true, grants: [] },
    });
  };

  remove = (id: string): void => {
    if (!Object.prototype.hasOwnProperty.call(this.current.plugins, id)) {
      return;
    }
    this.replacePlugins(
      Object.fromEntries(
        Object.entries(this.current.plugins).filter(([entryId]) => entryId !== id),
      ),
    );
  };

  /**
   * Runs a pending persistence callback immediately and awaits queued writes.
   * It resolves even when a write failed: save failures reach callers through
   * `onSaveError`, so a shutdown flush is never blocked by a rejected promise.
   */
  flush = async (): Promise<void> => {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.enqueueSave();
    }
    await this.saveChain;
  };

  private replacePlugins(plugins: Record<string, PluginEntry>): void {
    this.current = { plugins };
    for (const listener of [...this.listeners]) {
      listener();
    }
    this.scheduleSave();
  }

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
    const text = serializePluginsFile(this.current);
    this.saveChain = this.saveChain
      .then(() => save(text))
      .catch((error) => {
        this.onSaveError?.(error);
      });
  }
}
