import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { listen } from "@tauri-apps/api/event";
import {
  registerAction,
  type ActionContext,
  type TrayId,
} from "./actions/registry";
import { FeaturesDock } from "./actions/FeaturesDock";
import { Tray } from "./actions/Tray";
import { resolveLinkage } from "./chat/linkage";
import { CloseGuard } from "./close/CloseGuard";
import { decideOnClose, type CloseDecision } from "./close/closeBehavior";
import { ConnectionBanner } from "./connection/ConnectionBanner";
import { listenForPowerEvents } from "./connection/powerEvents";
import { AlreadyOpenDialog } from "./conversations/AlreadyOpenDialog";
import { ConversationsFullscreen } from "./conversations/ConversationsFullscreen";
import { ConversationsRail } from "./conversations/ConversationsRail";
import { NoteScheduler } from "./conversations/noteScheduler";
import { SessionPalette } from "./conversations/palette/SessionPalette";
import type { LlmSessionRecord } from "./conversations/types";
import { FolderSearch } from "./folders/FolderSearch";
import { isEditableElement } from "./keyboard";
import { Menubar, type MenuSpec } from "./menubar/Menubar";
import {
  viewMenu,
  workspaceMenu,
  type MenuRow,
  type ViewToggleField,
  aboutRow,
} from "./menubar/menus";
import { PluginsMenu, type PluginsMenuRow } from "./menubar/PluginsMenu";
import { pickFolder as pickNativeFolder } from "./native/dialog";
import { tauriListDirs } from "./native/folders";
import { tauriOpenFolder } from "./native/openFolder";
import {
  tauriDismissOutput,
  tauriGenerateBundle,
  tauriListArtifacts,
  tauriListOutputs,
  tauriReadTextFile,
} from "./native/sessionData";
import { OutputPane, type LiveOutputRow } from "./outputs/OutputPane";
import { OutputsStore } from "./outputs/outputsStore";
import { BUNDLED_MANIFESTS } from "./plugins/bundled";
import {
  surfacesOf,
  type PluginManifest,
  type PluginSurface,
} from "./plugins/manifest";
import { tauriPluginNative } from "./plugins/native";
import { manifestFor } from "./plugins/registry";
import {
  SaveSessionDialog,
  type SaveSessionPrefill,
} from "./saved/SaveSessionDialog";
import type {
  SavedConversationRef,
  SavedSession,
  SavedSshRef,
} from "./saved/types";
import { probeRemoteTitle } from "./native/sshProbe";
import { SetPasswordDialog } from "./ssh/SetPasswordDialog";
import type { SshHost } from "./ssh/types";
import type { PluginHealth } from "./settings/PluginsPanel";
import {
  SettingsSurface,
  type SettingsPlugins,
} from "./settings/SettingsSurface";
import type { SettingsSectionId } from "./settings/sections";
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
} from "./settings/settings";
import { SettingsStore } from "./settings/SettingsStore";
import { useSettings } from "./settings/useSettings";
import { ThemeProvider } from "./theme/ThemeProvider";
import { Welcome } from "./welcome/Welcome";
import { shouldShowWelcome } from "./welcome/shouldShowWelcome";
import {
  Sidebar,
  type SidebarConversations,
  type SidebarHosts,
  type SidebarPlugin,
  type SidebarSaved,
} from "./sidebar/Sidebar";
import { SplitLayout, type SplitLayoutActions } from "./split/SplitLayout";
import {
  findContainer,
  sessionIdsInSplit,
  type SplitNode,
  type Tab,
} from "./state/layout";
import { SleepController } from "./terminal/sleep";
import { decideAttentionFlash } from "./workspace/attentionFlash";
import {
  DEFAULT_VIEWER_GEOMETRY,
  viewerLayoutDirection,
  type ViewerGeometry,
} from "./viewer/viewerState";
import { StatusBar } from "./statusbar/StatusBar";
import { useFocusedPaneStatus } from "./statusbar/useFocusedPaneStatus";
import { useUpdates } from "./updates/useUpdates";
import { UpdateBanner } from "./updates/UpdateBanner";
import { ForcedUpdateModal } from "./updates/ForcedUpdateModal";
import { HostRestartBanner } from "./updates/HostRestartBanner";
import { AboutDialog } from "./updates/AboutDialog";
import { needsHostRestart } from "./updates/hostRestart";
import { ViewerHost, type ViewerApi } from "./viewer/ViewerHost";
import {
  bootstrapWorkspace,
  type BootstrappedWorkspace,
  type BootstrapWorkspaceOptions,
} from "./workspace/bootstrapWorkspace";
import type { FolderSearchTarget } from "./workspace/WorkspaceController";
import { firstSessionId } from "./workspace/layoutOperations";
import { tauriWindowBus } from "./workspace/windowBus";
import { DEFAULT_WINDOW_NAME, WindowNameHeader } from "./workspace/WindowName";
import {
  manageAuxWindow,
  openAuxWindows,
  tauriWindowFactory,
} from "./workspace/windowManager";
import { MAIN_WINDOW_ID } from "./state/layout";
import type { ConnectionState } from "./host/reconnect";
import {
  DEFAULT_SIDEBAR_WIDTH,
  UiStateStore,
  applyTrayConfigure,
  setHostsCollapsed,
  setSidebarWidth,
  setViewerGeometry,
} from "./workspace/uiState";
import { useWorkspace } from "./workspace/useWorkspace";

type AppState =
  | { type: "loading" }
  | { type: "ready"; workspace: BootstrappedWorkspace }
  | { type: "error"; message: string };

export interface AppProps {
  bootstrap?: (
    options?: BootstrapWorkspaceOptions,
  ) => Promise<BootstrappedWorkspace>;
  /**
   * Which window slot this instance renders (multi-window spec): absent/main
   * for the primary window, an `aux-<n>` id for a torn-out one (main.tsx
   * reads it from `?window=`).
   */
  windowId?: string;
}

/* Action chips (spec §14). Registered at module scope so trays are populated
 * on the very first paint; the closures live in the per-render ActionContext,
 * never in the chip itself. */
registerAction({
  id: "new-tab",
  icon: "＋",
  label: "New terminal",
  run: (ctx) => (ctx.newTab as (() => void) | undefined)?.(),
});
registerAction({
  id: "folder-search",
  icon: "⌕",
  label: "New terminal in folder",
  run: (ctx) => (ctx.openFolderSearch as (() => void) | undefined)?.(),
});
registerAction({
  id: "settings",
  icon: "⚙",
  label: "Settings",
  run: (ctx) => (ctx.openSettings as (() => void) | undefined)?.(),
});
registerAction({
  id: "features",
  icon: "⋮⋮",
  label: "Features…",
  run: (ctx) => (ctx.openFeatures as (() => void) | undefined)?.(),
});
registerAction({
  id: "outputs",
  icon: "▤",
  label: "Outputs",
  run: (ctx) => (ctx.toggleOutputs as (() => void) | undefined)?.(),
});

const NO_LIVE_OUTPUTS: readonly LiveOutputRow[] = [];

/** How often the workspace rescans agent sessions for the conversation list. */
const CONVERSATIONS_RESCAN_MS = 30_000;
const NO_RECORDS: readonly LlmSessionRecord[] = [];
const emptyRecords = () => NO_RECORDS;
const NO_SAVED: readonly SavedSession[] = [];
const emptySaved = () => NO_SAVED;

/** Last path segment, for a save-dialog name a human would recognise. */
function folderTail(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

/** Everything a committed save needs beyond what the dialog edits. */
interface SavePromptState {
  prefill: SaveSessionPrefill;
  conversation?: SavedConversationRef;
  ssh?: SavedSshRef;
  lastDaemonSessionId?: number;
}

const NO_SSH_HOSTS: readonly SshHost[] = [];
const EMPTY_WITH_PASSWORD: ReadonlySet<string> = new Set();
const noopSubscribe = () => () => {};

export default function App({ bootstrap = bootstrapWorkspace, windowId }: AppProps) {
  const [state, setState] = useState<AppState>({ type: "loading" });

  useEffect(() => {
    let canceled = false;
    let ownedWorkspace: BootstrappedWorkspace | null = null;
    setState({ type: "loading" });

    // One bus per window process: main broadcasts layout truth over it, an
    // aux window forwards its mutations (single-writer rule). Outside Tauri
    // its emits reject and are swallowed, so tests and plain browsers keep
    // working unchanged.
    void bootstrap({
      windowBus: tauriWindowBus(),
      ...(windowId ? { windowId } : {}),
    }).then(
      (workspace) => {
        if (canceled) {
          disposeWorkspace(workspace);
          return;
        }
        ownedWorkspace = workspace;
        setState({ type: "ready", workspace });
      },
      () => {
        if (!canceled) {
          setState({
            type: "error",
            message: "Unable to start the TermX workspace.",
          });
        }
      },
    );

    return () => {
      canceled = true;
      if (ownedWorkspace) {
        disposeWorkspace(ownedWorkspace);
        ownedWorkspace = null;
      }
    };
  }, [bootstrap, windowId]);

  return (
    <div className="app-shell">
      {/* The ready workspace draws its OWN header: the menubar in it is wired
          to the controller, the settings store and the focused pane, none of
          which exist until the workspace does. Before that there is nothing to
          name, nowhere to store it, and no action a menu could offer. */}
      {state.type === "ready" ? (
        <ReadyWorkspace workspace={state.workspace} />
      ) : (
        <>
          <header className="app-header">
            <div className="app-brand">TermX</div>
            <div className="app-subtitle">{DEFAULT_WINDOW_NAME}</div>
          </header>
          {state.type === "loading" ? (
            <WorkspacePanel testId="workspace-loading" title="Starting TermX…">
              Connecting to the terminal host.
            </WorkspacePanel>
          ) : (
            <WorkspacePanel testId="workspace-error" title="Workspace unavailable">
              {state.message}
            </WorkspacePanel>
          )}
        </>
      )}
    </div>
  );
}

type WorkspaceConnection = NonNullable<BootstrappedWorkspace["connection"]>;

/**
 * Which reading wins when one plugin's panes disagree: a failure outranks a
 * wait, a wait outranks a success, and "nothing observed yet" never masks a
 * real answer. A plugin is one process, so its panes are reporting on the same
 * thing — the worst of them is the true state of it.
 */
const PLUGIN_HEALTH_RANK: Record<PluginHealth, number> = {
  down: 3,
  starting: 2,
  up: 1,
  unknown: 0,
};

/**
 * Bootstrap's manifest resolver (plugin spec §2), seen optionally.
 *
 * It resolves a registered folder's own `termx-plugin.json` before the bundled
 * table and is ungated by `enabled`, so it answers for a plugin that is merely
 * switched off. Declared here rather than imported so App compiles both before
 * and after the accessor lands on `BootstrappedWorkspace`, and so a window
 * booted without one degrades to the bundled table instead of failing.
 */
interface PluginManifestSource {
  pluginManifestFor?: (pluginId: string) => PluginManifest | null;
}

/**
 * The registry entry's "start with TermX" flag, seen optionally.
 *
 * Declared here rather than imported so App compiles both before and after the
 * field lands on `PluginEntry`, and so a registry written by an older TermX —
 * which has no such field — simply reads as off.
 */
interface PluginAutostartEntry {
  autostart?: boolean;
}

/** Legacy fixtures carry no reconnect machine; they are simply always up. */
const ALWAYS_CONNECTED: ConnectionState = { phase: "connected" };

function useConnectionState(connection: WorkspaceConnection | null): ConnectionState {
  const subscribe = useMemo(
    () => (onChange: () => void) =>
      connection ? connection.onStateChange(onChange) : () => undefined,
    [connection],
  );
  const getSnapshot = useMemo(
    () => () => connection?.state ?? ALWAYS_CONNECTED,
    [connection],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

function ReadyWorkspace({ workspace }: { workspace: BootstrappedWorkspace }) {
  const controller = workspace.controller;
  const snapshot = useWorkspace(controller);
  const connection = workspace.connection ?? null;
  const connectionState = useConnectionState(connection);
  // A socket that dies while the CPU is asleep is never noticed by a read
  // loop; the shell's power broadcasts are what turn a wake into an immediate
  // reconnect instead of a terminal that looks alive and answers nothing.
  useEffect(() => {
    if (!connection) {
      return;
    }
    return listenForPowerEvents(connection, listen);
  }, [connection]);
  // Legacy fixtures omit the settings store; fall back to in-memory defaults.
  const settingsStore = useMemo(
    () => workspace.settings ?? new SettingsStore(),
    [workspace],
  );
  const settings = useSettings(settingsStore);
  const uiStateStore = useMemo(
    () => workspace.uiState ?? new UiStateStore(),
    [workspace],
  );
  const uiSnapshot = useSyncExternalStore(
    uiStateStore.subscribe,
    uiStateStore.getSnapshot,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Which section the surface should land on when it is opened from a menu row
  // that names a destination. Null = wherever the surface starts on its own.
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | null>(
    null,
  );
  const [featuresOpen, setFeaturesOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [closeGuardOpen, setCloseGuardOpen] = useState(false);
  // First-run welcome (workspace root). Decided once at mount: a fresh
  // settings file, nothing already running, no root chosen. Later launches
  // find the file (Start writes it, Skip touches it) and never show it again.
  const [welcomeOpen, setWelcomeOpen] = useState(() => {
    const liveSessionCount = Object.values(snapshot.paneStates).filter(
      (pane) => pane.status === "live",
    ).length;
    return shouldShowWelcome({
      settingsWasCreated: settingsStore.wasCreated,
      liveSessionCount,
      workspaceRoot: settings.workspaceRoot,
    });
  });
  const [folderSearch, setFolderSearch] = useState<FolderSearchTarget | null>(null);
  const [conversationsFull, setConversationsFull] = useState(false);
  const [outputsOpen, setOutputsOpen] = useState(false);
  const [alreadyOpen, setAlreadyOpen] = useState<{
    record: LlmSessionRecord;
    tabId: string;
  } | null>(null);
  // Focused pane per tab is ephemeral UI state (layout spec: never persisted).
  const [focusByTab, setFocusByTab] = useState<Record<string, number>>({});
  // ...and it is App's alone, so the controller gets a PROVIDER over it. That
  // is what makes `openPlugin("split")` land beside the pane the user is in:
  // the controller's own `activeSessionId` is `firstSessionId(activeTab.split)`,
  // the leftmost leaf, which is the wrong pane in every multi-pane tab.
  //
  // A ref because a menu is built once and clicked much later - the provider
  // must read the CURRENT map, not the one that existed when it was handed
  // over, and re-registering on every focus move would be a second source of
  // truth for the same fact.
  const focusByTabRef = useRef(focusByTab);
  useEffect(() => {
    focusByTabRef.current = focusByTab;
  }, [focusByTab]);
  // The other direction: the controller asking App to MOVE focus. "Already
  // open somewhere - focus it" is only true if the pane itself takes focus;
  // switching the active tab alone leaves the ring on the pane the user came
  // from and every keystroke in that pane's terminal, which reads as the click
  // having done nothing. The controller has no DOM, so it publishes a request
  // and App performs it, once per `seq`.
  const focusRequest = snapshot.focusRequest;
  const servedFocusRef = useRef<number | null>(null);
  useEffect(() => {
    // Absent, not just null: a snapshot published by an older window - or by
    // a fixture that predates the field - carries no request at all.
    if (!focusRequest || servedFocusRef.current === focusRequest.seq) {
      return;
    }
    servedFocusRef.current = focusRequest.seq;
    const { tabId, sessionId } = focusRequest;
    const target = snapshot.layout.tabs[tabId];
    // A request that outlived its pane: the layout moved between the
    // controller's mutation and this effect. Recording a session the layout
    // has never heard of would put the ring nowhere and misanchor every later
    // split, so an unresolvable request is simply dropped.
    if (!target || !sessionIdsInSplit(target.split).includes(sessionId)) {
      return;
    }
    setFocusByTab((prev) =>
      prev[tabId] === sessionId ? prev : { ...prev, [tabId]: sessionId },
    );
    focusPaneContents(sessionId);
  }, [focusRequest, snapshot.layout.tabs]);

  useEffect(() => {
    controller.setFocusedPane((tabId) => focusByTabRef.current[tabId] ?? null);
    // A dead App's focus map must not outlive it on the controller: null is
    // "no answer", which sends the split path back to the caller's own guess.
    return () => controller.setFocusedPane(null);
  }, [controller]);
  const [dismissing, setDismissing] = useState<ReadonlySet<number>>(new Set());
  const [restarting, setRestarting] = useState<ReadonlySet<number>>(new Set());
  const viewerRef = useRef<ViewerApi | null>(null);

  const activeTabId = snapshot.activeTabId;
  // Spec §6: the active tab's IMMEDIATE parent group is the new-tab scope.
  const activeGroupId = useMemo(
    () =>
      activeTabId
        ? findContainer(snapshot.layout, { kind: "tab", id: activeTabId })
        : null,
    [snapshot.layout, activeTabId],
  );
  // Every tab stays mounted (hidden ones under display:none) so the sleep
  // lifecycle (spec §13) owns hidden panes instead of unmount destroying them.
  const allTabs = useMemo<readonly Tab[]>(
    () => Object.values(snapshot.layout.tabs),
    [snapshot.layout.tabs],
  );
  const visiblePanesByTab = useRef(new Map<string, readonly number[]>());

  // ---- Attention delivery (spec: "tell me when it's done") ----
  // Looking at a tab (it is active AND the window has OS focus) delivers its
  // attention mark. Runs on every snapshot too: a burst that settles while the
  // user is already watching clears immediately (markSeen no-ops when nothing
  // is settled, so this cannot publish-loop).
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const onFocus = () => setWindowFocused(true);
    const onBlur = () => setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  useEffect(() => {
    if (windowFocused && activeTabId) {
      controller.markTabSeen?.(activeTabId, visiblePanesByTab.current.get(activeTabId) ?? []);
    }
  }, [controller, windowFocused, activeTabId, snapshot]);

  // While the window is in the background, a tab entering "attention" flashes
  // the taskbar button — the "I'm in another app entirely" half of the ask.
  const attentionTabIds = useMemo(() => {
    const ids: string[] = [];
    for (const tab of snapshot.ungroupedTabs) {
      if (tab.activity === "attention") {
        ids.push(tab.id);
      }
    }
    for (const group of snapshot.groups) {
      for (const tab of group.tabs) {
        if (tab.activity === "attention") {
          ids.push(tab.id);
        }
      }
    }
    return ids;
  }, [snapshot.ungroupedTabs, snapshot.groups]);
  const announcedAttentionRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const { flash, announced } = decideAttentionFlash(
      attentionTabIds,
      windowFocused,
      announcedAttentionRef.current,
    );
    announcedAttentionRef.current = announced;
    if (!flash) {
      return;
    }
    void (async () => {
      try {
        const { getCurrentWindow, UserAttentionType } = await import(
          "@tauri-apps/api/window"
        );
        // Critical, not Informational: Informational blinks the taskbar button
        // four times and gives up, so anyone not watching that exact strip of
        // screen misses it. Critical holds the button lit until the window is
        // brought forward, which is the whole point — it has to still be
        // saying "done" when the user looks over minutes later.
        await getCurrentWindow().requestUserAttention(UserAttentionType.Critical);
      } catch {
        // Not running under Tauri; the sidebar mark still shows.
      }
    })();
  }, [attentionTabIds, windowFocused]);

  // One window-wide sleep controller; SplitLayout is its only visibility
  // writer (observe), the App only reads the verdict for the zZ badges.
  const sleepController = useMemo(() => new SleepController(), []);
  useEffect(() => () => sleepController.dispose(), [sleepController]);
  useEffect(() => {
    sleepController.setOption(settings.sleepHiddenTerminals);
  }, [sleepController, settings.sleepHiddenTerminals]);
  const sleeping = useSyncExternalStore(
    sleepController.subscribe,
    sleepController.getSnapshot,
  );

  // Lazy, throttled LLM notes (spec §6): the rail's visibility feed drives
  // reconcile; the scheduler reads the live engine settings itself, so
  // disk-only degrades to a no-op without tearing anything down.
  const conversationsStore = workspace.conversations ?? null;
  const noteScheduler = useMemo(() => {
    if (!conversationsStore) {
      return null;
    }
    return new NoteScheduler({
      generateBundle: tauriGenerateBundle,
      store: {
        getSnapshot: conversationsStore.getSnapshot,
        writeGeneratedNote: conversationsStore.setGeneratedNote,
      },
      settings: settingsStore,
      now: () => Date.now(),
    });
  }, [conversationsStore, settingsStore]);
  useEffect(() => () => noteScheduler?.dispose(), [noteScheduler]);

  // The save dialog resolves a pane's conversation from this list, so it must
  // be current even when the rail was never opened — scan on mount and keep it
  // fresh while the workspace lives. Unforced scans are cheap: the Rust side
  // skips unchanged transcripts via its mtime index.
  const conversationsRecords = useSyncExternalStore(
    conversationsStore?.subscribe ?? noopSubscribe,
    conversationsStore
      ? () => conversationsStore.getSnapshot().records
      : emptyRecords,
  );
  useEffect(() => {
    if (!conversationsStore) {
      return;
    }
    void conversationsStore.refresh(false);
    const timer = window.setInterval(() => {
      void conversationsStore.refresh(false);
    }, CONVERSATIONS_RESCAN_MS);
    return () => window.clearInterval(timer);
  }, [conversationsStore]);

  // Live OSC 9;77 output registrations (polish P4), keyed by termx session.
  // The dock follows the focused pane of the active tab; sidecar history is
  // keyed by conversation and lives in the DetailPane instead.
  const outputsStore = useMemo(() => new OutputsStore(), []);
  const activeTab = activeTabId ? snapshot.layout.tabs[activeTabId] : undefined;
  const focusedSessionId = activeTab
    ? resolveFocusedSession(activeTab.split, focusByTab[activeTab.id])
    : null;
  // Splitting needs a LIVE pane — SplitLayout's own handler refuses anything
  // else, and the menu must not offer what the key beside it would refuse.
  const focusedPaneLive =
    focusedSessionId !== null &&
    snapshot.paneStates[focusedSessionId]?.status === "live";
  // Closing does not: a plugin panel and a dead terminal are both panes you
  // close, and the Ctrl+Shift+W this row prints closes them. Only the absence
  // of a focused pane greys the row.
  const focusedPaneExists =
    focusedSessionId !== null &&
    snapshot.paneStates[focusedSessionId] !== undefined;
  const paneStatus=useFocusedPaneStatus(controller,focusedSessionId,
    focusedSessionId !== null && focusedPaneLive ? controller.sessionPid?.(focusedSessionId) ?? null : null,
    settings.statusBar);
  const updates=useUpdates({
    policy: settings.updatePolicy,
    snoozedVersion: uiSnapshot.updates?.snoozedVersion ?? null,
    onSnooze: (version) => controller.setUpdateSnooze(version),
    // A host-changing install: flag the restart the new UI must finish, then
    // stop the daemon so the installer can replace its exe.
    onHostChangeInstall: async () => {
      controller.setPendingHostRestart(true);
      await controller.stopHostForUpdate();
    },
  });
  const [aboutOpen, setAboutOpen] = useState(false);
  const liveSessionCountNow = Object.values(snapshot.paneStates).filter((pane) => pane.status === "live").length;
  const hostRestartDue = needsHostRestart({
    uiVersion: updates.version ?? "",
    hostVersion: snapshot.hostVersion ?? null,
    hostChanged: uiSnapshot.updates?.pendingHostRestart === true,
  });
  const [hostRestartError, setHostRestartError] = useState<string | null>(null);
  const hostRestartStarted = useRef(false);
  const restartHost = () => {
    if (hostRestartStarted.current) return;
    hostRestartStarted.current = true;
    setHostRestartError(null);
    controller.restartHost().catch((error: unknown) => {
      hostRestartStarted.current = false;
      setHostRestartError(error instanceof Error ? error.message : String(error));
    });
  };
  // With nothing live there is nothing to lose: finish the update by itself.
  useEffect(() => {
    if (hostRestartDue && liveSessionCountNow === 0) restartHost();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostRestartDue, liveSessionCountNow]);
  const installUpdate = () => {
    if (updates.update.kind === "ready") void updates.install();
    else if (updates.update.kind === "checked" || updates.update.kind === "error") void updates.download();
  };
  const [changingDirectory,setChangingDirectory]=useState(false);
  const statusFocusedId=useRef(focusedSessionId);
  statusFocusedId.current=focusedSessionId;
  const focusedProfile=focusedSessionId !== null ? controller.sessionProfile?.(focusedSessionId) : null;
  const focusedRemote=focusedSessionId !== null ? controller.sshPaneInfo?.(focusedSessionId) : null;
  const directoryDisabledReason=!focusedPaneLive ? "Select a live terminal"
    : focusedRemote ? "Folder selection is available for local terminals"
    : focusedProfile !== "powershell" ? "Folder selection requires an integrated PowerShell terminal"
    : !paneStatus.probe?.alive ? "Checking whether the shell is idle"
    : paneStatus.probe.at_prompt===undefined ? "Open a new PowerShell terminal after restarting TermX to enable folder selection"
    : paneStatus.probe.busy || !paneStatus.probe.at_prompt ? "Return to a clear shell prompt" : undefined;
  const liveOutputs = useSyncExternalStore(
    outputsStore.subscribe,
    () =>
      focusedSessionId !== null
        ? outputsStore.snapshotFor(focusedSessionId)
        : NO_LIVE_OUTPUTS,
  );
  const handleSessionOutput = (sessionId: number, path: string) => {
    outputsStore.register(sessionId, path, Date.now());
    // A deliverable just landed — surface the dock like Claude Code's output
    // section does, instead of leaving it behind a chip the user must know.
    setOutputsOpen(true);
  };

  // Ctrl+scroll zoom from any pane. One shared size for every terminal —
  // reading the store directly (not the render's `settings`) keeps a fast
  // wheel burst from clamping against a stale snapshot.
  const adjustTerminalFontSize = (delta: 1 | -1) => {
    const current = settingsStore.getSnapshot().terminalFontSize;
    const next = Math.min(
      TERMINAL_FONT_SIZE_MAX,
      Math.max(TERMINAL_FONT_SIZE_MIN, current + delta),
    );
    if (next !== current) {
      settingsStore.update({ terminalFontSize: next });
    }
  };

  // Resume with dedupe (polish P6): "already-open" raises the dialog; a
  // resume that actually opened a tab drops the full-screen overlay so the
  // new terminal is visible.
  const handleResume = (record: LlmSessionRecord) => {
    void controller.resumeSession(record).then((outcome) => {
      if (outcome.kind === "already-open") {
        setAlreadyOpen({ record, tabId: outcome.tabId });
      } else if (outcome.kind === "opened") {
        setConversationsFull(false);
        // `claude --resume` writes its NEW transcript within seconds, but the
        // regular rescan is 30s — long enough for the list to still show only
        // the conversation that was just superseded. Two early forced scans
        // catch it without turning the scanner into a hot loop.
        for (const delayMs of [4_000, 15_000]) {
          window.setTimeout(() => {
            void conversationsStore?.refresh(true);
          }, delayMs);
        }
      }
    });
  };

  // The controller routes the ask-searcher policy through this handler.
  useEffect(() => {
    controller.setFolderSearchHandler((target) => setFolderSearch(target));
    return () => controller.setFolderSearchHandler(null);
  }, [controller]);

  // Ctrl+Shift+O opens the folder searcher targeting the active tab's group.
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) {
        return;
      }
      if (event.key.toLowerCase() !== "o") {
        return;
      }
      if (isEditableElement(document.activeElement)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setFolderSearch({ groupId: activeGroupId, profile: null });
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [activeGroupId]);

  // Ctrl+Shift+R opens the session palette (spec §4), gated on the setting.
  useEffect(() => {
    if (!conversationsStore) {
      return;
    }
    const handleKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) {
        return;
      }
      if (event.key.toLowerCase() !== "r") {
        return;
      }
      if (!settingsStore.getSnapshot().conversationsPalette) {
        return;
      }
      if (isEditableElement(document.activeElement)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setPaletteOpen(true);
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [conversationsStore, settingsStore]);

  // ---- Multi-window lifecycle (multi-window spec) ----
  // MAIN keeps every aux slot backed by a real OS window: at boot (adopt) and
  // whenever a move-to-new-window adds a slot. Outside Tauri the factory's
  // probes throw and openAuxWindows contains that per window.
  const auxWindowIds = (snapshot.windowIds ?? [])
    .filter((id) => id !== MAIN_WINDOW_ID)
    .join("\0");
  useEffect(() => {
    if (controller.windowId !== MAIN_WINDOW_ID || auxWindowIds.length === 0) {
      return;
    }
    void openAuxWindows(controller.getSnapshot().layout, tauriWindowFactory());
  }, [controller, auxWindowIds]);
  // An AUX window owns its own close: items return to main (forwarded and
  // flushed over the bus), then the window destroys itself — the app-level
  // CloseGuard below never runs here. It also records its bounds, debounced,
  // so relaunch restores the position.
  useEffect(() => {
    if (controller.windowId === MAIN_WINDOW_ID) {
      return;
    }
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const current = getCurrentWindow();
        const managed = manageAuxWindow({
          windowId: controller.windowId,
          controller,
          chrome: {
            onCloseRequested: (handler) => current.onCloseRequested(handler),
            onMoved: (handler) => current.onMoved(handler),
            onResized: (handler) => current.onResized(handler),
            outerPosition: () => current.outerPosition(),
            outerSize: () => current.outerSize(),
            destroy: () => current.destroy(),
          },
        });
        if (cancelled) {
          managed();
        } else {
          dispose = managed;
        }
      } catch {
        // Not running under Tauri; the OS close button just closes.
      }
    })();
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [controller]);

  // Window close (spec §15): silent/keep-running lets the window close (the
  // daemon keeps sessions), stop-all shuts the host down first, ask shows the
  // CloseGuard. Outside Tauri (tests, plain browser) this wires nothing.
  // MAIN window only — an aux window's close is the return-to-main flow above.
  const anyAlive = useMemo(
    () => Object.values(snapshot.paneStates).some((pane) => pane.status === "live"),
    [snapshot.paneStates],
  );
  const anyAliveRef = useRef(anyAlive);
  anyAliveRef.current = anyAlive;
  const bypassCloseGuardRef = useRef(false);
  /**
   * Every debounced disk write, emptied before the webview dies. Nothing on
   * this path used to flush at all, so a Settings change (enable, disable, Add
   * folder, Remove) or a layout edit made inside its debounce window was
   * simply lost on quit.
   *
   * Registry first, then the controller: `plugins_v1.json` is what the layout
   * and the pane bindings REFER to. A half-done shutdown that saved only the
   * registry just forgets a pane; one that saved only the layout names a
   * plugin with no entry — "not installed" on the next boot, with the folder
   * path gone. Both are best-effort: a failed save reaches the user through
   * `onSaveError`, and neither may strand a window that is trying to close.
   */
  const flushBeforeClose = async (): Promise<void> => {
    try {
      await workspace.plugins.flush();
    } catch {
      // Never hold a closing window open on a rejected write.
    }
    try {
      await controller.flush();
    } catch {
      // Same: the layout/bindings flush is best-effort too.
    }
  };
  const closeWindow = async (stopAll: boolean): Promise<void> => {
    // Strictly BEFORE the shutdown below: the layout half of `flush()` writes
    // through the daemon client, which `shutdown()` takes away.
    await flushBeforeClose();
    if (stopAll) {
      try {
        workspace.client.shutdown?.();
      } catch {
        // The window is closing either way; never block on a dead socket.
      }
      // Give the shutdown frame a beat to flush before the webview dies.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    bypassCloseGuardRef.current = true;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch {
      // Not running under Tauri; nothing to close.
    }
  };
  const closeWindowRef = useRef(closeWindow);
  closeWindowRef.current = closeWindow;
  useEffect(() => {
    if (controller.windowId !== MAIN_WINDOW_ID) {
      return;
    }
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const stop = await getCurrentWindow().onCloseRequested((event) => {
          if (bypassCloseGuardRef.current) {
            return;
          }
          const decision = decideOnClose(
            settingsStore.getSnapshot().onWindowClose,
            anyAliveRef.current,
          );
          // Nothing to ask the user, but the debounced writes still have to
          // land, so this close is held as well: flush, then close explicitly.
          if (decision === "silent" || decision === "keep-running") {
            event.preventDefault();
            void closeWindowRef.current(false);
            return;
          }
          event.preventDefault();
          if (decision === "stop-all") {
            void closeWindowRef.current(true);
            return;
          }
          setCloseGuardOpen(true);
        });
        if (cancelled) {
          stop();
        } else {
          unlisten = stop;
        }
      } catch {
        // Not running under Tauri; the OS close button just closes.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [settingsStore, controller]);
  const handleCloseDecision = (decision: CloseDecision, remember: boolean) => {
    setCloseGuardOpen(false);
    if (remember) {
      settingsStore.update({ onWindowClose: decision });
    }
    void closeWindow(decision === "stop-all");
  };

  // The pane pin button reads through a ref: the actions cache below outlives
  // any single render, and the save handler closes over per-render snapshots
  // (records, saved entries) that must be current at CLICK time.
  const openSaveForPaneRef = useRef<(tabId: string, sessionId: number) => void>(
    () => undefined,
  );
  const openSaveForRecordRef = useRef<(record: LlmSessionRecord) => void>(
    () => undefined,
  );
  const paneSaveEnabled =
    (workspace.saved ?? null) !== null && settings.savedPaneButton;
  const railSaveEnabled =
    (workspace.saved ?? null) !== null && settings.savedConversationsRail;

  // Per-tab SplitLayout actions, cached so hidden layouts keep stable props.
  const actionsFor = useMemo(() => {
    const cache = new Map<string, SplitLayoutActions>();
    return (tabId: string): SplitLayoutActions => {
      let cached = cache.get(tabId);
      if (!cached) {
        cached = {
          splitPane(sessionId, dir) {
            void controller.splitPane(tabId, sessionId, dir).then((created) => {
              if (created !== null) {
                setFocusByTab((prev) => ({ ...prev, [tabId]: created }));
              }
            });
          },
          closePane(sessionId) {
            return controller.closePane(tabId, sessionId);
          },
          async dismissPane(sessionId) {
            setDismissing((prev) => new Set(prev).add(sessionId));
            try {
              await controller.closePane(tabId, sessionId);
            } finally {
              setDismissing((prev) => {
                const next = new Set(prev);
                next.delete(sessionId);
                return next;
              });
            }
          },
          deadPaneResumeTitle(sessionId) {
            return controller.deadPaneResumeTitle?.(sessionId) ?? null;
          },
          async restartPane(sessionId, mode) {
            setRestarting((prev) => new Set(prev).add(sessionId));
            try {
              const created = await controller.restartPane(tabId, sessionId, mode);
              if (created !== null) {
                setFocusByTab((prev) => ({ ...prev, [tabId]: created }));
              }
            } finally {
              setRestarting((prev) => {
                const next = new Set(prev);
                next.delete(sessionId);
                return next;
              });
            }
          },
          resizePane(path, sizes) {
            controller.resizePane(tabId, path, sizes);
          },
          // A panel's Relaunch re-runs the plugin's ensure-up and KEEPS the
          // pane id — never `restartPane`, which would hand the pane a shell.
          relaunchPlugin(sessionId) {
            void controller.relaunchPlugin(sessionId);
          },
          popOutPane(sessionId) {
            controller.popOutPane(tabId, sessionId);
          },
          ...(paneSaveEnabled
            ? {
                savePane(sessionId: number) {
                  openSaveForPaneRef.current(tabId, sessionId);
                },
              }
            : {}),
        };
        cache.set(tabId, cached);
      }
      return cached;
    };
  }, [controller, paneSaveEnabled]);

  const viewerGeometry = uiSnapshot.viewerGeometry ?? DEFAULT_VIEWER_GEOMETRY;
  const onViewerGeometry = (geometry: ViewerGeometry) =>
    uiStateStore.update((current) => setViewerGeometry(current, geometry));
  const configureTray = (tray: TrayId, ids: readonly string[] | null) =>
    uiStateStore.update((current) => applyTrayConfigure(current, tray, ids));

  // Scrollback the ring has evicted lives only in the host's spill file, so it
  // is read a page at a time through the viewer rather than poured back into
  // the terminal. Absent on legacy fixtures whose client cannot read history —
  // the pane then never offers the bar at all.
  const readHistory = workspace.client.readHistory?.bind(workspace.client);
  const openHistory = useMemo(
    () =>
      readHistory
        ? (sessionId: number, beforeOffset: bigint) =>
          viewerRef.current?.openHistory({
            sessionId,
            title: `Session ${sessionId}`,
            beforeOffset,
            read: (before, maxBytes) => readHistory(sessionId, before, maxBytes),
          })
        : null,
    [readHistory],
  );

  const trayContext = useMemo<ActionContext>(
    () => ({
      newTab: () => void controller.createTab({ groupId: null, profile: null }),
      openFolderSearch: () => setFolderSearch({ groupId: activeGroupId, profile: null }),
      openSettings: () => setSettingsOpen(true),
      openFeatures: () => setFeaturesOpen(true),
      toggleOutputs: () => setOutputsOpen((open) => !open),
    }),
    [controller, activeGroupId],
  );

  const sidebarConversations = useMemo<SidebarConversations | null>(() => {
    if (!conversationsStore) {
      return null;
    }
    return {
      store: conversationsStore,
      settings,
      onResume: handleResume,
      onOpenTranscript: (record) => viewerRef.current?.openTranscript(record),
      listArtifacts: tauriListArtifacts,
      onOpenFile: (path) => viewerRef.current?.openFile(path),
      onOpenFolder: (parentDir) =>
        void controller.createTabWithCwd({
          groupId: activeGroupId,
          profile: null,
          cwd: parentDir,
        }),
      onVisibleRecords: (keys) => noteScheduler?.reconcile([...keys]),
      listOutputs: tauriListOutputs,
      dismissOutput: tauriDismissOutput,
      ...(railSaveEnabled
        ? {
            onSaveConversation: (record: LlmSessionRecord) =>
              openSaveForRecordRef.current(record),
          }
        : {}),
    };
    // handleResume is recreated per render but closes only over stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    conversationsStore,
    settings,
    controller,
    activeGroupId,
    noteScheduler,
    railSaveEnabled,
  ]);

  // Saved sessions (saved-sessions spec). The store is machine-written and
  // lives with the workspace; the sidebar only reads the list and asks the
  // controller to resume a row.
  const savedStore = workspace.saved ?? null;
  const savedEntries = useSyncExternalStore(
    savedStore?.subscribe ?? noopSubscribe,
    savedStore ? savedStore.getSnapshot : emptySaved,
  );
  const sidebarSaved = useMemo<SidebarSaved | null>(() => {
    if (!savedStore) {
      return null;
    }
    return {
      enabled: settings.savedSidebarList,
      entries: savedEntries,
      onResume: (entry) => void controller.resumeSaved(entry),
      onRename: (id, name) => savedStore.update(id, { name }),
      onDescribe: (id, description) => savedStore.update(id, { description }),
      onDelete: (id) => savedStore.remove(id),
    };
  }, [savedStore, savedEntries, settings.savedSidebarList, controller]);

  // SSH hosts + credentials (ssh-sessions spec §1). The inventory is read once
  // at boot; the credentials store is machine-written like the saved store.
  const sshHosts = workspace.sshHosts ?? NO_SSH_HOSTS;
  const sshCredentials = workspace.sshCredentials ?? null;
  const withPassword = useSyncExternalStore(
    sshCredentials?.subscribe ?? noopSubscribe,
    sshCredentials ? sshCredentials.getSnapshot : () => EMPTY_WITH_PASSWORD,
  );
  const hostByAlias = (alias: string): SshHost | null =>
    sshHosts.find((host) => host.aliases.includes(alias)) ?? null;
  // The set-password dialog target (ssh-sessions spec §6); null = closed.
  const [passwordAlias, setPasswordAlias] = useState<string | null>(null);

  const sidebarHosts = useMemo<SidebarHosts | null>(() => {
    if (sshHosts.length === 0 && !sshCredentials) {
      return null;
    }
    return {
      enabled: settings.sshHostsSidebar,
      menuEnabled: settings.sshHostsMenu,
      hosts: sshHosts,
      onConnect: (alias) => {
        const host = hostByAlias(alias);
        if (host) {
          void controller.connectSshHost(host);
        }
      },
      // Storing is offered only under the "store" policy (spec §6).
      ...(sshCredentials && settings.sshPasswordPolicy === "store"
        ? { onSetPassword: (alias: string) => setPasswordAlias(alias) }
        : {}),
      withPassword,
      collapsed: uiSnapshot.hostsCollapsed === true,
      onToggleCollapsed: (collapsed: boolean) =>
        uiStateStore.update((current) => setHostsCollapsed(current, collapsed)),
    };
  }, [
    sshHosts,
    sshCredentials,
    withPassword,
    settings.sshHostsSidebar,
    settings.sshHostsMenu,
    settings.sshPasswordPolicy,
    controller,
    uiSnapshot.hostsCollapsed,
    uiStateStore,
  ]);

  // Installed plugins (plugin spec §2). The registry answers which plugins
  // exist and whether they are switched on; the manifest supplies the name and
  // glyph every surface shows. Bootstrap always builds this store — a fallback
  // here would be a SECOND registry with no `save` behind it and a different
  // instance from the one the plugin lifecycle gates on, so Settings would
  // write nothing, report nothing, and disagree with `ensureUp`.
  const pluginsStore = workspace.plugins;
  const pluginsRegistry = useSyncExternalStore(
    pluginsStore.subscribe,
    pluginsStore.getSnapshot,
  );
  // Bootstrap's folder-manifest cache fills in LATE — after the boot budget it
  // gave itself, and again a debounce after the registry changes — and none of
  // that lands in React state. Without this subscription the memos below stay
  // on whatever the first render resolved (the bundled table, or the plugin's
  // bare id) until some unrelated render happens to refresh them, which is a
  // panel wearing the wrong name for as long as the user leaves it alone.
  // The counter is the whole mechanism: it exists to be a dependency.
  const [manifestRevision, setManifestRevision] = useState(0);
  useEffect(() => {
    const bump = () => setManifestRevision((revision) => revision + 1);
    const unsubscribe = workspace.subscribeManifests(bump);
    // A cache that landed between this render and this effect would otherwise
    // notify nobody, so read once more now that the subscription is live.
    bump();
    return unsubscribe;
  }, [workspace]);

  // Bootstrap resolves a registered folder's own `termx-plugin.json` and falls
  // back to the bundled table; it is ungated by `enabled`, so it answers for a
  // plugin that is merely switched off. Read through an OPTIONAL view: this
  // compiles both before and after that accessor lands on the workspace, and a
  // window booted without one still names the bundled plugins.
  const knownManifest = useMemo(() => {
    const resolve = (workspace as PluginManifestSource).pluginManifestFor;
    return (pluginId: string): PluginManifest | null =>
      resolve?.(pluginId) ?? manifestFor(pluginId, null);
    // `manifestRevision` is not read here and is not meant to be: the accessor
    // answers differently once the cache moves, so the revision is what makes
    // this memo — and everything derived from it — ask again.
  }, [workspace, manifestRevision]);
  // Registered plugins UNION the bundled table: a first-party panel is named
  // even before anyone adds its folder, which is what keeps the right glyph on
  // a pane whose plugin has since been removed. `enabled` is the registry's
  // alone, so an un-added plugin is listed and offered by nothing. Sorted by
  // name, so the menus read the same however the JSON file is keyed.
  const sidebarPlugins = useMemo<readonly SidebarPlugin[]>(() => {
    const ids = new Set([
      ...Object.keys(pluginsRegistry.plugins),
      ...Object.keys(BUNDLED_MANIFESTS),
    ]);
    const listed: SidebarPlugin[] = [];
    for (const id of ids) {
      const manifest = knownManifest(id);
      if (manifest === null) {
        // A plugin TermX cannot name has nothing to put in a menu. Settings is
        // where that is explained, with the field that failed.
        continue;
      }
      listed.push({
        id,
        name: manifest.name,
        icon: manifest.icon,
        enabled: pluginsRegistry.plugins[id]?.enabled === true,
      });
    }
    return listed.sort((left, right) => left.name.localeCompare(right.name));
  }, [pluginsRegistry, knownManifest, manifestRevision]);


  // The manifest that DRESSES a bound pane. Registry presence is the gate, and
  // deliberately not the enabled flag: switching a plugin off must not strip
  // the name off a panel that is still on screen, while removing it should.
  // A null answer no longer costs the user the pane — SplitLayout mounts the
  // panel either way and falls back to the plugin's id for a name — so this
  // decides how a pane is LABELLED, not whether it survives.
  const pluginManifestFor = useMemo(
    () =>
      (pluginId: string): PluginManifest | null =>
        pluginsRegistry.plugins[pluginId] === undefined
          ? null
          : knownManifest(pluginId),
    [pluginsRegistry, knownManifest, manifestRevision],
  );

  // Live health per plugin for the Settings rows, read off the panes that are
  // actually on screen: the plugin's own process has no other observer here.
  // A plugin with NO open panel is left out of the record entirely, so the
  // panel draws no mark rather than claiming a state nothing has watched.
  const pluginHealth = useMemo<Record<string, PluginHealth>>(() => {
    const worst: Record<string, PluginHealth> = {};
    for (const state of Object.values(snapshot.paneStates)) {
      if (state.status !== "plugin" || state.pluginId === undefined) {
        continue;
      }
      // A bound pane with no reading yet is "unknown", not healthy.
      const reading = state.pluginHealth ?? "unknown";
      const held = worst[state.pluginId];
      if (held === undefined || PLUGIN_HEALTH_RANK[reading] > PLUGIN_HEALTH_RANK[held]) {
        worst[state.pluginId] = reading;
      }
    }
    return worst;
  }, [snapshot.paneStates]);

  /**
   * The launcher's rows: one per REGISTRY entry.
   *
   * Deliberately NOT the rail's union with the bundled table. The rail names
   * panes, so naming a first-party panel before anyone adds its folder is
   * right; a launcher OFFERS to start things, and offering to start a plugin
   * that is not installed is an offer it cannot keep.
   *
   * The dot is three-valued and the middle value is the honest one: health is
   * only observed through panes that are on screen, so a plugin whose server is
   * up with nothing open still reads "down" — registered, nothing answering
   * here. "starting" reads the same way rather than as a fourth state the
   * mockup never drew.
   */
  const pluginMenuRows = useMemo<readonly PluginsMenuRow[]>(() => {
    const rows: PluginsMenuRow[] = [];
    for (const [id, entry] of Object.entries(pluginsRegistry.plugins)) {
      const manifest = knownManifest(id);
      if (manifest === null) {
        // A plugin TermX cannot name has nothing to put in a menu, exactly as
        // in the rail. Settings is where that is explained, with the field
        // that failed.
        continue;
      }
      rows.push({
        id,
        name: manifest.name,
        icon: manifest.icon,
        status: !entry.enabled
          ? "disabled"
          : pluginHealth[id] === "up"
            ? "up"
            : "down",
        autostart: (entry as PluginAutostartEntry).autostart === true,
        surfaces: surfacesOf(manifest),
      });
    }
    return rows.sort((left, right) => left.name.localeCompare(right.name));
  }, [pluginsRegistry, knownManifest, pluginHealth, manifestRevision]);

  // Plugin management WRITES `plugins_v1.json`, and the main window is its only
  // writer (spec §2) — bootstrap hands every window a read-write store, so the
  // single-writer rule is kept here. An aux window is handed no bundle and
  // shows the surface's own "unavailable in this window" note.
  const settingsPlugins = useMemo<SettingsPlugins | null>(() => {
    if (controller.windowId !== MAIN_WINDOW_ID) {
      return null;
    }
    return {
      store: pluginsStore,
      // The panel reads a registered folder's own `termx-plugin.json` through
      // this seam; a folder without one falls back to the bundled table.
      native: tauriPluginNative,
      health: pluginHealth,
      // The ONE entry point, exactly as the launcher uses it: the panel names
      // the surface it wants and the controller owns what that means. Wiring
      // this to `openPluginTab` instead would still open something, which is
      // why it has to be pinned rather than eyeballed.
      onOpen: (pluginId: string, surface?: PluginSurface) =>
        void controller.openPlugin(pluginId, surface),
    };
  }, [controller, pluginsStore, pluginHealth]);

  // Flipping the "encrypt stored passwords" setting rewrites every stored
  // secret to match (spec §6). Skip the first render — the setting did not
  // change, and reencrypting the freshly-loaded store would be pointless work.
  const encryptFlipSeen = useRef(false);
  useEffect(() => {
    if (!encryptFlipSeen.current) {
      encryptFlipSeen.current = true;
      return;
    }
    if (sshCredentials) {
      void sshCredentials
        .reencryptAll(settings.sshEncryptPasswords)
        .catch((error: unknown) => {
          // A DPAPI failure must not look like a successful re-encrypt: the
          // stored scheme stays as it was, so say so rather than swallow it.
          console.error("failed to re-encrypt ssh passwords", error);
        });
    }
  }, [settings.sshEncryptPasswords, sshCredentials]);

  // Save dialog (saved-sessions spec §"Save flow"). One dialog serves both the
  // pane pin button and the conversations-rail action; savePrompt carries what
  // the dialog does not edit (conversation ref, daemon session id).
  const [savePrompt, setSavePrompt] = useState<SavePromptState | null>(null);

  const openSaveForPane = async (tabId: string, sessionId: number) => {
    if (!savedStore) {
      return;
    }
    const cwd = controller.sessionCwd(sessionId) ?? "";
    // An SSH pane knows its host + captured conversation directly; a local
    // pane resolves it from its resume key, else its own directory.
    const sshInfo = controller.sshPaneInfo(sessionId);
    const conversation = sshInfo
      ? sshConversationForPane(sessionId)
      : await localConversationForPane(tabId, cwd, sessionId);
    // save() upserts by conversation id and treats its input as the whole
    // entry, so an existing save must feed its fields back through the dialog.
    const existing = conversation
      ? savedEntries.find((entry) => entry.conversation?.id === conversation.id)
      : undefined;
    const sshLabel = sshInfo ? sshHostLabel(sshInfo.host) : null;
    setSavePrompt({
      prefill: {
        name:
          existing?.name ??
          conversation?.title ??
          (folderTail(cwd) || `Session ${sessionId}`),
        description: existing?.description ?? "",
        // The pane's live cwd wins (spec: "prefilled from sessionCwd") — the
        // stored folder is only a fallback when the pane's is unknown.
        cwd: cwd || (existing?.cwd ?? ""),
        conversationLabel: conversation?.title ?? null,
        sshLabel,
        updatesExisting: existing !== undefined,
      },
      ...(conversation ? { conversation } : {}),
      ...(sshInfo ? { ssh: { host: sshInfo.host } } : {}),
      lastDaemonSessionId: sessionId,
    });
    // The remote title (a /rename the user did) lands async — refresh the open
    // dialog for this same pane when the probe resolves (spec §3).
    if (sshInfo && conversation && !existing) {
      const host = hostByAlias(sshInfo.host);
      if (host) {
        void probeRemoteTitle(host.alias, conversation.provider, conversation.id)
          .then((title) => {
            if (!title) {
              return;
            }
            setSavePrompt((current) =>
              current &&
              current.ssh?.host === sshInfo.host &&
              current.conversation?.id === conversation.id
                ? {
                    ...current,
                    // Both the suggested name and the "Resumes:" line: a remote
                    // pin whose name would otherwise stay the raw id (the dialog
                    // adopts the name only while the user has not edited it).
                    prefill: {
                      ...current.prefill,
                      name: title,
                      conversationLabel: title,
                    },
                    conversation: current.conversation
                      ? { ...current.conversation, title }
                      : current.conversation,
                  }
                : current,
            );
          });
      }
    }
  };
  openSaveForPaneRef.current = openSaveForPane;

  // A local pane's conversation, resolved by explicit resume key or cwd match.
  const localConversationForPane = async (
    tabId: string,
    cwd: string,
    sessionId: number,
  ): Promise<SavedConversationRef | undefined> => {
    const captured = await controller.capturedLocalConversation?.(sessionId);
    if (captured) return { provider: captured.provider, id: captured.id, title: captured.title,
      ...(captured.launch !== undefined ? { launch: captured.launch } : {}),
    };
    const link = resolveLinkage({
      explicitKey: controller.resumedSessionKeyForTab(tabId),
      paneCwd: cwd === "" ? null : cwd,
      candidates: conversationsRecords,
    });
    if (!link) return undefined;
    const record = await controller.conversationWithLaunch(link.record);
    return { provider: record.provider, id: record.id, title: record.title,
      ...(record.launch !== undefined ? { launch: record.launch } : {}),
    };
  };

  // An SSH pane's conversation from the id captured when claude/codex started.
  const sshConversationForPane = (
    sessionId: number,
  ): SavedConversationRef | undefined => {
    const capture = controller.capturedConversation(sessionId);
    return capture
      ? { provider: capture.provider, id: capture.id, title: capture.id }
      : undefined;
  };

  // "SSH: user@host" for the save dialog, from the parsed inventory.
  const sshHostLabel = (alias: string): string => {
    const host = hostByAlias(alias);
    const target = host?.hostName ?? alias;
    return host?.user ? `SSH: ${host.user}@${target}` : `SSH: ${target}`;
  };

  const openSaveForRecord = async (record: LlmSessionRecord) => {
    // The rail disables its Save button without a cwd; this is the backstop.
    if (!savedStore || record.cwd === null) {
      return;
    }
    const recordedCwd = record.cwd;
    record = await controller.conversationWithLaunch(record);
    const existing = savedEntries.find(
      (entry) => entry.conversation?.id === record.id,
    );
    setSavePrompt({
      prefill: {
        name: existing?.name ?? record.title,
        description: existing?.description ?? "",
        cwd: existing?.cwd ?? recordedCwd,
        conversationLabel: record.title,
        updatesExisting: existing !== undefined,
      },
      conversation: {
        provider: record.provider,
        id: record.id,
        title: record.title,
        ...(record.launch !== undefined ? { launch: record.launch } : {}),
      },
      // A rail save knows no pane, but save() replaces the whole entry — so
      // the stored reattach link must ride along or a description tweak from
      // the rail would downgrade the next resume to a fresh restore.
      ...(existing?.lastDaemonSessionId !== undefined
        ? { lastDaemonSessionId: existing.lastDaemonSessionId }
        : {}),
    });
  };
  openSaveForRecordRef.current = openSaveForRecord;

  // ---- The menubar (menubar + plugin-placement spec) ----
  // Every row is a second doorway onto an action some other surface already
  // offers — the rail's context menus, the pane toolbar, a keyboard shortcut.
  // Nothing below reimplements one.
  const workspaceRows: readonly MenuRow[] = workspaceMenu({
    hasLivePane: focusedPaneLive,
    canClosePane: focusedPaneExists,
    canSaveSession:
      savedStore !== null && activeTabId !== null && focusedSessionId !== null,
    newTab: () =>
      void controller.createTab({ groupId: activeGroupId, profile: null }),
    openFolderAsTab: () =>
      setFolderSearch({ groupId: activeGroupId, profile: null }),
    // Through the cached per-tab actions, so a menu split lands the focus ring
    // on the new pane exactly as the pane toolbar's split does.
    splitPane: (dir) => {
      if (activeTabId !== null && focusedSessionId !== null) {
        actionsFor(activeTabId).splitPane(focusedSessionId, dir);
      }
    },
    // The SAME Ctrl+Shift+W the keyboard sends. The confirmation a LIVE pane
    // gets before it dies lives inside SplitLayout's handler, so calling
    // closePane() from here would be a second implementation whose one
    // difference from the first is that it kills the pane without asking.
    closePane: () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "w",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    // A genuinely NEW window, in ONE structural write. Creating a tab here and
    // shipping it out afterwards meant diffing the layout to find it, and that
    // diff can pick up a tab MAIN created during the await; the controller op
    // has the whole thing under one mutation and moves nothing on failure.
    newWindow: () => void controller.createTabInNewWindow({ profile: null }),
    // F2 on the header's own label: the editor is that component's state, and
    // F2 is the key it already listens for — the same route the keyboard takes.
    renameWindow: () => {
      const label = document.querySelector<HTMLElement>(
        "[data-testid='window-name']",
      );
      label?.focus();
      label?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true }),
      );
    },
    saveSession: () => {
      if (activeTabId !== null && focusedSessionId !== null) {
        openSaveForPane(activeTabId, focusedSessionId);
      }
    },
  });


  // Written field by field rather than through a computed key: a settings
  // patch built from a variable name is a patch TypeScript cannot check.
  const setChrome = (field: ViewToggleField, next: boolean) => {
    settingsStore.update(
      field === "sideRail"
        ? { sideRail: next }
        : field === "conversationsRail"
          ? { conversationsRail: next }
          : { statusBar: next },
    );
  };

  const menubarMenus: readonly MenuSpec[] = [
    { kind: "menu", id: "workspace", label: "Workspace", rows: workspaceRows },
    {
      kind: "menu",
      id: "view",
      label: "View",
      rows: viewMenu({
        sideRail: settings.sideRail,
        conversationsRail: settings.conversationsRail,
        statusBar: settings.statusBar,
        toggle: setChrome,
      }),
    },
    {
      kind: "panel",
      id: "plugins",
      label: "Plugins",
      render: (close) => (
        <PluginsMenu
          rows={pluginMenuRows}
          onOpen={(pluginId, surface) => {
            // The surface is passed through ONLY when a chip was pressed. A row
            // press must reach the controller with no surface at all, so the
            // manifest's default is read in one place instead of being copied
            // into the menu that draws it.
            void (surface === undefined
              ? controller.openPlugin(pluginId)
              : controller.openPlugin(pluginId, surface));
          }}
          onManage={() => {
            setSettingsSection("plugins");
            setSettingsOpen(true);
          }}
          onDone={close}
        />
      ),
    },
    {
      kind: "item",
      id: "settings",
      label: "Settings",
      onSelect: () => {
        setSettingsSection(null);
        setSettingsOpen(true);
      },
    },
    {
      kind: "menu",
      id: "help",
      label: "Help",
      rows: [aboutRow({ openAbout: () => setAboutOpen(true) })],
    },
  ];

  const commitSave = (result: {
    name: string;
    description: string;
    cwd: string;
  }) => {
    if (!savedStore || !savePrompt) {
      return;
    }
    savedStore.save({
      name: result.name,
      ...(result.description.length > 0
        ? { description: result.description }
        : {}),
      cwd: result.cwd,
      ...(savePrompt.conversation
        ? { conversation: savePrompt.conversation }
        : {}),
      ...(savePrompt.ssh ? { ssh: savePrompt.ssh } : {}),
      ...(savePrompt.lastDaemonSessionId !== undefined
        ? { lastDaemonSessionId: savePrompt.lastDaemonSessionId }
        : {}),
    });
    setSavePrompt(null);
  };

  return (
    <>
      <header className="app-header">
        <div className="app-brand">TermX</div>
        {/* The window's own label, read from the layout it lives in. */}
        <WindowNameHeader workspace={workspace} />
        {/* The hairline that separates naming the window from acting on it. */}
        <span className="app-header__divider" aria-hidden="true" />
        <Menubar menus={menubarMenus} />
      </header>
      <ConnectionBanner
        state={connectionState}
        onRetry={() => connection?.retryNow()}
      />
      <ThemeProvider themeId={settings.theme} />
      <UpdateBanner update={updates.update} onInstall={installUpdate} onLater={updates.snooze} onNotes={() => void updates.open()} />
      <HostRestartBanner open={hostRestartDue} liveCount={liveSessionCountNow} onRestart={restartHost} error={hostRestartError} />
      <div className="app-workspace">
        {/* Hidden from the View menu, and only ever from there: the bar the
            toggle lives on stays on screen, so the rail can always come back. */}
        {settings.sideRail ? (
          <Sidebar
            snapshot={snapshot}
            actions={controller}
            windowId={controller.windowId}
            hostConnected={connectionState.phase === "connected"}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenFolderSearch={(groupId) =>
              setFolderSearch({ groupId, profile: null })}
            maxGroupDepth={settings.maxGroupDepth}
            // The rail's hover preview names panes from the same source the pane
            // headers do, so the two can never disagree.
            paneTitles={controller.paneTitles}
            // ...and where each of them is standing. A pane name is a profile
            // and a folder tail, which two panes in one repo share; the path is
            // what tells them apart.
            paneCwds={controller.paneCwds}
            {...(sidebarConversations ? { conversations: sidebarConversations } : {})}
            {...(sidebarSaved ? { saved: sidebarSaved } : {})}
            {...(sidebarHosts ? { hosts: sidebarHosts } : {})}
            plugins={sidebarPlugins}
            width={uiSnapshot.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH}
            onResize={(width) =>
              uiStateStore.update((current) => setSidebarWidth(current, width))}
            {...(sidebarConversations
              ? { onExpandConversations: () => setConversationsFull(true) }
              : {})}
            sleeping={sleeping}
            footerTray={
              <Tray
                trayId="sidebar-footer"
                context={trayContext}
                uiState={uiSnapshot}
                onConfigure={configureTray}
              />
            }
          />
        ) : null}
        <div
          className="viewer-area"
          style={{ flexDirection: viewerLayoutDirection(viewerGeometry) }}
        >
          <main className="app-main">
            {allTabs.length === 0 ? (
              <WorkspacePanel testId="workspace-empty" title="No terminal tabs">
                Create a terminal from the sidebar to begin.
              </WorkspacePanel>
            ) : (
              allTabs.map((tab) => (
                <div
                  key={tab.id}
                  style={
                    tab.id === activeTabId
                      ? { display: "contents" }
                      : { display: "none" }
                  }
                >
                  <SplitLayout
                    tabId={tab.id}
                    root={tab.split}
                    client={controller.attachments}
                    paneStates={snapshot.paneStates}
                    focusedSessionId={resolveFocusedSession(
                      tab.split,
                      focusByTab[tab.id],
                    )}
                    dismissingSessionIds={dismissing}
                    restartingSessionIds={restarting}
                    onSessionCwd={controller.reportSessionCwd}
                    onConversationCaptured={controller.reportCapturedConversation}
                    onSessionOutput={handleSessionOutput}
                    onSessionBell={controller.noteBell}
                    onFocusPane={(sessionId) =>
                      setFocusByTab((prev) =>
                        prev[tab.id] === sessionId
                          ? prev
                          : { ...prev, [tab.id]: sessionId }
                      )}
                    actions={actionsFor(tab.id)}
                    visible={tab.id === activeTabId}
                    sleep={sleepController}
                    sessionDims={controller.sessionDims(sessionIdsInSplit(tab.split))}
                    paneTitles={controller.paneTitles(tab.id)}
                    paneActivity={controller.paneActivity?.(tab.id)}
                    onVisiblePanesChange={(ids) => {
                      if (ids.length) visiblePanesByTab.current.set(tab.id, ids);
                      else visiblePanesByTab.current.delete(tab.id);
                      if (windowFocused && tab.id === activeTabId) {
                        controller.markTabSeen?.(tab.id, ids);
                      }
                    }}
                    // Double-click a pane's title bar to name that terminal.
                    // The name lands in the controller, which is where every
                    // reader of it - header, rail row, hover preview - looks.
                    onRenamePane={controller.renamePane}
                    pluginManifestFor={pluginManifestFor}
                    fontSize={settings.terminalFontSize}
                    onFontSizeWheel={adjustTerminalFontSize}
                    {...(openHistory ? { onLoadEarlier: openHistory } : {})}
                  />
                </div>
              ))
            )}
          </main>
          <ViewerHost
            ref={viewerRef}
            readFile={tauriReadTextFile}
            geometry={viewerGeometry}
            onGeometry={onViewerGeometry}
          />
        </div>
        {outputsOpen ? (
          <div className="app-outputs-dock">
            <OutputPane
              sessionId={focusedSessionId}
              sessionKey={null}
              live={liveOutputs}
              onOpenFile={(path) => viewerRef.current?.openFile(path)}
              onClose={() => setOutputsOpen(false)}
            />
          </div>
        ) : null}
        {settingsOpen ? (
          <SettingsSurface
            store={settingsStore}
            pickFolder={pickNativeFolder}
            onClose={() => setSettingsOpen(false)}
            {...(settingsSection ? { section: settingsSection } : {})}
            {...(settingsPlugins ? { plugins: settingsPlugins } : {})}
          />
        ) : null}
        <FeaturesDock
          open={featuresOpen}
          onClose={() => setFeaturesOpen(false)}
          uiState={uiSnapshot}
          onConfigure={configureTray}
        />
        {conversationsStore ? (
          <SessionPalette
            store={conversationsStore}
            open={paletteOpen}
            onClose={() => setPaletteOpen(false)}
            onResume={(record) => {
              setPaletteOpen(false);
              handleResume(record);
            }}
          />
        ) : null}
        {conversationsFull && sidebarConversations ? (
          <ConversationsFullscreen onClose={() => setConversationsFull(false)}>
            <ConversationsRail
              variant="expanded"
              store={sidebarConversations.store}
              settings={sidebarConversations.settings}
              onResume={sidebarConversations.onResume}
              onOpenTranscript={sidebarConversations.onOpenTranscript}
              {...(sidebarConversations.listArtifacts
                ? { listArtifacts: sidebarConversations.listArtifacts }
                : {})}
              {...(sidebarConversations.onOpenFile
                ? { onOpenFile: sidebarConversations.onOpenFile }
                : {})}
              {...(sidebarConversations.onOpenFolder
                ? { onOpenFolder: sidebarConversations.onOpenFolder }
                : {})}
              {...(sidebarConversations.onVisibleRecords
                ? { onVisibleRecords: sidebarConversations.onVisibleRecords }
                : {})}
              {...(sidebarConversations.listOutputs
                ? { listOutputs: sidebarConversations.listOutputs }
                : {})}
              {...(sidebarConversations.dismissOutput
                ? { dismissOutput: sidebarConversations.dismissOutput }
                : {})}
              {...(sidebarConversations.onSaveConversation
                ? {
                    onSaveConversation:
                      sidebarConversations.onSaveConversation,
                  }
                : {})}
            />
          </ConversationsFullscreen>
        ) : null}
        <AlreadyOpenDialog
          open={alreadyOpen !== null}
          onSwitch={() => {
            if (alreadyOpen) {
              controller.activateTab(alreadyOpen.tabId);
              setAlreadyOpen(null);
              setConversationsFull(false);
            }
          }}
          onOpenAnyway={() => {
            if (alreadyOpen) {
              const record = alreadyOpen.record;
              setAlreadyOpen(null);
              void controller.resumeSession(record, { force: true }).then((outcome) => {
                if (outcome.kind === "opened") {
                  setConversationsFull(false);
                }
              });
            }
          }}
          onCancel={() => setAlreadyOpen(null)}
        />
        <CloseGuard open={closeGuardOpen} onDecide={handleCloseDecision} />
        <ForcedUpdateModal
          update={updates.update}
          sessionTitles={[...snapshot.ungroupedTabs, ...snapshot.groups.flatMap((group) => group.tabs ?? [])]
            .filter((tab) => tab.status === "live").map((tab) => tab.title)}
          onInstall={installUpdate}
          onNotes={() => void updates.open()}
        />
        <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} uiVersion={updates.version} hostVersion={snapshot.hostVersion ?? null} />
        <Welcome
          open={welcomeOpen}
          pickFolder={pickNativeFolder}
          onStart={(root) => {
            settingsStore.update({ workspaceRoot: root });
            setWelcomeOpen(false);
            void controller.createTab({ groupId: null, profile: null });
          }}
          onSkip={() => {
            // Skip must still write the settings file, or the screen would
            // return on every launch; `update` ignores no-op patches.
            settingsStore.touch();
            setWelcomeOpen(false);
          }}
        />
        {savePrompt ? (
          <SaveSessionDialog
            open
            prefill={savePrompt.prefill}
            onSave={commitSave}
            onCancel={() => setSavePrompt(null)}
          />
        ) : null}
        {sshCredentials && passwordAlias !== null ? (
          <SetPasswordDialog
            open
            alias={passwordAlias}
            hasExisting={withPassword.has(passwordAlias)}
            onSave={(password) => {
              // Rejects if encryption is on and DPAPI fails; leave the dialog
              // open in that case so the secret is not silently lost, and never
              // let the rejection go unhandled.
              void sshCredentials
                .setPassword(passwordAlias, password, settings.sshEncryptPasswords)
                .then(() => setPasswordAlias(null))
                .catch((error: unknown) => {
                  console.error("failed to store ssh password", error);
                });
            }}
            onRemove={() => {
              void sshCredentials.removePassword(passwordAlias).catch(
                (error: unknown) => {
                  console.error("failed to remove ssh password", error);
                },
              );
              setPasswordAlias(null);
            }}
            onCancel={() => setPasswordAlias(null)}
          />
        ) : null}
        {folderSearch ? (
          <FolderSearch
            recents={workspace.uiState?.getSnapshot().recentFolders ?? []}
            listDirs={tauriListDirs}
            onPick={(path) => {
              setFolderSearch(null);
              void controller.createTabWithCwd({
                groupId: folderSearch.groupId,
                profile: folderSearch.profile,
                cwd: path,
              });
            }}
            onBrowse={() => {
              setFolderSearch(null);
              void controller.createTabViaNativeDialog(folderSearch);
            }}
            onClose={() => setFolderSearch(null)}
          />
        ) : null}
      </div>
      {settings.statusBar ? (
        <StatusBar
          model={paneStatus.model}
          appVersion={updates.version}
          update={updates.update}
          onCheckUpdates={() => void updates.check()}
          onOpenUpdate={installUpdate}
          changingDirectory={changingDirectory}
          directoryDisabledReason={directoryDisabledReason}
          onChangeDirectory={() => {
            if (focusedSessionId===null || changingDirectory) return;
            setChangingDirectory(true);
            const target=focusedSessionId;
            void controller.changeDirectory?.(target).then(accepted=>{
              if(accepted && statusFocusedId.current===target) focusPaneContents(target);
            }).finally(()=>setChangingDirectory(false));
          }}
          cwd={
            focusedSessionId !== null
              ? controller.sessionCwd?.(focusedSessionId) ?? null
              : null
          }
          profile={
            focusedSessionId !== null
              ? controller.sessionProfile?.(focusedSessionId) ?? null
              : null
          }
          sshHost={
            focusedSessionId !== null
              ? controller.sshPaneInfo?.(focusedSessionId)?.host ?? null
              : null
          }
          // The path is the shortest route to the folder itself. A remote pane's
          // cwd lives on the far side of an ssh hop, so there is nothing here to
          // open — the bar keeps it as plain text in that case.
          onOpenCwd={
            focusedSessionId !== null &&
            !controller.sshPaneInfo?.(focusedSessionId)
              ? (folder) => void tauriOpenFolder(folder)
              : undefined
          }
        />
      ) : null}
    </>
  );
}

/**
 * Put real DOM focus inside a pane, the way clicking into it does.
 *
 * A click works because the browser focuses whatever the pointer landed on and
 * `.split-pane`'s capture handler reports it back; there is no imperative
 * "focus pane N" to call, and the section itself takes no caret. So the target
 * is the element a click would have landed on: the plugin's frame, or the
 * terminal's own textarea (xterm's helper, what `terminal.focus()` focuses).
 * A pane with neither - an offline plugin card - has nothing that should hold
 * the caret, and only the ring moves.
 */
function focusPaneContents(sessionId: number): void {
  const pane = document.querySelector<HTMLElement>(
    `.split-pane[data-session-id="${sessionId}"]`,
  );
  pane?.querySelector<HTMLElement>("iframe, textarea")?.focus();
}

function resolveFocusedSession(root: SplitNode, preferred: number | undefined): number {
  if (preferred !== undefined && sessionIdsInSplit(root).includes(preferred)) {
    return preferred;
  }
  return firstSessionId(root);
}

function WorkspacePanel({
  testId,
  title,
  children,
}: {
  testId: string;
  title: string;
  children: string;
}) {
  return (
    <section className="workspace-panel" data-testid={testId}>
      <div className="workspace-panel__content">
        <div className="workspace-panel__mark" aria-hidden="true">›_</div>
        <h1>{title}</h1>
        <p>{children}</p>
      </div>
    </section>
  );
}

function disposeWorkspace(workspace: BootstrappedWorkspace): void {
  try {
    workspace.controller.dispose();
  } catch {
    // Keep releasing the host client after a partial renderer cleanup failure.
  }
  try {
    workspace.client.close();
  } catch {
    // Teardown is best-effort; never surface internal host details from cleanup.
  }
}
