/**
 * The menubar's join to the workspace, asserted at the mount site.
 *
 * `Menubar.test.tsx` proves the bar behaves like a menubar; this file proves
 * each row is wired to the action it names — the same call the rail, the pane
 * toolbar or a keyboard shortcut already makes. A menu that opens beautifully
 * and does the wrong thing is the failure this guards against.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest, PluginSurfaces } from "../plugins/manifest";
import { PluginsStore } from "../plugins/registry";
import { SettingsStore } from "../settings/SettingsStore";
import type { Layout } from "../state/layout";
import type {
  SidebarTabModel,
  WorkspaceSnapshot,
} from "../workspace/WorkspaceController";
import { fixtureWorkspace } from "./fixtureWorkspace";

const { readManifest } = vi.hoisted(() => ({
  readManifest: vi.fn(async (_folder: string): Promise<string | null> => null),
}));
vi.mock("../plugins/native", () => ({
  tauriPluginNative: {
    readManifest,
    readRuntime: async () => null,
    probe: async () => "",
    spawn: async () => 0,
    stderrTail: async () => "",
  },
}));

vi.mock("../sidebar/Sidebar", () => ({
  Sidebar: () => <div data-testid="workspace-sidebar" />,
}));
vi.mock("../terminal/TerminalPane", () => ({
  TerminalPane: ({ sessionId }: { sessionId: number }) => (
    <div data-session-id={sessionId} data-testid="workspace-terminal">
      {/* xterm builds a helper textarea and `terminal.focus()` focuses it, so
          the stand-in carries one: focus has to be able to land somewhere. */}
      <textarea className="xterm-helper-textarea" readOnly value="" />
    </div>
  ),
}));

import App from "../App";

const CWD = "C:\\Dev\\TermX\\ui";

function tab(): SidebarTabModel {
  return {
    id: "tab-1",
    groupId: null,
    title: "PowerShell · ui",
    color: "blue",
    fill: "off",
    primarySessionId: 7,
    sessionIds: [7],
    status: "live",
    activity: "idle",
    profile: "powershell",
    cwd: CWD,
  } as SidebarTabModel;
}

function snapshot(
  paneState: Record<string, unknown> = { status: "live", exitCode: null },
): WorkspaceSnapshot {
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
    paneStates: { 7: paneState },
    activeTabId: active.id,
    activeSessionId: 7,
    windowIds: ["main"],
    persistence: { saving: false, error: null },
    notice: null,
  } as unknown as WorkspaceSnapshot;
}

function harness(
  overrides: Record<string, unknown> = {},
  parts: Record<string, unknown> = {},
) {
  const current = (overrides.snapshot as WorkspaceSnapshot | undefined) ?? snapshot();
  const controller = {
    windowId: "main",
    attachments: {
      attach: vi.fn(),
      onError: vi.fn(() => () => undefined),
      close: vi.fn(),
    },
    getSnapshot: () => current,
    subscribe: () => () => undefined,
    dispose: vi.fn(),
    flush: vi.fn(async () => undefined),
    activateTab: vi.fn(),
    renameTab: vi.fn(),
    recolorTab: vi.fn(),
    moveTab: vi.fn(),
    moveItemToWindow: vi.fn(() => "aux-1"),
    reorderGroup: vi.fn(),
    createGroup: vi.fn(),
    renameGroup: vi.fn(),
    renameWindow: vi.fn(),
    toggleGroup: vi.fn(),
    createTab: vi.fn(async () => undefined),
    createTabInNewWindow: vi.fn(async () => undefined),
    setFocusedPane: vi.fn(),
    duplicateTab: vi.fn(),
    openFolderHere: vi.fn(),
    closeLiveTab: vi.fn(),
    closeGroup: vi.fn(),
    dismissDeadTab: vi.fn(),
    splitPane: vi.fn(async () => null),
    closePane: vi.fn(async () => undefined),
    resizePane: vi.fn(),
    reportSessionCwd: vi.fn(),
    setFolderSearchHandler: vi.fn(),
    createTabWithCwd: vi.fn(async () => undefined),
    createTabViaNativeDialog: vi.fn(async () => undefined),
    mergeTabs: vi.fn(),
    popOutPane: vi.fn(),
    relaunchPlugin: vi.fn(),
    openPlugin: vi.fn(async () => undefined),
    openPluginTab: vi.fn(async () => undefined),
    resumeSession: vi.fn(async () => undefined),
    sessionDims: vi.fn(() => ({})),
    paneTitles: vi.fn(() => ({})),
    paneCwds: vi.fn(() => ({})),
    sessionCwd: vi.fn(() => CWD),
    sessionProfile: vi.fn(() => "powershell"),
    sshPaneInfo: vi.fn(() => null),
    capturedConversation: vi.fn(() => null),
    resumedSessionKeyForTab: vi.fn(() => null),
    resumedEntries: vi.fn(() => []),
    rebindResumedTab: vi.fn(),
    setResumeBootListener: vi.fn(),
    markTabSeen: vi.fn(),
    ...overrides,
  };
  return {
    controller,
    workspace: fixtureWorkspace({
      controller,
      client: { close: vi.fn() },
      ...parts,
    }),
  };
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  if (root) {
    const current = root;
    root = null;
    await act(async () => current.unmount());
  }
  document.body.replaceChildren();
});

async function unmount() {
  if (root) {
    const current = root;
    root = null;
    await act(async () => current.unmount());
  }
  container.replaceChildren();
}

async function mount(workspace: ReturnType<typeof harness>["workspace"]) {
  root = createRoot(container);
  await act(async () => root!.render(<App bootstrap={async () => workspace} />));
}

async function click(element: Element | null) {
  if (!element) {
    throw new Error("nothing to click");
  }
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Open a bar menu and click one of its rows. */
async function pick(menuId: string, rowId: string) {
  await click(container.querySelector(`.menubar__item[data-menu-id='${menuId}']`));
  await click(container.querySelector(`.menubar__row[data-row-id='${rowId}']`));
}

function rowOf(rowId: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `.menubar__row[data-row-id='${rowId}']`,
  );
}

describe("App — the menubar in the header", () => {
  it("mounts the bar in the header, after the window name", async () => {
    const { workspace } = harness();
    await mount(workspace);
    const header = container.querySelector(".app-header");
    const children = [...(header?.children ?? [])].map((child) => child.className);
    expect(children[0]).toContain("app-brand");
    expect(children[1]).toContain("app-subtitle");
    expect(children[2]).toContain("app-header__divider");
    expect(children[3]).toContain("menubar");
    expect(
      [...container.querySelectorAll(".menubar__item")].map(
        (item) => item.textContent?.replace("▾", "").trim(),
      ),
    ).toEqual(["Workspace", "View", "Plugins", "Settings"]);
  });
});

describe("App — the Workspace menu runs the workspace's own actions", () => {
  it("New tab creates one in the active tab's group", async () => {
    const { controller, workspace } = harness();
    await mount(workspace);
    await pick("workspace", "new-tab");
    expect(controller.createTab).toHaveBeenCalledExactlyOnceWith({
      groupId: null,
      profile: null,
    });
  });

  it("Open folder as tab… raises the folder searcher", async () => {
    const { workspace } = harness();
    await mount(workspace);
    expect(container.querySelector(".folder-search")).toBeNull();
    await pick("workspace", "open-folder");
    expect(container.querySelector(".folder-search")).not.toBeNull();
  });

  it("Split right and Split down split the FOCUSED pane", async () => {
    const { controller, workspace } = harness();
    await mount(workspace);
    await pick("workspace", "split-right");
    expect(controller.splitPane).toHaveBeenCalledExactlyOnceWith("tab-1", 7, "row");
    await pick("workspace", "split-down");
    expect(controller.splitPane).toHaveBeenNthCalledWith(2, "tab-1", 7, "col");
  });

  it(
    "Close pane goes through the SAME Ctrl+Shift+W path the keyboard uses, so " +
      "a live pane still gets its confirmation instead of just vanishing",
    async () => {
      const { workspace } = harness();
      await mount(workspace);
      const seen: KeyboardEvent[] = [];
      const spy = (event: Event) => seen.push(event as KeyboardEvent);
      window.addEventListener("keydown", spy, true);
      try {
        await pick("workspace", "close-pane");
      } finally {
        window.removeEventListener("keydown", spy, true);
      }
      const sent = seen.find((event) => event.key.toLowerCase() === "w");
      expect(sent?.ctrlKey).toBe(true);
      expect(sent?.shiftKey).toBe(true);
      // SplitLayout owns the rest: a live pane raises its confirm dialog.
      expect(container.querySelector(".split-dialog")).not.toBeNull();
    },
  );

  it(
    "New window asks the controller for one — ONE structural write, so no " +
      "layout diff can pick up a tab something else created mid-await",
    async () => {
      const { controller, workspace } = harness();
      await mount(workspace);
      await pick("workspace", "new-window");

      expect(controller.createTabInNewWindow).toHaveBeenCalledExactlyOnceWith({
        profile: null,
      });
      // The tab the user is standing in must not move, and nothing may be
      // created here first and shipped out afterwards.
      expect(controller.createTab).not.toHaveBeenCalled();
      expect(controller.moveItemToWindow).not.toHaveBeenCalled();
    },
  );

  it("Rename window opens the header's own name editor", async () => {
    const { workspace } = harness();
    await mount(workspace);
    expect(container.querySelector("[aria-label='Name this window']")).toBeNull();
    await pick("workspace", "rename-window");
    expect(container.querySelector("[aria-label='Name this window']")).not.toBeNull();
  });

  it("greys out the SPLIT rows when the focused pane is not alive", async () => {
    const { workspace } = harness({
      snapshot: snapshot({ status: "exited", exitCode: 0 }),
    });
    await mount(workspace);
    await click(container.querySelector(".menubar__item[data-menu-id='workspace']"));
    expect(rowOf("split-right")?.disabled).toBe(true);
    expect(rowOf("split-down")?.disabled).toBe(true);
    expect(rowOf("new-tab")?.disabled).toBe(false);
  });

  it(
    "keeps Close pane reachable on a plugin panel and on a dead terminal — " +
      "the Ctrl+Shift+W it prints closes both, so greying it would make the " +
      "menu contradict the keyboard beside it",
    async () => {
      for (const paneState of [
        { status: "plugin", pluginId: "recall", pluginHealth: "up" },
        { status: "exited", exitCode: 1 },
      ]) {
        const { workspace } = harness({ snapshot: snapshot(paneState) });
        await mount(workspace);
        await click(
          container.querySelector(".menubar__item[data-menu-id='workspace']"),
        );
        expect(rowOf("close-pane")?.disabled, JSON.stringify(paneState)).toBe(false);
        expect(rowOf("split-right")?.disabled).toBe(true);
        await unmount();
      }
    },
  );

  it("greys Close pane only when there is no focused pane at all", async () => {
    const empty = snapshot();
    (empty as { paneStates: Record<number, unknown> }).paneStates = {};
    const { workspace } = harness({ snapshot: empty });
    await mount(workspace);
    await click(container.querySelector(".menubar__item[data-menu-id='workspace']"));
    expect(rowOf("close-pane")?.disabled).toBe(true);
  });

  it("greys out Save session… when this window has no saved-sessions store", async () => {
    const { workspace } = harness();
    await mount(workspace);
    await click(container.querySelector(".menubar__item[data-menu-id='workspace']"));
    expect(rowOf("save-session")?.disabled).toBe(true);
  });

  it("Save session… raises the save dialog when there is a store", async () => {
    const entries: unknown[] = [];
    const saved = {
      subscribe: () => () => undefined,
      getSnapshot: () => entries,
      save: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    };
    const { workspace } = harness({}, { saved });
    await mount(workspace);
    await pick("workspace", "save-session");
    expect(container.querySelector(".save-session")).not.toBeNull();
  });
});

describe("App — the View menu drives the chrome it names", () => {
  it("prints each toggle's live state and writes the inverse", async () => {
    const settings = new SettingsStore();
    const { workspace } = harness({}, { settings });
    await mount(workspace);

    await click(container.querySelector(".menubar__item[data-menu-id='view']"));
    expect(
      [...container.querySelectorAll(".menubar__key")].map((key) => key.textContent),
    ).toEqual(["on", "on", "on"]);

    await click(rowOf("side-rail"));
    expect(settings.getSnapshot().sideRail).toBe(false);
    await pick("view", "conversations-rail");
    expect(settings.getSnapshot().conversationsRail).toBe(false);
    await pick("view", "status-bar");
    expect(settings.getSnapshot().statusBar).toBe(false);

    await click(container.querySelector(".menubar__item[data-menu-id='view']"));
    expect(
      [...container.querySelectorAll(".menubar__key")].map((key) => key.textContent),
    ).toEqual(["off", "off", "off"]);
  });

  it("hides the side rail and the status bar when their toggles are off", async () => {
    const settings = new SettingsStore();
    const { workspace } = harness({}, { settings });
    await mount(workspace);
    expect(container.querySelector("[data-testid='workspace-sidebar']")).not.toBeNull();
    expect(container.querySelector(".status-bar")).not.toBeNull();

    await pick("view", "side-rail");
    expect(container.querySelector("[data-testid='workspace-sidebar']")).toBeNull();
    // The bar is still there to put it back — that is the whole point of
    // hiding a surface from a MENU rather than from a keyboard trick.
    expect(container.querySelector(".menubar__item[data-menu-id='view']")).not.toBeNull();

    await pick("view", "status-bar");
    expect(container.querySelector(".status-bar")).toBeNull();
  });
});

describe("App — Settings", () => {
  it("opens the settings surface from the bar's last label", async () => {
    const { workspace } = harness();
    await mount(workspace);
    expect(container.querySelector(".settings-surface")).toBeNull();
    await click(container.querySelector(".menubar__item[data-menu-id='settings']"));
    expect(container.querySelector(".settings-surface")).not.toBeNull();
  });
});
/** A manifest with only the fields the launcher reads. */
function manifest(
  id: string,
  name: string,
  icon: string,
  surfaces?: PluginSurfaces,
): PluginManifest {
  return {
    manifest: 1,
    id,
    name,
    icon,
    start: { command: "node", args: [] },
    singleton: true,
    discovery: { runtimeFile: "runtime.json", healthPath: "/health" },
    panel: { path: "/" },
    ...(surfaces ? { surfaces } : {}),
  };
}

/**
 * Three registered plugins: one enabled and answering with an autostart flag
 * and a full set of surfaces, one enabled and silent with no surfaces field at
 * all, one switched off. Plus a registry entry TermX cannot name.
 */
function pluginsHarness() {
  const plugins = new PluginsStore({
    initial: {
      plugins: {
        recall: {
          path: "C:/p/recall",
          enabled: true,
          grants: [],
          // Lane P's field; read through an optional view until it lands.
          autostart: true,
        },
        showroom: { path: "C:/p/showroom", enabled: true, grants: [] },
        cockpit: { path: "C:/p/cockpit", enabled: false, grants: [] },
        mystery: { path: "C:/p/mystery", enabled: true, grants: [] },
      },
    } as unknown as { plugins: Record<string, never> },
  });
  const manifests: Record<string, PluginManifest> = {
    recall: manifest("recall", "Recall", "◈", {
      default: "split",
      allowed: ["tab", "split", "window"],
    }),
    // No `surfaces` field: the launcher must fall back to tab + split, tab
    // filled, exactly as Showroom behaved before the field existed.
    showroom: manifest("showroom", "Showroom", "▣"),
    cockpit: manifest("cockpit", "Client Cockpit", "◧"),
  };
  const current = snapshot();
  // A bound plugin pane is the only thing that reports a plugin's health.
  (current.paneStates as Record<number, unknown>)[8] = {
    status: "plugin",
    pluginId: "recall",
    pluginHealth: "up",
  };
  return harness(
    { snapshot: current },
    { plugins, pluginManifestFor: (id: string) => manifests[id] ?? null },
  );
}

async function openPluginsMenu() {
  await click(container.querySelector(".menubar__item[data-menu-id='plugins']"));
}

function pluginIds(): (string | undefined)[] {
  return [...container.querySelectorAll(".plugins-menu__row")].map(
    (item) => (item as HTMLElement).dataset.pluginId,
  );
}

describe("App — the Plugins launcher", () => {
  it("lists every registry entry it can name, sorted by name", async () => {
    const { workspace } = pluginsHarness();
    await mount(workspace);
    await openPluginsMenu();
    // `mystery` has no manifest: TermX cannot name it, so it has nothing to
    // put in a menu. Settings is where that is explained.
    expect(pluginIds()).toEqual(["cockpit", "recall", "showroom"]);
  });

  it("reads the dot from the registry and the live pane health", async () => {
    const { workspace } = pluginsHarness();
    await mount(workspace);
    await openPluginsMenu();
    const dot = (id: string) =>
      container.querySelector(`[data-plugin-id='${id}'] .plugins-menu__dot`)
        ?.className;
    expect(dot("recall")).toContain("--up");
    // Enabled, registered, and nothing is answering for it.
    expect(dot("showroom")).toContain("--down");
    expect(dot("cockpit")).toContain("--disabled");
  });

  it("resolves the chips through the manifest, defaults included", async () => {
    const { workspace } = pluginsHarness();
    await mount(workspace);
    await openPluginsMenu();
    const chips = (id: string) =>
      [...container.querySelectorAll(`[data-plugin-id='${id}'] .plugins-menu__chip`)]
        .map((chip) => `${chip.textContent}${
          chip.classList.contains("plugins-menu__chip--default") ? "*" : ""
        }`);
    expect(chips("recall")).toEqual(["Tab", "Split*", "Win"]);
    // No surfaces field at all: tab and split, tab by default.
    expect(chips("showroom")).toEqual(["Tab*", "Split"]);
    expect(chips("cockpit")).toEqual([]);
  });

  it("says which plugin starts with TermX", async () => {
    const { workspace } = pluginsHarness();
    await mount(workspace);
    await openPluginsMenu();
    expect(
      container.querySelector("[data-plugin-id='recall'] .plugins-menu__auto"),
    ).not.toBeNull();
    expect(
      container.querySelector("[data-plugin-id='showroom'] .plugins-menu__auto"),
    ).toBeNull();
  });

  it("opens through the controller's one entry point", async () => {
    const { controller, workspace } = pluginsHarness();
    await mount(workspace);
    await openPluginsMenu();
    await click(container.querySelector("[data-row-id='plugin-recall']"));
    // No surface: the manifest's default is the controller's to read.
    expect(controller.openPlugin).toHaveBeenCalledExactlyOnceWith("recall");

    await openPluginsMenu();
    await click(container.querySelector("[data-row-id='chip-showroom-split']"));
    expect(controller.openPlugin).toHaveBeenNthCalledWith(2, "showroom", "split");
  });

  it("sends a switched-off plugin and the foot row to Settings › Plugins", async () => {
    const { controller, workspace } = pluginsHarness();
    await mount(workspace);
    await openPluginsMenu();
    await click(container.querySelector("[data-row-id='plugin-cockpit']"));
    expect(controller.openPlugin).not.toHaveBeenCalled();
    expect(
      container
        .querySelector(".settings-surface__tab[data-section='plugins']")
        ?.getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("lands the foot row on the Plugins section too", async () => {
    const { workspace } = pluginsHarness();
    await mount(workspace);
    await openPluginsMenu();
    await click(container.querySelector("[data-row-id='manage-plugins']"));
    expect(
      container
        .querySelector(".settings-surface__tab[data-section='plugins']")
        ?.getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("opens plain Settings from the bar's own label, not on Plugins", async () => {
    const { workspace } = pluginsHarness();
    await mount(workspace);
    // Reaching Plugins once must not stick: the Settings label is its own
    // destination, and it is General.
    await openPluginsMenu();
    await click(container.querySelector("[data-row-id='manage-plugins']"));
    await click(container.querySelector(".settings-surface__back"));
    await click(container.querySelector(".menubar__item[data-menu-id='settings']"));
    expect(
      container
        .querySelector(".settings-surface__tab[data-section='general']")
        ?.getAttribute("aria-selected"),
    ).toBe("true");
  });
});
/**
 * Settings › Plugins → "Open as tab" is the OTHER caller of the one entry
 * point, and it lives on the same App.tsx line the menubar's does. It is
 * tested here, beside the launcher, because a stale wiring at that line fails
 * silently: the button still opens something, just always on the old tab-only
 * path, whatever surface the panel asked for.
 */
describe("App — Settings › Plugins opens through the same entry point", () => {
  it("passes the panel's requested surface straight to openPlugin", async () => {
    const { controller, workspace } = pluginsHarness();
    // A folder whose manifest is real, so the row is healthy enough to offer
    // the button at all (an unreadable folder shows a problem instead).
    readManifest.mockImplementation(async (folder: string) =>
      folder.endsWith("recall")
        ? JSON.stringify(
            manifest("recall", "Recall", "◈", {
              default: "split",
              allowed: ["tab", "split", "window"],
            }),
          )
        : null,
    );
    await mount(workspace);

    await click(container.querySelector(".menubar__item[data-menu-id='settings']"));
    await click(
      container.querySelector(".settings-surface__tab[data-section='plugins']"),
    );
    // describeFolder reads the manifest asynchronously.
    await act(async () => undefined);

    const open = container.querySelector("[aria-label='Open as tab: Recall']");
    expect(open, "the panel offered no Open button to press").not.toBeNull();
    await click(open);

    expect(controller.openPlugin).toHaveBeenCalledExactlyOnceWith("recall", "tab");
    // And never the old tab-only path, which would ignore the surface.
    expect(controller.openPluginTab).not.toHaveBeenCalled();
  });
});

describe("Menubar workspace — focus requests", () => {
  /**
   * "Already open somewhere → focus it" is only true if the PANE takes focus.
   * Switching the active tab alone leaves the ring on the pane the user left
   * and sends every keystroke to that terminal, which reads as the click
   * having done nothing at all.
   *
   * The controller has no DOM, so it publishes a request and App performs it.
   * These tests drive the real SplitLayout: the ring comes from App's focus
   * map, and the caret from the element a click would have landed on.
   */
  function twoPanes(
    focusRequest: { tabId: string; sessionId: number; seq: number } | null,
  ): WorkspaceSnapshot {
    const base = snapshot();
    const active = { ...tab(), sessionIds: [7, 8] } as SidebarTabModel;
    return {
      ...base,
      layout: {
        ...base.layout,
        tabs: {
          "tab-1": {
            ...base.layout.tabs["tab-1"]!,
            split: {
              kind: "split" as const,
              dir: "row" as const,
              sizes: [0.5, 0.5] as [number, number],
              children: [
                { kind: "pane" as const, sessionId: 7 },
                { kind: "pane" as const, sessionId: 8 },
              ],
            },
          },
        },
      },
      rootItems: [{ kind: "tab", tab: active }],
      ungroupedTabs: [active],
      paneStates: {
        7: { status: "live", exitCode: null },
        // A real panel, not a mock: an "up" plugin on a loopback origin is
        // what makes PluginPane draw the frame the caret has to reach.
        8: {
          status: "plugin",
          pluginId: "showroom",
          pluginHealth: "up",
          pluginUrl: "http://127.0.0.1:5051",
        },
      },
      focusRequest,
    } as unknown as WorkspaceSnapshot;
  }

  /** A harness that can publish a later snapshot, the way the daemon does. */
  function live(initial: WorkspaceSnapshot) {
    let snap = initial;
    const listeners = new Set<() => void>();
    const built = harness({
      snapshot: initial,
      getSnapshot: () => snap,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    });
    const publish = async (next: WorkspaceSnapshot) => {
      snap = next;
      await act(async () => {
        for (const fn of [...listeners]) fn();
      });
    };
    return { ...built, publish };
  }

  function pane(sessionId: number): HTMLElement {
    const found = container.querySelector<HTMLElement>(
      `.split-pane[data-session-id='${sessionId}']`,
    );
    if (!found) throw new Error(`no pane ${sessionId}`);
    return found;
  }

  it("moves the ring AND the caret onto the plugin panel it names", async () => {
    const { workspace, publish } = live(twoPanes(null));
    await mount(workspace);
    expect(pane(7).className).toContain("split-pane--focused");

    await publish(twoPanes({ tabId: "tab-1", sessionId: 8, seq: 1 }));

    expect(pane(8).className).toContain("split-pane--focused");
    // The frame, not the section: a section takes no caret, and a panel whose
    // ring moved but whose iframe never focused still swallows nothing.
    expect(document.activeElement).toBe(pane(8).querySelector("iframe"));
  });

  it("focuses a terminal pane where the caret really goes", async () => {
    const { workspace, publish } = live(twoPanes({ tabId: "tab-1", sessionId: 8, seq: 1 }));
    await mount(workspace);

    await publish(twoPanes({ tabId: "tab-1", sessionId: 7, seq: 2 }));

    expect(pane(7).className).toContain("split-pane--focused");
    expect(document.activeElement).toBe(pane(7).querySelector("textarea"));
  });

  it("acts on a request once, however often the snapshot is republished", async () => {
    const { workspace, publish } = live(twoPanes(null));
    await mount(workspace);
    await publish(twoPanes({ tabId: "tab-1", sessionId: 8, seq: 1 }));

    // The user goes back to the terminal, then something unrelated republishes.
    const shell = pane(7).querySelector<HTMLElement>("textarea")!;
    await act(async () => shell.focus());
    await publish(twoPanes({ tabId: "tab-1", sessionId: 8, seq: 1 }));

    // Re-serving a served request would yank the caret out from under them.
    expect(pane(7).className).toContain("split-pane--focused");
    expect(document.activeElement).toBe(shell);
  });

  it("ignores a request for a tab this window no longer has", async () => {
    const { workspace, publish } = live(twoPanes(null));
    await mount(workspace);

    await publish(twoPanes({ tabId: "tab-gone", sessionId: 8, seq: 1 }));

    expect(pane(7).className).toContain("split-pane--focused");
    expect(pane(8).className).not.toContain("split-pane--focused");
  });

  it("ignores a request for a pane that has left the layout", async () => {
    const { controller, workspace, publish } = live(twoPanes(null));
    await mount(workspace);

    await publish(twoPanes({ tabId: "tab-1", sessionId: 99, seq: 1 }));

    expect(pane(7).className).toContain("split-pane--focused");
    // The damage a missing pane does is not visible on screen: recording it
    // leaves every later split anchored on a session id the layout has never
    // heard of, which is exactly what the controller reads back here.
    const provider = controller.setFocusedPane.mock.calls
      .map((call: unknown[]) => call[0])
      .filter((first: unknown) => typeof first === "function")
      .at(-1) as (tabId: string) => number | null;
    expect(provider("tab-1")).toBeNull();
  });
});
