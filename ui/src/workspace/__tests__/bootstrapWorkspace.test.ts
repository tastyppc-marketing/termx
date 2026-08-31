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
    const fake = fakeClient();
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
