use std::sync::Arc;

use crate::{IdError, MAX_ID_BYTES};

/// Opaque owned request ID. Equality, ordering, and hashing use the
/// normalized typed value, not the original spelling.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RequestId {
    kind: IdKind,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum IdKind {
    Integer(i64),
    String(Arc<str>),
}

/// Immutable view of a normalized request ID for later serialization.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdView<'a> {
    Integer(i64),
    String(&'a str),
}

impl RequestId {
    /// Parse one entire JSON scalar token.
    ///
    /// The caller must supply the exact token span. Leading or trailing
    /// whitespace is rejected as outside that span; the future envelope parser
    /// is responsible for isolating the span. Numeric tokens never pass through
    /// `serde_json::Value`, `Number`, or `f64`.
    ///
    /// There is no unchecked public constructor.
    pub fn parse_json_token(raw: &[u8]) -> Result<Self, IdError> {
        if raw.is_empty() {
            return Err(IdError::Empty);
        }
        if raw.len() > MAX_ID_BYTES {
            return Err(IdError::TokenTooLong);
        }
        if raw[0].is_ascii_whitespace() {
            return Err(IdError::LeadingWhitespace);
        }
        if raw[raw.len() - 1].is_ascii_whitespace() {
            return Err(IdError::TrailingWhitespace);
        }
        match raw[0] {
            b'"' => parse_string(raw),
            b'-' | b'0'..=b'9' => parse_number(raw),
            _ => Err(IdError::InvalidToken),
        }
    }

    pub fn view(&self) -> IdView<'_> {
        match &self.kind {
            IdKind::Integer(value) => IdView::Integer(*value),
            IdKind::String(value) => IdView::String(value),
        }
    }

    /// Canonical JSON scalar length in bytes.
    ///
    /// Numeric IDs use ordinary signed-integer spelling (at most 20 bytes).
    /// String IDs use `serde_json` string encoding of the decoded value.
    pub fn encoded_len(&self) -> usize {
        match &self.kind {
            IdKind::Integer(value) => i64_encoded_len(*value),
            IdKind::String(value) => canonical_string_len(value),
        }
    }

    /// Heap payload owned by this ID.
    ///
    /// Integer IDs own none. String IDs report the UTF-8 payload length of the
    /// shared `Arc<str>`; allocator headers are excluded.
    pub fn owned_heap_bytes(&self) -> usize {
        match &self.kind {
            IdKind::Integer(_) => 0,
            IdKind::String(value) => value.len(),
        }
    }
}

fn parse_string(raw: &[u8]) -> Result<RequestId, IdError> {
    let decoded: String = serde_json::from_slice(raw).map_err(|_| IdError::InvalidToken)?;
    if decoded.len() > MAX_ID_BYTES {
        return Err(IdError::DecodedTooLong);
    }
    if canonical_string_len(&decoded) > MAX_ID_BYTES {
        return Err(IdError::CanonicalTooLong);
    }
    Ok(RequestId {
        kind: IdKind::String(Arc::from(decoded)),
    })
}

fn canonical_string_len(value: &str) -> usize {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
}

fn parse_number(raw: &[u8]) -> Result<RequestId, IdError> {
    let mut i = 0usize;
    let negative = if raw[0] == b'-' {
        i = 1;
        true
    } else {
        false
    };
    if i >= raw.len() {
        return Err(IdError::InvalidToken);
    }

    let mut digits = Vec::with_capacity(raw.len());
    match raw[i] {
        b'0' => {
            digits.push(0);
            i += 1;
            if i < raw.len() && raw[i].is_ascii_digit() {
                return Err(IdError::InvalidToken);
            }
        }
        b'1'..=b'9' => {
            while i < raw.len() && raw[i].is_ascii_digit() {
                digits.push(raw[i] - b'0');
                i += 1;
            }
        }
        _ => return Err(IdError::InvalidToken),
    }

    let mut frac_len = 0usize;
    if i < raw.len() && raw[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < raw.len() && raw[i].is_ascii_digit() {
            digits.push(raw[i] - b'0');
            i += 1;
        }
        if i == frac_start {
            return Err(IdError::InvalidToken);
        }
        frac_len = i - frac_start;
    }

    let mut exp: i32 = 0;
    if i < raw.len() && (raw[i] == b'e' || raw[i] == b'E') {
        i += 1;
        if i >= raw.len() {
            return Err(IdError::InvalidToken);
        }
        let exp_negative = match raw[i] {
            b'-' => {
                i += 1;
                true
            }
            b'+' => {
                i += 1;
                false
            }
            _ => false,
        };
        if i >= raw.len() || !raw[i].is_ascii_digit() {
            return Err(IdError::InvalidToken);
        }
        let mut magnitude: i32 = 0;
        let mut overflow = false;
        while i < raw.len() && raw[i].is_ascii_digit() {
            let digit = i32::from(raw[i] - b'0');
            if magnitude > (i32::MAX - digit) / 10 {
                overflow = true;
                magnitude = i32::MAX;
            } else {
                magnitude = magnitude * 10 + digit;
            }
            i += 1;
        }
        exp = if overflow {
            if exp_negative {
                i32::MIN
            } else {
                i32::MAX
            }
        } else if exp_negative {
            -magnitude
        } else {
            magnitude
        };
    }

    if i != raw.len() {
        return Err(IdError::InvalidToken);
    }

    let value = digits_to_i64(&digits, frac_len, exp, negative)?;
    Ok(RequestId {
        kind: IdKind::Integer(value),
    })
}

fn digits_to_i64(digits: &[u8], frac_len: usize, exp: i32, negative: bool) -> Result<i64, IdError> {
    let mut start = 0usize;
    while start < digits.len() && digits[start] == 0 {
        start += 1;
    }
    if start == digits.len() {
        return Ok(0);
    }
    let digits = &digits[start..];
    let scale = exp
        .checked_sub(i32::try_from(frac_len).unwrap_or(i32::MAX))
        .unwrap_or(i32::MIN);

    let significant = if scale >= 0 {
        if scale > 20 {
            return Err(IdError::OutOfRange);
        }
        digits
    } else {
        let drop = usize::try_from(scale.unsigned_abs()).unwrap_or(usize::MAX);
        if drop > digits.len() {
            return Err(IdError::NonIntegral);
        }
        let keep = digits.len() - drop;
        if digits[keep..].iter().any(|digit| *digit != 0) {
            return Err(IdError::NonIntegral);
        }
        if keep == 0 {
            return Ok(0);
        }
        &digits[..keep]
    };

    let mut value: i64 = 0;
    for &digit in significant {
        let digit = i64::from(digit);
        value = value.checked_mul(10).ok_or(IdError::OutOfRange)?;
        value = if negative {
            value.checked_sub(digit).ok_or(IdError::OutOfRange)?
        } else {
            value.checked_add(digit).ok_or(IdError::OutOfRange)?
        };
    }
    if scale > 0 {
        for _ in 0..scale {
            value = value.checked_mul(10).ok_or(IdError::OutOfRange)?;
        }
    }
    Ok(value)
}

fn i64_encoded_len(value: i64) -> usize {
    if value == 0 {
        1
    } else if value == i64::MIN {
        20
    } else {
        let mut len = usize::from(value < 0);
        let mut remaining = value.unsigned_abs();
        while remaining > 0 {
            len += 1;
            remaining /= 10;
        }
        len
    }
}
