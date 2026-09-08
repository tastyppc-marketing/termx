use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

use crate::error::{StoreError, ValidationError};
use crate::model::{
    AcknowledgementResult, AttachmentRecord, AuthorityId, GroupId, MailboxAfterRequest,
    MailboxCursor, MailboxEntry, MailboxNavigation, MailboxPage, MailboxPageRequest, MessageId,
    MessageRecord, PeerId, PeerPrincipal, ReceiptRecord, Revision, SourceId, SourceReferenceId,
    MAX_MAILBOX_PAGE_BYTES,
};

use super::policy::revision_from_sql;
use super::revision::bump_delivery;
use super::{authorize_peer, now_millis, Store};

const CURSOR_LIFETIME_MILLIS: i64 = 24 * 60 * 60 * 1000;

/// Cursor families. A cursor continues exactly the read kind and selector that
/// produced it; every other use is a scope error, never a silent reposition.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ReadKind {
    Mailbox,
    Thread,
    Outgoing,
}

impl ReadKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Mailbox => "mailbox",
            Self::Thread => "thread",
            Self::Outgoing => "outgoing",
        }
    }
}

/// Where a bounded read starts. `Fresh` and `After` freeze a new watermark;
/// `Cursor` continues a frozen one. A position is navigation only.
pub(super) enum InboxStart {
    Fresh,
    After(u64),
    Cursor(MailboxCursor),
}

impl From<MailboxNavigation> for InboxStart {
    fn from(navigation: MailboxNavigation) -> Self {
        match navigation {
            MailboxNavigation::After { after_sequence } => Self::After(after_sequence),
            MailboxNavigation::Cursor(cursor) => Self::Cursor(cursor),
        }
    }
}

pub(super) struct Frozen {
    pub snapshot_high: i64,
    pub position: i64,
}

impl Store {
    pub fn read_mailbox(
        &mut self,
        principal: &PeerPrincipal,
        request: MailboxPageRequest,
    ) -> Result<MailboxPage, StoreError> {
        request.validate()?;
        let start = request.cursor.map_or(InboxStart::Fresh, InboxStart::Cursor);
        self.read_inbox(principal, &request.group_id, start, request.max_items)
    }

    /// Mailbox read from an explicit position or an existing mailbox cursor.
    /// Identical projection and fetch evidence to `read_mailbox`; the position
    /// never acknowledges, never fetches and never moves a cursor backwards.
    pub fn read_mailbox_after(
        &mut self,
        principal: &PeerPrincipal,
        request: MailboxAfterRequest,
    ) -> Result<MailboxPage, StoreError> {
        request.validate()?;
        self.read_inbox(
            principal,
            &request.group_id,
            InboxStart::from(request.navigation),
            request.max_items,
        )
    }

    fn read_inbox(
        &mut self,
        principal: &PeerPrincipal,
        group_id: &GroupId,
        start: InboxStart,
        max_items: usize,
    ) -> Result<MailboxPage, StoreError> {
        let authority_id = self.authority_id.clone();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let authorized = authorize_peer(&transaction, &authority_id, principal, group_id)?;
        let frozen = resolve_navigation(
            &transaction,
            &authority_id,
            principal,
            group_id,
            authorized.policy_revision,
            ReadKind::Mailbox,
            None,
            &start,
        )?;
        let now = now_millis(&transaction)?;
        // Mailbox history includes every exact current delivery, including
        // acknowledged rows and retained v2 sender/self rows which are
        // intentionally absent from ACK ordering.
        let mut statement = transaction.prepare(
            "SELECT m.message_id,m.group_sequence,m.sender_peer_id,m.sender_binding_revision,m.client_key,m.body,m.topic,m.reply_to_message_id,d.delivery_generation,a.fetched_at_millis,a.acknowledged_at_millis FROM current_deliveries d INDEXED BY current_delivery_mailbox JOIN messages m ON m.message_id=d.message_id LEFT JOIN acknowledgements a ON a.message_id=d.message_id AND a.recipient_peer_id=d.recipient_peer_id AND a.binding_revision=d.recipient_binding_revision AND a.generation=d.delivery_generation WHERE d.group_id=?1 AND d.recipient_peer_id=?2 AND d.recipient_binding_revision=?3 AND d.group_sequence>?4 AND d.group_sequence<=?5 AND m.group_id=d.group_id AND m.group_sequence=d.group_sequence ORDER BY d.group_sequence LIMIT ?6",
        )?;
        let mut rows = statement.query_map(
            params![
                group_id.as_str(),
                principal.peer_id.as_str(),
                principal.binding_revision.as_sql_i64(),
                frozen.position,
                frozen.snapshot_high,
                page_limit(max_items),
            ],
            |row| {
                Ok((
                    message_row(row)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                    row.get::<_, Option<i64>>(10)?,
                ))
            },
        )?;
        let mut messages = Vec::new();
        let sizing_cursor = MailboxCursor::generate();
        // IDs have fixed serialized length. Reserve the same full Some(cursor)
        // envelope as before, even when this ultimately becomes the last page.
        let mut sizing = super::page_size::PageSize::new(&MailboxPage {
            messages: Vec::new(),
            next_cursor: Some(sizing_cursor),
            snapshot_high_sequence: sequence_from_sql(frozen.snapshot_high)?,
        })?;
        let mut more_exists = false;
        let mut newly_fetched = 0_usize;
        for row in &mut rows {
            if messages.len() == max_items {
                more_exists = true;
                break;
            }
            let (message, generation, fetched_at, acknowledged_at) = row?;
            let message = message_record(&transaction, group_id, &message)?;
            let mut entry = MailboxEntry {
                receipt: ReceiptRecord {
                    message_id: message.message_id.clone(),
                    recipient_peer_id: principal.peer_id.clone(),
                    binding_revision: principal.binding_revision,
                    generation: revision_from_sql(generation)?,
                    fetched_at_millis: fetched_at,
                    acknowledged_at_millis: acknowledged_at,
                },
                message,
            };
            let fresh = entry.receipt.fetched_at_millis.is_none();
            if fresh {
                entry.receipt.fetched_at_millis = Some(now);
            }
            let page_bytes = sizing.with_entry(&entry)?;
            if page_bytes > MAX_MAILBOX_PAGE_BYTES {
                if messages.is_empty() {
                    return Err(StoreError::PageItemTooLarge);
                }
                more_exists = true;
                break;
            }
            sizing.accept(page_bytes);
            newly_fetched += usize::from(fresh);
            messages.push(entry);
        }
        drop(rows);
        drop(statement);
        for entry in &messages {
            mark_fetched(&transaction, principal, &entry.message.message_id, now)?;
        }
        if newly_fetched > 0 {
            bump_delivery(&transaction)?;
        }
        let last_position = messages
            .last()
            .map_or(frozen.position, |entry| entry.message.group_sequence as i64);
        let next_cursor = if more_exists {
            Some(insert_cursor(
                &transaction,
                &authority_id,
                principal,
                group_id,
                authorized.policy_revision,
                ReadKind::Mailbox,
                None,
                frozen.snapshot_high,
                last_position,
                now,
            )?)
        } else {
            None
        };
        transaction.commit()?;
        Ok(MailboxPage {
            messages,
            next_cursor,
            snapshot_high_sequence: sequence_from_sql(frozen.snapshot_high)?,
        })
    }

    pub fn acknowledge_message(
        &mut self,
        principal: &PeerPrincipal,
        group_id: &GroupId,
        message_id: &MessageId,
    ) -> Result<AcknowledgementResult, StoreError> {
        let authority_id = self.authority_id.clone();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        authorize_peer(&transaction, &authority_id, principal, group_id)?;
        let delivery = transaction
            .query_row(
                "SELECT generation FROM recipient_ack_order WHERE message_id=?1 AND recipient_peer_id=?2 AND binding_revision=?3 AND group_id=?4",
                params![message_id.as_str(), principal.peer_id.as_str(), principal.binding_revision.as_sql_i64(), group_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .ok_or(StoreError::Unauthorized {
                reason: "message is not an eligible delivery for this peer",
            })?;
        let generation = delivery;
        let now = now_millis(&transaction)?;
        transaction.execute(
            "INSERT INTO acknowledgements(message_id,recipient_peer_id,binding_revision,generation,acknowledged_at_millis) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(message_id,recipient_peer_id,binding_revision,generation) DO UPDATE SET acknowledged_at_millis=COALESCE(acknowledgements.acknowledged_at_millis,excluded.acknowledged_at_millis)",
            params![message_id.as_str(), principal.peer_id.as_str(), principal.binding_revision.as_sql_i64(), generation, now],
        )?;
        transaction.execute(
            "UPDATE current_deliveries SET acknowledged_generation=?1, acknowledged_at_millis=COALESCE(acknowledged_at_millis,?2) WHERE message_id=?3 AND recipient_peer_id=?4",
            params![generation, now, message_id.as_str(), principal.peer_id.as_str()],
        )?;
        transaction.execute(
            "UPDATE recipient_ack_order SET acknowledged=1 WHERE message_id=?1 AND recipient_peer_id=?2 AND binding_revision=?3 AND generation=?4",
            params![message_id.as_str(), principal.peer_id.as_str(), principal.binding_revision.as_sql_i64(), generation],
        )?;
        let acknowledged_at = transaction.query_row(
            "SELECT acknowledged_at_millis FROM acknowledgements WHERE message_id=?1 AND recipient_peer_id=?2 AND binding_revision=?3 AND generation=?4",
            params![message_id.as_str(), principal.peer_id.as_str(), principal.binding_revision.as_sql_i64(), generation],
            |row| row.get::<_, i64>(0),
        )?;
        let contiguous = acknowledgement_watermark(&transaction, group_id, principal, now)?;
        bump_delivery(&transaction)?;
        let result = AcknowledgementResult {
            message_id: message_id.clone(),
            generation: revision_from_sql(generation)?,
            acknowledged_at_millis: acknowledged_at,
            contiguous_group_sequence: contiguous,
        };
        transaction.commit()?;
        Ok(result)
    }
}

/// Exactly `max_items + 1` rows: one extra row proves a further page exists
/// without scanning beyond it.
pub(super) fn page_limit(max_items: usize) -> i64 {
    i64::try_from(max_items + 1).expect("bounded page limit fits i64")
}

pub(super) fn sequence_from_sql(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value).map_err(|_| StoreError::InvalidCursor)
}

/// Frozen watermark and starting position for one exact read scope.
#[allow(clippy::too_many_arguments)]
pub(super) fn resolve_navigation(
    transaction: &Transaction<'_>,
    authority_id: &AuthorityId,
    principal: &PeerPrincipal,
    group_id: &GroupId,
    policy_revision: Revision,
    kind: ReadKind,
    selector: Option<&str>,
    start: &InboxStart,
) -> Result<Frozen, StoreError> {
    match start {
        InboxStart::Cursor(cursor) => load_cursor(
            transaction,
            authority_id,
            principal,
            group_id,
            policy_revision,
            kind,
            selector,
            cursor,
        ),
        InboxStart::Fresh | InboxStart::After(_) => {
            let next_sequence = transaction.query_row(
                "SELECT next_sequence FROM groups WHERE group_id=?1",
                [group_id.as_str()],
                |row| row.get::<_, i64>(0),
            )?;
            let snapshot_high = next_sequence - 1;
            let position = match start {
                InboxStart::After(after) => {
                    let position =
                        i64::try_from(*after).map_err(|_| ValidationError::IntegerRange {
                            field: "after_sequence",
                        })?;
                    if position > snapshot_high {
                        return Err(StoreError::InvalidPosition {
                            position: *after,
                            snapshot_high: sequence_from_sql(snapshot_high)?,
                        });
                    }
                    position
                }
                _ => 0,
            };
            Ok(Frozen {
                snapshot_high,
                position,
            })
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn insert_cursor(
    transaction: &Transaction<'_>,
    authority_id: &AuthorityId,
    principal: &PeerPrincipal,
    group_id: &GroupId,
    policy_revision: Revision,
    kind: ReadKind,
    selector: Option<&str>,
    snapshot_high: i64,
    position: i64,
    now: i64,
) -> Result<MailboxCursor, StoreError> {
    let cursor = MailboxCursor::generate();
    transaction.execute(
        "INSERT INTO mailbox_cursors(cursor_id,authority_id,group_id,peer_id,binding_revision,policy_revision,snapshot_high_sequence,position_sequence,created_at_millis,expires_at_millis,read_kind,selector) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            cursor.as_str(),
            authority_id.as_str(),
            group_id.as_str(),
            principal.peer_id.as_str(),
            principal.binding_revision.as_sql_i64(),
            policy_revision.as_sql_i64(),
            snapshot_high,
            position,
            now,
            now + CURSOR_LIFETIME_MILLIS,
            kind.as_str(),
            selector,
        ],
    )?;
    Ok(cursor)
}

pub(super) type MessageRow = (
    String,
    i64,
    String,
    i64,
    String,
    String,
    Option<String>,
    Option<String>,
);

/// Columns 0..8 of a message projection in the fixed order
/// `message_id,group_sequence,sender_peer_id,sender_binding_revision,client_key,body,topic,reply_to_message_id`.
pub(super) fn message_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MessageRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
    ))
}

pub(super) fn message_record(
    transaction: &Transaction<'_>,
    group_id: &GroupId,
    row: &MessageRow,
) -> Result<MessageRecord, StoreError> {
    let message_id = MessageId::parse(&row.0)?;
    let attachments = load_attachments(transaction, &message_id)?;
    Ok(MessageRecord {
        message_id,
        group_id: group_id.clone(),
        group_sequence: sequence_from_sql(row.1)?,
        sender_peer_id: PeerId::parse(&row.2)?,
        sender_binding_revision: revision_from_sql(row.3)?,
        client_key: row.4.clone(),
        body: row.5.clone(),
        topic: row.6.clone(),
        reply_to: row.7.as_deref().map(MessageId::parse).transpose()?,
        attachments,
    })
}

pub(super) fn load_attachments(
    transaction: &Transaction<'_>,
    message_id: &MessageId,
) -> Result<Vec<AttachmentRecord>, StoreError> {
    let mut statement = transaction.prepare_cached(
        "SELECT source_reference_id,source_id,source_kind,owner_peer_id,snapshot_reference FROM message_source_references WHERE message_id=?1 ORDER BY ordinal",
    )?;
    let attachments = statement
        .query_map([message_id.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?
        .map(|row| {
            let (reference, source, kind, owner, snapshot) = row?;
            Ok(AttachmentRecord {
                source_reference_id: SourceReferenceId::parse(&reference)?,
                source_id: SourceId::parse(&source)?,
                source_kind: kind,
                owner_peer_id: PeerId::parse(&owner)?,
                snapshot_reference: snapshot,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    Ok(attachments)
}

/// Receipt for the caller's exact current-binding delivery of one message, if any.
pub(super) fn load_receipt(
    transaction: &Transaction<'_>,
    principal: &PeerPrincipal,
    message_id: &MessageId,
) -> Result<Option<ReceiptRecord>, StoreError> {
    let row = transaction
        .query_row(
            "SELECT d.delivery_generation,a.fetched_at_millis,a.acknowledged_at_millis FROM current_deliveries d LEFT JOIN acknowledgements a ON a.message_id=d.message_id AND a.recipient_peer_id=d.recipient_peer_id AND a.binding_revision=d.recipient_binding_revision AND a.generation=d.delivery_generation WHERE d.message_id=?1 AND d.recipient_peer_id=?2 AND d.recipient_binding_revision=?3",
            params![
                message_id.as_str(),
                principal.peer_id.as_str(),
                principal.binding_revision.as_sql_i64()
            ],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()?;
    row.map(|(generation, fetched, acknowledged)| {
        Ok(ReceiptRecord {
            message_id: message_id.clone(),
            recipient_peer_id: principal.peer_id.clone(),
            binding_revision: principal.binding_revision,
            generation: revision_from_sql(generation)?,
            fetched_at_millis: fetched,
            acknowledged_at_millis: acknowledged,
        })
    })
    .transpose()
}

#[allow(clippy::too_many_arguments)]
fn load_cursor(
    transaction: &Transaction<'_>,
    authority_id: &AuthorityId,
    principal: &PeerPrincipal,
    group_id: &GroupId,
    policy_revision: Revision,
    kind: ReadKind,
    selector: Option<&str>,
    cursor: &MailboxCursor,
) -> Result<Frozen, StoreError> {
    let row = transaction
        .query_row(
            "SELECT authority_id,group_id,peer_id,binding_revision,policy_revision,snapshot_high_sequence,position_sequence,expires_at_millis,read_kind,selector FROM mailbox_cursors WHERE cursor_id=?1",
            [cursor.as_str()],
            |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,row.get::<_, i64>(3)?,row.get::<_, i64>(4)?,row.get::<_, i64>(5)?,row.get::<_, i64>(6)?,row.get::<_, i64>(7)?,row.get::<_, String>(8)?,row.get::<_, Option<String>>(9)?)),
        )
        .optional()?
        .ok_or(StoreError::InvalidCursor)?;
    if row.0 != authority_id.as_str()
        || row.1 != group_id.as_str()
        || row.2 != principal.peer_id.as_str()
        || row.8 != kind.as_str()
        || row.9.as_deref() != selector
    {
        return Err(StoreError::CursorScope);
    }
    if row.3 != principal.binding_revision.as_sql_i64() || row.4 != policy_revision.as_sql_i64() {
        return Err(StoreError::StaleCursor);
    }
    let now = now_millis(transaction)?;
    if row.7 < now {
        return Err(StoreError::ExpiredCursor);
    }
    Ok(Frozen {
        snapshot_high: row.5,
        position: row.6,
    })
}

pub(super) fn mark_fetched(
    transaction: &Transaction<'_>,
    principal: &PeerPrincipal,
    message_id: &MessageId,
    now: i64,
) -> Result<(), StoreError> {
    let generation = transaction.query_row(
        "SELECT delivery_generation FROM current_deliveries WHERE message_id=?1 AND recipient_peer_id=?2",
        [message_id.as_str(), principal.peer_id.as_str()],
        |row| row.get::<_, i64>(0),
    )?;
    transaction.execute(
        "INSERT INTO acknowledgements(message_id,recipient_peer_id,binding_revision,generation,fetched_at_millis) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(message_id,recipient_peer_id,binding_revision,generation) DO UPDATE SET fetched_at_millis=COALESCE(acknowledgements.fetched_at_millis,excluded.fetched_at_millis)",
        params![message_id.as_str(), principal.peer_id.as_str(), principal.binding_revision.as_sql_i64(), generation, now],
    )?;
    transaction.execute(
        "UPDATE current_deliveries SET fetched_generation=COALESCE(fetched_generation,?1), fetched_at_millis=COALESCE(fetched_at_millis,?2) WHERE message_id=?3 AND recipient_peer_id=?4",
        params![generation, now, message_id.as_str(), principal.peer_id.as_str()],
    )?;
    Ok(())
}

fn acknowledgement_watermark(
    transaction: &Transaction<'_>,
    group_id: &GroupId,
    principal: &PeerPrincipal,
    now: i64,
) -> Result<u64, StoreError> {
    // Receipt generations remain distinct, but a group sequence gap belongs to
    // the whole current binding. Never reuse a historical per-generation bound.
    let current = transaction.query_row(
        "SELECT contiguous_group_sequence FROM binding_acknowledgement_watermarks WHERE group_id=?1 AND recipient_peer_id=?2 AND binding_revision=?3",
        params![group_id.as_str(),principal.peer_id.as_str(),principal.binding_revision.as_sql_i64()],
        |row|row.get::<_,i64>(0),
    ).optional()?.unwrap_or(0);
    let first_unacknowledged = transaction.query_row(
        "SELECT group_sequence FROM recipient_ack_order WHERE group_id=?1 AND recipient_peer_id=?2 AND binding_revision=?3 AND acknowledged=0 AND group_sequence>?4 ORDER BY group_sequence LIMIT 1",
        params![group_id.as_str(),principal.peer_id.as_str(),principal.binding_revision.as_sql_i64(),current],
        |row|row.get::<_,i64>(0),
    ).optional()?;
    let watermark = match first_unacknowledged {
        Some(sequence) => transaction.query_row(
            "SELECT group_sequence FROM recipient_ack_order WHERE group_id=?1 AND recipient_peer_id=?2 AND binding_revision=?3 AND group_sequence>?4 AND group_sequence<?5 ORDER BY group_sequence DESC LIMIT 1",
            params![group_id.as_str(),principal.peer_id.as_str(),principal.binding_revision.as_sql_i64(),current,sequence],
            |row|row.get::<_,i64>(0),
        ).optional()?.unwrap_or(current),
        None => transaction.query_row(
            "SELECT group_sequence FROM recipient_ack_order WHERE group_id=?1 AND recipient_peer_id=?2 AND binding_revision=?3 AND group_sequence>?4 ORDER BY group_sequence DESC LIMIT 1",
            params![group_id.as_str(),principal.peer_id.as_str(),principal.binding_revision.as_sql_i64(),current],
            |row|row.get::<_,i64>(0),
        ).optional()?.unwrap_or(current),
    };
    transaction.execute(
        "INSERT INTO binding_acknowledgement_watermarks(group_id,recipient_peer_id,binding_revision,contiguous_group_sequence,updated_at_millis) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(group_id,recipient_peer_id,binding_revision) DO UPDATE SET contiguous_group_sequence=MAX(binding_acknowledgement_watermarks.contiguous_group_sequence,excluded.contiguous_group_sequence),updated_at_millis=excluded.updated_at_millis",
        params![group_id.as_str(),principal.peer_id.as_str(),principal.binding_revision.as_sql_i64(),watermark,now],
    )?;
    u64::try_from(watermark).map_err(|_| StoreError::InvalidCursor)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use rusqlite::params;

    use crate::model::{GroupId, MessageId, VerifiedBinding};

    use super::Store;

    fn retained_path(name: &str) -> std::path::PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("retired")
            .join("test-artifacts")
            .join("swarm-core")
            .join(format!("{name}-{timestamp}"));
        std::fs::create_dir_all(&directory).unwrap();
        directory.join("swarm.sqlite")
    }

    fn binding(name: &str) -> VerifiedBinding {
        VerifiedBinding::trusted(
            format!(
                "l_{:032x}",
                name.bytes()
                    .fold(0_u128, |value, byte| { value * 257 + u128::from(byte) })
            ),
            format!("terminal-{name}"),
            "codex".to_owned(),
            format!("conversation-{name}"),
            None,
            42,
            4242,
            true,
        )
        .unwrap()
    }

    #[test]
    fn empty_recipient_mailbox_has_bounded_vm_work_amid_other_deliveries() {
        let path = retained_path("sparse-mailbox-vm-bound");
        let mut store = Store::open(path).unwrap();
        let owner = store.trusted_owner();
        let alice = store.enroll_peer(&owner, binding("sparse-alice")).unwrap();
        let bob = store.enroll_peer(&owner, binding("sparse-bob")).unwrap();
        let group = store
            .create_group(
                &owner,
                "sparse",
                BTreeSet::from([alice.record.peer_id.clone(), bob.record.peer_id.clone()]),
            )
            .unwrap();
        seed_acknowledged_prefix(
            &mut store,
            &group.group_id,
            alice.record.peer_id.as_str(),
            bob.record.peer_id.as_str(),
            5_000,
        );
        let plan = {
            let mut statement = store
                .connection
                .prepare(
                    "EXPLAIN QUERY PLAN SELECT m.message_id FROM current_deliveries d INDEXED BY current_delivery_mailbox JOIN messages m ON m.message_id=d.message_id WHERE d.group_id=?1 AND d.recipient_peer_id=?2 AND d.recipient_binding_revision=?3 AND d.group_sequence>?4 AND d.group_sequence<=?5 AND m.group_id=d.group_id AND m.group_sequence=d.group_sequence ORDER BY d.group_sequence LIMIT ?6",
                )
                .unwrap();
            statement
                .query_map(
                    params![
                        group.group_id.as_str(),
                        bob.record.peer_id.as_str(),
                        bob.record.revision.as_sql_i64(),
                        0,
                        5_001,
                        129,
                    ],
                    |row| row.get::<_, String>(3),
                )
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert!(
            plan.iter()
                .any(|detail| detail.contains("current_delivery_mailbox")),
            "mailbox plan did not use complete recipient range index: {plan:?}"
        );
        assert!(
            plan.iter().all(|detail| !detail.contains("TEMP B-TREE")),
            "mailbox plan introduced temporary ordering: {plan:?}"
        );
        let callbacks = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&callbacks);
        store
            .connection
            .progress_handler(
                100,
                Some(move || {
                    counter.fetch_add(1, Ordering::Relaxed);
                    false
                }),
            )
            .unwrap();
        let page = store
            .read_mailbox(
                &bob.principal,
                crate::model::MailboxPageRequest {
                    group_id: group.group_id,
                    cursor: None,
                    max_items: 128,
                },
            )
            .unwrap();
        store
            .connection
            .progress_handler(0, None::<fn() -> bool>)
            .unwrap();
        assert!(page.messages.is_empty() && page.next_cursor.is_none());
        assert_eq!(page.snapshot_high_sequence, 5_001);
        let observed = callbacks.load(Ordering::Relaxed);
        eprintln!("empty sparse mailbox: {observed} callbacks at 100 VM instructions");
        assert!(
            observed <= 10,
            "empty recipient examined unrelated retained history: {observed} callbacks"
        );
    }

    #[test]
    fn in_order_ack_after_large_acknowledged_prefix_has_bounded_vm_work() {
        const ACKNOWLEDGED_PREFIX: i64 = 5_000;
        const PROGRESS_INTERVAL: i32 = 100;
        const MAX_PROGRESS_CALLBACKS: usize = 10;

        let path = retained_path("ack-vm-bound");
        let mut store = Store::open(path).unwrap();
        let owner = store.trusted_owner();
        let alice = store.enroll_peer(&owner, binding("scale-alice")).unwrap();
        let bob = store.enroll_peer(&owner, binding("scale-bob")).unwrap();
        let group = store
            .create_group(
                &owner,
                "scale",
                BTreeSet::from([alice.record.peer_id.clone(), bob.record.peer_id.clone()]),
            )
            .unwrap();
        seed_acknowledged_prefix(
            &mut store,
            &group.group_id,
            alice.record.peer_id.as_str(),
            bob.record.peer_id.as_str(),
            ACKNOWLEDGED_PREFIX,
        );
        let pending = MessageId::parse(&format!("m_{:032x}", ACKNOWLEDGED_PREFIX + 1)).unwrap();

        let callbacks = Arc::new(AtomicUsize::new(0));
        let callback_counter = Arc::clone(&callbacks);
        store
            .connection
            .progress_handler(
                PROGRESS_INTERVAL,
                Some(move || {
                    callback_counter.fetch_add(1, Ordering::Relaxed);
                    false
                }),
            )
            .unwrap();
        let result = store
            .acknowledge_message(&alice.principal, &group.group_id, &pending)
            .unwrap();
        store
            .connection
            .progress_handler(0, None::<fn() -> bool>)
            .unwrap();

        assert_eq!(result.contiguous_group_sequence, 5_001);
        let observed_callbacks = callbacks.load(Ordering::Relaxed);
        eprintln!(
            "bounded ACK triggered {observed_callbacks} progress callbacks at a {PROGRESS_INTERVAL}-opcode interval"
        );
        assert!(
            observed_callbacks <= MAX_PROGRESS_CALLBACKS,
            "ACK used at least {} bundled-SQLite VM steps for a {ACKNOWLEDGED_PREFIX}-row resolved prefix",
            observed_callbacks * PROGRESS_INTERVAL as usize
        );
    }

    fn seed_acknowledged_prefix(
        store: &mut Store,
        group_id: &GroupId,
        recipient_peer_id: &str,
        sender_peer_id: &str,
        acknowledged_prefix: i64,
    ) {
        let transaction = store.connection.transaction().unwrap();
        transaction
            .execute(
                "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<?1) INSERT INTO messages(message_id,group_id,group_sequence,sender_peer_id,sender_binding_revision,client_key,semantic_payload_json,body,committed_at_millis) SELECT printf('m_%032x',n),?2,n,?3,1,printf('scale-%d',n),'{}','x',1 FROM seq",
                params![acknowledged_prefix + 1, group_id.as_str(), sender_peer_id],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO recipient_deliveries(message_id,recipient_peer_id,recipient_binding_revision,saved_at_millis,fetched_generation,fetched_at_millis,acknowledged_generation,acknowledged_at_millis,delivery_generation) SELECT message_id,?1,1,1,CASE WHEN group_sequence<=?3 THEN 1 END,CASE WHEN group_sequence<=?3 THEN 1 END,CASE WHEN group_sequence<=?3 THEN 1 END,CASE WHEN group_sequence<=?3 THEN 1 END,1 FROM messages WHERE group_id=?2",
                params![recipient_peer_id, group_id.as_str(), acknowledged_prefix],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO acknowledgements(message_id,recipient_peer_id,binding_revision,generation,fetched_at_millis,acknowledged_at_millis) SELECT message_id,?1,1,1,1,1 FROM messages WHERE group_id=?2 AND group_sequence<=?3",
                params![recipient_peer_id, group_id.as_str(), acknowledged_prefix],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO recipient_ack_order(message_id,recipient_peer_id,group_id,group_sequence,binding_revision,generation,acknowledged) SELECT message_id,?1,?2,group_sequence,1,1,group_sequence<=?3 FROM messages WHERE group_id=?2",
                params![recipient_peer_id, group_id.as_str(), acknowledged_prefix],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO acknowledgement_watermarks(group_id,recipient_peer_id,binding_revision,generation,contiguous_group_sequence,updated_at_millis) VALUES (?1,?2,1,1,?3,1)",
                params![group_id.as_str(), recipient_peer_id, acknowledged_prefix],
            )
            .unwrap();
        transaction
            .execute(
                "UPDATE groups SET next_sequence=?1 WHERE group_id=?2",
                params![acknowledged_prefix + 2, group_id.as_str()],
            )
            .unwrap();
        transaction.commit().unwrap();
    }
}
