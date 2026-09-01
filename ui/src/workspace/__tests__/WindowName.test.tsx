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
import type { WorkspaceSnapshot } from "../WorkspaceController";
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

/** A workspace whose controller records what the header asks of it. */
function harness(options: { layout?: Layout; settings?: Partial<TermxSettings> } = {}) {
  const layout = options.layout ?? { ...emptyLayout(), activeTabId: "tab-1" };
  const snapshot = {
    layout,
    rootItems: [],
    ungroupedTabs: [],
    groups: [],
    paneStates: {},
    activeTabId: layout.activeTabId,
    activeSessionId: null,
    persistence: { saving: false, error: null },
    notice: null,
  } as unknown as WorkspaceSnapshot;
  const controller = {
    windowId: "main",
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    renameWindow: vi.fn(),
    renameTab: vi.fn(),
  };
  const settings = new SettingsStore();
  if (options.settings) {
    settings.update(options.settings);
  }
  return {
    controller,
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

    expect(controller.renameWindow).toHaveBeenCalledExactlyOnceWith("main", "Client work");
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

      expect(controller.renameWindow).toHaveBeenCalledTimes(1);
      expect(controller.renameTab).not.toHaveBeenCalled();
    },
  );

  it("renames this window's active tab as well once the setting is on", async () => {
    const { controller, workspace } = harness({
      settings: { syncWindowRenameToTab: true },
    });
    await render(<WindowNameHeader workspace={workspace} />);

    await beginEdit();
    await type("Client work");
    await press("Enter");

    expect(controller.renameTab).toHaveBeenCalledExactlyOnceWith("tab-1", "Client work");
  });

  it("carries a cleared name through to the tab too, when the setting is on", async () => {
    const { controller, workspace } = harness({
      layout: { ...emptyLayout(), activeTabId: "tab-1", windowNames: { main: "Old" } },
      settings: { syncWindowRenameToTab: true },
    });
    await render(<WindowNameHeader workspace={workspace} />);

    await beginEdit();
    await type("");
    await press("Enter");

    expect(controller.renameWindow).toHaveBeenCalledExactlyOnceWith("main", null);
    expect(controller.renameTab).toHaveBeenCalledExactlyOnceWith("tab-1", null);
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
