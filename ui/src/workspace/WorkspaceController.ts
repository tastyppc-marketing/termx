import type {
  HostClient,
  SessionAttachment,
  SessionAttachmentCallbacks,
} from "../host/client";
import type { SessionInfo } from "../host/protocol";
import {
  duplicateTab as duplicateFolderTab,
  openFolderHere as openFolderFromTab,
  pickFolderAndCreateSession,
} from "../native/folderSession";
import type { FolderPicker } from "../native/dialog";
import {
  sessionIdsInLayout,
  type LayoutV1,
  type PaletteId,
  type SplitDir,
} from "../state/layout";
import type { LayoutStore } from "../state/store";
import type { AttachmentHubSnapshot } from "./AttachmentHub";
import type {
  LayoutChangeKind,
  LayoutPersistenceSnapshot,
} from "./LayoutPersistence";
import {
  canSplitPane,
  firstSessionId,
  nextTabColor,
  pruneSessionIds,
  removeGroupAndTabs,
  reorderGroup as reorderLayoutGroup,
  sessionIdsInTab,
} from "./layoutOperations";

export type WorkspaceHostClient = Pick<
  HostClient,
  | "createSession"
  | "closeSession"
  | "onSessionExited"
  | "onSessionClosed"
  | "onError"
>;

export interface WorkspaceAttachmentHub {
  getSnapshot(): AttachmentHubSnapshot;
  subscribe(listener: () => void): () => void;
  attachSession(sessionId: number): Promise<void>;
  markExited(sessionId: number, exitCode: number | null): void;
  forgetSession(sessionId: number): void;
  attach(
    sessionId: number,
    callbacks?: SessionAttachmentCallbacks,
    replay?: boolean,
  ): Promise<SessionAttachment>;
  onError(listener: (error: Error) => void): () => void;
  close(): void;
}

export interface WorkspacePersistence {
  getSnapshot(): LayoutPersistenceSnapshot;
  subscribe(listener: () => void): () => void;
  record(layout: LayoutV1, kind: LayoutChangeKind): void;
  flush(): Promise<void>;
  dispose(): void;
}

export interface SidebarTabModel {
  id: string;
  groupId: string | null;
  title: string;
  color: PaletteId;
  primarySessionId: number;
  sessionIds: readonly number[];
  status: "live" | "dead" | "missing" | "attach_error";
  activity: "idle" | "active" | "unread";
  profile: string | null;
  cwd: string | null;
}

export interface SidebarGroupModel {
  id: string;
  name: string;
  collapsed: boolean;
  color: "slate";
  tabs: readonly SidebarTabModel[];
}

/// Per-pane projection for the split renderer. "dead" = the host still knows
/// the session (scrollback ring intact, exit code may be known); "missing" =
/// the layout references a session the host no longer has.
export interface PaneSessionState {
  status: "live" | "dead" | "missing";
  exitCode: number | null;
}

export interface WorkspaceSnapshot {
  layout: LayoutV1;
  ungroupedTabs: readonly SidebarTabModel[];
  groups: readonly SidebarGroupModel[];
  paneStates: Readonly<Record<number, PaneSessionState>>;
  activeTabId: string | null;
  activeSessionId: number | null;
  persistence: LayoutPersistenceSnapshot;
  notice: string | null;
}

export interface WorkspaceControllerOptions {
  client: WorkspaceHostClient;
  store: LayoutStore;
  persistence: WorkspacePersistence;
  attachments: WorkspaceAttachmentHub;
  sessions: readonly SessionInfo[];
  generateId?: () => string;
  pickFolder?: FolderPicker;
}

export class WorkspaceController {
  readonly attachments: WorkspaceAttachmentHub;

  private readonly client: WorkspaceHostClient;
  private readonly store: LayoutStore;
  private readonly persistence: WorkspacePersistence;
  private readonly generateId: () => string;
  private readonly pickFolder?: FolderPicker;
  private readonly sessions = new Map<number, SessionInfo>();
  private readonly listeners = new Set<() => void>();
  private readonly cleanups: Array<() => void> = [];
  private cachedSnapshot: WorkspaceSnapshot | null = null;
  private cachedLayout: LayoutV1 | null = null;
  private cachedAttachments: AttachmentHubSnapshot | null = null;
  private cachedPersistence: LayoutPersistenceSnapshot | null = null;
  private sessionsRevision = 0;
  private cachedSessionsRevision = -1;
  private notice: string | null = null;
  private cachedNotice: string | null | undefined;
  private disposed = false;

  constructor(options: WorkspaceControllerOptions) {
    this.client = options.client;
    this.store = options.store;
    this.persistence = options.persistence;
    this.attachments = options.attachments;
    this.generateId = options.generateId ?? (() => crypto.randomUUID());
    this.pickFolder = options.pickFolder;
    for (const session of options.sessions) {
      this.sessions.set(session.id, session);
    }

    this.cleanups.push(
      this.store.subscribe(() => this.publish()),
      this.persistence.subscribe(() => this.publish()),
      this.attachments.subscribe(() => this.publish()),
      this.client.onSessionExited(({ sessionId, exitCode }) => {
        const existing = this.sessions.get(sessionId);
        if (existing) {
          this.sessions.set(sessionId, { ...existing, alive: false });
          this.sessionsRevision += 1;
        }
        this.attachments.markExited(sessionId, exitCode);
        this.publish();
      }),
      this.client.onSessionClosed(({ sessionId }) => {
        if (this.sessions.delete(sessionId)) {
          this.sessionsRevision += 1;
        }
        this.attachments.forgetSession(sessionId);
        this.publish();
      }),
      this.client.onError(() => {
        this.setNotice("The terminal host reported an error.");
      }),
    );
  }

  getSnapshot = (): WorkspaceSnapshot => {
    const layout = this.store.getState();
    const attachments = this.attachments.getSnapshot();
    const persistence = this.persistence.getSnapshot();
    if (
      this.cachedSnapshot &&
      this.cachedLayout === layout &&
      this.cachedAttachments === attachments &&
      this.cachedPersistence === persistence &&
      this.cachedSessionsRevision === this.sessionsRevision &&
      this.cachedNotice === this.notice
    ) {
      return this.cachedSnapshot;
    }

    const projectTab = (tabId: string, groupId: string | null): SidebarTabModel => {
      const tab = layout.tabs[tabId]!;
      const sessionIds = sessionIdsInTab(tab);
      const primarySessionId = firstSessionId(tab.split);
      const primary = this.sessions.get(primarySessionId);
      const live = sessionIds.some((id) => this.sessions.get(id)?.alive === true);
      const knownDead = sessionIds.some((id) => {
        const info = this.sessions.get(id);
        return info !== undefined && !info.alive;
      });
      const attachError = sessionIds.some((id) => attachments.sessions[id]?.attachError);
      const unread = sessionIds.some((id) => attachments.sessions[id]?.unread);
      const active = sessionIds.some((id) => attachments.sessions[id]?.active);
      return {
        id: tab.id,
        groupId,
        title: tab.title ?? derivedTitle(primary),
        color: tab.color,
        primarySessionId,
        sessionIds,
        status: live
          ? (attachError ? "attach_error" : "live")
          : (knownDead ? "dead" : "missing"),
        activity: unread ? "unread" : (active ? "active" : "idle"),
        profile: primary?.profile ?? null,
        cwd: primary?.cwd ?? null,
      };
    };

    const ungroupedTabs = layout.ungroupedTabIds.map((tabId) => projectTab(tabId, null));
    const groups = layout.groups.map((group): SidebarGroupModel => ({
      id: group.id,
      name: group.name,
      collapsed: group.collapsed,
      color: "slate",
      tabs: group.tabIds.map((tabId) => projectTab(tabId, group.id)),
    }));
    const paneStates: Record<number, PaneSessionState> = {};
    for (const sessionId of sessionIdsInLayout(layout)) {
      const info = this.sessions.get(sessionId);
      if (info?.alive === true) {
        paneStates[sessionId] = { status: "live", exitCode: null };
      } else if (info !== undefined) {
        paneStates[sessionId] = {
          status: "dead",
          exitCode: attachments.sessions[sessionId]?.exitCode ?? null,
        };
      } else {
        paneStates[sessionId] = { status: "missing", exitCode: null };
      }
    }
    const activeTab = layout.activeTabId ? layout.tabs[layout.activeTabId] : undefined;
    const snapshot: WorkspaceSnapshot = {
      layout,
      ungroupedTabs,
      groups,
      paneStates,
      activeTabId: layout.activeTabId,
      activeSessionId: activeTab ? firstSessionId(activeTab.split) : null,
      persistence,
      notice: this.notice,
    };
    this.cachedSnapshot = snapshot;
    this.cachedLayout = layout;
    this.cachedAttachments = attachments;
    this.cachedPersistence = persistence;
    this.cachedSessionsRevision = this.sessionsRevision;
    this.cachedNotice = this.notice;
    return snapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  activateTab = (tabId: string): void => {
    this.mutate("active_tab", () => this.store.setActiveTab(tabId));
  };

  renameTab = (tabId: string, title: string | null): void => {
    this.mutate("structural", () => this.store.renameTab(tabId, title));
  };

  recolorTab = (tabId: string, color: PaletteId): void => {
    this.mutate("structural", () => this.store.recolorTab(tabId, color));
  };

  moveTab = (tabId: string, groupId: string | null, index: number): void => {
    this.mutate("structural", () => this.store.moveTab(tabId, { groupId }, index));
  };

  reorderGroup = (groupId: string, targetIndex: number): void => {
    this.mutate("structural", () =>
      this.store.replaceState(reorderLayoutGroup(this.store.getState(), groupId, targetIndex))
    );
  };

  createGroup = (name: string): void => {
    this.mutate("structural", () => this.store.createGroup({ id: this.generateId(), name }));
  };

  renameGroup = (groupId: string, name: string): void => {
    this.mutate("structural", () => this.store.renameGroup(groupId, name));
  };

  toggleGroup = (groupId: string): void => {
    this.mutate("structural", () => this.store.toggleGroupCollapsed(groupId));
  };

  createTab = async (options: {
    groupId: string | null;
    profile: string | null;
  }): Promise<void> => {
    this.setNotice(null);
    try {
      const created = await pickFolderAndCreateSession(
        { client: this.client, pickFolder: this.pickFolder },
        { profile: options.profile, picker: { title: "Open folder for new terminal" } },
      );
      if (created) {
        await this.addSessionTab(created, options.groupId);
      }
    } catch {
      this.setNotice("The terminal session could not be created.");
    }
  };

  duplicateTab = async (tabId: string): Promise<void> => {
    const source = this.sourceForTab(tabId);
    if (!source) {
      this.setNotice("The source terminal is no longer available.");
      return;
    }
    try {
      const created = await duplicateFolderTab({ client: this.client }, source.template);
      await this.addSessionTab(created, source.groupId);
    } catch {
      this.setNotice("The terminal tab could not be duplicated.");
    }
  };

  openFolderHere = async (tabId: string): Promise<void> => {
    const source = this.sourceForTab(tabId);
    if (!source) {
      this.setNotice("The source terminal is no longer available.");
      return;
    }
    try {
      const created = await openFolderFromTab(
        { client: this.client, pickFolder: this.pickFolder },
        source.template,
      );
      if (created) {
        await this.addSessionTab(created, source.groupId);
      }
    } catch {
      this.setNotice("The folder could not be opened in a terminal.");
    }
  };

  closeLiveTab = async (tabId: string): Promise<void> => {
    const tab = this.store.getState().tabs[tabId];
    if (!tab) {
      return;
    }
    const sessionIds = sessionIdsInTab(tab);
    const { successful, failed } = await this.closeSessions(sessionIds);
    this.applyClosedSessions(successful);
    if (failed) {
      this.setNotice("Some terminal sessions could not be closed.");
    }
  };

  closeGroup = async (groupId: string): Promise<void> => {
    const layout = this.store.getState();
    const group = layout.groups.find((candidate) => candidate.id === groupId);
    if (!group) {
      return;
    }
    const sessionIds = group.tabIds.flatMap((tabId) => {
      const tab = layout.tabs[tabId];
      return tab ? sessionIdsInTab(tab) : [];
    });
    const { successful, failed } = await this.closeSessions(sessionIds);
    this.mutate("structural", () => {
      const pruned = pruneSessionIds(this.store.getState(), successful);
      const candidate = failed ? pruned : removeGroupAndTabs(pruned, groupId);
      return this.store.replaceState(candidate);
    });
    if (failed) {
      this.setNotice("Some terminal sessions could not be closed.");
    }
  };

  dismissDeadTab = async (tabId: string): Promise<void> => {
    const tab = this.store.getState().tabs[tabId];
    if (!tab) {
      return;
    }
    const dismissible = sessionIdsInTab(tab).filter((sessionId) =>
      this.sessions.get(sessionId)?.alive !== true
    );
    const { successful, failed } = await this.closeSessions(dismissible);
    this.applyClosedSessions(successful);
    if (failed) {
      this.setNotice("The ended terminal could not be dismissed.");
    }
  };

  /// Split a live pane: duplicate its session (same profile + cwd), attach it
  /// in the hub, then apply the store split. The store re-validates after the
  /// createSession await; if it refuses (layout moved underneath us), the
  /// just-created session is closed again so no orphan outlives the action.
  /// Returns the new pane's session id so the caller can focus it.
  splitPane = async (
    tabId: string,
    paneSessionId: number,
    dir: SplitDir,
  ): Promise<number | null> => {
    const tab = this.store.getState().tabs[tabId];
    if (!tab) {
      return null;
    }
    const source = this.sessions.get(paneSessionId);
    if (source?.alive !== true) {
      this.setNotice("Only a running terminal can be split.");
      return null;
    }
    if (!canSplitPane(tab.split, paneSessionId)) {
      this.setNotice("This pane is already split as deep as it can go.");
      return null;
    }
    this.setNotice(null);
    let created: SessionInfo;
    try {
      created = await duplicateFolderTab(
        { client: this.client },
        { profile: source.profile, cwd: source.cwd },
      );
    } catch {
      this.setNotice("The terminal session could not be created.");
      return null;
    }
    this.sessions.set(created.id, created);
    this.sessionsRevision += 1;
    try {
      await this.attachments.attachSession(created.id);
    } catch {
      // The hub records the attach error; the new pane surfaces it inline.
    }
    const before = this.store.getState();
    const after = this.store.splitPane(tabId, paneSessionId, dir, created.id);
    if (after === before) {
      try {
        await this.client.closeSession(created.id);
      } catch {
        // The host reaps the session on its own close path.
      }
      this.sessions.delete(created.id);
      this.sessionsRevision += 1;
      this.attachments.forgetSession(created.id);
      this.setNotice("The pane could not be split.");
      this.publish();
      return null;
    }
    this.persistence.record(after, "structural");
    this.publish();
    return created.id;
  };

  /// Pessimistic pane close (also the dead-pane Dismiss path): the host
  /// CloseSession must succeed — freeing the scrollback ring — before the
  /// pane leaves the layout. Closing a tab's last pane closes the tab.
  closePane = async (tabId: string, sessionId: number): Promise<void> => {
    const { successful, failed } = await this.closeSessions([sessionId]);
    if (failed) {
      this.setNotice("The terminal session could not be closed.");
      return;
    }
    if (successful.has(sessionId)) {
      this.mutate("structural", () => this.store.closePane(tabId, sessionId));
    }
    this.publish();
  };

  /// Persistence rule 4: the split renderer previews drags locally and calls
  /// this only on release, so every call is a real structural write.
  resizePane = (tabId: string, path: number[], sizes: [number, number]): void => {
    this.mutate("structural", () => this.store.resizePane(tabId, path, sizes));
  };

  flush = (): Promise<void> => this.persistence.flush();

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // Continue releasing the remaining workspace ownership.
      }
    }
    this.listeners.clear();
    this.persistence.dispose();
    this.attachments.close();
  }

  private async addSessionTab(session: SessionInfo, groupId: string | null): Promise<void> {
    this.sessions.set(session.id, session);
    this.sessionsRevision += 1;
    await this.attachments.attachSession(session.id);
    const layout = this.store.getState();
    const targetGroupId = groupId !== null && layout.groups.some((group) => group.id === groupId)
      ? groupId
      : null;
    this.mutate("structural", () => this.store.createTab({
      id: this.generateId(),
      sessionId: session.id,
      color: nextTabColor(layout),
      groupId: targetGroupId,
    }));
    this.publish();
  }

  private sourceForTab(tabId: string): {
    groupId: string | null;
    template: { profile: string | null; cwd: string | null };
  } | null {
    const layout = this.store.getState();
    const tab = layout.tabs[tabId];
    if (!tab) {
      return null;
    }
    const session = this.sessions.get(firstSessionId(tab.split));
    if (!session) {
      return null;
    }
    const group = layout.groups.find((candidate) => candidate.tabIds.includes(tabId));
    return {
      groupId: group?.id ?? null,
      template: { profile: session.profile, cwd: session.cwd },
    };
  }

  private async closeSessions(sessionIds: readonly number[]): Promise<{
    successful: Set<number>;
    failed: boolean;
  }> {
    const successful = new Set<number>();
    let failed = false;
    for (const sessionId of sessionIds) {
      const known = this.sessions.has(sessionId);
      if (!known) {
        successful.add(sessionId);
        continue;
      }
      try {
        await this.client.closeSession(sessionId);
        if (this.sessions.delete(sessionId)) {
          this.sessionsRevision += 1;
        }
        this.attachments.forgetSession(sessionId);
        successful.add(sessionId);
      } catch {
        failed = true;
      }
    }
    return { successful, failed };
  }

  private applyClosedSessions(sessionIds: ReadonlySet<number>): void {
    if (sessionIds.size === 0) {
      return;
    }
    this.mutate("structural", () =>
      this.store.replaceState(pruneSessionIds(this.store.getState(), sessionIds))
    );
    this.publish();
  }

  private mutate(kind: LayoutChangeKind, mutation: () => LayoutV1): void {
    const before = this.store.getState();
    const after = mutation();
    if (after !== before) {
      this.persistence.record(after, kind);
    }
  }

  private setNotice(notice: string | null): void {
    if (notice === this.notice) {
      return;
    }
    this.notice = notice;
    this.publish();
  }

  private publish(): void {
    this.cachedSnapshot = null;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // One React consumer cannot block the remaining workspace listeners.
      }
    }
  }
}

function derivedTitle(session: SessionInfo | undefined): string {
  if (!session) {
    return "Terminal ended";
  }
  const profile = session.profile || "Terminal";
  if (!session.cwd) {
    return profile;
  }
  const parts = session.cwd.split(/[\\/]/).filter(Boolean);
  const tail = parts[parts.length - 1];
  return tail ? `${profile} · ${tail}` : profile;
}
