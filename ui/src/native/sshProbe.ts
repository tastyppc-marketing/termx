/**
 * One-shot remote lookups over ssh (ssh-sessions spec §3).
 *
 * Live rename streaming was deliberately not built. Instead the title of a
 * remote conversation is read FRESH at the one moment it is shown — pin time —
 * by running a tiny read-only command on the host. That keeps TermX from
 * holding a stale copy of something the user renamed remotely, and it doubles
 * as the host's health check.
 *
 * Every failure degrades to `null`: an offline host, a missing transcript, a
 * refused key, a wedged network. The save dialog then shows the conversation id
 * instead of a title and the save still works — a probe must never be able to
 * block a pin.
 *
 * SECURITY. The only value interpolated into the remote command is the
 * conversation id, and only after it matches the same bare-token rule the
 * resume command enforces. Nothing else about a remote transcript — its path,
 * its contents, its title — is ever placed on a command line.
 */

import { invoke } from "@tauri-apps/api/core";

/** Ids are bare tokens; anything else never reaches a shell (spec §3, §5). */
const PROBE_ID_PATTERN = /^[A-Za-z0-9-]+$/;

/** Control characters in remote output are never part of a title. */
/** SGR/CSI sequences, so a colored line cannot leave `[31m` in a title. */
const ANSI_SEQUENCES = /\u001b\[[0-9;?]*[a-zA-Z]/g;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** A title is a label, not a document: long output is a wrong answer. */
const TITLE_MAX_CHARS = 200;

/** Short by design: the dialog is already open and waiting for nothing. */
export const REMOTE_TITLE_TIMEOUT_MS = 6_000;

/** The probe seam — tests fake it; production is `tauriSshProbe`. */
export type SshProbe = (
  alias: string,
  command: string,
  timeoutMs: number,
) => Promise<string | null>;

/** Run one command on a host and return its stdout, or null on any failure. */
export async function tauriSshProbe(
  alias: string,
  command: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const value = await invoke<unknown>("ssh_probe", {
      alias,
      command,
      timeoutMs,
    });
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The remote command that reads a claude conversation's current title out of
 * its transcript: find the session file anywhere under the projects store (the
 * directory is derived from a munged cwd we do not have to reproduce), then
 * take the LAST `"summary"` value in it — the newest one, which is what a
 * remote `/rename` writes. Null for an id that must not reach a shell.
 */
export function remoteTitleCommand(id: string): string | null {
  if (!PROBE_ID_PATTERN.test(id)) {
    return null;
  }
  return [
    `f=$(find "$HOME/.claude/projects" -name '${id}.jsonl' 2>/dev/null | head -1)`,
    `[ -n "$f" ] && grep -o '"summary":"[^"]*"' "$f" | tail -1 | cut -d'"' -f4`,
  ].join("; ");
}

/**
 * Shape whatever the far end printed into a title, or null when there is
 * nothing usable in it. The last non-empty line wins (a login banner or a
 * warning can precede the answer), control characters are dropped, and the
 * result is capped — this string is remote data on its way into the UI.
 */
export function shapeRemoteTitle(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const lines = raw
    .split(/\r?\n/)
    .map((line) =>
      line.replace(ANSI_SEQUENCES, "").replace(CONTROL_CHARACTERS, "").trim(),
    )
    .filter((line) => line.length > 0);
  const title = lines[lines.length - 1];
  if (title === undefined) {
    return null;
  }
  return title.slice(0, TITLE_MAX_CHARS);
}

/**
 * The current title of a remote conversation, or null when it cannot be read.
 *
 * Codex returns null in v1: its titles live in a local index rather than in the
 * session file, so there is nothing on the remote host to read — the id stays
 * the display fallback, exactly as it does for a probe that fails.
 */
export async function probeRemoteTitle(
  alias: string,
  provider: "claude" | "codex",
  id: string,
  probe: SshProbe = tauriSshProbe,
): Promise<string | null> {
  if (provider !== "claude") {
    return null;
  }
  const command = remoteTitleCommand(id);
  if (command === null) {
    return null;
  }
  return shapeRemoteTitle(await probe(alias, command, REMOTE_TITLE_TIMEOUT_MS));
}
