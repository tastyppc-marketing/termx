use termx_swarm_mcp_protocol::ActiveRequest;

fn needs_clone<T: Clone>(_: &T) {}

fn main() {
    let lease: Option<&ActiveRequest> = None;
    if let Some(lease) = lease {
        needs_clone(lease);
    }
}
