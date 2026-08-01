import type { RefObject } from "react";
import type { TranscriptSearchMode } from "../../native/transcript";

export interface TranscriptSearchProps {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  mode: TranscriptSearchMode;
  matchCount: number;
  activeIndex: number;
  truncated: boolean;
  loading: boolean;
  error: string | null;
  onQueryChange(query: string): void;
  onModeChange(mode: TranscriptSearchMode): void;
  onPrevious(): void;
  onNext(): void;
  onClose(): void;
}

export function TranscriptSearch({
  inputRef,
  query,
  mode,
  matchCount,
  activeIndex,
  truncated,
  loading,
  error,
  onQueryChange,
  onModeChange,
  onPrevious,
  onNext,
  onClose,
}: TranscriptSearchProps) {
  const countLabel =
    matchCount === 0
      ? "0 matches"
      : `${activeIndex + 1} / ${matchCount}${truncated ? "+" : ""}`;

  return (
    <div className="transcript-search" role="search">
      <input
        ref={inputRef}
        className="transcript-search__input"
        aria-label="Search transcript query"
        autoComplete="off"
        spellCheck={false}
        placeholder="Find in transcript"
        value={query}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
      />
      <select
        className="transcript-search__mode"
        aria-label="Transcript search mode"
        value={mode}
        onChange={(event) =>
          onModeChange(event.currentTarget.value as TranscriptSearchMode)
        }
      >
        <option value="substring">Substring</option>
        <option value="regex">Regex</option>
        <option value="fuzzy">Fuzzy</option>
      </select>
      <button
        type="button"
        className="transcript-search__button"
        aria-label="Previous transcript match"
        disabled={matchCount === 0}
        onClick={onPrevious}
      >
        ↑
      </button>
      <button
        type="button"
        className="transcript-search__button"
        aria-label="Next transcript match"
        disabled={matchCount === 0}
        onClick={onNext}
      >
        ↓
      </button>
      <span className="transcript-search__status" role="status">
        {error ?? (loading ? "Searching…" : countLabel)}
      </span>
      <button
        type="button"
        className="transcript-search__button transcript-search__button--close"
        aria-label="Close transcript search"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
