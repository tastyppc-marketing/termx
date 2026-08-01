/**
 * Detail pane for the selected conversation (spec §3): title, full cwd,
 * provider, last-active time, both note kinds (whatever exists, regardless of
 * the row display setting), Resume, Open transcript, and the Files-touched
 * section — a slot the artifacts pass (§11) fills in.
 *
 * Render-and-fire only: the callbacks come from the App.
 */

import type { ReactNode } from "react";
import { relativeTime } from "./folderOps";
import { hasTranscript, type LlmSessionRecord, type SessionNote } from "./types";
import "./DetailPane.css";

export interface DetailPaneProps {
  record: LlmSessionRecord;
  note: SessionNote;
  onResume(record: LlmSessionRecord): void;
  onOpenTranscript(record: LlmSessionRecord): void;
  /** Files-touched content (§11). Absent renders the "not harvested" hint. */
  filesSlot?: ReactNode;
  /** Injected clock for the relative time; tests pass a fixed value. */
  nowMs?: number;
}

export function DetailPane({
  record,
  note,
  onResume,
  onOpenTranscript,
  filesSlot,
  nowMs,
}: DetailPaneProps) {
  const transcript = hasTranscript(record);
  const now = nowMs ?? Date.now();

  return (
    <section className="conversation-detail" aria-label="Conversation details">
      <header className="conversation-detail__header">
        <span
          className="conversation-detail__provider"
          data-provider={record.provider}
        >
          {record.provider}
        </span>
        <h2 className="conversation-detail__title" title={record.title}>
          {record.title}
        </h2>
      </header>

      <dl className="conversation-detail__fields">
        <dt>Folder</dt>
        <dd className="conversation-detail__cwd" title={record.cwd ?? undefined}>
          {record.cwd ?? "Unknown"}
        </dd>
        <dt>Last active</dt>
        <dd title={new Date(record.updatedAtMs).toISOString()}>
          {relativeTime(record.updatedAtMs, now)}
        </dd>
      </dl>

      {note.summary ? (
        <p className="conversation-detail__summary">{note.summary}</p>
      ) : null}
      {note.recap ? (
        <p className="conversation-detail__recap">{note.recap}</p>
      ) : null}

      <section
        className="conversation-detail__files"
        aria-label="Files touched"
        data-slot="files-touched"
      >
        <h3>Files touched</h3>
        {filesSlot ?? (
          <p className="conversation-detail__hint">
            {transcript
              ? "Not harvested yet."
              : "Unavailable — this session has no transcript file."}
          </p>
        )}
      </section>

      <div className="conversation-detail__actions">
        <button
          type="button"
          className="conversation-detail__resume"
          onClick={() => onResume(record)}
        >
          Resume
        </button>
        <button
          type="button"
          className="conversation-detail__transcript"
          disabled={!transcript}
          title={
            transcript
              ? record.filePath
              : "This session has no transcript file on disk"
          }
          onClick={() => onOpenTranscript(record)}
        >
          Open transcript
        </button>
      </div>
    </section>
  );
}
