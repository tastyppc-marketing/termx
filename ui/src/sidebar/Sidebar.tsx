import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { PALETTE_HEX, PALETTE_IDS, type PaletteId } from "../state/layout";
import type {
  SidebarGroupModel,
  SidebarTabModel,
  WorkspaceSnapshot,
} from "../workspace/WorkspaceController";
import { ContextMenu, type MenuPoint } from "./ContextMenu";
import { InlineRename } from "./InlineRename";
import {
  commitDrop,
  crossedDragThreshold,
  type DragSource,
  type DropTarget,
} from "./pointerDrag";
import "./Sidebar.css";

export interface SidebarActions {
  activateTab(tabId: string): void;
  renameTab(tabId: string, title: string | null): void;
  recolorTab(tabId: string, color: PaletteId): void;
  moveTab(tabId: string, groupId: string | null, index: number): void;
  reorderGroup(groupId: string, targetIndex: number): void;
  createGroup(name: string): void;
  renameGroup(groupId: string, name: string): void;
  toggleGroup(groupId: string): void;
  createTab(options: { groupId: string | null; profile: string | null }): Promise<void>;
  duplicateTab(tabId: string): Promise<void>;
  openFolderHere(tabId: string): Promise<void>;
  closeLiveTab(tabId: string): Promise<void>;
  closeGroup(groupId: string): Promise<void>;
  dismissDeadTab(tabId: string): Promise<void>;
}

export interface SidebarProps {
  snapshot: WorkspaceSnapshot;
  actions: SidebarActions;
  /** UI chrome, not a workspace action: opens the app settings dialog. */
  onOpenSettings?: () => void;
  /** Opens the folder-search palette targeting the given group. */
  onOpenFolderSearch?: (groupId: string | null) => void;
}

type RenameTarget =
  | { kind: "tab"; id: string }
  | { kind: "group"; id: string };

type ConfirmClose =
  | { kind: "tab"; id: string; title: string }
  | { kind: "group"; id: string; title: string };

type SidebarMenu =
  | { kind: "tab"; id: string; point: MenuPoint }
  | { kind: "group"; id: string; point: MenuPoint }
  | { kind: "background"; point: MenuPoint }
  | { kind: "create"; point: MenuPoint };

type MenuPanel = "root" | "color" | "move";

interface PointerDragState {
  pointerId: number;
  source: DragSource;
  origin: { x: number; y: number };
  current: { x: number; y: number };
  active: boolean;
  target: DropTarget | null;
  label: string;
  indicator: { left: number; top: number; width: number } | null;
}

export function Sidebar({
  snapshot,
  actions,
  onOpenSettings,
  onOpenFolderSearch,
}: SidebarProps) {
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [confirmClose, setConfirmClose] = useState<ConfirmClose | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [dismissingTabIds, setDismissingTabIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [menu, setMenu] = useState<SidebarMenu | null>(null);
  const [menuPanel, setMenuPanel] = useState<MenuPanel>("root");
  const [focusedTabId, setFocusedTabId] = useState<string | null>(snapshot.activeTabId);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const groupRefs = useRef(new Map<string, HTMLElement>());
  const restoreFocusRef = useRef<RenameTarget | null>(null);
  const dragRef = useRef<PointerDragState | null>(null);
  const [drag, setDrag] = useState<PointerDragState | null>(null);
  const suppressClickRef = useRef(false);
  const dismissingTabIdsRef = useRef(new Set<string>());
  const dialogOpenerRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const dialogCancelRef = useRef<HTMLButtonElement | null>(null);

  const visibleTabs = useMemo(() => [
    ...snapshot.ungroupedTabs,
    ...snapshot.groups.flatMap((group) => group.collapsed ? [] : group.tabs),
  ], [snapshot.groups, snapshot.ungroupedTabs]);
  const visibleTabIds = useMemo(() => visibleTabs.map((tab) => tab.id), [visibleTabs]);

  useLayoutEffect(() => {
    if (focusedTabId && visibleTabIds.includes(focusedTabId)) {
      return;
    }
    const nextFocusedId = snapshot.activeTabId && visibleTabIds.includes(snapshot.activeTabId)
      ? snapshot.activeTabId
      : (visibleTabIds[0] ?? null);
    const activeElement = document.activeElement;
    const shouldRestoreDomFocus = focusedTabId !== null && (
      activeElement === null ||
      activeElement === document.body ||
      !activeElement.isConnected
    );
    if (nextFocusedId !== focusedTabId) {
      setFocusedTabId(nextFocusedId);
    }
    if (shouldRestoreDomFocus && nextFocusedId) {
      tabRefs.current.get(nextFocusedId)?.focus();
    }
  }, [focusedTabId, snapshot.activeTabId, visibleTabIds]);

  useLayoutEffect(() => {
    if (confirmClose) {
      if (busy) {
        dialogRef.current?.focus();
      } else {
        dialogCancelRef.current?.focus();
      }
    } else if (dialogOpenerRef.current?.isConnected) {
      dialogOpenerRef.current.focus();
      dialogOpenerRef.current = null;
    }
  }, [busy, confirmClose]);

  useLayoutEffect(() => {
    const target = restoreFocusRef.current;
    if (!target || renameTarget) {
      return;
    }
    restoreFocusRef.current = null;
    if (target.kind === "tab") {
      tabRefs.current.get(target.id)?.focus();
    } else {
      groupRefs.current.get(target.id)?.focus();
    }
  });

  const installDrag = (next: PointerDragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const cancelDrag = () => {
    const current = dragRef.current;
    if (current) {
      releaseDragCapture(current, tabRefs.current, groupRefs.current);
    }
    installDrag(null);
  };

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && dragRef.current) {
        event.preventDefault();
        cancelDrag();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, []);

  const startDrag = (
    event: ReactPointerEvent<HTMLElement>,
    source: DragSource,
    label: string,
  ) => {
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      (event.target instanceof HTMLElement &&
        event.target.closest("button, input, [role='menuitem']"))
    ) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    installDrag({
      pointerId: event.pointerId,
      source,
      origin: { x: event.clientX, y: event.clientY },
      current: { x: event.clientX, y: event.clientY },
      active: false,
      target: null,
      label,
      indicator: null,
    });
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) {
      return;
    }
    const point = { x: event.clientX, y: event.clientY };
    const active = current.active || crossedDragThreshold(current.origin, point);
    if (!active) {
      if (point.x !== current.current.x || point.y !== current.current.y) {
        installDrag({ ...current, current: point });
      }
      return;
    }
    const resolved = resolveDropTarget(current.source, point);
    installDrag({
      ...current,
      current: point,
      active: true,
      target: resolved?.target ?? null,
      indicator: resolved?.indicator ?? null,
    });
  };

  const finishDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) {
      return;
    }
    releaseDragCapture(current, tabRefs.current, groupRefs.current);
    const command = current.active && current.target
      ? commitDrop(current.source, current.target)
      : null;
    suppressClickRef.current = current.active;
    installDrag(null);
    if (command?.kind === "move_tab") {
      actions.moveTab(command.tabId, command.groupId, command.index);
    } else if (command?.kind === "reorder_group") {
      actions.reorderGroup(command.groupId, command.index);
    }
  };

  const finishRename = (target: RenameTarget) => {
    restoreFocusRef.current = target;
    setRenameTarget(null);
  };

  const beginTabRename = (tab: SidebarTabModel) => {
    setRenameTarget({ kind: "tab", id: tab.id });
  };

  const openConfirmation = (next: ConfirmClose, opener?: HTMLElement | null) => {
    dialogOpenerRef.current = opener ?? (
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    );
    setConfirmClose(next);
  };

  const closeConfirmation = () => {
    setConfirmClose(null);
  };

  const openMenu = (next: SidebarMenu) => {
    setMenuPanel("root");
    setMenu(next);
  };

  const closeMenu = () => {
    setMenu(null);
    setMenuPanel("root");
  };

  const createTab = async (groupId: string | null, profile: string | null) => {
    if (creating) {
      return;
    }
    setCreating(true);
    try {
      await actions.createTab({ groupId, profile });
    } finally {
      setCreating(false);
    }
  };

  const dismissDeadTab = async (tabId: string) => {
    if (dismissingTabIdsRef.current.has(tabId)) {
      return;
    }
    dismissingTabIdsRef.current.add(tabId);
    setDismissingTabIds(new Set(dismissingTabIdsRef.current));
    try {
      await actions.dismissDeadTab(tabId);
    } finally {
      dismissingTabIdsRef.current.delete(tabId);
      setDismissingTabIds(new Set(dismissingTabIdsRef.current));
    }
  };

  const requestTabClose = (tab: SidebarTabModel, opener?: HTMLElement | null) => {
    if (tab.status === "live" || tab.status === "attach_error") {
      openConfirmation({ kind: "tab", id: tab.id, title: tab.title }, opener);
    } else {
      void dismissDeadTab(tab.id);
    }
  };

  const handleTabKey = (event: KeyboardEvent<HTMLDivElement>, tab: SidebarTabModel) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    const index = visibleTabIds.indexOf(tab.id);
    if (event.key === "ArrowDown" && index >= 0 && index < visibleTabIds.length - 1) {
      event.preventDefault();
      const nextId = visibleTabIds[index + 1]!;
      setFocusedTabId(nextId);
      tabRefs.current.get(nextId)?.focus();
    } else if (event.key === "ArrowUp" && index > 0) {
      event.preventDefault();
      const previousId = visibleTabIds[index - 1]!;
      setFocusedTabId(previousId);
      tabRefs.current.get(previousId)?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      actions.activateTab(tab.id);
    } else if (event.key === "F2") {
      event.preventDefault();
      beginTabRename(tab);
    } else if (event.key === "Delete") {
      event.preventDefault();
      requestTabClose(tab);
    }
  };

  const renderTab = (tab: SidebarTabModel, index: number) => {
    const active = tab.id === snapshot.activeTabId;
    const ended = tab.status === "dead" || tab.status === "missing";
    const renaming = renameTarget?.kind === "tab" && renameTarget.id === tab.id;
    return (
      <div
        key={tab.id}
        ref={(node) => {
          if (node) tabRefs.current.set(tab.id, node);
          else tabRefs.current.delete(tab.id);
        }}
        className={[
          "sidebar-tab",
          active ? "sidebar-tab--active" : "",
          ended ? "sidebar-tab--ended" : "",
          tab.status === "attach_error" ? "sidebar-tab--error" : "",
        ].filter(Boolean).join(" ")}
        role="tab"
        aria-selected={active}
        tabIndex={focusedTabId === tab.id || (!focusedTabId && active) ? 0 : -1}
        data-tab-id={tab.id}
        data-group-id={tab.groupId ?? ""}
        data-drop-kind="tab"
        data-drop-index={index}
        onPointerDown={(event) => startDrag(event, {
          kind: "tab",
          tabId: tab.id,
          groupId: tab.groupId,
          index,
        }, tab.title)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openMenu({
            kind: "tab",
            id: tab.id,
            point: { x: event.clientX, y: event.clientY },
          });
        }}
        onFocus={() => setFocusedTabId(tab.id)}
        onClick={(event) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            event.preventDefault();
            return;
          }
          if (event.target === event.currentTarget || !(event.target as HTMLElement).closest("button")) {
            actions.activateTab(tab.id);
          }
        }}
        onDoubleClick={(event: MouseEvent<HTMLDivElement>) => {
          if (!(event.target as HTMLElement).closest("button")) {
            event.preventDefault();
            beginTabRename(tab);
          }
        }}
        onKeyDown={(event) => handleTabKey(event, tab)}
      >
        <span className="sidebar-tab__accent" aria-hidden="true" />
        <span
          className="sidebar-tab__color"
          data-color={tab.color}
          aria-label={`${tab.color} tab`}
        />
        <span className="sidebar-tab__content">
          {renaming ? (
            <InlineRename
              value={tab.title}
              ariaLabel={`Rename ${tab.title}`}
              onCommit={(value) => {
                actions.renameTab(tab.id, value);
                finishRename({ kind: "tab", id: tab.id });
              }}
              onCancel={() => finishRename({ kind: "tab", id: tab.id })}
            />
          ) : (
            <span className="sidebar-tab__title">{tab.title}</span>
          )}
          {ended ? <span className="sidebar-tab__badge">Exited</span> : null}
          {tab.status === "attach_error" ? (
            <span className="sidebar-tab__badge sidebar-tab__badge--error">Attach error</span>
          ) : null}
        </span>
        <span
          className="sidebar-tab__activity"
          data-activity={tab.activity}
          aria-label={activityLabel(tab.activity)}
        />
        <button
          type="button"
          className="sidebar-tab__close"
          aria-label={`${ended ? "Dismiss" : "Close"} ${tab.title}`}
          disabled={ended && dismissingTabIds.has(tab.id)}
          onClick={(event) => {
            event.stopPropagation();
            requestTabClose(tab);
          }}
        >
          ×
        </button>
      </div>
    );
  };

  const renderGroup = (group: SidebarGroupModel, groupIndex: number) => {
    const renaming = renameTarget?.kind === "group" && renameTarget.id === group.id;
    return (
      <section className="sidebar-group" data-group-id={group.id} key={group.id}>
        <div
          className="sidebar-group__header"
          data-drop-kind="group"
          data-drop-index={groupIndex}
          data-drop-tab-count={group.tabs.length}
          onPointerDown={(event) => startDrag(event, {
            kind: "group",
            groupId: group.id,
            index: groupIndex,
          }, group.name)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openMenu({
              kind: "group",
              id: group.id,
              point: { x: event.clientX, y: event.clientY },
            });
          }}
        >
          <button
            type="button"
            className="sidebar-group__toggle"
            aria-label={`${group.collapsed ? "Expand" : "Collapse"} ${group.name}`}
            aria-expanded={!group.collapsed}
            onClick={() => actions.toggleGroup(group.id)}
          >
            <span className="sidebar-group__chevron" aria-hidden="true">›</span>
          </button>
          <span className="sidebar-group__color" data-color="slate" aria-hidden="true" />
          <span
            ref={(node) => {
              if (node) groupRefs.current.set(group.id, node);
              else groupRefs.current.delete(group.id);
            }}
            className="sidebar-group__name"
            data-group-name={group.id}
            tabIndex={0}
            onDoubleClick={() => setRenameTarget({ kind: "group", id: group.id })}
            onKeyDown={(event) => {
              if (event.key === "F2") {
                event.preventDefault();
                setRenameTarget({ kind: "group", id: group.id });
              }
            }}
          >
            {renaming ? (
              <InlineRename
                value={group.name}
                ariaLabel={`Rename ${group.name}`}
                onCommit={(value) => {
                  actions.renameGroup(group.id, value);
                  finishRename({ kind: "group", id: group.id });
                }}
                onCancel={() => finishRename({ kind: "group", id: group.id })}
              />
            ) : group.name}
          </span>
          <span className="sidebar-group__count">{group.tabs.length}</span>
        </div>
        {!group.collapsed ? (
          <div
            className="sidebar-group__tabs"
            role="tablist"
            aria-label={`${group.name} terminals`}
            data-drop-kind="tab-container"
            data-drop-group-id={group.id}
            data-drop-index={group.tabs.length}
          >
            {group.tabs.map(renderTab)}
          </div>
        ) : null}
      </section>
    );
  };

  const renderedMenu = (() => {
    if (!menu) {
      return null;
    }
    if (menu.kind === "tab") {
      const tab = [...snapshot.ungroupedTabs, ...snapshot.groups.flatMap((group) => group.tabs)]
        .find((candidate) => candidate.id === menu.id);
      if (!tab) {
        return null;
      }
      if (menuPanel === "color") {
        return (
          <ContextMenu label={`Color for ${tab.title}`} point={menu.point} onClose={closeMenu}>
            <button type="button" role="menuitem" onClick={() => setMenuPanel("root")}>← Back</button>
            <div className="sidebar-color-grid" aria-label="Tab colors">
              {PALETTE_IDS.map((color) => (
                <button
                  type="button"
                  role="menuitem"
                  className="sidebar-color-swatch"
                  aria-label={`Set color ${color}`}
                  title={color}
                  key={color}
                  style={{ backgroundColor: PALETTE_HEX[color] }}
                  onClick={() => {
                    actions.recolorTab(tab.id, color);
                    closeMenu();
                  }}
                />
              ))}
            </div>
          </ContextMenu>
        );
      }
      if (menuPanel === "move") {
        const targets = [
          ...(tab.groupId === null ? [] : [{ id: null, name: "Ungrouped", count: snapshot.ungroupedTabs.length }]),
          ...snapshot.groups
            .filter((group) => group.id !== tab.groupId)
            .map((group) => ({ id: group.id, name: group.name, count: group.tabs.length })),
        ];
        return (
          <ContextMenu label={`Move ${tab.title}`} point={menu.point} onClose={closeMenu}>
            <button type="button" role="menuitem" onClick={() => setMenuPanel("root")}>← Back</button>
            {targets.map((target) => (
              <button
                type="button"
                role="menuitem"
                key={target.id ?? "ungrouped"}
                onClick={() => {
                  actions.moveTab(tab.id, target.id, target.count);
                  closeMenu();
                }}
              >
                {target.name}
              </button>
            ))}
          </ContextMenu>
        );
      }
      const ended = tab.status === "dead" || tab.status === "missing";
      return (
        <ContextMenu label={`Actions for ${tab.title}`} point={menu.point} onClose={closeMenu}>
          <button type="button" role="menuitem" onClick={() => {
            closeMenu();
            beginTabRename(tab);
          }}>Rename</button>
          <button type="button" role="menuitem" onClick={() => {
            closeMenu();
            void actions.duplicateTab(tab.id);
          }}>Duplicate tab</button>
          <button type="button" role="menuitem" onClick={() => {
            closeMenu();
            void actions.openFolderHere(tab.id);
          }}>Open folder here</button>
          <button type="button" role="menuitem" onClick={() => setMenuPanel("color")}>Color</button>
          <button type="button" role="menuitem" onClick={() => setMenuPanel("move")}>Move to group</button>
          <button type="button" role="menuitem" className="context-menu__danger" onClick={() => {
            closeMenu();
            requestTabClose(tab, tabRefs.current.get(tab.id));
          }}>{ended ? "Dismiss" : "Close"}</button>
        </ContextMenu>
      );
    }

    if (menu.kind === "group") {
      const group = snapshot.groups.find((candidate) => candidate.id === menu.id);
      if (!group) {
        return null;
      }
      return (
        <ContextMenu label={`Actions for ${group.name}`} point={menu.point} onClose={closeMenu}>
          <button type="button" role="menuitem" onClick={() => {
            closeMenu();
            setRenameTarget({ kind: "group", id: group.id });
          }}>Rename</button>
          <button type="button" role="menuitem" onClick={() => {
            closeMenu();
            void createTab(group.id, null);
          }}>New tab in group</button>
          {onOpenFolderSearch ? (
            <button type="button" role="menuitem" onClick={() => {
              closeMenu();
              onOpenFolderSearch(group.id);
            }}>New tab in folder…</button>
          ) : null}
          <button type="button" role="menuitem" onClick={() => {
            actions.toggleGroup(group.id);
            closeMenu();
          }}>{group.collapsed ? "Expand" : "Collapse"}</button>
          <button type="button" role="menuitem" className="context-menu__danger" onClick={() => {
            closeMenu();
            openConfirmation(
              { kind: "group", id: group.id, title: group.name },
              groupRefs.current.get(group.id),
            );
          }}>Close group</button>
        </ContextMenu>
      );
    }

    if (menu.kind === "background") {
      return (
        <ContextMenu label="Sidebar actions" point={menu.point} onClose={closeMenu}>
          <button type="button" role="menuitem" onClick={() => {
            closeMenu();
            void createTab(null, null);
          }}>New tab</button>
          {onOpenFolderSearch ? (
            <button type="button" role="menuitem" onClick={() => {
              closeMenu();
              onOpenFolderSearch(null);
            }}>New tab in folder…</button>
          ) : null}
          <button type="button" role="menuitem" onClick={() => {
            closeMenu();
            setCreatingGroup(true);
          }}>New group</button>
        </ContextMenu>
      );
    }

    return (
      <ContextMenu label="New terminal profile" point={menu.point} onClose={closeMenu}>
        {onOpenFolderSearch ? (
          <button type="button" role="menuitem" onClick={() => {
            closeMenu();
            onOpenFolderSearch(null);
          }}>New tab in folder…</button>
        ) : null}
        <button type="button" role="menuitem" onClick={() => {
          closeMenu();
          void createTab(null, null);
        }}>Default</button>
        <button type="button" role="menuitem" onClick={() => {
          closeMenu();
          void createTab(null, "powershell");
        }}>Windows PowerShell</button>
        <button type="button" role="menuitem" onClick={() => {
          closeMenu();
          void createTab(null, "cmd");
        }}>Command Prompt</button>
      </ContextMenu>
    );
  })();

  return (
    <aside
      className="sidebar"
      aria-label="Terminal sessions"
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={cancelDrag}
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu({
          kind: "background",
          point: { x: event.clientX, y: event.clientY },
        });
      }}
    >
      <header className="sidebar__header">
        <span className="sidebar__mark" aria-hidden="true">T</span>
        <span>Sessions</span>
        {snapshot.persistence.saving ? <span className="sidebar__saving">Saving…</span> : null}
      </header>
      <div className="sidebar__scroll">
        <div
          className="sidebar__ungrouped"
          role="tablist"
          aria-label="Ungrouped terminals"
          data-drop-kind="tab-container"
          data-drop-group-id=""
          data-drop-index={snapshot.ungroupedTabs.length}
          data-empty={snapshot.ungroupedTabs.length === 0 ? "true" : undefined}
        >
          {snapshot.ungroupedTabs.map(renderTab)}
        </div>
        {snapshot.groups.map(renderGroup)}
      </div>
      {creatingGroup ? (
        <div className="sidebar-new-group">
          <InlineRename
            value="New group"
            ariaLabel="Name new group"
            onCommit={(name) => {
              actions.createGroup(name);
              setCreatingGroup(false);
            }}
            onCancel={() => setCreatingGroup(false)}
          />
        </div>
      ) : null}
      <div className="sidebar-create">
        <button
          type="button"
          className="sidebar-create__primary"
          aria-label="New terminal"
          disabled={creating}
          onClick={() => void createTab(null, null)}
        >
          <span aria-hidden="true">＋</span>
          {creating ? "Creating…" : "New terminal"}
        </button>
        <button
          type="button"
          className="sidebar-create__options"
          aria-label="New terminal options"
          disabled={creating}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu({
              kind: "create",
              point: { x: rect.right, y: rect.bottom },
            });
          }}
        >
          ▴
        </button>
        {onOpenFolderSearch ? (
          <button
            type="button"
            className="sidebar-create__options"
            aria-label="New terminal in folder"
            title="New terminal in folder (Ctrl+Shift+O)"
            onClick={() => onOpenFolderSearch(null)}
          >
            ⌕
          </button>
        ) : null}
        {onOpenSettings ? (
          <button
            type="button"
            className="sidebar-create__options"
            aria-label="Settings"
            title="Settings"
            onClick={onOpenSettings}
          >
            ⚙
          </button>
        ) : null}
      </div>
      {snapshot.notice || snapshot.persistence.error ? (
        <div className="sidebar__notice" role="status">
          {snapshot.notice ?? snapshot.persistence.error}
        </div>
      ) : null}
      {renderedMenu}
      {drag?.active ? (
        <>
          <div
            className="sidebar-drag-ghost"
            style={{
              transform: `translate3d(${drag.current.x + 12}px, ${drag.current.y + 12}px, 0)`,
            }}
          >
            {drag.label}
          </div>
          {drag.indicator ? (
            <div
              className="sidebar-drag-indicator"
              style={{
                left: drag.indicator.left,
                top: drag.indicator.top,
                width: drag.indicator.width,
              }}
            />
          ) : null}
        </>
      ) : null}
      {confirmClose ? (
        <div className="sidebar-dialog-backdrop">
          <div
            ref={dialogRef}
            className="sidebar-dialog"
            role="dialog"
            aria-modal="true"
            aria-busy={busy}
            aria-label={confirmClose.kind === "tab" ? "Close terminal" : "Close group"}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (!busy) {
                  closeConfirmation();
                }
                return;
              }
              if (event.key !== "Tab") {
                return;
              }
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
              );
              if (buttons.length === 0) {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.focus();
                return;
              }
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const leavingStart = event.shiftKey && index <= 0;
              const leavingEnd = !event.shiftKey && index === buttons.length - 1;
              if (leavingStart || leavingEnd) {
                event.preventDefault();
                event.stopPropagation();
                buttons[leavingStart ? buttons.length - 1 : 0]?.focus();
              }
            }}
          >
            <h2>{confirmClose.kind === "tab" ? "Close terminal?" : "Close group?"}</h2>
            <p>
              {confirmClose.kind === "tab"
                ? `Close “${confirmClose.title}” and end its running shell?`
                : `Close every terminal in “${confirmClose.title}”?`}
            </p>
            <div className="sidebar-dialog__actions">
              <button
                ref={dialogCancelRef}
                type="button"
                disabled={busy}
                onClick={closeConfirmation}
              >Cancel</button>
              <button
                type="button"
                className="sidebar-dialog__danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    if (confirmClose.kind === "tab") {
                      await actions.closeLiveTab(confirmClose.id);
                    } else {
                      await actions.closeGroup(confirmClose.id);
                    }
                    closeConfirmation();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy
                  ? "Closing…"
                  : (confirmClose.kind === "tab" ? "Close terminal" : "Close group")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

function activityLabel(activity: SidebarTabModel["activity"]): string {
  if (activity === "unread") return "Unread output";
  if (activity === "active") return "Terminal active";
  return "No recent output";
}

function resolveDropTarget(
  source: DragSource,
  point: { x: number; y: number },
): {
  target: DropTarget;
  indicator: { left: number; top: number; width: number };
} | null {
  const hit = document.elementFromPoint(point.x, point.y);
  if (!(hit instanceof HTMLElement)) {
    return null;
  }
  const candidate = hit.closest<HTMLElement>("[data-drop-kind]");
  if (!candidate) {
    return null;
  }
  const kind = candidate.dataset.dropKind;
  const rect = candidate.getBoundingClientRect();

  if (source.kind === "group") {
    if (kind !== "group") {
      return null;
    }
    const baseIndex = numberAttribute(candidate.dataset.dropIndex);
    const after = point.y >= rect.top + rect.height / 2;
    return {
      target: { kind: "group", index: baseIndex + (after ? 1 : 0) },
      indicator: {
        left: rect.left,
        top: after ? rect.bottom : rect.top,
        width: rect.width,
      },
    };
  }

  if (kind === "tab") {
    const baseIndex = numberAttribute(candidate.dataset.dropIndex);
    const after = point.y >= rect.top + rect.height / 2;
    return {
      target: {
        kind: "tab",
        groupId: nullableGroupId(candidate.dataset.groupId),
        index: baseIndex + (after ? 1 : 0),
      },
      indicator: {
        left: rect.left + 8,
        top: after ? rect.bottom : rect.top,
        width: Math.max(0, rect.width - 16),
      },
    };
  }

  if (kind === "tab-container") {
    return {
      target: {
        kind: "tab",
        groupId: nullableGroupId(candidate.dataset.dropGroupId),
        index: numberAttribute(candidate.dataset.dropIndex),
      },
      indicator: {
        left: rect.left + 8,
        top: rect.bottom,
        width: Math.max(0, rect.width - 16),
      },
    };
  }

  if (kind === "group") {
    const group = candidate.closest<HTMLElement>("[data-group-id]");
    if (!group) {
      return null;
    }
    return {
      target: {
        kind: "tab",
        groupId: nullableGroupId(group.dataset.groupId),
        index: numberAttribute(candidate.dataset.dropTabCount),
      },
      indicator: {
        left: rect.left + 8,
        top: rect.bottom,
        width: Math.max(0, rect.width - 16),
      },
    };
  }
  return null;
}

function numberAttribute(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function nullableGroupId(value: string | undefined): string | null {
  return value ? value : null;
}

function releaseDragCapture(
  drag: PointerDragState,
  tabRefs: ReadonlyMap<string, HTMLDivElement>,
  groupRefs: ReadonlyMap<string, HTMLElement>,
): void {
  const element = drag.source.kind === "tab"
    ? tabRefs.get(drag.source.tabId)
    : groupRefs.get(drag.source.groupId)?.closest<HTMLElement>(".sidebar-group__header");
  try {
    element?.releasePointerCapture(drag.pointerId);
  } catch {
    // Pointer capture may already be released by the browser.
  }
}
