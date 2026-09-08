use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

use crate::error::StoreError;
use crate::model::{
    FrozenRecipient, GroupId, MessageCommitOutcome, MessageId, PeerId, PeerPrincipal, Revision,
    SendMessageRequest, SendReceipt,
};

use super::policy::revision_from_sql;
use super::{authorize_peer, now_millis, Store};

impl Store {
    pub fn send_message(
        &mut self,
        principal: &PeerPrincipal,
        request: SendMessageRequest,
    ) -> Result<SendReceipt, StoreError> {
        request.validate()?;
        let canonical_payload = String::from_utf8(request.canonical_json()?).map_err(|error| {
            crate::error::ValidationError::CanonicalSerialization(error.to_string())
        })?;
        let authority_id = self.authority_id.clone();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        authorize_peer(&transaction, &authority_id, principal, &request.group_id)?;
        let frozen_recipients =
            authorize_recipients(&transaction, &request.group_id, request.recipients.iter())?;

        if let Some((message_id, stored_payload)) = transaction
            .query_row(
                "SELECT message_id,semantic_payload_json FROM messages WHERE group_id=?1 AND sender_peer_id=?2 AND client_key=?3",
                params![request.group_id.as_str(), principal.peer_id.as_str(), request.client_key],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
        {
            if stored_payload != canonical_payload {
                return Err(StoreError::IdempotencyConflict);
            }
            let receipt = load_receipt(&transaction, &MessageId::parse(&message_id)?)?;
            transaction.commit()?;
            return Ok(receipt);
        }

        if request.recipients.contains(&principal.peer_id) {
            return Err(StoreError::Unauthorized {
                reason: "sender cannot be a message recipient",
            });
        }
        validate_reply(&transaction, principal, &request)?;
        let group_sequence = transaction.query_row(
            "SELECT next_sequence FROM groups WHERE group_id=?1",
            [request.group_id.as_str()],
            |row| row.get::<_, i64>(0),
        )?;
        let changed = transaction.execute(
            "UPDATE groups SET next_sequence=next_sequence+1 WHERE group_id=?1 AND next_sequence=?2",
            params![request.group_id.as_str(), group_sequence],
        )?;
        if changed != 1 {
            return Err(StoreError::StalePolicy {
                expected: u64::try_from(group_sequence).unwrap_or(0),
                actual: 0,
            });
        }
        let message_id = MessageId::generate();
        let now = now_millis(&transaction)?;
        transaction.execute(
            "INSERT INTO messages(message_id,group_id,group_sequence,sender_peer_id,sender_binding_revision,client_key,semantic_payload_json,body,topic,reply_to_message_id,committed_at_millis) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                message_id.as_str(),
                request.group_id.as_str(),
                group_sequence,
                principal.peer_id.as_str(),
                principal.binding_revision.as_sql_i64(),
                request.client_key,
                canonical_payload,
                request.body,
                request.topic,
                request.reply_to.as_ref().map(MessageId::as_str),
                now,
            ],
        )?;
        for recipient in &frozen_recipients {
            transaction.execute(
                "INSERT INTO recipient_deliveries(message_id,recipient_peer_id,recipient_binding_revision,saved_at_millis,delivery_generation) VALUES (?1,?2,?3,?4,?5)",
                params![
                    message_id.as_str(),
                    recipient.peer_id.as_str(),
                    recipient.binding_revision.as_sql_i64(),
                    now,
                    recipient.generation.as_sql_i64(),
                ],
            )?;
            transaction.execute(
                "INSERT INTO recipient_ack_order(message_id,recipient_peer_id,group_id,group_sequence,binding_revision,generation,acknowledged) VALUES (?1,?2,?3,?4,?5,?6,0)",
                params![
                    message_id.as_str(),
                    recipient.peer_id.as_str(),
                    request.group_id.as_str(),
                    group_sequence,
                    recipient.binding_revision.as_sql_i64(),
                    recipient.generation.as_sql_i64(),
                ],
            )?;
        }
        if let Some(reply_to) = &request.reply_to {
            transaction.execute(
                "UPDATE current_deliveries SET replied_by_message_id=?1 WHERE message_id=?2 AND recipient_peer_id=?3 AND recipient_binding_revision=?4",
                params![message_id.as_str(), reply_to.as_str(), principal.peer_id.as_str(), principal.binding_revision.as_sql_i64()],
            )?;
        }
        let receipt = SendReceipt {
            message_id,
            group_id: request.group_id,
            group_sequence: u64::try_from(group_sequence).map_err(|_| {
                StoreError::Unauthorized {
                    reason: "invalid stored group sequence",
                }
            })?,
            sender_peer_id: principal.peer_id.clone(),
            sender_binding_revision: principal.binding_revision,
            recipients: frozen_recipients,
            committed_at_millis: now,
            outcome: MessageCommitOutcome::Saved,
        };
        transaction.commit()?;
        Ok(receipt)
    }
}

fn authorize_recipients<'a>(
    transaction: &Transaction<'_>,
    group_id: &GroupId,
    recipients: impl Iterator<Item = &'a PeerId>,
) -> Result<Vec<FrozenRecipient>, StoreError> {
    let mut frozen = Vec::new();
    for peer_id in recipients {
        let revision = transaction
            .query_row(
                "SELECT p.current_binding_revision FROM peers p JOIN group_memberships gm ON gm.peer_id=p.peer_id AND gm.group_id=?1 AND gm.removed_policy_revision IS NULL WHERE p.peer_id=?2",
                [group_id.as_str(), peer_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        let Some(revision) = revision else {
            return Err(StoreError::Unauthorized {
                reason: "recipient is not an active group member",
            });
        };
        frozen.push(FrozenRecipient {
            peer_id: peer_id.clone(),
            binding_revision: revision_from_sql(revision)?,
            generation: Revision::new(1)?,
        });
    }
    Ok(frozen)
}

fn validate_reply(
    transaction: &Transaction<'_>,
    principal: &PeerPrincipal,
    request: &SendMessageRequest,
) -> Result<(), StoreError> {
    let Some(reply_to) = &request.reply_to else {
        return Ok(());
    };
    let accessible = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM messages m WHERE m.message_id=?1 AND m.group_id=?2 AND (m.sender_peer_id=?3 OR EXISTS(SELECT 1 FROM current_deliveries d WHERE d.message_id=m.message_id AND d.recipient_peer_id=?3 AND d.recipient_binding_revision=?4)))",
        params![reply_to.as_str(), request.group_id.as_str(), principal.peer_id.as_str(), principal.binding_revision.as_sql_i64()],
        |row| row.get::<_, bool>(0),
    )?;
    if !accessible {
        return Err(StoreError::InvalidReply);
    }
    Ok(())
}

fn load_receipt(
    transaction: &Transaction<'_>,
    message_id: &MessageId,
) -> Result<SendReceipt, StoreError> {
    let header = transaction.query_row(
        "SELECT group_id,group_sequence,sender_peer_id,sender_binding_revision,committed_at_millis FROM messages WHERE message_id=?1",
        [message_id.as_str()],
        |row| Ok((row.get::<_, String>(0)?,row.get::<_, i64>(1)?,row.get::<_, String>(2)?,row.get::<_, i64>(3)?,row.get::<_, i64>(4)?)),
    )?;
    let mut statement = transaction.prepare(
        "SELECT recipient_peer_id,recipient_binding_revision,delivery_generation FROM recipient_deliveries WHERE message_id=?1 ORDER BY recipient_peer_id",
    )?;
    let recipients = statement
        .query_map([message_id.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .map(|row| {
            let (peer, binding, generation) = row?;
            Ok(FrozenRecipient {
                peer_id: PeerId::parse(&peer)?,
                binding_revision: revision_from_sql(binding)?,
                generation: revision_from_sql(generation)?,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    Ok(SendReceipt {
        message_id: message_id.clone(),
        group_id: GroupId::parse(&header.0)?,
        group_sequence: u64::try_from(header.1).map_err(|_| StoreError::Unauthorized {
            reason: "invalid stored group sequence",
        })?,
        sender_peer_id: PeerId::parse(&header.2)?,
        sender_binding_revision: revision_from_sql(header.3)?,
        recipients,
        committed_at_millis: header.4,
        outcome: MessageCommitOutcome::Saved,
    })
}
