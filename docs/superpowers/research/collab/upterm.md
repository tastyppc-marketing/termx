# Upterm — Product Study for TermX Session Sharing

**Product:** Upterm (`github.com/owenthereal/upterm`)
**Studied at commit:** `1a8b11e43b117d4dcfc8d7d92d421cb3f1abbca9` (master, 2026-07-12)
**Language / size:** Go 1.26, ~11k LOC non-test — small enough to read end to end
**Method:** full shallow clone read locally, plus README. Claims below are marked
**[V]** = verified by reading source at a cited path:line, **[I]** = inferred.

---

## 1. License verdict

**Apache License 2.0** [V] (`LICENSE`, and README "License" section).

**Verdict: TermX MAY borrow code, not just learn from it.** Apache-2.0 is
permissive and GPL-incompatible-in-one-direction only (it can be consumed by
GPLv3, not GPLv2). TermX is free to:

- lift algorithms, protocol shapes and naming wholesale;
- translate Go source to Rust line-by-line (a translation is a derivative work,
  and Apache-2.0 permits derivative works);
- vendor the Go binary/`uptermd` unmodified.

Obligations if code or a substantial derivative is shipped: retain the license
text, retain copyright/attribution notices, propagate any `NOTICE` file
contents, and state significant changes made. Apache-2.0 also carries an express
patent grant plus a patent-retaliation termination clause — both favourable for
TermX. There is no copyleft reach into TermX's own source.

**One caveat that matters more than the license itself:** Upterm's relay depends
on a *forked* `golang.org/x/crypto` [V] (`go.mod:159`):

```
replace golang.org/x/crypto => github.com/tg123/sshpiper.crypto v0.50.0-sshpiper-20260423
replace github.com/pkg/sftp   => github.com/owenthereal/sftp v0.0.0-20260113082633-ef3e1c92482e
```

The sshpiper crypto fork adds the `ssh.Upstream` / `ChallengeContext` piping API
that stock `x/crypto/ssh` does not expose. **This is the single biggest
borrow-blocker**: the relay design is only cheap to build *because* that fork
exists in Go. Rust's `russh` has no equivalent turnkey "piper" abstraction, so
the architecture is portable but the implementation cost is not (see §8).

---

## 2. Architecture

### 2.1 The core inversion (the good idea)

> "Upterm starts an SSH server (a.k.a. `sshd`) in the host machine and sets up a
> reverse SSH tunnel to a Upterm server (a.k.a. `uptermd`)." — README, *How it works*

The host **is** an SSH server. [V] `host/internal/server.go:120-149` constructs a
full `gssh.Server` (charmbracelet/ssh) with `HostSigners`, `PublicKeyHandler`,
`SubsystemHandlers` for SFTP, and channel handlers for `session` and
`direct-tcpip`. That server is then served over a listener that is **not** a TCP
socket — it is the reverse tunnel:

[V] `host/host.go:390-394`
```go
g.Add(func() error {
    return sshServer.ServeWithContext(ctx, rt.Listener())   // rt = ReverseTunnel
}, ...)
```

[V] `host/internal/reversetunnel.go:104` — the listener is a remote-forwarded
**Unix socket bound on the relay, named by session ID**:
```go
c.ln, err = c.Listen("unix", sessResp.SessionID)
```

So the topology is: joiner → `uptermd` → (reverse tunnel) → host's own sshd →
PTY. The relay owns no terminal logic whatsoever. It never parses escape
sequences, never holds screen state, never knows what a PTY is. It is a
**named-socket switchboard**.

### 2.2 Session establishment handshake

[V] `host/internal/reversetunnel.go:46-119` + `server/sshd.go:106-145`:

1. Host dials `uptermd` over SSH (client version banner
   `SSH-2.0-upterm-host-client`, `upterm/const.go:5` — the banner is
   load-bearing, see §4).
2. Host sends a **global SSH request** `upterm-create-session@upterm.dev`
   [V] `upterm/const.go:15` carrying a protobuf `CreateSessionRequest{HostUser,
   HostPublicKeys, ClientAuthorizedKeys}`.
3. Relay generates the session ID and stores the session record
   [V] `server/sshd.go:112`:
   ```go
   sessionID := utils.GenerateSessionID()   // uniuri.NewLen(uniuri.UUIDLen)
   ```
   [V] `utils/utils.go:217-219` — 20 chars from uniuri's 62-char alphabet
   ≈ **119 bits of entropy**. Genuinely unguessable; correct for a bearer token.
4. Relay replies with `{SessionID, NodeAddr, SshUser}`.
5. Host opens the reverse tunnel named by `SessionID`, then starts its sshd on it.
6. Host runs a keepalive ticker sending `keepalive@openssh.com`
   [V] `reversetunnel.go:110-116`.

Note the relay's own sshd **refuses interactive login entirely**
[V] `server/sshd.go:66-68, 94`:
```go
Handler: func(s ssh.Session) { _ = s.Exit(1) },      // disable ssh login
ChannelHandlers: make(map[string]ssh.ChannelHandler), // disallow shell
```
Its only accepted request types are the streamlocal forward handlers and
`createSessionHandler`. Good hardening: the relay exposes an SSH port that
cannot give you a shell on the relay.

### 2.3 The relay is a piper, NOT an end-to-end tunnel

This is the most important architectural fact and it is easy to get wrong.

[V] `server/sshproxy.go:141-220` — `authPiper.PublicKeyCallback` returns an
`*ssh.Upstream`: the relay **terminates the joiner's SSH connection**, then opens
a *separate* SSH connection upstream to the host, and pipes between them. The
relay therefore holds plaintext of the terminal stream.

**`uptermd` can read and modify everything in the session.** [I, but strongly
implied by the piper structure] There is no end-to-end encryption layer above
SSH. Contrast sshx, which puts an encryption key in the URL fragment so the
server sees only ciphertext. Upterm's threat model is "you trust the relay
operator" — which is exactly why self-hosting is a first-class feature rather
than a nicety.

To keep the joiner's identity honest across that MITM boundary, Upterm uses a
**certificate-as-attestation** scheme [V] `server/cert.go:81-119`: the relay mints
a short-lived SSH *user certificate*, embedding the original joiner's
`AuthRequest` (client version, remote addr, and the **actual public key the
joiner presented**) as a custom cert extension `upterm-auth-request`
[V] `upterm/const.go:23`:

```go
Permissions: ssh.Permissions{
    Extensions: map[string]string{upterm.SSHCertExtension: string(b)},
},
```

The host then unwraps that extension and authorizes against the *embedded* key,
not the cert key [V] `server/cert.go:47-79` (`parseAuthRequestFromCert`) and
`host/internal/server.go:169-193`. Cert validity is `now ± 1 minute`
[V] `server/cert.go:23, 93-95` — a deliberate symmetric clock-skew window so the
host's independent `time.Now()` accepts it despite NTP drift. Nice detail worth
copying: skew tolerance belongs on the *issuer* side, widening both ends.

Honest weakness [V] `server/cert.go:108`: `// TODO: use different key to sign` —
the relay signs user certs with the same signer set used elsewhere.

### 2.4 Routing: how a joiner reaches the right relay node

Two modes [V] `routing/modes.go`:

- **`embedded`** (default): the node address is base64url-encoded **into the SSH
  username** alongside the session ID [V] `routing/encoding.go:63-65`:
  ```go
  func (e *EmbeddedEncodeDecoder) Encode(sessionID, nodeAddr string) string {
      return sessionID + ":" + base64.URLEncoding.EncodeToString([]byte(nodeAddr))
  }
  ```
  Stateless horizontal scaling: any node can decode where to forward. No shared
  store needed.
- **`consul`**: username is the bare session ID; node address is looked up from
  Consul KV [V] `routing/encoding.go:88-107`, with `DefaultSessionTTL = 30 *
  time.Minute` [V] `server/session.go:35` and a watch that replicates the session
  map into an in-memory cache [V] `server/session.go:649-715`.

The consul decoder tolerates the embedded format on input (strips at the first
colon) for mixed-mode rollouts [V] `routing/encoding.go:100-104` — a small,
copyable migration courtesy.

Cross-node forwarding is handled by `sidewayConnDialer`
[V] `server/server.go:503-527`: if the decoded node address is this node, dial
the local session socket; otherwise dial the neighbour node directly.

---

## 3. The join / share flow

There is **no link and no web UI**. The shared artifact is a literal SSH command.

[V] `cmd/upterm/command/session.go:310`:
```go
sshCmd = fmt.Sprintf("ssh %s@%s", user, host)
```

Producing:

```
ssh <sessionID>:<base64url(nodeAddr)>@uptermd.upterm.dev
```

Flow:

1. `upterm host [-- command]` — starts the session.
2. `upterm session current` — prints the connection string (plus `sftp`/`scp`
   variants [V] `session.go:329-335`).
3. Joiner pastes it into any stock `ssh`. **No client install required.**

Non-standard-port and WebSocket joins wrap in a ProxyCommand
[V] `session.go:315`:
```go
sshCmd = fmt.Sprintf("ssh -o ProxyCommand='upterm proxy %s://%s@%s' %s@%s", ...)
```
— this is the one path that *does* require the `upterm` binary on the joiner.

### Auth of joiners

- **Default: none beyond the token.** [V] `server/session.go:123-126`:
  ```go
  func (s *Session) IsClientKeyAllowed(key ssh.PublicKey) bool {
      if len(s.ClientAuthorizedKeys) == 0 { return true }
      ...
  ```
  Also [V] `host/internal/server.go:179-182`. **Possession of the session ID is
  full authority.** The 119-bit token is the whole security boundary.
- **Key allowlist:** `--authorized-keys FILE` [V] `cmd/.../host.go:121`.
- **Identity allowlist:** `--github-user`, `--gitlab-user`, `--srht-user`,
  `--codeberg-user` [V] `cmd/.../host.go:123`, resolved by fetching the
  provider's public-key endpoint [V] `host/authorizedkeys.go:19-22, 107-149`
  (`https://github.com/USER.keys`, GitHub API `users/%s/keys`, etc.).
  **This is the best UX idea in the product** — invite a *person*, and the
  allowlist materializes from their published keys with zero coordination.
- **Interactive per-join approval:** default is to prompt the host; `--accept`
  disables prompting for CI/non-interactive use [V] `cmd/.../host.go:126,
  186-187`.

### Expiry

There is **no session expiry, no TTL, and no revocation** in embedded mode [I,
by absence — `Session` has no expiry field and no reaper exists in
`memorySessionStore`, `server/session.go:736-808`]. The session lives exactly as
long as the host process holds the reverse tunnel; killing `upterm host` is the
only revocation mechanism. The 30-minute TTL in consul mode is a *liveness* TTL
for the routing record, not a security expiry. **Do not copy this.** Sharing
links without expiry is a real weakness for TermX's use case.

---

## 4. Read-only enforcement — the standout lesson

`upterm host --read-only` [V] `cmd/.../host.go:127`.

**Enforcement point: the host, by structural omission.** [V]
`host/internal/server.go:310-323`:

```go
// if a readonly session has been requested, don't connect stdin
if h.readonly {
    _, _ = io.WriteString(sess, "\r\n=== Attached to read-only session ===\r\n\r\n")
} else {
    // input
    ctx, cancel := context.WithCancel(h.ctx)
    g.Add(func() error {
        _, err := io.Copy(ptmx, uio.NewContextReader(ctx, sess))
        return err
    }, ...)
}
```

The input-forwarding goroutine **is never created**. There is no filter, no
predicate on a write path, no "if readonly { drop }" inside a hot loop. The data
path from joiner to PTY does not exist. This is the correct shape: a capability
you never construct cannot be bypassed by a bug in a conditional.

**And it is enforced across every channel, not just the PTY.** This is the part
most implementations miss:

- **SFTP writes** [V] `host/internal/sftp.go:159-164, 209-214` — `Filewrite` and
  `Filecmd` both return `sftp.ErrSSHFxPermissionDenied` when `readOnly`.
  Downloads still work.
- **TCP forwarding** is refused at *CLI validation time* as mutually exclusive
  [V] `cmd/.../host.go:139-141`:
  ```go
  if flagReadOnly && flagAllowLocalTCPForwarding {
      result = multierror.Append(result, fmt.Errorf(
        "--read-only and --allow-local-tcp-forwarding cannot be used together: "+
        "a read-only session must not permit network pivoting through the host"))
  }
  ```
  The reasoning is exactly right: a read-only *terminal* that still lets you
  pivot the network is not read-only. Refusing the combination at parse time
  beats trying to reconcile it at runtime.

**Limitation:** read-only is a property of the **session**, set by the host at
launch, applying to **all joiners uniformly**. [V] `Host.ReadOnly bool`,
`host/host.go:207`. There is no per-joiner read-only, and no promote/demote
during a live session. For TermX's "Ibrahim joins to watch, then takes the
keyboard" scenario, Upterm has no answer — you would have to restart the session.

---

## 5. Multi-writer and presence semantics

**Output fan-out** [V] `host/host.go` → `uio.NewMultiWriter(5)`
(`host/internal/server.go:49`). Each joiner appends its own writer
[V] `server.go:282-288`, wrapped in a `TerminalQueryFilter` that strips terminal
query sequences (OSC 10/11 colour queries, CSI 6n cursor reports) so joiner
terminals don't answer probes aimed at the host's terminal — **a genuinely
subtle bug class TermX should pre-empt** [V] `server.go:278-282` comment.

**Input: unmoderated free-for-all.** Every non-read-only joiner runs its own
`io.Copy(ptmx, sess)` into the *same* PTY [V] `server.go:316-322`. There is no
lock, no turn-taking, no write token, no last-writer-wins arbitration. Two people
typing produces byte-level interleaving. This is the tmate/`screen -x` model:
social protocol substitutes for a concurrency protocol.

**Presence** is event-based and host-side only [V] `upterm/const.go:25-28`:
`client-joined`, `client-left`, `terminal-window-changed`, `terminal-detached`.
The host maintains a `ClientRepo` [V] `host/host.go:295, 320-367`, exposed over a
**Unix-domain admin socket** [V] `host/host.go:308-317`, `host/internal/adminserver.go`,
with the path handed to the child process via `UPTERM_ADMIN_SOCKET`
[V] `host/host.go:375`. That is how the README's shell-prompt trick shows a 🆙
emoji and live joiner count. Per-client record is `{Id, Version, Addr,
PublicKeyFingerprint}` [V] `host/internal/server.go:336-344`.

Design note worth stealing: **presence is queryable out-of-band via a local
socket**, so any prompt, statusline, or GUI can subscribe without the daemon
owning the UI.

**Terminal sizing** is not negotiated — window-change events propagate from
joiners to the shared PTY [V] `server.go:291-308`, so the last resize wins and a
small joiner window can shrink the host's view. No per-viewer reflow.

**Join-time replay is the weakest part of the product.** [V] `io/writer.go:45-79`
— `MultiWriter` keeps a queue of the **last 5 write chunks** and replays them to
a newly appended writer:

```go
// MultiWriter is a concurrent safe writer that allows appending/removing writers.
// Newly appended writers get the last write to preserve last output.
```

That is not scrollback and not screen state — it is the last 5 PTY writes,
whatever size they happened to be. A joiner arriving mid-session sees a partial
screen. (tmate replays real terminal state; sshx keeps a server-side terminal
model.) Two further defects in that file: `buffer.Data()` does
`make([][]byte, len)` then `append(...)`, returning a slice with a leading run of
`nil` entries [V] `io/writer.go:37-43]`; and `MultiWriter.Remove` loops `i > 0`,
so the writer at index 0 can never be removed [V] `io/writer.go:85`.
**TermX must not copy this component** — see §8.

---

## 6. Self-hosting `uptermd` on a VPS

This is Upterm's strongest operational story: **one static Go binary, no
dependencies, no database.**

### Ports and flags [V] `cmd/uptermd/command/root.go:28-46`

| Flag | Default | Purpose |
|---|---|---|
| `--ssh-addr` | `127.0.0.1:2222` | SSH listener (the join port) |
| `--ws-addr` | *(empty)* | WebSocket listener; enable for restrictive networks |
| `--node-addr` | falls back to ssh/ws addr | address embedded in the join token |
| `--private-key` | — | relay host key(s); also `PRIVATE_KEY` env [V] `server/server.go:121` |
| `--hostname` | — | cert principals; if empty, plain host-key auth is used |
| `--authorized-keys` | — | restrict **who may register as a host** (repeatable) |
| `--ssh-proxy-protocol` | `false` | PROXY protocol v2 for real client IP behind L4 proxies |
| `--network` | `mem` | network provider (in-memory) |
| `--routing` | `embedded` | `embedded` or `consul` |
| `--consul-url` / `--consul-session-ttl` | — / `30m` | multi-node routing |
| `--metric-addr` | — | Prometheus `/metrics` |

Every flag is also an env var: viper with prefix `UPTERMD_` and `-`→`_`
[V] `root.go:100-102`, so `UPTERMD_SSH_ADDR`, `UPTERMD_AUTHORIZED_KEYS`, etc.
A `--config` file is also supported [V] `root.go:107-120`.

### Single-VPS recipe

For one node, `--network mem` + `--routing embedded` needs **no external
services at all** — no Consul, no Redis, no Postgres. Sessions live in a
`memorySessionStore` map [V] `server/session.go:736-808`. Consul is only required
for multi-node.

Shipped deployment assets [V]: `systemd/uptermd.service`, `charts/uptermd/`
(Helm), `Dockerfile.uptermd`, `fly.toml`, `terraform/digitalocean`,
`terraform/heroku`, `Procfile`, plus a Traefik `docker-compose` example in the
README.

The systemd unit is a good hardening template to copy [V] `systemd/uptermd.service`:
```ini
ExecStart=/usr/bin/uptermd --ssh-addr 0.0.0.0:2222
DynamicUser=yes
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=yes
ProtectProc=invisible
PrivateUsers=yes
PrivateDevices=yes
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
```

### Locking down a private relay

`--authorized-keys` gates **host registration only** [V] `server/sshproxy.go:80-98`,
and it does so by checking the **SSH client version banner**:

```go
// Only HOST connections (uptermd hosts registering with the proxy) are gated by authorized_keys.
if string(conn.ClientVersion()) != upterm.HostSSHClientVersion { return nil }
```

Keys are unwrapped from certificates before fingerprint comparison
[V] `sshproxy.go:100-110` (correct — agent-supplied cert signers would otherwise
never match an `authorized_keys` line). Files are read **once at startup**
[V] `sshproxy.go:112-116` — edits need a restart.

⚠️ **Note the banner-based gate is a soft boundary** [I]: the client version
string is attacker-controlled, so a joiner could in principle present the host
banner to route into the host branch. It doesn't grant a session (session
creation still requires the create-session request path), but it is not a
cryptographic distinction. If TermX copies the "gate hosts but not joiners"
split, key it off the authenticated key or the request type, **not** a banner
string.

Behind Traefik/HAProxy/ELB, `--ssh-proxy-protocol` is required for real client
IPs, and once enabled **all** SSH connections must arrive via the proxy
[V] README + `server/server.go:158-162].

### Verdict for the owner's VPS

Very easy. A single `uptermd --ssh-addr 0.0.0.0:2222 --ws-addr 0.0.0.0:8443
--private-key /etc/uptermd/hostkey --authorized-keys /etc/uptermd/team.keys`
behind the shipped systemd unit is a complete private relay. Resource footprint
is trivial (Helm chart requests 100m CPU / 512Mi [V] `charts/uptermd/values.yaml`).
The relay holds no terminal state, so it restarts cheaply — though restarting it
kills every live session, since sessions are in-memory and tunnel-bound.

---

## 7. What SSH-native buys vs a WebSocket relay

**Wins**

1. **Zero client install.** The joiner already has `ssh`. No app, no browser, no
   version negotiation. For a Windows-first product whose collaborators may not
   run TermX, this is a genuine distribution advantage.
2. **Auth, key management, and transport encryption are inherited, not built.**
   Public-key auth, known_hosts, agent forwarding, cert principals, cipher
   negotiation — all free and all audited. Upterm's own auth code is ~250 lines
   because SSH does the work.
3. **Multiplexing is free.** SSH channels give shell + SFTP + `direct-tcpip` port
   forwarding over one connection [V] `host/internal/server.go:141-145`. A
   WebSocket relay must invent framing, subsystem dispatch, and flow control.
   Upterm gets `scp`/`sftp` file transfer essentially for nothing.
4. **MITM detection is a solved, familiar UX.** The host verifies the relay via
   `known_hosts` with the standard scary banner [V] `host/host.go:66-77`, and
   supports `accept-new` semantics via `--skip-host-key-check`
   [V] `host/host.go:38-40`.
5. **Reverse tunnel needs no inbound port on the host.** Works behind NAT and
   corporate firewalls without UPnP or hole-punching.

**Losses**

1. **No browser join, ever.** This is the decisive one. sshx's "paste a URL, a
   terminal opens in Chrome" is impossible here. Upterm's WebSocket support is
   *SSH-over-WebSocket for firewall traversal* [V] `ws/client.go`,
   `server/wsproxy.go`, still requiring the `upterm` binary as a ProxyCommand
   [V] `session.go:315] — it is emphatically **not** a web client.
2. **No end-to-end encryption.** The piper terminates and re-originates SSH
   (§2.3), so the relay sees plaintext. A WebSocket relay carrying opaque
   ciphertext (sshx model) is strictly stronger against a hostile relay operator.
3. **The share artifact is ugly.** `ssh a8Xk2...:aHR0cDovL...@host` is not a
   link. It cannot be clicked, previewed, QR-coded, or given a landing page with
   "you are about to join Michael's terminal, read-only".
4. **Corporate egress on :22/:2222 is often blocked** — hence the WebSocket
   fallback exists at all, which partly gives back win #1 since it needs the binary.
5. **Rich UI signalling has nowhere to live.** Presence, cursors, per-joiner
   permission changes, chat — SSH gives you a byte stream and custom global
   requests. Upterm's answer is a *separate local admin socket* (§5) rather than
   in-band protocol, precisely because in-band signalling in SSH is awkward.

**Read for TermX:** SSH-native is the right choice for *headless CLI joiners and
firewall traversal*, and the wrong choice for *a Tauri app with a rich UI and a
shareable link*. These are not exclusive — Upterm's own structure (relay is a
dumb switchboard; the host owns all session semantics) works equally well under a
WebSocket transport. **Steal the shape, not the transport.**

---

## 8. Principles TermX should adopt

TermX today: Rust ConPTY daemon under `C:\Dev\TermX\host\src\` with
`server.rs`, `session.rs`, `registry.rs`, `protocol.rs`, `ring.rs`, `history.rs`;
an `Attach { since_offset }` client message [V] `host/src/protocol.rs:39, 268-282`;
and a hard-capped absolute-offset `RingBuffer` with disk spill
[V] `host/src/ring.rs:1-30`, `host/src/history.rs`.

### P1 — Keep the relay dumb; the daemon stays the sole authority

Upterm's relay never touches terminal semantics; it routes a named socket and
pipes bytes. Every policy decision — who may attach, whether input is wired,
whether SFTP writes land — is made by the *host* process that owns the PTY.

**Maps onto TermX:** the VPS relay should be a byte switchboard keyed by session
ID, and `host/src/session.rs` must remain the only place that decides whether an
attached client's input reaches ConPTY. Concretely: do **not** add a
`read_only` check in the relay. Add it in `session.rs` at the point where an
attached client's `Frame::Input` is currently routed to the PTY writer
[V] `host/src/protocol.rs:147, 170`. Benefit: a compromised or buggy relay cannot
grant write access it was never asked to mediate.

### P2 — Enforce read-only by *not building the input path*, and enforce it on every channel

Two halves, both load-bearing:

- **Structural omission over runtime filtering.** Upterm never spawns the
  stdin-copy goroutine [V] `host/internal/server.go:311-323`. In TermX, an
  attached client that is read-only should be registered in a subscriber list
  that the input router *cannot see* — e.g. `session.rs` holds
  `writers: Vec<ClientId>` distinct from `viewers: Vec<ClientId>`, and
  `Frame::Input` from a non-member is dropped at the router with no per-frame
  boolean to get wrong.
- **Cover every capability, not just keystrokes.** Upterm refuses `--read-only`
  together with `--allow-local-tcp-forwarding` at *argument-validation time*
  [V] `cmd/.../host.go:139-141`, and denies SFTP writes separately
  [V] `host/internal/sftp.go:159-164, 209-214`. TermX's equivalent surfaces are
  resize (`Frame::Resize`, `protocol.rs:53`), any future file transfer, and any
  command-execution or plugin channel. **Audit each one against read-only, and
  make illegal combinations un-representable at config-parse time.** A read-only
  viewer who can resize the host's terminal is not read-only.

`protocol.rs` currently has no `ReadOnly` concept at all — this is a clean
greenfield addition rather than a retrofit.

### P3 — Go beyond Upterm: per-joiner, live-mutable permission

This is where TermX should **deliberately diverge**. Upterm's `--read-only` is a
process-wide launch flag [V] `host/host.go:207` — uniform for all joiners,
immutable for the session's life. That cannot express "Ibrahim watches, then
takes the keyboard", which is the actual collaboration story.

**Maps onto TermX:** make write permission a per-`ClientId` attribute in the
session's client registry, mutable at runtime via a control frame, with the
owner as the only grantor. The promotion path is then: viewer attaches → owner
approves → `ClientId` moves from `viewers` to `writers`. Because P2 makes the
distinction structural, promotion is a list move, not a flag flip — and
revocation is equally atomic.

Pair it with Upterm's **explicit-approval default** [V] `cmd/.../host.go:126`:
prompting the host on each join, with an `--accept`-style escape hatch for
unattended use, is the right default for a desktop app where a modal is cheap.

### P4 — Invite identities, not just tokens; and give tokens a lifetime

Two fixes to Upterm's weakest security surface.

- **Steal the `.keys` trick.** `--github-user owenthereal` fetches
  `https://github.com/owenthereal.keys` and pins the session to those public keys
  [V] `host/authorizedkeys.go:19-22, 107-149`. This turns "send a secret string"
  into "invite a person", with no key exchange and no shared secret to leak.
  TermX can resolve a GitHub/GitLab handle to keys at share time and bind the
  session to them.
- **Do not copy the missing expiry.** Upterm sessions have no TTL and no
  revocation short of killing the host process (§3). TermX's share tokens should
  carry an explicit expiry and a revoke operation from the owner's UI, and the
  daemon should reject attach on an expired token. Also copy the *good* half:
  a 119-bit random session ID [V] `utils/utils.go:217-219` — if the token is the
  authority, make it unguessable.

Also worth copying verbatim: **stateless routing by encoding the node address
into the token** [V] `routing/encoding.go:63-65`. A TermX share token of
`{session_id}:{base64url(node_addr)}` lets any relay node route without a shared
store, which is exactly the "no database on the VPS" property that makes
self-hosting a one-binary affair.

### P5 — Presence as an out-of-band local subscription; replay as real state

- **Presence:** Upterm emits `client-joined` / `client-left` /
  `terminal-window-changed` events [V] `upterm/const.go:25-28` into a host-side
  `ClientRepo` served over a **Unix admin socket** [V] `host/host.go:308-317`,
  advertised via `UPTERM_ADMIN_SOCKET` [V] `host/host.go:375`. Any consumer —
  shell prompt, statusline, GUI — subscribes without the daemon knowing about UI.
  TermX already has the right substrate (`registry.rs` + the existing IPC
  server); expose joiner identity, address, and key fingerprint on it so the
  Tauri UI renders presence from the same source a scripted statusline would.
- **Replay: TermX is already ahead — protect that lead.** Upterm's join-time
  replay is the last **5 PTY write chunks** [V] `io/writer.go:45-79`, which shows
  a mid-session joiner a torn partial screen. TermX's `RingBuffer` with absolute
  stream offsets plus disk spill, driven by `Attach { since_offset }`
  [V] `host/src/ring.rs:1-12`, `host/src/protocol.rs:268-282`, is a strictly
  better design. **Reuse the existing attach/resync path for remote joiners
  rather than inventing a share-specific replay** — a joiner is just an attach
  with `since_offset = None` and a permission class. Do not port `MultiWriter`.
- **One free bug-fix to copy:** filter terminal *query* sequences (OSC 10/11,
  CSI 6n) on the fan-out path to joiners [V] `host/internal/server.go:278-282`,
  or every joiner's terminal will answer probes meant for the host's and inject
  garbage into the shared PTY.

---

## 9. Things to explicitly NOT copy

| Anti-pattern | Cite | Why |
|---|---|---|
| 5-chunk replay buffer | `io/writer.go:45-79` | Torn screen on join; TermX's ring is better |
| `MultiWriter.Remove` skipping index 0 | `io/writer.go:85` | Writer at index 0 is unremovable |
| `buffer.Data()` leading nils | `io/writer.go:37-43` | `make(len)` + `append` returns 2× length |
| Unmoderated concurrent input | `host/internal/server.go:316-322` | Byte interleaving with no arbitration |
| Session-wide, immutable read-only | `host/host.go:207` | Can't express watch-then-drive |
| No session expiry/revocation | §3 | Token is forever until the process dies |
| Trusting the SSH client-version banner as an auth boundary | `server/sshproxy.go:86` | Attacker-controlled string |
| Relay signing user certs with its own host signer | `server/cert.go:108` | Author's own `TODO` |

---

## 10. Sources

**Primary (source read locally at commit `1a8b11e4`):**
- `LICENSE`, `go.mod` (fork replaces, lines 159-161)
- `routing/encoding.go`, `routing/modes.go` — token/URL scheme
- `server/server.go`, `server/sshd.go`, `server/sshproxy.go`, `server/cert.go`,
  `server/session.go` — relay, piper, cert attestation, session store
- `host/host.go`, `host/internal/server.go`, `host/internal/reversetunnel.go`,
  `host/internal/sftp.go`, `host/authorizedkeys.go` — host sshd, read-only,
  key providers
- `io/writer.go` — fan-out and replay
- `upterm/const.go` — protocol constants
- `cmd/upterm/command/host.go`, `cmd/upterm/command/session.go`,
  `cmd/uptermd/command/root.go` — CLI surface
- `systemd/uptermd.service`, `charts/uptermd/values.yaml` — deployment

**Secondary:**
- README.md — *How it works*, *Deployment* (Kubernetes/Fly.io/Heroku/DigitalOcean/
  Systemd/Traefik), *Restricting Host Registration*, *Monitoring*,
  *Comparison with Prior Arts*
- https://github.com/owenthereal/upterm
- https://github.com/tg123/sshpiper — the crypto fork enabling the piper design

**TermX cross-reference (read for the mapping in §8):**
- `C:\Dev\TermX\host\src\protocol.rs`, `C:\Dev\TermX\host\src\ring.rs`
