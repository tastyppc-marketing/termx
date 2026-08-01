import type { TranscriptWindowResult } from "../../native/transcript";

export type TranscriptRole = "user" | "assistant";
export type TranscriptToolPhase = "call" | "result";

export interface TranscriptMessageEntry {
  kind: "message";
  role: TranscriptRole;
  text: string;
}

export interface TranscriptToolEntry {
  kind: "tool";
  phase: TranscriptToolPhase;
  name: string;
  summary: string;
  detail: string;
  toolId: string | null;
}

export type TranscriptEntry = TranscriptMessageEntry | TranscriptToolEntry;

export interface ParsedTranscriptLine {
  offset: number;
  byteSize: number;
  entries: TranscriptEntry[];
}

export type TranscriptWindowPayload = TranscriptWindowResult;

export interface TranscriptChunk {
  key: string;
  requestBeforeOffset: number | null;
  requestMaxBytes: number;
  startOffset: number;
  endOffset: number;
  byteSize: number;
  lines: ParsedTranscriptLine[] | null;
}

type JsonObject = Record<string, unknown>;

const textEncoder = new TextEncoder();
const PRIMARY_ARGUMENT_KEYS = [
  "file_path",
  "path",
  "command",
  "query",
  "prompt",
  "url",
  "description",
] as const;

function objectValue(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function compact(value: unknown, maxChars = 140): string {
  const source =
    typeof value === "string"
      ? value
      : value === undefined
        ? ""
        : JSON.stringify(value);
  return (source ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function pretty(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2) ?? "";
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function primaryArgument(parsed: unknown): string {
  const record = objectValue(parsed);
  if (record) {
    for (const key of PRIMARY_ARGUMENT_KEYS) {
      if (record[key] !== undefined) {
        return compact(record[key]);
      }
    }
    const first = Object.values(record).find(
      (candidate) =>
        typeof candidate === "string" ||
        typeof candidate === "number" ||
        typeof candidate === "boolean",
    );
    return compact(first);
  }
  return compact(parsed);
}

function message(role: TranscriptRole, text: unknown): TranscriptMessageEntry[] {
  const value = stringValue(text);
  return value && value.trim().length > 0
    ? [{ kind: "message", role, text: value }]
    : [];
}

function toolEntry(
  phase: TranscriptToolPhase,
  source: JsonObject,
  fallbackName?: string,
): TranscriptToolEntry {
  const input =
    source.input ??
    source.arguments ??
    source.args ??
    source.action ??
    source.output ??
    source.content;
  const parsedInput = parseArguments(input);
  const name =
    stringValue(source.name) ?? stringValue(source.tool_name) ?? fallbackName ??
    (phase === "result" ? "result" : "tool");
  return {
    kind: "tool",
    phase,
    name,
    summary: primaryArgument(parsedInput),
    detail: pretty(parsedInput),
    toolId:
      stringValue(source.id) ??
      stringValue(source.tool_use_id) ??
      stringValue(source.call_id),
  };
}

function contentEntries(
  content: unknown,
  role: TranscriptRole,
): TranscriptEntry[] {
  if (typeof content === "string") {
    return message(role, content);
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const entries: TranscriptEntry[] = [];
  for (const candidate of content) {
    const block = objectValue(candidate);
    if (!block) {
      continue;
    }
    const type = stringValue(block.type);
    if (type === "text" || type === "input_text" || type === "output_text") {
      entries.push(...message(role, block.text));
    } else if (
      type === "tool_use" ||
      type === "function_call" ||
      type === "custom_tool_call"
    ) {
      entries.push(toolEntry("call", block));
    } else if (
      type === "tool_result" ||
      type === "function_call_output" ||
      type === "custom_tool_call_output"
    ) {
      entries.push(toolEntry("result", block));
    }
  }
  return entries;
}

function messageObjectEntries(
  source: JsonObject,
  fallbackRole?: TranscriptRole,
): TranscriptEntry[] {
  const roleValue = stringValue(source.role);
  const role =
    roleValue === "user" || roleValue === "assistant"
      ? roleValue
      : fallbackRole;
  if (!role) {
    return [];
  }
  return contentEntries(source.content ?? source.text, role);
}

function parseClaudeLike(source: JsonObject): TranscriptEntry[] {
  const type = stringValue(source.type);
  if (type !== "user" && type !== "assistant") {
    return [];
  }
  if (type === "user" && source.isMeta === true) {
    return [];
  }
  const nested = objectValue(source.message);
  if (nested) {
    return messageObjectEntries(nested, type);
  }
  return contentEntries(source.content ?? source.text, type);
}

function parseCodexPayload(payload: JsonObject): TranscriptEntry[] {
  const type = stringValue(payload.type);
  if (type === "message") {
    return messageObjectEntries(payload);
  }
  if (
    type === "function_call" ||
    type === "custom_tool_call" ||
    type === "local_shell_call" ||
    type === "web_search_call"
  ) {
    const fallbackName =
      type === "local_shell_call"
        ? "shell"
        : type === "web_search_call"
          ? "web_search"
          : undefined;
    return [toolEntry("call", payload, fallbackName)];
  }
  if (
    type === "function_call_output" ||
    type === "custom_tool_call_output" ||
    type === "local_shell_call_output"
  ) {
    return [toolEntry("result", payload)];
  }
  if (type === "user_message") {
    return message("user", payload.message ?? payload.content);
  }
  if (type === "agent_message") {
    return message("assistant", payload.message ?? payload.content);
  }
  return [];
}

/** Parse one provider JSONL record. Unknown and malformed records are absent. */
export function parseTranscriptLine(
  raw: string,
  offset: number,
  provider?: string,
  knownByteSize?: number,
): ParsedTranscriptLine | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const source = objectValue(value);
  if (!source) {
    return null;
  }

  const parseCodexLike = (): TranscriptEntry[] => {
    const topType = stringValue(source.type);
    const payload = objectValue(source.payload);
    return (topType === "response_item" || topType === "event_msg") && payload
      ? parseCodexPayload(payload)
      : [];
  };
  const parsers =
    provider === "codex"
      ? [parseCodexLike, () => parseClaudeLike(source)]
      : [() => parseClaudeLike(source), parseCodexLike];
  let entries: TranscriptEntry[] = [];
  for (const parse of parsers) {
    entries = parse();
    if (entries.length > 0) break;
  }
  if (entries.length === 0) {
    return null;
  }
  return {
    offset,
    byteSize: knownByteSize ?? textEncoder.encode(raw).byteLength + 1,
    entries,
  };
}

/** Convert a command response into an offset-addressable, reloadable chunk. */
export function parseTranscriptWindow(
  key: string,
  requestBeforeOffset: number | null,
  window: TranscriptWindowPayload,
  provider?: string,
  requestMaxBytes = 256 * 1024,
): TranscriptChunk {
  const startOffset = window.nextBeforeOffset ?? 0;
  let offset = startOffset;
  let byteSize = 0;
  const lines: ParsedTranscriptLine[] = [];

  for (const raw of window.lines) {
    const rawBytes = textEncoder.encode(raw).byteLength + 1;
    const parsed = parseTranscriptLine(raw, offset, provider, rawBytes);
    if (parsed) {
      lines.push(parsed);
    }
    offset += rawBytes;
    byteSize += rawBytes;
  }

  return {
    key,
    requestBeforeOffset,
    requestMaxBytes,
    startOffset,
    endOffset: requestBeforeOffset ?? offset,
    byteSize,
    lines,
  };
}

/** Insert or replace a chunk while preserving file order. */
export function mergeTranscriptChunk(
  chunks: readonly TranscriptChunk[],
  incoming: TranscriptChunk,
): TranscriptChunk[] {
  return [...chunks.filter((chunk) => chunk.key !== incoming.key), incoming].sort(
    (left, right) =>
      left.startOffset - right.startOffset || left.endOffset - right.endOffset,
  );
}

/** Renderable lines in file order, deduplicated where search windows overlap. */
export function flattenTranscriptLines(
  chunks: readonly TranscriptChunk[],
): ParsedTranscriptLine[] {
  const byOffset = new Map<number, ParsedTranscriptLine>();
  for (const chunk of chunks) {
    for (const line of chunk.lines ?? []) {
      byOffset.set(line.offset, line);
    }
  }

  const namesById = new Map<string, string>();
  return [...byOffset.values()]
    .sort((left, right) => left.offset - right.offset)
    .map((line) => {
      let entries = line.entries;
      for (const [index, entry] of line.entries.entries()) {
        if (entry.kind !== "tool" || !entry.toolId) continue;
        if (entry.phase === "call") {
          namesById.set(entry.toolId, entry.name);
          continue;
        }
        const resolvedName = namesById.get(entry.toolId);
        if (entry.name === "result" && resolvedName) {
          if (entries === line.entries) entries = [...entries];
          entries[index] = { ...entry, name: resolvedName };
        }
      }
      return entries === line.entries ? line : { ...line, entries };
    });
}

function distanceFromChunk(chunk: TranscriptChunk, anchorOffset: number): number {
  if (anchorOffset < chunk.startOffset) {
    return chunk.startOffset - anchorOffset;
  }
  if (anchorOffset > chunk.endOffset) {
    return anchorOffset - chunk.endOffset;
  }
  return 0;
}

/**
 * Evict parsed payloads farthest from the viewport. Chunk cursors and ranges
 * remain, so the exact window can be fetched again without retaining its text.
 */
export function enforceTranscriptMemoryGuard(
  chunks: readonly TranscriptChunk[],
  maxBytes: number,
  anchorOffset: number,
): TranscriptChunk[] {
  const result = chunks.map((chunk) => ({ ...chunk }));
  const loaded = result.filter((chunk) => chunk.lines !== null);
  let total = loaded.reduce((sum, chunk) => sum + chunk.byteSize, 0);
  let loadedCount = loaded.length;
  const evictionOrder = [...loaded].sort(
    (left, right) =>
      distanceFromChunk(right, anchorOffset) -
        distanceFromChunk(left, anchorOffset) ||
      right.byteSize - left.byteSize,
  );

  for (const chunk of evictionOrder) {
    if (total <= maxBytes || loadedCount <= 1) break;
    chunk.lines = null;
    total -= chunk.byteSize;
    loadedCount -= 1;
  }
  return result;
}
