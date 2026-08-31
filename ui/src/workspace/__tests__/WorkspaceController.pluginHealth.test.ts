/**
 * Plugin health polling (plugin spec §3/§4, P1 T6).
 *
 * A plugin is a process TermX does not own: it can be killed from Task Manager
 * at any moment, and nothing tells the workspace. So while a panel is on
 * screen the controller re-asks — every 15 s, once per plugin no matter how
 * many panes share it — and a failed answer flips the pane to the offline card.
 *
 * The probe is deliberately an OBSERVATION, never an ensure-up: respawning a
 * plugin the user just killed would make the offline card unreachable and the
 * Relaunch button a lie.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  type PaneSessionState,
  type WorkspaceAttachmentHub,
  type WorkspaceHostClient,
  type WorkspacePersistence,
  type WorkspacePluginHost,
} from "../WorkspaceController";

const SHOWROOM: PluginManifest = {
  manifest: 1,
  id: "showroom",
  name: "Showroom",
  icon: "🖼",
  start: { command: "node", args: ["server/showroom.js"] },
  singleton: true,
  discovery: { runtimeFile: "C:\\data\\Showroom\\runtime.json", healthPath: "/api/health" },
  panel: { path: "/" },
};

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

function layout(): Layout {
  return {
    version: 3,
    auxWindows: {},
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
    },
    activeTabId: "tab-1",
  };
}

function runtimeUp(): EnsureUpResult {
  return {
    ok: true,
    runtime: { port: 7345, token: "t", version: "1.0.0", url: "http://127.0.0.1:7345" },
  };
}

function harness(options: {
  /** `null` builds a host with NO probe method at all (the legacy shape). */
  probe?: ((pluginId: string) => Promise<boolean>) | null;
  ensureUp?: (pluginId: string) => Promise<EnsureUpResult>;
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
    record: vi.fn(),
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
  const ensureUp = vi.fn(options.ensureUp ?? (async () => runtimeUp()));
  const probe = vi.fn(options.probe ?? (async () => true));
  const plugins: WorkspacePluginHost = {
    manifestFor: (id: string) => (id === "showroom" ? SHOWROOM : null),
    ensureUp,
    ...(options.probe === null ? {} : { probe }),
  };
  const controller = new WorkspaceController({
    client,
    store: createLayoutStore(layout()),
    persistence,
    attachments,
    sessions: [session(1)],
    generateId: () => "panel-tab",
    pluginPanes: new PaneBindingsStore({ initial: {}, save: async () => undefined }),
    plugins,
  });
  return { controller, ensureUp, probe };
}

/** The reserved pane the plugin tab was opened around. */
function panelId(controller: WorkspaceController): number {
  const entry = Object.entries(controller.getSnapshot().paneStates).find(
    ([, state]) => state.status === "plugin",
  );
  if (entry === undefined) {
    throw new Error("no plugin pane in the layout");
  }
  return Number(entry[0]);
}

function panelState(controller: WorkspaceController): PaneSessionState {
  return controller.getSnapshot().paneStates[panelId(controller)]!;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("plugin health polling", () => {
  it("re-probes an open panel every 15 s, and only after the first interval", async () => {
    const { controller, probe } = harness();
    await controller.openPluginTab("showroom");
    await vi.advanceTimersByTimeAsync(0);
    expect(panelState(controller).pluginHealth).toBe("up");
    // Ensure-up just answered; asking again in the same breath is noise.
    expect(probe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith("showroom");

    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    // A healthy answer changes nothing the pane can see.
    expect(panelState(controller).pluginHealth).toBe("up");
    expect(panelState(controller).pluginUrl).toBe("http://127.0.0.1:7345");

    controller.dispose();
  });

  it("flips the pane to offline when the plugin stops answering", async () => {
    let alive = true;
    const { controller, ensureUp } = harness({ probe: async () => alive });
    await controller.openPluginTab("showroom");
    await vi.advanceTimersByTimeAsync(0);

    alive = false;
    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS);

    const state = panelState(controller);
    expect(state.pluginHealth).toBe("down");
    expect(state.pluginUrl).toBeNull();
    expect(state.pluginError).toBe("The panel stopped answering.");
    // The card offers Relaunch; the poller must not have pressed it.
    expect(ensureUp).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("stops asking once the plugin is down, so a killed panel stays killed", async () => {
    const { controller, probe, ensureUp } = harness({ probe: async () => false });
    await controller.openPluginTab("showroom");
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(panelState(controller).pluginHealth).toBe("down");

    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS * 4);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(ensureUp).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("never runs two probes at once, however slow the plugin is", async () => {
    const pending: { settle: ((alive: boolean) => void) | null } = { settle: null };
    const { controller, probe } = harness({
      probe: () => new Promise<boolean>((resolve) => {
        pending.settle = resolve;
      }),
    });
    await controller.openPluginTab("showroom");
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS * 3);
    expect(probe).toHaveBeenCalledTimes(1);

    pending.settle?.(true);
    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(2);

    controller.dispose();
  });

  it("shares one poller between the panes of one plugin", async () => {
    const { controller, probe } = harness();
    const tabId = await controller.openPluginTab("showroom");
    await vi.advanceTimersByTimeAsync(0);
    await controller.openPluginSplit(tabId!, panelId(controller), "showroom");
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("stops polling when the last pane of a plugin closes", async () => {
    const { controller, probe } = harness();
    const tabId = await controller.openPluginTab("showroom");
    await vi.advanceTimersByTimeAsync(0);
    const sessionId = panelId(controller);

    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(1);

    await controller.closePane(tabId!, sessionId);
    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS * 4);
    expect(probe).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("stops polling when the controller is disposed", async () => {
    const { controller, probe } = harness();
    await controller.openPluginTab("showroom");
    await vi.advanceTimersByTimeAsync(0);

    controller.dispose();
    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS * 4);
    expect(probe).not.toHaveBeenCalled();
  });

  it("polls nothing when the host has no probe seam, rather than guessing", async () => {
    // `probe: null` builds a host without the optional method — every legacy
    // fixture, and any window booted before the seam existed.
    const { controller, ensureUp } = harness({ probe: null });
    await controller.openPluginTab("showroom");
    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS * 4);

    expect(ensureUp).toHaveBeenCalledTimes(1);
    expect(panelState(controller).pluginHealth).toBe("up");

    controller.dispose();
  });
});
