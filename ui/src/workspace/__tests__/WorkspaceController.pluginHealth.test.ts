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
import { PaneBindingsStore, PLUGIN_PANE_MIN_ID } from "../../plugins/paneBindings";
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

/** Every controller a test builds, disposed in `afterEach`. */
const live: WorkspaceController[] = [];

/** A layout whose plugin pane sits in the MAIN window's rail. */
function layoutWithPanelInMain(): Layout {
  const state = layout();
  state.auxWindows["aux-1"] = { rootItems: [], activeTabId: null, bounds: null };
  state.tabs.panel = {
    id: "panel",
    title: "Showroom",
    color: "magenta",
    fill: "off",
    split: { kind: "pane", sessionId: PLUGIN_PANE_MIN_ID },
  };
  state.rootItems.push({ kind: "tab", id: "panel" });
  return state;
}

/** A layout whose plugin pane sits in an AUX window's rail. */
function layoutWithPanelInAux(): Layout {
  const state = layout();
  state.tabs.panel = {
    id: "panel",
    title: "Showroom",
    color: "magenta",
    fill: "off",
    split: { kind: "pane", sessionId: PLUGIN_PANE_MIN_ID },
  };
  state.auxWindows["aux-1"] = {
    rootItems: [{ kind: "tab", id: "panel" }],
    activeTabId: "panel",
    bounds: null,
  };
  return state;
}

function harness(options: {
  /** `null` builds a host with NO probe method at all (the legacy shape). */
  probe?: ((pluginId: string, origin: string) => Promise<boolean>) | null;
  /** Aux-only seam: one look for a plugin this window believes is down. */
  observeOnce?: (pluginId: string) => Promise<EnsureUpResult>;
  ensureUp?: (pluginId: string) => Promise<EnsureUpResult>;
  initial?: Layout;
  windowId?: string;
  bindings?: Record<string, { pluginId: string }>;
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
  const observeOnce = vi.fn(
    options.observeOnce
      ?? (async () => ({
        ok: false as const,
        reason: "The plugin is not running. Relaunch it from the main window.",
        stderrTail: "",
      })),
  );
  const plugins: WorkspacePluginHost = {
    manifestFor: (id: string) => (id === "showroom" ? SHOWROOM : null),
    ensureUp,
    ...(options.probe === null ? {} : { probe }),
    // Present on every harness host: whether a MAIN controller leaves it alone
    // is one of the things under test.
    observeOnce,
  };
  const pluginPanes = new PaneBindingsStore({
    initial: options.bindings ?? {},
    save: async () => undefined,
  });
  const controller = new WorkspaceController({
    client,
    store: createLayoutStore(options.initial ?? layout()),
    persistence,
    attachments,
    sessions: [session(1)],
    generateId: () => "panel-tab",
    pluginPanes,
    plugins,
    ...(options.windowId ? { windowId: options.windowId } : {}),
  });
  live.push(controller);
  return { controller, ensureUp, probe, observeOnce, pluginPanes };
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
  // Disposed HERE, not at the end of each test body: a failed expect skips
  // the rest of the body, and a leaked 15 s interval then fires inside the
  // next test with that test's fake clock.
  for (const controller of live.splice(0)) {
    controller.dispose();
  }
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
    expect(probe).toHaveBeenCalledWith("showroom", "http://127.0.0.1:7345");

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

  it("asks every 15 seconds, not merely on some interval", async () => {
    // The other cases advance by the constant itself, so they would pass at
    // any value. This is the only place the actual cadence is pinned.
    expect(PLUGIN_HEALTH_INTERVAL_MS).toBe(15_000);
  });

  it("treats a probe that throws as the panel being gone", async () => {
    const { controller } = harness({
      probe: async () => {
        throw new Error("connection refused");
      },
    });
    await controller.openPluginTab("showroom");
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS);

    expect(panelState(controller).pluginHealth).toBe("down");
  });

  it("re-frames the new port when a relaunched plugin moves", async () => {
    // Showroom walks ports (spec §9). The poll asks the origin the pane is
    // FRAMING, so a plugin that came back elsewhere reads as down — and the
    // Relaunch that follows is what re-reads the runtime file.
    let port = 7345;
    const { controller, probe } = harness({
      ensureUp: async () => ({
        ok: true,
        runtime: {
          port,
          token: "t",
          version: "1.0.0",
          url: `http://127.0.0.1:${port}`,
        },
      }),
      probe: async (_pluginId, origin) => origin.endsWith("7999"),
    });
    await controller.openPluginTab("showroom");
    await vi.advanceTimersByTimeAsync(0);
    expect(panelState(controller).pluginUrl).toBe("http://127.0.0.1:7345");

    // The plugin died and came back on another port; the old frame is dead.
    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS);
    expect(probe).toHaveBeenCalledWith("showroom", "http://127.0.0.1:7345");
    expect(panelState(controller).pluginHealth).toBe("down");

    port = 7999;
    await controller.relaunchPlugin(panelId(controller));
    await vi.advanceTimersByTimeAsync(0);

    expect(panelState(controller).pluginUrl).toBe("http://127.0.0.1:7999");
    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS);
    expect(probe).toHaveBeenLastCalledWith("showroom", "http://127.0.0.1:7999");
    expect(panelState(controller).pluginHealth).toBe("up");
  });

  it("lets a probe that lands after the last pane closed change nothing", async () => {
    // Otherwise the late answer re-creates a runtime entry for a plugin no
    // pane renders, and the NEXT open short-circuits on it: a panel that
    // opens straight into "down" without anything having been asked.
    const pending: { settle: ((alive: boolean) => void) | null } = { settle: null };
    const { controller, ensureUp } = harness({
      probe: () => new Promise<boolean>((resolve) => {
        pending.settle = resolve;
      }),
    });
    const tabId = await controller.openPluginTab("showroom");
    await vi.advanceTimersByTimeAsync(0);
    const sessionId = panelId(controller);
    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS);

    await controller.closePane(tabId!, sessionId);
    pending.settle?.(false);
    await vi.advanceTimersByTimeAsync(0);

    // A fresh panel asks the plugin again rather than inheriting that answer.
    await controller.openPluginTab("showroom");
    await vi.advanceTimersByTimeAsync(0);
    expect(ensureUp).toHaveBeenCalledTimes(2);
    expect(panelState(controller).pluginHealth).toBe("up");
  });

  it("polls only for panes in THIS window", async () => {
    // Every window builds its own controller from the same blob. A
    // layout-wide answer would have three windows polling one pane's plugin,
    // three times a quarter minute, and three iframes' worth of state for a
    // panel only one of them shows.
    const { probe } = harness({
      initial: layoutWithPanelInMain(),
      windowId: "aux-1",
      bindings: { [String(PLUGIN_PANE_MIN_ID)]: { pluginId: "showroom" } },
    });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS * 4);

    expect(probe).not.toHaveBeenCalled();
  });

  it("MAIN polls a panel that lives in another window", async () => {
    // The counterpart of the rule above, and the reason it is not simply
    // "poll your own slot". Main is the only window allowed to START a plugin
    // (spec §3), so main's runtime cache is what every later open trusts. Tear
    // a Showroom tab into a window and kill the plugin, and a main that polled
    // only its own rail would keep saying "up" for ever — with nothing on
    // screen here to correct it.
    const { controller, probe } = harness({
      initial: layoutWithPanelInAux(),
      bindings: { [String(PLUGIN_PANE_MIN_ID)]: { pluginId: "showroom" } },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().paneStates[PLUGIN_PANE_MIN_ID]?.pluginHealth)
      .toBe("up");

    probe.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS);

    expect(probe).toHaveBeenCalledWith("showroom", "http://127.0.0.1:7345");
    // Main's cache is corrected, so the down card is what a pane here shows
    // instead of an iframe pointed at a port nothing is listening on.
    expect(controller.getSnapshot().paneStates[PLUGIN_PANE_MIN_ID]?.pluginHealth)
      .toBe("down");
  });

  it("an AUX window's down pane heals once the plugin is back", async () => {
    // The poll is one-way on MAIN for a good reason: re-probing something
    // believed dead could only be acted on by starting it, which would
    // resurrect a plugin the user just killed. An aux window cannot start
    // anything, so there the same rule only stops it noticing good news — and
    // the card it is stuck on names a remedy (Relaunch in the main window)
    // that it then ignores when the user performs it.
    const { controller, observeOnce } = harness({
      initial: layoutWithPanelInAux(),
      windowId: "aux-1",
      bindings: { [String(PLUGIN_PANE_MIN_ID)]: { pluginId: "showroom" } },
      ensureUp: async () => ({
        ok: false,
        reason: "The plugin is not running. Relaunch it from the main window.",
        stderrTail: "",
      }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().paneStates[PLUGIN_PANE_MIN_ID]?.pluginHealth)
      .toBe("down");

    // Somebody else (main, answering a Relaunch) started it.
    observeOnce.mockResolvedValue(runtimeUp());
    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS);

    expect(controller.getSnapshot().paneStates[PLUGIN_PANE_MIN_ID])
      .toMatchObject({ pluginHealth: "up", pluginUrl: "http://127.0.0.1:7345" });
  });

  it("MAIN never re-asks about a plugin it believes is dead", async () => {
    // The other half of the same rule. Main is the window that can spawn, so a
    // re-look here is the first step towards resurrecting a plugin the user
    // killed on purpose — and the offline card would become unreachable.
    const { controller, observeOnce } = harness({
      ensureUp: async () => ({
        ok: false,
        reason: "health probe never passed",
        stderrTail: "",
      }),
    });
    await controller.openPluginTab("showroom");
    await vi.advanceTimersByTimeAsync(0);
    expect(panelState(controller).pluginHealth).toBe("down");

    await vi.advanceTimersByTimeAsync(PLUGIN_HEALTH_INTERVAL_MS * 4);

    expect(observeOnce).not.toHaveBeenCalled();
    expect(panelState(controller).pluginHealth).toBe("down");
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

/**
 * Teardown. A window is destroyed the moment it flushes, so everything the
 * controller armed has to be given back: timers that would wake a dead
 * controller, and work still in flight that would act on its behalf.
 */
describe("teardown", () => {
  it("gives back every health poller", async () => {
    // Counted rather than described: `pollPluginHealth` returns early once
    // disposed, so a test that only watched `probe` would stay green with the
    // interval still armed and firing for the life of the process.
    const { controller } = harness();
    await controller.openPluginTab("showroom");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    controller.dispose();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets no ensure-up publish after the window is gone", async () => {
    // The answer arrives on a promise nothing can cancel, so the guard has to
    // be on the receiving side.
    const pending: { release: ((result: EnsureUpResult) => void) | null } =
      { release: null };
    const { controller } = harness({
      ensureUp: () => new Promise<EnsureUpResult>((resolve) => {
        pending.release = resolve;
      }),
    });
    await controller.openPluginTab("showroom");
    await vi.advanceTimersByTimeAsync(0);

    controller.dispose();
    // Subscribed AFTER teardown on purpose: `dispose` empties the listener
    // set, so a listener added before it counts zero however loudly a dead
    // controller publishes.
    let published = 0;
    controller.subscribe(() => {
      published += 1;
    });
    pending.release?.(runtimeUp());
    await vi.advanceTimersByTimeAsync(0);

    expect(published).toBe(0);
    expect(panelState(controller).pluginHealth).toBe("starting");
  });

  it("starts nothing for a binding that changes after the window is gone", async () => {
    // The bindings store OUTLIVES this controller: it is main's map, shared
    // with every window. A subscription left behind would start a plugin on
    // behalf of a window that no longer exists.
    const { controller, ensureUp, pluginPanes } = harness({
      initial: layoutWithPanelInMain(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ensureUp).not.toHaveBeenCalled();

    controller.dispose();
    pluginPanes.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom" });
    await vi.advanceTimersByTimeAsync(0);

    expect(ensureUp).not.toHaveBeenCalled();
  });
});
