import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NOTE_WINDOW_MS,
  NoteScheduler,
  type NoteSchedulerStore,
} from "../noteScheduler";
import type { SummaryContent, SummaryEngine } from "../../settings/settings";
import type {
  BundleNote,
  GeneratedNote,
  LlmSessionRecord,
  SessionKey,
} from "../types";

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

/** What the default fake generator produces for a transcript path. */
function bundleFor(filePath: string): BundleNote {
  return {
    title: `title of ${filePath}`,
    summary: `summary of ${filePath}`,
    recap: `recap of ${filePath}`,
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
  /** Transcript paths passed to `generateBundle`, in call order. */
  readonly calls: string[];
  readonly generateBundle: ReturnType<typeof vi.fn>;
  setClock(value: number): void;
  advance(deltaMs: number): void;
}

/**
 * `result` decides what each generation resolves to; the default is a
 * synchronous success carrying all three bundle fields. The scheduler owns no
 * timers, so the injected clock is the only source of time and a single
 * macrotask tick drains the pump.
 */
function makeScheduler(options: {
  records: LlmSessionRecord[];
  generated?: Record<SessionKey, GeneratedNote>;
  engine?: SummaryEngine;
  content?: SummaryContent;
  now?: number;
  result?: (filePath: string) => Promise<BundleNote | null>;
}): Harness {
  const store = new FakeStore();
  store.records = options.records;
  store.generated = options.generated ?? {};
  let clock = options.now ?? 0;
  const calls: string[] = [];
  const generateBundle = vi.fn(async (filePath: string) => {
    calls.push(filePath);
    if (options.result) {
      return await options.result(filePath);
    }
    return bundleFor(filePath);
  });
  const scheduler = new NoteScheduler({
    generateBundle,
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
    generateBundle,
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

    expect(harness.generateBundle).not.toHaveBeenCalled();
    expect(harness.store.writes).toEqual([]);
  });

  it("generates under disk-first only for a session with a gap on disk", async () => {
    const harness = makeScheduler({
      records: [
        record({
          id: "has",
          summary: "harvested",
          recap: "harvested recap",
          filePath: "C:\\has.jsonl",
        }),
        record({ id: "gap", summary: null, filePath: "C:\\gap.jsonl" }),
      ],
      engine: "disk-first",
      content: "summary",
    });

    harness.scheduler.reconcile(["claude:has", "claude:gap"]);
    await tick();

    expect(harness.calls).toEqual(["C:\\gap.jsonl"]);
  });

  it("skips a disk-first session that the generated cache already fills", async () => {
    const harness = makeScheduler({
      records: [record()],
      generated: {
        "claude:a": note({
          summary: "cached",
          recap: "cached recap",
          sourceMtimeMs: 1,
        }),
      },
      engine: "disk-first",
      content: "summary",
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.generateBundle).not.toHaveBeenCalled();
  });

  it("generates under llm for a session present on disk but never generated", async () => {
    const harness = makeScheduler({
      records: [record({ summary: "harvested", recap: "harvested recap" })],
      engine: "llm",
      content: "summary",
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.calls).toEqual(["C:\\a.jsonl"]);
  });

  it("regenerates under llm when the cache holds only one of the two kinds", async () => {
    const harness = makeScheduler({
      records: [record({ updatedAtMs: 100 })],
      generated: {
        "claude:a": note({ summary: "cached", recap: null, sourceMtimeMs: 100 }),
      },
      engine: "llm",
      content: "both",
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.calls).toEqual(["C:\\a.jsonl"]);
    expect(harness.store.generated["claude:a"]?.recap).toBe(
      "recap of C:\\a.jsonl",
    );
  });

  it("generates nothing when summaryContent is none", async () => {
    const harness = makeScheduler({
      records: [record()],
      engine: "llm",
      content: "none",
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.generateBundle).not.toHaveBeenCalled();
  });

  it("schedules the same single bundle when summaryContent is recap", async () => {
    const harness = makeScheduler({
      records: [record()],
      engine: "disk-first",
      content: "recap",
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.calls).toEqual(["C:\\a.jsonl"]);
  });

  it("makes exactly one call per session and stores all three bundle fields", async () => {
    const harness = makeScheduler({
      records: [record()],
      engine: "disk-first",
      content: "both",
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.calls).toEqual(["C:\\a.jsonl"]);
    expect(harness.store.generated["claude:a"]).toEqual({
      title: "title of C:\\a.jsonl",
      summary: "summary of C:\\a.jsonl",
      recap: "recap of C:\\a.jsonl",
      generatedAtMs: 0,
      sourceMtimeMs: 100,
    });
  });
});

describe("staleness math", () => {
  const stale = { updatedAtMs: 5_000 };
  const cached = {
    summary: "cached",
    recap: "cached recap",
    sourceMtimeMs: 4_000,
    generatedAtMs: 0,
  };

  it("regenerates at exactly the 10-minute boundary", async () => {
    const harness = makeScheduler({
      records: [record(stale)],
      generated: { "claude:a": note(cached) },
      engine: "llm",
      now: NOTE_WINDOW_MS,
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.calls).toEqual(["C:\\a.jsonl"]);
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

    expect(harness.generateBundle).not.toHaveBeenCalled();
  });

  it("never regenerates a note whose source mtime already covers the record", async () => {
    const harness = makeScheduler({
      records: [record({ updatedAtMs: 5_000 })],
      generated: {
        "claude:a": note({
          summary: "cached",
          recap: "cached recap",
          sourceMtimeMs: 5_000,
        }),
      },
      engine: "llm",
      now: NOTE_WINDOW_MS * 100,
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.generateBundle).not.toHaveBeenCalled();
  });

  it("leaves a stale note under disk-first alone when disk already has both kinds", async () => {
    const harness = makeScheduler({
      records: [
        record({ ...stale, summary: "harvested", recap: "harvested recap" }),
      ],
      generated: { "claude:a": note(cached) },
      engine: "disk-first",
      now: NOTE_WINDOW_MS,
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.generateBundle).not.toHaveBeenCalled();
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
      result: async (filePath) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => gates.push(resolve));
        active -= 1;
        return bundleFor(filePath);
      },
    });

    harness.scheduler.reconcile(["claude:a", "claude:b", "claude:c"]);
    await tick();
    expect(harness.generateBundle).toHaveBeenCalledTimes(1);

    gates[0]?.();
    await tick();
    expect(harness.generateBundle).toHaveBeenCalledTimes(2);

    gates[1]?.();
    await tick();
    expect(harness.generateBundle).toHaveBeenCalledTimes(3);

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

    expect(harness.calls).toEqual([
      "C:\\new.jsonl",
      "C:\\mid.jsonl",
      "C:\\old.jsonl",
    ]);
  });

  it("does not enqueue the same session twice across reconciles", async () => {
    const gate = deferred<BundleNote | null>();
    const harness = makeScheduler({
      records: [record()],
      result: () => gate.promise,
    });

    harness.scheduler.reconcile(["claude:a"]);
    harness.scheduler.reconcile(["claude:a"]);
    await tick();
    gate.resolve(bundleFor("C:\\a.jsonl"));
    await tick();

    expect(harness.generateBundle).toHaveBeenCalledTimes(1);
  });
});

describe("visibility gating", () => {
  it("skips a queued key that the latest reconcile dropped", async () => {
    const gate = deferred<BundleNote | null>();
    let first = true;
    const harness = makeScheduler({
      records: [
        record({ id: "a", filePath: "C:\\a.jsonl", updatedAtMs: 200 }),
        record({ id: "b", filePath: "C:\\b.jsonl", updatedAtMs: 100 }),
      ],
      result: (filePath) => {
        if (first) {
          first = false;
          return gate.promise;
        }
        return Promise.resolve(bundleFor(filePath));
      },
    });

    harness.scheduler.reconcile(["claude:a", "claude:b"]);
    await tick();
    expect(harness.calls).toEqual(["C:\\a.jsonl"]);

    // "b" scrolls out of view while "a" is still generating.
    harness.scheduler.reconcile(["claude:a"]);
    gate.resolve(bundleFor("C:\\a.jsonl"));
    await tick();

    expect(harness.calls).toEqual(["C:\\a.jsonl"]);
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

    expect(harness.generateBundle).not.toHaveBeenCalled();
  });

  it("ignores a visible key with no matching record", async () => {
    const harness = makeScheduler({ records: [record()] });

    harness.scheduler.reconcile(["claude:a", "codex:missing"]);
    await tick();

    expect(harness.calls).toEqual(["C:\\a.jsonl"]);
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
    expect(harness.generateBundle).toHaveBeenCalledTimes(1);
    expect(harness.store.writes).toEqual([]);
    expect(harness.store.generated).toEqual({});

    // Immediately, and just short of the window: still throttled.
    harness.scheduler.reconcile(["claude:a"]);
    await tick();
    harness.advance(NOTE_WINDOW_MS - 1);
    harness.scheduler.reconcile(["claude:a"]);
    await tick();
    expect(harness.generateBundle).toHaveBeenCalledTimes(1);

    harness.advance(1);
    harness.scheduler.reconcile(["claude:a"]);
    await tick();
    expect(harness.generateBundle).toHaveBeenCalledTimes(2);
  });

  it("treats a rejected generation as a silent failure and keeps draining", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let first = true;
    const harness = makeScheduler({
      records: [
        record({ id: "a", filePath: "C:\\a.jsonl", updatedAtMs: 200 }),
        record({ id: "b", filePath: "C:\\b.jsonl", updatedAtMs: 100 }),
      ],
      result: (filePath) => {
        if (first) {
          first = false;
          return Promise.reject(new Error("spawn failed"));
        }
        return Promise.resolve(bundleFor(filePath));
      },
    });

    harness.scheduler.reconcile(["claude:a", "claude:b"]);
    await tick();

    expect(harness.generateBundle).toHaveBeenCalledTimes(2);
    expect(harness.store.writes.map((write) => write.key)).toEqual(["claude:b"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("success", () => {
  it("writes sourceMtimeMs captured at generation start, not completion", async () => {
    const gate = deferred<BundleNote | null>();
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
    gate.resolve({
      title: "fresh title",
      summary: "fresh summary",
      recap: "fresh recap",
    });
    await tick();

    expect(harness.store.writes).toEqual([
      {
        key: "claude:a",
        note: {
          title: "fresh title",
          summary: "fresh summary",
          recap: "fresh recap",
          generatedAtMs: 4_000,
          sourceMtimeMs: 5_000,
        },
      },
    ]);
  });

  it("replaces the whole cached note with the bundle it just generated", async () => {
    const harness = makeScheduler({
      records: [record({ updatedAtMs: 5_000 })],
      generated: {
        "claude:a": note({
          title: "old title",
          summary: "old summary",
          recap: "old recap",
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
      title: "title of C:\\a.jsonl",
      summary: "summary of C:\\a.jsonl",
      recap: "recap of C:\\a.jsonl",
      generatedAtMs: NOTE_WINDOW_MS,
      sourceMtimeMs: 5_000,
    });
  });

  it("stores a partial bundle verbatim, nulls included", async () => {
    const harness = makeScheduler({
      records: [record()],
      result: async () => ({
        title: null,
        summary: "only a summary",
        recap: null,
      }),
    });

    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.store.generated["claude:a"]).toEqual({
      title: null,
      summary: "only a summary",
      recap: null,
      generatedAtMs: 0,
      sourceMtimeMs: 100,
    });
  });
});

describe("dispose", () => {
  function pending() {
    const gate = deferred<BundleNote | null>();
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
    gate.resolve(bundleFor("C:\\a.jsonl"));
    await tick();

    expect(harness.store.writes).toEqual([]);
  });

  it("cancels everything still queued", async () => {
    const { gate, harness } = pending();
    harness.scheduler.reconcile(["claude:a", "claude:b", "claude:c"]);
    await tick();
    expect(harness.generateBundle).toHaveBeenCalledTimes(1);

    harness.scheduler.dispose();
    gate.resolve(bundleFor("C:\\a.jsonl"));
    await tick();

    expect(harness.generateBundle).toHaveBeenCalledTimes(1);
  });

  it("ignores reconcile after dispose", async () => {
    const harness = makeScheduler({ records: [record()] });

    harness.scheduler.dispose();
    harness.scheduler.reconcile(["claude:a"]);
    await tick();

    expect(harness.generateBundle).not.toHaveBeenCalled();
  });
});
