import { describe, expect, it, vi } from "vitest";
import type { AppFileName, AppFileStore } from "../../native/appFiles";
import {
  SAVED_SESSIONS_FILE,
  createSavedSessionsStore,
  parseSavedSessions,
  serializeSavedSessions,
} from "../store";
import type { SavedSession } from "../types";

interface FakeFiles extends AppFileStore {
  /** Every write, in order — the debounce collapses runs, so this is short. */
  readonly writes: readonly string[];
  text: string | null;
  reads: number;
  failRead: boolean;
  failWrite: boolean;
}

function fakeFiles(initial: string | null = null): FakeFiles {
  const writes: string[] = [];
  const files: FakeFiles = {
    writes,
    text: initial,
    reads: 0,
    failRead: false,
    failWrite: false,
    read(name: AppFileName) {
      expect(name).toBe(SAVED_SESSIONS_FILE);
      files.reads += 1;
      if (files.failRead) {
        return Promise.reject(new Error("ipc down"));
      }
      return Promise.resolve(files.text);
    },
    write(name: AppFileName, contents: string) {
      expect(name).toBe(SAVED_SESSIONS_FILE);
      if (files.failWrite) {
        return Promise.reject(new Error("disk full"));
      }
      writes.push(contents);
      files.text = contents;
      return Promise.resolve();
    },
  };
  return files;
}

/** Deterministic ids/clock; the production defaults are randomUUID/Date.now. */
function testStore(files: AppFileStore, startMs = 1_000) {
  let clock = startMs;
  let seq = 0;
  const store = createSavedSessionsStore(files, {
    now: () => clock,
    generateId: () => `id-${(seq += 1)}`,
  });
  return {
    store,
    tick(ms: number) {
      clock += ms;
    },
  };
}

function fileOf(saved: readonly Partial<SavedSession>[]): string {
  return JSON.stringify({ version: 1, saved });
}

const ENTRY: SavedSession = {
  id: "entry-1",
  name: "OpenSEO audit",
  description: "mid-audit, ledger open",
  cwd: "C:\\Users\\mjfos\\code\\open SEO",
  conversation: { provider: "claude", id: "conv-a", title: "OpenSEO audit" },
  lastDaemonSessionId: 7,
  createdAtMs: 100,
  updatedAtMs: 200,
};

describe("parseSavedSessions", () => {
  it("returns an empty list for a missing or corrupt file", () => {
    expect(parseSavedSessions(null)).toEqual([]);
    expect(parseSavedSessions("")).toEqual([]);
    expect(parseSavedSessions("{not json")).toEqual([]);
    expect(parseSavedSessions("42")).toEqual([]);
    expect(parseSavedSessions("null")).toEqual([]);
    expect(parseSavedSessions("[]")).toEqual([]);
    expect(parseSavedSessions(JSON.stringify({ version: 1 }))).toEqual([]);
    expect(parseSavedSessions(JSON.stringify({ saved: "nope" }))).toEqual([]);
  });

  it("round-trips a full entry through serialize", () => {
    expect(parseSavedSessions(serializeSavedSessions([ENTRY]))).toEqual([ENTRY]);
  });

  it("serializes the documented file shape", () => {
    const text = serializeSavedSessions([ENTRY]);
    expect(JSON.parse(text)).toEqual({ version: 1, saved: [ENTRY] });
    expect(text.endsWith("\n")).toBe(true);
  });

  it("drops entries missing an id, name, or cwd", () => {
    const parsed = parseSavedSessions(
      fileOf([
        { name: "no id", cwd: "C:\\a", createdAtMs: 1, updatedAtMs: 1 },
        { id: "b", cwd: "C:\\b", createdAtMs: 1, updatedAtMs: 1 },
        { id: "c", name: "no cwd", createdAtMs: 1, updatedAtMs: 1 },
        { id: "d", name: "   ", cwd: "C:\\d", createdAtMs: 1, updatedAtMs: 1 },
        { id: "", name: "empty id", cwd: "C:\\e", createdAtMs: 1, updatedAtMs: 1 },
        { id: "good", name: "keeper", cwd: "C:\\ok", createdAtMs: 1, updatedAtMs: 2 },
      ]),
    );
    expect(parsed).toEqual([
      { id: "good", name: "keeper", cwd: "C:\\ok", createdAtMs: 1, updatedAtMs: 2 },
    ]);
  });

  it("drops junk rows and duplicate ids without throwing", () => {
    const parsed = parseSavedSessions(
      JSON.stringify({
        version: 1,
        saved: [
          null,
          "string",
          42,
          [],
          { id: "dup", name: "first", cwd: "C:\\1", createdAtMs: 1, updatedAtMs: 1 },
          { id: "dup", name: "second", cwd: "C:\\2", createdAtMs: 1, updatedAtMs: 1 },
        ],
      }),
    );
    expect(parsed).toEqual([
      { id: "dup", name: "first", cwd: "C:\\1", createdAtMs: 1, updatedAtMs: 1 },
    ]);
  });

  it("degrades bad optional fields instead of dropping the entry", () => {
    const [entry] = parseSavedSessions(
      fileOf([
        {
          id: "x",
          name: "keeper",
          cwd: "C:\\x",
          description: 7 as unknown as string,
          conversation: { provider: "gemini", id: "c" } as never,
          lastDaemonSessionId: "7" as unknown as number,
          createdAtMs: "soon" as unknown as number,
          updatedAtMs: Number.NaN,
        },
      ]),
    );
    expect(entry).toEqual({
      id: "x",
      name: "keeper",
      cwd: "C:\\x",
      createdAtMs: 0,
      updatedAtMs: 0,
    });
  });

  it("keeps a good conversation ref and falls back to the id for a junk title", () => {
    const [entry] = parseSavedSessions(
      fileOf([
        {
          id: "x",
          name: "keeper",
          cwd: "C:\\x",
          conversation: { provider: "codex", id: "conv-z", title: 9 } as never,
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      ]),
    );
    expect(entry?.conversation).toEqual({
      provider: "codex",
      id: "conv-z",
      title: "conv-z",
    });
  });

  it("keeps only a usable daemon session id", () => {
    const ids = [7, 0, -1, 2.5, Number.POSITIVE_INFINITY, null, "7"];
    const parsed = parseSavedSessions(
      fileOf(
        ids.map((lastDaemonSessionId, index) => ({
          id: `id-${index}`,
          name: "keeper",
          cwd: "C:\\x",
          lastDaemonSessionId: lastDaemonSessionId as number,
          createdAtMs: 1,
          updatedAtMs: 1,
        })),
      ),
    );
    expect(parsed.map((entry) => entry.lastDaemonSessionId)).toEqual([
      7,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("createSavedSessionsStore", () => {
  it("starts empty, hydrates from the file once, and notifies", async () => {
    const files = fakeFiles(serializeSavedSessions([ENTRY]));
    const { store } = testStore(files);
    const listener = vi.fn();
    store.subscribe(listener);

    expect(store.getSnapshot()).toEqual([]);

    await store.ready();

    expect(store.getSnapshot()).toEqual([ENTRY]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(files.reads).toBe(1);

    await store.ready();
    expect(files.reads).toBe(1);
  });

  it("degrades a corrupt file and a failed read to an empty list", async () => {
    const corrupt = fakeFiles("{broken");
    const broken = testStore(corrupt);
    await broken.store.ready();
    expect(broken.store.getSnapshot()).toEqual([]);

    const unreadable = fakeFiles(serializeSavedSessions([ENTRY]));
    unreadable.failRead = true;
    const offline = testStore(unreadable);
    await offline.store.ready();
    expect(offline.store.getSnapshot()).toEqual([]);
  });

  it("does not write during load", async () => {
    const files = fakeFiles("{broken");
    const { store } = testStore(files);
    await store.ready();
    await store.flush();
    expect(files.writes).toEqual([]);
  });

  it("round-trips saves through the file into a fresh store", async () => {
    const files = fakeFiles();
    const first = testStore(files);
    await first.store.ready();

    first.store.save({
      name: "OpenSEO audit",
      description: "ledger open",
      cwd: "C:\\code\\open SEO",
      conversation: { provider: "claude", id: "conv-a", title: "OpenSEO audit" },
      lastDaemonSessionId: 4,
    });
    first.tick(50);
    first.store.save({ name: "scratch", cwd: "C:\\scratch" });
    await first.store.flush();

    // User-initiated saves write immediately (a pin made just before closing
    // the window must survive), so each save is its own file write.
    expect(files.writes).toHaveLength(2);

    const second = testStore(files);
    await second.store.ready();
    expect(second.store.getSnapshot()).toEqual(first.store.getSnapshot());
    expect(second.store.getSnapshot()).toEqual([
      {
        id: "id-1",
        name: "OpenSEO audit",
        description: "ledger open",
        cwd: "C:\\code\\open SEO",
        conversation: { provider: "claude", id: "conv-a", title: "OpenSEO audit" },
        lastDaemonSessionId: 4,
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
      },
      {
        id: "id-2",
        name: "scratch",
        cwd: "C:\\scratch",
        createdAtMs: 1_050,
        updatedAtMs: 1_050,
      },
    ]);
  });

  it("writes user mutations immediately but keeps touchDaemonSession debounced", async () => {
    const files = fakeFiles();
    const { store } = testStore(files);
    await store.ready();

    // save/update/remove are things the user just did — each hits the disk
    // without waiting out a debounce a window close could interrupt.
    const entry = store.save({ name: "pin", cwd: "C:\\x" });
    await store.flush();
    expect(files.writes).toHaveLength(1);

    store.update(entry.id, { name: "pin 2" });
    await store.flush();
    expect(files.writes).toHaveLength(2);

    // Machine bookkeeping stays debounced: no write until the timer (or an
    // explicit flush) runs it.
    store.touchDaemonSession(entry.id, 7);
    await Promise.resolve();
    await Promise.resolve();
    expect(files.writes).toHaveLength(2);
    await store.flush();
    expect(files.writes).toHaveLength(3);

    store.remove(entry.id);
    await store.flush();
    expect(files.writes).toHaveLength(4);
  });

  it("upserts by conversation id, keeping id and createdAtMs", async () => {
    const files = fakeFiles();
    const { store, tick } = testStore(files);
    await store.ready();

    const created = store.save({
      name: "audit",
      description: "first pass",
      cwd: "C:\\code\\a",
      conversation: { provider: "claude", id: "conv-a", title: "audit" },
      lastDaemonSessionId: 1,
    });
    tick(500);
    const updated = store.save({
      name: "audit (renamed)",
      description: "second pass",
      cwd: "C:\\code\\b",
      conversation: { provider: "claude", id: "conv-a", title: "audit" },
      lastDaemonSessionId: 9,
    });

    expect(store.getSnapshot()).toHaveLength(1);
    expect(updated).toEqual({
      id: created.id,
      name: "audit (renamed)",
      description: "second pass",
      cwd: "C:\\code\\b",
      conversation: { provider: "claude", id: "conv-a", title: "audit" },
      lastDaemonSessionId: 9,
      createdAtMs: 1_000,
      updatedAtMs: 1_500,
    });
    expect(store.getSnapshot()[0]).toEqual(updated);

    // The input is the whole save: fields it omits are cleared, not inherited.
    const bare = store.save({
      name: "audit",
      cwd: "C:\\code\\b",
      conversation: { provider: "claude", id: "conv-a", title: "audit" },
    });
    expect(bare.description).toBeUndefined();
    expect(bare.lastDaemonSessionId).toBeUndefined();
    expect(bare.id).toBe(created.id);
    expect(bare.createdAtMs).toBe(1_000);
  });

  it("keeps a different conversation in its own entry", async () => {
    const { store } = testStore(fakeFiles());
    await store.ready();

    store.save({
      name: "a",
      cwd: "C:\\a",
      conversation: { provider: "claude", id: "conv-a", title: "a" },
    });
    store.save({
      name: "b",
      cwd: "C:\\b",
      conversation: { provider: "codex", id: "conv-b", title: "b" },
    });

    expect(store.getSnapshot().map((entry) => entry.name)).toEqual(["a", "b"]);
  });

  it("appends every bare-shell save, even with the same folder", async () => {
    const { store } = testStore(fakeFiles());
    await store.ready();

    const first = store.save({ name: "shell", cwd: "C:\\code" });
    const second = store.save({ name: "shell", cwd: "C:\\code" });

    expect(first.id).not.toBe(second.id);
    expect(store.getSnapshot()).toHaveLength(2);
    expect(store.getSnapshot().every((entry) => entry.conversation === undefined))
      .toBe(true);
  });

  it("update patches name and description only, and ignores unknown ids", async () => {
    const files = fakeFiles();
    const { store } = testStore(files);
    await store.ready();
    const entry = store.save({
      name: "old",
      description: "old note",
      cwd: "C:\\a",
      conversation: { provider: "claude", id: "conv-a", title: "old" },
      lastDaemonSessionId: 3,
    });
    await store.flush();
    const writesAfterSave = files.writes.length;

    store.update(entry.id, { name: "new" });
    expect(store.getSnapshot()[0]).toEqual({ ...entry, name: "new" });

    store.update(entry.id, { description: "new note" });
    expect(store.getSnapshot()[0]).toEqual({
      ...entry,
      name: "new",
      description: "new note",
    });

    // An empty description clears the field rather than storing "".
    store.update(entry.id, { description: "" });
    expect(store.getSnapshot()[0]?.description).toBeUndefined();

    const before = store.getSnapshot();
    store.update("nope", { name: "ghost" });
    store.update(entry.id, {});
    store.update(entry.id, { name: "new" });
    expect(store.getSnapshot()).toBe(before);

    await store.flush();
    expect(files.writes.length).toBeGreaterThan(writesAfterSave);
  });

  it("removes an entry and ignores an unknown id", async () => {
    const files = fakeFiles();
    const { store } = testStore(files);
    await store.ready();
    const kept = store.save({ name: "keep", cwd: "C:\\keep" });
    const gone = store.save({ name: "gone", cwd: "C:\\gone" });
    await store.flush();
    const writes = files.writes.length;

    store.remove(gone.id);
    expect(store.getSnapshot()).toEqual([kept]);

    const before = store.getSnapshot();
    store.remove("nope");
    expect(store.getSnapshot()).toBe(before);

    await store.flush();
    expect(files.writes.length).toBe(writes + 1);
  });

  it("touchDaemonSession records the session and stamps updatedAtMs", async () => {
    const files = fakeFiles();
    const { store, tick } = testStore(files);
    await store.ready();
    const entry = store.save({ name: "keep", cwd: "C:\\keep" });
    await store.flush();
    const writes = files.writes.length;

    tick(250);
    store.touchDaemonSession(entry.id, 12);
    expect(store.getSnapshot()[0]).toEqual({
      ...entry,
      lastDaemonSessionId: 12,
      updatedAtMs: 1_250,
    });

    // Same session id again changes nothing: no notify, no write.
    const before = store.getSnapshot();
    store.touchDaemonSession(entry.id, 12);
    store.touchDaemonSession("nope", 99);
    expect(store.getSnapshot()).toBe(before);

    await store.flush();
    expect(files.writes.length).toBe(writes + 1);
  });

  it("keeps the snapshot reference stable between changes", async () => {
    const { store } = testStore(fakeFiles());
    await store.ready();
    const empty = store.getSnapshot();
    expect(store.getSnapshot()).toBe(empty);

    store.save({ name: "a", cwd: "C:\\a" });
    const afterSave = store.getSnapshot();
    expect(afterSave).not.toBe(empty);
    expect(store.getSnapshot()).toBe(afterSave);
  });

  it("notifies subscribers once per real change and stops after unsubscribe", async () => {
    const { store } = testStore(fakeFiles());
    await store.ready();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    const entry = store.save({ name: "a", cwd: "C:\\a" });
    expect(listener).toHaveBeenCalledTimes(1);
    store.update(entry.id, { name: "b" });
    expect(listener).toHaveBeenCalledTimes(2);
    store.update("nope", { name: "c" });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.remove(entry.id);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toEqual([]);
  });

  it("keeps entries saved before hydration finishes", async () => {
    const files = fakeFiles(serializeSavedSessions([ENTRY]));
    const { store } = testStore(files);

    const early = store.save({ name: "early", cwd: "C:\\early" });
    await store.ready();

    expect(store.getSnapshot().map((entry) => entry.id)).toEqual([
      ENTRY.id,
      early.id,
    ]);
    await store.flush();
    expect(JSON.parse(files.writes.at(-1)!).saved).toHaveLength(2);
  });

  it("serializes writes and survives a failing one", async () => {
    const files = fakeFiles();
    files.failWrite = true;
    const errors: unknown[] = [];
    const store = createSavedSessionsStore(files, {
      onSaveError: (error) => errors.push(error),
    });
    await store.ready();

    store.save({ name: "a", cwd: "C:\\a" });
    await store.flush();
    expect(errors).toHaveLength(1);

    files.failWrite = false;
    store.save({ name: "b", cwd: "C:\\b" });
    await store.flush();
    expect(store.getSnapshot()).toHaveLength(2);
    expect(files.writes).toHaveLength(1);
  });

  it("uses uuids and the wall clock by default", async () => {
    const store = createSavedSessionsStore(fakeFiles());
    await store.ready();
    const before = Date.now();
    const entry = store.save({ name: "a", cwd: "C:\\a" });

    expect(entry.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(entry.createdAtMs).toBeGreaterThanOrEqual(before);
    expect(entry.updatedAtMs).toBe(entry.createdAtMs);
    await store.flush();
  });
});
