import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryPage } from "../../host/client";
import { HistoryView, decodeHistory, trimToBoundary } from "../HistoryView";

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
  container.remove();
});

async function render(ui: React.ReactElement): Promise<void> {
  await act(async () => root.render(ui));
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function button(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
}

describe("trimToBoundary", () => {
  it("leaves a page that already starts at a boundary", () => {
    const page = bytes("\nhello world");
    expect(trimToBoundary(page)).toEqual(page);
  });

  it("drops the partial first line a byte offset lands in the middle of", () => {
    const trimmed = trimToBoundary(bytes("f a line\nwhole line"));
    expect(new TextDecoder().decode(trimmed)).toBe("\nwhole line");
  });

  it("drops a partial escape sequence at the head of a page", () => {
    // The page began mid-CSI; rendering those bytes would print garbage.
    const trimmed = trimToBoundary(bytes("31mred\x1b[0m done"));
    expect(new TextDecoder().decode(trimmed)).toBe("\x1b[0m done");
  });

  it("prefers the earliest boundary, escape or newline", () => {
    const trimmed = trimToBoundary(bytes("junk\nrest\x1b[0m"));
    expect(new TextDecoder().decode(trimmed)).toBe("\nrest\x1b[0m");
  });

  it("keeps a page with no boundary at all rather than showing nothing", () => {
    const page = bytes("no boundary here");
    expect(trimToBoundary(page)).toEqual(page);
  });
});

describe("decodeHistory", () => {
  it("strips the escape sequences the plain-text surface cannot render", () => {
    expect(decodeHistory(bytes("\x1b[31mred\x1b[0m\r\nplain\r\n"))).toBe("red\nplain\n");
  });

  it("drops OSC payloads whole, including the shell-integration reports", () => {
    expect(decodeHistory(bytes("a\x1b]9;9;C:\\work\x07b"))).toBe("ab");
  });
});

describe("HistoryView", () => {
  function reader(pages: HistoryPage[]) {
    const calls: Array<{ before: bigint; maxBytes: number }> = [];
    const read = vi.fn(async (before: bigint, maxBytes: number) => {
      calls.push({ before, maxBytes });
      const page = pages.shift();
      if (!page) {
        throw new Error("no page scripted");
      }
      return page;
    });
    return { calls, read };
  }

  it("opens on the newest page and pages backward until the start", async () => {
    const { calls, read } = reader([
      { startOffset: 900n, data: bytes("\nnewest"), atStart: false },
      { startOffset: 0n, data: bytes("oldest"), atStart: true },
    ]);

    await render(<HistoryView sessionId={7} beforeOffset={1_000n} read={read} />);
    expect(container.textContent).toContain("newest");
    expect(calls[0]).toEqual({ before: 1_000n, maxBytes: 65_536 });

    const older = button("Load older");
    expect(older).toBeDefined();
    await act(async () => older!.click());

    // Older output reads above the newer page, the way scrollback runs.
    expect(container.textContent?.indexOf("oldest")).toBeLessThan(
      container.textContent!.indexOf("newest"),
    );
    expect(calls[1]).toEqual({ before: 900n, maxBytes: 65_536 });
    expect(button("Load older")).toBeUndefined();
    expect(container.textContent).toContain("This is the oldest output the host still has.");
  });

  it("stops paging when the host answers empty, and says so", async () => {
    const { read } = reader([{ startOffset: 0n, data: new Uint8Array(0), atStart: true }]);

    await render(<HistoryView sessionId={7} beforeOffset={0n} read={read} />);

    expect(read).toHaveBeenCalledTimes(1);
    expect(button("Load older")).toBeUndefined();
    expect(container.textContent).toContain("No earlier output was kept for this session.");
  });

  it("reports a failed read without losing the pages already on screen", async () => {
    const read = vi
      .fn<(before: bigint, maxBytes: number) => Promise<HistoryPage>>()
      .mockResolvedValueOnce({ startOffset: 500n, data: bytes("kept"), atStart: false })
      .mockRejectedValueOnce(new Error("Host connection is closed"));

    await render(<HistoryView sessionId={7} beforeOffset={900n} read={read} />);
    await act(async () => button("Load older")!.click());

    expect(container.textContent).toContain("kept");
    expect(container.textContent).toContain("Host connection is closed");
    // Still offered: the connection may well be back by the time they click.
    expect(button("Load older")).toBeDefined();
  });

  it("ignores a page that lands after the session it was asked for changed", async () => {
    let resolveFirst!: (page: HistoryPage) => void;
    const read = vi
      .fn<(before: bigint, maxBytes: number) => Promise<HistoryPage>>()
      .mockImplementationOnce(
        () => new Promise<HistoryPage>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValue({ startOffset: 10n, data: bytes("second session"), atStart: true });

    await render(<HistoryView sessionId={7} beforeOffset={900n} read={read} />);
    await render(<HistoryView sessionId={8} beforeOffset={900n} read={read} />);
    await act(async () => {
      resolveFirst({ startOffset: 800n, data: bytes("first session"), atStart: false });
    });

    expect(container.textContent).toContain("second session");
    expect(container.textContent).not.toContain("first session");
  });
});
