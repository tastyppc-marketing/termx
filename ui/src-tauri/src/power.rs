//! Windows suspend/resume notifications, forwarded to the renderer as Tauri
//! events.
//!
//! WHY THIS EXISTS: a TCP socket that dies while the CPU is asleep is never
//! noticed by a blocked read — the connection just stays "open" forever and
//! every later request fails against a corpse. The only reliable fix is to be
//! told the machine is going to sleep and tear the socket down proactively, then
//! reconnect on wake. The renderer's reconnect machine listens for these two
//! events.
//!
//! WIN32 NOTE: a message-only window (`HWND_MESSAGE` parent) does NOT receive
//! broadcast messages, and `WM_POWERBROADCAST` suspend/resume is broadcast — so
//! the window alone would never hear a thing. `RegisterSuspendResumeNotification`
//! subscribes the window explicitly, which is also the delivery method Windows
//! has documented as preferred since Windows 8.

use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Power::RegisterSuspendResumeNotification;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
    DEVICE_NOTIFY_WINDOW_HANDLE, HWND_MESSAGE, MSG, PBT_APMRESUMEAUTOMATIC, PBT_APMSUSPEND,
    WM_POWERBROADCAST, WNDCLASSW,
};

pub const POWER_SUSPEND_EVENT: &str = "termx://power-suspend";
pub const POWER_RESUME_EVENT: &str = "termx://power-resume";

const WINDOW_CLASS: &str = "TermxPowerListener";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PowerEvent {
    Suspend,
    Resume,
}

impl PowerEvent {
    pub fn name(self) -> &'static str {
        match self {
            PowerEvent::Suspend => POWER_SUSPEND_EVENT,
            PowerEvent::Resume => POWER_RESUME_EVENT,
        }
    }
}

/// The whole decision the wndproc makes, lifted out of it so it can be tested
/// without a window, a message pump, or a sleeping machine.
///
/// Only AUTOMATIC resume is mapped: `PBT_APMRESUMESUSPEND` fires solely when a
/// user is present, so keying off it would leave a machine that woke for a
/// scheduled task with a dead socket until someone touched the keyboard.
pub fn power_event(wparam: WPARAM) -> Option<PowerEvent> {
    match wparam as u32 {
        PBT_APMSUSPEND => Some(PowerEvent::Suspend),
        PBT_APMRESUMEAUTOMATIC => Some(PowerEvent::Resume),
        _ => None,
    }
}

/// The app handle the listener thread emits through. A `OnceLock` rather than
/// wndproc userdata: the wndproc is a plain `extern "system"` function and this
/// keeps the unsafe surface to the window plumbing itself.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Start listening for power notifications. Idempotent — a second call is
/// ignored rather than starting a second pump.
pub fn start(app: AppHandle) {
    if APP.set(app).is_err() {
        return;
    }
    std::thread::spawn(|| unsafe { run_listener() });
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_POWERBROADCAST {
        if let Some(event) = power_event(wparam) {
            emit(event);
        }
        return 1; // TRUE: handled.
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn emit(event: PowerEvent) {
    let Some(app) = APP.get() else {
        return;
    };
    if let Err(error) = app.emit(event.name(), ()) {
        // Nothing to recover: without the event the renderer falls back to its
        // ordinary backoff, which is slower but not broken.
        eprintln!("power event {} not delivered: {error}", event.name());
    }
}

/// Owns a message-only window and pumps its queue for the process lifetime.
/// Every failure path just returns: losing proactive suspend handling degrades
/// reconnect latency, it must never stop the app from starting.
unsafe fn run_listener() {
    let class = wide(WINDOW_CLASS);
    let instance = GetModuleHandleW(std::ptr::null());
    let mut descriptor: WNDCLASSW = std::mem::zeroed();
    descriptor.lpfnWndProc = Some(wnd_proc);
    descriptor.hInstance = instance;
    descriptor.lpszClassName = class.as_ptr();
    if RegisterClassW(&descriptor) == 0 {
        eprintln!("power listener: RegisterClassW failed");
        return;
    }

    let hwnd = CreateWindowExW(
        0,
        class.as_ptr(),
        class.as_ptr(),
        0,
        0,
        0,
        0,
        0,
        HWND_MESSAGE,
        std::ptr::null_mut(),
        instance,
        std::ptr::null(),
    );
    if hwnd.is_null() {
        eprintln!("power listener: CreateWindowExW failed");
        return;
    }

    // See the module header: without this the message-only window never sees a
    // single WM_POWERBROADCAST.
    if RegisterSuspendResumeNotification(hwnd, DEVICE_NOTIFY_WINDOW_HANDLE) == 0 {
        eprintln!("power listener: RegisterSuspendResumeNotification failed");
        return;
    }

    let mut message: MSG = std::mem::zeroed();
    while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
        DispatchMessageW(&message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suspend_and_automatic_resume_are_mapped() {
        assert_eq!(
            power_event(PBT_APMSUSPEND as WPARAM),
            Some(PowerEvent::Suspend)
        );
        assert_eq!(
            power_event(PBT_APMRESUMEAUTOMATIC as WPARAM),
            Some(PowerEvent::Resume)
        );
    }

    /// The documented constant values, spelled out: a windows-sys upgrade that
    /// changed them would silently stop every reconnect-on-wake.
    #[test]
    fn the_mapped_constants_are_the_documented_wparams() {
        assert_eq!(power_event(0x0004), Some(PowerEvent::Suspend));
        assert_eq!(power_event(0x0012), Some(PowerEvent::Resume));
    }

    #[test]
    fn other_power_broadcasts_are_ignored() {
        // PBT_APMPOWERSTATUSCHANGE (0x000A), PBT_POWERSETTINGCHANGE (0x8013),
        // and PBT_APMRESUMESUSPEND (0x0007) must not drive the socket.
        for wparam in [0x0000, 0x0007, 0x000A, 0x8013, 0xFFFF] {
            assert_eq!(power_event(wparam), None, "wparam {wparam:#x}");
        }
    }

    #[test]
    fn event_names_match_the_renderer_contract() {
        assert_eq!(PowerEvent::Suspend.name(), "termx://power-suspend");
        assert_eq!(PowerEvent::Resume.name(), "termx://power-resume");
    }

    #[test]
    fn wide_strings_are_nul_terminated_for_win32() {
        assert_eq!(wide("ab"), vec![b'a' as u16, b'b' as u16, 0]);
    }
}
