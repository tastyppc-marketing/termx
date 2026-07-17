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
}

pub fn resolve(name: &str) -> Result<Profile> {
    resolve_with_env(name, &|key| std::env::var(key).ok())
}

pub fn resolve_with_env(name: &str, get_env: &dyn Fn(&str) -> Option<String>) -> Result<Profile> {
    match name {
        "powershell" => {
            let root = get_env("SystemRoot")
                .ok_or_else(|| anyhow::anyhow!("SystemRoot not set"))?;
            Ok(Profile {
                name: name.into(),
                command: PathBuf::from(root)
                    .join(r"System32\WindowsPowerShell\v1.0\powershell.exe"),
                args: vec!["-NoLogo".into()],
            })
        }
        "cmd" => {
            let comspec = get_env("ComSpec")
                .ok_or_else(|| anyhow::anyhow!("ComSpec not set"))?;
            Ok(Profile { name: name.into(), command: PathBuf::from(comspec), args: vec![] })
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
        let p = resolve_with_env("powershell", &fake_env).unwrap();
        assert_eq!(
            p.command,
            PathBuf::from(r"X:\FakeWindows\System32\WindowsPowerShell\v1.0\powershell.exe")
        );
        assert_eq!(p.args, vec!["-NoLogo".to_string()]);
    }

    #[test]
    fn cmd_resolves_from_comspec() {
        let p = resolve_with_env("cmd", &fake_env).unwrap();
        assert_eq!(p.command, PathBuf::from(r"X:\FakeWindows\system32\cmd.exe"));
        assert!(p.args.is_empty());
    }

    #[test]
    fn unknown_profile_lists_known_ones() {
        let err = resolve_with_env("zsh", &fake_env).unwrap_err().to_string();
        assert!(err.contains("powershell") && err.contains("cmd"), "helpful error: {err}");
    }

    #[test]
    fn real_env_resolves_powershell_on_this_machine() {
        let p = resolve("powershell").unwrap();
        assert!(p.command.is_file(), "should exist on any Windows box: {:?}", p.command);
    }
}
