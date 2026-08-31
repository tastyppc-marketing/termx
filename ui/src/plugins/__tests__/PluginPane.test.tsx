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
} = {}) {
  await act(async () =>
    root.render(
      <PluginPane
        state={options.state ?? pluginState()}
        name="Showroom"
        icon="🖼"
        panelPath={options.panelPath ?? "/"}
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
