/**
 * The menubar's behaviour: one menu open at a time, the pointer sliding
 * between labels the way every desktop menubar has behaved for forty years,
 * and a keyboard route through all of it.
 *
 * The chrome is Direction B (square, hairline, shadow-only elevation) and is
 * asserted only where it carries meaning — the register mark under the open
 * label, and the printed state column — never pixel by pixel.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Menubar, type MenuSpec } from "../Menubar";
import type { MenuRow } from "../menus";

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  if (root) {
    const current = root;
    root = null;
    await act(async () => current.unmount());
  }
  document.body.replaceChildren();
});

const picked = vi.fn();

function row(id: string, label: string, extra: Partial<MenuRow> = {}): MenuRow {
  return {
    kind: "item",
    id,
    label,
    disabled: false,
    onSelect: () => picked(id),
    ...extra,
  } as MenuRow;
}

function specs(overrides: Record<string, MenuSpec> = {}): MenuSpec[] {
  const base: Record<string, MenuSpec> = {
    workspace: {
      kind: "menu",
      id: "workspace",
      label: "Workspace",
      rows: [
        row("new-tab", "New tab"),
        row("split-right", "Split right", { shortcut: "Ctrl+Shift+D" }),
        { kind: "separator", id: "sep" },
        row("close-pane", "Close pane", { disabled: true }),
        row("save-session", "Save session…"),
      ],
    },
    view: {
      kind: "menu",
      id: "view",
      label: "View",
      rows: [
        row("side-rail", "Side rail", { state: true }),
        row("status-bar", "Status bar", { state: false }),
      ],
    },
    plugins: {
      kind: "panel",
      id: "plugins",
      label: "Plugins",
      render: (close) => (
        <button type="button" role="menuitem" data-testid="panel-row" onClick={close}>
          Manage plugins…
        </button>
      ),
    },
    settings: {
      kind: "item",
      id: "settings",
      label: "Settings",
      onSelect: () => picked("settings"),
    },
  };
  return Object.values({ ...base, ...overrides });
}

/**
 * A panel shaped like the Plugins launcher: rows the down-walk should visit,
 * and a chip beside one of them that it should step over.
 */
function chipPanel(): MenuSpec {
  return {
    kind: "panel",
    id: "plugins",
    label: "Plugins",
    render: (close) => (
      <>
        <button type="button" role="menuitem" data-row-id="recall">
          Recall
        </button>
        <button
          type="button"
          role="menuitem"
          data-menu-skip=""
          data-row-id="recall-split"
          onClick={() => {
            close();
            picked("recall-split");
          }}
        >
          Split
        </button>
        <button type="button" role="menuitem" data-row-id="showroom">
          Showroom
        </button>
      </>
    ),
  };
}

async function mount(menus: MenuSpec[] = specs()) {
  root = createRoot(container);
  await act(async () => root!.render(<Menubar menus={menus} />));
}

function label(id: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(
    `.menubar__item[data-menu-id='${id}']`,
  );
  if (!found) {
    throw new Error(`no menubar label ${id}`);
  }
  return found;
}

function dropdown(): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-testid='menubar-dropdown']");
}

function rowIds(): string[] {
  return [...container.querySelectorAll<HTMLElement>(".menubar__row")].map(
    (item) => item.dataset.rowId ?? "",
  );
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/**
 * React derives pointerenter from pointerover at the root, so a dispatched
 * `pointerenter` reaches nothing — the tests send what a browser really sends.
 */
async function hover(element: Element) {
  await act(async () => {
    element.dispatchEvent(
      new PointerEvent("pointerover", { bubbles: true, cancelable: true }),
    );
  });
}

async function key(element: Element, init: KeyboardEventInit) {
  await act(async () => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
}

beforeEach(() => picked.mockClear());

describe("Menubar — chrome", () => {
  it("renders the four labels after the window name, in spec order", async () => {
    await mount();
    expect(
      [...container.querySelectorAll(".menubar__item")].map(
        (item) => (item as HTMLElement).dataset.menuId,
      ),
    ).toEqual(["workspace", "view", "plugins", "settings"]);
    expect(container.querySelector("[data-testid='menubar']")?.getAttribute("role"))
      .toBe("menubar");
  });

  it("announces which labels open a menu and which are plain items", async () => {
    await mount();
    for (const id of ["workspace", "view", "plugins"]) {
      expect(label(id).getAttribute("aria-haspopup")).toBe("menu");
      expect(label(id).getAttribute("aria-expanded")).toBe("false");
    }
    // Settings is a destination, not a menu: nothing to expand.
    expect(label("settings").getAttribute("aria-haspopup")).toBeNull();
    expect(label("settings").getAttribute("aria-expanded")).toBeNull();
  });

  it("opens on click, with the register mark on the open label", async () => {
    await mount();
    expect(dropdown()).toBeNull();

    await click(label("workspace"));

    const menu = dropdown();
    expect(menu?.getAttribute("role")).toBe("menu");
    expect(menu?.getAttribute("aria-label")).toBe("Workspace");
    expect(label("workspace").getAttribute("aria-expanded")).toBe("true");
    expect(label("workspace").classList.contains("menubar__item--open")).toBe(true);
    expect(rowIds()).toEqual([
      "new-tab",
      "split-right",
      "close-pane",
      "save-session",
    ]);
    expect(menu?.querySelectorAll("[role='separator']")).toHaveLength(1);
  });

  it("prints the shortcut column and the on/off state column", async () => {
    await mount();
    await click(label("workspace"));
    expect(
      container.querySelector(".menubar__row[data-row-id='split-right'] .menubar__key")
        ?.textContent,
    ).toBe("Ctrl+Shift+D");
    // A row with no binding prints nothing at all.
    expect(
      container.querySelector(".menubar__row[data-row-id='new-tab'] .menubar__key"),
    ).toBeNull();

    await click(label("view"));
    const keys = [...container.querySelectorAll(".menubar__key")].map(
      (item) => item.textContent,
    );
    expect(keys).toEqual(["on", "off"]);
    expect(
      container
        .querySelector(".menubar__row[data-row-id='side-rail'] .menubar__key")
        ?.classList.contains("menubar__key--on"),
    ).toBe(true);
  });

  it("renders a panel menu's own content instead of a row list", async () => {
    await mount();
    await click(label("plugins"));
    expect(container.querySelector("[data-testid='panel-row']")).not.toBeNull();
    expect(dropdown()?.getAttribute("aria-label")).toBe("Plugins");
  });
});

describe("Menubar — opening, switching and closing", () => {
  it("switches on hover while a menu is open, and only then", async () => {
    await mount();
    // Nothing open: crossing the bar is just crossing the bar.
    await hover(label("view"));
    expect(dropdown()).toBeNull();

    await click(label("workspace"));
    await hover(label("view"));
    expect(dropdown()?.getAttribute("aria-label")).toBe("View");
    expect(label("workspace").getAttribute("aria-expanded")).toBe("false");
    // Only ever one.
    expect(container.querySelectorAll("[data-testid='menubar-dropdown']")).toHaveLength(1);
  });

  it("closes on a second click of the same label", async () => {
    await mount();
    await click(label("workspace"));
    await click(label("workspace"));
    expect(dropdown()).toBeNull();
  });

  it("closes on Escape and hands focus back to the label", async () => {
    await mount();
    await click(label("workspace"));
    await key(dropdown()!, { key: "Escape" });
    expect(dropdown()).toBeNull();
    expect(document.activeElement).toBe(label("workspace"));
  });

  it("closes on a pointerdown outside itself", async () => {
    await mount();
    await click(label("workspace"));
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(dropdown()).toBeNull();
  });

  it("stays open for a pointerdown inside the menu", async () => {
    await mount();
    await click(label("workspace"));
    await act(async () => {
      dropdown()!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(dropdown()).not.toBeNull();
  });

  it("runs the row's action and closes when an item is picked", async () => {
    await mount();
    await click(label("workspace"));
    await click(container.querySelector(".menubar__row[data-row-id='save-session']")!);
    expect(picked).toHaveBeenCalledExactlyOnceWith("save-session");
    expect(dropdown()).toBeNull();
  });

  it("renders a disabled row as disabled and refuses to run it", async () => {
    await mount();
    await click(label("workspace"));
    const closePane = container.querySelector<HTMLButtonElement>(
      ".menubar__row[data-row-id='close-pane']",
    )!;
    expect(closePane.disabled).toBe(true);
    await click(closePane);
    expect(picked).not.toHaveBeenCalled();
    expect(dropdown()).not.toBeNull();
  });

  it("fires a plain item's action without opening anything", async () => {
    await mount();
    await click(label("settings"));
    expect(picked).toHaveBeenCalledExactlyOnceWith("settings");
    expect(dropdown()).toBeNull();
  });
});

describe("Menubar — focus", () => {
  /**
   * The bar sits above a terminal. Every keystroke the user types belongs to
   * that terminal, so opening a menu with the pointer must not take focus off
   * it, and picking a row must hand it straight back.
   */
  function terminal(): HTMLElement {
    const pane = document.createElement("div");
    pane.tabIndex = -1;
    pane.id = "fake-xterm";
    document.body.append(pane);
    pane.focus();
    return pane;
  }

  /** What a browser really sends: mousedown (which moves focus) then click. */
  async function pointerOpen(element: HTMLElement): Promise<MouseEvent> {
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    await act(async () => {
      element.dispatchEvent(down);
    });
    await click(element);
    return down;
  }

  it("refuses the mousedown that would pull focus onto a label", async () => {
    await mount();
    const pane = terminal();

    const down = await pointerOpen(label("workspace"));

    // jsdom does not implement focus-on-mousedown, so the honest assertion is
    // on the suppression itself - that is the whole mechanism a browser uses.
    expect(down.defaultPrevented).toBe(true);
    expect(dropdown()).not.toBeNull();
    expect(document.activeElement).toBe(pane);
  });

  it("puts focus back where it was when a row is picked", async () => {
    await mount();
    const pane = terminal();
    await pointerOpen(label("workspace"));

    await click(
      container.querySelector<HTMLElement>("[data-row-id='new-tab']")!,
    );

    expect(picked).toHaveBeenCalledWith("new-tab");
    // Not the label: further typing has to reach the terminal, not a button.
    expect(document.activeElement).toBe(pane);
  });

  it("closes on Escape typed into the pane the pointer left focus in", async () => {
    await mount();
    const pane = terminal();
    await pointerOpen(label("workspace"));

    await key(pane, { key: "Escape" });

    expect(dropdown()).toBeNull();
    expect(document.activeElement).toBe(pane);
  });

  it("walks the rows of a menu opened by pointer, from outside the bar", async () => {
    await mount();
    const pane = terminal();
    await pointerOpen(label("workspace"));

    // The bar has no focus to receive arrow keys, so it listens while open.
    await key(pane, { key: "ArrowDown" });

    expect(document.activeElement?.getAttribute("data-row-id")).toBe("new-tab");
  });

  it("returns to the label when the menu was opened from the keyboard", async () => {
    await mount();
    terminal();
    label("workspace").focus();

    await key(label("workspace"), { key: "ArrowDown" });
    await key(document.activeElement!, { key: "Escape" });

    // Keyboard in, keyboard out: the label is where the user's focus was.
    expect(dropdown()).toBeNull();
    expect(document.activeElement).toBe(label("workspace"));
  });
});

describe("Menubar — keyboard", () => {
  it("opens with ArrowDown and lands on the first enabled row", async () => {
    await mount();
    label("workspace").focus();
    await key(label("workspace"), { key: "ArrowDown" });
    expect(dropdown()).not.toBeNull();
    expect((document.activeElement as HTMLElement)?.dataset.rowId).toBe("new-tab");
  });

  it("walks the rows with the arrows, skipping the disabled one", async () => {
    await mount();
    await click(label("workspace"));
    const menu = dropdown()!;
    await key(menu, { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement)?.dataset.rowId).toBe("new-tab");
    await key(menu, { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement)?.dataset.rowId).toBe("split-right");
    // close-pane is disabled, so the walk steps over it.
    await key(menu, { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement)?.dataset.rowId).toBe("save-session");
    // …and wraps.
    await key(menu, { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement)?.dataset.rowId).toBe("new-tab");
    await key(menu, { key: "ArrowUp" });
    expect((document.activeElement as HTMLElement)?.dataset.rowId).toBe("save-session");
  });

  it("activates the focused row with Enter", async () => {
    await mount();
    await click(label("workspace"));
    await key(dropdown()!, { key: "ArrowDown" });
    await key(document.activeElement!, { key: "Enter" });
    expect(picked).toHaveBeenCalledExactlyOnceWith("new-tab");
    expect(dropdown()).toBeNull();
  });

  it("moves between menus with Left and Right, from the label or the rows", async () => {
    await mount();
    await click(label("workspace"));
    await key(dropdown()!, { key: "ArrowRight" });
    expect(dropdown()?.getAttribute("aria-label")).toBe("View");
    await key(dropdown()!, { key: "ArrowLeft" });
    expect(dropdown()?.getAttribute("aria-label")).toBe("Workspace");
    // Left from the first menu wraps to the last one that HAS a menu; the
    // plain Settings item is a destination, never a menu to land in.
    await key(dropdown()!, { key: "ArrowLeft" });
    expect(dropdown()?.getAttribute("aria-label")).toBe("Plugins");
  });

  it(
    "steps the down-walk OVER a control a panel arranges on its own axis, so " +
      "a row of chips does not turn one menu row into four",
    async () => {
      await mount(specs({ plugins: chipPanel() }));
      await click(label("plugins"));
      const menu = dropdown()!;
      await key(menu, { key: "ArrowDown" });
      expect((document.activeElement as HTMLElement)?.dataset.rowId).toBe("recall");
      await key(menu, { key: "ArrowDown" });
      expect((document.activeElement as HTMLElement)?.dataset.rowId).toBe("showroom");
    },
  );

  it("still activates such a control with Enter once focus is on it", async () => {
    await mount(specs({ plugins: chipPanel() }));
    await click(label("plugins"));
    container.querySelector<HTMLElement>("[data-row-id='recall-split']")!.focus();
    await key(document.activeElement!, { key: "Enter" });
    expect(picked).toHaveBeenCalledExactlyOnceWith("recall-split");
    expect(dropdown()).toBeNull();
  });

  it("lets a panel claim Left/Right for itself", async () => {
    await mount(
      specs({
        plugins: {
          kind: "panel",
          id: "plugins",
          label: "Plugins",
          render: () => (
            <div
              data-testid="chips"
              onKeyDown={(event) => {
                if (event.key === "ArrowRight") {
                  event.preventDefault();
                }
              }}
            >
              <button type="button" role="menuitem" data-row-id="recall">
                Recall
              </button>
            </div>
          ),
        },
      }),
    );
    await click(label("plugins"));
    await key(container.querySelector("[data-testid='chips']")!, { key: "ArrowRight" });
    // The panel consumed it: the menubar did not walk on to Settings' neighbour.
    expect(dropdown()?.getAttribute("aria-label")).toBe("Plugins");
  });
});
