import {
  assertSessionId,
  decodeFrame,
  encodeFrame,
  MAX_INPUT_PAYLOAD,
} from "./frames";
import type { ClientMsg, HostMsg, JsonValue, SessionInfo } from "./protocol";

const OPEN = 1;
const TEXT_ENCODER = new TextEncoder();
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
  /** Inject the shell's OSC 9;9 cwd-reporting prompt hook. Omitted means ON,
   * matching the host's wire default. */
  shellIntegration?: boolean;
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
  replay: boolean;
  awaitingReplay: boolean;
  detaching: boolean;
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

  private latestError: Error | null = null;

  private readonly requestQueue: PendingRequest[] = [];
  private readonly attachments = new Map<number, AttachmentState>();
  private readonly attachQueue: AttachmentState[] = [];
  private readonly sessionExitedListeners = new Set<SessionExitedListener>();
  private readonly sessionClosedListeners = new Set<SessionClosedListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly messageListener: EventListener;
  private readonly errorListener: EventListener;
  private readonly closeListener: EventListener;
  private activeRequest: PendingRequest | null = null;
  private activeAttach: AttachmentState | null = null;
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

  get lastError(): Error | null {
    return this.latestError;
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
        shell_integration: options.shellIntegration ?? true,
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
    if (!isJsonValue(layout)) {
      throw new TypeError("layout must contain only finite JSON values");
    }
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
        nextOffset: replay ? 0n : null,
        replay,
        awaitingReplay: replay,
        detaching: false,
        detached: false,
        resolve,
        reject,
        handle,
      } satisfies AttachmentState);
      this.attachments.set(sessionId, state);
      this.attachQueue.push(state);
      this.pumpAttachments();
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
    this.terminate(new Error("Host connection closed"), true, false);
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

  private pumpAttachments() {
    if (this.activeAttach || this.closed) {
      return;
    }
    const next = this.attachQueue.shift();
    if (!next) {
      return;
    }
    this.activeAttach = next;
    try {
      this.sendJson({
        type: "attach",
        session_id: next.sessionId,
        replay: next.replay,
      });
    } catch {
      this.activeAttach = null;
      this.attachments.delete(next.sessionId);
      next.detached = true;
      next.reject(new Error("Unable to attach to the host session"));
      this.terminate(new Error("Host connection failed"), true);
      return;
    }

    if (!next.replay) {
      void this.listSessions().then(
        () => this.completeAttachment(next),
        (error: unknown) => this.failAttachment(next, asError(error)),
      );
    }
  }

  private completeAttachment(attachment: AttachmentState) {
    if (this.activeAttach !== attachment || attachment.detached) {
      return;
    }
    attachment.awaitingReplay = false;
    this.activeAttach = null;
    const resolve = attachment.resolve;
    attachment.resolve = () => undefined;
    attachment.reject = () => undefined;
    resolve(attachment.handle);
    this.pumpAttachments();
  }

  private failAttachment(attachment: AttachmentState, error: Error) {
    if (attachment.detached) {
      return;
    }
    if (this.activeAttach === attachment) {
      this.activeAttach = null;
    } else {
      const queuedIndex = this.attachQueue.indexOf(attachment);
      if (queuedIndex >= 0) {
        this.attachQueue.splice(queuedIndex, 1);
      }
    }
    this.attachments.delete(attachment.sessionId);
    attachment.detached = true;
    attachment.awaitingReplay = false;
    const reject = attachment.reject;
    attachment.resolve = () => undefined;
    attachment.reject = () => undefined;
    attachment.callbacks = {};
    reject(error);
    this.pumpAttachments();
  }

  private closeAttachment(sessionId: number) {
    const attachment = this.attachments.get(sessionId);
    if (!attachment) {
      return;
    }
    const error = new Error(`Session ${sessionId} closed before attachment completed`);

    if (this.activeAttach === attachment) {
      this.attachments.delete(sessionId);
      attachment.detached = true;
      attachment.awaitingReplay = false;
      const reject = attachment.reject;
      attachment.resolve = () => undefined;
      attachment.reject = () => undefined;
      attachment.callbacks = {};
      reject(error);
      return;
    }

    if (this.attachQueue.includes(attachment)) {
      this.failAttachment(attachment, error);
      return;
    }

    attachment.detached = true;
    attachment.detaching = false;
    attachment.callbacks = {};
    this.attachments.delete(sessionId);
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
        if (attachment && !attachment.detached && !attachment.detaching) {
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
        if (!attachment || attachment.detached || attachment.detaching) {
          return;
        }
        const data = decodeBase64(message.data_b64);
        this.deliverOutput(attachment, BigInt(message.start_offset), data, "replay");
        if (attachment.awaitingReplay) {
          if (this.activeAttach !== attachment) {
            throw new Error("replay arrived for an attachment that was not sent");
          }
          this.completeAttachment(attachment);
        }
        return;
      }
      case "session_exited": {
        this.invokeConsumer(
          this.attachments.get(message.session_id)?.callbacks.onExit,
          [message.exit_code],
        );
        const event = { sessionId: message.session_id, exitCode: message.exit_code };
        for (const listener of this.sessionExitedListeners) {
          this.invokeConsumer(listener, [event]);
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
        this.closeAttachment(message.session_id);
        for (const listener of this.sessionClosedListeners) {
          this.invokeConsumer(listener, [{ sessionId: message.session_id }]);
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

    if (context === "attach" && this.activeAttach) {
      if (this.activeAttach.detached) {
        this.activeAttach = null;
        this.pumpAttachments();
        return;
      }
      this.failAttachment(
        this.activeAttach,
        new Error(`Host request failed (attach): ${this.redact(message)}`),
      );
      return;
    }

    if (active && REQUEST_CONTEXTS.has(context)) {
      active.reject(new Error("Host sent an unexpected request error"));
      this.activeRequest = null;
      this.terminate(new Error("Host sent an unexpected request error"), true);
      return;
    }

    const error = new Error(`Host error (${context}): ${this.redact(message)}`);
    this.emitError(error);
  }

  private deliverOutput(
    attachment: AttachmentState,
    offset: bigint,
    data: Uint8Array,
    source: SessionOutputEvent["source"],
  ) {
    const end = offset + BigInt(data.byteLength);
    const expected = attachment.nextOffset;
    if (expected === null || offset > expected) {
      if (expected !== null) {
        this.invokeConsumer(attachment.callbacks.onLostScrollback, [{
          expectedOffset: expected,
          receivedOffset: offset,
        }]);
      }
      attachment.nextOffset = end;
      if (data.byteLength > 0) {
        this.invokeConsumer(attachment.callbacks.onOutput, [{ offset, data, source }]);
      }
      return;
    }

    if (end <= expected) {
      return;
    }

    const overlap = Number(expected - offset);
    const remaining = data.subarray(overlap);
    attachment.nextOffset = end;
    this.invokeConsumer(attachment.callbacks.onOutput, [{
      offset: expected,
      data: remaining,
      source,
    }]);
  }

  private sendInput(attachment: AttachmentState, data: string | Uint8Array) {
    this.assertAttachmentActive(attachment);
    const bytes = typeof data === "string" ? TEXT_ENCODER.encode(data) : data;
    if (bytes.byteLength === 0) {
      this.sendBinary(encodeFrame({
        type: "input",
        sessionId: attachment.sessionId,
        data: bytes,
      }));
      return;
    }
    for (let start = 0; start < bytes.byteLength; start += MAX_INPUT_PAYLOAD) {
      this.sendBinary(encodeFrame({
        type: "input",
        sessionId: attachment.sessionId,
        data: bytes.subarray(start, start + MAX_INPUT_PAYLOAD),
      }));
    }
  }

  private resizeAttachment(attachment: AttachmentState, cols: number, rows: number) {
    this.assertAttachmentActive(attachment);
    assertDimensions(cols, rows);
    this.sendJson({ type: "resize", session_id: attachment.sessionId, cols, rows });
  }

  private detachAttachment(attachment: AttachmentState) {
    if (attachment.detached || attachment.detaching) {
      return;
    }
    this.assertConnectionOpen();
    this.sendJson({ type: "detach", session_id: attachment.sessionId });
    attachment.detaching = true;
    attachment.awaitingReplay = false;
    queueMicrotask(() => {
      if (this.closed || attachment.detached) {
        return;
      }
      void this.listSessions().then(
        () => this.finalizeDetach(attachment),
        (error: unknown) => this.terminate(asError(error), true),
      );
    });
  }

  private finalizeDetach(attachment: AttachmentState) {
    if (attachment.detached) {
      return;
    }
    attachment.detached = true;
    attachment.detaching = false;
    this.attachments.delete(attachment.sessionId);
    attachment.callbacks = {};
    attachment.resolve = () => undefined;
    attachment.reject = () => undefined;
  }

  private assertAttachmentActive(attachment: AttachmentState) {
    if (
      attachment.detached
      || attachment.detaching
      || this.attachments.get(attachment.sessionId) !== attachment
    ) {
      throw new Error("Session attachment is detached");
    }
    this.assertConnectionOpen();
  }

  private sendJson(message: ClientMsg) {
    this.assertConnectionOpen();
    this.socket.send(JSON.stringify(message));
  }

  private sendBinary(data: Uint8Array<ArrayBuffer>) {
    this.assertConnectionOpen();
    this.socket.send(data.buffer);
  }

  private assertConnectionOpen() {
    if (this.closed || this.socket.readyState !== OPEN) {
      throw new Error("Host connection is closed");
    }
  }

  private redact(message: string) {
    return this.token.length === 0 ? message : message.split(this.token).join("[redacted]");
  }

  private invokeConsumer<TArgs extends unknown[]>(
    callback: ((...args: TArgs) => void) | undefined,
    args: TArgs,
  ) {
    if (!callback) {
      return;
    }
    try {
      callback(...args);
    } catch (cause) {
      this.emitError(new Error("Host client callback failed", { cause }));
    }
  }

  private emitError(error: Error) {
    this.latestError = error;
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch (listenerError) {
        console.error("HostClient error listener failed", listenerError);
      }
    }
  }

  private terminate(error: Error, closeSocket: boolean, reportError = true) {
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

    const attachments = [...this.attachments.values()];
    this.attachments.clear();
    this.attachQueue.splice(0);
    this.activeAttach = null;
    for (const attachment of attachments) {
      attachment.detached = true;
      attachment.detaching = false;
      attachment.awaitingReplay = false;
      attachment.reject(error);
      attachment.resolve = () => undefined;
      attachment.reject = () => undefined;
    }

    if (closeSocket && this.socket.readyState !== 3) {
      this.socket.close();
    }
    if (reportError) {
      this.emitError(error);
    }
    for (const attachment of attachments) {
      this.invokeConsumer(attachment.callbacks.onDisconnect, []);
      attachment.callbacks = {};
    }

    this.sessionExitedListeners.clear();
    this.sessionClosedListeners.clear();
    this.errorListeners.clear();
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

function assertDimensions(cols: number, rows: number) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 0xffff || rows > 0xffff) {
    throw new RangeError("terminal dimensions must fit positive unsigned 16-bit integers");
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Host transport failed");
}
