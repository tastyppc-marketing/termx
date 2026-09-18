/**
 * Whether the running daemon has to be restarted to finish an update. Pure:
 * the UI version comes from Tauri, the daemon version from `AuthOk`, and
 * `hostChanged` from the persisted `updates.pendingHostRestart` flag that the
 * installer path leaves behind.
 *
 * An unknown UI version (still loading) or an unconnected daemon is never a
 * reason to restart anything.
 */
export function needsHostRestart(input: {
  uiVersion: string;
  hostVersion: string | null;
  hostChanged: boolean;
}): boolean {
  return (
    input.hostChanged &&
    input.uiVersion !== "" &&
    input.hostVersion !== null &&
    input.hostVersion !== input.uiVersion
  );
}
