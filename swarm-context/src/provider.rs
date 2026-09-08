use std::fmt;

use serde_json::Value;

use crate::scanner::JsonValue;
use crate::{
    AssistantPhase, ByteRange, NativeId, OmissionCounts, OwnerProjection, OwnerRecord,
    PeerProjection, PeerRecord, Provider, RecordIdentity, ScanItem, ToolStatus, UnavailableReason,
    MAX_PROJECTED_BLOCKS,
};

#[derive(Debug)]
pub struct ProviderParser {
    provider: Provider,
    conversation: NativeId,
    peer_codex_identity: CodexIdentity,
    owner_codex_identity: CodexIdentity,
    peer_claude_identity_conflicting: bool,
    owner_claude_identity_conflicting: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodexIdentity {
    Missing,
    Confirmed,
    Conflicting,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectionError {
    MalformedJson,
    UnsupportedProviderShape,
}

impl fmt::Display for ProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MalformedJson => formatter.write_str("malformed provider JSON"),
            Self::UnsupportedProviderShape => formatter.write_str("unsupported provider shape"),
        }
    }
}

impl std::error::Error for ProjectionError {}

impl ProviderParser {
    pub fn new(provider: Provider, conversation: &str) -> Result<Self, crate::IdentityError> {
        Ok(Self {
            provider,
            conversation: NativeId::new(conversation)?,
            peer_codex_identity: CodexIdentity::Missing,
            owner_codex_identity: CodexIdentity::Missing,
            peer_claude_identity_conflicting: false,
            owner_claude_identity_conflicting: false,
        })
    }

    pub fn project_peer(&mut self, item: ScanItem) -> PeerProjection {
        match item {
            ScanItem::Unavailable { range, reason } => unavailable(self.provider, range, reason),
            ScanItem::Complete(record) => {
                let range = record.range().clone();
                match self.project_value(&record.value, range.clone(), Audience::Peer) {
                    Ok(Projection::Peer(projection)) => projection,
                    Ok(Projection::Owner(_)) => {
                        unreachable!("peer audience yields peer projection")
                    }
                    Err(reason) => unavailable(self.provider, range, reason),
                }
            }
        }
    }

    pub fn project_owner_line(&mut self, line: &str) -> Result<OwnerProjection, ProjectionError> {
        let value: Value =
            serde_json::from_str(line).map_err(|_| ProjectionError::MalformedJson)?;
        let value = owner_value(value);
        match self.project_value(&value, ByteRange::new_for_owner(), Audience::Owner) {
            Ok(Projection::Owner(projection)) => Ok(projection),
            Ok(Projection::Peer(_)) => unreachable!("owner audience yields owner projection"),
            Err(_) => Err(ProjectionError::UnsupportedProviderShape),
        }
    }

    fn project_value(
        &mut self,
        value: &JsonValue,
        range: ByteRange,
        audience: Audience,
    ) -> Result<Projection, UnavailableReason> {
        match self.provider {
            Provider::Claude => self.project_claude(value, range, audience),
            Provider::Codex => self.project_codex(value, range, audience),
        }
    }

    fn project_claude(
        &mut self,
        value: &JsonValue,
        range: ByteRange,
        audience: Audience,
    ) -> Result<Projection, UnavailableReason> {
        let already_conflicting = match audience {
            Audience::Peer => self.peer_claude_identity_conflicting,
            Audience::Owner => self.owner_claude_identity_conflicting,
        };
        if already_conflicting {
            return Err(UnavailableReason::ConflictingConversationIdentity);
        }
        match value.get("sessionId").and_then(JsonValue::as_str) {
            None => return Err(UnavailableReason::MissingConversationIdentity),
            Some(value) if value != self.conversation.as_str() => {
                match audience {
                    Audience::Peer => self.peer_claude_identity_conflicting = true,
                    Audience::Owner => self.owner_claude_identity_conflicting = true,
                }
                return Err(UnavailableReason::ConflictingConversationIdentity);
            }
            Some(_) => {}
        }
        if optional_bool(value, "isSidechain")? == Some(true) {
            return Err(UnavailableReason::SidechainAttributionUnavailable);
        }
        let native_record_id = required_id(value, "uuid")?;
        let record_type = value
            .get("type")
            .and_then(JsonValue::as_str)
            .ok_or(UnavailableReason::UnsupportedProviderShape)?;
        match record_type {
            "assistant" => self.claude_assistant(value, native_record_id, range, audience),
            "user" => self.claude_user(value, native_record_id, range, audience),
            "system"
                if value.get("subtype").and_then(JsonValue::as_str) == Some("compact_boundary") =>
            {
                if audience == Audience::Peer
                    && value.get("isMeta").and_then(JsonValue::as_bool) != Some(false)
                {
                    return Err(UnavailableReason::UnsupportedProviderShape);
                }
                let text = required_text(value, "content")?;
                Ok(match audience {
                    Audience::Peer => Projection::Peer(PeerProjection::new(
                        self.provider,
                        vec![PeerRecord::CompactionBoundary {
                            identity: identity(native_record_id, None, None, range),
                            text,
                        }],
                        OmissionCounts::default(),
                    )),
                    Audience::Owner => Projection::Owner(OwnerProjection::new(
                        self.provider,
                        vec![OwnerRecord::Compaction { text, recap: false }],
                    )),
                })
            }
            _ => Err(UnavailableReason::UnsupportedProviderShape),
        }
    }

    fn claude_assistant(
        &self,
        value: &JsonValue,
        native_record_id: NativeId,
        range: ByteRange,
        audience: Audience,
    ) -> Result<Projection, UnavailableReason> {
        let message = value
            .get("message")
            .ok_or(UnavailableReason::UnsupportedProviderShape)?;
        if audience == Audience::Peer
            && (message.get("role").and_then(JsonValue::as_str) != Some("assistant")
                || message.get("type").and_then(JsonValue::as_str) != Some("message"))
        {
            return Err(UnavailableReason::UnsupportedProviderShape);
        }
        let response_id = required_id(message, "id")?;
        let blocks = message
            .get("content")
            .and_then(JsonValue::as_array)
            .ok_or(UnavailableReason::UnsupportedProviderShape)?;
        if audience == Audience::Peer && blocks.len() > MAX_PROJECTED_BLOCKS {
            return Err(UnavailableReason::TooManyProjectedBlocks);
        }
        let mut peer = Vec::new();
        let mut owner = Vec::new();
        let mut omissions = OmissionCounts::default();
        for (index, block) in blocks.iter().enumerate() {
            let block_type = block.get("type").and_then(JsonValue::as_str).unwrap_or("");
            match block_type {
                "text" => {
                    let text = required_text(block, "text")?;
                    match audience {
                        Audience::Peer => {
                            ensure_peer_room(peer.len(), 1)?;
                            peer.push(PeerRecord::AssistantText {
                                identity: identity(
                                    native_record_id.clone(),
                                    Some(response_id.clone()),
                                    index_u16(index)?,
                                    range.clone(),
                                ),
                                phase: AssistantPhase::Unspecified,
                                text,
                            });
                        }
                        Audience::Owner => owner.push(OwnerRecord::AssistantText { text }),
                    }
                }
                "tool_use" => match audience {
                    Audience::Peer => {
                        ensure_peer_room(peer.len(), 1)?;
                        peer.push(PeerRecord::ToolCall {
                            identity: identity(
                                native_record_id.clone(),
                                Some(response_id.clone()),
                                index_u16(index)?,
                                range.clone(),
                            ),
                            call_id: required_id(block, "id")?,
                            tool_name: required_text(block, "name")?,
                            status: ToolStatus::Running,
                        });
                    }
                    Audience::Owner => owner.push(OwnerRecord::ToolCall {
                        call_id: required_id(block, "id")?,
                        tool_name: required_text(block, "name")?,
                        status: ToolStatus::Running,
                        input_json: block
                            .get("input")
                            .map_or_else(|| "null".to_owned(), owner_input_json),
                    }),
                },
                "thinking" | "redacted_thinking" => match audience {
                    Audience::Peer => omissions
                        .omit_private_reasoning()
                        .map_err(|_| UnavailableReason::ResourceLimit)?,
                    Audience::Owner if block_type == "thinking" => {
                        if let Some(text) = block.get("thinking").and_then(JsonValue::as_str) {
                            owner.push(OwnerRecord::Thinking {
                                text: text.to_owned(),
                            });
                        }
                    }
                    Audience::Owner => {}
                },
                _ if block.get("sensitivity").and_then(JsonValue::as_str)
                    == Some("private_model_reasoning") =>
                {
                    if audience == Audience::Peer {
                        omissions
                            .omit_unknown_sensitive()
                            .map_err(|_| UnavailableReason::ResourceLimit)?;
                    }
                }
                _ => return Err(UnavailableReason::UnsupportedProviderShape),
            }
        }
        if peer.is_empty() && omissions.blocks() != 0 {
            omissions
                .omit_provider_record()
                .map_err(|_| UnavailableReason::ResourceLimit)?;
        }
        Ok(match audience {
            Audience::Peer => Projection::Peer(PeerProjection::new(self.provider, peer, omissions)),
            Audience::Owner => Projection::Owner(OwnerProjection::new(self.provider, owner)),
        })
    }

    fn claude_user(
        &self,
        value: &JsonValue,
        native_record_id: NativeId,
        range: ByteRange,
        audience: Audience,
    ) -> Result<Projection, UnavailableReason> {
        let message = value
            .get("message")
            .ok_or(UnavailableReason::UnsupportedProviderShape)?;
        if optional_bool(value, "isMeta")? == Some(true) {
            let mut omissions = OmissionCounts::default();
            omissions
                .omit_metadata()
                .map_err(|_| UnavailableReason::ResourceLimit)?;
            return Ok(match audience {
                Audience::Peer => {
                    Projection::Peer(PeerProjection::new(self.provider, Vec::new(), omissions))
                }
                Audience::Owner => {
                    Projection::Owner(OwnerProjection::new(self.provider, Vec::new()))
                }
            });
        }
        if audience == Audience::Peer
            && message.get("role").and_then(JsonValue::as_str) != Some("user")
        {
            return Err(UnavailableReason::UnsupportedProviderShape);
        }
        let content = message
            .get("content")
            .ok_or(UnavailableReason::UnsupportedProviderShape)?;
        if optional_bool(value, "isCompactSummary")? == Some(true) {
            if audience == Audience::Peer
                && value
                    .get("isVisibleInTranscriptOnly")
                    .and_then(JsonValue::as_bool)
                    != Some(true)
            {
                return Err(UnavailableReason::UnsupportedProviderShape);
            }
            let text = content
                .as_str()
                .ok_or(UnavailableReason::UnsupportedProviderShape)?
                .to_owned();
            return Ok(match audience {
                Audience::Peer => Projection::Peer(PeerProjection::new(
                    self.provider,
                    vec![PeerRecord::CompactionSummary {
                        identity: identity(native_record_id, None, None, range),
                        text,
                    }],
                    OmissionCounts::default(),
                )),
                Audience::Owner => Projection::Owner(OwnerProjection::new(
                    self.provider,
                    vec![OwnerRecord::Compaction { text, recap: true }],
                )),
            });
        }
        if let Some(text) = content.as_str() {
            return Ok(match audience {
                Audience::Peer => Projection::Peer(PeerProjection::new(
                    self.provider,
                    vec![PeerRecord::UserText {
                        identity: identity(native_record_id, None, Some(0), range),
                        text: text.to_owned(),
                    }],
                    OmissionCounts::default(),
                )),
                Audience::Owner => Projection::Owner(OwnerProjection::new(
                    self.provider,
                    vec![OwnerRecord::UserText {
                        text: text.to_owned(),
                    }],
                )),
            });
        }
        let blocks = content
            .as_array()
            .ok_or(UnavailableReason::UnsupportedProviderShape)?;
        if audience == Audience::Peer && blocks.len() > MAX_PROJECTED_BLOCKS {
            return Err(UnavailableReason::TooManyProjectedBlocks);
        }
        let mut peer = Vec::new();
        let mut owner = Vec::new();
        for (index, block) in blocks.iter().enumerate() {
            match block.get("type").and_then(JsonValue::as_str) {
                Some("tool_result") => {
                    let call_id = required_id(block, "tool_use_id")?;
                    let texts = result_texts(block, audience)?;
                    let status = if optional_bool(block, "is_error")? == Some(true) {
                        ToolStatus::Failed
                    } else {
                        ToolStatus::Completed
                    };
                    match audience {
                        Audience::Peer => {
                            ensure_peer_room(peer.len(), texts.len())?;
                            for (subindex, text) in texts.into_iter().enumerate() {
                                peer.push(PeerRecord::ToolResult {
                                    identity: nested_identity(
                                        native_record_id.clone(),
                                        None,
                                        index_u16(index)?,
                                        index_u16(subindex)?,
                                        range.clone(),
                                    ),
                                    call_id: call_id.clone(),
                                    text,
                                    status,
                                });
                            }
                        }
                        Audience::Owner => {
                            owner.extend(texts.into_iter().map(|text| OwnerRecord::ToolResult {
                                call_id: call_id.clone(),
                                status,
                                text,
                            }));
                        }
                    }
                }
                Some("text") => {
                    let text = required_text(block, "text")?;
                    match audience {
                        Audience::Peer => {
                            ensure_peer_room(peer.len(), 1)?;
                            peer.push(PeerRecord::UserText {
                                identity: identity(
                                    native_record_id.clone(),
                                    None,
                                    index_u16(index)?,
                                    range.clone(),
                                ),
                                text,
                            });
                        }
                        Audience::Owner => owner.push(OwnerRecord::UserText { text }),
                    }
                }
                _ => return Err(UnavailableReason::UnsupportedProviderShape),
            }
        }
        Ok(match audience {
            Audience::Peer => Projection::Peer(PeerProjection::new(
                self.provider,
                peer,
                OmissionCounts::default(),
            )),
            Audience::Owner => Projection::Owner(OwnerProjection::new(self.provider, owner)),
        })
    }

    fn project_codex(
        &mut self,
        value: &JsonValue,
        range: ByteRange,
        audience: Audience,
    ) -> Result<Projection, UnavailableReason> {
        let record_type = value
            .get("type")
            .and_then(JsonValue::as_str)
            .ok_or(UnavailableReason::UnsupportedProviderShape)?;
        if record_type == "session_meta" {
            let supplied = value
                .get("payload")
                .and_then(|payload| payload.get("id"))
                .and_then(JsonValue::as_str);
            let matches = supplied == Some(self.conversation.as_str());
            let state = match audience {
                Audience::Peer => &mut self.peer_codex_identity,
                Audience::Owner => &mut self.owner_codex_identity,
            };
            if *state != CodexIdentity::Conflicting {
                *state = if matches {
                    CodexIdentity::Confirmed
                } else {
                    CodexIdentity::Conflicting
                };
            }
            if *state == CodexIdentity::Conflicting {
                return Err(UnavailableReason::ConflictingConversationIdentity);
            }
            let mut omissions = OmissionCounts::default();
            omissions
                .omit_metadata()
                .map_err(|_| UnavailableReason::ResourceLimit)?;
            return Ok(match audience {
                Audience::Peer => {
                    Projection::Peer(PeerProjection::new(self.provider, Vec::new(), omissions))
                }
                Audience::Owner => {
                    Projection::Owner(OwnerProjection::new(self.provider, Vec::new()))
                }
            });
        }
        let identity_state = match audience {
            Audience::Peer => self.peer_codex_identity,
            Audience::Owner => self.owner_codex_identity,
        };
        match identity_state {
            CodexIdentity::Missing => return Err(UnavailableReason::MissingConversationIdentity),
            CodexIdentity::Conflicting => {
                return Err(UnavailableReason::ConflictingConversationIdentity)
            }
            CodexIdentity::Confirmed => {}
        }
        if record_type != "response_item" {
            return Err(UnavailableReason::UnsupportedProviderShape);
        }
        let payload = value
            .get("payload")
            .ok_or(UnavailableReason::UnsupportedProviderShape)?;
        let payload_type = payload
            .get("type")
            .and_then(JsonValue::as_str)
            .ok_or(UnavailableReason::UnsupportedProviderShape)?;
        match payload_type {
            "message" => self.codex_message(payload, range, audience),
            "custom_tool_call" => Ok(match audience {
                Audience::Peer => {
                    let status = codex_tool_status(payload)?;
                    Projection::Peer(PeerProjection::new(
                        self.provider,
                        vec![PeerRecord::ToolCall {
                            identity: identity(required_id(payload, "id")?, None, None, range),
                            call_id: required_id(payload, "call_id")?,
                            tool_name: required_text(payload, "name")?,
                            status,
                        }],
                        OmissionCounts::default(),
                    ))
                }
                Audience::Owner => Projection::Owner(OwnerProjection::new(
                    self.provider,
                    vec![OwnerRecord::ToolCall {
                        call_id: required_id(payload, "call_id")?,
                        tool_name: required_text(payload, "name")?,
                        status: codex_tool_status(payload)?,
                        input_json: payload
                            .get("input")
                            .map_or_else(|| "null".to_owned(), owner_input_json),
                    }],
                )),
            }),
            "custom_tool_call_output" => {
                let native_record_id = required_id(payload, "id")?;
                let call_id = required_id(payload, "call_id")?;
                let output = payload
                    .get("output")
                    .and_then(JsonValue::as_array)
                    .ok_or(UnavailableReason::UnsupportedProviderShape)?;
                if output.is_empty() {
                    return Err(UnavailableReason::UnsupportedProviderShape);
                }
                if audience == Audience::Peer && output.len() > MAX_PROJECTED_BLOCKS {
                    return Err(UnavailableReason::TooManyProjectedBlocks);
                }
                let mut peer =
                    (audience == Audience::Peer).then(|| Vec::with_capacity(output.len()));
                let mut owner =
                    (audience == Audience::Owner).then(|| Vec::with_capacity(output.len()));
                for (index, block) in output.iter().enumerate() {
                    if block.get("type").and_then(JsonValue::as_str) != Some("input_text") {
                        return Err(UnavailableReason::UnsupportedProviderShape);
                    }
                    let text = required_text(block, "text")?;
                    match audience {
                        Audience::Peer => {
                            peer.as_mut()
                                .expect("peer vector")
                                .push(PeerRecord::ToolResult {
                                    identity: identity(
                                        native_record_id.clone(),
                                        None,
                                        index_u16(index)?,
                                        range.clone(),
                                    ),
                                    call_id: call_id.clone(),
                                    text,
                                    status: ToolStatus::Completed,
                                })
                        }
                        Audience::Owner => {
                            owner
                                .as_mut()
                                .expect("owner vector")
                                .push(OwnerRecord::ToolResult {
                                    call_id: call_id.clone(),
                                    status: ToolStatus::Completed,
                                    text,
                                })
                        }
                    }
                }
                Ok(match audience {
                    Audience::Peer => Projection::Peer(PeerProjection::new(
                        self.provider,
                        peer.expect("peer vector"),
                        OmissionCounts::default(),
                    )),
                    Audience::Owner => Projection::Owner(OwnerProjection::new(
                        self.provider,
                        owner.expect("owner vector"),
                    )),
                })
            }
            "reasoning" => Ok(match audience {
                Audience::Peer => {
                    let mut omissions = OmissionCounts::default();
                    omissions
                        .omit_private_reasoning()
                        .map_err(|_| UnavailableReason::ResourceLimit)?;
                    omissions
                        .omit_provider_record()
                        .map_err(|_| UnavailableReason::ResourceLimit)?;
                    Projection::Peer(PeerProjection::new(self.provider, Vec::new(), omissions))
                }
                Audience::Owner => {
                    Projection::Owner(OwnerProjection::new(self.provider, Vec::new()))
                }
            }),
            _ => Err(UnavailableReason::UnsupportedProviderShape),
        }
    }

    fn codex_message(
        &self,
        payload: &JsonValue,
        range: ByteRange,
        audience: Audience,
    ) -> Result<Projection, UnavailableReason> {
        let role = payload
            .get("role")
            .and_then(JsonValue::as_str)
            .ok_or(UnavailableReason::UnsupportedProviderShape)?;
        if matches!(role, "developer" | "system") {
            return Ok(match audience {
                Audience::Peer => {
                    let mut omissions = OmissionCounts::default();
                    omissions
                        .omit_instruction()
                        .map_err(|_| UnavailableReason::ResourceLimit)?;
                    Projection::Peer(PeerProjection::new(self.provider, Vec::new(), omissions))
                }
                Audience::Owner => {
                    Projection::Owner(OwnerProjection::new(self.provider, Vec::new()))
                }
            });
        }
        let native_record_id = required_id(payload, "id")?;
        let content = payload
            .get("content")
            .and_then(JsonValue::as_array)
            .ok_or(UnavailableReason::UnsupportedProviderShape)?;
        if audience == Audience::Peer && content.len() > MAX_PROJECTED_BLOCKS {
            return Err(UnavailableReason::TooManyProjectedBlocks);
        }
        let phase = match role {
            "user" => AssistantPhase::Unspecified,
            "assistant" => match payload.get("phase").and_then(JsonValue::as_str) {
                Some("commentary") => AssistantPhase::Commentary,
                Some("final_answer") => AssistantPhase::FinalAnswer,
                _ => return Err(UnavailableReason::UnsupportedProviderShape),
            },
            _ => return Err(UnavailableReason::UnsupportedProviderShape),
        };
        let expected_block = if role == "user" {
            "input_text"
        } else {
            "output_text"
        };
        let mut peer = (audience == Audience::Peer).then(|| Vec::with_capacity(content.len()));
        let mut owner = (audience == Audience::Owner).then(|| Vec::with_capacity(content.len()));
        for (index, block) in content.iter().enumerate() {
            if block.get("type").and_then(JsonValue::as_str) != Some(expected_block) {
                return Err(UnavailableReason::UnsupportedProviderShape);
            }
            let text = required_text(block, "text")?;
            match audience {
                Audience::Peer => {
                    let identity = identity(
                        native_record_id.clone(),
                        None,
                        index_u16(index)?,
                        range.clone(),
                    );
                    let record = if role == "user" {
                        PeerRecord::UserText { identity, text }
                    } else {
                        PeerRecord::AssistantText {
                            identity,
                            phase,
                            text,
                        }
                    };
                    peer.as_mut().expect("peer vector").push(record);
                }
                Audience::Owner => {
                    let record = if role == "user" {
                        OwnerRecord::UserText { text }
                    } else {
                        OwnerRecord::AssistantText { text }
                    };
                    owner.as_mut().expect("owner vector").push(record);
                }
            }
        }
        Ok(match audience {
            Audience::Peer => Projection::Peer(PeerProjection::new(
                self.provider,
                peer.expect("peer vector"),
                OmissionCounts::default(),
            )),
            Audience::Owner => Projection::Owner(OwnerProjection::new(
                self.provider,
                owner.expect("owner vector"),
            )),
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Audience {
    Peer,
    Owner,
}

enum Projection {
    Peer(PeerProjection),
    Owner(OwnerProjection),
}

fn identity(
    native_record_id: NativeId,
    native_response_id: Option<NativeId>,
    block_index: Option<u16>,
    source: ByteRange,
) -> RecordIdentity {
    RecordIdentity::new(
        native_record_id,
        native_response_id,
        block_index,
        None,
        source,
    )
}

fn nested_identity(
    native_record_id: NativeId,
    native_response_id: Option<NativeId>,
    block_index: Option<u16>,
    subblock_index: Option<u16>,
    source: ByteRange,
) -> RecordIdentity {
    RecordIdentity::new(
        native_record_id,
        native_response_id,
        block_index,
        subblock_index,
        source,
    )
}

fn required_id(value: &JsonValue, field: &str) -> Result<NativeId, UnavailableReason> {
    value
        .get(field)
        .and_then(JsonValue::as_str)
        .ok_or(UnavailableReason::MissingNativeId)
        .and_then(|value| NativeId::new(value).map_err(|_| UnavailableReason::InvalidNativeId))
}

fn required_text(value: &JsonValue, field: &str) -> Result<String, UnavailableReason> {
    value
        .get(field)
        .and_then(JsonValue::as_str)
        .map(str::to_owned)
        .ok_or(UnavailableReason::UnsupportedProviderShape)
}

fn optional_bool(value: &JsonValue, field: &str) -> Result<Option<bool>, UnavailableReason> {
    match value.get(field) {
        None => Ok(None),
        Some(JsonValue::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(UnavailableReason::UnsupportedProviderShape),
    }
}

fn codex_tool_status(value: &JsonValue) -> Result<ToolStatus, UnavailableReason> {
    match value.get("status").and_then(JsonValue::as_str) {
        Some("completed") => Ok(ToolStatus::Completed),
        Some("failed") => Ok(ToolStatus::Failed),
        _ => Err(UnavailableReason::UnsupportedProviderShape),
    }
}

fn result_texts(value: &JsonValue, audience: Audience) -> Result<Vec<String>, UnavailableReason> {
    let content = value
        .get("content")
        .ok_or(UnavailableReason::UnsupportedProviderShape)?;
    if let Some(text) = content.as_str() {
        return Ok(vec![text.to_owned()]);
    }
    let blocks = content
        .as_array()
        .ok_or(UnavailableReason::UnsupportedProviderShape)?;
    if blocks.is_empty() {
        return Err(UnavailableReason::UnsupportedProviderShape);
    }
    if audience == Audience::Peer && blocks.len() > MAX_PROJECTED_BLOCKS {
        return Err(UnavailableReason::TooManyProjectedBlocks);
    }
    blocks
        .iter()
        .map(|block| {
            if block.get("type").and_then(JsonValue::as_str) != Some("text") {
                return Err(UnavailableReason::UnsupportedProviderShape);
            }
            required_text(block, "text")
        })
        .collect()
}

fn ensure_peer_room(current: usize, additional: usize) -> Result<(), UnavailableReason> {
    if current
        .checked_add(additional)
        .is_none_or(|count| count > MAX_PROJECTED_BLOCKS)
    {
        return Err(UnavailableReason::TooManyProjectedBlocks);
    }
    Ok(())
}

fn owner_input_json(value: &JsonValue) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_compact_json(), str::to_owned)
}

fn index_u16(index: usize) -> Result<Option<u16>, UnavailableReason> {
    u16::try_from(index)
        .map(Some)
        .map_err(|_| UnavailableReason::ResourceLimit)
}

fn unavailable(provider: Provider, range: ByteRange, reason: UnavailableReason) -> PeerProjection {
    PeerProjection::new(
        provider,
        vec![PeerRecord::Unavailable {
            source: range,
            reason,
        }],
        OmissionCounts::default(),
    )
}

fn owner_value(value: Value) -> JsonValue {
    match value {
        Value::Null => JsonValue::Null,
        Value::Bool(value) => JsonValue::Bool(value),
        Value::Number(value) => JsonValue::Number(value),
        Value::String(value) => JsonValue::String(value),
        Value::Array(values) => JsonValue::Array(values.into_iter().map(owner_value).collect()),
        Value::Object(values) => JsonValue::Object(
            values
                .into_iter()
                .map(|(name, value)| (name, owner_value(value)))
                .collect(),
        ),
    }
}
