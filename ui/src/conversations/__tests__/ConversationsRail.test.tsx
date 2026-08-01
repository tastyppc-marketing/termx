import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type TermxSettings } from "../../settings/settings";
import { ConversationsRail } from "../ConversationsRail";
import { ConversationsStore } from "../store";
import type { LlmSessionRecord, SessionLister } from "../types";

const NOW = 1_000_000_000;

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
  record({ id: "a", title: "Parser work", summary: "Fixed the tokenizer" }),
  record({
    id: "b",
    provider: "codex",
    title: "Deploy script",
    cwd: "C:\\Work\\ops",
    filePath: "C:\\b.jsonl",
    updatedAtMs: NOW - 7_200_000,
    summary: "Wrote the deploy script",
    recap: "Long recap text",
  }),
];

async function renderRail(
  options: {
    rows?: LlmSessionRecord[];
    settings?: Partial<TermxSettings>;
    list?: SessionLister;
  } = {},
) {
  const rows = options.rows ?? DEFAULT_ROWS;
  const list = options.list ?? vi.fn<SessionLister>(async () => rows);
  let sequence = 0;
  const store = new ConversationsStore({
    list,
    debounceMs: 0,
    now: () => NOW,
    generateId: () => `f${++sequence}`,
  });
  const onResume = vi.fn();
  const onOpenTranscript = vi.fn();
  const settings: TermxSettings = { ...DEFAULT_SETTINGS, ...options.settings };
  await act(async () => {
    root.render(
      <ConversationsRail
        store={store}
        settings={settings}
        onResume={onResume}
        onOpenTranscript={onOpenTranscript}
        debounceMs={0}
        nowMs={NOW}
      />,
    );
  });
  await act(async () => {});
  return { store, list, onResume, onOpenTranscript };
}

function rows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".conversation-row")];
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label,
  );
  if (!found) {
    throw new Error(`no button ${label}`);
  }
  return found;
}

async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function contextMenu(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      }),
    );
  });
}

describe("ConversationsRail", () => {
  it("scans once on mount and renders rows newest first", async () => {
    const { list } = await renderRail();
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(false);
    expect(rows().map((row) => row.dataset.sessionKey)).toEqual([
      "claude:a",
      "codex:b",
    ]);
    expect(rows()[0]!.textContent).toContain("Parser work");
    expect(rows()[0]!.textContent).toContain("1m ago");
    expect(rows()[1]!.textContent).toContain("2h ago");
  });

  it("filters by provider chip", async () => {
    await renderRail();
    await click(button("Codex"));
    expect(rows().map((row) => row.dataset.sessionKey)).toEqual(["codex:b"]);
    await click(button("All"));
    expect(rows()).toHaveLength(2);
  });

  it("searches over title, cwd, and note text", async () => {
    await renderRail();
    const search = container.querySelector<HTMLInputElement>(".conversations__search")!;

    const type = async (value: string) => {
      await act(async () => {
        // React tracks the DOM value on the instance; go through the prototype
        // setter so the synthetic change event actually fires.
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!;
        setter.call(search, value);
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    await type("ops");
    expect(rows().map((row) => row.dataset.sessionKey)).toEqual(["codex:b"]);
    await type("TOKENIZER");
    expect(rows().map((row) => row.dataset.sessionKey)).toEqual(["claude:a"]);
    await type("nothing matches");
    expect(rows()).toHaveLength(0);
  });

  it("shows notes as tooltips in hover mode", async () => {
    await renderRail({ settings: { summaryDisplay: "hover", summaryContent: "both" } });
    expect(rows()[1]!.getAttribute("title")).toBe(
      "Wrote the deploy script\nLong recap text",
    );
    expect(container.querySelector(".conversation-row__summary")).toBeNull();
    expect(container.querySelector(".conversation-row__recap")).toBeNull();
  });

  it("shows secondary lines in under-title mode, per summaryContent", async () => {
    await renderRail({
      settings: { summaryDisplay: "under-title", summaryContent: "both" },
    });
    expect(
      [...container.querySelectorAll(".conversation-row__summary")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["Fixed the tokenizer", "Wrote the deploy script"]);
    expect(
      [...container.querySelectorAll(".conversation-row__recap")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["Long recap text"]);
    expect(rows()[1]!.hasAttribute("title")).toBe(false);
  });

  it("hides note text entirely when summaryContent is none", async () => {
    await renderRail({
      settings: { summaryDisplay: "under-title", summaryContent: "none" },
    });
    expect(container.querySelector(".conversation-row__summary")).toBeNull();
    expect(container.querySelector(".conversation-row__recap")).toBeNull();
    expect(rows()[0]!.hasAttribute("title")).toBe(false);
    expect(rows()[0]!.textContent).toContain("Parser work");
  });

  it("shows only the recap when summaryContent is recap", async () => {
    await renderRail({
      settings: { summaryDisplay: "under-title", summaryContent: "recap" },
    });
    expect(container.querySelector(".conversation-row__summary")).toBeNull();
    expect(container.querySelector(".conversation-row__recap")!.textContent).toBe(
      "Long recap text",
    );
  });

  it("selects a row, resumes from its button, and resumes on double click", async () => {
    const { onResume, store } = await renderRail();
    await click(rows()[0]!);
    expect(store.getSnapshot().selectedKey).toBe("claude:a");

    await click(button("Resume Parser work"));
    expect(onResume).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", provider: "claude" }),
    );

    await act(async () => {
      rows()[1]!.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
      );
    });
    expect(onResume).toHaveBeenLastCalledWith(expect.objectContaining({ id: "b" }));
  });

  it("counts sessions in the footer and force-refreshes from the button", async () => {
    const { list } = await renderRail();
    const footer = container.querySelector(".conversations__count")!;
    expect(footer.textContent).toBe("2 sessions · refreshed just now");

    await click(button("Refresh sessions"));
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith(true);
  });

  it("creates a folder and moves a session into it from the row menu", async () => {
    const { store } = await renderRail();
    await click(button("New folder"));
    const input = container.querySelector<HTMLInputElement>(".inline-rename")!;
    await act(async () => {
      input.value = "Work";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(store.getSnapshot().data.folders).toEqual([{ id: "f1", name: "Work" }]);

    await contextMenu(rows()[0]!);
    await click(button("Move to folder"));
    await click(button("Work"));
    expect(store.getSnapshot().data.assignments).toEqual({ "claude:a": "f1" });

    // The row now renders under the folder section, above Unfiled.
    const sections = [...container.querySelectorAll<HTMLElement>(".conversations__folder")];
    expect(sections[0]!.dataset.folderId).toBe("f1");
    expect(sections[0]!.textContent).toContain("Parser work");

    await contextMenu(rows()[0]!);
    await click(button("Remove from folder"));
    expect(store.getSnapshot().data.assignments).toEqual({});
  });

  it("keeps a codex row with no transcript resumable but blocks transcript actions", async () => {
    const { onResume, onOpenTranscript } = await renderRail({
      rows: [
        record({
          id: "ghost",
          provider: "codex",
          title: "Indexed only",
          filePath: "",
          summary: "should never show",
        }),
      ],
      settings: { summaryDisplay: "under-title", summaryContent: "both" },
    });

    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain("Indexed only");
    // Note affordances are off: no secondary line and no tooltip.
    expect(container.querySelector(".conversation-row__summary")).toBeNull();
    expect(rows()[0]!.hasAttribute("title")).toBe(false);

    await click(rows()[0]!);
    expect(button("Open transcript").disabled).toBe(true);
    await click(button("Open transcript"));
    expect(onOpenTranscript).not.toHaveBeenCalled();

    await click(button("Resume Indexed only"));
    expect(onResume).toHaveBeenCalledWith(expect.objectContaining({ id: "ghost" }));
  });

  it("opens the detail pane for the selection and fires Open transcript", async () => {
    const { onOpenTranscript } = await renderRail();
    expect(container.querySelector(".conversation-detail")).toBeNull();

    await click(rows()[1]!);
    const detail = container.querySelector(".conversation-detail")!;
    expect(detail.textContent).toContain("Deploy script");
    expect(detail.textContent).toContain("C:\\Work\\ops");

    await click(button("Open transcript"));
    expect(onOpenTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ id: "b", filePath: "C:\\b.jsonl" }),
    );
  });
});
