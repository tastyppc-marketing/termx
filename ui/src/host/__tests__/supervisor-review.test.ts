// Supervisor review additions (T3 gate): the two brief-required behaviors
// the worker missed — input-cap refusal and the client-side auth deadline.
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "../client";
import { MAX_INPUT_PAYLOAD, encodeFrame } from "../frames";

describe("input payload cap", () => {
  it("encodes a payload at exactly the host cap", () => {
    const frame = encodeFrame({
      type: "input",
      sessionId: 1,
      data: new Uint8Array(MAX_INPUT_PAYLOAD),
    });
    expect(frame.byteLength).toBe(5 + MAX_INPUT_PAYLOAD);
  });

  it("refuses a payload one byte over the cap — oversized frames drop the whole connection host-side", () => {
    expect(() =>
      encodeFrame({
        type: "input",
        sessionId: 1,
        data: new Uint8Array(MAX_INPUT_PAYLOAD + 1),
      }),
    ).toThrow(RangeError);
  });
});

describe("auth deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects after 5s when the listener accepts but never answers auth", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, Set<EventListener>>();
    let closed = 0;
    const socket = {
      binaryType: "blob" as BinaryType,
      readyState: 0,
      addEventListener(type: string, fn: EventListener) {
        const set = listeners.get(type) ?? new Set<EventListener>();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener(type: string, fn: EventListener) {
        listeners.get(type)?.delete(fn);
      },
      send() {
        // swallow the auth message; the "host" stays silent
      },
      close() {
        closed += 1;
        this.readyState = 3;
      },
    };

    const promise = HostClient.connect({
      port: 4242,
      token: "tok",
      webSocketFactory: () => socket as never,
    });
    const settled = expect(promise).rejects.toThrow("Host authentication timed out");

    // Open the socket so auth is sent, then let the silent host stall.
    socket.readyState = 1;
    for (const fn of [...(listeners.get("open") ?? [])]) {
      fn(new Event("open"));
    }
    await vi.advanceTimersByTimeAsync(5_100);

    await settled;
    expect(closed).toBeGreaterThan(0);
  });
});
