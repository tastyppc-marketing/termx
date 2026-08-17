/**
 * OSC `9;78;<provider>;<id>` conversation capture (ssh-sessions spec §2).
 *
 * The remote bootstrap's watcher emits this ONCE per agent launch, the moment
 * the transcript file appears — the id is captured, never guessed. Everything
 * here exists to keep a hostile or corrupt payload out of the resume command
 * that id later becomes: the id must be a bare `[A-Za-z0-9-]+` token, and the
 * provider must be one TermX knows.
 *
 * Live-only, like the 9;77 output report: replayed scrollback re-plays every
 * launch a pane ever made, and re-reporting them would overwrite the pane's
 * CURRENT conversation with an old one.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  SessionAttachment,
  SessionAttachmentCallbacks,
  SessionOutputEvent,
} from "../../host/client";
import {
  TerminalSessionBinding,
  parseOsc9ConversationCapture,
} from "../TerminalSessionBinding";

const CLAUDE_ID = "0f4b1c2e-9a77-4d31-8b0e-2c5d6e7f8a90";

describe("parseOsc9ConversationCapture", () => {
  it("accepts 78 payloads for both providers", () => {
    expect(parseOsc9ConversationCapture(`78;claude;${CLAUDE_ID}`)).toEqual({
      provider: "claude",
      id: CLAUDE_ID,
    });
    expect(parseOsc9ConversationCapture("78;codex;abc-123")).toEqual({
      provider: "codex",
      id: "abc-123",
    });
    // The remote printf can pick up trailing whitespace from a wrapped line.
    expect(parseOsc9ConversationCapture("78;claude;abc  ")).toEqual({
      provider: "claude",
      id: "abc",
    });
  });

  it("reduces a codex rollout filename stem to the bare session uuid", () => {
    // The watcher reports the transcript file's stem, but `codex resume` wants
    // the uuid inside it — so the stored/typed id must be the uuid, not the stem.
    expect(
      parseOsc9ConversationCapture(`78;codex;rollout-2026-08-17T10-00-00-${CLAUDE_ID}`),
    ).toEqual({ provider: "codex", id: CLAUDE_ID });
    // Claude reports a bare uuid already; it must be left untouched.
    expect(parseOsc9ConversationCapture(`78;claude;${CLAUDE_ID}`)).toEqual({
      provider: "claude",
      id: CLAUDE_ID,
    });
    // A codex id that is not a rollout stem is passed through unchanged, and a
    // stem that does not end in a uuid is left as-is (no worse than before).
    expect(parseOsc9ConversationCapture("78;codex;abc-123")).toEqual({
      provider: "codex",
      id: "abc-123",
    });
    expect(parseOsc9ConversationCapture("78;codex;rollout-no-uuid-here")).toEqual({
      provider: "codex",
      id: "rollout-no-uuid-here",
    });
  });

  it("rejects other OSC 9 subcommands", () => {
    expect(parseOsc9ConversationCapture("9;C:\\Dev\\TermX")).toBeNull();
    expect(parseOsc9ConversationCapture("77;output;C:\\a.md")).toBeNull();
    expect(parseOsc9ConversationCapture("4;100")).toBeNull();
    expect(parseOsc9ConversationCapture("780;claude;abc")).toBeNull();
  });

  it("rejects unknown providers and ids that are not bare tokens", () => {
    expect(parseOsc9ConversationCapture("78;grok;abc-123")).toBeNull();
    expect(parseOsc9ConversationCapture("78;constructor;abc")).toBeNull();
    expect(parseOsc9ConversationCapture("78;claude;")).toBeNull();
    expect(parseOsc9ConversationCapture("78;claude;   ")).toBeNull();
    expect(parseOsc9ConversationCapture("78;claude")).toBeNull();
    // Everything an injected transcript name could smuggle onto a command line.
    expect(parseOsc9ConversationCapture("78;claude;../../evil")).toBeNull();
    expect(parseOsc9ConversationCapture("78;claude;abc; calc")).toBeNull();
    expect(parseOsc9ConversationCapture("78;claude;$(id)")).toBeNull();
    expect(parseOsc9ConversationCapture("78;claude;a b")).toBeNull();
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
  onConversationCaptured?: (capture: {
    provider: "claude" | "codex";
    id: string;
  }) => void;
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

const OSC_CAPTURE = (payload: string) => `\u001b]9;78;${payload}\u0007`;
const OSC_CWD = (path: string) => `\u001b]9;9;${path}\u0007`;

describe("TerminalSessionBinding conversation captures", () => {
  it("fires onConversationCaptured for live captures only, never for replay", async () => {
    const captures: Array<{ provider: string; id: string }> = [];
    const { binding, emit } = fixture({
      onConversationCaptured: (capture) => captures.push(capture),
    });
    await binding.start();

    emit(chunk(`old ${OSC_CAPTURE("claude;replayed-id")}`, "replay"));
    emit(chunk(`now ${OSC_CAPTURE(`claude;${CLAUDE_ID}`)}`, "live"));

    expect(captures).toEqual([{ provider: "claude", id: CLAUDE_ID }]);
    binding.dispose();
  });

  it("reports every live launch in order — the newest capture wins upstream", async () => {
    const captures: Array<{ provider: string; id: string }> = [];
    const { binding, emit } = fixture({
      onConversationCaptured: (capture) => captures.push(capture),
    });
    await binding.start();

    emit(chunk("boot", "live"));
    emit(
      chunk(
        `${OSC_CAPTURE("claude;first-id")}${OSC_CAPTURE("codex;second-id")}`,
        "live",
      ),
    );

    expect(captures).toEqual([
      { provider: "claude", id: "first-id" },
      { provider: "codex", id: "second-id" },
    ]);
    binding.dispose();
  });

  it("ignores malformed captures without disturbing the good one", async () => {
    const captures: Array<{ provider: string; id: string }> = [];
    const { binding, emit } = fixture({
      onConversationCaptured: (capture) => captures.push(capture),
    });
    await binding.start();

    emit(chunk("boot", "live"));
    emit(
      chunk(
        `${OSC_CAPTURE("claude;")}${OSC_CAPTURE("grok;abc")}${OSC_CAPTURE("claude;a b")}${OSC_CAPTURE("claude;good-id")}`,
        "live",
      ),
    );

    expect(captures).toEqual([{ provider: "claude", id: "good-id" }]);
    binding.dispose();
  });

  it("leaves cwd reports working alongside the capture callback", async () => {
    const captures: Array<{ provider: string; id: string }> = [];
    const cwds: Array<{ path: string; live: boolean }> = [];
    const { binding, emit } = fixture({
      onConversationCaptured: (capture) => captures.push(capture),
      onCwd: (path, live) => cwds.push({ path, live }),
    });
    await binding.start();

    emit(chunk(OSC_CWD("/root/app"), "replay"));
    emit(chunk(`${OSC_CWD("/root/app")}${OSC_CAPTURE("claude;good-id")}`, "live"));

    expect(cwds).toEqual([
      { path: "/root/app", live: false },
      { path: "/root/app", live: true },
    ]);
    expect(captures).toEqual([{ provider: "claude", id: "good-id" }]);
    binding.dispose();
  });

  it("registers the OSC handler when only onConversationCaptured is supplied", async () => {
    const { terminal, binding } = fixture({
      onConversationCaptured: () => undefined,
    });
    await binding.start();

    expect(terminal.oscHandlers.get(9)?.length ?? 0).toBeGreaterThan(0);
    binding.dispose();
    expect(terminal.disposedOscHandlers).toBeGreaterThan(0);
  });
});
