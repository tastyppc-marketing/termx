import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DetailPane, type DetailPaneProps } from "../DetailPane";
import type {
  GeneratedNote,
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

function generatedNote(overrides: Partial<GeneratedNote> = {}): GeneratedNote {
  return {
    title: "Tokenizer rewrite",
    summary: null,
    recap: null,
    generatedAtMs: NOW,
    sourceMtimeMs: NOW,
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
    generated?: GeneratedNote;
    listOutputs?: DetailPaneProps["listOutputs"];
    dismissOutput?: DetailPaneProps["dismissOutput"];
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
        {...(overrides.generated ? { generated: overrides.generated } : {})}
        {...(overrides.listOutputs ? { listOutputs: overrides.listOutputs } : {})}
        {...(overrides.dismissOutput ? { dismissOutput: overrides.dismissOutput } : {})}
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

describe("DetailPane header title (P2)", () => {
  function heading(): HTMLElement {
    return container.querySelector<HTMLElement>(".conversation-detail__title")!;
  }

  it("shows the generated title for a derived record and keeps the raw one as tooltip", async () => {
    await renderPane({
      record: record({ title: "abc-123", titleSource: "derived" }),
      generated: generatedNote(),
    });
    expect(heading().textContent).toBe("Tokenizer rewrite");
    expect(heading().getAttribute("title")).toBe("abc-123");
    expect(heading().dataset.generated).toBe("true");
  });

  it("keeps a named title even when a generated one exists", async () => {
    await renderPane({
      record: record({ title: "Parser work", titleSource: "named" }),
      generated: generatedNote(),
    });
    expect(heading().textContent).toBe("Parser work");
    expect(heading().dataset.generated).toBeUndefined();
  });
});

describe("DetailPane section order (P3)", () => {
  function slots(): (string | undefined)[] {
    return [...container.querySelectorAll<HTMLElement>("[data-slot]")].map(
      (node) => node.dataset.slot,
    );
  }

  it("orders Description, Recap, Outputs, then Files touched", async () => {
    const listOutputs = vi.fn(async () => [
      { path: "C:\\out\\report.xlsx", label: null, atMs: NOW, exists: true },
    ]);
    await renderPane({
      note: { summary: "Short line", recap: "- one\n- two" },
      listOutputs,
    });
    await flush();
    expect(slots()).toEqual(["description", "recap", "outputs", "files-touched"]);
  });

  it("gives description and recap their own headings", async () => {
    await renderPane({ note: { summary: "Short line", recap: "- one" } });
    const description = container.querySelector<HTMLElement>("[data-slot='description']")!;
    const recap = container.querySelector<HTMLElement>("[data-slot='recap']")!;
    expect(description.querySelector("h3")!.textContent).toBe("Description");
    expect(recap.querySelector("h3")!.textContent).toBe("Recap");
    expect(description.querySelector(".conversation-detail__summary")!.textContent).toBe(
      "Short line",
    );
  });

  it("omits a section whose note kind is missing", async () => {
    await renderPane({ note: { summary: null, recap: "- one" } });
    expect(slots()).toEqual(["recap", "files-touched"]);
  });
});

describe("DetailPane outputs (P4)", () => {
  const ENTRY = { path: "C:\\out\\report.xlsx", label: null, atMs: NOW, exists: true };
  const OTHER = { path: "C:\\out\\deck.pptx", label: "Deck", atMs: NOW, exists: false };

  function outputRows(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>(".conversation-detail__output-row")];
  }

  it("hides the section entirely when unwired", async () => {
    await renderPane();
    expect(container.querySelector("[data-slot='outputs']")).toBeNull();
  });

  it("hides the section when the session has no outputs", async () => {
    const listOutputs = vi.fn(async () => []);
    await renderPane({ listOutputs });
    await flush();
    expect(listOutputs).toHaveBeenCalledWith("claude:a");
    expect(container.querySelector("[data-slot='outputs']")).toBeNull();
  });

  it("renders one row per output and opens the file on click", async () => {
    const listOutputs = vi.fn(async () => [ENTRY, OTHER]);
    const { onOpenFile } = await renderPane({ listOutputs });
    await flush();

    expect(outputRows().map((row) => row.dataset.path)).toEqual([
      "C:\\out\\report.xlsx",
      "C:\\out\\deck.pptx",
    ]);
    expect(outputRows()[1]!.className).toContain("conversation-detail__file-row--missing");
    expect(outputRows()[0]!.textContent).toContain("report.xlsx");

    await click(
      outputRows()[0]!.querySelector(".conversation-detail__output-open")!,
    );
    expect(onOpenFile).toHaveBeenCalledWith("C:\\out\\report.xlsx");
  });

  it("dismisses an entry and refreshes the list from the injected call", async () => {
    let entries = [ENTRY, OTHER];
    const listOutputs = vi.fn(async () => entries);
    const dismissOutput = vi.fn(async (_key: string, path: string) => {
      entries = entries.filter((entry) => entry.path !== path);
      return true;
    });
    const { onOpenFile } = await renderPane({ listOutputs, dismissOutput });
    await flush();
    expect(outputRows()).toHaveLength(2);

    await click(
      outputRows()[0]!.querySelector(".conversation-detail__output-dismiss")!,
    );
    await flush();

    expect(dismissOutput).toHaveBeenCalledWith("claude:a", "C:\\out\\report.xlsx");
    expect(listOutputs).toHaveBeenCalledTimes(2);
    expect(outputRows().map((row) => row.dataset.path)).toEqual(["C:\\out\\deck.pptx"]);
    // Dismissing must not double as "open this file".
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("offers no dismiss affordance when no dismiss call is wired", async () => {
    const listOutputs = vi.fn(async () => [ENTRY]);
    await renderPane({ listOutputs });
    await flush();
    expect(outputRows()).toHaveLength(1);
    expect(container.querySelector(".conversation-detail__output-dismiss")).toBeNull();
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

  it("refetches on re-expand when the record updated after the completed fetch", async () => {
    const listArtifacts = vi.fn(async () => []);
    const before = record();
    const after = record({ updatedAtMs: before.updatedAtMs + 1 });
    const renderWith = async (rec: LlmSessionRecord) => {
      await act(async () => {
        root.render(
          <DetailPane
            record={rec}
            note={{ summary: null, recap: null }}
            onResume={vi.fn()}
            onOpenTranscript={vi.fn()}
            nowMs={NOW}
            listArtifacts={listArtifacts}
          />,
        );
      });
    };
    await renderWith(before);
    await toggleFiles();
    await flush();
    expect(listArtifacts).toHaveBeenCalledTimes(1);

    // Same sessionKey, newer transcript: no remount, but the next expand
    // must notice the record moved past the fetch and refetch.
    await renderWith(after);
    await toggleFiles(); // collapse
    await toggleFiles(); // expand again
    expect(listArtifacts).toHaveBeenCalledTimes(2);
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
