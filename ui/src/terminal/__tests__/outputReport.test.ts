import { describe, expect, it, vi } from "vitest";
import type {
  SessionAttachment,
  SessionAttachmentCallbacks,
  SessionOutputEvent,
} from "../../host/client";
import {
  TerminalSessionBinding,
  parseOsc9OutputReport,
} from "../TerminalSessionBinding";

describe("parseOsc9OutputReport", () => {
  it("accepts 77;output payloads, quoted or bare", () => {
    expect(parseOsc9OutputReport("77;output;C:\\Dev\\out\\report.md")).toBe(
      "C:\\Dev\\out\\report.md",
    );
    expect(parseOsc9OutputReport('77;output;"C:\\Program Files\\a b.txt"')).toBe(
      "C:\\Program Files\\a b.txt",
    );
    expect(parseOsc9OutputReport("77;output;C:\\out.md  ")).toBe("C:\\out.md");
  });

  it("rejects other OSC 9 subcommands and malformed payloads", () => {
    expect(parseOsc9OutputReport("9;C:\\Dev\\TermX")).toBeNull(); // cwd report
    expect(parseOsc9OutputReport("4;100")).toBeNull(); // ConEmu progress
    expect(parseOsc9OutputReport("77;output")).toBeNull();
    expect(parseOsc9OutputReport("77;output;")).toBeNull();
    expect(parseOsc9OutputReport("77;output;   ")).toBeNull();
    expect(parseOsc9OutputReport('77;output;""')).toBeNull();
    expect(parseOsc9OutputReport("77;notoutput;C:\\a.md")).toBeNull();
    expect(parseOsc9OutputReport("77;output;C:\\bad\u0007path")).toBeNull();
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
    // xterm hands an OSC 9 handler everything after `ESC]9;`, parsed
    // synchronously before this write's callback runs.
    const pattern = /\u001b\]9;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;
    for (const match of data.matchAll(pattern)) {
      for (const handler of this.oscHandlers.get(9) ?? []) {
        handler(match[1]!);
      }
    }
    callback?.();
  }
}

function fixture(callbacks: {
  onOutputRegistered?: (path: string) => void;
  onCwd?: (path: string, live: boolean) => void;
}) {
  const terminal = new OscFakeTerminal();
  let hostCallbacks: SessionAttachmentCallbacks | undefined;
  const attachment: SessionAttachment = {
    sessionId: 7,
    nextOffset: 0n,
    sendInput: vi.fn(),
    resize: vi.fn(),
    detach: vi.fn(),
  };
  const client = {
    attach: vi.fn(
      async (_sessionId: number, nextCallbacks: SessionAttachmentCallbacks) => {
        hostCallbacks = nextCallbacks;
        return attachment;
      },
    ),
  };
  const binding = new TerminalSessionBinding({
    client,
    sessionId: 7,
    terminal,
    fit: () => undefined,
    ...callbacks,
  });
  return {
    terminal,
    binding,
    emit(event: SessionOutputEvent) {
      hostCallbacks?.onOutput?.(event);
    },
  };
}

function chunk(text: string, source: "replay" | "live"): SessionOutputEvent {
  return { data: new TextEncoder().encode(text), source, offset: 0n };
}

const OSC_OUTPUT = (path: string) => `\u001b]9;77;output;${path}\u0007`;
const OSC_CWD = (path: string) => `\u001b]9;9;${path}\u0007`;

describe("TerminalSessionBinding output reports", () => {
  it("fires onOutputRegistered for live reports only, never for replay", async () => {
    const paths: string[] = [];
    const { binding, emit } = fixture({
      onOutputRegistered: (path) => paths.push(path),
    });
    await binding.start();

    emit(chunk(`old ${OSC_OUTPUT("C:\\out\\replayed.md")}`, "replay"));
    emit(chunk(`now ${OSC_OUTPUT("C:\\out\\live.md")}`, "live"));

    expect(paths).toEqual(["C:\\out\\live.md"]);
    binding.dispose();
  });

  it("ignores malformed and empty payloads", async () => {
    const paths: string[] = [];
    const { binding, emit } = fixture({
      onOutputRegistered: (path) => paths.push(path),
    });
    await binding.start();

    emit(chunk("boot", "live"));
    emit(
      chunk(
        `${OSC_OUTPUT("")}${OSC_OUTPUT("   ")}\u001b]9;77;notoutput;C:\\a.md\u0007${OSC_OUTPUT("C:\\out\\good.md")}`,
        "live",
      ),
    );

    expect(paths).toEqual(["C:\\out\\good.md"]);
    binding.dispose();
  });

  it("leaves cwd reports working alongside the output callback", async () => {
    const paths: string[] = [];
    const cwds: Array<{ path: string; live: boolean }> = [];
    const { binding, emit } = fixture({
      onOutputRegistered: (path) => paths.push(path),
      onCwd: (path, live) => cwds.push({ path, live }),
    });
    await binding.start();

    emit(chunk(`${OSC_CWD("C:\\Dev\\TermX")}`, "replay"));
    emit(
      chunk(`${OSC_CWD("C:\\Dev\\Live")}${OSC_OUTPUT("C:\\out\\live.md")}`, "live"),
    );

    expect(cwds).toEqual([
      { path: "C:\\Dev\\TermX", live: false },
      { path: "C:\\Dev\\Live", live: true },
    ]);
    expect(paths).toEqual(["C:\\out\\live.md"]);
    binding.dispose();
  });

  it("registers the OSC handler when only onOutputRegistered is supplied", async () => {
    const { terminal, binding } = fixture({
      onOutputRegistered: () => undefined,
    });
    await binding.start();

    expect(terminal.oscHandlers.get(9)?.length ?? 0).toBeGreaterThan(0);
    binding.dispose();
    expect(terminal.disposedOscHandlers).toBeGreaterThan(0);
  });
});
