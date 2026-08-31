/**
 * App-level plugin wiring (plugin spec §2/§4, Phase 1 T8 phase 2): the plugin
 * snapshot and entry-point actions the Sidebar renders from, the manifest
 * lookup and Relaunch the SplitLayout needs to draw a panel, and the Settings
 * bundle — main window only, because plugin management writes
 * `plugins_v1.json` and only the main window may write it.
 *
 * The three heavy children are stubbed to capture their props: what is under
 * test is what App hands them, not how they render it.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_WINDOW_ID, type Layout } from "../state/layout";
import { PluginsStore, type PluginsV1 } from "../plugins/registry";
import type { SettingsSurfaceProps } from "../settings/SettingsSurface";
import type { SidebarProps } from "../sidebar/Sidebar";
import type { SplitLayoutProps } from "../split/SplitLayout";
import type {
  SidebarTabModel,
  WorkspaceSnapshot,
} from "../workspace/WorkspaceController";
import type { BootstrappedWorkspace } from "../workspace/bootstrapWorkspace";

const captured = vi.hoisted(() => ({
  sidebar: null as unknown,
  split: null as unknown,
  settings: null as unknown,
}));

vi.mock("../sidebar/Sidebar", () => ({
  Sidebar: (props: unknown) => {
    captured.sidebar = props;
    return <div data-testid="workspace-sidebar" />;
  },
}));
vi.mock("../split/SplitLayout", () => ({
  SplitLayout: (props: unknown) => {
    captured.split = props;
    return <div data-testid="workspace-split" />;
  },
}));
vi.mock("../settings/SettingsSurface", () => ({
  SettingsSurface: (props: unknown) => {
    captured.settings = props;
    return <div data-testid="workspace-settings" />;
  },
}));

import App from "../App";

function sidebarProps(): SidebarProps {
  if (!captured.sidebar) {
    throw new Error("the sidebar never rendered");
  }
  return captured.sidebar as SidebarProps;
}

function splitProps(): SplitLayoutProps {
  if (!captured.split) {
    throw new Error("no split layout rendered");
  }
  return captured.split as SplitLayoutProps;
}

function settingsProps(): SettingsSurfaceProps {
  if (!captured.settings) {
    throw new Error("the settings surface never rendered");
  }
  return captured.settings as SettingsSurfaceProps;
}

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

function snapshot(): WorkspaceSnapshot {
  const active = tab();
  const layout: Layout = {
    version: 3,
    auxWindows: {},
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
    paneStates: { 1: { status: "live", exitCode: null } },
    activeTabId: active.id,
    activeSessionId: 1,
    persistence: { saving: false, error: null },
    notice: null,
  };
}

/** Showroom installed and on — the Phase 1 plugin, from the bundled table. */
const INSTALLED: PluginsV1 = {
  plugins: { showroom: { path: "C:\\code\\showroom", enabled: true, grants: [] } },
};

interface Harness {
  workspace: BootstrappedWorkspace;
  openPluginTab: ReturnType<typeof vi.fn>;
  openPluginSplit: ReturnType<typeof vi.fn>;
  relaunchPlugin: ReturnType<typeof vi.fn>;
  plugins: PluginsStore;
}

function harness(
  options: { windowId?: string; registry?: PluginsV1 } = {},
): Harness {
  const current = snapshot();
  const openPluginTab = vi.fn(async () => "tab-2");
  const openPluginSplit = vi.fn(async () => 0x8000_0000);
  const relaunchPlugin = vi.fn(async () => undefined);
  const plugins = new PluginsStore({ initial: options.registry ?? INSTALLED });
  const controller = {
    windowId: options.windowId ?? MAIN_WINDOW_ID,
    attachments: {
      attach: vi.fn(),
      onError: vi.fn(() => () => undefined),
      close: vi.fn(),
    },
    getSnapshot: () => current,
    subscribe: () => () => undefined,
    dispose: vi.fn(),
    openPluginTab,
    openPluginSplit,
    relaunchPlugin,
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
    workspace: {
      controller,
      client: { close: vi.fn() },
      plugins,
    } as unknown as BootstrappedWorkspace,
    openPluginTab,
    openPluginSplit,
    relaunchPlugin,
    plugins,
  };
}

async function renderApp(fixture: Harness): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<App bootstrap={vi.fn(async () => fixture.workspace)} />)
  );
  return container;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  captured.sidebar = null;
  captured.split = null;
  captured.settings = null;
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("App plugin wiring — sidebar", () => {
  it("hands the sidebar every known plugin with its manifest name and glyph", async () => {
    await renderApp(harness());

    expect(sidebarProps().plugins).toEqual([
      { id: "showroom", name: "Showroom", icon: "🖼", enabled: true },
    ]);
  });

  it("reports a registered plugin that is switched off as disabled", async () => {
    await renderApp(harness({
      registry: {
        plugins: { showroom: { path: "C:\\code\\showroom", enabled: false, grants: [] } },
      },
    }));

    expect(sidebarProps().plugins?.map((plugin) => plugin.enabled)).toEqual([false]);
  });

  it("still names a bundled plugin nobody has installed, as disabled", async () => {
    await renderApp(harness({ registry: { plugins: {} } }));

    // The union with the bundled table is what lets a pane bound to a removed
    // plugin keep its glyph; `enabled: false` keeps it out of every menu.
    expect(sidebarProps().plugins).toEqual([
      { id: "showroom", name: "Showroom", icon: "🖼", enabled: false },
    ]);
  });

  it("republishes the snapshot when the registry changes", async () => {
    const fixture = harness();
    await renderApp(fixture);

    await act(async () => fixture.plugins.setEnabled("showroom", false));

    expect(sidebarProps().plugins?.[0]?.enabled).toBe(false);
  });

  it("opens a plugin tab through the controller", async () => {
    const fixture = harness();
    await renderApp(fixture);

    await act(async () => sidebarProps().actions.openPluginTab?.("showroom", null));

    expect(fixture.openPluginTab).toHaveBeenCalledWith("showroom", null);
  });

  it("splits a pane with a plugin through the controller", async () => {
    const fixture = harness();
    await renderApp(fixture);

    await act(async () =>
      sidebarProps().actions.openPluginSplit?.("tab-1", 1, "showroom", "row")
    );

    expect(fixture.openPluginSplit).toHaveBeenCalledWith("tab-1", 1, "showroom", "row");
  });
});

describe("App plugin wiring — split layout", () => {
  it("resolves the manifest of an installed plugin", async () => {
    await renderApp(harness());

    expect(splitProps().pluginManifestFor?.("showroom")?.name).toBe("Showroom");
  });

  it("resolves nothing for a plugin that is not installed", async () => {
    await renderApp(harness({ registry: { plugins: {} } }));

    // T6's contract: no manifest, no panel — the pane degrades to the
    // dismissible dead pane rather than framing a page it cannot name.
    expect(splitProps().pluginManifestFor?.("showroom")).toBeNull();
    expect(splitProps().pluginManifestFor?.("ghost")).toBeNull();
  });

  it("keeps resolving the manifest of a plugin the user switched off", async () => {
    await renderApp(harness({
      registry: {
        plugins: { showroom: { path: "C:\\code\\showroom", enabled: false, grants: [] } },
      },
    }));

    // Disabling is not removing: an open panel must not turn into a corpse
    // because its plugin was switched off in Settings.
    expect(splitProps().pluginManifestFor?.("showroom")?.name).toBe("Showroom");
  });

  it("relaunches a plugin pane through the controller", async () => {
    const fixture = harness();
    await renderApp(fixture);

    await act(async () => splitProps().actions.relaunchPlugin?.(0x8000_0000));

    expect(fixture.relaunchPlugin).toHaveBeenCalledWith(0x8000_0000);
  });
});

describe("App plugin wiring — settings", () => {
  it("gives the main window the plugins bundle, opening a plugin as a tab", async () => {
    const fixture = harness();
    const container = await renderApp(fixture);

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>("[data-testid='workspace-settings']")
        ?.click()
    );
    // The surface only mounts once Settings is open; drive it the way the
    // sidebar does.
    await act(async () => sidebarProps().onOpenSettings?.());

    const bundle = settingsProps().plugins;
    expect(bundle?.store).toBe(fixture.plugins);
    // The native seam is whatever the surface declares; what matters here is
    // that a seam is wired at all and that opening reaches the controller.
    expect(bundle?.native).toBeTruthy();

    bundle?.onOpen?.("showroom");
    expect(fixture.openPluginTab).toHaveBeenCalledWith("showroom");
  });

  it("withholds the bundle in an aux window, where the registry is not writable", async () => {
    const fixture = harness({ windowId: "aux-1" });
    await renderApp(fixture);
    await act(async () => sidebarProps().onOpenSettings?.());

    // Spec §2: the main window is the only writer of plugins_v1.json, so an
    // aux window gets the surface's "unavailable in this window" note.
    expect(settingsProps().plugins).toBeUndefined();
  });
});
