import { describe, expect, it, vi } from "vitest";
import type {
  HostClientConnectOptions,
  SessionAttachment,
  SessionAttachmentCallbacks,
} from "../../host/client";
import type { JsonValue, SessionInfo } from "../../host/protocol";
import type { AppFileStore } from "../../native/appFiles";
import { CAPTURES_FILE, compactCaptures } from "../../conversations/captures";
import type { LlmSessionRecord } from "../../conversations/types";
import { PLUGIN_PANE_MIN_ID, parsePluginPanes } from "../../plugins/paneBindings";
import { emptyLayout, serializeLayout } from "../../state/layout";
import { loopbackBus } from "../windowBus";
import {
  bootstrapWorkspace,
  parseBootstrapHostResult,
  PLUGIN_MANIFEST_BOOT_BUDGET_MS,
  PLUGIN_MANIFEST_REFRESH_DEBOUNCE_MS,
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
  it("saves an offline layout edit when the host reconnects", async () => {
    const fake = fakeClient();
    const replacement = fakeClient();
    const workspace = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: vi.fn().mockResolvedValueOnce(fake.client).mockResolvedValue(replacement.client),
      appFiles: { read: async () => null, write: async () => undefined },
    });
    try {
      workspace.connection!.notifySuspend();
      workspace.controller.renameWindow("main", "Offline edit");
      await workspace.controller.flush();
      expect(workspace.controller.getSnapshot().persistence.error).not.toBeNull();
      workspace.connection!.retryNow();
      await vi.waitFor(() => expect(workspace.connection!.state.phase).toBe("connected"));
      await workspace.controller.flush();
      expect(replacement.setLayout).toHaveBeenCalledWith(expect.objectContaining({
        windowNames: { main: "Offline edit" },
      }));
    } finally {
      workspace.controller.dispose();
    }
  });

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

  /**
   * The single writer arbitrates the singleton rule (review P-RV2).
   *
   * An aux window cannot see that main is already showing - or mid-open on -
   * the same singleton: its replica has no row until main has bound one AND
   * the broadcast has landed. Both windows then think nothing is open and both
   * open, and one process ends up with two panels fighting over its page.
   * Only main sees both, so only main can say no.
   */
  function pluginSeed(): Record<string, string> {
    return {
      "plugin_panes_v1.json": JSON.stringify({
        version: 1,
        panes: { "2147483648": { pluginId: "showroom" } },
      }),
      "plugins_v1.json": JSON.stringify({
        plugins: { showroom: { path: "C:\code\showroom", enabled: true, grants: [] } },
      }),
    };
  }

  it("refuses a forwarded bind that would give a singleton a second panel", async () => {
    const bus = loopbackBus();
    const refusals: number[][] = [];
    bus.onPluginPanesMutation((mutation) => {
      if (mutation.op === "rejected") {
        refusals.push(mutation.sessionIds);
      }
    });
    const fake = fakeClient({ layout: panelLayout() });
    const { appFiles } = files(pluginSeed());
    const workspace = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      appFiles,
      windowBus: bus,
    });

    await bus.forwardPluginPanes({
      kind: "pluginPanes",
      op: "bind",
      sessionId: 2147483649,
      pluginId: "showroom",
    });

    // Not written, and the asking window is TOLD rather than left to sit out
    // its adopt timeout on a panel that is never coming.
    expect(workspace.pluginPanes.getSnapshot()["2147483649"]).toBeUndefined();
    expect(refusals).toEqual([[2147483649]]);
    workspace.controller.dispose();
  });

  it("takes a forwarded bind when the singleton is not open anywhere", async () => {
    // The guard is exclusivity, not a lock: the ordinary aux open still works,
    // which is the whole reason the forwarding path exists.
    const bus = loopbackBus();
    const refusals: number[][] = [];
    bus.onPluginPanesMutation((mutation) => {
      if (mutation.op === "rejected") {
        refusals.push(mutation.sessionIds);
      }
    });
    const fake = fakeClient({});
    const { appFiles } = files({
      "plugins_v1.json": JSON.stringify({
        plugins: { showroom: { path: "C:\code\showroom", enabled: true, grants: [] } },
      }),
    });
    const workspace = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      appFiles,
      windowBus: bus,
    });

    await bus.forwardPluginPanes({
      kind: "pluginPanes",
      op: "bind",
      sessionId: 2147483649,
      pluginId: "showroom",
    });

    expect(workspace.pluginPanes.getSnapshot()["2147483649"])
      .toEqual({ pluginId: "showroom" });
    expect(refusals).toEqual([]);
    workspace.controller.dispose();
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
    // Built as a const and passed by reference, not written inline: the seam
    // gains members over time, and a variable satisfies the interface without
    // an excess-property complaint on the ones it does not name yet.
    const native = {
      readRuntime: async (path: string) => {
        runtimeReads.push(path);
        return null;
      },
      probe: async () => "",
      spawn: async () => {
        throw new Error("spawn refused");
      },
      stderrTail: async () => "",
      readManifest: async () => null,
    };

    const workspace = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      appFiles,
      generateId: () => "panel-tab",
      pluginEnv: { APPDATA: "C:\\data" },
      pluginNative: native,
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
      pluginNative: nativeSpy().native,
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

  /// A registry holding one Showroom entry at a chosen enabled state.
  function registry(enabled: boolean): string {
    return JSON.stringify({
      plugins: { showroom: { path: "C:\\code\\showroom", enabled, grants: [] } },
    });
  }

  /// A native seam that records spawns and never reaches a Tauri command.
  ///
  /// Spawning REFUSES by default, and deliberately: a spawn that "succeeds"
  /// leaves ensure-up polling for its whole ten-second budget before it gives
  /// up, so the honest failure is also the fast one. The tests here are about
  /// whether a spawn happens at all.
  function nativeSpy() {
    const spawn = vi.fn(async (): Promise<number> => {
      throw new Error("spawn refused");
    });
    return {
      spawn,
      native: {
        readRuntime: async () => null,
        probe: async () => "",
        spawn,
        stderrTail: async () => "",
        readManifest: async () => null,
      },
    };
  }

  /// One turn of the loop: ensure-up is fire-and-forget, so its verdict lands
  /// a tick after the action that kicked it.
  function settled(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("refuses to open a DISABLED plugin and never spawns its process", async () => {
    // `enabled` is a real off switch (spec §2, §7), and the controller API is a
    // seam other code calls — T8 hiding the menu entry is not the guard. The
    // same gate covers openPluginSplit: both ask the host for the manifest
    // first, and a disabled plugin has none to give.
    const fake = fakeClient({ layout: serializeLayout(emptyLayout()) });
    const { appFiles } = files({ "plugins_v1.json": registry(false) });
    const spy = nativeSpy();

    const workspace = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      appFiles,
      generateId: () => "panel-tab",
      pluginNative: spy.native,
    });

    expect(await workspace.controller.openPluginTab("showroom")).toBeNull();
    await settled();

    expect(spy.spawn).not.toHaveBeenCalled();
    expect(workspace.controller.getSnapshot().layout.tabs).toEqual({});
    // Nothing was bound either: a refused open leaves no orphan behind.
    expect(workspace.pluginPanes.getSnapshot()).toEqual({});
  });

  it("tells a restored pane its plugin is disabled, and Relaunch keeps saying so", async () => {
    // The pane must stay a PLUGIN pane reporting why it is down, not decay
    // into a dead terminal: a dead terminal offers Restart/Resume, which would
    // put a shell where the user's panel was. And Relaunch must not become a
    // way to start a plugin the user switched off.
    const fake = fakeClient({ layout: panelLayout() });
    const { appFiles } = files({
      "plugin_panes_v1.json": JSON.stringify({
        version: 1,
        panes: { "2147483648": { pluginId: "showroom" } },
      }),
      "plugins_v1.json": registry(false),
    });
    const spy = nativeSpy();

    const workspace = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      appFiles,
      pluginNative: spy.native,
    });

    await workspace.controller.relaunchPlugin(PLUGIN_PANE_MIN_ID);
    const state = workspace.controller.getSnapshot().paneStates[PLUGIN_PANE_MIN_ID]!;

    expect(state.status).toBe("plugin");
    expect(state.pluginHealth).toBe("down");
    expect(state.pluginError).toContain("disabled");
    expect(spy.spawn).not.toHaveBeenCalled();

    // Clicking it again is the same honest answer, still with no process.
    await workspace.controller.relaunchPlugin(PLUGIN_PANE_MIN_ID);
    expect(workspace.controller.getSnapshot().paneStates[PLUGIN_PANE_MIN_ID])
      .toMatchObject({ pluginHealth: "down" });
    expect(workspace.controller.getSnapshot().paneStates[PLUGIN_PANE_MIN_ID]?.pluginError)
      .toContain("disabled");
    expect(spy.spawn).not.toHaveBeenCalled();
  });

  it("tells a restored pane its plugin is no longer installed", async () => {
    // The plugin was removed from the registry while its pane sat in the
    // layout. Same rule: a plugin pane saying what is wrong, never a corpse.
    const fake = fakeClient({ layout: panelLayout() });
    const { appFiles } = files({
      "plugin_panes_v1.json": JSON.stringify({
        version: 1,
        panes: { "2147483648": { pluginId: "showroom" } },
      }),
    });
    const spy = nativeSpy();

    const workspace = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      appFiles,
      pluginNative: spy.native,
    });

    await workspace.controller.relaunchPlugin(PLUGIN_PANE_MIN_ID);
    const state = workspace.controller.getSnapshot().paneStates[PLUGIN_PANE_MIN_ID]!;

    expect(state.status).toBe("plugin");
    expect(state.pluginHealth).toBe("down");
    expect(state.pluginError).toContain("not installed");
    expect(spy.spawn).not.toHaveBeenCalled();
  });

  it("unbinds a plugin pane when the group holding it is closed", async () => {
    // `deleteGroup("close-tabs")` is the one close path that does not go
    // through applyClosedSessions, so it gets its own end-to-end pin: the
    // binding must go, and the reserved id must never reach the daemon.
    const state = emptyLayout();
    state.groups.g = {
      id: "g",
      name: "Work",
      collapsed: false,
      color: null,
      items: [{ kind: "tab", id: "panel" }, { kind: "tab", id: "term" }],
    };
    state.tabs.panel = {
      id: "panel",
      title: "Showroom",
      color: "magenta",
      fill: "off",
      split: { kind: "pane", sessionId: PLUGIN_PANE_MIN_ID },
    };
    state.tabs.term = {
      id: "term",
      title: null,
      color: "blue",
      fill: "off",
      split: { kind: "pane", sessionId: 1 },
    };
    state.rootItems = [{ kind: "group", id: "g" }];
    state.activeTabId = "term";
    const fake = fakeClient({
      layout: serializeLayout(state),
      sessions: [session(1)],
    });
    const { appFiles, writes } = files({
      "plugin_panes_v1.json": JSON.stringify({
        version: 1,
        panes: { "2147483648": { pluginId: "showroom" } },
      }),
      "plugins_v1.json": registry(true),
    });

    const workspace = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      appFiles,
    });
    await workspace.controller.deleteGroup("g", "close-tabs");
    await workspace.pluginPanes.flush();

    expect(workspace.pluginPanes.getSnapshot()).toEqual({});
    expect(workspace.controller.getSnapshot().layout.groups).toEqual({});
    // Only the real terminal was closed host-side.
    expect(vi.mocked(fake.client.closeSession).mock.calls).toEqual([[1]]);
    const written = writes.filter(([name]) => name === "plugin_panes_v1.json");
    expect(parsePluginPanes(written.at(-1)![1])).toEqual({});
  });

  /// A registry holding the given entries, enabled with a per-id folder path
  /// unless the test says otherwise.
  function registryOf(
    entries: Record<
      string,
      { enabled?: boolean; path?: string; autostart?: boolean }
    >,
  ): string {
    return JSON.stringify({
      plugins: Object.fromEntries(
        Object.entries(entries).map(([id, entry]) => [
          id,
          {
            path: entry.path ?? `C:\\code\\${id}`,
            enabled: entry.enabled ?? true,
            grants: [],
            ...(entry.autostart === true ? { autostart: true } : {}),
          },
        ]),
      ),
    });
  }

  /**
   * "Start with TermX" (menubar spec), end to end through the real registry,
   * the real host and the real controller.
   *
   * The observable is the RUNTIME FILE READ: ensure-up's first act is to look
   * for the plugin's runtime file, and with no pane bound and no autostart
   * nothing ever asks. So a path in `runtimeReads` is proof the plugin was
   * started for no reason other than the flag.
   */
  describe("autostart", () => {
    it("starts a marked plugin at boot with no pane open", async () => {
      const spy = healthyNative();
      await bootWith({
        seed: { "plugins_v1.json": registryOf({ showroom: { autostart: true } }) },
        native: spy.native,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(spy.runtimeReads).toEqual(["C:\\data\\Showroom\\runtime.json"]);
    });

    it("starts nothing for an unmarked plugin", async () => {
      const spy = healthyNative();
      await bootWith({
        seed: { "plugins_v1.json": registryOf({ showroom: {} }) },
        native: spy.native,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(spy.runtimeReads).toEqual([]);
    });

    it("starts nothing for a marked plugin that is switched off", async () => {
      // `enabled` is the real off switch: a disabled plugin has no manifest to
      // give, so autostart must not smuggle it back into the lifecycle.
      const spy = healthyNative();
      await bootWith({
        seed: {
          "plugins_v1.json": registryOf({
            showroom: { enabled: false, autostart: true },
          }),
        },
        native: spy.native,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(spy.runtimeReads).toEqual([]);
    });

    it("never autostarts from an aux window", async () => {
      // Spawning is main's alone (plugin spec §3). Two windows both finding a
      // marked plugin down would both start the singleton.
      const spy = healthyNative();
      await bootWith({
        seed: { "plugins_v1.json": registryOf({ showroom: { autostart: true } }) },
        native: spy.native,
        windowId: "aux-1",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(spy.runtimeReads).toEqual([]);
    });

    it("starts a plugin marked from Settings after boot", async () => {
      // The flag is LIVE, not a boot-time reading. Nothing about a registry
      // write is a layout or a binding change, so without the registry watch
      // reaching the controller the switch did nothing at all until some
      // unrelated layout mutation happened by.
      const spy = healthyNative();
      const workspace = await bootWith({
        seed: { "plugins_v1.json": registryOf({ showroom: {} }) },
        native: spy.native,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(spy.runtimeReads).toEqual([]);

      workspace.plugins.setAutostart("showroom", true);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(spy.runtimeReads).toEqual(["C:\\data\\Showroom\\runtime.json"]);
    });

    it("stops there when the flag is flipped in an aux window", async () => {
      // Belt and braces on top of the aux host having no accessor at all:
      // bootstrap does not carry the registry change to an aux controller, and
      // the controller refuses it even when something does. Two windows both
      // acting on the flag would race to start the same singleton.
      const spy = healthyNative();
      const workspace = await bootWith({
        seed: { "plugins_v1.json": registryOf({ showroom: {} }) },
        native: spy.native,
        windowId: "aux-1",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      workspace.plugins.setAutostart("showroom", true);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(spy.runtimeReads).toEqual([]);
    });

    it("carries the autostart accessor on main's host, and not on an aux one", async () => {
      const main = await bootWith({
        seed: {
          "plugins_v1.json": registryOf({
            showroom: { autostart: true },
            toolbox: {},
          }),
        },
        native: healthyNative().native,
      });
      const aux = await bootWith({
        seed: { "plugins_v1.json": registryOf({ showroom: { autostart: true } }) },
        native: healthyNative().native,
        windowId: "aux-1",
      });

      expect([...(main.pluginHost.autostartIds?.() ?? [])]).toEqual(["showroom"]);
      expect(aux.pluginHost.autostartIds).toBeUndefined();
    });
  });

  /// A well-formed `termx-plugin.json`, so a test can prove the plugin's own
  /// file is preferred over the bundled table.
  function folderManifest(id: string, name: string): string {
    return JSON.stringify({
      manifest: 1,
      id,
      name,
      icon: "🧩",
      start: { command: "node", args: ["server.js"] },
      singleton: true,
      discovery: {
        runtimeFile: "%APPDATA%\\Thing\\runtime.json",
        healthPath: "/health",
      },
      panel: { path: "/" },
    });
  }

  /// A native seam answering a healthy Showroom on port 7788, with every hook
  /// a test may want to redirect.
  function healthyNative(overrides: {
    readRuntime?: () => Promise<string | null>;
    probe?: (url: string) => Promise<string>;
    readManifest?: (path: string) => Promise<string | null>;
  } = {}) {
    const spawn = vi.fn(async (): Promise<number> => {
      throw new Error("a probe must never spawn");
    });
    const probeUrls: string[] = [];
    const runtimeReads: string[] = [];
    const manifestReads: string[] = [];
    const native = {
      readRuntime: async (path: string) => {
        runtimeReads.push(path);
        return overrides.readRuntime
          ? await overrides.readRuntime()
          : JSON.stringify({ port: 7788, token: "t", version: "1.0.0" });
      },
      probe: async (url: string) => {
        probeUrls.push(url);
        return overrides.probe
          ? await overrides.probe(url)
          : JSON.stringify({ ok: true, version: "1.0.0" });
      },
      spawn,
      stderrTail: async () => "",
      readManifest: async (path: string) => {
        manifestReads.push(path);
        return overrides.readManifest ? await overrides.readManifest(path) : null;
      },
    };
    return { native, spawn, probeUrls, runtimeReads, manifestReads };
  }

  async function bootWith(options: {
    seed: Record<string, string>;
    native: ReturnType<typeof healthyNative>["native"];
    layout?: JsonValue;
    windowId?: string;
  }) {
    const fake = fakeClient(
      options.layout === undefined ? {} : { layout: options.layout },
    );
    const { appFiles } = files(options.seed);
    return bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      appFiles,
      generateId: () => "panel-tab",
      pluginEnv: { APPDATA: "C:\\data" },
      pluginNative: options.native,
      ...(options.windowId ? { windowId: options.windowId } : {}),
    });
  }

  /// The origin a pane would be framing after a successful ensure-up.
  const FRAMED = "http://127.0.0.1:7788";

  it("carries a probe on the production host at all", async () => {
    // The 15 s poll does nothing at all when the host has no probe, and every
    // controller-side test injects one — so without this assertion the whole
    // health feature could be missing from the real app and stay green.
    const workspace = await bootWith({
      seed: { "plugins_v1.json": registry(true) },
      native: healthyNative().native,
    });

    expect(typeof workspace.pluginHost.probe).toBe("function");
  });

  it("probes the origin the pane is framing, and never spawns", async () => {
    // A pure OBSERVATION of the CURRENT frame: an ensure-up here would respawn
    // a plugin the user just killed, and re-reading the runtime file would
    // report a plugin that came back on a new port as healthy while the iframe
    // still points at the old one.
    const spy = healthyNative();
    const workspace = await bootWith({
      seed: { "plugins_v1.json": registry(true) },
      native: spy.native,
    });

    expect(await workspace.pluginHost.probe?.("showroom", FRAMED)).toBe(true);
    expect(spy.probeUrls).toEqual([`${FRAMED}/api/health`]);
    expect(spy.runtimeReads).toEqual([]);
    expect(spy.spawn).not.toHaveBeenCalled();
  });

  it("treats a probe that throws as not healthy", async () => {
    const spy = healthyNative({
      probe: async () => {
        throw new Error("connection refused");
      },
    });
    const workspace = await bootWith({
      seed: { "plugins_v1.json": registry(true) },
      native: spy.native,
    });

    expect(await workspace.pluginHost.probe?.("showroom", FRAMED)).toBe(false);
  });

  it("reports an unhealthy body as not healthy", async () => {
    // A foreign app squatting on the recorded port answers 200; only the
    // {ok, version} pair proves the plugin itself is listening.
    const spy = healthyNative({ probe: async () => "<html>not us</html>" });
    const workspace = await bootWith({
      seed: { "plugins_v1.json": registry(true) },
      native: spy.native,
    });

    expect(await workspace.pluginHost.probe?.("showroom", FRAMED)).toBe(false);
  });

  it("reports a 200 without a version as not healthy", async () => {
    // Spec §3.1's identity rule: `{ok:true}` alone is any web server saying
    // yes. Only the version pair proves it is this plugin.
    const spy = healthyNative({ probe: async () => JSON.stringify({ ok: true }) });
    const workspace = await bootWith({
      seed: { "plugins_v1.json": registry(true) },
      native: spy.native,
    });

    expect(await workspace.pluginHost.probe?.("showroom", FRAMED)).toBe(false);
  });

  it("never probes a disabled plugin", async () => {
    const spy = healthyNative();
    const workspace = await bootWith({
      seed: { "plugins_v1.json": registry(false) },
      native: spy.native,
    });

    expect(await workspace.pluginHost.probe?.("showroom", FRAMED)).toBe(false);
    expect(spy.probeUrls).toEqual([]);
  });

  it("prefers a plugin's own folder manifest over the bundled one", async () => {
    // The tab title is the manifest's name, so it is the visible proof of
    // which manifest won.
    const spy = healthyNative({
      readManifest: async () => folderManifest("showroom", "Showroom Dev"),
    });
    const workspace = await bootWith({
      seed: { "plugins_v1.json": registry(true) },
      native: spy.native,
    });

    expect(await workspace.controller.openPluginTab("showroom")).toBe("panel-tab");
    expect(workspace.controller.getSnapshot().ungroupedTabs.at(-1)?.title)
      .toBe("Showroom Dev");
  });

  it("falls back to the bundled manifest when the folder file is malformed", async () => {
    // A first-party plugin must not become unopenable because its repository
    // grew a broken file; Settings is where the parse errors are explained.
    const spy = healthyNative({ readManifest: async () => "{ not json" });
    const workspace = await bootWith({
      seed: { "plugins_v1.json": registry(true) },
      native: spy.native,
    });

    expect(await workspace.controller.openPluginTab("showroom")).toBe("panel-tab");
    expect(workspace.controller.getSnapshot().ungroupedTabs.at(-1)?.title)
      .toBe("Showroom");
  });

  it("opens a non-bundled plugin from its folder manifest alone", async () => {
    const spy = healthyNative({
      readManifest: async () => folderManifest("toolbox", "Toolbox"),
    });
    const workspace = await bootWith({
      seed: { "plugins_v1.json": registryOf({ toolbox: {} }) },
      native: spy.native,
    });

    expect(await workspace.controller.openPluginTab("toolbox")).toBe("panel-tab");
    expect(workspace.controller.getSnapshot().ungroupedTabs.at(-1)?.title)
      .toBe("Toolbox");
  });

  it("leaves a non-bundled plugin with a malformed manifest unopenable", async () => {
    // Nothing to fall back to, and half-opening a plugin TermX cannot describe
    // would produce a pane with no name and no panel path.
    const spy = healthyNative({ readManifest: async () => "{ not json" });
    const workspace = await bootWith({
      seed: { "plugins_v1.json": registryOf({ toolbox: {} }) },
      native: spy.native,
    });

    expect(await workspace.controller.openPluginTab("toolbox")).toBeNull();
    expect(workspace.controller.getSnapshot().layout.tabs).toEqual({});
  });

  it("ignores a folder manifest that claims a different plugin id", async () => {
    // The registry key is what the binding stores and what the spawn stamps as
    // TERMX_PLUGIN_ID; a folder answering to another name would let one plugin
    // impersonate another.
    const spy = healthyNative({
      readManifest: async () => folderManifest("showroom", "Impostor"),
    });
    const workspace = await bootWith({
      seed: { "plugins_v1.json": registryOf({ toolbox: {} }) },
      native: spy.native,
    });

    expect(await workspace.controller.openPluginTab("toolbox")).toBeNull();
  });

  it("re-reads folder manifests when the registry changes", async () => {
    let manifest: string | null = null;
    const spy = healthyNative({ readManifest: async () => manifest });
    const workspace = await bootWith({
      seed: { "plugins_v1.json": registryOf({ toolbox: {} }) },
      native: spy.native,
    });
    // Boot read found nothing, and toolbox is not bundled.
    expect(workspace.pluginHost.manifestFor("toolbox")).toBeNull();

    manifest = folderManifest("toolbox", "Toolbox");
    workspace.plugins.add("toolbox", "C:\\code\\toolbox-moved");

    await vi.waitFor(() => {
      expect(workspace.pluginHost.manifestFor("toolbox")?.name).toBe("Toolbox");
    });
  });

  it("expands %VAR% in a registry path before reading its manifest", async () => {
    // plugins_v1.json is a hand-editable file; a literal `%APPDATA%\\Toolbox`
    // would otherwise read as "no manifest" for ever.
    const spy = healthyNative({
      readManifest: async () => folderManifest("toolbox", "Toolbox"),
    });
    const workspace = await bootWith({
      seed: {
        "plugins_v1.json": registryOf({ toolbox: { path: "%APPDATA%\\Toolbox" } }),
      },
      native: spy.native,
    });

    expect(spy.manifestReads).toEqual(["C:\\data\\Toolbox"]);
    expect(workspace.pluginHost.manifestFor("toolbox")?.name).toBe("Toolbox");
  });

  it("names a DISABLED non-bundled plugin by its own manifest", async () => {
    // The refusal is what the down card shows. A plugin the user switched off
    // still has a name, and "toolbox is disabled" (the raw registry key) reads
    // like a different, unknown thing.
    const spy = healthyNative({
      readManifest: async () => folderManifest("toolbox", "Toolbox"),
    });
    const workspace = await bootWith({
      seed: { "plugins_v1.json": registryOf({ toolbox: { enabled: false } }) },
      native: spy.native,
    });

    expect(await workspace.controller.openPluginTab("toolbox")).toBeNull();
    expect(workspace.controller.getSnapshot().notice)
      .toBe("Toolbox is disabled in Settings.");
  });

  it("opens a re-enabled plugin at once, without waiting for a re-read", async () => {
    // The cache holds disabled entries too, so flipping the switch is instant.
    // Dropping them made a re-enable produce "cannot read a manifest" until an
    // async refresh landed — and that text then sat on the card.
    const spy = healthyNative({
      readManifest: async () => folderManifest("toolbox", "Toolbox"),
    });
    const workspace = await bootWith({
      seed: { "plugins_v1.json": registryOf({ toolbox: { enabled: false } }) },
      native: spy.native,
    });

    workspace.plugins.setEnabled("toolbox", true);

    expect(await workspace.controller.openPluginTab("toolbox")).toBe("panel-tab");
    expect(workspace.controller.getSnapshot().ungroupedTabs.at(-1)?.title)
      .toBe("Toolbox");
  });

  it("names a plugin the enabled gate refuses, for the UI that lists it", async () => {
    // `pluginHost.manifestFor` refuses a disabled plugin because OPENING one
    // must refuse; naming one must not, or Settings and the sidebar show a
    // raw id.
    const spy = healthyNative({
      readManifest: async () => folderManifest("toolbox", "Toolbox"),
    });
    const workspace = await bootWith({
      seed: { "plugins_v1.json": registryOf({ toolbox: { enabled: false } }) },
      native: spy.native,
    });

    expect(workspace.pluginHost.manifestFor("toolbox")).toBeNull();
    expect(workspace.pluginManifestFor("toolbox")?.name).toBe("Toolbox");
  });

  it("does not hang the whole boot on an unresponsive manifest read", async () => {
    // A plugin folder is a user-chosen path: a UNC share, a disconnected
    // mapped drive, a spun-down disk. No window at all is a far worse answer
    // than a plugin briefly named from the bundled table.
    vi.useFakeTimers();
    try {
      const spy = healthyNative({
        readManifest: () => new Promise<string | null>(() => undefined),
      });
      const booting = bootWith({
        seed: { "plugins_v1.json": registry(true) },
        native: spy.native,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      const workspace = await booting;

      // Booted, and the bundled table answered while the read hung.
      expect(workspace.pluginHost.manifestFor("showroom")?.name).toBe("Showroom");
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads once for a burst of registry changes", async () => {
    vi.useFakeTimers();
    try {
      const spy = healthyNative();
      const booting = bootWith({
        seed: { "plugins_v1.json": registry(true) },
        native: spy.native,
      });
      await vi.advanceTimersByTimeAsync(0);
      const workspace = await booting;
      const atBoot = spy.manifestReads.length;

      // Three flicks of a Settings switch.
      workspace.plugins.setEnabled("showroom", false);
      workspace.plugins.setEnabled("showroom", true);
      workspace.plugins.setEnabled("showroom", false);
      await vi.advanceTimersByTimeAsync(500);

      expect(spy.manifestReads.length).toBe(atBoot + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the newest registry state win when an older read is slower", async () => {
    // Last started wins: a read of the OLD folder that lands after the new
    // one would otherwise reinstate a manifest for a path the user replaced.
    vi.useFakeTimers();
    try {
      let releaseOld = (): void => undefined;
      const oldRead = new Promise<string | null>((resolve) => {
        releaseOld = () => resolve(folderManifest("toolbox", "Old"));
      });
      const spy = healthyNative({
        readManifest: (path) =>
          path.endsWith("one")
            ? oldRead
            : Promise.resolve(folderManifest("toolbox", "New")),
      });
      const booting = bootWith({
        seed: { "plugins_v1.json": registryOf({ toolbox: {} }) },
        native: spy.native,
      });
      await vi.advanceTimersByTimeAsync(0);
      const workspace = await booting;

      workspace.plugins.add("toolbox", "C:\\code\\one");
      await vi.advanceTimersByTimeAsync(200);
      workspace.plugins.add("toolbox", "C:\\code\\two");
      await vi.advanceTimersByTimeAsync(200);
      expect(workspace.pluginManifestFor("toolbox")?.name).toBe("New");

      releaseOld();
      await vi.advanceTimersByTimeAsync(200);

      expect(workspace.pluginManifestFor("toolbox")?.name).toBe("New");
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the renderer when a folder manifest finally lands", async () => {
    // `pluginManifestFor` answers differently over time — the boot read is
    // bounded, and a registry change re-reads after a debounce — and nothing
    // in React would notice. A panel would wear the bundled name, or its bare
    // id, until some unrelated render refreshed it.
    let manifest: string | null = null;
    const spy = healthyNative({ readManifest: async () => manifest });
    const workspace = await bootWith({
      seed: { "plugins_v1.json": registryOf({ toolbox: {} }) },
      native: spy.native,
    });
    let moved = 0;
    const stop = workspace.subscribeManifests(() => {
      moved += 1;
    });

    manifest = folderManifest("toolbox", "Toolbox");
    workspace.plugins.add("toolbox", "C:\\code\\toolbox-moved");
    await vi.waitFor(() => {
      expect(workspace.pluginManifestFor("toolbox")?.name).toBe("Toolbox");
    });
    expect(moved).toBeGreaterThan(0);

    // And it lets go: a listener that outlived its window would keep a dead
    // renderer's closure alive.
    stop();
    const after = moved;
    workspace.plugins.add("toolbox", "C:\\code\\toolbox-again");
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    expect(moved).toBe(after);
  });

  it("pins the two budgets a manifest re-read is bounded by", () => {
    // Both are promises made in prose (a boot that never hangs, one read for a
    // burst of clicks); advancing by the constant itself would pass at any
    // value.
    expect(PLUGIN_MANIFEST_BOOT_BUDGET_MS).toBe(1_500);
    expect(PLUGIN_MANIFEST_REFRESH_DEBOUNCE_MS).toBe(100);
  });

  it("tells the renderer about a boot read that lands after the budget", async () => {
    // The boot only bounds the WAIT: the read keeps going, and the answer it
    // finally brings back changes what `pluginManifestFor` says. Nothing in
    // React would notice, so every panel and rail entry would wear the bundled
    // name until some unrelated render.
    vi.useFakeTimers();
    try {
      let release = (): void => undefined;
      const spy = healthyNative({
        readManifest: () => new Promise<string | null>((resolve) => {
          release = () => resolve(folderManifest("showroom", "Showroom Folder"));
        }),
      });
      const booting = bootWith({
        seed: { "plugins_v1.json": registry(true) },
        native: spy.native,
      });
      await vi.advanceTimersByTimeAsync(PLUGIN_MANIFEST_BOOT_BUDGET_MS);
      const workspace = await booting;
      let moved = 0;
      const stop = workspace.subscribeManifests(() => {
        moved += 1;
      });
      // Booted on the bundled table, as the budget promises.
      expect(workspace.pluginManifestFor("showroom")?.name).toBe("Showroom");

      release();
      await vi.advanceTimersByTimeAsync(0);

      expect(moved).toBe(1);
      expect(workspace.pluginManifestFor("showroom")?.name).toBe("Showroom Folder");
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing for a read a newer one has already superseded", async () => {
    // The epoch guard drops the stale answer; announcing it anyway would make
    // React re-read a cache that did not change — and, worse, would teach the
    // renderer to expect a notification per read rather than per landing.
    vi.useFakeTimers();
    try {
      let releaseOld = (): void => undefined;
      const oldRead = new Promise<string | null>((resolve) => {
        releaseOld = () => resolve(folderManifest("toolbox", "Old"));
      });
      const spy = healthyNative({
        readManifest: (path) =>
          path.endsWith("one")
            ? oldRead
            : Promise.resolve(folderManifest("toolbox", "New")),
      });
      const booting = bootWith({
        seed: { "plugins_v1.json": registryOf({ toolbox: {} }) },
        native: spy.native,
      });
      await vi.advanceTimersByTimeAsync(0);
      const workspace = await booting;

      workspace.plugins.add("toolbox", "C:\\code\\one");
      await vi.advanceTimersByTimeAsync(200);
      workspace.plugins.add("toolbox", "C:\\code\\two");
      await vi.advanceTimersByTimeAsync(200);

      let moved = 0;
      const stop = workspace.subscribeManifests(() => {
        moved += 1;
      });
      releaseOld();
      await vi.advanceTimersByTimeAsync(200);

      expect(moved).toBe(0);
      expect(workspace.pluginManifestFor("toolbox")?.name).toBe("New");
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a manifest read that lands after the workspace is disposed", async () => {
    // The boot read is unbounded — only the WAIT for it is bounded — so it can
    // still answer inside a window that has already been torn down. Installing
    // that answer would rewrite a cache nobody owns and wake listeners
    // belonging to a dead renderer.
    vi.useFakeTimers();
    try {
      let release = (): void => undefined;
      const spy = healthyNative({
        readManifest: () => new Promise<string | null>((resolve) => {
          release = () => resolve(folderManifest("showroom", "Late Name"));
        }),
      });
      const booting = bootWith({
        seed: { "plugins_v1.json": registry(true) },
        native: spy.native,
      });
      await vi.advanceTimersByTimeAsync(PLUGIN_MANIFEST_BOOT_BUDGET_MS);
      const workspace = await booting;

      workspace.controller.dispose();
      // Subscribed AFTER teardown on purpose: `dispose` empties the listener
      // set, so one added before it cannot tell us anything.
      let moved = 0;
      const stop = workspace.subscribeManifests(() => {
        moved += 1;
      });
      release();
      await vi.advanceTimersByTimeAsync(0);

      expect(moved).toBe(0);
      expect(workspace.pluginManifestFor("showroom")?.name).toBe("Showroom");
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops watching the registry once the workspace is disposed", async () => {
    const spy = healthyNative();
    const workspace = await bootWith({
      seed: { "plugins_v1.json": registry(true) },
      native: spy.native,
    });
    const atBoot = spy.manifestReads.length;

    workspace.controller.dispose();
    workspace.plugins.setEnabled("showroom", false);
    await new Promise<void>((resolve) => setTimeout(resolve, 250));

    expect(spy.manifestReads.length).toBe(atBoot);
  });

  it("starts a restored panel's plugin at boot, with no user action", async () => {
    // The second launch of TermX. Nothing else would ever call ensure-up for
    // a pane that is simply already there, and T6's "starting" card has no
    // Relaunch button — so without this the panel is unrecoverable.
    const spy = healthyNative();
    const workspace = await bootWith({
      layout: panelLayout(),
      seed: {
        "plugin_panes_v1.json": JSON.stringify({
          version: 1,
          panes: { "2147483648": { pluginId: "showroom" } },
        }),
        "plugins_v1.json": registry(true),
      },
      native: spy.native,
    });

    await vi.waitFor(() => {
      expect(workspace.controller.getSnapshot().paneStates[PLUGIN_PANE_MIN_ID])
        .toMatchObject({ status: "plugin", pluginHealth: "up" });
    });
    // Adopted, never spawned: the plugin was already running.
    expect(spy.spawn).not.toHaveBeenCalled();
  });

  it("an aux window adopts a running plugin but never spawns one", async () => {
    // Lifecycle ownership is the main window's alone (spec §3): two windows
    // both finding the plugin down would otherwise both spawn the singleton,
    // and a plugin that walks ports answers that with two live processes.
    const spy = healthyNative();
    const workspace = await bootWith({
      seed: { "plugins_v1.json": registry(true) },
      native: spy.native,
      windowId: "aux-1",
    });

    const result = await workspace.pluginHost.ensureUp("showroom");

    expect(result.ok).toBe(true);
    expect(spy.spawn).not.toHaveBeenCalled();
  });

  it("MAIN spawns in exactly the situation an aux window refuses to", async () => {
    // The half that makes the two aux assertions mean something. With no
    // runtime file there is nothing to adopt, and this window DOES try to
    // start the plugin — so "never spawns" next door is a statement about the
    // window, not about the fixture being healthy enough that nobody would.
    const spy = healthyNative({ readRuntime: async () => null });
    const workspace = await bootWith({
      seed: { "plugins_v1.json": registry(true) },
      native: spy.native,
    });

    const result = await workspace.pluginHost.ensureUp("showroom");

    expect(spy.spawn).toHaveBeenCalled();
    // The spy's spawn throws, so the attempt is reported as a failure rather
    // than pretending a process appeared.
    expect(result.ok).toBe(false);
  });

  it("writes a pending registry change when the window closes", async () => {
    // `PluginsStore` debounces its disk write, and closing a window is exactly
    // when that debounce is still pending: add the folder, open the panel,
    // quit. The layout and the bindings file would then name a plugin
    // `plugins_v1.json` had never heard of, and the next boot says it is not
    // installed with the folder path gone.
    const spy = healthyNative();
    const { appFiles, writes } = files({ "plugins_v1.json": registry(true) });
    const fake = fakeClient({});
    const workspace = await bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      appFiles,
      generateId: () => "panel-tab",
      pluginEnv: { APPDATA: "C:\\data" },
      pluginNative: spy.native,
    });
    // Fake timers from HERE: the 800 ms debounce must never get the chance to
    // fire, or the test passes on time elapsing rather than on the close
    // flushing — which is the whole point.
    vi.useFakeTimers();
    try {
      workspace.plugins.add("toolbox", "C:\\code\\toolbox");
      expect(writes.filter(([name]) => name === "plugins_v1.json")).toHaveLength(0);

      workspace.controller.dispose();
      await vi.advanceTimersByTimeAsync(0);

      const registryWrites = writes.filter(([name]) => name === "plugins_v1.json");
      expect(registryWrites).toHaveLength(1);
      expect(JSON.parse(registryWrites[0]![1]).plugins.toolbox.path)
        .toBe("C:\\code\\toolbox");
    } finally {
      vi.useRealTimers();
    }
  });

  it("MAIN waits for its own bus listeners before booting", async () => {
    // An aux window's `sync` — or a bind forwarded the moment it opened — that
    // wins the race against an unresolved `listen()` is dropped, and nothing
    // re-sends it. Main has to be listening before it can open a window that
    // talks to it.
    let releaseListeners = (): void => undefined;
    const listening = new Promise<void>((resolve) => {
      releaseListeners = resolve;
    });
    const bus = loopbackBus();
    const slowBus = { ...bus, ready: () => listening };
    const spy = healthyNative();
    const { appFiles } = files({ "plugins_v1.json": registry(true) });
    const fake = fakeClient({});
    let booted = false;
    const booting = bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      appFiles,
      generateId: () => "panel-tab",
      pluginEnv: { APPDATA: "C:\\data" },
      pluginNative: spy.native,
      windowBus: slowBus,
    }).then((workspace) => {
      booted = true;
      return workspace;
    });

    // A whole macrotask turn, not a couple of microtasks: every other await on
    // the boot path (file reads, the host handshake, the manifest budget)
    // settles inside it, so a boot still pending here is pending on `ready()`
    // and nothing else.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(booted).toBe(false);

    releaseListeners();
    const workspace = await booting;

    expect(booted).toBe(true);
    workspace.controller.dispose();
  });

  it("an aux window fails fast on a path fault instead of waiting ten seconds", async () => {
    // `plugin_read_runtime` answers null for a missing file but REJECTS for an
    // unexpanded `%VAR%`, a relative path or a denied read. Those cannot start
    // working because time passed, and reporting "relaunch it from the main
    // window" for a path fault sends the user to a button that cannot help.
    vi.useFakeTimers();
    try {
      const spy = healthyNative({
        readRuntime: async () => {
          throw new Error("runtime path must be absolute");
        },
      });
      const booting = bootWith({
        seed: { "plugins_v1.json": registry(true) },
        native: spy.native,
        windowId: "aux-1",
      });
      await vi.advanceTimersByTimeAsync(0);
      const workspace = await booting;

      const pending = workspace.pluginHost.ensureUp("showroom");
      // No clock advance at all: the answer is already there.
      await vi.advanceTimersByTimeAsync(0);

      expect(await pending).toEqual({
        ok: false,
        reason: "runtime path must be absolute",
        stderrTail: "",
      });
      expect(spy.spawn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops an in-flight observe when the window is disposed", async () => {
    // The observe budget is ten seconds and a torn-out window can be closed
    // well inside it. A loop that keeps reading files and probing ports for a
    // window that is gone is a leak the user pays for on every close.
    vi.useFakeTimers();
    try {
      const spy = healthyNative({ readRuntime: async () => null });
      const booting = bootWith({
        seed: { "plugins_v1.json": registry(true) },
        native: spy.native,
        windowId: "aux-1",
      });
      await vi.advanceTimersByTimeAsync(0);
      const workspace = await booting;

      const pending = workspace.pluginHost.ensureUp("showroom");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(spy.runtimeReads.length).toBeGreaterThan(1);

      workspace.controller.dispose();
      const atDispose = spy.runtimeReads.length;
      await vi.advanceTimersByTimeAsync(30_000);

      expect(spy.runtimeReads.length).toBe(atDispose);
      // And the caller is answered rather than left hanging on a dead loop.
      expect((await pending).ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an aux window waits, then points at the main window", async () => {
    vi.useFakeTimers();
    try {
      const spy = healthyNative({ readRuntime: async () => null });
      const booting = bootWith({
        seed: { "plugins_v1.json": registry(true) },
        native: spy.native,
        windowId: "aux-1",
      });
      await vi.advanceTimersByTimeAsync(0);
      const workspace = await booting;

      const pending = workspace.pluginHost.ensureUp("showroom");
      await vi.advanceTimersByTimeAsync(11_000);
      const result = await pending;

      expect(result).toEqual({
        ok: false,
        reason: "The plugin is not running. Relaunch it from the main window.",
        stderrTail: "",
      });
      expect(spy.spawn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an aux window's one look adopts a plugin that is back, without spawning", async () => {
    // What the 15 s health poll calls in a non-main window. `ensureUp` is the
    // wrong seam for it: that one waits out a ten-second budget, so a poll
    // built on it would still be waiting when the next tick arrived.
    vi.useFakeTimers();
    try {
      const spy = healthyNative();
      const booting = bootWith({
        seed: { "plugins_v1.json": registry(true) },
        native: spy.native,
        windowId: "aux-1",
      });
      await vi.advanceTimersByTimeAsync(0);
      const workspace = await booting;

      const look = workspace.pluginHost.observeOnce;
      if (look === undefined) {
        throw new Error("an aux host must carry the one-look seam");
      }
      const pending = look("showroom");
      // No clock advance: one read, one probe, an answer.
      await vi.advanceTimersByTimeAsync(0);

      expect(await pending).toEqual({
        ok: true,
        runtime: { url: FRAMED, port: 7788, token: "t", version: "1.0.0" },
      });
      expect(spy.probeUrls.length).toBeGreaterThan(0);
      expect(spy.spawn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an aux window's one look gives up at once when the plugin is still gone", async () => {
    // The half that makes "one look" mean one. Built on the observe LOOP this
    // would read the runtime file over and over for ten seconds and answer
    // nothing at t=0 — every health tick starting another one.
    vi.useFakeTimers();
    try {
      const spy = healthyNative({ readRuntime: async () => null });
      const booting = bootWith({
        seed: { "plugins_v1.json": registry(true) },
        native: spy.native,
        windowId: "aux-1",
      });
      await vi.advanceTimersByTimeAsync(0);
      const workspace = await booting;

      const look = workspace.pluginHost.observeOnce;
      if (look === undefined) {
        throw new Error("an aux host must carry the one-look seam");
      }
      const reads = spy.runtimeReads.length;
      const pending = look("showroom");
      await vi.advanceTimersByTimeAsync(0);

      expect(await pending).toEqual({
        ok: false,
        reason: "The plugin is not running. Relaunch it from the main window.",
        stderrTail: "",
      });
      expect(spy.runtimeReads.length).toBe(reads + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("MAIN carries no one-look seam, so its health poll stays one-way", async () => {
    // Re-looking is only safe where it cannot lead to a spawn. On main a
    // second look at a plugin believed dead is the first step towards
    // restarting something the user killed on purpose, and the offline card
    // that names Relaunch would become unreachable.
    const spy = healthyNative();
    const workspace = await bootWith({
      seed: { "plugins_v1.json": registry(true) },
      native: spy.native,
    });

    expect(workspace.pluginHost.observeOnce).toBeUndefined();
    workspace.controller.dispose();
  });
});

/**
 * Conversation captures end to end (plugin-phase1 Task C). The unit tests in
 * conversations/__tests__/captures.test.ts prove the parser; these prove the
 * WIRING — that the file is actually read at boot, re-read when a pane dies,
 * and that a failed read degrades to "I do not know" instead of "no captures".
 */
describe("bootstrapWorkspace conversation captures", () => {
  it("reloads launch metadata without a pane exit and retains it after pane capture compaction", async () => {
    const fake = fakeClient({ layout: null, sessions: [] });
    let launches: string | null = null;
    const appFiles: AppFileStore = { read: async name => name === "conversation_launches_v1.jsonl" ? launches : null, write: async () => undefined };
    const workspace = await boot(appFiles, fake);
    const record = { provider: "codex" as const, id: "captured-id", title: "Saved" };
    expect(await workspace.controller.conversationWithLaunch(record)).toEqual(record);
    const launch = { v: 1, provider: "codex", args: ["--model", "original", "--add-dir", "../shared"], cwd: "C:\\launch" };
    launches = JSON.stringify({ v: 1, provider: "codex", id: "captured-id", launch }) + "\n";
    expect(await workspace.controller.conversationWithLaunch(record)).toEqual({ ...record, launch });
    workspace.controller.dispose();
    const restarted = await boot(appFiles, fakeClient({ layout: null, sessions: [] }));
    expect(await restarted.controller.conversationWithLaunch(record)).toEqual({ ...record, launch });
    restarted.controller.dispose();
  });

  const CAPTURED_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
  const OTHER_ID = "7d9e2f10-3a4b-4c5d-8e6f-102938475650";

  /** A layout holding one pane, so a corpse has somewhere to be. */
  function soloLayout(sessionId: number): JsonValue {
    const state = emptyLayout();
    state.tabs.only = {
      id: "only",
      title: null,
      color: "blue",
      fill: "off",
      split: { kind: "pane", sessionId },
    };
    state.rootItems = [{ kind: "tab", id: "only" }];
    state.activeTabId = "only";
    return serializeLayout(state);
  }

  /** A session the host still remembers but that has already exited. */
  function corpse(id: number): SessionInfo {
    return { ...session(id), alive: false, pid: null };
  }

  function captureLine(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      v: 1,
      termxSessionId: 3,
      provider: "claude",
      id: CAPTURED_ID,
      cwd: "C:\\work\\3",
      atMs: 1000,
      ...overrides,
    });
  }

  /** A capture store whose contents and failure mode a test can steer. */
  function captureFiles(initial: string | null) {
    const state = { text: initial, throwOnRead: false, throwOnWrite: false };
    const writes: Array<[string, string]> = [];
    const appFiles: AppFileStore = {
      read: async (name) => {
        if (name !== CAPTURES_FILE) {
          return null;
        }
        if (state.throwOnRead) {
          throw new Error("read_app_file failed");
        }
        return state.text;
      },
      write: async (name, contents) => {
        if (name === CAPTURES_FILE && state.throwOnWrite) {
          throw new Error("write_app_file failed");
        }
        writes.push([name, contents]);
      },
    };
    return { appFiles, state, writes };
  }

  async function flush(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }
  }

  function boot(
    appFiles: AppFileStore,
    fake: ReturnType<typeof fakeClient>,
    extra: { listSessions?: () => Promise<readonly LlmSessionRecord[]> } = {},
  ) {
    return bootstrapWorkspace({
      invokeBootstrap: async () => ({ port: 1234, token: "token" }),
      connect: async () => fake.client,
      appFiles,
      ...(extra.listSessions ? { listSessions: extra.listSessions } : {}),
    });
  }

  it("reads the log at boot so a dead pane resumes the conversation IT ran", async () => {
    const fake = fakeClient({ layout: soloLayout(3), sessions: [corpse(3)] });
    const { appFiles } = captureFiles(`${captureLine()}\n`);

    const workspace = await boot(appFiles, fake);

    // Synthesized: the index has not scanned yet, and resume must not wait.
    expect(workspace.controller.deadPaneResumeTitle(3)).toBe("Captured conversation");
  });

  it("resolves the capture to the EXACT indexed conversation, not the newest in the folder", async () => {
    // Pins the id rather than the placeholder title: once the index holds
    // records, capturedConversationFor joins on provider + id, so a
    // distinctive title coming back proves the captured id was matched.
    const indexed: LlmSessionRecord = {
      provider: "claude",
      id: CAPTURED_ID,
      title: "The captured one",
      cwd: "C:\\work\\3",
      filePath: "C:\\transcripts\\captured.jsonl",
      updatedAtMs: 10,
      summary: null,
      recap: null,
      titleSource: "named",
    };
    // Newer, and in the SAME folder — exactly what the old folder-based
    // lookup would have resumed instead.
    const decoy: LlmSessionRecord = {
      ...indexed,
      id: OTHER_ID,
      title: "A stranger",
      updatedAtMs: 99,
    };
    const fake = fakeClient({ layout: soloLayout(3), sessions: [corpse(3)] });
    const { appFiles } = captureFiles(`${captureLine()}\n`);

    const workspace = await boot(appFiles, fake, {
      listSessions: async () => [decoy, indexed],
    });
    await workspace.conversations?.refresh(true);

    expect(workspace.controller.deadPaneResumeTitle(3)).toBe("The captured one");
  });

  it("offers no capture-based resume when the log names a different pane", async () => {
    const fake = fakeClient({ layout: soloLayout(3), sessions: [corpse(3)] });
    const { appFiles } = captureFiles(`${captureLine({ termxSessionId: 9 })}\n`);

    const workspace = await boot(appFiles, fake);

    expect(workspace.controller.deadPaneResumeTitle(3)).toBeNull();
  });

  it("re-reads the log when a session exits, catching a capture written after boot", async () => {
    const fake = fakeClient({ layout: soloLayout(3), sessions: [corpse(3)] });
    const { appFiles, state } = captureFiles(null);

    const workspace = await boot(appFiles, fake);
    expect(workspace.controller.deadPaneResumeTitle(3)).toBeNull();

    // The pane ran `claude` long after boot; the hook appended just now.
    state.text = `${captureLine()}\n`;
    fake.emitExit(3, 0);
    await flush();

    expect(workspace.controller.deadPaneResumeTitle(3)).toBe("Captured conversation");
  });

  it("repaints the dead pane when a re-read brings its capture in", async () => {
    // The map is not React state: a pane that gained a resumable conversation
    // after it died would keep showing the plain Restart card until something
    // unrelated repainted it.
    //
    // The read is held open on purpose. The exit itself publishes, so a test
    // that only counted publishes after the exit would pass with no repaint at
    // all — the one that matters is the publish AFTER the file comes back.
    const fake = fakeClient({ layout: soloLayout(3), sessions: [corpse(3)] });
    let defer = false;
    const pending: Array<(text: string | null) => void> = [];
    const appFiles: AppFileStore = {
      read: async (name) => {
        if (name !== CAPTURES_FILE) {
          return null;
        }
        if (!defer) {
          return null;
        }
        return new Promise<string | null>((resolve) => {
          pending.push(resolve);
        });
      },
      write: async () => undefined,
    };

    const workspace = await boot(appFiles, fake);
    defer = true;
    fake.emitExit(3, 0);
    await flush();
    expect(pending).toHaveLength(1);

    // Everything the exit itself could repaint has already happened.
    let published = 0;
    workspace.controller.subscribe(() => {
      published += 1;
    });

    pending[0]?.(`${captureLine()}\n`);
    await flush();

    expect(published).toBe(1);
    expect(workspace.controller.deadPaneResumeTitle(3)).toBe("Captured conversation");
  });

  /**
   * The regression Grok caught: a THROWN read used to return an empty map and
   * be assigned unconditionally, erasing every capture for the rest of the
   * process — so Resume silently vanished from every later dead pane.
   */
  it("keeps the last good map when a re-read throws", async () => {
    const fake = fakeClient({ layout: soloLayout(3), sessions: [corpse(3)] });
    const { appFiles, state } = captureFiles(`${captureLine()}\n`);

    const workspace = await boot(appFiles, fake);
    expect(workspace.controller.deadPaneResumeTitle(3)).toBe("Captured conversation");

    state.throwOnRead = true;
    fake.emitExit(3, 0);
    await flush();

    expect(workspace.controller.deadPaneResumeTitle(3)).toBe("Captured conversation");
  });

  it("boots with no captures when the boot read throws", async () => {
    const fake = fakeClient({ layout: soloLayout(3), sessions: [corpse(3)] });
    const { appFiles, state } = captureFiles(`${captureLine()}\n`);
    state.throwOnRead = true;

    const workspace = await boot(appFiles, fake);

    expect(workspace.controller.deadPaneResumeTitle(3)).toBeNull();
  });

  /**
   * Two panes exiting together start two reads. The SLOWER one may resolve
   * last while holding the OLDER file, so ordering by completion would undo a
   * capture that had already landed.
   */
  it("never lets a slow earlier read overwrite a newer one", async () => {
    const fake = fakeClient({ layout: soloLayout(3), sessions: [corpse(3)] });
    let defer = false;
    const pending: Array<(text: string | null) => void> = [];
    const appFiles: AppFileStore = {
      read: async (name) => {
        if (name !== CAPTURES_FILE || !defer) {
          return null;
        }
        return new Promise<string | null>((resolve) => {
          pending.push(resolve);
        });
      },
      write: async () => undefined,
    };

    const workspace = await boot(appFiles, fake);
    expect(workspace.controller.deadPaneResumeTitle(3)).toBeNull();
    defer = true;

    fake.emitExit(3, 0); // read A — opened first, holds the older file
    fake.emitExit(3, 0); // read B — opened second, holds the newer file
    await flush();
    expect(pending).toHaveLength(2);

    // B finishes first and brings the capture the hook has just written.
    pending[1]?.(`${captureLine()}\n`);
    await flush();
    expect(workspace.controller.deadPaneResumeTitle(3)).toBe("Captured conversation");

    // A finally lands, holding the log from BEFORE that capture existed.
    pending[0]?.(null);
    await flush();

    expect(workspace.controller.deadPaneResumeTitle(3)).toBe("Captured conversation");
  });

  it("makes a superseded resume lookup await the newest configuration read", async () => {
    let defer = false;
    const pending: Array<(value: string) => void> = [];
    const appFiles: AppFileStore = {
      read: async name => name === "conversation_launches_v1.jsonl" && defer ? new Promise<string>(resolve => pending.push(resolve)) : null,
      write: async () => undefined,
    };
    const workspace = await boot(appFiles, fakeClient({ layout: null, sessions: [] }));
    defer = true;
    const record = { provider: "codex", id: "id" };
    let finished = false;
    const first = workspace.controller.conversationWithLaunch(record).then(value => { finished = true; return value; });
    const second = workspace.controller.conversationWithLaunch(record);
    const launch = { v: 1, provider: "codex", cwd: "C:\\start", args: ["--model", "newest"] };
    pending[0]!("");
    await flush();
    expect(finished).toBe(false);
    pending[1]!(JSON.stringify({ v: 1, ...record, launch }));
    expect(await first).toEqual({ ...record, launch });
    expect(await second).toEqual({ ...record, launch });
    workspace.controller.dispose();
  });

  describe("boot-time compaction", () => {
    /** A log past the 512 KiB threshold, with many lines per pane. */
    function hugeLog(): string {
      const lines: string[] = [];
      for (let index = 0; index < 6000; index += 1) {
        lines.push(captureLine({ termxSessionId: index % 50, atMs: 1000 + index }));
      }
      return `${lines.join("\n")}\n`;
    }

    it("writes the compacted log back when the file has grown past the threshold", async () => {
      const fake = fakeClient({ layout: soloLayout(3), sessions: [corpse(3)] });
      const big = hugeLog();
      const { appFiles, writes } = captureFiles(big);

      const workspace = await boot(appFiles, fake);

      const written = writes.filter(([name]) => name === CAPTURES_FILE);
      expect(written).toHaveLength(1);
      // Shorter, and rewritten exactly once — the exact contents are pinned by
      // the keep-set cases below.
      expect((written[0]?.[1] ?? "").length).toBeLessThan(big.length);
      // Compaction must not cost the boot a single resume.
      expect(workspace.controller.deadPaneResumeTitle(3)).toBe("Captured conversation");
    });

    it("leaves a small log alone rather than racing the hook for nothing", async () => {
      const fake = fakeClient({ layout: soloLayout(3), sessions: [corpse(3)] });
      const { appFiles, writes } = captureFiles(`${captureLine()}\n`);

      await boot(appFiles, fake);

      expect(writes.filter(([name]) => name === CAPTURES_FILE)).toEqual([]);
    });

    it("drops the captures of panes the restored layout no longer holds", async () => {
      // The log outlives the panes: every closed tab leaves records nothing
      // can ever resume, and they are the bulk of a long-lived log.
      const fake = fakeClient({ layout: soloLayout(3), sessions: [corpse(3)] });
      const big = hugeLog();
      const { appFiles, writes } = captureFiles(big);

      const workspace = await boot(appFiles, fake);

      const written = writes.filter(([name]) => name === CAPTURES_FILE);
      expect(written[0]?.[1]).toBe(compactCaptures(big, new Set([3])));
      // Strictly less than age-and-count compaction alone, and the pane that
      // IS in the layout keeps its resume.
      expect((written[0]?.[1] ?? "").length)
        .toBeLessThan((compactCaptures(big) ?? "").length);
      expect(workspace.controller.deadPaneResumeTitle(3)).toBe("Captured conversation");
    });

    it("compacts WITHOUT a keep set when the layout blob could not be parsed", async () => {
      // A corrupt blob reconciles to an empty layout, and an empty keep set
      // clears the log by contract. Trusting it here would erase every
      // capture at the one boot where the user most needs a resume.
      const fake = fakeClient({ layout: "not a layout", sessions: [corpse(3)] });
      const big = hugeLog();
      const { appFiles, writes } = captureFiles(big);

      await boot(appFiles, fake);

      const written = writes.filter(([name]) => name === CAPTURES_FILE);
      expect(written[0]?.[1]).toBe(compactCaptures(big));
      expect(written[0]?.[1]).not.toBe("");
    });

    it("swallows a failed compaction write — the hook may hold the file open", async () => {
      const fake = fakeClient({ layout: soloLayout(3), sessions: [corpse(3)] });
      const { appFiles, state } = captureFiles(hugeLog());
      state.throwOnWrite = true;

      const workspace = await boot(appFiles, fake);

      // Boot completed and the captures it parsed are still in hand; the next
      // boot simply tries the rewrite again.
      expect(workspace.controller.deadPaneResumeTitle(3)).toBe("Captured conversation");
    });
  });
});
