/**
 * `openPlugin` — the ONE entry point every launcher uses (menubar spec).
 *
 * The menubar's Plugins list, the rail's plugin submenus and Settings' Open
 * button all land here, so the placement policy is written once: which surface
 * the manifest asked for, whether the plugin is already on screen somewhere,
 * and what to do when the surface it was asked for is not one it allows.
 *
 * The surface a panel currently occupies is DERIVED from the layout, never
 * stored: a lone pane in a tab of the main window is a tab, a lone pane in an
 * aux window is a dedicated window, and a pane sharing its tab is a split. That
 * keeps "already open as a split" honest when the user drags the pane somewhere
 * else afterwards.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionAttachment, SessionAttachmentCallbacks } from "../../host/client";
import type { SessionInfo } from "../../host/protocol";
import type { EnsureUpResult } from "../../plugins/lifecycle";
import type { PluginManifest } from "../../plugins/manifest";
import { PaneBindingsStore, type PluginPanesV1 } from "../../plugins/paneBindings";
import { createLayoutStore } from "../../state/store";
import { MAIN_WINDOW_ID, sessionIdsInSplit, type Layout } from "../../state/layout";
import { LayoutPersistence } from "../LayoutPersistence";
import {
  PLUGIN_BIND_ADOPT_TIMEOUT_MS,
  WorkspaceController,
  type WorkspaceAttachmentHub,
  type WorkspaceHostClient,
  type WorkspacePersistence,
  type WorkspacePluginHost,
} from "../WorkspaceController";
import { DEFAULT_SETTINGS } from "../../settings/settings";

function session(id: number): SessionInfo {
  return {
    id,
    profile: "powershell",
    cwd: `C:\\work\\project-${id}`,
    cols: 120,
    rows: 30,
    alive: true,
    pid: 1000 + id,
  };
}

/// tab-1 is a lone pane; tab-2 is a two-pane split and the ACTIVE tab, so the
/// stand-in focused pane is session 2.
function layout(): Layout {
  return {
    version: 3,
    auxWindows: {},
    windowNames: {},
    groups: {},
    rootItems: [{ kind: "tab", id: "tab-1" }, { kind: "tab", id: "tab-2" }],
    tabs: {
      "tab-1": {
        id: "tab-1",
        title: null,
        color: "blue",
        fill: "off",
        split: { kind: "pane", sessionId: 1 },
      },
      "tab-2": {
        id: "tab-2",
        title: null,
        color: "cyan",
        fill: "off",
        split: {
          kind: "split",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [
            { kind: "pane", sessionId: 2 },
            { kind: "pane", sessionId: 3 },
          ],
        },
      },
    },
    activeTabId: "tab-2",
  };
}

/// One tab in an aux window, for the forwarding cases.
function auxLayout(): Layout {
  return {
    version: 3,
    auxWindows: {
      "aux-1": { rootItems: [{ kind: "tab", id: "tab-9" }], activeTabId: "tab-9", bounds: null },
    },
    windowNames: {},
    groups: {},
    rootItems: [{ kind: "tab", id: "tab-1" }],
    tabs: {
      "tab-1": {
        id: "tab-1",
        title: null,
        color: "blue",
        fill: "off",
        split: { kind: "pane", sessionId: 1 },
      },
      "tab-9": {
        id: "tab-9",
        title: null,
        color: "green",
        fill: "off",
        split: { kind: "pane", sessionId: 9 },
      },
    },
    activeTabId: "tab-1",
  };
}

/// Singleton, and silent about placement: the pre-menubar shape every existing
/// plugin has, which must keep meaning "a tab, or a split if you ask".
const SHOWROOM: PluginManifest = {
  manifest: 1,
  id: "showroom",
  name: "Showroom",
  icon: "S",
  start: { command: "node", args: [] },
  singleton: true,
  discovery: { runtimeFile: "C:\\data\\Showroom\\runtime.json", healthPath: "/api/health" },
  panel: { path: "/" },
};

/// Not a singleton, splits by default, and allowed anywhere: the shape the
/// placement chips exist for.
const RECALL: PluginManifest = {
  manifest: 1,
  id: "recall",
  name: "Recall",
  icon: "R",
  start: { command: "node", args: [] },
  singleton: false,
  discovery: { runtimeFile: "C:\\data\\Recall\\runtime.json", healthPath: "/api/health" },
  panel: { path: "/" },
  surfaces: { default: "split", allowed: ["tab", "split", "window"] },
  minSize: { width: 360, height: 240 },
};

function runtimeUp(): EnsureUpResult {
  return {
    ok: true,
    runtime: { port: 7788, token: "t", version: "1.0.0", url: "http://127.0.0.1:7788" },
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface HarnessOptions {
  initial?: Layout;
  windowId?: string;
  pluginBindings?: PluginPanesV1;
  pluginPanesStore?: PaneBindingsStore;
  manifests?: Record<string, PluginManifest>;
  unavailableReason?: (pluginId: string) => string | null;
  /** Swap in the real persistence to count what actually reaches the writer. */
  persistence?: WorkspacePersistence;
  sessions?: SessionInfo[];
  /** The pane box the size rule measures; absent means "no box to measure". */
  measurePane?: (sessionId: number) => { width: number; height: number } | null;
  /** The OS-window raise seam; absent means "nothing can raise a window". */
  raiseWindow?: (windowId: string) => Promise<void>;
}

function harness(options: HarnessOptions = {}) {
  const client: WorkspaceHostClient = {
    createSession: vi.fn(async () => session(50)),
    closeSession: vi.fn(async () => undefined),
    onSessionExited: () => () => undefined,
    onSessionClosed: () => () => undefined,
    onError: () => () => undefined,
  };
  const persistenceCalls: Array<{ layout: Layout; kind: "structural" | "active_tab" }> = [];
  const persistence: WorkspacePersistence = options.persistence ?? {
    getSnapshot: () => ({ saving: false, error: null }),
    subscribe: () => () => undefined,
    record: (next, kind) => {
      persistenceCalls.push({ layout: next, kind });
    },
    flush: async () => undefined,
    dispose: vi.fn(),
  };
  const attachments: WorkspaceAttachmentHub = {
    sendInput: vi.fn(() => true),
    getSnapshot: () => ({ sessions: {} }),
    subscribe: () => () => undefined,
    attachSession: vi.fn(async () => undefined),
    markExited: vi.fn(),
    forgetSession: vi.fn(),
    attach: vi.fn(async (sessionId: number, _callbacks?: SessionAttachmentCallbacks) => ({
      sessionId,
      nextOffset: 0n,
      sendInput: vi.fn(),
      resize: vi.fn(),
      detach: vi.fn(),
    } satisfies SessionAttachment)),
    noteBell: vi.fn(),
    markSeen: vi.fn(),
    onError: () => () => undefined,
    close: vi.fn(),
  };
  const pluginPanes = options.pluginPanesStore ?? new PaneBindingsStore({
    initial: options.pluginBindings ?? {},
    save: async () => undefined,
  });
  const manifests = options.manifests ?? { showroom: SHOWROOM, recall: RECALL };
  const ensureUp = vi.fn(async () => runtimeUp());
  const plugins: WorkspacePluginHost = {
    manifestFor: (id: string) => manifests[id] ?? null,
    ensureUp,
    ...(options.unavailableReason ? { unavailableReason: options.unavailableReason } : {}),
  };
  let counter = 0;
  const store = createLayoutStore(options.initial ?? layout());
  const controller = new WorkspaceController({
    client,
    store,
    persistence,
    attachments,
    sessions: options.sessions ?? [session(1), session(2), session(3)],
    generateId: () => `gen-${(counter += 1)}`,
    settings: { getSnapshot: () => DEFAULT_SETTINGS },
    pluginPanes,
    plugins,
    ...(options.measurePane ? { measurePane: options.measurePane } : {}),
    ...(options.raiseWindow ? { raiseWindow: options.raiseWindow } : {}),
    ...(options.windowId ? { windowId: options.windowId } : {}),
  });
  return { controller, store, persistenceCalls, pluginPanes, ensureUp };
}

/// Every pane bound to `pluginId`, as `[tabId, sessionId]` pairs.
function panesFor(
  controller: WorkspaceController,
  bindings: PaneBindingsStore,
  pluginId: string,
): Array<[string, number]> {
  const state = controller.getSnapshot().layout;
  const out: Array<[string, number]> = [];
  for (const [key, binding] of Object.entries(bindings.getSnapshot())) {
    if (binding.pluginId !== pluginId) {
      continue;
    }
    const sessionId = Number(key);
    for (const [tabId, tab] of Object.entries(state.tabs)) {
      if (sessionIdsInSplit(tab.split).includes(sessionId)) {
        out.push([tabId, sessionId]);
      }
    }
  }
  return out;
}

describe("openPlugin surfaces", () => {
  it("uses the manifest's default surface when none is asked for", async () => {
    const h = harness();

    await h.controller.openPlugin("showroom");
    await tick();

    // Showroom declares nothing, so it defaults to a tab of its own.
    const panes = panesFor(h.controller, h.pluginPanes, "showroom");
    expect(panes).toHaveLength(1);
    const [tabId] = panes[0]!;
    expect(h.controller.getSnapshot().layout.tabs[tabId]!.split.kind).toBe("pane");
    expect(h.ensureUp).toHaveBeenCalledWith("showroom");
  });

  it("splits the focused pane when that is the manifest's default", async () => {
    const h = harness();

    await h.controller.openPlugin("recall");
    await tick();

    // tab-2 is active, so its first pane is the stand-in focus and the panel
    // lands beside it — in tab-2, not in a tab of its own.
    const panes = panesFor(h.controller, h.pluginPanes, "recall");
    expect(panes).toHaveLength(1);
    expect(panes[0]![0]).toBe("tab-2");
  });

  it("opens as a tab when the tab chip is picked", async () => {
    const h = harness();

    await h.controller.openPlugin("recall", "tab");
    await tick();

    const [[tabId]] = panesFor(h.controller, h.pluginPanes, "recall") as [[string, number]];
    expect(tabId).not.toBe("tab-2");
    expect(h.controller.getSnapshot().layout.tabs[tabId]!.split.kind).toBe("pane");
  });

  it("tears a dedicated window off in ONE structural write", async () => {
    const h = harness();

    await h.controller.openPlugin("recall", "window");
    await tick();

    const state = h.controller.getSnapshot().layout;
    const [[tabId]] = panesFor(h.controller, h.pluginPanes, "recall") as [[string, number]];
    expect(Object.keys(state.auxWindows)).toEqual(["aux-1"]);
    expect(state.auxWindows["aux-1"]!.rootItems).toEqual([{ kind: "tab", id: tabId }]);
    // The tab and the move are ONE transaction: a layout that reached disk
    // between them would restore a plugin tab sitting in the main rail.
    expect(h.persistenceCalls.filter((call) => call.kind === "structural")).toHaveLength(1);
  });

  it("refuses a surface the manifest does not allow, and writes nothing", async () => {
    const h = harness();

    await h.controller.openPlugin("showroom", "window");
    await tick();

    expect(panesFor(h.controller, h.pluginPanes, "showroom")).toEqual([]);
    expect(h.persistenceCalls).toEqual([]);
    expect(h.controller.getSnapshot().notice)
      .toBe("Showroom cannot open in its own window.");
  });

  it("says what the host says when the plugin cannot be opened at all", async () => {
    const h = harness({
      manifests: {},
      unavailableReason: () => "Showroom is disabled in Settings.",
    });

    await h.controller.openPlugin("showroom");

    expect(h.controller.getSnapshot().notice).toBe("Showroom is disabled in Settings.");
    expect(h.persistenceCalls).toEqual([]);
  });
});

describe("openPlugin re-entry", () => {
  it("focuses the panel already open instead of opening a second one", async () => {
    const h = harness();
    await h.controller.openPlugin("showroom", "tab");
    await tick();
    const before = panesFor(h.controller, h.pluginPanes, "showroom");
    h.controller.activateTab("tab-1");

    await h.controller.openPlugin("showroom");
    await tick();

    expect(panesFor(h.controller, h.pluginPanes, "showroom")).toEqual(before);
    expect(h.controller.getSnapshot().layout.activeTabId).toBe(before[0]![0]);
  });

  it("focuses a singleton even when a chip names a surface it is not on", async () => {
    const h = harness();
    await h.controller.openPlugin("showroom", "tab");
    await tick();
    const before = panesFor(h.controller, h.pluginPanes, "showroom");
    h.controller.activateTab("tab-1");

    // Showroom allows split too, but one process means one panel: a second
    // pane would frame the same page twice and fight over its state.
    await h.controller.openPlugin("showroom", "split");
    await tick();

    expect(panesFor(h.controller, h.pluginPanes, "showroom")).toEqual(before);
    expect(h.controller.getSnapshot().layout.activeTabId).toBe(before[0]![0]);
  });

  it("opens a second panel when a non-singleton is asked for a surface it is not on", async () => {
    const h = harness();
    await h.controller.openPlugin("recall", "tab");
    await tick();
    // Back on a terminal tab: the chip click means "beside THIS pane", which is
    // the only reading under which a second panel is what the user asked for.
    h.controller.activateTab("tab-2");

    await h.controller.openPlugin("recall", "split");
    await tick();

    const panes = panesFor(h.controller, h.pluginPanes, "recall");
    expect(panes).toHaveLength(2);
    expect(panes.map(([tabId]) => tabId)).toContain("tab-2");
  });

  it("focuses rather than duplicating when a non-singleton is already on that surface", async () => {
    const h = harness();
    await h.controller.openPlugin("recall", "tab");
    await tick();
    const before = panesFor(h.controller, h.pluginPanes, "recall");
    h.controller.activateTab("tab-1");

    await h.controller.openPlugin("recall", "tab");
    await tick();

    expect(panesFor(h.controller, h.pluginPanes, "recall")).toEqual(before);
    expect(h.controller.getSnapshot().layout.activeTabId).toBe(before[0]![0]);
  });

  it("focuses a panel that lives in another window", async () => {
    // The panel is main's; the click came from main. Focus follows the pane
    // wherever the user dragged it, which is the point of reading the layout
    // rather than remembering where it was opened.
    const h = harness({ initial: auxLayout(), sessions: [session(1), session(9)] });
    await h.controller.openPlugin("recall", "window");
    await tick();
    const [[tabId]] = panesFor(h.controller, h.pluginPanes, "recall") as [[string, number]];
    const windowId = Object.keys(h.controller.getSnapshot().layout.auxWindows)
      .find((id) => h.controller.getSnapshot().layout.auxWindows[id]!
        .rootItems.some((item) => item.kind === "tab" && item.id === tabId))!;

    await h.controller.openPlugin("recall", "window");
    await tick();

    expect(panesFor(h.controller, h.pluginPanes, "recall")).toHaveLength(1);
    expect(h.controller.getSnapshot().layout.auxWindows[windowId]!.activeTabId).toBe(tabId);
  });
});

describe("openPlugin from an aux window", () => {
  it("forwards exactly ONE layout write to main for a dedicated window", async () => {
    // An aux window may not write the daemon: its persistence writer IS the
    // bus forward. Two writes here would put a half-torn layout on the wire.
    const setLayout = vi.fn(async () => undefined);
    const forwarded: string[] = [];
    let acknowledge = (): void => undefined;
    const replica = new PaneBindingsStore({
      initial: {},
      save: null,
      onForward: (request) => {
        forwarded.push(request.op);
        if (request.op === "bind") {
          acknowledge = () => {
            replica.adopt({ [String(request.sessionId)]: request.binding });
          };
        }
      },
    });
    const persistence = new LayoutPersistence({ setLayout });
    const h = harness({
      initial: auxLayout(),
      windowId: "aux-1",
      pluginPanesStore: replica,
      persistence,
      sessions: [session(1), session(9)],
    });

    const opening = h.controller.openPlugin("recall", "window");
    await tick();
    expect(forwarded).toEqual(["bind"]);
    acknowledge();
    await opening;
    await persistence.flush();

    expect(setLayout).toHaveBeenCalledTimes(1);
    const state = h.controller.getSnapshot().layout;
    const [[tabId]] = panesFor(h.controller, replica, "recall") as [[string, number]];
    expect(Object.keys(state.auxWindows).sort()).toEqual(["aux-1", "aux-2"]);
    expect(state.auxWindows["aux-2"]!.rootItems).toEqual([{ kind: "tab", id: tabId }]);
  });

  it("never autostarts or spawns from an aux window's refusal path", async () => {
    const h = harness({ initial: auxLayout(), windowId: "aux-1", manifests: { showroom: SHOWROOM } });

    await h.controller.openPlugin("showroom", "window");

    expect(h.controller.getSnapshot().notice)
      .toBe("Showroom cannot open in its own window.");
    expect(h.ensureUp).not.toHaveBeenCalled();
  });
});

describe("openPlugin focus seam", () => {
  it("splits beside the pane App reports as focused, not the tab's first", async () => {
    const h = harness();
    h.controller.setFocusedPane((tabId) => (tabId === "tab-2" ? 3 : null));

    await h.controller.openPlugin("recall", "split");
    await tick();

    const tab = h.controller.getSnapshot().layout.tabs["tab-2"]!;
    // Session 3 is the right-hand pane; splitting it puts the panel inside a
    // nested split under child[1], never under child[0].
    expect(tab.split.kind).toBe("split");
    const right = tab.split.kind === "split" ? tab.split.children[1]! : null;
    expect(right?.kind).toBe("split");
  });

  it("falls back to the active tab's first pane when nothing reports focus", async () => {
    const h = harness();
    h.controller.setFocusedPane(() => null);

    await h.controller.openPlugin("recall", "split");
    await tick();

    const tab = h.controller.getSnapshot().layout.tabs["tab-2"]!;
    const left = tab.split.kind === "split" ? tab.split.children[0]! : null;
    expect(left?.kind).toBe("split");
  });

  it("takes the caller's tab, and App's focus WITHIN it", async () => {
    // The rail's tab menu names the tab it was opened on; App knows which pane
    // of that tab the user is in. Neither alone is enough: the tab may not be
    // active, and the rail's own anchor is only a guess at the pane.
    const h = harness();
    h.controller.setFocusedPane((tabId) => (tabId === "tab-2" ? 3 : null));

    await h.controller.openPlugin("recall", "split", {
      pane: { tabId: "tab-2", sessionId: 2 },
    });
    await tick();

    const tab = h.controller.getSnapshot().layout.tabs["tab-2"]!;
    const right = tab.split.kind === "split" ? tab.split.children[1]! : null;
    expect(right?.kind).toBe("split");
  });

  it("keeps the caller's own anchor when App has no record for that tab", async () => {
    const h = harness();
    h.controller.setFocusedPane(() => null);
    // tab-2 is active, so an unhinted split would take session 2; the caller
    // asked for session 3 and there is nothing better to override it with.
    await h.controller.openPlugin("recall", "split", {
      pane: { tabId: "tab-2", sessionId: 3 },
    });
    await tick();

    const tab = h.controller.getSnapshot().layout.tabs["tab-2"]!;
    const right = tab.split.kind === "split" ? tab.split.children[1]! : null;
    expect(right?.kind).toBe("split");
  });

  it("refuses rather than splitting elsewhere when the caller's tab has gone", async () => {
    const h = harness();

    await h.controller.openPlugin("recall", "split", {
      pane: { tabId: "tab-gone", sessionId: 7 },
    });
    await tick();

    expect(panesFor(h.controller, h.pluginPanes, "recall")).toEqual([]);
  });

  it("opens a plugin tab into the group the caller named", async () => {
    const grouped: Layout = {
      ...layout(),
      groups: {
        "group-1": {
          id: "group-1",
          name: "Work",
          collapsed: false,
          color: null,
          items: [],
        },
      },
      rootItems: [
        { kind: "tab", id: "tab-1" },
        { kind: "tab", id: "tab-2" },
        { kind: "group", id: "group-1" },
      ],
    };
    const h = harness({ initial: grouped });

    await h.controller.openPlugin("recall", "tab", { groupId: "group-1" });
    await tick();

    const [[tabId]] = panesFor(h.controller, h.pluginPanes, "recall") as [[string, number]];
    expect(h.controller.getSnapshot().layout.groups["group-1"]!.items)
      .toEqual([{ kind: "tab", id: tabId }]);
  });

  it("opens as a tab when this window has no pane to split", async () => {
    const empty: Layout = {
      version: 3,
      auxWindows: {},
      windowNames: {},
      groups: {},
      rootItems: [],
      tabs: {},
      activeTabId: null,
    };
    const h = harness({ initial: empty, sessions: [] });

    await h.controller.openPlugin("recall", "split");
    await tick();

    const panes = panesFor(h.controller, h.pluginPanes, "recall");
    expect(panes).toHaveLength(1);
    const [tabId] = panes[0]!;
    expect(h.controller.getSnapshot().layout.tabs[tabId]!.split.kind).toBe("pane");
    expect(MAIN_WINDOW_ID).toBe("main");
  });
});

/**
 * The size rule (menubar spec): a split that would leave the panel under its
 * declared `minSize` restructures instead of cramming.
 *
 * Panes tile their tab with no gutter, and the 6px divider is an overlay strip
 * centred on the boundary - so each side of a split gets half the box less
 * three pixels, and `SPLIT_DIVIDER_PX` is what comes off the pair.
 *
 * Recall declares 360x240, so every box below is chosen against that.
 */
describe("openPlugin size rule", () => {
  /** A measurer that answers the same box for whatever pane it is asked about. */
  function box(width: number, height: number) {
    return () => ({ width, height });
  }

  /// Which direction tab-2's split ended up going, or null when it never split.
  function splitDirOf(controller: WorkspaceController): string | null {
    const tab = controller.getSnapshot().layout.tabs["tab-2"];
    if (!tab || tab.split.kind !== "split") {
      return null;
    }
    const left = tab.split.children[0]!;
    return left.kind === "split" ? left.dir : null;
  }

  it("splits as asked when the pane leaves room for both halves", async () => {
    const h = harness({ measurePane: box(1000, 600) });

    await h.controller.openPlugin("recall", "split");
    await tick();

    expect(splitDirOf(h.controller)).toBe("row");
    expect(h.controller.getSnapshot().notice).toBeNull();
  });

  it("splits at exactly the minimum rather than calling it too small", async () => {
    // 726 = 360 * 2 + the 6px divider strip, and 240 is the height floor: the
    // boundary belongs on the side that still works.
    const h = harness({ measurePane: box(726, 240) });

    await h.controller.openPlugin("recall", "split");
    await tick();

    expect(splitDirOf(h.controller)).toBe("row");
  });

  it("splits DOWN when the pane is too narrow sideways but tall enough", async () => {
    // 600 wide leaves 297 a side, under 360; 600 tall leaves 297 under, over
    // 240. Restructuring beats cramming, which is the whole point of the rule.
    const h = harness({ measurePane: box(600, 600) });

    await h.controller.openPlugin("recall", "split");
    await tick();

    expect(splitDirOf(h.controller)).toBe("col");
    expect(h.controller.getSnapshot().notice).toBeNull();
  });

  it("opens a tab and says why when neither direction leaves room", async () => {
    // 500x300: too narrow to sit beside (247), too short to sit under (147).
    const h = harness({ measurePane: box(500, 300) });

    await h.controller.openPlugin("recall", "split");
    await tick();

    expect(splitDirOf(h.controller)).toBeNull();
    const panes = panesFor(h.controller, h.pluginPanes, "recall");
    expect(panes).toHaveLength(1);
    expect(h.controller.getSnapshot().layout.tabs[panes[0]![0]]!.split.kind).toBe("pane");
    expect(h.controller.getSnapshot().notice)
      .toBe("Recall needs 360\u00d7240 to split \u2014 opened as a tab.");
  });

  it("refuses to split a pane too narrow for the panel at any height", async () => {
    // A column split does not widen anything: under minWidth, nothing fits.
    const h = harness({ measurePane: box(300, 4000) });

    await h.controller.openPlugin("recall", "split");
    await tick();

    expect(splitDirOf(h.controller)).toBeNull();
    expect(h.controller.getSnapshot().notice)
      .toBe("Recall needs 360\u00d7240 to split \u2014 opened as a tab.");
  });

  it("treats a pane it cannot measure as room enough", async () => {
    // A pane that has not been laid out, a harness with no document, a window
    // still painting. Refusing on a missing measurement would break splitting
    // in exactly the cases where nothing is actually wrong.
    const h = harness({ measurePane: () => null });

    await h.controller.openPlugin("recall", "split");
    await tick();

    expect(splitDirOf(h.controller)).toBe("row");
    expect(h.controller.getSnapshot().notice).toBeNull();
  });

  it("measures the pane the split would actually go beside", async () => {
    const asked: number[] = [];
    const h = harness({
      measurePane: (sessionId) => {
        asked.push(sessionId);
        return { width: 1000, height: 600 };
      },
    });
    h.controller.setFocusedPane((tabId) => (tabId === "tab-2" ? 3 : null));

    await h.controller.openPlugin("recall", "split");
    await tick();

    expect(asked).toContain(3);
  });

  it("uses the plugin's own floor, so a modest panel still fits", async () => {
    // Showroom declares no minSize and takes the 320x200 default; 700x420
    // leaves 347 a side, which is under Recall's 360 but over Showroom's 320.
    const h = harness({ measurePane: box(700, 420) });

    await h.controller.openPlugin("showroom", "split");
    await tick();

    expect(splitDirOf(h.controller)).toBe("row");
  });

  it("keeps a real open failure's reason instead of the size notice", async () => {
    // The tab fallback failed on its own terms. Replacing that reason with
    // "opened as a tab" would claim something happened that did not.
    const failing = harness({
      measurePane: box(500, 300),
      manifests: {},
      unavailableReason: () => "Recall is disabled in Settings.",
    });

    await failing.controller.openPlugin("recall", "split");

    expect(failing.controller.getSnapshot().notice)
      .toBe("Recall is disabled in Settings.");
  });
});

/**
 * Aux coverage for the ordinary surfaces (review P-F6). The dedicated-window
 * case was pinned from the start; tab and split were not, and they are the two
 * a user actually reaches for from a torn-out window.
 *
 * Two separate channels have to behave: the LAYOUT goes to main as one
 * `setLayout` forward, and the BINDING goes to main over the plugin-panes
 * channel. Neither may be written locally - an aux window is a replica of both
 * files, and a local write is a second writer.
 */
describe("openPlugin surfaces from an aux window", () => {
  function auxHarness() {
    const setLayout = vi.fn(async () => undefined);
    const forwarded: string[] = [];
    let acknowledge = (): void => undefined;
    const replica = new PaneBindingsStore({
      initial: {},
      save: null,
      onForward: (request) => {
        forwarded.push(request.op);
        if (request.op === "bind") {
          acknowledge = () => {
            replica.adopt({ [String(request.sessionId)]: request.binding });
          };
        }
      },
    });
    const persistence = new LayoutPersistence({ setLayout });
    const h = harness({
      initial: auxLayout(),
      windowId: "aux-1",
      pluginPanesStore: replica,
      persistence,
      sessions: [session(1), session(9)],
    });
    return {
      ...h,
      replica,
      persistence,
      setLayout,
      forwarded,
      ack: () => acknowledge(),
    };
  }

  it("forwards a tab open once, and writes no binding locally", async () => {
    const a = auxHarness();

    const opening = a.controller.openPlugin("recall", "tab");
    await tick();
    // The layout must not move until main has accepted the binding: a pane in
    // the blob with no binding behind it restores as a corpse.
    expect(a.forwarded).toEqual(["bind"]);
    expect(a.replica.getSnapshot()).toEqual({});
    expect(a.setLayout).not.toHaveBeenCalled();

    a.ack();
    await opening;
    await a.persistence.flush();

    expect(a.setLayout).toHaveBeenCalledTimes(1);
    expect(a.forwarded).toEqual(["bind"]);
    const [[tabId]] = panesFor(a.controller, a.replica, "recall") as [[string, number]];
    // A tab opened from aux-1 belongs to aux-1's rail, not main's.
    expect(a.controller.getSnapshot().layout.auxWindows["aux-1"]!.rootItems)
      .toContainEqual({ kind: "tab", id: tabId });
  });

  it("forwards a split open once, and writes no binding locally", async () => {
    const a = auxHarness();

    const opening = a.controller.openPlugin("recall", "split");
    await tick();
    expect(a.forwarded).toEqual(["bind"]);
    expect(a.replica.getSnapshot()).toEqual({});

    a.ack();
    await opening;
    await a.persistence.flush();

    expect(a.setLayout).toHaveBeenCalledTimes(1);
    expect(a.forwarded).toEqual(["bind"]);
    // Beside aux-1's own focused pane, which is tab-9's only pane.
    const panes = panesFor(a.controller, a.replica, "recall");
    expect(panes).toHaveLength(1);
    expect(panes[0]![0]).toBe("tab-9");
  });

  it("takes the binding back and forwards nothing more when main refuses", async () => {
    // Main never acknowledges. The open must not write a layout at all, and the
    // row it asked for must be withdrawn rather than left as an orphan.
    vi.useFakeTimers();
    const a = auxHarness();

    const opening = a.controller.openPlugin("recall", "tab");
    await vi.advanceTimersByTimeAsync(PLUGIN_BIND_ADOPT_TIMEOUT_MS + 10);
    await opening;

    expect(a.setLayout).not.toHaveBeenCalled();
    expect(a.forwarded).toEqual(["bind", "unbind"]);
    expect(a.replica.getSnapshot()).toEqual({});
    vi.useRealTimers();
  });
});

/**
 * "Already open → focus it" has to be VISIBLE (review P-C3).
 *
 * Setting the owning window's `activeTabId` is the whole of what the layout
 * can express, and it is not enough twice over. A panel sharing the ACTIVE tab
 * is already in the active tab, so that write changes nothing at all - the
 * terminal beside it keeps keyboard focus and every pane command still goes
 * there. And a panel in another OS window gets its tab selected behind a
 * window nobody raised.
 *
 * So the controller says what it wants and lets the two owners do it: App owns
 * DOM focus and reads `focusRequest`; the window manager owns OS windows and is
 * reached through the `raiseWindow` seam. `seq` exists because the same pane is
 * very often the answer twice running - without it the second press of a menu
 * row would be indistinguishable from the first and App would ignore it.
 */
describe("openPlugin focus request", () => {
  it("asks App to focus the pane when the panel is in this window", async () => {
    const h = harness();
    await h.controller.openPlugin("recall", "tab");
    await tick();
    const [[tabId, sessionId]] = panesFor(h.controller, h.pluginPanes, "recall") as [[string, number]];
    h.controller.activateTab("tab-1");

    await h.controller.openPlugin("recall");
    await tick();

    expect(h.controller.getSnapshot().focusRequest)
      .toEqual({ tabId, sessionId, seq: 1 });
  });

  it("asks again, with a fresh seq, when the pane is ALREADY the active tab", async () => {
    // The bug in one test: the panel is in the active tab, so setting the
    // active tab writes nothing, and a focus request that did not change would
    // leave the click doing visibly nothing.
    const h = harness();
    await h.controller.openPlugin("recall", "tab");
    await tick();

    await h.controller.openPlugin("recall");
    const first = h.controller.getSnapshot().focusRequest;
    await h.controller.openPlugin("recall");
    const second = h.controller.getSnapshot().focusRequest;

    expect(first?.seq).toBe(1);
    expect(second?.seq).toBe(2);
    expect(second?.tabId).toBe(first?.tabId);
  });

  it("raises the other OS window instead, and asks App for nothing", async () => {
    // App cannot focus a pane it does not render. Its window has to come
    // forward first, and the window that owns it will make its own focus
    // request when it renders the tab it was just told to activate.
    const raised: string[] = [];
    const h = harness({ raiseWindow: async (windowId) => { raised.push(windowId); } });
    await h.controller.openPlugin("recall", "window");
    await tick();

    await h.controller.openPlugin("recall", "window");
    await tick();

    expect(raised).toEqual(["aux-1"]);
    expect(h.controller.getSnapshot().focusRequest).toBeNull();
  });

  it("focuses without a raise seam rather than throwing", async () => {
    // Every legacy fixture, and any window booted before the seam existed.
    // The tab still becomes its window's active tab; only the raise is lost.
    const h = harness();
    await h.controller.openPlugin("recall", "window");
    await tick();

    await h.controller.openPlugin("recall", "window");
    await tick();

    const state = h.controller.getSnapshot().layout;
    const [[tabId]] = panesFor(h.controller, h.pluginPanes, "recall") as [[string, number]];
    expect(state.auxWindows["aux-1"]!.activeTabId).toBe(tabId);
    expect(h.controller.getSnapshot().focusRequest).toBeNull();
  });
});

/**
 * A singleton stays ONE panel across the gap in its own open (review P-C4).
 *
 * An open commits the binding and waits for it to be accepted BEFORE it writes
 * the layout, and "already open" is read from panes in the layout - so for the
 * width of that await the plugin is open and looks shut. Two launches inside
 * it (a double click, or main and an aux window at once) both see "not open"
 * and a plugin the spec says is one process gets two panels framing it.
 */
describe("openPlugin singleton race", () => {
  it("opens ONE panel for two launches in the same breath", async () => {
    const h = harness();

    await Promise.all([
      h.controller.openPlugin("showroom"),
      h.controller.openPlugin("showroom"),
    ]);
    await tick();

    expect(panesFor(h.controller, h.pluginPanes, "showroom")).toHaveLength(1);
  });

  it("treats a committed binding with no pane yet as already opening", async () => {
    // The cross-window half: main has ACCEPTED an aux window's binding and its
    // layout write is still on the wire. A second launch here must wait for it
    // rather than race it.
    const h = harness({ pluginBindings: { "2147483648": { pluginId: "showroom" } } });

    await h.controller.openPlugin("showroom");
    await tick();

    expect(panesFor(h.controller, h.pluginPanes, "showroom")).toEqual([]);
    expect(h.persistenceCalls.filter((call) => call.kind === "structural")).toEqual([]);
  });

  it("still opens a second panel for a plugin that is not a singleton", async () => {
    // The guard is the singleton rule, not a general lock: Recall may have as
    // many panels as the user asks for.
    const h = harness();

    await h.controller.openPlugin("recall", "tab");
    await tick();
    h.controller.activateTab("tab-2");
    await h.controller.openPlugin("recall", "split");
    await tick();

    expect(panesFor(h.controller, h.pluginPanes, "recall")).toHaveLength(2);
  });
});

/**
 * A chip focuses the instance ON THAT SURFACE (review P-C6).
 *
 * With a tab panel and a window panel of the same plugin, "already open on the
 * surface you asked for" was answered by focusing the FIRST placement found -
 * which is main's, because the search walks the windows in order. Pressing
 * Window then brought the tab forward, which is the one thing the chip
 * certainly did not mean.
 */
describe("openPlugin chip picks its own instance", () => {
  async function twoInstances(raised: string[]) {
    const h = harness({ raiseWindow: async (windowId) => { raised.push(windowId); } });
    await h.controller.openPlugin("recall", "tab");
    await tick();
    await h.controller.openPlugin("recall", "window");
    await tick();
    return h;
  }

  it("raises the WINDOW instance for the window chip", async () => {
    const raised: string[] = [];
    const h = await twoInstances(raised);

    await h.controller.openPlugin("recall", "window");
    await tick();

    expect(raised).toEqual(["aux-1"]);
    expect(h.controller.getSnapshot().focusRequest).toBeNull();
  });

  it("focuses the TAB instance for the tab chip", async () => {
    const raised: string[] = [];
    const h = await twoInstances(raised);
    const tabPane = panesFor(h.controller, h.pluginPanes, "recall")
      .find(([tabId]) => h.controller.getSnapshot().layout.rootItems
        .some((item) => item.kind === "tab" && item.id === tabId))!;

    await h.controller.openPlugin("recall", "tab");
    await tick();

    expect(raised).toEqual([]);
    expect(h.controller.getSnapshot().focusRequest)
      .toEqual({ tabId: tabPane[0], sessionId: tabPane[1], seq: 1 });
  });
});
