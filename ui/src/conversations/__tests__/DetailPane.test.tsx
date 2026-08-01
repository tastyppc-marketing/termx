import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DetailPane } from "../DetailPane";
import type { LlmSessionRecord, SessionNote } from "../types";

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
    title: "Parser work",
    cwd: "C:\\Dev\\TermX",
    filePath: "C:\\a.jsonl",
    updatedAtMs: NOW - 3_600_000,
    summary: null,
    recap: null,
    ...overrides,
  };
}

async function renderPane(
  overrides: {
    record?: LlmSessionRecord;
    note?: SessionNote;
    filesSlot?: React.ReactNode;
  } = {},
) {
  const onResume = vi.fn();
  const onOpenTranscript = vi.fn();
  await act(async () => {
    root.render(
      <DetailPane
        record={overrides.record ?? record()}
        note={overrides.note ?? { summary: null, recap: null }}
        onResume={onResume}
        onOpenTranscript={onOpenTranscript}
        nowMs={NOW}
        {...(overrides.filesSlot ? { filesSlot: overrides.filesSlot } : {})}
      />,
    );
  });
  return { onResume, onOpenTranscript };
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
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

describe("DetailPane", () => {
  it("renders title, provider, full cwd, and last-active time", async () => {
    await renderPane();
    const pane = container.querySelector(".conversation-detail")!;
    expect(pane.textContent).toContain("Parser work");
    expect(pane.textContent).toContain("claude");
    expect(pane.querySelector(".conversation-detail__cwd")!.textContent).toBe(
      "C:\\Dev\\TermX",
    );
    expect(pane.textContent).toContain("1h ago");
  });

  it("shows both note kinds regardless of the row display setting", async () => {
    await renderPane({ note: { summary: "Short line", recap: "Longer recap" } });
    expect(container.querySelector(".conversation-detail__summary")!.textContent).toBe(
      "Short line",
    );
    expect(container.querySelector(".conversation-detail__recap")!.textContent).toBe(
      "Longer recap",
    );
  });

  it("fires Resume and Open transcript with the record", async () => {
    const { onResume, onOpenTranscript } = await renderPane();
    await click(button("Resume"));
    await click(button("Open transcript"));
    expect(onResume).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    expect(onOpenTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "C:\\a.jsonl" }),
    );
  });

  it("disables Open transcript when the session has no transcript file", async () => {
    const { onOpenTranscript } = await renderPane({
      record: record({ provider: "codex", filePath: "", cwd: null }),
    });
    expect(button("Open transcript").disabled).toBe(true);
    await click(button("Open transcript"));
    expect(onOpenTranscript).not.toHaveBeenCalled();
    expect(container.querySelector(".conversation-detail__cwd")!.textContent).toBe(
      "Unknown",
    );
    expect(container.querySelector(".conversation-detail__hint")!.textContent).toContain(
      "no transcript file",
    );
    expect(button("Resume").disabled).toBe(false);
  });

  it("renders the files slot for the artifacts pass when provided", async () => {
    await renderPane({ filesSlot: <p className="files-probe">two files</p> });
    const files = container.querySelector("[data-slot='files-touched']")!;
    expect(files.querySelector(".files-probe")!.textContent).toBe("two files");
    expect(container.querySelector(".conversation-detail__hint")).toBeNull();
  });
});
