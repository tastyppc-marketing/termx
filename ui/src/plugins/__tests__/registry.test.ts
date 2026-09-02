import { afterEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_MANIFESTS } from "../bundled";
import {
  PluginsStore,
  autostartOf,
  manifestFor,
  parsePluginsFile,
  serializePluginsFile,
  type PluginsV1,
} from "../registry";

afterEach(() => {
  vi.useRealTimers();
});

describe("plugin registry file", () => {
  it.each([
    ["a missing file", null],
    ["invalid JSON", "{oops"],
    ["a non-object root", "[]"],
    ["a missing plugins object", "{}"],
  ])("treats %s as an empty registry", (_label, text) => {
    expect(parsePluginsFile(text)).toEqual({ plugins: {} });
  });

  it("round-trips plugin entries", () => {
    const state: PluginsV1 = {
      plugins: {
        showroom: {
          path: "C:\\Plugins\\Showroom",
          enabled: true,
          grants: ["terminal.open", "notify"],
        },
      },
    };

    expect(parsePluginsFile(serializePluginsFile(state))).toEqual(state);
  });

  it("skips entries whose id is not a valid plugin id", () => {
    const text = JSON.stringify({
      plugins: {
        showroom: { path: "C:\\Plugins\\Showroom", enabled: true, grants: [] },
        Showroom: { path: "C:\\Plugins\\Other", enabled: true, grants: [] },
        "": { path: "C:\\Plugins\\Empty", enabled: true, grants: [] },
        "bad id": { path: "C:\\Plugins\\Bad", enabled: true, grants: [] },
      },
    });

    expect(parsePluginsFile(text)).toEqual({
      plugins: {
        showroom: { path: "C:\\Plugins\\Showroom", enabled: true, grants: [] },
      },
    });
  });

  it("falls back to the bundled Showroom manifest", () => {
    expect(manifestFor("showroom", null)).toBe(BUNDLED_MANIFESTS.showroom);
  });

  it("prefers a plugin-root manifest over the bundled manifest", () => {
    const fileText = JSON.stringify({
      ...BUNDLED_MANIFESTS.showroom,
      name: "Local Showroom",
      panel: { path: "/termx" },
    });

    expect(manifestFor("showroom", fileText)).toMatchObject({
      name: "Local Showroom",
      panel: { path: "/termx" },
    });
  });

  it("has no fallback for an unknown plugin", () => {
    expect(manifestFor("unknown", null)).toBeNull();
  });

  it("does not hide a malformed plugin-root manifest behind the fallback", () => {
    expect(manifestFor("showroom", "{oops")).toBeNull();
  });
});

describe("PluginsStore", () => {
  it("persists the latest enabled state once after the trailing debounce", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const store = new PluginsStore({
      initial: {
        plugins: {
          showroom: {
            path: "C:\\Plugins\\Showroom",
            enabled: true,
            grants: [],
          },
        },
      },
      save: async (text) => {
        writes.push(text);
      },
      debounceMs: 800,
    });

    store.setEnabled("showroom", false);
    store.setEnabled("showroom", true);
    store.setEnabled("showroom", false);

    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(799);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(1);
    expect(parsePluginsFile(writes[0]!)).toEqual({
      plugins: {
        showroom: {
          path: "C:\\Plugins\\Showroom",
          enabled: false,
          grants: [],
        },
      },
    });
  });

  it("flushes the pending debounced save without advancing timers", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const store = new PluginsStore({
      initial: {
        plugins: {
          showroom: {
            path: "C:\\Plugins\\Showroom",
            enabled: true,
            grants: [],
          },
        },
      },
      save: async (text) => {
        writes.push(text);
      },
      debounceMs: 800,
    });

    store.setEnabled("showroom", false);
    await store.flush();

    expect(writes).toHaveLength(1);
    expect(parsePluginsFile(writes[0]!)).toEqual({
      plugins: {
        showroom: {
          path: "C:\\Plugins\\Showroom",
          enabled: false,
          grants: [],
        },
      },
    });

    // The cancelled debounce must not fire a second write later.
    await vi.advanceTimersByTimeAsync(2000);
    expect(writes).toHaveLength(1);
  });

  it("ignores an add with an invalid plugin id", () => {
    const store = new PluginsStore();

    store.add("Showroom", "C:\\Plugins\\Showroom");
    store.add("bad id", "C:\\Plugins\\Bad");
    store.add("", "C:\\Plugins\\Empty");

    expect(store.getSnapshot()).toEqual({ plugins: {} });
  });

  it("adds and removes a plugin round-trip", () => {
    const store = new PluginsStore();

    store.add("showroom", "C:\\Plugins\\Showroom");
    expect(store.getSnapshot()).toEqual({
      plugins: {
        showroom: {
          path: "C:\\Plugins\\Showroom",
          enabled: true,
          grants: [],
        },
      },
    });

    store.remove("showroom");
    expect(store.getSnapshot()).toEqual({ plugins: {} });
  });

  it("notifies subscribers for mutations and stops after unsubscribe", () => {
    const store = new PluginsStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.add("showroom", "C:\\Plugins\\Showroom");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.setEnabled("showroom", false);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

/**
 * "Start with TermX" (menubar spec): a per-plugin flag on the registry entry.
 *
 * Off is the ABSENCE of the key, never `autostart: false`. That is what makes a
 * registry written by an older TermX read as off, and it keeps the file clean -
 * turning the switch back off leaves the entry exactly as it was rather than
 * growing a false on every plugin the user ever considered.
 */
describe("plugin registry autostart", () => {
  function entryText(autostart: unknown): string {
    return JSON.stringify({
      plugins: {
        showroom: {
          path: "C:\\Plugins\\Showroom",
          enabled: true,
          grants: [],
          ...(autostart === undefined ? {} : { autostart }),
        },
      },
    });
  }

  it("reads a marked entry as marked", () => {
    const parsed = parsePluginsFile(entryText(true));

    expect(parsed.plugins.showroom!.autostart).toBe(true);
    expect(autostartOf(parsed.plugins.showroom!)).toBe(true);
  });

  it.each([
    ["an absent flag", undefined],
    ["an explicit false", false],
    ["a string", "yes"],
    ["a number", 1],
    ["a null", null],
  ])("reads %s as off, with no key left behind", (_label, value) => {
    const entry = parsePluginsFile(entryText(value)).plugins.showroom!;

    expect(autostartOf(entry)).toBe(false);
    expect("autostart" in entry).toBe(false);
  });

  it("round-trips a marked entry through the file", () => {
    const once = parsePluginsFile(entryText(true));

    expect(parsePluginsFile(serializePluginsFile(once))).toEqual(once);
  });

  it("leaves a newly added plugin unmarked", () => {
    const store = new PluginsStore();
    store.add("showroom", "C:\\Plugins\\Showroom");

    expect(autostartOf(store.getSnapshot().plugins.showroom!)).toBe(false);
  });
});

describe("PluginsStore.setAutostart", () => {
  function storeWith(save: (text: string) => Promise<void>): PluginsStore {
    return new PluginsStore({
      initial: {
        plugins: {
          showroom: { path: "C:\\Plugins\\Showroom", enabled: true, grants: [] },
        },
      },
      save,
      debounceMs: 800,
    });
  }

  it("persists the flag through the same debounced save chain as Enabled", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const store = storeWith(async (text) => {
      writes.push(text);
    });

    store.setAutostart("showroom", true);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(800);

    expect(writes).toHaveLength(1);
    expect(parsePluginsFile(writes[0]!).plugins.showroom!.autostart).toBe(true);
  });

  it("removes the key rather than writing a false", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const store = new PluginsStore({
      initial: {
        plugins: {
          showroom: {
            path: "C:\\Plugins\\Showroom",
            enabled: true,
            grants: [],
            autostart: true,
          },
        },
      },
      save: async (text) => {
        writes.push(text);
      },
      debounceMs: 800,
    });

    store.setAutostart("showroom", false);
    await store.flush();

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!).plugins.showroom).not.toHaveProperty("autostart");
  });

  it("leaves the rest of the entry alone", () => {
    const store = new PluginsStore({
      initial: {
        plugins: {
          showroom: {
            path: "C:\\Plugins\\Showroom",
            enabled: true,
            grants: ["terminal.open"],
          },
        },
      },
    });

    store.setAutostart("showroom", true);

    expect(store.getSnapshot().plugins.showroom).toEqual({
      path: "C:\\Plugins\\Showroom",
      enabled: true,
      grants: ["terminal.open"],
      autostart: true,
    });
  });

  it("does nothing for an unknown plugin, and nothing for a no-op flip", () => {
    const listener = vi.fn();
    const store = storeWith(async () => undefined);
    store.subscribe(listener);

    store.setAutostart("ghost", true);
    store.setAutostart("showroom", false);

    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot().plugins.ghost).toBeUndefined();
  });

  it("notifies subscribers when the flag really changes", () => {
    const listener = vi.fn();
    const store = storeWith(async () => undefined);
    store.subscribe(listener);

    store.setAutostart("showroom", true);

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
