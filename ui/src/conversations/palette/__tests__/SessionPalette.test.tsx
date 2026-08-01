import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationsStore } from "../../store";
import type { LlmSessionRecord, SessionLister } from "../../types";
import { SessionPalette } from "../SessionPalette";

const NOW = 1_000_000_000;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function keydown(target: Element, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

function record(overrides: Partial<LlmSessionRecord> = {}): LlmSessionRecord {
  return {
    provider: "claude",
    id: "a",
    title: "Session A",
    cwd: "C:\\Dev\\TermX",
    filePath: "C:\\a.jsonl",
    updatedAtMs: NOW - 60_000,
    summary: null,
    recap: null,
    ...overrides,
  };
}

const DEFAULT_ROWS: LlmSessionRecord[] = [
  record({ id: "a", title: "Parser work", updatedAtMs: NOW - 60_000 }),
  record({
    id: "b",
    provider: "codex",
    title: "Deploy script",
    cwd: "C:\\Work\\ops",
    filePath: "C:\\b.jsonl",
    updatedAtMs: NOW - 7_200_000,
    summary: "Wrote the deploy script",
  }),
];

async function renderPalette(
  overrides: {
    rows?: LlmSessionRecord[];
    open?: boolean;
  } = {},
) {
  const rows = overrides.rows ?? DEFAULT_ROWS;
  const list = vi.fn<SessionLister>(async () => rows);
  const store = new ConversationsStore({ list, now: () => NOW });
  await act(async () => {
    await store.refresh(false);
  });
  const onClose = vi.fn<() => void>();
  const onResume = vi.fn<(record: LlmSessionRecord) => void>();
  await act(async () => {
    root.render(
      <SessionPalette
        store={store}
        open={overrides.open ?? true}
        onClose={onClose}
        onResume={onResume}
        nowMs={NOW}
      />,
    );
  });
  return { store, list, onClose, onResume };
}

function rows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[role='option']")];
}

describe("SessionPalette", () => {
  it("renders nothing when closed", async () => {
    await renderPalette({ open: false });
    expect(container.querySelector(".session-palette")).toBeNull();
  });

  it("shows the most recent sessions on an empty query, focused and ready", async () => {
    await renderPalette();
    const input = container.querySelector("input")!;
    expect(document.activeElement).toBe(input);
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Parser work"),
      expect.stringContaining("Deploy script"),
    ]);
  });

  it("caps the list at 12 rows even with more matching sessions", async () => {
    const many = Array.from({ length: 15 }, (_, index) =>
      record({
        id: `s${index}`,
        title: `Session ${index}`,
        updatedAtMs: NOW - index * 60_000, // descending: s0 is newest
      }),
    );
    await renderPalette({ rows: many });
    expect(rows()).toHaveLength(12);
    expect(rows()[0]!.textContent).toContain("Session 0");
    expect(rows()[11]!.textContent).toContain("Session 11");
  });

  it("fuzzy-filters over title, cwd, and summary", async () => {
    const props = await renderPalette();
    const input = container.querySelector("input")!;
    const type = async (value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    await type("ops"); // matches cwd C:\Work\ops
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Deploy script"),
    ]);

    await type("DEPLOY SCRIPT"); // matches summary text, case-insensitive
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Deploy script"),
    ]);

    await type("parser"); // matches title
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Parser work"),
    ]);

    await type("nothing matches this query");
    expect(rows()).toHaveLength(0);
    expect(container.querySelector(".session-palette__empty")).not.toBeNull();

    void props;
  });

  it("arrow keys move the highlight and wrap in both directions", async () => {
    const { onResume } = await renderPalette();
    const input = container.querySelector("input")!;

    await keydown(input, "ArrowUp"); // wraps from row 0 up to the last row
    await keydown(input, "Enter");
    expect(onResume).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));

    onResume.mockClear();
    await keydown(input, "ArrowDown"); // wraps from the last row back to row 0
    await keydown(input, "Enter");
    expect(onResume).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("Enter fires onResume with the exact highlighted record", async () => {
    const { onResume } = await renderPalette();
    const input = container.querySelector("input")!;

    await keydown(input, "ArrowDown");
    await keydown(input, "Enter");
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledWith(
      expect.objectContaining({ id: "b", provider: "codex", title: "Deploy script" }),
    );
  });

  it("Escape closes; clicking a row resumes it", async () => {
    const { onClose, onResume } = await renderPalette();
    await keydown(container.querySelector("input")!, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);

    const second = rows()[1]!;
    await act(async () => {
      second.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onResume).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
  });

  it("renders a provider badge per row", async () => {
    await renderPalette();
    const badges = [...container.querySelectorAll(".session-palette__badge")];
    expect(badges.map((badge) => badge.textContent)).toEqual(["C", "X"]);
    expect(badges[0]!.getAttribute("aria-label")).toBe("claude session");
    expect(badges[1]!.getAttribute("aria-label")).toBe("codex session");
  });

  it("resets the query and highlight each time it re-opens", async () => {
    const { store, onResume } = await renderPalette();
    const input = container.querySelector("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "parser");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rows()).toHaveLength(1);

    await act(async () => {
      root.render(
        <SessionPalette
          store={store}
          open={false}
          onClose={vi.fn()}
          onResume={onResume}
          nowMs={NOW}
        />,
      );
    });
    expect(container.querySelector(".session-palette")).toBeNull();

    await act(async () => {
      root.render(
        <SessionPalette
          store={store}
          open={true}
          onClose={vi.fn()}
          onResume={onResume}
          nowMs={NOW}
        />,
      );
    });
    expect(container.querySelector("input")!.value).toBe("");
    expect(rows()).toHaveLength(2);
  });

  it("re-renders live when the store's scan finishes after the palette is open", async () => {
    let resolveList: (rows: LlmSessionRecord[]) => void = () => {};
    const list = vi.fn<SessionLister>(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    );
    const store = new ConversationsStore({ list, now: () => NOW });
    const scanPromise = store.refresh(false);
    const onResume = vi.fn();
    await act(async () => {
      root.render(
        <SessionPalette
          store={store}
          open={true}
          onClose={vi.fn()}
          onResume={onResume}
          nowMs={NOW}
        />,
      );
    });
    expect(rows()).toHaveLength(0);

    await act(async () => {
      resolveList(DEFAULT_ROWS);
      await scanPromise;
    });
    expect(rows()).toHaveLength(2);
  });
});
