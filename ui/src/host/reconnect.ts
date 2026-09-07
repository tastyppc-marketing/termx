import type { HostClient } from "./client";

/**
 * Keeps a connection to the daemon alive for weeks.
 *
 * `HostClient` is deliberately one-shot: it dies on the first transport error
 * and never comes back. This wrapper owns that lifecycle — it holds the current
 * client, notices when it dies, and reconnects on a step table until it wins.
 * It never gives up, because the alternative Michael actually lived through was
 * a UI that had zero sockets and answered every "new terminal" with an error.
 *
 * Two rules shape everything here:
 *  - A connection counts only when it is PROVEN. `connect()` resolves only
 *    after auth_ok, so a TCP handshake that never authenticates is a failure
 *    and does not reset the attempt counter.
 *  - Requests fail, they never queue. A queued request would resolve minutes
 *    later against a world that has moved on; the UI shows the reconnecting
 *    state instead.
 */

/** Step table for ordinary transport failures; the last step repeats forever. */
export const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000] as const;

/**
 * Slow table for failures a retry storm cannot fix: a rejected token (the
 * daemon restarted with a new one) or a bootstrap that could not produce a
 * host at all. Each attempt re-runs the full bootstrap chain, so these are
 * expensive as well as unlikely to succeed twice in a row.
 */
export const AUTH_BACKOFF_MS = [5_000, 15_000, 30_000] as const;

/**
 * A reconnect may not happen sooner than this after the LAST successful
 * connection, so a crash-looping daemon cannot drive a reconnect storm. It
 * expires on its own as wall-clock time passes, which is why it needs no
 * separate reset.
 */
export const ANTI_FLAP_FLOOR_MS = 30_000;

/** The daemon is local. A request outstanding this long is not slow, it is stuck. */
export const REQUEST_TIMEOUT_MS = 120_000;

/** Thrown by `request` instead of waiting for a connection that may never come. */
export class HostDisconnectedError extends Error {
  readonly kind = "host-disconnected";

  constructor(message = "The TermX host is not connected") {
    super(message);
    this.name = "HostDisconnectedError";
  }
}

/**
 * The bootstrap chain (read runtime.json, spawn the daemon if needed) failed,
 * as opposed to the socket failing. This is the one failure a human can act on,
 * so it surfaces as `failed` with a retry action — while the machine keeps
 * retrying underneath regardless.
 */
export class HostBootstrapError extends Error {
  readonly kind = "host-bootstrap-failed";

  constructor(message: string) {
    super(message);
    this.name = "HostBootstrapError";
  }
}

export type ConnectionState =
  | { phase: "connecting"; isInitial: boolean }
  | { phase: "connected" }
  | { phase: "reconnecting"; attempt: number; nextDelayMs: number }
  | { phase: "failed"; reason: string };

/** All the machine needs of a client: to hear it die, and to close it. */
export interface ReconnectableClient {
  onError(listener: (error: Error) => void): () => void;
  close(): void;
}

export interface ReconnectOptions<TClient extends ReconnectableClient = HostClient> {
  /** The FULL bootstrap chain: re-read runtime.json (port and token change when
   * the daemon restarts), spawn the daemon if needed, connect, authenticate. */
  connect: () => Promise<TClient>;
  /**
   * A connection that is already proven. Boot keeps its own failure path (a
   * workspace that cannot start says so instead of silently retrying behind a
   * blank screen), and hands the machine the client it ended up with.
   */
  initialClient?: TClient;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
}

export type ConnectionStateListener = (state: ConnectionState) => void;
export type ConnectedListener<TClient extends ReconnectableClient = HostClient> = (
  client: TClient,
  isReconnect: boolean,
) => void;

/**
 * Errors that mean the client is finished, as opposed to one request failing.
 * `HostClient` reports these through `onError` on its way to terminating and
 * rejects everything in flight with the same message.
 */
const TERMINAL_CLIENT_ERRORS = [
  "Host connection closed",
  "Host connection failed",
  "Host connection is closed",
  "Host sent an invalid message",
  "Host sent an unexpected request error",
];

export function isTerminalClientError(error: unknown): boolean {
  return (
    error instanceof Error
    && TERMINAL_CLIENT_ERRORS.some((message) => error.message.includes(message))
  );
}

/** The daemon refused our token — reconnecting fast cannot help. */
function isAuthRejection(error: unknown): boolean {
  return error instanceof Error && /authentication rejected/i.test(error.message);
}

export class ReconnectingHostClient<TClient extends ReconnectableClient = HostClient> {
  private currentState: ConnectionState;
  private client: TClient | null = null;
  private stopClientErrors: (() => void) | null = null;
  private cancelTimer: (() => void) | null = null;
  private readonly stateListeners = new Set<ConnectionStateListener>();
  private readonly connectedListeners = new Set<ConnectedListener<TClient>>();
  /** Consecutive failures since the last proven connection. */
  private attempt = 0;
  private table: readonly number[] = RECONNECT_BACKOFF_MS;
  private connectedAt: number | null = null;
  private hasConnected = false;
  /** Asleep: hold every retry rather than burning the table on a frozen CPU. */
  private frozen = false;
  private connecting = false;
  private disposed = false;

  private constructor(private readonly options: ReconnectOptions<TClient>) {
    this.currentState = { phase: "connecting", isInitial: true };
  }

  static start<TClient extends ReconnectableClient = HostClient>(
    options: ReconnectOptions<TClient>,
  ): ReconnectingHostClient<TClient> {
    const machine = new ReconnectingHostClient<TClient>(options);
    if (options.initialClient) {
      // Adopt it synchronously: callers that bootstrapped their own connection
      // must be able to use it on the very next line.
      machine.handleConnected(options.initialClient);
      return machine;
    }
    machine.attemptConnect(true);
    return machine;
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  /** The live client, or null whenever the connection is not proven. */
  get currentClient(): TClient | null {
    return this.currentState.phase === "connected" ? this.client : null;
  }

  onStateChange(listener: ConnectionStateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onConnected(listener: ConnectedListener<TClient>): () => void {
    this.connectedListeners.add(listener);
    return () => this.connectedListeners.delete(listener);
  }

  /**
   * Run one request against the live client. Rejects immediately with
   * `HostDisconnectedError` when there is no connection — callers surface the
   * reconnecting state rather than an error, and nothing is ever queued.
   */
  request<T>(call: (client: TClient) => Promise<T>): Promise<T> {
    const client = this.currentClient;
    if (!client) {
      return Promise.reject(new HostDisconnectedError());
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cancel = this.schedule(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(
          new HostDisconnectedError(
            `The host did not answer within ${REQUEST_TIMEOUT_MS / 1_000}s`,
          ),
        );
        // HostClient serializes requests. Retiring this exact transport drains
        // anything queued behind the stalled call so it cannot execute later.
        this.handleClientDeath(client, true);
      }, REQUEST_TIMEOUT_MS);

      let request: Promise<T>;
      try {
        request = call(client);
      } catch (error: unknown) {
        settled = true;
        cancel();
        if (isTerminalClientError(error)) {
          this.handleClientDeath(client);
        }
        reject(error instanceof Error ? error : new Error("Host request failed"));
        return;
      }

      request.then(
        (value) => {
          if (settled) {
            return;
          }
          settled = true;
          cancel();
          resolve(value);
        },
        (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          cancel();
          if (isTerminalClientError(error)) {
            this.handleClientDeath(client);
          }
          reject(error instanceof Error ? error : new Error("Host request failed"));
        },
      );
    });
  }

  /**
   * The machine is going to sleep. Close the socket NOW: one that dies while
   * the CPU is frozen is never noticed by a read loop, and every later request
   * would fail against a corpse. Retries are frozen too — a table walked while
   * asleep would land on its slowest step by the time anyone wakes up.
   */
  notifySuspend(): void {
    if (this.disposed || this.frozen) {
      return;
    }
    this.frozen = true;
    this.cancelPending();
    this.releaseClient(true);
    this.setState({
      phase: "reconnecting",
      attempt: this.attempt,
      // Frozen: nothing is counting down.
      nextDelayMs: 0,
    });
  }

  /** Awake: reconnect at once, subject only to the anti-flap floor. */
  notifyResume(): void {
    if (this.disposed || !this.frozen) {
      return;
    }
    this.frozen = false;
    this.cancelPending();
    const wait = this.antiFlapRemainder();
    if (wait === 0) {
      this.attemptConnect(false);
      return;
    }
    this.waitThenConnect(wait, {
      phase: "reconnecting",
      attempt: this.attempt,
      nextDelayMs: wait,
    });
  }

  /**
   * The user asked, explicitly (the "Restart host" action). Bypasses the
   * backoff AND the anti-flap floor: a person waiting on a button press is not
   * a crash loop.
   */
  retryNow(): void {
    if (this.disposed || this.currentState.phase === "connected") {
      return;
    }
    this.frozen = false;
    this.cancelPending();
    this.attemptConnect(false);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelPending();
    this.releaseClient(true);
    this.stateListeners.clear();
    this.connectedListeners.clear();
  }

  private attemptConnect(isInitial: boolean): void {
    if (this.disposed || this.connecting) {
      return;
    }
    this.cancelPending();
    this.connecting = true;
    this.setState({ phase: "connecting", isInitial });
    this.options.connect().then(
      (client) => this.handleConnected(client),
      (error: unknown) => this.handleConnectFailure(error),
    );
  }

  private handleConnected(client: TClient): void {
    this.connecting = false;
    // Disposed, or we fell asleep mid-handshake: this socket is already doomed.
    if (this.disposed || this.frozen) {
      closeQuietly(client);
      return;
    }
    this.client = client;
    this.stopClientErrors = client.onError((error) => {
      if (isTerminalClientError(error)) {
        this.handleClientDeath(client);
      }
    });
    this.attempt = 0;
    this.table = RECONNECT_BACKOFF_MS;
    this.connectedAt = this.now();
    const isReconnect = this.hasConnected;
    this.hasConnected = true;
    this.setState({ phase: "connected" });
    for (const listener of [...this.connectedListeners]) {
      try {
        listener(client, isReconnect);
      } catch {
        // A resync failure must not stop the machine from being connected.
      }
    }
  }

  private handleConnectFailure(error: unknown): void {
    this.connecting = false;
    if (this.disposed) {
      return;
    }
    if (error instanceof HostBootstrapError) {
      this.table = AUTH_BACKOFF_MS;
      this.scheduleRetry(error.message);
      return;
    }
    if (isAuthRejection(error)) {
      // The daemon restarted with a new token, or something else is on the
      // port. Each retry re-runs the bootstrap, which is what picks the new
      // token up — but slowly, because hammering it cannot help.
      this.table = AUTH_BACKOFF_MS;
    }
    this.scheduleRetry(null);
  }

  /** The live connection died under us. */
  private handleClientDeath(expectedClient: TClient, close = false): void {
    if (this.disposed || this.client !== expectedClient) {
      return;
    }
    this.releaseClient(close);
    if (this.frozen) {
      return;
    }
    this.scheduleRetry(null);
  }

  private scheduleRetry(failureReason: string | null): void {
    const step = this.table[Math.min(this.attempt, this.table.length - 1)]
      ?? this.table[this.table.length - 1]
      ?? RECONNECT_BACKOFF_MS[0];
    this.attempt += 1;
    const wait = Math.max(step, this.antiFlapRemainder());
    const next: ConnectionState = failureReason === null
      ? { phase: "reconnecting", attempt: this.attempt, nextDelayMs: wait }
      : { phase: "failed", reason: failureReason };
    if (this.frozen) {
      this.setState(next);
      return;
    }
    this.waitThenConnect(wait, next);
  }

  private waitThenConnect(wait: number, next: ConnectionState): void {
    this.setState(next);
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      this.attemptConnect(false);
    }, wait);
  }

  private antiFlapRemainder(): number {
    if (this.connectedAt === null) {
      return 0;
    }
    return Math.max(0, ANTI_FLAP_FLOOR_MS - (this.now() - this.connectedAt));
  }

  private releaseClient(close: boolean): void {
    // Unsubscribe BEFORE closing, or our own close would come back as a death.
    this.stopClientErrors?.();
    this.stopClientErrors = null;
    const client = this.client;
    this.client = null;
    if (client && close) {
      closeQuietly(client);
    }
  }

  private cancelPending(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private setState(state: ConnectionState): void {
    this.currentState = state;
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state);
      } catch {
        // One bad subscriber must not stop the others, or the machine.
      }
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private schedule(run: () => void, ms: number): () => void {
    if (this.options.schedule) {
      return this.options.schedule(run, ms);
    }
    const handle = setTimeout(run, ms);
    return () => clearTimeout(handle);
  }
}

function closeQuietly(client: ReconnectableClient): void {
  try {
    client.close();
  } catch {
    // Closing an already-dead socket is not news.
  }
}
