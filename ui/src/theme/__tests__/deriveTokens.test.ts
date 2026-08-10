import { describe, expect, it } from "vitest";
import { PALETTE_HEX, PALETTE_IDS } from "../../state/layout";
import { contrastRatio } from "../contrast";
import { deriveTokens, xtermTheme } from "../deriveTokens";
import {
  DEFAULT_THEME_ID,
  isThemeId,
  resolveTabColor,
  THEME_IDS,
  THEMES,
  type TermxTheme,
} from "../themes";

const TOKEN_KEYS = [
  "--bg",
  "--fg",
  "--accent",
  "--surface-1",
  "--surface-2",
  "--surface-3",
  "--border",
  "--divider",
  "--text-main",
  "--text-sub",
  "--text-hint",
  "--text-disabled",
  "--accent-10",
  "--accent-25",
  "--accent-40",
  "--accent-60",
  "--error",
  "--warn",
  "--ok",
];

const ALL_THEMES = THEME_IDS.map((id) => THEMES[id]);

describe("themes", () => {
  it("ships the six spec'd themes with a full 16-colour ansi set", () => {
    expect(THEME_IDS).toEqual([
      "gunmetal-brass",
      "cold-steel",
      "dark-iron",
      "graphite-dark",
      "slate-medium",
      "paper-light",
    ]);
    for (const theme of ALL_THEMES) {
      expect(theme.ansi).toHaveLength(16);
      for (const color of theme.ansi) {
        expect(color).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(theme.name.length).toBeGreaterThan(0);
    }
    expect(THEMES["paper-light"].mode).toBe("light");
    expect(DEFAULT_THEME_ID).toBe("gunmetal-brass");
  });

  it("guards theme ids", () => {
    expect(isThemeId("cold-steel")).toBe(true);
    expect(isThemeId("neon")).toBe(false);
    expect(isThemeId(null)).toBe(false);
    expect(isThemeId(7)).toBe(false);
  });

  it("resolves tab colours from the shared palette, honouring a theme override", () => {
    const theme = THEMES["graphite-dark"];
    // No shipped theme overrides the palette, so every id resolves from
    // PALETTE_HEX (contrast-corrected against the theme background).
    for (const id of PALETTE_IDS) {
      expect(resolveTabColor(theme, id)).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrastRatio(resolveTabColor(theme, id), theme.bg))
        .toBeGreaterThanOrEqual(3);
    }
    const overridden: TermxTheme = { ...theme, tabPalette: { red: "#ff0000" } };
    expect(resolveTabColor(overridden, "red")).toBe("#ff0000");
    expect(resolveTabColor(overridden, "blue")).toBe(resolveTabColor(theme, "blue"));
  });

  it("keeps every tab stripe legible on every theme", () => {
    for (const theme of ALL_THEMES) {
      for (const id of PALETTE_IDS) {
        expect(contrastRatio(resolveTabColor(theme, id), theme.bg))
          .toBeGreaterThanOrEqual(3);
      }
    }
    // The palette ids themselves never change — stored layouts stay stable.
    expect(Object.keys(PALETTE_HEX).sort()).toEqual([...PALETTE_IDS].sort());
  });
});

describe("deriveTokens", () => {
  it("produces exactly the spec'd token set", () => {
    const tokens = deriveTokens(THEMES[DEFAULT_THEME_ID]);
    expect(Object.keys(tokens).sort()).toEqual([...TOKEN_KEYS].sort());
    expect(tokens["--bg"]).toBe(THEMES[DEFAULT_THEME_ID].bg);
    for (const value of Object.values(tokens)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("snapshots the default theme", () => {
    expect(deriveTokens(THEMES["gunmetal-brass"])).toMatchSnapshot();
  });

  it("blends surfaces and the accent ramp at the spec'd opacities", () => {
    const tokens = deriveTokens(THEMES["graphite-dark"]);
    // bg #0f1115 (15,17,21) + fg #e2e4e9 (226,228,233) @ 10%
    expect(tokens["--surface-2"]).toBe("#24262a");
    expect(tokens["--border"]).toBe(tokens["--surface-2"]);
    expect(tokens["--divider"]).toBe(tokens["--surface-3"]);
    // accent #7aa2f7 (122,162,247) @ 25% over bg
    expect(tokens["--accent-25"]).toBe("#2a354e");
  });

  it("keeps text legible on both the window background and a raised surface", () => {
    for (const theme of ALL_THEMES) {
      const tokens = deriveTokens(theme);
      const bg = tokens["--bg"]!;
      const raised = tokens["--surface-2"]!;
      for (const key of ["--text-main", "--text-sub", "--text-hint"]) {
        expect(contrastRatio(tokens[key]!, bg), `${theme.id} ${key} vs bg`)
          .toBeGreaterThanOrEqual(4.5);
        // Body text must also clear 4.5 on a raised row; the dimmer rungs are
        // secondary text and only have to stay distinguishable there.
        const floor = key === "--text-main" ? 4.5 : 3;
        expect(contrastRatio(tokens[key]!, raised), `${theme.id} ${key} vs surface-2`)
          .toBeGreaterThanOrEqual(floor);
      }
      expect(contrastRatio(tokens["--fg"]!, bg)).toBeGreaterThanOrEqual(4.5);
      // Hairlines are subtle by design — they only have to be visible at all.
      expect(contrastRatio(tokens["--border"]!, bg)).toBeGreaterThanOrEqual(1.2);
      for (const key of ["--accent", "--error", "--warn", "--ok"]) {
        expect(contrastRatio(tokens[key]!, bg), `${theme.id} ${key}`)
          .toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("keeps the text ladder ordered from main down to disabled", () => {
    for (const theme of ALL_THEMES) {
      const tokens = deriveTokens(theme);
      const bg = tokens["--bg"]!;
      const ladder = ["--text-main", "--text-sub", "--text-hint", "--text-disabled"]
        .map((key) => contrastRatio(tokens[key]!, bg));
      // Tolerance: two rungs the contrast gate lifted to the same 4.5 floor
      // land within search precision of each other, in either order.
      for (let i = 1; i < ladder.length; i += 1) {
        expect(ladder[i]!, `${theme.id} rung ${i}`).toBeLessThanOrEqual(
          ladder[i - 1]! + 0.05,
        );
      }
    }
  });
});

describe("xtermTheme", () => {
  it("maps all 16 ansi slots plus background, foreground, cursor and selection", () => {
    const theme = THEMES["cold-steel"];
    const palette = xtermTheme(theme);
    expect(palette.background).toBe(theme.bg);
    expect(palette.foreground).toBe(theme.fg);
    expect(palette.cursor).toBe(deriveTokens(theme)["--accent"]);
    expect(palette.selectionBackground).toBe(deriveTokens(theme)["--accent-25"]);
    expect([
      palette.black,
      palette.red,
      palette.green,
      palette.yellow,
      palette.blue,
      palette.magenta,
      palette.cyan,
      palette.white,
      palette.brightBlack,
      palette.brightRed,
      palette.brightGreen,
      palette.brightYellow,
      palette.brightBlue,
      palette.brightMagenta,
      palette.brightCyan,
      palette.brightWhite,
    ]).toEqual([...theme.ansi]);
  });

  it("gives every theme a distinct palette", () => {
    const backgrounds = ALL_THEMES.map((theme) => xtermTheme(theme).background);
    expect(new Set(backgrounds).size).toBe(ALL_THEMES.length);
  });
});
