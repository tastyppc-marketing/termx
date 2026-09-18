# Releasing TermX

TermX ships as one NSIS installer, `TermX-Setup-<version>-x64.exe`, attached
to a GitHub release in the private repository `tastyppc-marketing/termx`.
A release is cut with one local command; GitHub Actions builds, probes and
publishes it. Installed copies pick the new release up through the in-app
updater, which is described in `docs/updates.md`.

## What ships

- One asset per release, `TermX-Setup-<version>-x64.exe`, on the tag
  `v<version>`. Stable semver only: the updater ignores drafts, prereleases
  and any other tag shape.
- The installer is per-user (NSIS `currentUser` mode). There is no admin
  prompt and the default location is `%LOCALAPPDATA%\Programs\TermX`.
- The installed folder holds exactly four files: `termx-ui.exe` (the app),
  `termx-host.exe` (the terminal daemon), `termx-output.exe` (the output
  helper) and `uninstall.exe`. No `data\` folder, no `portable.flag`, no
  JSON. Per-user state is created in `%APPDATA%\TermX` on first launch, so a
  fresh install starts empty by construction.
- Tauri names the main exe after the crate, `termx-ui.exe`, not `TermX.exe`,
  and installs the `externalBin` sidecars without their target-triple suffix.
  The UI's sidecar lookup (`ui\src-tauri\src\bootstrap.rs`) accepts the bare
  name first and the triple-suffixed names after it, so the installed layout
  and a hand-assembled portable folder both resolve.
- WebView2 is fetched by the evergreen bootstrapper when a machine lacks it
  (`webviewInstallMode: downloadBootstrapper` in `tauri.conf.json`).
- The installer is unsigned. Windows SmartScreen shows "Windows protected
  your PC" on the first run. The release notes template tells people to
  click "More info", then "Run anyway". The workflow carries a signing step
  that is a no-op until a certificate exists.

## Cut a release

From a clean checkout of `main`, at the repo root:

```powershell
powershell -NoProfile -File tools\release.ps1 -Version 0.3.0 [-Force] [-Notes path\to\notes.md]
```

The script refuses to run when any of these hold:

- the version is not of the form `X.Y.Z`
- the working tree is dirty
- the current branch is not `main`
- the tag `v<version>` already exists locally or on `origin`

Then it does the following, in order:

1. Decides whether the daemon changed by running `git diff --quiet <previous v* tag> -- host/`.
   With no previous tag it assumes the host changed.
2. Runs `tools\version.ps1 -Version <version>` and refreshes both `Cargo.lock`
   files with `cargo update -w` (root workspace and `ui\src-tauri`).
3. Runs the version-sync test `ui\src\__tests__\versionSync.test.ts` and
   stops if the four manifests disagree.
4. Writes `RELEASE-NOTES.md` at the repo root: the machine marker lines
   first, then the body from `-Notes` or from
   `tools\RELEASE-NOTES.template.md`. Without `-Notes` it pauses so you can
   edit the file, and continues when you press Enter. Keep the `termx-*`
   lines at the top.
5. Commits `chore(release): v<version>`, creates the annotated tag, pushes
   `main` and then the tag.

`-Force` adds `termx-update: force` to the notes. Every older install then
has to update before work can continue, so use it only for releases that an
older UI cannot safely run against.

Watch the build at https://github.com/tastyppc-marketing/termx/actions. When
it finishes, the release exists with the installer attached and a body that
ends in `termx-sha256: <hex>`. Confirm with:

```powershell
gh release view v0.3.0 --repo tastyppc-marketing/termx --json assets,body
```

## What CI does

`.github/workflows/release.yml` runs on every pushed `v*` tag, on
`windows-latest`:

1. Checks that the tag version equals the version in `ui\src-tauri\tauri.conf.json`.
2. Runs `npm ci` in `ui\`.
3. Builds the sidecars with `cargo build --release -p termx-host --bin termx-host --bin termx-output`
   and copies them to `ui\src-tauri\binaries\termx-host-x86_64-pc-windows-msvc.exe`
   and `ui\src-tauri\binaries\termx-output-x86_64-pc-windows-msvc.exe`.
   This runs before the gates because the Tauri crate does not compile, tests
   included, until those two files exist.
4. Gates: `npx tsc -p tsconfig.app.json --noEmit --incremental false` and
   `npx vitest run` in `ui\`, `cargo test --workspace` at the root, and
   `cargo test` in `ui\src-tauri`.
5. Runs `npx tauri build` in `ui\`, which emits
   `ui\src-tauri\target\release\bundle\nsis\TermX_<version>_x64-setup.exe`.
6. Copies that file to `TermX-Setup-<version>-x64.exe`, computes its SHA-256
   and appends `termx-sha256: <hex>` to `RELEASE-NOTES.md`.
7. Clean-slate probe: installs the asset in passive mode into a temporary
   folder (`/P /NS /D=<temp>`), fails when the result contains
   `portable.flag`, a `data` folder or any `.json` or `.jsonl` file, and fails
   when `termx-ui.exe`, `termx-host.exe` or `termx-output.exe` is missing.
8. Publishes with `gh release create v<version> --title "TermX v<version>" --notes-file RELEASE-NOTES.md TermX-Setup-<version>-x64.exe`
   using the workflow token. A failed step leaves no release behind.

## Release body markers

The updater reads three lines from the release body. Each must start at the
beginning of a line. Case does not matter. Only the first well-formed digest
counts.

| Line | Written by | Meaning |
|---|---|---|
| `termx-sha256: <64 hex>` | CI, after the build | Required. A release without it is invisible to the updater. |
| `termx-update: force` | `release.ps1 -Force` | Older installs must update before they can continue. |
| `termx-host: changed` | `release.ps1`, when `host/` differs from the previous tag | The daemon has to be restarted after the update to finish it. |

## Version sync

Four manifests declare the version and must agree:
`ui\src-tauri\tauri.conf.json`, `ui\package.json`, `ui\src-tauri\Cargo.toml`
and `host\Cargo.toml`. Only `tools\version.ps1` changes them (it also rewrites
the two root version entries of the npm lock file in `ui\`). The vitest test
`ui\src\__tests__\versionSync.test.ts` fails when they drift, and CI refuses a
tag whose version does not match `tauri.conf.json`.

## Build the installer locally

The bundle declares `termx-host` and `termx-output` as `externalBin`, so the
Tauri crate needs the sidecar files before it will compile at all. That
applies to `cargo test` and `cargo build` in `ui\src-tauri` as well as to
`npx tauri build`. The folder `ui\src-tauri\binaries\` is gitignored.

```powershell
# 1. Sidecars, from the repo root (termx-output is a second bin of the termx-host package)
cargo build --release -p termx-host --bin termx-host --bin termx-output
New-Item -ItemType Directory -Force ui\src-tauri\binaries | Out-Null
Copy-Item target\release\termx-host.exe   ui\src-tauri\binaries\termx-host-x86_64-pc-windows-msvc.exe
Copy-Item target\release\termx-output.exe ui\src-tauri\binaries\termx-output-x86_64-pc-windows-msvc.exe

# 2. Installer, from ui\
npx tauri build
```

The installer lands at
`ui\src-tauri\target\release\bundle\nsis\TermX_<version>_x64-setup.exe`. To
inspect it without touching your real install, run it into a scratch folder
and list the result:

```powershell
.\TermX_0.3.0_x64-setup.exe /P /NS /D=<scratch folder>\TermX-probe
```

Expect `termx-ui.exe`, `termx-host.exe`, `termx-output.exe` and
`uninstall.exe`, nothing else. Never pass `/D=` pointing at a folder you care
about, and never run a local build's installer against the folder the
in-app updater manages unless you mean to replace that install.

## Portable staging (developer dogfooding)

The pre-installer flow still works for a quick local build: `termx-ui.exe`,
`termx-host.exe` and `termx-output.exe` copied into one folder. That folder
is the product.

```powershell
# UI (Tauri CLI, see the warning below; the sidecar files above must exist first)
cd ui
npx tauri build --no-bundle

# Host and output helper, from the repo root
cargo build --release -p termx-host --bin termx-host --bin termx-output
```

Outputs come from two different target directories, because `termx-ui` is
deliberately not a member of the root workspace:

- `ui\src-tauri\target\release\termx-ui.exe`
- `target\release\termx-host.exe` and `target\release\termx-output.exe`

Data location for a staged folder:

- No `portable.flag`: data lives in `%APPDATA%\TermX` and survives folder moves.
- An empty `portable.flag` beside the exes: data lives in `data\` inside the
  folder (fully self-contained, clean first launch).

A staged folder is not exempt from the updater. If it accepts an update, the
installer runs with `/D=` set to that folder and writes the installed layout
there. Keep dogfooding folders separate from anything you want to stay
frozen, or set the update policy to "Ask me" in Settings.

## WARNING: never ship a bare-cargo UI build

`cargo build --release` inside `ui/src-tauri` WITHOUT the Tauri CLI (or without
`--features custom-protocol`) produces a broken exe: tauri-build emits
`cfg(dev)`, so the window loads the dev-server URL (`localhost:1420`) instead of
the embedded frontend and shows a connection-refused page. Verified 2026-07-26.

Do NOT verify a build by grepping the exe for `localhost:1420`: the config
(including devUrl) is embedded in ALL builds and the frontend assets are
brotli-compressed. Valid checks:

1. Newest `ui\src-tauri\target\release\build\tauri-*\output` contains no
   `cargo:rustc-cfg=dev` line (a correct build shows `custom_protocol`).
2. `termx-ui.exe` mtime is newer than that output file.
3. Launch it with no dev server running: the workspace must render.

## First-five-minutes smoke

Run the installed `termx-ui.exe` (or the staged folder): the window renders
the workspace; `termx-host.exe` appears in Task Manager with no console
flash; `%APPDATA%\TermX\runtime.json` is fresh. On a machine with no settings
file, the welcome screen asks for a workspace folder. Then: type into a
terminal (proves ConPTY, the WebSocket and the CSP), open the folder picker
(proves the dialog capability shipped), split, rename and close a pane, then
kill the UI and relaunch: sessions reattach with scrollback.

Known limit (BACKLOG section 4): not multi-window-safe. Two UIs fight over
the layout and the last writer wins.
