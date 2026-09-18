# How TermX updates itself

TermX checks the private GitHub repository `tastyppc-marketing/termx` for a
newer release, downloads the installer in the background, verifies it, and
installs it silently. Optional releases wait for you or for the next launch.
Forced releases block work until they are installed. This page describes what
the code does; the release side is in `docs/RELEASE.md`.

## Set up updates

TermX never holds a GitHub token. Every request goes through the GitHub CLI
on the machine, so an installed copy needs two things once:

1. GitHub CLI (`gh`) installed and on `PATH`.
2. `gh auth login` completed for a github.com account that can read the
   private repository (a collaborator or an organisation member).

Until then the status bar shows "Updates unavailable" and the tooltip says
that update checks need GitHub CLI installed and signed in. Nothing else
breaks: the app runs normally without updates.

## Where updates come from

- Catalog: `gh api repos/tastyppc-marketing/termx/releases?per_page=100`,
  with a 10 second deadline and a 1 MiB response cap.
- A release qualifies only when it is not a draft, not a prerelease, its tag
  is stable semver (`vX.Y.Z`), it has an uploaded, nonempty asset named
  exactly `TermX-Setup-<version>-x64.exe` (or `-arm64` on ARM), and its body
  carries a `termx-sha256:` line. A release missing any of these is invisible.
- The newest qualifying release is compared with the running version. Newer
  means "available"; equal or older means "current"; no qualifying release at
  all means "no-release" (shown as "No published release").
- Checks run at launch and every six hours while the app is open, whether or
  not the status bar is visible. Clicking the status-bar update button runs a
  check on demand.

## Release body markers

Three machine-readable lines may appear in the release body. Each must start
at the beginning of its line; case does not matter; an indented copy does not
count.

| Line | Effect |
|---|---|
| `termx-sha256: <64 hex>` | Required. The digest the downloaded installer must match. Only the first well-formed digest in a body counts. |
| `termx-update: force` | This release is forced. |
| `termx-host: changed` | This release changed the terminal daemon, so the daemon must restart to finish the update. |

### The forced floor

`forced` and `hostChanged` are not read from the newest release alone. They
aggregate over every qualifying release newer than the running version. If
0.3.1 was forced and you are on 0.3.0, then 0.3.2 is offered as forced even
when its own body has no force line. Likewise a host change anywhere in the
span marks the update as host-changing. A forced release at or below the
running version has no effect.

## Download and verify

Once a check reports "available", the hook downloads right away, on every
policy:

- `gh release download <tag> --repo tastyppc-marketing/termx --pattern <asset> --dir <dir> --clobber`
  with a 5 minute deadline. Progress is not streamed; the status bar shows
  "Downloading 0.3.0…" until it finishes.
- Destination: `%LOCALAPPDATA%\TermX\updates\<version>\TermX-Setup-<version>-x64.exe`.
- After the download the file must be nonempty and its SHA-256 must equal the
  release's `termx-sha256` line. A mismatch deletes the file and reports
  "The update failed verification and was discarded. Click to retry."
- A file already present that verifies is reused without a network call, so
  a retry after a failed install does not download again.

## Install and relaunch

Installing runs the verified installer detached as:

```
TermX-Setup-<version>-x64.exe /S /UPDATE /R /D=<folder termx-ui.exe runs from>
```

`/S` is silent, `/UPDATE` skips the uninstall-previous step and the WebView2
check, `/R` makes the Tauri NSIS template relaunch TermX when the files are in
place, and `/D=` pins the install folder so the location never changes. The UI
exits immediately after spawning the installer, because NSIS waits for the
running exe to go away before it replaces files.

The installer refuses to run from anywhere but the updates folder: the path
must be absolute, free of `.` and `..` components, end in `.exe` and live
under `%LOCALAPPDATA%\TermX\updates`.

The daemon is never killed by the installer. A pre-install hook in
`ui\src-tauri\nsis\hooks.nsh` renames a present `termx-host.exe` and
`termx-output.exe` to `termx-host.exe.old` and `termx-output.exe.old` first,
which Windows allows even while they run. The new files then install
normally. At every startup the UI deletes `termx-host*.old` and
`termx-output*.old` beside itself; a delete that fails because the old daemon
still runs is retried at the next launch.

## Optional updates

An optional update goes through these visible states:

| Status-bar label | Meaning |
|---|---|
| `Checking updates…` | A check is in flight. |
| `Update 0.3.0` | A newer release exists and the download has not finished yet. Clicking starts the download again. |
| `Downloading 0.3.0…` | The installer is being fetched and verified. |
| `Update 0.3.0 ready` | Verified and waiting. Clicking installs and reopens TermX. |
| `Installing…` | The installer has been started; the app is about to exit. |
| `Up to date` | The newest qualifying release is the running one. |
| `No published release` | Nothing qualifies in the catalog. |
| `Updates unavailable` | The check or download failed. The tooltip carries the message and "Click to retry". |

Once an optional update is ready, a banner appears across the top of the
workspace: "TermX 0.3.0 is ready. It installs in a few seconds and reopens
where you left off." with three controls:

- **Install now** runs the install described above.
- **Later** records the offered version in `ui_state_v1.json` as
  `updates.snoozedVersion`. That version is downloaded again at the next
  launch but is not installed automatically. The banner stays on screen for
  the rest of the current session, and the status-bar pill still offers the
  install. A newer version replaces the snooze.
- **What's new** opens the release page on GitHub in the browser.

### The `updatePolicy` setting

Settings, General, "Optional updates":

- **Install at next launch** (`auto`, the default). The launch check
  downloads the update and, once verified, installs it and reopens TermX. Only
  the first check of a launch does this; the six-hour poll downloads but never
  restarts the app mid-work. A snoozed version and a forced release are never
  auto-installed either.
- **Ask me** (`ask`). The update is downloaded and offered on the banner and
  the pill. Nothing installs until you click.

Forced updates ignore this setting.

## Forced updates

When the result is forced and available, a modal covers the workspace:
"TermX 0.3.2 is required. This release has to be installed before TermX can
continue. Work continues after the update." It cannot be dismissed: Escape is
swallowed, Tab cycles inside it, and the menubar does not take the keyboard.
Its primary button follows the updater state: "Downloading…", then "Update
now", "Installing…", or "Retry" after a failure with the message shown
inline. "What's new" opens the release page.

When the span changed the daemon, the modal lists the live terminals that
will close. "Update now" then marks a pending host restart in
`ui_state_v1.json`, stops the daemon, and runs the installer. The relaunched
UI finds no daemon, starts the freshly installed one, and clears the flag.

A forced release cannot be installed when GitHub CLI is missing or signed
out. The check fails before anything is known about the release, so the
status bar shows "Updates unavailable" and no modal appears; the check retries
every six hours or on click.

## Finishing a host-changing update

The UI is replaced by the installer, but a daemon that was running at the
time keeps serving from its renamed exe. After an optional host-changing
update, the new UI compares the daemon version reported at connect with its
own version. When they differ and a host restart is pending, a banner says
"Restart terminals to finish the update (N will close)" with a "Restart now"
button. When there are no live terminals it restarts on its own. The restart
stops the old daemon, starts the one installed beside the UI, clears the
pending flag and reloads the window. Layout lives in the daemon's state file,
so the tabs and groups come back; the live shells do not. A failed restart
keeps the banner with the error shown beside the text.

## About TermX

The Settings menu ends with "About TermX…", which shows the UI version, the
daemon version ("not connected" when there is none), the install folder and
the data folder. Ask for these when someone reports a problem.

## Errors

Every failure becomes plain text. The status-bar label is "Updates
unavailable" with the exact message in its tooltip followed by "Click to
retry"; the forced modal shows the same message inline above a "Retry"
button.

| Failure | Message | Behaviour |
|---|---|---|
| GitHub CLI missing or signed out | Update checks need GitHub CLI (gh) installed and signed in to this private repository. | No download, no modal even for a forced release. Retries every 6 h or on click. |
| Offline, access denied, API error | GitHub could not be reached or access was denied. Check your connection and gh login. | Retry on click or at the next poll. |
| Check took longer than 10 s | The GitHub update check timed out. | Same. |
| Catalog larger than 1 MiB or unreadable | GitHub's release catalog exceeded the size limit. / GitHub returned an unreadable release catalog. | Same. |
| Download took longer than 5 min or gh failed | The GitHub update download timed out. / GitHub did not deliver the installer. Check your connection and gh login. | Retry downloads again. |
| Digest mismatch or empty file | The update failed verification and was discarded. Click to retry. | File deleted; retry downloads again. |
| Installer path outside the updates folder | Refusing to run an installer from outside the updates folder. | Nothing runs. |
| Installer file gone | The downloaded installer is missing. Download the update again. | Retry downloads again. |
| Installer could not start | Could not start the installer. | Installer file kept; retry runs it again. |
| Daemon restart fails | The error from the restart, beside the banner text. | Banner stays; sessions untouched; Restart now can be pressed again. |
| Version manifests drift | Release script and the version-sync test fail. | No tag is created. |

## Give someone TermX

1. Invite them as a collaborator on the private repository
   `tastyppc-marketing/termx` (read access is enough).
2. They accept the invitation and sign in to github.com.
3. They open https://github.com/tastyppc-marketing/termx/releases, pick the
   newest release, and download `TermX-Setup-<version>-x64.exe`.
4. They run it. Windows may show "Windows protected your PC": click "More
   info", then "Run anyway". The install is per-user, needs no admin rights,
   and lands in `%LOCALAPPDATA%\Programs\TermX`.
5. For in-app updates they install GitHub CLI and run `gh auth login` once
   with the account that was invited.
6. The first launch shows the welcome screen. They pick the folder their work
   lives in and press Start; new terminals open there. Skip leaves it unset
   and can be changed later under Settings, General, "Workspace folder".

## Files involved

- `ui\src-tauri\src\updates.rs`: catalog check, marker parsing, download,
  digest check, installer launch.
- `ui\src-tauri\src\cleanup.rs`: deletes the `.old` sidecars at startup.
- `ui\src-tauri\nsis\hooks.nsh`: the pre-install rename hook.
- `ui\src\updates\useUpdates.ts`: the state machine, launch auto-install and
  snooze.
- `ui\src\updates\UpdateBanner.tsx`, `ForcedUpdateModal.tsx`,
  `HostRestartBanner.tsx`, `AboutDialog.tsx`: the surfaces.
- `ui\src\updates\hostRestart.ts`: whether a daemon restart is owed.
- `ui\src\settings\settings.ts`: `updatePolicy` and `workspaceRoot`.
- `ui\src\workspace\uiState.ts`: `updates.snoozedVersion` and
  `updates.pendingHostRestart`.
- `%LOCALAPPDATA%\TermX\updates\<version>\`: downloaded installers.
