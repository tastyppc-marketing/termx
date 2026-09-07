# Stability and resume verification

## Backup and scope

Before changing application code, remote `main` and
`backup/pre-stability-2026-09-04` were verified at
`d5699c30bb39565a5717f8ad0dfc2d1cd2d17199` in the private repository
`tastyppc-marketing/termx`. Fixes are on `fix/stability-and-resume-config`.

The changes address three reproduced defects: a timed-out transport could
later transmit queued commands; failed layout writes could be lost after
retry exhaustion; and overlapping window edits could overwrite one another.
Regression tests cover late replies, reconnect recovery, reentrant writes,
disposal, concurrent window edits, acknowledgements and structural conflicts.

Conversation resumes now carry validated, structured launch arguments through
capture, persistence and every local resume entry point. The native launcher
preserves argument boundaries and original working directories. Only a
confirmed SessionStart hook associated with the exact launcher can record a
conversation's original configuration. Failed attempted resumes cannot create
a baseline. Independent reviews found and resolved additional identity,
shell-selection, metadata-refresh and executable-resolution edge cases.

## Validation

- Full UI suite: 152 files, 2,385 tests passed. After the final conversation-ID
  tightening, the affected resume/capture/SSH suites passed 89 tests.
- Production UI build and TypeScript checking passed after the final UI changes.
- Native app-file storage tests: nine passed.
- Hook installer tests: two passed, covering preservation, exact backups,
  idempotence, dry runs and refusal to modify malformed settings.
- Controlled-provider process smoke: actual Windows processes exercised the
  native launcher, live process ancestry and hook stdin for both providers.
  The Codex case used the installer's real PowerShell adapter. Both preserved
  complete arguments, Unicode and empty values, with silent hook output.

Final native validation on September 6:

- Full host suite: 174 tests passed (153 library, six host entry-point,
  12 output helper, three executable integration tests).
- Real HostClient reconnect/reattach suite: six tests passed across two files.
- Rebuilt native launcher and repeated the controlled-provider capture smoke:
  both providers passed.
- The restricted sandbox could not discover a test's grandchild process;
  the full host suite passed outside that restriction, including that check.

## Operational limits

The controlled-provider smoke does not establish that an authenticated Codex
session using a shared app-server can expose the required ancestry. That
configuration remains unverified. Unproven associations do not capture options.

A separate prompt-free real Codex 0.153.4 startup on September 6 succeeded
through the native launcher with authenticated ChatGPT login. The observed
launcher-to-Node-to-Codex process tree stayed intact, and `/new` worked without
a model request. Existing SessionStart hooks were active. This did not test
the newly installed TermX hook or approve its trust; `/hooks` review remains
part of activation.

Historical conversations without captured arguments retain legacy resume
behavior. Capture requires the updated host, new integrated shell panes and
enabled SessionStart hooks. Codex still requires its normal `/hooks` trust
review. Environment variables and referenced settings-file contents are not
snapshotted; remote SSH launch capture is not part of this change.

No running TermX host was restarted during validation. Tests used isolated
hosts and data directories. See [setup and behavior](../resume-launch-settings.md).
