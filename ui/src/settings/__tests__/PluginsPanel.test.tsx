/**
 * The Plugins settings panel: the only surface where a plugin is added,
 * enabled, opened or removed. It is also the only place a broken plugin folder
 * gets explained, so the manifest-problem assertions below are as load-bearing
 * as the happy path — a silent row would leave the user with a plugin that
 * simply never opens and no reason why.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginNative } from "../../plugins/native";
import { PluginsStore, type PluginsV1 } from "../../plugins/registry";
import {
  PluginsPanel,
  shortenPath,
  type PluginHealth,
} from "../PluginsPanel";
import { SettingsStore } from "../SettingsStore";
import { SettingsSurface } from "../SettingsSurface";

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

const SHOWROOM_PATH = "C:\\code\\showroom";
const WIDGETS_PATH = "D:\\plugins\\widgets";

function storeWith(plugins: PluginsV1["plugins"]): PluginsStore {
  return new PluginsStore({ initial: { plugins } });
}

/** A manifest whose fields all pass, so a test can break exactly one. */
function manifestText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    manifest: 1,
    id: "widgets",
    name: "Widgets",
    icon: "▣",
    start: { command: "node", args: ["server.js"] },
    singleton: true,
    discovery: {
      runtimeFile: "%APPDATA%\\Widgets\\runtime.json",
      healthPath: "/api/health",
    },
    panel: { path: "/" },
    ...overrides,
  });
}

/** Folder → manifest text; any folder not named reads as "no manifest file". */
function fakeNative(manifests: Record<string, string> = {}): PluginNative {
  return {
    readRuntime: vi.fn().mockResolvedValue(null),
    probe: vi.fn().mockResolvedValue(""),
    spawn: vi.fn().mockResolvedValue(1),
    stderrTail: vi.fn().mockResolvedValue(""),
    readManifest: vi.fn(async (folder: string) => manifests[folder] ?? null),
  };
}

interface PanelOptions {
  store: PluginsStore;
  native?: PluginNative;
  health?: Record<string, PluginHealth>;
  onOpen?: (pluginId: string) => void;
  pickFolder?: () => Promise<string | null>;
  bundled?: Parameters<typeof PluginsPanel>[0]["bundled"];
}

async function renderPanel(options: PanelOptions): Promise<void> {
  await act(async () => {
    root.render(
      <PluginsPanel
        store={options.store}
        native={options.native ?? fakeNative()}
        {...(options.health ? { health: options.health } : {})}
        {...(options.onOpen ? { onOpen: options.onOpen } : {})}
        {...(options.pickFolder ? { pickFolder: options.pickFolder } : {})}
        {...(options.bundled ? { bundled: options.bundled } : {})}
      />,
    );
  });
  // The manifest reads are async; one more empty act drains them so assertions
  // see the settled row state rather than the first paint.
  await act(async () => undefined);
}

function rowIds(): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(".settings-plugin"),
  ).map((row) => row.dataset.pluginId!);
}

function row(id: string): HTMLElement {
  return container.querySelector<HTMLElement>(
    `.settings-plugin[data-plugin-id='${id}']`,
  )!;
}

function text(element: Element | null): string {
  return element?.textContent ?? "";
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

function action(id: string, label: string): HTMLButtonElement | null {
  return (
    Array.from(
      row(id).querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === label) ?? null
  );
}

/** The Remove button, found by role rather than by its two-step label. */
function removeButton(id: string): HTMLButtonElement | null {
  return row(id).querySelector<HTMLButtonElement>(
    ".settings-plugins__action--danger",
  );
}

describe("PluginsPanel rows", () => {
  it("lists every installed plugin with its folder path", async () => {
    await renderPanel({
      store: storeWith({
        widgets: { path: WIDGETS_PATH, enabled: false, grants: [] },
        showroom: { path: SHOWROOM_PATH, enabled: true, grants: [] },
      }),
      native: fakeNative({ [WIDGETS_PATH]: manifestText() }),
    });

    // Bundled first, then alphabetical: the first-party plugin is the anchor.
    expect(rowIds()).toEqual(["showroom", "widgets"]);
    expect(text(row("showroom").querySelector(".settings-plugin__name"))).toContain(
      "Showroom",
    );
    expect(text(row("showroom").querySelector(".settings-plugin__path"))).toBe(
      SHOWROOM_PATH,
    );
    expect(text(row("widgets").querySelector(".settings-plugin__name"))).toContain(
      "Widgets",
    );
    expect(text(row("widgets").querySelector(".settings-plugin__path"))).toBe(
      WIDGETS_PATH,
    );
  });

  it("lists the bundled plugin even when no folder has been added", async () => {
    await renderPanel({ store: storeWith({}) });

    expect(rowIds()).toEqual(["showroom"]);
    const toggle = row("showroom").querySelector<HTMLInputElement>(
      "input[type='checkbox']",
    )!;
    // Nothing to enable until a folder is known — an enabled row with no path
    // would be a switch that silently does nothing.
    expect(toggle.disabled).toBe(true);
    expect(action("showroom", "Add folder…")).not.toBeNull();
  });

  it("toggles enabled through the store", async () => {
    const store = storeWith({
      showroom: { path: SHOWROOM_PATH, enabled: false, grants: [] },
    });
    const setEnabled = vi.spyOn(store, "setEnabled");
    await renderPanel({ store });

    const toggle = row("showroom").querySelector<HTMLInputElement>(
      "input[type='checkbox']",
    )!;
    expect(toggle.checked).toBe(false);
    await click(toggle);

    expect(setEnabled).toHaveBeenCalledWith("showroom", true);
    expect(store.getSnapshot().plugins.showroom!.enabled).toBe(true);
    expect(
      row("showroom").querySelector<HTMLInputElement>("input[type='checkbox']")!
        .checked,
    ).toBe(true);
  });

  it("removes a folder plugin, row and all", async () => {
    const store = storeWith({
      showroom: { path: SHOWROOM_PATH, enabled: true, grants: [] },
      widgets: { path: WIDGETS_PATH, enabled: true, grants: [] },
    });
    const remove = vi.spyOn(store, "remove");
    await renderPanel({
      store,
      native: fakeNative({ [WIDGETS_PATH]: manifestText() }),
    });

    // Removal is two-step (see the confirm-in-place suite); the first click
    // only arms the button.
    await click(removeButton("widgets")!);
    await click(removeButton("widgets")!);
    expect(remove).toHaveBeenCalledWith("widgets");
    expect(rowIds()).toEqual(["showroom"]);
  });

  it("removes the folder from a bundled plugin but keeps its row", async () => {
    // Showroom ships with TermX, so the catalog entry is permanent — but the
    // folder it points at is the user's and has to be forgettable.
    const store = storeWith({
      showroom: { path: SHOWROOM_PATH, enabled: true, grants: [] },
    });
    const remove = vi.spyOn(store, "remove");
    await renderPanel({ store });

    await click(removeButton("showroom")!);
    await click(removeButton("showroom")!);

    expect(remove).toHaveBeenCalledWith("showroom");
    expect(rowIds()).toEqual(["showroom"]);
    expect(text(row("showroom").querySelector(".settings-plugin__hint"))).toBe(
      "No folder added yet.",
    );
    // And the way back is right there.
    expect(action("showroom", "Add folder…")).not.toBeNull();
  });

  it("offers nothing to remove on a bundled row with no folder", async () => {
    await renderPanel({ store: storeWith({}) });

    expect(removeButton("showroom")).toBeNull();
  });

  it("opens a plugin as a tab", async () => {
    const onOpen = vi.fn();
    await renderPanel({
      store: storeWith({
        showroom: { path: SHOWROOM_PATH, enabled: true, grants: [] },
      }),
      onOpen,
    });

    await click(action("showroom", "Open as tab")!);
    expect(onOpen).toHaveBeenCalledWith("showroom");
  });

  it("offers no Open action for a disabled plugin", async () => {
    await renderPanel({
      store: storeWith({
        showroom: { path: SHOWROOM_PATH, enabled: false, grants: [] },
      }),
      onOpen: vi.fn(),
    });

    expect(action("showroom", "Open as tab")).toBeNull();
  });
});

describe("PluginsPanel row hierarchy", () => {
  it("marks a disabled row so it reads as stood down", async () => {
    await renderPanel({
      store: storeWith({
        showroom: { path: SHOWROOM_PATH, enabled: false, grants: [] },
        widgets: { path: WIDGETS_PATH, enabled: true, grants: [] },
      }),
      native: fakeNative({ [WIDGETS_PATH]: manifestText() }),
    });

    expect(row("showroom").className).toContain("settings-plugin--disabled");
    expect(row("widgets").className).not.toContain("settings-plugin--disabled");
  });

  it("shows the plugin id beside a name that differs from it", async () => {
    await renderPanel({
      store: storeWith({
        showroom: { path: SHOWROOM_PATH, enabled: true, grants: [] },
      }),
    });

    // Two plugins may both call themselves "Showroom"; the id is what the
    // registry, the layout blob and every error message actually key on.
    expect(text(row("showroom").querySelector(".settings-plugin__id"))).toBe(
      "showroom",
    );
  });

  it("omits the id when it is the only name there is", async () => {
    // No manifest, no bundled entry: the label already *is* the id, and
    // printing it twice is noise.
    await renderPanel({
      store: storeWith({
        widgets: { path: WIDGETS_PATH, enabled: true, grants: [] },
      }),
      bundled: {},
    });

    expect(text(row("widgets").querySelector(".settings-plugin__label"))).toBe(
      "widgets",
    );
    expect(row("widgets").querySelector(".settings-plugin__id")).toBeNull();
  });

  it("middle-truncates a long folder and keeps the whole path in the tooltip", async () => {
    const long = "C:\\Users\\mjfos\\code\\vendor\\termx-plugins\\showroom\\plugin";
    await renderPanel({
      store: storeWith({
        showroom: { path: long, enabled: true, grants: [] },
      }),
    });

    const path = row("showroom").querySelector<HTMLElement>(
      ".settings-plugin__path",
    )!;
    expect(path.textContent).toBe("C:\\…\\showroom\\plugin");
    expect(path.title).toBe(long);
  });
});

describe("PluginsPanel health marks", () => {
  function health(id: string): HTMLElement | null {
    return row(id).querySelector<HTMLElement>(".settings-plugin__health");
  }

  async function renderWithHealth(
    reported: Record<string, PluginHealth>,
  ): Promise<void> {
    await renderPanel({
      store: storeWith({
        showroom: { path: SHOWROOM_PATH, enabled: true, grants: [] },
        widgets: { path: WIDGETS_PATH, enabled: true, grants: [] },
      }),
      native: fakeNative({ [WIDGETS_PATH]: manifestText() }),
      health: reported,
    });
  }

  it("draws a distinct mark for up, down and starting", async () => {
    await renderWithHealth({ showroom: "up", widgets: "down" });
    expect(health("showroom")!.className).toContain(
      "settings-plugin__health--up",
    );
    expect(health("widgets")!.className).toContain(
      "settings-plugin__health--down",
    );

    await renderWithHealth({ showroom: "starting", widgets: "up" });
    expect(health("showroom")!.className).toContain(
      "settings-plugin__health--starting",
    );
  });

  it("names each mark for a screen reader", async () => {
    await renderWithHealth({ showroom: "up", widgets: "down" });
    expect(health("showroom")!.getAttribute("aria-label")).toBe("Running");
    expect(health("widgets")!.getAttribute("aria-label")).toBe("Not answering");
  });

  it("draws no mark for a plugin nothing is reporting on", async () => {
    // No workspace wired, or never opened in this window. A mark here would
    // read as a state the process is in.
    await renderWithHealth({ showroom: "up" });
    expect(health("widgets")).toBeNull();
  });

  it("draws no mark for a reported unknown either", async () => {
    await renderWithHealth({ showroom: "unknown", widgets: "up" });
    expect(health("showroom")).toBeNull();
  });

  it("draws no marks at all when no health is passed", async () => {
    await renderPanel({
      store: storeWith({
        showroom: { path: SHOWROOM_PATH, enabled: true, grants: [] },
      }),
    });
    expect(health("showroom")).toBeNull();
  });
});

describe("shortenPath", () => {
  it("leaves a path that already fits alone", () => {
    expect(shortenPath("C:\\code\\showroom")).toBe("C:\\code\\showroom");
  });

  it("keeps the drive and the last two segments of a long Windows path", () => {
    expect(
      shortenPath("C:\\Users\\mjfos\\code\\vendor\\termx-plugins\\showroom\\plugin"),
    ).toBe("C:\\…\\showroom\\plugin");
  });

  it("keeps the whole \\\\server\\share head of a long UNC path", () => {
    // Dropping either half of a UNC head names a machine that does not exist,
    // which is worse than a longer string.
    expect(
      shortenPath(
        "\\\\fileserver01\\team-share\\dev\\termx\\vendor\\plugins\\showroom-viewer",
      ),
    ).toBe("\\\\fileserver01\\team-share\\…\\plugins\\showroom-viewer");
  });

  it("keeps the leading slash of a long POSIX path", () => {
    expect(
      shortenPath("/home/mjfos/code/vendor/termx/plugins/showroom-viewer"),
    ).toBe("/home/…/plugins/showroom-viewer");
  });

  it("returns a long but shallow path unchanged rather than lying about it", () => {
    // Nothing to elide between the head and the last two segments: an ellipsis
    // here would claim there are hidden folders when there are none.
    const shallow = "C:\\a-very-long-single-folder-name-that-runs-on\\plugin";
    expect(shortenPath(shallow)).toBe(shallow);
  });
});

describe("PluginsPanel accessible names", () => {
  it("names the plugin on its toggle and on both row buttons", async () => {
    await renderPanel({
      store: storeWith({
        showroom: { path: SHOWROOM_PATH, enabled: true, grants: [] },
        widgets: { path: WIDGETS_PATH, enabled: true, grants: [] },
      }),
      native: fakeNative({ [WIDGETS_PATH]: manifestText() }),
      onOpen: vi.fn(),
    });

    // "Enabled" repeated down a list tells a screen-reader user nothing about
    // which plugin the switch belongs to.
    const toggle = row("showroom").querySelector<HTMLInputElement>(
      "input[type='checkbox']",
    )!;
    expect(toggle.getAttribute("aria-label")).toContain("Showroom");
    expect(
      action("showroom", "Open as tab")!.getAttribute("aria-label"),
    ).toContain("Showroom");
    expect(removeButton("widgets")!.getAttribute("aria-label")).toContain(
      "Widgets",
    );
  });

  it("starts every accessible name with the control's own visible text", async () => {
    // WCAG 2.5.3 label-in-name: someone driving by voice says what they can
    // see ("click open as tab"), so the visible words must lead the name.
    await renderPanel({
      store: storeWith({
        showroom: { path: SHOWROOM_PATH, enabled: true, grants: [] },
        widgets: { path: WIDGETS_PATH, enabled: true, grants: [] },
      }),
      native: fakeNative({ [WIDGETS_PATH]: manifestText() }),
      onOpen: vi.fn(),
    });

    expect(
      row("showroom")
        .querySelector<HTMLInputElement>("input[type='checkbox']")!
        .getAttribute("aria-label"),
    ).toBe("Enabled: Showroom");
    expect(
      action("showroom", "Open as tab")!.getAttribute("aria-label"),
    ).toBe("Open as tab: Showroom");
    expect(removeButton("widgets")!.getAttribute("aria-label")).toBe(
      "Remove: Widgets",
    );
    // Bundled: the plugin stays, only its folder goes — and "Remove" still
    // leads, so the visible word is still the spoken one.
    expect(removeButton("showroom")!.getAttribute("aria-label")).toBe(
      "Remove folder: Showroom",
    );
  });

  it("keeps the visible text leading once Remove is armed", async () => {
    await renderPanel({
      store: storeWith({
        widgets: { path: WIDGETS_PATH, enabled: true, grants: [] },
      }),
      native: fakeNative({ [WIDGETS_PATH]: manifestText() }),
    });

    await click(removeButton("widgets")!);
    expect(removeButton("widgets")!.textContent).toBe("Confirm remove");
    expect(removeButton("widgets")!.getAttribute("aria-label")).toBe(
      "Confirm remove: Widgets",
    );
  });

  it("names a row's Add and Change folder buttons too", async () => {
    await renderPanel({ store: storeWith({}) });
    expect(action("showroom", "Add folder…")!.getAttribute("aria-label")).toBe(
      "Add folder: Showroom",
    );

    await renderPanel({
      store: storeWith({
        showroom: { path: SHOWROOM_PATH, enabled: true, grants: [] },
      }),
    });
    expect(
      action("showroom", "Change folder…")!.getAttribute("aria-label"),
    ).toBe("Change folder: Showroom");
  });

  it("does not leave the toggle's visible text to be read twice", async () => {
    await renderPanel({
      store: storeWith({
        showroom: { path: SHOWROOM_PATH, enabled: true, grants: [] },
      }),
    });

    // The aria-label already says "Enabled: Showroom"; the visible "Enabled"
    // beside it would otherwise be announced again as static text.
    expect(
      row("showroom")
        .querySelector(".settings-radio__text")!
        .getAttribute("aria-hidden"),
    ).toBe("true");
  });
});

describe("PluginsPanel remove confirmation", () => {
  function widgetsStore(): PluginsStore {
    return storeWith({
      widgets: { path: WIDGETS_PATH, enabled: true, grants: [] },
    });
  }

  async function renderWidgets(store: PluginsStore): Promise<void> {
    await renderPanel({
      store,
      native: fakeNative({ [WIDGETS_PATH]: manifestText() }),
    });
  }

  it("arms on the first click and removes only on the second", async () => {
    const store = widgetsStore();
    const remove = vi.spyOn(store, "remove");
    await renderWidgets(store);

    await click(removeButton("widgets")!);
    expect(remove).not.toHaveBeenCalled();
    expect(removeButton("widgets")!.textContent).toBe("Confirm remove");

    await click(removeButton("widgets")!);
    expect(remove).toHaveBeenCalledWith("widgets");
    expect(rowIds()).toEqual(["showroom"]);
  });

  it("disarms when the button loses focus", async () => {
    const store = widgetsStore();
    const remove = vi.spyOn(store, "remove");
    await renderWidgets(store);

    const button = removeButton("widgets")!;
    button.focus();
    await click(button);
    await act(async () => {
      button.blur();
    });

    expect(removeButton("widgets")!.textContent).toBe("Remove");
    expect(remove).not.toHaveBeenCalled();
  });

  it("disarms on Escape", async () => {
    const store = widgetsStore();
    await renderWidgets(store);

    const button = removeButton("widgets")!;
    await click(button);
    await act(async () => {
      button.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(removeButton("widgets")!.textContent).toBe("Remove");
  });

  it("disarms itself after four seconds", async () => {
    const store = widgetsStore();
    await renderWidgets(store);

    // The timer is scheduled by the arming click, so the clock has to be fake
    // before it — installing it afterwards would leave a real 4 s pending.
    vi.useFakeTimers();
    try {
      await click(removeButton("widgets")!);
      expect(removeButton("widgets")!.textContent).toBe("Confirm remove");

      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(removeButton("widgets")!.textContent).toBe("Remove");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PluginsPanel manifest problems", () => {
  it("flags a folder with no manifest file", async () => {
    await renderPanel({
      store: storeWith({
        widgets: { path: WIDGETS_PATH, enabled: true, grants: [] },
      }),
    });

    expect(text(row("widgets").querySelector(".settings-plugin__status"))).toBe(
      "Manifest missing",
    );
  });

  it("names the invalid fields of a malformed manifest", async () => {
    await renderPanel({
      store: storeWith({
        widgets: { path: WIDGETS_PATH, enabled: true, grants: [] },
      }),
      native: fakeNative({
        [WIDGETS_PATH]: manifestText({ id: "Widgets!", start: {} }),
      }),
    });

    expect(text(row("widgets").querySelector(".settings-plugin__status"))).toBe(
      "Manifest invalid: id, start.command, start.args",
    );
  });

  it("says so plainly when a manifest is not JSON at all", async () => {
    await renderPanel({
      store: storeWith({
        widgets: { path: WIDGETS_PATH, enabled: true, grants: [] },
      }),
      native: fakeNative({ [WIDGETS_PATH]: "{ not json" }),
    });

    // A parser exception must never reach the panel as a stack trace.
    expect(text(row("widgets").querySelector(".settings-plugin__status"))).toBe(
      "Manifest is not valid JSON",
    );
  });

  it("flags a folder that cannot be read, apart from one with no manifest", async () => {
    const native = fakeNative();
    native.readManifest = vi.fn().mockRejectedValue(new Error("EACCES"));
    await renderPanel({
      store: storeWith({
        widgets: { path: WIDGETS_PATH, enabled: true, grants: [] },
      }),
      native,
    });

    // A deleted or permission-denied folder is not the same as an ordinary
    // folder that simply carries no termx-plugin.json.
    expect(text(row("widgets").querySelector(".settings-plugin__status"))).toBe(
      "Folder unavailable",
    );
  });

  it("refuses a manifest that names a different plugin than the row", async () => {
    // Someone edited the manifest, or pointed two rows at one folder. The
    // lifecycle keys on the registry id and would refuse to start it, so a
    // healthy-looking row here is a lie with an "Open as tab" button on it.
    await renderPanel({
      store: storeWith({
        widgets: { path: WIDGETS_PATH, enabled: false, grants: [] },
      }),
      native: fakeNative({ [WIDGETS_PATH]: manifestText({ id: "gadgets" }) }),
      onOpen: vi.fn(),
    });

    expect(text(row("widgets").querySelector(".settings-plugin__status"))).toBe(
      "This folder's manifest says gadgets, not widgets.",
    );
    expect(action("widgets", "Open as tab")).toBeNull();
  });

  it("will not switch on a plugin whose folder is broken", async () => {
    await renderPanel({
      store: storeWith({
        widgets: { path: WIDGETS_PATH, enabled: false, grants: [] },
      }),
    });

    // Nothing to enable: the lifecycle would refuse it, so the switch would
    // silently do nothing.
    const toggle = row("widgets").querySelector<HTMLInputElement>(
      "input[type='checkbox']",
    )!;
    expect(toggle.disabled).toBe(true);
  });

  it("still lets a broken plugin be switched off", async () => {
    // The row broke while it was on. Trapping it there is worse than the
    // problem it is reporting.
    const store = storeWith({
      widgets: { path: WIDGETS_PATH, enabled: true, grants: [] },
    });
    const setEnabled = vi.spyOn(store, "setEnabled");
    await renderPanel({ store });

    const toggle = row("widgets").querySelector<HTMLInputElement>(
      "input[type='checkbox']",
    )!;
    expect(toggle.disabled).toBe(false);

    await click(toggle);
    expect(setEnabled).toHaveBeenCalledWith("widgets", false);
    expect(store.getSnapshot().plugins.widgets!.enabled).toBe(false);
  });

  it("hides Open on a mismatched manifest even while the plugin is on", async () => {
    // Separate from the enabled gate: this row IS enabled, so if Open is gone
    // it is the manifest problem hiding it and nothing else.
    const store = storeWith({
      widgets: { path: WIDGETS_PATH, enabled: true, grants: [] },
    });
    const setEnabled = vi.spyOn(store, "setEnabled");
    await renderPanel({
      store,
      native: fakeNative({ [WIDGETS_PATH]: manifestText({ id: "gadgets" }) }),
      onOpen: vi.fn(),
    });

    expect(text(row("widgets").querySelector(".settings-plugin__status"))).toBe(
      "This folder's manifest says gadgets, not widgets.",
    );
    expect(action("widgets", "Open as tab")).toBeNull();

    // And the way out is still open.
    const toggle = row("widgets").querySelector<HTMLInputElement>(
      "input[type='checkbox']",
    )!;
    expect(toggle.disabled).toBe(false);
    await click(toggle);
    expect(setEnabled).toHaveBeenCalledWith("widgets", false);
  });

  it("uses the bundled manifest when the bundled plugin's folder has no file", async () => {
    // Showroom's repository carries no termx-plugin.json by design (spec §9);
    // its bundled manifest is the answer, not a problem chip.
    await renderPanel({
      store: storeWith({
        showroom: { path: SHOWROOM_PATH, enabled: true, grants: [] },
      }),
    });

    expect(row("showroom").querySelector(".settings-plugin__status")).toBeNull();
    expect(text(row("showroom").querySelector(".settings-plugin__name"))).toContain(
      "Showroom",
    );
  });
});

describe("PluginsPanel add flow", () => {
  function addButton(): HTMLButtonElement {
    return container.querySelector<HTMLButtonElement>(
      "[data-testid='plugins-add']",
    )!;
  }

  function error(): string {
    return text(container.querySelector(".settings-plugins__error"));
  }

  it("adds a folder whose manifest parses", async () => {
    const store = storeWith({});
    const add = vi.spyOn(store, "add");
    await renderPanel({
      store,
      native: fakeNative({ [WIDGETS_PATH]: manifestText() }),
      pickFolder: async () => WIDGETS_PATH,
    });

    await click(addButton());

    expect(add).toHaveBeenCalledWith("widgets", WIDGETS_PATH);
    expect(error()).toBe("");
    expect(rowIds()).toEqual(["showroom", "widgets"]);
  });

  it("falls back to the bundled manifest, keyed by folder name", async () => {
    const store = storeWith({});
    const add = vi.spyOn(store, "add");
    await renderPanel({ store, pickFolder: async () => SHOWROOM_PATH });

    await click(addButton());

    expect(add).toHaveBeenCalledWith("showroom", SHOWROOM_PATH);
    expect(error()).toBe("");
  });

  it("refuses a folder that is neither manifested nor bundled", async () => {
    const store = storeWith({});
    const add = vi.spyOn(store, "add");
    await renderPanel({ store, pickFolder: async () => WIDGETS_PATH });

    await click(addButton());

    expect(add).not.toHaveBeenCalled();
    expect(error()).toBe("No termx-plugin.json found in that folder.");
  });

  it("explains a malformed manifest by field", async () => {
    const store = storeWith({});
    const add = vi.spyOn(store, "add");
    await renderPanel({
      store,
      native: fakeNative({ [WIDGETS_PATH]: manifestText({ icon: 42 }) }),
      pickFolder: async () => WIDGETS_PATH,
    });

    await click(addButton());

    expect(add).not.toHaveBeenCalled();
    expect(error()).toBe("Manifest invalid: icon");
  });

  it("refuses an id that is already installed", async () => {
    const store = storeWith({
      widgets: { path: "D:\\old\\widgets", enabled: true, grants: [] },
    });
    const add = vi.spyOn(store, "add");
    await renderPanel({
      store,
      native: fakeNative({
        "D:\\old\\widgets": manifestText(),
        [WIDGETS_PATH]: manifestText(),
      }),
      pickFolder: async () => WIDGETS_PATH,
    });

    await click(addButton());

    expect(add).not.toHaveBeenCalled();
    expect(error()).toBe("That plugin id is already installed.");
    expect(store.getSnapshot().plugins.widgets!.path).toBe("D:\\old\\widgets");
  });

  it("reads the manifest for the id, not the folder's name", async () => {
    // The folder is `my-widgets`; the manifest says `widgets`. If the panel
    // ever fell back to the basename this would install under the wrong key.
    const store = storeWith({});
    const add = vi.spyOn(store, "add");
    const renamed = "D:\\plugins\\my-widgets";
    await renderPanel({
      store,
      native: fakeNative({ [renamed]: manifestText() }),
      pickFolder: async () => renamed,
    });

    await click(addButton());

    expect(add).toHaveBeenCalledWith("widgets", renamed);
    expect(error()).toBe("");
  });

  it("says so when the folder cannot be read at all", async () => {
    const store = storeWith({});
    const add = vi.spyOn(store, "add");
    const native = fakeNative();
    native.readManifest = vi.fn().mockRejectedValue(new Error("EACCES"));
    await renderPanel({ store, native, pickFolder: async () => WIDGETS_PATH });

    await click(addButton());

    expect(add).not.toHaveBeenCalled();
    // Never the raw errno — unreadable is a different fact from unmanifested.
    expect(error()).toBe("That folder could not be read.");
  });

  it("says so when the folder picker itself fails to open", async () => {
    // A rejected picker used to escape as an unhandled rejection: the click
    // did nothing and the panel said nothing.
    const store = storeWith({});
    const add = vi.spyOn(store, "add");
    await renderPanel({
      store,
      pickFolder: async () => {
        throw new Error("dialog plugin not initialised");
      },
    });

    await click(addButton());

    expect(add).not.toHaveBeenCalled();
    expect(error()).toBe("The folder picker could not be opened.");
  });

  it("recovers from a failed picker on the next click", async () => {
    // The guard has to be released even when the picker throws, or the button
    // is dead for the rest of the session.
    const store = storeWith({});
    const add = vi.spyOn(store, "add");
    let fail = true;
    await renderPanel({
      store,
      pickFolder: async () => {
        if (fail) {
          throw new Error("dialog plugin not initialised");
        }
        return SHOWROOM_PATH;
      },
    });

    await click(addButton());
    fail = false;
    await click(addButton());

    expect(add).toHaveBeenCalledWith("showroom", SHOWROOM_PATH);
    expect(error()).toBe("");
  });

  it("reads a folder's own name past a trailing separator and case", async () => {
    // The registry stores the path the user picked, verbatim; the only place
    // the panel interprets one is this bundled-by-folder-name fallback, and it
    // must not care how the picker spelled it.
    const store = storeWith({});
    const add = vi.spyOn(store, "add");
    const spelled = "C:\\code\\Showroom\\";
    await renderPanel({ store, pickFolder: async () => spelled });

    await click(addButton());

    expect(add).toHaveBeenCalledWith("showroom", spelled);
    expect(error()).toBe("");
  });

  it("reads a UNC folder's own name the same way", async () => {
    const store = storeWith({});
    const add = vi.spyOn(store, "add");
    const unc = "\\\\fileserver01\\team-share\\showroom";
    await renderPanel({ store, pickFolder: async () => unc });

    await click(addButton());

    expect(add).toHaveBeenCalledWith("showroom", unc);
  });

  it("treats a cancelled picker as nothing happening", async () => {
    const store = storeWith({});
    const add = vi.spyOn(store, "add");
    await renderPanel({ store, pickFolder: async () => null });

    await click(addButton());

    expect(add).not.toHaveBeenCalled();
    expect(error()).toBe("");
  });

  it("clears a previous error on the next successful add", async () => {
    const store = storeWith({});
    let picked = WIDGETS_PATH;
    await renderPanel({
      store,
      native: fakeNative({ [SHOWROOM_PATH]: manifestText({ id: "showroom" }) }),
      pickFolder: async () => picked,
    });

    await click(addButton());
    expect(error()).toBe("No termx-plugin.json found in that folder.");

    picked = SHOWROOM_PATH;
    await click(addButton());
    expect(error()).toBe("");
  });
});

describe("PluginsPanel row-scoped folder actions", () => {
  function error(): string {
    return text(container.querySelector(".settings-plugins__error"));
  }

  it("repoints a bundled plugin at a new folder", async () => {
    // Showroom has no Remove, so without this a wrong path can only be fixed
    // by hand-editing plugins_v1.json.
    const store = storeWith({
      showroom: { path: "C:\\old\\showroom", enabled: true, grants: [] },
    });
    const add = vi.spyOn(store, "add");
    await renderPanel({ store, pickFolder: async () => SHOWROOM_PATH });

    await click(action("showroom", "Change folder…")!);

    expect(add).toHaveBeenCalledWith("showroom", SHOWROOM_PATH);
    expect(store.getSnapshot().plugins.showroom!.path).toBe(SHOWROOM_PATH);
    expect(error()).toBe("");
  });

  it("offers no Change folder on a plugin that can just be removed", async () => {
    await renderPanel({
      store: storeWith({
        widgets: { path: WIDGETS_PATH, enabled: true, grants: [] },
      }),
      native: fakeNative({ [WIDGETS_PATH]: manifestText() }),
    });

    expect(action("widgets", "Change folder…")).toBeNull();
    expect(removeButton("widgets")).not.toBeNull();
  });

  it("refuses a folder that holds a different plugin than the row", async () => {
    const store = storeWith({});
    const add = vi.spyOn(store, "add");
    await renderPanel({
      store,
      native: fakeNative({ [WIDGETS_PATH]: manifestText() }),
      pickFolder: async () => WIDGETS_PATH,
    });

    // Showroom's own row, pointed at the widgets folder: installing widgets
    // here would leave Showroom still empty and say nothing about it.
    await click(action("showroom", "Add folder…")!);

    expect(add).not.toHaveBeenCalled();
    expect(error()).toBe("That folder holds widgets, not showroom.");
  });

  it("accepts the right folder from a row's own button", async () => {
    const store = storeWith({});
    const add = vi.spyOn(store, "add");
    await renderPanel({ store, pickFolder: async () => SHOWROOM_PATH });

    await click(action("showroom", "Add folder…")!);

    expect(add).toHaveBeenCalledWith("showroom", SHOWROOM_PATH);
    expect(error()).toBe("");
  });

  it("runs one picker even when the button is clicked twice in a frame", async () => {
    const store = storeWith({});
    const add = vi.spyOn(store, "add");
    let picks = 0;
    await renderPanel({
      store,
      native: fakeNative({ [WIDGETS_PATH]: manifestText() }),
      pickFolder: async () => {
        picks += 1;
        return WIDGETS_PATH;
      },
    });

    const button = container.querySelector<HTMLButtonElement>(
      "[data-testid='plugins-add']",
    )!;
    // Both clicks land before React can repaint the disabled state, so the
    // `picking` state alone would let two pickers through.
    await act(async () => {
      button.click();
      button.click();
    });

    expect(picks).toBe(1);
    expect(add).toHaveBeenCalledTimes(1);
  });
});

describe("PluginsPanel late folder reads", () => {
  /**
   * A `readManifest` whose promises settle only when the test says so, and
   * per folder — the discriminating tests need to answer an OLD read while a
   * newer one for a different folder is still outstanding.
   */
  function queuedNative(): {
    native: PluginNative;
    settle(folder: string, value: string | null): Promise<void>;
  } {
    const waiting: { folder: string; resolve(value: string | null): void }[] =
      [];
    const native = fakeNative();
    native.readManifest = vi.fn(
      (folder: string) =>
        new Promise<string | null>((resolve) => {
          waiting.push({ folder, resolve });
        }),
    );
    return {
      native,
      settle: async (folder, value) => {
        // Snapshot the matches BEFORE resolving: settling one read re-runs the
        // effect, which queues the next one, and that must not be settled here.
        const matched = waiting.filter((entry) => entry.folder === folder);
        for (const entry of matched) {
          waiting.splice(waiting.indexOf(entry), 1);
        }
        await act(async () => {
          for (const entry of matched) {
            entry.resolve(value);
          }
        });
      },
    };
  }

  it("does not show a stale payload to the panel that replaces it", async () => {
    const store = storeWith({
      widgets: { path: WIDGETS_PATH, enabled: true, grants: [] },
    });
    const { native, settle } = queuedNative();
    await renderPanel({ store, native });

    // Settings closes with the read still outstanding, and the disk answers
    // afterwards with what the folder used to hold.
    await act(async () => root.unmount());
    await settle(WIDGETS_PATH, manifestText({ name: "Stale Widgets" }));

    // Reopened: the folder now holds something else, and that is what must
    // show. A leaked cache or a write from the dead read would say otherwise.
    root = createRoot(container);
    await renderPanel({
      store,
      native: fakeNative({
        [WIDGETS_PATH]: manifestText({ name: "Fresh Widgets" }),
      }),
    });

    expect(text(row("widgets").querySelector(".settings-plugin__label"))).toBe(
      "Fresh Widgets",
    );
  });

  it("lets the new folder's manifest win when an old read lands late", async () => {
    const OLD_PATH = "C:\old\showroom";
    const store = storeWith({
      showroom: { path: OLD_PATH, enabled: true, grants: [] },
    });
    const { native, settle } = queuedNative();
    await renderPanel({ store, native, pickFolder: async () => SHOWROOM_PATH });

    // Repoint while the read of the OLD folder is still outstanding. The add
    // path reads the picked folder itself, so answer that one to let it land.
    await click(action("showroom", "Change folder…")!);
    await settle(
      SHOWROOM_PATH,
      manifestText({ id: "showroom", name: "New Showroom" }),
    );
    expect(store.getSnapshot().plugins.showroom!.path).toBe(SHOWROOM_PATH);

    // Now the abandoned read answers. It describes a folder this row no longer
    // points at, so it must not reach the screen.
    await settle(
      OLD_PATH,
      manifestText({ id: "showroom", name: "Old Showroom" }),
    );
    expect(
      text(row("showroom").querySelector(".settings-plugin__label")),
    ).not.toBe("Old Showroom");

    // And the read the effect issued for the NEW folder is the one that lands.
    await settle(
      SHOWROOM_PATH,
      manifestText({ id: "showroom", name: "New Showroom" }),
    );
    expect(text(row("showroom").querySelector(".settings-plugin__label"))).toBe(
      "New Showroom",
    );
  });
});

describe("PluginsPanel inside the real Settings surface", () => {
  /**
   * The armed-Remove Esc rule can only be proved with the surface actually
   * mounted: both Esc handlers are window-capture listeners, and the panel's
   * registers SECOND because it mounts when this test navigates to the
   * Plugins section — long after the surface registered. A panel-only test
   * would pass on ordering that does not exist in the app.
   */
  async function openPluginsSection(
    store: PluginsStore,
    onClose: () => void,
  ): Promise<void> {
    await act(async () => {
      root.render(
        <SettingsSurface
          store={new SettingsStore({ save: () => Promise.resolve() })}
          onClose={onClose}
          plugins={{
            store,
            native: fakeNative({ [WIDGETS_PATH]: manifestText() }),
          }}
        />,
      );
    });
    const tab = container.querySelector<HTMLButtonElement>(
      ".settings-surface__tab[data-section='plugins']",
    )!;
    await act(async () => {
      tab.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await act(async () => undefined);
  }

  async function pressEscape(target: HTMLElement): Promise<void> {
    await act(async () => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }

  it("gives Escape to an armed Remove before it closes Settings", async () => {
    const onClose = vi.fn();
    const store = storeWith({
      widgets: { path: WIDGETS_PATH, enabled: true, grants: [] },
    });
    const remove = vi.spyOn(store, "remove");
    await openPluginsSection(store, onClose);

    const button = removeButton("widgets")!;
    // A real click focuses the button it hits; that focus is what marks the
    // armed control as the owner of the key.
    button.focus();
    await click(button);
    expect(button.textContent).toBe("Confirm remove");

    await pressEscape(removeButton("widgets")!);

    // Disarmed, and Settings is still open — losing the whole surface because
    // you backed out of one button would be the worse of the two outcomes.
    expect(removeButton("widgets")!.textContent).toBe("Remove");
    expect(remove).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes Settings on the next Escape once nothing is armed", async () => {
    const onClose = vi.fn();
    const store = storeWith({
      widgets: { path: WIDGETS_PATH, enabled: true, grants: [] },
    });
    await openPluginsSection(store, onClose);

    const button = removeButton("widgets")!;
    button.focus();
    await click(button);
    await pressEscape(removeButton("widgets")!);
    expect(onClose).not.toHaveBeenCalled();

    // The guard is gone with the armed state, so Esc means what it always
    // means again.
    await pressEscape(removeButton("widgets")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes Settings on Escape when no Remove is armed at all", async () => {
    const onClose = vi.fn();
    await openPluginsSection(
      storeWith({
        widgets: { path: WIDGETS_PATH, enabled: true, grants: [] },
      }),
      onClose,
    );

    const button = removeButton("widgets")!;
    button.focus();
    await pressEscape(button);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("PluginsPanel empty state", () => {
  it("says there are no plugins when nothing is installed or bundled", async () => {
    await renderPanel({ store: storeWith({}), bundled: {} });

    expect(rowIds()).toEqual([]);
    const empty = container.querySelector(".settings-plugins__empty")!;
    // Authored in sentence case; the overline rule renders it NO PLUGINS, the
    // way every other section heading in the app is written.
    expect(text(empty.querySelector(".settings-plugins__empty-title"))).toBe(
      "No plugins",
    );
    // The way out of the empty state stays on screen.
    expect(
      container.querySelector("[data-testid='plugins-add']"),
    ).not.toBeNull();
  });
});
