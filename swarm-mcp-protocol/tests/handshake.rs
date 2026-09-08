use termx_swarm_mcp_protocol::{
    AdmitError, CancelDisposition, Disposition, InitializedDisposition, Limits, Phase,
    ProtocolSession, RequestClass, RequestId, ResponseOutcome,
};

fn parse(raw: &[u8]) -> RequestId {
    RequestId::parse_json_token(raw).expect("token")
}

fn session() -> ProtocolSession {
    ProtocolSession::new(Limits::suggested()).expect("limits")
}

#[test]
fn ping_is_admitted_in_every_open_phase_and_not_after_close() {
    let session = session();
    assert_eq!(session.phase(), Phase::Uninitialized);
    let (ping, disposition) = session.admit(parse(b"10"), RequestClass::Ping).unwrap();
    assert_eq!(disposition, Disposition::Ping);
    ping.response_sent(ResponseOutcome::ProtocolComplete);

    let (init, disposition) = session
        .admit(parse(b"1"), RequestClass::Initialize)
        .unwrap();
    assert_eq!(disposition, Disposition::Initialize);
    assert_eq!(session.phase(), Phase::Initializing);
    let (ping, disposition) = session.admit(parse(b"11"), RequestClass::Ping).unwrap();
    assert_eq!(disposition, Disposition::Ping);
    ping.response_sent(ResponseOutcome::ProtocolComplete);

    init.response_sent(ResponseOutcome::InitializeSuccess);
    assert_eq!(session.phase(), Phase::AwaitingInitialized);
    let (ping, disposition) = session.admit(parse(b"12"), RequestClass::Ping).unwrap();
    assert_eq!(disposition, Disposition::Ping);
    ping.response_sent(ResponseOutcome::ProtocolComplete);

    assert_eq!(
        session.initialized_notification(),
        InitializedDisposition::BecameReady
    );
    let (ping, disposition) = session.admit(parse(b"13"), RequestClass::Ping).unwrap();
    assert_eq!(disposition, Disposition::Ping);
    ping.response_sent(ResponseOutcome::ProtocolComplete);

    session.close();
    assert_eq!(session.phase(), Phase::Closed);
    assert_eq!(
        session.admit(parse(b"14"), RequestClass::Ping).map(|_| ()),
        Err(AdmitError::Closed)
    );
}

#[test]
fn ordinary_ready_only_work_is_phase_error_before_ready() {
    let session = session();
    let (lease, disposition) = session.admit(parse(b"2"), RequestClass::ReadyOnly).unwrap();
    assert_eq!(disposition, Disposition::CorrelatedPhaseError);
    assert_eq!(session.phase(), Phase::Uninitialized);
    assert_eq!(session.active_count(), 1);
    lease.response_sent(ResponseOutcome::ProtocolComplete);
    assert_eq!(session.active_count(), 0);

    let (init, _) = session
        .admit(parse(b"1"), RequestClass::Initialize)
        .unwrap();
    let (lease, disposition) = session.admit(parse(b"3"), RequestClass::ReadyOnly).unwrap();
    assert_eq!(disposition, Disposition::CorrelatedPhaseError);
    lease.response_sent(ResponseOutcome::ProtocolComplete);
    init.response_sent(ResponseOutcome::InitializeSuccess);
    let (lease, disposition) = session.admit(parse(b"4"), RequestClass::ReadyOnly).unwrap();
    assert_eq!(disposition, Disposition::CorrelatedPhaseError);
    lease.response_sent(ResponseOutcome::ProtocolComplete);

    session.initialized_notification();
    let (lease, disposition) = session.admit(parse(b"5"), RequestClass::ReadyOnly).unwrap();
    assert_eq!(disposition, Disposition::OrdinaryReady);
    lease.response_sent(ResponseOutcome::ProtocolComplete);
}

#[test]
fn early_and_duplicate_initialized_notifications_do_not_promote_or_reset() {
    let session = session();
    assert_eq!(
        session.initialized_notification(),
        InitializedDisposition::Ignored
    );
    assert_eq!(session.phase(), Phase::Uninitialized);

    let (init, _) = session
        .admit(parse(b"1"), RequestClass::Initialize)
        .unwrap();
    assert_eq!(
        session.initialized_notification(),
        InitializedDisposition::Ignored
    );
    assert_eq!(session.phase(), Phase::Initializing);

    init.response_sent(ResponseOutcome::InitializeSuccess);
    assert_eq!(
        session.initialized_notification(),
        InitializedDisposition::BecameReady
    );
    assert_eq!(session.phase(), Phase::Ready);
    assert_eq!(
        session.initialized_notification(),
        InitializedDisposition::Ignored
    );
    assert_eq!(session.phase(), Phase::Ready);
}

#[test]
fn initialize_error_send_allows_retry_and_drop_closes() {
    let session = session();
    let (init, _) = session
        .admit(parse(b"1"), RequestClass::Initialize)
        .unwrap();
    init.response_sent(ResponseOutcome::InitializeError);
    assert_eq!(session.phase(), Phase::Uninitialized);
    assert_eq!(session.active_count(), 0);

    let (init, _) = session
        .admit(parse(b"2"), RequestClass::Initialize)
        .unwrap();
    assert_eq!(session.phase(), Phase::Initializing);
    drop(init);
    assert_eq!(session.phase(), Phase::Closed);
    assert_eq!(
        session
            .admit(parse(b"3"), RequestClass::Initialize)
            .map(|_| ()),
        Err(AdmitError::Closed)
    );
}

#[test]
fn second_initialize_error_or_drop_cannot_reset_original_handshake() {
    let session = session();
    let (original, disposition) = session
        .admit(parse(b"1"), RequestClass::Initialize)
        .unwrap();
    assert_eq!(disposition, Disposition::Initialize);
    assert_eq!(session.phase(), Phase::Initializing);

    let (second, disposition) = session
        .admit(parse(b"2"), RequestClass::Initialize)
        .unwrap();
    assert_eq!(disposition, Disposition::CorrelatedPhaseError);
    second.response_sent(ResponseOutcome::InitializeError);
    assert_eq!(session.phase(), Phase::Initializing);
    assert_eq!(session.active_count(), 1);

    let (third, disposition) = session
        .admit(parse(b"3"), RequestClass::Initialize)
        .unwrap();
    assert_eq!(disposition, Disposition::CorrelatedPhaseError);
    drop(third);
    assert_eq!(session.phase(), Phase::Initializing);
    assert_eq!(session.active_count(), 1);

    original.response_sent(ResponseOutcome::InitializeSuccess);
    assert_eq!(session.phase(), Phase::AwaitingInitialized);
}

#[test]
fn closed_late_initialize_send_cannot_reopen() {
    let session = session();
    let (original, _) = session
        .admit(parse(b"1"), RequestClass::Initialize)
        .unwrap();
    session.close();
    assert_eq!(session.phase(), Phase::Closed);
    original.response_sent(ResponseOutcome::InitializeSuccess);
    assert_eq!(session.phase(), Phase::Closed);
    assert_eq!(
        session.initialized_notification(),
        InitializedDisposition::Ignored
    );
    assert_eq!(
        session.admit(parse(b"2"), RequestClass::Ping).map(|_| ()),
        Err(AdmitError::Closed)
    );
}

#[test]
fn initialize_cancellation_is_ignored_and_leaves_lease_intact() {
    let session = session();
    let id = parse(b"1");
    let (init, _) = session.admit(id.clone(), RequestClass::Initialize).unwrap();
    assert_eq!(session.cancel(&id), CancelDisposition::IgnoredInitialize);
    assert!(!init.cancellation_requested());
    assert_eq!(session.phase(), Phase::Initializing);
    assert_eq!(session.active_count(), 1);
    init.response_sent(ResponseOutcome::InitializeSuccess);
    assert_eq!(session.phase(), Phase::AwaitingInitialized);
}

#[test]
fn protocol_complete_on_original_initialize_closes_helper() {
    let session = session();
    let (init, disposition) = session
        .admit(parse(b"1"), RequestClass::Initialize)
        .unwrap();
    assert_eq!(disposition, Disposition::Initialize);
    init.response_sent(ResponseOutcome::ProtocolComplete);
    assert_eq!(session.phase(), Phase::Closed);
    assert_eq!(session.active_count(), 0);
    assert_eq!(
        session.initialized_notification(),
        InitializedDisposition::Ignored
    );
    assert_eq!(
        session
            .admit(parse(b"2"), RequestClass::ReadyOnly)
            .map(|_| ()),
        Err(AdmitError::Closed)
    );
}

#[test]
fn only_explicit_initialize_success_advances_and_error_retries() {
    let success_session = session();
    let (init, _) = success_session
        .admit(parse(b"1"), RequestClass::Initialize)
        .unwrap();
    init.response_sent(ResponseOutcome::InitializeSuccess);
    assert_eq!(success_session.phase(), Phase::AwaitingInitialized);

    let retry_session = session();
    let (init, _) = retry_session
        .admit(parse(b"1"), RequestClass::Initialize)
        .unwrap();
    init.response_sent(ResponseOutcome::InitializeError);
    assert_eq!(retry_session.phase(), Phase::Uninitialized);
    let (retry, disposition) = retry_session
        .admit(parse(b"2"), RequestClass::Initialize)
        .unwrap();
    assert_eq!(disposition, Disposition::Initialize);
    assert_eq!(retry_session.phase(), Phase::Initializing);
    retry.response_sent(ResponseOutcome::InitializeSuccess);
    assert_eq!(retry_session.phase(), Phase::AwaitingInitialized);
}

#[test]
fn phase_error_leases_do_not_own_handshake_transition() {
    let session = session();
    let (original, _) = session
        .admit(parse(b"1"), RequestClass::Initialize)
        .unwrap();
    assert_eq!(session.phase(), Phase::Initializing);

    let (second, disposition) = session
        .admit(parse(b"2"), RequestClass::Initialize)
        .unwrap();
    assert_eq!(disposition, Disposition::CorrelatedPhaseError);
    second.response_sent(ResponseOutcome::InitializeSuccess);
    assert_eq!(session.phase(), Phase::Initializing);
    assert_eq!(session.active_count(), 1);

    let (third, disposition) = session
        .admit(parse(b"3"), RequestClass::Initialize)
        .unwrap();
    assert_eq!(disposition, Disposition::CorrelatedPhaseError);
    third.response_sent(ResponseOutcome::ProtocolComplete);
    assert_eq!(session.phase(), Phase::Initializing);

    let (ordinary, disposition) = session.admit(parse(b"4"), RequestClass::ReadyOnly).unwrap();
    assert_eq!(disposition, Disposition::CorrelatedPhaseError);
    ordinary.response_sent(ResponseOutcome::InitializeError);
    assert_eq!(session.phase(), Phase::Initializing);
    assert_eq!(session.active_count(), 1);

    original.response_sent(ResponseOutcome::InitializeSuccess);
    assert_eq!(session.phase(), Phase::AwaitingInitialized);
}

#[test]
fn every_initialize_class_lease_ignores_cancellation() {
    let session = session();
    let original_id = parse(b"1");
    let second_id = parse(b"2");
    let ping_id = parse(b"10");
    let (original, _) = session
        .admit(original_id.clone(), RequestClass::Initialize)
        .unwrap();
    let (second, disposition) = session
        .admit(second_id.clone(), RequestClass::Initialize)
        .unwrap();
    assert_eq!(disposition, Disposition::CorrelatedPhaseError);
    let (ping, _) = session.admit(ping_id.clone(), RequestClass::Ping).unwrap();

    assert_eq!(
        session.cancel(&original_id),
        CancelDisposition::IgnoredInitialize
    );
    assert_eq!(
        session.cancel(&second_id),
        CancelDisposition::IgnoredInitialize
    );
    assert!(!original.cancellation_requested());
    assert!(!second.cancellation_requested());
    assert_eq!(session.cancel(&ping_id), CancelDisposition::Marked);
    assert!(ping.cancellation_requested());
    assert_eq!(session.active_count(), 3);

    ping.response_sent(ResponseOutcome::ProtocolComplete);
    second.response_sent(ResponseOutcome::ProtocolComplete);
    original.response_sent(ResponseOutcome::InitializeSuccess);
    assert_eq!(
        session.initialized_notification(),
        InitializedDisposition::BecameReady
    );

    let late_id = parse(b"3");
    let (late, disposition) = session
        .admit(late_id.clone(), RequestClass::Initialize)
        .unwrap();
    assert_eq!(disposition, Disposition::CorrelatedPhaseError);
    let ready_id = parse(b"20");
    let (ready, _) = session
        .admit(ready_id.clone(), RequestClass::ReadyOnly)
        .unwrap();
    assert_eq!(
        session.cancel(&late_id),
        CancelDisposition::IgnoredInitialize
    );
    assert!(!late.cancellation_requested());
    assert_eq!(session.cancel(&ready_id), CancelDisposition::Marked);
    assert!(ready.cancellation_requested());
    assert_eq!(session.active_count(), 2);
    late.response_sent(ResponseOutcome::ProtocolComplete);
    ready.response_sent(ResponseOutcome::ProtocolComplete);
    assert_eq!(session.active_count(), 0);
}

#[test]
fn protocol_version_constant_is_the_implemented_revision() {
    assert_eq!(termx_swarm_mcp_protocol::PROTOCOL_VERSION, "2025-11-25");
}
