use super::fixture::*;
use std::time::Instant;
use termx_swarm_core::{model::*, worker::*};

pub async fn traverse(client: &Client, fixture: &Fixture, label: &str, group: usize) {
    let start = Instant::now();
    let mut pages = 0;
    let mut position = 0;
    let mut cursor = None;
    loop {
        let Response::Mailbox(page) =
            call(client, || fixture.mailbox(group, cursor.clone(), 128)).await
        else {
            panic!("mailbox")
        };
        check_page(&page, group, position, Some(fixture.next[group] - 1));
        position += page.messages.len() as u64;
        pages += 1;
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(position, fixture.next[group] - 1);
    emit(
        serde_json::json!({"event":label,"group":group,"elapsed_us":start.elapsed().as_micros(),"pages":pages,"messages":position,"api":"public frozen snapshot from sequence zero"}),
    );
}
pub async fn run(client: &Client, fixture: &Fixture) {
    // Worst sparse projection: a member with no eligible deliveries still has
    // to navigate the retained group range under this query plan.
    let sparse_start = Instant::now();
    for _ in 0..12 {
        let Response::Mailbox(page) = call(client, || {
            Command::Mailbox(
                fixture.peers[3].principal.clone(),
                MailboxPageRequest {
                    group_id: fixture.groups[0].group_id.clone(),
                    cursor: None,
                    max_items: 128,
                },
            )
        })
        .await
        else {
            panic!("sparse page")
        };
        assert!(page.messages.is_empty() && page.next_cursor.is_none());
        assert_eq!(page.snapshot_high_sequence, fixture.next[0] - 1);
    }
    emit(
        serde_json::json!({"event":"empty_recipient_benchmark","repeats":12,"elapsed_us":sparse_start.elapsed().as_micros(),"group_history":fixture.next[0]-1,"eligible":0}),
    );
    for items in [1, 32, 128] {
        let mut total = 0;
        let mut minimum = u128::MAX;
        let mut maximum = 0;
        for _ in 0..12 {
            let start = Instant::now();
            let Response::Mailbox(page) = call(client, || fixture.mailbox(0, None, items)).await
            else {
                panic!("mailbox")
            };
            let elapsed = start.elapsed().as_micros();
            total += elapsed;
            minimum = minimum.min(elapsed);
            maximum = maximum.max(elapsed);
            check_page(&page, 0, 0, Some(fixture.next[0] - 1));
        }
        emit(
            serde_json::json!({"event":"page_benchmark","items":items,"repeats":12,"total_us":total,"min_us":minimum,"max_us":maximum}),
        );
    }
    traverse(client, fixture, "baseline_navigation", 0).await;
    let Response::Mailbox(page) = call(client, || fixture.mailbox(0, None, 1)).await else {
        panic!("mailbox")
    };
    let id = page.messages[0].message.message_id.clone();
    let mut first = None;
    for pass in 0..2 {
        let start = Instant::now();
        for _ in 0..100 {
            let Response::Acknowledged(ack) = call(client, || {
                Command::Acknowledge(
                    fixture.recipient(0),
                    fixture.groups[0].group_id.clone(),
                    id.clone(),
                )
            })
            .await
            else {
                panic!("ack")
            };
            assert_eq!(ack.contiguous_group_sequence, 1);
            if let Some(ref expected) = first {
                assert_eq!(&ack, expected);
            } else {
                first = Some(ack);
            }
        }
        emit(
            serde_json::json!({"event":"repeated_ack_benchmark","pass":pass,"repeats":100,"elapsed_us":start.elapsed().as_micros()}),
        );
    }
    // Separate bounded fixtures in this same test store; not part of load history.
    for (name, body) in [
        ("moderate", "x".repeat(4096)),
        ("unicode", "\u{1f980}".repeat(MAX_MESSAGE_BODY_BYTES / 4)),
        ("escaped", "\0".repeat(MAX_MESSAGE_BODY_BYTES)),
    ] {
        let Response::Group(group) = call(client, || {
            Command::CreateGroup(
                fixture.owner.clone(),
                format!("boundary-{name}"),
                [
                    fixture.peers[0].record.peer_id.clone(),
                    fixture.peers[1].record.peer_id.clone(),
                ]
                .into(),
            )
        })
        .await
        else {
            panic!("group")
        };
        let count = if name == "moderate" { 129 } else { 9 };
        for i in 0..count {
            call(client, || {
                Command::Send(
                    fixture.sender(0),
                    SendMessageRequest {
                        group_id: group.group_id.clone(),
                        client_key: format!("boundary-{i}"),
                        recipients: [fixture.recipient(0).peer_id().clone()].into(),
                        body: body.clone(),
                        topic: Some("\"\\\n\u{1f980}".into()),
                        reply_to: None,
                    },
                )
            })
            .await;
        }
        let start = Instant::now();
        let mut bytes = 0;
        let mut items = 0;
        for _ in 0..12 {
            let Response::Mailbox(page) = call(client, || {
                Command::Mailbox(
                    fixture.recipient(0),
                    MailboxPageRequest {
                        group_id: group.group_id.clone(),
                        cursor: None,
                        max_items: 128,
                    },
                )
            })
            .await
            else {
                panic!("mailbox")
            };
            bytes = serde_json::to_vec(&page).unwrap().len();
            items = page.messages.len();
            assert!(bytes <= MAX_MAILBOX_PAGE_BYTES && page.next_cursor.is_some());
            assert!(page.messages.iter().all(|e| e.message.body == body));
        }
        emit(
            serde_json::json!({"event":"boundary_benchmark","name":name,"repeats":12,"elapsed_us":start.elapsed().as_micros(),"items":items,"wire_bytes":bytes}),
        );
    }
}
