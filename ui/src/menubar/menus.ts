/**
 * The menubar's item models — pure data, no React, no DOM.
 *
 * A menubar is two things at once: a place to reach an action with the mouse,
 * and the only place most people ever learn the keyboard from. The second is
 * why `shortcut` is treated as a promise rather than a decoration: a row may
 * print only a binding TermX actually listens for, so `EXISTING_SHORTCUTS` is
 * the whole vocabulary and `menus.test.ts` guards it. Nothing here invents a
 * binding, and a row with no binding prints nothing at all.
 *
 * Every row's `onSelect` is a call the rail, the pane toolbar or a context
 * menu already makes. The menubar is a second doorway onto the same actions,
 * never a second implementation of them.
 */

/** The five bindings that exist today. The menu may print no others. */
export const EXISTING_SHORTCUTS = {
  /** SplitLayout's window-capture handler. */
  splitRight: "Ctrl+Shift+D",
  splitDown: "Ctrl+Shift+E",
  closePane: "Ctrl+Shift+W",
  /** App's folder-search handler. */
  openFolderAsTab: "Ctrl+Shift+O",
  /** The window-name header's own F2, the same key the rail renames with. */
  renameWindow: "F2",
} as const;

export interface MenuItemModel {
  readonly kind: "item";
  readonly id: string;
  readonly label: string;
  /**
   * The right-hand column, when this row has a key binding. Must be a value of
   * `EXISTING_SHORTCUTS`; a row with nothing bound leaves it out.
   */
  readonly shortcut?: string;
  /**
   * The right-hand column, when this row is a toggle: its live state, printed
   * `on` / `off`. Mutually exclusive with `shortcut` in practice — none of the
   * toggles has a binding.
   */
  readonly state?: boolean;
  /** A row whose action has nothing to act on is shown, greyed, not hidden. */
  readonly disabled: boolean;
  onSelect(): void;
}

export interface MenuSeparatorModel {
  readonly kind: "separator";
  readonly id: string;
}

export type MenuRow = MenuItemModel | MenuSeparatorModel;

export interface WorkspaceMenuDeps {
  /**
   * The focused pane exists AND is alive. Splitting needs that — SplitLayout
   * refuses to split anything else — but closing does not.
   */
  readonly hasLivePane: boolean;
  /**
   * There is a focused pane at all, whatever state it is in. A plugin panel
   * and a dead terminal are both things you close, and the Ctrl+Shift+W this
   * row prints closes them; greying the row while the key still works would
   * make the menu lie about the keyboard it is teaching.
   */
  readonly canClosePane: boolean;
  /** A saved-sessions store and a pane to save are both present. */
  readonly canSaveSession: boolean;
  newTab(): void;
  openFolderAsTab(): void;
  splitPane(dir: "row" | "col"): void;
  closePane(): void;
  newWindow(): void;
  renameWindow(): void;
  saveSession(): void;
}

export function workspaceMenu(deps: WorkspaceMenuDeps): readonly MenuRow[] {
  return [
    {
      kind: "item",
      id: "new-tab",
      label: "New tab",
      disabled: false,
      onSelect: () => deps.newTab(),
    },
    {
      kind: "item",
      id: "open-folder",
      label: "Open folder as tab…",
      shortcut: EXISTING_SHORTCUTS.openFolderAsTab,
      disabled: false,
      onSelect: () => deps.openFolderAsTab(),
    },
    {
      kind: "item",
      id: "split-right",
      label: "Split right",
      shortcut: EXISTING_SHORTCUTS.splitRight,
      disabled: !deps.hasLivePane,
      onSelect: () => deps.splitPane("row"),
    },
    {
      kind: "item",
      id: "split-down",
      label: "Split down",
      shortcut: EXISTING_SHORTCUTS.splitDown,
      disabled: !deps.hasLivePane,
      onSelect: () => deps.splitPane("col"),
    },
    {
      kind: "item",
      id: "close-pane",
      label: "Close pane",
      shortcut: EXISTING_SHORTCUTS.closePane,
      disabled: !deps.canClosePane,
      onSelect: () => deps.closePane(),
    },
    { kind: "separator", id: "sep-windows" },
    {
      kind: "item",
      id: "new-window",
      label: "New window",
      // Never greyed: it makes the tab it moves out, so it needs nothing that
      // is not already here.
      disabled: false,
      onSelect: () => deps.newWindow(),
    },
    {
      kind: "item",
      id: "rename-window",
      label: "Rename window",
      shortcut: EXISTING_SHORTCUTS.renameWindow,
      disabled: false,
      onSelect: () => deps.renameWindow(),
    },
    { kind: "separator", id: "sep-save" },
    {
      kind: "item",
      id: "save-session",
      label: "Save session…",
      disabled: !deps.canSaveSession,
      onSelect: () => deps.saveSession(),
    },
  ];
}

export interface HelpMenuDeps {
  openAbout(): void;
}

/**
 * "About TermX…": the row the Settings menu ends on. Always enabled, never
 * bound to a key, so it prints nothing in the shortcut column.
 */
export function aboutRow(deps: HelpMenuDeps): MenuItemModel {
  return {
    kind: "item",
    id: "about",
    label: "About TermX…",
    disabled: false,
    onSelect: () => deps.openAbout(),
  };
}

/** The chrome toggles the View menu owns, by settings field. */
export type ViewToggleField = "sideRail" | "conversationsRail" | "statusBar";

export interface ViewMenuDeps {
  readonly sideRail: boolean;
  readonly conversationsRail: boolean;
  readonly statusBar: boolean;
  toggle(field: ViewToggleField, next: boolean): void;
}

export function viewMenu(deps: ViewMenuDeps): readonly MenuRow[] {
  const toggleRow = (
    id: string,
    label: string,
    field: ViewToggleField,
    on: boolean,
  ): MenuItemModel => ({
    kind: "item",
    id,
    label,
    state: on,
    disabled: false,
    onSelect: () => deps.toggle(field, !on),
  });
  return [
    toggleRow("side-rail", "Side rail", "sideRail", deps.sideRail),
    // Deliberately unbound in the printed column: Ctrl+Shift+R opens the
    // session PALETTE, which is a different thing from showing the rail, and
    // printing it here would teach a key that does not do what the row does.
    toggleRow(
      "conversations-rail",
      "Conversations rail",
      "conversationsRail",
      deps.conversationsRail,
    ),
    toggleRow("status-bar", "Status bar", "statusBar", deps.statusBar),
  ];
}
