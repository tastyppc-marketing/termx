import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_UI_STATE, type UiStateV1 } from "../../workspace/uiState";
import {
  allActions,
  DEFAULT_TRAYS,
  getAction,
  registerAction,
  trayChipIds,
  type ActionChip,
  type TrayId,
} from "../registry";

function chip(id: string, overrides: Partial<ActionChip> = {}): ActionChip {
  return {
    id,
    icon: "◆",
    label: `Action ${id}`,
    run: vi.fn(),
    ...overrides,
  };
}

function stateWith(trayChips: UiStateV1["trayChips"]): UiStateV1 {
  return { ...DEFAULT_UI_STATE, ...(trayChips ? { trayChips } : {}) };
}

// The registry is module-level; these two ids are the whole population for
// this file, and re-registering them is how the "last wins" rule is exercised.
beforeEach(() => {
  registerAction(chip("one"));
  registerAction(chip("two"));
});

describe("action registry", () => {
  it("registers chips and looks them up by id", () => {
    expect(getAction("one")?.label).toBe("Action one");
    expect(getAction("nope")).toBeUndefined();
  });

  it("is idempotent by id — re-registering replaces, never duplicates", () => {
    const before = allActions().length;
    const run = vi.fn();
    registerAction(chip("one", { label: "Renamed", icon: "★", run }));

    expect(allActions()).toHaveLength(before);
    expect(getAction("one")?.label).toBe("Renamed");
    expect(getAction("one")?.icon).toBe("★");
    getAction("one")?.run({});
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("allActions lists every chip once, in registration order", () => {
    expect(allActions().map((entry) => entry.id)).toEqual(["one", "two"]);
  });

  it("ships the adopted default trays", () => {
    expect(Object.keys(DEFAULT_TRAYS).sort()).toEqual([
      "pane-toolbar",
      "sidebar-footer",
      "viewer-header",
    ]);
    // The sidebar footer mirrors its pre-tray chrome; the others start empty.
    expect(DEFAULT_TRAYS["sidebar-footer"]).toEqual([
      "folder-search",
      "settings",
      "features",
    ]);
    expect(DEFAULT_TRAYS["pane-toolbar"]).toEqual([]);
    expect(DEFAULT_TRAYS["viewer-header"]).toEqual([]);
  });

  it("trayChipIds falls back to DEFAULT_TRAYS when the tray is unconfigured", () => {
    const state = stateWith({ "pane-toolbar": ["two"] });
    expect(trayChipIds(state, "pane-toolbar")).toEqual(["two"]);
    expect(trayChipIds(state, "sidebar-footer")).toEqual([]);
    expect(trayChipIds(DEFAULT_UI_STATE, "viewer-header")).toEqual([]);
  });

  it("trayChipIds reads the default layout (and filters it too)", () => {
    const defaults = DEFAULT_TRAYS as Record<TrayId, readonly string[]>;
    const original = defaults["sidebar-footer"];
    defaults["sidebar-footer"] = ["one", "ghost"];
    try {
      expect(trayChipIds(DEFAULT_UI_STATE, "sidebar-footer")).toEqual(["one"]);
    } finally {
      defaults["sidebar-footer"] = original;
    }
  });

  it("trayChipIds drops unknown ids and duplicates from a stale config", () => {
    const state = stateWith({ "sidebar-footer": ["ghost", "two", "one", "two"] });
    expect(trayChipIds(state, "sidebar-footer")).toEqual(["two", "one"]);
  });

  it("trayChipIds tolerates a non-array tray entry", () => {
    const state = {
      ...DEFAULT_UI_STATE,
      trayChips: { "sidebar-footer": "one" as unknown as string[] },
    } satisfies UiStateV1;
    expect(trayChipIds(state, "sidebar-footer")).toEqual([]);
  });
});
