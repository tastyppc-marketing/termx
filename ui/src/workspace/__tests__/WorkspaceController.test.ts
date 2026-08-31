import { describe, expect, it, vi } from "vitest";
import type { SessionAttachment, SessionAttachmentCallbacks } from "../../host/client";
import type { SessionInfo } from "../../host/protocol";
import type { EnsureUpResult } from "../../plugins/lifecycle";
import type { PluginManifest } from "../../plugins/manifest";
import {
  PaneBindingsStore,
  PLUGIN_PANE_MIN_ID,
  isPluginPaneId,
  type PluginPanesV1,
} from "../../plugins/paneBindings";
import { createLayoutStore } from "../../state/store";
import type { Item, Layout } from "../../state/layout";
import {
  PLUGIN_BIND_ADOPT_TIMEOUT_MS,
  PLUGIN_ENSURE_DEADLINE_MS,
  WorkspaceController,
  type WorkspaceAttachmentHub,
  type WorkspaceHostClient,
  type WorkspacePersistence,
  type WorkspacePluginHost,
} from "../WorkspaceController";
import { DEFAULT_SETTINGS, type TermxSettings } from "../../settings/settings";
import type { LlmSessionRecord } from "../../conversations/types";
import { UiStateStore } from "../uiState";

function session(id: number, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    profile: "powershell",
    cwd: `C:\\work\\project-${id}`,
    cols: 120,
    rows: 30,
    alive: true,
    pid: 1000 + id,
    ...overrides,
  };
}

function layout(): Layout {
  return {
    version: 3,
    auxWindows: {},
    groups: {
      group: {
        id: "group",
        name: "Work",
        collapsed: false,
        color: null,
        items: [{ kind: "tab", id: "tab-2" }],
      },
    },
    rootItems: [{ kind: "tab", id: "tab-1" }, { kind: "group", id: "group" }],
    tabs: {
      "tab-1": {
        id: "tab-1",
        title: null,
        color: "blue",
        fill: "off",
        split: { kind: "pane", sessionId: 1 },
      },
      "tab-2": {
        id: "tab-2",
        title: "Split",
        color: "cyan",
        fill: "off",
        split: {
          kind: "split",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [
            { kind: "pane", sessionId: 2 },
            { kind: "pane", sessionId: 3 },
          ],
        },
      },
    },
    activeTabId: "tab-1",
  };
}

/// The bundled Showroom manifest, inlined so these tests pin the controller's
/// behaviour rather than the registry's contents.
const SHOWROOM: PluginManifest = {
  manifest: 1,
  id: "showroom",
  name: "Showroom",
  icon: "🖼",
  start: { command: "node", args: ["server/showroom.js"] },
  singleton: true,
  discovery: {
    runtimeFile: "C:\\data\\Showroom\\runtime.json",
    healthPath: "/api/health",
  },
  panel: { path: "/" },
};

function runtimeUp(port = 7788): EnsureUpResult {
  return {
    ok: true,
    runtime: { port, token: "t", version: "1.0.0", url: `http://127.0.0.1:${port}` },
  };
}

/// One turn of the event loop: enough for every queued microtask (the bindings
/// store's save chain among them) to run.
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(options: {
  sessions?: SessionInfo[];
  initial?: Layout;
  closeSession?: (sessionId: number) => Promise<void>;
  pickFolder?: () => Promise<string | null>;
  settings?: Partial<TermxSettings>;
  uiState?: UiStateStore;
  createSession?: (createOptions: {
    profile: string | null;
    cwd: string | null;
    cols: number;
    rows: number;
  }) => Promise<SessionInfo>;
  /** Dead-pane resume lookup: cwd -> newest conversation record. */
  latestForCwd?: (cwd: string) => LlmSessionRecord | null;
  /** Exact per-pane capture: session id -> the conversation that pane ran. */
  capturedConversationFor?: (sessionId: number) => LlmSessionRecord | null;
  /** Which window slot this controller renders (multi-window Phase 1). */
  windowId?: string;
  /** Bindings the workspace boots with (plugin spec §4). */
  pluginBindings?: PluginPanesV1;
  /** Bindings-file writer; the default records into `events`. */
  savePluginPanes?: (text: string) => Promise<void>;
  /** A replica store (aux window): forwards instead of writing. */
  pluginPanesStore?: PaneBindingsStore;
  /** Manifests the workspace can open; the default knows Showroom only. */
  pluginManifests?: Record<string, PluginManifest>;
  ensureUp?: (pluginId: string) => Promise<EnsureUpResult>;
  /** Why a plugin cannot be opened; the host owns this text. */
  unavailableReason?: (pluginId: string) => string | null;
  /** Tab/group id source; a throwing one proves the open paths stay contained. */
  generateId?: () => string;
} = {}) {
  const exitListeners = new Set<(event: { sessionId: number; exitCode: number | null }) => void>();
  const closeListeners = new Set<(event: { sessionId: number }) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  const createSession = vi.fn(
    options.createSession ??
      (async (createOptions: {
        profile: string | null;
        cwd: string | null;
        cols: number;
        rows: number;
      }) => session(50, {
        profile: createOptions.profile ?? "powershell",
        cwd: createOptions.cwd,
        cols: createOptions.cols,
        rows: createOptions.rows,
      })),
  );
  const closeSession = vi.fn(options.closeSession ?? (async () => undefined));
  const client: WorkspaceHostClient = {
    createSession,
    closeSession,
    onSessionExited(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    onSessionClosed(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
  };
  const persistenceCalls: Array<{ layout: Layout; kind: "structural" | "active_tab" }> = [];
  /// Interleaved log of the two writes a plugin pane needs, in the order they
  /// really happened — the only way to prove the bindings file lands first.
  const events: string[] = [];
  /// The layout writer's own state, so a test can hold a write open or make
  /// one fail without touching the controller.
  const layoutWrites = { gate: null as Promise<void> | null, error: null as string | null };
  const persistence: WorkspacePersistence = {
    getSnapshot: () => ({ saving: false, error: layoutWrites.error }),
    subscribe: () => () => undefined,
    record(next, kind) {
      persistenceCalls.push({ layout: next, kind });
      events.push(`layout:${kind}`);
    },
    flush: async () => {
      if (layoutWrites.gate !== null) {
        await layoutWrites.gate;
      }
      events.push("layout:written");
    },
    dispose: vi.fn(),
  };
  const pluginWrites: string[] = [];
  const savePluginPanes = options.savePluginPanes
    ?? (async (text: string) => {
      pluginWrites.push(text);
    });
  const pluginPanes = options.pluginPanesStore ?? new PaneBindingsStore({
    initial: options.pluginBindings ?? {},
    save: async (text) => {
      events.push("bindings:start");
      await savePluginPanes(text);
      events.push("bindings:done");
    },
  });
  const manifests = options.pluginManifests ?? { showroom: SHOWROOM };
  const ensureUp = vi.fn(options.ensureUp ?? (async () => runtimeUp()));
  const plugins: WorkspacePluginHost = {
    manifestFor: (id: string) => manifests[id] ?? null,
    ensureUp,
    ...(options.unavailableReason
      ? { unavailableReason: options.unavailableReason }
      : {}),
  };
  let attachmentSnapshot = { sessions: {} };
  const writes: Array<[number, string | Uint8Array]> = [];
  const attachments: WorkspaceAttachmentHub = {
    sendInput: vi.fn((sessionId: number, data: string | Uint8Array) => {
      writes.push([sessionId, data]);
      return true;
    }),
    getSnapshot: () => attachmentSnapshot,
    subscribe: () => () => undefined,
    attachSession: vi.fn(async () => undefined),
    markExited: vi.fn(),
    forgetSession: vi.fn(),
    attach: vi.fn(async (sessionId: number, _callbacks?: SessionAttachmentCallbacks) => ({
      sessionId,
      nextOffset: 0n,
      sendInput: vi.fn(),
      resize: vi.fn(),
      detach: vi.fn(),
    } satisfies SessionAttachment)),
    noteBell: vi.fn(),
    markSeen: vi.fn(),
    onError: () => () => undefined,
    close: vi.fn(),
  };
  const ids = ["new-tab", "new-group", "later-tab"];
  const settingsValue: TermxSettings = { ...DEFAULT_SETTINGS, ...options.settings };
  const uiState = options.uiState ?? new UiStateStore();
  const store = createLayoutStore(options.initial ?? layout());
  const controller = new WorkspaceController({
    client,
    store,
    persistence,
    attachments,
    sessions: options.sessions ?? [session(1), session(2), session(3)],
    generateId: options.generateId ?? (() => ids.shift() ?? "fallback-id"),
    pickFolder: options.pickFolder,
    settings: { getSnapshot: () => settingsValue },
    uiState,
    pluginPanes,
    plugins,
    ...(options.latestForCwd
      ? { conversations: { latestForCwd: options.latestForCwd } }
      : {}),
    ...(options.capturedConversationFor
      ? { capturedConversationFor: options.capturedConversationFor }
      : {}),
    ...(options.windowId ? { windowId: options.windowId } : {}),
  });
  return {
    controller,
    store,
    layoutWrites,
    client,
    createSession,
    closeSession,
    persistence,
    persistenceCalls,
    attachments,
    uiState,
    writes,
    events,
    pluginPanes,
    pluginWrites,
    ensureUp,
    setAttachmentSnapshot(value: typeof attachmentSnapshot) {
      attachmentSnapshot = value;
    },
  };
}

describe("WorkspaceController projection", () => {
  it("derives titles and projects neutral root groups with their nesting depth", () => {
    const { controller } = harness();
    const snapshot = controller.getSnapshot();

    expect(snapshot.ungroupedTabs[0]).toMatchObject({
      title: "powershell · project-1",
      status: "live",
      primarySessionId: 1,
    });
    expect(snapshot.groups[0]).toMatchObject({
      color: null,
      name: "Work",
      depth: 1,
      parentGroupId: null,
    });
    expect(snapshot.layout.groups.group!.color).toBeNull();
    expect(snapshot.rootItems.map((item) => item.kind)).toEqual(["tab", "group"]);
    expect(snapshot.activeSessionId).toBe(1);
  });

  it("projects dead, missing, attach-error, pulse, and unread state out of band", () => {
    const dead = session(2, { alive: false, pid: null });
    const { controller, setAttachmentSnapshot } = harness({ sessions: [session(1), dead] });
    setAttachmentSnapshot({
      sessions: {
        1: {
          sessionId: 1,
          hostAttached: true,
          terminalAttached: false,
          active: true,
          unread: true,
          exited: false,
          exitCode: null,
          lostScrollback: false,
          attachError: null,
        },
        2: {
          sessionId: 2,
          hostAttached: false,
          terminalAttached: false,
          active: false,
          unread: false,
          exited: true,
          exitCode: 0,
          lostScrollback: false,
          attachError: "attach failed",
        },
      },
    });

    const snapshot = controller.getSnapshot();
    expect(snapshot.ungroupedTabs[0]?.activity).toBe("unread");
    expect(snapshot.groups[0]?.tabs[0]?.status).toBe("dead");
    expect(snapshot.groups[0]?.tabs[0]?.sessionIds).toEqual([2, 3]);
  });

  it("ranks a settled pane above unread and active — the tab needs a look", () => {
    const { controller, setAttachmentSnapshot } = harness();
    setAttachmentSnapshot({
      sessions: {
        1: {
          sessionId: 1,
          hostAttached: true,
          terminalAttached: false,
          active: true,
          unread: true,
          settled: true,
          exited: false,
          exitCode: null,
          lostScrollback: false,
          attachError: null,
        },
      },
    });

    expect(controller.getSnapshot().ungroupedTabs[0]?.activity).toBe("attention");
  });

  it("dates the attention mark from the oldest pane still waiting", () => {
    const { controller, setAttachmentSnapshot } = harness();
    const hubSession = (sessionId: number, settledAt: number | null) => ({
      sessionId,
      hostAttached: true,
      terminalAttached: false,
      active: false,
      unread: false,
      settled: settledAt !== null,
      settledAt,
      exited: false,
      exitCode: null,
      lostScrollback: false,
      attachError: null,
    });
    // The grouped tab holds panes 2 and 3: one finished long ago, one just now.
    // The tab has been waiting since the older one.
    setAttachmentSnapshot({
      sessions: {
        2: hubSession(2, 1_000),
        3: hubSession(3, 9_000),
      },
    });

    const tab = controller.getSnapshot().groups[0]?.tabs[0];
    expect(tab?.activity).toBe("attention");
    expect(tab?.attentionSince).toBe(1_000);
  });

  it("carries no attention date once the mark is gone", () => {
    const { controller, setAttachmentSnapshot } = harness();
    setAttachmentSnapshot({
      sessions: {
        1: {
          sessionId: 1,
          hostAttached: true,
          terminalAttached: false,
          active: false,
          unread: true,
          settled: false,
          settledAt: null,
          exited: false,
          exitCode: null,
          lostScrollback: false,
          attachError: null,
        },
      },
    });

    const tab = controller.getSnapshot().ungroupedTabs[0];
    expect(tab?.activity).toBe("unread");
    expect(tab?.attentionSince).toBeNull();
  });

  it("gives a lone pane its tab's rail title, split panes their own derivations", () => {
    const { controller } = harness();

    // tab-1 holds one pane and no custom name: rail derivation, same string.
    expect(controller.paneTitles("tab-1")).toEqual({
      1: "powershell · project-1",
    });

    // A rename must reach the pane's title bar too — the window may show
    // nothing else (Michael: "it needs to be the actual title of whatever's
    // in the side rail").
    controller.renameTab("tab-1", "prod box");
    expect(controller.paneTitles("tab-1")).toEqual({ 1: "prod box" });

    // tab-2 is a split: the tab name cannot tell the panes apart, so each
    // keeps its own profile · folder derivation even though the tab is named.
    const split = controller.paneTitles("tab-2");
    expect(Object.keys(split)).toEqual(["2", "3"]);
    expect(split[2]).not.toBe("Split");

    expect(controller.paneTitles("no-such-tab")).toEqual({});
  });

  it("forwards noteBell per pane and markTabSeen to every pane in the tab", () => {
    const { controller, attachments } = harness();

    controller.noteBell(2);
    expect(attachments.noteBell).toHaveBeenCalledWith(2);

    controller.markTabSeen("tab-2");
    expect(attachments.markSeen).toHaveBeenCalledWith(2);
    expect(attachments.markSeen).toHaveBeenCalledWith(3);

    controller.markTabSeen("no-such-tab");
    expect(attachments.markSeen).toHaveBeenCalledTimes(2);
  });
});

describe("WorkspaceController.resyncSessions (daemon-restart truth)", () => {
  it("flips vanished and corpse sessions dead and runs the full wind-down", () => {
    const { controller, attachments } = harness();

    // A restarted daemon: session 1 comes back as a corpse record (its
    // state.json row, alive=false), sessions 2 and 3 are simply unknown.
    controller.resyncSessions([
      session(1, { alive: false, pid: null, cwd: "C:\\daemon\\stale" }),
    ]);

    const snapshot = controller.getSnapshot();
    expect(snapshot.ungroupedTabs[0]?.status).toBe("dead");
    expect(snapshot.groups[0]?.tabs[0]?.status).toBe("dead");
    for (const sessionId of [1, 2, 3]) {
      expect(attachments.markExited).toHaveBeenCalledWith(sessionId, null);
    }
    // The cwd the UI tracked live outranks the daemon's persisted one, so the
    // dead pane's Restart lands where the user actually was.
    expect(snapshot.ungroupedTabs[0]?.cwd).toBe("C:\\work\\project-1");
  });

  it("unlocks Restart and Dismiss on the zombie panes it kills", async () => {
    const { controller, createSession, closeSession } = harness();

    // Before the resync the pane is a zombie: restart refuses as alive.
    expect(await controller.restartPane("tab-1", 1, "restart")).toBeNull();
    expect(controller.getSnapshot().notice).toBe("This terminal is still running.");

    controller.resyncSessions([]);

    const created = await controller.restartPane("tab-1", 1, "restart");
    expect(created).toBe(50);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "C:\\work\\project-1" }),
    );

    await controller.dismissDeadTab("tab-2");
    expect(closeSession).toHaveBeenCalledWith(2);
    expect(closeSession).toHaveBeenCalledWith(3);
  });

  it("adopts unknown rows and is a silent no-op when nothing changed", () => {
    const { controller, attachments } = harness();

    const publishes = vi.fn();
    controller.subscribe(publishes);
    // The same truth the map was seeded with: nothing to do, no publish.
    controller.resyncSessions([session(1), session(2), session(3)]);
    expect(publishes).not.toHaveBeenCalled();

    controller.resyncSessions([
      session(1),
      session(2),
      session(3),
      session(9, { alive: false, pid: null }),
    ]);
    expect(controller.sessionCwd(9)).toBe("C:\\work\\project-9");
    // Adopted dead rows referenced by no pane wind nothing down.
    expect(attachments.markExited).not.toHaveBeenCalled();
  });
});

describe("WorkspaceController mutations", () => {
  it("uses active debounce only for activation and structural writes for edits", () => {
    const { controller, persistenceCalls } = harness();

    controller.activateTab("tab-2");
    controller.renameTab("tab-2", "Renamed");
    controller.recolorTab("tab-2", "green");
    controller.toggleGroup("group");
    // Item indices, not group indices: the group already sits at 1 (after
    // tab-1), so this reorder is a no-op and writes nothing.
    controller.reorderGroup("group", 1);

    expect(persistenceCalls.map((call) => call.kind)).toEqual([
      "active_tab",
      "structural",
      "structural",
      "structural",
    ]);
    expect(controller.getSnapshot().groups[0]?.tabs[0]).toMatchObject({
      title: "Renamed",
      color: "green",
    });
  });

  it("creates folder-backed tabs with the next palette color and target group", async () => {
    const { controller, createSession, attachments, persistenceCalls } = harness({
      pickFolder: async () => "D:\\chosen",
      settings: { newTabPolicy: "ask-native" },
    });

    await controller.createTab({ groupId: "group", profile: "cmd" });

    expect(createSession).toHaveBeenCalledWith({
      profile: "cmd",
      cwd: "D:\\chosen",
      cols: 120,
      rows: 30,
      shellIntegration: true,
    });
    expect(attachments.attachSession).toHaveBeenCalledWith(50);
    expect(controller.getSnapshot().groups[0]?.tabs.at(-1)).toMatchObject({
      primarySessionId: 50,
      color: "green",
    });
    expect(persistenceCalls.at(-1)?.kind).toBe("structural");
  });

  it("treats folder-picker cancellation as a complete no-op", async () => {
    const { controller, createSession, persistenceCalls } = harness({
      pickFolder: async () => null,
      settings: { newTabPolicy: "ask-native" },
    });
    await controller.createTab({ groupId: null, profile: null });
    expect(createSession).not.toHaveBeenCalled();
    expect(persistenceCalls).toEqual([]);
  });

  it("duplicates and opens folders from the source profile, cwd, and group", async () => {
    const pickFolder = vi.fn(async () => "D:\\new-project");
    const duplicated = harness({ pickFolder });

    await duplicated.controller.duplicateTab("tab-2");

    expect(duplicated.createSession).toHaveBeenCalledWith({
      profile: "powershell",
      cwd: "C:\\work\\project-2",
      cols: 120,
      rows: 30,
      shellIntegration: true,
    });
    expect(duplicated.controller.getSnapshot().groups[0]?.tabs.at(-1)?.primarySessionId).toBe(50);

    const opened = harness({ pickFolder });
    await opened.controller.openFolderHere("tab-2");

    expect(pickFolder).toHaveBeenLastCalledWith({
      title: "Open folder",
      defaultPath: "C:\\work\\project-2",
    });
    expect(opened.createSession).toHaveBeenCalledWith({
      profile: "powershell",
      cwd: "D:\\new-project",
      cols: 120,
      rows: 30,
      shellIntegration: true,
    });
    expect(opened.controller.getSnapshot().groups[0]?.tabs.at(-1)?.primarySessionId).toBe(50);
  });

  it("falls back to the ungrouped root when an async target group closes", async () => {
    let releaseAttach!: () => void;
    const attachGate = new Promise<void>((resolve) => {
      releaseAttach = resolve;
    });
    const { controller, attachments } = harness({ pickFolder: async () => "D:\\chosen" });
    vi.mocked(attachments.attachSession).mockImplementation(() => attachGate);

    const creating = controller.createTab({ groupId: "group", profile: null });
    await Promise.resolve();
    await controller.closeGroup("group");
    releaseAttach();
    await creating;

    expect(controller.getSnapshot().groups).toEqual([]);
    expect(controller.getSnapshot().ungroupedTabs.at(-1)?.primarySessionId).toBe(50);
  });

  it("closes every pane sequentially before pruning a live tab", async () => {
    const order: number[] = [];
    const { controller, closeSession, persistenceCalls } = harness({
      closeSession: async (sessionId) => {
        order.push(sessionId);
      },
    });

    await controller.closeLiveTab("tab-2");

    expect(order).toEqual([2, 3]);
    expect(closeSession).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().layout.tabs["tab-2"]).toBeUndefined();
    expect(persistenceCalls.at(-1)?.kind).toBe("structural");
  });

  it("retains a pane whose close failed and reports a bounded notice", async () => {
    const { controller } = harness({
      closeSession: async (sessionId) => {
        if (sessionId === 3) {
          throw new Error("secret host detail");
        }
      },
    });

    await controller.closeLiveTab("tab-2");

    expect(controller.getSnapshot().groups[0]?.tabs[0]?.sessionIds).toEqual([3]);
    expect(controller.getSnapshot().notice).toBe("Some terminal sessions could not be closed.");
  });

  it("removes a group only after all of its sessions close", async () => {
    const { controller } = harness();
    await controller.closeGroup("group");
    expect(controller.getSnapshot().groups).toEqual([]);
    expect(controller.getSnapshot().layout.tabs["tab-2"]).toBeUndefined();
  });

  it("dismisses host-retained dead sessions but prunes missing sessions without a host call", async () => {
    const dead = session(2, { alive: false, pid: null });
    const { controller, closeSession } = harness({ sessions: [session(1), dead] });

    await controller.dismissDeadTab("tab-2");

    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith(2);
    expect(controller.getSnapshot().layout.tabs["tab-2"]).toBeUndefined();
  });
});

describe("WorkspaceController nested groups", () => {
  /// The fixture's group, plus a subgroup holding one more tab.
  function nested(settings?: Partial<TermxSettings>) {
    const base = layout();
    base.groups.sub = {
      id: "sub",
      name: "Clients",
      collapsed: false,
      color: null,
      items: [{ kind: "tab", id: "tab-3" }],
    };
    base.groups.group!.items.push({ kind: "group", id: "sub" });
    base.tabs["tab-3"] = {
      id: "tab-3",
      title: "Deep",
      color: "red",
      fill: "off",
      split: { kind: "pane", sessionId: 4 },
    };
    return harness({
      initial: base,
      sessions: [session(1), session(2), session(3), session(4)],
      ...(settings ? { settings } : {}),
    });
  }

  it("creates a subgroup under a parent and reports its id", () => {
    const { controller, persistenceCalls } = harness();

    const id = controller.createGroup("group", "Clients");

    expect(id).toBe("new-tab");
    expect(controller.getSnapshot().layout.groups[id!]).toMatchObject({
      name: "Clients",
      color: null,
      items: [],
    });
    expect(controller.getSnapshot().groups.map((group) => group.depth)).toEqual([1, 2]);
    expect(persistenceCalls.at(-1)?.kind).toBe("structural");
  });

  it("refuses a subgroup past maxGroupDepth without writing anything", () => {
    const { controller, persistenceCalls } = nested({ maxGroupDepth: 2 });

    expect(controller.createGroup("sub")).toBeNull();
    expect(controller.createGroup("ghost")).toBeNull();
    expect(persistenceCalls).toEqual([]);
    expect(controller.createGroup(null, "Root level")).not.toBeNull();
  });

  it("moves a tab into a subgroup and a group into another group", () => {
    const { controller } = nested();

    expect(controller.moveItem({ kind: "tab", id: "tab-1" }, "sub", 0)).toBe(true);
    expect(controller.getSnapshot().layout.groups.sub!.items).toEqual([
      { kind: "tab", id: "tab-1" },
      { kind: "tab", id: "tab-3" },
    ]);

    controller.createGroup(null, "Standalone");
    expect(controller.moveItem({ kind: "group", id: "new-tab" }, "group", 0)).toBe(true);
    expect(controller.getSnapshot().layout.groups.group!.items[0])
      .toEqual({ kind: "group", id: "new-tab" });
  });

  it("refuses a cyclic move and a move past the depth setting", () => {
    const { controller, persistenceCalls } = nested({ maxGroupDepth: 2 });
    const before = controller.getSnapshot().layout;

    const cycle: Item = { kind: "group", id: "group" };
    expect(controller.moveItem(cycle, "sub", 0)).toBe(false);
    // group > sub is already 2 levels tall, so it cannot go under another group.
    controller.createGroup(null, "Elsewhere");
    expect(controller.moveItem(cycle, "new-tab", 0)).toBe(false);
    expect(controller.getSnapshot().layout.groups.group).toBe(before.groups.group);
    expect(persistenceCalls.filter((call) => call.kind === "structural")).toHaveLength(1);
  });

  it("keep-children delete splices the subtree into the parent in place", async () => {
    const { controller, closeSession } = nested();

    await controller.deleteGroup("group", "keep-children");

    expect(closeSession).not.toHaveBeenCalled();
    expect(controller.getSnapshot().layout.rootItems).toEqual([
      { kind: "tab", id: "tab-1" },
      { kind: "tab", id: "tab-2" },
      { kind: "group", id: "sub" },
    ]);
    expect(controller.getSnapshot().layout.groups.group).toBeUndefined();
    expect(controller.getSnapshot().layout.tabs["tab-3"]).toBeDefined();
  });

  it("close-tabs delete closes every session in the subtree, then removes it", async () => {
    const closed: number[] = [];
    const { controller } = nested();
    const nestedWithSpy = harness({
      initial: controller.getSnapshot().layout,
      sessions: [session(1), session(2), session(3), session(4)],
      closeSession: async (sessionId) => {
        closed.push(sessionId);
      },
    });

    await nestedWithSpy.controller.deleteGroup("group", "close-tabs");

    expect(closed).toEqual([2, 3, 4]);
    const layoutAfter = nestedWithSpy.controller.getSnapshot().layout;
    expect(layoutAfter.groups).toEqual({});
    expect(layoutAfter.tabs["tab-2"]).toBeUndefined();
    expect(layoutAfter.tabs["tab-3"]).toBeUndefined();
    expect(layoutAfter.rootItems).toEqual([{ kind: "tab", id: "tab-1" }]);
  });

  it("recolors a group and sets a tab fill through the persisted blob", () => {
    const { controller, persistenceCalls } = harness();

    controller.recolorGroup("group", "magenta");
    controller.setTabFill("tab-1", "strong");

    const persisted = persistenceCalls.at(-1)!.layout;
    expect(persisted.groups.group!.color).toBe("magenta");
    expect(persisted.tabs["tab-1"]!.fill).toBe("strong");
    expect(controller.getSnapshot().groups[0]?.color).toBe("magenta");
    expect(controller.getSnapshot().ungroupedTabs[0]?.fill).toBe("strong");
  });
});

describe("WorkspaceController pane states", () => {
  it("projects live, dead-with-exit-code, and missing sessions per pane", () => {
    const dead = session(2, { alive: false, pid: null });
    const { controller, setAttachmentSnapshot } = harness({
      sessions: [session(1), dead],
    });
    setAttachmentSnapshot({
      sessions: {
        2: {
          sessionId: 2,
          hostAttached: false,
          terminalAttached: false,
          active: false,
          unread: false,
          exited: true,
          exitCode: 5,
          lostScrollback: false,
          attachError: null,
        },
      },
    });

    const { paneStates } = controller.getSnapshot();
    expect(paneStates[1]).toEqual({
      status: "live",
      exitCode: null,
      suspended: false,
      attachGeneration: 0,
      historyBefore: 0n,
    });
    expect(paneStates[2]).toEqual({ status: "dead", exitCode: 5 });
    expect(paneStates[3]).toEqual({ status: "missing", exitCode: null });
  });
});

describe("WorkspaceController split actions", () => {
  it("splits a live pane by duplicating its session and focuses the result", async () => {
    const { controller, createSession, attachments, persistenceCalls } = harness();

    const created = await controller.splitPane("tab-1", 1, "row");

    expect(created).toBe(50);
    expect(createSession).toHaveBeenCalledWith({
      profile: "powershell",
      cwd: "C:\\work\\project-1",
      cols: 120,
      rows: 30,
      shellIntegration: true,
    });
    expect(attachments.attachSession).toHaveBeenCalledWith(50);
    expect(controller.getSnapshot().layout.tabs["tab-1"]?.split).toEqual({
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        { kind: "pane", sessionId: 1 },
        { kind: "pane", sessionId: 50 },
      ],
    });
    expect(persistenceCalls.at(-1)?.kind).toBe("structural");
    expect(controller.getSnapshot().paneStates[50]).toEqual({
      status: "live",
      exitCode: null,
      suspended: false,
      attachGeneration: 0,
      historyBefore: 0n,
    });
  });

  it("refuses to split a pane whose session is not alive", async () => {
    const dead = session(1, { alive: false, pid: null });
    const { controller, createSession } = harness({
      sessions: [dead, session(2), session(3)],
    });

    const created = await controller.splitPane("tab-1", 1, "row");

    expect(created).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(controller.getSnapshot().notice).toBe("Only a running terminal can be split.");
  });

  it("refuses a depth-capped split before creating any session", async () => {
    const initial: Layout = {
      version: 3,
      auxWindows: {},
      groups: {},
      rootItems: [{ kind: "tab", id: "deep" }],
      tabs: {
        deep: {
          id: "deep",
          title: null,
          color: "blue",
          fill: "off",
          split: {
            kind: "split",
            dir: "row",
            sizes: [0.5, 0.5],
            children: [
              { kind: "pane", sessionId: 5 },
              {
                kind: "split",
                dir: "col",
                sizes: [0.5, 0.5],
                children: [
                  { kind: "pane", sessionId: 6 },
                  {
                    kind: "split",
                    dir: "row",
                    sizes: [0.5, 0.5],
                    children: [
                      { kind: "pane", sessionId: 7 },
                      {
                        kind: "split",
                        dir: "col",
                        sizes: [0.5, 0.5],
                        children: [
                          { kind: "pane", sessionId: 8 },
                          { kind: "pane", sessionId: 9 },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      activeTabId: "deep",
    };
    const { controller, createSession } = harness({
      initial,
      sessions: [session(5), session(6), session(7), session(8), session(9)],
    });

    const created = await controller.splitPane("deep", 9, "row");

    expect(created).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(controller.getSnapshot().notice).toBe(
      "This pane is already split as deep as it can go.",
    );
  });

  it("rolls back the created session when the layout refuses the split", async () => {
    const { controller, createSession, closeSession, attachments } = harness();
    createSession.mockImplementationOnce(async (createOptions) => {
      // The pane disappears while the host is creating the new session.
      await controller.closePane("tab-1", 1);
      return session(50, { cwd: createOptions.cwd });
    });

    const created = await controller.splitPane("tab-1", 1, "row");

    expect(created).toBeNull();
    expect(closeSession).toHaveBeenCalledWith(50);
    expect(attachments.forgetSession).toHaveBeenCalledWith(50);
    expect(controller.getSnapshot().layout.tabs["tab-1"]).toBeUndefined();
    expect(controller.getSnapshot().paneStates[50]).toBeUndefined();
    expect(controller.getSnapshot().notice).toBe("The pane could not be split.");
  });

  it("keeps tracking the created session when the rollback close itself fails", async () => {
    const { controller, createSession, closeSession, attachments } = harness({
      closeSession: async (sessionId) => {
        if (sessionId === 50) {
          throw new Error("host busy");
        }
      },
    });
    createSession.mockImplementationOnce(async (createOptions) => {
      // The pane disappears while the host is creating the new session.
      await controller.closePane("tab-1", 1);
      return session(50, { cwd: createOptions.cwd });
    });

    const created = await controller.splitPane("tab-1", 1, "row");

    expect(created).toBeNull();
    expect(closeSession).toHaveBeenCalledWith(50);
    // The host still owns session 50 — it must NOT be forgotten into a leak.
    expect(attachments.forgetSession).not.toHaveBeenCalledWith(50);
    expect(controller.getSnapshot().notice).toBe("The pane could not be split.");
  });

  it("closes a pane pessimistically and collapses the split into the sibling", async () => {
    const { controller, closeSession, persistenceCalls } = harness();

    await controller.closePane("tab-2", 2);

    expect(closeSession).toHaveBeenCalledWith(2);
    expect(controller.getSnapshot().layout.tabs["tab-2"]?.split).toEqual({
      kind: "pane",
      sessionId: 3,
    });
    expect(persistenceCalls.at(-1)?.kind).toBe("structural");
  });

  it("keeps the pane when the host refuses to close its session", async () => {
    const { controller } = harness({
      closeSession: async () => {
        throw new Error("host detail");
      },
    });

    await controller.closePane("tab-2", 2);

    expect(controller.getSnapshot().layout.tabs["tab-2"]?.split.kind).toBe("split");
    expect(controller.getSnapshot().notice).toBe(
      "The terminal session could not be closed.",
    );
  });

  it("closes the tab when its last pane closes", async () => {
    const { controller } = harness();

    await controller.closePane("tab-1", 1);

    expect(controller.getSnapshot().layout.tabs["tab-1"]).toBeUndefined();
    expect(controller.getSnapshot().layout.rootItems).toEqual([
      { kind: "group", id: "group" },
    ]);
  });

  it("records a structural write for a real resize and nothing for a no-op", () => {
    const { controller, persistenceCalls } = harness();

    controller.resizePane("tab-2", [], [0.3, 0.7]);
    const afterResize = persistenceCalls.length;
    expect(
      (controller.getSnapshot().layout.tabs["tab-2"]?.split as {
        sizes: [number, number];
      }).sizes[0],
    ).toBeCloseTo(0.3);
    expect(persistenceCalls.at(-1)?.kind).toBe("structural");

    controller.resizePane("tab-1", [], [0.3, 0.7]);
    expect(persistenceCalls.length).toBe(afterResize);
  });
});

describe("WorkspaceController dead-pane relaunch", () => {
  const RESUME_ID = "7d9e2f10-3a4b-4c5d-8e6f-102938475650";
  const record = (cwd: string): LlmSessionRecord => ({
    provider: "claude",
    id: RESUME_ID,
    title: "Daemon work",
    cwd,
    filePath: "C:\\transcripts\\a.jsonl",
    updatedAtMs: 100,
    summary: null,
    recap: null,
  });

  it("resume relaunches in the dead pane's folder and types the resume command", async () => {
    const h = harness({
      sessions: [session(1), session(2), session(3, { alive: false, pid: null })],
      latestForCwd: (cwd) => record(cwd),
    });

    const pending = h.controller.restartPane("tab-2", 3, "resume");
    // Let createSession/attach settle, then report the new shell's prompt.
    for (let i = 0; i < 25; i += 1) {
      await Promise.resolve();
    }
    h.controller.reportSessionCwd(50, "C:\\work\\project-3", true);
    const created = await pending;

    expect(created).toBe(50);
    expect(h.createSession).toHaveBeenCalledWith({
      profile: "powershell",
      cwd: "C:\\work\\project-3",
      cols: 120,
      rows: 30,
      shellIntegration: true,
    });
    expect(h.writes).toEqual([[50, "claude --resume " + RESUME_ID + "\r"]]);
  });

  it("resume with no conversation degrades to a plain restart", async () => {
    const h = harness({
      sessions: [session(1), session(2), session(3, { alive: false, pid: null })],
      latestForCwd: () => null,
    });

    const created = await h.controller.restartPane("tab-2", 3, "resume");

    expect(created).toBe(50);
    expect(h.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "C:\\work\\project-3" }),
    );
    expect(h.writes).toEqual([]);
  });

  it("deadPaneResumeTitle names the conversation only for a dead pane with one", () => {
    const h = harness({
      sessions: [session(1), session(3, { alive: false, pid: null })],
      latestForCwd: (cwd) => record(cwd),
    });

    expect(h.controller.deadPaneResumeTitle(3)).toBe("Daemon work");
    expect(h.controller.deadPaneResumeTitle(1)).toBeNull(); // alive
    expect(h.controller.deadPaneResumeTitle(999)).toBeNull(); // unknown
  });

  it("deadPaneResumeTitle is null when the record's id cannot be resumed", () => {
    const h = harness({
      sessions: [session(3, { alive: false, pid: null })],
      latestForCwd: (cwd) => ({ ...record(cwd), id: "not a; valid id" }),
    });

    expect(h.controller.deadPaneResumeTitle(3)).toBeNull();
  });

  // A capture (tools/claude-hooks/termx-capture.py) pairs a pane with the
  // conversation it actually ran, so resume stops guessing "newest in this
  // folder" — which is wrong whenever two panes share a folder.
  const CAPTURED_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
  const captured = (
    overrides: Partial<LlmSessionRecord> = {},
  ): LlmSessionRecord => ({
    provider: "claude",
    id: CAPTURED_ID,
    title: "Captured conversation",
    cwd: "C:\\work\\project-3",
    filePath: "",
    updatedAtMs: 50,
    summary: null,
    recap: null,
    titleSource: "derived",
    ...overrides,
  });

  it("resumes the pane's captured conversation, not the newest one in its folder", async () => {
    const h = harness({
      sessions: [session(1), session(2), session(3, { alive: false, pid: null })],
      latestForCwd: (cwd) => record(cwd),
      capturedConversationFor: (id) => (id === 3 ? captured() : null),
    });

    expect(h.controller.deadPaneResumeTitle(3)).toBe("Captured conversation");

    const pending = h.controller.restartPane("tab-2", 3, "resume");
    for (let i = 0; i < 25; i += 1) {
      await Promise.resolve();
    }
    h.controller.reportSessionCwd(50, "C:\\work\\project-3", true);
    await pending;

    expect(h.writes).toEqual([[50, "claude --resume " + CAPTURED_ID + "\r"]]);
  });

  it("restarts a cwd-less corpse in the captured folder", async () => {
    const h = harness({
      sessions: [
        session(1),
        session(2),
        session(3, { alive: false, pid: null, cwd: null }),
      ],
      capturedConversationFor: () => captured({ cwd: "C:\\work\\captured" }),
    });

    const created = await h.controller.restartPane("tab-2", 3, "restart");

    expect(created).toBe(50);
    expect(h.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "C:\\work\\captured" }),
    );
  });

  it("offers a resume for a cwd-less corpse the folder lookup could never serve", () => {
    const h = harness({
      sessions: [session(3, { alive: false, pid: null, cwd: null })],
      latestForCwd: (cwd) => record(cwd),
      capturedConversationFor: () => captured({ cwd: null }),
    });

    expect(h.controller.deadPaneResumeTitle(3)).toBe("Captured conversation");
  });

  /**
   * The title only proves a button would appear. This proves the pane actually
   * comes BACK: a corpse from a pre-cwd-tracking daemon has no folder to look
   * in, so the capture is the only thing that can name the conversation, and
   * the id it names has to reach the shell as a typed command.
   */
  it("types the captured id when resuming a cwd-less corpse", async () => {
    const h = harness({
      sessions: [
        session(1),
        session(2),
        session(3, { alive: false, pid: null, cwd: null }),
      ],
      // The folder lookup is armed and would answer "Daemon work" for any
      // directory — but there is no directory, so only the capture can serve.
      latestForCwd: (cwd) => record(cwd),
      capturedConversationFor: () => captured({ cwd: null }),
    });

    const pending = h.controller.restartPane("tab-2", 3, "resume");
    for (let i = 0; i < 25; i += 1) {
      await Promise.resolve();
    }
    h.controller.reportSessionCwd(50, "C:\\work\\wherever", true);
    await pending;

    expect(h.writes).toEqual([[50, "claude --resume " + CAPTURED_ID + "\r"]]);
  });

  it("ignores a capture whose id could not be typed and falls back to the folder", () => {
    const h = harness({
      sessions: [session(3, { alive: false, pid: null })],
      latestForCwd: (cwd) => record(cwd),
      capturedConversationFor: () => captured({ id: "not a; valid id" }),
    });

    expect(h.controller.deadPaneResumeTitle(3)).toBe("Daemon work");
  });

  it("never captures a live pane's resume", () => {
    const h = harness({
      sessions: [session(1)],
      capturedConversationFor: () => captured(),
    });

    expect(h.controller.deadPaneResumeTitle(1)).toBeNull();
  });

  it("restarts a dead pane in place with its own profile and cwd", async () => {
    const { controller, createSession, closeSession, attachments, persistenceCalls } =
      harness({
        sessions: [session(1), session(2), session(3, { alive: false, pid: null })],
      });

    const created = await controller.restartPane("tab-2", 3, "restart");

    expect(created).toBe(50);
    expect(createSession).toHaveBeenCalledWith({
      profile: "powershell",
      cwd: "C:\\work\\project-3",
      cols: 120,
      rows: 30,
      shellIntegration: true,
    });
    expect(attachments.attachSession).toHaveBeenCalledWith(50);
    expect(controller.getSnapshot().layout.tabs["tab-2"]?.split).toEqual({
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        { kind: "pane", sessionId: 2 },
        { kind: "pane", sessionId: 50 },
      ],
    });
    expect(closeSession).toHaveBeenCalledWith(3);
    expect(persistenceCalls.at(-1)?.kind).toBe("structural");
    expect(controller.getSnapshot().paneStates[50]).toEqual({
      status: "live",
      exitCode: null,
      suspended: false,
      attachGeneration: 0,
      historyBefore: 0n,
    });
  });

  it("launches workspace defaults for a fresh session instead", async () => {
    const { controller, createSession } = harness({
      sessions: [
        session(1),
        session(2),
        session(3, { alive: false, pid: null, profile: "cmd" }),
      ],
    });

    const created = await controller.restartPane("tab-2", 3, "fresh");

    expect(created).toBe(50);
    expect(createSession).toHaveBeenCalledWith({
      profile: "powershell",
      cwd: null,
      cols: 120,
      rows: 30,
      shellIntegration: true,
    });
  });

  it("falls back to the host default dir when the remembered cwd fails", async () => {
    const { controller, createSession } = harness({
      sessions: [session(1), session(2), session(3, { alive: false, pid: null })],
      createSession: async (createOptions) => {
        if (createOptions.cwd !== null) {
          throw new Error("stale cwd");
        }
        return session(50, { cwd: null });
      },
    });

    const created = await controller.restartPane("tab-2", 3, "restart");

    expect(created).toBe(50);
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(createSession.mock.calls[1]?.[0]).toMatchObject({ cwd: null });
  });

  it("refuses while the pane's session is still alive", async () => {
    const { controller, createSession } = harness();

    const created = await controller.restartPane("tab-1", 1, "restart");

    expect(created).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(controller.getSnapshot().notice).toBe("This terminal is still running.");
  });

  it("refuses a session that is not one of the tab's panes", async () => {
    const { controller, createSession } = harness({
      sessions: [session(1), session(2, { alive: false, pid: null }), session(3)],
    });

    const created = await controller.restartPane("tab-1", 2, "restart");

    expect(created).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("surfaces creation failure without touching the layout", async () => {
    const { controller, closeSession } = harness({
      sessions: [session(1), session(2), session(3, { alive: false, pid: null })],
      createSession: async () => {
        throw new Error("host refused");
      },
    });
    const before = controller.getSnapshot().layout;

    const created = await controller.restartPane("tab-2", 3, "restart");

    expect(created).toBeNull();
    expect(controller.getSnapshot().notice).toBe(
      "The terminal session could not be created.",
    );
    expect(controller.getSnapshot().layout).toBe(before);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("resumes the capture of a pane the daemon no longer knows at all", async () => {
    // The post-reboot case this feature exists for: the daemon was restarted,
    // so the pane's id is in the layout and in NO session map. Requiring a
    // session record here made the capture unreachable exactly when it was
    // the only thing that could answer.
    const h = harness({
      sessions: [session(1)],
      capturedConversationFor: (id) => (id === 3 ? captured({ cwd: null }) : null),
    });

    expect(h.controller.deadPaneResumeTitle(3)).toBe("Captured conversation");
  });

  it("restarts a forgotten pane in the folder its capture recorded", async () => {
    // And types its resume command: the capture is the ONLY record of where
    // that pane was working, so a forgotten pane that cannot reach it lands in
    // the host's default directory with nothing resumed.
    const h = harness({
      sessions: [session(1)],
      capturedConversationFor: (id) => (id === 3 ? captured() : null),
    });

    const pending = h.controller.restartPane("tab-2", 3, "resume");
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
    h.controller.reportSessionCwd(50, "C:\\work\\project-3", true);
    await pending;

    expect(h.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "C:\\work\\project-3" }),
    );
    expect(h.writes).toEqual([[50, "claude --resume " + CAPTURED_ID + "\r"]]);
  });

  it("still refuses a live pane", async () => {
    // The guard that moved must not start offering Resume on a running shell.
    const h = harness({ capturedConversationFor: () => captured() });
    expect(h.controller.deadPaneResumeTitle(1)).toBeNull();
  });
});

describe("WorkspaceController combine tabs (spec §16)", () => {
  it("grafts the source tab beside the target without any session lifecycle call", () => {
    const { controller, createSession, closeSession, attachments, persistenceCalls } =
      harness();

    controller.mergeTabs("tab-2", "tab-1");

    const after = controller.getSnapshot().layout;
    expect(after.tabs["tab-1"]?.split).toEqual({
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [{ kind: "pane", sessionId: 1 }, layout().tabs["tab-2"]!.split],
    });
    expect(after.tabs["tab-2"]).toBeUndefined();
    expect(after.groups.group?.items).toEqual([]);
    expect(persistenceCalls.at(-1)?.kind).toBe("structural");
    expect(createSession).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    expect(attachments.attachSession).not.toHaveBeenCalled();
    expect(attachments.forgetSession).not.toHaveBeenCalled();
  });

  it("leaves the target active when the source tab was the active one", () => {
    const { controller } = harness();

    // Fixture: tab-1 is active and is the tab being merged AWAY.
    controller.mergeTabs("tab-1", "tab-2");

    const snapshot = controller.getSnapshot();
    expect(snapshot.activeTabId).toBe("tab-2");
    expect(snapshot.activeSessionId).toBe(2);
    expect(snapshot.layout.tabs["tab-2"]?.split).toEqual({
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [layout().tabs["tab-2"]!.split, { kind: "pane", sessionId: 1 }],
    });
  });

  it("notices a refused combine and writes nothing", () => {
    const { controller, persistenceCalls } = harness();
    const before = controller.getSnapshot().layout;

    controller.mergeTabs("tab-1", "tab-1");
    expect(controller.getSnapshot().notice).toBe("The tabs could not be combined.");

    controller.mergeTabs("gone", "tab-1");
    expect(controller.getSnapshot().notice).toBe("The tabs could not be combined.");
    expect(controller.getSnapshot().layout).toBe(before);
    expect(persistenceCalls).toEqual([]);
  });

  it("pops a pane out into a generated tab after its source, which takes focus", () => {
    const { controller, createSession, closeSession, persistenceCalls } = harness();

    controller.popOutPane("tab-2", 3);

    const snapshot = controller.getSnapshot();
    expect(snapshot.layout.tabs["tab-2"]?.split).toEqual({ kind: "pane", sessionId: 2 });
    // "new-tab" is the harness's first generateId() value.
    expect(snapshot.layout.tabs["new-tab"]?.split).toEqual({ kind: "pane", sessionId: 3 });
    expect(snapshot.layout.groups.group?.items).toEqual([
      { kind: "tab", id: "tab-2" },
      { kind: "tab", id: "new-tab" },
    ]);
    expect(snapshot.activeTabId).toBe("new-tab");
    expect(snapshot.activeSessionId).toBe(3);
    expect(snapshot.groups[0]?.tabs.at(-1)).toMatchObject({
      id: "new-tab",
      primarySessionId: 3,
    });
    expect(persistenceCalls.at(-1)?.kind).toBe("structural");
    expect(createSession).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("refuses to pop out a tab's only pane, silently and without a write", () => {
    const { controller, persistenceCalls } = harness();
    const before = controller.getSnapshot().layout;

    controller.popOutPane("tab-1", 1);

    expect(controller.getSnapshot().layout).toBe(before);
    expect(controller.getSnapshot().notice).toBeNull();
    expect(persistenceCalls).toEqual([]);
  });
});

describe("WorkspaceController new-tab cwd policy (F1)", () => {
  it("group-active opens instantly in the scope's active path — no picker", async () => {
    const pickFolder = vi.fn(async () => "Z:\\never");
    const { controller, createSession } = harness({ pickFolder });

    controller.reportSessionCwd(2, "D:\\live-cd", true);
    await controller.createTab({ groupId: "group", profile: null });

    expect(pickFolder).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "D:\\live-cd", profile: "powershell" }),
    );
  });

  it("stamps the live shell-integration setting onto every created session", async () => {
    const on = harness();
    await on.controller.createTab({ groupId: "group", profile: null });
    expect(on.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ shellIntegration: true }),
    );

    const off = harness({ settings: { shellIntegration: false } });
    await off.controller.createTab({ groupId: "group", profile: null });
    expect(off.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ shellIntegration: false }),
    );
  });

  it("falls back to the scope seed when there is no active path", async () => {
    const { controller, createSession } = harness();

    // Constructor seeding: group scope seeds from tab-2's primary session (2).
    await controller.createTab({ groupId: "group", profile: null });

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "C:\\work\\project-2" }),
    );
  });

  it("walks the candidate chain past stale paths the host rejects", async () => {
    const attempts: Array<string | null> = [];
    const { controller, uiState } = harness({
      createSession: async (createOptions) => {
        attempts.push(createOptions.cwd);
        if (createOptions.cwd !== null) {
          throw new Error("cwd does not exist");
        }
        return session(50, { cwd: null });
      },
    });

    controller.reportSessionCwd(2, "D:\\deleted", true);
    await controller.createTab({ groupId: "group", profile: null });

    expect(attempts).toEqual(["D:\\deleted", "C:\\work\\project-2", null]);
    expect(controller.getSnapshot().notice).toBeNull();
    expect(uiState.getSnapshot().scopePaths.active["group"]).toBe("D:\\deleted");
  });

  it("active-tab policy prefers the focused tab's live cwd within the scope", async () => {
    const { controller, createSession } = harness({
      settings: { newTabPolicy: "active-tab" },
    });

    // active tab is tab-1 (ungrouped); its session's cwd leads the chain.
    controller.reportSessionCwd(1, "C:\\focused-here", true);
    await controller.createTab({ groupId: null, profile: null });

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "C:\\focused-here" }),
    );
  });

  it("first-terminal policy ignores CDs and uses the seed", async () => {
    const { controller, createSession } = harness({
      settings: { newTabPolicy: "first-terminal" },
    });

    controller.reportSessionCwd(2, "D:\\wandered-off", true);
    await controller.createTab({ groupId: "group", profile: null });

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "C:\\work\\project-2" }),
    );
  });

  it("ask-searcher routes to the registered palette handler and creates nothing", async () => {
    const opened: unknown[] = [];
    const { controller, createSession } = harness({
      settings: { newTabPolicy: "ask-searcher" },
    });
    controller.setFolderSearchHandler((target) => opened.push(target));

    await controller.createTab({ groupId: "group", profile: null });

    expect(opened).toEqual([{ groupId: "group", profile: "powershell" }]);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("ask-searcher without a handler falls back to the native dialog", async () => {
    const pickFolder = vi.fn(async () => "D:\\picked");
    const { controller, createSession } = harness({
      pickFolder,
      settings: { newTabPolicy: "ask-searcher" },
    });

    await controller.createTab({ groupId: null, profile: null });

    expect(pickFolder).toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "D:\\picked" }),
    );
  });

  it("null profile resolves to the settings default profile", async () => {
    const { controller, createSession } = harness({
      settings: { defaultProfile: "cmd" },
    });

    await controller.createTab({ groupId: null, profile: null });

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "cmd" }),
    );
  });

  it("createTabWithCwd creates directly in the given folder and records recents", async () => {
    const { controller, createSession, uiState } = harness();

    await controller.createTabWithCwd({
      groupId: "group",
      profile: null,
      cwd: "E:\\projects\\thing",
    });

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "E:\\projects\\thing" }),
    );
    expect(uiState.getSnapshot().recentFolders[0]).toBe("E:\\projects\\thing");
  });

  it("replay-derived cwd reports update the session but never scope state", () => {
    const { controller, uiState } = harness();

    controller.reportSessionCwd(2, "D:\\old-replayed", false);

    expect(uiState.getSnapshot().scopePaths.active["group"]).toBeUndefined();
    expect(uiState.getSnapshot().recentFolders).toEqual([]);
    const tab = controller.getSnapshot().groups[0]?.tabs[0];
    expect(tab?.cwd).toBe("D:\\old-replayed");
  });

  it("live cwd reports keep duplicate-tab templates fresh", async () => {
    const { controller, createSession } = harness();

    controller.reportSessionCwd(2, "D:\\moved-here", true);
    await controller.duplicateTab("tab-2");

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "D:\\moved-here" }),
    );
  });

  it("closing a group forgets its scope paths", async () => {
    const { controller, uiState } = harness();

    controller.reportSessionCwd(2, "D:\\group-work", true);
    expect(uiState.getSnapshot().scopePaths.active["group"]).toBe("D:\\group-work");

    await controller.closeGroup("group");

    expect(uiState.getSnapshot().scopePaths.active["group"]).toBeUndefined();
    expect(uiState.getSnapshot().scopePaths.seeds["group"]).toBeUndefined();
  });
});

/// Marketing > Clients with the active tab two levels down, and a root tab
/// beside it — the shape spec §6 is about.
function nestedLayout(): Layout {
  return {
    version: 3,
    auxWindows: {},
    groups: {
      marketing: {
        id: "marketing",
        name: "Marketing",
        collapsed: false,
        color: null,
        items: [{ kind: "group", id: "clients" }],
      },
      clients: {
        id: "clients",
        name: "Clients",
        collapsed: false,
        color: null,
        items: [{ kind: "tab", id: "tab-2" }],
      },
    },
    rootItems: [{ kind: "tab", id: "tab-1" }, { kind: "group", id: "marketing" }],
    tabs: {
      "tab-1": {
        id: "tab-1",
        title: null,
        color: "blue",
        fill: "off",
        split: { kind: "pane", sessionId: 1 },
      },
      "tab-2": {
        id: "tab-2",
        title: null,
        color: "cyan",
        fill: "off",
        split: { kind: "pane", sessionId: 2 },
      },
    },
    activeTabId: "tab-2",
  };
}

describe("WorkspaceController new-tab policy with nesting (spec §6)", () => {
  it("scopes a nested tab to its immediate parent, never an ancestor", async () => {
    const { controller, createSession, uiState } = harness({ initial: nestedLayout() });

    controller.reportSessionCwd(2, "D:\\clients-cd", true);
    expect(uiState.getSnapshot().scopePaths.active["clients"]).toBe("D:\\clients-cd");
    expect(uiState.getSnapshot().scopePaths.active["marketing"]).toBeUndefined();

    await controller.createTab({ groupId: "clients", profile: null });
    expect(createSession)
      .toHaveBeenLastCalledWith(expect.objectContaining({ cwd: "D:\\clients-cd" }));

    // Marketing holds no tabs of its own, so it inherits nothing from below.
    await controller.createTab({ groupId: "marketing", profile: null });
    expect(createSession).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: null }));
  });

  it("active-tab policy reaches a nested active tab only inside its own scope", async () => {
    const { controller, createSession } = harness({
      initial: nestedLayout(),
      settings: { newTabPolicy: "active-tab" },
    });

    controller.reportSessionCwd(2, "D:\\deep", true);
    await controller.createTab({ groupId: "clients", profile: null });
    expect(createSession).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: "D:\\deep" }));

    await controller.createTab({ groupId: null, profile: null });
    expect(createSession)
      .toHaveBeenLastCalledWith(expect.objectContaining({ cwd: "C:\\work\\project-1" }));
  });

  it("lands a group row's new tab in that group and a root one at the root", async () => {
    // Two creations in one test need two distinct sessions; the default fake
    // hands out 50 every time, which the store would reject as a duplicate.
    let nextSessionId = 50;
    const { controller } = harness({
      initial: nestedLayout(),
      createSession: async (createOptions) =>
        session(nextSessionId++, {
          profile: createOptions.profile ?? "powershell",
          cwd: createOptions.cwd,
        }),
    });

    // Ids come from the harness's generic pool, in creation order.
    await controller.createTab({ groupId: "clients", profile: null });
    await controller.createTab({ groupId: null, profile: null });

    const state = controller.getSnapshot().layout;
    expect(state.groups.clients!.items).toEqual([
      { kind: "tab", id: "tab-2" },
      { kind: "tab", id: "new-tab" },
    ]);
    expect(state.rootItems.at(-1)).toEqual({ kind: "tab", id: "new-group" });
  });
});

describe("WorkspaceController sessionDims (spec §13)", () => {
  it("prefers the hub's recorded resize dims, falls back to SessionInfo, drops unknowns", () => {
    const { controller, attachments } = harness({
      sessions: [session(1), session(2, { cols: 80, rows: 24 })],
    });
    // The hub recorded a live resize for session 1 only.
    attachments.lastDims = (sessionId: number) =>
      sessionId === 1 ? { cols: 200, rows: 50 } : null;

    expect(controller.sessionDims([1, 2, 99])).toEqual({
      1: { cols: 200, rows: 50 },
      2: { cols: 80, rows: 24 },
    });
  });

  it("works against a hub without the lastDims seam", () => {
    const { controller } = harness({ sessions: [session(3)] });
    expect(controller.sessionDims([3])).toEqual({ 3: { cols: 120, rows: 30 } });
  });
});

describe("WorkspaceController multi-window (Phase 1)", () => {
  /// layout() with tab-1 torn out into aux-1; the group stays in main.
  function tornLayout(): Layout {
    const initial = layout();
    initial.rootItems = [{ kind: "group", id: "group" }];
    initial.activeTabId = "tab-2";
    initial.auxWindows["aux-1"] = {
      rootItems: [{ kind: "tab", id: "tab-1" }],
      activeTabId: "tab-1",
      bounds: null,
    };
    return initial;
  }

  it("an aux controller snapshots only its own window's slot", () => {
    const { controller } = harness({ initial: tornLayout(), windowId: "aux-1" });
    const snapshot = controller.getSnapshot();
    expect(snapshot.ungroupedTabs.map((tab) => tab.id)).toEqual(["tab-1"]);
    expect(snapshot.groups).toEqual([]);
    expect(snapshot.activeTabId).toBe("tab-1");
    expect(snapshot.activeSessionId).toBe(1);
    expect(snapshot.windowIds).toEqual(["main", "aux-1"]);
  });

  it("the main controller no longer shows a torn-out tab", () => {
    const { controller } = harness({ initial: tornLayout() });
    const snapshot = controller.getSnapshot();
    expect(snapshot.ungroupedTabs).toEqual([]);
    expect(snapshot.groups.map((group) => group.id)).toEqual(["group"]);
    expect(snapshot.activeTabId).toBe("tab-2");
  });

  it("moveItemToWindow('new') allocates aux ids and records a structural write", () => {
    const { controller, persistenceCalls } = harness();
    const target = controller.moveItemToWindow({ kind: "tab", id: "tab-1" }, "new");
    expect(target).toBe("aux-1");
    const snapshot = controller.getSnapshot();
    expect(snapshot.ungroupedTabs).toEqual([]);
    expect(snapshot.layout.auxWindows["aux-1"]!.rootItems).toEqual([
      { kind: "tab", id: "tab-1" },
    ]);
    expect(persistenceCalls.at(-1)).toMatchObject({ kind: "structural" });

    const second = controller.moveItemToWindow({ kind: "group", id: "group" }, "new");
    expect(second).toBe("aux-2");
  });

  it("moveItemToWindow moves a group whole and back again", () => {
    const { controller } = harness();
    expect(
      controller.moveItemToWindow({ kind: "group", id: "group" }, "new"),
    ).toBe("aux-1");
    expect(controller.getSnapshot().groups).toEqual([]);
    expect(
      controller.moveItemToWindow({ kind: "group", id: "group" }, "main"),
    ).toBe("main");
    expect(controller.getSnapshot().groups.map((group) => group.id)).toEqual([
      "group",
    ]);
    // The emptied slot survives the move; only closing the window prunes it.
    expect(controller.getSnapshot().windowIds).toEqual(["main", "aux-1"]);
  });

  it("moveItemToWindow refuses unknown items", () => {
    const { controller, persistenceCalls } = harness();
    expect(
      controller.moveItemToWindow({ kind: "tab", id: "ghost" }, "new"),
    ).toBeNull();
    expect(persistenceCalls).toEqual([]);
  });

  it("returnWindowToMain brings the slot's items home and deletes the slot", () => {
    const { controller } = harness({ initial: tornLayout() });
    controller.returnWindowToMain("aux-1");
    const snapshot = controller.getSnapshot();
    expect(snapshot.windowIds).toEqual(["main"]);
    expect(snapshot.ungroupedTabs.map((tab) => tab.id)).toEqual(["tab-1"]);
    expect(snapshot.activeTabId).toBe("tab-2");
  });

  it("an aux controller's activateTab writes its own slot, not main's", () => {
    const initial = tornLayout();
    initial.auxWindows["aux-1"]!.rootItems.push({ kind: "tab", id: "tab-3" });
    initial.tabs["tab-3"] = {
      id: "tab-3",
      title: null,
      color: "green",
      fill: "off",
      split: { kind: "pane", sessionId: 9 },
    };
    const { controller } = harness({
      initial,
      windowId: "aux-1",
      sessions: [session(1), session(2), session(3), session(9)],
    });
    controller.activateTab("tab-3");
    const snapshot = controller.getSnapshot();
    expect(snapshot.activeTabId).toBe("tab-3");
    expect(snapshot.layout.activeTabId).toBe("tab-2");
  });
});

describe("WorkspaceController plugin panes (plugin spec §4)", () => {
  /// The reserved id a plugin tab was given. Reads it out of the layout rather
  /// than predicting it: allocation is a random re-roll by design.
  function panelId(state: Layout, tabId: string): number {
    const split = state.tabs[tabId]?.split;
    if (split?.kind !== "pane") {
      throw new Error(`tab ${tabId} does not hold a single pane`);
    }
    return split.sessionId;
  }

  /// A layout whose third tab is a reserved-id pane, as a restored blob has it.
  function layoutWithPanel(sessionId = PLUGIN_PANE_MIN_ID): Layout {
    const initial = layout();
    initial.tabs["tab-3"] = {
      id: "tab-3",
      title: "Showroom",
      color: "magenta",
      fill: "off",
      split: { kind: "pane", sessionId },
    };
    initial.rootItems = [...initial.rootItems, { kind: "tab", id: "tab-3" }];
    return initial;
  }

  it("openPluginTab binds a reserved pane, opens the tab, and starts the plugin", async () => {
    const { controller, persistenceCalls, pluginPanes, ensureUp } = harness();

    const tabId = await controller.openPluginTab("showroom");
    expect(tabId).toBe("new-tab");

    const snapshot = controller.getSnapshot();
    const sessionId = panelId(snapshot.layout, "new-tab");
    expect(isPluginPaneId(sessionId)).toBe(true);
    expect(pluginPanes.getSnapshot()).toEqual({
      [String(sessionId)]: { pluginId: "showroom" },
    });
    // The rail names the panel, not "Terminal ended" — a plugin pane has no
    // session for derivedTitle to describe, and no corpse to dismiss.
    expect(snapshot.ungroupedTabs.at(-1)).toMatchObject({
      id: "new-tab",
      title: "Showroom",
      status: "live",
    });
    expect(persistenceCalls.at(-1)).toMatchObject({ kind: "structural" });
    expect(ensureUp).toHaveBeenCalledTimes(1);
    expect(ensureUp).toHaveBeenCalledWith("showroom");

    await tick();
    expect(controller.getSnapshot().paneStates[sessionId]).toEqual({
      status: "plugin",
      exitCode: null,
      pluginId: "showroom",
      pluginUrl: "http://127.0.0.1:7788",
      pluginHealth: "up",
    });
  });

  it("shows a pane as starting until the health probe answers", async () => {
    // A real ensure-up spawns a process and polls for seconds; the pane must
    // render something for that whole window, and it has no URL to frame yet.
    let answer = (result: EnsureUpResult): void => void result;
    const { controller } = harness({
      ensureUp: () => new Promise<EnsureUpResult>((resolve) => {
        answer = resolve;
      }),
    });

    await controller.openPluginTab("showroom");
    const sessionId = panelId(controller.getSnapshot().layout, "new-tab");
    expect(controller.getSnapshot().paneStates[sessionId]).toEqual({
      status: "plugin",
      exitCode: null,
      pluginId: "showroom",
      pluginUrl: null,
      pluginHealth: "starting",
    });

    answer(runtimeUp());
    await tick();
    expect(controller.getSnapshot().paneStates[sessionId]).toMatchObject({
      pluginHealth: "up",
    });
  });

  it("writes the binding file BEFORE the layout that references the pane", async () => {
    // The crash window this closes: a layout blob naming a reserved id whose
    // binding never landed renders as a dead pane at the next boot, and the
    // panel identity is gone for good. Bindings file first, layout second.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ savePluginPanes: () => gate });

    const opened = h.controller.openPluginTab("showroom");
    await tick();
    expect(h.events).toEqual(["bindings:start"]);

    release();
    await opened;
    expect(h.events).toEqual(["bindings:start", "bindings:done", "layout:structural"]);
  });

  it("starts a plugin once per boot however many panes open it", async () => {
    const { controller, ensureUp } = harness();

    const first = await controller.openPluginTab("showroom");
    await tick();
    const second = await controller.openPluginTab("showroom");
    const snapshot = controller.getSnapshot();

    expect([first, second]).toEqual(["new-tab", "new-group"]);
    // Two panes, two ids: the allocator never hands out one twice.
    const ids = [
      panelId(snapshot.layout, "new-tab"),
      panelId(snapshot.layout, "new-group"),
    ];
    expect(new Set(ids).size).toBe(2);
    expect(ensureUp).toHaveBeenCalledTimes(1);
    // The second pane reads the cached runtime rather than waiting on a probe.
    expect(snapshot.paneStates[ids[1]!]).toMatchObject({
      pluginHealth: "up",
      pluginUrl: "http://127.0.0.1:7788",
    });
  });

  it("surfaces an ensure-up failure as a down pane carrying the reason", async () => {
    const { controller } = harness({
      ensureUp: async () => ({
        ok: false,
        reason: "health probe never passed",
        stderrTail: "Error: cannot find module\n",
      }),
    });

    await controller.openPluginTab("showroom");
    await tick();
    const snapshot = controller.getSnapshot();
    const state = snapshot.paneStates[panelId(snapshot.layout, "new-tab")]!;

    expect(state.pluginHealth).toBe("down");
    expect(state.pluginError).toContain("health probe never passed");
    expect(state.pluginError).toContain("cannot find module");
  });

  it("relaunchPlugin re-runs ensure-up and keeps the pane id", async () => {
    let attempt = 0;
    const { controller, ensureUp } = harness({
      ensureUp: async () => {
        attempt += 1;
        return attempt === 1
          ? { ok: false, reason: "health probe never passed", stderrTail: "" }
          : runtimeUp(9001);
      },
    });

    await controller.openPluginTab("showroom");
    await tick();
    const sessionId = panelId(controller.getSnapshot().layout, "new-tab");
    expect(controller.getSnapshot().paneStates[sessionId]?.pluginHealth).toBe("down");

    await controller.relaunchPlugin(sessionId);

    expect(ensureUp).toHaveBeenCalledTimes(2);
    // Relaunch is NOT restartPane: the id — and with it the binding — survives.
    expect(panelId(controller.getSnapshot().layout, "new-tab")).toBe(sessionId);
    expect(controller.getSnapshot().paneStates[sessionId]).toMatchObject({
      pluginHealth: "up",
      pluginUrl: "http://127.0.0.1:9001",
    });
  });

  it("relaunchPlugin ignores a pane that is not a plugin", async () => {
    const { controller, ensureUp } = harness();
    await controller.relaunchPlugin(1);
    expect(ensureUp).not.toHaveBeenCalled();
  });

  it("openPluginSplit adds a plugin pane beside a live terminal", async () => {
    const { controller, persistenceCalls } = harness();

    const sessionId = await controller.openPluginSplit("tab-1", 1, "showroom", "row");

    expect(sessionId).not.toBeNull();
    expect(isPluginPaneId(sessionId!)).toBe(true);
    const snapshot = controller.getSnapshot();
    expect(snapshot.layout.tabs["tab-1"]!.split).toMatchObject({
      kind: "split",
      dir: "row",
      children: [
        { kind: "pane", sessionId: 1 },
        { kind: "pane", sessionId },
      ],
    });
    expect(snapshot.paneStates[sessionId!]).toMatchObject({ status: "plugin" });
    expect(persistenceCalls.at(-1)).toMatchObject({ kind: "structural" });
  });

  it("openPluginSplit writes the binding before the layout too", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ savePluginPanes: () => gate });

    const opened = h.controller.openPluginSplit("tab-1", 1, "showroom", "col");
    await tick();
    expect(h.events).toEqual(["bindings:start"]);

    release();
    await opened;
    expect(h.events).toEqual(["bindings:start", "bindings:done", "layout:structural"]);
  });

  it("refuses an unknown plugin without touching the layout or the bindings", async () => {
    const { controller, persistenceCalls, pluginPanes } = harness();

    expect(await controller.openPluginTab("ghost")).toBeNull();
    expect(await controller.openPluginSplit("tab-1", 1, "ghost", "row")).toBeNull();

    expect(persistenceCalls).toEqual([]);
    expect(pluginPanes.getSnapshot()).toEqual({});
    expect(controller.getSnapshot().notice).toContain("ghost");
  });

  it("renders a reserved pane with no binding as a dismissible dead pane", () => {
    // The downgrade path (spec §4): the bindings file was lost, or an older
    // build wrote this layout. Never an undefined ghost.
    const { controller } = harness({ initial: layoutWithPanel() });
    const snapshot = controller.getSnapshot();

    expect(snapshot.paneStates[PLUGIN_PANE_MIN_ID]).toEqual({
      status: "missing",
      exitCode: null,
    });
    expect(snapshot.ungroupedTabs.at(-1)).toMatchObject({
      id: "tab-3",
      status: "missing",
    });
  });

  it("dismissing a plugin pane prunes it and unbinds WITHOUT calling the daemon", async () => {
    // The load-bearing guard: closeSessions early-succeeds for ids the UI's
    // session map does not know, so Dismiss never asks the daemon to close a
    // session that never existed — which would fail and leave the pane stuck.
    const { controller, closeSession, pluginPanes } = harness({
      initial: layoutWithPanel(),
      pluginBindings: { [String(PLUGIN_PANE_MIN_ID)]: { pluginId: "showroom" } },
    });

    await controller.closePane("tab-3", PLUGIN_PANE_MIN_ID);

    expect(closeSession).not.toHaveBeenCalled();
    expect(controller.getSnapshot().layout.tabs["tab-3"]).toBeUndefined();
    expect(pluginPanes.getSnapshot()).toEqual({});
  });

  it("closing a tab holding a plugin pane unbinds it too", async () => {
    const { controller, closeSession, pluginPanes } = harness({
      initial: layoutWithPanel(),
      pluginBindings: { [String(PLUGIN_PANE_MIN_ID)]: { pluginId: "showroom" } },
    });

    await controller.dismissDeadTab("tab-3");

    expect(closeSession).not.toHaveBeenCalled();
    expect(controller.getSnapshot().layout.tabs["tab-3"]).toBeUndefined();
    expect(pluginPanes.getSnapshot()).toEqual({});
  });

  /// The aux-window shape: tab-1 torn out into its own slot.
  function auxLayout(): Layout {
    const initial = layout();
    initial.rootItems = [{ kind: "group", id: "group" }];
    initial.activeTabId = "tab-2";
    initial.auxWindows["aux-1"] = {
      rootItems: [{ kind: "tab", id: "tab-1" }],
      activeTabId: "tab-1",
      bounds: null,
    };
    return initial;
  }

  it("an aux window waits for main to take the binding before it records the layout", async () => {
    // The same crash order as the main window, one hop further out: an aux
    // window persists nothing itself, so "the binding landed" means main
    // ACKNOWLEDGED it. `flush()` awaits the forward (the store chains it into
    // the same queue), and the layout write must sit behind that.
    let release = (): void => undefined;
    const delivered = new Promise<void>((resolve) => {
      release = resolve;
    });
    let replica: PaneBindingsStore;
    // Main acknowledges by broadcasting the row back, which is what the open
    // path actually waits on; nothing may be written before that lands.
    replica = new PaneBindingsStore({
      initial: {},
      save: null,
      onForward: async (request) => {
        await delivered;
        if (request.op === "bind") {
          replica.adopt({ [String(request.sessionId)]: request.binding });
        }
      },
    });
    const { controller, events } = harness({
      initial: auxLayout(),
      windowId: "aux-1",
      pluginPanesStore: replica,
    });

    const opened = controller.openPluginTab("showroom");
    await tick();
    expect(events).toEqual([]);

    release();
    await opened;
    expect(events).toEqual(["layout:structural"]);
  });

  it("an aux window forwards its binding to main instead of writing the file", async () => {
    // Single-writer rule: only the main window owns plugin_panes_v1.json.
    const forwarded: unknown[] = [];
    let replica: PaneBindingsStore;
    replica = new PaneBindingsStore({
      initial: {},
      save: null,
      onForward: (request) => {
        forwarded.push(request);
        if (request.op === "bind") {
          replica.adopt({ [String(request.sessionId)]: request.binding });
        }
      },
    });
    const { controller, events } = harness({
      initial: auxLayout(),
      windowId: "aux-1",
      pluginPanesStore: replica,
    });

    const tabId = await controller.openPluginTab("showroom");

    expect(tabId).toBe("new-tab");
    const sessionId = panelId(controller.getSnapshot().layout, "new-tab");
    expect(forwarded).toEqual([
      { op: "bind", sessionId, binding: { pluginId: "showroom" } },
    ]);
    // No local write at all: the layout is the only thing this window records.
    expect(events).toEqual(["layout:structural"]);
    // The tab landed on THIS window rail, beside the tab already torn out.
    expect(controller.getSnapshot().ungroupedTabs.map((entry) => entry.id)).toEqual([
      "tab-1",
      "new-tab",
    ]);
  });

  it("starts every bound plugin at boot, so a restored panel is never stuck starting", async () => {
    // Without this, the SECOND launch of TermX shows a spinner with no
    // Relaunch button (only "down" has one) and the panel never comes back —
    // spec §4 puts a plugin pane's liveness on the health probe, and nothing
    // was probing it.
    const { controller, ensureUp } = harness({
      initial: layoutWithPanel(),
      pluginBindings: { [String(PLUGIN_PANE_MIN_ID)]: { pluginId: "showroom" } },
    });

    await tick();

    expect(ensureUp).toHaveBeenCalledTimes(1);
    expect(ensureUp).toHaveBeenCalledWith("showroom");
    expect(controller.getSnapshot().paneStates[PLUGIN_PANE_MIN_ID]).toMatchObject({
      status: "plugin",
      pluginHealth: "up",
    });
  });

  it("starts nothing at boot for a reserved pane with no binding", async () => {
    const { ensureUp } = harness({ initial: layoutWithPanel() });
    await tick();
    expect(ensureUp).not.toHaveBeenCalled();
  });

  it("starts nothing at boot for a binding whose pane is not in the layout", async () => {
    // The boot prune deals with those. Starting a process for a pane nobody
    // can see would launch a plugin the user never asked for.
    const { ensureUp } = harness({
      pluginBindings: { [String(PLUGIN_PANE_MIN_ID)]: { pluginId: "showroom" } },
    });
    await tick();
    expect(ensureUp).not.toHaveBeenCalled();
  });

  it("starts a shared plugin once when several restored panes use it", async () => {
    const initial = layoutWithPanel();
    initial.tabs["tab-4"] = {
      id: "tab-4",
      title: "Showroom",
      color: "magenta",
      fill: "off",
      split: { kind: "pane", sessionId: PLUGIN_PANE_MIN_ID + 1 },
    };
    initial.rootItems = [...initial.rootItems, { kind: "tab", id: "tab-4" }];
    const { ensureUp } = harness({
      initial,
      pluginBindings: {
        [String(PLUGIN_PANE_MIN_ID)]: { pluginId: "showroom" },
        [String(PLUGIN_PANE_MIN_ID + 1)]: { pluginId: "showroom" },
      },
    });

    await tick();

    expect(ensureUp).toHaveBeenCalledTimes(1);
  });

  it("re-probes when a pane opens after the last one closed", async () => {
    // The plugin may have died while no pane was watching it. Publishing the
    // remembered "up" URL would point an iframe at a dead port until the 15 s
    // poller noticed.
    const { controller, ensureUp } = harness();
    const tabId = await controller.openPluginTab("showroom");
    await tick();
    const sessionId = panelId(controller.getSnapshot().layout, tabId!);

    await controller.closePane(tabId!, sessionId);
    await controller.openPluginTab("showroom");
    await tick();

    expect(ensureUp).toHaveBeenCalledTimes(2);
  });

  it("keeps the cached runtime while another pane still holds the plugin", async () => {
    const { controller, ensureUp } = harness();
    const first = await controller.openPluginTab("showroom");
    await tick();
    await controller.openPluginTab("showroom");
    await tick();

    await controller.closePane(first!, panelId(controller.getSnapshot().layout, first!));
    await controller.openPluginTab("showroom");
    await tick();

    // One plugin, one process: the surviving pane's runtime still answers.
    expect(ensureUp).toHaveBeenCalledTimes(1);
  });

  it("forces a fresh attempt when Relaunch is pressed during a slow start", async () => {
    // Joining the run already under way would make the click do nothing — and
    // if that run is the one that fails, the user sees a button that lies.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempt = 0;
    const { controller, ensureUp } = harness({
      ensureUp: async () => {
        attempt += 1;
        if (attempt === 1) {
          await gate;
          return { ok: false, reason: "health probe never passed", stderrTail: "" };
        }
        return runtimeUp(9100);
      },
    });

    const tabId = await controller.openPluginTab("showroom");
    const sessionId = panelId(controller.getSnapshot().layout, tabId!);
    const relaunch = controller.relaunchPlugin(sessionId);
    release();
    await relaunch;

    expect(ensureUp).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().paneStates[sessionId]).toMatchObject({
      pluginHealth: "up",
      pluginUrl: "http://127.0.0.1:9100",
    });
  });

  it("refuses restartPane on a plugin pane", async () => {
    // Restart creates a host session and swaps the id out of the layout, which
    // would destroy the binding and leave a terminal where the panel was.
    // Relaunch is the plugin pane's only restart affordance.
    const { controller, createSession } = harness({
      initial: layoutWithPanel(),
      pluginBindings: { [String(PLUGIN_PANE_MIN_ID)]: { pluginId: "showroom" } },
    });

    expect(await controller.restartPane("tab-3", PLUGIN_PANE_MIN_ID, "restart")).toBeNull();
    expect(await controller.restartPane("tab-3", PLUGIN_PANE_MIN_ID, "resume")).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(controller.getSnapshot().layout.tabs["tab-3"]?.split)
      .toEqual({ kind: "pane", sessionId: PLUGIN_PANE_MIN_ID });
  });

  it("flush() waits for the bindings file, not just the layout", async () => {
    // The aux close path flushes and then destroys the webview; an unbind
    // still in flight would die with it and orphan a binding until the next
    // boot's prune.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saved = false;
    const h = harness({
      savePluginPanes: async () => {
        await gate;
        saved = true;
      },
    });
    h.pluginPanes.bind(PLUGIN_PANE_MIN_ID, { pluginId: "showroom" });

    let settledFlush = false;
    const flushed = h.controller.flush().then(() => {
      settledFlush = true;
    });
    await tick();
    expect(settledFlush).toBe(false);

    release();
    await flushed;
    expect(saved).toBe(true);
  });

  it("takes the binding back, on disk, when the layout refuses the tab", async () => {
    // The refusal path must leave nothing behind: a binding with no pane is an
    // orphan that only the next boot's prune would clear.
    const initial = layout();
    initial.tabs["new-tab"] = {
      id: "new-tab",
      title: null,
      color: "green",
      fill: "off",
      split: { kind: "pane", sessionId: 9 },
    };
    initial.rootItems = [...initial.rootItems, { kind: "tab", id: "new-tab" }];
    const h = harness({
      initial,
      sessions: [session(1), session(2), session(3), session(9)],
    });

    expect(await h.controller.openPluginTab("showroom")).toBeNull();

    expect(h.pluginPanes.getSnapshot()).toEqual({});
    expect(h.persistenceCalls).toEqual([]);
    // Bound then unbound, and BOTH reached the file before the call returned.
    expect(h.pluginWrites).toHaveLength(2);
    expect(h.pluginWrites.at(-1)).toContain("\"panes\": {}");
  });

  it("closeLiveTab unbinds a plugin tab without asking the daemon", async () => {
    // The rail shows a bound plugin tab as LIVE, so this is the close path the
    // UI actually calls for one — dismissDeadTab never sees it.
    const { controller, closeSession, pluginPanes } = harness({
      initial: layoutWithPanel(),
      pluginBindings: { [String(PLUGIN_PANE_MIN_ID)]: { pluginId: "showroom" } },
    });

    await controller.closeLiveTab("tab-3");

    expect(closeSession).not.toHaveBeenCalled();
    expect(controller.getSnapshot().layout.tabs["tab-3"]).toBeUndefined();
    expect(pluginPanes.getSnapshot()).toEqual({});
  });

  it("keeps the binding when a close leaves the pane in the layout", async () => {
    // Unbinding before knowing the layout write succeeded is the same failure
    // the flush ordering exists to prevent, arriving through the back door: a
    // working panel would silently become a dead pane.
    const { controller, pluginPanes } = harness({
      initial: layoutWithPanel(),
      pluginBindings: { [String(PLUGIN_PANE_MIN_ID)]: { pluginId: "showroom" } },
    });

    // Wrong tab: the store refuses, so the pane stays where it is.
    await controller.closePane("tab-1", PLUGIN_PANE_MIN_ID);

    expect(controller.getSnapshot().layout.tabs["tab-3"]).toBeDefined();
    expect(pluginPanes.getSnapshot()).toEqual({
      [String(PLUGIN_PANE_MIN_ID)]: { pluginId: "showroom" },
    });
  });

  it("refuses to open when the binding could not be written", async () => {
    // A resolved flush is what the layout write trusts. If the write failed,
    // writing the layout anyway would produce the exact corpse-on-next-boot
    // this ordering exists to prevent.
    const h = harness({
      savePluginPanes: async () => {
        throw new Error("disk full");
      },
    });

    expect(await h.controller.openPluginTab("showroom")).toBeNull();

    expect(h.persistenceCalls).toEqual([]);
    expect(h.controller.getSnapshot().layout.tabs["new-tab"]).toBeUndefined();
    expect(h.pluginPanes.getSnapshot()).toEqual({});
  });

  it("projects a pane's panel-path override", () => {
    // A binding may pin one pane to a sub-path of the plugin; the renderer
    // needs it beside the origin to build the iframe URL.
    const { controller } = harness({
      initial: layoutWithPanel(),
      pluginBindings: {
        [String(PLUGIN_PANE_MIN_ID)]: { pluginId: "showroom", path: "/gallery" },
      },
    });

    expect(controller.getSnapshot().paneStates[PLUGIN_PANE_MIN_ID]).toMatchObject({
      status: "plugin",
      pluginPanelPath: "/gallery",
    });
  });

  it("says so when Relaunch reaches a plugin pane with no binding", async () => {
    // In an aux window the binding arrives by broadcast, so a pane opened here
    // can briefly have none. Returning in silence leaves a button that does
    // nothing and explains nothing.
    const { controller } = harness({ initial: layoutWithPanel() });

    await controller.relaunchPlugin(PLUGIN_PANE_MIN_ID);

    expect(controller.getSnapshot().notice).not.toBeNull();
  });

  it("shares one start between two panes opened in the same breath", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller, ensureUp } = harness({
      ensureUp: async () => {
        await gate;
        return runtimeUp();
      },
    });

    const first = controller.openPluginTab("showroom");
    const second = controller.openPluginTab("showroom");
    await Promise.all([first, second]);
    release();
    await tick();

    expect(ensureUp).toHaveBeenCalledTimes(1);
  });

  it("an aux window waits for main to broadcast the binding back", async () => {
    // Two bus channels with no ordering between them: the forward REACHING
    // main is not the same as the row existing. Recording the layout first
    // would let main persist a reserved pane its bindings file does not know.
    const forwarded: string[] = [];
    let acknowledge = (): void => undefined;
    let replica: PaneBindingsStore;
    replica = new PaneBindingsStore({
      initial: {},
      save: null,
      onForward: (request) => {
        forwarded.push(request.op);
        if (request.op === "bind") {
          acknowledge = () => {
            replica.adopt({ [String(request.sessionId)]: request.binding });
          };
        }
      },
    });
    const { controller, events } = harness({
      initial: auxLayout(),
      windowId: "aux-1",
      pluginPanesStore: replica,
    });

    const opened = controller.openPluginTab("showroom");
    await tick();
    // Delivered, but not yet acknowledged: nothing may be written.
    expect(forwarded).toEqual(["bind"]);
    expect(events).toEqual([]);

    acknowledge();
    expect(await opened).toBe("new-tab");
    expect(events).toEqual(["layout:structural"]);
  });

  it("says what the HOST says when a plugin cannot be opened", async () => {
    // Three different things refuse an open — not installed, switched off, no
    // readable manifest — and only the host knows which. A single "not
    // installed" for all three sends the user hunting for a folder they never
    // removed.
    const h = harness({
      pluginManifests: {},
      unavailableReason: () => "Showroom is disabled in Settings.",
    });

    expect(await h.controller.openPluginTab("showroom")).toBeNull();
    expect(h.controller.getSnapshot().notice)
      .toBe("Showroom is disabled in Settings.");
  });

  it("falls back to a plain refusal when the host offers no reason", async () => {
    const h = harness({ pluginManifests: {} });

    expect(await h.controller.openPluginTab("ghost")).toBeNull();
    expect(h.controller.getSnapshot().notice)
      .toBe('The plugin "ghost" is not installed.');
  });

  it("gives up on an ensure-up that never answers, and ignores it after", async () => {
    // A native call that hangs (a wedged disk, a lost invoke) is outside the
    // lifecycle's own spawn budget. Without a deadline the pane sits on
    // "starting" for ever — and T6's starting card has no Relaunch button, so
    // the state hides the only affordance that could recover it.
    vi.useFakeTimers();
    try {
      const pending: { release: ((result: EnsureUpResult) => void) | null } =
        { release: null };
      const h = harness({
        ensureUp: () => new Promise<EnsureUpResult>((resolve) => {
          pending.release = resolve;
        }),
      });
      const opened = h.controller.openPluginTab("showroom");
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(PLUGIN_ENSURE_DEADLINE_MS + 10);
      const tabId = await opened;
      const sessionId = panelId(h.controller.getSnapshot().layout, tabId!);
      expect(h.controller.getSnapshot().paneStates[sessionId]).toMatchObject({
        pluginHealth: "down",
        pluginError: "The plugin did not answer in time.",
      });

      // The hung call finally answers. Its news is stale by definition: the
      // pane has already been told, and a silent flip back to "up" would frame
      // a plugin nobody has heard from.
      pending.release?.(runtimeUp());
      await vi.advanceTimersByTimeAsync(0);
      expect(h.controller.getSnapshot().paneStates[sessionId]?.pluginHealth)
        .toBe("down");
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the plugin when MAIN adopts a binding forwarded by another window", async () => {
    // Lifecycle ownership is main's alone, so an aux window's open cannot
    // spawn. Main adopting the forwarded bind is the moment the plugin can be
    // started — and it happens before that window's layout write arrives, so
    // the layout cannot be what triggers it.
    const h = harness();

    h.pluginPanes.bind(PLUGIN_PANE_MIN_ID + 7, { pluginId: "showroom" });
    await tick();

    expect(h.ensureUp).toHaveBeenCalledTimes(1);
    expect(h.ensureUp).toHaveBeenCalledWith("showroom");
  });

  it("does not start a plugin twice when a second pane binds to it", async () => {
    const h = harness();
    h.pluginPanes.bind(PLUGIN_PANE_MIN_ID + 7, { pluginId: "showroom" });
    await tick();

    h.pluginPanes.bind(PLUGIN_PANE_MIN_ID + 8, { pluginId: "showroom" });
    await tick();

    expect(h.ensureUp).toHaveBeenCalledTimes(1);
  });

  it("never closes a daemon session that shares a reserved id", async () => {
    // Pathological, and deliberately non-destructive: if a real session ever
    // carries a reserved id, dismissing the PANEL must not kill the shell.
    const h = harness({
      initial: layoutWithPanel(),
      sessions: [session(1), session(2), session(PLUGIN_PANE_MIN_ID)],
      pluginBindings: { [String(PLUGIN_PANE_MIN_ID)]: { pluginId: "showroom" } },
    });

    await h.controller.closePane("tab-3", PLUGIN_PANE_MIN_ID);

    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().layout.tabs["tab-3"]).toBeUndefined();
    expect(h.pluginPanes.getSnapshot()).toEqual({});
  });

  it("contains a throw mid-open instead of leaking an orphan binding", async () => {
    // The callers are `void controller.openPluginTab(...)` seams: an escaping
    // error is an unhandled rejection and a menu entry that silently does
    // nothing, with a bindings row left behind for the next boot to restore.
    const h = harness({
      generateId: () => {
        throw new Error("no ids left");
      },
    });

    expect(await h.controller.openPluginTab("showroom")).toBeNull();
    expect(h.controller.getSnapshot().notice)
      .toBe("The plugin panel could not be opened.");
    expect(h.pluginPanes.getSnapshot()).toEqual({});
    expect(h.controller.getSnapshot().layout.tabs["new-tab"]).toBeUndefined();
  });

  /// The same panel, torn out into an aux window's slot.
  function panelInAux(): Layout {
    const next = layoutWithPanel();
    next.rootItems = next.rootItems.filter(
      (item) => !(item.kind === "tab" && item.id === "tab-3"),
    );
    next.auxWindows["aux-1"] = {
      rootItems: [{ kind: "tab", id: "tab-3" }],
      activeTabId: "tab-3",
      bounds: null,
    };
    return next;
  }

  const BOUND_PANEL = { [String(PLUGIN_PANE_MIN_ID)]: { pluginId: "showroom" } };

  it("pins the two waits a panel depends on", () => {
    // Both are promises made in prose elsewhere (a 5 s acknowledgement, a 15 s
    // answer); advancing by the constant itself would pass at any value.
    expect(PLUGIN_BIND_ADOPT_TIMEOUT_MS).toBe(5_000);
    expect(PLUGIN_ENSURE_DEADLINE_MS).toBe(15_000);
  });

  it("starts a plugin when the pane arrives in a layout from ANOTHER window", async () => {
    // Layout adoption is `replaceState`, not `mutate`: an aux window's open,
    // a returned aux window, a moved tab. Nothing here goes through the open
    // paths, so without a kick on layout change the pane renders "starting"
    // for ever — and T6's starting card has no Relaunch button.
    const h = harness({ pluginBindings: BOUND_PANEL });
    await tick();
    expect(h.ensureUp).not.toHaveBeenCalled();

    h.store.replaceState(layoutWithPanel());
    await tick();

    expect(h.ensureUp).toHaveBeenCalledWith("showroom");
  });

  it("leaves a pane in ANOTHER window's slot to that window", async () => {
    // Every window builds its own controller from the same blob. An aux
    // window ensuring for main's pane is a second lifecycle owner for a
    // process the spec says is a singleton.
    const h = harness({
      initial: layoutWithPanel(),
      windowId: "aux-1",
      pluginBindings: BOUND_PANEL,
    });
    await tick();

    expect(h.ensureUp).not.toHaveBeenCalled();
  });

  it("observes a panel once it is moved INTO this aux window", async () => {
    const h = harness({
      initial: layoutWithPanel(),
      windowId: "aux-1",
      pluginBindings: BOUND_PANEL,
    });
    await tick();

    h.store.replaceState(panelInAux());
    await tick();

    expect(h.ensureUp).toHaveBeenCalledWith("showroom");
  });

  it("forgets a plugin an aux window no longer renders", async () => {
    // Main moved the pane away; this window only ever sees the new layout, and
    // never mutates anything itself. A kept "up" would let the next panel here
    // frame a port nobody has checked since.
    const h = harness({
      initial: panelInAux(),
      windowId: "aux-1",
      // A real replica: its map is main's to change, so the row stays while
      // the pane comes and goes from THIS window's slot.
      pluginPanesStore: new PaneBindingsStore({
        initial: { ...BOUND_PANEL },
        save: null,
        onForward: () => undefined,
      }),
    });
    await tick();
    expect(h.ensureUp).toHaveBeenCalledTimes(1);

    h.store.replaceState(layoutWithPanel());
    await tick();
    h.store.replaceState(panelInAux());
    await tick();

    expect(h.ensureUp).toHaveBeenCalledTimes(2);
  });

  it("keeps a binding until the layout write that dropped its pane lands", async () => {
    // The crash order, in the direction nobody tests: unbind first and a crash
    // restores a layout naming a pane with no binding — a dead pane where a
    // working panel was.
    const h = harness({ initial: layoutWithPanel(), pluginBindings: BOUND_PANEL });
    let release = (): void => undefined;
    h.layoutWrites.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const closing = h.controller.closePane("tab-3", PLUGIN_PANE_MIN_ID);
    await tick();
    expect(h.controller.getSnapshot().layout.tabs["tab-3"]).toBeUndefined();
    expect(h.pluginPanes.getSnapshot()[String(PLUGIN_PANE_MIN_ID)]).toBeDefined();

    release();
    await closing;

    expect(h.pluginPanes.getSnapshot()).toEqual({});
  });

  it("keeps a binding when the layout write FAILED", async () => {
    const h = harness({ initial: layoutWithPanel(), pluginBindings: BOUND_PANEL });
    h.layoutWrites.error = "Unable to save the workspace layout.";

    await h.controller.closePane("tab-3", PLUGIN_PANE_MIN_ID);

    // The layout on disk may still name this pane, so its panel must survive.
    expect(h.pluginPanes.getSnapshot()[String(PLUGIN_PANE_MIN_ID)]).toBeDefined();
  });

  it("ignores an ensure-up that lands after its pane closed", async () => {
    // Otherwise the late answer re-creates a runtime for a plugin no pane
    // renders, and the NEXT open short-circuits on it.
    const pending: { release: ((result: EnsureUpResult) => void) | null } =
      { release: null };
    const h = harness({
      ensureUp: () => new Promise<EnsureUpResult>((resolve) => {
        pending.release = resolve;
      }),
    });
    const tabId = await h.controller.openPluginTab("showroom");
    const sessionId = panelId(h.controller.getSnapshot().layout, tabId!);

    await h.controller.closePane(tabId!, sessionId);
    pending.release?.(runtimeUp());
    await tick();

    const reopened = await h.controller.openPluginTab("showroom");
    const nextId = panelId(h.controller.getSnapshot().layout, reopened!);
    await tick();
    expect(h.ensureUp).toHaveBeenCalledTimes(2);
    // And the new pane is genuinely waiting on the new probe, not wearing the
    // late answer's "up".
    expect(h.controller.getSnapshot().paneStates[nextId]?.pluginHealth)
      .toBe("starting");
  });

  it("coalesces Relaunch clicks during a slow start into one retry", async () => {
    // Each click used to chain its own full attempt off the same promise: a
    // frustrated user clicking four times bought four serialized launches,
    // each with its own ten-second budget.
    const gates: Array<(result: EnsureUpResult) => void> = [];
    const h = harness({
      ensureUp: () => new Promise<EnsureUpResult>((resolve) => {
        gates.push(resolve);
      }),
    });
    const tabId = await h.controller.openPluginTab("showroom");
    const sessionId = panelId(h.controller.getSnapshot().layout, tabId!);

    const clicks = [
      h.controller.relaunchPlugin(sessionId),
      h.controller.relaunchPlugin(sessionId),
      h.controller.relaunchPlugin(sessionId),
    ];
    gates[0]?.({ ok: false, reason: "health probe never passed", stderrTail: "" });
    await tick();

    expect(h.ensureUp).toHaveBeenCalledTimes(2);
    gates[1]?.(runtimeUp());
    await Promise.all(clicks);
    expect(h.controller.getSnapshot().paneStates[sessionId]?.pluginHealth).toBe("up");
  });

  it("settles a pending adopt wait when the window is disposed", async () => {
    // Otherwise a closing aux window holds a 5 s timer and rolls a binding
    // back from inside a webview that is already gone.
    const replica = new PaneBindingsStore({
      initial: {},
      save: null,
      onForward: () => undefined,
    });
    const { controller, events } = harness({
      initial: auxLayout(),
      windowId: "aux-1",
      pluginPanesStore: replica,
    });

    vi.useFakeTimers();
    try {
      const opened = controller.openPluginTab("showroom");
      await vi.advanceTimersByTimeAsync(0);
      // The adopt wait, ticking. Counted rather than described: a timer the
      // teardown does not know about is exactly the leak.
      expect(vi.getTimerCount()).toBe(1);

      controller.dispose();

      expect(vi.getTimerCount()).toBe(0);
      expect(await opened).toBeNull();
      expect(events).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disowns a binding main acknowledges after the open gave up", async () => {
    // The bound id belongs to no pane by then. Left alone it is an orphan
    // nothing clears until the next boot — and on main it would start a
    // plugin nobody asked for.
    vi.useFakeTimers();
    try {
      const forwarded: Array<{ op: string; sessionId?: number }> = [];
      const replica = new PaneBindingsStore({
        initial: {},
        save: null,
        onForward: (request) => {
          forwarded.push(
            request.op === "bind"
              ? { op: "bind", sessionId: request.sessionId }
              : { op: "unbind" },
          );
        },
      });
      const { controller } = harness({
        initial: auxLayout(),
        windowId: "aux-1",
        pluginPanesStore: replica,
      });

      const opened = controller.openPluginTab("showroom");
      await vi.advanceTimersByTimeAsync(PLUGIN_BIND_ADOPT_TIMEOUT_MS + 10);
      expect(await opened).toBeNull();
      const sessionId = forwarded[0]?.sessionId as number;

      replica.adopt({ [String(sessionId)]: { pluginId: "showroom" } });
      await vi.advanceTimersByTimeAsync(0);

      expect(forwarded.filter((request) => request.op === "unbind")).toHaveLength(2);
      expect(controller.getSnapshot().layout.tabs["new-tab"]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says why Restart does nothing on a reserved pane with no binding", async () => {
    // The downgrade path renders an ordinary DeadPane, Restart button and all;
    // refusing in silence looks like a broken button.
    const h = harness({ initial: layoutWithPanel() });

    expect(await h.controller.restartPane("tab-3", PLUGIN_PANE_MIN_ID, "restart"))
      .toBeNull();
    expect(h.controller.getSnapshot().notice).not.toBeNull();
  });

  it("lets go of a plugin whose only remaining binding names no pane", async () => {
    // A crash between the two writes leaves a row with no pane. Counting that
    // row as a reason to keep the runtime made `forgetPluginRuntime`
    // unreachable for the plugin for the rest of the session, so the next open
    // framed a port nobody had re-probed since.
    const h = harness();
    const tabId = await h.controller.openPluginTab("showroom");
    const sessionId = panelId(h.controller.getSnapshot().layout, tabId!);
    // The orphan: a row main accepts (exactly as it accepts an aux window's
    // forwarded bind) whose pane never arrives in any layout.
    h.pluginPanes.bind(PLUGIN_PANE_MIN_ID + 21, { pluginId: "showroom" });
    await tick();

    await h.controller.closePane(tabId!, sessionId);
    await tick();

    await h.controller.openPluginTab("showroom");
    await tick();

    expect(h.ensureUp).toHaveBeenCalledTimes(2);
  });

  it("re-runs a start that a close abandoned while it was still in flight", async () => {
    // The forget stamps the attempt as superseded so its answer is dropped —
    // and the pane that wants the plugin again must not JOIN that attempt, or
    // it waits on a result nobody will ever apply.
    const gates: Array<(result: EnsureUpResult) => void> = [];
    const h = harness({
      ensureUp: () => new Promise<EnsureUpResult>((resolve) => {
        gates.push(resolve);
      }),
    });
    const tabId = await h.controller.openPluginTab("showroom");
    const sessionId = panelId(h.controller.getSnapshot().layout, tabId!);

    // Closed mid-start: the first attempt is still running and now speaks for
    // nobody.
    await h.controller.closePane(tabId!, sessionId);
    await tick();
    const reopened = await h.controller.openPluginTab("showroom");
    const nextId = panelId(h.controller.getSnapshot().layout, reopened!);
    expect(h.controller.getSnapshot().paneStates[nextId]?.pluginHealth)
      .toBe("starting");

    gates[0]?.(runtimeUp());
    await tick();
    gates[1]?.(runtimeUp());
    await tick();

    expect(h.ensureUp).toHaveBeenCalledTimes(2);
    expect(h.controller.getSnapshot().paneStates[nextId]?.pluginHealth).toBe("up");
  });

  it("starts observing when the binding for a pane it already renders arrives", async () => {
    // An aux window learns its bindings from main's broadcast, and its layout
    // was restored before that landed. This is the moment a restored panel in
    // THIS window's slot first becomes startable; without it the pane renders
    // a spinner with no Relaunch until something else changes.
    const replica = new PaneBindingsStore({
      initial: {},
      save: null,
      onForward: () => undefined,
    });
    const h = harness({
      initial: panelInAux(),
      windowId: "aux-1",
      pluginPanesStore: replica,
    });
    await tick();
    expect(h.ensureUp).not.toHaveBeenCalled();

    replica.adopt({ ...BOUND_PANEL });
    await tick();

    expect(h.ensureUp).toHaveBeenCalledWith("showroom");
  });

  it("closes a group over a panel without asking the daemon about it", async () => {
    // "Close tabs" walks a whole subtree into `closeSessions`; a reserved id
    // reaching the daemon there would be the one close path that still could.
    const initial = layoutWithPanel();
    initial.rootItems = initial.rootItems.filter(
      (item) => !(item.kind === "tab" && item.id === "tab-3"),
    );
    const group = initial.groups["group"]!;
    group.items = [...group.items, { kind: "tab", id: "tab-3" }];
    const h = harness({
      initial,
      // The pathological case the guard exists for: the daemon happens to know
      // a session with this id, so "is it known?" alone would close it.
      sessions: [session(1), session(2), session(PLUGIN_PANE_MIN_ID)],
      pluginBindings: BOUND_PANEL,
    });

    await h.controller.deleteGroup("group", "close-tabs");

    expect(h.closeSession.mock.calls.map(([id]) => id))
      .not.toContain(PLUGIN_PANE_MIN_ID);
    expect(h.controller.getSnapshot().layout.tabs["tab-3"]).toBeUndefined();
    expect(h.pluginPanes.getSnapshot()).toEqual({});
  });

  it("an aux window gives up when main never acknowledges the binding", async () => {
    vi.useFakeTimers();
    try {
      const forwarded: string[] = [];
      const replica = new PaneBindingsStore({
        initial: {},
        save: null,
        onForward: (request) => {
          forwarded.push(request.op);
        },
      });
      const { controller, events } = harness({
        initial: auxLayout(),
        windowId: "aux-1",
        pluginPanesStore: replica,
      });

      const opened = controller.openPluginTab("showroom");
      await vi.advanceTimersByTimeAsync(PLUGIN_BIND_ADOPT_TIMEOUT_MS + 10);

      expect(await opened).toBeNull();
      // No layout write at all, and the binding request is withdrawn.
      expect(events).toEqual([]);
      expect(forwarded).toEqual(["bind", "unbind"]);
      expect(controller.getSnapshot().notice).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
