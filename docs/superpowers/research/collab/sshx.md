# sshx — Product Study for TermX Session Sharing

**Studied from source**, not docs. Repo cloned at commit `dd42496be83da6a7cbb963aee54ba9402f0ddd98`
(2025-06-19, "Double connection pool size to 10 (#132)"), which is the tip of `main`.
Latest tag: `v0.4.1`. Workspace version `0.4.1`.

Every claim below is tagged:
- **[V]** = verified in source (file:line given where it matters)
- **[I]** = inferred / not provable from the repo alone

> **Project liveness [V/I]:** the tip of `main` is 14 months old as of this study (2026-08-22),
> and the newest tag is `v0.4.1`. The design is stable and worth copying; do **not** plan on
> upstream fixing anything for you. **[V]** on the dates, **[I]** on "effectively dormant".

---

## 1. License + borrow-vs-learn verdict

**License: MIT [V]** — `LICENSE`, "Copyright (c) 2023 Eric Zhang". Every crate manifest carries
`license.workspace = true` → `license = "MIT"` in the root `Cargo.toml` **[V]**. No CLA, no
dual-license, no contributor-agreement file in the tree **[V]**.

**Verdict: BORROW freely, with attribution.** MIT permits vendoring, modification, and shipping in a
closed-source Tauri app. The only obligation is to include the copyright notice and the MIT text for
any substantial portion you copy. Practically: a `THIRD-PARTY-NOTICES.md` in TermX with the sshx MIT
block, and a header comment on each vendored file.

**What is worth actually copying as code (self-contained, small, high value):**

| File | LOC | Why |
|---|---|---|
| `crates/sshx/src/encrypt.rs` | 102 | Whole E2E crypto core. Zero sshx-specific coupling — depends only on `aes`, `ctr`, `argon2`. Ships with 4 unit tests including cross-implementation golden vectors. |
| `src/lib/encrypt.ts` | 78 | The matching browser half (Argon2-browser + WebCrypto AES-CTR). Copy both or neither; they must stay byte-compatible. |
| `src/lib/typeahead.ts` | 1961 | Predictive local echo ("Mosh-style"). **Itself a fork of VS Code's `terminalTypeAheadAddon.ts` @ 1.80.1 [V]** — header comment names the exact upstream path. So this file is MIT-from-Microsoft *and* MIT-from-ekzhang; carry **both** notices if you vendor it. |
| `src/lib/srocket.ts` | 129 | Reconnecting CBOR WebSocket with a 64-message send buffer and at-most-once semantics. Directly relevant to TermX's WS-reconnect adoption blocker. |
| `src/lib/lock.ts` | 29 | Async serialization lock, needed because `crypto.subtle` is async and chunk decryption must stay in stream order. |

**What to learn from but NOT copy:** `sshx-server/src/session.rs`, `state.rs`, `state/mesh.rs`.
These are welded to sshx's protobuf types and its Redis mesh model, and TermX's `host/src/ring.rs`
already occupies the same architectural slot with a better-documented eviction contract.

**Do not take a crate dependency on `sshx-core`.** It is versioned for publication (`version.workspace`
+ `path` in the workspace deps **[V]**) and would be resolvable from crates.io **[I]**, but it is only
the generated protobuf module plus `Sid`/`Uid`/`IdCounter` (93 lines **[V]**). Depending on it would
lock TermX's wire format to sshx's. Define TermX's own proto; steal the message *shapes*.

---

## 2. Architecture (actual crate/module layout, protocol from source)

### Three processes, two protocols

```
  sshx CLI (Rust)                 sshx-server (Rust)              browser (SvelteKit)
  crates/sshx                     crates/sshx-server              src/
      |                                  |                              |
      |  gRPC over HTTP/2                |   WebSocket (CBOR frames)    |
      |  bidi stream: Channel()          |   /api/s/{name}              |
      +--------- OUTBOUND -------------> | <--------------------------- +
         (client dials the server;          (browser dials the server)
          server never dials the client)
```

Both protocols terminate on **one TCP listener**. `listen.rs:48-57` **[V]** uses `tower::steer::Steer`
to route by `Content-Type`: `application/grpc` → the Tonic router, everything else → the Axum router.
So one port (8051 default **[V]**, `sshx-server/src/main.rs`) serves gRPC, the WebSocket API, and the
static SvelteKit build out of `./build/` (`web.rs:16-28` **[V]**).

### Crate layout [V]

```
crates/sshx-core/          # shared: proto/sshx.proto, Sid, Uid, IdCounter, rand_alphanumeric
crates/sshx/               # the CLI that owns the real terminals
  src/main.rs              #   clap args: --server --shell --quiet --name --enable-readers
  src/controller.rs        #   gRPC client, reconnect loop, shell task registry (297 L)
  src/runner.rs            #   per-shell task: PTY <-> encrypted chunks, rolling buffer (176 L)
  src/encrypt.rs           #   Argon2id + AES-128-CTR
  src/terminal/unix.rs     #   openpty + fork + login_tty (181 L)
  src/terminal/windows.rs  #   ConPTY via the `conpty` 0.7 crate (119 L)
crates/sshx-server/        # the relay
  src/listen.rs            #   Steer-based gRPC/HTTP multiplexing
  src/grpc.rs              #   SshxService impl: Open / Channel / Close (244 L)
  src/web/socket.rs        #   browser WebSocket handler + auth gate + perms (311 L)
  src/web/protocol.rs      #   WsClient / WsServer CBOR enums (99 L)
  src/session.rs           #   in-memory session: shells, users, broadcast (424 L)
  src/session/snapshot.rs  #   zstd-compressed protobuf snapshot for failover
  src/state.rs             #   DashMap of sessions, HMAC token signing, expiry
  src/state/mesh.rs        #   Redis: owner key, snapshot key, transfer pub/sub (201 L)
src/                       # SvelteKit frontend (Svelte 3, Tailwind, static adapter)
```

### The gRPC protocol (`crates/sshx-core/proto/sshx.proto`, 120 lines) [V]

Three RPCs:
- `Open(OpenRequest) -> OpenResponse` — creates the session. Request carries `origin`,
  `encrypted_zeros`, `name` (user@hostname), optional `write_password_hash`. Response returns the
  random session `name`, a signed `token`, and the public `url`.
- `Channel(stream ClientUpdate) -> stream ServerUpdate` — the long-lived bidi stream. **This is the
  whole session.**
- `Close(CloseRequest) -> CloseResponse` — graceful teardown, token-authenticated.

`ClientUpdate` oneof: `hello` ("name,token", must be first), `data` (TerminalData), `created_shell`,
`closed_shell`, `pong`, `error`. `ServerUpdate` oneof: `input` (TerminalInput), `create_shell`,
`close_shell`, `sync` (SequenceNumbers), `resize`, `ping`, `error`.

Note the **inversion**: the server *asks* the client to create shells (`ServerUpdate.create_shell`),
and the client acknowledges (`ClientUpdate.created_shell`). Shell IDs are allocated **server-side**
by `IdCounter::next_sid()` (`socket.rs:182` **[V]**), because multiple browsers can request new
terminals concurrently and the relay is the only serialization point.

### The synchronization model (the important part)

This is the design decision that makes sshx robust, and it is the one TermX should study hardest.

**The source of truth for terminal output is the CLI client, not the relay.**

- `runner.rs` keeps a rolling in-memory buffer per shell: `CONTENT_ROLLING_BYTES = 8 MiB` retained,
  pruned once it exceeds `CONTENT_PRUNE_BYTES = 12 MiB`, sent in `CONTENT_CHUNK_SIZE = 64 KiB`
  chunks **[V]** (`runner.rs:15-17`).
- The relay keeps only `SHELL_STORED_BYTES = 2 MiB` per shell (`session.rs:26` **[V]**), evicting
  whole chunks from the front and tracking `chunk_offset` / `byte_offset` so absolute stream offsets
  survive eviction (`session.rs:269-281` **[V]**).
- Every `SYNC_INTERVAL = 5s` (`grpc.rs:23` **[V]**) the relay pushes `ServerMessage::Sync` — a map of
  `shell_id -> seqnum` describing *how many bytes it has*. The CLI compares against its own buffer and
  re-sends anything missing (`runner.rs:113-130` **[V]**).
- `add_data` on the relay is **idempotent and gap-refusing**: it accepts a chunk only if
  `seq <= shell.seqnum && seq + len > shell.seqnum`, then slices off the already-known prefix
  (`session.rs:262-267` **[V]**). Duplicates are no-ops; out-of-order-ahead data is dropped and will
  be re-sent on the next sync.

The consequence: **the relay can lose all its state and fully recover** by announcing lower seqnums.
That is what makes the Redis failover in §5 work, and it is why a relay crash costs you nothing but
the 2 MiB of scrollback beyond what browsers already rendered.

There is a matching "server fell behind" guard on the CLI side: if the relay's advertised seqnum is
*lower* than the client's three times in a row, the client rewinds its own pointer
(`runner.rs:91-98`, `seq_outdated >= 3` **[V]**). Three strikes, not one, so a single stale sync
message in flight does not trigger a spurious replay.

### Connection lifecycle [V]

- `HEARTBEAT_INTERVAL = 2s` — the CLI sends an empty `ClientUpdate` (`controller.rs:23`).
- `RECONNECT_INTERVAL = 60s` — the CLI **deliberately tears down and re-dials the gRPC channel every
  minute** (`controller.rs:26`, `controller.rs:191-193`). The comment explains why: server replicas
  gracefully shut down, so long-lived connections must be periodically rotated to land on a healthy
  replica. This is a load-balancing-by-churn trick.
- Reconnect backoff: `2^min(retries,4)` seconds, i.e. 1/2/4/8/16 capped, and the retry counter resets
  if the last attempt held for 10s (`controller.rs:147-157` **[V]**).
- Browser side: `RECONNECT_DELAY = 500ms` flat, 64-message buffer while disconnected
  (`srocket.ts:11-14` **[V]**).
- Relay evicts a session after `DISCONNECTED_SESSION_EXPIRY = 300s` with no CLI heartbeat
  (`state.rs:27`, swept every 60s **[V]**).

### WebSocket protocol (browser side) [V]

CBOR-encoded binary frames only; text frames are logged and ignored (`socket.rs:86` **[V]**).
`ciborium` on the server, `cbor-x` in the browser.

`WsClient`: `Authenticate(Bytes, Option<Bytes>)`, `SetName`, `SetCursor`, `SetFocus`, `Create(x,y)`,
`Close(Sid)`, `Move(Sid, Option<WsWinsize>)`, `Data(Sid, Bytes, u64)`, `Subscribe(Sid, chunknum)`,
`Chat(String)`, `Ping(u64)`.

`WsServer`: `Hello(Uid, name)`, `InvalidAuth()`, `Users(Vec<(Uid, WsUser)>)`, `UserDiff(Uid, Option<WsUser>)`,
`Shells(Vec<(Sid, WsWinsize)>)`, `Chunks(Sid, seqnum, Vec<Bytes>)`, `Hear(Uid, name, text)`,
`ShellLatency(u64)`, `Pong(u64)`, `Error(String)`.

`Subscribe` is the backfill mechanism: the browser names the chunk index it already has, and
`Session::subscribe_chunks` streams from there forward, then parks on a `Notify` until more arrives
(`session.rs:159-197` **[V]**). Subscriptions are deduped per socket via a `HashSet`
(`socket.rs:136,226-229` **[V]**).

> **Concurrency note worth stealing:** `subscribe_chunks` contains the comment *"We absolutely cannot
> hold `shells` across an await point, since that would cause deadlocks"* and is structured so the
> `parking_lot::RwLock` guard and the `Notify` future are both constructed inside a scope that closes
> before the `await` **[V]** (`session.rs:167-186`). Using a sync lock in async code is fine exactly
> when you enforce this shape.

---

## 3. Link / join + crypto flow, as implemented

### Key generation and the URL [V]

1. CLI generates `encryption_key = rand_alphanumeric(14)` — the comment says **83.3 bits of entropy**
   (`controller.rs:57`); log2(62^14) ≈ 83.4, so the comment is accurate.
2. If `--enable-readers`, it generates a **second, independent** `rand_alphanumeric(14)` as the
   write password (`controller.rs:65`).
3. Both are stretched through Argon2id on a blocking thread pool (`spawn_blocking`, because Argon2 at
   19 MiB would stall the reactor).
4. `Open()` sends `encrypted_zeros` and (optionally) `write_password_hash` — **never the keys
   themselves** (`controller.rs:83-89`).
5. The server returns `url = "{origin}/s/{name}"` where `name = rand_alphanumeric(10)`
   (`grpc.rs:51,66` — ~59.5 bits).
6. The CLI appends the key **client-side**: `resp.url = resp.url + "#" + &encryption_key`
   (`controller.rs:90`), and the writable variant is `url + "," + &write_password`
   (`controller.rs:92-96`).

So the URL shapes are:

```
read-only  : https://sshx.io/s/AbCd123XyZ#Kk3jF9pLmQ7wRt
writable   : https://sshx.io/s/AbCd123XyZ#Kk3jF9pLmQ7wRt,Zx8vN2qLpW4dHt
```

**The fragment is never transmitted to the server** — that is a browser guarantee, not an sshx
mechanism, and it is the entire basis of the E2E claim. The browser parses it in
`Session.svelte:134-135` **[V]**:
```js
const key = window.location.hash?.slice(1).split(",")[0] ?? "";
const writePassword = window.location.hash?.slice(1).split(",")[1] ?? null;
```

### The KDF and cipher [V]

Both implementations must match byte-for-byte, and the Rust side carries a golden-vector test
(`encrypt.rs:65-72`) to prove it.

- **KDF:** Argon2id, version 0x13, **m = 19 MiB (19*1024 KiB), t = 2, p = 1, output 16 bytes**.
- **Salt:** a hardcoded, public, *global* constant string: `"This is a non-random salt for sshx.io,
  since we want to stretch the security of 83-bit keys!"` The source comment justifies it: "The KDF
  salt is public, as it needs to be used from the web client. It only exists to make rainbow table
  attacks less likely."
- **Cipher:** AES-128 in CTR mode, `Ctr64BE` — a 64-bit big-endian counter in the low 8 bytes of the
  IV, with the **stream number in the high 8 bytes**.
- **Key check ("encrypted zeros"):** AES-CTR-encrypt 16 zero bytes under a zero IV. This is a
  key-check value, like a KCV on a payment HSM: it proves you hold the key without revealing it.

### Stream separation [V]

CTR mode dies on keystream reuse, so sshx partitions the keystream by stream number, and hard-asserts
that stream 0 is never used (both `encrypt.rs:48` and `encrypt.ts:56`, both labelled
"security check"):

| Stream number | Carries | Set in |
|---|---|---|
| `0x100000000 \| shell_id` | Terminal **output** for that shell | `runner.rs:118` |
| `0x200000000` | Terminal **input** from *all* browsers, for *all* shells | `Session.svelte:300`, `controller.rs:198` |

Offsets within the output stream are absolute byte positions in that shell's stream — which is
exactly why the seqnum resync in §2 is safe: re-sending byte range [a,b) always produces identical
ciphertext.

Offsets in the **input** stream are chosen by each browser: on its first keystroke it seeds a
**random 64-bit counter** from `crypto.getRandomValues` and advances it by the byte length of each
input (`Session.svelte:291-302` **[V]**). The comment "Must increment before the `await`" is load
bearing — it prevents two concurrent async encrypts from claiming the same offset.

### The join handshake [V] (`socket.rs:94-130`)

1. Browser connects to `/api/s/{name}`; server immediately sends `Hello(uid, session_name)`.
2. Browser must reply with `Authenticate(encrypted_zeros, Option<write_encrypted_zeros>)` as the very
   first message — anything else is an immediate `InvalidAuth` and disconnect.
3. Server compares the submitted zeros block against the stored one using
   `subtle::ConstantTimeEq` **[V]**. Mismatch → `InvalidAuth`.
4. Write permission is then resolved by a 3-case match:
   - no stored password → **everyone can write** (default when `--enable-readers` is off);
   - stored but not provided → **read-only**;
   - stored and provided → constant-time compare; mismatch is a **hard `InvalidAuth`**, not a silent
     downgrade to read-only.
5. `can_write` is baked into the `WsUser` record for the connection's lifetime.

### Security assessment — what this design does and does not give you

**Genuinely holds up [V]:**
- The relay never sees the key, the write password, or any plaintext terminal byte. Confirmed by
  reading every server file: `session.rs` handles `Bytes` opaquely and there is no cipher import
  anywhere in `sshx-server`.
- Read-only is enforced server-side on **every** mutating message via `check_write_permission`, not
  just in the UI (`socket.rs:178,190,199,215` **[V]**). The client-side `hasWriteAccess` guards in
  `Session.svelte` are cosmetic; the real gate is the relay.
- Constant-time comparison on both secrets.
- Session tokens are HMAC-SHA256 over the session name (`grpc.rs:65`, `state.rs:53` **[V]**), so a
  CLI cannot hijack another session's stream.

**Real limitations TermX must not inherit blindly:**

1. **No integrity/authentication whatsoever. [V by absence]** AES-CTR with no MAC, no AEAD, no
   signature. A malicious or compromised relay cannot *read* your terminal, but it can **flip
   arbitrary bits** in output ciphertext, and CTR mode turns a bit-flip in the ciphertext into the
   same bit-flip in the plaintext. That means a hostile relay can inject chosen text (including ANSI
   escape sequences) into what a viewer sees. It can also replay recorded input ciphertext into the
   PTY. **If TermX adopts this, use AES-GCM or ChaCha20-Poly1305, or encrypt-then-MAC.**
2. **Read-only is not confidentiality. [V]** A read-only viewer holds the full encryption key — it
   is the part of the fragment before the comma. They can decrypt everything, including the *input*
   stream, i.e. every keystroke every writer types. "Read-only" means "the relay will refuse your
   writes", nothing more.
3. **Shared input keystream across writers. [V]** All browsers write into stream `0x200000000` at
   self-chosen offsets. Honest clients collide only with ~birthday probability on a random 64-bit
   seed, which is fine. A *malicious* writer, however, can deliberately pick an offset overlapping
   another writer's range and recover that writer's plaintext by XOR **[I — attack not demonstrated,
   but it follows directly from the construction]**.
4. **Global constant salt. [V]** One salt for the entire service means an attacker can build one
   table against sshx.io and attack every session with it. 83 bits still makes that impractical, but
   a per-session salt (the session name is right there and is public anyway) would have cost nothing.
5. **Chat and display names are NOT end-to-end encrypted. [V]** `WsClient::Chat(String)` →
   `Session::send_chat(&str)` → `WsServer::Hear(uid, name, String)` — plaintext through the relay
   (`protocol.rs:92,62`, `session.rs:359-369`). Same for `SetName`. The relay operator reads all
   session chat and every participant's name. This is an easy thing for TermX to do better.
6. **No terminal count limit on the server. [V]** The "max 14 terminals" cap lives only in
   `Session.svelte:273`; `WsClient::Create` on the server checks write permission and nothing else.
   A hostile writer can request unbounded shells, each costing 2 MiB of relay RAM.

---

## 4. Multi-writer / presence semantics

**There is no conflict resolution, and that is the correct answer.** [V]

Every writer's bytes go into the same PTY file descriptor. The PTY *is* the serialization point;
the kernel (or ConPTY) orders the writes. There is no CRDT, no OT, no lock, no turn-taking, no
"who has the pen". Two people typing simultaneously interleave their bytes exactly as two people
sharing a `screen` session do. sshx does not attempt to fix this, and there is no code anywhere
that tries.

What it *does* provide is enough awareness that humans self-coordinate:

**Per-user state** (`WsUser` in `web/protocol.rs:35-44` **[V]**):
```rust
pub struct WsUser {
    pub name: String,            // self-chosen, default "User {uid}", plaintext to server
    pub cursor: Option<(i32,i32)>,  // MOUSE position on the infinite canvas, not text cursor
    pub focus: Option<Sid>,      // which terminal window this user is focused on
    pub can_write: bool,
}
```

**Presence propagation [V]:**
- On join, the new socket receives a full `Users` snapshot (`socket.rs:134`).
- Thereafter every change is a `UserDiff(uid, Some(user))` broadcast; departure is
  `UserDiff(uid, None)` (`session.rs:299-346`).
- Departure is guaranteed by RAII: `user_scope()` returns a `UserGuard` whose `Drop` impl removes the
  user and broadcasts the diff (`session.rs:313-338`). No leaked ghost users on panic or abrupt
  disconnect. **This is a pattern TermX should copy verbatim.**
- The broadcast channel is `tokio::sync::broadcast` with capacity 64; a slow client that falls behind
  gets `BroadcastStreamRecvError::Lagged`, which `socket.rs:144` turns into a hard connection error
  ("client fell behind on broadcast stream"). Blunt but safe — the client reconnects and re-snapshots.
- The doc comment on the broadcast field states the invariant explicitly: *"Every update inside this
  channel must be of idempotent form, since messages may arrive before or after any snapshot"*
  **[V]** (`session.rs:62-66`).

**Cursors [V]:** live *mouse* cursors on the shared infinite canvas, throttled to 80 ms
(`Session.svelte:324`), rendered via the `perfect-cursors` npm package for spline interpolation
between samples. `setCursor(null)` is sent on `mouseleave`. Terminal moves are throttled to 50 ms.
Focus changes are debounced 20 ms, with the comment "blur events happen before focus events"
(`Session.svelte:388`).

**Avatars [V]:** each terminal window shows avatars of the users whose `focus === thisShellId`
(`Session.svelte:544-548`), so you can see who is "in" a terminal before you start typing in it.

**Shared window management [V]:** window position, size, and z-order are session state, not per-user
view state. `Move(Sid, Option<WsWinsize>)` with `None` means "bring to front" — implemented as
remove-and-push on the ordered `Vec` (`session.rs:247-256`). Everyone sees the same layout, and
resizing a terminal resizes the actual PTY for everyone (`socket.rs:205-212` sends
`ServerMessage::Resize` → `term.set_winsize`). There is no per-viewer independent sizing; the PTY has
one size.

**Latency instrumentation [V]:** two separate round trips, surfaced in a `NetworkInfo` panel.
Browser↔relay via `WsClient::Ping`/`WsServer::Pong` every 2 s, and relay↔CLI via
`ServerMessage::Ping`/`ClientMessage::Pong` every 2 s, the latter broadcast to all browsers as
`ShellLatency`. Both are reported as a 10-sample median (`Session.svelte:248-257`). The typeahead
addon consumes this: predictive echo turns **on** when measured latency exceeds a 50 ms threshold
(`typeahead.ts:1600,1759`).

---

## 5. Self-hosting the relay (fit for the VPS)

### The official position [V]

`README.md` is blunt:

> "Self-hosted deployments are not supported at the moment. If you want to deploy sshx, you'll need
> to properly implement HTTP/TCP reverse proxies, gRPC forwarding, TLS termination, private mesh
> networking, and graceful shutdown."

That warning is scoped to running a *global mesh* like sshx.io. **A single-node relay is much
simpler than the README implies**, and the code supports it as a first-class path.

### Single-node mode is real, not a hack [V]

`ServerState::new` only constructs a `StorageMesh` when `redis_url` is `Some` (`state.rs:48-51`).
With no Redis:
- `backend_connect` / `frontend_connect` never consult the mesh (`state.rs:116,140`);
- `insert` skips the background sync task (`state.rs:77`);
- `listen_for_transfers` returns immediately (`state.rs:154`).

So: **one binary + one `build/` directory + one port.** Sessions live purely in RAM and die with the
process, which is acceptable given they already expire after 300 s of CLI disconnect.

### What running it actually takes

```bash
sshx-server --listen :: --port 8051 --secret "$SSHX_SECRET" --override-origin "https://term.example.com"
```

- `--secret` / `SSHX_SECRET` **matters**: without it, `state.rs:47` generates a random 22-char secret
  per boot **[V]**, which invalidates every outstanding session token on restart.
- `--override-origin` makes the relay decide the printed URL rather than trusting the CLI's
  `--server` value (`grpc.rs:47` **[V]**). Set it, so shared links use the public hostname.
- Default bind is `::1` (loopback-only) **[V]**, so it is safe-by-default and you must opt into
  exposure.
- Static assets are served from `./build` **relative to the working directory** (`web.rs:16-21`
  **[V]**), with precompressed gzip/br support. Set the working directory correctly in the systemd unit.
- Prebuilt `sshx-server` binaries for `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`
  are published to S3 by `scripts/release.sh` **[V]** — statically linked, so no glibc concerns.
  Or use the two-stage `Dockerfile` (rust:alpine + node:lts-alpine → alpine) **[V]**.

**The one genuine obstacle: the reverse proxy must speak gRPC.** Because gRPC and the WebSocket share
a port and are separated by `Content-Type`, the proxy must (a) support HTTP/2 to the backend and
(b) not rewrite or buffer `application/grpc` bodies. Caddy handles this in about four lines; nginx
needs `grpc_pass` on a location match plus a separate `proxy_pass` with upgrade headers for
`/api/s/`. **[I — no proxy config exists in the repo; this follows from `listen.rs`'s Steer routing.]**
Simplest correct answer: terminate TLS in Caddy with HTTP/2 enabled and reverse-proxy everything to
`h2c://127.0.0.1:8051`.

**A gotcha for TermX specifically:** `sshx-server/src/main.rs` imports `tokio::signal::unix::{signal,
SignalKind}` **[V]**, so the server *binary* does not compile on Windows. The `sshx-server` *library*
(`lib.rs`) is platform-neutral **[I]**, so a Windows-hosted relay would need its own `main.rs` with
`ctrl_c()` handling. For the VPS this is a non-issue.

### Cost to run [I, extrapolated from verified constants]

The relay is memory-bound and nearly CPU-free: it never decrypts, never renders, never touches a PTY.
Per-session cost is `2 MiB × active_shells` of ring buffer plus per-connection Tokio task overhead.
A dozen concurrent sessions with a few shells each is comfortably under 100 MB RSS. Any $5/month VPS
is oversized for this. The real constraint is bandwidth on busy output (a `yes` loop streams at full
PTY rate, chunked at 64 KiB).

### The mesh, if you ever want multi-region [V]

Worth understanding even if you never use it, because the mechanism is elegant:
- Redis holds three keys per session: `session:{name}:owner` (hostname), `session:{name}:snapshot`
  (zstd-compressed protobuf), `session:{name}:closed` (tombstone). All with a 300 s TTL
  (`mesh.rs:14-22`).
- Every 20 s, or immediately on `sync_now()` (shell created/closed/counter bumped), the owner writes a
  fresh snapshot (`mesh.rs:105-138`).
- Snapshots are deliberately tiny: **32 KiB of scrollback per shell**, 4 MiB hard cap, zstd level 3
  (`snapshot.rs:16-18,68-69`). They exist for failover, not history — the CLI's 8 MiB buffer refills
  the rest via seqnum resync.
- When a CLI reconnects to a *different* node, that node restores from the snapshot, takes ownership,
  and publishes to `transfers:{old_owner}` so the old node drops its copy (`state.rs:111-129`,
  `mesh.rs:158-162`).
- Browsers hitting the wrong node are **transparently WebSocket-reverse-proxied** to the owner
  (`socket.rs:255-311`) rather than redirected — the URL never changes.

---

## 6. The 3-5 things TermX should adopt, and how they map

TermX today (verified by reading `C:\Dev\TermX\host\src\`): a `termx-host` daemon binding
`TcpListener::bind(("127.0.0.1", 0))` **[V]** with a random port and a shared-secret `Auth { token }`
gate, JSON control frames + binary PTY frames, `portable-pty`, and a `RingBuffer` with **absolute
stream offsets** plus a documented `Replay`/resync contract and disk-spilled history.

The good news: **TermX's `ring.rs` + `Replay`/`since_offset` design is already the same shape as
sshx's seqnum model, and in some ways better documented.** The delta to a shared session is smaller
than it looks.

### Adopt #1 — Invert the connection: the host DIALS the relay

**What sshx does:** the machine with the terminals is a *gRPC client*. It opens one outbound bidi
stream and the relay drives it (`Channel`). The relay never dials back.

**Why TermX needs this:** it is the single change that unlocks the roadmap item "VPS-resident
sessions + Ibrahim collaboration" without touching Michael's router, firewall, or DNS. A Windows
laptop behind NAT can host a session that a teammate joins from a browser.

**Mapping:** add `host/src/relay.rs` alongside `server.rs`. It mirrors `controller.rs`: dial the
relay, send `Hello{name, token}`, then a `select!` over (a) local session output → relay, (b) relay
messages → local sessions, (c) heartbeat tick, (d) forced-reconnect timer. The existing
`server.rs` loopback listener stays exactly as it is — local Tauri UI keeps using it, and the relay
becomes a *second* consumer of the same session broadcast. TermX already fans one session's output to
multiple sockets (`ws_a`/`ws_b` in its own tests **[V]**), so the fan-out primitive exists.

**Copy these two constants and the reasoning behind them:** the 2 s heartbeat, and especially the
**60 s deliberate reconnect** (`controller.rs:26`). The latter is counter-intuitive and it is exactly
what makes rolling relay restarts invisible. Also copy the backoff-with-reset-after-10s-stability
pattern (`controller.rs:147-157`) — this is directly relevant to the WS-reconnect work that is
currently the adoption blocker.

### Adopt #2 — Seqnum resync with the host as source of truth

**What sshx does:** the relay periodically advertises "I have N bytes of shell 3"; the host re-sends
whatever is missing; `add_data` refuses gaps and silently drops duplicates.

**Why TermX needs this:** it makes the relay disposable. Restart it, redeploy it, let it OOM — the
host refills it. Without this, a relay restart loses the session.

**Mapping:** TermX's ring already tracks `total_written` as an absolute offset, and `Replay` already
carries `start_offset` with a documented "may jump FORWARD, treat as lost scrollback" contract. Add
two messages: `HostMsg::Sync { session_id -> offset }` in the relay direction, and make the host's
send path compare against `ring.total_written`. Port the **three-strikes rule** from
`runner.rs:91-98` — do not rewind on a single stale sync, because sync messages race with in-flight
data. And port the idempotent-accept guard from `session.rs:262`
(`seq <= have && seq + len > have`) rather than inventing one; it is four lines and it makes the
whole thing safe to retry.

Keep TermX's disk-spill history local to the host. Do not replicate it to the relay: sshx's 32 KiB
snapshot proves that failover state and scrollback are different problems with different budgets.

### Adopt #3 — E2E encryption with the key in the URL fragment, but with AEAD

**What sshx does:** Argon2id-stretched random key → AES-128-CTR, keystream partitioned by stream
number, key travels only in the URL fragment, relay verifies possession via an encrypted-zeros KCV.

**Why TermX needs this:** the moment a session traverses Michael's VPS, "the relay operator can read
every client's terminal" becomes a real statement about a real machine. E2E makes the relay untrusted
infrastructure, which is the only sane security posture for a box that also runs other things.

**Mapping:**
- Vendor `crates/sshx/src/encrypt.rs` and `src/lib/encrypt.ts` as a matched pair into a new
  `host/src/crypto.rs` + `ui/src/lib/crypto.ts`. Keep the golden-vector test.
- **Change the cipher to AES-256-GCM or ChaCha20-Poly1305, per chunk.** sshx's lack of integrity
  (§3, limitation 1) is its weakest point and TermX has no reason to inherit it. Chunks are already
  discrete and offset-addressed, so per-chunk AEAD with the nonce derived from
  `(stream_number, offset)` fits the existing structure. Cost: 16 bytes of tag per 64 KiB chunk.
- **Use a per-session salt** — the session ID is already random and public. Free improvement.
- Keep the encrypted-zeros KCV handshake verbatim; it is a clean way to prove key possession without
  a challenge-response round trip, and `subtle::ConstantTimeEq` is already the right call.
- **Encrypt chat and display names too.** sshx leaks both; TermX should not.

### Adopt #4 — The read/write link split and the per-message permission gate

**What sshx does:** `#key` joins read-only, `#key,writepassword` joins writable. The relay checks
`can_write` on every mutating message, not just at handshake.

**Why TermX needs this:** "let Ibrahim watch" and "let Ibrahim drive" are genuinely different asks,
and the two-secret URL expresses it with zero account infrastructure.

**Mapping:** extend TermX's `ClientMsg::Auth { token }` to `Auth { token, write_token: Option<String> }`
and add a `can_write: bool` to the per-connection state. Then gate `CreateSession`, `Attach` (writes),
`Resize`, `CloseSession`, `SetLayout`, and `Shutdown` on it. Copy the exact 3-case match from
`socket.rs:107-122` including the detail that a *wrong* write password is a hard rejection rather
than a silent downgrade — silent downgrade would leave a collaborator confused about why their
keystrokes vanish.

Be explicit in TermX's UI about what sshx leaves implicit: **a read-only link still grants full
visibility, including other people's keystrokes.** If TermX ever needs true restricted visibility,
that requires a separate key and re-encryption at the host, which sshx does not do.

### Adopt #5 — RAII presence + idempotent broadcast

**What sshx does:** `user_scope()` returns a guard whose `Drop` removes the user and broadcasts
`UserDiff(uid, None)`; all broadcast messages are idempotent so they compose with snapshots in any
order.

**Why TermX needs this:** it is ~40 lines that eliminates the entire class of "ghost user still shown
as connected" bugs, and TermX has no user concept at all today.

**Mapping:** add `Uid` + a `users: RwLock<HashMap<Uid, User>>` to TermX's session registry, with
`{name, focus: Option<SessionId>, can_write}`. Send a full `Users` snapshot on attach, `UserDiff`
thereafter. Skip mouse cursors initially — they are canvas-specific and TermX's UI is a tabbed/sidebar
layout, not an infinite canvas — but keep `focus`, because "who is looking at this pane" is the piece
that actually prevents two people typing over each other.

### Honorable mention, cheap and high-impact

**Vendor `typeahead.ts` for predictive echo.** 1961 lines, MIT (from VS Code), already adapted to be
standalone, and it activates automatically above a 50 ms latency threshold using measured RTT. Over a
VPS relay to a remote session this is the difference between "feels like SSH" and "feels laggy".
It expects `sshx-xterm` types; TermX uses xterm.js, so expect some type-shimming **[I]**. Carry both
the Microsoft and ekzhang MIT notices.

---

## 7. Gaps — what sshx lacks that TermX's teams/admin vision needs

sshx is a *single-purpose ephemeral link-sharing tool*. Every gap below is a deliberate scope
decision by its author, not an oversight. TermX's roadmap (persistent VPS sessions, teams, admin,
saved/named sessions, blocks UI) needs all of them.

1. **No identity, accounts, or teams. [V]** A user is a `Uid` (an `AtomicU32` starting at 1) plus a
   self-declared display name. Anyone can claim any name. There is nothing to build "Ibrahim has
   standing access to the staging box" on.
2. **No revocation, and the key cannot rotate. [V]** Access *is* the URL. Once shared, the only way
   to revoke is to kill the session (`Close` RPC) and start a new one with a new key. No per-user
   kick, no expiring invite, no "make everyone read-only now".
3. **Sessions are ephemeral by design. [V]** Random 10-char name, no reservation, evicted 300 s after
   the CLI disconnects, Redis snapshot TTL 300 s. There is no "reconnect to my long-running build
   tomorrow morning." TermX's whole VPS-resident-session premise is the opposite of this.
4. **No audit trail or session recording. [V]** Nothing is persisted beyond the 32 KiB/shell failover
   snapshot. There is no record of who joined, when, or what they typed. For a shared-with-a-colleague
   box this is a real compliance gap — and note that **E2E encryption makes server-side audit
   fundamentally impossible**, so if TermX wants audit it must be recorded *host-side*, before
   encryption. Design that in from the start.
5. **No admin surface at all. [V]** No API to list sessions, no metrics endpoint, no health check
   beyond fly.io's TCP probe, no way to see who is connected to what. `ServerState.store` is a
   `DashMap` with no HTTP exposure.
6. **No resource limits on the relay. [V]** No per-session shell cap (the 14 is client-side only), no
   rate limiting, no bandwidth cap, no cap on concurrent sessions. Fine for an invite-only tool;
   inadequate for anything reachable from the internet.
7. **Chat and names traverse the relay in plaintext. [V]** Covered in §3.
8. **No file transfer, no port forwarding, no SFTP.** Terminal bytes only. **[V by absence]**
9. **No shell integration or semantic output.** sshx moves an opaque byte stream; it has no notion of
   where a command starts or ends. **TermX is already ahead here** — `host/src/protocol.rs` has an
   OSC 9;9 `shell_integration` flag **[V]** — and the blocks-UI vision needs exactly that structure,
   which sshx offers no help with. Note that any command/block framing must survive the encryption
   boundary, so it belongs in the host's message layer, not in parsed output at the relay.
10. **Weak Windows support — TermX is strictly ahead. [V]** `crates/sshx/src/terminal/windows.rs` is
    119 lines wrapping the `conpty` 0.7 crate, and its own doc comment says: *"I can't get
    `powershell.exe` to work with ConPTY, since it returns error 8009001d... This is why I don't
    typically use Windows!"* Its default-shell probe checks exactly two hardcoded paths (Git Bash,
    then `cmd.exe`). TermX's `portable-pty`-based host with profiles and shell integration is a
    materially better Windows implementation. **Borrow nothing from sshx's PTY layer.**
11. **Server binary is Unix-only. [V]** `tokio::signal::unix` in `sshx-server/src/main.rs`. Non-issue
    for the VPS, worth knowing if a relay ever needs to run on Windows.
12. **No per-viewer terminal sizing. [V]** One PTY, one winsize, shared by everyone; whoever resizes
    resizes it for all. With participants on different screens this is a real annoyance and there is
    no reflow/fit-per-viewer story. sshx sidesteps it with the zoomable infinite canvas — a UI answer
    to a protocol limitation.
13. **Upstream is dormant. [V/I]** Tip of `main` is 2025-06-19. Treat any vendored code as a fork you
    now own.

---

## 8. Sources

All primary sources are files in the sshx repository at commit `dd42496`, cloned locally to:
`C:\Users\mjfos\AppData\Local\Temp\claude\C--Dev\7e673402-8c77-471b-bbda-fa825fd7a42e\scratchpad\sshx`
(scratchpad — treat as disposable; re-clone from `https://github.com/ekzhang/sshx` to reproduce).

Files read in full for this study:

| Path | What it established |
|---|---|
| `LICENSE`, `Cargo.toml` | MIT, Eric Zhang 2023, workspace v0.4.1 |
| `README.md` | Feature list, install story, **"Self-hosted deployments are not supported"** |
| `crates/sshx-core/proto/sshx.proto` | Full gRPC contract, all message shapes |
| `crates/sshx-core/src/lib.rs` | `Sid`/`Uid`/`IdCounter`, `rand_alphanumeric` |
| `crates/sshx/src/main.rs` | CLI flags incl. `--enable-readers` |
| `crates/sshx/src/controller.rs` | Key generation, URL construction, reconnect loop, timings |
| `crates/sshx/src/runner.rs` | Rolling buffer, chunking, seqnum resync, stream numbers |
| `crates/sshx/src/encrypt.rs` | Argon2id params, AES-CTR, salt, KCV, golden vectors |
| `crates/sshx/src/terminal/windows.rs` | ConPTY limits, PowerShell failure comment |
| `crates/sshx/src/terminal/unix.rs` (partial) | openpty/fork/login_tty approach |
| `crates/sshx/Cargo.toml`, `crates/sshx-server/Cargo.toml` | Dependency surface |
| `crates/sshx-server/src/lib.rs`, `main.rs`, `listen.rs`, `web.rs` | Server options, Steer multiplexing, static serving, Unix-only main |
| `crates/sshx-server/src/grpc.rs` | Open/Channel/Close, HMAC tokens, sync + ping intervals |
| `crates/sshx-server/src/session.rs` | Session state, 2 MiB ring, idempotent `add_data`, RAII `user_scope`, subscribe_chunks |
| `crates/sshx-server/src/session/snapshot.rs` | 32 KiB/shell, 4 MiB cap, zstd |
| `crates/sshx-server/src/state.rs`, `state/mesh.rs` | DashMap store, expiry, Redis owner/snapshot/transfer |
| `crates/sshx-server/src/web/protocol.rs` | `WsClient`/`WsServer`/`WsUser`/`WsWinsize` |
| `crates/sshx-server/src/web/socket.rs` | Auth handshake, write-permission gate, proxy_redirect |
| `crates/sshx-server/tests/with_client.rs` (partial) | Integration test shape |
| `src/lib/encrypt.ts` | Browser KDF/cipher, must match Rust byte-for-byte |
| `src/lib/Session.svelte` | Fragment parsing, input counter seeding, throttles, presence UI |
| `src/lib/srocket.ts`, `src/lib/lock.ts` | Reconnecting CBOR socket, async ordering lock |
| `src/lib/ui/XTerm.svelte` | xterm.js setup, addons, typeahead wiring |
| `src/lib/typeahead.ts` (header + greps) | VS Code 1.80.1 fork, 50 ms threshold |
| `src/routes/s/[id]/+page.svelte` | Session route |
| `package.json` | `sshx-xterm` fork, argon2-browser, cbor-x, perfect-cursors |
| `Dockerfile`, `compose.yaml`, `fly.toml`, `scripts/release.sh` | Deployment and release targets |

TermX files read for the mapping in §6 (read-only, unmodified):
`C:\Dev\TermX\host\Cargo.toml`, `C:\Dev\TermX\host\src\protocol.rs`, `C:\Dev\TermX\host\src\ring.rs`,
and greps over `C:\Dev\TermX\host\src\server.rs`.

Not consulted: sshx.io marketing pages, GitHub issues/discussions, npm `sshx-xterm` fork internals
(the specific divergence from upstream xterm.js 5.2.1 is **[I]** and unexamined).
