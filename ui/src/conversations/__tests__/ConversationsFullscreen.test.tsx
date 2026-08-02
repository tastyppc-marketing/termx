/**
 * Full-screen Conversations overlay (polish P5): renders its children, closes
 * on the restore control and on Esc — and Esc stays scoped to the overlay, so
 * it never fires once the surface is closed.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationsFullscreen } from "../ConversationsFullscreen";

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

async function renderOverlay(onClose: () => void) {
  await act(async () => {
    root.render(
      <ConversationsFullscreen onClose={onClose}>
        <div data-testid="rail-slot">rail goes here</div>
      </ConversationsFullscreen>,
    );
  });
}

function escape(target: EventTarget = window): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

describe("ConversationsFullscreen", () => {
  it("renders the header chrome and the injected children", async () => {
    await renderOverlay(vi.fn());

    const overlay = container.querySelector<HTMLElement>(".conversations-fullscreen")!;
    expect(overlay.getAttribute("aria-label")).toBe("Conversations full screen");
    expect(overlay.textContent).toContain("Conversations");
    expect(overlay.textContent).toContain("Esc");
    expect(container.querySelector("[data-testid='rail-slot']")).not.toBeNull();
    expect(
      container.querySelector(".conversations-fullscreen__body [data-testid='rail-slot']"),
    ).not.toBeNull();
    expect(container.querySelector("[aria-label='Exit full screen']")).not.toBeNull();
  });

  it("closes from the restore control", async () => {
    const onClose = vi.fn();
    await renderOverlay(onClose);

    const restore = container.querySelector<HTMLButtonElement>(
      "[aria-label='Exit full screen']",
    )!;
    await act(async () => {
      restore.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("takes focus on mount and closes on Esc", async () => {
    const onClose = vi.fn();
    await renderOverlay(onClose);

    expect(document.activeElement).toBe(
      container.querySelector(".conversations-fullscreen"),
    );

    await act(async () => escape());

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores Esc raised outside the overlay and other keys inside it", async () => {
    const onClose = vi.fn();
    await renderOverlay(onClose);

    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    await act(async () => escape(outside));
    expect(onClose).not.toHaveBeenCalled();

    container.querySelector<HTMLElement>(".conversations-fullscreen")!.focus();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => escape());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("never fires once closed — the listener leaves with the overlay", async () => {
    const onClose = vi.fn();
    await renderOverlay(onClose);
    await act(async () => root.render(null));

    await act(async () => escape());
    await act(async () => escape(document.body));

    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector(".conversations-fullscreen")).toBeNull();
  });
});
