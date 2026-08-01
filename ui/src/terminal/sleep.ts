/**
 * Terminal semi-sleep (spec §13).
 *
 * HARD INVARIANT: sleep is a RENDERER-side economy measure and nothing else.
 * Nothing in this module — or anything driven by it — stops, signals, closes,
 * or resizes a host session. The daemon keeps every PTY (and any agent running
 * in one) alive and untouched. Sleeping a pane only unmounts its
 * <TerminalPane>, which releases the xterm presentation and the LOGICAL
 * attachment through the pane's existing cleanup path; the AttachmentHub keeps
 * its physical attachment and keeps buffering output, so waking replays the
 * scrollback straight back into a fresh terminal.
 *
 * Second invariant: a VISIBLE pane never sleeps, whatever the clock says.
 *
 * `SleepTracker` is the pure state machine (injected clock, no timers, no
 * subscriptions). `SleepController` wraps it with the timer + subscription
 * seam the UI needs, and `useSleepingSessions` is the React binding used by
 * SplitLayout.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { DEFAULT_SETTINGS, type SleepOption } from "../settings/settings";

const MINUTE_MS = 60_000;

/** Idle milliseconds a hidden pane may accumulate before it sleeps. */
export const SLEEP_THRESHOLD_MS: Readonly<Record<SleepOption, number | null>> = {
  off: null,
  "5": 5 * MINUTE_MS,
  "15": 15 * MINUTE_MS,
  "60": 60 * MINUTE_MS,
};

/** Threshold for a setting value; null means "never sleep" (`off`). */
export function sleepThresholdMs(option: SleepOption): number | null {
  return SLEEP_THRESHOLD_MS[option] ?? null;
}

export interface SleepTrackerOptions {
  /** The `sleepHiddenTerminals` setting. Defaults to the settings default. */
  option?: SleepOption;
  /** Injected clock (ms). Defaults to Date.now; tests drive a fake. */
  now?: () => number;
}

interface PaneRecord {
  visible: boolean;
  /** When this pane last entered its current visibility state (or last woke). */
  since: number;
}

/**
 * Pure per-session visibility bookkeeping: who is on screen, who is hidden,
 * and for how long. No timers, no DOM, no host calls.
 */
export class SleepTracker {
  private readonly panes = new Map<number, PaneRecord>();
  private readonly clock: () => number;
  private option: SleepOption;

  constructor(options: SleepTrackerOptions = {}) {
    this.option = options.option ?? DEFAULT_SETTINGS.sleepHiddenTerminals;
    this.clock = options.now ?? (() => Date.now());
  }

  get sleepOption(): SleepOption {
    return this.option;
  }

  setOption(option: SleepOption): void {
    this.option = option;
  }

  /**
   * Declare whether these panes are on screen. Re-declaring the SAME
   * visibility is idempotent — the idle clock keeps running, so a re-render
   * can never postpone sleep indefinitely.
   */
  observe(sessionIds: Iterable<number>, visible: boolean): void {
    const now = this.clock();
    for (const sessionId of sessionIds) {
      const existing = this.panes.get(sessionId);
      if (existing && existing.visible === visible) {
        continue;
      }
      this.panes.set(sessionId, { visible, since: now });
    }
  }

  /**
   * Explicit wake (placeholder click): restart the idle clock without
   * claiming the pane became visible.
   */
  wake(sessionId: number): void {
    const existing = this.panes.get(sessionId);
    this.panes.set(sessionId, {
      visible: existing?.visible ?? false,
      since: this.clock(),
    });
  }

  /** Forget panes that no longer exist (closed, or their layout unmounted). */
  release(sessionIds: Iterable<number>): void {
    for (const sessionId of sessionIds) {
      this.panes.delete(sessionId);
    }
  }

  isSleeping(sessionId: number): boolean {
    const record = this.panes.get(sessionId);
    return record ? this.sleepingAt(record, this.clock()) : false;
  }

  /** Every session whose hidden idle time has crossed the threshold. */
  sleepingSessions(): ReadonlySet<number> {
    const now = this.clock();
    const sleeping = new Set<number>();
    for (const [sessionId, record] of this.panes) {
      if (this.sleepingAt(record, now)) {
        sleeping.add(sessionId);
      }
    }
    return sleeping;
  }

  /**
   * Milliseconds until the next awake hidden pane crosses the threshold, or
   * null when no pane ever will (setting `off`, or nothing hidden and awake).
   */
  msUntilNextSleep(): number | null {
    const threshold = sleepThresholdMs(this.option);
    if (threshold === null) {
      return null;
    }
    const now = this.clock();
    let soonest: number | null = null;
    for (const record of this.panes.values()) {
      if (record.visible) {
        continue;
      }
      const remaining = record.since + threshold - now;
      if (remaining <= 0) {
        continue;
      }
      if (soonest === null || remaining < soonest) {
        soonest = remaining;
      }
    }
    return soonest;
  }

  private sleepingAt(record: PaneRecord, now: number): boolean {
    const threshold = sleepThresholdMs(this.option);
    if (threshold === null || record.visible) {
      return false;
    }
    return now - record.since >= threshold;
  }
}

/** Timer seam: run `callback` after `delayMs`, returning a cancel function. */
export type SleepSchedule = (callback: () => void, delayMs: number) => () => void;

export interface SleepControllerOptions extends SleepTrackerOptions {
  /** Defaults to setTimeout/clearTimeout. */
  schedule?: SleepSchedule;
}

const NO_SLEEPING: ReadonlySet<number> = new Set<number>();

const defaultSchedule: SleepSchedule = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

/**
 * Observable sleep state for the whole window: a SleepTracker plus the timer
 * that re-evaluates it and the subscription the UI (and, later, the tab row's
 * "zZ" marker) reads. `getSnapshot` is useSyncExternalStore-safe: the returned
 * set identity only changes when membership actually changes.
 */
export class SleepController {
  private readonly tracker: SleepTracker;
  private readonly schedule: SleepSchedule;
  private readonly listeners = new Set<() => void>();
  private snapshot: ReadonlySet<number> = NO_SLEEPING;
  private cancelTimer: (() => void) | null = null;
  private disposed = false;

  constructor(options: SleepControllerOptions = {}) {
    this.tracker = new SleepTracker(options);
    this.schedule = options.schedule ?? defaultSchedule;
  }

  getSnapshot = (): ReadonlySet<number> => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Instant-apply of the `sleepHiddenTerminals` setting. */
  setOption(option: SleepOption): void {
    this.tracker.setOption(option);
    this.refresh();
  }

  get sleepOption(): SleepOption {
    return this.tracker.sleepOption;
  }

  observe(sessionIds: Iterable<number>, visible: boolean): void {
    this.tracker.observe(sessionIds, visible);
    this.refresh();
  }

  wake(sessionId: number): void {
    this.tracker.wake(sessionId);
    this.refresh();
  }

  release(sessionIds: Iterable<number>): void {
    this.tracker.release(sessionIds);
    this.refresh();
  }

  isSleeping(sessionId: number): boolean {
    return this.snapshot.has(sessionId);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelScheduled();
    this.listeners.clear();
    this.snapshot = NO_SLEEPING;
  }

  private refresh(): void {
    if (this.disposed) {
      return;
    }
    const next = this.tracker.sleepingSessions();
    const changed = !sameMembers(next, this.snapshot);
    if (changed) {
      this.snapshot = next;
    }
    this.rearm();
    if (!changed) {
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // One bad subscriber must never stop the others from updating.
      }
    }
  }

  private rearm(): void {
    this.cancelScheduled();
    const delay = this.tracker.msUntilNextSleep();
    if (delay === null) {
      return;
    }
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      this.refresh();
    }, Math.max(delay, 0));
  }

  private cancelScheduled(): void {
    const cancel = this.cancelTimer;
    this.cancelTimer = null;
    if (!cancel) {
      return;
    }
    try {
      cancel();
    } catch {
      // A failed cancel must not block re-arming or teardown.
    }
  }
}

function sameMembers(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

const INERT_STORE = {
  subscribe: () => () => undefined,
  getSnapshot: () => NO_SLEEPING,
};

/**
 * Reports this layout's panes to the controller and returns the set of
 * sleeping sessions. Without a controller the hook is inert (empty set), so a
 * caller that has not opted in never sleeps anything.
 */
export function useSleepingSessions(
  controller: SleepController | null | undefined,
  sessionIds: readonly number[],
  visible: boolean,
): ReadonlySet<number> {
  const key = sessionIds.join(",");
  // Stable per pane-set so an unrelated parent re-render never restarts the
  // idle clocks (the effect below re-runs on identity change).
  const panes = useMemo(() => [...sessionIds], [key]);

  useEffect(() => {
    if (!controller) {
      return;
    }
    controller.observe(panes, visible);
    return () => controller.release(panes);
  }, [controller, panes, visible]);

  const store = controller ?? INERT_STORE;
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
