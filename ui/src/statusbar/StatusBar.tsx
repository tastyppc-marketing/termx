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
import type { UpdateState } from "../updates/types";
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
  model?: { provider: string; model: string | null } | null;
  appVersion?: string;
  onChangeDirectory?: () => void;
  directoryDisabledReason?: string;
  changingDirectory?: boolean;
  update?: UpdateState;
  onCheckUpdates?: () => void;
  onOpenUpdate?: () => void;
}

export function StatusBar({ cwd, profile, sshHost, onOpenCwd, model, appVersion,
  onChangeDirectory, directoryDisabledReason, changingDirectory,
  update, onCheckUpdates, onOpenUpdate }: StatusBarProps) {
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

  const available = update?.kind === "checked" && update.result.status === "available";
  const ready = update?.kind === "ready";
  const busy = update?.kind === "checking" || update?.kind === "downloading" || update?.kind === "installing";
  const updateLabel = update?.kind === "checking" ? "Checking updates…"
    : update?.kind === "error" ? "Updates unavailable"
    : update?.kind === "downloading" ? `Downloading ${update.result.latestVersion}…`
    : update?.kind === "ready" ? `Update ${update.result.latestVersion} ready`
    : update?.kind === "installing" ? "Installing…"
    : update?.kind === "checked" ? update.result.status === "available"
      ? `Update ${update.result.latestVersion}`
      : update.result.status === "no-release" ? "No published release" : "Up to date"
    : "Check updates";
  const updateTitle = update?.kind === "error" ? `${update.message}. Click to retry.`
    : ready ? "Install the update and reopen TermX"
    : available ? "Download the update"
    : update?.kind === "downloading" ? "Downloading the installer"
    : update?.kind === "installing" ? "Installing the update"
    : "Check GitHub for a TermX update";
  return (
    <footer className="status-bar" data-testid="status-bar">
      {cwd !== null && onOpenCwd ? <button
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
      </button> : <span className="status-bar__cwd" title={cwd ?? undefined}>{cwd ?? "—"}</span>}
      {onChangeDirectory ? <button type="button" className="status-bar__action"
        data-testid="status-bar-change-directory"
        title={directoryDisabledReason ?? "Choose a folder for this terminal"}
        disabled={Boolean(directoryDisabledReason) || changingDirectory}
        onClick={onChangeDirectory}>{changingDirectory ? "Opening…" : "Open folder…"}</button> : null}
      {model ? <span className="status-bar__model" data-testid="status-bar-model"
        title={`${model.provider} · ${model.model ?? "Model unavailable"}`}>
        {model.provider} · {model.model ?? "Model unavailable"}
      </span> : null}
      {chips}
      {appVersion ? <span className="status-bar__version" data-testid="status-bar-version">TermX {appVersion}</span> : null}
      {onCheckUpdates || onOpenUpdate ? <button type="button"
        className={`status-bar__action${available || ready ? " status-bar__action--update" : ""}`}
        data-testid="status-bar-update" disabled={busy}
        title={updateTitle}
        onClick={available || ready ? onOpenUpdate : onCheckUpdates}>{updateLabel}</button> : null}
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
