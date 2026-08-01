//! Codex adapter.
//!
//! Codex already maintains a session index (`session_index.jsonl`), so titles
//! and recency are cheap. Only the working directory costs an open: it lives
//! in the `session_meta` line at the head of the matching rollout file under
//! `sessions\<year>\<month>\<day>\`. That head line embeds the full system
//! prompt and can be tens of KB, so the read is bounded like Claude's.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Codex's own index of threads, relative to `.codex`.
pub const INDEX_FILE: &str = "session_index.jsonl";
/// Root of the rollout transcripts, relative to `.codex`.
pub const SESSIONS_DIR: &str = "sessions";
/// Bytes read from the head of a rollout file when looking for the cwd.
pub const HEAD_BYTES: u64 = 256 * 1024;
/// `sessions\2026\07\31\rollout-....jsonl` is three levels; one spare level
/// keeps an unexpected layout from turning into an unbounded walk.
const MAX_WALK_DEPTH: usize = 4;

/// One line of Codex's session index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodexIndexEntry {
    pub id: String,
    /// `thread_name`; may be empty, in which case the caller falls back.
    pub title: String,
    /// `None` when `updated_at` is missing or unparseable — the caller then
    /// falls back to the rollout file's mtime.
    pub updated_at_ms: Option<u64>,
}

/// Parse the index, skipping any line that is not a usable entry.
pub fn parse_codex_index(text: &str) -> Vec<CodexIndexEntry> {
    text.lines()
        .filter_map(|line| {
            let value: Value = serde_json::from_str(line.trim()).ok()?;
            let id = value.get("id").and_then(Value::as_str)?.trim();
            if id.is_empty() {
                return None; // an entry with no id cannot be resumed or keyed
            }
            Some(CodexIndexEntry {
                id: id.to_string(),
                title: value
                    .get("thread_name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                updated_at_ms: value
                    .get("updated_at")
                    .and_then(Value::as_str)
                    .and_then(parse_iso8601_ms),
            })
        })
        .collect()
}

/// Map rollout id → transcript path, by walking the date-partitioned store
/// once per scan. Filenames look like
/// `rollout-<timestamp>-<uuid>.jsonl`, so the id is the trailing UUID.
///
/// Duplicate ids keep the greater path: the embedded timestamp sorts
/// lexicographically, so that is the newer file.
pub fn rollout_files(sessions_root: &Path) -> HashMap<String, PathBuf> {
    let mut found = HashMap::new();
    walk(sessions_root, 0, &mut found);
    found
}

fn walk(dir: &Path, depth: usize, found: &mut HashMap<String, PathBuf>) {
    if depth > MAX_WALK_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            walk(&path, depth + 1, found);
            continue;
        }
        let Some(id) = rollout_id_of(&path) else {
            continue;
        };
        match found.get(&id) {
            Some(existing) if *existing >= path => {}
            _ => {
                found.insert(id, path);
            }
        }
    }
}

/// The session id encoded in a rollout filename, or `None` when the name does
/// not end in a UUID.
pub fn rollout_id_of(path: &Path) -> Option<String> {
    if !path
        .extension()
        .and_then(|e| e.to_str())?
        .eq_ignore_ascii_case("jsonl")
    {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    let start = stem.len().checked_sub(36)?;
    if !stem.is_char_boundary(start) {
        return None; // a multi-byte name cannot end in an ASCII uuid
    }
    let candidate = &stem[start..];
    is_uuid(candidate).then(|| candidate.to_ascii_lowercase())
}

fn is_uuid(text: &str) -> bool {
    let groups = [8usize, 4, 4, 4, 12];
    let mut parts = text.split('-');
    for len in groups {
        match parts.next() {
            Some(part) if part.len() == len && part.bytes().all(|b| b.is_ascii_hexdigit()) => {}
            _ => return false,
        }
    }
    parts.next().is_none()
}

/// The cwd recorded at the head of a rollout file, or `None`.
pub fn rollout_cwd_of(path: &Path) -> Option<String> {
    rollout_cwd(&read_head(path, HEAD_BYTES)?)
}

/// Pure core: the cwd from a bounded head excerpt. Prefers the `session_meta`
/// payload and falls back to any top-level `cwd`, because a tolerant scan of
/// user data outlives one provider's schema.
pub fn rollout_cwd(head: &str) -> Option<String> {
    let mut fallback = None;
    for line in head.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("session_meta") {
            if let Some(cwd) = value
                .get("payload")
                .and_then(|p| p.get("cwd"))
                .and_then(Value::as_str)
                .filter(|c| !c.trim().is_empty())
            {
                return Some(cwd.trim().to_string());
            }
        }
        if fallback.is_none() {
            fallback = value
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|c| !c.trim().is_empty())
                .map(|c| c.trim().to_string());
        }
    }
    fallback
}

fn read_head(path: &Path, cap: u64) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    file.take(cap).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Milliseconds since the epoch from an ISO-8601 stamp
/// (`2026-03-12T18:34:21.1342818Z`, with or without fraction, with `Z` or a
/// `±HH:MM` offset). `None` for anything else — the caller has an mtime to
/// fall back on, so guessing would only hide a format change.
pub fn parse_iso8601_ms(text: &str) -> Option<u64> {
    let text = text.trim();
    let (date, rest) = text.split_once(['T', 't', ' '])?;
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: u32 = date_parts.next()?.parse().ok()?;
    let day: u32 = date_parts.next()?.parse().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    // Split the offset off the time before parsing it.
    let (time, offset_ms) = split_offset(rest)?;
    let mut time_parts = time.split(':');
    let hour: i64 = time_parts.next()?.parse().ok()?;
    let minute: i64 = time_parts.next()?.parse().ok()?;
    let seconds = time_parts.next().unwrap_or("0");
    if time_parts.next().is_some() {
        return None;
    }
    let (whole, fraction) = seconds.split_once('.').unwrap_or((seconds, ""));
    let second: i64 = whole.parse().ok()?;
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    // Sub-millisecond precision is dropped, not rounded; the index only ever
    // sorts by this value.
    if !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let millis: i64 = fraction
        .chars()
        .chain("000".chars())
        .take(3)
        .collect::<String>()
        .parse()
        .ok()?;

    let days = days_from_civil(year, month, day);
    let total = days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000;
    u64::try_from(total + millis - offset_ms).ok()
}

/// Returns the time part and the offset in milliseconds to subtract. A stamp
/// with no zone at all is read as UTC rather than rejected.
fn split_offset(rest: &str) -> Option<(&str, i64)> {
    if let Some(time) = rest.strip_suffix(['Z', 'z']) {
        return Some((time, 0));
    }
    let Some(sign_at) = rest.rfind(['+', '-']) else {
        return Some((rest, 0));
    };
    let (time, offset) = rest.split_at(sign_at);
    let negative = offset.starts_with('-');
    let (hours, minutes) = offset[1..].split_once(':').unwrap_or((&offset[1..], "0"));
    let hours: i64 = hours.parse().ok()?;
    let minutes: i64 = minutes.parse().ok()?;
    let ms = (hours * 3_600_000) + (minutes * 60_000);
    Some((time, if negative { -ms } else { ms }))
}

/// Days since 1970-01-01 (Howard Hinnant's civil-from-days, inverted).
/// Cheaper than a date crate for the one thing this module needs.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let shifted = i64::from(if month > 2 { month - 3 } else { month + 9 });
    let day_of_year = (153 * shifted + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_index_lines_and_skips_unusable_ones() {
        let text = [
            "{\"id\":\"019ce354-0101-7a92-9a4d-3123a993d4f9\",\"thread_name\":\"Create repo\",\"updated_at\":\"2026-03-12T18:34:21.1342818Z\"}",
            "not json",
            "{\"thread_name\":\"no id\"}",
            "{\"id\":\"   \",\"thread_name\":\"blank id\"}",
            "{\"id\":\"second\",\"updated_at\":\"nonsense\"}",
            "",
        ]
        .join("\n");

        let got = parse_codex_index(&text);
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!(got[0].id, "019ce354-0101-7a92-9a4d-3123a993d4f9");
        assert_eq!(got[0].title, "Create repo");
        assert_eq!(got[0].updated_at_ms, Some(1_773_340_461_134));
        assert_eq!(
            got[1].title, "",
            "missing thread_name is empty, not an error"
        );
        assert_eq!(got[1].updated_at_ms, None, "unparseable stamp falls back");
    }

    #[test]
    fn iso_stamps_parse_to_epoch_millis() {
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00.250Z"), Some(250));
        assert_eq!(
            parse_iso8601_ms("2026-03-12T18:34:21Z"),
            Some(1_773_340_461_000)
        );
        // Fractional precision beyond milliseconds truncates.
        assert_eq!(
            parse_iso8601_ms("2026-03-12T18:34:21.1342818Z"),
            Some(1_773_340_461_134)
        );
        // Offsets normalize to UTC.
        assert_eq!(
            parse_iso8601_ms("2026-03-12T19:34:21+01:00"),
            Some(1_773_340_461_000)
        );
        assert_eq!(
            parse_iso8601_ms("2026-03-12T13:34:21-05:00"),
            Some(1_773_340_461_000)
        );
        // A leap day only lands right if the calendar math is real.
        assert_eq!(
            parse_iso8601_ms("2024-02-29T00:00:00Z"),
            Some(1_709_164_800_000)
        );
    }

    #[test]
    fn unparseable_stamps_are_none_rather_than_a_guess() {
        for junk in [
            "",
            "nonsense",
            "2026-03-12",
            "2026-13-12T00:00:00Z",
            "2026-03-32T00:00:00Z",
            "2026-03-12T25:00:00Z",
            "2026-03-12T00:61:00Z",
            "2026-03-12T00:00:00:00Z",
            "1960-01-01T00:00:00Z", // before the epoch: not representable
        ] {
            assert_eq!(parse_iso8601_ms(junk), None, "{junk:?} must not parse");
        }
    }

    #[test]
    fn cwd_comes_from_the_session_meta_payload() {
        let head = [
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}",
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"x\",\"cwd\":\"C:\\\\Users\\\\me\"}}",
        ]
        .join("\n");
        assert_eq!(rollout_cwd(&head).as_deref(), Some(r"C:\Users\me"));
    }

    #[test]
    fn a_top_level_cwd_is_the_fallback_and_absence_is_none() {
        assert_eq!(
            rollout_cwd("{\"type\":\"turn\",\"cwd\":\"C:\\\\Dev\"}").as_deref(),
            Some(r"C:\Dev")
        );
        assert_eq!(rollout_cwd("garbage\n{\"type\":\"turn\"}"), None);
        assert_eq!(rollout_cwd(""), None);
        // An empty cwd is not a directory.
        assert_eq!(
            rollout_cwd("{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"  \"}}"),
            None
        );
    }

    #[test]
    fn rollout_ids_come_from_the_uuid_suffix_of_the_filename() {
        let id = "019eae0f-3dce-7bc1-92d5-869accc96af0";
        let path = PathBuf::from(format!("C:\\s\\rollout-2026-06-09T13-24-54-{id}.jsonl"));
        assert_eq!(rollout_id_of(&path).as_deref(), Some(id));

        for junk in [
            "C:\\s\\rollout-2026-06-09.jsonl",
            "C:\\s\\notes.txt",
            "C:\\s\\rollout-019eae0f-3dce-7bc1-92d5-869accc96af0.txt",
            "C:\\s\\rollout-zzzzzzzz-3dce-7bc1-92d5-869accc96af0.jsonl",
        ] {
            assert_eq!(rollout_id_of(Path::new(junk)), None, "{junk}");
        }
    }

    #[test]
    fn the_rollout_walk_indexes_date_partitioned_files() {
        let dir = tempfile::Builder::new()
            .prefix("termx-codex-")
            .tempdir()
            .unwrap();
        let id = "019eae0f-3dce-7bc1-92d5-869accc96af0";
        let day = dir.path().join("2026").join("06").join("09");
        std::fs::create_dir_all(&day).unwrap();
        let older = day.join(format!("rollout-2026-06-09T01-00-00-{id}.jsonl"));
        let newer = day.join(format!("rollout-2026-06-09T13-24-54-{id}.jsonl"));
        std::fs::write(&older, b"{}").unwrap();
        std::fs::write(&newer, b"{}").unwrap();
        std::fs::write(day.join("stray.jsonl"), b"{}").unwrap();

        let found = rollout_files(dir.path());
        assert_eq!(found.len(), 1, "only real rollouts: {found:?}");
        assert_eq!(found.get(id), Some(&newer), "newest duplicate wins");

        // A missing store is empty, not an error.
        assert!(rollout_files(&dir.path().join("nope")).is_empty());
    }

    #[test]
    fn reading_a_head_is_bounded_and_missing_files_are_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.jsonl");
        let mut body =
            String::from("{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"C:\\\\A\"}}\n");
        body.push_str(&"z".repeat(300 * 1024));
        std::fs::write(&path, &body).unwrap();

        assert_eq!(
            read_head(&path, HEAD_BYTES).unwrap().len(),
            HEAD_BYTES as usize
        );
        assert_eq!(rollout_cwd_of(&path).as_deref(), Some(r"C:\A"));
        assert_eq!(rollout_cwd_of(&dir.path().join("gone.jsonl")), None);
    }
}
