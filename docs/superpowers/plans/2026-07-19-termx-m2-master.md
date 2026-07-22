# TermX Milestone 2 Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a packaged Windows Tauri desktop terminal whose disposable React renderer connects directly to the detached Rust host, preserves live shells across UI loss, provides durable session/layout/settings behavior, and performs safety-gated managed recovery only after confirmed host death.

**Architecture:** The detached `termx-host.exe` remains the sole owner of ConPTY sessions, output rings, lifecycle sequencing, layout/safety revisions, and durable live state. A thin Tauri 2 Rust process owns native discovery, host start/release, ACL and storage-repair authority, confirmation dialogs, notifications, and packaging; React owns the authenticated loopback WebSocket, canonical snapshot/event reduction, xterm.js, layout UX, settings UX, and recovery coordination. Because the approved specification spans independently testable safety, protocol, storage, native, renderer, and release subsystems, this master plan sequences eight focused phase plans rather than one unreviewable implementation document.

**Tech Stack:** Rust 2021 on `x86_64-pc-windows-msvc`; Tokio; tokio-tungstenite; portable-pty; Windows Job/process/named-pipe/ACL APIs through `windows-sys`; Tauri 2; React; TypeScript; Vite; xterm.js; Vitest; React Testing Library; ESLint; PowerShell 5.1 build and verification scripts.

## Global Constraints

- The approved design is `C:\Dev\TermX\docs\superpowers\specs\2026-07-18-termx-m2-ui-shell-design.md`, approved on exact pending-status SHA-256 `faddcb3f6f0e476d6bff2f6d163eb1f4b049f926890eb9d5d2648b1cd8009a33` and committed with approved-status SHA-256 `1569d3d40d6bd3d6073113e905c20e2a28b5b5dfd0e9f759cdf0f198dcb74096`.
- Work exclusively from `C:\Dev\TermX`; project source, configuration, and scripts derive paths at runtime and never embed machine-specific absolute paths.
- Use the Windows MSVC target. Use an isolated target directory such as `$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'` for verification so the protected locked `C:\Dev\TermX\target\debug\termx-host.exe` is never touched.
- Do not terminate PID 54876. Do not delete `C:\Dev\TermX\target-review` or `C:\Dev\TermX\target-review-final`.
- No destructive repository reset, state reset, or migration command is permitted during implementation. Storage reset behavior is exercised only in temporary test directories.
- TDD is mandatory: write one focused test, run it and observe the intended RED failure, implement the minimum production change, rerun focused and adjacent tests GREEN, then commit.
- Every meaningful implementation chunk is sent to Fable 5 with its exact diff and test output. Main-agent review supplements but never replaces Fable review.
- Renderer disconnect, reload, crash, and ordinary window close never send `Shutdown` or implicit `CloseSession`.
- The detached host remains the sole live writer of `StateV2`. Tauri writes host state only through the approved dead-host `StorageRepair` state machine.
- React owns the ordinary authenticated WebSocket. Tauri never proxies PTY input/output or canonical live session state.
- Protocol mismatch leaves a verified live host and all sessions untouched. Automatic protocol-major restart is disabled.
- UI-crash recovery is reconnect/resnapshot/reattach only. It never creates a recovery operation, launches a provider, or submits continuation text.
- Confirmed-dead-host reconstruction defaults to Reviewed. Plain Claude Code and Codex CLI remain Manual/Reviewed only.
- Unattended recovery requires exact conversation identity, qualified structured readiness, and qualified structured acceptance.
- Continuation delivery is at-most-once. `submitting` ambiguity becomes `unknown` and is never resent.
- All wire `u64` values are decimal strings and decode to TypeScript `bigint`; bounded session IDs and dimensions remain JSON numbers.
- Host authoritative ring: default 4 MiB/session and maximum 8 MiB/session. Replay chunks are at most 512 KiB decoded and remain below the 1 MiB WebSocket frame/message limit after JSON/base64 encoding.
- Renderer pending decoded output is capped at 3 MiB. xterm visible plus scrollback text is capped at 16 MiB plus one 256 KiB measurement interval and configured for at most 10,000 lines.
- Pending correlated requests are capped at 1,024 entries and 2 MiB.
- Application JSON caps are exact: complete `AuthOk`/`State` payload at most 4 MiB and `Sessions` payload at most 1 MiB.
- Provider `InputRecipe` payload is 1..=262,139 bytes before atomic priority-queue admission.
- Preserve secrets: runtime bearer token and shutdown authority key live only in the protected runtime discovery file; the shutdown key never crosses into React, WebSocket payloads, config, state, recovery documents, or audit.
- Do not infer provider conversations using `--continue`, `--last`, picker selection, screen scraping, prompt parsing, or private provider state.
- Claude Code qualification baseline is 2.1.214 and must prove exact `--session-id <uuid>` plus `--resume <same uuid>` behavior. Codex CLI qualification baseline is 0.144.4 and must prove exact `codex resume <registered-id-or-unique-name>` behavior.
- PowerShell 5.1 commands use separate statements, not `&&`, `||`, or ternary syntax.
- ConPTY test output is redirected to a file rather than piped, because child handle inheritance can wedge pipelines.
- Every implementation commit ends with `Co-Authored-By: Claude <noreply@anthropic.com>`.

---

## Locked File and Crate Structure

The implementation may refine internal helper names during RED/GREEN work, but it must preserve these responsibility boundaries and may not collapse protocol, storage, recovery, terminal, and layout logic into oversized files.

### Workspace and narrow shared Rust contracts

- `C:\Dev\TermX\Cargo.toml` — workspace members `crates/termx-canonical`, `crates/termx-contracts`, `crates/termx-data-security`, `crates/termx-paths`, `host`, and `ui/src-tauri`.
- `C:\Dev\TermX\crates\termx-canonical\` — leaf crate for strict UTF-8/BOM/duplicate/non-finite rejection, RFC 8785/JCS bytes and SHA-256, decimal-string scalars, and independent conformance tests; no filesystem, Windows, Tokio, Tauri, or domain schemas. Created first in Phase 1 before host process/storage records consume it.
- `C:\Dev\TermX\crates\termx-contracts\` — pure closed serde types and validation under `protocol`, `layout`, `config`, `storage`, `safety`, and `recovery`; depends on canonical helpers but owns no I/O, locks, processes, WebSockets, or Tauri commands. Created first in Phase 1 and extended only by reviewed closed-schema changes.
- `C:\Dev\TermX\crates\termx-data-security\` — Windows-only protected DACL apply/verify/readback and local ACL observations; depends on `windows-sys`, not `termx-contracts`, Tokio, or Tauri.
- `C:\Dev\TermX\crates\termx-paths\` — pure shared explicit/portable/AppData path resolution; ACL code receives an already-resolved path.
- `C:\Dev\TermX\fixtures\canonical\*.json` — cross-language canonical bytes and hashes checked by Rust and Vitest.
- `C:\Dev\TermX\fixtures\argv\*.json` — Windows argv and credential-classifier vectors.
- Human-editable `config.json` uses its separate exact two-space/LF/trailing-newline serializer and raw-byte fingerprint; it is not serialized as JCS merely because `ConfigV2` is a shared contract.

### Detached host

- Existing modules remain focused: `config.rs`, `paths.rs`, `profiles.rs`, `protocol.rs`, `registry.rs`, `ring.rs`, `server.rs`, `session.rs`, `main.rs`.
- Add `host/src/atomic_state.rs` — atomic primary/backup persistence and committed candidate installation.
- Add `host/src/events.rs` — global lifecycle event hub and cursor.
- Add `host/src/job.rs` — exact process handles, creation `FILETIME`, Job Object configuration, assignment, accounting, and teardown.
- Add `host/src/containment.rs` — durable unregistered containment and session teardown ownership records.
- Add `host/src/receipts.rs` — durable session-creation receipts, request fingerprints, and pruning.
- Add `host/src/safety.rs` — safety-state CAS, confirmations, kill switch, operation transitions, retention.
- Add `host/src/recovery/mod.rs`, `records.rs`, `operations.rs`, `adapters.rs`, `argv.rs`, `bridge.rs`, `evidence.rs`, `audit.rs` — managed provider and structured recovery implementation. Provider command construction exists only here, never in React or Tauri.
- Add focused integration tests under `host/tests/` for protocol v2, lifecycle, containment, receipts, recovery, structured bridge, ACL, audit, and soak support.

### Thin Tauri native bridge

- `C:\Dev\TermX\ui\src-tauri\src\host_lifecycle.rs` — resolve/discover/preflight/start/wait-release lifecycle state machine.
- `C:\Dev\TermX\ui\src-tauri\src\storage.rs` — config CAS plus native dead-host storage classification/repair.
- Add `storage_repair.rs`, `native_auth.rs`, `shutdown.rs`, `notifications.rs`, and `mutex.rs` so storage, confirmation, and lock authority do not accumulate in one file.
- Tauri exposes typed invoke commands only. It does not expose the shutdown key or proxy WebSocket frames.

### React/TypeScript renderer

- `ui/src/host/protocol.ts` — closed runtime validators and TypeScript wire types.
- `ui/src/host/HostClient.ts` — WebSocket, handshake, correlation, byte caps, reconnect.
- `ui/src/host/hostReducer.ts` — authoritative snapshot plus contiguous-event reduction.
- `ui/src/host/HostProvider.tsx` — integration/selectors/actions.
- `ui/src/terminal/OutputWriteQueue.ts`, `TerminalController.ts`, `TerminalView.tsx` — one visible xterm, replay suppression, offsets, bounded queues.
- `ui/src/layout/layoutSchema.ts`, `layoutReducer.ts`, `layoutPersistence.ts` — stable-tab/group schema, semantic operations, debounce/CAS/rebase.
- `ui/src/sessions/*` — sidebar presentation and actions consuming canonical host/layout state.
- `ui/src/settings/SettingsDrawer.tsx` — profile-config CAS and safety-state controls.
- `ui/src/recovery/recoveryTypes.ts`, `RecoveryCoordinator.ts`, `RecoveryReview.tsx`, `providerAdapters.ts` — renderer coordination and capability display only. `providerAdapters.ts` never constructs executable paths, argv, secrets, evidence, or provider commands.

### Scripts and verification artifacts

- `scripts/dev.ps1` — same-target host build, generated project-relative dev sidecar config, Tauri dev launch.
- `scripts/build.ps1` — same-target release host build, exact target-suffixed Tauri external binary staging, package build.
- `scripts/verify.ps1` — isolated-target Rust gates plus npm/Tauri gates.
- `scripts/soak.ps1` — 30-minute two-run memory/process scenario and JSON/CSV artifact generation.
- `ui/tests/desktop/*.spec.ts` — packaged desktop lifecycle checks.
- `artifacts/m2-soak/` remains ignored/generated; scripts derive it from the project root.

---

## Phase Dependency Graph

```text
Phase 1: canonical contract freeze + host safety prerequisites
   -> Phase 2: protocol v2 + committed StateV2/event/layout/receipt semantics
      -> Phase 3: shared data security + ownership + native StorageRepair
         -> Phase 4: host managed recovery + provider/bridge/at-most-once journal
            -> Phase 5: Tauri lifecycle/native bridge/sidecar packaging
               -> Phase 6: React transport/store/xterm/reconnect
                  -> Phase 7: sidebar/layout/settings/recovery UX
                     -> Phase 8: packaged E2E/soak/release verification
```

Permitted implementation parallelism after closed interfaces exist:

- In Phase 2, event-hub internals, protocol codecs, and layout-domain tests may be prepared in parallel, but they merge only after the shared state/commit API is green.
- After Phase 3 schemas are fixed, Tauri lifecycle tests, host profile discovery, and React protocol validators may be developed in parallel.
- After `HostProvider` is green, terminal, sidebar/layout, and settings presentation may be developed in parallel.
- Recovery UI types/review presentation may be developed against frozen schemas, but `RecoveryCoordinator` may not perform actions until the Phase 4 host commands and Phase 5 native bootstrap/release paths are live.
- One recovery operation always serializes launch, resume, structured bridge, continuation admission, acceptance, and completion. Separate operations may run concurrently only within `max_parallel_recoveries`, default 1.

Hard runtime barriers:

1. Protected data-directory verification precedes runtime credential publication.
2. Native authenticated preflight precedes returning host bootstrap to React.
3. `AuthOk` snapshot installation precedes event reduction and UI readiness.
4. Profile qualification and immutable binding precede session/provider process creation.
5. Recovery bootstrap import acknowledgement/reconciliation precedes reconstruction.
6. Durable begin-attempt commit precedes every external action.
7. Durable exact action result precedes the next recovery edge.
8. Structured bridge cleanup reaches durable `closed` before operation completion or affected session close.
9. Native shutdown authorization and exact old-host release precede replacement bootstrap/start.

---

## Phase Plans

### Phase 1 — Host safety prerequisites

Plan: `C:\Dev\TermX\docs\superpowers\plans\2026-07-19-termx-m2-phase-1-host-safety.md`

Deliverables:

- Freeze strict canonical helpers and closed shared contract schemas before any host safety consumer.
- Reproduce and fix committed-state snapshot isolation.
- Add deterministic failure/barrier injection.
- Replace unsafe post-spawn setup with an exact RAII containment guard.
- Add exact process-handle/creation-time and Job Object ownership.
- Persist/reconcile unregistered containment and two-phase close/graveyard state.
- Keep process waits and destructive calls outside commit/registry/persistence locks.

Exit gate: focused safety tests, existing M1 host suite, and real-Windows containment tests are green before any UI/Tauri production code is introduced.

### Phase 2 — Protocol v2 and durable host domains

Plan: `C:\Dev\TermX\docs\superpowers\plans\2026-07-19-termx-m2-phase-2-host-protocol-state.md`

Deliverables:

- Closed protocol-v2 handshake, decimal `u64`, request IDs, structured errors, limits.
- Global lifecycle event cursor and authoritative `AuthOk`/`GetState` snapshots.
- Ordered chunked replay, `Attached`, bounded byte queues, lag resnapshot.
- Atomic `StateV2` primary/backup persistence.
- Revisioned layout and safety CAS.
- Durable creation receipts/request reconciliation and shutdown transactions.
- Runtime profile discovery plus shared pure ConfigV2 parsing/validation, deterministic pretty bytes, raw-byte content hashes, default config, and credential-bearing argv rejection consumed unchanged by Phase 5.

### Phase 3 — Storage ownership, ACL, and native repair

Plan: `C:\Dev\TermX\docs\superpowers\plans\2026-07-19-termx-m2-phase-3-storage-native-repair.md`

Deliverables:

- Reuse the Phase 2 canonical/contracts crates and add narrow shared path/data-security crates.
- Protected DACL and exact file/directory identity.
- Ownership/preownership/ordinary/recovery mutex classification.
- Native-only preview/confirm/execute/cancel/status StorageRepair flow.
- Authorization ledger, crash-prefix journal, quarantine identity, deterministic reset/restore/adopt/containment-reboot.
- Diagnostic-only repair listener and reboot-gated containment repair.

### Phase 4 — Managed recovery host engine

Plan: `C:\Dev\TermX\docs\superpowers\plans\2026-07-19-termx-m2-phase-4-managed-recovery.md`

Deliverables:

- Recovery records, immutable bindings, canonical previews, operation construction and transition table.
- Claude/Codex qualification plus exact initial/resume identity behavior.
- Manual/Reviewed/Unattended eligibility and reviewed no-bridge/structured edges.
- Kill-switch action gate and durable external-action attempts.
- Structured named-pipe bridge, Job containment, Windows argv/environment encoding, authenticated evidence.
- At-most-once continuation, acceptance, audit, notifications, retention.

### Phase 5 — Tauri native shell and packaging

Plan: `C:\Dev\TermX\docs\superpowers\plans\2026-07-19-termx-m2-phase-5-tauri-native-shell.md`

Deliverables:

- Promote the headless `termx-ui-native` library created in Phase 3 into the Tauri 2 application, then add the Vite/React workspace scaffold after host prerequisites are green.
- Exactly ten release invokes: `bootstrap_host`, `read_config`, `write_config`, `confirm_shutdown`, `confirm_teardown_repair`, `prepare_storage_repair`, `confirm_storage_repair`, `execute_storage_repair`, `cancel_storage_repair`, and `get_storage_repair_status`.
- Native notification delivery is internal Rust-only; no notification invoke exists. Repair/open-folder/export guidance uses approved read-only OS/plugin integrations only after exact paths are native-resolved, and adds no generic filesystem, shell, protocol, status, or mutation invoke.
- No PTY/WebSocket proxy and no shutdown-key renderer exposure.
- Exact sidecar target staging and restrictive CSP/capabilities.
- Portable PowerShell dev/build/verify scripts.

### Phase 6 — React transport and terminal

Plan: `C:\Dev\TermX\docs\superpowers\plans\2026-07-19-termx-m2-phase-6-react-transport-terminal.md`

Deliverables:

- Runtime-validated protocol types and cross-language canonical fixtures.
- Authenticated direct WebSocket client with correlation, bounds, mismatch behavior, reconnect.
- Canonical snapshot/event reducer and provider.
- One visible xterm controller, replay-generated-reply suppression, offset overlap/gap handling, write queues, WebGL fallback, memory measurement.
- UI loss never triggers host/session destruction.

### Phase 7 — Desktop UX, layout, settings, and recovery review

Plan: `C:\Dev\TermX\docs\superpowers\plans\2026-07-19-termx-m2-phase-7-desktop-ux-recovery.md`

Deliverables:

- Stable tabs/groups/layout schema and semantic reducer.
- Sidebar search/actions, dead/closing/uncertain states, create/duplicate/close.
- Debounced layout CAS/rebase/undo.
- Settings drawer for profile config and safety settings.
- Recovery coordinator and mandatory preview/review flows with honest capability restrictions.
- Explicit restart/quit native-confirmation UX.
- Keyboard/focus/reduced-motion/non-color accessibility.

### Phase 8 — Packaged verification and release gate

Plan: `C:\Dev\TermX\docs\superpowers\plans\2026-07-19-termx-m2-phase-8-release-verification.md`

Deliverables:

- Cross-language fixtures and full Rust/TypeScript/Tauri validation matrix.
- Packaged lifecycle, UI crash survival, relaunch replay, protocol mismatch, recovery, storage repair, ACL, process cleanup.
- Two-run 30-minute soak with enforced memory and queue thresholds.
- Documentation/backlog updates.
- Fable high-effort review of every meaningful chunk and the final integrated diff.

---

## Acceptance Anchor Ownership

| Anchor | Owning phase | Primary test files |
|---|---:|---|
| `[M2-TST-UNREGISTERED-CONTAINMENT-PREFIX]` | 1 | `host/tests/containment_prefix.rs`, `host/tests/e2e.rs` |
| `[M2-TST-EXACT-HANDLE-FIRST]` | 1 | `host/tests/job_exact_handle.rs` |
| `[M2-TST-WIN32-MASKS-INHERITANCE]` | 1 | `host/tests/job_win32_contract.rs` |
| `[M2-TST-PROFILE-ARGV-SECRETS]` | 2 and 4 | `host/tests/profile_argv.rs`, `host/tests/recovery_adapters.rs`, `ui/src/host/protocol.test.ts` |
| `[M2-TST-STORAGE-OWNERSHIP-CLASSIFICATION]` | 3 | `ui/src-tauri/tests/storage_ownership.rs` |
| `[M2-TST-STORAGE-BOTH-INVALID-NATIVE]` | 3 | `ui/src-tauri/tests/storage_repair.rs` |
| `[M2-TST-STORAGE-JOURNAL-CRASH-PREFIX]` | 3 | `ui/src-tauri/tests/storage_journal_prefix.rs` |
| `[M2-TST-STORAGE-AUTH-REPLAY]` | 3 | `ui/src-tauri/tests/storage_authorization.rs` |
| `[M2-TST-STORAGE-QUARANTINE-IDENTITY]` | 3 | `ui/src-tauri/tests/storage_quarantine.rs` |
| `[M2-TST-STORAGE-PIPE-BOOTSTRAP-ORDER]` | 4 | `host/tests/structured_bridge_win32.rs` |
| `[M2-TST-STORAGE-REPAIR-BRANCHES]` | 3 | `ui/src-tauri/tests/storage_repair_branches.rs` |
| `[M2-TST-STORAGE-DIRECTORY-IDENTITY]` | 3 | `crates/termx-data-security/tests/windows_identity.rs`, `ui/src-tauri/tests/storage_directory_identity.rs` |
| `[M2-TST-STORAGE-INIT-VS-RESET]` | 3 | `ui/src-tauri/tests/storage_init_reset.rs`, `host/tests/storage_startup.rs` |
| `[M2-TST-STORAGE-AUTH-LEDGER]` | 3 | `ui/src-tauri/tests/storage_ledger.rs` |
| `[M2-TST-REVIEWED-NOBRIDGE]` | 4 and 7 | `host/tests/recovery_reviewed.rs`, `ui/src/recovery/RecoveryCoordinator.test.ts` |
| `[M2-TST-REVIEWED-STRUCTURED-EDGE]` | 4 and 7 | `host/tests/recovery_structured.rs`, `ui/src/recovery/RecoveryCoordinator.test.ts` |
| `[M2-TST-ARGV-CANONICAL-WIN32]` | 4 | `host/tests/windows_argv.rs`, `fixtures/argv/*.json` |
| `[M2-TST-RECEIPT-PRUNE-PRECEDENCE]` | 2 | `host/tests/receipt_reconciliation.rs` |

Every unlabelled acceptance bullet in specification sections 18.1–18.5 is mapped in the corresponding phase plan’s coverage table. The 18 anchor identifiers are not the complete test matrix.

---

## Standard Task Rhythm

Every implementation task in every phase uses this sequence:

1. **Write a focused failing test.** Existing defects require behavioral RED assertions with deterministic barriers/failure injectors, not merely compile failures. New APIs may begin with a compile failure, followed by a behavioral test before commit.
2. **Run RED.** Record the exact command and expected failure text/condition. An infrastructure error is not an acceptable RED result.
3. **Implement the minimum behavior.** State the lock order, durable boundary, observable failure outcome, and forbidden shortcut.
4. **Run GREEN.** Run the focused test and an adjacent regression target. Redirect real ConPTY output to a file rather than piping it.
5. **Review and commit.** Inspect the exact diff, obtain Fable review for meaningful chunks, stage only named paths, and commit with the required trailer.

Common verification environment used by phase plans:

```powershell
Set-Location 'C:\Dev\TermX'
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'
$env:RUST_BACKTRACE = '1'
```

Common Rust commands:

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test -p termx-canonical
cargo test -p termx-contracts
cargo test -p termx-paths
cargo test -p termx-data-security -- --test-threads=1
cargo test -p termx-host --lib
cargo test -p termx-host --tests -- --test-threads=1 *> (Join-Path $PWD 'target-m2\host-tests.log')
```

Common UI commands after Phase 5 creates `ui/package-lock.json`:

```powershell
Set-Location 'C:\Dev\TermX\ui'
npm ci
npm run typecheck
npm run lint -- --max-warnings=0
npm run test -- --run
```

Common package command:

```powershell
Set-Location 'C:\Dev\TermX'
& (Join-Path $PWD 'scripts\build.ps1') -Target 'x86_64-pc-windows-msvc' -Profile 'release'
```

---

## M1 Behavior That Must Not Leak into M2

- `Registry::set_layout` currently installs a candidate before persistence. Phase 1 replaces this with persist-then-install committed-state isolation.
- Current persistence snapshots independently locked fields. Phase 2 replaces it with one validated complete `StateV2` candidate under the declared commit/persist ordering.
- Current `Session::spawn` has no complete post-spawn RAII guard. Phase 1 makes every setup prefix cleanup-proven or durably uncertain.
- Current process cleanup can fall back to generic child kill/tree walking. M2 destructive action requires exact retained handles plus creation-time identity and proven Job ownership; PID-only targeting is forbidden.
- Current channels are bounded by item count rather than exact byte accounting. Protocol v2 queues enforce both item and byte caps.
- Current attach has no `Attached` acknowledgement and lifecycle emission is attachment-local. Phase 2 introduces ordered replay/attach and one global event sequence.
- Current tests use sleeps in places where M2 requires exact crash-prefix/barrier proof. New safety tests expose deterministic barriers and injectable persistence/process boundaries.
- Current runtime/state writes do not prove the approved DACL/identity contract. Phase 3 verifies security before credential or state publication.
- Current client `Shutdown` behavior is not an ordinary renderer-close path. Phase 5/7 permit it only after the complete prepared/native-authorized transaction.

---

## Master Completion Checklist

- [ ] Phase 1 gate completed and Fable-approved before UI/Tauri production scaffolding.
- [ ] Phase 2 protocol/state gate completed and Fable-approved.
- [ ] Phase 3 storage/security/native-repair gate completed and Fable-approved.
- [ ] Phase 4 managed-recovery engine gate completed and Fable-approved.
- [ ] Phase 5 Tauri lifecycle/package gate completed and Fable-approved.
- [ ] Phase 6 transport/terminal gate completed and Fable-approved.
- [ ] Phase 7 desktop UX/recovery-review gate completed and Fable-approved.
- [ ] Phase 8 full automated, packaged, real-render, process, and soak verification completed.
- [ ] Final exact integrated diff receives Fable’s uncontradicted implementation approval.
- [ ] No confirmed review finding remains unresolved unless Michael explicitly accepts it with recorded rationale.
