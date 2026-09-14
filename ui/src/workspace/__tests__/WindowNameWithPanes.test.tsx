/**
 * The name over a terminal, once its tab has more than one pane.
 *
 * Michael, 2026-09-13: "we're still having issues with saving the name of the
 * window when there are multiple panes. It then just says PowerShell, and then
 * the name of the tab: it's not saving the name that I have actually put for
 * that window."
 *
 * His saved layout says which name that is. `windowNames` is empty — the
 * top-left header has never been used — while twenty tabs carry titles he
 * typed ("Amy Kittle", "TastyPPC.com", "TermX") and several of those tabs hold
 * three panes. So the name he put on the thing is the TAB's, the label he
 * watches revert is the one over the terminal itself, and "PowerShell, and
 * then the name of the tab" is `derivedTitle` — `powershell · TermX` for the
 * TermX tab standing in the TermX folder.
 *
 * The rail row for such a tab reads `tab.title`; the pane that row stands for
 * read it too, right up until a second pane appeared. That contradiction is
 * the bug: the rail and the pane header are supposed to say the same thing
 * about the same terminal.
 *
 * The window-name header is exercised here as well, through the real
 * controller, because it had to be ruled out before the pane titles could be
 * blamed: a window name survives both a split and a reload.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "../../settings/SettingsStore";
import type { SessionAttachment, SessionAttachmentCallbacks } from "../../host/client";
import type { JsonValue, SessionInfo } from "../../host/protocol";
import { createLayoutStore } from "../../state/store";
import { parseLayout, serializeLayout, type Layout } from "../../state/layout";
import { LayoutPersistence } from "../LayoutPersistence";
import {
  WorkspaceController,
  type WorkspaceAttachmentHub,
  type WorkspaceHostClient,
} from "../WorkspaceController";
import type { BootstrappedWorkspace } from "../bootstrapWorkspace";
import { WindowNameHeader } from "../WindowName";

const { setTitle } = vi.hoisted(() => ({ setTitle: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTitle }),
}));

const DERIVED = "powershell \u00b7 project";

function session(id: number, cwd: string | null = "C:\\work\\project"): SessionInfo {
  return { id, profile: "powershell", cwd, cols: 120, rows: 30, alive: true, pid: 1000 + id };
}

/// One tab, one pane — the shape every one of his split tabs was in before he
/// split it.
function lonePaneLayout(tabTitle: string | null): Layout {
  return {
    version: 3,
    auxWindows: {},
    windowNames: {},
    groups: {},
    rootItems: [{ kind: "tab", id: "tab-1" }],
    tabs: {
      "tab-1": {
        id: "tab-1",
        title: tabTitle,
        color: "blue",
        fill: "off",
        split: { kind: "pane", sessionId: 1 },
      },
    },
    activeTabId: "tab-1",
  };
}

function harness(options: { tabTitle?: string | null } = {}) {
  const client: WorkspaceHostClient = {
    createSession: vi.fn(async () => session(50)),
    closeSession: vi.fn(async () => undefined),
    onSessionExited: () => () => undefined,
    onSessionClosed: () => () => undefined,
    onError: () => () => undefined,
  };
  const persistence = new LayoutPersistence({
    setLayout: vi.fn(async () => undefined),
  });
  // ONE object, not a fresh one per call: the controller's snapshot cache
  // compares the hub's snapshot by identity, and a new object every time makes
  // `useSyncExternalStore` re-render for ever.
  const hubSnapshot = { sessions: {} };
  const attachments: WorkspaceAttachmentHub = {
    sendInput: vi.fn(() => true),
    getSnapshot: () => hubSnapshot,
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
  const store = createLayoutStore(lonePaneLayout(options.tabTitle ?? null));
  const controller = new WorkspaceController({
    client,
    store,
    persistence,
    attachments,
    sessions: [session(1), session(50)],
  });
  const workspace = {
    controller,
    settings: new SettingsStore(),
  } as unknown as BootstrappedWorkspace;
  return { controller, store, workspace };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setTitle.mockClear();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

async function render(ui: React.ReactElement) {
  await act(async () => root.render(ui));
}

function headerText(): string | undefined {
  return container.querySelector<HTMLElement>("[data-testid='window-name']")?.textContent
    ?? undefined;
}

/// The rail row's title for a tab, which is what the sidebar draws.
function railTitle(controller: WorkspaceController, tabId: string): string {
  return controller.getSnapshot().ungroupedTabs.find((row) => row.id === tabId)!.title;
}

describe("a named tab whose pane gets a sibling", () => {
  it("wears its tab's name while it is the only pane", () => {
    const h = harness({ tabTitle: "Amy Kittle" });

    expect(h.controller.paneTitles("tab-1")[1]).toBe("Amy Kittle");
  });

  it(
    "keeps that name once a second pane appears, instead of reverting to " +
      "'powershell \u00b7 project'",
    async () => {
      const h = harness({ tabTitle: "Amy Kittle" });

      await h.controller.splitPane("tab-1", 1, "row");

      expect(h.controller.paneTitles("tab-1")[1]).toBe("Amy Kittle");
    },
  );

  it("names the pane BESIDE it by what it is, so the two stay apart", async () => {
    // The reason a tab name cannot simply be stamped on every pane: panes in
    // one split are the same profile in the same folder, and only their own
    // names tell them apart.
    const h = harness({ tabTitle: "Amy Kittle" });

    await h.controller.splitPane("tab-1", 1, "row");

    expect(h.controller.paneTitles("tab-1")[50]).toBe(DERIVED);
  });

  it("never contradicts the rail row that stands for the same terminal", async () => {
    const h = harness({ tabTitle: "Amy Kittle" });

    await h.controller.splitPane("tab-1", 1, "row");

    // The row keeps the tab's name; the pane the row is a row FOR has to agree.
    expect(railTitle(h.controller, "tab-1")).toBe("Amy Kittle");
    expect(h.controller.paneTitles("tab-1")[1]).toBe(railTitle(h.controller, "tab-1"));
  });

  it("still lets a pane of its own be named over the tab's name", async () => {
    const h = harness({ tabTitle: "Amy Kittle" });
    await h.controller.splitPane("tab-1", 1, "row");

    h.controller.renamePane(1, "Blogs");

    expect(h.controller.paneTitles("tab-1")).toEqual({ 1: "Blogs", 50: DERIVED });
  });

  it("leaves an unnamed tab's panes entirely to the derivation", async () => {
    const h = harness({ tabTitle: null });

    await h.controller.splitPane("tab-1", 1, "row");

    expect(h.controller.paneTitles("tab-1")).toEqual({ 1: DERIVED, 50: DERIVED });
  });
});

describe("the window-name header — ruled out, and kept ruled out", () => {
  it("survives the tab under it being split", async () => {
    const h = harness();
    await render(<WindowNameHeader workspace={h.workspace} />);

    h.controller.renameWindow("main", "Client work");
    await act(async () => {
      await h.controller.splitPane("tab-1", 1, "row");
    });

    expect(headerText()).toBe("Client work");
  });

  it("survives a persist and reload of the layout", () => {
    const h = harness();
    h.controller.renameWindow("main", "Client work");

    const reloaded = parseLayout(
      JSON.parse(JSON.stringify(serializeLayout(h.store.getState()))) as JsonValue,
    );

    expect(reloaded?.windowNames).toEqual({ main: "Client work" });
  });

  it("follows the tab's name while the window has none of its own", async () => {
    const h = harness({ tabTitle: "Amy Kittle" });
    await render(<WindowNameHeader workspace={h.workspace} />);

    await act(async () => {
      await h.controller.splitPane("tab-1", 1, "row");
    });

    expect(headerText()).toBe("Amy Kittle");
  });
});
