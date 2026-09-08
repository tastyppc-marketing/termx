//! `termx-output` — the explicit "this is a deliverable" signal (polish spec
//! P4).
//!
//! Nothing in TermX mines transcripts for outputs; a session *declares* them
//! by running this helper (from a Claude Code hook, a CLAUDE.md convention, or
//! by hand):
//!
//! ```text
//! termx-output <path> [--label <text>] [--session <claude-session-id>]
//! ```
//!
//! Two effects, both best-effort:
//!
//! 1. one JSON line appended to `<data dir>\outputs_v1.jsonl` (the sidecar the
//!    Conversations detail pane reads back), and
//! 2. when the process is running inside a TermX pane (`TERMX_SESSION_ID` set
//!    by `registry::stamp_termx_env`), the private OSC
//!    `ESC ] 9 ; 77 ; output ; <abs path> BEL` on stdout, so the app registers
//!    the file live without waiting for a rescan.
//!
//! This runs inside somebody's hook chain, so a sidecar that cannot be written
//! (locked, read-only, no data dir) still exits 0: a failed bookkeeping write
//! must never turn into a failed tool call. Only a malformed *invocation* —
//! which is a bug in the caller, not a runtime condition — exits non-zero.

use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

#[cfg(test)]
#[path = "../../tests/support/mod.rs"]
mod test_support;

/// Sidecar file name, shared by convention with `ui/src-tauri/src/outputs.rs`
/// (the reader). Versioned in the name so a future shape change is a new file
/// rather than a migration of an append-only log.
const SIDECAR_NAME: &str = "outputs_v1.jsonl";

/// Env var `registry::stamp_termx_env` puts on every TermX-spawned shell.
/// Its presence is what makes this process "inside a pane".
const SESSION_ENV: &str = "TERMX_SESSION_ID";

const USAGE: &str = "usage: termx-output <path> [--label <text>] [--session <claude-session-id>]";

/// Exit code for a malformed command line (see module docs: not a runtime
/// failure, so it is the one case that is *not* swallowed).
const EXIT_USAGE: i32 = 2;

/// One appended sidecar line. `dismissed` is omitted on registrations and
/// `true` on the tombstones the UI appends — the reader treats a missing field
/// as `false`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputRecord {
    /// `claude:<id>` when `--session` was given, else null (the record still
    /// lands, and is still visible live via `termxSession`).
    session_key: Option<String>,
    /// TermX pane id from the environment, when there is one.
    termx_session: Option<String>,
    path: String,
    label: Option<String>,
    at_ms: u64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    dismissed: bool,
}

#[derive(Debug, PartialEq, Eq)]
struct Args {
    path: String,
    label: Option<String>,
    session: Option<String>,
}

/// Strict parse: exactly one positional path, each flag at most once, every
/// flag with a value. Flags may appear before or after the path — hooks build
/// these command lines by string concatenation and the order is not worth an
/// argument.
fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Args, String> {
    let mut path: Option<String> = None;
    let mut label: Option<String> = None;
    let mut session: Option<String> = None;
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--label" => {
                if label.is_some() {
                    return Err("--label given twice".to_string());
                }
                label = Some(it.next().ok_or("--label requires a value")?);
            }
            "--session" => {
                if session.is_some() {
                    return Err("--session given twice".to_string());
                }
                session = Some(it.next().ok_or("--session requires a value")?);
            }
            other if other.starts_with("--") => {
                return Err(format!("unknown argument: {other}"));
            }
            other => {
                if path.is_some() {
                    return Err(format!("unexpected extra argument: {other}"));
                }
                path = Some(other.to_string());
            }
        }
    }
    let path = path.ok_or("a path is required")?;
    if path.is_empty() {
        return Err("path must not be empty".to_string());
    }
    Ok(Args {
        path,
        label,
        session,
    })
}

/// Lexically absolute form of `raw` against `cwd`. Deliberately *not*
/// `canonicalize`: that requires the file to exist (a hook may register
/// something being written right now) and on Windows returns a `\\?\` path,
/// which is not what anyone wants to read in a list row.
fn absolutize(raw: &str, cwd: &Path) -> PathBuf {
    let raw = Path::new(raw);
    let joined = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        cwd.join(raw)
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The private OSC the terminal binding listens for: `9;77;output;<path>`,
/// BEL-terminated (the same terminator the cwd OSC uses).
fn osc_for(path: &str) -> String {
    format!("\x1b]9;77;output;{path}\x07")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Append one JSON line, creating the sidecar (and its directory) on first
/// use. Append mode only — the log is never rewritten, so a concurrent hook
/// can never truncate another's record.
fn append_record(sidecar: &Path, record: &OutputRecord) -> std::io::Result<()> {
    if let Some(parent) = sidecar.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut line = serde_json::to_string(record)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    line.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(sidecar)?;
    file.write_all(line.as_bytes())
}

/// Whole program body, pure in its inputs: the caller supplies the sidecar
/// path, the cwd, the session env value and the stdout sink, so tests never
/// touch the real `%APPDATA%` or the real terminal.
///
/// Returns the process exit code — 0 for everything except a bad command line.
fn run(
    args: impl IntoIterator<Item = String>,
    cwd: &Path,
    sidecar: &Path,
    termx_session: Option<String>,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
) -> i32 {
    let args = match parse_args(args) {
        Ok(args) => args,
        Err(err) => {
            let _ = writeln!(stderr, "termx-output: {err}\n{USAGE}");
            return EXIT_USAGE;
        }
    };
    let abs = absolutize(&args.path, cwd).to_string_lossy().into_owned();
    // Empty is treated as unset: an exported-but-blank variable does not mean
    // "inside a pane".
    let termx_session = termx_session.filter(|s| !s.is_empty());
    let record = OutputRecord {
        session_key: args.session.map(|id| format!("claude:{id}")),
        termx_session: termx_session.clone(),
        path: abs.clone(),
        label: args.label,
        at_ms: now_ms(),
        dismissed: false,
    };
    if let Err(err) = append_record(sidecar, &record) {
        // Reported, never fatal: the OSC below may still register it live.
        let _ = writeln!(stderr, "termx-output: sidecar write failed: {err}");
    }
    if termx_session.is_some() {
        let _ = write!(stdout, "{}", osc_for(&abs));
        let _ = stdout.flush();
    }
    0
}

fn main() {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    // Same resolution as the host and the UI: override → portable.flag beside
    // the exe → %APPDATA%\TermX. Nothing absolute is hardcoded. If it cannot
    // be resolved we still run (and only the sidecar write fails).
    let sidecar = termx_host::paths::resolve_data_dir(None)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(SIDECAR_NAME);
    let code = run(
        std::env::args().skip(1),
        &cwd,
        &sidecar,
        std::env::var(SESSION_ENV).ok(),
        &mut std::io::stdout(),
        &mut std::io::stderr(),
    );
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn run_ok(argv: &[&str], cwd: &Path, sidecar: &Path, session: Option<&str>) -> (i32, String) {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(
            args(argv),
            cwd,
            sidecar,
            session.map(|s| s.to_string()),
            &mut out,
            &mut err,
        );
        (code, String::from_utf8(out).unwrap())
    }

    fn lines(sidecar: &Path) -> Vec<Value> {
        std::fs::read_to_string(sidecar)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn parses_path_with_both_flags_in_any_order() {
        let want = Args {
            path: r"C:\out\report.xlsx".to_string(),
            label: Some("Q3 report".to_string()),
            session: Some("abc-123".to_string()),
        };
        assert_eq!(
            parse_args(args(&[
                r"C:\out\report.xlsx",
                "--label",
                "Q3 report",
                "--session",
                "abc-123"
            ]))
            .unwrap(),
            want
        );
        assert_eq!(
            parse_args(args(&[
                "--session",
                "abc-123",
                "--label",
                "Q3 report",
                r"C:\out\report.xlsx"
            ]))
            .unwrap(),
            want
        );
    }

    #[test]
    fn path_only_is_enough() {
        let parsed = parse_args(args(&["out.txt"])).unwrap();
        assert_eq!(parsed.path, "out.txt");
        assert!(parsed.label.is_none() && parsed.session.is_none());
    }

    #[test]
    fn malformed_command_lines_are_rejected() {
        for argv in [
            vec![],
            vec!["--label", "x"],
            vec!["a.txt", "--label"],
            vec!["a.txt", "--session"],
            vec!["a.txt", "--nope", "x"],
            vec!["a.txt", "b.txt"],
            vec!["a.txt", "--label", "x", "--label", "y"],
            vec![""],
        ] {
            assert!(parse_args(args(&argv)).is_err(), "should reject {argv:?}");
        }
    }

    #[test]
    fn absolutize_joins_cwd_and_cleans_dot_segments() {
        let cwd = Path::new(r"C:\work\repo");
        assert_eq!(
            absolutize("out/report.md", cwd),
            PathBuf::from(r"C:\work\repo\out\report.md")
        );
        assert_eq!(
            absolutize(r".\out\.\report.md", cwd),
            PathBuf::from(r"C:\work\repo\out\report.md")
        );
        assert_eq!(
            absolutize(r"..\shared\report.md", cwd),
            PathBuf::from(r"C:\work\shared\report.md")
        );
    }

    #[test]
    fn absolutize_keeps_an_absolute_path() {
        assert_eq!(
            absolutize(r"D:\deliverables\deck.pptx", Path::new(r"C:\work")),
            PathBuf::from(r"D:\deliverables\deck.pptx")
        );
    }

    #[test]
    fn appends_a_record_with_session_key_and_label() {
        let tmp = test_support::retained_dir().unwrap();
        let sidecar = tmp.path().join("nested").join(SIDECAR_NAME);
        let (code, stdout) = run_ok(
            &["out/report.md", "--label", "Report", "--session", "s-1"],
            Path::new(r"C:\work"),
            &sidecar,
            None,
        );
        assert_eq!(code, 0);
        assert_eq!(stdout, "", "no OSC without a TermX session");
        let rows = lines(&sidecar);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["sessionKey"], "claude:s-1");
        assert_eq!(rows[0]["path"], r"C:\work\out\report.md");
        assert_eq!(rows[0]["label"], "Report");
        assert_eq!(rows[0]["termxSession"], Value::Null);
        assert!(rows[0]["atMs"].as_u64().unwrap() > 0);
        assert!(
            rows[0].get("dismissed").is_none(),
            "a registration is not a tombstone"
        );
    }

    #[test]
    fn without_session_flag_the_key_is_null() {
        let tmp = test_support::retained_dir().unwrap();
        let sidecar = tmp.path().join(SIDECAR_NAME);
        run_ok(&[r"C:\out\a.txt"], Path::new(r"C:\work"), &sidecar, None);
        let rows = lines(&sidecar);
        assert_eq!(rows[0]["sessionKey"], Value::Null);
        assert_eq!(rows[0]["label"], Value::Null);
    }

    #[test]
    fn emits_osc_and_records_pane_id_only_when_env_is_set() {
        let tmp = test_support::retained_dir().unwrap();
        let sidecar = tmp.path().join(SIDECAR_NAME);
        let (code, stdout) = run_ok(
            &[r"C:\out\a.txt"],
            Path::new(r"C:\work"),
            &sidecar,
            Some("7"),
        );
        assert_eq!(code, 0);
        assert_eq!(stdout, "\x1b]9;77;output;C:\\out\\a.txt\x07");
        assert_eq!(lines(&sidecar)[0]["termxSession"], "7");
    }

    #[test]
    fn an_empty_session_env_is_treated_as_unset() {
        let tmp = test_support::retained_dir().unwrap();
        let sidecar = tmp.path().join(SIDECAR_NAME);
        let (_, stdout) = run_ok(
            &[r"C:\out\a.txt"],
            Path::new(r"C:\work"),
            &sidecar,
            Some(""),
        );
        assert_eq!(stdout, "");
        assert_eq!(lines(&sidecar)[0]["termxSession"], Value::Null);
    }

    #[test]
    fn records_append_never_replace() {
        let tmp = test_support::retained_dir().unwrap();
        let sidecar = tmp.path().join(SIDECAR_NAME);
        run_ok(&[r"C:\out\a.txt"], Path::new(r"C:\work"), &sidecar, None);
        run_ok(&[r"C:\out\b.txt"], Path::new(r"C:\work"), &sidecar, None);
        let rows = lines(&sidecar);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["path"], r"C:\out\a.txt");
        assert_eq!(rows[1]["path"], r"C:\out\b.txt");
    }

    #[test]
    fn a_failed_sidecar_write_still_exits_zero_and_still_emits_the_osc() {
        let tmp = test_support::retained_dir().unwrap();
        // A directory where the sidecar file should be: every open-for-append
        // fails, which is as close as a test gets to a locked/read-only log.
        let sidecar = tmp.path().join(SIDECAR_NAME);
        std::fs::create_dir_all(&sidecar).unwrap();
        let (code, stdout) = run_ok(
            &[r"C:\out\a.txt"],
            Path::new(r"C:\work"),
            &sidecar,
            Some("7"),
        );
        assert_eq!(code, 0, "a hook chain must not break on bookkeeping");
        assert_eq!(stdout, "\x1b]9;77;output;C:\\out\\a.txt\x07");
    }

    #[test]
    fn a_bad_command_line_exits_two_and_writes_nothing() {
        let tmp = test_support::retained_dir().unwrap();
        let sidecar = tmp.path().join(SIDECAR_NAME);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(
            args(&["--label", "orphan"]),
            Path::new(r"C:\work"),
            &sidecar,
            None,
            &mut out,
            &mut err,
        );
        assert_eq!(code, EXIT_USAGE);
        assert!(out.is_empty());
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("usage: termx-output"));
        assert!(!sidecar.exists());
    }
}
