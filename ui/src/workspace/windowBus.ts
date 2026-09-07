import { emit, listen } from "@tauri-apps/api/event";
import type { JsonValue } from "../host/protocol";
import { isValidPluginId } from "../plugins/manifest";

/// Cross-window layout plumbing for the single-writer rule (multi-window
/// spec): the MAIN window is the only `SetLayout` writer. An aux window never
/// writes the daemon — it forwards its whole proposed layout to main over
/// this bus, main validates + persists, and the merged truth fans back out to
/// every window as a broadcast.
///
/// Proposals carry their base and a per-workspace sequence. Sync metadata is
/// bus-only: the persisted layout remains v3.
export type LayoutMutation = {
  kind: "setLayout";
  layout: JsonValue;
  base?: JsonValue;
  origin?: string;
  sequence?: number;
};

export interface LayoutSyncMetadata {
  authority: string;
  revision: number;
  receipts: Record<string, { sequence: number; rejected: boolean }>;
}

/**
 * Aux → main for the plugin pane bindings (plugin spec §4), the same shape of
 * plumbing as `LayoutMutation` and for the same reason: `plugin_panes_v1.json`
 * has one writer, so a window that is not main asks rather than writes.
 *
 * `sync` is the boot catch-up. An aux window seeds itself from the bindings
 * file, but the file it reads can already be stale (main binds during aux
 * startup, and a Tauri `listen()` that has not resolved yet drops the
 * broadcast). Asking main to re-broadcast once, after the listener exists,
 * closes that window without any promise plumbing in the bus.
 *
 * `ensure` is Relaunch from an aux window. It is on this channel rather than a
 * new one for the same reason the binds are: it is a window asking main to do
 * the one thing only main may do. Spawning is main's alone (spec §3 — two
 * windows both finding a plugin down would both start the singleton), so an
 * aux window's Relaunch has nothing to press without this. It carries no
 * reply: the asking window goes on observing, and sees the plugin come up the
 * same way it would if main had started it for any other reason.
 *
 * `rejected` is the one message that runs main -> aux on this channel, and the
 * only reply any of them has. Main refuses a bind it cannot honour - a second
 * panel for a singleton already open, or already opening in another window -
 * and the asking window has to be TOLD, or it sits out the five-second adopt
 * timeout showing a panel that is never coming. Main ignores its own copy;
 * every other window acts only on the ids it was waiting for.
 */
export type PluginPanesMutation =
  | {
      kind: "pluginPanes";
      op: "bind";
      sessionId: number;
      pluginId: string;
      path?: string;
    }
  | { kind: "pluginPanes"; op: "unbind"; sessionIds: number[] }
  | { kind: "pluginPanes"; op: "sync" }
  | { kind: "pluginPanes"; op: "ensure"; pluginId: string }
  | { kind: "pluginPanes"; op: "rejected"; sessionIds: number[] };

export interface WindowBus {
  /** Aux → main: apply this mutation to the shared layout. The promise
   * resolves once the runtime has taken the event — a closing aux window
   * awaits it before destroying itself, so the mutation cannot die with the
   * webview. */
  forwardMutation(mutation: LayoutMutation): Promise<void>;
  /** Main → all: the layout changed; here is the new blob. */
  broadcastLayout(layout: JsonValue, sync?: LayoutSyncMetadata): Promise<void>;
  /**
   * Main → all: the plugin pane bindings changed; here is the whole map
   * (plugin spec §4). This channel carries main's authoritative truth only —
   * `plugin_panes_v1.json` has the layout's single-writer discipline, so an
   * aux window adopts what arrives here and sends its own changes back the
   * other way, over `forwardPluginPanes`.
   */
  broadcastPluginPanes(state: JsonValue): Promise<void>;
  /**
   * Aux → main: apply this binding change, (`sync`) re-send the truth, or
   * (`ensure`) start the plugin, which only main may do.
   */
  forwardPluginPanes(mutation: PluginPanesMutation): Promise<void>;
  onMutation(handler: (mutation: LayoutMutation) => void): () => void;
  onLayout(handler: (layout: JsonValue, sync?: LayoutSyncMetadata) => void): () => void;
  onPluginPanes(handler: (state: JsonValue) => void): () => void;
  onPluginPanesMutation(handler: (mutation: PluginPanesMutation) => void): () => void;
  /**
   * Resolves once every subscription registered so far is really receiving
   * events. Subscribing is fire-and-forget (the transport's `listen` is
   * async), so a window that subscribes and IMMEDIATELY asks another window to
   * send it something can miss the answer. Await this in between.
   *
   * ALWAYS resolves, never rejects, and never waits longer than
   * `BUS_READY_TIMEOUT_MS`: this sits on a window's boot path, and a
   * registration that never settles must degrade to "carry on with local
   * state", not hang a window with no UI and no error path.
   */
  ready(): Promise<void>;
}

export const LAYOUT_MUTATION_EVENT = "termx:layout-mutation";
export const LAYOUT_STATE_EVENT = "termx:layout-state";
export const PLUGIN_PANES_EVENT = "termx:plugin-panes";
export const PLUGIN_PANES_MUTATION_EVENT = "termx:plugin-panes-mutation";

/**
 * How long `ready()` will wait for the transport's listener registrations.
 * Generous for an IPC round trip, short enough that a window that will never
 * hear anything still boots.
 */
export const BUS_READY_TIMEOUT_MS = 2_000;

/**
 * Forwarded bindings are untrusted input from another window, so the payload
 * is validated field by field before any of it reaches the store — the same
 * discipline `onMutation` applies to a forwarded layout blob.
 */
function parsePluginPanesMutation(payload: unknown): PluginPanesMutation | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    (payload as { kind?: unknown }).kind !== "pluginPanes"
  ) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (record.op === "sync") {
    return { kind: "pluginPanes", op: "sync" };
  }
  if (record.op === "ensure") {
    const { pluginId } = record;
    if (typeof pluginId !== "string" || !isValidPluginId(pluginId)) {
      return null;
    }
    return { kind: "pluginPanes", op: "ensure", pluginId };
  }
  if (record.op === "bind") {
    const { sessionId, pluginId, path } = record;
    if (
      typeof sessionId !== "number" ||
      !Number.isInteger(sessionId) ||
      typeof pluginId !== "string" ||
      // The same rule the registry enforces: an id it could never hold has no
      // business entering the bindings map — which main WRITES TO DISK.
      !isValidPluginId(pluginId)
    ) {
      return null;
    }
    return {
      kind: "pluginPanes",
      op: "bind",
      sessionId,
      pluginId,
      ...(typeof path === "string" && path.length > 0 ? { path } : {}),
    };
  }
  if (record.op === "unbind" || record.op === "rejected") {
    if (!Array.isArray(record.sessionIds)) {
      return null;
    }
    return {
      kind: "pluginPanes",
      op: record.op,
      sessionIds: record.sessionIds.filter(
        (id): id is number => typeof id === "number" && Number.isInteger(id),
      ),
    };
  }
  return null;
}

interface EmitListen {
  emit(event: string, payload: unknown): Promise<void>;
  listen(
    event: string,
    handler: (event: { payload: unknown }) => void,
  ): Promise<() => void>;
}

/// The real bus: Tauri's in-app event system, which reaches every webview
/// window of this app instance. `transport` is injectable for tests; the
/// default is the real Tauri API.
export function tauriWindowBus(
  transport: EmitListen = { emit, listen },
): WindowBus {
  const channel = (
    event: string,
  ): {
    send(payload: unknown): Promise<void>;
    subscribe(handler: (payload: unknown) => void): () => void;
    ready(): Promise<void>;
  } => {
    const handlers = new Set<(payload: unknown) => void>();
    // The in-flight `listen()` registration. Until it settles this window is
    // NOT yet receiving the event, so anything emitted meanwhile is lost —
    // which is why `ready()` exists.
    let listening: Promise<void> | null = null;
    /// What Tauri gives back for taking the registration off this window. A
    /// webview outlives its workspace — reconnects and remounts build a new
    /// one in the same page — so dropping this would leave every dead
    /// workspace still receiving, and re-dispatching, every broadcast for the
    /// life of the process.
    let unlisten: (() => void) | null = null;
    /// Bumped when the channel is released, so a registration still in flight
    /// knows it is already unwanted and hands itself straight back.
    let epoch = 0;
    return {
      send(payload) {
        // A failed emit means the receiving window is gone, and the next
        // broadcast carries the full truth anyway — never an error upstream.
        return transport.emit(event, payload).catch(() => undefined);
      },
      subscribe(handler) {
        handlers.add(handler);
        if (listening === null) {
          const mine = ++epoch;
          listening = transport
            .listen(event, ({ payload }) => {
              for (const registered of [...handlers]) {
                try {
                  registered(payload);
                } catch {
                  // One bad subscriber must not silence the others.
                }
              }
            })
            .then((stop) => {
              if (mine !== epoch) {
                // Released while it was registering.
                try {
                  stop();
                } catch {
                  // A transport that cannot unlisten is not our problem here.
                }
                return;
              }
              unlisten = stop;
            })
            .catch(() => undefined);
        }
        return () => {
          handlers.delete(handler);
          if (handlers.size > 0) {
            return;
          }
          // The last subscriber has gone: give the native registration back
          // and forget it, so a later workspace in this same webview listens
          // afresh rather than inheriting a dead channel.
          epoch += 1;
          listening = null;
          const stop = unlisten;
          unlisten = null;
          try {
            stop?.();
          } catch {
            // Same as above: nothing upstream can act on this.
          }
        };
      },
      ready() {
        return listening ?? Promise.resolve();
      },
    };
  };
  const mutations = channel(LAYOUT_MUTATION_EVENT);
  const layouts = channel(LAYOUT_STATE_EVENT);
  const pluginPanes = channel(PLUGIN_PANES_EVENT);
  const pluginPaneMutations = channel(PLUGIN_PANES_MUTATION_EVENT);
  const channels = [mutations, layouts, pluginPanes, pluginPaneMutations];
  return {
    ready: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), BUS_READY_TIMEOUT_MS);
      });
      const outcome = await Promise.race([
        Promise.all(channels.map((entry) => entry.ready())).then(
          () => "ready" as const,
        ),
        timeout,
      ]);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (outcome === "timeout") {
        // Visible, but never fatal: the caller's own fallback (for the
        // bindings, the file it already read) is what carries the window.
        console.warn(
          "[termx] window bus listeners did not register in time; continuing without cross-window sync",
        );
      }
    },
    forwardMutation: (mutation) => mutations.send(mutation),
    broadcastLayout: (layout, sync) => layouts.send(sync ? { layout, sync } : layout),
    broadcastPluginPanes: (state) => pluginPanes.send(state),
    forwardPluginPanes: (mutation) => pluginPaneMutations.send(mutation),
    onPluginPanesMutation: (handler) =>
      pluginPaneMutations.subscribe((payload) => {
        const mutation = parsePluginPanesMutation(payload);
        if (mutation !== null) {
          handler(mutation);
        }
      }),
    onPluginPanes: (handler) =>
      pluginPanes.subscribe((payload) => {
        // The bindings map is always a JSON object; anything else on this
        // channel is not ours, and adopting it would blank every binding.
        if (
          typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ) {
          handler(payload as JsonValue);
        }
      }),
    onMutation: (handler) =>
      mutations.subscribe((payload) => {
        if (
          typeof payload === "object" && payload !== null &&
          (payload as { kind?: unknown }).kind === "setLayout" &&
          "layout" in payload
        ) {
          handler(payload as LayoutMutation);
        }
      }),
    onLayout: (handler) =>
      layouts.subscribe((payload) => {
        if (typeof payload === "object" && payload !== null && "sync" in payload) {
          const envelope = payload as { layout: JsonValue; sync: LayoutSyncMetadata };
          const sync = envelope.sync;
          if (!sync || typeof sync.authority !== "string" || !sync.authority ||
            !Number.isSafeInteger(sync.revision) || sync.revision < 0 ||
            typeof sync.receipts !== "object" || sync.receipts === null ||
            Array.isArray(sync.receipts) ||
            !Object.values(sync.receipts).every((receipt) => receipt &&
              Number.isSafeInteger(receipt.sequence) && receipt.sequence > 0 &&
              typeof receipt.rejected === "boolean")) return;
          handler(envelope.layout, sync);
        } else {
          handler(payload as JsonValue);
        }
      }),
  };
}

/// In-process bus for tests and for a single-window run wired the same way.
/// Delivery is synchronous.
export function loopbackBus(): WindowBus {
  const mutationHandlers = new Set<(mutation: LayoutMutation) => void>();
  const layoutHandlers = new Set<(layout: JsonValue, sync?: LayoutSyncMetadata) => void>();
  const pluginPaneHandlers = new Set<(state: JsonValue) => void>();
  const pluginPaneMutationHandlers = new Set<
    (mutation: PluginPanesMutation) => void
  >();
  return {
    // Delivery is synchronous here, so a subscriber is live the moment it
    // subscribes; there is nothing to wait for.
    ready: async () => undefined,
    async forwardMutation(mutation) {
      for (const handler of [...mutationHandlers]) {
        try {
          handler(mutation);
        } catch {
          // One bad subscriber must not silence the others.
        }
      }
    },
    async broadcastLayout(layout, sync) {
      for (const handler of [...layoutHandlers]) {
        try {
          handler(layout, sync);
        } catch {
          // One bad subscriber must not silence the others.
        }
      }
    },
    async broadcastPluginPanes(state) {
      for (const handler of [...pluginPaneHandlers]) {
        try {
          handler(state);
        } catch {
          // One bad subscriber must not silence the others.
        }
      }
    },
    onMutation(handler) {
      mutationHandlers.add(handler);
      return () => mutationHandlers.delete(handler);
    },
    onLayout(handler) {
      layoutHandlers.add(handler);
      return () => layoutHandlers.delete(handler);
    },
    async forwardPluginPanes(mutation) {
      for (const handler of [...pluginPaneMutationHandlers]) {
        try {
          handler(mutation);
        } catch {
          // One bad subscriber must not silence the others.
        }
      }
    },
    onPluginPanes(handler) {
      pluginPaneHandlers.add(handler);
      return () => pluginPaneHandlers.delete(handler);
    },
    onPluginPanesMutation(handler) {
      pluginPaneMutationHandlers.add(handler);
      return () => pluginPaneMutationHandlers.delete(handler);
    },
  };
}
