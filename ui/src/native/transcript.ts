import { invoke } from "@tauri-apps/api/core";

export type TranscriptSearchMode = "substring" | "regex" | "fuzzy";
export type TranscriptSearchFilter = "all" | "user";

export interface TranscriptWindowResult {
  lines: string[];
  nextBeforeOffset: number | null;
}

export interface TranscriptSearchMatch {
  offset: number;
  snippet: string;
}

export interface TranscriptSearchResult {
  matches: TranscriptSearchMatch[];
  truncated: boolean;
}

export interface TranscriptCommands {
  readWindow(
    filePath: string,
    beforeOffset: number | null,
    maxBytes: number,
  ): Promise<TranscriptWindowResult>;
  search(
    filePath: string,
    query: string,
    mode: TranscriptSearchMode,
    filter: TranscriptSearchFilter,
    maxResults: number,
  ): Promise<TranscriptSearchResult>;
}

export function readTranscriptWindow(
  filePath: string,
  beforeOffset: number | null,
  maxBytes: number,
): Promise<TranscriptWindowResult> {
  return invoke<TranscriptWindowResult>("read_transcript_window", {
    filePath,
    beforeOffset,
    maxBytes,
  });
}

export function searchTranscript(
  filePath: string,
  query: string,
  mode: TranscriptSearchMode,
  filter: TranscriptSearchFilter,
  maxResults: number,
): Promise<TranscriptSearchResult> {
  return invoke<TranscriptSearchResult>("search_transcript", {
    filePath,
    query,
    mode,
    filter,
    maxResults,
  });
}

export const tauriTranscriptCommands: TranscriptCommands = {
  readWindow: readTranscriptWindow,
  search: searchTranscript,
};
