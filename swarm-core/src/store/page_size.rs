//! Exact serialization work is linear in the entries, including JSON escaping.

use crate::error::ValidationError;
use serde::Serialize;

/// Sizes a page whose serialized form is an envelope containing exactly one
/// JSON array of entries. `new` receives the envelope with an empty array.
pub(super) struct PageSize {
    bytes: usize,
    entries: usize,
}
impl PageSize {
    pub(super) fn new(empty_envelope: &impl Serialize) -> Result<Self, ValidationError> {
        Ok(Self {
            bytes: serialized_size(empty_envelope)?,
            entries: 0,
        })
    }
    pub(super) fn with_entry(&self, entry: &impl Serialize) -> Result<usize, ValidationError> {
        Ok(self.bytes + serialized_size(entry)? + usize::from(self.entries > 0))
    }
    pub(super) fn accept(&mut self, bytes: usize) {
        self.bytes = bytes;
        self.entries += 1;
    }
}
fn serialized_size(value: &impl Serialize) -> Result<usize, ValidationError> {
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, value)
        .map_err(|error| ValidationError::CanonicalSerialization(error.to_string()))?;
    Ok(counter.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        GroupId, MailboxCursor, MailboxPage, NavigationPosition, NavigationScope, PeerId, Revision,
    };
    use serde::Serialize;
    use std::cell::Cell;

    fn position(after_sequence: u64) -> NavigationPosition {
        NavigationPosition::new(
            GroupId::generate(),
            PeerId::generate(),
            Revision::new(1).unwrap(),
            Revision::new(1).unwrap(),
            NavigationScope::Mailbox,
            after_sequence,
        )
    }

    #[test]
    fn complete_envelope_and_commas_match_real_json() {
        for high in [0, 9, 10, u64::MAX] {
            let page = MailboxPage {
                messages: vec![],
                next_cursor: Some(MailboxCursor::generate()),
                resume_position: position(high),
                snapshot_high_sequence: high,
            };
            let envelope = serde_json::to_vec(&page).unwrap().len();
            let mut size = PageSize::new(&page).unwrap();
            assert_eq!(size.bytes, envelope);
            let mut entries = Vec::new();
            for index in 0..128 {
                let body = ["ascii", "\0\n\t\"\\", "\u{1f980}"][index % 3].repeat(index + 1);
                entries.push(serde_json::json!({"body": body, "optional": if index%2==0 {Some("value")}else{None}}));
                let candidate = size.with_entry(entries.last().unwrap()).unwrap();
                // Replace [] with the actual serialized array; this is independent
                // of the sizer's separator arithmetic.
                assert_eq!(
                    candidate,
                    envelope - 2 + serde_json::to_vec(&entries).unwrap().len()
                );
                size.accept(candidate);
            }
        }
    }
    #[test]
    fn sizing_visits_each_entry_once_and_rejected_entry_does_not_advance() {
        struct Tracked<'a>(&'a Cell<usize>);
        impl Serialize for Tracked<'_> {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                self.0.set(self.0.get() + 1);
                serializer.serialize_str("\0\u{1f980}")
            }
        }
        let calls = Cell::new(0);
        let page = MailboxPage {
            messages: vec![],
            next_cursor: Some(MailboxCursor::generate()),
            resume_position: position(123),
            snapshot_high_sequence: 123,
        };
        let mut size = PageSize::new(&page).unwrap();
        for _ in 0..128 {
            let candidate = size.with_entry(&Tracked(&calls)).unwrap();
            size.accept(candidate);
        }
        assert_eq!(calls.get(), 128);
        let before = size.bytes;
        let candidate = size.with_entry(&Tracked(&calls)).unwrap();
        assert!(candidate > before);
        assert_eq!(size.bytes, before);
    }
}
