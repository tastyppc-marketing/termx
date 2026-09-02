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
import { PaneBindingsStore } from "../../plugins/paneBindings";
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

/// One ordinary terminal tab in main, plus one in an aux window: no plugin pane
/// anywhere, so every ensure-up below is the flag's doing and nothing else.
function layout(): Layout {
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
    store: createLayoutStore(layout()),
    persistence,
    attachments,
    sessions: [session(1), session(9)],
    generateId: () => "gen",
    settings: { getSnapshot: () => DEFAULT_SETTINGS },
    pluginPanes: new PaneBindingsStore({ initial: {}, save: async () => undefined }),
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
