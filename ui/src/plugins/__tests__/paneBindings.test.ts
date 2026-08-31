/**
 * Plugin pane bindings (plugin spec §4): the out-of-band map from a reserved
 * pane id to the plugin that owns it, held in its OWN file so an old build can
 * neither read it nor delete it on the next ui-state write.
 *
 * The two rules under test are the ones that keep a downgrade recoverable and
 * a multi-window run coherent: the MAIN window is the only writer (an aux
 * store is constructed with `save: null` and must never persist, even when the
 * user binds in that window), and reserved ids stay inside the 2^31 range so
 * `validateSplit`'s u32 + uniqueness invariants still hold.
 */

import { describe, expect, it, vi } from "vitest";
import {
  allocatePluginPaneId,
  isPluginPaneId,
  PaneBindingsStore,
  parsePluginPanes,
  PLUGIN_PANE_MIN_ID,
  serializePluginPanes,
  type PluginPanesV1,
} from "../paneBindings";

describe("parsePluginPanes", () => {
  it("round-trips bindings keyed by session id string", () => {
    const state: PluginPanesV1 = {
      "2147483648": { pluginId: "showroom" },
      "2147483649": { pluginId: "showroom", path: "/gallery" },
    };

    expect(parsePluginPanes(serializePluginPanes(state))).toEqual(state);
  });

  it("degrades to empty state for a missing or corrupt file", () => {
    expect(parsePluginPanes(null)).toEqual({});
    expect(parsePluginPanes("")).toEqual({});
    expect(parsePluginPanes("{ not json")).toEqual({});
    expect(parsePluginPanes("[1,2,3]")).toEqual({});
    expect(parsePluginPanes("null")).toEqual({});
  });

  it("drops junk entries and keeps the good ones", () => {
    const parsed = parsePluginPanes(
      JSON.stringify({
        version: 1,
        panes: {
          "2147483648": { pluginId: "showroom", path: "/" },
          "2147483649": { pluginId: "" },
          "2147483650": { path: "/orphan" },
          "2147483651": "showroom",
          "not-an-id": { pluginId: "showroom" },
          "2147483652": { pluginId: "showroom", path: 7 },
        },
      }),
    );

    expect(parsed).toEqual({
      "2147483648": { pluginId: "showroom", path: "/" },
      "2147483652": { pluginId: "showroom" },
    });
  });

  it("reads a hand-written bare record (the spec's literal file shape)", () => {
    expect(
      parsePluginPanes(JSON.stringify({ "2147483648": { pluginId: "showroom" } })),
    ).toEqual({ "2147483648": { pluginId: "showroom" } });
  });
});

describe("plugin pane ids", () => {
  it("recognises only reserved u32 ids", () => {
    expect(PLUGIN_PANE_MIN_ID).toBe(0x8000_0000);
    expect(isPluginPaneId(PLUGIN_PANE_MIN_ID)).toBe(true);
    expect(isPluginPaneId(0xffff_ffff)).toBe(true);
    expect(isPluginPaneId(PLUGIN_PANE_MIN_ID - 1)).toBe(false);
    expect(isPluginPaneId(7)).toBe(false);
    expect(isPluginPaneId(0x1_0000_0000)).toBe(false);
    expect(isPluginPaneId(Number.NaN)).toBe(false);
    expect(isPluginPaneId(PLUGIN_PANE_MIN_ID + 0.5)).toBe(false);
  });

  it("allocates in range and re-rolls onto a free id", () => {
    const taken = new Set([PLUGIN_PANE_MIN_ID]);
    const random = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0.5);

    const id = allocatePluginPaneId(taken, random);

    expect(random).toHaveBeenCalledTimes(2);
    expect(id).toBe(PLUGIN_PANE_MIN_ID + 0x4000_0000);
    expect(isPluginPaneId(id)).toBe(true);
  });

  it("never leaves the u32 range, even for a degenerate random source", () => {
    expect(allocatePluginPaneId(new Set(), () => 1)).toBe(0xffff_ffff);
    expect(allocatePluginPaneId(new Set(), () => -1)).toBe(PLUGIN_PANE_MIN_ID);
  });

  it("throws only after 64 collisions", () => {
    const random = vi.fn(() => 0);

    expect(() => allocatePluginPaneId(new Set([PLUGIN_PANE_MIN_ID]), random))
      .toThrow(/pane id/i);
    expect(random).toHaveBeenCalledTimes(64);
  });
});

describe("PaneBindingsStore (main window)", () => {
  function mainStore(initial: PluginPanesV1 = {}) {
    const saves: string[] = [];
    const broadcasts: PluginPanesV1[] = [];
    const store = new PaneBindingsStore({
      initial,
      save: async (text) => {
        saves.push(text);
      },
      onBroadcast: (state) => broadcasts.push(state),
    });
    return { store, saves, broadcasts };
  }

  it("binds, persisting exactly once with string keys, and broadcasts", async () => {
    const { store, saves, broadcasts } = mainStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom" });
    await store.flush();

    expect(store.getSnapshot()).toEqual({ "2147483648": { pluginId: "showroom" } });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(saves).toHaveLength(1);
    expect(parsePluginPanes(saves[0]!)).toEqual(store.getSnapshot());
    expect(broadcasts).toEqual([{ "2147483648": { pluginId: "showroom" } }]);
  });

  it("ignores a re-bind of the same binding", async () => {
    const { store, saves, broadcasts } = mainStore();
    store.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom", path: "/" });
    const before = store.getSnapshot();

    store.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom", path: "/" });
    await store.flush();

    expect(store.getSnapshot()).toBe(before);
    expect(saves).toHaveLength(1);
    expect(broadcasts).toHaveLength(1);
  });

  it("unbinds the closed ids and leaves the rest alone", async () => {
    const { store, saves } = mainStore({
      "2147483648": { pluginId: "showroom" },
      "2147483649": { pluginId: "showroom" },
    });

    store.unbind([PLUGIN_PANE_MIN_ID, 12]);
    await store.flush();

    expect(store.getSnapshot()).toEqual({ "2147483649": { pluginId: "showroom" } });
    expect(saves).toHaveLength(1);
  });

  it("does not write when unbind matches nothing", async () => {
    const { store, saves, broadcasts } = mainStore({
      "2147483648": { pluginId: "showroom" },
    });
    const before = store.getSnapshot();

    store.unbind([12, 13]);
    store.unbind([]);
    await store.flush();

    expect(store.getSnapshot()).toBe(before);
    expect(saves).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it("survives a save that rejects", async () => {
    const store = new PaneBindingsStore({
      initial: {},
      save: async () => {
        throw new Error("disk full");
      },
    });

    store.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom" });

    await expect(store.flush()).resolves.toBeUndefined();
    expect(store.getSnapshot()).toEqual({ "2147483648": { pluginId: "showroom" } });
  });
});

describe("PaneBindingsStore (aux window)", () => {
  it("never persists, even when something binds in this window", async () => {
    const save = vi.fn(async () => undefined);
    const store = new PaneBindingsStore({ initial: {}, save: null });
    const auxWithSave = new PaneBindingsStore({ initial: {}, save });

    store.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom" });
    store.unbind([PLUGIN_PANE_MIN_ID]);
    await store.flush();

    expect(store.getSnapshot()).toEqual({});
    // Sanity: the same calls DO write when a save is wired (main window).
    auxWithSave.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom" });
    await auxWithSave.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("adopts bus state without persisting or echoing it back", async () => {
    const save = vi.fn(async () => undefined);
    const onBroadcast = vi.fn();
    const store = new PaneBindingsStore({ initial: {}, save: null, onBroadcast });
    const listener = vi.fn();
    store.subscribe(listener);

    store.adopt({ "2147483648": { pluginId: "showroom", path: "/" } });
    await store.flush();

    expect(store.getSnapshot()).toEqual({
      "2147483648": { pluginId: "showroom", path: "/" },
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(onBroadcast).not.toHaveBeenCalled();
  });

  it("keeps the same snapshot reference when an adopted state changes nothing", () => {
    const store = new PaneBindingsStore({
      initial: { "2147483648": { pluginId: "showroom" } },
      save: null,
    });
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();

    store.adopt({ "2147483648": { pluginId: "showroom" } });

    expect(store.getSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying an unsubscribed listener and survives a throwing one", () => {
    const store = new PaneBindingsStore({ initial: {}, save: null });
    const seen: number[] = [];
    store.subscribe(() => {
      throw new Error("bad subscriber");
    });
    const stop = store.subscribe(() => seen.push(1));

    store.adopt({ "2147483648": { pluginId: "showroom" } });
    stop();
    store.adopt({});

    expect(seen).toEqual([1]);
  });
});
