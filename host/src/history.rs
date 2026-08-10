//! Disk-spilled scrollback. Bytes evicted from a session's in-memory ring are
//! appended to `<data>/history/<session_id>.bin`, so history outlives the ring
//! while resident memory stays flat and capped.
//!
//! File format: `[8-byte LE u64 start_offset][raw evicted PTY bytes...]`.
//! `start_offset` is the ABSOLUTE stream offset of the first stored byte, so
//! byte `i` of the body is stream offset `start_offset + i` — the same offset
//! space `Replay` and output frames use. A writer is opened at session creation
//! and the ring evicts from offset 0 upward contiguously, so the header starts
//! at 0 and only cap truncation ever moves it forward.
//!
//! Failure is never fatal: history is a convenience layered on top of the
//! authoritative ring. An unwritable or corrupt spill file costs old scrollback,
//! never live output.

use crate::protocol::SessionId;
use anyhow::{bail, Context, Result};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// Bytes of `start_offset` header ahead of the body.
const HEADER_LEN: u64 = 8;

/// Largest slice one `read_history` request may return. Keeps a single reply
/// far below the WS frame limit even after base64 inflation.
pub const MAX_HISTORY_REQUEST_BYTES: u32 = 512 * 1024;

pub fn history_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("history")
}

pub fn session_file(data_dir: &Path, session_id: SessionId) -> PathBuf {
    history_dir(data_dir).join(format!("{session_id}.bin"))
}

/// Append-only spill file for one session's evicted scrollback.
pub struct HistoryWriter {
    path: PathBuf,
    /// Largest body (excluding the header) kept on disk before truncation.
    cap: u64,
    start_offset: u64,
    body_len: u64,
    file: File,
}

impl HistoryWriter {
    /// Create (or reset) this session's spill file. Called at session creation,
    /// when nothing has been evicted yet — hence the offset-0 header.
    pub fn open(data_dir: &Path, session_id: SessionId, cap: u64) -> Result<Self> {
        let dir = history_dir(data_dir);
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("creating history dir {}", dir.display()))?;
        let path = session_file(data_dir, session_id);
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&path)
            .with_context(|| format!("creating {}", path.display()))?;
        file.write_all(&0u64.to_le_bytes())
            .with_context(|| format!("writing header of {}", path.display()))?;
        Ok(Self {
            path,
            cap,
            start_offset: 0,
            body_len: 0,
            file,
        })
    }

    /// Absolute stream offset of the oldest byte still on disk.
    pub fn start_offset(&self) -> u64 {
        self.start_offset
    }

    /// Absolute stream offset just past the newest byte on disk. Equals the
    /// ring's start offset once anything has been evicted.
    pub fn end_offset(&self) -> u64 {
        self.start_offset + self.body_len
    }

    /// Append bytes the ring just dropped off its front, in stream order.
    pub fn append(&mut self, evicted: &[u8]) -> Result<()> {
        if evicted.is_empty() {
            return Ok(());
        }
        self.file
            .write_all(evicted)
            .with_context(|| format!("appending to {}", self.path.display()))?;
        self.body_len += evicted.len() as u64;
        if self.body_len > self.cap {
            self.truncate_oldest_half()?;
        }
        Ok(())
    }

    /// Drop the oldest half of the body. Coarse on purpose: the steady-state
    /// write path stays a plain append, and the cost of forgetting is paid
    /// rarely instead of on every eviction.
    fn truncate_oldest_half(&mut self) -> Result<()> {
        let dropped = self.body_len - self.body_len / 2;
        let kept_len = self.body_len - dropped;
        let mut kept = vec![0u8; kept_len as usize];
        self.file
            .seek(SeekFrom::Start(HEADER_LEN + dropped))
            .and_then(|_| self.file.read_exact(&mut kept))
            .with_context(|| format!("reading retained history of {}", self.path.display()))?;

        // Rewritten in place through our own handle. A crash mid-rewrite can
        // only corrupt history, which readers already degrade on — live output
        // never rides this file.
        let new_start = self.start_offset + dropped;
        self.file
            .seek(SeekFrom::Start(0))
            .and_then(|_| self.file.write_all(&new_start.to_le_bytes()))
            .and_then(|()| self.file.write_all(&kept))
            .and_then(|()| self.file.set_len(HEADER_LEN + kept_len))
            .and_then(|()| self.file.seek(SeekFrom::End(0)).map(|_| ()))
            .with_context(|| format!("truncating {}", self.path.display()))?;
        self.start_offset = new_start;
        self.body_len = kept_len;
        Ok(())
    }
}

pub struct HistorySlice {
    pub start_offset: u64,
    pub data: Vec<u8>,
    /// Nothing older than `start_offset` exists on disk.
    pub at_start: bool,
}

/// Read up to `max_bytes` of history ending just before `before_offset`.
/// `Ok(None)` means this session has no spill file — normal, not an error.
pub fn read_history(
    data_dir: &Path,
    session_id: SessionId,
    before_offset: u64,
    max_bytes: u32,
) -> Result<Option<HistorySlice>> {
    let path = session_file(data_dir, session_id);
    let mut file = match File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("opening {}", path.display()));
        }
    };
    let len = file
        .metadata()
        .with_context(|| format!("sizing {}", path.display()))?
        .len();
    if len < HEADER_LEN {
        bail!("history file {} is truncated", path.display());
    }
    let mut header = [0u8; HEADER_LEN as usize];
    file.read_exact(&mut header)
        .with_context(|| format!("reading header of {}", path.display()))?;
    let start = u64::from_le_bytes(header);
    let end = start + (len - HEADER_LEN);

    // A cursor outside the stored window is clamped, not an error: the UI pages
    // backward from a live offset that is normally past the file's end.
    let before = before_offset.clamp(start, end);
    let take = (before - start).min(u64::from(max_bytes.min(MAX_HISTORY_REQUEST_BYTES)));
    let slice_start = before - take;
    let mut data = vec![0u8; take as usize];
    file.seek(SeekFrom::Start(HEADER_LEN + (slice_start - start)))
        .and_then(|_| file.read_exact(&mut data))
        .with_context(|| format!("reading history from {}", path.display()))?;
    Ok(Some(HistorySlice {
        start_offset: slice_start,
        data,
        at_start: slice_start == start,
    }))
}

/// Forget one session's history (close_session). Best-effort: a file that is
/// already gone, or briefly locked, must never fail the close.
pub fn delete(data_dir: &Path, session_id: SessionId) {
    let path = session_file(data_dir, session_id);
    if let Err(error) = std::fs::remove_file(&path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!("removing {} failed: {error}", path.display());
        }
    }
}

/// Daemon boot: sessions never survive a daemon restart, so EVERY history file
/// on disk is stale and would otherwise accumulate forever.
pub fn sweep_all(data_dir: &Path) {
    let dir = history_dir(data_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.path().is_file() {
            if let Err(error) = std::fs::remove_file(entry.path()) {
                tracing::warn!("sweeping {} failed: {error}", entry.path().display());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slice(dir: &Path, before: u64, max: u32) -> HistorySlice {
        read_history(dir, 1, before, max)
            .expect("readable")
            .expect("file exists")
    }

    #[test]
    fn append_then_read_round_trips_absolute_offsets() {
        let tmp = tempfile::tempdir().unwrap();
        let mut writer = HistoryWriter::open(tmp.path(), 1, 1024).unwrap();
        assert_eq!((writer.start_offset(), writer.end_offset()), (0, 0));
        writer.append(b"0123456789").unwrap();
        assert_eq!(writer.end_offset(), 10);

        let page = slice(tmp.path(), 10, 4);
        assert_eq!(page.start_offset, 6);
        assert_eq!(page.data, b"6789");
        assert!(!page.at_start, "older bytes remain");

        let older = slice(tmp.path(), page.start_offset, 4);
        assert_eq!(older.start_offset, 2);
        assert_eq!(older.data, b"2345");

        let oldest = slice(tmp.path(), older.start_offset, 64);
        assert_eq!(oldest.start_offset, 0);
        assert_eq!(oldest.data, b"01");
        assert!(oldest.at_start, "reaching offset 0 ends the backward walk");
    }

    #[test]
    fn empty_append_is_a_no_op() {
        let tmp = tempfile::tempdir().unwrap();
        let mut writer = HistoryWriter::open(tmp.path(), 1, 1024).unwrap();
        writer.append(b"").unwrap();
        assert_eq!(writer.end_offset(), 0);
        assert!(slice(tmp.path(), 0, 16).at_start);
    }

    #[test]
    fn cap_truncation_keeps_the_newer_half_and_advances_the_start() {
        let tmp = tempfile::tempdir().unwrap();
        let mut writer = HistoryWriter::open(tmp.path(), 1, 8).unwrap();
        writer.append(b"0123456789").unwrap(); // 10 bytes into a cap of 8

        assert_eq!(writer.start_offset(), 5, "oldest half is forgotten");
        assert_eq!(writer.end_offset(), 10, "the stream end never moves back");
        let page = slice(tmp.path(), 10, 64);
        assert_eq!(page.start_offset, 5);
        assert_eq!(page.data, b"56789");
        assert!(page.at_start, "nothing older survives the truncation");

        // Appends after a truncation must still land at the right offsets.
        writer.append(b"AB").unwrap();
        assert_eq!(writer.end_offset(), 12);
        let after = slice(tmp.path(), 12, 64);
        assert_eq!(after.start_offset, 5);
        assert_eq!(after.data, b"56789AB");
    }

    #[test]
    fn repeated_truncation_stays_bounded() {
        let tmp = tempfile::tempdir().unwrap();
        let cap = 512;
        let mut writer = HistoryWriter::open(tmp.path(), 1, cap).unwrap();
        for _ in 0..200 {
            writer.append(&[b'x'; 64]).unwrap();
        }
        let on_disk = std::fs::metadata(session_file(tmp.path(), 1))
            .unwrap()
            .len();
        assert!(
            on_disk <= HEADER_LEN + cap,
            "history file grew past its cap: {on_disk}"
        );
        assert_eq!(writer.end_offset(), 200 * 64);
    }

    #[test]
    fn a_cursor_past_the_stored_window_is_clamped_not_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let mut writer = HistoryWriter::open(tmp.path(), 1, 1024).unwrap();
        writer.append(b"abcdef").unwrap();

        // The UI pages backward from a LIVE offset, far past the spill file.
        let page = slice(tmp.path(), 9_999, 64);
        assert_eq!(page.start_offset, 0);
        assert_eq!(page.data, b"abcdef");
        assert!(page.at_start);

        let nothing = slice(tmp.path(), 0, 64);
        assert!(nothing.data.is_empty());
        assert!(nothing.at_start, "at the very start there is nothing older");
    }

    #[test]
    fn request_size_is_capped() {
        let tmp = tempfile::tempdir().unwrap();
        let mut writer = HistoryWriter::open(tmp.path(), 1, 4 * 1024 * 1024).unwrap();
        writer
            .append(&vec![b'y'; (MAX_HISTORY_REQUEST_BYTES as usize) + 4_096])
            .unwrap();
        let page = slice(tmp.path(), writer.end_offset(), u32::MAX);
        assert_eq!(page.data.len(), MAX_HISTORY_REQUEST_BYTES as usize);
        assert!(!page.at_start);
    }

    #[test]
    fn missing_file_reads_as_absent_not_as_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_history(tmp.path(), 42, 100, 64).unwrap().is_none());
    }

    #[test]
    fn corrupt_file_is_an_error_the_caller_can_degrade_on() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(history_dir(tmp.path())).unwrap();
        std::fs::write(session_file(tmp.path(), 7), b"xx").unwrap();
        assert!(read_history(tmp.path(), 7, 100, 64).is_err());
    }

    #[test]
    fn delete_removes_one_session_and_tolerates_a_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        HistoryWriter::open(tmp.path(), 1, 1024).unwrap();
        HistoryWriter::open(tmp.path(), 2, 1024).unwrap();

        delete(tmp.path(), 1);

        assert!(!session_file(tmp.path(), 1).exists());
        assert!(session_file(tmp.path(), 2).exists(), "other sessions stay");
        delete(tmp.path(), 1); // idempotent
    }

    #[test]
    fn sweep_all_clears_stale_history_at_boot() {
        let tmp = tempfile::tempdir().unwrap();
        HistoryWriter::open(tmp.path(), 1, 1024).unwrap();
        HistoryWriter::open(tmp.path(), 2, 1024).unwrap();

        sweep_all(tmp.path());

        assert_eq!(
            std::fs::read_dir(history_dir(tmp.path()))
                .unwrap()
                .flatten()
                .count(),
            0,
            "no session survives a daemon restart, so no history file may"
        );
        sweep_all(tmp.path()); // no dir / empty dir is fine
    }
}
