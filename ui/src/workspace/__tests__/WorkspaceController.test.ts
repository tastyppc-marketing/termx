import { describe, expect, it, vi } from "vitest";
import type { SessionAttachment, SessionAttachmentCallbacks } from "../../host/client";
import type { SessionInfo } from "../../host/protocol";
import { createLayoutStore } from "../../state/store";
import type { LayoutV1 } from "../../state/layout";
import {
  WorkspaceController,
  type WorkspaceAttachmentHub,
  type WorkspaceHostClient,
  type WorkspacePersistence,
} from "../WorkspaceController";

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

function layout(): LayoutV1 {
  return {
    version: 1,
    groups: [{ id: "group", name: "Work", collapsed: false, tabIds: ["tab-2"] }],
    ungroupedTabIds: ["tab-1"],
    tabs: {
      "tab-1": {
        id: "tab-1",
        title: null,
        color: "blue",
        split: { kind: "pane", sessionId: 1 },
      },
      "tab-2": {
        id: "tab-2",
        title: "Split",
        color: "cyan",
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
  initial?: LayoutV1;
  closeSession?: (sessionId: number) => Promise<void>;
  pickFolder?: () => Promise<string | null>;
} = {}) {
  const exitListeners = new Set<(event: { sessionId: number; exitCode: number | null }) => void>();
  const closeListeners = new Set<(event: { sessionId: number }) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  const createSession = vi.fn(async (createOptions: {
    profile: string | null;
    cwd: string | null;
    cols: number;
    rows: number;
  }) => session(50, {
    profile: createOptions.profile ?? "powershell",
    cwd: createOptions.cwd,
    cols: createOptions.cols,
    rows: createOptions.rows,
  }));
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
  const persistenceCalls: Array<{ layout: LayoutV1; kind: "structural" | "active_tab" }> = [];
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
  const controller = new WorkspaceController({
    client,
    store: createLayoutStore(options.initial ?? layout()),
    persistence,
    attachments,
    sessions: options.sessions ?? [session(1), session(2), session(3)],
    generateId: () => ids.shift() ?? "fallback-id",
    pickFolder: options.pickFolder,
  });
  return {
    controller,
    client,
    createSession,
    closeSession,
    persistence,
    persistenceCalls,
    attachments,
    setAttachmentSnapshot(value: typeof attachmentSnapshot) {
      attachmentSnapshot = value;
    },
  };
}

describe("WorkspaceController projection", () => {
  it("derives titles and projects fixed slate groups without serializing color", () => {
    const { controller } = harness();
    const snapshot = controller.getSnapshot();

    expect(snapshot.ungroupedTabs[0]).toMatchObject({
      title: "powershell · project-1",
      status: "live",
      primarySessionId: 1,
    });
    expect(snapshot.groups[0]).toMatchObject({ color: "slate", name: "Work" });
    expect("color" in snapshot.layout.groups[0]!).toBe(false);
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
    controller.reorderGroup("group", 0);

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
    });

    await controller.createTab({ groupId: "group", profile: "cmd" });

    expect(createSession).toHaveBeenCalledWith({
      profile: "cmd",
      cwd: "D:\\chosen",
      cols: 120,
      rows: 30,
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
    expect(paneStates[1]).toEqual({ status: "live", exitCode: null });
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
    const initial: LayoutV1 = {
      version: 1,
      groups: [],
      ungroupedTabIds: ["deep"],
      tabs: {
        deep: {
          id: "deep",
          title: null,
          color: "blue",
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
    expect(controller.getSnapshot().layout.ungroupedTabIds).toEqual([]);
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
