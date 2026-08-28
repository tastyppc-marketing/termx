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
  /** Aux → main: apply this mutation to the shared layout. */
  forwardMutation(mutation: LayoutMutation): void;
  /** Main → all: the layout changed; here is the new blob. */
  broadcastLayout(layout: JsonValue): void;
  onMutation(handler: (mutation: LayoutMutation) => void): () => void;
  onLayout(handler: (layout: JsonValue) => void): () => void;
}

export const LAYOUT_MUTATION_EVENT = "termx:layout-mutation";
export const LAYOUT_STATE_EVENT = "termx:layout-state";

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
    send(payload: unknown): void;
    subscribe(handler: (payload: unknown) => void): () => void;
  } => {
    const handlers = new Set<(payload: unknown) => void>();
    let listening = false;
    return {
      send(payload) {
        // Fire-and-forget: a failed emit means the receiving window is gone,
        // and the next broadcast carries the full truth anyway.
        void transport.emit(event, payload).catch(() => undefined);
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
  return {
    forwardMutation: (mutation) => mutations.send(mutation),
    broadcastLayout: (layout) => layouts.send(layout),
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
  return {
    forwardMutation(mutation) {
      for (const handler of [...mutationHandlers]) {
        try {
          handler(mutation);
        } catch {
          // One bad subscriber must not silence the others.
        }
      }
    },
    broadcastLayout(layout) {
      for (const handler of [...layoutHandlers]) {
        try {
          handler(layout);
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
  };
}
