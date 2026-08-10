# TermX Settings Window — Design

**Date:** 2026-08-10 · **Status:** approved in brainstorm, pending spec review
**Companion spec (same batch):** `2026-08-10-chat-view-design.md`

## Goal

Settings move out of the piled-up modal dialog into a **full-screen settings
surface** with a sectioned sidebar — Michael's request verbatim: "the options
should be moved to its own entire window instead of a frame … and it should
have its own dedicated section" (the dedicated section being Chat View).
Full-screen *inside* the TermX window (the `ConversationsFullscreen` pattern),
not a separate OS window — same relief from the cramped modal, none of the
multi-window state-sync risk.

## Background

- `ui/src/settings/SettingsDialog.tsx` is a single modal frame currently
  holding ~12 controls (newTabPolicy, shellIntegration, defaultProfile,
  conversations toggles, summary engine/content/display, sleep, close
  behavior, maxGroupDepth, theme picker) — visibly overloaded.
- `ui/src/settings/settings.ts` + `SettingsStore.ts` (tolerant per-field
  parsing, change events) stay exactly as they are — this is a presentation
  change only, plus the new chat-view fields.
- `ConversationsFullscreen` demonstrates the take-over-the-workspace surface
  pattern (mount over `.app-workspace`, Esc/back returns).

## Design

### 1. Surface

New `ui/src/settings/SettingsSurface.tsx` (+ css): replaces the workspace
area while open (header stays). Left sidebar of sections; right side scrolls
the active section's controls. Esc, a back button, and the existing
open-settings action toggle it. `SettingsDialog` is deleted; every entry
point (sidebar gear, action chip, keyboard) routes to the surface. Focus
handling and dialog semantics follow the existing dialog's a11y behavior
(focus trap becomes surface-scoped focus, restore on close).

### 2. Sections and control mapping (all existing controls migrate; none dropped)

| Section | Controls |
|---|---|
| **General** | onWindowClose, sleepHiddenTerminals |
| **Appearance** | theme picker (six swatch cards) |
| **Terminal** | defaultProfile, shellIntegration |
| **Groups & Tabs** | newTabPolicy, maxGroupDepth |
| **Conversations** | conversationsRail, conversationsPalette, summaryEngine, summaryContent, summaryDisplay |
| **Chat View** | new fields below |

Sections are data (`SETTINGS_SECTIONS` array: id, label, control list) so
future batches add sections without layout surgery. Styling on theme tokens,
hardening rules (hairlines, 4 px radius, 28 px rows, tracked overlines for
section headers).

### 3. New settings fields (consumed by the chat-view spec)

```ts
// tolerant parsing, existing guard-function pattern
readonly agentPaneDefaultView: "terminal" | "chat";   // default "terminal"
readonly chatDefaultDensity: "chips" | "smart" | "full"; // default "smart"
```

## Error handling

Unchanged from today: settings file parsing is per-field tolerant; the
surface renders whatever the store holds; a malformed file never blocks
opening settings.

## Testing

- Section mapping test: every `TermxSettings` field appears in exactly one
  section (a completeness test that fails when someone adds a field without
  placing it).
- Surface tests: open/close/Esc/focus-restore; each section renders its
  controls; a change persists through `SettingsStore` (reuse the dialog's
  existing test approach); new-field parse/default/tolerance tests.
- Existing `SettingsDialog` tests migrate to the surface rather than being
  deleted wholesale.
- Gates: ui tsc clean; vitest ≥ 914 baseline + new; e2e ≥ 6.

## Out of scope

Separate OS-level settings window; settings search; import/export;
per-project settings.
