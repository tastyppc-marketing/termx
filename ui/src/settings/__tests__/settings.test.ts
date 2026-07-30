import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  parseSettings,
  serializeSettings,
} from "../settings";
import { SettingsStore, loadSettingsStore } from "../SettingsStore";

describe("parseSettings", () => {
  it("returns defaults for a missing file", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("returns defaults for malformed JSON without throwing", () => {
    expect(parseSettings("{not json")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("42")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("null")).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips a full settings object", () => {
    const settings = {
      newTabPolicy: "ask-searcher",
      shellIntegration: false,
      defaultProfile: "cmd",
    } as const;
    expect(parseSettings(serializeSettings(settings))).toEqual(settings);
  });

  it("recovers per-field: bad fields default, good fields survive", () => {
    const parsed = parseSettings(
      JSON.stringify({
        newTabPolicy: "chaos-mode",
        shellIntegration: "yes",
        defaultProfile: "cmd",
      }),
    );
    expect(parsed).toEqual({
      newTabPolicy: DEFAULT_SETTINGS.newTabPolicy,
      shellIntegration: DEFAULT_SETTINGS.shellIntegration,
      defaultProfile: "cmd",
    });
  });

  it("ignores unknown fields", () => {
    const parsed = parseSettings(
      JSON.stringify({ futureFeature: true, defaultProfile: "cmd" }),
    );
    expect(parsed.defaultProfile).toBe("cmd");
  });
});

describe("SettingsStore", () => {
  it("applies updates synchronously and notifies subscribers", () => {
    const store = new SettingsStore();
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().newTabPolicy));

    store.update({ newTabPolicy: "ask-native" });

    expect(store.getSnapshot().newTabPolicy).toBe("ask-native");
    expect(seen).toEqual(["ask-native"]);
  });

  it("does not notify or save when a patch changes nothing", async () => {
    const save = vi.fn(() => Promise.resolve());
    const store = new SettingsStore({ save });
    const listener = vi.fn();
    store.subscribe(listener);

    store.update({ shellIntegration: DEFAULT_SETTINGS.shellIntegration });
    await store.flush();

    expect(listener).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("serializes saves in update order", async () => {
    const saved: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new SettingsStore({
      save: async (text) => {
        if (saved.length === 0) {
          await gate;
        }
        saved.push(text);
      },
    });

    store.update({ defaultProfile: "cmd" });
    store.update({ shellIntegration: false });
    release();
    await store.flush();

    expect(saved).toHaveLength(2);
    expect(JSON.parse(saved[0]!).defaultProfile).toBe("cmd");
    expect(JSON.parse(saved[1]!).shellIntegration).toBe(false);
  });

  it("keeps working in memory when a save fails", async () => {
    const errors: unknown[] = [];
    const store = new SettingsStore({
      save: () => Promise.reject(new Error("disk full")),
      onSaveError: (error) => errors.push(error),
    });

    store.update({ defaultProfile: "cmd" });
    await store.flush();
    store.update({ shellIntegration: false });
    await store.flush();

    expect(store.getSnapshot()).toMatchObject({
      defaultProfile: "cmd",
      shellIntegration: false,
    });
    expect(errors).toHaveLength(2);
  });
});

describe("loadSettingsStore", () => {
  it("loads persisted settings", async () => {
    const store = await loadSettingsStore({
      read: () =>
        Promise.resolve(JSON.stringify({ newTabPolicy: "first-terminal" })),
    });
    expect(store.getSnapshot().newTabPolicy).toBe("first-terminal");
  });

  it("falls back to defaults when the read itself fails", async () => {
    const store = await loadSettingsStore({
      read: () => Promise.reject(new Error("ipc down")),
    });
    expect(store.getSnapshot()).toEqual(DEFAULT_SETTINGS);
  });

  it("does not write during load (malformed file preserved until user edit)", async () => {
    const save = vi.fn(() => Promise.resolve());
    const store = await loadSettingsStore({
      read: () => Promise.resolve("{broken"),
      save,
    });
    await store.flush();
    expect(save).not.toHaveBeenCalled();

    store.update({ defaultProfile: "cmd" });
    await store.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
