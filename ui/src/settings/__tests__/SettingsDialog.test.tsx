import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "../SettingsDialog";
import { DEFAULT_SETTINGS } from "../settings";

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

describe("SettingsDialog", () => {
  it("reflects current settings and reports changes as patches", async () => {
    const onChange = vi.fn();
    await render(
      <SettingsDialog
        settings={DEFAULT_SETTINGS}
        onChange={onChange}
        onClose={() => undefined}
      />,
    );

    const groupActive = container.querySelector<HTMLInputElement>(
      "input[value='group-active']",
    );
    expect(groupActive?.checked).toBe(true);

    const askSearcher = container.querySelector<HTMLInputElement>(
      "input[value='ask-searcher']",
    );
    await act(async () => {
      askSearcher?.click();
    });
    expect(onChange).toHaveBeenCalledWith({ newTabPolicy: "ask-searcher" });

    const integration = container.querySelector<HTMLInputElement>(
      "input[type='checkbox']",
    );
    expect(integration?.checked).toBe(true);
    await act(async () => {
      integration?.click();
    });
    expect(onChange).toHaveBeenCalledWith({ shellIntegration: false });
  });

  it("closes on Escape and via the Done button", async () => {
    const onClose = vi.fn();
    await render(
      <SettingsDialog
        settings={DEFAULT_SETTINGS}
        onChange={() => undefined}
        onClose={onClose}
      />,
    );

    const dialog = container.querySelector<HTMLElement>("[role='dialog']")!;
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    const done = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Done",
    );
    await act(async () => {
      done?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("takes initial focus and wraps Tab at the edges", async () => {
    await render(
      <SettingsDialog
        settings={DEFAULT_SETTINGS}
        onChange={() => undefined}
        onClose={() => undefined}
      />,
    );

    const dialog = container.querySelector<HTMLElement>("[role='dialog']")!;
    expect(document.activeElement).toBe(dialog);

    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>("input, select, button"),
    );
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
