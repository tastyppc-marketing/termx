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
  /** Commit a name, or null to go back to the default. */
  onRename(name: string | null): void;
}

/** Presentational: the label, and the editor it becomes. */
export function WindowName({ name, onRename }: WindowNameProps) {
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
          placeholder={DEFAULT_WINDOW_NAME}
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
      {name ?? DEFAULT_WINDOW_NAME}
    </div>
  );
}

/**
 * Connected: reads this window's name out of the layout, writes renames back
 * through the controller, and keeps the OS window title in step.
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

  useEffect(() => {
    void applyOsWindowTitle(windowTitleFor(name));
  }, [name]);

  return (
    <WindowName
      name={name}
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
