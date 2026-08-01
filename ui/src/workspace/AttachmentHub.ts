import type {
  HostClient,
  SessionAttachment,
  SessionAttachmentCallbacks,
  SessionOutputEvent,
} from "../host/client";
import type { AttachmentClient } from "../terminal/TerminalSessionBinding";

export const ATTACHMENT_REPLAY_CAP_BYTES = 8 * 1024 * 1024;
export const ATTACHMENT_REPLAY_MAX_CHUNKS = 512;
export const ACTIVITY_PULSE_MS = 1_200;

export interface HubSessionSnapshot {
  sessionId: number;
  hostAttached: boolean;
  terminalAttached: boolean;
  active: boolean;
  unread: boolean;
  exited: boolean;
  exitCode: number | null;
  lostScrollback: boolean;
  attachError: string | null;
}

export interface AttachmentHubSnapshot {
  sessions: Readonly<Record<number, HubSessionSnapshot>>;
}

export type AttachmentHostClient = Pick<
  HostClient,
  "attach" | "onError" | "onSessionClosed"
>;

interface ReplayChunk {
  offset: bigint;
  data: Uint8Array;
}

interface LostRange {
  expectedOffset: bigint;
  receivedOffset: bigint;
}

interface SessionRecord {
  sessionId: number;
  physical: SessionAttachment | null;
  attaching: Promise<void> | null;
  terminalCallbacks: SessionAttachmentCallbacks | null;
  chunks: ReplayChunk[];
  replayBytes: number;
  nextOffset: bigint | null;
  active: boolean;
  unread: boolean;
  exited: boolean;
  exitCode: number | null;
  lostRange: LostRange | null;
  attachError: string | null;
  activityTimer: ReturnType<typeof setTimeout> | null;
  /** Last dimensions a terminal successfully pushed to the host — the dims a
   * sleeping pane's scrollback was produced at, so the dims a wake must
   * re-apply before its replay (spec §13). */
  lastDims: { cols: number; rows: number } | null;
}

export class AttachmentHub implements AttachmentClient {
  private readonly records = new Map<number, SessionRecord>();
  private readonly listeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly stopHostError: () => void;
  private readonly stopHostClosed: () => void;
  private snapshot: AttachmentHubSnapshot = { sessions: {} };
  private closed = false;

  constructor(private readonly client: AttachmentHostClient) {
    this.stopHostError = client.onError((error) => {
      for (const listener of [...this.errorListeners]) {
        invokeConsumer(listener, error);
      }
    });
    this.stopHostClosed = client.onSessionClosed(({ sessionId }) => {
      this.removeSession(sessionId, false);
    });
  }

  getSnapshot = (): AttachmentHubSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async attachAll(
    sessionIds: readonly number[],
    prioritySessionId: number | null = null,
  ): Promise<void> {
    this.assertOpen();
    const unique = [...new Set(sessionIds)];
    const ordered = prioritySessionId !== null && unique.includes(prioritySessionId)
      ? [prioritySessionId, ...unique.filter((id) => id !== prioritySessionId)]
      : unique;
    for (const sessionId of ordered) {
      await this.attachSession(sessionId);
    }
  }

  attachSession(sessionId: number): Promise<void> {
    this.assertOpen();
    const record = this.records.get(sessionId) ?? this.createRecord(sessionId);
    if (record.physical) {
      return Promise.resolve();
    }
    if (record.attaching) {
      return record.attaching;
    }

    record.attachError = null;
    const attaching = this.attachPhysical(record);
    record.attaching = attaching;
    return attaching;
  }

  markExited(sessionId: number, exitCode: number | null): void {
    const record = this.records.get(sessionId) ?? this.createRecord(sessionId);
    this.finishActivity(record);
    const changed = !record.exited || record.exitCode !== exitCode;
    record.exited = true;
    record.exitCode = exitCode;
    invokeConsumer(record.terminalCallbacks?.onExit, exitCode);
    if (changed) {
      this.publish();
    }
  }

  forgetSession(sessionId: number): void {
    this.removeSession(sessionId, true);
  }

  async attach(
    sessionId: number,
    callbacks: SessionAttachmentCallbacks = {},
    replay = true,
  ): Promise<SessionAttachment> {
    this.assertOpen();
    await this.attachSession(sessionId);
    const record = this.records.get(sessionId);
    if (!record?.physical) {
      throw new Error(record?.attachError ?? `Unable to attach session ${sessionId}`);
    }
    if (record.terminalCallbacks) {
      throw new Error(`Session ${sessionId} already has a terminal`);
    }

    record.terminalCallbacks = callbacks;
    record.unread = false;
    this.publish();

    if (record.lostRange) {
      invokeConsumer(callbacks.onLostScrollback, record.lostRange);
    }
    if (replay) {
      for (const chunk of record.chunks) {
        invokeConsumer(callbacks.onOutput, {
          offset: chunk.offset,
          data: chunk.data.slice(),
          source: "replay",
        });
      }
    }
    invokeConsumer(callbacks.onOutput, {
      offset: record.nextOffset ?? 0n,
      data: new Uint8Array(0),
      source: "live",
    });
    if (record.exited) {
      invokeConsumer(callbacks.onExit, record.exitCode);
    }

    let detached = false;
    const physical = record.physical;
    const handle: SessionAttachment = {
      sessionId,
      get nextOffset() {
        return record.nextOffset;
      },
      sendInput(data) {
        if (detached || record.terminalCallbacks !== callbacks) {
          throw new Error("Session attachment is detached");
        }
        physical.sendInput(data);
      },
      resize(cols, rows) {
        if (detached || record.terminalCallbacks !== callbacks) {
          throw new Error("Session attachment is detached");
        }
        physical.resize(cols, rows);
        record.lastDims = { cols, rows };
      },
      detach: () => {
        if (detached) {
          return;
        }
        detached = true;
        if (record.terminalCallbacks === callbacks) {
          record.terminalCallbacks = null;
          this.publish();
        }
      },
    };
    return handle;
  }

  /// Write into a session's host attachment without owning its terminal
  /// callbacks — `attach` refuses a second terminal, and the resume flow types
  /// into a tab whose xterm is already bound. Returns false when there is no
  /// live host attachment to write to, so the caller can say so out loud
  /// instead of dropping the input on the floor.
  sendInput(sessionId: number, data: string | Uint8Array): boolean {
    const record = this.records.get(sessionId);
    if (this.closed || !record?.physical) {
      return false;
    }
    try {
      record.physical.sendInput(data);
      return true;
    } catch {
      return false;
    }
  }

  /// The dimensions the session's pty last ran at, from the terminal's own
  /// resize calls — the recorded dims a wake must re-apply before replay
  /// (spec §13). Null until a terminal has resized the session, or when the
  /// session is unknown. Deliberately a getter, not a snapshot field: resizes
  /// are drag-frequent and must not churn subscribers.
  lastDims(sessionId: number): { cols: number; rows: number } | null {
    return this.records.get(sessionId)?.lastDims ?? null;
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    invokeCleanup(this.stopHostError);
    invokeCleanup(this.stopHostClosed);
    for (const record of this.records.values()) {
      this.clearActivityTimer(record);
      invokeConsumer(record.terminalCallbacks?.onDisconnect);
      invokeCleanup(() => record.physical?.detach());
      record.terminalCallbacks = null;
      record.physical = null;
    }
    this.records.clear();
    this.listeners.clear();
    this.errorListeners.clear();
    this.snapshot = { sessions: {} };
  }

  private async attachPhysical(record: SessionRecord): Promise<void> {
    try {
      let dead = false;
      const physical = await this.client.attach(
        record.sessionId,
        {
          onOutput: (event) => this.receiveOutput(record, event),
          onLostScrollback: (range) => {
            record.lostRange = range;
            invokeConsumer(record.terminalCallbacks?.onLostScrollback, range);
            this.publish();
          },
          onExit: (exitCode) => this.markExited(record.sessionId, exitCode),
          onDisconnect: () => {
            // The host-side attachment is gone. Record that even when no
            // terminal is bound (a sleeping pane), or the hub keeps
            // advertising a dead handle and a later wake reuses it instead
            // of re-attaching through attachSession.
            dead = true;
            if (this.closed || this.records.get(record.sessionId) !== record) {
              return;
            }
            record.physical = null;
            invokeConsumer(record.terminalCallbacks?.onDisconnect);
            this.publish();
          },
        },
        true,
      );
      if (this.closed || this.records.get(record.sessionId) !== record) {
        invokeCleanup(() => physical.detach());
        return;
      }
      record.physical = dead ? null : physical;
      record.nextOffset = physical.nextOffset;
      record.attachError = null;
    } catch (error) {
      record.attachError = safeErrorMessage(error);
    } finally {
      record.attaching = null;
      if (!this.closed && this.records.get(record.sessionId) === record) {
        this.publish();
      }
    }
  }

  private receiveOutput(record: SessionRecord, event: SessionOutputEvent): void {
    if (this.closed || this.records.get(record.sessionId) !== record) {
      return;
    }
    if (event.data.byteLength > 0) {
      this.retain(record, event.offset, event.data);
      record.nextOffset = event.offset + BigInt(event.data.byteLength);
    } else if (record.nextOffset === null) {
      record.nextOffset = event.offset;
    }

    invokeConsumer(record.terminalCallbacks?.onOutput, event);
    if (event.source === "live" && event.data.byteLength > 0) {
      this.pulse(record);
    }
  }

  private retain(record: SessionRecord, offset: bigint, data: Uint8Array): void {
    let retainedOffset = offset;
    let retainedData = data.slice();
    if (retainedData.byteLength > ATTACHMENT_REPLAY_CAP_BYTES) {
      const skipped = retainedData.byteLength - ATTACHMENT_REPLAY_CAP_BYTES;
      retainedOffset += BigInt(skipped);
      retainedData = retainedData.slice(skipped);
      this.noteEviction(record, offset, retainedOffset);
    }

    record.chunks.push({ offset: retainedOffset, data: retainedData });
    record.replayBytes += retainedData.byteLength;
    while (
      record.chunks.length > ATTACHMENT_REPLAY_MAX_CHUNKS ||
      record.replayBytes > ATTACHMENT_REPLAY_CAP_BYTES
    ) {
      const removed = record.chunks.shift();
      if (!removed) {
        break;
      }
      record.replayBytes -= removed.data.byteLength;
      const receivedOffset = record.chunks[0]?.offset
        ?? removed.offset + BigInt(removed.data.byteLength);
      this.noteEviction(record, removed.offset, receivedOffset);
    }
  }

  private noteEviction(
    record: SessionRecord,
    expectedOffset: bigint,
    receivedOffset: bigint,
  ): void {
    record.lostRange = {
      expectedOffset: record.lostRange?.expectedOffset ?? expectedOffset,
      receivedOffset,
    };
  }

  private pulse(record: SessionRecord): void {
    this.clearActivityTimer(record);
    const changed = !record.active || (!record.terminalCallbacks && !record.unread);
    record.active = true;
    if (!record.terminalCallbacks) {
      record.unread = true;
    }
    record.activityTimer = setTimeout(() => {
      record.activityTimer = null;
      if (!this.closed && this.records.get(record.sessionId) === record && record.active) {
        record.active = false;
        this.publish();
      }
    }, ACTIVITY_PULSE_MS);
    if (changed) {
      this.publish();
    }
  }

  private finishActivity(record: SessionRecord): void {
    this.clearActivityTimer(record);
    record.active = false;
  }

  private clearActivityTimer(record: SessionRecord): void {
    if (record.activityTimer !== null) {
      clearTimeout(record.activityTimer);
      record.activityTimer = null;
    }
  }

  private createRecord(sessionId: number): SessionRecord {
    const record: SessionRecord = {
      sessionId,
      physical: null,
      attaching: null,
      terminalCallbacks: null,
      chunks: [],
      replayBytes: 0,
      nextOffset: null,
      active: false,
      unread: false,
      exited: false,
      exitCode: null,
      lostRange: null,
      attachError: null,
      activityTimer: null,
      lastDims: null,
    };
    this.records.set(sessionId, record);
    this.publish();
    return record;
  }

  private removeSession(sessionId: number, detachPhysical: boolean): void {
    const record = this.records.get(sessionId);
    if (!record) {
      return;
    }
    this.records.delete(sessionId);
    this.clearActivityTimer(record);
    invokeConsumer(record.terminalCallbacks?.onDisconnect);
    record.terminalCallbacks = null;
    if (detachPhysical) {
      invokeCleanup(() => record.physical?.detach());
    }
    record.physical = null;
    this.publish();
  }

  private publish(): void {
    const sessions: Record<number, HubSessionSnapshot> = {};
    for (const [sessionId, record] of this.records) {
      sessions[sessionId] = {
        sessionId,
        hostAttached: record.physical !== null,
        terminalAttached: record.terminalCallbacks !== null,
        active: record.active,
        unread: record.unread,
        exited: record.exited,
        exitCode: record.exitCode,
        lostScrollback: record.lostRange !== null,
        attachError: record.attachError,
      };
    }
    this.snapshot = { sessions };
    for (const listener of [...this.listeners]) {
      invokeConsumer(listener);
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Attachment hub is closed");
    }
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to attach to the host session";
}

function invokeConsumer<T>(listener: ((value: T) => void) | undefined, value: T): void;
function invokeConsumer(listener: (() => void) | undefined): void;
function invokeConsumer<T>(listener: ((value: T) => void) | (() => void) | undefined, value?: T): void {
  try {
    if (value === undefined) {
      (listener as (() => void) | undefined)?.();
    } else {
      (listener as ((argument: T) => void) | undefined)?.(value);
    }
  } catch {
    // Consumer failures must not break transport ownership or other subscribers.
  }
}

function invokeCleanup(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // Cleanup is best-effort; ownership is cleared locally regardless.
  }
}
