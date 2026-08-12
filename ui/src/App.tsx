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
import {
  DEFAULT_CHAT_SHOW_THINKING,
  defaultChatDensity,
  defaultChatViewMode,
} from "./chat/chatDefaults";
import { resolveLinkage } from "./chat/linkage";
import type { ChatViewMode } from "./chat/types";
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
import { tauriListDirs } from "./native/folders";
import {
  tauriDismissOutput,
  tauriGenerateBundle,
  tauriListArtifacts,
  tauriListOutputs,
  tauriReadTextFile,
} from "./native/sessionData";
import { OutputPane, type LiveOutputRow } from "./outputs/OutputPane";
import { OutputsStore } from "./outputs/outputsStore";
import { SettingsSurface } from "./settings/SettingsSurface";
import { SettingsStore } from "./settings/SettingsStore";
import { useSettings } from "./settings/useSettings";
import { ThemeProvider } from "./theme/ThemeProvider";
import { Sidebar, type SidebarConversations } from "./sidebar/Sidebar";
import { SplitLayout, type SplitLayoutActions } from "./split/SplitLayout";
import {
  findContainer,
  sessionIdsInSplit,
  type SplitNode,
  type Tab,
} from "./state/layout";
import { SleepController } from "./terminal/sleep";
import {
  DEFAULT_VIEWER_GEOMETRY,
  viewerLayoutDirection,
  type ViewerGeometry,
} from "./viewer/viewerState";
import { ViewerHost, type ViewerApi } from "./viewer/ViewerHost";
import {
  bootstrapWorkspace,
  type BootstrappedWorkspace,
} from "./workspace/bootstrapWorkspace";
import type { FolderSearchTarget } from "./workspace/WorkspaceController";
import { firstSessionId } from "./workspace/layoutOperations";
import type { ConnectionState } from "./host/reconnect";
import {
  DEFAULT_SIDEBAR_WIDTH,
  UiStateStore,
  applyTrayConfigure,
  setChatPaneState,
  setSidebarWidth,
  setViewerGeometry,
} from "./workspace/uiState";
import { useWorkspace } from "./workspace/useWorkspace";

type AppState =
  | { type: "loading" }
  | { type: "ready"; workspace: BootstrappedWorkspace }
  | { type: "error"; message: string };

export interface AppProps {
  bootstrap?: () => Promise<BootstrappedWorkspace>;
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

/** How often the workspace rescans agent sessions for pane↔chat linkage. */
const CONVERSATIONS_RESCAN_MS = 30_000;
const NO_RECORDS: readonly LlmSessionRecord[] = [];
const emptyRecords = () => NO_RECORDS;
const noopSubscribe = () => () => {};

export default function App({ bootstrap = bootstrapWorkspace }: AppProps) {
  const [state, setState] = useState<AppState>({ type: "loading" });

  useEffect(() => {
    let canceled = false;
    let ownedWorkspace: BootstrappedWorkspace | null = null;
    setState({ type: "loading" });

    void bootstrap().then(
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
  }, [bootstrap]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-brand">TermX</div>
        <div className="app-subtitle">Terminal workspace</div>
      </header>
      {state.type === "loading" ? (
        <WorkspacePanel testId="workspace-loading" title="Starting TermX…">
          Connecting to the terminal host.
        </WorkspacePanel>
      ) : state.type === "error" ? (
        <WorkspacePanel testId="workspace-error" title="Workspace unavailable">
          {state.message}
        </WorkspacePanel>
      ) : (
        <ReadyWorkspace workspace={state.workspace} />
      )}
    </div>
  );
}

type WorkspaceConnection = NonNullable<BootstrappedWorkspace["connection"]>;

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
  const [featuresOpen, setFeaturesOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [closeGuardOpen, setCloseGuardOpen] = useState(false);
  const [folderSearch, setFolderSearch] = useState<FolderSearchTarget | null>(null);
  const [conversationsFull, setConversationsFull] = useState(false);
  const [outputsOpen, setOutputsOpen] = useState(false);
  const [alreadyOpen, setAlreadyOpen] = useState<{
    record: LlmSessionRecord;
    tabId: string;
  } | null>(null);
  // Focused pane per tab is ephemeral UI state (layout spec: never persisted).
  const [focusByTab, setFocusByTab] = useState<Record<string, number>>({});
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

  // Chat linkage needs a live session list. The rail refreshes when opened,
  // but a pane running a freshly started agent session must gain its chat
  // switch without the rail ever opening — so scan on mount and keep the list
  // current while the workspace lives. Unforced scans are cheap: the Rust
  // side skips unchanged transcripts via its mtime index.
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

  // Resume with dedupe (polish P6): "already-open" raises the dialog; a
  // resume that actually opened a tab drops the full-screen overlay so the
  // new terminal is visible.
  const handleResume = (record: LlmSessionRecord) => {
    void controller.resumeSession(record).then((outcome) => {
      if (outcome.kind === "already-open") {
        setAlreadyOpen({ record, tabId: outcome.tabId });
      } else if (outcome.kind === "opened") {
        setConversationsFull(false);
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

  // Window close (spec §15): silent/keep-running lets the window close (the
  // daemon keeps sessions), stop-all shuts the host down first, ask shows the
  // CloseGuard. Outside Tauri (tests, plain browser) this wires nothing.
  const anyAlive = useMemo(
    () => Object.values(snapshot.paneStates).some((pane) => pane.status === "live"),
    [snapshot.paneStates],
  );
  const anyAliveRef = useRef(anyAlive);
  anyAliveRef.current = anyAlive;
  const bypassCloseGuardRef = useRef(false);
  const closeWindow = async (stopAll: boolean): Promise<void> => {
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
          if (decision === "silent" || decision === "keep-running") {
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
  }, [settingsStore]);
  const handleCloseDecision = (decision: CloseDecision, remember: boolean) => {
    setCloseGuardOpen(false);
    if (remember) {
      settingsStore.update({ onWindowClose: decision });
    }
    void closeWindow(decision === "stop-all");
  };

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
          popOutPane(sessionId) {
            controller.popOutPane(tabId, sessionId);
          },
        };
        cache.set(tabId, cached);
      }
      return cached;
    };
  }, [controller]);

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
    };
    // handleResume is recreated per render but closes only over stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationsStore, settings, controller, activeGroupId, noteScheduler]);

  // Chat view (chat-view spec §1/§2). A pane is offered the switch only when
  // it can be tied to a transcript: the session key a resume recorded, else
  // the pane's own directory, else nothing at all.
  const chatForSession = (sessionId: number, tabId: string) => {
    const records = conversationsRecords;
    if (records.length === 0) {
      return null;
    }
    const link = resolveLinkage({
      explicitKey: controller.resumedSessionKeyForTab(tabId),
      paneCwd: controller.sessionCwd(sessionId),
      candidates: records,
    });
    if (!link) {
      return null;
    }
    const key = String(sessionId);
    // The stored pane state wins; otherwise the user's settings decide.
    const stored = uiSnapshot.chatPanes?.[key];
    const mode = stored?.mode ?? defaultChatViewMode(settings);
    const density = stored?.density ?? defaultChatDensity(settings);
    const showThinking = stored?.showThinking ?? DEFAULT_CHAT_SHOW_THINKING;
    const write = (next: {
      mode: ChatViewMode;
      density: typeof density;
      showThinking: boolean;
    }) => uiStateStore.update((current) => setChatPaneState(current, key, next));
    return {
      filePath: link.record.filePath,
      title: link.record.title,
      mode,
      density,
      showThinking,
      onModeChange: (nextMode: ChatViewMode) =>
        write({ mode: nextMode, density, showThinking }),
      onDensityChange: (nextDensity: typeof density) =>
        write({ mode, density: nextDensity, showThinking }),
      onShowThinkingChange: (nextShowThinking: boolean) =>
        write({ mode, density, showThinking: nextShowThinking }),
    };
  };

  // Ctrl+Shift+C flips the focused pane between the terminal and the chat.
  // Verified free in this keymap (Ctrl+Shift+O and Ctrl+Shift+R are the only
  // app chords) before it was claimed.
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) {
        return;
      }
      if (event.key.toLowerCase() !== "c") {
        return;
      }
      if (isEditableElement(document.activeElement)) {
        return;
      }
      const sessionId = focusedSessionId;
      const tabId = activeTabId;
      if (sessionId === null || tabId === null) {
        return;
      }
      const chat = chatForSession(sessionId, tabId);
      if (!chat) {
        return; // an unlinked pane has no chat to flip to
      }
      event.preventDefault();
      event.stopPropagation();
      chat.onModeChange(chat.mode === "chat" ? "terminal" : "chat");
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
    // chatForSession closes over the current stores and ui snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedSessionId, activeTabId, uiSnapshot, conversationsRecords, controller]);

  return (
    <>
      <ConnectionBanner
        state={connectionState}
        onRetry={() => connection?.retryNow()}
      />
      <ThemeProvider themeId={settings.theme} />
      <div className="app-workspace">
        <Sidebar
          snapshot={snapshot}
          actions={controller}
          hostConnected={connectionState.phase === "connected"}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenFolderSearch={(groupId) =>
            setFolderSearch({ groupId, profile: null })}
          maxGroupDepth={settings.maxGroupDepth}
          {...(sidebarConversations ? { conversations: sidebarConversations } : {})}
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
                    onSessionOutput={handleSessionOutput}
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
                    {...(openHistory ? { onLoadEarlier: openHistory } : {})}
                    chatForSession={(sessionId) =>
                      chatForSession(sessionId, tab.id)}
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
            onClose={() => setSettingsOpen(false)}
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
    </>
  );
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
