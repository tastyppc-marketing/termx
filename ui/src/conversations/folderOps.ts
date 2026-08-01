/**
 * Pure operations over `ConversationsV1` plus the rail's view helpers.
 *
 * Every mutator returns the same reference for a no-op (the store's snapshot
 * identity — and therefore React's re-render — depends on it) and never
 * mutates its input. Folder membership only ever moves rows around inside
 * TermX: deleting a folder unfiles its sessions and never touches a provider
 * file.
 */

import { splitForDisplay } from "../folders/fuzzyScore";
import {
  sessionKey,
  type ConversationsV1,
  type LlmSessionRecord,
  type SessionKey,
  type SessionNote,
} from "./types";

/** One rendered section of the tree; `id: null` is the Unfiled bucket. */
export interface FolderSection {
  id: string | null;
  name: string;
  records: readonly LlmSessionRecord[];
}

export const UNFILED_NAME = "Unfiled";

export function createFolder(
  data: ConversationsV1,
  name: string,
  id: string,
): ConversationsV1 {
  const trimmed = name.trim();
  if (trimmed.length === 0 || id.length === 0) {
    return data;
  }
  if (data.folders.some((folder) => folder.id === id)) {
    return data;
  }
  return { ...data, folders: [...data.folders, { id, name: trimmed }] };
}

export function renameFolder(
  data: ConversationsV1,
  id: string,
  name: string,
): ConversationsV1 {
  const trimmed = name.trim();
  const current = data.folders.find((folder) => folder.id === id);
  if (!current || trimmed.length === 0 || current.name === trimmed) {
    return data;
  }
  return {
    ...data,
    folders: data.folders.map((folder) =>
      folder.id === id ? { ...folder, name: trimmed } : folder,
    ),
  };
}

/** Removes the folder and unfiles every session that lived in it. */
export function deleteFolder(
  data: ConversationsV1,
  id: string,
): ConversationsV1 {
  if (!data.folders.some((folder) => folder.id === id)) {
    return data;
  }
  const assignments: Record<SessionKey, string> = {};
  for (const [key, folderId] of Object.entries(data.assignments)) {
    if (folderId !== id) {
      assignments[key] = folderId;
    }
  }
  return {
    ...data,
    folders: data.folders.filter((folder) => folder.id !== id),
    assignments,
  };
}

/** `folderId: null` unfiles. An unknown folder id is refused (no-op). */
export function assignSession(
  data: ConversationsV1,
  key: SessionKey,
  folderId: string | null,
): ConversationsV1 {
  if (key.length === 0) {
    return data;
  }
  const current = data.assignments[key] ?? null;
  if (current === folderId) {
    return data;
  }
  if (folderId === null) {
    const assignments = { ...data.assignments };
    delete assignments[key];
    return { ...data, assignments };
  }
  if (!data.folders.some((folder) => folder.id === folderId)) {
    return data;
  }
  return { ...data, assignments: { ...data.assignments, [key]: folderId } };
}

export function folderIdFor(
  data: ConversationsV1,
  key: SessionKey,
): string | null {
  return data.assignments[key] ?? null;
}

/**
 * Case-insensitive substring match over title + cwd + summary + recap (§3).
 * An empty query matches everything.
 */
export function matchesQuery(
  query: string,
  record: LlmSessionRecord,
  note: SessionNote,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  const haystack = [record.title, record.cwd, note.summary, note.recap]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

export function filterRecords(
  records: readonly LlmSessionRecord[],
  options: {
    provider: "all" | LlmSessionRecord["provider"];
    query: string;
    noteFor: (record: LlmSessionRecord) => SessionNote;
  },
): LlmSessionRecord[] {
  return records.filter(
    (record) =>
      (options.provider === "all" || record.provider === options.provider) &&
      matchesQuery(options.query, record, options.noteFor(record)),
  );
}

/** User folders in stored order (empty ones included), then Unfiled last. */
export function groupSessions(
  records: readonly LlmSessionRecord[],
  data: ConversationsV1,
): FolderSection[] {
  const buckets = new Map<string, LlmSessionRecord[]>();
  for (const folder of data.folders) {
    buckets.set(folder.id, []);
  }
  const unfiled: LlmSessionRecord[] = [];
  for (const record of records) {
    const folderId = data.assignments[sessionKey(record)];
    const bucket = folderId ? buckets.get(folderId) : undefined;
    if (bucket) {
      bucket.push(record);
    } else {
      unfiled.push(record);
    }
  }
  return [
    ...data.folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      records: buckets.get(folder.id) ?? [],
    })),
    { id: null, name: UNFILED_NAME, records: unfiled },
  ];
}

/**
 * Leaf-preserving path shortening, like the folder palette: the folder name
 * itself always survives; the parent is elided from the left.
 */
export function shortenCwd(cwd: string | null, max = 34): string {
  if (cwd === null || cwd.length === 0) {
    return "";
  }
  if (cwd.length <= max) {
    return cwd;
  }
  const { parent, leaf } = splitForDisplay(cwd);
  if (parent.length === 0) {
    return leaf;
  }
  const separator = parent.endsWith("/") ? "/" : "\\";
  const segments = parent.slice(0, -1).split(/[\\/]/).filter(Boolean);
  const tail = segments[segments.length - 1];
  const withParent = tail ? `…${separator}${tail}${separator}${leaf}` : "";
  if (withParent.length > 0 && withParent.length <= max) {
    return withParent;
  }
  return `…${separator}${leaf}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact "how long ago" for row timestamps and the footer refresh line. */
export function relativeTime(atMs: number, nowMs: number): string {
  const delta = nowMs - atMs;
  if (!Number.isFinite(delta) || delta < MINUTE) {
    return "just now";
  }
  if (delta < HOUR) {
    return `${Math.floor(delta / MINUTE)}m ago`;
  }
  if (delta < DAY) {
    return `${Math.floor(delta / HOUR)}h ago`;
  }
  if (delta < 30 * DAY) {
    return `${Math.floor(delta / DAY)}d ago`;
  }
  return `${Math.floor(delta / (30 * DAY))}mo ago`;
}
