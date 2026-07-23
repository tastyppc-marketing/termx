import { decodeFrame, encodeFrame } from "./frames";
import type { ClientMsg, HostMsg, JsonValue, SessionInfo } from "./protocol";

const OPEN = 1;
const REQUEST_CONTEXTS = new Set([
  "create_session",
  "close_session",
  "list_sessions",
  "set_layout",
  "get_state",
]);

type WebSocketFactory = (url: string) => WebSocket;
type ReplyType = "session_created" | "session_closed" | "sessions" | "layout_saved" | "state";

export interface HostClientConnectOptions {
  port: number;
  token: string;
  webSocketFactory?: WebSocketFactory;
}

export interface CreateSessionOptions {
  profile: string | null;
  cwd: string | null;
  cols: number;
  rows: number;
}

export interface HostState {
  layout: JsonValue;
  sessions: SessionInfo[];
}

export interface SessionOutputEvent {
  offset: bigint;
  data: Uint8Array;
  source: "replay" | "live";
}

export interface LostScrollbackEvent {
  expectedOffset: bigint;
  receivedOffset: bigint;
}

export interface SessionAttachmentCallbacks {
  onOutput?: (event: SessionOutputEvent) => void;
  onLostScrollback?: (event: LostScrollbackEvent) => void;
  onExit?: (exitCode: number | null) => void;
  onDisconnect?: () => void;
}

export interface SessionAttachment {
  readonly sessionId: number;
  readonly nextOffset: bigint | null;
  sendInput(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  detach(): void;
}

interface PendingRequest {
  context: string;
  replyType: ReplyType;
  message: ClientMsg;
  map: (message: HostMsg) => unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface AttachmentState {
  sessionId: number;
  callbacks: SessionAttachmentCallbacks;
  nextOffset: bigint | null;
  awaitingReplay: boolean;
  detached: boolean;
  resolve: (handle: SessionAttachment) => void;
  reject: (error: Error) => void;
  handle: SessionAttachment;
}

type SessionExitedListener = (event: { sessionId: number; exitCode: number | null }) => void;
type SessionClosedListener = (event: { sessionId: number }) => void;
type ErrorListener = (error: Error) => void;

export class HostClient {
  readonly version: string;
  readonly initialSessions: SessionInfo[];

  private readonly requestQueue: PendingRequest[] = [];
  private readonly attachments = new Map<number, AttachmentState>();
  private readonly sessionExitedListeners = new Set<SessionExitedListener>();
  private readonly sessionClosedListeners = new Set<SessionClosedListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly messageListener: EventListener;
  private readonly errorListener: EventListener;
  private readonly closeListener: EventListener;
  private activeRequest: PendingRequest | null = null;
  private closed = false;

  private constructor(
    private readonly socket: WebSocket,
    private readonly token: string,
    version: string,
    initialSessions: SessionInfo[],
  ) {
    this.version = version;
    this.initialSessions = initialSessions;
    this.messageListener = (event) => this.receiveMessage(event as MessageEvent);
    this.errorListener = () => this.terminate(new Error("Host connection failed"), false);
    this.closeListener = () => this.terminate(new Error("Host connection closed"), false);
    socket.addEventListener("message", this.messageListener);
    socket.addEventListener("error", this.errorListener);
    socket.addEventListener("close", this.closeListener);
  }

  static connect(options: HostClientConnectOptions): Promise<HostClient> {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
      return Promise.reject(new RangeError("host port must be an integer from 1 through 65535"));
    }
    if (options.token.length === 0) {
      return Promise.reject(new Error("host token must not be empty"));
    }

    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        const factory = options.webSocketFactory ?? ((url: string) => new WebSocket(url));
        socket = factory(`ws://127.0.0.1:${options.port}`);
      } catch {
        reject(new Error("Unable to create the host connection"));
        return;
      }

      socket.binaryType = "arraybuffer";
      let settled = false;

      // The host closes half-open handshakes after 10s; this shorter client
      // deadline also covers a foreign listener that accepts and says nothing.
      const authDeadline = setTimeout(() => fail("Host authentication timed out"), 5_000);

      const removeBootstrapListeners = () => {
        clearTimeout(authDeadline);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onFailure);
        socket.removeEventListener("close", onFailure);
      };
      const fail = (message: string) => {
        if (settled) {
          return;
        }
        settled = true;
        removeBootstrapListeners();
        reject(new Error(message));
        socket.close();
      };
      const onOpen: EventListener = () => {
        try {
          socket.send(JSON.stringify({ type: "auth", token: options.token } satisfies ClientMsg));
        } catch {
          fail("Unable to authenticate with the host");
        }
      };
      const onMessage: EventListener = (event) => {
        const messageEvent = event as MessageEvent;
        if (typeof messageEvent.data !== "string") {
          fail("Host sent an invalid authentication response");
          return;
        }

        let message: HostMsg;
        try {
          message = parseHostMessage(messageEvent.data);
        } catch {
          fail("Host sent an invalid authentication response");
          return;
        }

        if (message.type === "auth_err") {
          fail("Host authentication rejected");
          return;
        }
        if (message.type !== "auth_ok") {
          fail("Host sent an unexpected authentication response");
          return;
        }

        settled = true;
        removeBootstrapListeners();
        resolve(new HostClient(socket, options.token, message.version, message.sessions));
      };
      const onFailure: EventListener = () => fail("Unable to connect to the host");

      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onFailure);
      socket.addEventListener("close", onFailure);
    });
  }

  createSession(options: CreateSessionOptions): Promise<SessionInfo> {
    assertDimensions(options.cols, options.rows);
    return this.request(
      {
        type: "create_session",
        profile: options.profile,
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
      },
      "create_session",
      "session_created",
      (message) => {
        if (message.type !== "session_created") {
          throw new Error("unreachable reply type");
        }
        return message.info;
      },
    );
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.request(
      { type: "list_sessions" },
      "list_sessions",
      "sessions",
      (message) => {
        if (message.type !== "sessions") {
          throw new Error("unreachable reply type");
        }
        return message.sessions;
      },
    );
  }

  setLayout(layout: JsonValue): Promise<void> {
    return this.request(
      { type: "set_layout", layout },
      "set_layout",
      "layout_saved",
      () => undefined,
    );
  }

  getState(): Promise<HostState> {
    return this.request(
      { type: "get_state" },
      "get_state",
      "state",
      (message) => {
        if (message.type !== "state") {
          throw new Error("unreachable reply type");
        }
        return { layout: message.layout, sessions: message.sessions };
      },
    );
  }

  closeSession(sessionId: number): Promise<void> {
    assertSessionId(sessionId);
    return this.request(
      { type: "close_session", session_id: sessionId },
      "close_session",
      "session_closed",
      () => undefined,
    );
  }

  /// CONSTRAINT: attach calls must be issued SEQUENTIALLY (await each before
  /// the next). Host attach errors carry only a context string — no session
  /// id — so a failure among concurrent pending attaches is ambiguous and
  /// tears down the connection as a protocol violation. Boot-time attach-all
  /// loops must `await` one attach at a time.
  attach(
    sessionId: number,
    callbacks: SessionAttachmentCallbacks = {},
    replay = true,
  ): Promise<SessionAttachment> {
    assertSessionId(sessionId);
    if (this.closed) {
      return Promise.reject(new Error("Host connection is closed"));
    }
    if (this.attachments.has(sessionId)) {
      return Promise.reject(new Error(`Session ${sessionId} is already attached`));
    }

    return new Promise((resolve, reject) => {
      const state = {} as AttachmentState;
      const handle: SessionAttachment = {
        sessionId,
        get nextOffset() {
          return state.nextOffset;
        },
        sendInput: (data) => this.sendInput(state, data),
        resize: (cols, rows) => this.resizeAttachment(state, cols, rows),
        detach: () => this.detachAttachment(state),
      };
      Object.assign(state, {
        sessionId,
        callbacks,
        nextOffset: null,
        awaitingReplay: replay,
        detached: false,
        resolve,
        reject,
        handle,
      } satisfies AttachmentState);
      this.attachments.set(sessionId, state);

      try {
        this.sendJson({ type: "attach", session_id: sessionId, replay });
      } catch (error) {
        this.attachments.delete(sessionId);
        reject(asError(error));
        return;
      }

      if (!replay) {
        resolve(handle);
      }
    });
  }

  onSessionExited(listener: SessionExitedListener): () => void {
    this.sessionExitedListeners.add(listener);
    return () => this.sessionExitedListeners.delete(listener);
  }

  onSessionClosed(listener: SessionClosedListener): () => void {
    this.sessionClosedListeners.add(listener);
    return () => this.sessionClosedListeners.delete(listener);
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  shutdown(): void {
    this.sendJson({ type: "shutdown" });
  }

  close(): void {
    this.terminate(new Error("Host connection closed"), true);
  }

  private request<T>(
    message: ClientMsg,
    context: string,
    replyType: ReplyType,
    map: (message: HostMsg) => T,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("Host connection is closed"));
    }

    return new Promise<T>((resolve, reject) => {
      this.requestQueue.push({
        message,
        context,
        replyType,
        map,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.pumpRequests();
    });
  }

  private pumpRequests() {
    if (this.activeRequest || this.closed) {
      return;
    }
    const next = this.requestQueue.shift();
    if (!next) {
      return;
    }
    this.activeRequest = next;
    try {
      this.sendJson(next.message);
    } catch (error) {
      this.activeRequest = null;
      next.reject(asError(error));
      this.terminate(new Error("Host connection failed"), true);
    }
  }

  private receiveMessage(event: MessageEvent) {
    try {
      if (typeof event.data === "string") {
        this.receiveControl(parseHostMessage(event.data));
        return;
      }
      if (event.data instanceof ArrayBuffer || ArrayBuffer.isView(event.data)) {
        const frame = decodeFrame(event.data);
        if (frame.type !== "output") {
          throw new Error("host sent an input frame");
        }
        const attachment = this.attachments.get(frame.sessionId);
        if (attachment && !attachment.detached) {
          this.deliverOutput(attachment, frame.offset, frame.data, "live");
        }
        return;
      }
      throw new Error("unsupported WebSocket message data");
    } catch {
      this.terminate(new Error("Host sent an invalid message"), true);
    }
  }

  private receiveControl(message: HostMsg) {
    switch (message.type) {
      case "replay": {
        const attachment = this.attachments.get(message.session_id);
        if (!attachment || attachment.detached) {
          return;
        }
        const data = decodeBase64(message.data_b64);
        this.deliverOutput(attachment, BigInt(message.start_offset), data, "replay");
        if (attachment.awaitingReplay) {
          attachment.awaitingReplay = false;
          attachment.resolve(attachment.handle);
        }
        return;
      }
      case "session_exited": {
        this.attachments.get(message.session_id)?.callbacks.onExit?.(message.exit_code);
        const event = { sessionId: message.session_id, exitCode: message.exit_code };
        for (const listener of this.sessionExitedListeners) {
          listener(event);
        }
        return;
      }
      case "error":
        this.receiveHostError(message.context, message.message);
        return;
      case "auth_ok":
      case "auth_err":
        throw new Error("unexpected authentication message");
      case "session_created":
      case "sessions":
      case "layout_saved":
      case "state":
        this.receiveReply(message);
        return;
      case "session_closed":
        this.receiveReply(message);
        this.attachments.delete(message.session_id);
        for (const listener of this.sessionClosedListeners) {
          listener({ sessionId: message.session_id });
        }
        return;
    }
  }

  private receiveReply(message: Extract<HostMsg, { type: ReplyType }>) {
    const active = this.activeRequest;
    if (!active || active.replyType !== message.type) {
      throw new Error("unexpected host reply");
    }

    this.activeRequest = null;
    try {
      active.resolve(active.map(message));
    } catch {
      active.reject(new Error("Host sent an invalid reply"));
    }
    this.pumpRequests();
  }

  private receiveHostError(context: string, message: string) {
    const active = this.activeRequest;
    if (active && active.context === context) {
      this.activeRequest = null;
      active.reject(new Error(`Host request failed (${context}): ${this.redact(message)}`));
      this.pumpRequests();
      return;
    }

    if (context === "attach") {
      const pending = [...this.attachments.values()].filter((item) => item.awaitingReplay);
      if (pending.length === 1) {
        const [attachment] = pending;
        if (!attachment) {
          throw new Error("missing attachment");
        }
        this.attachments.delete(attachment.sessionId);
        attachment.reject(new Error(`Host request failed (attach): ${this.redact(message)}`));
        return;
      }
      if (pending.length > 1) {
        throw new Error("ambiguous attach error");
      }
    }

    if (active && REQUEST_CONTEXTS.has(context)) {
      active.reject(new Error("Host sent an unexpected request error"));
      this.activeRequest = null;
      this.terminate(new Error("Host sent an unexpected request error"), true);
      return;
    }

    const error = new Error(`Host error (${context}): ${this.redact(message)}`);
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }

  private deliverOutput(
    attachment: AttachmentState,
    offset: bigint,
    data: Uint8Array,
    source: SessionOutputEvent["source"],
  ) {
    const end = offset + BigInt(data.byteLength);
    const expected = attachment.nextOffset;
    if (expected === null) {
      attachment.nextOffset = end;
      if (data.byteLength > 0) {
        attachment.callbacks.onOutput?.({ offset, data, source });
      }
      return;
    }

    if (offset > expected) {
      attachment.callbacks.onLostScrollback?.({ expectedOffset: expected, receivedOffset: offset });
      attachment.nextOffset = end;
      if (data.byteLength > 0) {
        attachment.callbacks.onOutput?.({ offset, data, source });
      }
      return;
    }

    if (end <= expected) {
      return;
    }

    const overlap = Number(expected - offset);
    const remaining = data.slice(overlap);
    attachment.nextOffset = end;
    attachment.callbacks.onOutput?.({ offset: expected, data: remaining, source });
  }

  private sendInput(attachment: AttachmentState, data: string | Uint8Array) {
    this.assertAttachmentActive(attachment);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.sendBinary(encodeFrame({ type: "input", sessionId: attachment.sessionId, data: bytes }));
  }

  private resizeAttachment(attachment: AttachmentState, cols: number, rows: number) {
    this.assertAttachmentActive(attachment);
    assertDimensions(cols, rows);
    this.sendJson({ type: "resize", session_id: attachment.sessionId, cols, rows });
  }

  private detachAttachment(attachment: AttachmentState) {
    if (attachment.detached) {
      return;
    }
    this.assertConnectionOpen();
    attachment.detached = true;
    this.attachments.delete(attachment.sessionId);
    this.sendJson({ type: "detach", session_id: attachment.sessionId });
    if (attachment.awaitingReplay) {
      attachment.awaitingReplay = false;
      attachment.reject(new Error("Attachment detached before replay"));
    }
  }

  private assertAttachmentActive(attachment: AttachmentState) {
    if (attachment.detached || this.attachments.get(attachment.sessionId) !== attachment) {
      throw new Error("Session attachment is detached");
    }
    this.assertConnectionOpen();
  }

  private sendJson(message: ClientMsg) {
    this.assertConnectionOpen();
    this.socket.send(JSON.stringify(message));
  }

  private sendBinary(data: Uint8Array) {
    this.assertConnectionOpen();
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    this.socket.send(copy.buffer);
  }

  private assertConnectionOpen() {
    if (this.closed || this.socket.readyState !== OPEN) {
      throw new Error("Host connection is closed");
    }
  }

  private redact(message: string) {
    return this.token.length === 0 ? message : message.split(this.token).join("[redacted]");
  }

  private terminate(error: Error, closeSocket: boolean) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket.removeEventListener("message", this.messageListener);
    this.socket.removeEventListener("error", this.errorListener);
    this.socket.removeEventListener("close", this.closeListener);

    this.activeRequest?.reject(error);
    this.activeRequest = null;
    for (const request of this.requestQueue.splice(0)) {
      request.reject(error);
    }
    for (const attachment of this.attachments.values()) {
      if (attachment.awaitingReplay) {
        attachment.reject(error);
      }
      attachment.callbacks.onDisconnect?.();
      attachment.detached = true;
    }
    this.attachments.clear();

    if (closeSocket && this.socket.readyState !== 3) {
      this.socket.close();
    }
  }
}

function parseHostMessage(text: string): HostMsg {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("host message must be an object with a type");
  }

  switch (value.type) {
    case "auth_ok":
      return { type: value.type, version: stringField(value, "version"), sessions: sessionsField(value) };
    case "auth_err":
      return { type: value.type, reason: stringField(value, "reason") };
    case "session_created":
      return { type: value.type, info: parseSessionInfo(value.info) };
    case "replay":
      return {
        type: value.type,
        session_id: u32Field(value, "session_id"),
        start_offset: safeUnsignedField(value, "start_offset"),
        data_b64: stringField(value, "data_b64"),
      };
    case "session_exited":
      return {
        type: value.type,
        session_id: u32Field(value, "session_id"),
        exit_code: value.exit_code === null ? null : u32Field(value, "exit_code"),
      };
    case "session_closed":
      return { type: value.type, session_id: u32Field(value, "session_id") };
    case "sessions":
      return { type: value.type, sessions: sessionsField(value) };
    case "layout_saved":
      return { type: value.type };
    case "state":
      return { type: value.type, layout: jsonField(value, "layout"), sessions: sessionsField(value) };
    case "error":
      return {
        type: value.type,
        context: stringField(value, "context"),
        message: stringField(value, "message"),
      };
    default:
      throw new Error("unknown host message type");
  }
}

function parseSessionInfo(value: unknown): SessionInfo {
  if (!isRecord(value)) {
    throw new Error("session info must be an object");
  }
  return {
    id: u32Field(value, "id"),
    profile: stringField(value, "profile"),
    cwd: nullableStringField(value, "cwd"),
    cols: u16Field(value, "cols"),
    rows: u16Field(value, "rows"),
    alive: booleanField(value, "alive"),
    pid: value.pid === null || value.pid === undefined ? null : u32Field(value, "pid"),
  };
}

function sessionsField(value: Record<string, unknown>): SessionInfo[] {
  if (!Array.isArray(value.sessions)) {
    throw new Error("sessions must be an array");
  }
  return value.sessions.map(parseSessionInfo);
}

function decodeBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("invalid replay encoding");
  }
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return field;
}

function nullableStringField(value: Record<string, unknown>, key: string): string | null {
  return value[key] === null ? null : stringField(value, key);
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return field;
}

function u32Field(value: Record<string, unknown>, key: string): number {
  const field = safeUnsignedField(value, key);
  if (field > 0xffff_ffff) {
    throw new Error(`${key} exceeds u32`);
  }
  return field;
}

function u16Field(value: Record<string, unknown>, key: string): number {
  const field = safeUnsignedField(value, key);
  if (field > 0xffff) {
    throw new Error(`${key} exceeds u16`);
  }
  return field;
}

function safeUnsignedField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (!Number.isSafeInteger(field) || (field as number) < 0) {
    throw new Error(`${key} must be a safe unsigned integer`);
  }
  return field as number;
}

function jsonField(value: Record<string, unknown>, key: string): JsonValue {
  const field = value[key];
  if (!isJsonValue(field)) {
    throw new Error(`${key} must be JSON`);
  }
  return field;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function assertSessionId(sessionId: number) {
  if (!Number.isInteger(sessionId) || sessionId < 0 || sessionId > 0xffff_ffff) {
    throw new RangeError("session id must fit an unsigned 32-bit integer");
  }
}

function assertDimensions(cols: number, rows: number) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 0xffff || rows > 0xffff) {
    throw new RangeError("terminal dimensions must fit positive unsigned 16-bit integers");
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Host transport failed");
}
