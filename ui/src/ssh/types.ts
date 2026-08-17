/**
 * SSH host inventory model (ssh-sessions spec §1).
 *
 * A host is one `Host` block of `~/.ssh/config`, which stays the single source
 * of truth: TermX reads it, never writes it, and stores nothing but the alias
 * anywhere else (a saved session references `alias`, so editing the config
 * moves the saved session with it).
 */

export interface SshHost {
  /** Primary alias — the first non-wildcard token on the `Host` line. */
  readonly alias: string;
  /** Every non-wildcard token on that line, primary first. */
  readonly aliases: readonly string[];
  /** `HostName` value, when the block sets one. */
  readonly hostName: string | null;
  readonly user: string | null;
  /** Kept verbatim, `~` and all: it is only ever displayed, never resolved. */
  readonly identityFile: string | null;
}
