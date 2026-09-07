//! Shell profiles. M1: powershell + cmd resolved from env vars AT RUNTIME
//! (portability rule: no literal install paths). M2 adds discovery of
//! Git Bash / pwsh / WSL for the profile picker.

use anyhow::{bail, Result};
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    pub name: String,
    pub command: PathBuf,
    pub args: Vec<String>,
    /// Environment overlaid on the spawned shell. Empty unless shell
    /// integration is on (only cmd needs env; powershell hooks via args).
    pub env: Vec<(String, String)>,
}

/// PowerShell prompt wrapper emitting the OSC 9;9 working-directory report (the
/// Windows Terminal convention) on every prompt, then delegating to whatever
/// prompt the user's profile installed.
///
/// This travels as ONE argv entry through portable_pty's ArgvQuote and then
/// powershell.exe's own `-Command` re-parse, so it deliberately contains no `"`
/// and no `\`: quoting rewrites those (`"` becomes `\"`, backslashes before a
/// quote double) and the shell would receive a mangled script. ESC and the ST
/// backslash are built with [char] casts instead.
///
/// `$?` is read as the very first statement and a false value is restored (the
/// Write-Error trick) before delegating, so posh-git-style prompts still see the
/// real success state. Nothing here reads or writes `$LASTEXITCODE`. Verified on
/// PowerShell 5.1.26100.8875: wrapped and unwrapped prompts observe identical
/// `$?` and `$LASTEXITCODE` after succeeding, failing, and native-exit-code
/// commands.
const POWERSHELL_OSC9_HOOK: &str = "$global:__termxPrompt = $function:prompt; function global:prompt { $__termxOk = $?; $e = [string][char]27; [Console]::Write($e + ']9;9;' + $ExecutionContext.SessionState.Path.CurrentFileSystemLocation.ProviderPath + $e + [string][char]92); if (-not $__termxOk) { Write-Error termx -ErrorAction SilentlyContinue }; & $global:__termxPrompt }";

/// Captures PowerShell's already-tokenized automatic `$args` array. Existing
/// user aliases/functions win: shell integration must not silently replace a
/// customization the user's profile installed.
const POWERSHELL_AGENT_WRAPPERS: &str = "if (-not (Get-Command claude -CommandType Alias,Function -ErrorAction SilentlyContinue)) { function global:claude { $j = ConvertTo-Json -Compress -InputObject ([ordered]@{v=1;provider='claude';args=[string[]]@($args)}); $t = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j)).TrimEnd('=').Replace('+','-').Replace('/','_'); & $env:TERMX_HOST_EXE --agent-json $t } }; if (-not (Get-Command codex -CommandType Alias,Function -ErrorAction SilentlyContinue)) { function global:codex { $j = ConvertTo-Json -Compress -InputObject ([ordered]@{v=1;provider='codex';args=[string[]]@($args)}); $t = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j)).TrimEnd('=').Replace('+','-').Replace('/','_'); & $env:TERMX_HOST_EXE --agent-json $t } }";

/// cmd has no prompt function to wrap, so PROMPT itself carries the sequence
/// (`$E` is cmd's VT escape, `$P` the cwd) and still renders the default
/// `path>` prompt after it.
const CMD_OSC9_PROMPT: &str = r"$E]9;9;$P$E\$P$G";

/// cmd macros forward the text cmd has already parsed to the native launcher.
/// The `findstr` guards preserve macros installed by cmd AutoRun rather than
/// replacing custom user definitions.
const CMD_AGENT_MACROS: &str = "doskey /macros | findstr /b /i /c:claude= >nul || doskey claude=%TERMX_AGENT_DQ%%TERMX_HOST_EXE%%TERMX_AGENT_DQ% --agent claude -- $* & doskey /macros | findstr /b /i /c:codex= >nul || doskey codex=%TERMX_AGENT_DQ%%TERMX_HOST_EXE%%TERMX_AGENT_DQ% --agent codex -- $*";

pub fn resolve(name: &str, shell_integration: bool) -> Result<Profile> {
    resolve_with_env(name, shell_integration, &|key| std::env::var(key).ok())
}

pub fn resolve_with_env(
    name: &str,
    shell_integration: bool,
    get_env: &dyn Fn(&str) -> Option<String>,
) -> Result<Profile> {
    match name {
        "powershell" => {
            let root =
                get_env("SystemRoot").ok_or_else(|| anyhow::anyhow!("SystemRoot not set"))?;
            let mut args = vec!["-NoLogo".to_string()];
            if shell_integration {
                // -NoExit keeps the interactive REPL after the hook runs, and
                // -Command must stay last: powershell treats everything after
                // it as the script.
                args.push("-NoExit".into());
                args.push("-Command".into());
                args.push(format!(
                    "{POWERSHELL_OSC9_HOOK}; {POWERSHELL_AGENT_WRAPPERS}"
                ));
            }
            Ok(Profile {
                name: name.into(),
                command: PathBuf::from(root)
                    .join(r"System32\WindowsPowerShell\v1.0\powershell.exe"),
                args,
                env: Vec::new(),
            })
        }
        "cmd" => {
            let comspec = get_env("ComSpec").ok_or_else(|| anyhow::anyhow!("ComSpec not set"))?;
            Ok(Profile {
                name: name.into(),
                command: PathBuf::from(comspec),
                args: if shell_integration {
                    vec!["/K".to_string(), CMD_AGENT_MACROS.to_string()]
                } else {
                    Vec::new()
                },
                env: if shell_integration {
                    vec![
                        ("PROMPT".to_string(), CMD_OSC9_PROMPT.to_string()),
                        ("TERMX_AGENT_DQ".to_string(), "\"".to_string()),
                    ]
                } else {
                    Vec::new()
                },
            })
        }
        other => bail!("unknown profile '{other}' — known profiles: powershell, cmd"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use std::ffi::OsStr;

    fn fake_env(key: &str) -> Option<String> {
        match key {
            "SystemRoot" => Some(r"X:\FakeWindows".into()),
            "ComSpec" => Some(r"X:\FakeWindows\system32\cmd.exe".into()),
            _ => None,
        }
    }

    #[test]
    fn powershell_resolves_from_systemroot() {
        let p = resolve_with_env("powershell", false, &fake_env).unwrap();
        assert_eq!(
            p.command,
            PathBuf::from(r"X:\FakeWindows\System32\WindowsPowerShell\v1.0\powershell.exe")
        );
        assert_eq!(p.args, vec!["-NoLogo".to_string()]);
        assert!(p.env.is_empty(), "integration off adds no env");
    }

    #[test]
    fn cmd_resolves_from_comspec() {
        let p = resolve_with_env("cmd", false, &fake_env).unwrap();
        assert_eq!(p.command, PathBuf::from(r"X:\FakeWindows\system32\cmd.exe"));
        assert!(p.args.is_empty());
        assert!(p.env.is_empty(), "integration off adds no env");
    }

    #[test]
    fn powershell_with_integration_appends_the_prompt_hook_as_one_arg() {
        let p = resolve_with_env("powershell", true, &fake_env).unwrap();
        assert_eq!(&p.args[..3], ["-NoLogo", "-NoExit", "-Command"]);
        let hook = p.args.last().unwrap();
        assert!(hook.starts_with(POWERSHELL_OSC9_HOOK));
        assert!(hook.contains("function global:claude"));
        assert!(hook.contains("function global:codex"));
        assert!(hook.contains("--agent-json"));
        assert!(hook.contains("TERMX_HOST_EXE"));
        assert!(p.env.is_empty(), "powershell hooks via args, never via env");
    }

    /// The hook survives argv quoting only because it has neither character
    /// that quoting rewrites. Guard the property, not just today's string.
    #[test]
    fn powershell_hook_avoids_characters_that_argv_quoting_rewrites() {
        assert!(
            !POWERSHELL_OSC9_HOOK.contains('"'),
            "a quote becomes \\\" on the command line"
        );
        assert!(
            !POWERSHELL_OSC9_HOOK.contains('\\'),
            "backslashes double when they precede a quote"
        );
    }

    #[test]
    fn powershell_hook_reads_status_before_writing_and_restores_it() {
        let hook = POWERSHELL_OSC9_HOOK;
        let capture = hook.find("$__termxOk = $?").expect("captures $?");
        let write = hook.find("[Console]::Write").expect("writes the OSC");
        let restore = hook.find("Write-Error").expect("restores a false $?");
        let delegate = hook.find("& $global:__termxPrompt").expect("delegates");
        assert!(
            capture < write && write < restore && restore < delegate,
            "order must be capture -> write -> restore -> delegate"
        );
        assert!(
            hook.contains("]9;9;"),
            "must emit the OSC 9;9 cwd report: {hook}"
        );
        assert!(
            hook.contains("CurrentFileSystemLocation.ProviderPath"),
            "must report a real filesystem path: {hook}"
        );
        assert!(
            !hook.contains("LASTEXITCODE"),
            "the hook must not touch $LASTEXITCODE: {hook}"
        );
    }

    #[test]
    fn cmd_with_integration_sets_prompt_env_keeping_the_visible_prompt() {
        let p = resolve_with_env("cmd", true, &fake_env).unwrap();
        assert_eq!(
            p.env,
            vec![
                ("PROMPT".to_string(), r"$E]9;9;$P$E\$P$G".to_string()),
                ("TERMX_AGENT_DQ".to_string(), "\"".to_string()),
            ]
        );
        assert_eq!(&p.args[..1], ["/K"]);
        let setup = p.args.last().unwrap();
        assert!(setup.contains("doskey claude="));
        assert!(setup.contains("doskey codex="));
        assert!(setup.contains("TERMX_HOST_EXE"));
        assert!(setup.contains("--agent claude -- $*"));
        assert!(setup.contains("--agent codex -- $*"));
    }

    #[test]
    fn unknown_profile_lists_known_ones() {
        let err = resolve_with_env("zsh", true, &fake_env)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("powershell") && err.contains("cmd"),
            "helpful error: {err}"
        );
    }

    #[test]
    fn real_env_resolves_powershell_on_this_machine() {
        let p = resolve("powershell", true).unwrap();
        assert!(
            p.command.is_file(),
            "should exist on any Windows box: {:?}",
            p.command
        );
    }

    fn build_host_argv_dumper(directory: &std::path::Path) -> PathBuf {
        let source = directory.join("host_argv_dumper.rs");
        let executable = directory.join("termx-host-fake.exe");
        std::fs::write(
            &source,
            r#"
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
fn main() {
    let mut out = std::fs::File::create(std::env::current_dir().unwrap().join("host-argv.dump")).unwrap();
    for arg in std::env::args_os().skip(1) {
        let units: Vec<String> = arg.encode_wide().map(|unit| unit.to_string()).collect();
        writeln!(out, "{}:{}", units.len(), units.join(",")).unwrap();
    }
}
"#,
        )
        .unwrap();
        let status = std::process::Command::new("rustc")
            .args([source.as_os_str(), OsStr::new("-o"), executable.as_os_str()])
            .status()
            .unwrap();
        assert!(status.success());
        executable
    }

    fn read_host_dump(path: &std::path::Path) -> Vec<String> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| {
                let (length, units) = line.split_once(':').unwrap();
                let decoded: Vec<u16> = if units.is_empty() {
                    Vec::new()
                } else {
                    units.split(',').map(|unit| unit.parse().unwrap()).collect()
                };
                assert_eq!(decoded.len(), length.parse::<usize>().unwrap());
                String::from_utf16(&decoded).unwrap()
            })
            .collect()
    }

    #[test]
    fn powershell_wrapper_round_trips_typed_arguments_through_structured_json() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_host = build_host_argv_dumper(tmp.path());
        let profile = resolve("powershell", true).unwrap();
        let script = format!(
            "{}; claude 'plain' '' 'a b' 'x&y' '^caret' '50%' '雪だるま'",
            profile.args.last().unwrap()
        );
        let status = std::process::Command::new(profile.command)
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", &script])
            .current_dir(tmp.path())
            .env("TERMX_HOST_EXE", &fake_host)
            .status()
            .unwrap();
        assert!(status.success());
        let host_args = read_host_dump(&tmp.path().join("host-argv.dump"));
        assert_eq!(host_args.first().map(String::as_str), Some("--agent-json"));
        let json = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&host_args[1])
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&json).unwrap();
        assert_eq!(value["provider"], "claude");
        assert_eq!(
            value["args"],
            serde_json::json!(["plain", "", "a b", "x&y", "^caret", "50%", "雪だるま"])
        );
    }

    #[test]
    fn cmd_macro_round_trips_typed_arguments_to_the_native_agent_mode() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_host = build_host_argv_dumper(tmp.path());
        let mut profile = resolve("cmd", true).unwrap();
        profile.env.push((
            "TERMX_HOST_EXE".into(),
            fake_host.display().to_string(),
        ));
        let session = crate::session::Session::spawn(&profile, Some(tmp.path()), 100, 30, 64 * 1024)
            .unwrap();
        session
            .write_input("claude plain \"\" \"a b\" \"x&y\" \"^caret\" \"50%\" \"雪だるま\"\r\n".as_bytes())
            .unwrap();
        let dump = tmp.path().join("host-argv.dump");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while std::time::Instant::now() < deadline && !dump.is_file() {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let output = String::from_utf8_lossy(&session.snapshot().1).into_owned();
        session.kill();
        assert!(session.wait_exit_blocking(std::time::Duration::from_secs(10)));
        assert!(
            dump.is_file(),
            "cmd macro did not invoke the native launcher; output: {output:?}"
        );
        assert_eq!(
            read_host_dump(&dump),
            vec!["--agent", "claude", "--", "plain", "", "a b", "x&y", "^caret", "50%", "雪だるま"]
        );
    }
}
