//! Claude Code transcript adapter.
//!
//! Transcripts are append-only JSONL and can pass 100 MB, so harvesting reads
//! only the first and last 256 KB. That bound is also why every field is
//! collected line-by-line rather than by parsing the file as a document: a
//! line clipped by the excerpt boundary simply fails to parse and is skipped,
//! which is the same handling a genuinely corrupt line gets.

use std::path::Path;

use serde_json::Value;

use super::{SessionRecord, TITLE_SOURCE_DERIVED, TITLE_SOURCE_NAMED};

/// Bytes read from each end of a transcript.
pub const EXCERPT_BYTES: u64 = 256 * 1024;
/// Titles are one row of a list, not a paragraph.
pub const TITLE_MAX_CHARS: usize = 120;
/// A compaction block is thousands of words; the rail shows an opening slice.
pub const RECAP_MAX_CHARS: usize = 2_000;
/// Disk summaries are one-liners by convention. The cap only stops a hostile
/// or runaway file from bloating the persisted index.
pub const SUMMARY_MAX_CHARS: usize = 500;

/// The marker Claude Code writes at the top of a post-compaction user turn.
const COMPACTION_PREFIX: &str = "This session is being continued";

/// Harvest one transcript. `None` only when the file cannot be opened or has
/// no usable name; unreadable *content* still yields a record.
pub fn harvest_claude_file(path: &Path) -> Option<SessionRecord> {
    let meta = std::fs::metadata(path).ok()?;
    let id = path.file_stem()?.to_string_lossy().into_owned();
    let slug = path
        .parent()
        .and_then(Path::file_name)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (head, tail) = read_head_and_tail(path, meta.len(), EXCERPT_BYTES)?;
    Some(harvest_claude_excerpts(
        &path.to_string_lossy(),
        &id,
        &slug,
        &head,
        &tail,
        super::mtime_ms(&meta),
    ))
}

/// Pure core: build a record from the two excerpts, so fixtures drive the
/// harvesting rules without touching the filesystem.
///
/// Head and tail are scanned in that order, which is what makes "first cwd",
/// "first user message" and "last summary" mean what they say. For files
/// under one excerpt the tail is empty and the head is the whole file.
pub fn harvest_claude_excerpts(
    file_path: &str,
    id: &str,
    slug: &str,
    head: &str,
    tail: &str,
    updated_at_ms: u64,
) -> SessionRecord {
    let mut acc = Harvest::default();
    scan_lines(head, &mut acc);
    scan_lines(tail, &mut acc);

    // The `summary` line is the name Claude Code itself shows for the
    // session, so when one exists it IS the title and nothing generated may
    // replace it. Without one, the best we can do is a fragment of the first
    // thing the user typed (or the bare id) — a derived title, and the only
    // case the UI is allowed to show a generated name instead.
    let (title, title_source) = match acc.summary.clone().filter(|s| !s.is_empty()) {
        Some(summary) => (summary, TITLE_SOURCE_NAMED),
        None => (
            acc.title
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| id.to_string()),
            TITLE_SOURCE_DERIVED,
        ),
    };

    SessionRecord {
        provider: "claude".to_string(),
        id: id.to_string(),
        title,
        title_source: title_source.to_string(),
        // Slug decoding is ambiguous (a real directory name may contain
        // dashes), so it is only ever a fallback for a transcript that never
        // recorded its cwd.
        cwd: acc.cwd.or_else(|| decode_slug(slug)),
        file_path: file_path.to_string(),
        updated_at_ms,
        summary: acc.summary,
        recap: acc.recap,
    }
}

#[derive(Default)]
struct Harvest {
    cwd: Option<String>,
    title: Option<String>,
    summary: Option<String>,
    recap: Option<String>,
}

fn scan_lines(chunk: &str, acc: &mut Harvest) {
    for line in chunk.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue; // malformed, truncated by the excerpt bound, or binary
        };

        if acc.cwd.is_none() {
            if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
                if !cwd.trim().is_empty() {
                    acc.cwd = Some(cwd.trim().to_string());
                }
            }
        }

        match value.get("type").and_then(Value::as_str) {
            Some("summary") => {
                // The harness rewrites this line as the session evolves, so
                // the last one is the current one.
                if let Some(text) = value.get("summary").and_then(Value::as_str) {
                    let cleaned = clean_text(text, SUMMARY_MAX_CHARS);
                    if !cleaned.is_empty() {
                        acc.summary = Some(cleaned);
                    }
                }
            }
            Some("user") => {
                // Meta lines carry hook output and command echoes with a user
                // role; they are not something the user typed.
                if value.get("isMeta").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                let Some(text) = user_text(&value) else {
                    continue;
                };
                if text.trim_start().starts_with(COMPACTION_PREFIX) {
                    // Newest compaction wins: a long session compacts several
                    // times and only the latest describes where it stands.
                    acc.recap = Some(clean_block(text, RECAP_MAX_CHARS));
                } else if acc.title.is_none() {
                    let cleaned = clean_text(text, TITLE_MAX_CHARS);
                    if !cleaned.is_empty() {
                        acc.title = Some(cleaned);
                    }
                }
            }
            _ => {}
        }
    }
}

/// Text of a user turn. `message.content` is either a plain string or a block
/// list; only `text` blocks are the user speaking — `tool_result` blocks are
/// the harness reporting back and must never become a title.
fn user_text(value: &Value) -> Option<&str> {
    let content = value.get("message")?.get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text);
    }
    content.as_array()?.iter().find_map(|block| {
        if block.get("type").and_then(Value::as_str)? == "text" {
            block.get("text").and_then(Value::as_str)
        } else {
            None
        }
    })
}

/// Collapse to a single line: control characters (including newlines and tabs)
/// become spaces, runs of whitespace collapse, then truncate by characters so
/// a multi-byte name is never cut in half.
pub fn clean_text(text: &str, max_chars: usize) -> String {
    let mut out = String::new();
    let mut chars = 0usize;
    let mut pending_space = false;
    for ch in text.chars() {
        if ch.is_control() || ch.is_whitespace() {
            pending_space = chars > 0;
            continue;
        }
        // The separator is only worth spending budget on if the character it
        // separates also fits, which is what keeps a truncated title from
        // ending in a dangling space.
        let needed = usize::from(pending_space) + 1;
        if chars + needed > max_chars {
            break;
        }
        if pending_space {
            out.push(' ');
            chars += 1;
            pending_space = false;
        }
        out.push(ch);
        chars += 1;
    }
    out
}

/// Like `clean_text` but keeps line structure: a recap is read as a block.
/// Only carriage returns and other control characters are dropped.
fn clean_block(text: &str, max_chars: usize) -> String {
    let cleaned: String = text
        .chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .collect();
    let trimmed = cleaned.trim();
    trimmed.chars().take(max_chars).collect()
}

/// Decode a project directory slug back into a path: `C--Dev-TermX` →
/// `C:\Dev\TermX`, `-home-me-proj` → `/home/me/proj`. `None` for anything
/// that does not look like an encoded absolute path, since a wrong directory
/// is worse than none (resume would open the wrong project).
pub fn decode_slug(slug: &str) -> Option<String> {
    let bytes = slug.as_bytes();
    if bytes.len() > 3 && bytes[0].is_ascii_alphabetic() && &slug[1..3] == "--" {
        let drive = bytes[0].to_ascii_uppercase() as char;
        let rest = slug[3..].replace('-', "\\");
        return Some(format!("{drive}:\\{rest}"));
    }
    if let Some(rest) = slug.strip_prefix('-') {
        if !rest.is_empty() && !rest.starts_with('-') {
            return Some(format!("/{}", rest.replace('-', "/")));
        }
    }
    None
}

/// The first and last `cap` bytes. The tail is empty when the file fits in
/// one excerpt, so small transcripts are never scanned twice.
fn read_head_and_tail(path: &Path, len: u64, cap: u64) -> Option<(String, String)> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path).ok()?;
    let mut head = Vec::new();
    file.by_ref()
        .take(len.min(cap))
        .read_to_end(&mut head)
        .ok()?;

    let mut tail = Vec::new();
    if len > cap {
        file.seek(SeekFrom::Start(len - cap)).ok()?;
        file.by_ref().take(cap).read_to_end(&mut tail).ok()?;
    }
    Some((
        String::from_utf8_lossy(&head).into_owned(),
        String::from_utf8_lossy(&tail).into_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user_line(text: &str) -> String {
        format!(
            "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":{}}}}}",
            serde_json::to_string(text).unwrap()
        )
    }

    fn harvest(head: &str) -> SessionRecord {
        harvest_claude_excerpts("F", "the-id", "C--Dev-Proj", head, "", 1)
    }

    #[test]
    fn the_last_summary_line_wins() {
        let body = [
            "{\"type\":\"summary\",\"summary\":\"first take\",\"leafUuid\":\"a\"}",
            &user_line("hello"),
            "{\"type\":\"summary\",\"summary\":\"current take\",\"leafUuid\":\"b\"}",
        ]
        .join("\n");
        assert_eq!(harvest(&body).summary.as_deref(), Some("current take"));
    }

    #[test]
    fn a_summary_in_the_tail_beats_one_in_the_head() {
        let head = "{\"type\":\"summary\",\"summary\":\"old\"}";
        let tail = "{\"type\":\"summary\",\"summary\":\"new\"}";
        let got = harvest_claude_excerpts("F", "id", "slug", head, tail, 1);
        assert_eq!(got.summary.as_deref(), Some("new"));
    }

    #[test]
    fn recap_is_the_newest_compaction_block_trimmed_to_two_thousand_chars() {
        let old = format!("{COMPACTION_PREFIX} from run one.\n\nSummary:\n1. old");
        let new = format!(
            "{COMPACTION_PREFIX} from run two.\n\nSummary:\n{}",
            "x".repeat(4_000)
        );
        let body = [user_line("start"), user_line(&old), user_line(&new)].join("\n");

        let recap = harvest(&body).recap.expect("compaction block harvested");
        assert!(recap.starts_with(&format!("{COMPACTION_PREFIX} from run two")));
        assert_eq!(recap.chars().count(), RECAP_MAX_CHARS);
        assert!(recap.contains('\n'), "line structure is kept: {recap:.60}");
    }

    #[test]
    fn a_compaction_block_never_becomes_the_title() {
        let body = [
            user_line(&format!("{COMPACTION_PREFIX} from earlier.")),
            user_line("now do the next thing"),
        ]
        .join("\n");
        let got = harvest(&body);
        assert_eq!(got.title, "now do the next thing");
        assert!(got.recap.is_some());
    }

    #[test]
    fn cwd_from_content_beats_the_ambiguous_slug() {
        // The slug would decode to C:\Dev\my-project — wrong, because the real
        // directory name contains the dash.
        let body = "{\"type\":\"user\",\"cwd\":\"C:\\\\Dev\\\\my-project\",\"message\":{\"role\":\"user\",\"content\":\"go\"}}";
        let got = harvest_claude_excerpts("F", "id", "C--Dev-my-project", body, "", 1);
        assert_eq!(got.cwd.as_deref(), Some(r"C:\Dev\my-project"));
    }

    #[test]
    fn the_first_cwd_seen_wins_over_later_ones() {
        let body = [
            "{\"type\":\"user\",\"cwd\":\"C:\\\\First\",\"message\":{\"role\":\"user\",\"content\":\"a\"}}",
            "{\"type\":\"user\",\"cwd\":\"C:\\\\Second\",\"message\":{\"role\":\"user\",\"content\":\"b\"}}",
        ]
        .join("\n");
        assert_eq!(harvest(&body).cwd.as_deref(), Some(r"C:\First"));
    }

    #[test]
    fn slug_decoding_is_the_fallback_when_no_line_records_a_cwd() {
        let got = harvest_claude_excerpts("F", "id", "C--Dev-TermX", &user_line("go"), "", 1);
        assert_eq!(got.cwd.as_deref(), Some(r"C:\Dev\TermX"));
    }

    #[test]
    fn decode_slug_only_accepts_encoded_absolute_paths() {
        assert_eq!(
            decode_slug("C--Dev-TermX").as_deref(),
            Some(r"C:\Dev\TermX")
        );
        assert_eq!(decode_slug("d--work").as_deref(), Some(r"D:\work"));
        assert_eq!(
            decode_slug("-home-me-proj").as_deref(),
            Some("/home/me/proj")
        );
        for junk in ["", "-", "--", "C-", "C--", "no-slug-at-all", "1--x"] {
            assert_eq!(decode_slug(junk), None, "{junk:?} is not a path");
        }
    }

    #[test]
    fn malformed_and_partial_lines_are_skipped() {
        let body = [
            "not json at all",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"truncat", // clipped
            "",
            "{}",
            "[1,2,3]",
            &user_line("the real first message"),
        ]
        .join("\n");
        assert_eq!(harvest(&body).title, "the real first message");
    }

    #[test]
    fn title_takes_the_first_user_text_block_and_strips_control_characters() {
        let body = [
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"content\":\"ran ok\"}]}}",
            "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"hook output\"}}",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"line one\\n\\tline two\"}]}}",
        ]
        .join("\n");
        assert_eq!(harvest(&body).title, "line one line two");
    }

    #[test]
    fn the_summary_line_is_the_title_and_outranks_the_first_message() {
        // Claude Code shows this line as the session's name, so it IS the
        // title — and being a given name, nothing generated may replace it.
        let body = [
            user_line("go and fix the resize bug"),
            "{\"type\":\"summary\",\"summary\":\"Refactor the host registry\"}".to_string(),
        ]
        .join("\n");
        let got = harvest(&body);
        assert_eq!(got.title, "Refactor the host registry");
        assert_eq!(got.title_source, TITLE_SOURCE_NAMED);
        assert_eq!(got.summary.as_deref(), Some("Refactor the host registry"));
    }

    #[test]
    fn without_a_summary_line_the_title_is_derived_from_the_first_message_then_the_id() {
        let from_message = harvest(&user_line("go and fix the resize bug"));
        assert_eq!(from_message.title, "go and fix the resize bug");
        assert_eq!(
            from_message.title_source,
            TITLE_SOURCE_DERIVED
        );

        for empty in ["", "   "] {
            let got = harvest(&user_line(empty));
            assert_eq!(got.title, "the-id", "{empty:?}");
            assert_eq!(got.title_source, TITLE_SOURCE_DERIVED);
        }
        assert_eq!(harvest("").title, "the-id");
    }

    #[test]
    fn long_titles_are_capped_at_one_hundred_and_twenty_characters() {
        let one_word = harvest(&user_line(&"x".repeat(400)));
        assert_eq!(one_word.title.chars().count(), TITLE_MAX_CHARS);

        // Truncating between words must not leave the row ending in a space.
        let many_words = harvest(&user_line(&"ab ".repeat(200)));
        let count = many_words.title.chars().count();
        assert!(
            count <= TITLE_MAX_CHARS && count > TITLE_MAX_CHARS - 3,
            "{count}"
        );
        assert!(
            !many_words.title.ends_with(' '),
            "no trailing gap: {:?}",
            many_words.title
        );
    }

    #[test]
    fn harvesting_a_real_file_reads_only_the_bounded_head_and_tail() {
        let dir = tempfile::Builder::new()
            .prefix("termx-claude-")
            .tempdir()
            .unwrap();
        let project = dir.path().join("C--Dev-Big");
        std::fs::create_dir_all(&project).unwrap();
        let path = project.join("11112222-3333.jsonl");

        // head | 600 KB of filler holding a poison line | tail
        let mut body = String::new();
        // The head's evidence is the cwd it records: content beats the slug.
        body.push_str(
            "{\"type\":\"user\",\"cwd\":\"C:\\\\Dev\\\\Big-Real\",\"message\":{\"role\":\"user\",\"content\":\"the opening request\"}}",
        );
        body.push('\n');
        while body.len() < 400 * 1024 {
            body.push_str("{\"type\":\"other\",\"pad\":\"");
            body.push_str(&"p".repeat(900));
            body.push_str("\"}\n");
        }
        body.push_str("{\"type\":\"summary\",\"summary\":\"MIDDLE POISON\"}\n");
        while body.len() < 900 * 1024 {
            body.push_str("{\"type\":\"other\",\"pad\":\"");
            body.push_str(&"p".repeat(900));
            body.push_str("\"}\n");
        }
        body.push_str("{\"type\":\"summary\",\"summary\":\"the tail summary\"}\n");
        std::fs::write(&path, &body).unwrap();
        assert!(
            body.len() as u64 > 2 * EXCERPT_BYTES,
            "fixture must exceed both excerpts"
        );

        let got = harvest_claude_file(&path).expect("harvested");
        assert_eq!(got.id, "11112222-3333");
        assert_eq!(
            got.cwd.as_deref(),
            Some(r"C:\Dev\Big-Real"),
            "head was read (its cwd outranks the slug, which decodes to C:\\Dev\\Big)"
        );
        assert_eq!(
            got.summary.as_deref(),
            Some("the tail summary"),
            "tail was read, and the middle stayed unread"
        );
        assert_eq!(
            got.title, "the tail summary",
            "the summary line is the session's own name"
        );
        assert_eq!(got.title_source, TITLE_SOURCE_NAMED);
        assert!(got.updated_at_ms > 0, "mtime stamped");
        assert_eq!(got.file_path, path.to_string_lossy());
    }

    #[test]
    fn a_missing_file_harvests_to_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(harvest_claude_file(&dir.path().join("gone.jsonl")).is_none());
    }
}
