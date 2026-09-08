use std::fmt;
use std::io::{self, Write};

use serde::Serialize;

use crate::{ByteRange, UnavailableReason};

pub const MAX_PROJECTED_BLOCKS: usize = 256;
pub const MAX_ENCODED_PEER_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Claude,
    Codex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityError {
    Empty,
    TooLong,
    InvalidCharacter,
}

impl fmt::Display for IdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for IdentityError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct NativeId(String);

impl NativeId {
    pub fn new(value: impl Into<String>) -> Result<Self, IdentityError> {
        let value = value.into();
        if value.is_empty() {
            return Err(IdentityError::Empty);
        }
        if value.len() > 256 {
            return Err(IdentityError::TooLong);
        }
        if !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b':' | b'.'))
        {
            return Err(IdentityError::InvalidCharacter);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecordIdentity {
    native_record_id: NativeId,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_response_id: Option<NativeId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    block_index: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subblock_index: Option<u16>,
    source: ByteRange,
}

impl RecordIdentity {
    pub(crate) fn new(
        native_record_id: NativeId,
        native_response_id: Option<NativeId>,
        block_index: Option<u16>,
        subblock_index: Option<u16>,
        source: ByteRange,
    ) -> Self {
        Self {
            native_record_id,
            native_response_id,
            block_index,
            subblock_index,
            source,
        }
    }

    pub fn native_record_id(&self) -> &NativeId {
        &self.native_record_id
    }

    pub fn native_response_id(&self) -> Option<&NativeId> {
        self.native_response_id.as_ref()
    }

    pub fn block_index(&self) -> Option<u16> {
        self.block_index
    }

    pub fn subblock_index(&self) -> Option<u16> {
        self.subblock_index
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AssistantPhase {
    Commentary,
    FinalAnswer,
    Unspecified,
}

impl AssistantPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Commentary => "commentary",
            Self::FinalAnswer => "final_answer",
            Self::Unspecified => "unspecified",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PeerRecord {
    UserText {
        identity: RecordIdentity,
        text: String,
    },
    AssistantText {
        identity: RecordIdentity,
        phase: AssistantPhase,
        text: String,
    },
    ToolCall {
        identity: RecordIdentity,
        call_id: NativeId,
        tool_name: String,
        status: ToolStatus,
    },
    ToolResult {
        identity: RecordIdentity,
        call_id: NativeId,
        text: String,
        status: ToolStatus,
    },
    CompactionBoundary {
        identity: RecordIdentity,
        text: String,
    },
    CompactionSummary {
        identity: RecordIdentity,
        text: String,
    },
    Unavailable {
        source: ByteRange,
        reason: UnavailableReason,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum OwnerRecord {
    UserText {
        text: String,
    },
    AssistantText {
        text: String,
    },
    Thinking {
        text: String,
    },
    ToolCall {
        call_id: NativeId,
        tool_name: String,
        status: ToolStatus,
        input_json: String,
    },
    ToolResult {
        call_id: NativeId,
        status: ToolStatus,
        text: String,
    },
    Compaction {
        text: String,
        recap: bool,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct OmissionCounts {
    provider_records: u64,
    blocks: u64,
    private_reasoning_blocks: u64,
    unknown_sensitive_blocks: u64,
    metadata_records: u64,
    instruction_records: u64,
}

impl OmissionCounts {
    pub fn checked_add_assign(&mut self, other: &Self) -> Result<(), OmissionOverflow> {
        macro_rules! add {
            ($field:ident) => {
                self.$field = self
                    .$field
                    .checked_add(other.$field)
                    .ok_or(OmissionOverflow)?;
            };
        }
        add!(provider_records);
        add!(blocks);
        add!(private_reasoning_blocks);
        add!(unknown_sensitive_blocks);
        add!(metadata_records);
        add!(instruction_records);
        Ok(())
    }

    pub fn provider_records(&self) -> u64 {
        self.provider_records
    }
    pub fn blocks(&self) -> u64 {
        self.blocks
    }
    pub fn private_reasoning_blocks(&self) -> u64 {
        self.private_reasoning_blocks
    }
    pub fn unknown_sensitive_blocks(&self) -> u64 {
        self.unknown_sensitive_blocks
    }
    pub fn metadata_records(&self) -> u64 {
        self.metadata_records
    }
    pub fn instruction_records(&self) -> u64 {
        self.instruction_records
    }

    pub(crate) fn omit_provider_record(&mut self) -> Result<(), OmissionOverflow> {
        self.provider_records = self
            .provider_records
            .checked_add(1)
            .ok_or(OmissionOverflow)?;
        Ok(())
    }

    pub(crate) fn omit_private_reasoning(&mut self) -> Result<(), OmissionOverflow> {
        self.blocks = self.blocks.checked_add(1).ok_or(OmissionOverflow)?;
        self.private_reasoning_blocks = self
            .private_reasoning_blocks
            .checked_add(1)
            .ok_or(OmissionOverflow)?;
        Ok(())
    }

    pub(crate) fn omit_unknown_sensitive(&mut self) -> Result<(), OmissionOverflow> {
        self.blocks = self.blocks.checked_add(1).ok_or(OmissionOverflow)?;
        self.unknown_sensitive_blocks = self
            .unknown_sensitive_blocks
            .checked_add(1)
            .ok_or(OmissionOverflow)?;
        Ok(())
    }

    pub(crate) fn omit_metadata(&mut self) -> Result<(), OmissionOverflow> {
        self.metadata_records = self
            .metadata_records
            .checked_add(1)
            .ok_or(OmissionOverflow)?;
        self.omit_provider_record()
    }

    pub(crate) fn omit_instruction(&mut self) -> Result<(), OmissionOverflow> {
        self.instruction_records = self
            .instruction_records
            .checked_add(1)
            .ok_or(OmissionOverflow)?;
        self.omit_provider_record()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OmissionOverflow;

impl fmt::Display for OmissionOverflow {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("omission counter overflow")
    }
}

impl std::error::Error for OmissionOverflow {}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PeerProjection {
    provider: Provider,
    records: Vec<PeerRecord>,
    omissions: OmissionCounts,
}

impl PeerProjection {
    pub fn records(&self) -> &[PeerRecord] {
        &self.records
    }
    pub fn omissions(&self) -> &OmissionCounts {
        &self.omissions
    }

    pub fn provider(&self) -> Provider {
        self.provider
    }

    pub(crate) fn new(
        provider: Provider,
        records: Vec<PeerRecord>,
        omissions: OmissionCounts,
    ) -> Self {
        Self {
            provider,
            records,
            omissions,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OwnerProjection {
    provider: Provider,
    records: Vec<OwnerRecord>,
}

impl OwnerProjection {
    pub fn provider(&self) -> Provider {
        self.provider
    }
    pub(crate) fn new(provider: Provider, records: Vec<OwnerRecord>) -> Self {
        Self { provider, records }
    }
    pub fn records(&self) -> &[OwnerRecord] {
        &self.records
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PeerBatch {
    projections: Vec<PeerProjection>,
    #[serde(skip)]
    encoded_len: usize,
    #[serde(skip)]
    projected_blocks: usize,
}

impl PeerBatch {
    pub fn new() -> Self {
        Self {
            projections: Vec::new(),
            encoded_len: br#"{"projections":[]}"#.len(),
            projected_blocks: 0,
        }
    }
    pub fn try_push(&mut self, projection: PeerProjection) -> PeerBatchPush {
        let next_blocks = match self.projected_blocks.checked_add(projection.records.len()) {
            Some(value) => value,
            None => return PeerBatchPush::Full(projection),
        };
        if next_blocks > MAX_PROJECTED_BLOCKS {
            return PeerBatchPush::Full(projection);
        }
        let mut counter = EncodedLength::default();
        let projection_len = match serde_json::to_writer(&mut counter, &projection) {
            Ok(()) => counter.0,
            Err(_) => return PeerBatchPush::Full(projection),
        };
        let separator = usize::from(!self.projections.is_empty());
        let next_len = match self
            .encoded_len
            .checked_add(separator)
            .and_then(|value| value.checked_add(projection_len))
        {
            Some(value) => value,
            None => return PeerBatchPush::Full(projection),
        };
        if next_len > MAX_ENCODED_PEER_BYTES {
            return PeerBatchPush::Full(projection);
        }
        self.projections.push(projection);
        self.encoded_len = next_len;
        self.projected_blocks = next_blocks;
        PeerBatchPush::Accepted
    }
    pub fn encoded_len(&self) -> usize {
        self.encoded_len
    }
    pub fn projected_blocks(&self) -> usize {
        self.projected_blocks
    }
    pub fn projections(&self) -> &[PeerProjection] {
        &self.projections
    }
}

impl Default for PeerBatch {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum PeerBatchPush {
    Accepted,
    Full(PeerProjection),
}

#[derive(Default)]
struct EncodedLength(usize);

impl Write for EncodedLength {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::other("encoded length overflow"))?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
