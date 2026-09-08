use super::{fixture::*, transitions};
use std::time::{Duration, Instant};
use termx_swarm_core::{error::StoreError, model::*, worker::*};
use tokio::task::JoinSet;

#[derive(Default)]
struct Slot {
    last: Option<(SendMessageRequest, SendReceipt)>,
}
enum Expected {
    Saved(SendMessageRequest, u64, PeerPrincipal),
    Retry(SendReceipt),
    Conflict,
    Page(usize),
    Ack(usize),
    Candidates,
}
fn check(response: Result<Response, OperationError>, expected: Expected, slot: &mut Slot) -> bool {
    match expected {
        Expected::Saved(request, sequence, principal) => {
            let Response::Saved(receipt) = response.unwrap() else {
                panic!("saved")
            };
            check_saved(&receipt, &request, sequence, &principal);
            slot.last = Some((request, receipt));
            false
        }
        Expected::Retry(receipt) => {
            let Response::Saved(actual) = response.unwrap() else {
                panic!("retry")
            };
            assert_eq!(receipt, actual);
            false
        }
        Expected::Conflict => {
            assert!(matches!(
                response,
                Err(OperationError::Store(StoreError::IdempotencyConflict))
            ));
            true
        }
        Expected::Page(group) => {
            let Response::Mailbox(page) = response.unwrap() else {
                panic!("page")
            };
            check_page(&page, group, 0, None);
            false
        }
        Expected::Ack(group) => {
            let Response::Acknowledged(ack) = response.unwrap() else {
                panic!("ack")
            };
            assert_eq!(
                ack.contiguous_group_sequence,
                if group == 0 { 1 } else { 0 }
            );
            false
        }
        Expected::Candidates => {
            let Response::Candidates(values) = response.unwrap() else {
                panic!("candidates")
            };
            assert!(values.len() <= 16);
            false
        }
    }
}
#[derive(Default, serde::Serialize)]
struct Counts {
    offered: u64,
    admitted: u64,
    completed: u64,
    expected_conflicts: u64,
    driver_busy: u64,
    admission: [u64; 6],
    latency_buckets: [u64; 8],
}
fn admission_index(error: AdmissionError) -> usize {
    match error {
        AdmissionError::Closed => 0,
        AdmissionError::Contended => 1,
        AdmissionError::Requests => 2,
        AdmissionError::RequestBytes => 3,
        AdmissionError::Responses => 4,
        AdmissionError::ResponseBytes => 5,
    }
}
fn complete(
    result: Result<(usize, Slot, bool, u128), tokio::task::JoinError>,
    slots: &mut [Option<Slot>],
    counts: &mut Counts,
) {
    let (index, slot, expected_error, ms) = result.unwrap();
    slots[index] = Some(slot);
    counts.completed += 1;
    counts.expected_conflicts += u64::from(expected_error);
    let bucket = [1, 4, 16, 64, 256, 1024, 4096]
        .iter()
        .position(|&bound| ms <= bound)
        .unwrap_or(7);
    counts.latency_buckets[bucket] += 1;
}
pub async fn run(client: &Client, fixture: &mut Fixture, seconds: u64) {
    let mut slots: Vec<_> = (0..8).map(|_| Some(Slot::default())).collect();
    let mut tasks = JoinSet::new();
    let mut serial = 0_u64;
    for (phase, rate) in [10_u64, 50, 100].into_iter().enumerate() {
        let mut counts = Counts::default();
        let start = Instant::now();
        let before = client.metrics();
        emit(
            serde_json::json!({"event":"phase_start","phase":phase,"rate":rate,"seconds":seconds,"next_sequences":fixture.next,"metrics":before}),
        );
        let total = seconds * rate;
        for tick in 0..total {
            let deadline = start + Duration::from_secs_f64(tick as f64 / rate as f64);
            tokio::time::sleep_until(deadline.into()).await;
            while let Some(result) = tasks.try_join_next() {
                complete(result, &mut slots, &mut counts);
            }
            counts.offered += 1;
            serial += 1;
            let index = (serial % 8) as usize;
            let group = index % 2;
            let Some(mut slot) = slots[index].take() else {
                counts.driver_busy += 1;
                emit(
                    serde_json::json!({"event":"offer","serial":serial,"phase":phase,"slot":index,"result":"driver_busy"}),
                );
                continue;
            };
            // A deterministic LCG permutation avoids a fixed operation per client.
            let kind = ((serial.wrapping_mul(6364136223846793005).wrapping_add(24301) >> 32) % 10)
                as usize;
            let (command, expected) = match slot.last.as_ref().filter(|_| kind >= 4) {
                None => {
                    let sequence = fixture.next[group];
                    let request = fixture.request(group, sequence);
                    let principal = fixture.sender(group);
                    (
                        Command::Send(principal.clone(), request.clone()),
                        Expected::Saved(request, sequence, principal),
                    )
                }
                Some((request, receipt)) => match kind {
                    4 => (
                        Command::Send(fixture.sender(group), request.clone()),
                        Expected::Retry(receipt.clone()),
                    ),
                    5 => {
                        let mut conflict = request.clone();
                        conflict.body.push('!');
                        (
                            Command::Send(fixture.sender(group), conflict),
                            Expected::Conflict,
                        )
                    }
                    6 | 9 => (fixture.mailbox(group, None, 128), Expected::Page(group)),
                    7 => (
                        Command::Acknowledge(
                            fixture.recipient(group),
                            fixture.groups[group].group_id.clone(),
                            receipt.message_id.clone(),
                        ),
                        Expected::Ack(group),
                    ),
                    _ => (
                        Command::Candidates(
                            fixture.owner.clone(),
                            fixture.groups[group].group_id.clone(),
                            fixture.recipient(group).peer_id().clone(),
                            fixture.recipient(group).binding_revision(),
                            16,
                        ),
                        Expected::Candidates,
                    ),
                },
            };
            let sent = Instant::now();
            match client.submit(command) {
                Ok(pending) => {
                    emit(
                        serde_json::json!({"event":"offer","serial":serial,"phase":phase,"slot":index,"kind":kind,"result":"admitted","new_sequence":if matches!(expected,Expected::Saved(..)){Some(fixture.next[group])}else{None}}),
                    );
                    counts.admitted += 1;
                    if matches!(expected, Expected::Saved(..)) {
                        fixture.next[group] += 1;
                    }
                    tasks.spawn(async move {
                        let response = pending.await;
                        let ms = sent.elapsed().as_millis();
                        let error = check(response, expected, &mut slot);
                        (index, slot, error, ms)
                    });
                }
                Err(error) => {
                    emit(
                        serde_json::json!({"event":"offer","serial":serial,"phase":phase,"slot":index,"kind":kind,"result":format!("{error:?}")}),
                    );
                    counts.admission[admission_index(error)] += 1;
                    slots[index] = Some(slot);
                }
            }
            if tick % (rate * 5) == 0 {
                emit(
                    serde_json::json!({"event":"sample","phase":phase,"elapsed_ms":start.elapsed().as_millis(),"counts":counts,"next_sequences":fixture.next,"metrics":client.metrics()}),
                );
            }
        }
        tokio::time::sleep_until((start + Duration::from_secs(seconds)).into()).await;
        while let Some(result) = tasks.join_next().await {
            complete(result, &mut slots, &mut counts);
        }
        assert_eq!(
            counts.offered,
            counts.admitted + counts.driver_busy + counts.admission.iter().sum::<u64>()
        );
        assert_eq!(counts.admitted, counts.completed);
        emit(
            serde_json::json!({"event":"phase_end","phase":phase,"elapsed_ms":start.elapsed().as_millis(),"counts":counts,"metrics":client.metrics()}),
        );
        // All accepted requests are joined: this is an actual lifecycle barrier.
        transitions::run(client, fixture).await;
    }
}
