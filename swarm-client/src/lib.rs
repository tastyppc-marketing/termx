mod discovery;
mod framing;
mod identity;
#[cfg(windows)]
mod pipe;
mod security;
mod wire;

pub use framing::{
    decode_frame, encode_frame, FrameBudget, FramePermit, ReceivedFrame, WireError, WireMessage,
    MAX_FRAME_BYTES,
};
#[cfg(windows)]
pub use identity::resolve_verified_enrolled_ancestor;
pub use identity::{
    resolve_enrolled_ancestor, AncestryError, ProcessError, ProcessIdentity, ProcessSnapshot,
    VerifiedProcess,
};
#[cfg(windows)]
pub use pipe::{PipeServer, VerifiedPipe};
pub use security::{AuthorityClaim, AuthorityError, ClientBootstrap, OwnerCredential};
pub use wire::{
    DecimalU64, DiscoveryRecord, Hello, RequestEnvelope, ResponseEnvelope, WIRE_VERSION,
};

pub struct OwnerClient {
    pipe: VerifiedPipe,
}

pub struct PeerClient {
    pipe: VerifiedPipe,
}
impl OwnerClient {
    pub async fn connect(
        discovery: &DiscoveryRecord,
        credential: &OwnerCredential,
    ) -> Result<Self, WireError> {
        Ok(Self {
            pipe: pipe::connect_owner(discovery, credential).await?,
        })
    }
    pub fn server_identity(&self) -> ProcessIdentity {
        self.pipe.server_identity()
    }
    pub async fn send_request(&self, request: &RequestEnvelope) -> Result<(), WireError> {
        self.pipe.send_request(request).await
    }
    pub async fn recv_response(&mut self) -> Result<ResponseEnvelope, WireError> {
        self.pipe.recv_response().await
    }
}
impl PeerClient {
    pub async fn connect(discovery: &DiscoveryRecord) -> Result<Self, WireError> {
        Ok(Self {
            pipe: pipe::connect_peer(discovery).await?,
        })
    }
    pub fn server_identity(&self) -> ProcessIdentity {
        self.pipe.server_identity()
    }
    pub async fn send_request(&self, request: &RequestEnvelope) -> Result<(), WireError> {
        self.pipe.send_request(request).await
    }
    pub async fn recv_response(&mut self) -> Result<ResponseEnvelope, WireError> {
        self.pipe.recv_response().await
    }
}
