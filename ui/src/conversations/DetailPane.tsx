/**
 * Detail pane for the selected conversation (spec §3): title, full cwd,
 * provider, last-active time, both note kinds (whatever exists, regardless of
 * the row display setting), Resume, Open transcript, and the Files-touched
 * section (§11) — a collapsed disclosure that lazily fetches the injected
 * `listArtifacts(filePath)` on first expand and caches the result through the
 * `artifacts` / `onArtifactsFetched` props (the caller owns persisting that
 * into `ConversationsStore.setArtifacts`).
 *
 * Render-and-fire only: side-effecting callbacks (Resume, Open transcript,
 * Open file, Open folder, the artifacts IO) all come from the caller. Local
 * `useState` is limited to the disclosure's own expand/collapse and in-flight
 * fetch bookkeeping.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { splitForDisplay } from "../folders/fuzzyScore";
import { ContextMenu, type MenuPoint } from "../sidebar/ContextMenu";
import {
  groupArtifacts,
  needsFetch,
  parentDirOf,
  type ArtifactLister,
} from "./artifacts";
import { relativeTime } from "./folderOps";
import {
  hasTranscript,
  sessionKey,
  type LlmSessionRecord,
  type SessionArtifactFile,
  type SessionArtifacts,
  type SessionKey,
  type SessionNote,
} from "./types";
import "./DetailPane.css";

export interface DetailPaneProps {
  record: LlmSessionRecord;
  note: SessionNote;
  onResume(record: LlmSessionRecord): void;
  onOpenTranscript(record: LlmSessionRecord): void;
  /** Files-touched content (§11), pre-rendered by the caller. Takes priority over the built-in artifacts UI. */
  filesSlot?: ReactNode;
  /** Injected clock for the relative time; tests pass a fixed value. */
  nowMs?: number;

  /** Injected `list_session_artifacts` IO (§11). Absent falls back to a static "not harvested" hint. */
  listArtifacts?: ArtifactLister;
  /** Cached harvest for this record, read from the store by the caller. */
  artifacts?: SessionArtifacts;
  /** Fires after a fresh fetch so the caller can persist it (`ConversationsStore.setArtifacts`). */
  onArtifactsFetched?(key: SessionKey, artifacts: SessionArtifacts): void;
  /** Row click. */
  onOpenFile?(path: string): void;
  /** "Open folder in new tab" context-menu action; already resolved to the parent directory. */
  onOpenFolder?(parentDir: string): void;
}

export function DetailPane({
  record,
  note,
  onResume,
  onOpenTranscript,
  filesSlot,
  nowMs,
  listArtifacts,
  artifacts,
  onArtifactsFetched,
  onOpenFile,
  onOpenFolder,
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
        {filesSlot ? (
          <>
            <h3>Files touched</h3>
            {filesSlot}
          </>
        ) : !transcript ? (
          <>
            <h3>Files touched</h3>
            <p className="conversation-detail__hint">
              Unavailable — this session has no transcript file.
            </p>
          </>
        ) : !listArtifacts ? (
          <>
            <h3>Files touched</h3>
            <p className="conversation-detail__hint">Not harvested yet.</p>
          </>
        ) : (
          <FilesTouchedSection
            key={sessionKey(record)}
            record={record}
            listArtifacts={listArtifacts}
            artifacts={artifacts}
            {...(onArtifactsFetched ? { onArtifactsFetched } : {})}
            {...(onOpenFile ? { onOpenFile } : {})}
            {...(onOpenFolder ? { onOpenFolder } : {})}
          />
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

interface FilesTouchedSectionProps {
  record: LlmSessionRecord;
  listArtifacts: ArtifactLister;
  artifacts: SessionArtifacts | undefined;
  onArtifactsFetched?(key: SessionKey, artifacts: SessionArtifacts): void;
  onOpenFile?(path: string): void;
  onOpenFolder?(parentDir: string): void;
}

interface FileMenuState {
  path: string;
  point: MenuPoint;
}

/**
 * The live "Files touched" disclosure for one record. Keyed by `sessionKey`
 * in the parent so switching the selection remounts (and resets) it rather
 * than leaking one session's fetch state into another's.
 */
function FilesTouchedSection({
  record,
  listArtifacts,
  artifacts,
  onArtifactsFetched,
  onOpenFile,
  onOpenFolder,
}: FilesTouchedSectionProps) {
  const fresh = artifacts !== undefined && !needsFetch(artifacts, record);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fetchedFiles, setFetchedFiles] = useState<SessionArtifactFile[] | null>(null);
  /** `record.updatedAtMs` at fetch start — a newer record makes a re-expand refetch. */
  const [fetchedAtMs, setFetchedAtMs] = useState<number | null>(null);
  const [menu, setMenu] = useState<FileMenuState | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const files = fetchedFiles ?? (fresh ? artifacts.files : null);

  const handleToggle = () => {
    const next = !expanded;
    setExpanded(next);
    const stale = fetchedAtMs !== null && record.updatedAtMs > fetchedAtMs;
    if (next && !loading && (files === null || stale)) {
      setFetchedAtMs(record.updatedAtMs);
      setLoading(true);
      void listArtifacts(record.filePath).then((result) => {
        onArtifactsFetched?.(sessionKey(record), {
          sourceMtimeMs: record.updatedAtMs,
          files: result,
        });
        if (!cancelledRef.current) {
          setFetchedFiles(result);
          setLoading(false);
        }
      });
    }
  };

  const openMenu = (path: string, point: MenuPoint) => setMenu({ path, point });
  const closeMenu = () => setMenu(null);

  return (
    <>
      <button
        type="button"
        className="conversation-detail__files-toggle"
        aria-expanded={expanded}
        onClick={handleToggle}
      >
        <span className="conversation-detail__files-chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        Files touched
      </button>
      {expanded ? (
        loading ? (
          <p className="conversation-detail__hint">Loading…</p>
        ) : files === null || files.length === 0 ? (
          <p className="conversation-detail__hint">No files recorded</p>
        ) : (
          <ArtifactGroups files={files} onOpenFile={onOpenFile} onOpenMenu={openMenu} />
        )
      ) : null}
      {menu ? (
        <ContextMenu label="File actions" point={menu.point} onClose={closeMenu}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const path = menu.path;
              closeMenu();
              onOpenFolder?.(parentDirOf(path));
            }}
          >
            Open folder in new tab
          </button>
        </ContextMenu>
      ) : null}
    </>
  );
}

function ArtifactGroups({
  files,
  onOpenFile,
  onOpenMenu,
}: {
  files: readonly SessionArtifactFile[];
  onOpenFile?(path: string): void;
  onOpenMenu(path: string, point: MenuPoint): void;
}) {
  const { created, edited } = groupArtifacts(files);
  return (
    <>
      {created.length > 0 ? (
        <ArtifactGroup
          label="Created"
          files={created}
          onOpenFile={onOpenFile}
          onOpenMenu={onOpenMenu}
        />
      ) : null}
      {edited.length > 0 ? (
        <ArtifactGroup
          label="Edited"
          files={edited}
          onOpenFile={onOpenFile}
          onOpenMenu={onOpenMenu}
        />
      ) : null}
    </>
  );
}

function ArtifactGroup({
  label,
  files,
  onOpenFile,
  onOpenMenu,
}: {
  label: string;
  files: readonly SessionArtifactFile[];
  onOpenFile?(path: string): void;
  onOpenMenu(path: string, point: MenuPoint): void;
}) {
  return (
    <div className="conversation-detail__file-group">
      <h4>{label}</h4>
      <ul className="conversation-detail__file-list">
        {files.map((file) => {
          const { parent, leaf } = splitForDisplay(file.path);
          return (
            <li
              key={file.path}
              className={`conversation-detail__file-row${
                file.exists ? "" : " conversation-detail__file-row--missing"
              }`}
              data-path={file.path}
              data-exists={file.exists}
              title={file.path}
              role="button"
              tabIndex={0}
              onClick={() => onOpenFile?.(file.path)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpenFile?.(file.path);
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenMenu(file.path, { x: event.clientX, y: event.clientY });
              }}
            >
              {parent ? (
                <span className="conversation-detail__file-parent">{parent}</span>
              ) : null}
              <span className="conversation-detail__file-leaf">{leaf}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
