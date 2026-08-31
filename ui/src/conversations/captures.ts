/**
 * Local conversation captures — the exact conversation a TermX pane ran.
 *
 * WHY this file exists: "Resume conversation" on a dead LOCAL pane used to be
 * chosen by `latestForCwd(pane.cwd)` — the NEWEST conversation recorded in the
 * pane's folder. That guesses, and it guesses wrong exactly when it matters:
 * three panes in one repo all resume the same conversation, and a corpse whose
 * cwd was never recorded gets no resume at all. Exact per-pane pairing already
 * existed for SSH panes (the remote bootstrap emits OSC 9;78); nothing emitted
 * it on Windows. `tools/claude-hooks/termx-capture.py` now records the pairing
 * at the source: a Claude Code SessionStart hook appends one JSON line naming
 * the conversation and the `TERMX_SESSION_ID` it started under.
 *
 * The file is JSONL and append-only. The hook is a separate process that can
 * die mid-write, and the file is plain text a user may edit, so parsing is
 * per-line tolerant in the same spirit as `conversations_v1.json`: one torn or
 * hostile line is dropped, never the whole file. Ids are validated against the
 * same `RESUME_ID_PATTERN` the resume command enforces, because the id ends up
 * on a command line — a capture that would not be resumable is not a capture.
 */

import { RESUME_ID_PATTERN } from "./resume";
import { LLM_PROVIDERS, type LlmProvider, type LlmSessionRecord } from "./types";

/** Already in the Rust storage allowlist (src-tauri/src/storage.rs). */
export const CAPTURES_FILE = "conversation_captures_v1.jsonl";

/** One `<TermX pane, conversation>` pairing, as written by the hook. */
export interface ConversationCapture {
  /** The `TERMX_SESSION_ID` the agent CLI started under. */
  termxSessionId: number;
  provider: LlmProvider;
  id: string;
  /** The folder the agent CLI started in; null when the hook had none. */
  cwd: string | null;
  atMs: number;
}

/** Placeholder title for a capture the conversations index has not seen yet. */
const CAPTURED_TITLE = "Captured conversation";

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProvider(value: unknown): value is LlmProvider {
  return (LLM_PROVIDERS as readonly unknown[]).includes(value);
}

/** Host session ids are u32s; anything else cannot name a pane. */
function isSessionId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * One line → one capture, or null when the line cannot be trusted. A missing
 * or unusable `atMs` degrades to 0 rather than dropping the line: an undated
 * capture still resumes the right conversation, it just loses every tie.
 */
function parseCaptureLine(text: string): ConversationCapture | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecordObject(raw)) {
    return null;
  }
  // A future format carries meanings this build does not know; skip it rather
  // than reading v2 fields as v1 ones. Absent = the original v1 shape.
  if (raw.v !== undefined && raw.v !== 1) {
    return null;
  }
  const { termxSessionId, provider, id } = raw;
  if (!isSessionId(termxSessionId) || !isProvider(provider)) {
    return null;
  }
  if (typeof id !== "string" || !RESUME_ID_PATTERN.test(id)) {
    return null;
  }
  return {
    termxSessionId,
    provider,
    id,
    cwd: typeof raw.cwd === "string" && raw.cwd.length > 0 ? raw.cwd : null,
    atMs:
      typeof raw.atMs === "number" && Number.isFinite(raw.atMs) && raw.atMs >= 0
        ? raw.atMs
        : 0,
  };
}

/**
 * Parse the whole capture log (null = missing file). Never throws. The newest
 * capture per TermX session id wins — the file is append-only and a pane that
 * ran `claude` three times has three lines; a tie goes to the later line,
 * which is the later run.
 */
export function parseCaptures(text: string | null): Map<number, ConversationCapture> {
  const captures = new Map<number, ConversationCapture>();
  if (text === null) {
    return captures;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const capture = parseCaptureLine(trimmed);
    if (capture === null) {
      continue;
    }
    const previous = captures.get(capture.termxSessionId);
    if (previous === undefined || capture.atMs >= previous.atMs) {
      captures.set(capture.termxSessionId, capture);
    }
  }
  return captures;
}

/**
 * Past this the boot read starts costing visible milliseconds, and the file is
 * re-read on every session exit. A capture line is ~130 ASCII bytes, so this is
 * roughly four thousand `claude` starts — years of normal use, or one runaway
 * script. Below it the log is cheaper to keep whole than to rewrite.
 */
const COMPACT_THRESHOLD_BYTES = 512 * 1024;

/**
 * Bound the append-only log: keep the newest line per TermX pane, drop the
 * rest. Returns the JSONL to write back, or null when there is nothing worth
 * writing — the log is small enough, or it is already compact. Null is the
 * common answer and means DO NOT WRITE: rewriting a file the hook may be
 * appending to at that instant is a race worth losing only when it buys
 * something.
 *
 * The winning line is carried across VERBATIM rather than re-serialized. A
 * capture this build understands must survive a round trip byte-for-byte, and
 * re-encoding would quietly rewrite anything `parseCaptureLine` normalized.
 *
 * Lines this build cannot parse are dropped, INCLUDING a future `v` it does not
 * know. That is the deliberate trade: an old build compacting a newer build's
 * log loses captures it was already ignoring, and the alternative — carrying
 * unreadable lines forever — is the unbounded growth this exists to stop.
 *
 * `keep`, when given, is the set of TermX session ids still present in the
 * layout; captures naming any other pane are dropped. Host session ids are
 * monotonic and never reused, so a capture for a pane that is gone can never
 * be resumed by anything — and this is the only genuinely unbounded axis, as
 * newest-per-pane alone still grows by one line per pane forever.
 *
 * CALLER BEWARE: an EMPTY `keep` set means "no pane in the layout" and clears
 * the log. That is correct by this function's rules, but it makes the set the
 * caller's responsibility — pass the real layout, never a set you built before
 * the layout was restored.
 */
export function compactCaptures(
  text: string,
  keep?: ReadonlySet<number>,
): string | null {
  // A UTF-8 encoding is never SHORTER than the string's UTF-16 length, so a
  // short string is guaranteed to be a small file. Cheap, and never early.
  if (text.length <= COMPACT_THRESHOLD_BYTES) {
    return null;
  }
  const winners = new Map<number, { atMs: number; line: string }>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const capture = parseCaptureLine(line);
    if (capture === null) {
      continue;
    }
    // Filtered before the winner contest rather than after: a dropped pane's
    // newest line should not displace anything, and this way it never even
    // enters the map.
    if (keep !== undefined && !keep.has(capture.termxSessionId)) {
      continue;
    }
    const previous = winners.get(capture.termxSessionId);
    // `>=` matches parseCaptures: on a tie the later line is the later run.
    if (previous === undefined || capture.atMs >= previous.atMs) {
      winners.set(capture.termxSessionId, { atMs: capture.atMs, line });
    }
  }
  const kept = [...winners.values()].sort((left, right) => left.atMs - right.atMs);
  const compacted = kept.map((entry) => entry.line).join("\n");
  const next = kept.length === 0 ? "" : `${compacted}\n`;
  return next === text ? null : next;
}

/**
 * The record a captured pane resumes: the indexed conversation when the scan
 * has found it (its real title feeds the button's tooltip), otherwise a
 * synthesized one — the resume needs only provider + id, and refusing to
 * resume until a background scan lands would defeat the whole point.
 *
 * The cwd is the CAPTURE's whenever it has one: the hook recorded where the
 * pane actually was, which is the folder a restart must land in, while the
 * index's cwd comes from the transcript and can name a different folder.
 */
export function capturedRecord(
  capture: ConversationCapture,
  indexed: LlmSessionRecord | null,
): LlmSessionRecord {
  if (indexed !== null) {
    return { ...indexed, cwd: capture.cwd ?? indexed.cwd };
  }
  return {
    provider: capture.provider,
    id: capture.id,
    title: CAPTURED_TITLE,
    cwd: capture.cwd,
    filePath: "",
    updatedAtMs: capture.atMs,
    summary: null,
    recap: null,
    titleSource: "derived",
  };
}
