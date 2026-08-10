/**
 * The six shipped themes. A theme is DATA — three colours plus a 16-colour
 * ansi set — and `deriveTokens` computes everything else, so adding a theme
 * never means writing CSS.
 *
 * Values come from the theme spec's table
 * (docs/superpowers/specs/2026-08-09-theme-engine-tab-colors-design.md §4).
 * Colour values and numeric scales are facts, not code: nothing here is
 * transliterated from any other implementation.
 */

import { PALETTE_HEX, type PaletteId } from "../state/layout";
import { ensureContrast } from "./contrast";

export const THEME_IDS = [
  "gunmetal-brass",
  "cold-steel",
  "dark-iron",
  "graphite-dark",
  "slate-medium",
  "paper-light",
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

/** Normal 0-7 then bright 8-15, exactly as xterm expects them. */
export type Ansi16 = readonly [
  string, string, string, string, string, string, string, string,
  string, string, string, string, string, string, string, string,
];

export interface TermxTheme {
  readonly id: ThemeId;
  readonly name: string;
  readonly mode: "dark" | "light";
  readonly bg: string;
  readonly fg: string;
  readonly accent: string;
  readonly ansi: Ansi16;
  /** Per-theme tuning of the eight tab colours; ids stay stable in storage. */
  readonly tabPalette?: Partial<Record<PaletteId, string>>;
}

export const THEMES: Record<ThemeId, TermxTheme> = {
  "gunmetal-brass": {
    id: "gunmetal-brass",
    name: "Gunmetal & Brass",
    mode: "dark",
    bg: "#141619",
    fg: "#d6d9de",
    accent: "#d9a441",
    ansi: [
      "#141619", "#d16a5f", "#8aa871", "#d9a441",
      "#7791b8", "#a582a3", "#7fa8a6", "#d6d9de",
      "#4a5058", "#e08477", "#a3c087", "#e6bb66",
      "#92abd1", "#bd9cba", "#99c2c0", "#eef0f3",
    ],
  },
  "cold-steel": {
    id: "cold-steel",
    name: "Cold Steel",
    mode: "dark",
    bg: "#12151a",
    fg: "#d3dae3",
    accent: "#5fa8d3",
    ansi: [
      "#12151a", "#cf6679", "#7fae8e", "#cfa75e",
      "#5fa8d3", "#9d8fc7", "#6fb3bd", "#d3dae3",
      "#454e59", "#e28495", "#99c6a7", "#ddbc7e",
      "#83bfe2", "#b3a7d8", "#8ccbd4", "#ecf0f4",
    ],
  },
  "dark-iron": {
    id: "dark-iron",
    name: "Dark Iron",
    mode: "dark",
    bg: "#101113",
    fg: "#d8d4cf",
    accent: "#c4703f",
    ansi: [
      "#101113", "#c85a49", "#94a06a", "#cf9d52",
      "#8496ad", "#a8809a", "#8aa89f", "#d8d4cf",
      "#45464a", "#dd7b6a", "#adb886", "#ddb272",
      "#9dafc4", "#bd99b0", "#a3c0b8", "#efece8",
    ],
  },
  "graphite-dark": {
    id: "graphite-dark",
    name: "Graphite Dark",
    mode: "dark",
    bg: "#0f1115",
    fg: "#e2e4e9",
    accent: "#7aa2f7",
    ansi: [
      "#0f1115", "#f7768e", "#9ece6a", "#e0af68",
      "#7aa2f7", "#bb9af7", "#7dcfff", "#e2e4e9",
      "#3b4048", "#f98ea2", "#b0da85", "#e8c187",
      "#93b5f9", "#cbb1f9", "#99daff", "#f2f3f6",
    ],
  },
  "slate-medium": {
    id: "slate-medium",
    name: "Slate Medium",
    mode: "dark",
    bg: "#232833",
    fg: "#e6e9ee",
    accent: "#8ab4f8",
    ansi: [
      "#232833", "#e07b8b", "#9cc088", "#d8b370",
      "#8ab4f8", "#b39ddb", "#87ceda", "#e6e9ee",
      "#59616f", "#ec96a4", "#b3d4a2", "#e4c68f",
      "#a3c5fa", "#c5b3e5", "#a0dce6", "#f4f6f9",
    ],
  },
  "paper-light": {
    id: "paper-light",
    name: "Paper Light",
    mode: "light",
    bg: "#f4f2ee",
    fg: "#24262b",
    accent: "#a3622f",
    ansi: [
      "#24262b", "#b03e2e", "#4a7c3f", "#9a7015",
      "#2f5d9e", "#8d4a86", "#3d7d7a", "#e9e6e0",
      "#55585f", "#cc5a48", "#649a58", "#b8892e",
      "#4d77b5", "#a5669d", "#579996", "#f4f2ee",
    ],
  },
};

export const DEFAULT_THEME_ID: ThemeId = "gunmetal-brass";

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

export function themeById(id: ThemeId | null | undefined): TermxTheme {
  return (id && THEMES[id]) || THEMES[DEFAULT_THEME_ID];
}

/**
 * The hex a tab/group `PaletteId` renders as under `theme`: the theme's own
 * override when it has one, else the shared palette — and always through the
 * contrast gate, so a 3 px stripe stays visible on light and dark alike.
 */
export function resolveTabColor(theme: TermxTheme, color: PaletteId): string {
  const base = theme.tabPalette?.[color] ?? PALETTE_HEX[color];
  return ensureContrast(base, theme.bg, 3, theme.mode);
}
