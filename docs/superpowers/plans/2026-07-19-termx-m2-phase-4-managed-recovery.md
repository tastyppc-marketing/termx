# TermX M2 Phase 4: Managed Recovery Host Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the host-owned managed-recovery engine that reconstructs the frozen shell, resumes the exact qualified provider conversation, and submits continuation input at most once under immutable previews, durable attempt journals, kill-switch gates, and exact evidence.

**Architecture:** Closed recovery contracts from Phase 1 are reduced only through host constructors and transition functions inside the existing complete-StateV2 commit boundary. Provider adapters construct typed recipes but never own process, pipe, Job, evidence, or state transitions. Every external shell/provider/bridge/input action is admitted only after a durable host-generated attempt identity and is classified durably before acknowledgement; ambiguous effects become terminal review states and are never repeated.

**Tech Stack:** Rust 2021; `termx-contracts`; `termx-canonical`; Tokio; Windows `CreateProcessW`, Job Objects, and named pipes through `windows-sys`; HMAC-SHA-256; base64; UUID; real Windows helper executables and deterministic fake adapters in integration tests.

## Global Constraints

- Phases 1-3 exact interfaces and tests must be Fable-approved before this phase.
- The host owns recovery records, operations, process/pipe/Job/channel lifecycle, provider argv construction, submission admission, and every phase/action/send state edge.
- React may request a valid transition but never supplies canonical operations, previews, timestamps, attempt IDs, submission IDs, evidence IDs, process identities, argv, or provider commands.
- Tauri does not proxy PTY input or structured evidence and cannot create recovery state.
- Plain Claude Code and Codex CLI are Manual/Reviewed only. Unattended requires exact identity, structured readiness, and structured acceptance.
- Preview is mandatory. Default mode is Reviewed. Automatic continuation submission remains disabled by default.
- `kill_switch_action_gate` is acquired before the per-operation/session action gate and retained through durable attempt admission, immediate pre-boundary generation recheck, the irreversible call, and durable result classification.
- External action retries require durable `failed_pre_action`; `submitting|unknown|creating_suspended` ambiguity never authorizes a repeat.
- Continuation state is only `not_started -> submitting -> accepted|unknown`; send retries are exactly zero and `unknown` is never resent.
- Provider input recipes are 1..=262,139 bytes before one atomic priority-queue admission.
- Structured bridge process creation uses no shell, no inherited handles, one preconfigured single-process Job, a five-name sanitized environment, one named-pipe endpoint sentinel, one TXSB bootstrap, HELLO first, and authenticated monotonic evidence frames.
- Recovery audit records are redacted bounded contract values. Phase 4 creates host audit facts; Phase 5 owns native append/rotation and notifications so the architecture retains one native file writer.
- Integration helpers compile only behind `termx-host/test-support`; release code exposes no evidence/failure injection or raw authority.

## Test-Support Contract

`C:\Dev\TermX\host\src\test_support.rs` adds `RecoveryFixture`, `AdapterProbeFixture`, `RecoveryActionBoundary`, `BridgeFixture`, and the test-only `structured-test` adapter. The fixture boots the real StateV2 commit/event engine in a protected temporary directory, exposes deterministic barriers before/after process creation and queue admission, and counts actual shell/provider/bridge/input boundaries. Real Windows bridge tests launch only `C:\Dev\TermX\host\tests\helpers\structured_bridge_helper.rs`, compiled by the test target into the isolated Cargo target directory; the helper validates bootstrap/frame behavior and performs no provider mutation.

---

### Task 1: Construct immutable records, operations, bindings, and previews

**Files:**
- Create: `C:\Dev\TermX\host\src\recovery\mod.rs`
- Create: `C:\Dev\TermX\host\src\recovery\records.rs`
- Create: `C:\Dev\TermX\host\src\recovery\operations.rs`
- Create: `C:\Dev\TermX\host\tests\recovery_operations.rs`
- Modify: `C:\Dev\TermX\host\src\lib.rs`
- Modify: `C:\Dev\TermX\host\src\registry.rs`
- Modify: `C:\Dev\TermX\host\Cargo.toml`

**Interfaces:**
- Consumes: `StateV2`, `SafetyStateV1`, `RecoveryRecordV1`, `RecoveryOperationDraftV1`, `RecoveryExecutionBindingV1`, and `RecoveryActionPreviewV1` from `termx-contracts`.
- Produces:
  ```rust
  pub struct RecoveryOperationConstructor<'a> {
      pub now: termx_contracts::Timestamp,
      pub settings: &'a termx_contracts::safety::SettingsV1,
      pub qualification: &'a AdapterQualification,
  }

  impl RecoveryOperationConstructor<'_> {
      pub fn create(
          &self,
          record: &RecoveryRecordV1,
          draft: &RecoveryOperationDraftV1,
      ) -> anyhow::Result<RecoveryOperationV1>;
  }

  pub fn record_binding_hash(record: &RecoveryRecordV1) -> anyhow::Result<Sha256Hex>;
  pub fn action_preview_hash(preview: &RecoveryActionPreviewV1) -> anyhow::Result<Sha256Hex>;
  ```
- Invariant: the host reloads the exact record, verifies expected revision/hash/current qualifications, copies the complete immutable execution projection, constructs the complete preview, and stores both hashes in one safety commit. Caller-supplied advanced phase/action/send fields do not exist.

- [ ] **Step 1: Write failing constructor and drift tests**

```rust
#[test]
fn operation_constructor_freezes_execution_binding_and_preview() {
    let fixture = RecoveryFixture::managed_claude_record();
    let operation = fixture.create_operation(RecoveryMode::Reviewed).unwrap();
    assert_eq!(operation.execution_binding.shell, fixture.record().shell_launch_binding);
    assert_eq!(operation.execution_binding.provider_conversation, fixture.record().provider_conversation);
    assert_eq!(operation.action_preview.operation_id, operation.operation_id);
    assert_eq!(operation.execution_binding_hash, fixture.hash(&operation.execution_binding));
    assert_eq!(operation.preview_hash, fixture.hash(&operation.action_preview));
    assert_eq!(operation.phase, RecoveryPhase::Planned);
    assert_eq!(operation.send_state, RecoverySendState::NotStarted);
}

#[test]
fn config_drift_never_substitutes_execution_binding() {
    let fixture = RecoveryFixture::managed_claude_record();
    let operation = fixture.create_operation(RecoveryMode::Reviewed).unwrap();
    fixture.replace_current_profile_executable();
    let result = fixture.begin_reconstruction(&operation);
    assert_eq!(result.unwrap_err().code(), "execution_binding_changed");
    assert_eq!(fixture.shell_spawn_count(), 0);
}
```

Add strict tests for stale safety revision, stale record-binding hash, wrong stable tab, non-recoverable status, duplicate pending operation, unsupported Unattended, operation/preview cardinality and byte caps, and bootstrap/live constructor byte equality.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-host --test recovery_operations -- --test-threads=1
```

Expected: recovery modules and constructor do not exist.

- [ ] **Step 3: Implement one host constructor**

Load the canonical record from current committed state and never trust a draft as a record copy. Validate current executable hashes/versions and shell encoder qualification. Capture exact continuation UTF-8 bytes from current settings once, compute `continuation_bytes` and `sha256:v1:<hex>`, and duplicate those exact values into operation and action preview. Requested Unattended is admitted only when record/current qualification proves exact identity, structured readiness, structured acceptance, provider allow flag, and every preview requirement; otherwise fail with the exact redacted capability reason rather than silently downgrading. Insert record `pending_operation_id` and operation in one commit/event.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-host --test recovery_operations -- --test-threads=1
cargo test -p termx-contracts recovery
cargo clippy -p termx-host --all-targets --features test-support -- -D warnings
```

Expected: constructor/drift/cap/bootstrap parity tests pass and no action boundary is crossed.

- [ ] **Step 5: Commit**

```powershell
git add -- host/src/recovery/mod.rs host/src/recovery/records.rs host/src/recovery/operations.rs host/src/lib.rs host/src/registry.rs host/tests/recovery_operations.rs host/Cargo.toml
git commit -m "feat(recovery): construct immutable recovery operations" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Qualify Claude/Codex adapters and journal managed initial launch

**Files:**
- Create: `C:\Dev\TermX\host\src\recovery\adapters.rs`
- Create: `C:\Dev\TermX\host\src\recovery\managed_launch.rs`
- Create: `C:\Dev\TermX\host\tests\recovery_adapters.rs`
- Create: `C:\Dev\TermX\fixtures\providers\claude-2.1.214.json`
- Create: `C:\Dev\TermX\fixtures\providers\codex-0.144.4.json`
- Modify: `C:\Dev\TermX\host\src\profiles.rs`
- Modify: `C:\Dev\TermX\host\src\server.rs`

**Interfaces:**
- Produces the closed host-only `ProviderAdapter` interface from specification §15.1, `AdapterQualification`, `ManagedLaunchRecipe`, `ArgvRecipe`, and:
  ```rust
  pub async fn start_managed_provider(
      registry: &Registry,
      request: StartManagedProviderV1,
  ) -> Result<ManagedProviderStartedV1, ProtocolErrorV2>;
  ```
- Invariant: Claude managed launch generates one UUID before action and binds exact `--session-id <uuid>` plus future `--resume <same uuid>`; recovery never uses `--continue`. Codex registration/resume uses only an exact ID or explicitly registered uniquely validated name; never `--last` or picker inference.
- Acceptance anchor portion: `[M2-TST-PROFILE-ARGV-SECRETS]` for adapter-generated argv.

- [ ] **Step 1: Write failing qualification and lost-ack tests**

```rust
#[test]
fn claude_managed_recipe_uses_same_uuid_for_initial_and_resume() {
    let fixture = AdapterProbeFixture::claude_2_1_214();
    let recipe = fixture.adapter().prepare_managed_launch(fixture.context()).unwrap();
    let id = recipe.provider_conversation.value.clone();
    assert_eq!(recipe.initial.argument_vector, vec!["--session-id", id.as_str()]);
    assert_eq!(recipe.resume.argument_vector, vec!["--resume", id.as_str()]);
    assert!(!recipe.initial.argument_vector.iter().any(|v| v == "--continue"));
}

#[tokio::test]
async fn managed_initial_launch_ack_loss_never_enqueues_second_command() {
    let fixture = RecoveryFixture::managed_initial_launch().await;
    let request = fixture.start_request("request-1");
    fixture.drop_ack_after_admission();
    let _ = fixture.dispatch(request.clone()).await;
    let replay = fixture.dispatch(request).await.unwrap();
    assert_eq!(replay.attempt_id, fixture.record().current_initial_launch_attempt_id.unwrap());
    assert_eq!(fixture.provider_queue_admissions(), 1);
}
```

Add baseline version/hash/stdout normalization fixtures, unknown Claude ID, ambiguous Codex name, clean near-miss and every credential-bearing generated argv vector, stale attempt count 255/256, retry maximum 256 total attempts, and no secret echo assertions.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-host --test recovery_adapters -- --test-threads=1
```

Expected: adapter/managed-launch modules and protocol request are absent.

- [ ] **Step 3: Implement qualification and initial action journal**

Qualification hashes exact executable bytes/path/version/normalized version output and exact adapter/bridge evidence. Re-run the compiled credential classifier after every adapter recipe and before record, preview, queue, or process creation. `StartManagedProvider` runs under kill-switch plus session action gates, validates typed expected attempt count/generation, durably records host-generated attempt ID and `submitting`, admits exactly one encoded provider command, then durably classifies `admitted|failed_pre_action|unknown` before response. Only exact queue non-entry may be `failed_pre_action`; acknowledgement loss reconciles durable identity and never consumes another attempt.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-host --test recovery_adapters -- --test-threads=1
cargo test -p termx-host --test profile_argv -- --test-threads=1
cargo test -p termx-host receipts::tests
```

Expected: exact baseline and crash/lost-ack fixtures pass; secret values are absent from captured diagnostics.

- [ ] **Step 5: Commit**

```powershell
git add -- host/src/recovery/adapters.rs host/src/recovery/managed_launch.rs host/src/profiles.rs host/src/server.rs host/tests/recovery_adapters.rs fixtures/providers
git commit -m "feat(recovery): qualify managed provider launches" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Enforce the closed recovery transition matrix and reviewed gates

**Files:**
- Create: `C:\Dev\TermX\host\src\recovery\transitions.rs`
- Create: `C:\Dev\TermX\host\tests\recovery_reviewed.rs`
- Create: `C:\Dev\TermX\host\tests\recovery_unattended.rs`
- Modify: `C:\Dev\TermX\host\src\recovery\operations.rs`
- Modify: `C:\Dev\TermX\host\src\safety.rs`
- Modify: `C:\Dev\TermX\host\src\server.rs`

**Interfaces:**
- Produces handlers for `TransitionRecoveryOperation`, `CompleteRecoveryOperation`, `RequestRecoveryCancellation`, `PrepareRecoveryReview`, and confirmation mutations through `CommitSafetyState`, including the one-use `reviewed_bridge_recreate` admission.
- Invariant: `TransitionRecoveryOperation` is the sole active phase-edge owner; completion is the sole terminal owner; cancellation remains deferred during in-flight pre-send actions; a bridge that previously reached active can leave durable `closed` only through a stored same-host `reviewed_bridge_recreate` confirmation and never by automatic retry.
- Acceptance anchors: `[M2-TST-REVIEWED-NOBRIDGE]`, `[M2-TST-REVIEWED-STRUCTURED-EDGE]` (phase-edge portion).

- [ ] **Step 1: Write failing matrix tests**

```rust
#[tokio::test]
async fn m2_tst_reviewed_nobridge_reconciles_only_the_phase_edge() {
    let fixture = RecoveryFixture::reviewed_plain_provider_admitted().await;
    fixture.drop_coordinator_before_edge();
    let reloaded = fixture.reconnect().await;
    reloaded.reconcile().await.unwrap();
    let operation = reloaded.operation();
    assert_eq!(operation.phase, RecoveryPhase::AwaitingReadinessConfirmation);
    assert_eq!(operation.structured_bridge_state, StructuredBridgeState::NotRequired);
    assert_eq!(reloaded.provider_resume_admissions(), 1);
    assert_eq!(reloaded.bridge_process_creations(), 0);
}

#[tokio::test]
async fn reviewed_active_bridge_edge_changes_only_phase_and_time() {
    let fixture = RecoveryFixture::reviewed_structured_bridge_active().await;
    let before = fixture.operation().clone();
    fixture.reconcile_reviewed_edge().await.unwrap();
    let after = fixture.operation();
    assert_eq!(after.phase, RecoveryPhase::AwaitingReadinessConfirmation);
    assert_eq!(after.structured_bridge_process, before.structured_bridge_process);
    assert_eq!(fixture.evidence_admissions(), 0);
}

#[tokio::test]
async fn reviewed_bridge_recreate_requires_fresh_exact_confirmation() {
    let fixture = RecoveryFixture::reviewed_bridge_durably_closed().await;
    assert_eq!(
        fixture.recreate_bridge_without_confirmation().await.unwrap_err().code(),
        "confirmation_required",
    );

    let confirmation = fixture.confirm_reviewed_bridge_recreate().await;
    fixture.recreate_bridge(confirmation.clone()).await.unwrap();

    assert_eq!(fixture.provider_resume_admissions(), 1);
    assert_eq!(fixture.continuation_admissions(), 0);
    assert_ne!(fixture.current_bridge_attempt_id(), fixture.prior_bridge_attempt_id());
    assert_ne!(fixture.current_channel_id(), fixture.prior_channel_id());
    assert_eq!(
        fixture.recreate_bridge(confirmation).await.unwrap_err().code(),
        "stale_recovery_confirmation",
    );
}
```

Add complete Reviewed, Manual, qualified Unattended auto-submit true/false matrices; stale confirmations; wrong preview/action/order; plain-provider Unattended rejection; zero-attempt pre-bridge terminal shortcuts; every forbidden edge; persistence failure; acknowledgement replay; terminal retention/pruning and 896/384 KiB targets plus 1,024/512 KiB hard bounds. For `reviewed_bridge_recreate`, cover same-host-only eligibility, exact prior zero Job accounting, no retained bridge/channel/pipe/Job identity, unchanged operation/provider/session/execution binding, required structured readiness/acceptance still pending, attempt limit, send state not unknown, and rejection during cancellation/shutdown or after phase advancement. Cross-host, wrong-action, stale-revision, reused, and changed-binding confirmations must create zero processes and admit zero provider/input actions.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-host --test recovery_reviewed -- --test-threads=1
cargo test -p termx-host --test recovery_unattended -- --test-threads=1
```

Expected: transition dispatcher and closed matrix are absent.

- [ ] **Step 3: Implement one pure validator plus one commit wrapper**

Define `validate_transition(current, request, confirmation, evidence) -> TransitionProjection` as a pure exhaustive match over exact phase/action/send/bridge/mode states. The commit wrapper loads current operation, rechecks every ID/hash/revision, applies only that projection plus host timestamp, persists, installs, increments safety revision once, and emits one full `SafetyStateChanged`. Plain Reviewed admitted/not-required and Reviewed admitted/active edges carry no confirmation and create no external action/evidence. Reviewed readiness confirmation remains the sole next edge. Unattended/not-required is invalid everywhere. `reviewed_bridge_recreate` is not a phase edge: its stored confirmation authorizes one internal bridge-attempt admission from durable `closed` only after the validator proves same host, unchanged binding, prior exact zero accounting, no retained identity, still-required structured evidence, safe send state, and no cancellation/shutdown. The admission consumes the confirmation by advancing the bridge journal and generates fresh attempt/channel/endpoint/nonce identities without changing phase or resending provider/continuation actions.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-host --test recovery_reviewed -- --test-threads=1
cargo test -p termx-host --test recovery_unattended -- --test-threads=1
cargo test -p termx-host --test safety_cas -- --test-threads=1
```

Expected: all permitted arrows pass, all unlisted arrows reject unchanged, and acknowledgement replay has one revision/event.

- [ ] **Step 5: Commit**

```powershell
git add -- host/src/recovery/transitions.rs host/src/recovery/operations.rs host/src/safety.rs host/src/server.rs host/tests/recovery_reviewed.rs host/tests/recovery_unattended.rs
git commit -m "feat(recovery): enforce reviewed and unattended transitions" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Journal recovery shell creation and provider resume under the kill switch

**Files:**
- Create: `C:\Dev\TermX\host\src\recovery\actions.rs`
- Create: `C:\Dev\TermX\host\tests\recovery_actions.rs`
- Create: `C:\Dev\TermX\host\tests\recovery_action_races.rs`
- Modify: `C:\Dev\TermX\host\src\registry.rs`
- Modify: `C:\Dev\TermX\host\src\server.rs`
- Modify: `C:\Dev\TermX\host\src\session.rs`

**Interfaces:**
- Produces recovery-bound `CreateSession` and `StartRecoveryProvider` handlers plus `KillSwitchActionGuard`.
- Invariant: exact frozen shell/profile/cwd and operation/attempt binding are durable before response; a lost response reconciles one session/queue action and never starts another.

- [ ] **Step 1: Write failing action-boundary race tests**

```rust
#[tokio::test]
async fn recovery_shell_ack_loss_reconciles_one_bound_session() {
    let fixture = RecoveryFixture::at_shell_recreating().await;
    fixture.drop_ack_after_session_commit();
    let request = fixture.create_bound_session_request();
    let _ = fixture.dispatch_create(request.clone()).await;
    let replay = fixture.dispatch_create(request).await.unwrap();
    assert_eq!(replay.session_id, fixture.only_recovery_bound_session().id);
    assert_eq!(fixture.shell_spawn_count(), 1);
}

#[tokio::test]
async fn kill_switch_wins_before_provider_queue_admission() {
    let fixture = RecoveryFixture::at_provider_resuming().await;
    fixture.pause_before_provider_admission();
    let resume = fixture.start_recovery_provider();
    fixture.engage_kill_switch().await.unwrap();
    fixture.release_provider_admission();
    assert_eq!(resume.await.unwrap_err().code(), "kill_switch_engaged");
    assert_eq!(fixture.provider_queue_admissions(), 0);
}
```

Add the opposite ordering where action boundary wins and SetKillSwitch waits for a durable classified result; create-vs-close/shutdown ascending session-gate order; stale attempt counts; exact cwd and executable hash failure before spawn; missing/duplicate/conflicting durable session binding; resume queue ambiguity; retry only from `failed_pre_action`; and deadline/cancellation behavior.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-host --test recovery_actions -- --test-threads=1
cargo test -p termx-host --test recovery_action_races -- --test-threads=1
```

Expected: recovery action handlers/gate do not exist.

- [ ] **Step 3: Implement durable begin/action/result boundaries**

Acquire kill-switch then sorted session-action gates. Validate expected typed generation/count/current IDs and complete immutable binding. Commit `begin_attempt` first. Recovery-bound session creation uses only the frozen shell executable/argv/encoder/safe cwd and persists exact operation/launch-attempt binding in the session record before acknowledgement. Provider resume commits `submitting`, admits one exact adapter-encoded recipe, and commits `admitted|failed_pre_action|unknown`. Every post-boundary unclassified failure becomes `unknown_external_action`; never issue a second shell/provider action from that state.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-host --test recovery_actions -- --test-threads=1
cargo test -p termx-host --test recovery_action_races -- --test-threads=1
cargo test -p termx-host --test containment_prefix -- --test-threads=1
cargo test -p termx-host --test shutdown_v2 -- --test-threads=1
```

Expected: boundary races deterministically have one durable winner and zero duplicate external effects/deadlocks.

- [ ] **Step 5: Commit**

```powershell
git add -- host/src/recovery/actions.rs host/src/registry.rs host/src/server.rs host/src/session.rs host/tests/recovery_actions.rs host/tests/recovery_action_races.rs
git commit -m "feat(recovery): journal reconstruction actions" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Implement canonical Windows argv and sanitized bridge launch preparation

**Files:**
- Create: `C:\Dev\TermX\host\src\recovery\argv.rs`
- Create: `C:\Dev\TermX\host\tests\windows_argv.rs`
- Create: `C:\Dev\TermX\host\tests\bridge_environment.rs`
- Create: `C:\Dev\TermX\fixtures\argv\windows-command-line.json`
- Create: `C:\Dev\TermX\fixtures\argv\bridge-environment.json`
- Modify: `C:\Dev\TermX\host\src\recovery\adapters.rs`

**Interfaces:**
- Produces:
  ```rust
  pub fn encode_windows_command_line(
      executable: &std::ffi::OsStr,
      arguments: &[std::ffi::OsString],
  ) -> anyhow::Result<Vec<u16>>;

  pub fn build_sanitized_environment(
      get: impl Fn(&str) -> Option<std::ffi::OsString>,
  ) -> anyhow::Result<Vec<u16>>;

  pub fn validate_bridge_recipe(
      qualification: &AdapterQualification,
      recipe: &StructuredBridgeLaunchRecipeV1,
      endpoint: &str,
  ) -> anyhow::Result<ValidatedBridgeLaunch>;
  ```
- Acceptance anchor: `[M2-TST-ARGV-CANONICAL-WIN32]`.

- [ ] **Step 1: Write failing cross-language/real-parser tests**

```rust
#[test]
fn m2_tst_argv_canonical_win32_round_trips_fixture_vectors() {
    for vector in argv_fixture_vectors() {
        let encoded = encode_windows_command_line(&vector.executable, &vector.arguments).unwrap();
        assert_eq!(command_line_to_argvw(&encoded).unwrap(), vector.logical_argv);
        assert_eq!(vector.logical_argv[0], vector.executable);
    }
}

#[test]
fn sanitized_environment_contains_exact_five_names() {
    let block = build_sanitized_environment(test_host_environment).unwrap();
    let decoded = decode_environment_block(&block).unwrap();
    assert_eq!(decoded.keys().collect::<Vec<_>>(), ["COMSPEC", "SystemRoot", "TEMP", "TMP", "WINDIR"]);
    assert!(!decoded.contains_key("PATH"));
    assert!(!decoded.keys().any(|name| name.ends_with("_TOKEN") || name.ends_with("_KEY")));
}
```

Include empty, spaces/tabs, quotes, repeated/backslash-before-quote/trailing backslashes, `C:\`, supplementary Unicode, exact 32,767 code units including NUL, one-over rejection, NUL/lone surrogate, endpoint sentinel missing/duplicate/wrong index, executable substitution, opaque command line, count/byte limits, duplicate-case/missing/control-bearing environment values, and injected secrets.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-host --test windows_argv -- --test-threads=1
cargo test -p termx-host --test bridge_environment -- --test-threads=1
```

Expected: argv/environment modules are absent.

- [ ] **Step 3: Implement the closed encoder and environment builder**

Quote every argv element including argv0 using the exact CommandLineToArgvW inverse; separately set `lpApplicationName` to the verified executable. Replace exactly one `__TERMX_PIPE_ENDPOINT_V1__` before encoding. Build deterministic case-insensitive ordered UTF-16 environment containing only SystemRoot, WINDIR, COMSPEC, TEMP, TMP and one double NUL. The adapter cannot supply endpoint, environment, secrets, callback, or final command line.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-host --test windows_argv -- --test-threads=1
cargo test -p termx-host --test bridge_environment -- --test-threads=1
cargo test -p termx-host --test recovery_adapters -- --test-threads=1
```

Expected: every fixture round-trips and every invalid vector fails before process creation.

- [ ] **Step 5: Commit**

```powershell
git add -- host/src/recovery/argv.rs host/src/recovery/adapters.rs host/tests/windows_argv.rs host/tests/bridge_environment.rs fixtures/argv
git commit -m "feat(recovery): canonicalize bridge process launch" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Own the structured bridge, TXSB bootstrap, evidence, and teardown

**Files:**
- Create: `C:\Dev\TermX\host\src\recovery\bridge.rs`
- Create: `C:\Dev\TermX\host\src\recovery\evidence.rs`
- Create: `C:\Dev\TermX\host\tests\helpers\structured_bridge_helper.rs`
- Create: `C:\Dev\TermX\host\tests\structured_bridge_codec.rs`
- Create: `C:\Dev\TermX\host\tests\structured_bridge_win32.rs`
- Create: `C:\Dev\TermX\host\tests\recovery_structured.rs`
- Modify: `C:\Dev\TermX\host\src\recovery\actions.rs`
- Modify: `C:\Dev\TermX\host\src\containment.rs`
- Modify: `C:\Dev\TermX\host\Cargo.toml`

**Interfaces:**
- Produces internal `StructuredChannelHandle`, `BridgeSetupGuard`, `StructuredEvidenceSink`, framed codec, lifecycle reconciliation, and normal/uncertain teardown ownership transfer.
- Invariant: adapter sees only verified `ChannelAttestationV1` plus closed decoded payload; it never receives a pipe/process/Job/nonce/unverified frame/lifecycle callback.
- Acceptance anchors: `[M2-TST-STORAGE-PIPE-BOOTSTRAP-ORDER]`, `[M2-TST-REVIEWED-STRUCTURED-EDGE]` (active bridge/evidence portion).

- [ ] **Step 1: Write failing codec, ordering, and crash-prefix tests**

```rust
#[tokio::test]
async fn m2_tst_storage_pipe_bootstrap_order_is_exact() {
    let trace = BridgeFixture::launch_and_trace().await.unwrap();
    assert!(trace.connect_armed_before_create_process);
    assert!(trace.created_suspended);
    assert!(trace.identity_persisted_before_resume);
    assert_eq!(trace.resume_thread_calls, 1);
    assert!(trace.peer_pid_and_creation_time_verified_before_bootstrap);
    assert_eq!(trace.txsb_records_written, 1);
    assert_eq!(trace.first_frame_kind, StructuredFrameKind::Hello);
}

#[tokio::test]
async fn bad_mac_closes_channel_without_evidence_transition() {
    let fixture = BridgeFixture::active().await;
    fixture.send_bad_mac_readiness().await;
    assert!(fixture.channel_closed().await);
    assert_eq!(fixture.evidence_admissions(), 0);
    assert_eq!(fixture.operation().phase, RecoveryPhase::ProviderResuming);
}

#[tokio::test]
async fn reviewed_recreation_uses_fresh_observer_identity_without_provider_resend() {
    let fixture = BridgeFixture::cleanly_closed_after_active().await;
    let before = fixture.identity_history();
    let confirmation = fixture.confirm_reviewed_bridge_recreate().await;

    fixture.recreate_reviewed_bridge(confirmation).await.unwrap();

    let after = fixture.identity_history();
    assert_ne!(after.current.attempt_id, before.prior.attempt_id);
    assert_ne!(after.current.channel_id, before.prior.channel_id);
    assert_ne!(after.current.pipe_endpoint_id, before.prior.pipe_endpoint_id);
    assert_ne!(after.current.channel_nonce_hash, before.prior.channel_nonce_hash);
    assert_eq!(fixture.provider_resume_admissions(), 1);
    assert_eq!(fixture.continuation_admissions(), 0);
}
```

Add exact CreateNamedPipeW flags/buffers/one instance/remote rejection; STARTUPINFOEXW one Job-list attribute; no inherited handles; pre/post-resume failure classification; process/creation-time peer mismatch; TXSB 4,096/4,106 bounds; HELLO-first; TXSC 68/65,536/65,604 bounds; numeric kinds; JCS payloads; MAC/constant-time verification; sequence duplicate/skip/wrap; wrong binding/attempt; readiness/acceptance field rules; timeout/exit; active-process-limit/no-breakaway; cleanup crash prefixes; startup exact-handle reconciliation; graveyard move-not-copy ownership. Add reviewed recreation rejection for automatic invocation, cross-host use, stale/reused/wrong-action confirmation, changed operation/provider/session/execution binding, nonzero or uncertain Job accounting, retained process/channel/pipe/Job identity, send state `unknown`, cancellation/shutdown, exhausted attempt bound, and a phase that no longer requires structured evidence. Every rejected case asserts zero `CreateProcessW`, provider-resume, and continuation admissions.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-host --test structured_bridge_codec -- --test-threads=1
cargo test -p termx-host --test structured_bridge_win32 -- --test-threads=1 *> (Join-Path $PWD 'target-m2\bridge-win32-red.log')
cargo test -p termx-host --test recovery_structured -- --test-threads=1
```

Expected: bridge/channel/evidence implementation absent.

- [ ] **Step 3: Implement host-only bridge lifecycle**

Under kill-switch then session gate, admit an initial/classified-pre-action attempt from `not_started|failed_pre_action`, or admit a reviewed observer recreation from durable `closed` only after loading and validating the exact one-use `reviewed_bridge_recreate` confirmation and all same-host/zero-accounting/no-identity/still-needed gates. Generate fresh attempt/channel/endpoint/nonce, create protected byte-mode overlapped pipe and preconfigured kill-on-close/one-process/no-breakaway Job, arm connect, validate recipe/argv/environment, call suspended CreateProcessW with one Job-list attribute and zero inherited handles, capture exact identity/accounting, persist `creating_suspended`, then ResumeThread exactly once. Verify pipe client PID/start time, send/flush one TXSB, require HELLO in ten seconds, persist `active`, then admit only verified monotonic frames through `StructuredEvidenceSink`. Normal close stops evidence, closes pipe, terminates Job, waits five seconds, proves zero accounting, persists `closed`, then releases handles. Ambiguity retains/moves exact ownership and blocks completion/restart/publication.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-host --test structured_bridge_codec -- --test-threads=1
cargo test -p termx-host --test structured_bridge_win32 -- --test-threads=1 *> (Join-Path $PWD 'target-m2\bridge-win32-green.log')
cargo test -p termx-host --test recovery_structured -- --test-threads=1
cargo test -p termx-host --test teardown_prefix -- --test-threads=1
```

Expected: exact ordering/codec/crash paths pass; helper and all bridge-created processes are absent after each test.

- [ ] **Step 5: Commit**

```powershell
git add -- host/src/recovery/bridge.rs host/src/recovery/evidence.rs host/src/recovery/actions.rs host/src/containment.rs host/tests/helpers/structured_bridge_helper.rs host/tests/structured_bridge_codec.rs host/tests/structured_bridge_win32.rs host/tests/recovery_structured.rs host/Cargo.toml
git commit -m "feat(recovery): own authenticated structured bridges" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Submit continuation and reconcile acceptance at most once

**Files:**
- Create: `C:\Dev\TermX\host\src\recovery\submission.rs`
- Create: `C:\Dev\TermX\host\tests\recovery_submission.rs`
- Create: `C:\Dev\TermX\host\tests\recovery_submission_races.rs`
- Modify: `C:\Dev\TermX\host\src\recovery\transitions.rs`
- Modify: `C:\Dev\TermX\host\src\server.rs`
- Modify: `C:\Dev\TermX\host\src\session.rs`

**Interfaces:**
- Produces `SubmitRecoveryInput -> RecoveryInputAccepted` and acceptance/completion reconciliation.
- Invariant: exact immutable bytes/fingerprint/attachment/operation/current attempt/confirmation/evidence/generation are checked, `submitting` plus host submission ID are durable before one atomic input admission, and ambiguity becomes `unknown_send_outcome` without resend.

- [ ] **Step 1: Write failing at-most-once tests**

```rust
#[tokio::test]
async fn crash_from_submitting_reloads_unknown_and_sends_nothing() {
    let fixture = RecoveryFixture::continuation_confirmed().await;
    fixture.crash_after_submitting_before_admission();
    let _ = fixture.submit_exact_continuation().await;
    let restarted = fixture.restart_host().await;
    restarted.reconcile().await.unwrap();
    assert_eq!(restarted.operation().send_state, RecoverySendState::Unknown);
    assert_eq!(restarted.operation().terminal_state, Some(RecoveryTerminalState::UnknownSendOutcome));
    assert_eq!(restarted.input_admissions(), 0);
    assert!(restarted.submit_exact_continuation().await.is_err());
}

#[tokio::test]
async fn acceptance_binds_current_attempt_submission_fingerprint_and_bytes() {
    let fixture = RecoveryFixture::structured_submission_in_flight().await;
    let evidence = fixture.valid_acceptance_evidence();
    fixture.accept_evidence(evidence.clone()).await.unwrap();
    for mutated in mutate_every_acceptance_binding(evidence) {
        assert_eq!(fixture.accept_evidence(mutated).await.unwrap_err().code(), "stale_recovery_evidence");
    }
}
```

Add zero/262,140-byte rejection before admission; exact 262,139-byte atomic acceptance; base64/fingerprint/UTF-8/current-settings drift; unattached/wrong session; Reviewed continuation/acceptance confirmations; Unattended auto-submit true/false; kill-switch race both orderings; queue backpressure; ack timeout/disconnect; acceptance-before-reconcile; duplicate request/cache eviction; accepted-to-recovered separate commits; zero retries.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-host --test recovery_submission -- --test-threads=1
cargo test -p termx-host --test recovery_submission_races -- --test-threads=1
```

Expected: submission handler/reconciliation absent.

- [ ] **Step 3: Implement one gated submission transaction**

Decode and verify exact operation-stored bytes/fingerprint/count. Acquire kill-switch then operation send/session gates; validate current disengaged generation, attachment, phase/send state, binding, current attempts, and mode-specific confirmation/readiness/acceptance capability. Commit host-generated `submission_id`, submitted byte count, and `submitting`; without releasing send gate admit exactly one plain buffer or adapter structured recipe. On certain full admission return only host-input acceptance, not provider acceptance. Any uncertainty after durable submitting commits terminal unknown or closes for reload reconciliation. Structured or human acceptance binds exact current IDs/fingerprint/bytes and commits `accepted`; recovered completion is separate.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-host --test recovery_submission -- --test-threads=1
cargo test -p termx-host --test recovery_submission_races -- --test-threads=1
cargo test -p termx-host --test recovery_reviewed -- --test-threads=1
cargo test -p termx-host --test recovery_unattended -- --test-threads=1
```

Expected: no fixture records more than one admission; every ambiguous prefix is terminal/non-retryable.

- [ ] **Step 5: Commit**

```powershell
git add -- host/src/recovery/submission.rs host/src/recovery/transitions.rs host/src/server.rs host/src/session.rs host/tests/recovery_submission.rs host/tests/recovery_submission_races.rs
git commit -m "feat(recovery): enforce at-most-once continuation" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Emit bounded redacted audit facts and close the Phase 4 gate

**Files:**
- Create: `C:\Dev\TermX\host\src\recovery\audit.rs`
- Create: `C:\Dev\TermX\host\tests\recovery_audit.rs`
- Create: `C:\Dev\TermX\host\tests\recovery_e2e.rs`
- Modify: `C:\Dev\TermX\host\src\recovery\mod.rs`
- Modify: `C:\Dev\TermX\crates\termx-contracts\src\recovery.rs`
- Modify: `C:\Dev\TermX\specs\handoffs\001-2026-07-17-termx-m1-host-core.md`

**Interfaces:**
- Produces `RecoveryAuditFactV1` and a bounded native-consumer stream; the record is capped at 8 KiB and excludes secrets, continuation, terminal content, full provider IDs, and private provider state.
- Phase 5 consumes audit facts and owns native file rotation/notifications.

- [ ] **Step 1: Write failing redaction and integrated reconstruction tests**

```rust
#[test]
fn audit_fact_contains_no_sensitive_recovery_values() {
    let fixture = RecoveryFixture::with_sensitive_values();
    let encoded = fixture.emit_audit_fact().unwrap();
    assert!(encoded.len() <= 8 * 1024);
    for forbidden in fixture.forbidden_sensitive_bytes() {
        assert!(!encoded.windows(forbidden.len()).any(|window| window == forbidden));
    }
}

#[tokio::test]
async fn reviewed_managed_claude_reconstructs_exact_shell_cwd_and_conversation() {
    let fixture = RecoveryFixture::end_to_end_managed_claude().await;
    fixture.run_reviewed_recovery().await.unwrap();
    assert_eq!(fixture.reconstructed_shell_binding(), fixture.original_shell_binding());
    assert_eq!(fixture.reconstructed_cwd(), fixture.original_safe_cwd());
    assert_eq!(fixture.resume_argv(), vec!["--resume", fixture.original_conversation_id()]);
    assert_eq!(fixture.continuation_admissions(), 1);
    assert_eq!(fixture.operation().terminal_state, Some(RecoveryTerminalState::Recovered));
}
```

Add Manual/Codex/structured-test integrated flows, UI/coordinator disconnect without action, proven-dead-only admission, process cleanup, audit queue overflow safe degradation fact, retention/pruning, and all Phase 4 anchor suites.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-host --test recovery_audit -- --test-threads=1
cargo test -p termx-host --test recovery_e2e -- --test-threads=1 *> (Join-Path $PWD 'target-m2\recovery-e2e-red.log')
```

Expected: bounded audit fact stream/integrated harness are absent.

- [ ] **Step 3: Implement redacted facts without creating a second state writer**

Construct audit facts only from explicit allowlisted fields and masked conversation identity; never serialize then subtract secrets. Deliver through a bounded 1,024-record/4 MiB native-consumer queue with explicit degraded notification fact on overflow. Audit failure cannot roll back authoritative recovery state or block ConPTY. Do not implement file rotation here; Phase 5 consumes the closed facts in trusted native Rust.

- [ ] **Step 4: Verify complete Phase 4 GREEN gate**

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test -p termx-contracts
cargo test -p termx-host --lib
cargo test -p termx-host --test recovery_operations -- --test-threads=1
cargo test -p termx-host --test recovery_adapters -- --test-threads=1
cargo test -p termx-host --test recovery_reviewed -- --test-threads=1
cargo test -p termx-host --test recovery_unattended -- --test-threads=1
cargo test -p termx-host --test recovery_actions -- --test-threads=1
cargo test -p termx-host --test recovery_action_races -- --test-threads=1
cargo test -p termx-host --test windows_argv -- --test-threads=1
cargo test -p termx-host --test bridge_environment -- --test-threads=1
cargo test -p termx-host --test structured_bridge_codec -- --test-threads=1
cargo test -p termx-host --test structured_bridge_win32 -- --test-threads=1 *> (Join-Path $PWD 'target-m2\phase4-bridge.log')
cargo test -p termx-host --test recovery_structured -- --test-threads=1
cargo test -p termx-host --test recovery_submission -- --test-threads=1
cargo test -p termx-host --test recovery_submission_races -- --test-threads=1
cargo test -p termx-host --test recovery_audit -- --test-threads=1
cargo test -p termx-host --test recovery_e2e -- --test-threads=1 *> (Join-Path $PWD 'target-m2\phase4-e2e.log')
```

Expected: all exit 0; no test-created shell/provider/bridge/OpenConsole remains. Send exact diff and output to Fable and resolve every confirmed finding before Phase 5.

- [ ] **Step 5: Commit**

```powershell
git add -- host/src/recovery/audit.rs host/src/recovery/mod.rs host/tests/recovery_audit.rs host/tests/recovery_e2e.rs crates/termx-contracts/src/recovery.rs specs/handoffs/001-2026-07-17-termx-m1-host-core.md
git commit -m "test(recovery): close managed recovery host gate" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Phase 4 Acceptance Coverage

| Specification acceptance requirement | Owning task | Exact primary test |
|---|---:|---|
| Defaults/capabilities construct exact immutable operation/preview | 1 | `host/tests/recovery_operations.rs` |
| UI crash/coordinator reload never launches/resumes provider | 3, 8 | `host/tests/recovery_e2e.rs::coordinator_disconnect_is_state_only` |
| Proven-dead recovery yields Reviewed queue | 1, 8 | `host/tests/recovery_e2e.rs::dead_host_builds_reviewed_operations` |
| Bootstrap and live operation constructors are identical and reject smuggled state | 1 | `host/tests/recovery_operations.rs::bootstrap_and_live_constructor_match` |
| Immutable shell/provider binding survives mutable config drift | 1, 4 | `host/tests/recovery_operations.rs::config_drift_never_substitutes_execution_binding` |
| Structured one-use evidence identity and replay rejection | 6 | `host/tests/structured_bridge_codec.rs` |
| InputRecipe exact 1..=262,139-byte bounds | 2, 7 | `host/tests/recovery_submission.rs::input_recipe_bounds_are_atomic` |
| Operation retention/pruning bounds | 3 | `host/tests/recovery_reviewed.rs::operation_pruning_preserves_protected_entries` |
| `[M2-TST-REVIEWED-NOBRIDGE]` | 3 | `host/tests/recovery_reviewed.rs` |
| `[M2-TST-REVIEWED-STRUCTURED-EDGE]` | 3, 6 | `host/tests/recovery_structured.rs` |
| Plain Claude/Codex never become Unattended | 1-3 | `host/tests/recovery_unattended.rs::plain_adapters_reject_unattended` |
| Unattended auto-submit false remains Unattended with reviewed continuation gate | 3, 7 | `host/tests/recovery_unattended.rs` |
| Managed Claude exact initial UUID/resume UUID | 2 | `host/tests/recovery_adapters.rs` |
| Initial launch crash/lost ack and stale attempt counters | 2 | `host/tests/recovery_adapters.rs` |
| Claude no `--continue`; Codex no `--last`/picker | 2 | provider fixtures and negative tests |
| Recovery-bound shell/provider actions reconcile one durable effect | 4 | `host/tests/recovery_actions.rs` |
| `submitting` continuation becomes terminal unknown with no resend | 7 | `host/tests/recovery_submission.rs` |
| Concurrent close/shutdown/action gate ordering | 4, 6, 7 | `host/tests/recovery_action_races.rs` |
| Structured TXSB/TXSC codec, bridge containment, crash reconciliation | 6 | structured bridge suites |
| `[M2-TST-STORAGE-PIPE-BOOTSTRAP-ORDER]` | 6 | `host/tests/structured_bridge_win32.rs` |
| `[M2-TST-ARGV-CANONICAL-WIN32]` | 5 | `host/tests/windows_argv.rs` |
| Readiness/acceptance evidence binds current attempts/submission/fingerprint/bytes | 6, 7 | `host/tests/recovery_structured.rs`, `recovery_submission.rs` |
| Send retries remain zero | 7 | `host/tests/recovery_submission_races.rs` |
| Kill-switch sole mutation and every external boundary race | 2, 4, 6, 7 | action/bridge/submission race suites |
| `[M2-TST-RECEIPT-PRUNE-PRECEDENCE]` recovery identities | 2, 4, 7 plus Phase 2 | recovery cache-eviction cases |
| Audit facts contain no forbidden data | 8 | `host/tests/recovery_audit.rs` |
| Fake structured adapter proves qualification without enabling real plain unattended | 1, 6 | `host/tests/recovery_unattended.rs` |
