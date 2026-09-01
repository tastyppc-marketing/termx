/**
 * The bar along the window's bottom edge — the strip that used to be dead
 * space under the last terminal row. It answers the one question a glance
 * should: WHERE is the focused pane standing, as a full path, never
 * abbreviated. Chips on the right say what the pane is (profile, and the ssh
 * host when the pane is a tracked remote one).
 *
 * The path is also the shortest route to that folder in the file manager, so
 * it becomes a button when a caller supplies `onOpenCwd`. Purely
 * presentational either way: what to do with the path is the mount site's
 * business, and the bar keeps no state of its own.
 */

import { useRef } from "react";
import "./StatusBar.css";

export interface StatusBarProps {
  /** Full working directory of the focused pane, or null when unknown. */
  cwd: string | null;
  /** Profile of the focused pane's session ("powershell", "cmd"). */
  profile: string | null;
  /** SSH host alias when the focused pane is a tracked remote pane. */
  sshHost: string | null;
  /**
   * Reveal `cwd` in the OS file manager. Omit it (or leave `cwd` null) and the
   * path stays an inert span — the bar never invents an affordance it cannot
   * honour.
   */
  onOpenCwd?: (cwd: string) => void;
}

export function StatusBar({ cwd, profile, sshHost, onOpenCwd }: StatusBarProps) {
  const pathRef = useRef<HTMLButtonElement | null>(null);

  const chips = (
    <span className="status-bar__chips">
      {sshHost ? (
        <span className="status-bar__chip" data-testid="status-bar-ssh">
          ssh · {sshHost}
        </span>
      ) : null}
      {profile ? (
        <span className="status-bar__chip" data-testid="status-bar-profile">
          {profile}
        </span>
      ) : null}
    </span>
  );

  if (cwd === null || !onOpenCwd) {
    return (
      <footer className="status-bar" data-testid="status-bar">
        <span className="status-bar__cwd" title={cwd ?? undefined}>
          {cwd ?? "—"}
        </span>
        {chips}
      </footer>
    );
  }

  return (
    <footer className="status-bar" data-testid="status-bar">
      <button
        ref={pathRef}
        type="button"
        className="status-bar__cwd status-bar__cwd--action"
        data-testid="status-bar-open-cwd"
        title={cwd}
        onClick={() => {
          if (!selectingPath(pathRef.current)) {
            onOpenCwd(cwd);
          }
        }}
      >
        {cwd}
      </button>
      {chips}
    </footer>
  );
}

/**
 * The path stays selectable so it can be copied straight off the bar, and a
 * drag-select ends in a click on the button. Swallow that one click — but only
 * when the selection is inside the path itself, or a stray selection anywhere
 * else on screen would leave the button permanently dead.
 */
function selectingPath(path: HTMLElement | null): boolean {
  if (!path) {
    return false;
  }
  const selection = window.getSelection?.();
  const anchor = selection?.anchorNode ?? null;
  return (
    selection !== null &&
    selection !== undefined &&
    selection.toString().length > 0 &&
    anchor !== null &&
    path.contains(anchor)
  );
}
