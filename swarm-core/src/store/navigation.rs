//! Thread and outgoing navigation: bounded, indexed, per-message authorized.
//!
//! A thread root or a sender scope selects candidate rows; every row is still
//! individually visible only when the caller sent it or currently holds an
//! exact current-binding delivery of it. Thread reads record fetch evidence
//! for the caller's own deliveries exactly like a mailbox read; outgoing reads
//! never touch delivery evidence.

use rusqlite::{params, TransactionBehavior};

use crate::error::StoreError;
use crate::model::{
    MailboxCursor, MessageId, MessageStateEntry, OutgoingPage, OutgoingPageRequest, PeerId,
    PeerPrincipal, RecipientState, ThreadEntry, ThreadPage, ThreadPageRequest,
    MAX_MAILBOX_PAGE_BYTES,
};

use super::page_size::PageSize;
use super::policy::revision_from_sql;
use super::query::{
    insert_cursor, load_receipt, mark_fetched, message_record, message_row, page_limit,
    resolve_navigation, sequence_from_sql, InboxStart, ReadKind,
};
use super::revision::bump_delivery;
use super::{authorize_peer, now_millis, Store};

impl Store {
    pub fn read_thread(
        &mut self,
        principal: &PeerPrincipal,
        request: ThreadPageRequest,
    ) -> Result<ThreadPage, StoreError> {
        request.validate()?;
        let authority_id = self.authority_id.clone();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let authorized = authorize_peer(&transaction, &authority_id, principal, &request.group_id)?;
        let start = InboxStart::from(request.navigation.clone());
        let frozen = resolve_navigation(
            &transaction,
            &authority_id,
            principal,
            &request.group_id,
            authorized.policy_revision,
            ReadKind::Thread,
            Some(request.root.as_str()),
            &start,
        )?;
        // The selector must be a thread root in this exact group that the
        // caller can see; unknown, foreign and invisible roots are identical.
        let visible_root = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM messages m WHERE m.message_id=?1 AND m.group_id=?2 AND m.thread_root_message_id=m.message_id AND (m.sender_peer_id=?3 OR EXISTS(SELECT 1 FROM current_deliveries d WHERE d.message_id=m.message_id AND d.recipient_peer_id=?3 AND d.recipient_binding_revision=?4)))",
            params![
                request.root.as_str(),
                request.group_id.as_str(),
                principal.peer_id.as_str(),
                principal.binding_revision.as_sql_i64()
            ],
            |row| row.get::<_, bool>(0),
        )?;
        if !visible_root {
            return Err(StoreError::NotFound {
                kind: "thread root",
            });
        }
        let now = now_millis(&transaction)?;
        let mut statement = transaction.prepare(
            "SELECT m.message_id,m.group_sequence,m.sender_peer_id,m.sender_binding_revision,m.client_key,m.body,m.topic,m.reply_to_message_id FROM messages m INDEXED BY messages_by_thread WHERE m.group_id=?1 AND m.thread_root_message_id=?2 AND m.group_sequence>?3 AND m.group_sequence<=?4 AND (m.sender_peer_id=?5 OR EXISTS(SELECT 1 FROM current_deliveries d WHERE d.message_id=m.message_id AND d.recipient_peer_id=?5 AND d.recipient_binding_revision=?6)) ORDER BY m.group_sequence LIMIT ?7",
        )?;
        let mut rows = statement.query_map(
            params![
                request.group_id.as_str(),
                request.root.as_str(),
                frozen.position,
                frozen.snapshot_high,
                principal.peer_id.as_str(),
                principal.binding_revision.as_sql_i64(),
                page_limit(request.max_items),
            ],
            message_row,
        )?;
        let snapshot_high_sequence = sequence_from_sql(frozen.snapshot_high)?;
        let mut sizing = PageSize::new(&ThreadPage {
            root: request.root.clone(),
            messages: Vec::new(),
            next_cursor: Some(MailboxCursor::generate()),
            snapshot_high_sequence,
        })?;
        let mut messages: Vec<ThreadEntry> = Vec::new();
        let mut more_exists = false;
        let mut newly_fetched = Vec::new();
        for row in &mut rows {
            if messages.len() == request.max_items {
                more_exists = true;
                break;
            }
            let row = row?;
            let message = message_record(&transaction, &request.group_id, &row)?;
            let mut receipt = load_receipt(&transaction, principal, &message.message_id)?;
            let fresh = matches!(&receipt, Some(receipt) if receipt.fetched_at_millis.is_none());
            if let Some(receipt) = receipt.as_mut() {
                if receipt.fetched_at_millis.is_none() {
                    receipt.fetched_at_millis = Some(now);
                }
            }
            let entry = ThreadEntry { message, receipt };
            let page_bytes = sizing.with_entry(&entry)?;
            if page_bytes > MAX_MAILBOX_PAGE_BYTES {
                if messages.is_empty() {
                    return Err(StoreError::PageItemTooLarge);
                }
                more_exists = true;
                break;
            }
            sizing.accept(page_bytes);
            if fresh {
                newly_fetched.push(entry.message.message_id.clone());
            }
            messages.push(entry);
        }
        drop(rows);
        drop(statement);
        for message_id in &newly_fetched {
            mark_fetched(&transaction, principal, message_id, now)?;
        }
        if !newly_fetched.is_empty() {
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
                &request.group_id,
                authorized.policy_revision,
                ReadKind::Thread,
                Some(request.root.as_str()),
                frozen.snapshot_high,
                last_position,
                now,
            )?)
        } else {
            None
        };
        transaction.commit()?;
        Ok(ThreadPage {
            root: request.root,
            messages,
            next_cursor,
            snapshot_high_sequence,
        })
    }

    /// The caller's own sent messages in one group with durable per-recipient
    /// state. Reading outgoing state is not delivery, fetch or ACK.
    pub fn read_outgoing(
        &mut self,
        principal: &PeerPrincipal,
        request: OutgoingPageRequest,
    ) -> Result<OutgoingPage, StoreError> {
        request.validate()?;
        let authority_id = self.authority_id.clone();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let authorized = authorize_peer(&transaction, &authority_id, principal, &request.group_id)?;
        let start = InboxStart::from(request.navigation.clone());
        let frozen = resolve_navigation(
            &transaction,
            &authority_id,
            principal,
            &request.group_id,
            authorized.policy_revision,
            ReadKind::Outgoing,
            None,
            &start,
        )?;
        let now = now_millis(&transaction)?;
        let mut statement = transaction.prepare(
            "SELECT m.message_id,m.group_sequence,m.sender_peer_id,m.sender_binding_revision,m.client_key,m.body,m.topic,m.reply_to_message_id FROM messages m INDEXED BY messages_by_sender WHERE m.group_id=?1 AND m.sender_peer_id=?2 AND m.group_sequence>?3 AND m.group_sequence<=?4 ORDER BY m.group_sequence LIMIT ?5",
        )?;
        let mut rows = statement.query_map(
            params![
                request.group_id.as_str(),
                principal.peer_id.as_str(),
                frozen.position,
                frozen.snapshot_high,
                page_limit(request.max_items),
            ],
            message_row,
        )?;
        let snapshot_high_sequence = sequence_from_sql(frozen.snapshot_high)?;
        let mut sizing = PageSize::new(&OutgoingPage {
            messages: Vec::new(),
            next_cursor: Some(MailboxCursor::generate()),
            snapshot_high_sequence,
        })?;
        let mut messages: Vec<MessageStateEntry> = Vec::new();
        let mut more_exists = false;
        for row in &mut rows {
            if messages.len() == request.max_items {
                more_exists = true;
                break;
            }
            let row = row?;
            let message = message_record(&transaction, &request.group_id, &row)?;
            let recipients = recipient_states(&transaction, &message.message_id)?;
            let entry = MessageStateEntry {
                message,
                recipients,
            };
            let page_bytes = sizing.with_entry(&entry)?;
            if page_bytes > MAX_MAILBOX_PAGE_BYTES {
                if messages.is_empty() {
                    return Err(StoreError::PageItemTooLarge);
                }
                more_exists = true;
                break;
            }
            sizing.accept(page_bytes);
            messages.push(entry);
        }
        drop(rows);
        drop(statement);
        let last_position = messages
            .last()
            .map_or(frozen.position, |entry| entry.message.group_sequence as i64);
        let next_cursor = if more_exists {
            Some(insert_cursor(
                &transaction,
                &authority_id,
                principal,
                &request.group_id,
                authorized.policy_revision,
                ReadKind::Outgoing,
                None,
                frozen.snapshot_high,
                last_position,
                now,
            )?)
        } else {
            None
        };
        transaction.commit()?;
        Ok(OutgoingPage {
            messages,
            next_cursor,
            snapshot_high_sequence,
        })
    }
}

/// Durable per-recipient state of one message: the original frozen binding,
/// the current (possibly transferred) binding and generation, and evidence
/// recorded only by the recipient's own fetch, ACK or reply.
pub(super) fn recipient_states(
    transaction: &rusqlite::Transaction<'_>,
    message_id: &MessageId,
) -> Result<Vec<RecipientState>, StoreError> {
    let mut statement = transaction.prepare_cached(
        "SELECT rd.recipient_peer_id,rd.recipient_binding_revision,cd.recipient_binding_revision,cd.delivery_generation,cd.fetched_at_millis,cd.acknowledged_at_millis,cd.replied_by_message_id FROM recipient_deliveries rd JOIN current_deliveries cd ON cd.message_id=rd.message_id AND cd.recipient_peer_id=rd.recipient_peer_id WHERE rd.message_id=?1 ORDER BY rd.recipient_peer_id",
    )?;
    let states = statement
        .query_map([message_id.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })?
        .map(|row| {
            let (peer, original, current, generation, fetched, acknowledged, replied) = row?;
            Ok(RecipientState {
                peer_id: PeerId::parse(&peer)?,
                original_binding_revision: revision_from_sql(original)?,
                current_binding_revision: revision_from_sql(current)?,
                generation: revision_from_sql(generation)?,
                fetched_at_millis: fetched,
                acknowledged_at_millis: acknowledged,
                replied_by: replied.as_deref().map(MessageId::parse).transpose()?,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    Ok(states)
}
