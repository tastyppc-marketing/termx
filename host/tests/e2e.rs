//! Black-box test of the real binary: the M1 acceptance test.

mod support;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

#[test]
fn retained_test_directories_are_unique_and_survive_drop() {
    let first = support::retained_dir().expect("first retained directory");
    let second = support::retained_dir().expect("second retained directory");
    assert_ne!(first.path(), second.path());
    assert!(
        !first
            .path()
            .as_os_str()
            .to_string_lossy()
            .starts_with(r"\\?\"),
        "test-facing paths must remain usable as cmd.exe working directories"
    );
    let first_path = first.path().to_path_buf();
    std::fs::write(first.path().join("survives.txt"), b"retained bytes").unwrap();

    drop(first);

    assert_eq!(
        std::fs::read(first_path.join("survives.txt")).unwrap(),
        b"retained bytes"
    );
}

#[test]
fn retained_snapshot_rejects_sources_outside_the_owned_fixture_root() {
    let outside = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let error = support::snapshot_fixture_tree(&outside, "forbidden-escape")
        .err()
        .expect("an external source must be rejected");
    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
}

#[test]
fn retained_snapshot_rejects_reparse_entries_without_following_them() {
    let fixture = support::retained_dir().unwrap();
    let outside = support::retained_dir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), b"outside bytes").unwrap();
    let link = fixture.path().join("linked-outside");
    std::os::windows::fs::symlink_dir(outside.path(), &link)
        .expect("create owned directory symlink fixture");

    let error = support::snapshot_fixture_tree(fixture.path(), "linked-tree")
        .err()
        .expect("a reparse entry must be rejected");

    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    assert_eq!(
        std::fs::read(outside.path().join("secret.txt")).unwrap(),
        b"outside bytes"
    );
}

#[test]
fn retained_snapshot_rejects_an_aliased_source_root_before_resolution() {
    let fixture = support::retained_dir().unwrap();
    let source = fixture.path().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("subject.txt"), b"aliased bytes").unwrap();
    let alias = fixture.path().join("source-alias");
    std::os::windows::fs::symlink_dir(&source, &alias).unwrap();

    let error = support::snapshot_fixture_tree(&alias, "aliased-source-root")
        .err()
        .expect("the original reparse root must be rejected before canonicalization");

    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    assert_eq!(
        std::fs::read(source.join("subject.txt")).unwrap(),
        b"aliased bytes"
    );
}

#[test]
fn retained_snapshot_copies_only_the_owned_fixture_tree() {
    let fixture = support::retained_dir().unwrap();
    std::fs::create_dir(fixture.path().join("nested")).unwrap();
    std::fs::write(fixture.path().join("root.txt"), b"root bytes").unwrap();
    std::fs::write(fixture.path().join("nested/child.txt"), b"child bytes").unwrap();

    let snapshot = support::snapshot_fixture_tree(fixture.path(), "positive-copy").unwrap();

    assert_eq!(
        std::fs::read(snapshot.path().join("root.txt")).unwrap(),
        b"root bytes"
    );
    assert_eq!(
        std::fs::read(snapshot.path().join("nested/child.txt")).unwrap(),
        b"child bytes"
    );
}

#[test]
fn cleanup_subject_is_preserved_before_the_working_copy_is_removed() {
    let fixture = support::retained_dir().unwrap();
    let subject = fixture.path().join("history.bin");
    std::fs::write(&subject, b"history before cleanup").unwrap();

    let retained = support::preserve_file_before_remove(&subject, "history-delete-test").unwrap();
    std::fs::remove_file(&subject).unwrap();

    assert!(!subject.exists(), "the synthetic working copy was removed");
    assert_eq!(std::fs::read(retained).unwrap(), b"history before cleanup");
}

#[test]
fn pre_removal_gate_preserves_regular_refuses_reparse_and_keeps_plain_directory_semantics() {
    let fixture = support::retained_dir().unwrap();
    let regular = fixture.path().join("regular.bin");
    std::fs::write(&regular, b"regular bytes").unwrap();
    support::preserve_before_remove_if_needed(&regular, "regular-gate").unwrap();
    std::fs::remove_file(&regular).unwrap();
    assert!(!regular.exists());

    support::preserve_before_remove_if_needed(&fixture.path().join("missing.bin"), "missing-gate")
        .unwrap();

    let directory = fixture.path().join("plain-directory");
    std::fs::create_dir(&directory).unwrap();
    support::preserve_before_remove_if_needed(&directory, "directory-gate").unwrap();
    std::fs::remove_file(&directory)
        .expect_err("the production remove_file semantics still reject a plain directory");
    assert!(directory.is_dir());

    let alias = fixture.path().join("directory-alias");
    std::os::windows::fs::symlink_dir(&directory, &alias).unwrap();
    let error = support::preserve_before_remove_if_needed(&alias, "reparse-gate")
        .expect_err("a reparse cleanup subject must stop removal");
    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    assert!(alias.exists());
    assert!(directory.is_dir());
}

#[test]
fn startup_cleanup_diagnostic_keeps_primary_identity_and_every_cleanup_failure() {
    let failures = vec![
        "terminating exact child job failed: access denied".to_owned(),
        "exact child stayed active past startup-cleanup deadline".to_owned(),
    ];

    let diagnostic = support::format_startup_cleanup_diagnostic_for_test(
        "controlled-child",
        4242,
        "resuming assigned child",
        "thread disappeared",
        &failures,
    );

    assert!(diagnostic.contains("label=controlled-child"));
    assert!(diagnostic.contains("pid=4242"));
    assert!(diagnostic.contains("stage=resuming assigned child"));
    assert!(diagnostic.contains("primary=thread disappeared"));
    for failure in failures {
        assert!(diagnostic.contains(&failure));
    }
}

#[test]
fn explicit_test_file_retirement_moves_only_the_named_subject() {
    let fixture = support::retained_dir().unwrap();
    let subject = fixture.path().join("state.json");
    let sibling = fixture.path().join("unrelated.txt");
    std::fs::write(&subject, b"durable state").unwrap();
    std::fs::write(&sibling, b"leave me").unwrap();

    let retained = support::retire_file(&subject, "state-failure-fixture").unwrap();

    assert!(!subject.exists());
    assert_eq!(std::fs::read(retained).unwrap(), b"durable state");
    assert_eq!(std::fs::read(sibling).unwrap(), b"leave me");
}

#[test]
fn bounded_reader_rejects_growth_after_the_source_handle_is_opened() {
    let fixture = support::retained_dir().unwrap();
    let subject = fixture.path().join("growing.bin");
    std::fs::write(&subject, b"1234").unwrap();

    let error = support::read_owned_file_bounded_for_test(&subject, 4, || {
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&subject)
            .unwrap();
        use std::io::Write;
        file.write_all(b"5").unwrap();
        file.sync_all().unwrap();
    })
    .expect_err("growth after open must cross the actual capped read");

    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert_eq!(std::fs::read(&subject).unwrap(), b"12345");
}

#[test]
fn owned_child_drop_terminates_and_reaps_only_its_assigned_job() {
    let fixture = support::retained_dir().unwrap();
    let ready = fixture.path().join("target-ready.txt");
    let script = fixture.path().join("target.ps1");
    std::fs::write(
        &script,
        r#"param([string]$Ready)
$descendant = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-Command','while ($true) { Start-Sleep -Seconds 60 }') -WindowStyle Hidden -PassThru
[IO.File]::WriteAllText($Ready, "$PID,$($descendant.Id)")
Wait-Process -Id $descendant.Id
"#,
    )
    .unwrap();
    let mut target_command = std::process::Command::new("powershell.exe");
    target_command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        script.to_str().unwrap(),
        "-Ready",
        ready.to_str().unwrap(),
    ]);
    let target = support::OwnedChild::spawn(
        &mut target_command,
        fixture.path(),
        "target-with-descendant",
    )
    .expect("spawn suspended target, assign its exact job, then resume it");
    let target_probe = target.process_probe().unwrap();

    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !ready.is_file() {
        assert!(
            std::time::Instant::now() < deadline,
            "target never confirmed descendant startup"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let identities = std::fs::read_to_string(&ready).unwrap();
    let mut identities = identities.trim().split(',');
    assert_eq!(
        identities.next().unwrap().parse::<u32>().unwrap(),
        target.id()
    );
    let descendant_pid = identities.next().unwrap().parse::<u32>().unwrap();
    assert!(identities.next().is_none());
    let descendant_probe = support::ProcessProbe::open(descendant_pid).unwrap();

    let mut unrelated_command = std::process::Command::new("powershell.exe");
    unrelated_command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "while ($true) { Start-Sleep -Seconds 60 }",
    ]);
    let unrelated = support::OwnedChild::spawn(
        &mut unrelated_command,
        fixture.path(),
        "separately-owned-unrelated",
    )
    .unwrap();
    let unrelated_probe = unrelated.process_probe().unwrap();
    assert!(!target_probe.exited().unwrap());
    assert!(!descendant_probe.exited().unwrap());
    assert!(!unrelated_probe.exited().unwrap());

    drop(target);

    assert!(
        target_probe.wait_exited(Duration::from_secs(1)).unwrap(),
        "exact target handle stayed live"
    );
    assert!(
        descendant_probe
            .wait_exited(Duration::from_secs(1))
            .unwrap(),
        "assigned descendant handle stayed live"
    );
    assert!(
        !unrelated_probe.exited().unwrap(),
        "terminating the target job touched a separately owned process"
    );
    drop(unrelated);
    assert!(
        unrelated_probe.wait_exited(Duration::from_secs(1)).unwrap(),
        "the unrelated guard did not reap its own exact handle"
    );
}

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

#[test]
fn malformed_runtime_error_is_written_to_host_log() {
    let tmp = support::retained_dir().unwrap();
    std::fs::write(tmp.path().join("runtime.json"), "{ not json").unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_termx-host"))
        .args(["--data-dir", tmp.path().to_str().unwrap()])
        .output()
        .expect("spawn termx-host");
    assert!(
        !output.status.success(),
        "malformed runtime must fail closed"
    );

    let logs = tmp.path().join("logs");
    let text = std::fs::read_dir(&logs)
        .expect("logs dir")
        .flatten()
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
        .collect::<String>();
    assert!(
        text.contains("parsing") && text.contains("runtime.json"),
        "discovery failure must survive discarded stderr; logs: {text:?}"
    );
}

#[test]
fn fatal_config_error_is_written_to_host_log() {
    let tmp = support::retained_dir().unwrap();
    std::fs::write(tmp.path().join("config.json"), "{ not json").unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_termx-host"))
        .args(["--data-dir", tmp.path().to_str().unwrap()])
        .output()
        .expect("spawn termx-host");
    assert!(
        !output.status.success(),
        "malformed config must fail startup"
    );

    let logs = tmp.path().join("logs");
    let text = std::fs::read_dir(&logs)
        .expect("logs dir")
        .flatten()
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
        .collect::<String>();
    assert!(
        text.contains("parsing") && text.contains("config.json"),
        "fatal startup cause must survive discarded stderr; logs: {text:?}"
    );
}

#[tokio::test]
async fn full_lifecycle_against_real_binary() {
    let tmp = support::retained_dir().unwrap();
    let exe = env!("CARGO_BIN_EXE_termx-host");
    let mut host_command = std::process::Command::new(exe);
    host_command
        .args(["--data-dir", tmp.path().to_str().unwrap()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let mut host = support::OwnedChild::spawn(&mut host_command, tmp.path(), "primary-host")
        .expect("spawn termx-host in exact owned job");

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
    support::preserve_file_before_remove(
        &tmp.path().join("runtime.json"),
        "primary-runtime-before-shutdown",
    )
    .unwrap();
    support::preserve_file_before_remove(
        &tmp.path().join("state.json"),
        "primary-state-before-shutdown",
    )
    .unwrap();
    support::preserve_file_before_remove(
        &termx_host::history::session_file(tmp.path(), session_id.try_into().unwrap()),
        "primary-history-before-shutdown",
    )
    .unwrap();
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
    let _between_hosts =
        support::snapshot_fixture_tree(tmp.path(), "between-primary-and-restart").unwrap();
    let mut host2_command = std::process::Command::new(exe);
    host2_command
        .args(["--data-dir", tmp.path().to_str().unwrap()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let mut host2 = support::OwnedChild::spawn(&mut host2_command, tmp.path(), "restart-host")
        .expect("respawn termx-host in exact owned job");
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
    support::preserve_file_before_remove(
        &tmp.path().join("runtime.json"),
        "restart-runtime-before-shutdown",
    )
    .unwrap();
    support::preserve_file_before_remove(
        &tmp.path().join("state.json"),
        "restart-state-before-shutdown",
    )
    .unwrap();
    let restarted_session_id = created2["info"]["id"].as_u64().unwrap();
    support::preserve_file_before_remove(
        &termx_host::history::session_file(tmp.path(), restarted_session_id.try_into().unwrap()),
        "restart-history-before-shutdown",
    )
    .unwrap();
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
