import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutputPane, mergeOutputRows, type OutputPaneProps } from "../OutputPane";
import type { OutputEntry } from "../../conversations/types";

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

function entry(overrides: Partial<OutputEntry> & { path: string }): OutputEntry {
  return { label: null, atMs: NOW, exists: true, ...overrides };
}

async function renderPane(overrides: Partial<OutputPaneProps> = {}) {
  const onOpenFile = vi.fn();
  const onDismiss = vi.fn(async () => true);
  const onClose = vi.fn();
  const props: OutputPaneProps = {
    sessionId: 7,
    sessionKey: "claude:abc",
    live: [],
    onOpenFile,
    onDismiss,
    onClose,
    nowMs: NOW,
    ...overrides,
  };
  await act(async () => {
    root.render(<OutputPane {...props} />);
  });
  return { onOpenFile, onDismiss, onClose };
}

function rows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".output-pane__row")];
}

function paths(): string[] {
  return rows().map((row) => row.dataset.path ?? "");
}

async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

describe("mergeOutputRows", () => {
  it("dedupes by path keeping the newest stamp, newest first, dismissed removed", () => {
    const merged = mergeOutputRows(
      [
        entry({ path: "C:\\out\\a.md", atMs: 100, label: "Report" }),
        entry({ path: "C:\\out\\gone.md", atMs: 400, exists: false }),
      ],
      [
        { path: "C:\\out\\a.md", atMs: 500 },
        { path: "C:\\out\\b.md", atMs: 300 },
      ],
      new Set(["C:\\out\\gone.md"]),
    );

    expect(merged).toEqual([
      { path: "C:\\out\\a.md", atMs: 500, label: "Report", exists: true },
      { path: "C:\\out\\b.md", atMs: 300, label: null, exists: true },
    ]);
  });
});

describe("OutputPane", () => {
  it("merges sidecar history with live registrations, newest first", async () => {
    await renderPane({
      listOutputs: async () => [
        entry({ path: "C:\\out\\old.md", atMs: NOW - 7_200_000 }),
        entry({ path: "C:\\out\\live.md", atMs: NOW - 86_400_000 }),
      ],
      live: [{ path: "C:\\out\\live.md", atMs: NOW - 60_000 }],
    });

    expect(paths()).toEqual(["C:\\out\\live.md", "C:\\out\\old.md"]);
    const first = rows()[0]!;
    expect(first.querySelector(".output-pane__leaf")!.textContent).toBe("live.md");
    expect(first.querySelector(".output-pane__parent")!.textContent).toBe("C:\\out\\");
    // Live stamp wins over the older sidecar record for the same path.
    expect(first.querySelector(".output-pane__time")!.textContent).toBe("1m ago");
    expect(rows()[1]!.querySelector(".output-pane__time")!.textContent).toBe("2h ago");
  });

  it("shows live registrations even without a sidecar lister", async () => {
    await renderPane({
      sessionKey: null,
      live: [{ path: "C:\\out\\fresh.md", atMs: NOW }],
    });

    expect(paths()).toEqual(["C:\\out\\fresh.md"]);
    expect(container.querySelector(".output-pane__context")).toBeNull();
  });

  it("opens a file when its row is clicked", async () => {
    const { onOpenFile } = await renderPane({
      live: [{ path: "C:\\out\\a.md", atMs: NOW }],
    });

    await click(container.querySelector(".output-pane__path")!);

    expect(onOpenFile).toHaveBeenCalledWith("C:\\out\\a.md");
  });

  it("removes a dismissed row immediately and reports the dismissal", async () => {
    const { onDismiss, onOpenFile } = await renderPane({
      listOutputs: async () => [entry({ path: "C:\\out\\keep.md", atMs: NOW - 60_000 })],
      live: [{ path: "C:\\out\\drop.md", atMs: NOW }],
    });
    expect(paths()).toEqual(["C:\\out\\drop.md", "C:\\out\\keep.md"]);

    await click(rows()[0]!.querySelector(".output-pane__dismiss")!);

    expect(paths()).toEqual(["C:\\out\\keep.md"]);
    expect(onDismiss).toHaveBeenCalledWith("claude:abc", "C:\\out\\drop.md");
    // The ✕ must not double as "open this file".
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("shows the termx-output hint when there is nothing to list", async () => {
    await renderPane({ listOutputs: async () => [] });

    expect(rows()).toHaveLength(0);
    expect(container.querySelector(".output-pane__hint")!.textContent).toBe(
      "No outputs yet — sessions register files here via termx-output.",
    );
  });

  it("refetches on a session change and closes on request", async () => {
    const listOutputs = vi.fn(async (key: string) => [
      entry({ path: `C:\\out\\${key}.md`, atMs: NOW }),
    ]);
    const first = await renderPane({ listOutputs });
    expect(paths()).toEqual(["C:\\out\\claude:abc.md"]);

    const second = await renderPane({
      listOutputs,
      sessionKey: "claude:def",
      sessionId: 8,
    });

    expect(paths()).toEqual(["C:\\out\\claude:def.md"]);
    expect(listOutputs).toHaveBeenCalledTimes(2);
    await click(container.querySelector(".output-pane__action--close")!);
    expect(second.onClose).toHaveBeenCalledTimes(1);
    expect(first.onClose).not.toHaveBeenCalled();
  });
});
