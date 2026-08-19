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

/**
 * The transcript a resume HANDED OFF to (auto-reveal spec §4).
 *
 * `claude --resume <id>` does not append to the transcript it was pointed at:
 * it opens a NEW one in the same project folder. The pane is still showing the
 * old file, so the resumed conversation looks dead. This finds the file that
 * took over.
 *
 * The rules are deliberately narrow, because adopting the wrong file puts a
 * different conversation in the pane: same folder as the record that was
 * resumed, a different id, something to read, and touched AFTER the moment of
 * the resume. Newest wins among several — a second `claude` in that folder is
 * the more recent one either way, and the caller only ever asks about panes it
 * resumed itself.
 */
export function successorRecord(options: {
  /** The record the pane resumed. */
  original: LlmSessionRecord;
  resumedAtMs: number;
  candidates: readonly LlmSessionRecord[];
}): LlmSessionRecord | null {
  const { original, resumedAtMs } = options;
  if (original.cwd === null || original.cwd.trim().length === 0) {
    return null; // no folder to match against: nothing can be proven a successor
  }
  const cwd = normalizeDir(original.cwd);
  const qualified = options.candidates.filter(
    (candidate) =>
      hasTranscript(candidate) &&
      candidate.id !== original.id &&
      candidate.cwd !== null &&
      normalizeDir(candidate.cwd) === cwd &&
      candidate.updatedAtMs > resumedAtMs,
  );
  if (qualified.length === 0) {
    return null;
  }
  return qualified.reduce((newest, candidate) =>
    candidate.updatedAtMs > newest.updatedAtMs ? candidate : newest,
  );
}
