/**
 * The MAIN window's close path (T8 phase 3e; Opus R9 #4 / Grok R9 #2).
 *
 * Both of the stores behind a quit debounce their disk write — the plugin
 * registry by 800 ms — and the close handler used to flush neither, on any of
 * its branches. A Settings change (enable, disable, Add folder, Remove) or a
 * layout edit made inside that window simply died with the webview.
 *
 * What these tests pin is the ORDER, not the mere fact of a call: the writes
 * have to land BEFORE the window is allowed to go, and before `shutdown()`
 * takes away the daemon client that the layout half of `flush()` writes
 * through. An aux window has its own close (`manageAuxWindow`), which already
 * returns its items to main and flushes; it never reaches this path, and it
 * never writes the registry, because App withholds the Settings bundle from
 * every window but this one.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_WINDOW_ID, type Layout } from "../state/layout";
import { PluginsStore } from "../plugins/registry";
import { DEFAULT_SETTINGS } from "../settings/settings";
import { SettingsStore } from "../settings/SettingsStore";
import type {
  PaneSessionState,
  SidebarTabModel,
  WorkspaceSnapshot,
} from "../workspace/WorkspaceController";
import type { BootstrappedWorkspace } from "../workspace/bootstrapWorkspace";
import { fixtureWorkspace } from "./fixtureWorkspace";

/** Every step of a shutdown, in the order it actually happened. */
const calls = vi.hoisted(() => ({ log: [] as string[] }));

const tauri = vi.hoisted(() => ({
  handler: null as ((event: { preventDefault(): void }) => void) | null,
  close: vi.fn(async () => {
    calls.log.push("close");
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: tauri.close,
    requestUserAttention: vi.fn(async () => undefined),
    onCloseRequested: async (
      handler: (event: { preventDefault(): void }) => void,
    ) => {
      tauri.handler = handler;
      return () => {
        tauri.handler = null;
      };
    },
  }),
  UserAttentionType: { Critical: 1, Informational: 2 },
}));
vi.mock("../sidebar/Sidebar", () => ({
  Sidebar: () => <div data-testid="workspace-sidebar" />,
}));
vi.mock("../split/SplitLayout", () => ({
  SplitLayout: () => <div data-testid="workspace-split" />,
}));

import App from "../App";

function tab(): SidebarTabModel {
  return {
    id: "tab-1",
    groupId: null,
    title: "PowerShell · project",
    color: "blue",
    fill: "off",
    primarySessionId: 1,
    sessionIds: [1],
    status: "live",
    activity: "idle",
    profile: "powershell",
    cwd: "C:\\work\\project",
  };
}

/**
 * One tab, one pane. `pane` decides whether a session is still alive, which is
 * the ONLY input to the close decision when the setting is left at its
 * default: no live session takes the "silent" branch, a live one asks.
 */
function snapshot(pane: PaneSessionState): WorkspaceSnapshot {
  const active = tab();
  const layout: Layout = {
    version: 3,
    auxWindows: {},
    windowNames: {},
    groups: {},
    rootItems: [{ kind: "tab", id: active.id }],
    tabs: {
      [active.id]: {
        id: active.id,
        title: active.title,
        color: active.color,
        fill: active.fill,
        split: { kind: "pane" as const, sessionId: active.primarySessionId },
      },
    },
    activeTabId: active.id,
  };
  return {
    layout,
    rootItems: [{ kind: "tab", tab: active }],
    ungroupedTabs: [active],
    groups: [],
    paneStates: { 1: pane },
    activeTabId: active.id,
    activeSessionId: 1,
    persistence: { saving: false, error: null },
    notice: null,
  };
}

const LIVE: PaneSessionState = { status: "live", exitCode: null };
/** A Showroom panel: a pane with nothing alive behind it. */
const PLUGIN_PANE: PaneSessionState = {
  status: "plugin",
  exitCode: null,
  pluginId: "showroom",
  pluginUrl: null,
  pluginHealth: "up",
};

interface Harness {
  workspace: BootstrappedWorkspace;
  plugins: PluginsStore;
  flush: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
}

function harness(
  options: { pane?: PaneSessionState; onWindowClose?: "ask" | "stop-all" | "keep-running" } = {},
): Harness {
  const current = snapshot(options.pane ?? PLUGIN_PANE);
  // A real store with a real debounce, so a mutation made just before the
  // quit is genuinely still pending when the close arrives.
  const plugins = new PluginsStore({
    initial: {
      plugins: { showroom: { path: "C:\\code\\showroom", enabled: true, grants: [] } },
    },
    save: async () => {
      calls.log.push("plugins:save");
    },
  });
  const flush = vi.fn(async () => {
    calls.log.push("controller:flush");
  });
  const shutdown = vi.fn(() => {
    calls.log.push("shutdown");
  });
  const controller = {
    windowId: MAIN_WINDOW_ID,
    activateTab: vi.fn(),
    moveItem: vi.fn(() => true),
    attachments: {
      attach: vi.fn(),
      onError: vi.fn(() => () => undefined),
      close: vi.fn(),
    },
    getSnapshot: () => current,
    subscribe: () => () => undefined,
    dispose: vi.fn(),
    flush,
    openPluginTab: vi.fn(async () => "tab-2"),
    openPluginSplit: vi.fn(async () => 0x8000_0000),
    relaunchPlugin: vi.fn(async () => undefined),
    splitPane: vi.fn(async () => null),
    closePane: vi.fn(async () => undefined),
    resizePane: vi.fn(),
    popOutPane: vi.fn(),
    reportSessionCwd: vi.fn(),
    setFolderSearchHandler: vi.fn(),
    sessionDims: vi.fn(() => ({})),
    paneTitles: vi.fn(() => ({})),
    sessionCwd: vi.fn(() => null),
    resumedSessionKeyForTab: vi.fn(() => null),
    resumedEntries: vi.fn(() => []),
    rebindResumedTab: vi.fn(),
    setResumeBootListener: vi.fn(),
  };
  return {
    workspace: fixtureWorkspace({
      controller,
      client: { close: vi.fn(), shutdown },
      plugins,
      settings: new SettingsStore({
        initial: {
          ...DEFAULT_SETTINGS,
          ...(options.onWindowClose ? { onWindowClose: options.onWindowClose } : {}),
        },
      }),
    }),
    plugins,
    flush,
    shutdown,
  };
}

let mounted: Root | null = null;

async function renderApp(fixture: Harness): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = root;
  await act(async () =>
    root.render(<App bootstrap={vi.fn(async () => fixture.workspace)} />)
  );
}

/** Ask the window to close, the way the OS button does, and let it settle. */
async function requestClose(): Promise<{ preventDefault: ReturnType<typeof vi.fn> }> {
  const handler = tauri.handler;
  if (!handler) {
    throw new Error("App never registered a close handler");
  }
  const event = { preventDefault: vi.fn() };
  await act(async () => {
    handler(event);
    // The shutdown sequence is async and the stop-all branch waits 150 ms for
    // the shutdown frame; give the whole chain room to finish.
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  return event;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  calls.log.length = 0;
  tauri.handler = null;
  tauri.close.mockClear();
});

afterEach(async () => {
  const root = mounted;
  mounted = null;
  if (root) {
    await act(async () => root.unmount());
  }
  document.body.replaceChildren();
});

describe("main window close — pending writes are flushed first", () => {
  it("writes a just-added plugin folder before letting the window close", async () => {
    const fixture = harness();
    await renderApp(fixture);
    // Add folder, then quit inside the 800 ms debounce: nothing is on disk.
    fixture.plugins.add("notes", "C:\\code\\notes");

    const event = await requestClose();

    // Held: without the preventDefault the OS closes over the pending write.
    expect(event.preventDefault).toHaveBeenCalled();
    expect(calls.log).toEqual(["plugins:save", "controller:flush", "close"]);
  });

  it("flushes on the stop-all path before the daemon client goes away", async () => {
    const fixture = harness({ pane: LIVE, onWindowClose: "stop-all" });
    await renderApp(fixture);
    fixture.plugins.setEnabled("showroom", false);

    await requestClose();

    // The layout half of `flush()` writes THROUGH the client that
    // `shutdown()` closes, so the order here is the whole point.
    expect(calls.log).toEqual([
      "plugins:save",
      "controller:flush",
      "shutdown",
      "close",
    ]);
  });

  it("flushes the layout even with no plugin write outstanding", async () => {
    const fixture = harness();
    await renderApp(fixture);

    await requestClose();

    // An idle registry has nothing to write, so `plugins:save` is absent —
    // but the controller must still be flushed, and only then the close.
    expect(calls.log).toEqual(["controller:flush", "close"]);
  });
});
