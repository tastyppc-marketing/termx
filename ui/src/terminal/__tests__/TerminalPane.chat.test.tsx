/**
 * The chat view mounted on a real pane (chat-view spec §1).
 *
 * The load-bearing claim these tests defend: flipping to chat does not stop
 * the terminal. The xterm surface stays in the DOM, its attachment is never
 * detached, and everything the chat sends goes out over that same attachment.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));

import type {
  SessionAttachment,
  SessionAttachmentCallbacks,
} from "../../host/client";
import type { ChatFeed } from "../../chat/feed";
import type { PaneChatProps } from "../TerminalPane";
import {
  TerminalPane,
  type TerminalPaneDependencies,
  type TerminalPresentation,
} from "../TerminalPane";

class FakeTerminal {
  cols = 80;
  rows = 24;
  readonly parser = {
    registerCsiHandler: () => ({ dispose: () => undefined }),
    registerDcsHandler: () => ({ dispose: () => undefined }),
    registerOscHandler: () => ({ dispose: () => undefined }),
  };

  onData() {
    return { dispose: () => undefined };
  }

  reset() {}
  reassertWindowsPtyInputMode() {}
  write(_data: string, callback?: () => void) {
    callback?.();
  }
}

const SCREEN = ["Do you want to proceed?", "❯ 1. Yes", "  2. No"];

function paneFixture() {
  const attachment: SessionAttachment = {
    sessionId: 7,
    nextOffset: 0n,
    sendInput: vi.fn(),
    resize: vi.fn(),
    detach: vi.fn(),
  };
  const presentation: TerminalPresentation = {
    terminal: new FakeTerminal(),
    fit: vi.fn(),
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    registerInputMarker: vi.fn(() => undefined),
    scrollToLine: vi.fn(),
    viewportY: vi.fn(() => 0),
    visibleLines: vi.fn(() => SCREEN),
  };
  let callbacks: SessionAttachmentCallbacks | undefined;
  const client = {
    attach: vi.fn(async (_sessionId: number, next: SessionAttachmentCallbacks) => {
      callbacks = next;
      return attachment;
    }),
    onError: vi.fn(() => vi.fn()),
    close: vi.fn(),
  };
  const dependencies: TerminalPaneDependencies = {
    bootstrapSession: vi.fn(async () => ({ client, sessionId: 7 })),
    createPresentation: vi.fn(() => presentation),
    observeResize: vi.fn(() => vi.fn()),
    activateLink: vi.fn(async () => null),
  };
  return {
    attachment,
    client,
    dependencies,
    presentation,
    get callbacks() {
      if (!callbacks) {
        throw new Error("attachment callbacks are not installed");
      }
      return callbacks;
    },
  };
}

/** A feed that answers instantly and holds a fixed conversation. */
function fakeOpenFeed(): { open: () => Promise<ChatFeed>; disposed: () => number } {
  let disposed = 0;
  const feed: ChatFeed = {
    entries: [{ kind: "user", id: "u1", ts: 1, text: "the opening prompt" }],
    stale: false,
    onUpdate: () => () => undefined,
    onStale: () => () => undefined,
    dispose: () => {
      disposed += 1;
    },
  };
  return {
    open: async () => feed,
    disposed: () => disposed,
  };
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.replaceChildren();
});

async function mountPane(chat: PaneChatProps | undefined) {
  const fixture = paneFixture();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <TerminalPane
        client={fixture.client}
        sessionId={7}
        dependencies={fixture.dependencies}
        {...(chat ? { chat } : {})}
      />,
    ),
  );
  await act(async () => undefined);
  return { ...fixture, container, root };
}

function chatProps(overrides: Partial<PaneChatProps> = {}): PaneChatProps {
  const opener = fakeOpenFeed();
  return {
    filePath: "C:\\Users\\me\\.claude\\projects\\C--Dev-TermX\\a.jsonl",
    title: "Chat view",
    mode: "terminal",
    density: "chips",
    showThinking: false,
    onModeChange: vi.fn(),
    onDensityChange: vi.fn(),
    onShowThinkingChange: vi.fn(),
    slashCommands: [],
    onCommandsLearned: vi.fn(),
    openFeed: opener.open as PaneChatProps["openFeed"],
    ...overrides,
  };
}

describe("TerminalPane chat view", () => {
  it("offers no switch on a pane that is not linked to a session", async () => {
    const pane = await mountPane(undefined);
    expect(pane.container.querySelector('[data-testid="chat-switch"]')).toBeNull();
    expect(pane.container.querySelector('[data-testid="chat-view"]')).toBeNull();
  });

  it("offers the switch on a linked pane and reports the flip", async () => {
    const onModeChange = vi.fn();
    const pane = await mountPane(chatProps({ onModeChange }));
    const button = pane.container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-switch"]',
    );
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(onModeChange).toHaveBeenCalledWith("chat");
  });

  it("keeps the terminal mounted and attached underneath the chat", async () => {
    const pane = await mountPane(chatProps({ mode: "chat" }));
    expect(pane.container.querySelector('[data-testid="chat-view"]')).not.toBeNull();
    const surface = pane.container.querySelector(".terminal-pane__surface");
    expect(surface).not.toBeNull();
    // Mounted but inert: xterm's hidden textarea must not be one Tab away
    // while the chat owns the keyboard (v3 §0/§6).
    expect(surface?.hasAttribute("inert")).toBe(true);
    expect(pane.attachment.detach).not.toHaveBeenCalled();
    expect(pane.presentation.dispose).not.toHaveBeenCalled();
    // No switch while the chat is up: the header's own button flips back.
    expect(pane.container.querySelector('[data-testid="chat-switch"]')).toBeNull();
  });

  it("sends the chat's keystrokes over the session's own attachment", async () => {
    const pane = await mountPane(chatProps({ mode: "chat" }));
    const esc = Array.from(pane.container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Esc",
    );
    await act(async () => esc?.click());
    expect(pane.attachment.sendInput).toHaveBeenCalledWith("\x1b");
  });

  it("renders the linked transcript's entries", async () => {
    const pane = await mountPane(chatProps({ mode: "chat" }));
    expect(pane.container.textContent).toContain("the opening prompt");
  });

  it("reads the visible terminal rows for the prompt detector", async () => {
    const pane = await mountPane(chatProps({ mode: "chat" }));
    expect(pane.presentation.visibleLines).toBeDefined();
    expect(pane.presentation.visibleLines?.()).toEqual(SCREEN);
  });
});
