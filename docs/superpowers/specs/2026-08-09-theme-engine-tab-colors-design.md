# TermX Theme Engine, UI Hardening, and Tab-Color System — Design

**Date:** 2026-08-09 · **Status:** approved in brainstorm, pending spec review
**Companion specs (same batch):** `2026-08-09-reliability-reconnect-design.md`, `2026-08-09-nested-groups-design.md`
**Licensing note:** design patterns and color values below draw on the Warp
study (`docs/warp-study/report-ui-design-system.md`). Numbers, palettes, and
schema ideas are facts and are free to use; **no Warp (AGPL) code is ever
transliterated** — all CSS/TS here is original.

## Goal

Replace TermX's single hardcoded look with a theme engine: six switchable
themes (three metals + dark/medium/light neutrals) built on a one-time
structural hardening pass that fixes the "too soft" feel, plus a tab/group
color system where tab colors stay legible inside colored groups (solid
stripe + optional fill, per Michael's choice).

## Background: current state

- Colors are hardcoded hex scattered per component: global chrome in
  `ui/src/styles.css` (`#0f1115` bg, `#e6e6e6` text, radius 8, a glow
  radial-gradient, a box-shadow on the brand mark); per-component `--sidebar-*`,
  `--viewer-*`, `--output-*`, `--conversations-*` variable blocks each
  redeclaring the same palette (`#161a22` / `#232a36` / `#e6e6e6` / `#8b93a7`
  / `#7aa2f7`).
- Tab colors: `PALETTE_IDS`/`PALETTE_HEX` in `ui/src/state/layout.ts:6-28`
  (Tokyo Night pastels); rendered as a small dot (`sidebar-tab__color`,
  `ui/src/sidebar/Sidebar.tsx:537`; hex rules `ui/src/sidebar/Sidebar.css:158-165`).
  Groups are hardcoded slate (Sidebar.tsx:622). Michael's complaint: a red tab
  in a blue group muddies into illegibility.
- Settings infra exists (`ui/src/settings/settings.ts` + `SettingsStore.ts` +
  `SettingsDialog`) with tolerant per-field parsing.
- xterm terminal theme is currently the default dark; pane chrome is styled in
  `styles.css` / `SplitLayout.css`.
- **Dependency:** the `Group.color` and `Tab.fill` schema fields this spec
  renders are defined by the nested-groups spec (layout_v2). This spec is
  implemented after (or on top of) that one.

## Design

### 1. Token system (new: `ui/src/theme/`)

A theme declares **three colors plus a terminal palette**; everything else is
derived — so adding a theme is data, not CSS.

```ts
interface TermxTheme {
  id: ThemeId;                       // "gunmetal-brass" | "cold-steel" | "dark-iron"
                                     // | "graphite-dark" | "slate-medium" | "paper-light"
  name: string;                      // display name
  mode: "dark" | "light";            // drives color-scheme + derivation direction
  bg: string;                        // window background
  fg: string;                        // primary text
  accent: string;                    // interactive/highlight
  ansi: string[16];                  // terminal palette, fed to xterm theme
  tabPalette?: Partial<Record<PaletteId, string>>; // per-theme overrides of PALETTE_HEX
}
```

`deriveTokens(theme)` (pure TS, unit-testable) computes the full token set by
blending fg into bg at fixed opacities and applies contrast correction (§2):

- Surfaces: `--surface-1/2/3` = fg @ 5/10/15 % over bg.
- Borders: `--border` = fg @ 10 %; `--divider` = fg @ 15 %.
- Text ladder: `--text-main/-sub/-hint/-disabled` = fg @ 90/60/40/20 %.
- Accent ramp: `--accent` plus `--accent-10/25/40/60` (accent @ N % over bg);
  selection = accent @ 25 %.
- Semantic: `--error` / `--warn` / `--ok` — fixed per-theme values (derived
  from the theme's ansi red/yellow/green, contrast-corrected).

`ThemeProvider` (mounted in `App.tsx`) writes the computed tokens as inline
custom properties on `document.documentElement` and sets
`color-scheme`. Switching themes is instant — one style-attribute write, no
reload; running terminals get their xterm `theme` option updated live.

Tokens are computed in TS (not CSS `color-mix`) precisely so the contrast
pass can correct them before they ever render.

### 2. WCAG contrast auto-correct (`ui/src/theme/contrast.ts`)

`ensureContrast(color, background, ratio)`: if the pair misses the target
(4.5:1 for text tokens, 3:1 for borders/non-text), binary-search the color's
blend toward pure white or black (direction per `mode`) until it passes.
Implemented independently from WCAG 2.x relative-luminance math (~40 lines).
Every derived token passes through it, so **no theme — including future user
themes — can produce unreadable UI**. Unit tests pin known ratios.

### 3. Structural hardening (theme-independent, one pass)

Applied while refactoring component CSS onto tokens — this is what fixes
"too soft" regardless of theme:

1. **Hairlines replace shadows:** all separation via 1 px `--border`; the app
   keeps exactly one `box-shadow` definition, used only by floating overlays
   (menus, dialogs). The brand-mark glow and `app-main` radial gradients are
   removed.
2. **Radii:** 4 px default; **0 on tabs and terminal panes**
   (`.terminal-host` drops its radius-8); 6–8 px only on floating overlays;
   round only dots.
3. **Density:** 12 px base UI font, 34 px chrome rows (header currently
   42 px → 34 px), 28 px list rows, 24 px icon buttons.
4. **Overlines:** 10 px uppercase labels with `letter-spacing: 0.08em` for
   section headers (group headers, dock titles) — the tracking sells the
   sign-shop look.
5. **Component var blocks** (`--sidebar-*`, `--viewer-*`, `--output-*`,
   `--conversations-*`) become aliases of global tokens, so nothing needs a
   per-component palette again.

### 4. The six themes (initial values; tuning expected during build)

| id | mode | bg | fg | accent | character |
|---|---|---|---|---|---|
| `gunmetal-brass` (default) | dark | `#141619` | `#d6d9de` | `#d9a441` | blued steel + brass |
| `cold-steel` | dark | `#12151a` | `#d3dae3` | `#5fa8d3` | cool steel + ice blue |
| `dark-iron` | dark | `#101113` | `#d8d4cf` | `#c4703f` | near-black iron + copper |
| `graphite-dark` | dark | `#0f1115` | `#e2e4e9` | `#7aa2f7` | today's feel, hardened |
| `slate-medium` | dark | `#232833` | `#e6e9ee` | `#8ab4f8` | "light-ish dark" |
| `paper-light` | light | `#f4f2ee` | `#24262b` | `#a3622f` | warm paper + bronze |

Each theme carries a full 16-color ansi set with **deliberately desaturated
brights** (the muting is much of why metal reads professional, not neon).
Exact ansi values are authored per theme during implementation with the
contrast checker as the gate; the metals derive from their accent family, the
neutrals keep a corrected Tokyo-Night-adjacent set.

### 5. Tab & group color rendering (Michael's pick: stripe + optional fill)

Consumes `Tab.color`, `Tab.fill`, `Group.color` from layout_v2:

- **Tab stripe:** every tab row gets a solid **3 px left stripe** in its
  palette color at full opacity — never blended, always legible regardless of
  group color behind it. Replaces the color dot as the primary signal (the
  dot is removed).
- **Tab fill:** `fill: "subtle"` adds the tab color at ~8 % over the row
  surface; `"strong"` ~18 %; `"off"` (default) keeps the neutral surface.
  Set from the tab context menu (color submenu gains the three-way fill
  toggle).
- **Group frame:** a colored group renders a 1 px frame in its color down the
  group's left edge plus a ~8 % wash on the group's background region, so the
  group's blue is visible *between and beside* tabs — the exact "see the
  frame and sidewalls" ask. `color: null` renders today's neutral look.
- **Per-theme tab palette:** rendering resolves a tab's `PaletteId` through
  `theme.tabPalette ?? PALETTE_HEX`, so metals can tune the eight colors to
  harmonize (stored layout keeps stable ids — switching themes recolors
  nothing in the data).
- Active/hover states remain surface-tint based (`--surface-2/3`) so the
  stripe stays the color carrier.

### 6. Settings integration

`TermxSettings` gains `theme: ThemeId` (default `"gunmetal-brass"`), tolerant
parsing as usual. `SettingsDialog` gains a Theme section: six swatch cards
(bg/accent preview + name), click applies live. Since Michael explicitly
wants to flip between them while deciding, switching must not require any
confirmation or restart.

## Error handling

- Unknown `theme` id in settings → default theme (tolerant parsing already
  guarantees this shape).
- `deriveTokens` is total: any parseable hex produces a token set; an
  unparseable theme constant fails unit tests at build time, not runtime.

## Testing

- `contrast.ts`: known-ratio pins, binary-search convergence, both modes.
- `deriveTokens`: snapshot per theme; property test — every text token ≥
  4.5:1 and border token ≥ 3:1 against its background for all six themes.
- ThemeProvider: applies/updates tokens and xterm themes live (jsdom).
- Sidebar rendering tests: stripe color resolution incl. `tabPalette`
  override, fill strengths, group frame/wash, null-color group.
- Settings: theme field parse/default; SettingsDialog swatch selection.
- Visual gate (manual, Michael): flip through all six themes on a real
  workspace with a blue group + red tabs — the original complaint must be
  visibly fixed before this spec closes.
- Gates: ui `tsc -b` clean, vitest ≥ 751 baseline, e2e 5, cargo unchanged.

## Out of scope

User-authored theme files (the Warp-compatible YAML import is a noted
follow-up — the three-color schema was chosen to make it trivial later),
background images, gradients, per-pane themes, light-mode ANSI science beyond
the contrast gate.
