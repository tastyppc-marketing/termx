/**
 * The first-run welcome shows exactly once per machine: when the settings
 * file did not exist at startup (a fresh install, not an upgrade), nothing is
 * already running (a reattached workspace is not a first run), and no
 * workspace root has been chosen yet. Skip persists the settings file, so the
 * predicate is false on every later launch without any extra "seen" flag.
 */
export function shouldShowWelcome(input: {
  settingsWasCreated: boolean;
  liveSessionCount: number;
  workspaceRoot: string | null;
}): boolean {
  return (
    input.settingsWasCreated &&
    input.liveSessionCount === 0 &&
    input.workspaceRoot === null
  );
}
