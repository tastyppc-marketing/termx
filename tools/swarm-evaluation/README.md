# Collaboration evaluation preparation

These standard-library recipes create four synthetic task packets, reference
solutions, independent grading checks, and preserved evidence. They do not launch
models or modify the running TermX host. See the
[evaluation protocol](../../docs/superpowers/plans/2026-09-08-collaboration-effectiveness-evaluation.md).

From the repository root, using Python 3.11 or newer, Node.js and Git:

```powershell
python -B tools/swarm-evaluation/prepare_python_packets.py
python -B tools/swarm-evaluation/prepare_review_packet.py
python -B tools/swarm-evaluation/prepare_cursor_packet.py
```

Each invocation creates a new directory under
`retired/test-artifacts/swarm-core/`. It initializes and commits nested task
repositories using the existing Git identity, runs basic checks against the
starting code, verifies the exact expected stronger-test outcomes, and checks
the reference solutions. Intentionally defective starting code must fail the
specified grading checks; an arbitrary import error or missing check is a
preparation failure. Nothing is deleted or regenerated in place.

The manifests retain source/evidence hashes, recipe hashes, repository revisions,
packet commits, commands and named results. A nonzero recipe exit means that
preparation did not meet its expected contract; preserve that directory when
investigating. The scripts intentionally fail if Git cannot create the nested
baseline commit; they do not change global Git configuration.

Only copy `packet/` contents into a fresh model-run repository, away from the
grading/reference corpus. Never run a model in the preparation directory.
Graders encode disclosed requirements but are withheld by procedure, not an OS
access boundary. Preserve ordinary harness permissions, keep references out of
the prompt, audit observed access, and invalidate contaminated runs as described
in the protocol.

The four cases are a review task, asynchronous repair, a multi-file cursor
compatibility change, and a straightforward sorting control. As of 2026-09-08,
the fixtures have passed independent preparation review. No comparative model
runs or collaboration-superiority results are claimed.
