import { useEffect, useMemo, useRef, useState } from "react";
import {
  isPathLikeQuery,
  mergeFolderResults,
  splitForDisplay,
  type FolderRow,
} from "./fuzzyScore";
import type { ListDirs } from "../native/folders";
import "./FolderSearch.css";

export interface FolderSearchProps {
  recents: readonly string[];
  listDirs: ListDirs;
  /** Open a terminal in this folder. */
  onPick(path: string): void;
  /** Fall back to the native OS folder dialog. */
  onBrowse(): void;
  onClose(): void;
  /** Completion debounce; tests pass 0. */
  debounceMs?: number;
}

/**
 * Warp-style folder searcher: recents + live path completion, keyboard-first,
 * with the native dialog one row away ("Browse…").
 */
export function FolderSearch({
  recents,
  listDirs,
  onPick,
  onBrowse,
  onClose,
  debounceMs = 120,
}: FolderSearchProps) {
  const [query, setQuery] = useState("");
  const [completions, setCompletions] = useState<readonly string[]>([]);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    if (query.trim().length > 0 && !isPathLikeQuery(query)) {
      setCompletions([]);
      return;
    }
    const timer = setTimeout(() => {
      void listDirs(query).then((dirs) => {
        if (requestIdRef.current === requestId) {
          setCompletions(dirs);
        }
      });
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [query, listDirs, debounceMs]);

  const rows = useMemo(
    () => mergeFolderResults(query, recents, completions),
    [query, recents, completions],
  );
  // Browse… is the last, always-present row.
  const rowCount = rows.length + 1;
  const clampedHighlight = Math.min(highlight, rowCount - 1);

  const activate = (index: number) => {
    const row: FolderRow | undefined = rows[index];
    if (row) {
      onPick(row.path);
    } else {
      onBrowse();
    }
  };

  return (
    <div className="folder-search-backdrop">
      <div
        className="folder-search"
        role="dialog"
        aria-modal="true"
        aria-label="Open a folder in a new terminal"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
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
          className="folder-search__input"
          aria-label="Search folders"
          role="combobox"
          aria-expanded="true"
          aria-controls="folder-search-results"
          aria-activedescendant={`folder-option-${clampedHighlight}`}
          placeholder="Type a folder name or path…"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setHighlight(0);
          }}
        />
        <ul
          className="folder-search__results"
          id="folder-search-results"
          role="listbox"
          aria-label="Folders"
        >
          {rows.map((row, index) => {
            const { parent, leaf } = splitForDisplay(row.path);
            return (
              <li
                key={row.path}
                id={`folder-option-${index}`}
                role="option"
                aria-selected={index === clampedHighlight}
                className={`folder-search__row${
                  index === clampedHighlight ? " folder-search__row--active" : ""
                }`}
                onPointerEnter={() => setHighlight(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => activate(index)}
              >
                <span className="folder-search__kind" aria-hidden="true">
                  {row.kind === "recent" ? "↺" : "▸"}
                </span>
                <span className="folder-search__path">
                  {parent ? (
                    <span className="folder-search__parent">{parent}</span>
                  ) : null}
                  <span className="folder-search__leaf">{leaf}</span>
                </span>
                {row.kind === "recent" ? (
                  <span className="folder-search__tag">recent</span>
                ) : null}
              </li>
            );
          })}
          <li
            key="__browse"
            id={`folder-option-${rows.length}`}
            role="option"
            aria-selected={clampedHighlight === rows.length}
            className={`folder-search__row folder-search__row--browse${
              clampedHighlight === rows.length ? " folder-search__row--active" : ""
            }`}
            onPointerEnter={() => setHighlight(rows.length)}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onBrowse()}
          >
            <span className="folder-search__kind" aria-hidden="true">…</span>
            <span className="folder-search__path">Browse…</span>
            <span className="folder-search__tag">system dialog</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
