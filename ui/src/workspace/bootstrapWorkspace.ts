import { invoke } from "@tauri-apps/api/core";
import {
  ConversationsStore,
  loadConversationsStore,
} from "../conversations/store";
import { sameFolder } from "./WorkspaceController";
import { conversationsFileIo, tauriSessionLister } from "../conversations/storage";
import type { SessionLister } from "../conversations/types";
import { HostClient, type HostClientConnectOptions } from "../host/client";
import { HostBootstrapError, ReconnectingHostClient } from "../host/reconnect";
import type { JsonValue, SessionInfo } from "../host/protocol";
import { tauriAppFiles, type AppFileStore } from "../native/appFiles";
import type { FolderPicker } from "../native/dialog";
import {
  PaneBindingsStore,
  parsePluginPanes,
  parsePluginPanesValue,
} from "../plugins/paneBindings";
import {
  tauriProtectSecret,
  tauriReadSshConfig,
  tauriUnprotectSecret,
} from "../native/sshNative";
import { parseSshConfig } from "../ssh/config";
import { createSshCredentialsStore, type SshCredentialsStore } from "../ssh/credentials";
import type { SshHost } from "../ssh/types";
import {
  createSavedSessionsStore,
  type SavedSessionsStoreHandle,
} from "../saved/store";
import { SettingsStore, loadSettingsStore } from "../settings/SettingsStore";
import { UiStateStore, loadUiStateStore } from "./uiState";
import { MAIN_WINDOW_ID, parseLayout, slotOf } from "../state/layout";
import { reconcile } from "../state/reconcile";
import { createLayoutStore } from "../state/store";
import { AttachmentHub } from "./AttachmentHub";
import { firstSessionId, flattenTabIds, sessionIdsInTab } from "./layoutOperations";
import { LayoutPersistence } from "./LayoutPersistence";
import type { WindowBus } from "./windowBus";
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
> &
  // Optional so existing fixtures keep type-checking: a client without
  // `shutdown` degrades stop-all to a plain window close, never a crash (spec
  // §15), and one without `readHistory` simply never offers earlier output.
  Partial<Pick<HostClient, "shutdown" | "readHistory">>;

export interface BootstrapWorkspaceOptions {
  invokeBootstrap?: () => Promise<unknown>;
  connect?: (options: HostClientConnectOptions) => Promise<BootstrapWorkspaceClient>;
  generateId?: () => string;
  pickFolder?: FolderPicker;
  appFiles?: AppFileStore;
  /** Injected `list_llm_sessions`; tests fake the scan. */
  listSessions?: SessionLister;
  /**
   * Which window slot this workspace instance renders (multi-window spec).
   * Default the main window. An aux window attaches only its own slot's
   * sessions; the main window attaches everything, so no session goes
   * untracked when an aux window fails to open.
   */
  windowId?: string;
  /**
   * Cross-window layout plumbing (single-writer rule). With a bus, the main
   * window persists to the daemon AND broadcasts every write, and adopts
   * mutations forwarded by aux windows; an aux window never writes the daemon
   * — its persistence path forwards over the bus instead, and it adopts every
   * broadcast. Without one (single-window fixtures), main writes directly and
   * an aux window's mutations go nowhere.
   */
  windowBus?: WindowBus;
}

/**
 * One long-lived client the workspace holds for its whole life, forwarding
 * every call to whichever socket is currently up.
 *
 * `HostClient` is one-shot, so after a reconnect the object the controller
 * captured at boot is a corpse. Rather than teaching every caller to re-fetch
 * the client, this facade forwards through the reconnect machine: while
 * disconnected each call rejects immediately with `HostDisconnectedError`
 * (fail fast, never queue), and listeners registered once keep firing across
 * however many sockets come and go.
 */
class ReconnectingWorkspaceClient implements BootstrapWorkspaceClient {
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly closedListeners = new Set<(event: { sessionId: number }) => void>();
  private readonly exitedListeners = new Set<
    (event: { sessionId: number; exitCode: number | null }) => void
  >();
  private stopBridges: Array<() => void> = [];

  constructor(
    private readonly connection: ReconnectingHostClient<BootstrapWorkspaceClient>,
  ) {
    connection.onConnected((client) => this.bridge(client));
    const current = connection.currentClient;
    if (current) {
      this.bridge(current);
    }
  }

  attach: BootstrapWorkspaceClient["attach"] = (sessionId, callbacks, replay, sinceOffset) =>
    this.connection.request((client) =>
      client.attach(sessionId, callbacks, replay, sinceOffset),
    );

  createSession: BootstrapWorkspaceClient["createSession"] = (options) =>
    this.connection.request((client) => client.createSession(options));

  closeSession: BootstrapWorkspaceClient["closeSession"] = (sessionId) =>
    this.connection.request((client) => client.closeSession(sessionId));

  getState: BootstrapWorkspaceClient["getState"] = () =>
    this.connection.request((client) => client.getState());

  setLayout: BootstrapWorkspaceClient["setLayout"] = (layout) =>
    this.connection.request((client) => client.setLayout(layout));

  readHistory: HostClient["readHistory"] = (sessionId, beforeOffset, maxBytes) =>
    this.connection.request((client) => {
      if (!client.readHistory) {
        throw new Error("This host connection cannot read scrollback history");
      }
      return client.readHistory(sessionId, beforeOffset, maxBytes);
    });

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onSessionClosed(listener: (event: { sessionId: number }) => void): () => void {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  onSessionExited(
    listener: (event: { sessionId: number; exitCode: number | null }) => void,
  ): () => void {
    this.exitedListeners.add(listener);
    return () => this.exitedListeners.delete(listener);
  }

  /** Quitting: stop reconnecting, then drop the socket. */
  close(): void {
    this.connection.dispose();
  }

  shutdown(): void {
    this.connection.currentClient?.shutdown?.();
  }

  private bridge(client: BootstrapWorkspaceClient): void {
    for (const stop of this.stopBridges.splice(0)) {
      try {
        stop();
      } catch {
        // The old client is already gone; its listeners went with it.
      }
    }
    this.stopBridges = [
      client.onError((error) => fanOut(this.errorListeners, error)),
      client.onSessionClosed((event) => fanOut(this.closedListeners, event)),
      client.onSessionExited((event) => fanOut(this.exitedListeners, event)),
    ];
  }
}

function fanOut<T>(listeners: Set<(value: T) => void>, value: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(value);
    } catch {
      // One bad subscriber must not silence the others.
    }
  }
}

export interface BootstrappedWorkspace {
  client: BootstrapWorkspaceClient;
  controller: WorkspaceController;
  /** The reconnect machine, for the connection banner and the power events. */
  connection?: ReconnectingHostClient<BootstrapWorkspaceClient>;
  /** Absent only in legacy test fixtures; App falls back to an in-memory store. */
  settings?: SettingsStore;
  /** Scope paths + recent folders; absent only in legacy test fixtures. */
  uiState?: UiStateStore;
  /**
   * Folders/assignments/notes for the Conversations rail (spec §3). Loading is
   * file-only — no session scan happens until the rail asks for one.
   */
  conversations?: ConversationsStore;
  /**
   * Pinned folder + conversation pairs (saved-sessions spec). Absent only in
   * legacy test fixtures; the sidebar then simply has no Saved section.
   */
  saved?: SavedSessionsStoreHandle;
  /**
   * SSH host inventory parsed from `~/.ssh/config` (ssh-sessions spec §1) and
   * the credentials store. Absent in legacy fixtures; the sidebar then has no
   * Hosts section.
   */
  sshHosts?: readonly SshHost[];
  sshCredentials?: SshCredentialsStore;
  /**
   * Plugin pane bindings (plugin spec §4). Always present: a window with no
   * plugins simply holds an empty map. Only the MAIN window's store persists —
   * an aux window's is a read-only replica fed by the bus.
   */
  pluginPanes: PaneBindingsStore;
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
  let connection: ReconnectingHostClient<BootstrapWorkspaceClient> | null = null;

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
    // Same discipline again: the store is usable from construction and gains
    // its persisted entries when the read lands, and a corrupt or missing file
    // reads as an empty list rather than failing the boot.
    const saved = createSavedSessionsStore(appFiles);
    await saved.ready();
    // SSH inventory + credentials (ssh-sessions spec). The config is read
    // once at boot (a rescan needs a restart — the file rarely changes); a
    // missing/unparseable file yields an empty inventory and never blocks.
    const sshHosts = parseSshConfig(await tauriReadSshConfig());
    const sshCredentials = createSshCredentialsStore(appFiles, {
      protect: tauriProtectSecret,
      unprotect: tauriUnprotectSecret,
    });
    await sshCredentials.ready();
    // Same optional-field contract as settings/ui-state: a read failure yields
    // empty state and never blocks the workspace.
    // Plugin pane bindings (spec §4). Read like every other user-data file:
    // a missing, corrupt, or unreadable file yields no bindings, which renders
    // any reserved-id pane as a dismissible dead pane rather than blocking the
    // boot.
    let pluginPanesText: string | null = null;
    try {
      pluginPanesText = await appFiles.read("plugin_panes_v1.json");
    } catch {
      pluginPanesText = null;
    }
    const conversationsIo = conversationsFileIo(appFiles);
    const conversations = await loadConversationsStore({
      read: () => conversationsIo.read(),
      save: (text) => conversationsIo.write(text),
      list: options.listSessions ?? tauriSessionLister,
    });

    const bootstrap = parseBootstrapHostResult(await invokeBootstrap());
    const established = await connect(bootstrap);

    // Every later attempt re-runs the WHOLE chain, not just the socket: a
    // daemon that restarted has a new port and a new token, and one that died
    // has to be spawned again. A failure in that part is what the user can act
    // on, so it is typed distinctly for the banner.
    connection = ReconnectingHostClient.start<BootstrapWorkspaceClient>({
      initialClient: established,
      connect: async () => {
        let target: HostClientConnectOptions;
        try {
          target = parseBootstrapHostResult(await invokeBootstrap());
        } catch (error) {
          throw new HostBootstrapError(
            error instanceof Error ? error.message : "Unable to start the TermX host",
          );
        }
        return connect(target);
      },
    });
    client = new ReconnectingWorkspaceClient(connection);
    const state = await client.getState();
    const restored = parseLayout(state.layout);
    const reconciled = reconcile(
      restored,
      state.sessions,
      options.generateId ? { generateId: options.generateId } : undefined,
    );
    const store = createLayoutStore(reconciled.layout);
    // Single-writer rule (multi-window spec): only the MAIN window's
    // persistence reaches the daemon. With a bus, every main write also
    // broadcasts the fresh blob to the other windows; an aux window's
    // persistence path forwards its proposed layout to main instead of
    // writing — reusing all of LayoutPersistence's debounce machinery.
    const bootWindowId = options.windowId ?? MAIN_WINDOW_ID;
    const bus = options.windowBus ?? null;
    const daemonWriter = client;
    const layoutWriter = bus === null
      ? daemonWriter
      : bootWindowId === MAIN_WINDOW_ID
        ? {
            setLayout: async (layout: Parameters<typeof daemonWriter.setLayout>[0]) => {
              await daemonWriter.setLayout(layout);
              await bus.broadcastLayout(layout);
            },
          }
        : {
            setLayout: async (layout: Parameters<typeof daemonWriter.setLayout>[0]) => {
              // Awaited so an aux window's flush() really covers delivery —
              // the close path destroys the webview right after it.
              await bus.forwardMutation({ kind: "setLayout", layout });
            },
          };
    const persistence = new LayoutPersistence(layoutWriter);
    if (bus !== null) {
      if (bootWindowId === MAIN_WINDOW_ID) {
        // A forwarded blob is untrusted input from another window: parse it
        // like any GetState blob and drop it on any violation — main keeps
        // its own model, which the next broadcast re-asserts.
        bus.onMutation((mutation) => {
          const proposed = parseLayout(mutation.layout);
          if (proposed === null) {
            return;
          }
          const adopted = store.replaceState(proposed);
          if (adopted === proposed) {
            persistence.record(adopted, "structural");
          }
        });
      } else {
        bus.onLayout((layout) => {
          const truth = parseLayout(layout);
          if (truth !== null) {
            store.replaceState(truth);
          }
        });
      }
    }
    // Same single-writer rule as the layout, applied to the bindings file: the
    // MAIN window persists every change and fans it out; an aux window is a
    // read-only replica that adopts broadcasts and never writes. Both windows
    // seed from the file, so an aux window has its bindings from the first
    // frame instead of waiting for main's next change.
    const pluginPanes = bootWindowId === MAIN_WINDOW_ID
      ? new PaneBindingsStore({
          initial: parsePluginPanes(pluginPanesText),
          save: (text) => appFiles.write("plugin_panes_v1.json", text),
          ...(bus !== null
            ? {
                // Structurally JSON already — the cast only tells TS that an
                // OPTIONAL `path` (i.e. `string | undefined`) never actually
                // holds `undefined`; the store builds bindings by spread.
                onBroadcast: (state) =>
                  void bus.broadcastPluginPanes(state as unknown as JsonValue),
              }
            : {}),
        })
      : new PaneBindingsStore({
          initial: parsePluginPanes(pluginPanesText),
          save: null,
        });
    if (bus !== null && bootWindowId !== MAIN_WINDOW_ID) {
      // A broadcast is untrusted input from another window: parse it like a
      // file read and adopt only what survives.
      bus.onPluginPanes((state) => pluginPanes.adopt(parsePluginPanesValue(state)));
    }
    const attachments = new AttachmentHub(client);
    const controllerOptions = {
      client,
      store,
      persistence,
      attachments,
      sessions: state.sessions as readonly SessionInfo[],
      settings,
      uiState,
      // Dead-pane resume: the newest resumable conversation recorded in a
      // directory. Read from the live snapshot at call time, so records that
      // finish scanning after bootstrap still count.
      conversations: {
        latestForCwd: (cwd: string) => {
          let best = null;
          for (const record of conversations.getSnapshot().records) {
            if (record.cwd === null || !sameFolder(record.cwd, cwd)) {
              continue;
            }
            if (best === null || record.updatedAtMs > best.updatedAtMs) {
              best = record;
            }
          }
          return best;
        },
      },
      savedSessions: saved,
      sshPasswords: { passwordFor: (alias: string) => sshCredentials.passwordFor(alias) },
      sshHosts: { byAlias: (alias: string) => sshHosts.find((host) => host.aliases.includes(alias)) ?? null },
      ...(options.generateId ? { generateId: options.generateId } : {}),
      ...(options.pickFolder ? { pickFolder: options.pickFolder } : {}),
      ...(options.windowId ? { windowId: options.windowId } : {}),
    };
    controller = new WorkspaceController(controllerOptions);

    const windowId = bootWindowId;
    const slot = slotOf(reconciled.layout, windowId);
    const activeTabId = slot?.activeTabId ?? null;
    const activeTab = activeTabId ? reconciled.layout.tabs[activeTabId] : undefined;
    const activeSessionId = activeTab ? firstSessionId(activeTab.split) : null;
    // The main window attaches every live session — including ones sitting in
    // aux slots — so nothing goes untracked when an aux window fails to open.
    // An aux window attaches only its own slot's sessions (multi-window spec).
    const windowSessionIds = windowId === MAIN_WINDOW_ID
      ? null
      : new Set(
          flattenTabIds(reconciled.layout, windowId).flatMap((tabId) => {
            const tab = reconciled.layout.tabs[tabId];
            return tab ? sessionIdsInTab(tab) : [];
          }),
        );
    const liveSessionIds = state.sessions
      .filter((session) => session.alive)
      .filter((session) => windowSessionIds === null || windowSessionIds.has(session.id))
      .map((session) => session.id);
    await attachments.attachAll(liveSessionIds, activeSessionId);
    for (const session of state.sessions) {
      if (!session.alive) {
        attachments.markExited(session.id, null);
      }
    }

    // Boot-time writes belong to the main window alone (single-writer rule):
    // an aux window adopts the same daemon state read-only.
    if (windowId === MAIN_WINDOW_ID) {
      if (restored !== null && reconciled.orphanAdoptedIds.length > 0) {
        persistence.record(reconciled.layout, "structural");
        await persistence.flush();
      }

      // Corpse hygiene: dead host-side records no pane references (their tab
      // was closed while the daemon was down) hold nothing anyone can reach —
      // reap them so state.json does not accumulate a graveyard across
      // reboots. Fire-and-forget: a failed close leaves a record the next
      // bootstrap reaps again.
      for (const deadId of reconciled.unreferencedDeadSessionIds) {
        client.closeSession(deadId).catch(() => undefined);
      }
    }

    // Losing the socket suspends attachments; it never destroys them. The
    // sessions are still running inside the daemon — only our connection to
    // them is gone, so the panes stay live and show a reconnecting state.
    const hubClient = client;
    connection.onStateChange((connectionState) => {
      if (connectionState.phase !== "connected") {
        attachments.suspendAll();
      }
    });
    const readyController = controller;
    connection.onConnected((_replacement, isReconnect) => {
      if (isReconnect) {
        // The facade is stable across sockets, so the hub re-attaches through
        // it and never has to learn which socket it is on.
        void attachments.resync(hubClient);
        // The controller's session map is seeded once at bootstrap; a NEW
        // daemon behind this reconnect (crash, restart, upgrade) knows a
        // different truth, and without this the old panes render live while
        // dead and refuse every affordance (triage P0 #3). A state read that
        // fails changes nothing — the next reconnect asks again.
        hubClient
          .getState()
          .then((state) => readyController.resyncSessions(state.sessions))
          .catch(() => undefined);
      }
    });

    return {
      client,
      controller,
      connection,
      settings,
      uiState,
      conversations,
      saved,
      sshHosts,
      sshCredentials,
      pluginPanes,
    };
  } catch {
    try {
      controller?.dispose();
    } catch {
      // Continue releasing the connected host client after partial setup.
    }
    try {
      // Disposing the machine also closes whatever socket it holds; a partial
      // boot must not leave a connection retrying behind an error screen.
      connection?.dispose();
      client?.close();
    } catch {
      // Bootstrap failure remains a bounded renderer error.
    }
    throw new Error("Unable to start the TermX workspace.");
  }
}
