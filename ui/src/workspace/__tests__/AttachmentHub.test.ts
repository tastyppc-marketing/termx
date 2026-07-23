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
  pending: Map<number, Deferred<SessionAttachment>>;
  physical: Map<number, PhysicalRecord>;
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
  const pending = new Map<number, Deferred<SessionAttachment>>();
  const physical = new Map<number, PhysicalRecord>();

  return {
    attachCalls,
    pending,
    physical,
    attach(sessionId, callbacks = {}) {
      attachCalls.push(sessionId);
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
