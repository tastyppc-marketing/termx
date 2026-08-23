# TermX Design Language — Research & Direction Candidates

**Date:** 2026-08-22
**Status:** Decision-ready. Pick one direction in §4; §6 is the implementation contract.
**Scope:** Research + proposals only. No code was changed.

---

## 1. Current-state inventory

### 1.1 What exists and works

TermX already has a real theme engine, and it is better than most of what the research turned up.

**Colour is fully derived.** `ui/src/theme/themes.ts` defines six themes as *data* — `bg`, `fg`, `accent`, plus a 16-colour ANSI set. `ui/src/theme/deriveTokens.ts` expands those three colours into the entire CSS custom-property set in TypeScript (surfaces at 5/10/15% blends, border 10%, divider 15%, a 90/60/40/20% text ladder, an accent ramp at 10/25/40/60%), and every derived value passes through `ensureContrast()` against WCAG floors (4.5 text, 3 non-text) *before it renders*. `ThemeProvider.applyTheme()` writes them all as one style-attribute write on `<html>`, so switching is instant with no reload.

This is very close to Linear's headline move — they collapsed 98 theme variables down to three inputs (base, accent, contrast) generated in LCH, and got accessible high-contrast variants for free ([Linear: How we redesigned the UI](https://linear.app/now/how-we-redesigned-the-linear-ui)). TermX is at three inputs already. The contrast gate is arguably ahead of them.

**The hardening pass landed.** `styles.css` shows the "less soft" work: `--radius: 4px` (down from something larger), terminal panes and sidebar rows explicitly `border-radius: 0` with comments saying so, the background glow gradient deleted ("separation is by hairline, not by atmosphere"), and exactly one shadow in the app — `--shadow-overlay`, reserved for floating overlays with a comment forbidding its use elsewhere. Section headers use a consistent overline treatment: 10px, uppercase, `letter-spacing: 0.08em`.

That last detail is worth calling out because two independent design systems converged on it: Linear flips to **+0.02em tracking** for 11–12px uppercase labels while everything larger gets *negative* tracking, and Raycast uses **+0.4px** on its 12px caption tier. TermX's 0.08em is in the right family and is the single most "sign-shop" thing in the current CSS.

### 1.2 What blocks a design-template preset

**Structural tokens have no provider.** `deriveTokens()` returns **colour only**. Everything structural — `--radius`, `--radius-overlay`, `--row-chrome` (34px), `--row-list` (28px), `--icon-button` (24px), `--shadow-overlay` — is a hardcoded literal in the `:root` block of `styles.css`. There is no `deriveStructure()`, no template type, nothing in `TermxSettings` to select one. This is the actual gap, and it is a small, clean one to fill (§6).

**Three token groups don't exist at all**, which is what would break a template today:

- **No spacing scale.** Padding is ad-hoc literals across 24 CSS files: `8px`, `6px 8px`, `20px`, `0 12px`, `3px 6px 3px 8px`, `10px 12px`, `7px 10px`, and ~20 more distinct declarations. A "density" preset has nothing to turn.
- **No border-width token.** `1px solid var(--border)` is written literally **140 times**. There are also 4 × `3px` (the tab colour stripe), 2 × `2px` (the focused-pane ring), 1 × `6px` (colour swatch frame). A template that wants hairlines heavier, lighter, or off has 140 edits.
- **No motion tokens.** `120ms ease`, `130ms ease`, `0.3s` are literals scattered through Sidebar, SplitLayout, and TerminalPane.

**Radius is already disciplined**, which is good news: 93 uses of `var(--radius)`, 11 of `var(--radius-overlay)`, 15 explicit `0`, 3 × `50%` (dots), 2 split-radius shorthands for the button pair. One value swap moves the whole app.

**Raw palette colours have leaked past the rule.** `styles.css` states "Nothing but this block may declare a raw palette colour," but three files violate it, and they will not follow a theme switch *or* a template:

| File | Lines | What |
|---|---|---|
| `connection/ConnectionBanner.css` | 10–13, 19–21, 35–49 | 12 raw hex values — the whole banner is hardcoded amber/red |
| `terminal/TerminalPane.css` | 130–157 | `#394253`, `#cbd5e1`, `rgba(23,27,34,.94)`, `#f6d889`, `#665521`, `rgba(30,35,44,.98)` — the "load earlier" bar and the sleeping chip |
| `viewer/Viewer.css` | 214–233 | `rgb(255 255 255 / 14%)`, `#dfe2e8`, `#f4c2ba`, `#713b42` |

These should be fixed regardless of which direction wins. On `paper-light` they are currently wrong.

**The frame Michael wants gone lives in four places**, not one — worth knowing before anyone edits:

```
styles.css       .app-main             padding: 10px          ← the outer gutter
styles.css       .terminal-host        border: 1px solid      ← the frame itself
SplitLayout.css  .split-pane           padding: 2px           ← per-pane gutter
SplitLayout.css  .split-pane--focused::after   border: 2px accent, inset 2px   ← full ring
TerminalPane.css .terminal-pane        border: 1px solid      ← a second frame
```

So the terminal currently sits inside **two** 1px borders plus 12px of combined padding, and when focused gains a third 2px ring. That is the "framed card" language — the same one Wave Terminal uses (2px accent border, 8px radius, 3px gaps). Removing the right/bottom frame by hand means touching all five rules; tokenising it (§6) makes it one preset value.

---

## 2. What the best tools actually do

Research covered Warp, Ghostty, Wave Terminal, VS Code, Zed, Linear, and Raycast. Sources are linked inline. The patterns below are the ones worth stealing — mechanisms, not assets.

### 2.1 The two available languages for content edges

There is a genuine fork here, and every tool picks a side:

**Edge-to-edge (Ghostty, Zed, VS Code classic).** Ghostty ships `window-padding-x: 2`, `window-padding-y: 2` — essentially no inset — and the grid runs to the window edge with no radius and no card. VS Code's terminal is full-bleed with exactly one exception: `padding-left: 20px` for a gutter, with the scrollable element offset back by `-20px` so the grid starts right of the gutter without clipping. Zed's editor is full-bleed and its *gutter background matches the editor background exactly*, so there is no visible left rail at all.

The generalisable rule comes from Android's edge-to-edge guidance and describes what all three do: **backgrounds and divider lines draw edge-to-edge; text and interactive targets are inset.** ([developer.android.com](https://developer.android.com/design/ui/mobile/guides/layout-and-content/edge-to-edge))

**Framed cards (Wave, VS Code's new "Modern UI").** Wave puts every block in a 2px-bordered, 8px-radius card with a 3px gap between blocks. VS Code's experimental Modern UI module does the same to the editor part: 1px border, 8px radius, and — critically — *deletes the shadow when it adds the border*, with the source comment "with that border above the shadow is redundant and would double up."

**Michael has already chosen edge-to-edge** by removing the right/bottom frame. Every direction below assumes it.

### 2.2 Two mechanics worth stealing verbatim

**VS Code's `contrastBorder` pattern.** In `baseColors.ts`, `contrastBorder` resolves to `null` in normal themes and `#6FC3DF` in high-contrast themes. Components unconditionally write `border: 1px solid var(--vscode-contrastBorder)`; in normal themes that resolves to nothing. **One variable flips the entire app between "separation by background value" and "separation by hairline."** Paired with it: `activeContrastBorder` aliases to `focusBorder`, and the activity bar uses **solid outline = selected, dashed outline = hover, same colour**, both at `outline-offset: -1px` so the box never grows.

This is exactly the mechanism a design-template preset needs. It is a `--stroke` token by another name.

**Never change geometry on a state change.** Zed's theme schema has six border tokens — `border`, `border.variant`, `border.focused`, `border.selected`, `border.disabled`, and **`border.transparent`**. The existence of a *named transparent border token* is the tell: layout reserves the 1px permanently and state only swaps its colour. Wave does the same thing differently — its inactive pane border is the same 2px stroke at 10% alpha, so nothing shifts by a pixel when focus moves. VS Code's Modern UI editor border sets `box-sizing: border-box` explicitly so the border "sits inside the area the grid already allocates, avoiding a relayout."

TermX's `.split-pane--focused::after` already does this correctly (a pseudo-element, `pointer-events: none`, absolutely positioned). Good. But `.sidebar-tab--active` swaps `border-color` on a permanently-reserved 1px border — also correct. Keep both patterns.

### 2.3 Active-pane signalling — four options, ranked by restraint

| Tool | Mechanism |
|---|---|
| **Zed** | **Nothing by default.** `active_pane_modifiers` ships `border_size: 0.0`, `inactive_opacity: 1.0`, `magnification: 1.0`. Dimming and borders are opt-in settings. Zed relies on cursor presence and tab-bar state. |
| **Ghostty** | Opacity wash only. `unfocused-split-opacity` (range 0.15–1, default slightly faded ~0.7); `unfocused-split-fill` sets what it dims *toward*. No accent, no border. |
| **Warp** | Dim inactive panes **+ a triangle indicator in the top-left corner of the active pane.** Cheap and unusual. |
| **Wave** | Full 2px accent border around the active card; inactive is the same stroke at 10% alpha. |
| **TermX today** | Full 2px accent ring, inset 2px — the Wave language, the heaviest of the four. |

VS Code's tab equivalent is the most restrained of all and worth quoting precisely: **`tab.activeBorderTop` draws a 1px accent line on the top edge of the active tab only; nothing else changes.** It is not a CSS border — it is an absolutely-positioned 1px child div, `pointer-events: none`, z-indexed above the tab background. Three refinements: the same slot at **2px** means a *different* state (unsaved file), and the line is suppressed under `:not(:focus)` so the keyboard focus outline is never ambiguous.

### 2.4 Elevation in dark UI

VS Code's shadows are **light-theme-only**. The `.part.editor::after` inset-shadow rule that makes the sidebar appear to float is gated behind the `.vs` (light) class. Alphas across their whole ramp run 0.02–0.15. In dark themes there is **no part elevation at all.**

Linear uses no drop shadows for elevation — the shadows that exist are inset rings (`rgb(35,37,42) 0 0 0 1px inset`), and outer shadows are reserved for true overlays. Raycast is the same: card depth is a paired inset ring, and outer shadows only on overlays.

The honest cost, stated well in the [Linear teardown](https://identityforge.io/learn/linear-design-system): **"shadows communicate depth pre-attentively; hairlines do not."** You trade instant, non-conscious depth perception for density and calm. Atlassian's counter-position is that dark mode should keep *both* because "shadows can be harder to see in dark mode" is a reason to supplement, not delete ([atlassian.design](https://atlassian.design/foundations/elevation)).

**TermX's current rule — one shadow token, overlays only — matches the Linear/Raycast/VS Code-dark consensus.** Do not change it.

### 2.5 Density, spacing, and the radius trap

**Linear:** 4px base, scale `4 / 8 / 12 / 16 / 24 / 32 / 48 / 96`. Control padding sits deliberately in an **8–12px band**, explicitly contrasted with mainstream frameworks' 16–24px. Radius scale `2 / 4 / 6 / 8 / 12 / pill` with a **hard ceiling of 12px in product chrome** (the marketing site goes higher; the app does not).

**Raycast:** command-palette rows are `padding: 6px 10px`, `border-radius: 6px` — about a 32–36px row. Selection is a **filled, rounded, inset row**, not a left accent bar, and the highlight is inset from the panel edge by the list's own horizontal padding.

**Zed:** `ui_font_size: 16` is *larger* than `buffer_font_size: 15`. Counterintuitive and deliberate — Zed keeps chrome legible and instead *removes* chrome elements. Minimap off by default; the one toolbar item off by default is code actions.

**The nested-radius trap** matters for TermX specifically. The formula is `r_inner = r_outer − gap`; two rounded rects only look parallel when their radii differ by exactly the distance between them, otherwise "the gap between the two curves looks fatter at the diagonal than along the straight edges, and the inner corner reads slightly pinched" ([the concentric border-radius rule](https://dev.to/sgbp/the-concentric-border-radius-rule-why-nested-rounded-corners-look-slightly-wrong-3hog), [Cloud Four](https://cloudfour.com/thinks/the-math-behind-nesting-rounded-corners/)).

The formula is a *tax*: every nesting level burns radius, so a system that rounds everything is forced into either non-concentric corners or square inner elements. Zed and Raycast both dodge it structurally — Zed keeps panels and editor at **0px** and rounds only small elements; Linear's 12px ceiling exists so the inner radius can stay positive. **The rule to adopt: round at most one level, and let the container be the square one.** TermX is already doing this by accident (`--radius: 4px` on controls, explicit `0` on panes and rows). Make it a stated rule.

### 2.6 The anti-pattern, from Warp's own users

This is the most useful finding in the whole research pass. From the [HN thread on Warp open-sourcing](https://news.ycombinator.com/item?id=47937349):

> "looks more or less too flat with just maybe 2 main colors and just one font variant, feels like big pile of flat text — hard to see what is header what is footer and sometimes what is button."

> "I always ended up with the same feeling as my initial impression: overwhelming."

The failure mode is precise: **a chrome-heavy UI that refuses to use value and weight contrast becomes unreadable *because* it's flat.** If TermX adds chrome, it has to pay for it with value/weight contrast, not just more surfaces. And the welcome/empty state is named as a specific liability — Warp's "giant popup to upsell the Oz agents."

The one Warp element people consistently praise: *"The vertical tabs are a game changer, having all my projects down the side."* TermX already has that.

Ghostty's praise runs the other way — it earns it by inventing **no chrome at all**, borrowing native window decorations, tabs, and splits. Its consistent complaint is the absence of a settings GUI. Its design position is a legitimate option, but it is not available to TermX (which is a *manager*, not just an emulator) and it isn't what Michael is asking for.

### 2.7 Typography

Linear: Inter Variable, weights **400 and 510 only** — "bold in the 700 sense is functionally absent." Tracking scales with size and *inverts* for micro-labels:

```
48px+                    -0.022em
20–32px                  -0.012em
13–17px                  -0.010em
11–12px UPPERCASE        +0.02em   ← flips positive
```

Their stated prohibitions, verbatim: **"No gradients. No drop shadows. No second accent colour. No font-weight above 510."**

Raycast independently lands on the same uppercase rule (+0.2 to +0.4px on dark), and uses body weight **500, not 400**, because it sets at small optical sizes on near-black.

Wave splits UI and mono deliberately: Inter 14px for chrome, Hack 12px for the grid — a 2px gap so chrome text doesn't compete with the terminal.

TermX is at Inter 12px base with `font-weight: 400`, uses 600/650/700 in places, and its overlines are at 0.08em. The 700s are the outlier relative to both reference systems.

### 2.8 Motion

Zed ships **essentially no UI transitions.** There is no animation or transition-duration setting in the entire settings reference. The public position is that responsiveness *is* the animation — GPUI targets 120 FPS with sub-millisecond input latency ([zed.dev/blog/videogame](https://zed.dev/blog/videogame)).

Linear publishes no duration table but claims keyboard shortcuts are processed in **under 50ms**, faster than a click path. VS Code's sash (split divider) tints on hover over `0.1s ease-out`. Ghostty animates almost nothing — a ~200ms quick-terminal reveal and a 750ms resize HUD, and the resize HUD is *suppressed on the first resize* and shown thereafter.

Matt Ström-Awn's [UI Density](https://mattstromawn.com/writing/ui-density/) gives the framing that makes this a design argument rather than a performance one: **temporal density is a density axis** — "the faster the interface responds to actions and loads new pages, the more dense the UI is." Zed's zero-animation stance and Linear's 50ms budget are density decisions.

TermX's current 120–130ms transitions are in the right band. The 300ms values (none currently, but Wave uses them) would not be.

### 2.9 Small mechanics worth a line each

- **Inset hairlines with first-child suppression** (VS Code Modern UI `paneHeaders.css`): section separators are `::before` pseudo-elements inset 4px from each side, and `:first-of-type` never draws one. Makes dense chrome read as calm without adding whitespace.
- **Inset list rows, pinned scrollbar** (VS Code Modern UI `padding.css`): rows get `left/right: 4px; width: auto` so the hover/selection highlight has a margin from the pane edge, **while the scrollbar stays pinned to the edge.** High value, low cost.
- **Divider yields to hover** (Wave `tab.scss`): `.tab:hover + .tab .tab-divider { display: none }` — the separator between two tabs disappears when the adjacent one is hovered, so the hover surface is never bisected.
- **Padding balance** (Ghostty `window-padding-balance`): when the viewport doesn't divide evenly by cell size, split the leftover across all four edges instead of dumping it on one. Directly applicable to an xterm grid.
- **Ghost vs solid elements** (Zed): `ghost_element.background` is transparent but `ghost_element.hover` is a real colour — two rest states, one hover vocabulary. TermX's hover-revealed action trays are this pattern already.
- **Typed right-aligned accessory slot** (Raycast `List.Item.accessories`): metadata is a typed slot, not free-form markup, which is why every Raycast list looks the same. And: **accessories are suppressed entirely when a detail pane is open.**
- **Empty state degrades rather than cramps** (VS Code `editorgroupview.css`): the shortcut list is hidden when the group is short or non-primary; the empty state falls back to logo-only.
- **Auto-hide the mouse cursor while typing** (Zed `hide_mouse: "on_typing_and_action"`). Pure chrome removal, near-zero cost.

---

## 3. Reading of Michael's taste, restated as constraints

Working backwards from "too soft," "sign-shop sharpness," "remove the right/bottom frame," and "attractive and inviting":

1. **Square containers, non-negotiable.** Panes, rows, rails, sections. Radius is permitted only on small controls, and only at one level.
2. **Chrome lives on the left rail and top rail. Nothing else.** Content bleeds to the window edge on the right and bottom.
3. **Separation is by hairline and by value, never by atmosphere.** No glow, no gradient, no shadow outside overlays. This is already the stated rule in `styles.css`; the directions below keep it.
4. **"Inviting" must come from typography, rhythm, and precision — not from softness.** This is the load-bearing constraint. The Warp criticism is the exact trap: sharp-and-flat reads as cold and illegible. Warmth has to be bought with value contrast, weight contrast, and consistent alignment, or the result will be rejected for the opposite reason the last pass was.
5. **Whatever wins must be expressible as tokens**, because the end goal is a selectable preset.

---

## 4. Three design directions

All three assume: content edge-to-edge on right and bottom; chrome on left + top rails only; one accent; overlay-only elevation; colour stays the theme's job.

---

### Direction A — "Machine Shop"

**The thesis:** maximum crispness. Zero radius anywhere in the app, including controls. Every boundary is a 1px hairline. Uniform tight density. The accent appears *only* on focus and active states — never as decoration. This is the most literal possible reading of "sign-shop sharpness."

**Tokens**

```
--stroke: 1px            --stroke-strong: 1px
--radius: 0              --radius-control: 0        --radius-overlay: 0
--space-1: 2px  --space-2: 4px  --space-3: 6px  --space-4: 8px  --space-5: 12px
--row-chrome: 30px       --row-list: 24px           --icon-button: 22px
--content-inset: 0
--frame-left: 1px  --frame-top: 1px  --frame-right: 0  --frame-bottom: 0
--active-pane-edge: 2px  --inactive-pane-opacity: 1
--focus-ring: 1px        --focus-ring-offset: -1px
--motion-fast: 0ms       --motion-base: 80ms
--font-ui: 12px          --weight-normal: 400       --weight-strong: 600
--overline-size: 10px    --overline-tracking: 0.08em
```

**Chrome:** left rail gets `border-right: 1px`. Top rail gets `border-bottom: 1px`. Nothing else in the app draws an outer frame. `.app-main` padding drops to 0; `.terminal-host` and `.terminal-pane` lose their borders entirely; splits are separated by a single 1px divider with no gutter (VS Code's terminal model exactly).

**Active pane:** a 2px accent bar on the **top edge of the pane only**, drawn as a `pointer-events: none` pseudo-element inside the pane box (VS Code's `tab.activeBorderTop` mechanism). Inactive panes are *not* dimmed. Single-pane layouts draw nothing, as today.

**Hover/focus:** hover is a `color-mix(--fg 4%)` background wash, exactly as today. Focus is a **1px solid** inset outline at `offset: -1px`; hover on a selectable item is the **same colour, dashed** (VS Code's high-contrast vocabulary). No geometry ever changes.

**Empty state:** the square accent mark, a 14px title, and a keyboard-shortcut definition list in the overline treatment. Degrades to mark-only below 478px height.

**Motion:** state changes are instantaneous (0ms). Only overlay entry animates, at 80ms ease-out. Reduced-motion kills that too.

**Why it fits:** it is the sharpest thing available and cannot be called soft by anyone. Zero-radius everywhere removes the nested-radius problem by construction. It is also the *cheapest* to implement — `--radius: 0` is a one-value change that propagates to 93 call sites.

**Risks**
1. **This is the Warp failure mode with the volume turned up.** Zero radius + flat weights + one accent is precisely "big pile of flat text — hard to see what is header what is footer and sometimes what is button." A 22px icon button with no radius and no border is visually indistinguishable from a label.
2. **"Inviting" is at maximum risk.** There is nothing in this direction that produces warmth; it is all subtraction. Michael's other stated goal goes unserved, and the likely feedback is "now it's cold."
3. **24px list rows with 2px spacing is tighter than every reference tool** (Raycast ~32–36px, VS Code 32px modern / 35px classic). Long sidebars become hard to scan, and the 3px tab colour stripe starts to dominate a 24px row.

---

### Direction B — "Drafting Table" ★ recommended

**The thesis:** the geometry is square and the structure is hairline-thin, but the *rhythm* is deliberate. Containers are square; radius survives at exactly one level (4px, controls only). Content is edge-to-edge. What makes it inviting is typographic and spatial precision — a tracking ramp, a disciplined weight pair, inset hairlines, consistent alignment — rather than any softening. Draughtsman's crispness: hard lines, but drawn with care and generous margins where they earn it.

**Tokens**

```
--stroke: 1px            --stroke-strong: 2px
--radius: 0                          /* containers, panes, rows, rails */
--radius-control: 4px                /* buttons, inputs, swatches, icon buttons */
--radius-overlay: 4px                /* menus, dialogs, palettes */
--space-1: 2px  --space-2: 4px  --space-3: 8px  --space-4: 12px  --space-5: 16px  --space-6: 24px
--row-chrome: 34px       --row-list: 28px           --icon-button: 24px
--content-inset: 0
--frame-left: 1px  --frame-top: 1px  --frame-right: 0  --frame-bottom: 0
--pane-gap: 1px                      /* hairline divider, no gutter */
--active-pane-edge: 2px  --inactive-pane-opacity: 0.88
--focus-ring: 2px        --focus-ring-offset: -2px
--motion-fast: 100ms     --motion-base: 130ms       --motion-ease: cubic-bezier(0.2, 0, 0, 1)
--font-ui: 12px          --font-mono: 12px          --line-height: 1.4
--weight-normal: 400     --weight-strong: 600       /* nothing above 600 */
--overline-size: 10px    --overline-tracking: 0.08em
--body-tracking: -0.006em
--list-inset: 4px                    /* rows inset; scrollbar stays pinned */
--hairline-inset: 8px                /* section separators inset from both ends */
```

**Chrome:** left rail `border-right: var(--stroke)`. Top rail `border-bottom: var(--stroke)`. Right and bottom of the content area draw nothing — the terminal grid runs to the window edge. `.app-main` padding → 0. `.terminal-host` and `.terminal-pane` borders → 0. Splits are separated by a single 1px divider (`--pane-gap`) with no gutter; the divider keeps its 6px invisible hit target and tints to accent on hover over `--motion-fast`.

**The one inset:** the xterm grid keeps `padding: 8px`, and gains `padding-left: 12px` — VS Code's gutter rule ("all terminals have at least 20px left padding") scaled down. Text never kisses the window frame even though the background does. This is the Android edge-to-edge rule: *backgrounds bleed, glyphs inset.*

**Active pane:** replace the current 2px full ring with a **2px accent bar on the pane's top edge only**, drawn as a `pointer-events: none` pseudo-element inside the box so geometry never shifts. Additionally, inactive panes wash to `opacity: 0.88` (Ghostty's mechanism, gentler than their ~0.7 default). Single-pane layouts draw neither. The bar reads as a "this one is live" tab stub rather than a cage, which is what makes the frame removal feel intentional rather than merely absent.

**Sidebar rows:** keep the 3px solid tab-colour stripe on the left edge — it is the single best thing in the current UI and it is exactly Raycast's accessory discipline applied to colour. Rows get `--list-inset: 4px` on each side so hover and selection highlights have a margin from the pane edge **while the scrollbar stays pinned to the edge**. Section separators become inset hairlines (`::before`, `left/right: var(--hairline-inset)`), and the first section in a scroll region draws none.

**Hover/focus:** hover = `color-mix(--fg 4%)` wash (unchanged). Active = `--surface-2` fill plus the three non-stripe borders swapping to `accent 14%` (unchanged — this is already right). Focus = 2px accent outline at `offset: -2px`, inset so nothing grows. Hover on a *selectable* item where a solid outline would be ambiguous uses the same colour dashed.

**Typography:** the Linear discipline, adapted. Weights **400 and 600 only** — every current 650 and 700 drops to 600, which alone removes a chunk of the "shouty flat" quality. Body gets `-0.006em` tracking; 10px uppercase overlines keep `+0.08em`. UI stays 12px; the mono grid stays at the user's terminal size. Section overlines keep their current treatment unchanged — it is already the strongest element.

**Empty states:** the square accent mark at `--icon-button × 1.5`, an 18px/600 title, one line of 12px body, and a keyboard-shortcut list in overline treatment. It degrades to mark + title when the pane is short. No promotional content, ever — this is Warp's named liability.

**Motion:** 100ms for micro-interactions (hover tints, tray reveals), 130ms for anything that moves or resizes, `cubic-bezier(0.2, 0, 0, 1)` ease-out. Nothing above 130ms. `prefers-reduced-motion` collapses everything to 0.01ms, as today.

**What stays theme-coloured vs structural:** the template owns **only** geometry, density, motion, and type structure. It never names a colour. `--accent`, all surfaces, the text ladder, the semantic triplet, and the tab palette remain the theme's exclusive property. That separation is what lets six themes × N templates all be coherent.

**Why it fits:** it keeps every hardening decision already made (square panes, hairline separation, one shadow, overline headers) and answers the two open asks precisely — the right/bottom frame becomes a token set to 0, and "inviting" is delivered by the tracking ramp, the weight pair, the inset rows, and the deliberate 8/12/16/24 rhythm rather than by rounding anything. The 4px control radius is the concession that keeps buttons reading as buttons, and because containers are all 0, the nested-radius tax is never paid.

**Risks**
1. **The 4px control radius is the compromise most likely to be rejected.** If Michael reads any radius as soft, the direction degrades to A on that one axis. Mitigation: `--radius-control` is a single token; setting it to 0 turns B into A-with-better-rhythm without touching anything else.
2. **`opacity: 0.88` on inactive panes is a genuine cost.** It dims *terminal output*, not chrome — including error text you might be trying to read in a background pane. Ghostty ships this and people turn it off. Mitigation: ship it as `--inactive-pane-opacity` with 1.0 available, and consider defaulting to 1.0 with the top-edge bar carrying the whole signal.
3. **Edge-to-edge terminal against a hard window edge can look unfinished on Windows**, where there is no rounded window mask to soften the corner and no drop shadow from the compositor in all configurations. The bottom-right corner in particular will show the terminal grid terminating flush against the frame. Mitigation is the 8px xterm padding (glyphs never touch), but the *background* will, and that is the intended look — worth confirming visually before committing.

---

### Direction C — "Instrument Panel"

**The thesis:** invert the value relationship. Chrome is *lighter* than content, so the terminal reads as a dark aperture cut into a lighter instrument face — this is Zed's actual model (chrome `#3b414d`, editor `#282c33`, and the active tab background is *identical* to the editor background, making the active tab a hole cut in the chrome rather than a highlighted rectangle). Rails carry a background-value shift instead of relying on hairlines; structure is heavier and more visible; density is tighter.

**Tokens**

```
--stroke: 1px            --stroke-strong: 2px
--radius: 0              --radius-control: 0        --radius-overlay: 2px
--space-1: 2px  --space-2: 4px  --space-3: 6px  --space-4: 10px  --space-5: 14px
--row-chrome: 32px       --row-list: 26px           --icon-button: 24px
--rail-surface: var(--surface-2)     /* rails are a full value step above content */
--content-surface: var(--bg)
--frame-left: 0  --frame-top: 0      /* value shift replaces the hairline */
--frame-right: 0 --frame-bottom: 0
--active-pane-edge: 3px  --inactive-pane-opacity: 1
--focus-ring: 2px        --focus-ring-offset: -2px
--motion-fast: 0ms       --motion-base: 100ms
--weight-normal: 400     --weight-strong: 600
--overline-size: 10px    --overline-tracking: 0.10em
```

**Chrome:** the left rail and top rail are painted `--surface-2` — a full 10% value step above the terminal background — and need **no border at all**, because the value change is the separation. The active tab in the rail is painted `--bg` (the terminal's own colour), so it reads as a window through the panel into the content. This is Zed's exact move and it is the single most distinctive idea in this direction.

**Active pane:** a 3px accent bar on the pane's top edge — heavier than B, because with lighter chrome around it a 2px line loses weight. No dimming.

**Why it fits:** "sign shop" as a literal metaphor is a painted panel with cut lettering, and this is the direction that actually builds that: a solid faceplate with apertures cut into it. It also solves the "inviting" problem differently and more robustly than B — value contrast between chrome and content does the work that hairlines do in A and B, which is exactly the fix for Warp's flatness complaint. Zed's One Dark keeps only ~19 luminance points between chrome and editor and it reads as calm, not stripey.

**Risks**
1. **It fights the current derivation.** `--surface-2` is `fg` blended into `bg` at 10%. On `paper-light`, "lighter chrome" means *darker* chrome, and the aperture metaphor inverts confusingly. This direction needs `--rail-surface` to be mode-aware in `deriveTokens`, which is real work and a real correctness risk.
2. **A lighter left rail is a large, always-on bright region** in a tool used at night in a dark room. Two of six shipped themes are quite dark (`dark-iron` at `#101113`, `graphite-dark` at `#0f1115`); a 10% lift across a 252px column is a lot of glare.
3. **Biggest departure from what's shipped**, so the highest chance of a "this isn't TermX anymore" reaction — and the hardest to reverse, since it changes what backgrounds mean rather than just how thick the lines are.

---

## 5. Recommendation

**Direction B, "Drafting Table."**

The reasoning, in order:

**It is the only direction that serves both stated goals.** A is sharp but has no answer to "inviting" — it is subtraction all the way down, and the research gives a named, documented failure mode for exactly that (Warp's users describing a flat, chrome-heavy UI as an unreadable "pile of flat text"). C answers "inviting" well but does it by changing what backgrounds mean, which is a bigger bet than the brief calls for.

**It preserves every decision already made.** Square panes, hairline separation, the single overlay shadow, the overline treatment, the 3px tab colour stripe, the 120–130ms motion band — all of it survives and gets *tokenised* rather than revisited. The hardening pass is not thrown away; it is finished.

**It makes the frame removal read as intentional.** Simply deleting the right/bottom border leaves a pane that looks like it lost something. Moving the active-pane signal from a full ring to a top-edge bar (VS Code's `tab.activeBorderTop` mechanism) reframes the whole thing: chrome now demonstrably lives on two edges, and the pane's top bar is the third piece of that same logic rather than a leftover cage.

**A and C stay reachable from it.** Because everything is a token, "Machine Shop" is B with `--radius-control: 0`, tighter `--row-*`, and 0ms motion. That is a second preset, not a rewrite. C is a genuinely different theme-level change and should be treated as a later experiment, not a launch option.

**The one decision to make deliberately:** whether `--inactive-pane-opacity` ships at 0.88 or 1.0. I lean **1.0** — let the top-edge bar carry the entire signal, and expose the dim as an opt-in, which is exactly what both Zed and Ghostty concluded. Dimming live terminal output is the kind of thing that is charming for a week and annoying for a year.

---

## 6. How this becomes a "design template" preset

### 6.1 The architecture, mirroring what already works

The colour system's shape is the right shape. Duplicate it for structure.

```
ui/src/theme/
  themes.ts          THEMES: Record<ThemeId, TermxTheme>          ← colour data (exists)
  deriveTokens.ts    deriveTokens(theme) → colour tokens          ← exists
  templates.ts       TEMPLATES: Record<TemplateId, TermxTemplate> ← NEW, structural data
  deriveStructure.ts deriveStructure(template) → structural tokens ← NEW
  ThemeProvider.tsx  applyTheme(themeId, templateId)              ← extend: one more loop
```

`applyTheme()` already writes N custom properties in a single style-attribute pass on `<html>`. Extend it to write the structural set in the same pass and set `root.dataset.template = template.id` alongside the existing `data-theme`. The existing `onThemeChange` subscriber mechanism (used by running xterm instances to retint) generalises to template changes for free — panes need it, because `--row-chrome` and pane padding changes must trigger a `fit()`.

**The invariant that keeps this clean:** `deriveStructure()` may never return a colour, and `deriveTokens()` may never return a length. Enforce it in a test the same way `sections.test.ts` already enforces settings completeness — assert that every value from `deriveStructure` matches `/^[\d.]+(px|ms|em|%)?$|^cubic-bezier|^0$/` and that no key overlaps the colour set. This is the guard that stops the two systems from rotting into each other.

### 6.2 The token groups a preset must own

Based on what is currently hardcoded in `styles.css` and scattered through the 24 component stylesheets:

| Group | Tokens | Currently |
|---|---|---|
| **Stroke** | `--stroke`, `--stroke-strong`, `--stripe-width` | Literal `1px` × 140, `2px` × 2, `3px` × 4 |
| **Geometry** | `--radius`, `--radius-control`, `--radius-overlay` | `--radius: 4px`, `--radius-overlay: 8px` in `:root` |
| **Rhythm** | `--space-1` … `--space-6` | **Does not exist.** ~30 distinct ad-hoc padding declarations |
| **Density** | `--row-chrome`, `--row-list`, `--icon-button`, `--sidebar-indent` | In `:root` (34/28/24px); `--sidebar-indent` has a 12px fallback in Sidebar.css |
| **Frame** | `--frame-left`, `--frame-top`, `--frame-right`, `--frame-bottom`, `--content-inset`, `--pane-gap`, `--list-inset`, `--hairline-inset` | **Does not exist.** Frame is 5 hardcoded rules across 3 files |
| **Signalling** | `--focus-ring`, `--focus-ring-offset`, `--active-pane-edge`, `--inactive-pane-opacity` | Literals in SplitLayout.css and Sidebar.css |
| **Elevation** | `--shadow-overlay`, `--overlay-blur` | `--shadow-overlay` in `:root`; `blur(3px)` literal × 3 |
| **Motion** | `--motion-fast`, `--motion-base`, `--motion-ease` | Literal `120ms`/`130ms ease` throughout |
| **Type structure** | `--font-ui`, `--line-height`, `--weight-normal`, `--weight-strong`, `--overline-size`, `--overline-tracking`, `--body-tracking` | `font-size: 12px` in `:root`; weights and tracking are per-rule literals |

Note that `--shadow-overlay` and `--overlay-blur` sit awkwardly across the line — a shadow has a colour in it. Keep the shadow token's *colour* fixed (`rgb(0 0 0 / 38%)` works on every theme because it is a true black scrim) and let the template own only its offsets and blur radius, or simply let the template own the whole string as the one documented exception. The latter is simpler and honest.

### 6.3 Wiring into settings

Three small edits, all following existing patterns:

1. **`settings/settings.ts`** — add `readonly designTemplate: TemplateId;` next to `theme`, with a matching `DEFAULT_SETTINGS` entry and an `isTemplateId()` guard in the parse function (line ~229 has the pattern verbatim).
2. **`settings/sections.ts`** — add `"designTemplate"` to the `appearance` section's fields. `sections.test.ts` fails if a field lands in zero or two sections, so this is enforced.
3. **`settings/SettingsSurface.tsx`** — a second `settings-subsection` under Appearance, rendering template cards the same way the theme cards render. The theme cards preview their own palette rather than the running one; the template cards should do the equivalent — a small static SVG or a div sketch showing rail + top bar + content with that template's actual `--stroke`, `--radius`, and `--row-list` applied inline, so density and squareness are legible before selection.

The template picker belongs **above** the theme picker in the Appearance panel, because structure is the more fundamental choice.

### 6.4 Prerequisite work (do this first, independent of direction)

None of this is optional for a working preset system, and all of it is worth doing anyway:

1. **Fix the raw-hex leaks** in `ConnectionBanner.css` (12 values), `TerminalPane.css` (8 values), and `Viewer.css` (5 values). They already break `paper-light`. They will break every template too. This is the highest-value cleanup in the list and is a pure bug fix.
2. **Introduce `--stroke`** and mechanically replace the 140 literal `1px` border declarations. Tedious but trivially verifiable — the rendered output should be pixel-identical before any template ships.
3. **Introduce the `--space-*` scale** and migrate padding. This is the largest chunk of work and the one that actually unlocks density presets. It can be done file-by-file; `Sidebar.css` and `SettingsSurface.css` are the highest-value targets.
4. **Introduce `--motion-fast` / `--motion-base`** and replace the ~20 duration literals.
5. **Tokenise the frame** — the five rules in `styles.css`, `SplitLayout.css`, and `TerminalPane.css` become `--frame-*` and `--pane-gap` reads. This is what makes "remove the right/bottom border" a preset value rather than a diff.

Steps 1 and 5 deliver visible value immediately and can ship before the template system exists. Steps 2–4 are the enabling refactor.

### 6.5 Suggested shipped presets

| Id | Name | What it is |
|---|---|---|
| `drafting-table` | Drafting Table | Direction B. Default. |
| `machine-shop` | Machine Shop | Direction A. `--radius-control: 0`, tighter rows, 0ms state changes. |
| `comfortable` | Comfortable | B with `--row-list: 32px`, `--space-*` one step up, `--font-ui: 13px`. The density dial Michael will want on a large monitor, and the cheapest possible third preset. |

Three is the right number to launch with. `instrument-panel` (Direction C) is a fourth candidate but should wait, because it needs mode-aware surface derivation that the other three do not.

---

## 7. Sources

**Terminals:** [Warp appearance docs](https://docs.warp.dev/terminal/appearance/) · [Warp custom themes](https://docs.warp.dev/terminal/appearance/custom-themes/) · [HN: Warp open-sourcing](https://news.ycombinator.com/item?id=47937349) · [Ghostty config reference](https://ghostty.org/docs/config/reference) · [Ghostty: about](https://ghostty.org/docs/about) · [HN: Ghostty native chrome](https://news.ycombinator.com/item?id=47206009) · [Wave Terminal config](https://docs.waveterm.dev/config) · [waveterm source](https://github.com/wavetermdev/waveterm) (`theme.scss`, `block.scss`, `tab.scss`, `tabbar.scss`)

**VS Code:** [theme-color reference](https://code.visualstudio.com/api/references/theme-color) · [microsoft/vscode source](https://github.com/microsoft/vscode) (`baseColors.ts`, `multieditortabscontrol.css`, `editorgroupview.css`, `terminal.css`, `sash.css`, `contrib/modernUI/browser/media/*`) · [design token ramp, issue #305618](https://github.com/microsoft/vscode/issues/305618) · [tab density, issue #193981](https://github.com/microsoft/vscode/issues/193981)

**Zed / Linear / Raycast:** [Zed theme schema v0.2.0](https://zed.dev/schema/themes/v0.2.0.json) · [Zed One Dark](https://github.com/zed-industries/zed/blob/main/assets/themes/one/one.json) · [Zed visual customization](https://zed.dev/docs/visual-customization) · [Zed: 120 FPS](https://zed.dev/blog/videogame) · [Linear: A calmer interface](https://linear.app/now/behind-the-latest-design-refresh) · [Linear: How we redesigned the UI (II)](https://linear.app/now/how-we-redesigned-the-linear-ui) · [Linear design system as constraints](https://identityforge.io/learn/linear-design-system) · [Raycast List API](https://developers.raycast.com/api-reference/user-interface/list)

**Principles:** [Matt Ström-Awn: UI Density](https://mattstromawn.com/writing/ui-density/) · [Atlassian: elevation](https://atlassian.design/foundations/elevation) · [Mastering elevation for dark UI](https://medium.muz.li/mastering-elevation-for-dark-ui-a-comprehensive-guide-04cc770dd0d6) · [Cloud Four: math behind nesting rounded corners](https://cloudfour.com/thinks/the-math-behind-nesting-rounded-corners/) · [The concentric border-radius rule](https://dev.to/sgbp/the-concentric-border-radius-rule-why-nested-rounded-corners-look-slightly-wrong-3hog) · [Android: edge-to-edge](https://developer.android.com/design/ui/mobile/guides/layout-and-content/edge-to-edge) · [Designing for cognition: high-density interfaces](https://www.lippihom.com/blog/designing-for-cognition-the-enduring-value-of-high-information-density-interfaces)
