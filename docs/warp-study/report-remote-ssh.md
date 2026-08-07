# Warp remote/SSH architecture — study report for TermX
### Agent study report (Opus, 2026-08-07) · verbatim archive · source: C:\Dev\warp-study

## Licensing
`Cargo.toml:25-27` — workspace `license = "AGPL-3.0-only"`. Every crate in this study is AGPL (`remote_server`, `warp_server_client`, `warp_server_auth`, `websocket`, `local_control`). Only `warpui` and `warpui_core` are MIT (UI framework, irrelevant here). Shell bootstrap scripts under `app\assets\bundled\bootstrap\` are AGPL. **Concepts only.**

## Headline
**Warp's remote sessions do not survive the local client disconnecting.** No remote PTY, no mosh, no persistent shell; the tmux-based flow was deliberately removed (`app\src\terminal\view\ssh_tmux_deprecation_banner.rs:26`). The protobuf protocol carries no terminal bytes. Warp solves "make plain ssh feel as rich as local," not "keep a session alive on a VPS." The layering is worth stealing; the central choice (terminal = the user's own ssh pty) is exactly what TermX must NOT do.

## 1. What remote_server is, and how it bootstraps
A **sidecar daemon** on the remote host for filesystem/git/indexing/agent services. Not the terminal.

Bootstrap chain:
1. A shell function `ssh` shadows the real binary (`bootstrap\bash_body.sh:1146-1163`); interactive sessions call `warp_ssh_helper`.
2. `warp_ssh_helper` runs real ssh with an owned ControlMaster: `ssh -o ControlMaster=yes -o ControlPath="$SSH_SOCKET_DIR/$WARP_SESSION_ID" -t "$@" "<remote bootstrap>"` — one process is both the interactive session AND the multiplex master. Can also reuse a user's existing master (`ssh -G` + `ssh -O check`).
3. Everything else is a **slave channel through that socket** — never re-authenticates. Slave args centralized (`crates\remote_server\src\ssh.rs:39-51`): `-q -o PasswordAuthentication=no -o ForwardX11=no -o ControlPath=<sock> placeholder@placeholder` (with a live ControlPath, ssh ignores the destination).
4. Platform probe `uname -sm`; preinstall check script piped as `bash -s` emitting key=value; glibc floor / musl/bionic → unsupported; unknown **fails open** (`setup.rs:157-165`).
5. Install: remote `curl|wget` from CDN into `~/.warp/remote-server/`; else client downloads and **scp's over the same ControlPath**.
6. Launch: `ssh <args> "oz remote-server-proxy --identity-key <key>"`, piped stdio, `kill_on_drop(true)`.

**Protocol:** protobuf, `[4-byte LE length][bytes]`, 64 MB cap. Three classes (`remote_server.proto:14-80`):
- `HostScopedRequest` — "may deliver the response on any open connection if the originating connection disconnects."
- `SessionScopedRequest` — must answer on the originating connection (subscription state: OpenBuffer, GetDiffState). Fields 4,7 `reserved` — scars from getting this split wrong.
- `Notification` — fire-and-forget (Abort, Authenticate, BufferEdit, SessionBootstrapped).

Payloads: file ops, versioned buffer sync, git, ripgrep, indexing, repo metadata, skills snapshots, one-shot RunCommand. **No pty, no resize, no scrollback.** Transport abstracted behind `trait RemoteTransport` (SSH / Docker exec / in-process for tests).

## 2. How it "feels local"
Warp **types its ~73 KB shell-integration script into the ssh pty as keystrokes** (`pty_controller.rs:363-458`; rcfile path disabled for remote). Two phases: remote-command string execs a tiny shim (bash `--rcfile <(...)`; zsh temp `ZDOTDIR` with hex-decoded `.zshenv`) setting `TERM_PROGRAM`, `WARP_IS_SSH=1`, `WARP_SESSION_ID`; then the full body typed in. Env forwarded as literal `export` statements (never SendEnv/SetEnv).

Hook wire format is Warp's private OSC/DCS family (9277/9278/9279/9280), not OSC 133; DCS normally, OSC through Windows ConPTY.

| Concern | Runs |
|---|---|
| Prompt marking, exit codes, pwd, git chip, venv | Remote (shell hooks) |
| Escape parsing, grid, blocks, UI | Local |
| Command parsing/highlighting, completion engine | Local (data collection remote; native completions via OSC 9280) |
| Agent file ops, index, buffers | Remote, daemon-only |

Three command executors, in order: daemon (parallel), ControlMaster fallback (one ssh per command; non-parallel due to remote MaxSessions), in-band generators over the live pty. **Graceful degradation tier matters:** daemon uninstallable (old glibc/musl) → "wrapper-only SSH" — blocks/prompt/completions survive; agent file editing hard-errors; `Unsupported` is a distinct state from `Failed` and renders as normal, not an error.

## 3. Session continuity — the negative result
**Dies with the client:** the shell, its process tree, all scrollback. **Survives:** only the daemon, as a warm cache.

`unix\proxy.rs` — "ControlMaster-like pattern (flock + fork + exec) to daemonize":
- Path layout from a non-secret **identity key**; socket/PID dir uses an 8-hex-char hash (sun_path 103-byte budget); data dir uses full percent-encoding (hash collision can't merge two identities' SQLite).
- `flock(LOCK_EX)` on the PID file serializes concurrent starts (two tabs → one daemon). Liveness by `kill(pid, 0)`.
- Spawn `oz remote-server-daemon` with `pre_exec(setsid())` — "the daemon is not in SSH's process group and will not receive that SIGHUP."
- Version-hashed socket/PID names; old daemons never killed — socket unlinked, they die on their own timer.
- Daemon accepts many connections; exits after **10 min with zero connections** (`GRACE_PERIOD`).

**Reconnect is only the daemon channel, never the shell.** `MAX_RECONNECT_ATTEMPTS = 2`, delay 2 s; spawns a fresh proxy through the still-live ControlMaster, replays handshake + SessionBootstrapped. `is_reconnectable()` false on ssh exit 255 (dead master). **Warp's "reconnect" recovers a broken sidecar channel over an intact ssh connection — never a broken ssh connection, never a shell.**

## 4. Auth model
- **The ssh hop is authenticated entirely by OpenSSH** — user's keys/agent/config/ControlMaster; `PasswordAuthentication=no` on slave channels (can't prompt). No custom keys, tokens, or CA. **Copy verbatim.**
- **Cloud token flows downward:** client hands the daemon a copy of its bearer token in `Initialize` so the remote can call Warp's cloud as the user; stored as externally-managed (`is_externally_managed()`), never refreshed by the daemon — client pushes rotations via the `Authenticate` notification. Clean delegate pattern.
- **No token authenticates machine-to-machine.** Identity key is a partition key, not a secret; daemon socket access control is pure filesystem (0700 dir / 0600 socket).

## 5. Multi-device
- **Multiple connections to one daemon** — real, same-machine only; host-scoped requests fail over between connections.
- **Session sharing** — the real multiplayer feature (see collab report); cloud-relayed over `wss://sessions.app.warp.dev`; the wire protocol is a **closed-source private git dep** (`session-sharing-protocol`). A viewing mechanism, not migration.
- **"Handoff" is a false friend** — local-agent→cloud-agent workspace migration, not device handoff.
- **`local_control` / `warpctrl`** — ~90 actions (input.insert, pane.split, tab.create...) behind four layers of local-only (0700 discovery records, peer-UID-checked Unix socket brokering per-action short-lived credentials, loopback HTTP with exact Host match, rejects any request with an Origin header). Unix-only. Precisely the "drive my terminal remotely" API, deliberately unreachable remotely.

## 6. What TermX should take
**Steal (cloud-independent):**
1. **OpenSSH ControlMaster as the transport.** One authenticated master, N free channels, zero credential handling. Windows caveat: Win32-OpenSSH has no ControlMaster — TermX needs its own multiplexer or N connections.
2. **Ownership tagging** — `ControlPath::{WarpManaged, UserOwned, None}`; `ssh -O exit` only against WarpManaged. Type makes killing the user's master unrepresentable.
3. **flock + PID-liveness + setsid() daemon singleton** (~60 lines) — the closest thing in the repo to "survives the client leaving."
4. **Dumb per-connection proxy + long-lived daemon** — reconnect = new proxy, not rebuilt state. Two documented details: manual stdout write→flush loop (LineWriter strands binary bytes after last \n); `shutdown(Both)` each direction or teardown hangs the ControlMaster.
5. **Host-scoped vs session-scoped request split** — any-connection failover vs connection affinity. Directly applicable to TermX multi-client.
6. **Version-hashed socket names + never kill the old daemon** — safe autoupdate.
7. **Identity partitioning with two encodings** — hash for socket paths, full percent-encoding for data dirs.
8. **Preinstall gate that fails open with a named degraded tier.**
9. **Token push-down with client-driven rotation** if TermX's VPS agent ever calls an API as the user.

**Ignore:** CDN install, Firebase/device-flow, GraphQL/SSE surface, cloud-relayed sharing, handoff-to-cloud, telemetry.

**The gap TermX fills itself:** the persistent remote PTY. Warp's daemon holds indexes, never a terminal. TermX's agent must own the PTY — daemon-child shell, scrollback ring, attach/detach with a **resume cursor** (a subscription, not a stream). Session-scoped-state-that-outlives-connections is a category Warp's protocol deliberately does not have; prior art is tmux/abduco/dtach. Bonus: with a daemon-owned remote PTY, shell-integration injection happens at spawn time on the remote side — no typed-bootstrap contortions.
