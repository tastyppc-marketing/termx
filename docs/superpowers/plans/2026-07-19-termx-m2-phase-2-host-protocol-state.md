# TermX M2 Phase 2: Host Protocol and Durable State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace M1’s open, attachment-local protocol and opaque state blob with closed protocol-v2 contracts, one atomic `StateV2`, global lifecycle sequencing, revisioned layout/safety commits, bounded replay, and durable side-effect receipts.

**Architecture:** Narrow shared crates freeze canonical bytes and closed schemas. The host constructs one complete state candidate under `commit_lock`, persists it under `persist_lock`, installs it, increments domain revision/cursor, and broadcasts one canonical event. Protocol handlers become thin validation/dispatch layers; fake-session integration tests close protocol semantics before real ConPTY integration is rerun.

**Tech Stack:** Rust 2021; `termx-canonical`; `termx-contracts`; serde; UUID; SHA-256; Tokio; tokio-tungstenite; tempfile; cross-language JSON fixtures.

## Global Constraints

- Phase 1 exact bytes must be Fable-approved before this phase starts.
- Run with the isolated MSVC target directory from the master plan.
- `commit_lock -> persist_lock -> domain lock` is the only state mutation order. A failed persist changes no memory, domain revision, event cursor, event, receipt, or acknowledgement.
- Closed schemas reject unknown fields, variants, enum values, duplicate keys, unknown schema versions, BOM, invalid UTF-8, and non-finite numbers.
- Every wire/persisted `u64` is a decimal string; TypeScript parity fixtures are added now and consumed in Phase 6.
- Request responses settle correlation only. When a canonical event exists, a response never independently mutates canonical session/layout/safety state.
- Queue limits are enforced by serialized bytes as well as item count.
- This phase does not add Tauri or React production code.
- Integration fixtures are compiled only behind the non-default `termx-host/test-support` feature established in Phase 1.

## Test-Support Contract

`host/src/test_support.rs` adds `StateFixture`, `ProtocolFixture`, `ReceiptFixture`, and `FakeSessionProtocolFixture`. Each fixture boots an in-process host against a temporary protected data directory, exposes exact serialized frame capture, deterministic commit/event/barrier injection, and counts external spawn/queue calls. `ProtocolFixture::boot()` returns clients authenticated through the real codec; `with_failing_sink()` swaps only the `StateSink`; `fill_completed_cache_past_limits()` creates valid completed cache entries without changing durable receipt identities. These helpers are unavailable to release builds.

---

### Task 1: Persist one complete StateV2 candidate

**Files:**
- Modify: `C:\Dev\TermX\host\Cargo.toml`
- Modify: `C:\Dev\TermX\host\src\atomic_state.rs`
- Modify: `C:\Dev\TermX\host\src\registry.rs`
- Modify: `C:\Dev\TermX\host\src\lib.rs`
- Create: `C:\Dev\TermX\host\tests\state_v2_commit.rs`

**Interfaces:**
- Consumes: Phase 1 atomic sink; `termx_contracts::storage::StateV2`.
- Produces:
  ```rust
  pub struct CommitResult<E> {
      pub state_revision: DecimalU64,
      pub event_id: DecimalU64,
      pub event: E,
  }

  impl Registry {
      pub fn committed_state(&self) -> std::sync::Arc<StateV2>;
      pub fn commit_candidate<E>(
          &self,
          build: impl FnOnce(&StateV2) -> anyhow::Result<(StateV2, E)>,
      ) -> anyhow::Result<CommitResult<E>>;
  }
  ```
- Invariant: complete `StateV2` primary/backup bytes are the only installed state; session metadata, layout, safety state, receipt high-water, containment, teardown, and import witness never persist independently.

- [ ] **Step 1: Write failing atomic-domain tests**

```rust
#[test]
fn failed_candidate_changes_no_domain_or_cursor() {
    let fixture = StateFixture::with_failing_sink();
    let before = fixture.registry.committed_state();
    let result = fixture.registry.commit_candidate(|state| {
        let mut next = state.clone();
        next.layout_revision.0 += 1;
        Ok((next, TestEvent::LayoutChanged))
    });
    assert!(result.is_err());
    assert_eq!(*fixture.registry.committed_state(), *before);
    assert_eq!(fixture.events.len(), 0);
}
```

Add a concurrent barrier test proving `GetState` sees either the complete old or complete new state, never a mixed domain candidate.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-host --test state_v2_commit
```

Expected: `StateV2` integration and `commit_candidate` do not exist.

- [ ] **Step 3: Implement the one-candidate commit helper**

Store `Arc<StateV2>` as the authoritative in-memory snapshot. Candidate construction validates all schema bounds before persistence. Persist exact canonical bytes to same-directory temporary, flush, publish primary and approved backup sequence, read back, then install the new `Arc`. Allocate revision/event only in the installed candidate. No subsystem writes state files directly.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-host --test state_v2_commit
cargo test -p termx-host --test committed_state
cargo test -p termx-host registry::tests -- --test-threads=1 *> (Join-Path $PWD 'target-m2\phase2-registry.log')
```

Expected: atomic-domain tests pass and Phase 1 isolation remains green.

- [ ] **Step 5: Commit**

```powershell
git add -- host/Cargo.toml host/src/atomic_state.rs host/src/registry.rs host/src/lib.rs host/tests/state_v2_commit.rs
git commit -m "feat(host): persist atomic StateV2 candidates" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Add protocol-v2 codecs, handshake, errors, and bounds

**Files:**
- Replace/modify: `C:\Dev\TermX\host\src\protocol.rs`
- Modify: `C:\Dev\TermX\host\src\server.rs`
- Create: `C:\Dev\TermX\host\tests\protocol_v2.rs`
- Create: `C:\Dev\TermX\host\tests\protocol_bounds.rs`

**Interfaces:**
- Consumes: `termx_contracts::protocol::*`, committed `StateV2`.
- Produces native authenticated `Preflight`, React `Hello`, correlated request/response IDs, `AuthOk` complete snapshot, closed `ErrorV2`, and exact major mismatch response.
- Invariant: wrong major returns structured mismatch and leaves the live host/sessions untouched.

- [ ] **Step 1: Write failing handshake and boundary tests**

```rust
#[tokio::test]
async fn wrong_major_returns_structured_mismatch_without_shutdown() {
    let host = ProtocolFixture::boot().await;
    let response = host.hello_with_major(99).await;
    assert_eq!(response.error.code, "protocol_major_mismatch");
    assert!(host.process_is_running());
    assert_eq!(host.session_count().await, 1);
}

#[test]
fn auth_ok_accepts_exactly_four_mib_and_rejects_one_more_byte() {
    assert!(encode_application_json(&fixture_auth_ok_bytes(4 * 1024 * 1024)).is_ok());
    assert_eq!(
        encode_application_json(&fixture_auth_ok_bytes(4 * 1024 * 1024 + 1)).unwrap_err().code,
        "snapshot_too_large"
    );
}
```

Also test `Sessions` 1 MiB exact acceptance/+1 rejection, decimal-string `u64`, request-ID echo, unknown fields, and confirmation names rejected as standalone commands.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-host --test protocol_v2
cargo test -p termx-host --test protocol_bounds
```

Expected: v2 messages/handlers are absent or M1 variants deserialize incorrectly.

- [ ] **Step 3: Implement a separate v2 dispatch path and remove unsafe M1 assumptions**

Authenticate before dispatch, require `Hello` as the first React request, and build `AuthOk` from one committed snapshot. Keep native `Preflight` on the trusted native path. Bound complete application JSON after serialization, independent of WebSocket header length. Error objects contain stable code, retriable flag, optional session/operation/request context, and safe message; no string parsing is required by clients.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-host --test protocol_v2
cargo test -p termx-host --test protocol_bounds
cargo test -p termx-host protocol::tests
cargo test -p termx-host server::tests::bad_token_is_rejected -- --exact
```

Expected: v2 and adjacent auth tests pass; mismatch never stops the fixture host.

- [ ] **Step 5: Commit**

```powershell
git add -- host/src/protocol.rs host/src/server.rs host/tests/protocol_v2.rs host/tests/protocol_bounds.rs
git commit -m "feat(host): add closed protocol v2 handshake" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Sequence global lifecycle events and snapshot races

**Files:**
- Create: `C:\Dev\TermX\host\src\events.rs`
- Create: `C:\Dev\TermX\host\tests\event_sequence.rs`
- Modify: `C:\Dev\TermX\host\src\lib.rs`
- Modify: `C:\Dev\TermX\host\src\registry.rs`
- Modify: `C:\Dev\TermX\host\src\server.rs`

**Interfaces:**
- Produces:
  ```rust
  pub struct EventHub {
      pub fn subscribe(&self) -> EventSubscription;
      pub fn publish_committed(&self, event: LifecycleEventV2) -> DecimalU64;
  }
  ```
- `AuthOk`/`GetState` return `event_cursor`; subscribers queue events above that cursor and reduce each exactly once.
- Invariant: two authenticated clients observe the same single event ID for every committed lifecycle mutation.

- [ ] **Step 1: Write failing two-client and race tests**

```rust
#[tokio::test]
async fn two_clients_receive_the_same_single_event_id() {
    let fixture = ProtocolFixture::boot().await;
    let (mut a, mut b) = fixture.two_authenticated_clients().await;
    fixture.create_fake_session().await;
    let ea = a.next_lifecycle_event().await;
    let eb = b.next_lifecycle_event().await;
    assert_eq!(ea.event_id, eb.event_id);
    assert_eq!(ea.kind(), "session_created");
}
```

Add a barrier test racing snapshot capture with a commit; reduce snapshot plus queued events and assert one final canonical result with neither loss nor double apply. Add slow-consumer overflow requiring `resnapshot_required` without blocking the mutation.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-host --test event_sequence
```

Expected: lifecycle events remain origin/attachment-local or lack a global cursor.

- [ ] **Step 3: Publish only from successful commit installation**

Create event envelopes inside the complete state candidate, install the state, then enqueue the same event ID to every subscriber. Never emit before persistence. Slow subscribers are dropped into a bounded resnapshot-required state; registry mutation never waits for them.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-host --test event_sequence
cargo test -p termx-host --test state_v2_commit
cargo test -p termx-host server::tests::close_by_one_client_notifies_other_attached_client -- --exact
```

Expected: all clients share IDs and snapshot race reductions are exact.

- [ ] **Step 5: Commit**

```powershell
git add -- host/src/events.rs host/src/lib.rs host/src/registry.rs host/src/server.rs host/tests/event_sequence.rs
git commit -m "feat(host): sequence global lifecycle events" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Add revisioned layout and safety CAS

**Files:**
- Create: `C:\Dev\TermX\host\src\safety.rs`
- Create: `C:\Dev\TermX\host\tests\layout_safety_cas.rs`
- Modify: `C:\Dev\TermX\host\src\lib.rs`
- Modify: `C:\Dev\TermX\host\src\registry.rs`
- Modify: `C:\Dev\TermX\host\src\server.rs`

**Interfaces:**
- Produces `CommitLayout { expected_revision, layout }`, `CommitSafetyState { expected_revision, mutations }`, canonical conflict responses, and closed `SafetyMutation` variants including only `StoreConfirmation`, `StorePreparedRecoveryConfirmation`, `DeleteConfirmation`, and `SetKillSwitch` according to their dispatch rules.
- Invariant: stale CAS loses without mutation; persist failure exposes no candidate/event; `SetKillSwitch` is the only mutation in its batch.

- [ ] **Step 1: Write failing CAS tests**

```rust
#[tokio::test]
async fn stale_layout_revision_has_one_winner_and_canonical_conflict() {
    let fixture = ProtocolFixture::boot().await;
    let base = fixture.get_state().await.layout_revision;
    let (a, b) = tokio::join!(
        fixture.commit_layout(base, layout("a")),
        fixture.commit_layout(base, layout("b")),
    );
    assert_eq!([a.is_ok(), b.is_ok()].into_iter().filter(|x| *x).count(), 1);
    let conflict = [a, b].into_iter().find_map(Result::err).unwrap();
    assert_eq!(conflict.code, "layout_conflict");
    assert_eq!(conflict.canonical_layout, fixture.get_state().await.layout);
}
```

Add tests for failed persist unchanged, confirmation variants accepted only inside `CommitSafetyState`, standalone command rejection, and mixed `SetKillSwitch` rejection.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-host --test layout_safety_cas
```

Expected: revisioned commands and safety state do not exist.

- [ ] **Step 3: Implement CAS through `commit_candidate` only**

Validate the entire mutation candidate, enforce 512 KiB layout and safety bounds, compare expected revisions under `commit_lock`, persist/install once, increment only the relevant revision once, and emit one full changed-state event. Do not debounce safety commits.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-host --test layout_safety_cas
cargo test -p termx-host --test committed_state
cargo test -p termx-host --test event_sequence
```

Expected: one winner, one canonical conflict, no tentative state/events.

- [ ] **Step 5: Commit**

```powershell
git add -- host/src/safety.rs host/src/lib.rs host/src/registry.rs host/src/server.rs host/tests/layout_safety_cas.rs
git commit -m "feat(host): add layout and safety CAS" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Add durable creation receipts and request reconciliation

**Files:**
- Create: `C:\Dev\TermX\host\src\receipts.rs`
- Create: `C:\Dev\TermX\host\tests\receipt_reconciliation.rs`
- Modify: `C:\Dev\TermX\host\src\lib.rs`
- Modify: `C:\Dev\TermX\host\src\registry.rs`
- Modify: `C:\Dev\TermX\host\src\server.rs`
- Modify: `C:\Dev\TermX\host\src\containment.rs`

**Interfaces:**
- Produces durable request fingerprint/creation sequence/receipt outcome records, bounded completed-request cache, protected pruning, and `action_reconciliation_required`.
- Invariant: cache eviction or acknowledgement loss never repeats a process creation, input admission, repair, termination, or shutdown side effect.
- Acceptance anchor: `[M2-TST-RECEIPT-PRUNE-PRECEDENCE]`.

- [ ] **Step 1: Write failing eviction and crash-prefix tests**

```rust
#[tokio::test]
async fn m2_tst_receipt_prune_precedence_does_not_repeat_creation_after_cache_eviction() {
    let fixture = ReceiptFixture::boot().await;
    let request = fixture.create_request("stable-request");
    let first = fixture.dispatch_create(request.clone()).await.unwrap();
    fixture.fill_completed_cache_past_limits().await;
    let replay = fixture.dispatch_create(request).await.unwrap();
    assert_eq!(replay, first);
    assert_eq!(fixture.spawn_call_count(), 1);
}
```

Table-test reservation persistence, before/after OS call, registration, receipt outcome, acknowledgement loss, startup `reserved -> unknown`, and protected receipt overflow.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-host --test receipt_reconciliation
```

Expected: receipt module and durable reconciliation are absent.

- [ ] **Step 3: Implement durable identity before side effects**

Fingerprint the canonical request. Reserve sequence/receipt inside the same candidate that arms containment. Cache entries optimize response replay only; durable receipt/operation/authorization identity remains authoritative after eviction. Deterministically prune only unprotected terminal receipts. High-water alone cannot fabricate metadata or authorize reuse.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-host --test receipt_reconciliation -- --test-threads=1
cargo test -p termx-host --test containment_prefix -- --test-threads=1 *> (Join-Path $PWD 'target-m2\phase2-containment.log')
```

Expected: one side effect across every replay/crash prefix.

- [ ] **Step 5: Commit**

```powershell
git add -- host/src/receipts.rs host/src/lib.rs host/src/registry.rs host/src/server.rs host/src/containment.rs host/tests/receipt_reconciliation.rs
git commit -m "feat(host): reconcile durable action receipts" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Implement chunked attach, Attached ordering, and bounded byte queues

**Files:**
- Create: `C:\Dev\TermX\host\tests\attach_replay_v2.rs`
- Modify: `C:\Dev\TermX\host\src\protocol.rs`
- Modify: `C:\Dev\TermX\host\src\server.rs`
- Modify: `C:\Dev\TermX\host\src\session.rs`

**Interfaces:**
- Produces `Attach`, sequential `ReplayChunk` frames, `Attached`, then binary frames; `replay:false` yields `Attached` then binary; lag yields bounded resync/detach. Sequentiality is enforced by the host's internal physical-writer completion barrier; protocol v2 defines no renderer-to-host replay acknowledgement command.
- Produces a strong correlated `DetachAccepted` barrier: before enqueueing it, the host closes the matching attachment input gate, removes the matching attachment-map generation, aborts and awaits that generation's forwarder, and submits an ordered-writer barrier after every output item already admitted by that forwarder. A replacement `Attach` independently aborts and awaits any prior forwarder for the same connection/session before creating its receiver or enqueueing replay/`Attached`. Therefore no prior-forwarder binary frame can be physically written after the replacement `Attached`; no wire attachment-generation field is added.
- Invariant: one connection holds at most one encoded and one decoded 512 KiB replay chunk; every non-final replay chunk contains exactly 512 KiB decoded and only the final chunk may be shorter, so an 8 MiB ring produces at most 16 replay envelopes; no output hole or duplicate reduction.

- [ ] **Step 1: Write failing ordered-attach tests**

```rust
#[tokio::test]
async fn initial_attach_orders_replay_then_attached_then_binary() {
    let mut client = FakeSessionProtocolFixture::with_history(b"history").connect().await;
    client.attach(true).await;
    assert!(matches!(client.next().await, HostFrame::ReplayChunk(_)));
    client.complete_next_physical_write().await;
    assert!(matches!(client.next().await, HostFrame::Attached(_)));
    assert!(matches!(client.next().await, HostFrame::BinaryOutput(_)));
}

#[tokio::test]
async fn detach_accepted_is_after_the_prior_forwarder_and_writer_barrier() {
    let mut client = FakeSessionProtocolFixture::active(7).connect().await;
    client.block_next_physical_write();
    client.publish_output(7, b"old").await;
    client.send_detach(7).await;

    assert!(client.try_next().is_none());
    assert_eq!(client.active_forwarder_count(7), 0);

    client.complete_next_physical_write().await;
    assert!(matches!(client.next().await, HostFrame::BinaryOutput(frame) if frame.payload == b"old"));
    assert!(matches!(client.next().await, HostFrame::DetachAccepted(message) if message.session_id == 7));
}

#[tokio::test]
async fn replacement_attach_cannot_cross_prior_forwarder_output() {
    let mut client = FakeSessionProtocolFixture::active(7).connect().await;
    client.block_next_physical_write();
    client.publish_output(7, b"old").await;
    client.send_attach(7, true).await;

    assert!(client.try_next().is_none());
    assert_eq!(client.active_forwarder_count(7), 0);

    client.complete_next_physical_write().await;
    assert!(matches!(client.next().await, HostFrame::BinaryOutput(frame) if frame.payload == b"old"));
    assert!(matches!(client.next().await, HostFrame::ReplayChunk(_)));
    client.complete_all_physical_writes().await;
    assert!(matches!(client.next().await, HostFrame::Attached(message) if message.session_id == 7));
    assert!(!client.remaining_frames().iter().any(HostFrame::is_prior_generation_output));
}
```

`FakeSessionProtocolFixture` implements the methods used above in `C:\Dev\TermX\host\tests\attach_replay_v2.rs`: `active`, `connect`, `block_next_physical_write`, `publish_output`, `send_detach`, `send_attach`, `try_next`, `next`, `active_forwarder_count`, `complete_next_physical_write`, `complete_all_physical_writes`, and `remaining_frames`. `HostFrame::is_prior_generation_output` is a test-fixture predicate backed by the fixture's internal forwarder-generation tag; that tag never enters protocol v2.

Add `replay:false`, overlap trim, forward gap, slow consumer, and 8 MiB ring chunking tests.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-host --test attach_replay_v2
```

Expected: M1 sends a single Replay/no Attached and uses item-only queue accounting.

- [ ] **Step 3: Implement sequential replay cursor and byte budgets**

Generate one chunk, serialize it into one outbound item, await the host-owned writer's physical-write completion signal, release that encoded/decoded chunk ownership, and only then advance the replay cursor and generate the next chunk. This is an internal writer barrier, not a wire acknowledgement from React. Buffer bounded live output during replay; after the final chunk's physical write completes, enqueue `Attached`, then release live frames. On queue-byte overflow or forward gap, detach and require fresh snapshot/replay; never block the session reader.

Implement `Detach` in this exact order under the connection attachment-state gate: locate the matching attachment-map generation; close its input gate; remove that generation so no later binary input can target it; signal its forwarder abort; release the state gate while awaiting the forwarder join; submit an ordered-writer barrier after all output items the joined forwarder admitted; await that barrier's physical completion; reacquire state only to verify no newer matching generation was removed; then enqueue correlated `DetachAccepted`. Connection cleanup uses the same abort/join/barrier primitive but emits no response. A replacement `Attach` invokes that primitive for any prior forwarder before it creates the bounded receiver or snapshots the ring. Failure to abort, join, or complete the writer barrier closes the connection without sending `DetachAccepted` or starting a replacement forwarder. The internal fixture may tag generations for proof, but no generation field is serialized on the wire.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-host --test attach_replay_v2
cargo test -p termx-host server::tests::lagged_forwarder_resyncs_via_replay_with_no_holes -- --exact
cargo test -p termx-host server::tests::attach_without_replay_suppresses_the_initial_replay -- --exact
```

Expected: ordering and byte caps pass; adjacent M1 semantics are preserved through v2 equivalents.

- [ ] **Step 5: Commit**

```powershell
git add -- host/src/protocol.rs host/src/server.rs host/src/session.rs host/tests/attach_replay_v2.rs
git commit -m "feat(host): add ordered bounded replay attach" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Add ConfigV2 pretty-byte CAS, profile discovery, and argv classification

**Files:**
- Create: `C:\Dev\TermX\host\src\argv_classifier.rs`
- Create: `C:\Dev\TermX\host\tests\profile_argv.rs`
- Modify: `C:\Dev\TermX\crates\termx-contracts\src\config.rs`
- Create: `C:\Dev\TermX\crates\termx-contracts\tests\config_v2.rs`
- Modify: `C:\Dev\TermX\host\src\lib.rs`
- Modify: `C:\Dev\TermX\host\src\config.rs`
- Modify: `C:\Dev\TermX\host\src\profiles.rs`
- Modify: `C:\Dev\TermX\host\src\server.rs`
- Create: `C:\Dev\TermX\fixtures\config\config-v2-pretty.json`
- Create: `C:\Dev\TermX\fixtures\argv\credential-classifier-v1.json`

**Interfaces:**
- Extends the Phase 1 pure `termx-contracts::config` module with the shared behavior required by both the detached host and Phase 5 native `ReadConfig`/`WriteConfig`:
  ```rust
  pub const MAX_CONFIG_FILE_BYTES: usize = 1024 * 1024;

  #[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
  pub struct Sha256Fingerprint([u8; 32]);

  #[derive(Clone, Copy, Debug, Eq, PartialEq)]
  pub enum FingerprintParseError {
      InvalidPrefix,
      InvalidLength,
      InvalidHex,
      UppercaseHex,
  }

  impl Sha256Fingerprint {
      pub fn from_raw_bytes(bytes: &[u8]) -> Self;
      pub fn parse(encoded: &str) -> Result<Self, FingerprintParseError>;
      pub fn encode(self) -> String;
  }

  #[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
  pub enum ConfigContentHash {
      Missing,
      Present(Sha256Fingerprint),
  }

  #[derive(Clone, Copy, Debug, Eq, PartialEq)]
  pub enum ConfigValidationReasonV1 {
      MalformedJson,
      InvalidType,
      InvalidUnicode,
      NonFiniteNumber,
      ExcessiveDepth,
      ExcessiveNodes,
      ConfigTooLarge,
      InvalidScrollbackBytes,
      InvalidDefaultProfileId,
      InvalidProfileId,
      InvalidExtensionKey,
      InvalidArgumentVector,
      InvalidEnvironmentExpansion,
      MissingEnvironmentVariable,
      CredentialBearingArgv,
  }

  #[derive(Clone, Copy, Debug, Eq, PartialEq)]
  pub struct ConfigValidationErrorV1 {
      pub reason_code: ConfigValidationReasonV1,
      pub argument_index: Option<u16>,
  }

  pub enum CredentialArgvClassificationV1 {
      Clean,
      SecretBearing { argument_index: u16 },
  }

  pub trait ConfigEnvironment {
      fn value(&self, allowlisted_name: &str) -> Option<&str>;
  }

  pub trait GeneratedProfileArguments {
      fn defaults_for(&self, profile_id: &str) -> Option<&[String]>;
  }

  pub fn default_config_v2() -> ConfigV2;
  pub fn config_content_hash(raw: Option<&[u8]>) -> ConfigContentHash;
  pub fn parse_config_v2(raw: &[u8]) -> Result<ConfigV2, ConfigValidationErrorV1>;
  pub fn validate_config_v2_shape(
      config: &ConfigV2,
  ) -> Result<(), ConfigValidationErrorV1>;
  pub fn validate_config_v2_effective_argv(
      config: &ConfigV2,
      environment: &impl ConfigEnvironment,
      generated_arguments: &impl GeneratedProfileArguments,
  ) -> Result<(), ConfigValidationErrorV1>;
  pub fn encode_config_v2_pretty(
      config: &ConfigV2,
  ) -> Result<Vec<u8>, ConfigValidationErrorV1>;
  pub fn classify_credential_argv(
      argv: &[String],
  ) -> CredentialArgvClassificationV1;
  ```
  `ConfigContentHash::Missing` serializes/deserializes only the exact string `missing:v1`; `ConfigContentHash::Present` and `Sha256Fingerprint` serialize/deserialize only `sha256:v1:<64 lowercase hex>`. `default_config_v2()` is fixture-pinned to schema version 2, 4,194,304 scrollback bytes, default profile ID `powershell`, empty profile overrides, and empty extensions. `parse_config_v2` enforces the 1 MiB raw-file cap before allocation/parsing and strict UTF-8/BOM/duplicate-key/closed-schema rules. `encode_config_v2_pretty` emits UTF-8 without BOM, recursively scalar-sorted object keys, two-space indentation, LF, RFC-8785-compatible binary64 spelling, and one trailing newline; it is not JCS. The pure module owns no filesystem, process, environment read, lock, Tokio, Windows, WebSocket, or Tauri behavior; callers inject environment values and generated default argv.
- Produces host discovery for PowerShell 7/Git Bash/WSL, immutable profile binding input, and the compiled `CredentialArgvClassifierV1`. Host config load and every process/provider boundary call the shared pure validator/classifier; Phase 5 later uses the exact same APIs under its native config-write lock.
- Invariant: credential-bearing argv is rejected and never echoed, logged, stored, previewed, queued, or passed to a process boundary. `ConfigValidationErrorV1` contains only the closed reason and optional safe argument index.
- Acceptance anchor: `[M2-TST-PROFILE-ARGV-SECRETS]` (host portion).

- [ ] **Step 1: Write failing classifier and config-byte tests**

```rust
#[test]
fn m2_tst_profile_argv_secrets_reports_only_the_safe_index() {
    for (argv, expected_index) in [
        (vec!["--api-key", "DO_NOT_LOG"], 0),
        (vec!["--TOKEN=DO_NOT_LOG"], 0),
        (vec!["SERVICE_PASSWORD=DO_NOT_LOG"], 0),
        (vec!["clean", "-p", "DO_NOT_LOG"], 1),
    ] {
        assert_eq!(
            classify_credential_argv(
                &argv.into_iter().map(String::from).collect::<Vec<_>>(),
            ),
            CredentialArgvClassificationV1::SecretBearing {
                argument_index: expected_index,
            },
        );
    }
}

#[test]
fn config_hash_distinguishes_missing_empty_and_whitespace_edits() {
    assert_eq!(config_content_hash(None), ConfigContentHash::Missing);
    let empty = config_content_hash(Some(b""));
    let compact = config_content_hash(Some(br#"{"schema_version":2}"#));
    let spaced = config_content_hash(Some(b"{ \"schema_version\": 2 }"));
    assert_ne!(empty, ConfigContentHash::Missing);
    assert_ne!(compact, spaced);
}

#[test]
fn config_v2_pretty_fixture_has_exact_bytes_and_raw_hash() {
    let config: ConfigV2 = config_v2_fixture();
    let encoded = encode_config_v2_pretty(&config).unwrap();
    assert_eq!(
        encoded,
        include_bytes!("../../../fixtures/config/config-v2-pretty.json"),
    );
    assert_eq!(encoded.last(), Some(&b'\n'));
    assert!(!encoded.starts_with(&[0xef, 0xbb, 0xbf]));
    assert_eq!(
        config_content_hash(Some(&encoded)),
        ConfigContentHash::Present(
            Sha256Fingerprint::parse(EXACT_CONFIG_V2_PRETTY_SHA256).unwrap(),
        ),
    );
}

#[test]
fn invalid_config_error_never_carries_the_rejected_argument() {
    let mut config = config_v2_fixture();
    config.profile_overrides.get_mut("powershell").unwrap().arguments =
        Some(vec!["--token=DO_NOT_LOG".to_owned()]);
    let error = validate_config_v2_effective_argv(
        &config,
        &FixtureEnvironment::complete(),
        &FixtureGeneratedArguments::clean(),
    )
    .unwrap_err();
    assert_eq!(error.reason_code, ConfigValidationReasonV1::CredentialBearingArgv);
    assert_eq!(error.argument_index, Some(0));
    assert!(!format!("{error:?}").contains("DO_NOT_LOG"));
}
```

Add one table-driven case for every `ConfigValidationReasonV1`; exact 1 MiB/1 MiB+1 raw-file boundaries; nested duplicate keys, BOM, malformed UTF-8, lone-surrogate escape, numeric overflow/non-finite, depth 64/65, extension-node 4,096/4,097, profile/argument/aggregate caps, disallowed and missing environment variables, all fixed flag/suffix classifier spellings, ASCII case folding, first-`=` handling, empty assignment names, total clean classification, recursively sorted extension objects, normalized negative zero, and exact RFC-8785-compatible exponent spelling. Add deterministic discovery fixtures using injected environment/filesystem probes.

- [ ] **Step 2: Run RED**

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'
cargo test -p termx-contracts --test config_v2
cargo test -p termx-host --test profile_argv
cargo test -p termx-host config::tests
cargo test -p termx-host profiles::tests
```

Expected: shared config validation/pretty-byte/hash APIs, classifier, and discovery behavior are absent; `config_v2` fails to compile on `MAX_CONFIG_FILE_BYTES`/`encode_config_v2_pretty`, and `profile_argv` fails to compile on `classify_credential_argv`.

- [ ] **Step 3: Implement validation before every profile/process boundary**

Implement the pure config codec, hash parser/formatter, environment-expansion validator, and credential classifier in `termx-contracts::config`; fixture-test them without filesystem or process access. Compile the classifier literals/version into the shared module so host config and Phase 5 native writes cannot diverge; neither config nor adapter can extend it. Host discovery supplies captured allowlisted environment values and generated defaults, then validates append/replace effective vectors before creating `ProfileInfoV2` or any immutable process binding. Keep config pretty serialization separate from JCS, recursively sort keys, use exact raw-file SHA-256, and ensure every error stores only its closed reason plus optional argument index.

- [ ] **Step 4: Verify GREEN**

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'
cargo test -p termx-contracts --test config_v2
cargo test -p termx-host --test profile_argv
cargo test -p termx-host config::tests
cargo test -p termx-host profiles::tests
cargo clippy -p termx-contracts -p termx-host --all-targets -- -D warnings
```

Expected: exact bytes/hashes, all validation boundaries, and all secret vectors pass without secret output; the shared crate still has no filesystem/platform/runtime dependency.

- [ ] **Step 5: Commit**

```powershell
git add -- crates/termx-contracts/src/config.rs crates/termx-contracts/tests/config_v2.rs host/src/argv_classifier.rs host/src/lib.rs host/src/config.rs host/src/profiles.rs host/src/server.rs host/tests/profile_argv.rs fixtures/config/config-v2-pretty.json fixtures/argv/credential-classifier-v1.json
git commit -m "feat(host): validate profiles and credential argv" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Implement prepared/native-authorized shutdown protocol

**Files:**
- Create: `C:\Dev\TermX\host\src\shutdown.rs`
- Create: `C:\Dev\TermX\host\tests\shutdown_v2.rs`
- Modify: `C:\Dev\TermX\host\src\lib.rs`
- Modify: `C:\Dev\TermX\host\src\server.rs`
- Modify: `C:\Dev\TermX\host\src\safety.rs`
- Modify: `C:\Dev\TermX\host\src\main.rs`

**Interfaces:**
- Produces prepare/cancel/finalize/native-read/native-authorization/consume/shutdown transaction records, shutdown epoch, and exact explicit-quit/restart confirmation mapping.
- Invariant: bearer-only or direct shutdown is rejected; second consumption/replay/tampering/staleness is rejected; post-epoch mutations return `shutting_down`.

- [ ] **Step 1: Write failing shutdown transaction tests**

```rust
#[tokio::test]
async fn direct_bearer_only_shutdown_is_rejected() {
    let fixture = ProtocolFixture::boot().await;
    let error = fixture.send_shutdown_without_native_authorization().await.unwrap_err();
    assert_eq!(error.code, "shutdown_not_authorized");
    assert!(fixture.host_is_running());
}

#[tokio::test]
async fn two_hundred_fifty_seven_inactive_shutdown_confirmations_do_not_exhaust_cap() {
    let fixture = ProtocolFixture::boot_with_frozen_clock().await;

    for sequence in 0..257 {
        let transaction = fixture.prepare_explicit_quit(sequence).await.unwrap();
        fixture.store_exact_shutdown_confirmation(&transaction).await.unwrap();
        if sequence % 2 == 0 {
            fixture.cancel_shutdown_preparation(&transaction).await.unwrap();
        } else {
            fixture.advance_past_expiry(&transaction);
            fixture.sweep_inactive_shutdown_confirmations().await.unwrap();
        }
    }

    let fresh = fixture.prepare_explicit_quit(257).await.unwrap();
    fixture.store_exact_shutdown_confirmation(&fresh).await.unwrap();
    assert!(fixture.confirmation_count() <= 256);
    assert_eq!(
        fixture.authorize_deleted_confirmation().await.unwrap_err().code(),
        "shutdown_confirmation_inactive",
    );
}
```

Add wrong-key/tampered hash/nonce replay/expiry/stale revision/changed affected set/second consumption tests and a barrier test with pre-/post-shutdown-epoch commits. For the 257-case reclamation fixture, freeze timestamps and UUIDs; prove the deterministic `(confirmed_at, confirmation_id)` sweep removes only expired/inactive unreferenced `explicit_quit|explicit_restart` confirmations before cap rejection, preserves every live pending/finalized/native-authorized reference, leaves operation state unchanged, keeps the 257th and a subsequent fresh confirmation admissible, and makes every swept confirmation permanently unable to authorize a later preparation.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-host --test shutdown_v2
```

Expected: current M1 bearer command shuts down or lacks the transaction.

- [ ] **Step 3: Implement host half of native authorization**

Keep shutdown key in runtime discovery and trusted host/native memory only. React-visible messages carry no key. Finalization freezes exact canonical preview/hash/revision/affected operation set and returns a native-readable authorization reference. Consume exactly once; commit final state and shutdown epoch before waiting for teardown. Do not start replacement here; Tauri owns that in Phase 5.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-host --test shutdown_v2 -- --test-threads=1
cargo test -p termx-host --test e2e full_lifecycle_against_real_binary -- --exact --test-threads=1 *> (Join-Path $PWD 'target-m2\phase2-e2e.log')
```

Expected: direct shutdown is refused; authorized exact flow exits cleanly; duplicate/tampered flows do nothing.

- [ ] **Step 5: Commit**

```powershell
git add -- host/src/shutdown.rs host/src/lib.rs host/src/server.rs host/src/safety.rs host/src/main.rs host/tests/shutdown_v2.rs
git commit -m "feat(host): require native-authorized shutdown" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Phase 2 Acceptance Coverage

| Specification acceptance requirement | Owning task | Exact primary test |
|---|---:|---|
| Wrong major is structured and non-destructive | 2 | `host/tests/protocol_v2.rs::wrong_major_is_structured_and_non_destructive` |
| Two clients receive the same single event ID for canonical mutations | 3 | `host/tests/lifecycle_events.rs::authenticated_clients_reduce_identical_event_ids` |
| Snapshot/cursor race has no loss or double reduction | 3 | `host/tests/lifecycle_events.rs::snapshot_cursor_handoff_is_exact` |
| Slow event consumer cannot block mutation and must resnapshot | 3 | `host/tests/lifecycle_events.rs::slow_consumer_is_disconnected_with_resnapshot_required` |
| `ReplayChunk -> Attached -> binary` and replay-false ordering | 6 | `host/tests/attach_v2.rs` ordering cases |
| Layout CAS has one winner and canonical conflict | 4 | `host/tests/layout_cas.rs::concurrent_layout_cas_has_one_winner` |
| Failed persistence exposes no candidate/event | 1, 4 | `host/tests/state_v2_commit.rs`, `host/tests/layout_cas.rs` |
| Exact 4 MiB/1 MiB complete application JSON caps | 2 | `host/tests/protocol_v2.rs::snapshot_payload_caps_are_application_json_bytes` |
| Oversized startup suppresses listener/runtime with no truncation | 2 | `host/tests/protocol_v2.rs::oversized_startup_snapshot_publishes_no_listener` |
| Unknown mutation completion reconciles through `GetState` | 3, 5 | `host/tests/receipt_reconciliation.rs::unknown_completion_requires_state_reconciliation` |
| Confirmation operations exist only as closed `CommitSafetyState` mutations | 4 | `host/tests/safety_cas.rs::confirmation_mutations_are_closed_and_idempotent` |
| Config CAS uses exact pretty raw bytes, not JCS | 7 | `host/tests/config_v2.rs::config_cas_hashes_exact_pretty_bytes` |
| `[M2-TST-PROFILE-ARGV-SECRETS]` host/config portion | 7 | `host/tests/profile_argv.rs` plus `fixtures/argv/credential-classifier.json` |
| `[M2-TST-RECEIPT-PRUNE-PRECEDENCE]` | 5 | `host/tests/receipt_reconciliation.rs` |
| Prepared/native-authorized shutdown, final epoch, and idempotent final bytes | 8 | `host/tests/shutdown_v2.rs` |
| 257 cancelled/expired shutdown preparations reclaim inactive confirmations before the 256-record cap | 8 | `host/tests/shutdown_v2.rs::two_hundred_fifty_seven_inactive_shutdown_confirmations_do_not_exhaust_cap` |

### Task 9: Close the Phase 2 protocol/state gate

**Files:**
- Modify: `C:\Dev\TermX\README.md`
- Modify: `C:\Dev\TermX\specs\handoffs\001-2026-07-17-termx-m1-host-core.md`
- Test: all shared-crate and host targets.

**Interfaces:**
- Produces frozen contracts consumed by storage, Tauri, and React phases.

- [ ] **Step 1: Add a full fake-session protocol lifecycle test**

Add to `protocol_v2.rs` one test that authenticates two clients, creates a fake generation through durable receipt APIs, installs a snapshot, attaches with chunked replay, observes shared create/resize/exit/close/layout events, and proves cache-evicted request replay creates no second generation.

- [ ] **Step 2: Run RED before wiring the last fake-session adapter methods**

```powershell
cargo test -p termx-host --test protocol_v2 full_v2_fake_session_lifecycle -- --exact
```

Expected: missing fake-session adapter operations prevent completion.

- [ ] **Step 3: Add only test-support adapter plumbing and documentation**

The production server continues to dispatch through the same registry/session-provider trait; test support substitutes deterministic fake output and barriers. Document v2 mismatch/non-destructive behavior and explicit native-authorized shutdown in `README.md`.

- [ ] **Step 4: Run full Phase 2 verification and Fable review**

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test -p termx-canonical
cargo test -p termx-contracts
cargo test -p termx-host --lib -- --test-threads=1 *> (Join-Path $PWD 'target-m2\phase2-lib.log')
cargo test -p termx-host --tests -- --test-threads=1 *> (Join-Path $PWD 'target-m2\phase2-tests.log')
```

Expected: all exit 0. Send exact diff and outputs to Fable; fix and re-review every confirmed issue.

- [ ] **Step 5: Commit**

```powershell
git add -- README.md host/tests/protocol_v2.rs specs/handoffs/001-2026-07-17-termx-m1-host-core.md
git commit -m "test(host): close protocol v2 state gate" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```
