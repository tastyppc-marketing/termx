# Theme Engine, UI Hardening, Tab Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Six live-switchable themes derived from three colors each, a structural hardening pass (hairlines, square tabs, density), and stripe+fill tab colors with colorable group frames.

**Architecture:** `ui/src/theme/` computes a full token set in TS from each theme's `bg/fg/accent` (so a WCAG contrast pass can correct tokens before they render), writes them as CSS custom properties on `document.documentElement`, and feeds a matching palette to xterm. All component CSS consumes tokens. Tab/group color rendering rides `--tab-color`/`--group-color` custom properties set inline per row from the layout's `PaletteId`s (already in layout_v2 on main: `Tab.fill`, `Group.color`, with controller mutations `setTabFill`/`recolorGroup` already merged).

**Tech Stack:** TypeScript (React 19), vitest + @testing-library/react, CSS custom properties + `color-mix()` (WebView2 supports it), xterm.js `ITheme`.

**Spec:** `docs/superpowers/specs/2026-08-09-theme-engine-tab-colors-design.md` — read first; authoritative. Licensing: Warp-study numbers/palettes are free to use; NEVER transliterate Warp (AGPL) code.

## Global Constraints

- Contrast targets: text tokens ≥ 4.5:1, border/non-text tokens ≥ 3:1, enforced by `ensureContrast` on every derived token.
- Derivation percentages verbatim: surfaces 5/10/15 % fg-over-bg; `--border` fg@10 %, `--divider` fg@15 %; text ladder 90/60/40/20 %; accent ramp 10/25/40/60 %.
- Hardening numbers verbatim: radius 4 px default, 0 on tabs and terminal panes, 6–8 px only floating overlays; ONE box-shadow definition app-wide (overlays only); 12 px base UI font; 34 px chrome rows; 28 px list rows; 24 px icon buttons; 10 px uppercase overlines with `letter-spacing: 0.08em`.
- Tab stripe: solid 3 px left, full opacity, never blended. Fill: subtle ≈ 8 %, strong ≈ 18 %. Group frame 1 px + ≈ 8 % wash.
- Default theme `"gunmetal-brass"`. Theme switch = live, no confirm, no reload.
- `exactOptionalPropertyTypes` ON: `{...(x ? { x } : {})}`. No hardcoded absolute machine paths.
- Gates: `cd ui && npx tsc -b` clean; `npx vitest run --reporter=dot` ≥ **800** (current baseline) + new, all green; e2e ≥ 5. Host/cargo untouched by this lane.
- Never `git stash`; never junction/symlink into the main repo; one commit per task.

## File Structure

- Create `ui/src/theme/`: `themes.ts` (data), `contrast.ts` (WCAG math), `deriveTokens.ts` (token computation + xterm palette), `ThemeProvider.tsx` (apply/subscribe), `__tests__/`.
- Modify: `ui/src/settings/settings.ts` + `SettingsDialog.tsx` (theme field + picker), `ui/src/App.tsx` (provider mount), `ui/src/terminal/TerminalPane.tsx` (xterm theme + live update), and every component CSS file (`styles.css`, `sidebar/Sidebar.css`, `split/SplitLayout.css`, `viewer/Viewer.css`, `outputs/OutputPane.css`, `conversations/ConversationsRail.css`, `actions/FeaturesDock.css`, settings/dead-pane css) for the token refactor + hardening.
- Modify: `ui/src/sidebar/Sidebar.tsx` (stripe/fill/group-frame rendering + color/fill menus).

---

### Task 1: contrast.ts + deriveTokens.ts + themes.ts

**Files:**
- Create: `ui/src/theme/contrast.ts`, `ui/src/theme/deriveTokens.ts`, `ui/src/theme/themes.ts`
- Test: `ui/src/theme/__tests__/contrast.test.ts`, `deriveTokens.test.ts`

**Interfaces — Produces (Tasks 2–5 rely on exactly these):**

```ts
// themes.ts
export const THEME_IDS = ["gunmetal-brass", "cold-steel", "dark-iron",
  "graphite-dark", "slate-medium", "paper-light"] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export interface TermxTheme {
  id: ThemeId; name: string; mode: "dark" | "light";
  bg: string; fg: string; accent: string;
  ansi: readonly [string, ...string[]] & { length: 16 };   // normal 0-7 then bright 8-15
  tabPalette?: Partial<Record<PaletteId, string>>;
}
export const THEMES: Record<ThemeId, TermxTheme>;
export const DEFAULT_THEME_ID: ThemeId; // "gunmetal-brass"
export function isThemeId(v: unknown): v is ThemeId;
export function resolveTabColor(theme: TermxTheme, color: PaletteId): string; // tabPalette override ?? PALETTE_HEX

// contrast.ts
export function contrastRatio(a: string, b: string): number;      // WCAG 2.x relative luminance; accepts #rgb/#rrggbb
export function ensureContrast(color: string, background: string,
  ratio: number, mode: "dark" | "light"): string;                  // binary-search blend toward white (dark) / black (light)

// deriveTokens.ts
export function deriveTokens(theme: TermxTheme): Record<string, string>;
// keys exactly: --bg --fg --accent --surface-1 --surface-2 --surface-3
//   --border --divider --text-main --text-sub --text-hint --text-disabled
//   --accent-10 --accent-25 --accent-40 --accent-60 --error --warn --ok
export function xtermTheme(theme: TermxTheme): {
  background: string; foreground: string; cursor: string; selectionBackground: string;
  black: string; red: string; /* ...all 16 named ITheme color slots */ brightWhite: string;
};
```

Theme data (starting values — tune only if the contrast tests force it; keep desaturated brights):

| theme | bg | fg | accent | ansi normal 0-7 / bright 8-15 |
|---|---|---|---|---|
| gunmetal-brass | `#141619` | `#d6d9de` | `#d9a441` | `#141619 #d16a5f #8aa871 #d9a441 #7791b8 #a582a3 #7fa8a6 #d6d9de` / `#4a5058 #e08477 #a3c087 #e6bb66 #92abd1 #bd9cba #99c2c0 #eef0f3` |
| cold-steel | `#12151a` | `#d3dae3` | `#5fa8d3` | `#12151a #cf6679 #7fae8e #cfa75e #5fa8d3 #9d8fc7 #6fb3bd #d3dae3` / `#454e59 #e28495 #99c6a7 #ddbc7e #83bfe2 #b3a7d8 #8ccbd4 #ecf0f4` |
| dark-iron | `#101113` | `#d8d4cf` | `#c4703f` | `#101113 #c85a49 #94a06a #cf9d52 #8496ad #a8809a #8aa89f #d8d4cf` / `#45464a #dd7b6a #adb886 #ddb272 #9dafc4 #bd99b0 #a3c0b8 #efece8` |
| graphite-dark | `#0f1115` | `#e2e4e9` | `#7aa2f7` | `#0f1115 #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #e2e4e9` / `#3b4048 #f98ea2 #b0da85 #e8c187 #93b5f9 #cbb1f9 #99daff #f2f3f6` |
| slate-medium | `#232833` | `#e6e9ee` | `#8ab4f8` | `#232833 #e07b8b #9cc088 #d8b370 #8ab4f8 #b39ddb #87ceda #e6e9ee` / `#59616f #ec96a4 #b3d4a2 #e4c68f #a3c5fa #c5b3e5 #a0dce6 #f4f6f9` |
| paper-light | `#f4f2ee` | `#24262b` | `#a3622f` | `#24262b #b03e2e #4a7c3f #9a7015 #2f5d9e #8d4a86 #3d7d7a #e9e6e0` / `#55585f #cc5a48 #649a58 #b8892e #4d77b5 #a5669d #579996 #f4f2ee` |

Semantic tokens: `--error`/`--warn`/`--ok` = the theme's ansi red/yellow/green run through `ensureContrast(…, bg, 3, mode)`.

- [ ] **Step 1:** Failing tests: `contrastRatio("#ffffff","#000000")` = 21 (±0.01); `ensureContrast` returns input unchanged when already passing; returns a passing color for a failing pair (assert `contrastRatio(result, bg) >= target`); converges for pathological pairs (accent≈bg). `deriveTokens`: snapshot for gunmetal-brass; property test over ALL six themes — every `--text-*` except `--text-disabled` ≥ 4.5:1 vs `--bg` and vs `--surface-2`; `--border` ≥ 1.2:1 vs bg (borders are subtle by design — assert only they're distinguishable) and `--error/--warn/--ok` ≥ 3:1 vs bg. `xtermTheme` maps all 16 slots + bg/fg/cursor/selection.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** green → **Step 5:** Commit: `feat(theme): theme data, WCAG contrast, token derivation`.

### Task 2: ThemeProvider + settings field + picker

**Files:**
- Create: `ui/src/theme/ThemeProvider.tsx`, test `ui/src/theme/__tests__/ThemeProvider.test.tsx`
- Modify: `ui/src/settings/settings.ts` (+`theme: ThemeId`, default `DEFAULT_THEME_ID`, tolerant parse via `isThemeId` — follow the `sleepHiddenTerminals` guard pattern), `ui/src/settings/SettingsDialog.tsx` (Theme section: six swatch cards showing bg+accent+name, click applies), `ui/src/App.tsx` (mount; subscribe settings)
- Test: extend `settings.test.ts`, `SettingsDialog.test.tsx`

**Interfaces — Produces:**

```ts
export function applyTheme(themeId: ThemeId): void;   // writes deriveTokens() entries onto document.documentElement.style, sets style.colorScheme from mode, and sets data-theme={id} attribute
export function currentThemeId(): ThemeId;
export function onThemeChange(l: (id: ThemeId) => void): () => void;  // TerminalPane subscribes (Task 4)
```

- [ ] **Step 1:** Failing tests: applyTheme writes `--bg` etc. on documentElement and flips on second call; settings default/tolerance ("neon" → default) round-trip; dialog renders six options, clicking one persists and applies.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** green → **Step 5:** Commit: `feat(theme): live theme provider, settings field, picker`.

### Task 3: Token refactor + structural hardening across all CSS

**Files:** every css file listed in File Structure; no TS behavior changes.

Mechanics: replace literal palette hexes with tokens (`#0f1115`→`var(--bg)`, `#161a22`→`var(--surface-1)`, `#232a36`→`var(--surface-2)`, `#e6e6e6`→`var(--text-main)`, `#8b93a7`→`var(--text-sub)`, `#7aa2f7`→`var(--accent)`, `#1f2430`/`rgb(255 255 255 / 6%)` borders→`var(--border)`); keep the per-component `--sidebar-*`-style var blocks but define them as aliases of global tokens. Then apply every Global-Constraints hardening number: kill the two radial-gradient glows in `styles.css` (app-main, workspace-panel) and the brand-mark box-shadow; `.terminal-host` radius 8→0; app-header 42→34 px; base font 13→12 px where component css sets it; overline treatment on group headers/dock titles; audit for any remaining `box-shadow` (allowed only on floating overlays — menus/dialogs) and any radius > 8.

`:root` in `styles.css` keeps fallback literals equal to graphite-dark values so a pre-ThemeProvider flash is coherent.

- [ ] **Step 1:** `rg -n "#[0-9a-fA-F]{3,6}|box-shadow|border-radius" ui/src --glob "*.css"` — inventory every hit into the commit message as done/kept-with-reason.
- [ ] **Step 2:** Apply. Visual sanity: existing component tests stay green (they assert structure, not pixels); `npx vitest run --reporter=dot` full suite green.
- [ ] **Step 3:** Commit: `refactor(ui): token-driven CSS + structural hardening (hairlines, square tabs, density)`.

### Task 4: xterm theming live

**Files:**
- Modify: `ui/src/terminal/TerminalPane.tsx` (construct xterm with `theme: xtermTheme(THEMES[currentThemeId()])`; subscribe `onThemeChange` → `terminal.options.theme = xtermTheme(...)`), any terminal css with literal colors
- Test: extend TerminalPane tests (theme object passed at construction; update on change — assert via the existing terminal fake/mocks)

- [ ] **Step 1:** Failing tests → **Step 2:** FAIL → **Step 3:** implement → **Step 4:** green → **Step 5:** Commit: `feat(terminal): per-theme xterm palette, live-switchable`.

### Task 5: Tab stripe + fill, group frame + wash, menus

**Files:**
- Modify: `ui/src/sidebar/Sidebar.tsx`, `Sidebar.css`
- Test: `ui/src/sidebar/__tests__/Sidebar.test.tsx`

Rendering: each tab row sets `style={{ "--tab-color": resolveTabColor(theme, tab.color) }}`; CSS: `.sidebar-tab { border-left: 3px solid var(--tab-color); border-radius: 0; }`; `.sidebar-tab--fill-subtle { background: color-mix(in srgb, var(--tab-color) 8%, transparent); }`, `--fill-strong` 18 % (active/hover surface tints layer on top via the existing background rules — stripe stays the color carrier). **Remove the tab color dot** (`sidebar-tab__color`) — the stripe replaces it; delete the dot's `[data-color]` css block and migrate the color-menu swatches to inline `resolveTabColor` styles so `tabPalette` overrides show truthfully. Colored group (`group.color != null`): the group's container gets `--group-color` and `border-left: 1px solid var(--group-color); background: color-mix(in srgb, var(--group-color) 8%, transparent);` — visible between/beside tabs; `null` renders exactly today's neutral. Keep the group header dot, now colored by `group.color ?? "slate"`.

Menus: tab color submenu (exists at Sidebar.tsx:679-694 area) gains a three-way fill row (`Off / Subtle / Strong` → `actions.setTabFill`); group menu gains a color submenu (same swatch grid + a "None" entry → `actions.recolorGroup`). Wire `setTabFill`/`recolorGroup` through `SidebarActions` (controller methods already exist on main).

- [ ] **Step 1:** Failing tests: stripe style var set from PaletteId and from a tabPalette override; fill classes per `tab.fill`; group frame/wash only when color non-null; fill menu calls setTabFill; group color menu calls recolorGroup; dot removed.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** green → **Step 5:** Commit: `feat(sidebar): stripe+fill tab colors, colorable group frames`.

### Task 6: Full gates

- [ ] `cd ui && npx tsc -b` clean; `npx vitest run --reporter=dot` ≥ 800 + new, all green; `npx vitest run -c vitest.e2e.config.ts` ≥ 5 green.
- [ ] Commit anything remaining; report per-commit SHAs + test counts. Note in the report that the manual visual gate (Michael flipping through six themes with a blue group + red tabs) remains open.

## Self-Review (done at plan time)

Spec §1→T1+T2, §2→T1, §3→T3, §4→T1 data, §5→T5, §6→T2; error handling→T2 tolerant parse + T1 totality; testing list mapped. Names cross-checked: `resolveTabColor`, `applyTheme`, `onThemeChange`, `xtermTheme` consistent between tasks. Border contrast assertion deliberately relaxed to ≥1.2:1 (spec's 3:1 applies to *meaningful* non-text like semantic colors; a 10 % hairline can't hit 3:1 by design) — deviation documented here.
