/**
 * "New window" as ONE transaction (menubar spec, review P-F3).
 *
 * A new window is a tab that was created and then moved, and the two halves
 * must not be observable apart. Two structural writes are two layout saves, and
 * on an aux window a layout save IS a bus forward to main - so the intermediate
 * shape, a tab sitting in a rail it was never meant to appear in, would reach
 * main and disk on its own, and a crash between the writes would strand it
 * there. The same single-mutate discipline `openPlugin("window")` already uses.
 *
 * The second hazard is the await. Creating the session is asynchronous, and
 * main can add a tab of its own while it runs; anything that worked out WHICH
 * tab to move by diffing the layout across that await would move somebody
 * else's tab. The id is generated up front and moved by name instead.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionAttachment, SessionAttachmentCallbacks } from "../../host/client";
import type { SessionInfo } from "../../host/protocol";
import { PaneBindingsStore } from "../../plugins/paneBindings";
import { createLayoutStore } from "../../state/store";
import type { Layout } from "../../state/layout";
import { LayoutPersistence } from "../LayoutPersistence";
import {
  WorkspaceController,
  type WorkspaceAttachmentHub,
  type WorkspaceHostClient,
  type WorkspacePersistence,
} from "../WorkspaceController";
import { DEFAULT_SETTINGS, type TermxSettings } from "../../settings/settings";
import { UiStateStore } from "../uiState";

function session(id: number, cwd: string | null = "C:\\work\\one"): SessionInfo {
  return {
    id,
    profile: "powershell",
    cwd,
    cols: 120,
    rows: 30,
    alive: true,
    pid: 1000 + id,
  };
}

/// Main holds tab-1; aux-1 holds tab-9, so an aux-window run can prove the new
/// tab does NOT land in the rail it was launched from.
function layout(): Layout {
  return {
    version: 3,
    auxWindows: {
      "aux-1": { rootItems: [{ kind: "tab", id: "tab-9" }], activeTabId: "tab-9", bounds: null },
    },
    windowNames: {},
    groups: {},
    rootItems: [{ kind: "tab", id: "tab-1" }],
    tabs: {
      "tab-1": {
        id: "tab-1",
        title: null,
        color: "blue",
        fill: "off",
        split: { kind: "pane", sessionId: 1 },
      },
      "tab-9": {
        id: "tab-9",
        title: null,
        color: "green",
        fill: "off",
        split: { kind: "pane", sessionId: 9 },
      },
    },
    activeTabId: "tab-1",
  };
}

function harness(options: {
  windowId?: string;
  settings?: Partial<TermxSettings>;
  persistence?: WorkspacePersistence;
  createSession?: () => Promise<SessionInfo>;
} = {}) {
  const createSession = vi.fn(options.createSession ?? (async () => session(50)));
  const client: WorkspaceHostClient = {
    createSession,
    closeSession: vi.fn(async () => undefined),
    onSessionExited: () => () => undefined,
    onSessionClosed: () => () => undefined,
    onError: () => () => undefined,
  };
  const persistenceCalls: Array<{ layout: Layout; kind: "structural" | "active_tab" }> = [];
  const persistence: WorkspacePersistence = options.persistence ?? {
    getSnapshot: () => ({ saving: false, error: null }),
    subscribe: () => () => undefined,
    record: (next, kind) => {
      persistenceCalls.push({ layout: next, kind });
    },
    flush: async () => undefined,
    dispose: vi.fn(),
  };
  const attachments: WorkspaceAttachmentHub = {
    sendInput: vi.fn(() => true),
    getSnapshot: () => ({ sessions: {} }),
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
  const store = createLayoutStore(layout());
  const controller = new WorkspaceController({
    client,
    store,
    persistence,
    attachments,
    sessions: [session(1), session(9)],
    generateId: () => "new-tab",
    settings: { getSnapshot: () => ({ ...DEFAULT_SETTINGS, ...options.settings }) },
    uiState: new UiStateStore(),
    pluginPanes: new PaneBindingsStore({ initial: {}, save: async () => undefined }),
    ...(options.windowId ? { windowId: options.windowId } : {}),
  });
  return { controller, store, persistenceCalls, createSession };
}

describe("createTabInNewWindow", () => {
  it("creates the tab and moves it in ONE structural write", async () => {
    const h = harness();

    await h.controller.createTabInNewWindow({ profile: null });

    const state = h.controller.getSnapshot().layout;
    expect(Object.keys(state.auxWindows).sort()).toEqual(["aux-1", "aux-2"]);
    expect(state.auxWindows["aux-2"]!.rootItems).toEqual([{ kind: "tab", id: "new-tab" }]);
    // Never in the rail it was launched from, not even for an instant.
    expect(state.rootItems).toEqual([{ kind: "tab", id: "tab-1" }]);
    expect(h.persistenceCalls.filter((call) => call.kind === "structural")).toHaveLength(1);
  });

  it("forwards exactly ONE layout write from an aux window", async () => {
    // An aux window may not write the daemon: its persistence writer IS the bus
    // forward, so two writes would put the half-moved layout on the wire.
    const setLayout = vi.fn(async () => undefined);
    const persistence = new LayoutPersistence({ setLayout });
    const h = harness({ windowId: "aux-1", persistence });

    await h.controller.createTabInNewWindow({ profile: null });
    await persistence.flush();

    expect(setLayout).toHaveBeenCalledTimes(1);
    const state = h.controller.getSnapshot().layout;
    expect(state.auxWindows["aux-2"]!.rootItems).toEqual([{ kind: "tab", id: "new-tab" }]);
    // The launching window's own rail is untouched.
    expect(state.auxWindows["aux-1"]!.rootItems).toEqual([{ kind: "tab", id: "tab-9" }]);
  });

  it("leaves a tab that arrived during the session-create await alone", async () => {
    // Working out which tab to move by diffing the layout across the await
    // would pick up whatever main added in the meantime and tear THAT out.
    let release: ((created: SessionInfo) => void) | null = null;
    const h = harness({
      createSession: () =>
        new Promise<SessionInfo>((resolve) => {
          release = resolve;
        }),
    });

    const opening = h.controller.createTabInNewWindow({ profile: null });
    await Promise.resolve();
    h.store.createTab({ id: "meanwhile", sessionId: 77, color: "red" });
    release!(session(50));
    await opening;

    const state = h.controller.getSnapshot().layout;
    expect(state.rootItems).toEqual([
      { kind: "tab", id: "tab-1" },
      { kind: "tab", id: "meanwhile" },
    ]);
    expect(state.auxWindows["aux-2"]!.rootItems).toEqual([{ kind: "tab", id: "new-tab" }]);
  });

  it("remembers the folder like any other new tab", async () => {
    const h = harness();

    await h.controller.createTabInNewWindow({ profile: null });

    expect(h.controller.getSnapshot().layout.tabs["new-tab"]).toBeDefined();
    expect(h.createSession).toHaveBeenCalledTimes(1);
  });

  it("raises the folder searcher with no group, and moves nothing yet", async () => {
    // The searcher is a question, not an action: the tab is created later, by
    // whichever answer comes back. Nothing may be torn out before then.
    const h = harness({ settings: { newTabPolicy: "ask-searcher" } });
    const asked = vi.fn();
    h.controller.setFolderSearchHandler(asked);

    await h.controller.createTabInNewWindow({ profile: null });

    expect(asked).toHaveBeenCalledWith({ groupId: null, profile: DEFAULT_SETTINGS.defaultProfile });
    expect(h.createSession).not.toHaveBeenCalled();
    expect(Object.keys(h.controller.getSnapshot().layout.auxWindows)).toEqual(["aux-1"]);
  });

  it("says so when the session cannot be created, and opens no window", async () => {
    const h = harness({
      createSession: async () => {
        throw new Error("no pty");
      },
    });

    await h.controller.createTabInNewWindow({ profile: null });

    expect(h.controller.getSnapshot().notice)
      .toBe("The terminal session could not be created.");
    expect(Object.keys(h.controller.getSnapshot().layout.auxWindows)).toEqual(["aux-1"]);
  });
});
