import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type UIEvent,
} from "react";
import type { LlmSessionRecord } from "../ViewerHost";
import { renderMarkdown } from "../markdown";
import {
  tauriTranscriptCommands,
  type TranscriptCommands,
  type TranscriptSearchMatch,
  type TranscriptSearchMode,
} from "../../native/transcript";
import {
  enforceTranscriptMemoryGuard,
  flattenTranscriptLines,
  mergeTranscriptChunk,
  parseTranscriptWindow,
  type TranscriptChunk,
} from "./transcriptModel";
import { TranscriptSearch } from "./TranscriptSearch";
import "./Transcript.css";

export const TRANSCRIPT_WINDOW_BYTES = 256 * 1024;
export const TRANSCRIPT_MATCH_WINDOW_BYTES = 4 * 1024 * 1024;
export const TRANSCRIPT_MEMORY_BYTES = 10 * 1024 * 1024;
export const TRANSCRIPT_MATCH_MARGIN_BYTES = TRANSCRIPT_MATCH_WINDOW_BYTES - 1;
const MAX_SEARCH_RESULTS = 200;
export const TRANSCRIPT_SEARCH_DEBOUNCE_MS = 180;
const MAX_USER_RESULTS = 1000;
/**
 * The jump walk wants "every user line", but the command needs a non-empty
 * query. Every jsonl record it can classify as a user turn carries a `type`
 * key, so this is the shortest needle that matches all of them and nothing the
 * filter would have kept anyway.
 */
const USER_LINE_QUERY = '"type"';

/**
 * `filter: "user"` selects lines whose TOP-LEVEL `type` is `"user"`, which in
 * the Claude format also covers tool results (the harness reporting back) and
 * `isMeta` hook echoes. Neither is something a person typed — and `isMeta`
 * lines are skipped by the parser outright, so jumping to one would land on a
 * line that renders nothing at all. Both announce themselves inside the match
 * snippet, which is the first ~200 characters of the record, so the walk drops
 * them without loading a single window.
 */
const NOT_A_SPOKEN_TURN = /"tool_result"|"tool_use_id"|"ismeta"\s*:\s*true/;

/** Jump-walk candidates: user lines a person actually typed, in file order. */
function spokenUserMatches(
  matches: readonly TranscriptSearchMatch[],
): TranscriptSearchMatch[] {
  const spoken = matches.filter(
    (match) => !NOT_A_SPOKEN_TURN.test(match.snippet.toLowerCase()),
  );
  // A transcript shape this heuristic does not recognise keeps every match
  // rather than leaving the control with nowhere to go.
  return spoken.length > 0 ? spoken : [...matches];
}

const TranscriptCommandsContext = createContext<TranscriptCommands>(
  tauriTranscriptCommands,
);

export interface TranscriptCommandsProviderProps {
  commands: TranscriptCommands;
  children: ReactNode;
}

export function TranscriptCommandsProvider({
  commands,
  children,
}: TranscriptCommandsProviderProps) {
  return (
    <TranscriptCommandsContext.Provider value={commands}>
      {children}
    </TranscriptCommandsContext.Provider>
  );
}

function chunkKey(beforeOffset: number | null): string {
  return beforeOffset === null ? "end" : `before:${beforeOffset}`;
}

export interface TranscriptViewProps {
  record: LlmSessionRecord;
}

/** Complete, bounded transcript reader mounted through ViewerHost's U14 seam. */
export function TranscriptView({ record }: TranscriptViewProps) {
  const commands = useContext(TranscriptCommandsContext);
  const [chunks, setChunks] = useState<TranscriptChunk[]>([]);
  const chunksRef = useRef<TranscriptChunk[]>([]);
  const [earlierCursor, setEarlierCursor] = useState<number | null>(null);
  const [loadingWindow, setLoadingWindow] = useState(true);
  const [initialLoadAttempt, setInitialLoadAttempt] = useState(0);
  const [initialLoadFailed, setInitialLoadFailed] = useState(false);
  const [windowError, setWindowError] = useState<string | null>(null);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(() => new Set());
  const [activeOffset, setActiveOffset] = useState<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<TranscriptSearchMode>("substring");
  const [matches, setMatches] = useState<TranscriptSearchMatch[]>([]);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const userMatchesRef = useRef<TranscriptSearchMatch[] | null>(null);
  const [jumpIndex, setJumpIndex] = useState<number | null>(null);
  const viewportAnchorRef = useRef(Number.MAX_SAFE_INTEGER);
  const rootRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const recordPathRef = useRef(record.filePath);
  recordPathRef.current = record.filePath;
  const revealRequestRef = useRef(0);
  const windowRequestRef = useRef(0);
  const jumpRequestRef = useRef(0);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<number | null>(null);
  const pendingPrependHeight = useRef<number | null>(null);
  const scrollInitialToBottom = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const searchRequest = useRef(0);

  const commitChunks = useCallback(
    (
      update: (current: readonly TranscriptChunk[]) => TranscriptChunk[],
      anchorOffset = viewportAnchorRef.current,
    ): void => {
      setChunks((current) => {
        const next = enforceTranscriptMemoryGuard(
          update(current),
          TRANSCRIPT_MEMORY_BYTES,
          anchorOffset,
        );
        chunksRef.current = next;
        return next;
      });
    },
    [],
  );

  const readChunk = useCallback(
    async (
      beforeOffset: number | null,
      key: string,
      maxBytes = TRANSCRIPT_WINDOW_BYTES,
    ) => {
      const window = await commands.readWindow(
        record.filePath,
        beforeOffset,
        maxBytes,
      );
      return {
        window,
        chunk: parseTranscriptWindow(
          key,
          beforeOffset,
          window,
          record.provider,
          maxBytes,
        ),
      };
    },
    [commands, record.filePath, record.provider],
  );

  useEffect(() => {
    let cancelled = false;
    revealRequestRef.current += 1;
    windowRequestRef.current += 1;
    jumpRequestRef.current += 1;
    searchRequest.current += 1;
    setChunks([]);
    chunksRef.current = [];
    setEarlierCursor(null);
    setWindowError(null);
    setInitialLoadFailed(false);
    setLoadingWindow(true);
    setActiveOffset(null);
    setMatches([]);
    setSearchTruncated(false);
    setSearchError(null);
    setSearching(false);
    setActiveMatchIndex(-1);
    userMatchesRef.current = null;
    setJumpIndex(null);
    pendingPrependHeight.current = null;
    viewportAnchorRef.current = Number.MAX_SAFE_INTEGER;
    scrollInitialToBottom.current = true;

    void readChunk(null, "end")
      .then(({ window: loadedWindow, chunk }) => {
        if (cancelled) return;
        commitChunks((current) => mergeTranscriptChunk(current, chunk));
        setEarlierCursor(loadedWindow.nextBeforeOffset);
      })
      .catch(() => {
        if (!cancelled) {
          setInitialLoadFailed(true);
          setWindowError("Transcript could not be read.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingWindow(false);
      });

    return () => {
      cancelled = true;
    };
  }, [commitChunks, initialLoadAttempt, readChunk, record.updatedAtMs]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
      if (programmaticScrollTimerRef.current !== null) {
        window.clearTimeout(programmaticScrollTimerRef.current);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    if (pendingPrependHeight.current !== null) {
      scroll.scrollTop += scroll.scrollHeight - pendingPrependHeight.current;
      pendingPrependHeight.current = null;
      return;
    }
    if (scrollInitialToBottom.current && !loadingWindow) {
      scroll.scrollTop = scroll.scrollHeight;
      scrollInitialToBottom.current = false;
    }
  }, [chunks, loadingWindow]);

  const scrollToOffset = useCallback((offset: number): void => {
    const line = scrollRef.current?.querySelector<HTMLElement>(
      `[data-offset="${offset}"]`,
    );
    if (!line) return;
    programmaticScrollRef.current = true;
    if (programmaticScrollTimerRef.current !== null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
    }
    line.scrollIntoView?.({ block: "center" });
    programmaticScrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticScrollTimerRef.current = null;
    }, 300);
  }, []);

  useLayoutEffect(() => {
    if (activeOffset !== null) {
      scrollToOffset(activeOffset);
    }
  }, [activeOffset, chunks, scrollToOffset]);

  const revealOffset = useCallback(
    async (offset: number): Promise<void> => {
      const filePath = record.filePath;
      const request = ++revealRequestRef.current;
      setWindowError(null);
      setActiveOffset(offset);
      viewportAnchorRef.current = offset;
      const cached = chunksRef.current.some((chunk) =>
        chunk.lines?.some((line) => line.offset === offset),
      );
      if (cached) {
        return;
      }

      const beforeOffset = offset + TRANSCRIPT_MATCH_MARGIN_BYTES;
      try {
        const { chunk } = await readChunk(
          beforeOffset,
          `match:${offset}`,
          TRANSCRIPT_MATCH_WINDOW_BYTES,
        );
        if (
          recordPathRef.current !== filePath ||
          revealRequestRef.current !== request
        ) {
          return;
        }
        commitChunks(
          (current) => mergeTranscriptChunk(current, chunk),
          offset,
        );
        const found = chunk.lines?.some((line) => line.offset === offset) ?? false;
        if (!found) {
          setActiveOffset(null);
          setWindowError("That matching transcript line is too large or unreadable.");
        }
      } catch {
        if (
          recordPathRef.current === filePath &&
          revealRequestRef.current === request
        ) {
          setActiveOffset(null);
          setWindowError("That transcript section could not be loaded.");
        }
      }
    }, [commitChunks, readChunk, record.filePath],
  );

  useEffect(() => {
    revealRequestRef.current += 1;
    setActiveOffset(null);
    if (!searchOpen || query.length === 0) {
      searchRequest.current += 1;
      setMatches([]);
      setSearchTruncated(false);
      setSearchError(null);
      setSearching(false);
      setActiveMatchIndex(-1);
      return;
    }
    if (mode === "regex") {
      try {
        new RegExp(query);
      } catch {
        searchRequest.current += 1;
        setMatches([]);
        setSearchTruncated(false);
        setSearchError("Invalid pattern");
        setSearching(false);
        setActiveMatchIndex(-1);
        return;
      }
    }

    const request = ++searchRequest.current;
    setSearchError(null);
    setSearching(true);
    const timer = window.setTimeout(() => {
      void commands
        .search(
          record.filePath,
          query,
          mode,
          "all",
          MAX_SEARCH_RESULTS,
        )
        .then((result) => {
          if (searchRequest.current !== request) return;
          setMatches(result.matches);
          setSearchTruncated(result.truncated);
          const nextIndex = result.matches.length > 0 ? 0 : -1;
          setActiveMatchIndex(nextIndex);
          if (nextIndex >= 0) {
            void revealOffset(result.matches[nextIndex]?.offset ?? 0);
          }
        })
        .catch(() => {
          if (searchRequest.current === request) {
            setMatches([]);
            setSearchTruncated(false);
            setSearchError("Search unavailable");
            setActiveMatchIndex(-1);
          }
        })
        .finally(() => {
          if (searchRequest.current === request) setSearching(false);
        });
    }, TRANSCRIPT_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [commands, mode, query, record.filePath, revealOffset, searchOpen]);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [searchOpen]);

  const loadEarlier = useCallback(async (): Promise<void> => {
    if (earlierCursor === null || loadingWindow) return;
    const filePath = record.filePath;
    const request = ++windowRequestRef.current;
    const cursor = earlierCursor;
    pendingPrependHeight.current = scrollRef.current?.scrollHeight ?? 0;
    setLoadingWindow(true);
    setWindowError(null);
    try {
      const { window: loadedWindow, chunk } = await readChunk(
        cursor,
        chunkKey(cursor),
      );
      if (
        recordPathRef.current !== filePath ||
        windowRequestRef.current !== request
      ) {
        return;
      }
      commitChunks((current) => mergeTranscriptChunk(current, chunk));
      setEarlierCursor(loadedWindow.nextBeforeOffset);
    } catch {
      if (
        recordPathRef.current === filePath &&
        windowRequestRef.current === request
      ) {
        pendingPrependHeight.current = null;
        setWindowError("Earlier transcript could not be loaded.");
      }
    } finally {
      if (
        recordPathRef.current === filePath &&
        windowRequestRef.current === request
      ) {
        setLoadingWindow(false);
      }
    }
  }, [commitChunks, earlierCursor, loadingWindow, readChunk, record.filePath]);

  const reloadChunk = useCallback(
    async (chunk: TranscriptChunk): Promise<void> => {
      if (loadingWindow) return;
      const filePath = record.filePath;
      const request = ++windowRequestRef.current;
      setLoadingWindow(true);
      setWindowError(null);
      try {
        const { chunk: restored } = await readChunk(
          chunk.requestBeforeOffset,
          chunk.key,
          chunk.requestMaxBytes,
        );
        if (
          recordPathRef.current !== filePath ||
          windowRequestRef.current !== request
        ) {
          return;
        }
        commitChunks(
          (current) => mergeTranscriptChunk(current, restored),
          chunk.startOffset,
        );
      } catch {
        if (
          recordPathRef.current === filePath &&
          windowRequestRef.current === request
        ) {
          setWindowError("That transcript section could not be reloaded.");
        }
      } finally {
        if (
          recordPathRef.current === filePath &&
          windowRequestRef.current === request
        ) {
          setLoadingWindow(false);
        }
      }
    }, [commitChunks, loadingWindow, readChunk, record.filePath],
  );

  const chooseSearchMatch = useCallback(
    (nextIndex: number): void => {
      if (matches.length === 0) return;
      const normalized = (nextIndex + matches.length) % matches.length;
      setActiveMatchIndex(normalized);
      const match = matches[normalized];
      if (match) void revealOffset(match.offset);
    },
    [matches, revealOffset],
  );

  const jumpToUser = useCallback(async (): Promise<void> => {
    const filePath = record.filePath;
    const request = ++jumpRequestRef.current;
    setWindowError(null);
    let available = userMatchesRef.current;
    if (available === null) {
      try {
        const result = await commands.search(
          filePath,
          USER_LINE_QUERY,
          "substring",
          "user",
          MAX_USER_RESULTS,
        );
        if (
          recordPathRef.current !== filePath ||
          jumpRequestRef.current !== request
        ) {
          return;
        }
        available = spokenUserMatches(result.matches);
        userMatchesRef.current = available;
      } catch {
        if (
          recordPathRef.current === filePath &&
          jumpRequestRef.current === request
        ) {
          setWindowError("User-message navigation is unavailable.");
        }
        return;
      }
    }
    if (
      recordPathRef.current !== filePath ||
      jumpRequestRef.current !== request ||
      available.length === 0
    ) {
      return;
    }
    const next = jumpIndex === null
      ? available.length - 1
      : Math.max(0, jumpIndex - 1);
    setJumpIndex(next);
    const match = available[next];
    if (match) await revealOffset(match.offset);
  }, [commands, jumpIndex, record.filePath, revealOffset]);

  const closeSearch = useCallback((): void => {
    setSearchOpen(false);
    queueMicrotask(() => rootRef.current?.focus());
  }, []);

  const handleUserScrollIntent = useCallback((): void => {
    programmaticScrollRef.current = false;
    if (programmaticScrollTimerRef.current !== null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
      programmaticScrollTimerRef.current = null;
    }
  }, []);

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>): void => {
    const scroll = event.currentTarget;
    const atBottom = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 4;
    if (atBottom && !programmaticScrollRef.current) {
      setJumpIndex(null);
    }
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const center = scroll.scrollTop + scroll.clientHeight / 2;
      const visibleLines = scroll.querySelectorAll<HTMLElement>(
        ".transcript-line[data-offset]",
      );
      let closest: HTMLElement | null = null;
      let distance = Number.MAX_SAFE_INTEGER;
      for (const line of visibleLines) {
        const nextDistance = Math.abs(line.offsetTop - center);
        if (nextDistance < distance) {
          distance = nextDistance;
          closest = line;
        }
      }
      if (closest?.dataset.offset) {
        viewportAnchorRef.current = Number(closest.dataset.offset);
      }
    });
  }, []);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>): void => {
      if (
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        ["ArrowDown", "End", "PageDown", " "].includes(event.key)
      ) {
        handleUserScrollIntent();
      }
      if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (event.ctrlKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        void jumpToUser();
        return;
      }
      if (searchOpen && event.key === "Escape") {
        event.preventDefault();
        closeSearch();
        return;
      }
      if (
        searchOpen &&
        event.key === "Enter" &&
        event.target === searchInputRef.current
      ) {
        event.preventDefault();
        chooseSearchMatch(activeMatchIndex + (event.shiftKey ? -1 : 1));
      }
    }, [
      activeMatchIndex,
      chooseSearchMatch,
      closeSearch,
      handleUserScrollIntent,
      jumpToUser,
      searchOpen,
    ],
  );

  const lines = useMemo(() => flattenTranscriptLines(chunks), [chunks]);
  const evicted = useMemo(
    () => chunks.filter((chunk) => chunk.lines === null),
    [chunks],
  );

  return (
    <section
      ref={rootRef}
      className="transcript"
      aria-label={`Transcript: ${record.title}`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="transcript__toolbar">
        <button
          type="button"
          className="transcript__toolbar-button"
          aria-label={
            initialLoadFailed
              ? "Retry transcript"
              : "Load earlier transcript"
          }
          disabled={
            loadingWindow || (earlierCursor === null && !initialLoadFailed)
          }
          onClick={() => {
            if (initialLoadFailed) {
              setInitialLoadAttempt((attempt) => attempt + 1);
            } else {
              void loadEarlier();
            }
          }}
        >
          {initialLoadFailed
            ? "Retry"
            : loadingWindow && chunks.length > 0
              ? "Loading…"
              : "Load earlier"}
        </button>
        <span className="transcript__toolbar-spacer" />
        <button
          type="button"
          className="transcript__toolbar-button"
          aria-label={
            jumpIndex === null
              ? "Jump to last user message"
              : "Jump to previous user message"
          }
          title="Jump to last user message (Ctrl+Shift+J)"
          onClick={() => void jumpToUser()}
        >
          ↟ Last user
        </button>
        <button
          type="button"
          className="transcript__toolbar-button"
          aria-label="Search transcript"
          title="Search transcript (Ctrl+F)"
          onClick={() => {
            if (searchOpen) closeSearch();
            else setSearchOpen(true);
          }}
        >
          Search
        </button>
      </div>

      {searchOpen ? (
        <TranscriptSearch
          inputRef={searchInputRef}
          query={query}
          mode={mode}
          matchCount={matches.length}
          activeIndex={activeMatchIndex}
          truncated={searchTruncated}
          loading={searching}
          error={searchError}
          onQueryChange={setQuery}
          onModeChange={setMode}
          onPrevious={() => chooseSearchMatch(activeMatchIndex - 1)}
          onNext={() => chooseSearchMatch(activeMatchIndex + 1)}
          onClose={closeSearch}
        />
      ) : null}

      {windowError ? <p className="transcript__notice">{windowError}</p> : null}

      <div
        ref={scrollRef}
        className="transcript__scroll"
        onScroll={handleScroll}
        onWheel={handleUserScrollIntent}
        onPointerDown={handleUserScrollIntent}
        onTouchStart={handleUserScrollIntent}
      >
        {loadingWindow && chunks.length === 0 ? (
          <p className="transcript__empty">Loading transcript…</p>
        ) : null}
        {evicted.map((chunk) => (
          <div
            className="transcript__evicted"
            key={`evicted:${chunk.key}`}
            style={{ order: chunk.startOffset }}
          >
            <span>Earlier content was released from memory.</span>
            <button
              type="button"
              disabled={loadingWindow}
              aria-label={`Reload transcript section starting at ${chunk.startOffset}`}
              onClick={() => void reloadChunk(chunk)}
            >
              Reload section
            </button>
          </div>
        ))}
        {lines.map((line) => (
          <div
            className={`transcript-line${
              line.offset === activeOffset ? " transcript-line--active-match" : ""
            }`}
            data-offset={line.offset}
            key={line.offset}
            style={{ order: line.offset }}
          >
            {line.entries.map((entry, entryIndex) => {
              const key = `${line.offset}:${entryIndex}`;
              if (entry.kind === "message") {
                return entry.role === "assistant" ? (
                  <article
                    className="transcript-turn transcript-turn--assistant viewer-markdown"
                    key={key}
                  >
                    <span className="transcript-turn__role">Assistant</span>
                    {renderMarkdown(entry.text)}
                  </article>
                ) : (
                  <article className="transcript-turn transcript-turn--user" key={key}>
                    <span className="transcript-turn__role">User</span>
                    <div className="transcript-turn__user-text">{entry.text}</div>
                  </article>
                );
              }

              const name = entry.name;
              const expanded = expandedTools.has(key);
              return (
                <div className="transcript-tool" key={key}>
                  <button
                    type="button"
                    className="transcript-tool__stub"
                    aria-label={`${expanded ? "Collapse" : "Expand"} tool ${name}`}
                    aria-expanded={expanded}
                    onClick={() =>
                      setExpandedTools((current) => {
                        const next = new Set(current);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      })
                    }
                  >
                    <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                    <span>
                      tool: {name}{entry.summary ? ` ${entry.summary}` : ""}
                    </span>
                  </button>
                  {expanded ? (
                    <pre className="transcript-tool__detail">{entry.detail}</pre>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
        {!loadingWindow &&
        !initialLoadFailed &&
        lines.length === 0 &&
        evicted.length === 0 ? (
          <p className="transcript__empty">No readable transcript turns.</p>
        ) : null}
      </div>
    </section>
  );
}
