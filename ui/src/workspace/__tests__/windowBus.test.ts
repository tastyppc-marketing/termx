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
import {
  LAYOUT_MUTATION_EVENT,
  LAYOUT_STATE_EVENT,
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

describe("single-writer wiring over the bus", () => {
  async function pair() {
    const bus = loopbackBus();
    const mainFake = fakeClient(tornLayout());
    const auxFake = fakeClient(tornLayout());
    const main = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => mainFake.client,
      windowBus: bus,
    });
    const aux = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => auxFake.client,
      windowId: "aux-1",
      windowBus: bus,
    });
    return { bus, main, aux, mainFake, auxFake };
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

  it("an aux boot attaches only its own slot's sessions", async () => {
    const { mainFake, auxFake } = await pair();
    // attach() calls happened during bootstrap; read them off the fakes.
    expect(vi.mocked(mainFake.client.attach).mock.calls.map((call) => call[0]))
      .toEqual([1, 2]);
    expect(vi.mocked(auxFake.client.attach).mock.calls.map((call) => call[0]))
      .toEqual([2]);
  });
});
