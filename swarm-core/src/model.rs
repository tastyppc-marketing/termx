use std::collections::BTreeSet;

use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};

use crate::error::ValidationError;

pub const MAX_LABEL_BYTES: usize = 256;
pub const MAX_METADATA_BYTES: usize = 4 * 1024;
pub const MAX_CLIENT_KEY_BYTES: usize = 256;
pub const MAX_TOPIC_BYTES: usize = 512;
pub const MAX_MESSAGE_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_CANONICAL_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_RECIPIENTS_PER_MESSAGE: usize = 4096;

pub fn sqlite_i64(field: &'static str, value: u64) -> Result<i64, ValidationError> {
    i64::try_from(value).map_err(|_| ValidationError::IntegerRange { field })
}

macro_rules! opaque_id {
    ($name:ident, $prefix:literal) => {
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn generate() -> Self {
                let mut bytes = [0_u8; 16];
                OsRng.fill_bytes(&mut bytes);
                let mut value = String::with_capacity($prefix.len() + 32);
                value.push_str($prefix);
                for byte in bytes {
                    use std::fmt::Write as _;
                    write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
                }
                Self(value)
            }

            pub fn parse(value: &str) -> Result<Self, ValidationError> {
                let suffix = value
                    .strip_prefix($prefix)
                    .ok_or(ValidationError::InvalidId {
                        kind: stringify!($name),
                    })?;
                if suffix.len() != 32 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    return Err(ValidationError::InvalidId {
                        kind: stringify!($name),
                    });
                }
                Ok(Self(value.to_ascii_lowercase()))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::parse(&value).map_err(serde::de::Error::custom)
            }
        }
    };
}

opaque_id!(AuthorityId, "a_");
opaque_id!(PeerId, "p_");
opaque_id!(LaunchId, "l_");
opaque_id!(GroupId, "g_");
opaque_id!(MessageId, "m_");
opaque_id!(DeliveryAttemptId, "d_");
opaque_id!(SourceReferenceId, "s_");
opaque_id!(MailboxCursor, "c_");

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct Revision(u64);

impl Revision {
    pub fn new(value: u64) -> Result<Self, ValidationError> {
        if value == 0 {
            return Err(ValidationError::Empty { field: "revision" });
        }
        sqlite_i64("revision", value)?;
        Ok(Self(value))
    }

    pub fn get(self) -> u64 {
        self.0
    }

    pub fn as_sql_i64(self) -> i64 {
        i64::try_from(self.0).expect("validated revision fits in i64")
    }
}

impl<'de> Deserialize<'de> for Revision {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = u64::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug)]
pub struct OwnerPrincipal {
    pub(crate) authority_id: AuthorityId,
}

impl OwnerPrincipal {
    pub(crate) fn new(authority_id: AuthorityId) -> Self {
        Self { authority_id }
    }

    pub fn authority_id(&self) -> &AuthorityId {
        &self.authority_id
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeerPrincipal {
    pub(crate) authority_id: AuthorityId,
    pub(crate) peer_id: PeerId,
    pub(crate) binding_revision: Revision,
}

impl PeerPrincipal {
    pub(crate) fn new(
        authority_id: AuthorityId,
        peer_id: PeerId,
        binding_revision: Revision,
    ) -> Self {
        Self {
            authority_id,
            peer_id,
            binding_revision,
        }
    }

    pub fn peer_id(&self) -> &PeerId {
        &self.peer_id
    }

    pub fn binding_revision(&self) -> Revision {
        self.binding_revision
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SendMessageRequest {
    pub group_id: GroupId,
    pub client_key: String,
    pub recipients: BTreeSet<PeerId>,
    pub body: String,
    pub topic: Option<String>,
    pub reply_to: Option<MessageId>,
}

/// Process identity evidence accepted by the trusted broker boundary.
///
/// This type deliberately has no `Deserialize` implementation. `trusted` is a
/// library entry point for a caller that has already authenticated the native
/// process; constructing this value does not itself verify a process.
#[derive(Clone, Debug)]
pub struct VerifiedBinding {
    pub(crate) launch_id: LaunchId,
    pub(crate) terminal_id: String,
    pub(crate) harness: String,
    pub(crate) conversation_id: String,
    pub(crate) model_metadata: Option<String>,
    pub(crate) process_id: u32,
    pub(crate) process_creation_filetime: u64,
    pub(crate) is_live: bool,
}

impl VerifiedBinding {
    #[allow(clippy::too_many_arguments)]
    pub fn trusted(
        launch_id: String,
        terminal_id: String,
        harness: String,
        conversation_id: String,
        model_metadata: Option<String>,
        process_id: u32,
        process_creation_filetime: u64,
        is_live: bool,
    ) -> Result<Self, ValidationError> {
        let value = Self {
            launch_id: LaunchId::parse(&launch_id)?,
            terminal_id,
            harness,
            conversation_id,
            model_metadata,
            process_id,
            process_creation_filetime,
            is_live,
        };
        value.validate()?;
        Ok(value)
    }

    fn validate(&self) -> Result<(), ValidationError> {
        validate_nonempty("terminal_id", &self.terminal_id, MAX_METADATA_BYTES)?;
        validate_nonempty("harness", &self.harness, MAX_LABEL_BYTES)?;
        validate_nonempty("conversation_id", &self.conversation_id, MAX_METADATA_BYTES)?;
        sqlite_i64("process_creation_filetime", self.process_creation_filetime)?;
        if let Some(metadata) = &self.model_metadata {
            validate_max("model_metadata", metadata, MAX_METADATA_BYTES)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeerMetadataUpdate {
    pub model_metadata: Option<String>,
    pub is_live: bool,
}

impl PeerMetadataUpdate {
    pub(crate) fn validate(&self) -> Result<(), ValidationError> {
        if let Some(metadata) = &self.model_metadata {
            validate_max("model_metadata", metadata, MAX_METADATA_BYTES)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnrolledPeer {
    pub record: PeerBindingRecord,
    pub principal: PeerPrincipal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrozenRecipient {
    pub peer_id: PeerId,
    pub binding_revision: Revision,
    pub generation: Revision,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendReceipt {
    pub message_id: MessageId,
    pub group_id: GroupId,
    pub group_sequence: u64,
    pub sender_peer_id: PeerId,
    pub sender_binding_revision: Revision,
    pub recipients: Vec<FrozenRecipient>,
    pub committed_at_millis: i64,
    pub outcome: MessageCommitOutcome,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageCommitOutcome {
    Saved,
}

pub const MAX_MAILBOX_PAGE_ITEMS: usize = 128;
pub const MAX_MAILBOX_PAGE_BYTES: usize = MAX_CANONICAL_PAYLOAD_BYTES;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MailboxPageRequest {
    pub group_id: GroupId,
    pub cursor: Option<MailboxCursor>,
    pub max_items: usize,
}

impl MailboxPageRequest {
    pub(crate) fn validate(&self) -> Result<(), ValidationError> {
        if self.max_items == 0 {
            return Err(ValidationError::Empty { field: "max_items" });
        }
        if self.max_items > MAX_MAILBOX_PAGE_ITEMS {
            return Err(ValidationError::TooLarge {
                field: "max_items",
                max: MAX_MAILBOX_PAGE_ITEMS,
            });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailboxEntry {
    pub message: MessageRecord,
    pub receipt: ReceiptRecord,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailboxPage {
    pub messages: Vec<MailboxEntry>,
    pub next_cursor: Option<MailboxCursor>,
    pub snapshot_high_sequence: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcknowledgementResult {
    pub message_id: MessageId,
    pub generation: Revision,
    pub acknowledged_at_millis: i64,
    pub contiguous_group_sequence: u64,
}

impl SendMessageRequest {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_nonempty("client_key", &self.client_key, MAX_CLIENT_KEY_BYTES)?;
        if self.recipients.is_empty() {
            return Err(ValidationError::Empty {
                field: "recipients",
            });
        }
        if self.recipients.len() > MAX_RECIPIENTS_PER_MESSAGE {
            return Err(ValidationError::TooLarge {
                field: "recipients",
                max: MAX_RECIPIENTS_PER_MESSAGE,
            });
        }
        validate_nonempty("body", &self.body, MAX_MESSAGE_BODY_BYTES)?;
        if let Some(topic) = &self.topic {
            validate_nonempty("topic", topic, MAX_TOPIC_BYTES)?;
        }
        self.canonical_json()?;
        Ok(())
    }

    pub fn canonical_json(&self) -> Result<Vec<u8>, ValidationError> {
        let encoded = serde_json::to_vec(self)
            .map_err(|error| ValidationError::CanonicalSerialization(error.to_string()))?;
        if encoded.len() > MAX_CANONICAL_PAYLOAD_BYTES {
            return Err(ValidationError::TooLong {
                field: "canonical_payload",
                max: MAX_CANONICAL_PAYLOAD_BYTES,
            });
        }
        Ok(encoded)
    }
}

impl PeerBindingRecord {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_nonempty("terminal_id", &self.terminal_id, MAX_METADATA_BYTES)?;
        validate_nonempty("harness", &self.harness, MAX_LABEL_BYTES)?;
        validate_nonempty("conversation_id", &self.conversation_id, MAX_METADATA_BYTES)?;
        sqlite_i64("process_creation_filetime", self.process_creation_filetime)?;
        if let Some(metadata) = &self.model_metadata {
            validate_max("model_metadata", metadata, MAX_METADATA_BYTES)?;
        }
        Ok(())
    }
}

impl GroupRecord {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_nonempty("label", &self.label, MAX_LABEL_BYTES)
    }
}

impl MessageRecord {
    pub fn validate(&self) -> Result<(), ValidationError> {
        sqlite_i64("group_sequence", self.group_sequence)?;
        validate_nonempty("client_key", &self.client_key, MAX_CLIENT_KEY_BYTES)?;
        validate_nonempty("body", &self.body, MAX_MESSAGE_BODY_BYTES)?;
        if let Some(topic) = &self.topic {
            validate_nonempty("topic", topic, MAX_TOPIC_BYTES)?;
        }
        Ok(())
    }
}

impl DeliveryAttemptRecord {
    pub fn validate(&self) -> Result<(), ValidationError> {
        sqlite_i64("attempt_number", self.attempt_number)?;
        if let Some(outcome) = &self.outcome {
            validate_max("outcome", outcome, MAX_METADATA_BYTES)?;
        }
        Ok(())
    }
}

impl SourceReferenceRecord {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_nonempty("source_kind", &self.source_kind, MAX_LABEL_BYTES)?;
        validate_nonempty(
            "opaque_reference",
            &self.opaque_reference,
            MAX_METADATA_BYTES,
        )
    }
}

fn validate_nonempty(field: &'static str, value: &str, max: usize) -> Result<(), ValidationError> {
    if value.is_empty() {
        return Err(ValidationError::Empty { field });
    }
    if value.len() > max {
        return Err(ValidationError::TooLong { field, max });
    }
    Ok(())
}

fn validate_max(field: &'static str, value: &str, max: usize) -> Result<(), ValidationError> {
    if value.len() > max {
        return Err(ValidationError::TooLong { field, max });
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerBindingRecord {
    pub peer_id: PeerId,
    pub revision: Revision,
    pub launch_id: LaunchId,
    pub terminal_id: String,
    pub harness: String,
    pub conversation_id: String,
    pub model_metadata: Option<String>,
    pub process_id: u32,
    pub process_creation_filetime: u64,
    pub is_live: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupRecord {
    pub group_id: GroupId,
    pub policy_revision: Revision,
    pub label: String,
    pub paused: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageRecord {
    pub message_id: MessageId,
    pub group_id: GroupId,
    pub group_sequence: u64,
    pub sender_peer_id: PeerId,
    pub sender_binding_revision: Revision,
    pub client_key: String,
    pub body: String,
    pub topic: Option<String>,
    pub reply_to: Option<MessageId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeliveryRecord {
    pub message_id: MessageId,
    pub recipient_peer_id: PeerId,
    pub recipient_binding_revision: Revision,
    pub fetched_generation: Option<Revision>,
    pub acknowledged_generation: Option<Revision>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceiptRecord {
    pub message_id: MessageId,
    pub recipient_peer_id: PeerId,
    pub binding_revision: Revision,
    pub generation: Revision,
    pub fetched_at_millis: Option<i64>,
    pub acknowledged_at_millis: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeliveryAttemptRecord {
    pub attempt_id: DeliveryAttemptId,
    pub message_id: MessageId,
    pub recipient_peer_id: PeerId,
    pub binding_revision: Revision,
    pub generation: Revision,
    pub attempt_number: u64,
    pub outcome: Option<String>,
}

#[derive(Clone, Debug)]
pub struct SourceReferenceRecord {
    pub source_reference_id: SourceReferenceId,
    pub message_id: MessageId,
    pub source_kind: String,
    pub(crate) opaque_reference: String,
}
