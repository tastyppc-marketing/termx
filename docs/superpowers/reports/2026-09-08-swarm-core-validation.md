# Durable collaboration core validation

The reproducible driver and measured core corrections have passed focused and
complete core verification. The 30-minute workload is **pending controller
execution**; Task 5 remains incomplete. No native harness, Windows authentication,
UI integration, user conversation or model-effectiveness claim follows from it.

## Reproduction and boundaries

The opt-in `swarm-core/examples/sustained.rs` workload uses the public serialized
worker. Its fixture, benchmarks, bounded load state and lifecycle checks live in
separate support modules. `tools/swarm-proof/sustained_observer.py` launches one
owned child and retains stdout, stderr, source/executable hashes, source copies,
native exit status and process-generation identity. It samples private memory,
working set, CPU, handles, threads and main/WAL/SHM file sizes approximately every
five seconds. Its separate SQLite read-only row counts are diagnostic metadata,
not peer paging operations. Process memory includes the Rust test client and
worker; the Python observer lives outside that process.

The workload uses seed 24301, six synthetic peers, two overlapping groups, eight
bounded client slots and 25,000 public-worker preloaded messages, with 256-byte and
4 KiB bodies. Groups use one sender and two frozen recipients each. The model
keeps only eight latest request/receipt pairs and sequence counters. No vector of
all history, message bodies or individual latencies grows with the database.
Page checks derive the expected sequence, key and complete synthetic body without
reading SQLite. Exact retry checks compare the original complete send receipt.

The prepared timed phases are 600 seconds each at 10, 50 and 100 offered
operations per second, after preload and warmup. Offered, admitted, completed,
driver-slot rejection, admission rejection and expected semantic errors are
separate counters. Fixed latency bucket upper bounds are 1, 4, 16, 64, 256, 1024
and 4096 milliseconds, followed by an unbounded overflow bucket; no exact
percentiles may be inferred from these coarse buckets. Values are truncated to
integer milliseconds before bucketing, so a nominal <=16 ms bucket means actual
elapsed time less than 17 ms, not an exact 16 ms upper bound.

Each timed phase starts after a real drain barrier. Between phases, checks cover
pause/resume, removed/re-added overlapping membership, offline/reconnect, sender
continuation and old-principal rejection, native-attempt uncertainty without ACK,
an abandoned accepted send with stable same-key retry, and a complete frozen
snapshot that excludes an interleaved append. A bounded 128-command burst keeps
control replies unread while classifying actual admission rejection. Continuation
in this driver covers a sender without recipient backlog; the separate three-seed
reference model and delivery tests cover transferred and historical backlog.
Candidate checks in the sustained driver establish bounded response size; the
independent short model provides the detailed candidate-projection oracle.

Public frozen-snapshot traversal from sequence zero is measured separately from
first-page polling. The existing API has no indexed start-after tail operation.
Mailbox cursor rows have expiry timestamps but remain retained. Neither fact is
hidden by privileged SQL shortcuts. An integration plan must address incremental
navigation deliberately while preserving authorization and reusable snapshots.

The existing Task 4 actual owned-child exit tests establish process-exit recovery,
not physical power-loss behavior. This task does not alter FULL durability,
database migrations, ordinary filesystem permissions or any running TermX host.

## Measured corrections and short results

Only two production changes were made, both in mailbox construction/querying:

1. The byte budget now serializes the empty full envelope once and each candidate
   entry once into a counting writer. It includes real JSON escaping, separators,
   snapshot digits and the same reserved `Some(cursor)` envelope as before. It
   never clones and reserializes the growing page. Rejected candidates do not
   advance the budget or become fetched. Tests compare the accounting with real
   JSON and verify one serialization visit per entry.
2. Mailbox enumeration starts with the existing recipient binding/sequence index.
   Historical recipient-order rows must join the exact **current** delivery
   binding and generation, then the matching immutable message. The query does
   not filter on ACK state. No new schema version, migration, permission change,
   message deletion or cursor invalidation was introduced.

The sparse regression used 5,001 group messages belonging to another recipient.
Before the query change, the actual bundled SQLite progress handler counted 400
callbacks at 100 VM instructions per callback and the bound assertion failed.
Afterward it counted 2 callbacks and passed. These are progress callback counts,
not exact row counts. The associated explicit mailbox regression covers an
acknowledged predecessor row excluded from the successor mailbox, current
generations 3/2/1, both acknowledged and unacknowledged mail, one-item frozen pages,
an excluded append, stale-principal rejection and immutable original send receipt.

Exploratory release measurements use fresh retained databases, the same 25,000
message preload, twelve reads per case, equal page/body sizes and full worker
operations. They are single-run comparisons on a shared Windows machine, not a
statistical performance guarantee. The intermediate run adds an empty-recipient
probe before the original benchmark sequence; cache state was not controlled.

| Case, 12 reads | Original | Page sizing only | Final recipient query |
| --- | ---: | ---: | ---: |
| 128 mixed 256-byte/4 KiB entries | 434.213 ms | 139.228 ms | 148.456 ms |
| 128 entries, each 4 KiB | 800.388 ms | 251.317 ms | 188.117 ms |
| Seven 1 MiB Unicode entries, 7,343,659-byte page | 1,346.880 ms | 669.606 ms | 734.777 ms |
| One escaped-NUL 1 MiB entry, 6,292,053-byte page | 570.493 ms | 481.623 ms | 420.672 ms |
| Empty eligible projection amid 12,500 group messages | Not measured | 2,494.795 ms | 4.042 ms |

The first public full traversal of 12,500 dense-recipient messages took 7.149 s
originally, 4.656 s with page sizing alone, and 4.400 s with the final query, in
98 pages. Repeated ACKs already
completed in roughly 0.5–0.7 ms on average in the short probes. Receipt-write
semantics and cursor retention were therefore left unchanged; neither first-page
polling nor a faster sparse query establishes an incremental inbox-tail API.

Final production/test verification passed **81 tests** (26 unit, 17 delivery,
4 fault, 10 mailbox, 1 three-seed model, 22 schema and 1 public worker). The ignored
child entry point is exercised by its parent process-exit tests. Package clippy
with all targets and `-D warnings` passed. The only later Rust change adds wall
timestamps to diagnostic events; all-target clippy and the release build passed
again, and the matched short run executes that exact diagnostic path.

The final short run completed all three **10-second** phases and exited 0 with
unchanged source hashes and an empty stderr file. This is 30 seconds of paced
workload, not the pending 30-minute soak. Offered/admitted/completed outcomes were:

| Offered rate | Offered | Admitted/completed | Driver slot busy | Admission response bytes | Expected conflicts |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10/s | 100 | 96/96 | 1 | 3 | 11 |
| 50/s | 500 | 448/448 | 22 | 30 | 47 |
| 100/s | 1,000 | 758/758 | 169 | 73 | 81 |

Actual phase durations were 10.004, 10.003 and 10.055 seconds. The observed driver
p95 buckets imply elapsed times below 1,025, 257 and 257 ms respectively; they
do not provide exact p95 values. The short run is visibly affected by latency
variation and admission limits; the offered rate is not claimed as achieved
throughput. The default reservation policy remains unchanged.

All 27,768 accepted worker operations completed, including setup/checkpoints and
expected errors. The 159 store errors equal 139 timed conflicts plus 20 deliberate
lifecycle rejections. Four abandoned replies were intentional and reconciled.
No unexpected error or unknown worker outcome occurred. Final request/response
reservations were zero. The maximum request high-watermark was 58, including
the separate control bursts; timed driver concurrency never exceeds eight.

Final public traversal checked complete synthetic bodies/order for both workload
groups: 12,788 and 12,778 messages in 100 pages each. The independent expected
count of 25,566 workload messages plus 147 boundary messages matched the retained
SQLite count of 25,713. Diagnostic counts also showed 51,279 current deliveries,
944 retained cursor rows, 25,702 receipt rows and four native-attempt records.
Cursor expiry remains 24 hours; no expiry or metadata archival was tested here.

The observer retained 41 approximately five-second samples. Across startup,
preload, boundaries and the short phases, sampled private memory peaked at
6,275,072 bytes and the final sample was 6,250,496 bytes. Windows' process peak
pagefile/private-commit counter reached 31,522,816 bytes, showing that periodic
samples missed the brief boundary-test allocation peak. The final sampled main
database/WAL sizes were 248,791,040/7,836,272 bytes. These short observations are
not a sustained memory-stability or leak conclusion; the observer and worker
metrics permit that assessment during the pending longer run.

## Retained evidence and pending work

All paths below are under `retired/test-artifacts/swarm-core/`:

- `baseline-20260908T132432631049Z/`: original release executable, source snapshot,
  logs and native exit 0. Exact creation FILETIME is in `exact-identity.json`.
- `optimized-short-20260908T133119485324Z/`: page-sizing-only executable, source
  snapshot, enhanced lifecycle checks, metrics and native exit 0.
- `sparse-vm-red-20260908T133450832448Z/` and
  `sparse-vm-green-20260908T133548662782Z/`: actual failing/passing VM regression.
- `mixed-mailbox-20260908T133553341205Z/`: focused generation/snapshot regression.
- `final-query-suite-20260908T133623364625Z/`: 81-test full suite, native exit 0.
- `freeze-clippy-20260908T133745541047Z/` and
  `freeze-build-20260908T133747352130Z/`: final diagnostic source checks/build.
- `final-short-20260908T133807850892Z/`: final matched run and frozen handoff data.
- `query-plan-evidence-20260908T134151864390Z/`: before/after plans from bundled
  SQLite 3.53.2, through a separate retained read-only diagnostic probe at
  `task5-query-plans-20260908/probe/`. The old plan starts with group messages;
  the final plan starts with `recipient_ack_binding_sequence`. Neither plan uses
  a temporary sort. VM assertions, rather than index names alone, establish the
  sparse-work improvement. An earlier Python-SQLite diagnostic is exploratory;
  the bundled-version evidence supersedes it.

Prepared controller command, run from the worktree after verifying the frozen
release executable and source manifest:

```powershell
python tools/swarm-proof/sustained_observer.py sustained-30m --preload 25000 --seconds 600
```

The release executable SHA-256 is
`cd33a507a55b849b6d67a2bb8abf22496f401eacfe1221c4972533a99d2d67e3`.
The complete source hashes, exact release executable copy, compiler version and
short configuration are in the final-short `manifest.json` and `source/` tree.
The observer copies the executable to a new retained run directory, binds its
owned process generation and captures the new 600-second phase configuration.
No recompilation or source change is needed to launch the longer run.

Earlier authoring failures are retained: a malformed JSON test expression, the
subsequent missing-sizer RED, and an initial strict-clippy failure in the example.
The observer's native-argv parser was corrected to preserve a nested `--`.
Original/intermediate run manifests report working-source changes because later
implementation progressed near their ends; their captured executable and full
pre-run source snapshots preserve what actually ran. The final runner uses an
owned executable copy and exact `GetProcessTimes` FILETIME from the retained
`Popen` handle, with fresh generation checks for OS samples.

The controller still must run the actual three 600-second phases, analyze memory
and queue/history trends, record any concurrent owned host regression activity,
complete the separate host ring-spill fixture investigation, obtain independent
implementation/broad review and publish the finished evidence. No 30-minute
completion, memory-stability conclusion or host-regression success is claimed
here. No current host or user session was modified or terminated.
