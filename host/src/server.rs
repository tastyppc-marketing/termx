//! WS server: auth gate, control dispatch, binary I/O pump, attach/replay.

use crate::protocol::{self, ClientMsg, Frame, HostMsg, SessionId};
use crate::registry::Registry;
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
        (0..32).map(|_| format!("{:x}", rng.gen_range(0..16u8))).collect()
    };
    let info = RuntimeInfo {
        port,
        token: token.clone(),
        pid: std::process::id(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    };
    let runtime_path = crate::paths::runtime_file(&data_dir);
    std::fs::write(&runtime_path, serde_json::to_string_pretty(&info)?)
        .with_context(|| format!("writing {}", runtime_path.display()))?;
    let _ = ready.send(info);

    let mut shutdown_rx = shutdown.subscribe();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _addr) = accepted.context("accept")?;
                let reg = Arc::clone(&registry);
                let tok = token.clone();
                let sd = shutdown.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_conn(stream, reg, tok, sd).await {
                        tracing::debug!("connection ended: {e:#}");
                    }
                });
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

async fn handle_conn(
    stream: TcpStream,
    registry: Arc<Registry>,
    token: String,
    shutdown: tokio::sync::watch::Sender<bool>,
) -> Result<()> {
    let ws = tokio_tungstenite::accept_async(stream).await.context("ws accept")?;
    let (mut tx, mut rx) = ws.split();

    // ---- Auth gate: first message, 5s budget ----
    let first = tokio::time::timeout(std::time::Duration::from_secs(5), rx.next())
        .await
        .ok()
        .flatten()
        .and_then(|r| r.ok());
    let authed = matches!(
        first.as_ref().and_then(|m| m.to_text().ok())
            .and_then(|t| serde_json::from_str::<ClientMsg>(t).ok()),
        Some(ClientMsg::Auth { token: ref t }) if *t == token
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
    // Outbound is bounded; ring stays authoritative and a laggard client
    // resyncs via replay, so dropping THIS client's frames is safe.
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
                        let _ = out_tx
                            .send(Message::Text(serde_json::to_string(&HostMsg::Error {
                                context: "parse".into(),
                                message: e.to_string(),
                            })?))
                            .await;
                        continue;
                    }
                };
                match parsed {
                    ClientMsg::Auth { .. } => {} // already authed; ignore
                    ClientMsg::CreateSession { profile, cwd, cols, rows } => {
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
                        let _ = out_tx.send(Message::Text(serde_json::to_string(&reply)?)).await;
                    }
                    ClientMsg::Attach { session_id, replay } => {
                        let Some(session) = registry.get(session_id) else {
                            let _ = out_tx
                                .send(Message::Text(serde_json::to_string(&HostMsg::Error {
                                    context: "attach".into(),
                                    message: format!("no session {session_id}"),
                                })?))
                                .await;
                            continue;
                        };
                        // Subscribe FIRST, then snapshot: no gap between replay and live.
                        let mut chunk_rx = session.subscribe();
                        let (start_offset, bytes) = session.snapshot();
                        let replay_end = start_offset + bytes.len() as u64;
                        if replay {
                            let _ = out_tx
                                .send(Message::Text(serde_json::to_string(&HostMsg::Replay {
                                    session_id,
                                    start_offset,
                                    data_b64: base64::engine::general_purpose::STANDARD
                                        .encode(&bytes),
                                })?))
                                .await;
                        }
                        let fwd_out = out_tx.clone();
                        let session_for_fwd = Arc::clone(&session);
                        let handle = tokio::spawn(async move {
                            loop {
                                match chunk_rx.recv().await {
                                    Ok(chunk) => {
                                        let end = chunk.offset + chunk.data.len() as u64;
                                        if end <= replay_end {
                                            continue; // already covered by replay
                                        }
                                        let frame = protocol::encode_frame(&Frame::Output {
                                            session_id,
                                            offset: chunk.offset,
                                            data: chunk.data.to_vec(),
                                        });
                                        if fwd_out.send(Message::Binary(frame)).await.is_err() {
                                            break;
                                        }
                                    }
                                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                                        // Bounded-memory path: resend authoritative ring.
                                        let (start_offset, bytes) = session_for_fwd.snapshot();
                                        let msg = HostMsg::Replay {
                                            session_id,
                                            start_offset,
                                            data_b64: base64::engine::general_purpose::STANDARD
                                                .encode(&bytes),
                                        };
                                        if let Ok(text) = serde_json::to_string(&msg) {
                                            if fwd_out.send(Message::Text(text)).await.is_err() {
                                                break;
                                            }
                                        }
                                    }
                                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                                }
                            }
                        });
                        if let Some(old) = forwarders.insert(session_id, handle) {
                            old.abort();
                        }
                    }
                    ClientMsg::Detach { session_id } => {
                        if let Some(handle) = forwarders.remove(&session_id) {
                            handle.abort();
                        }
                    }
                    ClientMsg::Resize { session_id, cols, rows } => {
                        if let Some(session) = registry.get(session_id) {
                            let _ = session.resize(cols, rows);
                        }
                    }
                    ClientMsg::CloseSession { session_id } => {
                        if let Some(handle) = forwarders.remove(&session_id) {
                            handle.abort();
                        }
                        registry.close_session(session_id);
                        let _ = out_tx
                            .send(Message::Text(serde_json::to_string(&HostMsg::SessionClosed {
                                session_id,
                            })?))
                            .await;
                    }
                    ClientMsg::ListSessions => {
                        let _ = out_tx
                            .send(Message::Text(serde_json::to_string(&HostMsg::Sessions {
                                sessions: registry.list(),
                            })?))
                            .await;
                    }
                    ClientMsg::SetLayout { layout } => {
                        registry.set_layout(layout);
                    }
                    ClientMsg::GetState => {
                        let _ = out_tx
                            .send(Message::Text(serde_json::to_string(&HostMsg::State {
                                layout: registry.layout(),
                                sessions: registry.list(),
                            })?))
                            .await;
                    }
                    ClientMsg::Shutdown => {
                        registry.shutdown_all();
                        let _ = shutdown.send(true);
                        break;
                    }
                }
            }
            Message::Binary(buf) => {
                if let Ok(Frame::Input { session_id, data }) = protocol::decode_frame(&buf) {
                    if let Some(session) = registry.get(session_id) {
                        let _ = session.write_input(&data);
                    }
                }
            }
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

    async fn connect(
        rt: &RuntimeInfo,
    ) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>> {
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{}", rt.port))
            .await
            .expect("connect");
        ws
    }

    async fn send_json(
        ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
        msg: &ClientMsg,
    ) {
        ws.send(Message::Text(serde_json::to_string(msg).unwrap()))
            .await
            .unwrap();
    }

    /// Reads messages until a JSON control message arrives; panics on close.
    async fn next_json(
        ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
    ) -> HostMsg {
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

    #[tokio::test]
    async fn bad_token_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        send_json(&mut ws, &ClientMsg::Auth { token: "wrong".into() }).await;
        match next_json(&mut ws).await {
            HostMsg::AuthErr { .. } => {}
            other => panic!("expected AuthErr, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn auth_create_echo_binary_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let (rt, _sd) = boot(tmp.path()).await;
        let mut ws = connect(&rt).await;
        send_json(&mut ws, &ClientMsg::Auth { token: rt.token.clone() }).await;
        assert!(matches!(next_json(&mut ws).await, HostMsg::AuthOk { .. }));

        send_json(
            &mut ws,
            &ClientMsg::CreateSession { profile: Some("cmd".into()), cwd: None, cols: 100, rows: 30 },
        )
        .await;
        let id: SessionId = match next_json(&mut ws).await {
            HostMsg::SessionCreated { info } => info.id,
            other => panic!("expected SessionCreated, got {other:?}"),
        };

        send_json(&mut ws, &ClientMsg::Attach { session_id: id, replay: false }).await;
        ws.send(Message::Binary(protocol::encode_frame(&Frame::Input {
            session_id: id,
            data: b"echo ws_marker_42\r\n".to_vec(),
        })))
        .await
        .unwrap();

        // Pump frames until the marker shows up in Output frames.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut seen = String::new();
        while std::time::Instant::now() < deadline && !seen.contains("ws_marker_42") {
            match tokio::time::timeout(std::time::Duration::from_secs(5), ws.next()).await {
                Ok(Some(Ok(Message::Binary(buf)))) => {
                    if let Ok(Frame::Output { session_id, data, .. }) = protocol::decode_frame(&buf) {
                        assert_eq!(session_id, id);
                        seen.push_str(&String::from_utf8_lossy(&data));
                    }
                }
                Ok(Some(Ok(_))) => continue,
                _ => break,
            }
        }
        assert!(seen.contains("ws_marker_42"), "no echo over WS; saw: {seen:?}");

        send_json(&mut ws, &ClientMsg::CloseSession { session_id: id }).await;
        loop {
            match next_json(&mut ws).await {
                HostMsg::SessionClosed { .. } => break,
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
            send_json(&mut ws_a, &ClientMsg::Auth { token: rt.token.clone() }).await;
            assert!(matches!(next_json(&mut ws_a).await, HostMsg::AuthOk { .. }));
            send_json(
                &mut ws_a,
                &ClientMsg::CreateSession { profile: Some("cmd".into()), cwd: None, cols: 100, rows: 30 },
            )
            .await;
            let id = match next_json(&mut ws_a).await {
                HostMsg::SessionCreated { info } => info.id,
                other => panic!("expected SessionCreated, got {other:?}"),
            };
            ws_a.send(Message::Binary(protocol::encode_frame(&Frame::Input {
                session_id: id,
                data: b"echo survive_marker_99\r\n".to_vec(),
            })))
            .await
            .unwrap();
            // Give the shell a moment to execute so the marker lands in the ring.
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            id
            // ws_a dropped HERE without Detach/Close — simulates a UI crash.
        };

        // Client B: fresh connection, attach with replay, expect the marker.
        let mut ws_b = connect(&rt).await;
        send_json(&mut ws_b, &ClientMsg::Auth { token: rt.token.clone() }).await;
        let sessions = match next_json(&mut ws_b).await {
            HostMsg::AuthOk { sessions, .. } => sessions,
            other => panic!("expected AuthOk, got {other:?}"),
        };
        assert!(
            sessions.iter().any(|s| s.id == id && s.alive),
            "session must still be alive after client A died: {sessions:?}"
        );
        send_json(&mut ws_b, &ClientMsg::Attach { session_id: id, replay: true }).await;
        let replayed = loop {
            match next_json(&mut ws_b).await {
                HostMsg::Replay { session_id, data_b64, .. } => {
                    assert_eq!(session_id, id);
                    break String::from_utf8_lossy(
                        &base64::engine::general_purpose::STANDARD.decode(data_b64).unwrap(),
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
