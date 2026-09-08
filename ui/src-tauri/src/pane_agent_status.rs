//! Exact active-agent metadata for one local terminal pane.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapture {
    pub provider: String,
    pub id: String,
    pub at_ms: u64,
    pub model: Option<String>,
    pub transcript_path: Option<String>,
    pub launcher_pid: Option<u32>,
    pub launcher_created_at: Option<String>,
    #[serde(default)]
    pub model_ambiguous: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PaneAgentStatus {
    pub provider: String,
    pub model: Option<String>,
}

#[derive(Clone, Debug)]
struct ProcessRow {
    pid: u32,
    parent_pid: u32,
    exe_name: String,
}

#[derive(Clone, Copy)]
struct ProcessFacts {
    created_at: u64,
    running: bool,
}

fn verify_runtime(
    shell_pid: u32,
    capture: &AgentCapture,
    rows: &[ProcessRow],
    mut inspect: impl FnMut(u32) -> Option<ProcessFacts>,
) -> bool {
    let Some(launcher) = capture
        .launcher_pid
        .filter(|pid| *pid != 0 && *pid != shell_pid)
    else {
        return false;
    };
    let Some(created_at) = capture
        .launcher_created_at
        .as_deref()
        .filter(|text| {
            !text.is_empty() && text.len() <= 20 && text.bytes().all(|b| b.is_ascii_digit())
        })
        .and_then(|text| text.parse::<u64>().ok())
        .filter(|time| *time > 0)
    else {
        return false;
    };
    if shell_pid == 0
        || !matches!(capture.provider.as_str(), "claude" | "codex")
        || capture.at_ms == 0
        || capture.id.is_empty()
        || capture.id.len() > 128
        || !capture
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return false;
    }
    let by_pid: HashMap<_, _> = rows.iter().map(|row| (row.pid, row)).collect();
    if by_pid.len() != rows.len() {
        return false;
    }
    let Some(launcher_row) = by_pid.get(&launcher) else {
        return false;
    };
    if !matches!(
        stem(&launcher_row.exe_name).as_str(),
        "termx-host" | "termx-host-x86_64-pc-windows-msvc" | "termx-host-x86_64-pc-windows-gnu"
    ) {
        return false;
    }
    let Some(launcher_info) =
        inspect(launcher).filter(|info| info.running && info.created_at == created_at)
    else {
        return false;
    };
    let mut cursor = launcher;
    let mut child_created_at = launcher_info.created_at;
    let mut seen = HashSet::new();
    for _ in 0..32 {
        if !seen.insert(cursor) {
            return false;
        }
        if cursor == shell_pid {
            break;
        }
        let Some(row) = by_pid.get(&cursor) else {
            return false;
        };
        let Some(parent) = inspect(row.parent_pid).filter(|info| {
            info.running && info.created_at > 0 && info.created_at <= child_created_at
        }) else {
            return false;
        };
        cursor = row.parent_pid;
        child_created_at = parent.created_at;
    }
    if cursor != shell_pid {
        return false;
    }
    // The tracked wrapper waits on exactly one direct provider child. A
    // legacy verified Node launch is supported, but a random shell child is not.
    let children: Vec<_> = rows
        .iter()
        .filter(|row| row.parent_pid == launcher)
        .collect();
    let [child] = children.as_slice() else {
        return false;
    };
    let child_stem = stem(&child.exe_name);
    if child_stem != capture.provider && child_stem != "node" {
        return false;
    }
    let Some(child_info) = inspect(child.pid)
        .filter(|info| info.running && info.created_at >= launcher_info.created_at)
    else {
        return false;
    };
    if capture.provider == "codex" && child_stem == "node" {
        let native: Vec<_> = rows
            .iter()
            .filter(|row| row.parent_pid == child.pid && stem(&row.exe_name) == "codex")
            .collect();
        let [native] = native.as_slice() else {
            return false;
        };
        if inspect(native.pid)
            .is_none_or(|info| !info.running || info.created_at < child_info.created_at)
        {
            return false;
        }
    }
    true
}

fn stem(name: &str) -> String {
    Path::new(name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn verify_stable_runtime(
    shell_pid: u32,
    capture: &AgentCapture,
    rows: &[ProcessRow],
    mut inspect: impl FnMut(u32) -> Option<ProcessFacts>,
    refresh: impl FnOnce() -> Option<Vec<ProcessRow>>,
) -> bool {
    let mut retained = HashMap::new();
    if !verify_runtime(shell_pid, capture, rows, |pid| {
        let facts = inspect(pid)?;
        retained.insert(pid, facts.created_at);
        Some(facts)
    }) {
        return false;
    }
    // The first Toolhelp table can predate OpenProcess. Refresh AFTER retaining
    // all handles, then verify ancestry/executable names against those exact
    // retained live identities. A recycled provider PID must not inherit its
    // predecessor's parent or image name from the old table.
    let Some(fresh) = refresh() else {
        return false;
    };
    verify_runtime(shell_pid, capture, &fresh, |pid| {
        let created = retained.get(&pid)?;
        inspect(pid).filter(|facts| facts.created_at == *created)
    })
}

fn usable_model(value: &str) -> Option<String> {
    (!value.trim().is_empty()
        && value.chars().count() <= 128
        && !value.chars().any(char::is_control)
        && value != "<synthetic>")
        .then(|| value.to_string())
}

fn model_from_lines(capture: &AgentCapture, lines: &[String]) -> Option<String> {
    if capture.model_ambiguous {
        return None;
    }
    for line in lines.iter().rev() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let timestamp = value
            .get("timestamp")
            .and_then(serde_json::Value::as_str)
            .and_then(crate::llm_sessions::codex::parse_iso8601_ms);
        if timestamp.is_none_or(|timestamp| timestamp <= capture.at_ms) {
            continue;
        }
        let model = match capture.provider.as_str() {
            "claude"
                if value.get("type").and_then(serde_json::Value::as_str) == Some("assistant")
                    && value
                        .get("isSidechain")
                        .and_then(serde_json::Value::as_bool)
                        != Some(true)
                    && value
                        .get("sessionId")
                        .and_then(serde_json::Value::as_str)
                        .is_none_or(|id| id == capture.id) =>
            {
                value
                    .get("message")
                    .and_then(|message| message.get("model"))
            }
            "codex"
                if value.get("type").and_then(serde_json::Value::as_str)
                    == Some("turn_context") =>
            {
                value
                    .get("payload")
                    .and_then(|payload| payload.get("model"))
            }
            _ => None,
        };
        if let Some(model) = model
            .and_then(serde_json::Value::as_str)
            .and_then(usable_model)
        {
            return Some(model);
        }
    }
    capture.model.as_deref().and_then(usable_model)
}

#[tauri::command]
pub async fn pane_agent_status(shell_pid: u32, capture: AgentCapture) -> Option<PaneAgentStatus> {
    tauri::async_runtime::spawn_blocking(move || status_now(shell_pid, &capture))
        .await
        .ok()
        .flatten()
}

/// Persist uncertainty for this invocation so closing its other writer or
/// restarting the UI cannot make that writer's retained transcript rows look
/// attributable again. Append alongside hooks; never replace their shared log.
#[tauri::command]
pub async fn mark_model_ambiguous(capture: serde_json::Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = crate::paths::resolve_data_dir(None)?;
        append_ambiguity(&base, capture)
    })
    .await
    .map_err(|e| e.to_string())?
}
fn append_ambiguity(base: &Path, mut capture: serde_json::Value) -> Result<(), String> {
    use std::io::Write;
    let parsed: AgentCapture =
        serde_json::from_value(capture.clone()).map_err(|_| "Invalid capture")?;
    if !matches!(parsed.provider.as_str(), "claude" | "codex")
        || parsed.launcher_pid.is_none()
        || parsed.launcher_created_at.is_none()
        || capture
            .get("termxSessionId")
            .and_then(|v| v.as_u64())
            .is_none_or(|v| v > u32::MAX as u64)
        || parsed.id.is_empty()
        || parsed.id.len() > 128
    {
        return Err("Invalid capture identity".into());
    }
    capture["modelAmbiguous"] = serde_json::Value::Bool(true);
    let mut line = serde_json::to_vec(&capture).map_err(|e| e.to_string())?;
    if line.len() > 65536 {
        return Err("Capture exceeds size limit".into());
    }
    line.push(b'\n');
    let _lock = capture_write_lock(base)?;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(base.join("conversation_captures_v1.jsonl"))
        .and_then(|mut file| file.write_all(&line))
        .map_err(|e| e.to_string())
}

fn capture_write_lock(base: &Path) -> Result<std::fs::File, String> {
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        match options.open(base.join("conversation_captures_v1.lock")) {
            Ok(file) => return Ok(file),
            Err(error)
                if matches!(error.raw_os_error(), Some(32 | 33)) && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(20))
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

#[tauri::command]
pub async fn compact_conversation_captures(expected: String, replacement: String) -> bool {
    if expected.len() > 32 * 1024 * 1024 || replacement.len() > expected.len() {
        return false;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(base) = crate::paths::resolve_data_dir(None) else {
            return false;
        };
        compact_captures_in(&base, &expected, &replacement)
    })
    .await
    .unwrap_or(false)
}

fn compact_captures_in(base: &Path, expected: &str, replacement: &str) -> bool {
    let Ok(_lock) = capture_write_lock(base) else {
        return false;
    };
    let path = base.join("conversation_captures_v1.jsonl");
    if std::fs::read_to_string(path).ok().as_deref() != Some(expected) {
        return false;
    }
    crate::storage::write_file_in(base, "conversation_captures_v1.jsonl", replacement).is_ok()
}

fn transcript_lines(capture: &AgentCapture) -> Vec<String> {
    let Some(raw) = capture
        .transcript_path
        .as_deref()
        .filter(|path| !path.contains('\0') && path.len() <= 24 * 1024)
    else {
        return Vec::new();
    };
    let path = Path::new(raw);
    let Some(name) = path.file_stem().and_then(|name| name.to_str()) else {
        return Vec::new();
    };
    let matches_id = match capture.provider.as_str() {
        "claude" => name == capture.id,
        "codex" => name.starts_with("rollout-") && name.ends_with(&format!("-{}", capture.id)),
        _ => false,
    };
    if !path.is_absolute()
        || !matches_id
        || path.extension().and_then(|ext| ext.to_str()) != Some("jsonl")
    {
        return Vec::new();
    }
    crate::transcript::read_window_at(path, None, 256 * 1024).lines
}

#[cfg(not(windows))]
fn status_now(_shell_pid: u32, _capture: &AgentCapture) -> Option<PaneAgentStatus> {
    None
}

#[cfg(windows)]
fn status_now(shell_pid: u32, capture: &AgentCapture) -> Option<PaneAgentStatus> {
    capture.launcher_pid?;
    capture.launcher_created_at.as_ref()?;
    let rows = windows::snapshot()?;
    let mut handles = HashMap::new();
    let verified = verify_stable_runtime(
        shell_pid,
        capture,
        &rows,
        |pid| {
            if let std::collections::hash_map::Entry::Vacant(entry) = handles.entry(pid) {
                entry.insert(windows::Process::open(pid)?);
            }
            handles.get(&pid)?.facts()
        },
        windows::snapshot,
    );
    if !verified {
        return None;
    }
    let model = model_from_lines(capture, &transcript_lines(capture));
    // Retained handles pin process identity while the transcript is read.
    if handles
        .values()
        .any(|process| process.facts().is_none_or(|info| !info.running))
    {
        return None;
    }
    Some(PaneAgentStatus {
        provider: capture.provider.clone(),
        model,
    })
}

#[cfg(windows)]
mod windows {
    use super::{ProcessFacts, ProcessRow};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_NO_MORE_FILES, FILETIME, HANDLE, INVALID_HANDLE_VALUE,
        WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
    };

    pub(super) struct Process(HANDLE);
    impl Drop for Process {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    impl Process {
        pub(super) fn open(pid: u32) -> Option<Self> {
            if pid == 0 {
                return None;
            }
            let handle = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    pid,
                )
            };
            if handle.is_null() {
                None
            } else {
                Some(Self(handle))
            }
        }
        pub(super) fn facts(&self) -> Option<ProcessFacts> {
            let mut created: FILETIME = unsafe { std::mem::zeroed() };
            let mut exited = created;
            let mut kernel = created;
            let mut user = created;
            if unsafe { GetProcessTimes(self.0, &mut created, &mut exited, &mut kernel, &mut user) }
                == 0
            {
                return None;
            }
            Some(ProcessFacts {
                created_at: (u64::from(created.dwHighDateTime) << 32)
                    | u64::from(created.dwLowDateTime),
                running: unsafe { WaitForSingleObject(self.0, 0) == WAIT_TIMEOUT },
            })
        }
    }
    pub(super) fn snapshot() -> Option<Vec<ProcessRow>> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let _snapshot = Process(snapshot);
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if unsafe { Process32FirstW(snapshot, &mut entry) } == 0 {
            return None;
        }
        let mut rows = Vec::new();
        loop {
            let len = entry
                .szExeFile
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(entry.szExeFile.len());
            rows.push(ProcessRow {
                pid: entry.th32ProcessID,
                parent_pid: entry.th32ParentProcessID,
                exe_name: String::from_utf16_lossy(&entry.szExeFile[..len]),
            });
            if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                return (unsafe { GetLastError() } == ERROR_NO_MORE_FILES).then_some(rows);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn capture() -> AgentCapture {
        serde_json::from_value(json!({"provider":"claude", "id":"abc-123", "atMs": 2000,
            "model":"startup-model", "launcherPid": 20, "launcherCreatedAt":"200"}))
        .unwrap()
    }

    fn rows() -> Vec<ProcessRow> {
        vec![
            ProcessRow {
                pid: 10,
                parent_pid: 1,
                exe_name: "pwsh.exe".into(),
            },
            ProcessRow {
                pid: 20,
                parent_pid: 10,
                exe_name: "termx-host.exe".into(),
            },
            ProcessRow {
                pid: 30,
                parent_pid: 20,
                exe_name: "claude.exe".into(),
            },
            ProcessRow {
                pid: 11,
                parent_pid: 1,
                exe_name: "pwsh.exe".into(),
            },
        ]
    }

    fn facts(pid: u32) -> Option<ProcessFacts> {
        Some(ProcessFacts {
            created_at: u64::from(pid) * 10,
            running: true,
        })
    }

    #[test]
    fn the_captured_launcher_belongs_only_to_its_own_shell() {
        assert!(verify_runtime(10, &capture(), &rows(), facts));
        assert!(!verify_runtime(11, &capture(), &rows(), facts));
    }
    #[test]
    fn rejects_a_provider_pid_recycled_between_snapshot_and_open() {
        let first = rows();
        let mut second = rows();
        second
            .iter_mut()
            .find(|row| row.pid == 30)
            .unwrap()
            .parent_pid = 11;
        assert!(!verify_stable_runtime(
            10,
            &capture(),
            &first,
            |pid| {
                let mut info = facts(pid)?;
                if pid == 30 {
                    info.created_at = 900;
                }
                Some(info)
            },
            || Some(second)
        ));
        assert!(verify_stable_runtime(10, &capture(), &first, facts, || {
            Some(rows())
        }));
        assert!(!verify_stable_runtime(
            10,
            &capture(),
            &first,
            facts,
            || None
        ));
    }
    #[test]
    fn ambiguity_appends_without_replacing_captures_and_validates_size() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("conversation_captures_v1.jsonl");
        std::fs::write(&path, "existing capture\n").unwrap();
        let record = json!({"v":1,"termxSessionId":1,"provider":"claude","id":"abc-123","atMs":10,"launcherPid":20,"launcherCreatedAt":"200"});
        append_ambiguity(tmp.path(), record.clone()).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("existing capture\n"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(text.lines().nth(1).unwrap()).unwrap()
                ["modelAmbiguous"],
            true
        );
        assert!(append_ambiguity(tmp.path(), json!({"provider":"claude"})).is_err());
        let mut huge = record;
        huge["cwd"] = json!("x".repeat(65537));
        assert!(append_ambiguity(tmp.path(), huge).is_err());
        let mut ambiguous = capture();
        ambiguous.model_ambiguous = true;
        assert_eq!(model_from_lines(&ambiguous, &[]), None);
        // A renderer compacting an earlier snapshot cannot erase a hook or
        // ambiguity record appended since its read.
        assert!(!compact_captures_in(tmp.path(), "existing capture\n", ""));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
        assert!(compact_captures_in(tmp.path(), &text, "compact\n"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "compact\n");
    }

    #[test]
    fn stopped_reused_inaccessible_or_recycled_parent_processes_are_not_active() {
        for bad_pid in [10, 20, 30] {
            assert!(!verify_runtime(10, &capture(), &rows(), |pid| {
                let mut info = facts(pid)?;
                if pid == bad_pid {
                    info.running = false;
                }
                Some(info)
            }));
            assert!(!verify_runtime(10, &capture(), &rows(), |pid| {
                if pid == bad_pid {
                    None
                } else {
                    facts(pid)
                }
            }));
        }
        assert!(!verify_runtime(10, &capture(), &rows(), |pid| {
            let mut info = facts(pid)?;
            if pid == 20 {
                info.created_at = 201;
            }
            Some(info)
        }));
        assert!(!verify_runtime(10, &capture(), &rows(), |pid| {
            let mut info = facts(pid)?;
            if pid == 10 {
                info.created_at = 500;
            }
            Some(info)
        }));
    }

    #[test]
    fn legacy_or_unrelated_or_ambiguous_processes_cannot_borrow_a_capture() {
        let mut value = capture();
        value.launcher_created_at = None;
        assert!(!verify_runtime(10, &value, &rows(), facts));
        value = capture();
        value.launcher_pid = None;
        assert!(!verify_runtime(10, &value, &rows(), facts));
        let mut tree = rows();
        tree[2].exe_name = "python.exe".into();
        assert!(!verify_runtime(10, &capture(), &tree, facts));
        tree = rows();
        tree.push(ProcessRow {
            pid: 31,
            parent_pid: 20,
            exe_name: "claude.exe".into(),
        });
        assert!(!verify_runtime(10, &capture(), &tree, facts));
    }

    #[test]
    fn native_and_verified_node_provider_launches_are_supported() {
        let mut tree = rows();
        tree[2].exe_name = "node.exe".into();
        assert!(verify_runtime(10, &capture(), &tree, facts));
        let mut value = capture();
        value.provider = "codex".into();
        assert!(!verify_runtime(10, &value, &tree, facts));
        tree.push(ProcessRow {
            pid: 40,
            parent_pid: 30,
            exe_name: "codex.exe".into(),
        });
        assert!(verify_runtime(10, &value, &tree, facts));
        assert!(!verify_runtime(10, &value, &tree, |pid| {
            let mut info = facts(pid)?;
            if pid == 40 {
                info.running = false;
            }
            Some(info)
        }));
    }

    #[test]
    fn new_claude_models_override_startup_but_resumed_history_and_sidechains_do_not() {
        let lines = [
            json!({"type":"assistant","timestamp":"1970-01-01T00:00:01Z","message":{"model":"old"}}).to_string(),
            json!({"type":"assistant","timestamp":"1970-01-01T00:00:03Z","message":{"model":"gpt-6-astra"}}).to_string(),
            json!({"type":"assistant","timestamp":"1970-01-01T00:00:04Z","isSidechain":true,"message":{"model":"sidechain"}}).to_string(),
            json!({"type":"assistant","timestamp":"1970-01-01T00:00:05Z","message":{"model":"<synthetic>"}}).to_string(),
            "{torn".into(),
        ];
        assert_eq!(
            model_from_lines(&capture(), &lines),
            Some("gpt-6-astra".into())
        );
        assert_eq!(
            model_from_lines(&capture(), &lines[..1]),
            Some("startup-model".into())
        );
    }

    #[test]
    fn codex_uses_the_latest_new_turn_context_without_model_defaults() {
        let mut value = capture();
        value.provider = "codex".into();
        value.model = None;
        assert_eq!(model_from_lines(&value, &[]), None);
        let lines = [
            json!({"type":"turn_context","timestamp":"1970-01-01T00:00:03Z","payload":{"model":"first"}}).to_string(),
            json!({"type":"turn_context","timestamp":"1970-01-01T00:00:04Z","payload":{"model":"custom/local-model"}}).to_string(),
            json!({"type":"turn_context","timestamp":"1970-01-01T00:00:05Z","payload":{"model":"x".repeat(129)}}).to_string(),
        ];
        assert_eq!(
            model_from_lines(&value, &lines),
            Some("custom/local-model".into())
        );
    }

    #[test]
    fn exact_transcript_reads_are_bounded_and_ignore_an_unrelated_filename() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc-123.jsonl");
        let mut value = capture();
        value.transcript_path = Some(path.to_string_lossy().into_owned());
        let older = json!({"type":"assistant", "timestamp":"1970-01-01T00:00:03Z", "message":{"model":"outside-tail"}}).to_string();
        let latest = json!({"type":"assistant", "timestamp":"1970-01-01T00:00:04Z", "message":{"model":"latest"}}).to_string();
        std::fs::write(
            &path,
            format!("{older}\n{}\n{latest}\n", "x".repeat(300 * 1024)),
        )
        .unwrap();
        let lines = transcript_lines(&value);
        assert!(lines.iter().map(String::len).sum::<usize>() <= 256 * 1024);
        assert!(!lines.iter().any(|line| line.contains("outside-tail")));
        assert_eq!(model_from_lines(&value, &lines), Some("latest".into()));
        value.id = "other-conversation".into();
        assert!(transcript_lines(&value).is_empty());
    }

    #[test]
    fn cycles_unknown_providers_and_overflowed_creation_identity_fail_closed() {
        let mut tree = rows();
        tree[1].parent_pid = 20;
        assert!(!verify_runtime(10, &capture(), &tree, facts));
        let mut value = capture();
        value.provider = "unknown".into();
        assert!(!verify_runtime(10, &value, &rows(), facts));
        value = capture();
        value.launcher_created_at = Some("18446744073709551616".into());
        assert!(!verify_runtime(10, &value, &rows(), facts));
    }

    #[cfg(windows)]
    #[test]
    fn windows_identity_and_snapshot_read_the_current_live_process() {
        let pid = std::process::id();
        let process = windows::Process::open(pid).unwrap();
        let first = process.facts().unwrap();
        assert!(first.running);
        assert!(first.created_at > 9_007_199_254_740_991);
        assert_eq!(process.facts().unwrap().created_at, first.created_at);
        assert!(windows::snapshot()
            .unwrap()
            .iter()
            .any(|row| row.pid == pid));
        assert!(windows::Process::open(0).is_none());
    }
}
