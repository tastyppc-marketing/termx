# Settings Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the overloaded settings modal with a full-screen sectioned settings surface, and add the two chat-view settings fields.

**Architecture:** New `SettingsSurface` takes over the workspace area (the `ConversationsFullscreen` pattern); sections are data (`SETTINGS_SECTIONS`); `SettingsStore`/`settings.ts` persistence unchanged; `SettingsDialog` deleted with its tests migrated.

**Tech Stack:** TypeScript (React 19), vitest + @testing-library/react, theme tokens.

**Spec:** `docs/superpowers/specs/2026-08-10-settings-window-design.md` — read first; authoritative. Also skim `2026-08-10-chat-view-design.md` §1 (consumer of the new fields — but do NOT implement anything from it; the chat lane runs in parallel and must not be touched here).

## Global Constraints

- Presentation change only: `settings_v1.json` format, tolerant parsing, and `SettingsStore` events unchanged (beyond the two new fields).
- New fields verbatim: `agentPaneDefaultView: "terminal" | "chat"` default `"terminal"`; `chatDefaultDensity: "chips" | "smart" | "full"` default `"smart"`.
- Section mapping exactly as the spec's table; every `TermxSettings` field appears in exactly one section, enforced by a completeness test.
- Theme tokens + hardening rules only (hairlines, 4 px radius, 28 px rows, 10 px/0.08em tracked overlines for section headers); no literal colors.
- `exactOptionalPropertyTypes` ON: `{...(x ? { x } : {})}`. No hardcoded absolute machine paths.
- Do NOT touch: `ui/src/chat/**` (does not exist yet — parallel lane), `TerminalPane`, `SplitLayout`, `WorkspaceController`, anything in `host/` or `src-tauri/`.
- Gates: `cd ui && npx tsc -b` clean; `npx vitest run --reporter=dot` ≥ 914 baseline + new, all green; `npx vitest run -c vitest.e2e.config.ts` ≥ 6 (needs the host binary — `cargo build -p termx-host` once from repo root in Git Bash after `export PATH="$HOME/tools/mingw64/bin:$HOME/.cargo/bin:$PATH"`).
- Never `git stash`; never junction/symlink into the main repo; one commit per task.

---

### Task 1: New settings fields

**Files:**
- Modify: `ui/src/settings/settings.ts`
- Test: `ui/src/settings/__tests__/settings.test.ts`

**Interfaces — Produces:**

```ts
export const AGENT_PANE_VIEWS = ["terminal", "chat"] as const;
export type AgentPaneView = (typeof AGENT_PANE_VIEWS)[number];
export const CHAT_DENSITIES = ["chips", "smart", "full"] as const;
export type ChatDensity = (typeof CHAT_DENSITIES)[number];
// TermxSettings gains:
//   readonly agentPaneDefaultView: AgentPaneView;   // default "terminal"
//   readonly chatDefaultDensity: ChatDensity;        // default "smart"
```

- [ ] **Step 1:** Failing tests (follow the exact pattern of the `maxGroupDepth` tests): defaults; junk values (`"bubble"`, `7`, missing) → defaults; round-trip when set. Also extend the SettingsStore equality regression suite so a change to ONLY one of the new fields fires listeners and persists (the bug class fixed in e5f0e5b).
- [ ] **Step 2:** Run `npx vitest run src/settings` — FAIL.
- [ ] **Step 3:** Implement with the existing guard-function pattern; add both fields to `SettingsStore`'s equality check.
- [ ] **Step 4:** Settings suite green.
- [ ] **Step 5:** Commit: `feat(settings): agentPaneDefaultView and chatDefaultDensity fields`.

### Task 2: SettingsSurface skeleton + section data

**Files:**
- Create: `ui/src/settings/SettingsSurface.tsx`, `SettingsSurface.css`, `ui/src/settings/sections.ts`
- Test: `ui/src/settings/__tests__/SettingsSurface.test.tsx`, `sections.test.ts`

**Interfaces — Produces:**

```ts
// sections.ts
export interface SettingsSection {
  id: "general" | "appearance" | "terminal" | "groups" | "conversations" | "chat";
  label: string;                       // "General", "Appearance", "Terminal", "Groups & Tabs", "Conversations", "Chat View"
  fields: readonly (keyof TermxSettings)[];   // which settings this section owns ("theme" lives in appearance)
}
export const SETTINGS_SECTIONS: readonly SettingsSection[];

// SettingsSurface.tsx
export function SettingsSurface(props: {
  store: SettingsStore;
  onClose: () => void;
}): JSX.Element;
```

Mapping per spec: general → onWindowClose, sleepHiddenTerminals; appearance → theme; terminal → defaultProfile, shellIntegration; groups → newTabPolicy, maxGroupDepth; conversations → conversationsRail, conversationsPalette, summaryEngine, summaryContent, summaryDisplay; chat → agentPaneDefaultView, chatDefaultDensity.

- [ ] **Step 1:** Failing tests: completeness — every key of `DEFAULT_SETTINGS` appears in exactly one section's `fields` (this test is the guard future batches trip over); surface renders the sidebar with all six labels; clicking a section shows its panel; Esc calls `onClose`; focus moves into the surface on mount and restores on close (mirror the dialog's existing focus tests).
- [ ] **Step 2:** FAIL → **Step 3:** implement skeleton (sidebar + panel shell, no real controls yet — panels render field names as placeholders visible only to tests via data-field attributes) → **Step 4:** green → **Step 5:** Commit: `feat(settings): full-screen SettingsSurface skeleton with section data`.

### Task 3: Migrate all controls, delete the dialog, reroute entry points

**Files:**
- Modify: `ui/src/settings/SettingsSurface.tsx` (+css), `ui/src/App.tsx` (replace `SettingsDialog` mount + `settingsOpen` wiring with the surface taking over the workspace area, same open triggers), any action/entry point referencing the dialog
- Delete: `ui/src/settings/SettingsDialog.tsx`, `SettingsDialog.css`
- Test: migrate `ui/src/settings/__tests__/SettingsDialog.test.tsx` → `SettingsSurface.test.tsx` (keep every behavioral assertion: each control renders, changing it persists through the store; the theme swatch cards move as-is)

- [ ] **Step 1:** Port each control into its section panel, preserving the control components/markup from the dialog wherever possible (this is a move, not a redesign). Theme swatches keep their live-apply behavior.
- [ ] **Step 2:** Migrate the dialog tests; delete the dialog files; `rg -n "SettingsDialog" ui/src` must return zero non-test hits (and zero test hits after migration).
- [ ] **Step 3:** App wiring: `settingsOpen` state now renders `SettingsSurface` over the workspace area (pattern-match how `ConversationsFullscreen` mounts); all previous open triggers (gear, action chip, shortcut) still work — assert in App tests.
- [ ] **Step 4: Full gates** — `npx tsc -b` clean; `npx vitest run --reporter=dot` ≥ 914 + new, all green; e2e ≥ 6 green.
- [ ] **Step 5:** Commit: `feat(settings): migrate controls to SettingsSurface, delete dialog`.

## Self-Review (done at plan time)

Spec §1→T2+T3, §2→T2 (data) + T3 (controls), §3→T1; error handling unchanged by design; every test in the spec's list mapped. Names consistent: `SETTINGS_SECTIONS`, `AgentPaneView`, `ChatDensity` used identically across tasks. No placeholders.
