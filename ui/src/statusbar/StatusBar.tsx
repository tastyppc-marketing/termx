/**
 * The bar along the window's bottom edge — the strip that used to be dead
 * space under the last terminal row. It answers the one question a glance
 * should: WHERE is the focused pane standing, as a full path, never
 * abbreviated. Chips on the right say what the pane is (profile, and the ssh
 * host when the pane is a tracked remote one).
 *
 * Purely presentational: everything it shows arrives as props, so it rerenders
 * with the workspace snapshot and holds no state of its own.
 */

import "./StatusBar.css";

export interface StatusBarProps {
  /** Full working directory of the focused pane, or null when unknown. */
  cwd: string | null;
  /** Profile of the focused pane's session ("powershell", "cmd"). */
  profile: string | null;
  /** SSH host alias when the focused pane is a tracked remote pane. */
  sshHost: string | null;
}

export function StatusBar({ cwd, profile, sshHost }: StatusBarProps) {
  return (
    <footer className="status-bar" data-testid="status-bar">
      <span className="status-bar__cwd" title={cwd ?? undefined}>
        {cwd ?? "—"}
      </span>
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
    </footer>
  );
}
