//! Shared, closed argument mapping for CLI and MCP peer tools.
//!
//! Decoding supplies addresses and requested operations only. Native peer
//! authentication, current group policy, binding generation and every domain
//! mutation remain the broker's responsibility. There is no sender override or
//! route to owner commands here.

use std::fmt;

use serde::{de::DeserializeOwned, Deserialize};
use termx_swarm_core::model::{
    GroupId, MailboxNavigation, MessageId, PeerId, SendMessageRequest, SourceReferenceId,
};

use super::rpc::{PeerOperation, MAX_REQUEST_FRAME_BYTES};

/// Leave room for the generated, bounded RPC correlation ID and wrapper.
pub const MAX_TOOL_ARGUMENT_BYTES: usize = MAX_REQUEST_FRAME_BYTES - 4096;

/// Fixed `tools/list` result, shared with CLI help. Borrowed directly from the
/// executable; neither a payload tree nor a runtime catalog copy is required.
/// The source-file newline is not part of the JSON value or an MCP output line.
pub fn tool_catalog_json() -> &'static str {
    include_str!("tool_catalog.json").trim_end_matches(['\r', '\n'])
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolInputError {
    UnknownTool,
    InvalidArguments,
    TooLarge,
}

impl fmt::Display for ToolInputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::UnknownTool => "unknown collaboration tool",
            Self::InvalidArguments => "invalid collaboration tool arguments",
            Self::TooLarge => "collaboration tool arguments exceed the input limit",
        })
    }
}

impl std::error::Error for ToolInputError {}

/// Decode one complete arguments object, preserving exact integer navigation
/// and caller-selected message idempotency keys. This performs no I/O.
pub fn decode_tool_call(name: &str, arguments: &str) -> Result<PeerOperation, ToolInputError> {
    if arguments.len() > MAX_TOOL_ARGUMENT_BYTES {
        return Err(ToolInputError::TooLarge);
    }
    Ok(match name {
        "whoami" => {
            let args: WhoAmI = decode(arguments)?;
            PeerOperation::WhoAmI {
                after_group: args.after_group,
                max_items: page_size(args.max_items)?,
            }
        }
        "list_peers" => {
            let args: ListPeers = decode(arguments)?;
            PeerOperation::ListPeers {
                group_id: args.group_id,
                after_peer: args.after_peer,
                max_items: page_size(args.max_items)?,
            }
        }
        "read_messages" => {
            let args: ReadPage = decode(arguments)?;
            PeerOperation::MailboxAfter {
                group_id: args.group_id,
                navigation: args.navigation,
                max_items: page_size(args.max_items)?,
            }
        }
        "read_outgoing" => {
            let args: ReadPage = decode(arguments)?;
            PeerOperation::ReadOutgoing {
                group_id: args.group_id,
                navigation: args.navigation,
                max_items: page_size(args.max_items)?,
            }
        }
        "read_thread" => {
            let args: ReadThread = decode(arguments)?;
            PeerOperation::ReadThread {
                group_id: args.group_id,
                root: args.root,
                navigation: args.navigation,
                max_items: page_size(args.max_items)?,
            }
        }
        "send_message" => {
            let args: SendMessageRequest = decode(arguments)?;
            PeerOperation::Send {
                group_id: args.group_id,
                client_key: args.client_key,
                recipients: args.recipients,
                body: args.body,
                topic: args.topic,
                reply_to: args.reply_to,
                attachments: args.attachments,
            }
        }
        "acknowledge_message" => {
            let args: Acknowledge = decode(arguments)?;
            PeerOperation::Acknowledge {
                group_id: args.group_id,
                message_id: args.message_id,
            }
        }
        "publish_status" => {
            let args: PublishStatus = decode(arguments)?;
            PeerOperation::PublishStatus {
                group_id: args.group_id,
                status: args.status,
            }
        }
        "resolve_attachment" => {
            let args: ResolveAttachment = decode(arguments)?;
            PeerOperation::ResolveAttachment {
                group_id: args.group_id,
                source_reference_id: args.source_reference_id,
            }
        }
        _ => return Err(ToolInputError::UnknownTool),
    })
}

fn decode<T: DeserializeOwned>(arguments: &str) -> Result<T, ToolInputError> {
    // The CLI reaches the same boundary as MCP. Reject escaped duplicate
    // fields even inside enum/opaque-navigation representations before serde
    // can select one spelling. This is syntax validation, never authority.
    termx_swarm_mcp_protocol::validate_json(arguments.as_bytes())
        .map_err(|_| ToolInputError::InvalidArguments)?;
    serde_json::from_str(arguments).map_err(|_| ToolInputError::InvalidArguments)
}

fn default_page_size() -> u32 {
    64
}

fn page_size(value: u32) -> Result<u32, ToolInputError> {
    if (1..=128).contains(&value) {
        Ok(value)
    } else {
        Err(ToolInputError::InvalidArguments)
    }
}

fn first_page() -> MailboxNavigation {
    MailboxNavigation::ResetAfter { after_sequence: 0 }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WhoAmI {
    after_group: Option<GroupId>,
    #[serde(default = "default_page_size")]
    max_items: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListPeers {
    group_id: GroupId,
    after_peer: Option<PeerId>,
    #[serde(default = "default_page_size")]
    max_items: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadPage {
    group_id: GroupId,
    #[serde(default = "first_page")]
    navigation: MailboxNavigation,
    #[serde(default = "default_page_size")]
    max_items: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadThread {
    group_id: GroupId,
    root: MessageId,
    #[serde(default = "first_page")]
    navigation: MailboxNavigation,
    #[serde(default = "default_page_size")]
    max_items: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Acknowledge {
    group_id: GroupId,
    message_id: MessageId,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PublishStatus {
    group_id: GroupId,
    status: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolveAttachment {
    group_id: GroupId,
    source_reference_id: SourceReferenceId,
}
