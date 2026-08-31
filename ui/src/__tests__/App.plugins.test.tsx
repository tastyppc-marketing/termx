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
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_WINDOW_ID, type Layout, type SplitNode } from "../state/layout";
import type { PluginManifest } from "../plugins/manifest";
import { tauriPluginNative } from "../plugins/native";
import { PluginsStore, type PluginsV1 } from "../plugins/registry";
import type { SettingsSurfaceProps } from "../settings/SettingsSurface";
import type { SidebarProps } from "../sidebar/Sidebar";
import type { SplitLayoutProps } from "../split/SplitLayout";
import type {
  PaneSessionState,
  SidebarTabModel,
  WorkspaceSnapshot,
} from "../workspace/WorkspaceController";
import type { BootstrappedWorkspace } from "../workspace/bootstrapWorkspace";
import {
  fixtureWorkspace,
  manifestFeed,
  type ManifestFeed,
} from "./fixtureWorkspace";

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

/**
 * One tab holding two panes side by side. The snapshot's `activeSessionId` is
 * the LEFTMOST leaf — that is what the controller publishes — so this fixture
 * is what separates "the pane the user is in" from "the first pane in the tab".
 */
function twoPaneSnapshot(): WorkspaceSnapshot {
  const base = snapshot();
  const active: SidebarTabModel = { ...tab(), sessionIds: [1, 5] };
  const split = {
    kind: "split" as const,
    dir: "row" as const,
    sizes: [0.5, 0.5] as [number, number],
    children: [
      { kind: "pane" as const, sessionId: 1 },
      { kind: "pane" as const, sessionId: 5 },
    ] as [SplitNode, SplitNode],
  };
  return {
    ...base,
    layout: {
      ...base.layout,
      tabs: { "tab-1": { ...base.layout.tabs["tab-1"]!, split } },
    },
    rootItems: [{ kind: "tab", tab: active }],
    ungroupedTabs: [active],
    paneStates: {
      1: { status: "live", exitCode: null },
      5: { status: "live", exitCode: null },
    },
    activeSessionId: 1,
  };
}

/**
 * A snapshot whose panes are Showroom panels at the given healths. One entry
 * per pane, so a plugin with two panes that disagree can be built.
 */
function pluginPaneSnapshot(
  ...healths: ReadonlyArray<"starting" | "up" | "down">
): WorkspaceSnapshot {
  const base = snapshot();
  const paneStates: Record<number, PaneSessionState> = {};
  healths.forEach((health, index) => {
    paneStates[0x8000_0000 + index] = {
      status: "plugin",
      exitCode: null,
      pluginId: "showroom",
      pluginUrl: null,
      pluginHealth: health,
    };
  });
  return { ...base, paneStates };
}

/**
 * A plugin that is NOT in the bundled table — the case a bundled-only lookup
 * can never see: registered from a folder that ships its own manifest.
 */
const NOTES_MANIFEST: PluginManifest = {
  manifest: 1,
  id: "notes",
  name: "Notes",
  icon: "🗒",
  start: { command: "node", args: ["server.js"] },
  singleton: true,
  discovery: { runtimeFile: "%APPDATA%\\Notes\\runtime.json", healthPath: "/health" },
  panel: { path: "/" },
};

const SHOWROOM_MANIFEST: PluginManifest = {
  manifest: 1,
  id: "showroom",
  name: "Showroom",
  icon: "🖼",
  start: { command: "node", args: ["server/showroom.js"] },
  singleton: true,
  discovery: { runtimeFile: "%APPDATA%\\Showroom\\runtime.json", healthPath: "/api/health" },
  panel: { path: "/" },
};

/**
 * Bootstrap's accessor as App sees it: ungated by `enabled`, folder manifests
 * ahead of the bundled table, null for a plugin it cannot name.
 */
function manifestAccessor(
  manifests: Record<string, PluginManifest>,
): (pluginId: string) => PluginManifest | null {
  return (pluginId) => manifests[pluginId] ?? null;
}

/** Showroom installed and on — the Phase 1 plugin, from the bundled table. */
const INSTALLED: PluginsV1 = {
  plugins: { showroom: { path: "C:\\code\\showroom", enabled: true, grants: [] } },
};

interface Harness {
  workspace: BootstrappedWorkspace;
  controller: { activateTab: unknown; moveItem: unknown };
  openPluginTab: ReturnType<typeof vi.fn>;
  openPluginSplit: ReturnType<typeof vi.fn>;
  relaunchPlugin: ReturnType<typeof vi.fn>;
  plugins: PluginsStore;
}

function harness(
  options: {
    windowId?: string;
    registry?: PluginsV1;
    snapshot?: WorkspaceSnapshot;
    /** Bootstrap's ungated manifest accessor; absent = not wired yet. */
    pluginManifestFor?: (pluginId: string) => PluginManifest | null;
    /** The "manifest cache landed" feed, when a test drives it. */
    manifests?: ManifestFeed;
  } = {},
): Harness {
  const current = options.snapshot ?? snapshot();
  const openPluginTab = vi.fn(async () => "tab-2");
  const openPluginSplit = vi.fn(async () => 0x8000_0000);
  const relaunchPlugin = vi.fn(async () => undefined);
  const plugins = new PluginsStore({ initial: options.registry ?? INSTALLED });
  const controller = {
    windowId: options.windowId ?? MAIN_WINDOW_ID,
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
    workspace: fixtureWorkspace({
      controller,
      client: { close: vi.fn() },
      // The registry under test, so these tests watch the same store App does.
      plugins,
      ...(options.pluginManifestFor
        ? { pluginManifestFor: options.pluginManifestFor }
        : {}),
      ...(options.manifests
        ? { subscribeManifests: options.manifests.subscribeManifests }
        : {}),
    }),
    controller,
    openPluginTab,
    openPluginSplit,
    relaunchPlugin,
    plugins,
  };
}

/// The root of the App most recently rendered, so a test can unmount it and
/// watch what App lets go of.
let mounted: Root | null = null;

async function renderApp(fixture: Harness): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = root;
  await act(async () =>
    root.render(<App bootstrap={vi.fn(async () => fixture.workspace)} />)
  );
  return container;
}

async function unmountApp(): Promise<void> {
  const root = mounted;
  mounted = null;
  if (root) {
    await act(async () => root.unmount());
  }
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

  it("names a non-bundled plugin through bootstrap's accessor", async () => {
    // Registered from a folder, absent from the bundled table: before the
    // accessor was wired this plugin appeared in no menu, ever, even though
    // the controller would happily open and title it.
    await renderApp(harness({
      registry: {
        plugins: { notes: { path: "C:\\code\\notes", enabled: true, grants: [] } },
      },
      pluginManifestFor: manifestAccessor({ notes: NOTES_MANIFEST }),
    }));

    expect(sidebarProps().plugins).toEqual([
      { id: "notes", name: "Notes", icon: "🗒", enabled: true },
      // Showroom still rides in from the bundled table, nameable but off.
      { id: "showroom", name: "Showroom", icon: "🖼", enabled: false },
    ]);
  });

  it("lists plugins by name, not by the order the registry file happens to hold", async () => {
    await renderApp(harness({
      registry: {
        plugins: {
          // Registry order is Showroom first; Notes must still sort ahead.
          showroom: { path: "C:\\code\\showroom", enabled: true, grants: [] },
          notes: { path: "C:\\code\\notes", enabled: true, grants: [] },
        },
      },
      pluginManifestFor: manifestAccessor({
        notes: NOTES_MANIFEST,
        showroom: SHOWROOM_MANIFEST,
      }),
    }));

    expect(sidebarProps().plugins?.map((plugin) => plugin.name)).toEqual([
      "Notes",
      "Showroom",
    ]);
  });

  it("drops a registered plugin the accessor cannot name", async () => {
    await renderApp(harness({
      registry: {
        plugins: { broken: { path: "C:\\code\\broken", enabled: true, grants: [] } },
      },
      pluginManifestFor: manifestAccessor({}),
    }));

    // A plugin TermX cannot name has nothing to put in a menu; Settings is
    // where the malformed manifest gets explained. Showroom still rides in
    // from the bundled table.
    expect(sidebarProps().plugins?.map((plugin) => plugin.id)).toEqual(["showroom"]);
  });

  it("republishes the snapshot when the registry changes", async () => {
    const fixture = harness();
    await renderApp(fixture);

    await act(async () => fixture.plugins.setEnabled("showroom", false));

    expect(sidebarProps().plugins?.[0]?.enabled).toBe(false);
  });

  // Opening as a TAB needs nothing from App, so the sidebar holds the
  // controller's own method — identity is the whole claim, and calling it
  // through `actions` to assert it was called would only be testing the mock.
  // Splitting is the opposite: App adapts it, per the plan's Task 8 wording,
  // because only App knows which pane holds focus. That one is a behaviour
  // test, below; the click path that reaches it is covered in
  // sidebar/__tests__/SidebarPlugins.test.tsx.
  it("hands the sidebar the controller's own open-as-tab entry point", async () => {
    const fixture = harness();
    await renderApp(fixture);

    expect(sidebarProps().actions.openPluginTab).toBe(fixture.openPluginTab);
  });

  // The split anchor CANNOT come from the snapshot: the controller publishes
  // `activeSessionId` as `firstSessionId(activeTab.split)`, the leftmost leaf,
  // while the pane the user is actually in lives in App's `focusByTab` — the
  // same source SplitLayout draws its focus ring from. Reading the snapshot
  // instead would split the leftmost pane of every multi-pane tab.
  it("anchors a plugin split on the focused pane, not the tab's first", async () => {
    const fixture = harness({ snapshot: twoPaneSnapshot() });
    await renderApp(fixture);

    // The user clicks into the second pane; SplitLayout reports it.
    await act(async () => splitProps().onFocusPane(5));
    // The sidebar still passes the anchor IT can see (the snapshot's leftmost).
    await act(async () =>
      sidebarProps().actions.openPluginSplit?.("tab-1", 1, "showroom", "row")
    );

    expect(fixture.openPluginSplit).toHaveBeenCalledWith("tab-1", 5, "showroom", "row");
  });

  it("falls back to the tab's first pane when no focus has been recorded", async () => {
    const fixture = harness({ snapshot: twoPaneSnapshot() });
    await renderApp(fixture);

    await act(async () =>
      sidebarProps().actions.openPluginSplit?.("tab-1", 1, "showroom", "row")
    );

    expect(fixture.openPluginSplit).toHaveBeenCalledWith("tab-1", 1, "showroom", "row");
  });

  it("passes the sidebar's own anchor through when the tab is already gone", async () => {
    const fixture = harness({ snapshot: twoPaneSnapshot() });
    await renderApp(fixture);

    // The layout moved under an open menu: App has no split to resolve against,
    // so the sidebar's guess is the best information left.
    await act(async () =>
      sidebarProps().actions.openPluginSplit?.("tab-gone", 7, "showroom", "row")
    );

    expect(fixture.openPluginSplit).toHaveBeenCalledWith("tab-gone", 7, "showroom", "row");
  });

  it("keeps every other sidebar action pointing at the controller", async () => {
    const fixture = harness();
    await renderApp(fixture);

    // The adapter overrides ONE member; nothing else may be dropped or rebound.
    expect(sidebarProps().actions.activateTab).toBe(fixture.controller.activateTab);
    expect(sidebarProps().actions.moveItem).toBe(fixture.controller.moveItem);
  });
});

describe("App plugin wiring — late manifests", () => {
  /**
   * Bootstrap fills its folder-manifest cache asynchronously: after the boot
   * budget, or a debounce past a registry change. Nothing about that lands in
   * React state, so without a subscription App keeps showing whatever the
   * bundled fallback said until some unrelated render happens to refresh it.
   */
  function lateHarness(): {
    fixture: Harness;
    feed: ManifestFeed;
    land(): void;
  } {
    const feed = manifestFeed();
    // Empty until the cache "lands", exactly like a folder not read yet.
    let resolved: Record<string, PluginManifest> = {};
    const fixture = harness({
      registry: {
        plugins: { notes: { path: "C:\\code\\notes", enabled: true, grants: [] } },
      },
      pluginManifestFor: (pluginId) => resolved[pluginId] ?? null,
      manifests: feed,
    });
    return {
      fixture,
      feed,
      land: () => {
        resolved = { notes: NOTES_MANIFEST };
      },
    };
  }

  it("picks up a manifest that lands after boot", async () => {
    const { fixture, feed, land } = lateHarness();
    await renderApp(fixture);

    // Before the cache lands, the folder plugin has no name to show.
    expect(sidebarProps().plugins?.map((plugin) => plugin.id)).toEqual(["showroom"]);

    land();
    await act(async () => feed.emit());

    expect(sidebarProps().plugins?.map((plugin) => plugin.name)).toEqual([
      "Notes",
      "Showroom",
    ]);
    expect(splitProps().pluginManifestFor?.("notes")?.name).toBe("Notes");
  });

  it("does not pick it up before the feed says so", async () => {
    const { fixture, land } = lateHarness();
    await renderApp(fixture);

    land();

    // No notification, no re-read: this is the bug's shape, and pinning it is
    // what proves the test above is driven by the feed and not by a stray
    // render that would have refreshed the memo anyway.
    expect(sidebarProps().plugins?.map((plugin) => plugin.id)).toEqual(["showroom"]);
  });

  it("lets go of the feed when the workspace unmounts", async () => {
    const { fixture, feed } = lateHarness();
    await renderApp(fixture);
    expect(feed.listenerCount()).toBe(1);

    await unmountApp();

    expect(feed.listenerCount()).toBe(0);
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

  it("resolves a non-bundled plugin's manifest through the accessor", async () => {
    await renderApp(harness({
      registry: {
        plugins: { notes: { path: "C:\\code\\notes", enabled: true, grants: [] } },
      },
      pluginManifestFor: manifestAccessor({ notes: NOTES_MANIFEST }),
    }));

    expect(splitProps().pluginManifestFor?.("notes")?.panel.path).toBe("/");
    expect(splitProps().pluginManifestFor?.("notes")?.icon).toBe("🗒");
  });

  it("still refuses a plugin the accessor can name but the registry has not got", async () => {
    await renderApp(harness({
      registry: { plugins: {} },
      pluginManifestFor: manifestAccessor({ notes: NOTES_MANIFEST }),
    }));

    // The presence gate outranks the accessor: a plugin the user REMOVED must
    // not keep dressing a pane just because its folder manifest still parses.
    expect(splitProps().pluginManifestFor?.("notes")).toBeNull();
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
    await renderApp(fixture);

    // The surface only mounts once Settings is open; drive it the way the
    // sidebar does.
    await act(async () => sidebarProps().onOpenSettings?.());

    const bundle = settingsProps().plugins;
    expect(bundle?.store).toBe(fixture.plugins);
    // The real Tauri seam, by identity: the panel reads a plugin folder's own
    // manifest through it, so a hand-rolled stand-in would read nothing.
    expect(bundle?.native).toBe(tauriPluginNative);

    bundle?.onOpen?.("showroom");
    expect(fixture.openPluginTab).toHaveBeenCalledWith("showroom");
  });

  it("reports the health of a plugin that has a panel open", async () => {
    const fixture = harness({ snapshot: pluginPaneSnapshot("up") });
    await renderApp(fixture);
    await act(async () => sidebarProps().onOpenSettings?.());

    expect(settingsProps().plugins?.health).toEqual({ showroom: "up" });
  });

  it("reports the worst state when a plugin's panels disagree", async () => {
    // One panel answering and one not is a broken plugin, and the down mark is
    // the reading the user has to see; the healthy pane must not mask it.
    const fixture = harness({ snapshot: pluginPaneSnapshot("up", "down") });
    await renderApp(fixture);
    await act(async () => sidebarProps().onOpenSettings?.());

    expect(settingsProps().plugins?.health?.["showroom"]).toBe("down");
  });

  it("reports no health for a plugin with nothing on screen", async () => {
    const fixture = harness();
    await renderApp(fixture);
    await act(async () => sidebarProps().onOpenSettings?.());

    // Installed but never opened: the panel draws no mark rather than claiming
    // a state nothing has observed.
    expect(Object.keys(settingsProps().plugins?.health ?? {})).toEqual([]);
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
