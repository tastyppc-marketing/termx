import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloseGuard } from "../CloseGuard";

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

async function render(ui: React.ReactElement): Promise<void> {
  await act(async () => root.render(ui));
}

function findButton(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === text,
  );
  if (!button) {
    throw new Error(`button "${text}" not found`);
  }
  return button;
}

describe("CloseGuard", () => {
  it("renders nothing when closed", async () => {
    await render(<CloseGuard open={false} onDecide={() => undefined} />);
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });

  it("renders the spec-required heading and body copy", async () => {
    await render(<CloseGuard open onDecide={() => undefined} />);

    const dialog = container.querySelector<HTMLElement>("[role='dialog']")!;
    expect(dialog).not.toBeNull();

    const heading = container.querySelector("h2");
    expect(heading?.textContent).toBe(
      "Your terminals keep running in the background",
    );

    const body = container.querySelector(".close-guard__body")?.textContent ?? "";
    expect(body).toContain("keeps running in the background daemon");
    expect(body).toContain("Reopening TermX restores them");

    expect(findButton("Keep running")).toBeTruthy();
    expect(findButton("Stop everything")).toBeTruthy();

    const remember = container.querySelector<HTMLInputElement>(
      "input[type='checkbox']",
    );
    expect(remember).not.toBeNull();
    expect(remember?.checked).toBe(false);
  });

  it("fires (\"keep-running\", false) from Keep running with the checkbox off", async () => {
    const onDecide = vi.fn();
    await render(<CloseGuard open onDecide={onDecide} />);

    await act(async () => {
      findButton("Keep running").click();
    });
    expect(onDecide).toHaveBeenCalledExactlyOnceWith("keep-running", false);
  });

  it("fires (\"keep-running\", true) from Keep running with the checkbox on", async () => {
    const onDecide = vi.fn();
    await render(<CloseGuard open onDecide={onDecide} />);

    const remember = container.querySelector<HTMLInputElement>(
      "input[type='checkbox']",
    )!;
    await act(async () => {
      remember.click();
    });

    await act(async () => {
      findButton("Keep running").click();
    });
    expect(onDecide).toHaveBeenCalledExactlyOnceWith("keep-running", true);
  });

  it("fires (\"stop-all\", false) from Stop everything with the checkbox off", async () => {
    const onDecide = vi.fn();
    await render(<CloseGuard open onDecide={onDecide} />);

    await act(async () => {
      findButton("Stop everything").click();
    });
    expect(onDecide).toHaveBeenCalledExactlyOnceWith("stop-all", false);
  });

  it("fires (\"stop-all\", true) from Stop everything with the checkbox on", async () => {
    const onDecide = vi.fn();
    await render(<CloseGuard open onDecide={onDecide} />);

    const remember = container.querySelector<HTMLInputElement>(
      "input[type='checkbox']",
    )!;
    await act(async () => {
      remember.click();
    });

    await act(async () => {
      findButton("Stop everything").click();
    });
    expect(onDecide).toHaveBeenCalledExactlyOnceWith("stop-all", true);
  });

  it("fires (\"keep-running\", false) on Escape regardless of the checkbox", async () => {
    const onDecide = vi.fn();
    await render(<CloseGuard open onDecide={onDecide} />);

    const remember = container.querySelector<HTMLInputElement>(
      "input[type='checkbox']",
    )!;
    await act(async () => {
      remember.click();
    });

    const dialog = container.querySelector<HTMLElement>("[role='dialog']")!;
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onDecide).toHaveBeenCalledExactlyOnceWith("keep-running", false);
  });

  it("takes initial focus and wraps Tab/Shift+Tab at the edges", async () => {
    await render(<CloseGuard open onDecide={() => undefined} />);

    const dialog = container.querySelector<HTMLElement>("[role='dialog']")!;
    expect(document.activeElement).toBe(dialog);

    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>("input, select, button"),
    );
    expect(focusables.length).toBeGreaterThan(1);
    const last = focusables[focusables.length - 1]!;

    last.focus();
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(focusables[0]);

    focusables[0]!.focus();
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(last);
  });
});
