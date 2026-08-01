import type {
  HostClient,
  SessionAttachment,
  SessionAttachmentCallbacks,
  SessionOutputEvent,
} from "../host/client";

interface Disposable {
  dispose(): void;
}

interface TerminalFunctionIdentifier {
  prefix?: string;
  intermediates?: string;
  final: string;
}

interface TerminalParserPort {
  registerCsiHandler(
    identifier: TerminalFunctionIdentifier,
    handler: (params: (number | number[])[]) => boolean,
  ): Disposable;
  registerDcsHandler(
    identifier: TerminalFunctionIdentifier,
    handler: (data: string, params: (number | number[])[]) => boolean,
  ): Disposable;
  registerOscHandler(identifier: number, handler: (data: string) => boolean): Disposable;
}

export interface TerminalPort {
  readonly cols: number;
  readonly rows: number;
  readonly parser: TerminalParserPort;
  onData(listener: (data: string) => void): Disposable;
  reset(): void;
  write(data: string, callback?: () => void): void;
  reassertWindowsPtyInputMode(): void;
}

export interface AttachmentClient {
  attach(
    sessionId: number,
    callbacks?: SessionAttachmentCallbacks,
    replay?: boolean,
  ): ReturnType<HostClient["attach"]>;
}

export type TerminalCleanupOperation =
  | "data_subscription"
  | "cwd_subscription"
  | "replay_suppression"
  | "detach";

export type TerminalSessionStatus =
  | { type: "attached" }
  | {
      type: "lost_scrollback";
      expectedOffset: bigint;
      receivedOffset: bigint;
    }
  | { type: "exited"; exitCode: number | null }
  | { type: "disconnected" }
  | {
      type: "error";
      operation: "host" | "input" | "output" | "fit" | "resize";
      message: string;
    };

export interface TerminalSessionBindingOptions {
  client: AttachmentClient;
  sessionId: number;
  terminal: TerminalPort;
  fit: () => void;
  onStatus?: (status: TerminalSessionStatus) => void;
  onCleanupError?: (operation: TerminalCleanupOperation, error: unknown) => void;
  /**
   * OSC 9;9 working-directory report (host-injected shell integration).
   * `live` is false while the report comes from replayed scrollback — replay
   * re-derives a session's cwd but must never move group-level state.
   */
  onCwd?: (path: string, live: boolean) => void;
  /** User keystrokes actually forwarded to the PTY (input-mark tracking). */
  onUserInput?: (data: string) => void;
  /**
   * Fires once, after every replayed byte has been parsed and the held live
   * output has been flushed. The reattach-dims rule (spec §13) hangs off this:
   * fit-to-container and the host resize may only run AFTER replay.
   */
  onReplayFinished?: () => void;
}

export class TerminalSessionBinding {
  private readonly decoder = new TextDecoder();
  private readonly dataSubscription: Disposable;
  private readonly cwdSubscription: Disposable | null;
  private attachment: SessionAttachment | null = null;
  private lastDimensions: string | null = null;
  private acceptingInput = false;
  private disposed = false;
  private ended = false;
  private outputDisabled = false;
  private replaySuppressions: Disposable[] = [];
  private readonly heldLiveOutput: string[] = [];
  private pendingReplayWrites = 0;
  private replayBoundaryReached = false;
  private replayFinished = false;

  constructor(private readonly options: TerminalSessionBindingOptions) {
    this.dataSubscription = options.terminal.onData((data) => {
      if (!this.acceptingInput) {
        return;
      }
      options.onUserInput?.(data);
      try {
        this.attachment?.sendInput(data);
      } catch (error) {
        this.reportRuntimeError("input", error);
      }
    });
    this.cwdSubscription = options.onCwd
      ? options.terminal.parser.registerOscHandler(9, (data) => {
          const path = parseOsc9CwdReport(data);
          if (path === null) {
            // Not a 9;9 cwd report (e.g. ConEmu progress) — leave it alone.
            return false;
          }
          if (!this.disposed) {
            this.options.onCwd?.(path, this.replayFinished);
          }
          return true;
        })
      : null;
  }

  async start(): Promise<void> {
    this.options.terminal.reset();
    this.installReplaySuppressions();

    let attachment: SessionAttachment;
    try {
      attachment = await this.options.client.attach(
        this.options.sessionId,
        {
          onOutput: (event) => this.handleOutput(event),
          onLostScrollback: ({ expectedOffset, receivedOffset }) => {
            if (this.disposed) {
              return;
            }
            this.options.onStatus?.({
              type: "lost_scrollback",
              expectedOffset,
              receivedOffset,
            });
          },
          onExit: (exitCode) => {
            if (!this.disposed && this.endInput()) {
              this.options.onStatus?.({ type: "exited", exitCode });
            }
          },
          onDisconnect: () => {
            if (!this.disposed && this.endInput()) {
              this.options.onStatus?.({ type: "disconnected" });
            }
          },
        },
        true,
      );
    } catch (error) {
      this.disposeReplaySuppressions();
      throw error;
    }

    if (this.disposed) {
      try {
        attachment.detach();
      } catch (error) {
        this.options.onCleanupError?.("detach", error);
      }
      return;
    }

    this.attachment = attachment;
    if (!this.ended) {
      this.acceptingInput = true;
      this.options.onStatus?.({ type: "attached" });
    }
  }

  reportHostError(error: Error): void {
    this.reportRuntimeError("host", error);
  }

  /**
   * Declare that the host has delivered every replay byte — a resolved attach
   * means exactly that. The first live frame normally closes replay first;
   * this keeps a session that produced no output after attach from stranding
   * post-replay work forever. Idempotent.
   */
  markReplayBoundary(): void {
    if (this.replayFinished || this.disposed) {
      return;
    }
    this.replayBoundaryReached = true;
    this.finishReplayWhenParsed();
  }

  fitAndResize(): void {
    try {
      this.options.fit();
    } catch (error) {
      this.reportRuntimeError("fit", error);
      return;
    }
    if (this.ended || this.disposed) {
      return;
    }
    const dimensions = `${this.options.terminal.cols}x${this.options.terminal.rows}`;
    if (!this.attachment || dimensions === this.lastDimensions) {
      return;
    }
    try {
      this.attachment.resize(this.options.terminal.cols, this.options.terminal.rows);
      this.lastDimensions = dimensions;
    } catch (error) {
      this.reportRuntimeError("resize", error);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.acceptingInput = false;
    this.heldLiveOutput.length = 0;
    this.disposeReplaySuppressions();
    const attachment = this.attachment;
    this.attachment = null;
    try {
      this.dataSubscription.dispose();
    } catch (error) {
      this.options.onCleanupError?.("data_subscription", error);
    }
    try {
      this.cwdSubscription?.dispose();
    } catch (error) {
      this.options.onCleanupError?.("cwd_subscription", error);
    }
    try {
      attachment?.detach();
    } catch (error) {
      this.options.onCleanupError?.("detach", error);
    }
  }

  private installReplaySuppressions(): void {
    const consume = () => true;
    const installed: Disposable[] = [];
    try {
      for (const prefix of [undefined, ">", "="] as const) {
        installed.push(
          this.options.terminal.parser.registerCsiHandler(
            prefix === undefined ? { final: "c" } : { prefix, final: "c" },
            consume,
          ),
        );
      }
      for (const prefix of [undefined, "?"] as const) {
        installed.push(
          this.options.terminal.parser.registerCsiHandler(
            prefix === undefined ? { final: "n" } : { prefix, final: "n" },
            consume,
          ),
          this.options.terminal.parser.registerCsiHandler(
            prefix === undefined
              ? { intermediates: "$", final: "p" }
              : { prefix, intermediates: "$", final: "p" },
            consume,
          ),
        );
      }
      installed.push(
        this.options.terminal.parser.registerCsiHandler(
          { prefix: ">", final: "q" },
          consume,
        ),
        this.options.terminal.parser.registerDcsHandler(
          { intermediates: "$", final: "q" },
          consume,
        ),
      );
      for (const identifier of [4, 10, 11, 12]) {
        installed.push(
          this.options.terminal.parser.registerOscHandler(identifier, (data) =>
            isOscColorQuery(identifier, data),
          ),
        );
      }
    } catch (error) {
      for (const handler of installed) {
        try {
          handler.dispose();
        } catch (cleanupError) {
          this.options.onCleanupError?.("replay_suppression", cleanupError);
        }
      }
      throw error;
    }
    this.replaySuppressions = installed;
  }

  private handleOutput({ data, source }: SessionOutputEvent): void {
    if (this.disposed || this.outputDisabled) {
      return;
    }

    let text: string;
    try {
      text = this.decoder.decode(data, { stream: true });
    } catch (error) {
      this.failOutput(error);
      return;
    }

    if (source === "replay" && !this.replayFinished) {
      this.writeReplay(text);
      return;
    }

    if (!this.replayFinished) {
      this.heldLiveOutput.push(text);
      this.replayBoundaryReached = true;
      this.finishReplayWhenParsed();
      return;
    }

    this.writeLive(text);
  }

  private writeReplay(text: string): void {
    this.pendingReplayWrites += 1;
    let completed = false;
    try {
      this.options.terminal.write(text, () => {
        if (completed || this.replayFinished || this.disposed) {
          return;
        }
        completed = true;
        this.pendingReplayWrites -= 1;
        this.finishReplayWhenParsed();
      });
    } catch (error) {
      if (!completed) {
        completed = true;
        this.pendingReplayWrites -= 1;
      }
      this.failOutput(error);
    }
  }

  private finishReplayWhenParsed(): void {
    if (
      this.replayFinished ||
      this.disposed ||
      !this.replayBoundaryReached ||
      this.pendingReplayWrites !== 0
    ) {
      return;
    }

    this.replayFinished = true;
    this.disposeReplaySuppressions();
    try {
      this.options.terminal.reassertWindowsPtyInputMode();
    } catch (error) {
      this.failOutput(error);
      return;
    }

    const held = this.heldLiveOutput.splice(0).filter((text) => text.length > 0);
    if (held.length === 0) {
      this.fireReplayFinished();
      return;
    }
    // Held live output was produced by the pty at the recorded dimensions, so
    // the consumer must not fit/resize until xterm has PARSED it — queued is
    // not parsed. Gate the callback on the held writes' parse callbacks, the
    // same way the replay writes themselves were gated.
    let remaining = held.length;
    for (const text of held) {
      if (this.outputDisabled) {
        return;
      }
      try {
        this.options.terminal.write(text, () => {
          remaining -= 1;
          if (remaining === 0) {
            this.fireReplayFinished();
          }
        });
      } catch (error) {
        this.failOutput(error);
        return;
      }
    }
  }

  private fireReplayFinished(): void {
    if (this.disposed || this.outputDisabled) {
      return;
    }
    try {
      this.options.onReplayFinished?.();
    } catch {
      // A consumer failure must never leave the binding half-attached; the
      // consumer owns reporting its own errors.
    }
  }

  private writeLive(text: string): void {
    if (text.length === 0 || this.disposed || this.outputDisabled) {
      return;
    }
    try {
      this.options.terminal.write(text);
    } catch (error) {
      this.failOutput(error);
    }
  }

  private failOutput(error: unknown): void {
    this.outputDisabled = true;
    this.heldLiveOutput.length = 0;
    this.disposeReplaySuppressions();
    this.reportRuntimeError("output", error, false);
  }

  private disposeReplaySuppressions(): void {
    const suppressions = this.replaySuppressions.splice(0);
    for (const handler of suppressions) {
      try {
        handler.dispose();
      } catch (error) {
        this.options.onCleanupError?.("replay_suppression", error);
      }
    }
  }

  private reportRuntimeError(
    operation: Extract<TerminalSessionStatus, { type: "error" }>["operation"],
    error: unknown,
    flushOutput = true,
  ): void {
    if (this.disposed || this.ended) {
      return;
    }
    let flushError: unknown;
    if (flushOutput) {
      this.endInput((error) => {
        flushError = error;
      });
    } else {
      this.ended = true;
      this.acceptingInput = false;
      this.decoder.decode();
    }
    const primaryMessage =
      error instanceof Error ? error.message : "Terminal operation failed";
    const message = flushError
      ? `${primaryMessage}; terminal output also failed: ${
          flushError instanceof Error ? flushError.message : "Terminal operation failed"
        }`
      : primaryMessage;
    this.options.onStatus?.({
      type: "error",
      operation,
      message,
    });
  }

  private endInput(onOutputError?: (error: unknown) => void): boolean {
    if (this.ended) {
      return false;
    }
    this.ended = true;
    this.acceptingInput = false;
    try {
      const remainder = this.decoder.decode();
      if (!this.replayFinished) {
        this.heldLiveOutput.push(remainder);
        this.replayBoundaryReached = true;
        this.finishReplayWhenParsed();
      } else if (remainder.length > 0 && !this.outputDisabled) {
        // Direct write, not writeLive: a flush failure here must reach THIS
        // catch so it can be folded into the primary error's message.
        this.options.terminal.write(remainder);
      }
    } catch (error) {
      this.outputDisabled = true;
      this.disposeReplaySuppressions();
      onOutputError?.(error);
    }
    return true;
  }
}

/**
 * Parse an OSC 9 payload as a 9;9 working-directory report (Windows Terminal
 * convention: `ESC]9;9;<path>ST`, path optionally double-quoted). Returns the
 * absolute Windows path, or null for anything else (other ConEmu OSC 9
 * subcommands, relative junk, empty payloads).
 */
export function parseOsc9CwdReport(data: string): string | null {
  if (!data.startsWith("9;")) {
    return null;
  }
  let path = data.slice(2).trim();
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1);
  }
  if (path.length === 0 || hasControlCharacters(path)) {
    return null;
  }
  const driveAbsolute = /^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:$/.test(path);
  const uncAbsolute = path.startsWith("\\\\") && path.length > 2;
  if (!driveAbsolute && !uncAbsolute) {
    return null;
  }
  return path;
}

function hasControlCharacters(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) < 0x20) {
      return true;
    }
  }
  return false;
}

function isOscColorQuery(identifier: number, data: string): boolean {
  if (identifier === 4) {
    const fields = data.split(";");
    for (let index = 1; index < fields.length; index += 2) {
      if (fields[index] === "?") {
        return true;
      }
    }
    return false;
  }
  return data === "?";
}
