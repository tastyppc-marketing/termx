//! Finite in-process destination budget with counted RAII permits.
//!
//! Test support only. Task 3 wraps its real shared frame budget permit in
//! `OwnedDestinationCredits`; this budget exists so the core can prove permit
//! ownership, exact release on every path and exhaustion without a native
//! transport. It is deliberately not a production API.

use std::sync::{Arc, Mutex};

use termx_swarm_core::model::OwnedDestinationCredits;

#[derive(Clone, Debug)]
pub struct TestBudget {
    used: Arc<Mutex<usize>>,
    limit: usize,
}

/// One counted reservation. Dropping it returns exactly its bytes.
#[derive(Debug)]
pub struct TestPermit {
    used: Arc<Mutex<usize>>,
    bytes: usize,
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
        let mut used = self.used.lock().unwrap_or_else(|e| e.into_inner());
        if bytes == 0 || *used + bytes > self.limit {
            return None;
        }
        *used += bytes;
        Some(TestPermit {
            used: Arc::clone(&self.used),
            bytes,
        })
    }

    pub fn usage(&self) -> usize {
        *self.used.lock().unwrap_or_else(|e| e.into_inner())
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
}
