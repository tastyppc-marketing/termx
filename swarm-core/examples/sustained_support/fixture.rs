use serde_json::Value;
use termx_swarm_core::{model::*, worker::*};

pub fn emit(mut value: Value) {
    // Align workload phases with the independent OS samples without treating
    // sender clocks as broker message chronology.
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    value
        .as_object_mut()
        .unwrap()
        .insert("utc_unix_millis".into(), millis.into());
    println!("{value}");
}
pub async fn call(client: &Client, make: impl Fn() -> Command) -> Response {
    loop {
        match client.submit(make()) {
            Ok(pending) => return pending.await.unwrap(),
            Err(AdmissionError::Contended) => tokio::task::yield_now().await,
            Err(error) => panic!("checkpoint admission: {error}"),
        }
    }
}
pub fn binding(index: usize) -> VerifiedBinding {
    VerifiedBinding::trusted(
        LaunchId::generate().as_str().into(),
        format!("synthetic-{index}"),
        "synthetic".into(),
        format!("synthetic-conversation-{index}"),
        None,
        1,
        1,
        true,
    )
    .unwrap()
}
pub struct Fixture {
    pub owner: OwnerPrincipal,
    pub peers: Vec<EnrolledPeer>,
    pub groups: Vec<GroupRecord>,
    pub next: [u64; 2],
}
impl Fixture {
    pub async fn new(client: &Client) -> Self {
        let Response::Owner(owner) = call(client, || Command::TrustedOwner).await else {
            panic!("owner")
        };
        call(client, || Command::Recover(owner.clone())).await;
        let mut peers = Vec::new();
        for i in 0..6 {
            let value = binding(i);
            let Response::Enrolled(peer) =
                call(client, || Command::Enroll(owner.clone(), value.clone())).await
            else {
                panic!("enroll")
            };
            peers.push(peer);
        }
        let mut groups = Vec::new();
        for (i, members) in [vec![0, 1, 2, 3], vec![2, 3, 4, 5]].iter().enumerate() {
            let Response::Group(group) = call(client, || {
                Command::CreateGroup(
                    owner.clone(),
                    format!("synthetic-group-{i}"),
                    members
                        .iter()
                        .map(|&p| peers[p].record.peer_id.clone())
                        .collect(),
                )
            })
            .await
            else {
                panic!("group")
            };
            groups.push(group);
        }
        Self {
            owner,
            peers,
            groups,
            next: [1, 1],
        }
    }
    pub fn sender(&self, group: usize) -> PeerPrincipal {
        self.peers[if group == 0 { 0 } else { 4 }].principal.clone()
    }
    pub fn recipient(&self, group: usize) -> PeerPrincipal {
        self.peers[if group == 0 { 1 } else { 5 }].principal.clone()
    }
    pub fn request(&self, group: usize, sequence: u64) -> SendMessageRequest {
        SendMessageRequest {
            group_id: self.groups[group].group_id.clone(),
            client_key: format!("g{group}-s{sequence}"),
            recipients: [
                self.recipient(group).peer_id().clone(),
                self.peers[2].record.peer_id.clone(),
            ]
            .into(),
            body: body(sequence),
            topic: None,
            reply_to: None,
        }
    }
    pub fn mailbox(
        &self,
        group: usize,
        cursor: Option<MailboxCursor>,
        max_items: usize,
    ) -> Command {
        Command::Mailbox(
            self.recipient(group),
            MailboxPageRequest {
                group_id: self.groups[group].group_id.clone(),
                cursor,
                max_items,
            },
        )
    }
    pub async fn preload(&mut self, client: &Client, count: u64) {
        for i in 0..count {
            let g = (i % 2) as usize;
            let request = self.request(g, self.next[g]);
            let Response::Saved(receipt) =
                call(client, || Command::Send(self.sender(g), request.clone())).await
            else {
                panic!("send")
            };
            check_saved(&receipt, &request, self.next[g], &self.sender(g));
            self.next[g] += 1;
        }
    }
}
pub fn body(sequence: u64) -> String {
    if sequence.is_multiple_of(4) {
        "x".repeat(4096)
    } else {
        "y".repeat(256)
    }
}
pub fn check_saved(
    receipt: &SendReceipt,
    request: &SendMessageRequest,
    sequence: u64,
    principal: &PeerPrincipal,
) {
    assert_eq!(receipt.group_sequence, sequence);
    assert_eq!(receipt.group_id, request.group_id);
    assert_eq!(receipt.sender_peer_id, *principal.peer_id());
    assert_eq!(
        receipt.sender_binding_revision,
        principal.binding_revision()
    );
    assert_eq!(
        receipt
            .recipients
            .iter()
            .map(|r| r.peer_id.clone())
            .collect::<std::collections::BTreeSet<_>>(),
        request.recipients
    );
    assert!(receipt
        .recipients
        .iter()
        .all(|r| r.binding_revision.get() == 1 && r.generation.get() == 1));
}
pub fn check_page(page: &MailboxPage, group: usize, position: u64, expected_high: Option<u64>) {
    if let Some(high) = expected_high {
        assert_eq!(page.snapshot_high_sequence, high);
    }
    for (i, entry) in page.messages.iter().enumerate() {
        let sequence = position + i as u64 + 1;
        assert_eq!(entry.message.group_sequence, sequence);
        assert_eq!(entry.message.client_key, format!("g{group}-s{sequence}"));
        assert!(
            entry.message.body == body(sequence),
            "synthetic payload mismatch (redacted)"
        );
        assert!(entry.receipt.fetched_at_millis.is_some());
        assert!(sequence <= page.snapshot_high_sequence);
    }
    assert!(serde_json::to_vec(page).unwrap().len() <= MAX_MAILBOX_PAGE_BYTES);
}
