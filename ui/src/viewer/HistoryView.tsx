/**
 * Scrollback older than the live ring, paged backward out of the host's spill
 * file (spec §4). The terminal itself only ever holds the ring; everything
 * evicted from it lives on disk and is read a page at a time, newest first —
 * loading a 64 MB history into an xterm buffer to let someone read one line
 * from an hour ago is not a trade worth making.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { HISTORY_PAGE_BYTES, type HistoryPage } from "../host/client";

/** Reads one backward page. Injected so this view never touches a transport. */
export type HistoryReader = (
  beforeOffset: bigint,
  maxBytes: number,
) => Promise<HistoryPage>;

export interface HistoryViewProps {
  sessionId: number;
  /** Page backward from here — normally the oldest offset the pane still holds. */
  beforeOffset: bigint;
  read: HistoryReader;
}

interface LoadedPage {
  startOffset: bigint;
  text: string;
}

/**
 * A page starts wherever the byte arithmetic landed, which may be halfway
 * through an escape sequence — printing that leaks control characters into the
 * text. Drop to the first escape or newline, whichever comes first. A page with
 * neither is shown as-is: slightly wrong beats blank.
 */
export function trimToBoundary(data: Uint8Array): Uint8Array {
  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index];
    if (byte === 0x1b || byte === 0x0a) {
      return index === 0 ? data : data.subarray(index);
    }
  }
  return data;
}

const CSI_OR_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;

/**
 * Terminal bytes as readable text. The viewer is a plain-text surface, not a
 * second emulator, so colours and cursor moves are dropped rather than
 * half-honoured — the alternative is a page full of `[31m`.
 */
export function decodeHistory(data: Uint8Array): string {
  return new TextDecoder()
    .decode(data)
    .replace(OSC, "")
    .replace(CSI_OR_ESCAPE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

export function HistoryView({ sessionId, beforeOffset, read }: HistoryViewProps) {
  const [pages, setPages] = useState<readonly LoadedPage[]>([]);
  const [atStart, setAtStart] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Monotonic: a page for a session (or a starting cursor) the user has moved
  // away from must never be appended to what is now on screen.
  const requestId = useRef(0);
  const cursor = useRef(beforeOffset);

  const loadPage = useCallback(
    (before: bigint) => {
      const request = requestId.current;
      setLoading(true);
      setError(null);
      void read(before, HISTORY_PAGE_BYTES).then(
        (page) => {
          if (requestId.current !== request) {
            return;
          }
          setLoading(false);
          if (page.data.byteLength === 0) {
            setAtStart(true);
            return;
          }
          cursor.current = page.startOffset;
          setAtStart(page.atStart);
          setPages((current) => [
            { startOffset: page.startOffset, text: decodeHistory(trimToBoundary(page.data)) },
            ...current,
          ]);
        },
        (reason: unknown) => {
          if (requestId.current !== request) {
            return;
          }
          setLoading(false);
          setError(reason instanceof Error ? reason.message : "Unable to read earlier output");
        },
      );
    },
    [read],
  );

  useEffect(() => {
    requestId.current += 1;
    cursor.current = beforeOffset;
    setPages([]);
    setAtStart(false);
    setError(null);
    loadPage(beforeOffset);
  }, [sessionId, beforeOffset, loadPage]);

  const empty = pages.length === 0;
  return (
    <div className="viewer-history" data-testid="viewer-history">
      {atStart ? (
        <p className="viewer__notice">
          {empty
            ? "No earlier output was kept for this session."
            : "This is the oldest output the host still has."}
        </p>
      ) : (
        <button
          type="button"
          className="viewer-history__older"
          disabled={loading}
          onClick={() => loadPage(cursor.current)}
        >
          {loading ? "Loading…" : "Load older"}
        </button>
      )}
      {error ? (
        <p className="viewer__notice viewer-history__error" role="status">
          {error}
        </p>
      ) : null}
      {pages.map((page) => (
        <pre className="viewer__plain-text" key={String(page.startOffset)}>
          {page.text}
        </pre>
      ))}
    </div>
  );
}
