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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuntimeInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub version: String,
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
    let _ = ready.send(info);

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
                    let _ = std::fs::remove_file(&runtime_path);
                    tracing::info!("shutdown requested; exiting accept loop");
                    return Ok(());
                }
            }
        }
    }
}

/// Send a JSON control message into a connection's outbound queue.
async fn send_ctl(out_tx: &tokio::sync::mpsc::Sender<Message>, msg: &HostMsg) {
    if let Ok(text) = serde_json::to_string(msg) {
        let _ = out_tx.send(Message::Text(text)).await;
    }
}

fn replay_msg(session_id: SessionId, session: &Session) -> (HostMsg, u64) {
    let (start_offset, bytes) = session.snapshot();
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
async fn forward_session(
    session_id: SessionId,
    session: Arc<Session>,
    mut chunk_rx: tokio::sync::broadcast::Receiver<crate::session::OutputChunk>,
    mut exit_rx: tokio::sync::watch::Receiver<crate::session::ExitState>,
    mut replay_end: u64,
    out_tx: tokio::sync::mpsc::Sender<Message>,
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
                    if out_tx.send(Message::Binary(frame)).await.is_err() {
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
                    let (msg, end) = replay_msg(session_id, &session);
                    if let Ok(text) = serde_json::to_string(&msg) {
                        if out_tx.send(Message::Text(text)).await.is_err() {
                            return; // connection gone
                        }
                        replay_end = end;
                    }
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
                let (msg, end) = replay_msg(session_id, &session);
                if let Ok(text) = serde_json::to_string(&msg) {
                    if out_tx.send(Message::Text(text)).await.is_err() {
                        return;
                    }
                    replay_end = end;
                }
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
                if out_tx.send(Message::Binary(frame)).await.is_err() {
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

async fn handle_conn(
    stream: TcpStream,
    registry: Arc<Registry>,
    token: String,
    shutdown: tokio::sync::watch::Sender<bool>,
) -> Result<()> {
    // A half-open TCP connection must not park an accept task forever.
    let ws = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio_tungstenite::accept_async(stream),
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
    // Count-bounded. Steady-state items are <=8KiB frames (~2MiB at cap);
    // replays can be up to scrollback_bytes each, but every producer awaits
    // its sends, so at any instant the queue holds at most a handful of
    // replays (attach bursts / lag resyncs) — bounded in practice by
    // sessions x scrollback, the same order as the rings themselves.
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Message>(256);

    // Writer half: single task owns `tx`.
    let writer = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if tx.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Per-attached-session forwarder tasks, aborted on Detach/socket end.
    let mut forwarders: std::collections::HashMap<SessionId, tokio::task::JoinHandle<()>> =
        std::collections::HashMap::new();

    while let Some(msg) = rx.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(_) => break,
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
                    } => {
                        let result = registry.create_session(
                            profile.as_deref(),
                            cwd.as_deref().map(std::path::Path::new),
                            cols,
                            rows,
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
                    ClientMsg::Attach { session_id, replay } => {
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
                        let (msg, replay_end) = replay_msg(session_id, &session);
                        if replay {
                            send_ctl(&out_tx, &msg).await;
                        }
                        let handle = tokio::spawn(forward_session(
                            session_id,
                            session,
                            chunk_rx,
                            exit_rx,
                            replay_end,
                            out_tx.clone(),
                            Arc::clone(&registry),
                        ));
                        forwarders.insert(session_id, handle);
                    }
                    ClientMsg::Detach { session_id } => {
                        if let Some(handle) = forwarders.remove(&session_id) {
                            handle.abort();
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
                        break;
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
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Client gone: tear down THIS client's forwarders. Sessions keep running.
    for (_, handle) in forwarders.drain() {
        handle.abort();
    }
    writer.abort();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

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

    async fn create_cmd(ws: &mut Ws) -> SessionId {
        send_json(
            ws,
            &ClientMsg::CreateSession {
                profile: Some("cmd".into()),
                cwd: None,
                cols: 100,
                rows: 30,
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
    }

    #[tokio::test]
    async fn attach_mid_stream_delivers_gapless_coverage() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;
        let id = create_cmd(&mut ws).await;
        // Start a firehose, let it run, THEN attach — the replay snapshot and
        // the broadcast subscription race live output here.
        ws.send(input_frame(
            id,
            b"for /L %i in (1,1,3000) do @echo gap_%i\r\n",
        ))
        .await
        .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        send_json(
            &mut ws,
            &ClientMsg::Attach {
                session_id: id,
                replay: true,
            },
        )
        .await;

        let mut intervals: Vec<(u64, u64)> = Vec::new();
        let mut first_replay_start: Option<u64> = None;
        let mut text = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while std::time::Instant::now() < deadline && !text.contains("gap_3000") {
            match tokio::time::timeout(std::time::Duration::from_secs(10), ws.next()).await {
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
                _ => break,
            }
        }
        assert!(
            text.contains("gap_3000"),
            "firehose tail never arrived; got {} bytes",
            text.len()
        );
        let from = first_replay_start.expect("a replay must have been delivered");
        let to = intervals.iter().map(|&(_, e)| e).max().unwrap();
        assert_no_holes(&mut intervals, from, to);
        send_json(&mut ws, &ClientMsg::CloseSession { session_id: id }).await;
    }

    #[tokio::test]
    async fn reattach_never_delivers_stale_covered_frames() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        auth(&mut ws, &rt).await;
        let id = create_cmd(&mut ws).await;
        ws.send(input_frame(
            id,
            b"for /L %i in (1,1,3000) do @echo re_%i\r\n",
        ))
        .await
        .unwrap();
        send_json(
            &mut ws,
            &ClientMsg::Attach {
                session_id: id,
                replay: true,
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
        // Direct forward_session harness: a broadcast capacity of 2 plus a
        // deliberately slow consumer forces the Lagged path deterministically.
        let profile = crate::profiles::resolve("cmd").unwrap();
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
        let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Message>(2);
        let fwd = tokio::spawn(forward_session(
            1,
            Arc::clone(&session),
            chunk_rx,
            exit_rx,
            replay_end,
            out_tx,
            Arc::clone(&reg),
        ));
        let mut lag_replays = 0u32;
        let mut exited = false;
        while let Some(msg) = out_rx.recv().await {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await; // slow client
            match msg {
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
    async fn runtime_json_is_written_and_valid() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let text = std::fs::read_to_string(tmp.path().join("runtime.json")).unwrap();
        let parsed: RuntimeInfo = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed.port, rt.port);
        assert_eq!(parsed.token, rt.token);
        assert_eq!(parsed.pid, std::process::id());
    }
}
