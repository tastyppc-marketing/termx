# Menubar + plugin placement + autostart — design

**Status:** approved in chat 2026-09-02 (Michael: "I like the full menubar the most"; placement model presented in the mockup, not objected to — strike anything here that misreads it). Mockup: `scratchpad\batch2\menubar-options.html` (artifact fdcfd547).

## Why

Plugins are only reachable through Settings → Plugins → Open, which is an extra trip every time. Michael wants (1) a top navigation menubar, (2) plugins launchable from it, (3) a per-plugin answer to "where does this open" — some are dedicated windows, some split into the current tab, some both — with resizing that restructures instead of cramming, and (4) an option for a plugin (Showroom) to start with TermX.

## Scope

In: the menubar (Workspace · View · Plugins · Settings) in every TermX window; the Plugins launcher; manifest `surfaces` + `minSize`; the size rule; the `data-compact` hint; per-plugin autostart; the window surface via existing tear-out.

Out (explicitly): new keyboard shortcuts (the menu prints only bindings that exist today); cross-window settings propagation (pre-existing gap, its own batch); plugin OS windows that *interact* with each other; zoom.

## The menubar

Lives in the header row after the window name, separated by a 1px vertical hairline (`--divider`). Items are 11px, `letter-spacing: .04em`, `--text-sub`; hover → `--text-main`; the open item is `--text-main` with a 2px `--accent` rule flush against the header's bottom hairline (the register mark). Direction B chrome: square dropdowns, `--surface-2`, 1px `--border`, `--shadow-overlay`, 28px rows, 10px overline section headers — the `PaneFlyout.css` recipe.

Behaviour: click opens; while one menu is open, hovering another label switches to it; Esc, click-outside, or picking an item closes. Only one open at a time. Arrow keys move between rows; Left/Right move between menus; Enter activates. Menu items call the same controller actions the rail and context menus call — no parallel implementations.

**Workspace:** New tab · Open folder as tab… (Ctrl+Shift+O) · Split right (Ctrl+Shift+D) · Split down (Ctrl+Shift+E) · Close pane (Ctrl+Shift+W) · ─ · New window · Rename window (F2) · ─ · Save session…
Rows whose action needs a live pane (splits, close pane) are disabled when there is none.

**View:** Side rail · Conversations rail (Ctrl+Shift+R palette exists; the rail toggle is the `conversationsRail` setting) · Status bar. These are the toggles that exist or are trivially added as settings; each shows its state (`on`/`off`) in the right column. "Side rail" and "Status bar" are new boolean settings (`sideRail`, `statusBar`, both default true) in `settings.ts` + the Appearance section.

**Plugins:** see below.

**Settings:** a direct item (no dropdown) that opens the settings surface.

## Plugins launcher

Section "Registered", one row per registry entry: icon, name, status dot (`--ok` up · `--error` registered-but-down · `--text-disabled` disabled), and on the right the **placement chips**. Disabled plugins render in `--text-disabled` with "Enable in Settings…" instead of chips; clicking them opens Settings → Plugins. A plugin with autostart on shows `· starts with TermX` in `--text-hint` after its name. Bottom: divider, "Manage plugins…" → Settings › Plugins.

Chips are the plugin's allowed surfaces, 9px bold overline in 1px `--divider` boxes; the default surface is filled `--accent-25`. A surface the plugin does not allow is not drawn (the mockup's dashed chip was illustrative; drawing what you cannot click is noise).

Click the row → open on the default surface. Click a chip → open on that surface. If the plugin is already open anywhere (any window), focus it instead of opening a second pane, **unless** the click is on a chip for a surface where it is not yet open and the plugin is not a singleton pane — singletons always focus. In an aux window the actions forward to main over the bus exactly like `openPluginTab` does today.

## Placement model

Two new manifest fields, both optional and tolerant:

```json
"surfaces": { "default": "split", "allowed": ["tab", "split", "window"] }
"minSize":  { "width": 360, "height": 240 }
```

- `surfaces` absent → `{ default: "tab", allowed: ["tab", "split"] }` (Showroom and Recall keep working unchanged). `default` must be in `allowed`; otherwise the default falls back to the first allowed and the manifest carries a **`warning`** (a separate field from `problem`, shown as its own amber chip in Settings). *Amended 2026-09-02 during build:* a warning gates nothing — `problem` is what removes Open/Enabled, and a typo in `surfaces.default` must never make a plugin unrunnable.
- *Amended 2026-09-02:* `openPlugin` takes an optional third argument, `at?: PluginOpenTarget` (the group a rail create-menu was opened on, or the tab + pane a split-menu was opened on), so the rail keeps opening into the right place. The menubar never passes it.
- `minSize` absent → `{ width: 320, height: 200 }`.
- Surfaces: `tab` = `openPluginTab`; `split` = `openPluginSplit` on the focused pane; `window` = open as a tab then `moveItemToWindow(item, "new")` in one structural transaction (or one bus forward from aux).

One controller entry point, `openPlugin(pluginId, surface?)`, owns the policy; the menu, the rail's plugin menus and PluginsPanel's Open all call it.

## Size is a rule, not a squeeze

When a split is requested, the controller measures the room the focused pane would leave (the pane's current box halved along the requested axis, less the divider) against `minSize`:

| Room for the split | Result |
|---|---|
| ≥ minSize | split as asked |
| too narrow but tall enough (pane box height ≥ 2·minHeight) | split *down* instead |
| neither | open as a **tab** and set the notice: "Recall needs 360×240 to split — opened as a tab." |

The measurement comes from the pane's live box (the SplitLayout already knows pane sizes; expose the focused pane's box on the snapshot or via a controller accessor — implementer's call, but it must be the real box, not a fraction times window width).

`PluginPane` sets `data-compact="width"` / `"height"` / `"both"` on its root when its box is under the plugin's minSize, and clears it when it grows back. TermX never resizes a pane below minSize on the plugin's behalf; the attribute is the plugin's cue to restack (its CSS: `[data-compact] …`). Recall and the template get a compact stylesheet as part of this batch (Lane B follow-up, not TermX).

## Start with TermX

Registry entry gains `autostart: boolean` (absent → false), parsed tolerantly in `registry.ts` and written by `PluginsStore.setAutostart(id, on)`. PluginsPanel shows a second toggle per row, "Start with TermX", enabled only when the row is enabled and healthy-able (same predicate as the Enabled toggle's "problem === null"). At boot the MAIN window calls `ensureUp` for every enabled entry with `autostart` true, after the existing boot prune and before/independent of any pane binding; failures land in the plugin's health as today (the row shows the offline card's reason in Settings). Aux windows never autostart (single-writer / main-only lifecycle rule). Health polling keeps an autostarted plugin in the "rendered here" set for main so it is polled and healed like a bound one.

## Dedicated windows

`window` surface reuses the tear-out path: the plugin pane becomes a tab, the tab moves to a new aux window. It appears in the rail under Plugins like any other pane. Closing that window returns nothing to main (the pane closes; the plugin server stays up per the existing lifecycle rules — a singleton stays up for the next open). No new window type, no new bus ops for the window surface itself. *Amended 2026-09-02 (review round 3):* the singleton race across windows needed one main→aux answer, so the plugin-pane channel gained `{ kind: "pluginPanes", op: "rejected", sessionIds }` — main refuses a second singleton bind at adopt and says so, instead of letting the aux wait out the adopt timeout. It is parsed in the unbind branch (same shape); main ignores its own echo.

## Data / files

- `ui/src/plugins/manifest.ts` — `surfaces`, `minSize` (types, parse, defaults, `default ∈ allowed` warning).
- `ui/src/plugins/registry.ts` — `autostart`; store setter.
- `ui/src/settings/settings.ts` + `sections.ts` — `sideRail`, `statusBar` (Appearance).
- `ui/src/settings/PluginsPanel.tsx` — autostart toggle; Open → `openPlugin`.
- `ui/src/workspace/WorkspaceController.ts` — `openPlugin(pluginId, surface?)`, size rule, boot autostart.
- `ui/src/plugins/PluginPane.tsx` — `data-compact`.
- NEW `ui/src/menubar/Menubar.tsx`, `Menubar.css`, `menus.ts` (item models), `PluginsMenu.tsx`.
- `ui/src/App.tsx` — mount the menubar; `sideRail`/`statusBar` gating.
- `ui/src/sidebar/Sidebar.tsx` — its plugin submenus call `openPlugin` (behaviour unchanged for default surface).

## Testing

Menubar: open/close/switch-by-hover/Esc/click-outside/keyboard nav; each item invokes the controller action with the right args; disabled states. Plugins menu: rows from registry + manifests, status dots, chips reflect `surfaces`, click-row default, click-chip surface, disabled → Settings, already-open focuses, aux forwards over the loopback bus harness. Manifest parse: defaults, `default ∉ allowed` warning, minSize defaults. Size rule: table above, with real pane boxes. `data-compact` set/cleared. Autostart: parse, store setter, PluginsPanel toggle predicate, main-only boot ensure (aux never), health poll includes autostarted plugin. Settings: new booleans parse + sections completeness guard. Gates unchanged (non-incremental tsc, full vitest, cargo if Rust touched).

## Risks

- The two lanes meet at `openPlugin`: its signature is fixed here (`openPlugin(pluginId: string, surface?: "tab" | "split" | "window"): Promise<void>`) so the menu can be built against it before the policy lands.
- Real pane box measurement in jsdom: tests inject a measurer; the production measurer reads the pane element's rect.
- "Already open anywhere" needs the plugin-pane bindings across windows (`plugin_panes_v1.json` is main-owned; aux reads its replica) — use the bindings, not DOM.
