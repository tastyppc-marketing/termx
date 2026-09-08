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

## Accounting from finalized owned sources

The offline collector reads an explicitly selected synthetic evaluation JSONL
source and verifies its expected conversation. It makes no model calls, changes
no source files, and exports counters and provenance metadata without transcript
text. For example:

```powershell
python -B tools/swarm-evaluation/usage_accounting.py --harness codex --source 'C:\owned-evaluation\rollout.jsonl' --conversation-id '<owned-thread-id>'
python -B tools/swarm-evaluation/usage_accounting.py --harness claude --source 'C:\owned-evaluation\conversation.jsonl' --conversation-id '<owned-session-id>'
python -B -m unittest discover -s tools/swarm-evaluation -p test_usage_accounting.py
```

Use a finalized source; its returned hash binds the bytes read and is not a live
snapshot guarantee. The collector counts distinct native response IDs. Claude
can repeat one response's usage in several assistant records; Codex cumulative
counters can reset on resume. Repeated identical response observations count
once, while conflicting/missing/malformed accounting returns `unavailable` and a
nonzero exit. It does not fall back to cumulative snapshots or guess a zero.

Success is labeled `recognized_source_usage`, with explicit coverage fields.
It covers recognized response records in that selected source, including its
recorded setup and resumes. Full-run usage, delegated calls, provider billing,
and overlap between sources remain unverified. Before reporting a pair's total,
record harness/schema versions and an owned source inventory, and verify whether
parent and descendant counters are disjoint or overlapping rollups. If that
coverage cannot be established, preserve the per-source results and report
run-level accounting as unavailable. Keep native counter categories separate;
they can overlap and must not all be added together. No dollar estimate is made.

The input record limit is 16 MiB. Retained memory grows with distinct response
IDs; decoding also uses memory for one record and its Python objects. This
offline diagnostic is not a broker memory bound or a private-context reader.

## Completion observation

The [offline observer](observer/README.md) accepts typed adapter evidence, waits
for two coherent completed observations, and retains one immutable scoring tree.
It keeps unavailable work pending, censors at the evaluation deadline, and retains
later writes separately. Run its owned tests through the retaining runner in that
directory; each invocation needs a new evidence path.

This verifies the observation and file-publication rules only. The native harness
adapters and comparative pilot remain pending. The
[validation report](../../docs/superpowers/reports/2026-09-08-swarm-observer-validation.md)
records the independent review and preservation checks.
