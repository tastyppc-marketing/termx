use crate::DecimalU64;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProcessIdentity {
    pub pid: u32,
    pub creation_filetime: DecimalU64,
}
impl ProcessIdentity {
    pub const fn new(pid: u32, creation_filetime: u64) -> Self {
        Self {
            pid,
            creation_filetime: DecimalU64::new(creation_filetime),
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct ProcessSnapshot {
    pub identity: ProcessIdentity,
    pub parent_pid: u32,
}
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AncestryError {
    #[error("ancestor not found")]
    NotFound,
    #[error("ancestry cycle")]
    Cycle,
    #[error("ambiguous enrolled ancestry")]
    Ambiguous,
    #[error("ancestry depth exceeded")]
    Depth,
    #[error("ancestry unavailable")]
    Unavailable,
}
pub fn resolve_enrolled_ancestor(
    start: u32,
    rows: &[ProcessSnapshot],
    enrolled: &[ProcessIdentity],
    max_depth: usize,
) -> Result<ProcessIdentity, AncestryError> {
    let mut map = HashMap::new();
    for row in rows {
        if map.insert(row.identity.pid, row).is_some() {
            return Err(AncestryError::Unavailable);
        }
    }
    let expected: HashSet<_> = enrolled.iter().copied().collect();
    let mut found = None;
    let mut pid = start;
    let mut seen = HashSet::new();
    for _ in 0..max_depth {
        if !seen.insert(pid) {
            return Err(AncestryError::Cycle);
        }
        let row = map.get(&pid).ok_or(AncestryError::NotFound)?;
        if expected.contains(&row.identity) && found.replace(row.identity).is_some() {
            return Err(AncestryError::Ambiguous);
        }
        if row.parent_pid == 0 {
            return found.ok_or(AncestryError::NotFound);
        }
        if seen.contains(&row.parent_pid) {
            return Err(AncestryError::Cycle);
        }
        let parent = map.get(&row.parent_pid).ok_or(AncestryError::NotFound)?;
        if parent.identity.creation_filetime > row.identity.creation_filetime {
            return Err(AncestryError::Unavailable);
        }
        pid = row.parent_pid;
    }
    Err(AncestryError::Depth)
}

#[cfg(windows)]
pub fn resolve_verified_enrolled_ancestor(
    start: u32,
    enrolled: &[ProcessIdentity],
    max_depth: usize,
) -> Result<VerifiedProcess, AncestryError> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(AncestryError::Unavailable);
    }
    let mut parents = HashMap::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        if parents
            .insert(entry.th32ProcessID, entry.th32ParentProcessID)
            .is_some()
        {
            unsafe { CloseHandle(snapshot) };
            return Err(AncestryError::Unavailable);
        }
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe { CloseHandle(snapshot) };

    let expected: HashSet<_> = enrolled.iter().copied().collect();
    let mut found = None;
    let mut previous_creation = None;
    let mut handles = Vec::new();
    let mut pid = start;
    let mut seen = HashSet::new();
    for _ in 0..max_depth {
        if !seen.insert(pid) {
            return Err(AncestryError::Cycle);
        }
        let process = VerifiedProcess::open(pid).map_err(|_| AncestryError::Unavailable)?;
        if !process.is_alive().map_err(|_| AncestryError::Unavailable)? {
            return Err(AncestryError::Unavailable);
        }
        if previous_creation.is_some_and(|child| process.identity().creation_filetime > child) {
            return Err(AncestryError::Unavailable);
        }
        if expected.contains(&process.identity()) && found.replace(handles.len()).is_some() {
            return Err(AncestryError::Ambiguous);
        }
        let parent_pid = *parents.get(&pid).ok_or(AncestryError::Unavailable)?;
        previous_creation = Some(process.identity().creation_filetime);
        handles.push(process);
        if parent_pid == 0 {
            let index = found.ok_or(AncestryError::NotFound)?;
            return Ok(handles.swap_remove(index));
        }
        pid = parent_pid;
    }
    Err(AncestryError::Depth)
}

pub struct VerifiedProcess {
    identity: ProcessIdentity,
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
}
#[cfg(windows)]
unsafe impl Send for VerifiedProcess {}
#[cfg(windows)]
unsafe impl Sync for VerifiedProcess {}
#[derive(Debug, thiserror::Error)]
pub enum ProcessError {
    #[error("process unavailable")]
    Unavailable,
    #[error("process generation mismatch")]
    Stale,
}
impl VerifiedProcess {
    pub fn identity(&self) -> ProcessIdentity {
        self.identity
    }
    #[cfg(windows)]
    pub fn open(pid: u32) -> Result<Self, ProcessError> {
        use windows_sys::Win32::{
            Foundation::FILETIME,
            System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        };
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | 0x0010_0000, 0, pid);
            if handle.is_null() {
                return Err(ProcessError::Unavailable);
            }
            let mut creation = FILETIME::default();
            let mut exit = FILETIME::default();
            let mut kernel = FILETIME::default();
            let mut user = FILETIME::default();
            if GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) == 0 {
                windows_sys::Win32::Foundation::CloseHandle(handle);
                return Err(ProcessError::Unavailable);
            }
            let time = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
            Ok(Self {
                identity: ProcessIdentity::new(pid, time),
                handle,
            })
        }
    }
    #[cfg(windows)]
    pub fn verify(expected: ProcessIdentity) -> Result<Self, ProcessError> {
        let value = Self::open(expected.pid)?;
        if value.identity != expected {
            return Err(ProcessError::Stale);
        }
        Ok(value)
    }
    #[cfg(windows)]
    pub fn is_alive(&self) -> Result<bool, ProcessError> {
        use windows_sys::Win32::{
            Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::WaitForSingleObject,
        };
        match unsafe { WaitForSingleObject(self.handle, 0) } {
            WAIT_TIMEOUT => Ok(true),
            WAIT_OBJECT_0 => Ok(false),
            _ => Err(ProcessError::Unavailable),
        }
    }
}
#[cfg(windows)]
impl Drop for VerifiedProcess {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}
