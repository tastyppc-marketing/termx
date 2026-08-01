import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  registerAction,
  type ActionContext,
  type TrayId,
} from "./actions/registry";
import { FeaturesDock } from "./actions/FeaturesDock";
import { Tray } from "./actions/Tray";
import { CloseGuard } from "./close/CloseGuard";
import { decideOnClose, type CloseDecision } from "./close/closeBehavior";
import { NoteScheduler } from "./conversations/noteScheduler";
import { SessionPalette } from "./conversations/palette/SessionPalette";
import { FolderSearch } from "./folders/FolderSearch";
import { isEditableElement } from "./keyboard";
import { tauriListDirs } from "./native/folders";
import {
  tauriGenerateNote,
  tauriListArtifacts,
  tauriReadTextFile,
} from "./native/sessionData";
import { SettingsDialog } from "./settings/SettingsDialog";
import { SettingsStore } from "./settings/SettingsStore";
import { useSettings } from "./settings/useSettings";
import { Sidebar, type SidebarConversations } from "./sidebar/Sidebar";
import { SplitLayout, type SplitLayoutActions } from "./split/SplitLayout";
import { sessionIdsInSplit, type SplitNode, type Tab } from "./state/layout";
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
import {
  UiStateStore,
  applyTrayConfigure,
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

function ReadyWorkspace({ workspace }: { workspace: BootstrappedWorkspace }) {
  const controller = workspace.controller;
  const snapshot = useWorkspace(controller);
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
  // Focused pane per tab is ephemeral UI state (layout spec: never persisted).
  const [focusByTab, setFocusByTab] = useState<Record<string, number>>({});
  const [dismissing, setDismissing] = useState<ReadonlySet<number>>(new Set());
  const viewerRef = useRef<ViewerApi | null>(null);

  const activeTabId = snapshot.activeTabId;
  const activeGroupId = useMemo(
    () =>
      activeTabId
        ? snapshot.layout.groups.find((group) => group.tabIds.includes(activeTabId))
            ?.id ?? null
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
      generate: tauriGenerateNote,
      store: {
        getSnapshot: conversationsStore.getSnapshot,
        writeGeneratedNote: conversationsStore.setGeneratedNote,
      },
      settings: settingsStore,
      now: () => Date.now(),
    });
  }, [conversationsStore, settingsStore]);
  useEffect(() => () => noteScheduler?.dispose(), [noteScheduler]);

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

  const trayContext = useMemo<ActionContext>(
    () => ({
      newTab: () => void controller.createTab({ groupId: null, profile: null }),
      openFolderSearch: () => setFolderSearch({ groupId: activeGroupId, profile: null }),
      openSettings: () => setSettingsOpen(true),
      openFeatures: () => setFeaturesOpen(true),
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
      onResume: (record) => void controller.resumeSession(record),
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
    };
  }, [conversationsStore, settings, controller, activeGroupId, noteScheduler]);

  return (
    <div className="app-workspace">
      <Sidebar
        snapshot={snapshot}
        actions={controller}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenFolderSearch={(groupId) =>
          setFolderSearch({ groupId, profile: null })}
        {...(sidebarConversations ? { conversations: sidebarConversations } : {})}
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
                  onSessionCwd={controller.reportSessionCwd}
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
      {settingsOpen ? (
        <SettingsDialog
          settings={settings}
          onChange={settingsStore.update}
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
            void controller.resumeSession(record);
          }}
        />
      ) : null}
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
