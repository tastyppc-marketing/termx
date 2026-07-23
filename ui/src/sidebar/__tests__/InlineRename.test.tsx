import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineRename } from "../InlineRename";

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

function dispatchKey(input: HTMLInputElement, key: string): void {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("InlineRename", () => {
  it("focuses with the existing value selected and enforces the layout name cap", async () => {
    await act(async () => root.render(
      <InlineRename value="Existing title" ariaLabel="Rename tab" onCommit={vi.fn()} onCancel={vi.fn()} />,
    ));

    const input = container.querySelector("input")!;
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Existing title".length);
    expect(input.maxLength).toBe(64);
    expect(input.getAttribute("aria-label")).toBe("Rename tab");
  });

  it("commits a trimmed valid value exactly once across Enter and blur", async () => {
    const onCommit = vi.fn();
    await act(async () => root.render(
      <InlineRename value="Old" ariaLabel="Rename tab" onCommit={onCommit} onCancel={vi.fn()} />,
    ));
    const input = container.querySelector("input")!;

    await act(async () => {
      input.value = "  New name  ";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      dispatchKey(input, "Enter");
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("New name");
  });

  it("commits a valid value on blur", async () => {
    const onCommit = vi.fn();
    await act(async () => root.render(
      <InlineRename value="Old" ariaLabel="Rename tab" onCommit={onCommit} onCancel={vi.fn()} />,
    ));
    const input = container.querySelector("input")!;

    await act(async () => {
      input.value = "  Blur name ";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(onCommit).toHaveBeenCalledWith("Blur name");
  });

  it("cancels Escape without allowing the following blur to commit", async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    await act(async () => root.render(
      <InlineRename value="Old" ariaLabel="Rename tab" onCommit={onCommit} onCancel={onCancel} />,
    ));
    const input = container.querySelector("input")!;

    await act(async () => {
      input.value = "Changed";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      dispatchKey(input, "Escape");
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("reverts empty and whitespace-only edits", async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    await act(async () => root.render(
      <InlineRename value="Old" ariaLabel="Rename tab" onCommit={onCommit} onCancel={onCancel} />,
    ));
    const input = container.querySelector("input")!;

    await act(async () => {
      input.value = "   ";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      dispatchKey(input, "Enter");
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
