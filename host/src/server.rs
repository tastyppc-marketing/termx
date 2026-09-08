//! WS server: auth gate, control dispatch, binary I/O pump, attach/replay.
//!
//! Every attached client gets a forwarder task per session that relays live
//! output and terminates with a SessionExited message when the session ends —
//! whether it exited on its own or another client closed it.

use crate::protocol::{self, ClientMsg, Frame, HostMsg, SessionId};
use crate::registry::Registry;
use crate::session::Session;
use anyhow::{Context, Result};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;

/// At most one full Replay may be materialized or queued per connection.
/// The permit travels with the message and is released only after the socket
/// writer sends or drops it; ordinary output remains bounded by channel count.
struct Outbound {
    message: Message,
    replay_permit: Option<tokio::sync::OwnedSemaphorePermit>,
}

impl Outbound {
    fn ordinary(message: Message) -> Self {
        Self {
            message,
            replay_permit: None,
        }
    }
}

fn replay_budget() -> Arc<tokio::sync::Semaphore> {
    Arc::new(tokio::sync::Semaphore::new(1))
}

async fn reserve_replay_budget(
    budget: Arc<tokio::sync::Semaphore>,
) -> std::result::Result<tokio::sync::OwnedSemaphorePermit, tokio::sync::AcquireError> {
    budget.acquire_owned().await
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuntimeInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub version: String,
}

/// Remove discovery state only when it still describes THIS exact host. A
/// startup race may let another host replace runtime.json after our read-back;
/// unconditional cleanup would then delete the winner's live discovery file.
fn cleanup_runtime_if_owned(path: &std::path::Path, ours: &RuntimeInfo) -> Result<()> {
    let should_remove = match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<RuntimeInfo>(&text) {
            Ok(current) => {
                current.pid == ours.pid
                    && current.port == ours.port
                    && current.token == ours.token
                    && current.version == ours.version
            }
            Err(error) => {
                tracing::warn!(
                    "runtime discovery state became corrupt during host lifetime; removing {}: {error}",
                    path.display()
                );
                true
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(error)
                .with_context(|| format!("reading runtime discovery state {}", path.display()));
        }
    };
    if should_remove {
        std::fs::remove_file(path)
            .with_context(|| format!("removing runtime discovery state {}", path.display()))?;
    }
    Ok(())
}

pub async fn run(
    registry: Arc<Registry>,
    data_dir: PathBuf,
    shutdown: tokio::sync::watch::Sender<bool>,
    ready: tokio::sync::oneshot::Sender<RuntimeInfo>,
) -> Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.context("bind")?;
    let port = listener.local_addr()?.port();
    let token: String = {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        (0..32)
            .map(|_| format!("{:x}", rng.gen_range(0..16u8)))
            .collect()
    };
    let info = RuntimeInfo {
        port,
        token: token.clone(),
        pid: std::process::id(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    };
    // Atomic write: a reader (already_running probe, UI discovery) must never
    // see a torn runtime.json. Known accepted gap for M1: two hosts started in
    // the same instant can still race the probe itself (single-user machine;
    // the UI spawns exactly one host).
    let runtime_path = crate::paths::runtime_file(&data_dir);
    let runtime_tmp = data_dir.join(format!("runtime.json.tmp.{}", std::process::id()));
    std::fs::write(&runtime_tmp, serde_json::to_string_pretty(&info)?)
        .with_context(|| format!("writing {}", runtime_tmp.display()))?;
    std::fs::rename(&runtime_tmp, &runtime_path)
        .with_context(|| format!("renaming to {}", runtime_path.display()))?;
    // Read-back self-check: if another host raced us and its rename landed
    // after ours, WE are the undiscoverable one — bow out instead of running
    // forever as an orphan daemon nobody can find. (A write landing after
    // this check is still possible; that residual window is the documented
    // accepted TOCTOU above.)
    let check: RuntimeInfo =
        serde_json::from_str(&std::fs::read_to_string(&runtime_path).context("runtime read-back")?)
            .context("runtime read-back parse")?;
    if check.pid != info.pid {
        anyhow::bail!(
            "another termx-host (pid {}) won the startup race; exiting",
            check.pid
        );
    }
    let _ = ready.send(info.clone());

    let mut shutdown_rx = shutdown.subscribe();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _addr)) => {
                        let reg = Arc::clone(&registry);
                        let tok = token.clone();
                        let sd = shutdown.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_conn(stream, reg, tok, sd).await {
                                tracing::debug!("connection ended: {e:#}");
                            }
                        });
                    }
                    Err(e) => {
                        // One bad accept (transient WSA error, socket teardown
                        // race) must NEVER take down the daemon and its
                        // sessions — log and keep serving.
                        tracing::warn!("accept error (continuing): {e}");
                    }
                }
            }
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    cleanup_runtime_if_owned(&runtime_path, &info)?;
                    tracing::info!("shutdown requested; exiting accept loop");
                    return Ok(());
                }
            }
        }
    }
}

/// Send a JSON control message into a connection's outbound queue.
async fn send_ctl(out_tx: &tokio::sync::mpsc::Sender<Outbound>, msg: &HostMsg) {
    if let Ok(text) = serde_json::to_string(msg) {
        let _ = out_tx.send(Outbound::ordinary(Message::Text(text))).await;
    }
}

/// Reserve the connection's Replay slot before taking a ring snapshot or
/// base64-encoding it. The permit remains attached through socket send.
///
/// `since_offset` is a reconnecting client's resume cursor (see
/// `ClientMsg::Attach`); `None` replays the whole ring.
async fn send_replay(
    out_tx: &tokio::sync::mpsc::Sender<Outbound>,
    budget: Arc<tokio::sync::Semaphore>,
    session_id: SessionId,
    session: &Session,
    since_offset: Option<u64>,
) -> Option<u64> {
    let permit = reserve_replay_budget(budget).await.ok()?;
    let (msg, end) = replay_msg(session_id, session, since_offset);
    let text = serde_json::to_string(&msg).ok()?;
    out_tx
        .send(Outbound {
            message: Message::Text(text),
            replay_permit: Some(permit),
        })
        .await
        .ok()?;
    Some(end)
}

/// Drop the prefix a client already has. A cursor the ring evicted past is
/// clamped to the ring start (the client's gap logic reports the loss), and a
/// cursor at or past the ring end yields an empty replay pinned at that end.
fn trim_replay(start_offset: u64, bytes: Vec<u8>, since_offset: Option<u64>) -> (u64, Vec<u8>) {
    let end = start_offset + bytes.len() as u64;
    let Some(since) = since_offset.filter(|since| *since > start_offset) else {
        return (start_offset, bytes);
    };
    if since >= end {
        return (end, Vec::new());
    }
    let skip = (since - start_offset) as usize;
    (since, bytes[skip..].to_vec())
}

fn replay_msg(
    session_id: SessionId,
    session: &Session,
    since_offset: Option<u64>,
) -> (HostMsg, u64) {
    let (snapshot_start, snapshot) = session.snapshot();
    let (start_offset, bytes) = trim_replay(snapshot_start, snapshot, since_offset);
    let end = start_offset + bytes.len() as u64;
    (
        HostMsg::Replay {
            session_id,
            start_offset,
            data_b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        },
        end,
    )
}

/// Relay live output for one (connection, session) pair. Ends — with a
/// SessionExited notification — when the session's exit watch fires.
///
/// `chunk_rx`/`exit_rx` are created by the CALLER, strictly before the ring
/// snapshot that fixed `replay_end`: a broadcast receiver only sees chunks
/// sent after it exists, so subscribing in here (after the spawn is polled)
/// would silently lose anything published between snapshot and first poll.
/// Subscribe-then-snapshot means the worst case is overlap, and overlap is
/// deduped by the `end <= replay_end` check.
#[allow(clippy::too_many_arguments)] // lifecycle inputs are intentionally explicit
async fn forward_session(
    session_id: SessionId,
    session: Arc<Session>,
    mut chunk_rx: tokio::sync::broadcast::Receiver<crate::session::OutputChunk>,
    mut exit_rx: tokio::sync::watch::Receiver<crate::session::ExitState>,
    mut replay_end: u64,
    out_tx: tokio::sync::mpsc::Sender<Outbound>,
    replay_budget: Arc<tokio::sync::Semaphore>,
    registry: Arc<Registry>,
) {
    let exit_code = loop {
        // Already exited before (or during) this attach: finish deterministically.
        let current = *exit_rx.borrow();
        if current.is_some() {
            break current;
        }
        tokio::select! {
            chunk = chunk_rx.recv() => match chunk {
                Ok(chunk) => {
                    let end = chunk.offset + chunk.data.len() as u64;
                    if end <= replay_end {
                        continue; // fully covered by a replay this client saw
                    }
                    let frame = protocol::encode_frame(&Frame::Output {
                        session_id,
                        offset: chunk.offset,
                        data: chunk.data.to_vec(),
                    });
                    if out_tx.send(Outbound::ordinary(Message::Binary(frame))).await.is_err() {
                        return; // connection gone
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    // Bounded-memory path: resend the authoritative ring. The
                    // horizon advances ONLY once the replay is actually in the
                    // outbound queue — advancing on a dropped replay would
                    // discard every later chunk under it as "already seen",
                    // silently and permanently. Awaited send: the replay IS
                    // the resync mechanism, so backpressure here is correct;
                    // while we wait we fall further behind, which at worst
                    // triggers another Lagged and a fresher snapshot.
                    let Some(end) = send_replay(
                        &out_tx,
                        Arc::clone(&replay_budget),
                        session_id,
                        &session,
                        None,
                    )
                    .await
                    else {
                        return; // connection gone
                    };
                    replay_end = end;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    break *exit_rx.borrow();
                }
            },
            changed = exit_rx.changed() => {
                if changed.is_err() {
                    break *exit_rx.borrow();
                }
                // loop re-checks borrow() at the top
            }
        }
    }
    .flatten();

    // Drain trailing output that raced the exit signal (conhost flushes the
    // tail after the child dies). A Lagged here must not abort the drain —
    // that would drop the session's final lines; resync from the ring instead.
    loop {
        match tokio::time::timeout(std::time::Duration::from_millis(300), chunk_rx.recv()).await {
            Err(_) => break, // quiet for 300ms — tail is flushed
            Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => break,
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {
                let Some(end) = send_replay(
                    &out_tx,
                    Arc::clone(&replay_budget),
                    session_id,
                    &session,
                    None,
                )
                .await
                else {
                    return;
                };
                replay_end = end;
            }
            Ok(Ok(chunk)) => {
                let end = chunk.offset + chunk.data.len() as u64;
                if end <= replay_end {
                    continue;
                }
                let frame = protocol::encode_frame(&Frame::Output {
                    session_id,
                    offset: chunk.offset,
                    data: chunk.data.to_vec(),
                });
                if out_tx
                    .send(Outbound::ordinary(Message::Binary(frame)))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
    }

    send_ctl(
        &out_tx,
        &HostMsg::SessionExited {
            session_id,
            exit_code,
        },
    )
    .await;
    registry.persist_logged();
}

enum ConnectionEvent<T> {
    Inbound(Option<T>),
    WriterStopped(Result<()>),
}

async fn next_connection_event<S>(
    inbound: &mut S,
    writer: &mut tokio::task::JoinHandle<Result<()>>,
) -> ConnectionEvent<S::Item>
where
    S: futures_util::Stream + Unpin,
{
    tokio::select! {
        message = inbound.next() => ConnectionEvent::Inbound(message),
        result = writer => ConnectionEvent::WriterStopped(match result {
            Ok(result) => result,
            Err(error) => Err(error).context("WebSocket writer task failed"),
        }),
    }
}

async fn handle_conn(
    stream: TcpStream,
    registry: Arc<Registry>,
    token: String,
    shutdown: tokio::sync::watch::Sender<bool>,
) -> Result<()> {
    // Inbound message cap: the protocol's largest legit client message is a
    // 256KiB input frame (+ layout JSON, far smaller) — without this,
    // tungstenite buffers up to its 64MiB default per message. Contract:
    // input frames over MAX_INPUT_FRAME get a graceful Error reply; anything
    // over THIS cap is a protocol violation and drops the connection.
    let ws_cfg = tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
        max_message_size: Some(1024 * 1024),
        max_frame_size: Some(1024 * 1024),
        ..Default::default()
    };
    // A half-open TCP connection must not park an accept task forever.
    let ws = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio_tungstenite::accept_async_with_config(stream, Some(ws_cfg)),
    )
    .await
    .context("ws handshake timeout")?
    .context("ws accept")?;
    let (mut tx, mut rx) = ws.split();

    // ---- Auth gate: first TEXT frame within 5s must be a valid Auth.
    // Non-text frames (Ping/Pong from eager clients) don't burn the attempt.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    let first_text: Option<String> = loop {
        match tokio::time::timeout_at(deadline, rx.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => break Some(t.to_string()),
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Err(_) => break None,
            Ok(Some(Ok(_))) => continue, // ping/pong/binary pre-auth: ignore
            Ok(Some(Err(_))) => break None,
        }
    };
    let authed = matches!(
        first_text.as_deref().map(serde_json::from_str::<ClientMsg>),
        Some(Ok(ClientMsg::Auth { token: ref t })) if *t == token
    );
    if !authed {
        let _ = tx
            .send(Message::Text(serde_json::to_string(&HostMsg::AuthErr {
                reason: "bad or missing token".into(),
            })?))
            .await;
        return Ok(());
    }
    tx.send(Message::Text(serde_json::to_string(&HostMsg::AuthOk {
        version: env!("CARGO_PKG_VERSION").to_string(),
        sessions: registry.list(),
    })?))
    .await?;

    // ---- Post-auth: fan session output into one outbound channel ----
    // Ordinary output is count-bounded (<=8KiB chunks, ~2MiB queue at cap).
    // Replays have a separate one-per-connection permit acquired BEFORE ring
    // snapshot/base64 materialization and held through socket send, preventing
    // repeated Attach/Lagged traffic from parking gigabytes in this queue.
    // Accepted for M1: control replies share the queue, so under full output
    // backpressure a reply await can briefly stall inbound processing — the
    // only client is our own UI, which always drains its socket.
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Outbound>(256);
    let replay_budget = replay_budget();

    // Writer half: single task owns `tx`. Keep any Replay permit alive until
    // the actual WebSocket send completes, then release it with `outbound`.
    let mut writer = tokio::spawn(async move {
        while let Some(outbound) = out_rx.recv().await {
            let Outbound {
                message,
                replay_permit,
            } = outbound;
            let _hold_until_sent = replay_permit;
            tx.send(message).await.context("WebSocket send")?;
        }
        Ok(())
    });

    // Per-attached-session forwarder tasks, aborted on Detach/socket end.
    let mut forwarders: std::collections::HashMap<SessionId, tokio::task::JoinHandle<()>> =
        std::collections::HashMap::new();

    let connection_result = loop {
        // Reap finished forwarder handles (exited sessions) so a long-lived
        // connection doesn't accumulate one dead handle per session forever.
        forwarders.retain(|_, h| !h.is_finished());
        let msg = match next_connection_event(&mut rx, &mut writer).await {
            ConnectionEvent::Inbound(Some(Ok(message))) => message,
            ConnectionEvent::Inbound(Some(Err(error))) => {
                break Err(error).context("WebSocket receive");
            }
            ConnectionEvent::Inbound(None) => break Ok(()),
            ConnectionEvent::WriterStopped(result) => break result,
        };
        match msg {
            Message::Text(text) => {
                let parsed: ClientMsg = match serde_json::from_str(&text) {
                    Ok(p) => p,
                    Err(e) => {
                        send_ctl(
                            &out_tx,
                            &HostMsg::Error {
                                context: "parse".into(),
                                message: e.to_string(),
                            },
                        )
                        .await;
                        continue;
                    }
                };
                match parsed {
                    ClientMsg::Auth { .. } => {} // already authed; ignore
                    ClientMsg::CreateSession {
                        profile,
                        cwd,
                        cols,
                        rows,
                        shell_integration,
                    } => {
                        let result = registry.create_session(
                            profile.as_deref(),
                            cwd.as_deref().map(std::path::Path::new),
                            cols,
                            rows,
                            shell_integration,
                        );
                        let reply = match result {
                            Ok((info, _)) => HostMsg::SessionCreated { info },
                            Err(e) => HostMsg::Error {
                                context: "create_session".into(),
                                message: format!("{e:#}"),
                            },
                        };
                        send_ctl(&out_tx, &reply).await;
                    }
                    ClientMsg::Attach {
                        session_id,
                        replay,
                        since_offset,
                    } => {
                        // Abort the previous forwarder AND await it, so a
                        // stale frame it was mid-sending can't land after the
                        // fresh replay below. (Await after abort returns as
                        // soon as the task hits a cancellation point.)
                        if let Some(old) = forwarders.remove(&session_id) {
                            old.abort();
                            let _ = old.await;
                        }
                        let Some(session) = registry.get(session_id) else {
                            send_ctl(
                                &out_tx,
                                &HostMsg::Error {
                                    context: "attach".into(),
                                    message: format!("no session {session_id}"),
                                },
                            )
                            .await;
                            continue;
                        };
                        // ORDER MATTERS: subscribe strictly BEFORE snapshot.
                        // A broadcast receiver only sees post-subscribe sends,
                        // so snapshot-first would silently lose any chunk
                        // published in the gap. Subscribe-first only risks
                        // overlap, which dedupes against replay_end. Chunks
                        // straddling the horizon are forwarded whole; their
                        // offset lets the client trim the overlap.
                        let chunk_rx = session.subscribe();
                        let exit_rx = session.subscribe_exit();
                        // replay:false still needs the dedupe horizon, but
                        // must not base64 a multi-MB ring just to discard it.
                        let replay_end = if replay {
                            let Some(end) = send_replay(
                                &out_tx,
                                Arc::clone(&replay_budget),
                                session_id,
                                &session,
                                since_offset,
                            )
                            .await
                            else {
                                break Ok(());
                            };
                            end
                        } else {
                            session.stream_end()
                        };
                        let handle = tokio::spawn(forward_session(
                            session_id,
                            session,
                            chunk_rx,
                            exit_rx,
                            replay_end,
                            out_tx.clone(),
                            Arc::clone(&replay_budget),
                            Arc::clone(&registry),
                        ));
                        forwarders.insert(session_id, handle);
                    }
                    ClientMsg::Detach { session_id } => {
                        if let Some(handle) = forwarders.remove(&session_id) {
                            // Await after abort: no frame may trail the detach
                            // point (a later re-attach replays from a snapshot
                            // that must be the only source of those bytes).
                            handle.abort();
                            let _ = handle.await;
                        }
                    }
                    ClientMsg::Resize {
                        session_id,
                        cols,
                        rows,
                    } => {
                        // PTY + recorded dims move together under one registry
                        // lock; concurrent resizes can't leave them diverged.
                        if let Err(e) = registry.resize_session(session_id, cols, rows) {
                            send_ctl(
                                &out_tx,
                                &HostMsg::Error {
                                    context: "resize".into(),
                                    message: format!("{e:#}"),
                                },
                            )
                            .await;
                        }
                    }
                    ClientMsg::CloseSession { session_id } => {
                        if let Some(handle) = forwarders.remove(&session_id) {
                            handle.abort();
                            let _ = handle.await;
                        }
                        if registry.close_session(session_id) {
                            // Other clients' forwarders learn via the exit
                            // watch (kill -> waiter -> SessionExited to them).
                            send_ctl(&out_tx, &HostMsg::SessionClosed { session_id }).await;
                        } else {
                            send_ctl(
                                &out_tx,
                                &HostMsg::Error {
                                    context: "close_session".into(),
                                    message: format!("no session {session_id}"),
                                },
                            )
                            .await;
                        }
                    }
                    ClientMsg::ReadHistory {
                        session_id,
                        before_offset,
                        max_bytes,
                    } => {
                        // No file, unknown session, or an unreadable one all
                        // answer the same way: an empty slice that says there
                        // is nothing older. History absence is normal.
                        let slice = registry.read_history(session_id, before_offset, max_bytes);
                        let reply = match slice {
                            Some(slice) => HostMsg::History {
                                session_id,
                                start_offset: slice.start_offset,
                                data_b64: base64::engine::general_purpose::STANDARD
                                    .encode(&slice.data),
                                at_start: slice.at_start,
                            },
                            None => HostMsg::History {
                                session_id,
                                start_offset: before_offset,
                                data_b64: String::new(),
                                at_start: true,
                            },
                        };
                        send_ctl(&out_tx, &reply).await;
                    }
                    ClientMsg::ProbeSession { session_id } => {
                        let (alive, busy) = registry.probe(session_id);
                        let (at_prompt, prompt_id) = registry.prompt_status(session_id);
                        send_ctl(
                            &out_tx,
                            &HostMsg::SessionProbe {
                                session_id,
                                alive,
                                busy,
                                at_prompt,
                                prompt_id,
                            },
                        )
                        .await;
                    }
                    ClientMsg::ChangeDirectory { session_id, expected_pid, prompt_id, cwd } => {
                        let accepted = registry.change_directory(session_id, expected_pid, &prompt_id, &cwd);
                        send_ctl(&out_tx, &HostMsg::DirectoryChanged { session_id, accepted }).await;
                    }
                    ClientMsg::ListSessions => {
                        send_ctl(
                            &out_tx,
                            &HostMsg::Sessions {
                                sessions: registry.list(),
                            },
                        )
                        .await;
                    }
                    ClientMsg::SetLayout { layout } => {
                        let reply = match registry.set_layout(layout) {
                            Ok(()) => HostMsg::LayoutSaved,
                            Err(e) => HostMsg::Error {
                                context: "set_layout".into(),
                                message: format!("{e:#}"),
                            },
                        };
                        send_ctl(&out_tx, &reply).await;
                    }
                    ClientMsg::GetState => {
                        send_ctl(
                            &out_tx,
                            &HostMsg::State {
                                layout: registry.layout(),
                                sessions: registry.list(),
                            },
                        )
                        .await;
                    }
                    ClientMsg::Shutdown => {
                        registry.shutdown_all();
                        let _ = shutdown.send(true);
                        break Ok(());
                    }
                }
            }
            Message::Binary(buf) => match protocol::decode_frame(&buf) {
                Ok(Frame::Input { session_id, data }) => match registry.get(session_id) {
                    Some(session) => {
                        if let Err(e) = session.write_input(&data) {
                            send_ctl(
                                &out_tx,
                                &HostMsg::Error {
                                    context: "input".into(),
                                    message: format!("session {session_id}: {e:#}"),
                                },
                            )
                            .await;
                        }
                    }
                    None => {
                        send_ctl(
                            &out_tx,
                            &HostMsg::Error {
                                context: "input".into(),
                                message: format!("no session {session_id}"),
                            },
                        )
                        .await;
                    }
                },
                Ok(Frame::Output { .. }) => {
                    send_ctl(
                        &out_tx,
                        &HostMsg::Error {
                            context: "input".into(),
                            message: "clients must not send Output frames".into(),
                        },
                    )
                    .await;
                }
                Err(e) => {
                    send_ctl(
                        &out_tx,
                        &HostMsg::Error {
                            context: "frame".into(),
                            message: format!("{e:#}"),
                        },
                    )
                    .await;
                }
            },
            Message::Close(_) => break Ok(()),
            _ => {}
        }
    };

    // Client gone: tear down THIS client's forwarders. Sessions keep running.
    for (_, handle) in forwarders.drain() {
        handle.abort();
    }
    writer.abort();
    connection_result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    #[tokio::test]
    async fn guarded_directory_request_refuses_input_that_races_after_the_probe() {
        let _serial = crate::HEAVY_PTY_TEST.lock().await;
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;
        let id = create_session(&mut ws, Some("powershell"), true).await;
        send_json(&mut ws, &ClientMsg::ListSessions).await;
        let pid = match next_json(&mut ws).await {
            HostMsg::Sessions { sessions } => sessions.iter().find(|info| info.id == id).unwrap().pid.unwrap(),
            other => panic!("expected sessions, got {other:?}"),
        };
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
        let prompt_id = loop {
            send_json(&mut ws, &ClientMsg::ProbeSession { session_id: id }).await;
            if let HostMsg::SessionProbe { at_prompt: Some(true), prompt_id: Some(prompt_id), .. } = next_json(&mut ws).await { break prompt_id; }
            assert!(tokio::time::Instant::now() < deadline, "no trusted PSReadLine prompt");
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        };
        ws.send(input_frame(id, b"Write-Output pending_user_input")).await.unwrap();
        send_json(&mut ws, &ClientMsg::ChangeDirectory { session_id: id, expected_pid: pid,
            prompt_id, cwd: tmp.path().to_string_lossy().into_owned() }).await;
        assert!(matches!(next_json(&mut ws).await, HostMsg::DirectoryChanged { accepted: false, .. }));
        send_json(&mut ws, &ClientMsg::ListSessions).await;
        match next_json(&mut ws).await {
            HostMsg::Sessions { sessions } => assert!(sessions.iter().find(|info| info.id == id).unwrap().alive),
            other => panic!("expected sessions, got {other:?}"),
        }
        ws.send(input_frame(id, b"\rexit\r")).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        shutdown_and_drain(&mut ws).await;
    }

    /// Boots a server on an ephemeral port inside the test runtime.
    async fn boot(tmp: &std::path::Path) -> (RuntimeInfo, tokio::sync::watch::Sender<bool>) {
        let reg = Arc::new(Registry::new(tmp.to_path_buf(), Config::default()));
        let (shutdown_tx, _) = tokio::sync::watch::channel(false);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(run(reg, tmp.to_path_buf(), shutdown_tx.clone(), ready_tx));
        (ready_rx.await.expect("server ready"), shutdown_tx)
    }

    type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

    async fn connect(rt: &RuntimeInfo) -> Ws {
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{}", rt.port))
            .await
            .expect("connect");
        ws
    }

    async fn send_json(ws: &mut Ws, msg: &ClientMsg) {
        ws.send(Message::Text(serde_json::to_string(msg).unwrap()))
            .await
            .unwrap();
    }

    /// Reads messages until a JSON control message arrives; panics on close.
    async fn next_json(ws: &mut Ws) -> HostMsg {
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(20), ws.next())
                .await
                .expect("timeout waiting for host msg")
                .expect("stream ended")
                .expect("ws error")
            {
                Message::Text(t) => return serde_json::from_str(&t).unwrap(),
                Message::Binary(_) => continue,
                other => panic!("unexpected: {other:?}"),
            }
        }
    }

    async fn auth(ws: &mut Ws, rt: &RuntimeInfo) -> Vec<protocol::SessionInfo> {
        send_json(
            ws,
            &ClientMsg::Auth {
                token: rt.token.clone(),
            },
        )
        .await;
        match next_json(ws).await {
            HostMsg::AuthOk { sessions, .. } => sessions,
            other => panic!("expected AuthOk, got {other:?}"),
        }
    }

    /// End a test's server the way production ends: Shutdown tears every
    /// session down with a bounded wait BEFORE the test process may exit.
    /// Skipping this orphans OpenConsole processes that outlive the test
    /// runner spinning at 100% CPU (observed saturating this machine).
    async fn shutdown_and_drain(ws: &mut Ws) {
        send_json(ws, &ClientMsg::Shutdown).await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            while let Some(msg) = ws.next().await {
                if msg.is_err() {
                    break;
                }
            }
        })
        .await;
    }

    async fn create_cmd(ws: &mut Ws) -> SessionId {
        create_session(ws, Some("cmd"), false).await
    }

    async fn create_session(
        ws: &mut Ws,
        profile: Option<&str>,
        shell_integration: bool,
    ) -> SessionId {
        send_json(
            ws,
            &ClientMsg::CreateSession {
                profile: profile.map(Into::into),
                cwd: None,
                cols: 100,
                rows: 30,
                shell_integration,
            },
        )
        .await;
        match next_json(ws).await {
            HostMsg::SessionCreated { info } => info.id,
            other => panic!("expected SessionCreated, got {other:?}"),
        }
    }

    fn input_frame(id: SessionId, data: &[u8]) -> Message {
        Message::Binary(protocol::encode_frame(&Frame::Input {
            session_id: id,
            data: data.to_vec(),
        }))
    }

    /// Pump until `pred` over accumulated binary output is true or timeout.
    async fn pump_output_until(ws: &mut Ws, id: SessionId, needle: &str, secs: u64) -> String {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
        let mut seen = String::new();
        while std::time::Instant::now() < deadline && !seen.contains(needle) {
            match tokio::time::timeout(std::time::Duration::from_secs(5), ws.next()).await {
                Ok(Some(Ok(Message::Binary(buf)))) => {
                    if let Ok(Frame::Output {
                        session_id, data, ..
                    }) = protocol::decode_frame(&buf)
                    {
                        if session_id == id {
                            seen.push_str(&String::from_utf8_lossy(&data));
                        }
                    }
                }
                Ok(Some(Ok(_))) => continue,
                _ => break,
            }
        }
        seen
    }

    #[tokio::test]
    async fn bad_token_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        send_json(
            &mut ws,
            &ClientMsg::Auth {
                token: "wrong".into(),
            },
        )
        .await;
        match next_json(&mut ws).await {
            HostMsg::AuthErr { .. } => {}
            other => panic!("expected AuthErr, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn garbage_json_pre_auth_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        ws.send(Message::Text("{not json".into())).await.unwrap();
        match next_json(&mut ws).await {
            HostMsg::AuthErr { .. } => {}
            other => panic!("expected AuthErr, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn binary_frame_pre_auth_does_not_burn_the_attempt() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        ws.send(Message::Binary(vec![9, 9, 9])).await.unwrap();
        let sessions = auth(&mut ws, &rt).await;
        assert!(sessions.is_empty());
    }

    /// End-to-end threading of the wire flag: CreateSession{shell_integration}
    /// must reach profile resolution, so a client that asked for integration
    /// sees OSC 9;9 cwd reports on its own socket.
    #[tokio::test]
    async fn shell_integration_flag_reaches_the_spawned_shell() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;
        let id = create_session(&mut ws, Some("cmd"), true).await;
        send_json(
            &mut ws,
            &ClientMsg::Attach {
                session_id: id,
                replay: true,
                since_offset: None,
            },
        )
        .await;
        ws.send(input_frame(id, b"cd \\\r\n")).await.unwrap();
        let seen = pump_output_until(&mut ws, id, "\x1b]9;9;", 30).await;
        assert!(
            seen.contains("\x1b]9;9;"),
            "no OSC 9;9 cwd report reached the client; saw: {seen:?}"
        );

        send_json(&mut ws, &ClientMsg::CloseSession { session_id: id }).await;
        shutdown_and_drain(&mut ws).await;
    }

    #[tokio::test]
    async fn auth_create_echo_binary_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;
        let id = create_cmd(&mut ws).await;

        send_json(
            &mut ws,
            &ClientMsg::Attach {
                session_id: id,
                replay: false,
                since_offset: None,
            },
        )
        .await;
        ws.send(input_frame(id, b"echo ws_marker_42\r\n"))
            .await
            .unwrap();
        let seen = pump_output_until(&mut ws, id, "ws_marker_42", 20).await;
        assert!(
            seen.contains("ws_marker_42"),
            "no echo over WS; saw: {seen:?}"
        );

        send_json(&mut ws, &ClientMsg::CloseSession { session_id: id }).await;
        loop {
            match next_json(&mut ws).await {
                HostMsg::SessionClosed { .. } => break,
                _ => continue,
            }
        }
        shutdown_and_drain(&mut ws).await;
    }

    #[tokio::test]
    async fn self_exited_session_notifies_attached_client_with_code() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;
        let id = create_cmd(&mut ws).await;
        send_json(
            &mut ws,
            &ClientMsg::Attach {
                session_id: id,
                replay: false,
                since_offset: None,
            },
        )
        .await;
        ws.send(input_frame(id, b"exit 7\r\n")).await.unwrap();
        let code = loop {
            match next_json(&mut ws).await {
                HostMsg::SessionExited {
                    session_id,
                    exit_code,
                } => {
                    assert_eq!(session_id, id);
                    break exit_code;
                }
                _ => continue,
            }
        };
        assert_eq!(code, Some(7), "exit code must reach the client");
        // Session stays listed (not closed) but is no longer alive.
        send_json(&mut ws, &ClientMsg::ListSessions).await;
        let sessions = loop {
            match next_json(&mut ws).await {
                HostMsg::Sessions { sessions } => break sessions,
                _ => continue,
            }
        };
        let info = sessions.iter().find(|s| s.id == id).expect("still listed");
        assert!(!info.alive);
        shutdown_and_drain(&mut ws).await;
    }

    #[tokio::test]
    async fn close_by_one_client_notifies_other_attached_client() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws_a = connect(&rt).await;
        auth(&mut ws_a, &rt).await;
        let id = create_cmd(&mut ws_a).await;

        let mut ws_b = connect(&rt).await;
        auth(&mut ws_b, &rt).await;
        send_json(
            &mut ws_b,
            &ClientMsg::Attach {
                session_id: id,
                replay: false,
                since_offset: None,
            },
        )
        .await;
        // Round-trip on B's connection: guarantees the Attach was processed
        // (same-connection ordering) before A pulls the trigger.
        send_json(&mut ws_b, &ClientMsg::ListSessions).await;
        loop {
            match next_json(&mut ws_b).await {
                HostMsg::Sessions { .. } => break,
                _ => continue,
            }
        }

        send_json(&mut ws_a, &ClientMsg::CloseSession { session_id: id }).await;
        assert!(matches!(
            next_json(&mut ws_a).await,
            HostMsg::SessionClosed { .. }
        ));
        // B (merely attached) must observe the session ending.
        loop {
            match next_json(&mut ws_b).await {
                HostMsg::SessionExited { session_id, .. } => {
                    assert_eq!(session_id, id);
                    break;
                }
                _ => continue,
            }
        }
        shutdown_and_drain(&mut ws_a).await;
    }

    #[tokio::test]
    async fn two_clients_both_receive_output_and_detach_isolates() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws_a = connect(&rt).await;
        auth(&mut ws_a, &rt).await;
        let id = create_cmd(&mut ws_a).await;
        send_json(
            &mut ws_a,
            &ClientMsg::Attach {
                session_id: id,
                replay: false,
                since_offset: None,
            },
        )
        .await;

        let mut ws_b = connect(&rt).await;
        auth(&mut ws_b, &rt).await;
        send_json(
            &mut ws_b,
            &ClientMsg::Attach {
                session_id: id,
                replay: false,
                since_offset: None,
            },
        )
        .await;
        // Both see the same echo.
        ws_a.send(input_frame(id, b"echo both_see_this\r\n"))
            .await
            .unwrap();
        let seen_a = pump_output_until(&mut ws_a, id, "both_see_this", 20).await;
        let seen_b = pump_output_until(&mut ws_b, id, "both_see_this", 20).await;
        assert!(seen_a.contains("both_see_this"), "A: {seen_a:?}");
        assert!(seen_b.contains("both_see_this"), "B: {seen_b:?}");

        // B detaches; only A sees the next marker.
        send_json(&mut ws_b, &ClientMsg::Detach { session_id: id }).await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        ws_a.send(input_frame(id, b"echo only_a_sees_this\r\n"))
            .await
            .unwrap();
        let seen_a2 = pump_output_until(&mut ws_a, id, "only_a_sees_this", 20).await;
        assert!(seen_a2.contains("only_a_sees_this"));
        let seen_b2 = pump_output_until(&mut ws_b, id, "only_a_sees_this", 2).await;
        assert!(
            !seen_b2.contains("only_a_sees_this"),
            "detached client must not receive output: {seen_b2:?}"
        );
        send_json(&mut ws_a, &ClientMsg::CloseSession { session_id: id }).await;
        shutdown_and_drain(&mut ws_a).await;
    }

    #[tokio::test]
    async fn set_layout_get_state_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;
        send_json(
            &mut ws,
            &ClientMsg::SetLayout {
                layout: serde_json::json!({"groups": [{"name": "harness", "color": "#ff8800"}]}),
            },
        )
        .await;
        // Durable-save ack must arrive before anything else.
        assert!(matches!(next_json(&mut ws).await, HostMsg::LayoutSaved));
        send_json(&mut ws, &ClientMsg::GetState).await;
        let layout = loop {
            match next_json(&mut ws).await {
                HostMsg::State { layout, .. } => break layout,
                _ => continue,
            }
        };
        assert_eq!(layout["groups"][0]["name"], "harness");
        assert_eq!(layout["groups"][0]["color"], "#ff8800");
    }

    #[tokio::test]
    async fn resize_updates_dims_and_unknown_session_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;
        let id = create_cmd(&mut ws).await;
        send_json(
            &mut ws,
            &ClientMsg::Resize {
                session_id: id,
                cols: 132,
                rows: 43,
            },
        )
        .await;
        send_json(&mut ws, &ClientMsg::ListSessions).await;
        let sessions = loop {
            match next_json(&mut ws).await {
                HostMsg::Sessions { sessions } => break sessions,
                _ => continue,
            }
        };
        let info = sessions.iter().find(|s| s.id == id).unwrap();
        assert_eq!((info.cols, info.rows), (132, 43));

        send_json(
            &mut ws,
            &ClientMsg::Resize {
                session_id: 9999,
                cols: 80,
                rows: 25,
            },
        )
        .await;
        loop {
            match next_json(&mut ws).await {
                HostMsg::Error { context, .. } => {
                    assert_eq!(context, "resize");
                    break;
                }
                _ => continue,
            }
        }
        send_json(&mut ws, &ClientMsg::CloseSession { session_id: id }).await;
        shutdown_and_drain(&mut ws).await;
    }

    #[tokio::test]
    async fn input_to_unknown_session_reports_error() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;
        ws.send(input_frame(4242, b"hello?\r\n")).await.unwrap();
        loop {
            match next_json(&mut ws).await {
                HostMsg::Error { context, message } => {
                    assert_eq!(context, "input");
                    assert!(message.contains("4242"));
                    break;
                }
                _ => continue,
            }
        }
    }

    #[tokio::test]
    async fn close_unknown_session_reports_error_not_closed() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;
        send_json(&mut ws, &ClientMsg::CloseSession { session_id: 777 }).await;
        loop {
            match next_json(&mut ws).await {
                HostMsg::Error { context, .. } => {
                    assert_eq!(context, "close_session");
                    break;
                }
                HostMsg::SessionClosed { .. } => panic!("must not claim to close a ghost"),
                _ => continue,
            }
        }
    }

    #[tokio::test]
    async fn session_survives_client_death_and_replays() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;

        // Client A: create a session, write a marker, then DIE without cleanup.
        let id: SessionId = {
            let mut ws_a = connect(&rt).await;
            auth(&mut ws_a, &rt).await;
            let id = create_cmd(&mut ws_a).await;
            ws_a.send(input_frame(id, b"echo survive_marker_99\r\n"))
                .await
                .unwrap();
            // Give the shell a moment to execute so the marker lands in the ring.
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            id
            // ws_a dropped HERE without Detach/Close — simulates a UI crash.
        };

        // Client B: fresh connection, attach with replay, expect the marker.
        let mut ws_b = connect(&rt).await;
        let sessions = auth(&mut ws_b, &rt).await;
        assert!(
            sessions.iter().any(|s| s.id == id && s.alive),
            "session must still be alive after client A died: {sessions:?}"
        );
        send_json(
            &mut ws_b,
            &ClientMsg::Attach {
                session_id: id,
                replay: true,
                since_offset: None,
            },
        )
        .await;
        let replayed = loop {
            match next_json(&mut ws_b).await {
                HostMsg::Replay {
                    session_id,
                    data_b64,
                    ..
                } => {
                    assert_eq!(session_id, id);
                    break String::from_utf8_lossy(
                        &base64::engine::general_purpose::STANDARD
                            .decode(data_b64)
                            .unwrap(),
                    )
                    .to_string();
                }
                _ => continue,
            }
        };
        assert!(
            replayed.contains("survive_marker_99"),
            "replay must contain pre-crash output; got: {replayed:?}"
        );
        send_json(&mut ws_b, &ClientMsg::CloseSession { session_id: id }).await;
        shutdown_and_drain(&mut ws_b).await;
    }

    /// Sorted-merge coverage check: the client-visible stream (replays +
    /// frames) must have no hole between `from` and `to`.
    fn assert_no_holes(intervals: &mut [(u64, u64)], from: u64, to: u64) {
        intervals.sort_unstable();
        let mut covered = from;
        for &(s, e) in intervals.iter() {
            assert!(
                s <= covered,
                "hole in client stream: [{covered}, {s}) never delivered"
            );
            covered = covered.max(e);
        }
        assert!(
            covered >= to,
            "stream truncated: covered to {covered}, expected {to}"
        );
    }

    #[tokio::test]
    async fn attach_to_exited_session_gets_replay_and_exit_code() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;
        let id = create_cmd(&mut ws).await;
        // Exit WITHOUT ever attaching, then wait until the host sees it dead.
        ws.send(input_frame(id, b"exit 5\r\n")).await.unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            assert!(
                std::time::Instant::now() < deadline,
                "session never reported dead"
            );
            send_json(&mut ws, &ClientMsg::ListSessions).await;
            let sessions = loop {
                match next_json(&mut ws).await {
                    HostMsg::Sessions { sessions } => break sessions,
                    _ => continue,
                }
            };
            if sessions.iter().any(|s| s.id == id && !s.alive) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        // Attaching to the corpse must yield its last output + a deterministic
        // SessionExited with the real code — this is how M2 shows dead shells.
        send_json(
            &mut ws,
            &ClientMsg::Attach {
                session_id: id,
                replay: true,
                since_offset: None,
            },
        )
        .await;
        let mut got_replay = false;
        loop {
            match next_json(&mut ws).await {
                HostMsg::Replay { session_id, .. } => {
                    assert_eq!(session_id, id);
                    got_replay = true;
                }
                HostMsg::SessionExited {
                    session_id,
                    exit_code,
                } => {
                    assert_eq!(session_id, id);
                    assert_eq!(exit_code, Some(5));
                    break;
                }
                _ => continue,
            }
        }
        assert!(got_replay, "replay must precede the exit notification");
        shutdown_and_drain(&mut ws).await;
    }

    #[tokio::test]
    async fn attach_mid_stream_delivers_gapless_coverage() {
        let _serial = crate::HEAVY_PTY_TEST.lock().await;
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;
        let id = create_cmd(&mut ws).await;
        // Start a firehose, let it run, THEN attach — the replay snapshot and
        // the broadcast subscription race live output here.
        ws.send(input_frame(
            id,
            b"for /L %i in (1,1,1500) do @echo gap_%i\r\n",
        ))
        .await
        .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        send_json(
            &mut ws,
            &ClientMsg::Attach {
                session_id: id,
                replay: true,
                since_offset: None,
            },
        )
        .await;

        let mut intervals: Vec<(u64, u64)> = Vec::new();
        let mut first_replay_start: Option<u64> = None;
        let mut text = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        while std::time::Instant::now() < deadline && !text.contains("gap_1500") {
            match tokio::time::timeout(std::time::Duration::from_secs(5), ws.next()).await {
                Err(_) => continue, // quiet spell; the outer deadline governs
                Ok(None) | Ok(Some(Err(_))) => break,
                Ok(Some(Ok(Message::Text(t)))) => {
                    if let Ok(HostMsg::Replay {
                        session_id,
                        start_offset,
                        data_b64,
                    }) = serde_json::from_str(&t)
                    {
                        assert_eq!(session_id, id);
                        let bytes = base64::engine::general_purpose::STANDARD
                            .decode(data_b64)
                            .unwrap();
                        first_replay_start.get_or_insert(start_offset);
                        intervals.push((start_offset, start_offset + bytes.len() as u64));
                        text.push_str(&String::from_utf8_lossy(&bytes));
                    }
                }
                Ok(Some(Ok(Message::Binary(buf)))) => {
                    if let Ok(Frame::Output {
                        session_id,
                        offset,
                        data,
                    }) = protocol::decode_frame(&buf)
                    {
                        assert_eq!(session_id, id);
                        intervals.push((offset, offset + data.len() as u64));
                        text.push_str(&String::from_utf8_lossy(&data));
                    }
                }
                Ok(Some(Ok(_))) => continue,
            }
        }
        assert!(
            text.contains("gap_1500"),
            "firehose tail never arrived; got {} bytes",
            text.len()
        );
        let from = first_replay_start.expect("a replay must have been delivered");
        let to = intervals.iter().map(|&(_, e)| e).max().unwrap();
        assert_no_holes(&mut intervals, from, to);
        send_json(&mut ws, &ClientMsg::CloseSession { session_id: id }).await;
        shutdown_and_drain(&mut ws).await;
    }

    #[tokio::test]
    async fn reattach_never_delivers_stale_covered_frames() {
        let _serial = crate::HEAVY_PTY_TEST.lock().await;
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;
        let id = create_cmd(&mut ws).await;
        ws.send(input_frame(
            id,
            b"for /L %i in (1,1,1500) do @echo re_%i\r\n",
        ))
        .await
        .unwrap();
        send_json(
            &mut ws,
            &ClientMsg::Attach {
                session_id: id,
                replay: true,
                since_offset: None,
            },
        )
        .await;
        // Let the first forwarder stream for a bit, then re-attach mid-flow.
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        send_json(
            &mut ws,
            &ClientMsg::Attach {
                session_id: id,
                replay: true,
                since_offset: None,
            },
        )
        .await;
        // Skip the backlog (frames + first replay) until the SECOND Replay.
        let mut replays_seen = 0;
        let replay2_end = loop {
            match tokio::time::timeout(std::time::Duration::from_secs(20), ws.next())
                .await
                .expect("timeout waiting for second replay")
                .expect("stream ended")
                .expect("ws error")
            {
                Message::Text(t) => {
                    if let Ok(HostMsg::Replay {
                        start_offset,
                        data_b64,
                        ..
                    }) = serde_json::from_str(&t)
                    {
                        replays_seen += 1;
                        if replays_seen == 2 {
                            let len = base64::engine::general_purpose::STANDARD
                                .decode(data_b64)
                                .unwrap()
                                .len() as u64;
                            break start_offset + len;
                        }
                    }
                }
                _ => continue,
            }
        };
        // After the fresh replay, no frame may be FULLY covered by it — that
        // would be a stale send from the aborted first forwarder.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut checked = 0u32;
        while std::time::Instant::now() < deadline && checked < 200 {
            match tokio::time::timeout(std::time::Duration::from_millis(1500), ws.next()).await {
                Ok(Some(Ok(Message::Binary(buf)))) => {
                    if let Ok(Frame::Output { offset, data, .. }) = protocol::decode_frame(&buf) {
                        let end = offset + data.len() as u64;
                        assert!(
                            end > replay2_end,
                            "stale frame [{offset},{end}) fully covered by replay ending {replay2_end}"
                        );
                        checked += 1;
                    }
                }
                Ok(Some(Ok(_))) => continue,
                _ => break,
            }
        }
        send_json(&mut ws, &ClientMsg::CloseSession { session_id: id }).await;
        shutdown_and_drain(&mut ws).await;
    }

    #[tokio::test]
    async fn default_profile_is_used_when_profile_omitted() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;
        send_json(
            &mut ws,
            &ClientMsg::CreateSession {
                profile: None,
                cwd: None,
                cols: 100,
                rows: 30,
                shell_integration: false,
            },
        )
        .await;
        let info = match next_json(&mut ws).await {
            HostMsg::SessionCreated { info } => info,
            other => panic!("expected SessionCreated, got {other:?}"),
        };
        assert_eq!(info.profile, "powershell", "config default must apply");
        send_json(
            &mut ws,
            &ClientMsg::CloseSession {
                session_id: info.id,
            },
        )
        .await;
        shutdown_and_drain(&mut ws).await;
    }

    #[tokio::test]
    async fn client_sent_output_frame_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;
        ws.send(Message::Binary(protocol::encode_frame(&Frame::Output {
            session_id: 1,
            offset: 0,
            data: b"spoof".to_vec(),
        })))
        .await
        .unwrap();
        loop {
            match next_json(&mut ws).await {
                HostMsg::Error { message, .. } => {
                    assert!(message.contains("Output"), "got: {message}");
                    break;
                }
                _ => continue,
            }
        }
    }

    #[tokio::test]
    async fn lagged_forwarder_resyncs_via_replay_with_no_holes() {
        let _serial = crate::HEAVY_PTY_TEST.lock().await;
        // Direct forward_session harness: a broadcast capacity of 2 plus a
        // deliberately slow consumer forces the Lagged path deterministically.
        let profile = crate::profiles::resolve("cmd", false).unwrap();
        let mut p = profile.clone();
        p.args = vec![
            "/c".into(),
            "for /L %i in (1,1,4000) do @echo lag_line_%i".into(),
        ];
        let session = Arc::new(
            crate::session::Session::spawn_with_broadcast_cap(
                &p,
                None,
                120,
                40,
                4 * 1024 * 1024,
                2,
            )
            .unwrap(),
        );
        let tmp = tempfile::tempdir().unwrap();
        let reg = Arc::new(Registry::new(tmp.path().to_path_buf(), Config::default()));
        // Same order as the Attach arm: subscribe, then snapshot.
        let chunk_rx = session.subscribe();
        let exit_rx = session.subscribe_exit();
        let (start, bytes) = session.snapshot();
        let replay_end = start + bytes.len() as u64;
        let mut intervals: Vec<(u64, u64)> = vec![(start, replay_end)];
        let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Outbound>(2);
        let fwd = tokio::spawn(forward_session(
            1,
            Arc::clone(&session),
            chunk_rx,
            exit_rx,
            replay_end,
            out_tx,
            replay_budget(),
            Arc::clone(&reg),
        ));
        let mut lag_replays = 0u32;
        let mut exited = false;
        while let Some(outbound) = out_rx.recv().await {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await; // slow client
            match outbound.message {
                Message::Text(t) => match serde_json::from_str::<HostMsg>(&t).unwrap() {
                    HostMsg::Replay {
                        start_offset,
                        data_b64,
                        ..
                    } => {
                        lag_replays += 1;
                        let len = base64::engine::general_purpose::STANDARD
                            .decode(data_b64)
                            .unwrap()
                            .len() as u64;
                        intervals.push((start_offset, start_offset + len));
                    }
                    HostMsg::SessionExited { .. } => exited = true,
                    _ => {}
                },
                Message::Binary(buf) => {
                    if let Ok(Frame::Output { offset, data, .. }) = protocol::decode_frame(&buf) {
                        intervals.push((offset, offset + data.len() as u64));
                    }
                }
                _ => {}
            }
        }
        let _ = fwd.await;
        assert!(exited, "forwarder must end with SessionExited");
        assert!(
            lag_replays >= 1,
            "tiny broadcast + slow consumer must force a lag replay"
        );
        let (final_start, final_bytes) = session.snapshot();
        let total_end = final_start + final_bytes.len() as u64;
        assert_no_holes(&mut intervals, start, total_end);
    }

    #[tokio::test]
    async fn attach_without_replay_suppresses_the_initial_replay() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;
        let id = create_cmd(&mut ws).await;
        // Let the banner land in the ring so a replay WOULD have content.
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        send_json(
            &mut ws,
            &ClientMsg::Attach {
                session_id: id,
                replay: false,
                since_offset: None,
            },
        )
        .await;
        // Round-trip: by the time Sessions comes back the Attach (and any
        // replay it wrongly sent) is already in our stream.
        send_json(&mut ws, &ClientMsg::ListSessions).await;
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(10), ws.next())
                .await
                .expect("timeout")
                .expect("stream ended")
                .expect("ws error")
            {
                Message::Text(t) => match serde_json::from_str::<HostMsg>(&t).unwrap() {
                    HostMsg::Replay { .. } => panic!("replay:false must not send a Replay"),
                    HostMsg::Sessions { .. } => break,
                    _ => continue,
                },
                _ => continue,
            }
        }
        shutdown_and_drain(&mut ws).await;
    }

    #[tokio::test]
    async fn unauthenticated_connection_is_closed_at_the_deadline() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        // Send NOTHING. The 5s auth deadline must close the socket; we must
        // never receive AuthOk.
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(8), async {
            loop {
                match ws.next().await {
                    Some(Ok(Message::Text(t))) => {
                        let parsed: HostMsg = serde_json::from_str(&t).unwrap();
                        assert!(
                            !matches!(parsed, HostMsg::AuthOk { .. }),
                            "must not auth a silent client"
                        );
                    }
                    Some(Ok(_)) => continue,
                    Some(Err(_)) | None => break,
                }
            }
        })
        .await;
        assert!(outcome.is_ok(), "connection was not closed by the deadline");
    }

    #[tokio::test]
    async fn set_layout_persist_failure_reaches_the_client() {
        let tmp = tempfile::tempdir().unwrap();
        // A DIRECTORY named state.json makes the persist rename fail
        // deterministically — the client must get the error, not silence.
        std::fs::create_dir(tmp.path().join("state.json")).unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;
        send_json(
            &mut ws,
            &ClientMsg::SetLayout {
                layout: serde_json::json!({"groups": []}),
            },
        )
        .await;
        loop {
            match next_json(&mut ws).await {
                HostMsg::Error { context, .. } => {
                    assert_eq!(context, "set_layout");
                    break;
                }
                HostMsg::LayoutSaved => panic!("must not ack a failed persist"),
                _ => continue,
            }
        }
    }

    #[tokio::test]
    async fn one_client_attached_to_two_sessions_gets_both_streams() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;
        let a = create_cmd(&mut ws).await;
        let b = create_cmd(&mut ws).await;
        for id in [a, b] {
            send_json(
                &mut ws,
                &ClientMsg::Attach {
                    session_id: id,
                    replay: false,
                    since_offset: None,
                },
            )
            .await;
        }
        ws.send(input_frame(a, b"echo marker_from_a\r\n"))
            .await
            .unwrap();
        ws.send(input_frame(b, b"echo marker_from_b\r\n"))
            .await
            .unwrap();
        // One pass over the shared socket: both streams arrive interleaved,
        // so pumping per-session would discard the other session's frames.
        let mut seen_a = String::new();
        let mut seen_b = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while std::time::Instant::now() < deadline
            && !(seen_a.contains("marker_from_a") && seen_b.contains("marker_from_b"))
        {
            match tokio::time::timeout(std::time::Duration::from_secs(5), ws.next()).await {
                Err(_) => continue,
                Ok(Some(Ok(Message::Binary(buf)))) => {
                    if let Ok(Frame::Output {
                        session_id, data, ..
                    }) = protocol::decode_frame(&buf)
                    {
                        let text = String::from_utf8_lossy(&data).to_string();
                        if session_id == a {
                            seen_a.push_str(&text);
                        } else if session_id == b {
                            seen_b.push_str(&text);
                        }
                    }
                }
                Ok(Some(Ok(_))) => continue,
                _ => break,
            }
        }
        assert!(seen_a.contains("marker_from_a"), "A: {seen_a:?}");
        assert!(seen_b.contains("marker_from_b"), "B: {seen_b:?}");
        for id in [a, b] {
            send_json(&mut ws, &ClientMsg::CloseSession { session_id: id }).await;
        }
        shutdown_and_drain(&mut ws).await;
    }

    #[tokio::test]
    async fn runtime_json_is_written_and_valid() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let text = std::fs::read_to_string(tmp.path().join("runtime.json")).unwrap();
        let parsed: RuntimeInfo = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed.port, rt.port);
        assert_eq!(parsed.token, rt.token);
        assert_eq!(parsed.pid, std::process::id());
    }

    #[tokio::test]
    async fn connection_loop_observes_writer_task_death() {
        let mut inbound = futures_util::stream::pending::<u8>();
        let mut writer = tokio::spawn(async { Ok(()) });
        let event = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            next_connection_event(&mut inbound, &mut writer),
        )
        .await
        .expect("writer completion must wake an otherwise-idle connection");
        assert!(matches!(event, ConnectionEvent::WriterStopped(Ok(()))));
    }

    #[tokio::test]
    async fn replay_budget_allows_only_one_max_replay_at_a_time() {
        let budget = replay_budget();
        let first = reserve_replay_budget(Arc::clone(&budget))
            .await
            .expect("first max replay fits");
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(50),
                reserve_replay_budget(Arc::clone(&budget)),
            )
            .await
            .is_err(),
            "a second max replay must wait instead of materializing another 10+ MiB message"
        );
        drop(first);
        let _second = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            reserve_replay_budget(budget),
        )
        .await
        .expect("budget released")
        .expect("second max replay fits after release");
    }

    /// Reconnect resync: the ring snapshot is trimmed to the client's cursor
    /// BEFORE base64, so a resync after a dropped socket costs the unseen tail
    /// rather than the whole ring.
    #[test]
    fn trim_replay_slices_the_snapshot_at_the_clients_cursor() {
        let bytes = b"abcdefgh".to_vec();
        assert_eq!(
            trim_replay(100, bytes.clone(), None),
            (100, bytes.clone()),
            "no cursor keeps today's replay-everything behavior"
        );
        assert_eq!(
            trim_replay(100, bytes.clone(), Some(103)),
            (103, b"defgh".to_vec()),
            "a mid-ring cursor replays exactly the tail"
        );
        assert_eq!(
            trim_replay(100, bytes.clone(), Some(100)),
            (100, bytes.clone()),
            "a cursor at the ring start is the whole ring"
        );
    }

    /// A cursor the ring has already evicted past cannot be honored; the client
    /// gets what still exists and its own gap logic reports the loss.
    #[test]
    fn trim_replay_clamps_a_cursor_the_ring_evicted_past() {
        let bytes = b"abcdefgh".to_vec();
        assert_eq!(trim_replay(100, bytes.clone(), Some(7)), (100, bytes));
    }

    /// A client that saw everything gets an empty replay pinned at the ring
    /// end — not an error, and never a re-send of bytes it already rendered.
    #[test]
    fn trim_replay_at_or_beyond_the_ring_end_is_empty() {
        let bytes = b"abcdefgh".to_vec();
        assert_eq!(
            trim_replay(100, bytes.clone(), Some(108)),
            (108, Vec::new())
        );
        assert_eq!(
            trim_replay(100, bytes, Some(u64::MAX)),
            (108, Vec::new()),
            "an absurd cursor must not panic or wrap"
        );
    }

    /// Wire-level proof through the real dispatcher: re-attaching with the
    /// cursor from a previous replay yields a Replay that starts exactly there.
    #[tokio::test]
    async fn attach_with_since_offset_replays_only_the_unseen_tail() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;
        let id = create_cmd(&mut ws).await;
        // Output only reaches an ATTACHED client, so attach before driving the
        // shell; replay:false keeps the ring out of this first exchange.
        send_json(
            &mut ws,
            &ClientMsg::Attach {
                session_id: id,
                replay: false,
                since_offset: None,
            },
        )
        .await;
        ws.send(input_frame(id, b"echo since_offset_marker\r\n"))
            .await
            .unwrap();
        let seen = pump_output_until(&mut ws, id, "since_offset_marker", 20).await;
        assert!(seen.contains("since_offset_marker"), "saw: {seen:?}");

        async fn next_replay(ws: &mut Ws, id: SessionId) -> (u64, Vec<u8>) {
            loop {
                if let HostMsg::Replay {
                    session_id,
                    start_offset,
                    data_b64,
                } = next_json(ws).await
                {
                    assert_eq!(session_id, id);
                    return (
                        start_offset,
                        base64::engine::general_purpose::STANDARD
                            .decode(data_b64)
                            .unwrap(),
                    );
                }
            }
        }

        // Full replay first: establishes the ring window this client has seen.
        send_json(
            &mut ws,
            &ClientMsg::Attach {
                session_id: id,
                replay: true,
                since_offset: None,
            },
        )
        .await;
        let (start, full) = next_replay(&mut ws, id).await;
        assert!(full.len() > 8, "need a ring worth slicing: {}", full.len());
        let mid = start + (full.len() as u64) / 2;

        send_json(
            &mut ws,
            &ClientMsg::Attach {
                session_id: id,
                replay: true,
                since_offset: Some(mid),
            },
        )
        .await;
        let (resync_start, resync) = next_replay(&mut ws, id).await;
        assert_eq!(
            resync_start, mid,
            "resync must begin at the client's cursor"
        );
        let expected_tail = &full[(mid - start) as usize..];
        assert!(
            resync.starts_with(expected_tail),
            "resync payload must be the unseen tail of the ring"
        );

        // A cursor past everything the host holds: an empty replay at the end.
        send_json(
            &mut ws,
            &ClientMsg::Attach {
                session_id: id,
                replay: true,
                since_offset: Some(u64::MAX),
            },
        )
        .await;
        let (end_start, end_data) = next_replay(&mut ws, id).await;
        assert!(end_data.is_empty(), "nothing unseen means nothing to send");
        assert!(end_start >= start + full.len() as u64);

        send_json(&mut ws, &ClientMsg::CloseSession { session_id: id }).await;
        shutdown_and_drain(&mut ws).await;
    }

    /// Backward paging over the wire: each reply ends where the previous one
    /// began, and reaching the oldest stored byte sets `at_start`.
    #[tokio::test]
    async fn read_history_pages_backward_and_reports_the_start() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        {
            let mut writer = crate::history::HistoryWriter::open(tmp.path(), 5, 1024).unwrap();
            writer.append(b"0123456789").unwrap();
        }
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;

        async fn page(
            ws: &mut Ws,
            session_id: SessionId,
            before: u64,
            max: u32,
        ) -> (u64, Vec<u8>, bool) {
            send_json(
                ws,
                &ClientMsg::ReadHistory {
                    session_id,
                    before_offset: before,
                    max_bytes: max,
                },
            )
            .await;
            loop {
                if let HostMsg::History {
                    session_id: id,
                    start_offset,
                    data_b64,
                    at_start,
                } = next_json(ws).await
                {
                    assert_eq!(id, session_id);
                    return (
                        start_offset,
                        base64::engine::general_purpose::STANDARD
                            .decode(data_b64)
                            .unwrap(),
                        at_start,
                    );
                }
            }
        }

        let newest = page(&mut ws, 5, 10, 4).await;
        assert_eq!(
            (newest.0, newest.1.as_slice(), newest.2),
            (6, b"6789".as_slice(), false)
        );
        let older = page(&mut ws, 5, newest.0, 4).await;
        assert_eq!(
            (older.0, older.1.as_slice(), older.2),
            (2, b"2345".as_slice(), false)
        );
        let oldest = page(&mut ws, 5, older.0, 64).await;
        assert_eq!(
            (oldest.0, oldest.1.as_slice(), oldest.2),
            (0, b"01".as_slice(), true)
        );

        // An absurd request size is clamped, never trusted.
        let all = page(&mut ws, 5, 10, u32::MAX).await;
        assert_eq!(all.1.len(), 10);
        assert!(all.2);

        // A session the host has never heard of is not an error.
        let unknown = page(&mut ws, 4242, 999, 64).await;
        assert!(unknown.1.is_empty(), "no history is not a failure");
        assert!(unknown.2);
    }

    /// Corruption degrades to "nothing older" instead of tearing the
    /// connection down over scrollback the user can live without.
    #[tokio::test]
    async fn read_history_degrades_on_a_corrupt_spill_file() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        std::fs::create_dir_all(crate::history::history_dir(tmp.path())).unwrap();
        std::fs::write(crate::history::session_file(tmp.path(), 3), b"xx").unwrap();
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;
        send_json(
            &mut ws,
            &ClientMsg::ReadHistory {
                session_id: 3,
                before_offset: 100,
                max_bytes: 64,
            },
        )
        .await;
        match next_json(&mut ws).await {
            HostMsg::History {
                data_b64, at_start, ..
            } => {
                assert!(data_b64.is_empty());
                assert!(at_start);
            }
            other => panic!("expected History, got {other:?}"),
        }
    }

    #[test]
    fn runtime_cleanup_removes_corrupt_discovery_record() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("runtime.json");
        let ours = RuntimeInfo {
            port: 1001,
            token: "ours".into(),
            pid: 11,
            version: "1".into(),
        };
        std::fs::write(&path, "{ corrupt during runtime").unwrap();

        cleanup_runtime_if_owned(&path, &ours).unwrap();

        assert!(
            !path.exists(),
            "malformed discovery state must not poison the next launch"
        );
    }

    #[test]
    fn runtime_cleanup_reports_delete_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("runtime.json");
        let ours = RuntimeInfo {
            port: 1001,
            token: "ours".into(),
            pid: 11,
            version: "1".into(),
        };
        std::fs::write(&path, serde_json::to_string(&ours).unwrap()).unwrap();
        use std::os::windows::fs::OpenOptionsExt;
        let _file_without_delete_sharing = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0x1 | 0x2) // FILE_SHARE_READ | FILE_SHARE_WRITE
            .open(&path)
            .unwrap();

        let error = cleanup_runtime_if_owned(&path, &ours)
            .expect_err("cleanup failure must reach host shutdown");

        assert!(
            error.to_string().contains("runtime discovery state"),
            "{error:#}"
        );
    }

    #[test]
    fn runtime_cleanup_never_removes_another_hosts_record() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("runtime.json");
        let ours = RuntimeInfo {
            port: 1001,
            token: "ours".into(),
            pid: 11,
            version: "1".into(),
        };
        let winner = RuntimeInfo {
            port: 1002,
            token: "winner".into(),
            pid: 22,
            version: "1".into(),
        };
        std::fs::write(&path, serde_json::to_string(&winner).unwrap()).unwrap();

        cleanup_runtime_if_owned(&path, &ours).unwrap();

        let preserved: RuntimeInfo =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(preserved.pid, winner.pid);
        assert_eq!(preserved.token, winner.token);
    }
}
