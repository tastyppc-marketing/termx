/**
 * Output pane (spec P4): the deliverables a session explicitly registered —
 * never mined from file extensions, never guessed.
 *
 * Two sources, one list: the JSONL sidecar (history, injected as
 * `listOutputs(sessionKey)`) merged with this run's live OSC registrations
 * (`live`, from `OutputsStore.snapshotFor`), deduped by path, newest first.
 *
 * Render-and-fire only: every side effect (open, dismiss, close) is an
 * injected callback, and placement/geometry belongs to whoever mounts this —
 * the pane simply fills its container.
 */

import { useEffect, useRef, useState } from "react";
import { splitForDisplay } from "../folders/fuzzyScore";
import { relativeTime } from "../conversations/folderOps";
import type { OutputEntry } from "../conversations/types";
import "./OutputPane.css";

export interface LiveOutputRow {
  readonly path: string;
  readonly atMs: number;
}

export interface OutputRow {
  path: string;
  atMs: number;
  label: string | null;
  exists: boolean;
}

export interface OutputPaneProps {
  /** Active termx session, for header context. Null = no session focused. */
  sessionId: number | null;
  /** Conversation key (`claude:<id>`) whose sidecar history to show; null = live only. */
  sessionKey: string | null;
  /** This run's live registrations for the active session. */
  live: readonly LiveOutputRow[];
  /** Injected `list_session_outputs`. Absent = live registrations only. */
  listOutputs?(key: string): Promise<OutputEntry[]>;
  /** Row click. */
  onOpenFile?(path: string): void;
  /** ✕ on a row: the row goes immediately, the tombstone is written behind it. */
  onDismiss?(key: string, path: string): Promise<boolean> | void;
  onClose(): void;
  /** Injected clock for the relative times; tests pass a fixed value. */
  nowMs?: number;
}

/**
 * Sidecar history + live registrations into one display list: one row per
 * path carrying the NEWEST timestamp seen for it, dismissed paths removed,
 * newest first.
 */
export function mergeOutputRows(
  sidecar: readonly OutputEntry[],
  live: readonly LiveOutputRow[],
  dismissed: ReadonlySet<string>,
): OutputRow[] {
  const rows = new Map<string, OutputRow>();
  for (const entry of sidecar) {
    if (entry.path.length === 0) {
      continue;
    }
    const existing = rows.get(entry.path);
    rows.set(entry.path, {
      path: entry.path,
      atMs: existing && existing.atMs > entry.atMs ? existing.atMs : entry.atMs,
      label: entry.label ?? existing?.label ?? null,
      exists: entry.exists,
    });
  }
  for (const entry of live) {
    if (entry.path.length === 0) {
      continue;
    }
    const existing = rows.get(entry.path);
    rows.set(entry.path, {
      path: entry.path,
      atMs: existing && existing.atMs > entry.atMs ? existing.atMs : entry.atMs,
      label: existing?.label ?? null,
      // A live registration was just written by the emitter; absent sidecar
      // knowledge, assume it is there.
      exists: existing?.exists ?? true,
    });
  }
  return [...rows.values()]
    .filter((row) => !dismissed.has(row.path))
    .sort((left, right) => right.atMs - left.atMs);
}

export function OutputPane({
  sessionId,
  sessionKey,
  live,
  listOutputs,
  onOpenFile,
  onDismiss,
  onClose,
  nowMs,
}: OutputPaneProps) {
  const [sidecar, setSidecar] = useState<readonly OutputEntry[]>([]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  // Held in a ref: an inline lister from the caller must not re-run the fetch
  // on every render. The session key is the only thing that invalidates it.
  const listRef = useRef(listOutputs);
  listRef.current = listOutputs;

  useEffect(() => {
    setDismissed(new Set());
    setSidecar([]);
    const list = listRef.current;
    if (sessionKey === null || list === undefined) {
      return;
    }
    let cancelled = false;
    void list(sessionKey).then(
      (entries) => {
        if (!cancelled) {
          setSidecar(entries);
        }
      },
      () => {
        // The wrapper never rejects by contract; a custom lister that does
        // degrades to "live only" rather than breaking the render.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  const rows = mergeOutputRows(sidecar, live, dismissed);
  const now = nowMs ?? Date.now();

  const handleDismiss = (path: string) => {
    setDismissed((previous) => {
      const next = new Set(previous);
      next.add(path);
      return next;
    });
    if (sessionKey === null || onDismiss === undefined) {
      return;
    }
    void Promise.resolve(onDismiss(sessionKey, path)).catch(() => undefined);
  };

  return (
    <section
      className="output-pane"
      aria-label="Outputs"
      data-session-id={sessionId ?? undefined}
      data-session-key={sessionKey ?? undefined}
    >
      <header className="output-pane__header">
        <span className="output-pane__title">Outputs</span>
        {sessionKey !== null ? (
          <span className="output-pane__context" title={sessionKey}>
            {sessionKey}
          </span>
        ) : null}
        <button
          type="button"
          className="output-pane__action output-pane__action--close"
          aria-label="Close outputs"
          title="Close"
          onClick={onClose}
        >
          ✕
        </button>
      </header>

      <div className="output-pane__body">
        {rows.length === 0 ? (
          <p className="output-pane__hint">
            No outputs yet — sessions register files here via{" "}
            <code>termx-output</code>.
          </p>
        ) : (
          <ul className="output-pane__list">
            {rows.map((row) => {
              const { parent, leaf } = splitForDisplay(row.path);
              return (
                <li
                  key={row.path}
                  className={`output-pane__row${
                    row.exists ? "" : " output-pane__row--missing"
                  }`}
                  data-path={row.path}
                  data-exists={row.exists}
                >
                  <span
                    className="output-pane__path"
                    role="button"
                    tabIndex={0}
                    title={row.label ?? row.path}
                    onClick={() => onOpenFile?.(row.path)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpenFile?.(row.path);
                      }
                    }}
                  >
                    {parent ? (
                      <span className="output-pane__parent">{parent}</span>
                    ) : null}
                    <span className="output-pane__leaf">{leaf}</span>
                  </span>
                  <span className="output-pane__time">
                    {relativeTime(row.atMs, now)}
                  </span>
                  <button
                    type="button"
                    className="output-pane__dismiss"
                    aria-label={`Dismiss ${leaf}`}
                    title="Remove from this list (the file is left alone)"
                    onClick={() => handleDismiss(row.path)}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
