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
  /** OSC handlers the binding installed, keyed by identifier, so a test can
   *  feed the OSC 9 one a payload exactly as xterm's parser would. */
  readonly oscHandlers = new Map<number, Array<(data: string) => boolean>>();
  readonly parser = {
    registerCsiHandler: () => ({ dispose: () => undefined }),
    registerDcsHandler: () => ({ dispose: () => undefined }),
    registerOscHandler: (identifier: number, handler: (data: string) => boolean) => {
      const list = this.oscHandlers.get(identifier) ?? [];
      list.push(handler);
      this.oscHandlers.set(identifier, list);
      return {
        dispose: () => {
          this.oscHandlers.set(
            identifier,
            (this.oscHandlers.get(identifier) ?? []).filter(
              (entry) => entry !== handler,
            ),
          );
        },
      };
    },
  };

  /** Deliver one OSC 9 payload (everything after `ESC]9;`). */
  emitOsc9(data: string) {
    for (const handler of this.oscHandlers.get(9) ?? []) {
      handler(data);
    }
  }

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
    registerInputMarker: vi.fn(() => undefined),
    scrollToLine: vi.fn(),
    viewportY: vi.fn(() => 0),
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
    terminal,
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

  it("survives the web-links addon's flag concatenation", () => {
    // The addon compiles urlRegex as `new RegExp(source, flags + "g")`.
    // Handing it the exported global regex produced invalid "gg" flags and a
    // SyntaxError on every hover, so the pane must pass a flagless copy
    // (regression, 2026-08-10).
    const addonCompile = (regex: RegExp) =>
      new RegExp(regex.source, `${regex.flags}g`);

    expect(() => addonCompile(PATH_LINK_REGEX)).toThrow(SyntaxError);
    expect(() => addonCompile(new RegExp(PATH_LINK_REGEX.source))).not.toThrow();
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

  // ssh-sessions spec §2: the pane is the only thing that knows which session
  // an OSC 9;78 capture belongs to, so it stamps the id on the way out.
  it("forwards conversation captures with the session id they came from", async () => {
    const fixture = paneFixture();
    const captures: Array<[number, { provider: string; id: string }]> = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TerminalPane
          dependencies={fixture.dependencies}
          onConversationCaptured={(sessionId, capture) =>
            captures.push([sessionId, capture])
          }
        />,
      );
      await flushPromises();
    });

    // Replay has to be over before a capture counts as current.
    await act(async () => {
      fixture.callbacks.onOutput?.({
        offset: 0n,
        data: new TextEncoder().encode("prompt"),
        source: "live",
      });
      await flushPromises();
    });
    await act(async () => {
      fixture.terminal.emitOsc9("78;claude;abc-123");
    });

    expect(captures).toEqual([[7, { provider: "claude", id: "abc-123" }]]);

    await act(async () => root.unmount());
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

describe("TerminalPane earlier output", () => {
  function historyFixture() {
    const fixture = paneFixture();
    let scrollListener: ((atTop: boolean) => void) | undefined;
    const dependencies: TerminalPaneDependencies = {
      ...fixture.dependencies,
      createPresentation: (element, onLink) => ({
        ...fixture.dependencies.createPresentation(element, onLink),
        onScroll: (listener: (atTop: boolean) => void) => {
          scrollListener = listener;
          return () => {
            scrollListener = undefined;
          };
        },
      }),
    };
    // Deliberately NOT spread: `fixture.callbacks` is a throwing getter until
    // the pane attaches, and spreading would evaluate it here.
    return {
      client: fixture.client,
      dependencies,
      scrollTo(atTop: boolean) {
        if (!scrollListener) {
          throw new Error("scroll listener is not installed");
        }
        scrollListener(atTop);
      },
    };
  }

  it("offers earlier output only at the top of a scrollback that has some", async () => {
    const fixture = historyFixture();
    const onLoadEarlier = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TerminalPane
          client={fixture.client}
          sessionId={7}
          historyBefore={4_096n}
          onLoadEarlier={onLoadEarlier}
          dependencies={fixture.dependencies}
        />,
      );
      await flushPromises();
    });

    // Not while the user is reading the live tail.
    expect(container.querySelector("[data-testid='load-earlier-output']")).toBeNull();

    await act(async () => fixture.scrollTo(true));
    const bar = container.querySelector<HTMLButtonElement>(
      "[data-testid='load-earlier-output']",
    );
    expect(bar).not.toBeNull();
    await act(async () => bar!.click());
    expect(onLoadEarlier).toHaveBeenCalledWith(4_096n);

    await act(async () => fixture.scrollTo(false));
    expect(container.querySelector("[data-testid='load-earlier-output']")).toBeNull();

    await act(async () => root.unmount());
  });

  it("stays quiet when the session has never lost a byte to disk", async () => {
    const fixture = historyFixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TerminalPane
          client={fixture.client}
          sessionId={7}
          historyBefore={0n}
          onLoadEarlier={vi.fn()}
          dependencies={fixture.dependencies}
        />,
      );
      await flushPromises();
    });
    await act(async () => fixture.scrollTo(true));

    expect(container.querySelector("[data-testid='load-earlier-output']")).toBeNull();

    await act(async () => root.unmount());
  });
});

describe("TerminalPane reconnect", () => {
  it("rebinds to the host when the hub reports a new attach generation", async () => {
    const fixture = paneFixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TerminalPane
          client={fixture.client}
          sessionId={7}
          attachGeneration={0}
          dependencies={fixture.dependencies}
        />,
      );
      await flushPromises();
    });
    expect(fixture.client.attach).toHaveBeenCalledTimes(1);

    // The binding is one-shot: onDisconnect ends it for good, so a reconnect
    // has to build a new one or the pane stays dead until a restart.
    await act(async () => {
      fixture.callbacks.onDisconnect?.();
      await flushPromises();
    });
    expect(container.textContent).toContain("Host connection lost");

    await act(async () => {
      root.render(
        <TerminalPane
          client={fixture.client}
          sessionId={7}
          attachGeneration={1}
          dependencies={fixture.dependencies}
        />,
      );
      await flushPromises();
    });

    expect(fixture.client.attach).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Host connection lost");

    await act(async () => root.unmount());
  });

  it("shows a reconnecting chip instead of pretending the session died", async () => {
    const fixture = paneFixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TerminalPane
          client={fixture.client}
          sessionId={7}
          suspended
          dependencies={fixture.dependencies}
        />,
      );
      await flushPromises();
    });

    const chip = container.querySelector("[data-testid='pane-reconnecting-chip']");
    expect(chip?.textContent).toContain("Reconnecting");
    expect(container.querySelector("[data-testid='dead-pane']")).toBeNull();

    await act(async () => root.unmount());
  });

  it("does not repeat the outage in the status line while the chip is up", async () => {
    const fixture = paneFixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TerminalPane
          client={fixture.client}
          sessionId={7}
          suspended
          dependencies={fixture.dependencies}
        />,
      );
      await flushPromises();
    });
    await act(async () => {
      fixture.callbacks.onDisconnect?.();
      await flushPromises();
    });

    expect(container.querySelector(".terminal-pane__status--disconnected")).toBeNull();

    await act(async () => root.unmount());
  });
});
