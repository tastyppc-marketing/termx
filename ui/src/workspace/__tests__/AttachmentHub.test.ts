import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SessionAttachment,
  SessionAttachmentCallbacks,
  SessionOutputEvent,
} from "../../host/client";
import {
  ACTIVITY_PULSE_MS,
  ATTACHMENT_REPLAY_CAP_BYTES,
  ATTACHMENT_REPLAY_MAX_CHUNKS,
  ATTENTION_MIN_BURST_MS,
  AttachmentHub,
  type AttachmentHostClient,
} from "../AttachmentHub";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface PhysicalRecord {
  callbacks: SessionAttachmentCallbacks;
  handle: SessionAttachment;
  detach: ReturnType<typeof vi.fn>;
  sendInput: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
}

interface FakeHost extends AttachmentHostClient {
  attachCalls: number[];
  /** Every attach with the resume cursor it carried, for resync assertions. */
  attachArgs: Array<{ sessionId: number; sinceOffset: bigint | undefined }>;
  pending: Map<number, Deferred<SessionAttachment>>;
  physical: Map<number, PhysicalRecord>;
  /** Sessions the daemon admits to having, for getState during a resync. */
  liveSessions: Set<number>;
  emitError(error: Error): void;
  emitClosed(sessionId: number): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createFakeHost(): FakeHost {
  const errorListeners = new Set<(error: Error) => void>();
  const closeListeners = new Set<(event: { sessionId: number }) => void>();
  const attachCalls: number[] = [];
  const attachArgs: Array<{ sessionId: number; sinceOffset: bigint | undefined }> = [];
  const pending = new Map<number, Deferred<SessionAttachment>>();
  const physical = new Map<number, PhysicalRecord>();
  const liveSessions = new Set<number>();

  return {
    attachCalls,
    attachArgs,
    pending,
    physical,
    liveSessions,
    getState() {
      return Promise.resolve({
        layout: null,
        sessions: [...liveSessions].map((id) => ({
          id,
          profile: "cmd",
          cwd: null,
          cols: 80,
          rows: 25,
          alive: true,
          pid: null,
        })),
      });
    },
    attach(sessionId, callbacks = {}, _replay = true, sinceOffset?: bigint) {
      attachCalls.push(sessionId);
      attachArgs.push({ sessionId, sinceOffset });
      liveSessions.add(sessionId);
      const next = deferred<SessionAttachment>();
      const detach = vi.fn();
      const sendInput = vi.fn();
      const resize = vi.fn();
      let nextOffset: bigint | null = 0n;
      const handle: SessionAttachment = {
        sessionId,
        get nextOffset() {
          return nextOffset;
        },
        sendInput,
        resize,
        detach,
      };
      Object.defineProperty(handle, "__setNextOffset", {
        value: (value: bigint) => {
          nextOffset = value;
        },
      });
      pending.set(sessionId, next);
      physical.set(sessionId, { callbacks, handle, detach, sendInput, resize });
      return next.promise;
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    onSessionClosed(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    emitError(error) {
      for (const listener of errorListeners) {
        listener(error);
      }
    },
    emitClosed(sessionId) {
      for (const listener of closeListeners) {
        listener({ sessionId });
      }
    },
  };
}

function resolvePhysical(host: FakeHost, sessionId: number): void {
  host.pending.get(sessionId)!.resolve(host.physical.get(sessionId)!.handle);
}

function emitOutput(
  host: FakeHost,
  sessionId: number,
  event: SessionOutputEvent,
): void {
  const record = host.physical.get(sessionId)!;
  const setNextOffset = Reflect.get(record.handle, "__setNextOffset") as (value: bigint) => void;
  setNextOffset(event.offset + BigInt(event.data.byteLength));
  record.callbacks.onOutput?.(event);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AttachmentHub physical lifecycle", () => {
  it("awaits priority-first physical attaches sequentially", async () => {
    const host = createFakeHost();
    const hub = new AttachmentHub(host);

    const attaching = hub.attachAll([7, 8, 9], 8);
    expect(host.attachCalls).toEqual([8]);

    resolvePhysical(host, 8);
    await flushMicrotasks();
    expect(host.attachCalls).toEqual([8, 7]);

    resolvePhysical(host, 7);
    await flushMicrotasks();
    expect(host.attachCalls).toEqual([8, 7, 9]);

    resolvePhysical(host, 9);
    await attaching;
    expect(Object.keys(hub.getSnapshot().sessions)).toEqual(["7", "8", "9"]);
  });

  it("records one attach failure and continues with remaining sessions", async () => {
    const host = createFakeHost();
    const hub = new AttachmentHub(host);

    const attaching = hub.attachAll([1, 2]);
    host.pending.get(1)!.reject(new Error("first failed"));
    await flushMicrotasks();
    expect(host.attachCalls).toEqual([1, 2]);
    resolvePhysical(host, 2);
    await attaching;

    expect(hub.getSnapshot().sessions[1]?.attachError).toBe("first failed");
    expect(hub.getSnapshot().sessions[2]?.hostAttached).toBe(true);
  });

  it("deduplicates input ids and ignores a priority outside the requested set", async () => {
    const host = createFakeHost();
    const hub = new AttachmentHub(host);

    const attaching = hub.attachAll([4, 4], 99);
    expect(host.attachCalls).toEqual([4]);
    resolvePhysical(host, 4);
    await attaching;
  });

  it("proxies host errors, removes closed sessions, and closes idempotently", async () => {
    const host = createFakeHost();
    const hub = new AttachmentHub(host);
    const onError = vi.fn();
    hub.onError(onError);

    const attaching = hub.attachAll([3]);
    resolvePhysical(host, 3);
    await attaching;
    host.emitError(new Error("socket failed"));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "socket failed" }));

    host.emitClosed(3);
    expect(hub.getSnapshot().sessions[3]).toBeUndefined();

    hub.close();
    hub.close();
    expect(host.physical.get(3)!.detach).toHaveBeenCalledTimes(0);
  });
});

describe("AttachmentHub virtual attachments", () => {
  it("replays retained output, emits a zero-byte live boundary, and forwards controls", async () => {
    const host = createFakeHost();
    const hub = new AttachmentHub(host);
    const attaching = hub.attachAll([12]);
    emitOutput(host, 12, {
      offset: 0n,
      data: new Uint8Array([65, 66]),
      source: "replay",
    });
    resolvePhysical(host, 12);
    await attaching;

    const onOutput = vi.fn();
    const virtual = await hub.attach(12, { onOutput });

    expect(onOutput).toHaveBeenNthCalledWith(1, {
      offset: 0n,
      data: new Uint8Array([65, 66]),
      source: "replay",
    });
    expect(onOutput).toHaveBeenNthCalledWith(2, {
      offset: 2n,
      data: new Uint8Array(0),
      source: "live",
    });

    virtual.sendInput("dir\r");
    virtual.resize(100, 30);
    expect(host.physical.get(12)!.sendInput).toHaveBeenCalledWith("dir\r");
    expect(host.physical.get(12)!.resize).toHaveBeenCalledWith(100, 30);

    virtual.detach();
    expect(host.physical.get(12)!.detach).not.toHaveBeenCalled();
  });

  it("rejects a second virtual subscriber until the first detaches", async () => {
    const host = createFakeHost();
    const hub = new AttachmentHub(host);
    const attaching = hub.attachAll([5]);
    resolvePhysical(host, 5);
    await attaching;

    const first = await hub.attach(5);
    await expect(hub.attach(5)).rejects.toThrow("already has a terminal");
    first.detach();
    await expect(hub.attach(5)).resolves.toEqual(expect.objectContaining({ sessionId: 5 }));
  });

  it("tracks unread activity while inactive and clears it when activated", async () => {
    vi.useFakeTimers();
    const host = createFakeHost();
    const hub = new AttachmentHub(host);
    const attaching = hub.attachAll([6]);
    resolvePhysical(host, 6);
    await attaching;

    emitOutput(host, 6, {
      offset: 0n,
      data: new Uint8Array([1]),
      source: "live",
    });
    expect(hub.getSnapshot().sessions[6]).toMatchObject({ active: true, unread: true });

    const virtual = await hub.attach(6);
    expect(hub.getSnapshot().sessions[6]?.unread).toBe(false);
    vi.advanceTimersByTime(ACTIVITY_PULSE_MS);
    expect(hub.getSnapshot().sessions[6]?.active).toBe(false);
    virtual.detach();
  });

  it("replays exit and lost-scrollback state to late subscribers", async () => {
    const host = createFakeHost();
    const hub = new AttachmentHub(host);
    const attaching = hub.attachAll([10]);
    host.physical.get(10)!.callbacks.onLostScrollback?.({
      expectedOffset: 4n,
      receivedOffset: 20n,
    });
    host.physical.get(10)!.callbacks.onExit?.(17);
    resolvePhysical(host, 10);
    await attaching;

    const onLostScrollback = vi.fn();
    const onExit = vi.fn();
    await hub.attach(10, { onLostScrollback, onExit });
    expect(onLostScrollback).toHaveBeenCalledWith({
      expectedOffset: 4n,
      receivedOffset: 20n,
    });
    expect(onExit).toHaveBeenCalledWith(17);
  });

  it("detaches every live physical handle and clears timers on close", async () => {
    vi.useFakeTimers();
    const host = createFakeHost();
    const hub = new AttachmentHub(host);
    const attaching = hub.attachAll([1, 2]);
    resolvePhysical(host, 1);
    await flushMicrotasks();
    resolvePhysical(host, 2);
    await attaching;
    emitOutput(host, 1, { offset: 0n, data: new Uint8Array([1]), source: "live" });

    hub.close();
    expect(host.physical.get(1)!.detach).toHaveBeenCalledTimes(1);
    expect(host.physical.get(2)!.detach).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("AttachmentHub replay bounds", () => {
  it("evicts oldest complete chunks at the chunk cap", async () => {
    const host = createFakeHost();
    const hub = new AttachmentHub(host);
    const attaching = hub.attachAll([30]);
    for (let index = 0; index <= ATTACHMENT_REPLAY_MAX_CHUNKS; index += 1) {
      emitOutput(host, 30, {
        offset: BigInt(index),
        data: new Uint8Array([index & 0xff]),
        source: "replay",
      });
    }
    resolvePhysical(host, 30);
    await attaching;

    const onOutput = vi.fn();
    const onLostScrollback = vi.fn();
    await hub.attach(30, { onOutput, onLostScrollback });
    const replayEvents = onOutput.mock.calls
      .map(([event]) => event as SessionOutputEvent)
      .filter((event) => event.source === "replay");
    expect(replayEvents).toHaveLength(ATTACHMENT_REPLAY_MAX_CHUNKS);
    expect(replayEvents[0]?.offset).toBe(1n);
    expect(onLostScrollback).toHaveBeenCalled();
    // Everything below this offset is only on disk now — the cursor the
    // earlier-output bar pages backward from.
    expect(hub.getSnapshot().sessions[30]!.oldestOffset).toBe(1n);
  });

  it("reports no earlier output for a session that has lost nothing", async () => {
    const host = createFakeHost();
    const hub = new AttachmentHub(host);
    const attaching = hub.attachAll([32]);
    emitOutput(host, 32, {
      offset: 0n,
      data: new Uint8Array([1, 2, 3]),
      source: "replay",
    });
    resolvePhysical(host, 32);
    await attaching;

    expect(hub.getSnapshot().sessions[32]!.oldestOffset).toBe(0n);
  });

  it("evicts an oversized byte history down to the approved cap", async () => {
    const host = createFakeHost();
    const hub = new AttachmentHub(host);
    const attaching = hub.attachAll([31]);
    const firstSize = ATTACHMENT_REPLAY_CAP_BYTES - 1;
    emitOutput(host, 31, {
      offset: 0n,
      data: new Uint8Array(firstSize),
      source: "replay",
    });
    emitOutput(host, 31, {
      offset: BigInt(firstSize),
      data: new Uint8Array(2),
      source: "replay",
    });
    resolvePhysical(host, 31);
    await attaching;

    const onOutput = vi.fn();
    await hub.attach(31, { onOutput });
    const replayEvents = onOutput.mock.calls
      .map(([event]) => event as SessionOutputEvent)
      .filter((event) => event.source === "replay");
    expect(replayEvents).toHaveLength(1);
    expect(replayEvents[0]?.data).toHaveLength(2);
  });
});

describe("AttachmentHub disconnect and recorded dims", () => {
  it("marks the host attachment gone on disconnect with no terminal bound, and re-attaches on wake", async () => {
    const host = createFakeHost();
    const hub = new AttachmentHub(host);
    const attaching = hub.attachAll([5]);
    resolvePhysical(host, 5);
    await attaching;
    expect(hub.getSnapshot().sessions[5]?.hostAttached).toBe(true);

    // A sleeping pane holds no terminal callbacks when the host side dies;
    // the hub must not keep advertising the dead handle.
    host.physical.get(5)!.callbacks.onDisconnect?.();
    expect(hub.getSnapshot().sessions[5]?.hostAttached).toBe(false);

    // The wake re-attaches through the client instead of reusing the handle.
    const waking = hub.attach(5);
    await flushMicrotasks();
    resolvePhysical(host, 5);
    const handle = await waking;
    expect(host.attachCalls).toEqual([5, 5]);
    expect(handle.sessionId).toBe(5);
  });

  it("still forwards a disconnect to a bound terminal and drops the handle", async () => {
    const host = createFakeHost();
    const hub = new AttachmentHub(host);
    const attaching = hub.attachAll([6]);
    resolvePhysical(host, 6);
    await attaching;
    const onDisconnect = vi.fn();
    await hub.attach(6, { onDisconnect });

    host.physical.get(6)!.callbacks.onDisconnect?.();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(hub.getSnapshot().sessions[6]?.hostAttached).toBe(false);
  });

  it("records the last resize dims per session, surviving terminal detach", async () => {
    const host = createFakeHost();
    const hub = new AttachmentHub(host);
    const attaching = hub.attachAll([5]);
    resolvePhysical(host, 5);
    await attaching;
    expect(hub.lastDims(5)).toBeNull();
    expect(hub.lastDims(99)).toBeNull();

    const handle = await hub.attach(5);
    handle.resize(140, 42);
    expect(hub.lastDims(5)).toEqual({ cols: 140, rows: 42 });

    // Sleep detaches the terminal; the recorded dims survive for the wake.
    handle.detach();
    expect(hub.lastDims(5)).toEqual({ cols: 140, rows: 42 });
  });
});

describe("AttachmentHub reconnect resync", () => {
  async function hubWithSessions(sessionIds: readonly number[]) {
    const host = createFakeHost();
    const hub = new AttachmentHub(host);
    const attaching = hub.attachAll(sessionIds);
    for (const sessionId of sessionIds) {
      resolvePhysical(host, sessionId);
      await flushMicrotasks();
    }
    await attaching;
    return { host, hub };
  }

  it("suspends every live record instead of forgetting it", async () => {
    const { host, hub } = await hubWithSessions([5, 6]);
    emitOutput(host, 5, { offset: 0n, data: new Uint8Array([1, 2, 3]), source: "live" });
    const notified = vi.fn();
    hub.subscribe(notified);

    hub.suspendAll();

    const snapshot = hub.getSnapshot();
    expect(snapshot.sessions[5]).toMatchObject({ suspended: true, hostAttached: false });
    expect(snapshot.sessions[6]).toMatchObject({ suspended: true, hostAttached: false });
    expect(notified).toHaveBeenCalled();
  });

  it("re-attaches sequentially from each session's own cursor and restores dims", async () => {
    const { host, hub } = await hubWithSessions([5, 6]);
    emitOutput(host, 5, { offset: 0n, data: new Uint8Array(64), source: "live" });
    emitOutput(host, 6, { offset: 0n, data: new Uint8Array(10), source: "live" });
    const handle = await hub.attach(6);
    handle.resize(120, 40);
    host.attachCalls.length = 0;
    host.attachArgs.length = 0;

    hub.suspendAll();
    const resyncing = hub.resync(host);
    await flushMicrotasks();

    // Sequential: the second attach must not be issued until the first lands.
    expect(host.attachCalls).toEqual([5]);
    resolvePhysical(host, 5);
    await flushMicrotasks();
    expect(host.attachCalls).toEqual([5, 6]);
    resolvePhysical(host, 6);
    await resyncing;

    expect(host.attachArgs).toEqual([
      { sessionId: 5, sinceOffset: 64n },
      { sessionId: 6, sinceOffset: 10n },
    ]);
    expect(host.physical.get(6)!.resize).toHaveBeenCalledWith(120, 40);
    expect(host.physical.get(5)!.resize).not.toHaveBeenCalled();
    expect(hub.getSnapshot().sessions[5]).toMatchObject({
      suspended: false,
      hostAttached: true,
    });
  });

  it("turns a session the daemon no longer has into a dead pane", async () => {
    const { host, hub } = await hubWithSessions([5, 6]);
    const exits: Array<number | null> = [];
    const handle = await hub.attach(5, { onExit: (code) => exits.push(code) });
    expect(handle.sessionId).toBe(5);
    host.liveSessions.delete(5);
    host.attachCalls.length = 0;

    hub.suspendAll();
    const resyncing = hub.resync(host);
    await flushMicrotasks();
    resolvePhysical(host, 6);
    await resyncing;

    expect(host.attachCalls).toEqual([6]);
    expect(exits).toEqual([null]);
    expect(hub.getSnapshot().sessions[5]).toMatchObject({
      exited: true,
      suspended: false,
    });
  });

  it("leaves a consistent suspended state when the socket dies mid-resync", async () => {
    const { host, hub } = await hubWithSessions([5, 6]);
    host.attachCalls.length = 0;

    hub.suspendAll();
    const resyncing = hub.resync(host);
    await flushMicrotasks();
    expect(host.attachCalls).toEqual([5]);

    // The replacement connection dies while session 5's attach is in flight.
    host.pending.get(5)!.reject(new Error("Host connection closed"));
    hub.suspendAll();
    await resyncing;

    // No attach may be issued into a socket that has already died.
    expect(host.attachCalls).toEqual([5]);
    const snapshot = hub.getSnapshot();
    expect(snapshot.sessions[5]).toMatchObject({ suspended: true, hostAttached: false });
    expect(snapshot.sessions[6]).toMatchObject({ suspended: true, hostAttached: false });
  });

  it("routes errors and closes through the replacement connection", async () => {
    const { hub } = await hubWithSessions([5]);
    const replacement = createFakeHost();
    replacement.liveSessions.add(5); // the daemon still has it; only our socket changed
    const errors: Error[] = [];
    hub.onError((error) => errors.push(error));

    hub.suspendAll();
    const resyncing = hub.resync(replacement);
    await flushMicrotasks();
    resolvePhysical(replacement, 5);
    await resyncing;

    replacement.emitError(new Error("from the new socket"));
    expect(errors.map((error) => error.message)).toEqual(["from the new socket"]);

    replacement.emitClosed(5);
    expect(hub.getSnapshot().sessions[5]).toBeUndefined();
  });

  it("does nothing on a closed hub", async () => {
    const { host, hub } = await hubWithSessions([5]);
    hub.close();

    hub.suspendAll();
    await hub.resync(host);

    expect(hub.getSnapshot().sessions).toEqual({});
  });

  it("bumps the attach generation so bound terminals know to rebind", async () => {
    const { host, hub } = await hubWithSessions([5]);
    expect(hub.getSnapshot().sessions[5]!.attachGeneration).toBe(0);

    hub.suspendAll();
    const resyncing = hub.resync(host);
    await flushMicrotasks();
    resolvePhysical(host, 5);
    await resyncing;

    expect(hub.getSnapshot().sessions[5]!.attachGeneration).toBe(1);
  });

  it("does not bump the generation for a resync that never re-attached", async () => {
    const { host, hub } = await hubWithSessions([5]);

    hub.suspendAll();
    const resyncing = hub.resync(host);
    await flushMicrotasks();
    host.pending.get(5)!.reject(new Error("Host connection closed"));
    await resyncing;

    expect(hub.getSnapshot().sessions[5]!.attachGeneration).toBe(0);
  });
});

/**
 * The output tap (ssh-sessions spec §2): a way to WATCH a session's live
 * output without owning its terminal, which is what the ssh password watcher
 * needs — `attach` refuses a second terminal, and the pane already holds the
 * one there is.
 */
describe("AttachmentHub output taps", () => {
  async function hubWithSession(sessionId: number) {
    const host = createFakeHost();
    const hub = new AttachmentHub(host);
    const attaching = hub.attachAll([sessionId]);
    resolvePhysical(host, sessionId);
    await attaching;
    return { host, hub };
  }

  function bytes(text: string): Uint8Array {
    return new TextEncoder().encode(text);
  }

  it("hands a tap the decoded live output and stops on dispose", async () => {
    const { host, hub } = await hubWithSession(21);
    const seen: string[] = [];

    const tap = hub.tapOutput(21, (text) => seen.push(text));
    emitOutput(host, 21, {
      offset: 0n,
      data: bytes("root@vps's password: "),
      source: "live",
    });
    tap.dispose();
    emitOutput(host, 21, { offset: 40n, data: bytes("after"), source: "live" });

    expect(seen).toEqual(["root@vps's password: "]);
    hub.close();
  });

  it("never hands a tap replayed scrollback", async () => {
    const { host, hub } = await hubWithSession(21);
    const seen: string[] = [];

    hub.tapOutput(21, (text) => seen.push(text));
    emitOutput(host, 21, {
      offset: 0n,
      data: bytes("old password: "),
      source: "replay",
    });
    emitOutput(host, 21, { offset: 20n, data: bytes("new"), source: "live" });

    expect(seen).toEqual(["new"]);
    hub.close();
  });

  it("decodes multi-byte characters split across chunks", async () => {
    const { host, hub } = await hubWithSession(21);
    const seen: string[] = [];
    const encoded = bytes("é");

    hub.tapOutput(21, (text) => seen.push(text));
    emitOutput(host, 21, { offset: 0n, data: encoded.slice(0, 1), source: "live" });
    emitOutput(host, 21, { offset: 1n, data: encoded.slice(1), source: "live" });

    expect(seen.join("")).toBe("é");
    hub.close();
  });

  it("keeps every other tap alive when one of them throws", async () => {
    const { host, hub } = await hubWithSession(21);
    const seen: string[] = [];

    hub.tapOutput(21, () => {
      throw new Error("tap consumer failed");
    });
    hub.tapOutput(21, (text) => seen.push(text));
    emitOutput(host, 21, { offset: 0n, data: bytes("alive"), source: "live" });

    expect(seen).toEqual(["alive"]);
    hub.close();
  });

  it("survives the terminal detaching, and a session it has never seen", async () => {
    const { host, hub } = await hubWithSession(21);
    const seen: string[] = [];
    const terminal = await hub.attach(21, {}, false);

    hub.tapOutput(21, (text) => seen.push(text));
    terminal.detach();
    emitOutput(host, 21, {
      offset: 0n,
      data: bytes("after detach"),
      source: "live",
    });

    expect(seen).toEqual(["after detach"]);
    // A tap on an unknown session is inert, never a throw: the watcher is
    // armed around a session that may already have died.
    expect(() => hub.tapOutput(999, () => undefined).dispose()).not.toThrow();
    hub.close();
  });
});

describe("AttachmentHub attention (settled bursts)", () => {
  async function hubWithSession(id: number) {
    const host = createFakeHost();
    const hub = new AttachmentHub(host);
    const attaching = hub.attachAll([id]);
    resolvePhysical(host, id);
    await attaching;
    return { host, hub };
  }

  /** Emit live output every second for `totalMs`, then go quiet past the
   * pulse window so the burst ends and the settle check runs. */
  function burst(host: FakeHost, id: number, totalMs: number): void {
    let offset = 0n;
    const step = 1_000;
    for (let elapsed = 0; ; elapsed += step) {
      emitOutput(host, id, { offset, data: new Uint8Array([46]), source: "live" });
      offset += 1n;
      if (elapsed >= totalMs) {
        break;
      }
      vi.advanceTimersByTime(step);
    }
    vi.advanceTimersByTime(ACTIVITY_PULSE_MS);
  }

  it("never marks a short burst — a dir listing is not an agent finishing", async () => {
    vi.useFakeTimers();
    const { host, hub } = await hubWithSession(7);
    burst(host, 7, 1_000);
    expect(hub.getSnapshot().sessions[7]).toMatchObject({ active: false, settled: false });
  });

  it("marks a long burst settled once it goes quiet, and the mark is sticky", async () => {
    vi.useFakeTimers();
    const { host, hub } = await hubWithSession(7);
    burst(host, 7, ATTENTION_MIN_BURST_MS + 1_000);
    expect(hub.getSnapshot().sessions[7]).toMatchObject({ active: false, settled: true });
    vi.advanceTimersByTime(60_000);
    expect(hub.getSnapshot().sessions[7]?.settled).toBe(true);
  });

  it("a fresh burst supersedes the mark; only its own settle re-arms it", async () => {
    vi.useFakeTimers();
    const { host, hub } = await hubWithSession(7);
    burst(host, 7, ATTENTION_MIN_BURST_MS + 1_000);
    expect(hub.getSnapshot().sessions[7]?.settled).toBe(true);
    emitOutput(host, 7, { offset: 100n, data: new Uint8Array([46]), source: "live" });
    expect(hub.getSnapshot().sessions[7]?.settled).toBe(false);
    vi.advanceTimersByTime(ACTIVITY_PULSE_MS);
    expect(hub.getSnapshot().sessions[7]?.settled).toBe(false);
  });

  it("markSeen delivers the mark; markSeen on a clean session publishes nothing", async () => {
    vi.useFakeTimers();
    const { host, hub } = await hubWithSession(7);
    burst(host, 7, ATTENTION_MIN_BURST_MS + 1_000);
    expect(hub.getSnapshot().sessions[7]?.settled).toBe(true);

    hub.markSeen(7);
    expect(hub.getSnapshot().sessions[7]?.settled).toBe(false);

    const before = hub.getSnapshot();
    hub.markSeen(7);
    hub.markSeen(999);
    expect(hub.getSnapshot()).toBe(before);
  });

  it("noteBell marks instantly, without any burst at all", async () => {
    vi.useFakeTimers();
    const { hub } = await hubWithSession(7);
    expect(hub.getSnapshot().sessions[7]?.settled).toBe(false);
    hub.noteBell(7);
    expect(hub.getSnapshot().sessions[7]?.settled).toBe(true);
    hub.noteBell(999);
    hub.markSeen(7);
    expect(hub.getSnapshot().sessions[7]?.settled).toBe(false);
  });

  it("stamps the settle with when output stopped, not when the timer fired", async () => {
    vi.useFakeTimers();
    const { host, hub } = await hubWithSession(7);
    burst(host, 7, ATTENTION_MIN_BURST_MS + 1_000);
    const settledAt = hub.getSnapshot().sessions[7]?.settledAt ?? null;
    expect(settledAt).toBe(Date.now() - ACTIVITY_PULSE_MS);

    // Sticky: the stamp must not creep while the tab waits to be noticed,
    // or "done since" would always read as just now.
    vi.advanceTimersByTime(60_000);
    expect(hub.getSnapshot().sessions[7]?.settledAt).toBe(settledAt);
  });

  it("clears the settle stamp when the mark is delivered or superseded", async () => {
    vi.useFakeTimers();
    const { host, hub } = await hubWithSession(7);
    burst(host, 7, ATTENTION_MIN_BURST_MS + 1_000);
    expect(hub.getSnapshot().sessions[7]?.settledAt).not.toBeNull();

    hub.markSeen(7);
    expect(hub.getSnapshot().sessions[7]?.settledAt).toBeNull();

    burst(host, 7, ATTENTION_MIN_BURST_MS + 1_000);
    expect(hub.getSnapshot().sessions[7]?.settledAt).not.toBeNull();
    emitOutput(host, 7, { offset: 500n, data: new Uint8Array([46]), source: "live" });
    expect(hub.getSnapshot().sessions[7]).toMatchObject({
      settled: false,
      settledAt: null,
    });
  });

  it("a bell stamps the settle at the moment it rang", async () => {
    vi.useFakeTimers();
    const { hub } = await hubWithSession(7);
    hub.noteBell(7);
    expect(hub.getSnapshot().sessions[7]?.settledAt).toBe(Date.now());
  });

  it("replayed output never starts a burst clock toward attention", async () => {
    vi.useFakeTimers();
    const host = createFakeHost();
    const hub = new AttachmentHub(host);
    const attaching = hub.attachAll([9]);
    emitOutput(host, 9, { offset: 0n, data: new Uint8Array([65]), source: "replay" });
    resolvePhysical(host, 9);
    await attaching;
    vi.advanceTimersByTime(ATTENTION_MIN_BURST_MS + ACTIVITY_PULSE_MS + 1_000);
    expect(hub.getSnapshot().sessions[9]?.settled ?? false).toBe(false);
    hub.close();
  });
});
