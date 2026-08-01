import { describe, expect, it, vi } from "vitest";
import {
  ConversationsStore,
  findRecord,
  loadConversationsStore,
} from "../store";
import { serializeConversations } from "../storage";
import type { ConversationsV1, LlmSessionRecord, SessionLister } from "../types";

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

function makeStore(
  options: {
    list?: SessionLister;
    initial?: ConversationsV1;
    save?: (text: string) => Promise<void>;
    onSaveError?: (error: unknown) => void;
    now?: () => number;
  } = {},
) {
  let sequence = 0;
  return new ConversationsStore({
    list: options.list ?? (async () => []),
    debounceMs: 0,
    generateId: () => `f${++sequence}`,
    ...(options.initial ? { initial: options.initial } : {}),
    ...(options.save ? { save: options.save } : {}),
    ...(options.onSaveError ? { onSaveError: options.onSaveError } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

describe("refresh", () => {
  it("invokes the injected lister and sorts newest first", async () => {
    const list = vi.fn<SessionLister>(async () => [
      record({ id: "old", updatedAtMs: 10 }),
      record({ id: "new", updatedAtMs: 300 }),
      record({ id: "mid", updatedAtMs: 100 }),
    ]);
    const store = makeStore({ list, now: () => 5_000 });

    await store.refresh(true);

    expect(list).toHaveBeenCalledWith(true);
    expect(store.getSnapshot().records.map((entry) => entry.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
    expect(store.getSnapshot().refreshedAtMs).toBe(5_000);
    expect(store.getSnapshot().refreshing).toBe(false);
  });

  it("marks refreshing while in flight and coalesces concurrent scans", async () => {
    let release: (value: LlmSessionRecord[]) => void = () => {};
    const list = vi.fn<SessionLister>(
      () => new Promise<LlmSessionRecord[]>((resolve) => {
        release = resolve;
      }),
    );
    const store = makeStore({ list });

    const first = store.refresh(false);
    const second = store.refresh(false);
    expect(store.getSnapshot().refreshing).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);

    release([record()]);
    await Promise.all([first, second]);
    expect(store.getSnapshot().refreshing).toBe(false);
    expect(store.getSnapshot().records).toHaveLength(1);
  });

  it("keeps previous records when the lister fails", async () => {
    let fail = false;
    const store = makeStore({
      list: async () => {
        if (fail) {
          throw new Error("host down");
        }
        return [record()];
      },
      now: () => 1,
    });
    await store.refresh(false);
    fail = true;
    await store.refresh(true);

    expect(store.getSnapshot().records).toHaveLength(1);
    expect(store.getSnapshot().refreshedAtMs).toBe(1);
    expect(store.getSnapshot().refreshing).toBe(false);
  });

  it("clears a selection whose session disappeared", async () => {
    let rows = [record({ id: "a" }), record({ id: "b" })];
    const store = makeStore({ list: async () => rows });
    await store.refresh(false);
    store.select("claude:b");
    rows = [record({ id: "a" })];
    await store.refresh(true);

    expect(store.getSnapshot().selectedKey).toBeNull();
    expect(findRecord(store.getSnapshot().records, "claude:a")?.id).toBe("a");
  });
});

describe("folders and assignment", () => {
  it("notifies subscribers and persists folder edits", async () => {
    const saved: string[] = [];
    const store = makeStore({
      save: async (text) => {
        saved.push(text);
      },
    });
    const listener = vi.fn();
    store.subscribe(listener);

    store.createFolder("Work");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().data.folders).toEqual([{ id: "f1", name: "Work" }]);

    store.assign("claude:a", "f1");
    store.renameFolder("f1", "Client");
    await store.flush();

    expect(saved.length).toBeGreaterThan(0);
    const last = JSON.parse(saved[saved.length - 1]!) as ConversationsV1;
    expect(last.folders).toEqual([{ id: "f1", name: "Client" }]);
    expect(last.assignments).toEqual({ "claude:a": "f1" });
  });

  it("unfiles sessions when their folder is deleted", async () => {
    const store = makeStore();
    store.createFolder("Work");
    store.assign("claude:a", "f1");
    store.deleteFolder("f1");

    expect(store.getSnapshot().data.folders).toEqual([]);
    expect(store.getSnapshot().data.assignments).toEqual({});
  });

  it("does not notify or save for a no-op edit", async () => {
    const save = vi.fn(async () => {});
    const store = makeStore({ save });
    const listener = vi.fn();
    store.subscribe(listener);

    store.assign("claude:a", "ghost-folder");
    store.renameFolder("nope", "x");
    store.createFolder("   ");
    await store.flush();

    expect(listener).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("contains save failures instead of throwing", async () => {
    const onSaveError = vi.fn();
    const store = makeStore({
      save: async () => {
        throw new Error("disk full");
      },
      onSaveError,
    });
    store.createFolder("Work");
    await store.flush();

    expect(onSaveError).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().data.folders).toHaveLength(1);
  });
});

describe("noteFor", () => {
  const generated: ConversationsV1 = {
    version: 1,
    folders: [],
    assignments: {},
    generated: {
      "claude:a": {
        summary: "generated summary",
        recap: "generated recap",
        generatedAtMs: 500,
        sourceMtimeMs: 100,
      },
    },
  };

  it("disk-only never consults the generated cache", () => {
    const store = makeStore({ initial: generated });
    expect(
      store.noteFor(record({ summary: "disk" }), { summaryEngine: "disk-only" }),
    ).toEqual({ summary: "disk", recap: null });
  });

  it("disk-first keeps disk values and fills only the gaps", () => {
    const store = makeStore({ initial: generated });
    expect(
      store.noteFor(record({ summary: "disk summary" }), {
        summaryEngine: "disk-first",
      }),
    ).toEqual({ summary: "disk summary", recap: "generated recap" });
  });

  it("llm prefers a fresh generated note and falls back when stale", () => {
    const store = makeStore({ initial: generated });
    const fresh = record({ summary: "disk summary", updatedAtMs: 100 });
    expect(store.noteFor(fresh, { summaryEngine: "llm" })).toEqual({
      summary: "generated summary",
      recap: "generated recap",
    });

    const moved = record({ summary: "disk summary", updatedAtMs: 900 });
    expect(store.noteFor(moved, { summaryEngine: "llm" })).toEqual({
      summary: "disk summary",
      recap: "generated recap",
    });
  });

  it("ignores the cache for a session with no transcript file", () => {
    const store = makeStore({ initial: generated });
    expect(
      store.noteFor(record({ filePath: "" }), { summaryEngine: "llm" }),
    ).toEqual({ summary: null, recap: null });
  });
});

describe("loadConversationsStore", () => {
  it("parses persisted state", async () => {
    const store = await loadConversationsStore({
      read: async () =>
        serializeConversations({
          version: 1,
          folders: [{ id: "f9", name: "Saved" }],
          assignments: {},
          generated: {},
        }),
      list: async () => [],
    });
    expect(store.getSnapshot().data.folders).toEqual([{ id: "f9", name: "Saved" }]);
  });

  it("degrades to empty state when the read fails, and never scans on load", async () => {
    const list = vi.fn<SessionLister>(async () => []);
    const store = await loadConversationsStore({
      read: async () => {
        throw new Error("no file");
      },
      list,
    });
    expect(store.getSnapshot().data.folders).toEqual([]);
    expect(store.getSnapshot().refreshedAtMs).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });
});
