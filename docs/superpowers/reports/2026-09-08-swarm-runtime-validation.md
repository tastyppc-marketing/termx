# Task3 authenticated companion runtime

Final verification complete and independently reconciled at retired/test-artifacts/host/runtime-final-20260908T230459271592Z. Spec PASS / quality APPROVED for Task3 scope; native enrollment and product integration remain later work. Base cb6cc914a5a92f618d6db9b0445b5a048fcae594, worktree swarm-proof, branch feat/swarm-windows-proof.

## Resulting behavior

TermX now has an independent broker runtime selected by --swarm-broker before ordinary host cleanup, logging, PTY creation or argument parsing. Future --swarm-mcp and swarm CLI modes are recognized early and explicitly unavailable pending Task4. Broker startup claims native authority, opens one SQLite worker, recovers a new run, refreshes every persisted live process generation with revision-aware bounded pages, binds separate owner/peer named pipes, publishes discoveryv2, then opens a persistent dispatch gate. Failure/competing start preserves predecessor discovery and unrelated resources. No history-count cutoff remains.

The authority follows actual owned native resources through unpolled futures, panic, cancellation, worker open/drain/reaper and nested read/accept tasks. Shutdown aborts every accept task before joining any of them, closes the gate, cancels source work and drains only owned broker operations. One-second elapsed backoff handles momentary worker admission contention without yield-count startup failures; capacity/closed errors remain immediate.

Owner route requires private secret acceptance; peer hello verifies boot only and grants no enrollment. Strict typed RPC uses actual connection evidence and current core grants, bounded correlation and exact decimal wire values. JSON sender/role/PID claims cannot promote authority. Owner subscribe carries lossy boot/revision hints and overflow requires resnapshot. Typed clients also report locally dropped hints.

Host request/output ownership is separate from transport and core reply ownership. Data admission leaves bounded control headroom. Responses preadmit before side effects, use fixed-capacity encoders and retain credit through write/drop. Source I/O has two concurrent slots, a deadline and cancellation-owned future. Host source body capacity is preadmitted; final publication reserves the exact destination before core validation. Pause/removal/offline/withdrawal/rebind before validation returns the exact rejection with no publication commitment; revocation after commit cannot undo that single immutable response. Production source verification/reading remains unavailable until native adapters exist.

Discovery migration recognizes only exact secure legacyv1 under exclusive publisher, retires predecessor bytes and writesv2. Ordinary readers acceptv2 only. Unknown/malformed/future/insecure predecessors remain unchanged. Transient Windows sharing is retried boundedly; case-insensitive owner/peer pipe aliases are rejected.

Detached startup retains the exact child immediately, verifies it outside EVERY job while still suspended, verifies retained child/thread identity/liveness before resuming, and reaps only the owned child on rejection/error/unwind. This environment's ancestor job prevents full breakaway: that path explicitly reports unsupported and does not mutate target data. Foreground stdin/launcher lifetime and owner-connection independence are tested. No claim of successful full detachment here.

## Scoped reviews and tests

Root independently approved client, core worker lifetime, Windows lifetime and RPC/output slices; exact reviews and manifests are linked in task-3-{client-runtime,core-lifetime,lifetime,rpc}-root-review.md. Core141 tests+6docs (one existing ignored) and client71tests+7docs/fmt/strictClippy/release passed on their final unchanged sources. Runtime integration consumes those sources; root added native ownership/cancellation, history, event, source and route regressions.

The current combined host run has268passed/3ignored helpers/history in --all-targets; the ignored262145-peer history regression is separately run and passed. There are0 host doctests. Package fmt, strictalltargetClippy and production-only releaseClippy passed. Release build also passed. Exact source/log/artifact reconciliation follows below. This is not a current-schema broker soak or a model collaboration comparison.

Meaningful root retained RED/GREEN pairs: readiness gate; source cancellation/deadline; missing expected page revision and old262144-peer cutoff; claim-through-SQLite work; canceled shutdown first-join orphan; timed admission scheduling. Earlier false test assumptions (BrokerConfigClone, peer boot-only hello, withdrawn-source class), scoped concurrent-build failures and production-only test-helper lint failures are retained accurately. The first combined final run225725 passed tests/history/docs/fmt/alltargetlint but failed production lint for unused test-only imports/helper; root added matching feature gates. No runtime behavior was suppressed with warning allowances.

## Actual consumer APIs and limits

See task-4-runtime-api-preparation.md for concrete names. BrokerConfig and BrokerRuntime own lifecycle. SourceReader returns SourceReadFuture, SourceSnapshot is bounded, UnavailableSourceReader is default. Fixture enrollment/source/observer/core access is feature-gated and unavailable through wire/CLI. TypedConnection uses boxed ResponseBody (same JSON) and materializes DTOs; later MCP streaming must retain ReceivedFrame bytes instead. There is no peer event wait yet.

Task3 does not implement real native harness enrollment, common tools, recorded-context provenance/indexing, scheduler/wake, collaboration UI, automatic startup or installation. Membership alone is not tool/context/wake capability. No arbitrary message quotas, roles, rounds, forced replies or second conversation writer were added. No live user host/session was operated or replaced. All displaced files and failed evidence remain retained; root alone owns Git checkpoint publication.


## Final root readback

{
  "utc": "2026-09-08T23:10:16.279961+00:00",
  "final_manifest_sha256": "823328f83aacd124abac66f9a06949c0959c49dd1b6d630b542043806a8b3995",
  "source_inputs_and_copies": 81,
  "commands": 7,
  "logs": 14,
  "artifacts": [
    {
      "path": "C:\\Dev\\TermX\\.worktrees\\swarm-proof\\retired\\t-host-runtime-20260908T225725995782Z\\release\\termx-host.exe",
      "bytes": 7367680,
      "sha256": "48314ec374a829a9c39ca71d2fd84bdab91f3208fa5fd59f8d0b53c9432437e7"
    },
    {
      "path": "C:\\Dev\\TermX\\.worktrees\\swarm-proof\\retired\\t-host-runtime-20260908T225725995782Z\\release\\termx_host.pdb",
      "bytes": 4255744,
      "sha256": "93814abfd59e49f92204534566090bdf14987bc7dd8e7e54386094f03401c3df"
    },
    {
      "path": "C:\\Dev\\TermX\\.worktrees\\swarm-proof\\retired\\t-host-runtime-20260908T225725995782Z\\release\\libtermx_host.rlib",
      "bytes": 17879806,
      "sha256": "20fad5b9c3aea17d03f195cadc7b17087e06314d0b7a1694128d7d570cae56a4"
    },
    {
      "path": "C:\\Dev\\TermX\\.worktrees\\swarm-proof\\retired\\t-host-runtime-20260908T225725995782Z\\release\\libtermx_host.d",
      "bytes": 2797,
      "sha256": "72a94576081f6dd50eb908fe78ba04228423ef7fa8f16f4701deb33d1bb4a225"
    },
    {
      "path": "C:\\Dev\\TermX\\.worktrees\\swarm-proof\\retired\\t-host-runtime-20260908T225725995782Z\\release\\termx-host.d",
      "bytes": 2846,
      "sha256": "7583177a0b2453d96e2d8869f9cc48c9e4a698dd097b3bc9a87d90fd738a5b0f"
    }
  ],
  "counts": {
    "tests": [
      {
        "passed": 206,
        "failed": 0,
        "ignored": 1
      },
      {
        "passed": 7,
        "failed": 0,
        "ignored": 0
      },
      {
        "passed": 12,
        "failed": 0,
        "ignored": 0
      },
      {
        "passed": 14,
        "failed": 0,
        "ignored": 0
      },
      {
        "passed": 6,
        "failed": 0,
        "ignored": 1
      },
      {
        "passed": 6,
        "failed": 0,
        "ignored": 0
      },
      {
        "passed": 5,
        "failed": 0,
        "ignored": 0
      },
      {
        "passed": 12,
        "failed": 0,
        "ignored": 1
      }
    ],
    "history": [
      {
        "passed": 1,
        "failed": 0,
        "ignored": 0
      }
    ],
    "docs": [
      {
        "passed": 0,
        "failed": 0,
        "ignored": 0
      }
    ],
    "fmt": [],
    "clippy": [],
    "production-clippy": [],
    "release": []
  },
  "all_required_commands_native0": true,
  "source_unchanged": true
}

All seven required native commands exited0. Compiler cache was reused from the retained first final attempt; every changed source was rebuilt by Cargo and all current source inputs were frozen and compared before/after each command. The failed first attempt remains intact. Final production artifacts were built with default production features, separately linted without test targets. No executable was installed or copied over a live application.
