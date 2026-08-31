import { describe, expect, it, vi } from "vitest";
import type { JsonValue, SessionInfo } from "../../host/protocol";
import { emptyLayout, serializeLayout, type Layout } from "../../state/layout";
import type {
  SessionAttachment,
  SessionAttachmentCallbacks,
} from "../../host/client";
import {
  bootstrapWorkspace,
  type BootstrapWorkspaceClient,
} from "../bootstrapWorkspace";
import type { AppFileName, AppFileStore } from "../../native/appFiles";
import { PLUGIN_PANE_MIN_ID } from "../../plugins/paneBindings";
import {
  BUS_READY_TIMEOUT_MS,
  LAYOUT_MUTATION_EVENT,
  LAYOUT_STATE_EVENT,
  PLUGIN_PANES_EVENT,
  PLUGIN_PANES_MUTATION_EVENT,
  loopbackBus,
  tauriWindowBus,
  type LayoutMutation,
  type PluginPanesMutation,
  type WindowBus,
} from "../windowBus";

describe("loopbackBus", () => {
  it("delivers mutations and layouts to their own subscribers only", () => {
    const bus = loopbackBus();
    const mutations: LayoutMutation[] = [];
    const layouts: JsonValue[] = [];
    bus.onMutation((mutation) => mutations.push(mutation));
    bus.onLayout((layout) => layouts.push(layout));

    bus.forwardMutation({ kind: "setLayout", layout: { a: 1 } });
    bus.broadcastLayout({ b: 2 });

    expect(mutations).toEqual([{ kind: "setLayout", layout: { a: 1 } }]);
    expect(layouts).toEqual([{ b: 2 }]);
  });

  it("delivers plugin-pane bindings on their own channel", () => {
    const bus = loopbackBus();
    const layouts: JsonValue[] = [];
    const bindings: JsonValue[] = [];
    bus.onLayout((layout) => layouts.push(layout));
    const stop = bus.onPluginPanes((state) => bindings.push(state));

    bus.broadcastPluginPanes({ "2147483648": { pluginId: "showroom" } });
    stop();
    bus.broadcastPluginPanes({});

    expect(bindings).toEqual([{ "2147483648": { pluginId: "showroom" } }]);
    expect(layouts).toEqual([]);
  });

  it("delivers forwarded binding mutations on their own channel", () => {
    const bus = loopbackBus();
    const mutations: PluginPanesMutation[] = [];
    const bindings: JsonValue[] = [];
    bus.onPluginPanes((state) => bindings.push(state));
    const stop = bus.onPluginPanesMutation((mutation) => mutations.push(mutation));

    bus.forwardPluginPanes({ kind: "pluginPanes", op: "sync" });
    stop();
    bus.forwardPluginPanes({ kind: "pluginPanes", op: "unbind", sessionIds: [1] });

    expect(mutations).toEqual([{ kind: "pluginPanes", op: "sync" }]);
    expect(bindings).toEqual([]);
  });

  it("unsubscribes cleanly and survives a throwing subscriber", () => {
    const bus = loopbackBus();
    const seen: JsonValue[] = [];
    bus.onLayout(() => {
      throw new Error("bad subscriber");
    });
    const stop = bus.onLayout((layout) => seen.push(layout));
    bus.broadcastLayout({ n: 1 });
    stop();
    bus.broadcastLayout({ n: 2 });
    expect(seen).toEqual([{ n: 1 }]);
  });
});

describe("tauriWindowBus", () => {
  function fakeTransport() {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    /// Every native registration this transport handed out, and whether the
    /// bus ever gave it back.
    const registrations: Array<{ event: string; released: boolean }> = [];
    return {
      emitted,
      listeners,
      registrations,
      transport: {
        emit: vi.fn(async (event: string, payload: unknown) => {
          emitted.push({ event, payload });
          listeners.get(event)?.({ payload });
        }),
        listen: vi.fn(
          async (
            event: string,
            handler: (event: { payload: unknown }) => void,
          ) => {
            listeners.set(event, handler);
            const registration = { event, released: false };
            registrations.push(registration);
            return () => {
              registration.released = true;
              listeners.delete(event);
            };
          },
        ),
      },
    };
  }

  it("sends on the layout channels and delivers received payloads", async () => {
    const { transport, emitted } = fakeTransport();
    const bus = tauriWindowBus(transport);
    const mutations: LayoutMutation[] = [];
    const layouts: JsonValue[] = [];
    bus.onMutation((mutation) => mutations.push(mutation));
    bus.onLayout((layout) => layouts.push(layout));
    await Promise.resolve(); // let the async listen() registrations land

    bus.forwardMutation({ kind: "setLayout", layout: { a: 1 } });
    bus.broadcastLayout({ b: 2 });
    await Promise.resolve();

    expect(emitted.map((entry) => entry.event)).toEqual([
      LAYOUT_MUTATION_EVENT,
      LAYOUT_STATE_EVENT,
    ]);
    expect(mutations).toEqual([{ kind: "setLayout", layout: { a: 1 } }]);
    expect(layouts).toEqual([{ b: 2 }]);
  });

  it("ignores payloads that are not layout mutations", async () => {
    const { transport, listeners } = fakeTransport();
    const bus = tauriWindowBus(transport);
    const mutations: LayoutMutation[] = [];
    bus.onMutation((mutation) => mutations.push(mutation));
    await Promise.resolve();

    listeners.get(LAYOUT_MUTATION_EVENT)?.({ payload: "garbage" });
    listeners.get(LAYOUT_MUTATION_EVENT)?.({ payload: { kind: "other" } });
    expect(mutations).toEqual([]);
  });

  it("sends plugin-pane bindings on their own event and drops junk payloads", async () => {
    const { transport, emitted, listeners } = fakeTransport();
    const bus = tauriWindowBus(transport);
    const bindings: JsonValue[] = [];
    bus.onPluginPanes((state) => bindings.push(state));
    await Promise.resolve();

    bus.broadcastPluginPanes({ "2147483648": { pluginId: "showroom" } });
    await Promise.resolve();
    listeners.get(PLUGIN_PANES_EVENT)?.({ payload: "garbage" });
    listeners.get(PLUGIN_PANES_EVENT)?.({ payload: [1, 2] });
    listeners.get(PLUGIN_PANES_EVENT)?.({ payload: null });

    expect(emitted.map((entry) => entry.event)).toEqual([PLUGIN_PANES_EVENT]);
    expect(bindings).toEqual([{ "2147483648": { pluginId: "showroom" } }]);
  });

  it("hands the native subscription back when its last subscriber goes", async () => {
    // A webview outlives its workspace: reconnects and remounts build a new
    // one in the same page. The unlisten Tauri returns is the ONLY way to take
    // a native registration off that window, so dropping it leaves every dead
    // workspace still receiving — and re-dispatching — every layout broadcast
    // for the life of the process.
    const { transport, registrations } = fakeTransport();
    const bus = tauriWindowBus(transport);

    const stopFirst = bus.onMutation(() => undefined);
    const stopSecond = bus.onMutation(() => undefined);
    await Promise.resolve();
    expect(registrations).toHaveLength(1);

    stopFirst();
    // One subscriber left: the registration is still doing work.
    expect(registrations[0]?.released).toBe(false);
    stopSecond();

    expect(registrations[0]?.released).toBe(true);
  });

  it("listens again after the channel was released", async () => {
    // Releasing must not leave the channel deaf: a later workspace in the same
    // webview subscribes to the same event and has to hear it.
    const { transport, registrations, listeners } = fakeTransport();
    const bus = tauriWindowBus(transport);

    bus.onMutation(() => undefined)();
    await Promise.resolve();
    const seen: LayoutMutation[] = [];
    bus.onMutation((mutation) => seen.push(mutation));
    await Promise.resolve();

    expect(registrations.length).toBeGreaterThanOrEqual(1);
    listeners.get(LAYOUT_MUTATION_EVENT)?.({
      payload: { kind: "setLayout", layout: { tabs: {} } },
    });
    expect(seen).toHaveLength(1);
  });

  it("ready() waits for the transport's listen registration", async () => {
    // The boot race an aux window's sync request has to survive: until listen()
    // resolves, this window receives nothing.
    let letListenLand: (() => void) | undefined;
    const transport = {
      emit: vi.fn(async () => undefined),
      listen: vi.fn(
        () =>
          new Promise<() => void>((resolve) => {
            letListenLand = () => resolve(() => undefined);
          }),
      ),
    };
    const bus = tauriWindowBus(transport);

    // Nothing subscribed yet: there is nothing to wait for.
    await expect(bus.ready()).resolves.toBeUndefined();

    bus.onPluginPanes(() => undefined);
    let settled = false;
    const ready = bus.ready().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    letListenLand?.();
    await ready;
    expect(settled).toBe(true);
  });

  it("ready() gives up after the timeout instead of hanging the window", async () => {
    // A listen() that never settles must not wedge a booting window with no
    // UI and no error path — the caller's own fallback carries it.
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const transport = {
        emit: vi.fn(async () => undefined),
        listen: vi.fn(() => new Promise<() => void>(() => undefined)),
      };
      const bus = tauriWindowBus(transport);
      bus.onPluginPanes(() => undefined);

      let settled = false;
      const ready = bus.ready().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(BUS_READY_TIMEOUT_MS - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await ready;
      expect(settled).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("carries forwarded binding mutations and validates them field by field", async () => {
    const { transport, emitted, listeners } = fakeTransport();
    const bus = tauriWindowBus(transport);
    const seen: PluginPanesMutation[] = [];
    bus.onPluginPanesMutation((mutation) => seen.push(mutation));
    await Promise.resolve();

    bus.forwardPluginPanes({
      kind: "pluginPanes",
      op: "bind",
      sessionId: 2147483648,
      pluginId: "showroom",
      path: "/",
    });
    bus.forwardPluginPanes({ kind: "pluginPanes", op: "sync" });
    await Promise.resolve();
    // Junk from a hostile or mismatched build must never reach the store.
    const deliver = listeners.get(PLUGIN_PANES_MUTATION_EVENT);
    deliver?.({ payload: "garbage" });
    deliver?.({ payload: { kind: "setLayout", layout: {} } });
    deliver?.({ payload: { kind: "pluginPanes", op: "nope" } });
    deliver?.({ payload: { kind: "pluginPanes", op: "bind", sessionId: 1.5, pluginId: "x" } });
    deliver?.({ payload: { kind: "pluginPanes", op: "bind", sessionId: 7 } });
    // An id the registry could never hold, on the op that main WRITES TO DISK.
    deliver?.({
      payload: { kind: "pluginPanes", op: "bind", sessionId: 7, pluginId: "Showroom" },
    });
    deliver?.({ payload: { kind: "pluginPanes", op: "unbind", sessionIds: "all" } });
    // A partly-junk id list keeps the ids that are real.
    deliver?.({
      payload: { kind: "pluginPanes", op: "unbind", sessionIds: [7, "x", null] },
    });

    expect(emitted.map((entry) => entry.event)).toEqual([
      PLUGIN_PANES_MUTATION_EVENT,
      PLUGIN_PANES_MUTATION_EVENT,
    ]);
    expect(seen).toEqual([
      {
        kind: "pluginPanes",
        op: "bind",
        sessionId: 2147483648,
        pluginId: "showroom",
        path: "/",
      },
      { kind: "pluginPanes", op: "sync" },
      { kind: "pluginPanes", op: "unbind", sessionIds: [7] },
    ]);
  });

  it("carries a Relaunch request and drops an id the registry could never hold", async () => {
    // The op that makes an aux window's Relaunch work at all. Every other test
    // of it runs over `loopbackBus`, which hands objects through UNPARSED — so
    // without this the parse branch could be deleted, the suite would stay
    // green, and Relaunch would be dead in the shipped app.
    const { transport, emitted, listeners } = fakeTransport();
    const bus = tauriWindowBus(transport);
    const seen: PluginPanesMutation[] = [];
    bus.onPluginPanesMutation((mutation) => seen.push(mutation));
    await Promise.resolve();

    bus.forwardPluginPanes({
      kind: "pluginPanes",
      op: "ensure",
      pluginId: "showroom",
    });
    await Promise.resolve();
    const deliver = listeners.get(PLUGIN_PANES_MUTATION_EVENT);
    // A spawn request is the most privileged thing that crosses this bus, so
    // the id is held to the registry's rule rather than "is a string".
    deliver?.({ payload: { kind: "pluginPanes", op: "ensure", pluginId: "Showroom" } });
    deliver?.({ payload: { kind: "pluginPanes", op: "ensure", pluginId: "" } });
    deliver?.({ payload: { kind: "pluginPanes", op: "ensure", pluginId: 7 } });
    deliver?.({ payload: { kind: "pluginPanes", op: "ensure" } });

    expect(emitted.map((entry) => entry.event)).toEqual([
      PLUGIN_PANES_MUTATION_EVENT,
    ]);
    expect(seen).toEqual([
      { kind: "pluginPanes", op: "ensure", pluginId: "showroom" },
    ]);
  });
});

/// Main slot: tab-1 (session 1). aux-1 slot: tab-2 (session 2).
/// `pluginPane` adds tab-3 in the MAIN slot holding a reserved plugin pane, so
/// a seeded binding is not an orphan that boot would prune away.
function tornLayout(pluginPane = false): Layout {
  const layout = emptyLayout();
  layout.tabs["tab-1"] = {
    id: "tab-1",
    title: null,
    color: "blue",
    fill: "off",
    split: { kind: "pane", sessionId: 1 },
  };
  layout.tabs["tab-2"] = {
    id: "tab-2",
    title: null,
    color: "green",
    fill: "off",
    split: { kind: "pane", sessionId: 2 },
  };
  layout.rootItems = [{ kind: "tab", id: "tab-1" }];
  if (pluginPane) {
    layout.tabs["tab-3"] = {
      id: "tab-3",
      title: null,
      color: "magenta",
      fill: "off",
      split: { kind: "pane", sessionId: PLUGIN_PANE_MIN_ID },
    };
    layout.rootItems.push({ kind: "tab", id: "tab-3" });
  }
  layout.activeTabId = "tab-1";
  layout.auxWindows["aux-1"] = {
    rootItems: [{ kind: "tab", id: "tab-2" }],
    activeTabId: "tab-2",
    bounds: null,
  };
  return layout;
}

/// The tear-out: the same torn layout, but the plugin pane is in the AUX
/// window's rail rather than main's.
function panelTornOut(): Layout {
  const layout = tornLayout(true);
  layout.rootItems = layout.rootItems.filter(
    (item) => !(item.kind === "tab" && item.id === "tab-3"),
  );
  layout.auxWindows["aux-1"] = {
    rootItems: [{ kind: "tab", id: "tab-2" }, { kind: "tab", id: "tab-3" }],
    activeTabId: "tab-3",
    bounds: null,
  };
  return layout;
}

/// A plugin native whose runtime file can be taken away mid-test — the user
/// killing `node server/showroom.js` — and comes back when something spawns.
function killablePlugin(state: { alive: boolean } = { alive: true }) {
  const spawn = vi.fn(async (): Promise<number> => {
    state.alive = true;
    return 4242;
  });
  const native = {
    readRuntime: async () =>
      (state.alive
        ? JSON.stringify({ port: 7788, token: "t", version: "1.0.0" })
        : null),
    probe: async () => {
      if (!state.alive) {
        throw new Error("connection refused");
      }
      return JSON.stringify({ ok: true, version: "1.0.0" });
    },
    spawn,
    stderrTail: async () => "",
    readManifest: async () => null,
  };
  return { native, spawn, state };
}

const SHOWROOM_REGISTRY = JSON.stringify({
  version: 1,
  plugins: { showroom: { path: "C:\\code\\showroom", enabled: true } },
});

const PANEL_BINDING = JSON.stringify({
  version: 1,
  panes: { [String(PLUGIN_PANE_MIN_ID)]: { pluginId: "showroom" } },
});

function session(id: number): SessionInfo {
  return {
    id,
    profile: "powershell",
    cwd: `C:\\work\\${id}`,
    cols: 120,
    rows: 30,
    alive: true,
    pid: 9000 + id,
  };
}

function fakeClient(layout: Layout) {
  const setLayout = vi.fn(async (_layout: JsonValue) => undefined);
  const client: BootstrapWorkspaceClient = {
    createSession: vi.fn(async () => session(99)),
    closeSession: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({
      layout: serializeLayout(layout),
      sessions: [session(1), session(2)],
    })),
    setLayout,
    attach: vi.fn(async (
      sessionId: number,
      _callbacks: SessionAttachmentCallbacks = {},
    ) => ({
      sessionId,
      nextOffset: 0n,
      sendInput: vi.fn(),
      resize: vi.fn(),
      detach: vi.fn(),
    } satisfies SessionAttachment)),
    onSessionExited: () => () => undefined,
    onSessionClosed: () => () => undefined,
    onError: () => () => undefined,
    close: vi.fn(),
  };
  return { client, setLayout };
}

/// In-memory app-data files, one set per window: the bindings file is
/// main-owned, so the test needs to see WHICH window wrote it.
function fakeAppFiles(seed: Partial<Record<AppFileName, string>> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const write = vi.fn(async (name: AppFileName, contents: string) => {
    files.set(name, contents);
  });
  const store: AppFileStore = {
    read: async (name) => files.get(name) ?? null,
    write,
  };
  return { store, files, write };
}

describe("single-writer wiring over the bus", () => {
  async function pair(
    options: {
      seed?: Partial<Record<AppFileName, string>>;
      pluginPane?: boolean;
    } = {},
  ) {
    const seed = options.seed ?? {};
    const bus = loopbackBus();
    const mainFake = fakeClient(tornLayout(options.pluginPane));
    const auxFake = fakeClient(tornLayout(options.pluginPane));
    const mainFiles = fakeAppFiles(seed);
    const auxFiles = fakeAppFiles(seed);
    const main = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => mainFake.client,
      appFiles: mainFiles.store,
      windowBus: bus,
    });
    const aux = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => auxFake.client,
      appFiles: auxFiles.store,
      windowId: "aux-1",
      windowBus: bus,
    });
    return { bus, main, aux, mainFake, auxFake, mainFiles, auxFiles };
  }

  it("an aux mutation reaches main, which persists exactly once", async () => {
    const { main, aux, mainFake, auxFake } = await pair();

    aux.controller.renameTab("tab-2", "renamed");
    await aux.controller.flush();
    await main.controller.flush();

    expect(auxFake.setLayout).not.toHaveBeenCalled();
    expect(mainFake.setLayout).toHaveBeenCalledTimes(1);
    expect(mainFake.setLayout.mock.calls[0]?.[0]).toMatchObject({
      tabs: { "tab-2": { title: "renamed" } },
    });
    expect(main.controller.getSnapshot().layout.tabs["tab-2"]!.title).toBe(
      "renamed",
    );
  });

  it("a main broadcast reaches aux, which adopts without persisting", async () => {
    const { main, aux, mainFake, auxFake } = await pair();

    main.controller.renameTab("tab-1", "from-main");
    await main.controller.flush();

    expect(mainFake.setLayout).toHaveBeenCalledTimes(1);
    expect(auxFake.setLayout).not.toHaveBeenCalled();
    expect(aux.controller.getSnapshot().layout.tabs["tab-1"]!.title).toBe(
      "from-main",
    );
  });

  it("a malformed forwarded blob is dropped and main keeps its model", async () => {
    const { bus, main, mainFake } = await pair();
    const before = main.controller.getSnapshot().layout;

    bus.forwardMutation({ kind: "setLayout", layout: { version: 999 } });
    await main.controller.flush();

    expect(main.controller.getSnapshot().layout).toBe(before);
    expect(mainFake.setLayout).not.toHaveBeenCalled();
  });

  it("a main plugin binding is persisted once and adopted by aux", async () => {
    const { main, aux, mainFiles, auxFiles } = await pair();

    main.pluginPanes.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom" });
    await main.pluginPanes.flush();
    await aux.pluginPanes.flush();

    const expected = { "2147483648": { pluginId: "showroom" } };
    expect(main.pluginPanes.getSnapshot()).toEqual(expected);
    expect(aux.pluginPanes.getSnapshot()).toEqual(expected);
    expect(
      mainFiles.write.mock.calls.filter(
        (call) => call[0] === "plugin_panes_v1.json",
      ),
    ).toHaveLength(1);
    expect(
      auxFiles.write.mock.calls.map((call) => call[0]),
    ).not.toContain("plugin_panes_v1.json");
  });

  it("the two windows never share binding objects", async () => {
    const { main, aux } = await pair();

    main.pluginPanes.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom" });
    await main.pluginPanes.flush();

    const fromMain = main.pluginPanes.getSnapshot()["2147483648"];
    const fromAux = aux.pluginPanes.getSnapshot()["2147483648"];
    expect(fromMain).toEqual(fromAux);
    expect(fromMain).not.toBe(fromAux);
    expect(main.pluginPanes.getSnapshot()).not.toBe(aux.pluginPanes.getSnapshot());
  });

  it("an aux bind is forwarded to main, which persists it and hands it back", async () => {
    const { main, aux, mainFiles, auxFiles } = await pair();

    aux.pluginPanes.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom", path: "/" });
    await main.pluginPanes.flush();
    await aux.pluginPanes.flush();

    const expected = { "2147483648": { pluginId: "showroom", path: "/" } };
    expect(main.pluginPanes.getSnapshot()).toEqual(expected);
    // Aux holds it because main broadcast it back — not because it self-applied.
    expect(aux.pluginPanes.getSnapshot()).toEqual(expected);
    expect(
      mainFiles.write.mock.calls.filter(
        (call) => call[0] === "plugin_panes_v1.json",
      ),
    ).toHaveLength(1);
    expect(
      auxFiles.write.mock.calls.map((call) => call[0]),
    ).not.toContain("plugin_panes_v1.json");
  });

  it("an aux unbind is forwarded to main and clears both windows", async () => {
    const { main, aux, auxFiles } = await pair({
      seed: {
        "plugin_panes_v1.json": JSON.stringify({
          version: 1,
          panes: { "2147483648": { pluginId: "showroom" } },
        }),
      },
      pluginPane: true,
    });

    aux.pluginPanes.unbind([PLUGIN_PANE_MIN_ID]);
    await main.pluginPanes.flush();
    // Main announces a change only once its own write has landed, so the
    // broadcast reaches this window one turn after main's flush resolves.
    await aux.pluginPanes.flush();

    expect(main.pluginPanes.getSnapshot()).toEqual({});
    expect(aux.pluginPanes.getSnapshot()).toEqual({});
    expect(
      auxFiles.write.mock.calls.map((call) => call[0]),
    ).not.toContain("plugin_panes_v1.json");
  });

  it("both windows adopt the persisted bindings file at boot", async () => {
    const { main, aux } = await pair({
      seed: {
        "plugin_panes_v1.json": JSON.stringify({
          version: 1,
          panes: { "2147483648": { pluginId: "showroom", path: "/" } },
        }),
      },
      pluginPane: true,
    });

    const expected = { "2147483648": { pluginId: "showroom", path: "/" } };
    expect(main.pluginPanes.getSnapshot()).toEqual(expected);
    expect(aux.pluginPanes.getSnapshot()).toEqual(expected);
  });

  it("an aux window that boots late catches up from main, not from a stale file", async () => {
    // The race the sync request exists for: main binds AFTER the aux window
    // has read the file (here: after main booted, before aux booted at all).
    const bus = loopbackBus();
    const mainFake = fakeClient(tornLayout(true));
    const auxFake = fakeClient(tornLayout(true));
    const mainFiles = fakeAppFiles();
    // The aux window's disk view is stale on purpose: it never sees the write.
    const auxFiles = fakeAppFiles();
    const main = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => mainFake.client,
      appFiles: mainFiles.store,
      windowBus: bus,
    });

    main.pluginPanes.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom" });
    await main.pluginPanes.flush();

    const aux = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => auxFake.client,
      appFiles: auxFiles.store,
      windowId: "aux-1",
      windowBus: bus,
    });

    expect(aux.pluginPanes.getSnapshot()).toEqual({
      "2147483648": { pluginId: "showroom" },
    });
  });

  it("an aux window's Relaunch makes MAIN spawn the plugin", async () => {
    // Michael's flow: tear a Showroom tab into its own window, kill the
    // plugin, press Relaunch. Spawning is main's alone (spec §3), so without a
    // request over the bus that button has nothing behind it — the pane spins
    // for ten seconds and comes back to the same card telling the user to go
    // to the main window they just left.
    const bus = loopbackBus();
    const layout = panelTornOut();
    const seed = {
      "plugins_v1.json": SHOWROOM_REGISTRY,
      "plugin_panes_v1.json": PANEL_BINDING,
    } as Partial<Record<AppFileName, string>>;
    // ONE runtime file, two windows reading it: the plugin's liveness is
    // shared, only the spawn spies are per window.
    const plugin = { alive: true };
    const mainPlugin = killablePlugin(plugin);
    const auxPlugin = killablePlugin(plugin);
    const main = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fakeClient(layout).client,
      appFiles: fakeAppFiles(seed).store,
      pluginEnv: { APPDATA: "C:\\data" },
      pluginNative: mainPlugin.native,
      windowBus: bus,
    });
    const aux = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fakeClient(layout).client,
      appFiles: fakeAppFiles(seed).store,
      windowId: "aux-1",
      pluginEnv: { APPDATA: "C:\\data" },
      pluginNative: auxPlugin.native,
      windowBus: bus,
    });
    // Both windows adopted the running plugin; nobody had to start it.
    await vi.waitFor(() => {
      expect(aux.controller.getSnapshot().paneStates[PLUGIN_PANE_MIN_ID]
        ?.pluginHealth).toBe("up");
    });
    expect(mainPlugin.spawn).not.toHaveBeenCalled();

    // The user kills the plugin, then presses Relaunch in the aux window.
    plugin.alive = false;
    await aux.controller.relaunchPlugin(PLUGIN_PANE_MIN_ID);

    await vi.waitFor(() => {
      expect(mainPlugin.spawn).toHaveBeenCalledTimes(1);
    });
    // Started by MAIN, never by the window that asked.
    expect(auxPlugin.spawn).not.toHaveBeenCalled();

    main.controller.dispose();
    aux.controller.dispose();
  });

  it("a Relaunch that lands while MAIN is still booting is honoured, once", async () => {
    // Main registers this handler and awaits `bus.ready()` long before it
    // builds a controller — the manifest budget alone is 1.5 s. An aux window
    // that outlived a main remount presses Relaunch in that window and the
    // request finds `controller === null`. Dropped, nothing retries it: the
    // pane sits on a card naming a button the user just pressed.
    const bus = loopbackBus();
    const plugin = { alive: false };
    const mainPlugin = killablePlugin(plugin);
    // Delivered at the moment main subscribes, which IS the gap: the handler
    // exists, the controller does not.
    let delivered = false;
    const gapBus: WindowBus = {
      ...bus,
      onPluginPanesMutation: (handler) => {
        const stop = bus.onPluginPanesMutation(handler);
        if (!delivered) {
          delivered = true;
          // Twice: an impatient user, and one spawn is still the right answer.
          handler({ kind: "pluginPanes", op: "ensure", pluginId: "showroom" });
          handler({ kind: "pluginPanes", op: "ensure", pluginId: "showroom" });
        }
        return stop;
      },
    };

    const main = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fakeClient(tornLayout()).client,
      appFiles: fakeAppFiles({ "plugins_v1.json": SHOWROOM_REGISTRY }).store,
      pluginEnv: { APPDATA: "C:\data" },
      pluginNative: mainPlugin.native,
      windowBus: gapBus,
    });
    expect(delivered).toBe(true);

    await vi.waitFor(() => {
      expect(mainPlugin.spawn).toHaveBeenCalledTimes(1);
    });

    main.controller.dispose();
  });

  it("an aux window's close keeps the binding when MAIN's layout write fails", async () => {
    // The crash order across windows. An aux window's "persistence" is an
    // event emission: it succeeds the moment main is TOLD, which says nothing
    // about whether the daemon accepted the layout. Sweeping on that promise
    // deletes the binding while the stored layout still names the pane —
    // the next boot restores a reserved pane with no panel behind it, and the
    // identity of what the user had open is gone for good.
    const bus = loopbackBus();
    const layout = panelTornOut();
    const seed = {
      "plugins_v1.json": SHOWROOM_REGISTRY,
      "plugin_panes_v1.json": PANEL_BINDING,
    } as Partial<Record<AppFileName, string>>;
    const plugin = { alive: true };
    const mainFake = fakeClient(layout);
    const auxFake = fakeClient(layout);
    const mainFiles = fakeAppFiles(seed);
    const main = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => mainFake.client,
      appFiles: mainFiles.store,
      pluginEnv: { APPDATA: "C:\data" },
      pluginNative: killablePlugin(plugin).native,
      windowBus: bus,
    });
    const aux = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => auxFake.client,
      appFiles: fakeAppFiles(seed).store,
      windowId: "aux-1",
      pluginEnv: { APPDATA: "C:\data" },
      pluginNative: killablePlugin(plugin).native,
      windowBus: bus,
    });
    // The daemon refuses from here on: disk full, a rejected blob, a host that
    // died between the forward and the write.
    mainFake.setLayout.mockRejectedValue(new Error("the daemon refused it"));

    await aux.controller.closePane("tab-3", PLUGIN_PANE_MIN_ID);
    await aux.controller.flush();
    await main.controller.flush();

    const key = String(PLUGIN_PANE_MIN_ID);
    expect(main.pluginPanes.getSnapshot()[key]).toBeDefined();
    expect(aux.pluginPanes.getSnapshot()[key]).toBeDefined();
    expect(mainFiles.write.mock.calls.map((call) => call[0]))
      .not.toContain("plugin_panes_v1.json");

    main.controller.dispose();
    aux.controller.dispose();
  });

  it("an aux window's close DOES clear the binding once main's write lands", async () => {
    // The half that makes the failure case mean something: the aux window
    // stops unbinding, it does not stop the binding being cleaned up. Main
    // adopts the forwarded layout and sweeps against its own write — the only
    // one that reaches disk.
    const bus = loopbackBus();
    const layout = panelTornOut();
    const seed = {
      "plugins_v1.json": SHOWROOM_REGISTRY,
      "plugin_panes_v1.json": PANEL_BINDING,
    } as Partial<Record<AppFileName, string>>;
    const plugin = { alive: true };
    const mainFiles = fakeAppFiles(seed);
    const main = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fakeClient(layout).client,
      appFiles: mainFiles.store,
      pluginEnv: { APPDATA: "C:\data" },
      pluginNative: killablePlugin(plugin).native,
      windowBus: bus,
    });
    const aux = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fakeClient(layout).client,
      appFiles: fakeAppFiles(seed).store,
      windowId: "aux-1",
      pluginEnv: { APPDATA: "C:\data" },
      pluginNative: killablePlugin(plugin).native,
      windowBus: bus,
    });

    await aux.controller.closePane("tab-3", PLUGIN_PANE_MIN_ID);
    await aux.controller.flush();
    await main.controller.flush();
    await aux.pluginPanes.flush();

    expect(main.pluginPanes.getSnapshot()).toEqual({});
    expect(aux.pluginPanes.getSnapshot()).toEqual({});
    expect(mainFiles.write.mock.calls.map((call) => call[0]))
      .toContain("plugin_panes_v1.json");

    main.controller.dispose();
    aux.controller.dispose();
  });

  it("an aux boot attaches only its own slot's sessions", async () => {
    const { mainFake, auxFake } = await pair();
    // attach() calls happened during bootstrap; read them off the fakes.
    expect(vi.mocked(mainFake.client.attach).mock.calls.map((call) => call[0]))
      .toEqual([1, 2]);
    expect(vi.mocked(auxFake.client.attach).mock.calls.map((call) => call[0]))
      .toEqual([2]);
  });
});
