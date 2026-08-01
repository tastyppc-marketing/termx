import { describe, expect, it, vi } from "vitest";
import type {
  SessionAttachment,
  SessionAttachmentCallbacks,
} from "../../host/client";
import { TerminalSessionBinding } from "../TerminalSessionBinding";

class FakeTerminal {
  cols = 80;
  rows = 24;
  readonly writes: string[] = [];
  writeError: Error | null = null;
  readonly parser = {
    registerCsiHandler: () => ({ dispose: () => undefined }),
    registerDcsHandler: () => ({ dispose: () => undefined }),
    registerOscHandler: () => ({ dispose: () => undefined }),
  };
  private dataListener: ((data: string) => void) | null = null;

  onData(listener: (data: string) => void) {
    this.dataListener = listener;
    return { dispose: () => (this.dataListener = null) };
  }

  reset() {}

  reassertWindowsPtyInputMode() {}

  write(data: string, callback?: () => void) {
    if (this.writeError) {
      throw this.writeError;
    }
    this.writes.push(data);
    callback?.();
  }

  emitData(data: string) {
    this.dataListener?.(data);
  }
}

function attachmentFixture() {
  const sendInput = vi.fn();
  const resize = vi.fn();
  const detach = vi.fn();
  const attachment: SessionAttachment = {
    sessionId: 7,
    nextOffset: 0n,
    sendInput,
    resize,
    detach,
  };
  let callbacks: SessionAttachmentCallbacks | undefined;
  const client = {
    attach: vi.fn(async (_sessionId: number, nextCallbacks: SessionAttachmentCallbacks) => {
      callbacks = nextCallbacks;
      return attachment;
    }),
  };

  return {
    attachment,
    client,
    get callbacks() {
      if (!callbacks) {
        throw new Error("attachment callbacks are not installed");
      }
      return callbacks;
    },
    sendInput,
    resize,
    detach,
  };
}

describe("TerminalSessionBinding", () => {
  it("streams replay and live output, forwards input, and deduplicates resize", async () => {
    const terminal = new FakeTerminal();
    const fit = vi.fn(() => {
      terminal.cols = 120;
      terminal.rows = 36;
    });
    const fixture = attachmentFixture();
    const binding = new TerminalSessionBinding({
      client: fixture.client,
      sessionId: 7,
      terminal,
      fit,
    });

    await binding.start();
    fixture.callbacks.onOutput?.({
      offset: 0n,
      data: new TextEncoder().encode("replay\r\n"),
      source: "replay",
    });
    fixture.callbacks.onOutput?.({
      offset: 8n,
      data: new TextEncoder().encode("live"),
      source: "live",
    });
    terminal.emitData("dir\r");
    binding.fitAndResize();
    binding.fitAndResize();

    expect(terminal.writes).toEqual(["replay\r\n", "live"]);
    expect(fixture.sendInput).toHaveBeenCalledWith("dir\r");
    expect(fit).toHaveBeenCalledTimes(2);
    expect(fixture.resize).toHaveBeenCalledTimes(1);
    expect(fixture.resize).toHaveBeenCalledWith(120, 36);
  });

  it("preserves split UTF-8 and reports scrollback loss and exit", async () => {
    const terminal = new FakeTerminal();
    const fixture = attachmentFixture();
    const onStatus = vi.fn();
    const binding = new TerminalSessionBinding({
      client: fixture.client,
      sessionId: 7,
      terminal,
      fit: vi.fn(),
      onStatus,
    });

    await binding.start();
    const encoded = new TextEncoder().encode("A😀B");
    fixture.callbacks.onOutput?.({
      offset: 0n,
      data: encoded.slice(0, 3),
      source: "replay",
    });
    fixture.callbacks.onOutput?.({
      offset: 3n,
      data: encoded.slice(3),
      source: "live",
    });
    fixture.callbacks.onLostScrollback?.({ expectedOffset: 6n, receivedOffset: 9n });
    fixture.callbacks.onExit?.(17);
    fixture.callbacks.onDisconnect?.();
    terminal.emitData("ignored");
    binding.fitAndResize();

    expect(terminal.writes.join("")).toBe("A😀B");
    expect(onStatus).toHaveBeenNthCalledWith(1, { type: "attached" });
    expect(onStatus).toHaveBeenNthCalledWith(2, {
      type: "lost_scrollback",
      expectedOffset: 6n,
      receivedOffset: 9n,
    });
    expect(onStatus).toHaveBeenNthCalledWith(3, { type: "exited", exitCode: 17 });
    expect(onStatus).toHaveBeenCalledTimes(3);
    expect(fixture.sendInput).not.toHaveBeenCalled();
    expect(fixture.resize).not.toHaveBeenCalled();
  });

  it("contains terminal output failures instead of poisoning host frame handling", async () => {
    const terminal = new FakeTerminal();
    const fixture = attachmentFixture();
    const onStatus = vi.fn();
    terminal.writeError = new Error("renderer disposed");
    const binding = new TerminalSessionBinding({
      client: fixture.client,
      sessionId: 7,
      terminal,
      fit: vi.fn(),
      onStatus,
    });

    await binding.start();

    expect(() =>
      fixture.callbacks.onOutput?.({
        offset: 0n,
        data: new TextEncoder().encode("output"),
        source: "live",
      }),
    ).not.toThrow();
    expect(onStatus).toHaveBeenLastCalledWith({
      type: "error",
      operation: "output",
      message: "renderer disposed",
    });
  });

  it("preserves the primary runtime error when decoder flushing also fails", async () => {
    const terminal = new FakeTerminal();
    const fixture = attachmentFixture();
    const onStatus = vi.fn();
    fixture.sendInput.mockImplementation(() => {
      throw new Error("socket closing");
    });
    const binding = new TerminalSessionBinding({
      client: fixture.client,
      sessionId: 7,
      terminal,
      fit: vi.fn(),
      onStatus,
    });

    await binding.start();
    fixture.callbacks.onOutput?.({
      offset: 0n,
      data: new Uint8Array([0xf0]),
      source: "live",
    });
    terminal.writeError = new Error("renderer disposed");

    expect(() => terminal.emitData("input")).not.toThrow();
    expect(onStatus).toHaveBeenLastCalledWith({
      type: "error",
      operation: "input",
      message: "socket closing; terminal output also failed: renderer disposed",
    });
  });

  it("reports input failure once and disables further input", async () => {
    const terminal = new FakeTerminal();
    const fixture = attachmentFixture();
    const onStatus = vi.fn();
    fixture.sendInput.mockImplementation(() => {
      throw new Error("socket closing");
    });
    const binding = new TerminalSessionBinding({
      client: fixture.client,
      sessionId: 7,
      terminal,
      fit: vi.fn(),
      onStatus,
    });

    await binding.start();
    terminal.emitData("first");
    terminal.emitData("second");

    expect(fixture.sendInput).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenLastCalledWith({
      type: "error",
      operation: "input",
      message: "socket closing",
    });
  });

  it("ignores pending callbacks after disposal and detaches the late handle", async () => {
    const terminal = new FakeTerminal();
    const fixture = attachmentFixture();
    const onStatus = vi.fn();
    let pendingCallbacks: SessionAttachmentCallbacks | undefined;
    let resolveAttachment: ((attachment: SessionAttachment) => void) | undefined;
    fixture.client.attach.mockImplementation(
      async (_sessionId: number, nextCallbacks: SessionAttachmentCallbacks) => {
        pendingCallbacks = nextCallbacks;
        return new Promise<SessionAttachment>((resolve) => {
          resolveAttachment = resolve;
        });
      },
    );
    const binding = new TerminalSessionBinding({
      client: fixture.client,
      sessionId: 7,
      terminal,
      fit: vi.fn(),
      onStatus,
    });

    const started = binding.start();
    binding.dispose();
    pendingCallbacks?.onOutput?.({
      offset: 0n,
      data: new TextEncoder().encode("late output"),
      source: "replay",
    });
    pendingCallbacks?.onExit?.(0);
    resolveAttachment?.(fixture.attachment);
    await started;

    expect(terminal.writes).toEqual([]);
    expect(onStatus).not.toHaveBeenCalled();
    expect(fixture.detach).toHaveBeenCalledOnce();
  });

  it("reports a late attachment detach failure after disposal", async () => {
    const terminal = new FakeTerminal();
    const fixture = attachmentFixture();
    const onCleanupError = vi.fn();
    const detachError = new Error("detach refused");
    let resolveAttachment: ((attachment: SessionAttachment) => void) | undefined;
    fixture.detach.mockImplementation(() => {
      throw detachError;
    });
    fixture.client.attach.mockImplementation(
      async () =>
        new Promise<SessionAttachment>((resolve) => {
          resolveAttachment = resolve;
        }),
    );
    const binding = new TerminalSessionBinding({
      client: fixture.client,
      sessionId: 7,
      terminal,
      fit: vi.fn(),
      onCleanupError,
    });

    const started = binding.start();
    binding.dispose();
    resolveAttachment?.(fixture.attachment);
    await started;

    expect(onCleanupError).toHaveBeenCalledWith("detach", detachError);
  });

  it("contains detach failures after clearing local state", async () => {
    const terminal = new FakeTerminal();
    const fixture = attachmentFixture();
    const onCleanupError = vi.fn();
    fixture.detach.mockImplementation(() => {
      throw new Error("socket already closed");
    });
    const binding = new TerminalSessionBinding({
      client: fixture.client,
      sessionId: 7,
      terminal,
      fit: vi.fn(),
      onCleanupError,
    });

    await binding.start();

    expect(() => binding.dispose()).not.toThrow();
    expect(onCleanupError).toHaveBeenCalledWith("detach", expect.any(Error));
  });

  it("fires onReplayFinished only after held live output has parsed", async () => {
    const terminal = new FakeTerminal();
    const parseCallbacks: Array<() => void> = [];
    terminal.write = (data: string, callback?: () => void) => {
      terminal.writes.push(data);
      if (callback) {
        parseCallbacks.push(callback);
      }
    };
    const fixture = attachmentFixture();
    const onReplayFinished = vi.fn();
    const binding = new TerminalSessionBinding({
      client: fixture.client,
      sessionId: 7,
      terminal,
      fit: vi.fn(),
      onReplayFinished,
    });

    await binding.start();
    fixture.callbacks.onOutput?.({
      offset: 0n,
      data: new TextEncoder().encode("REPLAY"),
      source: "replay",
    });
    // Live output during replay is held; it was produced at the recorded dims.
    fixture.callbacks.onOutput?.({
      offset: 6n,
      data: new TextEncoder().encode("HELD"),
      source: "live",
    });

    // Replay parses: the held output is now QUEUED to xterm but not parsed —
    // a fit/resize here would reflow those recorded-width bytes.
    parseCallbacks.shift()?.();
    expect(terminal.writes).toEqual(["REPLAY", "HELD"]);
    expect(onReplayFinished).not.toHaveBeenCalled();

    // Only once xterm has parsed the held output may the consumer resize.
    parseCallbacks.shift()?.();
    expect(onReplayFinished).toHaveBeenCalledTimes(1);

    binding.dispose();
  });
});
