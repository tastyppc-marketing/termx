import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlreadyOpenDialog } from "../AlreadyOpenDialog";

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

describe("AlreadyOpenDialog", () => {
  it("renders nothing when closed", async () => {
    await render(
      <AlreadyOpenDialog
        open={false}
        onSwitch={() => undefined}
        onOpenAnyway={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });

  it("renders the spec copy and both buttons when open", async () => {
    await render(
      <AlreadyOpenDialog
        open
        onSwitch={() => undefined}
        onOpenAnyway={() => undefined}
        onCancel={() => undefined}
      />,
    );

    const dialog = container.querySelector<HTMLElement>("[role='dialog']");
    expect(dialog).not.toBeNull();

    const body = container.querySelector(".already-open-dialog__body")?.textContent ?? "";
    expect(body).toBe("This session is already open. Switch to that tab?");

    expect(findButton("Switch")).toBeTruthy();
    expect(findButton("Open anyway")).toBeTruthy();
  });

  it("fires onSwitch from the Switch button", async () => {
    const onSwitch = vi.fn();
    await render(
      <AlreadyOpenDialog
        open
        onSwitch={onSwitch}
        onOpenAnyway={() => undefined}
        onCancel={() => undefined}
      />,
    );

    await act(async () => {
      findButton("Switch").click();
    });
    expect(onSwitch).toHaveBeenCalledExactlyOnceWith();
  });

  it("fires onOpenAnyway from the Open anyway button", async () => {
    const onOpenAnyway = vi.fn();
    await render(
      <AlreadyOpenDialog
        open
        onSwitch={() => undefined}
        onOpenAnyway={onOpenAnyway}
        onCancel={() => undefined}
      />,
    );

    await act(async () => {
      findButton("Open anyway").click();
    });
    expect(onOpenAnyway).toHaveBeenCalledExactlyOnceWith();
  });

  it("fires onCancel on Escape", async () => {
    const onCancel = vi.fn();
    await render(
      <AlreadyOpenDialog
        open
        onSwitch={() => undefined}
        onOpenAnyway={() => undefined}
        onCancel={onCancel}
      />,
    );

    const dialog = container.querySelector<HTMLElement>("[role='dialog']")!;
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onCancel).toHaveBeenCalledExactlyOnceWith();
  });

  it("takes initial focus and wraps Tab/Shift+Tab between the two buttons", async () => {
    await render(
      <AlreadyOpenDialog
        open
        onSwitch={() => undefined}
        onOpenAnyway={() => undefined}
        onCancel={() => undefined}
      />,
    );

    const dialog = container.querySelector<HTMLElement>("[role='dialog']")!;
    expect(document.activeElement).toBe(dialog);

    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>("button"));
    expect(focusables.length).toBe(2);
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
