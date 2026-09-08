use termx_swarm_mcp_protocol::*;

fn main() {
    let session = ProtocolSession::new(Limits::suggested()).unwrap();
    assert_eq!(session.phase(), Phase::Uninitialized);
    let id = RequestId::parse_json_token(b"1").unwrap();
    let (lease, disposition) = session.admit(id, RequestClass::Initialize).unwrap();
    assert_eq!(disposition, Disposition::Initialize);
    assert_eq!(session.phase(), Phase::Initializing);
    lease.response_sent(ResponseOutcome::InitializeSuccess);
    assert_eq!(session.phase(), Phase::AwaitingInitialized);
    assert_eq!(
        session.initialized_notification(),
        InitializedDisposition::BecameReady
    );
    assert_eq!(session.phase(), Phase::Ready);
    let ping_id = RequestId::parse_json_token(b"2").unwrap();
    let (ping, disposition) = session.admit(ping_id, RequestClass::Ping).unwrap();
    assert_eq!(disposition, Disposition::Ping);
    ping.response_sent(ResponseOutcome::ProtocolComplete);
}
