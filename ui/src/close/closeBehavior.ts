/**
 * Pure decision logic for what happens when the TermX window is asked to
 * close (spec §15). No alive sessions -> close silently no matter what the
 * setting says (there is nothing to keep running or stop). Otherwise the
 * user's `onWindowClose` setting decides: `ask` means show the CloseGuard
 * dialog and let the user pick; `keep-running` / `stop-all` apply straight
 * away without a dialog.
 */

import type { TermxSettings } from "../settings/settings";

/** What actually happens to running sessions when the window closes. */
export type CloseDecision = "keep-running" | "stop-all";

/**
 * Decide what should happen when the window close is requested.
 *
 * - No alive session -> "silent" (close immediately, nothing to decide).
 * - Otherwise mirrors the `onWindowClose` setting: "ask" surfaces the
 *   CloseGuard dialog; "keep-running" / "stop-all" apply directly.
 */
export function decideOnClose(
  setting: TermxSettings["onWindowClose"],
  anyAlive: boolean,
): CloseDecision | "ask" | "silent" {
  if (!anyAlive) {
    return "silent";
  }
  return setting;
}
