# TermX

A stable, Warp-like terminal manager for Windows. Sessions live in a tiny Rust
daemon (`termx-host`) and survive UI crashes; the UI (Tauri, Milestone 2) is
disposable by design.

## Status

- [x] M1 — host core: ConPTY sessions, authenticated localhost WebSocket,
      capped ring-buffer scrollback, reattach-with-replay, state persistence
- [ ] M2 — UI shell: window, xterm.js, sidebar tabs/groups/colors
- [ ] M3 — folder picker | M4 — blocks + Ctrl+F | M5 — clickables
- [ ] M6 — split panes | M7 — palette/history/snippets | M8 — polish

Design spec: `docs/superpowers/specs/2026-07-17-termx-design.md`
Plans: `docs/superpowers/plans/`
Backlog: `BACKLOG.md`

Conversation launch capture and resume setup:
[Resume with original launch settings](docs/resume-launch-settings.md).

## Dev

Requires Rust (stable). This machine currently builds with the
`x86_64-pc-windows-gnu` toolchain + portable MinGW (see the toolchain note
below). From the repo root:

    cargo test -p termx-host          # full host suite (spawns real shells)
    cargo build -p termx-host         # target/debug/termx-host.exe

Run the host manually:

    cargo run -p termx-host           # data dir: %APPDATA%\TermX
    cargo run -p termx-host -- --data-dir X:\some\dir

`runtime.json` in the data dir has the port + auth token. A `portable.flag`
file beside the exe switches all storage to `<exe dir>\data`.

### Windows ConPTY notes (hard-won; do not regress)

- The PTY slave handles must stay alive until the child exits, or children
  die at startup with 0xC0000142 (wezterm/wezterm#4674). The waiter thread
  owns the slave.
- conhost sends `ESC[6n` (cursor-position query) during child console init
  and blocks until the hosting terminal answers. Headless sessions have no
  terminal, so the host's reader thread answers `ESC[1;1R` itself.
- Run `cargo test` with output redirected to a file, not a pipe — ConPTY
  children can inherit pipe handles and wedge pipelines.

## Portability

No absolute paths in source or config — the app folder can move between
machines. Storage: `%APPDATA%\TermX` (default) or `<exe dir>\data` (portable
mode) or `--data-dir <path>` (explicit).
