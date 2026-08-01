//! Bounded text reads for the native file viewer (spec §12).
//!
//! The viewer opens whatever an AI run happened to produce, so the path comes
//! from a transcript rather than a picker: it may be gone, a directory, a
//! 4 GB log or a binary. None of those may reach the renderer as an error
//! dialog — the viewer frame shows a one-line notice instead — so the command
//! answers `None` for everything it cannot render and never propagates an
//! `io::Error`.
//!
//! Two hard limits do the protecting: at most `MAX_BYTES` is ever read (the
//! rest is reported through `truncated`), and a NUL byte anywhere in the first
//! `SNIFF_BYTES` means "binary, refuse" — the cheap test that keeps executables
//! and UTF-16 files out of a monospace pane.

use std::io::Read;
use std::path::Path;

use serde::Serialize;

/// Reading stops here; beyond it the viewer shows a truncation notice.
pub const MAX_BYTES: usize = 2 * 1024 * 1024;

/// How far in to look for a NUL before calling the file text.
const SNIFF_BYTES: usize = 8 * 1024;

/// UTF-8 byte order mark.
const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// A viewable text file: its (possibly truncated) contents plus whether more
/// exists on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub content: String,
    pub truncated: bool,
}

/// Tauri command: read `path` as text for the viewer. Missing, unreadable or
/// binary → `None`; never errors.
#[tauri::command]
pub async fn read_text_file(path: String) -> Option<FileText> {
    // Up to 2 MB off a possibly-network path: never on the IPC thread.
    tauri::async_runtime::spawn_blocking(move || read_text_file_at(Path::new(&path)))
        .await
        .ok()
        .flatten()
}

/// Command body against the real filesystem.
pub fn read_text_file_at(path: &Path) -> Option<FileText> {
    let file = std::fs::File::open(path).ok()?;
    // On unix a directory opens fine and only fails at read time; check up
    // front so both platforms answer `None` for the same reason.
    if file.metadata().ok()?.is_dir() {
        return None;
    }

    // One byte past the cap is what distinguishes "exactly 2 MB" from "more
    // than 2 MB" without a second stat that could race the file growing.
    let mut buf = Vec::new();
    file.take(MAX_BYTES as u64 + 1).read_to_end(&mut buf).ok()?;
    let truncated = buf.len() > MAX_BYTES;
    if truncated {
        buf.truncate(MAX_BYTES);
    }
    decode(&buf, truncated).map(|content| FileText { content, truncated })
}

/// `None` when the head sniffs as binary. Otherwise a lossy decode: a stray
/// bad byte should cost one replacement character, not the whole file.
fn decode(bytes: &[u8], truncated: bool) -> Option<String> {
    if bytes[..bytes.len().min(SNIFF_BYTES)].contains(&0) {
        return None;
    }
    // Cutting at the cap can land mid-character; dropping that stub is why the
    // last visible character is never a stray replacement glyph.
    let body = if truncated {
        valid_utf8_prefix(bytes)
    } else {
        bytes
    };
    // A BOM is invisible in a hex dump and fatal to the markdown renderer: a
    // leading U+FEFF stops `# Title` from being a heading. Strip it as bytes so
    // a 2 MB file is not copied twice.
    let body = body.strip_prefix(BOM).unwrap_or(body);
    Some(match std::str::from_utf8(body) {
        Ok(text) => text.to_string(),
        Err(_) => String::from_utf8_lossy(body).into_owned(),
    })
}

/// Trim up to three trailing bytes to reach a valid UTF-8 boundary. Anything
/// else wrong with the file is left to the lossy decode.
fn valid_utf8_prefix(bytes: &[u8]) -> &[u8] {
    for cut in 0..4.min(bytes.len() + 1) {
        let end = bytes.len() - cut;
        if std::str::from_utf8(&bytes[..end]).is_ok() {
            return &bytes[..end];
        }
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn small_text_files_read_whole_and_unflagged() {
        let tmp = tempfile::tempdir().unwrap();
        let body = "# Spec\n\n- item one\n- café ✓\n";
        let got = read_text_file_at(&write(tmp.path(), "notes.md", body.as_bytes())).unwrap();
        assert_eq!(
            got,
            FileText {
                content: body.to_string(),
                truncated: false
            }
        );
    }

    #[test]
    fn an_empty_file_is_readable_not_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let got = read_text_file_at(&write(tmp.path(), "empty.txt", b"")).unwrap();
        assert_eq!(
            got,
            FileText {
                content: String::new(),
                truncated: false
            }
        );
    }

    #[test]
    fn a_nul_in_the_sniff_window_refuses_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        for (name, body) in [
            ("head.bin", vec![0u8, b'M', b'Z']),
            ("late.bin", {
                let mut v = vec![b'a'; SNIFF_BYTES - 1];
                v.push(0);
                v
            }),
            ("utf16.txt", b"h\0e\0l\0l\0o\0".to_vec()),
        ] {
            assert_eq!(
                read_text_file_at(&write(tmp.path(), name, &body)),
                None,
                "{name} must sniff as binary"
            );
        }
    }

    #[test]
    fn a_nul_past_the_sniff_window_is_still_text() {
        let tmp = tempfile::tempdir().unwrap();
        let mut body = vec![b'a'; SNIFF_BYTES];
        body.push(0);
        let got = read_text_file_at(&write(tmp.path(), "late-nul.txt", &body)).unwrap();
        assert_eq!(got.content.len(), SNIFF_BYTES + 1);
        assert!(!got.truncated);
    }

    #[test]
    fn exactly_the_cap_is_not_truncated_but_one_byte_more_is() {
        let tmp = tempfile::tempdir().unwrap();

        let exact =
            read_text_file_at(&write(tmp.path(), "exact.txt", &vec![b'x'; MAX_BYTES])).unwrap();
        assert_eq!(exact.content.len(), MAX_BYTES);
        assert!(!exact.truncated, "a file at the cap is complete");

        let over =
            read_text_file_at(&write(tmp.path(), "over.txt", &vec![b'x'; MAX_BYTES + 1])).unwrap();
        assert_eq!(over.content.len(), MAX_BYTES);
        assert!(over.truncated);
    }

    #[test]
    fn truncation_never_splits_a_multibyte_character() {
        let tmp = tempfile::tempdir().unwrap();
        // '✓' is three bytes and straddles the cap: one byte inside, two out.
        let mut body = vec![b'x'; MAX_BYTES - 1];
        body.extend_from_slice("✓✓✓".as_bytes());
        let got = read_text_file_at(&write(tmp.path(), "split.md", &body)).unwrap();

        assert!(got.truncated);
        assert_eq!(
            got.content.len(),
            MAX_BYTES - 1,
            "the partial char is dropped"
        );
        assert!(
            !got.content.contains('\u{fffd}'),
            "no replacement character may reach the viewer"
        );
        assert!(got.content.ends_with('x'));
    }

    #[test]
    fn invalid_utf8_degrades_to_replacement_characters() {
        let tmp = tempfile::tempdir().unwrap();
        let got = read_text_file_at(&write(tmp.path(), "latin1.txt", b"caf\xe9 time")).unwrap();
        assert_eq!(got.content, "caf\u{fffd} time");
        assert!(!got.truncated);
    }

    #[test]
    fn a_utf8_bom_is_stripped_so_markdown_still_parses() {
        let tmp = tempfile::tempdir().unwrap();
        let got = read_text_file_at(&write(tmp.path(), "bom.md", "\u{feff}# Title\n".as_bytes()))
            .unwrap();
        assert_eq!(got.content, "# Title\n");
    }

    #[test]
    fn missing_paths_and_directories_read_as_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(read_text_file_at(&tmp.path().join("nope.txt")), None);
        assert_eq!(read_text_file_at(&tmp.path().join("a").join("b.txt")), None);
        assert_eq!(read_text_file_at(tmp.path()), None);
    }

    #[test]
    fn valid_utf8_prefix_only_trims_an_incomplete_tail() {
        assert_eq!(valid_utf8_prefix(b"abc"), b"abc");
        assert_eq!(valid_utf8_prefix("ab✓".as_bytes()), "ab✓".as_bytes());
        assert_eq!(valid_utf8_prefix(&[b'a', 0xE2, 0x9C]), b"a");
        assert_eq!(valid_utf8_prefix(&[b'a', 0xE2]), b"a");
        assert_eq!(valid_utf8_prefix(b""), b"");
    }
}
