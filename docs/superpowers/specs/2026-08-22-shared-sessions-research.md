# Shared Sessions & Teams — Architecture Research

**Date:** 2026-08-22 · **Status:** research / feasibility, no code changed · **Author:** research agent (Opus 5)
**Purpose:** decision-ready input for a proper design & brainstorm cycle on (1) a Warp-style shared environment reachable by link, and (2) a teams layer with admin visibility over subordinates' sessions.

This is not a plan. It is the map you run the planning cycle against. Open questions you must answer are at the end (§9) — several of them are forks the whole architecture hangs on.

---

## 0. Headline findings

1. **TermX's daemon is already a multi-viewer session server.** Multi-client attach, per-session byte-offset replay, lag resync, gapless reattach, and sessions that outlive their clients are all shipped and covered by tests. The primitives a "join my terminal" feature needs are 80% built. What is missing is not streaming — it is **identity, authorization, and reach**.

2. **Warp is open source as of 28 April 2026 — the client only, under AGPL-3.0** (the `warpui`/`warpui_core` UI crates are MIT). The server, Warp Drive backend, and auth infrastructure remain closed. So Michael is right that Warp is open source, but the half that matters for a relay is not. **AGPL means learn-only for us.** Our own in-repo study (`docs/warp-study/report-collaboration.md`, Aug 7) already dissected the ~17k lines of shipped session-sharing in that client; this report builds on it rather than repeating it.

3. **A Linux port of `termx-host` is far cheaper than it looks.** The daemon already uses `portable-pty` (which speaks both ConPTY and Unix PTY). The only OS-bound API use is **six `windows-sys` references in a single file** (`host/src/session.rs`, `OpenProcess`/`TerminateProcess` for process liveness and kill); beyond that, the platform work is an `%APPDATA%` branch in `paths.rs` and Unix shell profiles alongside the powershell/cmd ones. `server.rs`, `registry.rs`, `protocol.rs`, `ring.rs` and `history.rs` are portable as they stand. This makes "VPS-resident sessions" a genuinely reachable phase rather than a rewrite.

4. **Today's auth model cannot survive contact with a second person.** One 128-bit bearer token grants every capability: any authed connection can attach to any session, write input to any session, close any session, and `Shutdown` the whole daemon. There is no per-connection principal, no per-session ACL, and no read-only mode. **This is the mandatory prerequisite for everything else**, and it is a clean standalone piece of work.

5. **Sharing the terminal does not share the chat.** TermX's chat view is rendered from **local Claude Code transcript JSONL files**, tailed by a Tauri command over a filesystem path (`ui/src-tauri/src/chat_feed.rs`), linked to a pane by explicit key or by cwd. A remote viewer has no access to those files. "Admin can access any and all chats" therefore requires a **second data channel** (transcript deltas on the wire), not just the PTY stream. It is a separate sub-project, sized L.

6. **True end-to-end encryption and admin oversight are mutually exclusive.** sshx's E2E design (which is excellent and MIT-licensed) means the relay cannot read the session — which also means the relay cannot record it for audit. You cannot have both on the same session. This is a fork, not a trade-off to be finessed. See §5.4 and Q3.

7. **The commercial reference product deliberately declined to build silent admin monitoring.** Warp's Teams gives admins billing, usage, adoption analytics, SSO and policy control — and no way to see a member's terminal without that member sharing it. If TermX ships admin oversight it is ahead of the field, and it must be designed with consent, visible indicators, scope limits and audit as **load-bearing requirements**, not settings. §6 treats them that way.

---

## 1. TermX today: the session and attachment model

### 1.1 Topology

```
Tauri UI (React 19 + xterm.js 6)
    │  bootstrap_host  →  spawn daemon if absent, read runtime.json
    │
    │  ws://127.0.0.1:<ephemeral port>      (loopback only)
    ▼
termx-host (Rust, tokio, tokio-tungstenite)
    ├── Registry  ── owns all Sessions, layout blob, persistence (state.json)
    └── Session[] ── ConPTY via portable-pty
                     ring buffer (absolute byte offsets)
                     broadcast::Sender<OutputChunk>  ← the fan-out point
                     watch::Receiver<ExitState>
                     disk spill for evicted scrollback (history.rs)
```

The daemon binds `127.0.0.1:0`, mints a 32-hex-char (≈128-bit) token, and writes `{port, token, pid, version}` atomically to `runtime.json` in the data dir (`%APPDATA%\TermX`, or `<exe>/data` in portable mode). Discovery is that file; there is no service registration and nothing listens off-loopback.

### 1.2 Wire protocol (`host/src/protocol.rs`)

One WebSocket carries two kinds of frame:

- **Text = JSON control.** `ClientMsg`: `Auth`, `CreateSession`, `Attach{session_id, replay, since_offset}`, `Detach`, `Resize`, `CloseSession`, `ReadHistory`, `ListSessions`, `SetLayout`, `GetState`, `Shutdown`. `HostMsg`: `AuthOk{version, sessions}`, `AuthErr`, `SessionCreated`, `Replay{session_id, start_offset, data_b64}`, `SessionExited`, `SessionClosed`, `History`, `Sessions`, `LayoutSaved`, `State`, `Error{context, message}`.
- **Binary = PTY bytes.** Tag byte + `Output{session_id: u32, offset: u64, data}` or `Input{session_id: u32, data}`. Clients sending `Output` are rejected explicitly.

The protocol has a **serde-default discipline for wire compatibility** (`shell_integration`, `since_offset` both default when omitted, with tests pinning that). Extending it for sharing is therefore low-risk by construction.

### 1.3 Attachment semantics — the part that is already right

`handle_conn` (`host/src/server.rs:385`) is the whole story:

- **Auth gate.** First *text* frame within 5s must be `Auth{token}` matching. Ping/pong pre-auth doesn't burn the attempt. Half-open handshakes time out at 10s.
- **One outbound queue per connection** (mpsc, depth 256) drained by a single writer task, with a **one-replay-per-connection semaphore permit** held from before the ring snapshot until the socket send completes. This is what stops a joining viewer from parking megabytes of base64 in memory.
- **One forwarder task per (connection, session).** `Attach` subscribes to the session's broadcast **strictly before** taking the ring snapshot (order is commented and tested), so the worst case is overlap, deduped against `replay_end`. Ordinary output goes out as binary frames; a `Lagged` broadcast receiver triggers an **unsolicited resync `Replay`**, and `replay_end` advances only once that replay is actually queued.
- **Resume by cursor.** `Attach{since_offset}` trims the replay at the client's cursor; a cursor the ring evicted past is clamped and the client's `onLostScrollback` reports the gap. The client (`ui/src/host/client.ts`) tracks `nextOffset` per attachment and trims overlap itself.
- **Sessions outlive clients.** Client death aborts only that connection's forwarders. Tests prove: two clients both receive output, detach isolates, one client closing notifies the other, a session survives client death and replays on reattach, mid-stream attach is gapless, and reattach never delivers stale covered frames.
- **Reconnect supervisor** (`ui/src/host/reconnect.ts`): step-table backoff, a separate slow table for auth/bootstrap failures, a 30s anti-flap floor, requests fail rather than queue, and "connected" means `auth_ok` — not TCP.

**In plain terms: a second human attaching to a live TermX session already works, correctly, including late join, lag, and reconnect. It just can't be a *different* human, and it can't be from off-box.**

### 1.4 What is absent

| Missing | Consequence |
|---|---|
| Per-connection principal | Every connection is the owner. No "who joined". |
| Per-session ACL / read-only | A viewer can type into your shell, and there is no way to stop them. |
| Capability gating on `Shutdown` / `CloseSession` | A remote viewer could kill the daemon. |
| Presence / participant list | Nobody knows anyone else is watching. |
| Resize policy | Any client resizes any session; two viewers with different window sizes fight. tmate solves this by tracking every client's dims and picking a size that fits all. |
| Audit events | Nothing is recorded about who attached to what. |
| Off-loopback reach | Nothing listens beyond `127.0.0.1`, by design. |

### 1.5 SSH today is *not* VPS-resident sessions

The shipped SSH feature (`docs/superpowers/specs/2026-08-17-ssh-sessions-design.md`, `ui/src/ssh/`) creates a **local** PTY and types `ssh -t <alias> '<base64 bootstrap>'` into it. Nothing is installed remotely. The bootstrap sets a bash `PROMPT_COMMAND` emitting OSC 9;9 (remote cwd) and defines `claude`/`codex` wrappers that emit a private OSC 9;78 carrying the captured conversation id.

Consequences that matter here:

- **The session's PTY lives on the Windows box.** Laptop sleeps or TermX dies → the remote shell dies with it. There is no tmux, no mosh, no remote resident process. This is the same choice Warp made and, per our own Warp study, "exactly what TermX must NOT do" for the collaboration roadmap.
- **The bash OSC 9;9 hook already exists and is proven.** A Linux daemon's shell profiles can reuse that payload nearly verbatim — a real head start on §4 Candidate B.

### 1.6 Chat is file-derived, not stream-derived

`chat_feed_open/poll/close` tail a Claude Code JSONL transcript **by local path** at 500ms, windowing the last 256 KiB and capping each poll at 1 MiB. `ui/src/chat/linkage.ts` binds a pane to a transcript explicitly or by matching cwd. SSH panes have no chat at all (the transcript is on the remote box, and nothing reads it).

So: **PTY stream ≠ chat.** Any "admin sees the chats" feature needs transcript content to travel the wire as its own message type, sourced either from the daemon (which today knows nothing about transcripts) or from a per-client agent. Budget for it separately.

---

## 2. Prior art: what is actually out there, and what we may legally take

### 2.1 Warp — verified status

**Verdict: the owner is right about the client, and the useful half for a relay is closed.**

| Thing | Status | License |
|---|---|---|
| `warpdotdev/warp` — the Rust client, incl. ~17k lines of shipped session sharing | Public since **28 Apr 2026** | **AGPL-3.0** |
| `warpui`, `warpui_core` (UI toolkit crates) | Public | **MIT** |
| `warpdotdev/session-sharing-protocol` — the sharing wire protocol | Public | **AGPL-3.0** |
| Server / relay, Warp Drive backend, auth infrastructure, "Oz" orchestrator | **Closed. No commitment to open it.** | — |
| `themes`, `workflows` | Public | Apache-2.0 |
| `docs`, `commands.dev`, `claude-code-warp`, `codex-warp` | Public | MIT |

Contributions require a CLA. No acquisition; independent, ~$73M raised, last round 2023.

**How Warp sharing works** (docs.warp.dev + the protocol crate + our in-repo study):

- Sharer picks scope at share time — **full scrollback, no scrollback, or one specific block** — and the client uploads session state to Warp's cloud, which returns a link.
- The link opens in a **browser** (no install needed for the joiner), or in Warp on another machine, or on mobile.
- **Read-only by default; write access is requested by the viewer and approved by the sharer.** Roles in the protocol crate are `Reader | Executor | Full`. Scope is invited-people / whole-team / anyone-with-link. Stopping the share kills live access instantly; shared data auto-expires ~1 week.
- **Everything relays through Warp's cloud over WebSocket with JSON text frames.** A third-party self-hosted relay exists (`b1nhm1nh/warp-server`, AGPL-3.0, axum + tokio + DashMap, ~500 lines) implementing the published protocol, which tells you how dumb the relay can be: `GET /sessions/create`, `/sessions/join/:id`, `/sessions/:id/resume`; the session UUID is the only secret; the sharer holds a distinct `reconnect_token`; viewers are stateless and get an identical stream; **CRDT operations are opaque payloads the relay never interprets**.
- Viewer input is **three deliberate channels, not raw keystrokes**: CRDT ops for the shared command input, a semantic `ExecuteCommand` the sharer validates, and raw `WriteToPty` (100ms batched) only for alt-screen programs. Every privileged request is re-validated **on the sharer's client**.
- **Inactivity ladder:** revoke executors at 10 min idle, warn at 25, end the session at 30.

**Warp Teams gives admins no terminal visibility.** Roles are Owner / Admin / Member; admins get membership, SSO (Okta/Entra/Google), policy and agent-autonomy configuration, credit/spend tracking and adoption analytics via an Analytics API. There is **no documented way for an admin to view a member's session, command history, or agent conversation without that member sharing it**. Their published privacy posture runs hard the other way: telemetry is metadata-only and never console output, enterprise teams have collection off by default, secrets are redacted before any LLM call, ZDR agreements with Anthropic/OpenAI/Google, SOC 2 Type II.

**Practical read:** Warp's *design* is the closest match to what Michael wants and is safe to learn from. Its *code* is AGPL and must not be borrowed. Its *server* is not available at any price. And on admin monitoring, we are deliberately going somewhere Warp chose not to go — which means we own the entire trust design ourselves.

### 2.2 sshx — the closest technical analog, and MIT

`github.com/ekzhang/sshx` · **MIT** · Rust server + Rust client + Svelte web UI · 7.6k stars · last commit 2025-06-19 (quiet, but complete and coherent).

- **Session state lives on the server**, not the host. Host ↔ server is a gRPC bidirectional stream; browser ↔ server is **WebSocket carrying CBOR**. Per shell the server keeps a **2 MiB rolling buffer** with a sequence number; viewers **pull by chunk index** (`Subscribe(sid, chunknum)`), which makes reconnect/resume free. Optional Redis enables session migration between nodes and transparent WebSocket reverse-proxying to the owning node.
- **Link:** `https://sshx.io/s/{name}#{key}` — `name` is a 10-char server-side id, `key` is a 14-char client-side secret (~83 bits) that **lives in the URL fragment and never reaches the server**. With `--enable-readers` you get two links, read-only and writable (`#{key},{write_password}`).
- **The crypto is the best idea in the field and is worth copying wholesale.** Argon2id (m=19MiB, t=2, p=1) stretches the key; AES-128-CTR with IV = `[stream_num u64][block_num u64]`; **terminal output for shell `id` uses stream `2^32 | id` with the absolute byte offset as counter**, so any byte range stays independently seekable *through* the encryption — which is exactly what makes chunk-index resume work. Joiner authentication is proof-of-key-possession: the host publishes `E(key, 0^16)` under an all-zero IV, the joiner computes the same block, and the server does a **constant-time compare** — learning nothing, because stream 0 is forbidden for real data.
- **The relay sees:** session name, exact byte lengths and timing, terminal dimensions, viewer names, cursor positions, chat messages (plaintext), IPs. **It cannot see:** terminal bytes, keystrokes, the key.
- Two weaknesses worth fixing in any reimplementation: raw CTR with **no MAC**, so a malicious relay can *replay* a captured input ciphertext at its original offset; and **all writers share one input keystream**, collision-avoided only by random 64-bit start offsets. Use an AEAD and per-writer stream numbers.
- **Read-only is enforced server-side**, decided once at auth, gating `Data`/`Create`/`Close`/`Move`. Readers keep full social presence — name, live cursor, chat. Multiple writers interleave with no locking; the multiplayer affordances are what make that workable.
- **It ships a ConPTY implementation** (`crates/sshx/src/terminal/windows.rs`, MIT) carrying a warning that PowerShell fails under its ConPTY setup with error `8009001d`. We already solved that (we run PowerShell under ConPTY fine), but the file is a legal freebie if ever useful.
- Self-hosting is technically easy (three-stage Dockerfile, one binary, Redis optional) but officially "not supported"; the one real trap is that reverse proxies must pass h2c gRPC through.

### 2.3 The rest of the field

| Project | Session lives | Transport | Join | Read-only | License | Borrowable? |
|---|---|---|---|---|---|---|
| **sshx** | Server | gRPC (host) + WS/CBOR (browser) | URL with secret in fragment; browser | Per-viewer, server-enforced | **MIT** | **Yes** |
| **Upterm** | Host | Reverse SSH tunnel; relay is an SSH piper (a deliberate MITM) | `ssh TOKEN@uptermd…`; **no web UI** | Session-wide only | **Apache-2.0** | **Yes** (+patent grant) |
| **tmate** | Server (a second tmux fork replicating from the host over SSH+msgpack) | SSH + WebSocket | 4 links: ssh/web × ro/rw | Separate read-only token; enforced by a **symlink check** on the socket | ISC/MIT core; **web component unlicensed**; master closed | Learn only in practice |
| **tty-share** | Host (the host binary *is* the web server) | Single outbound TCP, yamux-multiplexed; relay is a dumb pipe | URL; browser (stock xterm.js) | Session-wide flag | **MIT** | Yes |
| **Zellij** | Server (always had client/server split) | Two WebSockets: terminal + a separate control subchannel | `https://host/<session-name>`; attach/resurrect/create by URL | **Token-scoped**: `--create-read-only-token` blocks keyboard, mouse **and resize** | **MIT** (verified, no relicense) | **Yes** |
| **Wave Terminal** | Host + remote Unix-socket-backed durable sessions | Go backend + Electron | — (no sharing today; collab is their stated future monetization) | — | Apache-2.0 | n/a |
| **ttyd / GoTTY** | Host | WS + xterm.js | URL (GoTTY `-r` adds a random path segment) | **Read-only by default**; `-W`/`-w` to enable writing | **MIT** | Yes |
| **VS Code Live Share** | Host | P2P first, cloud relay fallback; **E2E over SSH** either way | Non-guessable link valid only for that session | Per-terminal, chosen at share time | **Proprietary** | Model only |
| **VS Code Remote Tunnels** | Host | Outbound registration to Azure relay; AES-256-CTR over SSH through it | `vscode.dev/tunnel/<machine>/<folder>` | n/a — **same account both ends**, no multi-user at all | CLI MIT, **server proprietary** | Model only |
| **Teleport** | Host + proxy | — | `tsh join` / web UI, **mode chosen explicitly before entry** | observer / moderator / peer | **AGPL-3.0** core; CE binaries under a restrictive commercial license since v16 | **Do not vendor** |

### 2.4 The four ideas most worth stealing

1. **sshx's stream-namespaced encryption** — per-shell keystream indexed by absolute byte offset, so seek/resume survives encryption. Directly compatible with TermX's existing offset model.
2. **Zellij's capability tokens** — read-only is a property of the *credential*, minted separately and revocable, not a runtime flag a UI bug can flip. And it blocks **resize** too, which is easy to forget and is a real side channel.
3. **Zellij's two-channel split** — terminal data on one socket, control on another, so a `cat` of a big file never queues a resize or a permission change behind it. TermX currently shares one queue for both, with an explicit comment noting the accepted stall risk; a second participant makes that stop being acceptable.
4. **tmate's relay-failover reconnect** — the proxy HMAC-signs `(session_id, token, ro_token)` and hands it to the host, so the host can reconnect to a *different* relay node, possibly in another region, and **the shared links stay valid**. Best-in-class, and TermX's reconnect supervisor is already the right shape to carry it.

---

## 3. Design space for TermX

### 3.1 (a) Session residence

| | **Local-resident** (daemon stays on Michael's box) | **VPS-resident** (Linux daemon on the VPS) |
|---|---|---|
| Sessions survive laptop sleep/reboot | No | **Yes** |
| Ibrahim and Michael in the *same* shell | Only while Michael's box is awake and connected | **Yes, natively** |
| New daemon build required | No | Yes — but small (§3.6) |
| Attack surface | Relay only | **An internet-reachable process that spawns shells** |
| Matches | Warp, Upterm, tty-share, Live Share | sshx, Zellij web, tmate |

**Assessment:** local-resident is the fast path to a share link; VPS-resident is what "shared environment" actually means once a second person depends on it. The end state is **both**, chosen per session, with the UI treating "where does this session live" as a first-class property (TermX already has a Hosts inventory to hang that off).

The decisive TermX-specific fact: **the Linux port is small.** `portable-pty` already abstracts the PTY; the only Windows-bound code is six `windows-sys` lines in `session.rs` for process-liveness and termination, plus the `%APPDATA%` branch in `paths.rs` and the powershell/cmd profiles. A Unix `ProcessIdentity` (kill/waitpid), an XDG data-dir branch, and bash/zsh profiles carrying the OSC 9;9 hook **that `ui/src/ssh/bootstrap.ts` already proves works** is the whole job.

### 3.2 (b) Transport

- **WebSocket relay on the VPS (recommended).** It *is* already the protocol. TLS via the existing reverse proxy, outbound-only registration from the daemon (no inbound firewall rules, works from any network — the VS Code Tunnels trick), and it is the only option that lets a browser join. Avoid sshx's gRPC hop: one protocol for both host and viewer collapses two stacks and dodges the h2c proxy trap that generates most of sshx's self-hosting issues.
- **SSH tunnelling.** Reuses trust Michael already has (all 8 configured hosts are key-auth), needs no new server component, and Upterm proves the design. But there is no browser join, the "link" is an ssh command, and a teams/audit plane needs an application server anyway.
- **WebRTC.** Rejected. It still needs signalling infrastructure, it buys latency only on the P2P path, and every teams requirement (audit, admin visibility, recording) wants a server in the path deliberately.

**Recommendation: WebSocket to a VPS relay, outbound-registered, wss only.** Keep SSH tunnelling in the back pocket as the "paranoid mode" for a session Michael refuses to relay.

### 3.3 (c) The share-link flow

```
Sharer (TermX)                 termx-relay (VPS)              Joiner
  │  "Share this session"         │                             │
  ├── register(session meta) ────►│                             │
  │◄── {slug, reconnect_token} ───┤                             │
  │                               │                             │
  │   link = https://termx.<domain>/s/<slug>#<key>[,<writekey>]  │
  │   ─────────────────────────────────────────────────────────►│
  │                               │◄──── GET /s/<slug> ─────────┤
  │                               │  page offers:               │
  │                               │   • Open in TermX  (termx://join/<slug>#<key>)
  │                               │   • Join in browser (xterm.js, same version as the app)
  │                               │◄──── ws join + auth ────────┤
  │◄── viewer attach (relayed) ───┤                             │
  │──── Replay + live frames ────►├────────────────────────────►│
```

Design commitments:

- **`slug` is server-minted routing; the secret lives in the URL fragment** and never reaches the relay (sshx). This is what makes E2E possible later even if v1 ships without it.
- **Deep link `termx://join/<slug>#<key>`** registered via Tauri 2's deep-link plugin, with single-instance routing into the running app. The web page is the fallback for anyone without TermX — that fallback *is* the "open a link" experience for Ibrahim on his phone.
- **Token scoping** — the share grant is a signed capability: `{slug, session_id, role, expires_at, max_viewers, revoked_at}`. Roles at minimum `viewer` (read-only) and `writer`. Mint read-only and writable as **separate** credentials (Zellij), never one credential with a flag.
- **Expiry and revocation** — default expiry short (hours, not Warp's week, for a v1); "Stop sharing" in the UI kills the relay session and disconnects everyone immediately; revocation list on the relay so a leaked link dies even if the daemon is offline.
- **Cap viewers** (`ttyd -m`), and show the count in the sharer's UI.

### 3.4 (d) Multi-writer semantics

**Recommendation: server-side `can_write` decided once at join, interleaved input, no locking — plus presence, plus an always-live owner keyboard.** Every project in the field converged here, and Live Share states the reason explicitly: the owner's ability to interrupt *is* the safety valve. Turn-taking locks are a solution to a problem social presence solves better.

What that requires in TermX specifically:

- **Gate `Frame::Input` on the connection's role** (currently ungated, `server.rs:695`).
- **Gate `Resize`, `CloseSession` and above all `Shutdown`.** A remote viewer able to send `Shutdown` today would kill the daemon and every session on the machine.
- **Adopt a resize policy.** With two viewers this is a live bug, not a nicety. Options: owner pins the size (simplest, recommended for v1); or fit-the-smallest across attached writers (tmate). Either way, `SessionInfo` needs to report who set the current dims so the UI can explain the black bars.
- **Presence.** New `HostMsg::Participants{session_id, participants:[{id, display_name, role, joined_at}]}` plus join/leave events. Once presence exists, "who just typed that" is answerable, which is what makes uncoordinated writing tolerable.
- **Do not build a CRDT for v1.** Warp needs one because it shares a structured *command input buffer*; TermX shares a byte stream. A CRDT becomes relevant only if the shared **chat composer** ever becomes multi-writer, which is a later question.

### 3.5 (e) The teams layer

Deferred to §6, because it is mostly a trust-design problem rather than a transport problem.

### 3.6 (f) Daemon changes vs. new server component

**Changes inside `termx-host` (Rust):**

| Change | Size | Note |
|---|---|---|
| Per-connection principal (`Principal{id, display_name, role, source: Local\|Relay}`) replacing the single-token model; keep the local token as the "owner" credential | **M** | The single most important change. Touches the auth gate and every capability check. |
| Capability gating on `Input`, `Resize`, `CloseSession`, `Shutdown`, `SetLayout`, `CreateSession` | **S** | Mechanical once the principal exists. |
| Per-session share state `Option<ShareGrant>` + ACL lookup | **S–M** | Registry-level. |
| Presence tracking + `Participants` message + join/leave events | **M** | New per-session participant map; the broadcast fan-out point already exists. |
| Generalize `handle_conn` over `AsyncRead + AsyncWrite` instead of `TcpStream` | **S** | Unlocks the relay socket reusing the entire existing state machine. |
| Outbound relay client (dial VPS, register, multiplex remote viewers as pseudo-connections) | **M** | Each remote viewer becomes another `handle_conn`-shaped client. This is the cheapest possible integration. |
| Resize policy | **S** | |
| Audit event emission (append-only, local + relayed) | **M** | |
| Linux build: Unix `ProcessIdentity`, XDG data dir, bash/zsh profiles | **M** | Only for VPS-resident sessions. Reuses the proven SSH-bootstrap OSC 9;9 payload. |
| Transcript tail moved/duplicated into the daemon + a transcript wire channel | **L** | Only for chat sharing. Today this logic lives in the Tauri layer. |

**New component: `termx-relay` (Rust, axum + tokio; runs on the VPS):**

| Responsibility | Size |
|---|---|
| Session directory: register / join / resume, slug minting, reconnect tokens | **M** |
| Frame pass-through fan-out (relay stays dumb; it does not parse PTY bytes) | **S–M** |
| Identity & auth (see Q2 — GitHub OAuth recommended for v1) | **M** |
| Share-grant issuance, expiry, revocation list | **M** |
| Web join page: xterm.js viewer pinned to the same version the app ships (`@xterm/xterm` 6.0.0), plus the deep-link handoff | **M** |
| Teams: orgs, membership, roles, admin session directory | **L** |
| Append-only audit log + retention policy | **M** |
| Session recording (only if not E2E — see Q3) | **M–L** |

Effort scale used throughout: **S** ≈ one focused working session; **M** ≈ a TermX-sized batch (a few days, spec + tests); **L** ≈ multi-batch, needs its own design doc.

---

## 4. Architecture candidates

### Candidate A — Relay-attached local daemon

The Windows daemon keeps owning every session. When Michael shares one, the daemon dials `termx-relay` on the VPS outbound and registers it; the relay mints a slug and returns a link. A joiner opens the link and gets either the browser xterm view or a TermX deep-link; either way the relay pipes their frames to the daemon, where they arrive as an ordinary attach with a non-owner principal.

**Two sentences:** The relay is a dumb, stateless pipe and the existing daemon does all the work — remote viewers reuse `handle_conn`, `Attach`, replay, resync and reconnect exactly as the local UI does. Fastest route to a working share link, and the relay it builds is the same component every later phase needs.

- **Effort:** daemon principal+ACL **M**, relay socket + `handle_conn` generalization **M**, relay service **M**, web viewer **M**, deep link **S**. Total ≈ 2–3 batches.
- **Risks:** sessions die with the laptop, so it is a *demo/pairing* feature, not a shared environment. Relay sees plaintext unless E2E is added. Windows box must stay awake for Ibrahim to work — which is precisely the complaint that motivated the VPS roadmap.

### Candidate B — VPS-resident daemon

Port `termx-host` to Linux and run it on the VPS behind the relay's auth. TermX desktop becomes one client among several; Michael and Ibrahim attach to the same session ids over the same protocol; the browser viewer is a third client.

**Two sentences:** Sessions become infrastructure rather than a property of somebody's laptop, which is the only version of this that survives sleep, reboots and time zones. It costs a Linux daemon build (small, thanks to `portable-pty`) and a serious security posture, because an internet-reachable process that spawns shells is exactly what it sounds like.

- **Effort:** Linux session backend **M**, auth front-end **M**, multi-tenant ACLs **M–L**, UI "remote host" concept **M**, hardening/deployment **M**. Total ≈ 3–4 batches, and it depends on Candidate A's principal/ACL work.
- **Risks:** security surface is the whole risk. Also does *not* by itself give link-sharing to people without TermX — that still needs the relay's web viewer. And the chat view will not work against remote sessions until the transcript channel exists (§1.6).

### Candidate C — Relay as the identity and teams spine

The relay is promoted from pipe to platform: it owns accounts, orgs, roles, share grants and the audit log, and it fronts **both** locally-resident daemons (Candidate A) and VPS-resident ones (Candidate B). The web viewer is the universal fallback; the desktop app is the rich client.

**Two sentences:** This is the honest end state, because teams, admin oversight and audit all need a durable server-side identity plane that neither A nor B provides on its own. The only real question is ordering — and since A's relay grows into C without being thrown away, C is a destination rather than a competing choice.

- **Effort:** everything in A and B, plus orgs/roles **L**, admin directory **M**, audit + retention **M**, consent/indicator machinery **M**. Total ≈ 6–9 batches cumulative.
- **Risks:** scope. This is a product, not a feature — it implies account management, a database, deployment and uptime obligations, and the security posture of a service that can spawn shells for multiple people. Do not start here.

---

## 5. Cross-cutting risks

1. **A shared terminal is remote code execution, by design.** Every mitigation is about *who* and *how loudly*, never *whether*. The relay is a high-value target; treat it as production from day one (see the blast-radius rule in CLAUDE.md — a VPS carrying live client work is not free-fire).
2. **AGPL contamination.** Warp's client and protocol crate, and Teleport's core, are AGPL. Reading them for design is fine and we have already done it. Copying any of it into TermX would put TermX under AGPL. Our own study file already records this; keep the discipline. The safe-to-copy pool is sshx (MIT), Zellij (MIT), Upterm (Apache-2.0), tty-share/ttyd/GoTTY (MIT).
3. **E2E vs. audit is a hard fork.** See Q3.
4. **Token leakage.** A share link in a Slack channel is a shell. Mitigations: short expiry, viewer caps, revocation, read-only default, and an unmissable participant list on the sharer's side with one-click remove (Live Share's notification-with-Remove-button is the pattern).
5. **The chat gap.** Shipping "shared sessions" and having the chat view silently not work for shared or remote panes would be a bad surprise. Decide early whether phase 1 ships terminal-only sharing *explicitly* (and says so in the UI) or waits for the transcript channel.
6. **Single-writer assumptions in the UI.** The reconnect supervisor, the attach queue's sequential constraint, and the resize path all assume one client. Each needs a review pass, not just the daemon.
7. **xterm.js version drift.** The web viewer must ship the same renderer as the app (`@xterm/xterm` 6.0.0) or shared output will render differently for the joiner than the sharer. Pin them together.

---

## 6. The teams layer and its trust design

This section is written as requirements, not suggestions. Admin oversight of live terminals is the single most sensitive thing TermX could ship, and the research is unambiguous that the serious tools treat consent, indication, scope and audit as architecture.

### 6.1 Where the field draws the line

- **Warp:** admins get billing, usage, SSO, policy. **No terminal visibility without the member sharing.** Deliberate.
- **VS Code Live Share:** host is auto-notified on join with an inline **Remove** button; a live participant list with per-participant removal; optional `guestApprovalRequired` for approve-before-entry; unauthenticated guests are read-only *and* always prompt; **only the host can start a shared terminal**; read-only vs read/write is chosen per terminal at share time.
- **Teleport:** joining requires **explicitly declaring a mode** (observer / moderator / peer) before entry; an in-stream banner (`Teleport > User jeff joined the session`) lands in the scrollback *and* the recording; RBAC governs both who may join whose sessions and who **must** be present; `on_leave: pause` freezes I/O rather than killing the session when a required observer drops. Notably, Teleport does **not** guarantee the user is told they are being recorded.
- **CyberArk PSM:** monitoring notification is **configurable per platform** (optional — a compliance decision pushed onto the customer); a persistent corner-anchored indicator during suspension; and a **monotonic override hierarchy** — disabled at system level cannot be re-enabled at platform level. Broader scope may only restrict.

### 6.2 Required design properties for TermX

1. **Visibility is opt-in at the session level, and the default is invisible.** A member's session becomes admin-observable only because (a) it was created in an org workspace marked observable, or (b) the member shared it. Never "all sessions by default".
2. **A non-suppressible indicator whenever anyone but the owner is attached.** Persistent status-bar chip naming every participant and their role (CyberArk's corner anchor, not a dismissible toast), *plus* an in-stream banner line written into the scrollback on join and leave (Teleport), so the fact of observation is in the transcript and any recording.
3. **Admins cannot suppress the indicator.** If an admin could turn it off, every other property in this list becomes theatre. Make it structurally impossible: the indicator is driven by the participant list the daemon already has to maintain, not by a flag.
4. **Observer is read-only by default.** Write requires request-and-approve (Warp/Live Share). If an "admin force-write" capability exists at all, it must be louder — a distinct indicator state and a distinct audit event.
5. **Explicit mode declaration on join** (Teleport). The joiner picks observer / participant before entry; the choice is displayed and logged.
6. **Scope limits, enforced server-side.** An admin sees only live sessions of members in their org; never personal (non-org) sessions; and **no retroactive scrollback** unless recording is separately enabled and separately disclosed. Live observation and historical recording are two different features with two different consent stories — do not let one silently imply the other.
7. **Monotonic scope hierarchy** (CyberArk): org policy may only *restrict* what a team policy allows; never the reverse. Build this in at the start; retrofitting override precedence is miserable.
8. **Append-only audit log**, on the VPS, covering `session.start / join / leave / end` with participants **and their modes**, plus a reason field where one was given. Emit the same events into the observed user's own local log, so they can see who watched them without asking the admin.
9. **A private-session escape hatch**, and the honest compromise that using it is itself logged. A member marking a session private is a legitimate act; a system where it is impossible is a system people will route around by using a different terminal.
10. **Notice, not in-product consent, is the legal instrument.** Under GDPR, employee consent is generally **not** a valid lawful basis (EDPB 05/2020) — the power imbalance invalidates it, and relying on it can hurt you. The basis is legitimate interests plus a documented proportionality test. Meanwhile NY Civil Rights Law §52-c requires written notice **on hiring** plus acknowledgement plus a conspicuously posted notice (any size private employer with a NY place of business), and Delaware allows either daily notice at point of access or one-time notice with acknowledgement. **Product implication:** ship org-level enrolment notice + acknowledgement capture with an exportable record, and treat the per-session banner as the "daily notice at point of access" option — not as a consent click.

### 6.3 The chat/transcript question

"Access any and all chats" is the harder half. Because chat is rendered from local JSONL transcripts (§1.6), admin chat visibility means transcript content leaves the member's machine. That is a materially bigger privacy step than watching a terminal — transcripts contain everything, including whatever was pasted into a prompt.

Minimum design if this is pursued: transcripts travel only for sessions already marked observable; the same indicator and audit rules apply; and secret redaction happens **before** transmission (Warp redacts API keys, passwords and SSH keys before anything leaves the client — copy that, and note TermX's own damage-control hooks already reflect this instinct).

---

## 7. Recommended phasing

**Phase 0 — Daemon authorization model (prerequisite for everything). Size: M.**
Per-connection principal; capability gating on `Input`, `Resize`, `CloseSession`, `Shutdown`, `SetLayout`; per-session ACL scaffold; resize policy; `Participants` presence message; generalize `handle_conn` off `TcpStream`. Ships standalone value (the daemon stops being a single all-powerful token) and is testable entirely locally with the existing e2e harness. **Do this first regardless of which candidate wins.**

**Phase 1 — Link-shared read-only view of one session. Size: M–L.**
`termx-relay` v1 on the VPS (register/join/resume, slug + capability tokens, expiry, revocation, viewer cap); daemon outbound relay client; web join page with xterm.js pinned to 6.0.0; `termx://` deep link; sharer-side participant list with one-click remove; in-stream join/leave banners. **Read-only only.** This is the "open a link that goes to the shared terminal" deliverable.

**Phase 2 — Multi-writer. Size: M.**
Separate writable credential (never a flag on the read-only one); viewer-requests / sharer-approves flow; owner keyboard always live; presence colours and last-typed attribution; inactivity ladder (Warp's 10/25/30 minute pattern is a good default). Optionally add sshx-style E2E here **if** Q3 resolves toward untrusted relay.

**Phase 3 — VPS-resident sessions. Size: L.**
Linux `termx-host` build; relay-fronted auth; the UI's "where does this session live" concept; bash/zsh profiles reusing the proven OSC 9;9 bootstrap; hardening and deployment. This is what makes same-session collaboration with Ibrahim real rather than dependent on Michael's laptop being awake.

**Phase 4 — Teams and admin visibility. Size: L.**
Orgs, membership, roles; admin session directory scoped to org members; the full §6.2 consent/indicator/scope/audit machinery built as requirements; enrolment notice and acknowledgement capture. Recording, if wanted, is a further increment with its own disclosure.

**Phase 5 (independent track) — Chat/transcript sharing. Size: L.**
Transcript tailing in the daemon, a transcript wire channel, redaction before transmission, and chat rendering for remote and shared panes. Can start any time after Phase 0; blocks the "admin sees chats" half of the goal.

**Rough cumulative:** a usable share link at the end of Phase 1 (~3 batches), real shared environment at the end of Phase 3 (~6–7 batches), teams at the end of Phase 4 (~9+).

---

## 8. What we may legally reuse — quick reference

| Source | License | Use |
|---|---|---|
| sshx | MIT | **Copy code.** Encryption scheme, chunk-index resume, protocol enums, ConPTY file. Keep the notice. |
| Zellij | MIT | **Copy code / patterns.** Token model, dual-channel split, session-URL semantics. |
| Upterm | Apache-2.0 | **Copy code.** Identity/pubkey allowlisting, per-connection host approval. Preserve NOTICE. |
| tty-share, ttyd, GoTTY | MIT | Copy freely. |
| tmate core | ISC/MIT (web component **unlicensed**) | Learn only in practice — C tmux forks; steal the reconnect-failover protocol design and the read-only-via-symlink idea. **Do not copy `tmate-websocket`.** |
| **Warp client + `session-sharing-protocol`** | **AGPL-3.0** | **Learn only.** Design, message semantics, role model, inactivity ladder. No code. |
| Warp `warpui`/`warpui_core` | MIT | Copyable, but it is a UI toolkit we do not need. |
| Teleport | AGPL-3.0 (+ restrictive CE binary licence) | **Learn only.** Best design reference for oversight; worst code reference. |
| VS Code Live Share / Server | Proprietary | Model only. |

---

## 9. Open questions Michael must answer

These are the forks. Several of them change the architecture, not just the roadmap.

**Q1 — Is the goal pairing or infrastructure?** "Show Ibrahim my terminal for an hour" (Candidate A is enough) or "Ibrahim and I share a machine that is always there" (Candidate B is mandatory and Phase 1 is a stepping stone, not the product)? The answer decides whether the Linux daemon is phase 3 or phase 1.

**Q2 — Who is the identity provider?** GitHub OAuth (recommended: zero password handling, Ibrahim almost certainly has an account, matches Upterm's prior art), Google, or home-grown accounts on the VPS? This decision leaks into every later teams feature and is expensive to change.

**Q3 — E2E or auditable? You cannot have both on the same session.** If the relay cannot decrypt (sshx model), it cannot record for admin oversight. Options: (a) no E2E, relay is trusted, audit works — simplest, and the relay is your own VPS; (b) E2E for peer shares, plaintext for org-observed sessions, with the session's mode visible to everyone in it; (c) E2E everywhere and admin oversight is *live-only* with no recording. **This is the single most consequential question in the document.**

**Q4 — How much admin power is actually wanted?** "See that work is progressing" (read-only observation with indicators — defensible, and ahead of the field on transparency) versus "see everything anyone has ever done" (recording, retroactive scrollback, transcripts — a surveillance product with real legal obligations)? These have very different designs and very different costs.

**Q5 — Who will actually be monitored, and where are they?** Employees vs. contractors vs. Ibrahim-as-a-peer changes the legal picture materially (NY §52-c, Delaware, and GDPR if anyone is in the EU). Also: is Ibrahim a *peer* or a *subordinate*? The current goal statement mixes collaboration and oversight, and they want different defaults.

**Q6 — Does chat sharing ship with terminal sharing, or later?** If phase 1 ships terminal-only, the UI must say so plainly, because a chat pane that silently shows nothing for a shared session will read as a bug.

**Q7 — Which VPS, and what is its blast radius?** Standing rule is that live VPSes are prod. If the relay lands on a box carrying client work, the security posture, backups and deployment story need to be settled before phase 1, not after. A dedicated box for the relay is the cheaper answer.

**Q8 — Read-only default for the *owner's own* second device?** Michael attaching from his phone to his own session is a different case from Ibrahim joining; same-identity multi-device (the VS Code Tunnels model) can skip most of the consent machinery and is worth carving out explicitly.

---

## Appendix — source pointers

**In-repo prior art (already committed, read these first):**
- `C:\Dev\TermX\docs\warp-study\report-collaboration.md` — deep dissection of Warp's shipped session sharing (transport, join, CRDT input, presence, roles, ordering, reconnect).
- `C:\Dev\TermX\docs\warp-study\report-remote-ssh.md` — why Warp's remote sessions do *not* survive client disconnect, and the ControlMaster bootstrap chain.
- `C:\Dev\TermX\docs\superpowers\specs\2026-08-17-ssh-sessions-design.md` — the shipped SSH model and the bash OSC 9;9 / 9;78 bootstrap.
- `C:\Dev\TermX\docs\superpowers\specs\2026-08-09-reliability-reconnect-design.md` — the reconnect supervisor this feature inherits.

**Code attach points:**
- `C:\Dev\TermX\host\src\protocol.rs` — the wire protocol to extend.
- `C:\Dev\TermX\host\src\server.rs` — `run` (bind/token/runtime.json), `handle_conn` (auth gate, dispatch, capability gaps), `forward_session` (the fan-out to generalize).
- `C:\Dev\TermX\host\src\session.rs` — the only Windows-bound file (6 `windows-sys` lines).
- `C:\Dev\TermX\host\src\registry.rs` — session ownership, layout, persistence.
- `C:\Dev\TermX\ui\src\host\client.ts` / `reconnect.ts` — the client half.
- `C:\Dev\TermX\ui\src-tauri\src\chat_feed.rs` — the local-file transcript tail that chat sharing has to replace.
- `C:\Dev\TermX\ui\src\ssh\bootstrap.ts` — the proven remote bash hook payload a Linux daemon can reuse.

**External:**
- sshx — https://github.com/ekzhang/sshx (MIT); crypto in `crates/sshx/src/encrypt.rs` + `src/lib/encrypt.ts`; read-only gating in `crates/sshx-server/src/web/socket.rs`.
- Zellij web client — https://zellij.dev/documentation/web-client, https://poor.dev/blog/building-zellij-web-terminal/ (MIT).
- Upterm — https://github.com/owenthereal/upterm (Apache-2.0).
- tmate architecture paper — https://viennot.com/tmate.pdf (the best single architecture document in the field).
- Warp — https://www.warp.dev/blog/warp-is-now-open-source, https://github.com/warpdotdev/warp/blob/master/FAQ.md, https://github.com/warpdotdev/session-sharing-protocol, https://docs.warp.dev/agent-platform/local-agents/session-sharing/, https://docs.warp.dev/enterprise/team-management/roles-and-permissions/
- Third-party self-hosted Warp relay (shows how dumb a relay can be) — https://github.com/b1nhm1nh/warp-server (AGPL-3.0).
- VS Code Live Share security — https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/security
- Teleport moderated sessions & recording — https://goteleport.com/docs/zero-trust-access/authentication/joining-sessions/, https://goteleport.com/docs/reference/architecture/session-recording/
- CyberArk live session monitoring — https://docs.cyberark.com/pam-self-hosted/latest/en/content/pasimp/configuring-live-session-monitoring.htm
