import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TranscriptCommands,
  TranscriptSearchResult,
  TranscriptWindowResult,
} from "../../../native/transcript";
import type { LlmSessionRecord } from "../../ViewerHost";
import {
  TranscriptCommandsProvider,
  TranscriptView,
} from "../TranscriptView";

let container: HTMLDivElement;
let root: Root;

const record: LlmSessionRecord = {
  provider: "claude",
  id: "session-1",
  title: "Transcript test",
  cwd: "C:\\work",
  filePath: "C:\\sessions\\session-1.jsonl",
  updatedAtMs: 1,
  summary: null,
  recap: null,
};

const user = (text: string) =>
  JSON.stringify({ type: "user", message: { content: text } });
const assistant = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function commands(options?: {
  readWindow?: TranscriptCommands["readWindow"];
  search?: TranscriptCommands["search"];
}): TranscriptCommands {
  return {
    readWindow:
      options?.readWindow ??
      vi.fn(async (): Promise<TranscriptWindowResult> => ({
        lines: [],
        nextBeforeOffset: null,
      })),
    search:
      options?.search ??
      vi.fn(async (): Promise<TranscriptSearchResult> => ({
        matches: [],
        truncated: false,
      })),
  };
}

async function renderView(
  fake: TranscriptCommands,
  viewRecord: LlmSessionRecord = record,
): Promise<void> {
  await act(async () => {
    root.render(
      <TranscriptCommandsProvider commands={fake}>
        <TranscriptView record={viewRecord} />
      </TranscriptCommandsProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitForSearch(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 190));
  });
  await settle();
}

function button(label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!found) {
    throw new Error(`Missing button: ${label}`);
  }
  return found;
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelect(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("TranscriptView", () => {
  it("pages backward and reconstructs turns in file order", async () => {
    const readWindow = vi.fn(
      async (_path: string, beforeOffset: number | null): Promise<TranscriptWindowResult> =>
        beforeOffset === null
          ? { lines: [assistant("new answer")], nextBeforeOffset: 100 }
          : { lines: [user("old question")], nextBeforeOffset: null },
    );
    await renderView(commands({ readWindow }));

    expect(container.textContent).toContain("new answer");
    await act(async () => button("Load earlier transcript").click());
    await settle();

    const turns = Array.from(container.querySelectorAll(".transcript-turn")).map(
      (node) => node.textContent,
    );
    expect(turns[0]).toContain("old question");
    expect(turns[1]).toContain("new answer");
    expect(readWindow).toHaveBeenNthCalledWith(1, record.filePath, null, 262_144);
    expect(readWindow).toHaveBeenNthCalledWith(2, record.filePath, 100, 262_144);
  });

  it("discards an earlier-page response after the record changes", async () => {
    let resolveEarlier: ((value: TranscriptWindowResult) => void) | undefined;
    const earlier = new Promise<TranscriptWindowResult>((resolve) => {
      resolveEarlier = resolve;
    });
    const nextRecord: LlmSessionRecord = {
      ...record,
      id: "session-2",
      title: "Next transcript",
      filePath: "C:\\sessions\\session-2.jsonl",
    };
    const readWindow = vi.fn(
      async (path: string, beforeOffset: number | null): Promise<TranscriptWindowResult> => {
        if (path === record.filePath && beforeOffset === null) {
          return { lines: [assistant("old latest")], nextBeforeOffset: 100 };
        }
        if (path === record.filePath) {
          return earlier;
        }
        return { lines: [assistant("new latest")], nextBeforeOffset: null };
      },
    );
    const fake = commands({ readWindow });
    await renderView(fake);

    await act(async () => button("Load earlier transcript").click());
    await act(async () => {
      root.render(
        <TranscriptCommandsProvider commands={fake}>
          <TranscriptView record={nextRecord} />
        </TranscriptCommandsProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      resolveEarlier?.({ lines: [user("stale earlier")], nextBeforeOffset: null });
      await Promise.resolve();
    });

    expect(container.textContent).toContain("new latest");
    expect(container.textContent).not.toContain("stale earlier");
  });

  it("merges a late initial read without discarding a revealed match", async () => {
    let resolveInitial: ((value: TranscriptWindowResult) => void) | undefined;
    const initial = new Promise<TranscriptWindowResult>((resolve) => {
      resolveInitial = resolve;
    });
    const readWindow = vi.fn(
      async (_path: string, beforeOffset: number | null): Promise<TranscriptWindowResult> =>
        beforeOffset === null
          ? initial
          : { lines: [user("revealed target")], nextBeforeOffset: null },
    );
    const search = vi.fn(async () => ({
      matches: [{ offset: 0, snippet: "revealed target" }],
      truncated: false,
    }));
    await renderView(commands({ readWindow, search }));

    await act(async () => button("Search transcript").click());
    const input = container.querySelector<HTMLInputElement>(
      "input[aria-label='Search transcript query']",
    );
    if (!input) throw new Error("search input missing");
    await act(async () => setInput(input, "target"));
    await waitForSearch();
    expect(container.textContent).toContain("revealed target");

    await act(async () => {
      resolveInitial?.({ lines: [assistant("latest turn")], nextBeforeOffset: 500 });
      await Promise.resolve();
    });

    expect(container.textContent).toContain("latest turn");
    expect(container.textContent).toContain("revealed target");
    expect(
      container.querySelector<HTMLElement>(".transcript-line--active-match")?.dataset
        .offset,
    ).toBe("0");
  });

  it("refreshes a transcript when the same file record is updated", async () => {
    const readWindow = vi.fn(async (): Promise<TranscriptWindowResult> => ({
      lines: [assistant(readWindow.mock.calls.length === 1 ? "old turn" : "new turn")],
      nextBeforeOffset: null,
    }));
    const fake = commands({ readWindow });
    await renderView(fake);

    await act(async () => {
      root.render(
        <TranscriptCommandsProvider commands={fake}>
          <TranscriptView record={{ ...record, updatedAtMs: 2 }} />
        </TranscriptCommandsProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readWindow).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("new turn");
    expect(container.textContent).not.toContain("old turn");
  });

  it("offers a retry after the initial transcript read fails", async () => {
    const readWindow = vi
      .fn<TranscriptCommands["readWindow"]>()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({
        lines: [assistant("recovered turn")],
        nextBeforeOffset: null,
      });
    await renderView(commands({ readWindow }));

    expect(container.textContent).toContain("Transcript could not be read.");
    await act(async () => button("Retry transcript").click());
    await settle();

    expect(container.textContent).toContain("recovered turn");
    expect(container.textContent).not.toContain("Transcript could not be read.");
  });

  it("renders assistant markdown only and expands tool stubs in place", async () => {
    const tool = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Write",
            input: { file_path: "ui/src/App.tsx", content: "body" },
          },
        ],
      },
    });
    await renderView(
      commands({
        readWindow: vi.fn(async () => ({
          lines: [user("# user heading"), assistant("# assistant heading"), tool],
          nextBeforeOffset: null,
        })),
      }),
    );

    expect(container.querySelector("h1")?.textContent).toBe("assistant heading");
    expect(container.querySelector(".transcript-turn--user")?.textContent).toContain(
      "# user heading",
    );
    expect(container.querySelector(".transcript-turn--user h1")).toBeNull();

    const stub = button("Expand tool Write");
    expect(stub.textContent).toContain("tool: Write ui/src/App.tsx");
    expect(container.querySelector(".transcript-tool__detail")).toBeNull();
    await act(async () => stub.click());
    expect(container.querySelector(".transcript-tool__detail")?.textContent).toContain(
      '"content": "body"',
    );
    expect(stub.getAttribute("aria-expanded")).toBe("true");

    await act(async () => button("Collapse tool Write").click());
    expect(container.querySelector(".transcript-tool__detail")).toBeNull();
    expect(button("Expand tool Write").getAttribute("aria-expanded")).toBe("false");
  });

  it("reruns server search with the selected mode", async () => {
    const search = vi.fn(async () => ({ matches: [], truncated: false }));
    await renderView(commands({ search }));

    await act(async () => button("Search transcript").click());
    const input = container.querySelector<HTMLInputElement>(
      "input[aria-label='Search transcript query']",
    );
    const mode = container.querySelector<HTMLSelectElement>(
      "select[aria-label='Transcript search mode']",
    );
    if (!input || !mode) throw new Error("search controls missing");

    await act(async () => setInput(input, "needle"));
    await act(async () => setSelect(mode, "fuzzy"));
    await waitForSearch();

    expect(search).toHaveBeenLastCalledWith(
      record.filePath,
      "needle",
      "fuzzy",
      "all",
      200,
    );
  });

  it("debounces rapid query edits into one backend search", async () => {
    vi.useFakeTimers();
    const search = vi.fn(async () => ({ matches: [], truncated: false }));
    await renderView(commands({ search }));

    await act(async () => button("Search transcript").click());
    const input = container.querySelector<HTMLInputElement>(
      "input[aria-label='Search transcript query']",
    );
    if (!input) throw new Error("search input missing");

    await act(async () => {
      setInput(input, "n");
      setInput(input, "ne");
      setInput(input, "needle");
    });
    await settle();
    expect(search).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTime(180));
    await settle();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(
      record.filePath,
      "needle",
      "substring",
      "all",
      200,
    );
  });

  it("loads and highlights the exact line selected by search", async () => {
    const readWindow = vi.fn(
      async (_path: string, beforeOffset: number | null): Promise<TranscriptWindowResult> =>
        beforeOffset === null
          ? { lines: [assistant("latest")], nextBeforeOffset: 500 }
          : { lines: [user("needle target")], nextBeforeOffset: null },
    );
    const search = vi.fn(async () => ({
      matches: [{ offset: 0, snippet: "needle target" }],
      truncated: false,
    }));
    await renderView(commands({ readWindow, search }));

    await act(async () => button("Search transcript").click());
    const input = container.querySelector<HTMLInputElement>(
      "input[aria-label='Search transcript query']",
    );
    if (!input) throw new Error("search input missing");
    await act(async () => setInput(input, "needle"));
    await waitForSearch();

    expect(readWindow).toHaveBeenLastCalledWith(
      record.filePath,
      4_194_303,
      4_194_304,
    );
    const active = container.querySelector<HTMLElement>(
      ".transcript-line--active-match",
    );
    expect(active?.dataset.offset).toBe("0");
    expect(active?.textContent).toContain("needle target");
  });

  it("shows invalid regex inline without invoking the command", async () => {
    const search = vi.fn(async () => ({ matches: [], truncated: false }));
    await renderView(commands({ search }));

    await act(async () => button("Search transcript").click());
    const mode = container.querySelector<HTMLSelectElement>(
      "select[aria-label='Transcript search mode']",
    );
    const input = container.querySelector<HTMLInputElement>(
      "input[aria-label='Search transcript query']",
    );
    if (!input || !mode) throw new Error("search controls missing");
    await act(async () => setSelect(mode, "regex"));
    search.mockClear();
    await act(async () => setInput(input, "[unclosed"));
    await settle();

    expect(container.querySelector("[role='status']")?.textContent).toContain(
      "Invalid pattern",
    );
    expect(search).not.toHaveBeenCalled();
  });

  it("walks user matches backward and resets at the bottom", async () => {
    const lines = [user("first"), assistant("middle"), user("latest")];
    const secondOffset = new TextEncoder().encode(`${lines[0]}\n${lines[1]}\n`).byteLength;
    const search = vi.fn(async () => ({
      matches: [
        { offset: 0, snippet: "first" },
        { offset: secondOffset, snippet: "latest" },
      ],
      truncated: false,
    }));
    await renderView(
      commands({
        readWindow: vi.fn(async () => ({ lines, nextBeforeOffset: null })),
        search,
      }),
    );

    await act(async () => button("Jump to last user message").click());
    await settle();
    expect(
      container.querySelector<HTMLElement>(".transcript-line--active-match")?.dataset
        .offset,
    ).toBe(String(secondOffset));

    await act(async () => button("Jump to previous user message").click());
    await settle();
    expect(
      container.querySelector<HTMLElement>(".transcript-line--active-match")?.dataset
        .offset,
    ).toBe("0");

    const scroll = container.querySelector<HTMLElement>(".transcript__scroll");
    if (!scroll) throw new Error("scroll surface missing");
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, writable: true, value: 700 },
    });
    await act(async () => {
      scroll.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
      scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await act(async () => button("Jump to last user message").click());
    await settle();
    expect(
      container.querySelector<HTMLElement>(".transcript-line--active-match")?.dataset
        .offset,
    ).toBe(String(secondOffset));
    expect(search).toHaveBeenCalledWith(
      record.filePath,
      "\"type\"",
      "substring",
      "user",
      1000,
    );
  });

  it("walks past tool results and hook echoes to the last message a person typed", async () => {
    const spoken = user("the real question");
    const meta = JSON.stringify({
      type: "user",
      isMeta: true,
      message: { content: "hook output" },
    });
    const toolResult = JSON.stringify({
      type: "user",
      message: {
        content: [
          { tool_use_id: "toolu_1", type: "tool_result", content: "ran ok" },
        ],
      },
    });
    const encoder = new TextEncoder();
    const metaOffset = encoder.encode(`${spoken}\n`).byteLength;
    const toolOffset = metaOffset + encoder.encode(`${meta}\n`).byteLength;
    // `filter: "user"` hands back every top-level `"type":"user"` line, which is
    // all three of these; only the first is a person speaking.
    const search = vi.fn(async () => ({
      matches: [
        { offset: 0, snippet: spoken },
        { offset: metaOffset, snippet: meta },
        { offset: toolOffset, snippet: toolResult },
      ],
      truncated: false,
    }));
    await renderView(
      commands({
        readWindow: vi.fn(async () => ({
          lines: [spoken, meta, toolResult],
          nextBeforeOffset: null,
        })),
        search,
      }),
    );
    expect(container.querySelector(".transcript-tool__stub")?.textContent).toContain(
      "tool: result",
    );

    await act(async () => button("Jump to last user message").click());
    await settle();

    expect(
      container.querySelector<HTMLElement>(".transcript-line--active-match")?.dataset
        .offset,
    ).toBe("0");
  });

  it("releases the section farthest from the viewport and reloads it from its cursor", async () => {
    // Unparseable, so it renders nothing at all — it exists only to cost the
    // bytes the ~10 MB guard measures.
    const ballast = `x${"y".repeat(6_000_000)}`;
    const readWindow = vi.fn(
      async (_path: string, beforeOffset: number | null): Promise<TranscriptWindowResult> =>
        beforeOffset === null
          ? { lines: [assistant("newest turn"), ballast], nextBeforeOffset: 6_000_100 }
          : { lines: [user("earliest turn"), ballast], nextBeforeOffset: null },
    );
    await renderView(commands({ readWindow }));
    expect(container.textContent).toContain("newest turn");

    await act(async () => button("Load earlier transcript").click());
    await settle();

    // Two ~6 MB pages exceed the guard, so the earlier one is dropped while the
    // page under the viewport survives.
    expect(container.textContent).not.toContain("earliest turn");
    expect(container.textContent).toContain("newest turn");

    // Its cursor and window size survived the eviction, so the exact same page
    // can be fetched again.
    await act(async () =>
      button("Reload transcript section starting at 0").click(),
    );
    await settle();
    expect(readWindow).toHaveBeenNthCalledWith(3, record.filePath, 6_000_100, 262_144);
  });

  it("handles Ctrl+F and Ctrl+Shift+J only from focused transcript content", async () => {
    const search = vi.fn(async () => ({ matches: [], truncated: false }));
    await renderView(commands({ search }));
    const transcript = container.querySelector<HTMLElement>(".transcript");
    if (!transcript) throw new Error("transcript root missing");

    await act(async () => {
      document.body.focus();
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }),
      );
    });
    expect(container.querySelector(".transcript-search")).toBeNull();

    transcript.focus();
    await act(async () =>
      transcript.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }),
      ),
    );
    expect(container.querySelector(".transcript-search")).not.toBeNull();

    await act(async () =>
      transcript.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "J",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      ),
    );
    await settle();
    expect(search).toHaveBeenCalledWith(
      record.filePath,
      "\"type\"",
      "substring",
      "user",
      1000,
    );
  });
});
