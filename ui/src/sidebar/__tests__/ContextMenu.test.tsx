import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampMenuPoint, ContextMenu } from "../ContextMenu";

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

function MenuHarness({ onClose }: { onClose: () => void }) {
  return (
    <ContextMenu label="Tab actions" point={{ x: 20, y: 30 }} onClose={onClose}>
      <button type="button" role="menuitem" disabled>Unavailable</button>
      <button type="button" role="menuitem">Rename</button>
      <button type="button" role="menuitem">Close</button>
    </ContextMenu>
  );
}

function keydown(key: string): void {
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("clampMenuPoint", () => {
  it("clamps menus to an eight-pixel viewport inset", () => {
    expect(clampMenuPoint(
      { x: 195, y: -10 },
      { width: 80, height: 60 },
      { width: 200, height: 100 },
    )).toEqual({ x: 112, y: 8 });
    expect(clampMenuPoint(
      { x: 30, y: 40 },
      { width: 80, height: 60 },
      { width: 200, height: 120 },
    )).toEqual({ x: 30, y: 40 });
  });
});

describe("ContextMenu", () => {
  it("renders an accessible menu and focuses the first enabled item", async () => {
    await act(async () => root.render(<MenuHarness onClose={vi.fn()} />));

    const menu = container.querySelector<HTMLElement>("[role='menu']")!;
    const rename = container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")[1]!;
    expect(menu.getAttribute("aria-label")).toBe("Tab actions");
    expect(document.activeElement).toBe(rename);
    expect(menu.style.position).toBe("fixed");
  });

  it("moves focus among enabled items with Arrow Up and Down", async () => {
    await act(async () => root.render(<MenuHarness onClose={vi.fn()} />));
    const items = container.querySelectorAll<HTMLButtonElement>("[role='menuitem']");

    await act(async () => keydown("ArrowDown"));
    expect(document.activeElement).toBe(items[2]);
    await act(async () => keydown("ArrowDown"));
    expect(document.activeElement).toBe(items[1]);
    await act(async () => keydown("ArrowUp"));
    expect(document.activeElement).toBe(items[2]);
  });

  it("activates the focused native button with Enter and Space", async () => {
    const onRename = vi.fn();
    await act(async () => root.render(
      <ContextMenu label="Actions" point={{ x: 0, y: 0 }} onClose={vi.fn()}>
        <button type="button" role="menuitem" onClick={onRename}>Rename</button>
      </ContextMenu>,
    ));

    await act(async () => keydown("Enter"));
    await act(async () => keydown(" "));
    expect(onRename).toHaveBeenCalledTimes(2);
  });

  it("closes on Escape or an outside pointer but retains inside pointers", async () => {
    const onClose = vi.fn();
    await act(async () => root.render(<MenuHarness onClose={onClose} />));
    const menu = container.querySelector<HTMLElement>("[role='menu']")!;

    await act(async () => {
      menu.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the opener when closed", async () => {
    const opener = document.createElement("button");
    document.body.prepend(opener);
    opener.focus();
    const onClose = vi.fn();
    await act(async () => root.render(<MenuHarness onClose={onClose} />));

    await act(async () => keydown("Escape"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it("measures and clamps fixed coordinates to the viewport", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 80,
      height: 60,
      top: 0,
      right: 80,
      bottom: 60,
      left: 0,
      toJSON: () => ({}),
    });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 200 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 100 });

    await act(async () => root.render(
      <ContextMenu label="Actions" point={{ x: 195, y: 95 }} onClose={vi.fn()}>
        <button type="button" role="menuitem">Rename</button>
      </ContextMenu>,
    ));

    const menu = container.querySelector<HTMLElement>("[role='menu']")!;
    expect(menu.style.left).toBe("112px");
    expect(menu.style.top).toBe("32px");
  });
});
