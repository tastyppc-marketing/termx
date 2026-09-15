import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyLayout, type Layout } from "../../state/layout";
import {
  ACTIVE_TAB_PERSIST_DEBOUNCE_MS,
  LAYOUT_WRITE_TIMEOUT_MS,
  LayoutPersistence,
} from "../LayoutPersistence";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function state(activeTabId: string | null): Layout {
  const layout = emptyLayout();
  return { ...layout, activeTabId };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LayoutPersistence", () => {
  it("starts structural writes immediately", async () => {
    const setLayout = vi.fn(async (_layout: unknown) => undefined);
    const persistence = new LayoutPersistence({ setLayout });
    const layout = state(null);

    persistence.record(layout, "structural");
    expect(setLayout).toHaveBeenCalledTimes(1);
    await persistence.flush();
    expect(persistence.getSnapshot()).toEqual({ saving: false, error: null });
  });

  it("debounces active-tab-only writes for two seconds", async () => {
    vi.useFakeTimers();
    const setLayout = vi.fn(async (_layout: unknown) => undefined);
    const persistence = new LayoutPersistence({ setLayout });

    persistence.record(state(null), "active_tab");
    await vi.advanceTimersByTimeAsync(ACTIVE_TAB_PERSIST_DEBOUNCE_MS - 1);
    expect(setLayout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(setLayout).toHaveBeenCalledTimes(1);
    await persistence.flush();
  });

  it("structural changes cancel a pending active timer and persist the newest state", async () => {
    vi.useFakeTimers();
    const setLayout = vi.fn(async (_layout: unknown) => undefined);
    const persistence = new LayoutPersistence({ setLayout });
    const active = state(null);
    const structural = {
      ...emptyLayout(),
      groups: {
        g: { id: "g", name: "Group", collapsed: false, color: null, items: [] },
      },
      rootItems: [{ kind: "group" as const, id: "g" }],
    } satisfies Layout;

    persistence.record(active, "active_tab");
    persistence.record(structural, "structural");
    expect(setLayout).toHaveBeenCalledTimes(1);
    expect(setLayout.mock.calls[0]?.[0]).toMatchObject({ groups: structural.groups });
    await vi.advanceTimersByTimeAsync(ACTIVE_TAB_PERSIST_DEBOUNCE_MS);
    expect(setLayout).toHaveBeenCalledTimes(1);
  });

  it("coalesces writes arriving in flight to the latest layout", async () => {
    const first = deferred<void>();
    const setLayout = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const persistence = new LayoutPersistence({ setLayout });
    const second = {
      ...emptyLayout(),
      groups: {
        g2: { id: "g2", name: "Second", collapsed: false, color: null, items: [] },
      },
      rootItems: [{ kind: "group" as const, id: "g2" }],
    } satisfies Layout;
    const third = {
      ...emptyLayout(),
      groups: {
        g3: { id: "g3", name: "Third", collapsed: false, color: null, items: [] },
      },
      rootItems: [{ kind: "group" as const, id: "g3" }],
    } satisfies Layout;

    persistence.record(emptyLayout(), "structural");
    persistence.record(second, "structural");
    persistence.record(third, "structural");
    expect(setLayout).toHaveBeenCalledTimes(1);

    first.resolve();
    await persistence.flush();
    expect(setLayout).toHaveBeenCalledTimes(2);
    expect(setLayout.mock.calls[1]?.[0]).toMatchObject({ groups: third.groups });
  });

  it("retries a failed write exactly once and clears the error after later success", async () => {
    const setLayout = vi.fn()
      .mockRejectedValueOnce(new Error("disk busy"))
      .mockRejectedValueOnce(new Error("disk busy again"))
      .mockResolvedValueOnce(undefined);
    const persistence = new LayoutPersistence({ setLayout });

    persistence.record(emptyLayout(), "structural");
    await persistence.flush();
    expect(setLayout).toHaveBeenCalledTimes(2);
    expect(persistence.getSnapshot().error).toBe("Unable to save the workspace layout.");

    persistence.record(emptyLayout(), "structural");
    await persistence.flush();
    expect(setLayout).toHaveBeenCalledTimes(3);
    expect(persistence.getSnapshot().error).toBeNull();
  });

  it("dispose cancels timers without closing the writer", async () => {
    vi.useFakeTimers();
    const setLayout = vi.fn(async (_layout: unknown) => undefined);
    const persistence = new LayoutPersistence({ setLayout });
    persistence.record(emptyLayout(), "active_tab");

    persistence.dispose();
    await vi.advanceTimersByTimeAsync(ACTIVE_TAB_PERSIST_DEBOUNCE_MS);
    expect(setLayout).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the latest exhausted write for recovery without spinning flush", async () => {
    let available = false;
    let saved: unknown = null;
    const setLayout = vi.fn(async (layout: unknown) => {
      if (!available) throw new Error("offline");
      saved = layout;
    });
    const persistence = new LayoutPersistence({ setLayout });
    const layout = { ...emptyLayout(), windowNames: { main: "Offline edit" } };
    persistence.record(layout, "structural");
    await persistence.flush();
    await persistence.flush();
    expect(setLayout).toHaveBeenCalledTimes(2);
    available = true;
    persistence.retry();
    await persistence.flush();
    expect(saved).toMatchObject({ windowNames: { main: "Offline edit" } });
    expect(persistence.getSnapshot()).toEqual({ saving: false, error: null });
    persistence.dispose();
  });

  it("does not restore an old failed snapshot over a newer change", async () => {
    const setLayout = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const persistence = new LayoutPersistence({ setLayout });
    persistence.record({ ...emptyLayout(), windowNames: { main: "Old" } }, "structural");
    await persistence.flush();
    persistence.record({ ...emptyLayout(), windowNames: { main: "New" } }, "structural");
    await persistence.flush();
    persistence.retry();
    await persistence.flush();
    expect(setLayout).toHaveBeenCalledTimes(3);
    expect(setLayout.mock.calls[2]?.[0]).toMatchObject({ windowNames: { main: "New" } });
    persistence.dispose();
  });

  it("keeps a synchronous subscriber's newer edit after recovering an old write", async () => {
    const setLayout = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const persistence = new LayoutPersistence({ setLayout });
    persistence.record({ ...emptyLayout(), windowNames: { main: "Old" } }, "structural");
    await persistence.flush();
    let edited = false;
    persistence.subscribe(() => {
      if (!edited && persistence.getSnapshot().saving) {
        edited = true;
        persistence.record({ ...emptyLayout(), windowNames: { main: "New" } }, "structural");
      }
    });
    persistence.retry();
    await persistence.flush();
    expect(setLayout.mock.calls.at(-1)?.[0]).toMatchObject({ windowNames: { main: "New" } });
    persistence.dispose();
  });

  it("finishes an existing flush when disposal is followed by a failed write", async () => {
    const first = deferred<void>();
    const setLayout = vi.fn(() => first.promise);
    const persistence = new LayoutPersistence({ setLayout });
    persistence.record(emptyLayout(), "structural");
    const flushing = persistence.flush();
    persistence.dispose();
    first.reject(new Error("closed"));
    // Check the settlement state before awaiting flush so a regression cannot
    // starve Vitest's own timeout with an endless microtask loop.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect((persistence as unknown as { pending: unknown }).pending).toBeNull();
    await flushing;
    expect(setLayout).toHaveBeenCalledTimes(1);
  });

  it("remembers reconnect while the exhausted old attempt is still settling", async () => {
    const second = deferred<void>();
    const setLayout = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => second.promise).mockResolvedValue(undefined);
    const persistence = new LayoutPersistence({ setLayout });
    const layout = { ...emptyLayout(), windowNames: { main: "Recovery" } };
    persistence.record(layout, "structural");
    await vi.waitFor(() => expect(setLayout).toHaveBeenCalledTimes(2));
    persistence.retry();
    second.reject(new Error("old connection closed"));
    await persistence.flush();
    expect(setLayout).toHaveBeenCalledTimes(3);
    expect(setLayout.mock.calls[2]?.[0]).toMatchObject({ windowNames: { main: "Recovery" } });
    expect(persistence.getSnapshot()).toEqual({ saving: false, error: null });
  });

  /**
   * A write that is never answered is the one failure mode with no floor
   * under it: the socket stays open, so nothing rejects, and every later
   * change piles up behind the write that will never finish. The user is told
   * the workspace is "saving" for as long as the app stays open, and every
   * name they type in the meantime is gone the moment they restart it.
   *
   * (Michael, 2026-09-15, third report of pane names not sticking. His host
   * keeps a request queue with no timeout of its own, so one unanswered reply
   * stalls every layout write behind it.)
   */
  it("gives up on a write that is never answered instead of losing what came after", async () => {
    vi.useFakeTimers();
    const hung = deferred<void>();
    const setLayout = vi.fn()
      .mockImplementationOnce(() => hung.promise)
      .mockResolvedValue(undefined);
    const persistence = new LayoutPersistence({ setLayout });

    persistence.record({ ...emptyLayout(), windowNames: { main: "First" } }, "structural");
    // The name typed while the first write hangs.
    persistence.record({ ...emptyLayout(), windowNames: { main: "Renamed" } }, "structural");
    expect(setLayout).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(LAYOUT_WRITE_TIMEOUT_MS);

    // The newest layout is written, and the stall is reported rather than
    // shown as an endless "saving".
    expect(setLayout.mock.calls.at(-1)?.[0]).toMatchObject({
      windowNames: { main: "Renamed" },
    });
    expect(persistence.getSnapshot().saving).toBe(false);
    hung.resolve();
    persistence.dispose();
  });

  it("stops flushing a write that never answers, so closing the window is not a hang", async () => {
    vi.useFakeTimers();
    const hung = deferred<void>();
    const setLayout = vi.fn().mockImplementation(() => hung.promise);
    const persistence = new LayoutPersistence({ setLayout });
    persistence.record(emptyLayout(), "structural");

    let settled = false;
    void persistence.flush().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(LAYOUT_WRITE_TIMEOUT_MS * 3);

    expect(settled).toBe(true);
    expect(persistence.getSnapshot().error).toBe("Unable to save the workspace layout.");
    hung.resolve();
    persistence.dispose();
  });

  it("does not write after a subscriber disposes while saving is announced", async () => {
    const setLayout = vi.fn().mockResolvedValue(undefined);
    const persistence = new LayoutPersistence({ setLayout });
    persistence.subscribe(() => persistence.dispose());
    persistence.record(emptyLayout(), "structural");
    await persistence.flush();
    expect(setLayout).not.toHaveBeenCalled();
  });
});
