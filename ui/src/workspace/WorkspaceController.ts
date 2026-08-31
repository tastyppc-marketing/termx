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
  remoteResumeCommand,
  resumeCommand,
  tauriDirExists,
  type DirExists,
} from "../conversations/resume";
import { sessionKey, type LlmSessionRecord, type SessionKey } from "../conversations/types";
import type { EnsureUpResult } from "../plugins/lifecycle";
import type { PluginManifest } from "../plugins/manifest";
import {
  allocatePluginPaneId,
  isPluginPaneId,
  PaneBindingsStore,
  type PluginPaneBinding,
} from "../plugins/paneBindings";
import type { SavedSessionsStore } from "../saved/store";
import type { SavedSession } from "../saved/types";
import { sshConnectCommand } from "../ssh/bootstrap";
import type { SshHost } from "../ssh/types";
import { DEFAULT_SETTINGS, type TermxSettings } from "../settings/settings";
import {
  dropScope,
  newTabCwdCandidates,
  reportScopeCwd,
  scopeKeyFor,
  seedScope,
  type ScopeKey,
} from "./scopePaths";
import {
  setSshPaneState,
  UiStateStore,
  touchRecentFolder,
  updateScopePaths,
} from "./uiState";
import {
  canMoveItem,
  collectSubtreeTabIds,
  findContainer,
  groupDepth,
  MAIN_WINDOW_ID,
  sessionIdsInLayout,
  slotOf,
  windowIds,
  type FillStrength,
  type Item,
  type Layout,
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
  withActiveTab,
} from "./layoutOperations";

export type WorkspaceHostClient = Pick<
  HostClient,
  | "createSession"
  | "closeSession"
  | "onSessionExited"
  | "onSessionClosed"
  | "onError"
> & {
  /**
   * Is anything running inside the session's shell? Optional so existing
   * fakes keep type-checking; absent — or rejected, which is what an older
   * daemon's parse error becomes — reads as "busy", and busy means reattach
   * and type nothing, the pre-probe behavior.
   */
  probeSession?(sessionId: number): Promise<{ alive: boolean; busy: boolean }>;
};

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
  /**
   * Watch a session's decoded live output without owning its terminal
   * (ssh-sessions spec §2); AttachmentHub implements it. Optional so existing
   * hub fakes keep type-checking — a hub without it simply never types a
   * stored ssh password, and the user types it themselves as they always could.
   */
  tapOutput?(
    sessionId: number,
    listener: (text: string) => void,
  ): { dispose(): void };
  /** Mark a pane's terminal-bell attention (optional; hub implements it). */
  noteBell?(sessionId: number): void;
  /** Clear a pane's attention because the user is looking at it. */
  markSeen?(sessionId: number): void;
  onError(listener: (error: Error) => void): () => void;
  close(): void;
}

export interface WorkspacePersistence {
  getSnapshot(): LayoutPersistenceSnapshot;
  subscribe(listener: () => void): () => void;
  record(layout: Layout, kind: LayoutChangeKind): void;
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
  activity: "idle" | "active" | "unread" | "attention";
  /** When the work in this tab went quiet, for an "and it has been done since"
   * badge. Set only while `activity` is "attention". Optional so existing
   * fixtures keep type-checking. */
  attentionSince?: number | null;
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
/// the layout references a session the host no longer has; "plugin" = the pane
/// is a reserved-id plugin panel and has no host session by design.
export interface PaneSessionState {
  status: "live" | "dead" | "missing" | "plugin";
  exitCode: number | null;
  /**
   * The host connection is gone but the session is presumed still running: the
   * pane shows a reconnecting chip and stays live. Optional so the many
   * hand-written pane fixtures keep type-checking; the controller always sets
   * it, and absent reads as "not suspended".
   */
  suspended?: boolean;
  /**
   * From `HubSessionSnapshot.attachGeneration`. The pane remounts its terminal
   * binding whenever this moves — the only way a pane recovers from a
   * reconnect, since a binding cannot be revived once it is disconnected.
   */
  attachGeneration?: number;
  /**
   * From `HubSessionSnapshot.oldestOffset`: where the earlier-output bar starts
   * paging backward. Zero means nothing has been evicted.
   */
  historyBefore?: bigint;
  /** Set only while `status` is "plugin" — which plugin owns this pane. */
  pluginId?: string;
  /**
   * The plugin's loopback ORIGIN (no trailing slash, no panel path), or null
   * while it is starting or down. The renderer appends the manifest's panel
   * path, so the two halves stay separable.
   */
  pluginUrl?: string | null;
  /**
   * A plugin pane's liveness, which comes from the health probe rather than
   * from the daemon: "starting" while ensure-up runs, "up" once the plugin
   * answered, "down" when it could not be reached (→ a Relaunch card).
   */
  pluginHealth?: "starting" | "up" | "down";
  /** Why the plugin is down: the ensure-up reason plus whatever it printed. */
  pluginError?: string;
  /**
   * This pane's own panel path, when its binding pins one (`{pluginId, path}`).
   * Kept separate from `pluginUrl` so the renderer composes origin + path and
   * neither half has to be re-parsed out of the other.
   */
  pluginPanelPath?: string;
}

/**
 * The plugin lifecycle seam (plugin spec §3). Kept to the two questions the
 * controller actually asks — what is this plugin called, and please make sure
 * it is running — so the controller never learns about registries, manifest
 * files, or process spawning.
 */
export interface WorkspacePluginHost {
  /** Manifest for an installed plugin, or null when it is unknown. */
  manifestFor(pluginId: string): PluginManifest | null;
  /** Adopt a running instance or spawn one; never kills what it did not start. */
  ensureUp(pluginId: string): Promise<EnsureUpResult>;
  /**
   * Is this plugin still answering? A pure OBSERVATION — unlike `ensureUp` it
   * must never spawn, because a plugin the user killed has to stay dead until
   * they press Relaunch. Optional: a host without it simply gets no health
   * polling, which is every legacy fixture and any window booted before the
   * seam existed (an open panel then keeps whatever ensure-up last said).
   */
  probe?(pluginId: string): Promise<boolean>;
}

/**
 * What the controller remembers about one plugin's process, shared by every
 * pane bound to it. Not an `EnsureUpResult`: "starting" is a state ensure-up
 * has no value for, and it is the state a freshly opened pane renders in.
 */
interface PluginRuntimeState {
  health: "starting" | "up" | "down";
  url: string | null;
  error?: string;
}

export interface WorkspaceSnapshot {
  layout: Layout;
  /** This window's slot of the sidebar, in order — the recursive render's
   * entry point. A controller renders ONLY its own window's items. */
  rootItems: readonly SidebarItemModel[];
  /** Root-level tabs only, in order (this window's). */
  ungroupedTabs: readonly SidebarTabModel[];
  /** EVERY group in this window, depth-first in render order. */
  groups: readonly SidebarGroupModel[];
  paneStates: Readonly<Record<number, PaneSessionState>>;
  activeTabId: string | null;
  activeSessionId: number | null;
  persistence: LayoutPersistenceSnapshot;
  notice: string | null;
  /** All window ids in the layout, main first (menus' "Move to <window>").
   * Optional so existing fixtures keep type-checking; the controller always
   * sets it, and absent reads as "just the main window". */
  windowIds?: readonly string[];
}

/** Read-only view of live settings (SettingsStore satisfies this). */
export interface SettingsReader {
  getSnapshot(): TermxSettings;
}

/**
 * The slice of the saved-sessions store a resume writes back to: which daemon
 * session the saved entry now names. Narrowed to that one method so the
 * controller can never drift into owning the saved list itself.
 */
export type SavedSessionsRecorder = Pick<SavedSessionsStore, "touchDaemonSession">;

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
  /**
   * Saved sessions (saved-sessions spec). Absent — legacy fixtures, and any
   * caller that does not persist saves — means a `resumeSaved` still resumes
   * exactly as it should; only the "this entry now runs session N" write-back
   * is skipped.
   */
  /**
   * The conversations index, for restart-with-resume on a dead pane: given a
   * directory, the newest resumable conversation that ran there. Optional so
   * harnesses without a conversations store keep type-checking — absent means
   * dead panes offer a plain shell restart only.
   */
  conversations?: {
    latestForCwd(cwd: string): LlmSessionRecord | null;
  };
  /**
   * The conversation a given pane ACTUALLY ran, recorded at the source by the
   * Claude Code SessionStart hook (`tools/claude-hooks/termx-capture.py`).
   * Exact where `conversations.latestForCwd` only guesses — two panes in one
   * folder are indistinguishable to the folder lookup, and a corpse whose cwd
   * the daemon never recorded is invisible to it. Optional: without the hook
   * installed (and in every legacy fixture) the folder fallback is unchanged.
   */
  capturedConversationFor?: (sessionId: number) => LlmSessionRecord | null;
  savedSessions?: SavedSessionsRecorder;
  /**
   * Stored ssh passwords (ssh-sessions spec §2). Absent — or a policy that
   * stores none — means a password host prompts in the terminal and Michael
   * types it himself; the connection is still tracked either way.
   */
  sshPasswords?: { passwordFor(alias: string): Promise<string | null> };
  /**
   * The parsed ssh host inventory, for validating a saved entry's alias against
   * the CURRENT config (ssh-sessions spec §5). Absent — legacy fixtures — skips
   * that check and restores anyway; the ssh error would then be visible in the
   * terminal, which is the same place every other ssh failure surfaces.
   */
  sshHosts?: { byAlias(alias: string): SshHost | null };
  /**
   * Which window's slot this controller renders and mutates (multi-window
   * spec). Default the main window — every pre-multi-window caller.
   */
  windowId?: string;
  /**
   * Reserved-pane → plugin bindings (plugin spec §4). Optional so every legacy
   * fixture keeps type-checking; absent means an empty, unpersisted map, which
   * renders any reserved pane in the layout as a dismissible dead pane — the
   * same degradation as a lost bindings file.
   */
  pluginPanes?: PaneBindingsStore;
  /**
   * The plugin lifecycle. Absent — legacy fixtures, and any window booted
   * without a plugin registry — means the open-plugin actions refuse; existing
   * bindings still render (as "starting", then whatever a relaunch finds).
   */
  plugins?: WorkspacePluginHost;
}

/**
 * How often an on-screen panel re-asks whether its plugin is still there.
 * A plugin is a process TermX does not own — it can be killed from Task
 * Manager and nothing would tell the workspace — so the panel has to ask.
 * 15 s is a loopback round trip per plugin per quarter minute: cheap enough to
 * be free, quick enough that a dead panel is not still pretending minutes later.
 */
export const PLUGIN_HEALTH_INTERVAL_MS = 15_000;

/**
 * How long a replica window waits for the main window to acknowledge a new
 * binding before giving up on the pane (plugin spec §4).
 *
 * Bounded because the alternative is a panel that never opens and never says
 * why: main may be busy, mid-quit, or gone. Generous because the round trip is
 * a bus message plus one small file write, so anything approaching this is
 * already a real fault rather than slowness.
 */
export const PLUGIN_BIND_ADOPT_TIMEOUT_MS = 5_000;

/** How long a connect watches its pane for a password prompt (spec §2). */
export const SSH_PASSWORD_WATCH_MS = 60_000;

/** How much of the tail the prompt matcher keeps — a prompt is one short line. */
const SSH_PASSWORD_TAIL_CHARS = 512;

/**
 * An ssh password prompt: the word "password", then anything but a newline, a
 * colon, and the end of what has arrived so far. Anchored at the END because
 * that is what makes it a PROMPT rather than a mention — `cat password:` in the
 * scrollback is followed by more output, a real prompt is where output stops.
 */
const SSH_PASSWORD_PROMPT = /password[^\n]*:[ \t]*$/i;

/**
 * How long an ssh restore waits for the REMOTE shell's first prompt (spec §5).
 * Far longer than the local wait: this covers dialling a VPS, a key handshake
 * and the bootstrap's own startup, any of which can be slow on a bad link.
 */
export const SSH_REMOTE_PROMPT_TIMEOUT_MS = 45_000;


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
 * reports that failure separately). "opened" carries the ids it created so the
 * caller can open that pane on the boot itself (auto-reveal spec §4).
 */
export type ResumeOutcome =
  | { kind: "opened"; tabId: string; sessionId: number }
  | { kind: "already-open"; tabId: string }
  | { kind: "refused" };

/**
 * One tab a resume is bound to (auto-reveal spec §4): the conversation it was
 * resumed FROM, the tab holding it, and when the resume happened. The stamp is
 * what makes transcript handoff safe — only a transcript written after this
 * moment can be the file `claude --resume` continued into.
 */
export interface ResumedEntry {
  readonly key: SessionKey;
  readonly tabId: string;
  readonly resumedAtMs: number;
}

interface ResumeWaiter {
  settle: (outcome: ResumeWaitOutcome) => void;
  /** False for the fixed-delay path: cwd reports must not shorten the wait. */
  awaitPrompt: boolean;
  /**
   * Which cwd reports count as "ready". Absent = any of them, the local
   * behavior. The ssh restore sets it so the LOCAL shell's prompt cannot settle
   * the wait meant for the REMOTE one — that mistake would type
   * `claude --resume` into Windows powershell (spec §5).
   */
  accept?: (path: string) => boolean;
}

/** True for a rooted Unix path — i.e. a report from the REMOTE shell (§2). */
/** Compare directories the way the chat linkage does: case- and slash-blind,
 * trailing separators ignored. The saved-resume verdict uses this to decide
 * whether an idle shell is still standing in the saved folder. */
export function sameFolder(a: string, b: string): boolean {
  const normalize = (path: string): string =>
    path.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

function isRemoteCwd(path: string): boolean {
  return path.startsWith("/");
}

/** A tracked ssh pane: its host, and the newest conversation captured in it. */
interface SshPaneRecord {
  host: string;
  captured: { provider: "claude" | "codex"; id: string } | null;
}

export class WorkspaceController {
  readonly attachments: WorkspaceAttachmentHub;
  /** Which window's slot this controller renders and mutates. */
  readonly windowId: string;

  private readonly client: WorkspaceHostClient;
  private readonly store: LayoutStore;
  private readonly persistence: WorkspacePersistence;
  private readonly generateId: () => string;
  private readonly pickFolder?: FolderPicker;
  private readonly settings: SettingsReader;
  private readonly uiState: UiStateStore;
  private readonly dirExists: DirExists;
  private readonly conversations?: {
    latestForCwd(cwd: string): LlmSessionRecord | null;
  };
  private readonly capturedConversationFor?: (
    sessionId: number,
  ) => LlmSessionRecord | null;
  private readonly savedSessions: SavedSessionsRecorder | null;
  private readonly sshPasswords:
    | { passwordFor(alias: string): Promise<string | null> }
    | null;
  private readonly sshHosts: { byAlias(alias: string): SshHost | null } | null;
  /// Reserved-pane bindings (plugin spec §4). Always a store, never null, so
  /// every read site is a plain lookup instead of a null dance.
  private readonly pluginPanes: PaneBindingsStore;
  private readonly plugins: WorkspacePluginHost | null;
  /// One entry per plugin, shared by every pane bound to it: a plugin is one
  /// process, so N panes must not mean N spawns or N different health answers.
  private readonly pluginRuntimes = new Map<string, PluginRuntimeState>();
  /// In-flight ensure-up per plugin, so two panes opened in the same breath
  /// join one probe instead of racing two.
  private readonly pluginEnsures = new Map<string, Promise<void>>();
  /// One health poller per plugin with a pane open — never one per pane, or a
  /// four-way split would probe the same process four times a quarter minute.
  private readonly pluginHealthTimers = new Map<string, ReturnType<typeof setInterval>>();
  /// Plugins with a health probe in flight. A slow plugin must not accumulate
  /// probes: the next tick skips rather than queues, so a plugin that takes a
  /// minute to answer is asked once, not four times.
  private readonly pluginHealthProbes = new Set<string>();
  /// Bumped whenever a binding or a plugin's health changes — neither lives in
  /// the layout, so without it the snapshot memo would hand back a stale frame.
  private pluginRevision = 0;
  private cachedPluginRevision = -1;
  /// Tracked ssh panes by session id (spec §2), mirrored into ui state so a
  /// restart still knows which panes are remote.
  private readonly sshPanes = new Map<number, SshPaneRecord>();
  /// Live password watchers by session id, so a pane's death or a second
  /// connect can shut one down. The password itself is never in here — only the
  /// function that stops watching.
  private readonly sshPasswordWatchers = new Map<number, () => void>();
  private folderSearchHandler: ((target: FolderSearchTarget) => void) | null = null;
  /// One-shot resume waiters keyed by the session the resume just created.
  private readonly resumeWaiters = new Map<number, ResumeWaiter>();
  /// spec P6 dedupe: session key → the tab a successful resume opened for it,
  /// plus WHEN it opened (auto-reveal spec §4 — the stamp a transcript handoff
  /// is judged against).
  /// An entry is only ever trusted after re-checking the tab is still live
  /// (`isTabLive`); it is also proactively dropped the moment that stops
  /// being true — see `purgeResumedTabsNotIn` (every structural mutation)
  /// and `purgeResumedTabForSession` (the exited/closed session listeners) —
  /// so a stale mapping never outlives the tab it names.
  private readonly resumedTabs = new Map<
    SessionKey,
    { tabId: string; resumedAtMs: number }
  >();
  /// The chat registers here to learn that a pane is BOOTING an agent, so it
  /// can open on the boot rather than hiding it behind bubbles (spec §4).
  private resumeBootListener: ((sessionId: number) => void) | null = null;
  private readonly sessions = new Map<number, SessionInfo>();
  private readonly listeners = new Set<() => void>();
  private readonly cleanups: Array<() => void> = [];
  private cachedSnapshot: WorkspaceSnapshot | null = null;
  private cachedLayout: Layout | null = null;
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
      // Optional members must be forwarded as optional: a wrapper that grew a
      // probeSession the raw client lacks would claim a capability the daemon
      // does not have.
      ...(rawClient.probeSession
        ? { probeSession: (sessionId: number) => rawClient.probeSession!(sessionId) }
        : {}),
    };
    this.windowId = options.windowId ?? MAIN_WINDOW_ID;
    this.store = options.store;
    this.persistence = options.persistence;
    this.attachments = options.attachments;
    this.generateId = options.generateId ?? (() => crypto.randomUUID());
    this.pickFolder = options.pickFolder;
    this.settings = options.settings ?? { getSnapshot: () => DEFAULT_SETTINGS };
    this.uiState = options.uiState ?? new UiStateStore();
    this.dirExists = options.dirExists ?? tauriDirExists;
    this.savedSessions = options.savedSessions ?? null;
    this.conversations = options.conversations;
    this.capturedConversationFor = options.capturedConversationFor;
    this.sshPasswords = options.sshPasswords ?? null;
    this.sshHosts = options.sshHosts ?? null;
    this.pluginPanes = options.pluginPanes
      ?? new PaneBindingsStore({ initial: {}, save: null });
    this.plugins = options.plugins ?? null;
    for (const session of options.sessions) {
      this.sessions.set(session.id, session);
    }
    this.hydrateSshPanes();

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
        // Every window's slot seeds: a tab torn out into an aux window keeps
        // the root scope, and its groups keep their own.
        for (const windowId of windowIds(layout)) {
          seedContainer(slotOf(layout, windowId)!.rootItems, scopeKeyFor(null));
        }
        return next;
      }),
    );

    this.cleanups.push(
      this.store.subscribe(() => this.publish()),
      this.persistence.subscribe(() => this.publish()),
      this.attachments.subscribe(() => this.publish()),
      // A binding can change without this window doing anything: in an aux
      // window every binding arrives as a broadcast from main.
      this.pluginPanes.subscribe(() => {
        this.pluginRevision += 1;
        // An aux window learns its bindings from main's broadcast, so this is
        // where a restored panel in THIS window first becomes startable.
        this.kickBoundPlugins();
        this.publish();
      }),
      this.client.onSessionExited(({ sessionId, exitCode }) => {
        const existing = this.sessions.get(sessionId);
        if (existing) {
          this.sessions.set(sessionId, { ...existing, alive: false });
          this.sessionsRevision += 1;
        }
        this.settleResumeWait(sessionId, "gone");
        // Nothing may be typed into a shell that is gone — least of all a
        // password (spec §2).
        this.stopSshPasswordWatch(sessionId);
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
        this.stopSshPasswordWatch(sessionId);
        // The host has forgotten this session for good, so its ssh identity
        // goes too — a stale entry would make some later pane look remote.
        // (Ids are never reused — registry.rs keeps a monotonic watermark
        // across restarts — but hygiene here costs nothing.)
        this.forgetSshPane(sessionId);
        this.attachments.forgetSession(sessionId);
        this.purgeResumedTabForSession(sessionId);
        this.publish();
      }),
      this.client.onError(() => {
        this.setNotice("The terminal host reported an error.");
      }),
    );

    // Restored panels (spec §4): a bound pane's liveness comes from the health
    // probe, and `ensurePluginUp` is otherwise reached ONLY by opening or
    // relaunching a panel. Without this, the second launch of TermX renders
    // every restored panel as a spinner for ever — and T6's starting card has
    // no Relaunch button, so there is no way out but dismissing the pane.
    // Fire-and-forget: each pane shows "starting" until its answer lands.
    this.kickBoundPlugins();
  }

  /**
   * Start every plugin that a pane in the CURRENT layout is bound to, once
   * each. Bindings whose pane is not in the layout are skipped deliberately:
   * those are orphans for the boot prune to clear, and starting a process for
   * a pane nobody can see would launch a plugin the user never asked for.
   *
   * Idempotent — `ensurePluginUp` skips a plugin it has already answered for —
   * so it can run again whenever the bindings change.
   */
  private kickBoundPlugins(): void {
    if (this.plugins === null) {
      return;
    }
    const bindings = this.pluginPanes.getSnapshot();
    if (Object.keys(bindings).length === 0) {
      return;
    }
    const inLayout = new Set(sessionIdsInLayout(this.store.getState()));
    const started = new Set<string>();
    for (const [key, binding] of Object.entries(bindings)) {
      if (!inLayout.has(Number(key)) || started.has(binding.pluginId)) {
        continue;
      }
      started.add(binding.pluginId);
      void this.ensurePluginUp(binding.pluginId);
    }
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
      this.cachedPluginRevision === this.pluginRevision &&
      this.cachedNotice === this.notice
    ) {
      return this.cachedSnapshot;
    }

    const bindings = this.pluginPanes.getSnapshot();
    /// A reserved pane counts as a panel only WITH a binding: without one it is
    /// the dismissible dead pane the downgrade rule requires (spec §4).
    const boundPlugin = (sessionId: number): PluginPaneBinding | null => {
      if (!isPluginPaneId(sessionId)) {
        return null;
      }
      return bindings[String(sessionId)] ?? null;
    };

    const projectTab = (tabId: string, groupId: string | null): SidebarTabModel => {
      const tab = layout.tabs[tabId]!;
      const sessionIds = sessionIdsInTab(tab);
      const primarySessionId = firstSessionId(tab.split);
      const primary = this.sessions.get(primarySessionId);
      // A bound plugin pane keeps its tab alive in the rail: it has no host
      // session, but it is not a corpse either, and a tab marked dead offers a
      // Dismiss the user would lose a working panel to.
      const live = sessionIds.some(
        (id) => this.sessions.get(id)?.alive === true || boundPlugin(id) !== null,
      );
      const knownDead = sessionIds.some((id) => {
        const info = this.sessions.get(id);
        return info !== undefined && !info.alive;
      });
      const attachError = sessionIds.some((id) => attachments.sessions[id]?.attachError);
      const unread = sessionIds.some((id) => attachments.sessions[id]?.unread);
      const active = sessionIds.some((id) => attachments.sessions[id]?.active);
      const attention = sessionIds.some((id) => attachments.sessions[id]?.settled);
      // The oldest still-unseen finish in the tab: a split whose first pane
      // stopped twenty minutes ago has been waiting twenty minutes, even if a
      // second pane only just went quiet.
      let attentionSince: number | null = null;
      for (const id of sessionIds) {
        const session = attachments.sessions[id];
        if (!session?.settled) {
          continue;
        }
        const at = session.settledAt ?? null;
        if (at !== null && (attentionSince === null || at < attentionSince)) {
          attentionSince = at;
        }
      }
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
        // Attention outranks everything: "finished, look at me" is the one
        // state the user asked to be told about. Streaming shows as active;
        // the settle mark only exists once streaming stopped.
        activity: attention
          ? "attention"
          : (unread ? "unread" : (active ? "active" : "idle")),
        attentionSince: attention ? attentionSince : null,
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
    // Only this window's slot is projected: each window renders its own rail.
    const slot = slotOf(layout, this.windowId);
    const rootItems = projectItems(slot?.rootItems ?? [], null, 1);
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
      const binding = boundPlugin(sessionId);
      if (binding !== null) {
        const pluginId = binding.pluginId;
        // No host session exists for this id and none ever will, so the daemon
        // sweep below would call it "missing" forever. Its liveness is the
        // plugin's health instead.
        const runtime = this.pluginRuntimes.get(pluginId);
        paneStates[sessionId] = {
          status: "plugin",
          exitCode: null,
          pluginId,
          pluginUrl: runtime?.url ?? null,
          pluginHealth: runtime?.health ?? "starting",
          ...(runtime?.error !== undefined ? { pluginError: runtime.error } : {}),
          ...(binding.path !== undefined ? { pluginPanelPath: binding.path } : {}),
        };
        continue;
      }
      const info = this.sessions.get(sessionId);
      const attachment = attachments.sessions[sessionId];
      if (info?.alive === true) {
        paneStates[sessionId] = {
          status: "live",
          exitCode: null,
          suspended: attachment?.suspended ?? false,
          attachGeneration: attachment?.attachGeneration ?? 0,
          historyBefore: attachment?.oldestOffset ?? 0n,
        };
      } else if (info !== undefined) {
        paneStates[sessionId] = {
          status: "dead",
          exitCode: attachment?.exitCode ?? null,
        };
      } else {
        paneStates[sessionId] = { status: "missing", exitCode: null };
      }
    }
    const activeTabId = slot?.activeTabId ?? null;
    const activeTab = activeTabId ? layout.tabs[activeTabId] : undefined;
    const snapshot: WorkspaceSnapshot = {
      layout,
      rootItems,
      ungroupedTabs,
      groups,
      paneStates,
      activeTabId,
      activeSessionId: activeTab ? firstSessionId(activeTab.split) : null,
      persistence,
      notice: this.notice,
      windowIds: windowIds(layout),
    };
    this.cachedSnapshot = snapshot;
    this.cachedLayout = layout;
    this.cachedAttachments = attachments;
    this.cachedPersistence = persistence;
    this.cachedSessionsRevision = this.sessionsRevision;
    this.cachedPluginRevision = this.pluginRevision;
    this.cachedNotice = this.notice;
    return snapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  activateTab = (tabId: string): void => {
    this.mutate("active_tab", () => this.store.setActiveTab(tabId, this.windowId));
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
    this.mutate("structural", () =>
      this.store.moveItem(item, targetGroupId, index, this.windowId)
    );
    return true;
  };

  /// Multi-window spec: re-parent a tab or group into another window's root.
  /// `"new"` allocates the next free `aux-<n>` slot. Returns the target window
  /// id, or null when the store refused the move.
  moveItemToWindow = (item: Item, target: string | "new"): string | null => {
    const targetWindowId = target === "new"
      ? this.allocateAuxWindowId()
      : target;
    const before = this.store.getState();
    let after: Layout = before;
    this.mutate("structural", () => {
      after = this.store.moveItemToWindow(item, targetWindowId);
      return after;
    });
    return after === before ? null : targetWindowId;
  };

  /// An aux window is closing: its items come home to the main rail and the
  /// slot disappears. Sessions never notice (spec: close-returns-to-main).
  returnWindowToMain = (windowId: string): void => {
    this.mutate("structural", () => this.store.returnWindowToMain(windowId));
  };

  /// This aux window moved or resized (already debounced upstream): remember
  /// its outer bounds so relaunch restores the position. Main's bounds are
  /// not tracked — the OS restores the primary window as it always has.
  recordWindowBounds = (bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): void => {
    if (this.windowId === MAIN_WINDOW_ID) {
      return;
    }
    this.mutate("structural", () =>
      this.store.setWindowBounds(this.windowId, bounds)
    );
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
      const existing = this.resumedTabs.get(key);
      if (existing !== undefined) {
        if (this.isTabLive(existing.tabId)) {
          return { kind: "already-open", tabId: existing.tabId };
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

    // The tab is recorded for dedupe the moment it exists — before the prompt
    // wait — so a session death mid-wait purges itself through the normal
    // onSessionExited/onSessionClosed path instead of needing a special case.
    const opened = await this.openResumedTab(created, command, (tabId) => {
      this.rememberResumedTab(key, tabId);
    });
    // The binding written above IS the tab that opened — read it back rather
    // than smuggling the id out of the callback.
    const openedTabId = this.resumedTabs.get(key)?.tabId;
    if (!opened || openedTabId === undefined) {
      return { kind: "refused" };
    }
    // Only a boot that actually happened is announced: a pane whose resume was
    // refused has nothing to reveal.
    this.announceResumeBoot(created.id);
    return { kind: "opened", tabId: openedTabId, sessionId: created.id };
  };

  /// What should clicking an alive saved row do? Decided by the daemon's
  /// busy probe (triage P0 #1):
  ///   - a bare-shell save, a busy shell, or an unanswerable probe (old
  ///     daemon, error) -> "reattach": type NOTHING into a shell that may
  ///     have an agent in it;
  ///   - idle in the saved folder -> "resume_in_place";
  ///   - idle anywhere else -> "restore_fresh" (a saved session IS its
  ///     folder). An ssh save's cwd is remote, so an idle local shell can
  ///     never match it — idle ssh saves always restore fresh, through the
  ///     ssh path.
  private async aliveSaveVerdict(
    entry: SavedSession,
    sessionId: number,
  ): Promise<"reattach" | "resume_in_place" | "restore_fresh"> {
    if (!entry.conversation && !entry.ssh) {
      return "reattach"; // a bare shell IS the thing that was saved
    }
    const probe = this.client.probeSession;
    if (!probe) {
      return "reattach";
    }
    let busy: boolean;
    try {
      const result = await probe.call(this.client, sessionId);
      if (!result.alive) {
        return "restore_fresh"; // died between the snapshot and the probe
      }
      busy = result.busy;
    } catch {
      return "reattach"; // an unanswerable probe must never type
    }
    if (busy) {
      return "reattach";
    }
    if (entry.ssh) {
      return "restore_fresh";
    }
    const shellCwd = this.sessionCwd(sessionId);
    return shellCwd !== null && sameFolder(shellCwd, entry.cwd)
      ? "resume_in_place"
      : "restore_fresh";
  }

  /// Resume a saved session (saved-sessions spec §"Resume flow"). Three shapes:
  ///
  /// 1. REATTACH. The daemon still runs the terminal the save came from AND
  ///    something is still running inside that shell (the probe says busy, or
  ///    cannot say — an old daemon, a failed probe — or the save is a bare
  ///    shell): focus the tab that holds it, or open a tab onto it when the
  ///    layout has none. Nothing is created and NOTHING is typed.
  /// 2. RESUME IN PLACE. The saved shell is alive but IDLE at its prompt, in
  ///    the saved folder, and the save carries a conversation: the resume
  ///    command is typed into that same shell. This is the everyday case the
  ///    old reattach got wrong — quit claude, come back later, click the row,
  ///    and "reattach" used to deliver a silent empty shell (triage P0 #1).
  /// 3. FRESH RESTORE. A new shell in the saved folder, then the provider's
  ///    resume command once the prompt reports (a bare-shell save types
  ///    nothing at all, and does not wait for a prompt it has no use for).
  ///    Also where an idle-but-wandered shell lands: a saved session IS its
  ///    folder, so a shell that has cd'd elsewhere no longer counts as it.
  ///
  /// A saved session IS its folder — claude conversations are keyed to their
  /// project directory and the user pinned this one deliberately — so a
  /// vanished folder is a refusal, never a shell somewhere else, and the host
  /// default directory is never a fallback here.
  resumeSaved = async (entry: SavedSession): Promise<void> => {
    this.setNotice(null);

    const recordedSessionId = entry.lastDaemonSessionId;
    if (
      recordedSessionId !== undefined &&
      this.sessions.get(recordedSessionId)?.alive === true
    ) {
      const verdict = await this.aliveSaveVerdict(entry, recordedSessionId);
      if (verdict !== "restore_fresh") {
        const existingTabId = this.tabHoldingSession(recordedSessionId);
        if (existingTabId !== null) {
          this.activateTab(existingTabId);
        } else {
          // Alive but tabless: the session outlived its tab (a merge, a
          // dismissed layout, a restore that dropped it). Give it a tab back
          // rather than starting a second shell beside it.
          try {
            await this.addSessionTab(
              this.sessions.get(recordedSessionId)!,
              null,
            );
          } catch {
            this.setNotice("The saved session could not be reopened.");
            return;
          }
        }
        if (verdict === "resume_in_place") {
          // The shell is idle at its prompt in the saved folder — no prompt
          // wait is needed or possible (its report already happened).
          const command = resumeCommand(entry.conversation!);
          if (command === null) {
            this.setNotice(
              "That session cannot be resumed: its id is not valid.",
            );
            return;
          }
          const sent =
            this.attachments.sendInput?.(recordedSessionId, command + "\r") ??
            false;
          if (!sent) {
            this.setNotice(
              "The resume command could not be sent to the terminal.",
            );
            return;
          }
          const tabId = this.tabHoldingSession(recordedSessionId);
          if (tabId !== null) {
            this.rememberResumedTab(sessionKey(entry.conversation!), tabId);
          }
          this.announceResumeBoot(recordedSessionId);
        }
        this.recordDaemonSession(entry, recordedSessionId);
        return;
      }
      // restore_fresh falls through: the saved shell is idle but standing in
      // the wrong folder, so it no longer counts as the saved session.
    }

    // The command is built from the provider and id ALONE, and only after
    // `resumeCommand` validates the id — a corrupt store row is refused here,
    // before a terminal exists.
    const conversation = entry.conversation;
    let command: string | null = null;
    if (conversation) {
      command = resumeCommand(conversation);
      if (command === null) {
        this.setNotice("That session cannot be resumed: its id is not valid.");
        return;
      }
    }

    // An ssh entry's `cwd` is REMOTE, so there is nothing local to probe and no
    // local shell to open in it (spec §5).
    const ssh = entry.ssh;
    if (ssh) {
      await this.resumeSavedOverSsh(entry, ssh.host);
      return;
    }

    if (!(await this.probeDir(entry.cwd))) {
      this.setNotice(
        `The saved session's folder no longer exists (${entry.cwd}).`,
      );
      return;
    }

    const profile = this.settings.getSnapshot().defaultProfile;
    let created: SessionInfo;
    try {
      created = await this.createSessionDownChain(profile, [entry.cwd]);
    } catch {
      this.setNotice("The terminal session could not be created.");
      return;
    }

    const opened = await this.openResumedTab(created, command, (tabId) => {
      if (conversation) {
        this.rememberResumedTab(sessionKey(conversation), tabId);
      }
      this.recordDaemonSession(entry, created.id);
    });
    // A bare-shell restore types nothing, so no agent is booting in it.
    if (opened && command !== null) {
      this.announceResumeBoot(created.id);
    }
  };

  /// One-click connect to an ssh host (ssh-sessions spec §2). Deliberately the
  /// resume machinery again — open a local shell, wait for ITS prompt, type one
  /// command — because that path is already proven against shells that answer
  /// slowly, and because the whole remote bootstrap travels inside that one
  /// command (nothing is installed on the far end).
  ///
  /// The pane is recorded as an ssh pane the moment its tab exists, which is
  /// what later makes it pin-able as a remote save. A stored password is typed
  /// by a bounded watcher over the pane's own output; without one the prompt is
  /// simply left on screen for Michael, and the connection is tracked either
  /// way.
  connectSshHost = async (
    host: SshHost,
    options?: { groupId?: string | null },
  ): Promise<void> => {
    this.setNotice(null);
    // The launcher shell IS the default profile, and the connect command's
    // quoting must match the shell it is typed into (cmd has no single
    // quotes) — so the profile is read first and travels into the command.
    const profile = this.settings.getSnapshot().defaultProfile;
    let command: string;
    try {
      command = sshConnectCommand(host.alias, { localShell: profile });
    } catch {
      // An alias reaches a command line verbatim, so a name that is not a name
      // is refused rather than escaped — before any terminal exists.
      this.setNotice(
        "That SSH host cannot be connected: its alias is not a plain name.",
      );
      return;
    }

    // Read BEFORE the shell exists so the value lives only in this local and
    // in the watcher's closure, never on the controller.
    const password = await this.storedSshPassword(host.alias);
    let created: SessionInfo;
    try {
      // No cwd chain: the local shell is a launcher, and where it starts is
      // invisible — the cwd that matters is the remote one.
      created = await this.createSessionDownChain(profile, [null]);
    } catch {
      this.setNotice("The terminal session could not be created.");
      return;
    }

    const opened = await this.openResumedTab(
      created,
      command,
      (tabId) => {
        // Stamped the instant the tab exists, so the rail says which host was
        // clicked before the connection has even been answered. This is a real
        // rename, which is exactly why it sticks: a stamped title outranks the
        // profile/cwd title derivation, so the local launcher shell reporting
        // `C:\Dev` a second later cannot rewrite it — and a later rename by
        // Michael simply replaces it, since nothing re-stamps.
        this.renameTab(tabId, sshTabTitle(host.alias));
        this.recordSshPane(created.id, host.alias);
      },
      { groupId: options?.groupId ?? null },
    );
    // Armed only AFTER the connect command went in — never before. A watcher
    // armed at tab-open would sit over the LOCAL shell's first prompt, and
    // it is the arm-after-send ordering that lets ANY later prompt report
    // retire it: once armed, the next prompt — remote (logged in) or local
    // (ssh failed and the launcher shell is back) — means the password phase
    // is over. See reportSessionCwd.
    if (opened && password !== null) {
      this.watchForSshPasswordPrompt(created.id, password);
    }
  };

  /// The ssh host a pane is connected to, when TermX opened the connection
  /// itself. Null for every ordinary local pane — including one where the user
  /// typed `ssh` by hand, which stays untracked by design (spec "Decisions").
  sshPaneInfo = (sessionId: number): { host: string } | null => {
    const record = this.sshPanes.get(sessionId);
    return record ? { host: record.host } : null;
  };

  /// The newest conversation the remote watcher reported for this pane — the
  /// exact id, captured at launch, never guessed.
  capturedConversation = (
    sessionId: number,
  ): { provider: "claude" | "codex"; id: string } | null =>
    this.sshPanes.get(sessionId)?.captured ?? null;

  /// A remote agent just started in this pane (OSC 9;78). The newest capture
  /// wins: a second `claude` in the same shell IS the pane's conversation now.
  /// Captures for panes TermX does not know as ssh panes are ignored — only a
  /// tracked connection has a host to attach the id to.
  reportCapturedConversation = (
    sessionId: number,
    capture: { provider: "claude" | "codex"; id: string },
  ): void => {
    const record = this.sshPanes.get(sessionId);
    if (!record) {
      return;
    }
    if (
      record.captured?.provider === capture.provider &&
      record.captured.id === capture.id
    ) {
      return;
    }
    record.captured = capture;
    this.writeSshPane(sessionId);
  };

  /// Recorded dims per session for reattach-before-replay (spec §13): the
  /// hub's live resize record wins (the dims the pty actually ran at), the
  /// host's creation-time SessionInfo is the fallback for sessions no
  /// terminal has resized yet this run.
  /// A session's current directory, as the host reported it (OSC 9;9 keeps it
  /// live). The chat view matches this against the recorded cwd of discovered
  /// transcripts to work out which conversation a pane is running.
  sessionCwd = (sessionId: number): string | null =>
    this.sessions.get(sessionId)?.cwd ?? null;

  /// A pane's terminal rang its bell (xterm's parser saw a real BEL, not an
  /// OSC terminator). Routed to the attachment hub's attention mark.
  noteBell = (sessionId: number): void => {
    this.attachments.noteBell?.(sessionId);
  };

  /// The user is looking at this tab (it is active and the window has focus):
  /// deliver every pane's attention mark.
  markTabSeen = (tabId: string): void => {
    const tab = this.store.getState().tabs[tabId];
    if (!tab) {
      return;
    }
    for (const sessionId of sessionIdsInTab(tab)) {
      this.attachments.markSeen?.(sessionId);
    }
  };

  /// A display name per pane, for the split view's own title bars.
  ///
  /// A LONE pane is its tab, so it wears the tab's own rail title — a custom
  /// rename included — never a parallel derivation that would contradict the
  /// sidebar. Panes in a split all sit under one tab title, so the tab's name
  /// cannot tell them apart — each is named by what it actually IS (profile
  /// plus the folder it is standing in), the same derivation an unnamed tab
  /// uses.
  paneTitles = (tabId: string): Readonly<Record<number, string>> => {
    const tab = this.store.getState().tabs[tabId];
    if (!tab) {
      return {};
    }
    const sessionIds = sessionIdsInTab(tab);
    const titles: Record<number, string> = {};
    const lone = sessionIds.length === 1 ? sessionIds[0] : undefined;
    if (lone !== undefined) {
      titles[lone] = tab.title ?? derivedTitle(this.sessions.get(lone));
      return titles;
    }
    for (const sessionId of sessionIds) {
      titles[sessionId] = derivedTitle(this.sessions.get(sessionId));
    }
    return titles;
  };

  /// The profile a session was created with (status bar chrome).
  sessionProfile = (sessionId: number): string | null =>
    this.sessions.get(sessionId)?.profile ?? null;

  /// The session key a resume tied to this pane's tab, when the session was
  /// started or resumed through TermX. This is the strongest chat linkage
  /// there is — no directory guessing involved.
  resumedSessionKeyForTab = (tabId: string): SessionKey | null => {
    for (const [key, entry] of this.resumedTabs) {
      if (entry.tabId === tabId) {
        return key;
      }
    }
    return null;
  };

  /// Every tab a resume is currently bound to (auto-reveal spec §4). The chat
  /// walks these against the conversations store to spot the transcript
  /// `claude --resume` handed off to — only tabs THIS controller resumed are
  /// ever considered, so no pane is ever handed a conversation by guesswork.
  resumedEntries = (): readonly ResumedEntry[] =>
    [...this.resumedTabs].map(([key, entry]) => ({
      key,
      tabId: entry.tabId,
      resumedAtMs: entry.resumedAtMs,
    }));

  /// Point a resumed tab at the transcript that succeeded the one it was
  /// resumed from. The tab and the moment of the resume are unchanged — it is
  /// the same resume, still reading its own successor — so a second handoff in
  /// the same pane is judged against the original resume, not against the
  /// adoption. Unknown or unchanged keys are no-ops.
  rebindResumedTab = (oldKey: SessionKey, newKey: SessionKey): void => {
    if (oldKey === newKey) {
      return;
    }
    const entry = this.resumedTabs.get(oldKey);
    if (entry === undefined) {
      return;
    }
    // Another tab already owns `newKey` — two resumes in one folder can each
    // nominate the same successor. Adopting it here would silently CLOBBER the
    // other tab's binding; keeping the old key is the honest failure.
    if (this.resumedTabs.has(newKey)) {
      return;
    }
    this.resumedTabs.delete(oldKey);
    this.resumedTabs.set(newKey, entry);
  };

  /// The chat registers here to be told a pane is booting an agent (spec §4),
  /// so the resume's `cd`, trust prompt and startup are visible instead of
  /// hidden behind the bubbles. Null unregisters.
  setResumeBootListener = (
    listener: ((sessionId: number) => void) | null,
  ): void => {
    this.resumeBootListener = listener;
  };

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
    // ANY prompt after the connect command went in means the password phase is
    // over — remote (login succeeded, no password will be asked again) or
    // LOCAL (ssh failed: DNS, auth, no bash on the far end — and the launcher
    // shell is back, echoing). Retiring on both is what keeps the watcher's
    // 60 s window from catching an unrelated later prompt (a `sudo`
    // password:, a manual `ssh` to another box) and typing the stored
    // password into it. Watchers are armed only AFTER the command is sent, so
    // the local shell's FIRST prompt — the one the send waited for — can
    // never retire a watcher early: it predates the watcher.
    if (this.sshPanes.has(sessionId)) {
      this.stopSshPasswordWatch(sessionId);
    }
    // A LIVE report is the prompt-ready signal a pending resume waits for
    // (spec §5 step 3); replayed reports say nothing about the prompt. The path
    // travels with it so an ssh restore can tell the two shells apart.
    this.settleResumeWait(sessionId, "ready", path);
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

  /// The daemon's CURRENT session inventory, applied mid-run (triage P0 #3).
  ///
  /// The session map is seeded once at bootstrap; before this existed nothing
  /// ever resynced it, so a daemon restart while the app was open produced
  /// panes that RENDERED live while their input was dead — and every way out
  /// refused: Dismiss filters on `alive !== true`, Restart said "still
  /// running", Close was rejected by the new daemon. The tab could not be
  /// removed until relaunch.
  ///
  /// On reconnect the truth is re-read: sessions the daemon no longer reports
  /// alive go down the same wind-down a daemon-reported exit runs (the new
  /// daemon serves its state.json rows back as corpse records, so profile and
  /// cwd survive for the dead pane's Restart/Resume buttons), and rows we
  /// never met are adopted for lookups. Our own cwd is kept where we have
  /// one — live OSC reports are fresher than the daemon's records.
  resyncSessions = (truth: readonly SessionInfo[]): void => {
    const byId = new Map(truth.map((info) => [info.id, info]));
    const died: number[] = [];
    let changed = false;
    for (const [sessionId, existing] of [...this.sessions]) {
      const now = byId.get(sessionId);
      if (now === undefined) {
        // Not even a corpse: the daemon has never heard of it. Dead, with
        // everything we knew preserved for the dead-pane affordances.
        if (existing.alive) {
          this.sessions.set(sessionId, { ...existing, alive: false, pid: null });
          died.push(sessionId);
          changed = true;
        }
        continue;
      }
      if (existing.alive !== now.alive) {
        this.sessions.set(sessionId, {
          ...now,
          cwd: existing.cwd ?? now.cwd,
        });
        if (!now.alive) {
          died.push(sessionId);
        }
        changed = true;
      }
    }
    for (const [sessionId, now] of byId) {
      if (!this.sessions.has(sessionId)) {
        this.sessions.set(sessionId, now);
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    this.sessionsRevision += 1;
    for (const sessionId of died) {
      // Mirror the onSessionExited listener: nothing may keep waiting on,
      // watching, or typing into a session that is gone.
      this.settleResumeWait(sessionId, "gone");
      this.stopSshPasswordWatch(sessionId);
      this.attachments.markExited(sessionId, null);
      this.purgeResumedTabForSession(sessionId);
    }
    this.publish();
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
    await this.pluginPanes.flush().catch(() => undefined);
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
    await this.pluginPanes.flush().catch(() => undefined);
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
    await this.pluginPanes.flush().catch(() => undefined);
    if (failed) {
      this.setNotice("The ended terminal could not be dismissed.");
    }
  };

  /**
   * The capture log has been re-read and its contents may have changed.
   *
   * Dead panes decide whether to offer "Resume conversation" from that log
   * (`deadPaneConversation`), and it is loaded asynchronously at boot and
   * refreshed while TermX runs. Nothing else observes it, so without this a
   * pane that gained a resumable conversation keeps showing the plain
   * "Restart" card until some unrelated event happens to repaint it.
   */
  notifyCapturesChanged = (): void => {
    this.publish();
  };

  /// The conversation a dead pane's "Resume conversation" would bring back:
  /// the conversation THAT pane ran when a capture recorded it, else the
  /// newest resumable conversation in the pane's directory, else null (no
  /// capture, no directory, no index, or nothing ever ran there). The title is
  /// for the button's tooltip.
  deadPaneResumeTitle = (deadSessionId: number): string | null => {
    return this.deadPaneConversation(deadSessionId)?.title ?? null;
  };

  /**
   * Capture first, folder second. The capture names the conversation this very
   * pane started, so it is right where the folder lookup is only plausible: N
   * panes in one repo, or a pane whose recorded cwd is not where the agent ran.
   * A capture that fails `resumeCommand` (a corrupt id) is not "no resume" —
   * it just cannot be typed, so the folder fallback still gets its turn.
   */
  private deadPaneConversation(deadSessionId: number): LlmSessionRecord | null {
    const dead = this.sessions.get(deadSessionId);
    // Only a LIVE session disqualifies a pane. A pane the daemon has no record
    // of at all is the post-reboot case this feature exists for, and requiring
    // a session record made it unreachable exactly when the capture was the
    // only thing that could answer.
    if (dead?.alive === true) {
      return null;
    }
    const captured = this.capturedConversationFor?.(deadSessionId) ?? null;
    if (captured !== null && resumeCommand(captured) !== null) {
      return captured;
    }
    if (!dead?.cwd || !this.conversations) {
      return null;
    }
    const record = this.conversations.latestForCwd(dead.cwd);
    if (record === null || resumeCommand(record) === null) {
      return null;
    }
    return record;
  }

  /// Dead-pane "Resume conversation" / "Restart session" / "New session":
  /// create a replacement session — the dead pane's own profile + cwd for
  /// "restart" and "resume" (falling back to the host default dir if the cwd
  /// went stale), workspace defaults for "fresh" — swap it into the dead
  /// pane's slot, then release the dead session's scrollback on the host.
  /// "resume" additionally types the resume command for the newest
  /// conversation recorded in that directory once the new shell's prompt
  /// reports — the post-reboot "give me my workspace back" path. A resume
  /// with no findable conversation degrades to a plain restart: the right
  /// directory with no command is strictly better than a refusal.
  /// Returns the new session id so the caller can focus it, or null on
  /// refusal.
  restartPane = async (
    tabId: string,
    deadSessionId: number,
    mode: "restart" | "fresh" | "resume",
  ): Promise<number | null> => {
    const tab = this.store.getState().tabs[tabId];
    if (!tab || pathToPaneNode(tab.split, deadSessionId) === null) {
      return null;
    }
    if (isPluginPaneId(deadSessionId)) {
      // A plugin pane is RELAUNCHED, never restarted: restart creates a host
      // session and swaps its id into the pane, which would strand the
      // binding and leave a terminal where the panel was. Reachable because a
      // reserved pane with no binding renders as an ordinary dead pane.
      return null;
    }
    const dead = this.sessions.get(deadSessionId);
    if (dead?.alive === true) {
      this.setNotice("This terminal is still running.");
      return null;
    }
    this.setNotice(null);
    const defaultProfile = this.settings.getSnapshot().defaultProfile;
    const profile = mode === "fresh"
      ? defaultProfile
      : (dead?.profile ?? defaultProfile);
    // A corpse from a pre-cwd-tracking daemon carries no directory at all; the
    // capture recorded where the agent CLI started in that very pane, which is
    // the only other honest answer. Restart AND resume both take it — landing
    // in the right folder is the whole point of "restart in place".
    const cwd = mode === "fresh"
      ? null
      : (dead?.cwd ?? this.capturedConversationFor?.(deadSessionId)?.cwd ?? null);
    // Resolved BEFORE the shell exists, so a resume that has nothing to
    // resume degrades to a restart without ever arming a wait.
    const record = mode === "resume" ? this.deadPaneConversation(deadSessionId) : null;
    const command = record === null ? null : resumeCommand(record);
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
    // Armed before the attach: the shell's first OSC 9;9 report can land
    // inside any later await (openResumedTab's rule).
    const awaitPrompt = this.settings.getSnapshot().shellIntegration;
    const ready = command === null
      ? null
      : this.armResumeWait(
        created.id,
        awaitPrompt ? RESUME_PROMPT_TIMEOUT_MS : RESUME_FIXED_DELAY_MS,
        awaitPrompt,
      );
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
      this.settleResumeWait(created.id, "gone");
      if (ready !== null) {
        await ready;
      }
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
    if (ready !== null && command !== null && record !== null) {
      if ((await ready) === "gone") {
        this.setNotice("The terminal ended before the session could be resumed.");
      } else {
        const sent = this.attachments.sendInput?.(created.id, command + "\r") ?? false;
        if (sent) {
          this.rememberResumedTab(sessionKey(record), tabId);
          this.announceResumeBoot(created.id);
        } else {
          this.setNotice("The resume command could not be sent to the terminal.");
        }
      }
    }
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
      await this.pluginPanes.flush().catch(() => undefined);
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
    const merged = mergeTabIntoTab(
      this.store.getState(),
      sourceTabId,
      targetTabId,
      this.windowId,
    );
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
      this.store.replaceState(withActiveTab(extracted, this.windowId, newTabId))
    );
  };

  /// Open a plugin panel as its own tab (plugin spec §4): allocate a reserved
  /// pane id, bind it, create an ORDINARY one-pane tab around it, and kick the
  /// plugin's ensure-up. Returns the new tab's id, or null when the plugin is
  /// unknown, unwired, or the layout refused the tab.
  ///
  /// Async because of the crash-ordering rule below — the caller does not have
  /// to await it for the tab to appear, only to know the writes landed.
  openPluginTab = async (
    pluginId: string,
    groupId: string | null = null,
  ): Promise<string | null> => {
    const manifest = this.pluginManifest(pluginId);
    if (manifest === null) {
      return null;
    }
    this.setNotice(null);
    const sessionId = this.freshPluginPaneId();
    if (sessionId === null) {
      this.setNotice("The plugin panel could not be opened.");
      return null;
    }
    if (!await this.commitPluginBinding(sessionId, pluginId)) {
      this.setNotice("The plugin panel could not be opened.");
      return null;
    }

    const layout = this.store.getState();
    const targetGroupId = groupId !== null && layout.groups[groupId] ? groupId : null;
    const tabId = this.generateId();
    this.mutate("structural", () => this.store.createTab({
      id: tabId,
      sessionId,
      // Named from the manifest: with no session behind it, `derivedTitle`
      // would call a working panel "Terminal ended".
      title: manifest.name,
      color: nextTabColor(layout),
      groupId: targetGroupId,
      // Ungrouped tabs land on THIS window's rail; a group names its own.
      windowId: this.windowId,
    }));
    if (this.store.getState() === layout) {
      // The layout refused it (an id clash, a bad target). Take the binding
      // back rather than leave an orphan in the bindings file — and see it all
      // the way to disk, since the row is already there and a window that dies
      // now would restore a pane the layout never got.
      this.pluginPanes.unbind([sessionId]);
      await this.pluginPanes.flush().catch(() => undefined);
      this.setNotice("The plugin panel could not be opened.");
      return null;
    }
    void this.ensurePluginUp(pluginId);
    this.publish();
    return tabId;
  };

  /// The same, as a split beside an existing pane: any pane may be a plugin
  /// pane, so this is the ordinary split path with a reserved id in place of a
  /// duplicated session. Returns the new pane's reserved id, or null.
  openPluginSplit = async (
    tabId: string,
    anchorSessionId: number,
    pluginId: string,
    dir: SplitDir = "row",
  ): Promise<number | null> => {
    const tab = this.store.getState().tabs[tabId];
    if (!tab) {
      return null;
    }
    const manifest = this.pluginManifest(pluginId);
    if (manifest === null) {
      return null;
    }
    if (!canSplitPane(tab.split, anchorSessionId)) {
      this.setNotice("This pane is already split as deep as it can go.");
      return null;
    }
    this.setNotice(null);
    const sessionId = this.freshPluginPaneId();
    if (sessionId === null) {
      this.setNotice("The pane could not be split.");
      return null;
    }
    if (!await this.commitPluginBinding(sessionId, pluginId)) {
      this.setNotice("The pane could not be split.");
      return null;
    }

    const before = this.store.getState();
    const after = this.store.splitPane(tabId, anchorSessionId, dir, sessionId);
    if (after === before) {
      this.pluginPanes.unbind([sessionId]);
      await this.pluginPanes.flush().catch(() => undefined);
      this.setNotice("The pane could not be split.");
      this.publish();
      return null;
    }
    this.persistence.record(after, "structural");
    void this.ensurePluginUp(pluginId);
    this.publish();
    return sessionId;
  };

  /**
   * Make `sessionId`'s binding durable before ANY layout write mentions it.
   *
   * This is the crash-ordering rule of plugin spec §4, in one place so no open
   * path can forget half of it. The bindings file must be on disk first: a
   * layout that names a reserved pane with no binding restores as a corpse the
   * user can only dismiss, and the panel is gone. The reverse order is safe —
   * a binding with no pane is pruned at the next boot.
   *
   * On a REPLICA window there is a second half. `bind` there only forwards to
   * main and returns; this window's own map stays empty until main broadcasts
   * the row back. Waiting for that broadcast is what proves main accepted and
   * wrote it, and it is also what makes the pane renderable here — the pane
   * state is built from the binding, so mutating the layout first would show a
   * reserved pane with no plugin behind it.
   *
   * Returns false when the write failed or main never answered; the caller
   * must then leave the layout alone. The binding is taken back here so every
   * failure path is one call.
   */
  private async commitPluginBinding(
    sessionId: number,
    pluginId: string,
  ): Promise<boolean> {
    this.pluginPanes.bind(sessionId, { pluginId });
    try {
      await this.pluginPanes.flush();
    } catch {
      // The row never reached disk (or main). Nothing to take back on a
      // replica, and on main the unbind is the same failing write — but a
      // queued removal costs nothing and covers a transient failure.
      this.pluginPanes.unbind([sessionId]);
      return false;
    }
    if (await this.awaitBindingAdopted(sessionId)) {
      return true;
    }
    this.pluginPanes.unbind([sessionId]);
    await this.pluginPanes.flush().catch(() => undefined);
    return false;
  }

  /// True once this window's own bindings map holds `sessionId`. On main that
  /// is already the case (single writer, synchronous local write), so this
  /// answers immediately; on a replica it waits for main's broadcast, bounded
  /// by `PLUGIN_BIND_ADOPT_TIMEOUT_MS` so a silent main cannot hang the open.
  private awaitBindingAdopted(sessionId: number): Promise<boolean> {
    const key = String(sessionId);
    if (this.pluginPanes.getSnapshot()[key] !== undefined) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let done = false;
      const settle = (adopted: boolean): void => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        stop();
        resolve(adopted);
      };
      const timer = setTimeout(() => settle(false), PLUGIN_BIND_ADOPT_TIMEOUT_MS);
      const stop = this.pluginPanes.subscribe(() => {
        if (this.pluginPanes.getSnapshot()[key] !== undefined) {
          settle(true);
        }
      });
      // The broadcast may have landed between the check above and the
      // subscription; re-read rather than wait for a change that already
      // happened.
      if (this.pluginPanes.getSnapshot()[key] !== undefined) {
        settle(true);
      }
    });
  }

  /// The plugin pane's "Relaunch": re-run ensure-up for the plugin this pane is
  /// bound to, KEEPING the pane id. Deliberately not `restartPane`, which
  /// creates a host session and swaps the pane's id out of the layout — that
  /// would destroy the binding and turn the panel into a terminal. A pane with
  /// no binding (an ordinary or orphaned pane) is a silent no-op.
  relaunchPlugin = async (sessionId: number): Promise<void> => {
    const binding = this.pluginPanes.getSnapshot()[String(sessionId)];
    if (binding === undefined) {
      if (isPluginPaneId(sessionId)) {
        // A reserved pane with no binding: an orphan the boot prune will
        // clear, or — on a replica — a pane whose binding main has not
        // broadcast back yet. Silence would leave a button that does nothing
        // and explains nothing.
        this.setNotice("This panel is still being registered. Try again in a moment.");
      }
      return;
    }
    this.setNotice(null);
    await this.ensurePluginUp(binding.pluginId, { force: true });
  };

  /**
   * Everything this controller has queued, BOTH stores.
   *
   * The bindings file belongs here because an aux window's shutdown is
   * `flush()` then destroy: an unbind still in flight would die with the
   * webview and leave main holding an orphan until the next boot prune.
   *
   * A bindings failure is swallowed here and only here — a shutdown must not
   * be blocked by it, and the open paths await `pluginPanes.flush()` directly,
   * where a failure has somewhere to go.
   */
  flush = async (): Promise<void> => {
    await Promise.all([
      this.persistence.flush(),
      this.pluginPanes.flush().catch(() => undefined),
    ]);
  };

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const timer of this.pluginHealthTimers.values()) {
      clearInterval(timer);
    }
    this.pluginHealthTimers.clear();
    for (const sessionId of [...this.resumeWaiters.keys()]) {
      this.settleResumeWait(sessionId, "gone");
    }
    for (const stop of [...this.sshPasswordWatchers.values()]) {
      stop();
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
      // Ungrouped tabs land on THIS window's rail; a group target already
      // names its own window.
      windowId: this.windowId,
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

  /// The shared tail of both resume flows: arm the prompt wait BEFORE the
  /// session is attached (once a terminal binds to it, its first OSC 9;9
  /// report can land inside any later await), open the tab, then type
  /// `command` once the shell reports its prompt. `onTabOpened` runs the
  /// instant the tab exists in the layout — the point from which a mid-wait
  /// death cleans itself up through the normal listeners.
  ///
  /// A null `command` (a bare-shell saved session) types nothing and waits for
  /// nothing: there is no prompt to race. Returns false when the resume was
  /// refused, in which case a notice is already set.
  private async openResumedTab(
    created: SessionInfo,
    command: string | null,
    onTabOpened: (tabId: string) => void,
    options?: { groupId?: string | null },
  ): Promise<boolean> {
    const awaitPrompt = this.settings.getSnapshot().shellIntegration;
    const ready = command === null
      ? null
      : this.armResumeWait(
        created.id,
        awaitPrompt ? RESUME_PROMPT_TIMEOUT_MS : RESUME_FIXED_DELAY_MS,
        awaitPrompt,
      );
    let tabId: string;
    try {
      tabId = await this.addSessionTab(created, options?.groupId ?? null);
    } catch {
      this.settleResumeWait(created.id, "gone");
      if (ready !== null) {
        await ready;
      }
      this.setNotice("The terminal session could not be created.");
      return false;
    }
    onTabOpened(tabId);

    if (ready !== null && (await ready) === "gone") {
      this.setNotice("The terminal ended before the session could be resumed.");
      return false;
    }
    if (command !== null) {
      const sent = this.attachments.sendInput?.(created.id, `${command}\r`) ?? false;
      if (!sent) {
        // A resume whose command never went in was refused (the contract
        // above): callers must not treat the empty shell as a booted agent —
        // or arm a password watcher over it.
        this.setNotice("The resume command could not be sent to the terminal.");
        return false;
      }
    }
    return true;
  }

  /// Fresh restore of a saved SSH session (spec §5) — the "as if he never left"
  /// path: ssh back in, land in the remote folder, resume the exact remote
  /// conversation.
  ///
  /// It is the local restore with one extra beat. TWO prompts have to be waited
  /// for, not one: the LOCAL shell's (after which the connect command can be
  /// typed) and then the REMOTE shell's, which only a rooted-Unix cwd report can
  /// prove. Anything less would type `claude --resume` into powershell.
  ///
  /// The `cd` is not typed — it rides inside the bootstrap the connect command
  /// carries — so a folder that has moved on the far end surfaces where it
  /// belongs: in the terminal (spec §5).
  private async resumeSavedOverSsh(
    entry: SavedSession,
    alias: string,
  ): Promise<void> {
    // The config is the source of truth for hosts, so a save can outlive its
    // host. Say so by name rather than dialling something that is not there.
    if (this.sshHosts && this.sshHosts.byAlias(alias) === null) {
      this.setNotice(`Host ${alias} is no longer in your SSH config.`);
      return;
    }
    // Quoting must match the LOCAL launcher shell the command is typed into.
    const profile = this.settings.getSnapshot().defaultProfile;
    let connect: string;
    try {
      connect = sshConnectCommand(alias, {
        remoteCwd: entry.cwd,
        localShell: profile,
      });
    } catch {
      this.setNotice(
        "That SSH host cannot be connected: its alias is not a plain name.",
      );
      return;
    }

    const password = await this.storedSshPassword(alias);
    let created: SessionInfo;
    try {
      created = await this.createSessionDownChain(profile, [null]);
    } catch {
      this.setNotice("The terminal session could not be created.");
      return;
    }

    const conversation = entry.conversation;
    const opened = await this.openResumedTab(created, connect, (tabId) => {
      this.recordSshPane(created.id, alias);
      if (conversation) {
        this.rememberResumedTab(sessionKey(conversation), tabId);
      }
      this.recordDaemonSession(entry, created.id);
    });
    // Same ordering rule as connectSshHost: the watcher exists only from the
    // moment the connect command is in the shell, so any prompt report after
    // it — local or remote — can safely retire it.
    if (opened && password !== null) {
      this.watchForSshPasswordPrompt(created.id, password);
    }
    // A bare-shell save is finished here: the remote shell in the saved folder
    // is the whole of what was pinned.
    const remoteCommand = remoteResumeCommand(conversation);
    if (!opened || remoteCommand === null) {
      return;
    }

    const ready = await this.armResumeWait(
      created.id,
      SSH_REMOTE_PROMPT_TIMEOUT_MS,
      true,
      isRemoteCwd,
    );
    if (ready !== "ready") {
      // "gone": the connection failed or the shell died — whatever ssh said is
      // on screen already, and TermX adds nothing to it (spec §7). "elapsed":
      // the shell is up but no remote prompt was seen in time (slow box, or a
      // bashrc that swallows the OSC), so nothing on screen explains why the
      // resume never ran — say so, and leave the connected shell in place.
      if (ready === "elapsed") {
        this.setNotice(
          "Connected, but the remote prompt was not detected — run the resume command yourself.",
        );
      }
      return;
    }
    const sent =
      this.attachments.sendInput?.(created.id, `${remoteCommand}\r`) ?? false;
    if (!sent) {
      this.setNotice("The resume command could not be sent to the terminal.");
      return;
    }
    // The remote agent is booting now. Chat is local-only for the moment, so
    // this is inert today — but the signal belongs where the boot is.
    this.announceResumeBoot(created.id);
  }

  /// Remember a pane as an ssh pane and mirror it to disk (spec §2).
  private recordSshPane(sessionId: number, host: string): void {
    this.sshPanes.set(sessionId, { host, captured: null });
    this.writeSshPane(sessionId);
  }

  /// A session the host has forgotten stops being an ssh pane, in memory and on
  /// disk both.
  private forgetSshPane(sessionId: number): void {
    if (!this.sshPanes.delete(sessionId)) {
      return;
    }
    this.writeSshPane(sessionId);
  }

  /// Push one pane's ssh state into ui state (absent from the map = delete).
  private writeSshPane(sessionId: number): void {
    const record = this.sshPanes.get(sessionId);
    this.uiState.update((state) =>
      setSshPaneState(
        state,
        String(sessionId),
        record === undefined
          ? null
          : {
              host: record.host,
              ...(record.captured
                ? {
                    capturedProvider: record.captured.provider,
                    capturedId: record.captured.id,
                  }
                : {}),
            },
      ),
    );
  }

  /// Restore tracked ssh panes at construction, keeping only sessions the host
  /// still has. The rest are swept out of the file rather than merely ignored:
  /// a stale entry would linger forever otherwise. (Ids are never reused —
  /// registry.rs keeps a monotonic watermark across restarts — but a clean
  /// file beats trusting that from over here.)
  private hydrateSshPanes(): void {
    const stored = this.uiState.getSnapshot().sshPanes;
    if (!stored) {
      return;
    }
    const stale: string[] = [];
    for (const [key, pane] of Object.entries(stored)) {
      const sessionId = Number(key);
      if (!Number.isInteger(sessionId) || !this.sessions.has(sessionId)) {
        stale.push(key);
        continue;
      }
      this.sshPanes.set(sessionId, {
        host: pane.host,
        captured:
          pane.capturedProvider !== undefined && pane.capturedId !== undefined
            ? { provider: pane.capturedProvider, id: pane.capturedId }
            : null,
      });
    }
    if (stale.length > 0) {
      this.uiState.update((state) =>
        stale.reduce((next, key) => setSshPaneState(next, key, null), state),
      );
    }
  }

  /// The stored password for a host, or null — no store, no policy, no entry, a
  /// store that threw, an empty string, or a hub with no output tap to watch
  /// with. Every one of those means the same thing to the caller: nobody types
  /// anything, and the prompt is left on screen where the user can answer it.
  private async storedSshPassword(alias: string): Promise<string | null> {
    // Spec §6: "never" means what the settings screen says verbatim — "any
    // already saved is ignored". The store is not even consulted, so flipping
    // the policy is enough; nothing needs deleting for the promise to hold.
    if (this.settings.getSnapshot().sshPasswordPolicy !== "store") {
      return null;
    }
    if (!this.sshPasswords || !this.attachments.tapOutput) {
      return null;
    }
    try {
      const stored = await this.sshPasswords.passwordFor(alias);
      return stored !== null && stored.length > 0 ? stored : null;
    } catch {
      // A credentials store that cannot answer is not an error worth a notice:
      // the terminal is about to ask for the password anyway.
      return null;
    }
  }

  /// Watch a connecting pane for its password prompt and type the stored
  /// password ONCE (spec §2).
  ///
  /// Bounded three ways — one match, one 60 s window, and the session's own
  /// death — because a watcher that outlived its window would be a thing that
  /// types a password into whatever came next. The value never leaves this
  /// closure: not into state, not into a notice, not into the scrollback (the
  /// pty echoes nothing for a password prompt).
  private watchForSshPasswordPrompt(sessionId: number, password: string): void {
    const tapOutput = this.attachments.tapOutput;
    if (!tapOutput) {
      return;
    }
    this.stopSshPasswordWatch(sessionId);
    let tap: { dispose(): void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let finished = false;
    let tail = "";
    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (this.sshPasswordWatchers.get(sessionId) === finish) {
        this.sshPasswordWatchers.delete(sessionId);
      }
      const active = tap;
      tap = null;
      try {
        active?.dispose();
      } catch {
        // The tap belongs to a session that may already be gone.
      }
    };
    this.sshPasswordWatchers.set(sessionId, finish);
    timer = setTimeout(finish, SSH_PASSWORD_WATCH_MS);
    const installed = tapOutput.call(this.attachments, sessionId, (text) => {
      if (finished) {
        return;
      }
      // Only the tail can hold a prompt: it is one short line, and a prompt is
      // recognised by output STOPPING at it.
      tail = (tail + text).slice(-SSH_PASSWORD_TAIL_CHARS);
      if (!SSH_PASSWORD_PROMPT.test(tail)) {
        return;
      }
      // Stop watching BEFORE typing, so nothing the send itself produces can
      // be read as a second prompt.
      finish();
      this.attachments.sendInput?.(sessionId, `${password}\r`);
    });
    if (finished) {
      // The window closed while the tap was being installed.
      try {
        installed.dispose();
      } catch {
        // Nothing left to clean up.
      }
      return;
    }
    tap = installed;
  }

  /// Stop this session's password watcher, if it has one. Idempotent.
  private stopSshPasswordWatch(sessionId: number): void {
    this.sshPasswordWatchers.get(sessionId)?.();
  }

  /// The tab whose split holds `sessionId`, when the layout has one.
  private tabHoldingSession(sessionId: number): string | null {
    const layout = this.store.getState();
    for (const [tabId, tab] of Object.entries(layout.tabs)) {
      if (sessionIdsInTab(tab).includes(sessionId)) {
        return tabId;
      }
    }
    return null;
  }

  /// Write back which daemon session a saved entry now names. Skipped when it
  /// already names this one (the reattach case), so a resume that changed
  /// nothing does not bump the entry's `updatedAtMs` — and therefore does not
  /// reshuffle the sidebar's most-recent-first order for no reason.
  private recordDaemonSession(entry: SavedSession, sessionId: number): void {
    if (entry.lastDaemonSessionId === sessionId) {
      return;
    }
    this.savedSessions?.touchDaemonSession(entry.id, sessionId);
  }

  /// The user's nesting ceiling for CREATION and MOVEMENT (spec §3). Parsing
  /// is never gated by it — a deeper layout built earlier still works.
  private maxGroupDepth(): number {
    return this.settings.getSnapshot().maxGroupDepth;
  }

  /// Smallest `aux-<n>` (n from 1) not already a window slot. Ids are reused
  /// after a slot closes, which is fine: a slot IS the window's identity, and
  /// a closed one has no leftovers to collide with.
  private allocateAuxWindowId(): string {
    const layout = this.store.getState();
    for (let n = 1; ; n += 1) {
      const candidate = `aux-${n}`;
      if (!(candidate in layout.auxWindows)) {
        return candidate;
      }
    }
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
    accept?: (path: string) => boolean,
  ): Promise<ResumeWaitOutcome> {
    this.settleResumeWait(sessionId, "gone");
    return new Promise<ResumeWaitOutcome>((resolve) => {
      const timer = setTimeout(
        () => this.settleResumeWait(sessionId, "elapsed"),
        timeoutMs,
      );
      const waiter: ResumeWaiter = {
        awaitPrompt,
        ...(accept ? { accept } : {}),
        settle: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
      };
      this.resumeWaiters.set(sessionId, waiter);
    });
  }

  /// `path` is the reported cwd, present only for a "ready" from a cwd report:
  /// a waiter with an `accept` predicate stays armed for reports it does not
  /// recognise as its own shell's.
  private settleResumeWait(
    sessionId: number,
    outcome: ResumeWaitOutcome,
    path?: string,
  ): void {
    const waiter = this.resumeWaiters.get(sessionId);
    if (!waiter || (outcome === "ready" && !waiter.awaitPrompt)) {
      return;
    }
    if (
      outcome === "ready" &&
      waiter.accept !== undefined &&
      (path === undefined || !waiter.accept(path))
    ) {
      return;
    }
    this.resumeWaiters.delete(sessionId);
    waiter.settle(outcome);
  }

  /// Cwd of the globally active tab, when that tab belongs to the scope a
  /// new tab targets. Falls back to the group-active chain otherwise.
  private activeTabCwdInScope(key: ScopeKey): string | null {
    const layout = this.store.getState();
    const activeTabId = slotOf(layout, this.windowId)?.activeTabId ?? null;
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

  /// The manifest for an installed plugin, with the notice already set when
  /// there is none — the shared front half of both open-plugin actions.
  private pluginManifest(pluginId: string): PluginManifest | null {
    const manifest = this.plugins?.manifestFor(pluginId) ?? null;
    if (manifest === null) {
      this.setNotice(`The plugin "${pluginId}" is not installed.`);
      return null;
    }
    return manifest;
  }

  /**
   * A free reserved pane id. "Taken" is deliberately wider than the layout:
   * a binding whose pane has not reached the blob yet (the window between the
   * two writes) must not be handed out a second time, and daemon ids join the
   * set so a future daemon that ever reached the reserved range still cannot
   * collide. Null when the allocator gave up, which the callers treat as a
   * plain refusal rather than an exception.
   *
   * The pending-binding term covers the MAIN window only: a replica's `bind`
   * forwards without touching its own map, so an id it has just requested is
   * not in this set until main broadcasts it back. Two aux windows allocating
   * in the same instant can therefore pick the same id — at ~2⁻³¹ per pair,
   * against a random 31-bit draw, that is left as the accepted risk rather
   * than paid for with a second cross-window round trip.
   */
  private freshPluginPaneId(): number | null {
    const taken = new Set<number>(sessionIdsInLayout(this.store.getState()));
    for (const key of Object.keys(this.pluginPanes.getSnapshot())) {
      taken.add(Number(key));
    }
    for (const id of this.sessions.keys()) {
      taken.add(id);
    }
    try {
      return allocatePluginPaneId(taken);
    } catch {
      return null;
    }
  }

  /// Make sure a plugin is running, at most once per plugin per boot: panes
  /// share one process, so the second pane must adopt the first one's answer
  /// rather than probe again. `force` is the Relaunch button — the one way a
  /// plugin that failed at boot gets another turn.
  private ensurePluginUp(
    pluginId: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const plugins = this.plugins;
    if (plugins === null) {
      return Promise.resolve();
    }
    const inFlight = this.pluginEnsures.get(pluginId);
    if (inFlight) {
      if (!options.force) {
        // Two panes opened in one breath join the probe already running
        // instead of spawning a second copy.
        return inFlight;
      }
      // Relaunch must mean "try again", never "wait for the attempt already
      // under way" — which is very often the attempt the user is relaunching
      // BECAUSE it is failing or hanging. Queue a fresh run behind it rather
      // than racing two spawns of a singleton plugin.
      return inFlight.then(() => this.ensurePluginUp(pluginId, { force: true }));
    }
    if (!options.force && this.pluginRuntimes.has(pluginId)) {
      return Promise.resolve();
    }
    this.setPluginRuntime(pluginId, {
      health: "starting",
      // The last known URL is kept so a relaunch does not blank a live iframe
      // before the probe has said anything is wrong.
      url: this.pluginRuntimes.get(pluginId)?.url ?? null,
    });
    const run = plugins
      .ensureUp(pluginId)
      .then((result) => this.applyEnsureUpResult(pluginId, result))
      .catch((error: unknown) => {
        // A rejection is the lifecycle itself failing (a missing native
        // command, say). Same user-visible outcome as a failed probe: a down
        // card with a reason and a Relaunch button.
        this.applyEnsureUpResult(pluginId, {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
          stderrTail: "",
        });
      })
      .finally(() => {
        this.pluginEnsures.delete(pluginId);
      });
    this.pluginEnsures.set(pluginId, run);
    return run;
  }

  private applyEnsureUpResult(pluginId: string, result: EnsureUpResult): void {
    if (result.ok) {
      this.setPluginRuntime(pluginId, { health: "up", url: result.runtime.url });
      return;
    }
    const tail = result.stderrTail.trim();
    this.setPluginRuntime(pluginId, {
      health: "down",
      url: null,
      error: tail.length > 0 ? `${result.reason}\n${tail}` : result.reason,
    });
  }

  private setPluginRuntime(pluginId: string, state: PluginRuntimeState): void {
    this.pluginRuntimes.set(pluginId, state);
    this.pluginRevision += 1;
    this.publish();
  }

  /// Every plugin with at least one pane in this window's layout. A pane counts
  /// only WITH a binding, exactly as the snapshot counts it — an orphaned
  /// reserved id is a dead pane, and polling for it would poll for nothing.
  private openPluginIds(): Set<string> {
    const open = new Set<string>();
    const bindings = this.pluginPanes.getSnapshot();
    for (const sessionId of sessionIdsInLayout(this.store.getState())) {
      if (!isPluginPaneId(sessionId)) {
        continue;
      }
      const pluginId = bindings[String(sessionId)]?.pluginId;
      if (pluginId !== undefined) {
        open.add(pluginId);
      }
    }
    return open;
  }

  /// Match the pollers to the panes on screen. Runs from `publish` — the one
  /// place every binding change, layout mutation and health update already
  /// funnels through — so a panel opened, closed, or moved out of the layout
  /// starts and stops its poller without any caller having to remember to.
  private syncPluginHealthPolls(): void {
    if (this.pluginHealthTimers.size === 0
      && (this.disposed || this.plugins?.probe === undefined)) {
      // The overwhelmingly common case (no plugins wired at all): free.
      return;
    }
    const open = this.disposed ? new Set<string>() : this.openPluginIds();
    for (const [pluginId, timer] of [...this.pluginHealthTimers]) {
      if (!open.has(pluginId)) {
        clearInterval(timer);
        this.pluginHealthTimers.delete(pluginId);
      }
    }
    if (this.disposed || this.plugins?.probe === undefined) {
      return;
    }
    for (const pluginId of open) {
      if (this.pluginHealthTimers.has(pluginId)) {
        continue;
      }
      this.pluginHealthTimers.set(
        pluginId,
        setInterval(
          () => void this.pollPluginHealth(pluginId),
          PLUGIN_HEALTH_INTERVAL_MS,
        ),
      );
    }
  }

  /// One health tick. Only a plugin believed UP is asked: "starting" belongs to
  /// the ensure-up already running, and "down" is a verdict the user answers
  /// with Relaunch — re-probing it would either do nothing or, if the probe
  /// were ever allowed to spawn, resurrect a plugin they just killed.
  private async pollPluginHealth(pluginId: string): Promise<void> {
    const probe = this.plugins?.probe;
    if (probe === undefined || this.disposed) {
      return;
    }
    if (this.pluginHealthProbes.has(pluginId) || this.pluginEnsures.has(pluginId)) {
      return;
    }
    if (this.pluginRuntimes.get(pluginId)?.health !== "up") {
      return;
    }
    this.pluginHealthProbes.add(pluginId);
    let alive = false;
    try {
      alive = await probe(pluginId);
    } catch {
      // A probe that could not even be asked is the same news as a refused
      // one: the panel is not reachable from here.
      alive = false;
    } finally {
      this.pluginHealthProbes.delete(pluginId);
    }
    if (alive || this.disposed) {
      return;
    }
    // Re-read: a Relaunch (or a close) may have landed while the probe was in
    // flight, and its answer is fresher than this one.
    if (this.pluginRuntimes.get(pluginId)?.health !== "up") {
      return;
    }
    this.setPluginRuntime(pluginId, {
      health: "down",
      url: null,
      error: "The panel stopped answering.",
    });
  }

  private async closeSessions(sessionIds: readonly number[]): Promise<{
    successful: Set<number>;
    failed: boolean;
  }> {
    const successful = new Set<number>();
    let failed = false;
    // Binding cleanup (plugin spec §4). Every path that takes panes out of the
    // layout — closeLiveTab, dismissDeadTab, closePane, deleteGroup — funnels
    // through here, so one sweep covers all of them and orphan bindings can
    // never accumulate in `plugin_panes_v1.json`.
    // NOTE: reserved ids are NOT unbound here. Closing is two steps — release
    // the sessions, then write the layout — and the layout write can be
    // refused. Unbinding first would turn a still-rendered panel into a pane
    // with no plugin behind it. `unbindDepartedPanes`, driven by the layout
    // that actually landed, is the only place a binding is dropped.
    for (const sessionId of sessionIds) {
      const known = this.sessions.has(sessionId);
      if (!known) {
        // Load-bearing early success (spec §4's downgrade audit): a reserved
        // plugin pane — and any pane the host has forgotten — is dismissed
        // WITHOUT a CloseSession, which the daemon would reject as "no such
        // session", leaving the pane undismissable.
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

  private mutate(kind: LayoutChangeKind, mutation: () => Layout): void {
    const before = this.store.getState();
    const after = mutation();
    if (after !== before) {
      this.persistence.record(after, kind);
      // Spec P6: every structural tab removal — closeLiveTab, closeGroup,
      // dismissDeadTab, closePane's last-pane case, mergeTabs folding the
      // source tab away — flows through here, so one generic sweep catches
      // all of them instead of a bespoke call at each site.
      this.purgeResumedTabsNotIn(after);
      this.unbindDepartedPanes(before, after);
    }
  }

  /**
   * Drop the binding of every plugin pane that has just left the layout, and
   * forget a plugin's runtime once no pane renders it any more.
   *
   * Deliberately AFTER the layout write, not before it: a close whose layout
   * mutation is refused keeps its pane, and a pane whose binding was already
   * taken away is a dead pane where a working panel used to be. This ordering
   * is the mirror of `commitPluginBinding` — binding first when a pane
   * appears, binding last when it goes — and both leave the recoverable
   * failure (an orphan row, cleared by the boot prune) rather than the
   * unrecoverable one.
   *
   * Forgetting the runtime matters as much as the row: a plugin can die while
   * no pane is watching it, so the next pane to open must probe afresh instead
   * of inheriting a remembered "up" and framing a dead port.
   */
  private unbindDepartedPanes(before: Layout, after: Layout): void {
    const bindings = this.pluginPanes.getSnapshot();
    const keys = Object.keys(bindings);
    if (keys.length === 0) {
      return;
    }
    // A pane counts as departed only if THIS mutation removed it: it was in
    // the layout before and is not in the layout after. "Bound but not in the
    // layout" is the normal state of a pane between its binding and the
    // mutation that places it, and two panels opened in the same breath
    // interleave exactly there — a plain absence check would have the first
    // one's layout write unbind the second one's pane.
    const gone = new Set(sessionIdsInLayout(before));
    for (const id of sessionIdsInLayout(after)) {
      gone.delete(id);
    }
    const departed = keys.filter((key) => gone.has(Number(key)));
    if (departed.length === 0) {
      return;
    }
    this.pluginPanes.unbind(departed.map(Number));
    // Computed from the map as it was, minus what just left: on a replica
    // `unbind` only forwards, so re-reading the snapshot would still show the
    // departed rows and no runtime would ever be released.
    const stillUsed = new Set(
      keys.filter((key) => !departed.includes(key))
        .map((key) => bindings[key]!.pluginId),
    );
    for (const key of departed) {
      const pluginId = bindings[key]!.pluginId;
      if (!stillUsed.has(pluginId)) {
        this.forgetPluginRuntime(pluginId);
      }
    }
  }

  /// Forget what we knew about a plugin's process. The health poll prunes its
  /// own timer on the next publish, since no pane names this plugin any more.
  private forgetPluginRuntime(pluginId: string): void {
    if (!this.pluginRuntimes.delete(pluginId)) {
      return;
    }
    this.pluginRevision += 1;
    this.publish();
  }

  /// Drops any resume-dedupe entry whose tab id no longer exists in `layout`.
  private purgeResumedTabsNotIn(layout: Layout): void {
    if (this.resumedTabs.size === 0) {
      return;
    }
    for (const [key, entry] of this.resumedTabs) {
      if (!layout.tabs[entry.tabId]) {
        this.resumedTabs.delete(key);
      }
    }
  }

  /// Bind a resumed conversation to the tab now holding it, stamped with the
  /// moment of the resume (spec §4). Every resume path goes through here so
  /// the stamp can never be forgotten by one of them.
  private rememberResumedTab(key: SessionKey, tabId: string): void {
    this.resumedTabs.set(key, { tabId, resumedAtMs: Date.now() });
  }

  /// Tell whoever is listening that `sessionId` is booting an agent.
  private announceResumeBoot(sessionId: number): void {
    this.resumeBootListener?.(sessionId);
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
    for (const [key, entry] of this.resumedTabs) {
      const tab = layout.tabs[entry.tabId];
      if (!tab || !sessionIdsInTab(tab).includes(sessionId)) {
        continue;
      }
      if (!this.isTabLive(entry.tabId)) {
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
    // Panels come and go with the layout, so the pollers follow the layout.
    this.syncPluginHealthPolls();
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
function subtreeGroupIdsOf(layout: Layout, groupId: string): string[] {
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

/**
 * What a one-click ssh tab is called. Same `<what> · <which>` shape as the
 * derived local title (`powershell · TermX`), with the alias in the slot the
 * eye already reads as "the specific one" — the tab rail and the left rail
 * render the same string, so naming it here names it in both.
 */
export function sshTabTitle(alias: string): string {
  return `ssh · ${alias}`;
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
