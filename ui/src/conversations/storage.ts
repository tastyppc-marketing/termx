/**
 * `conversations_v1.json` parse/serialize plus the Tauri IO adapters.
 *
 * Parsing is per-field tolerant (settings/ui-state philosophy): a corrupt or
 * hand-edited file degrades to empty state instead of crashing the rail, and a
 * field we cannot understand is dropped rather than propagated. Dangling
 * assignments (pointing at a folder that no longer exists) are dropped on load
 * so the tree can never show a ghost folder.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  LLM_PROVIDERS,
  type ConversationFolder,
  type ConversationsV1,
  type GeneratedNote,
  type LlmProvider,
  type LlmSessionRecord,
  type SessionArtifactFile,
  type SessionArtifacts,
  type SessionKey,
  type SessionLister,
} from "./types";

/** Already present in the Rust storage allowlist. */
export const CONVERSATIONS_FILE = "conversations_v1.json";

function emptyConversations(): ConversationsV1 {
  return { version: 1, folders: [], assignments: {}, generated: {} };
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function parseFolders(value: unknown): ConversationFolder[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const folders: ConversationFolder[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecordObject(entry)) {
      continue;
    }
    const id = entry.id;
    const name = entry.name;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      typeof name !== "string" ||
      name.trim().length === 0 ||
      seen.has(id)
    ) {
      continue;
    }
    seen.add(id);
    // `collapsed` (P7) is tolerant: only a literal `true` collapses a folder;
    // anything else (missing, "true", 1) leaves it expanded.
    folders.push({
      id,
      name: name.trim(),
      ...(entry.collapsed === true ? { collapsed: true } : {}),
    });
  }
  return folders;
}

function parseAssignments(
  value: unknown,
  folders: readonly ConversationFolder[],
): Record<SessionKey, string> {
  if (!isRecordObject(value)) {
    return {};
  }
  const known = new Set(folders.map((folder) => folder.id));
  const assignments: Record<SessionKey, string> = {};
  for (const [key, folderId] of Object.entries(value)) {
    if (
      key.length > 0 &&
      typeof folderId === "string" &&
      known.has(folderId)
    ) {
      assignments[key] = folderId;
    }
  }
  return assignments;
}

function parseGenerated(value: unknown): Record<SessionKey, GeneratedNote> {
  if (!isRecordObject(value)) {
    return {};
  }
  const generated: Record<SessionKey, GeneratedNote> = {};
  for (const [key, note] of Object.entries(value)) {
    if (key.length === 0 || !isRecordObject(note)) {
      continue;
    }
    generated[key] = {
      title: optionalText(note.title),
      summary: optionalText(note.summary),
      recap: optionalText(note.recap),
      generatedAtMs: finiteNumber(note.generatedAtMs),
      sourceMtimeMs: finiteNumber(note.sourceMtimeMs),
    };
  }
  return generated;
}

function parseArtifactFiles(value: unknown): SessionArtifactFile[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const files: SessionArtifactFile[] = [];
  for (const entry of value) {
    if (!isRecordObject(entry)) {
      continue;
    }
    const path = entry.path;
    if (typeof path !== "string" || path.length === 0) {
      continue;
    }
    files.push({
      path,
      kind: entry.kind === "created" ? "created" : "edited",
      exists: entry.exists !== false,
    });
  }
  return files;
}

/** Absent (not `{}`) when nothing parseable — matches the trayChips pattern. */
function parseArtifacts(
  value: unknown,
): Record<SessionKey, SessionArtifacts> | undefined {
  if (!isRecordObject(value)) {
    return undefined;
  }
  const artifacts: Record<SessionKey, SessionArtifacts> = {};
  let found = false;
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0 || !isRecordObject(entry)) {
      continue;
    }
    artifacts[key] = {
      sourceMtimeMs: finiteNumber(entry.sourceMtimeMs),
      files: parseArtifactFiles(entry.files),
    };
    found = true;
  }
  return found ? artifacts : undefined;
}

/** Parse conversations text (null = missing file). Never throws. */
export function parseConversations(text: string | null): ConversationsV1 {
  if (text === null) {
    return emptyConversations();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyConversations();
  }
  if (!isRecordObject(raw)) {
    return emptyConversations();
  }
  const folders = parseFolders(raw.folders);
  const artifacts = parseArtifacts(raw.artifacts);
  return {
    version: 1,
    folders,
    assignments: parseAssignments(raw.assignments, folders),
    generated: parseGenerated(raw.generated),
    ...(artifacts ? { artifacts } : {}),
  };
}

export function serializeConversations(value: ConversationsV1): string {
  return `${JSON.stringify({ ...value, version: 1 }, null, 2)}\n`;
}

function isProvider(value: unknown): value is LlmProvider {
  return (LLM_PROVIDERS as readonly unknown[]).includes(value);
}

/**
 * Tolerant read of the `list_llm_sessions` payload: a malformed row is skipped
 * rather than poisoning the whole rail (the command itself never errors).
 */
export function parseSessionRecords(value: unknown): LlmSessionRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const records: LlmSessionRecord[] = [];
  for (const entry of value) {
    if (!isRecordObject(entry)) {
      continue;
    }
    const { provider, id } = entry;
    if (!isProvider(provider) || typeof id !== "string" || id.length === 0) {
      continue;
    }
    const title = typeof entry.title === "string" && entry.title.length > 0
      ? entry.title
      : id;
    records.push({
      provider,
      id,
      title,
      cwd: optionalText(entry.cwd),
      filePath: typeof entry.filePath === "string" ? entry.filePath : "",
      updatedAtMs: finiteNumber(entry.updatedAtMs),
      summary: optionalText(entry.summary),
      recap: optionalText(entry.recap),
      titleSource: entry.titleSource === "derived" ? "derived" : "named",
    });
  }
  return records;
}

/** Invokes the Rust command; a host failure degrades to an empty list. */
export const tauriSessionLister: SessionLister = async (force) => {
  try {
    return parseSessionRecords(await invoke<unknown>("list_llm_sessions", { force }));
  } catch {
    return [];
  }
};

/**
 * Structural view of `AppFileStore` — this module names the file, the caller
 * supplies the (Tauri or fake) store.
 */
export interface ConversationsAppFiles {
  read(name: string): Promise<string | null>;
  write(name: string, contents: string): Promise<void>;
}

export interface ConversationsFileIo {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

export function conversationsFileIo(
  files: ConversationsAppFiles,
): ConversationsFileIo {
  return {
    read: () => files.read(CONVERSATIONS_FILE),
    write: (text) => files.write(CONVERSATIONS_FILE, text),
  };
}
