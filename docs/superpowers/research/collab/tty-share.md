# tty-share — session sharing study

**Product:** [tty-share](https://github.com/elisescu/tty-share) (client + embedded server) and [tty-proxy](https://github.com/elisescu/tty-proxy) (the public relay)
**Author:** Elis/Vasile Popescu · **Language:** Go · **Studied at:** tty-share `master` (v2.4.1, last push 2025-09-03, 998★) and tty-proxy `master` (last push 2023-09-16, 56★)
**Date of study:** 2026-08-22
**Method:** full source read of both repos (files downloaded from `raw.githubusercontent.com`), plus repo metadata and issue archaeology via `gh api`. Every claim below is marked **[verified]** (read in source) or **[inferred]** (reasoned from source but not directly stated).

---

## 1. License verdict

| Repo | License | File |
|---|---|---|
| `elisescu/tty-share` | **MIT** — "Copyright (c) 2019 Vasile Popescu" | `LICENSE` **[verified]** |
| `elisescu/tty-proxy` | **MIT** — "Copyright (c) 2020 Elis Popescu" | `LICENSE` **[verified]** |

GitHub's own license detection reports `MIT` (SPDX) for both **[verified via `gh api`]**.

**Verdict: TermX may borrow code, not just learn from it.** MIT permits use, modification and redistribution in a closed or open product, with one obligation: reproduce the copyright notice and permission text. Practically, for TermX:

- Porting Go → Rust is a derivative work in spirit; the safe and cheap move is to add both notices to a `THIRD-PARTY-NOTICES.md` / `licenses/` folder with a line naming what was derived (e.g. "relay handshake and yamux stream-per-request design derived from elisescu/tty-proxy, MIT").
- No copyleft, no patent grant, no attribution-in-UI requirement.
- Watch the transitive deps if you ever vendor Go code: `hashicorp/yamux` is **MPL-2.0** (file-level copyleft — fine to link, but modified yamux files must stay open). TermX would use the Rust `yamux` crate instead (Apache-2.0/MIT), so this is moot for a port. **[verified: `vendor/github.com/hashicorp/yamux/LICENSE` present in both repos]**

---

## 2. Architecture

### 2.1 The one-sentence version

**The relay is a dumb byte pipe; the sharer's own machine is the web server.** `tty-share` embeds a complete HTTP + WebSocket server that serves the xterm.js page and the terminal stream. When you want a public URL, it opens a single outbound TCP connection to `tty-proxy` and multiplexes the relay's inbound HTTP requests back over that one connection with yamux. `tty-proxy` never parses HTTP semantics, never knows what a terminal is, and stores nothing.

### 2.2 Two modes

**Local mode (no relay)** **[verified: `main.go`, `server/server.go`]**
`tty-share` spawns the command on a PTY, starts `http.Server` on `localhost:8000`, and prints `http://localhost:8000/s/local/`. Anyone who can reach that address gets the terminal. That is the entire mechanism.

**Public mode (`--public`)** **[verified: `proxy/proxy.go`, tty-proxy `server.go`]**

```
   sharer's machine                          VPS
 ┌────────────────────────┐        ┌──────────────────────────┐        browser
 │ tty-share              │        │ nginx (TLS term.)        │      ┌─────────┐
 │  ├ ptyMaster (PTY)     │        │  :443 http ─┐            │      │xterm.js │
 │  ├ ttyShareSession     │        │  :4567 tcp ─┼─ stream    │      └────┬────┘
 │  │   (fan-out list)    │        │             │  module    │           │
 │  └ http.Server ────────┼──┐     │             ▼            │  GET /s/<id>/
 │      /s/<id>/          │  │     │  ┌────────────────────┐  │           │
 │      /s/<id>/ws/       │  └────►│  │ tty-proxy          │◄─┼───────────┘
 │      /s/<id>/tws       │  one   │  │  map[id]→yamux.Sess│  │
 └────────────────────────┘  TCP   │  └────────────────────┘  │
                            (TLS)  └──────────────────────────┘
```

### 2.3 The relay protocol, in full

This is small enough to state exhaustively. **[all verified: `proxy/proxy.go` + tty-proxy `server.go`]**

1. **Dial.** `tty-share` dials the relay's *back address* (`on.tty-share.com:4567` by default) with `tls.Dial` using the system cert pool, or plain `net.Dial` under `--no-tls`. Hostname verification is on (ServerName inferred from the dial address).

2. **Handshake — two JSON objects, one each way, then never again:**
   ```go
   // client → server
   type HelloClient struct { Version string; Data string }   // {"Version":"1","Data":"-"}
   // server → client
   type HelloServer struct { Version, SessionID, PublicURL, Data string }
   ```
   The relay generates the session ID *before* reading the hello, from `crypto/rand`: **50 random bytes → `base64.RawURLEncoding` → a 67-character token**. It returns `PublicURL = publicBaseURL + "/s/" + sessionID + "/"`. That is 400 bits of entropy in a URL path segment.

3. **Role inversion on the mux.** After the handshake both sides wrap the *same* TCP connection in yamux — but crossed over:
   - `tty-share` calls `yamux.Server(conn, nil)` and **accepts** streams.
   - `tty-proxy` calls `yamux.Client(conn, nil)` and **opens** streams.

   So the relay is the stream initiator even though the sharer initiated the TCP connection. This is the whole NAT-traversal trick: one outbound connection, inbound-request semantics.

4. **Per-HTTP-request stream.** For every front-end request matching `/s/{sessionID}/`:
   ```go
   backConn, _ := wrapper.ySession.Open()   // new yamux stream
   frontConn, _, _ := w.(http.Hijacker).Hijack()  // steal the raw TCP conn from net/http
   r.Write(backConn)                        // re-serialize the request onto the stream
   pipeConnectionsAndWait(backConn, frontConn)  // two io.Copy goroutines, first error closes both
   ```
   **The relay hijacks the connection out of `net/http` and stops speaking HTTP.** After `r.Write`, it is a raw bidirectional byte pump. This is why WebSocket upgrades work with zero WebSocket code in the relay: the `101 Switching Protocols` response and every subsequent frame are just bytes in the pipe. The relay also never needs a response parser, never buffers a body, never sets a timeout on the stream.

5. **Liveness by negative-space.** After registering the session the relay does:
   ```go
   go func() {
       _, err := ymuxServerSession.Accept()   // expected to NEVER succeed
       if err != nil { removeSession(s, wrapper); conn.Close() }
   }()
   ```
   The sharer never opens a stream toward the relay, so this `Accept` blocks forever — until the mux dies, at which point it errors and the session is evicted from the map. A liveness detector that costs one goroutine and zero bytes. **[verified: tty-proxy `server.go` lines ~300-308]**

6. **Unknown session ID** → the relay serves a static `invalid-session.html`. Not a 404, not a redirect, no distinction between "expired", "never existed", and "sharer just disconnected". **[verified]**

**Total relay:** `main.go` (45 lines) + `server.go` (334 lines including static-asset serving and the 404/redirect handlers). That is the entire public service behind tty-share.com.

### 2.4 The terminal protocol (sharer ↔ joiner)

**[verified: `server/tty_protocol_rw.go`, `server/session.go`, `server/frontend/tty-share/tty-receiver.ts`]**

WebSocket text frames carrying a two-level JSON envelope:

```go
type MsgWrapper  struct { Type string; Data []byte }   // Type ∈ {"Write","WinSize"}
type MsgTTYWrite struct { Data []byte; Size int }
type MsgTTYWinSize struct { Cols, Rows int }
```

Because Go marshals `[]byte` to base64 in JSON, and the inner `MsgTTYWrite.Data` is *also* a `[]byte`, **every PTY byte is base64-encoded twice and wrapped in two JSON documents.** The browser reflects this exactly:
```ts
let msgData = base64.decode(message.Data)          // outer
let writeMsg = JSON.parse(msgData)
this.xterminal.write(base64.base64ToArrayBuffer(writeMsg.Data))  // inner
```
≈1.78× expansion plus two JSON parses per output chunk. **Do not copy this.** It is the clearest wart in the codebase and exists only because the author leaned on Go's default `encoding/json` behavior for `[]byte`.

**Fan-out** is a `container/list` of connections under a `sync.RWMutex`; `Write` copies the list under a read lock and then writes to each receiver outside the lock, each receiver serialized by its own per-connection mutex. **[verified: `session.go` `forEachReceiverLock`]** No per-client backpressure, no slow-consumer eviction — a stalled WebSocket write blocks the fan-out loop for that one writer's turn.

### 2.5 Attach semantics — and why they are weak

When a new WebSocket arrives, the server calls `server.config.PTY.Refresh()` before adding the client. **`Refresh()` is a hack:** **[verified: `pty_master.go`]**

```go
func (pty *ptyMaster) Refresh() {
    // We wanna force the app to re-draw itself, but there doesn't seem to be a way to do that
    // so we fake it by resizing the window quickly, making it smaller and then back big
    cols, rows, _ := pty.GetWinSize()
    pty.SetWinSize(rows-1, cols)
    go func() { time.Sleep(50 * time.Millisecond); /* restore */ }()
}
```

It shrinks the PTY by one row and grows it back 50ms later, hoping the running app repaints on `SIGWINCH`. **There is no scrollback buffer anywhere in tty-share.** A joiner sees nothing until the app redraws or produces new output; `cat`ted output from before the join is gone forever.

**Bug worth naming:** in `--readonly` mode the real PTY handler is replaced by `nilPTY`, whose `Refresh()` is an **empty function** (`main.go` lines 42-44). So read-only sessions get *no* repaint on attach at all — a read-only joiner lands on a blank terminal and stays blank until the app writes. **[verified by reading both call sites; not reported as an issue upstream as far as I found]**

### 2.6 Window sizing — host-authoritative, and that is deliberate

**[verified]** `session.go`'s `onWinSize` callback **ignores the cols/rows the client sent** and merely calls `Refresh()`. Clients cannot resize the sharer's PTY. Instead:

- **Browser joiner:** receives the host's `WinSize` and *scales the font size* to make the host's grid fit the browser viewport (`guessNewFontSize` in `tty-receiver.ts`, with a comment admitting it is "a horrible hack" and noting VS Code does the same).
- **Terminal joiner:** compares its own window to the host's, and if it is smaller, **mutes itself** — sets an atomic flag that makes stdout writes and stdin reads no-ops, clears the screen, and prints *"Your window is smaller than the remote window. Please resize or press `<C-o C-c>` to detach."* **[verified: `client.go` `updateAndDecideStdoutMuted` + `keyListener.Read`]**

This is a real design decision, not an omission: **the owner's terminal geometry is never held hostage by a joiner.** The cost is pushed entirely onto joiners (shrink your font, or resize your window, or be muted).

### 2.7 Bonus: TCP tunneling over the same channel

`-L local:host:port` on the joiner + `-A` on the sharer opens a *second* WebSocket at `/s/<id>/tws`, sends one JSON `{Address}` init message, then runs **yamux again on top of the WebSocket** (`WSConnReadWriteCloser` adapts `*websocket.Conn` to `io.ReadWriteCloser`, translating WS close codes into `io.EOF` so yamux doesn't choke). Each locally accepted TCP connection becomes a yamux stream dialed out from the sharer's side. **[verified: `server/server.go` `handleTunnelWebsocket`, `client.go` `tunnelFunc`, `server/ws_rw_wrapper.go`]** Same primitive as the relay, one layer up — yamux appears twice in the stack for a public tunneled session.

---

## 3. Join / share flow, and where access is enforced

| Concern | tty-share's answer |
|---|---|
| **Link format** | `https://on.tty-share.com/s/<67-char-base64url>/` — a pure capability URL **[verified]** |
| **Token generation** | `crypto/rand`, 50 bytes, relay-side, one per TCP connection **[verified]** |
| **Auth** | **None.** No login, no password, no per-joiner identity. A `grep -riE "auth|password|token"` over the non-vendored tree returns zero hits. **[verified]** |
| **Expiry** | **None.** No TTL, no idle timeout, no max-joiners, no revocation. The session lives exactly as long as the sharer's TCP connection and dies with it. **[verified — no timer of any kind in tty-proxy `server.go`]** |
| **Read-only** | A **global, process-wide, start-time-only** flag (`--readonly`) |
| **Enforcement point** | **The sharer's own process, at the PTY boundary** |
| **Multi-writer** | Every joiner is a writer, always, with no coordination |
| **Presence** | **None.** No join/leave notification, no participant list, no cursor attribution |

### 3.1 The read-only mechanism, in full

```go
// main.go
type nilPTY struct{}
func (nw *nilPTY) Write(data []byte) (int, error) { return len(data), nil }  // swallow
func (nw *nilPTY) Refresh() {}

var pty server.PTYHandler = ptyMaster
if *readOnly { pty = &nilPTY{} }
server := createServer(..., pty, ...)
```

That is the *entire* implementation. **[verified: `--readonly` appears in exactly one non-usage-string place in the whole repo]** The server still accepts input WebSocket frames from every joiner and still routes them to `ptyHandler.Write`; the writes simply land in a black hole and report success.

**Why this is architecturally right despite being crude:** the enforcement is at the last possible point — the single chokepoint where bytes would enter the PTY — inside the process that owns the terminal. Nothing on the relay, the network, or the browser can be tampered with to bypass it, because nothing on those layers is consulted. A malicious joiner sending hand-crafted WebSocket frames achieves nothing. Compare with the naive design (grey out the input box in the web client) which any joiner defeats with devtools.

**Why it is nonetheless too crude for TermX:** it is all-or-nothing for the whole session and fixed at launch. There is no "I share read-write with Ibrahim and read-only with the room", no promote/demote mid-session, no per-attachment role.

The maintainer's actual recommended workaround for that, from issue #18 ("Make only FIRST user to connect to the URL have control over tty"): **[verified from the issue thread]**

> "you can achieve it by creating two sessions: first one read-write, and inside that one, create a new read-only and share with the rest of the users this read-only one."

**Nest a read-only `tty-share` inside a read-write `tty-share` and hand out the inner URL.** Composition instead of an ACL. It works, it needs zero protocol surface, and it is a hint at the right abstraction: **a share is a scoped view of a session, and views can be stacked.** TermX can express that far more cleanly as a per-share-link role than as nested PTYs.

### 3.2 The capability-URL leak the maintainer's own config creates

The session secret lives in the **URL path**. The maintainer's published nginx config logs `$request` (which contains the full path) to `/var/log/nginx/tty-proxy.access.log`, and separately logs `New front client connection: %s, from %s` with `r.URL.Path` at `Info` level inside tty-proxy itself. **[verified: `doc/nginx.conf` lines 28+40, tty-proxy `server.go` line ~210]**

So on a stock deployment, **every live session secret is sitting in plaintext in two log files**, plus browser history, plus any `Referer` header the page emits to a third-party origin. This is the standard capability-URL failure mode and it is entirely avoidable — TermX should keep the secret out of the logged path (fragment, or short public ID + separate secret in the WS subprotocol/first frame) and scrub what it logs.

### 3.3 Security posture, stated

The README is refreshingly blunt: TLS to the relay, HTTPS to the browser, **"end-to-end encryption is on the TODO list"**, and "if you don't trust my tty-proxy installation, you can run your own." **[verified]** The relay sees every byte of the terminal in cleartext. It is trusted infrastructure, and the mitigation offered is self-hosting rather than cryptography.

---

## 4. Self-hosting the relay on the owner's VPS

**Assessment: this is the easiest self-host of any tool in this study, and the closest match to what TermX needs.**

**What it takes** **[verified: tty-proxy README + Dockerfile + doc/nginx.conf]**

```bash
docker run -p 3456:3456 -p 8080:8080 -e URL=https://term.example.com --cap-drop=all --rm tty-proxy
# or: go build && ./tty-proxy --front-address :8080 --back-address :3456 --url https://term.example.com
```
Then point clients at it: `tty-share --tty-proxy term.example.com:4567 --public`.

**Properties that make it cheap to run:**

- **Three flags, zero config file.** `--front-address`, `--back-address`, `--url`. That is the complete configuration surface.
- **Stateless.** One in-memory `map[string]*sessionWrapper`. No database, no Redis, no disk. Restarting drops all sessions and needs no migration or cleanup.
- **Tiny footprint.** One goroutine per session for liveness, two per proxied request. Traffic is `io.Copy` — no parsing, no buffering of terminal data.
- **`--cap-drop=all`** in the documented run command; it needs no privileges.
- **TLS is nginx's job, not the app's.** The relay speaks plaintext TCP on both listeners; nginx terminates HTTPS on :443 for the web side and, notably, uses the **`ngx_stream` module** to terminate TLS on :4567 for the *raw TCP back-channel* before forwarding to :3456. The nginx snippet also sets `so_keepalive=30m::10` on the stream listener and raises `proxy_send/read_timeout` to 1600s on the HTTP side — both necessary, because terminal sessions are long-lived and idle for long stretches. **Those two timeout details are the ones people get wrong when self-hosting anything like this.**

**What is missing for production, and TermX would have to add:**

- No rate limiting, no cap on concurrent sessions, no per-IP limits. The session map grows without bound; anyone who can reach `:4567` can allocate sessions indefinitely. **[verified — no limits of any kind in `handleBackConnections`]**
- No authentication on the *back* channel: any `tty-share` binary pointed at your relay gets a public session on your domain and your bandwidth. Running an open relay means running an open proxy for strangers' terminals. TermX must gate the back-channel (pre-shared key or account token in the `HelloClient.Data` field — which is literally an unused `string` sitting there for exactly this **[inferred: field is present, set to `"-"`, and never read for any purpose]**).
- No metrics, no health endpoint, no graceful drain.
- No end-to-end encryption; the VPS sees plaintext.

**Fit for TermX's model:** TermX already plans VPS-resident sessions. The tty-proxy pattern fits a *different* need — sessions that live on the **user's Windows machine** and are joined from outside without any inbound port, VPN, or NAT rule. That is the case where the "one outbound TCP + mux the requests backwards" trick is worth its weight, and where TermX's daemon-is-the-server posture already lines up perfectly.

---

## 5. What TermX should steal

TermX's relevant existing shape **[verified from `C:\Dev\TermX\host\src\`]**: a Rust daemon (`server.rs`, 2210 lines) with `ClientMsg::Auth{token}` / `Attach{session_id, replay, since_offset}` / `Resize`, a ring buffer with **absolute stream offsets** (`ring.rs`), disk-spilled scrollback (`history.rs`), and JSON control frames + binary PTY frames (`protocol.rs`). Auth today is a single shared token from a loopback runtime file; **there is no role, permission or read-only concept anywhere in the host** (grep confirms).

### Principle 1 — Enforce write access at the PTY write chokepoint, never at the edge

**tty-share:** `nilPTY` swallows writes inside the sharing process. The relay and the browser are never trusted or consulted.

**TermX mapping:** TermX has exactly one place where client bytes reach ConPTY — the input path in `session.rs` fed from `server.rs`'s client loop. Put the check *there*, keyed on the **attachment**, not the session and not the connection:

```rust
// conceptual
enum Role { Owner, Writer, Reader }
struct Attachment { session_id: SessionId, role: Role, /* ... */ }

// in the input handler, the single gate:
if att.role == Role::Reader { return Ok(()); }  // drop silently, as tty-share does
session.write_input(&bytes)?;
```

Steal the *placement*, upgrade the *granularity*: per-attachment role instead of a process-wide launch flag. The UI may grey out input as a courtesy, but the host must behave identically whether or not the client cooperates. Add a test that a `Reader` attachment sending raw input frames changes nothing observable in the PTY — that is the test tty-share never wrote.

### Principle 2 — The relay is a dumb, stateless byte pipe; keep all product logic on the daemon

**tty-share:** 334 lines of relay, one `map[id]→mux`, hijack-and-`io.Copy`, no HTTP response parsing, no terminal awareness, no storage. Terminal protocol changes ship by updating the *client binaries only* — the relay never needs redeploying.

**TermX mapping:** if TermX adds a VPS relay for joining a Windows-resident session, resist putting session state, replay buffers, or role logic on the VPS. The relay should know: a session ID, one live mux, and how to pipe bytes. Roles, ring buffer, replay offsets, presence — all stay in `host/`, where they already are. The payoff is that TermX's wire protocol (`protocol.rs`) can evolve freely without a relay deploy, and a relay compromise leaks traffic but cannot forge a role or rewrite history.

Concretely: Rust `yamux` (or QUIC streams, which give this for free) over one outbound TLS connection from the daemon; the relay opens a stream per inbound join and pipes. Reuse tty-share's **role inversion** — the daemon is the mux *server* (accepts) even though it dialed out.

### Principle 3 — Cheap liveness by negative-space, and fail-closed session eviction

**tty-share:** the relay blocks on a `mux.Accept()` that is *designed never to return*, using its error as the death signal, then evicts the session from the map. One goroutine, zero heartbeat traffic, zero timer tuning.

**TermX mapping:** for both the relay (if built) and the existing daemon↔client link, prefer "the transport told me it died" over an application-level heartbeat wherever the transport is honest about it. TermX's WS reconnect work is already the known adoption blocker; the lesson is that **the authoritative liveness signal should be a single, unambiguous, transport-level event that has exactly one handler** — not a heartbeat timer racing a close event racing a read error. And when it fires, evict eagerly and let the client re-attach with `since_offset`, which TermX already supports and tty-share cannot dream of.

### Principle 4 — The owner's terminal geometry is never hostage to a joiner

**tty-share:** joiner-reported sizes are read and then deliberately discarded; browsers scale their font to the host's grid, and terminal joiners that are too small mute themselves with an explicit, actionable message rather than corrupting the shared view.

**TermX mapping:** TermX's `ClientMsg::Resize{session_id, cols, rows}` is currently unrestricted — any attached client can reshape the PTY. Under sharing, that must become **owner-only**: `Resize` from a non-owner attachment is dropped, and the joiner's UI fits the owner's grid instead (font scale in xterm, which the frontend can do far more cleanly than tty-share's `guessNewFontSize` guesswork since xterm's `FitAddon`/`CanvasAddon` measure cells properly). Steal the *policy*, not the hack. And steal the honest failure message: telling a joiner "your window is 80x24, the session is 120x40, resize or detach" beats silently reflowing someone's vim.

### Principle 5 — A share is a scoped, revocable *view* of a session, not a property of the session

**tty-share:** the maintainer's own answer to mixed permissions is *nesting a read-only session inside a read-write one*. That is the right idea reached by the only means available in a design with no per-link identity.

**TermX mapping:** model shares as first-class objects the daemon owns, one per link:

```rust
struct Share {
    id: ShareId,          // short, loggable, public
    secret: Secret,       // high-entropy, NEVER in a URL path or a log line
    session_id: SessionId,
    role: Role,           // Writer | Reader — per link, not per session
    expires_at: Option<Instant>,
    max_joins: Option<u32>,
    revoked: bool,
}
```

Then everything tty-share lacks falls out for free and costs almost nothing: two links to one session with different roles (no nesting), revoke without killing the session, expiry, and an audit line per join. Three specific corrections to tty-share's defaults, all cheap:

- **Expiry exists and is short by default.** tty-share has none — the URL is valid until the process dies, which for a long-running dev session is days.
- **The secret is not in the logged URL path.** Use `/s/<share_id>#<secret>` (fragment never leaves the browser) or send the secret in the first WS frame / subprotocol header. tty-share's secret is in `$request` in nginx logs and in the relay's own `Info` logs.
- **Presence is not optional at read-write.** tty-share has zero presence: you cannot tell whether anyone is watching your terminal, or who, or when they joined. For TermX's actual use case (Michael + Ibrahim in one session) a participant list and a join/leave toast in the UI is the difference between a shareable terminal and a comfortable one. The daemon already tracks attachments; surfacing them is a `HostMsg::Presence{session_id, participants}` broadcast, not an architecture.

### Explicitly do NOT copy

1. **The double-base64 JSON envelope.** ~1.78× expansion and two JSON parses per chunk. TermX's binary frames for PTY bytes are already strictly better — keep them.
2. **`Refresh()` as attach semantics.** Shrinking the PTY by a row to bait a redraw is a hack that fails for any app that doesn't handle `SIGWINCH`, loses all pre-join output, and is a **no-op in read-only mode** (`nilPTY.Refresh()` is empty), leaving read-only joiners staring at a blank screen. TermX's ring buffer + `since_offset` replay is the correct answer and is already built — a new joiner should get a real replay, scoped to the share's role.
3. **Unbounded fan-out with no slow-consumer policy.** A stalled joiner's WebSocket write stalls that joiner's slot in the broadcast loop with no eviction path. TermX's `Replay`-on-lag resync design (documented in `protocol.rs`) already anticipates this properly.
4. **An unauthenticated back-channel.** An open relay for anyone's terminal is a liability on Michael's VPS. Gate it — `HelloClient.Data` is an unused string field sitting there for exactly that purpose.

---

## 6. Sources

**Primary (source read directly, `master` branch):**
- https://github.com/elisescu/tty-share — `LICENSE`, `README.md`, `main.go`, `client.go`, `pty_master.go`, `proxy/proxy.go`, `proxy/readme.md`, `doc/architecture.md`, `doc/http_routes.md`, `server/server.go`, `server/session.go`, `server/tty_protocol_rw.go`, `server/ws_rw_wrapper.go`, `server/frontend/tty-share/main.ts`, `server/frontend/tty-share/tty-receiver.ts`
- https://github.com/elisescu/tty-proxy — `LICENSE`, `README.md`, `main.go`, `server.go`, `doc/nginx.conf`

**Issue archaeology (via `gh api`):**
- tty-share issue #18 — "Make only FIRST user to connect to the URL have control over tty" (maintainer's nested-session workaround)
- tty-share issue #56 — "[Feature Request] Add an option to disable input/view only" (closed: `--readonly` covers it)
- tty-share issue #96 — "tls terminator config" (open)

**Repo metadata:** `gh api repos/elisescu/tty-share`, `.../releases`, `gh api repos/elisescu/tty-proxy` — 998★/91 forks, MIT, v2.4.1 (2025-01-12), last push 2025-09-03; relay 56★, MIT, last push 2023-09-16.

**TermX cross-reference:** `C:\Dev\TermX\host\src\protocol.rs`, `C:\Dev\TermX\host\src\server.rs`, `C:\Dev\TermX\host\src\ring.rs`, `C:\Dev\TermX\host\src\history.rs`

**Not consulted:** the live tty-share.com service (no account or live session was created); the `assets_bundle.go` generated frontend bundle; the vendored dependency trees beyond their LICENSE files.
