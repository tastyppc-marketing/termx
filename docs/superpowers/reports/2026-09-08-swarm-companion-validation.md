# Windows collaboration client validation

The shared Windows client milestone is implemented at `8ea7445`. It provides
process identity, exclusive local ownership, authenticated named-pipe connections
and bounded framing. Broker/domain RPCs, harness enrollment/tools, recorded-context
sharing, native notifications and collaboration UI remain subsequent work in the
[integration plan](../plans/2026-09-08-swarm-companion-integration.md). This is not
an installed or usable swarm-feature release.

The original implementation is `b4ce8c6`; repair commits `0da337b` and `8ea7445`
address independent review findings. Fable5.1 approved the full first repair.
Its final narrow review approved `8ea7445` without required code changes on
2026-09-08 at 17:07:31 UTC. The documentation handoff below closes the remaining
consumer-documentation requirement.

A subsequent development worker exposed a Windows command-wrapper issue: passing
a multiline task prompt through the local `claude.cmd` launcher delivered only
its first line. The earlier review produced real findings and approval, but its
complete intended instructions were not delivered. The development launcher now
uses a short instruction pointing to the complete retained task file. A fresh
read-only Fable review verified full task-file delivery, inspected the complete
client contracts/source and retained evidence, and returned Spec PASS / Quality
APPROVED with no required changes on 2026-09-08 at 17:23:46 UTC. It reran no tests
or builds and made no mutations. This reconciles the review-context limitation;
the client source and validation results below are unchanged.

## Behavior verified

- Ancestry requires an exact starting PID and creation FILETIME, retains process
  handles and checks liveness. Confirmed absent/newer parents end the inspectable
  chain; inaccessible/incomplete evidence remains unavailable, and multiple
  enrolled matches remain ambiguous.
- Directory ownership and the exclusive lock survive competing claims and path
  aliases. Credentials and discovery metadata are checked on opened objects;
  insecure existing inputs are rejected and preserved. Discovery reads remain
  bounded if the file grows.
- Both client types verify server identity and boot before authentication. Owner
  connection success requires server acceptance. The server retains the actual
  connecting process identity. Authentication has a bounded deadline without
  blocking later accepts.
- Reads and writes progress independently. Acceptor cancellation/replacement
  failures preserve ownership. Interrupted frames and post-prefix capacity errors
  make the connection unusable instead of reinterpreting leftover bytes. Busy
  connection retries are bounded. Transport failure never proves application rollback.

Limits are 16 MiB per frame, 64 KiB discovery and 64 connections by default.
Default connect/handshake deadlines are two seconds, with 10 ms busy retry intervals.
These are resource controls, not conversation/message/token limits.

## Final evidence

The final frozen source passed 46 top-level tests (including four child helper
entrypoints), package formatting, strict all-target Clippy and a release build.
All four recorded native exits were 0, from 2026-09-08 16:56:51.9814376 UTC through
16:57:52.5876582 UTC. A fresh retained target directory preserved the preceding
repair's compiled artifacts. Focused API regressions have retained RED 101/GREEN 0
command manifests; compilation failures establish the missing API contract,
while the GREEN native tests exercise generation/liveness and wrong-server behavior.

Retained local evidence is under
`retired/test-artifacts/swarm-client/task-1-fix-2-final-20260908T1656413278036Z/`.
Its manifest records exact arguments, working directory, target override, times,
native exits and log hashes. All 15 source hashes are unchanged before/after and
match the committed Git content after Git's path-specific line-ending
normalization; raw working-file hashes are recorded separately. Root independently
verified eight logs, three new
release artifacts and three preserved prior artifacts. Final rlib SHA256:
`e924e74f483325bc1bb8cf393996bf61f92915f6a0fadb09f7715741e574ac38`.
Raw synthetic credentials and native model traces are excluded from Git.

## Consumer requirements and limits

The package is `termx-swarm-client`. Implementations live in `lib.rs`,
`identity.rs`, `security.rs`, `discovery.rs`, `framing.rs`, `wire.rs` and `pipe.rs`;
there is no separate `client.rs`. Principal consumer interfaces are:

| Interface | Contract |
| --- | --- |
| `ProcessIdentity { pid: u32, creation_filetime: DecimalU64 }` | An expectation to verify, not native authentication by deserialization. `DecimalU64::parse(&str)` rejects noncanonical unsigned decimal strings. |
| `VerifiedProcess::verify(ProcessIdentity) -> Result<Self, ProcessError>` | Retains the exact native process handle; `identity()` returns its identity and `is_alive()` returns `Result<bool, ProcessError>`. |
| `resolve_verified_enrolled_ancestor(ProcessIdentity, &[ProcessIdentity], usize) -> Result<VerifiedProcess, AncestryError>` | Exact starting generation, enrolled set and maximum inspection depth. Synchronous native snapshot work must run in a bounded blocking task, never on the SQLite worker. The pure counterpart takes an additional `&[ProcessSnapshot]` after the start. |
| `AuthorityClaim::claim(&Path) -> Result<Self, AuthorityError>` | Retains exclusive authority. `load_or_create_owner_credential()` returns the opaque native credential; `publish_discovery(&DiscoveryRecord)` preserves prior discovery. |
| `ClientBootstrap::open(&Path) -> Result<Self, AuthorityError>` | Verifies existing authority without taking its lock. `read_discovery()` and `load_owner_credential()` return `Result<DiscoveryRecord, AuthorityError>` and `Result<OwnerCredential, AuthorityError>`. |
| `PipeServer::bind(&str, FrameBudget) -> Result<Self, WireError>` | Owns listener/acceptor state. Async `accept(&mut self)` returns an unauthenticated `VerifiedPipe`. |
| `VerifiedPipe::authenticate_peer(&self, &str)` / `authenticate_owner(&self, &str, &OwnerCredential)` | Async boot/authentication methods returning `Result<(), WireError>`; `_with_timeout` variants accept `Duration`. The server route must be chosen explicitly. |
| `VerifiedPipe::connecting_client_identity()` / `connecting_client_is_alive()` | Server-side `Result<ProcessIdentity, WireError>` / `Result<bool, WireError>`; the client endpoint returns `WrongEndpoint`. |
| `OwnerClient::connect(&DiscoveryRecord, &OwnerCredential)` / `PeerClient::connect(&DiscoveryRecord)` | Async constructors returning `Result<Self, WireError>`. Both offer `connect_with_options` with `TransportOptions`; owner success includes credential acceptance. |
| Client `send_request(&RequestEnvelope)` / `recv_response()` | Async shared-reference methods returning `Result<(), WireError>` / `Result<ResponseEnvelope, WireError>`. Current version 1 typed envelopes contain boot hello/acceptance only; domain RPC additions remain Task 3. |
| `FrameBudget::with_limits(usize, usize) -> Self` | Aggregate byte and connection admission. `VerifiedPipe::send_bytes(&[u8])` / `recv_bytes()` are async and return `Result<(), WireError>` / `Result<ReceivedFrame, WireError>`; received bytes retain their permit until drop. |

`TransportOptions` contains `connect_timeout`, `connect_retry_interval` and
`handshake_timeout`, all `Duration`. Server mismatches and unavailable identity
inspection have distinct errors. There is not yet a dedicated native transport
regression for the unavailable-identity error branch; this is a recorded coverage
gap, not a claimed test. Final review's cosmetic suggestions are deferred.

Short-lived discovery readers can temporarily block `ReplaceFileW` because their
handles use read-only sharing. Broker integration must handle that publication
failure with bounded retry or an explicit unavailable result while preserving the
predecessor; Task 3 has a deterministic held-reader acceptance case for this.

The client is Windows-only and is not a sandbox against other unrestricted code
running as the same user or administrators. Unvalidated ancestor directories are
outside its object-validation guarantee. Generation tests do not claim forced
Windows PID reuse; a retained process handle already prevents reuse of that object.
Creation-order inference also inherits the resolution of Windows creation times;
a theoretically equal-timestamp reused ancestor cannot be distinguished by that
comparison alone. Native generation/retained-handle checks remain necessary.

Cancellation after frame I/O starts polling conservatively closes the logical
connection. The broker must retain an idle read or use a dedicated reader task,
handle capacity failures explicitly, and define owner/peer route selection.
Strict raw authentication frames follow the versioned boot hello; they are not
domain RPC messages. Current group authorization and durable replay semantics
belong to later integration. No live TermX executable was replaced or restarted.

The separately reviewed [durable-core validation](2026-09-08-swarm-core-validation.md)
remains valid. Neither these client tests nor the core stress run establish that
collaboration outperforms solo work; the reviewed comparative pilot is still pending.


## Reserved-send extension

The independently reviewed extension at `996cf46` adds
`VerifiedPipe::reserve_send` and `send_reserved`. A private, single-use
`ReservedFrameSend` owns one actual body-plus-four-byte-prefix permit and binds
it to the exact endpoint. An opaque cloneable `FrameCreditHandle` shares the
same permit lifetime; it cannot send or reconstruct a token. Wrong endpoint,
undersized capacity and poisoned state reject before writing. The writer uses
existing cancellation/poison behavior and never reserves a second permit.

Frozen evidence is retained under
`retired/test-artifacts/swarm-client/reserved-send-20260908T1959549967224Z/final`.
All five native exits were zero: 56 top-level tests, seven doctests, package fmt,
strict all-target Clippy and release build (2026-09-08 20:08:54-20:09:56 UTC).
Root matched all 14 inputs against raw files and committed blobs, ten logs,
counts and three release artifacts. Manifest SHA-256:
`b108532cc3349ee9811f97ee2cacf74601de9034603dec4af73a6e6e1b59c318`.
Release rlib SHA-256:
`2ca659258a0e0e925d01dc725e2968cd9e4cbbe03b7d12a2418151a8f150cb04`.

Grok implemented this scope; independent review returned Spec PASS / Quality
APPROVED. The client-owned metadata getter was completed in the follow-up below.
Reserved on-wire bytes are not a heap-size estimate.
The host must also bind one send token to one request, destination and committed
immutable response. This generic transport primitive alone does not provide
protected context publication or complete the host runtime.


## Credit metadata follow-up

The independently approved follow-up at `0343d1b` moves endpoint ownership from
the shared reservation to the sole send token. Credit-only handles now retain
exactly two fixed allocations: the reservation and its shared budget mutex.
`FrameCreditHandle::owned_heap_bytes()` reports their checked, padded Arc layout
sum, conservatively charging the full shared allocations to every handle. The
measured bound is 96 heap bytes plus 8 inline bytes on the audited Rust 1.97,
x64 Windows target. This is allocation-request accounting, not RSS or a stable
Rust ABI; the assumptions require review on toolchain or target changes.

Grok implemented the change and SOL independently returned Spec PASS / Quality
APPROVED. The frozen source passed 60 top-level tests, seven doctests, package
formatting, strict all-target Clippy and a release build. All five native exits
were zero, from 20:34:53 through 20:35:45 UTC on 2026-09-08. The meaningful RED
regression showed the old credit handle retaining the endpoint; the final tests
prove endpoint release and exact last-owner credit release.

Evidence: `retired/test-artifacts/swarm-client/reserved-metadata-20260908T2025363860332Z/final`.
Manifest SHA-256: `8f1bb705d0c3f4dab873a315345ce18a57c46b97f74c7f2b9925e8f85e12185b`.
Root verified 14 raw/committed inputs, ten logs, test counts and three release
artifacts, and retained exact sources and both reports. Release rlib SHA-256:
`a0def2a7c116f776158a677b4e32dcda705c455db7d55a6250a65d72285efa19`.

The host adapter remains Task 3 work: bind a private destination/request slot to
the single-use token, delegate this getter through the core guard, and separately
account for connection state, queues, futures and retained response buffers.
No live executable or conversation was changed by this validation.
