/**
 * Conversations rail (spec §3): provider chips, debounced search, folder tree
 * with Unfiled, session rows honouring the §6 display settings, a footer with
 * the session count / refresh stamp, and the detail pane for the selection.
 *
 * All state lives in the injected `ConversationsStore`; this component only
 * renders it and fires callbacks. Nothing scans until the rail is mounted —
 * the first render triggers exactly one incremental refresh.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { SummaryContent, TermxSettings } from "../settings/settings";
import { ContextMenu, type MenuPoint } from "../sidebar/ContextMenu";
import { InlineRename } from "../sidebar/InlineRename";
import { DetailPane } from "./DetailPane";
import {
  filterRecords,
  folderIdFor,
  groupSessions,
  relativeTime,
  shortenCwd,
} from "./folderOps";
import { findRecord, type ConversationsStore } from "./store";
import {
  hasTranscript,
  sessionKey,
  EMPTY_NOTE,
  type LlmProvider,
  type LlmSessionRecord,
  type SessionKey,
  type SessionNote,
} from "./types";
import "./ConversationsRail.css";

export interface ConversationsRailProps {
  store: ConversationsStore;
  settings: TermxSettings;
  onResume(record: LlmSessionRecord): void;
  onOpenTranscript(record: LlmSessionRecord): void;
  /** Search debounce; tests pass 0. */
  debounceMs?: number;
  /** Injected clock for relative times; tests pass a fixed value. */
  nowMs?: number;
}

type ProviderFilter = "all" | LlmProvider;

const PROVIDER_FILTERS: { id: ProviderFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
];

type RailMenu =
  | { kind: "session"; key: SessionKey; point: MenuPoint }
  | { kind: "folder"; id: string; point: MenuPoint };

/** Which note kinds a row may show, per `summaryContent` (§6). */
export function visibleNote(note: SessionNote, content: SummaryContent): SessionNote {
  if (content === "none") {
    return EMPTY_NOTE;
  }
  return {
    summary: content === "recap" ? null : note.summary,
    recap: content === "summary" ? null : note.recap,
  };
}

export function ConversationsRail({
  store,
  settings,
  onResume,
  onOpenTranscript,
  debounceMs = 120,
  nowMs,
}: ConversationsRailProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [provider, setProvider] = useState<ProviderFilter>("all");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [menu, setMenu] = useState<RailMenu | null>(null);
  const [menuPanel, setMenuPanel] = useState<"root" | "move">("root");
  const rowRefs = useRef(new Map<SessionKey, HTMLDivElement>());
  const startedRef = useRef(false);

  const now = nowMs ?? Date.now();

  useEffect(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;
    if (snapshot.refreshedAtMs === null && !snapshot.refreshing) {
      void store.refresh(false);
    }
  }, [snapshot.refreshedAtMs, snapshot.refreshing, store]);

  useEffect(() => {
    if (debounceMs <= 0) {
      setAppliedQuery(query);
      return;
    }
    const timer = setTimeout(() => setAppliedQuery(query), debounceMs);
    return () => clearTimeout(timer);
  }, [query, debounceMs]);

  const noteFor = useMemo(
    () =>
      (record: LlmSessionRecord): SessionNote =>
        hasTranscript(record) ? store.noteFor(record, settings) : EMPTY_NOTE,
    [store, settings],
  );

  const filtered = useMemo(
    () => filterRecords(snapshot.records, { provider, query: appliedQuery, noteFor }),
    [snapshot.records, provider, appliedQuery, noteFor],
  );
  const sections = useMemo(
    () => groupSessions(filtered, snapshot.data),
    [filtered, snapshot.data],
  );
  const visibleKeys = useMemo(
    () =>
      sections.flatMap((section) => section.records.map((record) => sessionKey(record))),
    [sections],
  );

  const selected = findRecord(snapshot.records, snapshot.selectedKey);
  const closeMenu = () => {
    setMenu(null);
    setMenuPanel("root");
  };

  const focusRow = (key: SessionKey) => {
    store.select(key);
    rowRefs.current.get(key)?.focus();
  };

  const handleRowKey = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    record: LlmSessionRecord,
  ) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    const key = sessionKey(record);
    const index = visibleKeys.indexOf(key);
    if (event.key === "ArrowDown" && index >= 0 && index < visibleKeys.length - 1) {
      event.preventDefault();
      focusRow(visibleKeys[index + 1]!);
    } else if (event.key === "ArrowUp" && index > 0) {
      event.preventDefault();
      focusRow(visibleKeys[index - 1]!);
    } else if (event.key === "Enter") {
      event.preventDefault();
      store.select(key);
      onResume(record);
    }
  };

  const renderRow = (record: LlmSessionRecord) => {
    const key = sessionKey(record);
    const isSelected = key === snapshot.selectedKey;
    const note = visibleNote(noteFor(record), settings.summaryContent);
    const noteText = [note.summary, note.recap]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("\n");
    const hover = settings.summaryDisplay === "hover" && noteText.length > 0;
    const underTitle = settings.summaryDisplay === "under-title";

    return (
      <div
        key={key}
        ref={(node) => {
          if (node) rowRefs.current.set(key, node);
          else rowRefs.current.delete(key);
        }}
        className={`conversation-row${isSelected ? " conversation-row--selected" : ""}`}
        role="option"
        aria-selected={isSelected}
        // Roving tab stop: the selection, or the first row when nothing is
        // selected, so the list is always reachable from the keyboard.
        tabIndex={
          isSelected || (snapshot.selectedKey === null && key === visibleKeys[0])
            ? 0
            : -1
        }
        data-session-key={key}
        data-provider={record.provider}
        {...(hover ? { title: noteText } : {})}
        onClick={() => store.select(key)}
        onDoubleClick={(event) => {
          event.preventDefault();
          store.select(key);
          onResume(record);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          store.select(key);
          setMenuPanel("root");
          setMenu({
            kind: "session",
            key,
            point: { x: event.clientX, y: event.clientY },
          });
        }}
        onKeyDown={(event) => handleRowKey(event, record)}
      >
        <span className="conversation-row__badge" aria-label={`${record.provider} session`}>
          {record.provider === "claude" ? "C" : "X"}
        </span>
        <span className="conversation-row__content">
          <span className="conversation-row__line">
            <span className="conversation-row__title" title={record.title}>
              {record.title}
            </span>
            <span className="conversation-row__time">
              {relativeTime(record.updatedAtMs, now)}
            </span>
          </span>
          <span className="conversation-row__cwd" title={record.cwd ?? undefined}>
            {shortenCwd(record.cwd)}
          </span>
          {underTitle && note.summary ? (
            <span className="conversation-row__summary">{note.summary}</span>
          ) : null}
          {underTitle && note.recap ? (
            <span className="conversation-row__recap">{note.recap}</span>
          ) : null}
        </span>
        {isSelected ? (
          <button
            type="button"
            className="conversation-row__resume"
            aria-label={`Resume ${record.title}`}
            onClick={(event) => {
              event.stopPropagation();
              onResume(record);
            }}
          >
            Resume
          </button>
        ) : null}
      </div>
    );
  };

  const renderedMenu = (() => {
    if (!menu) {
      return null;
    }
    if (menu.kind === "folder") {
      const folder = snapshot.data.folders.find((entry) => entry.id === menu.id);
      if (!folder) {
        return null;
      }
      return (
        <ContextMenu
          label={`Actions for ${folder.name}`}
          point={menu.point}
          onClose={closeMenu}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              setRenamingFolderId(folder.id);
            }}
          >
            Rename folder
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu__danger"
            onClick={() => {
              closeMenu();
              store.deleteFolder(folder.id);
            }}
          >
            Delete folder
          </button>
        </ContextMenu>
      );
    }

    const record = findRecord(snapshot.records, menu.key);
    if (!record) {
      return null;
    }
    const currentFolder = folderIdFor(snapshot.data, menu.key);
    if (menuPanel === "move") {
      return (
        <ContextMenu label={`Move ${record.title}`} point={menu.point} onClose={closeMenu}>
          <button type="button" role="menuitem" onClick={() => setMenuPanel("root")}>
            ← Back
          </button>
          {snapshot.data.folders
            .filter((folder) => folder.id !== currentFolder)
            .map((folder) => (
              <button
                type="button"
                role="menuitem"
                key={folder.id}
                onClick={() => {
                  store.assign(menu.key, folder.id);
                  closeMenu();
                }}
              >
                {folder.name}
              </button>
            ))}
        </ContextMenu>
      );
    }
    return (
      <ContextMenu
        label={`Actions for ${record.title}`}
        point={menu.point}
        onClose={closeMenu}
      >
        <button
          type="button"
          role="menuitem"
          disabled={snapshot.data.folders.length === 0}
          onClick={() => setMenuPanel("move")}
        >
          Move to folder
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={currentFolder === null}
          onClick={() => {
            store.assign(menu.key, null);
            closeMenu();
          }}
        >
          Remove from folder
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            closeMenu();
            onResume(record);
          }}
        >
          Resume
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!hasTranscript(record)}
          onClick={() => {
            closeMenu();
            onOpenTranscript(record);
          }}
        >
          Open transcript
        </button>
      </ContextMenu>
    );
  })();

  return (
    <div
      className="conversations"
      aria-label="Conversations"
      onContextMenu={(event) => {
        // Rows and folder headers handle their own menus (and stop here); a
        // right-click on rail whitespace must not fall through to the
        // sidebar's terminal menu.
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="conversations__filters" role="group" aria-label="Provider filter">
        {PROVIDER_FILTERS.map((filter) => (
          <button
            type="button"
            key={filter.id}
            className={`conversations__chip${
              provider === filter.id ? " conversations__chip--active" : ""
            }`}
            aria-pressed={provider === filter.id}
            onClick={() => setProvider(filter.id)}
          >
            {filter.label}
          </button>
        ))}
        <button
          type="button"
          className="conversations__new-folder"
          aria-label="New folder"
          title="New folder"
          onClick={() => setCreatingFolder(true)}
        >
          ＋
        </button>
      </div>

      <input
        className="conversations__search"
        type="search"
        aria-label="Search conversations"
        placeholder="Search title, folder, summary…"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />

      {creatingFolder ? (
        <div className="conversations__new-folder-row">
          <InlineRename
            value="New folder"
            ariaLabel="Name new folder"
            onCommit={(name) => {
              store.createFolder(name);
              setCreatingFolder(false);
            }}
            onCancel={() => setCreatingFolder(false)}
          />
        </div>
      ) : null}

      <div className="conversations__scroll">
        {visibleKeys.length === 0 && snapshot.data.folders.length === 0 ? (
          <p className="conversations__empty">
            {snapshot.refreshing ? "Scanning sessions…" : "No conversations found."}
          </p>
        ) : null}
        {sections.map((section) =>
          section.id === null && section.records.length === 0 ? null : (
            <section
              className="conversations__folder"
              key={section.id ?? "__unfiled"}
              data-folder-id={section.id ?? ""}
            >
              <header
                className="conversations__folder-header"
                onContextMenu={(event) => {
                  if (section.id === null) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  setMenuPanel("root");
                  setMenu({
                    kind: "folder",
                    id: section.id,
                    point: { x: event.clientX, y: event.clientY },
                  });
                }}
              >
                <span className="conversations__folder-name">
                  {section.id !== null && renamingFolderId === section.id ? (
                    <InlineRename
                      value={section.name}
                      ariaLabel={`Rename ${section.name}`}
                      onCommit={(name) => {
                        store.renameFolder(section.id!, name);
                        setRenamingFolderId(null);
                      }}
                      onCancel={() => setRenamingFolderId(null)}
                    />
                  ) : (
                    section.name
                  )}
                </span>
                <span className="conversations__folder-count">
                  {section.records.length}
                </span>
                {section.id !== null ? (
                  <button
                    type="button"
                    className="conversations__folder-menu"
                    aria-label={`Folder actions for ${section.name}`}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setMenuPanel("root");
                      setMenu({
                        kind: "folder",
                        id: section.id!,
                        point: { x: rect.right, y: rect.bottom },
                      });
                    }}
                  >
                    ⋯
                  </button>
                ) : null}
              </header>
              <div
                className="conversations__rows"
                role="listbox"
                aria-label={`${section.name} conversations`}
              >
                {section.records.map(renderRow)}
              </div>
            </section>
          ),
        )}
      </div>

      <div className="conversations__footer">
        <span className="conversations__count" role="status">
          {`${filtered.length} session${filtered.length === 1 ? "" : "s"} · refreshed ${
            snapshot.refreshedAtMs === null
              ? "never"
              : relativeTime(snapshot.refreshedAtMs, now)
          }`}
        </span>
        <button
          type="button"
          className="conversations__refresh"
          aria-label="Refresh sessions"
          title="Rescan sessions"
          disabled={snapshot.refreshing}
          onClick={() => void store.refresh(true)}
        >
          ⟳
        </button>
      </div>

      {selected ? (
        <DetailPane
          record={selected}
          note={noteFor(selected)}
          onResume={onResume}
          onOpenTranscript={onOpenTranscript}
          nowMs={now}
        />
      ) : null}

      {renderedMenu}
    </div>
  );
}
