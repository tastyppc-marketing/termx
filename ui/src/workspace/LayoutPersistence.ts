import type { HostClient } from "../host/client";
import { serializeLayout, type Layout } from "../state/layout";

export const ACTIVE_TAB_PERSIST_DEBOUNCE_MS = 2_000;

/**
 * How long one layout write may go unanswered before it counts as failed.
 *
 * The host's request queue has no timeout of its own: a reply that never
 * arrives leaves the promise pending for as long as the socket stays open,
 * which on a live-but-stuck daemon is forever. Without a floor here, the write
 * in flight never settles, every later change queues behind it unwritten, the
 * indicator says "saving" for the rest of the session, and closing the window
 * loses the lot — which is exactly how a pane name typed after the stall
 * disappears with no error anywhere (Michael, 2026-09-15).
 *
 * Generous on purpose: this is a small atomic file write on the far side of a
 * loopback socket, so ten seconds is already far past "slow" and only ever
 * fires on a write that is not coming back. Nothing is cancelled — the write
 * may still land — and the retry is the same whole-layout blob, so a late
 * arrival and a retry cannot disagree about the result.
 */
export const LAYOUT_WRITE_TIMEOUT_MS = 10_000;

export type LayoutChangeKind = "structural" | "active_tab";

export interface LayoutPersistenceSnapshot {
  saving: boolean;
  error: string | null;
}

interface PendingWrite {
  layout: Layout;
  attempts: number;
}

export class LayoutPersistence {
  private readonly listeners = new Set<() => void>();
  private snapshot: LayoutPersistenceSnapshot = { saving: false, error: null };
  private pending: PendingWrite | null = null;
  // Retained for reconnect, but not runnable work: an offline flush must end.
  private failedLayout: Layout | null = null;
  private inFlight: Promise<void> | null = null;
  private recoveryGeneration = 0;
  private activeTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly writer: Pick<HostClient, "setLayout">) {}

  getSnapshot = (): LayoutPersistenceSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  record(layout: Layout, kind: LayoutChangeKind): void {
    if (this.disposed) {
      return;
    }
    this.pending = { layout, attempts: 0 };
    this.failedLayout = null;
    this.clearActiveTimer();
    if (kind === "active_tab") {
      this.activeTimer = setTimeout(() => {
        this.activeTimer = null;
        this.startPump();
      }, ACTIVE_TAB_PERSIST_DEBOUNCE_MS);
      return;
    }
    this.startPump();
  }

  async flush(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.clearActiveTimer();
    this.startPump();
    while (!this.disposed && (this.inFlight || this.pending)) {
      this.clearActiveTimer();
      this.startPump();
      const active = this.inFlight;
      if (active) {
        await active;
      }
    }
  }

  retry(): void {
    if (this.disposed) {
      return;
    }
    // A reconnect can precede the rejection from the retired connection.
    // Each signal permits one new bounded batch after that write settles.
    this.recoveryGeneration++;
    if (this.failedLayout !== null && !this.pending && !this.inFlight) {
      this.record(this.failedLayout, "structural");
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearActiveTimer();
    this.pending = null;
    this.failedLayout = null;
    this.listeners.clear();
  }

  private startPump(): void {
    if (this.disposed || this.inFlight || this.activeTimer || !this.pending) {
      return;
    }
    const current = this.pending;
    this.pending = null;
    const generation = this.recoveryGeneration;
    // Reserve ownership BEFORE notifying subscribers or calling the writer:
    // either can synchronously record a newer layout or dispose this instance.
    let complete!: () => void;
    this.inFlight = new Promise<void>((resolve) => { complete = resolve; });
    this.setSnapshot({ ...this.snapshot, saving: true });
    if (this.disposed) {
      this.inFlight = null;
      complete();
      return;
    }
    void this.runWrite(current, generation).then(complete, complete);
  }

  private async runWrite(current: PendingWrite, generation: number): Promise<void> {
    let failed = false;
    try {
      await this.writeWithDeadline(current.layout);
      if (this.disposed) return;
      this.setSnapshot({ saving: true, error: null });
    } catch {
      if (this.disposed) return;
      failed = true;
      if (this.pending === null && this.recoveryGeneration > generation) {
        this.pending = { layout: current.layout, attempts: 0 };
      } else if (current.attempts < 1 && this.pending === null) {
        this.pending = { ...current, attempts: current.attempts + 1 };
      } else if (current.attempts >= 1 && this.pending === null) {
        this.failedLayout = current.layout;
        this.setSnapshot({
          saving: true,
          error: "Unable to save the workspace layout.",
        });
      }
    } finally {
      this.inFlight = null;
      if (this.disposed) return;
      if (!this.disposed && this.pending && this.activeTimer === null) {
        this.startPump();
      }
      if (this.inFlight === null && this.pending === null) {
        this.setSnapshot({ ...this.snapshot, saving: false });
      } else if (failed && current.attempts >= 1) {
        this.setSnapshot({ ...this.snapshot, saving: this.inFlight !== null });
      }
    }
  }

  /**
   * One write, with a deadline under it.
   *
   * The underlying call is NOT cancelled when the deadline passes — there is
   * no way to un-send a request, and the daemon may still be writing the file.
   * It is only stopped being waited on, so the pump can move to the layout
   * that came after it instead of holding it hostage. A late reply is handled
   * either way, so neither outcome leaves an unhandled rejection behind.
   */
  private writeWithDeadline(layout: Layout): Promise<void> {
    const write = this.writer.setLayout(serializeLayout(layout));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("the host did not answer the layout write"));
      }, LAYOUT_WRITE_TIMEOUT_MS);
      write.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private clearActiveTimer(): void {
    if (this.activeTimer !== null) {
      clearTimeout(this.activeTimer);
      this.activeTimer = null;
    }
  }

  private setSnapshot(snapshot: LayoutPersistenceSnapshot): void {
    if (
      snapshot.saving === this.snapshot.saving &&
      snapshot.error === this.snapshot.error
    ) {
      return;
    }
    this.snapshot = snapshot;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Persistence ownership must not be broken by a React consumer.
      }
    }
  }
}
