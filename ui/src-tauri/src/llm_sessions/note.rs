//! LLM-written session notes: shell out to the Claude CLI for a one-line
//! summary or a short recap of a transcript.
//!
//! This is best-effort decoration for a list row, so every failure mode —
//! no CLI installed, a hung model, a non-zero exit, empty output — is `None`
//! and the caller keeps whatever it already had. The transcript excerpt goes
//! in on stdin and is never logged: it is the user's conversation, and it
//! would also be the wrong thing to put on a command line, where other
//! processes can read it.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::claude::{clean_text, RECAP_MAX_CHARS};

/// The CLI TermX shells out to. Injected everywhere below so tests never run
/// the real one.
pub const DEFAULT_PROGRAM: &str = "claude";
/// Small and fast: this runs opportunistically behind a list.
pub const MODEL: &str = "claude-haiku-4-5-20251001";
/// A note is not worth more than half a minute of a background process.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// How much of the transcript the model sees — the end, where "what was going
/// on" actually lives.
pub const EXCERPT_BYTES: u64 = 8 * 1024;
/// Summaries share a row with the title.
pub const SUMMARY_MAX_CHARS: usize = 120;
/// Recap shape, enforced locally so a chatty model cannot reflow the pane.
pub const RECAP_MAX_LINES: usize = 5;
const RECAP_LINE_MAX_CHARS: usize = 240;

/// How often the timeout loop checks on the child.
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// The prompt for a supported note kind; `None` rejects an unknown kind
/// before anything is spawned or read.
pub fn instruction(kind: &str) -> Option<&'static str> {
    match kind {
        "summary" => Some(
            "The stdin below is the tail of a coding session transcript. Reply with ONE line of \
             at most 120 characters describing what the session is about. No preamble, no \
             quotes, no markdown.",
        ),
        "recap" => Some(
            "The stdin below is the tail of a coding session transcript. Reply with 3 to 5 short \
             bullets, each starting with '- ', describing what was happening and where it stands. \
             No preamble, no other text.",
        ),
        _ => None,
    }
}

/// A bare program name resolved to something `Command::new` can actually
/// spawn. On Windows, CreateProcess only appends `.exe` while searching PATH,
/// so the npm-installed CLI — a `claude.cmd` shim with no `claude.exe` beside
/// it — is invisible to a bare `Command::new("claude")`. Probing PATH
/// ourselves and handing back the shim's full path works because Rust's std
/// detects the `.cmd` extension and runs it through `cmd.exe` with safe
/// argument escaping. Order mirrors Windows resolution: first PATH directory
/// wins, `.exe` beats `.cmd`/`.bat` within a directory.
#[cfg(windows)]
pub fn resolve_program(program: &str) -> String {
    let path = std::env::var_os("PATH").unwrap_or_default();
    resolve_in_paths(program, &path)
        .map(|found| found.to_string_lossy().into_owned())
        .unwrap_or_else(|| program.to_string())
}

#[cfg(not(windows))]
pub fn resolve_program(program: &str) -> String {
    program.to_string()
}

#[cfg(windows)]
fn resolve_in_paths(
    program: &str,
    path_var: &std::ffi::OsStr,
) -> Option<std::path::PathBuf> {
    let candidates = [
        format!("{program}.exe"),
        format!("{program}.cmd"),
        format!("{program}.bat"),
    ];
    std::env::split_paths(path_var).find_map(|dir| {
        candidates
            .iter()
            .map(|candidate| dir.join(candidate))
            .find(|full| full.is_file())
    })
}

/// The command for a note kind, without running it.
///
/// The isolation flags are load-bearing: the transcript excerpt is untrusted
/// model input, so the CLI runs with no tools (nothing an injected prompt
/// could execute), no customizations (`--safe-mode`: no hooks, plugins,
/// CLAUDE.md, or MCP servers), and no session persistence — otherwise every
/// note would write a synthetic transcript under `~/.claude/projects` that
/// our own scanner then lists, feeding the summarizer its own output.
pub fn note_command(program: &str, kind: &str) -> Option<Command> {
    let instruction = instruction(kind)?;
    let mut command = Command::new(program);
    command
        .arg("-p")
        .arg("--model")
        .arg(MODEL)
        .arg("--no-session-persistence")
        .arg("--safe-mode")
        .arg("--tools")
        .arg("")
        .arg(instruction);
    Some(command)
}

/// The last `cap` bytes of a file as text. `None` when it cannot be read.
pub fn tail_excerpt(path: &Path, cap: u64) -> Option<String> {
    use std::io::{Seek, SeekFrom};
    let meta = std::fs::metadata(path).ok()?;
    let mut file = std::fs::File::open(path).ok()?;
    if meta.len() > cap {
        file.seek(SeekFrom::Start(meta.len() - cap)).ok()?;
    }
    let mut buf = Vec::new();
    file.take(cap).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Run `command` with `stdin_text` on its stdin and return its stdout, or
/// `None` if it fails, exits non-zero, or outlives `timeout`.
///
/// stdin is written from a separate thread because the child can fill the
/// stdout pipe before it has drained its input: writing inline would then
/// block us while it blocks on us.
pub fn run_note_command(
    mut command: Command,
    stdin_text: &str,
    timeout: Duration,
) -> Option<String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().ok()?;

    if let Some(mut stdin) = child.stdin.take() {
        let payload = stdin_text.to_string();
        std::thread::spawn(move || {
            let _ = stdin.write_all(payload.as_bytes());
        });
    }
    let reader = child.stdout.take().map(|mut stdout| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = stdout.read_to_string(&mut buf);
            buf
        })
    });

    let deadline = Instant::now() + timeout;
    let finished = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(POLL_INTERVAL),
            Ok(None) => break None,
            Err(_) => break None,
        }
    };

    let Some(status) = finished else {
        // Kill and reap; the reader thread ends on its own once the pipe
        // closes, so it is left detached rather than joined.
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    if !status.success() {
        return None;
    }
    reader?.join().ok()
}

/// Trim a model's answer into the shape the UI expects, or `None` when there
/// is nothing usable in it.
pub fn shape_note(kind: &str, raw: &str) -> Option<String> {
    let shaped = match kind {
        "summary" => raw
            .lines()
            .map(|line| clean_text(line, SUMMARY_MAX_CHARS))
            .find(|line| !line.is_empty())
            .unwrap_or_default(),
        "recap" => raw
            .lines()
            .map(|line| clean_text(line, RECAP_LINE_MAX_CHARS))
            .filter(|line| !line.is_empty())
            .take(RECAP_MAX_LINES)
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let shaped: String = shaped.chars().take(RECAP_MAX_CHARS).collect();
    (!shaped.is_empty()).then_some(shaped)
}

/// Generate one note. The program name and timeout are injected so tests can
/// point at a stub instead of the real CLI.
pub fn generate_note_with(
    program: &str,
    file_path: &Path,
    kind: &str,
    timeout: Duration,
) -> Option<String> {
    // Kind is validated first: an unknown kind must not read the transcript
    // or spawn anything.
    let command = note_command(program, kind)?;
    let excerpt = tail_excerpt(file_path, EXCERPT_BYTES)?;
    if excerpt.trim().is_empty() {
        return None;
    }
    let raw = run_note_command(command, &excerpt, timeout)?;
    shape_note(kind, &raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    mod resolve {
        use super::super::{resolve_in_paths, resolve_program};
        use std::path::Path;

        fn touch(dir: &Path, name: &str) {
            std::fs::write(dir.join(name), "@echo off\r\n").unwrap();
        }

        fn path_var(dirs: &[&Path]) -> std::ffi::OsString {
            std::env::join_paths(dirs.iter().copied()).unwrap()
        }

        #[test]
        fn finds_a_cmd_shim_the_bare_name_cannot_spawn() {
            let dir = tempfile::tempdir().unwrap();
            touch(dir.path(), "fake-cli.cmd");
            let found = resolve_in_paths("fake-cli", &path_var(&[dir.path()])).unwrap();
            assert_eq!(found, dir.path().join("fake-cli.cmd"));
        }

        #[test]
        fn prefers_exe_over_cmd_within_one_directory() {
            let dir = tempfile::tempdir().unwrap();
            touch(dir.path(), "fake-cli.cmd");
            touch(dir.path(), "fake-cli.exe");
            let found = resolve_in_paths("fake-cli", &path_var(&[dir.path()])).unwrap();
            assert_eq!(found, dir.path().join("fake-cli.exe"));
        }

        #[test]
        fn earlier_path_directory_wins() {
            let first = tempfile::tempdir().unwrap();
            let second = tempfile::tempdir().unwrap();
            touch(first.path(), "fake-cli.cmd");
            touch(second.path(), "fake-cli.exe");
            let found =
                resolve_in_paths("fake-cli", &path_var(&[first.path(), second.path()]))
                    .unwrap();
            assert_eq!(found, first.path().join("fake-cli.cmd"));
        }

        #[test]
        fn unresolvable_name_falls_back_to_the_bare_program() {
            assert!(
                resolve_in_paths("termx-no-such-cli", &path_var(&[])).is_none()
            );
            assert_eq!(
                resolve_program("termx-no-such-cli"),
                "termx-no-such-cli",
            );
        }
    }

    /// Echoes stdin back on stdout. Stands in for the real CLI.
    #[cfg(windows)]
    fn echo_stdin() -> Command {
        let mut command = Command::new("findstr");
        command.arg(".");
        command
    }
    #[cfg(not(windows))]
    fn echo_stdin() -> Command {
        Command::new("cat")
    }

    /// Outlives any test timeout.
    #[cfg(windows)]
    fn slow() -> Command {
        let mut command = Command::new("ping");
        command.args(["-n", "20", "127.0.0.1"]);
        command
    }
    #[cfg(not(windows))]
    fn slow() -> Command {
        let mut command = Command::new("sleep");
        command.arg("20");
        command
    }

    #[cfg(windows)]
    fn failing() -> Command {
        let mut command = Command::new("cmd");
        command.args(["/c", "exit 1"]);
        command
    }
    #[cfg(not(windows))]
    fn failing() -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", "exit 1"]);
        command
    }

    const ABSENT: &str = "termx-no-such-binary-8f3a1c";

    #[test]
    fn only_the_two_documented_kinds_produce_a_command() {
        assert!(instruction("summary").is_some());
        assert!(instruction("recap").is_some());
        for junk in ["", "Summary", "both", "none", "note"] {
            assert!(instruction(junk).is_none(), "{junk:?}");
            assert!(note_command(DEFAULT_PROGRAM, junk).is_none(), "{junk:?}");
        }
    }

    #[test]
    fn the_command_names_the_haiku_model_and_passes_the_prompt_as_an_argument() {
        let command = note_command("stub-cli", "summary").unwrap();
        let args: Vec<String> = command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(command.get_program().to_string_lossy(), "stub-cli");
        assert_eq!(
            &args[..7],
            [
                "-p",
                "--model",
                MODEL,
                "--no-session-persistence",
                "--safe-mode",
                "--tools",
                ""
            ],
            "isolation flags are load-bearing: {args:?}"
        );
        assert!(args[7].contains("ONE line"), "{args:?}");
        assert_eq!(args.len(), 8, "no transcript on the command line: {args:?}");
    }

    #[test]
    fn stdin_reaches_the_child_and_stdout_comes_back() {
        let got = run_note_command(echo_stdin(), "a summary line", Duration::from_secs(20));
        assert!(
            got.unwrap_or_default().contains("a summary line"),
            "the excerpt must go in on stdin"
        );
    }

    #[test]
    fn an_absent_binary_is_none() {
        let command = note_command(ABSENT, "summary").unwrap();
        assert_eq!(run_note_command(command, "x", Duration::from_secs(5)), None);
    }

    #[test]
    fn a_non_zero_exit_is_none() {
        assert_eq!(
            run_note_command(failing(), "x", Duration::from_secs(20)),
            None
        );
    }

    #[test]
    fn a_hung_child_is_killed_at_the_timeout() {
        let started = Instant::now();
        let got = run_note_command(slow(), "x", Duration::from_millis(300));
        let elapsed = started.elapsed();
        assert_eq!(got, None);
        assert!(
            elapsed < Duration::from_secs(10),
            "must not wait out the child: {elapsed:?}"
        );
    }

    #[test]
    fn the_excerpt_is_the_tail_of_the_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.jsonl");
        let mut body = String::from("HEAD MARKER\n");
        body.push_str(&"filler line\n".repeat(2_000));
        body.push_str("TAIL MARKER\n");
        std::fs::write(&path, &body).unwrap();

        let excerpt = tail_excerpt(&path, EXCERPT_BYTES).unwrap();
        assert_eq!(excerpt.len(), EXCERPT_BYTES as usize);
        assert!(excerpt.contains("TAIL MARKER"));
        assert!(
            !excerpt.contains("HEAD MARKER"),
            "the head must stay unread"
        );

        // A short file is returned whole.
        let small = dir.path().join("small.jsonl");
        std::fs::write(&small, b"just this").unwrap();
        assert_eq!(
            tail_excerpt(&small, EXCERPT_BYTES).as_deref(),
            Some("just this")
        );
        assert_eq!(
            tail_excerpt(&dir.path().join("gone.jsonl"), EXCERPT_BYTES),
            None
        );
    }

    #[test]
    fn a_summary_is_one_clean_line_and_a_recap_is_at_most_five() {
        assert_eq!(
            shape_note(
                "summary",
                "\n\n  Wired the host registry \t up  \n second line\n"
            )
            .as_deref(),
            Some("Wired the host registry up")
        );
        let long = "x".repeat(400);
        assert_eq!(
            shape_note("summary", &long).unwrap().chars().count(),
            SUMMARY_MAX_CHARS
        );

        let recap = shape_note("recap", "- one\n\n- two\n- three\n- four\n- five\n- six").unwrap();
        assert_eq!(recap.lines().count(), RECAP_MAX_LINES);
        assert!(recap.starts_with("- one"));
        assert!(!recap.contains("six"));

        for empty in ["", "   ", "\n\n"] {
            assert_eq!(shape_note("summary", empty), None, "{empty:?}");
            assert_eq!(shape_note("recap", empty), None, "{empty:?}");
        }
        assert_eq!(shape_note("bogus", "anything"), None);
    }

    /// A stub CLI that ignores its arguments and echoes stdin, so the whole
    /// chain (kind → command → excerpt → stdout → shaping) runs without the
    /// real `claude` binary.
    fn stub_cli(dir: &Path) -> String {
        #[cfg(windows)]
        {
            let path = dir.join("stub-cli.cmd");
            std::fs::write(&path, "@echo off\r\nfindstr .\r\n").unwrap();
            path.to_string_lossy().into_owned()
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join("stub-cli.sh");
            std::fs::write(&path, "#!/bin/sh\nexec cat\n").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path.to_string_lossy().into_owned()
        }
    }

    #[test]
    fn generating_against_a_stub_returns_the_shaped_answer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        std::fs::write(&path, b"the session said something\nand then stopped\n").unwrap();

        let got = generate_note_with(
            &stub_cli(dir.path()),
            &path,
            "summary",
            Duration::from_secs(20),
        );
        assert_eq!(got.as_deref(), Some("the session said something"));

        let recap = generate_note_with(
            &stub_cli(dir.path()),
            &path,
            "recap",
            Duration::from_secs(20),
        )
        .unwrap();
        assert_eq!(recap, "the session said something\nand then stopped");
    }

    #[test]
    fn every_failure_mode_of_generate_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        std::fs::write(&path, b"content\n").unwrap();

        // Unknown kind, missing transcript, empty transcript, absent binary.
        assert_eq!(
            generate_note_with(ABSENT, &path, "bogus", Duration::from_secs(1)),
            None
        );
        assert_eq!(
            generate_note_with(
                ABSENT,
                &dir.path().join("gone.jsonl"),
                "summary",
                Duration::from_secs(1)
            ),
            None
        );
        let blank = dir.path().join("blank.jsonl");
        std::fs::write(&blank, b"   \n").unwrap();
        assert_eq!(
            generate_note_with(ABSENT, &blank, "summary", Duration::from_secs(1)),
            None
        );
        assert_eq!(
            generate_note_with(ABSENT, &path, "summary", Duration::from_secs(1)),
            None
        );
    }
}
