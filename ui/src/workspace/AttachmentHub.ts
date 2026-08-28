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

/**
 * A burst of output at least this long, followed by quiet, means an agent
 * finished (or stopped for input) — the pane deserves an attention mark.
 * Short bursts (a `dir`, an echo of typing) never qualify: they were never
 * something the user walked away from.
 */
export const ATTENTION_MIN_BURST_MS = 5_000;

export interface HubSessionSnapshot {
  sessionId: number;
  hostAttached: boolean;
  terminalAttached: boolean;
  active: boolean;
  unread: boolean;
  /** A long output burst ended (or the terminal rang its bell): the agent in
   * this pane finished or is waiting — it needs a look. Sticky until
   * `markSeen` or the next burst. Optional so older fixtures type-check. */
  settled?: boolean;
  /** Wall-clock time the pane went quiet, so the rail can say how long ago it
   * finished rather than only that it did. Null whenever `settled` is false. */
  settledAt?: number | null;
  exited: boolean;
  exitCode: number | null;
  lostScrollback: boolean;
  attachError: string | null;
  /** The host connection is gone but this session is presumed ALIVE: the pane
   * shows a reconnecting chip and must never become a dead pane. */
  suspended: boolean;
  /**
   * Incremented every time this session is re-attached to a NEW socket. A
   * terminal binding is one-shot — its `onDisconnect` ends input for good — so
   * a bound pane has to build a fresh binding after a reconnect. This is the
   * signal it watches; it never moves while a connection holds.
   */
  attachGeneration: number;
  /**
   * The oldest offset this session's retained replay still covers. Greater than
   * zero means output has fallen out of what the pane holds and lives only in
   * the host's spill file — the cursor the history viewer pages backward from.
   */
  oldestOffset: bigint;
}

export interface AttachmentHubSnapshot {
  sessions: Readonly<Record<number, HubSessionSnapshot>>;
}

export type AttachmentHostClient = Pick<
  HostClient,
  "attach" | "onError" | "onSessionClosed"
> &
  // Optional so existing fixtures keep type-checking. Without it a resync
  // cannot tell a session that died while we were offline from one that is
  // still running, and re-attaches everything hopefully.
  Partial<Pick<HostClient, "getState">>;

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
  settled: boolean;
  /** When `settled` last turned true; null whenever it is false. */
  settledAt: number | null;
  /** This session's app has rung a real bell at least once — it announces
   * completion explicitly, so the burst-quiet guess would only ever add
   * false "finished" marks on top (Michael saw "Finished at 2:06" over a
   * still-thinking Claude). While a terminal is attached to parse bells,
   * bell-capable sessions settle on bells alone. */
  bellCapable: boolean;
  /** When the current output burst began; null while quiet. */
  burstStartedAt: number | null;
  exited: boolean;
  exitCode: number | null;
  lostRange: LostRange | null;
  attachError: string | null;
  suspended: boolean;
  attachGeneration: number;
  activityTimer: ReturnType<typeof setTimeout> | null;
  /** Last dimensions a terminal successfully pushed to the host — the dims a
   * sleeping pane's scrollback was produced at, so the dims a wake must
   * re-apply before its replay (spec §13). */
  lastDims: { cols: number; rows: number } | null;
  /** Output observers that own no terminal (ssh-sessions spec §2). */
  taps: Set<(text: string) => void>;
  /** Streaming decoder for the taps, created with the first one so a session
   *  nobody is watching pays nothing. */
  tapDecoder: TextDecoder | null;
}

export class AttachmentHub implements AttachmentClient {
  private readonly records = new Map<number, SessionRecord>();
  private readonly listeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private stopHostError: () => void = () => undefined;
  private stopHostClosed: () => void = () => undefined;
  private snapshot: AttachmentHubSnapshot = { sessions: {} };
  private closed = false;
  /** Bumped by every suspend, so an in-flight resync can tell that the world
   * moved on and stop issuing attaches into a dead socket. */
  private connectionEpoch = 0;

  constructor(private client: AttachmentHostClient) {
    this.bindClient(client);
  }

  private bindClient(client: AttachmentHostClient): void {
    invokeCleanup(this.stopHostError);
    invokeCleanup(this.stopHostClosed);
    this.client = client;
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

  /// Observe a session's decoded LIVE output without attaching a terminal
  /// (ssh-sessions spec §2: the password watcher). Multiple taps are allowed;
  /// dispose to stop. Unknown sessions get an inert handle rather than a throw —
  /// a watcher is armed around a session that may already be gone.
  ///
  /// Replayed scrollback is deliberately NOT delivered: a tap is a trigger for
  /// ACTION (typing a password), and history must never make something happen a
  /// second time. Text is decoded once per session and shared by every tap, so
  /// a multi-byte character split across two frames still arrives whole.
  tapOutput(
    sessionId: number,
    listener: (text: string) => void,
  ): { dispose(): void } {
    const record = this.records.get(sessionId);
    if (this.closed || !record) {
      return { dispose: () => undefined };
    }
    record.taps.add(listener);
    record.tapDecoder ??= new TextDecoder();
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        record.taps.delete(listener);
        if (record.taps.size === 0) {
          record.tapDecoder = null;
        }
      },
    };
  }

  /// The dimensions the session's pty last ran at, from the terminal's own
  /// resize calls — the recorded dims a wake must re-apply before replay
  /// (spec §13). Null until a terminal has resized the session, or when the
  /// session is unknown. Deliberately a getter, not a snapshot field: resizes
  /// are drag-frequent and must not churn subscribers.
  lastDims(sessionId: number): { cols: number; rows: number } | null {
    return this.records.get(sessionId)?.lastDims ?? null;
  }

  /// The host connection died. Records are KEPT, marked suspended, with their
  /// `nextOffset` cursors intact — the sessions are still running inside the
  /// daemon, only our socket is gone. Tearing them down here is what used to
  /// make every pane unusable until a restart.
  suspendAll(): void {
    if (this.closed) {
      return;
    }
    this.connectionEpoch += 1;
    let changed = false;
    for (const record of this.records.values()) {
      if (record.exited) {
        continue;
      }
      if (!record.suspended || record.physical !== null) {
        changed = true;
      }
      record.suspended = true;
      record.physical = null;
      record.attaching = null;
    }
    if (changed) {
      this.publish();
    }
  }

  /// A new connection is up: re-attach every suspended session from the cursor
  /// it left off at, SEQUENTIALLY (client.ts requires it — a failure among
  /// concurrent attaches is ambiguous and kills the connection), then re-apply
  /// the dims its scrollback was produced at. Sessions the daemon no longer has
  /// go down the ordinary exit path and become dead panes.
  async resync(client: AttachmentHostClient): Promise<void> {
    if (this.closed) {
      return;
    }
    this.bindClient(client);
    const epoch = this.connectionEpoch;
    const alive = await this.liveSessionIds(client);
    for (const record of [...this.records.values()]) {
      if (this.closed || this.connectionEpoch !== epoch) {
        return; // the replacement died too; suspendAll already reset the state
      }
      if (record.exited || this.records.get(record.sessionId) !== record) {
        continue;
      }
      if (alive && !alive.has(record.sessionId)) {
        record.suspended = false;
        this.markExited(record.sessionId, null);
        continue;
      }
      await this.reattach(record);
    }
    if (!this.closed && this.connectionEpoch === epoch) {
      this.publish();
    }
  }

  /// The sessions the daemon admits to having, or null when this client cannot
  /// say (older fixtures) — in which case every record is re-attached and a
  /// vanished session surfaces as an attach error instead.
  private async liveSessionIds(
    client: AttachmentHostClient,
  ): Promise<Set<number> | null> {
    if (!client.getState) {
      return null;
    }
    try {
      const state = await client.getState();
      return new Set(state.sessions.filter((s) => s.alive).map((s) => s.id));
    } catch {
      // A resync that cannot ask must not delete anything it is unsure about.
      return null;
    }
  }

  private async reattach(record: SessionRecord): Promise<void> {
    const epoch = this.connectionEpoch;
    const cursor = record.nextOffset;
    await this.attachPhysical(record, cursor ?? undefined);
    if (this.closed || this.connectionEpoch !== epoch || !record.physical) {
      return;
    }
    record.suspended = false;
    // Only now, with a proven attachment: this is what makes a bound pane throw
    // away its dead binding and build a new one, so a failed attach must not
    // move it or the pane rebinds into nothing.
    record.attachGeneration += 1;
    const dims = record.lastDims;
    if (dims) {
      // The pty must be back at the size its scrollback was rendered for before
      // the replayed bytes land, or the reflow is wrong.
      invokeCleanup(() => record.physical?.resize(dims.cols, dims.rows));
    }
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
      record.taps.clear();
      record.tapDecoder = null;
    }
    this.records.clear();
    this.listeners.clear();
    this.errorListeners.clear();
    this.snapshot = { sessions: {} };
  }

  private async attachPhysical(
    record: SessionRecord,
    sinceOffset?: bigint,
  ): Promise<void> {
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
        sinceOffset,
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
    this.feedTaps(record, event);
    if (event.source === "live" && event.data.byteLength > 0) {
      this.pulse(record);
    }
  }

  /// Decode once, hand the text to every tap. A tap that throws is contained
  /// like any other consumer — an output watcher must never break the session
  /// it is watching.
  private feedTaps(record: SessionRecord, event: SessionOutputEvent): void {
    const decoder = record.tapDecoder;
    if (decoder === null || record.taps.size === 0 || event.source !== "live") {
      return;
    }
    let text: string;
    try {
      text = decoder.decode(event.data, { stream: true });
    } catch {
      return;
    }
    if (text.length === 0) {
      return;
    }
    for (const tap of [...record.taps]) {
      invokeConsumer(tap, text);
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
    const changed =
      !record.active ||
      (!record.terminalCallbacks && !record.unread) ||
      record.settled;
    if (!record.active) {
      // A new burst begins: whatever settled before is superseded by fresh
      // work, and the burst clock starts now.
      record.burstStartedAt = Date.now();
      record.settled = false;
      record.settledAt = null;
    }
    record.active = true;
    if (!record.terminalCallbacks) {
      record.unread = true;
    }
    record.activityTimer = setTimeout(() => {
      record.activityTimer = null;
      if (!this.closed && this.records.get(record.sessionId) === record && record.active) {
        record.active = false;
        // The burst ran from its start to the last output (one pulse ago).
        // Long enough means an agent worked and stopped — mark it.
        const lastOutputAt = Date.now() - ACTIVITY_PULSE_MS;
        // A bell-capable session with a terminal attached settles on bells
        // alone — quiet is not done, the bell says when. The guess still
        // stands for panes ASLEEP (no xterm mounted, so a bell could not be
        // parsed) and for apps that never ring.
        const bellOwnsSettling =
          record.bellCapable && record.terminalCallbacks !== null;
        if (
          !bellOwnsSettling &&
          record.burstStartedAt !== null &&
          lastOutputAt - record.burstStartedAt >= ATTENTION_MIN_BURST_MS
        ) {
          record.settled = true;
          // Stamped with the last output, not with now: "done since" means
          // since the work stopped, which is one pulse before this fires.
          record.settledAt = lastOutputAt;
        }
        record.burstStartedAt = null;
        this.publish();
      }
    }, ACTIVITY_PULSE_MS);
    if (changed) {
      this.publish();
    }
  }

  /** The pane's terminal rang its bell — an explicit "look at me" (Claude
   * Code's terminal_bell notification, among others). Same mark as a settled
   * burst, delivered instantly. */
  noteBell(sessionId: number): void {
    const record = this.records.get(sessionId);
    if (!record) {
      return;
    }
    record.bellCapable = true;
    if (record.settled) {
      return;
    }
    record.settled = true;
    record.settledAt = Date.now();
    this.publish();
  }

  /** The user is looking at this pane (its tab active, window focused):
   * whatever attention it held is delivered. */
  markSeen(sessionId: number): void {
    const record = this.records.get(sessionId);
    if (!record || !record.settled) {
      return;
    }
    record.settled = false;
    record.settledAt = null;
    this.publish();
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
      settled: false,
      settledAt: null,
      bellCapable: false,
      burstStartedAt: null,
      unread: false,
      exited: false,
      exitCode: null,
      lostRange: null,
      attachError: null,
      suspended: false,
      attachGeneration: 0,
      activityTimer: null,
      lastDims: null,
      taps: new Set(),
      tapDecoder: null,
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
    record.taps.clear();
    record.tapDecoder = null;
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
        settled: record.settled,
        settledAt: record.settledAt,
        exited: record.exited,
        exitCode: record.exitCode,
        lostScrollback: record.lostRange !== null,
        attachError: record.attachError,
        suspended: record.suspended,
        attachGeneration: record.attachGeneration,
        oldestOffset: record.chunks[0]?.offset ?? 0n,
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
