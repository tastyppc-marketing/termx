/**
 * Conversations domain types (spec §3/§6).
 *
 * `LlmSessionRecord` is the exact camelCase wire shape of the Rust
 * `list_llm_sessions` command — one discovered Claude/Codex session. Records
 * are transient (rescanned on demand); everything the user owns (folders,
 * assignments, cached notes, cached artifacts) lives in `ConversationsV1`,
 * persisted as `conversations_v1.json`.
 */

export const LLM_PROVIDERS = ["claude", "codex"] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export interface LlmSessionRecord {
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
}

/** One cached LLM-generated note (§6); `sourceMtimeMs` drives staleness. */
export interface GeneratedNote {
  summary: string | null;
  recap: string | null;
  generatedAtMs: number;
  sourceMtimeMs: number;
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
