import { emit, listen } from "@tauri-apps/api/event";
import type { JsonValue } from "../host/protocol";

/// Cross-window layout plumbing for the single-writer rule (multi-window
/// spec): the MAIN window is the only `SetLayout` writer. An aux window never
/// writes the daemon — it forwards its whole proposed layout to main over
/// this bus, main validates + persists, and the merged truth fans back out to
/// every window as a broadcast.
///
/// v1 of the mutation protocol is deliberately coarse: one mutation kind
/// carrying the ENTIRE proposed layout. Coarse is safe because window slots
/// partition ownership — an aux window only ever rewrites its own slot plus
/// explicit cross-window moves — and simultaneous edits to different slots
/// converge because main re-broadcasts the merged truth.

export type LayoutMutation = { kind: "setLayout"; layout: JsonValue };

export interface WindowBus {
  /** Aux → main: apply this mutation to the shared layout. The promise
   * resolves once the runtime has taken the event — a closing aux window
   * awaits it before destroying itself, so the mutation cannot die with the
   * webview. */
  forwardMutation(mutation: LayoutMutation): Promise<void>;
  /** Main → all: the layout changed; here is the new blob. */
  broadcastLayout(layout: JsonValue): Promise<void>;
  /**
   * Main → all: the plugin pane bindings changed; here is the whole map
   * (plugin spec §4). One-directional by design — `plugin_panes_v1.json` has
   * the layout's single-writer discipline, so an aux window only ever adopts,
   * and there is deliberately no aux → main binding mutation.
   */
  broadcastPluginPanes(state: JsonValue): Promise<void>;
  onMutation(handler: (mutation: LayoutMutation) => void): () => void;
  onLayout(handler: (layout: JsonValue) => void): () => void;
  onPluginPanes(handler: (state: JsonValue) => void): () => void;
}

export const LAYOUT_MUTATION_EVENT = "termx:layout-mutation";
export const LAYOUT_STATE_EVENT = "termx:layout-state";
export const PLUGIN_PANES_EVENT = "termx:plugin-panes";

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
  } => {
    const handlers = new Set<(payload: unknown) => void>();
    let listening = false;
    return {
      send(payload) {
        // A failed emit means the receiving window is gone, and the next
        // broadcast carries the full truth anyway — never an error upstream.
        return transport.emit(event, payload).catch(() => undefined);
      },
      subscribe(handler) {
        handlers.add(handler);
        if (!listening) {
          listening = true;
          void transport
            .listen(event, ({ payload }) => {
              for (const registered of [...handlers]) {
                try {
                  registered(payload);
                } catch {
                  // One bad subscriber must not silence the others.
                }
              }
            })
            .catch(() => undefined);
        }
        return () => handlers.delete(handler);
      },
    };
  };
  const mutations = channel(LAYOUT_MUTATION_EVENT);
  const layouts = channel(LAYOUT_STATE_EVENT);
  const pluginPanes = channel(PLUGIN_PANES_EVENT);
  return {
    forwardMutation: (mutation) => mutations.send(mutation),
    broadcastLayout: (layout) => layouts.send(layout),
    broadcastPluginPanes: (state) => pluginPanes.send(state),
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
      layouts.subscribe((payload) => handler(payload as JsonValue)),
  };
}

/// In-process bus for tests and for a single-window run wired the same way.
/// Delivery is synchronous.
export function loopbackBus(): WindowBus {
  const mutationHandlers = new Set<(mutation: LayoutMutation) => void>();
  const layoutHandlers = new Set<(layout: JsonValue) => void>();
  const pluginPaneHandlers = new Set<(state: JsonValue) => void>();
  return {
    async forwardMutation(mutation) {
      for (const handler of [...mutationHandlers]) {
        try {
          handler(mutation);
        } catch {
          // One bad subscriber must not silence the others.
        }
      }
    },
    async broadcastLayout(layout) {
      for (const handler of [...layoutHandlers]) {
        try {
          handler(layout);
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
    onPluginPanes(handler) {
      pluginPaneHandlers.add(handler);
      return () => pluginPaneHandlers.delete(handler);
    },
  };
}
