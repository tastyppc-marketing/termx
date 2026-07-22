# TermX M2 Phase 5: Tauri Native Shell and Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the Phase 3 `termx-ui-native` library into a Tauri 2 Windows application that securely discovers or starts the detached host, performs native-only destructive confirmations, owns audit/notification OS integration, and packages the exact host sidecar without proxying terminal traffic.

**Architecture:** The tested Phase 3 native core remains the lifecycle/storage/security engine. A narrow Tauri adapter exposes closed bounded invoke DTOs, stores runtime secrets only in Rust state, and gives React only the authenticated loopback endpoint/token/version bootstrap. Sidecar build tooling derives project paths, pins the MSVC target, verifies wire-major metadata, and supplies exactly the target-triple-suffixed external binary consumed through Tauri's sidecar API.

**Tech Stack:** Rust 2021; `tauri = 2.11.5`; `tauri-build = 2.6.3`; `@tauri-apps/api = 2.11.1`; `@tauri-apps/cli = 2.11.4`; `tauri-plugin-dialog = 2.7.2`; `tauri-plugin-notification = 2.3.3`; `tauri-plugin-shell = 2.3.5` for Rust-only launch of the single `termx-host` sidecar; `termx-ui-native`; `termx-contracts`; `termx-canonical`; `termx-paths`; `termx-data-security`; Tokio; tokio-tungstenite; `windows-sys`; PowerShell 5.1 build scripts; MSVC target `x86_64-pc-windows-msvc`; Rust unit/integration tests and Tauri mock-runtime tests.

## Global Constraints

- Phases 1-4 exact interfaces and tests must be Fable-approved before this phase begins.
- React directly owns the ordinary authenticated WebSocket. No Tauri command proxies PTY output/input, replay, attach, resize, layout, safety, or recovery messages.
- Tauri receives both runtime secrets from the protected runtime file, but only the bearer token may cross into JavaScript through one in-memory bootstrap result. The shutdown-authority key never appears in an invoke result, event, error, log, notification, audit record, WebSocket payload, command line, environment, or state/config/recovery file.
- Existing live host discovery always precedes sidecar start. PID/port/name are diagnostic prefilters; trust requires exact process start time and authenticated native `Preflight` identity.
- A live protocol-major mismatch is non-destructive. No automatic restart or shutdown is permitted.
- Runtime schema 1 is read-only legacy discovery: authenticate/read preview, close, show Manual release guidance, and never send legacy `Shutdown`.
- The recovery/bootstrap mutex serializes every dead-host proof/bootstrap/replacement attempt across Tauri processes. `WAIT_ABANDONED` requires full artifact reconciliation and has no shortcut.
- Ordinary window close/reload/renderer crash exits only the UI. It never sends host `Shutdown`, kills the sidecar, removes runtime state, or mutates provider recovery operations.
- Only explicit Quit or confirmed Restart runs the complete prepare/store/finalize/native-read/native-dialog/native-authorize/shutdown transaction.
- All invoke inputs/outputs are strict closed schemas with exact size/cardinality checks. Raw proof identities, process identities, MACs, authority keys, bridge handles, and storage-repair internal plans never reach JavaScript.
- The packaged app uses only Tauri's configured sidecar resource. Development uses only the freshly built workspace artifact selected through generated project-relative configuration. Neither path searches `PATH`.
- Source/config/scripts derive paths at runtime; no project file contains a machine-specific absolute path.
- Tests create and own temporary data directories and helper processes only. They never target PID 54876 or the protected review directories.
- `termx-ui-native/test-support` and Tauri mock seams are unavailable in release builds.

## Test-Support Contract

`C:\Dev\TermX\ui\src-tauri\src\test_support.rs` is extended with `NativeShellFixture`, `HostManagerFixture`, `ConfigFixture`, `ShutdownFixture`, `AuditFixture`, and `SidecarFixture`. `HostManagerFixture` runs a real loopback protocol-v2 preflight helper or a test-owned real `termx-host` artifact from the isolated target directory; it records sidecar-start calls, exact process identity checks, native secret exposure observations, state transitions, mutex ownership, and runtime re-reads. `ConfigFixture` owns one temporary config path, an injected exact-byte atomic store, deterministic allowlisted environment values/generated profile defaults, storage failure injection, file-byte snapshots, and live-host mutation counters; `valid_config()` returns `default_config_v2()` and `valid_config_with_argument(argument)` changes only the PowerShell override argument vector. `ShutdownFixture` exercises the actual host proof/MAC flow through a test dialog seam whose choice is explicit. `SidecarFixture` inspects generated Tauri configuration and bundled filenames without invoking an installer. No helper accepts arbitrary external PIDs or directories.

---

### Task 1: Promote `termx-ui-native` into a minimal Tauri 2 application

**Files:**
- Modify: `C:\Dev\TermX\Cargo.toml`
- Modify: `C:\Dev\TermX\ui\src-tauri\Cargo.toml`
- Modify: `C:\Dev\TermX\ui\src-tauri\src\lib.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\build.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\src\app_manifest_commands.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\src\main.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\src\app_state.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\src\test_support.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tauri.conf.json`
- Create: `C:\Dev\TermX\ui\src-tauri\capabilities\default.json`
- Create: `C:\Dev\TermX\ui\package.json`
- Create: `C:\Dev\TermX\ui\package-lock.json`
- Create: `C:\Dev\TermX\ui\tsconfig.json`
- Create: `C:\Dev\TermX\ui\vite.config.ts`
- Create: `C:\Dev\TermX\ui\index.html`
- Create: `C:\Dev\TermX\ui\src\main.tsx`
- Create: `C:\Dev\TermX\ui\src\app\App.tsx`
- Create: `C:\Dev\TermX\ui\src\app\styles.css`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\tauri_surface.rs`

**Interfaces:**
- Produces:
  ```rust
  pub struct NativeAppShellState {
      native_dialog_active: std::sync::Arc<
          std::sync::atomic::AtomicBool,
      >,
  }

  pub const REGISTERED_COMMAND_NAMES: [&str; 10] = [
      "bootstrap_host",
      "read_config",
      "write_config",
      "confirm_shutdown",
      "confirm_teardown_repair",
      "prepare_storage_repair",
      "confirm_storage_repair",
      "execute_storage_repair",
      "cancel_storage_repair",
      "get_storage_repair_status",
  ];

  pub fn registered_command_names() ->
      &'static [&'static str];

  pub fn build_app_shell<R: tauri::Runtime>() -> tauri::Builder<R>;
  ```
- Task 1 freezes the exact compatible native matrix `tauri = 2.11.5`, `tauri-build = 2.6.3`, `@tauri-apps/api = 2.11.1`, `@tauri-apps/cli = 2.11.4`, `tauri-plugin-dialog = 2.7.2`, `tauri-plugin-notification = 2.3.3`, and `tauri-plugin-shell = 2.3.5`, plus the exact renderer scaffold matrix `react = 19.2.7`, `react-dom = 19.2.7`, `vite = 8.1.5`, `@vitejs/plugin-react = 6.0.3`, `typescript = 6.0.3`, `@types/node = 24.13.3`, `@types/react = 19.2.17`, and `@types/react-dom = 19.2.3`. Every Cargo manifest uses an exact `=x.y.z` requirement, every npm manifest value is an exact `x.y.z` string without `^` or `~`, and both lockfiles retain the exact resolved package checksums. `typescript = 6.0.3` is intentional rather than `7.0.2` because Phase 6 pins `typescript-eslint = 8.64.0`, whose peer range is `<6.1.0`. The npm manifest also freezes `engines.node = "24.14.1"`, `engines.npm = "11.11.0"`, and `packageManager = "npm@11.11.0"`; implementation records the actual `node --version` and `npm --version` output before install and requires the exact reviewed outputs `v24.14.1` and `11.11.0`. These packages have independent release trains and are not required to share a minor number.
- `app_manifest_commands.rs` is a data-only source included by both `build.rs` and the library. `build.rs` calls `tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&REGISTERED_COMMAND_NAMES)))`, generating exactly the ten `allow-$command`/`deny-$command` application permissions before any handler implementation exists. `capabilities/default.json` lists exactly the ten unprefixed `allow-bootstrap-host` through `allow-get-storage-repair-status` identifiers. Task 1 does not register handler functions or construct later services; the final complete `build_app` assembly moves to Task 7 after Tasks 3-6 create the state and commands.
- Invariant: `ShutdownSecretStore` remains private inside the verified native host-session/coordinator implementation rather than being a publicly reachable app-state field. Because dialog, notification, and shell are invoked only from trusted Rust, the renderer capability grants no `dialog:*`, `notification:*`, `shell:*`, filesystem, network, or process permission. The fixed sidecar logical name and empty argv are enforced by the narrow Rust `SidecarLaunchPort`, not by a renderer shell permission. `show_native_notification`, `get_native_status`, every PTY/protocol proxy, and every test-support command are absent from the release registry.

- [ ] **Step 1: Write failing command-surface and capability tests**

```rust
#[test]
fn registered_invoke_surface_is_closed_and_contains_no_pty_proxy() {
    let commands = termx_ui_native::registered_command_names();
    assert_eq!(commands, [
        "bootstrap_host",
        "read_config",
        "write_config",
        "confirm_shutdown",
        "confirm_teardown_repair",
        "prepare_storage_repair",
        "confirm_storage_repair",
        "execute_storage_repair",
        "cancel_storage_repair",
        "get_storage_repair_status",
    ]);
    for forbidden in [
        "get_native_status",
        "show_native_notification",
        "attach",
        "input",
        "resize",
        "replay",
        "commit_layout",
        "commit_safety_state",
    ] {
        assert!(!commands.contains(&forbidden));
    }
}

#[test]
fn default_capability_contains_only_exact_application_permissions() {
    let capability = load_default_capability();
    assert_eq!(
        capability.permissions,
        [
            "allow-bootstrap-host",
            "allow-read-config",
            "allow-write-config",
            "allow-confirm-shutdown",
            "allow-confirm-teardown-repair",
            "allow-prepare-storage-repair",
            "allow-confirm-storage-repair",
            "allow-execute-storage-repair",
            "allow-cancel-storage-repair",
            "allow-get-storage-repair-status",
        ],
    );
    assert!(!capability.permissions.iter().any(|permission| {
        permission.starts_with("shell:")
            || permission.starts_with("dialog:")
            || permission.starts_with("notification:")
            || permission.starts_with("fs:")
    }));
}

#[test]
fn exact_tauri_dependencies_are_frozen_without_version_ranges() {
    let manifests = TauriManifestFixture::load();
    for dependency in [
        "tauri",
        "tauri-build",
        "@tauri-apps/api",
        "@tauri-apps/cli",
        "react",
        "react-dom",
        "vite",
        "@vitejs/plugin-react",
        "typescript",
        "@types/node",
        "@types/react",
        "@types/react-dom",
        "tauri-plugin-dialog",
        "tauri-plugin-notification",
        "tauri-plugin-shell",
    ] {
        assert!(manifests.requirement_is_exact(dependency));
        assert!(manifests.lockfile_contains_exact(dependency));
    }
    assert_eq!(manifests.node_engine(), "24.14.1");
    assert_eq!(manifests.npm_engine(), "11.11.0");
    assert_eq!(manifests.package_manager(), "npm@11.11.0");
    assert_eq!(manifests.requirement("typescript"), "6.0.3");
}
```

Add tests that `build.rs` and `registered_command_names()` consume the same data-only constant; the pinned Tauri generated permissions contain exactly ten allow/deny pairs; the exact capability is accepted by `@tauri-apps/cli = 2.11.4`; no plugin, filesystem, network, or process permission is granted; arbitrary shell names and nonempty sidecar argv are rejected by the Rust launch adapter contract; the window close handler uses `prevent_close` only while a native confirmation dialog is active, otherwise allows UI exit; `build_app_shell` manages only `NativeAppShellState` and initializes the three pinned plugins without invoking a later handler; and test-support commands/modules are absent without the feature. The complete one-state/ten-real-handler assembly test belongs to Task 7.

- [ ] **Step 2: Run RED**

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'
cargo test -p termx-ui-native --test tauri_surface -- --test-threads=1
```

Expected: Tauri dependencies, app entrypoint, capability, and closed command registry do not exist.

- [ ] **Step 3: Add the minimal Tauri shell**

Keep all Phase 3 modules in the same crate. Enable Tauri only for the application/default feature while pure native tests remain directly callable. Before installing packages, run `node --version` and `npm --version`; require exact Node `v24.14.1` and npm `11.11.0`, then create `C:\Dev\TermX\ui\package.json` with exact values `react: "19.2.7"`, `react-dom: "19.2.7"`, `vite: "8.1.5"`, `@vitejs/plugin-react: "6.0.3"`, `typescript: "6.0.3"`, `@types/node: "24.13.3"`, `@types/react: "19.2.17"`, `@types/react-dom: "19.2.3"`, `@tauri-apps/api: "2.11.1"`, and `@tauri-apps/cli: "2.11.4"`; run `npm --prefix ui install` once to produce the lockfile and do not use floating ranges. `main.rs` invokes `termx_ui_native::run()`. `build_app_shell` initializes `tauri-plugin-dialog = 2.7.2`, `tauri-plugin-notification = 2.3.3`, and `tauri-plugin-shell = 2.3.5`, manages only `NativeAppShellState`, and installs the close-event policy; it deliberately registers no application handlers yet. `build.rs` includes `src/app_manifest_commands.rs` and generates the exact app ACL manifest. No renderer plugin permission is granted because all three plugins are called only by trusted Rust. The later production sidecar adapter uses `app.shell().sidecar("termx-host")?.spawn()?` with a hard-coded logical basename and empty argv; Task 1 does not launch it. Scaffold a minimal renderer with no native call yet; Task 4 adds the raw invoke adapter and Task 7 wires the final app. No WebSocket or terminal implementation is added until Phase 6.

- [ ] **Step 4: Verify GREEN**

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'
cargo test -p termx-ui-native --test tauri_surface -- --test-threads=1
cargo clippy -p termx-ui-native --all-targets --all-features -- -D warnings
npm --prefix ui run typecheck
```

Expected: closed native surface passes, Clippy is clean, and the minimal renderer typechecks.

- [ ] **Step 5: Commit**

```powershell
git add -- Cargo.toml ui/package.json ui/package-lock.json ui/tsconfig.json ui/vite.config.ts ui/index.html ui/src ui/src-tauri/Cargo.toml ui/src-tauri/build.rs ui/src-tauri/src/app_manifest_commands.rs ui/src-tauri/src/lib.rs ui/src-tauri/src/main.rs ui/src-tauri/src/app_state.rs ui/src-tauri/src/test_support.rs ui/src-tauri/tauri.conf.json ui/src-tauri/capabilities/default.json ui/src-tauri/tests/tauri_surface.rs
git commit -m "feat(tauri): scaffold the trusted native shell" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Implement strict runtime discovery and native Preflight

**Files:**
- Create: `C:\Dev\TermX\ui\src-tauri\src\runtime_discovery.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\src\native_preflight.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\runtime_discovery.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\native_preflight.rs`
- Modify: `C:\Dev\TermX\ui\src-tauri\src\app_state.rs`
- Modify: `C:\Dev\TermX\ui\src-tauri\src\lib.rs`

**Interfaces:**
- Consumes Phase 2 `RuntimeDiscoveryV2`, `Preflight`, `PreflightOk`, strict codecs, Phase 3 `RepairStatusV1`, and Phase 1 exact process identity.
- Produces these internal classifications and the one closed renderer bootstrap result:
  ```rust
  pub enum DiscoveryClassification {
      Ready(VerifiedHostBootstrap),
      Missing,
      ProvenDead(DeadHostObservation),
      LiveProtocolMismatch(ProtocolMismatchInfo),
      LegacyLive(LegacyHostPreview),
      OwnershipUncertain(OwnershipUncertainty),
      RepairRequired(RepairStatusV1),
  }

  pub enum DiscoveryFailure {
      RuntimeRead,
      RuntimeSchema,
      ProcessOpen,
      ListenerConnect,
      Authentication,
      Permission,
      InternalAdapter,
  }

  pub struct VerifiedHostBootstrap {
      pub websocket_url: String,
      pub token: secrecy::SecretString,
      pub data_dir_instance_id: uuid::Uuid,
      pub host_instance_id: uuid::Uuid,
      pub host_version: String,
      pub protocol_major: u16,
      pub protocol_minor: u16,
  }

  #[derive(Clone, Debug, serde::Serialize)]
  #[serde(rename_all = "snake_case")]
  pub struct RendererHostBootstrapV1 {
      pub websocket_url: String,
      pub token: String,
      pub data_dir_instance_id: uuid::Uuid,
      pub host_instance_id: uuid::Uuid,
      pub host_version: String,
      pub protocol_major: u16,
      pub protocol_minor: u16,
  }

  #[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
  #[serde(rename_all = "snake_case")]
  pub enum BootstrapHostFailureCodeV1 {
      DiscoveryFailure,
      HostLaunchFailure,
      AuthenticationFailure,
      OwnershipUncertain,
      PermissionDenied,
      BootstrapConflict,
      RecoveryPlanTooLarge,
      ManualInterventionRequired,
  }

  #[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
  #[serde(rename_all = "snake_case")]
  pub enum BootstrapHostFailureCategoryV1 {
      Discovery,
      Launch,
      Authentication,
      Ownership,
      Permission,
      Recovery,
      ManualIntervention,
  }

  #[derive(Clone, Debug, serde::Serialize)]
  #[serde(rename_all = "snake_case")]
  pub struct RendererHistoricalSessionStatusV1 {
      #[serde(skip_serializing_if = "Option::is_none")]
      pub stable_tab_id: Option<uuid::Uuid>,
      pub session_id: u32,
      pub recovery_status: HistoricalRecoveryStatusV1,
      #[serde(skip_serializing_if = "Option::is_none")]
      pub reason_code: Option<String>,
  }

  #[derive(Clone, Debug, serde::Serialize)]
  #[serde(rename_all = "snake_case")]
  pub struct RendererStorageRepairRequiredV1 {
      pub loaded_from: RepairLoadedFromV1,
      pub listener_scope: RepairListenerScopeV1,
      pub reason_code: String,
      pub historical_sessions:
          Vec<RendererHistoricalSessionStatusV1>,
      pub containment_reboot_record_ids: Vec<uuid::Uuid>,
  }

  #[derive(Clone, Debug, serde::Serialize)]
  #[serde(tag = "outcome", rename_all = "snake_case")]
  pub enum BootstrapHostResultV1 {
      Ready {
          bootstrap: RendererHostBootstrapV1,
      },
      LiveProtocolMismatch {
          ui_version: String,
          ui_protocol_major: u16,
          ui_protocol_minor: u16,
          host_version: String,
          host_protocol_major: u16,
          host_protocol_minor: u16,
      },
      LegacyHostLive {
          host_version: String,
          runtime_schema_version: u16,
          guidance_code: LegacyHostGuidanceCodeV1,
          redacted_message: String,
      },
      StorageRepairRequired {
          repair: RendererStorageRepairRequiredV1,
      },
      Failed {
          code: BootstrapHostFailureCodeV1,
          category: BootstrapHostFailureCategoryV1,
          retryable: bool,
          redacted_message: String,
      },
  }

  impl VerifiedHostBootstrap {
      pub fn into_renderer_projection(self) ->
          RendererHostBootstrapV1;
  }

  #[derive(Clone, Copy, Debug, Eq, PartialEq)]
  pub enum NativeProjectionError {
      InvalidReasonCode,
      InvalidRedactedMessage,
      HistoricalSessionLimit,
      ContainmentRecordLimit,
      EncodedResultLimit,
  }

  impl BootstrapHostResultV1 {
      pub fn failed(
          code: BootstrapHostFailureCodeV1,
          redacted_message: &str,
      ) -> Result<Self, NativeProjectionError>;
  }

  pub async fn discover_and_preflight(
      data_dir: &std::path::Path,
  ) -> Result<DiscoveryClassification, DiscoveryFailure>;
  ```
- `HistoricalRecoveryStatusV1`, `RepairLoadedFromV1`, `RepairListenerScopeV1`, and `LegacyHostGuidanceCodeV1` are closed enums with the exact wire spellings from the specification: `historical_only|recoverable|unrecoverable|containment_uncertain`, `backup`, `diagnostic_repair_only`, and `close_legacy_host_manually`. The projection preserves each approved `RepairStatusV1::RepairRequired.historical_sessions[*].record.stable_tab_id` as optional and maps `.record.session_id` directly. `containment_reboot_record_ids` does not come from `HistoricalSessionStatusV1`: native discovery parses the same validated `StateV2` source snapshot already bound by `RepairStatusV1`, selects `unregistered_containment_records` in source order with `state=armed|containment_uncertain`, and projects only each exact `record_id`, rejecting duplicates or a source/status snapshot mismatch. It never fabricates an actionable record ID from a session ID or artifact identity. `RendererStorageRepairRequiredV1.reason_code`, every historical `reason_code`, and every failure/guidance message are constructor-validated at 128, 128, and 1,024 UTF-8 bytes respectively; `historical_sessions` is capped at 4,096 and `containment_reboot_record_ids` at 128. Failure construction owns the exact immutable code/category/retryability table: discovery/recovery availability failures are retryable only when a fresh disk/process observation could change the result; permission, ownership uncertainty, bootstrap conflict, recovery-plan-too-large, and manual intervention are non-retryable without user action.
- Invariant: `VerifiedHostBootstrap` never contains the shutdown-authority key, raw runtime document, or latest-import witness. `RendererHostBootstrapV1` is the sole token-bearing JavaScript projection, serializes the exact recursive `snake_case` native wire keys consumed by Phase 6's boundary DTOs, and is held only in renderer memory; neither native Rust nor React persists/logs/caches its token. `BootstrapHostResultV1` is a Phase 5 adapter contract that closes an omission in the plan without altering any §4.2 native command. It represents expected discovery/launch/authentication/mismatch/legacy/repair/manual states as bounded success values; no `get_native_status`, `NativeFailureV1`, `NativeBootstrapFailure`, arbitrary error string, or fabricated ready bootstrap exists. The repair projection intentionally excludes `source_snapshot`, pending quarantine identity, artifact/process/target-directory identities, hashes, paths, owner observations, and MAC/proof data; only user-facing stable/session/record IDs needed to choose a repair action cross into JavaScript.

- [ ] **Step 1: Write failing exact-identity and secret-boundary tests**

```rust
#[tokio::test]
async fn authenticated_preflight_is_required_before_ready() {
    let fixture = HostManagerFixture::runtime_v2();
    fixture.answer_preflight_with_wrong_process_start_time();
    let classification = fixture.discover().await.unwrap();
    assert!(matches!(
        classification,
        DiscoveryClassification::OwnershipUncertain(_)
    ));
    assert_eq!(fixture.sidecar_start_calls(), 0);
}

#[tokio::test]
async fn renderer_bootstrap_contains_token_but_no_other_native_secret() {
    let fixture = HostManagerFixture::ready_v2().await;
    let result = fixture.bootstrap_result().await.unwrap();
    let json = serde_json::to_value(result).unwrap();
    assert_eq!(json["outcome"], "ready");
    assert!(json.pointer("/bootstrap/token").is_some());
    assert!(!fixture.recursive_json_keys(&json).iter().any(|key| {
        matches!(
            key.as_str(),
            "shutdownAuthorityKey"
                | "shutdown_authority_key"
                | "processIdentity"
                | "process_identity"
                | "sourceSnapshot"
                | "source_snapshot"
                | "targetDirectoryIdentity"
                | "target_directory_identity"
                | "pendingPrimaryQuarantineIdentity"
                | "pending_primary_quarantine_identity"
                | "mac"
        )
    }));
    assert!(!json.to_string().contains(
        fixture.shutdown_key_marker()
    ));
}

#[tokio::test]
async fn live_mismatch_is_a_non_destructive_closed_result() {
    let fixture = HostManagerFixture::live_protocol_mismatch();
    let result = fixture.bootstrap_result().await.unwrap();
    assert!(matches!(
        result,
        BootstrapHostResultV1::LiveProtocolMismatch {
            ui_protocol_major: 2,
            host_protocol_major: 3,
            ..
        }
    ));
    assert_eq!(fixture.sidecar_start_calls(), 0);
    assert_eq!(fixture.shutdown_calls(), 0);
}

#[test]
fn bootstrap_failure_mapping_is_closed_and_redacted() {
    for row in expected_bootstrap_failure_table() {
        let result = BootstrapHostResultV1::failed(
            row.code,
            row.message,
        )
        .unwrap();
        let BootstrapHostResultV1::Failed {
            category,
            retryable,
            redacted_message,
            ..
        } = result else {
            panic!("expected failed result");
        };
        assert_eq!(category, row.category);
        assert_eq!(retryable, row.retryable);
        assert!(redacted_message.as_bytes().len() <= 1024);
    }
}
```

Add malformed/unreadable runtime, wrong token, host/data UUID, PID/start time, protocol/version, listener refusal, PID reuse, foreign directory, exact top-level 4 MiB bootstrap-result cap, runtime read-change race, schema 1 read-only authentication/preview, `close_legacy_host_manually` guidance, legacy no-Shutdown, repair projection cardinalities and forbidden recursive keys, every failure-code mapping, and live mismatch unchanged-host tests. The expected RED must name the missing `BootstrapHostResultV1` and safe projection constructors rather than an undefined generic failure.

- [ ] **Step 2: Run RED**

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'
cargo test -p termx-ui-native --test runtime_discovery -- --test-threads=1
cargo test -p termx-ui-native --test native_preflight -- --test-threads=1
```

Expected: discovery/preflight modules and classifications do not exist.

- [ ] **Step 3: Implement strict read, exact process verification, and Preflight**

Apply/verify DACL before reading credentials. Parse runtime with strict schema/no unknown or duplicate keys and exact 64-lowercase-hex secret lengths. Open the exact process, verify PID/start `FILETIME`, connect only to `ws://127.0.0.1:<port>`, send native Preflight with expected UUIDs/token, and compare every returned identity. Transfer the shutdown key into the private native host-session owned by `HostManager`/`ShutdownCoordinator`; no public state getter or cloneable projection exposes it. Build `BootstrapHostResultV1` by exhaustive matching over the internal classification: only `Ready` constructs the token-bearing renderer projection; mismatch, legacy, repair-required, ownership-uncertain, and operational failures construct their exact bounded non-ready variants. A mismatch closes that socket and classifies without mutation.

- [ ] **Step 4: Verify GREEN**

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'
cargo test -p termx-ui-native --test runtime_discovery -- --test-threads=1
cargo test -p termx-ui-native --test native_preflight -- --test-threads=1
cargo test -p termx-data-security -- --test-threads=1
```

Expected: all exact identity/legacy/mismatch/secret-boundary fixtures pass and no sidecar starts for uncertain/live states.

- [ ] **Step 5: Commit**

```powershell
git add -- ui/src-tauri/src/runtime_discovery.rs ui/src-tauri/src/native_preflight.rs ui/src-tauri/src/app_state.rs ui/src-tauri/src/lib.rs ui/src-tauri/tests/runtime_discovery.rs ui/src-tauri/tests/native_preflight.rs
git commit -m "feat(tauri): authenticate native host discovery" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Serialize discovery, bootstrap, and sidecar start

**Files:**
- Create: `C:\Dev\TermX\ui\src-tauri\src\host_lifecycle.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\src\bootstrap.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\src\sidecar_launch.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\host_lifecycle.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\bootstrap_reconciliation.rs`
- Modify: `C:\Dev\TermX\ui\src-tauri\src\lib.rs`
- Modify: `C:\Dev\TermX\ui\src-tauri\src\app_state.rs`

**Interfaces:**
- Produces:
  ```rust
  #[derive(Clone, Copy, Debug, Eq, PartialEq)]
  pub enum HostManagerState {
      Stopped,
      Discovering,
      Spawning,
      Connecting,
      Authenticating,
      Ready,
      Backoff,
  }

  pub type HostBootstrapFuture = futures::future::BoxFuture<
      'static,
      Result<BootstrapHostResultV1, std::sync::Arc<NativeAdapterError>>,
  >;

  pub trait SidecarLaunchPort: Send + Sync {
      fn launch_termx_host(
          &self,
      ) -> Result<LaunchedSidecarV1, NativeAdapterError>;
  }

  struct InFlightBootstrap {
      generation: u64,
      future: futures::future::Shared<HostBootstrapFuture>,
  }

  pub struct HostManager {
      state: tokio::sync::Mutex<HostManagerInner>,
      launcher: std::sync::Arc<dyn SidecarLaunchPort>,
  }

  struct HostManagerInner {
      lifecycle: HostManagerState,
      next_generation: u64,
      in_flight: Option<InFlightBootstrap>,
  }

  impl HostManager {
      pub async fn bootstrap(
          &self,
          context: std::sync::Arc<NativeContext>,
      ) -> Result<
          BootstrapHostResultV1,
          std::sync::Arc<NativeAdapterError>,
      >;
  }
  ```
- `NativeAdapterError` is a private, non-serializable closed enum with exact variants `ServiceDisposed`, `InvariantViolation`, `ProjectionFailed`, and `PlatformAdapterFailed`; it stores no arbitrary string, source error, backtrace, path, identifier, token, or proof bytes. `HostManager` shares it behind `Arc` only to satisfy `Shared` output cloning. Task 4 alone maps `ServiceDisposed` to `native_state_unavailable,true` and the other three variants to `native_adapter_failure,false` with constructor-owned constant text. Every expected discovery, launch, authentication, ownership, mismatch, legacy, repair, recovery-plan, and manual-intervention outcome is a `BootstrapHostResultV1` value.
- Invariant: `HostManager` owns its short state lock internally; it never holds a `tokio::sync::MutexGuard` across process I/O, socket I/O, sidecar launch, native dialog, or backoff. `HostBootstrapFuture` is the exact alias `futures::future::BoxFuture<'static, Result<BootstrapHostResultV1, std::sync::Arc<NativeAdapterError>>>`, so its output satisfies `Clone` and can be wrapped by `futures::future::Shared`. Concurrent in-process callers clone and await one `Shared<HostBootstrapFuture>`; the command boundary converts the shared `Arc<NativeAdapterError>` to the closed rejection without exposing its source. Cross-process candidates separately hold the OS recovery mutex continuously from first dead-host proof through bootstrap/import acknowledgement or safe failure cleanup.

- [ ] **Step 1: Write failing concurrency and crash-prefix tests**

```rust
#[tokio::test]
async fn concurrent_bootstrap_calls_share_one_discovery_and_spawn() {
    let fixture = HostManagerFixture::missing_host();
    let results = fixture.concurrent_bootstrap_calls(16).await;
    assert!(results.iter().all(|result| matches!(
        result,
        Ok(BootstrapHostResultV1::Ready { .. })
    )));
    assert_eq!(fixture.discovery_passes(), 1);
    assert_eq!(fixture.sidecar_start_calls(), 1);
    assert_eq!(fixture.unique_host_instance_ids().len(), 1);
}

#[tokio::test]
async fn abandoned_recovery_mutex_reconciles_before_any_write_or_spawn() {
    let fixture = HostManagerFixture::abandoned_with_mismatched_tombstone();
    let result = fixture.bootstrap().await.unwrap();
    assert!(matches!(
        result,
        BootstrapHostResultV1::Failed {
            code: BootstrapHostFailureCodeV1::BootstrapConflict,
            retryable: false,
            ..
        }
    ));
    assert_eq!(fixture.bootstrap_writes(), 0);
    assert_eq!(fixture.sidecar_start_calls(), 0);
}
```

Add all Stopped/Discovering/Spawning/Connecting/Authenticating/Ready/Backoff transitions; waiter re-read after mutex release; atomic create-or-exact-match bootstrap; 512 KiB/4,096 preview/1,024 draft caps; source raw-byte hash and revision drift; spawn failure cleanup; runtime re-read after spawn; witness/tombstone acknowledgement loss; distinct later import only after matching tombstone; and no reconstructed action before exact import acknowledgement. Add overlapping callers sharing one pending generation; completion clearing `in_flight` only when its generation still matches; a sequential call after transient failure starting a new discovery generation; a sequential call after a previously Ready host dies performing fresh classification instead of replaying the old result; and an older completion unable to clear a newer pending operation. The fake `SidecarLaunchPort` records only `launch_termx_host()` calls and accepts no caller-selected name, argv, path, or environment.

- [ ] **Step 2: Run RED**

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'
cargo test -p termx-ui-native --test host_lifecycle -- --test-threads=1
cargo test -p termx-ui-native --test bootstrap_reconciliation -- --test-threads=1
```

Expected: host manager/bootstrap state machine absent.

- [ ] **Step 3: Implement one shared future and one cross-process authority path**

Only `bootstrap_host` calls that overlap the same pending generation join its shared future. Creating a new operation increments `next_generation`, stores `InFlightBootstrap { generation, future }`, and owns all mutable lifecycle work while callers never receive or mutate the internal state machine. Completion clears `in_flight` only if the stored generation still equals the completing generation; the completed renderer result is not cached in `HostManager`, so later calls always begin fresh discovery/reclassification and cannot replay a stale Ready or transient failure. Discovery returns immediately for verified Ready/mismatch/legacy/repair-required/uncertain states. Proven dead/missing paths acquire recovery then preownership/ordinary mutexes as specified, fully reclassify, prepare the exact bounded recovery bootstrap when reconstruction applies, atomically create-or-match it, launch only the configured sidecar, then repeatedly re-read and native-Preflight until Ready/import acknowledgement or a closed bounded failure result. On `WAIT_ABANDONED`, reconcile runtime/bootstrap/witness/tombstone before writing. Release the recovery mutex only after candidate ordinary ownership publication/import acknowledgement or safe stopped cleanup.

- [ ] **Step 4: Verify GREEN**

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'
cargo test -p termx-ui-native --test host_lifecycle -- --test-threads=1
cargo test -p termx-ui-native --test bootstrap_reconciliation -- --test-threads=1
cargo test -p termx-host --test recovery_e2e -- --test-threads=1
```

Expected: all concurrency/crash prefixes converge to one spawn/import or fail closed without overwrite/action.

- [ ] **Step 5: Commit**

```powershell
git add -- ui/src-tauri/src/host_lifecycle.rs ui/src-tauri/src/bootstrap.rs ui/src-tauri/src/sidecar_launch.rs ui/src-tauri/src/test_support.rs ui/src-tauri/src/lib.rs ui/src-tauri/src/app_state.rs ui/src-tauri/tests/host_lifecycle.rs ui/src-tauri/tests/bootstrap_reconciliation.rs
git commit -m "feat(tauri): serialize detached host lifecycle" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Expose strict native invokes and StorageRepair adapters

**Files:**
- Create: `C:\Dev\TermX\ui\src-tauri\src\commands.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\src\invoke_types.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\invoke_contracts.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\storage_invoke.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\config_invoke.rs`
- Modify: `C:\Dev\TermX\ui\src-tauri\src\lib.rs`
- Modify: `C:\Dev\TermX\ui\src-tauri\src\storage.rs`
- Modify: `C:\Dev\TermX\ui\src-tauri\src\storage_repair.rs`

**Interfaces:**
- Consumes the exact recursive `snake_case` §4.2 request/result schemas from `termx_contracts::native` and `termx_contracts::storage`, the Phase 2 pure config APIs (`ConfigContentHash`, `Sha256Fingerprint`, `parse_config_v2`, `validate_config_v2_shape`, `validate_config_v2_effective_argv`, `encode_config_v2_pretty`, and `config_content_hash`), and the exact Phase 3 `StorageRepairService`. Phase 5 imports `ConfirmShutdownRequestV1`, `ConfirmTeardownRepairRequestV1`, `PrepareStorageRepairRequestV1`, `ConfirmStorageRepairRequestV1`, `ExecuteStorageRepairRequestV1`, `CancelStorageRepairRequestV1`, `GetStorageRepairStatusRequestV1`, `NativeShutdownAuthorizationResult`, `NativeTeardownRepairResult`, `StorageRepairPrepared`, `StorageRepairAuthorized`, `StorageRepairExecutionResultV1`, and `StorageRepairStatusV1`; it does not redeclare, alias, reshape, or wrap any of them.
- Produces:
  ```rust
  pub const MAX_NATIVE_INVOKE_REQUEST_BYTES: usize = 1024 * 1024;
  pub const MAX_STANDARD_NATIVE_REQUEST_BYTES: usize = 256 * 1024;
  pub const MAX_WRITE_CONFIG_REQUEST_BYTES: usize =
      MAX_NATIVE_INVOKE_REQUEST_BYTES;
  pub const MAX_NATIVE_INVOKE_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

  #[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
  #[serde(deny_unknown_fields)]
  pub struct BootstrapHostRequestV1 {}

  #[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
  #[serde(deny_unknown_fields)]
  pub struct ReadConfigRequestV1 {}

  #[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
  #[serde(deny_unknown_fields)]
  pub struct WriteConfigRequestV1 {
      pub expected_content_hash: ConfigContentHash,
      pub config: ConfigV2,
  }

  use termx_contracts::native::{
      CancelStorageRepairRequestV1,
      ConfirmShutdownRequestV1,
      ConfirmStorageRepairRequestV1,
      ConfirmTeardownRepairRequestV1,
      ExecuteStorageRepairRequestV1,
      GetStorageRepairStatusRequestV1,
      NativeShutdownAuthorizationResult,
      NativeTeardownRepairResult,
      PrepareStorageRepairRequestV1,
      StorageRepairAuthorized,
      StorageRepairPrepared,
  };
  use termx_contracts::storage::{
      StorageRepairExecutionResultV1,
      StorageRepairStatusV1,
  };

  pub enum NativeInvokeRequestV1 {
      BootstrapHost(BootstrapHostRequestV1),
      ReadConfig(ReadConfigRequestV1),
      WriteConfig(WriteConfigRequestV1),
      ConfirmShutdown(ConfirmShutdownRequestV1),
      ConfirmTeardownRepair(ConfirmTeardownRepairRequestV1),
      PrepareStorageRepair(PrepareStorageRepairRequestV1),
      ConfirmStorageRepair(ConfirmStorageRepairRequestV1),
      ExecuteStorageRepair(ExecuteStorageRepairRequestV1),
      CancelStorageRepair(CancelStorageRepairRequestV1),
      GetStorageRepairStatus(GetStorageRepairStatusRequestV1),
  }

  pub fn decode_native_invoke(
      command: &'static str,
      raw: &[u8],
  ) -> Result<NativeInvokeRequestV1, NativeInvokeRejectionV1>;

  #[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
  #[serde(rename_all = "snake_case")]
  pub enum NativeInvokeRejectionCodeV1 {
      InvalidNativeRequest,
      NativeRequestTooLarge,
      NativeResponseTooLarge,
      NativeStateUnavailable,
      NativeAdapterFailure,
  }

  #[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
  #[serde(rename_all = "snake_case")]
  pub struct InvalidConfigDetailV1 {
      pub reason_code: ConfigValidationReasonV1,
      #[serde(skip_serializing_if = "Option::is_none")]
      pub argument_index: Option<u16>,
  }

  #[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
  #[serde(tag = "outcome", rename_all = "snake_case")]
  pub enum ReadConfigResultV1 {
      Ready {
          config: ConfigV2,
          content_hash: ConfigContentHash,
      },
      InvalidConfig {
          detail: InvalidConfigDetailV1,
      },
  }

  #[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
  #[serde(tag = "outcome", rename_all = "snake_case")]
  pub enum WriteConfigResultV1 {
      Written {
          content_hash: Sha256Fingerprint,
          profiles_restart_required: bool,
      },
      ConfigConflict {
          content_hash: ConfigContentHash,
          config: ConfigV2,
      },
      InvalidConfig {
          detail: InvalidConfigDetailV1,
      },
  }

  #[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
  #[serde(rename_all = "snake_case")]
  pub struct NativeInvokeRejectionV1 {
      pub code: NativeInvokeRejectionCodeV1,
      pub retryable: bool,
      pub redacted_message: String,
  }

  #[tauri::command]
  pub async fn read_config(
      state: tauri::State<'_, NativeAppState>,
      request: tauri::ipc::Request<'_>,
  ) -> Result<tauri::ipc::Response, NativeInvokeRejectionV1>;

  #[tauri::command]
  pub async fn write_config(
      state: tauri::State<'_, NativeAppState>,
      request: tauri::ipc::Request<'_>,
  ) -> Result<tauri::ipc::Response, NativeInvokeRejectionV1>;

  async fn read_config_decoded(
      state: &NativeAppState,
      request: ReadConfigRequestV1,
  ) -> Result<ReadConfigResultV1, NativeInvokeRejectionV1>;

  async fn write_config_decoded(
      state: &NativeAppState,
      request: WriteConfigRequestV1,
  ) -> Result<WriteConfigResultV1, NativeInvokeRejectionV1>;

  pub trait AtomicConfigStore: Send + Sync {
      fn read_exact(
          &self,
      ) -> Result<Option<Vec<u8>>, ConfigStorageError>;
      fn replace_exact(
          &self,
          bytes: &[u8],
      ) -> Result<(), ConfigStorageError>;
  }

  #[derive(Clone, Copy, Debug, Eq, PartialEq)]
  pub enum ConfigStorageError {
      PermissionDenied,
      ReadFailed,
      AtomicReplaceFailed,
      ReadbackMismatch,
  }

  pub struct ConfigService {
      write_lock: tokio::sync::Mutex<()>,
      environment: std::sync::Arc<dyn ConfigEnvironment + Send + Sync>,
      generated_arguments:
          std::sync::Arc<dyn GeneratedProfileArguments + Send + Sync>,
      store: std::sync::Arc<dyn AtomicConfigStore>,
  }

  impl ConfigService {
      pub async fn read(
          &self,
      ) -> Result<ReadConfigResultV1, ConfigStorageError>;
      pub async fn write(
          &self,
          expected_content_hash: ConfigContentHash,
          config: ConfigV2,
      ) -> Result<WriteConfigResultV1, ConfigStorageError>;
  }

  #[tauri::command]
  pub async fn bootstrap_host(
      state: tauri::State<'_, NativeAppState>,
      request: tauri::ipc::Request<'_>,
  ) -> Result<tauri::ipc::Response, NativeInvokeRejectionV1>;

  #[tauri::command]
  pub async fn confirm_shutdown(
      state: tauri::State<'_, NativeAppState>,
      request: tauri::ipc::Request<'_>,
  ) -> Result<tauri::ipc::Response, NativeInvokeRejectionV1>;

  #[tauri::command]
  pub async fn confirm_teardown_repair(
      state: tauri::State<'_, NativeAppState>,
      request: tauri::ipc::Request<'_>,
  ) -> Result<tauri::ipc::Response, NativeInvokeRejectionV1>;

  #[tauri::command]
  pub async fn prepare_storage_repair(
      state: tauri::State<'_, NativeAppState>,
      request: tauri::ipc::Request<'_>,
  ) -> Result<tauri::ipc::Response, NativeInvokeRejectionV1>;

  #[tauri::command]
  pub async fn confirm_storage_repair(
      state: tauri::State<'_, NativeAppState>,
      request: tauri::ipc::Request<'_>,
  ) -> Result<tauri::ipc::Response, NativeInvokeRejectionV1>;

  #[tauri::command]
  pub async fn execute_storage_repair(
      state: tauri::State<'_, NativeAppState>,
      request: tauri::ipc::Request<'_>,
  ) -> Result<tauri::ipc::Response, NativeInvokeRejectionV1>;

  #[tauri::command]
  pub async fn cancel_storage_repair(
      state: tauri::State<'_, NativeAppState>,
      request: tauri::ipc::Request<'_>,
  ) -> Result<tauri::ipc::Response, NativeInvokeRejectionV1>;

  #[tauri::command]
  pub async fn get_storage_repair_status(
      state: tauri::State<'_, NativeAppState>,
      request: tauri::ipc::Request<'_>,
  ) -> Result<tauri::ipc::Response, NativeInvokeRejectionV1>;

  pub fn project_prepare_storage_repair_error(
      error: StorageRepairServiceErrorV1,
  ) -> Result<StorageRepairPrepared, NativeInvokeRejectionV1>;

  pub fn project_confirm_storage_repair_error(
      error: StorageRepairServiceErrorV1,
  ) -> Result<StorageRepairAuthorized, NativeInvokeRejectionV1>;

  pub fn project_execute_storage_repair_error(
      request: &ExecuteStorageRepairRequestV1,
      error: StorageRepairServiceErrorV1,
  ) -> Result<StorageRepairExecutionResultV1, NativeInvokeRejectionV1>;

  pub fn project_cancel_storage_repair_error(
      request: &CancelStorageRepairRequestV1,
      error: StorageRepairServiceErrorV1,
  ) -> Result<StorageRepairExecutionResultV1, NativeInvokeRejectionV1>;

  pub fn project_get_storage_repair_status_error(
      request: &GetStorageRepairStatusRequestV1,
      error: StorageRepairServiceErrorV1,
  ) -> Result<StorageRepairStatusV1, NativeInvokeRejectionV1>;
  ```
- `NativeInvokeRejectionV1` is the only Tauri rejection shape. It is a Phase 5 transport contract, not a domain result and not a substitute for any §4.2 outcome. Its exact immutable mapping is: invalid syntax/shape/unknown field/range/presence rule -> `invalid_native_request,false`; raw request over cap -> `native_request_too_large,false`; a safe success projection over its cap -> `native_response_too_large,false`; missing disposed application service -> `native_state_unavailable,true`; otherwise unprojectable private adapter failure -> `native_adapter_failure,false`. `redacted_message` is constructor-controlled UTF-8 at most 1,024 bytes; source/debug/display/error chains are never serialized.
- The five projection functions above are the only code allowed to inspect `StorageRepairServiceErrorCodeV1`. Each function exhaustively matches every enum member, so adding a Phase 3 code is a compile failure until all five command projections are chosen. Command handlers call exactly one service method, return its success unchanged, or call the matching projection function; they never reconstruct a plan, reacquire a service gate, reread storage, or branch on an error code.

  Exact command-by-command projection table:

  | Phase 3 service code | Prepare | Confirm | Execute | Cancel | GetStatus |
  |---|---|---|---|---|---|
  | `RequestIdBodyMismatch` | `invalid_native_request,false` | `invalid_native_request,false` | `invalid_native_request,false` | `invalid_native_request,false` | `invalid_native_request,false` |
  | `RepairNotFound` | `invalid_native_request,false` | `invalid_native_request,false` | `invalid_native_request,false` | `invalid_native_request,false` | `invalid_native_request,false` |
  | `PlanMismatch` | `invalid_native_request,false` | `invalid_native_request,false` | `invalid_native_request,false` | `invalid_native_request,false` | `invalid_native_request,false` |
  | `AuthorizationMismatch` | `invalid_native_request,false` | `invalid_native_request,false` | `invalid_native_request,false` | `invalid_native_request,false` | `invalid_native_request,false` |
  | `RepairExpired` | `invalid_native_request,false` | `invalid_native_request,false` | `invalid_native_request,false` | `invalid_native_request,false` | `invalid_native_request,false` |
  | `AuthorizationMacFailed` | `invalid_native_request,false` | `invalid_native_request,false` | `invalid_native_request,false` | `invalid_native_request,false` | `invalid_native_request,false` |
  | `RepairUnavailable` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` |
  | `OwnershipChanged` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` |
  | `SourceChanged` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` |
  | `DirectoryIdentityChanged` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` |
  | `ArtifactIdentityChanged` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` |
  | `LedgerCorrupt` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` |
  | `JournalCorrupt` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` | `native_state_unavailable,false` |
  | `LockUnavailable` | `native_state_unavailable,true` | `native_state_unavailable,true` | `native_state_unavailable,true` | `native_state_unavailable,true` | `native_state_unavailable,true` |
  | `LedgerCapacityExceeded` | `native_adapter_failure,false` | `native_adapter_failure,false` | `native_adapter_failure,false` | `native_adapter_failure,false` | `native_adapter_failure,false` |
  | `NativeConfirmationUnavailable` | `native_adapter_failure,false` | `native_adapter_failure,false` | `native_adapter_failure,false` | `native_adapter_failure,false` | `native_adapter_failure,false` |
  | `PersistenceFailed` | `native_adapter_failure,false` | `native_adapter_failure,false` | `native_adapter_failure,false` | `native_adapter_failure,false` | `native_adapter_failure,false` |
  | `ReadbackFailed` | `native_adapter_failure,false` | `native_adapter_failure,false` | `native_adapter_failure,false` | `native_adapter_failure,false` | `native_adapter_failure,false` |
  | `StorageRepairAmbiguous` | `native_state_unavailable,false` | `native_state_unavailable,false` | exact `StorageRepairExecutionResultV1 { execution_status: Ambiguous, journal_phase: Some(Ambiguous), request_id/repair_id/plan_hash copied from the validated Execute request, all other optional fields absent }` success | exact `StorageRepairExecutionResultV1 { execution_status: Ambiguous, journal_phase: Some(Ambiguous), request_id/repair_id/plan_hash copied from the validated Cancel request, all other optional fields absent }` success | exact `StorageRepairStatusV1::Ambiguous { repair_id: request.repair_id, reason_code: StorageRepairAmbiguous }` success |

  The fixed redacted messages are selected solely by the projected category: `The native request is invalid.`, `Native repair state is unavailable.`, `Native repair is busy.`, `Native repair failed.`, and `Native repair outcome is ambiguous; inspect its retained status.` The first four remain within `NativeInvokeRejectionV1`; the fifth is diagnostic text only and is not serialized into the approved success DTO. `StorageRepairAmbiguous` is the only service error that a projection may turn into success, and only Execute, Cancel, and GetStatus may do so. Phase 3 must return the approved `replayed`, `cancelled`, and `too_late` execution statuses as ordinary `Ok(StorageRepairExecutionResultV1)` values; no Phase 5 error mapping synthesizes those statuses.
- The request module imports `RequestId`, `Sha256Hex`, `ConfigV2`, `ConfigContentHash`, `ShutdownAuthorizationV1`, and `StorageRepairModeV1` directly from `termx_contracts`; it does not create native-local aliases. The native raw JSON wire is recursively `snake_case`, exactly matching §4.2 and every nested shared-contract schema; the adapter adds no camelCase aliases. `BootstrapHostRequestV1` and `ReadConfigRequestV1` accept exactly `{}`. `PrepareStorageRepairRequestV1.record_id` deliberately has no `skip_serializing_if` attribute because the type is deserialize-only; after strict decode, command-level validation requires `Some(record_id)` exactly for `ContainmentReboot` and `None` for `Restore`, `Reset`, and `Adopt`. Explicit wire `null` decodes to `None` under serde, so the lexical request validator must reject a present `record_id:null` before serde projection; absent and null are not interchangeable at this boundary.
- Expected domain outcomes remain successful command values: shutdown/teardown cancellation, stale, expired, and ownership loss use their specified native results; StorageRepair ambiguity, cancellation, replay, too-late execution, and retained status use the specified StorageRepair result variants; bootstrap discovery/launch/authentication/ownership/manual states use `BootstrapHostResultV1`; config reads/writes use `ReadConfigResultV1`/`WriteConfigResultV1` so `invalid_config` and `config_conflict` remain structured bounded values rather than Tauri rejection strings. `ReadConfig` maps an absent file to `default_config_v2()` plus `ConfigContentHash::Missing`; present empty/malformed/invalid files return `InvalidConfig` with no guessed candidate. `WriteConfigResultV1::ConfigConflict` contains the freshly read raw-byte hash and parsed current config only when that file is itself valid; a missing/current-file mismatch returns `default_config_v2()` with `ConfigContentHash::Missing`, while an invalid current file returns `InvalidConfig` and echoes no rejected text or argv. `ConfigStorageError::PermissionDenied` maps to `native_adapter_failure,false` with the fixed message `Native configuration access was denied.`; its other three variants map to `native_adapter_failure,false` with `Native configuration storage failed.`. Request/body deduplication failures generated by the Phase 3 service are projected through that service's exact retained closed result/error contract and never widened to arbitrary Tauri strings.
- The exact §4.2 `StorageRepairPrepared`, `StorageRepairAuthorized`, and `StorageRepairStatusV1::Authorized` intentionally contain the approved immutable preview/authorization schemas, including target-directory and artifact identities needed for plan-hash review and request replay. That is not permission to expose process identity, an authority key, a MAC, private mutex/handle data, or any additional internal struct. Tests validate the complete allowed schema recursively and reject extra fields; they do not delete approved schema fields from the result.
- Invariant: stable Tauri 2 exposes no independent public pre-dispatch middleware containing the original bytes of an ordinary JSON-object invoke; `InvokeBody::Json` is already parsed and cannot preserve duplicate keys or lexical byte identity. Therefore every one of the ten JavaScript adapters sends its command DTO as a UTF-8 `Uint8Array`, producing `tauri::ipc::InvokeBody::Raw`. Each registered `#[tauri::command]` wrapper accepts the documented public `tauri::ipc::Request<'_>` command argument plus `State`, matches `request.body()` only as `InvokeBody::Raw`, rejects `InvokeBody::Json`, reads the borrowed raw slice without a preliminary clone, applies the 1 MiB absolute cap and command cap (`MAX_WRITE_CONFIG_REQUEST_BYTES` only for `write_config`; `MAX_STANDARD_NATIVE_REQUEST_BYTES` for the other nine commands), then calls `decode_native_invoke(command_name, raw_bytes)` for strict duplicate-key/number/closed-schema decoding before any service method. Async borrowed-`Request` commands return `Result`, as required by the pinned command macro. Test-only direct calls use the same decoder. Every closed success value is serialized exactly once into a scratch `String`, checked against its lower domain cap and the 4 MiB absolute cap, and returned as `tauri::ipc::Response::new(serialized_json)`, which stores that `String` as `InvokeResponseBody::Json` without a second serde serialization. Under pinned `tauri = 2.11.5` / `@tauri-apps/api = 2.11.1`, the IPC JSON response is decoded by the Tauri invoke client before its Promise resolves: JavaScript observes the parsed object/array/scalar represented by `serialized_json`, not a JSON string and not raw bytes. Phase 6 therefore validates the returned `unknown` directly against the command's closed result schema and must not call `JSON.parse`, `TextDecoder`, or cast an unconstrained generic result. Every rejection is independently closed and bounded. No command returns an internal serde object by accident.

- [ ] **Step 1: Write failing closed-schema, rejection, and projection tests**

```rust
#[test]
fn invoke_rejects_unknown_fields_before_storage_service() {
    let fixture = NativeShellFixture::storage_repair_ready();
    let result = fixture.invoke_raw_json("prepare_storage_repair", r#"{
        "request_id":"11111111-1111-4111-8111-111111111111",
        "mode":"reset",
        "extra":true
    }"#);
    assert_eq!(
        result.unwrap_err().code,
        NativeInvokeRejectionCodeV1::InvalidNativeRequest
    );
    assert_eq!(fixture.storage_service_calls(), 0);
}

#[test]
fn invoke_rejects_raw_oversize_before_json_decode_or_service() {
    let fixture = NativeShellFixture::storage_repair_ready();
    let raw = fixture.valid_prepare_request_padded_to(
        MAX_STANDARD_NATIVE_REQUEST_BYTES + 1,
    );
    let result = fixture.invoke_raw(
        "prepare_storage_repair",
        &raw,
    );
    assert_eq!(
        result.unwrap_err().code,
        NativeInvokeRejectionCodeV1::NativeRequestTooLarge
    );
    assert_eq!(fixture.json_decode_calls(), 0);
    assert_eq!(fixture.storage_service_calls(), 0);
}

#[test]
fn storage_authorization_projection_is_exact_not_subtractive() {
    let fixture = NativeShellFixture::authorized_storage_repair();
    let json = fixture.invoke_confirm_storage_repair().unwrap();
    assert_eq!(
        fixture.recursive_schema_paths(&json),
        expected_storage_repair_authorized_schema_paths()
    );
    for forbidden in [
        "mac",
        "shutdownAuthorityKey",
        "shutdown_authority_key",
        "processIdentity",
        "process_identity",
        "mutexHandle",
        "rawPlanBytes",
    ] {
        assert!(!fixture.recursive_json_keys(&json).contains(
            &forbidden.to_owned()
        ));
    }
}

#[test]
fn every_native_rejection_is_closed_bounded_and_secret_free() {
    for rejection in all_native_invoke_rejections() {
        let json = serde_json::to_vec(&rejection).unwrap();
        assert!(json.len() <= 4 * 1024);
        assert!(rejection.redacted_message.as_bytes().len() <= 1024);
        for marker in secret_and_internal_markers() {
            assert!(!json.windows(marker.len()).any(|w| w == marker));
        }
    }
}

#[tokio::test]
async fn read_config_distinguishes_missing_from_present_empty() {
    let fixture = ConfigFixture::missing();
    assert_eq!(
        fixture.service.read().await.unwrap(),
        ReadConfigResultV1::Ready {
            config: default_config_v2(),
            content_hash: ConfigContentHash::Missing,
        },
    );

    fixture.store_exact(b"");
    assert_eq!(
        fixture.service.read().await.unwrap(),
        ReadConfigResultV1::InvalidConfig {
            detail: InvalidConfigDetailV1 {
                reason_code: ConfigValidationReasonV1::MalformedJson,
                argument_index: None,
            },
        },
    );
}

#[tokio::test]
async fn write_config_conflicts_on_exact_raw_whitespace_change() {
    let fixture = ConfigFixture::valid_existing();
    let stale = fixture.current_hash();
    fixture.rewrite_current_with_semantically_equal_whitespace();
    let changed_bytes = fixture.current_bytes();

    let result = fixture
        .service
        .write(stale, fixture.valid_config())
        .await
        .unwrap();

    assert!(matches!(
        result,
        WriteConfigResultV1::ConfigConflict {
            content_hash,
            config,
        } if content_hash == config_content_hash(Some(&changed_bytes))
            && config == fixture.current_parsed_config()
    ));
    assert_eq!(fixture.current_bytes(), changed_bytes);
}

#[tokio::test]
async fn write_config_publishes_exact_pretty_bytes_without_live_mutation() {
    let fixture = ConfigFixture::missing();
    let config = fixture.valid_config();
    let expected = encode_config_v2_pretty(&config).unwrap();

    let result = fixture
        .service
        .write(ConfigContentHash::Missing, config)
        .await
        .unwrap();

    assert_eq!(
        result,
        WriteConfigResultV1::Written {
            content_hash: Sha256Fingerprint::from_raw_bytes(&expected),
            profiles_restart_required: true,
        },
    );
    assert_eq!(fixture.current_bytes(), expected);
    assert_eq!(fixture.live_profile_mutation_calls(), 0);
}

#[tokio::test]
async fn credential_bearing_config_reports_only_reason_and_index() {
    let fixture = ConfigFixture::missing();
    let result = fixture
        .service
        .write(
            ConfigContentHash::Missing,
            fixture.valid_config_with_argument("--token=DO_NOT_LOG"),
        )
        .await
        .unwrap();
    let json = serde_json::to_vec(&result).unwrap();

    assert_eq!(
        result,
        WriteConfigResultV1::InvalidConfig {
            detail: InvalidConfigDetailV1 {
                reason_code: ConfigValidationReasonV1::CredentialBearingArgv,
                argument_index: Some(0),
            },
        },
    );
    assert!(!json.windows(b"DO_NOT_LOG".len()).any(|w| w == b"DO_NOT_LOG"));
    assert_eq!(fixture.atomic_replace_calls(), 0);
}

#[tokio::test]
async fn failed_atomic_replace_preserves_previous_config_bytes() {
    let fixture = ConfigFixture::valid_existing();
    let before = fixture.current_bytes();
    fixture.fail_next_replace(ConfigStorageError::AtomicReplaceFailed);

    let error = fixture
        .service
        .write(fixture.current_hash(), fixture.valid_config())
        .await
        .unwrap_err();

    assert_eq!(error, ConfigStorageError::AtomicReplaceFailed);
    assert_eq!(fixture.current_bytes(), before);
    assert_eq!(fixture.live_profile_mutation_calls(), 0);
}
```

Add a table-driven exact request-schema test for all ten commands: `bootstrap_host` and `read_config` accept only raw `{}`; every other command accepts only its exact recursive `snake_case` field set; camelCase aliases reject; missing and unknown fields reject; `PrepareStorageRepair` accepts `record_id` exactly for `containment_reboot`, rejects its absence there, and rejects present UUID, explicit null, or any other value for `restore|reset|adopt`. Add duplicate decoded keys at every nesting depth, including literal `"a"` versus escaped-equivalent `"\\u0061"` and duplicates inside objects nested in arrays; malformed UTF-8; BOM; unsafe numbers; exact request/response byte boundaries; lower 96 KiB StorageRepair-plan and 192 KiB complete-response caps; RequestId/body replay through all five StorageRepair commands; repair mode/record-id presence rules; dead-host-only availability; mutex `Busy` non-mutation; `Abandoned` mandatory full reconciliation before service progress; decimal strings unchanged; all five rejection mappings; complete recursive allowed-field sets for every §4.2 result; a pinned mock-runtime assertion that `tauri::ipc::Response::new(serialized_json)` resolves to the parsed JavaScript object rather than a JSON string/raw byte array; and zero standalone status/notification/safety/layout/session/recovery mutation invokes. `config_invoke.rs` also adds stale key-order conflicts; missing/current-file conflict; valid-current conflict projection; invalid-current conflict returning `InvalidConfig`; exact SHA-256 readback; 1 MiB and 1 MiB+1 file boundaries; every `ConfigValidationReasonV1`; config command input unknown/duplicate-field rejection; config response byte caps; permission/read/replace/readback storage-failure mapping; and concurrent writers proving the second writer re-reads under the one native config-write lock and conflicts rather than overwriting. The mock-runtime test must prove malformed/oversize raw invokes are rejected by the pre-dispatch guard before Tauri's typed handler counter increments.

- [ ] **Step 2: Run RED**

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'
cargo test -p termx-ui-native --test invoke_contracts -- --test-threads=1
cargo test -p termx-ui-native --test storage_invoke -- --test-threads=1
cargo test -p termx-ui-native --test config_invoke -- --test-threads=1
```

Expected: `NativeInvokeRejectionV1`, the strict request DTOs/decoder, public `Request<'_>` raw-body command wrappers, exact pre-encoded `Response` boundary, `ConfigService`, StorageRepair command adapters, and safe recursive projections are absent; `config_invoke` fails to compile on `ConfigFixture`/`ConfigService::write`, and raw-body boundary tests fail before any service call. `BootstrapHostResultV1` already exists from Task 2 and is not an expected RED cause.

- [ ] **Step 3: Implement raw-command-argument parse/validate/project adapters**

Make all ten Tauri wrappers accept only `state: tauri::State<'_, NativeAppState>` plus the pinned public `request: tauri::ipc::Request<'_>` argument and return `Result<tauri::ipc::Response, NativeInvokeRejectionV1>`. The JavaScript native client serializes each closed DTO with the strict TermX encoder and passes the resulting UTF-8 `Uint8Array` directly as the invoke body; it never passes a JavaScript object whose conversion would become `InvokeBody::Json`. Match `request.body()` as `InvokeBody::Raw`, reject every other variant, and share `decode_native_invoke(command, raw_bytes)` with direct tests. Match only the ten registered names, reject non-raw bodies, enforce the raw cap before JSON parsing or service invocation, apply the strict codec and exact command schema, then invoke one native service. Explicitly construct or strict-revalidate each §4.2 success result and enforce its domain and absolute encoded caps before returning it. `ConfigService::read` performs one exact-byte read; `ConfigService::write` holds its one write lock across fresh read/hash/parse, expected-hash comparison, shape/effective-argv validation, deterministic encode, same-directory atomic replace, and exact-byte readback/hash. It never calls the live host or changes its active profile snapshot. Map only impossible/private adapter failures and closed `ConfigStorageError` through the five-code rejection table; do not return `anyhow` debug/display text. `StorageRepairService` owns the complete recovery/preownership/ordinary/repair/ledger authority chain and retained request replay. Command handlers never acquire, release, drop, or reacquire one of those locks and never reconstruct a repair plan from a renderer result.

- [ ] **Step 4: Verify GREEN**

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'
cargo test -p termx-ui-native --test invoke_contracts -- --test-threads=1
cargo test -p termx-ui-native --test storage_invoke -- --test-threads=1
cargo test -p termx-ui-native --test config_invoke -- --test-threads=1
cargo test -p termx-ui-native --test storage_authorization -- --test-threads=1
cargo test -p termx-ui-native --test storage_journal_prefix -- --test-threads=1
cargo test -p termx-contracts --test config_v2
```

Expected: raw and typed invoke schemas are exact, config CAS is raw-byte/atomic/redacted and does not mutate the live host, StorageRepair dedup survives command boundaries, every specified success projection is byte-bounded, and no secret or unapproved internal value serializes.

- [ ] **Step 5: Commit**

```powershell
git add -- ui/src-tauri/src/commands.rs ui/src-tauri/src/invoke_types.rs ui/src-tauri/src/lib.rs ui/src-tauri/src/storage.rs ui/src-tauri/src/storage_repair.rs ui/src-tauri/tests/invoke_contracts.rs ui/src-tauri/tests/storage_invoke.rs ui/src-tauri/tests/config_invoke.rs
git commit -m "feat(tauri): expose bounded native lifecycle invokes" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Implement native shutdown and teardown-repair confirmation

**Files:**
- Create: `C:\Dev\TermX\ui\src-tauri\src\shutdown.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\src\native_dialog.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\native_shutdown.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\native_teardown_repair.rs`
- Modify: `C:\Dev\TermX\ui\src-tauri\src\commands.rs`
- Modify: `C:\Dev\TermX\ui\src-tauri\src\app_state.rs`

**Interfaces:**
- Consumes Phase 2 native-only `GetFinalizedShutdownPreparation -> FinalizedShutdownPreparation`, `AuthorizeShutdown -> ShutdownAuthorized`, `GetTeardownRepairPreparation -> TeardownRepairPreparation`, and `RepairTeardown -> TeardownRepaired`; Task 4 owns the two invoke signatures and closed rejection transport.
- Produces:
  ```rust
  pub trait NativeDialogPort: Send + Sync {
      fn confirm(
          &self,
          request: NativeConfirmationDialogV1,
      ) -> futures::future::BoxFuture<
          'static,
          Result<NativeDialogChoice, NativeDialogError>,
      >;
  }

  pub struct ShutdownCoordinator {
      transactions: tokio::sync::Mutex<
          ShutdownCoordinatorState,
      >,
      dialog: std::sync::Arc<dyn NativeDialogPort>,
  }

  #[derive(Clone, Copy, Debug, Eq, PartialEq)]
  pub enum ShutdownReleaseFailureCodeV1 {
      DeadlineExpired,
      DescendantTreeLive,
      RuntimeOwnerChanged,
      RuntimeReleaseUnverifiable,
      OrdinaryMutexStillOwned,
      OrdinaryMutexReleaseUnverifiable,
      ProcessIdentityUnverifiable,
  }

  #[derive(Clone, Copy, Debug, Eq, PartialEq)]
  pub enum ShutdownReleaseOutcome {
      Released,
      ManualInterventionRequired {
          reason_code: ShutdownReleaseFailureCodeV1,
      },
  }

  pub enum ShutdownCoordinatorState {
      Idle,
      Confirming {
          preparation_id: uuid::Uuid,
          host_instance_id: uuid::Uuid,
      },
      AuthorizedAwaitingFinalShutdown {
          confirmation_id: uuid::Uuid,
          host_instance_id: uuid::Uuid,
          process_identity: ExactProcessIdentity,
          reason: ShutdownReasonV2,
          expires_at: Timestamp,
      },
      ReleaseObserved {
          confirmation_id: uuid::Uuid,
          reason: ShutdownReasonV2,
      },
      ManualInterventionRequired {
          confirmation_id: uuid::Uuid,
          reason_code: ShutdownReleaseFailureCodeV1,
      },
  }

  impl ShutdownCoordinator {
      pub async fn confirm_shutdown(
          &self,
          authorization: ShutdownAuthorizationV1,
      ) -> Result<
          NativeShutdownAuthorizationResult,
          NativeAdapterError,
      >;

      pub async fn await_release_for_bootstrap(
          &self,
          deadline: std::time::Duration,
      ) -> ShutdownReleaseOutcome;

      pub async fn confirm_teardown_repair(
          &self,
          preparation_id: uuid::Uuid,
      ) -> Result<NativeTeardownRepairResult, NativeAdapterError>;
  }
  ```
- `NativeConfirmationDialogV1` is a closed native-only view model built solely from the exact verified host preparation: title at most 128 UTF-8 bytes, body at most 8 KiB, closed action/reason enums, affected session count, affected operation count, and bounded consequence rows. It contains no token, key, MAC, process identity, path, terminal/provider text, or caller-supplied prose. The production `TauriDialogPort` calls the pinned Rust dialog plugin's callback-based `show_with_result`, bridges the callback through one `tokio::sync::oneshot`, and maps only explicit affirmative to acceptance; negative, window close, Escape, callback loss, unknown result, and oneshot cancellation fail closed as cancel/adapter failure. Tests inject `FakeNativeDialogPort`; no WebView, Tauri event, or JavaScript callback selects the answer. Automated coordinator tests do not claim WDIO/tauri-driver can inspect or click OS-native dialog UI; Phase 8 owns Windows UI Automation or a recorded manual packaged smoke for actual focus/modality/dismissal behavior.
- Invariant: the passed authorization/preparation ID is only a lookup binding. Native Rust independently retrieves and verifies the finalized host preview/proof with the private in-memory shutdown key, displays that exact consequence set, then sends one native authorization/repair only after affirmative OS input. The coordinator reserves the transaction under its mutex, releases the Tokio guard before socket I/O or showing the OS dialog, and uses an unforgeable process-local transaction lease to prevent a competing confirmation. Re-entry reacquires the mutex and commits only when lease, host identity, preparation/authorization hash, expiry, and exact process identity still match; otherwise it invalidates the host preparation where specified and returns the closed stale/expired/ownership-lost outcome.
- Final Shutdown remains renderer-owned but outside generic `HostClient.request`: after `ShutdownAuthorized`, `confirm_shutdown` records `AuthorizedAwaitingFinalShutdown`, starts one native release observer on the retained exact process handle/runtime identity, and returns `outcome=authorized`. React then sends the dedicated correlated `Shutdown` and receives `ShutdownAccepted`. For confirmed restart, the subsequent `bootstrap_host` joins `await_release_for_bootstrap(5 seconds)` before reading recovery state or spawning; for quit, the observer still verifies exact process exit, runtime disappearance/non-ownership, and mutex release before native app teardown completes. Timeout, a live old tree, changed runtime owner, or unverifiable mutex state records `ManualInterventionRequired`; no replacement host starts. No `get_native_status`, final-Shutdown invoke, or Tauri protocol proxy is added.

- [ ] **Step 1: Write failing tamper, cancellation, and replay tests**

```rust
#[tokio::test]
async fn confirm_shutdown_retrieves_exact_finalized_preview_before_dialog() {
    let fixture = ShutdownFixture::finalized_quit().await;
    let supplied = fixture.authorization();
    let result = fixture.confirm_shutdown(supplied).await.unwrap();
    assert_eq!(
        fixture.dialog_preview_hash(),
        fixture.host_finalized_preview_hash()
    );
    let (confirmation_id, expires_at) = match result {
        NativeShutdownAuthorizationResult::Authorized {
            confirmation_id,
            expires_at,
        } => (confirmation_id, expires_at),
        other => panic!("expected authorized result, got {other:?}"),
    };
    assert_eq!(confirmation_id, fixture.host_confirmation_id());
    assert_eq!(expires_at, fixture.host_authorization_expires_at());
    assert_eq!(fixture.authorize_shutdown_calls(), 1);
    assert_eq!(fixture.final_shutdown_calls(), 0);
    assert_eq!(
        fixture.coordinator_state(),
        ShutdownCoordinatorStateView::AuthorizedAwaitingFinalShutdown
    );
}

#[tokio::test]
async fn native_cancel_sends_no_authority_and_leaves_host_alive() {
    let fixture = ShutdownFixture::finalized_quit()
        .await
        .with_dialog_cancel();
    let result = fixture
        .confirm_shutdown(fixture.authorization())
        .await
        .unwrap();
    assert!(matches!(
        result,
        NativeShutdownAuthorizationResult::Cancelled
    ));
    assert_eq!(fixture.authorize_shutdown_calls(), 0);
    assert_eq!(fixture.final_shutdown_calls(), 0);
    assert!(fixture.host_is_live().await);
}

#[tokio::test]
async fn dialog_does_not_hold_tokio_state_guard_and_reentry_is_stale() {
    let fixture = ShutdownFixture::finalized_quit()
        .await
        .with_blocked_dialog();
    let first = fixture.start_confirm_shutdown();
    fixture.wait_until_dialog_visible().await;
    assert!(fixture.native_state_lock_is_immediately_available());

    let second = fixture
        .confirm_shutdown(fixture.authorization())
        .await
        .unwrap();
    assert!(matches!(
        second,
        NativeShutdownAuthorizationResult::Stale
    ));
    assert_eq!(fixture.authorize_shutdown_calls(), 0);

    fixture.answer_dialog_affirmative();
    let first_result = first.await.unwrap();
    assert!(matches!(
        first_result,
        NativeShutdownAuthorizationResult::Authorized { .. }
    ));
    assert_eq!(fixture.authorize_shutdown_calls(), 1);
}

#[tokio::test]
async fn replacement_bootstrap_waits_for_exact_release_after_final_shutdown() {
    let fixture = ShutdownFixture::authorized_restart().await;
    fixture.renderer_sends_final_shutdown().await;
    let bootstrap = fixture.start_bootstrap();

    fixture.advance_release_clock(std::time::Duration::from_secs(4));
    assert!(!bootstrap.is_finished());
    assert_eq!(fixture.sidecar_start_calls(), 0);

    fixture.release_old_process_runtime_and_mutex();
    assert!(matches!(
        bootstrap.await.unwrap(),
        BootstrapHostResultV1::Ready { .. }
    ));
    assert_eq!(fixture.sidecar_start_calls(), 1);
}

#[tokio::test]
async fn release_timeout_never_starts_replacement() {
    let fixture = ShutdownFixture::authorized_restart().await;
    fixture.renderer_sends_final_shutdown().await;
    let bootstrap = fixture.start_bootstrap();
    fixture.advance_release_clock(std::time::Duration::from_secs(5));
    let result = bootstrap.await.unwrap();
    assert!(matches!(
        result,
        BootstrapHostResultV1::Failed {
            code:
                BootstrapHostFailureCodeV1::ManualInterventionRequired,
            retryable: false,
            ..
        }
    ));
    assert_eq!(fixture.sidecar_start_calls(), 0);
}
```

Add wrong key, tampered authorization/preview/hash, stale revision, wrong affected set, expired/replayed read nonce, expired/replayed authorization nonce, ownership loss, second consumption, duplicate/reentrant dialogs, app/window close while the dialog is active, direct bearer-only Shutdown, native-confirmed-but-no-final-Shutdown expiry, wrong final-Shutdown authorization, restart with nonterminal operation, exact five-second boundary, old descendant tree still live, runtime owner changed, mutex release unverifiable, quit release observation, repair-mode release preserving source bytes, and teardown same-boot/wrong boot/PID reuse/proof mutation tests. Tests must assert Tauri never itself emits the final renderer `Shutdown` and never starts a replacement before exact release.

- [ ] **Step 2: Run RED**

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'
cargo test -p termx-ui-native --test native_shutdown -- --test-threads=1
cargo test -p termx-ui-native --test native_teardown_repair -- --test-threads=1
```

Expected: finalized native read/MAC/dialog flow absent.

- [ ] **Step 3: Implement the trusted confirmation pipeline**

Reserve one transaction by replacing `Idle` with `Confirming` under the coordinator mutex, copy only the lease and private verified-host session into owned values, and release the Tokio guard. Require current verified host identity; use the retained shutdown key to issue the host's native finalized-read challenge/MAC; constant-time verify response identities/hash/expiry/nonces; build the closed dialog view only from verified preview fields; and await `NativeDialogPort` with no Tokio state guard held. Reacquire the mutex, validate the same lease and current host/process identity, and after affirmative input issue exactly one `AuthorizeShutdown` or `RepairTeardown`. Project only the exact §4.2 bounded result. On authorized shutdown, retain the exact process handle plus expected runtime/ownership identity in `AuthorizedAwaitingFinalShutdown` and start the release observer; do not send final `Shutdown`. Explicit cancellation calls the host invalidation path where required. Ordinary window close never calls this module, and an active dialog is the sole reason the close handler temporarily prevents close.

`HostManager::bootstrap` checks the coordinator before any discovery/recovery write. With an authorized restart it waits at most five seconds for the existing observer to prove process-tree exit plus runtime and ordinary-mutex release. Exact release clears the old secret/session, transitions to `ReleaseObserved`, and permits the existing dead-host reconstruction path. Any timeout, identity drift, live descendant, or unverifiable release returns the non-retryable `manual_intervention_required` bootstrap failure and leaves every artifact untouched. Quit uses the same observer and release proof but does not construct a recovery bootstrap or replacement host.

- [ ] **Step 4: Verify GREEN**

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'
cargo test -p termx-ui-native --test native_shutdown -- --test-threads=1
cargo test -p termx-ui-native --test native_teardown_repair -- --test-threads=1
cargo test -p termx-host --test shutdown_v2 -- --test-threads=1
cargo test -p termx-host --test teardown_repair -- --test-threads=1
```

Expected: only an exact current native-confirmed proof authorizes destructive lifecycle mutation; cancellation/tamper are non-destructive.

- [ ] **Step 5: Commit**

```powershell
git add -- ui/src-tauri/src/shutdown.rs ui/src-tauri/src/native_dialog.rs ui/src-tauri/src/commands.rs ui/src-tauri/src/app_state.rs ui/src-tauri/tests/native_shutdown.rs ui/src-tauri/tests/native_teardown_repair.rs
git commit -m "feat(tauri): authorize destructive lifecycle natively" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Add redacted audit rotation and native notifications

**Files:**
- Create: `C:\Dev\TermX\ui\src-tauri\src\audit.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\src\notifications.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\audit_rotation.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\notifications.rs`
- Modify: `C:\Dev\TermX\ui\src-tauri\src\app_state.rs`
- Modify: `C:\Dev\TermX\ui\src-tauri\src\lib.rs`

**Interfaces:**
- Consumes Phase 4 `RecoveryAuditFactV1` plus its bounded host-to-native delivery contract and closed `NativeNotificationFactV1`; this task does not accept notification title/body strings from JavaScript.
- Produces:
  ```rust
  pub trait AuditFactSource: Send + Sync {
      fn next(
          &self,
      ) -> futures::future::BoxFuture<
          'static,
          Result<Option<RecoveryAuditFactV1>, AuditSourceError>,
      >;

      fn acknowledge(
          &self,
          audit_fact_id: uuid::Uuid,
          record_sha256: Sha256Hex,
      ) -> futures::future::BoxFuture<
          'static,
          Result<(), AuditSourceError>,
      >;
  }

  pub struct RecoveryAuditWriter {
      source: std::sync::Arc<dyn AuditFactSource>,
      notifications: std::sync::Arc<NativeNotificationService>,
  }

  impl RecoveryAuditWriter {
      pub fn reconcile_startup(
          &self,
      ) -> Result<AuditStatusV1, AuditWriteError>;

      pub fn run(
          self: std::sync::Arc<Self>,
      ) -> futures::future::BoxFuture<'static, ()>;
  }

  pub struct NativeNotificationService;

  impl NativeNotificationService {
      pub fn project(
          fact: &NativeNotificationFactV1,
      ) -> Result<NativeNotificationV1, NotificationProjectionError>;

      pub fn show(
          &self,
          notification: NativeNotificationV1,
      ) -> Result<(), NativeNotificationError>;
  }
  ```
- `RecoveryAuditWriter::run` accepts one validated fact, computes the exact canonical record/hash, appends and flushes it, then acknowledges that exact `audit_fact_id` plus `record_sha256`. An acknowledgement is never sent before the protected append is durable. Redelivery of the same fact ID/hash is idempotent by scanning/retaining exact audit identities; same ID with different hash degrades. Source disconnect/reconnect does not create a second writer. This delivery contract requires an exact host/native IPC definition in the approved architecture and Phase 4; Task 6 cannot invent an unregistered WebSocket variant or named-pipe protocol locally.
- Invariant: at most five protected 8 MiB slots/40 MiB total; uncertainty enters `audit_degraded` and does not append. Phase 5 projects audit status only where the approved schema already names it: `StorageRepairExecutionResultV1.audit_status` and its retained status result. The general persistent `audit_degraded` Settings diagnostic/retry surface is part of the same architecture amendment as the host/native delivery transport; Task 6 does not add a status invoke, Tauri event, or bootstrap field locally. Notifications are initiated only from closed native facts, use the pinned Tauri 2 notification plugin from Rust, and omit full IDs and continuation/terminal/private provider text. There is no `show_native_notification` invoke.

- [ ] **Step 1: Write failing crash-prefix and redaction tests**

```rust
#[test]
fn audit_rotation_crash_prefix_retains_newest_valid_generations() {
    for prefix in AuditRotationPrefix::ALL {
        let fixture = AuditFixture::full_slots();
        fixture.crash_after(prefix);
        fixture.append(next_safe_fact()).ok();
        let reopened = fixture.reopen();
        let status = reopened.reconcile().unwrap();
        assert!(status.slot_count <= 5);
        assert!(status.total_bytes <= 40 * 1024 * 1024);
        assert!(reopened.generations_are_valid_and_monotonic());
    }
}

#[test]
fn notification_projection_omits_sensitive_fields() {
    let shown = NativeNotificationService::project(
        &sensitive_native_notification_fact(),
    )
    .unwrap();
    assert!(!shown.body.contains(
        "Continue. We accidentally terminated."
    ));
    assert!(!shown.body.contains(
        "00000000-0000-0000-0000-000000000001"
    ));
    assert!(!shown.body.contains("token-marker"));
}

#[tokio::test]
async fn audit_acknowledges_only_after_durable_append() {
    let fixture = AuditFixture::one_source_fact();
    fixture.block_active_slot_flush();
    let worker = fixture.start_writer();

    fixture.wait_until_flush_blocked().await;
    assert_eq!(fixture.source_acknowledgements(), 0);

    fixture.complete_active_slot_flush();
    worker.await.unwrap();
    assert_eq!(fixture.source_acknowledgements(), 1);
    assert_eq!(
        fixture.acknowledged_identity(),
        fixture.persisted_fact_identity()
    );
}

#[tokio::test]
async fn audit_redelivery_is_idempotent_but_conflict_degrades() {
    let fixture = AuditFixture::persisted_and_redelivered_same_fact();
    fixture.run_one().await.unwrap();
    assert_eq!(fixture.persisted_record_count(), 1);
    assert_eq!(fixture.source_acknowledgements(), 1);

    fixture.redeliver_same_id_with_different_hash();
    fixture.run_one().await.unwrap();
    assert_eq!(fixture.status(), AuditStatusV1::AuditDegraded);
    assert_eq!(fixture.persisted_record_count(), 1);
    assert_eq!(fixture.high_severity_notifications(), 1);
}
```

Add delete/rename/create/flush/ACL/header/quota failure, startup mixed-slot prefixes, exact per-slot and aggregate caps, source disconnect before delivery, disconnect after append/before ack, same-ID replay after restart, conflicting-ID/hash, source queue overflow, disabled settings, focused/unfocused behavior, persistent unknown/unrecoverable review notifications, plugin denial/failure, and exact closed notification projection caps. Tests assert the command registry remains unchanged and no renderer-provided notification string can reach the native service.

- [ ] **Step 2: Run RED**

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'
cargo test -p termx-ui-native --test audit_rotation -- --test-threads=1
cargo test -p termx-ui-native --test notifications -- --test-threads=1
```

Expected: audit writer/notification projection absent.

- [ ] **Step 3: Implement allowlist serialization and atomic slot rotation**

Do not begin this GREEN step until the Phase 4/spec gate names the exact authenticated host/native `AuditFactSource` transport, endpoint discovery, connection ownership, replay/ack identity, close behavior, and queue caps. Then implement that contract without adding a renderer-visible command or an ordinary protocol-v2 bearer message. Serialize `RecoveryAuditFactV1` only after strict contract validation; never accept arbitrary text. Protect/read back every slot. Use deterministic generation headers and the specification's delete-before-rename, metadata-only rotation with crash-prefix reconciliation. Append and flush before acknowledging; retain bounded identities sufficient to make exact redelivery idempotent. Rotation/delivery conflicts publish an in-memory native degraded state and stop further appends until verified reconciliation; they do not block host terminal traffic or rewrite StateV2. Construct native notifications from closed enum/status/reduced identity fields only and call the Rust notification adapter directly.

- [ ] **Step 4: Verify GREEN**

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'
cargo test -p termx-ui-native --test audit_rotation -- --test-threads=1
cargo test -p termx-ui-native --test notifications -- --test-threads=1
cargo test -p termx-host --test recovery_audit -- --test-threads=1
```

Expected: every prefix stays within five slots/40 MiB or safely degrades; forbidden bytes are absent.

- [ ] **Step 5: Commit**

```powershell
git add -- ui/src-tauri/src/audit.rs ui/src-tauri/src/notifications.rs ui/src-tauri/src/app_state.rs ui/src-tauri/src/lib.rs ui/src-tauri/tests/audit_rotation.rs ui/src-tauri/tests/notifications.rs
git commit -m "feat(tauri): rotate redacted recovery audit" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Build and verify the exact MSVC sidecar package

**Files:**
- Create: `C:\Dev\TermX\scripts\build-host-sidecar.ps1`
- Create: `C:\Dev\TermX\scripts\dev.ps1`
- Create: `C:\Dev\TermX\scripts\build.ps1`
- Create: `C:\Dev\TermX\scripts\verify-sidecar.ps1`
- Modify: `C:\Dev\TermX\ui\src-tauri\build.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tauri.dev.conf.template.json`
- Modify: `C:\Dev\TermX\ui\src-tauri\src\sidecar_launch.rs`
- Modify: `C:\Dev\TermX\ui\src-tauri\src\app_state.rs`
- Modify: `C:\Dev\TermX\ui\src-tauri\src\lib.rs`
- Modify: `C:\Dev\TermX\ui\src-tauri\src\test_support.rs`
- Create: `C:\Dev\TermX\ui\src-tauri\tests\sidecar_packaging.rs`
- Modify: `C:\Dev\TermX\ui\src-tauri\Cargo.toml`
- Modify: `C:\Dev\TermX\ui\src-tauri\tauri.conf.json`
- Modify: `C:\Dev\TermX\.gitignore`

**Interfaces:**
- Consumes the exact reviewed stable Tauri 2 versions frozen by Task 1 for `tauri`, `tauri-build`, `@tauri-apps/api`, `@tauri-apps/cli`, `tauri-plugin-dialog`, `tauri-plugin-notification`, and `tauri-plugin-shell`; lockfile checksums may change only through a separately reviewed dependency update. No filesystem plugin is installed, and shell capability is restricted to the configured `termx-host` sidecar with empty argv.
- Produces a closed generated `SidecarBuildDescriptorV1` at `<workspace>\target-m2\termx-sidecar\<profile>\sidecar-build-v1.json` and an exact staged external-binary source named `termx-host-x86_64-pc-windows-msvc.exe` in `C:\Dev\TermX\ui\src-tauri\binaries\` for Tauri's `bundle.externalBin` entry `binaries/termx-host`. Project tooling creates the already target-triple-suffixed source; Tauri selects that source and bundles it under the unsuffixed runtime logical name `termx-host`. Code addresses only that logical name, never an absolute path, PATH lookup, or shell command. The descriptor and generated development merge config are ignored build artifacts and are never committed.
- Produces script entrypoints:
  ```powershell
  # build-host-sidecar.ps1
  param(
      [ValidateSet('debug', 'release')]
      [string]$Profile = 'debug',
      [string]$Target = 'x86_64-pc-windows-msvc',
      [string]$CargoTargetDir
  )

  # verify-sidecar.ps1
  param(
      [ValidateSet('debug', 'release')]
      [string]$Profile = 'debug',
      [string]$Target = 'x86_64-pc-windows-msvc',
      [string]$CargoTargetDir
  )
  ```
  Omitted `CargoTargetDir` resolves to `<workspace>\target-m2`; every path derives from `$PSScriptRoot` plus `cargo metadata` and no script mutates the locked default `C:\Dev\TermX\target` tree.
- `tauri.conf.json` owns packaged `bundle.externalBin`; `tauri.dev.conf.json` is a generated project-relative merge config used only by `cargo tauri dev --config <generated path>`. Development still launches the freshly staged external binary through Tauri's shell sidecar API. `SidecarLauncher` is a narrow internal adapter whose production call is exactly `app.shell().sidecar("termx-host")?.spawn()?`; it retains the returned `(Receiver<CommandEvent>, CommandChild)` only for bounded startup diagnostics/process-control while independently querying exact Windows process start time and completing authenticated native `Preflight`. Capability grants exactly that configured binary and empty argument shape, not generic `shell:default`, arbitrary execute/spawn, or arbitrary argv. Stable Tauri does not expose the final resolved executable path or a native Windows process handle, so neither the adapter nor tests invent a `resolve_packaged_sidecar() -> PathBuf` API.
- Invariant: scripts derive the workspace root from `$PSScriptRoot`, use `cargo metadata --manifest-path <absolute workspace Cargo.toml>` for structure, and parse Cargo's JSON `compiler-artifact.executable` message from the exact host build invocation to select the emitted binary. `cargo metadata` alone is never treated as build proof. Scripts set an isolated project-relative target directory, build host and Tauri with the same target/profile, and fail when host artifact, fresh-build identity, target/profile descriptor, or protocol-major metadata is absent/mismatched. The final packaged-installer and real sidecar launch/resource proof belongs to Phase 8; Task 7 proves staging/configuration, capability validation, and a debug Tauri bundle build.

- [ ] **Step 1: Write failing packaging tests**

```rust
#[test]
fn packaged_external_bin_has_exact_target_suffix_and_wire_major() {
    let fixture = SidecarFixture::generate("x86_64-pc-windows-msvc", "release").unwrap();
    assert_eq!(fixture.external_bin_name(), "termx-host-x86_64-pc-windows-msvc.exe");
    assert_eq!(fixture.host_wire_major(), 2);
    assert_eq!(fixture.tauri_wire_major(), 2);
    assert_eq!(
        fixture.external_bin_config_entry(),
        "binaries/termx-host"
    );
    assert!(fixture.path_is_project_relative());
}

#[test]
fn pinned_tauri_sidecar_api_compiles_with_exact_capability() {
    let fixture = SidecarFixture::pinned_versions();
    fixture.compile_launcher_adapter().unwrap();
    assert_eq!(fixture.logical_sidecar_name(), "termx-host");
    assert_eq!(fixture.allowed_argument_shapes(), vec![Vec::<String>::new()]);
    assert!(!fixture.has_arbitrary_shell_permission());
    assert!(!fixture.has_filesystem_plugin());
}

#[tokio::test]
async fn sidecar_launch_never_falls_back_to_path() {
    let fixture = SidecarFixture::with_missing_bundle_and_path_decoy();
    let error = fixture.launch_configured_sidecar().await.unwrap_err();
    assert_eq!(error.code(), "packaged_sidecar_missing");
    assert_eq!(fixture.requested_logical_names(), ["termx-host"]);
    assert_eq!(fixture.path_decoy_launches(), 0);
}
```

Add missing host, wrong triple/profile, stale preexisting staged artifact, source artifact older than the current Cargo build invocation, wire-major metadata missing/mismatch, development generated-config selection, same-target assertion, paths-with-spaces, exact logical-name/suffix mapping, pinned Tauri/plugin version skew, missing or overbroad capability, forbidden arbitrary argv, and exact `bundle.externalBin` configuration tests. A script fixture sets a PATH decoy and proves neither staging nor launch resolves it.

- [ ] **Step 2: Run RED**

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'
cargo test -p termx-ui-native --test sidecar_packaging
& .\scripts\verify-sidecar.ps1
```

Expected: build scripts/build metadata and generated artifact do not exist.

- [ ] **Step 3: Implement portable same-target packaging**

Resolve the workspace by calling `cargo metadata --format-version 1 --no-deps --manifest-path (Join-Path $workspaceRoot 'Cargo.toml')`, where `$workspaceRoot` is derived from `$PSScriptRoot\..`; do not rely on the caller's working directory. Resolve or accept `CargoTargetDir`, require it to remain under the workspace for these project scripts, and set `$env:CARGO_TARGET_DIR` only for child Cargo invocations. Invoke Cargo separately for `termx-host` and the Tauri crate with the exact same `--target x86_64-pc-windows-msvc` and selected debug/release profile. The host build uses `cargo build --message-format=json-render-diagnostics`; parse the one matching `compiler-artifact` record whose package/target is `termx-host`, require a non-null `executable`, and select that exact path rather than synthesizing it from the metadata target directory. Record a generated descriptor with target/profile/protocol-major/source-artifact SHA-256/source-artifact byte length/build invocation ID. Stage with copy-to-new-sibling, flush/readback/hash, then atomic replace of `ui\src-tauri\binaries\termx-host-x86_64-pc-windows-msvc.exe`; never resolve the source or destination through PATH. Generate the dev merge config/descriptor with the same same-directory atomic discipline. `build.rs` reads only the generated descriptor and fails the Tauri build if target/profile/major/hash/length/logical-name/config are missing or inconsistent. `SidecarLauncher` calls exactly `app.shell().sidecar("termx-host")?.spawn()?` and no arguments; it does not invoke `std::process::Command`, `cmd.exe`, PowerShell, or a generic shell execution capability.

- [ ] **Step 4: Verify GREEN and close the Phase 5 gate**

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test -p termx-ui-native -- --test-threads=1
& .\scripts\build-host-sidecar.ps1 -Profile debug
& .\scripts\verify-sidecar.ps1 -Profile debug
npm --prefix ui run typecheck
npm --prefix ui run lint
npm --prefix ui run test -- --run
npm --prefix ui exec tauri build -- --debug --target x86_64-pc-windows-msvc
```

Expected: all commands exit 0; the generated sidecar has exact name/major/target/profile; Tauri builds under MSVC. Send exact diff and logs to Fable and resolve all confirmed findings before Phase 6.

- [ ] **Step 5: Commit**

```powershell
git add -- scripts/build-host-sidecar.ps1 scripts/dev.ps1 scripts/build.ps1 scripts/verify-sidecar.ps1 ui/src-tauri/build.rs ui/src-tauri/tauri.dev.conf.json ui/src-tauri/tests/sidecar_packaging.rs ui/src-tauri/Cargo.toml ui/src-tauri/tauri.conf.json .gitignore
git commit -m "build(tauri): package the exact host sidecar" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Phase 5 Acceptance Coverage

| Specification acceptance requirement | Owning task | Exact primary test |
|---|---:|---|
| Tauri resolves the same explicit/portable/AppData directory and verifies DACL | Phase 3 + 2 | Phase 3 path/ACL tests and `runtime_discovery.rs` |
| Native discovery validates exact PID/start time/token/host/data/version | 2 | `ui/src-tauri/tests/native_preflight.rs` |
| Runtime bearer token is the only secret returned to JavaScript | 2, 4 | `renderer_bootstrap_contains_token_but_never_shutdown_authority` and invoke projections |
| Shutdown key has one durable occurrence and stays trusted-Rust-only | 2, 5 | native preflight/shutdown secret-boundary tests |
| In-process concurrent launches share one in-flight result | 3 | `host_lifecycle.rs::concurrent_bootstrap_calls_share_one_discovery_and_spawn` |
| Cross-process recovery mutex and abandoned-owner reconciliation | 3 | `bootstrap_reconciliation.rs` |
| Bootstrap create/import/witness/tombstone crash prefixes | 3 | `bootstrap_reconciliation.rs` plus host Phase 2 import tests |
| Legacy protocol host is Manual-close-only and receives no Shutdown | 2 | `native_preflight.rs::legacy_host_never_receives_shutdown` |
| Live protocol mismatch leaves host/sessions untouched | 2, 3 | mismatch discovery tests |
| Dead-host StorageRepair native invokes preserve Phase 3 authority/replay | 4 | `storage_invoke.rs` plus Phase 3 suites |
| Native ConfirmShutdown independently retrieves exact finalized preview and MAC | 5 | `native_shutdown.rs` |
| Direct bearer-only Quit/Restart is rejected | 5 | `native_shutdown.rs::bearer_only_shutdown_is_rejected` |
| Native teardown repair never targets same boot/PID-reuse/wrong proof | 5 | `native_teardown_repair.rs` |
| Repair diagnostic shutdown preserves source bytes and grants no storage write | 5 | `native_shutdown.rs::repair_release_preserves_sources` |
| Ordinary window close/reload/crash sends no host shutdown | 1, 3 | `tauri_surface.rs::ordinary_close_has_no_shutdown_effect` |
| Audit/notifications contain no token/continuation/terminal/full ID/private state | 6 | audit/notification redaction tests |
| Audit rotation exact five-slot/40 MiB crash reconciliation | 6 | `audit_rotation.rs` |
| Sidecar uses exact MSVC suffix and same target/profile | 7 | `sidecar_packaging.rs` and `verify-sidecar.ps1` |
| Development/package resolution never searches PATH | 7 | sidecar resolution negative tests |
| Capabilities expose no blanket shell/filesystem and no PTY proxy invoke | 1, 4 | `tauri_surface.rs`, `invoke_contracts.rs` |
| Actual protected ACL on runtime/state/config/bootstrap/audit artifacts | Phase 3 + 2, 6 | Phase 3 ACL integration plus Phase 5 artifact tests |
