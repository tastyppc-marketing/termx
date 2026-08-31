import { describe, expect, it, vi } from "vitest";
import type {
  HostClientConnectOptions,
  SessionAttachment,
  SessionAttachmentCallbacks,
} from "../../host/client";
import type { JsonValue, SessionInfo } from "../../host/protocol";
import type { AppFileStore } from "../../native/appFiles";
import { PLUGIN_PANE_MIN_ID, parsePluginPanes } from "../../plugins/paneBindings";
import { emptyLayout, serializeLayout } from "../../state/layout";
import {
  bootstrapWorkspace,
  parseBootstrapHostResult,
  type BootstrapWorkspaceClient,
} from "../bootstrapWorkspace";

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

function fakeClient(options: {
  layout?: JsonValue;
  sessions?: SessionInfo[];
  setLayout?: (layout: JsonValue) => Promise<void>;
} = {}) {
  const attachCalls: number[] = [];
  const exitListeners = new Set<(event: { sessionId: number; exitCode: number | null }) => void>();
  const setLayout = vi.fn(options.setLayout ?? (async () => undefined));
  const close = vi.fn();
  const client: BootstrapWorkspaceClient = {
    createSession: vi.fn(async () => session(99)),
    closeSession: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({
      layout: options.layout ?? serializeLayout(emptyLayout()),
      sessions: options.sessions ?? [],
    })),
    setLayout,
    attach: vi.fn(async (
      sessionId: number,
      callbacks: SessionAttachmentCallbacks = {},
    ) => {
      attachCalls.push(sessionId);
      callbacks.onOutput?.({
        offset: 0n,
        data: new Uint8Array(0),
        source: "replay",
      });
      return {
        sessionId,
        nextOffset: 0n,
        sendInput: vi.fn(),
        resize: vi.fn(),
        detach: vi.fn(),
      } satisfies SessionAttachment;
    }),
    onSessionExited(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    onSessionClosed: () => () => undefined,
    onError: () => () => undefined,
    close,
  };
  return {
    client,
    close,
    setLayout,
    attachCalls,
    emitExit(sessionId: number, exitCode: number | null) {
      for (const listener of exitListeners) {
        listener({ sessionId, exitCode });
      }
    },
  };
}

describe("parseBootstrapHostResult", () => {
  it("accepts only a valid loopback bootstrap shape", () => {
    expect(parseBootstrapHostResult({ port: 4242, token: "secret" })).toEqual({
      port: 4242,
      token: "secret",
    });
    expect(() => parseBootstrapHostResult({ port: 0, token: "secret" })).toThrow(
      "invalid result",
    );
    expect(() => parseBootstrapHostResult({ port: 4242, token: "" })).toThrow(
      "invalid result",
    );
  });
});

describe("bootstrapWorkspace", () => {
  it("invokes native bootstrap, connects, restores, and attaches active-first sequentially", async () => {
    const state = emptyLayout();
    state.tabs.first = {
      id: "first",
      title: null,
      color: "blue",
      fill: "off",
      split: { kind: "pane", sessionId: 1 },
    };
    state.tabs.second = {
      id: "second",
      title: null,
      color: "cyan",
      fill: "off",
      split: { kind: "pane", sessionId: 2 },
    };
    state.rootItems = [{ kind: "tab", id: "first" }, { kind: "tab", id: "second" }];
    state.activeTabId = "second";
    const fake = fakeClient({ layout: serializeLayout(state), sessions: [session(1), session(2)] });
    const invokeBootstrap = vi.fn(async () => ({ port: 3210, token: "token-value" }));
    const connect = vi.fn(async (_options: HostClientConnectOptions) => fake.client);

    const workspace = await bootstrapWorkspace({ invokeBootstrap, connect });

    expect(invokeBootstrap).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({ port: 3210, token: "token-value" });
    expect(fake.attachCalls).toEqual([2, 1]);
    expect(workspace.controller.getSnapshot().activeSessionId).toBe(2);
    expect(fake.setLayout).not.toHaveBeenCalled();
  });

  it("observes session exits that occur during sequential startup attachment", async () => {
    const state = emptyLayout();
    state.tabs.first = {
      id: "first",
      title: null,
      color: "blue",
      fill: "off",
      split: { kind: "pane", sessionId: 1 },
    };
    state.tabs.second = {
      id: "second",
      title: null,
      color: "cyan",
      fill: "off",
      split: { kind: "pane", sessionId: 2 },
    };
    state.rootItems = [{ kind: "tab", id: "first" }, { kind: "tab", id: "second" }];
    state.activeTabId = "second";
    const fake = fakeClient({ layout: serializeLayout(state), sessions: [session(1), session(2)] });
    vi.mocked(fake.client.attach).mockImplementation(async (sessionId) => {
      if (sessionId === 2) {
        fake.emitExit(1, 7);
      }
      return {
        sessionId,
        nextOffset: 0n,
        sendInput: vi.fn(),
        resize: vi.fn(),
        detach: vi.fn(),
      } satisfies SessionAttachment;
    });

    const workspace = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
    });

    expect(workspace.controller.getSnapshot().ungroupedTabs[0]).toMatchObject({
      id: "first",
      status: "dead",
    });
  });

  it("does not overwrite a malformed restored layout before user mutation", async () => {
    const fake = fakeClient({
      layout: { version: 999 },
      sessions: [session(4)],
    });

    const workspace = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      generateId: () => "adopted",
    });

    expect(workspace.controller.getSnapshot().layout.rootItems)
      .toEqual([{ kind: "tab", id: "adopted" }]);
    expect(fake.setLayout).not.toHaveBeenCalled();
  });

  it("persists orphan adoption once when the restored layout is valid", async () => {
    const fake = fakeClient({
      layout: serializeLayout(emptyLayout()),
      sessions: [session(5)],
    });

    await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      generateId: () => "orphan",
    });

    expect(fake.setLayout).toHaveBeenCalledTimes(1);
    expect(fake.setLayout.mock.calls[0]?.[0]).toMatchObject({
      version: 3,
      rootItems: [{ kind: "tab", id: "orphan" }],
    });
  });

  it("restores plugin pane bindings and persists new ones to their own file", async () => {
    // The bound pane must be IN the layout, or boot prunes it as an orphan.
    const state = emptyLayout();
    state.tabs.panel = {
      id: "panel",
      title: null,
      color: "magenta",
      fill: "off",
      split: { kind: "pane", sessionId: PLUGIN_PANE_MIN_ID },
    };
    state.rootItems = [{ kind: "tab", id: "panel" }];
    state.activeTabId = "panel";
    const fake = fakeClient({ layout: serializeLayout(state) });
    const seed: Record<string, string> = {
      "plugin_panes_v1.json": JSON.stringify({
        version: 1,
        panes: { "2147483648": { pluginId: "showroom" } },
      }),
    };
    const writes: Array<[string, string]> = [];
    const appFiles: AppFileStore = {
      read: async (name) => seed[name] ?? null,
      write: async (name, contents) => {
        writes.push([name, contents]);
      },
    };

    const workspace = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      appFiles,
    });
    expect(workspace.pluginPanes.getSnapshot()).toEqual({
      "2147483648": { pluginId: "showroom" },
    });

    workspace.pluginPanes.bind(PLUGIN_PANE_MIN_ID + 1, { pluginId: "showroom" });
    await workspace.pluginPanes.flush();

    const written = writes.filter(([name]) => name === "plugin_panes_v1.json");
    expect(written).toHaveLength(1);
    expect(parsePluginPanes(written[0]![1])).toEqual({
      "2147483648": { pluginId: "showroom" },
      "2147483649": { pluginId: "showroom" },
    });
  });

  it("prunes bindings whose pane is not in the restored layout", async () => {
    // The crash order this exists for: `bind` writes the bindings file
    // immediately, so a crash before the layout write leaves a binding whose
    // pane never made it into the blob.
    const fake = fakeClient({ layout: serializeLayout(emptyLayout()) });
    const seed: Record<string, string> = {
      "plugin_panes_v1.json": JSON.stringify({
        version: 1,
        panes: { "2147483648": { pluginId: "showroom" } },
      }),
    };
    const writes: Array<[string, string]> = [];
    const appFiles: AppFileStore = {
      read: async (name) => seed[name] ?? null,
      write: async (name, contents) => {
        writes.push([name, contents]);
      },
    };

    const workspace = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      appFiles,
    });
    await workspace.pluginPanes.flush();

    expect(workspace.pluginPanes.getSnapshot()).toEqual({});
    const written = writes.filter(([name]) => name === "plugin_panes_v1.json");
    expect(written).toHaveLength(1);
    expect(parsePluginPanes(written[0]![1])).toEqual({});
  });

  it("keeps bindings when the restored layout could not be parsed", async () => {
    // A malformed blob is not evidence that the panes are gone — pruning
    // against the empty fallback layout would delete every binding the user
    // has, and the next good boot could not bring them back.
    const fake = fakeClient({ layout: { version: 999 } });
    const seed: Record<string, string> = {
      "plugin_panes_v1.json": JSON.stringify({
        version: 1,
        panes: { "2147483648": { pluginId: "showroom" } },
      }),
    };
    const writes: Array<[string, string]> = [];
    const appFiles: AppFileStore = {
      read: async (name) => seed[name] ?? null,
      write: async (name, contents) => {
        writes.push([name, contents]);
      },
    };

    const workspace = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      appFiles,
    });
    await workspace.pluginPanes.flush();

    expect(workspace.pluginPanes.getSnapshot()).toEqual({
      "2147483648": { pluginId: "showroom" },
    });
    expect(writes.map(([name]) => name)).not.toContain("plugin_panes_v1.json");
  });

  it("boots with empty bindings when the bindings file is corrupt or unreadable", async () => {
    const fake = fakeClient();
    const appFiles: AppFileStore = {
      read: async (name) => {
        if (name === "plugin_panes_v1.json") {
          throw new Error("storage command unavailable");
        }
        return null;
      },
      write: async () => undefined,
    };

    const workspace = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      appFiles,
    });

    expect(workspace.pluginPanes.getSnapshot()).toEqual({});
  });

  it("closes a connected client and returns a bounded error on later failure", async () => {
    const fake = fakeClient();
    fake.client.getState = vi.fn(async () => {
      throw new Error("token-value must not escape");
    });

    await expect(bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token-value" }),
      connect: async () => fake.client,
    })).rejects.toThrow("Unable to start the TermX workspace.");
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});

describe("bootstrapWorkspace plugin panes", () => {
  /// A restored layout whose only tab holds a reserved plugin pane.
  function panelLayout(): JsonValue {
    const state = emptyLayout();
    state.tabs.panel = {
      id: "panel",
      title: "Showroom",
      color: "magenta",
      fill: "off",
      split: { kind: "pane", sessionId: PLUGIN_PANE_MIN_ID },
    };
    state.rootItems = [{ kind: "tab", id: "panel" }];
    state.activeTabId = "panel";
    return serializeLayout(state);
  }

  function files(seed: Record<string, string>) {
    const writes: Array<[string, string]> = [];
    const appFiles: AppFileStore = {
      read: async (name) => seed[name] ?? null,
      write: async (name, contents) => {
        writes.push([name, contents]);
      },
    };
    return { appFiles, writes };
  }

  it("boots a bound reserved pane as a plugin pane, not a corpse", async () => {
    // Two things at once: reconcile was told the id is live by design (or the
    // dead sweep would claim it), and the controller was handed the bindings
    // store (or it could not tell a panel from a forgotten session).
    const fake = fakeClient({ layout: panelLayout() });
    const { appFiles } = files({
      "plugin_panes_v1.json": JSON.stringify({
        version: 1,
        panes: { "2147483648": { pluginId: "showroom" } },
      }),
      "plugins_v1.json": JSON.stringify({
        plugins: { showroom: { path: "C:\\code\\showroom", enabled: true, grants: [] } },
      }),
    });

    const workspace = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      appFiles,
    });

    expect(workspace.controller.getSnapshot().paneStates[PLUGIN_PANE_MIN_ID])
      .toMatchObject({ status: "plugin", pluginId: "showroom" });
    // A plugin pane costs the workspace no layout rewrite at boot.
    expect(fake.setLayout).not.toHaveBeenCalled();
  });

  it("boots an unbound reserved pane as a dismissible dead pane", async () => {
    // The downgrade path: an old build wrote this layout, or the bindings file
    // was lost. Degraded and visible, never a ghost.
    const fake = fakeClient({ layout: panelLayout() });
    const { appFiles } = files({});

    const workspace = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      appFiles,
    });

    expect(workspace.controller.getSnapshot().paneStates[PLUGIN_PANE_MIN_ID])
      .toEqual({ status: "missing", exitCode: null });
  });

  it("exposes the plugin registry it loaded", async () => {
    const fake = fakeClient();
    const { appFiles } = files({
      "plugins_v1.json": JSON.stringify({
        plugins: { showroom: { path: "C:\\code\\showroom", enabled: true, grants: [] } },
      }),
    });

    const workspace = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      appFiles,
    });

    expect(workspace.plugins.getSnapshot().plugins.showroom).toEqual({
      path: "C:\\code\\showroom",
      enabled: true,
      grants: [],
    });
  });

  it("expands %VAR% in a manifest discovery path before reading it", async () => {
    // Showroom's manifest points at `%APPDATA%\Showroom\runtime.json`. Left
    // unexpanded that read can never succeed, so the panel would report down
    // forever however healthy the plugin actually is.
    const fake = fakeClient({ layout: serializeLayout(emptyLayout()) });
    const { appFiles } = files({
      "plugins_v1.json": JSON.stringify({
        plugins: { showroom: { path: "C:\\code\\showroom", enabled: true, grants: [] } },
      }),
    });
    const runtimeReads: string[] = [];

    const workspace = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      appFiles,
      generateId: () => "panel-tab",
      pluginEnv: { APPDATA: "C:\\data" },
      pluginNative: {
        readRuntime: async (path) => {
          runtimeReads.push(path);
          return null;
        },
        probe: async () => "",
        spawn: async () => {
          throw new Error("spawn refused");
        },
        stderrTail: async () => "",
      },
    });

    await workspace.controller.openPluginTab("showroom");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtimeReads).toEqual(["C:\\data\\Showroom\\runtime.json"]);
  });

  it("persists a new binding BEFORE the layout that references it", async () => {
    // End to end through the real store and the real persistence: a crash
    // between these two writes must leave a binding with no pane (pruned at the
    // next boot), never a pane with no binding (a dead panel forever).
    const order: string[] = [];
    const fake = fakeClient({
      layout: serializeLayout(emptyLayout()),
      setLayout: async () => {
        order.push("layout");
      },
    });
    const appFiles: AppFileStore = {
      read: async (name) => (name === "plugins_v1.json"
        ? JSON.stringify({
            plugins: { showroom: { path: "C:\\code\\showroom", enabled: true, grants: [] } },
          })
        : null),
      write: async (name) => {
        if (name === "plugin_panes_v1.json") {
          order.push("bindings");
        }
      },
    };

    const workspace = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      appFiles,
      generateId: () => "panel-tab",
      // Nothing may reach the real Tauri commands from a unit test.
      pluginNative: {
        readRuntime: async () => null,
        probe: async () => "",
        spawn: async () => {
          throw new Error("spawn refused");
        },
        stderrTail: async () => "",
      },
    });

    const tabId = await workspace.controller.openPluginTab("showroom");
    await workspace.controller.flush();
    // Ensure-up is fire-and-forget by design (the tab appears immediately);
    // one turn of the loop is enough for its verdict to land.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(tabId).toBe("panel-tab");
    expect(order).toEqual(["bindings", "layout"]);
    const split = workspace.controller.getSnapshot().layout.tabs["panel-tab"]?.split;
    expect(split?.kind === "pane" && split.sessionId >= PLUGIN_PANE_MIN_ID).toBe(true);
    // The spawn failed, so the pane offers Relaunch rather than an empty frame.
    expect(Object.values(workspace.controller.getSnapshot().paneStates)).toContainEqual(
      expect.objectContaining({ status: "plugin", pluginHealth: "down" }),
    );
  });
});
