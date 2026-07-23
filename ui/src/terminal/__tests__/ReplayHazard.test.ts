import { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import type {
  SessionAttachment,
  SessionAttachmentCallbacks,
} from "../../host/client";
import {
  TerminalSessionBinding,
  type TerminalPort,
} from "../TerminalSessionBinding";

const ESC = "";
const ST = `${ESC}\\`;
const encoder = new TextEncoder();

function attachmentFixture() {
  const sendInput = vi.fn();
  const attachment: SessionAttachment = {
    sessionId: 7,
    nextOffset: 0n,
    sendInput,
    resize: vi.fn(),
    detach: vi.fn(),
  };
  let callbacks: SessionAttachmentCallbacks | undefined;
  const client = {
    attach: vi.fn(async (_sessionId: number, nextCallbacks: SessionAttachmentCallbacks) => {
      callbacks = nextCallbacks;
      return attachment;
    }),
  };

  return {
    client,
    sendInput,
    get callbacks() {
      if (!callbacks) {
        throw new Error("attachment callbacks are not installed");
      }
      return callbacks;
    },
  };
}

function xtermPort(terminal: Terminal): TerminalPort {
  return {
    get cols() {
      return terminal.cols;
    },
    get rows() {
      return terminal.rows;
    },
    onData: (listener) => terminal.onData(listener),
    reset: () => terminal.reset(),
    parser: terminal.parser,
    write: (data, callback) => terminal.write(data, callback),
    reassertWindowsPtyInputMode: () => {
      terminal.options.windowsPty = { backend: "conpty" };
      terminal.write(`${ESC}[?9001h`);
    },
  };
}

async function startedRealBinding() {
  const terminal = new Terminal({ windowsPty: { backend: "conpty" } });
  const fixture = attachmentFixture();
  const port = xtermPort(terminal);
  const binding = new TerminalSessionBinding({
    client: fixture.client,
    sessionId: 7,
    terminal: port,
    fit: vi.fn(),
  });
  await binding.start();
  return { binding, fixture, port, terminal };
}

function output(
  callbacks: SessionAttachmentCallbacks,
  source: "replay" | "live",
  data: string,
) {
  callbacks.onOutput?.({ offset: 0n, data: encoder.encode(data), source });
}

async function waitForWrites() {
  await vi.waitFor(() => undefined);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("xterm replay auto-answer suppression", () => {
  it("replay hazard #1 resets before replay and suppresses DA1, DA2, and DA3", async () => {
    const terminal = new Terminal({ windowsPty: { backend: "conpty" } });
    const fixture = attachmentFixture();
    const port = xtermPort(terminal);
    const reset = vi.spyOn(port, "reset");
    const binding = new TerminalSessionBinding({
      client: fixture.client,
      sessionId: 7,
      terminal: port,
      fit: vi.fn(),
    });
    await binding.start();

    output(fixture.callbacks, "replay", `${ESC}[c${ESC}[>0c${ESC}[=c`);
    output(fixture.callbacks, "live", "ready");
    await waitForWrites();

    expect(reset).toHaveBeenCalledOnce();
    expect(fixture.sendInput).not.toHaveBeenCalled();
  });

  it("replay hazard #2 suppresses DSR status and private window reports", async () => {
    const { fixture } = await startedRealBinding();

    output(fixture.callbacks, "replay", `${ESC}[5n${ESC}[?15n`);
    output(fixture.callbacks, "live", "ready");
    await waitForWrites();

    expect(fixture.sendInput).not.toHaveBeenCalled();
  });

  it("replay hazard #3 suppresses a replayed CPR even though the host strips it", async () => {
    const { fixture } = await startedRealBinding();

    output(fixture.callbacks, "replay", `${ESC}[6n`);
    output(fixture.callbacks, "live", "ready");
    await waitForWrites();

    expect(fixture.sendInput).not.toHaveBeenCalled();
  });

  it("replay hazard #4 suppresses DECXCPR missed by the host strip", async () => {
    const { fixture } = await startedRealBinding();

    output(fixture.callbacks, "replay", `${ESC}[?6n`);
    output(fixture.callbacks, "live", "ready");
    await waitForWrites();

    expect(fixture.sendInput).not.toHaveBeenCalled();
  });

  it("replay hazard #5 suppresses private and plain DECRQM plus DECRQSS", async () => {
    const { fixture } = await startedRealBinding();

    output(
      fixture.callbacks,
      "replay",
      `${ESC}[?1049$p${ESC}[4$p${ESC}P$qm${ST}`,
    );
    output(fixture.callbacks, "live", "ready");
    await waitForWrites();

    expect(fixture.sendInput).not.toHaveBeenCalled();
  });

  it("replay hazard #6 registers XTVERSION suppression", async () => {
    const csiIdentifiers: Array<{ prefix?: string; intermediates?: string; final: string }> = [];
    const terminal = {
      cols: 80,
      rows: 24,
      onData: () => ({ dispose: () => undefined }),
      reset: vi.fn(),
      parser: {
        registerCsiHandler: (
          identifier: { prefix?: string; intermediates?: string; final: string },
        ) => {
          csiIdentifiers.push(identifier);
          return { dispose: () => undefined };
        },
        registerDcsHandler: () => ({ dispose: () => undefined }),
        registerOscHandler: () => ({ dispose: () => undefined }),
      },
      write: (_data: string, callback?: () => void) => callback?.(),
      reassertWindowsPtyInputMode: vi.fn(),
    };
    const fixture = attachmentFixture();
    const binding = new TerminalSessionBinding({
      client: fixture.client,
      sessionId: 7,
      terminal,
      fit: vi.fn(),
    });

    await binding.start();

    expect(csiIdentifiers).toContainEqual({ prefix: ">", final: "q" });
  });

  it("replay hazard #7 suppresses OSC color queries but preserves an OSC 11 navy set", async () => {
    const oscHandlers = new Map<number, (data: string) => boolean>();
    const terminal = {
      cols: 80,
      rows: 24,
      onData: () => ({ dispose: () => undefined }),
      reset: vi.fn(),
      parser: {
        registerCsiHandler: () => ({ dispose: () => undefined }),
        registerDcsHandler: () => ({ dispose: () => undefined }),
        registerOscHandler: (identifier: number, handler: (data: string) => boolean) => {
          oscHandlers.set(identifier, handler);
          return { dispose: () => oscHandlers.delete(identifier) };
        },
      },
      write: vi.fn(),
      reassertWindowsPtyInputMode: vi.fn(),
    };
    const fixture = attachmentFixture();
    const binding = new TerminalSessionBinding({
      client: fixture.client,
      sessionId: 7,
      terminal,
      fit: vi.fn(),
    });
    await binding.start();

    expect(oscHandlers.get(4)?.("1;?")).toBe(true);
    expect(oscHandlers.get(10)?.("?")).toBe(true);
    expect(oscHandlers.get(11)?.("?")).toBe(true);
    expect(oscHandlers.get(12)?.("?")).toBe(true);
    expect(oscHandlers.get(11)?.("rgb:0000/0000/8080")).toBe(false);
  });

  it("replay hazard #8 handles empty and mid-sequence replay chunks, resyncs, and sends no reply", async () => {
    const { fixture, terminal } = await startedRealBinding();

    expect(() => {
      output(fixture.callbacks, "replay", "");
      output(fixture.callbacks, "replay", `[?6ntruncated${ESC}[?6nresynced`);
      output(fixture.callbacks, "live", "ready");
    }).not.toThrow();
    await waitForWrites();

    expect(fixture.sendInput).not.toHaveBeenCalled();
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain("resyncedready");
  });

  it("replay hazard #9 disposes suppression before held live DA1 is parsed", async () => {
    let onData: ((data: string) => void) | undefined;
    let da1Suppressed = false;
    const replayCallbacks: Array<() => void> = [];
    const writes: string[] = [];
    const disposals: ReturnType<typeof vi.fn>[] = [];
    const disposable = (onDispose?: () => void) => {
      const dispose = vi.fn(() => onDispose?.());
      disposals.push(dispose);
      return { dispose };
    };
    const terminal: TerminalPort = {
      cols: 80,
      rows: 24,
      onData: (listener) => {
        onData = listener;
        return { dispose: () => (onData = undefined) };
      },
      reset: vi.fn(),
      parser: {
        registerCsiHandler: (identifier) => {
          if (identifier.final === "c" && identifier.prefix === undefined) {
            da1Suppressed = true;
            return disposable(() => {
              da1Suppressed = false;
            });
          }
          return disposable();
        },
        registerDcsHandler: () => disposable(),
        registerOscHandler: () => disposable(),
      },
      write: (data, callback) => {
        writes.push(data);
        if (data === `${ESC}[c` && !da1Suppressed) {
          onData?.(`${ESC}[?1;2c`);
        }
        if (callback) {
          replayCallbacks.push(callback);
        }
      },
      reassertWindowsPtyInputMode: vi.fn(),
    };
    const fixture = attachmentFixture();
    const binding = new TerminalSessionBinding({
      client: fixture.client,
      sessionId: 7,
      terminal,
      fit: vi.fn(),
    });
    await binding.start();

    output(fixture.callbacks, "replay", "historical");
    output(fixture.callbacks, "live", `${ESC}[c`);
    expect(writes).toEqual(["historical"]);
    expect(fixture.sendInput).not.toHaveBeenCalled();

    replayCallbacks.shift()?.();

    expect(disposals).not.toHaveLength(0);
    expect(disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(writes).toEqual(["historical", `${ESC}[c`]);
    expect(fixture.sendInput).toHaveBeenCalledOnce();
    expect(fixture.sendInput).toHaveBeenCalledWith(`${ESC}[?1;2c`);
  });

  it("replay hazard #10 reasserts ConPTY win32 input mode before forwarding typed keys", async () => {
    const writeCallbacks: Array<() => void> = [];
    let onData: ((data: string) => void) | undefined;
    let win32InputMode = false;
    const reassertWindowsPtyInputMode = vi.fn(() => {
      win32InputMode = true;
    });
    const terminal: TerminalPort = {
      cols: 80,
      rows: 24,
      onData: (listener) => {
        onData = listener;
        return { dispose: () => (onData = undefined) };
      },
      reset: () => {
        win32InputMode = false;
      },
      parser: {
        registerCsiHandler: () => ({ dispose: () => undefined }),
        registerDcsHandler: () => ({ dispose: () => undefined }),
        registerOscHandler: () => ({ dispose: () => undefined }),
      },
      write: (data, callback) => {
        if (data.includes(`${ESC}[?9001h`)) {
          win32InputMode = true;
        }
        if (callback) {
          writeCallbacks.push(callback);
        }
      },
      reassertWindowsPtyInputMode,
    };
    const fixture = attachmentFixture();
    const binding = new TerminalSessionBinding({
      client: fixture.client,
      sessionId: 7,
      terminal,
      fit: vi.fn(),
    });
    await binding.start();

    output(fixture.callbacks, "replay", `${ESC}[?9001h`);
    output(fixture.callbacks, "live", "held");
    expect(reassertWindowsPtyInputMode).not.toHaveBeenCalled();
    writeCallbacks.shift()?.();
    onData?.(win32InputMode ? `${ESC}[65;1;65;1;0;1_` : "a");

    expect(reassertWindowsPtyInputMode).toHaveBeenCalledOnce();
    expect(fixture.sendInput).toHaveBeenCalledWith(`${ESC}[65;1;65;1;0;1_`);
  });
});
