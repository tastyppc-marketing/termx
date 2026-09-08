//! Task 3 companion runtime: early swarm mode routing against the real
//! `termx-host` binary, and the broker runtime driven through the library
//! seam. Every filesystem fixture is an exclusive retained path; every child
//! is an exactly owned, hidden, job-bounded process.

#![cfg(windows)]

mod support;

use std::ffi::OsString;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant, SystemTime};

const EXIT_SWARM_USAGE: i32 = 2;
const EXIT_SWARM_UNAVAILABLE: i32 = 3;
const CHILD_DEADLINE: Duration = Duration::from_secs(60);

fn host_exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_termx-host"))
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Files that the normal host startup path would remove or rewrite if the
/// swarm token ever fell through to ordinary startup: a rotated log older
/// than the 14-day retention window and a stray history spill file.
struct Sentinels {
    stale_log: PathBuf,
    stale_log_bytes: Vec<u8>,
    history: PathBuf,
    history_bytes: Vec<u8>,
}

fn plant_sentinels(data_dir: &Path) -> Sentinels {
    let logs = data_dir.join("logs");
    fs::create_dir_all(&logs).unwrap();
    let stale_log = logs.join("host.log.2020-01-01");
    let stale_log_bytes = b"stale rotated log sentinel\n".to_vec();
    fs::write(&stale_log, &stale_log_bytes).unwrap();
    let old = SystemTime::now() - Duration::from_secs(30 * 24 * 3600);
    fs::File::options()
        .write(true)
        .open(&stale_log)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(old))
        .unwrap();
    let history_dir = data_dir.join("history");
    fs::create_dir_all(&history_dir).unwrap();
    let history = history_dir.join("424242.bin");
    let history_bytes = b"history spill sentinel".to_vec();
    fs::write(&history, &history_bytes).unwrap();
    Sentinels {
        stale_log,
        stale_log_bytes,
        history,
        history_bytes,
    }
}

impl Sentinels {
    fn assert_intact(&self) {
        assert_eq!(
            fs::read(&self.stale_log).unwrap(),
            self.stale_log_bytes,
            "stale log sentinel must survive byte for byte"
        );
        assert_eq!(
            fs::read(&self.history).unwrap(),
            self.history_bytes,
            "history sentinel must survive byte for byte"
        );
    }

    fn evidence(&self) -> serde_json::Value {
        serde_json::json!({
            "staleLog": {
                "path": self.stale_log.display().to_string(),
                "bytes": self.stale_log_bytes.len(),
                "fnv1a64": format!("{:016x}", fnv1a64(&self.stale_log_bytes)),
            },
            "history": {
                "path": self.history.display().to_string(),
                "bytes": self.history_bytes.len(),
                "fnv1a64": format!("{:016x}", fnv1a64(&self.history_bytes)),
            },
        })
    }
}

fn list_names(dir: &Path) -> Vec<String> {
    match fs::read_dir(dir) {
        Ok(entries) => {
            let mut names = entries
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            names.sort();
            names
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => panic!("listing {}: {error}", dir.display()),
    }
}

fn assert_no_normal_host_artifacts(data_dir: &Path) {
    assert!(
        !data_dir.join("config.json").exists(),
        "config.json created"
    );
    assert!(
        !data_dir.join("runtime.json").exists(),
        "runtime.json created"
    );
    assert_eq!(
        list_names(&data_dir.join("logs")),
        vec!["host.log.2020-01-01".to_owned()],
        "normal host logging must not start"
    );
    assert_eq!(
        list_names(&data_dir.join("history")),
        vec!["424242.bin".to_owned()],
        "history sweep must not run"
    );
    assert!(
        !data_dir.join("appdata").join("TermX").exists(),
        "default data directory must never be resolved"
    );
}

struct HostRun {
    status: ExitStatus,
    stdout: String,
    stderr: String,
    elapsed: Duration,
}

impl HostRun {
    fn code(&self) -> i32 {
        self.status.code().expect("native exit code")
    }

    fn evidence(&self) -> serde_json::Value {
        serde_json::json!({
            "exitCode": self.status.code(),
            "stdout": self.stdout,
            "stderr": self.stderr,
            "elapsedMillis": self.elapsed.as_millis(),
        })
    }
}

/// Runs the real host binary as an exactly owned hidden child. `APPDATA` is
/// redirected into the fixture for this one process so even a routing bug
/// cannot resolve the user's real data directory.
fn run_host(fixture: &Path, label: &str, args: &[OsString]) -> HostRun {
    let stdout_path = fixture.join(format!("{label}.stdout.log"));
    let stderr_path = fixture.join(format!("{label}.stderr.log"));
    let mut command = Command::new(host_exe());
    command
        .args(args)
        .env("APPDATA", fixture.join("appdata"))
        .env_remove("RUST_LOG")
        .stdin(Stdio::piped())
        .stdout(Stdio::from(fs::File::create(&stdout_path).unwrap()))
        .stderr(Stdio::from(fs::File::create(&stderr_path).unwrap()));
    let started = Instant::now();
    let mut child = support::OwnedChild::spawn(&mut command, fixture, label).unwrap();
    drop(child.take_stdin());
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(
            started.elapsed() < CHILD_DEADLINE,
            "{label}: owned host child did not exit within {CHILD_DEADLINE:?}"
        );
        std::thread::sleep(Duration::from_millis(25));
    };
    HostRun {
        status,
        stdout: fs::read_to_string(&stdout_path).unwrap(),
        stderr: fs::read_to_string(&stderr_path).unwrap(),
        elapsed: started.elapsed(),
    }
}

fn args(items: &[&str]) -> Vec<OsString> {
    items.iter().map(OsString::from).collect()
}

fn write_result(fixture: &Path, name: &str, value: serde_json::Value) {
    let mut file = fs::File::create(fixture.join(name)).unwrap();
    file.write_all(serde_json::to_string_pretty(&value).unwrap().as_bytes())
        .unwrap();
}

#[test]
fn swarm_broker_mode_runs_before_cleanup_and_leaves_sentinels_intact() {
    let fixture = support::retained_dir().unwrap();
    let data_dir = fixture.path().join("data");
    fs::create_dir_all(&data_dir).unwrap();
    let sentinels = plant_sentinels(&data_dir);

    let run = run_host(
        fixture.path(),
        "broker-foreground",
        &args(&[
            "--swarm-broker",
            "--data-dir",
            data_dir.to_str().unwrap(),
            "--lifetime",
            "stdin",
        ]),
    );

    let discovery = data_dir.join("swarm").join("discovery.json");
    write_result(
        fixture.path(),
        "result.json",
        serde_json::json!({
            "case": "broker-foreground-stdin-close",
            "run": run.evidence(),
            "discoveryPublished": discovery.is_file(),
            "sentinels": sentinels.evidence(),
        }),
    );
    sentinels.assert_intact();
    assert_no_normal_host_artifacts(&data_dir);
    assert!(
        discovery.is_file(),
        "broker mode must publish discovery v2 before serving; stderr: {}",
        run.stderr
    );
    assert!(
        run.status.success(),
        "foreground broker exits cleanly once its launcher closes stdin; stderr: {}",
        run.stderr
    );
    assert!(
        run.stdout.contains("swarm-broker ready"),
        "ready marker is printed only after publication; stdout: {}",
        run.stdout
    );
}

#[test]
fn future_swarm_modes_return_unavailable_without_touching_data() {
    let fixture = support::retained_dir().unwrap();
    let data_dir = fixture.path().join("data");
    fs::create_dir_all(&data_dir).unwrap();
    let sentinels = plant_sentinels(&data_dir);
    let dir = data_dir.to_str().unwrap();

    let mcp = run_host(
        fixture.path(),
        "mcp",
        &args(&["--swarm-mcp", "--data-dir", dir]),
    );
    let cli = run_host(
        fixture.path(),
        "cli",
        &args(&["swarm", "status", "--data-dir", dir]),
    );

    write_result(
        fixture.path(),
        "result.json",
        serde_json::json!({
            "mcp": mcp.evidence(),
            "cli": cli.evidence(),
            "sentinels": sentinels.evidence(),
        }),
    );
    for (label, run) in [("--swarm-mcp", &mcp), ("swarm", &cli)] {
        assert_eq!(
            run.code(),
            EXIT_SWARM_UNAVAILABLE,
            "{label}: {}",
            run.stderr
        );
        assert!(
            run.stderr.contains("not available"),
            "{label} must say it is unavailable: {}",
            run.stderr
        );
        assert!(run.stdout.is_empty(), "{label} stdout: {}", run.stdout);
    }
    sentinels.assert_intact();
    assert_no_normal_host_artifacts(&data_dir);
    assert!(
        !data_dir.join("swarm").exists(),
        "unavailable modes create no swarm state"
    );
}

#[test]
fn malformed_and_non_unicode_swarm_arguments_never_fall_through() {
    use std::os::windows::ffi::OsStringExt;

    let fixture = support::retained_dir().unwrap();
    let data_dir = fixture.path().join("data");
    fs::create_dir_all(&data_dir).unwrap();
    let sentinels = plant_sentinels(&data_dir);
    let dir = data_dir.to_str().unwrap();

    let unknown = run_host(
        fixture.path(),
        "unknown-flag",
        &args(&["--swarm-broker", "--data-dir", dir, "--bogus"]),
    );
    let missing = run_host(
        fixture.path(),
        "missing-value",
        &args(&["--swarm-broker", "--data-dir"]),
    );
    let mut lone_surrogate = args(&["--swarm-broker", "--data-dir", dir]);
    lone_surrogate.push(OsString::from_wide(&[0xD800]));
    let non_unicode = run_host(fixture.path(), "non-unicode", &lone_surrogate);
    let mut mcp_non_unicode = args(&["--swarm-mcp"]);
    mcp_non_unicode.push(OsString::from_wide(&[0xDC00, 0x0041]));
    let mcp = run_host(fixture.path(), "mcp-non-unicode", &mcp_non_unicode);

    write_result(
        fixture.path(),
        "result.json",
        serde_json::json!({
            "unknownFlag": unknown.evidence(),
            "missingValue": missing.evidence(),
            "nonUnicode": non_unicode.evidence(),
            "mcpNonUnicode": mcp.evidence(),
            "sentinels": sentinels.evidence(),
        }),
    );
    for (label, run) in [
        ("unknown flag", &unknown),
        ("missing value", &missing),
        ("non-unicode", &non_unicode),
    ] {
        assert_eq!(run.code(), EXIT_SWARM_USAGE, "{label}: {}", run.stderr);
        assert!(
            !run.stderr.contains("unknown argument: --swarm-broker"),
            "{label} fell through to the normal host parser: {}",
            run.stderr
        );
        assert!(
            !run.stderr.contains("--bogus"),
            "{label} must not echo argv into diagnostics: {}",
            run.stderr
        );
    }
    assert_eq!(mcp.code(), EXIT_SWARM_UNAVAILABLE, "{}", mcp.stderr);
    sentinels.assert_intact();
    assert_no_normal_host_artifacts(&data_dir);
    assert!(!data_dir.join("swarm").exists());
}

#[test]
fn swarm_token_after_data_dir_is_not_a_mode() {
    let fixture = support::retained_dir().unwrap();
    let data_dir = fixture.path().join("data");
    fs::create_dir_all(&data_dir).unwrap();
    let sentinels = plant_sentinels(&data_dir);
    let dir = data_dir.to_str().unwrap();

    let run = run_host(
        fixture.path(),
        "late-token",
        &args(&["--data-dir", dir, "swarm"]),
    );

    write_result(
        fixture.path(),
        "result.json",
        serde_json::json!({ "run": run.evidence(), "sentinels": sentinels.evidence() }),
    );
    assert!(!run.status.success());
    assert!(
        run.stderr.contains("unknown argument: swarm"),
        "ordinary strict parser must reject the late token: {}",
        run.stderr
    );
    assert!(!data_dir.join("swarm").exists());
    sentinels.assert_intact();
}

#[test]
fn agent_modes_keep_precedence_over_swarm_tokens() {
    let fixture = support::retained_dir().unwrap();
    let data_dir = fixture.path().join("data");
    fs::create_dir_all(&data_dir).unwrap();
    let sentinels = plant_sentinels(&data_dir);
    let dir = data_dir.to_str().unwrap();

    let capture = run_host(
        fixture.path(),
        "capture-precedence",
        &args(&["--capture-agent", "--swarm-broker", "--data-dir", dir]),
    );

    write_result(
        fixture.path(),
        "result.json",
        serde_json::json!({ "capture": capture.evidence(), "sentinels": sentinels.evidence() }),
    );
    assert_eq!(capture.code(), 0, "capture hook is a silent interface");
    assert!(capture.stdout.is_empty());
    assert!(capture.stderr.is_empty());
    assert!(!data_dir.join("swarm").exists());
    sentinels.assert_intact();
    assert_no_normal_host_artifacts(&data_dir);
}
