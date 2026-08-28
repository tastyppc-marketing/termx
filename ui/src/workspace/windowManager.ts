import type { Layout, WindowBounds } from "../state/layout";
import { MAIN_WINDOW_ID, windowIds } from "../state/layout";

/// Aux-window lifecycle (multi-window spec): the MAIN window opens one OS
/// window per aux slot — at boot (adopt) and whenever a new slot appears
/// (move-to-new-window) — and each AUX window intercepts its own close to
/// return its items to main before destroying itself.

/** Opens OS windows; injected so tests never touch Tauri. */
export interface WindowFactory {
  /** True when a window with this id already exists (never open it twice). */
  isOpen(windowId: string): Promise<boolean>;
  open(windowId: string, bounds: WindowBounds | null): Promise<void>;
}

/// Open a window for every aux slot that does not already have one. Runs at
/// boot (a crash-left slot is indistinguishable from "not booted yet", which
/// is the correct default: re-open it) and again on every layout change that
/// added a slot. Failures are contained per window — one broken slot must not
/// stop the others from opening.
export async function openAuxWindows(
  layout: Layout,
  factory: WindowFactory,
): Promise<void> {
  for (const windowId of windowIds(layout)) {
    if (windowId === MAIN_WINDOW_ID) {
      continue;
    }
    try {
      if (await factory.isOpen(windowId)) {
        continue;
      }
      await factory.open(windowId, layout.auxWindows[windowId]?.bounds ?? null);
    } catch {
      // The slot survives in the layout; the next adopt pass tries again.
    }
  }
}

/// The real factory: one Tauri WebviewWindow per aux slot, loading the same
/// UI with `?window=<id>` so the new window bootstraps into its own slot.
/// Imported lazily so test environments without Tauri never touch it.
export function tauriWindowFactory(): WindowFactory {
  return {
    async isOpen(windowId) {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      return (await WebviewWindow.getByLabel(windowId)) !== null;
    },
    async open(windowId, bounds) {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      await new Promise<void>((resolve, reject) => {
        const spawned = new WebviewWindow(windowId, {
          url: `index.html?window=${encodeURIComponent(windowId)}`,
          title: "TermX",
          ...(bounds !== null
            ? {
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
              }
            : {}),
        });
        void spawned.once("tauri://created", () => resolve());
        void spawned.once("tauri://error", (event) =>
          reject(new Error(String(event.payload)))
        );
      });
    },
  };
}

/** The slice of the current OS window an aux lifecycle needs; injected so
 * tests never touch Tauri. Mirrors Tauri's Window API. */
export interface AuxWindowChrome {
  onCloseRequested(
    handler: (event: { preventDefault(): void }) => void,
  ): Promise<() => void>;
  onMoved(handler: () => void): Promise<() => void>;
  onResized(handler: () => void): Promise<() => void>;
  outerPosition(): Promise<{ x: number; y: number }>;
  outerSize(): Promise<{ width: number; height: number }>;
  destroy(): Promise<void>;
}

export interface AuxLifecycleController {
  returnWindowToMain(windowId: string): void;
  flush(): Promise<void>;
  recordWindowBounds(bounds: WindowBounds): void;
}

export const AUX_BOUNDS_DEBOUNCE_MS = 500;

/// Wire an AUX window's own lifecycle:
///  - close-requested: the items go home first (forwarded to main and
///    FLUSHED, so the mutation cannot die with this webview), then the
///    window destroys itself — never the app-level CloseGuard, and sessions
///    never notice (spec: close-returns-to-main).
///  - move/resize: debounced into the slot's recorded bounds for relaunch.
/// Returns a cleanup that unregisters everything.
export function manageAuxWindow(options: {
  windowId: string;
  controller: AuxLifecycleController;
  chrome: AuxWindowChrome;
  debounceMs?: number;
}): () => void {
  const { windowId, controller, chrome } = options;
  const debounceMs = options.debounceMs ?? AUX_BOUNDS_DEBOUNCE_MS;
  let disposed = false;
  let closing = false;
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const stops: Array<() => void> = [];

  const recordBounds = (): void => {
    if (boundsTimer !== null) {
      clearTimeout(boundsTimer);
    }
    boundsTimer = setTimeout(() => {
      boundsTimer = null;
      void (async () => {
        try {
          const [position, size] = await Promise.all([
            chrome.outerPosition(),
            chrome.outerSize(),
          ]);
          if (!disposed && !closing) {
            controller.recordWindowBounds({
              x: position.x,
              y: position.y,
              width: size.width,
              height: size.height,
            });
          }
        } catch {
          // The window is going away; its final bounds are already recorded.
        }
      })();
    }, debounceMs);
  };

  const register = async (): Promise<void> => {
    const registered = await Promise.all([
      chrome.onCloseRequested((event) => {
        if (closing) {
          return;
        }
        closing = true;
        event.preventDefault();
        void (async () => {
          try {
            controller.returnWindowToMain(windowId);
            await controller.flush();
          } finally {
            await chrome.destroy();
          }
        })();
      }),
      chrome.onMoved(recordBounds),
      chrome.onResized(recordBounds),
    ]);
    if (disposed) {
      for (const stop of registered) {
        stop();
      }
      return;
    }
    stops.push(...registered);
  };
  void register().catch(() => undefined);

  return () => {
    disposed = true;
    if (boundsTimer !== null) {
      clearTimeout(boundsTimer);
      boundsTimer = null;
    }
    for (const stop of stops.splice(0)) {
      try {
        stop();
      } catch {
        // The window is already gone.
      }
    }
  };
}
