/**
 * Conversations domain types (spec §3/§6).
 *
 * `LlmSessionRecord` is the exact camelCase wire shape of the Rust
 * `list_llm_sessions` command — one discovered Claude/Codex session. Records
 * are transient (rescanned on demand); everything the user owns (folders,
 * assignments, cached notes, cached artifacts) lives in `ConversationsV1`,
 * persisted as `conversations_v1.json`.
 */

import type { LaunchConfiguration } from "./launchConfiguration";

export const LLM_PROVIDERS = ["claude", "codex"] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export interface LlmSessionRecord {
  /** Absent for older sessions; null marks a corrupt captured configuration. */
  launch?: LaunchConfiguration | null;
  provider: LlmProvider;
  id: string;
  title: string;
  /** Absolute directory the session ran in, when it could be determined. */
  cwd: string | null;
  /**
   * Absolute path of the source transcript. **Empty** when the provider index
   * knows a session whose transcript file could not be located (codex does
   * this): still listed and resumable, but nothing to open or summarize.
   */
  filePath: string;
  updatedAtMs: number;
  summary: string | null;
  recap: string | null;
  /**
   * Whether `title` was deliberately given (Claude summary line, Codex index
   * title) or derived (first-message fragment, bare id). Absent — e.g. a
   * fixture or an older host — means `"named"`: a generated title must never
   * displace a title we are not sure is derived (spec P2).
   */
  titleSource?: "named" | "derived";
}

/** `${provider}:${id}` — stable identity across rescans. */
export type SessionKey = string;

export function sessionKey(
  record: Pick<LlmSessionRecord, "provider" | "id">,
): SessionKey {
  return `${record.provider}:${record.id}`;
}

/** A session with no transcript file has nothing to open, read, or summarize. */
export function hasTranscript(record: LlmSessionRecord): boolean {
  return record.filePath.length > 0;
}

export interface ConversationFolder {
  id: string;
  name: string;
  /**
   * Collapsed in the rail (polish spec P7). Absent = expanded; only ever
   * written as `true` so a folder nobody collapsed stays a two-field object.
   */
  collapsed?: boolean;
}

/** One cached LLM-generated note (§6); `sourceMtimeMs` drives staleness. */
export interface GeneratedNote {
  /** Generated session name (polish spec P2). Absent on pre-bundle caches. */
  title?: string | null;
  summary: string | null;
  recap: string | null;
  generatedAtMs: number;
  sourceMtimeMs: number;
}

/** Wire shape of `generate_session_bundle` (polish spec P2). */
export interface BundleNote {
  title: string | null;
  summary: string | null;
  recap: string | null;
}

/** Wire shape of `list_session_outputs` rows (polish spec P4). */
export interface OutputEntry {
  path: string;
  label: string | null;
  atMs: number;
  exists: boolean;
}

export interface SessionArtifactFile {
  path: string;
  kind: "created" | "edited";
  exists: boolean;
}

/** Cached "Files touched" harvest (§11) — written by the artifacts pass. */
export interface SessionArtifacts {
  sourceMtimeMs: number;
  files: SessionArtifactFile[];
}

export interface ConversationsV1 {
  version: 1;
  folders: ConversationFolder[];
  /** session key → folder id. Absent key = Unfiled. */
  assignments: Record<SessionKey, string>;
  generated: Record<SessionKey, GeneratedNote>;
  /** Optional: absent until the artifacts pass caches its first harvest. */
  artifacts?: Record<SessionKey, SessionArtifacts>;
}

/** What a row/detail pane shows: whichever note kinds are available. */
export interface SessionNote {
  summary: string | null;
  recap: string | null;
}

export const EMPTY_NOTE: SessionNote = { summary: null, recap: null };

/** Injected `list_llm_sessions` (all store IO is injected so tests fake it). */
export type SessionLister = (
  force: boolean,
) => Promise<readonly LlmSessionRecord[]>;
