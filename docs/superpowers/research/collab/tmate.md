# tmate — Product Study for TermX Session Sharing

**Studied:** 2026-08-22 · **Method:** primary source read of `tmate`, `tmate-ssh-server`,
`tmate-websocket`, `tmate-master`, `tmate-kube` at `master`, plus live probes of tmate.io.
**Marking:** every claim is tagged **[V]** verified by reading source/config or running a probe,
or **[I]** inferred/reasoned. No claim rests on marketing copy.

> One-line verdict: **learn, do not borrow.** tmate's *ideas* are the best-proven in this space
> and several map directly onto TermX's roadmap. Its *code* is a C tmux fork under ambiguous
> licensing, and the two components you would actually need for a web viewer carry **no license
> file at all**.

---

## 1. Licenses + borrow-vs-learn

Checked per repo — this matters because the answer is **not uniform**, and the ambiguity lands
exactly on the parts a Windows/Rust project would be tempted to lift.

| Repo | License file present? | Stated license | GitHub SPDX | Verdict |
|---|---|---|---|---|
| `tmate` | `COPYING` (tmux ISC notice) | README: "tmux and tmate are BSD-licensed" | `NOASSERTION` | Permissive but loose **[V]** |
| `tmate-ssh-server` | `COPYING` (tmux ISC notice), **no `LICENSE`** | README.md: "MIT license." | `NOASSERTION` | **Contradictory** — MIT claimed, ISC file shipped **[V]** |
| `tmate-websocket` | **none** | **none** (no README either) | *(none)* | **All rights reserved** by default **[V]** |
| `tmate-master` | **none** | **none** | *(none)* | **All rights reserved** by default **[V]** |
| `tmate-kube` | **none** | **none** | *(none)* | All rights reserved **[V]** |

Detail worth knowing: `COPYING` in both C repos opens with
`THIS IS FOR INFORMATION ONLY, CODE IS UNDER THE LICENCE AT THE TOP OF ITS FILE.` **[V]** — the
inherited tmux `.c` files carry per-file ISC headers, but the *tmate-specific* files
(`tmate-ssh-server.c`, `tmate-ssh-daemon.c`, `tmate-ssh-client-pty.c`, `tmate-websocket.c`, …)
carry **no copyright header at all** **[V]**. So the exact files implementing the interesting
behaviour are the ones with the weakest license provenance.

**Borrow-vs-learn: LEARN.** Three independent reasons, any one of which is sufficient:

1. **Legal.** The web-viewer path (`tmate-websocket` + `tmate-master`) is unlicensed. Absent a
   license grant, default copyright applies and vendoring is not permitted. **[V]**
2. **Technical.** `tmate-ssh-server` is not a library — it is a *complete second copy of the tmux
   source tree* (≈150 `.c` files: `window.c`, `grid.c`, `layout.c`, `server-client.c` …) with the
   tmate files added alongside **[V]**. There is no extractable "relay" module; the relay *is* a
   tmux fork. TermX is Rust + ConPTY, so the impedance mismatch is total.
3. **Platform.** Session isolation depends on Linux namespaces — the container needs `SYS_ADMIN`
   "to create nested containers (namespaces) to secure sessions" **[V]**. Nothing here ports to a
   Windows host process.

The safe path is to reimplement the *protocol shape and security model* in Rust. Those are ideas,
not expression, and the ideas are the valuable part.

---

## 2. Relay architecture (from source)

### The core trick: the relay is a tmux server that speaks SSH

The single most important structural fact, and the one most write-ups get wrong: tmate's server is
**not a proxy that shuttles bytes between two SSH connections.** The relay host *runs the tmux
server process itself*. The person's laptop runs only a tmux **client**.

Concretely, on connection the server forks and assigns the connection a role based on **what kind
of SSH channel request arrives** — all three roles share one TCP port:

| Who | SSH username | Channel request | Role assigned | Handler |
|---|---|---|---|---|
| Host (session owner) | `tmate` | `subsystem "tmate"` | `TMATE_ROLE_DAEMON` | `tmate_spawn_daemon()` |
| Guest (human) | *the session token* | `shell` / `pty` | `TMATE_ROLE_PTY_CLIENT` | `tmate_spawn_pty_client()` |
| Tooling | *the session token* | `exec <cmd>` | exec | `tmate_spawn_exec()` |

All **[V]** — `tmate-ssh-server.c` `subsystem_request()` / `shell_request()` / `exec_request()`,
and client side `ssh_options_set(session, SSH_OPTIONS_USER, "tmate")` +
`ssh_channel_request_subsystem(channel, "tmate")` in `tmate-ssh-client.c`.

Flow:

```
  HOST laptop                    RELAY VPS (one SSH port)                 GUEST
  ───────────                    ───────────────────────                  ─────
  tmate (tmux fork)              sshd-ish (libssh, forks per conn)
    │ outbound SSH ───────────►  user=tmate, subsystem=tmate
    │  as user "tmate"             └─► fork → tmate_spawn_daemon()
    │                                   ├─ server_create_socket()
    │  msgpack protocol                 │    /tmp/tmate/sessions/<TOKEN>   (unix socket)
    │  over the SSH channel  ◄──►       ├─ create_session_ro_symlink()
    │  (screen state, input)            │    /tmp/tmate/sessions/ro-<TOK> ─┐ symlink
    │                                   └─ tmux_server_init(); server_start()
    │                                        ▲                             │
    └─ receives the URLs ◄──────────────┐    │ unix socket                 │
                                        │    │                             │
                                   fork → tmate_spawn_pty_client()  ◄──────┴── ssh <TOKEN>@host
                                        client_connect(socket_path)             or ssh ro-<TOKEN>@host
```

Key consequences of "the tmux server lives on the relay":

- **The host can disconnect and the session survives** — the terminal state is server-side. **[I,
  strongly implied]** by `server_start()` running in the relay-side fork and the reconnection
  machinery in §3.
- **Every participant, including the host, is a peer client of one server.** This collapses the
  "who is authoritative" question that plagues peer-to-peer sharing designs. **[V]**
- **Multiplexing/panes/scrollback are free**, because it's literally tmux. **[V]**

Outbound-only from the host is why tmate works behind NAT and corporate firewalls with zero
configuration — the host never listens. **[V]** (host initiates the SSH connection).

### The web path

`tmate-ssh-server` optionally links to a second daemon. When `HAS_WEBSOCKET=1` **[V]**, the
C server opens a plain **TCP** connection to the Elixir `tmate-websocket` server
(`_tmate_connect_to_websocket()`, default port **4002** via `TMATE_DEFAULT_WEBSOCKET_PORT`) **[V]**
and forwards the msgpack session stream. Elixir side is a `ranch` TCP acceptor
(`daemon_tcp.ex`, `port: 4002`) feeding a `Tmate.Session` GenServer per session **[V]**.

Browsers then connect over **WebSocket on 4001** (`WEBSOCKET_PORT`, default `"4001"`) to
`.../ws/session/<token>` **[V]**, served by cowboy. The actual HTML/xterm client and the
homepage live in `tmate-master` (Phoenix; `assets/js/term/{session,window,pane}.js`) **[V]**.

Notably, when a websocket server is present the **C server stops emitting the user-facing
notifications entirely** and delegates: `if (tmate_has_websocket()) { tmate_send_websocket_header(session); return; }` **[V]**
— all URL text is then produced by the Elixir layer. Clean separation: C does transport, Elixir
does product.

---

## 3. Session URL / auth flow, and the read-only enforcement point

### Token generation

- Length **25** chars (`TMATE_TOKEN_LEN 25`), drawn from `/dev/urandom` via a buffered stream **[V]**.
- Alphabet deliberately excludes look-alike glyphs — comment in source: *"We skip letters that are
  hard to distinguish when reading"*. It keeps
  `abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789` = **55 chars** **[V]**, dropping
  lowercase `i l o`, uppercase `I O`, and digits `0 1`. Note the asymmetry: uppercase `L` is kept
  while lowercase `l` is dropped — the confusable pair is `l`/`1`, not `L`/`1` **[V]**.
  25 chars × log2(55) ≈ **144.5 bits** of entropy **[V, computed]** — unguessable, which is the
  whole security model.
- Rejection sampling (`while (c >= NUM_DIGITS)`) avoids modulo bias **[V]**.

### The URLs the host receives

Without a websocket server, the C code emits four things directly **[V]**:

```
ssh session read only: ssh ro-<TOKEN_RO>@<host>     → env tmate_ssh_ro
ssh session:           ssh <TOKEN>@<host>           → env tmate_ssh
```
plus the warning `Note: clear your terminal before sharing readonly access` **[V]**.

With the websocket server, Elixir emits all four, web included **[V]** (`session.ex`):

```
web session read only: <base>t/<TOKEN_RO>
ssh session read only: ssh ro-...@host
web session:           <base>t/<TOKEN>
ssh session:           ssh ...@host
```
The web URL format is `"#{user_facing_base_url}t/%s"` **[V]** — i.e. `https://tmate.io/t/<token>`.

Both are also exported as tmux environment variables (`tmate_ssh`, `tmate_ssh_ro`, and web
equivalents), which is how `tmate display -p '#{tmate_ssh}'` scripting works **[V]**.

### ⭐ The read-only enforcement point — the symlink trick

This is the mechanism worth stealing conceptually. The read-only token is **a filesystem symlink
pointing at the read-write session's unix socket** **[V]** (`create_session_ro_symlink()`):

```c
xasprintf(&token, "ro-%s", get_random_token());   /* independent 25-char token, NOT derived */
session->session_token_ro = token;
xasprintf(&session_ro_path, TMATE_WORKDIR "/sessions/%s", session->session_token_ro);
symlink(session->session_token, session_ro_path);
```

Then, when *any* guest connects, the server resolves the username to a socket path and asks one
question — *did I arrive via a symlink?* **[V]** (`tmate_spawn_pty_client()`):

```c
session->readonly = false;
if (lstat(socket_path, &fstat) < 0) tmate_fatal("Cannot fstat()");
if (S_ISLNK(fstat.st_mode)) {
        session->readonly = true;
        argv = argv_ro;          /* "attach", "-r" */
        argc = 2;
}
```

`lstat` (not `stat`) is load-bearing: it deliberately does *not* follow the link, so the link-ness
is the signal. Both tokens name the same tmux server; only the path taken differs.

Enforcement is then applied at **three independent layers** — genuine defence in depth **[V]**:

1. **Transport.** Guest keystrokes are dropped before ever reaching the pty:
   `if (session->readonly) return total_len;` at the top of `on_ssh_channel_read()` — it lies about
   having written the bytes, so the SSH channel stays healthy while input is discarded.
2. **Application.** tmux is invoked as `attach -r`, setting `CLIENT_READONLY` (`0x800`) on the
   server-side client struct.
3. **Web.** Enforced by **Erlang function-head pattern matching**, which is unusually elegant:
   ```elixir
   def websocket_handle({:binary, msg}, %{access_mode: :rw} = state) do
     handle_ws_msg(state, deserialize_msg!(msg)); {:ok, state}
   end
   def websocket_handle({:binary, _msg}, state), do: {:ok, state}   # ro falls here, silently dropped
   ```
   The `access_mode` comes from `SessionRegistry.get_session/2`, which returns `{:rw, pid}` if the
   token matched `stoken` and `{:ro, pid}` if it matched `stoken_ro` **[V]**. A read-only client
   *cannot* reach the write path — there is no branch to forget, no flag to check.

Window-resize is the deliberate exception: `SSH_CHANNEL_REQUEST_WINDOW_CHANGE` is handled *outside*
the readonly gate, so read-only viewers still resize **[V]**. (Which is a real, if minor,
side-channel: a read-only viewer can perturb the host's layout. **[I]**)

### Auth: bearer-token by default, pubkey allowlist opt-in

Default posture is **no authentication** — `ssh_set_auth_methods(..., SSH_AUTH_METHOD_NONE | ...)`
and `auth_none_cb()` simply accepts and records the username **[V]**. The username *is* the
credential. Anyone with the URL is in; that is the entire model.

Optional hardening via `set tmate-authorized-keys` **[V]**: the host supplies a list of allowed SSH
public keys, and `tmate_allow_auth()` compares the presented key with `ssh_key_cmp(...,
SSH_KEY_CMP_PUBLIC)` **[V]**. Default-open is explicit: `if (!tmate_session->authorized_keys) return true;` **[V]**.

There's a subtle and honest piece of engineering in `would_tmate_session_allow_auth()`: the SSH
server process must answer the pubkey question *before* the session process exists in its context,
so it briefly connects to the session's unix socket to ask. The source comment concedes
*"The existance of this function is a bit unpleasant"* **[V]**, and notes the client is
**re-authenticated later** in `server-client.c` — i.e. the early check is a UX affordance (it makes
`ssh` cycle through its keys) and is *not* the security boundary. Good pattern: never let a
convenience check become the only check. **[V]**

**Named sessions + API keys** are a websocket-server-only feature **[V]** — the C daemon prints
`"Named sessions are not supported (no websocket server)"` if you try without one **[V]**. Flow:
API key is exactly **30 chars** (`@api_key_length 30`), exchanged via
`MasterApi.get_named_session_prefix(api_key)` for a **prefix**, and the final token becomes
`"#{prefix}#{desired_stoken}"` **[V]**. That namespacing is why `/` is in the *validation*
alphabet (`valid_digits` includes `-_/`) though never in *generated* tokens **[V]**. Renaming
rewrites the unix sockets and re-creates the symlink — same mechanism, new names **[V]**:
`File.rename(...)` then `File.ln_s(stoken, p.(stoken_ro))`.

Path-traversal defence is a one-line comment plus a whitelist: *"get_socket_path() replaces '/' and
'.' by '_' to avoid wondering around the file system"* **[V]**, backed by `tmate_validate_session_token()`
rejecting any char outside the alphabet and any token ≤ 2 chars **[V]**.

### Reconnection: HMAC-signed stateless resume token ⭐

Directly relevant to TermX's WebSocket-reconnect problem. The server hands the client an opaque
blob and *forgets about it*; the client presents it on reconnect **[V]**:

```elixir
def pack_and_sign!(value)   # → [msgpack(data), :crypto.hmac(:sha256, hmac_key, data)]
def verify_and_unpack!(v)   # ^received_signature = ... (pattern match; crashes on mismatch)
new_reconnection_data = [2, id, stoken, stoken_ro, Tmate.host, generation+1]
daemon_set_env(state, "tmate_reconnection_data", pack_and_sign!(new_reconnection_data))
```

Three things to note: it is **versioned** (leading `2`), it carries a **`generation` counter** that
increments each reconnect (replay/staleness detection), and it records the **origin host** so a
multi-node fleet can route the resume back. Verification uses Erlang's `^` pin-match, so a bad
signature crashes the process rather than falling through — fail-closed by construction. **[V]**

Client-side, the host **pins the relay's host-key fingerprint** rather than using
`known_hosts` **[V]** — `tmate-server-{rsa,ecdsa,ed25519}-fingerprint` options compared with a
plain `strcmp` against `ssh_get_publickey_hash(SSH_PUBLICKEY_HASH_SHA256, ...)`, killing the
connection on mismatch **[V]**. Self-hosters must therefore distribute their own fingerprints.

---

## 4. Self-hosting on a VPS

**Documented?** Partially, and the good documentation is *not* the README — it's the k8s manifests
in `tmate-kube`, which are the real production config **[V]**. The `tmate-ssh-server` README covers
only env vars **[V]**. tmate.io's own hosted docs were **unreachable at study time** (see §6).

### Components

| Component | Language | Image | Role | License |
|---|---|---|---|---|
| `tmate-ssh-server` | C | `tmate/tmate-ssh-server` **[V]** | SSH relay + tmux server | ambiguous MIT/ISC |
| `tmate-websocket` | Elixir | `tmate/tmate-websocket` **[V]** | msgpack→WS bridge, named sessions, webhooks | **none** |
| `tmate-master` | Elixir/Phoenix | *(built from repo)* | homepage, HTML/xterm client, accounts, API keys | **none** |
| PostgreSQL | — | — | master's DB (`dev/postgres.yaml`, `bootstrap_db.txt`) **[V]** | — |

**Minimum viable relay = just `tmate-ssh-server`.** SSH-only sharing (rw + ro) works standalone;
you lose the web viewer and named sessions. **[V]** This is the tier a TermX owner would actually run.

### Ports

| Port | Component | Purpose | Source |
|---|---|---|---|
| **2200** | ssh-server | listen (`TMATE_SSH_DEFAULT_PORT` when not in-container) | **[V]** |
| **22** | ssh-server | *advertised* to hosts via `SSH_PORT_ADVERTISE` | **[V]** |
| **4002** | websocket | daemon TCP link from the C server | **[V]** |
| **4001** | websocket | browser WebSocket (`WEBSOCKET_PORT`, TLS if `SSL_KEY_FILE`) | **[V]** |

Listen ≠ advertise is a deliberate split: run unprivileged on 2200, terminate 22 at the LB, and the
URL printed to the user still says 22 (the code omits `-p` entirely when advertised port == 22) **[V]**.

### Env vars (ssh-server) **[V]**

`SSH_KEYS_PATH` (mandatory) · `HAS_WEBSOCKET=1` · `USE_PROXY_PROTOCOL=1` · `SSH_HOSTNAME` ·
`SSH_PORT_LISTEN` · `SSH_PORT_ADVERTISE`. Host keys are generated by `create_keys.sh` **[V]**.
Container **requires `SYS_ADMIN`** **[V]**.

### Env vars (websocket) **[V]**

`DAEMON_HMAC_KEY` · `WEBSOCKET_PORT` · `WEBSOCKET_BASE_URL` · `MASTER_BASE_URL` ·
`USER_FACING_BASE_URL` · `INTERNAL_API_AUTH_TOKEN` · `SSL_{KEY,CERT,CACERT}_FILE` ·
`ERL_NODE_NAME` / `ERL_COOKIE`.

### Topology

The two containers run **in the same pod sharing an `emptyDir` volume mounted at
`/tmp/tmate/sessions`** **[V]**. That is not incidental — the unix sockets *and the read-only
symlinks* live there, so both processes need the same filesystem. **This is what makes the design
single-node per session** **[I, direct consequence]**: the RO/RW distinction is a filesystem
artifact, so it cannot span machines without a shared mount. On a single VPS with docker-compose
and a shared volume, that constraint is free.

The manifest's own comment block explains the load-balancer choice — SSH can't carry an
`X-Forwarded-For` header, so real client IPs require **PROXY protocol**; they rejected `hostPort`
(NAT hides the IP) and `hostNetwork` (would have to relocate the node's own sshd) **[V]**. A
single-VPS TermX deployment sidesteps all of this: bind 22 directly, no LB, no PROXY protocol. **[I]**

**Realistic owner's VPS setup [I, synthesized from the above]:** one small box; `tmate-ssh-server`
on `:22` with generated host keys; skip `HAS_WEBSOCKET` unless a browser viewer is wanted; publish
the host-key fingerprints so clients can pin them. Adding the web tier means also running the
unlicensed Elixir pair plus Postgres — a meaningfully larger operational and legal commitment.

---

## 5. The 3–5 principles TermX should steal

**① The relay hosts the session, and one port serves every role.**
Do not build a byte-shuttling proxy. Put the authoritative session on the relay and let the owner's
machine be *a client of their own session*. Then distinguish roles by the *request type on a single
connection* (tmate: subsystem vs shell), not by separate ports or endpoints. **Why it wins:** the
host is outbound-only (NAT/firewall traversal for free), the session outlives the host's network,
"who is authoritative" never becomes a question, and there is exactly one port to secure and
firewall. For TermX this maps onto the VPS-resident-session roadmap item almost one-to-one: the
ConPTY daemon becomes the relay-resident authority and the Tauri UI becomes one more attached
client — the same code path that later serves Ibrahim.

**② Separate *capability* into separate unguessable identifiers — never a flag on one identifier.**
Two independent 25-char tokens, one meaning read-write and one meaning read-only. The read-only
token is **not derived** from the read-write one **[V]**, so possessing it grants no path to the
other. Sharing is then a pure copy-paste act with no UI, no roles table, no permission dialog.
**Steal the shape, replace the mechanism:** tmate's symlink is a Unix trick with no Windows analogue
and it ties the design to one filesystem. In Rust, a `HashMap<Token, (SessionId, AccessMode)>` gives
the identical guarantee, ports to Windows, and removes the single-node constraint from §4.

**③ Make read-only unforgettable by construction, then defend it in depth.**
The Elixir pattern-match is the model to copy: a read-only client should be *structurally incapable*
of reaching the write path, rather than checked at each call site. In Rust, hand attached clients a
typed handle — a `ReadOnlyClient` that simply has no `send_input` method, or an enum where only the
`ReadWrite` variant owns the pty writer. Then add tmate's second and third layers anyway: drop input
at the transport boundary, and mark the session read-only at the core. Three cheap layers, and no
future refactor can silently grant write access. Also copy the resize exception (viewers should
still resize) **and** be aware it's a small side-channel.

**④ Stateless, HMAC-signed, versioned, generation-counted resume tokens.**
This targets TermX's known adoption blocker directly. The server holds no reconnect state; it signs
`[version, id, tokens, host, generation]` and hands it to the client, verifying the HMAC on return
**[V]**. Version prefix allows protocol evolution, the generation counter detects stale/replayed
resumes, and the host field lets a future multi-node fleet route correctly. Fail **closed** on
signature mismatch — tmate's pin-match crashes rather than falling through; in Rust that's a
`Result` you must not `unwrap_or_default()`.

**⑤ Design the token alphabet for humans reading it aloud.**
25 chars, look-alike glyphs (`i l o I O 0 1`) removed, rejection sampling to avoid modulo bias **[V]**.
Still ~144.5 bits — dropping seven characters costs under 2 bits and eliminates an entire class of
"is that a lowercase L or a one?" support moments. Free win; implement it on day one, because
changing a token alphabet after URLs are in the wild is painful.

*Bonus, cheap:* export the share URLs as **environment variables** in the session (`tmate_ssh`,
`tmate_ssh_ro`) **[V]**. It turns sharing into something scripts and CI can consume, at near-zero
implementation cost.

---

## 6. What to avoid / what's dated

- **The hosted service is not a reliability model to emulate.** `https://tmate.io/` returned
  **HTTP 503 on three consecutive attempts** at study time **[V]**, so the web viewer, account
  system, and docs were all unavailable. DNS for `ssh.tmate.io` still resolves to four DigitalOcean
  IPs **[V]** (SSH relay likely still up; my TCP banner probe returned nothing, plausibly sandbox
  egress — **[I]**, not confirmed). The lesson for TermX: **the SSH/relay tier must not depend on
  the web tier being healthy.** tmate's own C server already honours this (SSH-only mode works with
  no websocket server), and that separation is why sharing survives the homepage being down.

- **Do not replicate the filesystem-as-database design.** Using symlinks and unix-socket names as
  the authorization record is clever and *very* Unix, but it hard-couples the read-only feature to a
  shared mount, blocks horizontal scaling, and has no Windows equivalent **[V/I]**. Use a real
  in-memory registry.

- **`SYS_ADMIN` for isolation is a heavy, Linux-only bet.** **[V]** TermX on Windows needs a
  different isolation story entirely (separate low-privilege processes / job objects) — plan it
  rather than inheriting the assumption. **[I]**

- **Default-open bearer tokens are a deliberate trade, not an oversight.** Anyone with the URL gets
  in; there is no revocation, no expiry, and no identity **[V]**. Fine for pair-programming, wrong
  for anything auditable. If TermX ever wants named collaborators, build identity in early —
  retrofitting it onto pure bearer tokens is what pushed tmate into needing an entire closed-ish
  master/API-key tier.

- **Beware the "clear your terminal" warning as a security control.** tmate must *tell the user* to
  clear scrollback before sharing read-only **[V]**, because attaching replays existing screen
  content. TermX should decide this deliberately — e.g. start viewers at a clean screen, or make
  scrollback-sharing an explicit opt-in — rather than shipping a warning string.

- **Codebase age and drift.** `tmate-master` last pushed **2023-01-05** **[V]**; the Elixir uses the
  deprecated `use Mix.Config` and `:crypto.hmac/3` (removed in newer OTP) **[V]**, and
  `Logger.warn` is deprecated **[V]**. `tmate-websocket` ships **no README and no license** **[V]**.
  Treat all of it as reference material, not a maintained dependency.

- **The multi-writer reality.** Everyone attached to a read-write session types into the *same*
  pty — tmux gives shared view and shared input, not per-user cursors or CRDT-style merging **[V/I]**.
  That's honest and simple, and TermX should be equally honest about it; if Ibrahim-style
  collaboration ever needs concurrent independent editing, that is a fundamentally different
  product, not a tmate tweak.

---

## 7. Sources

All GitHub sources read at `master` on 2026-08-22 via `raw.githubusercontent.com` / GitHub API.

**Primary — source files read directly:**
- `tmate-io/tmate-ssh-server`: `tmate.h`, `tmate-ssh-server.c`, `tmate-ssh-daemon.c`,
  `tmate-ssh-client-pty.c`, `tmate-auth-keys.c`, `tmate-daemon-decoder.c`, `tmate-websocket.c`,
  `tmate-rand.c`, `README.md`, `COPYING`
- `tmate-io/tmate`: `options-table.c`, `tmate-ssh-client.c`, `README.md`, `COPYING`, `tmate.1`
- `tmate-io/tmate-websocket`: `lib/tmate/session.ex`, `lib/tmate/session_registry.ex`,
  `lib/tmate/ws_api/websocket.ex`, `lib/tmate/daemon_tcp.ex`, `lib/tmate/master_api.ex`,
  `config/config.exs`, `config/prod.exs`
- `tmate-io/tmate-kube`: `prod/session.yaml` (+ tree listing)
- `tmate-io/tmate-master`: repository tree + metadata

**Probes run:**
- `curl https://tmate.io/` ×3 → `503` (2026-08-22)
- `nslookup ssh.tmate.io` → `188.166.207.127`, `206.189.246.93`, `134.209.128.51`, `157.230.72.130`
- GitHub API `/repos/tmate-io/*/license` → `NOASSERTION` (tmate, tmate-ssh-server); no license
  object (tmate-websocket, tmate-master, tmate-kube)

**Note on secondary sources:** tmate.io's own documentation and FAQ pages could not be retrieved
(503). Every claim above is therefore grounded in source code or a live probe rather than vendor
documentation — which is the stronger basis anyway, but it does mean any *stated intent* not visible
in code is absent from this study.
