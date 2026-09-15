/**
 * Naming a terminal END TO END (Michael, third report of the same bug on
 * 2026-09-15: "Window pane name saving is still not working").
 *
 * Every other pane-name test stops at a seam: the title bar reports the typed
 * name to a spy, or the controller is renamed by a direct call. This one
 * double-clicks the REAL title bar of a pane inside the REAL SplitLayout, with
 * the REAL controller, store and LayoutPersistence behind it, and asks the
 * only question that matters: is the name in the blob that reaches the daemon.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionAttachment, SessionAttachmentCallbacks } from "../../host/client";
import type { JsonValue, SessionInfo } from "../../host/protocol";
import { parseLayout, type Layout } from "../../state/layout";
import { createLayoutStore } from "../../state/store";
import { LayoutPersistence } from "../../workspace/LayoutPersistence";
import {
  WorkspaceController,
  type WorkspaceAttachmentHub,
  type WorkspaceHostClient,
} from "../../workspace/WorkspaceController";
import type { PaneHostClient } from "../../terminal/TerminalPane";
import { SplitLayout, type SplitLayoutActions } from "../SplitLayout";

/// The real TerminalPane needs xterm and a canvas. What it does that matters
/// HERE is take focus for the pane it renders — which is exactly what a rename
/// editor has to survive.
vi.mock("../../terminal/TerminalPane", () => ({
  TerminalPane: ({ sessionId }: { sessionId: number }) => (
    <textarea
      className="xterm-helper-textarea"
      data-testid={`terminal-${sessionId}`}
      readOnly
    />
  ),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

function session(id: number, cwd: string | null = "C:\\Users\\mjfos"): SessionInfo {
  return { id, profile: "powershell", cwd, cols: 120, rows: 30, alive: true, pid: 1000 + id };
}

/// Michael's shape: one named tab, three panes of the same profile in the same
/// folder (so every derived name is the same string).
function threePaneLayout(tabTitle: string | null = "Amy Kittle"): Layout {
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
        split: {
          kind: "split",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [
            { kind: "pane", sessionId: 1 },
            {
              kind: "split",
              dir: "col",
              sizes: [0.5, 0.5],
              children: [
                { kind: "pane", sessionId: 2 },
                { kind: "pane", sessionId: 3 },
              ],
            },
          ],
        },
      },
    },
    activeTabId: "tab-1",
  };
}

function harness(initialLayout: Layout = threePaneLayout()) {
  const client: WorkspaceHostClient = {
    createSession: vi.fn(async () => session(50)),
    closeSession: vi.fn(async () => undefined),
    onSessionExited: () => () => undefined,
    onSessionClosed: () => () => undefined,
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
  const store = createLayoutStore(initialLayout);
  const controller = new WorkspaceController({
    client,
    store,
    persistence,
    attachments,
    sessions: [session(1), session(2), session(3)],
  });
  return { controller, store, saved };
}

function layoutActions(): SplitLayoutActions {
  return {
    splitPane: vi.fn(),
    closePane: vi.fn(async () => undefined),
    dismissPane: vi.fn(async () => undefined),
    restartPane: vi.fn(async () => undefined),
    resizePane: vi.fn(),
  };
}

/// App.tsx's own wiring, condensed: the layout renders from the controller's
/// snapshot, the pane titles come from `controller.paneTitles`, and a rename
/// goes to `controller.renamePane`. Re-rendering on every publish is what the
/// real app does through useSyncExternalStore.
async function renderApp(h: ReturnType<typeof harness>, tabId = "tab-1") {
  // App keeps the focused pane in its own state and hands it back down, so a
  // click in a pane re-renders this layout before the double-click lands.
  let focused = 1;
  const draw = () => {
    const tab = h.store.getState().tabs[tabId]!;
    root.render(
      <SplitLayout
        tabId={tabId}
        root={tab.split}
        client={{} as PaneHostClient}
        paneStates={{
          1: { status: "live", exitCode: null },
          2: { status: "live", exitCode: null },
          3: { status: "live", exitCode: null },
          50: { status: "live", exitCode: null },
        }}
        focusedSessionId={focused}
        dismissingSessionIds={new Set()}
        onFocusPane={(sessionId) => {
          if (focused !== sessionId) {
            focused = sessionId;
            draw();
          }
        }}
        actions={layoutActions()}
        paneTitles={h.controller.paneTitles(tabId)}
        onRenamePane={h.controller.renamePane}
      />,
    );
  };
  h.controller.subscribe(() => draw());
  await act(async () => draw());
  return { redraw: async () => { await act(async () => draw()); } };
}

function titleOf(sessionId: number): string | null {
  return container
    .querySelector(`[data-testid='split-pane-title-${sessionId}']`)
    ?.textContent ?? null;
}

function editorFor(sessionId: number): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(
    `[data-testid='split-pane-rename-${sessionId}'] input`,
  );
}

async function doubleClickTitle(sessionId: number): Promise<void> {
  const title = container.querySelector(`[data-testid='split-pane-title-${sessionId}']`);
  expect(title, `pane ${sessionId} has no title bar to double-click`).not.toBeNull();
  await act(async () => {
    title!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
}

async function typeAndEnter(sessionId: number, name: string): Promise<void> {
  const input = editorFor(sessionId);
  expect(input, `pane ${sessionId} did not open a rename editor`).not.toBeNull();
  input!.value = name;
  await act(async () => {
    input!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
  });
}

/// Every pane title in the blob that reached the daemon, keyed by session id.
function savedTitles(blob: JsonValue | undefined): Record<number, string | undefined> {
  const layout = parseLayout(blob as JsonValue);
  expect(layout, "the saved blob did not parse back").not.toBeNull();
  const out: Record<number, string | undefined> = {};
  const walk = (node: { kind: string; sessionId?: number; title?: string; children?: unknown[] }) => {
    if (node.kind === "pane") {
      out[node.sessionId!] = node.title;
      return;
    }
    for (const child of node.children ?? []) {
      walk(child as Parameters<typeof walk>[0]);
    }
  };
  for (const tab of Object.values(layout!.tabs)) {
    walk(tab.split as Parameters<typeof walk>[0]);
  }
  return out;
}

describe("naming a pane from its own title bar, all the way to the daemon", () => {
  it("names the second pane of a three-pane tab", async () => {
    const h = harness();
    await renderApp(h);

    await doubleClickTitle(2);
    await typeAndEnter(2, "Blogs");

    expect(h.controller.paneTitles("tab-1")[2]).toBe("Blogs");
    expect(titleOf(2)).toBe("Blogs");
    await h.controller.flush();
    expect(savedTitles(h.saved.at(-1))[2]).toBe("Blogs");
  });

  it("names the third pane, which is the deepest one in the tree", async () => {
    const h = harness();
    await renderApp(h);

    await doubleClickTitle(3);
    await typeAndEnter(3, "SEO");

    expect(h.controller.paneTitles("tab-1")[3]).toBe("SEO");
    await h.controller.flush();
    expect(savedTitles(h.saved.at(-1))[3]).toBe("SEO");
  });

  it("names the primary pane, whose bar shows the tab's name", async () => {
    const h = harness();
    await renderApp(h);
    expect(titleOf(1)).toBe("Amy Kittle");

    await doubleClickTitle(1);
    await typeAndEnter(1, "Plan");

    expect(h.controller.paneTitles("tab-1")[1]).toBe("Plan");
    await h.controller.flush();
    expect(savedTitles(h.saved.at(-1))[1]).toBe("Plan");
  });

  it("names all three panes in turn, each keeping the ones before it", async () => {
    const h = harness();
    await renderApp(h);

    await doubleClickTitle(1);
    await typeAndEnter(1, "Plan");
    await doubleClickTitle(2);
    await typeAndEnter(2, "Blogs");
    await doubleClickTitle(3);
    await typeAndEnter(3, "SEO");

    expect(h.controller.paneTitles("tab-1")).toEqual({ 1: "Plan", 2: "Blogs", 3: "SEO" });
    await h.controller.flush();
    expect(savedTitles(h.saved.at(-1))).toEqual({ 1: "Plan", 2: "Blogs", 3: "SEO" });
  });

  it("keeps the typed name when the app re-renders mid-edit", async () => {
    // Terminal output, a cwd report, an activity tick: the app re-renders
    // constantly while a rename editor is open, and the half-typed name lives
    // in an uncontrolled input that a remount would silently reset.
    const h = harness();
    const app = await renderApp(h);

    await doubleClickTitle(2);
    const input = editorFor(2)!;
    input.value = "Blogs";
    await app.redraw();
    await app.redraw();

    expect(editorFor(2)?.value).toBe("Blogs");
    await act(async () => {
      editorFor(2)!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });
    expect(h.controller.paneTitles("tab-1")[2]).toBe("Blogs");
  });

  it("commits the name when the terminal takes focus back instead of Enter", async () => {
    // Clicking into the terminal is how a rename ends for anyone who does not
    // press Enter. Blur must commit what was typed, not throw it away.
    const h = harness();
    await renderApp(h);

    await doubleClickTitle(2);
    const input = editorFor(2)!;
    expect(document.activeElement).toBe(input);
    input.value = "Blogs";
    const terminal = container.querySelector<HTMLTextAreaElement>(
      "[data-testid='terminal-2']",
    )!;
    await act(async () => {
      terminal.focus();
    });

    expect(h.controller.paneTitles("tab-1")[2]).toBe("Blogs");
  });

  it("does not commit the derived name when the terminal steals focus first", async () => {
    // xterm grabs focus for the pane the pointer landed in. If that arrives
    // after the editor opened but before anything is typed, a blur-commit
    // would write the DERIVED name in as an explicit one — a name the user
    // never chose, and one that can never go back to following the folder.
    const h = harness();
    await renderApp(h);

    await doubleClickTitle(2);
    const terminal = container.querySelector<HTMLTextAreaElement>(
      "[data-testid='terminal-2']",
    )!;
    await act(async () => {
      terminal.focus();
    });

    expect(h.controller.paneTitles("tab-1")[2]).toBe("powershell · mjfos");
    await h.controller.flush();
    // Nothing was named, so nothing was written; if anything was, the pane is
    // still unnamed in it.
    const blob = h.saved.at(-1);
    expect(blob === undefined || savedTitles(blob)[2] === undefined).toBe(true);
  });

  it("names a pane the user has not been working in", async () => {
    // The real gesture on Michael's screenshot: the focus is in one pane and
    // he double-clicks the title of ANOTHER. The first click focuses that pane
    // — which re-renders the whole layout — and the second click has to still
    // land on the same title bar and open its editor.
    const h = harness();
    await renderApp(h);
    const title = container.querySelector("[data-testid='split-pane-title-3']")!;

    await act(async () => {
      title.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      title.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      title.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    });
    // The title bar the second click landed on is the one still in the DOM.
    expect(container.querySelector("[data-testid='split-pane-title-3']")).toBe(title);
    await act(async () => {
      title.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await typeAndEnter(3, "SEO");

    expect(h.controller.paneTitles("tab-1")[3]).toBe("SEO");
    await h.controller.flush();
    expect(savedTitles(h.saved.at(-1))[3]).toBe("SEO");
  });

  it("renames the same pane twice in a row", async () => {
    const h = harness();
    await renderApp(h);

    await doubleClickTitle(2);
    await typeAndEnter(2, "Blogs");
    await doubleClickTitle(2);
    await typeAndEnter(2, "Drafts");

    expect(h.controller.paneTitles("tab-1")[2]).toBe("Drafts");
    await h.controller.flush();
    expect(savedTitles(h.saved.at(-1))[2]).toBe("Drafts");
  });

  it("survives a reboot from the blob that was actually written", async () => {
    const h = harness();
    await renderApp(h);
    await doubleClickTitle(2);
    await typeAndEnter(2, "Blogs");
    await doubleClickTitle(3);
    await typeAndEnter(3, "SEO");
    await h.controller.flush();
    h.controller.dispose();

    const restored = parseLayout(h.saved.at(-1)!);
    expect(restored).not.toBeNull();
    const again = harness(restored!);
    expect(again.controller.paneTitles("tab-1")).toEqual({
      1: "Amy Kittle",
      2: "Blogs",
      3: "SEO",
    });
    again.controller.dispose();
  });
});
