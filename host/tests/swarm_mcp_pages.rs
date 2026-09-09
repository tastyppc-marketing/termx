use termx_swarm_core::model::{
    GroupId, MessageId, MessageRecord, MessageStateEntry, NavigationPosition, OutgoingPage, PeerId,
    RecipientState, Revision, MAX_MAILBOX_PAGE_BYTES, MAX_RECIPIENTS_PER_MESSAGE,
};

#[test]
fn maximum_outgoing_recipient_pages_fit_the_shared_json_validator() {
    let group = GroupId::parse("g_00000000000000000000000000000001").unwrap();
    let sender = PeerId::parse("p_00000000000000000000000000000001").unwrap();
    let revision = Revision::new(1).unwrap();
    let recipients = (0..MAX_RECIPIENTS_PER_MESSAGE)
        .map(|index| RecipientState {
            peer_id: PeerId::parse(&format!("p_{:032x}", index + 2)).unwrap(),
            original_binding_revision: revision,
            current_binding_revision: revision,
            generation: revision,
            fetched_at_millis: None,
            acknowledged_at_millis: None,
            replied_by: None,
        })
        .collect::<Vec<_>>();
    // Obtain the ordinary serialized navigation type through its existing
    // checked decoder; it conveys no caller identity or authority.
    let resume_position: NavigationPosition = serde_json::from_value(serde_json::json!({
        "group_id": group,
        "peer_id": sender,
        "binding_revision": 1,
        "policy_revision": 8194,
        "scope": "outgoing",
        "after_sequence": 10,
    }))
    .unwrap();
    let page = OutgoingPage {
        messages: (0..10)
            .map(|index| MessageStateEntry {
                message: MessageRecord {
                    message_id: MessageId::parse(&format!("m_{:032x}", index + 1)).unwrap(),
                    group_id: group.clone(),
                    group_sequence: index + 1,
                    sender_peer_id: sender.clone(),
                    sender_binding_revision: revision,
                    client_key: index.to_string(),
                    body: "b".into(),
                    topic: None,
                    reply_to: None,
                    attachments: Vec::new(),
                },
                recipients: recipients.clone(),
            })
            .collect(),
        next_cursor: None,
        resume_position,
        snapshot_high_sequence: 10,
    };
    let raw = serde_json::to_vec(&page).unwrap();
    assert!(raw.len() <= MAX_MAILBOX_PAGE_BYTES);
    assert!(raw.len() >= 7 * 1024 * 1024);
    let validated = termx_swarm_mcp_protocol::validate_json(&raw)
        .expect("a supported outgoing page must not be rejected by the shared JSON work budget");
    assert!(validated.stats().work_nodes() > 524_288);
    let decoded: OutgoingPage = serde_json::from_slice(&raw).unwrap();
    assert_eq!(decoded, page);
    eprintln!(
        "typed outgoing page: {} bytes, {} nodes, {} messages with {} recipients each",
        raw.len(),
        validated.stats().work_nodes(),
        page.messages.len(),
        recipients.len()
    );
}
