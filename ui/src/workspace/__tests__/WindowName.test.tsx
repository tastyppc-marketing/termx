/**
 * Naming a window, and the one setting that decides whether the rail tab
 * comes along.
 *
 * The default-OFF case is the feature, not a conservative default: a window
 * name is a heading over the two or three panes inside it, while a rail tab
 * names one terminal. So the assertion that `renameTab` is NOT called carries
 * as much weight here as the assertion that the window name was stored.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type TermxSettings } from "../../settings/settings";
import { SettingsStore } from "../../settings/SettingsStore";
import { emptyLayout, type Layout } from "../../state/layout";
import type { SidebarTabModel, WorkspaceSnapshot } from "../WorkspaceController";
import type { BootstrappedWorkspace } from "../bootstrapWorkspace";
import {
  DEFAULT_WINDOW_NAME,
  WindowName,
  WindowNameHeader,
  windowTitleFor,
} from "../WindowName";

const { setTitle } = vi.hoisted(() => ({ setTitle: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTitle }),
}));

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

function label(): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-testid='window-name']");
}

function editor(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>("input.inline-rename");
}

async function beginEdit() {
  await act(async () => {
    label()!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  });
}

async function type(value: string) {
  const input = editor()!;
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(key: string) {
  await act(async () => {
    editor()!.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

describe("windowTitleFor", () => {
  it("puts the name in front of the app, and says just TermX when unnamed", () => {
    expect(windowTitleFor("Client work")).toBe("Client work — TermX");
    expect(windowTitleFor(null)).toBe("TermX");
  });
});

describe("WindowName — the label and its editor", () => {
  it("shows the default until the window has a name of its own", async () => {
    await render(<WindowName name={null} onRename={vi.fn()} />);
    expect(label()?.textContent).toBe(DEFAULT_WINDOW_NAME);

    await render(<WindowName name="Client work" onRename={vi.fn()} />);
    expect(label()?.textContent).toBe("Client work");
  });

  it("reads as the fallback it is given, until it has a name of its own", async () => {
    await render(
      <WindowName name={null} fallback="PowerShell / ui" onRename={vi.fn()} />,
    );
    expect(label()?.textContent).toBe("PowerShell / ui");

    // A name the user typed is the window's own; it does not follow anything.
    await render(
      <WindowName name="Client work" fallback="PowerShell / ui" onRename={vi.fn()} />,
    );
    expect(label()?.textContent).toBe("Client work");
  });

  it("offers the fallback as the editor's placeholder, on an empty field", async () => {
    await render(
      <WindowName name={null} fallback="PowerShell / ui" onRename={vi.fn()} />,
    );

    await beginEdit();

    // Opening the editor must show what the label currently READS, and start
    // empty so typing begins fresh and Escape leaves it following.
    expect(editor()!.placeholder).toBe("PowerShell / ui");
    expect(editor()!.value).toBe("");
  });

  it("commits a new name on Enter", async () => {
    const onRename = vi.fn();
    await render(<WindowName name={null} onRename={onRename} />);

    await beginEdit();
    expect(editor()).not.toBeNull();
    await type("Client work");
    await press("Enter");

    expect(onRename).toHaveBeenCalledExactlyOnceWith("Client work");
    expect(editor()).toBeNull();
  });

  it("abandons the edit on Escape, changing nothing", async () => {
    const onRename = vi.fn();
    await render(<WindowName name="Client work" onRename={onRename} />);

    await beginEdit();
    await type("Something else");
    await press("Escape");

    expect(onRename).not.toHaveBeenCalled();
    expect(editor()).toBeNull();
    expect(label()?.textContent).toBe("Client work");
  });

  it("takes an empty commit as 'go back to the default', not as a blank name", async () => {
    const onRename = vi.fn();
    await render(<WindowName name="Client work" onRename={onRename} />);

    await beginEdit();
    await type("   ");
    await press("Enter");

    expect(onRename).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("claims Escape while editing, so nothing behind it also closes", async () => {
    await render(<WindowName name={null} onRename={vi.fn()} />);
    await beginEdit();

    // The ownership marker the settings surface checks before treating an
    // Escape as its own.
    expect(editor()!.closest("[data-esc-guard]")).not.toBeNull();
  });

  it("opens the editor on F2 too, so a mouse is not the only way in", async () => {
    await render(<WindowName name={null} onRename={vi.fn()} />);

    await act(async () => {
      label()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true }),
      );
    });

    expect(editor()).not.toBeNull();
  });
});

/** A rail row, as the controller projects it: `title` is already resolved. */
function railTab(id: string, title: string) {
  return { id, title } as unknown as SidebarTabModel;
}

interface Rows {
  /** This window's root-level rail rows. */
  tabs?: SidebarTabModel[];
  /** Rows that live inside a group, to prove the search is not root-only. */
  grouped?: SidebarTabModel[];
}

/** A workspace whose controller records what the header asks of it. */
function harness(
  options: { layout?: Layout; settings?: Partial<TermxSettings> } & Rows = {},
) {
  const layout = options.layout ?? { ...emptyLayout(), activeTabId: "tab-1" };
  const build = (current: Layout, rows: Rows): WorkspaceSnapshot =>
    ({
      layout: current,
      rootItems: [],
      ungroupedTabs: rows.tabs ?? [],
      groups: rows.grouped ? [{ tabs: rows.grouped }] : [],
      paneStates: {},
      activeTabId: current.activeTabId,
      activeSessionId: null,
      persistence: { saving: false, error: null },
      notice: null,
    }) as unknown as WorkspaceSnapshot;
  let snapshot = build(layout, options);
  const listeners = new Set<() => void>();
  const controller = {
    windowId: "main",
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    renameWindow: vi.fn(),
    renameTab: vi.fn(),
  };
  /** What the daemon does: a new snapshot, and everyone re-reads it. */
  const publish = async (next: { layout?: Layout } & Rows) => {
    snapshot = build(next.layout ?? snapshot.layout, next);
    await act(async () => {
      for (const fn of [...listeners]) fn();
    });
  };
  const settings = new SettingsStore();
  if (options.settings) {
    settings.update(options.settings);
  }
  return {
    controller,
    publish,
    workspace: { controller, settings } as unknown as BootstrappedWorkspace,
  };
}

describe("WindowNameHeader — what a commit actually does", () => {
  it("stores the name against this window", async () => {
    const { controller, workspace } = harness();
    await render(<WindowNameHeader workspace={workspace} />);

    await beginEdit();
    await type("Client work");
    await press("Enter");

    expect(controller.renameWindow).toHaveBeenCalledExactlyOnceWith(
      "main",
      "Client work",
      false,
    );
  });

  it(
    "leaves the rail tab alone by default — the window is the group label, " +
      "and the tab keeps naming its own terminal",
    async () => {
      expect(DEFAULT_SETTINGS.syncWindowRenameToTab).toBe(false);
      const { controller, workspace } = harness();
      await render(<WindowNameHeader workspace={workspace} />);

      await beginEdit();
      await type("Client work");
      await press("Enter");

      expect(controller.renameWindow).toHaveBeenCalledExactlyOnceWith(
        "main",
        "Client work",
        false,
      );
    },
  );

  it(
    "asks for the tab rename in the SAME call once the setting is on, never " +
      "as a second mutation of its own",
    async () => {
      const { controller, workspace } = harness({
        settings: { syncWindowRenameToTab: true },
      });
      await render(<WindowNameHeader workspace={workspace} />);

      await beginEdit();
      await type("Client work");
      await press("Enter");

      expect(controller.renameWindow).toHaveBeenCalledExactlyOnceWith(
        "main",
        "Client work",
        true,
      );
      // A second call here is the bug this shape exists to prevent: it would
      // put a half-synced layout on the bus and could persist alone.
      expect(controller.renameTab).not.toHaveBeenCalled();
    },
  );

  it("carries a cleared name through to the tab too, when the setting is on", async () => {
    const { controller, workspace } = harness({
      layout: { ...emptyLayout(), activeTabId: "tab-1", windowNames: { main: "Old" } },
      settings: { syncWindowRenameToTab: true },
    });
    await render(<WindowNameHeader workspace={workspace} />);

    await beginEdit();
    await type("");
    await press("Enter");

    expect(controller.renameWindow).toHaveBeenCalledExactlyOnceWith("main", null, true);
    expect(controller.renameTab).not.toHaveBeenCalled();
  });

  it("shows the name this window already carries in the layout", async () => {
    const { workspace } = harness({
      layout: { ...emptyLayout(), windowNames: { main: "Deploys" } },
    });

    await render(<WindowNameHeader workspace={workspace} />);

    expect(label()?.textContent).toBe("Deploys");
  });

  it("puts a named window's name in the OS title bar", async () => {
    const { workspace } = harness({
      layout: { ...emptyLayout(), windowNames: { main: "Deploys" } },
    });

    await render(<WindowNameHeader workspace={workspace} />);

    expect(setTitle).toHaveBeenCalledWith("Deploys — TermX");
  });

  it("leaves an unnamed window titled plainly", async () => {
    const { workspace } = harness();

    await render(<WindowNameHeader workspace={workspace} />);

    expect(setTitle).toHaveBeenCalledWith("TermX");
  });
});

describe("WindowNameHeader - an unnamed window follows its active tab", () => {
  /**
   * Michael's report: the header said "Terminal workspace" in every window,
   * and the rail is hard to read at a glance. An unnamed window has no name of
   * its own to show, so it shows the one thing it IS - the tab you are on.
   *
   * The title comes from the rail row the controller already projected, never
   * from a second derivation here: `tab.title` has the rename, the pane name
   * and the cwd-derived fallback resolved into it, so the header and the rail
   * row beside it cannot disagree.
   */
  it("shows the active tab's rail title, in the label and the OS title bar", async () => {
    const { workspace } = harness({ tabs: [railTab("tab-1", "PowerShell / ui")] });

    await render(<WindowNameHeader workspace={workspace} />);

    expect(label()?.textContent).toBe("PowerShell / ui");
    expect(setTitle).toHaveBeenCalledWith("PowerShell / ui \u2014 TermX");
  });

  it("finds the active tab inside a group, not just at the root", async () => {
    const { workspace } = harness({ grouped: [railTab("tab-1", "Deploy / api")] });

    await render(<WindowNameHeader workspace={workspace} />);

    expect(label()?.textContent).toBe("Deploy / api");
  });

  it("follows the switch when the user moves to another tab", async () => {
    const rows = [railTab("tab-1", "PowerShell / ui"), railTab("tab-2", "bash / api")];
    const { workspace, publish } = harness({ tabs: rows });
    await render(<WindowNameHeader workspace={workspace} />);

    await publish({ layout: { ...emptyLayout(), activeTabId: "tab-2" }, tabs: rows });

    expect(label()?.textContent).toBe("bash / api");
    expect(setTitle).toHaveBeenLastCalledWith("bash / api \u2014 TermX");
  });

  it("follows the tab being renamed, or changing folder", async () => {
    const { workspace, publish } = harness({ tabs: [railTab("tab-1", "PowerShell / ui")] });
    await render(<WindowNameHeader workspace={workspace} />);

    await publish({ tabs: [railTab("tab-1", "PowerShell / api")] });

    expect(label()?.textContent).toBe("PowerShell / api");
  });

  it("stops following once the window has a name of its own", async () => {
    const { workspace } = harness({
      layout: { ...emptyLayout(), activeTabId: "tab-1", windowNames: { main: "Deploys" } },
      tabs: [railTab("tab-1", "PowerShell / ui")],
    });

    await render(<WindowNameHeader workspace={workspace} />);

    expect(label()?.textContent).toBe("Deploys");
    expect(setTitle).toHaveBeenCalledWith("Deploys \u2014 TermX");
  });

  it("follows the tab again after the name is cleared", async () => {
    const rows = [railTab("tab-1", "PowerShell / ui"), railTab("tab-2", "bash / api")];
    const { controller, workspace, publish } = harness({
      layout: { ...emptyLayout(), activeTabId: "tab-1", windowNames: { main: "Deploys" } },
      tabs: rows,
    });
    await render(<WindowNameHeader workspace={workspace} />);

    await beginEdit();
    await type("");
    await press("Enter");
    expect(controller.renameWindow).toHaveBeenCalledExactlyOnceWith("main", null, false);

    // The layout comes back without the name, and the header is following
    // again - proved by a switch, not just by the label it happens to show.
    await publish({ layout: { ...emptyLayout(), activeTabId: "tab-2" }, tabs: rows });

    expect(label()?.textContent).toBe("bash / api");
  });

  it("says the old default only when this window has no tab at all", async () => {
    const { workspace } = harness({ layout: emptyLayout(), tabs: [] });

    await render(<WindowNameHeader workspace={workspace} />);

    expect(label()?.textContent).toBe(DEFAULT_WINDOW_NAME);
    // The OS title does NOT become the default label: with nothing to follow,
    // it stays the plain app name it has always been.
    expect(setTitle).toHaveBeenCalledWith("TermX");
  });
});
