use std::cell::Cell;
use std::collections::HashSet;
use std::fmt;
use std::rc::Rc;

use serde::de::{self, DeserializeSeed, Error as _, MapAccess, SeqAccess, Visitor};
use serde::{Serialize, Serializer};
use serde_json::Number;
use sha2::{Digest, Sha256};

pub const MAX_RECORD_BYTES: usize = 1024 * 1024;
pub const MAX_JSON_DEPTH: usize = 64;
pub const MAX_VALUE_NODES: usize = 65_536;
pub const MAX_OBJECT_MEMBERS: usize = 16_384;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ByteOffset(u64);

impl ByteOffset {
    pub(crate) fn new(value: u64) -> Self {
        Self(value)
    }

    pub fn get(self) -> u64 {
        self.0
    }
}

impl Serialize for ByteOffset {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ByteRange {
    start: ByteOffset,
    end: ByteOffset,
    sha256: String,
}

impl ByteRange {
    fn new(start: u64, end: u64, sha256: String) -> Self {
        Self {
            start: ByteOffset::new(start),
            end: ByteOffset::new(end),
            sha256,
        }
    }

    pub fn start(&self) -> ByteOffset {
        self.start
    }

    pub fn end(&self) -> ByteOffset {
        self.end
    }

    pub fn sha256(&self) -> &str {
        &self.sha256
    }

    pub(crate) fn new_for_owner() -> Self {
        Self::new(0, 0, String::new())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnavailableReason {
    InvalidUtf8,
    MalformedJson,
    RecordTooLarge,
    NestingTooDeep,
    ResourceLimit,
    MissingConversationIdentity,
    ConflictingConversationIdentity,
    MissingNativeId,
    SidechainAttributionUnavailable,
    UnsupportedProviderShape,
    TooManyProjectedBlocks,
    InvalidNativeId,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompleteRecord {
    range: ByteRange,
    pub(crate) value: JsonValue,
}

impl CompleteRecord {
    pub fn range(&self) -> &ByteRange {
        &self.range
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ScanItem {
    Complete(CompleteRecord),
    Unavailable {
        range: ByteRange,
        reason: UnavailableReason,
    },
}

impl ScanItem {
    pub fn range(&self) -> &ByteRange {
        match self {
            Self::Complete(record) => &record.range,
            Self::Unavailable { range, .. } => range,
        }
    }

    pub fn unavailable_reason(&self) -> Option<UnavailableReason> {
        match self {
            Self::Complete(_) => None,
            Self::Unavailable { reason, .. } => Some(*reason),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanLag {
    captured_through: ByteOffset,
    observed_length: ByteOffset,
    pending_bytes: u64,
    retained_bytes: usize,
    retained_capacity: usize,
    sha256: String,
    oversized: bool,
}

impl ScanLag {
    pub fn captured_through(&self) -> ByteOffset {
        self.captured_through
    }

    pub fn observed_length(&self) -> ByteOffset {
        self.observed_length
    }

    pub fn pending_bytes(&self) -> u64 {
        self.pending_bytes
    }

    pub fn retained_bytes(&self) -> usize {
        self.retained_bytes
    }

    pub fn retained_capacity(&self) -> usize {
        self.retained_capacity
    }

    pub fn sha256(&self) -> &str {
        &self.sha256
    }

    pub fn oversized(&self) -> bool {
        self.oversized
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanError {
    OffsetOverflow,
}

impl fmt::Display for ScanError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OffsetOverflow => formatter.write_str("JSONL byte offset overflow"),
        }
    }
}

impl std::error::Error for ScanError {}

#[derive(Debug)]
pub struct JsonlScanner {
    record_start: u64,
    next_offset: u64,
    pending_len: u64,
    retained: Vec<u8>,
    hasher: Sha256,
}

impl JsonlScanner {
    pub fn new(base_offset: u64) -> Self {
        Self {
            record_start: base_offset,
            next_offset: base_offset,
            pending_len: 0,
            retained: Vec::with_capacity(MAX_RECORD_BYTES),
            hasher: Sha256::new(),
        }
    }

    pub fn push_chunk(
        &mut self,
        chunk: &[u8],
        mut emit: impl FnMut(ScanItem),
    ) -> Result<(), ScanError> {
        let chunk_len = u64::try_from(chunk.len()).map_err(|_| ScanError::OffsetOverflow)?;
        self.next_offset
            .checked_add(chunk_len)
            .ok_or(ScanError::OffsetOverflow)?;

        let mut consumed = 0usize;
        while consumed < chunk.len() {
            let remaining = &chunk[consumed..];
            let take = remaining
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(remaining.len(), |index| index + 1);
            let piece = &remaining[..take];
            self.absorb(piece)?;
            consumed += take;
            if piece.ends_with(b"\n") {
                emit(self.finish_record());
            }
        }
        Ok(())
    }

    pub fn lag(&self) -> Option<ScanLag> {
        if self.pending_len == 0 {
            return None;
        }
        Some(ScanLag {
            captured_through: ByteOffset::new(self.record_start),
            observed_length: ByteOffset::new(self.next_offset),
            pending_bytes: self.pending_len,
            retained_bytes: self.retained.len(),
            retained_capacity: self.retained.capacity(),
            sha256: format!("{:x}", self.hasher.clone().finalize()),
            oversized: self.pending_len >= MAX_RECORD_BYTES as u64,
        })
    }

    fn absorb(&mut self, bytes: &[u8]) -> Result<(), ScanError> {
        let byte_len = u64::try_from(bytes.len()).map_err(|_| ScanError::OffsetOverflow)?;
        self.pending_len = self
            .pending_len
            .checked_add(byte_len)
            .ok_or(ScanError::OffsetOverflow)?;
        self.next_offset = self
            .next_offset
            .checked_add(byte_len)
            .ok_or(ScanError::OffsetOverflow)?;
        self.hasher.update(bytes);

        let room = MAX_RECORD_BYTES.saturating_sub(self.retained.len());
        self.retained
            .extend_from_slice(&bytes[..room.min(bytes.len())]);
        Ok(())
    }

    fn finish_record(&mut self) -> ScanItem {
        let hasher = std::mem::replace(&mut self.hasher, Sha256::new());
        let range = ByteRange::new(
            self.record_start,
            self.next_offset,
            format!("{0:x}", hasher.finalize()),
        );
        let record_len = self.pending_len;
        self.pending_len = 0;
        self.record_start = self.next_offset;

        if record_len > MAX_RECORD_BYTES as u64 {
            self.retained.clear();
            return ScanItem::Unavailable {
                range,
                reason: UnavailableReason::RecordTooLarge,
            };
        }

        let parsed = match std::str::from_utf8(&self.retained) {
            Ok(_) => match parse_bounded_json(&self.retained) {
                Ok(value) => Ok(value),
                Err(reason) => Err(reason),
            },
            Err(_) => Err(UnavailableReason::InvalidUtf8),
        };
        self.retained.clear();
        match parsed {
            Ok(value) => ScanItem::Complete(CompleteRecord { range, value }),
            Err(reason) => ScanItem::Unavailable { range, reason },
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum JsonValue {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
    Array(Vec<JsonValue>),
    Object(Vec<(String, JsonValue)>),
}

impl JsonValue {
    pub(crate) fn get(&self, name: &str) -> Option<&Self> {
        match self {
            Self::Object(members) => members
                .iter()
                .rev()
                .find_map(|(key, value)| (key == name).then_some(value)),
            _ => None,
        }
    }

    pub(crate) fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }

    pub(crate) fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(value) => Some(*value),
            _ => None,
        }
    }

    pub(crate) fn as_array(&self) -> Option<&[Self]> {
        match self {
            Self::Array(value) => Some(value),
            _ => None,
        }
    }

    pub(crate) fn to_compact_json(&self) -> String {
        fn write(value: &JsonValue, output: &mut String) {
            match value {
                JsonValue::Null => output.push_str("null"),
                JsonValue::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
                JsonValue::Number(value) => output.push_str(&value.to_string()),
                JsonValue::String(value) => output.push_str(
                    &serde_json::to_string(value).expect("string serialization cannot fail"),
                ),
                JsonValue::Array(values) => {
                    output.push('[');
                    for (index, value) in values.iter().enumerate() {
                        if index != 0 {
                            output.push(',');
                        }
                        write(value, output);
                    }
                    output.push(']');
                }
                JsonValue::Object(values) => {
                    output.push('{');
                    for (index, (name, value)) in values.iter().enumerate() {
                        if index != 0 {
                            output.push(',');
                        }
                        output.push_str(
                            &serde_json::to_string(name)
                                .expect("object member serialization cannot fail"),
                        );
                        output.push(':');
                        write(value, output);
                    }
                    output.push('}');
                }
            }
        }

        let mut output = String::new();
        write(self, &mut output);
        output
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParseFailure {
    Depth,
    Resource,
    Duplicate,
}

struct Budget {
    nodes: Cell<usize>,
    members: Cell<usize>,
    failure: Cell<Option<ParseFailure>>,
}

impl Budget {
    fn new() -> Self {
        Self {
            nodes: Cell::new(0),
            members: Cell::new(0),
            failure: Cell::new(None),
        }
    }

    fn count_node<E: de::Error>(&self) -> Result<(), E> {
        let next = self.nodes.get().checked_add(1).ok_or_else(|| {
            self.failure.set(Some(ParseFailure::Resource));
            E::custom("value node counter overflow")
        })?;
        if next > MAX_VALUE_NODES {
            self.failure.set(Some(ParseFailure::Resource));
            return Err(E::custom("value node limit exceeded"));
        }
        self.nodes.set(next);
        Ok(())
    }

    fn count_member<E: de::Error>(&self) -> Result<(), E> {
        let next = self.members.get().checked_add(1).ok_or_else(|| {
            self.failure.set(Some(ParseFailure::Resource));
            E::custom("object member counter overflow")
        })?;
        if next > MAX_OBJECT_MEMBERS {
            self.failure.set(Some(ParseFailure::Resource));
            return Err(E::custom("object member limit exceeded"));
        }
        self.members.set(next);
        Ok(())
    }

    fn check_depth<E: de::Error>(&self, depth: usize) -> Result<(), E> {
        if depth > MAX_JSON_DEPTH {
            self.failure.set(Some(ParseFailure::Depth));
            return Err(E::custom("JSON nesting limit exceeded"));
        }
        Ok(())
    }

    fn duplicate<E: de::Error>(&self) -> E {
        self.failure.set(Some(ParseFailure::Duplicate));
        E::custom("duplicate decoded object member")
    }
}

struct ValueSeed {
    budget: Rc<Budget>,
    parent_container_depth: usize,
}

impl<'de> DeserializeSeed<'de> for ValueSeed {
    type Value = JsonValue;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        self.budget.count_node()?;
        deserializer.deserialize_any(ValueVisitor {
            budget: self.budget,
            parent_container_depth: self.parent_container_depth,
        })
    }
}

struct ValueVisitor {
    budget: Rc<Budget>,
    parent_container_depth: usize,
}

impl<'de> Visitor<'de> for ValueVisitor {
    type Value = JsonValue;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a bounded JSON value")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(JsonValue::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(JsonValue::Number(value.into()))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(JsonValue::Number(value.into()))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Number::from_f64(value)
            .map(JsonValue::Number)
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(JsonValue::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(JsonValue::String(value))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(JsonValue::Null)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(JsonValue::Null)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let depth = self.parent_container_depth.checked_add(1).ok_or_else(|| {
            self.budget.failure.set(Some(ParseFailure::Depth));
            A::Error::custom("JSON nesting counter overflow")
        })?;
        self.budget.check_depth(depth)?;
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element_seed(ValueSeed {
            budget: Rc::clone(&self.budget),
            parent_container_depth: depth,
        })? {
            values.push(value);
        }
        Ok(JsonValue::Array(values))
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let depth = self.parent_container_depth.checked_add(1).ok_or_else(|| {
            self.budget.failure.set(Some(ParseFailure::Depth));
            A::Error::custom("JSON nesting counter overflow")
        })?;
        self.budget.check_depth(depth)?;
        let mut values = Vec::new();
        let mut names = HashSet::new();
        while let Some(name) = map.next_key::<String>()? {
            self.budget.count_member()?;
            if !names.insert(name.clone()) {
                return Err(self.budget.duplicate());
            }
            let value = map.next_value_seed(ValueSeed {
                budget: Rc::clone(&self.budget),
                parent_container_depth: depth,
            })?;
            values.push((name, value));
        }
        Ok(JsonValue::Object(values))
    }
}

fn parse_bounded_json(bytes: &[u8]) -> Result<JsonValue, UnavailableReason> {
    let budget = Rc::new(Budget::new());
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let parsed = ValueSeed {
        budget: Rc::clone(&budget),
        parent_container_depth: 0,
    }
    .deserialize(&mut deserializer)
    .and_then(|value| {
        deserializer.end()?;
        Ok(value)
    });

    let value = match parsed {
        Ok(value) => value,
        Err(_) => {
            return Err(match budget.failure.get() {
                Some(ParseFailure::Depth) => UnavailableReason::NestingTooDeep,
                Some(ParseFailure::Resource) => UnavailableReason::ResourceLimit,
                Some(ParseFailure::Duplicate) | None => UnavailableReason::MalformedJson,
            });
        }
    };
    if !matches!(value, JsonValue::Object(_)) {
        return Err(UnavailableReason::MalformedJson);
    }
    Ok(value)
}
