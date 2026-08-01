import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DetailPane, type DetailPaneProps } from "../DetailPane";
import type {
  LlmSessionRecord,
  SessionArtifactFile,
  SessionArtifacts,
  SessionNote,
} from "../types";

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
    listArtifacts?: DetailPaneProps["listArtifacts"];
    artifacts?: SessionArtifacts;
  } = {},
) {
  const onResume = vi.fn();
  const onOpenTranscript = vi.fn();
  const onArtifactsFetched = vi.fn();
  const onOpenFile = vi.fn();
  const onOpenFolder = vi.fn();
  await act(async () => {
    root.render(
      <DetailPane
        record={overrides.record ?? record()}
        note={overrides.note ?? { summary: null, recap: null }}
        onResume={onResume}
        onOpenTranscript={onOpenTranscript}
        nowMs={NOW}
        onArtifactsFetched={onArtifactsFetched}
        onOpenFile={onOpenFile}
        onOpenFolder={onOpenFolder}
        {...(overrides.filesSlot ? { filesSlot: overrides.filesSlot } : {})}
        {...(overrides.listArtifacts ? { listArtifacts: overrides.listArtifacts } : {})}
        {...(overrides.artifacts ? { artifacts: overrides.artifacts } : {})}
      />,
    );
  });
  return { onResume, onOpenTranscript, onArtifactsFetched, onOpenFile, onOpenFolder };
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

function filesToggle(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(
    ".conversation-detail__files-toggle",
  );
  if (!found) {
    throw new Error("no files-touched toggle");
  }
  return found;
}

async function toggleFiles(): Promise<void> {
  await click(filesToggle());
}

/** Flush the microtask queue inside `act` so promise continuations settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

describe("DetailPane files-touched artifacts (§11)", () => {
  const UPDATED_AT = NOW - 3_600_000; // matches the record() factory default

  it("falls back to the static hint when no artifacts IO is wired", async () => {
    await renderPane();
    expect(container.querySelector(".conversation-detail__files-toggle")).toBeNull();
    expect(container.querySelector(".conversation-detail__hint")!.textContent).toBe(
      "Not harvested yet.",
    );
  });

  it("never fetches when the record has no transcript file, even with IO wired", async () => {
    const listArtifacts = vi.fn(async () => []);
    await renderPane({
      record: record({ provider: "codex", filePath: "", cwd: null }),
      listArtifacts,
    });
    expect(listArtifacts).not.toHaveBeenCalled();
    expect(container.querySelector(".conversation-detail__files-toggle")).toBeNull();
    expect(container.querySelector(".conversation-detail__hint")!.textContent).toContain(
      "no transcript file",
    );
  });

  it("is collapsed by default and fetches only on first expand", async () => {
    const listArtifacts = vi.fn(async () => []);
    await renderPane({ listArtifacts });
    expect(listArtifacts).not.toHaveBeenCalled();
    expect(filesToggle().getAttribute("aria-expanded")).toBe("false");

    await toggleFiles();
    expect(listArtifacts).toHaveBeenCalledTimes(1);
    expect(listArtifacts).toHaveBeenCalledWith("C:\\a.jsonl");
    expect(filesToggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("shows a loading state while the fetch is in flight", async () => {
    const pending = deferred<SessionArtifactFile[]>();
    const listArtifacts = vi.fn(() => pending.promise);
    await renderPane({ listArtifacts });

    await toggleFiles();
    expect(container.querySelector(".conversation-detail__hint")!.textContent).toBe(
      "Loading…",
    );

    await act(async () => pending.resolve([]));
    expect(container.querySelector(".conversation-detail__hint")!.textContent).toBe(
      "No files recorded",
    );
  });

  it("shows 'No files recorded' when the harvest is empty", async () => {
    const listArtifacts = vi.fn(async () => []);
    await renderPane({ listArtifacts });
    await toggleFiles();
    await flush();
    expect(container.querySelector(".conversation-detail__hint")!.textContent).toBe(
      "No files recorded",
    );
  });

  it("does not refetch on re-expand after a completed fetch", async () => {
    const files: SessionArtifactFile[] = [
      { path: "C:\\proj\\a.ts", kind: "created", exists: true },
    ];
    const listArtifacts = vi.fn(async () => files);
    await renderPane({ listArtifacts });

    await toggleFiles();
    await flush();
    expect(listArtifacts).toHaveBeenCalledTimes(1);

    await toggleFiles(); // collapse
    await toggleFiles(); // expand again
    expect(listArtifacts).toHaveBeenCalledTimes(1);
  });

  it("uses a fresh cached harvest without ever fetching", async () => {
    const cached: SessionArtifacts = {
      sourceMtimeMs: UPDATED_AT,
      files: [{ path: "C:\\proj\\cached.ts", kind: "created", exists: true }],
    };
    const listArtifacts = vi.fn(async () => []);
    await renderPane({ listArtifacts, artifacts: cached });

    await toggleFiles();
    expect(listArtifacts).not.toHaveBeenCalled();
    const row = container.querySelector<HTMLElement>("[data-path]")!;
    expect(row.getAttribute("data-path")).toBe("C:\\proj\\cached.ts");
  });

  it("refetches when the cached harvest is older than the record's last update", async () => {
    const stale: SessionArtifacts = { sourceMtimeMs: UPDATED_AT - 1, files: [] };
    const listArtifacts = vi.fn(async () => []);
    await renderPane({ listArtifacts, artifacts: stale });

    await toggleFiles();
    expect(listArtifacts).toHaveBeenCalledTimes(1);
  });

  it("reports the fresh harvest to onArtifactsFetched keyed by sourceMtimeMs = record.updatedAtMs", async () => {
    const files: SessionArtifactFile[] = [
      { path: "C:\\proj\\a.ts", kind: "created", exists: true },
    ];
    const listArtifacts = vi.fn(async () => files);
    const rec = record();
    const { onArtifactsFetched } = await renderPane({ record: rec, listArtifacts });

    await toggleFiles();
    await flush();
    expect(onArtifactsFetched).toHaveBeenCalledWith("claude:a", {
      sourceMtimeMs: rec.updatedAtMs,
      files,
    });
  });

  it("groups created/edited files and grays out rows whose files no longer exist", async () => {
    const files: SessionArtifactFile[] = [
      { path: "C:\\proj\\new.ts", kind: "created", exists: true },
      { path: "C:\\proj\\gone.ts", kind: "created", exists: false },
      { path: "C:\\proj\\old.ts", kind: "edited", exists: true },
    ];
    const listArtifacts = vi.fn(async () => files);
    await renderPane({ listArtifacts });
    await toggleFiles();
    await flush();

    const groups = [...container.querySelectorAll(".conversation-detail__file-group")];
    expect(groups.map((group) => group.querySelector("h4")!.textContent)).toEqual([
      "Created",
      "Edited",
    ]);
    const createdRows = groups[0]!.querySelectorAll(".conversation-detail__file-row");
    expect(createdRows).toHaveLength(2);
    expect(
      createdRows[0]!.classList.contains("conversation-detail__file-row--missing"),
    ).toBe(false);
    expect(
      createdRows[1]!.classList.contains("conversation-detail__file-row--missing"),
    ).toBe(true);
    const editedRows = groups[1]!.querySelectorAll(".conversation-detail__file-row");
    expect(editedRows).toHaveLength(1);
  });

  it("fires onOpenFile with the exact path on row click", async () => {
    const files: SessionArtifactFile[] = [
      { path: "C:\\proj\\a.ts", kind: "edited", exists: true },
    ];
    const listArtifacts = vi.fn(async () => files);
    const { onOpenFile } = await renderPane({ listArtifacts });
    await toggleFiles();
    await flush();

    const row = container.querySelector<HTMLElement>("[data-path]")!;
    await click(row);
    expect(onOpenFile).toHaveBeenCalledWith("C:\\proj\\a.ts");
  });

  it("right-click opens 'Open folder in new tab', firing onOpenFolder with the parent dir", async () => {
    const files: SessionArtifactFile[] = [
      { path: "C:\\proj\\src\\a.ts", kind: "edited", exists: true },
    ];
    const listArtifacts = vi.fn(async () => files);
    const { onOpenFolder } = await renderPane({ listArtifacts });
    await toggleFiles();
    await flush();

    const row = container.querySelector<HTMLElement>("[data-path]")!;
    await act(async () => {
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 20,
        }),
      );
    });
    await click(button("Open folder in new tab"));
    expect(onOpenFolder).toHaveBeenCalledWith("C:\\proj\\src");
  });
});
