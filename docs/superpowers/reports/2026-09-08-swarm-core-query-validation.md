# Scoped collaboration queries and publication validation

Task 2 is implemented and reviewed at `c4489bd`, after repairs at `39e3ea8`.
It supplies the core operations needed by the companion: scoped discovery,
revision-coherent owner pages, mailbox/thread navigation, source lifecycle and
single-use publication validation. Host RPCs, native enrollment/context capture,
notifications and UI remain in the [integration plan](../plans/2026-09-08-swarm-companion-integration.md).
This is library validation, not an installed swarm feature.

## Behavior and review

Peer reads check the authenticated binding and one explicit group. Owner pages
separate peers/groups from memberships and sources, and continuations require a
coherent inventory revision. Bounded indexed thread queries limit sender and
recipient candidates before merging, including long hidden histories.
Navigation positions bind group, reader, binding, policy and read scope; an
explicit reset is navigation, never permission or acknowledgement.

Publication preparation owns immutable response bytes, a source observation
bound to its lease, and actual destination credits. Final writer validation
rechecks current authorization and commits one response identity. Consuming that
response requires its exact destination. Pause/rebind before validation rejects;
later policy changes do not retroactively change an already committed response.
A retry or new destination requires new preparation and validation. This does
not establish native delivery or ACK.

Guard metadata is limited to 64 KiB, checked for arithmetic overflow and charged
in request/pending-response accounting. Adapters must honestly report their
retained heap; the constructor also counts their concrete inline size. The core
cannot authenticate a dishonest adapter's assertion. The worker's reply permit
ends when Pending yields; the separate destination guard stays owned through
publication/send completion or drop. Host consumers must separately account for
their output queues and other retained buffers.

Schema v9 adds the required projections/indexes and audit fields while preserving
recognized v8 data and prior schema definitions. Tests cover populated migration,
rollback, foreign schemas, retained history and current-binding projections.

Independent SOL review closed the paging/navigation/migration/ownership findings
and found a remaining metadata undercount. Fable repaired it with behavioral RED
tests; root independently reviewed that repair and closed the finding. Three
later source-comment clarifications distinguish worker reply accounting from
destination ownership; executable lines and tests are unchanged.

## Retained evidence

Frozen run `retired/test-artifacts/swarm-core/task-2-fix-2-final-20260908T201037953546Z`
passed **135 tests, one pre-existing ignored test, and six doctests**, package
formatting, strict all-target Clippy and a release build. All five native exits
were zero, from 20:10:38 through 20:12:49 UTC on 2026-09-08.

Root's readback matched 47 inputs to raw files and committed Git blobs, ten logs,
test counts, all command exits and three fresh release artifacts. Manifest
SHA-256: `39c4e5fe6f29d883ab339c49e29c1e1834493cf1da8021745d67763e58f7ee56`.
Release rlib SHA-256:
`69c561bdbe527c14c34a7ab7b5465d641f0f4851dd443b12d33e7d1cbcfaf920`.
Original sources/report are retained in that run's `root-frozen-source-archive`.
Comment-only proof and passing fmt are in
`task-2-fix-2-root-comment-clarification-20260908T201800Z`.

The earlier 30-minute durable-core soak used an older schema/revision. It is not
a soak of this new host/transport path. Native integration, failure testing and
the comparative collaboration pilot remain outstanding.
