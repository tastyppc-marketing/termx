# Warp — Session Sharing Architecture Study

**Researched:** 2026-08-22 · **For:** TermX collaboration design (Rust ConPTY daemon + Tauri 2 / React 19 / xterm)

**Legend used throughout:**
- **[VERIFIED]** — read directly from Warp's published source code or official docs.
- **[INFERRED]** — my reasoning from the code/docs. Plausible, but not stated by Warp.
- **[UNKNOWN]** — could not determine.

**Headline:** Warp is genuinely open source as of 2026-04-30, and — critically — the *session sharing wire protocol is published as its own standalone AGPLv3 Rust crate* (`warpdotdev/session-sharing-protocol`), with the full client implementation in the main repo. This is the single richest primary source available on how a shipping commercial terminal does session sharing. The **server is not open source**, but a third party has already reimplemented it from the published protocol, which proves the protocol is complete enough to build against.

---

## 1. What's Actually Public + Licenses

### The open-source verdict

**[VERIFIED]** Warp open-sourced its **client** on 2026-04-30. `github.com/warpdotdev/warp` — 64,447 stars, described as "Warp is an agentic development environment, born out of the terminal."

**[VERIFIED]** Licensing is split, stated verbatim in the repo README:

> Warp's UI framework (the `warpui_core` and `warpui` crates) are licensed under the [MIT license](LICENSE-MIT).
>
> The rest of the code in this repository is licensed under the [AGPL v3](LICENSE-AGPL).

So the widely-repeated "dual MIT and AGPL" framing in press coverage is **misleading**. It is not dual licensing in the pick-either sense. It is a *split*: two UI-framework crates are MIT, everything else — including every line of session-sharing code — is **AGPLv3**.

### The session sharing repos specifically

| Repo | Contents | License | Can TermX use the code? |
|---|---|---|---|
| `warpdotdev/session-sharing-protocol` | The complete wire protocol: `sharer.rs`, `viewer.rs`, `common/` (19 modules) | **AGPLv3** + CLA required at `cla.warp.dev` | **No — learn only** |
| `warpdotdev/warp` → `app/src/terminal/shared_session/**` | Full client implementation (sharer + viewer networking, permissions, presence) | **AGPLv3** | **No — learn only** |
| `warpdotdev/warp` → `crates/warpui`, `crates/warpui_core` | UI framework only, unrelated to sharing | MIT | Yes, but irrelevant here |
| Warp's relay **server** | Not in any public repo | n/a | **Not published** |

**[VERIFIED]** GitHub's license detector reports `NOASSERTION` for `session-sharing-protocol`, but its README states plainly: *"This project is licensed under version 3 of the GNU Affero General Public License; see LICENSE.md."* The `NOASSERTION` is an artifact of the CLA note in the file, not an ambiguity.

### The practical borrowing verdict

**Study it; do not copy it.** AGPLv3 is the most aggressive copyleft in common use, and its §13 network clause is precisely aimed at the situation TermX is contemplating: if you run a modified AGPL work as a network service, you must offer the complete corresponding source to every user interacting with it over the network. A TermX relay containing Warp code would trigger that obligation for the *whole* combined work.

**[VERIFIED]** The contributor CLA requirement at `cla.warp.dev` is a further signal — **[INFERRED]** Warp is collecting copyright assignment so it retains the right to relicense proprietarily, which is the standard open-core posture. Contributions flow in under AGPL; Warp's own commercial build is unencumbered.

What *is* freely usable: the **design**. Protocol shapes, state machine transitions, role semantics, and failure taxonomies are facts and ideas, not copyrightable expression. TermX should reimplement from a clean understanding, not translate files.

> **Recommendation:** Do not vendor, translate, or port any file from either repo. Read them, write down the *principles* (Section 5), and implement independently. If anyone on the project has copied code, treat it as a licensing incident.

### One notable third-party artifact

**[VERIFIED]** `github.com/b1nhm1nh/warp-server` — "Self-hosted, limit-free relay for Warp session sharing." A third party reimplemented Warp's relay in Rust (axum + tokio, in-memory state) against the published protocol crate, exposing three WebSocket endpoints. It is **AGPL-3.0**, because it links the protocol crate. Its existence is the proof that Warp's published protocol is complete and self-consistent — but it is equally off-limits as a code source for TermX.

---

## 2. Sharing Architecture

### Where the shared session lives

**[VERIFIED]** **Warp's cloud, not peer-to-peer.** The docs state that when a share is initiated, "Warp uploads the session scrollback to its servers and generates a shareable link," and explicitly frame this as "cloud-based ... rather than using peer-to-peer connections."

**[VERIFIED]** The transport is **WebSocket carrying JSON text frames**. From the protocol crate's `lib.rs`:

> "All messages defined here are shared across the client and server, and are serialized/deserialized to/from JSON."

The client uses `websocket::WebSocket::connect_with_headers(...)` and explicitly ignores non-text frames ("Ignore non-text frames (e.g. ping frames sent by the server)").

### Topology

```
   SHARER (owns the real PTY)                          VIEWER(s) — desktop / web / mobile
   ┌──────────────────────────┐                        ┌───────────────────────────┐
   │  ConPTY-equivalent       │                        │  xterm-style renderer     │
   │  local shell + agent     │                        │  (no local PTY at all)    │
   └───────────┬──────────────┘                        └─────────────┬─────────────┘
               │ WS  /sessions/create                                │ WS  /sessions/join/:id
               │ WS  /sessions/:id/resume  (reconnect)               │
               ▼                                                     ▼
        ╔══════════════════════════════════════════════════════════════════╗
        ║              WARP CLOUD RELAY  (closed source)                   ║
        ║  • Authoritative total ordering: assigns/relays event_no          ║
        ║  • Holds scrollback snapshot + event log (retention ~1 week)      ║
        ║  • Enforces ACLs; is the ONLY thing viewers can talk to           ║
        ║  • Enforces size + inactivity + per-user quota limits             ║
        ╚══════════════════════════════════════════════════════════════════╝
```

**The single most important structural fact: viewers never touch the sharer.** Every byte in both directions crosses the relay. There is no NAT traversal, no STUN/TURN, no direct socket. **[INFERRED]** This is why it works unchanged from a phone browser — a design property TermX gets for free if it copies the topology.

### The data model: snapshot + ordered event log

**[VERIFIED]** Sharing is *not* a raw PTY byte pipe. It is a **bootstrap snapshot followed by a totally-ordered event stream**.

**Bootstrap.** The sharer's `InitPayload` uploads a `Scrollback`, which is *structured*, not a flat buffer:

```rust
struct Scrollback { blocks: Vec<ScrollbackBlock>, /* + alt-screen flag */ }
struct ScrollbackBlock { raw: Vec<u8> }
```

Blocks, not lines. **[INFERRED]** This is the same block abstraction that powers Warp's command-blocks UI — the sharing layer reuses it rather than inventing a parallel representation. Directly relevant to TermX's own blocks-UI ambition: *design the block model once and let sharing ride on it.*

**Steady state.** Every subsequent change is an `OrderedTerminalEvent`:

```rust
struct OrderedTerminalEvent {
    event_no: usize,               // total order across ALL event kinds
    event_type: OrderedTerminalEventType,
}

enum OrderedTerminalEventType {
    PtyBytesRead { bytes: Vec<u8> },
    CommandExecutionStarted { participant_id, ai_metadata },
    CommandExecutionFinished { next_block_id },
    Resize { window_size: WindowSize },
    AgentResponseEvent { response_initiator, response_event /* base64 protobuf */, forked_from_conversation_token },
    AgentConversationReplayStarted,
    AgentConversationReplayEnded,
    CloudModeSetupPhaseEnded,
}
```

The design insight worth stealing outright: **PTY bytes, resizes, command boundaries, and AI-agent events share one sequence number space.** A resize is not a side-channel; it is event #4172 in the same stream as the bytes around it. That is what makes replay deterministic — a viewer joining late, or reconnecting after a drop, replays from `last_received_event_no` and lands in exactly the state everyone else is in, with resizes applied at the right instants.

**[VERIFIED]** Reconnect resume is explicit in the viewer's `InitPayload`:

```rust
struct InitPayload {
    viewer_id: Option<ParticipantId>,
    user_id: UserID,
    last_received_event_no: Option<usize>,   // ← resume cursor
    latest_block_id: Option<BlockId>,
    telemetry_context: Option<TelemetryContext>,
    feature_support: FeatureSupport,
}
```

### Backpressure and batching

**[VERIFIED]** Constants read from the client source:

| Concern | Value | Source |
|---|---|---|
| Sharer PTY-read batching | 50 ms (250 ms in one build config) | `sharer/network.rs` `PTY_READS_BATCH_THRESHOLD` |
| Viewer PTY-write batching | 100 ms (5 ms in tests) | `viewer/network.rs` `PTY_WRITES_BATCH_THRESHOLD` |
| Create-session attempt timeout | 5 s | `CREATE_SESSION_ATTEMPT_TIMEOUT` |
| Ambient create retries | 3 | `AMBIENT_CREATE_SESSION_MAX_ATTEMPTS` |
| Reconnect backoff | exponential, 1000 ms base, **18 retries ≈ 128 s total** | `RECONNECT_RETRY_STRATEGY` (both sides) |

**[VERIFIED]** The reconnect comment in the source: *"Exponential backoff when retrying reconnection. This configuration has us retry for ~128 seconds before giving up."*

**[VERIFIED]** Size is metered, not unbounded. `OrderedTerminalEventType::num_bytes()` charges only `PtyBytesRead` and `AgentResponseEvent`; control events cost zero. The sharer tracks `num_bytes_shared` cumulatively, and both `SessionTerminatedReason::ExceededSizeLimit` and `FailedToInitializeSessionReason::ScrollbackTooLarge` exist as first-class outcomes.

### Multi-writer input: a CRDT, not a lock

**[VERIFIED]** This is the most technically interesting part. Warp does **not** serialize concurrent typing through the relay with a lock. The shared *input buffer* (the prompt line being composed) is a **CRDT with per-participant replicas**:

```rust
struct InputReplicaId(String);        // per-participant; "The sharer is allowed to choose their own replica ID"
struct InputOperationSeqNo(usize);    // monotonic per buffer: zero() / advance()
struct BufferId(...);                 // NEW buffer id each time a command executes and input resets
struct CrdtOperation(Vec<u8>);        // opaque payload — "will eventually become a strongly-typed data structure"

struct InputOperationId { participant_id, buffer_id, op_no }
struct InputUpdate { id: InputOperationId, updates: Vec<CrdtOperation> }
```

**[VERIFIED]** The `BufferId` doc comment: *"when a command is executed and the buffer is reset, the buffer_id=B2, where B1 != B2."* Each prompt is a fresh CRDT document with a fresh identity. Stale edits against a retired buffer are rejected with `CommandExecutionFailureReason::StaleBuffer`.

**[VERIFIED]** Offline edits survive disconnection: the viewer keeps `pending_input_updates: Vec<InputUpdate>` — *"Input updates buffered while disconnected, to be flushed on reconnect."*

**[INFERRED]** The split is deliberate and is the key architectural idea: **the composed-but-not-yet-run input is collaborative (CRDT, concurrent, conflict-free); the executed PTY stream is authoritative and strictly ordered (single sequence, relay-assigned).** Two people can type into the same prompt simultaneously without a lock; but the instant it executes, it collapses into one totally-ordered event that everyone observes identically. **[UNKNOWN]** Which CRDT algorithm — the payload is `Vec<u8>` and the implementation lives outside the published protocol crate.

### Presence

**[VERIFIED]** Presence is separate from participation, and both are modeled explicitly:

```rust
struct Viewer       { info, role, is_present: bool }
struct PresentViewer{ info, max_acl: Role }
struct AbsentViewer { info }
struct Guest        { profile_data, direct_acl: Role }   // has ACL, may never have joined
struct PendingGuest { email, direct_acl: Role }          // invited, not yet a Warp user
```

`ParticipantList` carries all five collections at once. **[VERIFIED]** Cursor/selection is its own throttled channel — `UpdateSelection(SelectionUpdate { selection, event_no })` with its own `selection_event_no` counter, sent through a throttled stream, deliberately *not* in the main terminal event sequence. **[INFERRED]** Cursor movement is high-frequency and lossy-tolerant; putting it in the ordered log would poison the resume cursor and inflate the metered byte count. TermX should mirror this separation.

---

## 3. Link / Join Flow

### Two generations, and the direction of travel matters

The code shows Warp **migrating away from capability URLs toward authenticated ACLs**, gated behind `FeatureFlag::SessionSharingAcls`. Both paths are present in master today.

**Generation 1 — bearer-secret capability URL [VERIFIED, legacy path]**

```rust
struct SessionId(Uuid);       // "cannot be used to access a shared session; you need the SessionSecret"
struct SessionSecret(String); // Uuid::new_v4().to_string()

fn to_join_route(&self) -> String {
    format!("/sessions/join/{}?pwd={}", self.session_id, self.secret_to_string())
}
```

Two independent UUIDv4s: a public id and a secret passed as `?pwd=`. `FailedToJoinReason::WrongPassword` is the enforcement point. Anyone holding the URL is in.

**Generation 2 — authenticated identity + server-side ACLs [VERIFIED, current]**

The live link generator carries **no secret at all**:

```rust
pub fn join_link(session_id: &SessionId) -> String {
    format!("{}/session/{}", ChannelState::server_root_url(), session_id)
}
pub fn join_native_intent(session_id: &SessionId) -> String {
    format!("{}://shared_session/{}", ChannelState::url_scheme(), session_id)
}
```

And the WebSocket connect passes **auth headers**, not a password:

```rust
let join_endpoint = connect_endpoint(format!("/sessions/join/{session_id}"))?;
let user_id = Self::get_user_id(auth_client, &auth_state).await?;
websocket::WebSocket::connect_with_headers(&join_endpoint, None::<&str>, iap_headers).await?
```

**[INFERRED]** The URL has become a *pointer*, and authority moved entirely server-side into an ACL check against the authenticated user's identity. The legacy `?pwd=` route survives for older clients. Notably, `connect_endpoint` appends `?version={app_version}` when the ACL flag is on — **[INFERRED]** server-side protocol negotiation so the relay can downgrade behavior for old clients.

**[VERIFIED]** Protocol versioning is handled by additive-only evolution, stated as a hard rule in `lib.rs` and repeated in `sharer.rs`:

> "Remember to annotate `#[serde(default)]` to every new field added for backward compatibility, since old clients may not specify new fields expected by the server."

Plus a **graceful capability downgrade** helper — `ParticipantList::downgrade_full_roles()`, documented as *"Used for backward compatibility with clients that don't support the Full role"* — which rewrites every `Full` to `Executor` before sending to an old client. That is a genuinely elegant pattern: the server degrades the *data* to fit the client's capabilities rather than refusing the connection.

### Server endpoint surface

**[VERIFIED]** Three WebSocket endpoints, confirmed independently from both Warp's client and the third-party relay:

| Endpoint | Who | Purpose |
|---|---|---|
| `/sessions/create` | Sharer | Open a new shared session |
| `/sessions/join/:session_id` | Viewer | Join (and rejoin) |
| `/sessions/:session_id/resume` | Sharer | Sharer reconnect after drop |

### Session lifecycle

**Handshake** — `Initialize(InitPayload)` up; `SessionInitialized` or `FailedToInitializeSession { reason }` down. Failure reasons: `ScrollbackTooLarge`, `NoUserQuotaRemaining`, `UserNotFound`, `InternalServerError`.

**Sharer reconnect** — `ReconnectPayload` carries `session_secret`, a `ReconnectToken` (opaque, with masked `Display`/`Debug`), `user_id`, `latest_block_id`, `selection`, `feature_support`. Rejection reasons are richly enumerated: `Invalid`, `SessionNotFound`, `WrongPassword`, `WrongReconnectionToken`, `WrongFirebaseUid`, `NoUserQuotaRemaining`, `SessionNotAccessible`.

**[VERIFIED]** A detail TermX should copy verbatim in spirit — the viewer *closes the old socket before reconnecting*:

> "Close the old connection before reconnecting so the server sees `WebsocketClosed` immediately rather than waiting for its own idle timer."

Without this, the relay holds a zombie participant until an idle timeout expires, and the rejoining user appears twice in the participant list.

**Expiry and retention [VERIFIED]:**

```rust
enum Lifetime { Ephemeral, Lingering }        // deleted when sharing ends / persists after
enum SessionEndedReason { EndedBySharer, InactivityLimitReached, ExceededSizeLimit }
enum SessionRetentionReason { SetupFailed }   // "retain for inspection"
// UpstreamMessage::ExtendSessionRetention
```

Docs state shared data **expires after approximately one week** and becomes inaccessible.

**Revocation [VERIFIED]:** Only the publisher can revoke access or stop publishing. Mid-session revocation is a live, modeled state — `ViewerRemovedReason::LostAccess` and a `viewers_without_access: Vec<ParticipantId>` field computed on every participant-list refresh. Access loss is *pushed*, not discovered on next request.

**Join failure taxonomy [VERIFIED]:** `Invalid`, `SessionNotFound`, `WrongPassword`, `InternalServerError`, `MaxNumberOfParticipantsReached`, `SessionNotAccessible`.

### Read-only vs read-write

**[VERIFIED]** Three roles, escalating:

```rust
enum Role { Reader, Executor, Full }   // Full also includes ACL-modification rights
impl Role {
    fn can_execute(&self) -> bool;     // true for Executor and Full
    fn downgrade_full(&mut self);      // Full -> Executor
}
struct AccessLevels { max_acl: Role, direct_acl: Role }
```

- **Reader** — watch scrollback, agent output, presence. No input.
- **Executor** — send input, run commands, write to PTY, prompt the agent.
- **Full** — everything, *plus modify the ACL* (invite guests, change link level, set team access).

**[VERIFIED]** The two-field `AccessLevels { max_acl, direct_acl }` is the effective-permission model: a user's ceiling is the max across the paths that grant them access (direct guest grant, team ACL, link level), while `direct_acl` records only what was assigned to them personally. **[INFERRED]** This is what lets Warp answer "why does this person have edit?" — because the grant paths stay distinguishable rather than being collapsed into one number.

**[VERIFIED]** Elevation is a request/approve handshake, not a silent grant:

```rust
struct RoleRequestId(Uuid);
struct PendingRoleRequest { participant_id, request_id, requested_role }
enum RoleRequestResponse { Approved { new_role: Role }, Rejected { reason } }
enum RoleRequestRejectedReason { RejectedBySharer }
```

Messages: viewer sends `RequestRole` → sharer receives `RoleRequested` → sharer answers `UpdateRole` → everyone receives `ParticipantRoleChanged`. Cancellation is modeled too (`RoleRequestCancelled`). **[VERIFIED]** Roles can also *expire downward* on their own: `RoleUpdatedReason::InactivityLimitReached` — an idle executor is auto-demoted.

**[VERIFIED]** Write actions are separately typed rather than lumped into one "input" channel: `CommandExecutionRequested`, `WriteToPtyRequested`, `AgentPromptRequested`, `ControlActionRequested`. Each is independently permission-checkable and independently observable. `CommandExecutionFailureReason` is exactly `{ InsufficientPermissions, StaleBuffer }` — permission and staleness, the only two ways a write can legitimately fail.

**[VERIFIED]** The relay acknowledges in-flight writes (`CommandExecutionRequestInFlight`, `EventsProcessedAck`) so the requesting viewer can show "sending…" rather than appearing to have done nothing during the round trip.

---

## 4. Teams / Roles / Admin Model

**[VERIFIED]** Three orthogonal grant paths converge on the same `Role`:

1. **Link access level** — `UpdateLinkAccessLevel` → `LinkAccessLevelUpdateResponse { Success { role: Option<Role> }, Error }`. `Option<Role>` = `None` means link access is off entirely.
2. **Direct guests** — `AddGuests` **by email**, `RemoveGuest`. Non-Warp invitees become `PendingGuest { email, direct_acl }`, so a role can be pre-assigned to someone who has not signed up yet. Failure reasons are specific and user-facing: *"One or more of the emails did not correspond with Warp users"*, *"One or more of the guests has already been added to the session."*
3. **Team ACL** — `TeamAclData { acl: Role, uid: String, name: String }`, with `TeamAccessLevelUpdateResponse`. **[VERIFIED]** The client comment is candid about the current limit: *"For now, this assumes that sessions can have only one team ACL."*

**[VERIFIED]** The unification worth noting: Warp Drive objects (notebooks, workflows, prompts) use `SharingAccessLevel { View, Edit, Full }` with UI labels "Can view" / "Can edit" / "Full access", and live sessions use `Role { Reader, Executor, Full }` — with a direct `Role → SharingAccessLevel` conversion in `permissions_manager.rs`. **One sharing mental model spans saved artifacts and live sessions.** A user who understands sharing a workflow already understands sharing a terminal.

**[VERIFIED]** Identity is Firebase-backed: `ProfileData { firebase_uid, display_name, photo_url, email, input_replica_id }`, and `ReconnectionFailedReason::WrongFirebaseUid`.

### Commercial tiers

**[VERIFIED]** From warp.dev/pricing:

| Tier | Price | Relevant to sharing |
|---|---|---|
| Free | $0 | "Limited cloud agents and collaboration features" |
| Build | $20/mo ($18 annual) | "Unlimited Warp Drive objects and collaboration"; 1,500 credits |
| Max | $200/mo ($180 annual) | 18,000 credits |
| Business | $50/user/mo ($45 annual) | ≤25 seats, **SAML SSO**, admin-configurable data controls, team usage metrics |
| Enterprise | Custom | Unlimited seats, multi-admin, enterprise admin controls |

**[UNKNOWN]** No published per-session participant cap, retention length by tier, or bandwidth quota — though the protocol proves quotas exist in some form (`NoUserQuotaRemaining` appears in three separate failure enums, and `MaxNumberOfParticipantsReached` is a real join failure). **[INFERRED]** Collaboration is deliberately positioned as the free→paid conversion lever: it is the one feature that is useless alone and gets more valuable per additional paying seat.

**[VERIFIED]** Security posture: TLS 1.2+ in transit, AES-256 at rest. **[VERIFIED]** Crucially **not** end-to-end encrypted — the relay reads plaintext, which it must, since it parses and orders individual event types.

### The security caveat Warp publishes explicitly

**[VERIFIED]**, quoted from the docs, and this is the sentence TermX must internalize:

> "Anything visible in a shared session's scrollback, **including values that Secret Redaction would otherwise redact elsewhere**, is visible to everyone who can access the share."

Warp's own secret-redaction feature **does not apply to shared sessions**. **[INFERRED]** The reason is structural: redaction is a render-time transform on the local client, while sharing uploads `ScrollbackBlock { raw: Vec<u8> }` — the raw pre-render bytes. Redaction and sharing were built at different layers and the seam leaks. Warp handled it by documenting the gap rather than closing it.

**[VERIFIED]** Warp also states shared contents are not indexed by AI unless someone actively uses AI features within that session.

---

## 5. Principles TermX Should Steal

### 1. Ship a versioned protocol crate as a first-class artifact, separate from the daemon

Warp's protocol is a standalone repo with one job: define messages shared by client and server. Its two rules are enforced culturally in doc comments — **every new field gets `#[serde(default)]`**, and capability mismatches are handled by *downgrading data* (`downgrade_full_roles()`) rather than refusing connections.

For TermX this matters more than it did for Warp, because of the roadmap: VPS-resident sessions and Ibrahim joining the same session mean **the daemon and the UI will be at different versions routinely** — different machines, different update cadences. A shared `termx-protocol` crate with additive-only evolution and an explicit `FeatureSupport` handshake turns "collaborator on an old build" from a support incident into a degraded-but-working session. Adopt the `?version=` query param too; it costs nothing and lets the server adapt.

### 2. One totally-ordered event log — with PTY bytes, resizes, and command boundaries in the *same* sequence

`OrderedTerminalEvent { event_no, event_type }` where resize, command-start, command-finish, and raw bytes all share one counter, and viewers resume via `last_received_event_no`.

This is the load-bearing idea. It is what makes late-join, reconnect-resume, and replay all be *the same code path* rather than three features. Given Michael's stated adoption blocker is WebSocket reconnect, this is the highest-leverage thing on this list: a monotonic sequence number plus a resume cursor converts reconnection from "hope the buffer is still valid" into "replay from N." Keep high-frequency lossy signals — cursor and selection — on a *separate throttled channel* with their own counter, exactly as Warp does, so they never contaminate the resume cursor or the metered byte count.

Design this against the block model TermX already wants for its blocks-UI. Warp shares `Vec<ScrollbackBlock>`, not a flat scrollback, because sharing rides on the same block abstraction the UI uses. Build the block model once.

### 3. Split collaborative *input* from authoritative *execution*

Warp runs a CRDT over the un-executed prompt buffer (per-participant `InputReplicaId`, monotonic `InputOperationSeqNo`, fresh `BufferId` per command) while the executed PTY stream stays strictly relay-ordered.

This dissolves the multi-writer problem without a lock, a turn-taking UI, or "you have the pen" awkwardness. Two people compose the same command line concurrently; execution collapses it to one ordered event. The `BufferId`-per-command trick is what makes it tractable — each prompt is a short-lived CRDT document that is *thrown away* on execute, so no CRDT state accumulates across a long session, and late edits die cleanly as `StaleBuffer`. Buffer edits made while disconnected and flush on reconnect (`pending_input_updates`).

### 4. Roles as an escalation *protocol*, not a boolean — with server-pushed revocation

`Reader / Executor / Full`, `AccessLevels { max_acl, direct_acl }`, a full request→approve→broadcast handshake with cancellation, automatic demotion on inactivity, and push-based access loss (`ViewerRemovedReason::LostAccess`, `viewers_without_access`).

Two sub-principles are easy to miss and expensive to retrofit. First, **`Full` is separated from `Executor` specifically because "can run commands" and "can change who else can run commands" are different risks** — TermX should not collapse them. Second, **revocation is pushed, never polled**: the moment access is removed the viewer is told, rather than discovering it on the next action. For a session on Michael's own VPS with an outside collaborator attached, instant revocation is the safety valve that makes granting edit access thinkable at all. Type the write actions separately (execute command / write to PTY / prompt agent) so each is independently gateable — read-only that still allows PTY writes is not read-only.

### 5. Relay everything through the server; never attempt peer-to-peer

All traffic crosses Warp's relay. No NAT traversal, no STUN/TURN, no direct connections.

This is what makes a share openable from a phone browser with no install, and it is the reason the feature is reliable enough to be a selling point. Given TermX is already heading toward VPS-resident sessions, the relay is a box you were going to run anyway — putting sharing on it is close to free architecturally, and it sidesteps the entire class of "works on my network" failures that sink P2P terminal sharing. **Bound it from day one**, as Warp does: size limits with a per-event `num_bytes()` where control events cost zero, inactivity timeouts, participant caps, and retention windows are all in the protocol's failure enums from the start, not bolted on after the first runaway `yes` loop fills the disk.

---

## 6. What to Avoid

**Do not copy any AGPLv3 code.** Restating because it is the highest-consequence item: a TermX relay containing Warp code triggers AGPL §13 network-source obligations across the whole combined work. Reimplement from principles. Do not port `session-sharing-protocol` file-by-file, and do not use `b1nhm1nh/warp-server` as a starting point either (also AGPL).

**Do not leave secret redaction broken across the sharing seam.** Warp's own docs admit redaction does not apply to shared scrollback, because sharing uploads raw pre-render bytes. This is a real leak with a documentation-shaped patch over it. TermX should redact **at capture time, before the bytes enter the shared event log** — not at render time. Retrofitting this after a block model and an event log exist is painful; getting it right at the seam costs almost nothing today.

**Do not ship a bearer-secret-in-URL as the permanent model.** Warp started with `?pwd=<uuid>` and is visibly migrating to authenticated identity + server-side ACLs, keeping the old route only for compatibility. Capability URLs leak through Slack history, screen shares, browser history, and shoulder-surfing, and they cannot be revoked per-person. Learn from where Warp *ended up*, not where it started: authenticate the joiner, then evaluate an ACL. If TermX wants a quick-share link for expedience, scope it hard from the start — short TTL, view-only by default, and revocable — so it never becomes the thing everyone relies on.

**Do not model presence as a single online/offline flag.** Warp needed five distinct participant shapes (`PresentViewer`, `AbsentViewer`, `Guest`, `PendingGuest`, plus a legacy `Viewer`) because "has an ACL," "is currently connected," and "has ever joined" are three genuinely independent facts. A boolean here forces awkward retrofits the moment you support invite-by-email or want to show who *was* in the session.

**Do not put cursor/selection in the ordered event log.** Warp deliberately throttles selection onto its own channel with its own counter. Selection updates are high-frequency and safely lossy; mixing them into the durable ordered stream inflates retention, inflates the metered byte count, and makes the resume cursor jump for no semantic reason.

**Do not treat the legacy field as free.** `ParticipantList` still carries a `viewers: Vec<Viewer>` field marked *"Legacy field kept for backwards compatibility. After the ACL transition we should be using present_viewers, absent_viewers, and non_viewer_guests and can remove this field."* Warp is paying to serialize a duplicate participant list on every update because the ACL migration is incomplete. **[INFERRED]** The lesson for TermX, which has no shipped clients to support yet: get the participant/ACL model right *before* the first external collaborator connects, because after that every mistake becomes a compatibility field you carry for years.

**Do not promise end-to-end encryption.** Warp's relay reads plaintext because it must parse and order individual event types. TLS in transit plus encryption at rest is the honest, achievable posture. Any design that both routes through a smart relay and claims E2EE is claiming something it cannot deliver.

**Do not under-specify failure reasons.** Warp enumerates them exhaustively — `FailedToJoinReason`, `FailedToInitializeSessionReason`, `ReconnectionFailedReason`, `SessionTerminatedReason`, `SessionEndedReason`, `RoleUpdatedReason`, `ViewerRemovedReason`, `CommandExecutionFailureReason`, `InputUpdateFailureReason`. Nine enums, each with specific variants. A generic `Error { message: String }` makes it impossible for the UI to distinguish "retry will work" from "you were kicked out" from "you're over quota," and that distinction is the entire difference between a reconnect experience users tolerate and one they abandon.

---

## 7. Sources

**Primary — source code (all AGPLv3; read, do not copy):**
- [warpdotdev/session-sharing-protocol](https://github.com/warpdotdev/session-sharing-protocol) — `src/lib.rs`, `src/sharer.rs`, `src/viewer.rs`, and `src/common/{roles,permissions,participant,input,session_params,ordered_terminal_events,scrollback,command_execution,team}.rs`
- [warpdotdev/warp](https://github.com/warpdotdev/warp) — `app/src/terminal/shared_session/{mod.rs, permissions_manager.rs}`, `app/src/terminal/shared_session/viewer/network.rs`, `app/src/terminal/shared_session/sharer/network.rs`, `crates/cloud_objects/src/drive/sharing.rs` (default branch is `master`, not `main`)
- [warpdotdev/warp README — Licensing section](https://github.com/warpdotdev/warp/blob/master/README.md)

**Official docs & announcements:**
- [Warp is now open source](https://www.warp.dev/blog/warp-is-now-open-source) (2026-04-30)
- [Agent Session Sharing — Warp Docs](https://docs.warp.dev/agent-platform/local-agents/session-sharing/)
- [Session Sharing — Warp Docs](https://docs.warp.dev/knowledge-and-collaboration/session-sharing/)
- [Warp Drive overview](https://docs.warp.dev/knowledge-and-collaboration/warp-drive/)
- [Security overview — Warp Docs](https://docs.warp.dev/enterprise/security-and-compliance/security-overview/)
- [Warp Pricing](https://www.warp.dev/pricing)

**Third-party:**
- [b1nhm1nh/warp-server](https://github.com/b1nhm1nh/warp-server) — independent AGPL relay reimplementation; confirms the endpoint surface
- [Warp (terminal) — Wikipedia](https://en.wikipedia.org/wiki/Warp_(terminal))
- [Warp open sources its AI terminal client — Help Net Security](https://www.helpnetsecurity.com/2026/04/30/warp-open-source-client/)
- [Good News! AI-first Warp Terminal is Now Open Source — It's FOSS](https://itsfoss.com/news/warp-goes-open-source/)
