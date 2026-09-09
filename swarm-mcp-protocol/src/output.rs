use std::io::{self, Write};

use crate::{IdView, RequestId, ValidatedJson, MAX_ID_BYTES};

/// Maximum complete JSON-RPC response line, including its terminal LF.
pub const MAX_RESPONSE_LINE_BYTES: usize = 32 * 1024 * 1024;
/// Maximum permitted wrapper, canonical ID, fixed metadata, and LF contribution.
pub const MAX_RESPONSE_WRAPPER_BYTES: usize = 16 * 1024;
/// Fixed streaming output chunk.
pub const OUTPUT_CHUNK_BYTES: usize = 8 * 1024;
/// Fixed canonical request-ID buffer.
pub const OUTPUT_ID_BYTES: usize = MAX_ID_BYTES;
/// Conservative allowance for planner/writer scalar metadata and call frames.
pub const OUTPUT_METADATA_ALLOWANCE_BYTES: usize = 2 * 1024;
/// Complete explicit fixed-scratch charge for one write operation.
pub const OUTPUT_FIXED_SCRATCH_BYTES: usize =
    OUTPUT_CHUNK_BYTES + OUTPUT_ID_BYTES + OUTPUT_METADATA_ALLOWANCE_BYTES;

const PLAIN_PREFIX: &[u8] = br#"{"jsonrpc":"2.0","id":"#;
const PLAIN_RESULT: &[u8] = br#","result":"#;
const PLAIN_SUFFIX: &[u8] = b"}\n";
const TOOL_RESULT: &[u8] = br#","result":{"content":[{"type":"text","text":"#;
const TOOL_STRUCTURED: &[u8] = br#"}],"structuredContent":"#;
const TOOL_IS_ERROR: &[u8] = br#","isError":"#;
const TOOL_SUFFIX: &[u8] = b"}}\n";

/// Maximum fixed wire contribution for tool mode with a maximum canonical ID.
pub const OUTPUT_MAX_FIXED_WIRE_BYTES: usize = PLAIN_PREFIX.len()
    + MAX_ID_BYTES
    + TOOL_RESULT.len()
    + 2
    + TOOL_STRUCTURED.len()
    + TOOL_IS_ERROR.len()
    + 5
    + TOOL_SUFFIX.len();

const _: () = assert!(OUTPUT_FIXED_SCRATCH_BYTES <= 64 * 1024);
const _: () = assert!(OUTPUT_MAX_FIXED_WIRE_BYTES <= MAX_RESPONSE_WRAPPER_BYTES);

/// A closed failure to plan a pure JSON-RPC response line.
///
/// Rendering failures never include response data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputPlanError {
    ResultObjectRequired,
    LineBreak,
    LineTooLarge,
    LengthOverflow,
}

impl std::fmt::Display for OutputPlanError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::ResultObjectRequired => "response result must be a JSON object",
            Self::LineBreak => "response result contains a literal line break",
            Self::LineTooLarge => "response line exceeds 32 MiB",
            Self::LengthOverflow => "response line length overflowed",
        })
    }
}

impl std::error::Error for OutputPlanError {}

/// A borrowed JSON-RPC response formatting plan.
///
/// This value proves only syntax and bounded formatting. It grants no native,
/// protocol-schema, correlation, tool, or application authority and owns no
/// payload heap allocation.
pub struct ResponseLine<'a> {
    id: &'a RequestId,
    result: ValidatedJson<'a>,
    mode: ResponseMode,
    encoded_len: usize,
}

#[derive(Clone, Copy)]
enum ResponseMode {
    Plain,
    Tool { is_error: bool },
}

/// Plan an ordinary JSON-RPC object result without granting application authority.
pub fn plan_result<'a>(
    id: &'a RequestId,
    result: ValidatedJson<'a>,
) -> Result<ResponseLine<'a>, OutputPlanError> {
    validate_result_span(result.as_str())?;
    let encoded_len = checked_sum(&[
        PLAIN_PREFIX.len(),
        encoded_id_len(id)?,
        PLAIN_RESULT.len(),
        result.as_str().len(),
        PLAIN_SUFFIX.len(),
    ])?;
    finish_plan(id, result, ResponseMode::Plain, encoded_len)
}

/// Plan an MCP tool result without granting tool, schema, or application authority.
pub fn plan_tool_result<'a>(
    id: &'a RequestId,
    result: ValidatedJson<'a>,
    is_error: bool,
) -> Result<ResponseLine<'a>, OutputPlanError> {
    validate_result_span(result.as_str())?;
    let encoded_text_len = json_string_len(result.as_str())?;
    let boolean_len = if is_error { 4 } else { 5 };
    let encoded_len = checked_sum(&[
        PLAIN_PREFIX.len(),
        encoded_id_len(id)?,
        TOOL_RESULT.len(),
        encoded_text_len,
        TOOL_STRUCTURED.len(),
        result.as_str().len(),
        TOOL_IS_ERROR.len(),
        boolean_len,
        TOOL_SUFFIX.len(),
    ])?;
    finish_plan(id, result, ResponseMode::Tool { is_error }, encoded_len)
}

fn finish_plan<'a>(
    id: &'a RequestId,
    result: ValidatedJson<'a>,
    mode: ResponseMode,
    encoded_len: usize,
) -> Result<ResponseLine<'a>, OutputPlanError> {
    if encoded_len > MAX_RESPONSE_LINE_BYTES {
        return Err(OutputPlanError::LineTooLarge);
    }
    Ok(ResponseLine {
        id,
        result,
        mode,
        encoded_len,
    })
}

fn validate_result_span(raw: &str) -> Result<(), OutputPlanError> {
    if raw.bytes().any(|byte| matches!(byte, b'\r' | b'\n')) {
        return Err(OutputPlanError::LineBreak);
    }
    let trimmed = raw.trim_matches([' ', '\t']);
    if !trimmed.starts_with('{') {
        return Err(OutputPlanError::ResultObjectRequired);
    }
    Ok(())
}

fn checked_sum(parts: &[usize]) -> Result<usize, OutputPlanError> {
    parts.iter().try_fold(0usize, |total, part| {
        total
            .checked_add(*part)
            .ok_or(OutputPlanError::LengthOverflow)
    })
}

fn encoded_id_len(id: &RequestId) -> Result<usize, OutputPlanError> {
    match id.view() {
        IdView::Integer(value) => Ok(integer_len(value)),
        IdView::String(value) => json_string_len(value),
    }
}

fn integer_len(value: i64) -> usize {
    if value == 0 {
        return 1;
    }
    let mut length = usize::from(value < 0);
    let mut remaining = value.unsigned_abs();
    while remaining != 0 {
        length += 1;
        remaining /= 10;
    }
    length
}

fn json_string_len(value: &str) -> Result<usize, OutputPlanError> {
    let mut length = 2usize;
    for byte in value.bytes() {
        length = length
            .checked_add(escaped_byte_len(byte))
            .ok_or(OutputPlanError::LengthOverflow)?;
    }
    Ok(length)
}

fn escaped_byte_len(byte: u8) -> usize {
    match byte {
        b'"' | b'\\' | b'\x08' | b'\t' | b'\n' | b'\x0c' | b'\r' => 2,
        0x00..=0x1f => 6,
        _ => 1,
    }
}

impl ResponseLine<'_> {
    /// Exact encoded byte length, including one terminal LF.
    pub fn encoded_len(&self) -> usize {
        self.encoded_len
    }

    /// Heap storage owned by this formatting plan.
    pub const fn owned_heap_bytes(&self) -> usize {
        0
    }

    /// Fixed scratch charged while streaming this plan.
    pub const fn fixed_scratch_bytes(&self) -> usize {
        OUTPUT_FIXED_SCRATCH_BYTES
    }

    /// Stream this formatting-only response plan to a byte sink.
    ///
    /// This method does not flush the sink. A terminal write error is returned
    /// after its exact already-written prefix; the line is never replayed and
    /// no secondary error document is appended.
    pub fn write_to<W: Write>(&self, sink: &mut W) -> io::Result<()> {
        let mut id_bytes = [0u8; OUTPUT_ID_BYTES];
        let id_len = encode_id(self.id, &mut id_bytes);
        debug_assert_eq!(Some(id_len), encoded_id_len(self.id).ok());

        let mut output = ChunkWriter::new(sink);
        output.push(PLAIN_PREFIX)?;
        output.push(&id_bytes[..id_len])?;
        match self.mode {
            ResponseMode::Plain => {
                output.push(PLAIN_RESULT)?;
                output.push(self.result.as_str().as_bytes())?;
                output.push(PLAIN_SUFFIX)?;
            }
            ResponseMode::Tool { is_error } => {
                output.push(TOOL_RESULT)?;
                write_json_string(&mut output, self.result.as_str())?;
                output.push(TOOL_STRUCTURED)?;
                output.push(self.result.as_str().as_bytes())?;
                output.push(TOOL_IS_ERROR)?;
                output.push(if is_error { b"true" } else { b"false" })?;
                output.push(TOOL_SUFFIX)?;
            }
        }
        output.finish()
    }
}

fn encode_id(id: &RequestId, output: &mut [u8; OUTPUT_ID_BYTES]) -> usize {
    match id.view() {
        IdView::Integer(value) => encode_integer(value, output),
        IdView::String(value) => encode_json_string_to_slice(value, output),
    }
}

fn encode_integer(value: i64, output: &mut [u8; OUTPUT_ID_BYTES]) -> usize {
    let mut reversed = [0u8; 20];
    let mut digits = 0usize;
    let mut remaining = value.unsigned_abs();
    loop {
        reversed[digits] = b'0' + (remaining % 10) as u8;
        digits += 1;
        remaining /= 10;
        if remaining == 0 {
            break;
        }
    }

    let mut cursor = 0usize;
    if value < 0 {
        output[cursor] = b'-';
        cursor += 1;
    }
    for index in (0..digits).rev() {
        output[cursor] = reversed[index];
        cursor += 1;
    }
    cursor
}

fn encode_json_string_to_slice(value: &str, output: &mut [u8; OUTPUT_ID_BYTES]) -> usize {
    let mut cursor = 0usize;
    output[cursor] = b'"';
    cursor += 1;
    for byte in value.bytes() {
        if let Some(short) = short_escape(byte) {
            output[cursor..cursor + short.len()].copy_from_slice(short);
            cursor += short.len();
        } else if byte <= 0x1f {
            let escape = unicode_control_escape(byte);
            output[cursor..cursor + escape.len()].copy_from_slice(&escape);
            cursor += escape.len();
        } else {
            output[cursor] = byte;
            cursor += 1;
        }
    }
    output[cursor] = b'"';
    cursor + 1
}

fn write_json_string<W: Write>(output: &mut ChunkWriter<'_, W>, value: &str) -> io::Result<()> {
    output.push(b"\"")?;
    let bytes = value.as_bytes();
    let mut start = 0usize;
    for (index, &byte) in bytes.iter().enumerate() {
        if short_escape(byte).is_some() || byte <= 0x1f {
            output.push(&bytes[start..index])?;
            if let Some(short) = short_escape(byte) {
                output.push(short)?;
            } else {
                output.push(&unicode_control_escape(byte))?;
            }
            start = index + 1;
        }
    }
    output.push(&bytes[start..])?;
    output.push(b"\"")
}

fn short_escape(byte: u8) -> Option<&'static [u8]> {
    match byte {
        b'"' => Some(br#"\""#),
        b'\\' => Some(br#"\\"#),
        b'\x08' => Some(br#"\b"#),
        b'\t' => Some(br#"\t"#),
        b'\n' => Some(br#"\n"#),
        b'\x0c' => Some(br#"\f"#),
        b'\r' => Some(br#"\r"#),
        _ => None,
    }
}

fn unicode_control_escape(byte: u8) -> [u8; 6] {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    [
        b'\\',
        b'u',
        b'0',
        b'0',
        HEX[(byte >> 4) as usize],
        HEX[(byte & 0x0f) as usize],
    ]
}

struct ChunkWriter<'a, W> {
    sink: &'a mut W,
    buffer: [u8; OUTPUT_CHUNK_BYTES],
    buffered: usize,
}

impl<'a, W: Write> ChunkWriter<'a, W> {
    fn new(sink: &'a mut W) -> Self {
        Self {
            sink,
            buffer: [0; OUTPUT_CHUNK_BYTES],
            buffered: 0,
        }
    }

    fn push(&mut self, mut bytes: &[u8]) -> io::Result<()> {
        while !bytes.is_empty() {
            if self.buffered == self.buffer.len() {
                self.write_buffer()?;
            }
            let available = self.buffer.len() - self.buffered;
            let copied = available.min(bytes.len());
            self.buffer[self.buffered..self.buffered + copied].copy_from_slice(&bytes[..copied]);
            self.buffered += copied;
            bytes = &bytes[copied..];
        }
        Ok(())
    }

    fn finish(mut self) -> io::Result<()> {
        self.write_buffer()
    }

    fn write_buffer(&mut self) -> io::Result<()> {
        let mut written = 0usize;
        while written < self.buffered {
            match self.sink.write(&self.buffer[written..self.buffered]) {
                Ok(0) => return Err(io::Error::from(io::ErrorKind::WriteZero)),
                Ok(bytes) if bytes <= self.buffered - written => written += bytes,
                Ok(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "sink reported writing beyond the supplied buffer",
                    ));
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
        self.buffered = 0;
        Ok(())
    }
}
