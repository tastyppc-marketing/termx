import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));

import type { SessionAttachment, SessionAttachmentCallbacks } from "../../host/client";
import { xtermTheme } from "../../theme/deriveTokens";
import { applyTheme } from "../../theme/ThemeProvider";
import { DEFAULT_THEME_ID, THEMES } from "../../theme/themes";
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

function fixture() {
  const setTheme = vi.fn();
  const presentation: TerminalPresentation = {
    terminal: new FakeTerminal(),
    fit: vi.fn(),
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    setTheme,
    registerInputMarker: vi.fn(() => undefined),
    scrollToLine: vi.fn(),
    viewportY: vi.fn(() => 0),
  };
  const attachment: SessionAttachment = {
    sessionId: 3,
    nextOffset: 0n,
    sendInput: vi.fn(),
    resize: vi.fn(),
    detach: vi.fn(),
  };
  const client = {
    attach: vi.fn(async (_id: number, _callbacks: SessionAttachmentCallbacks) => attachment),
    onError: vi.fn(() => vi.fn()),
    close: vi.fn(),
  };
  const dependencies: TerminalPaneDependencies = {
    bootstrapSession: vi.fn(async () => ({ client, sessionId: 3 })),
    createPresentation: vi.fn(() => presentation),
    observeResize: vi.fn(() => vi.fn()),
    activateLink: vi.fn(async () => null),
  };
  return { dependencies, setTheme };
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  applyTheme(DEFAULT_THEME_ID);
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("TerminalPane theming", () => {
  it("retints a running terminal when the theme changes, and stops on unmount", async () => {
    const { dependencies, setTheme } = fixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<TerminalPane dependencies={dependencies} />);
    });

    setTheme.mockClear();
    await act(async () => {
      applyTheme("paper-light");
    });
    expect(setTheme).toHaveBeenCalledWith(xtermTheme(THEMES["paper-light"]));

    setTheme.mockClear();
    await act(async () => {
      applyTheme("dark-iron");
    });
    expect(setTheme).toHaveBeenCalledWith(xtermTheme(THEMES["dark-iron"]));

    setTheme.mockClear();
    await act(async () => root.unmount());
    applyTheme("cold-steel");
    expect(setTheme).not.toHaveBeenCalled();
  });

  it("survives a presentation that cannot retint (setTheme is optional)", async () => {
    const { dependencies } = fixture();
    const presentation = dependencies.createPresentation(
      document.createElement("div"),
      () => undefined,
    ) as TerminalPresentation & { setTheme?: unknown };
    delete presentation.setTheme;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<TerminalPane dependencies={dependencies} />);
    });
    expect(() => applyTheme("slate-medium")).not.toThrow();
    await act(async () => root.unmount());
  });
});
