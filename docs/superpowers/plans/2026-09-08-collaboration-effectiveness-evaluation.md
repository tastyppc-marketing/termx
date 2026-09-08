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

## Run record

Record the repository/fixture revision, harness versions, model/provider metadata, reasoning settings, permission configuration summary, enabled tool names, and exact activation capability. Opaque/custom model names remain opaque. The user's Claude/Astra route is a separate coverage item until its launcher is known and verified.

Keep structured observations:

- elapsed time from task submission to a valid final artifact;
- completion and every deterministic check result;
- input/output/cache token counters as reported by each native harness, preserving their categories;
- tool calls and cross-harness message/receipt counts;
- broker/native failures, retries, pauses, and uncertain outcomes;
- public peer contributions referenced or incorporated into the final work.

Do not sum repeated cumulative usage snapshots as though they were separate calls. Record unavailable accounting rather than inventing a number. Report the pair's combined usage. Additional cached prompt context and harness setup are real overhead and should remain visible. Dollar estimates require verified pricing for the actual route; tokens alone are not a dollar cost.

Use the [offline response-accounting helper](../../../tools/swarm-evaluation/README.md#accounting-from-finalized-owned-sources) only for finalized owned sources. The observed Claude format repeats usage across assistant blocks; the observed Codex format provides per-response records alongside cumulative counters that reset on resume. A valid per-source result does not establish complete run coverage. Record harness/schema versions and an owned source inventory, verify delegated-call coverage and whether parent/descendant counters overlap, and report total-run or pair accounting as unavailable if that cannot be established. Preserve valid per-source categories separately rather than silently assuming missing usage is zero.

Do not export private reasoning. Use only authorized recorded user/assistant text, permitted tool evidence, broker events, and final artifacts. A quoted message ID in a tool result is not a delivery receipt. Label an observed contribution as such; a public trace does not prove what a model would have independently thought later.

## Scoring and comparison

Use deterministic acceptance checks as the primary evidence. For review tasks, separately count correct defects, unsupported defects, and missed severe defects. For changes, report requirements satisfied, regression failures, and whether the submitted tests actually exercised the changed behavior.

Any qualitative review should hide the arm label and usage/latency while judging the artifact. An automated review is an automated review; it must not be presented as blinded human assessment. Resolve disputed correctness with executable checks where possible, preserving the original artifact before revisions.

Publish task-level wins, ties, regressions, latency, and combined usage. Four tasks are a feasibility pilot, not statistical evidence of a universal advantage. If the pair improves quality only by using substantially more inference, say so. A later sensitivity comparison can give the stronger solo harness comparable opportunity for additional attempts without truncating normal conversations to force equal token counts.

Do not select only tasks where the pair wins. Preserve failed attempts and straightforward controls. If interaction introduces a bad assumption, conflict, redundant work, or missed verification, that is a useful result for improving the communication/context interface.

## Sustained work

Reliability soak tests and model effectiveness tests answer different questions. The core's initial 30-minute load/recovery test checks durability, queue bounds, memory, and latency; it does not establish that agents solve long projects well.

After the pilot, expand the task set and repetitions as justified by observed uncertainty and actual resource use. Include longer projects with multiple tool/verification steps and independent final checks. The research notes propose a larger 18-task pilot and a later multiweek evaluation, but neither is represented as completed overnight.

Improve the product using observed failure mechanisms: clearer provenance when evidence is misattributed, durable replay when a handoff is lost, efficient context paging when repeated history reads dominate, and truthful status when an agent or transport is unavailable. Preserve the user's discretionary communication model. Do not convert evaluation findings into compulsory roles, scripted debate rounds, or message quotas.
