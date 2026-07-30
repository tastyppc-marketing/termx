import { useEffect, useMemo, useState } from "react";
import { SettingsDialog } from "./settings/SettingsDialog";
import { SettingsStore } from "./settings/SettingsStore";
import { useSettings } from "./settings/useSettings";
import { Sidebar } from "./sidebar/Sidebar";
import { SplitLayout, type SplitLayoutActions } from "./split/SplitLayout";
import { sessionIdsInSplit, type SplitNode } from "./state/layout";
import {
  bootstrapWorkspace,
  type BootstrappedWorkspace,
} from "./workspace/bootstrapWorkspace";
import { firstSessionId } from "./workspace/layoutOperations";
import { useWorkspace } from "./workspace/useWorkspace";

type AppState =
  | { type: "loading" }
  | { type: "ready"; workspace: BootstrappedWorkspace }
  | { type: "error"; message: string };

export interface AppProps {
  bootstrap?: () => Promise<BootstrappedWorkspace>;
}

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Focused pane per tab is ephemeral UI state (layout spec: never persisted).
  const [focusByTab, setFocusByTab] = useState<Record<string, number>>({});
  const [dismissing, setDismissing] = useState<ReadonlySet<number>>(new Set());

  const activeTabId = snapshot.activeTabId;
  const activeTab = activeTabId ? snapshot.layout.tabs[activeTabId] : undefined;

  const actions = useMemo<SplitLayoutActions | null>(() => {
    if (!activeTabId) {
      return null;
    }
    return {
      splitPane(sessionId, dir) {
        void controller.splitPane(activeTabId, sessionId, dir).then((created) => {
          if (created !== null) {
            setFocusByTab((prev) => ({ ...prev, [activeTabId]: created }));
          }
        });
      },
      closePane(sessionId) {
        return controller.closePane(activeTabId, sessionId);
      },
      async dismissPane(sessionId) {
        setDismissing((prev) => new Set(prev).add(sessionId));
        try {
          await controller.closePane(activeTabId, sessionId);
        } finally {
          setDismissing((prev) => {
            const next = new Set(prev);
            next.delete(sessionId);
            return next;
          });
        }
      },
      resizePane(path, sizes) {
        controller.resizePane(activeTabId, path, sizes);
      },
    };
  }, [controller, activeTabId]);

  return (
    <div className="app-workspace">
      <Sidebar
        snapshot={snapshot}
        actions={controller}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="app-main">
        {!activeTab || !actions ? (
          <WorkspacePanel testId="workspace-empty" title="No terminal tabs">
            Create a terminal from the sidebar to begin.
          </WorkspacePanel>
        ) : (
          <SplitLayout
            key={activeTab.id}
            tabId={activeTab.id}
            root={activeTab.split}
            client={controller.attachments}
            paneStates={snapshot.paneStates}
            focusedSessionId={resolveFocusedSession(
              activeTab.split,
              focusByTab[activeTab.id],
            )}
            dismissingSessionIds={dismissing}
            onFocusPane={(sessionId) =>
              setFocusByTab((prev) =>
                prev[activeTab.id] === sessionId
                  ? prev
                  : { ...prev, [activeTab.id]: sessionId }
              )}
            actions={actions}
          />
        )}
      </main>
      {settingsOpen ? (
        <SettingsDialog
          settings={settings}
          onChange={settingsStore.update}
          onClose={() => setSettingsOpen(false)}
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
