# Zellij — session sharing study for TermX

**Product:** Zellij (`github.com/zellij-org/zellij`) — Rust terminal workspace / multiplexer.
**Studied at:** workspace version `0.46.0` (main branch, shallow clone taken 2026-08-22), CHANGELOG top release `0.45.0` (2026-08-20).
**Study method:** shallow clone of the repo + read of the actual Rust source, cross-checked against zellij.dev docs/blog. Every claim below is tagged **[VERIFIED-SOURCE]** (read in the cloned tree), **[VERIFIED-DOCS]** (official docs/blog), or **[INFERRED]**.

Local clone used for this study (scratch, disposable):
`C:\Users\mjfos\AppData\Local\Temp\claude\C--Dev\7e673402-8c77-471b-bbda-fa825fd7a42e\scratchpad\zellij`

---

## 1. License verdict

**[VERIFIED-SOURCE]** `LICENSE.md` at repo root:

```
MIT License
Copyright (c) 2020 Zellij contributors
```

Single MIT license, no dual-licensing, no CLA-gated contrib restriction affecting downstream use, no GPL crates vendored into the paths of interest (the web-server path pulls `axum`, `axum-server`, `rustls`, `tokio`, `rusqlite`, `sha2`, `uuid`, `prost` — all permissive).

**Verdict: TermX MAY BORROW CODE.** Copy-adapt is legally fine with attribution (retain the MIT notice for any file/substantial block carried over). Practically:

- **Worth literally borrowing:** `zellij-utils/src/web_authentication_tokens.rs` (SQLite token store: hashing, auth-token vs session-token split, expiry, cascade revoke) — it is ~390 lines, self-contained, and does exactly what TermX needs. Also `zellij-client/src/web_client/authentication.rs` (78 lines, the axum auth middleware + cookie-clearing-on-invalid pattern).
- **Worth borrowing as reference implementation:** `zellij-server/src/os_input_output_windows.rs` — native ConPTY (`CreatePseudoConsole`/`ResizePseudoConsole`/`ClosePseudoConsole` via `windows-sys`) with **IOCP-async output through a `tokio::net::windows::named_pipe::NamedPipeServer`**. TermX currently uses `portable-pty 0.9`; if TermX ever needs true async ConPTY reads without a blocking reader thread, this file is a working MIT-licensed blueprint.
- **Learn-only (too entangled to lift):** `screen.rs` (12k+ lines), `route.rs`, the tab/pane engine.

---

## 2. Architecture

### 2.1 Crate layout **[VERIFIED-SOURCE]**

```
zellij-utils/    shared types: ipc.rs, client_server_contract/ (protobuf), data.rs,
                 web_authentication_tokens.rs, remote_session_tokens.rs, web_server_contract/
zellij-server/   the session-owning daemon: lib.rs (SessionState), route.rs (per-client
                 message router), screen.rs (layout/render), pty.rs,
                 os_input_output_unix.rs / os_input_output_windows.rs
zellij-client/   the attaching client — AND, surprisingly, the web server:
                 web_client/ (axum HTTP+WS server), remote_attach/ (terminal client
                 that speaks the web protocol)
default-plugins/ share/ (the token+sharing UI plugin), session-manager, status-bar, ...
```

The web server living inside `zellij-client` is not an accident: **the web server *is* a Zellij client**, one per browser connection. Blog confirms: *"Reusing the Zellij client code per connection, serving as a translation layer between the browser's websockets and the Zellij server's IPC channels."* **[VERIFIED-DOCS]**

### 2.2 Where sessions live **[VERIFIED-SOURCE]**

Sessions live in a **detached per-session server process**, one process per session, addressed by a local IPC socket named after the session:

```rust
// zellij-client/src/web_client/session_management.rs
let mut sock_dir = zellij_utils::consts::ZELLIJ_SOCK_DIR.clone();
fs::create_dir_all(&sock_dir).unwrap();
zellij_utils::shared::set_permissions(&sock_dir, 0o700).unwrap();
sock_dir.push(session_name);
```

Transport for that socket is `interprocess::local_socket::Stream` — Unix domain socket on Unix, **named pipe on Windows** **[VERIFIED-SOURCE]** (`zellij-utils/src/ipc.rs` implements `IpcStream` over `LocalSocketStream`). Directory mode `0o700` is the only access control on the IPC layer: *any process running as the owning user can attach.* **[VERIFIED-SOURCE]**

Session survival on detach is a direct consequence: the server process is independent of any client, and clients come and go over the socket. **[VERIFIED-DOCS]** *"When the client detaches from the server, the server remains alive until the client connects again."*

### 2.3 Client↔server wire contract **[VERIFIED-SOURCE]**

`zellij-utils/src/ipc.rs` defines two Rust enums, `ClientToServerMsg` and `ServerToClientMsg`, which are **serialized as protobuf** (`prost`) via a `.proto` contract checked into `zellij-utils/src/client_server_contract/`:

```
client_server_contract/
  client_to_server.proto
  server_to_client.proto
  common_types.proto
```

`ipc.rs` imports `ClientToServerMsg as ProtoClientToServerMsg` and converts through `ipc/protobuf_conversion.rs` + `ipc/enum_conversions.rs`. **[INFERRED, strongly]** the move to protobuf (from the older bincode framing) exists to make client/server version skew survivable — you can attach a slightly different client build to a running server without the deserializer exploding. There is a separate `web_server_contract/web_server_commands.proto` for daemon↔web-server control.

Message shapes that matter for TermX:

```rust
pub enum ClientToServerMsg {
    FirstClientConnected { cli_assets: CliAssets, is_web_client: bool },
    AttachClient { cli_assets, tab_position_to_focus, pane_to_focus, is_web_client: bool },
    AttachWatcherClient { terminal_size: Size, is_web_client: bool },   // <-- read-only attach
    TerminalResize { new_size: Size },
    Key { key, raw_bytes, is_kitty_keyboard_protocol },
    Action { action, terminal_id, client_id, is_cli_client },
    SubscribeToPaneRenders { pane_ids, scrollback, ansi },
    DetachSession { client_ids: Vec<ClientId> }, ClientExited, KillSession, ...
}
pub enum ServerToClientMsg {
    Render { content: String },       // pre-rendered ANSI, per client
    Connected, Exit { exit_reason }, SwitchSession { .. },
    PaneRenderUpdate { pane_id, viewport, scrollback, is_initial }, ...
}
```

Note `ServerToClientMsg::Render { content: String }`: the daemon does **not** ship raw PTY bytes to clients. It runs the terminal emulator and layout engine server-side and ships a **per-client rendered frame**. That is the structural reason Zellij can give two clients different tabs, different sizes, different focus. **[VERIFIED-SOURCE]**

### 2.4 The web server (`zellij web`) **[VERIFIED-SOURCE]**

One web server per machine, serving all sessions. Started by `zellij web` (daemonizes on Unix via `daemonize`/`daemonix`) or from inside a session by the `share` plugin. axum + tokio, TLS via `axum_server::tls_rustls::RustlsConfig` (rustls, not OpenSSL). Front-end assets are compiled into the binary with `include_dir!("$CARGO_MANIFEST_DIR/assets")`.

Router (`zellij-client/src/web_client/mod.rs`):

```rust
let app = Router::new()
    .route("/ws/control",            any(ws_handler_control))
    .route("/ws/terminal",           any(ws_handler_terminal))
    .route("/ws/terminal/{session}", any(ws_handler_terminal))
    .route("/session",               post(create_new_client))
    .route("/session-list",          get(list_sessions_handler))
    .route_layer(middleware::from_fn(auth_middleware))   // ^ everything above is authed
    .route("/",                get(serve_html))          // v everything below is public
    .route("/{session}",       get(serve_html))
    .route("/assets/{*path}",  get(get_static_asset))
    .route("/command/login",   post(login_handler))
    .route("/info/version",    get(version_handler))
```

`route_layer` applies only to routes registered *before* it — so the shell HTML, static assets, login and version endpoints are unauthenticated, and every route that touches a session is behind the cookie gate. Clean and worth copying verbatim as a pattern.

**Two WebSockets per browser client**, deliberately split **[VERIFIED-SOURCE + VERIFIED-DOCS]**:

| socket | payload | direction |
|---|---|---|
| `/ws/terminal` | raw ANSI stdout down, keystrokes/mouse up | hot path, strings, no serde |
| `/ws/control` | JSON `WebClientToWebServerControlMessage` / `WebServerToWebClientControlMessage` — resize, config, session switch | cold path |

Blog rationale: *"first so that they don't end up blocking each other and second as a performance consideration to allow the potentially-heavy-throughput STDOUT not to be serialized/deserialized."* **[VERIFIED-DOCS]** In code, `/ws/terminal` carries `UnboundedSender<String>` and `/ws/control` carries `UnboundedSender<Message>` with `serde_json` on it. **[VERIFIED-SOURCE]**

Browser rendering is **xterm.js**, plain JS (no TypeScript, deliberate). Custom work: AnyEvent mouse tracking hand-rolled from `mousemove` because xterm.js lacks it; OSC 0 intercepted by regex to set `document.title`. **[VERIFIED-DOCS]**

### 2.5 The relay path, end to end **[VERIFIED-SOURCE]**

```
browser (xterm.js)
   │  WSS /ws/terminal  (ANSI down, keys up)
   │  WSS /ws/control   (JSON: resize, config, switch-session)
   ▼
zellij web  (axum, one machine-wide process)
   ├─ ConnectionTable: web_client_id -> { os_api, terminal_tx, control_tx,
   │                                      is_read_only, session_token_hash }
   └─ per connection: a real Zellij client (server_listener thread)
          │  protobuf over local socket / named pipe  (ZELLIJ_SOCK_DIR/<session>, 0700)
          ▼
     zellij-server for session "<name>"  (owns PTYs, terminal emulation, layout)
          └─ per-client: active tab, active pane, size, Render frames
```

`zellij attach https://host:8082/my-session --token <t>` from a terminal uses **the exact same HTTP+WS protocol as the browser** — `zellij-client/src/remote_attach/{auth.rs,http_client.rs,websockets.rs}` does POST `/command/login` → POST `/session` → open both WebSockets. **[VERIFIED-SOURCE]** One wire protocol, two front-ends. This is the single most valuable structural idea in the whole product.

---

## 3. Join / share flow

### 3.1 Owner side **[VERIFIED-DOCS + VERIFIED-SOURCE]**

1. Turn the web server on: `zellij web`, or config `web_server true`, or the `share` plugin (default keybind `Ctrl o` then `s`).
2. Mint a login token: `zellij web --create-token [--token-name X]`, or `--create-read-only-token`, or from the `share` plugin UI (`default-plugins/share/src/token_management_screen.rs` — new token, new **read-only** token, rename, revoke one, revoke all).
3. Mark the session shareable. Sessions are **not** web-reachable by default; see `WebSharing` below.
4. Hand the peer a URL + token. URL is `https://host:8082/<session-name>` — session name *is* the path.

### 3.2 Guest side **[VERIFIED-SOURCE]**

```
GET  /<session>            -> unauthenticated shell HTML + xterm.js bundle
POST /command/login        -> { auth_token, remember_me }
                              creates a *session token*, returns Set-Cookie:
                              session_token=<uuid>; HttpOnly; SameSite=Strict;
                              Secure=<is_https>; [Max-Age=4 weeks if remember_me]
POST /session?session=<n>  -> (authed) mints web_client_id (uuid), binds it to
                              sha256(session_token), returns { web_client_id,
                              is_read_only, session_name, config }
WS   /ws/terminal?web_client_id=..&rows=..&cols=..
WS   /ws/control?web_client_id=..
```

**Two-tier token model** — the important bit. **[VERIFIED-SOURCE]** `zellij-utils/src/web_authentication_tokens.rs`:

```sql
CREATE TABLE tokens (            -- long-lived login tokens
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT UNIQUE NOT NULL,        -- sha256 hex, plaintext never stored
  name TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  read_only BOOLEAN NOT NULL DEFAULT 0    -- added by in-place migration
);
CREATE TABLE session_tokens (    -- short-lived browser-session tokens
  session_token_hash TEXT UNIQUE NOT NULL,
  auth_token_hash TEXT NOT NULL,
  remember_me BOOLEAN NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  FOREIGN KEY (auth_token_hash) REFERENCES tokens(token_hash)
);
```

- Login token = `Uuid::new_v4()`, stored only as `sha256` hex. *"Tokens are hashed in a local database and so will only be displayed once. They cannot be retrieved, only revoked."* **[VERIFIED-DOCS, VERIFIED-SOURCE]**
- Session token = second uuid, also stored hashed, with `expires_at`. **Expiry: 4 weeks with `remember_me`, 5 minutes without** (the 5-minute floor is deliberate; the browser's session cookie, which has no `Max-Age`, is the real lifetime bound). **[VERIFIED-SOURCE]**
- `revoke_token(name)` cascades: revoking a login token deletes every `session_token` derived from it. **[VERIFIED-SOURCE]** `cleanup_expired_sessions()` is called on every `create_session_token`.
- DB file is chmod `0o600` on Unix; **no equivalent ACL is applied on Windows** — a gap TermX should not copy. **[VERIFIED-SOURCE]**

**Client-ownership binding.** `web_client_id` alone is not a capability: the WS upgrade re-checks that the cookie's `sha256(session_token)` matches the hash recorded when the id was minted. **[VERIFIED-SOURCE]**

```rust
// websocket_handlers.rs, both /ws/control and /ws/terminal
if !state.connection_table.lock().unwrap()
        .verify_client_ownership(&params.web_client_id, &session_token_hash.0) {
    return StatusCode::FORBIDDEN.into_response();
}
```

Plus, inside the control socket loop, every inbound JSON message's embedded `web_client_id` is compared against the connection's own and the connection is dropped on mismatch. Defence in depth against id-guessing / cross-client injection.

**Auth failure is self-healing.** `auth_middleware` on an invalid/expired cookie returns 401 *and* emits two `Set-Cookie` clears (one `Secure`, one not) so a stale cookie from an http↔https switch cannot wedge the client. **[VERIFIED-SOURCE]** Small, cheap, worth stealing.

### 3.3 Read-only enforcement — the exact enforcement point **[VERIFIED-SOURCE]**

This is enforced in **three** places, and the authoritative one is inside the daemon, not the web tier.

**(a) Web tier decides the class.** `auth_middleware` looks up `is_session_token_read_only(session_token)` (SQL join `session_tokens → tokens.read_only`) and injects `IsReadOnly(bool)` into request extensions. Note the fail-closed default: `.unwrap_or(true)`. `create_new_client` records it in `ConnectionTable.client_read_only_status`, defaulting to `IsReadOnly(true)` if the extension is somehow absent.

**(b) The class picks a different attach message.** `session_management::create_first_message`:

```rust
let is_web_client = true;
if is_read_only {
    // read only clients attach as watchers
    ClientToServerMsg::AttachWatcherClient { terminal_size: client_attributes.size, is_web_client }
} else if should_create_session {
    ClientToServerMsg::FirstClientConnected { cli_assets, is_web_client }
} else {
    ClientToServerMsg::AttachClient { cli_assets, tab_position_to_focus: None, pane_to_focus: None, is_web_client }
}
```

Also: `if is_read_only && !session_exists { log::error!("Read only tokens cannot create new sessions."); close }` (`server_listener.rs`). A viewer can never conjure a session.

**(c) The daemon gates every subsequent message, deny-by-default.** `zellij-server/src/route.rs`, at the *top* of the per-client instruction handler, before the main `match`:

```rust
let is_watcher = session_state.read().unwrap().is_watcher(&client_id);
if is_watcher {
    match &instruction {
        ClientToServerMsg::Key { key, .. } => {
            if (Ctrl-q) || Esc || (Ctrl-c) {
                send Exit{Normal}; ScreenInstruction::RemoveWatcherClient(client_id);
                should_break = true;
            }
        },
        ClientToServerMsg::TerminalResize { new_size } => {
            // watcher size is tracked for rendering, does NOT affect session size
            ScreenInstruction::WatcherTerminalResize(client_id, *new_size)
        },
        _ => {
            // Ignore all input from watcher clients
        },
    }
    return Ok(should_break);   // don't do anything else for watchers
}
```

Two properties worth naming explicitly, because they are what makes this trustworthy:

1. **The allowlist is the wildcard's complement.** New `ClientToServerMsg` variants added later are automatically denied to watchers. A blocklist would silently leak every new feature.
2. **The gate is in the daemon that owns the PTY**, not in the HTTP tier. A compromised or bypassed web server cannot upgrade a watcher to a writer, because the watcher/writer distinction is `SessionState.watchers: HashMap<ClientId, bool>` inside the session process. `convert_client_to_watcher()` moves a client from `clients` to `watchers`; `is_watcher()` reads it.

Terminal-side equivalent: `zellij watch` / `zellij attach --watch` sends the same `AttachWatcherClient`. Same enforcement, no web involved. **[VERIFIED-SOURCE + VERIFIED-DOCS]**

### 3.4 Per-session sharing opt-in: the three-state switch **[VERIFIED-SOURCE]**

`zellij-utils/src/data.rs`:

```rust
pub enum WebSharing { On, Off, Disabled }
impl WebSharing {
    pub fn web_clients_allowed(&self) -> bool { matches!(self, WebSharing::On) }
    pub fn set_sharing(&mut self) -> bool {        // returns false if it refused
        match self { On => true, Off => { *self = On; true }, Disabled => false }
    }
    pub fn set_not_sharing(&mut self) -> bool {
        match self { On => { *self = Off; true }, Off => true, Disabled => false }
    }
}
```

`Disabled` is a **latch**: a session started with `web_sharing Disabled` can never be flipped on at runtime, not by a plugin, not by the CLI, not by a compromised web server. `Off` is the reversible default (`Default::default() == Off`). Checked in `route.rs` on **both** `AttachClient` and `AttachWatcherClient`:

```rust
let allow_web_connections = session_data.read().ok()
    .and_then(|s| s.as_ref().map(|s| s.web_sharing.web_clients_allowed()))
    .unwrap_or(false);                                    // fail closed
let should_allow_connection = !is_web_client || allow_web_connections;
if !should_allow_connection {
    send LogError("This session does not allow web connections.");
    send ServerInstruction::SendWebClientsForbidden(client_id);
}
```

Also compile/config-level: there is a `zellij-no-web` release build with the web client and its dependencies excluded entirely, and a `web_server_capability: Option<bool>` reported in `ModeInfo`. **[VERIFIED-DOCS + VERIFIED-SOURCE]**

### 3.5 Known scoping limitation **[VERIFIED-SOURCE]**

**A token is not scoped to a session.** `auth_middleware` validates the token; `create_new_client` takes the session name from a query parameter; nothing cross-checks the two. Any valid token can reach **any** session on that machine whose `web_sharing` is `On`. The docs say this out loud: *"authenticated users are trusted, because the server serves terminal sessions for a single user on a single machine."* **[VERIFIED-DOCS]**

For TermX's stated goal (share *one* session with Ibrahim, not the whole box) this is the single thing **not** to copy. TermX needs a `(token → session_id)` binding, or a per-session share-code, checked at attach time.

---

## 4. Multi-writer / presence semantics

### 4.1 Per-client state in the daemon **[VERIFIED-SOURCE]**

`zellij-server/src/lib.rs` `SessionState`:

```rust
clients:  HashMap<ClientId, Option<(Size, bool /* is_web_client */)>>,
watchers: HashMap<ClientId, bool /* is_web_client */>,
last_active_client: Option<ClientId>,
// helpers: client_ids(), watcher_client_ids(), web_client_ids(),
//          web_watcher_client_ids(), convert_client_to_watcher(), is_watcher()
```

`zellij-server/src/screen.rs`:

```rust
active_tab_ids:   HashMap<ClientId, usize>,       // each client has its own tab
client_sizes:     HashMap<ClientId, Size>,        // each client has its own size
watcher_clients:  HashMap<ClientId, WatcherState>,// { size, should_force_render }
followed_client_id: Option<ClientId>,             // which writer the watchers see
mobile_web_prefs: HashMap<ClientId, MobileRenderPrefs>,
```

and per-tab, `zellij-server/src/tab/mod.rs`:

```rust
let active_panes: HashMap<ClientId, PaneId> = connected_clients...
```

So: **each client independently has its own focused tab, its own focused pane, its own viewport size, and its own cursor.** There is no "one active pane" for the session. The daemon renders a distinct `ServerToClientMsg::Render` frame per client.

**[VERIFIED-DOCS]** presentation layer: *"Each have their own cursor. The cursors appear in different colors, giving a Google-docs like experience in the terminal"*, plus a tab-strip indication of which tabs other clients are focused on.

### 4.2 Multi-writer conflict policy **[VERIFIED-SOURCE + INFERRED]**

There is **no locking, no turn-taking, no ownership**. Two writers focused on the same pane both write to that PTY; the bytes interleave at the PTY. Zellij's answer to write conflicts is *avoidance by divergence*: because focus is per-client, two writers naturally work in different panes/tabs and only collide if they deliberately focus the same pane. **[INFERRED from the absence of any arbitration code in `route.rs`'s `Key`/`Action` paths, which route straight through to the focused pane's PTY writer.]**

The read-only watcher is the only "role", and it is binary.

### 4.3 Size negotiation — genuinely clever, and new **[VERIFIED-SOURCE]**

The classic multiplexer problem: two attached terminals of different sizes, so the session shrinks to the smallest. Zellij `0.45.0` changed this — CHANGELOG: *"feat: allow tabs to have different sizes if clients aren't focused on the same one (PR #5133)"*.

`screen.rs::recompute_tab_size(tab_id)` collects sizes **only from clients whose `active_tab_ids[client] == tab_id`**, sorts, and takes the minimum:

```rust
rows.sort_unstable(); cols.sort_unstable();
let new_size = Size { rows: rows[0], cols: cols[0] };
if tab.size != new_size { tab.resize_whole_tab(new_size)?; tab.set_force_render(); }
```

with the explicit comment on the helper:

```rust
// Only clients viewing the same tab are relevant: fullscreen and tab sizing are
// per-tab, so a client on another tab is neither disturbed by nor a useful size
// reference for this one.
fn shares_tab_with(&self, client_id: ClientId, other_id: ClientId) -> bool { ... }
```

Consequences: a phone attached to tab 2 no longer squeezes the desktop on tab 1. Only co-focused clients negotiate, and then to the min. A `fit: false` mobile client is excluded from the min and instead adopts the **largest** co-focused client's size as a reference (`reference_size_for_client` uses `.max_by_key(|s| s.rows * s.cols)`) and scrolls/pans instead.

And watchers are excluded from sizing entirely: `WatcherTerminalResize` only sets `WatcherState.size` and forces a re-render. **A viewer can never resize the host's panes.** That is a real and non-obvious attack/annoyance surface closed.

### 4.4 Watcher rendering **[VERIFIED-SOURCE]**

`add_watcher_client` seeds `WatcherState::new(Size { rows: 24, cols: 80 })` with `should_force_render: true` — a joining watcher gets a **full** repaint, not a delta, so it never inherits a torn screen. `set_followed_client(client_id)` selects which writer's viewport the watchers mirror. **[INFERRED]** watchers therefore see a "follow the driver" view rather than an independent one, which is the right default for demos/teaching.

---

## 5. Self-hosting on the owner's VPS

**Assessment: fully self-hostable, and this is the intended deployment.** There is no vendor relay, no signalling service, no account system, no phone-home anywhere in the web path. **[VERIFIED-SOURCE]**

What running it on a VPS looks like:

| concern | mechanism | verdict |
|---|---|---|
| bind address | `web_server_ip` (default `127.0.0.1`), `--ip` | fine |
| port | `web_server_port` (default `8082`), `--port` | fine |
| TLS | `web_server_cert` + `web_server_key`, rustls. `should_use_https()` **hard-refuses** non-localhost without a cert and `std::process::exit(2)` | good — cannot be footgunned off |
| localhost TLS | `enforce_https_for_localhost` (default false) | fine |
| reverse proxy | `base_url "/zellij"` for subpath serving; docs recommend nginx in front for untrusted networks | fine |
| daemonizing | `zellij web` daemonizes on Unix (parent/child handshake over an unnamed pipe for startup errors); `--status [--timeout N]` health check | fine |
| state | two SQLite files under `ZELLIJ_PROJ_DIR.data_dir()`: `tokens.db`, `remote_sessions.db` | fine, no external DB |
| multi-tenancy | **none.** One OS user, all their sessions, one token namespace | **the limitation** |

The multi-tenancy gap is the thing to plan around. A VPS-resident TermX daemon shared with Ibrahim is exactly the case Zellij's model does not cover: a Zellij token is a key to the whole user account's terminal.

---

## 6. What TermX should steal, and how it maps

TermX today (**[VERIFIED-SOURCE]**, `C:\Dev\TermX\host\src\`): `server.rs` is a `tokio-tungstenite` WebSocket server; `protocol.rs` defines `ClientMsg`/`HostMsg` as serde-tagged JSON with binary frames for PTY bytes; auth is a **single shared token compared by equality** (`server.rs`: `Some(Ok(ClientMsg::Auth { token: ref t })) if *t == token`); `session.rs` fans output out via a `tokio::sync::broadcast` + a ring buffer with absolute stream offsets and `since_offset` resume; `Resize { session_id, cols, rows }` is unqualified by client. So TermX already has: persistent daemon, WS transport, attach/detach, replay-on-reconnect. It lacks: client identity, roles, per-client size, and a real token store.

### Adoptable 1 — Add a `ClientId` to the daemon and make attach state per-client

**Zellij:** `SessionState { clients: HashMap<ClientId, ...>, watchers: HashMap<ClientId, bool> }`, `Screen { active_tab_ids, client_sizes, watcher_clients }`, per-tab `active_panes: HashMap<ClientId, PaneId>`.

**TermX map:** the host currently tracks a WS connection but not a first-class client. Introduce `ClientId` at the `server.rs` connection-accept point, carry it into `session.rs`, and turn the single `(cols, rows)` per session into `HashMap<ClientId, Size>`. This is the prerequisite for *every* other item on this list — do it first, and do it before the SSH/collab work lands, because retrofitting client identity through a broadcast fan-out later is painful. **Effort: medium. Blast radius: `protocol.rs` (`Attach` gains no field; `Resize` becomes per-client implicitly), `server.rs`, `session.rs`.**

### Adoptable 2 — Read-only is a **different attach message**, gated deny-by-default in the daemon

**Zellij:** `ClientToServerMsg::AttachWatcherClient` vs `AttachClient`; `route.rs` gates at the top of the router with `_ => { /* Ignore all input from watcher clients */ }`; `SessionState::is_watcher()` is the authority; the web tier only *chooses*, it does not *enforce*.

**TermX map:** add `ClientMsg::AttachWatcher { session_id, replay, since_offset }` alongside `Attach`. In `server.rs`'s message loop, hoist a watcher check **above** the main `match` on `ClientMsg` and make the fallthrough arm ignore, allowing only `Detach` and a size-tracking resize. Do **not** implement this by filtering in the UI or by refusing `Input` frames at one site — the wildcard-deny is the whole point, so new `ClientMsg` variants are safe by construction.

Concrete rule for TermX: a watcher may send `Detach`, `Resize` (tracked, never applied to the PTY), and nothing else. It may not `CreateSession`, `CloseSession`, `SetLayout`, `Shutdown`, `ReadHistory`, or write input.

Also copy the fail-closed defaults: `is_session_token_read_only(...).unwrap_or(true)` and `IsReadOnly(true)` as the missing-extension fallback. Unknown role ⇒ viewer.

### Adoptable 3 — Two-tier token store: hashed login tokens → expiring session tokens, cascade revoke

**Zellij:** `zellij-utils/src/web_authentication_tokens.rs` (MIT, ~390 lines, borrowable near-verbatim). `tokens` (sha256 hex, unique name, `read_only` flag) → `session_tokens` (FK to auth token, `expires_at`, `remember_me`). `revoke_token(name)` cascades. HttpOnly + SameSite=Strict + Secure cookie. Invalid cookie ⇒ 401 **plus** clear both Secure and non-Secure variants.

**TermX map:** replace the single equality-compared token with a `rusqlite` store under TermX's app-data dir (resolved at runtime — no hardcoded paths). Named tokens mean you can hand Ibrahim `ibrahim-laptop` and revoke exactly that. `read_only` becomes a column, which is what feeds Adoptable 2. The 4-weeks-vs-5-minutes expiry split is a good default to copy directly.

Two deltas to make while borrowing:
- Zellij sets `0o600` on the DB **only under `#[cfg(unix)]`**. TermX is Windows-first — set a restrictive DACL (or at minimum place the DB under `%LOCALAPPDATA%` with inherited user-only ACL) or the whole hashing exercise is undone by a world-readable file.
- Zellij's `token_hash` is bare `sha256(uuid)` with no salt/KDF. That is defensible for a 122-bit-random uuid but not if TermX ever allows a human-chosen share code. If TermX wants short human-typeable codes, use argon2/bcrypt, not sha256.

### Adoptable 4 — Scope the token to the session (fix Zellij's known gap)

**Zellij:** does **not** do this. A valid token reaches every session with `web_sharing On`. Documented and accepted because it is single-user/single-machine.

**TermX map:** TermX's whole collab premise is "share *this* session with Ibrahim." So add what Zellij lacks: a `session_grants(token_hash, session_id, role)` table, checked in the `Attach` handler, not just at `Auth`. Keep Zellij's `verify_client_ownership` idea too — bind the connection's client id to `sha256(session_token)` so a leaked client id is not itself a capability.

Pair it with Zellij's **three-state `WebSharing { On, Off, Disabled }`** on the session record. The `Disabled` latch — settable at creation, never flippable at runtime — is the piece worth copying most literally: it gives "this session is never shareable, full stop" a representation that no runtime code path can undo. TermX sessions running client-sensitive work should be creatable as `Disabled`.

### Adoptable 5 — Split the transport: hot output channel vs cold control channel; and one protocol, two front-ends

**Zellij:** `/ws/terminal` (raw ANSI strings, no serde) and `/ws/control` (JSON) as separate WebSockets, so a 200MB `cat` cannot delay a resize or a config push. And `zellij attach https://...` reuses the browser's exact HTTP+WS protocol, so remote-terminal-attach cost roughly nothing to add.

**TermX map:** TermX already multiplexes both on one WS with JSON text frames for control and binary frames for PTY bytes — better than nothing, but a single `tungstenite` sink still serializes them behind one socket's write queue and one backpressure budget. When TermX adds the VPS/SSH-resident mode, split into two sockets before the traffic gets heavy; retrofitting a split after clients depend on frame ordering across the two kinds is much worse.

The second half matters more strategically: **make TermX's Tauri UI and any future remote/CLI attacher speak the same wire protocol over the same endpoint.** TermX's `ClientMsg`/`HostMsg` are already transport-agnostic JSON, so a `termx attach wss://vps:PORT/<session> --token ...` CLI is nearly free — provided the auth handshake is HTTP-first (POST login → cookie/bearer → WS upgrade) rather than the current in-band `ClientMsg::Auth` first-frame. Moving auth to an HTTP pre-flight also lets a reverse proxy and a browser client work without special-casing.

### Bonus (not in the top 5, but noted) — protobuf/versioned contract

Zellij moved `ClientToServerMsg`/`ServerToClientMsg` to a checked-in `.proto` contract. TermX's serde-tagged JSON with `#[serde(default)]` on new fields (already used for `shell_integration` and `since_offset`) is achieving the same forward-compat goal more cheaply and is fine at TermX's scale. Keep the discipline — every new field `#[serde(default)]`, every new variant additive — and don't take on prost unless a non-JS client appears.

### Bonus — Windows ConPTY reference

`zellij-server/src/os_input_output_windows.rs` is a working native ConPTY implementation with IOCP-async output via `tokio::net::windows::named_pipe::NamedPipeServer`, MIT-licensed. If TermX ever outgrows `portable-pty 0.9` (blocking reader thread per session), this is the blueprint to lift. Related fixes in their CHANGELOG worth pre-empting in TermX: PATHEXT resolution when launching bare command names, backslashes dropped when quoting spawned-process args, and not reusing terminal pane ids across respawns.

---

## 7. Verified-vs-inferred ledger

| claim | status |
|---|---|
| MIT, single license, borrowable | VERIFIED-SOURCE (`LICENSE.md`) |
| One server process per session, socket under `ZELLIJ_SOCK_DIR`, dir mode 0700 | VERIFIED-SOURCE |
| Protobuf client/server contract | VERIFIED-SOURCE (`client_server_contract/*.proto`, `prost`) |
| Reason for protobuf = version skew tolerance | INFERRED |
| Web server is an axum process embedding N Zellij clients | VERIFIED-SOURCE + VERIFIED-DOCS |
| Two WebSockets (terminal/control) and the stated reason | VERIFIED-SOURCE + VERIFIED-DOCS |
| Token tables, sha256, 4wk/5min expiry, cascade revoke | VERIFIED-SOURCE |
| Read-only = `AttachWatcherClient` + deny-by-default gate in `route.rs` | VERIFIED-SOURCE |
| `WebSharing::Disabled` is an unflippable latch | VERIFIED-SOURCE |
| Per-client tab/pane/size; per-tab min-size negotiation | VERIFIED-SOURCE |
| Watchers excluded from size negotiation | VERIFIED-SOURCE |
| Coloured per-client cursors, tab focus indication | VERIFIED-DOCS |
| No multi-writer arbitration exists | INFERRED (absence of any such code in the `Key`/`Action` route) |
| Watchers mirror `followed_client_id` | VERIFIED-SOURCE (field + setter) / INFERRED (UX intent) |
| Token is not session-scoped | VERIFIED-SOURCE + VERIFIED-DOCS |
| Native Windows ConPTY + IOCP named pipes | VERIFIED-SOURCE |
| TermX's current single-token equality auth, single per-session size | VERIFIED-SOURCE (`C:\Dev\TermX\host\src\server.rs`, `protocol.rs`, `session.rs`) |

---

## 8. Sources

Source tree (authoritative for everything tagged VERIFIED-SOURCE), Zellij `0.46.0` main:

- `LICENSE.md`
- `zellij-utils/src/ipc.rs`, `zellij-utils/src/client_server_contract/*.proto`
- `zellij-utils/src/web_authentication_tokens.rs`, `zellij-utils/src/remote_session_tokens.rs`
- `zellij-utils/src/data.rs` (`WebSharing`)
- `zellij-server/src/lib.rs` (`SessionState`), `zellij-server/src/route.rs` (watcher gate, web-sharing gate), `zellij-server/src/screen.rs` (`recompute_tab_size`, `WatcherState`, per-client maps), `zellij-server/src/tab/mod.rs` (`active_panes`), `zellij-server/src/os_input_output_windows.rs`
- `zellij-client/src/web_client/{mod,authentication,http_handlers,websocket_handlers,connection_manager,session_management,server_listener,types}.rs`
- `zellij-client/src/remote_attach/{auth,http_client,websockets}.rs`
- `default-plugins/share/src/*`
- `CHANGELOG.md`

Web:

- Zellij Web Client tutorial — https://zellij.dev/tutorials/web-client/
- Web Client user guide — https://zellij.dev/documentation/web-client.html
- 0.43.0 release (web client) — https://zellij.dev/news/web-client-multiple-pane-actions/
- 0.44.0 release (remote sessions, Windows, CLI automation) — https://zellij.dev/news/remote-sessions-windows-cli/
- Multiplayer sessions — https://zellij.dev/news/multiplayer-sessions/
- "Terminal sessions you can bookmark: Building Zellij's web client", Aram Drevekenin — https://poor.dev/blog/building-zellij-web-terminal/
- Repo — https://github.com/zellij-org/zellij
