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
            "UPDATE recipient_deliveries SET acknowledged_generation=?1, acknowledged_at_millis=COALESCE(acknowledged_at_millis,?2) WHERE message_id=?3 AND recipient_peer_id=?4",
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
        let contiguous =
            acknowledgement_watermark(&transaction, group_id, principal, generation, now)?;
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
    generation: i64,
    now: i64,
) -> Result<u64, StoreError> {
    let current = transaction
        .query_row(
            "SELECT contiguous_group_sequence FROM acknowledgement_watermarks WHERE group_id=?1 AND recipient_peer_id=?2 AND binding_revision=?3 AND generation=?4",
            params![group_id.as_str(), principal.peer_id.as_str(), principal.binding_revision.as_sql_i64(), generation],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0);
    let first_unacknowledged = transaction
        .query_row(
            "SELECT group_sequence FROM recipient_ack_order WHERE group_id=?1 AND recipient_peer_id=?2 AND binding_revision=?3 AND generation=?4 AND acknowledged=0 AND group_sequence>?5 ORDER BY group_sequence LIMIT 1",
            params![group_id.as_str(), principal.peer_id.as_str(), principal.binding_revision.as_sql_i64(), generation, current],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let watermark = match first_unacknowledged {
        Some(sequence) => transaction
            .query_row(
                "SELECT group_sequence FROM recipient_ack_order WHERE group_id=?1 AND recipient_peer_id=?2 AND binding_revision=?3 AND generation=?4 AND group_sequence>?5 AND group_sequence<?6 ORDER BY group_sequence DESC LIMIT 1",
                params![group_id.as_str(), principal.peer_id.as_str(), principal.binding_revision.as_sql_i64(), generation, current, sequence],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(current),
        None => transaction
            .query_row(
                "SELECT group_sequence FROM recipient_ack_order WHERE group_id=?1 AND recipient_peer_id=?2 AND binding_revision=?3 AND generation=?4 AND group_sequence>?5 ORDER BY group_sequence DESC LIMIT 1",
                params![group_id.as_str(), principal.peer_id.as_str(), principal.binding_revision.as_sql_i64(), generation, current],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(current),
    };
    transaction.execute(
        "INSERT INTO acknowledgement_watermarks(group_id,recipient_peer_id,binding_revision,generation,contiguous_group_sequence,updated_at_millis) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(group_id,recipient_peer_id,binding_revision,generation) DO UPDATE SET contiguous_group_sequence=MAX(acknowledgement_watermarks.contiguous_group_sequence,excluded.contiguous_group_sequence),updated_at_millis=excluded.updated_at_millis",
        params![group_id.as_str(), principal.peer_id.as_str(), principal.binding_revision.as_sql_i64(), generation, watermark, now],
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
