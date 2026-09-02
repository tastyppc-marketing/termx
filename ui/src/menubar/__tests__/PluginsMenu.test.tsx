/**
 * The Plugins launcher: one row per registered plugin, with the placement
 * chips that say where it opens.
 *
 * The row is the plugin's default answer and the chips are its alternatives,
 * so the two halves must never disagree with the manifest: a surface the
 * plugin does not allow is not drawn at all, because a chip you cannot press
 * is worse than no chip. Presentational — the policy for what "open" means
 * lives in the controller's `openPlugin`.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSurface } from "../../plugins/manifest";
import { PluginsMenu, type PluginsMenuRow } from "../PluginsMenu";

let container: HTMLDivElement;
let root: Root | null = null;

const onOpen = vi.fn<(id: string, surface?: PluginSurface) => void>();
const onManage = vi.fn();
const onDone = vi.fn();

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  onOpen.mockClear();
  onManage.mockClear();
  onDone.mockClear();
});

afterEach(async () => {
  if (root) {
    const current = root;
    root = null;
    await act(async () => current.unmount());
  }
  document.body.replaceChildren();
});

function row(overrides: Partial<PluginsMenuRow> = {}): PluginsMenuRow {
  return {
    id: "recall",
    name: "Recall",
    icon: "◈",
    status: "up",
    autostart: false,
    surfaces: { default: "split", allowed: ["tab", "split", "window"] },
    ...overrides,
  };
}

async function mount(rows: readonly PluginsMenuRow[] = [row()]) {
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <PluginsMenu
        rows={rows}
        onOpen={onOpen}
        onManage={onManage}
        onDone={onDone}
      />,
    ),
  );
}

async function click(element: Element | null) {
  if (!element) {
    throw new Error("nothing to click");
  }
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function key(element: Element, init: KeyboardEventInit) {
  await act(async () => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
}

function at(rowId: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-row-id='${rowId}']`);
  if (!found) {
    throw new Error(`no control ${rowId}`);
  }
  return found;
}

function chipTexts(): string[] {
  return [...container.querySelectorAll(".plugins-menu__chip")].map(
    (chip) => chip.textContent ?? "",
  );
}

describe("PluginsMenu — what a row says", () => {
  it("heads the list and names each plugin with its manifest glyph", async () => {
    await mount([row(), row({ id: "showroom", name: "Showroom", icon: "▣" })]);
    expect(container.querySelector(".menubar__section")?.textContent).toBe(
      "Registered",
    );
    expect(
      [...container.querySelectorAll(".plugins-menu__row")].map(
        (item) => (item as HTMLElement).dataset.pluginId,
      ),
    ).toEqual(["recall", "showroom"]);
    expect(container.querySelector(".plugins-menu__icon")?.textContent).toBe("◈");
  });

  it("marks the status dot up, down or disabled", async () => {
    await mount([
      row({ id: "up", status: "up" }),
      row({ id: "down", status: "down" }),
      row({ id: "off", status: "disabled" }),
    ]);
    expect(
      [...container.querySelectorAll(".plugins-menu__dot")].map(
        (dot) => dot.className,
      ),
    ).toEqual([
      "plugins-menu__dot plugins-menu__dot--up",
      "plugins-menu__dot plugins-menu__dot--down",
      "plugins-menu__dot plugins-menu__dot--disabled",
    ]);
  });

  it("draws the allowed surfaces only, with the default one filled", async () => {
    await mount();
    expect(chipTexts()).toEqual(["Tab", "Split", "Win"]);
    expect(at("chip-recall-split").classList.contains("plugins-menu__chip--default"))
      .toBe(true);
    expect(at("chip-recall-tab").classList.contains("plugins-menu__chip--default"))
      .toBe(false);
  });

  it(
    "draws NO chip for a surface the plugin refuses — a chip you cannot press " +
      "is worse than no chip",
    async () => {
      await mount([
        row({ surfaces: { default: "tab", allowed: ["tab", "split"] } }),
      ]);
      expect(chipTexts()).toEqual(["Tab", "Split"]);
      expect(container.querySelector("[data-row-id='chip-recall-window']")).toBeNull();
    },
  );

  it("says on the row when a plugin starts with TermX", async () => {
    await mount([row({ autostart: true })]);
    expect(container.querySelector(".plugins-menu__auto")?.textContent).toBe(
      " · starts with TermX",
    );
    await mount([row({ autostart: false })]);
    expect(container.querySelector(".plugins-menu__auto")).toBeNull();
  });

  it("offers a disabled plugin the way to switch it on, and no chips", async () => {
    await mount([row({ status: "disabled" })]);
    expect(at("plugin-recall").textContent).toContain("Enable in Settings…");
    expect(chipTexts()).toEqual([]);
  });

  it("says so plainly when nothing is registered", async () => {
    await mount([]);
    expect(container.querySelector(".plugins-menu__empty")?.textContent).toBe(
      "No plugins registered yet.",
    );
    // The way to fix that is still one row away.
    expect(at("manage-plugins")).not.toBeNull();
  });
});

describe("PluginsMenu — what a row does", () => {
  it("opens on the plugin's OWN default when the row itself is clicked", async () => {
    await mount();
    await click(at("plugin-recall"));
    // No surface argument: the controller reads the manifest's default, so the
    // menu never has to hold a second copy of that decision.
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("recall");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("opens on the surface a chip names", async () => {
    await mount();
    await click(at("chip-recall-window"));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("recall", "window");
    await click(at("chip-recall-tab"));
    expect(onOpen).toHaveBeenNthCalledWith(2, "recall", "tab");
  });

  it("sends a disabled row to Settings instead of trying to open it", async () => {
    await mount([row({ status: "disabled" })]);
    await click(at("plugin-recall"));
    expect(onOpen).not.toHaveBeenCalled();
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("sends the foot row to Settings", async () => {
    await mount();
    await click(at("manage-plugins"));
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("PluginsMenu — keyboard", () => {
  it("walks Left and Right across a row's chips, starting from its name", async () => {
    await mount();
    at("plugin-recall").focus();
    await key(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(at("chip-recall-tab"));
    await key(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(at("chip-recall-split"));
    await key(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(at("chip-recall-tab"));
    await key(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(at("plugin-recall"));
  });

  it(
    "lets Left and Right OUT at the ends of a row, so the menubar can still " +
      "move to the next menu instead of trapping the user in a chip",
    async () => {
      await mount();
      at("plugin-recall").focus();
      const escaping = await keyReachesMenubar(at("plugin-recall"), "ArrowLeft");
      expect(escaping).toBe(true);
      at("chip-recall-window").focus();
      expect(await keyReachesMenubar(at("chip-recall-window"), "ArrowRight")).toBe(
        true,
      );
      // …and is consumed while there is somewhere to go inside the row.
      expect(await keyReachesMenubar(at("chip-recall-window"), "ArrowLeft")).toBe(
        false,
      );
    },
  );

  it("keeps the chips out of the menu's vertical walk", async () => {
    await mount();
    for (const chip of container.querySelectorAll(".plugins-menu__chip")) {
      expect(chip.getAttribute("data-menu-skip")).not.toBeNull();
    }
    expect(at("plugin-recall").getAttribute("data-menu-skip")).toBeNull();
  });
});

/**
 * Did the key survive the panel and reach the bar? The menubar reads
 * `defaultPrevented` to decide whether a panel claimed the key for itself, so
 * that is exactly what this asks.
 */
async function keyReachesMenubar(element: Element, name: string): Promise<boolean> {
  const event = new KeyboardEvent("keydown", {
    key: name,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    element.dispatchEvent(event);
  });
  return !event.defaultPrevented;
}
