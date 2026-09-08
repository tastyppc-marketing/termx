# Durable collaboration core validation

The core fixes at `9d92f707492f18ce777997d43af5b19b91951191` passed
81 active tests, strict all-target Clippy, release builds and independent scoped
review. The corrected 30-minute workload is running in a separate frozen checkout.
The earlier build completed its own 30-minute workload; those results remain
earlier-build evidence. Task 5 awaits the corrected run and final evidence review.
Native integration, UI behavior and comparative collaboration effectiveness remain
separate work in the [companion plan](../plans/2026-09-08-swarm-companion-integration.md).

## Changes and compatibility

Mailbox page sizing counts the empty complete JSON envelope and each candidate
entry once. It includes actual escaping, separators, snapshot digits and reserved
cursor metadata. It avoids cloning and reserializing the growing page; rejected
candidates neither advance the byte budget nor become fetched. Tests compare this
accounting against actual serialization, including 1 MiB Unicode and escaped-NUL
messages and the 8 MiB complete core page limit.

The initial query optimization reused the ACK-order index. Independent broad
review found a compatibility defect: supported-v2 self-recipient messages had
intentionally been excluded from ACK ordering, but remained valid mailbox history.
The optimization changed a public legacy read from sequences `[1,2]` to `[2]`.
The stored message remained intact. This finding blocked completion.

Schema v7 now adds a complete current-delivery index over explicit group,
recipient, binding and sequence. Mailbox selection starts there and joins the
immutable message plus exact current binding/generation receipt. Historical v1-v6
schema definitions, sender ACK exclusion, reusable cursor interpretation, frozen
high watermarks and immutable retry receipts remain unchanged. The public legacy
regression now traverses both retained messages with one-item pages while excluding
an interleaved append. The sparse 5,001-unrelated-message regression measures the
actual mailbox VM work and verifies the ordered index has no temporary sort.

The sustained driver's uncertainty check also now requires its seeded candidate,
checks the exact attempt identity, and traverses publicly to that message before
asserting its receipt has no ACK. Missing candidates or messages fail the run.
Earlier runs' first-entry assertion does not prove that exact-message property.

## Workload and measurement boundaries

`swarm-core/examples/sustained.rs` uses the public serialized worker with seed
24301, six synthetic peers, two overlapping groups, eight bounded client slots
and 25,000 preloaded messages with 256-byte and 4 KiB bodies. The model retains
eight latest request/receipt pairs plus counters, deriving expected keys, order
and full synthetic bodies during public snapshot traversal. Its memory does not
retain a vector of all history or individual latencies.

After preload and boundary checks, three 600-second phases offer 10, 50 and 100
operations per second. Offered, admitted, completed, driver-slot busy, admission
rejections and expected semantic conflicts are separate counters. Fixed latency
buckets end at 1/4/16/64/256/1,024/4,096 ms plus overflow. Values are truncated to
integer milliseconds before bucketing, so bucket 64 implies actual elapsed time
less than 65 ms; these are coarse bounds, not exact percentiles.

Four lifecycle barriers surround the three phases. They exercise pause/resume,
membership removal/re-addition, offline/reconnect, sender continuation and stale
principal rejection, uncertain attempts, abandoned accepted sends with exact
same-key retry, and frozen snapshots excluding later appends. Separate delivery
and three-seed reference-model tests provide detailed recipient continuation and
candidate projection checks. Test durations and queue/frame bounds impose no
product message, turn, role or token quotas.

`tools/swarm-proof/sustained_observer.py` retains an executable copy, all 30 source
entries, hashes, compiler version, argv, native exit and exact process FILETIME
from its owned child handle. Approximately five-second OS samples cover memory,
CPU, handles, threads and SQLite main/WAL/SHM file sizes. Separate read-only SQL
counts are diagnostic metadata; they are not peer APIs. Rust process memory
includes the driver and worker, excluding the Python observer. Periodic samples
can miss brief peaks. Windows reports private commit separately from resident
working set. [Microsoft memory-counter definitions](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex)

FULL/WAL, SQLite live-backup behavior and accepted-message retention remain in
place. Actual owned-child exit tests establish process-exit recovery, not physical
power-loss behavior. Existing cursor metadata expires after 24 hours but is
retained; no expiry archival or multi-week disk-growth claim is made. Indexed
incremental inbox reads remain an explicit companion integration task.

## Optimization measurements

These are exploratory single-run release measurements on a shared Windows
machine, with fresh retained databases and equal 25,000-message preloads. Cache
state and coexistence load were not controlled. The schema-6 optimization is
included to explain the investigation; its compatibility defect is fixed above.

| Case, 12 reads | Original | Page sizing only | Initial query, schema 6 | Corrected query, schema 7 |
| --- | ---: | ---: | ---: | ---: |
| 128 mixed 256-byte/4 KiB entries | 434.213 ms | 139.228 ms | 148.456 ms | 251.291 ms |
| 128 entries, each 4 KiB | 800.388 ms | 251.317 ms | 188.117 ms | 275.389 ms |
| Seven 1 MiB Unicode entries | 1,346.880 ms | 669.606 ms | 734.777 ms | 723.612 ms |
| One escaped-NUL 1 MiB entry | 570.493 ms | 481.623 ms | 420.672 ms | 751.099 ms |
| Empty eligible projection amid 12,500 group messages | Not measured | 2,494.795 ms | 4.042 ms | 3.367 ms |

The original sparse 5,001-message public-API regression counted 400 progress
callbacks at 100 VM instructions per callback; the initial optimization counted
2, and the corrected query counted 0. Those are sampled VM callback counts, not
exact instruction or row counts. The bound and public compatibility regressions
are stronger evidence of the algorithmic change than these variable wall times.
Initial full traversal of 12,500 messages in 98 pages measured 7.149/4.656/4.400/
5.744 seconds across these four builds. No universal latency improvement follows.

The corrected column and 5.744-second traversal come directly from
`retired/test-artifacts/swarm-core/b1-fixed-short-20260908T142131255402Z/stdout.jsonl`.
Its `result.json` and `root-analysis-20260908.json` provide corrected short-run
accounting and memory figures. None of these values is attributed to the pending
corrected 30-minute run.

## Completed earlier-build 30-minute run

`sustained-30m-20260908T134932085639Z` ran the frozen `ef254590` executable,
SHA-256 `cd33a507a55b849b6d67a2bb8abf22496f401eacfe1221c4972533a99d2d67e3`.
PID 44368 / creation FILETIME `134333489731729857` exited 0 at
2026-09-08 14:23:44 UTC. Its source-at-end comparison is false because subsequent
fixes changed the development checkout; its copied executable and pre-run sources
remain intact. It does not validate the schema-7 compatibility or exact-message
uncertainty corrections.

| Offered rate | Offered | Admitted/completed | Driver busy | Admission contention | Response-byte admission | Expected conflicts | Actual duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10/s | 6,000 | 5,879 | 54 | 0 | 67 | 598 | 600.009 s |
| 50/s | 30,000 | 26,788 | 1,638 | 2 | 1,572 | 2,847 | 600.034 s |
| 100/s | 60,000 | 49,249 | 5,594 | 7 | 5,150 | 5,382 | 600.002 s |

Achieved rates were 9.798, 44.644 and 82.081 completed operations/s. Coarse driver
p95 bounds were less than 65/257/257 ms. All 108,864 accepted worker operations
completed, including setup and expected rejections; final reservations and unknown
worker outcomes were zero. Four abandoned replies were intentional and reconciled.
The 8,847 store errors equal 8,827 timed conflicts plus 20 lifecycle rejections.
The retained 60,580 messages matched 60,433 workload plus 147 boundary messages;
12,084 cursors were retained. Integrity and foreign-key checks passed.

Across 393 samples, private memory peaked at 15,785,984 bytes and ended at
6,533,120 bytes; the lifetime private-commit peak counter reached 31,584,256 bytes.
During the third phase, first/last twelve-sample private medians were
6,774,784/6,778,880 bytes while retained history grew. This observed plateau is
encouraging, but does not prove absence of future leaks. Final main database size
was 472,256,512 bytes and sampled peak WAL was 11,408,312 bytes. Timed handles were
78-79; whole-lifetime thread samples were 3-6.

Host regression builds/tests, root owned-handle probes, core fix builds and both
short attempts coexisted with this run. Exact activity windows are retained in
the run's coexistence records and implementation reports. Timing is not presented
as an isolated-machine benchmark. The final navigation-to-integrity-completion
interval was 28.774 seconds: full `Inspect` is maintenance, and the companion plan
explicitly excludes it from ordinary UI status and peer requests.

## Corrected build verification and current run

The initial `b1-fixed-short-20260908T141451863205Z` invocation accidentally copied
the pre-existing schema-6 observer target. It is preserved and **invalid as
corrected-build evidence**. The target was explicitly rebuilt before
`b1-fixed-short-20260908T142131255402Z`.

The corrected short run used SHA-256
`b3216d9a00c7e7e4c28c4ddf10011c3fc8fd8a8d8dfebac4a30327fcdbc37e94`,
PID 96676 / FILETIME `134333508920267712`, and exited 0 at 14:24:58 UTC.
Independent review matched all 30 source entries to retained/current bytes and
Git-filtered `9d92f707` blobs, verified the executable and actual schema-7 index,
and excluded the stale attempt. Three 10-second phases admitted/completed
100/445/687 operations; all four exact-message lifecycle barriers passed.
All 27,710 accepted worker operations completed with zero final reservations or
unknown outcomes. Integrity and the 25,684 retained-message model agreed.
Sampled private memory peaked at 8,310,784 bytes and ended at 5,320,704 bytes.
This is short correctness evidence, not the corrected long-run result.

Full core verification after the fix passed 81 active tests plus one ignored
child helper exercised by its parent tests. Captured strict all-target Clippy and
release builds exited 0. Core formatting passed. An incidental workspace format
affected six unrelated host files; their formatted bytes and diff were preserved,
then their reviewed committed logical contents restored. Physical EOL-byte
identity with earlier host evidence is not claimed.

The corrected three-600-second run started at 14:33:30 UTC from detached checkout
`.worktrees/swarm-core-validation-9d92f707`, using the exact verified short-run
source bytes and executable. Preparation records Git's EOL-related stat flags
alongside a zero normalized content diff and exact per-file hashes; no rebuild
is claimed. Its retained directory is
`corrected-30m-20260908T143330815795Z`, PID 105532 / FILETIME
`134333516115183858`. Result and final evidence review are pending. Shared-client
development may coexist in the separate development checkout and is recorded as
load; it cannot mutate this frozen run.

The exact preparation record is
`C:/Dev/TermX/.worktrees/swarm-core-validation-9d92f707/retired/test-artifacts/swarm-core/frozen-preparation.json`.

## Host regression and retained evidence

The separate host spill fixture now waits for executed final command output and
a coherent history/ring seam. Its saved prefix is captured before normal close
of the exact synthetic session. The deterministic regression rejects the former
early echo condition and a lagging spill; actual ConPTY and the full default host
suite passed (191 tests). The explicit non-truncating capture-lock flag passed
its focused regression and all 18 launch tests; strict all-target Clippy passed.
Independent host review approved both scoped commits, `61e7fc3` and `fba3fc4`.
Package-wide host formatting still has pre-existing drift outside those hunks.

The 191-test suite ran after the final registry fixture edit and before the later
`fba3fc4` lock clarification; the focused lock/launch tests and strict Clippy cover
that final behavior-preserving adjustment. Retained host logs contain the Cargo
pass/finish summaries. Most numeric host command exits survive in contemporaneous
tool output/reporting, without a separate persisted command-exit manifest; only
the two format logs retain explicit `NATIVE_EXIT=1` footers. The fixture's recorded
shell close exit 1 is separate from Cargo/test command status. Completed suites
were not rerun solely to reconstruct missing exit metadata.

Retained artifacts under the development checkout's
`retired/test-artifacts/swarm-core/` include original/page-sizing/schema-6 short
runs, VM RED/GREEN, the full suite, bundled-SQLite query plans, the independent
legacy reproduction, original long run, stale attempt, corrected build logs and
corrected short run. The corrected long run and preparation manifest live under
the frozen checkout's matching `retired/test-artifacts/swarm-core/` path. Host
fixtures, close evidence and the incidental-format snapshot remain under
`retired/test-artifacts/host/`. Root log-only analyses preserve phase accounting,
operation buckets, memory trends and exact process-generation consistency.

The GitHub pre-swarm backup remains `41a72fc28936fe9a1f4c4b6b4458cb7225225657`.
No running binary was replaced and no current user conversation was messaged,
reconfigured, restarted or terminated. Product-path fault testing, native
acceptance, UI checks and the four-case effectiveness pilot remain outstanding.
