/**
 * NoteScheduler — the UI-side driver for LLM session notes (spec §6, polish P2).
 *
 * The rail and the palette know which sessions are on screen; this scheduler
 * turns that visibility into a *lazy*, throttled stream of
 * `generate_session_bundle(file_path)` calls — **one call per session**, which
 * yields the title, the description and the recap together (polish P2: one
 * Haiku call, three mutually consistent fields, a third of the cost):
 *
 * - concurrency 1 (one `claude -p` child at a time, never a fan-out),
 * - ordered most-recently-updated first (the session the user is watching wins),
 * - only sessions in the LATEST `reconcile` call (a row scrolled away mid-queue
 *   is dropped when it reaches the head),
 * - at most one attempt per session per 10 minutes — so an active chat, whose
 *   transcript keeps changing, refreshes its note "every so often" instead of
 *   on every rescan,
 * - silent on failure (§9): the cache is left untouched and the session is
 *   retried only after the same 10-minute window.
 *
 * Because the bundle is indivisible, the queue unit is the session key alone
 * and `summaryContent` is only a boolean gate here ("none" = schedule nothing);
 * which fields the user actually *sees* is a display decision made downstream,
 * and a stored bundle always carries all three fields.
 *
 * Everything with a side effect is injected (the generator, the store facade,
 * the settings reader, the clock), so tests drive the whole world. The
 * scheduler holds no timers of its own: time enters only through `now()`.
 */

import type { SummaryContent, SummaryEngine } from "../settings/settings";
import {
  hasTranscript,
  sessionKey,
  type BundleNote,
  type GeneratedNote,
  type LlmSessionRecord,
  type SessionKey,
} from "./types";

/**
 * The two note kinds a session can carry (§6). The scheduler no longer asks
 * for one kind at a time — the bundle produces both — but the legacy per-kind
 * `generate_session_note` wrapper still speaks this vocabulary.
 */
export type NoteKind = "summary" | "recap";

const NOTE_KINDS: readonly NoteKind[] = ["summary", "recap"];

/**
 * Spec §6: "min 10 minutes between generations per session". The same window
 * doubles as the staleness gate and as the retry-after-failure backoff (§9).
 */
export const NOTE_WINDOW_MS = 600_000;

/**
 * The slice of `ConversationsStore` the scheduler needs.
 *
 * `getSnapshot` is satisfied structurally by `ConversationsStore.getSnapshot`
 * as it exists today. `writeGeneratedNote` is the write action the integration
 * wires up (a one-line adapter that merges the note into
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
  /** Injected `generate_session_bundle`; `null` = generation failed (§9). */
  generateBundle(filePath: string): Promise<BundleNote | null>;
  store: NoteSchedulerStore;
  settings: NoteSchedulerSettings;
  now(): number;
}

interface QueueItem {
  /** The session key — the throttle, dedupe and ordering unit. */
  readonly key: SessionKey;
  /** Ordering snapshot taken at enqueue time. */
  readonly updatedAtMs: number;
}

/**
 * Whether `summaryContent` wants notes at all (§6). Anything but `none` asks
 * for the same single bundle; `none` asks for nothing.
 */
function wantsNotes(content: SummaryContent): boolean {
  return content !== "none";
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
 * Per-session eligibility (§6) — the same engine gate as before, asked once
 * for the whole bundle instead of once per kind.
 *
 * - `disk-only` never reaches here.
 * - `disk-first`: the LLM fills gaps only — some kind must be missing on disk
 *   *and* absent from the generated cache. One gap is enough, because the one
 *   call that fills it also produces the rest.
 * - `llm`: the LLM owns the notes regardless of what disk harvested, so the
 *   disk value is ignored; generate when never generated, when a kind is
 *   missing from the cache, or when stale. This is a strict superset of the
 *   `disk-first` set, which is what makes `ConversationsStore.noteFor`'s `llm`
 *   branch (a fresh generated note beats disk per kind) meaningful.
 */
function isEligible(
  record: LlmSessionRecord,
  generated: GeneratedNote | undefined,
  engine: SummaryEngine,
  now: number,
): boolean {
  if (engine === "llm") {
    if (generated === undefined) {
      return true;
    }
    if (NOTE_KINDS.some((kind) => generated[kind] === null)) {
      return true;
    }
    return isStale(generated, record, now);
  }
  return NOTE_KINDS.some(
    (kind) => record[kind] === null && (generated?.[kind] ?? null) === null,
  );
}

export class NoteScheduler {
  private readonly generateBundle: NoteSchedulerDeps["generateBundle"];
  private readonly store: NoteSchedulerStore;
  private readonly settings: NoteSchedulerSettings;
  private readonly now: () => number;
  /** Pending work, head first; re-sorted most-recently-updated first. */
  private readonly queue: QueueItem[] = [];
  /** Session keys that are queued or in flight — the dedupe guard. */
  private readonly claimed = new Set<SessionKey>();
  /** Session key → clock reading when its last attempt STARTED (§9 backoff). */
  private readonly attempts = new Map<SessionKey, number>();
  private visible = new Set<SessionKey>();
  private running = false;
  private disposed = false;

  constructor(deps: NoteSchedulerDeps) {
    this.generateBundle = deps.generateBundle;
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
    if (summaryEngine === "disk-only" || !wantsNotes(summaryContent)) {
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
      if (this.claimed.has(key)) {
        continue;
      }
      const lastAttempt = this.attempts.get(key);
      if (lastAttempt !== undefined && now - lastAttempt < NOTE_WINDOW_MS) {
        continue;
      }
      if (!isEligible(record, snapshot.data.generated[key], summaryEngine, now)) {
        continue;
      }
      this.queue.push({ key, updatedAtMs: record.updatedAtMs });
      this.claimed.add(key);
      added = true;
    }
    if (added) {
      // Stable sort: ties keep insertion order (record order from the store).
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
        this.claimed.delete(item.key);
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
    this.attempts.set(item.key, this.now());
    this.running = true;
    void this.generateBundle(record.filePath).then(
      (bundle) => {
        this.settle(item, sourceMtimeMs, bundle);
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
    bundle: BundleNote | null,
  ): void {
    if (this.disposed) {
      return;
    }
    this.running = false;
    this.claimed.delete(item.key);
    if (bundle !== null) {
      // The bundle is authoritative for all three fields: they were produced
      // in one pass and must stay mutually consistent.
      this.store.writeGeneratedNote(item.key, {
        title: bundle.title,
        summary: bundle.summary,
        recap: bundle.recap,
        generatedAtMs: this.now(),
        sourceMtimeMs,
      });
    }
    this.pump();
  }
}
