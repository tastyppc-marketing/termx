/**
 * Saved sessions data model (saved-sessions spec, batch 1: local).
 *
 * A saved session is a name + optional description over a snapshot of a folder
 * and (optionally) the agent conversation that folder was running, so the pair
 * survives a TermX restart, a daemon kill, or a reboot. Batch 2 added the
 * optional `ssh` block below — purely additive, so no migration was needed.
 */

export type SavedProvider = "claude" | "codex";

/**
 * Which SSH host a save lives on. Only the config alias is stored: `~/.ssh/config`
 * stays the source of truth, so editing HostName or User there moves every
 * saved session with it (ssh-sessions spec §4).
 */
export interface SavedSshRef {
  readonly host: string;
}

export interface SavedConversationRef {
  readonly launch?: import("../conversations/launchConfiguration").LaunchConfiguration | null;
  readonly provider: SavedProvider;
  readonly id: string;    // conversation id, [A-Za-z0-9-]+ (resumeCommand validates)
  readonly title: string; // display fallback
}

export interface SavedSession {
  readonly id: string;                     // uuid, TermX-generated
  readonly name: string;
  readonly description?: string;
  /** Absolute dir — LOCAL for a local save, REMOTE when `ssh` is present. */
  readonly cwd: string;
  readonly conversation?: SavedConversationRef; // absent = bare-shell save (cd only)
  readonly ssh?: SavedSshRef;              // absent = local save
  readonly lastDaemonSessionId?: number;   // for reattach-if-alive
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}
