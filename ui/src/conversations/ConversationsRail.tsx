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
import type { ArtifactLister } from "./artifacts";
import { DetailPane } from "./DetailPane";
import {
  effectiveTitle,
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
  type GeneratedNote,
  type LlmProvider,
  type LlmSessionRecord,
  type OutputEntry,
  type SessionKey,
  type SessionNote,
} from "./types";
import "./ConversationsRail.css";

export interface ConversationsRailProps {
  store: ConversationsStore;
  settings: TermxSettings;
  onResume(record: LlmSessionRecord): void;
  onOpenTranscript(record: LlmSessionRecord): void;
  /**
   * Saved sessions: pin this conversation (folder + conversation ref) for later
   * resume. Absent hides the row action entirely, which is how the
   * `savedConversationsRail` setting turns the surface off.
   */
  onSaveConversation?(record: LlmSessionRecord): void;
  /** Injected `list_session_artifacts` for the detail pane (§11); absent = static hint. */
  listArtifacts?: ArtifactLister;
  /** Detail-pane file row click (§11). */
  onOpenFile?(path: string): void;
  /** Detail-pane "Open folder in new tab" (§11); receives the parent dir. */
  onOpenFolder?(parentDir: string): void;
  /** Injected `list_session_outputs` for the detail pane (P4); absent hides Outputs. */
  listOutputs?(key: SessionKey): Promise<readonly OutputEntry[]>;
  /** Injected `dismiss_session_output` for the detail pane (P4). */
  dismissOutput?(key: SessionKey, path: string): Promise<unknown>;
  /**
   * Reports the session keys currently on screen after each list change —
   * the NoteScheduler's visibility feed (§6). Fired from an effect, never
   * during render.
   */
  onVisibleRecords?(keys: readonly SessionKey[]): void;
  /** Search debounce; tests pass 0. */
  debounceMs?: number;
  /** Injected clock for relative times; tests pass a fixed value. */
  nowMs?: number;
  /**
   * Layout variant (polish P5): "sidebar" (default) is the compact rail;
   * "expanded" is the full-window two-pane layout. Purely presentational —
   * same behavior in both.
   */
  variant?: "sidebar" | "expanded";
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
  onSaveConversation,
  listArtifacts,
  onOpenFile,
  onOpenFolder,
  onVisibleRecords,
  listOutputs,
  dismissOutput,
  debounceMs = 120,
  nowMs,
  variant = "sidebar",
}: ConversationsRailProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [provider, setProvider] = useState<ProviderFilter>("all");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  /** Non-null while the inline "new folder" input is open; `assignTo` is the
   *  row waiting for it ("Move to folder ▸ New group…"), else null. */
  const [creatingFolder, setCreatingFolder] = useState<{
    assignTo: SessionKey | null;
  } | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [menu, setMenu] = useState<RailMenu | null>(null);
  const [menuPanel, setMenuPanel] = useState<"root" | "move">("root");
  /** Session key being dragged (HTML5 drag; the ref survives the event trip). */
  const dragKeyRef = useRef<SessionKey | null>(null);
  const [draggingKey, setDraggingKey] = useState<SessionKey | null>(null);
  /** Folder header currently under the pointer: `undefined` none, `null` Unfiled. */
  const [dropFolderId, setDropFolderId] = useState<string | null | undefined>(undefined);
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

  /** Cached generated note per record — the P2 title source. */
  const generatedFor = useMemo(
    () =>
      (record: LlmSessionRecord): GeneratedNote | undefined =>
        snapshot.data.generated[sessionKey(record)],
    [snapshot.data],
  );

  const filtered = useMemo(
    () =>
      filterRecords(snapshot.records, {
        provider,
        query: appliedQuery,
        noteFor,
        generatedFor,
      }),
    [snapshot.records, provider, appliedQuery, noteFor, generatedFor],
  );
  const sections = useMemo(
    () => groupSessions(filtered, snapshot.data),
    [filtered, snapshot.data],
  );
  // Rows inside a collapsed folder are not on screen: they leave the roving
  // tab order and the scheduler's visibility feed alike.
  const visibleKeys = useMemo(
    () =>
      sections
        .filter((section) => !section.collapsed)
        .flatMap((section) => section.records.map((record) => sessionKey(record))),
    [sections],
  );

  // The scheduler's visibility feed (§6): report after commit, re-firing only
  // when the actual key list changes, not on every parent render.
  const visibleKeysSignature = visibleKeys.join("\n");
  const onVisibleRecordsRef = useRef(onVisibleRecords);
  onVisibleRecordsRef.current = onVisibleRecords;
  const visibleKeysRef = useRef(visibleKeys);
  visibleKeysRef.current = visibleKeys;
  useEffect(() => {
    onVisibleRecordsRef.current?.(visibleKeysRef.current);
  }, [visibleKeysSignature]);

  const selected = findRecord(snapshot.records, snapshot.selectedKey);
  const selectedArtifacts = selected
    ? snapshot.data.artifacts?.[sessionKey(selected)]
    : undefined;
  const selectedGenerated = selected
    ? snapshot.data.generated[sessionKey(selected)]
    : undefined;
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

  /**
   * Create a folder and (for "New group…") drop the pending row into it. The
   * store owns id generation, so the new folder is spotted by diffing the
   * snapshot rather than by guessing an id.
   */
  const commitNewFolder = (name: string, assignTo: SessionKey | null) => {
    const before = new Set(store.getSnapshot().data.folders.map((folder) => folder.id));
    store.createFolder(name);
    if (assignTo === null) {
      return;
    }
    const created = store
      .getSnapshot()
      .data.folders.find((folder) => !before.has(folder.id));
    if (created) {
      store.assign(assignTo, created.id);
    }
  };

  /** HTML5 drop onto a folder header; `folderId: null` drops back to Unfiled. */
  const handleFolderDrop = (folderId: string | null) => {
    const key = dragKeyRef.current;
    dragKeyRef.current = null;
    setDraggingKey(null);
    setDropFolderId(undefined);
    if (key !== null) {
      store.assign(key, folderId);
    }
  };

  const renderRow = (record: LlmSessionRecord) => {
    const key = sessionKey(record);
    const title = effectiveTitle(record, generatedFor(record));
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
        className={`conversation-row${isSelected ? " conversation-row--selected" : ""}${
          draggingKey === key ? " conversation-row--dragging" : ""
        }`}
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
        // Drag-to-group (P7): same affordance as a sidebar tab drag — the row
        // dims while it travels and the folder header lights up as a target.
        draggable
        onDragStart={(event) => {
          dragKeyRef.current = key;
          setDraggingKey(key);
          store.select(key);
          event.dataTransfer?.setData("text/plain", key);
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
          }
        }}
        onDragEnd={() => {
          dragKeyRef.current = null;
          setDraggingKey(null);
          setDropFolderId(undefined);
        }}
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
            {/* P2: a generated name may be shown, but the tooltip keeps the
                raw record title so nothing is silently replaced. */}
            <span
              className="conversation-row__title"
              title={record.title}
              data-generated={title === record.title ? undefined : "true"}
            >
              {title}
            </span>
            <span className="conversation-row__time">
              {relativeTime(record.updatedAtMs, now)}
            </span>
          </span>
          <span className="conversation-row__cwd" title={record.cwd ?? undefined}>
            {shortenCwd(record.cwd)}
          </span>
          {underTitle && note.summary ? (
            <span className="conversation-row__summary" title={note.summary}>
              {note.summary}
            </span>
          ) : null}
          {underTitle && note.recap ? (
            <span className="conversation-row__recap">{note.recap}</span>
          ) : null}
        </span>
        {isSelected && onSaveConversation ? (
          // Same selection-gated affordance as Resume beside it. A record with
          // no recorded folder has nothing to restore, so it is offered but
          // refused rather than silently saving a folderless entry.
          <button
            type="button"
            className="conversation-row__save"
            data-testid="conversation-save"
            aria-label={`Save ${title}`}
            title={
              record.cwd === null
                ? "No folder recorded for this session"
                : "Save this session…"
            }
            disabled={record.cwd === null}
            onClick={(event) => {
              event.stopPropagation();
              onSaveConversation(record);
            }}
          >
            Save
          </button>
        ) : null}
        {isSelected ? (
          <button
            type="button"
            className="conversation-row__resume"
            aria-label={`Resume ${title}`}
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
    const menuTitle = effectiveTitle(record, generatedFor(record));
    if (menuPanel === "move") {
      return (
        <ContextMenu label={`Move ${menuTitle}`} point={menu.point} onClose={closeMenu}>
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
          {/* Tab-group parity (P7): name a new group and land in it. */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const key = menu.key;
              closeMenu();
              setCreatingFolder({ assignTo: key });
            }}
          >
            New group…
          </button>
        </ContextMenu>
      );
    }
    return (
      <ContextMenu
        label={`Actions for ${menuTitle}`}
        point={menu.point}
        onClose={closeMenu}
      >
        <button type="button" role="menuitem" onClick={() => setMenuPanel("move")}>
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
      className={`conversations${variant === "expanded" ? " conversations--expanded" : ""}`}
      aria-label="Conversations"
      onContextMenu={(event) => {
        // Rows and folder headers handle their own menus (and stop here); a
        // right-click on rail whitespace must not fall through to the
        // sidebar's terminal menu.
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {/* The list column: in the sidebar it is the whole rail; under
          `variant="expanded"` it becomes the left pane with the detail
          pane beside it (CSS only — the tree below is identical). */}
      <div className="conversations__list">
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
            onClick={() => setCreatingFolder({ assignTo: null })}
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
              value={creatingFolder.assignTo === null ? "New folder" : "New group"}
              ariaLabel="Name new folder"
              onCommit={(name) => {
                commitNewFolder(name, creatingFolder.assignTo);
                setCreatingFolder(null);
              }}
              onCancel={() => setCreatingFolder(null)}
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
                data-collapsed={section.collapsed ? "true" : undefined}
              >
                <header
                  className={`conversations__folder-header${
                    dropFolderId !== undefined && dropFolderId === section.id
                      ? " conversations__folder-header--drop-target"
                      : ""
                  }`}
                  // Drop target for row drags (P7). Unfiled (`id: null`)
                  // un-groups whatever lands on it.
                  onDragOver={(event) => {
                    if (dragKeyRef.current === null) {
                      return;
                    }
                    event.preventDefault();
                    if (event.dataTransfer) {
                      event.dataTransfer.dropEffect = "move";
                    }
                    setDropFolderId(section.id);
                  }}
                  onDragLeave={() => setDropFolderId(undefined)}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    handleFolderDrop(section.id);
                  }}
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
                  {section.id !== null ? (
                    <button
                      type="button"
                      className="conversations__folder-chevron"
                      aria-label={`${section.collapsed ? "Expand" : "Collapse"} ${
                        section.name
                      }`}
                      aria-expanded={!section.collapsed}
                      onClick={() =>
                        store.updateFolder(section.id!, { collapsed: !section.collapsed })
                      }
                    >
                      <span aria-hidden="true">{section.collapsed ? "▸" : "▾"}</span>
                    </button>
                  ) : null}
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
                {section.collapsed ? null : (
                  <div
                    className="conversations__rows"
                    role="listbox"
                    aria-label={`${section.name} conversations`}
                  >
                    {section.records.map(renderRow)}
                  </div>
                )}
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
      </div>

      {selected ? (
        <DetailPane
          record={selected}
          note={noteFor(selected)}
          onResume={onResume}
          onOpenTranscript={onOpenTranscript}
          nowMs={now}
          {...(selectedArtifacts ? { artifacts: selectedArtifacts } : {})}
          onArtifactsFetched={store.setArtifacts}
          {...(listArtifacts ? { listArtifacts } : {})}
          {...(onOpenFile ? { onOpenFile } : {})}
          {...(onOpenFolder ? { onOpenFolder } : {})}
          {...(selectedGenerated ? { generated: selectedGenerated } : {})}
          {...(listOutputs ? { listOutputs } : {})}
          {...(dismissOutput ? { dismissOutput } : {})}
        />
      ) : null}

      {renderedMenu}
    </div>
  );
}
