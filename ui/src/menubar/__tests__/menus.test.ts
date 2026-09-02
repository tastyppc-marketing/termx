/**
 * The menu item models, on their own.
 *
 * These are pure data — label, printed shortcut, disabled, and the callback —
 * so what each row PROMISES can be pinned without a DOM. The load-bearing test
 * is the last one: the menu is also how a user learns the keyboard, so a row
 * may print only a binding TermX actually listens for.
 */

import { describe, expect, it, vi } from "vitest";
import {
  EXISTING_SHORTCUTS,
  viewMenu,
  workspaceMenu,
  type MenuItemModel,
  type MenuRow,
  type ViewMenuDeps,
  type WorkspaceMenuDeps,
} from "../menus";

function items(rows: readonly MenuRow[]): MenuItemModel[] {
  return rows.filter((row): row is MenuItemModel => row.kind === "item");
}

function byId(rows: readonly MenuRow[], id: string): MenuItemModel {
  const found = items(rows).find((row) => row.id === id);
  if (!found) {
    throw new Error(`no row ${id} in ${items(rows).map((row) => row.id).join(", ")}`);
  }
  return found;
}

function workspaceDeps(
  overrides: Partial<WorkspaceMenuDeps> = {},
): WorkspaceMenuDeps {
  return {
    hasLivePane: true,
    canClosePane: true,
    canSaveSession: true,
    newTab: vi.fn(),
    openFolderAsTab: vi.fn(),
    splitPane: vi.fn(),
    closePane: vi.fn(),
    newWindow: vi.fn(),
    renameWindow: vi.fn(),
    saveSession: vi.fn(),
    ...overrides,
  };
}

function viewDeps(overrides: Partial<ViewMenuDeps> = {}): ViewMenuDeps {
  return {
    sideRail: true,
    conversationsRail: true,
    statusBar: true,
    toggle: vi.fn(),
    ...overrides,
  };
}

describe("workspaceMenu", () => {
  it("lists the spec's rows, in order, with its two dividers", () => {
    const rows = workspaceMenu(workspaceDeps());
    expect(rows.map((row) => (row.kind === "item" ? row.id : "—"))).toEqual([
      "new-tab",
      "open-folder",
      "split-right",
      "split-down",
      "close-pane",
      "—",
      "new-window",
      "rename-window",
      "—",
      "save-session",
    ]);
    expect(items(rows).map((row) => row.label)).toEqual([
      "New tab",
      "Open folder as tab…",
      "Split right",
      "Split down",
      "Close pane",
      "New window",
      "Rename window",
      "Save session…",
    ]);
  });

  it("prints ONLY bindings TermX already listens for", () => {
    // The menu teaches the keyboard, so a printed shortcut is a promise. Every
    // string in the column must be one of the five bindings that exist; a row
    // with no binding prints nothing rather than inventing one.
    const known = new Set<string>(Object.values(EXISTING_SHORTCUTS));
    const printed = items(workspaceMenu(workspaceDeps()))
      .map((row) => row.shortcut)
      .filter((shortcut): shortcut is string => shortcut !== undefined);
    for (const shortcut of printed) {
      expect(known, `invented shortcut ${shortcut}`).toContain(shortcut);
    }
    expect(byId(workspaceMenu(workspaceDeps()), "open-folder").shortcut)
      .toBe("Ctrl+Shift+O");
    expect(byId(workspaceMenu(workspaceDeps()), "split-right").shortcut)
      .toBe("Ctrl+Shift+D");
    expect(byId(workspaceMenu(workspaceDeps()), "split-down").shortcut)
      .toBe("Ctrl+Shift+E");
    expect(byId(workspaceMenu(workspaceDeps()), "close-pane").shortcut)
      .toBe("Ctrl+Shift+W");
    expect(byId(workspaceMenu(workspaceDeps()), "rename-window").shortcut)
      .toBe("F2");
    // No Ctrl+T, no Ctrl+O, no Ctrl+Shift+N: nothing listens for them.
    expect(byId(workspaceMenu(workspaceDeps()), "new-tab").shortcut).toBeUndefined();
    expect(byId(workspaceMenu(workspaceDeps()), "new-window").shortcut).toBeUndefined();
    expect(byId(workspaceMenu(workspaceDeps()), "save-session").shortcut)
      .toBeUndefined();
  });

  it("runs the action each row names", () => {
    const deps = workspaceDeps();
    const rows = workspaceMenu(deps);
    byId(rows, "new-tab").onSelect();
    byId(rows, "open-folder").onSelect();
    byId(rows, "split-right").onSelect();
    byId(rows, "split-down").onSelect();
    byId(rows, "close-pane").onSelect();
    byId(rows, "new-window").onSelect();
    byId(rows, "rename-window").onSelect();
    byId(rows, "save-session").onSelect();

    expect(deps.newTab).toHaveBeenCalledTimes(1);
    expect(deps.openFolderAsTab).toHaveBeenCalledTimes(1);
    expect(deps.splitPane).toHaveBeenNthCalledWith(1, "row");
    expect(deps.splitPane).toHaveBeenNthCalledWith(2, "col");
    expect(deps.closePane).toHaveBeenCalledTimes(1);
    expect(deps.newWindow).toHaveBeenCalledTimes(1);
    expect(deps.renameWindow).toHaveBeenCalledTimes(1);
    expect(deps.saveSession).toHaveBeenCalledTimes(1);
  });

  it("disables the SPLIT rows when the focused pane is not alive", () => {
    const rows = workspaceMenu(workspaceDeps({ hasLivePane: false }));
    expect(byId(rows, "split-right").disabled).toBe(true);
    expect(byId(rows, "split-down").disabled).toBe(true);
    // Creating work never needs a pane to already exist.
    expect(byId(rows, "new-tab").disabled).toBe(false);
    expect(byId(rows, "open-folder").disabled).toBe(false);
  });

  it(
    "keeps Close pane live for a pane that is NOT alive — a plugin panel and " +
      "a dead terminal are both panes you close, and the Ctrl+Shift+W this " +
      "row prints closes them either way",
    () => {
      const rows = workspaceMenu(
        workspaceDeps({ hasLivePane: false, canClosePane: true }),
      );
      expect(byId(rows, "close-pane").disabled).toBe(false);
      // Only the absence of a focused pane greys it.
      const empty = workspaceMenu(
        workspaceDeps({ hasLivePane: false, canClosePane: false }),
      );
      expect(byId(empty, "close-pane").disabled).toBe(true);
    },
  );

  it("disables Save session… without a store, and nothing else", () => {
    const noSave = workspaceMenu(workspaceDeps({ canSaveSession: false }));
    expect(byId(noSave, "save-session").disabled).toBe(true);
    // New window MAKES the tab it moves out, so an empty workspace is not a
    // reason to grey it: there is nothing it needs that is not already there.
    expect(byId(noSave, "new-window").disabled).toBe(false);
    expect(byId(noSave, "rename-window").disabled).toBe(false);
  });
});

describe("viewMenu", () => {
  it("lists the three chrome toggles and prints each one's state", () => {
    const rows = viewMenu(viewDeps({ conversationsRail: false }));
    expect(items(rows).map((row) => [row.id, row.label, row.state])).toEqual([
      ["side-rail", "Side rail", true],
      ["conversations-rail", "Conversations rail", false],
      ["status-bar", "Status bar", true],
    ]);
  });

  it("toggles each setting to its inverse", () => {
    const deps = viewDeps({ sideRail: true, conversationsRail: false, statusBar: true });
    const rows = viewMenu(deps);
    byId(rows, "side-rail").onSelect();
    byId(rows, "conversations-rail").onSelect();
    byId(rows, "status-bar").onSelect();
    expect(deps.toggle).toHaveBeenNthCalledWith(1, "sideRail", false);
    expect(deps.toggle).toHaveBeenNthCalledWith(2, "conversationsRail", true);
    expect(deps.toggle).toHaveBeenNthCalledWith(3, "statusBar", false);
  });

  it(
    "prints no key on the conversations row — Ctrl+Shift+R opens the session " +
      "palette, which is not what this row does",
    () => {
      for (const row of items(viewMenu(viewDeps()))) {
        expect(row.shortcut).toBeUndefined();
      }
    },
  );
});
