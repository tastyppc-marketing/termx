use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

use crate::error::StoreError;
use crate::model::{
    AcknowledgementResult, GroupId, MailboxCursor, MailboxEntry, MailboxPage, MailboxPageRequest,
    MessageId, MessageRecord, PeerId, PeerPrincipal, ReceiptRecord, Revision,
    MAX_MAILBOX_PAGE_BYTES,
};

use super::policy::revision_from_sql;
use super::{authorize_peer, now_millis, Store};

const CURSOR_LIFETIME_MILLIS: i64 = 24 * 60 * 60 * 1000;

impl Store {
    pub fn read_mailbox(
        &mut self,
        principal: &PeerPrincipal,
        request: MailboxPageRequest,
    ) -> Result<MailboxPage, StoreError> {
        request.validate()?;
        let authority_id = self.authority_id.clone();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let authorized = authorize_peer(&transaction, &authority_id, principal, &request.group_id)?;
        let (snapshot_high, position) = match request.cursor.as_ref() {
            Some(cursor) => load_cursor(
                &transaction,
                &authority_id,
                principal,
                &request.group_id,
                authorized.policy_revision,
                cursor,
            )?,
            None => {
                let next_sequence = transaction.query_row(
                    "SELECT next_sequence FROM groups WHERE group_id=?1",
                    [request.group_id.as_str()],
                    |row| row.get::<_, i64>(0),
                )?;
                (next_sequence - 1, 0)
            }
        };

        let now = now_millis(&transaction)?;
        let mut statement = transaction.prepare(
            "SELECT m.message_id,m.group_sequence,m.sender_peer_id,m.sender_binding_revision,m.client_key,m.body,m.topic,m.reply_to_message_id,d.delivery_generation,a.fetched_at_millis,a.acknowledged_at_millis FROM messages m JOIN recipient_deliveries d ON d.message_id=m.message_id LEFT JOIN acknowledgements a ON a.message_id=d.message_id AND a.recipient_peer_id=d.recipient_peer_id AND a.binding_revision=d.recipient_binding_revision AND a.generation=d.delivery_generation WHERE m.group_id=?1 AND d.recipient_peer_id=?2 AND d.recipient_binding_revision=?3 AND m.group_sequence>?4 AND m.group_sequence<=?5 ORDER BY m.group_sequence LIMIT ?6",
        )?;
        let mut rows = statement.query_map(
            params![
                request.group_id.as_str(),
                principal.peer_id.as_str(),
                principal.binding_revision.as_sql_i64(),
                position,
                snapshot_high,
                i64::try_from(request.max_items + 1).expect("bounded page limit fits i64"),
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                    row.get::<_, Option<i64>>(10)?,
                ))
            },
        )?;
        let mut messages = Vec::new();
        let sizing_cursor = MailboxCursor::generate();
        let mut more_exists = false;
        for row in &mut rows {
            if messages.len() == request.max_items {
                more_exists = true;
                break;
            }
            let row = row?;
            let mut entry = mailbox_entry(&request.group_id, principal, &row)?;
            if entry.receipt.fetched_at_millis.is_none() {
                entry.receipt.fetched_at_millis = Some(now);
            }
            messages.push(entry);
            let candidate = MailboxPage {
                messages: messages.clone(),
                next_cursor: Some(sizing_cursor.clone()),
                snapshot_high_sequence: u64::try_from(snapshot_high)
                    .map_err(|_| StoreError::InvalidCursor)?,
            };
            let page_bytes = serde_json::to_vec(&candidate)
                .map_err(|error| {
                    crate::error::ValidationError::CanonicalSerialization(error.to_string())
                })?
                .len();
            if page_bytes > MAX_MAILBOX_PAGE_BYTES {
                messages.pop();
                if messages.is_empty() {
                    return Err(StoreError::PageItemTooLarge);
                }
                more_exists = true;
                break;
            }
        }
        drop(rows);
        drop(statement);
        for entry in &messages {
            mark_fetched(&transaction, principal, &entry.message.message_id, now)?;
        }
        let last_position = messages
            .last()
            .map_or(position, |entry| entry.message.group_sequence as i64);
        let next_cursor = if more_exists {
            let cursor = MailboxCursor::generate();
            transaction.execute(
            "INSERT INTO mailbox_cursors(cursor_id,authority_id,group_id,peer_id,binding_revision,policy_revision,snapshot_high_sequence,position_sequence,created_at_millis,expires_at_millis) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![
                    cursor.as_str(),
                    authority_id.as_str(),
                    request.group_id.as_str(),
                    principal.peer_id.as_str(),
                    principal.binding_revision.as_sql_i64(),
                    authorized.policy_revision.as_sql_i64(),
                    snapshot_high,
                    last_position,
                    now,
                    now + CURSOR_LIFETIME_MILLIS,
                ],
            )?;
            Some(cursor)
        } else {
            None
        };
        transaction.commit()?;
        Ok(MailboxPage {
            messages,
            next_cursor,
            snapshot_high_sequence: u64::try_from(snapshot_high)
                .map_err(|_| StoreError::InvalidCursor)?,
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
                "SELECT d.delivery_generation,m.sender_peer_id FROM recipient_deliveries d JOIN messages m ON m.message_id=d.message_id WHERE d.message_id=?1 AND d.recipient_peer_id=?2 AND d.recipient_binding_revision=?3 AND m.group_id=?4",
                params![message_id.as_str(), principal.peer_id.as_str(), principal.binding_revision.as_sql_i64(), group_id.as_str()],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
            .ok_or(StoreError::Unauthorized {
                reason: "message is not an eligible delivery for this peer",
            })?;
        if delivery.1 == principal.peer_id.as_str() {
            return Err(StoreError::Unauthorized {
                reason: "message sender cannot acknowledge its own message",
            });
        }
        let generation = delivery.0;
        let now = now_millis(&transaction)?;
        transaction.execute(
            "INSERT INTO acknowledgements(message_id,recipient_peer_id,binding_revision,generation,acknowledged_at_millis) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(message_id,recipient_peer_id,binding_revision,generation) DO UPDATE SET acknowledged_at_millis=COALESCE(acknowledgements.acknowledged_at_millis,excluded.acknowledged_at_millis)",
            params![message_id.as_str(), principal.peer_id.as_str(), principal.binding_revision.as_sql_i64(), generation, now],
        )?;
        transaction.execute(
            "UPDATE recipient_deliveries SET acknowledged_generation=?1, acknowledged_at_millis=COALESCE(acknowledged_at_millis,?2) WHERE message_id=?3 AND recipient_peer_id=?4",
            params![generation, now, message_id.as_str(), principal.peer_id.as_str()],
        )?;
        let acknowledged_at = transaction.query_row(
            "SELECT acknowledged_at_millis FROM acknowledgements WHERE message_id=?1 AND recipient_peer_id=?2 AND binding_revision=?3 AND generation=?4",
            params![message_id.as_str(), principal.peer_id.as_str(), principal.binding_revision.as_sql_i64(), generation],
            |row| row.get::<_, i64>(0),
        )?;
        let contiguous = acknowledgement_watermark(&transaction, group_id, principal)?;
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

type MailboxRow = (
    String,
    i64,
    String,
    i64,
    String,
    String,
    Option<String>,
    Option<String>,
    i64,
    Option<i64>,
    Option<i64>,
);

fn mailbox_entry(
    group_id: &GroupId,
    principal: &PeerPrincipal,
    row: &MailboxRow,
) -> Result<MailboxEntry, StoreError> {
    let message_id = MessageId::parse(&row.0)?;
    let binding_revision = principal.binding_revision;
    let generation = revision_from_sql(row.8)?;
    Ok(MailboxEntry {
        message: MessageRecord {
            message_id: message_id.clone(),
            group_id: group_id.clone(),
            group_sequence: u64::try_from(row.1).map_err(|_| StoreError::InvalidCursor)?,
            sender_peer_id: PeerId::parse(&row.2)?,
            sender_binding_revision: revision_from_sql(row.3)?,
            client_key: row.4.clone(),
            body: row.5.clone(),
            topic: row.6.clone(),
            reply_to: row.7.as_deref().map(MessageId::parse).transpose()?,
        },
        receipt: ReceiptRecord {
            message_id,
            recipient_peer_id: principal.peer_id.clone(),
            binding_revision,
            generation,
            fetched_at_millis: row.9,
            acknowledged_at_millis: row.10,
        },
    })
}

fn load_cursor(
    transaction: &Transaction<'_>,
    authority_id: &crate::model::AuthorityId,
    principal: &PeerPrincipal,
    group_id: &GroupId,
    policy_revision: Revision,
    cursor: &MailboxCursor,
) -> Result<(i64, i64), StoreError> {
    let row = transaction
        .query_row(
            "SELECT authority_id,group_id,peer_id,binding_revision,policy_revision,snapshot_high_sequence,position_sequence,expires_at_millis FROM mailbox_cursors WHERE cursor_id=?1",
            [cursor.as_str()],
            |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,row.get::<_, i64>(3)?,row.get::<_, i64>(4)?,row.get::<_, i64>(5)?,row.get::<_, i64>(6)?,row.get::<_, i64>(7)?)),
        )
        .optional()?
        .ok_or(StoreError::InvalidCursor)?;
    if row.0 != authority_id.as_str()
        || row.1 != group_id.as_str()
        || row.2 != principal.peer_id.as_str()
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
    Ok((row.5, row.6))
}

fn mark_fetched(
    transaction: &Transaction<'_>,
    principal: &PeerPrincipal,
    message_id: &MessageId,
    now: i64,
) -> Result<(), StoreError> {
    let generation = transaction.query_row(
        "SELECT delivery_generation FROM recipient_deliveries WHERE message_id=?1 AND recipient_peer_id=?2",
        [message_id.as_str(), principal.peer_id.as_str()],
        |row| row.get::<_, i64>(0),
    )?;
    transaction.execute(
        "INSERT INTO acknowledgements(message_id,recipient_peer_id,binding_revision,generation,fetched_at_millis) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(message_id,recipient_peer_id,binding_revision,generation) DO UPDATE SET fetched_at_millis=COALESCE(acknowledgements.fetched_at_millis,excluded.fetched_at_millis)",
        params![message_id.as_str(), principal.peer_id.as_str(), principal.binding_revision.as_sql_i64(), generation, now],
    )?;
    transaction.execute(
        "UPDATE recipient_deliveries SET fetched_generation=COALESCE(fetched_generation,?1), fetched_at_millis=COALESCE(fetched_at_millis,?2) WHERE message_id=?3 AND recipient_peer_id=?4",
        params![generation, now, message_id.as_str(), principal.peer_id.as_str()],
    )?;
    Ok(())
}

fn acknowledgement_watermark(
    transaction: &Transaction<'_>,
    group_id: &GroupId,
    principal: &PeerPrincipal,
) -> Result<u64, StoreError> {
    let first_unacknowledged = transaction.query_row(
        "SELECT MIN(m.group_sequence) FROM messages m JOIN recipient_deliveries d ON d.message_id=m.message_id LEFT JOIN acknowledgements a ON a.message_id=d.message_id AND a.recipient_peer_id=d.recipient_peer_id AND a.binding_revision=d.recipient_binding_revision AND a.generation=d.delivery_generation WHERE m.group_id=?1 AND d.recipient_peer_id=?2 AND d.recipient_binding_revision=?3 AND a.acknowledged_at_millis IS NULL",
        params![group_id.as_str(), principal.peer_id.as_str(), principal.binding_revision.as_sql_i64()],
        |row| row.get::<_, Option<i64>>(0),
    )?;
    let watermark = match first_unacknowledged {
        Some(sequence) => transaction.query_row(
            "SELECT COALESCE(MAX(m.group_sequence),0) FROM messages m JOIN recipient_deliveries d ON d.message_id=m.message_id JOIN acknowledgements a ON a.message_id=d.message_id AND a.recipient_peer_id=d.recipient_peer_id AND a.binding_revision=d.recipient_binding_revision AND a.generation=d.delivery_generation WHERE m.group_id=?1 AND d.recipient_peer_id=?2 AND d.recipient_binding_revision=?3 AND m.group_sequence<?4 AND a.acknowledged_at_millis IS NOT NULL",
            params![group_id.as_str(), principal.peer_id.as_str(), principal.binding_revision.as_sql_i64(), sequence],
            |row| row.get::<_, i64>(0),
        )?,
        None => transaction.query_row(
            "SELECT COALESCE(MAX(m.group_sequence),0) FROM messages m JOIN recipient_deliveries d ON d.message_id=m.message_id JOIN acknowledgements a ON a.message_id=d.message_id AND a.recipient_peer_id=d.recipient_peer_id AND a.binding_revision=d.recipient_binding_revision AND a.generation=d.delivery_generation WHERE m.group_id=?1 AND d.recipient_peer_id=?2 AND d.recipient_binding_revision=?3 AND a.acknowledged_at_millis IS NOT NULL",
            params![group_id.as_str(), principal.peer_id.as_str(), principal.binding_revision.as_sql_i64()],
            |row| row.get::<_, i64>(0),
        )?,
    };
    u64::try_from(watermark).map_err(|_| StoreError::InvalidCursor)
}
