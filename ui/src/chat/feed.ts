/**
 * The renderer's half of the live transcript feed (chat-view spec §3).
 *
 * A feed opens a tail on one transcript, accumulates the entries it is handed,
 * and re-polls every 500 ms for as long as it is not disposed. Two rules:
 *
 * - **Polls never overlap.** The next tick is armed only once the previous
 *   answer has landed, so a slow read cannot pile up requests behind itself.
 * - **A failed poll is not a dead feed.** It flips the stale flag on and the
 *   retry is simply the next tick; the terminal underneath is unaffected, and
 *   a later success flips the flag back off (spec "Error handling").
 *
 * The chat never writes anything: the only commands issued here are open, poll
 * and close.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { ChatEntry, FeedWindow } from "./types";

/** Spec §3: poll cadence, and only while a chat view is mounted. */
export const CHAT_POLL_MS = 500;

/** The command surface; injected so tests drive it without a host. */
export type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** A one-shot timer returning its own canceller; injected for the same reason. */
export type ScheduleFn = (callback: () => void, delayMs: number) => () => void;

export interface ChatFeed {
  /** Everything the feed has been handed, oldest first. */
  readonly entries: readonly ChatEntry[];
  /** The last poll failed and the view is showing something out of date. */
  readonly stale: boolean;
  onUpdate(listener: () => void): () => void;
  onStale(listener: (stale: boolean) => void): () => void;
  /** Stop polling and release the feed's state in the host. */
  dispose(): void;
}

const defaultSchedule: ScheduleFn = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

/**
 * Open a tail on `path`. Rejects when the transcript cannot be opened — the
 * caller shows an unlinked/stale header rather than an empty chat pretending
 * to be a conversation.
 */
export async function openChatFeed(
  path: string,
  invoke: InvokeFn = tauriInvoke as InvokeFn,
  schedule: ScheduleFn = defaultSchedule,
): Promise<ChatFeed> {
  const opened = await invoke<FeedWindow>("chat_feed_open", { path });

  const entries: ChatEntry[] = [];
  /** id → index in `entries`, so a finished tool replaces its running self. */
  const positions = new Map<string, number>();
  const updateListeners = new Set<() => void>();
  const staleListeners = new Set<(stale: boolean) => void>();
  let stale = false;
  let disposed = false;
  let cancelTimer: (() => void) | null = null;

  const clear = () => {
    entries.length = 0;
    positions.clear();
  };

  /** Apply one window; returns whether anything actually moved. */
  const apply = (feedWindow: FeedWindow): boolean => {
    let changed = false;
    if (feedWindow.reset) {
      changed = entries.length > 0 || feedWindow.entries.length > 0;
      clear();
    }
    for (const entry of feedWindow.entries) {
      const existing = positions.get(entry.id);
      if (existing === undefined) {
        positions.set(entry.id, entries.length);
        entries.push(entry);
      } else {
        entries[existing] = entry;
      }
      changed = true;
    }
    return changed;
  };

  const setStale = (next: boolean) => {
    if (stale === next) {
      return;
    }
    stale = next;
    for (const listener of [...staleListeners]) {
      listener(next);
    }
  };

  const notifyUpdate = () => {
    for (const listener of [...updateListeners]) {
      listener();
    }
  };

  const arm = () => {
    if (disposed) {
      return;
    }
    cancelTimer = schedule(() => {
      cancelTimer = null;
      void tick();
    }, CHAT_POLL_MS);
  };

  const tick = async () => {
    if (disposed) {
      return;
    }
    try {
      const polled = await invoke<FeedWindow>("chat_feed_poll", {
        feedId: opened.feedId,
      });
      // The pane may have unmounted while the read was in flight; a disposed
      // feed must not resurrect itself or its timer.
      if (disposed) {
        return;
      }
      setStale(false);
      if (apply(polled)) {
        notifyUpdate();
      }
    } catch {
      if (disposed) {
        return;
      }
      setStale(true);
    }
    arm();
  };

  apply({ ...opened, reset: true });
  arm();

  return {
    get entries() {
      return entries;
    },
    get stale() {
      return stale;
    },
    onUpdate(listener) {
      updateListeners.add(listener);
      return () => {
        updateListeners.delete(listener);
      };
    },
    onStale(listener) {
      staleListeners.add(listener);
      return () => {
        staleListeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      cancelTimer?.();
      cancelTimer = null;
      updateListeners.clear();
      staleListeners.clear();
      // Best effort: a host that has already dropped the feed is exactly the
      // state we were asking for.
      void invoke("chat_feed_close", { feedId: opened.feedId }).catch(
        () => undefined,
      );
    },
  };
}
