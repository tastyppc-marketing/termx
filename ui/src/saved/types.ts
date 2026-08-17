/**
 * Saved sessions data model (saved-sessions spec, batch 1: local).
 *
 * A saved session is a name + optional description over a snapshot of a folder
 * and (optionally) the agent conversation that folder was running, so the pair
 * survives a TermX restart, a daemon kill, or a reboot. Batch 2 adds an
 * optional `ssh` block here — the shape below is deliberately SSH-ready, so
 * that arrives without a migration.
 */

export type SavedProvider = "claude" | "codex";

export interface SavedConversationRef {
  readonly provider: SavedProvider;
  readonly id: string;    // conversation id, [A-Za-z0-9-]+ (resumeCommand validates)
  readonly title: string; // display fallback
}

export interface SavedSession {
  readonly id: string;                     // uuid, TermX-generated
  readonly name: string;
  readonly description?: string;
  readonly cwd: string;                    // absolute local dir
  readonly conversation?: SavedConversationRef; // absent = bare-shell save (cd only)
  readonly lastDaemonSessionId?: number;   // for reattach-if-alive
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}
