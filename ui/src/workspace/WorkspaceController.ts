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
import { sessionKey, type LlmSessionRecord, type SessionKey } from "../conversations/types";
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
  canMoveItem,
  collectSubtreeTabIds,
  findContainer,
  groupDepth,
  sessionIdsInLayout,
  type FillStrength,
  type Item,
  type LayoutV2,
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
  pathToPaneNode,
  pruneSessionIds,
  removeGroupAndTabs,
  reorderGroup as reorderLayoutGroup,
  replaceSessionInTab,
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
  record(layout: LayoutV2, kind: LayoutChangeKind): void;
  flush(): Promise<void>;
  dispose(): void;
}

export interface SidebarTabModel {
  id: string;
  /** Immediate parent group, null at the root. */
  groupId: string | null;
  title: string;
  color: PaletteId;
  fill: FillStrength;
  primarySessionId: number;
  sessionIds: readonly number[];
  status: "live" | "dead" | "missing" | "attach_error";
  activity: "idle" | "active" | "unread";
  profile: string | null;
  cwd: string | null;
}

export interface SidebarGroupModel {
  id: string;
  /** Immediate parent group, null at the root. */
  parentGroupId: string | null;
  name: string;
  collapsed: boolean;
  color: PaletteId | null;
  /** Nesting level, 1 for a root group — mirrors `groupDepth`. */
  depth: number;
  /** Ordered children as rendered: tabs and subgroups interleaved. */
  items: readonly SidebarItemModel[];
  /** This group's own tabs (NOT its subgroups'), in order. */
  tabs: readonly SidebarTabModel[];
}

/// One rendered sidebar row and, for a group, everything under it.
export type SidebarItemModel =
  | { kind: "tab"; tab: SidebarTabModel }
  | { kind: "group"; group: SidebarGroupModel };

/// Per-pane projection for the split renderer. "dead" = the host still knows
/// the session (scrollback ring intact, exit code may be known); "missing" =
/// the layout references a session the host no longer has.
export interface PaneSessionState {
  status: "live" | "dead" | "missing";
  exitCode: number | null;
}

export interface WorkspaceSnapshot {
  layout: LayoutV2;
  /** Top level of the sidebar, in order — the recursive render's entry point. */
  rootItems: readonly SidebarItemModel[];
  /** Root-level tabs only, in order. */
  ungroupedTabs: readonly SidebarTabModel[];
  /** EVERY group, depth-first in render order (menus and lookups). */
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

/**
 * Outcome of `resumeSession` (polish spec P6). "refused" covers every
 * pre-existing validation/notice failure (bad id, vanished folder, creation
 * failure, the terminal dying before the prompt arrived) — the caller still
 * reads the notice for the reason; "already-open" means a live tab from an
 * earlier resume of the same session was found and nothing new was created;
 * "opened" means a fresh tab now holds this resume (whether or not the
 * resume command itself was successfully typed into it — a `notice` still
 * reports that failure separately).
 */
export type ResumeOutcome =
  | { kind: "opened" }
  | { kind: "already-open"; tabId: string }
  | { kind: "refused" };

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
  /// spec P6 dedupe: session key → the tab a successful resume opened for it.
  /// An entry is only ever trusted after re-checking the tab is still live
  /// (`isTabLive`); it is also proactively dropped the moment that stops
  /// being true — see `purgeResumedTabsNotIn` (every structural mutation)
  /// and `purgeResumedTabForSession` (the exited/closed session listeners) —
  /// so a stale mapping never outlives the tab it names.
  private readonly resumedTabs = new Map<SessionKey, string>();
  private readonly sessions = new Map<number, SessionInfo>();
  private readonly listeners = new Set<() => void>();
  private readonly cleanups: Array<() => void> = [];
  private cachedSnapshot: WorkspaceSnapshot | null = null;
  private cachedLayout: LayoutV2 | null = null;
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
        // A tab's scope is its IMMEDIATE parent group (spec §6), so every
        // container seeds only the tabs it holds directly.
        const seedContainer = (items: readonly Item[], key: ScopeKey) => {
          for (const item of items) {
            if (item.kind === "tab") {
              seedFromTab(item.id, key);
            } else {
              const group = layout.groups[item.id];
              if (group) {
                seedContainer(group.items, group.id);
              }
            }
          }
        };
        seedContainer(layout.rootItems, scopeKeyFor(null));
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
        // Pane death (spec P6): the tab may still be sitting in the layout as
        // "dead" (nothing dismissed it yet), so the generic post-mutation
        // purge in `mutate()` never sees this — check it directly.
        this.purgeResumedTabForSession(sessionId);
        this.publish();
      }),
      this.client.onSessionClosed(({ sessionId }) => {
        if (this.sessions.delete(sessionId)) {
          this.sessionsRevision += 1;
        }
        this.settleResumeWait(sessionId, "gone");
        this.attachments.forgetSession(sessionId);
        this.purgeResumedTabForSession(sessionId);
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
        fill: tab.fill,
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

    // One recursive pass builds the render tree; a group met twice (impossible
    // in a valid layout) is skipped so a bad blob can never spin this walk.
    const seenGroups = new Set<string>();
    const projectItems = (
      items: readonly Item[],
      parentGroupId: string | null,
      depth: number,
    ): SidebarItemModel[] => {
      const projected: SidebarItemModel[] = [];
      for (const item of items) {
        if (item.kind === "tab") {
          if (layout.tabs[item.id]) {
            projected.push({ kind: "tab", tab: projectTab(item.id, parentGroupId) });
          }
          continue;
        }
        const group = layout.groups[item.id];
        if (!group || seenGroups.has(group.id)) {
          continue;
        }
        seenGroups.add(group.id);
        const children = projectItems(group.items, group.id, depth + 1);
        const model: SidebarGroupModel = {
          id: group.id,
          parentGroupId,
          name: group.name,
          collapsed: group.collapsed,
          color: group.color,
          depth,
          items: children,
          tabs: children.flatMap((child) => child.kind === "tab" ? [child.tab] : []),
        };
        projected.push({ kind: "group", group: model });
      }
      return projected;
    };
    const rootItems = projectItems(layout.rootItems, null, 1);
    const ungroupedTabs = rootItems.flatMap((item) =>
      item.kind === "tab" ? [item.tab] : []
    );
    // Flat, depth-first in render order: the menus' "Move to…" list.
    const groups: SidebarGroupModel[] = [];
    const collectGroups = (items: readonly SidebarItemModel[]): void => {
      for (const item of items) {
        if (item.kind === "group") {
          groups.push(item.group);
          collectGroups(item.group.items);
        }
      }
    };
    collectGroups(rootItems);
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
      rootItems,
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
    this.moveItem({ kind: "tab", id: tabId }, groupId, index);
  };

  /// Drag/menu move for tabs AND subgroups. Returns false when the move is
  /// refused — the depth setting, a group into its own subtree, an unknown
  /// item or target — in which case nothing is written.
  moveItem = (item: Item, targetGroupId: string | null, index: number): boolean => {
    const layout = this.store.getState();
    if (!canMoveItem(layout, item, targetGroupId, this.maxGroupDepth())) {
      return false;
    }
    this.mutate("structural", () => this.store.moveItem(item, targetGroupId, index));
    return true;
  };

  reorderGroup = (groupId: string, targetIndex: number): void => {
    this.mutate("structural", () =>
      this.store.replaceState(reorderLayoutGroup(this.store.getState(), groupId, targetIndex))
    );
  };

  /// New group inside `parentGroupId` (null = the root). Returns the new
  /// group's id, or null when the depth setting refuses it.
  createGroup = (parentGroupId: string | null, name?: string): string | null => {
    const layout = this.store.getState();
    const depth = parentGroupId === null ? 0 : groupDepth(layout, parentGroupId);
    if (parentGroupId !== null && depth === 0) {
      return null;
    }
    if (depth + 1 > this.maxGroupDepth()) {
      return null;
    }
    const id = this.generateId();
    this.mutate("structural", () => this.store.createGroup({
      id,
      name: name ?? "New group",
      parentGroupId,
    }));
    return this.store.getState().groups[id] ? id : null;
  };

  renameGroup = (groupId: string, name: string): void => {
    this.mutate("structural", () => this.store.renameGroup(groupId, name));
  };

  recolorGroup = (groupId: string, color: PaletteId | null): void => {
    this.mutate("structural", () => this.store.recolorGroup(groupId, color));
  };

  setTabFill = (tabId: string, fill: FillStrength): void => {
    this.mutate("structural", () => this.store.setTabFill(tabId, fill));
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

  /// Resume an LLM session (spec §5, dedupe spec P6): validate, open a tab in
  /// the session's directory, wait for the shell's prompt, then type the
  /// resume command.
  ///
  /// The command is built from the record's provider and id ALONE, and only
  /// after `resumeCommand` validates the id — a record whose id is anything
  /// but `[A-Za-z0-9-]+` is refused here, before a terminal exists. Claude
  /// sessions are keyed to their project directory, so a vanished cwd is a
  /// refusal; codex threads are keyed globally, so theirs degrades to the host
  /// default directory.
  ///
  /// Without `options.force`, a session already mapped to a still-live tab
  /// short-circuits to `already-open` and creates nothing; `force` (the
  /// dialog's "Open anyway") skips that check entirely. Every existing
  /// validation/notice failure now returns `refused` — behavior otherwise
  /// unchanged, including the exact notice text.
  resumeSession = async (
    record: LlmSessionRecord,
    options?: { force?: boolean },
  ): Promise<ResumeOutcome> => {
    this.setNotice(null);
    const key = sessionKey(record);
    if (!options?.force) {
      const existingTabId = this.resumedTabs.get(key);
      if (existingTabId !== undefined) {
        if (this.isTabLive(existingTabId)) {
          return { kind: "already-open", tabId: existingTabId };
        }
        // Stale: the tab closed or its pane died without this map entry
        // having been proactively purged yet (e.g. a mutation this instance
        // never observed). Drop it and fall through to a normal resume.
        this.resumedTabs.delete(key);
      }
    }

    const command = resumeCommand(record);
    if (command === null) {
      this.setNotice("That session cannot be resumed: its id is not valid.");
      return { kind: "refused" };
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
      return { kind: "refused" };
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
      return { kind: "refused" };
    }

    // Arm the waiter before the session is attached: once a terminal binds to
    // it, its first OSC 9;9 report can land inside any later await.
    const awaitPrompt = this.settings.getSnapshot().shellIntegration;
    const ready = this.armResumeWait(
      created.id,
      awaitPrompt ? RESUME_PROMPT_TIMEOUT_MS : RESUME_FIXED_DELAY_MS,
      awaitPrompt,
    );
    let tabId: string;
    try {
      tabId = await this.addSessionTab(created, null);
    } catch {
      this.settleResumeWait(created.id, "gone");
      await ready;
      this.setNotice("The terminal session could not be created.");
      return { kind: "refused" };
    }
    // The tab is live in the layout from this point on — record it before
    // awaiting further so a session death mid-wait purges itself through the
    // normal onSessionExited/onSessionClosed path instead of needing a
    // special case here.
    this.resumedTabs.set(key, tabId);

    if ((await ready) === "gone") {
      this.setNotice("The terminal ended before the session could be resumed.");
      return { kind: "refused" };
    }
    const sent = this.attachments.sendInput?.(created.id, `${command}\r`) ?? false;
    if (!sent) {
      this.setNotice("The resume command could not be sent to the terminal.");
    }
    return { kind: "opened" };
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

  /// Delete a group, either keeping its children (they take its place in its
  /// own container, subgroups included) or closing every session in its whole
  /// subtree first. Unknown groups are a silent no-op.
  deleteGroup = async (
    groupId: string,
    mode: "keep-children" | "close-tabs",
  ): Promise<void> => {
    const layout = this.store.getState();
    const group = layout.groups[groupId];
    if (!group) {
      return;
    }
    if (mode === "keep-children") {
      this.mutate("structural", () => this.store.deleteGroup(groupId));
      this.uiState.update((state) =>
        updateScopePaths(state, (paths) => dropScope(paths, groupId)),
      );
      return;
    }

    const sessionIds = collectSubtreeTabIds(layout, groupId).flatMap((tabId) => {
      const tab = layout.tabs[tabId];
      return tab ? sessionIdsInTab(tab) : [];
    });
    const droppedScopes = [groupId, ...subtreeGroupIdsOf(layout, groupId)];
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
        updateScopePaths(state, (paths) =>
          droppedScopes.reduce((next, id) => dropScope(next, id), paths),
        ),
      );
    }
  };

  /// The sidebar's existing "Close group" affordance.
  closeGroup = (groupId: string): Promise<void> =>
    this.deleteGroup(groupId, "close-tabs");

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

  /// Dead-pane "Restart session" / "New session": create a replacement
  /// session — the dead pane's own profile + cwd for "restart" (falling back
  /// to the host default dir if the cwd went stale), workspace defaults for
  /// "fresh" — swap it into the dead pane's slot, then release the dead
  /// session's scrollback on the host. Returns the new session id so the
  /// caller can focus it, or null on refusal.
  restartPane = async (
    tabId: string,
    deadSessionId: number,
    mode: "restart" | "fresh",
  ): Promise<number | null> => {
    const tab = this.store.getState().tabs[tabId];
    if (!tab || pathToPaneNode(tab.split, deadSessionId) === null) {
      return null;
    }
    const dead = this.sessions.get(deadSessionId);
    if (dead?.alive === true) {
      this.setNotice("This terminal is still running.");
      return null;
    }
    this.setNotice(null);
    const defaultProfile = this.settings.getSnapshot().defaultProfile;
    const profile = mode === "restart"
      ? (dead?.profile ?? defaultProfile)
      : defaultProfile;
    const cwd = mode === "restart" ? (dead?.cwd ?? null) : null;
    let created: SessionInfo;
    try {
      created = await this.createSessionDownChain(
        profile,
        cwd === null ? [null] : [cwd, null],
      );
    } catch {
      this.setNotice("The terminal session could not be created.");
      this.publish();
      return null;
    }
    this.sessions.set(created.id, created);
    this.sessionsRevision += 1;
    try {
      await this.attachments.attachSession(created.id);
    } catch {
      // The hub records the attach error; the new pane surfaces it inline.
    }
    const replaced = replaceSessionInTab(
      this.store.getState(),
      tabId,
      deadSessionId,
      created.id,
    );
    if (replaced === null) {
      // The layout moved underneath the createSession await: roll the new
      // session back the same way splitPane does, so no orphan outlives the
      // refusal (a failed close keeps it tracked for restore reconciliation).
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
      this.setNotice("The pane could not be restarted.");
      this.publish();
      return null;
    }
    this.mutate("structural", () => this.store.replaceState(replaced));
    // Free the dead session's ring. It is already out of the layout, so a
    // close failure only leaves a host-side record that restore
    // reconciliation reaps later — not worth a notice on a successful swap.
    await this.closeSessions([deadSessionId]);
    this.publish();
    return created.id;
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

  /// Returns the id of the tab it just created (the resume flow records it
  /// for dedupe tracking; every other caller ignores the return value).
  private async addSessionTab(session: SessionInfo, groupId: string | null): Promise<string> {
    this.sessions.set(session.id, session);
    this.sessionsRevision += 1;
    await this.attachments.attachSession(session.id);
    const layout = this.store.getState();
    const targetGroupId = groupId !== null && layout.groups[groupId] ? groupId : null;
    const tabId = this.generateId();
    this.mutate("structural", () => this.store.createTab({
      id: tabId,
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
    return tabId;
  }

  /// The user's nesting ceiling for CREATION and MOVEMENT (spec §3). Parsing
  /// is never gated by it — a deeper layout built earlier still works.
  private maxGroupDepth(): number {
    return this.settings.getSnapshot().maxGroupDepth;
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
    // Spec §6: a tab's scope is its IMMEDIATE parent group.
    const parentGroupId = findContainer(layout, { kind: "tab", id: activeTabId });
    const inScope = key === scopeKeyFor(parentGroupId);
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
    for (const [tabId, tab] of Object.entries(layout.tabs)) {
      if (sessionIdsInTab(tab).includes(sessionId)) {
        return scopeKeyFor(findContainer(layout, { kind: "tab", id: tabId }));
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
    return {
      groupId: findContainer(layout, { kind: "tab", id: tabId }),
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

  private mutate(kind: LayoutChangeKind, mutation: () => LayoutV2): void {
    const before = this.store.getState();
    const after = mutation();
    if (after !== before) {
      this.persistence.record(after, kind);
      // Spec P6: every structural tab removal — closeLiveTab, closeGroup,
      // dismissDeadTab, closePane's last-pane case, mergeTabs folding the
      // source tab away — flows through here, so one generic sweep catches
      // all of them instead of a bespoke call at each site.
      this.purgeResumedTabsNotIn(after);
    }
  }

  /// Drops any resume-dedupe entry whose tab id no longer exists in `layout`.
  private purgeResumedTabsNotIn(layout: LayoutV2): void {
    if (this.resumedTabs.size === 0) {
      return;
    }
    for (const [key, tabId] of this.resumedTabs) {
      if (!layout.tabs[tabId]) {
        this.resumedTabs.delete(key);
      }
    }
  }

  /// Pane death (spec P6): `sessionId` just went dead or was forgotten by the
  /// host while its tab is still sitting in the layout (nothing dismissed
  /// it), so `purgeResumedTabsNotIn` never fires. Find the resumed tab that
  /// owns this session, if any, and drop its entry once the tab is no longer
  /// live overall (a split tab with a surviving sibling pane stays mapped).
  private purgeResumedTabForSession(sessionId: number): void {
    if (this.resumedTabs.size === 0) {
      return;
    }
    const layout = this.store.getState();
    for (const [key, tabId] of this.resumedTabs) {
      const tab = layout.tabs[tabId];
      if (!tab || !sessionIdsInTab(tab).includes(sessionId)) {
        continue;
      }
      if (!this.isTabLive(tabId)) {
        this.resumedTabs.delete(key);
      }
    }
  }

  /// True when `tabId` still exists and at least one of its panes is alive —
  /// the same liveness rule `getSnapshot`'s projection uses.
  private isTabLive(tabId: string): boolean {
    const tab = this.store.getState().tabs[tabId];
    if (!tab) {
      return false;
    }
    return sessionIdsInTab(tab).some((id) => this.sessions.get(id)?.alive === true);
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

/// Every group id strictly under `groupId` (its scope entries die with it).
function subtreeGroupIdsOf(layout: LayoutV2, groupId: string): string[] {
  const out: string[] = [];
  const walk = (id: string): void => {
    for (const item of layout.groups[id]?.items ?? []) {
      if (item.kind === "group" && !out.includes(item.id)) {
        out.push(item.id);
        walk(item.id);
      }
    }
  };
  walk(groupId);
  return out;
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
