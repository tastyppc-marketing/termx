use termx_swarm_mcp_protocol::{
    AdmitError, CancelDisposition, Disposition, InitializedDisposition, Limits, Phase,
    ProtocolSession, RequestClass, RequestId, ResponseOutcome,
};

fn parse(raw: &[u8]) -> RequestId {
    RequestId::parse_json_token(raw).expect("token")
}

fn ready_session() -> ProtocolSession {
    let session = ProtocolSession::new(Limits::suggested()).expect("limits");
    let (init, _) = session
        .admit(parse(b"1"), RequestClass::Initialize)
        .unwrap();
    init.response_sent(ResponseOutcome::InitializeSuccess);
    assert_eq!(
        session.initialized_notification(),
        InitializedDisposition::BecameReady
    );
    session
}

struct HeldOutput {
    lease: termx_swarm_mcp_protocol::ActiveRequest,
}

impl HeldOutput {
    fn cancellation_requested(&self) -> bool {
        self.lease.cancellation_requested()
    }
}

#[test]
fn duplicate_active_id_closes_helper_and_creates_no_second_lease() {
    let session = ready_session();
    let id = parse(b"7");
    let (original, disposition) = session.admit(id.clone(), RequestClass::ReadyOnly).unwrap();
    assert_eq!(disposition, Disposition::OrdinaryReady);
    assert_eq!(
        session
            .admit(id.clone(), RequestClass::ReadyOnly)
            .map(|_| ()),
        Err(AdmitError::TerminalCollision)
    );
    assert_eq!(session.phase(), Phase::Closed);
    assert_eq!(session.active_count(), 1);
    assert_eq!(
        session.admit(parse(b"8"), RequestClass::Ping).map(|_| ()),
        Err(AdmitError::Closed)
    );
    original.response_sent(ResponseOutcome::ProtocolComplete);
    assert_eq!(session.active_count(), 0);
    assert_eq!(session.phase(), Phase::Closed);
}

#[test]
fn collision_is_detected_before_capacity_or_phase_rejection() {
    let session = ProtocolSession::new(Limits {
        active: 2,
        control_reserve: 1,
    })
    .unwrap();
    let init_id = parse(b"1");
    let ping_id = parse(b"2");
    let (init, _) = session
        .admit(init_id.clone(), RequestClass::Initialize)
        .unwrap();
    let (ping, disposition) = session.admit(ping_id, RequestClass::Ping).unwrap();
    assert_eq!(disposition, Disposition::Ping);
    assert_eq!(session.active_count(), 2);
    assert_eq!(
        session
            .admit(init_id.clone(), RequestClass::Initialize)
            .map(|_| ()),
        Err(AdmitError::TerminalCollision)
    );
    assert_eq!(session.phase(), Phase::Closed);
    assert_eq!(session.active_count(), 2);
    assert_eq!(init.id(), &init_id);
    drop(init);
    assert_eq!(session.active_count(), 1);
    ping.response_sent(ResponseOutcome::ProtocolComplete);
    assert_eq!(session.active_count(), 0);
}

#[test]
fn held_output_owner_keeps_id_through_collision_cancel_and_only_terminal_end_frees() {
    let session = ready_session();
    let id = parse(b"9");
    let (lease, _) = session.admit(id.clone(), RequestClass::ReadyOnly).unwrap();
    let held = HeldOutput { lease };
    assert_eq!(session.active_count(), 1);

    assert_eq!(
        session.admit(id.clone(), RequestClass::Ping).map(|_| ()),
        Err(AdmitError::TerminalCollision)
    );
    assert_eq!(session.phase(), Phase::Closed);
    assert_eq!(session.active_count(), 1);

    assert_eq!(session.cancel(&id), CancelDisposition::Marked);
    assert!(held.cancellation_requested());
    assert_eq!(session.active_count(), 1);

    drop(held);
    assert_eq!(session.active_count(), 0);
}

#[test]
fn cancel_marks_only_its_own_request_and_never_releases_slots() {
    let session = ready_session();
    let first = parse(b"2");
    let second = parse(b"3");
    let (a, _) = session
        .admit(first.clone(), RequestClass::ReadyOnly)
        .unwrap();
    let (b, _) = session
        .admit(second.clone(), RequestClass::ReadyOnly)
        .unwrap();
    assert_eq!(session.cancel(&first), CancelDisposition::Marked);
    assert_eq!(session.cancel(&first), CancelDisposition::Marked);
    assert!(a.cancellation_requested());
    assert!(!b.cancellation_requested());
    assert_eq!(session.active_count(), 2);
    assert_eq!(session.cancel(&parse(b"99")), CancelDisposition::Unknown);
    assert_eq!(session.active_count(), 2);
    a.response_sent(ResponseOutcome::ProtocolComplete);
    assert_eq!(session.active_count(), 1);
    assert!(!b.cancellation_requested());
    b.response_sent(ResponseOutcome::ProtocolComplete);
    assert_eq!(session.active_count(), 0);
    assert_eq!(session.cancel(&first), CancelDisposition::Unknown);
}

#[test]
fn close_prevents_admission_without_releasing_existing_leases() {
    let session = ready_session();
    let (lease, _) = session.admit(parse(b"4"), RequestClass::ReadyOnly).unwrap();
    session.close();
    assert_eq!(session.phase(), Phase::Closed);
    assert_eq!(session.active_count(), 1);
    assert_eq!(
        session.admit(parse(b"5"), RequestClass::Ping).map(|_| ()),
        Err(AdmitError::Closed)
    );
    lease.response_sent(ResponseOutcome::ProtocolComplete);
    assert_eq!(session.active_count(), 0);
}

#[test]
fn completed_sequences_do_not_grow_registration_state() {
    let session = ready_session();
    let before = session.accounting();
    for n in 0..400 {
        let token = n.to_string();
        let id = parse(token.as_bytes());
        let (lease, disposition) = session.admit(id, RequestClass::ReadyOnly).unwrap();
        assert_eq!(disposition, Disposition::OrdinaryReady);
        lease.response_sent(ResponseOutcome::ProtocolComplete);
    }
    let after = session.accounting();
    assert_eq!(after.active_registrations, 0);
    assert_eq!(after.slot_storage_bytes, before.slot_storage_bytes);
    assert_eq!(after.request_id_heap_bytes, before.request_id_heap_bytes);
    assert_eq!(
        after.shared_state_heap_bytes,
        before.shared_state_heap_bytes
    );
}

#[test]
fn session_handle_may_drop_while_leases_remain_valid() {
    let session = ProtocolSession::new(Limits::suggested()).unwrap();
    let keep = session.clone();
    let (lease, _) = session
        .admit(parse(b"1"), RequestClass::Initialize)
        .unwrap();
    drop(session);
    assert_eq!(keep.phase(), Phase::Initializing);
    assert_eq!(keep.active_count(), 1);
    lease.response_sent(ResponseOutcome::InitializeSuccess);
    assert_eq!(keep.phase(), Phase::AwaitingInitialized);
}

#[test]
fn invalid_completed_id_reuse_is_a_new_request_and_late_cancel_is_ambiguous() {
    let session = ready_session();
    let id = parse(b"7");
    let (lease, _) = session.admit(id.clone(), RequestClass::ReadyOnly).unwrap();
    lease.response_sent(ResponseOutcome::ProtocolComplete);
    assert_eq!(session.cancel(&id), CancelDisposition::Unknown);
    let (lease, _) = session.admit(id.clone(), RequestClass::ReadyOnly).unwrap();
    assert_eq!(session.cancel(&id), CancelDisposition::Marked);
    assert!(lease.cancellation_requested());
    lease.response_sent(ResponseOutcome::ProtocolComplete);
}

#[test]
fn dropped_phase_error_does_not_free_another_request() {
    let session = ProtocolSession::new(Limits::suggested()).unwrap();
    let (init, _) = session
        .admit(parse(b"1"), RequestClass::Initialize)
        .unwrap();
    let (phase_error, disposition) = session.admit(parse(b"2"), RequestClass::ReadyOnly).unwrap();
    assert_eq!(disposition, Disposition::CorrelatedPhaseError);
    drop(phase_error);
    assert_eq!(session.phase(), Phase::Initializing);
    assert_eq!(session.active_count(), 1);
    init.response_sent(ResponseOutcome::InitializeSuccess);
    assert_eq!(session.phase(), Phase::AwaitingInitialized);
}
