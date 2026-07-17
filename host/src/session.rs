//! One ConPTY-backed shell session. The reader thread is the only place PTY
//! output enters the system: ring buffer first (authoritative, capped), then
//! a bounded broadcast for live listeners. No client/socket state lives here.

use crate::profiles::Profile;
use crate::ring::RingBuffer;
use anyhow::{Context, Result};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;

/// Count occurrences of the DSR cursor-position query ESC[6n in `bytes`.
fn count_dsr_queries(bytes: &[u8]) -> usize {
    bytes.windows(4).filter(|w| w == b"\x1b[6n").count()
}

#[derive(Clone, Debug)]
pub struct OutputChunk {
    pub offset: u64,
    pub data: Arc<Vec<u8>>,
}

enum WriterCmd {
    Data(Vec<u8>),
}

pub struct Session {
    ring: Arc<Mutex<RingBuffer>>,
    tx_out: broadcast::Sender<OutputChunk>,
    tx_writer: std::sync::mpsc::Sender<WriterCmd>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    exit: Arc<Mutex<Option<Option<u32>>>>,
}

impl Session {
    pub fn spawn(
        profile: &Profile,
        cwd: Option<&Path>,
        cols: u16,
        rows: u16,
        ring_cap: usize,
    ) -> Result<Session> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .context("openpty")?;

        let mut cmd = CommandBuilder::new(profile.command.as_os_str());
        cmd.args(profile.args.iter());
        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }
        let mut child = pair.slave.spawn_command(cmd).context("spawn shell")?;
        let killer = child.clone_killer();
        // Windows kills the child with 0xC0000142 (STATUS_DLL_INIT_FAILED) if
        // slave handles close during its initialization (wezterm/wezterm#4674).
        // The waiter thread owns the slave and drops it only after exit.
        let slave = pair.slave;

        let mut reader = pair.master.try_clone_reader().context("clone reader")?;
        let mut writer = pair.master.take_writer().context("take writer")?;

        let ring = Arc::new(Mutex::new(RingBuffer::new(ring_cap)));
        let (tx_out, _) = broadcast::channel::<OutputChunk>(256);
        let exit: Arc<Mutex<Option<Option<u32>>>> = Arc::new(Mutex::new(None));

        // Writer thread: serializes all input to the PTY.
        let (tx_writer, rx_writer) = std::sync::mpsc::channel::<WriterCmd>();
        std::thread::spawn(move || {
            while let Ok(WriterCmd::Data(data)) = rx_writer.recv() {
                if writer.write_all(&data).is_err() {
                    break; // PTY gone; child exited
                }
                let _ = writer.flush();
            }
        });

        // Reader thread: sole producer into ring + broadcast. Also answers
        // ConPTY's cursor-position query (ESC[6n): conhost BLOCKS child console
        // init until the hosting terminal responds, and with no UI attached the
        // host is that terminal. Without this, children wedge before their first
        // instruction (observed on Windows 26200; bytes: 9001h/1004h then 6n).
        let ring_r = Arc::clone(&ring);
        let tx_r = tx_out.clone();
        let tx_dsr = tx_writer.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut carry: Vec<u8> = Vec::new(); // tail bytes: catches ESC[6n split across reads
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break, // EOF: child exited
                    Ok(n) => {
                        let mut ring = ring_r.lock().unwrap();
                        let offset = ring.end_offset();
                        ring.push(&buf[..n]);
                        drop(ring);
                        // Laggards get Lagged and resync via snapshot(); send() only
                        // errors when there are no receivers, which is fine.
                        let _ = tx_r.send(OutputChunk {
                            offset,
                            data: Arc::new(buf[..n].to_vec()),
                        });
                        let mut scan = std::mem::take(&mut carry);
                        scan.extend_from_slice(&buf[..n]);
                        for _ in 0..count_dsr_queries(&scan) {
                            let _ = tx_dsr.send(WriterCmd::Data(b"\x1b[1;1R".to_vec()));
                        }
                        let keep = scan.len().min(3);
                        carry = scan[scan.len() - keep..].to_vec();
                    }
                }
            }
        });

        // Waiter thread: records the exit code once, then releases the slave.
        let exit_w = Arc::clone(&exit);
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code());
            drop(slave);
            *exit_w.lock().unwrap() = Some(code);
        });

        Ok(Session {
            ring,
            tx_out,
            tx_writer,
            master: Mutex::new(pair.master),
            killer: Mutex::new(killer),
            exit,
        })
    }

    pub fn write_input(&self, data: &[u8]) -> Result<()> {
        self.tx_writer
            .send(WriterCmd::Data(data.to_vec()))
            .ok()
            .context("session writer thread gone")
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .lock()
            .unwrap()
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .context("pty resize")
    }

    pub fn subscribe(&self) -> broadcast::Receiver<OutputChunk> {
        self.tx_out.subscribe()
    }

    pub fn snapshot(&self) -> (u64, Vec<u8>) {
        self.ring.lock().unwrap().snapshot()
    }

    pub fn kill(&self) {
        let _ = self.killer.lock().unwrap().kill();
    }

    pub fn exited(&self) -> Option<Option<u32>> {
        *self.exit.lock().unwrap()
    }

    pub fn wait_exit_blocking(&self, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if self.exited().is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles;

    fn collect_output_until_exit(s: &Session) -> String {
        assert!(s.wait_exit_blocking(Duration::from_secs(30)), "session should exit");
        // Ring holds everything (tests stay under cap): decode lossily.
        let (_, bytes) = s.snapshot();
        String::from_utf8_lossy(&bytes).to_string()
    }

    #[test]
    fn cmd_echo_round_trip() {
        let profile = profiles::resolve("cmd").unwrap();
        let mut p = profile.clone();
        p.args = vec!["/c".into(), "echo termx_alive".into()];
        let s = Session::spawn(&p, None, 80, 25, 1024 * 1024).unwrap();
        let out = collect_output_until_exit(&s);
        assert!(out.contains("termx_alive"), "output was: {out:?}");
        assert_eq!(s.exited().unwrap(), Some(0));
    }

    #[test]
    fn respects_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let profile = profiles::resolve("cmd").unwrap();
        let mut p = profile.clone();
        p.args = vec!["/c".into(), "cd".into()]; // `cd` with no args prints cwd
        let s = Session::spawn(&p, Some(tmp.path()), 80, 25, 1024 * 1024).unwrap();
        let out = collect_output_until_exit(&s);
        let tail = tmp.path().file_name().unwrap().to_string_lossy().to_string();
        assert!(out.contains(&tail), "cwd dir name '{tail}' not in: {out:?}");
    }

    #[test]
    fn write_input_drives_an_interactive_shell() {
        let profile = profiles::resolve("cmd").unwrap(); // interactive cmd
        let s = Session::spawn(&profile, None, 80, 25, 1024 * 1024).unwrap();
        let mut rx = s.subscribe();
        s.write_input(b"echo in_band_marker\r\n").unwrap();
        // Drain broadcast until the marker echoes back (or time out).
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        let mut seen = String::new();
        while std::time::Instant::now() < deadline && !seen.contains("in_band_marker") {
            match rx.try_recv() {
                Ok(chunk) => seen.push_str(&String::from_utf8_lossy(&chunk.data)),
                Err(broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                Err(broadcast::error::TryRecvError::Closed) => break,
            }
        }
        assert!(seen.contains("in_band_marker"), "echo not observed; saw: {seen:?}");
        s.kill();
        assert!(s.wait_exit_blocking(Duration::from_secs(10)));
    }

    #[test]
    fn kill_terminates_and_reports_exit() {
        let profile = profiles::resolve("cmd").unwrap();
        let s = Session::spawn(&profile, None, 80, 25, 1024 * 1024).unwrap();
        assert!(s.exited().is_none(), "fresh interactive session is alive");
        s.kill();
        assert!(s.wait_exit_blocking(Duration::from_secs(10)), "killed session must exit");
    }
}
