use std::fmt;

use crate::{json::scan_value_end, validate_json, RequestId};

pub const MAX_MCP_INPUT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_MCP_METHOD_BYTES: usize = 128;

const MAX_ENCODED_SMALL_STRING_BYTES: usize = 2 + 6 * MAX_MCP_METHOD_BYTES;
const MAX_ENCODED_VERSION_BYTES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvelopeErrorKind {
    InputTooLarge,
    LineBreak,
    InvalidJson,
    TopLevelObjectRequired,
    UnknownField,
    MissingJsonRpc,
    InvalidJsonRpc,
    MissingMethod,
    InvalidMethod,
    MethodTooLong,
    InvalidId,
    ParamsObjectRequired,
}

/// Closed MCP envelope failure. Neither Debug nor Display includes source
/// bytes, method names, parameters, or request IDs.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct EnvelopeError {
    kind: EnvelopeErrorKind,
    offset: usize,
}

impl EnvelopeError {
    pub fn kind(self) -> EnvelopeErrorKind {
        self.kind
    }

    pub fn offset(self) -> usize {
        self.offset
    }

    const fn new(kind: EnvelopeErrorKind, offset: usize) -> Self {
        Self { kind, offset }
    }
}

impl fmt::Debug for EnvelopeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EnvelopeError")
            .field("kind", &self.kind)
            .field("offset", &self.offset)
            .finish()
    }
}

impl fmt::Display for EnvelopeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let description = match self.kind {
            EnvelopeErrorKind::InputTooLarge => "MCP input exceeds 4 MiB",
            EnvelopeErrorKind::LineBreak => {
                "MCP input contains a line break; the adapter must strip its delimiter"
            }
            EnvelopeErrorKind::InvalidJson => "MCP input is not bounded valid JSON",
            EnvelopeErrorKind::TopLevelObjectRequired => "MCP envelope must be one object",
            EnvelopeErrorKind::UnknownField => "MCP envelope contains an unsupported field",
            EnvelopeErrorKind::MissingJsonRpc => "MCP envelope is missing jsonrpc",
            EnvelopeErrorKind::InvalidJsonRpc => "MCP jsonrpc must decode exactly to 2.0",
            EnvelopeErrorKind::MissingMethod => "MCP envelope is missing method",
            EnvelopeErrorKind::InvalidMethod => "MCP method must be a nonempty string",
            EnvelopeErrorKind::MethodTooLong => "decoded MCP method exceeds 128 bytes",
            EnvelopeErrorKind::InvalidId => "MCP request ID is invalid",
            EnvelopeErrorKind::ParamsObjectRequired => "MCP params must be an object",
        };
        write!(formatter, "{description} at byte {}", self.offset)
    }
}

impl std::error::Error for EnvelopeError {}

/// Borrowed, syntax-only MCP request or notification envelope. Unknown methods
/// remain inert data. Parsing grants no dispatch or application authority.
pub struct McpEnvelope<'a> {
    id: Option<RequestId>,
    method: String,
    params: Option<&'a str>,
}

impl fmt::Debug for McpEnvelope<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("McpEnvelope")
            .field("has_id", &self.id.is_some())
            .field("method_bytes", &self.method.len())
            .field("params_bytes", &self.params.map(str::len))
            .finish()
    }
}

impl<'a> McpEnvelope<'a> {
    /// Parse one complete input line after the line adapter has removed LF or
    /// CRLF. Any literal CR/LF is rejected; escaped newline text remains JSON.
    pub fn parse(input: &'a [u8]) -> Result<Self, EnvelopeError> {
        if input.len() > MAX_MCP_INPUT_BYTES {
            return Err(EnvelopeError::new(
                EnvelopeErrorKind::InputTooLarge,
                MAX_MCP_INPUT_BYTES,
            ));
        }
        if let Some(offset) = input.iter().position(|byte| matches!(byte, b'\r' | b'\n')) {
            return Err(EnvelopeError::new(EnvelopeErrorKind::LineBreak, offset));
        }
        let validated = validate_json(input)
            .map_err(|error| EnvelopeError::new(EnvelopeErrorKind::InvalidJson, error.offset()))?;
        let mut position = 0usize;
        skip_horizontal_whitespace(input, &mut position);
        if input.get(position) != Some(&b'{') {
            return Err(EnvelopeError::new(
                EnvelopeErrorKind::TopLevelObjectRequired,
                position,
            ));
        }
        position += 1;

        let mut id = None;
        let mut method = None;
        let mut params = None;
        let mut jsonrpc_seen = false;
        skip_horizontal_whitespace(input, &mut position);
        if input.get(position) == Some(&b'}') {
            position += 1;
        } else {
            loop {
                skip_horizontal_whitespace(input, &mut position);
                let key_start = position;
                let key_end = scan_value_end(input, key_start).map_err(|error| {
                    EnvelopeError::new(EnvelopeErrorKind::InvalidJson, error.offset())
                })?;
                let key = decode_small_string(
                    &input[key_start..key_end],
                    MAX_ENCODED_SMALL_STRING_BYTES,
                    MAX_MCP_METHOD_BYTES,
                )
                .map_err(|_| EnvelopeError::new(EnvelopeErrorKind::InvalidJson, key_start))?;
                position = key_end;
                skip_horizontal_whitespace(input, &mut position);
                debug_assert_eq!(input.get(position), Some(&b':'));
                position += 1;
                skip_horizontal_whitespace(input, &mut position);
                let value_start = position;
                let value_end = scan_value_end(input, value_start).map_err(|error| {
                    EnvelopeError::new(EnvelopeErrorKind::InvalidJson, error.offset())
                })?;
                match key.as_str() {
                    "jsonrpc" => {
                        jsonrpc_seen = true;
                        let version = decode_small_string(
                            &input[value_start..value_end],
                            MAX_ENCODED_VERSION_BYTES,
                            3,
                        )
                        .map_err(|_| {
                            EnvelopeError::new(EnvelopeErrorKind::InvalidJsonRpc, value_start)
                        })?;
                        if version != "2.0" {
                            return Err(EnvelopeError::new(
                                EnvelopeErrorKind::InvalidJsonRpc,
                                value_start,
                            ));
                        }
                    }
                    "method" => {
                        let decoded = decode_small_string(
                            &input[value_start..value_end],
                            MAX_ENCODED_SMALL_STRING_BYTES,
                            MAX_MCP_METHOD_BYTES,
                        )
                        .map_err(|kind| {
                            EnvelopeError::new(
                                if kind == SmallStringError::TooLong {
                                    EnvelopeErrorKind::MethodTooLong
                                } else {
                                    EnvelopeErrorKind::InvalidMethod
                                },
                                value_start,
                            )
                        })?;
                        if decoded.is_empty() {
                            return Err(EnvelopeError::new(
                                EnvelopeErrorKind::InvalidMethod,
                                value_start,
                            ));
                        }
                        method = Some(decoded);
                    }
                    "id" => {
                        id = Some(
                            RequestId::parse_json_token(&input[value_start..value_end]).map_err(
                                |_| EnvelopeError::new(EnvelopeErrorKind::InvalidId, value_start),
                            )?,
                        );
                    }
                    "params" => {
                        if input.get(value_start) != Some(&b'{') {
                            return Err(EnvelopeError::new(
                                EnvelopeErrorKind::ParamsObjectRequired,
                                value_start,
                            ));
                        }
                        params = Some(&validated.as_str()[value_start..value_end]);
                    }
                    _ => {
                        return Err(EnvelopeError::new(
                            EnvelopeErrorKind::UnknownField,
                            key_start,
                        ));
                    }
                }
                position = value_end;
                skip_horizontal_whitespace(input, &mut position);
                match input.get(position) {
                    Some(b',') => position += 1,
                    Some(b'}') => {
                        position += 1;
                        break;
                    }
                    _ => unreachable!("bounded JSON validation established object delimiters"),
                }
            }
        }
        skip_horizontal_whitespace(input, &mut position);
        debug_assert_eq!(position, input.len());
        if !jsonrpc_seen {
            return Err(EnvelopeError::new(
                EnvelopeErrorKind::MissingJsonRpc,
                position,
            ));
        }
        let method =
            method.ok_or_else(|| EnvelopeError::new(EnvelopeErrorKind::MissingMethod, position))?;
        Ok(Self { id, method, params })
    }

    pub fn id(&self) -> Option<&RequestId> {
        self.id.as_ref()
    }

    pub fn method(&self) -> &str {
        &self.method
    }

    pub fn params(&self) -> Option<&'a str> {
        self.params
    }

    pub fn is_notification(&self) -> bool {
        self.id.is_none()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SmallStringError {
    NotString,
    TooLong,
}

fn decode_small_string(
    raw: &[u8],
    max_encoded: usize,
    max_decoded: usize,
) -> Result<String, SmallStringError> {
    if raw.len() > max_encoded {
        return Err(SmallStringError::TooLong);
    }
    if raw.first() != Some(&b'"') || raw.last() != Some(&b'"') {
        return Err(SmallStringError::NotString);
    }
    let decoded: String = serde_json::from_slice(raw).map_err(|_| SmallStringError::NotString)?;
    if decoded.len() > max_decoded {
        return Err(SmallStringError::TooLong);
    }
    Ok(decoded)
}

fn skip_horizontal_whitespace(input: &[u8], position: &mut usize) {
    while input
        .get(*position)
        .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
    {
        *position += 1;
    }
}
