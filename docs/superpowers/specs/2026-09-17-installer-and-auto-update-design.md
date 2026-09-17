# TermX installer, auto-update, and first-run workspace root — design

Date: 2026-09-17. Status: approved by Michael in chat ("go"), 2026-09-17.

## Goal

Anyone Michael invites to the private GitHub repo `tastyppc-marketing/termx`
can open the newest release page, download one installer exe, run it, and
have a working TermX with a clean slate and their own workspace root. After
that, TermX updates itself from the same repo: optional releases are offered
and installed at the next launch, forced releases must be installed before
work continues. Michael cuts a release with one script.

Non-goals (explicitly out): code signing (SmartScreen "unknown publisher"
stays until a certificate is bought; the pipeline gets a hook for it later),
macOS/Linux, a public download page, delta updates, and the admin-control /
shared-session work (separate spec).

## Facts this design rests on (verified 2026-09-15..17)

- A notify-only updater already exists and is kept: `ui/src-tauri/src/updates.rs`
  (`check_for_updates`, `open_update_release`), `ui/src/updates/useUpdates.ts`
  (6 h poll), status-bar button `ui/src/statusbar/StatusBar.tsx:95-100`. It
  reaches GitHub only through the machine's own `gh` login (10 s deadline,
  1 MiB cap). No token ever enters the app. Renderer CSP blocks outbound HTTP,
  so a `gh` subprocess stays the only network path.
- Versions are declared in four places, all `0.2.0`, nothing syncs them:
  `ui/src-tauri/tauri.conf.json:4`, `ui/package.json:4`,
  `ui/src-tauri/Cargo.toml:3`, `host/Cargo.toml:3`. The updater compares the
  Tauri package version; the host reports its own crate version in
  `runtime.json` and the WebSocket `AuthOk` message, and no code reads it.
- The bundler is active (`tauri.conf.json` `bundle.active: true`,
  `targets: "all"`, icons present, NSIS cached in `%LOCALAPPDATA%\tauri\NSIS`)
  but the host daemon is not declared as a bundled binary, so today's installer
  would ship the UI alone. Host discovery (`ui/src-tauri/src/bootstrap.rs:167-219`)
  already accepts `termx-host-x86_64-pc-windows-msvc.exe` beside the UI exe.
  Toolchain host triple is `x86_64-pc-windows-msvc`. A third binary,
  `termx-output.exe` (`host/src/bin/termx-output.rs`), ships in the portable
  folder and must ship in the installer too.
- The UI attaches to a live daemon via `runtime.json` (`bootstrap.rs:86-94`)
  and only spawns one when none answers. Restarting the UI loses nothing
  (layout lives in the daemon's `state.json`); restarting the daemon kills
  every live terminal.
- Per-user state lives in `%APPDATA%\TermX` (or `data\` beside the exe when
  `portable.flag` exists). Nothing in the repo or the build output carries
  Michael's terminals, names, sessions or settings (the only path hits are
  test fixtures). A fresh install is therefore empty by construction.
- Settings: `ui/src/settings/settings.ts` (`TermxSettings` + `DEFAULT_SETTINGS`
  + validators), grouped for the panel in `ui/src/settings/sections.ts`
  (a test enforces every field appears in a section). Persisted as
  `settings_v1.json` through the allowlist in `ui/src-tauri/src/storage.rs:22`.
  Non-setting UI state lives in `ui_state_v1.json` (`ui/src/workspace/uiState.ts`).
- New-tab cwd resolution: `WorkspaceController.createTab` →
  `newTabCwdCandidates` in `ui/src/workspace/scopePaths.ts:78` builds a chain
  `[active-tab cwd?, scope active cwd?, scope seed?, null]`; `null` means the
  host's default (the daemon's own working directory, effectively the user's
  profile). The controller already owns a `pickFolder` function (native folder
  dialog via `tauri-plugin-dialog`).
- No CI exists (`.github` absent). `docs/RELEASE.md` is a manual two-command
  build. `dist-portable/` is gitignored.

## Part 1 — Installer

### Bundle contents

`ui/src-tauri/tauri.conf.json`:

- `bundle.targets`: `["nsis"]` (drop MSI; one artifact, one download).
- `bundle.externalBin`: `["binaries/termx-host", "binaries/termx-output"]`.
  Tauri requires the files at `ui/src-tauri/binaries/termx-host-x86_64-pc-windows-msvc.exe`
  and `…/termx-output-x86_64-pc-windows-msvc.exe`; the release script copies
  them there from `target\release\` before `tauri build`. `ui/src-tauri/binaries/`
  is gitignored. Tauri installs them beside `TermX.exe` under their triple
  names, which `bootstrap.rs` already resolves. `termx-output` is resolved the
  same way (add the triple name to its candidate list where it is located).
- `bundle.windows.nsis`: `installMode: "currentUser"` (no admin prompt, per-user
  install under `%LOCALAPPDATA%\Programs\TermX`), `languages: ["English"]`,
  `displayLanguageSelector: false`. `bundle.windows.webviewInstallMode`:
  `{ "type": "downloadBootstrapper" }` so a clean Windows 10 image still gets
  WebView2.
- `mainBinaryName` stays `termx-ui`; the installed product exe is `TermX.exe`
  (Tauri names the installed binary after `productName`). The portable folder's
  `TermX.exe` alias is unchanged.

### Artifact naming

Release asset: `TermX-Setup-<version>-x64.exe` (Tauri emits
`TermX_<version>_x64-setup.exe`; the release script renames it). The updater
selects on this exact name. Portable zip support in `updates.rs` is removed;
the portable folder stays a developer staging path only (RELEASE.md keeps it).

### SmartScreen

Unsigned. The release notes template says: "Windows may show 'Windows
protected your PC'. Click More info, then Run anyway." The pipeline has a
single `SIGN_COMMAND` step that is a no-op until a certificate exists.

## Part 2 — First run: clean slate and workspace root

### Clean slate

No change needed for the data: the installer ships no `data\`, no
`portable.flag`, no state. On first launch `%APPDATA%\TermX` is created empty
by the host. The release script's packaging step asserts that the NSIS bundle
contains no `data\` directory and no `*.json`/`*.jsonl` (test in
`tools/release.ps1`, see Part 5).

### Workspace root setting

New field in `TermxSettings`:

```ts
/** Folder every new terminal starts in when nothing else decides. Null until the user picks one. */
readonly workspaceRoot: string | null;
```

- Default `null`. Validator: string of at most 1024 chars or null; not
  checked for existence at load (a moved folder must not corrupt settings).
- Section: `general`, first field, rendered as a path row with a "Choose…"
  button that calls the same `pickFolder` the new-tab dialog uses.
- `newTabCwdCandidates` gains a final parameter `workspaceRoot: string | null`
  and pushes it just before the trailing `null`. Every policy therefore ends
  `[…, workspaceRoot, null]`. The existing dedupe stays. Because the chain
  already tries candidates down to `null`, a deleted root falls through to the
  host default without an error dialog.
- `createTabViaNativeDialog` and the folder searcher open at `workspaceRoot`
  when set (initial directory of the picker), otherwise as today.
- Saved-session default location and any "recent folders" seeding are not
  changed by this spec.

### Welcome screen

Shown once, when all of these hold at startup: `settings_v1.json` did not exist
before this launch (the settings store reports `wasCreated`), the daemon
reports zero sessions, and `workspaceRoot` is null. It is a modal over the
empty workspace, not a wizard:

- Title "Welcome to TermX". One paragraph: "Pick the folder your work lives in.
  New terminals open there. You can change it any time in Settings."
- Path field (read-only) + "Choose folder…" (native picker, starts at the
  user's profile) + "Start" (disabled until a folder is chosen) + "Skip"
  (leaves `workspaceRoot` null; never shown again because the settings file
  now exists).
- Start writes `workspaceRoot`, closes the modal, and creates the first tab
  in that folder.

Michael never sees it: his settings file exists.

## Part 3 — Updater

### Release catalog and selection (`updates.rs`)

- Keep `gh api repos/{REPOSITORY}/releases?per_page=100` with today's bounds.
- A release qualifies when: not draft, not prerelease, tag parses as stable
  semver, and it has an uploaded nonempty asset named exactly
  `TermX-Setup-<version>-x64.exe`.
- New per-release fields parsed from the release **body** (markdown), first
  matching line wins, case-insensitive, anchored at line start:
  - `termx-update: force` → `forced: true`
  - `termx-sha256: <64 hex>` → installer digest (required; a release without
    it does not qualify)
  - `termx-host: changed` → `hostChanged: true` (the release script sets it
    when any file under `host/` changed since the previous tag)
- `UpdateResult` gains: `forced: boolean` (true when ANY qualifying release
  newer than the running version is forced, not only the newest, so a user
  who skipped a forced 0.3.1 is still forced at 0.3.2), `hostChanged: boolean`
  (true when any newer qualifying release changed the host), `sha256`,
  `assetName`, `notesUrl`.
- Unit tests extend the existing `select_release` suite: forced floor
  semantics, missing digest disqualifies, host-changed aggregation, asset name
  exactness.

### Download and verify (`updates.rs`, new command `download_update`)

- `gh release download <tag> --repo <REPOSITORY> --pattern <assetName> --dir <dir> --clobber`
  into `%LOCALAPPDATA%\TermX\updates\<version>\`, bounded by a 5 min deadline;
  output cap unchanged for stderr capture. Progress is not streamed (gh does
  not expose it); the UI shows an indeterminate state.
- After download: size > 0, SHA-256 of the file equals `termx-sha256`
  (Rust `sha2` crate, added to `ui/src-tauri/Cargo.toml`). Mismatch deletes
  the file and returns an error naming the release tag.
- Returns the absolute installer path. Idempotent: a present file with a
  matching digest is returned without re-downloading.

### Install and relaunch (`updates.rs`, new command `install_update`)

- Runs the verified installer as `TermX-Setup-<v>-x64.exe /S` (NSIS silent)
  detached, with `/D=<current install dir>` so the location never changes.
  The installer replaces files in place; NSIS waits for the running exe to
  exit, so the UI exits itself immediately after spawning it
  (`app.exit(0)`), and the installer's final step relaunches `TermX.exe`
  (`bundle.windows.nsis.installerHooks` post-install hook; the hook only runs
  when the installer was started with `/S`, so a hand-run installer behaves
  normally).
- The daemon is never killed by the installer. NSIS cannot overwrite an exe
  that is running, so a TermX pre-install hook (`NSIS_HOOK_PREINSTALL` in
  `ui/src-tauri/nsis/hooks.nsh`, wired by `bundle.windows.nsis.installerHooks`)
  renames any existing `termx-host-*.exe` and `termx-output-*.exe` to
  `<name>.old` first. Windows permits renaming a running exe, and the running
  daemon keeps its mapped image. The new files then install normally. The UI
  deletes `*.old` beside itself at every startup; a delete that fails because
  the old daemon is still running is ignored and retried next launch. The
  running old daemon keeps serving until the user restarts it (below).
- The same hook file carries the post-install relaunch: when the installer
  was started with `/S`, it runs the installed `TermX.exe` after the files are
  in place. The hook is a repo file, so the behaviour is versioned and testable
  by building the installer in CI.

### Daemon restart policy

The new UI, on attach, compares the daemon version from `AuthOk.version`
(already parsed at `ui/src/host/protocol.ts:53`, stored in `client.ts`) with
its own package version.

- Equal: nothing.
- Older daemon, `hostChanged` false for the span: nothing (compatible).
- Older daemon and the update carried a host change: a persistent banner
  "Restart terminals to finish the update (N live sessions will close)" with
  a "Restart now" button. It also auto-completes when the session count
  reaches zero (the UI asks the daemon to stop, waits for `runtime.json` to
  go stale, spawns the new one through the existing bootstrap path).
- Forced update with host change: the pre-install modal lists the sessions
  that will close, and "Update now" performs the daemon stop before running
  the installer, so the update finishes in one pass.

### UI states and settings

`ui/src/updates/`:

- `types.ts`: `UpdateResult` extended as above; `UpdateState` gains
  `downloading`, `ready` (installer path), `installing`.
- `useUpdates.ts`: keeps the 6 h poll and the status-bar button. Adds
  `download()` and `install()`; `open()` (release page) stays for the notes
  link. The check no longer depends on the status bar being visible: it runs
  whenever the app runs; the status bar merely displays it.
- New setting `updatePolicy: "auto" | "ask"` (default `"auto"`), section
  `general`: with `auto`, an optional update is downloaded in the background
  once found, and installed silently at the next launch if the digest still
  verifies and nothing is forced; with `ask`, it is only downloaded and offered.
  Forced updates ignore this setting.
- `ui_state_v1.json` gains `updates: { lastCheckAt, snoozedVersion }` so
  "Later" on an optional update hides the banner until a newer version
  appears or 24 h pass.
- Surfaces: (1) status-bar pill as today, text "Update 0.3.0 ready" when
  downloaded; (2) an optional-update banner at the top of the workspace with
  Install now / Later and a "What's new" link; (3) a forced-update modal that
  cannot be dismissed, with the notes link, the session-close list when the
  host changed, and a single "Update now" button. Keyboard focus is trapped
  in the modal; the menubar's capture-phase handler yields to it as it does
  for editable elements.
- Every failure (gh not logged in, offline, digest mismatch, installer exit
  code) becomes a plain-language message on the pill with "Click to retry";
  a forced modal shows the same message inline and keeps its button.

### Version display

The status bar keeps `TermX <version>`. The menubar Settings menu gains
"About TermX…" showing UI version, daemon version, install path and data path
(all read-only), so support questions are answerable.

## Part 4 — Version sync

`tools/version.ps1 -Version X.Y.Z` rewrites the four version fields and
`ui/package-lock.json`'s root version, and is the only way versions change.
A vitest test (`ui/src/__tests__/versionSync.test.ts`) reads all four files
and fails when they differ, so a drift cannot ship.

## Part 5 — Release pipeline

### `tools/release.ps1 -Version X.Y.Z [-Force] [-Notes <path>]`

Runs on Michael's machine, from any clone location (no absolute paths):

1. Refuses on a dirty tree or when not on `main`; refuses when the tag exists.
2. `tools/version.ps1 -Version X.Y.Z`; runs the vitest version-sync test.
3. Determines `hostChanged` by `git diff --quiet <previous tag> -- host/`.
4. Writes `RELEASE-NOTES.md` at the repo root from `-Notes` or from an
   editor prompt, prepending the machine-readable lines (`termx-update: force`
   when `-Force`, `termx-host: changed` when so; the sha256 line is added by CI
   after the build).
5. Commits `chore(release): vX.Y.Z`, tags `vX.Y.Z`, pushes branch and tag.

### GitHub Actions `.github/workflows/release.yml`

On `push` of tags `v*`, on `windows-latest`:

1. Checkout, Rust stable (msvc), Node 22, `npm ci` in `ui/`.
2. Run the gates: `npx tsc -p tsconfig.app.json --noEmit`, `npx vitest run`
   (from `ui/`), `cargo test --workspace` (root) and `cargo test` in
   `ui/src-tauri`.
3. `cargo build --release -p termx-host -p termx-output` at the root; copy the
   two exes into `ui/src-tauri/binaries/` under their triple names.
4. `npx tauri build` in `ui/` (bundler on; produces the NSIS setup exe).
5. Rename to `TermX-Setup-<version>-x64.exe`, compute SHA-256, append
   `termx-sha256: <hex>` to the release notes, assert the bundle contains no
   `data\`, `portable.flag`, `*.json` or `*.jsonl` (the clean-slate check).
6. `gh release create v<version> --notes-file RELEASE-NOTES.md --title "TermX <version>" TermX-Setup-<version>-x64.exe`.
   Draft is never used (the updater ignores drafts anyway). A failed step
   leaves no release behind.

`docs/RELEASE.md` is rewritten around this flow, keeps the portable staging
section for local dogfooding, and gains a "Give someone TermX" section: invite
them as a collaborator, they sign in to GitHub, open the newest release, and
run the installer; they need `gh auth login` once for in-app updates
(the welcome screen's Skip/Start footer links to a short "Set up updates" note
that says exactly that, and the status bar pill's error text says it too when
`gh` is missing or logged out).

## Error handling summary

| Failure | Behaviour |
|---|---|
| `gh` missing / logged out | Pill: "Sign in to GitHub with gh to get updates". No modal, even for forced releases, because nothing can be downloaded; the check retries every 6 h. |
| Offline / API error | Pill: "Updates unavailable. Click to retry". |
| Digest mismatch | File deleted; pill: "Update 0.3.0 failed verification. Click to retry". |
| Installer exits non-zero before the UI exits | Message with the exit code; installer file kept for retry. |
| Daemon restart fails | Banner stays with the error; sessions untouched. |
| Version files drift | Release script and vitest both fail before a tag exists. |

## Testing

- Rust unit tests in `updates.rs` for selection (forced floor, host-changed
  aggregation, digest required, asset name), body parsing, digest check with a
  temp file, and command argument construction (the `gh`/installer argv is
  built by pure functions and asserted, never executed in tests).
- Vitest: `useUpdates` states (download, ready, installing, error, snooze),
  banner/modal rendering and focus trap, forced-modal cannot be closed by
  Escape or backdrop, `newTabCwdCandidates` with `workspaceRoot` in every
  policy, settings validation for both new fields, section coverage test,
  welcome-screen gating (shown only on the first-launch triple), version sync.
- Pipeline: the workflow runs the full gates on every tag; the clean-slate
  assertion is a real step, not a comment.
- Manual click-test (Michael): install `0.3.0` on a spare Windows user
  account or VM, confirm the welcome screen and an empty workspace, pick a
  root, open a tab there; publish `0.3.1` optional → pill, banner, Later,
  relaunch installs; publish `0.3.2` forced with a host change → modal lists
  sessions, Update now, terminals restart, version shows `0.3.2` in About.
