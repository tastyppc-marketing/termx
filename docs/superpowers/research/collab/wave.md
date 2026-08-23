# Wave Terminal — session sharing study

**Product:** Wave Terminal (`github.com/wavetermdev/waveterm`), by Command Line Inc.
**Stack:** Go backend (`wavesrv`) + Electron main (`emain`) + React/Jotai/xterm.js renderer.
**Studied:** 2026-08-22, against `main`.
**Report author's TL;DR:** Wave has **no session sharing and no multiplayer, at all**. What it *does*
have — and the reason it is worth this much of our time — is the single best open-source reference
for the exact thing TermX is: a daemon-backed terminal with detach/reattach over a byte-sequenced
stream, an ACK-flow-controlled ring buffer, and a routed RPC layer that works identically over
websocket, unix socket and SSH. Its durable-job subsystem is essentially "TermX's host, but for
remote hosts, in Go, on Unix". Steal the protocol, not the product.

---

## 1. License verdict

| Item | Finding |
|---|---|
| License | **Apache-2.0**, single `LICENSE` at repo root — verified by fetching the file; header reads "Apache License, Version 2.0, January 2004". |
| Per-file SPDX | Every Go file studied carries `// SPDX-License-Identifier: Apache-2.0` and `// Copyright 2025/2026, Command Line Inc.` — verified in `pkg/authkey`, `pkg/jobmanager`, `pkg/jobcontroller`, `pkg/wavejwt`. |
| Sub-licenses | None. `gh api search/code … filename:LICENSE` returns exactly one path. There is a root `NOTICE` containing only `Copyright 2025, Command Line Inc.` — verified. |
| Trademark | Apache-2.0 §6 grants no trademark rights. "Wave" / "Wave Terminal" naming stays theirs. |

**Verdict: TermX MAY borrow code.** Apache-2.0 is compatible with essentially any TermX licensing
choice. Obligations if we copy anything verbatim or adapt it closely:

1. Keep the Apache-2.0 license text available (a `licenses/` or `THIRD-PARTY` file in TermX).
2. Preserve the `Copyright … Command Line Inc.` + SPDX headers on borrowed files.
3. **Mark modifications** ("prominent notices stating that You changed the Files").
4. Reproduce the `NOTICE` content in our distribution.

Practically: the algorithms here (ring + ACK window + seq resume) are a page of ideas, not a page of
Go. Porting the *design* to Rust is a clean-room rewrite that carries no obligation. My
recommendation is **learn-and-reimplement**, with the option to lift `cirbuf.go` / `streammanager.go`
verbatim-and-attributed if we ever want a Go-side agent.

---

## 2. Does Wave have session sharing? (the direct question)

**No.** Established by four independent checks:

* `gh search code --repo wavetermdev/waveterm "sharing"` → 3 hits, none relevant: a README line about
  "sharing data between terminal sessions" (that is `wsh setvar`/`wsh file`, a key-value store), an
  Electron comment about renderers sharing an origin, and an AI-prompt doc listing "Collaboration /
  sharing" as an example of a *thing to build with the widget framework*. **Verified.**
* `"collaborat"` → 1 hit, the same AI-prompt doc. **Verified.**
* `ROADMAP.md` contains no sharing, collaboration, multiplayer, cloud-sync or tunnel item. Fetched
  and checked. **Verified.**
* No invite/link/token/participant/permission concept exists anywhere in `pkg/`. The 51 packages are
  listed below; none is a sharing subsystem. **Verified.**

The only thing that even smells multiplayer:

* **Multi-input** (`tabModel.isTermMultiInput`, `termwrap.multiInputCallback`) — a local
  broadcast-typing toggle. One human's keystrokes are mirrored into every terminal block in the
  current tab, iTerm2-style. Single user, single machine, no network. **Verified** from
  `frontend/app/store/tab-model.ts`, `frontend/app/view/term/term.tsx`, `termwrap.ts`, `keymodel.ts`.
* **Workspaces are single-window.** The docs state that selecting a workspace already open in another
  window just focuses that window. So even two *local* frontends never render the same tab
  concurrently. **Verified** (`docs/docs/workspaces.mdx`).
* **Cloud is future/paid.** Public statements (FAQ/site) say terminal sharing, shared workspaces and
  backup/sync may arrive as opt-in paid team features. Nothing is in the repo. **Verified as a
  statement; unbuilt.**

So: there is no join flow, no share link, no token minting for guests, no read-only mode, no
presence, no multi-writer arbitration. Sections that would normally cover those are answered below in
terms of the *nearest structural analogue Wave does have* — the attach/reattach model — because that
is the part TermX must get right first anyway.

---

## 3. Architecture (verified from source unless marked)

### 3.1 Processes and trust boundary

```
Electron main (emain)  ──spawns──▶  wavesrv (Go)
   │  generates AuthKey = crypto.randomUUID() per launch          [verified emain/authkey.ts]
   │  passes it in env WAVETERM_AUTH_KEY                          [verified emain-wavesrv.ts]
   │  injects X-AuthKey header into renderer requests             [verified emain.ts, emain-tabview.ts]
   │  exposes it to renderer via ipc "get-auth-key"               [verified preload.ts]
   ▼
renderer (React) ──WebSocket /ws?stableid=…, X-AuthKey──▶ wavesrv
                 ──HTTP /wave/… , X-AuthKey──────────────▶ wavesrv
```

`wavesrv` listens on **`127.0.0.1:` with an ephemeral port** (`MakeTCPListener`, verified
`pkg/web/web.go:421-427`) plus a **unix domain socket chmod 0700** (`MakeUnixListener`, verified
`web.go:431-439`). `SetAuthKeyFromEnv()` reads the key then **`os.Unsetenv`s it** so it does not leak
to child processes (verified `pkg/authkey/authkey.go`). Every HTTP and WS request is gated by:

```go
func ValidateIncomingRequest(r *http.Request) error {
    reqAuthKey := r.Header.Get(AuthKeyHeader)   // "X-AuthKey"
    if reqAuthKey == "" { return fmt.Errorf("no x-authkey header") }
    if reqAuthKey != GetAuthKey() { return fmt.Errorf("x-authkey header is invalid") }
    return nil
}
```

Note `CheckOrigin` returns `true` unconditionally (verified `pkg/web/ws.go`) — safe only because the
listener is loopback and the shared secret is per-launch and never written to disk. **Inferred:** any
attempt to expose this port beyond loopback inherits a CSRF-ish exposure and a static bearer secret.

### 3.2 Frontend ↔ backend protocol

Two channels over one websocket, plus a code-generation pipeline:

* **wshrpc** — request/response + streaming RPC. A single Go interface `WshRpcInterface` is the source
  of truth; `cmd/generate` emits `wshclient.go` (Go), `gotypes.d.ts` and `wshclientapi.ts` (TS). One
  command definition, three type-checked call sites. **Verified** via DeepWiki + the presence of
  `pkg/gogen`, `pkg/tsgen`, `pkg/wshrpc/wshclient`.
* **wps (Wave Pub-Sub)** — event broadcast. `wps.Broker.Publish(WaveEvent{Event, Scopes, Data})`;
  subscribers register per event with either `AllScopes: true` or a scope list, and scopes support
  `*` / `**` wildcards over a `:`-delimited path (`getMatchingRouteIds`, `StarMatchString`).
  Events can set `Persist > 0` for a capped replayable history (`MaxPersist = 4096`). **Verified**
  from `pkg/wps/wps.go`.

Terminal output is *not* pushed as a bespoke terminal message. It is pushed as a **filesystem event**:

```go
filestore.WFS.AppendData(ctx, blockId, "term", data)
wps.Broker.Publish(wps.WaveEvent{
    Event:  wps.Event_BlockFile,
    Scopes: []string{oref.String()},              // e.g. "block:<uuid>"
    Data:   &wps.WSFileEventData{ZoneId, FileName: "term", FileOp: FileOp_Append, Data64: …},
})
```
**Verified** (`pkg/jobcontroller/jobcontroller.go:774-792`, `pkg/blockcontroller/blockcontroller.go`).
This is the key architectural move: *the terminal is a file, and the live stream is the file's append
event.* Any number of subscribers to that scope get the bytes; scrollback and live output are the
same object.

### 3.3 The store: WaveFS, a zoned file store with circular files

`pkg/filestore` is a SQLite-backed store of **zones** (a zone == a block id or job id) each holding
named files, chunked into `DefaultPartDataSize = 64 * 1024` parts, with lazy part loading so appends
do not read the whole file. Files can be declared `Circular` with a `MaxSize`; for those,
`DataLength() = min(Size, MaxSize)` and `DataStartIdx()` returns the offset of the oldest surviving
byte, so **logical offsets keep increasing forever while storage stays bounded**. Constraints
enforced: a circular file must have a max size and cannot be ijson. **Verified** from
`pkg/filestore/blockstore.go`. Job terminal files are created as
`FileOpts{MaxSize: 10 * 1024 * 1024, Circular: true}` — verified `jobcontroller.go:683-690`.

### 3.4 Frontend attach / scrollback restore

`frontend/app/view/term/termwrap.ts`:

* `loadInitialTerminalData()` reads two files — a serialized xterm state cache (`cache:term:full`,
  whose metadata carries `ptyoffset`) and then the live `term` file *from that offset*. If the cached
  terminal geometry differs from current, it temporarily resizes, writes, and resizes back so the
  reflow is correct.
* Then it subscribes: `mainFileSubject.subscribe(handleNewFileSubjectData)` — appends are written to
  xterm, truncates clear it.
* `processAndCacheData()` periodically calls `serializeAddon.serialize()` and
  `BlockService.SaveTerminalState()` to refresh the cache + `ptyoffset`.
* `handleResize()` sends `RpcApi.ControllerInputCommand()` and, on first resize, `resyncController()`.
* `TermResyncHandler` re-syncs whenever connection status flips.

**Verified.** Note what this buys: reopening a window does not replay 10 MB through xterm's parser —
it restores a *rendered snapshot* and replays only the delta. That is a materially better UX than
raw-replaying the ring, and TermX does not do it.

### 3.5 The durable-session subsystem (the part worth copying)

This is Wave's answer to "my shell must survive the app closing". Crucially it exists **only for
remote connections**:

`IsBlockTermDurable()` (verified `jobcontroller.go:1348-1391`) — a 3-level config cascade:
block meta `term:durable` → connection config → global setting → **default `true` for non-local**;
local and WSL connections are hard-excluded. So a local Wave terminal still dies with the app.

Topology:

```
wavesrv (local, "main server")                    remote host (over SSH)
  jobcontroller ──RemoteStartJobCommand──▶ wsh agent ──▶ JobManager (daemonized)
       ▲                                                   │  JobCmd (pty + shell)
       │  CommandStreamData{Id, Seq, Data64}               │  StreamManager
       └──CommandStreamAckData{Id, Seq, RWnd, Fin}─────────┘  CirBuf (2 MB)
```

* `JobManager` daemonizes on the remote box and listens on a **unix domain socket** at
  `wavebase.GetRemoteJobSocketPath(jobId)` under `/tmp/waveterm-<uid>/` (mode 0700 dir). Reattach =
  a new RPC connection to that socket. **Verified** `pkg/jobmanager/jobmanager.go:379-412`.
* Unix only: `SetupJobManager` returns `"job manager only supported on unix systems"` for other GOOS,
  and `jobmanager_windows.go` is a stub whose `daemonize` returns
  `"daemonize not supported on windows"`. **Verified.** *(Relevant to us: there is no Windows prior
  art here to lean on. TermX is on its own — as it already knew.)*
* Identity: the job gets a random 32-hex `JobAuthToken` **plus** an ed25519-signed JWT
  (`wavejwt.Sign`) with scoped claims:
  ```go
  type WaveJwtClaims struct {
      jwt.RegisteredClaims
      MainServer bool; Sock string; RouteId string; ProcRoute bool
      BlockId string; JobId string; Conn string; Router bool
  }
  ```
  The main server signs; the remote verifies with the public key it was handed at start
  (`PublicKeyBase64` in `CommandRemoteStartJobData`). Default expiry if unset:
  `time.Now().Add(time.Hour * 24 * 365)`. **Verified** `pkg/wavejwt/wavejwt.go`,
  `jobcontroller.go:635-707`.

#### The stream protocol — this is the gem

`pkg/jobmanager/streammanager.go` + `cirbuf.go`. **Verified line by line.**

```go
const (
    CwndSize      = 64 * 1024       // send window while a client is connected
    CirBufSize    = 2 * 1024 * 1024 // max buffer while disconnected
    DisconnReadSz = 4 * 1024
    MaxPacketSize = 4 * 1024        // max data bytes per packet
)
```

* **Dual-mode ring.** `CirBuf.SetEffectiveWindow(syncMode, windowSize)`:
  * **Connected → sync mode**, window = `min(cwnd, rwnd)`. When the window is full, `WriteAvailable`
    returns `(0, waitCh)` and the PTY read loop **blocks**. Backpressure propagates into the shell.
    **Zero data loss while a client is attached.**
  * **Disconnected → async mode**, window = full 2 MB. Writes never block; the oldest bytes are
    silently dropped (`readPos` advances). **Bounded loss while detached, and the shell keeps
    running.**
  This single toggle is the whole "don't lose output vs. don't wedge the shell" tradeoff, resolved
  correctly per connection state.
* **Absolute byte sequence numbers.** `HeadPos() = totalSize - count`. Every `CommandStreamData`
  carries `Seq` = the absolute stream offset of its first byte.
* **ACK-based flow control.** `RecvAck(CommandStreamAckData{Id, Seq, RWnd, Fin})` consumes the ring up
  to `Seq`, updates the receive window, and ignores stale/out-of-order ACKs via a
  **`(seq, rwnd)` tuple comparison** — `if seq < maxAckedSeq || (seq == maxAckedSeq && rwnd <= maxAckedRwnd) { return }`.
  A pure-seq check would drop legitimate window-only updates; a pure-rwnd check would accept
  reordered stale acks. Small detail, exactly right.
* **Terminal event as an in-band, ACKed packet.** EOF/error is recorded once at a fixed `eofPos`, sent
  as a packet with `Eof`/`Error` set, and only when the client ACKs with `Fin: true` does the stream
  become `terminalEventAcked` and the manager shut down. **Exit is delivered, not raced.**
* **Resume with gap accounting.** On reattach the client computes its cursor from durable state:
  ```go
  currentSeq = waveFile.Size + getMetaInt64(waveFile.Meta, "totalgap")
  ```
  and sends it in `JobPrepareConnectData{StreamMeta, Seq, TermSize}`. Server side
  (`ClientConnected`): if `clientSeq > headPos` it consumes the already-delivered bytes; if the ask
  is beyond the buffer it errors
  (`"client seq %d is beyond our stream end (head=%d, size=%d)"`). If the server's returned start seq
  is **ahead** of the client's cursor, the client records the difference as a **gap**, adds it to a
  persisted `totalgap` file-meta counter, and calls `reader.UpdateNextSeq(rtnData.Seq)`:
  ```go
  if rtnData.Seq > currentSeq {
      gap := rtnData.Seq - currentSeq
      totalGap += gap
      filestore.WFS.WriteMeta(ctx, jobId, "term", FileMeta{MetaKey_TotalGap: totalGap}, true)
      reader.UpdateNextSeq(rtnData.Seq)
  }
  ```
  So the local compacted file stays a valid cursor basis across an unbounded number of lossy
  disconnects. **Verified `jobcontroller.go:1236-1326`.**
* **Two-phase, "corked" attach.** `JobPrepareConnect` is sent with `StreamMeta.RWnd = 0` — the stream
  is wired up but the window is zero, so **no data flows yet**. The response carries the agreed start
  seq, `StreamDone`/`StreamError`, and `HasExited`/`ExitCode`/`ExitSignal`. The client handles all of
  that, sets up its output loop, and only then sends `JobStartStreamCommand`, which calls
  `SetRwndSize(rwnd)` and opens the tap. **Verified `jobmanager.go:308-377`, `jobcontroller.go:1252-1341`.**
  This removes the entire class of "output arrived before the UI was ready" races.
* **Reconnection policy** lives in the controller, not the transport: `AutoReconnectDelay = 1s`,
  `AutoReconnectCooldown = 30s`, `singleflight.Group` to dedupe concurrent reconnect attempts, a
  `connReconcileWorker` driven by `Event_RouteUp` / `Event_RouteDown` / `Event_ConnChange` /
  `Event_BlockClose`, and a `jobPruningWorker` that garbage-collects jobs no block references.
  **Verified `jobcontroller.go:43-137, 240-420`.**
* **UX honesty on reattach:** `writeSessionSeparatorToTerminal(blockId, cols)`,
  `writeMutedMessageToTerminal`, `writeJobTerminationMessage`, `resetTerminalState` — the terminal
  itself gets a visible separator/notice when a session is (re)started or the job dies. **Verified**
  (function definitions at `jobcontroller.go:1541-1615`).

### 3.6 Ownership semantics — single attached client, explicitly enforced

Two independent places enforce "exactly one":

```go
// pkg/jobmanager/jobmanager.go:211
func (jm *JobManager) SetAttachedClient(msc *MainServerConn) {
    jm.lock.Lock(); defer jm.lock.Unlock()
    if jm.attachedClient != nil {
        log.Printf("SetAttachedClient: kicking out existing client\n")
        jm.attachedClient.Close()
    }
    jm.attachedClient = msc
}
```
and `connectToStreamHelper_withlock` disconnects any existing stream client and detaches the old
stream writer before connecting the new one. **Verified.**

On the websocket side, `registerConn()` keys connections by a client-supplied `stableid` query param
into `RouteToConnMap map[string]*StableConnInfo{ConnId, LinkId}` and logs
*"replacing existing connection for stableid"* when a second connection arrives with the same id —
one live socket per stable identity, reconnects transparently take over the route. Keepalive:
`wsInitialPingTime 1s`, `wsPingPeriodTickTime 10s`, `wsReadWaitTimeout 15s`,
`wsWriteWaitTimeout 10s`, `WebSocketChannelSize 128`. **Verified `pkg/web/ws.go`.**

**Presence / multi-writer semantics: none.** Last attacher wins, previous is kicked and logged. Which
is the honest answer for a single-user product — and it is the right *default* for TermX's collab
too, with sharing built as an explicit widening of it.

### 3.7 Routing — one RPC surface, many transports

`WshRouter` switches on route-id prefixes: `conn:` (SSH/WSL), `controller:` (block controllers),
`tab:`, `feblock:` (frontend blocks), `job:`. Routes are announced dynamically via
`RouteAnnounceCommand`, and route up/down are published as `wps` events that the job controller
listens to. Transports: websocket (`gorilla/websocket`), unix domain socket (for `wsh` and remote
agents, with symlink management so socket paths are stable), SSH tunnel, and stdio.
**Verified structurally** (`pkg/wshutil/wshrouter.go`, `wshproxy.go`, `wshadapter.go`,
`wshstreamadapter.go` exist; prefixes and announce confirmed via DeepWiki + `MakeJobRouteId`,
`MakeConnectionRouteId` call sites in `jobcontroller.go`).

Consequence: `wshclient.JobPrepareConnectCommand(bareRpc, data, &RpcOpts{Route: MakeJobRouteId(jobId)})`
is the *same call* whether that job is on localhost or three SSH hops away. **The caller never learns
where the session lives.**

---

## 4. Join/share flow — N/A, and the nearest analogue

There is no link, no token minting for a guest, no expiry, no read-only mode, no enforcement point,
because there is no guest. The identity model that *does* exist, and that a sharing feature would
have to be grafted onto, is:

| Boundary | Credential | Enforcement point | Expiry |
|---|---|---|---|
| renderer → wavesrv (loopback) | random UUID `AuthKey`, per app launch, env-passed then unset, never on disk | `authkey.ValidateIncomingRequest` on every HTTP + the `/ws` upgrade | process lifetime |
| wavesrv → remote agent/job | ed25519 JWT with scoped claims (`JobId`, `BlockId`, `RouteId`, `Conn`, `MainServer`) + a 32-hex per-job `JobAuthToken` | `wavejwt.Verify` on the remote using the pinned public key | `ExpiresAt` if set, else **1 year** default |

The good idea to take: **two different credential kinds for two different blast radii** — a cheap
symmetric secret for the same-machine, same-user channel; an asymmetric, *capability-scoped* token
for anything crossing a machine boundary. The bad idea to leave: a 1-year default expiry on a
capability token.

---

## 5. Self-hosting the server side on the owner's VPS

**Assessment: don't. And Wave's own architecture is the argument for why.**

Could you run `wavesrv` headless on a VPS and point a client at it? Mechanically almost: it is a Go
binary speaking websocket, and `CheckOrigin` already returns true. But:

* It binds `127.0.0.1:<ephemeral>` and a 0700 unix socket. There is no configurable bind address, no
  TLS, no reverse-proxy story. **Verified `web.go:421-439`.** You would be SSH-tunnelling to it,
  which is fine, but that is not "hosting a service".
* Authorization is one process-wide shared secret. There is no user concept, no per-session ACL, no
  way to hand someone access to session 3 and not session 5. Anyone with the key has everything —
  including `wsh` file/command RPCs over the same channel.
* State is a single-tenant SQLite DB + WaveFS zones keyed by client id (`wstore.GetClientId()`), with
  telemetry and config assuming one desktop user.
* The frontend is an Electron app; the renderer obtains the key over Electron IPC. There is no
  browser-served build.

**The far more interesting finding is that Wave deliberately inverts the topology.** The fat server
stays on the *user's* machine; what goes to the remote host is a thin `wsh` agent pushed over SSH,
which daemonizes a `JobManager` per session on a unix socket. No service to install, no port to
expose, no cert, no inbound firewall rule, and it degrades to "your session is still there" rather
than "your server is down". For TermX's VPS-resident-sessions goal that is a genuinely serious
alternative to "run termx-host on the VPS and connect to it": **push the host binary over SSH on
demand, keep the control plane local.**

---

## 6. Principles TermX should steal, and how they map onto our host

TermX today (verified from `C:\Dev\TermX\host\src`): `ring.rs` is a `VecDeque<u8>` with `cap` and
`total_written`, giving absolute offsets and `snapshot() -> (start_offset, bytes)`; `session.rs`
fans out via `broadcast::Receiver<OutputChunk>` and spills evicted bytes to `history.rs`;
`protocol.rs` has `ClientMsg::Attach { session_id, replay, since_offset }` and
`HostMsg::Replay { start_offset, data_b64 }` with a documented forward-gap contract. We are closer to
Wave's job-manager design than to anything else in this study. The gaps are specific.

### 1. Make the ring dual-mode: block the PTY while someone is attached, drop only while nobody is

Wave's `CirBuf.SetEffectiveWindow(syncMode, windowSize)` is the whole idea. Attached ⇒ sync mode with
a 64 KB window, the PTY reader blocks, **no byte is ever lost to a live viewer**. Detached ⇒ async
mode with the full 2 MB, writes never block, oldest bytes drop.

TermX today is async-always: `push_evicting` never blocks, so a lagging client eats an offset jump and
our own `protocol.rs` doc-comment tells clients to treat it as lost scrollback. That is the correct
*fallback*, but it should not be the *normal* path for an attached client — it is exactly the
"terminal ate my build output" class of bug, and it will get worse the moment a second (remote,
higher-latency) viewer is attached.

**Map:** add an effective-window + parked-waker to `RingBuffer`, and have the PTY read loop in
`session.rs` await it. Window = `min(cwnd, min(rwnd of all attached clients))`. When the last client
detaches, flip to async so a background build never wedges. Our disk spill in `history.rs` means we
keep the scrollback either way — we are only choosing whether the *live* stream is lossy.

### 2. Two-phase corked attach: agree the cursor and the exit status before any byte flows

`JobPrepareConnect` (RWnd = 0) → response carries `{Seq, StreamDone, StreamError, HasExited,
ExitCode, ExitSignal}` → client wires up → `JobStartStream` opens the window.

TermX's `Attach` is one-shot: the host decides and starts firing `Replay` + live binary frames. There
is no point at which the client can say "I know where I am, and I know whether this shell is already
dead — now start". Session exit is a separate `SessionExited` message racing the output stream.

**Map:** split `ClientMsg::Attach` into `Attach` (returns a new `HostMsg::AttachReady { session_id,
start_offset, alive, exit_code, ring_start, ring_end }`, sends nothing else) and
`ClientMsg::StartStream { session_id, rwnd }`. This also gives us the natural place to put a
**read-only flag and a lease decision** when collab lands — the handshake already exists.

### 3. Sequence-ACK flow control with stale-ACK rejection, and a persisted gap counter

Client ACKs `{seq, rwnd}`; server consumes the ring to `seq` and rejects stale acks on the
**`(seq, rwnd)` tuple**; a forward jump is recorded as a gap and **persisted** so the resume cursor
arithmetic survives arbitrarily many lossy disconnects (`MetaKey_TotalGap`).

TermX has offsets but no ACKs — the host cannot know what the client actually rendered, which is
precisely why it cannot apply backpressure (steal #1 depends on this one). Our gap situation is
better than Wave's by construction: we spill evicted bytes to disk, so an offset is always a true
position in the full stream and no `totalgap` fudge is needed. Keep that advantage; just add the ACK.

**Map:** a third binary frame tag `TAG_ACK { session_id, seq, rwnd }` alongside `TAG_OUTPUT`/
`TAG_INPUT`, and per-connection ack state in `server.rs::Outbound`. Reject stale on the tuple.

### 4. Exit is an in-band, ACKed terminal packet — not a side-channel event

Wave fixes `eofPos` at EOF, emits it as a packet at that exact sequence position, and only tears the
stream down after the client ACKs `Fin: true`. The client therefore learns the exit code *at the
right position in the byte stream*, after every preceding byte.

TermX sends `HostMsg::SessionExited` as an independent JSON message, which can (and under lag will)
land before the tail of the output it belongs after. Users read this as "the terminal lost the last
few lines of the failing build".

**Map:** carry exit as `HostMsg::Replay`-adjacent terminal marker at `end_offset`, or a
`TAG_EXIT { session_id, offset, exit_code }` binary frame, and only reap the session's broadcast
channel once every attached client has ACKed past it (with a timeout).

### 5. One RPC surface, route-addressed, transport-agnostic — decide this before SSH lands

`RpcOpts{Route: MakeJobRouteId(jobId)}` is identical for a local job and one behind two SSH hops;
`WshRouter` resolves prefix → transport, routes announce themselves, and route-up/route-down are
ordinary pub-sub events that the reconnect logic subscribes to. Wave gets local, WSL and SSH sessions
from one code path because addressing was separated from transport on day one.

TermX's `SessionId` is a bare `u32` scoped to one host process. The moment sessions live on a VPS —
and certainly the moment a shared session lives on someone *else's* host — that becomes ambiguous.

**Map:** introduce a route/address type now (`local:`, `ssh:<conn>:`, and later `share:<id>:`),
thread it through `ClientMsg`, and make the UI address sessions by it. Also worth copying wholesale:
publishing connection up/down as events and driving reconnect from them via a reconcile worker with
a delay + cooldown + singleflight dedupe (`AutoReconnectDelay 1s`, `AutoReconnectCooldown 30s`) —
that is a solved-problem shape for our known WS-reconnect adoption blocker.

### Bonus (cheap, high-visible-value)

* **Serialized-screen snapshot cache.** Wave caches `serializeAddon.serialize()` + `ptyoffset` and
  restores *that* plus the delta, instead of replaying megabytes through the parser. On a 10 MB ring
  this is the difference between an instant reattach and a visible chug. TermX replays raw bytes today.
* **Write a visible separator into the terminal on reattach/session-restart/job-death.** Users forgive
  a gap they were told about.
* **Durability as a 3-level cascade** (per-session meta → per-connection → global, with a sane
  default). We will want exactly this shape for "which sessions are shareable", and it is worth
  copying the *shape* rather than inventing a flat toggle.

---

## 7. Teams / roles / admin / consent relevance

Close to nil, and that is itself a data point: a well-built, well-funded terminal shipped
detach/reattach, remote agents and durable sessions **without ever introducing a second human**. The
only transferable pieces are (a) the two-tier credential model of §4 — cheap secret inside the trust
boundary, scoped signed capability across it, which is the right skeleton for a share token carrying
`{session_id, mode: ro|rw, exp}`; and (b) the single-attached-client invariant of §3.6, enforced in
one place, logged when it kicks. Wave's honest default ("one writer, last attacher wins, say so in the
log") is the correct base case for TermX collab, with read-only observers added as a widening and a
write lease as an explicit, revocable grant. There is no consent flow, no participant list, no admin
surface, and no audit trail to learn from here.

---

## 8. Sources

Verified by direct fetch of source at `main`:

* `LICENSE`, `NOTICE` — https://raw.githubusercontent.com/wavetermdev/waveterm/main/LICENSE
* `ROADMAP.md` — https://raw.githubusercontent.com/wavetermdev/waveterm/main/ROADMAP.md
* `pkg/authkey/authkey.go`, `pkg/web/ws.go`, `pkg/web/web.go`
* `pkg/jobmanager/jobmanager.go`, `streammanager.go`, `cirbuf.go`, `jobmanager_windows.go`
* `pkg/jobcontroller/jobcontroller.go`
* `pkg/wavejwt/wavejwt.go`
* `pkg/blockcontroller/blockcontroller.go`, `durableshellcontroller.go`
* `pkg/filestore/blockstore.go`, `pkg/wps/wps.go`
* `frontend/app/view/term/termwrap.ts` (via DeepWiki + code search)
* Code search: `gh search code --repo wavetermdev/waveterm` for `sharing`, `collaborat`, `multiinput`,
  `termdurable`, `stableid`, `AuthKey`

Secondary / structural (used where source was not read line-by-line, marked inferred above):

* DeepWiki — https://deepwiki.com/wavetermdev/waveterm/2.3-client-server-communication
* DeepWiki — https://deepwiki.com/wavetermdev/waveterm/4.1-terminal-blocks
* DeepWiki — https://deepwiki.com/wavetermdev/waveterm/3-block-system
* Wave docs — https://docs.waveterm.dev/connections , https://docs.waveterm.dev/releasenotes
* Wave FAQ (legacy docs) — https://legacydocs.waveterm.dev/reference/faq (cloud/team features stated
  as future, opt-in, paid)
* `docs/docs/workspaces.mdx` in-repo (workspace is single-window)

Local files referenced for the mapping in §6: `C:\Dev\TermX\host\src\ring.rs`,
`C:\Dev\TermX\host\src\protocol.rs`, `C:\Dev\TermX\host\src\session.rs`,
`C:\Dev\TermX\host\src\registry.rs`, `C:\Dev\TermX\host\src\server.rs`.
