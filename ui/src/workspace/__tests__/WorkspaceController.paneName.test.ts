/**
 * Naming a terminal (Michael: "I want to change the terminal name").
 *
 * A pane is named by what it IS - its profile and the folder it is standing in
 * - which is right until two panes are the same profile in the same repo. Then
 * only the user can say which is which, so they can.
 *
 * Explicit names belong to layout panes. Saving and restoring the workspace
 * must retain them, including when an ended terminal is restarted in place.
 *
 * ONE rule, in one place. The pane header, the rail row and the rail's hover
 * preview all read `paneTitles`, so a name typed into a pane header has to
 * reach all three or they contradict each other about the same terminal.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionAttachment, SessionAttachmentCallbacks } from "../../host/client";
import type { JsonValue, SessionInfo } from "../../host/protocol";
import { createLayoutStore } from "../../state/store";
import { parseLayout, type Layout } from "../../state/layout";
import { reconcile } from "../../state/reconcile";
import { LayoutPersistence } from "../LayoutPersistence";
import {
  WorkspaceController,
  type WorkspaceAttachmentHub,
  type WorkspaceHostClient,
} from "../WorkspaceController";

function session(id: number, cwd: string | null = "C:\\work\\project"): SessionInfo {
  return { id, profile: "powershell", cwd, cols: 120, rows: 30, alive: true, pid: 1000 + id };
}

/// tab-1 is a lone pane (session 1); tab-2 is a two-pane split (2 and 3).
function layout(tabTitle: string | null = null): Layout {
  return {
    version: 3,
    auxWindows: {},
    windowNames: {},
    groups: {},
    rootItems: [{ kind: "tab", id: "tab-1" }, { kind: "tab", id: "tab-2" }],
    tabs: {
      "tab-1": {
        id: "tab-1",
        title: tabTitle,
        color: "blue",
        fill: "off",
        split: { kind: "pane", sessionId: 1 },
      },
      "tab-2": {
        id: "tab-2",
        title: null,
        color: "cyan",
        fill: "off",
        split: {
          kind: "split",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [{ kind: "pane", sessionId: 2 }, { kind: "pane", sessionId: 3 }],
        },
      },
    },
    activeTabId: "tab-1",
  };
}

function harness(options: { tabTitle?: string | null; initialLayout?: Layout; sessions?: SessionInfo[] } = {}) {
  let onClosed: ((event: { sessionId: number }) => void) | null = null;
  const client: WorkspaceHostClient = {
    createSession: vi.fn(async () => session(50)),
    closeSession: vi.fn(async () => undefined),
    onSessionExited: () => () => undefined,
    onSessionClosed: (handler) => {
      onClosed = handler;
      return () => undefined;
    },
    onError: () => () => undefined,
  };
  const saved: JsonValue[] = [];
  const persistence = new LayoutPersistence({
    setLayout: vi.fn(async (value) => { saved.push(structuredClone(value)); }),
  });
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
  const store = createLayoutStore(options.initialLayout ?? layout(options.tabTitle ?? null));
  const controller = new WorkspaceController({
    client,
    store,
    persistence,
    attachments,
    sessions: options.sessions ?? [session(1), session(2), session(3, "C:\\work\\project")],
  });
  return {
    controller,
    saved,
    store,
    closeSession: (sessionId: number) => onClosed?.({ sessionId }),
  };
}

/// The rail row's title for a tab, which is what the sidebar draws.
function railTitle(controller: WorkspaceController, tabId: string): string {
  return controller.getSnapshot().ungroupedTabs.find((row) => row.id === tabId)!.title;
}

describe("renamePane", () => {
  it("names a lone pane over the name derived from its folder", () => {
    const h = harness();
    expect(h.controller.paneTitles("tab-1")[1]).toBe("powershell \u00b7 project");

    h.controller.renamePane(1, "Build");

    expect(h.controller.paneTitles("tab-1")[1]).toBe("Build");
  });

  it("names one pane of a split without touching its sibling", () => {
    // The case the feature exists for: two panes, same profile, same folder,
    // identical derived names, and only the user can say which is which.
    const h = harness();

    h.controller.renamePane(2, "server");

    expect(h.controller.paneTitles("tab-2")).toEqual({
      2: "server",
      3: "powershell \u00b7 project",
    });
  });

  it("reaches the rail row too, so the two never disagree", () => {
    // The pane header and the rail row name the same terminal. A name that
    // reached only the header would make the sidebar contradict the pane.
    const h = harness();

    h.controller.renamePane(1, "Build");

    expect(railTitle(h.controller, "tab-1")).toBe("Build");
  });

  it("leaves a tab the user named alone in the rail", () => {
    // A tab title is a rename of the TAB, made deliberately and visible in the
    // rail; a pane name is a rename of the terminal. The more specific of the
    // two owns its own row.
    const h = harness({ tabTitle: "Deploy" });

    h.controller.renamePane(1, "Build");

    expect(railTitle(h.controller, "tab-1")).toBe("Deploy");
    // In the pane's OWN header the pane's own name is what was just typed.
    expect(h.controller.paneTitles("tab-1")[1]).toBe("Build");
  });

  it("gives a lone pane its tab's name when it has none of its own", () => {
    const h = harness({ tabTitle: "Deploy" });

    expect(h.controller.paneTitles("tab-1")[1]).toBe("Deploy");
  });

  it("goes back to the derived name when the name is cleared", () => {
    const h = harness();
    h.controller.renamePane(1, "Build");

    h.controller.renamePane(1, null);

    expect(h.controller.paneTitles("tab-1")[1]).toBe("powershell \u00b7 project");
    expect(railTitle(h.controller, "tab-1")).toBe("powershell \u00b7 project");
  });

  it("treats a name of nothing but spaces as clearing it", () => {
    const h = harness();
    h.controller.renamePane(1, "Build");

    h.controller.renamePane(1, "   ");

    expect(h.controller.paneTitles("tab-1")[1]).toBe("powershell \u00b7 project");
  });

  it("tells its subscribers, or the rename would not appear until something else changed", () => {
    const h = harness();
    const seen = vi.fn();
    h.controller.subscribe(seen);

    h.controller.renamePane(1, "Build");

    expect(seen).toHaveBeenCalled();
    // And the snapshot really is a new one: the cache keys on a revision, and
    // a rename that did not bump it would be invisible behind the old object.
    expect(railTitle(h.controller, "tab-1")).toBe("Build");
  });

  it("says nothing when the name did not actually change", () => {
    const h = harness();
    h.controller.renamePane(1, "Build");
    const seen = vi.fn();
    h.controller.subscribe(seen);

    h.controller.renamePane(1, "Build");

    expect(seen).not.toHaveBeenCalled();
  });

  it("keeps the name on an ended pane until the pane is dismissed", () => {
    const h = harness();
    h.controller.renamePane(1, "Build");

    h.closeSession(1);

    expect(h.controller.paneTitles("tab-1")[1]).toBe("Build");
  });

  it("saves distinct split-pane names and restores them with the workspace", async () => {
    const h = harness({ tabTitle: "Work" });
    h.controller.renamePane(1, "Plan");
    h.controller.renamePane(2, "Server");
    h.controller.renamePane(3, "Tests");
    await h.controller.flush();

    expect(h.saved.length).toBeGreaterThan(0);
    const restored = parseLayout(JSON.parse(JSON.stringify(h.saved.at(-1))));
    expect(restored).not.toBeNull();
    h.controller.dispose();
    const reopened = harness({ initialLayout: restored! });
    expect(reopened.controller.paneTitles("tab-2")).toEqual({ 2: "Server", 3: "Tests" });
    expect(reopened.controller.paneTitles("tab-1")[1]).toBe("Plan");
    expect(railTitle(reopened.controller, "tab-1")).toBe("Work");
    reopened.controller.dispose();
  });

  it("retains names across host restart and an ended pane's replacement session", async () => {
    const h = harness();
    h.controller.renamePane(2, "Server");
    h.controller.renamePane(3, "Tests");
    await h.controller.flush();
    const restored = parseLayout(h.saved.at(-1));
    expect(restored).not.toBeNull();
    h.controller.dispose();

    const reopened = harness({ initialLayout: reconcile(restored, []).layout, sessions: [] });
    expect(reopened.controller.paneTitles("tab-2")).toEqual({ 2: "Server", 3: "Tests" });
    expect(await reopened.controller.restartPane("tab-2", 2, "restart")).toBe(50);
    expect(reopened.controller.paneTitles("tab-2")).toEqual({ 50: "Server", 3: "Tests" });
    await reopened.controller.flush();
    const again = harness({ initialLayout: parseLayout(reopened.saved.at(-1))!, sessions: [session(50)] });
    expect(again.controller.paneTitles("tab-2")).toEqual({ 50: "Server", 3: "Tests" });
    reopened.controller.dispose();
    again.controller.dispose();
  });

  it("persists clearing a name and receives names from another window's layout", async () => {
    const h = harness();
    h.controller.renamePane(2, "Server");
    await h.controller.flush();
    expect(h.saved.length).toBeGreaterThan(0);
    const other = harness({ initialLayout: parseLayout(h.saved.at(-1))! });
    expect(other.controller.paneTitles("tab-2")[2]).toBe("Server");
    h.controller.renamePane(2, "   ");
    await h.controller.flush();
    other.store.replaceState(parseLayout(h.saved.at(-1))!);
    expect(other.controller.paneTitles("tab-2")[2]).toBe("powershell \u00b7 project");
    const reopened = harness({ initialLayout: parseLayout(h.saved.at(-1))! });
    expect(reopened.controller.paneTitles("tab-2")[2]).toBe("powershell \u00b7 project");
    h.controller.dispose();
    other.controller.dispose();
    reopened.controller.dispose();
  });
});
