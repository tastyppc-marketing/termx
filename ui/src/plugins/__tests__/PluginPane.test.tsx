/**
 * The plugin pane's three faces (plugin spec §4, P1 T6).
 *
 * A panel is not a terminal: it has no session, no exit code and no scrollback,
 * so its liveness is the health probe's answer and nothing else. These tests
 * pin what each answer looks like — and, load-bearing, that the iframe carries
 * NO `sandbox` attribute: Showroom serves its own scripts and storage from the
 * loopback origin, and a sandbox would break both. The CSP `frame-src` is the
 * boundary instead (see `src/__tests__/csp.test.ts`).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneSessionState } from "../../workspace/WorkspaceController";
import { PluginPane } from "../PluginPane";

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

function pluginState(overrides: Partial<PaneSessionState> = {}): PaneSessionState {
  return {
    status: "plugin",
    exitCode: null,
    pluginId: "showroom",
    pluginUrl: "http://127.0.0.1:7345",
    pluginHealth: "up",
    ...overrides,
  };
}

async function renderPane(options: {
  state?: PaneSessionState;
  panelPath?: string;
  onRelaunch?: () => void;
  onDismiss?: () => void;
  minSize?: { width: number; height: number };
} = {}) {
  await act(async () =>
    root.render(
      <PluginPane
        state={options.state ?? pluginState()}
        name="Showroom"
        icon="🖼"
        panelPath={options.panelPath ?? "/"}
        minSize={options.minSize ?? { width: 360, height: 240 }}
        onRelaunch={options.onRelaunch ?? (() => undefined)}
        onDismiss={options.onDismiss ?? (() => undefined)}
      />,
    ),
  );
}

function frame(): HTMLIFrameElement | null {
  return container.querySelector<HTMLIFrameElement>("iframe.plugin-pane__frame");
}

describe("plugin pane title bar", () => {
  it("names the panel the way a terminal pane names its shell, plus a health mark", async () => {
    await renderPane();

    const title = container.querySelector(".split-pane__title");
    expect(title).not.toBeNull();
    expect(title?.className).toContain("plugin-pane__title");
    expect(title?.querySelector(".plugin-pane__icon")?.textContent).toBe("🖼");
    expect(title?.querySelector(".plugin-pane__name")?.textContent).toBe("Showroom");
    expect(title?.getAttribute("title")).toBe("Showroom");
  });

  it("marks the health state on the bar, so a split says which panel died", async () => {
    await renderPane();
    expect(container.querySelector(".plugin-pane__health--up")).not.toBeNull();

    await renderPane({ state: pluginState({ pluginHealth: "down", pluginUrl: null }) });
    expect(container.querySelector(".plugin-pane__health--down")).not.toBeNull();

    await renderPane({ state: pluginState({ pluginHealth: "starting", pluginUrl: null }) });
    expect(container.querySelector(".plugin-pane__health--starting")).not.toBeNull();
  });
});

describe("plugin pane — up", () => {
  it("frames the panel at its exact origin + panel path", async () => {
    await renderPane({ panelPath: "/panel" });

    expect(frame()?.getAttribute("src")).toBe("http://127.0.0.1:7345/panel");
    expect(frame()?.getAttribute("title")).toBe("Showroom");
    // The panel is a local page, not a referrer target.
    expect(frame()?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it(
    "delegates clipboard-write and nothing else — the panel is cross-origin " +
      "to the app, so without the grant a copy button fails silently; " +
      "clipboard-READ, camera, microphone and geolocation stay denied",
    async () => {
      await renderPane();

      const allow = frame()?.getAttribute("allow");
      expect(allow).toBe("clipboard-write");
      for (const denied of ["clipboard-read", "camera", "microphone", "geolocation"]) {
        expect(allow).not.toContain(denied);
      }
    },
  );

  it("frames localhost as readily as the dotted-quad loopback", async () => {
    await renderPane({ state: pluginState({ pluginUrl: "http://localhost:7345" }) });

    expect(frame()?.getAttribute("src")).toBe("http://localhost:7345/");
  });

  it("reads the scheme and host case-insensitively, and normalises them", async () => {
    await renderPane({ state: pluginState({ pluginUrl: "HTTP://LOCALHOST:7345" }) });

    expect(frame()?.getAttribute("src")).toBe("http://localhost:7345/");
  });

  it("keeps a panel path's query string intact", async () => {
    await renderPane({ panelPath: "/panel?x=1" });

    expect(frame()?.getAttribute("src")).toBe("http://127.0.0.1:7345/panel?x=1");
  });

  it(
    "carries NO sandbox attribute — Showroom's own scripts and storage are " +
      "same-origin, and the CSP frame-src is what bounds the panel",
    async () => {
      await renderPane();

      expect(frame()).not.toBeNull();
      expect(frame()?.hasAttribute("sandbox")).toBe(false);
    },
  );

  it("shows neither waiting card nor offline card while it is up", async () => {
    await renderPane();

    expect(container.querySelector(".plugin-pane__wait")).toBeNull();
    expect(container.querySelector(".plugin-pane__card")).toBeNull();
  });
});

describe("plugin pane — origin refusal", () => {
  /** Anything that is not this machine's loopback. */
  const FOREIGN = [
    "http://192.168.1.10:7345",
    "https://showroom.example.com",
    "http://127.0.0.1.evil.test:7345",
    "http://127.0.0.1:7345@evil.test",
  ];

  it.each(FOREIGN)("refuses to frame %s, and says so", async (url) => {
    await renderPane({ state: pluginState({ pluginUrl: url }) });

    expect(frame()).toBeNull();
    expect(container.querySelector(".plugin-pane__reason")?.textContent)
      .toBe("The plugin reported a non-local address.");
    // It is an offline card, not a wait: nothing is coming.
    expect(container.querySelector(".plugin-pane__relaunch")).not.toBeNull();
    expect(container.querySelector(".plugin-pane__wait")).toBeNull();
  });

  /**
   * The origin is only half the address. A panel PATH that escapes its origin
   * is the same bug wearing the manifest's clothes — and `panel.path` is
   * checked for a leading "/" by the manifest parser and nothing else, so
   * `//evil.com/` passes that check today.
   */
  const ESCAPING_PATHS = [
    // Not rooted: string concatenation put this in the URL's USERINFO slot, so
    // `http://127.0.0.1:7345` + `@evil.com/` parsed to host `evil.com`
    // (verified against the WHATWG parser, not assumed).
    "@evil.com/",
    // Rooted, so the manifest parser accepts it, but protocol-relative: it
    // resolves to another host entirely.
    "//evil.com/",
    "//evil.com/panel",
    // Same escape wearing a backslash — the WHATWG parser folds `\` to `/` for
    // special schemes, so this reaches evil.com too.
    "/\\evil.com/",
    // Absolute: a path that is really a whole URL replaces the base outright.
    "https://evil.com/",
  ];

  it.each(ESCAPING_PATHS)("refuses a panel path of %s", async (panelPath) => {
    await renderPane({ panelPath });

    expect(frame()).toBeNull();
    expect(container.querySelector(".plugin-pane__reason")?.textContent)
      .toBe("The plugin reported a non-local address.");
  });
});

describe("plugin pane — state changes", () => {
  it(
    "unmounts the frame when the plugin goes down and builds a NEW one when " +
      "it comes back, so a dead panel cannot keep running in a hidden frame",
    async () => {
      await renderPane();
      const first = frame();
      expect(first).not.toBeNull();

      await renderPane({ state: pluginState({ pluginHealth: "down", pluginUrl: null }) });
      expect(frame()).toBeNull();
      expect(first?.isConnected).toBe(false);
      expect(container.querySelector(".plugin-pane__relaunch")).not.toBeNull();

      await renderPane();
      const third = frame();
      expect(third).not.toBeNull();
      expect(third).not.toBe(first);
    },
  );
});

describe("plugin pane — starting", () => {
  it("says which plugin is starting, and frames nothing yet", async () => {
    await renderPane({ state: pluginState({ pluginHealth: "starting", pluginUrl: null }) });

    expect(container.querySelector(".plugin-pane__wait")).not.toBeNull();
    expect(container.querySelector(".plugin-pane__overline")?.textContent)
      .toBe("Starting Showroom…");
    expect(frame()).toBeNull();
  });

  it("waits rather than framing a null origin, whatever the health says", async () => {
    await renderPane({ state: pluginState({ pluginUrl: null }) });

    expect(frame()).toBeNull();
    expect(container.querySelector(".plugin-pane__wait")).not.toBeNull();
  });
});

describe("plugin pane — down", () => {
  const DOWN = pluginState({
    pluginHealth: "down",
    pluginUrl: null,
    pluginError: "health probe never passed\nError: listen EADDRINUSE :::7345\n  at Server.setup",
  });

  it("reads as an empty state: what died, why, and what it printed", async () => {
    await renderPane({ state: DOWN });

    expect(container.querySelector(".plugin-pane__overline")?.textContent)
      .toBe("Plugin offline");
    expect(container.querySelector(".plugin-pane__name-large")?.textContent)
      .toBe("Showroom");
    // The reason is one line; the whole thing stays available on hover.
    const reason = container.querySelector(".plugin-pane__reason");
    expect(reason?.textContent).toBe("health probe never passed");
    expect(frame()).toBeNull();
  });

  it("keeps the stderr tail in a scrollable block instead of widening the pane", async () => {
    await renderPane({ state: DOWN });

    const stderr = container.querySelector(".plugin-pane__stderr");
    expect(stderr).not.toBeNull();
    expect(stderr?.textContent).toContain("EADDRINUSE");
    expect(stderr?.textContent).not.toContain("health probe never passed");
    // Focusable so the block can be scrolled from the keyboard too.
    expect(stderr?.getAttribute("tabindex")).toBe("0");
  });

  it("draws no stderr block when the plugin printed nothing", async () => {
    await renderPane({
      state: pluginState({
        pluginHealth: "down",
        pluginUrl: null,
        pluginError: "spawn node ENOENT",
      }),
    });

    expect(container.querySelector(".plugin-pane__reason")?.textContent)
      .toBe("spawn node ENOENT");
    expect(container.querySelector(".plugin-pane__stderr")).toBeNull();
  });

  it("still explains itself when ensure-up reported no reason at all", async () => {
    await renderPane({ state: pluginState({ pluginHealth: "down", pluginUrl: null }) });

    expect(container.querySelector(".plugin-pane__reason")?.textContent)
      .toBe("The panel is not answering on its loopback port.");
  });

  it("offers Relaunch and Dismiss, and calls exactly the one clicked", async () => {
    const onRelaunch = vi.fn();
    const onDismiss = vi.fn();
    await renderPane({ state: DOWN, onRelaunch, onDismiss });

    const relaunch = container.querySelector<HTMLButtonElement>(".plugin-pane__relaunch");
    const dismiss = container.querySelector<HTMLButtonElement>(".plugin-pane__dismiss");
    expect(relaunch?.textContent).toBe("Relaunch");
    expect(relaunch?.className).toContain("plugin-pane__action--primary");
    expect(dismiss?.textContent).toBe("Dismiss");

    await act(async () => relaunch?.click());
    expect(onRelaunch).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();

    await act(async () => dismiss?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onRelaunch).toHaveBeenCalledTimes(1);
  });
});

/**
 * `data-compact` (menubar spec): TermX never resizes a pane below the plugin's
 * `minSize` on its behalf - it says so, and the panel restacks itself. The
 * attribute is the whole contract, so which value appears when is load-bearing
 * for every plugin's `[data-compact]` stylesheet.
 */
describe("plugin pane compact hint", () => {
  /**
   * jsdom lays nothing out, so both halves are stubbed: the box the pane
   * reports, and the observer that would tell React it changed.
   */
  let notify: (() => void) | null = null;

  function stubLayout(width: number, height: number): void {
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement) {
        return this.classList.contains("plugin-pane")
          ? { width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0 }
          : { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
      },
    });
  }

  beforeEach(() => {
    notify = null;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe(): void {}
      disconnect(): void {
        notify = null;
      }
    };
  });

  afterEach(() => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    delete (HTMLElement.prototype as { getBoundingClientRect?: unknown })
      .getBoundingClientRect;
  });

  function pane(): HTMLElement {
    return container.querySelector<HTMLElement>(".plugin-pane")!;
  }

  it("says nothing about a pane with room to spare", async () => {
    stubLayout(800, 600);
    await renderPane();

    expect(pane().hasAttribute("data-compact")).toBe(false);
  });

  it("marks a pane that is only too narrow", async () => {
    stubLayout(300, 600);
    await renderPane();

    expect(pane().getAttribute("data-compact")).toBe("width");
  });

  it("marks a pane that is only too short", async () => {
    stubLayout(800, 180);
    await renderPane();

    expect(pane().getAttribute("data-compact")).toBe("height");
  });

  it("marks a pane that is short of both", async () => {
    stubLayout(300, 180);
    await renderPane();

    expect(pane().getAttribute("data-compact")).toBe("both");
  });

  it("clears the mark when the pane grows back", async () => {
    stubLayout(300, 180);
    await renderPane();
    expect(pane().getAttribute("data-compact")).toBe("both");

    stubLayout(800, 600);
    await act(async () => notify?.());

    expect(pane().hasAttribute("data-compact")).toBe(false);
  });

  it("re-marks the pane when it shrinks again", async () => {
    stubLayout(800, 600);
    await renderPane();

    stubLayout(800, 180);
    await act(async () => notify?.());

    expect(pane().getAttribute("data-compact")).toBe("height");
  });

  it("says nothing about a pane with no box yet", async () => {
    // A hidden tab and a first paint both measure zero. Calling that compact
    // would have every panel restack itself the moment it mounts.
    stubLayout(0, 0);
    await renderPane();

    expect(pane().hasAttribute("data-compact")).toBe(false);
  });

  it("follows the plugin's own floor, not a fixed one", async () => {
    stubLayout(340, 600);
    await renderPane({ minSize: { width: 320, height: 200 } });

    expect(pane().hasAttribute("data-compact")).toBe(false);
  });

  it("marks the offline card too, which has to restack like the panel", async () => {
    stubLayout(300, 180);
    await renderPane({ state: pluginState({ pluginHealth: "down", pluginUrl: null }) });

    expect(pane().getAttribute("data-compact")).toBe("both");
  });
});
