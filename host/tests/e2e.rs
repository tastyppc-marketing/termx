//! Black-box test of the real binary: the M1 acceptance test.

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

fn read_runtime(dir: &std::path::Path) -> Option<Value> {
    let text = std::fs::read_to_string(dir.join("runtime.json")).ok()?;
    serde_json::from_str(&text).ok()
}

async fn ws_connect(
    port: u64,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}"))
        .await
        .expect("ws connect");
    ws
}

#[tokio::test]
async fn full_lifecycle_against_real_binary() {
    let tmp = tempfile::tempdir().unwrap();
    let exe = env!("CARGO_BIN_EXE_termx-host");
    let mut host = std::process::Command::new(exe)
        .args(["--data-dir", tmp.path().to_str().unwrap()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn termx-host");

    // Wait for runtime.json (boot signal), up to 15s.
    let rt = {
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(v) = read_runtime(tmp.path()) {
                break v;
            }
            assert!(std::time::Instant::now() < deadline, "host never wrote runtime.json");
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    };
    let port = rt["port"].as_u64().unwrap();
    let token = rt["token"].as_str().unwrap().to_string();

    async fn next_control(
        ws: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    ) -> Value {
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(30), ws.next())
                .await
                .expect("timeout")
                .expect("stream end")
                .expect("ws err");
            if let Message::Text(t) = msg {
                return serde_json::from_str(&t).unwrap();
            }
        }
    }

    // Client A: create session, write marker, die abruptly.
    let session_id = {
        let mut ws = ws_connect(port).await;
        ws.send(Message::Text(
            serde_json::json!({"type": "auth", "token": token}).to_string(),
        ))
        .await
        .unwrap();
        let auth = next_control(&mut ws).await;
        assert_eq!(auth["type"], "auth_ok", "auth reply: {auth}");
        ws.send(Message::Text(
            serde_json::json!({"type": "create_session", "profile": "cmd", "cwd": null, "cols": 100, "rows": 30})
                .to_string(),
        ))
        .await
        .unwrap();
        let created = next_control(&mut ws).await;
        assert_eq!(created["type"], "session_created", "{created}");
        let id = created["info"]["id"].as_u64().unwrap();
        // Binary input frame: tag 2 + u32 id + payload.
        let mut frame = vec![2u8];
        frame.extend_from_slice(&(id as u32).to_le_bytes());
        frame.extend_from_slice(b"echo e2e_marker_7\r\n");
        ws.send(Message::Binary(frame)).await.unwrap();
        tokio::time::sleep(Duration::from_secs(3)).await;
        id
        // dropped without close — simulated UI crash
    };

    // Client B: reattach with replay; the marker must be there.
    let mut ws = ws_connect(port).await;
    ws.send(Message::Text(
        serde_json::json!({"type": "auth", "token": token}).to_string(),
    ))
    .await
    .unwrap();
    let auth = next_control(&mut ws).await;
    assert_eq!(auth["type"], "auth_ok");
    assert!(
        auth["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"].as_u64() == Some(session_id) && s["alive"] == true),
        "session gone after client death: {auth}"
    );
    ws.send(Message::Text(
        serde_json::json!({"type": "attach", "session_id": session_id, "replay": true}).to_string(),
    ))
    .await
    .unwrap();
    let replay = loop {
        let v = next_control(&mut ws).await;
        if v["type"] == "replay" {
            break v;
        }
    };
    let bytes = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(replay["data_b64"].as_str().unwrap())
            .unwrap()
    };
    assert!(
        String::from_utf8_lossy(&bytes).contains("e2e_marker_7"),
        "replay missing marker"
    );

    // Clean shutdown: host must exit and remove runtime.json.
    ws.send(Message::Text(serde_json::json!({"type": "shutdown"}).to_string()))
        .await
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        match host.try_wait().unwrap() {
            Some(status) => {
                assert!(status.success(), "host exit status: {status:?}");
                break;
            }
            None => {
                assert!(std::time::Instant::now() < deadline, "host did not exit on Shutdown");
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
    assert!(!tmp.path().join("runtime.json").exists(), "runtime.json must be cleaned up");
}
