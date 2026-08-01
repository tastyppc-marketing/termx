import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));

import type { SessionAttachment, SessionAttachmentCallbacks } from "../../host/client";
import {
  TerminalPane,
  type TerminalPaneDependencies,
  type TerminalPresentation,
} from "../TerminalPane";

const encoder = new TextEncoder();

/**
 * A presentation that records the exact order of the reattach steps that
 * matter for spec §13: size-to-recorded-dims → replay → fit + host resize.
 */
function dimsFixture(fitTo = { cols: 100, rows: 40 }) {
  const events: string[] = [];
  const terminal = {
    cols: 80,
    rows: 24,
    parser: {
      registerCsiHandler: () => ({ dispose: () => undefined }),
      registerDcsHandler: () => ({ dispose: () => undefined }),
      registerOscHandler: () => ({ dispose: () => undefined }),
    },
    onData: () => ({ dispose: () => undefined }),
    reset: () => undefined,
    reassertWindowsPtyInputMode: () => undefined,
    write: (data: string, callback?: () => void) => {
      if (data.length > 0) {
        events.push(`write:${data}`);
      }
      callback?.();
    },
  };
  const presentation: TerminalPresentation = {
    terminal,
    fit: () => {
      events.push("fit");
      terminal.cols = fitTo.cols;
      terminal.rows = fitTo.rows;
    },
    resize: (cols, rows) => {
      events.push(`presentation-resize:${cols}x${rows}`);
      terminal.cols = cols;
      terminal.rows = rows;
    },
    findNext: () => false,
    findPrevious: () => false,
    focus: () => undefined,
    dispose: () => undefined,
    registerInputMarker: () => undefined,
    scrollToLine: () => undefined,
    viewportY: () => 0,
  };

  const attachment: SessionAttachment = {
    sessionId: 7,
    nextOffset: 0n,
    sendInput: () => undefined,
    resize: (cols, rows) => events.push(`host-resize:${cols}x${rows}`),
    detach: () => undefined,
  };

  let callbacks: SessionAttachmentCallbacks | undefined;
  let releaseAttach: (() => void) | undefined;
  let resizeListener: (() => void) | undefined;
  const client = {
    attach: vi.fn(
      (_sessionId: number, nextCallbacks: SessionAttachmentCallbacks) =>
        new Promise<SessionAttachment>((resolve) => {
          callbacks = nextCallbacks;
          releaseAttach = () => resolve(attachment);
        }),
    ),
    onError: vi.fn(() => () => undefined),
    close: vi.fn(),
  };

  const dependencies: TerminalPaneDependencies = {
    bootstrapSession: vi.fn(async () => ({ client, sessionId: 7 })),
    createPresentation: vi.fn(() => presentation),
    observeResize: vi.fn((_element, listener: () => void) => {
      resizeListener = listener;
      return () => undefined;
    }),
    activateLink: vi.fn(async () => null),
  };

  return {
    client,
    dependencies,
    events,
    emitReplay(text: string) {
      callbacks?.onOutput?.({
        offset: 0n,
        data: encoder.encode(text),
        source: "replay",
      });
    },
    /** The zero-length live frame the hub sends to close replay. */
    emitLiveBoundary() {
      callbacks?.onOutput?.({
        offset: 0n,
        data: new Uint8Array(0),
        source: "live",
      });
    },
    resolveAttach() {
      releaseAttach?.();
    },
    resizeContainer() {
      if (!resizeListener) {
        throw new Error("resize observer is not installed");
      }
      resizeListener();
    },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("TerminalPane reattach dimensions", () => {
  it("sizes to the recorded dims, replays, and only then fits and resizes the host", async () => {
    const fixture = dimsFixture();

    await act(async () => {
      root.render(
        <TerminalPane
          client={fixture.client}
          sessionId={7}
          recordedDims={{ cols: 120, rows: 30 }}
          dependencies={fixture.dependencies}
        />,
      );
      await flushPromises();
    });

    fixture.emitReplay("REPLAYED-FRAME");
    fixture.emitLiveBoundary();
    await act(async () => {
      fixture.resolveAttach();
      await flushPromises();
    });

    expect(fixture.events).toEqual([
      "presentation-resize:120x30",
      "write:REPLAYED-FRAME",
      "fit",
      "host-resize:100x40",
    ]);
  });

  it("ignores container resizes until replay has finished", async () => {
    const fixture = dimsFixture();

    await act(async () => {
      root.render(
        <TerminalPane
          client={fixture.client}
          sessionId={7}
          recordedDims={{ cols: 120, rows: 30 }}
          dependencies={fixture.dependencies}
        />,
      );
      await flushPromises();
    });

    fixture.emitReplay("REPLAYED-FRAME");
    fixture.resizeContainer();

    // Nothing may reshape the grid while replayed bytes are still landing.
    expect(fixture.events).toEqual([
      "presentation-resize:120x30",
      "write:REPLAYED-FRAME",
    ]);

    // No live frame ever arrives; the resolved attach closes replay instead.
    await act(async () => {
      fixture.resolveAttach();
      await flushPromises();
    });

    expect(fixture.events).toEqual([
      "presentation-resize:120x30",
      "write:REPLAYED-FRAME",
      "fit",
      "host-resize:100x40",
    ]);

    fixture.resizeContainer();
    expect(fixture.events.filter((event) => event === "fit")).toHaveLength(2);
  });

  it("keeps the fit-first path when the session has no recorded dims", async () => {
    const fixture = dimsFixture();

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

    fixture.emitReplay("REPLAYED-FRAME");
    fixture.emitLiveBoundary();
    await act(async () => {
      fixture.resolveAttach();
      await flushPromises();
    });

    expect(fixture.events).not.toContain("presentation-resize:120x30");
    expect(fixture.events).toEqual([
      "write:REPLAYED-FRAME",
      "fit",
      "host-resize:100x40",
    ]);
  });

  it("ignores unusable recorded dims instead of pre-sizing the terminal", async () => {
    const fixture = dimsFixture();

    await act(async () => {
      root.render(
        <TerminalPane
          client={fixture.client}
          sessionId={7}
          recordedDims={{ cols: 0, rows: -4 }}
          dependencies={fixture.dependencies}
        />,
      );
      await flushPromises();
    });

    fixture.emitReplay("REPLAYED-FRAME");
    fixture.emitLiveBoundary();
    await act(async () => {
      fixture.resolveAttach();
      await flushPromises();
    });

    expect(fixture.events.some((event) => event.startsWith("presentation-resize"))).toBe(
      false,
    );
    expect(fixture.events).toEqual([
      "write:REPLAYED-FRAME",
      "fit",
      "host-resize:100x40",
    ]);
  });
});
