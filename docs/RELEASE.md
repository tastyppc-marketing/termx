# Building a shippable TermX

v1 ships as a **portable pair**: `termx-ui.exe` + `termx-host.exe` in one folder.
No installer, no Tauri bundler. The UI resolves the host strictly beside its own
exe in release builds (`ui/src-tauri/src/bootstrap.rs`).

## Build

```powershell
# 1. UI — MUST go through the Tauri CLI (see warning below)
cd C:\Dev\TermX\ui        # any clone location works; paths here are illustrative
npx tauri build --no-bundle

# 2. Host — plain cargo from the repo root
cargo build --release --manifest-path ..\Cargo.toml -p termx-host
```

Outputs (note the two DIFFERENT target dirs — `termx-ui` is deliberately not a
member of the root workspace):

- `ui\src-tauri\target\release\termx-ui.exe`
- `target\release\termx-host.exe`

## Stage

Copy both exes into one folder. That folder is the product.

- No `portable.flag` → data lives in `%APPDATA%\TermX` (survives folder moves).
- Drop an empty `portable.flag` beside the exes → data lives in `data\` inside
  the folder (fully self-contained, clean first launch).

## Published updates

The status bar reads the running package version and checks the private
`tastyppc-marketing/termx` GitHub release catalog using the existing `gh` login.
No release, authentication/network failure, and up-to-date are separate states.
Checks run at startup and every six hours while the bar is enabled; click the
status to check again. An available update opens its GitHub release page for
download. TermX does not install updates or restart terminals automatically.

For a stable `v0.2.0` release, upload **TermX-0.2.0-windows-x64-portable.zip**
(or `arm64` for that architecture). The ZIP must contain both `termx-ui.exe`
and `termx-host.exe` together; it may include the `TermX.exe` UI alias. Do not
include `data/`, credentials, personal settings, or executable backups. Use the
exact `TermX-{version}-windows-{x64|arm64}-portable.zip` asset name, with an
uploaded, nonempty asset. Drafts, prereleases, source ZIPs, and individual EXEs
are deliberately not advertised as complete updates.

Version 0.2.0 adds a per-tab minimized-pane shelf and focused-session status.
New model metadata and safe directory changes need the new host and newly
instrumented sessions. Replace the portable pair after completing active work;
reopening only the UI keeps the old daemon and its sessions running.

## WARNING: never ship a bare-cargo UI build

`cargo build --release` inside `ui/src-tauri` WITHOUT the Tauri CLI (or without
`--features custom-protocol`) produces a broken exe: tauri-build emits
`cfg(dev)`, so the window loads the dev-server URL (`localhost:1420`) instead of
the embedded frontend and shows a connection-refused page. Verified 2026-07-26.

Do NOT verify a build by grepping the exe for `localhost:1420` — the config
(including devUrl) is embedded in ALL builds and the frontend assets are
brotli-compressed. Valid checks:

1. Newest `ui\src-tauri\target\release\build\tauri-*\output` contains no
   `cargo:rustc-cfg=dev` line (a correct build shows `custom_protocol`).
2. `termx-ui.exe` mtime is newer than that output file.
3. Launch it with no dev server running — the workspace must render.

## First-five-minutes smoke

Launch from the staged folder: window renders the workspace; `termx-host.exe`
appears in Task Manager (no console flash); `%APPDATA%\TermX\runtime.json` is
fresh. Then: type into a terminal (proves ConPTY + WS + CSP), open the folder
picker (proves the dialog capability shipped), split/rename/close, and
kill-the-UI → relaunch → sessions reattach with scrollback.

Known limits (BACKLOG §4): not multi-window-safe (two UIs fight over layout,
last writer wins); no `webviewInstallMode` configured (fine on Win11, matters
on a clean Win10 image).
