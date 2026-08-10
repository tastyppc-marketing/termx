/**
 * Which transcript a pane is showing (chat-view spec §2).
 *
 * Three ways in, in order of how much we actually know:
 *
 * 1. **Explicit** — the session was started or resumed through TermX, so the
 *    pane already carries its key. Nothing beats this.
 * 2. **By directory** — a session whose recorded cwd is the pane's cwd. When
 *    several match, the one that moved most recently is the live one; when two
 *    are equally recent there is no answer, and guessing would put another
 *    project's conversation on screen.
 * 3. **Nothing** — the pane offers no chat switch at all. An absent switch is
 *    honest; a wrong conversation is not.
 *
 * Pure: candidates come from the conversations store the caller already has.
 */

import {
  hasTranscript,
  sessionKey,
  type LlmSessionRecord,
  type SessionKey,
} from "../conversations/types";

export type LinkageReason = "explicit" | "cwd";

export interface PaneLinkage {
  record: LlmSessionRecord;
  reason: LinkageReason;
}

/** Compare directories the way the resume path does: case- and slash-blind. */
function normalizeDir(path: string): string {
  return path.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

export function resolveLinkage(options: {
  /** The session key a resume tied to this pane, when there is one. */
  explicitKey?: SessionKey | null;
  /** The pane's current working directory. */
  paneCwd?: string | null;
  candidates: readonly LlmSessionRecord[];
}): PaneLinkage | null {
  const usable = options.candidates.filter(hasTranscript);

  if (options.explicitKey) {
    const explicit = usable.find(
      (record) => sessionKey(record) === options.explicitKey,
    );
    if (explicit) {
      return { record: explicit, reason: "explicit" };
    }
  }

  const cwd = options.paneCwd ? normalizeDir(options.paneCwd) : "";
  if (cwd.length === 0) {
    return null;
  }
  const matches = usable.filter(
    (record) => record.cwd !== null && normalizeDir(record.cwd) === cwd,
  );
  if (matches.length === 0) {
    return null;
  }
  if (matches.length === 1) {
    const only = matches[0];
    return only ? { record: only, reason: "cwd" } : null;
  }

  const sorted = [...matches].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  const [newest, runnerUp] = sorted;
  if (!newest || (runnerUp && runnerUp.updatedAtMs === newest.updatedAtMs)) {
    return null; // equally recent: no way to tell them apart
  }
  return { record: newest, reason: "cwd" };
}
