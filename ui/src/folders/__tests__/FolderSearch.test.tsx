import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderSearch } from "../FolderSearch";

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

async function renderSearch(overrides: Partial<Parameters<typeof FolderSearch>[0]> = {}) {
  const props = {
    recents: ["C:\\Dev\\TermX", "C:\\Work\\client"],
    listDirs: vi.fn(async () => [] as string[]),
    onPick: vi.fn(),
    onBrowse: vi.fn(),
    onClose: vi.fn(),
    debounceMs: 0,
    ...overrides,
  };
  await act(async () => root.render(<FolderSearch {...props} />));
  // Flush the debounced completion request.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
  return props;
}

describe("FolderSearch", () => {
  it("shows recents immediately and picks with Enter", async () => {
    const props = await renderSearch();
    const rows = container.querySelectorAll("[role='option']");
    // 2 recents + Browse…
    expect(rows).toHaveLength(3);

    const input = container.querySelector("input")!;
    expect(document.activeElement).toBe(input);
    await keydown(input, "Enter");
    expect(props.onPick).toHaveBeenCalledWith("C:\\Dev\\TermX");
  });

  it("filters recents by typed words without calling the path lister", async () => {
    const listDirs = vi.fn(async (_prefix: string) => [] as string[]);
    const props = await renderSearch({ listDirs });
    const input = container.querySelector("input")!;

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "client");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });

    const rows = Array.from(container.querySelectorAll("[role='option']"));
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("client"),
      expect.stringContaining("Browse"),
    ]);
    // Non-path-like queries never consult the backend beyond the initial load.
    expect(
      listDirs.mock.calls.filter(([prefix]) => prefix !== "").length,
    ).toBe(0);

    await keydown(input, "Enter");
    expect(props.onPick).toHaveBeenCalledWith("C:\\Work\\client");
  });

  it("completes path-like queries via listDirs", async () => {
    const listDirs = vi.fn(async (prefix: string) =>
      prefix.startsWith("C:\\D") ? ["C:\\Dev", "C:\\Documents"] : [],
    );
    await renderSearch({ recents: [], listDirs });
    const input = container.querySelector("input")!;

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "C:\\D");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });

    const rows = Array.from(container.querySelectorAll("[role='option']"));
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Dev"),
      expect.stringContaining("Documents"),
      expect.stringContaining("Browse"),
    ]);
  });

  it("arrow keys move the highlight and wrap through Browse…", async () => {
    const props = await renderSearch();
    const input = container.querySelector("input")!;

    await keydown(input, "ArrowDown");
    await keydown(input, "ArrowDown");
    await keydown(input, "Enter");
    expect(props.onBrowse).toHaveBeenCalledTimes(1);

    await keydown(input, "ArrowUp");
    await keydown(input, "Enter");
    expect(props.onPick).toHaveBeenCalledWith("C:\\Work\\client");
  });

  it("Escape closes; clicking a row picks it", async () => {
    const props = await renderSearch();
    await keydown(container.querySelector("input")!, "Escape");
    expect(props.onClose).toHaveBeenCalledTimes(1);

    const second = container.querySelectorAll<HTMLElement>("[role='option']")[1]!;
    await act(async () => {
      second.click();
    });
    expect(props.onPick).toHaveBeenCalledWith("C:\\Work\\client");
  });
});
