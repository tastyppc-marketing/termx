use termx_swarm_mcp_protocol::{
    AdmitError, Disposition, Limits, LimitsError, Phase, ProtocolSession, RequestClass, RequestId,
    ResponseOutcome,
};

fn parse(raw: &[u8]) -> RequestId {
    RequestId::parse_json_token(raw).expect("token")
}

fn ready(limits: Limits) -> ProtocolSession {
    let session = ProtocolSession::new(limits).expect("limits");
    let (init, _) = session
        .admit(parse(b"1"), RequestClass::Initialize)
        .unwrap();
    init.response_sent(ResponseOutcome::InitializeSuccess);
    session.initialized_notification();
    session
}

#[test]
fn limits_are_validated_before_allocation() {
    assert_eq!(
        ProtocolSession::new(Limits {
            active: 1,
            control_reserve: 0,
        })
        .map(|_| ()),
        Err(LimitsError::ActiveOutOfRange)
    );
    assert_eq!(
        ProtocolSession::new(Limits {
            active: 65,
            control_reserve: 1,
        })
        .map(|_| ()),
        Err(LimitsError::ActiveOutOfRange)
    );
    assert_eq!(
        ProtocolSession::new(Limits {
            active: 8,
            control_reserve: 0,
        })
        .map(|_| ()),
        Err(LimitsError::ControlReserveInvalid)
    );
    assert_eq!(
        ProtocolSession::new(Limits {
            active: 8,
            control_reserve: 8,
        })
        .map(|_| ()),
        Err(LimitsError::ControlReserveInvalid)
    );
    assert!(ProtocolSession::new(Limits::suggested()).is_ok());
    assert!(ProtocolSession::new(Limits {
        active: 2,
        control_reserve: 1,
    })
    .is_ok());
    assert!(ProtocolSession::new(Limits {
        active: 64,
        control_reserve: 1,
    })
    .is_ok());
}

#[test]
fn ordinary_work_cannot_consume_control_reserve_but_ping_can() {
    let session = ready(Limits {
        active: 4,
        control_reserve: 2,
    });
    let snap = session.accounting();
    assert_eq!(snap.slot_capacity, 4);
    assert_eq!(snap.control_reserve, 2);
    assert_eq!(snap.ordinary_available, 2);
    assert_eq!(snap.control_available, 4);

    let (a, d) = session
        .admit(parse(b"10"), RequestClass::ReadyOnly)
        .unwrap();
    assert_eq!(d, Disposition::OrdinaryReady);
    let (b, d) = session
        .admit(parse(b"11"), RequestClass::ReadyOnly)
        .unwrap();
    assert_eq!(d, Disposition::OrdinaryReady);
    assert_eq!(
        session
            .admit(parse(b"12"), RequestClass::ReadyOnly)
            .map(|_| ()),
        Err(AdmitError::Capacity)
    );
    assert_eq!(session.phase(), Phase::Ready);
    assert_eq!(session.active_count(), 2);

    let (ping, d) = session.admit(parse(b"13"), RequestClass::Ping).unwrap();
    assert_eq!(d, Disposition::Ping);
    assert_eq!(session.active_count(), 3);
    let (ping2, d) = session.admit(parse(b"14"), RequestClass::Ping).unwrap();
    assert_eq!(d, Disposition::Ping);
    assert_eq!(
        session.admit(parse(b"15"), RequestClass::Ping).map(|_| ()),
        Err(AdmitError::Capacity)
    );

    drop(a);
    assert_eq!(session.active_count(), 3);
    let (ordinary, d) = session
        .admit(parse(b"16"), RequestClass::ReadyOnly)
        .unwrap();
    assert_eq!(d, Disposition::OrdinaryReady);
    ordinary.response_sent(ResponseOutcome::ProtocolComplete);
    b.response_sent(ResponseOutcome::ProtocolComplete);
    ping.response_sent(ResponseOutcome::ProtocolComplete);
    ping2.response_sent(ResponseOutcome::ProtocolComplete);
    assert_eq!(session.active_count(), 0);
}

#[test]
fn pre_ready_phase_errors_use_control_class_slots() {
    let session = ProtocolSession::new(Limits {
        active: 3,
        control_reserve: 2,
    })
    .unwrap();
    let (init, _) = session
        .admit(parse(b"1"), RequestClass::Initialize)
        .unwrap();
    let (err1, d) = session.admit(parse(b"2"), RequestClass::ReadyOnly).unwrap();
    assert_eq!(d, Disposition::CorrelatedPhaseError);
    let (err2, d) = session.admit(parse(b"3"), RequestClass::ReadyOnly).unwrap();
    assert_eq!(d, Disposition::CorrelatedPhaseError);
    assert_eq!(
        session.admit(parse(b"4"), RequestClass::Ping).map(|_| ()),
        Err(AdmitError::Capacity)
    );
    err1.response_sent(ResponseOutcome::ProtocolComplete);
    err2.response_sent(ResponseOutcome::ProtocolComplete);
    init.response_sent(ResponseOutcome::InitializeSuccess);
    assert_eq!(session.active_count(), 0);
}

#[test]
fn capacity_failure_has_no_side_effects_and_does_not_close() {
    let session = ready(Limits {
        active: 2,
        control_reserve: 1,
    });
    let (ordinary, _) = session
        .admit(parse(b"10"), RequestClass::ReadyOnly)
        .unwrap();
    let before = session.accounting();
    assert_eq!(
        session
            .admit(parse(b"11"), RequestClass::ReadyOnly)
            .map(|_| ()),
        Err(AdmitError::Capacity)
    );
    let after = session.accounting();
    assert_eq!(session.phase(), Phase::Ready);
    assert_eq!(after.active_registrations, before.active_registrations);
    assert_eq!(after.request_id_heap_bytes, before.request_id_heap_bytes);
    ordinary.response_sent(ResponseOutcome::ProtocolComplete);
}
