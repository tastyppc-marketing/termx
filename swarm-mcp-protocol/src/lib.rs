//! Pure MCP bounded JSON/envelope parsing, request-ID normalization, handshake
//! admission, and bounded active-ID leases.
//!
//! This crate grants protocol admission only. A [`Disposition::OrdinaryReady`]
//! result is not application authority and does not reserve output or domain
//! capacity. A validated JSON document or parsed envelope proves syntax only;
//! neither grants application authority. Transport, tool catalogs, and native
//! enrollment are out of scope.
//!
//! Request-ID token spans must be exact. Leading or trailing whitespace is
//! rejected because the envelope parser supplies the span.
//!
//! Completed request IDs are not retained. An invalid later reuse may be
//! treated as a new request; a late cancel cannot be distinguished from
//! cancellation of that new request.
//!
//! One-request lifecycle control proving the public API compiles and the
//! handshake owner is the original initialize lease:
//!
//! ```
//! use termx_swarm_mcp_protocol::*;
//! let session = ProtocolSession::new(Limits::suggested()).unwrap();
//! assert_eq!(session.phase(), Phase::Uninitialized);
//! let id = RequestId::parse_json_token(b"1").unwrap();
//! let (lease, disposition) = session.admit(id, RequestClass::Initialize).unwrap();
//! assert_eq!(disposition, Disposition::Initialize);
//! assert_eq!(session.phase(), Phase::Initializing);
//! lease.response_sent(ResponseOutcome::InitializeSuccess);
//! assert_eq!(session.phase(), Phase::AwaitingInitialized);
//! assert_eq!(
//!     session.initialized_notification(),
//!     InitializedDisposition::BecameReady
//! );
//! assert_eq!(session.phase(), Phase::Ready);
//! ```
//!
//! `ActiveRequest` is not `Clone`.
//!
//! ```compile_fail
//! use termx_swarm_mcp_protocol::ActiveRequest;
//! fn needs_clone<T: Clone>(_: &T) {}
//! fn reject(lease: &ActiveRequest) {
//!     needs_clone(lease);
//! }
//! ```
//!
//! There is no ID-free ordinary/tool dispatch route.
//!
//! ```compile_fail
//! use termx_swarm_mcp_protocol::{ProtocolSession, RequestClass};
//! fn reject(session: &ProtocolSession) {
//!     let _ = session.admit_notification(RequestClass::ReadyOnly);
//! }
//! ```

#![forbid(unsafe_code)]

mod envelope;
mod id;
mod json;
mod output;
mod session;

pub use envelope::{
    EnvelopeError, EnvelopeErrorKind, McpEnvelope, MAX_MCP_INPUT_BYTES, MAX_MCP_METHOD_BYTES,
};
pub use id::{IdView, RequestId};
pub use json::{
    validate_json, JsonError, JsonErrorKind, JsonValidationStats, ValidatedJson,
    JSON_VALIDATOR_SCRATCH_BYTES, MAX_JSON_DEPTH, MAX_JSON_INPUT_BYTES, MAX_JSON_KEYS_PER_OBJECT,
    MAX_JSON_KEY_BYTES, MAX_JSON_LIVE_KEYS, MAX_JSON_NODES,
};
pub use output::{
    plan_result, plan_tool_result, OutputPlanError, ResponseLine, MAX_RESPONSE_LINE_BYTES,
    MAX_RESPONSE_WRAPPER_BYTES, OUTPUT_CHUNK_BYTES, OUTPUT_FIXED_SCRATCH_BYTES, OUTPUT_ID_BYTES,
    OUTPUT_MAX_FIXED_WIRE_BYTES, OUTPUT_METADATA_ALLOWANCE_BYTES,
};
pub use session::{
    AccountingSnapshot, ActiveRequest, AdmitError, CancelDisposition, Disposition,
    InitializedDisposition, Limits, Phase, ProtocolSession, RequestClass, ResponseOutcome,
};

/// Maximum encoded JSON scalar token, decoded UTF-8 string, and canonical
/// encoded scalar length in bytes.
pub const MAX_ID_BYTES: usize = 1024;

/// The one implemented MCP protocol version. Unknown requested versions are
/// selected by the later adapter using this constant.
pub const PROTOCOL_VERSION: &str = "2025-11-25";

/// Failure to parse an exact JSON scalar token as a request ID.
///
/// Display text never includes the token contents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdError {
    Empty,
    TokenTooLong,
    LeadingWhitespace,
    TrailingWhitespace,
    InvalidToken,
    NonIntegral,
    OutOfRange,
    DecodedTooLong,
    CanonicalTooLong,
}

impl std::fmt::Display for IdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Empty => "request ID token is empty",
            Self::TokenTooLong => "request ID token exceeds 1024 bytes",
            Self::LeadingWhitespace => "request ID token has leading whitespace",
            Self::TrailingWhitespace => "request ID token has trailing whitespace",
            Self::InvalidToken => "request ID token is not a JSON number or string scalar",
            Self::NonIntegral => "numeric request ID is not an integral value",
            Self::OutOfRange => "numeric request ID is outside signed i64",
            Self::DecodedTooLong => "decoded string request ID exceeds 1024 bytes",
            Self::CanonicalTooLong => "canonical encoded request ID exceeds 1024 bytes",
        })
    }
}

impl std::error::Error for IdError {}

/// Invalid [`Limits`] rejected before any slot allocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitsError {
    ActiveOutOfRange,
    ControlReserveInvalid,
}

impl std::fmt::Display for LimitsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::ActiveOutOfRange => "active limit must be in 2..=64",
            Self::ControlReserveInvalid => {
                "control reserve must be >= 1 and strictly less than active"
            }
        })
    }
}

impl std::error::Error for LimitsError {}
