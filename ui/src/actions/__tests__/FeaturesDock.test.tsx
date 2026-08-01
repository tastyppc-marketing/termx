import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { DEFAULT_UI_STATE, type UiStateV1 } from "../../workspace/uiState";
import { FeaturesDock } from "../FeaturesDock";
import { registerAction, type TrayId } from "../registry";

type ConfigureMock = Mock<(trayId: TrayId, ids: readonly string[] | null) => void>;
type CloseMock = Mock<() => void>;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  registerAction({ id: "settings", icon: "⚙", label: "Settings", run: vi.fn() });
  registerAction({ id: "search", icon: "⌕", label: "Folder search", run: vi.fn() });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

async function renderDock(options: {
  open?: boolean;
  uiState?: UiStateV1;
  onConfigure?: ConfigureMock;
  onClose?: CloseMock;
} = {}): Promise<{ onConfigure: ConfigureMock; onClose: CloseMock }> {
  const onConfigure: ConfigureMock = options.onConfigure ?? vi.fn();
  const onClose: CloseMock = options.onClose ?? vi.fn();
  await act(async () => root.render(
    <FeaturesDock
      open={options.open ?? true}
      onClose={onClose}
      uiState={options.uiState ?? DEFAULT_UI_STATE}
      onConfigure={onConfigure}
    />,
  ));
  return { onConfigure, onClose };
}

function buttonsLabelled(pattern: RegExp): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
    (button) => pattern.test(button.getAttribute("aria-label") ?? button.textContent ?? ""),
  );
}

function addButton(label: string, tray: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.getAttribute("aria-label")?.includes(`${label} to ${tray}`)
      || button.getAttribute("aria-label")?.includes(`${label} is already in ${tray}`));
  if (!found) {
    throw new Error(`no tray button for ${label} / ${tray}`);
  }
  return found;
}

describe("FeaturesDock", () => {
  it("renders nothing when closed", async () => {
    await renderDock({ open: false });
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });

  it("lists every registered action with an Add button per tray", async () => {
    await renderDock();

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>(".features-dock__row"),
    );
    expect(rows).toHaveLength(2);
    expect(
      rows.map((row) => row.querySelector(".features-dock__label")?.textContent),
    ).toEqual(["Settings", "Folder search"]);
    expect(
      rows.map((row) => row.querySelector(".features-dock__id")?.textContent),
    ).toEqual(["settings", "search"]);
    expect(buttonsLabelled(/^Add /)).toHaveLength(6); // 2 actions x 3 trays
  });

  it("adds an action to a tray, appending to the existing ids", async () => {
    const { onConfigure } = await renderDock({
      uiState: { ...DEFAULT_UI_STATE, trayChips: { "sidebar-footer": ["search"] } },
    });

    await act(async () => {
      addButton("Add Settings", "Sidebar footer").click();
    });
    expect(onConfigure).toHaveBeenCalledTimes(1);
    expect(onConfigure).toHaveBeenCalledWith("sidebar-footer", ["search", "settings"]);
  });

  it("marks an action already in a tray and treats a second add as a no-op", async () => {
    const { onConfigure } = await renderDock({
      uiState: { ...DEFAULT_UI_STATE, trayChips: { "viewer-header": ["settings"] } },
    });

    const button = addButton("Settings", "Viewer header");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.textContent).toBe("✓ In Viewer header");

    await act(async () => {
      button.click();
    });
    expect(onConfigure).not.toHaveBeenCalled();
  });

  it("Reset layout restores defaults for every tray via a null sentinel", async () => {
    const { onConfigure } = await renderDock({
      uiState: { ...DEFAULT_UI_STATE, trayChips: { "sidebar-footer": ["settings"] } },
    });

    const reset = container.querySelector<HTMLButtonElement>(".features-dock__reset");
    expect(reset?.textContent).toBe("Reset layout");
    await act(async () => {
      reset?.click();
    });
    expect(onConfigure.mock.calls).toEqual([
      ["sidebar-footer", null],
      ["pane-toolbar", null],
      ["viewer-header", null],
    ]);
  });

  it("takes focus, wraps Tab at the edges, and closes on Escape or Done", async () => {
    const { onClose } = await renderDock();

    const dialog = container.querySelector<HTMLElement>("[role='dialog']")!;
    expect(document.activeElement).toBe(dialog);

    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>("button"));
    focusables[focusables.length - 1]?.focus();
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(document.activeElement).toBe(focusables[0]);

    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);

    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
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
});
