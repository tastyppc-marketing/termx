# Warp session sharing & collaboration — study report for TermX
### Agent study report (Opus, 2026-08-07) · verbatim archive · source: C:\Dev\warp-study

**Headline:** Warp shipped complete, production real-time session sharing in the open client — ~17,000 lines under `app\src\terminal\shared_session\` — including a genuine multi-replica CRDT for the shared command input, live presence with remote cursors, and a three-tier role model. All server-relayed through Warp's proprietary WebSocket service; no P2P path. The design transfers directly to a TermX host daemon acting as rendezvous, and one decision — **"attaching to an agent's terminal" and "attaching to a human's terminal" are the same code path** — is the most valuable idea in the repo for the TermX roadmap.

## 0. Licensing
Workspace AGPL-3.0-only; only `warpui`/`warpui_core` are MIT (UI toolkit). The external `session-sharing-protocol` git dep is AGPL-3.0. `sum_tree` (CRDT buffer backing) is AGPL here regardless of upstream Zed licensing. **TermX implements its own protocol and CRDT.** Wire-protocol semantics (message names, sequencing, roles) are ideas — safe; the Rust is not. For a permissive CRDT: `loro`, `yrs`, or `diamond-types`.

## 1. The cloud_object system (Warp Drive — NOT session sharing)
Durable synced documents (notebooks, workflows, MCP configs, prefs). Live terminal state never touches it.

- Envelope `GenericCloudObject{id, metadata, permissions, conflict_status, model}` with **four independent timestamps** (revision/metadata/permissions/actions) so content, metadata, ACL sync independently.
- **Local-first content, server-authoritative metadata/permissions.** Content writes: memory → SQLite → sync queue, no network needed. Permission/trash ops refuse offline.
- **Dual-state IDs:** `enum SyncId { ClientId, ServerId }` — client mints a UUID for offline create; first sync rewrites the ID in SQLite and every referencing object.
- **Derived outbox:** sync queue is in-memory; durability is an `is_pending` column; startup reconstructs the queue by scanning. Ten offline edits collapse to one push. Dependency ordering via explicit graph.
- **Conflicts: server-arbitrated optimistic concurrency, NOT CRDT.** Server-assigned microsecond `Revision`; on mismatch server returns the full current object in a typed rejection. Client policies: notebooks → conflict banner ("copy your work and refresh", no merge); workflows/env vars → silent server-wins; folders/prefs → last-write-wins.
- Sync loop: GraphQL WS subscription + 10-min jittered poll uploading the full timestamp manifest (O(n)). No Merkle tree.
- Notebook co-editing is a **pessimistic "baton"** (`current_editor_uid`), no lease/TTL — social lock + revision checks.

**For TermX:** copy the shape (dual-state IDs, derived outbox, four-axis timestamps, single client trait with a working fake), not the conflict policy.

## 2. Real-time session sharing — fully shipped
### Transport
Server-relayed WS, JSON text frames. Endpoints: sharer `/sessions/create`, `/sessions/{id}/resume`; viewer `/sessions/join/{id}` (`wss://sessions.app.warp.dev`). Auth **in-band** — first message carries `UserID{anonymous_id, access_token}`. Base URL overridable via CLI flag — the open client is already pointable at a self-hosted rendezvous.

### Join
One snapshot then pure delta: `JoinedSuccessfully` carries scrollback (**structured blocks** as JSON `SerializedBlock`s, scope `None|FromBlock|All`; undeserializable blocks dropped), window size, active prompt, participant list, assigned `viewer_id` + `input_replica_id`, and `latest_event_no`. Then a **hybrid ordered stream**: lz4-compressed raw PTY bytes fed to the viewer's own ANSI parser (write-backs swallowed into `Sink`), interleaved with structured events (CommandExecutionStarted/Finished, Resize, AgentResponseEvent).

### Viewer input — three deliberate channels, never raw keystrokes by default
1. Shared command input → CRDT ops (`UpdateInput`), gated on executor role
2. `ExecuteCommand{buffer_id, command}` — semantic request the sharer validates and runs
3. Raw PTY bytes only via `WriteToPty`, 100 ms batched, for alt-screen programs
4. Agent prompts (`SendAgentPrompt`) + control actions

Every privileged request re-validated **on the sharer's client** against role → `InsufficientPermissions`. Caveat: client-side is the only visible enforcement.

### Ordering & reliability
- `EventNumber` newtype; sharer buffers unacked ordered events, freed on `EventsProcessedAck`. Input updates deliberately un-acked.
- Viewer reorders in a map, drains contiguously from `next_event_no`, warns >50 buffered.
- Reconnect both sides: exp backoff base 1000 ms ×1.2, 18 retries (~128 s); success = `SessionReconnected`/`RejoinedSuccessfully`, not TCP connect.
- Client heartbeat is dead code — server sends protocol pings and initiates disconnect; presence is server-computed.
- **No backpressure** — unbounded channels, try_send-and-drop. Flow control = batching (50 ms PTY reads / 100 ms writes / 20 ms selections) + 100 MB session byte cap from billing tier.

## 3. Presence — substantial, portable
`presence_manager.rs` (806 lines): per participant info + assigned color + `Option<Role>` (None ⇔ sharer); present/absent lists; color pool returned on leave; participants not inserted until their avatar future resolves (no flash of unstyled presence); seven preset Figma colors; selections at 25% opacity; all remote colors go muted grey while *you* reconnect. **Cursors and selections mutually exclusive per peer.** Remote carets carry name/avatar badges. Selections throttled 20 ms trailing-edge (not debounced — fast movement stays live). Terminal-grid and alt-screen selections shared too.

**Shared input is a real CRDT:** Lamport clocks + replica-id tie-break; version vectors; fragment/tombstone character model (WOOT/RGA family); causal delivery defers ops; ops serde-serialized as opaque blobs (protocol knows nothing of CRDT shape). **Replica IDs are server-assigned** — the viewer discards its local buffer and rebuilds under the server's `input_replica_id` on join.

**Roles:** `Reader | Executor | Full` (UI effectively two-state). Upgrade via `RequestRole` → sharer modal ("This grants the ability to execute commands on your behalf") → response. Downgrades immediate. **Inactivity ladder:** revoke executors at 10 min idle, warn 25, end session 30. Asymmetry: `Role::Full → SharingAccessLevel::Full` but `Full` drive grant → only `Executor` session role.

## 4. warp_multi_agent_client & orchestration
**Naming trap:** `warp_multi_agent_client` is a ~160-line SSE client for ONE conversation ("multi-agent" = three models in one request). Real coordination:

- **run ID == task ID == mailbox address == UI identity.** One UUID, no registry to sync. Cleanest idea in the repo.
- **Server mailbox, not P2P:** POST messages to run IDs; inbound SSE stream of **thin pointer events** `{event_type, run_id, ref_id, sequence}`; client hydrates bodies on demand and acks.
- Dispatch: LLM emits `run_agents` with N configs; parent's plan docs published first so children can read them; 30 s per-child spawn timeout; `StartAgentExecutor::dispatch` materializes nothing (emits an event; frontend decides GUI pane vs TUI).
- Task states: `Queued|Pending|Claimed|InProgress|Succeeded|Failed|Error|Blocked|Cancelled|Unknown`. Even local children get a server task row (addressable on the bus).
- `wait_for_events` parks agents in `WaitingForEvents` with a watchdog at server-timeout −30 s. No polling, no dying while idle.

### Collision avoidance — read carefully
**No distributed lock, no work-stealing, no lease, no filesystem partitioning.** No worktrees anywhere in the agent path — local sibling agents share the cwd and can stomp each other; Warp's answer is "run children remotely" (a product answer). What exists: a server-arbitrated `Claimed` state; **duplicate-agent refusal whose denial reason is a corrective instruction to the model** ("Do not start duplicate child agents; send follow-ups with send_message_to_agent using the existing agent id(s): …"); two-phase delivery confirmed by the model's own echo; lifecycle coalescing that never coalesces Errored/Cancelled/Blocked; env-var identity handshake (`OZ_RUN_ID`, `OZ_PARENT_RUN_ID`, `OZ_CLI`, `OZ_HARNESS`) so third-party CLIs join the mesh; local children refuse machine-global mutations.

### The insight that matters most
**Agents are not participants in a shared session — agents OWN shared sessions, and humans join them.** Every agent run is joinable (`session_id`/`session_link`); Warp's "watch a cloud agent work" UI *is* the session-sharing viewer, deferred until a session exists. **Build session attach once, correctly, and you get human-human collaboration and human-agent observation from the same code.** When a human's shared session runs a local agent, agent output broadcasts with `response_initiator: Option<ParticipantId>` for attribution; late joiners get a synthesized replay of the prior agent conversation (with a scar-tissue warning about synthesizing Finished for in-flight exchanges).

## 5. Server dependence & the minimal self-hosted equivalent
**Requires Warp's backend:** the sharing WS service (assigns session/participant/replica IDs, presence, fan-out, role arbitration), agent REST + RTC SSE bus, GraphQL revision arbitration, Firebase identity.

**The relay's job is narrow and dumb.** A minimal self-hosted rendezvous needs to: (1) accept create/resume/join WS endpoints with in-band token auth; (2) assign session/participant/replica IDs; (3) hold the sharer's snapshot, hand it to joiners; (4) fan out sequenced events with monotonic event_no, ack to sender, resume rejoiners from `last + 1`; (5) maintain the participant list via ping/close; (6) track roles and route role requests. No terminal semantics, no CRDT internals (opaque blobs), no block structure. A sequenced pub/sub hub + snapshot cache + ACL table — a natural fit for termx-host on the VPS.

**TermX gets two things free:** identity at two-person scale = a small token table (no Firebase); and **the PTY need not live on a participant's laptop** — daemon-hosted PTY makes both humans symmetric viewers, dissolving Warp's hardest problems (sharer-goes-offline, client-side enforcement, idle-sharer revocation ladder).

Also worth studying as daemon templates: `crates\remote_server` (length-delimited protobuf over SSH stdio; host-scoped vs session-scoped envelope; `RemoteTransport` trait; empty request_id = push; carries NO PTY traffic) and `crates\local_control` (honest threat model, per-action brokered credentials).

## 6. Recommendations
**Adopt:** one attach mechanism for humans and agents; semantic viewer-input channels; snapshot + sequenced delta with acks and `last+1` rejoin; run-ID-as-address; mailbox with pointer events + lazy hydration; `wait_for_events` parking; denial reasons as model instructions; structured blocks for scrollback + compressed raw bytes for live output.

**Avoid/improve:** don't copy the (absent) collision-avoidance story — give each agent a worktree and/or path claims/leases; don't put the PTY on a participant's laptop; don't enforce permissions only client-side (daemon enforces); add backpressure; use a permissive CRDT or let the daemon serialize input edits authoritatively and skip CRDT entirely.

**Files most worth reading directly:** `app\src\terminal\shared_session\sharer\network.rs`, `viewer\network.rs`, `viewer\event_loop.rs`, `presence_manager.rs`, `crates\remote_server\proto\remote_server.proto`, `app\src\ai\blocklist\orchestration_events.rs`.
