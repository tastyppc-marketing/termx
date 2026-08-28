import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyLayout, type Layout, type WindowBounds } from "../../state/layout";
import {
  manageAuxWindow,
  openAuxWindows,
  type AuxWindowChrome,
  type WindowFactory,
} from "../windowManager";

function layoutWithSlots(
  slots: Record<string, WindowBounds | null>,
): Layout {
  const layout = emptyLayout();
  for (const [windowId, bounds] of Object.entries(slots)) {
    layout.auxWindows[windowId] = { rootItems: [], activeTabId: null, bounds };
  }
  return layout;
}

function fakeFactory(openIds: string[] = []) {
  const opened: Array<{ windowId: string; bounds: WindowBounds | null }> = [];
  const factory: WindowFactory = {
    isOpen: vi.fn(async (windowId: string) => openIds.includes(windowId)),
    open: vi.fn(async (windowId: string, bounds: WindowBounds | null) => {
      opened.push({ windowId, bounds });
    }),
  };
  return { factory, opened };
}

describe("openAuxWindows", () => {
  it("opens every aux slot at its recorded bounds, main excluded", async () => {
    const bounds = { x: 1920, y: 0, width: 1280, height: 800 };
    const { factory, opened } = fakeFactory();
    await openAuxWindows(
      layoutWithSlots({ "aux-1": bounds, "aux-2": null }),
      factory,
    );
    expect(opened).toEqual([
      { windowId: "aux-1", bounds },
      { windowId: "aux-2", bounds: null },
    ]);
  });

  it("skips windows that are already open", async () => {
    const { factory, opened } = fakeFactory(["aux-1"]);
    await openAuxWindows(
      layoutWithSlots({ "aux-1": null, "aux-2": null }),
      factory,
    );
    expect(opened.map((entry) => entry.windowId)).toEqual(["aux-2"]);
  });

  it("contains one slot's failure and still opens the rest", async () => {
    const { factory, opened } = fakeFactory();
    vi.mocked(factory.open).mockImplementationOnce(async () => {
      throw new Error("monitor unplugged");
    });
    await openAuxWindows(
      layoutWithSlots({ "aux-1": null, "aux-2": null }),
      factory,
    );
    expect(opened.map((entry) => entry.windowId)).toEqual(["aux-2"]);
  });
});

describe("manageAuxWindow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeChrome() {
    let closeHandler: ((event: { preventDefault(): void }) => void) | null =
      null;
    let movedHandler: (() => void) | null = null;
    let resizedHandler: (() => void) | null = null;
    const destroy = vi.fn(async () => undefined);
    const chrome: AuxWindowChrome = {
      onCloseRequested: async (handler) => {
        closeHandler = handler;
        return () => {
          closeHandler = null;
        };
      },
      onMoved: async (handler) => {
        movedHandler = handler;
        return () => {
          movedHandler = null;
        };
      },
      onResized: async (handler) => {
        resizedHandler = handler;
        return () => {
          resizedHandler = null;
        };
      },
      outerPosition: async () => ({ x: 10, y: 20 }),
      outerSize: async () => ({ width: 800, height: 600 }),
      destroy,
    };
    return {
      chrome,
      destroy,
      requestClose(): { prevented: boolean } {
        const event = { prevented: false, preventDefault(): void {} };
        event.preventDefault = () => {
          event.prevented = true;
        };
        closeHandler?.(event);
        return event;
      },
      move: () => movedHandler?.(),
      resize: () => resizedHandler?.(),
    };
  }

  function fakeController() {
    const calls: string[] = [];
    return {
      calls,
      controller: {
        returnWindowToMain: vi.fn((windowId: string) => {
          calls.push(`return:${windowId}`);
        }),
        flush: vi.fn(async () => {
          calls.push("flush");
        }),
        recordWindowBounds: vi.fn(),
      },
    };
  }

  it("close-requested returns items to main, flushes, then destroys", async () => {
    const { chrome, destroy, requestClose } = fakeChrome();
    const { controller, calls } = fakeController();
    manageAuxWindow({ windowId: "aux-1", controller, chrome });
    await vi.runAllTimersAsync(); // let the async registrations land

    const event = requestClose();
    expect(event.prevented).toBe(true);
    await vi.runAllTimersAsync();

    expect(calls).toEqual(["return:aux-1", "flush"]);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("debounces move/resize bursts into one bounds record", async () => {
    const { chrome, move, resize } = fakeChrome();
    const { controller } = fakeController();
    manageAuxWindow({ windowId: "aux-1", controller, chrome });
    await vi.runAllTimersAsync();

    move();
    vi.advanceTimersByTime(200);
    resize();
    vi.advanceTimersByTime(200);
    move();
    expect(controller.recordWindowBounds).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(controller.recordWindowBounds).toHaveBeenCalledTimes(1);
    expect(controller.recordWindowBounds).toHaveBeenCalledWith({
      x: 10,
      y: 20,
      width: 800,
      height: 600,
    });
  });

  it("cleanup stops listeners and swallows the pending debounce", async () => {
    const { chrome, move } = fakeChrome();
    const { controller } = fakeController();
    const dispose = manageAuxWindow({ windowId: "aux-1", controller, chrome });
    await vi.runAllTimersAsync();

    move();
    dispose();
    await vi.runAllTimersAsync();
    expect(controller.recordWindowBounds).not.toHaveBeenCalled();
  });
});
