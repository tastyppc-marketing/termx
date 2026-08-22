/**
 * ConversationsStore — the rail's single source of truth (spec §3).
 *
 * `useSyncExternalStore` shape (`subscribe` / `getSnapshot`), same as
 * SettingsStore and UiStateStore. Every side effect is injected: the session
 * lister (`list_llm_sessions`), the app-file reader/writer, the clock, and the
 * folder-id generator — so tests fake the whole world and nothing scans a disk
 * until the rail actually asks.
 *
 * Nothing here throws: a failed scan keeps the previous records, and a failed
 * save stays contained in the store (§9).
 */

import type { TermxSettings } from "../settings/settings";
import {
  assignSession,
  createFolder as createFolderIn,
  deleteFolder as deleteFolderIn,
  renameFolder as renameFolderIn,
  updateFolder as updateFolderIn,
  type FolderPatch,
} from "./folderOps";
import { parseConversations, serializeConversations } from "./storage";
import {
  hasTranscript,
  sessionKey,
  type ConversationsV1,
  type GeneratedNote,
  type LlmSessionRecord,
  type SessionArtifacts,
  type SessionKey,
  type SessionLister,
  type SessionNote,
} from "./types";

export interface ConversationsSnapshot {
  /** Newest first (`updatedAtMs` desc). */
  readonly records: readonly LlmSessionRecord[];
  readonly data: ConversationsV1;
  readonly selectedKey: SessionKey | null;
  /** A scan is in flight (footer spinner / disabled refresh button). */
  readonly refreshing: boolean;
  /** Clock reading of the last successful scan; null = never scanned. */
  readonly refreshedAtMs: number | null;
}

export interface ConversationsStoreOptions {
  /** Injected `list_llm_sessions(force)`. */
  list: SessionLister;
  initial?: ConversationsV1;
  /** Persist serialized state; omitted = in-memory only (tests, fallback). */
  save?: (text: string) => Promise<void>;
  onSaveError?: (error: unknown) => void;
  /** Trailing debounce for disk writes. */
  debounceMs?: number;
  now?: () => number;
  generateId?: () => string;
}

let folderSequence = 0;

function defaultGenerateId(): string {
  const uuid = globalThis.crypto?.randomUUID;
  if (typeof uuid === "function") {
    return uuid.call(globalThis.crypto);
  }
  folderSequence += 1;
  return `folder-${Date.now()}-${folderSequence}`;
}

export function findRecord(
  records: readonly LlmSessionRecord[],
  key: SessionKey | null,
): LlmSessionRecord | null {
  if (key === null) {
    return null;
  }
  return records.find((record) => sessionKey(record) === key) ?? null;
}

/**
 * The project-folder name a provider gives a directory: every character that is
 * not a letter or a digit becomes "-". Confirmed against the real store here on
 * 1204 of 1338 indexed transcripts; the 134 that disagree are exactly the copies
 * below, sitting in some OTHER project's folder.
 */
function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** The directory a transcript sits in ("" when the path has no parent). */
function parentDirName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts.length >= 2 ? (parts[parts.length - 2] ?? "") : "";
}

/** True when this file is the copy in the conversation's OWN project folder. */
function isCanonicalCopy(record: LlmSessionRecord): boolean {
  return (
    record.cwd !== null &&
    hasTranscript(record) &&
    parentDirName(record.filePath) === projectSlug(record.cwd)
  );
}

/** Which of two rows for the same conversation is the one worth keeping. */
function betterCopy(
  seen: LlmSessionRecord,
  next: LlmSessionRecord,
): LlmSessionRecord {
  if (seen.updatedAtMs !== next.updatedAtMs) {
    return seen.updatedAtMs > next.updatedAtMs ? seen : next;
  }
  if (hasTranscript(seen) !== hasTranscript(next)) {
    return hasTranscript(seen) ? seen : next;
  }
  if (isCanonicalCopy(seen) !== isCanonicalCopy(next)) {
    return isCanonicalCopy(seen) ? seen : next;
  }
  return seen; // indistinguishable: first seen wins, so a rescan is stable
}

/**
 * One record per conversation (`SessionKey` is the identity — types.ts).
 *
 * The scan walks FILES, and a conversation given access to another directory is
 * COPIED into that directory's project folder: same provider, same id, same
 * mtime, a second path. Every consumer here treats `provider:id` as unique —
 * `findRecord` returns the first match, generated notes are keyed by it — and
 * the pane→conversation linkage reads two equally-recent rows in one folder as
 * genuine ambiguity and gives up, which is how a pin over a live claude wrote a
 * folder-only saved session (`resolveLinkage`, chat/linkage.ts).
 *
 * Order is the scan's own; the caller sorts.
 */
export function dedupeSessions(
  records: readonly LlmSessionRecord[],
): LlmSessionRecord[] {
  const kept = new Map<SessionKey, LlmSessionRecord>();
  for (const record of records) {
    const key = sessionKey(record);
    const seen = kept.get(key);
    kept.set(key, seen === undefined ? record : betterCopy(seen, record));
  }
  return [...kept.values()];
}

export class ConversationsStore {
  private snapshot: ConversationsSnapshot;
  private readonly list: SessionLister;
  private readonly saveFile?: (text: string) => Promise<void>;
  private readonly onSaveError?: (error: unknown) => void;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private pending: Promise<void> | null = null;

  constructor(options: ConversationsStoreOptions) {
    this.list = options.list;
    if (options.save) {
      this.saveFile = options.save;
    }
    if (options.onSaveError) {
      this.onSaveError = options.onSaveError;
    }
    this.debounceMs = options.debounceMs ?? 800;
    this.now = options.now ?? (() => Date.now());
    this.generateId = options.generateId ?? defaultGenerateId;
    this.snapshot = {
      records: [],
      data: options.initial ?? parseConversations(null),
      selectedKey: null,
      refreshing: false,
      refreshedAtMs: null,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ConversationsSnapshot => this.snapshot;

  /**
   * Rescan sessions through the injected lister and sort newest first.
   * Concurrent calls coalesce onto the in-flight scan; failures leave the
   * previous records (and the previous "refreshed" stamp) untouched.
   */
  refresh = (force: boolean): Promise<void> => {
    if (this.pending) {
      return this.pending;
    }
    this.emit({ refreshing: true });
    const run = (async () => {
      try {
        const listed = await this.list(force);
        // Copies collapse BEFORE the sort: two rows of one conversation are not
        // two sessions, and downstream identity is `provider:id`.
        const records = dedupeSessions(listed).sort(
          (left, right) => right.updatedAtMs - left.updatedAtMs,
        );
        this.emit({
          records,
          refreshedAtMs: this.now(),
          refreshing: false,
          ...(this.snapshot.selectedKey !== null &&
          !records.some((record) => sessionKey(record) === this.snapshot.selectedKey)
            ? { selectedKey: null }
            : {}),
        });
      } catch {
        this.emit({ refreshing: false });
      } finally {
        this.pending = null;
      }
    })();
    this.pending = run;
    return run;
  };

  createFolder = (name: string): void => {
    this.updateData((data) => createFolderIn(data, name, this.generateId()));
  };

  /** Patch a folder's own fields — P7's persisted collapse state. */
  updateFolder = (id: string, patch: FolderPatch): void => {
    this.updateData((data) => updateFolderIn(data, id, patch));
  };

  renameFolder = (id: string, name: string): void => {
    this.updateData((data) => renameFolderIn(data, id, name));
  };

  /** Deleting a folder unfiles its sessions; provider files are never touched. */
  deleteFolder = (id: string): void => {
    this.updateData((data) => deleteFolderIn(data, id));
  };

  assign = (key: SessionKey, folderId: string | null): void => {
    this.updateData((data) => assignSession(data, key, folderId));
  };

  /** Cache one record's "Files touched" harvest (§11), persisted like folders/notes. */
  setArtifacts = (key: SessionKey, artifacts: SessionArtifacts): void => {
    this.updateData((data) => ({
      ...data,
      artifacts: { ...data.artifacts, [key]: artifacts },
    }));
  };

  /** Cache one freshly generated LLM note (§6) — the NoteScheduler's write. */
  setGeneratedNote = (key: SessionKey, note: GeneratedNote): void => {
    this.updateData((data) => ({
      ...data,
      generated: { ...data.generated, [key]: note },
    }));
  };

  select = (key: SessionKey | null): void => {
    this.emit({ selectedKey: key });
  };

  /**
   * The note a row/detail pane should show for one record, per `summaryEngine`
   * (§6):
   * - `disk-only` — harvested data only; generated notes are never consulted.
   * - `disk-first` — harvested data wins; generated fills only the gaps.
   * - `llm` — a *fresh* generated note (its source mtime is at least the
   *   record's last activity) wins per kind, falling back to disk; a stale one
   *   only fills gaps.
   *
   * A session with no transcript file has nothing to summarize: disk values
   * only, generated cache ignored.
   */
  noteFor = (
    record: LlmSessionRecord,
    settings: Pick<TermxSettings, "summaryEngine">,
  ): SessionNote => {
    const disk: SessionNote = { summary: record.summary, recap: record.recap };
    if (settings.summaryEngine === "disk-only" || !hasTranscript(record)) {
      return disk;
    }
    const generated = this.snapshot.data.generated[sessionKey(record)];
    if (!generated) {
      return disk;
    }
    if (
      settings.summaryEngine === "llm" &&
      generated.sourceMtimeMs >= record.updatedAtMs
    ) {
      return {
        summary: generated.summary ?? disk.summary,
        recap: generated.recap ?? disk.recap,
      };
    }
    return {
      summary: disk.summary ?? generated.summary,
      recap: disk.recap ?? generated.recap,
    };
  };

  /** Runs any pending save immediately and awaits the chain (tests, teardown). */
  flush = async (): Promise<void> => {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.enqueueSave();
    }
    await this.saveChain;
  };

  private updateData(mutation: (data: ConversationsV1) => ConversationsV1): void {
    const next = mutation(this.snapshot.data);
    if (next === this.snapshot.data) {
      return;
    }
    this.emit({ data: next });
    this.scheduleSave();
  }

  private emit(patch: Partial<ConversationsSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    if (
      next.records === this.snapshot.records &&
      next.data === this.snapshot.data &&
      next.selectedKey === this.snapshot.selectedKey &&
      next.refreshing === this.snapshot.refreshing &&
      next.refreshedAtMs === this.snapshot.refreshedAtMs
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  private scheduleSave(): void {
    if (!this.saveFile) {
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
    const save = this.saveFile;
    if (!save) {
      return;
    }
    const text = serializeConversations(this.snapshot.data);
    this.saveChain = this.saveChain
      .then(() => save(text))
      .catch((error) => {
        this.onSaveError?.(error);
      });
  }
}

/**
 * Load persisted conversations state and build the live store. A failed read
 * yields empty state — conversations must never block workspace startup — and
 * no scan happens here: the rail asks for records when it first renders.
 */
export async function loadConversationsStore(options: {
  read: () => Promise<string | null>;
  list: SessionLister;
  save?: (text: string) => Promise<void>;
  onSaveError?: (error: unknown) => void;
  debounceMs?: number;
  now?: () => number;
  generateId?: () => string;
}): Promise<ConversationsStore> {
  let text: string | null = null;
  try {
    text = await options.read();
  } catch {
    text = null;
  }
  return new ConversationsStore({
    list: options.list,
    initial: parseConversations(text),
    ...(options.save ? { save: options.save } : {}),
    ...(options.onSaveError ? { onSaveError: options.onSaveError } : {}),
    ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.generateId ? { generateId: options.generateId } : {}),
  });
}
