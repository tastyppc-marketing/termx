use termx_swarm_mcp_protocol::{ProtocolSession, RequestClass};

fn main() {
    let session: Option<&ProtocolSession> = None;
    if let Some(session) = session {
        let _ = session.admit_notification(RequestClass::ReadyOnly);
    }
}
