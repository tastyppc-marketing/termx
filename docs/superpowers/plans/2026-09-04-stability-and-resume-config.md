# Stability and conversation resume implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans task by task. Track completion below.

**Goal:** Fix the three reproduced stability defects and preserve original conversation launch options on resume.

**Architecture:** A request deadline retires its exact transport so queued commands cannot run after failure. Layout persistence retains unsaved state for reconnection. Window synchronization applies changes relative to their base and preserves outstanding local edits while receiving authoritative updates. Resume commands carry validated structured launch arguments with shell-appropriate quoting.

**Tech stack:** TypeScript, React, Vitest; Rust/Tauri native metadata where needed.

**Spec:** `docs/reviews/2026-09-04-stability-review.md` and the user's request to restore conversation launch configurations.

## Constraints and backup

- GitHub backup was completed BEFORE source changes: private `tastyppc-marketing/termx`, `backup/pre-stability-2026-09-04`, SHA `d5699c30bb39565a5717f8ad0dfc2d1cd2d17199` (verified against remote).
- Work in the existing checkout on `fix/stability-and-resume-config`. This keeps the user's installed dependencies and working directory intact; no worktree is needed.
- Preserve host sessions on UI transport recovery; never automatically repeat a timed-out session command.
- Preserve independent changes across windows; reject conflicting structural changes explicitly rather than publishing an invalid layout.
- No dependency additions unless evidence requires them. Keep persisted layout v3 compatible.
- Resume must not replay the initial prompt, a pipeline, redirection, or arbitrary shell code. Existing conversations can only recover options for which metadata exists.
- User already authorized the fixes and added resume-config support. Continue without additional implementation approval.

## Task 1: retire a stalled request transport

**Files:** `ui/src/host/reconnect.ts`, relevant tests in `ui/src/host/__tests__/`.

**Contract:** On `REQUEST_TIMEOUT_MS`, reject the timed-out call, close that exact client, reject/drain its queued requests and attachments, and enter ordinary reconnect backoff. A deadline belonging to an old connection must not retire a replacement. No queued command from the old client can later be sent. A command already sent may have executed; timeout reporting must not promise it was cancelled.

- [x] Add a regression using real HostClient over a controlled WebSocket: hold GetState; queue CloseSession; expire the deadline; deliver late State; assert CloseSession was never transmitted and a replacement connection can answer a fresh request.
- [x] Add lifecycle coverage for disposal, queued requests, and a deadline associated with an obsolete client.
- [x] Run the new tests against old code and record the expected failure.
- [x] Implement timeout retirement guarded by client identity. Handle synchronous request callback throws without leaking timers.
- [x] Update the previous test asserting a timed-out request leaves the connection intact; that behavior is the diagnosed defect.
- [x] Run reconnect/client tests and TypeScript checking. Report evidence for review.

## Task 2: keep failed layout saves available for recovery

**Files:** `ui/src/workspace/LayoutPersistence.ts`, bootstrap reconnect wiring, persistence and workspace tests.

- [x] Add failing tests showing exhausted saves survive an explicit retry and that a real workspace reconnect saves an offline edit.
- [x] Retain the newest failed snapshot separately from actively pending work; expose a retry method invoked by the reconnect handler.
- [x] A newer record supersedes failed state. `flush()` drains active attempts and returns even while offline; retry exhaustion cannot produce a busy loop.
- [x] Cover disposal and a newer change arriving during a failing write; run persistence, close-flush and reconnect integration tests.

## Task 3: reconcile window edits against their base

**Files:** new focused layout synchronization helper, `windowBus.ts`, `bootstrapWorkspace.ts`, corresponding tests.

- [x] Add failing overlapping-window tests for separate tab edits, pending edits when a broadcast arrives, and structural changes.
- [x] Carry a base snapshot with each proposal. Merge changed properties against main's current layout; preserve unaffected properties. Validate the merged whole layout before adoption.
- [x] Rebase aux local changes while receiving broadcasts so unacknowledged edits are retained. Account for coalesced saves and acknowledgements; do not interpret an old broadcast as acknowledgement of a newer proposal.
- [x] Report conflicts to the originating window and resynchronize; do not silently overwrite newer structures or resurrect a deleted pane.
- [x] Run bus, layout, controller, plugin-pane and window lifecycle coverage.

## Task 4: restore original conversation launch configuration

**Files:** determine from read-only research into capture hooks, provider transcript metadata, saved-session records and all resume entry points.

- [x] Inspect installed CLI help and primary provider documentation to establish which arguments belong on resume commands and what source metadata can recover them.
- [x] Record the concrete capture/storage design after research; implement against failing tests covering quoted values, repeated options, permission/model settings, existing records without metadata, and saved/dead-pane resume.
- [x] Keep raw shell text out of command construction; preserve structured configuration and provider identity through persistence.

## Finish

- [x] Review each completed change and fix actionable issues.
- [x] Run full UI suite, build/typecheck, relevant native tests and real reconnect/reattach tests when changes reach those paths.
- [x] Record results and commit the fixes. Preserve the pre-change backup branch and report any remaining limits precisely.

Results: [verification report](../../reviews/2026-09-04-stability-and-resume-verification.md).
