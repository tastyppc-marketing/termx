/**
 * The label over each window's top-left corner.
 *
 * Every OS window used to say "Terminal workspace" — true, and useless once
 * there are three of them on screen. Named, it becomes what the window IS:
 * a heading over the two or three panes inside it. Double-click to name it,
 * exactly as a sidebar group is renamed.
 *
 * What it deliberately does NOT do is touch the rail tab. A window name is a
 * group label; a rail tab names one terminal. Tying them together would spend
 * the tab's identity every time the group is labelled, so the sync is a
 * setting and the setting is off.
 */

import { useEffect, useMemo, useState } from "react";
import { InlineRename } from "../sidebar/InlineRename";
import { SettingsStore } from "../settings/SettingsStore";
import { useSettings } from "../settings/useSettings";
import { MAX_NAME_LENGTH, windowNameOf } from "../state/layout";
import type { BootstrappedWorkspace } from "./bootstrapWorkspace";
import type { WorkspaceSnapshot } from "./WorkspaceController";
import { useWorkspace } from "./useWorkspace";

/** What an unnamed window calls itself — what every window used to say. */
export const DEFAULT_WINDOW_NAME = "Terminal workspace";

/** The OS window title. Unnamed windows stay plain "TermX". */
export function windowTitleFor(name: string | null): string {
  return name === null ? "TermX" : `${name} — TermX`;
}

export interface WindowNameProps {
  /** null until this window has been named. */
  name: string | null;
  /**
   * What an UNNAMED window reads as, and the editor's placeholder: the active
   * tab's rail title, or `DEFAULT_WINDOW_NAME` when there is no tab to follow.
   * Optional so a caller with nothing better to say still gets the old label;
   * the header passes the followed title, and a test pins that it does.
   */
  fallback?: string;
  /** Commit a name, or null to go back to the default. */
  onRename(name: string | null): void;
}

/** Presentational: the label, and the editor it becomes. */
export function WindowName({
  name,
  fallback = DEFAULT_WINDOW_NAME,
  onRename,
}: WindowNameProps) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      // Esc belongs to the editor while it is open — the same claim the
      // settings surface honours before treating Esc as "close me".
      <div className="app-subtitle app-subtitle--editing" data-esc-guard="">
        <InlineRename
          value={name ?? ""}
          ariaLabel="Name this window"
          // Blank is a real answer here: it means "go back to the default".
          allowEmpty
          maxLength={MAX_NAME_LENGTH}
          // What the label reads right now, so opening the editor on an
          // unnamed window shows what it is currently following. The VALUE
          // stays empty: typing starts fresh, and Escape leaves it following.
          placeholder={fallback}
          onCommit={(value) => {
            setEditing(false);
            onRename(value.length === 0 ? null : value);
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div
      className="app-subtitle app-subtitle--nameable"
      data-testid="window-name"
      title="Double-click to name this window"
      // Reachable without a mouse, by the same F2 the sidebar renames with.
      tabIndex={0}
      onDoubleClick={() => setEditing(true)}
      onKeyDown={(event) => {
        if (event.key === "F2") {
          event.preventDefault();
          setEditing(true);
        }
      }}
    >
      {name ?? fallback}
    </div>
  );
}

/**
 * The rail title of the tab this window is showing, or null when it has none.
 *
 * REUSED, never re-derived: the controller already resolved `tab.title` from
 * the explicit rename, then the pane name, then the folder-derived fallback
 * when it projected the rail row. Deriving it a second time here would let the
 * header and the rail row beside it disagree. Groups are searched as well as
 * the root, because `groups` carries every group in this window and each one
 * holds its own tabs.
 */
export function activeTabTitle(snapshot: WorkspaceSnapshot): string | null {
  const activeTabId = snapshot.activeTabId;
  if (activeTabId === null) {
    return null;
  }
  for (const tab of snapshot.ungroupedTabs) {
    if (tab.id === activeTabId) {
      return tab.title;
    }
  }
  for (const group of snapshot.groups) {
    for (const tab of group.tabs) {
      if (tab.id === activeTabId) {
        return tab.title;
      }
    }
  }
  return null;
}

/**
 * Connected: reads this window's name out of the layout, writes renames back
 * through the controller, and keeps the OS window title in step.
 *
 * An unnamed window FOLLOWS its active tab. "Terminal workspace" over every
 * window is true and useless, and the rail is hard to read at a glance; the
 * tab you are on is the one thing an unnamed window can honestly call itself.
 * A name the user typed always wins, and clearing it returns to following.
 */
export function WindowNameHeader({ workspace }: { workspace: BootstrappedWorkspace }) {
  const controller = workspace.controller;
  const snapshot = useWorkspace(controller);
  // Legacy fixtures omit the settings store, exactly as ReadyWorkspace notes;
  // in a real workspace this resolves to the same store the surface edits.
  const settingsStore = useMemo(
    () => workspace.settings ?? new SettingsStore(),
    [workspace],
  );
  const settings = useSettings(settingsStore);
  const windowId = controller.windowId;
  const name = windowNameOf(snapshot.layout, windowId);
  const followed = activeTabTitle(snapshot);

  useEffect(() => {
    // `windowTitleFor` still decides what null means, so a window with no name
    // AND no tab keeps the plain "TermX" it has always had.
    void applyOsWindowTitle(windowTitleFor(name ?? followed));
  }, [name, followed]);

  return (
    <WindowName
      name={name}
      fallback={followed ?? DEFAULT_WINDOW_NAME}
      // Off by default, and that IS the feature: the window becomes a group
      // label while the rail tab keeps naming its own terminal. The flag is
      // handed to the controller rather than spent on a second call here so
      // both writes land as one structural mutation — an aux window's rename
      // then crosses the bus once, with no half-synced layout in between.
      onRename={(next) =>
        controller.renameWindow(windowId, next, settings.syncWindowRenameToTab)
      }
    />
  );
}

/**
 * Best-effort OS window title. Outside Tauri — a browser dev server, a test —
 * there is no OS window to title, and a window's caption is never worth an
 * error path, so every failure is simply the title staying as it was.
 */
async function applyOsWindowTitle(title: string): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(title);
  } catch {
    // No window to name.
  }
}
