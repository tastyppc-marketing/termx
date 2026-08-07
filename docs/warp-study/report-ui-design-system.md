# Warp UI framework & design system — study report for TermX
### Agent study report (Opus, 2026-08-07) · verbatim archive · source: C:\Dev\warp-study

## 1. License verification
**Exactly two crates are MIT; everything else is AGPL-3.0-only.** Workspace default `Cargo.toml:26`; `crates\warpui\Cargo.toml:7` and `crates\warpui_core\Cargo.toml:7` declare MIT; all 78 other crates use `license.workspace = true`. Confirmed by `README.md:56-58`. **The parts TermX wants — theme tokens (`crates\warp_core\src\ui\theme\`), chrome (`app\src\`), `ui_components` — are all AGPL.** What TermX takes is non-copyrightable: color values, numeric scales, design ideas. **Rule: read AGPL files for ideas and numbers; write original CSS/TS; never transliterate.** Icon SVGs are AGPL creative assets — but they're Untitled UI icons (`pin-01`, `copy-05`, `x-close`...); pull the same icons from Untitled UI's free distribution instead.

## 2. Framework architecture (patterns only)
Hybrid: retained view objects ("analogous to a React component", `warpui_core\src\core\view\mod.rs:36-62`) + per-invalidation element-tree rebuild with **no diffing** (dirty view discards and rebuilds its subtree). Metal on macOS, wgpu elsewhere. Scene vocabulary is deliberately tiny — **rects (with corner_radius/border/drop_shadow/fill), glyphs, images, icons** — i.e. their primitive is a CSS box, which is why the design system ports to CSS almost losslessly. Layout is Flutter-style constraints, NOT flexbox (don't port layouts literally). Real signal system (`Tracked<T>` read-tracking → invalidation; Solid/MobX-ish).

**Composition pattern worth stealing:** `Component`/`Params`/`Options` triple — required props flat struct; optional props built from `Options::default(appearance)` and spread. Payoff: **defaults are theme-derived, not hardcoded** — in React: `{...optionsDefault(theme), disabled: true}`.

## 3. The design system
### 3a. Whole palette derived from three colors (most valuable finding)
A theme declares only **background, foreground, accent** (+16 ANSI colors). Every surface/border/text is computed by blending at fixed opacities (`theme\color.rs:428-604`):

- **Surface ramp** (bg + fg @ N%): surface_1 5% · surface_2 10% · surface_3 15% · neutral_4 20% · neutral_5 40% · neutral_6 (tooltip) 60% · neutral_7 90%
- **Overlay ramp** (translucent fg over content): 5/10/15/20/40/60/90. `outline()` = fg@10% is the universal border; pane divider = fg@15%.
- **Accent ramp:** 10/25/40/60. Selection = accent@25%.
- **Text ladder** (opacity on resolved font color): main 90 · sub 60 · hint 40 · disabled 20. Buttons: hover +10% fg, click +20% black.
- Semantic (only hardcoded RGB): warning `rgb(194,128,0)`, error `rgb(188,54,42)`, yellow `rgb(229,160,26)`, green `rgb(28,160,90)`; text selection `rgba(118,167,250,.4)`.

**The contrast guarantee:** `font_color()` runs a WCAG check against the actual background and **binary-searches opacity toward pure white/black until 4.5:1 (text) or 3:1 (non-text)** (`ui\color\contrast.rs:29-73`). Arbitrary user themes can never produce unreadable UI. ~40 lines; reimplement independently — the most valuable single thing to port.

### 3b. Theme definition/loading
User themes are **YAML in `~/.warp/themes/*.yaml`**:
```yaml
name: test_theme          # optional
accent: '#01a0e4'         # or {top,bottom}/{left,right} gradients
background: '#090300'
foreground: '#a5a2a2'
details: darker           # darker | lighter | custom opacity object
cursor: '#...'            # optional, defaults to accent
background_image: {path: bg.jpg, opacity: 30}   # optional
terminal_colors: {normal: {...8}, bright: {...8}}
```
`Fill` is serde-untagged (hex | vertical gradient | horizontal gradient). **Small enough for TermX to adopt verbatim → instant compatibility with the community Warp/iTerm theme ecosystem.** A schema is functional, safe to copy.

### 3c. Default palettes (colors not copyrightable — take freely)
From `app\src\themes\default_themes.rs`:

| Theme | bg | fg | accent |
|---|---|---|---|
| Dark (default) | `#050505` | `#ffffff` | `#19AAD8` |
| **Phenomenon** (flagship) | `#121212` | `#FAF9F6` | `#2E5D9E` |
| Adeberry | `#1D2022` | `#E4EEF5` | `#6C96B4` |
| Solar Flare | `#1B1C18` | `#DDE6EE` | `#34895C` |
| Gruvbox Dark | `#282828` | `#EBDBB2` | `#FC802D` |
| Dark City | `#01181F`→`#1A4551` grad | white | `#E9072D` |

**Phenomenon** is closest to the sign-shop direction: near-black `#121212`, warm off-white `#FAF9F6`, gold `#E5A01A` yellow; normal ramp black `#121212` / red `#D22D1E` / green `#1CA05A` / yellow `#E5A01A` / blue `#3780E9` / magenta `#BF409D` / cyan `#799C92` / white `#FAF9F6`; brights deliberately desaturated (`#AE756F`, `#789B88`, `#BD9F65`) — that muting is much of why it reads professional.

### 3d. Why Warp reads sharp, concretely
1. **Small radii, sparingly:** 4px default; 8px only modals; command blocks have NO radius and NO card. Nothing pill-shaped except dots.
2. **Hairline 1px borders at 10% fg, not shadows.** ONE shadow definition in the whole system (`0 10px 10px 30px rgba(0,0,0,.125)`), floating overlays only. Soft UIs separate with shadows; Warp separates with hairlines. Biggest lever.
3. **Separation by tint, not elevation:** same bg + 5/10/15% fg. No layered cards, glow, or blur except the 70%-black modal backdrop.
4. **Dense small type:** base UI 12px (line-height 1.2), overline/tooltips 10px, one 18px header. Tab bar/pane header 34px, icon buttons 24px, palette rows 28px.
5. **They're going further:** `NewTabStyling` flag → tabs radius **0** (square) with a 1px right border; `MinimalistUI` → 1px pane dividers, 0 block selection borders. Their designers concluded square + hairline > rounded + bordered.

Overline labels: `to_uppercase()` at 10px sub-color — but the framework has NO letter-spacing control. TermX should add tracking; that's what sells the sign-shop look.

## 4. Tab / pane / block chrome — density spec
- **Tabs:** bar 34px + 1px bottom border; 4px/8px padding; max width 200px, icon-only below 42px; active = fg@10%, hover = fg@5%, idle transparent; active border fg@20%, inactive 15%; close 20×20 r2 revealed on hover; overflow clips (no ellipsis).
- **Panes:** divider visually 1px (minimalist) or 2px at fg@15% with **+4px hit target each side**; unfocused panes dimmed by an fg@10% overlay (not opacity/filter); optional 2px accent focus border.
- **Blocks:** 1px full-width divider at fg@10%; **5px left "flag pole" stripe** carries state (AI/failure/subshell); **failure = full-width ANSI-red@10% wash + red stripe** (no icon/badge); restored fg@10%, AI fg@5%, selection accent@25%; **vertical spacing in line-heights** (normal 1.1 above prompt / 1.0 below output; compact 0.3/0.2) — port as `calc(var(--lh) * 1.1)`; hover reveals a right-aligned action pill (surface_1, r4, 26px icons, 34px tall), block body itself never tints on hover.

**Consolidated scales:**
| Scale | Values |
|---|---|
| Spacing | 2, 4, 6, 8, 12, 16, 20, 24, 28, 32 |
| Radius | 2, 3, **4 default**, 6, 8 (overlays), 50% (dots), **0 tabs/blocks** |
| Borders | 1px default; 2px focus/accent only |
| Heights | 34 (headers), 28 (rows), 24 (icon btns), 20 (close) |
| Font sizes | 10, **12 base**, 14, 18 |
| Opacity ramp | 5, 10, 15, 20, 25, 40, 60, 90 |

## 5. Directly reusable in a web UI
1. Theme YAML schema (§3b) verbatim.
2. Three-color derivation as CSS custom properties: `--surface-1: color-mix(in srgb, var(--fg) 5%, var(--bg))`; overlays `rgb(from var(--fg) r g b / 0.10)`. ~20 lines replaces their whole internal_colors module.
3. WCAG contrast fallback, reimplemented.
4. All palettes (§3c) — Phenomenon especially.
5. Icons: 383 SVGs on 24/16px grids, strokes converted to filled paths, color injected at render — web equivalent `mask-image: url(...); background: currentColor`. Names are Untitled UI's convention; pull from Untitled UI's free set for a clean license.
6. Fonts: Roboto UI / Hack mono — generic; an area to differentiate rather than copy.

**Three highest-leverage changes for a "too soft" React UI, in order:** (1) hairlines at 10% fg instead of shadows; (2) radii to 4px, tabs and blocks to 0; (3) 12px base font with 34px chrome rows. Those three account for most of the difference between Warp's look and a default-Tailwind look.
