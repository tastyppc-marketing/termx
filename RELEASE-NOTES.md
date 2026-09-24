termx-host: changed

## What's new

- First installable release. TermX installs for the current user with no admin prompt and starts with a clean slate: on first launch it asks for a workspace root folder, and new tabs open there.
- Built-in updater. TermX checks GitHub Releases at launch. Optional updates show a banner with Install and Later. Required updates show a dialog that installs before TermX continues.
- Settings gained a Workspace root and an Update policy (automatic, or ask me first).
- Help menu with an About dialog showing the app and daemon versions.

## Install

Download **TermX-Setup-<version>-x64.exe** below and run it. Windows may show "Windows protected your PC": click **More info**, then **Run anyway**. Existing installs update in place. TermX also installs this update itself at your next launch.

## One-time setup for updates

TermX fetches updates through the GitHub CLI. Install it from https://cli.github.com, then run `gh auth login` once in any terminal and sign in with the GitHub account that has access to this repository. Without that, TermX still works, but it cannot see new releases.
