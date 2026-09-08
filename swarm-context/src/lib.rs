//! Pure, streaming structural parsing for bounded peer transcript projection.
//!
//! Owner projections deliberately have no `Serialize` implementation, so an
//! owner-only field cannot be passed directly to a peer JSON encoder:
//!
//! ```compile_fail
//! use termx_swarm_context::{Provider, ProviderParser};
//!
//! let mut parser = ProviderParser::new(Provider::Claude, "session")?;
//! let owner = parser.project_owner_line(
//!     r#"{"sessionId":"session","uuid":"record","type":"user","message":{"role":"user","content":"text"}}"#,
//! )?;
//! let _peer_bytes = serde_json::to_vec(&owner)?;
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

mod provider;
mod records;
mod scanner;

pub use provider::{ProjectionError, ProviderParser};
pub use records::{
    AssistantPhase, IdentityError, NativeId, OmissionCounts, OmissionOverflow, OwnerProjection,
    OwnerRecord, PeerBatch, PeerBatchPush, PeerProjection, PeerRecord, Provider, RecordIdentity,
    ToolStatus, MAX_ENCODED_PEER_BYTES, MAX_PROJECTED_BLOCKS,
};
pub use scanner::{
    ByteOffset, ByteRange, CompleteRecord, JsonlScanner, ScanError, ScanItem, ScanLag,
    UnavailableReason, MAX_JSON_DEPTH, MAX_OBJECT_MEMBERS, MAX_RECORD_BYTES, MAX_VALUE_NODES,
};
