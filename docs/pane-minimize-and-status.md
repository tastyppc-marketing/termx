# Pane minimization and session status

Minimizing a pane puts a restore chip in a shelf at the bottom of its own tab.
Other visible panes fill the available area. At least one pane remains visible.
Terminals and plugin panels stay mounted and running; restoring a pane brings
back its place in the saved split tree. Minimize/maximize are local view state.
Shelf chips carry the existing activity/finished indicators; viewing another
pane must not acknowledge a minimized pane's finished state.

The status bar follows the focused pane. It shows a model only when it can be
associated with that pane, and distinguishes unavailable metadata from a known
model. The native Windows folder picker changes the focused local shell's
directory only after an idle-shell check, repeated after the dialog closes.
It never injects a directory command into an LLM or other running process.

The bar shows the running TermX version and checks the project's GitHub
releases for a newer installable Windows release. Failures and an empty release
catalog are distinct from being up to date. Updates are explicit user actions;
checking does not stop terminals or silently replace running executables.

The existing sidebar selection, pane maximize controls, resume settings, and
host sessions must remain intact. The current source is backed up on GitHub at
`backup/pre-pane-minimize-2026-09-07` before implementation.

Use the pane toolbar's minus button to minimize; click its bottom chip to
restore. A maximized pane keeps the shelf available, and restoring a chip
switches the maximized view to that pane. Restore split view returns the
remaining panes to their original arrangement. The last visible pane cannot
be minimized. View state resets when the application restarts.

`Open folder…` uses the native Windows folder picker for the focused integrated
PowerShell terminal. The host must prove the same clear PSReadLine prompt before
and after the picker and consume its one-use identity atomically. Typing into
the terminal in the meantime cancels the action. It does not send Ctrl+C. CMD,
SSH, custom readers, old hosts, and unknown prompts keep the button disabled.
After answering an in-process `Read-Host`, press Enter once at the empty shell
prompt if the button is still disabled. Ordinary history navigation and user
Ctrl+C recover at a fresh prompt. Clicking the path itself still reveals the
current folder in Explorer.

The model comes from the focused live Claude/Codex launch's hook and fresh
transcript metadata; legacy captures cannot establish current process identity.
Model changes become visible when the CLI writes the new metadata. When two
live launches share one conversation's transcript, the model is unavailable
for those invocations because the transcript does not identify each writer.
The ambiguity remains recorded after either writer exits. No model is guessed
from a folder or a default setting.

The running package version is 0.2.0. Update checks use GitHub CLI authentication
for this private repository; an available update opens the release download
page. The checker neither installs files nor stops terminals. The release
asset naming contract is documented in `RELEASE.md`.

To activate all features, finish active work, close TermX with **Stop everything**,
then reopen the portable application and start new sessions. If closing normally
keeps sessions running, set **Settings > General > When closing the window** to **Ask every time**
before closing. Reopening just the UI enables pane controls but leaves the old
host running; existing sessions cannot gain the new prompt/launch instrumentation.

## Verification

- UI suite: 158 files, 2,476 tests passed; final bootstrap/capability follow-up: 91 passed; TypeScript passed.
- Native UI suite: 238 passed, one opt-in live release check skipped in the suite. That authenticated check was run separately and returned no published release. Final model/capture-compaction follow-up: 11 passed.
- Host workspace: 169 library, 6 main, 12 output utility, and 3 lifecycle tests passed.
- Real host/PowerShell transport: 8 end-to-end tests passed across 3 files, including an idle directory change with quoted path characters, rejection after typing, and refusal during an in-process builtin without cancelling it.
- Browser component smoke: actual terminal components retained contents and identity through minimize, restore, maximize, and split changes; shelf geometry and status controls checked in dark and light themes. The native Windows dialog itself was not automated.
- Legacy Python hook: exact launch metadata, silent append, native-lock exclusion, and recovery verified with isolated temporary data.

The final Tauri CLI release build and host release build passed. Both UI aliases
and the host were staged in `dist-portable/TermX` with verified SHA-256 hashes
and `.before-pane-minimize-20260908T050238830Z` backups. The UI build embeds the
final frontend through Tauri custom protocol. The existing host and terminal
sessions were left running.
