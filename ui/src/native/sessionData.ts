/**
 * Invoke wrappers for the conversations data commands (spec §6, §11, §12
 * viewer file reads). Every command never-errors by contract; the wrappers
 * are equally tolerant so a failed IPC round-trip degrades to "nothing to
 * show", never an exception inside a render.
 */

import { invoke } from "@tauri-apps/api/core";
import type { ArtifactLister } from "../conversations/artifacts";
import type {
  BundleNote,
  OutputEntry,
  SessionArtifactFile,
} from "../conversations/types";
import type { NoteKind } from "../conversations/noteScheduler";
import type { FileReadResult } from "../viewer/ViewerHost";

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** `read_text_file` (viewer §10): null when unreadable, too large, or binary. */
export async function tauriReadTextFile(path: string): Promise<FileReadResult | null> {
  try {
    const value = await invoke<unknown>("read_text_file", { path });
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as { content?: unknown }).content !== "string" ||
      typeof (value as { truncated?: unknown }).truncated !== "boolean"
    ) {
      return null;
    }
    const result = value as { content: string; truncated: boolean };
    return { content: result.content, truncated: result.truncated };
  } catch {
    return null;
  }
}

/** `list_session_artifacts` (§11): unreadable transcript -> empty list. */
export const tauriListArtifacts: ArtifactLister = async (filePath) => {
  try {
    const value = await invoke<unknown>("list_session_artifacts", { filePath });
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter(
      (entry): entry is SessionArtifactFile =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { path?: unknown }).path === "string" &&
        ((entry as { kind?: unknown }).kind === "created" ||
          (entry as { kind?: unknown }).kind === "edited") &&
        typeof (entry as { exists?: unknown }).exists === "boolean",
    );
  } catch {
    return [];
  }
};

/** `generate_session_note` (§6): null = generation failed or refused. */
export async function tauriGenerateNote(
  filePath: string,
  kind: NoteKind,
): Promise<string | null> {
  try {
    const value = await invoke<unknown>("generate_session_note", { filePath, kind });
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * `generate_session_bundle` (polish P2): title + description + recap from one
 * Haiku call. Null when generation failed, was refused, or yielded nothing.
 */
export async function tauriGenerateBundle(
  filePath: string,
): Promise<BundleNote | null> {
  try {
    const value = await invoke<unknown>("generate_session_bundle", { filePath });
    if (typeof value !== "object" || value === null) {
      return null;
    }
    const raw = value as Record<string, unknown>;
    const bundle: BundleNote = {
      title: optionalText(raw.title),
      summary: optionalText(raw.summary),
      recap: optionalText(raw.recap),
    };
    return bundle.title !== null || bundle.summary !== null || bundle.recap !== null
      ? bundle
      : null;
  } catch {
    return null;
  }
}

export type OutputLister = (sessionKey: string) => Promise<OutputEntry[]>;

/** `list_session_outputs` (polish P4): newest first, tombstones applied. */
export const tauriListOutputs: OutputLister = async (sessionKey) => {
  try {
    const value = await invoke<unknown>("list_session_outputs", { sessionKey });
    if (!Array.isArray(value)) {
      return [];
    }
    const entries: OutputEntry[] = [];
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const raw = entry as Record<string, unknown>;
      if (typeof raw.path !== "string" || raw.path.length === 0) {
        continue;
      }
      entries.push({
        path: raw.path,
        label: optionalText(raw.label),
        atMs: typeof raw.atMs === "number" && Number.isFinite(raw.atMs) ? raw.atMs : 0,
        exists: raw.exists !== false,
      });
    }
    return entries;
  } catch {
    return [];
  }
};

/** `dismiss_session_output` (polish P4): false = nothing dismissed. */
export async function tauriDismissOutput(
  sessionKey: string,
  path: string,
): Promise<boolean> {
  try {
    return (await invoke<unknown>("dismiss_session_output", { sessionKey, path })) === true;
  } catch {
    return false;
  }
}
