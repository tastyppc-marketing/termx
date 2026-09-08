//! Thread and outgoing navigation: bounded, indexed, per-message authorized.
//!
//! A thread root or a sender scope selects candidate rows; every row is still
//! individually visible only when the caller sent it or currently holds an
//! exact current-binding delivery of it. Thread reads record fetch evidence
//! for the caller's own deliveries exactly like a mailbox read; outgoing reads
//! never touch delivery evidence.
//!
//! Thread candidates come from two bounded key ranges, each fetched with the
//! page limit and merged in Rust: messages the caller sent in the thread
//! (`messages_by_sender_thread`) and current deliveries to the caller's exact
//! binding in the thread (`current_thread_delivery_page`). Work is bounded by
//! the page size, never by the size of hidden branches or retained history.
//! A retained sender/self row appears in both ranges and is emitted once.

use rusqlite::{params, Transaction, TransactionBehavior};

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
    resolve_navigation, sequence_from_sql, Frozen, InboxStart, MessageRow, ReadKind,
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
        let selector = Some(request.root.as_str());
        let frozen = resolve_navigation(
            &transaction,
            &authority_id,
            principal,
            &request.group_id,
            authorized.policy_revision,
            ReadKind::Thread,
            selector,
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
        let candidates = thread_candidates(
            &transaction,
            principal,
            &request,
            &frozen,
            request.max_items,
        )?;
        let snapshot_high_sequence = sequence_from_sql(frozen.snapshot_high)?;
        let mut sizing = PageSize::new(&ThreadPage {
            root: request.root.clone(),
            messages: Vec::new(),
            next_cursor: Some(MailboxCursor::generate()),
            resume_position: frozen.sizing_position(
                principal,
                &request.group_id,
                authorized.policy_revision,
                ReadKind::Thread,
                selector,
            )?,
            snapshot_high_sequence,
        })?;
        let mut messages: Vec<ThreadEntry> = Vec::new();
        let mut more_exists = false;
        let mut newly_fetched = Vec::new();
        for message_id in &candidates {
            if messages.len() == request.max_items {
                more_exists = true;
                break;
            }
            let row = load_message_row(&transaction, message_id)?;
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
        for message_id in &newly_fetched {
            mark_fetched(&transaction, principal, message_id, now)?;
        }
        if !newly_fetched.is_empty() {
            bump_delivery(&transaction)?;
        }
        let last_included = messages.last().map(|entry| entry.message.group_sequence);
        let last_position = last_included.map_or(frozen.position, |sequence| sequence as i64);
        let next_cursor = if more_exists {
            Some(insert_cursor(
                &transaction,
                &authority_id,
                principal,
                &request.group_id,
                authorized.policy_revision,
                ReadKind::Thread,
                selector,
                frozen.snapshot_high,
                last_position,
                now,
            )?)
        } else {
            None
        };
        let resume_position = frozen.resume_position(
            principal,
            &request.group_id,
            authorized.policy_revision,
            ReadKind::Thread,
            selector,
            last_included,
            more_exists,
        )?;
        transaction.commit()?;
        Ok(ThreadPage {
            root: request.root,
            messages,
            next_cursor,
            resume_position,
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
            resume_position: frozen.sizing_position(
                principal,
                &request.group_id,
                authorized.policy_revision,
                ReadKind::Outgoing,
                None,
            )?,
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
        let last_included = messages.last().map(|entry| entry.message.group_sequence);
        let last_position = last_included.map_or(frozen.position, |sequence| sequence as i64);
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
        let resume_position = frozen.resume_position(
            principal,
            &request.group_id,
            authorized.policy_revision,
            ReadKind::Outgoing,
            None,
            last_included,
            more_exists,
        )?;
        transaction.commit()?;
        Ok(OutgoingPage {
            messages,
            next_cursor,
            resume_position,
            snapshot_high_sequence,
        })
    }
}

/// Up to `max_items + 1` visible thread message IDs in sequence order, from
/// the two bounded key ranges merged and deduplicated by sequence.
fn thread_candidates(
    transaction: &Transaction<'_>,
    principal: &PeerPrincipal,
    request: &ThreadPageRequest,
    frozen: &Frozen,
    max_items: usize,
) -> Result<Vec<MessageId>, StoreError> {
    let limit = page_limit(max_items);
    let mut sent_statement = transaction.prepare_cached(
        "SELECT group_sequence,message_id FROM messages INDEXED BY messages_by_sender_thread WHERE group_id=?1 AND sender_peer_id=?2 AND thread_root_message_id=?3 AND group_sequence>?4 AND group_sequence<=?5 ORDER BY group_sequence LIMIT ?6",
    )?;
    let sent = sent_statement
        .query_map(
            params![
                request.group_id.as_str(),
                principal.peer_id.as_str(),
                request.root.as_str(),
                frozen.position,
                frozen.snapshot_high,
                limit,
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let mut received_statement = transaction.prepare_cached(
        "SELECT group_sequence,message_id FROM current_thread_deliveries INDEXED BY current_thread_delivery_page WHERE group_id=?1 AND recipient_peer_id=?2 AND recipient_binding_revision=?3 AND thread_root_message_id=?4 AND group_sequence>?5 AND group_sequence<=?6 ORDER BY group_sequence LIMIT ?7",
    )?;
    let received = received_statement
        .query_map(
            params![
                request.group_id.as_str(),
                principal.peer_id.as_str(),
                principal.binding_revision.as_sql_i64(),
                request.root.as_str(),
                frozen.position,
                frozen.snapshot_high,
                limit,
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let mut merged = Vec::with_capacity(max_items + 1);
    let (mut sent, mut received) = (sent.into_iter().peekable(), received.into_iter().peekable());
    while merged.len() <= max_items {
        let next = match (sent.peek(), received.peek()) {
            (Some(a), Some(b)) if a.0 == b.0 => {
                // The same sequence is the same message: a retained
                // sender/self row is emitted once.
                received.next();
                sent.next()
            }
            (Some(a), Some(b)) if a.0 < b.0 => sent.next(),
            (Some(_), Some(_)) => received.next(),
            (Some(_), None) => sent.next(),
            (None, Some(_)) => received.next(),
            (None, None) => None,
        };
        match next {
            Some((_, message_id)) => merged.push(MessageId::parse(&message_id)?),
            None => break,
        }
    }
    Ok(merged)
}

fn load_message_row(
    transaction: &Transaction<'_>,
    message_id: &MessageId,
) -> Result<MessageRow, StoreError> {
    let mut statement = transaction.prepare_cached(
        "SELECT message_id,group_sequence,sender_peer_id,sender_binding_revision,client_key,body,topic,reply_to_message_id FROM messages WHERE message_id=?1",
    )?;
    Ok(statement.query_row([message_id.as_str()], message_row)?)
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
