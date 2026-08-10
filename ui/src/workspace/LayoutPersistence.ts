import type { HostClient } from "../host/client";
import { serializeLayout, type LayoutV2 } from "../state/layout";

export const ACTIVE_TAB_PERSIST_DEBOUNCE_MS = 2_000;

export type LayoutChangeKind = "structural" | "active_tab";

export interface LayoutPersistenceSnapshot {
  saving: boolean;
  error: string | null;
}

interface PendingWrite {
  layout: LayoutV2;
  attempts: number;
}

export class LayoutPersistence {
  private readonly listeners = new Set<() => void>();
  private snapshot: LayoutPersistenceSnapshot = { saving: false, error: null };
  private pending: PendingWrite | null = null;
  private inFlight: Promise<void> | null = null;
  private activeTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly writer: Pick<HostClient, "setLayout">) {}

  getSnapshot = (): LayoutPersistenceSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  record(layout: LayoutV2, kind: LayoutChangeKind): void {
    if (this.disposed) {
      return;
    }
    this.pending = { layout, attempts: 0 };
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
    while (this.inFlight || this.pending) {
      const active = this.inFlight;
      if (active) {
        await active;
      } else {
        this.startPump();
        await Promise.resolve();
      }
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearActiveTimer();
    this.pending = null;
    this.listeners.clear();
  }

  private startPump(): void {
    if (this.disposed || this.inFlight || this.activeTimer || !this.pending) {
      return;
    }
    const current = this.pending;
    this.pending = null;
    this.setSnapshot({ ...this.snapshot, saving: true });
    const running = this.runWrite(current);
    this.inFlight = running;
  }

  private async runWrite(current: PendingWrite): Promise<void> {
    let failed = false;
    try {
      await this.writer.setLayout(serializeLayout(current.layout));
      this.setSnapshot({ saving: true, error: null });
    } catch {
      failed = true;
      if (current.attempts < 1 && this.pending === null) {
        this.pending = { ...current, attempts: current.attempts + 1 };
      } else if (current.attempts >= 1) {
        this.setSnapshot({
          saving: true,
          error: "Unable to save the workspace layout.",
        });
      }
    } finally {
      this.inFlight = null;
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
