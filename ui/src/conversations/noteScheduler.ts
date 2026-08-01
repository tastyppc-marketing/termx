/**
 * NoteScheduler — the UI-side driver for LLM summaries and recaps (spec §6).
 *
 * The rail and the palette know which sessions are on screen; this scheduler
 * turns that visibility into a *lazy*, throttled stream of
 * `generate_session_note(file_path, kind)` calls:
 *
 * - concurrency 1 (one `claude -p` child at a time, never a fan-out),
 * - ordered most-recently-updated first (the session the user is watching wins),
 * - only sessions in the LATEST `reconcile` call (a row scrolled away mid-queue
 *   is dropped when it reaches the head),
 * - at most one attempt per session+kind per 10 minutes — so an active chat,
 *   whose transcript keeps changing, refreshes its note "every so often"
 *   instead of on every rescan,
 * - silent on failure (§9): the cache is left untouched and the pair is retried
 *   only after the same 10-minute window.
 *
 * Everything with a side effect is injected (the generator, the store facade,
 * the settings reader, the clock), so tests drive the whole world. The
 * scheduler holds no timers of its own: time enters only through `now()`.
 */

import type { SummaryContent, SummaryEngine } from "../settings/settings";
import {
  hasTranscript,
  sessionKey,
  type GeneratedNote,
  type LlmSessionRecord,
  type SessionKey,
} from "./types";

/** The two note kinds `generate_session_note` understands (§6). */
export type NoteKind = "summary" | "recap";

/**
 * Spec §6: "min 10 minutes between generations per session". The same window
 * doubles as the staleness gate and as the retry-after-failure backoff (§9).
 */
export const NOTE_WINDOW_MS = 600_000;

/**
 * The slice of `ConversationsStore` the scheduler needs.
 *
 * `getSnapshot` is satisfied structurally by `ConversationsStore.getSnapshot`
 * as it exists today. `writeGeneratedNote` is **not** on the store yet — U10
 * must not modify store.ts, so this is the write action the integration wires
 * up (a one-line adapter that merges the note into
 * `ConversationsV1.generated[key]` and lets the store's existing debounced save
 * persist it).
 */
export interface NoteSchedulerStore {
  getSnapshot(): {
    readonly records: readonly LlmSessionRecord[];
    readonly data: {
      readonly generated: Readonly<Record<SessionKey, GeneratedNote>>;
    };
  };
  /** Cache one freshly generated note under `key`, replacing any previous one. */
  writeGeneratedNote(key: SessionKey, note: GeneratedNote): void;
}

/** Satisfied structurally by `SettingsStore` (`getSnapshot(): TermxSettings`). */
export interface NoteSchedulerSettings {
  getSnapshot(): {
    readonly summaryEngine: SummaryEngine;
    readonly summaryContent: SummaryContent;
  };
}

export interface NoteSchedulerDeps {
  /** Injected `generate_session_note`; `null` = generation failed (§9). */
  generate(filePath: string, kind: NoteKind): Promise<string | null>;
  store: NoteSchedulerStore;
  settings: NoteSchedulerSettings;
  now(): number;
}

interface QueueItem {
  /** Session key + kind — the throttle and dedupe unit. */
  readonly id: string;
  readonly key: SessionKey;
  readonly kind: NoteKind;
  /** Ordering snapshot taken at enqueue time. */
  readonly updatedAtMs: number;
}

function itemId(key: SessionKey, kind: NoteKind): string {
  return `${key}\u0000${kind}`;
}

/** Which kinds `summaryContent` asks for (§6); `none` asks for nothing. */
function kindsFor(content: SummaryContent): readonly NoteKind[] {
  switch (content) {
    case "summary":
      return ["summary"];
    case "recap":
      return ["recap"];
    case "both":
      return ["summary", "recap"];
    case "none":
      return [];
  }
}

/**
 * A cached note is stale when the transcript changed after it was generated
 * *and* the 10-minute window has fully elapsed — the second half is what keeps
 * a live chat from regenerating on every rescan.
 */
function isStale(
  generated: GeneratedNote,
  record: LlmSessionRecord,
  now: number,
): boolean {
  return (
    record.updatedAtMs > generated.sourceMtimeMs &&
    now - generated.generatedAtMs >= NOTE_WINDOW_MS
  );
}

/**
 * Per-kind eligibility (§6).
 *
 * - `disk-only` never reaches here.
 * - `disk-first`: the LLM fills gaps only — the kind must be missing on disk
 *   *and* absent from the generated cache.
 * - `llm`: the LLM owns both kinds regardless of what disk harvested, so the
 *   disk value is ignored; generate when never generated, or when stale. This
 *   is a strict superset of the `disk-first` set, which is what makes
 *   `ConversationsStore.noteFor`'s `llm` branch (a fresh generated note beats
 *   disk per kind) meaningful.
 */
function isEligible(
  record: LlmSessionRecord,
  generated: GeneratedNote | undefined,
  kind: NoteKind,
  engine: SummaryEngine,
  now: number,
): boolean {
  const cached = generated ? generated[kind] : null;
  if (engine === "llm") {
    if (generated === undefined || cached === null) {
      return true;
    }
    return isStale(generated, record, now);
  }
  return record[kind] === null && cached === null;
}

export class NoteScheduler {
  private readonly generate: NoteSchedulerDeps["generate"];
  private readonly store: NoteSchedulerStore;
  private readonly settings: NoteSchedulerSettings;
  private readonly now: () => number;
  /** Pending work, head first; re-sorted most-recently-updated first. */
  private readonly queue: QueueItem[] = [];
  /** Item ids that are queued or in flight — the dedupe guard. */
  private readonly claimed = new Set<string>();
  /** Item id → clock reading when its last attempt STARTED (§9 backoff). */
  private readonly attempts = new Map<string, number>();
  private visible = new Set<SessionKey>();
  private running = false;
  private disposed = false;

  constructor(deps: NoteSchedulerDeps) {
    this.generate = deps.generate;
    this.store = deps.store;
    this.settings = deps.settings;
    this.now = deps.now;
  }

  /**
   * Called by the rail/palette whenever the on-screen session set changes (and
   * whenever the records themselves change — a rescan can make a note stale).
   * Replaces the eligible set and starts the pump if it is idle.
   */
  reconcile = (visibleKeys: SessionKey[]): void => {
    if (this.disposed) {
      return;
    }
    this.visible = new Set(visibleKeys);
    this.enqueueEligible();
    this.pump();
  };

  /** Drop all pending work and ignore whatever is still in flight. */
  dispose = (): void => {
    this.disposed = true;
    this.queue.length = 0;
    this.claimed.clear();
    this.visible.clear();
  };

  private enqueueEligible(): void {
    const { summaryEngine, summaryContent } = this.settings.getSnapshot();
    const kinds = kindsFor(summaryContent);
    if (summaryEngine === "disk-only" || kinds.length === 0) {
      return;
    }
    const snapshot = this.store.getSnapshot();
    const now = this.now();
    let added = false;
    for (const record of snapshot.records) {
      const key = sessionKey(record);
      // Not on screen, or nothing to read: never scheduled (§6, types.ts).
      if (!this.visible.has(key) || !hasTranscript(record)) {
        continue;
      }
      const generated = snapshot.data.generated[key];
      for (const kind of kinds) {
        const id = itemId(key, kind);
        if (this.claimed.has(id)) {
          continue;
        }
        const lastAttempt = this.attempts.get(id);
        if (lastAttempt !== undefined && now - lastAttempt < NOTE_WINDOW_MS) {
          continue;
        }
        if (!isEligible(record, generated, kind, summaryEngine, now)) {
          continue;
        }
        this.queue.push({ id, key, kind, updatedAtMs: record.updatedAtMs });
        this.claimed.add(id);
        added = true;
      }
    }
    if (added) {
      // Stable sort: ties keep insertion order (summary before recap).
      this.queue.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    }
  }

  /** Start the head of the queue if nothing is running; skip dead entries. */
  private pump(): void {
    if (this.disposed || this.running) {
      return;
    }
    while (this.queue.length > 0) {
      const item = this.queue.shift() as QueueItem;
      const record = this.liveRecord(item.key);
      if (record === null) {
        this.claimed.delete(item.id);
        continue;
      }
      this.start(item, record);
      return;
    }
  }

  /** The record for `key` if it is still visible, present, and readable. */
  private liveRecord(key: SessionKey): LlmSessionRecord | null {
    if (!this.visible.has(key)) {
      return null;
    }
    const record =
      this.store
        .getSnapshot()
        .records.find((entry) => sessionKey(entry) === key) ?? null;
    if (record === null || !hasTranscript(record)) {
      return null;
    }
    return record;
  }

  private start(item: QueueItem, record: LlmSessionRecord): void {
    // Captured at generation START: a transcript that grows while the model is
    // thinking must leave the note stale, not falsely current.
    const sourceMtimeMs = record.updatedAtMs;
    this.attempts.set(item.id, this.now());
    this.running = true;
    void this.generate(record.filePath, item.kind).then(
      (text) => {
        this.settle(item, sourceMtimeMs, text);
      },
      (error: unknown) => {
        // §9: generation failures are silent in the UI; console only.
        console.warn("[noteScheduler] generation failed", error);
        this.settle(item, sourceMtimeMs, null);
      },
    );
  }

  private settle(
    item: QueueItem,
    sourceMtimeMs: number,
    text: string | null,
  ): void {
    if (this.disposed) {
      return;
    }
    this.running = false;
    this.claimed.delete(item.id);
    if (text !== null) {
      const previous = this.store.getSnapshot().data.generated[item.key];
      this.store.writeGeneratedNote(item.key, {
        summary: item.kind === "summary" ? text : (previous?.summary ?? null),
        recap: item.kind === "recap" ? text : (previous?.recap ?? null),
        generatedAtMs: this.now(),
        sourceMtimeMs,
      });
    }
    this.pump();
  }
}
