/**
 * "Start with TermX" as the controller sees it (menubar spec).
 *
 * The flag itself lives in the registry and the boot wiring is bootstrap's, but
 * the CONSEQUENCE is here: an autostarted plugin joins the set of plugins this
 * window is responsible for, exactly as a plugin with a pane does. That one
 * decision buys three behaviours at once - it is started at boot, its runtime
 * is never forgotten while nothing renders it, and the health poll watches it
 * so a plugin that dies at 3am shows as down rather than as stale "up".
 *
 * Main only. Spawning is the main window's alone (plugin spec §3): two windows
 * both finding a marked plugin down would both start the singleton.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionAttachment, SessionAttachmentCallbacks } from "../../host/client";
import type { SessionInfo } from "../../host/protocol";
import type { EnsureUpResult } from "../../plugins/lifecycle";
import type { PluginManifest } from "../../plugins/manifest";
import { PaneBindingsStore, PLUGIN_PANE_MIN_ID } from "../../plugins/paneBindings";
import { createLayoutStore } from "../../state/store";
import type { Layout } from "../../state/layout";
import {
  PLUGIN_HEALTH_INTERVAL_MS,
  WorkspaceController,
  type WorkspaceAttachmentHub,
  type WorkspaceHostClient,
  type WorkspacePersistence,
  type WorkspacePluginHost,
} from "../WorkspaceController";
import { DEFAULT_SETTINGS } from "../../settings/settings";

afterEach(() => {
  vi.useRealTimers();
});

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

/// The reserved id a bound plugin pane uses in the tests that need one.
const PANEL_ID = PLUGIN_PANE_MIN_ID;

/// One ordinary terminal tab in main, plus one in an aux window: no plugin pane
/// anywhere, so every ensure-up below is the flag's doing and nothing else.
/// `withPanel` adds a tab whose pane IS Showroom, for the cases that have to
/// tell "unmarked" apart from "gone".
function layout(withPanel = false): Layout {
  return {
    version: 3,
    auxWindows: {
      "aux-1": { rootItems: [{ kind: "tab", id: "tab-9" }], activeTabId: "tab-9", bounds: null },
    },
    windowNames: {},
    groups: {},
    rootItems: withPanel
      ? [{ kind: "tab", id: "tab-1" }, { kind: "tab", id: "tab-panel" }]
      : [{ kind: "tab", id: "tab-1" }],
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
      ...(withPanel
        ? {
          "tab-panel": {
            id: "tab-panel",
            title: "Showroom",
            color: "cyan" as const,
            fill: "off" as const,
            split: { kind: "pane" as const, sessionId: PANEL_ID },
          },
        }
        : {}),
    },
    activeTabId: "tab-1",
  };
}

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

const TOOLBOX: PluginManifest = { ...SHOWROOM, id: "toolbox", name: "Toolbox" };

function runtimeUp(): EnsureUpResult {
  return {
    ok: true,
    runtime: { port: 7788, token: "t", version: "1.0.0", url: "http://127.0.0.1:7788" },
  };
}

function harness(options: {
  windowId?: string;
  autostartIds?: () => readonly string[];
  probe?: (pluginId: string, origin: string) => Promise<boolean>;
  /** Render a bound Showroom pane, so "unmarked" is not the same as "gone". */
  withPanel?: boolean;
} = {}) {
  const client: WorkspaceHostClient = {
    createSession: vi.fn(async () => session(50)),
    closeSession: vi.fn(async () => undefined),
    onSessionExited: () => () => undefined,
    onSessionClosed: () => () => undefined,
    onError: () => () => undefined,
  };
  const persistence: WorkspacePersistence = {
    getSnapshot: () => ({ saving: false, error: null }),
    subscribe: () => () => undefined,
    record: () => undefined,
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
  const manifests: Record<string, PluginManifest> = {
    showroom: SHOWROOM,
    toolbox: TOOLBOX,
  };
  // Typed so the assertions can read the plugin id out of `mock.calls`.
  const ensureUp = vi.fn(async (_pluginId: string) => runtimeUp());
  const probe = vi.fn(options.probe ?? (async () => true));
  const plugins: WorkspacePluginHost = {
    manifestFor: (id: string) => manifests[id] ?? null,
    ensureUp,
    probe,
    ...(options.autostartIds ? { autostartIds: options.autostartIds } : {}),
  };
  const controller = new WorkspaceController({
    client,
    store: createLayoutStore(layout(options.withPanel ?? false)),
    persistence,
    attachments,
    sessions: [session(1), session(9)],
    generateId: () => "gen",
    settings: { getSnapshot: () => DEFAULT_SETTINGS },
    pluginPanes: new PaneBindingsStore({
      initial: options.withPanel
        ? { [String(PANEL_ID)]: { pluginId: "showroom" } }
        : {},
      save: async () => undefined,
    }),
    plugins,
    ...(options.windowId ? { windowId: options.windowId } : {}),
  });
  return { controller, ensureUp, probe };
}

describe("autostart scope", () => {
  it("starts a marked plugin at boot with no pane anywhere", async () => {
    const h = harness({ autostartIds: () => ["showroom"] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.ensureUp).toHaveBeenCalledWith("showroom");
    expect(h.ensureUp).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });

  it("starts every marked plugin, and only those", async () => {
    const h = harness({ autostartIds: () => ["showroom", "toolbox"] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.ensureUp.mock.calls.map(([id]) => id).sort())
      .toEqual(["showroom", "toolbox"]);
    h.controller.dispose();
  });

  it("starts nothing when no plugin is marked", async () => {
    const h = harness({ autostartIds: () => [] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.ensureUp).not.toHaveBeenCalled();
    h.controller.dispose();
  });

  it("starts nothing in an aux window, flag or no flag", async () => {
    // Belt and braces: bootstrap does not hand an aux window the accessor at
    // all, and the controller refuses it even when something does.
    const h = harness({ windowId: "aux-1", autostartIds: () => ["showroom"] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.ensureUp).not.toHaveBeenCalled();
    h.controller.dispose();
  });

  it("keeps polling a marked plugin's health with nothing on screen", async () => {
    // The point of the flag is a plugin running while no pane shows it. Without
    // the poll its cached "up" would never be re-checked, and the first pane to
    // open would frame a port that died hours ago.
    vi.useFakeTimers();
    const h = harness({ autostartIds: () => ["showroom"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.probe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS);

    expect(h.probe).toHaveBeenCalledWith("showroom", "http://127.0.0.1:7788");
    h.controller.dispose();
  });

  it("stops polling a marked plugin once the window is disposed", async () => {
    vi.useFakeTimers();
    const h = harness({ autostartIds: () => ["showroom"] });
    await vi.advanceTimersByTimeAsync(0);
    h.controller.dispose();

    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS * 3);

    expect(h.probe).not.toHaveBeenCalled();
  });
});

/**
 * The flag is LIVE (review P-F2). `autostartIds()` reads the registry every
 * time, but nothing recomputed the scope after boot: the sync ran from the
 * constructor, a layout change or a binding change, and none of those happen
 * when the user flips a switch in Settings with no pane open.
 *
 * So the toggle was dead in both directions - on started nothing until some
 * unrelated layout mutation, and off left the runtime, the poller and the
 * scope entry standing, which also left a queued relaunch free to spawn a
 * plugin the user had just unmarked.
 */
describe("autostart refresh", () => {
  /// A registry the test can flip mid-run, as Settings does.
  function marked(initial: string[]) {
    const ids = { current: initial };
    return { ids, accessor: (): readonly string[] => ids.current };
  }

  it("starts a plugin marked after boot", async () => {
    const flag = marked([]);
    const h = harness({ autostartIds: flag.accessor });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.ensureUp).not.toHaveBeenCalled();

    flag.ids.current = ["showroom"];
    h.controller.refreshPluginScope();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.ensureUp).toHaveBeenCalledWith("showroom");
    h.controller.dispose();
  });

  it("stops polling a plugin unmarked with no pane open", async () => {
    vi.useFakeTimers();
    const flag = marked(["showroom"]);
    const h = harness({ autostartIds: flag.accessor });
    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS);
    expect(h.probe).toHaveBeenCalledTimes(1);

    flag.ids.current = [];
    h.controller.refreshPluginScope();
    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS * 3);

    // The runtime went with the poller: nothing renders it and nothing is
    // marked, so a cached "up" would send the next open at a dead port.
    expect(h.probe).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });

  it("keeps a plugin whose pane is still open when it is unmarked", async () => {
    // Unmarking is "do not start this at launch", never "stop it now". The
    // pane on screen is still framing it.
    vi.useFakeTimers();
    const flag = marked(["showroom"]);
    const h = harness({ autostartIds: flag.accessor, withPanel: true });
    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS);
    const before = h.probe.mock.calls.length;

    flag.ids.current = [];
    h.controller.refreshPluginScope();
    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS);

    expect(h.probe.mock.calls.length).toBeGreaterThan(before);
    h.controller.dispose();
  });

  it("releases the runtime, so re-marking has to start the plugin again", async () => {
    // Leaving scope must release the runtime exactly as a departed pane does.
    // A kept answer is what `ensurePluginUp` skips on, so a plugin unmarked
    // and re-marked would be "up" at whatever port it had before - which is
    // the one thing a plugin that died unattended is not.
    const flag = marked(["showroom"]);
    const h = harness({ autostartIds: flag.accessor });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.ensureUp).toHaveBeenCalledTimes(1);

    flag.ids.current = [];
    h.controller.refreshPluginScope();
    flag.ids.current = ["showroom"];
    h.controller.refreshPluginScope();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.ensureUp).toHaveBeenCalledTimes(2);
    h.controller.dispose();
  });

  it("refuses to act on the flag in an aux window", async () => {
    const flag = marked([]);
    const h = harness({ windowId: "aux-1", autostartIds: flag.accessor });
    flag.ids.current = ["showroom"];

    h.controller.refreshPluginScope();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.ensureUp).not.toHaveBeenCalled();
    h.controller.dispose();
  });
});
