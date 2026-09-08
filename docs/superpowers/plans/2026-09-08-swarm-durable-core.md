# Durable collaboration core and sustained validation

> **For agentic workers:** Use `superpowers:subagent-driven-development` for bounded implementation tasks with independent reviews. This plan implements an internal foundation; it does not authorize claims that untested harness activation works.

**Objective:** Build a durable, independently testable collaboration engine that preserves authorization, chronology, messages, and uncertainty through failures. Continue toward the approved feature while the remaining native activation/policy experiments run independently.

**Authority:** [Approved architecture](../specs/2026-09-08-cross-harness-collaboration-design.md), [observed Windows evidence](../reports/2026-09-08-swarm-windows-proof.md), and the user's overnight instruction to continue research, testing, linting, and optimization without deleting critical work.

**Starting checkpoint:** `eb5ffb5`, published on both feature branches. GitHub backup `backup/pre-swarm-2026-09-08` remains at `41a72fc`. Existing TermX host and user sessions stay running.

**Progress:** Tasks 1–3 completed and independently reviewed through `6171a5d`: 59 tests passed, with package formatting and clippy clean. The bundled SQLite is 3.53.2; schema v6 preserves recognized historical layouts and delivery evidence. The core supports exact message retries, bounded snapshot pages, binding-wide acknowledgement progress, persisted delivery attempts, explicit recovery and owner-authorized continuation. Review caught and fixed late-completion ordering, mixed-generation acknowledgement gaps, and repair of already-materialized older delivery state. The serialized worker, actual subprocess crashes, sustained testing, and native/UI integration remain ahead. This is an internal library, not yet a usable collaboration control in TermX.

## Global constraints

- Never delete filesystem artifacts as cleanup. Preserve them, or move artifacts needing removal into `retired/<date-and-reason>/` with their original paths recorded. Verify any move's absolute source/destination stay within the intended workspace. Do not run clean/prune/reset commands. New durable-test directories are retained under ignored `retired/test-artifacts/`; avoid auto-deleting temporary-directory guards in new tests.
- No production user conversation is messaged, resumed, reconfigured, or terminated. Native experiments use separately created synthetic conversations and exact owned process handles/generations. Do not replace current binaries or restart the existing host during this plan.
- No message-count, debate-round, token-budget, required-role, required-reply, or mandatory-summary policy. Finite frames, bounded work queues, paged reads, retry backoff, and diagnostic test durations are implementation controls, not limits on collaboration.
- Agent identity comes from a trusted binding layer, never serialized request fields. This internal store does not itself claim to authenticate Windows processes. Its peer principal is not deserializable; future transport must construct it only after verified authentication. Owner operations and peer operations have distinct entry points.
- All peer operations check current binding and group policy inside the same transaction that reads/changes the protected state. Every caller supplies one explicit group; overlapping memberships never combine grants.
- Once accepted, a message is retained on disk. No silent truncation, record eviction, automatic history purge, schema downgrade, or replacement of an unrecognized database. Pauses/removals preserve history. Retired data is not silently restored into a new session.
- Keep private credentials, model reasoning, raw environment/configuration, and unrelated histories out of logs, test reports, and peer context. This stage stores collaboration messages and source references, not copies of all harness transcripts.
- New modes and eventual broker bootstrap must run before ordinary host startup/log cleanup/history sweeping. This stage does not change host startup at all.
- Work in `C:\Dev\TermX\.worktrees\swarm-proof`. Only one implementation agent at a time; native experiments/research/reviews may run independently. Preserve all ignored proof and review artifacts.

## Technical decisions and evidence

Add a small Rust workspace member `swarm-core` (`termx-swarm-core`). Keep pure model/policy types, SQLite storage, and the bounded worker separate. It exposes no pipe, socket, terminal input, process shutdown, or harness command in this stage. A later companion/bridge stage will use this tested engine behind the approved Windows authentication boundary.

Use `rusqlite` 0.40.2 with bundled SQLite, pinned through Cargo.lock, plus the existing serde/serde_json/thiserror/rand dependency families. Record the actual compiled SQLite version and require the fixed baseline 3.51.3 or newer. SQLite documents a WAL-reset fix in 3.51.3; bundled builds avoid depending on an older machine DLL. WAL supports one writer, so use one owned connection and serialized transactions. Keep FULL synchronous durability and bounded busy handling explicit. [SQLite WAL](https://sqlite.org/wal.html), [rusqlite Connection](https://docs.rs/rusqlite/0.40.2/rusqlite/struct.Connection.html).

Check application/schema identity before migrations or journal-mode changes. Reject future or unrelated schemas while preserving their bytes. Initialize new recognized stores transactionally; verify `foreign_keys=ON`, `journal_mode=WAL`, and `synchronous=FULL` rather than assuming setting a pragma succeeded. Use short transactions and indexed bounded reads; do not hold a database read transaction during client waits or native I/O. [SQLite synchronous settings](https://sqlite.org/pragma.html#pragma_synchronous).

Use SQLite's backup API for any live database snapshot. Never copy/move the main database alone while a WAL is active; a partial filesystem copy is not a backup. No restore/overwrite operation is exposed in this stage. [SQLite backup API](https://sqlite.org/backup.html).

The real Codex probe accepted two pending rows with one client correlation key. Therefore native correlation is not broker idempotency. Commit deduplication, recipient freezing, and delivery-attempt reconciliation belong here. Native calls happen outside transactions, with an attempt recorded before dispatch and ambiguity retained after a crash.

## Public data contract to establish

- Opaque generated IDs distinguish authority, peer, launch, group, message, delivery attempt, and source reference. OS PID, terminal ID, conversation ID, and exact creation FILETIME remain separate fields. Do not treat an address as a credential.
- A peer binding contains launch identity, terminal identity, harness/conversation metadata, a monotonically increasing binding revision, and live/offline status. Unknown model metadata is valid. Do not expose a stored arbitrary source path through peer results.
- Group state includes a monotonic policy revision, label, pause state, and explicit membership. Membership mutations use expected revision to reject stale owner updates. A global pause is not equivalent to a turn finishing.
- An authenticated peer principal binds peer ID and current binding revision. It is an internal trusted value without `Deserialize`. Owner calls have separate methods. Neither message JSON nor MCP arguments accept `sender`, `role`, or a claimed PID.
- `SendMessage` takes one group ID, a stable client key, an explicit nonempty recipient set, body, optional topic, and optional reply reference. Normalize recipient order/duplicates before comparing retry payloads. The deduplication namespace is group plus durable sender peer plus client key, not the new process generation; an authorized continuation must not turn a retry into a new message. Freeze original sender/recipient bindings on first commit.
- Successful send returns the same message ID, group sequence, frozen recipients, and committed outcome for an identical authorized retry. Same key with a different semantic payload is a conflict. Invalid/unauthorized recipients reject the whole transaction. Never partially accept a broadcast-like request.
- Keep `Saved`, native attempt/outcome evidence, `Fetched`, `Acknowledged`, and `Replied` distinct. A socket write, UI read, or native queue ID does not acknowledge a message. Receipts are per eligible recipient/message and generation; sender/other recipient acknowledgement is rejected.
- One monotonic sequence per group orders messages. A recipient's mailbox is the ascending projection of eligible delivery rows. Gaps belonging to other recipients are allowed. A contiguous acknowledgement watermark cannot jump past an unacknowledged eligible row.
- Paged mailbox cursors bind authority, group, peer, current binding/policy revision, snapshot high-watermark, and position. Cursors convey no grant. Old cursors fail after revocation/rebinding/policy changes; a new read rechecks current authorization. Records appended later do not appear midway through a frozen snapshot.
- Initial transport-size defaults may bound individual body/frame/page sizes with structured errors and continuation cursors. They never cap retained history or the number of messages an agent may send. Persist the full accepted body; no clipped success result.

## Task 1: Crate, schema, and conservative store open

**Files:** `Cargo.toml`, `Cargo.lock`, `.gitignore`; new `swarm-core/Cargo.toml`, `swarm-core/src/{lib.rs,model.rs,error.rs,store/mod.rs,store/schema.rs}`, focused schema tests and retained-artifact test helper. Keep implementation files cohesive; split before a module becomes difficult to review.

**Scope:** Establish the typed internal contract and schema foundation only. No pipe/CLI/UI, no native harness calls, no shared global data directory.

- [x] Write meaningful failing tests for new-store initialization, reopen preserving authority, unrelated/future schema rejection without file mutation, explicit durability pragmas, transactional migration failure, and compiled SQLite fixed-version baseline. Tests retain unique file-backed fixtures under ignored `retired/test-artifacts/swarm-core/`.
- [x] Add the workspace member and dependency lock entries. Do not alter existing host dependency versions unnecessarily. Check that this crate can be tested independently with `cargo test -p termx-swarm-core`.
- [x] Define validated IDs, errors, binding/group/message/delivery/receipt records, and distinct trusted-principal versus serialized-request types. Enforce finite field lengths and integer conversions; never deserialize an owner/peer principal from untrusted JSON.
- [x] Create versioned tables/indexes for authority metadata, peers/current and historical bindings, groups/memberships, messages, recipient deliveries, acknowledgements, delivery attempts, and continuation records. Reserve no arbitrary SQL/path execution surface. Use foreign keys and unique constraints for structural invariants.
- [x] Implement conservative open/initialize and an integrity/durability inspection method for tests/diagnostics that returns metadata only. Unknown schema and failed initialization remain preserved; no catch-and-recreate fallback.
- [x] Run targeted tests, `cargo fmt --all -- --check` (format only owned files if existing unrelated code differs), and `cargo clippy -p termx-swarm-core --all-targets -- -D warnings`. Obtain independent review and commit.

## Task 2: Transactional membership and message mailbox

**Files:** extend `swarm-core/src/store/` with focused policy/message/query modules and tests; adjust model types only where required by this task's contract.

- [x] Add owner peer enrollment/metadata updates and group create/membership/pause operations with expected policy revision. Enrollment requires an internal verified-binding value supplied by a future trusted binder; do not manufacture process-verification claims here.
- [x] Add peer send/read/ack operations with authorization checks inside each protected transaction. Bind all SQL parameters. Normalize recipient sets and persist canonical retry payloads; freeze bindings/recipients on commit.
- [x] Prove identical retry returns the original committed receipt, changed payload conflicts, unauthorized recipient rolls back every row/sequence change, and two concurrent same-key attempts cannot create two messages.
- [x] Prove cross-group isolation (including overlapping groups), sender-spoof fields rejected by request decoding, paused/removed/stale bindings denied, message bodies preserved, replies limited to an accessible same-group message, and owner/user authorship cannot be obtained through a peer operation.
- [x] Implement bounded snapshot mailbox paging and explicit acknowledgements. Test appended messages excluded from an existing snapshot, forged/other-peer/old-policy cursors rejected, recipient-specific sequence gaps, out-of-order acknowledgements, and no acknowledgement caused by a read.
- [x] Reopen the store and verify mailbox order, recipient freezing, receipts, and idempotency survive. Run focused tests/lint, review, and commit.

## Task 3: Delivery attempts, uncertainty, and explicit continuation

**Files:** focused delivery/continuation modules and tests under `swarm-core/src/store/`.

- [x] Commit a unique delivery-attempt ticket before invoking any future adapter. A ticket binds group policy, recipient binding, and message/notification revision. Native I/O is outside the database connection/transaction.
- [x] Record outcomes only for the matching attempt. Stale completions cannot overwrite a successor binding or acknowledge content. Transport-written/native-queued remain evidence, not agent receipt. During explicit trusted new-run recovery after reopening, unfinished attempts become uncertain and are not blindly dispatched again. Merely opening an additional library connection must not invalidate a live attempt; the future exclusive companion must establish prior-run exit and invoke recovery before dispatch.
- [x] Candidate queries return bounded work for exact live authorized bindings. One held/unavailable recipient does not stall another. Pause/removal blocks future candidates while retaining messages and prior native evidence.
- [x] Implement owner-only compare-and-swap continuation using expected old binding, verified same-conversation/branch evidence, explicit continuation intent, and expected policy revisions. Two successors cannot win. Record predecessor/successor and original versus new delivery bindings.
- [x] Carry pending known-not-delivered backlog only through this transaction. Preserve acknowledged rows; preserve uncertain native outcomes for reconciliation rather than auto-resending them. An unrelated conversation/new pane occupant cannot inherit backlog or grants.
- [x] Test transaction failures before/after commit, lost reply/retry, pause during dispatch, stale attempt completion, competing continuation, acknowledged backlog preservation, and explicit new-run uncertainty. Review/lint/commit. Task 3 uses commit-hook rollback and reopen tests; actual abrupt subprocess exit is covered by Task 4 below.

## Task 4: Bounded serialized worker and crash/recovery harness

**Files:** `swarm-core/src/worker.rs`, focused worker tests, an explicitly test-only subprocess harness if needed, and `tools/swarm-proof` runner/report support.

- [ ] Own the SQLite connection in one worker thread with a bounded request channel. Define explicit backpressure/unavailable errors, cancellation semantics, clean flush/shutdown, and worker-panic propagation. Do not block an async executor thread with database work.
- [ ] A client timeout after enqueue means outcome unknown; it does not cancel a possibly committed transaction or justify a different idempotency key. A request rejected before enqueue is distinguishable. Bound queued work and response payloads independently of database history size.
- [ ] Prove slow/abandoned clients cannot stop other operations or leak unbounded pending work. Hold no database transaction while waiting for the next client message or native delivery response.
- [ ] Use owned test subprocesses and retained databases to verify committed data survives abrupt process exit, uncommitted transactions disappear on recovery, and a retry after a lost reply returns the original message. Do not claim a simulated process crash proves physical power-loss behavior.
- [ ] Exercise disk-full through a fixture-specific SQLite page limit, corrupt/unknown files, read-only/unavailable storage, and queued work at shutdown. Failures cannot return a false saved/acknowledged state or erase evidence.
- [ ] Run bounded workload tests with deterministic seeds and a simple independent reference model for memberships, recipient order, retry deduplication, acknowledgements, and continuation. Report the seed and smallest observed failing trace without message bodies/secrets.
- [ ] Review/lint/commit before sustained runs.

## Task 5: Sustained validation, optimization, and next-stage contract

**Files:** retained run artifacts plus sanitized `docs/superpowers/reports/2026-09-08-swarm-core-validation.md`; update this plan and the capability report only from observed evidence.

- [ ] Freeze a reproducible workload and measure correctness, queue depth, throughput, latency percentiles, database/WAL size, and process memory while varying retained history, active clients, pause/reconnect, and intermittent failures. Use an opt-in sustained run (initial target 30 minutes) with bounded offered load; this is a test duration, not a product conversation limit.
- [ ] Investigate bottlenecks using query plans and measured timings. Add missing indexes or remove repeated full-history scans only when evidence supports the change. Retain FULL durability and authorization checks. Re-run the affected workload after each material optimization; do not optimize by dropping messages or weakening permissions.
- [ ] Complete default tests, formatting and clippy, plus existing host regressions appropriate to workspace/link changes. Investigate the previously observed host ring-spill timing fixture separately; do not hide it by increasing timeouts without understanding its condition.
- [ ] Obtain a broad review of the new core and reports. Preserve artifacts, commit and push tested changes to the feature branches. Keep the original backup and current binaries intact.
- [ ] Write the next concrete companion/Windows identity/context/bridge integration plan using the observed policy/activation capabilities. Shipping or claiming arbitrary-existing-session activation remains gated by its own proof.

## Effectiveness evaluation alongside reliability

Publish a compact, primary-source-backed evaluation protocol from the research notes. Use the same complete task packet for Astra solo, Fable solo, and the free-form pair; no artificial split-information advantage, prescribed roles, mandatory messaging, or weak one-shot baseline. Prefer deterministic artifact checks and seeded-review precision/recall for the first pilot. Record quality, latency, and available native usage without exporting model reasoning. Label a small pilot as such; do not claim statistical or general superiority.

Prepare a modest initial subset of independent coding/review tasks and a straightforward control, all in fresh isolated nested repositories with retained artifacts. Expand only after the production communication path and accounting work. An 18-task research proposal and multiweek follow-up are a future protocol, not work claimed completed overnight. Coordinate policy tests and core validation first; do not spend large model-call batches merely repeating an already demonstrated transport exchange.
