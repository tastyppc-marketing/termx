//! Finite in-process destination budget with counted RAII permits.
//!
//! Test support only. Task 3 wraps its real shared frame budget permit in
//! `OwnedDestinationCredits`; this budget exists so the core can prove permit
//! ownership, exact release on every path and exhaustion without a native
//! transport. It is deliberately not a production API.

use std::mem::size_of;
use std::sync::{Arc, Mutex};

use termx_swarm_core::model::OwnedDestinationCredits;

#[derive(Clone, Debug)]
pub struct TestBudget {
    used: Arc<Mutex<usize>>,
    limit: usize,
}

/// One counted reservation. Dropping it returns exactly its bytes.
///
/// `metadata` is a real heap allocation the permit retains for its lifetime
/// (a transport permit might keep a frame header or route record); the guard
/// must report its measured capacity, never a fake zero.
#[derive(Debug)]
pub struct TestPermit {
    used: Arc<Mutex<usize>>,
    bytes: usize,
    metadata: Vec<u8>,
}

impl TestBudget {
    pub fn new(limit: usize) -> Self {
        Self {
            used: Arc::new(Mutex::new(0)),
            limit,
        }
    }

    /// Nonblocking reservation; `None` when the budget cannot cover `bytes`.
    pub fn reserve(&self, bytes: usize) -> Option<TestPermit> {
        self.reserve_with_metadata(bytes, 0)
    }

    /// Reservation whose permit additionally owns `metadata_bytes` of actual
    /// heap capacity for its whole lifetime.
    pub fn reserve_with_metadata(&self, bytes: usize, metadata_bytes: usize) -> Option<TestPermit> {
        let mut used = self.used.lock().unwrap_or_else(|e| e.into_inner());
        if bytes == 0 || *used + bytes > self.limit {
            return None;
        }
        *used += bytes;
        Some(TestPermit {
            used: Arc::clone(&self.used),
            bytes,
            metadata: Vec::with_capacity(metadata_bytes),
        })
    }

    pub fn usage(&self) -> usize {
        *self.used.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl TestPermit {
    /// Conservative bound on the shared `Arc<Mutex<usize>>` allocation this
    /// permit keeps alive: two reference counters plus the mutex cell, rounded
    /// up to a 16-byte allocator granule.
    pub const SHARED_COUNTER_BYTES: usize =
        (2 * size_of::<usize>() + size_of::<Mutex<usize>>()).next_multiple_of(16);

    /// Heap this permit retains beyond its inline size: the measured metadata
    /// capacity plus its share of the budget counter.
    pub fn retained_heap_bytes(&self) -> usize {
        self.metadata.capacity() + Self::SHARED_COUNTER_BYTES
    }
}

impl Drop for TestPermit {
    fn drop(&mut self) {
        let mut used = self.used.lock().unwrap_or_else(|e| e.into_inner());
        *used -= self.bytes;
    }
}

impl OwnedDestinationCredits for TestPermit {
    fn reserved_bytes(&self) -> usize {
        self.bytes
    }

    /// Honest accounting: the metadata capacity is fixed at reservation and
    /// the `Arc` share is a constant, so this bound is stable for the permit's
    /// lifetime. The inline `TestPermit` size is counted by the constructor.
    fn owned_heap_bytes(&self) -> usize {
        self.retained_heap_bytes()
    }
}
