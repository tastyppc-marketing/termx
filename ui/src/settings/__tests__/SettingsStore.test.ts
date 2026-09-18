import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, serializeSettings } from "../settings";
import { SettingsStore, loadSettingsStore } from "../SettingsStore";

describe("SettingsStore.wasCreated", () => {
  it("defaults to false and is set from the option", () => {
    expect(new SettingsStore().wasCreated).toBe(false);
    expect(new SettingsStore({ wasCreated: true }).wasCreated).toBe(true);
  });

  it("loadSettingsStore marks a store created from a missing file", async () => {
    const fresh = await loadSettingsStore({ read: () => Promise.resolve(null) });
    expect(fresh.wasCreated).toBe(true);
    const existing = await loadSettingsStore({
      read: () => Promise.resolve(serializeSettings(DEFAULT_SETTINGS)),
    });
    expect(existing.wasCreated).toBe(false);
    const failed = await loadSettingsStore({ read: () => Promise.reject(new Error("boom")) });
    expect(failed.wasCreated).toBe(true);
  });
});

describe("SettingsStore.touch", () => {
  it("saves the current settings once even though nothing changed", async () => {
    const save = vi.fn(() => Promise.resolve());
    const store = new SettingsStore({ save });
    const listener = vi.fn();
    store.subscribe(listener);
    store.touch();
    await store.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(serializeSettings(DEFAULT_SETTINGS));
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(DEFAULT_SETTINGS);
  });

  it("is a no-op without a save function and contains a failing save", async () => {
    expect(() => new SettingsStore().touch()).not.toThrow();
    const onSaveError = vi.fn();
    const store = new SettingsStore({
      save: () => Promise.reject(new Error("disk")),
      onSaveError,
    });
    store.touch();
    await store.flush();
    expect(onSaveError).toHaveBeenCalledOnce();
  });
});
