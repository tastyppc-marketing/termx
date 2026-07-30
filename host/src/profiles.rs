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

/// cmd has no prompt function to wrap, so PROMPT itself carries the sequence
/// (`$E` is cmd's VT escape, `$P` the cwd) and still renders the default
/// `path>` prompt after it.
const CMD_OSC9_PROMPT: &str = r"$E]9;9;$P$E\$P$G";

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
                args.push(POWERSHELL_OSC9_HOOK.into());
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
                args: vec![],
                env: if shell_integration {
                    vec![("PROMPT".to_string(), CMD_OSC9_PROMPT.to_string())]
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
        assert_eq!(
            p.args,
            vec![
                "-NoLogo".to_string(),
                "-NoExit".to_string(),
                "-Command".to_string(),
                POWERSHELL_OSC9_HOOK.to_string(),
            ]
        );
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
            vec![("PROMPT".to_string(), r"$E]9;9;$P$E\$P$G".to_string())]
        );
        assert!(p.args.is_empty(), "cmd hooks via env, never via args");
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
}
