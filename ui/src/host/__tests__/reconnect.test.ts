import { describe, expect, it, vi } from "vitest";
import { HostClient } from "../client";
import {
  ANTI_FLAP_FLOOR_MS,
  AUTH_BACKOFF_MS,
  HostBootstrapError,
  HostDisconnectedError,
  ReconnectingHostClient,
  RECONNECT_BACKOFF_MS,
  REQUEST_TIMEOUT_MS,
  type ConnectionState,
} from "../reconnect";

/** Deterministic clock + timer pair matching ReconnectOptions' injection points. */
function createClock() {
  interface Timer {
    id: number;
    at: number;
    run: () => void;
  }
  let current = 0;
  let nextId = 1;
  let timers: Timer[] = [];

  return {
    now: () => current,
    schedule: (run: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ id, at: current + ms, run });
      return () => {
        timers = timers.filter((timer) => timer.id !== id);
      };
    },
    pendingCount: () => timers.length,
    advance: (ms: number) => {
      const target = current + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > target) {
          break;
        }
        timers = timers.slice(1);
        current = next.at;
        next.run();
      }
      current = target;
    },
  };
}

/** The wrapper only ever touches onError and close, so that is the whole fake. */
class FakeClient {
  closeCalls = 0;
  private readonly listeners = new Set<(error: Error) => void>();

  onError(listener: (error: Error) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closeCalls += 1;
  }

  /** Simulate the socket dying under a live connection. */
  die(message = "Host connection closed"): void {
    for (const listener of [...this.listeners]) {
      listener(new Error(message));
    }
  }

  asHostClient(): HostClient {
    return this as unknown as HostClient;
  }
}

/** A controlled transport that exercises the real HostClient request queue. */
class ControlledWebSocket {
  binaryType: BinaryType = "blob";
  readyState = 0;
  readonly sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];
  closeCalls = 0;
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (!listener) {
      return;
    }
    const eventListener: EventListener = typeof listener === "function"
      ? listener
      : (event) => listener.handleEvent(event);
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(eventListener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (!listener || typeof listener !== "function") {
      return;
    }
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState !== 1) {
      throw new Error("socket is not open");
    }
    this.sent.push(data);
  }

  close() {
    this.closeCalls += 1;
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.emit("close", new Event("close"));
  }

  open() {
    this.readyState = 1;
    this.emit("open", new Event("open"));
  }

  receiveJson(message: Record<string, unknown>) {
    this.emit("message", new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  sentJson(): Array<Record<string, unknown>> {
    return this.sent
      .filter((message): message is string => typeof message === "string")
      .map((message) => JSON.parse(message) as Record<string, unknown>);
  }

  private emit(type: string, event: Event) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

async function connectControlled(socket: ControlledWebSocket): Promise<HostClient> {
  const pending = HostClient.connect({
    port: 43_123,
    token: "timeout-test-token",
    webSocketFactory: () => socket as never,
  });
  socket.open();
  socket.receiveJson({ type: "auth_ok", version: "0.1.0", sessions: [] });
  return pending;
}

async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

/** A `connect` driven by a script of outcomes; the last one repeats forever. */
function scriptedConnect(outcomes: ReadonlyArray<FakeClient | Error>) {
  let index = 0;
  const calls: number[] = [];
  const connect = vi.fn(() => {
    const outcome = outcomes[Math.min(index, outcomes.length - 1)];
    index += 1;
    calls.push(index);
    return outcome instanceof Error
      ? Promise.reject(outcome)
      : Promise.resolve(outcome!.asHostClient());
  });
  return connect;
}

function transportFailure() {
  return new Error("Unable to connect to the host");
}

function start(
  connect: () => Promise<HostClient>,
  clock: ReturnType<typeof createClock>,
) {
  return ReconnectingHostClient.start({
    connect,
    now: clock.now,
    schedule: clock.schedule,
  });
}

describe("ReconnectingHostClient backoff", () => {
  it("walks the step table and stays at its last step", async () => {
    const clock = createClock();
    const connect = scriptedConnect([transportFailure()]);
    const machine = start(connect, clock);

    expect(machine.state).toEqual({ phase: "connecting", isInitial: true });

    const observed: number[] = [];
    for (const step of RECONNECT_BACKOFF_MS) {
      await flush();
      const state = machine.state as Extract<ConnectionState, { phase: "reconnecting" }>;
      observed.push(state.nextDelayMs);
      clock.advance(step);
    }
    await flush();
    observed.push(
      (machine.state as Extract<ConnectionState, { phase: "reconnecting" }>).nextDelayMs,
    );

    expect(observed).toEqual([1_000, 2_000, 5_000, 10_000, 10_000]);
    expect(connect).toHaveBeenCalledTimes(5);
    machine.dispose();
  });

  it("counts attempts so the banner can say which one is pending", async () => {
    const clock = createClock();
    const machine = start(scriptedConnect([transportFailure()]), clock);

    await flush();
    expect(machine.state).toEqual({ phase: "reconnecting", attempt: 1, nextDelayMs: 1_000 });
    clock.advance(1_000);
    await flush();
    expect(machine.state).toEqual({ phase: "reconnecting", attempt: 2, nextDelayMs: 2_000 });
    machine.dispose();
  });

  it("resets the table only on a proven connection, not on a mere attempt", async () => {
    const clock = createClock();
    const client = new FakeClient();
    const machine = start(
      scriptedConnect([transportFailure(), transportFailure(), client, transportFailure()]),
      clock,
    );

    await flush();
    clock.advance(1_000);
    await flush();
    clock.advance(2_000);
    await flush();
    expect(machine.state).toEqual({ phase: "connected" });

    // Live long enough that the anti-flap floor is not what we are measuring.
    clock.advance(ANTI_FLAP_FLOOR_MS);
    client.die();
    await flush();
    expect(machine.state).toEqual({ phase: "reconnecting", attempt: 1, nextDelayMs: 1_000 });
    machine.dispose();
  });

  it("moves to the slow table when the host rejects our token", async () => {
    const clock = createClock();
    const machine = start(
      scriptedConnect([new Error("Host authentication rejected")]),
      clock,
    );

    const observed: number[] = [];
    for (const step of AUTH_BACKOFF_MS) {
      await flush();
      observed.push(
        (machine.state as Extract<ConnectionState, { phase: "reconnecting" }>).nextDelayMs,
      );
      clock.advance(step);
    }
    await flush();
    observed.push(
      (machine.state as Extract<ConnectionState, { phase: "reconnecting" }>).nextDelayMs,
    );

    expect(observed).toEqual([5_000, 15_000, 30_000, 30_000]);
    machine.dispose();
  });

  it("shows a bootstrap failure as failed but keeps retrying anyway", async () => {
    const clock = createClock();
    const client = new FakeClient();
    const machine = start(
      scriptedConnect([new HostBootstrapError("Unable to start the host"), client]),
      clock,
    );

    await flush();
    expect(machine.state).toEqual({
      phase: "failed",
      reason: "Unable to start the host",
    });

    // "Failed" is what the user sees, not what the machine does: it is still
    // counting down, on the slow table.
    clock.advance(AUTH_BACKOFF_MS[0]);
    await flush();
    expect(machine.state).toEqual({ phase: "connected" });
    machine.dispose();
  });
});

describe("ReconnectingHostClient anti-flap floor", () => {
  it("makes a crash-looping host wait out the floor from its last success", async () => {
    const clock = createClock();
    const client = new FakeClient();
    const connect = scriptedConnect([client, transportFailure()]);
    const machine = start(connect, clock);

    await flush();
    expect(machine.state).toEqual({ phase: "connected" });

    clock.advance(5_000);
    client.die();
    await flush();

    const state = machine.state as Extract<ConnectionState, { phase: "reconnecting" }>;
    expect(state.nextDelayMs).toBe(ANTI_FLAP_FLOOR_MS - 5_000);
    expect(connect).toHaveBeenCalledTimes(1);

    // Nothing may fire early.
    clock.advance(ANTI_FLAP_FLOOR_MS - 5_001);
    await flush();
    expect(connect).toHaveBeenCalledTimes(1);
    clock.advance(1);
    await flush();
    expect(connect).toHaveBeenCalledTimes(2);
    machine.dispose();
  });

  it("stops holding retries back once the floor has elapsed", async () => {
    const clock = createClock();
    const client = new FakeClient();
    const machine = start(scriptedConnect([client, transportFailure()]), clock);

    await flush();
    clock.advance(5_000);
    client.die();
    await flush();
    clock.advance(ANTI_FLAP_FLOOR_MS - 5_000);
    await flush();

    // The floor is now spent, so the ordinary table takes over.
    expect(machine.state).toEqual({ phase: "reconnecting", attempt: 2, nextDelayMs: 2_000 });
    machine.dispose();
  });
});

describe("ReconnectingHostClient requests", () => {
  it("fails fast while disconnected instead of queueing", async () => {
    const clock = createClock();
    const machine = start(scriptedConnect([transportFailure()]), clock);
    await flush();

    const call = vi.fn(() => Promise.resolve("never"));
    await expect(machine.request(call)).rejects.toBeInstanceOf(HostDisconnectedError);
    expect(call).not.toHaveBeenCalled();
    machine.dispose();
  });

  it("passes the live client through while connected", async () => {
    const clock = createClock();
    const client = new FakeClient();
    const machine = start(scriptedConnect([client]), clock);
    await flush();

    await expect(machine.request((live) => Promise.resolve(live))).resolves.toBe(
      client.asHostClient(),
    );
    machine.dispose();
  });

  it("retires the connection when the local daemon never answers", async () => {
    const clock = createClock();
    const client = new FakeClient();
    const machine = start(scriptedConnect([client]), clock);
    await flush();

    const pending = machine.request(() => new Promise<never>(() => undefined));
    const settled = vi.fn();
    void pending.catch(settled);

    clock.advance(REQUEST_TIMEOUT_MS - 1);
    await flush();
    expect(settled).not.toHaveBeenCalled();

    clock.advance(1);
    await flush();
    await expect(pending).rejects.toBeInstanceOf(HostDisconnectedError);
    expect(client.closeCalls).toBe(1);
    expect(machine.state).toMatchObject({ phase: "reconnecting" });
    machine.dispose();
  });

  it("closes a timed-out real client before its queued command can be sent", async () => {
    const clock = createClock();
    const firstSocket = new ControlledWebSocket();
    const secondSocket = new ControlledWebSocket();
    const firstClient = await connectControlled(firstSocket);
    const connect = vi.fn(() => connectControlled(secondSocket));
    const machine = ReconnectingHostClient.start({
      initialClient: firstClient,
      connect,
      now: clock.now,
      schedule: clock.schedule,
    });

    const getState = machine.request((client) => client.getState());
    const closeSession = machine.request((client) => client.closeSession(7));
    const attachment = firstClient.attach(7);
    void getState.catch(() => undefined);
    void closeSession.catch(() => undefined);
    void attachment.catch(() => undefined);
    expect(firstSocket.sentJson().map((message) => message.type)).toEqual([
      "auth",
      "get_state",
      "attach",
    ]);

    clock.advance(REQUEST_TIMEOUT_MS);
    await flush();

    await expect(getState).rejects.toThrow(/did not answer within 120s/);
    await expect(closeSession).rejects.toBeInstanceOf(Error);
    await expect(attachment).rejects.toThrow(/Host connection closed/);
    expect(firstSocket.closeCalls).toBe(1);
    expect(machine.state).toMatchObject({ phase: "reconnecting" });

    // A reply already in flight may arrive after the deadline. It must not
    // release the old HostClient queue and transmit CloseSession.
    firstSocket.receiveJson({ type: "state", layout: null, sessions: [] });
    expect(firstSocket.sentJson().map((message) => message.type)).toEqual([
      "auth",
      "get_state",
      "attach",
    ]);

    clock.advance(RECONNECT_BACKOFF_MS[0]);
    await flush();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(machine.state).toEqual({ phase: "connected" });

    const fresh = machine.request((client) => client.getState());
    secondSocket.receiveJson({ type: "state", layout: { fresh: true }, sessions: [] });
    await expect(fresh).resolves.toEqual({ layout: { fresh: true }, sessions: [] });
    machine.dispose();
  });

  it("does not let an obsolete request rejection retire its replacement client", async () => {
    const clock = createClock();
    const first = new FakeClient();
    const second = new FakeClient();
    const machine = start(scriptedConnect([first, second]), clock);
    await flush();

    let rejectOld!: (error: Error) => void;
    const stale = machine.request(() => new Promise<never>((_resolve, reject) => {
      rejectOld = reject;
    }));
    void stale.catch(() => undefined);
    first.die();
    clock.advance(ANTI_FLAP_FLOOR_MS);
    await flush();
    expect(machine.currentClient).toBe(second.asHostClient());

    rejectOld(new Error("Host connection closed"));
    await flush();

    await expect(stale).rejects.toThrow(/Host connection closed/);
    expect(second.closeCalls).toBe(0);
    expect(machine.currentClient).toBe(second.asHostClient());
    machine.dispose();
  });

  it("does not let an obsolete request deadline retire its replacement client", async () => {
    const clock = createClock();
    const first = new FakeClient();
    const second = new FakeClient();
    const machine = start(scriptedConnect([first, second]), clock);
    await flush();

    const stale = machine.request(() => new Promise<never>(() => undefined));
    void stale.catch(() => undefined);
    first.die();
    clock.advance(ANTI_FLAP_FLOOR_MS);
    await flush();
    expect(machine.currentClient).toBe(second.asHostClient());

    clock.advance(REQUEST_TIMEOUT_MS - ANTI_FLAP_FLOOR_MS);
    await flush();

    await expect(stale).rejects.toThrow(/did not answer within 120s/);
    expect(second.closeCalls).toBe(0);
    expect(machine.currentClient).toBe(second.asHostClient());
    machine.dispose();
  });

  it("cancels the deadline when the request callback throws synchronously", async () => {
    const clock = createClock();
    const client = new FakeClient();
    const machine = start(scriptedConnect([client]), clock);
    await flush();

    const failure = new Error("invalid request arguments");
    await expect(machine.request(() => {
      throw failure;
    })).rejects.toBe(failure);

    expect(clock.pendingCount()).toBe(0);
    clock.advance(REQUEST_TIMEOUT_MS);
    expect(client.closeCalls).toBe(0);
    expect(machine.state).toEqual({ phase: "connected" });
    machine.dispose();
  });

  it("disposal closes a real client and drains an outstanding request deadline", async () => {
    const clock = createClock();
    const socket = new ControlledWebSocket();
    const client = await connectControlled(socket);
    const machine = ReconnectingHostClient.start({
      initialClient: client,
      connect: () => Promise.reject(new Error("disposed machine must not reconnect")),
      now: clock.now,
      schedule: clock.schedule,
    });
    const pending = machine.request((live) => live.getState());
    void pending.catch(() => undefined);

    machine.dispose();
    await flush();

    await expect(pending).rejects.toThrow(/Host connection closed/);
    expect(socket.closeCalls).toBe(1);
    expect(clock.pendingCount()).toBe(0);
  });

  it("treats a terminal request rejection as the connection dying", async () => {
    const clock = createClock();
    const machine = start(
      scriptedConnect([new FakeClient(), transportFailure()]),
      clock,
    );
    await flush();

    await expect(
      machine.request(() => Promise.reject(new Error("Host connection closed"))),
    ).rejects.toThrow(/Host connection closed/);
    await flush();

    expect(machine.state).toMatchObject({ phase: "reconnecting" });
    machine.dispose();
  });

  it("leaves the connection alone when a request fails for its own reasons", async () => {
    const clock = createClock();
    const machine = start(scriptedConnect([new FakeClient()]), clock);
    await flush();

    await expect(
      machine.request(() => Promise.reject(new Error("Host request failed (attach): no session 9"))),
    ).rejects.toThrow(/no session 9/);
    await flush();

    expect(machine.state).toEqual({ phase: "connected" });
    machine.dispose();
  });
});

describe("ReconnectingHostClient power events", () => {
  it("drops the socket on suspend and burns no retries while asleep", async () => {
    const clock = createClock();
    const client = new FakeClient();
    const connect = scriptedConnect([client, new FakeClient()]);
    const machine = start(connect, clock);
    await flush();

    machine.notifySuspend();

    expect(client.closeCalls).toBe(1);
    expect(machine.state).toMatchObject({ phase: "reconnecting" });
    clock.advance(60 * 60 * 1_000);
    await flush();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(clock.pendingCount()).toBe(0);
    machine.dispose();
  });

  it("reconnects immediately on resume", async () => {
    const clock = createClock();
    const connect = scriptedConnect([new FakeClient(), new FakeClient()]);
    const machine = start(connect, clock);
    await flush();

    machine.notifySuspend();
    clock.advance(8 * 60 * 60 * 1_000); // a night asleep
    machine.notifyResume();
    await flush();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(machine.state).toEqual({ phase: "connected" });
    machine.dispose();
  });

  it("still honors the anti-flap floor on a resume that follows a brief session", async () => {
    const clock = createClock();
    const connect = scriptedConnect([new FakeClient(), new FakeClient()]);
    const machine = start(connect, clock);
    await flush();

    clock.advance(1_000);
    machine.notifySuspend();
    machine.notifyResume();
    await flush();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(machine.state).toMatchObject({
      phase: "reconnecting",
      nextDelayMs: ANTI_FLAP_FLOOR_MS - 1_000,
    });
    clock.advance(ANTI_FLAP_FLOOR_MS - 1_000);
    await flush();
    expect(connect).toHaveBeenCalledTimes(2);
    machine.dispose();
  });

  it("ignores a resume that no suspend preceded", async () => {
    const clock = createClock();
    const connect = scriptedConnect([new FakeClient()]);
    const machine = start(connect, clock);
    await flush();

    machine.notifyResume();
    await flush();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(machine.state).toEqual({ phase: "connected" });
    machine.dispose();
  });
});

describe("ReconnectingHostClient manual retry and disposal", () => {
  it("retries at once from a pending backoff", async () => {
    const clock = createClock();
    const connect = scriptedConnect([transportFailure(), new FakeClient()]);
    const machine = start(connect, clock);
    await flush();
    expect(machine.state).toMatchObject({ phase: "reconnecting", nextDelayMs: 1_000 });

    machine.retryNow();
    await flush();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(machine.state).toEqual({ phase: "connected" });
    machine.dispose();
  });

  it("does nothing when the connection is already healthy", async () => {
    const clock = createClock();
    const connect = scriptedConnect([new FakeClient()]);
    const machine = start(connect, clock);
    await flush();

    machine.retryNow();
    await flush();

    expect(connect).toHaveBeenCalledTimes(1);
    machine.dispose();
  });

  it("cancels timers, closes the socket, and goes quiet on dispose", async () => {
    const clock = createClock();
    const client = new FakeClient();
    const connect = scriptedConnect([client, transportFailure()]);
    const machine = start(connect, clock);
    await flush();

    clock.advance(ANTI_FLAP_FLOOR_MS);
    client.die();
    await flush();
    expect(clock.pendingCount()).toBe(1);

    machine.dispose();

    expect(clock.pendingCount()).toBe(0);
    clock.advance(60_000);
    await flush();
    expect(connect).toHaveBeenCalledTimes(1);
    machine.dispose(); // idempotent
  });

  it("closes a live socket on dispose", async () => {
    const clock = createClock();
    const client = new FakeClient();
    const machine = start(scriptedConnect([client]), clock);
    await flush();

    machine.dispose();

    expect(client.closeCalls).toBe(1);
  });
});

describe("ReconnectingHostClient listeners", () => {
  it("reports every transition in order", async () => {
    const clock = createClock();
    const client = new FakeClient();
    const connect = scriptedConnect([transportFailure(), client]);
    const machine = start(connect, clock);
    const states: ConnectionState[] = [];
    machine.onStateChange((state) => states.push(state));

    await flush();
    clock.advance(1_000);
    await flush();

    expect(states).toEqual([
      { phase: "reconnecting", attempt: 1, nextDelayMs: 1_000 },
      { phase: "connecting", isInitial: false },
      { phase: "connected" },
    ]);
    machine.dispose();
  });

  it("marks only the first success as an initial connection", async () => {
    const clock = createClock();
    const first = new FakeClient();
    const second = new FakeClient();
    const machine = start(scriptedConnect([first, second]), clock);
    const connections: Array<{ isReconnect: boolean }> = [];
    machine.onConnected((_client, isReconnect) => connections.push({ isReconnect }));

    await flush();
    clock.advance(ANTI_FLAP_FLOOR_MS);
    first.die();
    await flush();
    clock.advance(RECONNECT_BACKOFF_MS[0]);
    await flush();

    expect(connections).toEqual([{ isReconnect: false }, { isReconnect: true }]);
    machine.dispose();
  });

  it("lets a listener unsubscribe", async () => {
    const clock = createClock();
    const machine = start(scriptedConnect([transportFailure()]), clock);
    const seen: ConnectionState[] = [];
    const stop = machine.onStateChange((state) => seen.push(state));

    await flush();
    stop();
    clock.advance(1_000);
    await flush();

    expect(seen).toHaveLength(1);
    machine.dispose();
  });

  it("survives a listener that throws", async () => {
    const clock = createClock();
    const machine = start(scriptedConnect([new FakeClient()]), clock);
    machine.onStateChange(() => {
      throw new Error("listener exploded");
    });
    const seen: ConnectionState[] = [];
    machine.onStateChange((state) => seen.push(state));

    await flush();

    expect(seen).toEqual([{ phase: "connected" }]);
    machine.dispose();
  });
});
