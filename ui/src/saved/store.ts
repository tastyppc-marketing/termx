/**
 * Saved sessions store — `saved_sessions_v1.json` (saved-sessions spec §"Store
 * contract"). `useSyncExternalStore` shape (`subscribe` / `getSnapshot`), same
 * as SettingsStore, UiStateStore and ConversationsStore.
 *
 * Machine-written file, so the same discipline as `ui_state_v1.json`: per-entry
 * tolerant parse (a junk row is dropped, a junk optional field degrades, a
 * corrupt file reads as an empty list), debounced and serialized disk writes,
 * and nothing in here ever throws at a caller. The load happens once, in the
 * background: the store is usable synchronously from construction and gains its
 * persisted entries when the read lands.
 */

import type { AppFileName, AppFileStore } from "../native/appFiles";
import {
  type SavedConversationRef,
  type SavedProvider,
  type SavedSession,
} from "./types";

export const SAVED_SESSIONS_FILE: AppFileName = "saved_sessions_v1.json";

const SAVED_PROVIDERS: readonly SavedProvider[] = ["claude", "codex"];

/** The frozen cross-lane contract: every other lane codes against this. */
export interface SavedSessionsStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): readonly SavedSession[];       // stable ref between changes
  /** Upsert by conversation.id when present; returns the stored entry. */
  save(input: {
    name: string;
    description?: string;
    cwd: string;
    conversation?: SavedConversationRef;
    lastDaemonSessionId?: number;
  }): SavedSession;
  /** Rename / re-describe. Unknown id is a no-op. */
  update(id: string, patch: { name?: string; description?: string }): void;
  remove(id: string): void;
  /** Record the daemon session a resume just attached/created. */
  touchDaemonSession(id: string, daemonSessionId: number): void;
}

/**
 * What `createSavedSessionsStore` actually hands back: the contract above plus
 * the two lifecycle helpers the other app-file stores also expose (there they
 * are `loadXStore`'s await and `flush`). Assignable to `SavedSessionsStore`, so
 * consumers written against the contract need nothing from here.
 */
export interface SavedSessionsStoreHandle extends SavedSessionsStore {
  /** Resolves once the initial load has been applied. */
  ready(): Promise<void>;
  /** Runs any pending debounced write immediately and awaits the chain. */
  flush(): Promise<void>;
}

export interface SavedSessionsStoreOptions {
  onSaveError?: (error: unknown) => void;
  /** Trailing debounce for disk writes. */
  debounceMs?: number;
  now?: () => number;
  generateId?: () => string;
}

let idSequence = 0;

function defaultGenerateId(): string {
  const uuid = globalThis.crypto?.randomUUID;
  if (typeof uuid === "function") {
    return uuid.call(globalThis.crypto);
  }
  idSequence += 1;
  return `saved-${Date.now()}-${idSequence}`;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function timestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

/** Daemon session ids are non-negative integers; anything else is not one. */
function daemonSessionId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function parseConversation(value: unknown): SavedConversationRef | undefined {
  if (!isRecordObject(value)) {
    return undefined;
  }
  const { provider, id } = value;
  if (
    !(SAVED_PROVIDERS as readonly unknown[]).includes(provider) ||
    typeof id !== "string" ||
    id.length === 0
  ) {
    return undefined;
  }
  const title = requiredText(value.title);
  return { provider: provider as SavedProvider, id, title: title ?? id };
}

/**
 * Parse the store file (null = missing). Never throws. An entry without an id,
 * a name, or a cwd is not resumable, so it is dropped; everything optional
 * degrades in place — a broken conversation ref leaves a folder-only save
 * rather than removing the entry the user made.
 */
export function parseSavedSessions(text: string | null): SavedSession[] {
  if (text === null) {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecordObject(raw) || !Array.isArray(raw.saved)) {
    return [];
  }
  const saved: SavedSession[] = [];
  const seen = new Set<string>();
  for (const entry of raw.saved) {
    if (!isRecordObject(entry)) {
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id : "";
    const name = requiredText(entry.name);
    const cwd = requiredText(entry.cwd);
    if (id.length === 0 || name === null || cwd === null || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const description = requiredText(entry.description);
    const conversation = parseConversation(entry.conversation);
    const lastDaemonSessionId = daemonSessionId(entry.lastDaemonSessionId);
    saved.push({
      id,
      name,
      ...(description !== null ? { description } : {}),
      cwd,
      ...(conversation ? { conversation } : {}),
      ...(lastDaemonSessionId !== undefined ? { lastDaemonSessionId } : {}),
      createdAtMs: timestamp(entry.createdAtMs),
      updatedAtMs: timestamp(entry.updatedAtMs),
    });
  }
  return saved;
}

export function serializeSavedSessions(
  saved: readonly SavedSession[],
): string {
  return `${JSON.stringify({ version: 1, saved }, null, 2)}\n`;
}

const EMPTY: readonly SavedSession[] = [];

class SavedSessions implements SavedSessionsStoreHandle {
  private saved: readonly SavedSession[] = EMPTY;
  private readonly files: AppFileStore;
  private readonly onSaveError?: (error: unknown) => void;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly listeners = new Set<() => void>();
  private readonly loaded: Promise<void>;
  private hydrated = false;
  private dirtyBeforeHydration = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(files: AppFileStore, options: SavedSessionsStoreOptions = {}) {
    this.files = files;
    if (options.onSaveError) {
      this.onSaveError = options.onSaveError;
    }
    this.debounceMs = options.debounceMs ?? 800;
    this.now = options.now ?? (() => Date.now());
    this.generateId = options.generateId ?? defaultGenerateId;
    this.loaded = this.hydrate();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): readonly SavedSession[] => this.saved;

  ready = (): Promise<void> => this.loaded;

  save = (input: {
    name: string;
    description?: string;
    cwd: string;
    conversation?: SavedConversationRef;
    lastDaemonSessionId?: number;
  }): SavedSession => {
    const stamp = this.now();
    const conversation = input.conversation;
    const fields = {
      name: input.name,
      ...(input.description !== undefined && input.description.length > 0
        ? { description: input.description }
        : {}),
      cwd: input.cwd,
      ...(conversation ? { conversation } : {}),
      ...(input.lastDaemonSessionId !== undefined
        ? { lastDaemonSessionId: input.lastDaemonSessionId }
        : {}),
    };
    // Upsert only when a conversation is attached: two bare-shell saves of the
    // same folder are two deliberate entries, not one.
    const existing = conversation
      ? this.saved.findIndex((entry) => entry.conversation?.id === conversation.id)
      : -1;
    if (existing >= 0) {
      // The input is the whole save, so name, description, cwd and the daemon
      // session mirror it exactly — an omitted description clears the old one.
      // Only the identity of the entry survives.
      const previous = this.saved[existing]!;
      const next: SavedSession = {
        id: previous.id,
        ...fields,
        createdAtMs: previous.createdAtMs,
        updatedAtMs: stamp,
      };
      this.commit(
        this.saved.map((entry, index) => (index === existing ? next : entry)),
        { immediate: true },
      );
      return next;
    }
    const created: SavedSession = {
      id: this.generateId(),
      ...fields,
      createdAtMs: stamp,
      updatedAtMs: stamp,
    };
    this.commit([...this.saved, created], { immediate: true });
    return created;
  };

  /**
   * Name/description only — a rename is not a re-save, so cwd, conversation,
   * the daemon session and `updatedAtMs` are all left exactly as they were. An
   * empty description clears the field rather than storing "".
   */
  update = (
    id: string,
    patch: { name?: string; description?: string },
  ): void => {
    const index = this.saved.findIndex((entry) => entry.id === id);
    if (index < 0) {
      return;
    }
    const previous = this.saved[index]!;
    const name = patch.name ?? previous.name;
    const description =
      patch.description === undefined
        ? previous.description
        : patch.description.length > 0
          ? patch.description
          : undefined;
    if (name === previous.name && description === previous.description) {
      return;
    }
    // Spread-then-delete (the uiState pattern) so a cleared description leaves
    // no key behind, while everything else on the entry survives untouched.
    const next: { -readonly [K in keyof SavedSession]: SavedSession[K] } = {
      ...previous,
      name,
    };
    if (description !== undefined) {
      next.description = description;
    } else {
      delete next.description;
    }
    this.commit(
      this.saved.map((entry, at) => (at === index ? next : entry)),
      { immediate: true },
    );
  };

  remove = (id: string): void => {
    const rest = this.saved.filter((entry) => entry.id !== id);
    if (rest.length === this.saved.length) {
      return;
    }
    this.commit(rest, { immediate: true });
  };

  touchDaemonSession = (id: string, daemonSession: number): void => {
    const index = this.saved.findIndex((entry) => entry.id === id);
    if (index < 0) {
      return;
    }
    const previous = this.saved[index]!;
    if (previous.lastDaemonSessionId === daemonSession) {
      return;
    }
    const next: SavedSession = {
      ...previous,
      lastDaemonSessionId: daemonSession,
      updatedAtMs: this.now(),
    };
    this.commit(this.saved.map((entry, at) => (at === index ? next : entry)));
  };

  flush = async (): Promise<void> => {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.enqueueSave();
    }
    await this.saveChain;
  };

  private async hydrate(): Promise<void> {
    let text: string | null = null;
    try {
      text = await this.files.read(SAVED_SESSIONS_FILE);
    } catch {
      text = null;
    }
    const stored = parseSavedSessions(text);
    this.hydrated = true;
    if (stored.length > 0) {
      // Anything saved before the read landed keeps its place at the end.
      this.saved = this.saved.length > 0 ? [...stored, ...this.saved] : stored;
      this.notify();
    }
    if (this.dirtyBeforeHydration) {
      this.dirtyBeforeHydration = false;
      this.enqueueSave();
    }
  }

  /**
   * User-initiated mutations (save/update/remove) write immediately: losing a
   * pin the user made moments before closing the window would break the
   * feature's whole promise. Only `touchDaemonSession` — machine bookkeeping
   * that can fire in bursts during resumes — keeps the trailing debounce.
   */
  private commit(
    saved: readonly SavedSession[],
    options: { immediate?: boolean } = {},
  ): void {
    this.saved = saved;
    this.notify();
    if (options.immediate && this.hydrated) {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.enqueueSave();
      return;
    }
    this.scheduleSave();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  private scheduleSave(): void {
    // A write before the load would persist a half-known list over the file.
    if (!this.hydrated) {
      this.dirtyBeforeHydration = true;
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
    const text = serializeSavedSessions(this.saved);
    this.saveChain = this.saveChain
      .then(() => this.files.write(SAVED_SESSIONS_FILE, text))
      .catch((error: unknown) => {
        this.onSaveError?.(error);
      });
  }
}

export function createSavedSessionsStore(
  files: AppFileStore,
  options: SavedSessionsStoreOptions = {},
): SavedSessionsStoreHandle {
  return new SavedSessions(files, options);
}
