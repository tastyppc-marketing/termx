# TermX M2 Phase 1: Host Safety Prerequisites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make host state publication and Windows process containment fail closed so protocol-v2, Tauri, and React can be added without exposing tentative state or orphaning ConPTY processes.

**Architecture:** Introduce one persist-then-install state boundary and one exact Windows ownership layer. Session creation reserves durable identity before process creation, uses a Job Object plus retained exact process handles, and either registers one generation or leaves one bounded durable containment record; close uses a two-commit graveyard flow and performs all blocking/destructive work outside registry and persistence locks.

**Tech Stack:** Rust 2021, Tokio, portable-pty 0.9, `windows-sys`, serde/serde_json, tempfile, real Windows MSVC integration tests.

## Global Constraints

- Run from `C:\Dev\TermX` with `$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'`; never touch the locked default artifact or terminate PID 54876.
- Do not create `C:\Dev\TermX\ui` or Tauri production files until every task in this phase is green and Fable-approved.
- Existing behavioral defects require deterministic failing assertions, not sleep-only tests.
- Lock order is `commit_lock -> persist_lock -> registry/domain lock`; blocking process waits, Job termination, ConPTY close, reader drain, and callbacks run after all three are released.
- Persistence failure changes no installed memory, revision, event cursor, event, receipt outcome, or externally visible candidate.
- Destructive process action requires a retained exact process handle and matching creation `FILETIME`; PID-only targeting, `taskkill`, and unverified `portable-pty child.kill()` are forbidden.
- All injected post-spawn failures produce either proven exact absence or one durable `armed|containment_uncertain` record; uncertainty is never reported as success or `failed_pre_action`.
- Each task ends with focused tests, adjacent host tests, exact diff review, Fable review, and one commit with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Integration-test helpers live behind a non-default `test-support` Cargo feature in `host/src/test_support.rs`; production release behavior cannot call failure injection or expose raw handles.

## Test-Support Contract

Task 3 creates `termx_host::job::test_support::{spawn_suspended_cmd, capture_jobbed_process_creation}` returning owned helpers with `identity()`, `is_running()`, `cleanup_without_resume()`, and a `ProcessCreationTrace` carrying every asserted mask/flag. Task 4 creates `termx_host::containment::test_support::run_creation_until(Prefix) -> CreationPrefixOutcome`. Task 5 creates `TeardownFixture` with the exact methods used by its barrier test. Task 6 creates the local `E2eFixture::{with_setup_failure, start_host, collect_termx_descendants, scan_openconsole_for_test_tree}` in `host/tests/e2e.rs`. Every integration-test target enables `termx-host/test-support`; `cargo build -p termx-host --release` does not.

---

### Task 1: Freeze canonical bytes and closed contract crates

**Files:**
- Modify: `C:\Dev\TermX\Cargo.toml`
- Create: `C:\Dev\TermX\crates\termx-canonical\Cargo.toml`
- Create: `C:\Dev\TermX\crates\termx-canonical\src\lib.rs`
- Create: `C:\Dev\TermX\crates\termx-canonical\tests\jcs_fixtures.rs`
- Create: `C:\Dev\TermX\crates\termx-contracts\Cargo.toml`
- Create: `C:\Dev\TermX\crates\termx-contracts\src\lib.rs`
- Create: `C:\Dev\TermX\crates\termx-contracts\src\protocol.rs`
- Create: `C:\Dev\TermX\crates\termx-contracts\src\layout.rs`
- Create: `C:\Dev\TermX\crates\termx-contracts\src\config.rs`
- Create: `C:\Dev\TermX\crates\termx-contracts\src\storage.rs`
- Create: `C:\Dev\TermX\crates\termx-contracts\src\safety.rs`
- Create: `C:\Dev\TermX\crates\termx-contracts\src\recovery.rs`
- Create: `C:\Dev\TermX\crates\termx-contracts\src\native.rs`
- Create: `C:\Dev\TermX\crates\termx-contracts\tests\schema_validation.rs`
- Create: `C:\Dev\TermX\crates\termx-contracts\tests\native_schema_validation.rs`
- Create: `C:\Dev\TermX\fixtures\canonical\state-v2-fresh.json`
- Create: `C:\Dev\TermX\fixtures\canonical\layout-v1.json`
- Create: `C:\Dev\TermX\fixtures\canonical\shutdown-preview-v1.json`
- Create: `C:\Dev\TermX\fixtures\canonical\recovery-action-preview-v1.json`

**Interfaces:**
- Produces:
  ```rust
  pub fn parse_strict<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, CanonicalError>;
  pub fn to_jcs_bytes<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, CanonicalError>;
  pub fn jcs_sha256<T: serde::Serialize>(value: &T) -> Result<[u8; 32], CanonicalError>;

  #[derive(Clone, Copy, Eq, PartialEq, Ord, PartialOrd)]
  pub struct DecimalU64(pub u64);
  ```
- `termx-contracts` exports the exact closed protocol/storage/layout/config/safety/recovery schema names from the approved specification, including `ProcessIdentityV1`, `UnregisteredContainmentRecordV1`, `StateV2`, and every bounded enum used by later tasks. `storage.rs` owns `StorageRepairPreviewV1`, `StorageRepairAuthorizationV1`, `StorageRepairExecutionResultV1`, and the internally tagged `StorageRepairStatusV1`; `native.rs` owns the seven §4.2 native request DTOs and four direct result wrappers:
  ```rust
  #[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
  #[serde(deny_unknown_fields)]
  pub struct ConfirmShutdownRequestV1 {
      pub authorization: ShutdownAuthorizationV1,
  }

  #[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
  #[serde(deny_unknown_fields)]
  pub struct ConfirmTeardownRepairRequestV1 {
      pub preparation_id: uuid::Uuid,
  }

  #[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
  #[serde(deny_unknown_fields)]
  pub struct PrepareStorageRepairRequestV1 {
      pub request_id: RequestId,
      pub mode: StorageRepairModeV1,
      pub record_id: Option<uuid::Uuid>,
  }

  #[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
  #[serde(deny_unknown_fields)]
  pub struct ConfirmStorageRepairRequestV1 {
      pub request_id: RequestId,
      pub repair_id: uuid::Uuid,
      pub plan_hash: Sha256Hex,
  }

  #[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
  #[serde(deny_unknown_fields)]
  pub struct ExecuteStorageRepairRequestV1 {
      pub request_id: RequestId,
      pub repair_id: uuid::Uuid,
      pub plan_hash: Sha256Hex,
      pub authorization_id: uuid::Uuid,
  }

  #[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
  #[serde(deny_unknown_fields)]
  pub struct CancelStorageRepairRequestV1 {
      pub request_id: RequestId,
      pub repair_id: uuid::Uuid,
      pub plan_hash: Sha256Hex,
  }

  #[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
  #[serde(deny_unknown_fields)]
  pub struct GetStorageRepairStatusRequestV1 {
      pub request_id: RequestId,
      pub repair_id: uuid::Uuid,
  }

  #[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
  #[serde(tag = "outcome", rename_all = "snake_case")]
  pub enum NativeShutdownAuthorizationResult {
      Authorized {
          confirmation_id: uuid::Uuid,
          expires_at: Timestamp,
      },
      Cancelled,
      Stale,
      Expired,
      OwnershipLost,
  }

  #[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
  #[serde(tag = "outcome", rename_all = "snake_case")]
  pub enum NativeTeardownRepairResult {
      Repaired {
          session_id: u32,
          lifecycle_generation: uuid::Uuid,
      },
      Cancelled,
      Stale,
      Expired,
      OwnershipLost,
  }

  #[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
  #[serde(deny_unknown_fields)]
  pub struct StorageRepairPrepared {
      pub request_id: RequestId,
      pub preview: StorageRepairPreviewV1,
  }

  #[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
  #[serde(deny_unknown_fields)]
  pub struct StorageRepairAuthorized {
      pub request_id: RequestId,
      pub authorization: StorageRepairAuthorizationV1,
  }

  #[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
  #[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
  pub enum StorageRepairStatusV1 {
      Prepared {
          request_id: RequestId,
          preview: StorageRepairPreviewV1,
      },
      Authorized {
          immutable_plan: StorageRepairPreviewV1,
          authorization: StorageRepairAuthorizationV1,
      },
      InProgress {
          repair_id: uuid::Uuid,
          authorization_id: uuid::Uuid,
          phase: StorageRepairActivePhaseV1,
          plan_hash: Sha256Hex,
      },
      Completed {
          result: StorageRepairExecutionResultV1,
      },
      Cancelled {
          result: StorageRepairExecutionResultV1,
      },
      Ambiguous {
          repair_id: uuid::Uuid,
          reason_code: StorageRepairAmbiguousReasonV1,
      },
  }
  ```
- Every shared contract uses exact recursive `snake_case` JSON field names. Optional fields serialize with `#[serde(skip_serializing_if = "Option::is_none")]`; strict lexical validation rejects explicit `null` when the schema says absent-or-present rather than nullable. The Phase 5-only bootstrap/config/rejection adapters follow the same native wire rule but remain owned by Phase 5 because they are not §4.2 shared domain contracts.
- Invariant: Rust and later TypeScript implementations derive identical strict parse results, canonical bytes, lengths, decimal encodings, field names, optional-field presence, and hashes; these crates own no I/O, locks, processes, WebSockets, Windows, Tokio, or Tauri behavior.

- [ ] **Step 1: Write failing canonical/schema fixture tests**

```rust
#[test]
fn fixed_small_jcs_fixture_has_exact_bytes_length_and_hash() {
    let value: serde_json::Value = termx_canonical::parse_strict(br#"{"b":2,"a":1}"#).unwrap();
    let canonical = termx_canonical::to_jcs_bytes(&value).unwrap();
    assert_eq!(canonical, br#"{"a":1,"b":2}"#);
    assert_eq!(canonical.len(), 13);
    assert_eq!(
        hex::encode(termx_canonical::jcs_sha256(&value).unwrap()),
        "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
}

#[test]
fn fixed_state_v2_fixture_round_trips_exact_canonical_bytes() {
    let fixture = include_bytes!("../../../fixtures/canonical/state-v2-fresh.json");
    let value: termx_contracts::storage::StateV2 =
        termx_canonical::parse_strict(fixture).unwrap();
    assert_eq!(termx_canonical::to_jcs_bytes(&value).unwrap(), fixture);
}

#[test]
fn strict_parser_rejects_nested_duplicate_and_unknown_field() {
    assert!(termx_canonical::parse_strict::<termx_contracts::layout::LayoutV1>(
        br#"{"schema_version":1,"tabs":[],"tabs":[],"groups":[],"unknown":1}"#,
    )
    .is_err());
}

#[test]
fn storage_repair_status_internal_tag_rejects_unknown_field() {
    use termx_contracts::storage::{
        StorageRepairAmbiguousReasonV1,
        StorageRepairStatusV1,
    };

    let status = StorageRepairStatusV1::Ambiguous {
        repair_id: uuid::Uuid::parse_str(
            "11111111-1111-4111-8111-111111111111",
        )
        .unwrap(),
        reason_code:
            StorageRepairAmbiguousReasonV1::StorageRepairAmbiguous,
    };
    let mut value = serde_json::to_value(status).unwrap();
    value
        .as_object_mut()
        .unwrap()
        .insert("unexpected".to_owned(), serde_json::Value::Bool(true));
    let bytes = serde_json::to_vec(&value).unwrap();

    let error = termx_canonical::parse_strict::<StorageRepairStatusV1>(&bytes)
        .unwrap_err();
    assert!(error.to_string().contains("unknown field `unexpected`"));
}

#[test]
fn storage_repair_status_internal_tag_rejects_unknown_variant() {
    use termx_contracts::storage::StorageRepairStatusV1;

    let error = termx_canonical::parse_strict::<StorageRepairStatusV1>(
        br#"{"state":"forgotten","repair_id":"11111111-1111-4111-8111-111111111111"}"#,
    )
    .unwrap_err();
    assert!(error.to_string().contains("unknown variant `forgotten`"));
}
```

These two tests mechanically verify that serde 1.0.228 routes an internally tagged struct variant through `StructForm::InternallyTagged` while retaining the enum container's `deny_unknown_fields`, and that the tag dispatcher remains closed. Do not rely on derive intuition alone. The valid value is built through the real enum serializer before only the deliberately unknown member is inserted, so the failure cannot be caused by an incomplete hand-written variant fixture.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-canonical --test jcs_fixtures
cargo test -p termx-contracts --test schema_validation
cargo test -p termx-contracts --test native_schema_validation
```

Expected: packages, types, and functions do not exist.

- [ ] **Step 3: Implement the minimum pure crates**

Use a duplicate-detecting serde visitor rather than `serde_json::from_slice` directly. Implement the approved RFC 8785/JCS and strict parser rules exactly; ordinary `serde_json::to_vec` member order is not canonical. Keep dependencies one-way:

```text
termx-canonical -> serde, serde_json, sha2, thiserror
termx-contracts -> termx-canonical, serde, uuid
```

Add a metadata test that fails if either crate gains `tokio`, `windows-sys`, or `tauri`. Keep human-editable ConfigV2 pretty serialization outside the JCS helper even though `ConfigV2` is a closed contract.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-canonical
cargo test -p termx-contracts
cargo tree -p termx-canonical
cargo tree -p termx-contracts
cargo fmt --all -- --check
```

Expected: fixtures and negative parsing pass; dependency trees contain no forbidden runtime/platform crates.

- [ ] **Step 5: Commit**

```powershell
git add -- Cargo.toml crates/termx-canonical crates/termx-contracts fixtures/canonical
git commit -m "feat(contracts): add canonical M2 schemas" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Reproduce and fix committed-state layout isolation

**Files:**
- Create: `C:\Dev\TermX\host\src\atomic_state.rs`
- Create: `C:\Dev\TermX\host\tests\committed_state.rs`
- Modify: `C:\Dev\TermX\host\src\lib.rs`
- Modify: `C:\Dev\TermX\host\src\registry.rs`
- Modify: `C:\Dev\TermX\host\Cargo.toml`

**Interfaces:**
- Consumes: existing `Registry::set_layout`, `Registry::layout`, and persisted state file behavior.
- Produces:
  ```rust
  pub trait StateSink: Send + Sync {
      fn persist(&self, bytes: &[u8]) -> anyhow::Result<()>;
  }

  pub struct AtomicFileStateSink {
      primary: std::path::PathBuf,
      temporary: std::path::PathBuf,
  }

  impl AtomicFileStateSink {
      pub fn new(data_dir: &std::path::Path) -> Self;
  }

  impl Registry {
      pub fn new_with_state_sink(
          data_dir: std::path::PathBuf,
          config: Config,
          sink: std::sync::Arc<dyn StateSink>,
      ) -> Self;
  }
  ```
- Invariant: no reader can observe a layout candidate until its exact durable bytes have been flushed and atomically published.

- [ ] **Step 1: Add a deterministic failing regression test**

Create `C:\Dev\TermX\host\tests\committed_state.rs` with a blocking/failing sink and this exact behavioral test:

```rust
use std::sync::{Arc, Condvar, Mutex};
use tempfile::tempdir;
use termx_host::{atomic_state::StateSink, config::Config, registry::Registry};

#[derive(Default)]
struct Gate {
    entered: bool,
    release_with_error: bool,
}

#[derive(Default)]
struct BlockingFailingSink {
    state: Mutex<Gate>,
    changed: Condvar,
}

impl BlockingFailingSink {
    fn wait_until_entered(&self) {
        let mut state = self.state.lock().unwrap();
        while !state.entered {
            state = self.changed.wait(state).unwrap();
        }
    }

    fn fail(&self) {
        let mut state = self.state.lock().unwrap();
        state.release_with_error = true;
        self.changed.notify_all();
    }
}

impl StateSink for BlockingFailingSink {
    fn persist(&self, _bytes: &[u8]) -> anyhow::Result<()> {
        let mut state = self.state.lock().unwrap();
        state.entered = true;
        self.changed.notify_all();
        while !state.release_with_error {
            state = self.changed.wait(state).unwrap();
        }
        anyhow::bail!("injected persist failure")
    }
}

#[test]
fn get_state_never_observes_a_failed_layout_candidate() {
    let dir = tempdir().unwrap();
    let sink = Arc::new(BlockingFailingSink::default());
    let registry = Arc::new(Registry::new_with_state_sink(
        dir.path().to_path_buf(),
        Config::default(),
        sink.clone(),
    ));
    let original = registry.layout();
    let writer = {
        let registry = registry.clone();
        std::thread::spawn(move || {
            registry.set_layout(serde_json::json!({"schema_version": 1, "tabs": ["candidate"]}))
        })
    };

    sink.wait_until_entered();
    assert_eq!(registry.layout(), original, "tentative layout leaked while persistence was blocked");
    sink.fail();
    assert!(writer.join().unwrap().is_err());
    assert_eq!(registry.layout(), original, "failed candidate remained installed");
}
```

- [ ] **Step 2: Run RED and record the intended failure**

Run:

```powershell
Set-Location 'C:\Dev\TermX'
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'
cargo test -p termx-host --test committed_state get_state_never_observes_a_failed_layout_candidate -- --exact
```

Expected RED sequence:

1. Initial compile failure because `termx_host::atomic_state::StateSink` and `Registry::new_with_state_sink` do not exist.
2. After adding only the interface seam, the assertion fails because current `Registry::set_layout` installs the candidate before persistence completes.

- [ ] **Step 3: Implement persist-then-install with one linearization point**

Add `pub mod atomic_state;` to `C:\Dev\TermX\host\src\lib.rs`. Implement `StateSink` and `AtomicFileStateSink` so production persistence writes a complete temporary, flushes file content, atomically replaces the primary, and reports errors without touching installed state.

Change the registry fields to keep an injected sink and a single commit mutex:

```rust
pub struct Registry {
    commit_lock: Mutex<()>,
    state_sink: Arc<dyn StateSink>,
    layout: RwLock<serde_json::Value>,
    // existing session/id/config fields remain focused in Registry
}
```

Implement `set_layout` in this order:

```rust
pub fn set_layout(&self, layout: serde_json::Value) -> anyhow::Result<()> {
    validate_layout_candidate(&layout)?;
    let _commit = self.commit_lock.lock().unwrap();
    let candidate = self.build_persisted_candidate_with_layout(layout.clone())?;
    let bytes = serde_json::to_vec(&candidate)?;
    self.state_sink.persist(&bytes)?;
    *self.layout.write().unwrap() = layout;
    Ok(())
}
```

Do not update layout memory before `persist`; do not roll back an already exposed candidate; do not hold the layout write lock during filesystem I/O; do not allocate an event/revision in this M1-compatible prerequisite task.

- [ ] **Step 4: Verify GREEN and adjacent regressions**

Run:

```powershell
cargo test -p termx-host --test committed_state get_state_never_observes_a_failed_layout_candidate -- --exact
cargo test -p termx-host registry::tests::concurrent_failed_layout_updates_cannot_rollback_each_other -- --exact
cargo test -p termx-host registry::tests::failed_layout_persist_rolls_back_in_memory_state -- --exact
cargo fmt --all -- --check
```

Expected: all focused tests pass; existing layout persistence tests remain green; formatting exits 0.

- [ ] **Step 5: Review and commit**

```powershell
git diff -- host/src/atomic_state.rs host/src/lib.rs host/src/registry.rs host/tests/committed_state.rs host/Cargo.toml
git add -- host/src/atomic_state.rs host/src/lib.rs host/src/registry.rs host/tests/committed_state.rs host/Cargo.toml
git commit -m "fix(host): isolate committed layout state" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Add exact process identity and Job Object ownership

**Files:**
- Create: `C:\Dev\TermX\host\src\job.rs`
- Create: `C:\Dev\TermX\host\tests\job_exact_handle.rs`
- Create: `C:\Dev\TermX\host\tests\job_win32_contract.rs`
- Modify: `C:\Dev\TermX\host\src\lib.rs`
- Modify: `C:\Dev\TermX\host\Cargo.toml`

**Interfaces:**
- Consumes: Windows process IDs returned by ConPTY process creation.
- Produces:
  ```rust
  pub use termx_contracts::storage::ProcessIdentityV1;

  pub struct OwnedWin32Handle(
      windows_sys::Win32::Foundation::HANDLE,
  );

  pub struct ExactProcessHandle {
      handle: OwnedWin32Handle,
      identity: ProcessIdentityV1,
  }

  pub struct SessionJob {
      handle: OwnedWin32Handle,
      assigned_root: Option<ProcessIdentityV1>,
  }

  impl ExactProcessHandle {
      pub fn open_and_verify(identity: ProcessIdentityV1, access: u32) -> anyhow::Result<Self>;
      pub fn identity(&self) -> ProcessIdentityV1;
      pub fn is_running(&self) -> anyhow::Result<bool>;
  }

  impl SessionJob {
      pub fn create_kill_on_close() -> anyhow::Result<Self>;
      pub fn assign(&mut self, process: &ExactProcessHandle) -> anyhow::Result<()>;
      pub fn terminate_verified(&self, root: &ExactProcessHandle, exit_code: u32) -> anyhow::Result<()>;
      pub fn active_processes(&self) -> anyhow::Result<u32>;
  }
  ```
- Invariants: exact handle and creation time precede destructive calls; the Job has kill-on-close, no breakaway, and the exact access masks/handle-inheritance contract from specification sections 5.2 and 6.
- Acceptance anchors: `[M2-TST-EXACT-HANDLE-FIRST]`, `[M2-TST-WIN32-MASKS-INHERITANCE]`.

- [ ] **Step 1: Write failing real-Windows contract tests**

In `job_exact_handle.rs`, create a suspended benign child through a test helper and assert PID reuse/mismatch rejection:

```rust
#[test]
fn m2_tst_exact_handle_first_rejects_wrong_creation_time_before_termination() {
    let child = termx_host::job::test_support::spawn_suspended_cmd().unwrap();
    let actual = child.identity();
    let wrong = ProcessIdentityV1 {
        pid: actual.pid,
        process_start_time: actual.process_start_time.saturating_add(1),
    };
    let result = ExactProcessHandle::open_and_verify(wrong, termx_host::job::PROCESS_TERMINATE_QUERY_MASK);
    assert!(result.is_err());
    assert!(child.is_running().unwrap(), "identity mismatch must not target the process");
    child.cleanup_without_resume().unwrap();
}
```

In `job_win32_contract.rs`, assert the captured creation contract:

```rust
#[test]
fn m2_tst_win32_masks_inheritance_uses_closed_handle_contract() {
    let trace = termx_host::job::test_support::capture_jobbed_process_creation().unwrap();
    assert_eq!(trace.root_open_mask, termx_host::job::ROOT_PROCESS_ACCESS_MASK);
    assert_eq!(trace.assignment_open_mask, termx_host::job::ASSIGNMENT_PROCESS_ACCESS_MASK);
    assert!(trace.used_startupinfoex);
    assert_eq!(trace.job_list_attribute_count, 1);
    assert!(!trace.inherit_handles);
    assert_eq!(trace.inherited_handle_count, 0);
    assert!(trace.job_kill_on_close);
    assert!(!trace.breakaway_allowed);
    trace.cleanup_without_resume().unwrap();
}
```

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-host --test job_exact_handle -- --test-threads=1
cargo test -p termx-host --test job_win32_contract -- --test-threads=1
```

Expected: compile failure because `termx_host::job` and constants/test-support APIs do not exist.

- [ ] **Step 3: Implement exact Win32 ownership primitives**

Add the required `windows-sys` feature groups for Foundation, Security, Job Objects, Process Status, Pipes where shared declarations require them, System Information, Threading, and Windows Programming. Keep every raw `HANDLE` private and close it in `Drop`.

Implement `ExactProcessHandle::open_and_verify` as:

```rust
let handle = unsafe { OpenProcess(access, 0, identity.pid) };
if handle.is_null() { return Err(last_os_error().into()); }
let observed = query_process_start_time(handle)?;
if observed != identity.process_start_time {
    unsafe { CloseHandle(handle) };
    anyhow::bail!("process_identity_mismatch");
}
```

Implement Job creation with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, no breakaway flags, exact readback, and explicit `TerminateJobObject` for close/shutdown. Do not use PID-only `OpenProcess` immediately before termination without comparing creation time. Do not expose a generic `kill(pid)` API.

- [ ] **Step 4: Verify GREEN and inspect masks**

```powershell
cargo test -p termx-host --test job_exact_handle -- --test-threads=1
cargo test -p termx-host --test job_win32_contract -- --test-threads=1
cargo clippy -p termx-host --all-targets -- -D warnings
```

Expected: mismatch test leaves the child live until explicit fixture cleanup; contract test confirms exact masks and zero inherited handles; Clippy exits 0.

- [ ] **Step 5: Review and commit**

```powershell
git diff -- host/src/job.rs host/src/lib.rs host/tests/job_exact_handle.rs host/tests/job_win32_contract.rs host/Cargo.toml
git add -- host/src/job.rs host/src/lib.rs host/tests/job_exact_handle.rs host/tests/job_win32_contract.rs host/Cargo.toml
git commit -m "feat(host): add exact Job process ownership" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Arm durable unregistered containment before process creation

**Files:**
- Create: `C:\Dev\TermX\host\src\containment.rs`
- Create: `C:\Dev\TermX\host\tests\containment_prefix.rs`
- Modify: `C:\Dev\TermX\host\src\lib.rs`
- Modify: `C:\Dev\TermX\host\src\session.rs`
- Modify: `C:\Dev\TermX\host\src\registry.rs`
- Modify: `C:\Dev\TermX\host\src\atomic_state.rs`

**Interfaces:**
- Consumes: `AtomicFileStateSink`, `ProcessIdentityV1`, `SessionJob`.
- Produces:
  ```rust
  pub use termx_contracts::storage::{
      UnregisteredContainmentRecordV1,
      UnregisteredContainmentState,
  };

  pub trait SpawnBoundary: Send + Sync {
      fn create_suspended(
          &self,
          request: &SessionSpawnRequest,
      ) -> anyhow::Result<SpawnedSuspendedSession>;
  }
  ```
- Invariant: the matching reserved creation receipt and `Armed` containment record are one durable candidate before entry to the OS process-creation call.
- Acceptance anchor: `[M2-TST-UNREGISTERED-CONTAINMENT-PREFIX]`.

- [ ] **Step 1: Write a disk/barrier crash-prefix test**

Create a table-driven test whose fixture stops after each named boundary:

```rust
#[derive(Clone, Copy, Debug)]
enum Prefix {
    ArmPersisted,
    SpawnReturned,
    RootIdentityCaptured,
    JobAssigned,
    PtyReaderReady,
    WriterReady,
    CleanupStarted,
    AbsenceProofPersisted,
    RecordRemoved,
}

#[test]
fn m2_tst_unregistered_containment_prefix_has_one_safe_outcome_per_prefix() {
    for prefix in [
        Prefix::ArmPersisted,
        Prefix::SpawnReturned,
        Prefix::RootIdentityCaptured,
        Prefix::JobAssigned,
        Prefix::PtyReaderReady,
        Prefix::WriterReady,
        Prefix::CleanupStarted,
        Prefix::AbsenceProofPersisted,
        Prefix::RecordRemoved,
    ] {
        let outcome = termx_host::containment::test_support::run_creation_until(prefix).unwrap();
        assert_eq!(outcome.registered_session_count, 0);
        assert_eq!(outcome.lifecycle_event_count, 0);
        assert!(outcome.spawn_calls <= 1);
        assert!(
            outcome.exact_absence_proved
                || matches!(outcome.records.as_slice(), [record] if matches!(record.state, UnregisteredContainmentState::Armed | UnregisteredContainmentState::ContainmentUncertain))
        );
    }
}
```

Add separate capacity assertions for 129 protected records, 4,097 descendants, and 512 KiB + 1 canonical containment bytes, each requiring zero calls to `SpawnBoundary::create_suspended`.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-host --test containment_prefix m2_tst_unregistered_containment_prefix_has_one_safe_outcome_per_prefix -- --exact --test-threads=1
```

Expected: compile failure because containment records, test fixture, and spawn boundary do not exist.

- [ ] **Step 3: Implement reservation, guard, and startup reconciliation**

Under the registry commit lock:

1. Validate caps and deterministically prune only eligible oldest `ResolvedAbsent` records toward 96 records/384 KiB.
2. Reserve a creation sequence and create the matching receipt.
3. Insert one `Armed` record.
4. Persist the complete candidate.
5. Release commit/persistence locks.
6. Enter `SpawnBoundary::create_suspended` exactly once.
7. Enrich the durable record with exact process/Job/descendant identity as each becomes available.
8. Register the session only after every required setup step succeeds and the containment record can be removed in the same durable candidate.
9. On failure, run exact cleanup outside locks; persist `ResolvedAbsent` only after exact absence proof, otherwise persist `ContainmentUncertain` and block later creation/replacement.

Startup must convert `Armed` without a complete exact root proof to `ContainmentUncertain` before listener publication and must never retry the spawn.

- [ ] **Step 4: Verify GREEN and adjacent session regressions**

```powershell
cargo test -p termx-host --test containment_prefix -- --test-threads=1 *> (Join-Path $PWD 'target-m2\containment-prefix.log')
cargo test -p termx-host session::tests::kill_reaps_grandchildren_not_just_the_shell -- --exact --test-threads=1 *> (Join-Path $PWD 'target-m2\session-grandchildren.log')
cargo test -p termx-host registry::tests::create_list_close_lifecycle -- --exact --test-threads=1 *> (Join-Path $PWD 'target-m2\registry-lifecycle.log')
```

Expected: all prefix and cap cases produce exactly one safe outcome; existing session lifecycle remains green.

- [ ] **Step 5: Review and commit**

```powershell
git diff -- host/src/containment.rs host/src/lib.rs host/src/session.rs host/src/registry.rs host/src/atomic_state.rs host/tests/containment_prefix.rs
git add -- host/src/containment.rs host/src/lib.rs host/src/session.rs host/src/registry.rs host/src/atomic_state.rs host/tests/containment_prefix.rs
git commit -m "fix(host): guard every post-spawn setup prefix" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Replace one-step close with durable teardown ownership

**Files:**
- Create: `C:\Dev\TermX\host\tests\teardown_prefix.rs`
- Modify: `C:\Dev\TermX\host\src\containment.rs`
- Modify: `C:\Dev\TermX\host\src\registry.rs`
- Modify: `C:\Dev\TermX\host\src\session.rs`
- Modify: `C:\Dev\TermX\host\src\server.rs`

**Interfaces:**
- Consumes: exact Job/process ownership from Task 3, the atomic committed-state boundary from Task 2, and `termx_contracts::storage::TeardownRecordV1` from Task 1.
- Produces:
  ```rust
  pub use termx_contracts::storage::TeardownRecordV1;

  pub enum CloseOutcome { Closed, CloseUncertain }

  impl Registry {
      pub async fn close_session_v2(&self, session_id: u32) -> anyhow::Result<CloseOutcome>;
  }
  ```
- Invariant: first commit publishes durable `closing`; cleanup occurs unlocked; second commit emits exactly one `SessionClosed` or `close_uncertain` transition.

- [ ] **Step 1: Write failing lock-release and crash-prefix tests**

Add a barrier-controlled test:

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn close_releases_commit_lock_while_external_teardown_waits() {
    let fixture = termx_host::containment::test_support::TeardownFixture::new().await;
    let session_id = fixture.create_session().await;
    fixture.pause_after_closing_commit();

    let close = tokio::spawn({
        let registry = fixture.registry();
        async move { registry.close_session_v2(session_id).await }
    });
    fixture.wait_until_cleanup_paused().await;

    let snapshot = tokio::time::timeout(std::time::Duration::from_secs(1), fixture.get_state())
        .await
        .expect("GetState blocked behind external teardown");
    assert!(snapshot.sessions.iter().any(|s| s.id == session_id && s.close_state == "closing"));
    fixture.commit_unrelated_layout().await.unwrap();

    fixture.release_cleanup();
    assert!(matches!(close.await.unwrap().unwrap(), CloseOutcome::Closed));
}
```

Add a table test crashing after first commit, Job terminate, zero-process proof, final persist, and acknowledgement; assert one retained teardown owner and one terminal event on restart.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-host --test teardown_prefix close_releases_commit_lock_while_external_teardown_waits -- --exact --test-threads=1
```

Expected: compile failure for `close_session_v2`/fixture APIs; after seam creation, timeout or state assertion fails because current close does cleanup without the required two-commit lifecycle.

- [ ] **Step 3: Implement two-commit close**

Implement exactly:

```text
commit 1 under commit_lock:
  validate generation and ownership
  move live entry to graveyard teardown owner
  persist closing candidate
  install and sequence closing event
release every lock
external cleanup:
  terminate verified Job/process identities
  close ConPTY
  drain reader/writer
  prove zero Job processes and escaped descendants
commit 2 under commit_lock:
  if exact absence: remove graveyard/session and emit SessionClosed
  else: retain ownership as close_uncertain and emit SessionCloseStateChanged
```

A duplicate close joins the same owner. No `SessionClosed` is emitted while root, Job member, escaped descendant, reader, writer, or ConPTY ownership remains.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-host --test teardown_prefix -- --test-threads=1 *> (Join-Path $PWD 'target-m2\teardown-prefix.log')
cargo test -p termx-host registry::tests::close_then_immediate_shutdown_waits_for_full_teardown -- --exact --test-threads=1 *> (Join-Path $PWD 'target-m2\close-shutdown.log')
cargo test -p termx-host server::tests::close_by_one_client_notifies_other_attached_client -- --exact --test-threads=1 *> (Join-Path $PWD 'target-m2\close-client.log')
```

Expected: lock-release test completes before cleanup release; every crash prefix reconciles one owner and one terminal transition; adjacent M1 behavior remains green.

- [ ] **Step 5: Review and commit**

```powershell
git diff -- host/src/containment.rs host/src/registry.rs host/src/session.rs host/src/server.rs host/tests/teardown_prefix.rs
git add -- host/src/containment.rs host/src/registry.rs host/src/session.rs host/src/server.rs host/tests/teardown_prefix.rs
git commit -m "feat(host): persist two-phase session teardown" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Phase 1 Acceptance Coverage

| Specification acceptance requirement | Owning task | Exact primary test |
|---|---:|---|
| Concurrent `GetState` cannot observe blocked/failed/rolled-back layout | 2 | `host/tests/committed_state.rs::get_state_never_observes_a_failed_layout_candidate` |
| Failed persistence changes no installed state | 2 | `host/tests/committed_state.rs::failed_layout_candidate_changes_no_memory` |
| Every post-spawn failure leaves exact absence or one durable uncertainty record | 4 | `host/tests/containment_prefix.rs::m2_tst_unregistered_containment_prefix_has_one_safe_outcome_per_prefix` |
| `[M2-TST-UNREGISTERED-CONTAINMENT-PREFIX]` caps, crashes, startup reconciliation, PID reuse, reboot repair | 4 | `host/tests/containment_prefix.rs` table suite |
| `[M2-TST-EXACT-HANDLE-FIRST]` | 3 | `host/tests/job_exact_handle.rs` |
| `[M2-TST-WIN32-MASKS-INHERITANCE]` | 3 | `host/tests/job_win32_contract.rs` |
| Job assignment failure aborts creation | 3-4 | `host/tests/job_win32_contract.rs::job_assignment_failure_never_registers_session` |
| Pre-assignment descendants are contained or durably uncertain | 4 | `host/tests/containment_prefix.rs::preassignment_descendant_has_exact_owned_outcome` |
| Descendants remain owned after natural root exit until close/shutdown | 3, 5 | `host/tests/job_exact_handle.rs::job_ownership_survives_root_exit` |
| Close publishes `closing`, unlocks external work, and retains uncertain graveyard ownership | 5 | `host/tests/teardown_prefix.rs::close_releases_commit_lock_while_external_teardown_waits` |
| Every close crash prefix emits one terminal transition after reconciliation | 5 | `host/tests/teardown_prefix.rs::close_prefix_reconciles_one_owner_and_one_terminal_event` |
| Existing M1 zero-orphan/teardown invariants | 6 | `host/tests/e2e.rs` complete suite plus process scan |

### Task 6: Run the Phase 1 safety gate and freeze interfaces

**Files:**
- Modify: `C:\Dev\TermX\README.md`
- Modify: `C:\Dev\TermX\specs\handoffs\001-2026-07-17-termx-m1-host-core.md`
- Test: all Phase 1 and existing M1 host targets.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: reviewed safety interfaces consumed by protocol/state work in Phase 2.
- Invariant: no later phase begins on a failing, unreviewed, or uncommitted safety prerequisite.

- [ ] **Step 1: Add a phase-gate integration assertion**

Extend `C:\Dev\TermX\host\tests\e2e.rs` with:

```rust
#[test]
fn m2_phase1_host_safety_gate_leaves_no_orphan_after_injected_setup_failure() {
    let fixture = E2eFixture::with_setup_failure("writer_ready");
    let outcome = fixture.start_host_and_request_session();
    assert!(outcome.session_created.is_none());
    assert_eq!(outcome.registered_sessions, 0);
    assert_eq!(outcome.lifecycle_events, 0);
    assert!(outcome.exact_absence_proved || outcome.unresolved_containment_records == 1);
    fixture.assert_no_unowned_processes();
}
```

This test must use the real binary and a test-only explicit failure-injection switch accepted only in debug/test builds.

- [ ] **Step 2: Run the new integration test RED before wiring the test-only binary switch**

```powershell
cargo test -p termx-host --test e2e m2_phase1_host_safety_gate_leaves_no_orphan_after_injected_setup_failure -- --exact --test-threads=1 *> (Join-Path $PWD 'target-m2\phase1-e2e-red.log')
```

Expected: fixture cannot request the named injection until the binary exposes the test-only switch.

- [ ] **Step 3: Add only the test-build injection plumbing and documentation**

Wire the existing deterministic `SpawnBoundary` injection through an explicitly test-only environment variable checked behind `cfg(debug_assertions)`. Production release builds must ignore/reject it. Update `README.md` with the isolated MSVC target-dir command and the distinction between ordinary UI close and explicitly authorized host shutdown.

- [ ] **Step 4: Run complete Phase 1 verification**

```powershell
cargo fmt --all -- --check
cargo clippy -p termx-host --all-targets -- -D warnings
cargo test -p termx-host --lib -- --test-threads=1 *> (Join-Path $PWD 'target-m2\phase1-lib.log')
cargo test -p termx-host --tests -- --test-threads=1 *> (Join-Path $PWD 'target-m2\phase1-tests.log')
```

Expected: all commands exit 0; test logs contain no orphan/process-cleanup failure. Send the exact diff plus all four outputs to Fable. Resolve every confirmed finding and rerun affected commands.

- [ ] **Step 5: Commit the gate record**

```powershell
git add -- README.md host/tests/e2e.rs specs/handoffs/001-2026-07-17-termx-m1-host-core.md
git commit -m "test(host): close M2 safety prerequisite gate" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

Do not begin `C:\Dev\TermX\docs\superpowers\plans\2026-07-19-termx-m2-phase-2-host-protocol-state.md` until Fable approves the exact Phase 1 bytes.
