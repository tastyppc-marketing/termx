//! Compile-fail restrictions plus positive neighboring controls.
//!
//! These invoke `rustc` directly against the already-built package rlib. The
//! recorded status is the rustc process WaitForExit, not a pipeline wrapper.
//! Fixture outputs go to exclusive retained subdirectories so prior evidence
//! is never overwritten. The linked rlib is the newest matching artifact in
//! this test's deps directory; a fresh CARGO_TARGET_DIR makes that unique.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn deps_dir() -> PathBuf {
    std::env::current_exe()
        .expect("test exe")
        .parent()
        .expect("deps dir")
        .to_path_buf()
}

fn find_rlib(deps: &Path, crate_name: &str) -> PathBuf {
    let prefix = format!("lib{crate_name}-");
    let mut matches: Vec<(PathBuf, SystemTime)> = fs::read_dir(deps)
        .unwrap_or_else(|err| panic!("read {}: {err}", deps.display()))
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            name.starts_with(&prefix) && name.ends_with(".rlib")
        })
        .map(|path| {
            let modified = fs::metadata(&path)
                .and_then(|meta| meta.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            (path, modified)
        })
        .collect();
    matches.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    match matches.as_slice() {
        [] => panic!("missing rlib for {crate_name} in {}", deps.display()),
        [(path, _)] => path.clone(),
        more => more[0].0.clone(),
    }
}

fn unique_out_dir(name: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let pid = std::process::id();
    let base = match std::env::var_os("TERMX_PROTOCOL_UI_OUT") {
        Some(path) => PathBuf::from(path),
        None => {
            let target = std::env::var_os("CARGO_TARGET_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| deps_dir().join(".."));
            target.join("protocol-ui-runs")
        }
    };
    let out = base.join(format!("{stamp}-{pid}-{name}"));
    fs::create_dir_all(&out).expect("ui out dir");
    out
}

fn rustc() -> Command {
    let mut cmd = Command::new("rustc");
    cmd.arg("--edition").arg("2021");
    cmd.arg("--error-format").arg("short");
    cmd
}

fn compile_fixture(name: &str, extra_externs: &[(&str, &Path)]) -> std::process::Output {
    let deps = deps_dir();
    let protocol = find_rlib(&deps, "termx_swarm_mcp_protocol");
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let src = manifest.join("tests").join("compile-fail").join(name);
    let out_dir = unique_out_dir(name);
    let mut cmd = rustc();
    cmd.arg("-L")
        .arg(format!("dependency={}", deps.display()))
        .arg("--extern")
        .arg(format!("termx_swarm_mcp_protocol={}", protocol.display()))
        .arg("--crate-name")
        .arg(name.replace(['.', '-'], "_"))
        .arg("--out-dir")
        .arg(&out_dir)
        .arg(&src);
    for (crate_name, path) in extra_externs {
        cmd.arg("--extern")
            .arg(format!("{crate_name}={}", path.display()));
    }
    cmd.output()
        .unwrap_or_else(|err| panic!("rustc {name}: {err}"))
}

fn stderr_text(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn clone_of_active_request_is_rejected() {
    let output = compile_fixture("clone_lease.rs", &[]);
    assert!(
        !output.status.success(),
        "clone fixture compiled; restriction missing\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        stderr_text(&output)
    );
    let stderr = stderr_text(&output);
    assert!(
        stderr.contains("Clone") || stderr.contains("clone"),
        "expected Clone trait error, got:\n{stderr}"
    );
}

#[test]
fn deserialize_of_active_request_is_rejected() {
    let deps = deps_dir();
    let serde_json = find_rlib(&deps, "serde_json");
    let output = compile_fixture("deserialize_lease.rs", &[("serde_json", &serde_json)]);
    assert!(
        !output.status.success(),
        "deserialize fixture compiled; restriction missing\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        stderr_text(&output)
    );
    let stderr = stderr_text(&output);
    assert!(
        stderr.contains("Deserialize") || stderr.contains("deserialize"),
        "expected Deserialize trait error, got:\n{stderr}"
    );
}

#[test]
fn id_free_notification_dispatch_is_rejected() {
    let output = compile_fixture("id_free_dispatch.rs", &[]);
    assert!(
        !output.status.success(),
        "id-free fixture compiled; shortcut still exported\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        stderr_text(&output)
    );
    let stderr = stderr_text(&output);
    assert!(
        stderr.contains("admit_notification"),
        "expected missing-method diagnostic for admit_notification, got:\n{stderr}"
    );
}

#[test]
fn moved_lease_reuse_is_rejected() {
    let neighbor = compile_fixture("positive_moved_once.rs", &[]);
    assert!(
        neighbor.status.success(),
        "positive moved-once neighbor failed to compile\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&neighbor.stdout),
        stderr_text(&neighbor)
    );
    let output = compile_fixture("moved_lease.rs", &[]);
    assert!(
        !output.status.success(),
        "moved-lease fixture compiled; restriction missing\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        stderr_text(&output)
    );
    let stderr = stderr_text(&output);
    assert!(
        stderr.contains("moved value") || stderr.contains("use of moved"),
        "expected moved-value diagnostic, got:\n{stderr}"
    );
}

#[test]
fn positive_lifecycle_control_compiles() {
    let output = compile_fixture("positive_lifecycle.rs", &[]);
    assert!(
        output.status.success(),
        "positive lifecycle control failed to compile\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        stderr_text(&output)
    );
}
