# Cross-harness Windows proof implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a repeatable, evidence-based activation path for discretionary cross-harness messaging on the installed Windows harnesses before shipping a broker or UI.

**Architecture:** Isolated probe processes exercise native interfaces against disposable conversations. A dependency-free Node JSON-RPC client supports correlated requests and events without logging secrets. Results distinguish transport acceptance, model observation, and unavailable capabilities.

**Tech Stack:** Windows PowerShell, Node 24 built-ins and node:test, installed Claude Code and Codex CLI, existing Rust host tests.

**Spec:** `docs/superpowers/specs/2026-09-08-cross-harness-collaboration-design.md`, Stage 0 and its acceptance criteria.

**Milestone status:** The core discretionary interaction, reverse context reads/messages, ordinary-TUI idle wake, drafts, and Codex running-tool delivery were observed. This plan remains open for the explicitly unexercised Stage 0 gates below; see the [capability report](../reports/2026-09-08-swarm-windows-proof.md). No production broker or UI is shipped by this milestone.

## Global Constraints

- User's overnight instruction: preserve critical files and running work. Do not delete filesystem artifacts; move anything that must be removed into a `retired` folder with a clear original-path record. Preserve the GitHub backup. Continue bounded, sustained testing, research, linting, and optimization toward effective collaboration.
- No round, message-count, token-budget, or mandatory-summary cutoffs imposed by TermX.
- Do not message or restart the user's current work.
- Never start a second writer to the same conversation or silently replace a running agent.
- Compare effective provider route, custom model, effort, permissions, cwd, and configuration sources across any handoff, not only the model's display label.
- Do not export internal reasoning or raw authentication/environment/configuration data as peer context.
- Ordinary-existing-TUI attachment and verified remote-runtime launches are separate capability rows.
- Scope this plan to Stage 0; production broker, context library, and UI require subsequent implementation plans using the observed capabilities.
- Keep process handles and exact generated session IDs for cleanup. Never kill by process name. Store disposable state under ignored `.superpowers/swarm-proof/`.

## Task 1: Tested probe transport

**Files:** Create `tools/swarm-proof/rpc.mjs`, `tools/swarm-proof/rpc.test.mjs`.

**Interfaces:** Export `RpcClient` with constructor `new RpcClient({send, close, timeoutMs = 10000, maxEvents = 256, onRequest})`; `send` receives one JSON object, `close` closes its transport, and optional `onRequest(method, params)` handles server requests. Methods: `receive(object)`, `request(method, params, {timeoutMs} = {}) -> Promise`, `notify(method, params)`, `nextEvent(predicate, {timeoutMs} = {}) -> Promise`, `disconnect(reason = new Error('RPC disconnected'))`, `close()`. Events are notifications without IDs. Callers own stream framing and connect lifecycle.

- [x] Write tests that observe concurrent reversed responses resolving the correct requests, an RPC error rejecting only its matching request, disconnect immediately rejecting outstanding requests/event waits, a timed-out request rejecting and ignoring its late response, and an event arriving before a wait remaining observable exactly once.
- [x] Also cover bounded event storage failing explicitly on overflow rather than silently losing evidence; malformed envelopes fail closed; server requests produce correlated result/error responses; absent handler returns method-not-found; `close()` closes transport only once. Notification/event wait predicates throwing must not escape the transport callback or hang an unrelated request.
- [x] Run `node --test tools/swarm-proof/rpc.test.mjs` and capture the expected initial failure before implementation.
- [x] Implement the interface with monotonically increasing local request IDs, Maps for pending requests, timeout cleanup, retained bounded notifications, and settled-state guards. Never print payloads or catch an error as success. A timeout means unknown external outcome, not proof of non-delivery. Clear event storage on disconnect.

```javascript
// Independently derived correlation expectation used by the test fixture:
const first = client.request('first', {});
const second = client.request('second', {});
client.receive({id: 2, result: 'B'});
client.receive({id: 1, result: 'A'});
assert.deepEqual(await Promise.all([first, second]), ['A', 'B']);
```

- [x] Re-run the Node test command, inspect failures and leaks, commit the two files, and obtain an independent task review. This helper is probe-only and is not the production broker transport. Seventeen tests passed; task review approved after fixes in `f17261a`.

## Task 2: Isolated native runtime experiments

**Files:** Create probe entrypoints in `tools/swarm-proof/` as the native interfaces are established; keep ephemeral credentials, generated session data and raw events only under `.superpowers/swarm-proof/`. Create `docs/superpowers/reports/2026-09-08-swarm-windows-proof.md` for sanitized observations and commands. No normal host/UI startup changes.

**Interfaces:** Consume Task 1's RPC client. Use installed generated protocol at the original checkout `.superpowers/swarm-research/codex-protocol/` and version-matched Claude source, verifying runtime outcomes independently of documentation.

- [x] Record exact versions using `codex.cmd --version` and `claude --version`. Inspect only an allowlist of routing metadata; retain auth privately through normal inherited configuration. Record explicit isolation differences rather than claiming full launch parity.
- [x] Launch a disposable ordinary Windows Codex TUI, capture its PID/start identity and exact thread ID, inspect its own endpoint availability, and test `codex queue` against that exact disposable thread. Do not target a production thread. If no endpoint exists, record the concrete failure and continue to the separate remote path. The saved ordinary TUI received native CLI queue input without an attachable RPC endpoint.
- [x] Launch one owned `codex app-server --listen ws://127.0.0.1:PORT` in a synthetic workspace, connect with JSON-RPC initialization, create isolated threads, and inspect loaded ownership and allowlisted metadata. Negotiate experimental API before queue operations. Full effective settings parity remains a separate open gate.

```javascript
await client.request('initialize', {
  clientInfo: {name: 'termx_swarm_probe', title: 'TermX isolated proof', version: '0.1.0'},
  capabilities: {experimentalApi: true}
});
client.notify('initialized', {});
const loaded = await client.request('thread/loaded/list', {});
```

- [ ] Exercise same-owner rejoin, queue add versus start, idle wake, busy/tool-running delivery, duplicate correlation keys, and rejection of a mismatched active-turn ID. Capture ordered state transitions and exact IDs; do not infer model consumption from request success. Partial coverage includes durable rejoin, idle auto-start, busy-tool deferral, two pending rows sharing a client key, and a held-active-turn mismatch. Successful explicit queue/start and broader retry/race behavior remain unproved; a consumed ID's not-found response is not a substitute.
- [ ] Test the native remote TUI as its own row, including a composer draft and broker-client disconnect. Compare effective settings before/after. Do not automatically approve unrelated tool requests. Not exercised: ordinary TUI delivery supplied the core receive path; remote TUI remains a gate if offered.
- [ ] Launch disposable Claude sessions through the actual PowerShell wrapper with generated session UUIDs and scoped test settings. Establish native peer framing using its peer credential, never the own-child credential. Test exact-session rejection, accept/hold/refuse and permission classes. Preserve native peer provenance and observe actual same-process receipt. Partially exercised: scoped accept, mismatch, peer provenance, idle wake and draft preservation passed; hold/refuse and pending approval/input states remain open.
- [x] With a minimal member-scoped probe tool surface, test two threads sharing one Codex server. Confirm tool calls identify the exact originating thread using server-supplied routing, reject caller-supplied sender substitution, and revoke peers independently. If standard MCP lacks sufficient identity, document it rather than treating server PID as thread identity.
- [x] Run a synthetic shared problem after only a broad collaboration introduction. Let agents choose context reads and messages, observe at least one reverse-path context read and message, then observe a chosen message wake an idle peer. Distinguish scripted transport probes from this autonomous scenario. A diagnostic timeout stops the test process only; it is not a product conversation policy.
- [x] Close only handles/processes created by the probes and verify exit. Record every scenario as observed pass, observed failure, or not exercised with the exact reason.
- [ ] Verify the user's custom Claude/Astra launcher and full effective configuration-source/permission parity. Launcher details were requested but unavailable for this milestone.
- [ ] Prove scoped tool activation in arbitrary already-running sessions, including managed/project policy precedence. The observed MCP path used a deliberate handoff of disposable sessions.

## Task 3: Review and publish the capability evidence

**Files:** Finalize the report, add `tools/swarm-proof/README.md`, update checkboxes in this plan. Amend the approved design only where runtime evidence requires a concrete adapter correction.

**Interfaces:** The report is the contract for later broker/adapter plans: harness version, activation shape, identity proof, wake behavior, receipt evidence, settings differences, limitations, commands, and remediation.

- [x] Review each Stage 0 requirement against evidence. Do not mark the milestone fully proved if autonomous exchange, idle wake, identity, or launch parity remains unproved. Core interaction works; remaining gates are explicit above and in the report.
- [x] Re-run Node tool tests and any changed native code's targeted tests. Use `git diff --check` and inspect tracked additions for credentials, absolute personal runtime paths, raw conversations, and generated artifacts. Final default run: 17 passed, one live integration skipped; corrected live run: 1 passed in 71.27 seconds. Invalid executable fails cleanly. Task 2 scoped re-review approved `8a23ef6`. No native application code changed in this checkpoint.
- [ ] Obtain a whole-change review covering correctness, truthful claims, cleanup, and remaining blockers. Resolve material findings and rerun covering tests.
- [ ] Commit the tested scripts and sanitized report on the isolated feature branch and push the feature branch to the user's existing GitHub remote. Preserve the verified `backup/pre-swarm-2026-09-08` branch. Do not deploy binaries or merge into the current running application as part of this proof.

## Preflight coverage

Task 1 provides only generic test transport; Task 2 owns all native and real-agent proof obligations; Task 3 checks that untested cases stay explicit. Production durability, UI, and context paging tests belong to Stages 1–4 and are not claimed by this milestone. Experimental activation failures are evidence, not grounds to fabricate a successful capability.
