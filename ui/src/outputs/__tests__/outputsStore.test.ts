import { describe, expect, it, vi } from "vitest";
import { OutputsStore } from "../outputsStore";

describe("OutputsStore", () => {
  it("keeps registrations newest first, per session", () => {
    const store = new OutputsStore();
    store.register(1, "C:\\out\\a.md", 100);
    store.register(1, "C:\\out\\b.md", 300);
    store.register(1, "C:\\out\\c.md", 200);
    store.register(2, "C:\\other\\z.md", 999);

    expect(store.snapshotFor(1)).toEqual([
      { path: "C:\\out\\b.md", atMs: 300 },
      { path: "C:\\out\\c.md", atMs: 200 },
      { path: "C:\\out\\a.md", atMs: 100 },
    ]);
    expect(store.snapshotFor(2)).toEqual([{ path: "C:\\other\\z.md", atMs: 999 }]);
    expect(store.snapshotFor(3)).toEqual([]);
  });

  it("dedupes by path, keeping the newest timestamp", () => {
    const store = new OutputsStore();
    store.register(1, "C:\\out\\a.md", 100);
    store.register(1, "C:\\out\\b.md", 150);
    store.register(1, "C:\\out\\a.md", 400);
    store.register(1, "C:\\out\\a.md", 200); // older repeat keeps 400

    expect(store.snapshotFor(1)).toEqual([
      { path: "C:\\out\\a.md", atMs: 400 },
      { path: "C:\\out\\b.md", atMs: 150 },
    ]);
  });

  it("ignores empty paths without notifying", () => {
    const store = new OutputsStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.register(1, "", 100);

    expect(listener).not.toHaveBeenCalled();
    expect(store.snapshotFor(1)).toEqual([]);
  });

  it("notifies subscribers on register and clear, and stops after unsubscribe", () => {
    const store = new OutputsStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.register(1, "C:\\out\\a.md", 100);
    expect(listener).toHaveBeenCalledTimes(1);

    store.clear(1);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.snapshotFor(1)).toEqual([]);

    // Clearing an unknown session is a no-op, not a notification.
    store.clear(1);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.register(1, "C:\\out\\b.md", 200);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("returns a stable snapshot reference until that session changes", () => {
    const store = new OutputsStore();
    store.register(1, "C:\\out\\a.md", 100);
    const first = store.snapshotFor(1);

    expect(store.snapshotFor(1)).toBe(first);
    store.register(2, "C:\\other\\z.md", 100);
    expect(store.snapshotFor(1)).toBe(first);

    store.register(1, "C:\\out\\b.md", 200);
    expect(store.snapshotFor(1)).not.toBe(first);
    expect(store.snapshotFor(3)).toBe(store.snapshotFor(4));
  });
});
