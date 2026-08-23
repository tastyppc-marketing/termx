import { describe, expect, it, vi } from "vitest";
import { HostClient } from "../client";
import { decodeFrame, encodeFrame, MAX_INPUT_PAYLOAD } from "../frames";
import type { HostMsg, SessionInfo } from "../protocol";

const SESSION: SessionInfo = {
  id: 7,
  profile: "powershell",
  cwd: "C:\\work",
  cols: 120,
  rows: 30,
  alive: true,
  pid: 1234,
};

class FakeWebSocket {
  binaryType: BinaryType = "blob";
  readyState = 0;
  readonly sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];
  closeCalls = 0;
  failNextSend = false;
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
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("injected send failure");
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

  receiveJson(message: HostMsg) {
    this.receive(JSON.stringify(message));
  }

  receive(data: string | ArrayBuffer | ArrayBufferView) {
    this.emit("message", new MessageEvent("message", { data }));
  }

  remoteClose() {
    this.readyState = 3;
    this.emit("close", new Event("close"));
  }

  listenerCount() {
    let count = 0;
    for (const listeners of this.listeners.values()) {
      count += listeners.size;
    }
    return count;
  }

  private emit(type: string, event: Event) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

function startConnection(token = "test-auth-token") {
  const socket = new FakeWebSocket();
  const promise = HostClient.connect({
    port: 43123,
    token,
    webSocketFactory: () => socket as never,
  });
  return { promise, socket, token };
}

async function connect(token?: string) {
  const pending = startConnection(token);
  pending.socket.open();
  await flushPromises();
  pending.socket.receiveJson({
    type: "auth_ok",
    version: "0.1.0",
    sessions: [SESSION],
  });
  return {
    client: await pending.promise,
    socket: pending.socket,
    token: pending.token,
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function sentJson(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent
    .filter((message): message is string => typeof message === "string")
    .map((message) => JSON.parse(message) as Record<string, unknown>);
}

function base64(text: string) {
  return btoa(text);
}

describe("HostClient authentication", () => {
  it("opens the loopback socket, authenticates first, and returns host metadata", async () => {
    const { promise, socket } = startConnection();

    expect(socket.binaryType).toBe("arraybuffer");
    socket.open();
    expect(sentJson(socket)).toEqual([
      { type: "auth", token: "test-auth-token" },
    ]);

    socket.receiveJson({
      type: "auth_ok",
      version: "1.2.3",
      sessions: [SESSION],
    });

    const client = await promise;
    expect(client.version).toBe("1.2.3");
    expect(client.initialSessions).toEqual([SESSION]);
  });

  it("never exposes the token when authentication is rejected", async () => {
    const { promise, socket, token } = startConnection("never-print-this-token");
    socket.open();
    socket.receiveJson({
      type: "auth_err",
      reason: `bad credential: ${token}`,
    });

    const error = await promise.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(token);
    expect(socket.closeCalls).toBe(1);
    expect(socket.listenerCount()).toBe(0);
  });

  it("sanitizes factory failures instead of forwarding arbitrary error text", async () => {
    const token = "factory-secret-token";
    const error = await HostClient.connect({
      port: 43123,
      token,
      webSocketFactory: () => {
        throw new Error(`failed with ${token}`);
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(token);
  });
});

describe("HostClient ordered control transport", () => {
  it("serializes reply-bearing requests while routing SessionExited independently", async () => {
    const { client, socket } = await connect();
    const exits: Array<{ sessionId: number; exitCode: number | null }> = [];
    client.onSessionExited((event) => exits.push(event));

    const sessionsPromise = client.listSessions();
    const statePromise = client.getState();
    await flushPromises();

    expect(sentJson(socket).map((message) => message.type)).toEqual([
      "auth",
      "list_sessions",
    ]);

    socket.receiveJson({ type: "session_exited", session_id: 7, exit_code: 9 });
    expect(exits).toEqual([{ sessionId: 7, exitCode: 9 }]);

    socket.receiveJson({ type: "sessions", sessions: [SESSION] });
    await expect(sessionsPromise).resolves.toEqual([SESSION]);
    await flushPromises();
    expect(sentJson(socket).map((message) => message.type)).toEqual([
      "auth",
      "list_sessions",
      "get_state",
    ]);

    socket.receiveJson({ type: "state", layout: { groups: [] }, sessions: [SESSION] });
    await expect(statePromise).resolves.toEqual({
      layout: { groups: [] },
      sessions: [SESSION],
    });
  });

  it("routes one-way command errors without stealing an ordered reply", async () => {
    const { client, socket } = await connect();
    const errors: Error[] = [];
    client.onError((error) => errors.push(error));
    const sessionsPromise = client.listSessions();
    await flushPromises();

    socket.receiveJson({
      type: "error",
      context: "resize",
      message: "no session 999",
    });
    socket.receiveJson({ type: "sessions", sessions: [SESSION] });

    await expect(sessionsPromise).resolves.toEqual([SESSION]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("resize");
  });

  it("rejects a mismatched reply/error context and closes the ambiguous stream", async () => {
    const { client, socket } = await connect();
    const sessionsPromise = client.listSessions();
    await flushPromises();

    socket.receiveJson({
      type: "error",
      context: "create_session",
      message: "wrong reply",
    });

    await expect(sessionsPromise).rejects.toThrow(/unexpected/i);
    expect(socket.closeCalls).toBe(1);
  });

  it("redacts the auth token from host request errors", async () => {
    const token = "request-secret-token";
    const { client, socket } = await connect(token);
    const created = client.createSession({
      profile: null,
      cwd: null,
      cols: 80,
      rows: 24,
    });
    await flushPromises();

    socket.receiveJson({
      type: "error",
      context: "create_session",
      message: `spawn failed near ${token}`,
    });
    const error = await created.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(token);
  });

  it("sends shell_integration on the wire, defaulting to on", async () => {
    const { client, socket } = await connect();
    const first = client.createSession({ profile: null, cwd: null, cols: 80, rows: 24 });
    await flushPromises();
    socket.receiveJson({ type: "session_created", info: SESSION });
    await first;

    const second = client.createSession({
      profile: null,
      cwd: null,
      cols: 80,
      rows: 24,
      shellIntegration: false,
    });
    await flushPromises();
    socket.receiveJson({ type: "session_created", info: SESSION });
    await second;

    const created = sentJson(socket).filter(
      (message) => message.type === "create_session",
    );
    expect(created.map((message) => message.shell_integration)).toEqual([true, false]);
  });
});

describe("HostClient session attachments", () => {
  it("decodes initial replay, trims overlap, signals gaps, and accepts unsolicited resync", async () => {
    const { client, socket } = await connect();
    const output: Array<{ offset: bigint; text: string; source: string }> = [];
    const gaps: Array<{ expectedOffset: bigint; receivedOffset: bigint }> = [];
    const attachPromise = client.attach(7, {
      onOutput: (event) => output.push({
        offset: event.offset,
        text: new TextDecoder().decode(event.data),
        source: event.source,
      }),
      onLostScrollback: (event) => gaps.push(event),
    });
    await flushPromises();

    expect(sentJson(socket).at(-1)).toEqual({
      type: "attach",
      session_id: 7,
      replay: true,
    });

    socket.receiveJson({
      type: "replay",
      session_id: 7,
      start_offset: 100,
      data_b64: base64("abcd"),
    });
    const handle = await attachPromise;

    socket.receive(encodeFrame({
      type: "output",
      sessionId: 7,
      offset: 102n,
      data: new TextEncoder().encode("cdef"),
    }));
    socket.receiveJson({
      type: "replay",
      session_id: 7,
      start_offset: 103,
      data_b64: base64("defghi"),
    });
    socket.receiveJson({
      type: "replay",
      session_id: 7,
      start_offset: 120,
      data_b64: base64("xy"),
    });
    socket.receive(encodeFrame({
      type: "output",
      sessionId: 7,
      offset: 122n,
      data: new TextEncoder().encode("z"),
    }));

    expect(handle.nextOffset).toBe(123n);
    expect(output).toEqual([
      { offset: 100n, text: "abcd", source: "replay" },
      { offset: 104n, text: "ef", source: "live" },
      { offset: 106n, text: "ghi", source: "replay" },
      { offset: 120n, text: "xy", source: "replay" },
      { offset: 122n, text: "z", source: "live" },
    ]);
    expect(gaps).toEqual([
      { expectedOffset: 0n, receivedOffset: 100n },
      { expectedOffset: 109n, receivedOffset: 120n },
    ]);
  });

  it("decodes a full-ring replay (multi-megabyte base64) without tearing down the connection", async () => {
    // Regression: the old base64 validation regex overflowed V8's regex stack
    // on multi-MB payloads ("Maximum call stack size exceeded"), which the
    // message handler treated as "Host sent an invalid message" and closed the
    // socket — an infinite reconnect loop for any session whose ring had
    // filled (2026-08-10, live incident).
    const { client, socket } = await connect();
    const received: number[] = [];
    const attachPromise = client.attach(9, {
      onOutput: (event) => received.push(event.data.byteLength),
    });
    await flushPromises();

    const ringBytes = 4 * 1024 * 1024; // termx-host's full ring cap
    socket.receiveJson({
      type: "replay",
      session_id: 9,
      start_offset: 144_622_698, // a realistic multi-hour stream offset
      data_b64: base64("A".repeat(ringBytes)),
    });

    const handle = await attachPromise;
    expect(handle.sessionId).toBe(9);
    expect(received).toEqual([ringBytes]);
    expect(socket.readyState).toBe(1);
  });

  it("routes Replay during another pending request without resolving that request", async () => {
    const { client, socket } = await connect();
    const output = vi.fn();
    const attaching = client.attach(7, { onOutput: output });
    await flushPromises();
    socket.receiveJson({
      type: "replay",
      session_id: 7,
      start_offset: 0,
      data_b64: base64("a"),
    });
    await attaching;

    const sessionsPromise = client.listSessions();
    let sessionsSettled = false;
    void sessionsPromise.finally(() => {
      sessionsSettled = true;
    });
    await flushPromises();
    socket.receiveJson({
      type: "replay",
      session_id: 7,
      start_offset: 1,
      data_b64: base64("b"),
    });
    await flushPromises();

    expect(output).toHaveBeenCalledTimes(2);
    expect(sessionsSettled).toBe(false);
    socket.receiveJson({ type: "sessions", sessions: [SESSION] });
    await expect(sessionsPromise).resolves.toEqual([SESSION]);
  });

  it("sends input, resize, and detach as one-way commands with no success ack", async () => {
    const { client, socket } = await connect();
    const attaching = client.attach(7);
    await flushPromises();
    socket.receiveJson({
      type: "replay",
      session_id: 7,
      start_offset: 0,
      data_b64: "",
    });
    const handle = await attaching;
    const sentBefore = socket.sent.length;

    expect(handle.sendInput("dir\r")).toBeUndefined();
    expect(handle.resize(132, 43)).toBeUndefined();
    expect(handle.detach()).toBeUndefined();

    const sent = socket.sent.slice(sentBefore);
    const input = decodeFrame(sent[0] as ArrayBufferView);
    expect({ ...input, data: [...input.data] }).toEqual({
      type: "input",
      sessionId: 7,
      data: [...new TextEncoder().encode("dir\r")],
    });
    expect(JSON.parse(sent[1] as string)).toEqual({
      type: "resize",
      session_id: 7,
      cols: 132,
      rows: 43,
    });
    expect(JSON.parse(sent[2] as string)).toEqual({
      type: "detach",
      session_id: 7,
    });
  });

  it("delivers exit status to both the attachment and client listeners", async () => {
    const { client, socket } = await connect();
    const handleExit = vi.fn();
    const clientExit = vi.fn();
    client.onSessionExited(clientExit);
    const attaching = client.attach(7, { onExit: handleExit });
    await flushPromises();
    socket.receiveJson({
      type: "replay",
      session_id: 7,
      start_offset: 0,
      data_b64: "",
    });
    await attaching;

    socket.receiveJson({ type: "session_exited", session_id: 7, exit_code: null });

    expect(handleExit).toHaveBeenCalledWith(null);
    expect(clientExit).toHaveBeenCalledWith({ sessionId: 7, exitCode: null });
  });

  it("rejects malformed replay data without exposing the token", async () => {
    const token = "malformed-replay-secret";
    const { client, socket } = await connect(token);
    const attaching = client.attach(7);
    await flushPromises();

    socket.receiveJson({
      type: "replay",
      session_id: 7,
      start_offset: 0,
      data_b64: `not-base64-${token}`,
    });
    const error = await attaching.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(token);
    expect(socket.closeCalls).toBe(1);
  });
});

describe("HostClient cleanup", () => {
  it("rejects active and queued requests, notifies attachments, and removes listeners", async () => {
    const { client, socket } = await connect();
    const disconnected = vi.fn();
    const attaching = client.attach(7, { onDisconnect: disconnected });
    await flushPromises();
    socket.receiveJson({
      type: "replay",
      session_id: 7,
      start_offset: 0,
      data_b64: "",
    });
    await attaching;

    const active = client.listSessions();
    const queued = client.getState();
    await flushPromises();
    socket.remoteClose();

    await expect(active).rejects.toThrow(/closed/i);
    await expect(queued).rejects.toThrow(/closed/i);
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(socket.listenerCount()).toBe(0);
  });
});

describe("HostClient review regressions", () => {
  it("isolates consumer callback failures from valid host traffic", async () => {
    const { client, socket } = await connect();
    const errors = vi.fn();
    client.onError(errors);
    const attaching = client.attach(7, {
      onOutput: () => {
        throw new Error("renderer failed");
      },
    });
    await flushPromises();

    socket.receiveJson({
      type: "replay",
      session_id: 7,
      start_offset: 0,
      data_b64: base64("a"),
    });

    await expect(attaching).resolves.toMatchObject({ sessionId: 7 });
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringMatching(/callback/i),
    }));
    expect(socket.closeCalls).toBe(0);
  });

  it("finishes teardown when one disconnect callback throws", async () => {
    const { client, socket } = await connect();
    const secondDisconnect = vi.fn();
    const first = client.attach(7, {
      onDisconnect: () => {
        throw new Error("dispose failed");
      },
    });
    await flushPromises();
    socket.receiveJson({ type: "replay", session_id: 7, start_offset: 0, data_b64: "" });
    await first;

    const second = client.attach(8, { onDisconnect: secondDisconnect });
    await flushPromises();
    socket.receiveJson({ type: "replay", session_id: 8, start_offset: 0, data_b64: "" });
    await second;

    expect(() => client.close()).not.toThrow();
    expect(socket.closeCalls).toBe(1);
    expect(secondDisconnect).toHaveBeenCalledTimes(1);
  });

  it("serializes attaches so an uncorrelated host error rejects only its owner", async () => {
    const { client, socket } = await connect();
    const first = client.attach(70);
    const second = client.attach(71);
    await flushPromises();

    expect(sentJson(socket).filter((message) => message.type === "attach")).toEqual([
      { type: "attach", session_id: 70, replay: true },
    ]);

    socket.receiveJson({ type: "error", context: "attach", message: "no session 70" });
    await expect(first).rejects.toThrow(/attach/i);
    expect(socket.closeCalls).toBe(0);
    expect(sentJson(socket).filter((message) => message.type === "attach")).toEqual([
      { type: "attach", session_id: 70, replay: true },
      { type: "attach", session_id: 71, replay: true },
    ]);

    socket.receiveJson({ type: "replay", session_id: 71, start_offset: 0, data_b64: "" });
    await expect(second).resolves.toMatchObject({ sessionId: 71 });
  });

  it("uses a round-trip barrier before resolving replay-free attaches", async () => {
    const { client, socket } = await connect();
    const attaching = client.attach(7, {}, false);
    let settled = false;
    void attaching.then(() => {
      settled = true;
    });
    await flushPromises();

    expect(settled).toBe(false);
    socket.receiveJson({ type: "sessions", sessions: [SESSION] });
    await expect(attaching).resolves.toMatchObject({ sessionId: 7 });
  });

  it("routes replay-free attach errors before the barrier", async () => {
    const { client, socket } = await connect();
    const attaching = client.attach(99, {}, false);
    await flushPromises();

    socket.receiveJson({ type: "error", context: "attach", message: "no session 99" });

    await expect(attaching).rejects.toThrow(/attach/i);
    expect(socket.closeCalls).toBe(0);
  });

  it("chunks large input without dropping paste bytes", async () => {
    const { client, socket } = await connect();
    const attaching = client.attach(7);
    await flushPromises();
    socket.receiveJson({ type: "replay", session_id: 7, start_offset: 0, data_b64: "" });
    const handle = await attaching;
    const input = Uint8Array.from(
      { length: MAX_INPUT_PAYLOAD + 17 },
      (_value, index) => index % 251,
    );
    const sentBefore = socket.sent.length;

    handle.sendInput(input);

    const chunks = socket.sent.slice(sentBefore).map((message) => {
      const frame = decodeFrame(message as ArrayBufferView);
      expect(frame.type).toBe("input");
      return frame.data;
    });
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([MAX_INPUT_PAYLOAD, 17]);
    const reconstructed = new Uint8Array(input.byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      reconstructed.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect([...reconstructed]).toEqual([...input]);
  });

  it("keeps the attachment active when detach send fails", async () => {
    const { client, socket } = await connect();
    const attaching = client.attach(7);
    await flushPromises();
    socket.receiveJson({ type: "replay", session_id: 7, start_offset: 0, data_b64: "" });
    const handle = await attaching;
    socket.failNextSend = true;

    expect(() => handle.detach()).toThrow(/injected send failure/);
    expect(() => handle.sendInput("x")).not.toThrow();
  });

  it("holds a detaching generation until a round-trip barrier", async () => {
    const { client, socket } = await connect();
    const oldOutput = vi.fn();
    const attaching = client.attach(7, { onOutput: oldOutput });
    await flushPromises();
    socket.receiveJson({ type: "replay", session_id: 7, start_offset: 0, data_b64: "" });
    const handle = await attaching;

    handle.detach();
    const blocked = client.attach(7);
    await flushPromises();
    expect(sentJson(socket).filter((message) => message.type === "attach")).toHaveLength(1);
    socket.receive(encodeFrame({
      type: "output",
      sessionId: 7,
      offset: 0n,
      data: new TextEncoder().encode("stale"),
    }));
    expect(oldOutput).not.toHaveBeenCalled();

    socket.receiveJson({ type: "sessions", sessions: [SESSION] });
    await expect(blocked).rejects.toThrow(/already attached/i);
    const freshOutput = vi.fn();
    const fresh = client.attach(7, { onOutput: freshOutput });
    await flushPromises();
    socket.receiveJson({
      type: "replay",
      session_id: 7,
      start_offset: 0,
      data_b64: base64("fresh"),
    });
    await fresh;
    expect(freshOutput).toHaveBeenCalledTimes(1);
  });

  it("rejects non-finite layouts before serialization", async () => {
    const { client, socket } = await connect();

    expect(() => client.setLayout({ ratio: Number.NaN })).toThrow(/finite JSON/i);
    expect(sentJson(socket).some((message) => message.type === "set_layout")).toBe(false);
  });

  it("reports an idle remote disconnect through the error channel", async () => {
    const { client, socket } = await connect();
    const errors = vi.fn();
    client.onError(errors);

    socket.remoteClose();

    expect(errors).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringMatching(/closed/i),
    }));
  });

  it("retains the latest error when no listener is registered", async () => {
    const { client, socket } = await connect();

    socket.remoteClose();

    const observable = client as unknown as { readonly lastError: Error | null };
    expect(observable.lastError).toEqual(expect.objectContaining({
      message: expect.stringMatching(/closed/i),
    }));
  });

  it("settles an attach closed before validation without wedging the queue", async () => {
    const { client, socket } = await connect();
    const closing = client.closeSession(7);
    const attaching = client.attach(7);
    await flushPromises();

    socket.receiveJson({ type: "session_closed", session_id: 7 });
    await expect(closing).resolves.toBeUndefined();
    await expect(attaching).rejects.toThrow(/closed/i);

    const next = client.attach(8);
    await flushPromises();
    expect(sentJson(socket).filter((message) =>
      message.type === "attach" && message.session_id === 8
    )).toHaveLength(0);

    socket.receiveJson({ type: "error", context: "attach", message: "no session 7" });
    expect(sentJson(socket).filter((message) =>
      message.type === "attach" && message.session_id === 8
    )).toHaveLength(1);
    socket.receiveJson({ type: "replay", session_id: 8, start_offset: 0, data_b64: "" });
    await expect(next).resolves.toMatchObject({ sessionId: 8 });
    expect(socket.closeCalls).toBe(0);
  });

  it("removes a queued attach when its session closes before send", async () => {
    const { client, socket } = await connect();
    const first = client.attach(70);
    const queued = client.attach(7);
    const closing = client.closeSession(7);
    await flushPromises();

    socket.receiveJson({ type: "session_closed", session_id: 7 });
    await expect(closing).resolves.toBeUndefined();
    await expect(queued).rejects.toThrow(/closed/i);
    socket.receiveJson({ type: "replay", session_id: 70, start_offset: 0, data_b64: "" });
    await first;

    expect(sentJson(socket).filter((message) =>
      message.type === "attach" && message.session_id === 7
    )).toHaveLength(0);
    const next = client.attach(8);
    await flushPromises();
    expect(sentJson(socket).filter((message) =>
      message.type === "attach" && message.session_id === 8
    )).toHaveLength(1);
    socket.receiveJson({ type: "replay", session_id: 8, start_offset: 0, data_b64: "" });
    await expect(next).resolves.toMatchObject({ sessionId: 8 });
  });
});

describe("HostClient attach resume cursor", () => {
  it("omits since_offset on a first attach and sends it on a resync", async () => {
    const { client, socket } = await connect();

    void client.attach(7);
    await flushPromises();
    expect(sentJson(socket).at(-1)).toEqual({
      type: "attach",
      session_id: 7,
      replay: true,
    });

    socket.receiveJson({ type: "replay", session_id: 7, start_offset: 0, data_b64: "" });
    void client.attach(8, {}, true, 4_096n);
    await flushPromises();
    expect(sentJson(socket).at(-1)).toEqual({
      type: "attach",
      session_id: 8,
      replay: true,
      since_offset: 4096,
    });
  });

  it("treats the cursor as already seen, so a resync replay is not a gap", async () => {
    const { client, socket } = await connect();
    const output: Array<{ offset: bigint; text: string }> = [];
    const gaps: Array<{ expectedOffset: bigint; receivedOffset: bigint }> = [];
    const attaching = client.attach(
      7,
      {
        onOutput: (event) =>
          output.push({ offset: event.offset, text: new TextDecoder().decode(event.data) }),
        onLostScrollback: (event) => gaps.push(event),
      },
      true,
      100n,
    );
    await flushPromises();

    socket.receiveJson({
      type: "replay",
      session_id: 7,
      start_offset: 100,
      data_b64: base64("abcd"),
    });
    const handle = await attaching;

    expect(gaps).toEqual([]);
    expect(output).toEqual([{ offset: 100n, text: "abcd" }]);
    expect(handle.nextOffset).toBe(104n);
  });

  it("reports a gap when the host had already evicted past the cursor", async () => {
    const { client, socket } = await connect();
    const gaps: Array<{ expectedOffset: bigint; receivedOffset: bigint }> = [];
    const attaching = client.attach(
      7,
      { onLostScrollback: (event) => gaps.push(event) },
      true,
      100n,
    );
    await flushPromises();

    socket.receiveJson({
      type: "replay",
      session_id: 7,
      start_offset: 500,
      data_b64: base64("late"),
    });
    await attaching;

    expect(gaps).toEqual([{ expectedOffset: 100n, receivedOffset: 500n }]);
  });

  it("trims a replay the host clamped back to an older ring start", async () => {
    const { client, socket } = await connect();
    const output: Array<{ offset: bigint; text: string }> = [];
    const attaching = client.attach(
      7,
      {
        onOutput: (event) =>
          output.push({ offset: event.offset, text: new TextDecoder().decode(event.data) }),
      },
      true,
      102n,
    );
    await flushPromises();

    socket.receiveJson({
      type: "replay",
      session_id: 7,
      start_offset: 100,
      data_b64: base64("abcdef"),
    });
    await attaching;

    expect(output).toEqual([{ offset: 102n, text: "cdef" }]);
  });

  it("refuses a cursor no JSON number can carry", async () => {
    const { client } = await connect();

    await expect(client.attach(7, {}, true, BigInt(Number.MAX_SAFE_INTEGER) + 1n))
      .rejects.toThrow(/safe integer/i);
    await expect(client.attach(7, {}, true, -1n)).rejects.toThrow(/safe integer/i);
  });
});

describe("HostClient scrollback history", () => {
  it("pages backward and decodes the slice the host answers with", async () => {
    const { client, socket } = await connect();

    const reading = client.readHistory(7, 4_096n, 65_536);
    await flushPromises();
    expect(sentJson(socket).at(-1)).toEqual({
      type: "read_history",
      session_id: 7,
      before_offset: 4096,
      max_bytes: 65536,
    });

    socket.receiveJson({
      type: "history",
      session_id: 7,
      start_offset: 4090,
      data_b64: base64("abcdef"),
      at_start: false,
    });

    const page = await reading;
    expect(page.startOffset).toBe(4090n);
    expect(new TextDecoder().decode(page.data)).toBe("abcdef");
    expect(page.atStart).toBe(false);
  });

  it("reports the start of history as an ordinary empty answer", async () => {
    const { client, socket } = await connect();

    const reading = client.readHistory(7, 0n, 65_536);
    await flushPromises();
    socket.receiveJson({
      type: "history",
      session_id: 7,
      start_offset: 0,
      data_b64: "",
      at_start: true,
    });

    await expect(reading).resolves.toEqual({
      startOffset: 0n,
      data: new Uint8Array(0),
      atStart: true,
    });
  });

  it("refuses a cursor no JSON number can carry", async () => {
    const { client } = await connect();

    await expect(client.readHistory(7, BigInt(Number.MAX_SAFE_INTEGER) + 1n, 1_024))
      .rejects.toThrow(/safe integer/i);
    await expect(client.readHistory(7, -1n, 1_024)).rejects.toThrow(/safe integer/i);
  });

  it("stays ordered behind another reply-bearing request", async () => {
    const { client, socket } = await connect();

    const sessions = client.listSessions();
    const reading = client.readHistory(7, 64n, 64);
    await flushPromises();
    expect(sentJson(socket).map((message) => message.type)).toEqual([
      "auth",
      "list_sessions",
    ]);

    socket.receiveJson({ type: "sessions", sessions: [SESSION] });
    await expect(sessions).resolves.toEqual([SESSION]);
    await flushPromises();
    expect(sentJson(socket).at(-1)?.type).toBe("read_history");

    socket.receiveJson({
      type: "history",
      session_id: 7,
      start_offset: 0,
      data_b64: base64("gh"),
      at_start: true,
    });
    await expect(reading).resolves.toMatchObject({ startOffset: 0n, atStart: true });
  });
});

describe("HostClient session probe", () => {
  it("asks the host and decodes its answer", async () => {
    const { client, socket } = await connect();

    const probing = client.probeSession(7);
    await flushPromises();
    expect(sentJson(socket).at(-1)).toEqual({
      type: "probe_session",
      session_id: 7,
    });

    socket.receiveJson({
      type: "session_probe",
      session_id: 7,
      alive: true,
      busy: false,
    });

    await expect(probing).resolves.toEqual({ alive: true, busy: false });
  });

  it("turns an old daemon's parse error into a rejection, not a hung queue", async () => {
    // A daemon that predates probe_session answers Error{context:"parse"}.
    // Without the parse branch that error matched nothing, the active request
    // never settled, and every later request queued behind it forever.
    const { client, socket } = await connect();

    const probing = client.probeSession(7);
    await flushPromises();
    socket.receiveJson({
      type: "error",
      context: "parse",
      message: "unknown variant `probe_session`",
    });

    await expect(probing).rejects.toThrow(/probe_session/);

    // The queue must keep flowing: the NEXT request still gets sent and
    // answered normally.
    const sessions = client.listSessions();
    await flushPromises();
    expect(sentJson(socket).at(-1)?.type).toBe("list_sessions");
    socket.receiveJson({ type: "sessions", sessions: [SESSION] });
    await expect(sessions).resolves.toEqual([SESSION]);
  });
});
