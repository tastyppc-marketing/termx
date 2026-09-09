//! Swarm companion runtime: early mode routing, the authorized broker
//! runtime, strict typed RPC over the two named-pipe endpoints, and bounded
//! revision events.
//!
//! Only the first OS argument selects a swarm mode. A recognized token always
//! yields a mode result, before ordinary host argument parsing, log cleanup,
//! history sweeps, logging or PTY/TCP startup. Agent helper tokens keep their
//! precedence because `agent_launch::dispatch_early` runs first in `main`.

pub mod events;
pub mod lifetime;
pub mod output;
pub mod response;
pub mod rpc;
pub mod runtime;
pub mod tools;

use std::ffi::{OsStr, OsString};
use std::fmt;
use std::path::PathBuf;
use termx_swarm_client::ProcessIdentity;

pub const BROKER_MODE: &str = "--swarm-broker";
pub const MCP_MODE: &str = "--swarm-mcp";
pub const CLI_MODE: &str = "swarm";

/// Malformed swarm mode arguments.
pub const EXIT_USAGE: i32 = 2;
/// A recognized mode whose implementation does not exist in this build.
pub const EXIT_UNAVAILABLE: i32 = 3;
/// The broker could not start (busy authority, bind or publication failure).
pub const EXIT_START_FAILED: i32 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModeToken {
    Broker,
    Mcp,
    Cli,
}

/// How a foreground broker learns that it must stop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LifetimePolicy {
    /// Ctrl+C only.
    Signal,
    /// Ctrl+C or end of standard input (the launcher closed its pipe).
    Stdin,
    /// Ctrl+C or exit of this exact launcher process generation.
    Launcher(ProcessIdentity),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrokerArgs {
    pub data_dir: Option<PathBuf>,
    pub lifetime: LifetimePolicy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArgError {
    UnknownOption,
    MissingValue(&'static str),
    Duplicate(&'static str),
    NotUnicode,
    InvalidLifetime,
}

impl fmt::Display for ArgError {
    /// Fixed diagnostics only: the offending argv is never echoed.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownOption => write!(f, "unknown option"),
            Self::MissingValue(option) => write!(f, "{option} requires a value"),
            Self::Duplicate(option) => write!(f, "{option} was given more than once"),
            Self::NotUnicode => write!(f, "an argument is not valid Unicode"),
            Self::InvalidLifetime => write!(
                f,
                "--lifetime must be signal, stdin or launcher:<pid>:<creation-filetime>"
            ),
        }
    }
}

/// Recognizes a swarm mode from the intended first OS argument only.
pub fn recognize(first: Option<&OsStr>) -> Option<ModeToken> {
    match first.and_then(OsStr::to_str) {
        Some(BROKER_MODE) => Some(ModeToken::Broker),
        Some(MCP_MODE) => Some(ModeToken::Mcp),
        Some(CLI_MODE) => Some(ModeToken::Cli),
        _ => None,
    }
}

/// Strict broker argument parse: `--data-dir <path>` and
/// `--lifetime signal|stdin|launcher:<pid>:<filetime>`. Any other token,
/// missing value, duplicate or non-Unicode option or value is an error; the
/// broker never starts against a path it cannot represent exactly.
pub fn parse_broker_args(args: &[OsString]) -> Result<BrokerArgs, ArgError> {
    let mut data_dir = None;
    let mut lifetime = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.to_str().ok_or(ArgError::NotUnicode)? {
            "--data-dir" => {
                if data_dir.is_some() {
                    return Err(ArgError::Duplicate("--data-dir"));
                }
                let value = iter
                    .next()
                    .ok_or(ArgError::MissingValue("--data-dir"))?
                    .to_str()
                    .ok_or(ArgError::NotUnicode)?;
                data_dir = Some(PathBuf::from(value));
            }
            "--lifetime" => {
                if lifetime.is_some() {
                    return Err(ArgError::Duplicate("--lifetime"));
                }
                let value = iter
                    .next()
                    .ok_or(ArgError::MissingValue("--lifetime"))?
                    .to_str()
                    .ok_or(ArgError::NotUnicode)?;
                lifetime = Some(parse_lifetime(value)?);
            }
            _ => return Err(ArgError::UnknownOption),
        }
    }
    Ok(BrokerArgs {
        data_dir,
        lifetime: lifetime.unwrap_or(LifetimePolicy::Signal),
    })
}

fn parse_lifetime(value: &str) -> Result<LifetimePolicy, ArgError> {
    match value {
        "signal" => Ok(LifetimePolicy::Signal),
        "stdin" => Ok(LifetimePolicy::Stdin),
        other => {
            let rest = other
                .strip_prefix("launcher:")
                .ok_or(ArgError::InvalidLifetime)?;
            let (pid, filetime) = rest.split_once(':').ok_or(ArgError::InvalidLifetime)?;
            let pid = termx_swarm_client::DecimalU64::parse(pid)
                .ok()
                .and_then(|value| u32::try_from(value.get()).ok())
                .filter(|pid| *pid != 0)
                .ok_or(ArgError::InvalidLifetime)?;
            let filetime = termx_swarm_client::DecimalU64::parse(filetime)
                .map_err(|_| ArgError::InvalidLifetime)?
                .get();
            if filetime == 0 {
                return Err(ArgError::InvalidLifetime);
            }
            Ok(LifetimePolicy::Launcher(ProcessIdentity::new(
                pid, filetime,
            )))
        }
    }
}

/// Early dispatch. Returns `Some(exit_code)` for every recognized swarm first
/// token, including malformed trailing arguments; `None` when the first
/// token is not a swarm mode so ordinary host startup continues.
pub fn dispatch_early(args: impl Iterator<Item = OsString>) -> Option<i32> {
    let args = args.collect::<Vec<_>>();
    let mode = recognize(args.first().map(OsString::as_os_str))?;
    Some(match mode {
        ModeToken::Broker => match parse_broker_args(&args[1..]) {
            Ok(parsed) => runtime::run_broker_mode(parsed),
            Err(error) => {
                eprintln!("TermX swarm broker: {error}");
                EXIT_USAGE
            }
        },
        ModeToken::Mcp => {
            eprintln!("TermX swarm MCP mode is not available in this build");
            EXIT_UNAVAILABLE
        }
        ModeToken::Cli => {
            eprintln!("TermX swarm command-line mode is not available in this build");
            EXIT_UNAVAILABLE
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::ffi::OsStringExt;

    fn os(items: &[&str]) -> Vec<OsString> {
        items.iter().map(OsString::from).collect()
    }

    #[test]
    fn only_the_first_token_selects_a_mode() {
        assert_eq!(
            recognize(Some(OsStr::new("--swarm-broker"))),
            Some(ModeToken::Broker)
        );
        assert_eq!(
            recognize(Some(OsStr::new("--swarm-mcp"))),
            Some(ModeToken::Mcp)
        );
        assert_eq!(recognize(Some(OsStr::new("swarm"))), Some(ModeToken::Cli));
        assert_eq!(recognize(Some(OsStr::new("--data-dir"))), None);
        assert_eq!(recognize(Some(OsStr::new("--agent"))), None);
        assert_eq!(recognize(Some(OsStr::new("--SWARM-BROKER"))), None);
        assert_eq!(recognize(Some(OsStr::new("swarm "))), None);
        assert_eq!(recognize(None), None);
        assert_eq!(
            recognize(Some(&OsString::from_wide(&[0xD800]))),
            None,
            "a non-Unicode first token is never a mode"
        );
        assert_eq!(
            dispatch_early(os(&["--data-dir", "x", "swarm"]).into_iter()),
            None
        );
    }

    #[test]
    fn broker_arguments_are_strict_and_never_echoed() {
        assert_eq!(
            parse_broker_args(&os(&["--data-dir", "C:\\x"])),
            Ok(BrokerArgs {
                data_dir: Some(PathBuf::from("C:\\x")),
                lifetime: LifetimePolicy::Signal
            })
        );
        assert_eq!(
            parse_broker_args(&os(&["--lifetime", "stdin"]))
                .unwrap()
                .lifetime,
            LifetimePolicy::Stdin
        );
        assert_eq!(
            parse_broker_args(&os(&["--lifetime", "launcher:42:9007199254740993"]))
                .unwrap()
                .lifetime,
            LifetimePolicy::Launcher(ProcessIdentity::new(42, 9_007_199_254_740_993))
        );
        assert_eq!(
            parse_broker_args(&os(&["--bogus"])),
            Err(ArgError::UnknownOption)
        );
        assert_eq!(
            parse_broker_args(&os(&["--data-dir"])),
            Err(ArgError::MissingValue("--data-dir"))
        );
        assert_eq!(
            parse_broker_args(&os(&["--data-dir", "a", "--data-dir", "b"])),
            Err(ArgError::Duplicate("--data-dir"))
        );
        assert_eq!(
            parse_broker_args(&os(&["--lifetime", "launcher:0:1"])),
            Err(ArgError::InvalidLifetime)
        );
        assert_eq!(
            parse_broker_args(&os(&["--lifetime", "launcher:1:01"])),
            Err(ArgError::InvalidLifetime)
        );
        assert_eq!(
            parse_broker_args(&[OsString::from_wide(&[0xDC00])]),
            Err(ArgError::NotUnicode)
        );
        for error in [
            ArgError::UnknownOption,
            ArgError::MissingValue("--data-dir"),
            ArgError::NotUnicode,
            ArgError::InvalidLifetime,
        ] {
            assert!(!error.to_string().contains("bogus"));
        }
    }

    #[test]
    fn future_modes_return_unavailable_without_side_effects() {
        assert_eq!(
            dispatch_early(os(&["--swarm-mcp"]).into_iter()),
            Some(EXIT_UNAVAILABLE)
        );
        assert_eq!(
            dispatch_early(os(&["swarm", "status"]).into_iter()),
            Some(EXIT_UNAVAILABLE)
        );
        assert_eq!(
            dispatch_early(os(&["--swarm-broker", "--bogus"]).into_iter()),
            Some(EXIT_USAGE)
        );
        let mut non_unicode = os(&["--swarm-broker", "--data-dir"]);
        non_unicode.push(OsString::from_wide(&[0xD800]));
        assert_eq!(
            dispatch_early(non_unicode.into_iter()),
            Some(EXIT_USAGE),
            "a non-Unicode trailing argument still yields a mode result"
        );
    }
}
