/**
 * Pure helpers for the "Files touched" artifacts harvest (spec §11): cache
 * staleness, created/edited grouping, and Windows-correct parent-directory
 * derivation for the "Open folder in new tab" context-menu action.
 *
 * No React, no IO here — `DetailPane` owns the fetch lifecycle (lazy on first
 * expand, cached in the store) and calls into these.
 */

import type { LlmSessionRecord, SessionArtifactFile, SessionArtifacts } from "./types";

/**
 * Injected `list_session_artifacts(file_path)`. Wire shape is the camelCase
 * `{ path, kind, exists }[]` the Rust command returns; it never errors
 * (unreadable transcript -> empty array), so this never rejects either.
 */
export type ArtifactLister = (filePath: string) => Promise<SessionArtifactFile[]>;

/**
 * True when there is no cached harvest yet, or the transcript has moved
 * (`record.updatedAtMs`) since the cache was built — the only two conditions
 * under which an expand should re-fetch.
 */
export function needsFetch(
  cached: SessionArtifacts | undefined,
  record: Pick<LlmSessionRecord, "updatedAtMs">,
): boolean {
  return cached === undefined || cached.sourceMtimeMs < record.updatedAtMs;
}

export interface GroupedArtifacts {
  created: SessionArtifactFile[];
  edited: SessionArtifactFile[];
}

/** Partition a harvest into created/edited groups, preserving harvest order within each. */
export function groupArtifacts(files: readonly SessionArtifactFile[]): GroupedArtifacts {
  const created: SessionArtifactFile[] = [];
  const edited: SessionArtifactFile[] = [];
  for (const file of files) {
    (file.kind === "created" ? created : edited).push(file);
  }
  return { created, edited };
}

/**
 * Windows-correct parent directory of a file path, for "Open folder in new
 * tab". Handles both backslash and forward-slash paths, and drive roots:
 * `C:\a\b.md` -> `C:\a`, but `C:\b.md` -> `C:\` (not the bare, meaningless
 * `C:`, which Windows treats as "current directory on drive C", not the
 * root). A path with no separator has no derivable parent and is returned
 * unchanged.
 */
export function parentDirOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (cut < 0) {
    return path;
  }
  const separator = path[cut];
  const parent = path.slice(0, cut);
  return /^[A-Za-z]:$/.test(parent) ? parent + separator : parent;
}
