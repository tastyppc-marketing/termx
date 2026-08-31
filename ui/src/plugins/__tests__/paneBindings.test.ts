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
  toJsonPluginPanes,
  type PluginPanesRequest,
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

  it("drops keys that are not the canonical spelling of a reserved id", () => {
    // "7" is a REAL daemon session — a binding there would dress a live
    // terminal up as a panel. The rest can never equal `String(sessionId)`.
    expect(
      parsePluginPanes(
        JSON.stringify({
          version: 1,
          panes: {
            "7": { pluginId: "showroom" },
            "0": { pluginId: "showroom" },
            "-2147483648": { pluginId: "showroom" },
            "1e9": { pluginId: "showroom" },
            "2147483648.0": { pluginId: "showroom" },
            " 2147483648": { pluginId: "showroom" },
            "4294967296": { pluginId: "showroom" },
            "": { pluginId: "showroom" },
          },
        }),
      ),
    ).toEqual({});
  });

  it("reads a hand-written bare record (the spec's literal file shape)", () => {
    expect(
      parsePluginPanes(JSON.stringify({ "2147483648": { pluginId: "showroom" } })),
    ).toEqual({ "2147483648": { pluginId: "showroom" } });
  });
});

describe("toJsonPluginPanes", () => {
  it("deep-copies and never carries an undefined field across the bus", () => {
    const state: PluginPanesV1 = {
      "2147483648": { pluginId: "showroom" },
      "2147483649": { pluginId: "showroom", path: "/gallery" },
    };

    const json = toJsonPluginPanes(state);

    expect(json).toEqual(state);
    expect(json["2147483648"]).not.toBe(state["2147483648"]);
    // `{ pluginId, path: undefined }` would survive a spread but not JSON.
    expect(Object.keys(json["2147483648"]!)).toEqual(["pluginId"]);
    expect(JSON.parse(JSON.stringify(json))).toEqual(state);
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

  it("spells an empty path the same way the parsers do", async () => {
    // Three normalizations of one binding used to exist: bind kept `path: ""`,
    // both parsers dropped it. The stored map then disagreed with its own
    // reload AND with the same call made from an aux window.
    const { store, saves, broadcasts } = mainStore();

    store.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom", path: "" });
    store.bind(PLUGIN_PANE_MIN_ID + 1, { pluginId: "showroom", path: "   " });
    await store.flush();

    const expected = {
      "2147483648": { pluginId: "showroom" },
      "2147483649": { pluginId: "showroom" },
    };
    expect(store.getSnapshot()).toEqual(expected);
    // Survives its own round trip unchanged: no spurious rebind on next boot.
    expect(parsePluginPanes(saves.at(-1)!)).toEqual(expected);

    // And re-binding with the same empty path is now a genuine no-op.
    store.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom", path: "" });
    await store.flush();
    expect(saves).toHaveLength(2);
    expect(broadcasts).toHaveLength(2);
  });

  it("refuses to bind an id outside the reserved range", async () => {
    const { store, saves, broadcasts } = mainStore();

    store.bind(7, { pluginId: "showroom" });
    store.bind(PLUGIN_PANE_MIN_ID - 1, { pluginId: "showroom" });
    await store.flush();

    // 7 is a real daemon session; binding it would dress a live terminal up
    // as a plugin panel.
    expect(store.getSnapshot()).toEqual({});
    expect(saves).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it("prunes bindings whose pane is gone from the layout", async () => {
    const { store, saves, broadcasts } = mainStore({
      "2147483648": { pluginId: "showroom" },
      "2147483649": { pluginId: "showroom" },
    });

    store.prune(new Set([PLUGIN_PANE_MIN_ID, 1, 2]));
    await store.flush();

    expect(store.getSnapshot()).toEqual({ "2147483648": { pluginId: "showroom" } });
    expect(saves).toHaveLength(1);
    expect(broadcasts).toHaveLength(1);
  });

  it("does not write when every binding survives the prune", async () => {
    const { store, saves } = mainStore({ "2147483648": { pluginId: "showroom" } });
    const before = store.getSnapshot();

    store.prune(new Set([PLUGIN_PANE_MIN_ID]));
    await store.flush();

    expect(store.getSnapshot()).toBe(before);
    expect(saves).toEqual([]);
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
  /// The real aux shape: no save, and a forward seam to the main window.
  function replica(initial: PluginPanesV1 = {}) {
    const forwarded: PluginPanesRequest[] = [];
    const store = new PaneBindingsStore({
      initial,
      save: null,
      onForward: (request) => {
        forwarded.push(request);
      },
    });
    return { store, forwarded };
  }

  /// Same shape, but delivery is a real promise resolved on command — the
  /// production case, where the forward is an IPC emit.
  function asyncReplica() {
    const forwarded: PluginPanesRequest[] = [];
    let deliver: (() => void) | undefined;
    const store = new PaneBindingsStore({
      initial: {},
      save: null,
      onForward: (request) =>
        new Promise<void>((resolve) => {
          deliver = () => {
            forwarded.push(request);
            resolve();
          };
        }),
    });
    return { store, forwarded, deliver: () => deliver?.() };
  }

  it("flush() does not resolve until the forward has been delivered", async () => {
    // The aux close path awaits flush() before destroying the webview, and T5
    // awaits it before persisting a layout that references a fresh binding.
    // If flush() only covered disk writes it would be a no-op here, and both
    // of those guarantees would be fiction.
    const { store, forwarded, deliver } = asyncReplica();

    store.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom" });
    let flushed = false;
    const pending = store.flush().then(() => {
      flushed = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(flushed).toBe(false);
    expect(forwarded).toEqual([]);

    deliver();
    await pending;
    expect(flushed).toBe(true);
    expect(forwarded).toHaveLength(1);
  });

  it("survives a forward that rejects", async () => {
    const store = new PaneBindingsStore({
      initial: {},
      save: null,
      onForward: async () => {
        throw new Error("the main window is gone");
      },
    });

    store.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom" });

    await expect(store.flush()).resolves.toBeUndefined();
  });

  it("is read-only when it has no channel to main", async () => {
    // Neither persists nor forwards: applying locally would invent a binding
    // that exists in no file and no other window.
    const store = new PaneBindingsStore({ initial: {}, save: null });
    const listener = vi.fn();
    store.subscribe(listener);

    store.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom" });
    store.unbind([PLUGIN_PANE_MIN_ID]);
    await store.flush();

    expect(store.getSnapshot()).toEqual({});
    expect(listener).not.toHaveBeenCalled();
  });

  it("forwards a bind to main instead of applying it locally", async () => {
    const { store, forwarded } = replica();
    const listener = vi.fn();
    store.subscribe(listener);

    store.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom", path: "/" });
    await store.flush();

    // Nothing lands locally: main's broadcast is what makes it real, so a
    // local edit would show a binding that then snapped back.
    expect(store.getSnapshot()).toEqual({});
    expect(listener).not.toHaveBeenCalled();
    expect(forwarded).toEqual([
      {
        op: "bind",
        sessionId: PLUGIN_PANE_MIN_ID,
        binding: { pluginId: "showroom", path: "/" },
      },
    ]);
  });

  it("forwards a bind even when its own map already says the same thing", async () => {
    // A replica's map can be AHEAD of main's — a broadcast whose emit failed
    // is swallowed by design — and a same-binding short-circuit here would
    // make that state permanent: re-binding the same plugin would send
    // nothing. Main de-dupes on arrival, so a redundant forward costs nothing.
    const { store, forwarded } = replica({
      "2147483648": { pluginId: "showroom", path: "/" },
    });

    store.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom", path: "/" });
    await store.flush();

    expect(forwarded).toEqual([
      {
        op: "bind",
        sessionId: PLUGIN_PANE_MIN_ID,
        binding: { pluginId: "showroom", path: "/" },
      },
    ]);
  });

  it("forwards an unbind unfiltered and drops an empty one", async () => {
    const { store, forwarded } = replica({
      "2147483648": { pluginId: "showroom" },
    });

    store.unbind([PLUGIN_PANE_MIN_ID, 12]);
    store.unbind([]);
    await store.flush();

    // The id it cannot see (12) still travels: only main knows the whole map.
    expect(forwarded).toEqual([
      { op: "unbind", sessionIds: [PLUGIN_PANE_MIN_ID, 12] },
    ]);
    expect(store.getSnapshot()).toEqual({ "2147483648": { pluginId: "showroom" } });
  });

  it("ignores a prune — main prunes and broadcasts the result", () => {
    const { store, forwarded } = replica({
      "2147483648": { pluginId: "showroom" },
    });

    store.prune(new Set());

    expect(store.getSnapshot()).toEqual({ "2147483648": { pluginId: "showroom" } });
    expect(forwarded).toEqual([]);
  });

  it("cannot write the bindings file: a replica has no save at all", async () => {
    const save = vi.fn(async () => undefined);
    const { store } = replica();
    const mainSanity = new PaneBindingsStore({ initial: {}, save });

    store.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom" });
    await store.flush();

    expect(save).not.toHaveBeenCalled();
    // Sanity: the same call DOES write on the main-window shape.
    mainSanity.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom" });
    await mainSanity.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("adopts bus state without echoing anything back to main", async () => {
    // A replica cannot even be CONSTRUCTED with an onBroadcast (the options
    // union forbids it), so the only echo it could produce is a forward.
    const { store, forwarded } = replica();
    const listener = vi.fn();
    store.subscribe(listener);

    store.adopt({ "2147483648": { pluginId: "showroom", path: "/" } });
    await store.flush();

    expect(store.getSnapshot()).toEqual({
      "2147483648": { pluginId: "showroom", path: "/" },
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(forwarded).toEqual([]);
  });

  it("copies what it adopts, so the sender cannot mutate it afterwards", () => {
    // `loopbackBus` hands the payload over by reference; without the copy the
    // two windows would share binding objects.
    const store = new PaneBindingsStore({ initial: {}, save: null });
    const sent: PluginPanesV1 = { "2147483648": { pluginId: "showroom" } };

    store.adopt(sent);
    sent["2147483648"]!.pluginId = "impostor";
    sent["2147483649"] = { pluginId: "late" };

    expect(store.getSnapshot()).toEqual({
      "2147483648": { pluginId: "showroom" },
    });
    expect(store.getSnapshot()["2147483648"]).not.toBe(sent["2147483648"]);
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
