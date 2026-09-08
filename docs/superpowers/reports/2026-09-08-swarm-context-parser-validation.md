# Pure context parser validation

The new `termx-swarm-context` crate parses recorded Claude and Codex structures
into a separate allowlisted peer projection. It is an independently reviewed
library milestone. It does not yet replace the owner transcript viewer or
provide verified source capture, context tools or native broker provenance.

## Behavior and limits

The streaming JSONL scanner requires complete newline-terminated records,
strict UTF-8, a root object and unique decoded object keys. It bounds a record
to 1 MiB including its terminator, JSON depth to 64, nodes to 65,536 and members
per object to 16,384. Oversized incomplete records retain bounded scanner
storage and continue hashing/ranging until their terminator; later valid rows
remain readable. Incomplete final rows report lag.

Peer projection keeps supported user/assistant text, tool identity and results,
and recognized compaction records. Native record/response/call identities and
block order remain distinct. Private reasoning, instruction records, unsupported
sensitive variants and tool arguments are excluded. Generic aggregate omission
counts carry no private per-record identity or digest. Unknown models do not
change routing. Literal copied prose and forged shell envelopes remain complete
untrusted text; they do not create an authorized source reference.

The batch owns at most 256 projected records and 2 MiB of encoded envelope;
full admission does not mutate the accepted batch or clip a provider record.
Cached checked counts avoid rescanning prior entries on each push. Owner parsing
uses independent identity state and entry points and does not inherit peer block
limits. Owner projection deliberately cannot be serialized by the peer encoder.
This separation is not a claim of parity with the existing owner UI.

These are structural and allocation-request bounds, not an aggregate process
RSS guarantee. Input, parsed trees, key sets and projected text can coexist.
The later capture/publication adapters must account their simultaneous owners,
source I/O, queues and output credits separately.

## Review and verification

GPT-5.6-SOL implemented the crate. Root review found and drove corrections for
owner/peer identity contamination, inherited owner limits, nested total-block
admission, avoidable private materialization, batch rescanning and scanner
capacity growth. Behavioral RED/GREEN evidence is retained. Independent review
then identified one remaining acceptance-test gap: selected-field assertions
did not compare actual parser output to the full approved fixture oracle.

The test-only correction adds complete ordered semantic comparisons, exact
native/oracle copied-prose and forged-shell equality, all aggregate omission
counters, and negative controls for altered text, linkage, order and
marker-preserving truncation. All 31 first-freeze files remained unchanged;
one new oracle test made the final freeze 32 files. Independent re-review
returned **Spec PASS / Quality APPROVED** with the finding closed.

Final package verification on 2026-09-08 passed **39 tests and one compile-fail
doctest**, package formatting, strict all-target Clippy and release build.
All five native exits were zero, from 21:43:21 through 21:44:20 UTC, using a
fresh retained target. Root independently reconciled all 32 live/frozen input
hashes, ten logs, exact command arguments/exits, counts and five release
artifacts at 21:44:49 UTC. Source normalization at Git integration is checked
separately against the preserved raw inputs.

Evidence directory:
`retired/test-artifacts/swarm-core/task-5-phase-a-fix-1-final-20260908T2143042806989Z`.

- Source freeze SHA-256: `deae6f653a6e14d6d2a8c867c17d167d49f948c238d1445e723e71f0f5e6cbc6`
- Command manifest SHA-256: `cbdd69a74c5bf59e9ff27d0a0e432fb490ecab4f7131540a59d6a3f8b3705167`
- Release manifest SHA-256: `325a55612b416f510cf61b01cc93ed65de0568d85725e97761c1ee4587358fcc`
- Release rlib SHA-256: `937bb2529d0f305f43aac7ab0ab4bba2d514586f3d7fde204a81ee5a8d01fa26`

Dependencies reuse serde/serde_json and add sha2 0.10.9. Existing locked
packages were not upgraded. Both original fixture bytes and the separately
approved two-summary oracle adjustment remain preserved. The first freeze,
failed runs, reviews and superseded evidence are retained.

Integration pins fixture files as binary for Git newline handling. This keeps
their recorded hashes and byte offsets intact when checking out on Windows
with `core.autocrlf=true`; source code retains the repository's normal handling.
An isolated staged-file checkout verifies the fixture bytes before publication.

No installed executable, live conversation or provider configuration was
changed. Verified Windows capture/indexing, owner compatibility adapters,
authorization/publication integration and the comparative collaboration pilot
remain later work; these tests establish none of those claims.
