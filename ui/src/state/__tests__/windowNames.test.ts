/**
 * Per-window display names — the label over the top-left of each OS window.
 *
 * They live in the LAYOUT rather than in settings for two reasons. They are
 * per window, and the layout is the only per-window model there is; and the
 * layout is what crosses the window bus, so an aux window's rename reaches
 * main through the machinery that already exists for renaming a tab.
 *
 * That second reason is what most of this file is really guarding: the bus
 * carries a whole serialized layout which main re-parses before adopting, so a
 * name that does not survive `parseLayout` is a name that vanishes the instant
 * a second window touches anything.
 */

import { describe, expect, it } from "vitest";
import {
  emptyLayout,
  MAX_NAME_LENGTH,
  migrateV2,
  parseLayout,
  serializeLayout,
  windowNameOf,
  type Layout,
  type LayoutV2,
} from "../layout";
import { createLayoutStore } from "../store";
import { baseLayout, tabItem } from "./helpers";

/** `baseLayout` plus one aux window holding nothing. */
function withAux(): Layout {
  return {
    ...baseLayout(),
    rootItems: [tabItem("t1"), tabItem("t2")],
    auxWindows: {
      "aux-0": { rootItems: [{ kind: "group", id: "g1" }], activeTabId: "t3", bounds: null },
    },
  };
}

describe("window names in the layout model", () => {
  it("starts empty, and an unnamed window reads as null rather than a blank", () => {
    const layout = emptyLayout();
    expect(layout.windowNames).toEqual({});
    expect(windowNameOf(layout, "main")).toBeNull();
    expect(windowNameOf(layout, "aux-0")).toBeNull();
  });

  it("migrates a v2 blob to no names at all", () => {
    const v2: LayoutV2 = {
      version: 2,
      groups: {},
      rootItems: [],
      tabs: {},
      activeTabId: null,
    };
    expect(migrateV2(v2).windowNames).toEqual({});
  });

  it(
    "accepts a v3 blob written before window names existed — every layout " +
      "already on disk is one of those, and refusing them would empty the app",
    () => {
      const blob = JSON.parse(JSON.stringify(baseLayout())) as Record<string, unknown>;
      delete blob.windowNames;

      const parsed = parseLayout(blob);

      expect(parsed).not.toBeNull();
      expect(parsed!.windowNames).toEqual({});
      expect(parsed!.tabs.t1).toBeDefined();
    },
  );

  it("round-trips names through serialize and parse, which is the bus path", () => {
    const named: Layout = {
      ...withAux(),
      windowNames: { main: "Client work", "aux-0": "Deploys" },
    };

    const parsed = parseLayout(serializeLayout(named));

    expect(parsed?.windowNames).toEqual({ main: "Client work", "aux-0": "Deploys" });
  });

  it(
    "drops junk names but keeps the workspace — a name is cosmetic and a " +
      "layout is not, so a bad name must never cost the user their tabs",
    () => {
      const blob = JSON.parse(JSON.stringify(baseLayout())) as Record<string, unknown>;
      blob.windowNames = {
        main: "Fine",
        "aux-0": 42,
        "aux-1": "",
        "aux-2": "   ",
        "aux-3": "x".repeat(MAX_NAME_LENGTH + 1),
      };

      const parsed = parseLayout(blob);

      expect(parsed).not.toBeNull();
      expect(parsed!.windowNames).toEqual({ main: "Fine" });
      expect(parsed!.tabs.t1).toBeDefined();
    },
  );

  it("survives a windowNames field that is not an object at all", () => {
    const blob = JSON.parse(JSON.stringify(baseLayout())) as Record<string, unknown>;
    blob.windowNames = "not a map";

    const parsed = parseLayout(blob);

    expect(parsed).not.toBeNull();
    expect(parsed!.windowNames).toEqual({});
  });
});

describe("setWindowName", () => {
  it("names the main window and any aux window alike", () => {
    const store = createLayoutStore(withAux());

    expect(store.setWindowName("main", "Client work").windowNames).toEqual({
      main: "Client work",
    });
    expect(store.setWindowName("aux-0", "Deploys").windowNames).toEqual({
      main: "Client work",
      "aux-0": "Deploys",
    });
  });

  it("trims the name, the way every other name in the store is trimmed", () => {
    const store = createLayoutStore(withAux());

    expect(windowNameOf(store.setWindowName("main", "  Client work  "), "main"))
      .toBe("Client work");
  });

  it("clears back to the default on null, on empty, and on whitespace", () => {
    for (const cleared of [null, "", "   "]) {
      const store = createLayoutStore({
        ...withAux(),
        windowNames: { main: "Client work" },
      });

      const next = store.setWindowName("main", cleared);

      expect(next.windowNames).toEqual({});
      expect(windowNameOf(next, "main")).toBeNull();
    }
  });

  it("refuses a name past the length cap, leaving the state untouched", () => {
    const store = createLayoutStore(withAux());
    const before = store.getState();

    const after = store.setWindowName("main", "x".repeat(MAX_NAME_LENGTH + 1));

    expect(after).toBe(before);
  });

  it("refuses a window that does not exist", () => {
    const store = createLayoutStore(withAux());
    const before = store.getState();

    expect(store.setWindowName("aux-9", "Nowhere")).toBe(before);
  });

  it("is a no-op when the name is already what it would be set to", () => {
    const store = createLayoutStore(withAux());
    const named = store.setWindowName("main", "Client work");

    expect(store.setWindowName("main", "Client work")).toBe(named);
    // And clearing an already-unnamed window changes nothing either.
    expect(store.setWindowName("aux-0", null)).toBe(named);
  });

  it(
    "lets the name go when the window itself goes — a closed aux window must " +
      "not leave its label behind for the next window to inherit that id",
    () => {
      const store = createLayoutStore({
        ...withAux(),
        windowNames: { main: "Client work", "aux-0": "Deploys" },
      });

      const next = store.returnWindowToMain("aux-0");

      expect(next.auxWindows["aux-0"]).toBeUndefined();
      expect(next.windowNames).toEqual({ main: "Client work" });
    },
  );
});
