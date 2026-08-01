/**
 * Session palette (spec §4): `Ctrl+Shift+R` overlay that resumes any LLM
 * session without leaving the keyboard. Clones FolderSearch's interaction
 * contract exactly — combobox, ArrowUp/Down with wrap, Enter selects the
 * highlighted row, Esc closes, pointer hover moves the highlight, click
 * selects — and reuses the rail's row anatomy (provider badge, title,
 * shortened cwd, relative time) minus folders.
 *
 * All data is local (`ConversationsStore`'s already-scanned snapshot), so
 * unlike FolderSearch there is no async completion source and therefore no
 * debounce/race to guard against: filtering re-runs synchronously on every
 * keystroke. The palette never triggers a scan itself — the rail already
 * causes one, and re-scanning here would be a second scan the spec rules out.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { scoreFolder } from "../../folders/fuzzyScore";
import { relativeTime, shortenCwd } from "../folderOps";
import type { ConversationsStore } from "../store";
import type { LlmSessionRecord } from "../types";
import "./SessionPalette.css";

export interface SessionPaletteProps {
  store: ConversationsStore;
  /** Renders nothing when false; resets query/highlight each time it opens. */
  open: boolean;
  onClose(): void;
  onResume(record: LlmSessionRecord): void;
  /** Injected clock for relative times; tests pass a fixed value. */
  nowMs?: number;
}

const ROW_CAP = 12;

/**
 * Fuzzy-ranks a record against the query using the folder searcher's scorer
 * (per-token, leaf-aware) applied to each of title/cwd/summary independently,
 * since `scoreFolder` requires every token to land in one string and a query
 * word may legitimately target any one of the three fields. A match in the
 * title outranks a cwd-only match, which outranks a summary-only match.
 */
function scoreSession(query: string, record: LlmSessionRecord): number | null {
  const titleScore = scoreFolder(query, record.title);
  if (titleScore !== null) {
    return titleScore + 20_000;
  }
  const cwdScore = record.cwd ? scoreFolder(query, record.cwd) : null;
  if (cwdScore !== null) {
    return cwdScore + 10_000;
  }
  const summaryScore = record.summary ? scoreFolder(query, record.summary) : null;
  if (summaryScore !== null) {
    return summaryScore;
  }
  return null;
}

/** Empty query = most recent sessions, in the store's newest-first order. */
function rankSessions(
  query: string,
  records: readonly LlmSessionRecord[],
): LlmSessionRecord[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return records.slice(0, ROW_CAP);
  }
  return records
    .map((record) => ({ record, score: scoreSession(trimmed, record) }))
    .filter(
      (entry): entry is { record: LlmSessionRecord; score: number } =>
        entry.score !== null,
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, ROW_CAP)
    .map((entry) => entry.record);
}

export function SessionPalette({
  store,
  open,
  onClose,
  onResume,
  nowMs,
}: SessionPaletteProps) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Every open is a fresh palette: reset the query and re-focus, matching
  // FolderSearch's remount-on-open behaviour without requiring the caller to
  // unmount/remount this component.
  useEffect(() => {
    if (!open) {
      return;
    }
    setQuery("");
    setHighlight(0);
    inputRef.current?.focus();
  }, [open]);

  // Subscribed (not a one-shot `getSnapshot()` read) so a scan that finishes
  // while the palette is already open — e.g. it was opened before the rail's
  // first refresh landed — still populates the list live.
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const records = snapshot.records;
  const rows = useMemo(() => rankSessions(query, records), [query, records]);
  const rowCount = rows.length;
  const clampedHighlight = rowCount > 0 ? Math.min(highlight, rowCount - 1) : -1;
  const now = nowMs ?? Date.now();

  if (!open) {
    return null;
  }

  const activate = (index: number) => {
    const record = rows[index];
    if (record) {
      onResume(record);
    }
  };

  return (
    <div className="session-palette-backdrop">
      <div
        className="session-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Resume a session"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (rowCount === 0) {
              return;
            }
            const delta = event.key === "ArrowDown" ? 1 : -1;
            setHighlight((clampedHighlight + delta + rowCount) % rowCount);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            activate(clampedHighlight);
            return;
          }
          if (event.key === "Tab") {
            // Single-field palette: keep focus in the input.
            event.preventDefault();
          }
        }}
      >
        <input
          ref={inputRef}
          className="session-palette__input"
          aria-label="Search sessions"
          role="combobox"
          aria-expanded="true"
          aria-controls="session-palette-results"
          {...(clampedHighlight >= 0
            ? { "aria-activedescendant": `session-palette-option-${clampedHighlight}` }
            : {})}
          placeholder="Search sessions by title, folder, or summary…"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setHighlight(0);
          }}
        />
        <ul
          className="session-palette__results"
          id="session-palette-results"
          role="listbox"
          aria-label="Sessions"
        >
          {rows.map((record, index) => (
            <li
              key={`${record.provider}:${record.id}`}
              id={`session-palette-option-${index}`}
              role="option"
              aria-selected={index === clampedHighlight}
              data-provider={record.provider}
              className={`session-palette__row${
                index === clampedHighlight ? " session-palette__row--active" : ""
              }`}
              onPointerEnter={() => setHighlight(index)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => activate(index)}
            >
              <span
                className="session-palette__badge"
                aria-label={`${record.provider} session`}
              >
                {record.provider === "claude" ? "C" : "X"}
              </span>
              <span className="session-palette__content">
                <span className="session-palette__line">
                  <span className="session-palette__title" title={record.title}>
                    {record.title}
                  </span>
                  <span className="session-palette__time">
                    {relativeTime(record.updatedAtMs, now)}
                  </span>
                </span>
                <span
                  className="session-palette__cwd"
                  title={record.cwd ?? undefined}
                >
                  {shortenCwd(record.cwd)}
                </span>
              </span>
            </li>
          ))}
          {rowCount === 0 ? (
            <li className="session-palette__empty" aria-hidden="true">
              {query.trim().length === 0
                ? "No sessions found."
                : `No sessions match "${query.trim()}".`}
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
