# TermX stability review — September 4, 2026

Reviewed commit: `21e840f` on `main`.

Scope: host process/session lifecycle, WebSocket request handling, reconnect and attachment recovery, and workspace persistence across windows. This was a source review with automated tests, not an extended interactive GUI or soak test. No application code was changed.

1. **High priority: overlapping edits in different windows overwrite one another.**

   Location: `ui/src/workspace/bootstrapWorkspace.ts:574`, particularly `store.replaceState(proposed)` at line 579.

   Auxiliary windows forward their entire layout, including other windows' state. Main validates the blob and replaces its current layout wholesale. There is no base revision, conflict detection, or merge, despite the description in `windowBus.ts`. A single writer serializes disk writes but does not prevent stale snapshots from replacing newer changes.

   Confirmed reproduction: bootstrap main and aux from the same two-tab layout; rename main's tab; before its save acknowledgement/broadcast reaches aux, rename aux's own tab; flush both controllers. Main's title returns to null in both windows, while aux's title survives. This succeeds even with immediate promise-based fake disk writes and the real workspace controllers and bus. The same replacement mechanism also covers tab arrangements and window slots.

   Suggested correction: forward explicit operations with stable IDs, applied against main's current state. If snapshots remain, include base revisions and implement conflict handling; partition ownership must actually be enforced during application.

2. **High priority: timed-out requests remain queued and can execute after failure was reported.**

   Locations: `ui/src/host/reconnect.ts:192` and `ui/src/host/client.ts:469`.

   The reconnect wrapper's timeout rejects only its outer promise. The underlying HostClient retains its active request and queued requests. `pumpRequests` stops while the active request remains, and the reconnect machine still advertises `connected`.

   Confirmed reproduction using the real HostClient and reconnect wrapper over a controlled WebSocket: withhold a GetState response until it times out; request CloseSession(7) and let that time out too. The socket has sent only Auth and GetState, and the machine still says connected. Deliver the late State response: CloseSession(7) is now transmitted even though its caller already received a timeout. Without the late response, subsequent ordinary requests remain blocked.

   Suggested correction: make deadlines own transport-queue cancellation too. Cancel unsent requests, and recover a stalled in-flight connection while preserving the daemon's sessions. Because the protocol lacks request IDs, simply discarding the active slot would risk associating a late reply with a different request. An operation already sent to the host also needs an explicit uncertain-outcome policy.

3. **Medium priority: layout edits made while disconnected are never saved after reconnect.**

   Locations: `ui/src/workspace/LayoutPersistence.ts:94` and `ui/src/workspace/bootstrapWorkspace.ts:1248`.

   Persistence retries once immediately, then discards the pending layout. While disconnected, both attempts fail immediately. Reconnect resynchronizes sessions and attachments but never re-records the dirty layout. A later flush therefore has nothing to save, even though the edited layout is still displayed. A subsequent layout mutation can incidentally save it; reconnect alone cannot.

   Confirmed at two levels: a persistence-only test and a real bootstrapped-workspace test. In the latter, suspend the connection, rename a tab, flush, reconnect successfully through a second client, and flush again. The tab retains its new title in memory, but neither client received a SetLayout call. Closing/restarting without another layout mutation loses that edit. The workspace does record a save error, so this finding is failed recovery rather than absence of error reporting.

   Suggested correction: retain the latest dirty snapshot after retry exhaustion and retry when the connection becomes available. Keep retry scheduling separate from flush completion so an offline flush cannot spin indefinitely.

Validation:

- Existing UI suite: **150 files, 2,339 tests passed** (`npm.cmd test -- --maxWorkers=2`).
- Host library suite: **139 passed, 1 failed inside the sandbox** (`cargo test -p termx-host --lib -- --test-threads=2`). The failure was `kill_reaps_grandchildren_not_just_the_shell`: its Get-CimInstance lookup could not discover the child because Windows management access was denied. The exact test **passed outside the sandbox**. This is not counted as a product finding.
- Four temporary reproduction tests confirmed the three findings above. These were witness tests asserting the observed defects, not regression tests claiming a fix. They were removed after the review.
- Tauri native tests, release packaging, and an interactive GUI soak were not run.
