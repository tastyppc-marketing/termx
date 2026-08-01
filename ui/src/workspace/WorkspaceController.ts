import type {
  HostClient,
  SessionAttachment,
  SessionAttachmentCallbacks,
} from "../host/client";
import type { SessionInfo } from "../host/protocol";
import {
  createSessionWithCwd,
  duplicateTab as duplicateFolderTab,
  openFolderHere as openFolderFromTab,
  pickFolderAndCreateSession,
} from "../native/folderSession";
import type { FolderPicker } from "../native/dialog";
import {
  RESUME_FIXED_DELAY_MS,
  RESUME_PROMPT_TIMEOUT_MS,
  resumeCommand,
  tauriDirExists,
  type DirExists,
} from "../conversations/resume";
import type { LlmSessionRecord } from "../conversations/types";
import { DEFAULT_SETTINGS, type TermxSettings } from "../settings/settings";
import {
  dropScope,
  newTabCwdCandidates,
  reportScopeCwd,
  scopeKeyFor,
  seedScope,
  type ScopeKey,
} from "./scopePaths";
import { UiStateStore, touchRecentFolder, updateScopePaths } from "./uiState";
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
  extractSessionToTab,
  firstSessionId,
  mergeTabIntoTab,
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
  /**
   * Direct write into a session's host attachment, WITHOUT taking ownership of
   * its terminal callbacks (`attach` refuses a second terminal). This is the
   * seam the resume flow types its command through; AttachmentHub implements
   * it. Optional so existing hub fakes keep type-checking — a hub without it
   * degrades to a "could not be typed" notice, never to a silent no-op.
   */
  sendInput?(sessionId: number, data: string | Uint8Array): boolean;
  /**
   * Last dims a terminal pushed to the host for this session (spec §13);
   * AttachmentHub implements it. Optional so existing hub fakes keep
   * type-checking — absent means "no recorded dims", never an error.
   */
  lastDims?(sessionId: number): { cols: number; rows: number } | null;
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

/** Read-only view of live settings (SettingsStore satisfies this). */
export interface SettingsReader {
  getSnapshot(): TermxSettings;
}

/** Target for a deferred "pick a folder first" create (searcher palette). */
export interface FolderSearchTarget {
  groupId: string | null;
  profile: string | null;
}

export interface WorkspaceControllerOptions {
  client: WorkspaceHostClient;
  store: LayoutStore;
  persistence: WorkspacePersistence;
  attachments: WorkspaceAttachmentHub;
  sessions: readonly SessionInfo[];
  generateId?: () => string;
  pickFolder?: FolderPicker;
  settings?: SettingsReader;
  uiState?: UiStateStore;
  /** Directory probe for the resume flow (spec §5); defaults to `list_dirs`. */
  dirExists?: DirExists;
}

/** How a resume's wait for the new session's prompt ended. */
type ResumeWaitOutcome = "ready" | "elapsed" | "gone";

interface ResumeWaiter {
  settle: (outcome: ResumeWaitOutcome) => void;
  /** False for the fixed-delay path: cwd reports must not shorten the wait. */
  awaitPrompt: boolean;
}

export class WorkspaceController {
  readonly attachments: WorkspaceAttachmentHub;

  private readonly client: WorkspaceHostClient;
  private readonly store: LayoutStore;
  private readonly persistence: WorkspacePersistence;
  private readonly generateId: () => string;
  private readonly pickFolder?: FolderPicker;
  private readonly settings: SettingsReader;
  private readonly uiState: UiStateStore;
  private readonly dirExists: DirExists;
  private folderSearchHandler: ((target: FolderSearchTarget) => void) | null = null;
  /// One-shot resume waiters keyed by the session the resume just created.
  private readonly resumeWaiters = new Map<number, ResumeWaiter>();
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
    // Every session-creation path (policy chain, native dialog, duplicate,
    // open-folder-here) goes through this.client, so the live shell-integration
    // setting is stamped here once rather than threaded through each caller.
    const rawClient = options.client;
    this.client = {
      createSession: (createOptions) =>
        rawClient.createSession({
          ...createOptions,
          shellIntegration: this.settings.getSnapshot().shellIntegration,
        }),
      closeSession: (sessionId) => rawClient.closeSession(sessionId),
      onSessionExited: (listener) => rawClient.onSessionExited(listener),
      onSessionClosed: (listener) => rawClient.onSessionClosed(listener),
      onError: (listener) => rawClient.onError(listener),
    };
    this.store = options.store;
    this.persistence = options.persistence;
    this.attachments = options.attachments;
    this.generateId = options.generateId ?? (() => crypto.randomUUID());
    this.pickFolder = options.pickFolder;
    this.settings = options.settings ?? { getSnapshot: () => DEFAULT_SETTINGS };
    this.uiState = options.uiState ?? new UiStateStore();
    this.dirExists = options.dirExists ?? tauriDirExists;
    for (const session of options.sessions) {
      this.sessions.set(session.id, session);
    }

    // Seed scopes from the restored layout so group-aware policies work
    // immediately on layouts that predate scope tracking. seedScope never
    // moves an existing seed, so persisted state wins.
    this.uiState.update((state) =>
      updateScopePaths(state, (paths) => {
        const layout = this.store.getState();
        let next = paths;
        const seedFromTab = (tabId: string, key: ScopeKey) => {
          const tab = layout.tabs[tabId];
          if (!tab) {
            return;
          }
          const primary = this.sessions.get(firstSessionId(tab.split));
          next = seedScope(next, key, primary?.cwd ?? null);
        };
        for (const tabId of layout.ungroupedTabIds) {
          seedFromTab(tabId, scopeKeyFor(null));
        }
        for (const group of layout.groups) {
          for (const tabId of group.tabIds) {
            seedFromTab(tabId, group.id);
          }
        }
        return next;
      }),
    );

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
        this.settleResumeWait(sessionId, "gone");
        this.attachments.markExited(sessionId, exitCode);
        this.publish();
      }),
      this.client.onSessionClosed(({ sessionId }) => {
        if (this.sessions.delete(sessionId)) {
          this.sessionsRevision += 1;
        }
        this.settleResumeWait(sessionId, "gone");
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

  /// Plain "new tab": resolve the cwd from the settings policy — the default
  /// policies never prompt. Ask policies route to the folder searcher (when
  /// the UI registered one) or the native dialog.
  createTab = async (options: {
    groupId: string | null;
    profile: string | null;
  }): Promise<void> => {
    this.setNotice(null);
    const settings = this.settings.getSnapshot();
    const profile = options.profile ?? settings.defaultProfile;
    const policy = settings.newTabPolicy;

    if (policy === "ask-searcher" && this.folderSearchHandler) {
      this.folderSearchHandler({ groupId: options.groupId, profile });
      return;
    }
    if (policy === "ask-searcher" || policy === "ask-native") {
      await this.createTabViaNativeDialog({ groupId: options.groupId, profile });
      return;
    }

    const key = scopeKeyFor(options.groupId);
    const candidates = newTabCwdCandidates(
      this.uiState.getSnapshot().scopePaths,
      key,
      policy,
      policy === "active-tab" ? this.activeTabCwdInScope(key) : null,
    );
    try {
      const created = await this.createSessionDownChain(profile, candidates);
      await this.addSessionTab(created, options.groupId);
    } catch {
      this.setNotice("The terminal session could not be created.");
    }
  };

  /// Direct create with a known folder (searcher palette / Browse…).
  createTabWithCwd = async (options: {
    groupId: string | null;
    profile: string | null;
    cwd: string;
  }): Promise<void> => {
    this.setNotice(null);
    const profile =
      options.profile ?? this.settings.getSnapshot().defaultProfile;
    try {
      const created = await this.createSessionDownChain(profile, [options.cwd, null]);
      await this.addSessionTab(created, options.groupId);
    } catch {
      this.setNotice("The terminal session could not be created.");
    }
  };

  /// Native folder dialog → new tab (the searcher's Browse… escape hatch and
  /// the ask policies' fallback).
  createTabViaNativeDialog = async (target: FolderSearchTarget): Promise<void> => {
    this.setNotice(null);
    const profile =
      target.profile ?? this.settings.getSnapshot().defaultProfile;
    try {
      const created = await pickFolderAndCreateSession(
        { client: this.client, pickFolder: this.pickFolder },
        { profile, picker: { title: "Open folder for new terminal" } },
      );
      if (created) {
        await this.addSessionTab(created, target.groupId);
      }
    } catch {
      this.setNotice("The terminal session could not be created.");
    }
  };

  /// Resume an LLM session (spec §5): validate, open a tab in the session's
  /// directory, wait for the shell's prompt, then type the resume command.
  ///
  /// The command is built from the record's provider and id ALONE, and only
  /// after `resumeCommand` validates the id — a record whose id is anything
  /// but `[A-Za-z0-9-]+` is refused here, before a terminal exists. Claude
  /// sessions are keyed to their project directory, so a vanished cwd is a
  /// refusal; codex threads are keyed globally, so theirs degrades to the host
  /// default directory.
  resumeSession = async (record: LlmSessionRecord): Promise<void> => {
    this.setNotice(null);
    const command = resumeCommand(record);
    if (command === null) {
      this.setNotice("That session cannot be resumed: its id is not valid.");
      return;
    }

    const recorded = record.cwd && record.cwd.length > 0 ? record.cwd : null;
    const cwd = recorded !== null && (await this.probeDir(recorded))
      ? recorded
      : null;
    if (cwd === null && record.provider === "claude") {
      this.setNotice(
        recorded === null
          ? "This session has no recorded folder, so it cannot be resumed."
          : `The session's folder no longer exists (${recorded}).`,
      );
      return;
    }

    const profile = this.settings.getSnapshot().defaultProfile;
    let created: SessionInfo;
    try {
      created = await this.createSessionDownChain(
        profile,
        cwd === null ? [null] : [cwd, null],
      );
    } catch {
      this.setNotice("The terminal session could not be created.");
      return;
    }

    // Arm the waiter before the session is attached: once a terminal binds to
    // it, its first OSC 9;9 report can land inside any later await.
    const awaitPrompt = this.settings.getSnapshot().shellIntegration;
    const ready = this.armResumeWait(
      created.id,
      awaitPrompt ? RESUME_PROMPT_TIMEOUT_MS : RESUME_FIXED_DELAY_MS,
      awaitPrompt,
    );
    try {
      await this.addSessionTab(created, null);
    } catch {
      this.settleResumeWait(created.id, "gone");
      await ready;
      this.setNotice("The terminal session could not be created.");
      return;
    }

    if ((await ready) === "gone") {
      this.setNotice("The terminal ended before the session could be resumed.");
      return;
    }
    const sent = this.attachments.sendInput?.(created.id, `${command}\r`) ?? false;
    if (!sent) {
      this.setNotice("The resume command could not be sent to the terminal.");
    }
  };

  /// Recorded dims per session for reattach-before-replay (spec §13): the
  /// hub's live resize record wins (the dims the pty actually ran at), the
  /// host's creation-time SessionInfo is the fallback for sessions no
  /// terminal has resized yet this run.
  sessionDims = (
    sessionIds: readonly number[],
  ): Readonly<Record<number, { cols: number; rows: number }>> => {
    const dims: Record<number, { cols: number; rows: number }> = {};
    for (const sessionId of sessionIds) {
      const recorded = this.attachments.lastDims?.(sessionId) ?? null;
      const info = this.sessions.get(sessionId);
      const chosen =
        recorded ?? (info ? { cols: info.cols, rows: info.rows } : null);
      if (chosen !== null) {
        dims[sessionId] = chosen;
      }
    }
    return dims;
  };

  /// The UI registers the folder-search palette opener here; without one the
  /// ask-searcher policy falls back to the native dialog.
  setFolderSearchHandler = (
    handler: ((target: FolderSearchTarget) => void) | null,
  ): void => {
    this.folderSearchHandler = handler;
  };

  /// OSC 9;9 cwd report from a pane. Session cwd always follows (including
  /// replay-derived reports); scope active paths and recents move only on
  /// LIVE reports so relaunch replay can't clobber newer persisted state.
  reportSessionCwd = (sessionId: number, path: string, live: boolean): void => {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.cwd !== path) {
      this.sessions.set(sessionId, { ...existing, cwd: path });
      this.sessionsRevision += 1;
      this.publish();
    }
    if (!live) {
      return;
    }
    // A LIVE report is the prompt-ready signal a pending resume waits for
    // (spec §5 step 3); replayed reports say nothing about the prompt.
    this.settleResumeWait(sessionId, "ready");
    const key = this.scopeKeyOfSession(sessionId);
    if (key === null) {
      return;
    }
    this.uiState.update((state) =>
      touchRecentFolder(
        updateScopePaths(state, (paths) => reportScopeCwd(paths, key, path)),
        path,
      ),
    );
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
    } else {
      this.uiState.update((state) =>
        updateScopePaths(state, (paths) => dropScope(paths, groupId)),
      );
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
      let rolledBack = true;
      try {
        await this.client.closeSession(created.id);
      } catch {
        rolledBack = false;
      }
      if (rolledBack) {
        this.sessions.delete(created.id);
        this.sessionsRevision += 1;
        this.attachments.forgetSession(created.id);
      }
      // On close failure the host still owns a live session: keep tracking it
      // (restore reconciliation re-adopts orphans) instead of forgetting it
      // into an invisible leak.
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

  /// Spec §16 merge: the source tab's whole split subtree becomes a new
  /// right-hand sibling inside the target tab, and the source tab leaves the
  /// rail. Pure layout surgery — NO session is created, killed, attached, or
  /// detached; the moved panes remount and replay their scrollback. The target
  /// stays the active tab; UI pane focus belongs on the merged-in subtree,
  /// which is always `tabs[targetTabId].split.children[1]`.
  mergeTabs = (sourceTabId: string, targetTabId: string): void => {
    const merged = mergeTabIntoTab(this.store.getState(), sourceTabId, targetTabId);
    if (merged === null) {
      this.setNotice("The tabs could not be combined.");
      return;
    }
    this.setNotice(null);
    this.mutate("structural", () => this.store.replaceState(merged));
  };

  /// Spec §16 extract, the undo of a merge: the pane leaves its split (single
  /// -child splits collapse) and becomes its own tab right after the source, in
  /// the same group, which then takes focus. Sessions are untouched here too.
  ///
  /// A refusal (unknown tab/session, or the tab's only pane — which is already
  /// its own tab) is a silent no-op: the affordance is hidden for a lone pane,
  /// so there is nothing to explain.
  popOutPane = (tabId: string, sessionId: number): void => {
    const newTabId = this.generateId();
    const extracted = extractSessionToTab(
      this.store.getState(),
      tabId,
      sessionId,
      newTabId,
    );
    if (extracted === null) {
      return;
    }
    this.setNotice(null);
    this.mutate("structural", () =>
      this.store.replaceState({ ...extracted, activeTabId: newTabId })
    );
  };

  flush = (): Promise<void> => this.persistence.flush();

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const sessionId of [...this.resumeWaiters.keys()]) {
      this.settleResumeWait(sessionId, "gone");
    }
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
    if (session.cwd) {
      const cwd = session.cwd;
      this.uiState.update((state) =>
        touchRecentFolder(
          updateScopePaths(state, (paths) =>
            seedScope(paths, scopeKeyFor(targetGroupId), cwd),
          ),
          cwd,
        ),
      );
    }
    this.publish();
  }

  /// The injected probe is renderer code that can throw; a resume must never
  /// surface an exception, and an unanswerable probe means "not there".
  private async probeDir(path: string): Promise<boolean> {
    try {
      return await this.dirExists(path);
    } catch {
      return false;
    }
  }

  /// One-shot prompt waiter for a just-created session. Settles on the first
  /// LIVE cwd report (`awaitPrompt`), on the timer, or on the session dying —
  /// whichever comes first — and always unregisters itself, so nothing is left
  /// holding a timer or a promise once the resume is over.
  private armResumeWait(
    sessionId: number,
    timeoutMs: number,
    awaitPrompt: boolean,
  ): Promise<ResumeWaitOutcome> {
    this.settleResumeWait(sessionId, "gone");
    return new Promise<ResumeWaitOutcome>((resolve) => {
      const timer = setTimeout(
        () => this.settleResumeWait(sessionId, "elapsed"),
        timeoutMs,
      );
      const waiter: ResumeWaiter = {
        awaitPrompt,
        settle: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
      };
      this.resumeWaiters.set(sessionId, waiter);
    });
  }

  private settleResumeWait(sessionId: number, outcome: ResumeWaitOutcome): void {
    const waiter = this.resumeWaiters.get(sessionId);
    if (!waiter || (outcome === "ready" && !waiter.awaitPrompt)) {
      return;
    }
    this.resumeWaiters.delete(sessionId);
    waiter.settle(outcome);
  }

  /// Cwd of the globally active tab, when that tab belongs to the scope a
  /// new tab targets. Falls back to the group-active chain otherwise.
  private activeTabCwdInScope(key: ScopeKey): string | null {
    const layout = this.store.getState();
    const activeTabId = layout.activeTabId;
    if (!activeTabId) {
      return null;
    }
    const inScope =
      key === scopeKeyFor(null)
        ? layout.ungroupedTabIds.includes(activeTabId)
        : layout.groups.some(
            (group) => group.id === key && group.tabIds.includes(activeTabId),
          );
    if (!inScope) {
      return null;
    }
    const tab = layout.tabs[activeTabId];
    if (!tab) {
      return null;
    }
    return this.sessions.get(firstSessionId(tab.split))?.cwd ?? null;
  }

  private scopeKeyOfSession(sessionId: number): ScopeKey | null {
    const layout = this.store.getState();
    const tabHasSession = (tabId: string): boolean => {
      const tab = layout.tabs[tabId];
      return tab !== undefined && sessionIdsInTab(tab).includes(sessionId);
    };
    if (layout.ungroupedTabIds.some(tabHasSession)) {
      return scopeKeyFor(null);
    }
    for (const group of layout.groups) {
      if (group.tabIds.some(tabHasSession)) {
        return group.id;
      }
    }
    return null;
  }

  /// Try CreateSession down a cwd candidate chain (ending in null = host
  /// default dir) so a stale-but-remembered path can never fail creation on
  /// its own. Throws only when every candidate fails.
  private async createSessionDownChain(
    profile: string | null,
    candidates: ReadonlyArray<string | null>,
  ): Promise<SessionInfo> {
    let lastError: unknown = new Error("no cwd candidates");
    for (const cwd of candidates) {
      try {
        return await createSessionWithCwd(this.client, { profile, cwd });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
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
