# Multi-Window TermX (Tear-Out Tabs) — Design

**Date:** 2026-08-26 · **Status:** approved in direction (Michael), spec awaiting review
**Ask (verbatim):** "the ability to drag these terminal panes from the rail into its own separate window. That way, I could have possibly two or three screens that I work off of… three term-x windows that I'm working off of, so that way I can be monitoring each one of them."

## Goal

Move a tab (or a whole group) out of the main TermX window into its own OS window, so 2–3 monitors can each show live terminals. Sessions must survive every move untouched — a tear-out is a re-parenting, never a restart.

## Approved shape (from chat, 2026-08-26)

- **Phase 1 — "Move to new window":** context-menu action on tabs and groups. No literal dragging yet.
- **Phase 2 — literal drag-out:** dropping a rail drag outside the window bounds spawns a window at the cursor. Pure polish on Phase 1's plumbing.
- Secondary windows get the **full UI** (rail, status bar, footer) — consistent, and the rail can be dragged narrow.
- **Closing a secondary window returns its items to the main window.** Closing a window never kills sessions.
- **Relaunch restores every window** with its contents and bounds.

## Why the daemon needs no changes

- `termx-host` already accepts any number of authenticated WS connections (per-connection auth gate, `server.rs`).
- Session output is a `tokio::sync::broadcast` channel — attachments are not exclusive, and each window brings its own connection and its own attachments.
- Layout persistence is already daemon-side (`SetLayout` / `GetState`), so windows share one source of truth for free.

Each secondary window is simply another full TermX UI (same `index.html`) that connects to the same daemon. Session ownership rule for v1: a session's pane renders in exactly one window at a time (the layout guarantees this structurally, since a tab lives in exactly one window slot).

## Layout model: `layout_v3`

Today (`layout_v2`): one tree — `{ rootItems, groups, tabs, activeTabId }`, one implicit window.

v3 wraps window membership around the same structures:

```
{
  "version": 3,
  "tabs": { ... },            // unchanged pool
  "groups": { ... },          // unchanged pool
  "windows": {
    "main":  { "rootItems": [...], "activeTabId": "...", "bounds": null },
    "aux-1": { "rootItems": [...], "activeTabId": "...", "bounds": { x, y, w, h, monitor } }
  }
}
```

- **Migration:** a v2 blob loads as v3 with everything in `windows.main`. A v3 blob read by an old build fails parse and falls back exactly as malformed layouts do today (orphan adoption) — acceptable because Michael runs staged builds forward-only; `.prevN` rollback across this boundary loses window assignment, not sessions.
- `bounds` is recorded on move/resize (debounced) so relaunch restores positions. `monitor` is advisory; if the monitor is gone, the window opens clamped to the nearest visible area.

## Single-writer rule (the race that would otherwise bite)

Two windows writing `SetLayout` blobs concurrently is last-writer-wins data loss. v1 avoids merge logic entirely:

- **The main window is the only `SetLayout` writer.**
- Secondary windows never mutate layout directly; they forward mutations (move tab, rename, recolor, split changes…) to main over the Tauri in-app event bus (`emit`/`listen`, already a dependency — `listen` is imported in App.tsx today).
- Main applies the mutation to the full v3 model, persists once, and the updated state fans back out to every window the same way.
- The main window closing closes the app (standard behavior today); secondary windows are children in lifecycle terms, so "main is gone but aux writes are pending" cannot arise.

This costs one hop of latency on mutations made from a secondary window and buys total immunity from write races.

## Window lifecycle

- **Create:** "Move to new window" allocates `aux-<n>`, writes the item into that window slot, then opens a `WebviewWindow` with URL `?window=aux-<n>`. The new window bootstraps normally, reads state, and renders only its slot.
- **Adopt:** at boot, main opens first, reads state, and spawns one window per populated `aux-*` slot at its recorded bounds.
- **Close:** an aux window's close is intercepted (CloseGuard pattern already exists); its `rootItems` are appended to `windows.main.rootItems`, the slot is deleted, layout persists, the window closes. Sessions never notice.
- **Crash/kill of an aux window:** its slot survives in the layout; next boot re-opens it. (A "window that no longer exists" is indistinguishable from "not booted yet", which is the correct default.)

## What stays per-window vs shared

| Concern | Scope |
|---|---|
| HostClient connection, reconnect machine, attachments | per window |
| Attention flash (`requestUserAttention`) | per window — the window owning the finished tab flashes |
| SleepController (hidden-pane sleep) | per window |
| Settings, themes, conversations stores | shared files, loaded per window (read-mostly; settings writes are last-writer-wins and idempotent — acceptable) |
| Layout mutations | main window only (single-writer rule) |

## Phase 1 UI surface

- Tab context menu: **"Move to new window"**, and **"Move to window N"** entries for each existing aux window.
- Group context menu: the same pair, moving the whole group.
- No drag semantics change in Phase 1.

## Phase 2 (after Phase 1 ships and settles)

- The existing rail `pointerDrag` gains an "outside the window" drop target: releasing beyond the window bounds emits the same "move to new window" mutation with a spawn position at the cursor's screen coordinates.
- Cross-window rail drag (dragging from one window's rail into another's) is explicitly out of scope until someone misses it.

## Testing

- Layout v3 parse/migrate/serialize round-trips, including v2→v3 adoption and slot-return-on-close, as pure-function tests.
- Single-writer forwarding: controller-level tests that aux mutations produce forwarded events, not `SetLayout` calls.
- Window lifecycle against a fake window factory (spawn/close/bounds), no real Tauri in tests.
- Live verification: move a Claude Code tab to a second window, confirm the session stream continues uninterrupted, close the window, confirm the tab returns to main alive.

## Out of scope

- Rendering one session in two windows at once (daemon supports it; UI semantics don't need it).
- Per-window settings/themes.
- Detachable single panes (the unit of tear-out is the tab; pop-out-pane-to-tab already exists and composes).
