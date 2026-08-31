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
  LAYOUT_MUTATION_EVENT,
  LAYOUT_STATE_EVENT,
  PLUGIN_PANES_EVENT,
  loopbackBus,
  tauriWindowBus,
  type LayoutMutation,
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
    return {
      emitted,
      listeners,
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
            return () => listeners.delete(event);
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
});

/// Main slot: tab-1 (session 1). aux-1 slot: tab-2 (session 2).
function tornLayout(): Layout {
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
  layout.activeTabId = "tab-1";
  layout.auxWindows["aux-1"] = {
    rootItems: [{ kind: "tab", id: "tab-2" }],
    activeTabId: "tab-2",
    bounds: null,
  };
  return layout;
}

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
  async function pair(seed: Partial<Record<AppFileName, string>> = {}) {
    const bus = loopbackBus();
    const mainFake = fakeClient(tornLayout());
    const auxFake = fakeClient(tornLayout());
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

  it("an aux window never writes the bindings file, whatever it is told to bind", async () => {
    const { main, aux, auxFiles } = await pair();

    aux.pluginPanes.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom" });
    await aux.pluginPanes.flush();

    expect(
      auxFiles.write.mock.calls.map((call) => call[0]),
    ).not.toContain("plugin_panes_v1.json");
    // Aux is a read-only replica: its local bind never reaches main.
    expect(main.pluginPanes.getSnapshot()).toEqual({});
  });

  it("both windows adopt the persisted bindings file at boot", async () => {
    const { main, aux } = await pair({
      "plugin_panes_v1.json": JSON.stringify({
        version: 1,
        panes: { "2147483648": { pluginId: "showroom", path: "/" } },
      }),
    });

    const expected = { "2147483648": { pluginId: "showroom", path: "/" } };
    expect(main.pluginPanes.getSnapshot()).toEqual(expected);
    expect(aux.pluginPanes.getSnapshot()).toEqual(expected);
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
