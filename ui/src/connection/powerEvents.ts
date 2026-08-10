/**
 * Bridges the Tauri shell's power broadcasts (ui/src-tauri/src/power.rs) into
 * the reconnect machine.
 *
 * A socket that dies while the CPU sleeps is never noticed by a read loop, so
 * waiting for the transport to figure it out means waking up to a UI that
 * cannot open a terminal. Suspend tears the socket down on purpose; resume
 * reconnects at once instead of waiting out a backoff that ran while the
 * machine was frozen.
 */

export const POWER_SUSPEND_EVENT = "termx://power-suspend";
export const POWER_RESUME_EVENT = "termx://power-resume";

export interface PowerAwareConnection {
  notifySuspend(): void;
  notifyResume(): void;
}

/** Same shape as `@tauri-apps/api/event`'s `listen`, narrowed to what we use. */
export type PowerEventListen = (
  event: string,
  handler: () => void,
) => Promise<() => void>;

/**
 * Subscribe until the returned function is called. Outside Tauri (tests, a
 * plain browser) there is nothing to listen to, and the machine simply falls
 * back to its ordinary backoff.
 */
export function listenForPowerEvents(
  connection: PowerAwareConnection,
  listen: PowerEventListen,
): () => void {
  let stopped = false;
  const stops: Array<() => void> = [];

  const subscribe = (event: string, handler: () => void) => {
    listen(event, handler).then(
      (stop) => {
        if (stopped) {
          stop();
          return;
        }
        stops.push(stop);
      },
      () => {
        // No power events on this platform; backoff still covers the wake.
      },
    );
  };

  subscribe(POWER_SUSPEND_EVENT, () => connection.notifySuspend());
  subscribe(POWER_RESUME_EVENT, () => connection.notifyResume());

  return () => {
    stopped = true;
    for (const stop of stops.splice(0)) {
      try {
        stop();
      } catch {
        // Unsubscribing a listener the shell already dropped is not news.
      }
    }
  };
}
