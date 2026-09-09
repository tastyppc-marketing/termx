use std::{fmt, mem::size_of};

pub const MAX_JSON_INPUT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_JSON_DEPTH: usize = 64;
pub const MAX_JSON_KEYS_PER_OBJECT: usize = 64;
pub const MAX_JSON_LIVE_KEYS: usize = 256;
pub const MAX_JSON_KEY_BYTES: usize = 128;
pub const MAX_JSON_NODES: usize = 1_048_576;

/// Conservative fixed and transient scanner storage. The scanner is iterative,
/// so this includes its one key array, container-frame array, one temporary
/// decoded key, and 512 bytes for ordinary call locals. It allocates no heap.
pub const JSON_VALIDATOR_SCRATCH_BYTES: usize =
    size_of::<Scanner<'static>>() + size_of::<KeySlot>() + 512;

const _: () = assert!(JSON_VALIDATOR_SCRATCH_BYTES <= 64 * 1024);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsonErrorKind {
    InputTooLarge,
    InvalidUtf8,
    UnexpectedEnd,
    InvalidSyntax,
    InvalidEscape,
    InvalidSurrogate,
    TrailingInput,
    DepthLimit,
    ObjectKeyLimit,
    LiveKeyLimit,
    KeyTooLong,
    DuplicateKey,
    NodeLimit,
}

/// Closed JSON failure. Neither Debug nor Display includes source bytes.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct JsonError {
    kind: JsonErrorKind,
    offset: usize,
}

impl JsonError {
    pub fn kind(self) -> JsonErrorKind {
        self.kind
    }

    pub fn offset(self) -> usize {
        self.offset
    }
}

impl fmt::Debug for JsonError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("JsonError")
            .field("kind", &self.kind)
            .field("offset", &self.offset)
            .finish()
    }
}

impl fmt::Display for JsonError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let description = match self.kind {
            JsonErrorKind::InputTooLarge => "JSON input exceeds 16 MiB",
            JsonErrorKind::InvalidUtf8 => "JSON input is not UTF-8",
            JsonErrorKind::UnexpectedEnd => "JSON input ended unexpectedly",
            JsonErrorKind::InvalidSyntax => "JSON syntax is invalid",
            JsonErrorKind::InvalidEscape => "JSON string escape is invalid",
            JsonErrorKind::InvalidSurrogate => "JSON Unicode surrogate pair is invalid",
            JsonErrorKind::TrailingInput => "JSON has trailing input",
            JsonErrorKind::DepthLimit => "JSON nesting exceeds 64 containers",
            JsonErrorKind::ObjectKeyLimit => "JSON object exceeds 64 keys",
            JsonErrorKind::LiveKeyLimit => "JSON exceeds 256 live ancestor keys",
            JsonErrorKind::KeyTooLong => "decoded JSON object key exceeds 128 bytes",
            JsonErrorKind::DuplicateKey => "JSON object contains a duplicate decoded key",
            JsonErrorKind::NodeLimit => "JSON exceeds the node-work limit",
        };
        write!(formatter, "{description} at byte {}", self.offset)
    }
}

impl std::error::Error for JsonError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JsonValidationStats {
    work_nodes: usize,
    max_depth: usize,
    max_live_keys: usize,
}

impl JsonValidationStats {
    pub fn work_nodes(self) -> usize {
        self.work_nodes
    }

    pub fn max_depth(self) -> usize {
        self.max_depth
    }

    pub fn max_live_keys(self) -> usize {
        self.max_live_keys
    }

    pub const fn heap_scratch_bytes(self) -> usize {
        0
    }

    pub const fn scratch_capacity_bytes(self) -> usize {
        JSON_VALIDATOR_SCRATCH_BYTES
    }
}

/// Syntax-validated borrowed JSON. This proves only bounded lexical validity;
/// it grants no protocol or application authority.
#[derive(Clone, Copy)]
pub struct ValidatedJson<'a> {
    raw: &'a str,
    stats: JsonValidationStats,
}

impl fmt::Debug for ValidatedJson<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ValidatedJson")
            .field("bytes", &self.raw.len())
            .field("stats", &self.stats)
            .finish()
    }
}

impl<'a> ValidatedJson<'a> {
    pub fn as_str(self) -> &'a str {
        self.raw
    }

    pub fn stats(self) -> JsonValidationStats {
        self.stats
    }
}

pub fn validate_json(input: &[u8]) -> Result<ValidatedJson<'_>, JsonError> {
    if input.len() > MAX_JSON_INPUT_BYTES {
        return Err(JsonError::new(
            JsonErrorKind::InputTooLarge,
            MAX_JSON_INPUT_BYTES,
        ));
    }
    let raw = std::str::from_utf8(input)
        .map_err(|error| JsonError::new(JsonErrorKind::InvalidUtf8, error.valid_up_to()))?;
    let mut scanner = Scanner::new(input, 0);
    scanner.skip_whitespace();
    scanner.scan_one_value()?;
    scanner.skip_whitespace();
    if scanner.position != input.len() {
        return Err(scanner.error(JsonErrorKind::TrailingInput));
    }
    Ok(ValidatedJson {
        raw,
        stats: scanner.stats(),
    })
}

pub(crate) fn scan_value_end(input: &[u8], start: usize) -> Result<usize, JsonError> {
    let mut scanner = Scanner::new(input, start);
    scanner.scan_one_value()?;
    Ok(scanner.position)
}

#[derive(Clone, Copy)]
struct KeySlot {
    len: u16,
    bytes: [u8; MAX_JSON_KEY_BYTES],
}

impl KeySlot {
    const EMPTY: Self = Self {
        len: 0,
        bytes: [0; MAX_JSON_KEY_BYTES],
    };

    fn push(&mut self, byte: u8, offset: usize) -> Result<(), JsonError> {
        let len = usize::from(self.len);
        if len == MAX_JSON_KEY_BYTES {
            return Err(JsonError::new(JsonErrorKind::KeyTooLong, offset));
        }
        self.bytes[len] = byte;
        self.len += 1;
        Ok(())
    }

    fn extend(&mut self, bytes: &[u8], offset: usize) -> Result<(), JsonError> {
        for &byte in bytes {
            self.push(byte, offset)?;
        }
        Ok(())
    }

    fn as_slice(&self) -> &[u8] {
        &self.bytes[..usize::from(self.len)]
    }
}

#[derive(Clone, Copy)]
enum FrameState {
    ArrayFirst,
    ArrayNext,
    ArrayAfterValue,
    ObjectFirst,
    ObjectNext,
    ObjectAfterValue,
}

#[derive(Clone, Copy)]
struct Frame {
    state: FrameState,
    key_base: u16,
    key_count: u8,
}

impl Frame {
    const EMPTY: Self = Self {
        state: FrameState::ArrayFirst,
        key_base: 0,
        key_count: 0,
    };
}

struct Scanner<'a> {
    input: &'a [u8],
    position: usize,
    frames: [Frame; MAX_JSON_DEPTH],
    frame_len: usize,
    keys: [KeySlot; MAX_JSON_LIVE_KEYS],
    key_len: usize,
    work_nodes: usize,
    max_depth: usize,
    max_live_keys: usize,
}

impl<'a> Scanner<'a> {
    fn new(input: &'a [u8], position: usize) -> Self {
        Self {
            input,
            position,
            frames: [Frame::EMPTY; MAX_JSON_DEPTH],
            frame_len: 0,
            keys: [KeySlot::EMPTY; MAX_JSON_LIVE_KEYS],
            key_len: 0,
            work_nodes: 0,
            max_depth: 0,
            max_live_keys: 0,
        }
    }

    fn stats(&self) -> JsonValidationStats {
        JsonValidationStats {
            work_nodes: self.work_nodes,
            max_depth: self.max_depth,
            max_live_keys: self.max_live_keys,
        }
    }

    fn error(&self, kind: JsonErrorKind) -> JsonError {
        JsonError::new(kind, self.position.min(self.input.len()))
    }

    fn bump_node(&mut self) -> Result<(), JsonError> {
        if self.work_nodes == MAX_JSON_NODES {
            return Err(self.error(JsonErrorKind::NodeLimit));
        }
        self.work_nodes += 1;
        Ok(())
    }

    fn skip_whitespace(&mut self) {
        while self
            .input
            .get(self.position)
            .is_some_and(|byte| matches!(byte, b' ' | b'\t' | b'\n' | b'\r'))
        {
            self.position += 1;
        }
    }

    fn scan_one_value(&mut self) -> Result<(), JsonError> {
        self.begin_value()?;
        while self.frame_len != 0 {
            let index = self.frame_len - 1;
            match self.frames[index].state {
                FrameState::ArrayFirst => {
                    self.skip_whitespace();
                    if self.consume(b']') {
                        self.pop_frame();
                    } else {
                        self.frames[index].state = FrameState::ArrayAfterValue;
                        self.begin_value()?;
                    }
                }
                FrameState::ArrayNext => {
                    self.skip_whitespace();
                    if self.peek() == Some(b']') {
                        return Err(self.error(JsonErrorKind::InvalidSyntax));
                    }
                    self.frames[index].state = FrameState::ArrayAfterValue;
                    self.begin_value()?;
                }
                FrameState::ArrayAfterValue => {
                    self.skip_whitespace();
                    if self.consume(b',') {
                        self.frames[index].state = FrameState::ArrayNext;
                    } else if self.consume(b']') {
                        self.pop_frame();
                    } else {
                        return Err(self.expected_delimiter());
                    }
                }
                FrameState::ObjectFirst => {
                    self.skip_whitespace();
                    if self.consume(b'}') {
                        self.pop_frame();
                    } else {
                        self.scan_object_member(index)?;
                    }
                }
                FrameState::ObjectNext => {
                    self.skip_whitespace();
                    if self.peek() == Some(b'}') {
                        return Err(self.error(JsonErrorKind::InvalidSyntax));
                    }
                    self.scan_object_member(index)?;
                }
                FrameState::ObjectAfterValue => {
                    self.skip_whitespace();
                    if self.consume(b',') {
                        self.frames[index].state = FrameState::ObjectNext;
                    } else if self.consume(b'}') {
                        self.pop_frame();
                    } else {
                        return Err(self.expected_delimiter());
                    }
                }
            }
        }
        Ok(())
    }

    fn begin_value(&mut self) -> Result<(), JsonError> {
        self.skip_whitespace();
        self.bump_node()?;
        match self
            .peek()
            .ok_or_else(|| self.error(JsonErrorKind::UnexpectedEnd))?
        {
            b'{' => {
                self.position += 1;
                self.push_frame(FrameState::ObjectFirst, self.key_len)?;
            }
            b'[' => {
                self.position += 1;
                self.push_frame(FrameState::ArrayFirst, self.key_len)?;
            }
            b'"' => self.scan_string(None)?,
            b't' => self.scan_literal(b"true")?,
            b'f' => self.scan_literal(b"false")?,
            b'n' => self.scan_literal(b"null")?,
            b'-' | b'0'..=b'9' => self.scan_number()?,
            _ => return Err(self.error(JsonErrorKind::InvalidSyntax)),
        }
        Ok(())
    }

    fn push_frame(&mut self, state: FrameState, key_base: usize) -> Result<(), JsonError> {
        if self.frame_len == MAX_JSON_DEPTH {
            return Err(self.error(JsonErrorKind::DepthLimit));
        }
        self.frames[self.frame_len] = Frame {
            state,
            key_base: u16::try_from(key_base).expect("live-key bound fits u16"),
            key_count: 0,
        };
        self.frame_len += 1;
        self.max_depth = self.max_depth.max(self.frame_len);
        Ok(())
    }

    fn pop_frame(&mut self) {
        self.frame_len -= 1;
        let frame = self.frames[self.frame_len];
        if matches!(
            frame.state,
            FrameState::ObjectFirst | FrameState::ObjectNext | FrameState::ObjectAfterValue
        ) {
            self.key_len = usize::from(frame.key_base);
        }
    }

    fn scan_object_member(&mut self, frame_index: usize) -> Result<(), JsonError> {
        let frame = self.frames[frame_index];
        if usize::from(frame.key_count) == MAX_JSON_KEYS_PER_OBJECT {
            return Err(self.error(JsonErrorKind::ObjectKeyLimit));
        }
        if self.key_len == MAX_JSON_LIVE_KEYS {
            return Err(self.error(JsonErrorKind::LiveKeyLimit));
        }
        if self.peek() != Some(b'"') {
            return Err(self.error(JsonErrorKind::InvalidSyntax));
        }
        self.bump_node()?;
        let mut decoded = KeySlot::EMPTY;
        self.scan_string(Some(&mut decoded))?;
        let base = usize::from(frame.key_base);
        if self.keys[base..self.key_len]
            .iter()
            .any(|existing| existing.as_slice() == decoded.as_slice())
        {
            return Err(self.error(JsonErrorKind::DuplicateKey));
        }
        self.keys[self.key_len] = decoded;
        self.key_len += 1;
        self.max_live_keys = self.max_live_keys.max(self.key_len);
        self.frames[frame_index].key_count += 1;
        self.skip_whitespace();
        if !self.consume(b':') {
            return Err(self.error(JsonErrorKind::InvalidSyntax));
        }
        self.frames[frame_index].state = FrameState::ObjectAfterValue;
        self.begin_value()
    }

    fn scan_string(&mut self, mut decoded: Option<&mut KeySlot>) -> Result<(), JsonError> {
        debug_assert_eq!(self.peek(), Some(b'"'));
        self.position += 1;
        loop {
            let byte = self
                .peek()
                .ok_or_else(|| self.error(JsonErrorKind::UnexpectedEnd))?;
            match byte {
                b'"' => {
                    self.position += 1;
                    return Ok(());
                }
                b'\\' => {
                    self.position += 1;
                    let escape = self
                        .peek()
                        .ok_or_else(|| self.error(JsonErrorKind::UnexpectedEnd))?;
                    self.position += 1;
                    match escape {
                        b'"' | b'\\' | b'/' => {
                            if let Some(target) = decoded.as_deref_mut() {
                                target.push(escape, self.position - 1)?;
                            }
                        }
                        b'b' | b'f' | b'n' | b'r' | b't' => {
                            let value = match escape {
                                b'b' => 0x08,
                                b'f' => 0x0c,
                                b'n' => b'\n',
                                b'r' => b'\r',
                                _ => b'\t',
                            };
                            if let Some(target) = decoded.as_deref_mut() {
                                target.push(value, self.position - 1)?;
                            }
                        }
                        b'u' => {
                            let scalar = self.scan_unicode_escape()?;
                            if let Some(target) = decoded.as_deref_mut() {
                                let mut encoded = [0u8; 4];
                                target.extend(
                                    scalar.encode_utf8(&mut encoded).as_bytes(),
                                    self.position,
                                )?;
                            }
                        }
                        _ => return Err(self.error(JsonErrorKind::InvalidEscape)),
                    }
                }
                0x00..=0x1f => return Err(self.error(JsonErrorKind::InvalidSyntax)),
                _ => {
                    self.position += 1;
                    if let Some(target) = decoded.as_deref_mut() {
                        target.push(byte, self.position - 1)?;
                    }
                }
            }
        }
    }

    fn scan_unicode_escape(&mut self) -> Result<char, JsonError> {
        let first = self.scan_hex_quad()?;
        let scalar = if (0xd800..=0xdbff).contains(&first) {
            if self.input.get(self.position..self.position + 2) != Some(b"\\u") {
                return Err(self.error(JsonErrorKind::InvalidSurrogate));
            }
            self.position += 2;
            let second = self.scan_hex_quad()?;
            if !(0xdc00..=0xdfff).contains(&second) {
                return Err(self.error(JsonErrorKind::InvalidSurrogate));
            }
            0x1_0000 + ((u32::from(first) - 0xd800) << 10) + (u32::from(second) - 0xdc00)
        } else if (0xdc00..=0xdfff).contains(&first) {
            return Err(self.error(JsonErrorKind::InvalidSurrogate));
        } else {
            u32::from(first)
        };
        char::from_u32(scalar).ok_or_else(|| self.error(JsonErrorKind::InvalidSurrogate))
    }

    fn scan_hex_quad(&mut self) -> Result<u16, JsonError> {
        if self.position + 4 > self.input.len() {
            return Err(self.error(JsonErrorKind::UnexpectedEnd));
        }
        let mut value = 0u16;
        for _ in 0..4 {
            let digit = match self.input[self.position] {
                b'0'..=b'9' => u16::from(self.input[self.position] - b'0'),
                b'a'..=b'f' => u16::from(self.input[self.position] - b'a') + 10,
                b'A'..=b'F' => u16::from(self.input[self.position] - b'A') + 10,
                _ => return Err(self.error(JsonErrorKind::InvalidEscape)),
            };
            value = value * 16 + digit;
            self.position += 1;
        }
        Ok(value)
    }

    fn scan_literal(&mut self, literal: &[u8]) -> Result<(), JsonError> {
        if self.input.get(self.position..self.position + literal.len()) != Some(literal) {
            return Err(self.error(JsonErrorKind::InvalidSyntax));
        }
        self.position += literal.len();
        Ok(())
    }

    fn scan_number(&mut self) -> Result<(), JsonError> {
        if self.consume(b'-') && self.peek().is_none() {
            return Err(self.error(JsonErrorKind::UnexpectedEnd));
        }
        match self.peek() {
            Some(b'0') => {
                self.position += 1;
                if self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                    return Err(self.error(JsonErrorKind::InvalidSyntax));
                }
            }
            Some(b'1'..=b'9') => {
                self.position += 1;
                while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                    self.position += 1;
                }
            }
            _ => return Err(self.error(JsonErrorKind::InvalidSyntax)),
        }
        if self.consume(b'.') {
            let start = self.position;
            while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                self.position += 1;
            }
            if self.position == start {
                return Err(self.error(JsonErrorKind::InvalidSyntax));
            }
        }
        if self.peek().is_some_and(|byte| matches!(byte, b'e' | b'E')) {
            self.position += 1;
            if self.peek().is_some_and(|byte| matches!(byte, b'+' | b'-')) {
                self.position += 1;
            }
            let start = self.position;
            while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                self.position += 1;
            }
            if self.position == start {
                return Err(self.error(JsonErrorKind::InvalidSyntax));
            }
        }
        Ok(())
    }

    fn expected_delimiter(&self) -> JsonError {
        if self.position == self.input.len() {
            self.error(JsonErrorKind::UnexpectedEnd)
        } else {
            self.error(JsonErrorKind::InvalidSyntax)
        }
    }

    fn peek(&self) -> Option<u8> {
        self.input.get(self.position).copied()
    }

    fn consume(&mut self, expected: u8) -> bool {
        if self.peek() == Some(expected) {
            self.position += 1;
            true
        } else {
            false
        }
    }
}

impl JsonError {
    const fn new(kind: JsonErrorKind, offset: usize) -> Self {
        Self { kind, offset }
    }
}
