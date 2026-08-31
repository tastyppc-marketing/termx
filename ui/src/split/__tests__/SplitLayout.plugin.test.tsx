/**
 * Plugin panes in the split renderer (plugin spec §4, P1 T6).
 *
 * A plugin pane is a THIRD sibling inside the ordinary `.split-pane` section,
 * not a wrapper around it: it shares the pane chrome, the focus ring and the
 * close button with terminal panes, and differs only in what fills the middle.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "../../plugins/manifest";
import { PLUGIN_PANE_MIN_ID } from "../../plugins/paneBindings";
import type { SplitNode } from "../../state/layout";
import type { PaneHostClient } from "../../terminal/TerminalPane";
import type { PaneSessionState } from "../../workspace/WorkspaceController";
import { SplitLayout, type SplitLayoutActions } from "../SplitLayout";

vi.mock("../../terminal/TerminalPane", () => ({
  TerminalPane: ({ sessionId }: { sessionId: number }) => (
    <div data-testid={`terminal-${sessionId}`} />
  ),
}));

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

const PANEL_ID = PLUGIN_PANE_MIN_ID + 1;

const TREE: SplitNode = {
  kind: "split",
  dir: "row",
  sizes: [0.5, 0.5],
  children: [
    { kind: "pane", sessionId: 1 },
    { kind: "pane", sessionId: PANEL_ID },
  ],
};

const SHOWROOM: PluginManifest = {
  manifest: 1,
  id: "showroom",
  name: "Showroom",
  icon: "🖼",
  start: { command: "node", args: ["server/showroom.js"] },
  singleton: true,
  discovery: { runtimeFile: "%APPDATA%\\Showroom\\runtime.json", healthPath: "/api/health" },
  panel: { path: "/" },
};

function actions(overrides: Partial<SplitLayoutActions> = {}): SplitLayoutActions {
  return {
    splitPane: vi.fn(),
    closePane: vi.fn(async () => undefined),
    dismissPane: vi.fn(async () => undefined),
    restartPane: vi.fn(async () => undefined),
    resizePane: vi.fn(),
    ...overrides,
  };
}

async function renderLayout(options: {
  panel?: Partial<PaneSessionState>;
  /** Replaces the reserved pane's state outright (for the no-binding case). */
  panelState?: PaneSessionState;
  actions?: SplitLayoutActions;
  manifests?: Record<string, PluginManifest> | null;
}) {
  const manifests = options.manifests === undefined ? { showroom: SHOWROOM } : options.manifests;
  await act(async () =>
    root.render(
      <SplitLayout
        tabId="tab-1"
        root={TREE}
        client={{} as PaneHostClient}
        paneStates={{
          1: { status: "live", exitCode: null },
          [PANEL_ID]: options.panelState ?? {
            status: "plugin",
            exitCode: null,
            pluginId: "showroom",
            pluginUrl: "http://127.0.0.1:7345",
            pluginHealth: "up",
            ...options.panel,
          },
        }}
        focusedSessionId={1}
        dismissingSessionIds={new Set()}
        onFocusPane={() => undefined}
        actions={options.actions ?? actions()}
        {...(manifests
          ? { pluginManifestFor: (id: string) => manifests[id] ?? null }
          : {})}
      />,
    ),
  );
}

function panel(): Element | null {
  return container.querySelector(`[data-testid='split-pane-${PANEL_ID}']`);
}

describe("plugin panes in the split layout", () => {
  it("frames the panel inside the ordinary pane section, with its own title bar", async () => {
    await renderLayout({});

    const iframe = panel()?.querySelector("iframe.plugin-pane__frame");
    expect(iframe?.getAttribute("src")).toBe("http://127.0.0.1:7345/");
    expect(panel()?.querySelector(".plugin-pane__name")?.textContent).toBe("Showroom");
    // No session behind it, so no terminal is ever attached here.
    expect(panel()?.querySelector(`[data-testid='terminal-${PANEL_ID}']`)).toBeNull();
    expect(panel()?.querySelector(".dead-pane")).toBeNull();
    // The terminal beside it is untouched.
    expect(container.querySelector("[data-testid='terminal-1']")).not.toBeNull();
  });

  it("keeps the panel body a direct child of the pane, so the title bar keeps its row", async () => {
    await renderLayout({});

    expect(panel()?.querySelector(":scope > .split-pane__title")).not.toBeNull();
    expect(panel()?.querySelector(":scope > .plugin-pane")).not.toBeNull();
  });

  it("routes Relaunch to relaunchPlugin, NOT to restartPane", async () => {
    const layoutActions = actions({ relaunchPlugin: vi.fn(async () => undefined) });
    await renderLayout({
      panel: { pluginHealth: "down", pluginUrl: null, pluginError: "health probe never passed" },
      actions: layoutActions,
    });

    await act(async () =>
      panel()?.querySelector<HTMLButtonElement>(".plugin-pane__relaunch")?.click()
    );

    expect(layoutActions.relaunchPlugin).toHaveBeenCalledWith(PANEL_ID);
    // restartPane would create a host session and swap the pane's reserved id
    // out of the layout — the binding, and the panel, would be gone.
    expect(layoutActions.restartPane).not.toHaveBeenCalled();
  });

  it("dismisses the pane from the offline card without touching the daemon", async () => {
    const layoutActions = actions();
    await renderLayout({
      panel: { pluginHealth: "down", pluginUrl: null },
      actions: layoutActions,
    });

    await act(async () =>
      panel()?.querySelector<HTMLButtonElement>(".plugin-pane__dismiss")?.click()
    );

    expect(layoutActions.dismissPane).toHaveBeenCalledWith(PANEL_ID);
    expect(layoutActions.closePane).not.toHaveBeenCalled();
  });

  it("closes a live panel by dismissing it, with no 'end its shell?' dialog", async () => {
    const layoutActions = actions();
    await renderLayout({ actions: layoutActions });

    await act(async () =>
      panel()?.querySelector<HTMLButtonElement>("button[aria-label='Close pane']")?.click()
    );

    expect(container.querySelector(".split-dialog")).toBeNull();
    expect(layoutActions.dismissPane).toHaveBeenCalledWith(PANEL_ID);
  });

  it(
    "still renders a PANEL when the manifest cannot be resolved — a bound " +
      "reserved id must never be offered Restart / Resume / New session, " +
      "because restartPane creates a host session and swaps the reserved id " +
      "out of the layout, destroying the binding (spec §4)",
    async () => {
      const layoutActions = actions();
      await renderLayout({ manifests: null, actions: layoutActions });

      expect(panel()?.querySelector(".plugin-pane")).not.toBeNull();
      expect(panel()?.querySelector(".dead-pane")).toBeNull();
      // Named by the only identity that survives a missing manifest.
      expect(panel()?.querySelector(".plugin-pane__name")?.textContent).toBe("showroom");
      const labels = [...panel()!.querySelectorAll("button")].map((button) => button.textContent);
      expect(labels).not.toContain("Restart session");
      expect(labels).not.toContain("New session");
      expect(labels).not.toContain("Resume conversation");
      expect(layoutActions.restartPane).not.toHaveBeenCalled();
    },
  );

  it("offers Relaunch and Dismiss even with no manifest, and they still work", async () => {
    const layoutActions = actions({ relaunchPlugin: vi.fn(async () => undefined) });
    await renderLayout({
      manifests: null,
      panel: { pluginHealth: "down", pluginUrl: null },
      actions: layoutActions,
    });

    await act(async () =>
      panel()?.querySelector<HTMLButtonElement>(".plugin-pane__relaunch")?.click()
    );
    await act(async () =>
      panel()?.querySelector<HTMLButtonElement>(".plugin-pane__dismiss")?.click()
    );

    expect(layoutActions.relaunchPlugin).toHaveBeenCalledWith(PANEL_ID);
    expect(layoutActions.dismissPane).toHaveBeenCalledWith(PANEL_ID);
    expect(layoutActions.restartPane).not.toHaveBeenCalled();
  });

  it("keeps DeadPane for panes that really are dead, not for panels", async () => {
    await renderLayout({});

    const terminal = container.querySelector("[data-testid='split-pane-1']");
    expect(terminal?.querySelector(".plugin-pane")).toBeNull();
    expect(panel()?.querySelector(".dead-pane")).toBeNull();
  });
});

/**
 * The other half of the reserved-id rule, and the reason the branch keys off
 * `status` rather than the id's numeric range: a reserved id WITHOUT a binding
 * is not a panel. That is what an older build leaves behind (it cannot read
 * `plugin_panes_v1.json`), and what a lost bindings file produces — the
 * controller projects it as "missing", and the only thing the user should be
 * offered is a way to make the empty rectangle go away.
 */
describe("a reserved pane with no binding", () => {
  const MISSING: PaneSessionState = { status: "missing", exitCode: null };

  it("renders the dead pane, not a panel", async () => {
    await renderLayout({ panelState: MISSING });

    expect(panel()?.querySelector(".dead-pane")).not.toBeNull();
    expect(panel()?.querySelector(".plugin-pane")).toBeNull();
    expect(panel()?.querySelector("iframe")).toBeNull();
    expect(panel()?.querySelector(".dead-pane__dismiss")).not.toBeNull();
  });

  it(
    "dismisses on Dismiss and nothing else — no restart of a reserved id, and " +
      "no CloseSession for a session the daemon never had",
    async () => {
      const layoutActions = actions({ relaunchPlugin: vi.fn(async () => undefined) });
      await renderLayout({ panelState: MISSING, actions: layoutActions });

      await act(async () =>
        panel()?.querySelector<HTMLButtonElement>(".dead-pane__dismiss")?.click()
      );

      expect(layoutActions.dismissPane).toHaveBeenCalledWith(PANEL_ID);
      expect(layoutActions.dismissPane).toHaveBeenCalledTimes(1);
      expect(layoutActions.restartPane).not.toHaveBeenCalled();
      expect(layoutActions.closePane).not.toHaveBeenCalled();
      expect(layoutActions.relaunchPlugin).not.toHaveBeenCalled();
      // Dismiss is direct: an empty rectangle needs no "end its shell?" prompt.
      expect(container.querySelector(".split-dialog")).toBeNull();
    },
  );
});
