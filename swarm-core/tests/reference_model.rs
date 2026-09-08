//! Small independent collections model. No SQL or implementation predicates.
//! Every operation is checked immediately: on failure the retained trace is the
//! shortest observed failing prefix for that seed (not a claimed global minimum).
#[path = "support/evidence.rs"]
mod evidence;
mod support;
use rand::{Rng, SeedableRng};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
};
use termx_swarm_core::{error::StoreError, model::*, worker::*};

fn assert_auth_error(result: Result<Response, OperationError>) {
    assert!(matches!(
        result,
        Err(OperationError::Store(
            StoreError::GroupPaused | StoreError::BindingOffline | StoreError::Unauthorized { .. }
        ))
    ));
}
struct Delivery {
    binding: u64,
    generation: u64,
    fetched: bool,
    acked: bool,
    ready: bool,
}
struct Message {
    group: usize,
    request: SendMessageRequest,
    original: SendReceipt,
    deliveries: BTreeMap<usize, Delivery>,
}
struct Model {
    worker: Worker,
    client: Client,
    owner: OwnerPrincipal,
    peers: Vec<EnrolledPeer>,
    groups: Vec<GroupRecord>,
    members: Vec<BTreeSet<usize>>,
    messages: Vec<Message>,
    trace: std::fs::File,
    step: usize,
    seed: u64,
}
async fn call(client: &Client, make: impl Fn() -> Command) -> Result<Response, OperationError> {
    loop {
        match client.submit(make()) {
            Ok(p) => return p.await,
            Err(AdmissionError::Contended) => tokio::task::yield_now().await,
            Err(e) => panic!("unexpected admission: {e}"),
        }
    }
}
fn binding(name: &str) -> VerifiedBinding {
    VerifiedBinding::trusted(
        LaunchId::generate().as_str().into(),
        name.into(),
        "synthetic".into(),
        name.into(),
        None,
        1,
        1,
        true,
    )
    .unwrap()
}
impl Model {
    async fn new(seed: u64) -> Self {
        let path = support::retained_db(&format!("model-{seed}"));
        println!(
            "reference seed={seed} sqlite={} fixture={}",
            rusqlite::version(),
            path.display()
        );
        let mut trace = std::fs::File::create(path.with_extension("trace.txt")).unwrap();
        writeln!(
            trace,
            "seed={seed} sqlite={} operations=240 peers=6 groups=2",
            rusqlite::version()
        )
        .unwrap();
        std::fs::write(path.with_extension("sources.txt"), evidence::manifest()).unwrap();
        let worker = Worker::open(path, WorkerConfig::default()).await.unwrap();
        let client = worker.client();
        let Response::Owner(owner) = call(&client, || Command::TrustedOwner).await.unwrap() else {
            panic!()
        };
        let mut peers = Vec::new();
        for i in 0..6 {
            let b = binding(&format!("peer-{i}"));
            let Response::Enrolled(p) = call(&client, || Command::Enroll(owner.clone(), b.clone()))
                .await
                .unwrap()
            else {
                panic!()
            };
            peers.push(p);
        }
        let members: Vec<BTreeSet<usize>> = vec![[0, 1, 2, 3].into(), [0, 2, 3, 4, 5].into()];
        let mut groups = Vec::new();
        for (i, set) in members.iter().enumerate() {
            let Response::Group(g) = call(&client, || {
                Command::CreateGroup(
                    owner.clone(),
                    format!("group-{i}"),
                    set.iter()
                        .map(|p| peers[*p].record.peer_id.clone())
                        .collect(),
                )
            })
            .await
            .unwrap() else {
                panic!()
            };
            groups.push(g);
        }
        call(&client, || Command::Recover(owner.clone()))
            .await
            .unwrap();
        Self {
            worker,
            client,
            owner,
            peers,
            groups,
            members,
            messages: Vec::new(),
            trace,
            step: 0,
            seed,
        }
    }
    fn log(&mut self, operation: &str) {
        self.step += 1;
        writeln!(self.trace, "{} {operation}", self.step).unwrap();
        self.trace.flush().unwrap();
    }
    fn allowed(&self, g: usize, p: usize) -> bool {
        !self.groups[g].paused && self.members[g].contains(&p) && self.peers[p].record.is_live
    }
    async fn send(&mut self, g: usize, recipients: BTreeSet<usize>) -> Option<usize> {
        self.log(&format!("send group={g} recipient_indices={recipients:?}"));
        let request = SendMessageRequest {
            group_id: self.groups[g].group_id.clone(),
            client_key: format!("seed-{}-step-{}", self.seed, self.step),
            recipients: recipients
                .iter()
                .map(|p| self.peers[*p].record.peer_id.clone())
                .collect(),
            body: format!("synthetic {}", self.step),
            topic: None,
            reply_to: None,
        };
        let allowed = self.allowed(g, 0) && recipients.iter().all(|p| self.members[g].contains(p));
        let result = call(&self.client, || {
            Command::Send(self.peers[0].principal.clone(), request.clone())
        })
        .await;
        if !allowed {
            assert_auth_error(result);
            return None;
        }
        let Response::Saved(receipt) = result.unwrap() else {
            panic!()
        };
        assert!(receipt
            .recipients
            .windows(2)
            .all(|pair| pair[0].peer_id < pair[1].peer_id));
        assert_eq!(
            receipt.group_sequence,
            self.messages.iter().filter(|m| m.group == g).count() as u64 + 1
        );
        let expected: BTreeSet<_> = recipients
            .iter()
            .map(|p| {
                (
                    self.peers[*p].record.peer_id.clone(),
                    self.peers[*p].record.revision,
                    Revision::new(1).unwrap(),
                )
            })
            .collect();
        assert_eq!(
            receipt
                .recipients
                .iter()
                .map(|r| (r.peer_id.clone(), r.binding_revision, r.generation))
                .collect::<BTreeSet<_>>(),
            expected
        );
        let deliveries = recipients
            .iter()
            .map(|p| {
                (
                    *p,
                    Delivery {
                        binding: self.peers[*p].record.revision.get(),
                        generation: 1,
                        fetched: false,
                        acked: false,
                        ready: true,
                    },
                )
            })
            .collect();
        let index = self.messages.len();
        self.messages.push(Message {
            group: g,
            request,
            original: receipt,
            deliveries,
        });
        Some(index)
    }
    async fn retry(&mut self, index: usize, conflict: bool) {
        self.log(&format!("retry index={index} conflict={conflict}"));
        let message = &self.messages[index];
        let mut request = message.request.clone();
        if conflict {
            request.body.push('!');
        }
        let authorized = self.allowed(message.group, 0)
            && message
                .deliveries
                .keys()
                .all(|p| self.members[message.group].contains(p));
        let result = call(&self.client, || {
            Command::Send(self.peers[0].principal.clone(), request.clone())
        })
        .await;
        if !authorized {
            assert_auth_error(result);
        } else if conflict {
            assert!(matches!(
                result,
                Err(OperationError::Store(StoreError::IdempotencyConflict))
            ));
        } else {
            let Response::Saved(receipt) = result.unwrap() else {
                panic!()
            };
            assert_eq!(receipt, message.original);
        }
    }
    async fn membership(&mut self, g: usize, p: usize) {
        let active = !self.members[g].contains(&p);
        self.log(&format!("membership group={g} peer={p} active={active}"));
        let Response::Group(group) = call(&self.client, || {
            Command::Membership(
                self.owner.clone(),
                self.groups[g].group_id.clone(),
                self.peers[p].record.peer_id.clone(),
                active,
                self.groups[g].policy_revision,
            )
        })
        .await
        .unwrap() else {
            panic!()
        };
        assert_eq!(
            group.policy_revision.get(),
            self.groups[g].policy_revision.get() + 1
        );
        self.groups[g] = group;
        if active {
            self.members[g].insert(p);
        } else {
            self.members[g].remove(&p);
        }
    }
    async fn pause(&mut self, g: usize) {
        let mut expected = self.groups[g].clone();
        let previous_policy_revision = expected.policy_revision;
        let requested_paused = !expected.paused;
        expected.paused = requested_paused;
        expected.policy_revision = Revision::new(previous_policy_revision.get() + 1).unwrap();
        self.log(&format!(
            "pause group={g} requested={requested_paused} previous_policy={}",
            previous_policy_revision.get()
        ));
        let Response::Group(group) = call(&self.client, || {
            Command::Pause(
                self.owner.clone(),
                expected.group_id.clone(),
                requested_paused,
                previous_policy_revision,
            )
        })
        .await
        .unwrap() else {
            panic!()
        };
        // Check the transition and stable group identity before advancing the
        // oracle using only the expected state captured before the operation.
        assert_eq!(
            group, expected,
            "pause transition or stable identity differs"
        );
        self.groups[g] = expected;
    }
    async fn live(&mut self, p: usize) {
        let mut expected = self.peers[p].record.clone();
        let expected_binding_revision = expected.revision;
        let requested_live = !expected.is_live;
        expected.is_live = requested_live;
        expected.model_metadata = None;
        self.log(&format!(
            "live peer={p} requested={requested_live} binding={}",
            expected_binding_revision.get()
        ));
        let Response::Binding(record) = call(&self.client, || {
            Command::UpdatePeer(
                self.owner.clone(),
                expected.peer_id.clone(),
                expected_binding_revision,
                PeerMetadataUpdate {
                    model_metadata: None,
                    is_live: requested_live,
                },
            )
        })
        .await
        .unwrap() else {
            panic!()
        };
        // Equality includes the unchanged binding revision and every stable
        // peer/process identity field, as well as the requested mutable fields.
        assert_eq!(
            record, expected,
            "live transition or stable identity differs"
        );
        self.peers[p].record = expected;
    }
    async fn continuation(&mut self, p: usize) {
        self.log(&format!("continue peer={p}"));
        let old = self.peers[p].record.revision.get();
        let evidence = VerifiedContinuation::trusted(
            &self.peers[p].record,
            binding(&self.peers[p].record.conversation_id),
            "synthetic verified branch".into(),
        )
        .unwrap();
        let policies = self
            .groups
            .iter()
            .enumerate()
            .filter(|(g, _)| self.members[*g].contains(&p))
            .map(|(_, g)| (g.group_id.clone(), g.policy_revision))
            .collect::<BTreeMap<_, _>>();
        let Response::Enrolled(peer) = call(&self.client, || {
            Command::Continue(
                self.owner.clone(),
                evidence.clone(),
                format!("intent-{}", self.step),
                policies.clone(),
            )
        })
        .await
        .unwrap() else {
            panic!()
        };
        assert_eq!(peer.record.revision.get(), old + 1);
        self.peers[p] = peer;
        for message in &mut self.messages {
            if self.members[message.group].contains(&p) {
                if let Some(d) = message.deliveries.get_mut(&p) {
                    if d.binding == old && !d.fetched && !d.acked && d.ready {
                        d.binding += 1;
                        d.generation += 1;
                    }
                }
            }
        }
    }
    async fn ack(&mut self, g: usize, p: usize, index: usize) {
        self.log(&format!("ack group={g} peer={p} index={index}"));
        let current = self.peers[p].record.revision.get();
        let eligible = self.messages[index].group == g
            && self.messages[index]
                .deliveries
                .get(&p)
                .is_some_and(|d| d.binding == current);
        let result = call(&self.client, || {
            Command::Acknowledge(
                self.peers[p].principal.clone(),
                self.groups[g].group_id.clone(),
                self.messages[index].original.message_id.clone(),
            )
        })
        .await;
        if !self.allowed(g, p) || !eligible {
            assert_auth_error(result);
            return;
        }
        self.messages[index].deliveries.get_mut(&p).unwrap().acked = true;
        let mut frontier = 0;
        for m in self.messages.iter().filter(|m| m.group == g) {
            if let Some(d) = m.deliveries.get(&p) {
                if d.binding == current {
                    if !d.acked {
                        break;
                    }
                    frontier = m.original.group_sequence;
                }
            }
        }
        let Response::Acknowledged(ack) = result.unwrap() else {
            panic!()
        };
        assert_eq!(
            ack.generation.get(),
            self.messages[index].deliveries[&p].generation
        );
        assert_eq!(
            ack.contiguous_group_sequence, frontier,
            "mixed-generation frontier"
        );
    }
    async fn mailbox(&mut self, g: usize, p: usize, append: bool) {
        self.log(&format!("mailbox group={g} peer={p} append={append}"));
        let current = self.peers[p].record.revision.get();
        let expected: Vec<_> = self
            .messages
            .iter()
            .enumerate()
            .filter(|(_, m)| {
                m.group == g && m.deliveries.get(&p).is_some_and(|d| d.binding == current)
            })
            .map(|(i, _)| i)
            .collect();
        let mut cursor = None;
        let mut observed = Vec::new();
        let mut first = true;
        let mut high = None;
        loop {
            let result = call(&self.client, || {
                Command::Mailbox(
                    self.peers[p].principal.clone(),
                    MailboxPageRequest {
                        group_id: self.groups[g].group_id.clone(),
                        cursor: cursor.clone(),
                        max_items: 3,
                    },
                )
            })
            .await;
            if !self.allowed(g, p) {
                assert_auth_error(result);
                return;
            }
            let Response::Mailbox(page) = result.unwrap() else {
                panic!()
            };
            if let Some(high) = high {
                assert_eq!(page.snapshot_high_sequence, high)
            } else {
                high = Some(page.snapshot_high_sequence);
            }
            for entry in page.messages {
                let index = expected[observed.len()];
                let message = &mut self.messages[index];
                let delivery = message.deliveries.get_mut(&p).unwrap();
                assert_eq!(entry.message.message_id, message.original.message_id);
                assert!(
                    entry.message.body == message.request.body,
                    "message payload differs (redacted)"
                );
                assert_eq!(entry.receipt.generation.get(), delivery.generation);
                assert_eq!(
                    entry.receipt.acknowledged_at_millis.is_some(),
                    delivery.acked
                );
                assert!(entry.receipt.fetched_at_millis.is_some());
                delivery.fetched = true;
                observed.push(index);
            }
            cursor = page.next_cursor;
            if first && append && p != 0 && self.members[g].contains(&p) {
                self.send(g, [p].into()).await;
            }
            first = false;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(observed, expected);
    }
    async fn stale_snapshot(&mut self, g: usize, p: usize, continue_binding: bool) {
        self.log(&format!(
            "stale_snapshot group={g} peer={p} continue_binding={continue_binding}"
        ));
        let Response::Mailbox(page) = call(&self.client, || {
            Command::Mailbox(
                self.peers[p].principal.clone(),
                MailboxPageRequest {
                    group_id: self.groups[g].group_id.clone(),
                    cursor: None,
                    max_items: 1,
                },
            )
        })
        .await
        .unwrap() else {
            panic!()
        };
        let entry = &page.messages[0];
        let message = self
            .messages
            .iter_mut()
            .find(|m| m.original.message_id == entry.message.message_id)
            .unwrap();
        message.deliveries.get_mut(&p).unwrap().fetched = true;
        let cursor = page.next_cursor.expect("scripted snapshot has more items");
        if continue_binding {
            self.continuation(p).await;
        } else {
            self.membership(g, p).await;
            self.membership(g, p).await;
        }
        let result = call(&self.client, || {
            Command::Mailbox(
                self.peers[p].principal.clone(),
                MailboxPageRequest {
                    group_id: self.groups[g].group_id.clone(),
                    cursor: Some(cursor.clone()),
                    max_items: 1,
                },
            )
        })
        .await;
        assert!(matches!(
            result,
            Err(OperationError::Store(
                termx_swarm_core::error::StoreError::StaleCursor
            ))
        ));
    }
    async fn native(&mut self, g: usize, p: usize, delayed: bool) {
        self.log(&format!("native group={g} peer={p} delayed={delayed}"));
        let current = self.peers[p].record.revision.get();
        let expected: Vec<_> = if self.allowed(g, p) {
            self.messages
                .iter()
                .enumerate()
                .filter(|(_, m)| {
                    m.group == g
                        && m.deliveries.get(&p).is_some_and(|d| {
                            d.binding == current && !d.fetched && !d.acked && d.ready
                        })
                })
                .map(|(i, _)| i)
                .take(128)
                .collect()
        } else {
            Vec::new()
        };
        let Response::Candidates(candidates) = call(&self.client, || {
            Command::Candidates(
                self.owner.clone(),
                self.groups[g].group_id.clone(),
                self.peers[p].record.peer_id.clone(),
                self.peers[p].record.revision,
                128,
            )
        })
        .await
        .unwrap() else {
            panic!()
        };
        assert_eq!(
            candidates
                .iter()
                .map(|c| c.message_id())
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|i| &self.messages[*i].original.message_id)
                .collect::<Vec<_>>()
        );
        if let Some(candidate) = candidates.first() {
            let index = expected[0];
            let Response::Ticket(ticket) = call(&self.client, || {
                Command::Begin(self.owner.clone(), candidate.clone())
            })
            .await
            .unwrap() else {
                panic!()
            };
            self.messages[index].deliveries.get_mut(&p).unwrap().ready = false;
            if delayed {
                call(&self.client, || {
                    Command::Complete(
                        self.owner.clone(),
                        ticket.attempt_id().clone(),
                        AttemptOutcome::Uncertain,
                    )
                })
                .await
                .unwrap();
                let proof = VerifiedNotSubmitted::trusted(
                    ticket.attempt_id().clone(),
                    format!("proof-{}", self.step),
                )
                .unwrap();
                call(&self.client, || {
                    Command::Reconcile(self.owner.clone(), proof.clone())
                })
                .await
                .unwrap();
                self.messages[index].deliveries.get_mut(&p).unwrap().ready = true;
                self.continuation(p).await;
                call(&self.client, || {
                    Command::Complete(
                        self.owner.clone(),
                        ticket.attempt_id().clone(),
                        AttemptOutcome::NativeQueued,
                    )
                })
                .await
                .unwrap();
                call(&self.client, || {
                    Command::Reconcile(self.owner.clone(), proof.clone())
                })
                .await
                .unwrap();
            } else {
                call(&self.client, || {
                    Command::Complete(
                        self.owner.clone(),
                        ticket.attempt_id().clone(),
                        AttemptOutcome::Held,
                    )
                })
                .await
                .unwrap();
            }
        }
    }
    async fn finish(mut self) {
        let Response::Inspection(i) = call(&self.client, || Command::Inspect).await.unwrap() else {
            panic!()
        };
        assert!(i.integrity_ok);
        writeln!(
            self.trace,
            "PASS steps={} metrics={:?}",
            self.step,
            self.client.metrics()
        )
        .unwrap();
        self.worker.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn deterministic_collection_reference_model() {
    for seed in [0x5eed_u64, 0xc0ffee, 0x6171a5d] {
        let mut m = Model::new(seed).await;
        let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
        // One binding contains generations 3,2,1. Highest-first ACK cannot skip
        // either earlier eligible delivery; replay of an older generation is safe.
        let first = m.send(0, [1].into()).await.unwrap();
        m.continuation(1).await;
        let second = m.send(0, [1].into()).await.unwrap();
        m.continuation(1).await;
        let third = m.send(0, [1].into()).await.unwrap();
        m.ack(0, 1, third).await;
        m.ack(0, 1, first).await;
        m.ack(0, 1, second).await;
        m.ack(0, 1, first).await;
        m.send(0, [2].into()).await;
        m.native(0, 2, true).await;
        m.native(0, 2, false).await;
        for _ in 0..6 {
            m.send(0, [1].into()).await;
        }
        m.stale_snapshot(0, 1, false).await;
        m.stale_snapshot(0, 1, true).await;
        for _ in 0..240 {
            let g = rng.gen_range(0..2);
            let p = rng.gen_range(1..6);
            match rng.gen_range(0..11) {
                0 | 1 => {
                    let q = rng.gen_range(1..6);
                    m.send(g, [p, q].into()).await;
                }
                2 => m.membership(g, p).await,
                3 => m.pause(g).await,
                4 => m.live(p).await,
                5 => m.continuation(p).await,
                6 => m.mailbox(g, p, true).await,
                7 => {
                    let index = rng.gen_range(0..m.messages.len());
                    m.ack(g, p, index).await;
                }
                8 => {
                    let index = rng.gen_range(0..m.messages.len());
                    m.retry(index, rng.gen()).await;
                }
                9 => m.native(g, p, rng.gen()).await,
                _ => m.mailbox(g, p, false).await,
            }
        }
        for g in 0..2 {
            if m.groups[g].paused {
                m.pause(g).await;
            }
            for p in 1..6 {
                if !m.peers[p].record.is_live {
                    m.live(p).await;
                }
                m.mailbox(g, p, false).await;
            }
        }
        m.finish().await;
    }
}
