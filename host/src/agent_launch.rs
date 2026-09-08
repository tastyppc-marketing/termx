//! Native Windows launch boundary for tracked Claude/Codex invocations.
//!
//! Shell integrations hand already-tokenized arguments to this executable.
//! Persisted resume arguments use a bounded base64url JSON envelope, never a
//! reconstructed shell command.

use anyhow::{bail, Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_ARGS: usize = 512;
const MAX_ARG_BYTES: usize = 24 * 1024;
const MAX_JSON_BYTES: usize = 24 * 1024;
const MAX_TOKEN_BYTES: usize = 32 * 1024;
const MAX_PROCESS_ANCESTORS: usize = 32;
const MAX_CAPTURE_INPUT_BYTES: usize = 64 * 1024;
const CAPTURES_FILE: &str = "conversation_captures_v1.jsonl";
const LAUNCHES_FILE: &str = "conversation_launches_v1.jsonl";
const CAPTURE_LOCK_FILE: &str = "conversation_captures_v1.lock";
const MAX_CAPTURE_LOG_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Provider {
    Claude,
    Codex,
}

impl Provider {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            _ => bail!("unsupported agent provider"),
        }
    }

    fn executable_stem(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct AgentInvocation {
    v: u8,
    provider: Provider,
    args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct LaunchStamp {
    v: u8,
    provider: Provider,
    args: Vec<String>,
    cwd: String,
    launcher_pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    launcher_created_at: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ProcessRow {
    pid: u32,
    parent_pid: u32,
    exe_name: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ResolvedProvider {
    program: PathBuf,
    leading_args: Vec<OsString>,
}

#[derive(Debug, Deserialize)]
struct CapturePayload {
    session_id: String,
    cwd: Option<String>,
    source: String,
    model: Option<serde_json::Value>,
    transcript_path: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
struct LaunchConfiguration {
    v: u8,
    provider: Provider,
    args: Vec<String>,
    cwd: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureRecord {
    v: u8,
    termx_session_id: u32,
    provider: Provider,
    id: String,
    cwd: Option<String>,
    at_ms: u64,
    launch: LaunchConfiguration,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    transcript_path: Option<String>,
    launcher_pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    launcher_created_at: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum EarlyCommand {
    Launch(AgentInvocation),
    Capture(Provider),
}

fn encode_token<T: Serialize>(value: &T) -> Result<String> {
    let json = serde_json::to_vec(value).context("encoding agent launch")?;
    if json.len() > MAX_JSON_BYTES {
        bail!("agent launch payload is too large");
    }
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json))
}

fn decode_invocation(token: &str) -> Result<AgentInvocation> {
    if token.is_empty() || token.len() > MAX_TOKEN_BYTES || !token.is_ascii() {
        bail!("invalid agent launch token");
    }
    let json = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token)
        .context("decoding agent launch token")?;
    if json.len() > MAX_JSON_BYTES {
        bail!("agent launch payload is too large");
    }
    let invocation: AgentInvocation =
        serde_json::from_slice(&json).context("parsing agent launch payload")?;
    validate_invocation(&invocation)?;
    Ok(invocation)
}

fn validate_invocation(invocation: &AgentInvocation) -> Result<()> {
    if invocation.v != 1 {
        bail!("unsupported agent launch version");
    }
    if invocation.args.len() > MAX_ARGS {
        bail!("too many agent arguments");
    }
    for arg in &invocation.args {
        if arg.contains('\0') || arg.len() > MAX_ARG_BYTES {
            bail!("invalid agent argument");
        }
    }
    if let Some(cwd) = &invocation.cwd {
        if cwd.is_empty() || cwd.contains('\0') || cwd.len() > MAX_ARG_BYTES {
            bail!("invalid agent cwd");
        }
    }
    if serde_json::to_vec(invocation)?.len() > MAX_JSON_BYTES {
        bail!("agent launch payload is too large");
    }
    Ok(())
}

fn ancestry_matches(
    provider: Provider,
    launcher_pid: u32,
    current_pid: u32,
    rows: &[ProcessRow],
) -> bool {
    if launcher_pid == 0 || current_pid == 0 || launcher_pid == current_pid {
        return false;
    }
    let by_pid: HashMap<u32, &ProcessRow> = rows.iter().map(|row| (row.pid, row)).collect();
    if by_pid.len() != rows.len() {
        return false;
    }
    let mut cursor = current_pid;
    let mut seen = HashSet::new();
    let mut provider_processes = 0usize;
    let mut node_processes = 0usize;
    let mut nested_launcher = false;
    let mut direct_child_stem: Option<String> = None;
    for _ in 0..MAX_PROCESS_ANCESTORS {
        if !seen.insert(cursor) {
            return false;
        }
        let Some(row) = by_pid.get(&cursor) else {
            return false;
        };
        if cursor == launcher_pid {
            let launcher_is_host = std::path::Path::new(&row.exe_name)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .is_some_and(is_termx_host_stem);
            let direct = direct_child_stem.as_deref().unwrap_or_default();
            let trusted_provider = match provider {
                Provider::Claude => {
                    (direct.eq_ignore_ascii_case("claude")
                        && provider_processes == 1
                        && node_processes == 0)
                        || (direct.eq_ignore_ascii_case("node")
                            && provider_processes == 0
                            && node_processes == 1)
                }
                Provider::Codex => {
                    provider_processes == 1
                        && (direct.eq_ignore_ascii_case("codex")
                            || direct.eq_ignore_ascii_case("node"))
                }
            };
            return launcher_is_host && !nested_launcher && trusted_provider;
        }
        let stem = std::path::Path::new(&row.exe_name)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default();
        provider_processes += usize::from(stem.eq_ignore_ascii_case(provider.executable_stem()));
        if cursor != current_pid {
            node_processes += usize::from(stem.eq_ignore_ascii_case("node"));
            nested_launcher |= is_termx_host_stem(stem);
        }
        if row.parent_pid == launcher_pid {
            direct_child_stem = Some(stem.to_string());
        }
        cursor = row.parent_pid;
        if cursor == 0 {
            return false;
        }
    }
    false
}

fn is_termx_host_stem(stem: &str) -> bool {
    [
        "termx-host",
        "termx-host-x86_64-pc-windows-msvc",
        "termx-host-x86_64-pc-windows-gnu",
    ]
    .iter()
    .any(|expected| stem.eq_ignore_ascii_case(expected))
}

fn resolve_provider_in_paths(provider: Provider, path_var: &std::ffi::OsStr) -> Result<ResolvedProvider> {
    let directories = std::env::split_paths(path_var).collect::<Vec<_>>();
    let executable = format!("{}.exe", provider.executable_stem());
    for directory in &directories {
        let program = directory.join(&executable);
        if program.is_file() {
            return Ok(ResolvedProvider {
                program,
                leading_args: Vec::new(),
            });
        }
        let shim = directory.join(format!("{}.cmd", provider.executable_stem()));
        if !shim.is_file() {
            continue;
        }
        if let Some(resolved) = resolve_verified_npm(provider, directory, &directories) {
            return Ok(resolved);
        }
    }
    bail!("agent provider executable was not found")
}

fn launch_with_paths(invocation: AgentInvocation, path_var: &std::ffi::OsStr) -> Result<i32> {
    validate_invocation(&invocation)?;
    let cwd = match &invocation.cwd {
        Some(value) => {
            let path = PathBuf::from(value);
            if !path.is_absolute() || !path.is_dir() {
                bail!("agent cwd must be an existing absolute directory");
            }
            path
        }
        None => std::env::current_dir().context("resolving agent cwd")?,
    };
    let resolved = resolve_provider_in_paths(invocation.provider, path_var)?;
    let stamp = LaunchStamp {
        v: 1,
        provider: invocation.provider,
        args: invocation.args.clone(),
        cwd: cwd.display().to_string(),
        launcher_pid: std::process::id(),
        launcher_created_at: launcher_creation_time(std::process::id()),
    };
    let stamp_token = encode_token(&stamp)?;
    let mut child = std::process::Command::new(&resolved.program)
        .args(&resolved.leading_args)
        .args(&invocation.args)
        .current_dir(&cwd)
        .env("TERMX_AGENT_LAUNCH", stamp_token)
        .spawn()
        .context("starting agent provider")?;
    let status = child.wait().context("waiting for agent provider")?;
    Ok(status.code().unwrap_or(1))
}

fn capture_from_parts(
    provider: Provider,
    payload: &[u8],
    pane_id: &str,
    launch_token: &str,
    current_pid: u32,
    rows: &[ProcessRow],
    at_ms: u64,
) -> Option<CaptureRecord> {
    if payload.len() > MAX_CAPTURE_INPUT_BYTES {
        return None;
    }
    let payload: CapturePayload = serde_json::from_slice(payload).ok()?;
    if !matches!(payload.source.as_str(), "startup" | "resume" | "clear")
        || !valid_conversation_id(&payload.session_id)
    {
        return None;
    }
    let pane_id = pane_id.parse::<u32>().ok()?;
    let stamp = decode_stamp(launch_token).ok()?;
    if stamp.provider != provider
        || !ancestry_matches(provider, stamp.launcher_pid, current_pid, rows)
    {
        return None;
    }
    let cwd = match payload.cwd {
        Some(value) if !value.is_empty() && !value.contains('\0') && value.len() <= MAX_ARG_BYTES => {
            Some(value)
        }
        Some(_) => return None,
        None => None,
    };
    Some(CaptureRecord {
        v: 1,
        termx_session_id: pane_id,
        provider,
        id: payload.session_id,
        cwd,
        at_ms,
        model: payload.model.as_ref().and_then(serde_json::Value::as_str)
            .filter(|model| !model.trim().is_empty() && model.chars().count() <= 128
                && !model.chars().any(char::is_control)).map(str::to_string),
        transcript_path: payload.transcript_path.as_ref().and_then(serde_json::Value::as_str)
            .filter(|path| !path.is_empty() && path.len() <= MAX_ARG_BYTES && !path.contains('\0'))
            .map(str::to_string),
        launcher_pid: stamp.launcher_pid,
        launcher_created_at: None,
        launch: LaunchConfiguration {
            v: 1,
            provider,
            args: stamp.args,
            cwd: Some(stamp.cwd),
        },
    })
}

fn append_capture(data_dir: &Path, record: &CaptureRecord) -> Result<()> {
    append_capture_with_liveness(data_dir, record, |pid, created| {
        launcher_creation_time(pid).as_deref() == Some(created)
    })
}

fn append_capture_with_liveness(
    data_dir: &Path,
    record: &CaptureRecord,
    mut is_live: impl FnMut(u32, &str) -> bool,
) -> Result<()> {
    std::fs::create_dir_all(data_dir).context("creating capture data directory")?;
    let _lock = capture_lock(data_dir)?;
    let capture_path = data_dir.join(CAPTURES_FILE);
    let text = read_capture_log(&capture_path)?;
    let mut launches: HashMap<(u64, u32, String), serde_json::Value> = HashMap::new();
    let mut incoming = serde_json::to_value(record).context("encoding conversation capture")?;
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { continue; };
        let Some(pane) = value.get("termxSessionId").and_then(serde_json::Value::as_u64)
            .filter(|pane| *pane <= u64::from(u32::MAX)) else { continue; };
        if value.get("v").and_then(serde_json::Value::as_u64).is_some_and(|v| v != 1)
            || !matches!(value.get("provider").and_then(serde_json::Value::as_str), Some("claude" | "codex"))
            || !value.get("id").and_then(serde_json::Value::as_str).is_some_and(valid_conversation_id) {
            continue;
        }
        // A later same-launch hook cannot erase already-recorded ambiguity,
        // even if a different pane's capture has since won the current index.
        if same_captured_launch(&value, &incoming) && value.get("modelAmbiguous").and_then(serde_json::Value::as_bool) == Some(true) {
            incoming["modelAmbiguous"] = true.into();
        }
        if value.get("provider") != incoming.get("provider") || value.get("id") != incoming.get("id") {
            continue;
        }
        let Some((pid, created)) = captured_identity(&value) else { continue; };
        let identity = (pane, pid, created.to_owned());
        // A nested/newer conversation can replace the pane's visible capture
        // while an older launcher is still alive. Check each exact invocation.
        match launches.get(&identity) {
            Some(previous) if !capture_replaces(previous, &value) => {}
            _ => { launches.insert(identity, value); }
        }
    }
    let mut updates = Vec::new();
    for previous in launches.values() {
        if previous.get("termxSessionId") == incoming.get("termxSessionId") && same_captured_launch(previous, &incoming) {
            continue;
        }
        let Some((pid, created)) = captured_identity(previous) else { continue; };
        if is_live(pid, created) {
            let mut peer = previous.clone();
            peer["modelAmbiguous"] = true.into();
            updates.push(peer);
            incoming["modelAmbiguous"] = true.into();
        }
    }
    let line = capture_json_line(&incoming)?;
    // The original launch log remains append-only and receives the incoming
    // native record only. Peer annotations preserve every rich/raw field and
    // only add modelAmbiguous in the pane capture log.
    let mut batch = Vec::new();
    for peer in updates { batch.extend(capture_json_line(&peer)?); }
    batch.extend_from_slice(&line);
    append_line(&data_dir.join(LAUNCHES_FILE), &line, true)?;
    append_line(&capture_path, &batch, true)?;
    Ok(())
}

fn captured_identity(value: &serde_json::Value) -> Option<(u32, &str)> {
    let pid = value.get("launcherPid")?.as_u64().filter(|pid| *pid > 0 && *pid <= u64::from(u32::MAX))? as u32;
    let created = value.get("launcherCreatedAt")?.as_str()?;
    if created.is_empty() || created.len() > 20 || !created.bytes().all(|byte| byte.is_ascii_digit())
        || created.parse::<u64>().ok()? == 0 { return None; }
    Some((pid, created))
}

fn same_captured_launch(left: &serde_json::Value, right: &serde_json::Value) -> bool {
    left.get("provider") == right.get("provider") && left.get("id") == right.get("id")
        && captured_identity(left).is_some() && captured_identity(left) == captured_identity(right)
}

fn capture_replaces(previous: &serde_json::Value, next: &serde_json::Value) -> bool {
    if same_captured_launch(previous, next) && previous.get("launch").is_some() != next.get("launch").is_some() {
        return next.get("launch").is_some();
    }
    next.get("atMs").and_then(serde_json::Value::as_u64).unwrap_or(0)
        >= previous.get("atMs").and_then(serde_json::Value::as_u64).unwrap_or(0)
}

fn capture_json_line(value: &serde_json::Value) -> Result<Vec<u8>> {
    let mut line = serde_json::to_vec(value).context("encoding capture annotation")?;
    if line.len() > MAX_CAPTURE_INPUT_BYTES { bail!("conversation capture is too large"); }
    line.push(b'\n');
    Ok(line)
}

fn read_capture_log(path: &Path) -> Result<String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(error).context("opening capture log"),
    };
    let mut bytes = Vec::new();
    file.take(MAX_CAPTURE_LOG_BYTES + 1).read_to_end(&mut bytes).context("reading capture log")?;
    if bytes.len() as u64 > MAX_CAPTURE_LOG_BYTES { bail!("capture log exceeds the bounded overlap scan"); }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Persistent lock-file handle, not file existence, owns the lock. A crashed
/// hook releases the handle automatically; later hooks never delete the log.
fn capture_lock(data_dir: &Path) -> Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    loop {
        match std::fs::OpenOptions::new().read(true).write(true).create(true).share_mode(0)
            .open(data_dir.join(CAPTURE_LOCK_FILE)) {
            Ok(file) => return Ok(file),
            Err(error) if matches!(error.raw_os_error(), Some(32 | 33)) && std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(error) => return Err(error).context("locking capture transaction"),
        }
    }
}

fn process_snapshot() -> Result<Vec<ProcessRow>> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error()).context("taking process snapshot");
    }
    struct Snapshot(windows_sys::Win32::Foundation::HANDLE);
    impl Drop for Snapshot {
        fn drop(&mut self) {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.0);
            }
        }
    }
    let _snapshot = Snapshot(snapshot);
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    let mut rows = Vec::new();
    while ok {
        let length = entry
            .szExeFile
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(entry.szExeFile.len());
        rows.push(ProcessRow {
            pid: entry.th32ProcessID,
            parent_pid: entry.th32ParentProcessID,
            exe_name: String::from_utf16_lossy(&entry.szExeFile[..length]),
        });
        ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    Ok(rows)
}

fn parse_early_args(args: Vec<OsString>) -> Result<Option<EarlyCommand>> {
    let Some(mode) = args.first().and_then(|value| value.to_str()) else {
        return Ok(None);
    };
    match mode {
        "--agent" => {
            if args.len() < 3 || args[2] != "--" {
                bail!("invalid direct agent launch");
            }
            let provider = args[1]
                .to_str()
                .context("invalid agent provider")
                .and_then(Provider::parse)?;
            let forwarded = args[3..]
                .iter()
                .map(|arg| {
                    arg.to_str()
                        .map(str::to_string)
                        .context("agent argument is not valid Unicode")
                })
                .collect::<Result<Vec<_>>>()?;
            let invocation = AgentInvocation {
                v: 1,
                provider,
                args: forwarded,
                cwd: None,
            };
            validate_invocation(&invocation)?;
            Ok(Some(EarlyCommand::Launch(invocation)))
        }
        "--agent-json" => {
            if args.len() != 2 {
                bail!("invalid structured agent launch");
            }
            let token = args[1].to_str().context("invalid agent launch token")?;
            Ok(Some(EarlyCommand::Launch(decode_invocation(token)?)))
        }
        "--capture-agent" => {
            if args.len() != 2 {
                bail!("invalid agent capture invocation");
            }
            let provider = args[1]
                .to_str()
                .context("invalid agent provider")
                .and_then(Provider::parse)?;
            Ok(Some(EarlyCommand::Capture(provider)))
        }
        _ => Ok(None),
    }
}

fn decode_stamp(token: &str) -> Result<LaunchStamp> {
    if token.is_empty() || token.len() > MAX_TOKEN_BYTES || !token.is_ascii() {
        bail!("invalid agent launch token");
    }
    let json = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token)
        .context("decoding agent launch token")?;
    if json.len() > MAX_JSON_BYTES {
        bail!("agent launch payload is too large");
    }
    let stamp: LaunchStamp = serde_json::from_slice(&json).context("parsing agent launch stamp")?;
    validate_invocation(&AgentInvocation {
        v: stamp.v,
        provider: stamp.provider,
        args: stamp.args.clone(),
        cwd: Some(stamp.cwd.clone()),
    })?;
    if stamp.launcher_pid == 0 {
        bail!("invalid agent launcher pid");
    }
    Ok(stamp)
}

fn valid_conversation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().next().is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn append_line(path: &Path, line: &[u8], durable: bool) -> Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("opening {}", path.display()))?;
    file.write_all(line)
        .with_context(|| format!("appending {}", path.display()))?;
    if durable {
        file.sync_data()
            .with_context(|| format!("syncing {}", path.display()))?;
    }
    Ok(())
}

fn resolve_verified_npm(
    provider: Provider,
    shim_directory: &Path,
    path_directories: &[PathBuf],
) -> Option<ResolvedProvider> {
    let (package_name, package_relative, entry_relative) = match provider {
        Provider::Codex => ("@openai/codex", r"node_modules\@openai\codex", r"bin\codex.js"),
        Provider::Claude => (
            "@anthropic-ai/claude-code",
            r"node_modules\@anthropic-ai\claude-code",
            "cli.js",
        ),
    };
    let package = shim_directory.join(package_relative);
    let package_json = std::fs::read(package.join("package.json")).ok()?;
    if package_json.len() > 64 * 1024 {
        return None;
    }
    let manifest: serde_json::Value = serde_json::from_slice(&package_json).ok()?;
    if manifest.get("name")?.as_str()? != package_name {
        return None;
    }
    if manifest
            .get("bin")?
            .get(provider.executable_stem())?
            .as_str()?
            .replace('/', "\\")
            != entry_relative
    {
        // Current native Claude packages declare bin/claude.exe rather than
        // the older cli.js. Verify and launch that fixed entry directly.
        if provider != Provider::Claude
            || manifest.get("bin")?.get("claude")?.as_str()?.replace('/', "\\")
                != r"bin\claude.exe"
        {
            return None;
        }
        let native = verified_package_entry(&package, Path::new(r"bin\claude.exe"))?;
        return Some(ResolvedProvider {
            program: native,
            leading_args: Vec::new(),
        });
    }
    let entry = verified_package_entry(&package, Path::new(entry_relative))?;
    let node = std::iter::once(shim_directory.join("node.exe"))
        .chain(path_directories.iter().map(|directory| directory.join("node.exe")))
        .find(|candidate| candidate.is_file())?;
    Some(ResolvedProvider {
        program: node,
        leading_args: vec![entry.into_os_string()],
    })
}

fn verified_package_entry(package: &Path, relative: &Path) -> Option<PathBuf> {
    let root = std::fs::canonicalize(package).ok()?;
    let candidate = package.join(relative);
    let entry = std::fs::canonicalize(&candidate).ok()?;
    (entry.is_file() && entry.starts_with(root)).then_some(candidate)
}

/// Handle helper modes before daemon argument parsing and logging. `None`
/// means this is an ordinary daemon invocation.
pub fn dispatch_early(args: impl Iterator<Item = OsString>) -> Option<i32> {
    let args = args.collect::<Vec<_>>();
    let mode = args.first().and_then(|arg| arg.to_str());
    if mode == Some("--capture-agent") {
        if let Ok(Some(EarlyCommand::Capture(provider))) = parse_early_args(args) {
            capture_silently(provider);
        }
        return Some(0);
    }
    if !matches!(mode, Some("--agent" | "--agent-json")) {
        return None;
    }
    let result = parse_early_args(args).and_then(|command| match command {
        Some(EarlyCommand::Launch(invocation)) => {
            let path = std::env::var_os("PATH").unwrap_or_default();
            launch_with_paths(invocation, &path)
        }
        _ => bail!("invalid agent launch mode"),
    });
    match result {
        Ok(code) => Some(code),
        Err(_) => {
            // Never include the preserved argv in diagnostics.
            eprintln!("TermX could not start the agent");
            Some(2)
        }
    }
}

fn capture_silently(provider: Provider) {
    let Some(pane_id) = std::env::var("TERMX_SESSION_ID").ok() else {
        return;
    };
    let Some(launch_token) = std::env::var("TERMX_AGENT_LAUNCH").ok() else {
        return;
    };
    let Some(data_dir) = std::env::var_os("TERMX_DATA_DIR").map(PathBuf::from) else {
        return;
    };
    let mut payload = Vec::new();
    if std::io::stdin()
        .lock()
        .take((MAX_CAPTURE_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut payload)
        .is_err()
        || payload.len() > MAX_CAPTURE_INPUT_BYTES
    {
        return;
    }
    let Ok(rows) = process_snapshot() else {
        return;
    };
    let Some(mut record) = capture_from_parts(
        provider,
        &payload,
        &pane_id,
        &launch_token,
        std::process::id(),
        &rows,
        now_ms(),
    ) else {
        return;
    };
    record.launcher_created_at = launcher_creation_time(record.launcher_pid);
    let _ = append_capture(&data_dir, &record);
}

/// Query the exact launcher identity without relying on PID permanence. The
/// status reader will verify this timestamp and every live ancestry edge.
fn launcher_creation_time(pid: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, WaitForSingleObject,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() { return None; }
    let mut created: FILETIME = unsafe { std::mem::zeroed() };
    let mut exited = created;
    let mut kernel = created;
    let mut user = created;
    let valid = unsafe {
        GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) != 0
            && WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
    };
    unsafe { CloseHandle(handle); }
    let timestamp = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    (valid && timestamp > 0).then(|| timestamp.to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn invocation() -> AgentInvocation {
        AgentInvocation {
            v: 1,
            provider: Provider::Claude,
            args: vec![
                "plain".into(),
                "".into(),
                "quoted value".into(),
                "^&|<>%".into(),
                "雪だるま".into(),
            ],
            cwd: Some(r"C:\work tree".into()),
        }
    }

    #[test]
    fn structured_token_round_trips_empty_metacharacter_and_unicode_arguments() {
        let want = invocation();
        let token = encode_token(&want).unwrap();
        assert!(!token.contains(['+', '/', '=']));
        assert_eq!(decode_invocation(&token).unwrap(), want);
    }

    #[test]
    fn invocation_validation_rejects_wrong_version_nul_and_oversize_input() {
        let mut value = invocation();
        value.v = 2;
        assert!(validate_invocation(&value).is_err());

        value = invocation();
        value.args[0].push('\0');
        assert!(validate_invocation(&value).is_err());

        value = invocation();
        value.args = vec!["x".repeat(MAX_JSON_BYTES + 1)];
        assert!(validate_invocation(&value).is_err());
    }

    #[test]
    fn ancestry_requires_one_matching_provider_below_the_live_launcher() {
        let valid = vec![
            ProcessRow { pid: 40, parent_pid: 30, exe_name: "termx-host.exe".into() },
            ProcessRow { pid: 30, parent_pid: 20, exe_name: "python.exe".into() },
            ProcessRow { pid: 20, parent_pid: 10, exe_name: "claude.exe".into() },
            ProcessRow { pid: 10, parent_pid: 1, exe_name: "termx-host.exe".into() },
        ];
        assert!(ancestry_matches(Provider::Claude, 10, 40, &valid));
        assert!(!ancestry_matches(Provider::Codex, 10, 40, &valid));

        let nested = vec![
            ProcessRow { pid: 50, parent_pid: 25, exe_name: "termx-host.exe".into() },
            ProcessRow { pid: 25, parent_pid: 20, exe_name: "claude.exe".into() },
            ProcessRow { pid: 20, parent_pid: 10, exe_name: "claude.exe".into() },
            ProcessRow { pid: 10, parent_pid: 1, exe_name: "termx-host.exe".into() },
        ];
        assert!(
            !ancestry_matches(Provider::Claude, 10, 50, &nested),
            "a nested direct same-provider launch must not inherit the parent's settings"
        );

        let shared_daemon = vec![
            ProcessRow { pid: 60, parent_pid: 55, exe_name: "termx-host.exe".into() },
            ProcessRow { pid: 55, parent_pid: 1, exe_name: "codex.exe".into() },
            ProcessRow { pid: 10, parent_pid: 1, exe_name: "termx-host.exe".into() },
        ];
        assert!(!ancestry_matches(Provider::Codex, 10, 60, &shared_daemon));

        let legacy_node = vec![
            ProcessRow { pid: 40, parent_pid: 20, exe_name: "termx-host.exe".into() },
            ProcessRow { pid: 20, parent_pid: 10, exe_name: "node.exe".into() },
            ProcessRow { pid: 10, parent_pid: 1, exe_name: "termx-host.exe".into() },
        ];
        assert!(
            ancestry_matches(Provider::Claude, 10, 40, &legacy_node),
            "the verified legacy Claude npm launcher is one node child"
        );
        let nested_node = vec![
            ProcessRow { pid: 40, parent_pid: 25, exe_name: "termx-host.exe".into() },
            ProcessRow { pid: 25, parent_pid: 20, exe_name: "node.exe".into() },
            ProcessRow { pid: 20, parent_pid: 10, exe_name: "node.exe".into() },
            ProcessRow { pid: 10, parent_pid: 1, exe_name: "termx-host.exe".into() },
        ];
        assert!(
            !ancestry_matches(Provider::Claude, 10, 40, &nested_node),
            "a nested legacy Node provider must not reuse its parent's launch"
        );
        let native_nested_below_legacy_node = vec![
            ProcessRow { pid: 40, parent_pid: 25, exe_name: "termx-host.exe".into() },
            ProcessRow { pid: 25, parent_pid: 20, exe_name: "claude.exe".into() },
            ProcessRow { pid: 20, parent_pid: 10, exe_name: "node.exe".into() },
            ProcessRow { pid: 10, parent_pid: 1, exe_name: "termx-host.exe".into() },
        ];
        assert!(
            !ancestry_matches(Provider::Claude, 10, 40, &native_nested_below_legacy_node),
            "a native nested Claude below a legacy Node Claude is still nested"
        );

        let packaged_launcher = vec![
            ProcessRow { pid: 40, parent_pid: 20, exe_name: "termx-host.exe".into() },
            ProcessRow { pid: 20, parent_pid: 10, exe_name: "claude.exe".into() },
            ProcessRow {
                pid: 10,
                parent_pid: 1,
                exe_name: "termx-host-x86_64-pc-windows-msvc.exe".into(),
            },
        ];
        assert!(
            ancestry_matches(Provider::Claude, 10, 40, &packaged_launcher),
            "the packaged host executable name must remain a trusted launcher"
        );
    }

    #[test]
    fn provider_resolution_prefers_an_exe_and_accepts_only_a_verified_npm_layout() {
        let tmp = tempfile::tempdir().unwrap();
        let first = tmp.path().join("first");
        let second = tmp.path().join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        std::fs::write(first.join("codex.cmd"), "untrusted batch content").unwrap();
        std::fs::write(second.join("codex.exe"), "fake exe").unwrap();
        let path = std::env::join_paths([&first, &second]).unwrap();
        assert_eq!(
            resolve_provider_in_paths(Provider::Codex, &path).unwrap(),
            ResolvedProvider { program: second.join("codex.exe"), leading_args: vec![] }
        );

        std::fs::remove_file(second.join("codex.exe")).unwrap();
        assert!(
            resolve_provider_in_paths(Provider::Codex, OsStr::new(first.as_os_str())).is_err(),
            "an arbitrary cmd file must never be executed"
        );
        let package = first.join(r"node_modules\@openai\codex");
        std::fs::create_dir_all(package.join("bin")).unwrap();
        std::fs::write(first.join("node.exe"), "fake node").unwrap();
        std::fs::write(package.join("bin").join("codex.js"), "// cli").unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@openai/codex","bin":{"codex":"bin/codex.js"}}"#,
        )
        .unwrap();
        assert_eq!(
            resolve_provider_in_paths(Provider::Codex, first.as_os_str()).unwrap(),
            ResolvedProvider {
                program: first.join("node.exe"),
                leading_args: vec![package.join("bin").join("codex.js").into_os_string()],
            }
        );


        std::fs::write(second.join("codex.exe"), "later fake exe").unwrap();
        let path = std::env::join_paths([&first, &second]).unwrap();
        assert_eq!(
            resolve_provider_in_paths(Provider::Codex, &path).unwrap(),
            ResolvedProvider {
                program: first.join("node.exe"),
                leading_args: vec![package.join("bin").join("codex.js").into_os_string()],
            },
            "a verified shim in an earlier PATH directory wins over a later exe"
        );

        let claude_dir = tmp.path().join("claude-mismatch");
        let claude_package = claude_dir.join(r"node_modules\@anthropic-ai\claude-code");
        std::fs::create_dir_all(claude_package.join("bin")).unwrap();
        std::fs::write(claude_dir.join("claude.cmd"), "shim").unwrap();
        std::fs::write(claude_package.join("bin").join("claude.exe"), "native").unwrap();
        std::fs::write(
            claude_package.join("package.json"),
            r#"{"name":"attacker/package","bin":{"claude":"bin/claude.exe"}}"#,
        )
        .unwrap();
        assert!(
            resolve_provider_in_paths(Provider::Claude, claude_dir.as_os_str()).is_err(),
            "the native Claude fallback must still verify the package identity"
        );
    }

    fn build_argv_dumper(directory: &Path, name: &str) -> PathBuf {
        let source = directory.join("argv_dumper.rs");
        let executable = directory.join(name);
        std::fs::write(
            &source,
            r#"
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
fn main() {
    let cwd = std::env::current_dir().unwrap();
    let mut out = std::fs::File::create(cwd.join("argv.dump")).unwrap();
    for arg in std::env::args_os().skip(1) {
        let units: Vec<String> = arg.encode_wide().map(|unit| unit.to_string()).collect();
        writeln!(out, "{}:{}", units.len(), units.join(",")).unwrap();
    }
    std::fs::write(cwd.join("stamp.dump"), std::env::var("TERMX_AGENT_LAUNCH").unwrap()).unwrap();
    std::process::exit(23);
}
"#,
        )
        .unwrap();
        let status = std::process::Command::new("rustc")
            .args([source.as_os_str(), OsStr::new("-o"), executable.as_os_str()])
            .status()
            .unwrap();
        assert!(status.success(), "failed to compile argv dumper");
        executable
    }

    fn read_dump(path: &Path) -> Vec<String> {
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
    fn native_launcher_preserves_real_windows_argv_and_stamps_the_actual_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        build_argv_dumper(tmp.path(), "codex.exe");
        let want = vec!["plain", "", "a b", "^&|<>%", "雪だるま"]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        let invocation = AgentInvocation {
            v: 1,
            provider: Provider::Codex,
            args: want.clone(),
            cwd: Some(tmp.path().display().to_string()),
        };

        assert_eq!(launch_with_paths(invocation, tmp.path().as_os_str()).unwrap(), 23);
        assert_eq!(read_dump(&tmp.path().join("argv.dump")), want);
        let stamp_token = std::fs::read_to_string(tmp.path().join("stamp.dump")).unwrap();
        let stamp_json = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(stamp_token)
            .unwrap();
        let stamp: LaunchStamp = serde_json::from_slice(&stamp_json).unwrap();
        assert_eq!(stamp.provider, Provider::Codex);
        assert_eq!(stamp.args, want);
        assert_eq!(stamp.cwd, tmp.path().display().to_string());
        assert_eq!(stamp.launcher_pid, std::process::id());
    }

    fn valid_rows(provider: Provider, launcher_pid: u32, current_pid: u32) -> Vec<ProcessRow> {
        vec![
            ProcessRow { pid: current_pid, parent_pid: 30, exe_name: "termx-host.exe".into() },
            ProcessRow {
                pid: 30,
                parent_pid: launcher_pid,
                exe_name: format!("{}.exe", provider.executable_stem()),
            },
            ProcessRow { pid: launcher_pid, parent_pid: 1, exe_name: "termx-host.exe".into() },
        ]
    }

    #[test]
    fn capture_validates_identity_and_appends_the_same_launch_record_to_both_logs() {
        let tmp = tempfile::tempdir().unwrap();
        let stamp = LaunchStamp {
            v: 1,
            provider: Provider::Claude,
            args: vec!["--model".into(), "opus".into()],
            cwd: r"C:\launch".into(),
            launcher_pid: 10,
            launcher_created_at: None,
        };
        let token = encode_token(&stamp).unwrap();
        let payload = br#"{"session_id":"abc-123","cwd":"C:\\hook","source":"startup"}"#;
        let rows = valid_rows(Provider::Claude, 10, 40);
        let record = capture_from_parts(Provider::Claude, payload, "7", &token, 40, &rows, 55)
            .expect("valid explicit launch capture");
        assert_eq!(record.termx_session_id, 7);
        assert_eq!(record.id, "abc-123");
        assert_eq!(record.cwd.as_deref(), Some(r"C:\hook"));
        assert_eq!(record.launch.args, vec!["--model", "opus"]);

        append_capture(tmp.path(), &record).unwrap();
        let captures = std::fs::read_to_string(tmp.path().join(CAPTURES_FILE)).unwrap();
        let launches = std::fs::read_to_string(tmp.path().join(LAUNCHES_FILE)).unwrap();
        assert_eq!(captures, launches);
        assert_eq!(captures.lines().count(), 1);

        assert!(capture_from_parts(Provider::Codex, payload, "7", &token, 40, &rows, 55).is_none());
        assert!(capture_from_parts(Provider::Claude, payload, "not-a-pane", &token, 40, &rows, 55).is_none());
        assert!(capture_from_parts(
            Provider::Claude,
            br#"{"session_id":"bad/id","cwd":"C:\\hook","source":"startup"}"#,
            "7",
            &token,
            40,
            &rows,
            55,
        )
        .is_none());
    }

    #[test]
    fn capture_preserves_bounded_opaque_runtime_metadata_without_guessing_models() {
        let stamp = LaunchStamp { v: 1, provider: Provider::Claude, args: vec!["--model".into(), "opus".into()], cwd: r"C:\launch".into(), launcher_pid: 10, launcher_created_at: None };
        let token = encode_token(&stamp).unwrap();
        let rows = valid_rows(Provider::Claude, 10, 40);
        let payload = br#"{"session_id":"abc-123","source":"startup","model":"gpt-6-astra","transcript_path":"C:\\sessions\\one.jsonl"}"#;
        let record = capture_from_parts(Provider::Claude, payload, "7", &token, 40, &rows, 55).unwrap();
        let json = serde_json::to_value(record).unwrap();
        assert_eq!(json["model"], "gpt-6-astra");
        assert_eq!(json["transcriptPath"], r"C:\sessions\one.jsonl");
        assert_eq!(json["launcherPid"], 10);
        for model in [serde_json::json!("x".repeat(129)), serde_json::json!("bad\nmodel"), serde_json::json!(42), serde_json::Value::Null] {
            let payload = serde_json::to_vec(&serde_json::json!({"session_id":"abc-123", "source":"startup", "model": model})).unwrap();
            let record = capture_from_parts(Provider::Claude, &payload, "7", &token, 40, &rows, 55).unwrap();
            assert!(serde_json::to_value(record).unwrap().get("model").is_none_or(serde_json::Value::is_null));
        }
    }

    #[test]
    fn capture_reads_the_current_process_creation_identity_without_rounding() {
        let first = launcher_creation_time(std::process::id()).unwrap();
        assert_eq!(launcher_creation_time(std::process::id()).as_deref(), Some(first.as_str()));
        assert!(first.parse::<u64>().unwrap() > 9_007_199_254_740_991);
        assert_eq!(launcher_creation_time(0), None);
    }

    fn overlap_record(pane: u32, pid: u32, at_ms: u64) -> CaptureRecord {
        CaptureRecord {
            v: 1, termx_session_id: pane, provider: Provider::Claude, id: "shared-123".into(),
            cwd: Some(r"C:\same-folder".into()), at_ms,
            launch: LaunchConfiguration { v: 1, provider: Provider::Claude, args: vec!["--model".into(), format!("model-{pane}")], cwd: Some(r"C:\same-folder".into()) },
            model: Some(format!("model-{pane}")), transcript_path: Some(r"C:\sessions\shared-123.jsonl".into()),
            launcher_pid: pid, launcher_created_at: Some(format!("13400000000000{pid:04}")),
        }
    }

    #[test]
    fn source_overlap_remains_marked_when_the_second_launcher_exits_before_any_ui_read() {
        let tmp = tempfile::tempdir().unwrap();
        use std::os::windows::process::CommandExt;
        // This isolated helper exits naturally. No UI reader runs until after
        // its exit, reproducing the short-lived overlapping invocation.
        let mut child = std::process::Command::new(std::env::var_os("ComSpec").unwrap())
            .args(["/D", "/C", "ping -n 2 127.0.0.1 >nul"])
            .creation_flags(0x0800_0000).spawn().unwrap();
        let pid = std::process::id();
        let mut a = overlap_record(1, pid, 1000);
        a.launcher_created_at = launcher_creation_time(pid);
        let mut b = overlap_record(2, child.id(), 2000);
        b.launcher_created_at = launcher_creation_time(child.id());
        assert!(b.launcher_created_at.is_some());
        append_capture(tmp.path(), &a).unwrap();
        append_capture(tmp.path(), &b).unwrap();
        assert!(child.wait().unwrap().success());
        // Reading only after both source writes models a UI which never saw
        // the overlap live. Persisted flags must be sufficient by themselves.
        let text = std::fs::read_to_string(tmp.path().join(CAPTURES_FILE)).unwrap();
        let rows: Vec<serde_json::Value> = text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        for pane in [1, 2] {
            let row = rows.iter().rev().find(|row| row["termxSessionId"] == pane).unwrap();
            assert_eq!(row["modelAmbiguous"], true);
            assert_eq!(row["launch"]["args"][0], "--model");
        }
    }

    #[test]
    fn source_overlap_serializes_simultaneous_hooks_and_preserves_duplicate_flags() {
        let tmp = tempfile::tempdir().unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let mut workers = Vec::new();
        for pane in [1, 2] {
            let path = tmp.path().to_path_buf();
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                let capture = overlap_record(pane, pane + 100, u64::from(pane) * 1000);
                barrier.wait();
                append_capture_with_liveness(&path, &capture, |_, _| true).unwrap();
            }));
        }
        for worker in workers { worker.join().unwrap(); }
        // Subsequent duplicate native hooks arrive after the peer has exited.
        // They must inherit the persistent flag rather than relying on liveness.
        for pane in [1, 2] {
            let duplicate = overlap_record(pane, pane + 100, 9000);
            append_capture_with_liveness(tmp.path(), &duplicate, |_, _| false).unwrap();
        }
        let text = std::fs::read_to_string(tmp.path().join(CAPTURES_FILE)).unwrap();
        let rows: Vec<serde_json::Value> = text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        for pane in [1, 2] {
            let row = rows.iter().rev().find(|row| row["termxSessionId"] == pane).unwrap();
            assert_eq!(row["modelAmbiguous"], true);
        }
    }

    #[test]
    fn source_overlap_does_not_flag_nonoverlapping_resumes_or_same_launch_duplicates() {
        let tmp = tempfile::tempdir().unwrap();
        let a = overlap_record(1, 101, 1000);
        append_capture_with_liveness(tmp.path(), &a, |_, _| true).unwrap();
        append_capture_with_liveness(tmp.path(), &a, |_, _| true).unwrap();
        let b = overlap_record(2, 202, 2000);
        append_capture_with_liveness(tmp.path(), &b, |_, _| false).unwrap();
        let text = std::fs::read_to_string(tmp.path().join(CAPTURES_FILE)).unwrap();
        assert!(!text.contains("modelAmbiguous"));
    }

    #[test]
    fn source_overlap_retains_rich_native_peer_fields_over_a_later_legacy_duplicate() {
        let tmp = tempfile::tempdir().unwrap();
        let a = overlap_record(1, 101, 1000);
        append_capture_with_liveness(tmp.path(), &a, |_, _| true).unwrap();
        let mut legacy = serde_json::to_value(&a).unwrap();
        legacy.as_object_mut().unwrap().remove("launch");
        legacy["atMs"] = 9000.into();
        legacy["cwd"] = r"C:\wrong-duplicate".into();
        append_line(&tmp.path().join(CAPTURES_FILE), &capture_json_line(&legacy).unwrap(), false).unwrap();
        append_capture_with_liveness(tmp.path(), &overlap_record(2, 202, 2000), |_, _| true).unwrap();
        let text = std::fs::read_to_string(tmp.path().join(CAPTURES_FILE)).unwrap();
        let peer: serde_json::Value = text.lines().rev().map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .find(|row| row["termxSessionId"] == 1).unwrap();
        assert_eq!(peer["modelAmbiguous"], true);
        assert_eq!(peer["cwd"], r"C:\same-folder");
        assert_eq!(peer["model"], "model-1");
        assert_eq!(peer["launch"]["args"][1], "model-1");
        assert_eq!(peer["atMs"], 1000);
    }

    #[test]
    fn source_overlap_checks_live_older_launches_after_a_pane_records_another_conversation() {
        let tmp = tempfile::tempdir().unwrap();
        let a = overlap_record(1, 101, 1000);
        append_capture_with_liveness(tmp.path(), &a, |_, _| false).unwrap();
        let mut nested = overlap_record(1, 303, 2000);
        nested.id = "another-conversation".into();
        append_capture_with_liveness(tmp.path(), &nested, |_, _| false).unwrap();
        append_capture_with_liveness(tmp.path(), &overlap_record(2, 202, 3000), |pid, _| pid == 101).unwrap();
        let text = std::fs::read_to_string(tmp.path().join(CAPTURES_FILE)).unwrap();
        let rows: Vec<serde_json::Value> = text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        for pane in [1, 2] {
            let row = rows.iter().rev().find(|row| row["termxSessionId"] == pane && row["id"] == "shared-123").unwrap();
            assert_eq!(row["modelAmbiguous"], true);
        }
        assert!(!rows.iter().any(|row| row["id"] == "another-conversation" && row["modelAmbiguous"] == true));
    }

    #[test]
    fn source_overlap_lock_wait_and_log_read_are_bounded_without_overwriting_logs() {
        let tmp = tempfile::tempdir().unwrap();
        let lock = capture_lock(tmp.path()).unwrap();
        let start = std::time::Instant::now();
        assert!(append_capture_with_liveness(tmp.path(), &overlap_record(1, 101, 1000), |_, _| true).is_err());
        assert!(start.elapsed() < std::time::Duration::from_secs(2));
        drop(lock);
        let path = tmp.path().join(CAPTURES_FILE);
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_CAPTURE_LOG_BYTES + 1).unwrap();
        drop(file);
        assert!(append_capture_with_liveness(tmp.path(), &overlap_record(1, 101, 1000), |_, _| true).is_err());
        assert_eq!(std::fs::metadata(&path).unwrap().len(), MAX_CAPTURE_LOG_BYTES + 1);
    }

    #[test]
    fn early_modes_parse_direct_structured_and_capture_forms_strictly() {
        let direct = parse_early_args(
            ["--agent", "claude", "--", "--model", "opus"]
                .into_iter()
                .map(OsString::from)
                .collect(),
        )
        .unwrap();
        assert_eq!(
            direct,
            Some(EarlyCommand::Launch(AgentInvocation {
                v: 1,
                provider: Provider::Claude,
                args: vec!["--model".into(), "opus".into()],
                cwd: None,
            }))
        );

        let encoded = encode_token(&invocation()).unwrap();
        assert_eq!(
            parse_early_args(vec!["--agent-json".into(), encoded.into()]).unwrap(),
            Some(EarlyCommand::Launch(invocation()))
        );
        assert_eq!(
            parse_early_args(vec!["--capture-agent".into(), "codex".into()]).unwrap(),
            Some(EarlyCommand::Capture(Provider::Codex))
        );
        assert!(parse_early_args(vec!["--agent".into(), "claude".into()]).is_err());
        assert!(parse_early_args(vec!["--agent-json".into(), "%%%".into()]).is_err());
        assert_eq!(parse_early_args(vec!["--data-dir".into()]).unwrap(), None);
    }

    #[test]
    fn conversation_ids_start_with_an_alphanumeric_character() {
        assert!(valid_conversation_id("abc-123"));
        assert!(valid_conversation_id("1-2"));
        assert!(!valid_conversation_id("--last"));
        assert!(!valid_conversation_id("--fork-session"));
        assert!(!valid_conversation_id("bad/id"));
    }

    #[test]
    fn process_snapshot_contains_the_current_process() {
        let rows = process_snapshot().unwrap();
        assert!(rows.iter().any(|row| row.pid == std::process::id()));
    }

    #[test]
    fn early_dispatch_ignores_daemon_args_and_capture_failures_are_silent_success() {
        assert_eq!(dispatch_early([OsString::from("--data-dir")].into_iter()), None);
        assert_eq!(
            dispatch_early(
                [OsString::from("--capture-agent"), OsString::from("unknown")].into_iter()
            ),
            Some(0)
        );
    }
}
