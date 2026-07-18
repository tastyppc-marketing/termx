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
            assert!(
                std::time::Instant::now() < deadline,
                "host never wrote runtime.json"
            );
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
    let (session_id, shell_pid) = {
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
        let shell_pid = created["info"]["pid"]
            .as_u64()
            .expect("session must report its shell pid");
        // Binary input frame: tag 2 + u32 id + payload.
        let mut frame = vec![2u8];
        frame.extend_from_slice(&(id as u32).to_le_bytes());
        frame.extend_from_slice(b"echo e2e_marker_7\r\n");
        ws.send(Message::Binary(frame)).await.unwrap();
        tokio::time::sleep(Duration::from_secs(3)).await;
        (id, shell_pid)
        // dropped without close — simulated UI crash
    };

    // Single-instance guard, POSITIVE path: a second host started against the
    // same data dir must detect the live one and bow out without touching it.
    {
        let second = std::process::Command::new(exe)
            .args(["--data-dir", tmp.path().to_str().unwrap()])
            .output()
            .expect("spawn second termx-host");
        assert!(second.status.success(), "second instance: {second:?}");
        assert!(
            String::from_utf8_lossy(&second.stdout).contains("already running"),
            "second instance must report the live host; stdout: {:?}",
            String::from_utf8_lossy(&second.stdout)
        );
        assert!(
            read_runtime(tmp.path()).map(|v| v["port"].as_u64()) == Some(Some(port)),
            "second instance must not clobber runtime.json"
        );
    }

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

    // Persist a layout, then shut down cleanly: host must exit, remove
    // runtime.json, and actually kill the shell process tree.
    ws.send(Message::Text(
        serde_json::json!({"type": "set_layout", "layout": {"e2e": "layout_v1"}}).to_string(),
    ))
    .await
    .unwrap();
    let saved = next_control(&mut ws).await;
    assert_eq!(saved["type"], "layout_saved", "{saved}");
    ws.send(Message::Text(
        serde_json::json!({"type": "shutdown"}).to_string(),
    ))
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
                assert!(
                    std::time::Instant::now() < deadline,
                    "host did not exit on Shutdown"
                );
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
    assert!(
        !tmp.path().join("runtime.json").exists(),
        "runtime.json must be cleaned up"
    );

    // The shell tree must be dead — an orphaned cmd.exe would violate the
    // stability requirement the daemon exists for.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {shell_pid}"), "/FO", "CSV", "/NH"])
            .output()
            .expect("tasklist");
        if !String::from_utf8_lossy(&out.stdout)
            .to_ascii_lowercase()
            .contains("cmd.exe")
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "shell pid {shell_pid} still alive after host shutdown"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    // Restart continuity: a fresh host on the same data dir must serve the
    // persisted layout and never recycle session ids.
    let mut host2 = std::process::Command::new(exe)
        .args(["--data-dir", tmp.path().to_str().unwrap()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("respawn termx-host");
    let rt2 = {
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(v) = read_runtime(tmp.path()) {
                break v;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "restarted host never wrote runtime.json"
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    };
    let mut ws2 = ws_connect(rt2["port"].as_u64().unwrap()).await;
    ws2.send(Message::Text(
        serde_json::json!({"type": "auth", "token": rt2["token"].as_str().unwrap()}).to_string(),
    ))
    .await
    .unwrap();
    assert_eq!(next_control(&mut ws2).await["type"], "auth_ok");
    ws2.send(Message::Text(
        serde_json::json!({"type": "get_state"}).to_string(),
    ))
    .await
    .unwrap();
    let state = loop {
        let v = next_control(&mut ws2).await;
        if v["type"] == "state" {
            break v;
        }
    };
    assert_eq!(
        state["layout"]["e2e"], "layout_v1",
        "layout must survive a daemon restart: {state}"
    );
    ws2.send(Message::Text(
        serde_json::json!({"type": "create_session", "profile": "cmd", "cwd": null, "cols": 80, "rows": 25})
            .to_string(),
    ))
    .await
    .unwrap();
    let created2 = loop {
        let v = next_control(&mut ws2).await;
        if v["type"] == "session_created" {
            break v;
        }
    };
    assert!(
        created2["info"]["id"].as_u64().unwrap() > session_id,
        "session ids must not recycle across restarts: {created2}"
    );
    ws2.send(Message::Text(
        serde_json::json!({"type": "shutdown"}).to_string(),
    ))
    .await
    .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while host2.try_wait().unwrap().is_none() {
        assert!(
            std::time::Instant::now() < deadline,
            "restarted host did not exit on Shutdown"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}
