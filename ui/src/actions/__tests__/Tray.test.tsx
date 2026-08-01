import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { DEFAULT_UI_STATE, type UiStateV1 } from "../../workspace/uiState";
import { registerAction, type TrayId } from "../registry";
import { Tray } from "../Tray";

type ConfigureMock = Mock<(trayId: TrayId, ids: readonly string[] | null) => void>;

let container: HTMLDivElement;
let root: Root;

const runSplit = vi.fn();
const runClose = vi.fn();

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  registerAction({ id: "split", icon: "⫲", label: "Split pane", run: runSplit });
  registerAction({ id: "close", icon: "✕", label: "Close pane", run: runClose });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function stateWith(ids: readonly string[]): UiStateV1 {
  return { ...DEFAULT_UI_STATE, trayChips: { "pane-toolbar": ids } };
}

async function renderTray(
  uiState: UiStateV1,
  onConfigure: ConfigureMock = vi.fn(),
): Promise<ConfigureMock> {
  await act(async () => root.render(
    <Tray
      trayId="pane-toolbar"
      context={{ paneId: "p1" }}
      uiState={uiState}
      onConfigure={onConfigure}
    />,
  ));
  return onConfigure;
}

function chips(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(".tray__chip"));
}

async function rightClick(button: HTMLElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 60 }),
    );
  });
}

describe("Tray", () => {
  it("renders one chip per configured id, in order, with icon and label", async () => {
    await renderTray(stateWith(["close", "split"]));

    const rendered = chips();
    expect(rendered.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Close pane",
      "Split pane",
    ]);
    expect(rendered.map((button) => button.textContent)).toEqual(["✕", "⫲"]);
    expect(
      container.querySelector("[role='toolbar']")?.getAttribute("aria-label"),
    ).toBe("Pane toolbar actions");
  });

  it("renders an empty toolbar for an unconfigured tray and drops unknown ids", async () => {
    await renderTray(DEFAULT_UI_STATE);
    expect(chips()).toHaveLength(0);

    await renderTray(stateWith(["ghost", "split"]));
    expect(chips().map((button) => button.getAttribute("aria-label"))).toEqual([
      "Split pane",
    ]);
  });

  it("runs the action with the tray context on click", async () => {
    await renderTray(stateWith(["split"]));
    await act(async () => {
      chips()[0]?.click();
    });
    expect(runSplit).toHaveBeenCalledWith({ paneId: "p1" });
    expect(runClose).not.toHaveBeenCalled();
  });

  it("right-click opens a menu whose Remove fires onConfigure minus that id", async () => {
    const onConfigure = await renderTray(stateWith(["close", "split"]));
    expect(container.querySelector("[role='menu']")).toBeNull();

    await rightClick(chips()[0]!);
    const menu = container.querySelector<HTMLElement>("[role='menu']");
    expect(menu).not.toBeNull();
    const items = Array.from(
      menu!.querySelectorAll<HTMLButtonElement>("[role='menuitem']"),
    );
    expect(items.map((item) => item.textContent)).toEqual(["Remove from tray"]);

    await act(async () => {
      items[0]?.click();
    });
    expect(onConfigure).toHaveBeenCalledTimes(1);
    expect(onConfigure).toHaveBeenCalledWith("pane-toolbar", ["split"]);
    expect(container.querySelector("[role='menu']")).toBeNull();
  });
});
