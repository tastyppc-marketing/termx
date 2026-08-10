import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_IDS, THEMES } from "../../theme/themes";
import { SettingsDialog } from "../SettingsDialog";
import { DEFAULT_SETTINGS } from "../settings";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(ui: React.ReactElement): Promise<void> {
  await act(async () => root.render(ui));
}

describe("SettingsDialog", () => {
  it("reflects current settings and reports changes as patches", async () => {
    const onChange = vi.fn();
    await render(
      <SettingsDialog
        settings={DEFAULT_SETTINGS}
        onChange={onChange}
        onClose={() => undefined}
      />,
    );

    const groupActive = container.querySelector<HTMLInputElement>(
      "input[value='group-active']",
    );
    expect(groupActive?.checked).toBe(true);

    const askSearcher = container.querySelector<HTMLInputElement>(
      "input[value='ask-searcher']",
    );
    await act(async () => {
      askSearcher?.click();
    });
    expect(onChange).toHaveBeenCalledWith({ newTabPolicy: "ask-searcher" });

    const integration = container.querySelector<HTMLInputElement>(
      "input[type='checkbox']",
    );
    expect(integration?.checked).toBe(true);
    await act(async () => {
      integration?.click();
    });
    expect(onChange).toHaveBeenCalledWith({ shellIntegration: false });
  });

  it("fires exact one-field patches for the Conversations section controls", async () => {
    const onChange = vi.fn();
    await render(
      <SettingsDialog
        settings={DEFAULT_SETTINGS}
        onChange={onChange}
        onClose={() => undefined}
      />,
    );

    const rail = container.querySelector<HTMLInputElement>(
      "input[name='conversationsRail']",
    );
    expect(rail?.checked).toBe(true);
    await act(async () => {
      rail?.click();
    });
    expect(onChange).toHaveBeenCalledWith({ conversationsRail: false });

    const palette = container.querySelector<HTMLInputElement>(
      "input[name='conversationsPalette']",
    );
    expect(palette?.checked).toBe(true);
    await act(async () => {
      palette?.click();
    });
    expect(onChange).toHaveBeenCalledWith({ conversationsPalette: false });

    const engineLlm = container.querySelector<HTMLInputElement>(
      "input[name='summaryEngine'][value='llm']",
    );
    expect(engineLlm?.checked).toBe(false);
    await act(async () => {
      engineLlm?.click();
    });
    expect(onChange).toHaveBeenCalledWith({ summaryEngine: "llm" });

    const contentRecap = container.querySelector<HTMLInputElement>(
      "input[name='summaryContent'][value='recap']",
    );
    await act(async () => {
      contentRecap?.click();
    });
    expect(onChange).toHaveBeenCalledWith({ summaryContent: "recap" });

    const displayUnderTitle = container.querySelector<HTMLInputElement>(
      "input[name='summaryDisplay'][value='under-title']",
    );
    await act(async () => {
      displayUnderTitle?.click();
    });
    expect(onChange).toHaveBeenCalledWith({ summaryDisplay: "under-title" });
  });

  it("fires exact one-field patches for the Terminals section controls", async () => {
    const onChange = vi.fn();
    await render(
      <SettingsDialog
        settings={DEFAULT_SETTINGS}
        onChange={onChange}
        onClose={() => undefined}
      />,
    );

    const sleep15 = container.querySelector<HTMLInputElement>(
      "input[name='sleepHiddenTerminals'][value='15']",
    );
    expect(sleep15?.checked).toBe(true);

    const sleep60 = container.querySelector<HTMLInputElement>(
      "input[name='sleepHiddenTerminals'][value='60']",
    );
    await act(async () => {
      sleep60?.click();
    });
    expect(onChange).toHaveBeenCalledWith({ sleepHiddenTerminals: "60" });

    const sleepOff = container.querySelector<HTMLInputElement>(
      "input[name='sleepHiddenTerminals'][value='off']",
    );
    await act(async () => {
      sleepOff?.click();
    });
    expect(onChange).toHaveBeenCalledWith({ sleepHiddenTerminals: "off" });

    const closeAsk = container.querySelector<HTMLInputElement>(
      "input[name='onWindowClose'][value='ask']",
    );
    expect(closeAsk?.checked).toBe(true);

    const closeKeepRunning = container.querySelector<HTMLInputElement>(
      "input[name='onWindowClose'][value='keep-running']",
    );
    expect(closeKeepRunning?.parentElement?.textContent).toContain(
      "keeps terminals and agents running in the background",
    );
    await act(async () => {
      closeKeepRunning?.click();
    });
    expect(onChange).toHaveBeenCalledWith({ onWindowClose: "keep-running" });

    const closeStopAll = container.querySelector<HTMLInputElement>(
      "input[name='onWindowClose'][value='stop-all']",
    );
    await act(async () => {
      closeStopAll?.click();
    });
    expect(onChange).toHaveBeenCalledWith({ onWindowClose: "stop-all" });
  });

  it("renders the group-nesting depth ladder and patches just that field", async () => {
    const onChange = vi.fn();
    await render(
      <SettingsDialog
        settings={DEFAULT_SETTINGS}
        onChange={onChange}
        onClose={() => undefined}
      />,
    );

    const depth3 = container.querySelector<HTMLInputElement>(
      "input[name='maxGroupDepth'][value='3']",
    );
    expect(depth3?.checked).toBe(true);

    const depth1 = container.querySelector<HTMLInputElement>(
      "input[name='maxGroupDepth'][value='1']",
    );
    await act(async () => {
      depth1?.click();
    });
    expect(onChange).toHaveBeenCalledWith({ maxGroupDepth: 1 });

    const depth5 = container.querySelector<HTMLInputElement>(
      "input[name='maxGroupDepth'][value='5']",
    );
    await act(async () => {
      depth5?.click();
    });
    expect(onChange).toHaveBeenCalledWith({ maxGroupDepth: 5 });
  });

  it("closes on Escape and via the Done button", async () => {
    const onClose = vi.fn();
    await render(
      <SettingsDialog
        settings={DEFAULT_SETTINGS}
        onChange={() => undefined}
        onClose={onClose}
      />,
    );

    const dialog = container.querySelector<HTMLElement>("[role='dialog']")!;
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
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

  it("offers all six themes and reports the pick as a one-field patch", async () => {
    const onChange = vi.fn();
    await render(
      <SettingsDialog
        settings={DEFAULT_SETTINGS}
        onChange={onChange}
        onClose={() => undefined}
      />,
    );

    const swatches = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[name='theme']"),
    );
    expect(swatches.map((input) => input.value)).toEqual([...THEME_IDS]);
    expect(swatches.find((input) => input.checked)?.value).toBe(DEFAULT_SETTINGS.theme);
    // Every card previews its own theme, not the running one.
    expect(container.querySelectorAll(".settings-theme__swatch")).toHaveLength(
      THEME_IDS.length,
    );
    for (const id of THEME_IDS) {
      expect(container.textContent).toContain(THEMES[id].name);
    }

    const paper = swatches.find((input) => input.value === "paper-light")!;
    await act(async () => {
      paper.click();
    });
    expect(onChange).toHaveBeenCalledWith({ theme: "paper-light" });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("takes initial focus and wraps Tab at the edges", async () => {
    await render(
      <SettingsDialog
        settings={DEFAULT_SETTINGS}
        onChange={() => undefined}
        onClose={() => undefined}
      />,
    );

    const dialog = container.querySelector<HTMLElement>("[role='dialog']")!;
    expect(document.activeElement).toBe(dialog);

    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>("input, select, button"),
    );
    const last = focusables[focusables.length - 1]!;
    last.focus();
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(focusables[0]);

    focusables[0]!.focus();
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(last);
  });
});
