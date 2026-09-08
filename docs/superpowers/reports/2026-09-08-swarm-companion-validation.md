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
match the committed Git blobs. Root independently verified eight logs, three new
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
