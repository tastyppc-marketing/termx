import { useEffect, useState } from "react";
import { Sidebar } from "./sidebar/Sidebar";
import { TerminalPane } from "./terminal/TerminalPane";
import {
  bootstrapWorkspace,
  type BootstrappedWorkspace,
} from "./workspace/bootstrapWorkspace";
import { useWorkspace } from "./workspace/useWorkspace";
import type {
  SidebarTabModel,
  WorkspaceSnapshot,
} from "./workspace/WorkspaceController";

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
  const snapshot = useWorkspace(workspace.controller);
  const activeTab = findActiveTab(snapshot);
  const ended = activeTab?.status === "dead" || activeTab?.status === "missing";

  return (
    <div className="app-workspace">
      <Sidebar snapshot={snapshot} actions={workspace.controller} />
      <main className="app-main">
        {snapshot.activeSessionId === null || !activeTab ? (
          <WorkspacePanel testId="workspace-empty" title="No terminal tabs">
            Create a terminal from the sidebar to begin.
          </WorkspacePanel>
        ) : ended ? (
          <WorkspacePanel testId="workspace-ended" title="Terminal exited">
            This terminal session has ended. Dismiss it from the sidebar when you no longer need it.
          </WorkspacePanel>
        ) : (
          <TerminalPane
            key={snapshot.activeSessionId}
            client={workspace.controller.attachments}
            sessionId={snapshot.activeSessionId}
          />
        )}
      </main>
    </div>
  );
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

function findActiveTab(snapshot: WorkspaceSnapshot): SidebarTabModel | null {
  if (!snapshot.activeTabId) {
    return null;
  }
  return [
    ...snapshot.ungroupedTabs,
    ...snapshot.groups.flatMap((group) => group.tabs),
  ].find((tab) => tab.id === snapshot.activeTabId) ?? null;
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
