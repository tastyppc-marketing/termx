import { describe, expect, it, vi } from "vitest";
import type {
  SessionAttachment,
  SessionAttachmentCallbacks,
  SessionOutputEvent,
} from "../../host/client";
import {
  TerminalSessionBinding,
  parseOsc9CwdReport,
} from "../TerminalSessionBinding";

describe("parseOsc9CwdReport", () => {
  it("accepts 9;9 payloads with absolute Windows paths", () => {
    expect(parseOsc9CwdReport("9;C:\\Dev\\TermX")).toBe("C:\\Dev\\TermX");
    expect(parseOsc9CwdReport("9;C:/Dev")).toBe("C:/Dev");
    expect(parseOsc9CwdReport('9;"C:\\Program Files\\App"')).toBe(
      "C:\\Program Files\\App",
    );
    expect(parseOsc9CwdReport("9;\\\\server\\share")).toBe("\\\\server\\share");
  });

  it("rejects other OSC 9 subcommands and non-absolute junk", () => {
    expect(parseOsc9CwdReport("4;100")).toBeNull(); // ConEmu progress
    expect(parseOsc9CwdReport("notify;hello")).toBeNull();
    expect(parseOsc9CwdReport("9;relative\\path")).toBeNull();
    expect(parseOsc9CwdReport("9;")).toBeNull();
    expect(parseOsc9CwdReport('9;""')).toBeNull();
    expect(parseOsc9CwdReport("9;C:\\bad\u0007path")).toBeNull();
  });
});

interface OscHandler {
  (data: string): boolean;
}

class OscFakeTerminal {
  cols = 80;
  rows = 24;
  readonly writes: string[] = [];
  readonly oscHandlers = new Map<number, OscHandler[]>();
  disposedOscHandlers = 0;
  readonly parser = {
    registerCsiHandler: () => ({ dispose: () => undefined }),
    registerDcsHandler: () => ({ dispose: () => undefined }),
    registerOscHandler: (identifier: number, handler: OscHandler) => {
      const list = this.oscHandlers.get(identifier) ?? [];
      list.push(handler);
      this.oscHandlers.set(identifier, list);
      return {
        dispose: () => {
          this.disposedOscHandlers += 1;
          const current = this.oscHandlers.get(identifier) ?? [];
          this.oscHandlers.set(
            identifier,
            current.filter((entry) => entry !== handler),
          );
        },
      };
    },
  };

  onData() {
    return { dispose: () => undefined };
  }

  reset() {}

  reassertWindowsPtyInputMode() {}

  write(data: string, callback?: () => void) {
    this.writes.push(data);
    // Simulate the parser encountering embedded OSC 9 sequences during this
    // write, before the write callback fires (xterm parses synchronously
    // relative to the callback).
    const pattern = /\u001b\]9;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;
    for (const match of data.matchAll(pattern)) {
      for (const handler of this.oscHandlers.get(9) ?? []) {
        handler(`9;${match[1]!.split(";").slice(1).join(";")}`);
      }
    }
    callback?.();
  }
}

function fixture(onCwd: (path: string, live: boolean) => void) {
  const terminal = new OscFakeTerminal();
  let callbacks: SessionAttachmentCallbacks | undefined;
  const attachment: SessionAttachment = {
    sessionId: 7,
    nextOffset: 0n,
    sendInput: vi.fn(),
    resize: vi.fn(),
    detach: vi.fn(),
  };
  const client = {
    attach: vi.fn(async (_sessionId: number, nextCallbacks: SessionAttachmentCallbacks) => {
      callbacks = nextCallbacks;
      return attachment;
    }),
  };
  const binding = new TerminalSessionBinding({
    client,
    sessionId: 7,
    terminal,
    fit: () => undefined,
    onCwd,
  });
  return {
    terminal,
    binding,
    emit(event: SessionOutputEvent) {
      callbacks?.onOutput?.(event);
    },
  };
}

function chunk(text: string, source: "replay" | "live"): SessionOutputEvent {
  return { data: new TextEncoder().encode(text), source, offset: 0n };
}

const OSC = (path: string) => `\u001b]9;9;${path}\u0007`;

describe("TerminalSessionBinding cwd reports", () => {
  it("flags replay-derived reports as not live, later reports as live", async () => {
    const reports: Array<{ path: string; live: boolean }> = [];
    const { binding, emit } = fixture((path, live) => reports.push({ path, live }));
    await binding.start();

    emit(chunk(`old output ${OSC("C:\\replayed")}`, "replay"));
    emit(chunk(`prompt ${OSC("C:\\current")}`, "live"));

    expect(reports).toEqual([
      { path: "C:\\replayed", live: false },
      { path: "C:\\current", live: true },
    ]);
    binding.dispose();
  });

  it("disposes the cwd handler with the binding", async () => {
    const { terminal, binding } = fixture(() => undefined);
    await binding.start();
    const before = terminal.oscHandlers.get(9)?.length ?? 0;
    expect(before).toBeGreaterThan(0);
    binding.dispose();
    expect(terminal.disposedOscHandlers).toBeGreaterThan(0);
  });
});
