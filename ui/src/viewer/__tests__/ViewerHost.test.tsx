import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ViewerHost,
  type FileReadResult,
  type LlmSessionRecord,
  type TranscriptLoader,
  type ViewerApi,
} from "../ViewerHost";
import {
  DEFAULT_VIEWER_GEOMETRY,
  type ViewerGeometry,
} from "../viewerState";

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
  vi.restoreAllMocks();
});

interface HostHarness {
  api: React.RefObject<ViewerApi | null>;
  geometryChanges: ViewerGeometry[];
}

async function renderHost(options: {
  result: FileReadResult | null;
  initialGeometry?: ViewerGeometry;
  registerTranscript?: TranscriptLoader;
  readFile?: (path: string) => Promise<FileReadResult | null>;
}): Promise<HostHarness> {
  const api = createRef<ViewerApi>();
  const geometryChanges: ViewerGeometry[] = [];
  const readFile = options.readFile ?? vi.fn(async () => options.result);

  function Harness() {
    const [geometry, setGeometry] = useState(
      options.initialGeometry ?? DEFAULT_VIEWER_GEOMETRY,
    );
    return (
      <ViewerHost
        ref={api}
        readFile={readFile}
        geometry={geometry}
        onGeometry={(next) => {
          geometryChanges.push(next);
          setGeometry(next);
        }}
        {...(options.registerTranscript
          ? { registerTranscript: options.registerTranscript }
          : {})}
      />
    );
  }

  await act(async () => root.render(<Harness />));
  return { api, geometryChanges };
}

async function openFile(api: React.RefObject<ViewerApi | null>, path: string) {
  await act(async () => {
    api.current?.openFile(path);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ViewerHost file rendering", () => {
  it("opens markdown and shows the exact 2 MB truncation banner", async () => {
    const harness = await renderHost({
      result: { content: "# Release notes", truncated: true },
    });

    await openFile(harness.api, "C:\\work\\notes.md");

    expect(container.querySelector("h1")?.textContent).toBe("Release notes");
    expect(container.querySelector(".viewer__banner")?.textContent).toBe(
      "File truncated at 2 MB",
    );
    expect(harness.geometryChanges[0]).toEqual({
      dock: "right",
      sizePx: 380,
      state: "docked",
    });
  });

  it("renders non-markdown text in a monospace preformatted block", async () => {
    const harness = await renderHost({
      result: { content: "const value = 1;\n", truncated: false },
    });

    await openFile(harness.api, "C:\\work\\script.ts");

    expect(container.querySelector("pre.viewer__plain-text")?.textContent).toBe(
      "const value = 1;\n",
    );
    expect(container.querySelector("article.viewer-markdown")).toBeNull();
  });

  it("shows an inline notice when the file is missing, binary, or unreadable", async () => {
    const harness = await renderHost({ result: null });

    await openFile(harness.api, "C:\\work\\image.bin");

    expect(container.querySelector(".viewer__notice")?.textContent).toBe(
      "This file is missing, binary, or unreadable.",
    );
  });

  it("ignores a slow read for a file the viewer already moved on from", async () => {
    const pending = new Map<string, (result: FileReadResult) => void>();
    const harness = await renderHost({
      result: null,
      readFile: (path) =>
        new Promise<FileReadResult | null>((resolve) => {
          pending.set(path, resolve);
        }),
    });

    await act(async () => harness.api.current?.openFile("C:\\work\\slow.md"));
    await act(async () => harness.api.current?.openFile("C:\\work\\fast.md"));
    await act(async () => {
      pending.get("C:\\work\\fast.md")?.({
        content: "# Fast",
        truncated: false,
      });
      await Promise.resolve();
      pending.get("C:\\work\\slow.md")?.({
        content: "# Slow",
        truncated: false,
      });
      await Promise.resolve();
    });

    expect(container.querySelector("h1")?.textContent).toBe("Fast");
    expect(container.querySelector(".viewer__filename")?.textContent).toBe(
      "fast.md",
    );
  });
});

async function pressToggleShortcut(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "M",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  if (!found) {
    throw new Error(`Missing button: ${label}`);
  }
  return found;
}

describe("ViewerHost geometry controls", () => {
  it("installs Ctrl+Shift+M only while the readable viewer is visible", async () => {
    const harness = await renderHost({
      result: { content: "notes", truncated: false },
    });

    await pressToggleShortcut();
    expect(harness.geometryChanges).toHaveLength(0);

    await openFile(harness.api, "C:\\work\\notes.txt");
    await pressToggleShortcut();
    expect(harness.geometryChanges.at(-1)?.state).toBe("overlay");
    expect(container.querySelector(".viewer--overlay")).not.toBeNull();

    await pressToggleShortcut();
    expect(harness.geometryChanges.at(-1)?.state).toBe("docked");

    await act(async () => button("Close viewer").click());
    const countAfterClose = harness.geometryChanges.length;
    await pressToggleShortcut();
    expect(harness.geometryChanges).toHaveLength(countAfterClose);
  });

  it("fires geometry changes when docking and drag-resizing", async () => {
    const harness = await renderHost({
      result: { content: "notes", truncated: false },
    });
    await openFile(harness.api, "C:\\work\\notes.txt");

    await act(async () => button("Dock viewer to bottom").click());
    expect(harness.geometryChanges.at(-1)).toEqual({
      dock: "bottom",
      sizePx: 380,
      state: "docked",
    });

    const handle = container.querySelector<HTMLElement>("[role='separator']");
    expect(handle?.getAttribute("aria-orientation")).toBe("horizontal");
    await act(async () => {
      handle?.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, clientY: 500 }),
      );
      window.dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true, clientY: 440 }),
      );
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    expect(harness.geometryChanges.at(-1)).toEqual({
      dock: "bottom",
      sizePx: 440,
      state: "docked",
    });
  });

  it("resizes from the keyboard along the docked axis", async () => {
    const harness = await renderHost({
      result: { content: "notes", truncated: false },
    });
    await openFile(harness.api, "C:\\work\\notes.txt");

    const handle = container.querySelector<HTMLElement>("[role='separator']");
    expect(handle?.getAttribute("aria-valuenow")).toBe("380");
    await act(async () => {
      handle?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
    });
    expect(harness.geometryChanges.at(-1)?.sizePx).toBe(396);

    await act(async () => {
      container
        .querySelector<HTMLElement>("[role='separator']")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        );
    });
    expect(harness.geometryChanges.at(-1)?.sizePx).toBe(380);
  });

  it("reserves a docked width instead of covering the terminal", async () => {
    const harness = await renderHost({
      result: { content: "notes", truncated: false },
    });
    await openFile(harness.api, "C:\\work\\notes.txt");

    const docked = container.querySelector<HTMLElement>(".viewer--docked");
    expect(docked?.style.width).toBe("380px");
    expect(docked?.style.position).toBe("");

    await act(async () => button("Dock viewer to bottom").click());
    const bottom = container.querySelector<HTMLElement>(".viewer--dock-bottom");
    expect(bottom?.style.height).toBe("380px");
    expect(bottom?.style.width).toBe("");
  });

  it("minimizes to a filename pill, restores, and closes", async () => {
    const harness = await renderHost({
      result: { content: "notes", truncated: false },
    });
    await openFile(harness.api, "C:\\work\\notes.txt");

    await act(async () => button("Minimize viewer").click());
    const pill = button("Restore notes.txt");
    expect(pill.textContent).toBe("notes.txt");
    expect(harness.geometryChanges.at(-1)?.state).toBe("tray");

    await act(async () => pill.click());
    expect(harness.geometryChanges.at(-1)?.state).toBe("docked");
    expect(container.querySelector(".viewer--docked")).not.toBeNull();

    await act(async () => button("Close viewer").click());
    expect(harness.geometryChanges.at(-1)?.state).toBe("hidden");
    expect(container.querySelector(".viewer")).toBeNull();
  });
});

const transcriptRecord: LlmSessionRecord = {
  provider: "claude",
  id: "session-1",
  title: "Viewer design",
  cwd: "C:\\work",
  filePath: "C:\\sessions\\session-1.jsonl",
  updatedAtMs: 42,
  summary: null,
  recap: null,
};

describe("ViewerHost transcript mount seam", () => {
  it("shows the replacement stub when no transcript module is registered", async () => {
    const harness = await renderHost({ result: null });

    await act(async () => harness.api.current?.openTranscript(transcriptRecord));

    expect(container.querySelector(".viewer__transcript-fallback")?.textContent).toBe(
      "Transcript mode goes here",
    );
    expect(harness.geometryChanges.at(-1)?.state).toBe("docked");
  });

  it("lazily mounts the registered TranscriptView with the complete record", async () => {
    const registerTranscript: TranscriptLoader = async () => ({
      TranscriptView: ({ record }) => (
        <section data-testid="transcript-view">
          {record.provider}:{record.title}
        </section>
      ),
    });
    const harness = await renderHost({ result: null, registerTranscript });

    await act(async () => {
      harness.api.current?.openTranscript(transcriptRecord);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("[data-testid='transcript-view']")?.textContent).toBe(
      "claude:Viewer design",
    );
  });

  it("titles the frame with the session and swaps back to a file cleanly", async () => {
    const harness = await renderHost({
      result: { content: "# Notes", truncated: false },
    });

    await act(async () => harness.api.current?.openTranscript(transcriptRecord));
    expect(container.querySelector(".viewer__filename")?.textContent).toBe(
      "Viewer design",
    );

    await openFile(harness.api, "C:\\work\\notes.md");
    expect(container.querySelector(".viewer__transcript-fallback")).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Notes");
  });

  it("falls back gracefully when the registered transcript module is absent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registerTranscript: TranscriptLoader = async () => {
      throw new Error("module absent");
    };
    const harness = await renderHost({ result: null, registerTranscript });

    await act(async () => {
      harness.api.current?.openTranscript(transcriptRecord);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector(".viewer__transcript-fallback")?.textContent).toBe(
      "Transcript mode goes here",
    );
  });
});
