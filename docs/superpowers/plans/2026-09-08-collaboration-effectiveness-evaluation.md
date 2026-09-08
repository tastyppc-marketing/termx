# Evaluating whether collaboration helps

Date: 2026-09-08. Status: four synthetic task packets prepared and independently reviewed; no comparative model results claimed yet. See the [preparation evidence](../reports/2026-09-08-swarm-evaluation-preparation.md). This accompanies the [durable-core work](2026-09-08-swarm-durable-core.md) and the user's request for sustained reliability and productivity testing.

## What the evidence changes

A 2026 study found that one agent executing multi-turn workflows could match several multi-agent baselines across seven benchmarks, with an efficiency advantage. It is a preprint and does not directly test freely collaborating installed Codex and Claude harnesses. Its practical implication here is a strong iterative solo comparison, rather than comparing a pair against one hurried answer. [Xu et al., 2026-01-18](https://arxiv.org/abs/2601.12307).

The revised MAST study reports a failure taxonomy built from expert examination of 150 traces, alongside a larger annotated dataset. Its categories include system design, inter-agent misalignment, and task verification. It does not prove that adding a broker prevents those failures. We will separately record transport faults, stale/conflicting information, unsupported agreement, and missed verification. [Cemri et al., revised 2025-10-26](https://arxiv.org/abs/2503.13657).

METR's long-task methodology relates success to measured expert-human task duration and emphasizes uncertainty in task selection and reference timings. We will report actual run duration and task complexity separately. A small locally authored pilot cannot establish a precise human-equivalent time horizon or general long-task success rate. [METR, 2025-03-19 methodology](https://metr.org/blog/2025-03-19-measuring-ai-ability-to-complete-long-tasks/).

These findings motivate conditional claims: a particular exchange may improve a particular outcome, while another task may be faster or cheaper alone. Message volume and agreement are not success metrics.

## Initial pilot

Freeze four task packets and their scoring rules before model runs:

1. **Review with independently checkable defects:** a prepared patch with several seeded correctness/lifecycle defects plus harmless distractors. Grade defect precision/recall and severity, with tests confirming every scored defect.
2. **Bug repair:** a compact asynchronous or stateful component with visible regressions and held-out edge cases. Grade the final artifact against unchanged tests, including failure recovery.
3. **Multi-stage compatibility change:** a small project requiring changes across a parser, state transition, and caller while preserving an existing contract. Grade complete behavior and regression protection, not the number of files changed.
4. **Straightforward control:** a small deterministic change for which additional coordination may add little. Productive silence is allowed and is not a collaboration failure.

Each arm gets the same complete goal, source, constraints, and visible checks. Never manufacture an advantage by giving each collaborating agent clues withheld from the solo agent. Held-out checks stay outside the delivered task repository and are applied after the artifact is frozen; they encode the same requirements rather than surprise requirements.

Materialize only the packet into each run repository, away from the preparation corpus and its grading/reference siblings. Instruct every arm to work from the supplied task and not seek reference solutions or evaluation files. This is benchmark separation, not an OS access boundary: ordinary unrestricted harness permissions can still reach other same-account files. Preserve normal permissions, record this limitation, and invalidate an arm if reference or held-out access is observed. A later physically isolated evaluation can provide a stronger contamination guarantee; this pilot cannot claim one.

Run **Astra/Codex solo**, **Fable/Claude solo**, and **the pair** on fresh independent task copies. The pair shares one task copy, as two sessions working on the same project would, and chooses its own coordination. Neither model gets a designated role, leader, schedule, required reply, or number of messages. Give solo agents normal iterative tool use and self-review. Compare the pair against each solo result and against the stronger solo result for each task.

Use fresh isolated nested repositories under the retained test-artifact tree; never run these tasks in the user's working project. Preserve original task packets, final artifacts, source hashes, and synthetic native histories. Any artifact needing removal goes into `retired` with its original path recorded. Do not change global harness settings or ordinary permissions.

Start the comparison only when the protected communication/activation path used by that run is ready. A run using a disposable prototype must be labeled a prototype evaluation and cannot validate the production broker. Avoid large batches of model calls just to reconfirm working message transport.

## Submission, completion and the scored artifact

Before any comparative model call, freeze the controller's submission templates,
their exact instantiated UTF-8 bytes/hashes, setup procedure, run order and this
completion rule in the run manifest. The common task instruction is the same for
every arm; the pair receives only a process introduction explaining that the
connected sessions have the same complete task and may communicate or inspect
peer context when useful. No extra hints, prescribed roles, required messages or
coaching are added. The canonical templates are in
[pilot-submission-contract.md](../../../tools/swarm-evaluation/pilot-submission-contract.md).

Each case has one scored artifact, including for the pair:

| Case | Canonical submission |
| --- | --- |
| Review | The single `FINDINGS.md` required by the already frozen packet; proposed source must remain unchanged. |
| Asynchronous repair | One frozen task repository, including `coalescer.py` and any submitted helpers/tests. |
| Cursor compatibility | One frozen task repository, including `parser.mjs`, `state.mjs`, `client.mjs` and submitted helpers/tests. |
| Sorting control | One frozen task repository, including `display.py` and submitted helpers/tests. |

No human unions the two agents' reports, chooses between their answers, or merges
their changes after submission. Overwrites and conflicts remain part of the
pair's outcome. The packet's existing requirements and frozen grading rules are
unchanged by this clarification.

Main sessions are the arm participants: the one solo session or both explicitly
connected pair sessions. Ordinary internal delegates are covered by the absence
of known active delegated work below, without extra final-response requirements.

Completion is the first **verifiable completed work-turn boundary** for all main
sessions in that arm: each has returned a normal native final response after its
task input and any subsequently delivered peer wake, with no known active model,
tool or delegated work and no queued/in-flight native collaboration notice. A
final response is a submitted candidate even if it is wrong or asks for unnecessary
clarification; the controller never uses grader results to extend a run. Normal
iterative tool use and self-review before that response remain unrestricted.

The controller confirms the candidate boundary with two observations one second
apart, recording native completion/queue evidence, broker revision and the task
tree's file hashes. Both observations must show the same completed state and
artifact. A change restarts observation without sending a model prompt. The short
confirmation interval establishes observed stability; inactivity alone can never
finish a run while a model/tool is working. This is not a provider-atomic snapshot
or a product conversation cutoff. A lack of observable completion/queue/delegation
state is recorded as unavailable evidence, not inferred from a quiet terminal.

Record both the first verified candidate-boundary time and confirmed freeze time.
Freeze the as-observed tree once; apply held-out grading only afterward. Preserve
any later writes separately without replacing the scored snapshot. Known held,
refused, unavailable or uncertain activation that prevents the completion rule is
an operationally limited outcome, with the partial artifact retained and no claim
of successful production-path completion.

The pilot has a 60-minute observation window per arm from its first task-submission
timestamp, the same instant work time starts. This
is an experiment duration, not a product message/turn/token limit. If completion
cannot be verified in that window, or a provider/authentication interruption
prevents it, record a censored/operationally blocked attempt and preserve its state
before gracefully ending only the owned synthetic sessions. Do not count a partial
artifact that happens to pass grading as a completed success. No restart or extra
instruction is hidden inside the original attempt. The controller's completion
observer must pass owned active-tool, delayed-wake, late-write and unavailable-state
checks before the first pilot arm starts.

## Setup time and intervention policy

Use the same neutral initialization instruction for each fresh harness, so a saved
native conversation can exist before task work begins. Do not inspect task files
during that setup. Record startup through native readiness separately: ordinary
tools/session readiness for a solo, and both sessions plus exact tool/context/wake
capability snapshots for the pair. Native setup usage stays visible.

Record setup duration, task dispatch times for every participant, dispatch skew,
work-to-completion duration, freeze-confirmation overhead and total launch-to-freeze
duration. Work time starts with the first task submission in the arm, so the pair
does not receive uncounted work while its second prompt is being delivered. Compare
work durations on that definition; publish setup and total durations beside them
as product overhead. Do not silently include startup for one arm and exclude it
for another. Interleave a pre-registered arm order and record shared-machine load;
do not clear user caches or stop unrelated user processes for a timing advantage.

After the frozen task submission, the owner composer and additional human/controller
task instructions are unused. Necessary ordinary permission decisions must follow
the same supplied task scope for every arm and be logged with times and requested
actions, without coaching or hint text. A need for substantive clarification ends
the attempt as blocked; the controller does not provide extra task knowledge to
one arm. Corrections after a failed attempt become separately labeled attempts,
with the original preserved and reported.

## Run record

Record the repository/fixture revision, harness versions, model/provider metadata, reasoning settings, permission configuration summary, enabled tool names, and exact activation capability. Opaque/custom model names remain opaque. The user's Claude/Astra route is a separate coverage item until its launcher is known and verified.

Keep structured observations:

- elapsed time from the arm's first task submission to confirmed freeze under the completion rule, with candidate-boundary and confirmation times recorded separately;
- completion and every deterministic check result;
- input/output/cache token counters as reported by each native harness, preserving their categories;
- tool calls and cross-harness message/receipt counts;
- broker/native failures, retries, pauses, and uncertain outcomes;
- public peer contributions referenced or incorporated into the final work.

Do not sum repeated cumulative usage snapshots as though they were separate calls. Record unavailable accounting rather than inventing a number. Report the pair's combined usage. Additional cached prompt context and harness setup are real overhead and should remain visible. Dollar estimates require verified pricing for the actual route; tokens alone are not a dollar cost.

Use the [offline response-accounting helper](../../../tools/swarm-evaluation/README.md#accounting-from-finalized-owned-sources) only for finalized owned sources. The observed Claude format repeats usage across assistant blocks; the observed Codex format provides per-response records alongside cumulative counters that reset on resume. A valid per-source result does not establish complete run coverage. Record harness/schema versions and an owned source inventory, verify delegated-call coverage and whether parent/descendant counters overlap, and report total-run or pair accounting as unavailable if that cannot be established. Preserve valid per-source categories separately rather than silently assuming missing usage is zero.

Do not export private reasoning. Use only authorized recorded user/assistant text, permitted tool evidence, broker events, and final artifacts. A quoted message ID in a tool result is not a delivery receipt. Label an observed contribution as such; a public trace does not prove what a model would have independently thought later.

Record coordination as observed, with evidence coverage: broker-mediated exchanges,
workspace-only coordination, or parallel edits with no observed exchange. Collect
saved messages, serviced context reads, known file-write ordering and identifiable
overwrites where public tool traces support them; mark actor/order attribution
unavailable where they do not. A workspace-only pair win is not evidence that the
TermX message/context interface caused the gain. A matching edit or cited peer
message is evidence consistent with a contribution, not a counterfactual proof.
Neither wake, Saved, fetched nor ACK is itself a scored intellectual contribution.
Record fixed native wake turns, waits, setup and permission interactions as overhead.
Capability-limited attempts must retain their exact tool/context/wake states in
the result, rather than being grouped with fully ready production-path runs.

## Scoring and comparison

Use deterministic acceptance checks as the primary evidence. For review tasks, separately count correct defects, unsupported defects, and missed severe defects. For changes, report requirements satisfied, regression failures, and whether the submitted tests actually exercised the changed behavior.

Any qualitative review should hide the arm label and usage/latency while judging the artifact. An automated review is an automated review; it must not be presented as blinded human assessment. Resolve disputed correctness with executable checks where possible, preserving the original artifact before revisions.

Publish task-level wins, ties, regressions, work-to-completion duration, and combined usage where coverage permits. Show setup, confirmation overhead and total launch-to-freeze durations beside work time. Four tasks are a feasibility pilot, not statistical evidence of a universal advantage. If the pair improves quality only by using substantially more inference, say so when comparable complete usage supports it. A later sensitivity comparison can give the stronger solo harness comparable opportunity for additional attempts without truncating normal conversations to force equal token counts.

When either compared arm lacks verified complete run-level usage, do not compare
cost, total token efficiency or quality-per-token. Publish recognized per-source
categories and coverage limits separately, alongside non-cost overhead indicators.
Enabled native delegation tools are recorded for the solo arms as well as the pair;
one terminal is not automatically one model forward pass. Public trace review
also records stale/conflicting peer information, unsupported agreement, missed
verification and observed overwrites, without exporting private reasoning.

Do not select only tasks where the pair wins. Preserve failed attempts and straightforward controls. If interaction introduces a bad assumption, conflict, redundant work, or missed verification, that is a useful result for improving the communication/context interface.

## Sustained work

Reliability soak tests and model effectiveness tests answer different questions. The core's initial 30-minute load/recovery test checks durability, queue bounds, memory, and latency; it does not establish that agents solve long projects well.

After the pilot, expand the task set and repetitions as justified by observed uncertainty and actual resource use. Include longer projects with multiple tool/verification steps and independent final checks. The research notes propose a larger 18-task pilot and a later multiweek evaluation, but neither is represented as completed overnight.

Improve the product using observed failure mechanisms: clearer provenance when evidence is misattributed, durable replay when a handoff is lost, efficient context paging when repeated history reads dominate, and truthful status when an agent or transport is unavailable. Preserve the user's discretionary communication model. Do not convert evaluation findings into compulsory roles, scripted debate rounds, or message quotas.
