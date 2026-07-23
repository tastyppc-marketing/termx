import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));

import type {
  SessionAttachment,
  SessionAttachmentCallbacks,
} from "../../host/client";
import {
  activateTerminalLink,
  PATH_LINK_REGEX,
  TerminalPane,
  type TerminalPaneDependencies,
  type TerminalPresentation,
} from "../TerminalPane";

class FakePresentationTerminal {
  cols = 80;
  rows = 24;
  readonly writes: string[] = [];
  readonly parser = {
    registerCsiHandler: () => ({ dispose: () => undefined }),
    registerDcsHandler: () => ({ dispose: () => undefined }),
    registerOscHandler: () => ({ dispose: () => undefined }),
  };

  onData(_listener: (data: string) => void) {
    return { dispose: () => undefined };
  }

  reset() {}

  reassertWindowsPtyInputMode() {}

  write(data: string, callback?: () => void) {
    this.writes.push(data);
    callback?.();
  }
}

function paneFixture() {
  const terminal = new FakePresentationTerminal();
  const fit = vi.fn();
  const findNext = vi.fn();
  const findPrevious = vi.fn();
  const focus = vi.fn();
  const dispose = vi.fn();
  const presentation: TerminalPresentation = {
    terminal,
    fit,
    findNext,
    findPrevious,
    focus,
    dispose,
  };
  let callbacks: SessionAttachmentCallbacks | undefined;
  let hostErrorListener: ((error: Error) => void) | undefined;
  let linkHandler: ((link: string) => void) | undefined;
  const unsubscribeHostError = vi.fn();
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
    onError: vi.fn((listener: (error: Error) => void) => {
      hostErrorListener = listener;
      return unsubscribeHostError;
    }),
    close: vi.fn(),
  };
  const stopObserving = vi.fn();
  const activateLink = vi.fn(async (link: string) =>
    link.startsWith("http") ? "The link could not be opened." : "Path copied to clipboard.",
  );
  const dependencies: TerminalPaneDependencies = {
    bootstrapSession: vi.fn(async () => ({ client, sessionId: 7 })),
    createPresentation: vi.fn((_element, onLink) => {
      linkHandler = onLink;
      return presentation;
    }),
    observeResize: vi.fn((_element, _listener) => stopObserving),
    activateLink,
  };

  return {
    attachment,
    activateLink,
    client,
    dependencies,
    dispose,
    emitHostError(error: Error) {
      if (!hostErrorListener) {
        throw new Error("host error listener is not installed");
      }
      hostErrorListener(error);
    },
    activatePresentedLink(link: string) {
      if (!linkHandler) {
        throw new Error("link handler is not installed");
      }
      linkHandler(link);
    },
    findNext,
    findPrevious,
    focus,
    get callbacks() {
      if (!callbacks) {
        throw new Error("attachment callbacks are not installed");
      }
      return callbacks;
    },
    stopObserving,
    unsubscribeHostError,
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("TerminalPane", () => {
  it("recognizes supported Windows, UNC, relative, and POSIX paths", () => {
    const paths = [
      "C:\\work\\file.ts:4",
      "\\\\server\\share\\file.txt",
      "./src/App.tsx",
      "../src/App.tsx",
      "/home/user/file.txt",
      "src/App.tsx:11",
    ];

    for (const path of paths) {
      expect(path.match(PATH_LINK_REGEX)).toEqual([path]);
    }
  });

  it("recognizes diagnostic paths immediately following a colon", () => {
    const windowsPath = String.raw`C:\work\file.ts`;
    const cases = [
      { text: "ENOENT:/home/user/file.txt", expected: "/home/user/file.txt" },
      { text: `path:${windowsPath}`, expected: windowsPath },
    ];

    for (const { text, expected } of cases) {
      expect(Array.from(text.matchAll(PATH_LINK_REGEX), (match) => match[0])).toEqual([
        expected,
      ]);
    }
  });

  it("does not classify any portion of HTTP URLs as file paths", () => {
    const text = "Visit https://example.com/path or http://localhost:3000/a";

    expect(Array.from(text.matchAll(PATH_LINK_REGEX), (match) => match[0])).toEqual([]);
  });

  it("does not misreport secure URL activation as blocked", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    await expect(activateTerminalLink("https://example.com/docs")).resolves.toBe(
      "Link sent to the browser.",
    );
    expect(open).toHaveBeenCalledWith(
      "https://example.com/docs",
      "_blank",
      "noopener,noreferrer",
    );
    open.mockRestore();
  });

  it("bootstraps one attachment and exposes search and exit state", async () => {
    const fixture = paneFixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<TerminalPane dependencies={fixture.dependencies} />);
      await flushPromises();
    });

    expect(fixture.dependencies.bootstrapSession).toHaveBeenCalledOnce();
    expect(fixture.client.attach).toHaveBeenCalledWith(7, expect.any(Object), true);
    expect(fixture.focus).toHaveBeenCalledOnce();

    const pane = container.querySelector<HTMLElement>("[data-testid='terminal-pane']");
    expect(pane).not.toBeNull();
    await act(async () => {
      pane?.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    });

    const search = container.querySelector<HTMLInputElement>("[aria-label='Search terminal output']");
    expect(search).not.toBeNull();
    await act(async () => {
      if (!search) {
        return;
      }
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(search, "needle");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      search?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(fixture.findNext).toHaveBeenCalledWith("needle");

    await act(async () => {
      fixture.callbacks.onExit?.(23);
    });
    expect(container.textContent).toContain("Session exited with code 23");

    await act(async () => root.unmount());
    expect(fixture.attachment.detach).toHaveBeenCalledOnce();
    expect(fixture.client.close).toHaveBeenCalledOnce();
    expect(fixture.dispose).toHaveBeenCalledOnce();
    expect(fixture.stopObserving).toHaveBeenCalledOnce();
  });

  it("closes an owned client immediately when attach fails", async () => {
    const fixture = paneFixture();
    fixture.client.attach.mockRejectedValue(new Error("attach refused"));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<TerminalPane dependencies={fixture.dependencies} />);
      await flushPromises();
    });

    expect(container.textContent).toContain("Unable to open terminal: attach refused");
    expect(fixture.client.close).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    expect(fixture.client.close).toHaveBeenCalledOnce();
  });

  it("contains presentation construction failures in the pane", async () => {
    const fixture = paneFixture();
    fixture.dependencies.createPresentation = vi.fn(() => {
      throw new Error("renderer unavailable");
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<TerminalPane dependencies={fixture.dependencies} />));

    expect(container.textContent).toContain("Unable to open terminal: renderer unavailable");
    await act(async () => root.unmount());
  });

  it("keeps the newest link activation outcome when requests resolve out of order", async () => {
    const fixture = paneFixture();
    const resolvers: Array<(message: string | null) => void> = [];
    fixture.dependencies.activateLink = vi.fn(
      async () =>
        new Promise<string | null>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<TerminalPane dependencies={fixture.dependencies} />);
      await flushPromises();
    });
    await act(async () => {
      fixture.activatePresentedLink("first/path");
      fixture.activatePresentedLink("second/path");
    });
    await act(async () => {
      resolvers[1]?.("Second path copied.");
      await flushPromises();
    });
    expect(container.textContent).toContain("Second path copied.");

    await act(async () => {
      resolvers[0]?.("First path copied.");
      await flushPromises();
    });
    expect(container.textContent).toContain("Second path copied.");
    expect(container.textContent).not.toContain("First path copied.");

    await act(async () => root.unmount());
  });

  it("surfaces host errors and link activation outcomes", async () => {
    const fixture = paneFixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<TerminalPane dependencies={fixture.dependencies} />);
      await flushPromises();
    });
    await act(async () => fixture.emitHostError(new Error("host rejected input")));
    expect(container.textContent).toContain("Terminal host error: host rejected input");

    await act(async () => {
      fixture.activatePresentedLink("src/App.tsx:11");
      await flushPromises();
    });
    expect(fixture.activateLink).toHaveBeenCalledWith("src/App.tsx:11");
    expect(container.textContent).toContain("Path copied to clipboard.");

    await act(async () => root.unmount());
    expect(fixture.unsubscribeHostError).toHaveBeenCalledOnce();
  });

  it("continues teardown when one cleanup operation fails", async () => {
    const fixture = paneFixture();
    fixture.stopObserving.mockImplementation(() => {
      throw new Error("observer cleanup failed");
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<TerminalPane dependencies={fixture.dependencies} />);
      await flushPromises();
    });
    await act(async () => root.unmount());

    expect(fixture.attachment.detach).toHaveBeenCalledOnce();
    expect(fixture.client.close).toHaveBeenCalledOnce();
    expect(fixture.dispose).toHaveBeenCalledOnce();
    expect(fixture.unsubscribeHostError).toHaveBeenCalledOnce();
  });

  it("does not close a client supplied by the parent", async () => {
    const fixture = paneFixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TerminalPane
          client={fixture.client}
          sessionId={7}
          dependencies={fixture.dependencies}
        />,
      );
      await flushPromises();
    });
    await act(async () => root.unmount());

    expect(fixture.dependencies.bootstrapSession).not.toHaveBeenCalled();
    expect(fixture.attachment.detach).toHaveBeenCalledOnce();
    expect(fixture.client.close).not.toHaveBeenCalled();
  });
});
