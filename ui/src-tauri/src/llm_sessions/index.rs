//! The persisted scan cache behind `sessions_index_v1.json`.
//!
//! It exists so a cold open does not re-read a thousand transcripts: an entry
//! is trusted while the source file's mtime and size both match. The file is
//! a cache, never a source of truth, so parsing is tolerant in both
//! directions — garbage, a future version or a half-written record all read
//! as "nothing cached", which costs a slower scan and nothing else.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::SessionRecord;

/// Bumped only when the entry shape changes incompatibly; an unknown version
/// is discarded rather than migrated.
pub const INDEX_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub mtime_ms: u64,
    pub size: u64,
    pub record: SessionRecord,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndex {
    pub version: u32,
    /// Keyed by source file path, or `codex:<id>` for a Codex session whose
    /// rollout file could not be located. Ordered so the file on disk has a
    /// stable diff instead of churning on every scan.
    pub entries: BTreeMap<String, IndexEntry>,
}

impl SessionIndex {
    pub fn empty() -> Self {
        Self {
            version: INDEX_VERSION,
            entries: BTreeMap::new(),
        }
    }

    /// The cached entry for `key` when the source is byte-for-byte the same
    /// size and age as when it was harvested.
    pub fn unchanged(&self, key: &str, mtime_ms: u64, size: u64) -> Option<&IndexEntry> {
        self.entries
            .get(key)
            .filter(|entry| entry.mtime_ms == mtime_ms && entry.size == size)
    }

    pub fn put(&mut self, key: &str, mtime_ms: u64, size: u64, record: SessionRecord) {
        self.entries.insert(
            key.to_string(),
            IndexEntry {
                mtime_ms,
                size,
                record,
            },
        );
    }

    pub fn serialize(&self) -> String {
        serde_json::to_string(self)
            .unwrap_or_else(|_| String::from("{\"version\":1,\"entries\":{}}"))
    }
}

/// Parse a stored index. Anything unusable — missing file, junk, wrong
/// version, entries that no longer deserialize — yields an empty index.
/// Individual bad entries are dropped without taking the good ones with them.
pub fn parse_index(text: Option<&str>) -> SessionIndex {
    let Some(text) = text else {
        return SessionIndex::empty();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return SessionIndex::empty();
    };
    if value.get("version").and_then(serde_json::Value::as_u64) != Some(u64::from(INDEX_VERSION)) {
        return SessionIndex::empty();
    }
    let mut index = SessionIndex::empty();
    let Some(entries) = value.get("entries").and_then(serde_json::Value::as_object) else {
        return index;
    };
    for (key, entry) in entries {
        if let Ok(entry) = serde_json::from_value::<IndexEntry>(entry.clone()) {
            index.entries.insert(key.clone(), entry);
        }
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(title: &str) -> SessionRecord {
        SessionRecord {
            provider: "claude".to_string(),
            id: "abc".to_string(),
            title: title.to_string(),
            title_source: crate::llm_sessions::TITLE_SOURCE_NAMED.to_string(),
            cwd: Some(r"C:\Dev".to_string()),
            file_path: r"C:\s\abc.jsonl".to_string(),
            updated_at_ms: 1_700_000_000_000,
            summary: Some("did things".to_string()),
            recap: None,
        }
    }

    #[test]
    fn round_trips_through_camel_case_json() {
        let mut index = SessionIndex::empty();
        index.put(r"C:\s\abc.jsonl", 111, 222, record("a session"));
        let text = index.serialize();
        assert!(text.contains("\"mtimeMs\":111"), "{text}");
        assert!(text.contains("\"filePath\""), "{text}");

        let back = parse_index(Some(&text));
        assert_eq!(back.entries, index.entries);
        assert_eq!(back.version, INDEX_VERSION);
    }

    #[test]
    fn unusable_files_parse_as_empty_rather_than_failing() {
        for junk in [
            None,
            Some(""),
            Some("not json"),
            Some("[]"),
            Some("{}"),
            Some("{\"version\":2,\"entries\":{\"k\":{}}}"),
            Some("{\"version\":\"1\",\"entries\":{}}"),
            Some("{\"version\":1}"),
        ] {
            let got = parse_index(junk);
            assert!(got.entries.is_empty(), "{junk:?} should yield nothing");
            assert_eq!(got.version, INDEX_VERSION);
        }
    }

    #[test]
    fn a_broken_entry_does_not_discard_the_good_ones() {
        let mut index = SessionIndex::empty();
        index.put("good", 1, 2, record("keep me"));
        let mut value: serde_json::Value = serde_json::from_str(&index.serialize()).unwrap();
        value["entries"]["broken"] = serde_json::json!({ "mtimeMs": 1 });
        value["entries"]["alsoBroken"] = serde_json::json!("string, not an entry");

        let got = parse_index(Some(&value.to_string()));
        assert_eq!(got.entries.len(), 1);
        assert_eq!(got.entries["good"].record.title, "keep me");
    }

    #[test]
    fn an_entry_is_only_reused_when_size_and_mtime_both_match() {
        let mut index = SessionIndex::empty();
        index.put("k", 100, 200, record("cached"));
        assert!(index.unchanged("k", 100, 200).is_some());
        assert!(index.unchanged("k", 101, 200).is_none(), "newer mtime");
        assert!(index.unchanged("k", 100, 201).is_none(), "different size");
        assert!(index.unchanged("other", 100, 200).is_none());
    }
}
