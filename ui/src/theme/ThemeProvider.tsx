/**
 * Live theme application.
 *
 * `applyTheme` is one style-attribute write on <html>: the derived tokens as
 * custom properties, `color-scheme` from the theme's mode, and `data-theme`
 * for the rare rule that needs to key off the theme itself. Switching is
 * instant — no reload, no confirmation — which is the whole point of computing
 * tokens in TS.
 *
 * Non-React consumers (the terminal panes, which must retint a running xterm)
 * subscribe through `onThemeChange`.
 */

import { useLayoutEffect, useSyncExternalStore } from "react";
import { deriveTokens } from "./deriveTokens";
import { DEFAULT_THEME_ID, themeById, type ThemeId } from "./themes";

type ThemeListener = (id: ThemeId) => void;

let activeThemeId: ThemeId = DEFAULT_THEME_ID;
const listeners = new Set<ThemeListener>();

export function currentThemeId(): ThemeId {
  return activeThemeId;
}

export function onThemeChange(listener: ThemeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function applyTheme(themeId: ThemeId): void {
  const theme = themeById(themeId);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(deriveTokens(theme))) {
    root.style.setProperty(name, value);
  }
  root.style.colorScheme = theme.mode;
  root.dataset.theme = theme.id;
  activeThemeId = theme.id;
  for (const listener of [...listeners]) {
    try {
      listener(theme.id);
    } catch {
      // A subscriber that throws must not leave the app half-themed.
    }
  }
}

/**
 * The live theme id for components that RENDER theme-dependent values (the
 * sidebar resolves tab colours through it), so a switch repaints them without
 * a reload.
 */
export function useThemeId(): ThemeId {
  return useSyncExternalStore(onThemeChange, currentThemeId, currentThemeId);
}

export interface ThemeProviderProps {
  themeId: ThemeId;
}

/** Applies the settings theme before paint; renders nothing of its own. */
export function ThemeProvider({ themeId }: ThemeProviderProps) {
  useLayoutEffect(() => {
    applyTheme(themeId);
  }, [themeId]);
  return null;
}
