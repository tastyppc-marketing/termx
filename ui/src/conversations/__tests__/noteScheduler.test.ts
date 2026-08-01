import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NOTE_WINDOW_MS,
  NoteScheduler,
  type NoteKind,
  type NoteSchedulerStore,
} from "../noteScheduler";
import type { SummaryContent, SummaryEngine } from "../../settings/settings";
import type { GeneratedNote, LlmSessionRecord, SessionKey } from "../types";

function record(overrides: Partial<LlmSessionRecord> = {}): LlmSessionRecord {
  return {
    provider: "claude",
    id: "a",
    title: "Session A",
    cwd: "C:\\Dev\\TermX",
    filePath: "C:\\a.jsonl",
    updatedAtMs: 100,
    summary: null,
    recap: null,
    ...overrides,
  };
}

function note(overrides: Partial<GeneratedNote> = {}): GeneratedNote {
  return {
    summary: null,
    recap: null,
    generatedAtMs: 0,
    sourceMtimeMs: 0,
    ...overrides,
  };
}

/** The minimal store facade U10 depends on (main wires the real adapter). */
class FakeStore implements NoteSchedulerStore {
  records: LlmSessionRecord[] = [];
  generated: Record<SessionKey, GeneratedNote> = {};
  readonly writes: Array<{ key: SessionKey; note: GeneratedNote }> = [];

  getSnapshot() {
    return { records: this.records, data: { generated: this.generated } };
  }

  writeGeneratedNote(key: SessionKey, value: GeneratedNote): void {
    this.generated[key] = value;
    this.writes.push({ key, note: value });
  }
}

interface Harness {
  readonly scheduler: NoteScheduler;
  readonly store: FakeStore;
  readonly calls: Array<{ filePath: string; kind: NoteKind }>;
  readonly generate: ReturnType<typeof vi.fn>;
  setClock(value: number): void;
  advance(deltaMs: number): void;
}

/**
 * `result` decides what each generation resolves to; the default is a
 * synchronous success. The scheduler owns no timers, so the injected clock is
 * the only source of time and a single macrotask tick drains the pump.
 */
function makeScheduler(options: {
  records: LlmSessionRecord[];
  generated?: Record<SessionKey, GeneratedNote>;
  engine?: SummaryEngine;
  content?: SummaryContent;
  now?: number;
  result?: (filePath: string, kind: NoteKind) => Promise<string | null>;
}): Harness {
  const store = new FakeStore();
  store.records = options.records;
  store.generated = options.generated ?? {};
  let clock = options.now ?? 0;
  const calls: Array<{ filePath: string; kind: NoteKind }> = [];
  const generate = vi.fn(async (filePath: string, kind: NoteKind) => {
    calls.push({ filePath, kind });
    if (options.result) {
      return await options.result(filePath, kind);
    }
    return `${kind} of ${filePath}`;
  });
  const scheduler = new NoteScheduler({
    generate,
    store,
    settings: {
      getSnapshot: () => ({
        summaryEngine: options.engine ?? "disk-first",
        summaryContent: options.content ?? "summary",
      }),
    },
    now: () => clock,
  });
  return {
    scheduler,
    store,
    calls,
    generate,
    setClock: (value) => {
      clock = value;
    },
    advance: (deltaMs) => {
      clock += deltaMs;
    },
  };
}

/** Flush every pending microtask (the whole generate → settle → pump chain). */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((inner) => {
    resolve = inner;
  });
  return { promise, resolve };
}

describe("engine matrix", () => {
  it("never generates under disk-only, even for a session with no notes", async () => {
    const harness = makeScheduler({
      records: [record()],
      engine: "disk-only",
      content: "both",
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.generate).not.toHaveBeenCalled();
    expect(harness.store.writes).toEqual([]);
  });

  it("generates under disk-first only for a kind missing on disk", async () => {
    const harness = makeScheduler({
      records: [
        record({ id: "has", summary: "harvested", filePath: "C:\\has.jsonl" }),
        record({ id: "gap", summary: null, filePath: "C:\\gap.jsonl" }),
      ],
      engine: "disk-first",
      content: "summary",
    });

    harness.scheduler.reconcile(["claude:has", "claude:gap"]);
    await tick();

    expect(harness.calls).toEqual([
      { filePath: "C:\\gap.jsonl", kind: "summary" },
    ]);
  });

  it("skips a disk-first gap that the generated cache already fills", async () => {
    const harness = makeScheduler({
      records: [record()],
      generated: { "claude:a": note({ summary: "cached", sourceMtimeMs: 1 }) },
      engine: "disk-first",
      content: "summary",
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("generates under llm for a kind present on disk but never generated", async () => {
    const harness = makeScheduler({
      records: [record({ summary: "harvested" })],
      engine: "llm",
      content: "summary",
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.calls).toEqual([{ filePath: "C:\\a.jsonl", kind: "summary" }]);
  });

  it("generates the missing kind under llm when the cache holds only the other", async () => {
    const harness = makeScheduler({
      records: [record({ updatedAtMs: 100 })],
      generated: {
        "claude:a": note({ summary: "cached", sourceMtimeMs: 100 }),
      },
      engine: "llm",
      content: "both",
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.calls).toEqual([{ filePath: "C:\\a.jsonl", kind: "recap" }]);
  });

  it("generates nothing when summaryContent is none", async () => {
    const harness = makeScheduler({
      records: [record()],
      engine: "llm",
      content: "none",
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("generates only recaps when summaryContent is recap", async () => {
    const harness = makeScheduler({
      records: [record()],
      engine: "disk-first",
      content: "recap",
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.calls).toEqual([{ filePath: "C:\\a.jsonl", kind: "recap" }]);
  });

  it("generates summary then recap when summaryContent is both", async () => {
    const harness = makeScheduler({
      records: [record()],
      engine: "disk-first",
      content: "both",
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.calls).toEqual([
      { filePath: "C:\\a.jsonl", kind: "summary" },
      { filePath: "C:\\a.jsonl", kind: "recap" },
    ]);
    expect(harness.store.generated["claude:a"]).toEqual({
      summary: "summary of C:\\a.jsonl",
      recap: "recap of C:\\a.jsonl",
      generatedAtMs: 0,
      sourceMtimeMs: 100,
    });
  });
});

describe("staleness math", () => {
  const stale = { updatedAtMs: 5_000 };
  const cached = { summary: "cached", sourceMtimeMs: 4_000, generatedAtMs: 0 };

  it("regenerates at exactly the 10-minute boundary", async () => {
    const harness = makeScheduler({
      records: [record(stale)],
      generated: { "claude:a": note(cached) },
      engine: "llm",
      now: NOTE_WINDOW_MS,
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.calls).toEqual([{ filePath: "C:\\a.jsonl", kind: "summary" }]);
  });

  it("does not regenerate one millisecond before the boundary", async () => {
    const harness = makeScheduler({
      records: [record(stale)],
      generated: { "claude:a": note(cached) },
      engine: "llm",
      now: NOTE_WINDOW_MS - 1,
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("never regenerates a note whose source mtime already covers the record", async () => {
    const harness = makeScheduler({
      records: [record({ updatedAtMs: 5_000 })],
      generated: {
        "claude:a": note({ summary: "cached", sourceMtimeMs: 5_000 }),
      },
      engine: "llm",
      now: NOTE_WINDOW_MS * 100,
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("leaves a stale note under disk-first alone when disk already has the kind", async () => {
    const harness = makeScheduler({
      records: [record({ ...stale, summary: "harvested" })],
      generated: { "claude:a": note(cached) },
      engine: "disk-first",
      now: NOTE_WINDOW_MS,
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.generate).not.toHaveBeenCalled();
  });
});

describe("queue", () => {
  it("runs exactly one generation at a time", async () => {
    const gates: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const harness = makeScheduler({
      records: [
        record({ id: "a", filePath: "C:\\a.jsonl", updatedAtMs: 3 }),
        record({ id: "b", filePath: "C:\\b.jsonl", updatedAtMs: 2 }),
        record({ id: "c", filePath: "C:\\c.jsonl", updatedAtMs: 1 }),
      ],
      result: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => gates.push(resolve));
        active -= 1;
        return "note";
      },
    });

    harness.scheduler.reconcile(["claude:a", "claude:b", "claude:c"]);
    await tick();
    expect(harness.generate).toHaveBeenCalledTimes(1);

    gates[0]?.();
    await tick();
    expect(harness.generate).toHaveBeenCalledTimes(2);

    gates[1]?.();
    await tick();
    expect(harness.generate).toHaveBeenCalledTimes(3);

    gates[2]?.();
    await tick();
    expect(peak).toBe(1);
    expect(harness.store.writes).toHaveLength(3);
  });

  it("orders work most-recently-updated first", async () => {
    const harness = makeScheduler({
      records: [
        record({ id: "old", filePath: "C:\\old.jsonl", updatedAtMs: 10 }),
        record({ id: "new", filePath: "C:\\new.jsonl", updatedAtMs: 300 }),
        record({ id: "mid", filePath: "C:\\mid.jsonl", updatedAtMs: 100 }),
      ],
    });

    harness.scheduler.reconcile(["claude:old", "claude:new", "claude:mid"]);
    await tick();

    expect(harness.calls.map((call) => call.filePath)).toEqual([
      "C:\\new.jsonl",
      "C:\\mid.jsonl",
      "C:\\old.jsonl",
    ]);
  });

  it("does not enqueue the same session twice across reconciles", async () => {
    const gate = deferred<string | null>();
    const harness = makeScheduler({
      records: [record()],
      result: () => gate.promise,
    });

    harness.scheduler.reconcile(["claude:a"]);
    harness.scheduler.reconcile(["claude:a"]);
    await tick();
    gate.resolve("note");
    await tick();

    expect(harness.generate).toHaveBeenCalledTimes(1);
  });
});

describe("visibility gating", () => {
  it("skips a queued key that the latest reconcile dropped", async () => {
    const gate = deferred<string | null>();
    let first = true;
    const harness = makeScheduler({
      records: [
        record({ id: "a", filePath: "C:\\a.jsonl", updatedAtMs: 200 }),
        record({ id: "b", filePath: "C:\\b.jsonl", updatedAtMs: 100 }),
      ],
      result: () => {
        if (first) {
          first = false;
          return gate.promise;
        }
        return Promise.resolve("note");
      },
    });

    harness.scheduler.reconcile(["claude:a", "claude:b"]);
    await tick();
    expect(harness.calls).toEqual([
      { filePath: "C:\\a.jsonl", kind: "summary" },
    ]);

    // "b" scrolls out of view while "a" is still generating.
    harness.scheduler.reconcile(["claude:a"]);
    gate.resolve("note");
    await tick();

    expect(harness.calls).toEqual([
      { filePath: "C:\\a.jsonl", kind: "summary" },
    ]);
    expect(harness.store.writes.map((write) => write.key)).toEqual(["claude:a"]);
  });

  it("never schedules a record with an empty file path", async () => {
    const harness = makeScheduler({
      records: [record({ id: "ghost", filePath: "" })],
      engine: "llm",
      content: "both",
    });

    harness.scheduler.reconcile(["claude:ghost"]);
    await tick();

    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("ignores a visible key with no matching record", async () => {
    const harness = makeScheduler({ records: [record()] });

    harness.scheduler.reconcile(["claude:a", "codex:missing"]);
    await tick();

    expect(harness.calls).toEqual([{ filePath: "C:\\a.jsonl", kind: "summary" }]);
  });
});

describe("failures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves the cache untouched and retries only after the window", async () => {
    const harness = makeScheduler({
      records: [record()],
      now: 1_000_000,
      result: async () => null,
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();
    expect(harness.generate).toHaveBeenCalledTimes(1);
    expect(harness.store.writes).toEqual([]);
    expect(harness.store.generated).toEqual({});

    // Immediately, and just short of the window: still throttled.
    harness.scheduler.reconcile(["claude:a"]);
    await tick();
    harness.advance(NOTE_WINDOW_MS - 1);
    harness.scheduler.reconcile(["claude:a"]);
    await tick();
    expect(harness.generate).toHaveBeenCalledTimes(1);

    harness.advance(1);
    harness.scheduler.reconcile(["claude:a"]);
    await tick();
    expect(harness.generate).toHaveBeenCalledTimes(2);
  });

  it("treats a rejected generation as a silent failure and keeps draining", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let first = true;
    const harness = makeScheduler({
      records: [
        record({ id: "a", filePath: "C:\\a.jsonl", updatedAtMs: 200 }),
        record({ id: "b", filePath: "C:\\b.jsonl", updatedAtMs: 100 }),
      ],
      result: () => {
        if (first) {
          first = false;
          return Promise.reject(new Error("spawn failed"));
        }
        return Promise.resolve("note");
      },
    });

    harness.scheduler.reconcile(["claude:a", "claude:b"]);
    await tick();

    expect(harness.generate).toHaveBeenCalledTimes(2);
    expect(harness.store.writes.map((write) => write.key)).toEqual(["claude:b"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("success", () => {
  it("writes sourceMtimeMs captured at generation start, not completion", async () => {
    const gate = deferred<string | null>();
    const harness = makeScheduler({
      records: [record({ updatedAtMs: 5_000 })],
      now: 1_000,
      result: () => gate.promise,
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    // The transcript grows and the clock moves while the model is thinking.
    harness.store.records = [record({ updatedAtMs: 9_999 })];
    harness.setClock(4_000);
    gate.resolve("fresh summary");
    await tick();

    expect(harness.store.writes).toEqual([
      {
        key: "claude:a",
        note: {
          summary: "fresh summary",
          recap: null,
          generatedAtMs: 4_000,
          sourceMtimeMs: 5_000,
        },
      },
    ]);
  });

  it("preserves the other cached kind when writing one kind", async () => {
    const harness = makeScheduler({
      records: [record({ updatedAtMs: 5_000 })],
      generated: {
        "claude:a": note({
          summary: "old summary",
          recap: "kept recap",
          sourceMtimeMs: 4_000,
          generatedAtMs: 0,
        }),
      },
      engine: "llm",
      content: "summary",
      now: NOTE_WINDOW_MS,
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.store.generated["claude:a"]).toEqual({
      summary: "summary of C:\\a.jsonl",
      recap: "kept recap",
      generatedAtMs: NOTE_WINDOW_MS,
      sourceMtimeMs: 5_000,
    });
  });
});

describe("dispose", () => {
  function pending() {
    const gate = deferred<string | null>();
    const harness = makeScheduler({
      records: [
        record({ id: "a", filePath: "C:\\a.jsonl", updatedAtMs: 300 }),
        record({ id: "b", filePath: "C:\\b.jsonl", updatedAtMs: 200 }),
        record({ id: "c", filePath: "C:\\c.jsonl", updatedAtMs: 100 }),
      ],
      result: () => gate.promise,
    });
    return { gate, harness };
  }

  it("ignores an in-flight completion", async () => {
    const { gate, harness } = pending();
    harness.scheduler.reconcile(["claude:a", "claude:b", "claude:c"]);
    await tick();

    harness.scheduler.dispose();
    gate.resolve("note");
    await tick();

    expect(harness.store.writes).toEqual([]);
  });

  it("cancels everything still queued", async () => {
    const { gate, harness } = pending();
    harness.scheduler.reconcile(["claude:a", "claude:b", "claude:c"]);
    await tick();
    expect(harness.generate).toHaveBeenCalledTimes(1);

    harness.scheduler.dispose();
    gate.resolve("note");
    await tick();

    expect(harness.generate).toHaveBeenCalledTimes(1);
  });

  it("ignores reconcile after dispose", async () => {
    const harness = makeScheduler({ records: [record()] });

    harness.scheduler.dispose();
    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.generate).not.toHaveBeenCalled();
  });
});
