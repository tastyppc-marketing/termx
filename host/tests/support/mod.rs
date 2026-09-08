#![allow(dead_code)] // Shared by targets which each use a different helper subset.

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, ExitStatus};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

#[derive(Debug)]
pub struct RetainedDir {
    path: PathBuf,
}

pub struct RetainedSnapshot {
    path: PathBuf,
}

/// Exact child ownership for real-binary tests. On Windows the child is put
/// in a new kill-on-close job before the test is allowed to drive it, so any
/// descendants created later share the same exact failure-cleanup boundary.
pub struct OwnedChild {
    child: Child,
    fixture_root: PathBuf,
    label: String,
    #[cfg(windows)]
    job: OwnedJob,
}

impl OwnedChild {
    pub fn spawn(
        command: &mut Command,
        fixture_root: &Path,
        label: impl Into<String>,
    ) -> std::io::Result<Self> {
        let fixture_root = validate_owned_path(fixture_root)?;
        let label = label.into();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            const CREATE_SUSPENDED: u32 = 0x0000_0004;
            command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        }
        let mut child = command.spawn()?;
        #[cfg(windows)]
        let job = match OwnedJob::assign(&child) {
            Ok(job) => job,
            Err(error) => {
                return Err(cleanup_failed_start(
                    &mut child,
                    None,
                    &label,
                    "assigning exact child job",
                    error,
                ));
            }
        };
        #[cfg(windows)]
        if let Err(error) = resume_initial_thread(&child) {
            return Err(cleanup_failed_start(
                &mut child,
                Some(&job),
                &label,
                "resuming assigned child",
                error,
            ));
        }
        Ok(Self {
            child,
            fixture_root,
            label,
            #[cfg(windows)]
            job,
        })
    }

    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    pub fn wait(&mut self) -> std::io::Result<ExitStatus> {
        self.child.wait()
    }

    #[cfg(windows)]
    pub fn process_probe(&self) -> std::io::Result<ProcessProbe> {
        ProcessProbe::open(self.child.id())
    }
}

#[cfg(windows)]
fn cleanup_failed_start(
    child: &mut Child,
    job: Option<&OwnedJob>,
    label: &str,
    stage: &str,
    primary: std::io::Error,
) -> std::io::Error {
    let pid = child.id();
    let mut cleanup_failures = Vec::new();
    if let Some(job) = job {
        match job.terminate() {
            Ok(()) => match job.wait_empty(Duration::from_secs(5)) {
                Ok(true) => {}
                Ok(false) => cleanup_failures
                    .push("exact child job stayed active past startup-cleanup deadline".to_owned()),
                Err(error) => cleanup_failures.push(format!(
                    "checking exact child job during startup cleanup failed: {error}"
                )),
            },
            Err(error) => {
                cleanup_failures.push(format!(
                    "terminating exact child job during startup cleanup failed: {error}"
                ));
                if let Err(kill_error) = child.kill() {
                    cleanup_failures.push(format!(
                        "terminating exact child handle during startup cleanup failed: {kill_error}"
                    ));
                }
            }
        }
    } else if let Err(error) = child.kill() {
        cleanup_failures.push(format!(
            "terminating exact suspended child during startup cleanup failed: {error}"
        ));
    }
    match wait_for_child_exit(child, Duration::from_secs(5)) {
        Ok(Some(_)) => {}
        Ok(None) => cleanup_failures
            .push("exact child stayed active past startup-cleanup deadline".to_owned()),
        Err(error) => cleanup_failures.push(format!(
            "checking exact child during startup cleanup failed: {error}"
        )),
    }

    let mut message = format_startup_cleanup_diagnostic(
        label,
        pid,
        stage,
        &primary.to_string(),
        &cleanup_failures,
    );
    eprintln!("{message}");
    if let Err(error) = write_cleanup_diagnostic(label, pid, &message) {
        message.push_str(&format!(
            "; retaining startup-cleanup diagnostic failed: {error}"
        ));
        eprintln!("{message}");
    }
    std::io::Error::new(primary.kind(), message)
}

fn format_startup_cleanup_diagnostic(
    label: &str,
    pid: u32,
    stage: &str,
    primary: &str,
    cleanup_failures: &[String],
) -> String {
    let failures = if cleanup_failures.is_empty() {
        "none".to_owned()
    } else {
        cleanup_failures.join("; ")
    };
    format!(
        "owned child startup failed: label={label}; pid={pid}; stage={stage}; primary={primary}; cleanup_failures={failures}"
    )
}

pub fn format_startup_cleanup_diagnostic_for_test(
    label: &str,
    pid: u32,
    stage: &str,
    primary: &str,
    cleanup_failures: &[String],
) -> String {
    format_startup_cleanup_diagnostic(label, pid, stage, primary, cleanup_failures)
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        let snapshot = snapshot_fixture_tree(
            &self.fixture_root,
            &format!("{}-owned-child-drop", self.label),
        );
        let mut diagnostics = Vec::new();
        if let Err(error) = snapshot {
            diagnostics.push(format!("fixture snapshot failed: {error}"));
        }
        #[cfg(windows)]
        match self.job.terminate() {
            Ok(()) => match self.job.wait_empty(Duration::from_secs(10)) {
                Ok(true) => {}
                Ok(false) => diagnostics
                    .push("exact child job stayed active past the cleanup deadline".to_owned()),
                Err(error) => diagnostics.push(format!("checking exact child job failed: {error}")),
            },
            Err(error) => {
                diagnostics.push(format!("terminating exact child job failed: {error}"));
                if let Err(kill_error) = self.child.kill() {
                    diagnostics.push(format!(
                        "terminating exact child handle failed: {kill_error}"
                    ));
                }
            }
        }
        #[cfg(not(windows))]
        match self.child.try_wait() {
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => {
                if let Err(error) = self.child.kill() {
                    diagnostics.push(format!("terminating exact child handle failed: {error}"));
                }
            }
        }
        match wait_for_child_exit(&mut self.child, Duration::from_secs(10)) {
            Ok(Some(_)) => {}
            Ok(None) => diagnostics
                .push("exact child did not exit within the bounded cleanup interval".to_owned()),
            Err(error) => diagnostics.push(format!("checking exact child exit failed: {error}")),
        }
        if !diagnostics.is_empty() {
            let message = diagnostics.join("; ");
            eprintln!("owned child cleanup {}: {message}", self.label);
            let _ = write_cleanup_diagnostic(&self.label, self.child.id(), &message);
        }
    }
}

fn wait_for_child_exit(
    child: &mut Child,
    timeout: Duration,
) -> std::io::Result<Option<ExitStatus>> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn write_cleanup_diagnostic(label: &str, pid: u32, error: &str) -> std::io::Result<()> {
    let container = retained_dir()?;
    let manifest = serde_json::json!({
        "schema": "termx.host-owned-child-cleanup/v1",
        "label": label,
        "pid": pid,
        "error": error,
    });
    std::fs::write(
        container.path().join("cleanup-error.json"),
        serde_json::to_vec_pretty(&manifest).map_err(std::io::Error::other)?,
    )
}

#[cfg(windows)]
pub struct ProcessProbe {
    handle: windows_sys::Win32::Foundation::HANDLE,
    pid: u32,
}

#[cfg(windows)]
impl ProcessProbe {
    pub fn open(pid: u32) -> std::io::Result<Self> {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        };
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self { handle, pid })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn exited(&self) -> std::io::Result<bool> {
        use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        match unsafe { WaitForSingleObject(self.handle, 0) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => Err(std::io::Error::last_os_error()),
        }
    }

    pub fn wait_exited(&self, timeout: Duration) -> std::io::Result<bool> {
        use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        let timeout_ms = timeout.as_millis().min(u32::MAX as u128) as u32;
        match unsafe { WaitForSingleObject(self.handle, timeout_ms) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => Err(std::io::Error::last_os_error()),
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessProbe {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

#[cfg(windows)]
fn resume_initial_thread(child: &Child) -> std::io::Result<()> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut found = None;
    let mut valid = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    while valid {
        if entry.th32OwnerProcessID == child.id() {
            found = Some(entry.th32ThreadID);
            break;
        }
        valid = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    unsafe {
        CloseHandle(snapshot);
    }
    let thread_id = found.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "suspended child's initial thread was not found",
        )
    })?;
    let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id) };
    if thread.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    let previous = unsafe { ResumeThread(thread) };
    let resume_error = (previous == u32::MAX).then(std::io::Error::last_os_error);
    unsafe {
        CloseHandle(thread);
    }
    if let Some(error) = resume_error {
        return Err(error);
    }
    Ok(())
}

#[cfg(windows)]
struct OwnedJob {
    handle: isize,
}

#[cfg(windows)]
impl OwnedJob {
    fn assign(child: &Child) -> std::io::Result<Self> {
        use std::ffi::c_void;
        use std::os::windows::io::AsRawHandle;

        const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
        const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

        #[repr(C)]
        #[derive(Clone, Copy, Default)]
        struct BasicLimitInformation {
            per_process_user_time_limit: i64,
            per_job_user_time_limit: i64,
            limit_flags: u32,
            minimum_working_set_size: usize,
            maximum_working_set_size: usize,
            active_process_limit: u32,
            affinity: usize,
            priority_class: u32,
            scheduling_class: u32,
        }

        #[repr(C)]
        #[derive(Clone, Copy, Default)]
        struct IoCounters {
            read_operation_count: u64,
            write_operation_count: u64,
            other_operation_count: u64,
            read_transfer_count: u64,
            write_transfer_count: u64,
            other_transfer_count: u64,
        }

        #[repr(C)]
        #[derive(Clone, Copy, Default)]
        struct ExtendedLimitInformation {
            basic_limit_information: BasicLimitInformation,
            io_info: IoCounters,
            process_memory_limit: usize,
            job_memory_limit: usize,
            peak_process_memory_used: usize,
            peak_job_memory_used: usize,
        }

        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> isize;
            fn SetInformationJobObject(
                job: isize,
                information_class: i32,
                information: *const c_void,
                information_length: u32,
            ) -> i32;
            fn AssignProcessToJobObject(job: isize, process: isize) -> i32;
            fn CloseHandle(handle: isize) -> i32;
        }

        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut information = ExtendedLimitInformation::default();
        information.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                (&information as *const ExtendedLimitInformation).cast(),
                std::mem::size_of::<ExtendedLimitInformation>() as u32,
            )
        };
        if configured == 0 {
            let error = std::io::Error::last_os_error();
            unsafe { CloseHandle(handle) };
            return Err(error);
        }
        let assigned = unsafe { AssignProcessToJobObject(handle, child.as_raw_handle() as isize) };
        if assigned == 0 {
            let error = std::io::Error::last_os_error();
            unsafe { CloseHandle(handle) };
            return Err(error);
        }
        Ok(Self { handle })
    }

    fn terminate(&self) -> std::io::Result<()> {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn TerminateJobObject(job: isize, exit_code: u32) -> i32;
        }
        if unsafe { TerminateJobObject(self.handle, 1) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    fn wait_empty(&self, timeout: Duration) -> std::io::Result<bool> {
        use std::ffi::c_void;

        const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS: i32 = 1;

        #[repr(C)]
        #[derive(Clone, Copy, Default)]
        struct BasicAccountingInformation {
            total_user_time: i64,
            total_kernel_time: i64,
            this_period_total_user_time: i64,
            this_period_total_kernel_time: i64,
            total_page_fault_count: u32,
            total_processes: u32,
            active_processes: u32,
            total_terminated_processes: u32,
        }

        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn QueryInformationJobObject(
                job: isize,
                information_class: i32,
                information: *mut c_void,
                information_length: u32,
                return_length: *mut u32,
            ) -> i32;
        }

        let deadline = Instant::now() + timeout;
        loop {
            let mut information = BasicAccountingInformation::default();
            let queried = unsafe {
                QueryInformationJobObject(
                    self.handle,
                    JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS,
                    (&mut information as *mut BasicAccountingInformation).cast(),
                    std::mem::size_of::<BasicAccountingInformation>() as u32,
                    std::ptr::null_mut(),
                )
            };
            if queried == 0 {
                return Err(std::io::Error::last_os_error());
            }
            if information.active_processes == 0 {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[cfg(windows)]
impl Drop for OwnedJob {
    fn drop(&mut self) {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CloseHandle(handle: isize) -> i32;
        }
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

impl RetainedSnapshot {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl RetainedDir {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

pub fn retained_dir() -> std::io::Result<RetainedDir> {
    let root = retained_root()?;
    let resolved_root = root.canonicalize()?;
    for _ in 0..128 {
        let sequence = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = root.join(format!("fixture-{nanos}-{}-{sequence}", std::process::id()));
        match std::fs::create_dir(&path) {
            Ok(()) => {
                let resolved = path.canonicalize()?;
                if resolved.parent() != Some(resolved_root.as_path()) || is_link_or_reparse(&path)?
                {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "retained fixture escaped or became a reparse point",
                    ));
                }
                return Ok(RetainedDir { path });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not allocate a unique retained fixture directory",
    ))
}

/// Copy one regular test-owned subject before production cleanup removes its
/// working copy. The returned copy lives in its own retained directory.
pub fn preserve_file_before_remove(path: &Path, label: &str) -> std::io::Result<PathBuf> {
    let source = validate_owned_path(path)?;
    const MAX_PRESERVED_FILE_BYTES: u64 = 64 * 1024 * 1024;
    let container = retained_dir()?;
    let destination = container.path().join("subject.bin");
    let bytes = read_owned_file_bounded(&source, MAX_PRESERVED_FILE_BYTES, || {})?;
    write_new_file(&destination, &bytes)?;
    write_subject_manifest(container.path(), label, &source, "copied-before-remove")?;
    Ok(destination)
}

/// Fail-closed test hook for production `remove_file` call sites. Missing
/// subjects retain the production no-op behavior, and plain directories are
/// left for `remove_file` (or the production type gate) to reject. Every other
/// existing object must be a preserved regular file; links, reparse points and
/// special objects stop cleanup before the remove call.
pub fn preserve_before_remove_if_needed(path: &Path, label: &str) -> std::io::Result<()> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() || is_link_or_reparse(path)? {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!(
                "cleanup subject is a link or reparse point and was not preserved: {}",
                path.display()
            ),
        ));
    }
    if metadata.is_file() {
        preserve_file_before_remove(path, label)?;
        return Ok(());
    }
    if metadata.is_dir() {
        return Ok(());
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        format!(
            "cleanup subject is not a regular file and was not preserved: {}",
            path.display()
        ),
    ))
}

/// Move one exact synthetic test file aside before the test replaces its path
/// with a failure fixture. No recursive move is performed.
pub fn retire_file(path: &Path, label: &str) -> std::io::Result<PathBuf> {
    let source = validate_owned_path(path)?;
    let metadata = std::fs::symlink_metadata(&source)?;
    if !metadata.is_file() || is_link_or_reparse(&source)? {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "retirement subject is not a plain regular file",
        ));
    }
    let container = retained_dir()?;
    let destination = container.path().join("subject.bin");
    std::fs::rename(&source, &destination)?;
    write_subject_manifest(container.path(), label, &source, "moved-before-replacement")?;
    Ok(destination)
}

fn write_subject_manifest(
    container: &Path,
    label: &str,
    source: &Path,
    action: &str,
) -> std::io::Result<()> {
    let manifest = serde_json::json!({
        "schema": "termx.host-test-subject/v1",
        "label": label,
        "source": source,
        "retained": "subject.bin",
        "action": action,
    });
    std::fs::write(
        container.join("subject.json"),
        serde_json::to_vec_pretty(&manifest).map_err(std::io::Error::other)?,
    )
}

pub fn snapshot_fixture_tree(source: &Path, label: &str) -> std::io::Result<RetainedSnapshot> {
    const MAX_ENTRIES: usize = 4_096;
    const MAX_DIRECTORIES: usize = 1_024;
    const MAX_BYTES: u64 = 64 * 1024 * 1024;

    let source = validate_owned_path(source)?;
    if !std::fs::symlink_metadata(&source)?.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "snapshot source is not a directory",
        ));
    }
    let container = retained_dir()?;
    let destination = container.path().join("tree");
    std::fs::create_dir(&destination)?;
    let mut pending = vec![(source.clone(), destination.clone())];
    let mut entries = 0usize;
    let mut directories = 1usize;
    let mut bytes = 0u64;

    while let Some((source_dir, destination_dir)) = pending.pop() {
        let source_dir = validate_owned_path(&source_dir)?;
        for entry in std::fs::read_dir(&source_dir)? {
            let entry = entry?;
            entries = entries.checked_add(1).ok_or_else(snapshot_limit_error)?;
            if entries > MAX_ENTRIES {
                return Err(snapshot_limit_error());
            }
            let source_path = entry.path();
            let metadata = std::fs::symlink_metadata(&source_path)?;
            if is_link_or_reparse(&source_path)? {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    format!(
                        "snapshot entry is a link or reparse point: {}",
                        source_path.display()
                    ),
                ));
            }
            let destination_path = destination_dir.join(entry.file_name());
            if metadata.is_dir() {
                directories = directories
                    .checked_add(1)
                    .ok_or_else(snapshot_limit_error)?;
                if directories > MAX_DIRECTORIES {
                    return Err(snapshot_limit_error());
                }
                std::fs::create_dir(&destination_path)?;
                pending.push((source_path, destination_path));
            } else if metadata.is_file() {
                let remaining = MAX_BYTES
                    .checked_sub(bytes)
                    .ok_or_else(snapshot_limit_error)?;
                let body = read_owned_file_bounded(&source_path, remaining, || {})?;
                bytes = bytes
                    .checked_add(body.len() as u64)
                    .ok_or_else(snapshot_limit_error)?;
                write_new_file(&destination_path, &body)?;
            } else {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    format!(
                        "snapshot entry is not a regular file or directory: {}",
                        source_path.display()
                    ),
                ));
            }
        }
    }

    let manifest = serde_json::json!({
        "schema": "termx.host-test-snapshot/v1",
        "label": label,
        "source": source,
        "tree": "tree",
        "entries": entries,
        "directories": directories,
        "bytes": bytes,
    });
    std::fs::write(
        container.path().join("snapshot.json"),
        serde_json::to_vec_pretty(&manifest).map_err(std::io::Error::other)?,
    )?;
    Ok(RetainedSnapshot { path: destination })
}

fn snapshot_limit_error() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        "retained snapshot exceeded its bounded fixture limits",
    )
}

fn retained_root() -> std::io::Result<PathBuf> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repository = manifest.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "host manifest has no repository parent",
        )
    })?;
    let repository = repository.canonicalize()?;
    let requested = repository.join("retired/test-artifacts/host");
    create_checked_tree(&repository, &requested)?;
    let resolved = requested.canonicalize()?;
    if resolved != requested || !resolved.starts_with(&repository) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "retained artifact root escaped the repository",
        ));
    }
    Ok(ordinary_windows_path(&resolved))
}

fn validate_owned_path(path: &Path) -> std::io::Result<PathBuf> {
    let root = retained_root()?;
    reject_original_reparse_ancestors(&root, path)?;
    let resolved_root = root.canonicalize()?;
    let resolved = path.canonicalize()?;
    if resolved == resolved_root || !resolved.starts_with(&resolved_root) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "fixture path is outside the retained artifact root",
        ));
    }
    let relative = resolved.strip_prefix(&resolved_root).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "fixture path escaped the retained artifact root",
        )
    })?;
    let mut current = resolved_root;
    for component in relative.components() {
        current.push(component);
        if is_link_or_reparse(&current)? {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "fixture path contains a link or reparse point: {}",
                    current.display()
                ),
            ));
        }
    }
    Ok(ordinary_windows_path(&resolved))
}

fn reject_original_reparse_ancestors(root: &Path, path: &Path) -> std::io::Result<()> {
    let relative = path.strip_prefix(root).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "fixture path is lexically outside the retained artifact root",
        )
    })?;
    let mut current = root.to_path_buf();
    if is_link_or_reparse(&current)? {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "retained artifact root is a link or reparse point",
        ));
    }
    for component in relative.components() {
        match component {
            Component::Normal(part) => current.push(part),
            _ => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "fixture path contains a non-normal component",
                ));
            }
        }
        if is_link_or_reparse(&current)? {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "fixture path contains an original link or reparse point: {}",
                    current.display()
                ),
            ));
        }
    }
    Ok(())
}

fn read_owned_file_bounded(
    path: &Path,
    max_bytes: u64,
    after_open: impl FnOnce(),
) -> std::io::Result<Vec<u8>> {
    let source = validate_owned_path(path)?;
    let root = retained_root()?.canonicalize()?;
    let mut file = std::fs::File::open(&source)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "opened snapshot subject is not a regular file",
        ));
    }
    if metadata.len() > max_bytes {
        return Err(snapshot_limit_error());
    }
    let final_path = opened_final_path(&file)?;
    let final_resolved = final_path.canonicalize()?;
    if final_resolved == root || !final_resolved.starts_with(&root) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "opened snapshot subject escaped the retained artifact root",
        ));
    }
    after_open();
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(snapshot_limit_error());
    }
    Ok(bytes)
}

pub fn read_owned_file_bounded_for_test(
    path: &Path,
    max_bytes: u64,
    after_open: impl FnOnce(),
) -> std::io::Result<Vec<u8>> {
    read_owned_file_bounded(path, max_bytes, after_open)
}

fn write_new_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut destination = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    destination.write_all(bytes)?;
    destination.sync_all()
}

#[cfg(windows)]
fn opened_final_path(file: &std::fs::File) -> std::io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFinalPathNameByHandleW(
            file: isize,
            path: *mut u16,
            path_chars: u32,
            flags: u32,
        ) -> u32;
    }

    let mut buffer = vec![0u16; 512];
    loop {
        let length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle() as isize,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        };
        if length == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if length < buffer.len() as u32 {
            buffer.truncate(length as usize);
            return Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer)));
        }
        buffer.resize(length as usize + 1, 0);
    }
}

#[cfg(not(windows))]
fn opened_final_path(file: &std::fs::File) -> std::io::Result<PathBuf> {
    let _ = file;
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "opened final paths are only implemented for the Windows host tests",
    ))
}

fn ordinary_windows_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.as_os_str().to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

fn create_checked_tree(anchor: &Path, requested: &Path) -> std::io::Result<()> {
    if is_link_or_reparse(anchor)? {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "repository root is a link or reparse point",
        ));
    }
    let relative = requested.strip_prefix(anchor).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "retained artifact root is outside the repository",
        )
    })?;
    let mut current = anchor.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match std::fs::create_dir(&current) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        let metadata = std::fs::symlink_metadata(&current)?;
        if !metadata.is_dir() || is_link_or_reparse(&current)? {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "retained path component is not a plain directory: {}",
                    current.display()
                ),
            ));
        }
    }
    Ok(())
}

fn is_link_or_reparse(path: &Path) -> std::io::Result<bool> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Ok(true);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Ok(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
    }
    #[cfg(not(windows))]
    {
        let _ = FILE_ATTRIBUTE_REPARSE_POINT;
        Ok(false)
    }
}
