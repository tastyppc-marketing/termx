import { invoke } from "@tauri-apps/api/core";
import { dataDir } from "@tauri-apps/api/path";
import {
  ConversationsStore,
  loadConversationsStore,
} from "../conversations/store";
import { sameFolder } from "./WorkspaceController";
import {
  CAPTURES_FILE,
  capturedRecord,
  compactCaptures,
  parseCaptures,
  type ConversationCapture,
} from "../conversations/captures";
import { conversationsFileIo, tauriSessionLister } from "../conversations/storage";
import type { LlmSessionRecord, SessionLister } from "../conversations/types";
import { HostClient, type HostClientConnectOptions } from "../host/client";
import { HostBootstrapError, ReconnectingHostClient } from "../host/reconnect";
import type { SessionInfo } from "../host/protocol";
import { tauriAppFiles, type AppFileStore } from "../native/appFiles";
import type { FolderPicker } from "../native/dialog";
import {
  connect as connectPlugin,
  DEFAULT_SPAWN_TIMEOUT_MS,
  ensureUp,
  isHealthy,
  POLL_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
  type ConnectOutcome,
  type EnsureUpResult,
} from "../plugins/lifecycle";
import { expandEnv, type PluginManifest } from "../plugins/manifest";
import { tauriPluginNative, type PluginNative } from "../plugins/native";
import {
  clonePluginPanes,
  PaneBindingsStore,
  parsePluginPanes,
  parsePluginPanesValue,
  toJsonPluginPanes,
} from "../plugins/paneBindings";
import {
  autostartOf,
  manifestFor,
  parsePluginsFile,
  PluginsStore,
} from "../plugins/registry";
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
import {
  MAIN_WINDOW_ID,
  parseLayout,
  sessionIdsInLayout,
  slotOf,
} from "../state/layout";
import { reconcile } from "../state/reconcile";
import { createLayoutStore } from "../state/store";
import { AttachmentHub } from "./AttachmentHub";
import { firstSessionId, flattenTabIds, sessionIdsInTab } from "./layoutOperations";
import { LayoutPersistence } from "./LayoutPersistence";
import type { WindowBus } from "./windowBus";
import { WorkspaceController, type WorkspacePluginHost } from "./WorkspaceController";
import { tauriRaiseWindow } from "./windowManager";

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
  /**
   * Brings another OS window to the front, for focusing a plugin panel that
   * lives in one. Defaults to the Tauri window manager; injected in tests,
   * which have no OS windows to raise.
   */
  raiseWindow?: (windowId: string) => Promise<void>;
  /**
   * Plugin process/probe seam (plugin spec §3); defaults to the Tauri commands.
   * Injected in tests so a unit run never reaches a native command.
   */
  pluginNative?: PluginNative;
  /**
   * Environment used to expand `%VAR%` in a manifest's runtime-file path.
   *
   * Defaults to `{ APPDATA: <Tauri's data dir> }` — see `defaultPluginEnv`.
   */
  pluginEnv?: Record<string, string | undefined>;
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
  /**
   * The installed-plugin registry (plugin spec §2), for the Settings section.
   * Always present; an empty registry is simply a workspace with no plugins.
   */
  plugins: PluginsStore;
  /**
   * The lifecycle seam the controller opens panels through, exposed so a
   * health indicator (and the tests that pin this wiring) can ask the same
   * questions the controller does without reaching into it.
   */
  pluginHost: WorkspacePluginHost;
  /**
   * A plugin's manifest ignoring the enabled gate: the folder file when it has
   * one, else the bundled table, else null.
   *
   * Separate from `pluginHost.manifestFor`, which refuses a disabled plugin
   * because opening one must refuse. Naming one must NOT: a switched-off
   * plugin still needs its name and icon in Settings and in the sidebar, and a
   * plugin that exists only as a folder manifest must be nameable at all.
   */
  pluginManifestFor: (pluginId: string) => PluginManifest | null;
  /**
   * "The manifest cache moved." Folder manifests resolve asynchronously — at
   * boot within a budget, and again a debounce after any registry change — so
   * `pluginManifestFor` answers differently over time without anything in
   * React noticing. A renderer that names panes and menu rows from it has to
   * be told, or a panel wears the bundled name (or its bare id) until some
   * unrelated render happens to refresh it.
   *
   * Returns the unsubscribe.
   */
  subscribeManifests: (listener: () => void) => () => void;
}

/**
 * How long the workspace boot waits for plugins' own manifest files before it
 * carries on with the bundled table. A folder path is user-chosen and may be a
 * UNC share, a disconnected mapped drive or a spun-down disk, and no window at
 * all is a far worse answer than a plugin briefly named by its bundled entry —
 * the read keeps going and the cache answers as soon as it lands.
 */
export const PLUGIN_MANIFEST_BOOT_BUDGET_MS = 1_500;

/**
 * How long the registry-driven re-read waits for the toggling to stop. Three
 * flicks of a Settings switch would otherwise be 3 × N native reads.
 */
export const PLUGIN_MANIFEST_REFRESH_DEBOUNCE_MS = 100;

/**
 * The environment a manifest's `%VAR%` discovery path is expanded against
 * (plugin spec §3.1). Only `APPDATA`, because that is where a plugin keeps its
 * own runtime file — Showroom's is `%APPDATA%\Showroom\runtime.json` — and the
 * renderer has no environment of its own to offer.
 *
 * DERIVED at runtime from Tauri's data dir rather than written down: the same
 * build has to work from any folder, on any machine, for any user. Every
 * failure (an older host, a denied permission, a platform where the notion
 * does not apply) yields an empty environment, which leaves the placeholder
 * intact — the plugin then reads as down, with a Relaunch button, rather than
 * taking the boot with it.
 */
async function defaultPluginEnv(): Promise<Record<string, string | undefined>> {
  try {
    // On Windows this is `%APPDATA%` itself (the roaming data dir).
    const roaming = (await dataDir()).replace(/[\\/]+$/, "");
    return roaming.length > 0 ? { APPDATA: roaming } : {};
  } catch {
    return {};
  }
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
  /// Relaunch requests from another window that arrived before this window had
  /// a controller to honour them with. Main registers its bus handler and
  /// `await bus.ready()`s well before construction — the manifest budget alone
  /// is 1.5 s — so an aux window that outlives a main remount can land an
  /// `ensure` in that gap. Dropping it would leave the user's Relaunch doing
  /// nothing, with nothing to retry it.
  const pendingEnsures = new Set<string>();
  /// Everything this workspace subscribed to that outlives a single call:
  /// window-bus listeners and the host client's exit hook. Released by
  /// `pluginHost.dispose()`, which `WorkspaceController.dispose()` runs — so a
  /// closed window stops adopting layouts and re-reading capture files.
  const releaseOnDispose: Array<() => void> = [];
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
    // Parsed once, up here, because reconcile needs the bound ids BEFORE the
    // stores are built: without them the boot sweep would report every plugin
    // pane as a dead session.
    const restoredPluginPanes = parsePluginPanes(pluginPanesText);
    const pluginPaneIds = new Set(
      Object.keys(restoredPluginPanes).map((key) => Number(key)),
    );
    // The installed-plugin registry, read with the same tolerance: an
    // unreadable or corrupt file is a workspace with no plugins.
    let pluginsText: string | null = null;
    try {
      pluginsText = await appFiles.read("plugins_v1.json");
    } catch {
      pluginsText = null;
    }
    const plugins = new PluginsStore({
      initial: parsePluginsFile(pluginsText),
      save: (text) => appFiles.write("plugins_v1.json", text),
    });
    // Conversation captures: written by the Claude Code SessionStart hook, so
    // TermX only ever reads them. A MISSING file is "no captures yet" and the
    // folder-based resume fallback stands; a THROWN read is "I don't know",
    // which is a different answer and must never be mistaken for the first.
    // Returning an empty map on a throw would erase every capture the process
    // had already learned, and Resume would vanish from the next dead pane.
    const readCaptures = async (): Promise<Map<number, ConversationCapture> | null> => {
      try {
        return parseCaptures(await appFiles.read(CAPTURES_FILE));
      } catch {
        return null;
      }
    };
    let capturesText: string | null = null;
    try {
      capturesText = await appFiles.read(CAPTURES_FILE);
    } catch {
      capturesText = null;
    }
    let captures = parseCaptures(capturesText);
    // Overlapping refreshes: two panes exiting together start two reads, and
    // the SLOWER one may resolve last while holding the OLDER file. Only the
    // most recently started read may apply its result.
    let capturesGeneration = 0;
    const refreshCaptures = (): void => {
      capturesGeneration += 1;
      const generation = capturesGeneration;
      void readCaptures().then((next) => {
        if (next !== null && generation === capturesGeneration) {
          captures = next;
          // A dead pane decides whether to offer "Resume conversation" from
          // this map, and nothing else observes it. Without the nudge the
          // pane keeps showing the plain Restart card until some unrelated
          // event happens to repaint it — which, for a pane that just died,
          // may be never.
          controller?.notifyCapturesChanged();
        }
      });
    };
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
    const reconciled = reconcile(restored, state.sessions, {
      ...(options.generateId ? { generateId: options.generateId } : {}),
      pluginPaneIds,
    });
    // Nothing else ever prunes an append-only log the UI re-reads on every
    // session exit, so boot is where it gets bounded — here rather than
    // earlier, because the reconciled layout is what says which captures are
    // still reachable.
    //
    // The keep set is passed ONLY when the layout actually parsed. An empty
    // keep set means "keep nothing" by contract, and a corrupt or missing
    // layout blob reconciles to an EMPTY layout — so trusting it would erase
    // the user's whole capture log at exactly the boot where their panes are
    // most in need of a resume. Unfiltered compaction (by age and per-pane
    // count) is the safe answer there.
    //
    // Errors are swallowed on purpose: the hook is a separate process that
    // may be appending at this very instant, and Windows refuses a write over
    // a file another process holds open. Losing the rewrite costs nothing —
    // the next boot retries, and the log we just parsed is still correct.
    if (capturesText !== null) {
      const compacted = restored === null
        ? compactCaptures(capturesText)
        : compactCaptures(capturesText, new Set(sessionIdsInLayout(reconciled.layout)));
      if (compacted !== null) {
        try {
          await appFiles.write(CAPTURES_FILE, compacted);
        } catch {
          // Next boot tries again.
        }
      }
    }
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
        releaseOnDispose.push(bus.onMutation((mutation) => {
          const proposed = parseLayout(mutation.layout);
          if (proposed === null) {
            return;
          }
          const adopted = store.replaceState(proposed);
          if (adopted === proposed) {
            persistence.record(adopted, "structural");
          }
        }));
      } else {
        releaseOnDispose.push(bus.onLayout((layout) => {
          const truth = parseLayout(layout);
          if (truth !== null) {
            store.replaceState(truth);
          }
        }));
      }
    }
    // Same single-writer rule as the layout, applied to the bindings file: the
    // MAIN window persists every change and fans it out; any other window is a
    // replica that adopts broadcasts, forwards its own binding changes to main,
    // and never writes. Both windows seed from the file, so an aux window has
    // its bindings from the first frame instead of waiting for main's next
    // change.
    const pluginPanes = bootWindowId === MAIN_WINDOW_ID
      ? new PaneBindingsStore({
          initial: clonePluginPanes(restoredPluginPanes),
          save: (text) => appFiles.write("plugin_panes_v1.json", text),
          ...(bus !== null
            ? { onBroadcast: (state) => void bus.broadcastPluginPanes(toJsonPluginPanes(state)) }
            : {}),
        })
      : new PaneBindingsStore({
          initial: clonePluginPanes(restoredPluginPanes),
          save: null,
          ...(bus !== null
            ? {
                // The promise is RETURNED, not voided: the store chains it into
                // the same queue `flush()` awaits, and an aux window's binding
                // only really exists once main has been told. Voiding it would
                // make "flush the binding, then persist the layout" a no-op in
                // every window but main — the exact crash order T5 closes.
                onForward: (request) =>
                  bus.forwardPluginPanes(
                    request.op === "bind"
                      ? {
                          kind: "pluginPanes",
                          op: "bind",
                          sessionId: request.sessionId,
                          pluginId: request.binding.pluginId,
                          ...(request.binding.path !== undefined
                            ? { path: request.binding.path }
                            : {}),
                        }
                      : {
                          kind: "pluginPanes",
                          op: "unbind",
                          sessionIds: [...request.sessionIds],
                        },
                  ),
              }
            : {}),
        });
    if (bus !== null) {
      if (bootWindowId === MAIN_WINDOW_ID) {
        releaseOnDispose.push(bus.onPluginPanesMutation((mutation) => {
          if (mutation.op === "bind") {
            pluginPanes.bind(mutation.sessionId, {
              pluginId: mutation.pluginId,
              ...(mutation.path !== undefined ? { path: mutation.path } : {}),
            });
          } else if (mutation.op === "unbind") {
            pluginPanes.unbind(mutation.sessionIds);
          } else if (mutation.op === "ensure") {
            // Another window's Relaunch. Spawning is main's alone, so this is
            // the only place that click can be honoured — and it must be a
            // FORCE: the plugin the user is relaunching is usually one main
            // still has cached as "up".
            if (controller === null) {
              pendingEnsures.add(mutation.pluginId);
            } else {
              void controller.forcePluginRestart(mutation.pluginId);
            }
          } else {
            // Catch-up for a window that booted after our last broadcast: it
            // asked because its file read may already be stale.
            void bus.broadcastPluginPanes(
              toJsonPluginPanes(pluginPanes.getSnapshot()),
            );
          }
        }));
        // Main waits for its own registration too. An aux window's `sync` (or
        // a bind forwarded the instant it opened) that wins the race against
        // an unresolved `listen()` is dropped, and nothing re-sends it — so
        // this has to settle before any aux window can be opened.
        await bus.ready();
      } else {
        // A broadcast is untrusted input from another window: parse it like a
        // file read and adopt only what survives.
        releaseOnDispose.push(
          bus.onPluginPanes((state) => pluginPanes.adopt(parsePluginPanesValue(state))),
        );
        // Only once the subscription is REALLY live (the transport's listen is
        // async) do we ask main for the truth — otherwise the answer could
        // arrive before we are listening and be lost. The file read above is
        // the fallback if main never answers: aux windows are opened by main,
        // so in practice main is always listening by this point.
        await bus.ready();
        void bus.forwardPluginPanes({ kind: "pluginPanes", op: "sync" });
      }
    }
    if (bootWindowId === MAIN_WINDOW_ID && restored !== null) {
      // Orphan sweep (spec §4). `bind` writes the bindings file immediately and
      // independently of LayoutPersistence, so a crash between the two leaves a
      // binding whose pane never reached the blob; boot is where that is
      // cheapest to notice. Gated on a layout that actually PARSED — pruning
      // against the empty fallback would delete every binding the user has.
      //
      // T5 note (the other crash order): a layout write that lands before its
      // binding leaves a reserved pane with no binding — a dismissible dead
      // pane, and the panel identity is gone. Whatever binds a pane must
      // `await pluginPanes.flush()` BEFORE persisting the layout that
      // references it.
      pluginPanes.prune(new Set(sessionIdsInLayout(reconciled.layout)));
    }
    // The plugin lifecycle seam the controller opens panels through (spec §3).
    // Ensure-up adopts a healthy instance and only spawns when there is none,
    // so TermX never owns — or kills — a plugin's process.
    //
    // A manifest comes from the plugin's OWN `termx-plugin.json` when it ships
    // one, else the bundled table (spec §9 — a first-party plugin needs no file
    // in its repository). The read is async and the controller's `manifestFor`
    // seam is synchronous (it names a tab mid-open), so folder manifests are
    // pre-read into a cache at boot and re-read whenever the registry changes.
    const pluginNative = options.pluginNative ?? tauriPluginNative;
    // Resolved lazily and once: a workspace with no plugins never pays for it,
    // and two panes opened together share the one lookup.
    const injectedEnv = options.pluginEnv;
    let pluginEnvOnce: Promise<Record<string, string | undefined>> | null = null;
    const pluginEnv = (): Promise<Record<string, string | undefined>> => {
      pluginEnvOnce ??= injectedEnv ? Promise.resolve(injectedEnv) : defaultPluginEnv();
      return pluginEnvOnce;
    };
    /**
     * One plugin's manifest from its folder file, falling back to the bundled
     * table. The file WINS when it parses; a malformed one falls back rather
     * than making the plugin unopenable, because a first-party plugin whose
     * repository grew a broken file should keep working (Settings is where the
     * parse errors are explained).
     *
     * The id must MATCH the registry key: that key is what a pane binding
     * stores and what the spawn stamps as TERMX_PLUGIN_ID, so a folder
     * answering to another plugin's name would let one impersonate another.
     */
    const resolveManifest = (
      pluginId: string,
      text: string | null,
    ): PluginManifest | null => {
      const fromFile = text === null ? null : manifestFor(pluginId, text);
      if (fromFile !== null && fromFile.id === pluginId) {
        return fromFile;
      }
      return manifestFor(pluginId, null);
    };
    /**
     * Every registry entry's manifest, ENABLED OR NOT.
     *
     * Disabled entries are cached deliberately: a switched-off plugin still
     * has a name, and that name is what its refusal and its Settings row must
     * say — dropping it from the cache would print the raw registry id and
     * would leave a just-re-enabled plugin unopenable until the async re-read
     * landed. The gate lives in `installedManifest` alone.
     *
     * LIMITATION (P1): the cache is refreshed at boot and whenever the
     * registry snapshot changes. Editing a `termx-plugin.json` in place while
     * TermX runs is not noticed until the next boot or the next registry
     * change; re-picking the same folder in Settings is a no-op by design
     * (`registry.add` returns early on an unchanged path).
     */
    // The host's own lifetime. A spawn poll runs for ten seconds and an aux
    // window's observe for ten more, so both can easily outlive the window
    // that started them - and a loop that keeps reading files and probing
    // ports after its window is gone is a leak the user pays for on every
    // tear-out and close.
    let hostReleased = false;
    const pendingSleeps = new Set<{
      timer: ReturnType<typeof setTimeout>;
      wake: () => void;
    }>();
    const hostSleep = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        if (hostReleased) {
          resolve();
          return;
        }
        const entry = {
          timer: setTimeout(() => {
            pendingSleeps.delete(entry);
            resolve();
          }, ms),
          wake: resolve,
        };
        pendingSleeps.add(entry);
      });
    /**
     * `Infinity` once released, so the spawn poll's `while (now() < deadline)`
     * ends at its next check instead of running out the whole budget inside a
     * window that has closed.
     */
    const hostNow = (): number =>
      (hostReleased ? Number.POSITIVE_INFINITY : Date.now());
    const folderManifests = new Map<string, PluginManifest | null>();
    const manifestListeners = new Set<() => void>();
    let manifestEpoch = 0;
    // The boot read is unbounded (only the WAIT for it is bounded), so it can
    // still land in a window that has already been torn down.
    let manifestsReleased = false;
    const refreshFolderManifests = async (): Promise<void> => {
      const epoch = (manifestEpoch += 1);
      const next = new Map<string, PluginManifest | null>();
      const env = await pluginEnv();
      await Promise.all(
        Object.entries(plugins.getSnapshot().plugins).map(async ([id, entry]) => {
          let text: string | null = null;
          try {
            // Expanded like every other path from this file: a hand-edited
            // registry may hold `%APPDATA%\\Showroom`, and an unexpanded
            // literal would read as "no manifest" for ever.
            text = await pluginNative.readManifest(expandEnv(entry.path, env));
          } catch {
            // No folder file, an unreadable one, or an older host without the
            // command: the bundled table answers, exactly as before.
            text = null;
          }
          next.set(id, resolveManifest(id, text));
        }),
      );
      // A refresh that started earlier must not overwrite a newer one's
      // answers — and one that lands after the host was released must not
      // wake listeners belonging to a window that is gone.
      if (epoch !== manifestEpoch || manifestsReleased) {
        return;
      }
      folderManifests.clear();
      for (const [id, manifest] of next) {
        folderManifests.set(id, manifest);
      }
      for (const listener of [...manifestListeners]) {
        listener();
      }
    };
    // Bounded (see the constant): the boot must not hang on a folder read.
    let bootBudget: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      refreshFolderManifests(),
      new Promise<void>((resolve) => {
        bootBudget = setTimeout(resolve, PLUGIN_MANIFEST_BOOT_BUDGET_MS);
      }),
    ]);
    // The usual case is a read that beat the budget, leaving a 1.5 s timer
    // holding the event loop (and, under fake timers, a pending tick every
    // later assertion has to step over).
    clearTimeout(bootBudget);
    // Enabling, adding, or re-pathing a plugin changes which file to read, and
    // the answer must not stay stale until the next boot. Debounced, because
    // the store notifies synchronously on every mutation. Asynchronous by
    // nature: until it lands, the previous cache entry (or the bundled table)
    // answers, which is never worse than what came before.
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const stopWatchingRegistry = plugins.subscribe(() => {
      // "Start with TermX" is a registry field, and the controller recomputes
      // its plugin scope only from layout and binding changes — neither of
      // which a Settings toggle produces. Undebounced on purpose: the flag is
      // a direct instruction, the recompute is cheap and idempotent (the
      // ensure-up path dedupes an answer that already stands), and a debounce
      // would leave the switch visibly lagging its own effect.
      if (bootWindowId === MAIN_WINDOW_ID) {
        controller?.refreshPluginScope();
      }
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer);
      }
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refreshFolderManifests();
      }, PLUGIN_MANIFEST_REFRESH_DEBOUNCE_MS);
    });
    /// The manifest ignoring the enabled gate — for messages that need a NAME.
    const knownManifest = (pluginId: string): PluginManifest | null =>
      folderManifests.get(pluginId) ?? manifestFor(pluginId, null);
    // `enabled` is a real off switch (spec §2, §7), enforced HERE rather than
    // in the menus: the controller's open/relaunch methods are a seam other
    // code calls, so a hidden menu entry is not a guard. A disabled plugin has
    // no manifest to give, which is what makes every one of those paths refuse.
    const installedManifest = (pluginId: string): PluginManifest | null => {
      if (plugins.getSnapshot().plugins[pluginId]?.enabled !== true) {
        return null;
      }
      const cached = folderManifests.get(pluginId);
      return cached !== undefined ? cached : manifestFor(pluginId, null);
    };
    /**
     * Why this plugin cannot be opened, or null when it can.
     *
     * Each refusal says which of the three things is wrong, because this text
     * is what a refused menu entry and a restored pane's down card show.
     * "Not installed" on a plugin the user only switched off would send them
     * hunting for a folder they never removed.
     */
    const unavailableReason = (pluginId: string): string | null => {
      const entry = plugins.getSnapshot().plugins[pluginId];
      if (entry === undefined) {
        // Named without the gate too: a plugin that was just removed from the
        // registry may still be nameable from the bundled table.
        return `The plugin "${knownManifest(pluginId)?.name ?? pluginId}" is not installed.`;
      }
      if (entry.enabled !== true) {
        // Named WITHOUT the enabled gate: a disabled plugin still has a name,
        // and its card should use it.
        return `${knownManifest(pluginId)?.name ?? pluginId} is disabled in Settings.`;
      }
      if (installedManifest(pluginId) === null) {
        return `TermX cannot read a manifest for the plugin "${pluginId}".`;
      }
      return null;
    };
    /**
     * One runtime look, no spawn: the runtime file as it stands, probed for
     * this plugin's own health response.
     */
    const lookForRuntime = async (
      manifest: PluginManifest,
    ): Promise<ConnectOutcome> => {
      const env = await pluginEnv();
      return connectPlugin(expandEnv(manifest.discovery.runtimeFile, env), manifest, {
        native: pluginNative,
        env,
        now: hostNow,
        sleep: hostSleep,
      });
    };
    /**
     * An aux window's ensure-up: WAIT for the plugin, never start it.
     *
     * Lifecycle ownership is the main window's alone. Every window builds its
     * own controller and its own host, so two windows opening a panel at the
     * same moment would otherwise both find the plugin down and both spawn it
     * — and a plugin that walks ports (spec §9) answers that with two live
     * processes and one of them orphaned. Main starts the plugin as soon as it
     * adopts the forwarded binding, so the ordinary outcome here is that the
     * plugin appears within a poll or two.
     */
    const observePluginUp = async (
      manifest: PluginManifest,
    ): Promise<EnsureUpResult> => {
      const deadline = Date.now() + DEFAULT_SPAWN_TIMEOUT_MS;
      // The released check is the LOOP condition, so the wake `dispose` gives
      // a sleeping poll ends it rather than buying one more read and probe.
      while (!hostReleased) {
        const outcome = await lookForRuntime(manifest);
        if (outcome.kind === "up") {
          return { ok: true, runtime: outcome.runtime };
        }
        if (outcome.kind === "unreadable") {
          // The same fail-fast main gets: an unexpanded `%VAR%`, a relative
          // path, a denied read. Spending the whole ten seconds on a path
          // fault and then blaming the main window is the wrong answer twice.
          return { ok: false, reason: outcome.reason, stderrTail: "" };
        }
        if (Date.now() >= deadline) {
          break;
        }
        await hostSleep(POLL_INTERVAL_MS);
      }
      return {
        ok: false,
        reason: "The plugin is not running. Relaunch it from the main window.",
        stderrTail: "",
      };
    };
    const pluginHost: WorkspacePluginHost = {
      manifestFor: installedManifest,
      unavailableReason,
      ...(bootWindowId === MAIN_WINDOW_ID
        ? {
          // "Start with TermX" (menubar spec). Read LIVE from the registry, and
          // gated on `enabled` as everything else is: a switched-off plugin has
          // no manifest to give, so autostart must not smuggle it back into the
          // lifecycle. Main only - spawning is main's alone (spec §3).
          autostartIds: (): readonly string[] =>
            Object.entries(plugins.getSnapshot().plugins)
              .filter(([, entry]) => entry.enabled && autostartOf(entry))
              .map(([id]) => id),
        }
        : {}),
      dispose: () => {
        manifestsReleased = true;
        hostReleased = true;
        stopWatchingRegistry();
        manifestListeners.clear();
        if (refreshTimer !== null) {
          clearTimeout(refreshTimer);
          refreshTimer = null;
        }
        // Wake every poll so its loop reaches the released check and returns,
        // instead of holding a timer inside a window being destroyed.
        for (const entry of [...pendingSleeps]) {
          clearTimeout(entry.timer);
          pendingSleeps.delete(entry);
          entry.wake();
        }
        for (const release of releaseOnDispose.splice(0)) {
          try {
            release();
          } catch {
            // One failed unsubscribe must not strand the others.
          }
        }
        // The registry debounces its disk write by 800 ms, and closing a
        // window is exactly when that debounce is still pending: add a folder,
        // open the panel, quit. The layout and the bindings would then name a
        // plugin `plugins_v1.json` had never heard of.
        void plugins.flush();
      },
      ...(bus !== null && bootWindowId !== MAIN_WINDOW_ID
        ? {
          // Spawning is main's alone, so this window's Relaunch is a REQUEST.
          // The answer comes back as the plugin appearing, which the observe
          // loop started by the same click is already watching for.
          requestEnsure: (pluginId: string) => {
            void bus.forwardPluginPanes({
              kind: "pluginPanes",
              op: "ensure",
              pluginId,
            });
          },
        }
        : {}),
      ...(bootWindowId !== MAIN_WINDOW_ID
        ? {
          // One look, no waiting, no spawn: the health poll's way of letting
          // this window notice that main has started the plugin again. Main
          // deliberately has no such seam — there the poll must stay one-way.
          observeOnce: async (pluginId: string): Promise<EnsureUpResult> => {
            const manifest = installedManifest(pluginId);
            if (manifest === null) {
              return {
                ok: false as const,
                reason: unavailableReason(pluginId) ?? "The plugin is unavailable.",
                stderrTail: "",
              };
            }
            const outcome = await lookForRuntime(manifest);
            return outcome.kind === "up"
              ? { ok: true as const, runtime: outcome.runtime }
              : {
                ok: false as const,
                reason: outcome.kind === "unreadable"
                  ? outcome.reason
                  : "The plugin is not running. Relaunch it from the main window.",
                stderrTail: "",
              };
          },
        }
        : {}),
      ensureUp: async (pluginId: string) => {
        const refusal = unavailableReason(pluginId);
        if (refusal !== null) {
          return { ok: false as const, reason: refusal, stderrTail: "" };
        }
        const entry = plugins.getSnapshot().plugins[pluginId]!;
        const manifest = installedManifest(pluginId)!;
        if (bootWindowId !== MAIN_WINDOW_ID) {
          return observePluginUp(manifest);
        }
        return ensureUp(manifest, expandEnv(entry.path, await pluginEnv()), {
          native: pluginNative,
          env: await pluginEnv(),
          now: hostNow,
          sleep: hostSleep,
        });
      },
      /**
       * The 15-second poll's question, and a pure OBSERVATION: it asks the
       * health route of the origin the pane is CURRENTLY framing, and that is
       * all. It must NEVER become an ensure-up — a spawn here would resurrect
       * a plugin the user just killed, so the down card could never appear and
       * Relaunch would have nothing left to do.
       *
       * The origin comes from the caller rather than from a fresh read of the
       * runtime file, and that is the point: a plugin that died and came back
       * on another port (Showroom walks ports, spec §9) is NOT up as far as
       * this pane is concerned — the iframe is still pointed at the old one.
       * Answering "down" is what sends the user to Relaunch, which re-reads
       * the file and re-frames the new port.
       *
       * Every failure is the same answer, "not healthy": a disabled or
       * uninstalled plugin (no manifest), a refused connection, or a body that
       * is not this plugin's own health response.
       */
      probe: async (pluginId: string, origin: string): Promise<boolean> => {
        const manifest = installedManifest(pluginId);
        if (manifest === null) {
          return false;
        }
        try {
          return isHealthy(
            await pluginNative.probe(
              `${origin}${manifest.discovery.healthPath}`,
              PROBE_TIMEOUT_MS,
            ),
          );
        } catch {
          return false;
        }
      },
    };
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
      // Exact dead-pane resume: the conversation THIS pane ran. Joined against
      // the index for a real title when the scan has already seen it, and
      // synthesized from the capture alone when it has not — the resume needs
      // only provider + id, so it must not wait on a background scan.
      capturedConversationFor: (sessionId: number): LlmSessionRecord | null => {
        const capture = captures.get(sessionId);
        if (capture === undefined) {
          return null;
        }
        const indexed = conversations
          .getSnapshot()
          .records.find(
            (candidate) =>
              candidate.provider === capture.provider && candidate.id === capture.id,
          ) ?? null;
        return capturedRecord(capture, indexed);
      },
      savedSessions: saved,
      pluginPanes,
      plugins: pluginHost,
      sshPasswords: { passwordFor: (alias: string) => sshCredentials.passwordFor(alias) },
      sshHosts: { byAlias: (alias: string) => sshHosts.find((host) => host.aliases.includes(alias)) ?? null },
      raiseWindow: options.raiseWindow ?? tauriRaiseWindow(),
      ...(options.generateId ? { generateId: options.generateId } : {}),
      ...(options.pickFolder ? { pickFolder: options.pickFolder } : {}),
      ...(options.windowId ? { windowId: options.windowId } : {}),
    };
    controller = new WorkspaceController(controllerOptions);
    // Whatever asked while there was nobody to ask. Deduplicated by the set:
    // three impatient clicks are one spawn, which is what a force ensure would
    // have coalesced them into had the controller existed.
    const started = controller;
    for (const pluginId of pendingEnsures) {
      void started.forcePluginRestart(pluginId);
    }
    pendingEnsures.clear();

    // A session exiting is exactly when a dead pane appears and its Resume
    // button asks who it should resume — and the pane may have run `claude`
    // long after boot, so the boot-time read alone would miss it. One small
    // file read at that moment; a failed read leaves the last good map in
    // place. Fire-and-forget: nothing waits on the refresh, the pane simply
    // has its capture by the time the user reaches for the button.
    releaseOnDispose.push(client.onSessionExited(() => {
      refreshCaptures();
    }));

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
      plugins,
      pluginHost,
      pluginManifestFor: knownManifest,
      subscribeManifests: (listener: () => void) => {
        manifestListeners.add(listener);
        return () => {
          manifestListeners.delete(listener);
        };
      },
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
