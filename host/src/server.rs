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
async fn forward_session(
    session_id: SessionId,
    session: Arc<Session>,
    mut replay_end: u64,
    out_tx: tokio::sync::mpsc::Sender<Message>,
    registry: Arc<Registry>,
) {
    let mut chunk_rx = session.subscribe();
    let mut exit_rx = session.subscribe_exit();
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
                    // Bounded-memory path: resend the authoritative ring and
                    // ADVANCE the horizon so already-replayed bytes are not
                    // duplicated by chunks still in the broadcast buffer.
                    let (msg, end) = replay_msg(session_id, &session);
                    replay_end = end;
                    if let Ok(text) = serde_json::to_string(&msg) {
                        // try_send: if this client's queue is full it is
                        // already drowning — skip; a later Lagged resyncs.
                        match out_tx.try_send(Message::Text(text)) {
                            Ok(()) => {}
                            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                                tracing::debug!("lag-replay skipped: client queue full");
                            }
                            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => return,
                        }
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
    // tail after the child dies).
    while let Ok(Ok(chunk)) =
        tokio::time::timeout(std::time::Duration::from_millis(300), chunk_rx.recv()).await
    {
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
    // Bounded by count; every frame is <=8KB and lag-replays use try_send, so
    // worst-case queue memory is bounded too.
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Message>(1024);

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
                        // Abort any previous forwarder FIRST so its stale
                        // frames can't land after the fresh replay.
                        if let Some(old) = forwarders.remove(&session_id) {
                            old.abort();
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
                        // Subscribe (inside forward_session) happens before
                        // the snapshot horizon is used for dedupe, so there is
                        // no replay/live gap; chunks straddling the horizon
                        // are skipped only when FULLY covered by the replay.
                        let (msg, replay_end) = replay_msg(session_id, &session);
                        if replay {
                            send_ctl(&out_tx, &msg).await;
                        }
                        let handle = tokio::spawn(forward_session(
                            session_id,
                            session,
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
                    } => match registry.get(session_id) {
                        Some(session) => match session.resize(cols, rows) {
                            Ok(()) => registry.update_dims(session_id, cols, rows),
                            Err(e) => {
                                send_ctl(
                                    &out_tx,
                                    &HostMsg::Error {
                                        context: "resize".into(),
                                        message: format!("{e:#}"),
                                    },
                                )
                                .await;
                            }
                        },
                        None => {
                            send_ctl(
                                &out_tx,
                                &HostMsg::Error {
                                    context: "resize".into(),
                                    message: format!("no session {session_id}"),
                                },
                            )
                            .await;
                        }
                    },
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
                        registry.set_layout(layout);
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
