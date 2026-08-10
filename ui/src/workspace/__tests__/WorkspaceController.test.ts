import { describe, expect, it, vi } from "vitest";
import type { SessionAttachment, SessionAttachmentCallbacks } from "../../host/client";
import type { SessionInfo } from "../../host/protocol";
import { createLayoutStore } from "../../state/store";
import type { Item, LayoutV2 } from "../../state/layout";
import {
  WorkspaceController,
  type WorkspaceAttachmentHub,
  type WorkspaceHostClient,
  type WorkspacePersistence,
} from "../WorkspaceController";
import { DEFAULT_SETTINGS, type TermxSettings } from "../../settings/settings";
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

function layout(): LayoutV2 {
  return {
    version: 2,
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

function harness(options: {
  sessions?: SessionInfo[];
  initial?: LayoutV2;
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
  const persistenceCalls: Array<{ layout: LayoutV2; kind: "structural" | "active_tab" }> = [];
  const persistence: WorkspacePersistence = {
    getSnapshot: () => ({ saving: false, error: null }),
    subscribe: () => () => undefined,
    record(next, kind) {
      persistenceCalls.push({ layout: next, kind });
    },
    flush: async () => undefined,
    dispose: vi.fn(),
  };
  let attachmentSnapshot = { sessions: {} };
  const attachments: WorkspaceAttachmentHub = {
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
    onError: () => () => undefined,
    close: vi.fn(),
  };
  const ids = ["new-tab", "new-group", "later-tab"];
  const settingsValue: TermxSettings = { ...DEFAULT_SETTINGS, ...options.settings };
  const uiState = options.uiState ?? new UiStateStore();
  const controller = new WorkspaceController({
    client,
    store: createLayoutStore(options.initial ?? layout()),
    persistence,
    attachments,
    sessions: options.sessions ?? [session(1), session(2), session(3)],
    generateId: () => ids.shift() ?? "fallback-id",
    pickFolder: options.pickFolder,
    settings: { getSnapshot: () => settingsValue },
    uiState,
  });
  return {
    controller,
    client,
    createSession,
    closeSession,
    persistence,
    persistenceCalls,
    attachments,
    uiState,
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
    const initial: LayoutV2 = {
      version: 2,
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
function nestedLayout(): LayoutV2 {
  return {
    version: 2,
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
