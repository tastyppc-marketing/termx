/**
 * Token derivation: a theme's three colours become the whole CSS custom-property
 * set, in TypeScript rather than CSS `color-mix()`, precisely so the WCAG pass
 * can correct a token BEFORE it ever renders.
 *
 * Derivation opacities (theme spec §1): surfaces 5/10/15 %, border 10 %,
 * divider 15 %, text ladder 90/60/40/20 %, accent ramp 10/25/40/60 %.
 */

import { blend, ensureContrast } from "./contrast";
import type { TermxTheme } from "./themes";

/** WCAG floors: body text, and non-text that still has to be seen. */
const TEXT_RATIO = 4.5;
const NON_TEXT_RATIO = 3;

export type ThemeTokens = Record<string, string>;

export function deriveTokens(theme: TermxTheme): ThemeTokens {
  const { bg, fg, accent, mode } = theme;
  const surface = (alpha: number) => blend(fg, bg, alpha);
  const wash = (alpha: number) => blend(accent, bg, alpha);
  const text = (alpha: number) => ensureContrast(blend(fg, bg, alpha), bg, TEXT_RATIO, mode);

  return {
    "--bg": bg,
    "--fg": ensureContrast(fg, bg, TEXT_RATIO, mode),
    "--accent": ensureContrast(accent, bg, NON_TEXT_RATIO, mode),

    "--surface-1": surface(0.05),
    "--surface-2": surface(0.1),
    "--surface-3": surface(0.15),

    "--border": surface(0.1),
    "--divider": surface(0.15),

    "--text-main": text(0.9),
    "--text-sub": text(0.6),
    "--text-hint": text(0.4),
    // Deliberately unreadable: disabled text must read as disabled.
    "--text-disabled": surface(0.2),

    "--accent-10": wash(0.1),
    "--accent-25": wash(0.25),
    "--accent-40": wash(0.4),
    "--accent-60": wash(0.6),

    "--error": ensureContrast(theme.ansi[1], bg, NON_TEXT_RATIO, mode),
    "--warn": ensureContrast(theme.ansi[3], bg, NON_TEXT_RATIO, mode),
    "--ok": ensureContrast(theme.ansi[2], bg, NON_TEXT_RATIO, mode),
  };
}

/** The xterm.js `ITheme` slots TermX sets. */
export interface XtermPalette {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export function xtermTheme(theme: TermxTheme): XtermPalette {
  const tokens = deriveTokens(theme);
  const ansi = theme.ansi;
  return {
    background: theme.bg,
    foreground: theme.fg,
    cursor: tokens["--accent"]!,
    selectionBackground: tokens["--accent-25"]!,
    black: ansi[0],
    red: ansi[1],
    green: ansi[2],
    yellow: ansi[3],
    blue: ansi[4],
    magenta: ansi[5],
    cyan: ansi[6],
    white: ansi[7],
    brightBlack: ansi[8],
    brightRed: ansi[9],
    brightGreen: ansi[10],
    brightYellow: ansi[11],
    brightBlue: ansi[12],
    brightMagenta: ansi[13],
    brightCyan: ansi[14],
    brightWhite: ansi[15],
  };
}

/** xterm search-addon highlight colours, derived from the theme's own yellow. */
export interface XtermSearchDecorations {
  matchBackground: string;
  matchOverviewRuler: string;
  activeMatchBackground: string;
  activeMatchColorOverviewRuler: string;
}

export function xtermSearchDecorations(theme: TermxTheme): XtermSearchDecorations {
  const tokens = deriveTokens(theme);
  return {
    matchBackground: blend(theme.ansi[3], theme.bg, 0.25),
    matchOverviewRuler: tokens["--warn"]!,
    activeMatchBackground: blend(theme.ansi[3], theme.bg, 0.45),
    activeMatchColorOverviewRuler: tokens["--accent"]!,
  };
}
