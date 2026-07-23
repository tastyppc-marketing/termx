import { describe, expect, it, vi } from "vitest";
import { HostClient } from "../client";
import { decodeFrame, encodeFrame } from "../frames";
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
      { expectedOffset: 109n, receivedOffset: 120n },
    ]);
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
