# TermX implementation status

Status checked September 9, 2026. This report separates the staged terminal improvements from the unfinished collaboration feature. It is not a release acceptance report.

| Request | Current state | Evidence and limits |
| --- | --- | --- |
| Stability fixes and original resume arguments | Implemented in the earlier application work | [Verification](../../reviews/2026-09-04-stability-and-resume-verification.md). Capture applies to verified new local launches; old uncaptured conversations cannot recover unknown arguments. Referenced settings files and environment values are not snapshots. |
| Maximize a pane, switch panes and restore splits | Implemented; included in the staged portable application | Commit `42456ca`, included in staged source `41a72fc`. |
| Shift range selection and Ctrl individual tab selection | Implemented; included in the staged portable application | [Selection behavior](../../sidebar-tab-selection.md). Selection highlights rows; it does not apply every existing action to the whole selection. |
| Minimized panes with bottom restore chips and activity indicators | Implemented and staged | [Behavior and validation](../../pane-minimize-and-status.md). Sessions keep running; the last visible pane remains visible. |
| Model, folder picker, version and update status | Implemented and staged | The same report records the idle integrated PowerShell check, exact model association, unavailable states, and release-page update action. The picker was not itself automated. Updates are not silently installed. |
| Cross-harness collaboration | Foundation implemented; integration unfinished | Runtime, durable messaging, scoped access, notice coordination, protocol and transport components have separate validation reports. No installed swarm feature, final end-to-end acceptance, or productivity result is claimed. |

The portable UI and host still match the September 8 staging receipt: UI SHA-256 `8EE06CFB36486FA68A06C56BB5588088C1FD6B9D34FF42A18E7DBA3DFC3868E6`, host SHA-256 `45E389597D53C29896ACB3AD784228BF102BF916E71EBD7067C3FC0DBC35651B`. This verifies the files on disk, not which version a currently running process has loaded. The prior staging deliberately preserved live sessions; host instrumentation needs a normal user-chosen full restart and new panes as documented.

## Reviewed collaboration checkpoints

- [Common tool mapping](2026-09-09-swarm-common-tools-validation.md): published at `34a131f`, with 276 host tests passing at that frozen checkpoint, plus documentation, formatting, strict lint and release checks. A real outgoing-page fixture contains 10 messages with 4,096 recipients each; its 8,031,440-byte shape exposed and fixed a JSON scanner work-cap mismatch.
- [MCP output](2026-09-09-swarm-mcp-output-validation.md): separately published at `d595ebf`, 76 protocol tests and three documentation tests, with strict lint/release checks. Streaming avoids extra full payload copies and keeps partial-write failures explicit.
- [Native receive bounds](2026-09-09-swarm-receive-bounds-validation.md): separately published at `5e2a70e`, 78 client tests and seven documentation tests, with strict lint/release checks. Native prefix-only tests prove oversized replies are rejected before body allocation or waiting for the body.
- [Borrowed response validation](2026-09-09-swarm-response-schema-validation.md): separately published at `78377a9`, with 11 focused tests independently rerun by root, strict focused lint, and formatting checks. Full host checks are reserved for the combined inventory integration.
- [Shared Rust chat adapter](2026-09-09-swarm-chat-adapter-validation.md): separately published at `f78fac5`. The corrected adapter matches the archived legacy implementation on 15 synthetic parity tests, independently rerun by root. Its final parser suite passed 79 tests; Tauri Rust passed 253 tests with one opt-in check ignored. Scoped formatting, strict lint and builds passed. Unrelated formatting changes were preserved and restored.

These test counts describe different components and frozen sources. They are not one combined end-to-end test run. The proof branch contains the reviewed transport, protocol, schema and parser/chat changes, while the main feature checkpoint remains `34a131f` until combined host verification.

## Active work and release gates

Three bounded GPT-5.6-SOL delegates handled the Rust chat adapter, borrowed response-schema validation, and inventory/lifecycle work. The chat and schema slices have been reviewed and published. Independent inventory re-review accepted the liveness, directory-permission and cancellation corrections in frozen v2. Root reviews changes and owns Git integration. Existing Grok work and interrupted-run evidence have been retained and resumed by SOL. Fable and Grok are not active delegates in this run. The earlier interrupted workers are not represented as continuous overnight execution.

The chat native-status mismatch and inventory pending-I/O error path have been corrected with focused evidence. Inventory v2 checks retained shell liveness after the final asynchronous checks, accepts safe inherited directory permissions, and discards the exact connection when an inventory request is cancelled or times out. Its focused unit (13), lifecycle (2), and native integration (15, plus one ignored helper) tests passed. Root reconciled all nine frozen source files and 50 retained evidence files; independent re-review found those three boundaries correctly closed.

**Inventory integration is blocked by an ordinary-host startup regression.** Secure publication is currently mandatory before the ordinary host signals readiness. Consequently, a rejected data-root ACL or stale legacy runtime record can stop the whole terminal host, rather than merely make swarm inventory unavailable. Root's broader native test run on the frozen inventory branch returned exit 101: 192 passed, 27 failed, one ignored; the 27 server tests failed at startup through their shared inherited-ACL fixture. Cargo stopped at the library failure, so later targets did not run. Source review separately confirmed the stale pre-upgrade record path. Changing all test folders to private folders would not resolve the production compatibility problem. Startup compatibility needs a reviewed correction before inventory integration or the combined final matrix.

The diagnostic logs are retained in the inventory worktree at `retired/test-artifacts/host/task-4a1-inventory-20260908T2316018927803Z/root-v2-review-20260909T0854Z/20260909T085020173466Z-startup-regression`. The command manifest's actual UTC timestamps are authoritative. This failed diagnostic is not the prepared combined host test/lint/release run, which has not started. No failing inventory code has been integrated into the proof branch or staged portable application.

The remaining product work is verified live harness enrollment and common helper dispatch, authorized recorded-context sharing, native wake-up and restart recovery, the Connect agents UI, and sustained tests against the integrated current implementation. Shared app-server sessions remain unavailable until a separately verified per-thread adapter exists. The initial native feasibility experiments do not establish compatibility with every custom harness/model route.

The earlier durable-core soak tested an older revision. The current integrated RPC soak and controlled comparison of solo versus collaborating sessions have not run. There is no evidence yet supporting a claim that this feature improves productivity.

The GitHub pre-swarm backup remains `backup/pre-swarm-2026-09-08` at `41a72fc28936fe9a1f4c4b6b4458cb7225225657`. Superseded source and failed test artifacts are retained. The swarm work has not replaced the portable application or restarted production terminal sessions.
