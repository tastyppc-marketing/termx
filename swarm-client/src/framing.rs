use serde::{de::DeserializeOwned, Serialize};
use std::{
    ops::Deref,
    sync::{Arc, Mutex},
};

pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum WireError {
    #[error("frame exceeds limit")]
    FrameTooLarge,
    #[error("frame length mismatch")]
    LengthMismatch,
    #[error("invalid frame")]
    InvalidFrame,
    #[error("frame capacity unavailable")]
    Capacity,
    #[error("pipe disconnected")]
    Disconnected,
    #[error("named pipe remained busy until the connection deadline")]
    ConnectTimeout,
    #[error("transport handshake deadline expired")]
    HandshakeTimeout,
    #[error("transport authentication rejected")]
    AuthenticationRejected,
    #[error("transport connection is no longer reusable")]
    ConnectionPoisoned,
    #[error("accepted client identity is unavailable")]
    ClientIdentityUnavailable,
    #[error("named-pipe server identity does not match the expected process generation")]
    ServerIdentityMismatch,
    #[error("named-pipe server identity could not be verified")]
    ServerIdentityUnavailable,
    #[error("operation is invalid for this pipe endpoint")]
    WrongEndpoint,
    #[error("acceptor replacement is temporarily unavailable")]
    Transient,
    #[error("named pipe is currently busy")]
    PipeBusy,
    #[error("pipe I/O failed")]
    Io,
    #[error("native operation failed ({0})")]
    Native(u32),
}

pub fn encode_frame<T: WireMessage + Serialize>(value: &T) -> Result<Vec<u8>, WireError> {
    let body = encode_message_body(value)?;
    let mut out = Vec::with_capacity(body.len() + 4);
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend(body);
    Ok(out)
}
pub(crate) fn encode_body<T: Serialize>(value: &T) -> Result<Vec<u8>, WireError> {
    let body = serde_json::to_vec(value).map_err(|_| WireError::InvalidFrame)?;
    if body.len() > MAX_FRAME_BYTES {
        return Err(WireError::FrameTooLarge);
    }
    Ok(body)
}
pub(crate) fn encode_message_body<T: WireMessage + Serialize>(
    value: &T,
) -> Result<Vec<u8>, WireError> {
    if !value.valid() {
        return Err(WireError::InvalidFrame);
    }
    encode_body(value)
}
pub trait WireMessage: private::Sealed + DeserializeOwned {
    fn valid(&self) -> bool;
}
mod private {
    pub trait Sealed {}
}
impl private::Sealed for crate::RequestEnvelope {}
impl WireMessage for crate::RequestEnvelope {
    fn valid(&self) -> bool {
        self.valid()
    }
}
impl private::Sealed for crate::ResponseEnvelope {}
impl WireMessage for crate::ResponseEnvelope {
    fn valid(&self) -> bool {
        self.valid()
    }
}
pub fn decode_frame<T: WireMessage>(frame: &[u8]) -> Result<T, WireError> {
    if frame.len() < 4 {
        return Err(WireError::LengthMismatch);
    }
    let declared = u32::from_le_bytes(frame[..4].try_into().unwrap()) as usize;
    if declared > MAX_FRAME_BYTES {
        return Err(WireError::FrameTooLarge);
    }
    if frame.len() != declared + 4 {
        return Err(WireError::LengthMismatch);
    }
    decode_body(&frame[4..])
}
pub(crate) fn decode_body<T: WireMessage>(body: &[u8]) -> Result<T, WireError> {
    if body.len() > MAX_FRAME_BYTES {
        return Err(WireError::FrameTooLarge);
    }
    let mut de = serde_json::Deserializer::from_slice(body);
    let value = T::deserialize(&mut de).map_err(|_| WireError::InvalidFrame)?;
    de.end().map_err(|_| WireError::InvalidFrame)?;
    if !value.valid() {
        return Err(WireError::InvalidFrame);
    }
    Ok(value)
}

#[derive(Clone)]
/// Aggregate admission for retained frame bytes and accepted connections.
///
/// Server consumers must size and own this budget for their expected load. On
/// receive, a capacity error after the length prefix is connection-fatal; it is
/// neither an application rollback signal nor permission to resend a request.
pub struct FrameBudget {
    state: Arc<Mutex<BudgetState>>,
    byte_limit: usize,
    connection_limit: usize,
}
#[derive(Default)]
struct BudgetState {
    bytes: usize,
    frames: usize,
    connections: usize,
}
pub struct FramePermit {
    state: Arc<Mutex<BudgetState>>,
    bytes: usize,
}
pub(crate) struct ConnectionPermit {
    state: Arc<Mutex<BudgetState>>,
}
pub struct ReceivedFrame {
    pub(crate) bytes: Vec<u8>,
    pub(crate) _permit: FramePermit,
}
impl FrameBudget {
    pub fn new(limit: usize) -> Self {
        Self::with_limits(limit, 64)
    }
    pub fn with_limits(byte_limit: usize, connection_limit: usize) -> Self {
        Self {
            state: Arc::new(Mutex::new(BudgetState::default())),
            byte_limit,
            connection_limit,
        }
    }
    pub fn reserve(&self, bytes: usize) -> Result<FramePermit, WireError> {
        let mut s = self.state.lock().unwrap();
        if s.bytes
            .checked_add(bytes)
            .is_none_or(|sum| sum > self.byte_limit)
        {
            return Err(WireError::Capacity);
        }
        s.bytes += bytes;
        s.frames += 1;
        Ok(FramePermit {
            state: self.state.clone(),
            bytes,
        })
    }
    pub fn usage(&self) -> (usize, usize) {
        let state = self.state.lock().unwrap();
        (state.bytes, state.frames)
    }
    pub fn connection_usage(&self) -> usize {
        self.state.lock().unwrap().connections
    }
    pub(crate) fn reserve_connection(&self) -> Result<ConnectionPermit, WireError> {
        let mut state = self.state.lock().unwrap();
        if state.connections >= self.connection_limit {
            return Err(WireError::Capacity);
        }
        state.connections += 1;
        Ok(ConnectionPermit {
            state: self.state.clone(),
        })
    }
}
impl Drop for FramePermit {
    fn drop(&mut self) {
        let mut s = self.state.lock().unwrap();
        s.bytes -= self.bytes;
        s.frames -= 1;
    }
}
impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.state.lock().unwrap().connections -= 1;
    }
}
impl AsRef<[u8]> for ReceivedFrame {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}
impl Deref for ReceivedFrame {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        &self.bytes
    }
}
