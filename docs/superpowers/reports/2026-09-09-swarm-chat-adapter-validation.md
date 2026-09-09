# Shared parser: Rust chat adapter checkpoint

Claude chat now consumes the shared owner parser while preserving the prior chat presentation and state handling. Tauri retains the 32 pending-prompt and 512 open-tool limits, queue-echo matching, tool completion across batches, display IDs/timestamps, presentation limits, and withholding of a final record until its newline arrives.

The owner parser adds native body origin/type, block kind, text availability, and field-specific tool metadata. These facts keep chat's stricter nested-content and native-tool rules separate from the existing broader transcript parser. `native_is_error` is distinct from the broader result status: a recorded `status:"failed"` alone cannot change the old chat result to Error. Record-level raw tool results remain shared through one `Arc<Value>`.

The only new dependency edge is Tauri's pure `termx-swarm-context` path dependency with default features disabled. The owner parser and local chat DTO do not grant peer access or export private reasoning as peer context. This slice does not implement the TypeScript transcript adapter, native source/index authorization, harness enrollment or wake-up.

The test-only oracle is extracted from the archived 52,800-byte pre-adapter `chat_feed.rs`, SHA-256 `d981f55933f02889cac60abe93cf1d98c260c31716591ef1bd6431b32cc68bf5`. Root independently compared the normalizer and presentation helper algorithms after rustfmt/class renaming: they match. New comparisons use synthetic inputs, not copied user history. Genuine behavioral REDs caught native block-filter and error-status regressions, and both are corrected.

Final checks on the frozen source:

- Exact legacy parity: 15 tests passed, also rerun independently by root with native exit 0 at 08:34 UTC on September 9.
- Shared parser: 79 tests and three documentation tests passed; strict all-target Clippy, scoped rustfmt and release build passed.
- Tauri Rust: 253 tests passed and one opt-in check ignored; documentation command, strict all-target Clippy and debug build passed.

An overly broad formatting command touched unrelated files. Their changed bytes were retained before restoration. Root verified that all 42 audited unrelated/generated files exactly match base HEAD, and staged only the eight intended source/dependency/test files plus this report. No TypeScript files or application binaries were changed.

Evidence root: `retired/test-artifacts/swarm-context/task-5-phase-b2-resume-20260909T080000Z` in the parser worktree. Frozen manifest: `final-freeze-v2/manifest.json`, SHA-256 `2936c79c0346250e6639539e9a728efa2a096882267fa1211044f78d2fc370fc`. Root reconciled ten frozen source/report inputs, 38 command records with their logs, 42 restoration entries and two built artifacts. Root readback, fresh parity output and exact oracle comparison are retained in `root-review-20260909T0836Z`.

Artifacts: parser rlib 1,240,696 bytes, SHA-256 `4102a217ef2467b675655fe929d54042a790b2016ad576e27ce87cf01b542cf9`; Tauri debug exe 19,378,688 bytes, SHA-256 `86b605151be1eb958b7198e6c572973854d2d9c24b5ac46cf584a21739d02f47`. Neither was installed or launched. This checkpoint completes the Rust chat extraction, not the collaboration feature or all context work.
