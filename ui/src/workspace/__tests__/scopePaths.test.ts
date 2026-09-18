import { describe, expect, it } from "vitest";
import {
  EMPTY_SCOPE_PATHS,
  dropScope,
  newTabCwdCandidates,
  reportScopeCwd,
  scopeKeyFor,
  seedScope,
} from "../scopePaths";
import {
  DEFAULT_UI_STATE,
  RECENT_FOLDERS_CAP,
  UiStateStore,
  loadUiStateStore,
  parseUiState,
  serializeUiState,
  touchRecentFolder,
  updateScopePaths,
} from "../uiState";

describe("scopePaths", () => {
  it("maps null group to the ungrouped scope key", () => {
    expect(scopeKeyFor(null)).toBe("");
    expect(scopeKeyFor("g1")).toBe("g1");
  });

  it("seeds once: later seeds never move the first", () => {
    const seeded = seedScope(EMPTY_SCOPE_PATHS, "g1", "C:\\Dev");
    const again = seedScope(seeded, "g1", "C:\\Other");
    expect(again.seeds["g1"]).toBe("C:\\Dev");
    expect(again).toBe(seeded);
  });

  it("ignores empty seeds and returns the same reference", () => {
    expect(seedScope(EMPTY_SCOPE_PATHS, "g1", null)).toBe(EMPTY_SCOPE_PATHS);
    expect(seedScope(EMPTY_SCOPE_PATHS, "g1", "")).toBe(EMPTY_SCOPE_PATHS);
  });

  it("live CDs move the active path, most recent wins, and seed seedless scopes", () => {
    let state = reportScopeCwd(EMPTY_SCOPE_PATHS, "g1", "C:\\A");
    state = reportScopeCwd(state, "g1", "C:\\B");
    expect(state.active["g1"]).toBe("C:\\B");
    expect(state.seeds["g1"]).toBe("C:\\A");
  });

  it("repeated identical CD reports are reference no-ops", () => {
    const state = reportScopeCwd(EMPTY_SCOPE_PATHS, "g1", "C:\\A");
    expect(reportScopeCwd(state, "g1", "C:\\A")).toBe(state);
  });

  it("dropScope forgets both entries", () => {
    const state = reportScopeCwd(EMPTY_SCOPE_PATHS, "g1", "C:\\A");
    const dropped = dropScope(state, "g1");
    expect(dropped.seeds["g1"]).toBeUndefined();
    expect(dropped.active["g1"]).toBeUndefined();
    expect(dropScope(dropped, "g1")).toBe(dropped);
  });

  it("group-active candidates: active, then seed, then null", () => {
    let state = seedScope(EMPTY_SCOPE_PATHS, "g1", "C:\\Seed");
    state = reportScopeCwd(state, "g1", "C:\\Active");
    expect(newTabCwdCandidates(state, "g1", "group-active", null, null)).toEqual([
      "C:\\Active",
      "C:\\Seed",
      null,
    ]);
  });

  it("active-tab candidates lead with the focused tab's cwd", () => {
    const state = reportScopeCwd(EMPTY_SCOPE_PATHS, "g1", "C:\\Active");
    expect(newTabCwdCandidates(state, "g1", "active-tab", "C:\\Focused", null)).toEqual([
      "C:\\Focused",
      "C:\\Active",
      null,
    ]);
  });

  it("first-terminal candidates ignore the active path", () => {
    let state = seedScope(EMPTY_SCOPE_PATHS, "g1", "C:\\Seed");
    state = reportScopeCwd(state, "g1", "C:\\Active");
    expect(newTabCwdCandidates(state, "g1", "first-terminal", null, null)).toEqual([
      "C:\\Seed",
      null,
    ]);
  });

  it("deduplicates case-insensitively and always ends with null", () => {
    let state = seedScope(EMPTY_SCOPE_PATHS, "g1", "c:\\dev");
    state = reportScopeCwd(state, "g1", "C:\\DEV");
    expect(newTabCwdCandidates(state, "g1", "group-active", null, null)).toEqual([
      "C:\\DEV",
      null,
    ]);
    expect(newTabCwdCandidates(EMPTY_SCOPE_PATHS, "gX", "group-active", null, null)).toEqual([
      null,
    ]);
  });

  it("every policy falls back on the workspace root before the host default", () => {
    const state = reportScopeCwd(EMPTY_SCOPE_PATHS, "g1", "C:\\Active");
    expect(
      newTabCwdCandidates(state, "g1", "group-active", null, "C:\\Root"),
    ).toEqual(["C:\\Active", "C:\\Root", null]);
    expect(
      newTabCwdCandidates(EMPTY_SCOPE_PATHS, "g1", "first-terminal", null, "C:\\Root"),
    ).toEqual(["C:\\Root", null]);
    expect(
      newTabCwdCandidates(EMPTY_SCOPE_PATHS, "g1", "active-tab", null, "C:\\Root"),
    ).toEqual(["C:\\Root", null]);
  });

  it("dedupes the root against an equal active path", () => {
    const state = reportScopeCwd(EMPTY_SCOPE_PATHS, "g1", "c:\\root");
    expect(
      newTabCwdCandidates(state, "g1", "group-active", null, "C:\\ROOT"),
    ).toEqual(["c:\\root", null]);
  });
});

describe("uiState", () => {
  it("parses missing and malformed files to empty state", () => {
    expect(parseUiState(null)).toEqual(DEFAULT_UI_STATE);
    expect(parseUiState("{oops")).toEqual(DEFAULT_UI_STATE);
    expect(parseUiState("[]")).toEqual(DEFAULT_UI_STATE);
  });

  it("round-trips state and drops junk entries on parse", () => {
    const state = touchRecentFolder(
      updateScopePaths(DEFAULT_UI_STATE, (paths) =>
        reportScopeCwd(paths, "g1", "C:\\Dev"),
      ),
      "C:\\Dev",
    );
    expect(parseUiState(serializeUiState(state))).toEqual(state);

    const parsed = parseUiState(
      JSON.stringify({
        scopePaths: { seeds: { g1: 42, g2: "C:\\Ok" }, active: null },
        recentFolders: ["C:\\Keep", "", 7],
      }),
    );
    expect(parsed.scopePaths.seeds).toEqual({ g2: "C:\\Ok" });
    expect(parsed.scopePaths.active).toEqual({});
    expect(parsed.recentFolders).toEqual(["C:\\Keep"]);
  });

  it("touchRecentFolder dedupes case-insensitively, caps, and no-ops at head", () => {
    let state = touchRecentFolder(DEFAULT_UI_STATE, "C:\\A");
    state = touchRecentFolder(state, "C:\\B");
    state = touchRecentFolder(state, "c:\\a");
    expect(state.recentFolders).toEqual(["c:\\a", "C:\\B"]);
    expect(touchRecentFolder(state, "C:\\A")).toBe(state);

    let full = DEFAULT_UI_STATE;
    for (let index = 0; index < RECENT_FOLDERS_CAP + 5; index += 1) {
      full = touchRecentFolder(full, `C:\\dir${index}`);
    }
    expect(full.recentFolders).toHaveLength(RECENT_FOLDERS_CAP);
    expect(full.recentFolders[0]).toBe(`C:\\dir${RECENT_FOLDERS_CAP + 4}`);
  });

  it("debounces saves and coalesces a burst into one write", async () => {
    const writes: string[] = [];
    const store = new UiStateStore({
      save: async (text) => {
        writes.push(text);
      },
      debounceMs: 5,
    });
    store.update((state) => touchRecentFolder(state, "C:\\A"));
    store.update((state) => touchRecentFolder(state, "C:\\B"));
    expect(writes).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!).recentFolders).toEqual(["C:\\B", "C:\\A"]);
  });

  it("flush forces a pending save immediately", async () => {
    const writes: string[] = [];
    const store = new UiStateStore({
      save: async (text) => {
        writes.push(text);
      },
      debounceMs: 60_000,
    });
    store.update((state) => touchRecentFolder(state, "C:\\A"));
    await store.flush();
    expect(writes).toHaveLength(1);
  });

  it("no-op updates never notify or schedule a save", async () => {
    const writes: string[] = [];
    const store = new UiStateStore({
      save: async (text) => {
        writes.push(text);
      },
      debounceMs: 0,
    });
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.update((state) => state);
    await store.flush();
    expect(notified).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it("save failures stay contained and later saves still run", async () => {
    const errors: unknown[] = [];
    let failNext = true;
    const writes: string[] = [];
    const store = new UiStateStore({
      save: async (text) => {
        if (failNext) {
          failNext = false;
          throw new Error("disk full");
        }
        writes.push(text);
      },
      onSaveError: (error) => errors.push(error),
      debounceMs: 0,
    });
    store.update((state) => touchRecentFolder(state, "C:\\A"));
    await store.flush();
    store.update((state) => touchRecentFolder(state, "C:\\B"));
    await store.flush();
    expect(errors).toHaveLength(1);
    expect(writes).toHaveLength(1);
  });

  it("loadUiStateStore tolerates read failure", async () => {
    const store = await loadUiStateStore({
      read: () => Promise.reject(new Error("ipc down")),
    });
    expect(store.getSnapshot()).toEqual(DEFAULT_UI_STATE);
  });
});
