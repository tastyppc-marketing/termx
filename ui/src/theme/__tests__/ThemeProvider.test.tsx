import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveTokens } from "../deriveTokens";
import {
  applyTheme,
  currentThemeId,
  onThemeChange,
  ThemeProvider,
} from "../ThemeProvider";
import { DEFAULT_THEME_ID, THEMES } from "../themes";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  document.documentElement.removeAttribute("style");
  applyTheme(DEFAULT_THEME_ID);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function tokenOf(name: string): string {
  return document.documentElement.style.getPropertyValue(name);
}

describe("applyTheme", () => {
  it("writes the whole token set, the colour scheme and the theme attribute", () => {
    applyTheme("graphite-dark");
    const expected = deriveTokens(THEMES["graphite-dark"]);
    for (const [name, value] of Object.entries(expected)) {
      expect(tokenOf(name), name).toBe(value);
    }
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("graphite-dark");
    expect(currentThemeId()).toBe("graphite-dark");
  });

  it("flips every token on a second call — no reload, no confirmation", () => {
    applyTheme("graphite-dark");
    const before = tokenOf("--bg");
    applyTheme("paper-light");
    expect(tokenOf("--bg")).not.toBe(before);
    expect(tokenOf("--bg")).toBe(THEMES["paper-light"].bg);
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("paper-light");
    expect(currentThemeId()).toBe("paper-light");
  });

  it("notifies subscribers until they unsubscribe", () => {
    const listener = vi.fn();
    const stop = onThemeChange(listener);
    applyTheme("cold-steel");
    expect(listener).toHaveBeenCalledWith("cold-steel");
    stop();
    applyTheme("dark-iron");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("survives a listener that throws — one bad subscriber cannot break theming", () => {
    const good = vi.fn();
    const stopBad = onThemeChange(() => {
      throw new Error("subscriber blew up");
    });
    const stopGood = onThemeChange(good);
    expect(() => applyTheme("slate-medium")).not.toThrow();
    expect(good).toHaveBeenCalledWith("slate-medium");
    expect(currentThemeId()).toBe("slate-medium");
    stopBad();
    stopGood();
  });
});

describe("ThemeProvider", () => {
  it("applies on mount and re-applies when the setting changes", async () => {
    await act(async () => root.render(<ThemeProvider themeId="dark-iron" />));
    expect(tokenOf("--bg")).toBe(THEMES["dark-iron"].bg);

    await act(async () => root.render(<ThemeProvider themeId="cold-steel" />));
    expect(tokenOf("--bg")).toBe(THEMES["cold-steel"].bg);
    expect(currentThemeId()).toBe("cold-steel");
  });

  it("renders nothing of its own", async () => {
    await act(async () => root.render(<ThemeProvider themeId="graphite-dark" />));
    expect(container.innerHTML).toBe("");
  });
});
