import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyLayout, type LayoutV2 } from "../../state/layout";
import {
  ACTIVE_TAB_PERSIST_DEBOUNCE_MS,
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

function state(activeTabId: string | null): LayoutV2 {
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
    } satisfies LayoutV2;

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
    } satisfies LayoutV2;
    const third = {
      ...emptyLayout(),
      groups: {
        g3: { id: "g3", name: "Third", collapsed: false, color: null, items: [] },
      },
      rootItems: [{ kind: "group" as const, id: "g3" }],
    } satisfies LayoutV2;

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
});
