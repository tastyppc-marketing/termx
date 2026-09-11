import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyLayout, serializeLayout, type Layout } from "../../state/layout";
import { paneTitleInSplit } from "../layoutOperations";
import { createLayoutStore } from "../../state/store";
import { LayoutPersistence } from "../LayoutPersistence";
import { auxiliaryLayoutSync, mainLayoutSync, mergeLayout, LAYOUT_RECEIPT_TIMEOUT_MS } from "../layoutSync";
import { loopbackBus, type LayoutSyncMetadata, type WindowBus } from "../windowBus";

function layout(): Layout {
  const result = emptyLayout();
  for (const id of ["a", "b"]) result.tabs[id] = {
    id, title: null, color: "blue", fill: "off", split: { kind: "pane", sessionId: id === "a" ? 1 : 2 },
  };
  result.rootItems = [{ kind: "tab", id: "a" }, { kind: "tab", id: "b" }];
  result.activeTabId = "a";
  return result;
}

afterEach(() => vi.useRealTimers());

describe("base-relative layout merge", () => {
  it("preserves concurrent changes to separate properties of the same tab", () => {
    const base = layout();
    const proposed = structuredClone(base);
    const current = structuredClone(base);
    proposed.tabs.a!.title = "New title";
    current.tabs.a!.color = "red";
    expect(mergeLayout(base, proposed, current)?.tabs.a).toMatchObject({ title: "New title", color: "red" });
  });

  it("rejects different changes to the same property", () => {
    const base = layout();
    const proposed = structuredClone(base);
    const current = structuredClone(base);
    proposed.tabs.a!.title = "Aux";
    current.tabs.a!.title = "Main";
    expect(mergeLayout(base, proposed, current)).toBeNull();
  });

  it("merges a move with an unrelated rename and validates the whole result", () => {
    const base = layout();
    const proposed = structuredClone(base);
    const current = structuredClone(base);
    proposed.rootItems = [{ kind: "tab", id: "a" }];
    proposed.auxWindows.aux = { rootItems: [{ kind: "tab", id: "b" }], activeTabId: "b", bounds: null };
    current.tabs.a!.title = "Main";
    const merged = mergeLayout(base, proposed, current)!;
    expect(merged.tabs.a!.title).toBe("Main");
    expect(merged.auxWindows.aux!.rootItems).toEqual([{ kind: "tab", id: "b" }]);
    // Two independently valid moves put the same tab in different windows.
    current.rootItems = [{ kind: "tab", id: "a" }];
    current.auxWindows.other = { rootItems: [{ kind: "tab", id: "b" }], activeTabId: "b", bounds: null };
    expect(mergeLayout(base, proposed, current)).toBeNull();
  });

  it("does not combine competing split changes into a tree neither user requested", () => {
    const base = layout();
    base.tabs.a!.split = { kind: "split", dir: "row", sizes: [0.5, 0.5], children: [
      { kind: "pane", sessionId: 1 }, { kind: "pane", sessionId: 3 },
    ] };
    const proposed = structuredClone(base);
    const current = structuredClone(base);
    if (proposed.tabs.a!.split.kind === "split") proposed.tabs.a!.split.sizes = [0.3, 0.7];
    current.tabs.a!.split = { kind: "pane", sessionId: 1 };
    expect(mergeLayout(base, proposed, current)).toBeNull();
  });
});

function replicas() {
  const bus = loopbackBus();
  const mainStore = createLayoutStore(layout());
  const auxStore = createLayoutStore(layout());
  const save = vi.fn();
  const notice = vi.fn();
  const main = mainLayoutSync(mainStore, bus, save);
  const aux = auxiliaryLayoutSync(auxStore, bus, notice);
  bus.onMutation(main.receive);
  bus.onLayout(aux.receive);
  const persistence = new LayoutPersistence(aux);
  return { bus, mainStore, auxStore, save, notice, main, aux, persistence };
}

describe("layout replica receipts", () => {
  it("persists pane names from an auxiliary window alongside another tab's rename", async () => {
    const { mainStore, auxStore, main, persistence, aux, save, notice } = replicas();
    auxStore.renamePane(2, "Tests");
    mainStore.renamePane(1, "Build");
    await main.broadcast();
    persistence.record(auxStore.getState(), "structural");
    await persistence.flush();
    for (const store of [mainStore, auxStore]) {
      expect(paneTitleInSplit(store.getState().tabs.a!.split, 1)).toBe("Build");
      expect(paneTitleInSplit(store.getState().tabs.b!.split, 2)).toBe("Tests");
    }
    expect(save).toHaveBeenCalledWith(mainStore.getState());
    expect(notice).not.toHaveBeenCalled();
    persistence.dispose();
    aux.dispose();
  });

  it("completes on a matching receipt even if the transport delivery promise hangs", async () => {
    const bus = loopbackBus();
    const store = createLayoutStore(layout());
    const main = mainLayoutSync(createLayoutStore(layout()), bus, vi.fn());
    const aux = auxiliaryLayoutSync(store, { ...bus, forwardMutation: (mutation) => {
      void bus.forwardMutation(mutation);
      return new Promise<void>(() => {});
    } }, vi.fn());
    bus.onMutation(main.receive);
    bus.onLayout(aux.receive);
    store.renameTab("a", "Accepted");
    let completed = false;
    void aux.setLayout(serializeLayout(store.getState())).then(() => { completed = true; });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(completed).toBe(true);
    aux.dispose();
  });

  it("accepts broadcasts from a restarted main workspace", async () => {
    const { bus, main, mainStore, auxStore, aux } = replicas();
    mainStore.renameTab("a", "Before restart");
    await main.broadcast();
    await main.broadcast();
    const restarted = mainLayoutSync(mainStore, bus, vi.fn());
    mainStore.renameTab("a", "After restart");
    await restarted.broadcast();
    expect(auxStore.getState().tabs.a!.title).toBe("After restart");
    aux.dispose();
  });

  it("releases the receipt timer if event delivery fails", async () => {
    vi.useFakeTimers();
    const bus = loopbackBus();
    const store = createLayoutStore(layout());
    const aux = auxiliaryLayoutSync(store, {
      ...bus, forwardMutation: async () => { throw new Error("delivery failed"); },
    }, vi.fn());
    store.renameTab("a", "Local");
    await expect(aux.setLayout(serializeLayout(store.getState()))).rejects.toThrow("delivery failed");
    expect(vi.getTimerCount()).toBe(0);
    aux.dispose();
  });

  it("preserves a debounced active-tab edit across a remote broadcast and saves the rebased state", async () => {
    const { mainStore, auxStore, main, persistence, aux } = replicas();
    auxStore.replaceState({ ...auxStore.getState(), activeTabId: "b" });
    persistence.record(auxStore.getState(), "active_tab");
    mainStore.renameTab("a", "Remote title");
    await main.broadcast();
    expect(auxStore.getState().activeTabId).toBe("b");
    await persistence.flush();
    expect(mainStore.getState().activeTabId).toBe("b");
    expect(mainStore.getState().tabs.a!.title).toBe("Remote title");
    persistence.dispose();
    aux.dispose();
  });

  it("retries an unacknowledged proposal idempotently after a lost receipt", async () => {
    vi.useFakeTimers();
    const bus = loopbackBus();
    const store = createLayoutStore(layout());
    const remote = createLayoutStore(layout());
    const save = vi.fn();
    const main = mainLayoutSync(remote, bus, save);
    const aux = auxiliaryLayoutSync(store, bus, vi.fn());
    bus.onMutation(main.receive);
    store.renameTab("a", "Once");
    const first = aux.setLayout(serializeLayout(store.getState()));
    const failure = expect(first).rejects.toThrow(/acknowledge/);
    await vi.advanceTimersByTimeAsync(LAYOUT_RECEIPT_TIMEOUT_MS);
    await failure;
    bus.onLayout(aux.receive);
    await aux.setLayout(serializeLayout(store.getState()));
    expect(save).toHaveBeenCalledTimes(1);
    expect(store.getState().tabs.a!.title).toBe("Once");
    aux.dispose();
  });

  it("sends newer local changes after retrying a previously timed-out proposal", async () => {
    vi.useFakeTimers();
    const bus = loopbackBus();
    const store = createLayoutStore(layout());
    const remote = createLayoutStore(layout());
    const main = mainLayoutSync(remote, bus, vi.fn());
    const aux = auxiliaryLayoutSync(store, bus, vi.fn());
    bus.onMutation(main.receive);
    store.renameTab("a", "First");
    const first = aux.setLayout(serializeLayout(store.getState()));
    const failure = expect(first).rejects.toThrow(/acknowledge/);
    await vi.advanceTimersByTimeAsync(LAYOUT_RECEIPT_TIMEOUT_MS);
    await failure;
    store.renameTab("a", "Newer while offline");
    bus.onLayout(aux.receive);
    await aux.setLayout(serializeLayout(store.getState()));
    expect(remote.getState().tabs.a!.title).toBe("Newer while offline");
    aux.dispose();
  });

  it("ignores an old broadcast after a newer one", async () => {
    const { bus, main, mainStore, auxStore, aux } = replicas();
    const seen: Array<[ReturnType<typeof serializeLayout>, LayoutSyncMetadata | undefined]> = [];
    bus.onLayout((value, sync) => seen.push([value, sync]));
    mainStore.renameTab("a", "Old");
    await main.broadcast();
    mainStore.renameTab("a", "New");
    await main.broadcast();
    aux.receive(...seen[0]!);
    expect(auxStore.getState().tabs.a!.title).toBe("New");
    aux.dispose();
  });

  it("resynchronizes after a conflicting move and does not replay the rejected queued snapshot", async () => {
    const bus = loopbackBus();
    const deliveries: Array<() => Promise<void>> = [];
    const delayed: WindowBus = { ...bus, broadcastLayout: (...args) => {
      deliveries.push(() => bus.broadcastLayout(...args));
      return Promise.resolve();
    } };
    const mainStore = createLayoutStore(layout());
    const auxStore = createLayoutStore(layout());
    const main = mainLayoutSync(mainStore, delayed, vi.fn());
    const notice = vi.fn();
    const aux = auxiliaryLayoutSync(auxStore, delayed, notice);
    const persistence = new LayoutPersistence(aux);
    bus.onMutation(main.receive);
    bus.onLayout(aux.receive);
    const moved = (windowId: string): Layout => ({ ...layout(), rootItems: [{ kind: "tab", id: "a" }],
      auxWindows: { [windowId]: { rootItems: [{ kind: "tab", id: "b" }], activeTabId: "b", bounds: null } } });
    mainStore.replaceState(moved("main-move"));
    auxStore.replaceState(moved("aux-move"));
    persistence.record(auxStore.getState(), "structural");
    auxStore.renameTab("b", "Queued stale edit");
    persistence.record(auxStore.getState(), "structural");
    while (deliveries.length) await deliveries.shift()!();
    await persistence.flush();
    expect(auxStore.getState()).toEqual(mainStore.getState());
    expect(auxStore.getState().auxWindows["aux-move"]).toBeUndefined();
    expect(notice).toHaveBeenCalled();
    persistence.dispose();
    aux.dispose();
  });
});
