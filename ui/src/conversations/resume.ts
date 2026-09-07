/**
 * Resume-command construction and target validation (spec §5).
 *
 * Bare legacy resumes use a fixed provider verb and validated id. Captured
 * options travel as bounded structured data to the native launcher, never as
 * shell source. Remote values are Bash-quoted individually. Display metadata
 * (titles, summaries, transcript paths) never contributes command text.
 */

import { tauriListDirs, type ListDirs } from "../native/folders";
import type { SavedConversationRef } from "../saved/types";
import { encodeLaunch, parseLaunchConfiguration, resumeArguments, type LaunchConfiguration } from "./launchConfiguration";

/** Spec §5: ids are uuids; anything else is refused. */
export const RESUME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Spec §5 step 3: give the shell 15 s to report its first prompt. */
export const RESUME_PROMPT_TIMEOUT_MS = 15_000;

/** Spec §5: with shell integration OFF there is no prompt signal to wait for. */
export const RESUME_FIXED_DELAY_MS = 1_500;

/**
 * The fixed verb per provider. A `switch` (not a lookup object) so that
 * `provider: "constructor"` and friends resolve to null instead of an
 * inherited Object.prototype member.
 */
function resumeVerb(provider: string): string | null {
  switch (provider) {
    case "claude":
      return "claude --resume";
    case "codex":
      return "codex resume";
    default:
      return null;
  }
}

/** True when `id` is safe to place on a command line verbatim. */
export function isResumableSessionId(id: string): boolean {
  return RESUME_ID_PATTERN.test(id);
}

/**
 * The exact command to type, or null for an unknown provider, invalid id or
 * unusable captured settings. Callers must refuse the whole resume on null.
 */
export function resumeCommand(record: {
  provider: string;
  id: string;
  launch?: LaunchConfiguration | null;
}, shell = "powershell"): string | null {
  const verb = resumeVerb(record.provider);
  if (verb === null || !isResumableSessionId(record.id)) {
    return null;
  }
  if (record.launch !== undefined) {
    const launch = parseLaunchConfiguration(record.launch, record.provider);
    if (launch === null) return null;
    const args = resumeArguments(launch, record.id);
    if (args === null) return null;
    const token = encodeLaunch({ ...launch, args });
    // cmd has an 8191-character input limit. Refuse instead of truncating.
    if (token.length > (shell === "cmd" ? 7_500 : 28_000)) return null;
    if (shell === "cmd") return `"%TERMX_HOST_EXE%" --agent-json ${token}`;
    if (shell === "powershell") return `& $env:TERMX_HOST_EXE --agent-json ${token}`;
    return null;
  }
  return `${verb} ${record.id}`;
}

/**
 * The command to type into a tracked REMOTE shell to resume a saved
 * conversation (ssh-sessions spec §5), or null when there is nothing to type.
 *
 * Null means two different things to the caller, and only the caller can tell
 * them apart: NO conversation is a bare-shell save (the remote shell in the
 * saved folder is all that was pinned — type nothing, resume succeeds), while a
 * conversation whose id fails validation is a corrupt record and must refuse
 * the whole resume. There is no `--continue` fallback: the model carries no
 * provider hint without a conversation, so "no conversation" can only ever mean
 * a bare shell.
 *
 * The verbs are identical to the local ones on purpose — the agent CLIs are the
 * same programs over there — but the remote path gets its own function because
 * its input is a saved record with a title, and because remote verbs are free
 * to diverge later without touching the local resume.
 */
export function remoteResumeCommand(
  conversation: SavedConversationRef | undefined,
): string | null {
  if (conversation === undefined) {
    return null;
  }
  if (conversation.launch !== undefined) {
    if (!isResumableSessionId(conversation.id)) return null;
    const launch = parseLaunchConfiguration(conversation.launch, conversation.provider);
    if (launch === null) return null;
    const args = resumeArguments(launch, conversation.id);
    if (args === null || [launch.cwd, ...args].some(value => /[\x00-\x1f\x7f]/.test(value))) return null;
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    return `cd -- ${quote(launch.cwd)} && ${launch.provider} ${args.map(quote).join(" ")}`;
  }
  return resumeCommand(conversation);
}

/** Injected directory probe — tests fake it; production uses `list_dirs`. */
export type DirExists = (path: string) => Promise<boolean>;

function normalizeDir(path: string): string {
  return path.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/**
 * Directory existence on top of the folder searcher's `list_dirs` command —
 * the only path-probing surface the renderer has, and one that never errors.
 *
 * Two signals, because completion semantics answer the question sideways:
 * 1. `list_dirs(path)` completes the LEAF against its parent, so an existing
 *    directory appears in its own completion list.
 * 2. If that misses, `list_dirs(path\)` lists the directory's children; a
 *    non-empty answer proves the directory is readable. (Only a signal, never
 *    a disproof: an empty or subdirectory-less folder answers nothing.)
 *
 * Known miss: `list_dirs` hides dot-prefixed names, so a directory whose LEAF
 * starts with "." and which has no visible subdirectories reads as absent —
 * the failure mode is a refusal notice, never a wrong directory.
 */
export function dirExistsVia(listDirs: ListDirs): DirExists {
  return async (path) => {
    const target = normalizeDir(path);
    if (target.length === 0) {
      return false;
    }
    try {
      const siblings = await listDirs(path);
      if (siblings.some((entry) => normalizeDir(entry) === target)) {
        return true;
      }
      const asParent = /[\\/]$/.test(path) ? path : `${path}\\`;
      const children = await listDirs(asParent);
      return children.length > 0;
    } catch {
      return false;
    }
  };
}

export const tauriDirExists: DirExists = dirExistsVia(tauriListDirs);
