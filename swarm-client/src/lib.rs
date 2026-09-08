#[cfg(not(windows))]
compile_error!("termx-swarm-client supports Windows only");

#[cfg(windows)]
mod discovery;
#[cfg(windows)]
mod framing;
#[cfg(windows)]
mod identity;
#[cfg(windows)]
mod pipe;
#[cfg(windows)]
mod security;
#[cfg(windows)]
mod wire;

#[cfg(windows)]
pub use framing::{
    decode_frame, encode_frame, FrameBudget, FramePermit, ReceivedFrame, WireError, WireMessage,
    MAX_FRAME_BYTES,
};
#[cfg(windows)]
pub use identity::resolve_verified_enrolled_ancestor;
#[cfg(windows)]
pub use identity::{
    resolve_enrolled_ancestor, AncestryError, ProcessError, ProcessIdentity, ProcessSnapshot,
    VerifiedProcess,
};
#[cfg(windows)]
pub use pipe::{
    FrameCreditHandle, PipeServer, ReservedFrameSend, TransportOptions, VerifiedPipe,
    DEFAULT_CONNECT_RETRY_INTERVAL, DEFAULT_CONNECT_TIMEOUT, DEFAULT_HANDSHAKE_TIMEOUT,
};

#[cfg(windows)]
#[doc(hidden)]
pub fn assert_deserialize_owned<T: serde::de::DeserializeOwned>() {}

#[cfg(windows)]
pub use security::{AuthorityClaim, AuthorityError, ClientBootstrap, OwnerCredential};
#[cfg(windows)]
pub use wire::{
    DecimalU64, DiscoveryRecord, Hello, RequestEnvelope, ResponseEnvelope, DISCOVERY_VERSION,
    WIRE_VERSION,
};

#[cfg(windows)]
pub struct OwnerClient {
    pipe: VerifiedPipe,
}

#[cfg(windows)]
pub struct PeerClient {
    pipe: VerifiedPipe,
}
#[cfg(windows)]
impl OwnerClient {
    /// Connects, verifies the server generation, completes the versioned boot
    /// hello, and waits for the strict private owner-auth acceptance frame.
    pub async fn connect(
        discovery: &DiscoveryRecord,
        credential: &OwnerCredential,
    ) -> Result<Self, WireError> {
        Self::connect_with_options(discovery, credential, TransportOptions::default()).await
    }
    pub async fn connect_with_options(
        discovery: &DiscoveryRecord,
        credential: &OwnerCredential,
        options: TransportOptions,
    ) -> Result<Self, WireError> {
        Ok(Self {
            pipe: pipe::connect_owner(discovery, credential, options).await?,
        })
    }
    pub fn server_identity(&self) -> ProcessIdentity {
        self.pipe.server_identity()
    }
    pub async fn send_request(&self, request: &RequestEnvelope) -> Result<(), WireError> {
        self.pipe.send_request(request).await
    }
    pub async fn recv_response(&self) -> Result<ResponseEnvelope, WireError> {
        self.pipe.recv_response().await
    }
    /// The authenticated owner connection for domain-level framing.
    pub fn pipe(&self) -> &VerifiedPipe {
        &self.pipe
    }
    pub fn into_pipe(self) -> VerifiedPipe {
        self.pipe
    }
}
#[cfg(windows)]
impl PeerClient {
    pub async fn connect(discovery: &DiscoveryRecord) -> Result<Self, WireError> {
        Self::connect_with_options(discovery, TransportOptions::default()).await
    }
    pub async fn connect_with_options(
        discovery: &DiscoveryRecord,
        options: TransportOptions,
    ) -> Result<Self, WireError> {
        Ok(Self {
            pipe: pipe::connect_peer(discovery, options).await?,
        })
    }
    pub fn server_identity(&self) -> ProcessIdentity {
        self.pipe.server_identity()
    }
    pub async fn send_request(&self, request: &RequestEnvelope) -> Result<(), WireError> {
        self.pipe.send_request(request).await
    }
    pub async fn recv_response(&self) -> Result<ResponseEnvelope, WireError> {
        self.pipe.recv_response().await
    }
    /// The boot-verified peer connection for domain-level framing. The hello
    /// proves the boot generation only; it never identifies an enrolled peer.
    pub fn pipe(&self) -> &VerifiedPipe {
        &self.pipe
    }
    pub fn into_pipe(self) -> VerifiedPipe {
        self.pipe
    }
}
