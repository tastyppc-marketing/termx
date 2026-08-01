import { invoke } from "@tauri-apps/api/core";
import {
  ConversationsStore,
  loadConversationsStore,
} from "../conversations/store";
import { conversationsFileIo, tauriSessionLister } from "../conversations/storage";
import type { SessionLister } from "../conversations/types";
import { HostClient, type HostClientConnectOptions } from "../host/client";
import type { SessionInfo } from "../host/protocol";
import { tauriAppFiles, type AppFileStore } from "../native/appFiles";
import type { FolderPicker } from "../native/dialog";
import { SettingsStore, loadSettingsStore } from "../settings/SettingsStore";
import { UiStateStore, loadUiStateStore } from "./uiState";
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
  appFiles?: AppFileStore;
  /** Injected `list_llm_sessions`; tests fake the scan. */
  listSessions?: SessionLister;
}

export interface BootstrappedWorkspace {
  client: BootstrapWorkspaceClient;
  controller: WorkspaceController;
  /** Absent only in legacy test fixtures; App falls back to an in-memory store. */
  settings?: SettingsStore;
  /** Scope paths + recent folders; absent only in legacy test fixtures. */
  uiState?: UiStateStore;
  /**
   * Folders/assignments/notes for the Conversations rail (spec §3). Loading is
   * file-only — no session scan happens until the rail asks for one.
   */
  conversations?: ConversationsStore;
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
    // Settings load never blocks or fails the workspace: read errors yield
    // defaults, save errors stay contained in the store.
    const appFiles = options.appFiles ?? tauriAppFiles;
    const settings = await loadSettingsStore({
      read: () => appFiles.read("settings_v1.json"),
      save: (text) => appFiles.write("settings_v1.json", text),
    });
    const uiState = await loadUiStateStore({
      read: () => appFiles.read("ui_state_v1.json"),
      save: (text) => appFiles.write("ui_state_v1.json", text),
    });
    // Same optional-field contract as settings/ui-state: a read failure yields
    // empty state and never blocks the workspace.
    const conversationsIo = conversationsFileIo(appFiles);
    const conversations = await loadConversationsStore({
      read: () => conversationsIo.read(),
      save: (text) => conversationsIo.write(text),
      list: options.listSessions ?? tauriSessionLister,
    });

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
      settings,
      uiState,
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

    return { client, controller, settings, uiState, conversations };
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
