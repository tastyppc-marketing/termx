# Offline completion-observer prototype

This directory contains an evaluation-only Python 3.11 prototype. It accepts
typed evidence supplied by a future native adapter and decides when one owned
synthetic task tree can be frozen for scoring. It does not inspect native
sessions itself, send model messages, use a grader, or impose a product
conversation limit.

`completion_observer.py` exposes these input types:

- `ParticipantIdentity` binds the exact session, runtime boot, and binding
  revision expected for each main participant.
- `ParticipantEvidence` binds the latest task input and delivered wake to one
  exact normal-final response, plus exact active model, tool, and delegated-work
  counts.
- `StateRevisions` retains the broker's inventory, delivery, and run revisions
  separately. They are never summed or reduced to a single counter.
- `NativeObservation` adds exact queue counts and a bounded, strictly monotonic
  acquisition interval and sequence. The acquisition fields prove that two
  reads are fresh; they are excluded from the stable completed-state signature.

Missing, unavailable, uncertain, held, or refused evidence remains `WAITING`.
A candidate requires all main sessions to have a normal final after their latest
task and wake, zero known active work, and zero queued or in-flight notices. A
second fresh observation at least one second later must have the same participant
finals, broker boot, full revision tuple, and task-tree content hash. Every
material change restarts the current candidate interval. The second native
acquisition must also begin at least one second after the candidate acquisition
completed; delaying two nearby acquisitions at the controller cannot qualify.

The 60-minute deadline starts at the first task submission. Exceeding it creates
a censored retained artifact and grants no completion credit. A successful
confirmation creates one new retained run directory containing an immutable
`scored-snapshot`. Writes observed afterward are copied beneath `late-writes`
and marked as outside the scored snapshot. Consecutive observations of the same
late tree are deduplicated, while later distinct trees are retained. Existing run
directories are refused. Publication is built in a uniquely retained attempt
directory. That directory contains the snapshot, external inventory, and an
`observer-publication-preparation/v1` record which is always uncredited. Once
those bytes are complete, the directory is renamed to the exact final `run_id`
path. A final `observer-artifact-manifest/v2` is then exclusively written as
`observer-manifest.commit-pending.json` and renamed to
`observer-manifest.json`. Only that exact manifest name beneath the exact final
run path is the publication commit boundary. Consumers must reject attempt
directories, preparation records, pending manifests, failure markers, and a
final run directory without a valid committed manifest, even when a pending
manifest contains the intended final state.

Attempt creation is exclusive. A reconstructed controller refuses a retained
first attempt, and an in-process collision or creation failure does not mutate
or claim the other path as retained evidence. Failures before the final
directory rename leave an uncredited attempt and allow a later candidate window
to use the next bounded sequence. A failure after that rename but before the
manifest commit leaves preserved, uncredited bytes and puts that controller in
explicit publication refusal, so it cannot create a duplicate scored freeze.
The original first-submission deadline continues to run; crossing it reports a
censored result with no completion credit and does not retry into the occupied
final path. The prototype does not reconstruct or automatically recover these
filesystem states after a process crash.

The tree capture includes every regular file except the task root's explicitly
defined `.git` metadata entry. Observer metadata is stored beside, never inside,
the task snapshot. It rejects symlinks or Windows reparse points in supplied root
paths and the captured tree, special files, path overlap with the retention root,
changed directory/file identity or metadata, and changed inventories across a
capture. Each opened file's final handle path must remain inside the canonical
task root before its bytes are read. Enumeration is streamed and fails before
exceeding 30,000 total entries, 10,000 directories, 20,000 files, 4 MiB of
relative-path bytes, 64 MiB per file, or 512 MiB of aggregate file bytes. These
prototype safety bounds must be checked against each frozen packet.

The capture is coherent according to two metadata inventories and handle-bound
file reads. It is not a provider-atomic native state plus filesystem snapshot.
The evidence objects are trusted adapter assertions. The freshness checks do not
prove that a future adapter queried the claimed native objects. No pilot may run
until an actual adapter has validated identity, generation, final-event, active
work, delegation, queue, revision, and acquisition semantics end to end.

All post-freeze late-write directory creation is inside the retention failure
boundary. Failure keeps the committed scored snapshot and its credit unchanged,
reports a failed directory only when the current call exclusively created it,
and permits a later observation to retain the changed tree once. Equal retained
late snapshots remain deduplicated.

Run the owned verification through the retaining runner, choosing a new path:

```powershell
python -B tools/swarm-evaluation/observer/evidence_runner.py `
  --run-dir retired/test-artifacts/swarm-core/evaluation-observer-<unique-id>
```

The runner invokes only the scoped unittest suite and Ruff, creates no temporary
directory, and records exact arguments, UTC intervals, native exits, source
hashes, and log hashes. It never deletes or replaces an earlier run.
