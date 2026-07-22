# TermX M2 Phase 3: Storage Ownership and Native Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish one protected data-directory identity and a crash-replayable native-only StorageRepair transaction without making Tauri a second live StateV2 writer.

**Architecture:** Narrow shared path and DACL crates provide identical primitives to host and Tauri. Tauri classifies dead-host storage under named mutexes, prepares a complete immutable repair plan, records native confirmation in an authorization ledger, and executes one journaled restore/reset/adopt/containment-reboot transaction. The host remains the only ordinary writer and suppresses listener publication for in-progress, ambiguous, or both-invalid storage, except for the explicitly restricted diagnostic-repair-only listener.

**Tech Stack:** Rust 2021; `termx-paths`; `termx-data-security`; `termx-contracts`; `termx-canonical`; `windows-sys`; Tauri crate test harness without renderer production code; tempfile; real Windows mutex/ACL/file-identity tests.

## Global Constraints

- Phase 2 contracts and host publication APIs must be Fable-approved before this phase.
- This phase creates `ui/src-tauri` first as a headless Rust library package named `termx-ui-native` with no `tauri` dependency, `main.rs`, capabilities, or renderer scaffold; Phase 5 promotes that tested native core into the Tauri 2 application.
- `config.json` pretty-byte CAS remains separate from JCS state/repair records.
- Lock order is `recovery_bootstrap_mutex -> data_dir_preownership_mutex -> ordinary UUID mutex -> storage_repair_gate -> authorization_ledger_gate`.
- `storage_repair_gate` and `authorization_ledger_gate` are non-reentrant Tauri process-local gates; cross-process exclusion comes from the continuously held user-ACL-protected named recovery mutex.
- Repair writes occur only after exact dead-host/PID/start-time/endpoint absence, ACL, directory identity, source snapshot, ownership classification, confirmation, authorization, and journal persistence.
- Repair never overwrites an unexpected file. Quarantine moves are deterministic and non-overwriting.
- Reset is forbidden when any validated source contains unresolved containment.
- `containment_reboot` uses a frozen result timestamp and publishes identical candidate bytes to primary and backup.
- Tests operate only in temporary data directories and test-created processes/mutexes.
- Native integration fixtures compile only behind a non-default `termx-ui-native/test-support` feature; no release invoke exposes disk/process/ACL mutation injection.

## Test-Support Contract

`ui/src-tauri/src/test_support.rs` creates `StorageFixture`, `StorageObservationBuilder`, and exact failpoint enums for authorization, journal, replacement, and publication boundaries. `StorageFixture::reopen()` reopens the same temporary directory with fresh in-memory native state; `mutation_count`, quarantine/publication counters, artifact byte reads, and `validate_plan` observe real files and the real strict parsers. `host/src/test_support.rs` adds `HostSecurityFixture` and `HostStorageFixture` to boot the real startup classifier without binding outside loopback. Every helper creates and owns its mutex/process/artifact identities and cleans only those test resources.

---

### Task 1: Add shared runtime paths and protected DACL primitives

**Files:**
- Modify: `C:\Dev\TermX\Cargo.toml`
- Create: `C:\Dev\TermX\crates\termx-paths\Cargo.toml`
- Create: `C:\Dev\TermX\crates\termx-paths\src\lib.rs`
- Create: `C:\Dev\TermX\crates\termx-paths\tests\resolution.rs`
- Create: `C:\Dev\TermX\crates\termx-data-security\Cargo.toml`
- Create: `C:\Dev\TermX\crates\termx-data-security\src\lib.rs`
- Create: `C:\Dev\TermX\crates\termx-data-security\tests\windows_acl.rs`
- Modify: `C:\Dev\TermX\host\src\paths.rs`
- Modify: `C:\Dev\TermX\host\src\main.rs`
- Modify: `C:\Dev\TermX\host\src\server.rs`
- Create: `C:\Dev\TermX\host\tests\data_security_startup.rs`
- Modify: `C:\Dev\TermX\host\Cargo.toml`

**Interfaces:**
- Produces:
  ```rust
  pub struct DataDirInputs<'a> {
      pub explicit: Option<&'a std::path::Path>,
      pub executable: &'a std::path::Path,
      pub appdata: Option<&'a std::path::Path>,
  }
  pub fn resolve_data_dir(inputs: DataDirInputs<'_>) -> anyhow::Result<std::path::PathBuf>;

  pub struct AclObservation {
      pub inheritance_disabled: bool,
      pub current_user_allowed: bool,
      pub system_allowed: bool,
      pub administrators_allowed: bool,
      pub broad_principal_present: bool,
  }
  pub fn protect_directory(path: &std::path::Path) -> anyhow::Result<AclObservation>;
  pub fn verify_protected(path: &std::path::Path) -> anyhow::Result<AclObservation>;
  ```
- Invariant: both host and Tauri resolve the same directory and refuse credential/state publication if DACL apply/readback is not exact.

- [ ] **Step 1: Write failing path-parity and actual-DACL tests**

```rust
#[test]
fn host_and_native_inputs_resolve_the_same_portable_directory() {
    let root = tempfile::tempdir().unwrap();
    let exe = root.path().join("bin").join("termx-host.exe");
    std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
    std::fs::write(exe.parent().unwrap().join("portable.flag"), b"").unwrap();
    let appdata = root.path().join("appdata");
    let resolved = termx_paths::resolve_data_dir(DataDirInputs {
        explicit: None,
        executable: &exe,
        appdata: Some(&appdata),
    }).unwrap();
    assert_eq!(resolved, exe.parent().unwrap().join("data"));
}
```

```rust
#[test]
fn protected_directory_disables_inheritance_and_broad_principals() {
    let dir = tempfile::tempdir().unwrap();
    let observation = termx_data_security::protect_directory(dir.path()).unwrap();
    assert!(observation.inheritance_disabled);
    assert!(observation.current_user_allowed);
    assert!(observation.system_allowed);
    assert!(observation.administrators_allowed);
    assert!(!observation.broad_principal_present);
    assert_eq!(termx_data_security::verify_protected(dir.path()).unwrap(), observation);
}

#[test]
fn host_publishes_no_runtime_or_state_when_acl_readback_fails() {
    let fixture = HostSecurityFixture::with_injected_broad_principal();
    let result = fixture.start();
    assert_eq!(result.exit_code, LOCAL_SECURITY_FAILURE_EXIT);
    assert!(!fixture.runtime_exists());
    assert!(!fixture.state_exists());
    assert!(!fixture.listener_reachable());
}
```

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-paths
cargo test -p termx-data-security --test windows_acl -- --test-threads=1
cargo test -p termx-host --test data_security_startup -- --test-threads=1
```

Expected: packages do not exist.

- [ ] **Step 3: Implement narrow crates and migrate host path calls**

Keep DACL code independent of contracts/storage. It returns local observations; callers map them into contract records. Disable inheritance and permit only current user SID, SYSTEM, and Administrators. `termx-paths` performs no filesystem mutation beyond path selection. Replace host path implementation with calls into `termx-paths` while preserving public M1 wrappers. In host startup, resolve and protect/verify the directory before config initialization or any runtime token, shutdown key, StateV2, backup, temporary, bootstrap, or audit publication; a failed apply/readback exits with the blocking local-security classification before bind/listener publication.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-paths
cargo test -p termx-data-security -- --test-threads=1
cargo test -p termx-host paths::tests
cargo test -p termx-host --test data_security_startup -- --test-threads=1
cargo tree -p termx-data-security
```

Expected: exact resolution/DACL tests pass; data-security has no contracts/Tauri/Tokio dependency.

- [ ] **Step 5: Commit**

```powershell
git add -- Cargo.toml crates/termx-paths crates/termx-data-security host/src/paths.rs host/src/main.rs host/src/server.rs host/tests/data_security_startup.rs host/Cargo.toml
git commit -m "feat(storage): share protected data directory primitives" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Classify storage ownership and acquire named mutexes

**Files:**
- Create: `C:\Dev\TermX\ui\src-tauri\Cargo.toml`
- Create: `C:\Dev\TermX\ui\src-tauri\src\lib.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\src\mutex.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\src\storage.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\storage_ownership.rs`
- Modify: `C:\Dev\TermX\Cargo.toml`

**Interfaces:**
- Produces:
  ```rust
  pub struct NamedMutexGuard {
      handle: windows_sys::Win32::Foundation::HANDLE,
      name: String,
  }
  pub enum MutexAcquire { Acquired(NamedMutexGuard), Abandoned(NamedMutexGuard), Busy }
  pub fn acquire_recovery_mutex(data_dir: &std::path::Path) -> anyhow::Result<MutexAcquire>;
  pub fn acquire_preownership_mutex(data_dir: &std::path::Path) -> anyhow::Result<MutexAcquire>;
  pub fn acquire_ordinary_mutex(id: uuid::Uuid) -> anyhow::Result<MutexAcquire>;

  pub fn classify_storage(observation: &StorageObservationV1)
      -> anyhow::Result<StorageOwnershipClassificationV1>;
  ```
- Invariant: all six ownership classifications are total; owner appearance/disappearance/replacement forces reclassification and no implicit adoption.
- Acceptance anchor: `[M2-TST-STORAGE-OWNERSHIP-CLASSIFICATION]`.

- [ ] **Step 1: Write failing six-class and race tests**

```rust
#[test]
fn m2_tst_storage_ownership_classification_covers_closed_domain() {
    let fixtures = ownership_fixtures();
    assert_eq!(fixtures.len(), 6);
    for (observation, expected) in fixtures {
        assert_eq!(classify_storage(&observation).unwrap(), expected);
    }
}

#[test]
fn changed_owner_between_prepare_and_execute_is_ambiguous() {
    let fixture = StorageFixture::owned_valid();
    let plan = fixture.prepare_adopt().unwrap();
    fixture.replace_owner_with_new_uuid();
    assert_eq!(fixture.validate_plan(&plan).unwrap_err().code(), "storage_repair_ambiguous");
    assert_eq!(fixture.mutation_count(), 0);
}
```

Add two-process preownership/ordinary contention and abandoned-mutex re-read tests.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-ui-native --test storage_ownership -- --test-threads=1
```

Expected: Tauri crate, mutex, and classifier do not exist.

- [ ] **Step 3: Implement classification and exact mutex names**

Derive mutex names from canonical data-directory identity or exact UUID, protect mutex ACLs, distinguish abandoned ownership, and require complete artifact/ACL re-read after abandonment. Owner-present paths derive ordinary mutex from exact owner UUID; owner-absent adopt uses unanimous source UUID; reset generates and plan-binds a candidate UUID under recovery+preownership before acquiring that ordinary mutex.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-ui-native --test storage_ownership -- --test-threads=1
cargo clippy -p termx-ui-native --all-targets -- -D warnings
```

Expected: all classes and contention/abandonment paths pass without writes on ambiguity.

- [ ] **Step 5: Commit**

```powershell
git add -- Cargo.toml ui/src-tauri/Cargo.toml ui/src-tauri/src/lib.rs ui/src-tauri/src/mutex.rs ui/src-tauri/src/storage.rs ui/src-tauri/tests/storage_ownership.rs
git commit -m "feat(storage): classify ownership under named mutexes" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Bind exact artifact and directory identities

**Files:**
- Create: `C:\Dev\TermX\ui\src-tauri\src\storage_identity.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\storage_quarantine.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\storage_directory_identity.rs`
- Create: `C:\Dev\TermX\crates\termx-data-security\tests\windows_identity.rs`
- Modify: `C:\Dev\TermX\ui\src-tauri\src\lib.rs`

**Interfaces:**
- Produces readable SHA-256/length identity, unreadable fingerprint identity, deterministic missing identity, `TargetDirectoryIdentityV1`, and deterministic transaction-specific names.
- Invariant: a different existing file/directory is never overwritten or targeted after swap/junction/volume/file-ID/final-path drift.
- Acceptance anchors: `[M2-TST-STORAGE-QUARANTINE-IDENTITY]`, `[M2-TST-STORAGE-DIRECTORY-IDENTITY]`.

- [ ] **Step 1: Write failing identity tests**

```rust
#[test]
fn m2_tst_storage_quarantine_identity_never_overwrites_different_existing_artifact() {
    let fixture = StorageFixture::with_primary(b"old");
    let plan = fixture.prepare_restore().unwrap();
    fixture.create_conflicting_quarantine(b"different");
    assert_eq!(fixture.execute(plan).unwrap_err().code(), "storage_repair_ambiguous");
    assert_eq!(fixture.primary_bytes(), b"old");
}

#[test]
fn m2_tst_storage_directory_identity_rejects_directory_swap() {
    let fixture = StorageFixture::owned_valid();
    let plan = fixture.prepare_restore().unwrap();
    fixture.swap_target_directory();
    assert_eq!(fixture.execute(plan).unwrap_err().code(), "target_directory_changed");
}
```

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-ui-native --test storage_quarantine -- --test-threads=1
cargo test -p termx-ui-native --test storage_directory_identity -- --test-threads=1
```

Expected: identity module absent.

- [ ] **Step 3: Implement exact identity readback before every mutation**

Use `FileIdInfo`, normalized volume-GUID final path, strict UTF-16 conversion, lowercase 16-byte file ID, and decimal volume serial. Before journal, each move/replace, and completion, reopen and compare directory identity plus exact artifact identity. Existing deterministic quarantine/temporary names must be missing or exact expected bytes; otherwise fail unchanged.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-data-security --test windows_identity -- --test-threads=1
cargo test -p termx-ui-native --test storage_quarantine -- --test-threads=1
cargo test -p termx-ui-native --test storage_directory_identity -- --test-threads=1
```

Expected: swaps/conflicts fail before target mutation.

- [ ] **Step 5: Commit**

```powershell
git add -- crates/termx-data-security/tests/windows_identity.rs ui/src-tauri/src/storage_identity.rs ui/src-tauri/src/lib.rs ui/src-tauri/tests/storage_quarantine.rs ui/src-tauri/tests/storage_directory_identity.rs
git commit -m "feat(storage): bind exact artifact identities" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Prepare and authorize immutable repair plans

**Files:**
- Create: `C:\Dev\TermX\ui\src-tauri\src\storage_repair.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\src\native_auth.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\storage_authorization.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\storage_ledger.rs`
- Modify: `C:\Dev\TermX\ui\src-tauri\src\lib.rs`

**Interfaces:**
- Consumes the exact recursive `snake_case` `PrepareStorageRepairRequestV1`, `ConfirmStorageRepairRequestV1`, `ExecuteStorageRepairRequestV1`, `CancelStorageRepairRequestV1`, `GetStorageRepairStatusRequestV1`, `StorageRepairPrepared`, `StorageRepairAuthorized`, `StorageRepairExecutionResultV1`, and `StorageRepairStatusV1` contracts frozen by Phase 1. Phase 3 does not redefine or project those DTOs.
- Produces immutable `StorageRepairPreviewV1`, authorization MAC/nonces, direct ledger projections, retained canonical response replay, process-local repair/ledger gates, and this sole Phase 5 service boundary:
  ```rust
  #[derive(Clone, Copy, Debug, Eq, PartialEq)]
  pub enum StorageRepairCommandV1 {
      Prepare,
      Confirm,
      Execute,
      Cancel,
      GetStatus,
  }

  #[derive(Clone, Debug, Eq, PartialEq)]
  pub struct CanonicalStorageRepairRequest<T> {
      pub request: T,
      pub canonical_body: std::sync::Arc<[u8]>,
      pub body_sha256: Sha256Hex,
  }

  impl<T> CanonicalStorageRepairRequest<T> {
      pub fn from_strict_raw(
          request: T,
          canonical_body: Vec<u8>,
          body_sha256: Sha256Hex,
      ) -> Result<Self, StorageRepairServiceErrorV1>;
  }

  #[derive(Clone, Copy, Debug, Eq, PartialEq)]
  pub enum StorageRepairServiceErrorCodeV1 {
      RequestIdBodyMismatch,
      RepairUnavailable,
      RepairNotFound,
      PlanMismatch,
      AuthorizationMismatch,
      RepairExpired,
      OwnershipChanged,
      SourceChanged,
      DirectoryIdentityChanged,
      ArtifactIdentityChanged,
      LockUnavailable,
      LedgerCapacityExceeded,
      LedgerCorrupt,
      JournalCorrupt,
      StorageRepairAmbiguous,
      AuthorizationMacFailed,
      NativeConfirmationUnavailable,
      PersistenceFailed,
      ReadbackFailed,
  }

  #[derive(Clone, Debug, Eq, PartialEq)]
  pub struct StorageRepairServiceErrorV1 {
      pub code: StorageRepairServiceErrorCodeV1,
  }

  pub struct StorageRepairService {
      repair_gate: tokio::sync::Mutex<()>,
      ledger_gate: tokio::sync::Mutex<()>,
      dependencies: StorageRepairDependencies,
  }

  impl StorageRepairService {
      pub async fn prepare(
          &self,
          request: CanonicalStorageRepairRequest<PrepareStorageRepairRequestV1>,
      ) -> Result<StorageRepairPrepared, StorageRepairServiceErrorV1>;

      pub async fn confirm(
          &self,
          request: CanonicalStorageRepairRequest<ConfirmStorageRepairRequestV1>,
      ) -> Result<StorageRepairAuthorized, StorageRepairServiceErrorV1>;

      pub async fn execute(
          &self,
          request: CanonicalStorageRepairRequest<ExecuteStorageRepairRequestV1>,
      ) -> Result<StorageRepairExecutionResultV1, StorageRepairServiceErrorV1>;

      pub async fn cancel(
          &self,
          request: CanonicalStorageRepairRequest<CancelStorageRepairRequestV1>,
      ) -> Result<StorageRepairExecutionResultV1, StorageRepairServiceErrorV1>;

      pub async fn get_status(
          &self,
          request: CanonicalStorageRepairRequest<GetStorageRepairStatusRequestV1>,
      ) -> Result<StorageRepairStatusV1, StorageRepairServiceErrorV1>;
  }
  ```
- `canonical_body` is exactly `JCS(strictly decoded request DTO)` and `body_sha256=SHA-256(canonical_body)`. Construction rejects an empty body, a length over the native command cap, or a supplied hash that does not match the bytes. The service persists that exact hash and the exact canonical serialized response bytes in `StorageRepairRequestReplayV1`; command plus request ID plus hash is the idempotency key. A repeated command/request ID with the same hash returns the retained response bytes without re-observation or a second dialog; the same command/request ID with a different hash returns `RequestIdBodyMismatch` without mutation.
- `StorageRepairServiceErrorV1` contains no path, identity, raw OS error, source bytes, MAC, key, or user-controlled message. Phase 5 owns the exhaustive projection from these closed codes to either an approved §4.2 success outcome or `NativeInvokeRejectionV1`; handlers do not inspect internals or reacquire locks.
- Invariant: duplicate same request/body replays the exact response; changed body rejects; authorization is consumed only at flushed `journaled`.
- Acceptance anchors: `[M2-TST-STORAGE-AUTH-REPLAY]`, `[M2-TST-STORAGE-AUTH-LEDGER]`.

- [ ] **Step 1: Write failing acknowledgement-loss and replay tests**

```rust
#[tokio::test]
async fn m2_tst_storage_auth_replay_survives_native_restart_without_reprepare() {
    let fixture = StorageFixture::owned_valid().await;
    let service = fixture.service();

    let prepared_request = fixture.canonical_request(
        PrepareStorageRepairRequestV1 {
            request_id: uuid::Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
            mode: StorageRepairModeV1::Restore,
            record_id: None,
        },
    );
    let prepared = service.prepare(prepared_request).await.unwrap();

    let confirmed_request = fixture.canonical_request(
        ConfirmStorageRepairRequestV1 {
            request_id: uuid::Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap(),
            repair_id: prepared.preview.repair_id,
            plan_hash: prepared.preview.plan_hash.clone(),
        },
    );
    let authorized = service.confirm(confirmed_request).await.unwrap();
    let repair_id = authorized.authorization.repair_id;
    let expected_authorization = authorized.authorization.clone();
    let data_dir = fixture.data_dir().to_path_buf();
    drop(service);
    drop(fixture);

    let restarted = StorageFixture::reopen(data_dir).await;
    let status_request = restarted.canonical_request(
        GetStorageRepairStatusRequestV1 {
            request_id: uuid::Uuid::parse_str("33333333-3333-4333-8333-333333333333").unwrap(),
            repair_id,
        },
    );
    let status = restarted
        .service()
        .get_status(status_request)
        .await
        .unwrap();

    match status {
        StorageRepairStatusV1::Authorized {
            immutable_plan,
            authorization,
        } => {
            assert_eq!(immutable_plan, prepared.preview);
            assert_eq!(authorization, expected_authorization);
        }
        other => panic!("expected authorized status, got {other:?}"),
    }
    assert_eq!(restarted.prepare_count(), 1);
}
```

`StorageFixture::canonical_request<T: serde::Serialize>(request)` strict-serializes the closed DTO, reparses through `termx_canonical::parse_strict`, computes RFC 8785/JCS bytes and their `Sha256Hex`, and returns `CanonicalStorageRepairRequest<T>::from_strict_raw(request, canonical_body, body_sha256)`. `StorageFixture::reopen(data_dir)` constructs fresh process-local gates and a fresh `StorageRepairService` over the same test-owned directory. The test therefore exercises the exact public service signatures and durable replay rather than a test-only shortcut.

Add exact 96 KiB plan, 192 KiB response, 256 KiB base64 bounds; 64-record/512 KiB aggregate caps; cancellation; changed-source projection; same request/different body; and direct `mode|record_id|source_snapshot` equality tests.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-ui-native --test storage_authorization -- --test-threads=1
cargo test -p termx-ui-native --test storage_ledger -- --test-threads=1
```

Expected: APIs and durable ledger absent.

- [ ] **Step 3: Implement retained immutable authorization**

Prepare re-reads all exact inputs under the complete mutex/gate chain and writes nothing. Confirm invokes the native confirmation seam, constructs one authorization, and atomically installs the ledger generation with strict JCS/ACL/readback. `GetStatus` reconstructs exact retained responses. Execute reuses the durable plan preimage and never re-prepares from current disk.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-ui-native --test storage_authorization -- --test-threads=1
cargo test -p termx-ui-native --test storage_ledger -- --test-threads=1
```

Expected: restart/lost-ack replay returns exact prior plan; caps fail before target mutation.

- [ ] **Step 5: Commit**

```powershell
git add -- ui/src-tauri/src/storage_repair.rs ui/src-tauri/src/native_auth.rs ui/src-tauri/src/lib.rs ui/src-tauri/tests/storage_authorization.rs ui/src-tauri/tests/storage_ledger.rs
git commit -m "feat(storage): authorize immutable native repair plans" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Execute journaled restore, adopt, reset, and containment reboot

**Files:**
- Create: `C:\Dev\TermX\ui\src-tauri\src\storage_journal.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\storage_journal_prefix.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\storage_repair_branches.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\storage_init_reset.rs`
- Modify: `C:\Dev\TermX\ui\src-tauri\src\storage_repair.rs`
- Modify: `C:\Dev\TermX\ui\src-tauri\src\storage.rs`

**Interfaces:**
- Produces exact journal phases, branch-specific publication, `StorageRepairExecutionResultV1`, frozen containment timestamp, and terminal/ambiguous startup reconciliation.
- Invariant: every crash prefix continues idempotently or becomes durable non-mutating ambiguity; no duplicate quarantine/publication/owner creation.
- Acceptance anchors: `[M2-TST-STORAGE-JOURNAL-CRASH-PREFIX]`, `[M2-TST-STORAGE-REPAIR-BRANCHES]`, `[M2-TST-STORAGE-INIT-VS-RESET]`.

- [ ] **Step 1: Write failing phase-table tests**

```rust
#[test]
fn m2_tst_storage_journal_crash_prefix_has_one_idempotent_outcome() {
    for phase in StorageRepairJournalPhaseV1::ALL {
        let fixture = StorageFixture::for_restore();
        fixture.crash_after(phase);
        fixture.execute_authorized().ok();
        let reopened = fixture.reopen();
        let outcome = reopened.reconcile().unwrap();
        assert!(matches!(outcome, ReconcileOutcome::Completed(_) | ReconcileOutcome::Ambiguous(_)));
        assert!(reopened.quarantine_writes() <= 1);
        assert!(reopened.owner_publications() <= 1);
    }
}
```

Add branch assertions: restore selects backup; adopt prefers primary; reset quarantines backup first and writes state then owner; existing-primary ordinary publish uses `ReplaceFileW`; missing primary uses non-overwriting move; containment sync never uses `ReplaceFileW` and reaches published only with identical primary/backup.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-ui-native --test storage_journal_prefix -- --test-threads=1
cargo test -p termx-ui-native --test storage_repair_branches -- --test-threads=1
cargo test -p termx-ui-native --test storage_init_reset -- --test-threads=1
```

Expected: journal/branch engine absent.

- [ ] **Step 3: Implement one crash-prefix state machine**

Before mutation, persist/flush journal and mark authorization consumed. Re-read bound source at canonical location before move or exact quarantine after `moved`; this is location transition, not reselection. Create/flush/re-read candidate temporary before source movement. Use non-overwriting deterministic quarantine. Freeze `target_result_last_checked_at` in preparation and reuse it on every replay. At completion verify primary/owner/ACL and synchronized backup for containment reboot, write result/audit, release ledger/repair gates, release temporary ordinary UUID mutex and preownership, retain recovery mutex through candidate child independent UUID-mutex acquisition/runtime publication.

- [ ] **Step 4: Verify GREEN**

```powershell
cargo test -p termx-ui-native --test storage_journal_prefix -- --test-threads=1 *> (Join-Path $PWD 'target-m2\storage-prefix.log')
cargo test -p termx-ui-native --test storage_repair_branches -- --test-threads=1
cargo test -p termx-ui-native --test storage_init_reset -- --test-threads=1
```

Expected: every prefix has one valid terminal result; no source/target mutation on ambiguity.

- [ ] **Step 5: Commit**

```powershell
git add -- ui/src-tauri/src/storage_journal.rs ui/src-tauri/src/storage_repair.rs ui/src-tauri/src/storage.rs ui/src-tauri/tests/storage_journal_prefix.rs ui/src-tauri/tests/storage_repair_branches.rs ui/src-tauri/tests/storage_init_reset.rs
git commit -m "feat(storage): execute crash-safe repair branches" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Phase 3 Acceptance Coverage

| Specification acceptance requirement | Owning task | Exact primary test |
|---|---:|---|
| Brand-new initializer/preownership/ordinary UUID contention | 2, 5 | `ui/src-tauri/tests/storage_init_reset.rs::ordinary_initializers_publish_one_owner_uuid` |
| Recovery-bootstrap mutex contention and abandoned-owner reconciliation | 2 | `ui/src-tauri/tests/storage_ownership.rs::recovery_mutex_waiter_restarts_discovery` |
| Bootstrap witness/tombstone crash prefixes remain host-owned | 6 plus Phase 5 lifecycle | `host/tests/storage_startup.rs::bootstrap_tuple_blocks_ordinary_publication_until_reconciled` |
| Recovery drafts cannot smuggle advanced operation state | Phase 4; contracts frozen in Phase 1 | `host/tests/recovery_operations.rs::bootstrap_draft_uses_live_constructor` |
| Immutable shell/provider binding survives config drift | Phase 4; storage preserves bytes here | `host/tests/recovery_operations.rs::config_drift_never_substitutes_execution_binding` |
| Native repair/authorization respects exact source, directory, ACL, and no overwrite | 3-5 | storage identity/authorization/branch suites |
| Diagnostic-repair-only listener exposes only bounded read/release surface | 6 | `host/tests/storage_startup.rs::diagnostic_listener_rejects_every_ordinary_command` |
| `[M2-TST-STORAGE-OWNERSHIP-CLASSIFICATION]` | 2 | `ui/src-tauri/tests/storage_ownership.rs` |
| `[M2-TST-STORAGE-BOTH-INVALID-NATIVE]` | 6 | `ui/src-tauri/tests/storage_repair.rs` |
| `[M2-TST-STORAGE-JOURNAL-CRASH-PREFIX]` | 5 | `ui/src-tauri/tests/storage_journal_prefix.rs` |
| `[M2-TST-STORAGE-AUTH-REPLAY]` | 4 | `ui/src-tauri/tests/storage_authorization.rs` |
| `[M2-TST-STORAGE-QUARANTINE-IDENTITY]` | 3 | `ui/src-tauri/tests/storage_quarantine.rs` |
| `[M2-TST-STORAGE-REPAIR-BRANCHES]` | 5 | `ui/src-tauri/tests/storage_repair_branches.rs` |
| `[M2-TST-STORAGE-DIRECTORY-IDENTITY]` | 3 | `ui/src-tauri/tests/storage_directory_identity.rs` |
| `[M2-TST-STORAGE-INIT-VS-RESET]` | 5 | `ui/src-tauri/tests/storage_init_reset.rs` |
| `[M2-TST-STORAGE-AUTH-LEDGER]` | 4 | `ui/src-tauri/tests/storage_ledger.rs` |
| Actual protected DACL and secret publication fail-closed boundary | 1, 6 | `host/tests/data_security_startup.rs`, `host/tests/storage_startup.rs` |

### Task 6: Gate host startup and diagnostic repair mode

**Files:**
- Create: `C:\Dev\TermX\host\src\storage_startup.rs`
- Create: `C:\Dev\TermX\host\tests\storage_startup.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\storage_repair.rs`
- Modify: `C:\Dev\TermX\host\src\lib.rs`
- Modify: `C:\Dev\TermX\host\src\main.rs`
- Modify: `C:\Dev\TermX\host\src\server.rs`

**Interfaces:**
- Produces ordinary, diagnostic-repair-only, and no-listener startup classifications.
- Invariant: both-invalid, in-progress, ambiguous, unresolved ordinary replacement, or failed ACL publishes no listener/runtime; malformed primary plus exact valid backup may publish only the restricted diagnostic listener.
- Acceptance anchor: `[M2-TST-STORAGE-BOTH-INVALID-NATIVE]`.

- [ ] **Step 1: Write failing listener-publication tests**

```rust
#[test]
fn m2_tst_storage_both_invalid_native_publishes_no_listener_or_runtime() {
    let fixture = HostStorageFixture::both_invalid();
    let result = fixture.start_host();
    assert_eq!(result.exit_code, STORAGE_REPAIR_REQUIRED_EXIT);
    assert!(!fixture.runtime_exists());
    assert!(!fixture.listener_reachable());
}
```

Add diagnostic listener tests allowing only `Hello`, `GetState`, `ListSessions`, exact repair-release transaction, export/open-folder; zero live sessions; exact backup snapshot; every mutation/recovery/storage command rejected.

- [ ] **Step 2: Run RED**

```powershell
cargo test -p termx-host --test storage_startup -- --test-threads=1
cargo test -p termx-ui-native --test storage_repair m2_tst_storage_both_invalid_native_publishes_no_listener_or_runtime -- --exact --test-threads=1
```

Expected: current host attempts ordinary startup/degraded state behavior.

- [ ] **Step 3: Implement startup classification before bind/runtime publication**

Verify DACL, owner/source/journal/ledger/containment and choose one closed startup mode. The diagnostic listener preserves every byte and cannot authorize the later write; its shutdown bypass applies only to releasing the diagnostic host.

- [ ] **Step 4: Verify GREEN and full Phase 3 gate**

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test -p termx-paths
cargo test -p termx-data-security -- --test-threads=1
cargo test -p termx-contracts
cargo test -p termx-ui-native --tests -- --test-threads=1 *> (Join-Path $PWD 'target-m2\phase3-native.log')
cargo test -p termx-host --test storage_startup -- --test-threads=1 *> (Join-Path $PWD 'target-m2\phase3-host.log')
```

Expected: all exit 0. Send exact diff/output to Fable; resolve and re-review confirmed findings.

- [ ] **Step 5: Commit**

```powershell
git add -- host/src/storage_startup.rs host/src/lib.rs host/src/main.rs host/src/server.rs host/tests/storage_startup.rs ui/src-tauri/tests/storage_repair.rs specs/handoffs/001-2026-07-17-termx-m1-host-core.md
git commit -m "test(storage): close native repair gate" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```
