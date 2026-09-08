# Collaboration companion integration plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` for bounded tasks with independent reviews. Continue the already authorized feature; do not request another execution-method approval.

**Goal:** Let explicitly connected TermX sessions discover each other, read authorized recorded context, and exchange durable messages through one local companion, while preserving independent harness behavior.

**Architecture:** Reuse `termx-swarm-core` behind a Windows named-pipe boundary. A small shared native client crate serves the host modes and the separate Tauri workspace without exposing the host's administrative protocol. Context and native notification work run outside the SQLite writer; the UI consumes verified capabilities and durable evidence.

**Tech stack:** Rust, the existing Tokio 1.53 dependency, windows-sys 0.61, serde JSON, the reviewed SQLite core, React/TypeScript and Tauri. Reuse version-locked libraries where possible; document any new dependency and actual native capability version.

**Spec:** [Approved design](../specs/2026-09-08-cross-harness-collaboration-design.md). [Native capability evidence](../reports/2026-09-08-swarm-windows-proof.md) overrides assumptions about untested runtime activation. The [core plan](2026-09-08-swarm-durable-core.md) must finish sustained validation and review before Tasks 2 onward. Independent Task 1 may begin once the core fixes pass scoped review and short verification, while a separate frozen validation checkout completes the core soak; the client crate has no core/SQLite dependency or native activation.

**Status:** Task 1 is complete at `8ea7445`, with 46 passing tests, package fmt/strict Clippy/release validation and independent Fable approval. The [tracked client report](../reports/2026-09-08-swarm-companion-validation.md) records exported APIs, evidence and consumer requirements. Core Task 5 is also complete and published, including its corrected 30-minute soak and independent review. Task 2 is prepared for a fresh Fable implementation with SOL review; Tasks 2-8 remain to be implemented and validated. This is not an installed swarm-feature release.

## Global constraints

- Never delete filesystem artifacts as cleanup. Preserve them, or move artifacts needing removal into `retired/<date-and-reason>/` with their original paths recorded. Verify absolute source/destination paths before a move. Do not run clean/prune/reset commands or introduce auto-deleting fixture guards.
- Work in `C:\Dev\TermX\.worktrees\swarm-proof`. Only one implementation agent at a time. Research, reviews and separately owned synthetic probes may proceed independently.
- Do not replace current binaries, restart the existing host, or message, resume, reconfigure or terminate a production user conversation. New native tests use fresh synthetic conversations and exact retained process handles/generations.
- No roles, conversation rounds, message-count limits, token budgets, mandatory replies or mandatory summaries. Bounded frames/queues/pages and test durations are resource controls.
- Agent identity comes from the authenticated native connection and a verified binding. Peer, sender, process, role or source-path claims in JSON do not grant authority. Peer content and group operations supply one explicit group and check current grants; overlapping groups never union access. Bounded self-membership discovery bootstraps whoami without requiring a group ID first and grants no cross-group content access.
- Keep the owner credential and host inventory credential native. Neither reaches renderer results, MCP/CLI output, peer configuration or diagnostics. Same-account Windows access is not an OS sandbox against unrestricted programs running as that account.
- Accepted messages and historical native evidence remain durable. Keep FULL/WAL and conservative schema recognition. No automatic retry of a possibly delivered native notice, no false Saved/ACK result, no replacing an unrecognized database.
- Preserve user/assistant/tool provenance while excluding private model reasoning, raw credentials/environment/configuration and unrelated histories from peer context and reports. A peer message does not grant human approval or answer another session's permission prompt.
- Dispatch new modes before host log cleanup/history sweeping. Keep the PTY protocol and ordinary host lifetime independent from collaboration.
- Use canonical decimal strings for sequence, revision, generation, FILETIME and other potentially unsafe integers at JavaScript boundaries. Bound the full outer wire envelope, not only its payload.

## File responsibilities and task boundaries

| Area | Files | Responsibility |
| --- | --- | --- |
| Shared native boundary | `swarm-client/{Cargo.toml,src/lib.rs,src/identity.rs,src/security.rs,src/discovery.rs,src/framing.rs,src/wire.rs,src/pipe.rs}` | Exact process handles, native endpoint trust, bounded framing and versioned DTOs; no SQLite or PTY operations. |
| Core additions | `swarm-core/src/{model.rs,worker.rs,store/query.rs,store/policy.rs,store/schema.rs}` and focused new modules | Scoped discovery/tail reads, owner views/authorship, publication leases and durable notification intent. |
| Companion | `host/src/swarm/{mod.rs,runtime.rs,inventory.rs,enrollment.rs,rpc.rs,cli.rs,mcp.rs,events.rs}` | Early modes, exclusive authority, narrow inventory, verified enrollment and typed dispatch. |
| Shared context | `swarm-context/{Cargo.toml,src/lib.rs,src/records.rs,src/source.rs,src/index.rs}` | Bounded source reads and common parsing with a separate allowlisted peer projection. |
| Native delivery | `host/src/swarm/{notifications.rs,adapters/mod.rs,adapters/claude.rs,adapters/codex.rs}` | Coalesced fixed notices over exact capability-tested native routes. |
| UI | `ui/src/swarm/`, `ui/src-tauri/src/swarm.rs` and existing registration/selection entry points | Explicit connection controls, setup readiness, history/status and pane navigation. |

Each task includes its own focused tests, source/evidence hashes, native exit codes,
scoped commit and independent spec/quality review. Record actual exported names
and signatures in its report before dispatching a consumer. Split a growing file
by these responsibilities, not by copying a large existing module wholesale.

## Task 1: Shared Windows identity, ownership and framed client

**Files:** Create `swarm-client` files listed above and focused `swarm-client/tests/{identity,ownership,transport}.rs`. Add the member to root `Cargo.toml` and necessary pinned lockfile edges. Existing UI process-status wrappers remain unchanged initially.

**Interfaces:** The crate exports `ProcessIdentity { pid: u32, creation_filetime: DecimalU64 }`, a retained `VerifiedProcess` handle, `AuthorityClaim`, `DiscoveryRecord`, `VerifiedPipe`, `OwnerClient` and `PeerClient`. Handle/credential types have no Serialize, Deserialize or content-bearing Debug. `DecimalU64::parse(&str)` rejects signs, whitespace, leading zeros except `0`, overflow and numeric JSON values; context-specific nonzero/i64 constraints apply when converting into core types.

```rust
assert!(DecimalU64::parse("9007199254740993").is_ok());
assert!(DecimalU64::parse("01").is_err());
assert!(DecimalU64::parse("18446744073709551616").is_err());
// The native identity constructor opens a process and reads GetProcessTimes;
// a deserialized ProcessIdentity is only an expected value to verify.
```

- [x] Add failing pure tests for decimal round-trips, ancestry cycles/ambiguous enrolled ancestors, stale process generations and strict frame decoding. Then implement the types and fresh process inspection with retained handles and creation-order checks. Depth/resource failure returns unavailable rather than selecting an arbitrary peer.
- [x] Claim an opened, canonically resolved data directory using retained directory identity and an OS-held exclusive lock file for the entire broker lifetime. Verify competing claims and alias paths cannot create two owners, and test replacement/rename while ownership is held. The lock file is retained after exit; ownership is the live handle, not file existence. Reopening must preserve existing contents.
- [x] Create a local named pipe with explicit current-user/logon DACL, remote rejection, noninheritable handles and an initial first-instance claim. Keep one instance alive while rotating acceptors. Test actual client rights with the chosen DACL: Tokio's generic write access overlaps pipe-instance rights, so use an audited native specific-access `CreateFileW` opener if required. Preserve identification-only SQOS and overlapped I/O when transferring the handle into Tokio.
- [x] Before owner authentication, verify `GetNamedPipeServerProcessId`, exact creation FILETIME, live retained handle and a boot-specific hello against trusted native discovery. The peer client performs the same server verification. A wrong server test records zero owner-credential bytes transmitted.
- [x] Store a random owner credential with explicit native ACL and no renderer-facing getter. For an existing object, validate its expected file type, owner and effective DACL through the retained handle before accepting any credential bytes; the creation security descriptor does not validate an existing file. Test fresh creation, secure reopen and rejection of permissive, wrong-type and unexpected reparse objects. Preserve rejected objects and return a specific unavailable state, without automatic credential rotation. Publish bounded discovery metadata with authority/boot/process/version/pipe fields. Preserve previous discovery documents in a unique retired location before atomic replacement; keep malformed/future documents intact and return a specific error. No secret is printed or embedded in an executable argument.
- [x] Implement length-prefixed strict JSON framing with version, bounded correlation ID, request kind and typed payload. Use an explicit 16 MiB outer frame limit, reject the length before allocation, and reject duplicate/unknown discriminants. Reserve aggregate frame memory as well as connection count. This accommodates the existing 8 MiB core page plus bounded outer metadata without pretending the core limit is a wire limit.
- [x] Run `cargo test -p termx-swarm-client`, package fmt/clippy and owned subprocess ownership/transport tests. Retain wrong-server, reconnect, first-instance rotation, stale discovery, inherited-handle and close/reopen evidence. Commit only this task's files.

## Task 2: Scoped queries, incremental inbox and publication leases

**Files:** Core model/worker/query/policy plus focused `swarm-core/tests/{discovery,mailbox_tail,leases}.rs`; exact schema additions only where persisted facts are necessary.

**Interfaces:** Add typed worker commands for `WhoAmI`, `ListPeers`, `OwnerSnapshot`, `ReadMailboxAfter`, `ReadThread`, `PublishStatus`, `AcquireContextGrant` and `ValidateContextGrant`. Peer discovery returns only metadata authorized in the explicit group. Owner snapshots are separately owner-authenticated and paged. `ContextGrantLease` is internal, non-deserializable evidence containing authority/group/policy, caller binding, source owner binding and source revision; a source ID alone is never a lease.

```rust
// A supplied position is navigation, not authorization or acknowledgement.
let request = MailboxAfterRequest {
    group_id: group.clone(), after_sequence: 9007199254740993,
    cursor: None, max_items: 64,
};
// Every operation still checks the authenticated principal and current policy.
```

- [ ] Add failing tests for one-group metadata projection, owner/peer distinction, paused/removed members and binding changes. No raw source paths or trusted principals may appear in serialized output.
- [ ] Implement indexed start-after mailbox snapshots. Cursor and fresh start-after are mutually exclusive. Freeze the new snapshot high watermark; test empty tails, group-sequence gaps, later appends, stale policy/binding cursors and explicit old unacknowledged history access. Preserve existing snapshot semantics and retained cursors.
- [ ] Add paged authorized thread/outgoing reads without disclosing messages addressed only to other participants. Add optional caller-owned status scoped to one group, bounded by existing metadata/frame controls. A status is informational and does not imply a required role, availability promise or completed task. Add immutable opaque source-reference attachments to message metadata only with current source authorization; dereferencing later still requires a fresh grant check. Preserve exact retry comparison for the complete semantic payload and supported historical retries.
- [ ] Implement immutable publication leases and current validation using the writer. No file read occurs inside that transaction. Reserve bounded destination/output credits after source I/O and before final validation; bind validation to one exact immutable response/read identity. Successful writer validation commits that single-use response for publication and is the authorization linearization point. Enqueue consumes the already reserved credits without another capacity wait. A subsequent policy change does not retroactively revoke that committed response while OS delivery finishes; a new response, retry or reconnection needs fresh validation. Test a completed but unpolled validation result followed by pause/rebind, as well as revocation before validation. Publication is neither native delivery nor ACK.
- [ ] Provide a trusted owner-only `RegisterSource` command accepting a non-deserializable verified source descriptor from enrollment. Bind the source to the exact peer binding/conversation and an opaque native resolver key; peer results never expose the resolver's path. Define owner expected-revision transitions for withdrawal/re-establishment/replacement, preserving historical registrations/references and requiring fresh verified evidence to enable or replace one. The durable source authorization/identity revision changes with these transitions; ordinary appends and content-index extension do not change it. Old references become stale/unavailable after replacement rather than redirecting to new content. Task 4 supplies verification and Task 5 supplies distinct immutable content snapshots. Source registration alone grants no access outside current explicit group membership, and continuation requires an explicitly re-established source binding.
- [ ] Provide durable state revision(s) for owner snapshots and event resnapshot. Advance a revision atomically with the mutation it describes. A broker boot epoch distinguishes in-memory subscriptions; timestamps are not event sequence numbers. Events remain hints, never grants or receipts.
- [ ] Test worker response reservations against maximum newly exposed pages and metadata. Query plans must use bounded/indexed positions with long history. Run amended core tests, existing full core suite once after final changes, fmt/clippy, then commit with exact API notes for Task 3.

## Task 3: Companion runtime, early modes and narrow owner management

**Files:** `host/src/main.rs`, `host/src/lib.rs`, `host/Cargo.toml`, swarm runtime/rpc/events modules and `host/tests/swarm_runtime.rs`. Link reviewed core and shared client; no ordinary host startup rewrite.

**Interfaces:** `swarm::dispatch_early(args_os)` recognizes `--swarm-broker`, `--swarm-mcp` and `swarm`. Unrecognized arguments within one of these modes return its own error instead of falling through. `BrokerRuntime` owns `AuthorityClaim`, one `Worker`, current boot, verified bindings and bounded connection/event tasks. `OwnerClient` exposes typed inventory/group/snapshot operations, never a generic host message or arbitrary SQL command.

- [ ] Add an owned synthetic data directory with old log/history sentinels and a mode-dispatch subprocess test. Before implementation it must fail to enter the new mode; after implementation, normal host cleanup and PTY startup must remain absent, including malformed swarm arguments.
- [ ] Establish exclusive ownership, open the durable store, explicitly recover the new run, refresh persisted liveness using exact process generations, and only then expose native candidate dispatch. A second library connection never constitutes broker restart evidence.
- [ ] Separate owner and peer handshakes/routes. Convert strict wire DTOs into internal commands only after authentication. Every response retains correlation and exact decimal values. Accepted timeout/disconnection is outcome unknown; queue rejection is not enqueued. Pending response buffers consume independent credits until sent/dropped. Protected context publication uses Task 2's exact single-use response commitment after reserving destination credits; validation success cannot authorize another buffer, retry or reconnection.
- [ ] Bound concurrent connections, frame bytes, outstanding requests and event buffers. Subscriptions register before an authorized snapshot; overflow emits resnapshot-required. Long waits do not occupy the SQLite thread, emit model prompts or hold a transaction.
- [ ] Use bounded snapshots and lightweight worker counters for routine status. The core's `Inspect` performs full integrity work and is maintenance/test functionality, not a periodic UI health request or peer tool. The first retained long run took about 28.8 seconds between its final navigation event and completed inspection on a roughly 450 MiB database; keep that work off ordinary collaboration request paths.
- [ ] Verify pause/rebind while a request is buffered, malformed frames, slow readers, dropped clients, broker panic/exit and retained messages on restart. For context publication, revocation before final writer validation rejects; revocation after its single-response commitment is nonretroactive even with an unpolled result or slow native delivery. Test actual credit ownership through both barriers and disconnect/drop. Drain only owned broker work. Never route broker shutdown to host shutdown or session-close.
- [ ] Run the new transport/runtime tests and relevant host CLI regressions, formatting and clippy. Record source/executable hashes and exact owned process exit evidence. Commit a runtime checkpoint; no UI or automatic startup is enabled yet.

## Task 4: Verified enrollment and common CLI/MCP tools

**Files:** Inventory/enrollment/cli/mcp modules, shared wire DTOs and retained native enrollment tests. Existing launch capture and provider registry readers may be extracted into focused helpers with unchanged wrapper behavior.

**Interfaces:** `InventoryClient` has only `list_sessions()` and exact native shell/runtime verification. `VerifiedEnrollment` is not deserializable; selected terminal/capture metadata is evidence to validate, not proof. `PeerClient` resolves the connecting OS PID through fresh ancestry to exactly one enrolled runtime. CLI and MCP dispatch the same typed peer operations.

- [ ] Implement narrow host inventory using existing Auth/ListSessions internally. Keep the broad credential inside this adapter, with no renderer or agent forwarding route. The existing SessionInfo PID must be supplemented by retained native creation-time verification.
- [ ] Resolve actual provider process and exact conversation/source from verified capture or provider registry evidence. A wrapper stamp helps but is not mandatory; latest-by-directory lookup is not sufficient. Unknown/custom model names remain metadata. Initially capability-gate shared app-server sessions as unavailable: ordinary MCP/CLI ancestry cannot distinguish their threads. The prototype dynamic-tool proof does not create a production adapter. A future adapter requires owner-verified app-server identity plus authoritative per-call thread/turn/call binding and independent revocation; it must never resume a second writer to obtain that control.
- [ ] Publish a typed capability snapshot with separate tool access, context read and native wake states, each carrying the current peer binding, broker boot/state revision, evidence version and concrete unavailable reason. Membership is independent of these capabilities. Rebind, source replacement, policy or transport changes invalidate the affected state; UI/events request a new verified snapshot rather than retaining a single Ready flag.
- [ ] Implement owner enrollment and continuation preparation from verified native evidence. Continuation lists every active group and expected revision; use the reviewed complete-map CAS and same-conversation/branch proof. Matching only a conversation ID or pane slot is insufficient.
- [ ] Expose `whoami`, `list_peers`, `read_messages`, `send_message`, `acknowledge_message`, `publish_status` and `wait_for_events` over structured CLI and MCP stdio. Add context tools in Task 5. No sender/role/PID/path argument, shell-string execution or generic RPC escape hatch. Strict JSON-RPC request IDs, bounded framing, stdout reserved for protocol and cancellation semantics must be tested.
- [ ] Pin and test the MCP versions actually supported by the installed clients. The proof helper echoed the requested version and is not a production negotiation implementation. For handshake-based versions, enforce initialization/capability negotiation before tool calls, select only an implemented version and honor initialized/EOF/cancellation. Newer per-request-metadata semantics require a separate tested path; an unknown version is never silently treated as supported. Capture only negotiated protocol/version/capability metadata from fresh owned clients.
- [ ] Account for the MCP result wrapper separately from the private pipe frame. Returning both structured content and its JSON text representation can expand an 8 MiB core page to nearly 24 MiB with escaping. Use an explicit 32 MiB MCP output-line budget with shared aggregate response credits, exact serialization checks and a maximum escaped-body round-trip test; private broker frames remain 16 MiB. Do not clip a page or advance its cursor past omitted messages to make it fit. Annotate actual side effects: mailbox reads record fetch service/create cursors, so they are not a side-effect-free read just because the tool is named `read_messages`.
- [ ] Tool descriptions attribute peer material and explain saved/fetch-serviced/ACK/uncertain results without prescribing roles, rounds or reply behavior. Reconnect repeats authentication and current-grant checks. A helper path is the verified newly staged executable, not an assumed old `TERMX_HOST_EXE` value.
- [ ] Test spoofed identity, unrelated/ambiguous descendants, old process generation, cross-group source/peer addresses, reconnect, duplicate request IDs, malformed/oversized requests and lost replies. Normal permission/model settings remain unchanged. Commit verified tool access before native wake is advertised.

## Task 5: Shared parsing and authorized recorded-context snapshots

**Files:** New `swarm-context` crate, core/source grant integration, host context RPC and thin wrappers in `ui/src-tauri/src/{transcript,chat_feed}.rs`. Preserve owner UI parser behavior and existing regressions.

**Interfaces:** `VerifiedSource` is internal evidence from enrollment. `ContextSnapshot` identifies source object/generation, conversation, captured-through position, observed interval, available record kinds and completeness/lag. `ContextPage` contains only typed peer-projection records with provenance and opaque source references. Page/search/detail operations supply explicit group plus opaque reference/cursor; they never accept a filesystem path.

- [ ] Freeze actual Claude JSONL and Codex recorded-source shapes from owned proof artifacts into sanitized fixtures. Implement pure parsers for user/assistant/tool results and compaction evidence, with a separate allowlisted peer projection. Existing owner UI Thinking display remains local; unknown sensitive variants and raw rows never cross peer transport.
- [ ] Preserve nested TermX tool-result provenance. A recorded read from another group must not automatically expose its broker-owned body to a caller lacking that source grant. Use typed unavailable records or opaque references with fresh authorization, and avoid recursively copying previous context pages. Test overlapping groups and forwarded references. A shell-output marker or JSON envelope is not authenticated broker provenance: recognized CLI-wrapped nested results remain unavailable/untrusted unless a separately verified capture boundary exists. Never turn plain transcript text into an authorized source reference. Test spoofed markers and copied envelopes as well as provider-native tool/call linkage. This is enforcement on known broker material, not semantic information-flow control over arbitrary agent text or files; inaccessible provenance may reduce shared detail. Distinct context blocks in one native response remain distinct; usage-counter deduplication is not transcript deduplication.
- [ ] Implement a shared per-source index with bounded in-memory state and retained metadata. Pin Windows volume/file ID through an open handle, verified conversation header, complete record ranges and content hashes. This is a snapshot of observed complete records, not a claim of a provider-atomic whole-file transaction. Index metadata does not duplicate raw transcript bodies into the mailbox database.
- [ ] Capture each bounded record consistently around parsing, reject changing bytes, and exclude incomplete final UTF-8/JSON with an explicit lag state. On old page/detail reads, verify current source identity/header and selected ranges against their snapshot hashes. Same-size replacement or rewritten requested records return stale rather than silently substituting content. Watchers/mtime/length are hints, not immutable content proof.
- [ ] Start with recent context, allow earlier pages, search and record detail. Bound record size/nesting/page bytes and active source I/O; report oversized records explicitly. Append extends later snapshots while old cursors retain their captured-through bound. Do not reload full history per peer pair or on each wait.
- [ ] Acquire the exact grant lease, perform source I/O outside the writer, then revalidate source identity and current grants before publication. Test barrier-controlled pause/removal/rebind while a read is delayed and forwarded references across overlapping groups.
- [ ] Test replacement, in-place rewrite, truncate/regrow, partial append, missing/access-denied source, fork/ambiguous writer and record-kind leakage. Measure bounded page memory/latency on a retained large source. Run existing transcript/chat-feed regressions and new context tests, fmt/clippy, commit with clearly stated snapshot consistency limits.

## Task 6: Durable coalesced notice scheduling and native adapters

**Files:** Focused core notification model/store/schema tests and host notification/adapters files. Native calls remain outside writer transactions.

**Interfaces:** A durable notification intent binds recipient, binding, current policy, broker run and covered mailbox watermark(s). It has its own native attempt identity and outcome history. Coverage means an inbox notice advertises those committed messages; it does not mark them fetched, acknowledged or replied. Existing per-message native history remains intact.

- [ ] Add failing lifecycle tests before implementing notification intent: several messages before dispatch yield one notice; arrival during/after dispatch remains discoverable; an unknown notice is not blindly resent; partial inbox reads and multiple groups do not lose pending mail. A held/unavailable peer cannot block another recipient.
- [ ] Connect committed mail to durable notification work atomically: the send transaction must create or advance a per-recipient/binding coverage target, including all recipients frozen into that send. Events are wake hints only. Startup and event-overflow recovery query indexed durable coverage gaps, so a crash after send commit and before scheduler work cannot strand mail without an intent. Backfill eligible retained mail through an additive recognized migration or explicit indexed initialization. Test that boundary with an actual owned process exit; retain unknown prior attempts and never infer safe resend from the recovered coverage target.
- [ ] Freeze the exact coalescing representation and migration in the task report before native I/O integration. Persist the ticket before dispatch, recheck generation/policy, and record native outcomes using evidence rather than timer inference. Reconciliation requires matching known-not-submitted proof; an ambiguous hold is not such proof.
- [ ] Keep fixed-notice outcomes separate from native delivery of message bodies. A held/unknown inbox notice must not claim that any covered body was delivered or fetched, nor silently rewrite existing per-message native history. Test continuation against the actual information exposed: current binding/grant fences, fetch-service evidence and any historical body-delivery uncertainty remain authoritative. The notice's own unknown attempt still cannot be blindly resubmitted.
- [ ] Implement the verified ordinary saved Codex TUI queue route. Use one fixed broker-authored literal with no peer name/topic/body interpolation, because native queue text is recorded as user-role content. Agents fetch real attributed content through tools. Unsaved or unverified runtimes remain unavailable; no second app-server writer resumes their conversation.
- [ ] Implement Claude exact registry/process/session pipe delivery with the verified peer credential and a fixed inbox notice; real peer content stays in scoped tools. Respect accept/hold/refuse and ordinary permissions. A completed pipe write is transport-written only; absence of receipt is not proof of refusal or safe retry. No global settings edit, own-child exemption or invented permission-class assertion.
- [ ] Provide scoped fresh-launch tool setup and only demonstrated existing-session activation. Preserve ordinary model/provider/effort/cwd/sandbox/approval configurations. The user's custom Claude/Astra launch remains unverified until its actual configuration is available; do not advertise route parity from a matching display name.
- [ ] Repeat essential owned native acceptance through production code: agents choose a peer context read and two-way exchange, a later chosen message wakes idle peer, active tool completes, draft is retained, wrong session is rejected and no second writer starts. Preserve typed receipt/source/version evidence and reap only exact owned generations. Commit reviewed adapters before UI claims readiness.

## Task 7: True owner contribution and collaboration view

**Files:** Core owner-authored message contract and migrations/tests first; `ui/src/swarm/{types,client,store,controller,SwarmPanel}` and native `swarm.rs`; App/sidebar/pane entry points; native `lib.rs`, `build.rs`, `capabilities/default.json` and necessary package dependencies.

**Interfaces:** Owner authorship is a separate trusted command and persisted author kind, not a fake enrolled peer or a caller-supplied role. The UI gets strict DTOs and native invoke methods; the credential stays inside `OwnerClient`. Connection selection expands tabs into actual eligible pane sessions without modifying membership on later rail selection changes.

- [ ] Implement and review owner-origin message retention, deduplication and recipient receipt semantics before adding its composer. Preserve historical peer receipts and all recognized migrations; test that peer routes cannot create owner authorship. An owner view read never ACKs another participant's mail.
- [ ] Add Connect agents to current selection/pane controls. Show exact harness/model/cwd, the separate revision-bound tool/context/wake capabilities and recorded-history sharing intent. Explicit user selection authorizes the group; unavailable activation explains the concrete setup needed. Highlighting alone never enrolls peers. Resnapshot capability dimensions after disconnect/overflow and invalidate stale bindings instead of collapsing membership into Ready.
- [ ] Add group history, optional owner composer, pause/resume and explicit add/remove/continuation controls using expected revisions. Show Saved, native evidence, fetch serviced, explicitly acknowledged and replied separately; distinguish held, unavailable and unknown. Timeouts never optimistically become Saved.
- [ ] Link each participant to the correct tab/pane, restoring minimized/maximized presentation as needed without changing membership or independent selection. UI closure and pane layout changes leave collaboration active.
- [ ] Test multiple windows, stale policy actions, resnapshot after event overflow/disconnect, multi-selection and split/maximized/minimized panes. Verify no secret/raw configuration reaches React state or invoke results. Run TypeScript, Vitest, native tests and a release build into staged artifacts; do not replace a live executable.

## Task 8: Full-path reliability, effectiveness pilot and staging

**Files:** Retained run records plus sanitized reports; existing reviewed evaluation recipes and protocol; packaging scripts only when required for versioned staging.

- [ ] Freeze executable/source hashes, protocol/native versions and activation settings. Run transport/context faults and sustained pressure through actual RPC with owned synthetic peers, including recovery, pause/rebind, slow consumers and large retained histories. Compare with core measurements without conflating the two paths.
- [ ] Run the four frozen task packets for Astra/Codex solo, Fable/Claude solo and the discretionary pair. Each gets the same complete task in independent fresh repositories; the pair shares its own task repository. No prescribed role, required message or weak one-shot solo baseline. Keep grading/reference files outside run repositories and apply the documented contamination rules.
- [ ] Apply deterministic held-out checks and review precision/recall; report every arm including failures/control cases, elapsed time, available per-response native usage and verified coverage limits. Never export private reasoning or invent whole-run cost when descendant/overlap accounting is unverified. Four cases are a pilot, not general superiority evidence.
- [ ] Investigate observed failures, preserve original artifacts and rerun only affected scenarios after fixes. Obtain a broad review of the complete feature and retained evidence, with deferred findings explicitly triaged.
- [ ] Publish reviewed source checkpoints to both feature branches, retaining the original GitHub backup. Stage versioned portable executables and install/update metadata using preserved predecessors. Verify the existing host generation remains untouched. Clearly report supported activation paths, measured reliability, pilot outcomes and remaining coverage limits.

## Preflight interface and scope check

| Tasks | Shared boundary | Required agreement |
| --- | --- | --- |
| 1 / 3 / 4 / 7 | Shared client and native identity | DTO values are untrusted expectations; OS handles/verified handshake create trust. UI has no core/host administrative dependency. |
| 2 / 3 / 4 | Core queries and worker | New result sizes consume response credits; indexed tail cursors retain current explicit-group authorization. |
| 2 / 5 | Publication lease | Source I/O stays outside the writer and final protected publication checks the same current grant/binding. |
| 3 / 4 / 7 | Events and owner snapshots | Revision/boot identities are exact; subscribe then snapshot; overflow requires resnapshot and never changes grants. |
| 4 / 5 / 6 | Verified runtime/source capability | Exact launch/conversation identity is shared; tool-ready, context-readable and native-wake capabilities are separate. |
| 2 / 6 / 7 | Receipt and notice truth | Per-message receipts and coalesced native notices remain distinct; fetch service is not model comprehension. |
| 4 / 7 | Enrollment and continuation | UI intent is explicit, all groups/revisions are disclosed and verified CAS prevents competing successors. |
| 5 / 7 | Parser ownership | Existing owner UI retains its behavior; only the separate peer projection excludes private reasoning before transport. |
| 6 / 8 | Production native path and pilot | Pilot uses the reviewed exact path and ordinary configurations; prototype transport evidence alone is insufficient. |
| 1–8 individually | Files, tests and claims | Each task's tests target its stated deliverable; later UI/native/model results are never inferred from earlier unit or transport tests. |

This decomposition covers the approved product contract in stages. Unproven
arbitrary-existing-session activation and custom model-route parity remain
explicit capability gaps, not reasons to silently reconfigure a running session.

## Protocol research used by this plan

MCP 2025-11-25 requires initialization and version/capability negotiation; its
stdio transport uses UTF-8 newline-delimited JSON-RPC with protocol-only stdout.
These are separate from TermX's private length-prefixed broker frames.
[Lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle),
[transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

The published 2026-07-28 stdio specification instead describes per-request
metadata, discovery and compatibility with older initialization-based clients.
Therefore implementation must bind behavior to a tested negotiated version,
not assume that a current documentation page describes the installed harness.
Cancellation or helper exit still cannot reverse a message already committed
by the independent TermX broker; the original idempotency key remains necessary.
[MCP 2026-07-28 stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio).

MCP's structured-result guidance includes a JSON text representation for older
clients, and its schema defines tool errors and behavioral annotations. The
extra representation needs its own frame/memory accounting. Annotations describe
behavior; they do not authorize access or override harness permissions.
[Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools),
[schema](https://modelcontextprotocol.io/specification/2025-11-25/schema).

Windows file sharing and creation security are separate concerns. Sharing rules
persist with an open handle; a supplied creation descriptor does not validate an
existing object. The native boundary must inspect existing credential objects
and retain authority handles through the runtime lifetime.
[CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew).
Compare opened objects using volume/file identity and resolve aliases through
their handles; a path string or stale lock file alone does not establish ownership.
[FILE_ID_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info),
[final path](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew).
