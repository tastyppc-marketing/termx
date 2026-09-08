use serde::{de::DeserializeOwned, Serialize};
use std::{
    alloc::Layout,
    ops::Deref,
    sync::{atomic::AtomicUsize, Arc, Mutex},
};

/// Allocation-request size of an `Arc<T>` payload on this target.
///
/// Uses the current std `ArcInner` header of two `AtomicUsize` reference
/// counts followed by `T` at its required alignment, then padded to that
/// alignment. This is an audited Windows/std layout assumption for the
/// installed Rust 1.97 toolchain; review it on toolchain or target changes.
/// Does not inspect or cast `Arc` memory.
pub(crate) fn padded_arc_allocation_bytes<T: Sized>() -> usize {
    Layout::new::<[AtomicUsize; 2]>()
        .extend(Layout::new::<T>())
        .expect("Arc inner layout overflow")
        .0
        .pad_to_align()
        .size()
}

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
    #[error("reserved send token does not belong to this connection")]
    WrongConnection,
    #[error("frame body exceeds reserved send capacity")]
    ReservationTooSmall,
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

impl FramePermit {
    /// Heap allocation-request layout of the shared budget mutex `Arc`.
    ///
    /// `BudgetState` is three scalar counters behind `std::sync::Mutex`. On
    /// this Windows/std futex mutex the poison flag and native state are
    /// inline; the payload owns no connection, watch, buffer, or collection.
    pub(crate) fn shared_state_arc_heap_bytes() -> usize {
        padded_arc_allocation_bytes::<Mutex<BudgetState>>()
    }
}

#[cfg(test)]
pub(crate) struct SharedBudgetWeak {
    inner: std::sync::Weak<Mutex<BudgetState>>,
}

#[cfg(test)]
impl SharedBudgetWeak {
    pub(crate) fn can_upgrade(&self) -> bool {
        self.inner.upgrade().is_some()
    }
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
    #[cfg(test)]
    pub(crate) fn downgrade_shared_state(&self) -> SharedBudgetWeak {
        SharedBudgetWeak {
            inner: Arc::downgrade(&self.state),
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[repr(align(64))]
    struct OverAligned(u8);

    #[test]
    fn padded_arc_layout_includes_payload_alignment_padding() {
        let sample = OverAligned(7);
        assert_eq!(sample.0, 7);
        let header = std::mem::size_of::<[AtomicUsize; 2]>();
        let payload = std::mem::size_of_val(&sample);
        let naive = header + payload;
        let actual = padded_arc_allocation_bytes::<OverAligned>();
        assert!(
            actual > naive,
            "layout {actual} must exceed naive header+payload {naive}"
        );
        let expected = Layout::new::<[AtomicUsize; 2]>()
            .extend(Layout::new::<OverAligned>())
            .expect("over-aligned test layout")
            .0
            .pad_to_align()
            .size();
        assert_eq!(actual, expected);
        assert_eq!(std::mem::align_of::<OverAligned>(), 64);
        assert_eq!(payload, 64);
    }

    #[test]
    fn budget_mutex_arc_layout_is_fixed_scalar_payload() {
        let mutex_size = std::mem::size_of::<Mutex<BudgetState>>();
        let mutex_align = std::mem::align_of::<Mutex<BudgetState>>();
        let state_size = std::mem::size_of::<BudgetState>();
        let state_align = std::mem::align_of::<BudgetState>();
        let heap = FramePermit::shared_state_arc_heap_bytes();
        assert_eq!(state_size, 3 * std::mem::size_of::<usize>());
        assert!(mutex_size >= state_size);
        assert!(heap > mutex_size);
        assert_eq!(heap, padded_arc_allocation_bytes::<Mutex<BudgetState>>());
        assert_ne!(mutex_align, 0);
        assert_ne!(state_align, 0);
    }
}
