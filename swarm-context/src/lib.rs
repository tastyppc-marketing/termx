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
//!
//! The `owner` module is the full owner-adapter entry point. Top-level
//! `OwnerRecord`/`OwnerProjection` remain compatibility APIs and are not that
//! adapter surface. Namespaced owner projections also cannot be serialized:
//!
//! ```compile_fail
//! use termx_swarm_context::owner::OwnerParser;
//! use termx_swarm_context::Provider;
//!
//! let parser = OwnerParser::new(Provider::Claude);
//! let owner = parser.project_line(
//!     r#"{"type":"user","uuid":"record","message":{"content":"text"}}"#,
//! );
//! let _peer_bytes = serde_json::to_vec(&owner)?;
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! Neighboring field inspection compiles and observes owner-only structure:
//!
//! ```
//! use termx_swarm_context::owner::{OwnerBodyKind, OwnerBodyOrigin, OwnerParser, OwnerRecord};
//! use termx_swarm_context::Provider;
//!
//! let parser = OwnerParser::new(Provider::Claude);
//! let owner = parser.project_line(
//!     r#"{"type":"user","uuid":"record","message":{"content":"text"}}"#,
//! );
//! assert_eq!(owner.source.native_record_id.as_deref(), Some("record"));
//! assert_eq!(owner.source.native_kind.as_deref(), Some("user"));
//! assert_eq!(owner.source.nested_message_role.as_deref(), None);
//! assert_eq!(
//!     owner.source.body_origin,
//!     Some(OwnerBodyOrigin::NestedContent)
//! );
//! assert_eq!(owner.source.body_kind, Some(OwnerBodyKind::String));
//! assert!(matches!(
//!     &owner.records[0].record,
//!     OwnerRecord::UserText { text } if text == "text"
//! ));
//! ```

pub mod owner;
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
