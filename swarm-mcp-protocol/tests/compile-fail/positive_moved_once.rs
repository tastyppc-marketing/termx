use termx_swarm_mcp_protocol::*;

fn main() {
    let session = ProtocolSession::new(Limits::suggested()).unwrap();
    let id = RequestId::parse_json_token(b"1").unwrap();
    let (lease, _) = session.admit(id, RequestClass::Initialize).unwrap();
    lease.response_sent(ResponseOutcome::InitializeSuccess);
}
