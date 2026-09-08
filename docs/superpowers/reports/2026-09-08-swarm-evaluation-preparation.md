# Collaboration evaluation: prepared fixtures

Date: 2026-09-08. Four synthetic tasks and their grading rules are prepared and
independently reviewed. No model comparison has run. The production collaboration
path remains a prerequisite for the pilot described in the
[evaluation protocol](../plans/2026-09-08-collaboration-effectiveness-evaluation.md).

| Task | Reference checks | Starting-code evidence |
| --- | ---: | --- |
| Patch review | 3 | All three independently witnessed defects reproduced: cross-group retry collision, lost pending work after a known transport failure, and recipient ACK contamination. |
| Asynchronous repair | 8 | Cached completed work and shared cancellation fail the stated contract; existing shutdown and shared-failure behavior pass. |
| Cursor compatibility | 13 | Exact integer, source, normalized request, reset and response checks expose the intended legacy gaps; malformed-object rejection and service-failure state preservation pass. |
| Sorting control | 5 | Comparison normalization and unnamed-record ordering fail; original object preservation and empty output pass. |

All starting packets pass their visible basic checks. All reference checks pass.
Preparation validates the exact named outcome maps, including expected passes;
an arbitrary nonzero grader exit is insufficient. References and checks use
Python 3.11.15 and Node.js 24.14.1 from the test environment, with standard-library
dependencies. The reproducible recipes are in
[tools/swarm-evaluation](../../../tools/swarm-evaluation/README.md).

The review rubric freezes defect IDs, trigger/consequence/repair criteria and
severity. Precision, recall, severity agreement and finding completeness are
separate results. Additional real defects must receive executable witnesses and
consistent adjudication across every arm. Automated scoring will be labeled
automated; none has run yet.

The asynchronous checks use events and event-loop barriers for synchronization.
A focused mutation removing only the reference's exception-retrieval callback
was rejected by the abandoned-operation check. This verifies that the check can
detect that specific missing guarantee rather than merely failing on the
starting implementation's broader cancellation bug.

Retained fixture generations include `pilot-python-1788868407570009400`,
`pilot-review-1788868406040676700`, and `pilot-cursor-1788868444662718200` under
`retired/test-artifacts/swarm-core/`. Their manifests bind source/evidence hashes,
generator/support hashes, parent revisions, packet commits and exact commands.
Earlier generations, review findings and the focused mutant remain retained.

The pilot will deliver only task contents into fresh independent repositories.
Withheld graders remain outside those repositories, but ordinary unrestricted
same-account tools can still reach other files. This is procedural separation,
not a claimed sandbox. Observed reference access invalidates an arm; undetected
contamination remains a limitation. No model permissions are changed to hide it.

These checks establish fixture readiness. They do not establish model quality,
general productivity gains, statistical superiority, or long-project reliability.
