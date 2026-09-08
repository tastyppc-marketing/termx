# Offline collaboration completion observer validation

The evaluation observer now applies the approved completion rule to typed adapter
inputs and an owned task directory. It is evaluation tooling, not a native harness
adapter or evidence that collaboration improves results. No comparative pilot has
started, and no live TermX executable or user session was changed.

The implementation lives in `tools/swarm-evaluation/observer/`. A candidate requires
exact participant/runtime/binding identities, a normal final after the latest
task and delivered wake, and known zero model/tool/delegate work and outstanding
notices. Two fresh coherent acquisitions at least one second apart must agree on
the complete revision tuple, final identities and task-tree hash. Missing evidence
does not count as zero work. The 60-minute experimental deadline runs from the
first task submission; censoring never awards completion credit.

The observer captures bounded regular-file bytes through verified opened handles,
rejects linked/reparse paths and changing inventories, and stores metadata outside
the scoring tree. Publication exclusively creates an uncredited attempt, writes
the snapshot, renames its directory, then commits by renaming the pending manifest
to its exact authoritative filename. Failed attempts and partial publications are
retained. A reconstructed controller refuses existing output; no automatic crash
recovery or fsync durability is claimed. Later observed writes receive separate
retained snapshots and cannot replace the scored tree.

## Review and retained evidence

GPT-5.6-SOL implemented the offline prototype and repair. Root review and independent
Grok 4.6 review found and closed defects in path checks, bounded enumeration,
acquisition timing, publication failure handling and repeated late copies. The final
independent review concluded Spec PASS / Quality APPROVED on 2026-09-08 at
19:49:09 UTC. Its retained public review has SHA256
`29eb8f2cf210426bb968445b241d42b09797c881cf8a6b20555280c2e7807474`.

The repaired prototype final run is
`retired/test-artifacts/swarm-core/evaluation-observer-fix-1-final-20260908T1935066478695Z`.
It passed 30 unittest cases and Ruff, both native exit 0, with four unchanged source
inputs. Root independently verified source and log hashes, 14 complete snapshot
inventories and four explicit uncommitted directories that receive no credit.
The original prototype, superseded failing runs and exact frozen source archive
remain preserved.

The three Python files were copied byte for byte from that reviewed archive into
the tracked tools directory. Only the README's invocation path changed. The new
directory has the same nesting depth, so the runner's repository-root resolution
remains unchanged. Relocation verification is retained at
`retired/test-artifacts/swarm-core/evaluation-observer-promoted-20260908T195400Z`:
30 unittest cases and Ruff passed again with native exit 0 and stable source hashes.
Its `commands.json`, `run-manifest.json`, `source-hashes.json`, `evidence-hashes.json`
and command logs record exact arguments, times and hashes. All fixtures remain
under that owned evidence directory; no automatic temporary-directory cleanup runs.

The suite includes actual file changes, controlled tool/wake state transitions,
unavailable and stale observations, failed mkdir/write/rename, collision preservation,
late-write retry/deduplication, and Windows reparse/handle containment. Synthetic
adapter assertions do not verify the native facts they describe.

## Remaining acceptance gates

Neither installed harness has yet demonstrated a complete recursive delegate census
for the selected pilot route; exact final-after-wake correlation also needs native
proof. The future adapter must establish those facts with owned native barriers,
ordinary harness settings and exact identities. Unsupported evidence stays
unavailable and can censor the affected pilot arm. This does not disable otherwise
verified product tool/context/wake capabilities or impose delegation/message limits.

The capture is coherent under its documented checks, not an atomic provider-plus-
filesystem snapshot. Late writes are retained only when another observation occurs.
Windows behavior is tested in this lineage; the `/proc/self/fd` fallback is unverified.
File/tree bounds still need checking against every frozen evaluation packet.
