# TermX Milestone 2: UI Shell and Recovery Design

**Date:** 2026-07-18
**Status:** Approved for implementation
**Decision authority:** Michael selected the direct React-to-host architecture and delegated remaining M2 decisions to Fable 5. The architecture follows Fable’s stability-first decisions; final written-spec approval is recorded by the status above.

## 1. Purpose

Milestone 2 adds the first disposable desktop UI to the detached TermX host completed in Milestone 1. The UI must provide a useful Windows terminal manager without weakening the central stability invariant:

> The detached Rust host owns ConPTY sessions. Closing, crashing, reloading, or replacing the UI must not terminate live shells.

M2 adds:

- A Tauri 2 desktop shell with React, TypeScript, Vite, and xterm.js.
- Direct authenticated WebSocket communication from React to the existing localhost host.
- A sessions sidebar with tabs, names, colors, collapsible groups, ordering, duplication, and close actions.
- Durable layout persistence and multi-client conflict handling.
- Reliable attach, replay, resynchronization, and reconnection behavior.
- Runtime shell-profile discovery.
- A Settings surface in the main renderer.
- Safety-gated recovery of managed Claude Code and Codex CLI sessions after a destructive host loss.
- Required host protocol, lifecycle, replay, and Windows process-containment upgrades.

M2 is stability-first. It does not pull later terminal features forward merely because their future UI slots are visible.

## 2. Milestone boundary

### 2.1 Included

1. Mandatory host correctness prerequisites.
2. Protocol-major version 2.
3. Global sequenced session and layout lifecycle events.
4. Revisioned compare-and-swap layout persistence.
5. Best-effort Windows Job Object containment with explicit cleanup fallbacks.
6. Profile discovery for PowerShell, Command Prompt, PowerShell 7, Git Bash, and WSL distributions.
7. Tauri lifecycle/discovery/storage/notification bridge.
8. React host client and canonical client-side state store.
9. One visible xterm.js terminal controller.
10. Sessions sidebar, groups, colors, names, ordering, duplicate, and close behavior.
11. Main-renderer Settings.
12. Manual, Reviewed, and capability-gated Unattended recovery modes.
13. Durable at-most-once recovery operation state.
14. Redacted audit records and recovery notifications.
15. Tests for protocol, process containment, replay, reconnection, layout conflicts, recovery safety, and bounded memory.

### 2.2 Explicitly deferred

- Folder tree, native folder picker, file search, and scoped folder context: M3.
- OSC 133/7 blocks, command metadata, current-directory events, and terminal search: M4.
- Clickable paths, URLs, and OSC 8 links: M5.
- Split panes, pop-outs, multiple simultaneously visible terminals, and pane controls: M6.
- Command palette, durable command history, and snippets: M7.
- True PTY pause/credit flow control and terminal-state snapshots.
- Reliable output-activity indicators for detached inactive sessions.
- Codex app-server or another structured unattended provider adapter.
- Unattended continuation submission through plain Claude Code or plain Codex PTY interfaces.
- Screen scraping, prompt detection, private provider-state parsing, picker inference, or “most recent session” inference.
- Cross-session messaging, AI context sharing, `/forkit`, or a general AI assistant.
- DPAPI encryption of recovery metadata.
- Themes marketplace, SSH, installer work, and non-Windows support.

## 3. Stability and safety invariants

The implementation must preserve these invariants across all components:

1. **UI lifetime is not session lifetime.** Window close, renderer reload, renderer crash, and WebSocket disconnect never send `Shutdown` or `CloseSession` implicitly.
2. **Only an explicit destructive host-stop action stops the host.** Normal tab dismissal sends `CloseSession` for that session only. Host `Shutdown` is sent only by Quit TermX or a separately previewed and confirmed host restart.
3. **The host is canonical.** Session existence, process state, output rings, layout revision, and global lifecycle order are host-owned.
4. **No tentative durable state is observable.** A layout or recovery-journal mutation becomes visible only after atomic persistence succeeds.
5. **A slow client cannot stall a shell or registry commit.** Bounded queues fail by disconnecting/resnapshotting the client, not by pausing global progress or growing without limit.
6. **A live protocol mismatch is non-destructive.** TermX never automatically shuts down or replaces a live mismatched host.
7. **Process containment is fail-closed after spawn.** If Job assignment or any required post-spawn setup fails, session creation aborts and the child tree is explicitly reaped.
8. **Replay never injects stale terminal replies.** xterm-generated replies are suppressed while replay is applied.
9. **Recovery never guesses identity.** Provider conversations are resumed only from exact persisted IDs or names captured through a supported path.
10. **Continuation delivery is at-most-once.** An ambiguous send is never retried automatically.
11. **Unattended eligibility is evidence-based.** A global mode cannot upgrade an adapter or record that lacks exact identity, machine-readable readiness, or unambiguous acceptance.
12. **No secrets in durable UI state or logs.** The runtime bearer token has one deliberate durable location: the user-ACL-protected runtime discovery file owned by the host. Tauri reads it into memory and returns it to the trusted renderer bootstrap; React never persists it. Audit records exclude prompts, terminal content, tokens, and full provider IDs.
13. **Host identity is authenticated, not inferred from a PID or port.** A client trusts a discovered host only after token authentication and exact host-instance/data-directory identity agreement.
14. **Paths remain portable.** Code derives paths from project, executable, or standard OS locations and never hardcodes machine-specific absolute paths.

## 4. Architecture and ownership

### 4.1 React and TypeScript

React directly owns the authenticated loopback WebSocket and all renderer-side protocol behavior:

- Protocol negotiation and authentication.
- Request correlation.
- Connection state and bounded reconnect backoff.
- Canonical snapshot and lifecycle-event reduction.
- Attach, detach, replay, live binary output, input, paste, and resize.
- xterm.js lifecycle and output backpressure.
- Sessions sidebar and layout edits.
- Layout compare-and-swap and conflict rebase.
- Settings UI.
- Recovery preview and orchestration.
- Recovery capability presentation.
- In-app notifications.

React maintains one canonical host store derived from an authoritative host snapshot plus sequenced global events. Command responses settle pending requests; they do not independently mutate canonical session state when an event is defined for that mutation.

### 4.2 Thin Tauri Rust bridge

Tauri Rust is a native lifecycle, discovery, storage, and OS-integration bridge. It does not proxy WebSocket traffic and does not own live terminal state.

It owns:

- Resolving the TermX data directory using the same rules as the host:
  1. Explicit override supplied through a supported native configuration path.
  2. Portable mode beside the executable.
  3. The standard per-user application-data directory.
- Reading and validating runtime discovery state.
- Verifying host process identity and listener reachability.
- Starting the packaged `termx-host` sidecar only when no verified host is live.
- Serializing concurrent launch/discovery attempts through a native state machine.
- Performing a native authenticated preflight against discovery state before returning the port, token, host instance ID, data-directory instance ID, and version information to React in memory.
- Reading the last durable host state only when the host is proven absent and a recovery preview needs it.
- Native Windows notifications.
- Native `ConfirmShutdown` and `ConfirmTeardownRepair` commands plus the native `StorageRepair*` transaction that independently retrieve or construct exact proof in Rust, display the OS confirmation dialog, and return/send only the bounded result; JavaScript never receives the authority key, raw proof identities, or repair MAC.
- Append-only, redacted recovery audit output with atomic rotation.
- User-only data-directory ACL hardening. Startup fails closed if the runtime token or durable recovery metadata cannot be protected from other local users.

The exact native Tauri invoke contracts are separate from protocol-v2 WebSocket messages:

```text
ConfirmShutdown {
  authorization: ShutdownAuthorizationV1
} -> NativeShutdownAuthorizationResult {
  outcome: authorized|cancelled|stale|expired|ownership_lost,
  confirmation_id?: UUID,
  expires_at?: Timestamp
}

ConfirmTeardownRepair {
  preparation_id: UUID
} -> NativeTeardownRepairResult {
  outcome: repaired|cancelled|stale|expired|ownership_lost,
  session_id?: u32,
  lifecycle_generation?: UUID
}

PrepareStorageRepair {
  request_id: RequestId,
  mode: restore|reset|adopt|containment_reboot,
  record_id?: UUID
} -> StorageRepairPrepared {
  request_id: RequestId,
  preview: StorageRepairPreviewV1
}

ConfirmStorageRepair {
  request_id: RequestId,
  repair_id: UUID,
  plan_hash: Sha256Hex
} -> StorageRepairAuthorized {
  request_id: RequestId,
  authorization: StorageRepairAuthorizationV1
}

ExecuteStorageRepair {
  request_id: RequestId,
  repair_id: UUID,
  plan_hash: Sha256Hex,
  authorization_id: UUID
} -> StorageRepairExecutionResultV1

CancelStorageRepair {
  request_id: RequestId,
  repair_id: UUID,
  plan_hash: Sha256Hex
} -> StorageRepairExecutionResultV1

GetStorageRepairStatus {
  request_id: RequestId,
  repair_id: UUID
} -> StorageRepairStatusV1
```

`ConfirmShutdown` and `ConfirmTeardownRepair` retrieve host proof through the native-key MAC flow, display the native confirmation, and return only the bounded result. They never expose the authority key, raw proof identities, or MAC. `StorageRepair*` is available only in the dead-host storage-repair states defined in section 8.3; it is not a WebSocket protocol and does not fabricate host authorization. Its `containment_reboot` mode is the only native path that may publish a reboot absence proof for an unregistered-containment record. The native handler constructs the exact preview, displays the mode-specific OS dialog during `ConfirmStorageRepair`, and executes only through the same exclusive journaled StorageRepair writer; it never terminates a process, creates a session, or exposes process identities to JavaScript. `PrepareStorageRepair.record_id` is required exactly for `mode=containment_reboot` and absent for every other mode.

The native host manager uses this state machine:

```text
Stopped
  -> Discovering
  -> Spawning
  -> Connecting
  -> Authenticating
  -> Ready
  -> Backoff or Stopped
```

Concurrent callers within one Tauri process share one in-flight discovery/start result. Cross-process dead-host recovery and every native StorageRepair mode use a distinct named `recovery_bootstrap_mutex` derived from the canonical data-directory identity and protected by the same user-only security descriptor as the host ownership mutex. Tauri must acquire this OS mutex before its first dead-host proof read, StorageRepair classification/preparation, bootstrap creation/replacement, or replacement-host spawn. A bootstrap/replacement path holds it continuously through `BootstrapImported` or failure cleanup and releases it only after the candidate has acquired/published ordinary host ownership or the recovery attempt has safely stopped. A StorageRepair path follows the exact nested lock/authority order and release boundary in section 4.4. Other Tauri processes block and then restart discovery from disk; they never write a bootstrap or spawn while another process holds the recovery mutex. If `WaitForSingleObject` reports `WAIT_ABANDONED`, the new owner treats that result as ownership plus mandatory reconciliation, not as a clean first acquisition: before any write or spawn it re-reads runtime discovery, exact prior-host identity, bootstrap, the `StateV2.last_recovery_bootstrap_import` witness, and tombstone under the mutex; only the exact crash-prefix cases in section 4.4 may continue. Missing/malformed/mismatched artifacts, a possibly live prior owner, or an unclassifiable import state fails closed without overwrite or second spawn. Normal release and owner death therefore share one explicit state machine, while abandoned acquisition has no shortcut. The candidate host still independently requires the ordinary data-directory ownership mutex before bind/publication; the recovery mutex serializes preparers and does not substitute for host ownership. Bootstrap publication is atomic create-or-exact-match while this mutex is held and never overwrites different content. Runtime discovery is re-read after spawn. Malformed or unreadable runtime state is not blindly deleted. Protocol mismatch does not enter an automatic replacement path.

### 4.3 Detached Rust host

The host remains responsible for:

- ConPTY process ownership.
- Input and output.
- Authoritative byte rings.
- Process and Job Object lifetime.
- Session creation, resize, natural exit, explicit close, and shutdown.
- Global event sequencing.
- Atomic durable state and layout revisions.
- Profile discovery.
- Runtime discovery ownership.

### 4.4 Data ownership

The host remains the sole live writer of its durable state file. Durable state has two separately revisioned React-owned domains:

```text
ui_layout: LayoutV1                 // opaque to the host, layout_revision
safety_state: SafetyStateV1 {       // typed and validated by the host, safety_revision
  settings,
  recovery_records,
  recovery_operations,
  confirmations,
  kill_switch
}
```

While the host is live, React reads and writes these domains only through protocol-v2 compare-and-swap operations. The Tauri bridge may read the last durable document only after it has proved the host absent, for preview and reconstruction. It must not become a second writer. The sole exception is the explicit dead-host `StorageRepair` transaction in section 8.3, including its `containment_reboot` mode; no separate native containment writer exists. Every StorageRepair path acquires the named `recovery_bootstrap_mutex` before its first dead-host proof read, then the path-derived `data_dir_preownership_mutex`, then the UUID-derived ordinary data-directory mutex when the UUID is derivable, and retains that chain continuously through source proof, native dialog, post-dialog re-read, journal/ledger publication, target mutation, verification, terminal result, or failure cleanup. The continuously held recovery/preownership chain is the exclusive StorageRepair authority: no concurrent StorageRepair, bootstrap, migration, dead-host replacement, or host publication may interleave. No path that already holds preownership, the ordinary UUID mutex, or StorageRepair ledger authority may then request `recovery_bootstrap_mutex`; ordinary live-host startup never requests the recovery mutex. For owner-absent classifications, Tauri derives the ordinary mutex name from the exact target UUID before acquiring repair or ledger authority: `adopt` uses the unanimously validated source UUID, while `reset` first host-generates its plan-bound candidate UUID under recovery plus preownership without writing any artifact. It acquires and retains that UUID mutex in the declared order before the exclusive StorageRepair authority, even though the ownership file is still absent; mutex ownership is exclusion, not proof that storage ownership has been published. The later exact authorized plan atomically creates and validates the ownership file while the already-held UUID mutex prevents a same-target host from publishing. `foreign_or_orphaned|ambiguous` permits no mutation. Temporary storage authority and every repair lock end before a replacement host acquires/publishes ordinary ownership.

During a dead-host recovery gap, Tauri may create one user-ACL-protected bootstrap document:

```text
RecoveryBootstrapV1 {
  schema_version: 1,
  bootstrap_id: UUID,
  data_dir_instance_id: UUID,
  prior_host_instance_id: UUID,
  source_state_content_hash: Sha256Hex,
  source_safety_revision: U64DecimalString,
  created_at: Timestamp,
  classification_preview: [RecoveryClassificationPreviewV1] <= 4096 items,
  operation_drafts: [RecoveryOperationDraftV1] <= 1024 items
}

RecoveryBootstrapTombstoneIdentityV1 {
  schema_version: 1,
  bootstrap_id: UUID,
  tombstone_content_hash: Sha256Hex
}

RecoveryBootstrapImportWitnessV1 {
  schema_version: 1,
  bootstrap_id: UUID,
  data_dir_instance_id: UUID,
  prior_host_instance_id: UUID,
  importing_host_instance_id: UUID,
  imported_safety_revision: U64DecimalString,
  source_state_content_hash: Sha256Hex,
  bootstrap_content_hash: Sha256Hex,
  prior_tombstone_identity?: RecoveryBootstrapTombstoneIdentityV1
}

RecoveryBootstrapTombstoneV1 {
  schema_version: 1,
  bootstrap_id: UUID,
  data_dir_instance_id: UUID,
  prior_host_instance_id: UUID,
  importing_host_instance_id: UUID,
  imported_safety_revision: U64DecimalString,
  source_state_content_hash: Sha256Hex,
  bootstrap_content_hash: Sha256Hex
}
```

`Sha256Hex` is exactly 64 lowercase hexadecimal characters. `source_state_content_hash` is SHA-256 over the exact raw bytes of the last durable `state.json` read from disk, before any JSON parsing or normalization. Tauri and the replacement host hash the same file bytes; a missing or changed file is a bootstrap conflict. The bootstrap document is capped at 512 KiB serialized UTF-8 JSON and is rejected before write/import when the cap or any item bound is exceeded. The item caps deliberately equal the authoritative safety/session cardinalities; the serialized cap is the tighter practical limit. TermX never truncates, samples, paginates, or imports a partial affected set. If the complete bootstrap does not fit, reconstruction fails closed as `recovery_plan_too_large` and the UI offers exportable Manual instructions for the complete durable records without starting a replacement recovery action.

Tauri is the sole writer until the replacement host starts. The replacement verifies the data-directory identity, exact hashed base `StateV2`, and base safety revision, loads recovery records directly from that state rather than accepting record copies in the bootstrap, validates every operation draft/classification item, then applies the import as one safety-state commit. It runs each draft through the same host-owned operation constructor used by live `CreateRecoveryOperation`, deriving record lifecycle/pending-operation updates, the immutable execution binding, exact action preview/hash, initial phase/action/send invariants, timestamps, deadline, and kill-switch observation from the base record and current validated settings; a bootstrap cannot upsert a caller-constructed record or operation. Any `explicit_restart` confirmation already exists inside the hashed source state and is therefore not duplicated in the bootstrap, but it authorizes only destruction of the old host and is not referenced by newly constructed recovery operations. Automatic reconstruction after independently proven host death needs no prior confirmation because starting a replacement does not terminate a live owner. Neither case waives later Reviewed launch/resume/readiness/continuation approvals. Explicit restart is allowed only when the old host has no nonterminal operation; after exact old-host release, Tauri derives fresh `RecoveryOperationDraftV1` values from the durable managed records and the replacement constructs new `planned/not_started` operations. It never imports or claims to preserve an old operation journal across destruction.

Before constructing a later import candidate, the host reads the retained tombstone completely and computes `tombstone_content_hash=SHA-256(JCS(validated RecoveryBootstrapTombstoneV1))`. If a tombstone exists, the new witness includes `prior_tombstone_identity={schema_version:1,bootstrap_id:<old id>,tombstone_content_hash:<exact old hash>}`; if none exists, the field is absent. Any unreadable, malformed, or unhashable tombstone blocks import. In the same atomic `StateV2` replacement that installs all host-derived record lifecycle/pending-operation updates, host-derived operations, and one incremented safety revision, the replacement writes `last_recovery_bootstrap_import` as that exact `RecoveryBootstrapImportWitnessV1` for this immutable bootstrap. Only after the state replacement is durably flushed may it create the matching new `RecoveryBootstrapTombstoneV1`, flush it, and install it: create-new/non-overwriting when the witness has no prior identity, or atomic replace-existing only when the currently retained tombstone still exactly matches `prior_tombstone_identity`. It then removes the bootstrap with the same Windows replacement discipline and returns `BootstrapImported { bootstrap_id, safety_revision }`. `bootstrap_content_hash` is SHA-256 over the RFC 8785/JCS serialization of the complete validated `RecoveryBootstrapV1`. A current tombstone is idempotent success when its bootstrap ID, data-directory ID, prior-host ID, source-state hash, bootstrap-content hash, and imported revision exactly equal the current witness/incoming bootstrap. `importing_host_instance_id` is historical evidence only and is not required to equal the current host after a crash/restart. The matching current tombstone is durable proof that this exact immutable bootstrap committed, so later safety revisions or ordinary operation evolution do not invalidate replay acknowledgement. The current host returns its exact `imported_safety_revision` as the original import result and removes the matching leftover bootstrap; it does not require retaining historical state snapshots. A current tombstone is never removed merely because acknowledgement was delivered or the bootstrap was removed.

Startup/reconnect under `recovery_bootstrap_mutex` classifies the complete witness/bootstrap/tombstone tuple before import, acknowledgement, or overwrite. `RecoveryBootstrapImportWitnessV1` contains every field of the tombstone, so the current tombstone is derived exactly from the validated witness alone; a remaining bootstrap is additional immutable corroboration and, when present, must match the witness's bootstrap ID, data-directory/prior-host/source identities, and `bootstrap_content_hash`, but its absence after witness commit is never by itself a conflict. Exact current witness plus exact current matching tombstone is completed import. Exact current witness plus missing tombstone is safely repairable when `prior_tombstone_identity` is absent and the bootstrap is either absent or exact matching; the host creates the current tombstone from the witness without reapplying state. Exact current witness plus a tombstone matching `prior_tombstone_identity` is the defined later-import mixed crash prefix: when the bootstrap is absent or exact matching, the new `StateV2` import is already authoritative, the old tombstone proves the precise predecessor, and the host atomically replaces that exact old tombstone with the current tombstone derived from the witness, then proceeds without reapplying any operation. A tombstone matching neither the current witness nor its exact prior identity, a missing tombstone when a prior identity is recorded, an unexpected tombstone when prior identity is absent, a present bootstrap that does not exactly corroborate the witness, or any witness/tombstone hash, ID, revision, or source mismatch is `bootstrap_conflict`; nothing is overwritten and no new bootstrap is admitted. Operation-ID comparison alone is never proof. A crash before `StateV2` persistence leaves the bootstrap pending and re-appliable from the unchanged base revision. Crash injection after new-witness commit, before/during tombstone create/replace, after tombstone publication, during bootstrap removal, and before acknowledgement must reach exactly one of these classifications.

A crash after bootstrap removal but before the waiting Tauri receives `BootstrapImported` is witness/tombstone acknowledgement recovery, not a new import. The Tauri process that published the bootstrap retains its exact descriptor in memory while holding `recovery_bootstrap_mutex`; after reconnect it authenticates `Preflight`, compares `latest_recovery_bootstrap_import` against every retained descriptor field, and treats an exact match as the original `BootstrapImported` result. If that Tauri process also crashed, the next Tauri first authenticates `Preflight` while holding the recovery mutex and surfaces the returned latest import as `reconciled_import_completed`; no action is replayed and no new bootstrap is needed merely to acknowledge it. A new genuinely distinct bootstrap may be created only after the host has materialized and verified the matching current tombstone for its current witness. The next import records that tombstone's exact identity before installing its new witness, making witness-new/tombstone-old a recoverable named prefix rather than a claimed intact old pair. No reconstructed shell or provider launches before the original import has been acknowledged or exactly reconciled. From that point onward the host is again the sole writer.

Drag-generated layout changes may be debounced. Recovery journal transitions, kill-switch changes, confirmation records, and other safety-critical state are never debounced; they require a durable host acknowledgement before the external action proceeds.

The runtime bearer token and a distinct shutdown-authority key are generated by the host and persisted only in the runtime discovery file so a newly launched Tauri UI can authenticate to an already-running detached host and the native bridge can authorize destructive lifecycle actions. On first publication and every authoritative host replacement, both are independent cryptographically random 256-bit values encoded as 64 lowercase hexadecimal characters. That file receives user-only ACLs before it is published. Tauri reads both through native code but returns only the bearer token to React through the trusted in-memory bootstrap result. After Tauri reads it from that sole durable runtime-discovery location, the shutdown-authority key remains exclusively in trusted native Rust memory for API use. It is never exposed through an invoke result, event, JavaScript object, WebSocket payload, or any durable domain other than the user-ACL-protected runtime discovery file; the canonical host state/config/recovery/audit domains never contain it. The secrets are never placed in:

- A URL, query string, or hash.
- `localStorage` or `sessionStorage`.
- The host state document, settings, recovery records, or recovery bootstrap.
- A log, notification, audit record, or error report.
- A command-line argument or environment variable.

The Tauri content-security policy permits network connections only to the required loopback endpoint. The direct-WebSocket architecture has one honest limitation: JavaScript executing in the same trusted WebView can access the in-memory token. CSP, minimal dependencies, locked dependency versions, and no remote content reduce that risk; the design does not claim stronger isolation than it provides.

## 5. Mandatory host prerequisites

No Tauri or React implementation begins until these two current host defects have failing regression tests and passing fixes.

### 5.1 Committed-state snapshot isolation

The current layout transaction swaps the candidate into memory before persistence, then rolls back on failure. A concurrent `GetState` can therefore observe a layout that never became durable.

Protocol-v2 layout writes must instead follow this commit sequence:

1. Acquire the persistence/commit gate.
2. Compare the caller’s expected revision with the committed revision.
3. Construct a candidate state snapshot containing the new layout and next revision without installing it into observable state.
4. Atomically persist and rename the candidate snapshot.
5. Only after persistence succeeds, install the layout and revision as committed memory.
6. Allocate and publish `LayoutChanged` from the same registry commit sequence.

Persistence failure leaves the in-memory layout, revision, event cursor, and client-visible state unchanged.

The registry adds one `commit_lock` that is the linearization point for lifecycle commits, durable layout commits, event cursor allocation/publication, and snapshots. The lock order is:

```text
kill_switch_action_gate (when required)
  -> spawn_lock (when required)
  -> session_action_gate(s), ascending session ID (when required)
  -> commit_lock
  -> persist_lock
  -> entries
  -> layout
  -> safety_state
  -> graveyard
```

Every registry method, including `list`, close, shutdown, snapshot, graveyard pruning, and test helpers, follows this order or captures one lock’s data and releases it before acquiring a later independent lock. `SetKillSwitch` acquires only `kill_switch_action_gate` before the commit chain; it never waits for a session gate while holding `commit_lock`. The current `list` graveyard-then-entries inversion is removed. `persist_lock` is acquired only while `commit_lock` is already held; no path acquires `commit_lock` while holding `persist_lock`. No callback, session method, blocking process wait, or event send runs while `persist_lock`, `entries`, `layout`, `safety_state`, or `graveyard` is held.

A durable commit holds `commit_lock`, acquires `persist_lock`, snapshots the required registry/layout/safety fields under their ordered inner locks, releases the inner locks, writes and atomically replaces that exact immutable candidate while still holding `commit_lock` + `persist_lock`, then installs any candidate memory/revision and emits its event before releasing `commit_lock`. Observed external facts use the same protocol: after updating the in-memory external fact under `commit_lock`, they acquire `persist_lock`, rebuild the complete current `StateV2` candidate, and attempt its write before allocating the event; a failed write leaves only the current in-memory fact plus a dirty-domain marker. Because no state commit can pass `commit_lock` during snapshot/write/install, the persisted candidate is exactly the committed registry state at that linearization point. Persistence helpers receive an already-captured candidate, perform no registry callbacks, and never acquire registry locks. Profile discovery is immutable for one host instance after startup; a future refresh must itself be a commit-sequenced event.

`GetState` and `AuthOk` acquire `commit_lock`, capture the committed layout/revision, session snapshot, current event cursor, host instance ID, data-directory instance ID, and profiles, and subscribe the connection’s bounded event receiver before releasing the lock. A mutation acquires the same lock, durably commits when required, allocates the next cursor, publishes the event into the hub, and only then releases it. This creates one linearization point: a concurrent transition is either included in the snapshot cursor or delivered after it, never neither or both.

It must return either the previous committed state or the new durable state, never a candidate or rolled-back state. The implementation must avoid re-acquiring the same non-reentrant commit or persistence lock from helpers.

### 5.2 Post-spawn setup guard

After `spawn_command`, several setup steps can fail before the waiter owns the child and ConPTY slave. Current failures can return without terminating or waiting for the spawned child.

Create an RAII setup guard immediately after spawn. Until it is explicitly disarmed, it owns:

- The child.
- The ConPTY slave.
- The master and any acquired reader/writer handles.
- The PID and exact retained process handle when available.
- The Job Object handle and assignment state.

Every fallible post-spawn step is covered, including:

- Opening exact process identity.
- Assigning the process to the Job.
- Cloning the PTY reader.
- Taking the PTY writer.
- Allocating required queues.
- Starting mandatory reader/writer/waiter threads.

Immediately after spawn returns, the setup guard must acquire and retain the exact root process handle with `PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE`; the handle passed to `AssignProcessToJobObject` additionally requires `PROCESS_SET_QUOTA | PROCESS_TERMINATE`. It queries identity through `GetProcessId` and `GetProcessTimes`, records PID and creation `FILETIME`, and retains the Job handle opened with `JOB_OBJECT_ASSIGN_PROCESS | JOB_OBJECT_QUERY | JOB_OBJECT_SET_ATTRIBUTES | JOB_OBJECT_TERMINATE | SYNCHRONIZE` plus one explicit assignment state: `job_assigned|job_not_assigned|job_assignment_unknown`. An identity API that requires `PROCESS_QUERY_INFORMATION` requests it explicitly and fails closed if unavailable. The root handle and creation time are established before any destructive action; no PID-only open substitutes for this retained identity. Every later root observation must match `(pid, process_start_time)`. Failure to acquire or verify that identity is `process_identity_unavailable`; setup stops and no PID-only destructive API is attempted.

The only permitted destructive targets are the retained exact root handle, retained descendant handles whose PID and creation `FILETIME` were verified, the exact locally owned Job handle after its ownership/assignment state is verified, and exact handles acquired by a fresh creation-time-aware scan before destruction. The default implementation never calls `portable-pty child.kill()`. It may use that method only if a version-pinned implementation proves and tests that the call operates through the same retained exact process handle or verified Job handle; otherwise its unspecified/PID-derived semantics are not an authorized cleanup mechanism. `taskkill`, PID-only termination, and any destructive call before exact identity proof are forbidden.

Failure cleanup has three explicit assignment-state paths, all beginning with a fresh check that the retained root handle still has the recorded creation time:

- **`job_assigned`:** while the verified exact root handle is retained, enumerate the exact descendant tree using PID, parent PID, and process creation time. Open and retain query/synchronize/terminate handles for every descendant absent from the Job accounting snapshot; these are pre-assignment escape candidates. After Job ownership and assignment are reverified, call `TerminateJobObject`, wait up to five seconds for the root and all observable Job processes, terminate each still-matching retained escaped descendant through its exact handle, and re-enumerate until Job accounting and the escaped-descendant forest are proven empty. Use retained direct-root-handle termination only if that exact root remains alive.
- **`job_not_assigned`:** enumerate descendants and open/verify every root/descendant handle before termination. Terminate only through those exact handles, wait, and repeat creation-time-aware enumeration until the exact forest is empty. The unassigned Job is closed only after proving that it owns no process.
- **`job_assignment_unknown`:** combine both proofs conservatively. Open and retain exact root/descendant handles before termination, verify the locally retained Job identity/accounting, terminate the Job only when ownership is proven, terminate still-matching processes only through exact handles, and repeat both Job-accounting and descendant scans until empty. A process that exits before its handle opens is treated as gone only after a fresh creation-time-aware enumeration; a reused PID with a different creation time is unrelated and never targeted.

`CreateSession` arms durable unregistered-containment evidence before the OS spawn boundary. Under `kill_switch_action_gate -> spawn_lock -> commit_lock -> persist_lock`, the host constructs one complete `StateV2` candidate containing both the existing matching `SessionCreationReceiptV1(state=reserved)` and one `UnregisteredContainmentRecordV1(state=armed, receipt_state=reserved, setup_stage=armed_before_spawn, root_identity_status=unavailable, job_assignment_state=unknown, reason_code=spawn_boundary_uncertain, no identities, no proof)`. It atomically persists, flushes, and re-reads that candidate before entering the process-creation API. If the commit fails, no OS spawn, sequence increment, session/registry mutation, or event occurs. Record and receipt changes always use the same complete-State writer; no process wait, termination, reader drain, or callback runs under persistence or inner registry locks.

If the uninterrupted guard proves that the OS process-creation API was never entered, it may atomically classify the receipt `reserved -> failed_pre_action` and the record `armed -> resolved_absent` with `proof.method=pre_spawn_boundary_not_entered`. This is the only path to `failed_pre_action`. Once the API may have been entered, the receipt becomes `unknown`, never `failed_pre_action`, even if the call returns no usable child. Immediately after the call returns, the guard enriches the same record with every available exact root PID/creation `FILETIME`, executable identity, Job assignment state/accounting fingerprint, setup stage, and creation-time-verified escaped descendants. If a crash occurs before that update, startup treats the durable `armed/reserved` prefix as possible execution, never as pre-action failure.

All cleanup paths then wait for the child, preserve the slave-until-child-exit invariant, close ConPTY handles, and finish bounded reader drain outside all registry/persistence locks. A five-second deadline or any unverifiable identity, handle, assignment, descendant, or Job-accounting observation is fail-closed. For an already registered session it durably enters `close_uncertain`, retains the teardown ownership record and available handles, and emits no `SessionClosed`. For an unregistered post-boundary setup failure it creates no durable session, registry entry, `PersistedSessionRecordV1`, `TeardownRecordV1`, or lifecycle event. After exact cleanup, it atomically writes either `resolved_absent` with a complete exact absence proof or `containment_uncertain` with no absence claim; cleanup or persistence failure retains `receipt_state=unknown` plus `containment_uncertain`. It never retries creation from either post-boundary outcome and never converts an exact-cleanup `unknown` receipt to `failed_pre_action`.

The guard is disarmed only after waiter ownership and all session resources are installed. Successful registration atomically installs the exact session/receipt ownership and removes the matching unregistered-containment record in the same complete `StateV2` commit before the guard disarms; it creates the ordinary single `SessionCreated` event only for that registered generation. Unregistered-containment record updates do not increment `safety_revision` and emit no safety or lifecycle event. Acceptance tests instrument every destructive call and require exact root-handle acquisition and creation-time verification to precede it; creation-time mismatch and PID reuse prevent termination; the default path never invokes `portable-pty child.kill()`; Job destruction requires proven ownership/assignment; descendant destruction requires a retained verified handle; and every injected failure either proves exact absence or leaves the durable containment obligation rather than claiming cleanup success.

## 6. Windows Job Object containment

M2 adds Job Objects as defense in depth against descendant escape during explicit close or shutdown.

### 6.1 Creation and assignment

1. Create and configure a Job before spawning the shell.
2. Set `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
3. Spawn through `portable-pty`.
4. As soon as the exact process handle is available, assign it to the Job.
5. If assignment fails, abort session creation through the post-spawn setup guard.

`portable-pty 0.9` does not expose suspended creation or a process-attribute Job assignment path. Assignment therefore has an unavoidable post-spawn race window. Immediately after exact root identity verification and again immediately before successful setup-guard disarm, the host snapshots descendants by PID, parent PID, and creation time and compares them with Job accounting. It opens and retains exact handles for any descendant outside the Job, attempts assignment of eligible escaped descendants to the same Job, and aborts through the setup guard if assignment or exact containment proof fails. The guard’s cleanup retains and terminates those exact escaped descendants as defined above. Documentation and UI must still call containment **best effort**, not race-free or complete, because enumeration itself cannot make Windows process creation atomic. “Best effort” does not permit continuing with a known or unverified uncontained process after assignment.

### 6.2 Lifetime policy

- Store the Job handle in the `Session`.
- Never invoke `taskkill` or any PID-only destructive API. Fallback termination uses only creation-time-verified retained process handles plus repeated exact descendant enumeration; uncertainty fails closed.
- Natural root-shell exit does not immediately close or terminate the Job. Descendants remain contained and may continue until the user explicitly closes the session or the host shuts down.
- `CloseSession` and host shutdown explicitly call `TerminateJobObject`; they do not rely only on Rust `Drop`, because outstanding `Arc<Session>` references may delay handle closure.
- `CloseSession` is a bounded two-commit transaction. Under the target `session_action_gate` and `commit_lock`, the host removes the exact lifecycle generation from active entries, installs the same resource-owning object in the graveyard, persists `TeardownRecordV1(state=closing)`, allocates/publishes exactly one `SessionCloseStateChanged { lifecycle: closing }`, then explicitly releases `persist_lock`, every inner registry lock, and `commit_lock`. It retains only the target session gate, one teardown-owner token, the resource-owning session object, and exact OS handles. Job/root/escaped-descendant termination, process waits, final reader drain, and ConPTY closure then run with no registry or persistence lock held; cleanup is capped at five seconds. Unrelated snapshots and durable commits may proceed and must observe this generation in `closing`; a repeated close for the same generation joins the one teardown owner. After exact root, Job accounting, retained escaped descendants, fresh descendant scans, waiter completion, and handle closure are proven, the owner reacquires `commit_lock` in the declared order and performs exactly one second durable commit: remove the exact graveyard/teardown record, update the matching `SessionCreationReceiptV1` from `session_disposition=present` to `closed` while preserving its sequence/ID/hash/session/generation, emit `SessionClosed`, and return `CloseAccepted`.
- If that proof times out or any identity/accounting observation is unavailable, the teardown owner reacquires `commit_lock` in the declared order, durably changes the exact graveyard record to `close_uncertain`, allocates/publishes exactly one `SessionCloseStateChanged { lifecycle: close_uncertain }`, retains all still-valid handles/resources, and returns structured non-retryable `close_uncertain`; it emits no `SessionClosed` and marks the session in `ContainmentStatusV1`. The durable teardown record mirrors known exact process identities but cannot preserve OS handles across host death. During startup ownership classification, before listener/runtime publication and before any new session/recovery action, the new host loads every teardown record under `commit_lock`. It first verifies that any `structured_bridge_process` appears in exactly one durable ownership location: either one operation or one teardown record, never both; duplicate/conflicting ownership fails closed as `teardown_reconciliation_failed`. Each persisted `closing` record is an interrupted transaction whose original resource handles are irretrievably lost: the host performs a best-effort non-destructive exact identity/boot scan for diagnostics, then durably transitions that exact lifecycle generation to `close_uncertain`, sets `last_checked_at` to the host-generated startup time and `reason_code=host_restarted_during_close`, and emits no event because no client/event cursor exists yet. If this replacement fails, startup fails before listener publication as `teardown_reconciliation_failed`; it never leaves a reachable host with an immortal `closing` record. Existing `close_uncertain` records remain unchanged except for no-op diagnostic observations. `KILL_ON_JOB_CLOSE` is expected to have terminated assigned Job members, but because a crash may have interrupted final descendant enumeration, startup never upgrades either state to closed automatically even when known identities are gone. The now-canonical `close_uncertain` record remains until separately authorized repair establishes the required containment policy (for example after verified reboot/no matching identities) and removes it. Shutdown reconciliation in the same uninterrupted live host may still complete exact proof while handles remain valid. A replacement/recovery operation involving the same stable tab is blocked until final close or authorized repair.
- Repeated `CloseSession` with the same request ID uses request deduplication. A new request for an already `closing|close_uncertain` generation joins/reconciles the existing teardown and cannot start a second cleanup owner.
- The host retains final output and exit state until explicit `CloseSession`, as in M1; the ring remains owned but is no longer attachable once the graveyard transition commits.

### 6.3 Authorized teardown repair

A host restart cannot recreate lost process/Job handles, so it never clears `close_uncertain` from absence scans alone. M2 exposes one narrow native-authorized repair that is available only after a verified Windows reboot: `current_system_boot_time_filetime` must be strictly later than the teardown record’s persisted `system_boot_time_filetime`. Because every exact root/escaped creation time belongs to the prior boot, this establishes that those processes cannot still exist; same-boot manual assertions are insufficient.

`PrepareTeardownRepair` is bearer-authenticated but read-only. Under the target `session_action_gate` and `commit_lock`, the host requires the exact graveyard generation in `close_uncertain`, no live matching root, escaped descendant, or structured bridge identity, no conflicting session/stable-tab generation, and no pending/finalized shutdown transaction. If `session.recovery_binding` names a nonterminal operation, that exact operation must name the same stable tab and reconstructed session, have no launch/provider/send state in `submitting|unknown`, have `structured_bridge_state=containment_uncertain` with `structured_bridge_process` absent because ownership was moved to this teardown generation, and be the only linked nonterminal operation. Any other nonterminal or ambiguous recovery relationship is rejected. It queries the current boot time through the Windows system-time API, constructs the sorted exact-identity list as `ProcessIdentityV1` projections of the session root when present, all `escaped_descendants`, and `structured_bridge_process` when present, rejects duplicates, and sorts by `(pid, process_start_time)`. When the exact linked nonterminal operation exists, it also constructs `linked_ownership=TeardownRepairLinkedOwnershipV1` from the operation/record stable tab and operation ID, reconstructed terminal session, and the teardown-owned `BridgeProcessIdentityV1` structured bridge attempt/channel/pipe-endpoint/binding-hash fields; `bridge_process_identity_hash=SHA-256(JCS(the complete closed BridgeProcessIdentityV1))`. Every projection field and that complete identity hash must agree with the operation's current attempts, recovery binding, and the sole teardown-owned bridge identity. Otherwise `linked_ownership` is absent. It computes `proof_hash=SHA-256(JCS({data_dir_instance_id, host_instance_id, session_id, lifecycle_generation, linked_ownership, prior_system_boot_time_filetime, current_system_boot_time_filetime, exact_identities}))`. The list has at most 4,098 entries. It creates a one-use in-memory `TeardownRepairPreparationV1` expiring after five minutes. Preparations are capped at 16 and the complete retrieval response at 512 KiB; overflow fails as `teardown_repair_capacity` without truncation.

React may display that repair is available, but cannot retrieve exact proof identities or authorize mutation. It invokes native `ConfirmTeardownRepair { preparation_id }`. Tauri reads the native-only shutdown-authority key, generates a fresh `native_read_nonce`, and calls `GetTeardownRepairPreparation` with `HMAC-SHA-256(shutdown_authority_key, "termx-teardown-repair-read-v1" || JCS({request_id, preparation_id, native_read_nonce}))`. The host verifies the one-use nonce/MAC and returns its stored preparation plus exact identities. Tauri verifies the JCS proof hash and shows a native OS dialog stating that TermX will remove one uncertain historical ownership record based on the detected reboot; it does not claim to terminate a process. On affirmative input, Tauri calls `RepairTeardown` with `native_mac=HMAC-SHA-256(shutdown_authority_key, "termx-teardown-repair-v1" || JCS(preparation))`.

Under the same session gate and `commit_lock`, `RepairTeardown` re-queries boot time, reconstructs the complete optional `linked_ownership` projection, repeats all exact-absence/conflict/linked-operation checks, requires byte-equivalent preparation/proof/current boot including exact linked-ownership equality, and consumes the one-use authorization only as part of the successful commit. It constructs one complete `StateV2` candidate that removes the exact graveyard generation, updates the matching `SessionCreationReceiptV1` to `session_disposition=closed` while preserving its identity, and, when the target has the exact linked nonterminal operation described above, sets that operation’s `structured_bridge_state=closed`, leaves its process field absent, terminalizes it without retry as `unknown_external_action` unless durable `send_state=accepted` already proves the continuation outcome (then `recovered`), clears the matching record `pending_operation_id`, and records a safe reboot-repair reason. It persists and installs that candidate atomically. If safety state changed, it increments `safety_revision` once and sequences `SafetyStateChanged` first; it then sequences `SessionClosed` at the immediately following event ID for the same commit before returning `TeardownRepaired`. The repair never resets a possible-execution outcome to `not_started|failed_pre_action`, never relaunches a bridge/provider/send, and does not shut down the host. Any lifecycle/safety/session commit affecting the target, host restart, shutdown preparation, nonce replay, expiry, changed boot/identity scan, or persistence failure invalidates the preparation and changes no state. A pending teardown repair blocks shutdown finalization for that target; starting shutdown invalidates unapproved teardown repairs. Crash before the final durable replacement leaves `close_uncertain`; crash after replacement is reconciled from the absent exact generation and cannot emit a duplicate event in the new host instance. Tests inject every preparation/read/dialog/commit/acknowledgement boundary, MAC/nonce replay, same-boot refusal, PID reuse, changed identity list, and persistence failure.

### 6.4 Native repair of unregistered containment

An `armed` or `containment_uncertain` unregistered record is not cleared from same-boot absence, executable-name, PID-only, or broad process scans. When exact identity was unavailable or the host crashed before enrichment, the only escape is `StorageRepair(mode=containment_reboot, record_id=<exact record>)` after a verified Windows reboot. This is a mode of the sole exclusive dead-host writer in section 8.3, not a separate `StateV2` transaction or authority.

Under `recovery_bootstrap_mutex -> data_dir_preownership_mutex -> ordinary UUID mutex -> exclusive StorageRepair authority -> authorization-ledger writer`, Tauri re-proves that no authenticated host, runtime owner, matching host process identity, reachable endpoint, bootstrap import, replacement attempt, or other repair is live. `containment_reboot` is valid only for `owned_valid`; owner-absent, foreign/orphaned, ambiguous, or both-invalid storage cannot use it. It selects one exact validated source: valid primary when primary validates, otherwise valid backup when primary is malformed/unreadable/unsupported and backup validates. If both validate but their `unregistered_containment_records` differ, source selection is ambiguous and nothing changes. The immutable plan binds the source role, exact artifact identity/length/hash and embedded data-directory UUID, target `record_id`, canonical hash of that exact record without proof, the host-generated result `last_checked_at` timestamp, expected complete result bytes/hash/length, current boot, and every other ordinary StorageRepair observation. Prepared/authorized state retains hashes and exact source/record projections, not an unjournaled writable copy of the source. After authorization is consumed, Execute must re-read the exact bound source bytes before deriving and writing the bounded deterministic candidate temporary described in section 8.3.

Preparation requires the named record to remain unresolved and `current_system_boot_time_filetime > record.system_boot_time_filetime`; same-boot preparation returns `same_boot` without ledger, journal, or target mutation. The candidate proof is `UnregisteredContainmentProofV1(method=reboot_native, checked_system_boot_time_filetime=current boot, root_absent=true, descendants_absent=true, exact_identity_set_hash=SHA-256(JCS(the unique sorted persisted root plus escaped-descendant identities)), proof_hash=SHA-256(JCS({data_dir_instance_id, complete record without proof, checked boot, exact identity set})))`. `ConfirmStorageRepair` re-reads the same exact source/record/boot projections while holding the full lock chain and displays a native OS dialog stating that TermX will mark one historical containment obligation resolved because Windows has rebooted; it never claims to terminate a process or recover a provider. React receives only the bounded generic StorageRepair result and cannot authorize the mutation.

`ExecuteStorageRepair` journals and consumes the exact authorization before target mutation, re-reads the selected source and requires byte-equivalent identity/length/hash plus the exact unresolved record and unchanged later boot, then constructs candidate bytes from that source by changing only the target record to `state=resolved_absent`, `receipt_state=unknown`, `setup_stage=reboot_repair`, `reason_code=reboot_proof`, the exact preview-bound `source_snapshot.target_result_last_checked_at`, and the exact proof. Execute never substitutes its current wall-clock time, so the candidate bytes remain identical to the authorized expected result after acknowledgement loss or crash replay. It publishes those bytes through the `containment_sync` StorageRepair quarantine/primary/backup phases, verifies both canonical copies as the complete exact result, and records its terminal ledger/journal result. When the source was backup because primary was invalid, the exact source and malformed primary are preserved in their bound quarantine artifacts while both canonical paths receive the repaired result. A subsequent restore or adopt plan must select and publish this exact resulting containment field without discarding or rewriting any other resolved or unresolved record. Reset remains forbidden while any unresolved record exists.

The mode creates no session, registry entry, teardown record, recovery operation, safety revision, lifecycle event, host shutdown authorization, or process action. Crash-prefix reconciliation is exactly the section-8.3 journal state machine: before durable journaled publication the source remains unchanged; after journal consumption the exact immutable plan resumes; after verified publication one durable resolved proof exists. Cancel, stale source bytes, ownership loss, field-cap failure, or persistence/read-back failure changes no containment state unless a consumed journal already requires deterministic resume. Reboot repair never targets or terminates a current process. A later ordinary retention sweep may prune the resolved record; unresolved records are never pruned.

## 7. Protocol version 2

M2 deliberately introduces a new protocol major. Compatibility is explicit rather than inferred from package versions.

Every `JCS(value)`, canonical JSON serialization, and canonical JSON hash in this document uses RFC 8785 JSON Canonicalization Scheme after strict validation into the named closed schema. The UTF-8 JSON parser rejects a byte-order mark, invalid UTF-8, duplicate object member names at any nesting depth, non-finite numbers, and values outside the declared type/range before canonicalization; hash-bearing closed schemas reject unknown fields rather than preserving extensions. Optional absent fields are omitted, present fields are serialized normally, arrays retain their schema-defined order unless the contract explicitly requires sorting first, and all `u64`-range domain values use `U64DecimalString` rather than JSON numbers. Hash-bearing schemas contain no floating-point fields. Rust and TypeScript share byte-for-byte conformance fixtures for every hash-bearing type, including duplicate-key/unknown-field rejection, Unicode escaping, member ordering, optional-field omission, and the exact SHA-256 of canonical UTF-8 bytes. Later references to “canonical rules” mean this paragraph plus RFC 8785.

### 7.1 Runtime discovery

Runtime discovery includes:

```text
runtime_schema_version: 2
data_dir_instance_id: UUID
host_instance_id: UUID
protocol_major: 2
protocol_minor: u16
host_version: string
pid: u32
process_start_time: U64DecimalString
port: u16
token: secret 256-bit string
shutdown_authority_key: secret 256-bit string
```

`data_dir_instance_id` is generated once for the data directory and persisted in a user-protected ownership file. `host_instance_id` changes whenever a new host process becomes authoritative. `process_start_time` is the unsigned 100-nanosecond Windows `FILETIME` value returned for that exact process. Event IDs are meaningful only within that host instance.

Whenever the ownership file is absent, every v2 host/Tauri initializer first acquires one canonical user-ACL-protected named `data_dir_preownership_mutex` derived only from the canonicalized data-directory path. Ordinary initialization, legacy migration, and native storage repair use this same primitive; there is no separate initialization or migration mutex. Only while holding it does the candidate re-enumerate and classify every owner/state/backup/repair-journal/authorization-ledger/quarantine/audit/config/runtime/temporary artifact, probe any legacy runtime/process identity, and choose exactly one context and branch. Ordinary brand-new initialization is legal only when every listed artifact is absent and no pending native repair exists: apply/verify the directory ACL, generate one UUID, acquire the mutex derived from that UUID while retaining preownership, create-new publish/flush/re-read the exact owner and ACL first, publish/flush/re-read canonical initial `StateV2` naming that UUID second, then retain the UUID mutex as host ownership while releasing preownership. A crash after owner publication may resume this owner-first sequence only when the exact owner remains valid, StateV2 and every other listed artifact remain absent, and no repair journal exists. Native `adopt|reset`, including an empty-directory reset, is a distinct explicit preview-bound/confirmed/journaled context under `[M2-SCHEMA-StorageOwnershipClassificationV1]` in section 8.3; it never uses the ordinary shortcut, and owner-absent reset publishes state before owner. A matching nonterminal repair journal takes precedence and resumes before owner-absent classification. Any recognized or unrecognized pre-v2 artifact otherwise enters migration/repair classification and forbids ordinary UUID creation. If another participant created the ownership file before this owner’s reclassification, the candidate reclassifies and uses the exact valid owner only through the applicable ordinary-resume, migration, or repair rules rather than replacing it. An abandoned preownership mutex is recoverable only after complete reclassification; malformed content, unverifiable ACL, competing file/directory identity, or a live/unverifiable legacy writer stops as `ownership_uncertain`. The mutex remains held until the candidate acquires the UUID-derived ordinary ownership mutex or safely stops. Legacy M1 binaries do not participate in this new mutex, so their exclusion is proved through authenticated legacy runtime identity plus exact PID/start-time liveness checks while the preownership mutex is held; no migration or UUID publication occurs while a legacy owner is live or uncertain.

The per-data-directory single-instance primitive is a user-ACL-protected named Windows mutex derived from the validated data-directory instance UUID, held for the entire host lifetime. A candidate must own it before binding or publishing runtime state. Runtime publication writes an ACL-protected same-directory temporary file, flushes it, atomically replaces the runtime file, reads it back, and authenticates to the advertised endpoint with the token. It exits if any identity field changed or the endpoint reports another host instance. An abandoned mutex permits recovery only after the prior PID/start-time identity and endpoint are proven dead; otherwise startup stops as `ownership_uncertain`.

PID, executable name, process start time, and port are diagnostic prefilters only. A host is trusted only when an authenticated native `Preflight` response proves the exact token, host instance, data-directory instance, protocol version, PID, and process start time recorded in discovery. A PID-reused, foreign-data-directory, wrong-token, malformed, or unverifiable record is quarantined and never automatically deleted or treated as live.

For an existing M1 data directory with no instance UUID, migration is explicit and remains under the same path-derived `data_dir_preownership_mutex`. If a legacy host is authenticated and live, Tauri may read its legacy state but does not invent ownership identity or start a v2 host. Because protocol v1 has no independent native shutdown-authority key, M2 does not programmatically terminate that host: the UI provides Manual instructions to close it through the legacy application/user-controlled process, then retries discovery. Only after exact PID/start-time and endpoint checks prove no legacy host/process owns the directory does the mutex owner reclassify the unchanged artifacts, create the UUID ownership file with user-only ACL, migrate state/config, acquire UUID-derived host ownership, and release preownership. If absence cannot be proved or artifacts change during the transaction, migration stops as `ownership_uncertain`.

### 7.2 Handshake

Native discovery first performs `Preflight` using the runtime schema it found. For runtime schema 2 the exact exchange is:

```text
Preflight {
  request_id,
  token,
  expected_data_dir_instance_id,
  expected_host_instance_id
}

PreflightOk {
  request_id,
  data_dir_instance_id,
  host_instance_id,
  pid,
  process_start_time,
  host_version,
  protocol_major,
  protocol_minor,
  latest_recovery_bootstrap_import?: RecoveryBootstrapTombstoneV1
}
```

It is authenticated, read-only, and does not register a lifecycle-event client. `latest_recovery_bootstrap_import` is absent when no import has ever committed; otherwise the host derives it from the exact durable `last_recovery_bootstrap_import` witness and returns the tombstone-shaped fields byte-for-byte, including the original imported safety revision and historical importing host. It is recovery/discovery evidence only and does not expose operation content. Any mismatch returns a structured error and closes the connection.

For legacy runtime schema 1, Tauri recognizes the missing major before React connects; it may perform the legacy `Auth { token }` handshake only to verify that the endpoint owns the token and reports its host version, then issue legacy `GetState` to construct a read-only affected-session/layout preview. It immediately closes afterward. A legacy host cannot emit a v2 structured mismatch or prove native-only shutdown authority, so Tauri synthesizes the local `legacy_protocol_host` compatibility result. Automatic/programmatic restart is unavailable. After preview, Tauri offers only Manual close instructions and polls exact endpoint/PID/start-time release; it never sends legacy `Shutdown`. Migration starts only after independently proven legacy absence under `data_dir_preownership_mutex`.

After successful native v2 preflight, React’s first text request is `Hello`:

```text
Hello {
  request_id: RequestId,
  token: string,
  client_version: string <= 256 UTF-8 bytes,
  protocol_major: 2,
  protocol_minor: u16,
  supported_features: [FeatureId] <= 128 items
}
```

The host validates the bearer token before returning protocol details. A v2 major mismatch returns a structured `protocol_major_mismatch` error and closes only that connection. `FeatureId` is a lowercase ASCII identifier matching `[a-z0-9][a-z0-9._-]{0,63}`. For major 2, `negotiated_minor=min(Hello.protocol_minor, runtime.protocol_minor)`. The initial M2 feature registry is exact:

```text
FeatureRegistryV2 = {
  "core.snapshot_events": 0,
  "core.chunked_replay": 0,
  "core.layout_cas": 0,
  "core.safety_state": 0,
  "core.recovery_submit": 0
}
```

The host advertises the registry keys compiled into that binary; there is no separate runtime field. A feature is enabled only when its registry minimum is at or below `negotiated_minor` and it appears in both `Hello.supported_features` and the host registry. Unknown feature IDs are ignored, not errors. All commands and fields specified in this document require the listed minor-0 feature domain; a disabled required feature causes the relevant command to return structured `unsupported_feature`. Later minor additions must extend the version-controlled shared Rust/TypeScript registry before use. The exact negotiated minor and enabled feature set are returned in `AuthOk` and remain immutable for the connection.

A missing protocol major in legacy runtime or handshake data is treated as major 1. An M2 UI therefore recognizes an old host as incompatible without sending `Shutdown`.

Before snapshot capture, the server creates the connection’s byte-bounded outbound queue and event receiver and registers both with the hub. Under `commit_lock` it then captures the snapshot/cursor and enqueues `AuthOk` through the same writer arbiter before releasing the lock. Events committed afterward enter the registered queue behind that snapshot. If `AuthOk` cannot be enqueued, registration is removed before the connection closes.

Successful `Hello` returns the exact authoritative baseline:

```text
AuthOk {
  request_id: RequestId,
  host_instance_id: UUID,
  data_dir_instance_id: UUID,
  protocol_major: 2,
  protocol_minor: u16,
  negotiated_features: [FeatureId] <= 128 items,
  host_version: string <= 256 UTF-8 bytes,
  event_cursor: EventCursor,
  next_creation_sequence: U64DecimalString,
  layout_revision: U64DecimalString,
  layout: LayoutV1,
  safety_revision: U64DecimalString,
  safety_state: SafetyStateV1,
  sessions: [SessionInfoV2] <= 4096 items,
  profiles: [ProfileInfoV2] <= 512 items,
  repair_status: RepairStatusV1,
  containment_status: ContainmentStatusV1
}
```

React installs this complete snapshot as its canonical baseline before reducing any queued event above `event_cursor`. It does not merge `AuthOk` field-by-field into stale renderer state.

### 7.3 Request correlation and errors

Every request has a unique request ID. Every direct response and direct error carries it. Unsolicited lifecycle events do not.

Mutation timeouts are reconciled through `GetState`; clients do not blindly retry mutations whose commit status is unknown.

Structured errors contain:

```text
Error {
  request_id?: RequestId,
  code: string <= 128 UTF-8 bytes,
  message: string <= 1024 UTF-8 bytes,
  retryable: bool,
  context?: string <= 128 UTF-8 bytes,
  session_id?: u32,
  details?:
      LayoutConflictDetails { revision: U64DecimalString, layout: LayoutV1 }
    | SafetyStateConflictDetails { revision: U64DecimalString, safety_state: SafetyStateV1 }
    | RecoveryErrorDetails { operation_id?: UUID, phase?: RecoveryPhase, send_state?: not_started|submitting|accepted|unknown, safe_error?: SafeRecoveryErrorV1 }
    | SizeLimitDetails { domain: string <= 64 UTF-8 bytes, maximum_bytes: u32 }
}
```

`details` is a closed tagged union keyed by the error `code`; unknown detail variants are rejected for protocol major 2. Before authentication fails, `request_id` may be absent only when the frame cannot be parsed far enough to recover it. Every parsed request receives a correlated success or error.

Required machine-readable codes include:

- `authentication_failed`
- `protocol_major_mismatch`
- `unsupported_feature`
- `invalid_request`
- `invalid_dimensions`
- `unknown_profile`
- `unknown_session`
- `not_attached`
- `spawn_failed`
- `input_backpressure`
- `input_too_large`
- `layout_conflict`
- `safety_state_conflict`
- `invalid_recovery_transition`
- `recovery_approval_required`
- `recovery_operation_mismatch`
- `kill_switch_engaged`
- `unknown_submission`
- `persistence_failed`
- `shutting_down`
- `internal_error`

Errors shown to the user include safe context such as profile, executable identity, or dimensions, but never the token or secret environment values.

### 7.4 Global lifecycle sequencing

A single registry commit sequencer assigns one monotonically increasing `event_id` to each committed transition:

```text
Event {
  host_instance_id,
  event_id,
  event
}
```

The wire schema is:

```text
Event {
  host_instance_id: UUID,
  event_id: U64DecimalString,
  event: SessionCreated { info: SessionInfoV2 }
       | SessionResized { session_id, cols, rows, persistence_status }
       | SessionExited { session_id, exit_code, persistence_status }
       | SessionCloseStateChanged { session_id, lifecycle: closing|close_uncertain }
       | SessionClosed { session_id }
       | LayoutChanged { revision, layout }
       | SafetyStateChanged { revision, safety_state }
}
```

`event_id` starts at 1 for each host instance. Event commit classes are explicit:

- **Durable-first:** layout, safety state, create registration, close-to-graveyard transition, and final close removal persist successfully before cursor allocation/publication. Persistence failure returns an error and publishes nothing; for create, the setup guard tears the unregistered process down. A close request first moves the entry from the active map into the host-owned teardown graveyard, persists its `closing` record, then publishes `SessionCloseStateChanged { lifecycle: closing }`; this does not emit `SessionClosed` or return `CloseAccepted`. A durable transition to uncertainty publishes `SessionCloseStateChanged { lifecycle: close_uncertain }`.
- **Observed external fact:** natural process exit and a successful ConPTY resize are already true outside persistence. The registry commits the observed state in memory, attempts durable persistence, and publishes `SessionExited` or `SessionResized` with `persistence_status: saved|failed`. Failed persistence is surfaced as a high-severity diagnostic and sets only a dirty-domain marker; no failed candidate snapshot or delayed record payload is retained. Every persistence attempt is serialized under `persist_lock` and rebuilds the complete `StateV2` from the current registry/layout/safety state after acquiring that lock. Session IDs are never reused, and each active or graveyard entry has an immutable lifecycle generation removed only by a proven final close. A later final-close commit removes that exact generation from the graveyard and writes the current snapshot before acknowledging, clearing any dirty marker for that generation. Therefore a retry after final close can write only the current registry without the removed record; an exit or resize retry cannot resurrect a closed session or overwrite newer dimensions.

The same event object is cloned to every authenticated client. Direct success acknowledgement is generated only after its corresponding commit class completes.

Every authenticated client receives the same event and ID, whether or not it is attached to the affected session. Events are published once per committed transition from a registry-owned event hub, not from per-attachment output forwarders.

Natural-exit observation moves to one registry-owned watcher per session. Explicit close emits `SessionClosed` once only after final teardown proof and suppresses a later duplicate exit transition from the same lifecycle generation. `GetState`, `AuthOk`, and `ListSessions` include graveyard entries as `lifecycle=closing|close_uncertain`; they are not attachable, resizable, writable, or eligible for reconstruction. A client that times out on `CloseSession` reconciles this state through `GetState` and never infers closure from disappearance alone.

Each client’s unified outbound arbiter is capped at 256 queued items and 4 MiB of serialized/decoded application payload, whichever is reached first. Lifecycle events alone are capped at 128 items and 2 MiB within that budget. Enqueue reserves bytes before cloning payload ownership. Queue overflow disconnects that client and forces a fresh snapshot; it never blocks the registry or a shell. The WebSocket transport permits at most 4 MiB of application-level UTF-8 text payload for a control snapshot; WebSocket frame headers, masking metadata, and transport-library bookkeeping are excluded from this application cap and are bounded separately by the WebSocket implementation. Encoded Replay messages and binary output frames have a 1 MiB application cap. Binary input frames have an exact 256 KiB total application-frame cap including the 5-byte tag/session header, so input payload is at most 262,139 bytes; larger parseable frames receive `input_too_large`. `AuthOk` and `State` are capped at exactly 4 MiB serialized UTF-8 application JSON, equal to the text-control application cap; `Sessions` is capped at exactly 1 MiB. Layout, safety state, live-session list, profile list, and historical-repair list are each independently capped at 512 KiB serialized. In addition, before listener publication and before any commit that can change a snapshot domain, the host serializes the complete candidate `AuthOk`/`State` envelope using the canonical wire encoder and requires its exact UTF-8 application JSON bytes to be at most 4 MiB including all JSON keys, escaping, metadata, and repair/containment status; WebSocket framing bytes are excluded. `Sessions` receives the analogous exact 1 MiB application-JSON aggregate check. Domain caps do not imply aggregate eligibility. A startup state that exceeds an aggregate cap fails before listener publication as `snapshot_too_large`; a live candidate commit that would exceed it returns the same structured error and changes no memory, revision, cursor, or durable file. Authoritative snapshots are never partially omitted, paginated, or truncated.

`AuthOk` and `GetState` atomically return the snapshot plus `event_cursor`. While applying a snapshot, the client buffers incoming events, then:

1. Discards event IDs at or below the cursor.
2. Ignores exact duplicates already reduced.
3. Requires strict contiguous IDs after the cursor.
4. Disconnects and resnapshots on a gap, host-instance change, or queue overflow.

There is no unbounded historical event replay. “Exactly once” means each committed transition is reduced once into a connected client’s canonical store; authoritative snapshots replace history missed while disconnected.

### 7.5 Session commands

Protocol-v2 supports correlated forms of:

- `CreateSession`
- `StartManagedProvider`
- `StartRecoveryProvider`
- `RegisterRecoveryIdentity`
- `CreateRecoveryOperation`
- `PrepareRecoveryReview`
- `Attach`
- `Detach`
- `Resize`
- `CloseSession`
- `ListSessions`
- `SetLayout`
- `GetState`
- `GetSafetyState`
- `CommitSafetyState`
- `SubmitRecoveryInput`
- `PrepareTeardownRepair`
- `GetTeardownRepairPreparation`
- `RepairTeardown`
- `PrepareShutdown`
- `FinalizeShutdownPreparation`
- `CancelShutdownPreparation`
- `GetFinalizedShutdownPreparation`
- `AuthorizeShutdown`
- `Shutdown`

All JSON integers representing byte offsets, event cursors/IDs, revisions, Windows `FILETIME`, nonce generations, or values that may exceed JavaScript’s safe integer range are decimal strings on the wire and are decoded to TypeScript `bigint`. Rust wire types use string-serialized `u64`. Session IDs and bounded dimensions remain JSON numbers because their ranges are explicitly below `2^53`.

Common wire aliases and bounded nested snapshot types are:

```text
RequestId = UUID
ProcessStartFiletime = U64DecimalString
EventCursor { host_instance_id: UUID, event_id: U64DecimalString }
PersistenceStatus = saved|failed
RecoverySessionBindingV1 { operation_id: UUID, launch_attempt_id: UUID }
SessionCreationIdentityV1 {
  schema_version: 1,
  origin: live_request|legacy_migration,
  creation_id: UUID,
  creation_sequence: U64DecimalString,
  profile_id: string <= 256 UTF-8 bytes,
  safe_cwd: string <= 32 KiB UTF-8,
  initial_cols: u16 1..=1000,
  initial_rows: u16 1..=500,
  stable_tab_id?: UUID,
  recovery_binding?: RecoverySessionBindingV1
}
SessionCreationReceiptV1 {
  schema_version: 1,
  creation_sequence: U64DecimalString,
  creation_id: UUID,
  creation_identity_hash: Sha256Hex,
  state: reserved|created|failed_pre_action|unknown,
  session_id?: u32,
  lifecycle_generation?: UUID,
  session_disposition?: present|closed,
  updated_at: Timestamp
}
TeardownRepairLinkedOwnershipV1 {
  schema_version: 1,
  stable_tab_id: UUID,
  operation_id: UUID,
  reconstructed_terminal_session_id: u32,
  structured_bridge_attempt_id: UUID,
  channel_id: UUID,
  pipe_endpoint_id: UUID,
  structured_channel_binding_hash: Sha256Hex,
  bridge_process_identity_hash: Sha256Hex
}
TeardownRepairPreparationV1 {
  preparation_id: UUID,
  session_id: u32,
  lifecycle_generation: UUID,
  linked_ownership?: TeardownRepairLinkedOwnershipV1,
  prior_system_boot_time_filetime: ProcessStartFiletime,
  current_system_boot_time_filetime: ProcessStartFiletime,
  exact_identity_count: u32,
  proof_hash: Sha256Hex,
  expires_at: Timestamp,
  native_approval_nonce: UUID
}
ShutdownPreparationV1 {
  preparation_id: UUID,
  confirmation_id: UUID,
  action: explicit_quit|explicit_restart|repair_reset,
  preview_hash: Sha256Hex,
  prepared_safety_revision: U64DecimalString,
  affected_operation_ids: [UUID] <= 1024,
  expires_at: Timestamp
}
ShutdownAuthorizationV1 {
  preparation_id: UUID,
  confirmation_id: UUID,
  action: explicit_quit|explicit_restart|repair_reset,
  preview_hash: Sha256Hex,
  expected_safety_revision: U64DecimalString,
  affected_operation_ids: [UUID] <= 1024,
  expires_at: Timestamp,
  native_approval_nonce: UUID
}
FinalizedShutdownReadV1 {
  request_id: RequestId,
  preparation_id: UUID,
  confirmation_id: UUID,
  authorization_hash: Sha256Hex,
  native_read_nonce: UUID
}

SessionInfoV2 {
  session_id: u32,
  creation_id: UUID,
  creation_sequence: U64DecimalString,
  creation_identity_hash: Sha256Hex,
  stable_tab_id?: UUID,
  recovery_binding?: RecoverySessionBindingV1,
  lifecycle_generation: UUID,
  profile_id: string <= 256 UTF-8 bytes,
  safe_cwd: string <= 32 KiB UTF-8,
  cols: u16 1..=1000,
  rows: u16 1..=500,
  lifecycle: running|exited|closing|close_uncertain,
  root_pid?: u32,
  root_process_start_time?: ProcessStartFiletime,
  job_accounting_fingerprint?: Sha256Hex,
  exit_code?: u32,
  containment_state: assigned|unassigned|unknown
}

ProfileDiagnosticV1 {
  code: string <= 128 UTF-8 bytes,
  retryable: bool,
  redacted_message: string <= 1024 UTF-8 bytes
}

ProfileInfoV2 {
  profile_id: string <= 256 UTF-8 bytes,
  display_name: string <= 512 UTF-8 bytes,
  kind: windows_powershell|powershell_core|git_bash|command_prompt|wsl,
  available: bool,
  executable_path?: string <= 32 KiB UTF-8,
  default_arguments: [string <= 8 KiB] <= 64 items and 64 KiB total,
  discovery_source: configured_override|system|path|registry|derived_path|wsl_query,
  diagnostic?: ProfileDiagnosticV1
}

HistoricalSessionStatusV1 {
  record: PersistedSessionRecordV1,
  recovery_status: historical_only|recoverable|unrecoverable|containment_uncertain,
  reason_code?: string <= 128 UTF-8 bytes
}

RepairStatusV1 =
    Ready { state: ready }
  | RepairRequired {
      state: repair_required,
      loaded_from: backup,
      listener_scope: diagnostic_repair_only,
      reason_code: string <= 128 UTF-8 bytes,
      source_snapshot: StorageRepairSourceSnapshotV1,
      pending_primary_quarantine_identity: ArtifactIdentityV1,
      historical_sessions: [HistoricalSessionStatusV1] <= 4096 items
    }

ContainmentStatusV1 {
  policy: best_effort_job_assignment,
  state: nominal|uncertain,
  affected_session_ids: [u32] <= 4096 items,
  affected_unregistered_record_ids: [UUID] <= 128 items,
  reason_code?: string <= 128 UTF-8 bytes
}
```

`cols * rows` must not exceed 250,000. Before process creation the host resolves the effective profile and cwd, constructs closed-schema `SessionCreationIdentityV1` from those effective values plus the request’s creation sequence, initial dimensions, stable tab, and recovery binding, and stores `creation_identity_hash=SHA-256(JCS(identity))`; subsequent `Resize` never changes it. Duplicate reconciliation rebuilds this identity from the incoming request under the same frozen recovery binding/profile rules and compares the hash, so current resized dimensions are never mistaken for initial creation parameters. `exit_code` is present only for an exited session. The host generates a fresh immutable `lifecycle_generation` UUID for each created session before registration; migrations generate and durably persist one before exposing the record in v2. Every newly created live v2 `SessionInfoV2` includes `root_pid`, `root_process_start_time`, and `job_accounting_fingerprint`; absence is permitted only for an already-exited or migrated/diagnostic snapshot and cannot prove recoverability. Snapshot session lists contain at most 4,096 entries and profile lists at most 512 entries. `ProcessStartFiletime` is the same canonical unsigned 100-nanosecond Windows `FILETIME` value defined for runtime discovery; persisted and runtime values are captured and compared through the exact retained process handle rather than PID alone.

The exact request schemas are:

```text
CreateSession {
  request_id,
  creation_id: UUID,
  creation_sequence: U64DecimalString,
  profile_id?,
  cwd?,
  cols,
  rows,
  stable_tab_id?,
  recovery_binding?: RecoverySessionBindingV1,
  expected_kill_switch_generation: U64DecimalString
}
StartManagedProvider {
  request_id,
  session_id,
  stable_tab_id,
  adapter_id,
  expected_initial_launch_attempts: u16,
  expected_kill_switch_generation: U64DecimalString
}
StartRecoveryProvider {
  request_id,
  operation_id,
  session_id,
  launch_attempt_id,
  resume_attempt_id,
  expected_kill_switch_generation: U64DecimalString
}
RegisterRecoveryIdentity {
  request_id,
  registration: RecoveryIdentityRegistrationV1
}
CreateRecoveryOperation {
  request_id,
  draft: RecoveryOperationDraftV1
}
PrepareRecoveryReview {
  request_id,
  action: reviewed_launch|reviewed_resume|reviewed_readiness|reviewed_continuation|reviewed_acceptance,
  operation_ids: [UUID] <= 1024
}
Attach { request_id, session_id, replay }
Detach { request_id, session_id }
Resize { request_id, session_id, cols, rows }
CloseSession { request_id, session_id }
ListSessions { request_id }
GetState { request_id }
SetLayout { request_id, expected_revision, layout }
GetSafetyState { request_id }
CommitSafetyState { request_id, expected_revision, mutations }
SubmitRecoveryInput {
  request_id,
  session_id,
  operation_id,
  expected_kill_switch_generation: U64DecimalString,
  continuation_fingerprint,
  data_b64
}
PrepareTeardownRepair {
  request_id,
  session_id
}
GetTeardownRepairPreparation {
  request_id,
  preparation_id,
  native_read_nonce,
  native_read_mac: Sha256Hex
}
RepairTeardown {
  request_id,
  preparation_id,
  native_approval_nonce,
  native_mac: Sha256Hex
}
PrepareShutdown {
  request_id,
  reason: quit|confirmed_restart|repair
}
FinalizeShutdownPreparation {
  request_id,
  preparation_id,
  confirmation_id
}
CancelShutdownPreparation {
  request_id,
  preparation_id
}
GetFinalizedShutdownPreparation {
  request_id,
  preparation_id,
  confirmation_id,
  authorization_hash,
  native_read_nonce,
  native_read_mac: Sha256Hex
}
AuthorizeShutdown {
  request_id,
  authorization: ShutdownAuthorizationV1,
  native_mac: Sha256Hex
}
Shutdown {
  request_id,
  reason: quit|confirmed_restart|repair,
  authorization: ShutdownAuthorizationV1
}
```

Read responses are:

```text
Sessions {
  request_id: RequestId,
  host_instance_id: UUID,
  event_cursor: EventCursor,
  sessions: [SessionInfoV2] <= 4096 items,
  repair_status: RepairStatusV1,
  containment_status: ContainmentStatusV1
}

State {
  request_id: RequestId,
  data_dir_instance_id: UUID,
  host_instance_id: UUID,
  event_cursor: EventCursor,
  next_creation_sequence: U64DecimalString,
  layout_revision: U64DecimalString,
  layout: LayoutV1,
  safety_revision: U64DecimalString,
  safety_state: SafetyStateV1,
  sessions: [SessionInfoV2] <= 4096 items,
  profiles: [ProfileInfoV2] <= 512 items,
  repair_status: RepairStatusV1,
  containment_status: ContainmentStatusV1
}
```

In `repair_required`, `Sessions.sessions` is empty and `repair_status.historical_sessions` carries the bounded historical-only records. Those records are not live `SessionInfoV2` values and cannot be addressed by session commands.

`GetState` follows the same registration-before-cursor algorithm as `AuthOk`: if the connection is already registered, it captures the snapshot under `commit_lock` and enqueues `State` through its writer before release. `ListSessions` captures sessions and cursor under the same lock. `GetSafetyState` captures `host_instance_id`, `event_cursor`, `safety_revision`, and the complete safety state under that lock. All three are correlation-bearing snapshots; client reconciliation discards buffered events at or below their returned cursor.

A successful mutation returns a correlated acknowledgement:

```text
SessionCreateAccepted { request_id, session_id, info }
ManagedProviderAccepted {
  request_id,
  session_id,
  stable_tab_id,
  provider_conversation: ProviderConversationV1,
  launch_attempt_id: UUID,
  admitted_bytes: u32
}
RecoveryIdentityRegistered {
  request_id,
  revision: U64DecimalString,
  record: RecoveryRecordV1
}
RecoveryOperationCreated {
  request_id,
  revision: U64DecimalString,
  operation: RecoveryOperationV1,
  action_preview: RecoveryActionPreviewV1
}
RecoveryReviewPrepared {
  request_id,
  preview: RecoveryReviewPreviewV1,
  confirmation_template: RecoveryConfirmationTemplateV1
}
RecoveryProviderAccepted {
  request_id,
  operation_id,
  session_id,
  resume_attempt_id,
  admitted_bytes
}
ResizeAccepted { request_id, session_id, persistence_status: PersistenceStatus }
DetachAccepted { request_id, session_id }
CloseAccepted { request_id, session_id }
LayoutSaved { request_id, revision }
SafetyStateCommitted { request_id, revision }
RecoveryInputAccepted { request_id, operation_id, submission_id, accepted_bytes }
TeardownRepairPrepared { request_id, preparation: TeardownRepairPreparationV1 }
// Native-only response; never returned to React:
TeardownRepairPreparation { request_id, preparation: TeardownRepairPreparationV1, exact_identities: [ProcessIdentityV1] <= 4098 items }
TeardownRepaired { request_id, session_id, lifecycle_generation, final_safety_revision: U64DecimalString, event_cursor: EventCursor }
ShutdownPrepared {
  request_id,
  preparation: ShutdownPreparationV1,
  preview: ShutdownPreviewV1
}
ShutdownPreparationFinalized {
  request_id,
  authorization: ShutdownAuthorizationV1
}
ShutdownPreparationCancelled { request_id, preparation_id }
FinalizedShutdownPreparation {
  request_id,
  authorization: ShutdownAuthorizationV1,
  preview: ShutdownPreviewV1
}
ShutdownAuthorized { request_id, confirmation_id, expires_at }
ShutdownAccepted {
  request_id,
  runtime_release_pending: true,
  final_safety_revision: U64DecimalString
}
```

One host-owned `kill_switch_action_gate` serializes `SetKillSwitch` with every shell-creation, managed-initial-launch, recovery-resume, structured-bridge process-creation, and continuation-admission boundary. An action acquires that gate before any required spawn/session gate, compares its typed expected generation to the current persisted generation, requires `engaged=false`, durably commits any specified pre-action journal state, and re-reads the still-current generation/engaged state immediately before the irreversible process-creation or queue-admission call. Because `SetKillSwitch` requires the same gate through its durable generation increment, an engagement either commits first and blocks the action without crossing its boundary, or waits until the earlier action has durably classified its outcome. Missing generation is `invalid_request`, stale generation is `safety_state_conflict`, and an engaged switch is `kill_switch_engaged`.

Every `CreateSession`, ordinary or recovery-bound, requires `expected_kill_switch_generation` and a globally unique caller-generated `creation_id`. A normal user-created `CreateSession` omits both recovery fields but not the kill-switch generation or creation ID. Before any launch boundary the host checks durable live, historical, and teardown records for that creation ID: an exact same canonical request reconciles to the existing session/generation, while a parameter mismatch is `invalid_request`; an unresolved historical outcome is `action_reconciliation_required` and creates nothing. A recovery-bound `CreateSession` additionally requires `recovery_binding` and `stable_tab_id`; the host derives profile, cwd, executable, argv, and qualification exclusively from the operation’s immutable `execution_binding` and verifies `phase=shell_recreating`, the exact current launch-attempt ID, `launch_action_state=not_started`, and the stable-tab/profile/cwd binding under the operation action gate. It durably commits `launch_action_state=submitting`, then performs the mandatory immediate kill-switch recheck before calling the process-creation API. If failure is proven before any child process is created, it commits `failed_pre_action` plus a safe classified error and a later retry must first commit a fresh `begin_attempt=launch`. Once process creation returns a child handle, no failure from Job assignment, durable registration, response delivery, or teardown is classified pre-action, even if the child is subsequently reaped. Any such post-creation failure commits `launch_action_state=unknown` and terminates the operation as `unknown_external_action` before returning a classified error; failure to persist that outcome closes the connection and is reconciled from the durable `submitting` state on reload. Successful containment and registration atomically persist the session with its exact `RecoverySessionBindingV1` and `launch_action_state=created` before `SessionCreateAccepted` is sent. A recovery binding is immutable and unique among live and durable session records.

`StartManagedProvider` is the only supported path that creates a TermX-managed recoverable initial provider identity; `RegisterRecoveryIdentity` separately records a user-asserted existing Codex identity without launching provider bytes. The request carries `expected_initial_launch_attempts`, a caller-observed CAS count rather than an attempt ID. On first launch it must be zero. A retry is accepted only when the durable record is `failed_pre_action` and its current count exactly equals that expected value; the host then increments the count and generates the fresh host-owned attempt ID before the boundary. An exact delayed duplicate carrying an older count reconciles the already-recorded outcome and never begins the next attempt; the caller must deliberately resnapshot and send the new count to request a retry. `StartManagedProvider` is otherwise allowed only for an ordinary live shell with no conflicting provider record, no recovery binding, a unique stable tab, a qualified adapter/profile encoder, and an exact current disengaged `expected_kill_switch_generation: U64DecimalString`. Under `kill_switch_action_gate` and the per-tab/session action gate, the host calls `prepare_managed_launch`, generates a fresh `launch_attempt_id`, captures the active session’s complete `ShellLaunchBindingV1` plus safe cwd, constructs the complete initial `RecoveryRecordV1` with its host-generated conversation identity and both exact initial/resume provider argv vectors, and durably stores that record with `initial_launch_action_state=submitting`, attempt ID/count 1, the immutable shell/session identity, and `status=interrupted` until admission is durably classified before any provider bytes can enter the queue. It then re-reads and requires the same kill-switch generation still disengaged immediately before encoding and atomically admitting the exact initial argv once. A failure proven before queue admission, including a failed immediate recheck, persists `failed_pre_action` and may be explicitly retried with a fresh host-generated attempt ID within the same configured bound; once any bytes may have entered, only `admitted|unknown` is legal. Full admission persists `initial_launch_action_state=admitted` and `status=live` before `ManagedProviderAccepted`; a proven pre-admission failure persists `failed_pre_action` and leaves the record `interrupted`/non-recoverable until explicit retry; an ambiguous outcome persists `unknown`, marks the record unrecoverable/manual-review-required, and never emits a second initial launch automatically. On startup, reload, or lost acknowledgement, the durable state is reconciled exactly like other external actions: `admitted` is success, `failed_pre_action` alone permits a bounded retry, and `submitting|unknown` is never replayed. This transaction is the required journal boundary for Claude `--session-id <uuid>` and proves that the same stored UUID will later be used by the stored resume argv.

`StartRecoveryProvider` is the only managed recovery path that writes a provider resume command. The host derives the exact resume argv from the operation’s immutable `execution_binding`; the client cannot supply command bytes and a later recovery-record edit cannot alter the action. Under `kill_switch_action_gate` and the operation/session action gate it verifies `phase=provider_resuming`, the reconstructed session and its exact launch binding, both current attempt IDs, `provider_action_state=not_started`, exact provider identity, and the typed current disengaged kill-switch generation. It durably commits `provider_action_state=submitting`, performs the mandatory immediate kill-switch recheck, then atomically admits one fully encoded command buffer to the session priority-input queue. A failure proven before queue admission, including a failed immediate recheck, commits `failed_pre_action`; after any bytes may have been admitted, it can only commit `admitted` or `unknown`. On full admission it durably commits `provider_action_state=admitted` before returning `RecoveryProviderAccepted`; this acknowledgement means host queue admission, not provider readiness. A retry requires a fresh `begin_attempt=resume` and is allowed only from `failed_pre_action`.

Every session has one host-owned `session_action_gate`; recovery-bound sessions share that same gate with their operation/stable-tab index rather than having an independent lock. The order is `kill_switch_action_gate` when required, then `spawn_lock` when required, then one or more `session_action_gate`s in ascending numeric session ID, then `commit_lock -> persist_lock -> entries -> layout -> safety_state -> graveyard`. No path acquires an outer action/spawn gate while holding `commit_lock` or an inner lock. `CreateSession` holds the new-session/stable-tab launch gate through process creation and durable registration. `StartManagedProvider`, `StartRecoveryProvider`, structured-bridge creation, structured evidence handling, and `SubmitRecoveryInput` hold the bound session gate continuously from validation through durable pre-action state, exact queue/process boundary where applicable, and durable outcome classification; managed initial launch, recovery resume, structured-bridge `CreateProcessW`, and continuation admission additionally hold `kill_switch_action_gate` as specified above. All action-state commits use the same safety-state commit helper and emit the complete `SafetyStateChanged` event.

`CloseSession` first acquires that session gate, so any in-flight host action reaches a durable classified outcome before close can mark the session `closing`; after that transition no new action can validate. While holding the gate, close applies these rules atomically with the graveyard commit: `submitting|unknown` provider/launch/send outcomes block close as `close_action_ambiguous`; `structured_bridge_state=creating_suspended|active` first invokes the shared bounded cleanup, `unknown|containment_uncertain` forces a `close_uncertain` teardown record carrying the exact bridge identity, and only `not_required|closed|failed_pre_action`, or `not_started` under the exact zero-attempt/no-identity predicate below, permits ordinary cancellation/final close. For `not_started`, close requires `structured_bridge_attempts=0`, absent `current_structured_bridge_attempt_id`, no pending structured evidence, absent `structured_bridge_process`, and no channel/pipe/Job ownership ever created; it invokes no bridge cleanup. In the same graveyard commit that marks the session closing, it durably completes that exact pre-bridge operation `cancelled` with reason `session_closed`, clears the matching recovery record `pending_operation_id`, and emits the one combined safety/lifecycle commit sequence without creating a retry or bridge identity. An operation with `send_state=accepted` may already complete as recovered after bridge cleanup; any other admitted pre-continuation operation is durably completed `cancelled` with reason `session_closed`; and a managed initial provider record is marked intentionally interrupted/unrecoverable rather than recoverable from an accidental crash. Close then retains the gate through teardown/final-close or durable `close_uncertain`. Host shutdown acquires all session gates in ascending order before its final shutdown gate; preparation/finalization fails if any external action is in flight, any action/send state is `submitting|unknown`, any structured bridge is `creating_suspended|unknown|containment_uncertain`, or any nonterminal operation has `send_state=accepted` rather than first completing `recovered`. An `active` bridge is explicitly listed for shutdown cleanup and must reach durable `closed` or transfer into an uncertain teardown owner before runtime ownership can be released. Confirmed restart is refused while any recovery operation is nonterminal; it therefore never destroys a shell underneath an in-progress operation or pretends to preserve a journal whose process/bridge actions cannot be recreated. Explicit Quit prepares the exact set of remaining nonterminal operations, all of which must have `send_state=not_started`; only the final authorized `Shutdown` transaction, after required bridge cleanup, durably completes that exact set as `cancelled` with reason `explicit_quit` immediately before entering the exit gate. Thus close/shutdown never tears down a queue or process underneath an unclassified external action.

`PrepareShutdown` is a read-only host transaction performed under `commit_lock`. For ordinary `explicit_quit|explicit_restart`, it first requires `unregistered_containment_records` to contain no `armed|containment_uncertain` record; final authorization and `Shutdown` recheck the same invariant, and unresolved host-level containment returns `containment_uncertain` without preparing, consuming authorization, entering the exit gate, or releasing runtime ownership. The sole exception is `action=repair_reset` on the diagnostic `repair_required` host defined in sections 8.3 and 13.3: that exact host-release transaction may prepare/finalize/authorize/execute despite unresolved unregistered records because it performs no storage, containment, session, or safety mutation. It preserves every record byte-for-byte and exists only to release the diagnostic listener/runtime and ordinary UUID mutex so the separate native StorageRepair transaction can acquire exclusive authority. Its complete affected-operation set is action-specific and never renderer-selected: for `explicit_quit`, every nonterminal recovery operation is affected and preparation is refused unless each has `send_state=not_started`, no launch/provider action in `submitting|unknown`, and no structured bridge in `creating_suspended|unknown|containment_uncertain`; an `active` bridge is permitted only because final authorized shutdown will synchronously clean it before cancellation/exit; for `explicit_restart`, preparation is refused with `recovery_in_progress` if any recovery operation is nonterminal, regardless of whether it is currently bound to a live session; its affected-operation set is therefore empty and no recovery journal/bridge cleanup is part of restart; terminal operations remain history only; for `repair_reset`, the set is empty because repair mode exposes no canonical live recovery operations. No retained terminal operation is included merely for history. The host constructs the complete `ShutdownPreviewV1` from that exact canonical host/safety/session snapshot, sorts `sessions` by numeric session ID and `affected_operation_ids` by UUID byte order, serializes the typed preview with RFC 8785/JCS using the normative canonical JSON rules at the start of section 7, and computes `preview_hash=SHA-256(canonical UTF-8 bytes)`. It creates a short-lived in-memory pending preparation keyed by host-generated preparation/confirmation IDs, reason/action, hash, host instance, prepared safety revision, affected-operation list, expiry, and the exact allowed confirmation-commit sequence; no client supplies or modifies those fields. `ShutdownPrepared` returns that exact preview and matching `ShutdownPreparationV1`. React renders only the returned typed preview and uses the returned confirmation/hash/affected values when storing `ConfirmationV1`; it never recomputes the affected set.

A pending preparation is not invalidated by its exact action-specific confirmation commit. `explicit_quit` and `explicit_restart` permit exactly one `StoreConfirmation` whose content matches the preparation and permit no operation references or pre-finalization cancellation mutations. `repair_reset` uses the in-memory confirmation created by repair preparation and permits no safety commit or operation reference. Under `commit_lock`, the host records the one allowed successful safety revision as a preparation advance. Any other safety mutation, session/lifecycle commit, host-instance change, extra/different confirmation, or expiry invalidates it immediately. `FinalizeShutdownPreparation` is permitted only after the exact expected sequence is complete; it recomputes the full affected set and requires that the current safety revision equals the last allowed preparation revision. For `explicit_quit`, it verifies every affected operation is still nonterminal, exactly matches the prepared ID set, has no external action in flight, has no structured bridge in `creating_suspended|unknown|containment_uncertain`, and has `send_state=not_started`; an `active` bridge remains explicitly bound to the final shutdown cleanup and is not yet closed or cancelled. For `repair_reset`, the expected sequence is empty and finalization verifies the unchanged prepared revision plus the exact in-memory repair confirmation and the unchanged complete unresolved-containment field; unresolved records are allowed only by this diagnostic-release exception and cannot be removed, resolved, pruned, or reclassified by shutdown. It then returns a `ShutdownAuthorizationV1` bound to that resulting pre-cancellation revision, exact affected set, and a fresh native approval nonce. Preparations expire after five minutes and final authorizations expire at the same deadline or after one use. `CancelShutdownPreparation` is non-destructive and may be called with bearer authority by the UI before native approval, or by Tauri after the native dialog returns cancel. It is allowed in `repair_required` for the exact active repair preparation. Under `commit_lock` it invalidates the matching pending/finalized transaction and every unused native-read/approval nonce, returns idempotent success for the same already-cancelled preparation, and changes no session, operation, record, revision, or event cursor. Cancellation after native approval or after `Shutdown` consumption is rejected as `shutdown_already_authorized`. Once cancellation/expiry leaves no live transaction reference, any durable shutdown confirmation becomes eligible for the action-specific retention sweep.

The ordinary bearer-authenticated WebSocket authority is intentionally insufficient for shutdown. After `ShutdownPreparationFinalized`, React invokes the narrow native `ConfirmShutdown { authorization }` bridge command. Tauri opens a separate short-lived authenticated native connection, generates a fresh random `native_read_nonce`, computes `authorization_hash=SHA-256(JCS(authorization))`, and sends `GetFinalizedShutdownPreparation` with `native_read_mac=HMAC-SHA-256(shutdown_authority_key, "termx-finalized-read-v1" || JCS(FinalizedShutdownReadV1))`. The host verifies that MAC in constant time, rejects a reused nonce until the preparation expires, loads the still-live finalized transaction by the exact preparation/confirmation IDs, requires `authorization_hash` to match its finalized authorization, and returns its stored immutable `ShutdownPreviewV1` plus exact `ShutdownAuthorizationV1`; neither is accepted from React as display data. Tauri verifies that the returned authorization byte-for-byte/JCS-equivalent matches the authorization supplied to `ConfirmShutdown` and that `SHA-256(JCS(preview))` equals `authorization.preview_hash`. It then presents a native OS confirmation dialog containing the canonical reason/session/operation counts and preview hash suffix, and proceeds only from an actual affirmative native dialog result. It computes `native_mac=HMAC-SHA-256(shutdown_authority_key, "termx-shutdown-v1" || JCS(authorization))` and sends `AuthorizeShutdown`. The host verifies the MAC in constant time, the exact finalized authorization, the action-appropriate durable or in-memory confirmation, and the current transaction state, then marks only that authorization `native_approved` and returns `ShutdownAuthorized`. The native key is never available to React; a remote or arbitrary bearer-authenticated WebSocket client therefore cannot retrieve or authorize shutdown through bearer authority alone. Tauri capabilities expose this command only to the packaged local main window, and the native dialog is the final human-authority boundary even if renderer JavaScript is compromised.

`Shutdown` is accepted only when its authorization matches a still-live, finalized, `native_approved` host-generated authorization; the same-ID/action/hash/affected confirmation exists in durable `SafetyStateV1` for `explicit_quit|explicit_restart` or in the still-live in-memory repair transaction for `repair_reset`; `reason=quit` maps to `action=explicit_quit`, `confirmed_restart` maps to `explicit_restart`, and `repair` maps to `repair_reset`; and the current host instance, authorization’s pre-action safety revision, recomputed complete affected set, and—when action is repair reset—the complete unresolved-containment field still equal the finalized transaction. Otherwise the host returns `recovery_approval_required` or `safety_state_conflict` without consuming authorization or entering the shutdown gate. Thus an authenticated client cannot invoke a destructive shutdown merely by choosing a reason, completing the ordinary prepare/store flow, or fabricating a confirmation record; it must complete the exact one-use host transaction through native human authorization.

After all session gates are held and the authorization is revalidated but before the exit gate becomes visible, final `Shutdown` first stops evidence admission and, for `explicit_quit`, runs the shared exact bridge cleanup for every prepared operation with an `active` bridge. `explicit_restart` has no nonterminal operation and therefore no recovery bridge to clean; ordinary terminal sessions are handled by the later terminal-session/Job shutdown. Quit retains the now-signaled exact process/zero-accounting Job handles until the following durable commit succeeds. Any timeout or uncertain proof aborts shutdown, transfers the identity to the appropriate uncertain teardown owner when required, and never releases runtime ownership. The host then constructs at most one safety-state candidate: for `explicit_quit`, it both marks every cleaned bridge `closed`/clears its identity and completes every exact prepared affected operation as `terminal/cancelled`, preserves `send_state=not_started`, sets safe reason `explicit_quit`, host-generates one shared commit timestamp, clears matching record `pending_operation_id` values, and changes no operation outside the prepared set; for `explicit_restart`, it changes no operation or bridge but atomically marks each preview-listed live managed recovery record `status=recoverable`, clears its live `terminal_session_id`/`host_instance_id`, preserves its exact shell/provider/conversation binding, leaves `pending_operation_id` absent, and records one shared interruption timestamp/reason `explicit_restart`; `repair_reset` has no safety candidate. This pre-exit recoverable classification cannot launch anything while the old host owns runtime state, and Tauri still requires exact host/runtime/mutex release plus the section-13.3 no-old-tree proof before publishing a bootstrap. If the candidate differs from current safety state, the host persists it as one ordinary safety commit, installs `safety_revision=current+1`, allocates one event cursor, and emits one full `SafetyStateChanged`. Only after that durable commit succeeds (or no commit was needed) may it close retained bridge ownership handles, atomically consume the authorization, and enter the noncanonical shutdown gate. Persistence failure leaves operation state unchanged and authorization retryable until expiry; already terminated bridges remain represented by their old active identity with handles retained, so retry/startup reconciliation can prove and durably close them without relaunch. It emits no event and does not shut down. If the host crashes after an explicit-quit safety replacement but before in-memory authorization consumption or process exit, the durable terminal cancellations/bridge closures remain authoritative but the finalized/native-approved transaction is lost with the old host instance and can never authorize the replacement. Discovery reports that Quit did not complete; the user may prepare a new Quit, while the cancelled operations are not reconstructed or replayed. This is a safe crash prefix because native approval already authorized their cancellation, but it never claims the old non-durable shutdown gate completed.

`ShutdownAccepted` means the in-memory shutdown gate has committed under `commit_lock`, no new mutation can commit, and all previously acknowledged durable writes plus the action-specific final safety commit are flushed. The gate records one host-lifetime `shutdown_persistence_epoch` while still holding `commit_lock`; every complete-state writer, observed-fact persistence path, layout/safety/lifecycle mutation, and delayed callback must compare that epoch under the same lock immediately before candidate construction and again before replacement. A path that linearized before the shutdown epoch completes before the final shutdown candidate is constructed and is included in it. A path that observes or loses a race to the epoch returns `shutting_down` when request-correlated, or suppresses its persistence/event when it is a late observed callback; it may perform connection-local cleanup only. After the epoch commits, no teardown, forwarder, reader, exit observer, layout debounce, or generic `persist_logged` path may write another complete `StateV2`. Terminal-session/Job cleanup therefore cannot rebuild state from a drained registry or overwrite the retained final session metadata. Repeated Shutdown joins/returns the one accepted outcome and creates no second candidate.

`final_safety_revision` is the revision after that optional commit; explicit restart therefore reports the revision containing its durable managed-record recoverability classification. The shutdown gate itself is not a canonical persisted domain, does not independently increment a revision or event cursor, and emits no lifecycle event because the accepted host is intentionally exiting. It does not mean the process has exited or runtime discovery is released. Active structured bridges have already reached exact zero-process proof and durable `closed` before this acknowledgement. The host then performs the remaining five-second terminal-session/Job cleanup deadline. If cleanup succeeds, it removes only its owned runtime record, releases the mutex, and exits zero. If cleanup is uncertain or times out, it writes `shutdown-uncertain.json` with safe process/session identity, leaves its owned runtime record unchanged and the mutex held, releases no ownership claim, and remains alive in a diagnostic-only state long enough for explicit inspection rather than starting a replacement over possible descendants. Tauri closes the socket and separately waits for the exact host process handle to signal and the owned runtime record/mutex to disappear. The native wait returns exactly `released|timeout|ownership_uncertain`: `released` requires the exact host handle signaled, the owned runtime record absent, and the mutex acquirable; `timeout` means the deadline expired with consistent still-owned evidence; `ownership_uncertain` means the observations conflict or cannot be verified. Only `released` permits Quit-complete or replacement. The other results yield `manual_intervention_required` and never start recovery.

Canonical state changes arrive through the global event stream or a fresh snapshot. For mutations that define a canonical event, the acknowledgement is enqueued after the corresponding committed event has been sequenced; clients may receive either wire frame first because control/event lanes share one writer arbiter, but reducers change canonical state only from the event. `Detach` changes only per-connection attachment state. `Shutdown` has no event for its noncanonical exit gate. `explicit_quit` may bundle the specified canonical bridge-closure/cancellation commit and `explicit_restart` may bundle the specified managed-record interruption/recoverability commit; either emits its ordinary `SafetyStateChanged` before `ShutdownAccepted`. `repair_reset` changes no safety state.

Each connection maintains an attachment map keyed by session ID and generation, with `pending|active` state. `Attach` installs a pending entry during its ordered handshake and atomically activates it under the shared connection-state gate before `Attached` can physically leave the writer. `Detach`, connection cleanup, replacement, and close remove only the matching generation. Input remains a binary frame and is accepted only when the map contains an active generation for the session. Otherwise the host drops the binary payload and sends structured `not_attached` for the session.

Protocol v2 retains the M1 binary framing exactly: output is tag `0x01`, little-endian `session_id: u32`, little-endian authoritative `offset: u64`, then payload bytes; input is tag `0x02`, little-endian `session_id: u32`, then payload bytes and carries no offset. Decimal-string encoding applies only to JSON, not these fixed-width binary fields. Malformed tags or undersized frames produce structured `invalid_request`; oversized input produces `input_too_large`.

### 7.6 Attach, replay, and live ordering

For:

```text
Attach { request_id, session_id, replay }
```

the host:

1. Aborts and awaits the connection’s prior forwarder for that session.
2. Creates a bounded live-output receiver before taking the ring snapshot. Every published `OutputChunk` carries its authoritative start offset, and the receiver begins buffering immediately under the existing bounded-broadcast lag semantics.
3. Captures `ring_start` and `stream_end` from one ring snapshot, then sets the forwarder cursor to exactly `stream_end`. All byte intervals are half-open: ReplayChunk covers `[start_offset, end_offset)`, `replay_end` is the first byte not included in initial replay, `stream_offset` is the next expected live-byte offset after `Attached`, and a binary output frame at offset `N` covers `[N, N + payload_len)`.
4. If `replay=true`, enqueues sequential replay fragments for the snapshot interval `[ring_start, stream_end)`. If `replay=false`, enqueues none; `replay_end` still equals `stream_end`, so bytes before attachment are intentionally skipped rather than lost ambiguously.
5. Installs a `pending` attachment-map entry containing the captured session generation and input gate closed.
6. Enqueues correlated `Attached` with `replay_end=stream_end` and `stream_offset=stream_end`; if enqueue fails, removes the matching pending entry and aborts the forwarder.
7. In the same connection-state critical section after successful enqueue, changes that exact generation to `active` and opens its input gate. The writer cannot physically transmit `Attached` until the critical section is released, and binary-input dispatch acquires the same state gate, so input observed after `Attached` can never see the entry as absent/pending. Replacement, detach, close, or connection cleanup removes only the matching generation.
8. Drains the already-subscribed live receiver through the same arbiter. It discards chunks ending at or below the cursor, trims any prefix below the cursor, requires the next remaining byte to start exactly at the cursor, emits it, and advances the cursor. If the first available chunk starts above the cursor or the receiver reports lag, it does not forward later bytes: it performs the lagged-replay path from the authoritative ring starting at the cursor. Ring eviction may advance the replay start and is surfaced with the normal visible truncation semantics.

Subscription-before-snapshot plus authoritative offset trimming is the atomic cursor handoff: output committed before the snapshot is represented by the ring through `stream_end`; output committed after it is present in the subscribed receiver at or beyond `stream_end`; a chunk racing the snapshot may appear in both and is trimmed, and a gap triggers replay rather than byte loss. Ring mutation assigns the chunk offset, appends the bytes, advances `stream_end`, and publishes the same `OutputChunk` under one session output-sequencer critical section; snapshot capture reads the ring bounds under that sequencer. There is therefore no state in which `stream_end` includes bytes that are in neither the captured ring nor the pre-existing receiver.

Replay fragments use:

```text
ReplayChunk {
  request_id: RequestId?,
  session_id,
  replay_id: UUID,
  chunk_index: u32,
  final_chunk: bool,
  start_offset: U64DecimalString,
  end_offset: U64DecimalString,
  data_b64: string
}

Attached {
  request_id,
  session_id,
  replay_id?,
  ring_start: U64DecimalString,
  replay_end: U64DecimalString,
  stream_offset: U64DecimalString
}
```

Each decoded replay chunk is at most 512 KiB. Base64 plus JSON must remain below the exact 1 MiB WebSocket message and frame caps. The full ring remains at most 8 MiB decoded. One connection may hold only one 512 KiB decoded replay chunk, one encoded chunk, and one replay cursor at a time; chunks are generated and acknowledged to the writer sequentially rather than materializing the whole base64 replay.

The writer arbiter has one ordered outbound enum covering direct responses, lifecycle events, Replay chunks, `Attached`, and binary output. It preserves enqueue order within a connection and byte-accounts the fully serialized WebSocket frame before enqueue. Each physical socket write has a 10-second deadline. A timeout, peer that stops reading, or write failure closes the socket, drops the queue and Replay permit, removes hub/attachment registrations, and requires reconnect/resnapshot. Initial Replay chunks therefore precede `Attached`, and no binary frame from the new forwarder precedes `Attached`. `replay: false` sends no initial Replay chunk but still sends `Attached`. A lagged forwarder uses a new replay ID, emits sequential chunks, and orders subsequent binary data after the final chunk.

Attach uses a per-session connection generation. Under the registry commit gate it validates the session and captures its lifecycle generation; immediately before enqueuing `Attached`, it rechecks both. If close commits first, attach returns `unknown_session` and enqueues no `Attached`. If `Attached` is already enqueued first, that attachment is valid for its captured generation; a later `SessionClosed` event causes the client to detach canonically and the forwarder observes closure. There is no undefined attempt to retract an already-enqueued frame.

Global lifecycle events may interleave before or after an attach sequence only at explicit arbiter enqueue boundaries; they never break the Replay-chunk order for one replay ID.

Request IDs are unique per connection. The host keeps a completed-request cache capped at 1,024 entries and 2 MiB serialized, with least-recently-used eviction. It stores only compact acknowledgements/errors and request fingerprints, never Replay chunks, snapshots, layouts, safety-state bodies, or lifecycle events. An exact duplicate mutation returns the cached compact acknowledgement/error and never repeats the mutation; reuse of an ID with different content returns `invalid_request`. Cache retention is an optimization, never the sole idempotency boundary for an externally acting request. `CreateSession` carries both a caller-generated UUID and the caller-observed `creation_sequence` from `StateV2.next_creation_sequence`. Under `kill_switch_action_gate -> spawn_lock -> commit_lock`, the host resolves the canonical `SessionCreationIdentityV1`. If the sequence equals `next_creation_sequence`, it durably appends `SessionCreationReceiptV1(state=reserved)`, increments `next_creation_sequence`, and only then may cross the process-creation boundary; persistence failure creates nothing. A matching request with a lower consumed sequence reconciles the retained receipt/session. The host requires each sequence to have at most one durable receipt/session identity; duplicate ownership or a receipt/session hash mismatch fails startup before listener publication as `session_creation_reconciliation_failed`. If the receipt was pruned, the durable high-water mark still proves consumption and the host returns `action_reconciliation_required` without acting; a reused sequence with a retained different ID/hash is `invalid_request`. A sequence above the current next value is `safety_state_conflict`. Therefore receipt pruning cannot turn an old request into a new process creation. After durable reservation, the uninterrupted live host may commit `failed_pre_action` only when its still-live spawn guard proves the OS process-creation call was never entered; a caller may deliberately retry only the exact same sequence/ID/hash from that state. Once process creation may have occurred, the receipt becomes `created` with session/generation and `session_disposition=present` in the same registration commit or `unknown`. Because a crash destroys the volatile spawn guard, every durable `reserved` receipt found at startup becomes `unknown` before listener publication; startup never infers pre-action failure from missing registry/process evidence. `unknown` is never retried automatically or manually. The UUID, sequence, and identity hash are stored in `SessionInfoV2`/`PersistedSessionRecordV1`. While that exact generation remains in live, exited, or teardown state, an exact created duplicate returns the one canonical session/generation, while a different identity returns `invalid_request`, including after completed-request eviction or host restart. Final `SessionClosed` removes the session generation but retains or updates the matching receipt as `created` without a live session reference until ordinary receipt pruning; an exact duplicate in that state returns `action_reconciliation_required` with reason `session_already_closed` and never creates a replacement. Thus a created receipt never promises resurrection after canonical close. Creation receipts have a hard cap of 1,024 entries and 256 KiB canonical JSON, with retention targets of 896 entries and 192 KiB. A `created` receipt is protected and cannot be pruned while its referenced `(session_id,lifecycle_generation)` exists in the active/live registry, exited `last_sessions`, or `teardown_graveyard`; a live `reserved` receipt is also protected. Final close preserves the receipt identity, creation sequence/hash, and lifecycle generation, sets `state=created` and `session_disposition=closed`, and may omit `session_id` or retain it only as historical metadata. That closed receipt becomes eligible for ordinary pruning only under the normal retention policy.

Before reserving a new sequence, the host constructs the complete candidate including every protected receipt, then deterministically prunes only non-protected, non-`reserved` receipts in `(updated_at ascending, creation_sequence ascending)` order until the retention targets are met. If the protected set plus the candidate cannot fit either hard cap, creation fails as `session_creation_receipt_capacity` before sequence increment, process creation, durable mutation, or event. If a `created` receipt is absent after allowed pruning or historical migration, the host searches durable `PersistedSessionRecordV1` and `TeardownRecordV1.session` values for the exact `creation_sequence`, `creation_id`, `creation_identity_hash`, and `lifecycle_generation`. Exactly one match returns the canonical existing-session/generation metadata and never creates a process. No receipt and no matching durable generation returns `action_reconciliation_required`; the high-water mark proves only that the sequence was consumed, not that a session exists. Multiple matches or any receipt/session identity mismatch is `session_creation_reconciliation_failed` and blocks listener publication at startup where applicable. A pruned `failed_pre_action|unknown` remains non-executable because its sequence is below the durable high-water mark and has no authoritative retry receipt. `StartManagedProvider` is durably keyed by stable tab plus its host-generated current initial-launch attempt ID, recovery shell/provider actions by operation plus current attempt IDs, continuation by operation/submission journal, close by lifecycle generation, and shutdown by its one-use authorization. After cache eviction, any externally acting request that cannot prove from those durable identities that it is the same admitted action returns `action_reconciliation_required` and performs no process creation, queue admission, termination, repair, or shutdown. `Attach` idempotency is handled by a per-session attachment generation: an exact duplicate completed Attach returns the cached compact `Attached` metadata but does not replay bytes again; a timed-out client reconciles through local attachment state or performs `Detach` followed by a new request ID. Lagged Replay chunks are unsolicited and carry `request_id: null` plus a new replay ID.

### 7.7 Layout compare-and-swap

`SetLayout` contains:

```text
SetLayout {
  request_id,
  expected_revision,
  layout
}
```

On success the host:

1. Persists the candidate atomically as revision `N + 1`.
2. Installs it as committed state.
3. Emits one `LayoutChanged` event.
4. Returns `LayoutSaved` with the new revision.

A stale writer receives `layout_conflict` with the canonical current revision and layout. The host does not merge opaque layout JSON.

React retains the pending semantic layout operation and rebases it onto the canonical layout. It does not blindly overwrite the conflict response. The UI shows a conflict notification and provides undo for the retained local operation when appropriate.

The host rejects a serialized layout document larger than 512 KiB with `layout_too_large`; the candidate is measured as UTF-8 JSON before persistence. The host treats layout fields as opaque for product semantics and merge behavior, but a shared versioned `termx-layout-schema` package owns structural validation and migration. Rust validates generated JSON Schema invariants at the persistence boundary; TypeScript uses the same fixtures and schema for editing. The host does not invent names, groups, colors, or merge policy.

### 7.8 Safety-state CRUD and compare-and-swap

Recovery and Settings use typed protocol operations rather than mutating the opaque layout:

```text
GetSafetyState { request_id }
SafetyState { request_id, host_instance_id, event_cursor, revision, safety_state }
CommitSafetyState {
  request_id,
  expected_revision,
  mutations: [SafetyMutation]
}
SafetyStateCommitted { request_id, revision }
```

The exact mutation variants are:

```text
SafetyMutation =
    SetSettings { settings: SettingsV1 }
  | DeleteRecoveryRecord { stable_tab_id }
  | DeleteRecoveryOperation { operation_id: UUID }
  | TransitionRecoveryOperation {
      operation_id,
      expected_phase,
      expected_send_state,
      next_phase,
      next_send_state,
      begin_attempt?: launch|resume,
      set_reconstructed_terminal_session_id?: u32,
      confirmation_id?,
      last_safe_error?
    }
  | CompleteRecoveryOperation {
      operation_id,
      expected_phase,
      expected_send_state,
      next_send_state,
      terminal_state,
      confirmation_id?,
      last_safe_error?
    }
  | RequestRecoveryCancellation {
      operation_id,
      expected_phase,
      expected_send_state,
      reason_code
    }
  | StoreConfirmation { confirmation: ConfirmationV1 }
  | StorePreparedRecoveryConfirmation { confirmation_id: UUID, confirmed_at: Timestamp }
  | DeleteConfirmation { confirmation_id }
  | SetKillSwitch { engaged, expected_generation: U64DecimalString, reason_code? }
```

`StoreConfirmation`, `StorePreparedRecoveryConfirmation`, and `DeleteConfirmation` are closed `SafetyMutation` variants inside `CommitSafetyState`; they are not standalone WebSocket commands. Their exact semantics are:

- `StoreConfirmation` is allowed only for `explicit_quit|explicit_restart`. The supplied `ConfirmationV1.affected_operation_ids` must exactly equal the sorted host-prepared affected set: every nonterminal operation for `explicit_quit`, and empty for `explicit_restart`; `operation_preview_hashes|prepared_safety_revision` are absent. Under `commit_lock`, the host loads the exact live shutdown preparation and recomputes the action, confirmation/preparation IDs, preview hash, expiry, expected revision, and complete affected set; every supplied value must match and the renderer cannot add, omit, or reorder an ID. `repair_reset` and all `reviewed_*` actions are rejected through this variant. An exact duplicate is idempotent success; reuse of a confirmation ID with different content is a conflict.
- `StorePreparedRecoveryConfirmation` is allowed only for the five `reviewed_*` actions. The client supplies only the host-issued `confirmation_id` and canonical `confirmed_at`. The host reloads the live preparation template, reconstructs the complete `ConfirmationV1`, recomputes the sorted affected-operation IDs, operation hashes, batch preview hash, prepared safety revision, and current eligibility, and commits only that host-derived object. The client cannot supply a preview, affected set, revision, or operation hash.
- `DeleteConfirmation` is publicly allowed only for reviewed confirmations after every affected operation is terminal and no operation, pending bootstrap/tombstone, native preparation/authorization, or teardown repair references it. The same commit unlinks the ID from all affected terminal operations and deletes the confirmation. Explicit shutdown confirmations are removed only by the host’s deterministic expired/inactive shutdown sweep, never renderer deletion. Repair mode rejects every `CommitSafetyState` mutation.

`CommitSafetyState` requires `request_id: RequestId`, `expected_revision: U64DecimalString`, 1..=1,024 mutations, and at most 512 KiB serialized request bytes. The expected revision must equal the installed safety revision. The host validates the complete candidate before persistence; success atomically persists and installs the candidate, increments the revision once, sequences one full `SafetyStateChanged`, and returns `SafetyStateCommitted { request_id: RequestId, revision: U64DecimalString }`. Persistence failure changes no memory, revision, cursor, event, or durable state. Request-ID plus canonical request fingerprint deduplicates response handling, while durable confirmation IDs are the authoritative idempotency boundary after completed-request-cache eviction. The singleton `SetKillSwitch` dispatch rule below remains stricter than these generic mutation semantics.

Operation IDs, stable-tab IDs, and confirmation IDs are unique keys. Store conflicts on an existing ID with different content; an exact duplicate is idempotent success. Recovery-operation creation is not a `SafetyMutation` and never accepts `RecoveryOperationV1`. `CreateRecoveryOperation` accepts only `RecoveryOperationDraftV1`; under `commit_lock` the host loads the current qualified record and settings, rejects an existing nonterminal operation for the stable tab, generates or validates the draft’s idempotency identity, and constructs the entire canonical `RecoveryOperationV1`. It derives and stores the immutable execution binding, `execution_binding_hash=SHA-256(JCS(execution_binding))`, canonical `RecoveryActionPreviewV1`, `preview_hash=SHA-256(JCS(action_preview))`, source session, continuation fingerprint/byte count, effective mode, deadline, timestamps, and kill-switch observation. It always initializes `phase=planned`, launch/provider/send states to `not_started`, `structured_bridge_state=not_started` only when the effective mode’s canonical action preview contains `await_structured_readiness|await_structured_acceptance` and the adapter is currently qualified, and `not_required` for Manual or any operation whose selected capabilities are exclusively human/unsupported; `structured_bridge_process` is absent, all three attempt counters are zero, `cancellation_requested=false`, and all terminal state, reconstructed-session, current-attempt (including structured-bridge attempt), submission, evidence, error, and confirmation fields absent/empty. No request or bootstrap field can select a later phase, action state, send state, counter, attempt ID, submission ID, evidence, confirmation reference, timestamp, or deadline. The constructor persists the operation and matching record `pending_operation_id` in one safety commit before returning it.

Every recovery-bound shell launch, provider resume, structured-channel setup, continuation encoder, and evidence verifier derives exclusively from `operation.execution_binding` and its canonical action preview, never from a later mutable record lookup. There is no public complete-record upsert. `StartManagedProvider`, `RegisterRecoveryIdentity`, lifecycle/reconciliation logic, and bootstrap import are the only record-creation/update paths, and each constructs/canonicalizes host-owned fields rather than accepting `RecoveryRecordV1` as wire input. While any operation for a stable tab is nonterminal, `RegisterRecoveryIdentity` and `DeleteRecoveryRecord` are rejected if they change/delete any execution-binding field, capability evidence, qualification hash, or conversation identity; host-owned lifecycle/status/session/pending-operation metadata may advance only through their specified internal commit paths. After terminal completion, identity registration affects only future operations and requires a new preview/hash. Transition, completion, and cancellation request are per-operation CAS operations and must satisfy the host-owned transition table. `DeleteRecoveryOperation` is permitted only for a terminal operation and is rejected while the operation is referenced by any retained confirmation, pending/restart shutdown preparation, unresolved recovery bootstrap or tombstone reconciliation, pending structured-evidence receipt, record `pending_operation_id`, native finalized preparation, or teardown record for the same stable-tab/session lifecycle (including a moved structured bridge identity). A persisted `StructuredRecoveryEvidenceRefV1` is part of the operation rather than a separate retained object and is removed with an otherwise eligible operation; the bounded completed-evidence deduplication cache may retain only its UUID/fingerprint until ordinary expiry. Deletion atomically clears any matching terminal record pointer and removes the operation in one safety commit; it never deletes retained confirmation/preparation objects implicitly.

`TransitionRecoveryOperation` is the only client mutation that advances one active phase or nonterminal send state. It cannot set `next_phase=terminal`. `begin_attempt=launch|resume` is permitted only on the transition immediately before that classified external action; the host atomically increments only the selected stored `u16` counter and generates a fresh host-owned UUID in `current_launch_attempt_id` or `current_resume_attempt_id` while committing the transition. The initial launch/resume consumes attempt 1 (`0 -> 1`). Retry settings remain bounded `u8`, while all persisted attempt counters and caller-observed expected attempt counts are `u16`; therefore `max_*_retries=255` yields a representable maximum of 256 total attempts without overflow. `max_launch_retries=N` and `max_resume_retries=N` allow at most `1 + N` total attempts, so the host rejects a begin-attempt transition when the selected counter is already `1 + N`. The coordinator waits until the resulting `SafetyStateChanged` revision is installed, then uses that exact attempt ID in the external action request. A launch begin-attempt resets `launch_action_state` from initial `not_started` or prior `failed_pre_action` to `not_started`; a resume begin-attempt does the same for `provider_action_state`. No other prior action state permits another begin-attempt. A retry may begin only after a classified, durably recorded failure proven to have occurred before process creation or provider-command admission; a fresh attempt ID supersedes the prior one. Send attempts have no analogous counter and are never retried. `set_reconstructed_terminal_session_id` is permitted only on the successful launch-result transition to `shell_recreated`, must name the newly created session carrying the exact operation/current-launch-attempt recovery binding, and is immutable afterward.

Structured provider evidence never travels through a public safety mutation and no receipt ID is delivered to React. `StructuredEvidenceSink` runs under the bound `session_action_gate`; after authenticated frame decoding it generates one host-owned UUID, uses it as the pending cache/evidence ID, verifies the complete current operation binding, and directly invokes the same internal transition validator/commit helper used by public `TransitionRecoveryOperation`. Readiness evidence may internally commit only `provider_resuming -> provider_ready` for an operation whose stored `mode=unattended`; in Manual/Reviewed mode a valid readiness frame is audit-only/diagnostic and cannot bypass `awaiting_readiness_confirmation` or a reviewed confirmation. Acceptance evidence may internally commit only `submitting -> accepted` for a structured-qualified Reviewed or Unattended operation whose immutable preview includes `await_structured_acceptance`; otherwise it cannot advance state. The resulting ordinary `SafetyStateChanged` event carries the persisted `StructuredRecoveryEvidenceRefV1`, so the React coordinator observes completion without possessing a capability token or triggering the evidence edge. Human-reviewed edges still use public `confirmation_id` transitions.

The sink-generated UUID is used without translation as the pending cache key, host-normalized `StructuredRecoveryEvidenceV1.evidence_id`, and persisted `StructuredRecoveryEvidenceRefV1.evidence_id`. The provider frame/payload carries no authoritative evidence ID. After authenticated decoding and verification, the sink constructs the normalized evidence object and assigns its generated UUID; any provider-supplied ID-like field is rejected rather than copied. Each pending evidence item is one-use, expires after 30 seconds, occupies at most 64 KiB decoded, and lives in a host-owned cache capped at 128 items and 1 MiB; overflow closes the structured channel and requires Reviewed intervention. The host requires `evidence_fingerprint=sha256(decoded evidence_b64)` and passes the bounded payload plus channel attestation/current immutable operation binding to the registered verifier for the exact adapter ID/version and qualification hash. Both evidence kinds must match the operation ID, provider conversation identity, reconstructed session ID, evidence kind, exact current `current_launch_attempt_id`, `current_resume_attempt_id`, and `current_structured_bridge_attempt_id`, channel nonce binding, and monotonically fresh provider-frame sequence; evidence for a superseded attempt or consumed/expired item is rejected regardless of `observed_at`. Readiness evidence requires `submission_id`, `continuation_fingerprint`, and `accepted_bytes` absent. Acceptance evidence requires all three present and exactly equal the operation’s immutable `submission_id`, `continuation_fingerprint`, and `submitted_bytes`; the provider-specific payload must unambiguously identify acceptance of that same provider request/idempotency identity. An adapter unable to bind those values cannot qualify for Unattended acceptance. `observed_at` is audit ordering only. On successful durable commit the host consumes the pending item, discards raw payload, and retains only the evidence ref; failure leaves or discards it according to one-use/expiry rules but never advances state. Evidence IDs are deduplicated in the bounded completed-request/evidence cache. Plain Claude/Codex adapters cannot produce this evidence.

`CompleteRecoveryOperation` always sets `phase=terminal`, persists the supplied matching `terminal_state`, clears the matching recovery record’s `pending_operation_id`, and never changes attempt counters. Before constructing that terminal candidate, the host requires `structured_bridge_state=not_required|not_started|closed|failed_pre_action` with no retained bridge identity. `not_started` is terminalization-safe only when `structured_bridge_attempts=0`, `current_structured_bridge_attempt_id` is absent, and no bridge process/channel/Job identity was ever persisted; it proves no bridge creation boundary was reached. `failed_pre_action` is permitted only when cleanup already proved no process/Job remains. Otherwise completion first runs the shared cleanup under the session gate, and any `creating_suspended|active|unknown|containment_uncertain` result that cannot reach durable `closed` blocks terminalization. Its `next_send_state` must equal the current send state except for the explicitly allowed `submitting -> unknown` completion as `unknown_send_outcome`; `accepted -> terminal(recovered)` retains `accepted`. It is the exact mutation for manual completion, immediate cancellation, deadline/failure/unrecoverable completion, recovered completion, and reload reconciliation of an ambiguous submit.

`RequestRecoveryCancellation` sets `cancellation_requested=true`, records a safe cancelled error/reason, and changes neither phase, send state, nor counters. Use it only while a pre-send external action is already in flight. The coordinator starts no later action; when that action returns it uses `CompleteRecoveryOperation(... terminal_state=cancelled)`. If no action is in flight and `send_state=not_started`, cancellation uses `CompleteRecoveryOperation` directly. Cancellation is rejected once `send_state=submitting|accepted|unknown`; those states follow their at-most-once outcome rules.

`PrepareRecoveryReview` is a read-only host constructor under `commit_lock`. It validates that every requested operation is currently eligible for the one reviewed action, sorts unique operation IDs by UUID byte order, and builds `RecoveryReviewPreviewV1` with the current safety revision and an item containing each operation’s immutable `preview_hash=SHA-256(JCS(action_preview))`. It returns that preview plus a host-generated confirmation template whose `affected_operation_ids` and `operation_preview_hashes` exactly equal those sorted items, whose `prepared_safety_revision` equals the preview’s `safety_revision`, and whose `preview_hash=SHA-256(JCS(recovery_review_preview))`; the template’s `confirmed_at` is absent until the user acts. React displays the complete stored `RecoveryActionPreviewV1` for every item plus the returned batch action/hash, then supplies only the host-issued confirmation ID and user-action timestamp through `CommitSafetyState` with the sole `StorePreparedRecoveryConfirmation` mutation. The host reloads the still-live bounded template when React sends `CommitSafetyState` containing the sole `StorePreparedRecoveryConfirmation` mutation, rebuilds the exact prepared preview from the template’s action, prepared revision, and sorted item list, verifies its canonical hash and every current operation/hash/eligibility condition, validates the timestamp as a canonical current human-action time, and persists those exact fields plus `confirmed_at` as `ConfirmationV1`. The persisted action, `prepared_safety_revision`, ordered operation/hash list, and preview hash are therefore sufficient to reconstruct and verify the originally prepared `RecoveryReviewPreviewV1` after restart without an in-memory preparation cache. Pending review templates are host-memory-only, expire after 10 minutes, and are capped at 64 templates and 4 MiB serialized in aggregate; preparation returns `recovery_review_capacity` rather than evicting a live template when either bound is reached. Generic `StoreConfirmation` rejects all `reviewed_*` actions and remains only for the separately constructed v2 shutdown confirmation paths; legacy migration stores no v2 confirmation because it begins only after a Manual legacy close and independently proven absence. Expiry or any changed phase/hash/revision before storage requires a fresh preparation. This is the only Reviewed “Submit All” path and permits one confirmation to bind up to 1,024 distinct operations without weakening per-operation review.

`confirmation_id`, when supplied to a recovery transition/completion, must reference a stored confirmation whose reviewed action authorizes the exact edge, whose affected-operation list contains the operation, whose `operation_preview_hashes` has exactly one entry per affected ID with no duplicates, whose `prepared_safety_revision` is present, and whose entry for this operation equals its immutable action-preview hash. The host reconstructs the originally prepared canonical `RecoveryReviewPreviewV1` exclusively from the stored action, prepared revision, and sorted operation/hash list, verifies its JCS batch `preview_hash`, then checks current eligibility only for the operation taking this edge; the prepared revision is historical binding rather than a requirement that the current global safety revision remain unchanged after storage. Other batch members may therefore already have consumed the same confirmation and advanced. A list/map mismatch, a changed action preview for this operation, or an ineligible current phase is rejected. It appends the confirmation ID to each affected operation only as that operation takes the authorized edge. Shutdown confirmations are never attached to recovery operations and cannot substitute for a reviewed recovery confirmation. Both `operation_preview_hashes` and `prepared_safety_revision` are required only for the five `reviewed_*` actions and forbidden for `explicit_quit|explicit_restart|repair_reset`. The exact reviewed action mapping is: `reviewed_launch` on `awaiting_launch_approval -> shell_recreating`; `reviewed_resume` on `awaiting_resume_approval -> provider_resuming`; `reviewed_readiness` on `awaiting_readiness_confirmation -> provider_ready`; `reviewed_continuation` on `awaiting_continuation_approval -> continuation_confirmed`; and `reviewed_acceptance` on `submitting -> accepted`. `explicit_quit`, `explicit_restart`, and `repair_reset` authorize only their separately defined native flows and are never attached to recovery operations. Legacy migration is Manual-close-only and creates no confirmation record. A reviewed recovery confirmation may be deleted only after all affected operations are terminal and no pending bootstrap/native preparation references it. `CommitSafetyState` with the sole `DeleteConfirmation` mutation then atomically removes that confirmation ID from every affected terminal operation’s `confirmation_ids` and deletes the confirmation in the same safety commit, making those operations independently eligible for later deletion/pruning. Shutdown confirmations have separate liveness: `explicit_quit|explicit_restart` can authorize only their exact live in-memory preparation/finalization/native-approval transaction. When that transaction is canceled or invalidated, or its expiry has passed, and no live pending/finalized/native-approved transaction references the confirmation, the host may deterministically delete it regardless of affected-operation terminality; deletion changes no operation because shutdown confirmations are never attached to operations. A deleted or expired shutdown confirmation can never be adopted by a later preparation. At most 256 confirmation records are retained; before rejecting a new record, the host deterministically selects oldest confirmations satisfying their action-specific deletion prerequisites by `(confirmed_at ascending, confirmation_id UUID-byte ascending)` and applies the exact atomic unlink/delete operation where unlinking is applicable. Expired/inactive shutdown confirmations are swept before reviewed confirmations, preventing repeated canceled Quit/restart previews from exhausting the cap. `SetKillSwitch.expected_generation` is a CAS gate equal to the current generation; on success the host persists `generation=current+1` with the requested engaged state and reason. A stale generation returns `safety_state_conflict`. This monotonic generation is used by the final-send gate.

The operation map has an exact hard cap of 1,024 entries, while the complete canonical `SafetyStateV1` retains its stricter 512 KiB hard cap. Before `CreateRecoveryOperation` or bootstrap import would exceed either bound, the host computes the protected-reference set above and deterministically sorts eligible terminal unreferenced operations by `(updated_at ascending, operation_id UUID-byte ascending)`. It constructs the complete candidate state including all requested new operation(s), then prunes oldest eligible entries in that same candidate until both (a) final operation count is at most the retention target of 896 and (b) canonical serialized `SafetyStateV1` is at most the 384 KiB retention-size target, leaving 128 KiB headroom for later non-operation safety changes. Automatic pruning normally retains a floor of 16 terminal operations, but the 512 KiB hard state limit supersedes that floor: if protected/nonterminal state plus 16 terminal operations cannot fit, automatic creation/import fails rather than silently deleting below the floor. If the candidate still cannot satisfy the hard 1,024-entry/512 KiB limits while preserving protected entries and the 16-operation floor, the host returns `recovery_operation_capacity` or `snapshot_too_large` as applicable without changing state. Bootstrap pruning and operation construction are one all-or-nothing commit; the bootstrap is never partially admitted. Manual `DeleteRecoveryOperation` may remove any eligible terminal unreferenced operation regardless of the automatic floor. Tests freeze timestamps, UUIDs, and encoded sizes to prove deterministic survivors, reference protection, count/size targets, floor behavior, and unchanged state on exhaustion.

Every safety-state commit, whether initiated by `CommitSafetyState`, `SubmitRecoveryInput`, structured provider acceptance, or coordinator startup/reload/reconnect reconciliation, uses the same internal durable commit helper: validate, persist atomically, install under `commit_lock`, increment `safety_revision`, allocate the next global event cursor, and emit:

```text
SafetyStateChanged { revision, safety_state }
```

A `CommitSafetyState` mutation batch must contain at least one and at most 1,024 mutations and is limited to 512 KiB serialized. `SetKillSwitch` must be the sole mutation in its batch; a batch containing it plus any other mutation, or more than one `SetKillSwitch`, is rejected as `invalid_request` before candidate construction. Dispatch recognizes the variant before ordinary safety validation, acquires `kill_switch_action_gate`, and retains that gate continuously through expected-generation validation, durable replacement, memory/revision/event installation, and acknowledgement sequencing. No generic `CommitSafetyState` wrapper or fast path may enter the commit chain for a `SetKillSwitch` batch without that gate. The complete canonical `SafetyStateV1` is capped at 512 KiB serialized, so the event body has the same bound. It is charged to each connection’s event/outbound byte budget; clients that cannot hold it are disconnected and resnapshot. Stale writers receive `safety_state_conflict` with the canonical revision and state. The host enforces the section 15.5 operation transition table, including send-state `submitting -> unknown|accepted`, final send-state `accepted`, terminal phase transitions, approval references, selected attempt increments, and the prohibition on any transition out of `unknown`. React cannot use a generic JSON write to bypass those invariants.

Before each external recovery phase, React commits the exact mutation batch and waits for `SafetyStateCommitted`. During dead-host bootstrap import, the replacement host performs the same validation and CAS against the imported base revision before acknowledging ownership.

## 8. UI state and layout schema

### 8.1 Stable logical identity

UI tabs use stable UUIDs independent of numeric host session IDs. This allows a tab to preserve its name, color, group, and order when a dead host session is reconstructed under a new host ID.

Layout schema version 1 contains:

```text
TabId = UUID
GroupId = UUID
ColorV1 = string matching `#[0-9a-f]{6}`

LayoutV1 {
  schema_version: 1,
  active_tab_id?: TabId,
  root_tab_ids: [TabId] <= 4096 items,
  groups: [GroupV1] <= 256 items,
  tabs: { TabId: TabV1 } <= 4096 entries
}

GroupV1 {
  group_id: GroupId,
  name: string <= 512 UTF-8 bytes,
  color: ColorV1,
  collapsed: bool,
  tab_ids: [TabId] <= 4096 items
}

TabV1 {
  tab_id: TabId,
  session_id?: u32,
  host_instance_id?: UUID,
  profile_id: string <= 256 UTF-8 bytes,
  safe_cwd: string <= 32 KiB UTF-8,
  display_name: string <= 512 UTF-8 bytes,
  name_customized: bool,
  color: ColorV1,
  lifecycle: live|exited|interrupted|recovering|unrecoverable|containment_uncertain,
  recovery_record_id?: TabId
}
```

The separately revisioned `SafetyStateV1` contains `SettingsV1`, recovery records, recovery operations, confirmation records, and the kill switch. Safety-state writes never share the 250 ms layout debounce. Layout JSON remains capped at 512 KiB serialized in addition to these cardinality and field bounds.

For migration from arbitrary M1 layout JSON, only an exact fixture-recognized M2 precursor shape is converted. Numeric legacy session IDs map deterministically to UUIDv5 tab IDs under the data-directory instance UUID. Unrecognized layout is quarantined for export/repair; it is not guessed into groups or tabs.

### 8.2 Layout invariants

- Every tab appears exactly once: at root or in one group.
- Missing live sessions remain visible as dead or interrupted tabs.
- Live host sessions absent from the layout are appended as recovered root tabs.
- Reconstruction changes only the host binding and lifecycle state; stable tab identity, name, color, group, and order remain unchanged.
- Unknown or invalid layout fields fail validation and use a visible recovery path rather than silent data loss.

### 8.3 State-file migration, backup, and repair

The exact durable host wrapper becomes:

```text
StateV2 {
  schema_version: 2,
  data_dir_instance_id: UUID,
  next_session_id: u32,
  next_creation_sequence: U64DecimalString,
  session_creation_receipts: [SessionCreationReceiptV1] <= 1024 items,
  layout_revision: U64DecimalString,
  layout: LayoutV1,
  safety_revision: U64DecimalString,
  safety_state: SafetyStateV1,
  last_recovery_bootstrap_import?: RecoveryBootstrapImportWitnessV1,
  last_host_instance_id?: UUID,
  last_sessions: [PersistedSessionRecordV1] <= 4096 items,
  teardown_graveyard: [TeardownRecordV1] <= 4096 items,
  unregistered_containment_records: [UnregisteredContainmentRecordV1] <= 128 items
}

SafetyStateV1 {
  schema_version: 1,
  settings: SettingsV1,
  recovery_records: { StableTabId: RecoveryRecordV1 } <= 4096 entries,
  recovery_operations: { OperationId: RecoveryOperationV1 } <= 1024 entries,
  confirmations: { ConfirmationId: ConfirmationV1 } <= 256 entries,
  kill_switch: KillSwitchV1
}

PersistedSessionRecordV1 {
  schema_version: 1,
  session_id: u32,
  creation_id: UUID,
  creation_sequence: U64DecimalString,
  creation_identity_hash: Sha256Hex,
  stable_tab_id?: UUID,
  recovery_binding?: RecoverySessionBindingV1,
  host_instance_id?: UUID,
  lifecycle_generation: UUID,
  profile_id: string <= 256 UTF-8 bytes,
  safe_cwd: string <= 32 KiB UTF-8,
  shell_launch_binding?: ShellLaunchBindingV1,
  root_pid?: u32,
  root_process_start_time?: ProcessStartFiletime,
  containment_state: assigned|unassigned|unknown,
  job_accounting_fingerprint?: Sha256Hex,
  root_exit_state: running|exited|unknown,
  descendant_state: none_observed|observed|unknown,
  exit_code?: u32,
  last_known_at: Timestamp
}

ProcessIdentityV1 {
  pid: u32,
  process_start_time: ProcessStartFiletime
}

UnregisteredContainmentProofV1 {
  schema_version: 1,
  method: pre_spawn_boundary_not_entered|exact_identity_scan|reboot_native,
  checked_system_boot_time_filetime: ProcessStartFiletime,
  root_absent: bool,
  descendants_absent: bool,
  exact_identity_set_hash: Sha256Hex,
  proof_hash: Sha256Hex
}

UnregisteredContainmentRecordV1 {
  schema_version: 1,
  record_id: UUID,
  creation_id: UUID,
  creation_sequence: U64DecimalString,
  creation_identity_hash: Sha256Hex,
  profile_id: string <= 256 UTF-8 bytes,
  safe_cwd: PortablePath,
  shell_executable_path?: PortablePath,
  shell_executable_sha256?: Sha256Hex,
  observed_root_pid?: u32,
  root_process?: ProcessIdentityV1,
  root_identity_status: exact|unavailable|mismatch,
  job_assignment_state: assigned|not_assigned|unknown,
  job_accounting_fingerprint?: Sha256Hex,
  setup_stage: armed_before_spawn|spawn_returned|root_identity|job_assignment|pty_reader|pty_writer|queue_allocation|thread_start|cleanup|startup_reconciliation|reboot_repair,
  state: armed|containment_uncertain|resolved_absent,
  receipt_state: reserved|failed_pre_action|unknown,
  escaped_descendants: [ProcessIdentityV1] <= 4096 items,
  system_boot_time_filetime: ProcessStartFiletime,
  created_at: Timestamp,
  last_checked_at: Timestamp,
  reason_code: pre_spawn_boundary_not_entered|spawn_boundary_uncertain|process_identity_unavailable|job_assignment_failed|job_assignment_unknown|post_spawn_setup_failed|cleanup_timeout|identity_scan_unavailable|startup_armed_without_identity|reboot_proof,
  proof?: UnregisteredContainmentProofV1
}

BridgeProcessIdentityV1 {
  pid: u32,
  process_start_time: ProcessStartFiletime,
  channel_id: UUID,
  pipe_endpoint_id: UUID,
  structured_channel_binding: StructuredChannelBindingV1,
  structured_channel_binding_hash: Sha256Hex,
  launch_attempt_id: UUID,
  resume_attempt_id: UUID,
  structured_bridge_attempt_id: UUID,
  bridge_executable_path: PortablePath,
  bridge_executable_sha256: Sha256Hex
}

TeardownRecordV1 {
  schema_version: 1,
  session: PersistedSessionRecordV1,
  state: closing|close_uncertain,
  escaped_descendants: [ProcessIdentityV1] <= 4096 items,
  structured_bridge_process?: BridgeProcessIdentityV1,
  system_boot_time_filetime: ProcessStartFiletime,
  close_started_at: Timestamp,
  last_checked_at: Timestamp,
  reason_code?: string <= 128 UTF-8 bytes
}
```

`StateV2.last_sessions` contains only active/exited registry `PersistedSessionRecordV1` values; `teardown_graveyard` contains the mutually exclusive resource-owning closing/uncertain generations. The same `(session_id,lifecycle_generation)` may appear in exactly one collection, and the two collections have a combined hard cap of 4,096 session generations; neither per-field bound permits 8,192 aggregate entries. `PersistedSessionRecord` elsewhere is an alias for that exact versioned type. `last_recovery_bootstrap_import` is a single most-recent exact witness, not a history ledger: the recovery bootstrap mutex and host ownership gate permit a new bootstrap import only after any prior bootstrap has a matching durable tombstone or has been resolved as conflict, so overwriting the prior witness cannot erase an unresolved import proof. Every newly created v2 live-session record requires `host_instance_id`, `root_pid`, `root_process_start_time`, and `job_accounting_fingerprint`. They are optional only for migrated legacy/historical records, which must use `containment_state=unknown`, `root_exit_state=unknown|exited`, and can never independently prove safe recovery. `exit_code` is present only when `root_exit_state=exited`. The Job accounting fingerprint is a non-secret hash of the host instance, session ID, root PID/start time, and Job creation nonce; it allows matching TermX-owned recovery evidence but is not an OS handle that survives host death.

`unregistered_containment_records` is a host-containment domain, not a session, registry, `SafetyStateV1`, teardown, or lifecycle-event domain. Its canonical serialized UTF-8 JSON field has a 512 KiB hard cap, and the sum of all `escaped_descendants` lengths has a 4,096-identity hard cap; each record array has the same per-record 4,096 bound. The complete candidate field is validated before persistence with no truncation, sampling, or partial import. Record IDs, creation identities, and exact process identities are unique; a record must match exactly one `SessionCreationReceiptV1` by creation ID/sequence/hash and must not overlap a created/present session or teardown generation. `state=armed` requires `receipt_state=reserved`, no exact root/descendant identity, and no proof. `state=resolved_absent` requires a proof with `root_absent=true` and `descendants_absent=true`; `containment_uncertain` carries no proof claiming absence. `root_identity_status=exact` requires `root_process`; `unavailable` forbids destructive targeting; `mismatch` preserves the persisted identity and never targets an observed PID unless both PID and creation `FILETIME` match. Only creation-time-verified identities may appear in `escaped_descendants`.

Unresolved `armed|containment_uncertain` records are protected and never pruned. A `resolved_absent` record is eligible only when its receipt is non-reserved and no prepared/authorized/nonterminal StorageRepair plan references it; pruning is deterministic by `(last_checked_at ascending, record_id UUID-byte order)` toward 96 records and 384 KiB before admission is evaluated. The complete protected set plus the proposed candidate is then checked against hard caps. If it would exceed 128 records, 4,096 aggregate descendants, or 512 KiB canonical field bytes, the action fails as `unregistered_containment_capacity` before sequence reservation, spawn, StorageRepair plan/authorization creation, journal consumption, or any durable mutation; Execute rechecks the same exact limits immediately before journal installation. No cap failure may be converted into truncation, sampling, omission, reset, replacement, shutdown success, or diagnostic downgrade, and no unresolved record may be pruned to admit a new spawn or repair. Recognized unversioned migration and truly fresh reset with no valid prior source default this field to `[]`; a valid schema-v2 source must contain it, and schema-v2 restore/adopt preserves its exact validated contents. Restore/adopt may not discard or rewrite unresolved records. Reset is rejected whenever either exact validated source contains an unresolved record. When neither artifact validates, reset may quarantine the complete raw invalid artifacts under its bound journal but never claims those unparsed bytes contained no obligation or that quarantine resolved one; the resulting fresh field is an explicit ownership-unproven reset consequence, not containment proof. If primary and backup are both otherwise valid but disagree about this field, or one schema-v2 source omits it, StorageRepair classifies the observation as ambiguous rather than selecting the copy that loses containment evidence. Native reset cannot publish replacement state over an armed or uncertain record; that obligation must first reach exact `resolved_absent`, including reboot-native proof where required.

The lifecycle `event_cursor` is not durable. It resets to zero whenever a new `host_instance_id` is created, and `last_host_instance_id`/`last_sessions` are historical recovery evidence only.

Migration from the current unversioned M1 wrapper preserves `next_id` as `next_session_id`, sorts legacy sessions by numeric session ID, assigns each a deterministic UUIDv5 `lifecycle_generation` derived from `(data_dir_instance_id, "legacy-lifecycle", session_id)`, and assigns a deterministic migration-only `creation_sequence` beginning at zero plus a UUIDv5 `creation_id` derived from `(data_dir_instance_id, "legacy-session", session_id, lifecycle_generation)`. For the hash-bearing `SessionCreationIdentityV1`, migration uses `origin=legacy_migration`, the preserved profile/cwd, absent stable/recovery bindings, and the legacy dimensions when present or the fixed migration sentinel `initial_cols=80, initial_rows=24` when M1 did not persist them; this sentinel is historical identity metadata and never claims the old PTY dimensions. It stores the resulting `creation_identity_hash`, creates no live-action receipt, and sets `next_creation_sequence` to one greater than the largest assigned value. Thus every migrated historical `PersistedSessionRecordV1` satisfies the v2 schema and no live caller can reuse its consumed sequence as a new action. Migration otherwise preserves the session array as historical `last_sessions`, and treats the existing opaque `layout` as follows: if it validates as `LayoutV1`, preserve it; if it is null or an older recognized TermX shape, apply a deterministic fixture-tested migration; otherwise preserve the original as the quarantine source and enter repair mode rather than discarding it. New revisions start at zero and safety state starts from the documented defaults. The host writes a sibling backup before replacement, and the original remains untouched if migration persistence fails.

Windows replacement uses `ReplaceFileW` when a destination exists and `MoveFileExW` with write-through semantics for first publication, with a same-directory temporary file that is flushed before replacement. The last-known-good backup is replaced only after the new primary has been written and re-read successfully. Temp names are deterministic per writer PID/operation ID and startup classifies leftover temp files without promoting them automatically.

A malformed, unreadable, unsupported-version, or invalid-layout primary is never silently replaced with empty state. Startup attempts the last-known-good backup. If that backup validates before any session exists, the host may start only as the explicit diagnostic `repair_required` host, computes and exposes the bad primary's exact pending-quarantine `ArtifactIdentityV1` plus the exact validated backup `StorageRepairSourceSnapshotV1`, but does not move either artifact; the later native `StorageRepair` transaction chooses and performs every transaction-bound mutation. This diagnostic exception is permitted even when the exact validated backup contains unresolved unregistered-containment records. It holds ordinary host ownership solely to expose bounded read-only repair diagnostics and the exact release transaction; it exposes no live session, provider, bridge, recovery, reconstruction, continuation, or generic mutation surface. The host exposes repair status in `AuthOk`/`GetState`. Persisted `last_sessions` are historical/dead records only and cannot be attached, resized, or closed. While repair is required, ordinary operation permits only `Hello`, `GetState`, and `ListSessions` plus the exact repair-shutdown transaction routed before healthy-primary/generic-mutation and ordinary unresolved-containment publication validation: `PrepareShutdown { reason: repair }`; immediate `FinalizeShutdownPreparation`; optional `CancelShutdownPreparation`; native-MAC-authenticated `GetFinalizedShutdownPreparation`; native-MAC-authenticated `AuthorizeShutdown`; and `Shutdown { reason: repair }`. The in-memory `repair_reset` transaction authorizes only diagnostic-host release; it never authorizes or performs storage mutation. It requires no `CommitSafetyState` or durable `ConfirmationV1`, and no generic safety/session/provider mutation becomes available. Export/open-folder remains read-only. After exact host process, endpoint, runtime record, and mutex release, Tauri must start the separate native storage transaction defined below before restoring the backup or resetting state.

Storage ownership and repair are classified before Tauri exposes any mutation. The ownership file is the same-directory `storage-owner.v1.json`, encoded as exact UTF-8 RFC 8785/JCS with no BOM, surrounding whitespace, or trailing newline:

```text
StorageOwnerV1 {
  schema_version: 1,
  data_dir_instance_id: UUID,
  created_at: Timestamp
}

[M2-SCHEMA-StorageOwnershipClassificationV1]
StorageOwnershipClassificationV1 =
    owned_valid
  | ownership_missing_valid_state
  | ownership_unproven_invalid_state
  | uninitialized_empty
  | foreign_or_orphaned
  | ambiguous
```

For a native StorageRepair entry, Tauri first holds `recovery_bootstrap_mutex`, then acquires `data_dir_preownership_mutex`, re-proves no authenticated live host, no matching live PID/start-time identity, and no reachable recorded endpoint, and classifies the owner, primary, backup, repair journal, authorization ledger, quarantine files, audit directory, runtime, bootstrap, and replacement-attempt evidence in one observation. It then acquires the ordinary UUID mutex when derivable and the exclusive repair/ledger authorities in the section-4.4 order; no dialog, journal, or write occurs after releasing any outer lock:

- `owned_valid`: the ownership file and ACL validate, and every readable valid `StateV2` names that exact UUID. Tauri next acquires the UUID-derived ordinary mutex before repair.
- `ownership_missing_valid_state`: the owner is absent and at least one readable primary/backup is valid; all valid copies name one exact UUID. Only explicit `adopt` is available.
- `ownership_unproven_invalid_state`: the owner is absent, no primary/backup validates, and any state, journal, quarantine, or audit artifact exists. Only explicit destructive `reset` is available; restore/adopt is forbidden and the plan records `ownership_proof=absent` plus every artifact identity.
- `uninitialized_empty`: in the native-storage-repair context, the owner, primary, backup, repair journal, authorization ledger, quarantine files, audit directory, config, runtime, and temporary artifacts are all absent. Only explicit native initialization through `reset` is available.
- `foreign_or_orphaned`: the owner is malformed, ACL-invalid, mismatched with valid state, or an artifact identifies another instance. No mutation is available.
- `ambiguous`: observations conflict, change during classification, or cannot be read sufficiently to prove one prior class. No mutation is available.

`StorageInitializationContextV1 = ordinary_startup|native_storage_repair`. Ordinary startup is evaluated before StorageRepair classification and is entered only when owner, state, backup, repair journal, authorization ledger, quarantine, audit, config, runtime, and temporary artifacts are all absent, no pending native repair exists, and preownership is held. It generates one UUID, acquires the mutex derived from that UUID while retaining preownership, create-new publishes and flushes/re-reads the owner plus ACL first, then publishes exact initial `StateV2` naming that UUID, then config/runtime as applicable. A crash after owner publication but before state may resume ordinary initialization only when the owner remains exact/valid, StateV2 remains absent, and every other listed artifact remains absent; any extra artifact, UUID/ACL drift, or conflict is `ambiguous` and never invokes StorageRepair. Native `reset`, including `uninitialized_empty`, is a distinct explicit confirmed transaction: preparation binds a candidate UUID plus owner/state bytes, acquires the mutex derived from that exact candidate before repair/ledger authority, durably journals, publishes StateV2 first, then owner, and retains the already-held ordinary mutex until all repair authority is released. It never takes the ordinary initializer's owner-first shortcut.

Before ordinary classification, a readable matching nonterminal `state.json.repair.journal` takes precedence. Under preownership and the repair authority, Tauri validates its immutable plan/repair/directory/ledger bindings and resumes that exact transaction; it exposes no new Prepare/Confirm/Adopt/Reset until the journal reaches `completed|cancelled|ambiguous`. Conflicting journal/artifact/ledger observations are ambiguous. Only with no matching nonterminal journal does normal six-way classification run.

No adoption or UUID creation is implicit. `adopt` binds the exact valid `StateV2` identity, its embedded UUID, owner-absent observation, target directory identity, canonical owner bytes/hash, and complete plan hash. `reset` from an owner-absent allowed class generates one candidate UUID during preparation and binds that UUID plus exact canonical owner and fresh-state bytes; generation alone creates no authority or file. Before acquiring exclusive repair or ledger authority, Tauri derives and acquires the ordinary UUID mutex from that exact plan-bound candidate while still holding recovery plus preownership. Native Execute creates the owner only after state publication, using a same-directory create-new temporary, flush/re-read, non-overwriting `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)`, and exact bytes/ACL validation. It retains the already-held mutex through completion and reverse-order repair-lock release before permitting host startup. Owner appearance, disappearance, replacement, UUID/ACL change, directory identity change, or artifact drift becomes `ambiguous`. If neither primary nor backup validates, the host publishes no runtime record or WebSocket listener and Tauri never attempts or fabricates the host shutdown protocol.

The exact logical repair paths are:

```text
primary:              state.json
backup:               state.json.bak
owner:                storage-owner.v1.json
repair journal:       state.json.repair.journal
authorization ledger: state.json.repair.authorization-ledger
ledger temporary:     state.json.repair.authorization-ledger.tmp.<ledger_generation>
repair temporary:     state.json.repair.<repair_id>.tmp
owner temporary:      storage-owner.v1.json.repair.<repair_id>.tmp
primary quarantine:   state.json.quarantine.primary.v1.<repair_id>.<identity.value>
backup quarantine:    state.json.quarantine.backup.v1.<repair_id>.<identity.value>
```

`repair_id` and identity values are lowercase ASCII UUID/hex values. Every generated temporary/quarantine name is strict ASCII and at most 192 bytes; the fixed formulas above produce at most 155 bytes, and any implementation result outside the exact formula or bound is rejected before preparation. Exact generated names are stored in the plan and journal and reused on replay. A destination must be absent; an existing exact same-repair/same-identity artifact is accepted only as crash-prefix evidence. A different artifact is `storage_repair_ambiguous`. Repair target, quarantine, candidate-temporary, and owner artifacts never use `MOVEFILE_REPLACE_EXISTING` and never overwrite an unrelated artifact. The generation-numbered authorization-ledger install is the sole exception: after exact prior-generation validation it atomically replaces only the ledger path using the separately specified `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH` transaction.

```text
[M2-SCHEMA-ArtifactIdentityV1]
ArtifactIdentityV1 {
  kind: content_sha256|unreadable_fingerprint|missing,
  value: Sha256Hex
}

StorageArtifactIdentityTupleV1 = [
  primary_state: ArtifactIdentityV1,
  backup_state: ArtifactIdentityV1
] // exactly two entries in this fixed order

UnreadableArtifactFingerprintV1 {
  schema_version: 1,
  path_role: primary_state|backup_state,
  reason_code: read_failed|size_limit|metadata_failed,
  win32_error_code: u32,
  volume_serial?: u32,
  file_id_hex?: string <= 32 ASCII characters,
  byte_length?: U64DecimalString,
  creation_time_filetime?: U64DecimalString,
  last_write_time_filetime?: U64DecimalString,
  attributes?: u32
}

StorageArtifactMetadataV1 {
  schema_version: 1,
  path_role: primary_state|backup_state,
  presence: present|missing,
  readability: readable|unreadable|not_applicable,
  byte_length?: U64DecimalString,
  identity?: ArtifactIdentityV1,
  unreadable_fingerprint?: UnreadableArtifactFingerprintV1,
  validation: valid_state_v2|invalid|unsupported_version|unreadable|missing
}

StorageOwnerObservationV1 {
  presence: present|missing,
  identity?: ArtifactIdentityV1,
  data_dir_instance_id?: UUID,
  acl_status: valid|invalid|unavailable
}

[M2-SCHEMA-StorageRepairSourceSnapshotV1]
StorageRepairSourceSnapshotV1 {
  schema_version: 1,
  path_role: primary_state|backup_state,
  artifact_identity: ArtifactIdentityV1,
  byte_length: U64DecimalString,
  source_state_content_hash: Sha256Hex,
  source_data_dir_instance_id: UUID,
  target_record_id?: UUID,
  target_record_before_hash?: Sha256Hex,
  target_result_last_checked_at?: Timestamp
}

[M2-SCHEMA-TargetDirectoryIdentityV1]
TargetDirectoryIdentityV1 {
  schema_version: 1,
  volume_serial: U64DecimalString,
  file_id_hex: string <= 32 lowercase ASCII hexadecimal characters encoding the exact 16-byte FILE_ID_128,
  final_path: string <= 32 KiB strict UTF-8
}

StorageRepairPreviewV1 {
  schema_version: 1,
  repair_id: UUID,
  mode: restore|reset|adopt|containment_reboot,
  ownership_classification: StorageOwnershipClassificationV1,
  ownership_proof: present|absent,
  owner_before: StorageOwnerObservationV1,
  target_data_dir_instance_id: UUID,
  target_directory_identity: TargetDirectoryIdentityV1,
  target_directory_identity_hash: Sha256Hex,
  current_system_boot_time_filetime: ProcessStartFiletime,
  primary: StorageArtifactMetadataV1,
  backup: StorageArtifactMetadataV1,
  source_path_role?: primary_state|backup_state,
  source_identity?: ArtifactIdentityV1,
  source_snapshot?: StorageRepairSourceSnapshotV1,
  record_id?: UUID,
  publication_method: replace_existing|move_missing|already_exact|containment_sync,
  expected_artifact_identities: StorageArtifactIdentityTupleV1,
  expected_owner_sha256: Sha256Hex,
  expected_owner_byte_length: U64DecimalString,
  expected_result_sha256: Sha256Hex,
  expected_result_byte_length: U64DecimalString,
  temporary_name: string,
  owner_temporary_name?: string,
  primary_quarantine_name?: string,
  backup_quarantine_name?: string,
  plan_hash: Sha256Hex,
  expires_at: Timestamp,
  requires_strong_reset_confirmation: bool
}

[M2-SCHEMA-StorageRepairAuthorizationV1]
StorageRepairAuthorizationV1 {
  schema_version: 1,
  repair_id: UUID,
  plan_hash: Sha256Hex,
  authorization_id: UUID,
  authorized_at: Timestamp,
  expires_at: Timestamp,
  mode: restore|reset|adopt|containment_reboot,
  expected_owner_observation: StorageOwnerObservationV1,
  target_directory_identity: TargetDirectoryIdentityV1,
  target_directory_identity_hash: Sha256Hex,
  expected_artifact_identities: StorageArtifactIdentityTupleV1,
  source_snapshot?: StorageRepairSourceSnapshotV1,
  record_id?: UUID,
  expected_result_sha256: Sha256Hex,
  expected_result_byte_length: U64DecimalString
}

StorageRepairRequestReplayV1 {
  schema_version: 1,
  request_id: RequestId,
  command: Prepare|Confirm|Execute|Cancel|GetStatus,
  request_body_sha256: Sha256Hex,
  response_body_sha256: Sha256Hex,
  response_bytes_b64: string <= 256 KiB
}

[M2-SCHEMA-StorageRepairAuthorizationLedgerRecordV1]
StorageRepairAuthorizationLedgerRecordV1 {
  schema_version: 1,
  repair_id: UUID,
  plan_hash: Sha256Hex,
  authorization_id: UUID,
  mode: restore|reset|adopt|containment_reboot,
  record_id?: UUID,
  source_snapshot?: StorageRepairSourceSnapshotV1,
  immutable_plan: StorageRepairPreviewV1,
  authorization: StorageRepairAuthorizationV1,
  state: authorized|consumed|cancelled|completed|ambiguous,
  expires_at: Timestamp,
  journal_phase?: journaled|quarantining|replacement_written|publishing|published|owner_publishing|owner_published|verified|audited|completed|ambiguous,
  retained_result?: StorageRepairExecutionResultV1,
  request_replays: [StorageRepairRequestReplayV1] <= 32 items,
  updated_at: Timestamp
}

StorageRepairAuthorizationLedgerV1 {
  schema_version: 1,
  ledger_generation: U64DecimalString,
  records: [StorageRepairAuthorizationLedgerRecordV1] <= 64 items
}

[M2-STATE-StorageRepairJournalV1]
StorageRepairJournalV1 {
  schema_version: 1,
  repair_id: UUID,
  plan_hash: Sha256Hex,
  authorization_id: UUID,
  authorization_consumed: bool,
  authorization_expires_at: Timestamp,
  data_dir_instance_id: UUID,
  mode: restore|reset|adopt|containment_reboot,
  ownership_classification: StorageOwnershipClassificationV1,
  ownership_proof: present|absent,
  owner_before: StorageOwnerObservationV1,
  target_directory_identity: TargetDirectoryIdentityV1,
  target_directory_identity_hash: Sha256Hex,
  primary_before: StorageArtifactMetadataV1,
  backup_before: StorageArtifactMetadataV1,
  expected_artifact_identities: StorageArtifactIdentityTupleV1,
  source_path_role?: primary_state|backup_state,
  source_identity?: ArtifactIdentityV1,
  source_snapshot?: StorageRepairSourceSnapshotV1,
  record_id?: UUID,
  publication_method: replace_existing|move_missing|already_exact|containment_sync,
  phase:
      journaled
    | quarantining
    | replacement_written
    | publishing
    | published
    | owner_publishing
    | owner_published
    | verified
    | audited
    | completed
    | ambiguous,
  primary_quarantine_state: pending|moved|not_required,
  backup_quarantine_state: pending|moved|not_required,
  temporary_name: string,
  owner_temporary_name?: string,
  primary_quarantine_name?: string,
  backup_quarantine_name?: string,
  expected_owner_sha256: Sha256Hex,
  expected_owner_byte_length: U64DecimalString,
  expected_result_sha256: Sha256Hex,
  expected_result_byte_length: U64DecimalString,
  resulting_primary_sha256?: Sha256Hex,
  resulting_primary_byte_length?: U64DecimalString,
  ownership_status?: existing_valid|created_valid,
  audit_status?: written|audit_degraded,
  completed_at?: Timestamp
}

[M2-SCHEMA-StorageRepairExecutionResultV1]
StorageRepairExecutionResultV1 {
  schema_version: 1,
  request_id: RequestId,
  repair_id: UUID,
  plan_hash: Sha256Hex,
  execution_status: completed|cancelled|ambiguous|replayed|too_late,
  journal_phase?: journaled|quarantining|replacement_written|publishing|published|owner_publishing|owner_published|verified|audited|completed|ambiguous,
  result_sha256?: Sha256Hex,
  result_byte_length?: U64DecimalString,
  ownership_status?: existing_valid|created_valid,
  audit_status?: written|audit_degraded
}

StorageRepairStatusV1 =
    Prepared { preview: StorageRepairPreviewV1 }
  | Authorized {
      immutable_plan: StorageRepairPreviewV1,
      authorization: StorageRepairAuthorizationV1
    }
  | InProgress {
      repair_id: UUID,
      authorization_id: UUID,
      phase: journaled|quarantining|replacement_written|publishing|published|owner_publishing|owner_published|verified|audited,
      plan_hash: Sha256Hex
    }
  | Completed { result: StorageRepairExecutionResultV1 }
  | Cancelled { result: StorageRepairExecutionResultV1 }
  | Ambiguous { repair_id: UUID, reason_code: storage_repair_ambiguous }
```

A present readable artifact requires `readability=readable`, `byte_length`, `identity={kind:content_sha256,value:SHA-256(exact raw bytes)}`, no unreadable fingerprint, and `validation=valid_state_v2|invalid|unsupported_version`; it is streamed completely with bounded memory. A present unreadable artifact requires `readability=unreadable`, `identity={kind:unreadable_fingerprint,value:SHA-256(JCS(unreadable_fingerprint))}`, the matching `unreadable_fingerprint`, and `validation=unreadable`; byte length is present exactly when metadata supplied it. A missing artifact requires `readability=not_applicable`, forbids byte length and unreadable fingerprint, uses `validation=missing`, and has explicit deterministic `identity={kind:missing,value:SHA-256(JCS({schema_version:1,path_role:<primary_state|backup_state>,presence:"missing"}))}`. No other presence/readability/identity/validation combination is valid. `StorageOwnerObservationV1` is closed similarly: `presence=missing` requires `identity={kind:missing,value:SHA-256(JCS({schema_version:1,path_role:"storage_owner",presence:"missing"}))}`, absent `data_dir_instance_id`, and `acl_status=unavailable`; `presence=present` requires a non-missing content or unreadable-fingerprint identity, with `data_dir_instance_id` present only when exact owner bytes parse and validate, and `acl_status=valid` only for that exact validated owner plus required user-only ACL. `expected_artifact_identities` is always exactly `[primary_state identity, backup_state identity]` in that order; no omission, discovery order, or sorting is permitted. Source/quarantine fields are closed optional schema fields whose presence follows the selected branch, and every plan-hash input is a validated closed schema. `source_snapshot` is required for `restore|adopt|containment_reboot` and absent for `reset`; its artifact identity must be `content_sha256`, its `source_state_content_hash` must equal that identity value, its UUID must equal the fully validated source StateV2, and its byte length must equal the exact raw source bytes. `record_id` plus all three target-record fields are required exactly for `containment_reboot` and absent otherwise; `target_record_before_hash=SHA-256(JCS(the complete exact target UnregisteredContainmentRecordV1 before proof mutation))`, and `target_result_last_checked_at` is the host-generated result timestamp frozen during preparation. Preview, authorization, direct ledger projections, ledger immutable plan, and journal retain byte-equivalent source-snapshot and record bindings. The unreadable fallback is metadata identity, never a claimed content hash; it includes path role, Win32 error, and every available exact file-ID, volume, size, timestamp, and attributes field. If neither exact bytes nor sufficient metadata can establish identity, preparation returns `storage_identity_unavailable` and writes nothing.

Target-directory identity is acquired by opening the directory with `FILE_READ_ATTRIBUTES | SYNCHRONIZE` and `FILE_FLAG_BACKUP_SEMANTICS`, calling `GetFileInformationByHandleEx(FileIdInfo)` for the exact 64-bit volume serial and 16-byte `FILE_ID_128`, and calling `GetFinalPathNameByHandleW(FILE_NAME_NORMALIZED | VOLUME_NAME_GUID)`. The exact returned UTF-16 path is converted to strict UTF-8 with no Unicode/path normalization beyond the Windows API result; the file ID is 32 lowercase hex characters and the volume serial is `U64DecimalString`. `target_directory_identity_hash=SHA-256(JCS(TargetDirectoryIdentityV1))`. The preview, authorization, ledger, and journal bind both the closed object and hash. Tauri re-reads the same handle-derived object under the applicable mutex immediately before journal consumption, before each quarantine/publication mutation, and after completion. Any volume/file-ID/final-path/ACL drift is `storage_repair_ambiguous`; any unavailable required field is `storage_identity_unavailable` and writes nothing.

`PrepareStorageRepair` reclassifies all ownership/artifact observations with bounded I/O and writes nothing. `restore` requires `owned_valid` plus an exact valid backup. `adopt` requires `ownership_missing_valid_state`, selects exact valid state bytes, and creates the missing owner; if the selected valid source is not already the primary, the same immutable plan publishes it. `reset` is available only for `owned_valid`, `ownership_unproven_invalid_state`, or `uninitialized_empty`; it binds exact fresh bytes and is rejected when any exact validated source contains `armed|containment_uncertain` unregistered containment. `containment_reboot` requires `owned_valid`, exactly one requested unresolved record in the exact selected valid primary-or-backup source, a strictly later Windows boot, and no disagreement between otherwise valid sources' containment fields. Preparation host-generates and freezes `source_snapshot.target_result_last_checked_at`, constructs candidate bytes from the complete selected source by changing only that record as specified in section 6.4, and binds those exact bytes/hash/length; Confirm and Execute reuse that timestamp unchanged. `plan_hash=SHA-256(JCS(preview without plan_hash))`. Before returning or retaining anything, the native handler validates that exact `JCS(StorageRepairPreviewV1)` is at most 96 KiB and that every complete canonical native StorageRepair response is at most 192 KiB before base64 encoding; exceeding either bound returns `storage_repair_plan_too_large` without prepared state, ledger entry, replay entry, or target mutation. The 192-KiB raw bound encodes to at most 256 KiB base64, so every valid Prepare, Authorized-status, and replay response fits `StorageRepairRequestReplayV1` by construction. Prepared native state expires after five minutes and all retained repair metadata is capped at 512 KiB.

Fresh reset state is exactly UTF-8 RFC 8785/JCS of this closed value, with no BOM, leading/trailing whitespace, or trailing newline; `expected_result_sha256` and byte length are computed over these exact bytes before authorization:

```text
StateV2 {
  schema_version: 2,
  data_dir_instance_id: <target ownership UUID>,
  next_session_id: 1,
  next_creation_sequence: "0",
  session_creation_receipts: [],
  layout_revision: "0",
  layout: LayoutV1 {
    schema_version: 1,
    root_tab_ids: [],
    groups: [],
    tabs: {}
  },
  safety_revision: "0",
  safety_state: SafetyStateV1 {
    schema_version: 1,
    settings: SettingsV1 {
      schema_version: 1,
      recovery_mode: reviewed,
      auto_recover_on_ui_crash: true,
      auto_recover_on_host_crash: true,
      auto_restart_on_protocol_mismatch: false,
      auto_submit_after_preview: false,
      require_preview: true,
      continuation_text: "Continue. We accidentally terminated.",
      max_parallel_recoveries: 1,
      shell_launch_timeout_ms: 30000,
      provider_readiness_timeout_ms: 30000,
      send_acknowledgement_timeout_ms: 10000,
      per_session_deadline_ms: 120000,
      max_launch_retries: 2,
      max_resume_retries: 2,
      max_structured_bridge_retries: 1,
      max_send_retries: 0,
      retry_backoff_cap_ms: 2000,
      kill_switch_enabled: true,
      notifications_enabled: true,
      notify_start_success_failure: true,
      audit_log_enabled: true,
      provider_allow_unattended: {}
    },
    recovery_records: {},
    recovery_operations: {},
    confirmations: {},
    kill_switch: KillSwitchV1 {
      schema_version: 1,
      engaged: false,
      generation: "0"
    }
  },
  last_sessions: [],
  teardown_graveyard: [],
  unregistered_containment_records: []
}
```

`last_recovery_bootstrap_import` and `last_host_instance_id` are absent. Reset synthesizes no timestamp, session receipt, recovery record/operation, confirmation, host ID, or teardown witness. Cross-language fixtures pin exact bytes/hash/length for fixed ownership UUIDs.

`ConfirmStorageRepair` re-proves the complete plan while the full StorageRepair lock chain remains held. Restore/adopt each requires an explicit native OS dialog; containment reboot uses the exact historical-obligation dialog in section 6.4; reset uses a distinct destructive dialog and exact phrase `RESET TERMX STATE`, collected and compared only in native UI. Affirmative confirmation host-generates one `expires_at` equal to the prepared deadline, requires it to equal `immutable_plan.expires_at`, embeds it inside the closed `StorageRepairAuthorizationV1`, and atomically stores both the complete exact `immutable_plan: StorageRepairPreviewV1` and that authorization in `state.json.repair.authorization-ledger`; the Confirm response exposes no second independently serialized expiry. The ledger record's direct `repair_id|plan_hash|mode|record_id|source_snapshot|expires_at`, its `immutable_plan.repair_id|plan_hash|mode|record_id|owner_before|target_directory_identity|target_directory_identity_hash|expected_artifact_identities|source_snapshot|expected_result_sha256|expected_result_byte_length|expires_at`, and the corresponding authorization fields/projections must all agree, with optional fields equal by presence and value; every install/read recomputes `plan_hash=SHA-256(JCS(immutable_plan without plan_hash))`. Thus an `authorized` record retains the complete canonical plan preimage—including target ownership UUID, ownership classification/proof, before metadata, source role/identity, publication method, owner/result bindings, and deterministic temp/quarantine names—rather than relying on an irreversible hash or an in-memory prepared cache. The ledger record's `expires_at` must equal `authorization.expires_at` exactly as the same validated `Timestamp` value and is a redundant indexed copy, never independent authority. The ledger is strict RFC 8785/JCS UTF-8 with no BOM/newline, user-only ACL, at most 64 records and 512 KiB total; each retained canonical response is at most 192 KiB before base64 encoding and its `response_bytes_b64` is at most 256 KiB. A complete candidate with incremented decimal generation is written to `state.json.repair.authorization-ledger.tmp.<ledger_generation>`, file-flushed, parent-flushed where supported, atomically installed by `MoveFileExW(temp,ledger,MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`, then reopened to verify ACL, schema/JCS, generation, and response hashes before acknowledgement. Quota/ACL/flush/replace/read-back failure returns no authorization or mutation acknowledgement and leaves the repair target unchanged.

The native invoke handler validates/canonicalizes each request and authenticates its internal storage-engine call with an authority-key HMAC that JavaScript never receives. Same request ID and canonical body hash returns the retained exact response; same ID/different body rejects. A new Confirm for the same unexpired repair/plan returns retained authorization without a second dialog; changed plan/observation/authorization/expiry rejects. Execute accepts only an exact authorization and ledger/journal binding.

The repair action progresses exactly:

```text
prepared
  -> authorized              // native authorization ledger; data directory unchanged
  -> journaled               // first data-directory mutation; authorization_consumed=true
  -> quarantining            // only when the selected branch requires an explicit quarantine move
  -> replacement_written     // exact candidate temp flushed and re-read
  -> publishing
  -> published
  -> owner_publishing        // owner-absent adopt/reset only
  -> owner_published
  -> verified
  -> audited
  -> completed
```

Before any destructive mutation, Execute loads the ledger record by exact `repair_id|plan_hash|authorization_id`, validates and rehashes its complete `immutable_plan`, requires every authorization projection and redundant ledger key/mode/record/source-snapshot/expiry to equal that plan exactly, requires current time strictly before `authorization.expires_at`, enforces ledger count/byte caps, and re-observes the target solely to compare against the immutable plan—never to construct a replacement plan. It then deterministically projects the complete journal from that retained plan and flushes/re-reads it at `phase=journaled` with `authorization_consumed=true`, `authorization_expires_at=authorization.expires_at`, authorization ID, plan hash, target-directory identity, fixed ordered artifact identities, source/result bindings, publication method, exact names, and all immutable observations. The journal expiry is part of its closed RFC 8785/JCS/hash binding. This successful journal install is the sole authorization-consumption point. It immediately performs a separate atomic ledger generation update from `authorized` to `consumed`, mirrors `journal_phase=journaled`, and retains the exact replayable Execute response boundary. No owner/state/backup/quarantine mutation may begin until the journal is proven durable; failure before journal installation leaves the authorization `authorized` and retryable until expiry. Failure or crash after journal installation but before the ledger mirror does not restore authorization: the matching journal is authoritative, startup changes the ledger to `consumed`, and execution resumes the same immutable plan without a second dialog. A ledger claiming `authorized|cancelled` while a matching consumed journal exists is reconciled to `consumed`; incompatible authorization, plan, directory, artifact, or result bindings are `ambiguous` and block mutation.

Source selection and publication are deterministic. Restore always uses the valid backup. Adopt selects valid primary when present, otherwise valid backup. Containment reboot selects valid primary when present, otherwise the exact valid backup, and rejects disagreement between two valid containment fields. Reset has no source. Candidate bytes are fully read, validated, and written/flushed/re-read to the deterministic temporary before moving any source; the journal binds the complete `source_snapshot`, source role/identity, fixed ordered artifact tuple, optional target record and before-hash, `publication_method`, exact names, and quarantine states. Immediately before candidate construction, Execute re-reads the selected canonical source and requires exact raw content hash, byte length, embedded UUID, target record projection when present, and all fixed artifact identities. On later retries, the journal phase and quarantine-state fields identify the one exact location that must still contain those bound source bytes: the original canonical role before its move, or that role's deterministic exact quarantine after `moved`; Execute re-reads that location and requires the same snapshot before continuing. This location transition is not source reselection: it never switches primary/backup after authorization or reconstructs candidate bytes from a newly observed artifact.

- **Restore/adopt with existing primary:** never pre-move primary. If primary already equals the selected result, record `publication_method=already_exact`, re-read exact identity, and advance to `published` without replacement. Otherwise record `publishing` and call `ReplaceFileW(primary,temporary,primary_quarantine,REPLACEFILE_WRITE_THROUGH,nullptr,nullptr)`, atomically publishing candidate and quarantining old primary. The source backup remains untouched unless the immutable plan explicitly requires a separate forensic backup quarantine.
- **Restore/adopt with missing primary:** record `publication_method=move_missing`; keep source backup untouched and publish with non-overwriting `MoveFileExW(temporary,primary,MOVEFILE_WRITE_THROUGH)`.
- **Containment reboot:** use `publication_method=containment_sync`; a valid backup cannot remain at its old unresolved containment bytes. The immutable plan requires deterministic primary and backup quarantine names whenever those paths are present. The exact candidate temporary is already flushed and re-read before `phase=quarantining`. Under that phase, move each still-exact old artifact non-overwriting to its bound quarantine, flush/re-read each moved-state update, and preserve the selected source bytes there for forensics. Publish the already-exact candidate temporary non-overwriting to primary, then recreate the same deterministic temporary path from the identical journal-bound candidate bytes after proving that path absent, flush/re-read it, and publish it non-overwriting to backup. `temporary_name` may be consumed and recreated exactly once for this mode; no other mode does so. During `publishing`, exact old artifacts plus absent quarantines retry their bound quarantine moves; exact candidate primary plus absent backup and exact candidate temporary completes backup publication; exact candidate primary plus exact candidate backup advances; any differing extra artifact, candidate/hash drift, or mixed source identity is ambiguous. `published` requires both canonical primary and backup to equal the exact candidate plus every required old-artifact quarantine. Thus the repaired copies cannot disagree, and restore/adopt later select an exact result that preserves the repaired containment field.
- **Reset:** record no source. If backup exists, record `quarantining` and move backup first to its deterministic quarantine using non-overwriting `MoveFileExW`, flushing its `moved` state. Never pre-move an existing primary. With existing primary use `publication_method=replace_existing` and `ReplaceFileW(primary,temporary,primary_quarantine,REPLACEFILE_WRITE_THROUGH,nullptr,nullptr)`; with missing primary use `move_missing` and non-overwriting `MoveFileExW`.

`published` is recorded only after exact destination/quarantine/temp observations. Owner-absent adopt/reset then records `owner_publishing`, publishes the exact owner as defined above, and records `owner_published`; an existing valid owner skips owner publication with `ownership_status=existing_valid`.

Execute reopens primary, verifies exact SHA-256/length, fully parses and validates `StateV2`, verifies its UUID equals the exact owner UUID and its user-only ACL, verifies the owner/ordinary mutex state, and records `verified`. For restore/adopt/containment reboot it additionally proves that the published `unregistered_containment_records` equals the exact selected source field, except for the one preview-bound target mutation in containment reboot; no other record, receipt, session, layout, safety, graveyard, or bootstrap-witness field may differ from the expected candidate. It appends a redacted audit containing repair ID/mode, source identity kind/value and lengths, optional target record ID, result hash/length, ownership status, and outcome; `audit_degraded` is allowed only by the existing policy. It then records `audited` and terminal `completed` with the retained result.

Crash-prefix reconciliation under the complete recovery/preownership/ordinary/repair lock chain is deterministic. `journaled` resumes the exact plan. During `quarantining`, source-present/destination-absent retries the exact move; source-absent/exact-destination advances; both present, different destination, or identity drift is ambiguous. `replacement_written` requires exact temporary bytes. During ordinary `publishing`, an exact result plus required quarantine advances; an exact pre-call source/temp state retries the same API; any other combination is ambiguous. During `containment_sync` publishing, exact old primary/backup and absent bound quarantines resume only their ordered quarantine moves; exact candidate primary plus absent backup plus exact candidate temporary resumes only backup publication; exact candidate primary and backup plus exact required quarantines advances; any other combination is ambiguous. Deterministic temporary recreation is legal exactly once only when primary already equals the bound candidate, backup is absent, every required quarantine is exact, and the temporary path is absent; its bytes must rehash to the immutable expected result before backup publication. `published|owner_published|verified|audited` advances only after its exact observations; `completed` returns the retained result with `execution_status=replayed` and performs no file mutation. `ambiguous` blocks mutation and listener publication.

Cancel before a consumed journal durably changes the ledger record from `authorized` to `cancelled`, stores the exact terminal `StorageRepairExecutionResultV1` with no `journal_phase`, retains the replay response, and changes no owner/state/backup/quarantine artifact; repeated Cancel returns those exact retained bytes. The cancelled authorization remains as a non-executable audit/idempotency record rather than being deleted. Cancel at or after consumed `journaled` returns and retains `too_late`, never rolls back, and does not change ledger state from `consumed|completed|ambiguous`. Execute after cancellation rejects. Execute/Confirm with changed plan, authorization, action, expected result, ownership, directory/artifact observation, expiry, or foreign repair ID rejects without mutation.

Startup, `GetStorageRepairStatus`, and request replay reconcile the ledger and journal before returning status or exposing a new repair. `Authorized` status returns both the retained complete `immutable_plan` and its authorization. After Confirm acknowledgement loss or a complete Tauri/native restart, Execute uses those exact durable bytes; if the plan is missing, cannot be rehashed, exceeds bounds, or differs from any authorization/ledger projection, the record becomes `storage_repair_ambiguous` and remains non-mutating rather than recomputing from current disk observations. A matching consumed nonterminal journal is authoritative and advances the ledger mirror to its exact phase; terminal journal/result state advances the ledger to `completed|ambiguous` and retains the exact result. An `authorized|cancelled` ledger record without a journal remains non-mutating; an expired `authorized` record becomes non-executable but remains retained. A ledger `consumed|completed` record with a missing journal, or any conflicting authorization/plan/directory/artifact/result hash, is `storage_repair_ambiguous` and blocks mutation/listener publication. Reconciliation and sweeping run only while holding the complete `recovery_bootstrap_mutex -> data_dir_preownership_mutex -> ordinary UUID mutex when derivable -> exclusive repair authority -> ledger writer` chain.

Terminal `cancelled|completed|ambiguous` records, their request replays, and the completed/ambiguous journal are retained for at least 30 days from terminal `updated_at`. A sweep may remove only terminal records older than 30 days whose exact result and audit outcome are already durable and whose journal has no unresolved mutation prefix; it removes oldest eligible records first with the same atomic ledger install/read-back rules. Nonterminal and younger terminal records are never evicted. Before Confirm, Cancel, Execute, or reconciliation writes, the candidate ledger must satisfy 64 records, 512 KiB total, 32 replay entries per record, at most 192 KiB per retained canonical response before base64 encoding, and at most 256 KiB for its stored `response_bytes_b64`. If caps cannot be met by sweeping eligible records, the operation fails closed before mutation. The completed journal remains the durable idempotency record until that same eligibility proof permits its retention sweep.

A host may start only after the exact terminal completed result, primary/owner/ACL validation (and exact synchronized backup validation for `containment_reboot`), recorded audit outcome, Tauri's acquisition of the ordinary ownership mutex, and reverse-order release of ledger, repair, preownership, and recovery-bootstrap authority before host publication. Native repair never creates a host confirmation or shutdown authorization and never claims that a nonexistent host approved the file operation.

Migration and repair fixtures cover current M1 null/arbitrary layout, recognized legacy layout, valid v2, corrupt primary with valid backup, corrupt primary and backup, future schema version, owner classifications and races, interrupted owner/quarantine/temp/publication artifacts, every durable journal prefix, cancellation/expiry/request replay, changed source bytes, exact fresh reset bytes, and ambiguous observations.

### 8.4 Persistence cadence

- Rename, recolor, group create/delete, collapse, close, and other discrete operations persist immediately.
- Drag and reorder use a 250 ms trailing debounce plus a final write at drag end.
- Window close attempts a bounded flush of already-prepared non-destructive layout edits, but failure does not stop the window from closing or send host shutdown.
- Safety-critical recovery and kill-switch writes are immediate and acknowledgement-gated.

## 9. React component and state boundaries

Suggested focused modules:

### Host transport

- `HostClient`: socket state, handshake, request correlation, binary framing, bounded request table, reconnect.
- `hostReducer`: snapshot and event reduction with cursor validation.
- `HostProvider`: React integration and selectors.
- `protocol.ts`: explicit v2 TypeScript wire types and runtime validation.

### Terminal

- `TerminalController`: xterm instance, attach lifecycle, input gating, offset tracking.
- `OutputWriteQueue`: bounded replay/live write scheduling.
- `TerminalView`: DOM host and renderer fallback presentation.

### Sessions and layout

- `SessionSidebar`, `SessionRow`, `GroupRow`, and `NewSessionButton`.
- `layoutSchema`: parsing, migrations, validation, and invariants.
- `layoutReducer`: semantic layout operations.
- `layoutPersistence`: debounce, CAS, rebase, conflict notification, and undo record.

### Settings and recovery

- `SettingsDrawer`: main-renderer settings surface.
- `RecoveryCoordinator`: trigger classification, preview, journal transitions, adapter orchestration, deadlines, kill-switch checks, and notifications.
- `providerAdapters`: capability declarations and argv-vector launch/resume recipes.
- `RecoveryReview`: affected-session preview, capability reasons, confirmation, progress, unknown-result handling, and manual instructions.

These boundaries are intentionally narrow so protocol, terminal buffering, layout reconciliation, and recovery state machines can be tested independently.

## 10. xterm.js lifecycle and bounded memory

### 10.1 Visible terminal policy

M2 maintains one visible terminal controller. Switching tabs detaches and disposes the previous xterm view, then reattaches the selected session with replay. M6 generalizes the same abstraction to one controller per visible pane.

Detached inactive sessions remain alive in the host. M2 does not claim a reliable output-activity indicator for them because the renderer is not consuming their live output.

### 10.2 Renderer

- Prefer xterm’s WebGL addon.
- If addon initialization or the WebGL context fails, dispose it and use xterm’s pinned fallback renderer.
- Renderer fallback must not detach or restart the session.
- UI scrollback is capped at the lesser of 10,000 lines and 16 MiB of UTF-16 cell/text storage estimated by the terminal controller. A logical line is capped at 256 KiB of decoded input before a visible hard-wrap/truncation marker is inserted. The controller periodically measures serialized visible+scrollback text every 100 writes; crossing 16 MiB trims oldest lines to 12 MiB. The host byte ring remains the authoritative reconnect source, so renderer trimming is presentation-only and visible.

### 10.3 Initial attach and replay

On attach or full resynchronization:

1. Disable keyboard, paste, and terminal-generated reply forwarding.
2. Abort and dispose the old attachment.
3. Reset xterm parser and terminal state, including a RIS-lite reset such as `ESC[!p`.
4. Clear pending rendered-live data.
5. Request attach with replay.
6. Decode base64 directly into `Uint8Array`.
7. Write replay through bounded slices and await xterm write callbacks.
8. Suppress and discard `onData` and `onBinary` output produced by replayed DA, DSR, OSC, or other terminal queries.
9. Buffer `Attached` and later binary frames until replay rendering completes.
10. Enable user input only after replay drain and the correlated `Attached` acknowledgement.

The host does not sanitize arbitrary replay bytes because removing bytes would invalidate authoritative offsets.

### 10.4 Offset reconciliation

The terminal controller tracks authoritative byte intervals rather than assuming every replay begins at the requested offset.

- Fully duplicated frames are dropped.
- Partial overlap is trimmed.
- Exact continuation is written.
- A replay start beyond the expected offset indicates ring eviction. The UI inserts a visible scrollback-truncated marker, advances to the authoritative start, and continues.
- An unexplained live forward gap triggers detach and fresh replay rather than waiting forever for missing bytes.

### 10.5 Queue bounds

- Additional live write backlog is byte-accounted and capped at exactly 2 MiB of decoded payload.
- At most one 512 KiB decoded Replay chunk and one 512 KiB base64-decode scratch allocation exist in the renderer at a time.
- The terminal controller’s total owned pending decoded output is therefore capped at 3 MiB, excluding xterm’s configured 10,000-line internal scrollback.
- On overflow, the controller stops accepting live frames, detaches, clears or drains bounded pending work, and reattaches with replay.
- No JavaScript array, request table, decoded Replay payload, or write callback list may grow without an exact cap.
- Input and paste chunks are at most 240 KiB, below the host’s 256 KiB input-frame limit after binary framing.

### 10.6 Dead-session dismissal

A naturally exited session stays visible with its final replayable output. Dismissing its tab sends explicit `CloseSession` and marks it closing, but removes the tab only after canonical `SessionClosed`. A `close_uncertain` result keeps a visible blocked/diagnostic tab and offers no replacement or recovery action until containment is resolved. Only `SessionClosed` proves that the host released the retained ring, Job, ConPTY, and exact process-tree ownership.

## 11. Desktop shell and sessions sidebar

The main window contains:

- Top bar.
- Host connection and compatibility status.
- Search shell.
- Sessions sidebar.
- Main terminal area.
- Toast and recovery surfaces.
- Main-renderer Settings drawer or route.

There is no lifecycle-owning secondary Settings window in M2.

### 11.1 Search

The approved top bar remains visually ready for “search sessions and files,” but M2 returns only sessions and groups. File providers arrive in M3. Copy must not imply file search is already implemented.

### 11.2 Session actions

The sidebar supports:

- Create with the default profile.
- Create through a profile chooser.
- Rename.
- Preset and custom colors.
- Close.
- Duplicate using the same profile and cwd.
- Drag reorder.
- Move into and out of groups.
- Create, rename, recolor, collapse, expand, and delete groups.
- Group “new session here” and “close all.”
- Dead/interrupted presentation and explicit dismissal.

Spawn failures render inline with a structured safe error code, the attempted executable path, and a shortcut to profile Settings. The argument vector is displayed only when it previously passed `CredentialArgvClassifierV1=clean`; `invalid_config|profile_unavailable|adapter_unqualified|credential_bearing_argv` diagnostics show only the safe category and argument index defined by the classifier, never the rejected argument, inline value, following value, or complete vector.

## 12. Runtime profile discovery

The human-editable `config.json` is the durable source of profile configuration. Tauri owns validated file edits from Settings; the host owns the active in-memory configuration and discovery snapshot for its lifetime. The file gains schema version 2:

```text
ConfigV2 {
  schema_version: 2,
  scrollback_bytes: u32 1..=8_388_608,
  default_profile_id: string <= 256 UTF-8 bytes,
  profile_overrides: {
    profile_id: {
      enabled?: bool,
      display_name?: string <= 512 UTF-8 bytes,
      executable?: PortablePath,
      arguments_mode?: replace|append,
      arguments?: [string <= 8 KiB] <= 64 items and 64 KiB total
    }
  } <= 512 entries and 512 KiB serialized,
  extensions: { namespaced_key: CanonicalJsonValue } <= 1024 entries and 64 KiB serialized
}

CredentialArgvClassifierV1 {
  schema_version: 1,
  comparison: ascii_case_insensitive,
  value_taking_flags: [
    "--api-key", "--token", "--access-token", "--auth-token",
    "--password", "--secret", "--client-secret", "-p"
  ],
  assignment_name_suffixes: ["_KEY", "_TOKEN", "_PASSWORD", "_SECRET"],
  environment_allowlist: ["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"]
}
```

The Settings UI edits config through these exact native commands/results:

```text
ConfigContentHash = "missing:v1" | Sha256Fingerprint
ReadConfig -> { config: ConfigV2, content_hash: ConfigContentHash }
WriteConfig {
  expected_content_hash: ConfigContentHash,
  config: ConfigV2
} -> {
  content_hash: Sha256Fingerprint,
  profiles_restart_required: true
}
```

`ReadConfig.content_hash` is `missing:v1` only when no config file exists; otherwise it is `sha256:v1:<64 lowercase hex>` over the exact raw file bytes read from disk before UTF-8/JSON parsing. `WriteConfig.expected_content_hash` compares against a fresh exact raw-byte read made while holding the native config-write lock; a missing/current-file mismatch returns `config_conflict` with the newly read hash and parsed canonical current config when valid, and changes nothing. A matching write validates `ConfigV2`, serializes the deterministic pretty bytes defined below, atomically replaces the file, re-reads those exact bytes, and returns their SHA-256 fingerprint. This is a raw-content CAS: it detects external whitespace/key-order edits as conflicts and never hashes a parsed/JCS-normalized surrogate. Tauri validates and atomically writes `config.json`; the live host remains the owner of the active profile snapshot. A successful write marks `profiles_restart_required`; M2 applies it on an explicit confirmed host restart rather than mutating discovery underneath live clients.

Config migration recognizes the current two-field unversioned file: an in-range `scrollback_bytes` is preserved, legacy zero is normalized to the documented 4 MiB default, and a legacy value above 8 MiB is normalized to the 8 MiB maximum. This compatibility normalization exists only while decoding that recognized unversioned schema, occurs before constructing `ConfigV2`, emits one safe migration warning, and is fixture-pinned in the exact migrated pretty bytes; it is never applied by `ReadConfig` or `WriteConfig` to schema-v2 input. Migration maps `default_profile` to `default_profile_id`, creates empty overrides, backs up the original, and writes v2 atomically. Unknown top-level fields are moved during migration into `extensions` under keys prefixed `legacy.`. In v2, extension keys must match `<vendor-or-project>.<name>`.

`CanonicalJsonValue` is exactly null, bool, string, array, object, or an IEEE-754 binary64 number. Parsing uses the same JSON-to-binary64 semantics as ECMAScript `JSON.parse`: reject overflow to non-finite, reject NaN/Infinity literals, and normalize negative zero to zero. Integers outside the exactly representable binary64 range are accepted only as their parsed binary64 value; extensions needing exact large integers must encode them as strings. Strings are Unicode scalar values with lone surrogate escapes rejected. Arrays/objects are limited to depth 64, at most 4,096 aggregate nodes per extension value, and the existing aggregate entry/byte caps.

`WriteConfig` emits **deterministic pretty JSON, not JCS and not a canonical JSON serialization for the section-7 hash rules**: UTF-8 without BOM, two-space indentation, LF line endings, lexicographically sorted object keys by Unicode scalar sequence at every depth, one trailing newline, and binary64 numbers serialized by the RFC 8785 ECMAScript number-serialization algorithm (including lowercase `e`, the algorithm’s exponent-sign rules, and normalized zero). Its exact byte fingerprint is the raw-file `Sha256Fingerprint` defined above; no config hash is computed from JCS. Rust uses a fixture-tested pretty encoder plus Ryu/JCS-compatible number formatter over parsed `f64`; TypeScript uses the same byte-for-byte fixtures. TermX preserves extension values semantically without interpreting them; object order, whitespace, and original numeric spelling are not preserved after a successful write. For schema-v2 `ReadConfig` and `WriteConfig`, zero or greater-than-8-MiB scrollback is a hard `invalid_config` error and no file is overwritten; compatibility normalization is confined to the recognized unversioned migration described above. Malformed JSON, wrong types, invalid Unicode, numeric overflow/non-finite values, excessive depth/nodes, invalid profile IDs, or invalid argv are likewise hard errors and are never overwritten.

Arguments are JSON string arrays. `replace` replaces generated default arguments; `append` appends after them. Durable profile arguments are explicitly non-secret configuration: `ReadConfig`/Settings warns that they are persisted and may appear in safe launch previews. `CredentialArgvClassifierV1` is the complete compiled M2 classifier; it is not user-extensible, adapter-extensible, or selected by executable. After permitted environment expansion, it scans the complete effective argument vector left-to-right and returns exactly `clean|secret_bearing`; validated string arrays have no third/unclassifiable result. Comparison of the fixed ASCII flag/suffix literals is ASCII case-insensitive while all other argument bytes remain exact. An argument is `secret_bearing` when it is exactly one listed value-taking flag (whether or not a following value exists), when the substring before its first `=` exactly matches one listed flag, or when a nonempty substring before its first `=` ends with one listed assignment-name suffix. Therefore `-p` is rejected unconditionally; there is no executable-specific password-flag registry. A separate argument immediately following a listed value-taking flag is part of the rejected vector but need not be inspected or reported. Empty assignment names do not match. The validator reports only the safe flag/category and argument index, never the following or inline value. This denylist is defense-in-depth rather than a claim to detect every secret: users must provide credentials through the external provider's standard protected credential store, never profile argv.

`WriteConfig` rejects any override whose complete expanded effective argv is `secret_bearing`; `ReadConfig` treats an already-present schema-v2 file with that result as `invalid_config` and never echoes the offending value through diagnostics. The same classifier runs again before any ordinary shell launch, before constructing `ShellLaunchBindingV1`, and on every adapter-generated managed-initial argv, resume argv, and structured-bridge launch recipe before persistence, preview construction, terminal-input admission, or `CreateProcessW`; generated-default/adapter argv that is `secret_bearing` disables that profile or qualification with safe reason `credential_bearing_argv` and crosses no external boundary. `encode_structured_submission` returns `InputRecipe` exact terminal-input bytes rather than argv and is intentionally outside this argv classifier; its immutable continuation source is already the previewed, fingerprinted continuation text and remains subject to the separate size/at-most-once admission contract. Because classification is total after syntax/expansion validation, “cannot be classified” means only that earlier validation rejected the vector for invalid UTF-16/lone surrogate, NUL/control character, bound violation, malformed/disallowed expansion, or missing allowlisted variable; it is `invalid_config` for user overrides and `profile_unavailable|adapter_unqualified` for generated vectors. A shell profile whose effective shell argv fails either path is unavailable to `CreateSession`; its `ProfileInfoV2` has `available=false`, `default_arguments=[]`, and only the safe diagnostic category/index, so discovery never returns the offending vector. A provider adapter whose generated argv fails is unqualified while the underlying clean shell profile may still be used for a user to type commands manually. TermX creates no managed recovery record, operation, or `RecoveryActionPreviewV1` from the failed shell/profile/adapter qualification. This does not mean a Manual-mode recovery operation exists without a preview: no operation exists until the relevant vector is corrected and requalified.

Environment expansion uses only the classifier's exact non-secret allowlist `%SystemRoot%|%WINDIR%|%COMSPEC%|%TEMP%|%TMP%`; every other `%NAME%`, missing variable, NUL, or control character is rejected, and TermX never invokes a shell. Relative executable overrides are resolved through the captured host PATH and persisted as the configured string; discovered results expose the absolute resolved executable.

Required sources:

- Windows PowerShell 5.1 derived from `%SystemRoot%`.
- Command Prompt from `%ComSpec%`.
- `pwsh` from configured override and PATH.
- Git Bash from configured override, registry, PATH, and derived well-known installation locations.
- WSL distributions from `wsl.exe -l -q`.

Configured overrides take precedence. Stable IDs are `powershell`, `pwsh`, `git-bash`, `cmd`, and `wsl:<normalized-distro-name>`. Normalization trims Unicode whitespace, applies Windows case-insensitive comparison for deduplication, rejects control characters, and preserves the original display name. Duplicate sources collapse to one profile in precedence order.

WSL discovery starts `wsl.exe -l -q` without a shell, decodes UTF-16LE when a byte-order mark or NUL pattern indicates it and otherwise uses UTF-8 lossless validation, captures at most 256 KiB, and has a five-second deadline. Exceeding the output cap terminates discovery and returns `profile_discovery_output_limit` with no partial distro list. On timeout it terminates through the exact retained process handle, waits up to two seconds, and reports one disabled WSL diagnostic. If the exact discovery process still cannot be proved exited, profile discovery enters `containment_uncertain`; WSL profiles remain unavailable and host startup fails closed rather than leaving an unmanaged helper.

A WSL profile launches `wsl.exe` with generated argv `[-d, <exact original distro name>]`. Its stable recovery identity stores both the normalized stable ID and exact original distro name. On rediscovery, a case-insensitive normalized match may update display casing; no match marks the profile unavailable rather than selecting another distro. An override in `replace` mode replaces the complete generated argv and therefore opts out of distro identity guarantees; such a profile is Manual-only for recovery. `append` retains the generated `-d` selection and appends user arguments.

Each profile result contains:

- Stable profile ID.
- Display name.
- Profile kind.
- Availability.
- Executable identity.
- Default argument vector.
- Discovery source.
- Optional structured diagnostic.

A discovery failure disables only that profile; it does not prevent host startup, except that an explicitly configured default profile which is unavailable produces a visible configuration error and requires selecting a valid default before creation. Ordering is:

1. Configured default.
2. Windows PowerShell.
3. PowerShell 7.
4. Git Bash.
5. Command Prompt.
6. WSL distributions alphabetically.

The implementation passes argv vectors directly. It does not build interpolated shell commands.

## 13. Reconnection, restart, and protocol mismatch

### 13.1 Startup and normal reconnection

1. Tauri resolves the data directory.
2. It reads and validates runtime discovery.
3. It verifies PID identity and listener reachability.
4. It starts the sidecar only for proven missing or dead state.
5. It re-reads runtime discovery after spawn.
6. React connects directly to `ws://127.0.0.1:<port>` and authenticates in the first text frame.

React uses capped exponential reconnect backoff with jitter and keeps targeting the same verified host while it is live.

### 13.2 UI crash

UI crash recovery is reattach-only. It reconnects, installs a fresh snapshot, restores the selected tab, and replays the terminal. It never launches a provider resume command while the original host and shell remain alive.

### 13.3 Proven-dead host

If a running UI conclusively observes that the host died or its runtime ownership became invalid, Tauri may prepare a replacement when the setting is enabled. Before reconstruction, it must prove or classify the prior process state. Before listener/runtime publication and before any new session, provider, bridge, continuation, recovery bootstrap, reconstruction, shutdown, or host-replacement action, the ownership coordinator also validates every `UnregisteredContainmentRecordV1`, its matching creation receipt, all bounds, unique identities, and non-overlap with registered/teardown ownership. A leftover `armed/reserved` record is never inferred pre-action from missing process evidence: it is atomically changed to `receipt_state=unknown`, `state=containment_uncertain`, `setup_stage=startup_reconciliation`, and `reason_code=startup_armed_without_identity`. For a record with exact persisted identities, creation-time-aware root/descendant/ancestry and Job-accounting reconciliation runs outside all commit/persistence/registry locks; only a complete exact absence proof may set `resolved_absent`. PID reuse, access denial, unavailable or mismatched identity, incomplete ancestry/accounting, or cleanup timeout leaves the record unresolved. A reconciliation-persistence failure is `unregistered_containment_reconciliation_failed` and publishes no listener/runtime. No startup path retries `CreateSession` or reconstructs a provider from an armed/uncertain record. On the same uninterrupted host where setup failed, unresolved record IDs appear only in the bounded `ContainmentStatusV1` projection and unrelated already-registered session reads/attach/resize/exact teardown may continue; new shell/provider/bridge/continuation/recovery/reconstruction actions and ownership release are blocked. An ordinary replacement/healthy-host startup that retains any unresolved record publishes no listener/runtime at all; Tauri surfaces bounded native diagnostics/manual or reboot-repair guidance. Listener publication resumes only after every record is durably resolved. The sole publication exception is the explicit diagnostic `repair_required` host loaded from an exact valid backup when primary is invalid: it may publish a runtime/listener scoped to `Hello`, `GetState`, `ListSessions`, and the exact `reason=repair` prepare/finalize/cancel/native-read/native-authorize/shutdown release transaction. It exposes zero live sessions and rejects every normal session, provider, bridge, continuation, recovery, reconstruction, layout, safety, containment-repair, or storage mutation command. Its repair shutdown bypasses the unresolved-record gate only to release the diagnostic host, preserves the complete source StateV2 and all containment records byte-for-byte, and authorizes no reset or native file mutation. After exact release, only the separate mutex-serialized StorageRepair authority may mutate storage. No other unresolved-record startup receives this exception.

- The prior host process handle is signaled or its recorded PID/start-time identity no longer exists.
- The prior authenticated endpoint no longer answers for the recorded host instance.
- For every prior session, compare the persisted root PID/start time to the live process table through exact Windows process handles. If that exact root lives, recovery is blocked.
- Enumerate live descendants by parent PID plus creation time and compare them to the persisted root lifetime. A descendant whose ancestry crosses the persisted root and whose creation time is within that lifetime blocks recovery.
- A persisted `assigned` Job state allows TermX to require that no exact root or descendant remains. `unassigned` or `unknown`, process-enumeration failure, access denial, ambiguous PID ancestry, or missing creation-time evidence is not proof of death.

No OS Job handle survives a host crash, so TermX does not claim direct post-crash Job membership inspection. The ownership scan is a quarantine gate based on exact process identity and ancestry evidence. If any old root, descendant, or assignment-race result is alive or unverifiable, the record enters `containment_uncertain`. Tauri may start a replacement host for ordinary new sessions, but recovery of the affected cwd/provider conversation is quarantined: no reconstructed shell, provider resume, or continuation is launched until a user-reviewed ownership scan proves the old tree dead. TermX never resumes the same provider conversation in two potentially live process trees.

Once old ownership is safe, Tauri persists the recovery bootstrap, starts the replacement host, waits for atomic bootstrap import, and only then lets React reconstruct eligible shells. Reviewed provider resumes still wait for approval.

A cold launch with stale state but no trustworthy observation of the destructive event presents a review queue rather than silently launching providers.

### 13.4 Explicit restart

Tauri owns the explicit restart transaction; React owns presentation and confirmation. The flow is:

1. Reconcile every existing recovery operation to terminal or delete it through its ordinary eligible path. `PrepareShutdown { reason: confirmed_restart }` returns `recovery_in_progress` while any operation is nonterminal; restart never preserves or rewinds an operation journal.
2. Call `PrepareShutdown { reason: confirmed_restart }`; the host classifies all live managed sessions from durable records, returns the complete canonical `ShutdownPreviewV1`, immutable hash, prepared safety revision, an empty affected-operation list, and pending `ShutdownPreparationV1` from one `commit_lock` snapshot.
3. Show only that returned preview’s consequences and exact recovery limitations.
4. Persist `ConfirmationV1 { schema_version: 1, confirmation_id, confirmed_at, action: explicit_restart, preview_hash, affected_operation_ids: [] }` through `CommitSafetyState` with the sole `StoreConfirmation` mutation, using the preparation values exactly and omitting reviewed-only fields. No recovery operation references the shutdown confirmation.
5. Call `FinalizeShutdownPreparation { preparation_id, confirmation_id }`; the host verifies the exact completed confirmation sequence and returns `ShutdownAuthorizationV1` bound to the current post-confirmation revision.
6. Invoke native `ConfirmShutdown { authorization }`; Tauri re-reads the finalized host preview, presents the native OS confirmation, and on affirmative choice sends the native-key MAC through `AuthorizeShutdown`.
7. After `ShutdownAuthorized`, send correlated `Shutdown { reason: confirmed_restart, authorization }`; the host revalidates and consumes the exact finalized authorization, then Tauri waits up to five seconds for clean exit and runtime ownership release.
8. If shutdown fails or any old tree is alive/unverifiable, stop in `manual_intervention_required`; do not start recovery.
9. Only after exact old-host release, Tauri reads the last durable managed records, writes fresh recovery drafts into a new bootstrap, starts the replacement host, and imports host-constructed `planned/not_started` operations. These are new operation IDs and new previews; the old restart confirmation authorizes no later recovery edge.

There is no rollback that resurrects a host after confirmed shutdown. A replacement-start failure leaves the durable plan pending and may retry only within the bounded host-launch policy; provider operations remain `not_started`. Manual mode places each operation in the active, nonterminal `manual_intervention_required` phase with exact safe instructions rather than entering `provider_resuming`; the user later completes it through `CompleteRecoveryOperation` as `manually_completed` or `cancelled`. Reviewed mode enters `provider_resuming` only after per-record approval. Unattended does so only after eligibility and kill-switch checks.

### 13.5 Protocol-major mismatch

A live mismatch:

- Leaves the host and every session untouched.
- Shows exact UI, host, and protocol versions.
- Offers non-destructive exit/update guidance.
- Offers an explicit restart action only behind recovery preview and confirmation.
- Never auto-restarts, even when the selected recovery mode is Unattended.

If the old host is already proven dead, starting a replacement is permissible because TermX is not causing the destructive event.

### 13.6 Quit

“Quit TermX” is the only normal UI action that initiates a quit shutdown. Closing the window exits only the UI. Quit uses the full native-authorized transaction, never a direct WebSocket command:

1. React calls `PrepareShutdown { reason: quit }`; the host returns the complete canonical preview/preparation with `action=explicit_quit` and refuses preparation if any session action is ambiguous or any close/containment record is uncertain.
2. React displays that exact preview and stores only the host-matching `ConfirmationV1 { action: explicit_quit, affected_operation_ids: <the exact sorted prepared set> }`; no operation preview hashes, prepared safety revision, or other reviewed-only fields are permitted. The affected IDs are shutdown binding data, not references attached to the operations.
3. React calls `FinalizeShutdownPreparation`, then invokes native `ConfirmShutdown` with the returned authorization.
4. Tauri independently retrieves the finalized preview with the shutdown-authority-key MAC, shows the native OS confirmation dialog, and sends `AuthorizeShutdown` only after affirmative native input.
5. Only after `ShutdownAuthorized` does React send `Shutdown { reason: quit }`. Tauri waits for exact process/runtime/mutex release as defined in section 7.5.

Cancellation at either UI/native confirmation leaves the host and sessions untouched except for the durable shutdown confirmation record; no recovery operation is cancelled before a final authorized Quit `Shutdown`, and no restart record is reclassified before a final authorized restart `Shutdown`. The host immediately invalidates the in-memory preparation/finalization/native authorization on explicit cancellation; once invalidated or expired and no live transaction references it, the shutdown confirmation is eligible for deterministic deletion regardless of operation state and grants no later shutdown. Timeout, changed state, cancellation-persistence failure, or uncertain cleanup fails closed. Protocol-v1 legacy hosts are excluded from this path and remain Manual-close-only because they cannot enforce the native-only authorization boundary.

## 14. Settings

Settings live in the main renderer. Recovery/UI safety settings are schema-versioned inside the separately revisioned host-owned `safety_state`; profile configuration is edited through the separately versioned native `config.json` flow in section 12. Settings are never stored inside the opaque layout document.

### 14.1 Recovery modes

- **Manual:** TermX reports affected sessions and exact safe commands. It launches and sends nothing.
- **Reviewed:** TermX previews each launch, resume action, and continuation. Plain interactive providers require explicit user confirmation of readiness and acceptance; TermX does not parse terminal contents.
- **Unattended:** An individual operation is eligible only when its provider adapter proves exact conversation identity, machine-readable readiness, and unambiguous continuation acceptance.

The global mode cannot upgrade an ineligible adapter or recovery record. The UI shows the per-provider capability and the missing evidence. It never silently downgrades while claiming unattended recovery occurred.

### 14.2 Exact defaults

```text
recovery.mode                         = reviewed
auto_recover_on_ui_crash             = true
auto_recover_on_host_crash           = true
auto_restart_on_protocol_mismatch    = false
auto_submit_after_preview            = false
require_preview                      = true
continuation_text                    = "Continue. We accidentally terminated."
max_parallel_recoveries              = 1
shell_launch_timeout                 = 30 seconds
provider_readiness_timeout           = 30 seconds
send_acknowledgement_timeout         = 10 seconds
per_session_deadline                 = 2 minutes
max_launch_retries                   = 2
max_resume_retries                   = 2, only for host-classified failed_pre_action outcomes
max_structured_bridge_retries         = 1, only when the host durably proves the primary bridge thread was never resumed
max_send_retries                     = 0
retry_backoff_cap                    = 2 seconds
kill_switch_enabled                  = true, persisted
notifications_enabled                = true
notify_start_success_failure         = true
audit_log_enabled                    = true
```

`auto_recover_on_ui_crash` means reconnect and reattach, not provider relaunch. `auto_submit_after_preview` remains false by default. Waiting at a human review gate does not eventually convert into auto-approval.

Per-provider `allow_unattended` defaults false for Claude CLI, Codex CLI, and future adapters until each adapter passes qualification tests.

## 15. Managed AI-session recovery

This feature is a narrow continuity mechanism for destructive host loss. It is not cross-session context sharing or an AI assistant.

### 15.1 Provider-adapter and capability contract

Every provider adapter implements:

```text
ProviderAdapter {
  id() -> AdapterId
  version() -> AdapterVersion
  probe(executable) -> AdapterQualification
  prepare_managed_launch(context) -> ManagedLaunchRecipe
  build_resume(binding) -> ArgvRecipe
  classify_pre_action_failure(action, host_result) -> RetryClass
  readiness_capability() -> StructuredSignal | HumanConfirmation | Unsupported
  acceptance_capability() -> StructuredAcceptance | HumanConfirmation | Unsupported
  structured_bridge_launch_recipe(binding: StructuredChannelBindingV1) -> StructuredBridgeLaunchRecipeV1
  encode_structured_submission(operation, exact_bytes, channel_nonce) -> InputRecipe
  normalize_structured_evidence(operation, attestation: ChannelAttestationV1, payload: DecodedStructuredPayload) -> VerifiedEvidence
}
```

`ArgvRecipe` is an executable plus argv vector. `ManagedLaunchRecipe` contains a host-generated `ProviderConversationV1`, an exact qualified initial `ArgvRecipe`, and the exact future resume `ArgvRecipe`; for Claude the same host call generates the UUID, returns initial arguments containing `--session-id <uuid>`, and returns resume arguments containing `--resume <same uuid>`. The host rejects a recipe whose executable/identity differs between the two actions or whose conversation selector is not proven by qualification. `InputRecipe` is a byte buffer of 1..=262,139 bytes admitted atomically by the host’s priority-input queue and never supplied by React. Only the host invokes adapter builders/encoders. To start or resume a provider inside an already-created shell, the host passes the adapter’s safe argv recipe through the exact versioned encoder registered for that shell profile; that encoder performs per-argument quoting/escaping, emits one invocation plus its terminator, rejects NUL/control characters and unsupported profiles, and is fixture-tested to reproduce the original argv exactly. The resulting command bytes are ephemeral and may be carried as `InputRecipe`; TermX persists the exact safe argv vectors but never an arbitrary opaque shell command string. A profile without a qualified argv-to-input encoder is Manual-only. `classify_pre_action_failure` may return retryable only when the host result proves the relevant process-creation or queue-admission boundary was not crossed; adapter parsing of terminal output or a client timeout cannot establish this.

The exact structured-channel bootstrap and first-frame schemas are:

```text
SecretHex256 = exactly 64 lowercase hexadecimal characters decoding to 32 bytes

StructuredChannelBindingV1 {
  schema_version: 1,
  channel_id: UUID,
  pipe_endpoint_id: UUID,
  operation_id: UUID,
  reconstructed_terminal_session_id: u32,
  launch_attempt_id: UUID,
  resume_attempt_id: UUID,
  structured_bridge_attempt_id: UUID,
  adapter_id: AdapterId,
  adapter_version: string <= 64 UTF-8 bytes,
  qualification_hash: Sha256Hex
}

[M2-SCHEMA-WindowsCommandLineArgvEncoderV1]
WindowsCommandLineArgvEncoderV1 {
  schema_version: 1,
  encoder_id: "windows.command_line_to_argvw",
  encoder_version: "1",
  parser_contract: "CommandLineToArgvW",
  max_command_line_utf16_code_units_including_nul: 32767,
  argv0_source: executable_path,
  application_name_source: executable_path
}

StructuredBridgeLaunchRecipeV1 {
  schema_version: 1,
  executable_path: PortablePath,
  executable_sha256: Sha256Hex,
  executable_version?: string <= 256 UTF-8 bytes,
  argument_vector: [string <= 8 KiB] <= 64 items and 64 KiB total,
  pipe_endpoint_argument_index: u8,
  argv_encoder: WindowsCommandLineArgvEncoderV1
}

DecodedStructuredFrameV1 {
  attestation: ChannelAttestationV1,
  payload: DecodedStructuredPayload
}

StructuredChannelBootstrapV1 {
  schema_version: 1,
  binding: StructuredChannelBindingV1,
  channel_nonce: SecretHex256
}

StructuredChannelHelloV1 {
  schema_version: 1,
  binding_hash: Sha256Hex
}

StructuredChannelEvidencePayloadV1 {
  schema_version: 1,
  provider_conversation: ProviderConversationV1,
  submission_id?: UUID,
  continuation_fingerprint?: Sha256Fingerprint,
  accepted_bytes?: u32,
  observed_at: Timestamp,
  evidence_b64: string,
  evidence_fingerprint: Sha256Hex
}

ChannelAttestationV1 {
  schema_version: 1,
  binding: StructuredChannelBindingV1,
  binding_hash: Sha256Hex,
  frame_kind: readiness|acceptance,
  sequence: U64DecimalString,
  payload_fingerprint: Sha256Hex,
  bridge_qualification_hash: Sha256Hex
}
```

After the suspended bridge is durably registered and resumed, it connects to the substituted user-ACL-protected named-pipe endpoint. The host verifies the connecting client PID equals the exact retained bridge process and its creation `FILETIME` before sending exactly one bootstrap record on that duplex pipe: `magic="TXSB"(4) | version=u16 little-endian(1) | payload_len=u32 little-endian | payload`, where `payload` is the exact RFC 8785/JCS UTF-8 serialization of closed-schema `StructuredChannelBootstrapV1`. `payload_len` is at most 4,096 bytes and the complete record is at most 4,106 bytes. The host writes the exact-length record and changes the pipe state from bootstrap-write to authenticated-frame-read; it never sends a second bootstrap record. The bridge performs one exact-length read and rejects bad magic/version, zero/oversized length, truncation, invalid UTF-8/JSON/JCS schema, trailing record data, duplicate bootstrap data, or invalid nonce encoding. It must then send HELLO as the first framed message within the shared ten-second connect/bootstrap/HELLO deadline. `binding_hash` is exactly `SHA-256(JCS(bootstrap.binding))`; it never includes or reveals `channel_nonce`. Both sides decode the nonce hex to the same 32 raw bytes before key derivation. The closed schemas and section-7 canonicalization rules make bootstrap binding and HELLO hash byte-for-byte interoperable without any inherited handle or secret in argv/environment.

`StructuredChannelHandle` is an internal host transport type, not a provider-adapter method result or extension point. The host alone creates/owns the pipe, connect event, RAII guard, framed codec, MAC/sequence verification, decoded-frame attestation, and channel teardown. After host verification produces `ChannelAttestationV1` plus the closed decoded payload, the adapter may only normalize provider-specific evidence through `normalize_structured_evidence`; it receives no pipe/Job/process handle, endpoint authority, nonce ownership, unverified frame, or lifecycle callback. The concrete M2 channel contract is `StructuredChannelV1`: the host generates a random `pipe_endpoint_id: UUID` and derives the raw endpoint string exactly as `\\.\pipe\termx-structured-v1-<pipe_endpoint_id>`, where `<pipe_endpoint_id>` is the canonical lowercase hyphenated UUID text. It creates that duplex Windows named pipe with a user/SYSTEM/Administrators-only DACL. The UUID—not the redundant raw endpoint string—is the canonical durable endpoint identity and is included in both `StructuredChannelBindingV1` and `BridgeProcessIdentityV1`; startup, teardown, and repair derive the same raw string when needed and reject any binding/process mismatch. It asks the exact operation-bound adapter for `StructuredBridgeLaunchRecipeV1`, validates the recipe’s executable path/hash/version and exact host-pinned `argv_encoder` against the current qualification and operation qualification hash, validates all argv bounds, requires `pipe_endpoint_argument_index < argument_vector.length`, and requires exactly one element at that index to equal `__TERMX_PIPE_ENDPOINT_V1__`. It replaces that sentinel with the host-created endpoint before command-line encoding. The adapter may provide only this bounded typed recipe; it cannot provide the endpoint, an opaque or pre-encoded final command line, bootstrap secret, environment mutation, Job handle, or launch callback.

The host constructs full logical argv as `[executable_path] + substituted_argument_vector` and applies the exact closed inverse of the Windows `CommandLineToArgvW` parser to every element, including `argv[0]`. Every argument is quoted. An empty argument encodes as `""`; a run of backslashes immediately before a literal quote is doubled and the quote is escaped; trailing backslashes before the closing quote are doubled; all other backslashes remain unchanged. This preserves whitespace, tabs, empty strings, embedded quotes, and trailing backslashes after parsing. The host rejects NUL, invalid UTF-16/lone surrogates, per-argument or aggregate bound violations, and any encoded command line longer than 32,767 UTF-16 code units including its one terminating NUL. It allocates a separately owned mutable UTF-16 command-line buffer and calls `CreateProcessW(lpApplicationName=executable_path, lpCommandLine=mutable_buffer, ...)`; it never invokes a shell and the adapter never supplies `lpCommandLine`. The shell-profile argv-to-terminal-input encoder is a separate contract and is not reused for native bridge creation. Structured bridge qualification includes the exact encoder ID/version and fails before process creation if it differs from the host-compiled contract.

Before `CreateProcessW`, the host creates the duplex byte-mode named-pipe server exactly as `CreateNamedPipeW(endpoint, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536, 0, non_inheritable_SECURITY_ATTRIBUTES)`, arms exactly one overlapped `ConnectNamedPipe`, and retains the server handle and connect event in the setup RAII guard. `ERROR_IO_PENDING` is the normal armed state and `ERROR_PIPE_CONNECTED` is accepted only with the same later peer-identity proof; every other result fails before process creation. No pipe, process, thread, Job, event, bootstrap, or standard-I/O handle is inheritable, and no handle or secret appears in argv or environment.

The native call initializes `STARTUPINFOEXW`, size-queries and allocates one `PROC_THREAD_ATTRIBUTE_LIST`, and installs exactly one attribute: `PROC_THREAD_ATTRIBUTE_JOB_LIST` containing the single preconfigured dedicated bridge Job. It constructs an explicit host-owned sanitized Unicode environment block containing only the exact M2 allowlist `SystemRoot`, `WINDIR`, `COMSPEC`, `TEMP`, and `TMP` copied from the host after strict validation, with case-insensitive duplicate-name rejection, deterministic case-insensitive name order, strict UTF-16 validation, and one double-NUL terminator. `PATH`, inherited credentials/tokens, proxy credentials, cloud/provider keys, TermX runtime/shutdown secrets, and the channel nonce are absent unless a future qualification explicitly adds a named non-secret value under the same closed allowlist; the adapter cannot supply or mutate the block. It calls `CreateProcessW` with `dwCreationFlags=CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT`, the separate executable `lpApplicationName`, the mutable NUL-terminated UTF-16 command-line buffer, `lpEnvironment` pointing to that sanitized block rather than `NULL`, and `bInheritHandles=FALSE`. That Job is configured before launch with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, `JOB_OBJECT_LIMIT_ACTIVE_PROCESS=1`, and no breakaway, and its retained handle uses `JOB_OBJECT_ASSIGN_PROCESS | JOB_OBJECT_QUERY | JOB_OBJECT_SET_ATTRIBUTES | JOB_OBJECT_TERMINATE | SYNCHRONIZE`. Assignment is complete before any bridge instruction executes, and the bridge cannot spawn a child. The bridge process handle retains `PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE`; assignment paths additionally require `PROCESS_SET_QUOTA | PROCESS_TERMINATE`. A bridge setup RAII guard owns process/thread/Job/pipe/event handles and attribute storage until durable activation or proven cleanup. `DeleteProcThreadAttributeList`, attribute-buffer release, connect cancellation/event closure, thread-handle closure, and all process/Job/pipe cleanup run on every success/failure path.

Before `ResumeThread`, the host verifies exact post-spawn PID/creation `FILETIME` and Job accounting, durably persists the exact process identity plus channel ID, binding hash, endpoint identity, and structured-bridge attempt ID, and requires the pipe/connect/RAII setup to remain complete. Persistence or verification failure terminates the dedicated Job, waits on the exact process handle, proves zero Job accounting and that the primary thread never resumed, and only then may classify `failed_pre_action`. `ResumeThread` is called exactly once. After resume, the bridge opens the substituted endpoint with `CreateFileW`; the host completes the one armed connection, calls `GetNamedPipeClientProcessId`, opens that PID with `PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE`, and verifies `GetProcessId` plus `GetProcessTimes` against the retained process identity. Only after that exact peer proof does the host write one exact `TXSB` bootstrap record, flush it, and transition the pipe from bootstrap-write to authenticated-frame-read. HELLO must be the first frame within the shared ten-second connect/bootstrap/HELLO deadline. The bridge performs no provider/API instruction before it has validated the complete bootstrap. Any failure after `ResumeThread`, including connect, peer verification, bootstrap write/flush, HELLO, or active-state persistence, is never `failed_pre_action`; it becomes `unknown`, `unknown_external_action`, or `containment_uncertain` according to exact cleanup proof and is never automatically retried.

If `CreateProcessW` fails, cleanup frees attributes and closes the Job/thread/process/pipe/event resources without any child-destructive action; the process handle is never closed before teardown ownership is durably registered or cleanup is proven. The named-pipe endpoint appears only in the single substituted argument. The one bootstrap record carries a one-time 256-bit `channel_nonce`, operation ID, reconstructed session ID, current launch/resume attempt IDs, adapter ID/version/qualification hash, and host-generated channel ID; nonce and binding never appear in argv, environment, terminal bytes, logs, React, or durable state. A production adapter bridge must be a pinned executable included in the qualification hash and must connect to a provider’s documented local app-server/structured API; plain PTY providers do not qualify. Qualification must additionally prove that bridge startup/HELLO/evidence observation is read-only and cannot submit, resume, create, or mutate a provider conversation; continuation mutation occurs only through the separately journaled `SubmitRecoveryInput` path.

Structured bridge lifecycle is part of the operation journal and shares the operation’s `session_action_gate`. After provider resume is durably `admitted` and before structured readiness can advance, the host acquires `kill_switch_action_gate` before that session gate, requires the caller-observed `expected_kill_switch_generation: U64DecimalString` to equal the current persisted disengaged generation, and starts a bridge attempt only from initial/prior `structured_bridge_state=not_started|failed_pre_action`. It enforces `max_structured_bridge_retries` as additional attempts, increments `structured_bridge_attempts`, generates `current_structured_bridge_attempt_id`, and includes that exact ID in both `StructuredChannelBindingV1` and `BridgeProcessIdentityV1`. After all pipe/Job/suspended-launch preparation and immediately before `CreateProcessW`, it re-reads the same generation and requires `engaged=false`; a mismatch or engagement fails before process creation and is durably classified `failed_pre_action` without consuming an OS bridge attempt. Only then does it create the suspended bridge in its preconfigured Job. Once `CreateProcessW` returns, it obtains creation time from the retained process handle and durably commits `structured_bridge_state=creating_suspended` plus exact `BridgeProcessIdentityV1` before `ResumeThread`; persistence failure terminates the Job through the setup guard, waits for the exact process handle and zero Job accounting, and may commit `failed_pre_action` only after proving the primary thread never resumed and the exact bridge process/Job are gone. That durable classification alone permits a fresh bridge attempt; timeout, transport loss, or incomplete cleanup does not. The host resumes exactly once, validates the named-pipe peer identity, sends the one bootstrap record, authenticates HELLO within the shared ten-second connect/bootstrap/HELLO deadline, and commits `structured_bridge_state=active` before accepting evidence. For Unattended mode this occurs while phase remains `provider_resuming`, allowing structured readiness to perform the defined internal edge. For Reviewed mode, successful bridge activation is followed by the ordinary `provider_resuming -> awaiting_readiness_confirmation` transition before evidence admission opens; readiness frames are never state-advancing in Reviewed mode, while the active channel remains available for the later preview-bound structured acceptance when that capability was selected. A failure or crash after resume but before that active commit is never classified pre-action: the operation records `unknown`/`unknown_external_action` or requires Reviewed manual intervention and never launches a replacement bridge automatically. At most one non-closed bridge identity may exist per operation.

Normal channel closure first stops evidence admission, closes the pipe, calls `TerminateJobObject`, waits up to five seconds for the exact process handle to signal, verifies Job accounting zero, and durably commits `structured_bridge_state=closed` plus clears `structured_bridge_process`; only after that persistence succeeds may it close the retained Job/process handles. If that final persistence fails, the still-owned zero-accounting Job/process handles remain retained and the operation stays nonterminal/blocked until persistence can be retried or startup reconciles it; it does not falsely claim `containment_uncertain` merely because durable bookkeeping failed after exact zero-process proof. Timeout, inaccessible identity/accounting, or an observation contradicting the one-process/no-breakaway invariant commits `containment_uncertain`, blocks automatic completion/retry/ordinary close, and retains the exact identity and every available ownership handle. `CloseSession` may proceed only after normal bridge cleanup has durably reached `closed`; if cleanup becomes `containment_uncertain`, its graveyard commit atomically moves (never copies) the retained bridge identity from `RecoveryOperationV1.structured_bridge_process` into `TeardownRecordV1.structured_bridge_process`, leaves the operation’s bridge state `containment_uncertain` with its process field absent, and makes that exact teardown generation the sole durable process-ownership record. The zero-process proof/teardown repair includes that identity. Operation completion, superseded attempt, cancellation, evidence timeout, and host shutdown all run this same cleanup before releasing the session gate and cannot terminalize, supersede, cancel, or tear down the session while bridge state is `creating_suspended|active|unknown|containment_uncertain`.

Before listener/runtime publication, startup reconciles every operation or teardown record with `structured_bridge_state=creating_suspended|active|unknown|containment_uncertain` or a retained bridge identity. The old Job’s sole handle should have closed and killed the process; the replacement nevertheless opens only a creation-time-verified exact handle, checks the pinned executable hash/path, and proves it signaled. A still-live exact bridge is terminated through that retained handle and waited; PID-only termination is forbidden. Absence/signaled proof closes the bridge journal, but an operation that could have resumed without already persisted acceptance becomes terminal `unknown_external_action` and is never relaunched; persisted accepted evidence may proceed only to its already-defined recovered completion after cleanup. If exact absence/termination cannot be proved, startup fails before listener publication as `structured_bridge_containment_uncertain`. Because the bridge Job admits one process and no breakaway, no unbounded descendant scan is needed; any observation contradicting that invariant is containment uncertainty.

Frames use unsigned little-endian fields and this exact authenticated shape: `magic="TXSC"(4) | version=u16 little-endian(1) | kind=u16 little-endian | channel_id=16 RFC 4122 network-order UUID bytes | sequence=u64 little-endian | payload_len=u32 little-endian | payload | mac=32 bytes`. Frame kinds are exactly `HELLO=0x0001`, `READINESS=0x0002`, and `ACCEPTANCE=0x0003`; every other numeric kind is invalid. The fixed overhead is exactly 68 bytes; `payload_len` is at most 65,536 bytes, so the complete frame is at most 65,604 bytes. The bridge derives `frame_key=HMAC-SHA-256(channel_nonce_raw_32_bytes, UTF8("termx-structured-channel-v1") || channel_id_bytes)` and computes `mac=HMAC-SHA-256(frame_key, all preceding frame bytes exactly as transmitted)`. The first bridge frame must be `kind=HELLO`, `sequence=0`, and its payload must be exactly `JCS(StructuredChannelHelloV1 { schema_version: 1, binding_hash: SHA-256(JCS(bootstrap.binding)) })`; it contains no other field. `READINESS|ACCEPTANCE` payloads are exactly JCS UTF-8 `StructuredChannelEvidencePayloadV1`, with readiness requiring the three submission fields absent and acceptance requiring all three present. The encoded payload, including base64 expansion and envelope fields, must satisfy the 65,536-byte frame-payload cap; `evidence_b64` additionally decodes to at most 64 KiB and its fingerprint is over those decoded bytes. The host verifies DACL/peer connection, channel ID, version, exact binding hash, length, and MAC in constant time before accepting HELLO; later evidence frames require strictly increasing sequence beginning at 1. Duplicate, skipped, wrapped, wrong-kind, malformed, oversized, or bad-MAC frames close the channel, discard pending evidence, record a safe diagnostic, and force Reviewed intervention. The channel accepts no host commands and is closed at operation completion, superseded attempt, timeout, bridge exit, or connection loss. The host codec returns a host-created `ChannelAttestationV1` with the exact immutable binding/hash, normalized frame kind, decimal-string sequence, SHA-256 of the exact transmitted payload bytes, and verified bridge qualification hash; no attestation field is accepted from the bridge. Only after that verification does the host call adapter `normalize_structured_evidence(operation, attestation, payload)`, then submit the resulting bounded `VerifiedEvidence` internally through `StructuredEvidenceSink`; there is no public request or receipt delivery. The M2 fake structured adapter exercises the identical frame codec/MAC/replay rules through an in-process duplex transport with a test-only deterministic nonce source injected below the production interface; production code exposes no evidence injection method. `VerifiedEvidence` is the closed normalized statement whose fields satisfy section 15.4 before persistence. `AdapterQualification` records the exact executable path, executable version output, bridge executable hash/version, adapter version, supported identity flags/selectors, readiness mechanism, acceptance mechanism, and maximum capability:

```text
manual | reviewed | unattended
```

Qualification identity is deterministic: SHA-256 of the executable bytes, absolute canonical executable path, file version metadata, and SHA-256 of normalized `--version` stdout (UTF-8, CRLF converted to LF, one trailing LF removed). `AdapterVersion` is the TermX adapter schema/version string, not provider output. Qualification is cached only for that exact tuple and is re-run after any change. Fixtures pin argv arrays, exit status, stdout/stderr classification, and capability result for each supported baseline. A record stores the qualification evidence that existed at initial launch; recovery requires the current adapter to support the persisted record format.

Unattended requires all three:

1. Exact conversation identity.
2. Machine-readable resumed-and-ready state.
3. Unambiguous continuation acceptance.

If any is absent, the operation stops at Reviewed or Manual and surfaces the reason. Tests use a fake structured adapter plus versioned Claude/Codex CLI fixtures; a plain provider is never upgraded from screen text.

The M2 release pins and qualifies the locally verified baseline CLI contracts before enabling managed launch:

- Claude Code baseline: version 2.1.214. Qualification must prove `--session-id <uuid>` is accepted for initial launch and `--resume <uuid>` selects that exact session. If either probe fails on the installed version, TermX disables managed Claude launch/recovery and shows the reason.
- Codex baseline: version 0.144.4. Qualification must prove `codex resume <id-or-name>` syntax. IDs are preferred. Names are accepted only when the user explicitly registers one and adapter validation proves it resolves uniquely; ambiguous names are Manual-only.

These version numbers qualify the design baseline, not every future release. Upgrades require the probe and adapter fixtures to pass again.

### 15.2 Claude Code adapter

A Claude conversation is deterministically recoverable only when TermX manages its initial launch:

1. TermX generates a UUID before launch.
2. It durably stores the UUID and launch record.
3. It launches Claude with `--session-id <uuid>` and an optional display name.
4. Recovery uses exactly `claude --resume <uuid>`.

TermX never uses `claude --continue` for recovery. A session launched with no persistence is marked unrecoverable.

Plain Claude Code PTY does not provide a supported structured “exact session resumed and ready for input” event or an unambiguous provider acknowledgement for an arbitrary prompt. Prompt-shaped screen text is not authoritative. Therefore the M2 Claude CLI adapter is Manual/Reviewed only.

### 15.3 Codex CLI adapter

Codex recovery may use an explicitly persisted ID or name:

```text
codex resume <id-or-name>
```

A reviewed continuation may be supplied only after preview and confirmation. TermX never uses `--last`, a picker, arbitrary terminal scraping, or private Codex state to infer identity.

The plain Codex CLI likewise lacks a supported structured resumed-ready event and unambiguous arbitrary-prompt acceptance. It is Manual/Reviewed only.

`codex app-server` is the appropriate future structured-adapter direction, but it is not added to M2 solely to unlock auto-submit.

### 15.4 Exact safety and recovery schemas

Common serialization rules:

- UUIDs are lowercase hyphenated strings.
- Timestamps are UTC RFC 3339 strings with millisecond precision.
- `U64DecimalString` is canonical base-10 with no sign or leading zeros except `0`.
- Paths are UTF-8 JSON strings containing the Windows path exactly as selected; no environment values are persisted.
- Unknown enum values and unknown schema versions are rejected, not defaulted.
- `AdapterId` is a lowercase ASCII string matching `[a-z0-9][a-z0-9._-]{0,127}`.
- `PortablePath` is a UTF-8 JSON string at most 32 KiB containing no NUL.
- When present, `initial_launch_argument_vector`, and always-present `resume_argument_vector`, each contain at most 64 strings, each at most 8 KiB, with a total UTF-8 size of 64 KiB per vector.
- A conversation identity is at most 512 UTF-8 bytes. A safe cwd uses `PortablePath`.

```text
SettingsV1 {
  schema_version: 1,
  recovery_mode: manual|reviewed|unattended,
  auto_recover_on_ui_crash: bool,
  auto_recover_on_host_crash: bool,
  auto_restart_on_protocol_mismatch: bool,
  auto_submit_after_preview: bool,
  require_preview: bool,
  continuation_text: string <= 4096 UTF-8 bytes,
  max_parallel_recoveries: u8 1..=8,
  shell_launch_timeout_ms: u32,
  provider_readiness_timeout_ms: u32,
  send_acknowledgement_timeout_ms: u32,
  per_session_deadline_ms: u32,
  max_launch_retries: u8,
  max_resume_retries: u8,
  max_structured_bridge_retries: u8,
  max_send_retries: 0,
  retry_backoff_cap_ms: u32,
  kill_switch_enabled: bool,
  notifications_enabled: bool,
  notify_start_success_failure: bool,
  audit_log_enabled: bool,
  provider_allow_unattended: { AdapterId: bool } <= 128 entries and 16 KiB serialized
}

KillSwitchV1 {
  schema_version: 1,
  engaged: bool,
  generation: U64DecimalString,
  engaged_at?: Timestamp,
  reason_code?: user|policy|recovery_error
}

ProviderConversationV1 {
  kind: uuid|id|name,
  value: string,
  capture_method: termx_launcher|user_registered|structured_adapter
}

CapabilityEvidenceV1 {
  identity: exact|user_asserted|unsupported,
  readiness: structured|human_confirmation|unsupported,
  submission: structured_acceptance|human_confirmation|unsupported,
  qualification_hash: Sha256Hex
}

ShellLaunchBindingV1 {
  profile_id: string <= 256 bytes,
  profile_kind: windows_powershell|powershell_core|git_bash|command_prompt|wsl,
  executable_path: PortablePath,
  executable_sha256: Sha256Hex,
  executable_version?: string <= 256 bytes,
  argument_vector: [string <= 8 KiB] <= 64 items and 64 KiB total,
  argv_encoder_id: string <= 128 bytes,
  argv_encoder_version: string <= 64 bytes
}

RecoveryExecutionBindingV1 {
  stable_tab_id: UUID,
  provider: claude_cli|codex_cli|structured_test,
  adapter_id: AdapterId,
  adapter_version: string <= 64 bytes,
  qualification_hash: Sha256Hex,
  shell: ShellLaunchBindingV1,
  safe_cwd: PortablePath,
  provider_executable_path: PortablePath,
  provider_executable_sha256: Sha256Hex,
  provider_executable_version?: string <= 256 bytes,
  resume_argument_vector: [string <= 8 KiB] <= 64 items and 64 KiB total,
  provider_conversation: ProviderConversationV1
}

`expected_record_binding_hash` is `SHA-256(JCS(record_binding_projection))`, where `record_binding_projection` is exactly the current record’s `stable_tab_id`, provider, adapter ID/version, `capability_evidence.qualification_hash`, complete immutable `ShellLaunchBindingV1`, safe cwd, provider executable path/hash/version, bounded `resume_argument_vector`, and provider conversation in the same closed typed shape as `RecoveryExecutionBindingV1`. The host rejects a draft when that hash, the expected safety revision, the record’s recoverable status, or its current provider/shell executable and encoder qualification no longer matches; it never trusts the hash as a substitute for loading and validating the record. The operation constructor copies that projection into `execution_binding` and independently recomputes its canonical hash. `ShellLaunchBindingV1` is captured from the exact active session/profile resolution when the recovery record is created, not looked up from mutable `config.json` during reconstruction. Before recovery-bound `CreateSession`, the host reopens and hashes the exact frozen shell executable, requires its version/hash and registered encoder ID/version to match, uses only the frozen shell argv and safe cwd, and fails the operation as `unrecoverable` before process creation if any component is unavailable or changed. It never substitutes a newly discovered profile executable, current default arguments, or a different encoder under the same profile ID.

StructuredRecoveryEvidenceV1 {
  schema_version: 1,
  evidence_id: UUID,
  operation_id: UUID,
  evidence_kind: readiness|acceptance,
  adapter_id: AdapterId,
  adapter_version: string <= 64 bytes,
  qualification_hash: Sha256Hex,
  provider_conversation: ProviderConversationV1,
  reconstructed_terminal_session_id: u32,
  launch_attempt_id: UUID,
  resume_attempt_id: UUID,
  structured_bridge_attempt_id: UUID,
  submission_id?: UUID,
  continuation_fingerprint?: Sha256Fingerprint,
  accepted_bytes?: u32,
  observed_at: Timestamp,
  evidence_b64: string whose decoded payload is <= 64 KiB,
  evidence_fingerprint: Sha256Hex
}

StructuredRecoveryEvidenceRefV1 {
  schema_version: 1,
  evidence_id: UUID,
  evidence_kind: readiness|acceptance,
  adapter_id: AdapterId,
  adapter_version: string <= 64 bytes,
  qualification_hash: Sha256Hex,
  launch_attempt_id: UUID,
  resume_attempt_id: UUID,
  structured_bridge_attempt_id: UUID,
  submission_id?: UUID,
  continuation_fingerprint?: Sha256Fingerprint,
  accepted_bytes?: u32,
  observed_at: Timestamp,
  evidence_fingerprint: Sha256Hex
}

RecoveryIdentityRegistrationV1 {
  schema_version: 1,
  stable_tab_id: UUID,
  terminal_session_id: u32,
  provider: codex_cli,
  adapter_id: AdapterId,
  provider_conversation: ProviderConversationV1,
  expected_safety_revision: U64DecimalString
}

RecoveryRecordV1 {
  schema_version: 1,
  stable_tab_id: UUID,
  terminal_session_id?: u32,
  host_instance_id?: UUID,
  provider: claude_cli|codex_cli|structured_test,
  adapter_id: AdapterId,
  adapter_version: string <= 64 bytes,
  shell_launch_binding: ShellLaunchBindingV1,
  safe_cwd: PortablePath,
  provider_executable_path: PortablePath,
  provider_executable_sha256: Sha256Hex,
  provider_executable_version?: string <= 256 bytes,
  initial_launch_argument_vector?: [string <= 8 KiB] <= 64 items and 64 KiB total,
  resume_argument_vector: [string <= 8 KiB] <= 64 items and 64 KiB total,
  provider_conversation: ProviderConversationV1,
  capability: manual|reviewed|unattended,
  capability_evidence: CapabilityEvidenceV1,
  initial_launch_action_state: not_managed|submitting|admitted|failed_pre_action|unknown,
  initial_launch_attempts: u16,
  current_initial_launch_attempt_id?: UUID,
  status: live|interrupted|recoverable|unrecoverable|containment_uncertain,
  last_known_at: Timestamp,
  pending_operation_id?: UUID,
  redacted_ineligibility_reason?: string <= 512 bytes
}

`RegisterRecoveryIdentity` is the narrow user-registration path for an already-live ordinary Codex shell. The host requires the named session and stable tab to match, requires `provider_conversation.capture_method=user_registered`, runs the exact current adapter qualification and unique-name/ID validation, captures the complete active `ShellLaunchBindingV1`, safe cwd, provider executable hashes/version, and exact bounded resume argv itself, leaves `initial_launch_argument_vector` absent, and sets `initial_launch_action_state=not_managed`, attempts zero, and current initial attempt absent. It creates the remaining lifecycle, capability, timestamp, and status fields. It cannot register Claude as TermX-managed, cannot claim `structured_adapter`, cannot set unattended capability beyond the current probe, and cannot overwrite a different or nonterminal-bound record. Dead-host bootstrap never carries record copies. The replacement loads each draft’s record from the exact source state identified by `source_state_content_hash`, requires its historical session identity, qualification evidence, and initial-launch journal to remain internally consistent, and requalifies/canonicalizes status and capability before operation construction. A missing record, stale binding hash, or execution-critical mismatch is `bootstrap_conflict`.

RecoveryOperationDraftV1 {
  schema_version: 1,
  operation_id: UUID,
  stable_tab_id: UUID,
  requested_mode: manual|reviewed|unattended,
  expected_record_binding_hash: Sha256Hex,
  expected_safety_revision: U64DecimalString
}

RecoveryOperationV1 {
  schema_version: 1,
  operation_id: UUID,
  stable_tab_id: UUID,
  source_terminal_session_id?: u32,
  reconstructed_terminal_session_id?: u32,
  provider: claude_cli|codex_cli|structured_test,
  adapter_id: AdapterId,
  provider_conversation: ProviderConversationV1,
  execution_binding: RecoveryExecutionBindingV1,
  execution_binding_hash: Sha256Hex,
  action_preview: RecoveryActionPreviewV1,
  mode: manual|reviewed|unattended,
  phase: RecoveryPhase,
  terminal_state?: RecoveryTerminalState,
  preview_hash: Sha256Hex,
  continuation_text: string <= 4096 UTF-8 bytes,
  continuation_fingerprint: Sha256Fingerprint,
  continuation_bytes: u32,
  send_state: not_started|submitting|accepted|unknown,
  launch_action_state: not_started|submitting|created|failed_pre_action|unknown,
  provider_action_state: not_started|submitting|admitted|failed_pre_action|unknown,
  structured_bridge_state: not_required|not_started|creating_suspended|active|closed|failed_pre_action|unknown|containment_uncertain,
  structured_bridge_process?: BridgeProcessIdentityV1,
  launch_attempts: u16,
  resume_attempts: u16,
  structured_bridge_attempts: u16,
  current_launch_attempt_id?: UUID,
  current_resume_attempt_id?: UUID,
  current_structured_bridge_attempt_id?: UUID,
  submission_id?: UUID,
  submitted_bytes?: u32,
  deadline_at: Timestamp,
  created_at: Timestamp,
  updated_at: Timestamp,
  last_safe_error?: SafeRecoveryErrorV1,
  readiness_evidence?: StructuredRecoveryEvidenceRefV1,
  acceptance_evidence?: StructuredRecoveryEvidenceRefV1,
  confirmation_ids: [UUID] <= 16,
  cancellation_requested: bool,
  observed_kill_switch_generation: U64DecimalString
}

SafeRecoveryErrorV1 {
  code: string <= 128 bytes,
  category: startup|transport|identity|auth|trust|permission|cwd|timeout|unknown_external_action|unknown_submission|containment|cancelled,
  retryable: bool,
  redacted_message: string <= 1024 bytes
}

RecoveryReviewPreviewItemV1 {
  operation_id: UUID,
  action_preview_hash: Sha256Hex
}

RecoveryReviewPreviewV1 {
  schema_version: 1,
  action: reviewed_launch|reviewed_resume|reviewed_readiness|reviewed_continuation|reviewed_acceptance,
  safety_revision: U64DecimalString,
  items: [RecoveryReviewPreviewItemV1] <= 1024
}

RecoveryConfirmationTemplateV1 {
  schema_version: 1,
  confirmation_id: UUID,
  action: reviewed_launch|reviewed_resume|reviewed_readiness|reviewed_continuation|reviewed_acceptance,
  affected_operation_ids: [UUID] <= 1024,
  operation_preview_hashes: [RecoveryReviewPreviewItemV1] <= 1024,
  preview_hash: Sha256Hex,
  prepared_safety_revision: U64DecimalString,
  expires_at: Timestamp
}

ConfirmationV1 {
  schema_version: 1,
  confirmation_id: UUID,
  confirmed_at: Timestamp,
  action: explicit_quit|explicit_restart|repair_reset|reviewed_launch|reviewed_resume|reviewed_readiness|reviewed_continuation|reviewed_acceptance,
  affected_operation_ids: [UUID] <= 1024,
  operation_preview_hashes?: [RecoveryReviewPreviewItemV1] <= 1024,
  prepared_safety_revision?: U64DecimalString,
  preview_hash: Sha256Hex
}

RecoveryClassificationPreviewV1 {
  stable_tab_id: UUID,
  provider: claude_cli|codex_cli|structured_test,
  classification: recoverable|reviewed_only|unattended_eligible|unrecoverable|containment_uncertain,
  operation_id?: UUID,
  redacted_reason_code?: string <= 128 bytes
}

RecoveryActionPreviewV1 {
  schema_version: 1,
  operation_id: UUID,
  stable_tab_id: UUID,
  source_terminal_session_id?: u32,
  provider: claude_cli|codex_cli|structured_test,
  adapter_id: AdapterId,
  adapter_version: string <= 64 bytes,
  qualification_hash: Sha256Hex,
  shell: ShellLaunchBindingV1,
  safe_cwd: PortablePath,
  provider_executable_path: PortablePath,
  provider_executable_sha256: Sha256Hex,
  provider_executable_version?: string <= 256 bytes,
  resume_argument_vector: [string <= 8 KiB] <= 64 items and 64 KiB total,
  provider_conversation: ProviderConversationV1,
  effective_mode: manual|reviewed|unattended,
  continuation_text: string <= 4096 UTF-8 bytes,
  continuation_fingerprint: Sha256Fingerprint,
  continuation_bytes: u32,
  planned_actions: [await_human_launch|recreate_shell|await_human_resume|resume_provider|await_human_readiness|await_structured_readiness|await_human_continuation|submit_continuation|await_human_acceptance|await_structured_acceptance] <= 10,
  readiness_capability: structured|human_confirmation|unsupported,
  acceptance_capability: structured_acceptance|human_confirmation|unsupported
}

ShutdownPreviewSessionV1 {
  session_id: u32,
  stable_tab_id?: UUID,
  profile_id: string <= 256 UTF-8 bytes,
  lifecycle: running|exited|closing|close_uncertain,
  containment_state: assigned|unassigned|unknown,
  recovery_classification: recoverable|reviewed_only|unattended_eligible|unrecoverable|containment_uncertain|not_managed,
  operation_id?: UUID
}

ShutdownPreviewV1 {
  schema_version: 1,
  reason: quit|confirmed_restart|repair,
  host_instance_id: UUID,
  data_dir_instance_id: UUID,
  event_cursor: EventCursor,
  safety_revision: U64DecimalString,
  sessions: [ShutdownPreviewSessionV1] <= 4096,
  affected_operation_ids: [UUID] <= 1024
}
```

`RecoveryPhase` is exactly `planned`, `awaiting_launch_approval`, `shell_recreating`, `shell_recreated`, `awaiting_resume_approval`, `provider_resuming`, `awaiting_readiness_confirmation`, `provider_ready`, `awaiting_continuation_approval`, `continuation_confirmed`, `manual_intervention_required`, or `terminal`. `RecoveryTerminalState` is exactly `recovered`, `manually_completed`, `failed`, `unrecoverable`, `timed_out`, `cancelled`, `unknown_external_action`, or `unknown_send_outcome`. `RecoveryActionPreviewV1` is not a renderer-created display DTO: it is the canonical host-created action object stored inside the operation. The renderer may derive a masked view, but every human-reviewed confirmation displays all execution-affecting fields (masking only nonessential portions of the conversation value), the exact continuation text, and the hash; it must not substitute `RecoveryClassificationPreviewV1`. Any change to execution binding, effective mode, planned actions/capabilities, or continuation bytes requires a new operation and hash. `requested_mode=unattended` remains `mode=unattended` only when the operation is fully qualified. With `auto_submit_after_preview=false`, its canonical action preview includes `await_human_continuation` and it takes the explicit reviewed-continuation subpath defined below; this is an intentional human gate inside Unattended mode, not a silent downgrade to `mode=reviewed` and not a claim that continuation submission was unattended.

The host-owned transition table permits only the arrows in section 15.5 plus the exact completion/cancellation rules listed there. `TransitionRecoveryOperation` performs active nonterminal edges, `CompleteRecoveryOperation` performs every terminal edge, and `RequestRecoveryCancellation` records only deferred cancellation while an external pre-send action is in flight. Every terminal completion sets `phase=terminal` and the matching `terminal_state`. `send_state` may transition only `not_started -> submitting -> accepted|unknown`; no reverse edge exists. `SubmitRecoveryInput` changes only send state while phase remains `continuation_confirmed`; acceptance also leaves that phase unchanged until `CompleteRecoveryOperation(... recovered)`. Launch/provider/structured-bridge action state is host-owned and changes only through the recovery-bound `CreateSession`, `StartRecoveryProvider`, the internal structured-bridge lifecycle, their proven-pre-action failure commits, and startup/reconnect reconciliation. `launch_attempts`, `resume_attempts`, and `structured_bridge_attempts` are host-incremented total-attempt counters: the initial attempt is 1, and each configured retry allows one additional classified pre-action attempt. The structured-bridge attempt ID is generated only by the host and binds the exact process identity, bootstrap, frames, evidence, and cleanup for that attempt.

Only safe provider arguments are retained. Records exclude environment values, stdin, tokens, secrets, arbitrary opaque shell commands, terminal capture, and conversation content. Conversation IDs are sensitive metadata and are masked in UI surfaces that do not require the full value.

### 15.5 Recovery state machines

The exact normal transition matrices and mutation owners are:

```text
Reviewed:
planned
  --Transition--> awaiting_launch_approval
  --Transition(begin_attempt=launch, reviewed_launch confirmation)--> shell_recreating
  --recovery-bound CreateSession commits launch action + exact session; Transition(set_reconstructed_terminal_session_id)--> shell_recreated
  --Transition--> awaiting_resume_approval
  --Transition(begin_attempt=resume, reviewed_resume confirmation)--> provider_resuming
  --StartRecoveryProvider commits provider_action_state=admitted; for a structured-qualified operation the host-owned bridge lifecycle reaches active and the recovery coordinator invokes Transition--> awaiting_readiness_confirmation; for structured_bridge_state=not_required the coordinator invokes that same Transition directly after observing the durable admitted state, including startup/reload reconciliation
  --Transition(reviewed_readiness confirmation)--> provider_ready
  --Transition--> awaiting_continuation_approval
  --Transition(reviewed_continuation confirmation)--> continuation_confirmed/not_started
  --SubmitRecoveryInput--> continuation_confirmed/submitting
  --Transition(structured acceptance or reviewed_acceptance confirmation)--> continuation_confirmed/accepted
  --Complete(terminal_state=recovered)--> terminal/recovered

Unattended, qualified adapter only:
planned
  --Transition(begin_attempt=launch; eligibility + kill-switch checks)--> shell_recreating
  --recovery-bound CreateSession commits launch action + exact session; Transition(set_reconstructed_terminal_session_id)--> shell_recreated
  --Transition(begin_attempt=resume; exact identity + kill-switch checks)--> provider_resuming
  --StartRecoveryProvider commits provider_action_state=admitted; host creates/authenticates one active structured bridge; internal StructuredEvidenceSink(readiness)--> provider_ready
  --Transition(auto_submit_after_preview=true)--> continuation_confirmed/not_started
  --OR Transition(auto_submit_after_preview=false)--> awaiting_continuation_approval
       --Transition(reviewed_continuation confirmation)--> continuation_confirmed/not_started
  --SubmitRecoveryInput--> continuation_confirmed/submitting
  --internal StructuredEvidenceSink(acceptance)--> continuation_confirmed/accepted
  --Complete(terminal_state=recovered)--> terminal/recovered

Manual:
planned
  --Transition--> manual_intervention_required
  --Complete(terminal_state=manually_completed|cancelled)--> terminal
```

Every arrow preserves the current send state unless the matrix labels a new one. `shell_recreating` and `provider_resuming` are action-in-progress phases; a structured bridge in `creating_suspended|active` is an internal action-in-progress even while the phase remains `provider_resuming|awaiting_readiness_confirmation|provider_ready|continuation_confirmed`. A classified shell/provider retry commits a self-transition on the corresponding in-progress phase with `begin_attempt` after backoff and immediately before repeating the external action; a classified bridge retry is an internal journal commit allowed only from durable `failed_pre_action` and does not change the recovery phase. A launch failure never fabricates `shell_recreated`; a successful launch records the exact reconstructed session ID before resume can begin. No phase may advance past a bridge-dependent edge and no terminal completion may commit until required bridge cleanup has durably reached `closed`. `updated_at` is generated by the host on every transition, completion, cancellation request, structured-bridge journal change, and internal submit/acceptance commit; clients do not supply canonical timestamps. A reviewed confirmation must pass the action, operation-ID, and exact preview-hash binding defined in section 7.8.

`TransitionRecoveryOperation` remains the sole owner of every recovery-phase edge. The coordinator-triggered plain-provider edge is host-internal, carries no confirmation ID, and is requested only after observing durable `provider_action_state=admitted` or while reconciling that same durable state after startup/reload. It is valid only when `mode=reviewed`; `action_preview.readiness_capability=human_confirmation`; `planned_actions` contains `await_human_readiness`; `phase=provider_resuming`; the current resume attempt, reconstructed session, provider identity, and immutable execution binding match; `send_state=not_started`; `structured_bridge_state=not_required`; `structured_bridge_attempts=0`; and the current bridge attempt, bridge process, channel, pipe, Job, pending evidence, and structured-channel identities are all absent. The edge creates no external action or lifecycle event. One ordinary safety commit changes only `phase=awaiting_readiness_confirmation` plus host `updated_at`, increments `safety_revision` once, installs after persistence, and publishes exactly one full `SafetyStateChanged`. Persistence failure leaves durable `provider_resuming/admitted`; reconciliation may retry only this idempotent phase commit and never resends provider resume or creates a bridge. `reviewed_readiness` confirmation remains the sole owner of `awaiting_readiness_confirmation -> provider_ready`; structured evidence cannot advance a `not_required` operation.

The coordinator-triggered Reviewed structured edge is a separate host-internal `TransitionRecoveryOperation` edge, carries no confirmation ID, and is requested only after the same operation durably records `provider_action_state=admitted` and `structured_bridge_state=active`, including startup/reload reconciliation. It is valid only when `mode=reviewed`; `phase=provider_resuming`; `action_preview.readiness_capability=structured`; `planned_actions` contains `await_structured_readiness`; `send_state=not_started`; provider action is admitted; and the operation's stable tab, reconstructed session, provider conversation, immutable execution binding/hash, current resume attempt ID, current structured-bridge attempt ID, exact `BridgeProcessIdentityV1`, channel ID, pipe endpoint ID, structured-channel binding/hash, Job ownership/accounting, executable identity, and bridge qualification all match the one currently active retained bridge. No pending readiness or acceptance evidence, cancellation, shutdown transaction, superseding attempt, or conflicting durable process owner may exist. The edge admits no evidence and creates, resumes, closes, or retries no process/channel. One ordinary safety commit changes only `phase=awaiting_readiness_confirmation` plus host `updated_at`, increments `safety_revision` once, installs after persistence, and publishes exactly one full `SafetyStateChanged`; if the exact operation is already in that phase with the same active bridge, replay is an idempotent no-op. Persistence failure leaves durable `provider_resuming/admitted/active` and permits retry only of this phase commit. `reviewed_readiness` confirmation remains the sole owner of the next `provider_ready` edge; readiness frames received before or after this transition are never state-advancing in Reviewed mode, and no pending evidence is retained across the human gate.

Coordinator reload/reconnect while the same host and exact active bridge remain alive reconciles this Reviewed prefix before any later action. Durable `provider_action_state=admitted` plus bridge `not_started|failed_pre_action` may start or explicitly retry the bridge only through the ordinary bounded bridge lifecycle and kill-switch gates; admission alone never advances readiness. Durable `active` with exact current identities permits only the structured phase edge above. `creating_suspended|unknown|containment_uncertain`, a resumed bridge without durable active proof, identity drift, missing ownership, or conflicting evidence blocks/fails closed through the existing unknown/containment rules and never launches a replacement bridge automatically. Same-host acknowledgement loss after durable `active` but before the phase edge replays only that edge; loss after the phase commit retains the exact active channel and waits for Reviewed confirmation. A host process crash/restart is different: section 15.1 startup reconciliation first closes or proves absent every retained active bridge identity and, because provider resume may already have happened without durable acceptance, terminalizes the operation as `unknown_external_action` or blocks as `containment_uncertain`; it never replays the phase edge or relaunches provider/bridge. Lost same-host acknowledgements reconcile from the durable operation and bridge identities, never by resending provider resume, recreating a bridge, or accepting evidence as readiness.

`mode=unattended` with `structured_bridge_state=not_required` is `invalid_recovery_transition` at construction, action validation, and startup/reload reconciliation. Plain Claude and Codex therefore remain Manual/Reviewed and can never enter an Unattended provider, readiness, continuation, or acceptance edge.

If `auto_submit_after_preview=false`, an otherwise Unattended-qualified operation transitions from `provider_ready` to `awaiting_continuation_approval`. `PrepareRecoveryReview { action=reviewed_continuation }` explicitly treats that Unattended phase as eligible, the stored confirmation authorizes only the `awaiting_continuation_approval -> continuation_confirmed` edge, and `SubmitRecoveryInput` then requires that exact confirmation. The operation’s stored mode remains `unattended`; launch, resume, readiness, and structured acceptance retain their Unattended gates, while the preview and audit state explicitly record the one human continuation gate. An Unattended operation may skip that state only when its persisted record, current adapter qualification, global mode, per-provider allow flag, immutable preview, kill-switch generation, and `auto_submit_after_preview=true` all satisfy the stated capability gate. Plain Claude/Codex adapters can never take the Unattended-only edges.

Manual instructions are derived from the adapter’s safe argv recipe, but TermX does not launch or send. A user may mark the operation manually completed; TermX never infers completion from terminal text.

Terminal states are exactly:

- `recovered`
- `manually_completed`
- `failed`
- `unrecoverable`
- `timed_out`
- `cancelled`
- `unknown_external_action`
- `unknown_send_outcome`

`manual_intervention_required` is an active waiting phase, not a terminal state. From any active phase with `send_state=not_started` and no external action in flight, user cancellation uses `CompleteRecoveryOperation(... cancelled)`; classified deadline expiry uses `CompleteRecoveryOperation(... timed_out)`; invalid identity/capability uses `CompleteRecoveryOperation(... unrecoverable)`; exhausted retryable pre-action failures use `CompleteRecoveryOperation(... failed)`. While a pre-send external action is in flight, user cancellation or kill-switch engagement uses `RequestRecoveryCancellation`; it never starts the next action, and the coordinator completes `cancelled` only after the host command returns with a durable non-ambiguous action state. On coordinator startup/reload/reconnect, launch/provider action states are reconciled before any retry or later action: `failed_pre_action` permits a fresh begin-attempt after policy/backoff; `created` requires exactly one durable session whose recovery binding matches the operation/current launch-attempt and then permits the normal `shell_recreated` result transition; `admitted` permits the normal readiness edge; `submitting` or `unknown`, a missing/duplicate/conflicting launch binding, or any provider-command result not durably classified as admitted versus pre-action failure completes terminal `unknown_external_action` with the relevant action state set to `unknown`. That terminal is never retried automatically; any matching shell remains visible as an ordinary live/interrupted session for explicit human handling. On the same reconciliation pass, `send_state=submitting` uses `CompleteRecoveryOperation(next_send_state=unknown, terminal_state=unknown_send_outcome)` unless structured or human acceptance was durably committed first. From `accepted`, only `CompleteRecoveryOperation(... recovered)` is permitted. Manual mode transitions from `manual_intervention_required` only through completion as `manually_completed|cancelled`. No transition or completion out of an action/send `unknown` state exists after the single reconciliation commit that creates it.

The shell profile and cwd are restored before provider launch. TermX never reconstructs from an arbitrary shell command string.

### 15.6 Durable at-most-once operation journal

Managed initial provider launch is journaled entirely by host-owned `StartManagedProvider`: its fresh identity/argv record and `submitting` boundary are durable before queue admission, and its exact result is durable before acknowledgement. For destructive-loss reconstruction, before every external phase except continuation transmission, the coordinator atomically persists the corresponding action-in-progress transition with `begin_attempt` and waits for the resulting canonical `SafetyStateChanged`. The external effect itself is then requested only through the host-owned recovery-bound `CreateSession` or `StartRecoveryProvider` command; each command durably records its own `submitting` state before the irreversible process-creation or queue-admission boundary and its exact result state before acknowledging. A successful external action is followed by its exact phase result transition before the next action can begin; a classified retry commits another selected begin-attempt transition immediately before retrying and is legal only after `failed_pre_action`. Continuation transmission uses the same pattern internally: the correlated `SubmitRecoveryInput` request defined in section 15.7 performs the durable `submitting` transition, host-generated submission identity, and PTY enqueue as one host-owned gated operation; React must leave send state `not_started` before calling it.

The journal persists:

- Operation ID.
- Stable tab and terminal session identity.
- Provider and adapter identity.
- Exact provider conversation identity where needed.
- Immutable continuation text, exact UTF-8 byte count, and fingerprint `sha256:v1:<hex>`, all captured by the host from current settings when it constructs the operation. The fingerprint is computed over those exact stored UTF-8 bytes with no whitespace or newline normalization. This bounded body is duplicated into the operation/action preview so a later settings edit cannot change the reviewed or submitted action; it is never copied into audit output, notifications, or ordinary diagnostics.
- Current phase.
- Total launch, resume, and structured-bridge attempt counts, where the initial attempt is count 1 and Settings limits are additional retries.
- Current host-generated launch/resume/structured-bridge attempt IDs and launch/provider/bridge action states, including any exact retained bridge process identity.
- Host-generated continuation submission ID and exact submitted byte count once submitting begins.
- Send state.
- Deadlines and timestamps.
- Last safe classified error.
- Cancellation and kill-switch observations.

Continuation send state is:

```text
not_started -> submitting -> accepted
                     \
                      -> unknown
```

Rules:

- `not_started` may be attempted.
- `SubmitRecoveryInput` durably commits `submitting` before its implementation enqueues continuation bytes to the PTY; React receives no success acknowledgement until both steps complete.
- Structured acceptance, or a stored `reviewed_acceptance` confirmation for a plain Reviewed provider, transitions to `accepted` while phase remains `continuation_confirmed`.
- A crash, disconnect, or acknowledgement timeout while `submitting` is reconciled before any later provider action: on the next coordinator startup, renderer reload, or reconnect snapshot it completes as `unknown_send_outcome` unless acceptance was already durably committed.
- `unknown` is never automatically retried or resent.
- `accepted` is final for send state and never resent; the only remaining phase transition is to terminal `recovered`.
- Continuation send retries are always zero.
- Resume and launch retries occur only when the host durably classified `failed_pre_action` before process creation or provider-command queue admission; client-observed timeout/transport loss alone never proves this.
- Invalid identity, authentication, trust, permission, cwd/workspace, unknown external action, unknown submission, or ambiguous acknowledgement is not retryable.

Plain interactive providers expose no provider-facing idempotency key for arbitrary prompts. Exactly-once or duplicate-free delivery after a post-transmission crash cannot be guaranteed. M2 explicitly chooses at-most-once behavior and accepts the possibility that an ambiguous continuation was not delivered.

### 15.7 Kill switch

The global kill switch is persisted and checked:

1. Before a shell launch.
2. Before provider resume.
3. Before every structured-bridge `CreateProcessW` launch.
4. Before the durable continuation `submitting` transition.
5. Immediately before provider-command, bridge-process, or continuation-transmission admission.

Continuation bytes continue to travel directly from React to the host over the authenticated WebSocket; Tauri never accesses PTY input. Recovery uses a correlated JSON control request, not the ordinary binary-input frame:

```text
SubmitRecoveryInput {
  request_id: UUID,
  session_id: u32,
  operation_id: UUID,
  expected_kill_switch_generation: U64DecimalString,
  continuation_fingerprint: Sha256Fingerprint,
  data_b64: string
}

RecoveryInputAccepted {
  request_id: UUID,
  operation_id: UUID,
  submission_id: UUID,
  accepted_bytes: u32
}
```

`Sha256Fingerprint` is the literal prefix `sha256:v1:` plus 64 lowercase hexadecimal characters. Decoded `data_b64` must be at most 64 KiB and its exact bytes, UTF-8 validity, byte count, and fingerprint must equal the operation’s immutable `continuation_text`, `continuation_bytes`, and `continuation_fingerprint`; supplying bytes from the current mutable settings value is rejected if settings changed after operation creation. The connection must already be attached to the session. The client does not choose a submission identity. While committing `send_state=submitting`, the host generates a fresh `submission_id`, stores it with `submitted_bytes=decoded data_b64 length`, and returns both only in the correlated `RecoveryInputAccepted`; the UUID is therefore unique to this one durable enqueue attempt and cannot be reused for a retry.

The host processes this request under `kill_switch_action_gate` and the operation send/session gate: it verifies attachment, operation/provider binding, exact fingerprint, `phase=continuation_confirmed`, `send_state=not_started`, and the typed current disengaged kill-switch generation. For `mode=reviewed` it verifies a stored `reviewed_continuation` confirmation referenced by the operation, including the exact per-operation entry and canonical batch-preview binding from section 7.8. For `mode=unattended` it always revalidates exact identity, the operation’s persisted readiness-evidence reference against the current adapter ID/version/qualification hash, structured acceptance capability, provider allow flag, and immutable preview. It then accepts exactly one of two continuation gates: `auto_submit_after_preview=true` with no reviewed-continuation confirmation, or `auto_submit_after_preview=false` with the exact stored `reviewed_continuation` confirmation taken through the explicit Unattended reviewed-continuation subpath. Presence of that confirmation does not change the stored mode or weaken structured acceptance requirements.

It then uses the safety-state commit helper to atomically generate and persist `submission_id`, set `submitted_bytes` to the exact decoded length, and set `send_state=submitting` while leaving `phase=continuation_confirmed`, increment `safety_revision`, and sequence a full `SafetyStateChanged` event. Only after that durable commit, and without releasing the send gate, does the registered adapter admit the continuation once. For plain Reviewed PTY adapters, the admitted buffer is exactly the decoded continuation bytes with no normalization. For a qualified structured adapter, the host calls the adapter’s versioned structured-submit encoder with the same exact continuation bytes plus the host-owned operation, attempt, submission, and fingerprint values; the provider protocol envelope may add metadata, but its verifier must later bind acceptance to those exact values. Full admission returns the correlated `RecoveryInputAccepted`, which acknowledges host input-channel admission but not provider acceptance; the operation remains `submitting`. Structured provider acceptance or a stored `reviewed_acceptance` confirmation performs the exact `TransitionRecoveryOperation(expected_phase=continuation_confirmed, expected_send_state=submitting, next_phase=continuation_confirmed, next_send_state=accepted, ...)` commit and emits its own full safety event. The final `CompleteRecoveryOperation(... terminal_state=recovered)` is a separate durable commit/event. Backpressure or transport uncertainty after `submitting` persistence commits `send_state=unknown` and terminal `unknown_send_outcome` through the same helper before returning a classified error; if even that reconciliation persistence fails, the host closes the connection and reload reconciliation performs the same completion before any further provider action. `SetKillSwitch` uses the same gate; it either increments the generation before this request is admitted, or waits behind a write already classified as begun. Thus Tauri remains outside transport, the host remains the sole ConPTY writer, and the UI never reports a send as kill-switch-blocked if transmission had already started.

It blocks new shell launches, managed provider launches/resumes, structured-bridge process launches, and pending continuation sends. It does not terminate recovered shells, retract accepted continuations, or claim to recall bytes already handed to the transport. Each recovery operation also has a stop control.

### 15.8 Audit and notifications

Audit records are append-only JSON Lines with each encoded record capped at 8 KiB and rotated before an append would make a slot exceed 8 MiB. TermX uses exactly five owned slots: one active plus four completed, for an exact 40 MiB quota including slot headers and partial final lines. Rotation uses metadata-only same-volume renames and no copy/temp file: under the single-writer audit lock it flushes/closes active, deletes completed slot 4 first, renames 3->4, 2->3, 1->2, renames active->1, then creates and ACL-verifies an empty active slot before accepting another record. Deletion happens before any new file creation, and a rename does not duplicate file bytes, so every crash prefix remains at or below 40 MiB. Each slot begins with a fixed bounded header containing schema version and monotonic audit-generation number.

On startup, before enabling audit, TermX exclusively opens the audit directory, enumerates only its exact five slot paths plus audit-owned rotation markers from older builds, and enforces the quota. It validates headers, sorts surviving slots by embedded generation, discards malformed/duplicate-oldest audit-owned slots, truncates only a partial final JSON line, and renames the newest at most five files into canonical active/1..4 slots using delete-before-rename without copying. Any unexpected audit-owned temp/marker is deleted before audit is enabled; any non-audit filename is ignored. If deletion, rename, ACL verification, or quota reconciliation cannot prove total owned audit bytes <= 40 MiB, audit enters the degraded failure policy below and performs no append. Startup never promotes malformed content. Audit append/rotation runs on a bounded single-writer queue of 1,024 records or 4 MiB, whichever is reached first. Audit is non-authoritative: append, rotation, ACL, or quota-enforcement failure never rolls back an already durable safety/session transition and never blocks ConPTY I/O, but it sets a persistent `audit_degraded` diagnostic, disables further audit writes for that host instance, emits one redacted high-severity notification through the native bridge, and requires explicit retry/restart from Settings. Queue overflow follows the same fail-closed-for-audit degradation rather than dropping selected records while claiming the audit is complete. The data-directory DACL applies to every generation.

Audit records may contain:

- Event and operation IDs.
- Stable tab/session ID.
- Provider and adapter IDs.
- Masked conversation ID.
- Phase and timestamp.
- Result category and retry count.
- UI and host versions.
- Safe cwd hash or explicitly non-sensitive path.
- Redaction-schema version.

They never contain:

- Runtime token.
- Continuation body.
- Terminal content.
- Provider conversation content.
- Secrets or environment values.
- Full provider IDs where a masked form is sufficient.
- Private provider-state data.

Notifications cover preview availability, start, progress, success, failure, unknown send outcome, unrecoverable records, partial recovery, and kill-switch cancellation. Persistent notifications are used for conditions requiring review. Unfocused-window notifications use the native bridge and omit full IDs and continuation text.

## 16. Error handling and UX

- Host connection errors distinguish discovery failure, host launch failure, authentication failure, protocol mismatch, and transport loss.
- Retriable and non-retriable errors follow structured host codes rather than message parsing.
- Layout conflicts preserve the local semantic operation, load canonical state, and offer a clear conflict notification and undo where practical.
- Terminal truncation is visible; missing scrollback is not silently represented as complete history.
- Recovery previews classify every affected record and explain capability limits.
- Unattended-ineligible providers show “Unattended unavailable for this provider” with the missing evidence.
- Unknown continuation outcomes are persistent, require review, and never imply success.
- Accessibility includes keyboard navigation, focus-visible controls, labels for color-only states, reduced-motion support, and non-color lifecycle indicators.

## 17. Expected file and component map

### 17.1 Existing files likely modified

- `C:\Dev\TermX\Cargo.toml`
- `C:\Dev\TermX\host\Cargo.toml`
- `C:\Dev\TermX\host\src\lib.rs`
- `C:\Dev\TermX\host\src\protocol.rs`
- `C:\Dev\TermX\host\src\server.rs`
- `C:\Dev\TermX\host\src\registry.rs`
- `C:\Dev\TermX\host\src\session.rs`
- `C:\Dev\TermX\host\src\profiles.rs`
- `C:\Dev\TermX\host\src\config.rs`
- `C:\Dev\TermX\host\src\paths.rs`
- `C:\Dev\TermX\host\src\main.rs`
- `C:\Dev\TermX\host\tests\e2e.rs`
- `C:\Dev\TermX\README.md`
- `C:\Dev\TermX\BACKLOG.md`
- `C:\Dev\TermX\.gitignore`

Likely focused host additions:

- `C:\Dev\TermX\host\src\job.rs`
- `C:\Dev\TermX\host\src\events.rs`

### 17.2 UI and Tauri files likely created

- `C:\Dev\TermX\ui\package.json`
- `C:\Dev\TermX\ui\package-lock.json`
- `C:\Dev\TermX\ui\tsconfig.json`
- `C:\Dev\TermX\ui\vite.config.ts`
- `C:\Dev\TermX\ui\index.html`
- `C:\Dev\TermX\ui\src-tauri\Cargo.toml`
- `C:\Dev\TermX\ui\src-tauri\tauri.conf.json`
- `C:\Dev\TermX\ui\src-tauri\capabilities\default.json`
- `C:\Dev\TermX\ui\src-tauri\src\main.rs`
- `C:\Dev\TermX\ui\src-tauri\src\lib.rs`
- `C:\Dev\TermX\ui\src-tauri\src\host_lifecycle.rs`
- `C:\Dev\TermX\ui\src-tauri\src\storage.rs`
- `C:\Dev\TermX\ui\src-tauri\src\notifications.rs`
- `C:\Dev\TermX\ui\src\main.tsx`
- `C:\Dev\TermX\ui\src\app\App.tsx`
- `C:\Dev\TermX\ui\src\app\styles.css`
- `C:\Dev\TermX\ui\src\host\protocol.ts`
- `C:\Dev\TermX\ui\src\host\HostClient.ts`
- `C:\Dev\TermX\ui\src\host\hostReducer.ts`
- `C:\Dev\TermX\ui\src\host\HostProvider.tsx`
- `C:\Dev\TermX\ui\src\terminal\TerminalView.tsx`
- `C:\Dev\TermX\ui\src\terminal\TerminalController.ts`
- `C:\Dev\TermX\ui\src\terminal\OutputWriteQueue.ts`
- `C:\Dev\TermX\ui\src\sessions\SessionSidebar.tsx`
- `C:\Dev\TermX\ui\src\sessions\SessionRow.tsx`
- `C:\Dev\TermX\ui\src\sessions\GroupRow.tsx`
- `C:\Dev\TermX\ui\src\sessions\NewSessionButton.tsx`
- `C:\Dev\TermX\ui\src\layout\layoutSchema.ts`
- `C:\Dev\TermX\ui\src\layout\layoutReducer.ts`
- `C:\Dev\TermX\ui\src\layout\layoutPersistence.ts`
- `C:\Dev\TermX\ui\src\settings\SettingsDrawer.tsx`
- `C:\Dev\TermX\ui\src\recovery\RecoveryCoordinator.ts`
- `C:\Dev\TermX\ui\src\recovery\recoveryTypes.ts`
- `C:\Dev\TermX\ui\src\recovery\providerAdapters.ts`
- `C:\Dev\TermX\ui\src\recovery\RecoveryReview.tsx`
- Adjacent Vitest and React Testing Library tests.
- `C:\Dev\TermX\scripts\dev.ps1`
- `C:\Dev\TermX\scripts\build.ps1`

The implementation plan may refine names, but it must preserve these module boundaries and avoid collecting protocol, xterm, layout, and recovery logic in one oversized component.

### 17.3 Tauri sidecar packaging and ACL policy

The Tauri application bundles `termx-host` as an `externalBin`. Build tooling compiles the host for the same Rust target and profile as the Tauri app, copies it into the exact target-triple-suffixed external-binary filename required by Tauri 2, and fails if the host artifact or wire-major metadata is missing. Project scripts derive all paths from `$PSScriptRoot` and Cargo metadata.

Resolution rules are:

- **Development:** use the freshly built workspace host artifact selected through a generated, project-relative development config. The dev launcher never falls back to an arbitrary PATH executable.
- **Packaged application:** use only the sidecar returned by Tauri’s resource/sidecar API. The application never searches PATH for `termx-host`.
- **Existing detached host:** discovery may connect to an already-running authenticated host from the same data-directory instance, even when it was launched by an earlier UI build. Wire-major compatibility remains the gate.

The packaged artifact matrix verifies the external binary name and location for the Windows MSVC target. The host and UI versions may differ; wire protocol compatibility is independent of package version.

On first data-directory creation, the shared Rust `data_security` module applies and verifies a protected DACL before creating config, runtime, state, recovery bootstrap, or audit files: inheritance is disabled; access is granted only to the current user SID, `SYSTEM`, and Administrators; broad principals such as Everyone, Users, and Authenticated Users receive no access entries. Both Tauri and standalone `termx-host` call the same verification before reading or publishing credentials. The host refuses to bind/publish runtime state if the DACL or ownership check fails. If ACL application or verification fails, TermX shows a blocking local-security error with retry/open-folder guidance and never silently continues with broadly readable credentials.

## 18. Test strategy and acceptance gates

All behavioral changes follow test-driven development: write a focused failing test, verify the expected failure, implement the minimum passing change, then refactor while green.

### 18.1 Host prerequisites

- Concurrent `GetState` cannot observe a blocked, failed, or rolled-back layout candidate.
- A failed persist changes neither memory, revision, nor event cursor.
- Every injected fallible post-spawn setup point leaves no child, descendant, registry entry, event, or `OpenConsole` process; if exact absence cannot be proved, the unregistered action records host-level `containment_uncertain` and blocks reconstruction rather than claiming cleanup.
- `[M2-TST-UNREGISTERED-CONTAINMENT-PREFIX]` A disk/barrier fixture proves the matching reserved creation receipt and `armed` record are atomically durable before OS process-creation entry; persistence/cap failure crosses no spawn, sequence, session, registry, or event boundary. Crash injection at arm, spawn return, root identity, Job assignment, PTY reader/writer, queue/thread setup, cleanup, proof persistence, record removal, and acknowledgement proves every prefix has either exact durable absence or one bounded unresolved record and no registered generation/event. Startup converts armed/no-root to unknown/uncertain before listener publication, never retries spawn, and exact-scans only persisted PID+creation-`FILETIME`/ancestry/Job identities. PID reuse, mismatch, access denial, unavailable identity, unknown assignment, or ambiguous ancestry fails closed without unsafe targeting or partial admission. Capacity fixtures first populate every prune-eligible `resolved_absent` record and prove deterministic pruning, then separately prove that 129 protected `armed|containment_uncertain` records, a protected set plus candidate totaling 4,097 aggregate descendants, or a protected set plus candidate totaling 512 KiB+1 canonical field bytes fails closed before reservation, spawn, repair plan/authorization/journal, or mutation; no protected record is pruned to pass a cap. Exact cleanup creates `resolved_absent` only; same-boot native repair is refused; a strictly later boot plus native confirmation creates exactly one atomic reboot proof with no process termination, session, teardown, safety, or lifecycle event. Restore/adopt preserve the complete field, divergence is repair ambiguity, reset/replacement/shutdown cannot discard an unresolved record, and deterministic retention never prunes protected uncertainty.
- `[M2-TST-EXACT-HANDLE-FIRST]` Ordering instrumentation proves exact root-handle acquisition and creation-`FILETIME` verification precede every kill, close, or other destructive call; PID reuse, wrong creation time, or a missing exact handle is never targeted, the default path never invokes `portable-pty child.kill()`, Job termination requires verified ownership/assignment, and descendant termination requires an already retained exact handle. This cross-references the exact-handle and mask contract in section 5.2.
- `[M2-TST-WIN32-MASKS-INHERITANCE]` Windows API inspection asserts the exact root/process-assignment and Job access masks, `STARTUPINFOEXW`, one exact Job-list attribute, `bInheritHandles=FALSE`, non-inheritable security attributes and zero inherited handles, suspended/persist/bootstrap/resume ordering, and resource cleanup after every `CreateProcessW`/attribute/setup failure. This cross-references sections 5.2 and 15.1.
- Job assignment failure aborts creation.
- A descendant spawned in the pre-assignment race is either assigned to the Job or retained by exact PID/parent/creation-time identity and reaped; unprovable enumeration produces `containment_uncertain` rather than success.
- Descendants remain in the Job after natural root exit and terminate on explicit close or shutdown.
- `CloseSession` persists and publishes `closing` before cleanup, explicitly releases `persist_lock`, every inner lock, and global `commit_lock`, emits no `SessionClosed` while root/Job/escaped descendants remain, and returns/persists `close_uncertain` while retaining graveyard ownership after every injected timeout or unverifiable observation. A barrier-controlled teardown test holds the external waiter after the first commit and proves unrelated `GetState` plus an unrelated durable commit/event complete while the target remains `closing`; a duplicate close joins the same teardown owner. Instrumentation asserts no Job/process wait, reader drain, termination API, or ConPTY close runs while `commit_lock` or any registry/persistence lock is held.
- A crash at every close-to-graveyard, termination, proof, final-persist, and acknowledgement boundary reconciles one teardown owner and emits exactly one terminal `SessionClosed` or `SessionCloseStateChanged(close_uncertain)` transition after the second commit, with monotonic event IDs and no loss of intervening unrelated commits.
- Existing M1 teardown and zero-orphan invariants remain green.

### 18.2 Protocol v2

- Wrong major returns a structured mismatch and leaves the host and sessions running.
- Two authenticated clients receive the same single event ID for create, resize, natural exit, close, and layout commit.
- Snapshot/cursor racing a lifecycle commit produces neither loss nor double reduction.
- A slow event consumer cannot block registry mutation and is forced to resnapshot safely.
- Initial attach proves `Replay -> Attached -> binary` ordering.
- `replay: false` proves `Attached -> binary` with no initial replay.
- Stale layout revisions produce one winner and one `layout_conflict` containing canonical state.
- Failed persistence exposes no candidate and emits no event.
- Boundary fixtures prove a complete canonical `AuthOk`/`State` application JSON payload at exactly 4 MiB and `Sessions` application JSON payload at exactly 1 MiB is accepted independent of WebSocket header size, while one additional UTF-8 application byte is rejected as `snapshot_too_large` with no memory/revision/cursor/durable-file change.
- Oversized startup `AuthOk`/`State` or `Sessions` suppresses listener/runtime publication entirely; domain-under-cap but aggregate-over-cap fixtures prove there is no truncation, pagination, or partial omission.
- Unknown mutation completion is reconciled through `GetState`, not blind retry.
- Confirmation protocol fixtures prove `StoreConfirmation`, `StorePreparedRecoveryConfirmation`, and `DeleteConfirmation` exist only as closed `SafetyMutation` variants inside `CommitSafetyState`; exact duplicates are idempotent, conflicting IDs fail, repair mode rejects them, successful persistence returns `SafetyStateCommitted`, and no standalone WebSocket command with any of those names is accepted.

### 18.3 UI and terminal

- Config CAS fixtures hash exact raw UTF-8 file bytes, distinguish missing from present-empty/pretty files, reject stale hashes after external whitespace/key-order edits, and prove `WriteConfig` emits the exact two-space/LF/trailing-newline pretty bytes and returned SHA-256 fingerprint without applying section-7 JCS hashing.
- `[M2-TST-PROFILE-ARGV-SECRETS]` Cross-language `CredentialArgvClassifierV1` fixtures prove total deterministic classification after expansion: every fixed value-taking flag is rejected in each ASCII-case variant, including unconditional exact `-p`; a separate next argument and inline `--flag=value` are rejected without logging the value; `name=value` rejects each `_KEY|_TOKEN|_PASSWORD|_SECRET` suffix case-insensitively but not empty names or suffix-like text after the first `=`; clean near-misses remain accepted. Override tests apply classification to generated defaults plus `append` and to complete `replace` vectors, reject schema-v2 `ReadConfig`/`WriteConfig` without echoing secret values, and reject disallowed/missing expansion, NUL/control, lone-surrogate, and bound failures as `invalid_config`. Generated shell defaults and adapter-produced managed-initial/resume/structured-bridge argv recipes are reclassified before any binding, record, preview, queue, or process boundary; secret-bearing output yields only `credential_bearing_argv`, stores no offending vector or managed recovery artifact, and never becomes a preview-less Manual operation. Continuation `InputRecipe` bytes are instead checked by the separate exact-source, fingerprint, size, and at-most-once submission fixtures because they are terminal input, not argv. The same fixtures prove the classifier literals/version are compiled and neither config, executable identity, nor adapter can extend or override them.
- Create, type, resize, rename, recolor, group, reorder, duplicate, close, and reopen the UI with layout retained.
- Closing or killing the UI leaves the shell and host alive.
- Relaunch installs a fresh snapshot and replays marker output written while the UI was absent.
- Replay-generated terminal replies never reach PTY input.
- Duplicate and overlapping output are handled correctly.
- Ring eviction displays truncation and advances safely.
- Forward gaps and write-queue overflow trigger bounded detach/reattach replay.
- WebGL failure leaves a functioning terminal.
- Dismissing a dead tab sends `CloseSession` and frees the host entry.
- Multi-client layout conflicts preserve canonical data and rebase the pending semantic operation.

### 18.4 Recovery

- Persisted defaults exactly match section 14.2.
- UI crash never launches or resumes a provider.
- Proven-dead host recovery creates a review queue under the default Reviewed mode.
- Two first-run host/Tauri initializers contending on a brand-new directory prove that only the path-derived preownership-mutex owner creates the ownership UUID, both adopt the exact same persisted UUID, and only the UUID-derived ordinary ownership-mutex owner can bind/publish. Brand-new initialization and legacy migration cannot race because both reclassify under that same mutex; a concurrently live/unverifiable legacy writer blocks UUID creation. Abandoned preownership re-reads exact artifacts/file/ACL state before proceeding; malformed, replaced, or unverifiable ownership fails closed.
- Two Tauri processes contending for dead-host recovery prove that only the `recovery_bootstrap_mutex` owner publishes a bootstrap or spawns a candidate, while the waiter restarts discovery after release.
- An abandoned/owner-death `recovery_bootstrap_mutex` is acquired by the next process only after it reconciles an exact existing bootstrap/witness/tombstone; malformed or mismatched content fails closed without overwrite or second spawn.
- Bootstrap crash-prefix fixtures cover: before witness commit; first-import witness committed with no tombstone; later-import witness N committed while tombstone O still exactly matches `witness_N.prior_tombstone_identity`; interruption before and during atomic tombstone create/replace; tombstone N published before bootstrap removal; bootstrap removed before acknowledgement; and fresh-process/abandoned-mutex reconciliation at every prefix. They prove exactly one state import and one safety-revision increment, never reapply an operation/action after witness N exists, deterministically create tombstone N only for the exact first-import witness+bootstrap case, atomically replace only the exact bound tombstone O for the mixed N/O case, preserve either O or N across replacement interruption, and return `bootstrap_conflict` without overwrite for a missing required O, unexpected/unbound tombstone, absent required bootstrap, or any ID/hash/revision mismatch. The removal-to-ack fixture destroys the importing connection, authenticates a fresh `Preflight`, reconstructs the exact original acknowledgement from `latest_recovery_bootstrap_import`, and proves a distinct later import is admitted only after the current witness has its exact matching retained tombstone; the later witness binds that tombstone's exact JCS content hash before state replacement.
- Bootstrap import rejects caller-selected operation phases/action states/send states/counters/evidence and derives the same canonical initial operation as live `CreateRecoveryOperation`.
- `CreateRecoveryOperation` rejects a stale record-binding hash/revision and any attempt to supply or smuggle advanced operation state; its returned action-preview hash changes for every execution-affecting field or continuation-byte change. Recovery fixtures freeze the complete `ShellLaunchBindingV1` (shell executable path/hash/version, exact shell argv, encoder ID/version), mutate config/profile discovery after operation creation, and prove reconstruction either uses the immutable verified binding byte-for-byte or fails before process creation without substituting the new profile.
- Reviewed batch confirmation persists `prepared_safety_revision`, ordered operation/action-preview hashes, and the JCS batch hash; restart tests reconstruct the exact original `RecoveryReviewPreviewV1` with no pending-template cache, while changed phase/hash/revision before storage requires re-preparation. Cross-language canonicalization fixtures enforce the section-7 RFC 8785/parser rules, including duplicate/unknown-key rejection, Unicode/member ordering, optional omission, and exact hashes for shutdown, action, execution-binding, and reviewed-batch previews.
- Structured evidence tests prove the sink/cache key, host-normalized evidence ID, and persisted evidence-reference ID are the same one-use UUID; provider payloads cannot select it, and duplicate/replayed frames cannot create a second transition.
- Every provider `InputRecipe` path rejects 0 bytes or more than 262,139 bytes before atomic priority-queue admission, including initial launch, resume, and structured continuation; no prefix can be admitted on oversize.
- Recovery-operation pruning protects nonterminal/referenced entries, applies deterministic oldest-first order, enforces the 896-entry/384 KiB retention targets plus 1,024-entry/512 KiB hard bounds, preserves the 16 terminal floor or fails unchanged, and admits only complete bootstrap/live creations. Manual deletion is terminal/unreferenced only.
- Explicit restart persists and displays a preview before confirmation, refuses every nonterminal recovery operation, durably reclassifies exactly its preview-listed managed records as recoverable only in the final authorized shutdown commit, and creates only fresh `planned/not_started` operations after exact old-host release and ownership proof.
- Native shutdown retrieval/MAC tests reject a wrong key, tampered authorization or preview, mismatched authorization hash, replayed read/authorization nonce, expiry, stale safety revision, changed affected-operation set, and second `Shutdown` consumption. Quit tests prove the full prepare/store/finalize/native-read/native-dialog/authorize/shutdown sequence and reject direct bearer-only shutdown. The stored explicit-Quit `ConfirmationV1.affected_operation_ids` must exactly equal the sorted prepared/authorized nonterminal set; missing, added, reordered, or stale IDs reject, while explicit restart requires an empty set. They also prove explicit Quit atomically terminalizes exactly the prepared `send_state=not_started` operation set in one durable safety commit before the exit gate, reports the post-commit revision, emits one full safety event, leaves operations active on cancellation/persist failure, rejects in-flight/ambiguous/accepted sets, and reconciles every cancellation-commit/authorization-consume/ack/exit crash prefix without duplicate recovery work. A barrier-controlled shutdown-persistence test queues a layout commit and a late natural-exit callback on both sides of the shutdown epoch: a pre-epoch commit is included in the final candidate, a post-epoch request returns `shutting_down`, a post-epoch callback emits/persists nothing, repeated Shutdown creates no second candidate, and exact final `state.json` bytes/session IDs/dead lifecycle metadata/revisions/cursor remain unchanged throughout the five-second teardown wait.
- `CancelShutdownPreparation`, preparation expiry, and invalidation make the exact in-memory transaction permanently unusable and permit deterministic deletion of unreferenced `explicit_quit|explicit_restart` confirmations even while operations remain nonterminal. Repeating 257 cancelled/expired shutdown preparations cannot exhaust the 256-record cap, and no deleted confirmation can authorize a new preparation.
- Protocol-v1 migration tests prove Tauri never sends legacy `Shutdown`, waits for Manual exact process/endpoint release, and migrates only under the shared preownership mutex.
- Teardown repair rejects same-boot cleanup, wrong/replayed MAC or nonce, changed boot/identity/proof hash, PID reuse, live/conflicting generations, action/shutdown races, and persistence failure; crash prefixes yield either retained `close_uncertain` or exactly one durable removal with no same-host duplicate `SessionClosed`. A linked `containment_uncertain` recovery operation is reconciled in the same `StateV2` replacement to `closed` plus terminal `unknown_external_action` (or `recovered` only from already-persisted acceptance), never retryable; one `SafetyStateChanged` precedes one `SessionClosed` in consecutive event IDs, and a failed commit changes neither domain. Linked-ownership fixtures mutate each stable-tab/operation/session projection and every moved bridge identity component—including launch/resume/bridge attempt IDs, channel ID, pipe endpoint ID, structured binding/hash, executable path/hash, PID, and creation time—between prepare and repair; every mutation invalidates the byte-equivalent preparation/proof and changes no state.
- Repair mode with malformed primary plus an exact valid backup, including a backup containing protected unresolved containment, may publish only the `diagnostic_repair_only` listener/runtime. Fixtures prove it exposes `Hello`, `GetState`, `ListSessions`, and the exact repair-shutdown transaction, reports zero live sessions plus the exact backup source snapshot, rejects every normal mutation/recovery/containment/storage command, and permits native confirmation/authorization solely for host release while preserving primary, backup, receipts, and every containment record byte-for-byte. The host transaction never authorizes the later storage write; ordinary replacement with unresolved records still publishes no listener/runtime.
- `[M2-TST-STORAGE-OWNERSHIP-CLASSIFICATION]` Fixtures exercise all six `[M2-SCHEMA-StorageOwnershipClassificationV1]` values, owner appearance/disappearance/replacement races, no implicit adoption, explicit `adopt` only with an exact unchanged plan, and refusal of every `foreign_or_orphaned|ambiguous` mutation.
- `[M2-TST-STORAGE-BOTH-INVALID-NATIVE]` When both primary and backup are invalid, no listener/runtime is published; native repair proves dead-host/PID/start-time/endpoint absence and the applicable mutex chain before any write, rejects restore/adopt, permits only exact reset, pins RFC 8785/JCS fresh-state and owner bytes/hash/length, requires `RESET TERMX STATE`, and fabricates no host shutdown authorization.
- `[M2-TST-STORAGE-JOURNAL-CRASH-PREFIX]` Crash injection after every durable `[M2-STATE-StorageRepairJournalV1]` phase proves one idempotent continuation or `storage_repair_ambiguous`, no duplicate quarantine/publication/owner creation, completed replay without file mutation, and no listener while in-progress/ambiguous. `containment_reboot` fixtures start from valid primary, malformed-primary/valid-backup, and two-valid-identical sources; bind the exact source snapshot/record-before hash/later boot plus frozen result `last_checked_at`; prove no direct native StateV2 writer exists; and crash after each old-artifact quarantine, primary publication, deterministic temp recreation, backup publication, verification, and result boundary. Replay under a later wall clock must reproduce the identical candidate hash/bytes rather than changing the result timestamp. Only both canonical copies at the exact one-record candidate may reach `published`; differing valid containment fields, changed record/source/boot, same-boot repair, lock/ownership loss, or any mixed artifact not explicitly named becomes non-mutating ambiguity. The full lock trace is `recovery_bootstrap_mutex -> preownership -> ordinary UUID -> exclusive repair -> ledger`, with no inversion or concurrent bootstrap/repair/host publication.
- `[M2-TST-STORAGE-AUTH-REPLAY]` Duplicate Confirm/Execute/Cancel and `GetStorageRepairStatus` cover `[M2-SCHEMA-StorageRepairAuthorizationV1]` and `[M2-SCHEMA-StorageRepairExecutionResultV1]`: same request ID/body returns the retained acknowledgement, changed body rejects, authorization is consumed exactly once at flushed `journaled`, lost acknowledgements replay, pre-consumption cancel is idempotent, and post-consumption cancel is `too_late`.
- `[M2-TST-STORAGE-QUARANTINE-IDENTITY]` `[M2-SCHEMA-ArtifactIdentityV1]` fixtures distinguish readable exact SHA-256/length from unreadable metadata fingerprints, pin deterministic transaction-specific names, reject insufficient identity, and prove no different existing artifact is overwritten.
- `[M2-TST-STORAGE-PIPE-BOOTSTRAP-ORDER]` Real Windows bridge tests assert `CreateNamedPipeW` flags including `PIPE_REJECT_REMOTE_CLIENTS`, byte mode, one instance, 64-KiB buffers, and rejection of a remote-client attempt; one armed overlapped connect before `CreateProcessW`; only the Job-list process attribute; zero inherited handles; durable suspended identity before the single `ResumeThread`; bridge `CreateFileW`; exact `GetNamedPipeClientProcessId` plus process-ID/creation-time proof; then exactly one flushed `TXSB` record and HELLO-first authenticated reads. Every injected pre-resume failure may become `failed_pre_action` only after primary-thread-never-resumed plus exact zero-process/Job proof; connect, peer, bootstrap, HELLO, or persistence failure after resume is `unknown|unknown_external_action|containment_uncertain`, is never retried, and executes no provider/API instruction before valid bootstrap.
- `[M2-TST-STORAGE-REPAIR-BRANCHES]` Restore/adopt/reset fixtures cover valid-primary, valid-backup, missing-primary, existing-primary, and existing-backup combinations; containment-reboot branch coverage is additionally pinned by `[M2-TST-STORAGE-JOURNAL-CRASH-PREFIX]`. Candidate temp is exact before any source movement; restore always selects backup, adopt prefers exact primary, `already_exact` performs no replacement, missing primary uses non-overwriting move, reset quarantines backup first, and existing-primary ordinary publication uses `ReplaceFileW` without any pre-move. Crash-prefix observation proves the replacement backup argument contains the exact old primary, no ordinary branch can call `ReplaceFileW` after removing its destination, and `containment_sync` never calls `ReplaceFileW` or leaves only one canonical candidate copy at `published`.
- `[M2-TST-STORAGE-DIRECTORY-IDENTITY]` Fixtures pin `TargetDirectoryIdentityV1` from `FileIdInfo` plus normalized volume-GUID final path, strict UTF-16 conversion, lowercase 16-byte file-ID encoding, decimal volume serial, JCS hash, and exact preview/authorization/ledger/journal binding. Directory swap, junction/volume/file-ID/final-path/ACL drift, unavailable fields, or any change before journal, each mutation, or completion fails closed without targeting the replacement directory.
- `[M2-TST-STORAGE-INIT-VS-RESET]` Empty-directory concurrency/crash fixtures prove ordinary startup generates one UUID and acquires its mutex under preownership before owner-first publication, resumable only with the exact owner plus every other artifact absent; native `uninitialized_empty` reset requires preview-bound candidate UUID, acquires that UUID mutex before repair/ledger authority, then confirmation/journal, publishes StateV2 first and owner second, and retains the mutex through reverse-order repair release. Neither context can enter the other's publication sequence, and a matching nonterminal repair journal takes precedence over owner-absent classification.
- `[M2-TST-STORAGE-AUTH-LEDGER]` Ledger fixtures enforce strict JCS/ACL/generation/read-back, exact 96-KiB JCS plan / 192-KiB raw canonical response / 256-KiB base64 replay bounds, 64-record/512-KiB aggregate and per-response/replay caps, request-ID/body deduplication, retained authorization without a second dialog, journaled-as-sole-consumption, crash between journal and consumed mirror, authoritative startup reconciliation, exact pre-journal cancelled result, post-journal retained `too_late`, conflicting/missing journal ambiguity, and at-least-30-day terminal retention. Confirm-acknowledgement-loss followed by complete Tauri/native restart proves `Authorized` status and Execute recover the exact retained canonical plan preimage, publication branch, names, source/owner/result bytes and identities without re-preparing; missing/malformed plan bytes or any disk/authorization/plan projection drift becomes non-mutating ambiguity. Direct ledger `mode|record_id|source_snapshot` fields must equal both immutable-plan and authorization projections by presence and value. Sweeps run only under the complete recovery-bootstrap/preownership/ordinary-when-derivable/repair/ledger chain, remove only oldest eligible terminal records, and fail before target mutation when caps cannot be met.
- Live protocol mismatch leaves the host untouched.
- `[M2-TST-REVIEWED-NOBRIDGE]` Plain Claude and Codex Reviewed fixtures prove durable provider admission followed by exactly one coordinator-triggered `TransitionRecoveryOperation` to `awaiting_readiness_confirmation`, including coordinator reload before the edge and event/acknowledgement loss after it. The path performs zero bridge process/pipe/channel/Job/evidence/screen-parse actions; persistence failure exposes no candidate and never resends resume. Missing, stale, wrong-hash, or wrong-action `reviewed_readiness` cannot reach `provider_ready`, and structured evidence cannot advance `not_required`; exact human readiness, reviewed continuation, at-most-once submission, and reviewed acceptance can complete `recovered`. Unattended/not-required is rejected before provider resume and every stale/wrong-state internal edge is a no-op.
- `[M2-TST-REVIEWED-STRUCTURED-EDGE]` A qualified Reviewed fixture proves provider admission alone does not advance readiness; `not_started` begins only the ordinary bridge lifecycle, durable exact `active` enables exactly one host-internal structured `TransitionRecoveryOperation`, and that commit changes only phase/updated time with one safety revision/event while retaining the active bridge and admitting no evidence. Every stable-tab/session/execution-binding/resume-attempt/bridge-attempt/process/channel/pipe/Job/qualification mismatch rejects. Same-host coordinator reload or lost acknowledgement replays only the idempotent phase edge. `creating_suspended|unknown|containment_uncertain` blocks/fails closed. A host crash before or after active persistence runs exact bridge startup cleanup and becomes `unknown_external_action|containment_uncertain`, never relaunching provider/bridge or replaying the phase edge on the replacement host. Reviewed readiness confirmation remains the sole `provider_ready` edge.
- Plain Claude and Codex records cannot become Unattended. A qualified structured operation may complete as cancelled, timed out, failed, or unrecoverable from every active pre-bridge phase while `structured_bridge_state=not_started` only when attempts remain zero and every bridge attempt/process/channel/Job identity is absent; fixtures cover `planned`, launch approval, `shell_recreated`, resume approval, and provider-resuming-before-bridge-creation. Any persisted attempt or identity requires the normal cleanup/classification path and cannot use this shortcut.
- A qualified Unattended operation with `auto_submit_after_preview=false` takes the explicit `awaiting_continuation_approval -> reviewed_continuation -> continuation_confirmed` subpath without changing its stored mode, cannot submit without that exact confirmation, and still requires structured acceptance; with the setting true it takes the confirmation-free Unattended continuation edge.
- Managed Claude initial launch generates and durably stores one UUID and exact initial/resume argv before admission; fixtures prove `--session-id <uuid>` on initial launch and `--resume <same uuid>` on recovery. `StartManagedProvider`, recovery-bound `CreateSession`, `StartRecoveryProvider`, and `SubmitRecoveryInput` boundary-race tests hold the shared kill-switch gate, use typed decimal generations, persist their pre-action journal state, recheck immediately before the irreversible call, and prove concurrent `SetKillSwitch` either blocks before admission or waits for one durable classified outcome. Retry-boundary fixtures set each `max_launch_retries|max_resume_retries|max_structured_bridge_retries` independently to 255, prove the corresponding `u16` attempt count reaches exactly 256 without wrap or rejection, reject a 257th attempt, and prove stale caller-observed initial-launch count 255 cannot begin or reconcile attempt 256 while exact count 256 can only reconcile the already-classified outcome.
- A managed-initial-launch crash/lost acknowledgement at every journal/admission boundary never emits a second command unless the host durably proved `failed_pre_action`; `submitting|unknown` becomes unrecoverable/manual review. After completed-request eviction, an exact delayed request with an older `expected_initial_launch_attempts` reconciles the old attempt and cannot consume a retry; only an explicit resnapshot plus the exact current count can begin a fresh host-ID attempt.
- Claude rejects unknown or non-TermX-managed IDs and never uses `--continue`.
- Codex rejects unknown identity and never uses `--last` or picker inference.
- A crash from continuation `submitting` reloads as `unknown` and sends nothing.
- Recovery-bound shell creation persists the exact operation/launch-attempt binding before acknowledgement; a lost response reconciles that one session rather than spawning another.
- A launch action left `submitting`, an absent/duplicate/conflicting session binding, or an unclassified post-process-creation failure becomes terminal `unknown_external_action` and is never retried.
- Provider resume retries only after a durable `failed_pre_action`; a provider action left `submitting|unknown` becomes terminal `unknown_external_action` and writes no second resume command.
- Concurrent close/shutdown against initial launch, resume, structured readiness, continuation admission, and structured acceptance proves the ascending session-action-gate order: the action first reaches one durable classified boundary, then close waits/cancels/refuses exactly as specified, with no queue write to a closing session and no deadlock.
- `StructuredChannelV1` tests cover the exact single-record `TXSB` bootstrap encoding/4,096-byte payload/4,106-byte complete cap, named-pipe bootstrap-to-framed-read transition, zero inherited handles, DACL/exact peer PID+creation-time validation, closed binding/bootstrap/HELLO schemas and canonical hash fixture, numeric HELLO/READINESS/ACCEPTANCE kinds, the exact 68-byte frame overhead/65,536-byte payload/65,604-byte complete-frame limits, evidence-envelope/base64 decoded bounds, bad MAC, wrong channel/binding/version/kind, duplicate/skipped/wrapped sequence, replay after attempt supersession, bridge exit, and channel timeout. The decoded result always carries one host-created `ChannelAttestationV1` plus payload; no bridge field can supply or alter attestation. Only the internal sink advances structured evidence; React receives no receipt ID and observes the canonical event.
- `[M2-TST-ARGV-CANONICAL-WIN32]` Structured launch-recipe tests cross-reference `[M2-SCHEMA-WindowsCommandLineArgvEncoderV1]` and reject an unqualified bridge path/hash/version/encoder ID, argv count/byte overflow, out-of-range endpoint index, missing/duplicate/wrong `__TERMX_PIPE_ENDPOINT_V1__` sentinel, a recipe-supplied endpoint/secret/environment/callback/opaque command line, and executable substitution. Cross-language Windows fixtures cover no arguments, empty arguments, spaces/tabs, embedded quotes, repeated/backslash-before-quote/trailing backslashes, root paths such as `C:\`, supplementary Unicode, exact equality of decoded `argv[0]` and the `executable_path` also supplied independently as `lpApplicationName`, NUL/lone-surrogate rejection, exact 32,767 UTF-16-unit acceptance including terminator, one-unit-over rejection, and endpoint substitution before encoding. Round-trip through a `CommandLineToArgvW`-compatible parser yields the exact logical `[executable_path]+argument_vector`; `lpApplicationName` is separately populated, the exact mutable host-owned command-line buffer is asserted, and no shell is invoked. Process-environment inspection from the real bridge proves `CREATE_UNICODE_ENVIRONMENT`, strict deterministic double-NUL encoding, and exactly the five allowlisted names/values; fixtures inject `PATH`, provider/cloud credentials, proxy credentials, runtime bearer/shutdown secrets, and channel-nonce lookalikes into the host environment and prove none appears in the bridge. Missing, duplicate-case, invalid-UTF-16, NUL-bearing, or control-bearing allowlist values fail before process creation.
- Bridge-containment tests inspect real Windows creation attributes and prove the dedicated Job is configured with kill-on-close, active-process limit one, and no breakaway before `CREATE_SUSPENDED|PROC_THREAD_ATTRIBUTE_JOB_LIST` launch; no bridge instruction executes before durable `creating_suspended` stores the exact process/creation-time/channel/launch/resume/bridge-attempt identity, `bInheritHandles=FALSE`, and every process/thread/Job/pipe/event/bootstrap security attribute is non-inheritable. A structured-bridge-versus-`SetKillSwitch` boundary test holds the same outer gate across the typed generation check, durable attempt admission, immediate pre-`CreateProcessW` recheck, OS call, and durable classification: switch engagement first yields durable `failed_pre_action` with zero process boundary crossed, while bridge creation first forces `SetKillSwitch` to wait for one durable `creating_suspended|failed_pre_action|unknown|containment_uncertain` outcome. Pipe/RAII setup, process/Job verification, and durable identity failures before `ResumeThread`, plus explicit pre-resume cancellation, prove primary-thread-never-resumed, exact process signaled, and zero Job accounting before durable `failed_pre_action`; a retry receives a fresh bridge-attempt/channel/nonce and never overlaps the prior identity. Bootstrap write/flush, peer-validation, HELLO, timeout, cancellation, or active-persistence failure after `ResumeThread` is never `failed_pre_action` and never causes an automatic replacement attempt.
- Crash injection after durable suspended identity, immediately before/after `ResumeThread`, during HELLO, after HELLO/before `active`, during evidence, during Job termination, after zero-process proof/before durable `closed`, and after durable `closed` proves at most one executable bridge, no automatic retry after possible execution, exact startup reconciliation, and no lost ownership handle before persistence. HELLO timeout, active-process-limit violation, breakaway/escape evidence, inaccessible creation time/accounting, and cleanup timeout yield `unknown|containment_uncertain` and block terminal completion, ordinary close, shutdown release, and replacement listener publication as specified.
- Close/restart/Quit tests prove an active bridge is stopped and durably `closed` before operation terminalization or Quit `ShutdownAccepted`; explicit restart is rejected from every nonterminal recovery phase/action-state combination and changes no bridge or operation, while explicit Quit bundles bridge closure with exactly the prepared cancellations in one safety commit, and final-commit failure retains exact signaled-process/zero-accounting ownership for retry. Uncertain cleanup atomically moves one deduplicated bridge identity from the operation into the session teardown record, proves no duplicate durable ownership location exists at any commit/startup prefix, increases the native repair identity response by at most one item, and cannot be removed until reboot-gated exact zero-process proof succeeds. After an authorized restart reaches exact old-host release, bootstrap tests construct fresh operation IDs in canonical `planned/not_started` state from durable records and prove no old operation journal, bridge identity, confirmation reference, or external-action state is imported.
- Readiness evidence from a superseded launch/resume/structured-bridge attempt ID is rejected even when its timestamp is newer.
- Acceptance evidence is rejected unless it binds the current attempt IDs, host-generated submission ID, immutable continuation fingerprint, exact submitted byte count, and structured provider request identity.
- Send retries remain zero after timeout or ambiguity.
- `SetKillSwitch` is rejected in a mixed or repeated-mutation batch; a sole mutation acquires `kill_switch_action_gate` before validation and retains it through durable install/event sequencing. Boundary tests prove no generic `CommitSafetyState` dispatcher path can bypass that gate, and concurrent launch/send either classifies first or observes the incremented engaged generation.
- `[M2-TST-RECEIPT-PRUNE-PRECEDENCE]` Completed-request-cache eviction tests reuse old request IDs after more than 1,024 entries and 2 MiB: durable creation sequence/ID/identity hash, operation/attempt/submission identities, lifecycle generation, repair preparation, and shutdown authorization reconcile the original result or return `action_reconciliation_required`, with no second process creation, provider/input admission, termination, repair, or shutdown. Session-creation crash injection covers reservation persistence, immediately before/after the OS creation call, registration, receipt outcome persistence, acknowledgement loss, startup `reserved -> unknown`, receipt pruning, sequence high-water non-reuse, and M1 deterministic migration identities; only an uninterrupted guard-proven `failed_pre_action` may reuse the exact consumed sequence, and no crash prefix creates a second shell. Pruning tests prove `created` receipts for active, exited, or teardown generations are protected; final-close identity is retained; an absent receipt plus exactly one matching durable generation returns canonical metadata; high-water alone never fabricates metadata or permits reuse; no match returns `action_reconciliation_required`; duplicate/hash-conflicting matches fail closed; and a protected set exceeding count or byte caps rejects before sequence reservation.
- ACL integration tests inspect the actual protected DACL on the data directory, ownership file, runtime discovery, state/backup/temp, config, recovery bootstrap/tombstone, shutdown-uncertain, teardown-repair artifacts, and all audit slots; inheritance/broad-principal injection or ACL application/readback failure prevents credential publication or mutation and enters the documented fail-closed mode. Runtime-secret tests prove the bearer token and shutdown-authority key each have exactly one durable occurrence in the protected runtime discovery file, the shutdown key is independently random and absent from host state/config/recovery/bootstrap/audit artifacts, and every invoke result, Tauri event, JavaScript object, React bootstrap, and WebSocket payload exposes no shutdown-key field or value while native finalized-read/authorization MACs still succeed from trusted Rust memory.
- Audit and notifications contain no token, continuation, terminal capture, full provider ID, or private provider state.
- Audit rotation is crash-injected after every delete/rename/create/flush prefix; startup reconciliation always retains the newest valid generations, never exceeds five 8 MiB slots/40 MiB, and enters `audit_degraded` rather than appending when deletion, ACL, header, rename, or quota proof fails.
- Fake structured adapters can demonstrate capability qualification without enabling real plain-CLI unattended sends.

### 18.5 Memory and soak

The release soak runs for 30 minutes with one session producing at least 20 MiB/minute, tab switches every five seconds, a forced detach/reattach every 30 seconds, and a second authenticated snapshot-only client. RSS is sampled once per second from Windows working-set private bytes. Queue, replay, request-table, ring, and xterm estimates are sampled at the same cadence.

Definitions:

- Warm-up is minutes 0–5.
- Warm-up baseline is the median of samples from minute 4 through minute 5, not the high-water mark.
- A five-minute moving minimum is the minimum RSS sample in each non-overlapping five-minute window after warm-up.
- Settled RSS is the median of the final 60 samples of a run.
- No fixed-ring or xterm allocation is subtracted from RSS. Their explicit 8 MiB host-ring and 16 MiB renderer-scrollback caps are included in the threshold.

Pass criteria:

- Renderer-owned decoded output backlog never exceeds 3 MiB and estimated xterm visible+scrollback text never exceeds 16 MiB plus one 256 KiB measurement interval.
- One connection never owns more than one encoded and one decoded 512 KiB Replay chunk.
- Pending correlated requests never exceed 1,024 entries or 2 MiB and return to fewer than 10 entries and 64 KiB between cycles.
- For both host and UI, every post-warm-up RSS sample is at most warm-up baseline + 96 MiB.
- The five post-warm-up five-minute moving minima may not increase in every consecutive window; a strictly monotonic increase is failure.
- Repeating the scenario immediately a second time must keep second-run settled RSS within 16 MiB of first-run settled RSS for each process.
- Multiple clients do not multiply Replay materialization beyond one chunk per connection.
- Closing all test sessions and explicit host shutdown leaves zero child, descendant, or `OpenConsole` processes created by the suite within five seconds.

The test records raw samples and calculated results as an artifact. Threshold changes require an explicit design/test update; recording measurements without enforcing them does not pass.

### 18.6 Required verification before M2 completion

- Rust formatting.
- Strict Clippy across all targets.
- Host unit, binary, and end-to-end tests.
- TypeScript typecheck.
- ESLint with warnings treated as failures.
- Vitest unit/component tests.
- Tauri build under the verified MSVC toolchain.
- Real desktop render and keyboard/input check.
- UI-close/host-survival/relaunch-replay end-to-end check.
- Process and memory hygiene checks.
- Fable 5 high-effort code review of each meaningful implementation chunk and the final integrated diff.
- All confirmed review findings fixed and re-reviewed or explicitly accepted with rationale.

## 19. Clarifications against the original design and current code

This M2 spec intentionally supersedes or narrows several earlier statements:

1. The approved design says a protocol mismatch prompts a clean restart. M2 first leaves a live host untouched and requires recovery preview plus explicit confirmation before any destructive restart.
2. The approved design describes 10,000-line per-profile scrollback. The current host owns a byte ring with a 4 MiB default and 8 MiB maximum. M2 uses 10,000 lines in xterm while preserving the host’s byte-based authoritative ring.
3. The approved design describes pausing PTY reads for backpressure. M1 uses bounded broadcast and replay/resynchronization so one slow client cannot stall a shell. M2 formalizes bounded client resync; true PTY credit flow control remains deferred.
4. The approved design says state writes are continuously debounced. M2 debounces drag-generated layout writes only. Durable lifecycle, recovery, and safety acknowledgements remain synchronous.
5. Current restart persistence restores layout and ID watermark, not dead processes. M2 offers explicit reviewed reconstruction rather than implying old shells survived host death.
6. AI features and `/forkit` remain outside v1 scope. Managed recovery is a narrow crash-continuity exception and does not add cross-session context sharing.
7. Current lifecycle messages are origin replies or per-attached-forwarder exit notices. Protocol v2 replaces them with one global sequenced event hub.
8. Current `Attach` has no acknowledgement. Protocol v2 adds ordered `Replay` then `Attached`.
9. Current `SetLayout` has no revision and exposes a tentative candidate before persistence. Protocol v2 adds revision CAS and committed-state isolation.
10. Current profiles cover only PowerShell and Command Prompt. M2 adds bounded discovery for PowerShell 7, Git Bash, and WSL.
11. No `ui` directory or Tauri workspace member exists yet; M2 creates them.
12. The top-bar file-search wording is aspirational until M3. M2 searches sessions and groups only.
13. Inactive detached sessions cannot provide a trustworthy renderer-side output-activity indicator. M2 displays lifecycle state only.

## 20. Completion definition

M2 is complete only when a real packaged desktop build can:

1. Discover or start the detached host without exposing the token.
2. Create and interact with a shell through xterm.js.
3. Close or crash the UI while the shell survives.
4. Relaunch, resnapshot, reattach, and replay output produced while the UI was absent.
5. Manage names, colors, groups, ordering, profiles, and durable layout across restarts and conflicts.
6. Preserve bounded memory and process-cleanup invariants under lag and repeated replay.
7. Leave a live mismatched host untouched until explicit confirmation.
8. Present all three recovery modes honestly, with plain Claude and Codex limited to Manual/Reviewed.
9. Reconstruct a managed shell and exact provider conversation through a reviewed flow after proven host death.
10. Preserve at-most-once continuation behavior across crashes, timeouts, and kill-switch activation.
11. Pass the full automated and real-render verification matrix.
12. Pass mandatory Fable 5 code review with no unresolved confirmed finding.
