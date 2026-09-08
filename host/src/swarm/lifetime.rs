//! Windows lifetime of the broker process.
//!
//! An explicitly foreground broker exits when its launcher signals it
//! (stdin close, exact launcher process exit, or Ctrl+C) and otherwise lives
//! inside whatever job its launcher belongs to. Detached launch uses only
//! `CREATE_BREAKAWAY_FROM_JOB`, starts suspended, and verifies through the
//! retained child handle that no job still contains the child before it may
//! run. A restrictive immediate or ancestor job is reported as unsupported.
//! No service, scheduled task, WMI or global job change is ever attempted.
//!
//! The stdin watcher is a plain detached thread that owns its reader and
//! reports through a oneshot. Nothing about it can block Tokio's shutdown:
//! if another stop reason wins while the launcher still holds stdin open,
//! the runtime is shut down with a bounded timeout and the thread ends with
//! the process.

use crate::swarm::LifetimePolicy;
use std::future::Future;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use termx_swarm_client::{ProcessIdentity, VerifiedProcess};
use tokio::sync::oneshot;

const LAUNCHER_POLL: Duration = Duration::from_millis(250);
const CHILD_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);
const CHILD_CLEANUP_POLL: Duration = Duration::from_millis(20);

/// Resolves when the configured lifetime policy or Ctrl+C says the broker
/// must stop.
pub async fn wait_for_exit(policy: &LifetimePolicy) {
    let input: Option<Box<dyn Read + Send>> = match policy {
        LifetimePolicy::Stdin => Some(Box::new(std::io::stdin())),
        _ => None,
    };
    wait_for_exit_with(policy, input, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await;
}

/// Library form of [`wait_for_exit`]: `input` stands in for standard input
/// under the `Stdin` policy and `stop` for the Ctrl+C signal, so tests can
/// inject either without console signals to user sessions.
pub async fn wait_for_exit_with(
    policy: &LifetimePolicy,
    input: Option<Box<dyn Read + Send>>,
    stop: impl Future<Output = ()>,
) {
    match policy {
        LifetimePolicy::Signal => stop.await,
        LifetimePolicy::Stdin => {
            let closed = input.map(watch_input_closed);
            tokio::select! {
                _ = stop => {}
                _ = async {
                    match closed {
                        Some(closed) => {
                            let _ = closed.await;
                        }
                        None => std::future::pending::<()>().await,
                    }
                } => {}
            }
        }
        LifetimePolicy::Launcher(identity) => {
            tokio::select! {
                _ = stop => {}
                _ = launcher_exited(*identity) => {}
            }
        }
    }
}

/// Owns `input` on a detached thread and resolves when it reaches end of
/// file or fails. The thread keeps no runtime resources.
fn watch_input_closed(mut input: Box<dyn Read + Send>) -> oneshot::Receiver<()> {
    let (sender, receiver) = oneshot::channel();
    let spawned = std::thread::Builder::new()
        .name("swarm-stdin-watch".into())
        .spawn(move || {
            let mut buffer = [0u8; 256];
            loop {
                match input.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            let _ = sender.send(());
        });
    if spawned.is_err() {
        // Fail closed: dropping the only sender resolves the receiver and
        // stops the broker rather than silently weakening the stdin policy.
        let (_, orphan) = oneshot::channel();
        return orphan;
    }
    receiver
}

async fn launcher_exited(identity: ProcessIdentity) {
    let Ok(process) = VerifiedProcess::verify(identity) else {
        // The exact launcher generation is already gone or was never ours.
        return;
    };
    loop {
        if !process.is_alive().unwrap_or(false) {
            return;
        }
        tokio::time::sleep(LAUNCHER_POLL).await;
    }
}

#[derive(Debug)]
pub enum DetachError {
    /// The enclosing job (or an ancestor) does not permit breakaway, so a
    /// detached lifetime cannot be established from this launcher.
    Unsupported(&'static str),
    /// Detachment was unsupported after spawn, and exact-child cleanup also
    /// failed. The broker is never advertised as detached.
    UnsupportedCleanupFailed {
        reason: &'static str,
        cleanup: ChildCleanupError,
    },
    /// The child started but its exact generation could not be verified;
    /// it was terminated through the retained handle before returning.
    VerificationFailed(std::io::Error),
    /// Verification failed and exact-child cleanup could not be proved.
    VerificationCleanupFailed {
        verification: std::io::Error,
        cleanup: ChildCleanupError,
    },
    /// A post-spawn launch step failed and exact-child cleanup could not be
    /// proved.
    LaunchCleanupFailed {
        stage: &'static str,
        source: std::io::Error,
        cleanup: ChildCleanupError,
    },
    Io(std::io::Error),
}

#[derive(Debug)]
pub enum ChildCleanupError {
    Terminate(std::io::Error),
    TerminateStateUnknown {
        terminate: std::io::Error,
        inspect: std::io::Error,
    },
    Wait(std::io::Error),
    TimedOut(Duration),
}

impl std::fmt::Display for ChildCleanupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Terminate(error) => write!(f, "terminating exact child handle: {error}"),
            Self::TerminateStateUnknown { terminate, inspect } => write!(
                f,
                "terminating exact child handle: {terminate}; checking its state also failed: {inspect}"
            ),
            Self::Wait(error) => write!(f, "waiting for exact child exit: {error}"),
            Self::TimedOut(timeout) => {
                write!(f, "exact child stayed alive past {timeout:?} cleanup deadline")
            }
        }
    }
}

impl std::error::Error for ChildCleanupError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Terminate(error) | Self::Wait(error) => Some(error),
            Self::TerminateStateUnknown { terminate, .. } => Some(terminate),
            Self::TimedOut(_) => None,
        }
    }
}

impl std::fmt::Display for DetachError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported(reason) => write!(f, "detached broker launch unsupported: {reason}"),
            Self::UnsupportedCleanupFailed { reason, cleanup } => write!(
                f,
                "detached broker launch unsupported: {reason}; exact-child cleanup failed: {cleanup}"
            ),
            Self::VerificationFailed(error) => {
                write!(f, "detached broker generation could not be verified: {error}")
            }
            Self::VerificationCleanupFailed {
                verification,
                cleanup,
            } => write!(
                f,
                "detached broker generation could not be verified: {verification}; exact-child cleanup failed: {cleanup}"
            ),
            Self::LaunchCleanupFailed {
                stage,
                source,
                cleanup,
            } => write!(
                f,
                "detached broker launch failed while {stage}: {source}; exact-child cleanup failed: {cleanup}"
            ),
            Self::Io(error) => write!(f, "detached broker launch failed: {error}"),
        }
    }
}

impl std::error::Error for DetachError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Unsupported(_) => None,
            Self::UnsupportedCleanupFailed { cleanup, .. } => Some(cleanup),
            Self::VerificationFailed(error) | Self::Io(error) => Some(error),
            Self::VerificationCleanupFailed { verification, .. } => Some(verification),
            Self::LaunchCleanupFailed { source, .. } => Some(source),
        }
    }
}

/// Exact generation of a detached broker plus the launcher's own handle.
/// Spawn success proves that Windows reported no remaining job membership;
/// readiness is still proven separately by discovery and RPC progress.
pub struct DetachedBroker {
    identity: ProcessIdentity,
    child: OwnedChildGuard,
}

impl DetachedBroker {
    pub fn identity(&self) -> ProcessIdentity {
        self.identity
    }

    /// Releases the launcher's handle without terminating the broker.
    pub fn release(mut self) -> ProcessIdentity {
        let child = self.child.release();
        drop(child);
        self.identity
    }
}

struct OwnedChildGuard {
    child: Option<Child>,
}

impl OwnedChildGuard {
    fn new(child: Child) -> Self {
        Self { child: Some(child) }
    }

    fn child(&self) -> &Child {
        self.child.as_ref().expect("owned child already released")
    }

    fn release(&mut self) -> Child {
        self.child.take().expect("owned child already released")
    }

    fn terminate_and_reap(&mut self) -> Result<(), ChildCleanupError> {
        let child = self.child.as_mut().expect("owned child already released");
        if let Err(error) = child.kill() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    self.child.take();
                    return Ok(());
                }
                Ok(None) => return Err(ChildCleanupError::Terminate(error)),
                Err(inspect) => {
                    return Err(ChildCleanupError::TerminateStateUnknown {
                        terminate: error,
                        inspect,
                    });
                }
            }
        }

        let deadline = Instant::now() + CHILD_CLEANUP_TIMEOUT;
        loop {
            match child.try_wait().map_err(ChildCleanupError::Wait)? {
                Some(_) => {
                    self.child.take();
                    return Ok(());
                }
                None if Instant::now() >= deadline => {
                    return Err(ChildCleanupError::TimedOut(CHILD_CLEANUP_TIMEOUT));
                }
                None => std::thread::sleep(CHILD_CLEANUP_POLL),
            }
        }
    }
}

impl Drop for OwnedChildGuard {
    fn drop(&mut self) {
        if self.child.is_some() {
            if let Err(error) = self.terminate_and_reap() {
                eprintln!("detached broker exact-child cleanup failed: {error}");
            }
        }
    }
}

/// Whether this process belongs to a job, and if so whether the queried job
/// permits an initial breakaway attempt. `None` means not in any job. The
/// spawned child is checked separately because a restrictive ancestor can
/// still retain it.
pub fn current_job_breakaway() -> std::io::Result<Option<bool>> {
    use windows_sys::Win32::System::JobObjects::{
        IsProcessInJob, JobObjectExtendedLimitInformation, QueryInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    unsafe {
        let mut in_job = 0;
        if IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut in_job) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if in_job == 0 {
            return Ok(None);
        }
        let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        let queried = QueryInformationJobObject(
            std::ptr::null_mut(),
            JobObjectExtendedLimitInformation,
            (&mut information as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            std::ptr::null_mut(),
        );
        if queried == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Some(
            information.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_BREAKAWAY_OK != 0,
        ))
    }
}

/// Reads the exact generation of a spawned child from the handle the
/// launcher already holds; no PID reopen.
pub fn child_identity(child: &Child) -> std::io::Result<ProcessIdentity> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetProcessTimes;

    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut creation = zero;
    let mut exit = zero;
    let mut kernel = zero;
    let mut user = zero;
    let queried = unsafe {
        GetProcessTimes(
            child.as_raw_handle() as _,
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    };
    if queried == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let filetime = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    if filetime == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "child reported a zero creation time",
        ));
    }
    Ok(ProcessIdentity::new(child.id(), filetime))
}

/// Launches `executable --swarm-broker --data-dir <data_dir>` outside every
/// launcher job. The child stays suspended until retained-handle inspection
/// proves that no job contains it. Inputs are untouched when the preflight
/// rejects; a post-spawn rejection terminates the still-suspended child.
pub fn spawn_detached(executable: &Path, data_dir: &Path) -> Result<DetachedBroker, DetachError> {
    spawn_detached_inner(executable, data_dir, child_identity)
}

/// Library seam for tests: an injected generation verifier. A verifier
/// failure must terminate the spawned child through the retained handle.
#[cfg(feature = "swarm-test-seams")]
pub fn spawn_detached_with_verifier(
    executable: &Path,
    data_dir: &Path,
    verify: impl FnOnce(&Child) -> std::io::Result<ProcessIdentity>,
) -> Result<DetachedBroker, DetachError> {
    spawn_detached_inner(executable, data_dir, verify)
}

/// Test-only ownership seam for a child spawned inside a controlled fixture
/// job. It exercises verification, unwind, drop and explicit handoff without
/// making a detached-lifetime claim about that child.
#[cfg(feature = "swarm-test-seams")]
#[doc(hidden)]
pub fn guard_spawned_child_with_verifier(
    child: Child,
    verify: impl FnOnce(&Child) -> std::io::Result<ProcessIdentity>,
) -> Result<DetachedBroker, DetachError> {
    verify_owned_child(OwnedChildGuard::new(child), verify)
}

#[cfg(feature = "swarm-test-seams")]
fn verify_owned_child(
    mut child: OwnedChildGuard,
    verify: impl FnOnce(&Child) -> std::io::Result<ProcessIdentity>,
) -> Result<DetachedBroker, DetachError> {
    match verify(child.child()) {
        Ok(identity) => Ok(DetachedBroker { identity, child }),
        Err(verification) => match child.terminate_and_reap() {
            Ok(()) => Err(DetachError::VerificationFailed(verification)),
            Err(cleanup) => Err(DetachError::VerificationCleanupFailed {
                verification,
                cleanup,
            }),
        },
    }
}

fn child_in_any_job(child: &Child) -> std::io::Result<bool> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;

    let mut in_job = 0;
    let checked = unsafe {
        IsProcessInJob(
            child.as_raw_handle() as _,
            std::ptr::null_mut(),
            &mut in_job,
        )
    };
    if checked == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(in_job != 0)
}

fn find_initial_thread_id(child: &Child) -> std::io::Result<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut thread_id = None;
    let mut valid = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    while valid {
        if entry.th32OwnerProcessID == child.id() {
            thread_id = Some(entry.th32ThreadID);
            break;
        }
        valid = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    unsafe {
        CloseHandle(snapshot);
    }

    thread_id.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "suspended child's initial thread was not found",
        )
    })
}

fn resume_thread_checked(child: &Child, thread_id: u32) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        GetProcessIdOfThread, OpenThread, ResumeThread, WaitForSingleObject,
        THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
    };

    let thread = unsafe {
        OpenThread(
            THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
            0,
            thread_id,
        )
    };
    if thread.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    let result = (|| {
        let actual_pid = unsafe { GetProcessIdOfThread(thread) };
        if actual_pid == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if actual_pid != child.id() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "candidate initial thread belongs to another process",
            ));
        }
        match unsafe { WaitForSingleObject(child.as_raw_handle() as _, 0) } {
            WAIT_TIMEOUT => {}
            WAIT_OBJECT_0 => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "suspended child exited before its initial thread was resumed",
                ));
            }
            _ => return Err(std::io::Error::last_os_error()),
        }
        let previous = unsafe { ResumeThread(thread) };
        if previous == u32::MAX {
            return Err(std::io::Error::last_os_error());
        }
        if previous != 1 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("initial thread had unexpected suspend count {previous}"),
            ));
        }
        Ok(())
    })();
    unsafe {
        CloseHandle(thread);
    }
    result
}

fn resume_initial_thread(child: &Child) -> std::io::Result<()> {
    let thread_id = find_initial_thread_id(child)?;
    resume_thread_checked(child, thread_id)
}

fn spawn_detached_inner(
    executable: &Path,
    data_dir: &Path,
    verify: impl FnOnce(&Child) -> std::io::Result<ProcessIdentity>,
) -> Result<DetachedBroker, DetachError> {
    use std::os::windows::process::CommandExt;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    const ERROR_ACCESS_DENIED: i32 = 5;

    if let Some(false) = current_job_breakaway().map_err(DetachError::Io)? {
        return Err(DetachError::Unsupported(
            "the enclosing job does not permit breakaway",
        ));
    }
    let mut command = Command::new(executable);
    command
        .arg(crate::swarm::BROKER_MODE)
        .arg("--data-dir")
        .arg(data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(
            CREATE_BREAKAWAY_FROM_JOB
                | CREATE_NEW_PROCESS_GROUP
                | CREATE_NO_WINDOW
                | CREATE_SUSPENDED,
        );
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) if error.raw_os_error() == Some(ERROR_ACCESS_DENIED) => {
            return Err(DetachError::Unsupported(
                "an enclosing job denied breakaway",
            ))
        }
        Err(error) => return Err(DetachError::Io(error)),
    };
    // Ownership begins before any fallible inspection or caller verifier.
    // The child is still suspended, so an unsupported ancestor cannot race
    // ahead and publish broker state before we reject it.
    let mut child = OwnedChildGuard::new(child);
    let identity = match verify(child.child()) {
        Ok(identity) => identity,
        Err(verification) => {
            return match child.terminate_and_reap() {
                Ok(()) => Err(DetachError::VerificationFailed(verification)),
                Err(cleanup) => Err(DetachError::VerificationCleanupFailed {
                    verification,
                    cleanup,
                }),
            };
        }
    };
    match child_in_any_job(child.child()) {
        Ok(false) => {}
        Ok(true) => {
            let reason = "the spawned child remained in an enclosing job";
            return match child.terminate_and_reap() {
                Ok(()) => Err(DetachError::Unsupported(reason)),
                Err(cleanup) => Err(DetachError::UnsupportedCleanupFailed { reason, cleanup }),
            };
        }
        Err(error) => {
            return match child.terminate_and_reap() {
                Ok(()) => Err(DetachError::Io(error)),
                Err(cleanup) => Err(DetachError::LaunchCleanupFailed {
                    stage: "checking spawned child job membership",
                    source: error,
                    cleanup,
                }),
            };
        }
    }
    if let Err(error) = resume_initial_thread(child.child()) {
        return match child.terminate_and_reap() {
            Ok(()) => Err(DetachError::Io(error)),
            Err(cleanup) => Err(DetachError::LaunchCleanupFailed {
                stage: "resuming the verified detached child",
                source: error,
                cleanup,
            }),
        };
    }
    Ok(DetachedBroker { identity, child })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const SUSPENDED_HELPER_MARKER: &str = "TERMX_SWARM_SUSPENDED_HELPER";

    fn suspended_test_child() -> OwnedChildGuard {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_SUSPENDED: u32 = 0x0000_0004;

        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--ignored",
                "--exact",
                "swarm::lifetime::tests::suspended_child_helper",
            ])
            .env(SUSPENDED_HELPER_MARKER, "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        OwnedChildGuard::new(command.spawn().unwrap())
    }

    #[test]
    #[ignore = "exact subprocess helper for checked suspended-thread resume"]
    fn suspended_child_helper() {
        assert_eq!(std::env::var(SUSPENDED_HELPER_MARKER).as_deref(), Ok("1"));
    }

    #[test]
    fn checked_resume_runs_the_exact_suspended_child() {
        let mut child = suspended_test_child();
        resume_initial_thread(child.child()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match child.child.as_mut().unwrap().try_wait().unwrap() {
                Some(status) => {
                    assert!(status.success(), "resumed helper failed: {status}");
                    child.child.take();
                    break;
                }
                None if Instant::now() >= deadline => {
                    panic!("resumed exact child did not exit within the deadline")
                }
                None => std::thread::sleep(CHILD_CLEANUP_POLL),
            }
        }
    }

    #[test]
    fn checked_resume_rejects_another_childs_thread() {
        let mut first = suspended_test_child();
        let mut second = suspended_test_child();
        let first_thread = find_initial_thread_id(first.child()).unwrap();

        let error = resume_thread_checked(second.child(), first_thread)
            .expect_err("a TID from another exact child must be rejected");

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(first.child.as_mut().unwrap().try_wait().unwrap().is_none());
        assert!(second.child.as_mut().unwrap().try_wait().unwrap().is_none());
    }

    #[tokio::test]
    async fn stop_wins_while_stdin_stays_open_and_the_watcher_never_blocks_the_runtime() {
        let (reader, mut writer) = std::io::pipe().unwrap();
        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let waiting = tokio::spawn(async move {
            wait_for_exit_with(&LifetimePolicy::Stdin, Some(Box::new(reader)), async {
                let _ = stop_rx.await;
            })
            .await;
        });
        writer.write_all(b"still open").unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !waiting.is_finished(),
            "open stdin must not stop the broker"
        );
        stop_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("the injected stop signal ends the wait while stdin is still open")
            .unwrap();
        // The watcher thread still owns the reader; the writer is released
        // by the test, which is the only remaining holder.
        drop(writer);
    }

    #[tokio::test]
    async fn stdin_end_of_file_stops_the_wait() {
        let (reader, writer) = std::io::pipe().unwrap();
        let waiting = tokio::spawn(async move {
            wait_for_exit_with(
                &LifetimePolicy::Stdin,
                Some(Box::new(reader)),
                std::future::pending(),
            )
            .await;
        });
        drop(writer);
        tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("end of file ends the wait")
            .unwrap();
    }

    #[tokio::test]
    async fn exited_launcher_generation_stops_the_wait_immediately() {
        let stale = ProcessIdentity::new(std::process::id(), 1);
        tokio::time::timeout(
            Duration::from_secs(5),
            wait_for_exit_with(
                &LifetimePolicy::Launcher(stale),
                None,
                std::future::pending(),
            ),
        )
        .await
        .expect("a stale launcher generation is treated as exited");
    }
}
