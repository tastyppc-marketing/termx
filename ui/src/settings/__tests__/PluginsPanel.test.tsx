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
import { PluginsPanel, shortenPath } from "../PluginsPanel";

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

  it("removes a folder plugin but never the bundled one", async () => {
    const store = storeWith({
      showroom: { path: SHOWROOM_PATH, enabled: true, grants: [] },
      widgets: { path: WIDGETS_PATH, enabled: true, grants: [] },
    });
    const remove = vi.spyOn(store, "remove");
    await renderPanel({
      store,
      native: fakeNative({ [WIDGETS_PATH]: manifestText() }),
    });

    // Showroom ships with TermX: its row is permanent, the toggle is the only
    // way to stand it down.
    expect(removeButton("showroom")).toBeNull();

    // Removal is two-step (see the confirm-in-place suite); the first click
    // only arms the button.
    await click(removeButton("widgets")!);
    await click(removeButton("widgets")!);
    expect(remove).toHaveBeenCalledWith("widgets");
    expect(rowIds()).toEqual(["showroom"]);
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
