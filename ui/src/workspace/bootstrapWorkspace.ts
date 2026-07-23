import { invoke } from "@tauri-apps/api/core";
import { HostClient, type HostClientConnectOptions } from "../host/client";
import type { SessionInfo } from "../host/protocol";
import type { FolderPicker } from "../native/dialog";
import { parseLayout } from "../state/layout";
import { reconcile } from "../state/reconcile";
import { createLayoutStore } from "../state/store";
import { AttachmentHub } from "./AttachmentHub";
import { firstSessionId } from "./layoutOperations";
import { LayoutPersistence } from "./LayoutPersistence";
import { WorkspaceController } from "./WorkspaceController";

export type BootstrapWorkspaceClient = Pick<
  HostClient,
  | "attach"
  | "close"
  | "closeSession"
  | "createSession"
  | "getState"
  | "onError"
  | "onSessionClosed"
  | "onSessionExited"
  | "setLayout"
>;

export interface BootstrapWorkspaceOptions {
  invokeBootstrap?: () => Promise<unknown>;
  connect?: (options: HostClientConnectOptions) => Promise<BootstrapWorkspaceClient>;
  generateId?: () => string;
  pickFolder?: FolderPicker;
}

export interface BootstrappedWorkspace {
  client: BootstrapWorkspaceClient;
  controller: WorkspaceController;
}

export function parseBootstrapHostResult(value: unknown): HostClientConnectOptions {
  if (
    typeof value !== "object" ||
    value === null ||
    !("port" in value) ||
    !("token" in value) ||
    !Number.isInteger(value.port) ||
    (value.port as number) < 1 ||
    (value.port as number) > 65_535 ||
    typeof value.token !== "string" ||
    value.token.length === 0
  ) {
    throw new Error("Native host bootstrap returned an invalid result");
  }
  return { port: value.port as number, token: value.token };
}

export async function bootstrapWorkspace(
  options: BootstrapWorkspaceOptions = {},
): Promise<BootstrappedWorkspace> {
  const invokeBootstrap = options.invokeBootstrap ?? (() => invoke<unknown>("bootstrap_host"));
  const connect = options.connect ?? ((connectOptions) => HostClient.connect(connectOptions));
  let client: BootstrapWorkspaceClient | null = null;
  let controller: WorkspaceController | null = null;

  try {
    const bootstrap = parseBootstrapHostResult(await invokeBootstrap());
    client = await connect(bootstrap);
    const state = await client.getState();
    const restored = parseLayout(state.layout);
    const reconciled = reconcile(
      restored,
      state.sessions,
      options.generateId ? { generateId: options.generateId } : undefined,
    );
    const store = createLayoutStore(reconciled.layout);
    const persistence = new LayoutPersistence(client);
    const attachments = new AttachmentHub(client);
    const controllerOptions = {
      client,
      store,
      persistence,
      attachments,
      sessions: state.sessions as readonly SessionInfo[],
      ...(options.generateId ? { generateId: options.generateId } : {}),
      ...(options.pickFolder ? { pickFolder: options.pickFolder } : {}),
    };
    controller = new WorkspaceController(controllerOptions);

    const activeTab = reconciled.layout.activeTabId
      ? reconciled.layout.tabs[reconciled.layout.activeTabId]
      : undefined;
    const activeSessionId = activeTab ? firstSessionId(activeTab.split) : null;
    const liveSessionIds = state.sessions
      .filter((session) => session.alive)
      .map((session) => session.id);
    await attachments.attachAll(liveSessionIds, activeSessionId);
    for (const session of state.sessions) {
      if (!session.alive) {
        attachments.markExited(session.id, null);
      }
    }

    if (restored !== null && reconciled.orphanAdoptedIds.length > 0) {
      persistence.record(reconciled.layout, "structural");
      await persistence.flush();
    }

    return { client, controller };
  } catch {
    try {
      controller?.dispose();
    } catch {
      // Continue releasing the connected host client after partial setup.
    }
    try {
      client?.close();
    } catch {
      // Bootstrap failure remains a bounded renderer error.
    }
    throw new Error("Unable to start the TermX workspace.");
  }
}
