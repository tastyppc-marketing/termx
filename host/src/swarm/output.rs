//! Aggregate host output owner.
//!
//! The core's response reservation ends when a `Pending` yields its value;
//! from then on the decoded response, its DTO and the encoded frame are host
//! representations. This budget owns them: a permit is reserved before a
//! request is dispatched (so a request the host could not answer never has
//! side effects), resized to the actual simultaneous representation once the
//! frame is encoded, and released only after the frame was written or the
//! session dropped. A control headroom keeps small responses, error frames
//! and event hints flowing while large outputs are blocked on slow clients.

use std::sync::{Arc, Mutex};

/// Maximum one error/event/control representation admitted into headroom.
pub const CONTROL_OUTPUT_BYTES: usize = 256 * 1024;
pub const DEFAULT_OUTPUT_BUDGET_BYTES: usize = 128 * 1024 * 1024;
pub const DEFAULT_OUTPUT_HEADROOM_BYTES: usize = 4 * 1024 * 1024;

struct State {
    used: usize,
    high_water: usize,
    rejected: u64,
}

#[derive(Clone)]
pub struct OutputBudget {
    state: Arc<Mutex<State>>,
    limit: usize,
    headroom: usize,
}

/// Exactly `bytes` of aggregate output ownership; dropping returns them.
pub struct OutputPermit {
    state: Arc<Mutex<State>>,
    bytes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputPermitError {
    WouldGrow { reserved: usize, requested: usize },
}

impl std::fmt::Debug for OutputPermit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutputPermit")
            .field("bytes", &self.bytes)
            .finish()
    }
}

fn lock(state: &Mutex<State>) -> std::sync::MutexGuard<'_, State> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn admit(state: &mut State, ceiling: usize, bytes: usize) -> bool {
    match state.used.checked_add(bytes) {
        Some(used) if used <= ceiling => {
            state.used = used;
            state.high_water = state.high_water.max(used);
            true
        }
        _ => {
            state.rejected += 1;
            false
        }
    }
}

impl OutputBudget {
    pub fn new(limit: usize, headroom: usize) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                used: 0,
                high_water: 0,
                rejected: 0,
            })),
            limit,
            headroom: headroom.min(limit),
        }
    }

    fn reserve_with_ceiling(&self, bytes: usize, ceiling: usize) -> Option<OutputPermit> {
        let mut state = lock(&self.state);
        if !admit(&mut state, ceiling, bytes) {
            return None;
        }
        Some(OutputPermit {
            state: self.state.clone(),
            bytes,
        })
    }

    /// Reserves a decoded request or data response without consuming the
    /// headroom kept for bounded errors and revision hints.
    pub fn reserve_data(&self, bytes: usize) -> Option<OutputPermit> {
        self.reserve_with_ceiling(bytes, self.limit.saturating_sub(self.headroom))
    }

    /// Reserves one bounded control representation. Callers must classify
    /// the response before using this path; oversized values are rejected.
    pub fn reserve_control(&self, bytes: usize) -> Option<OutputPermit> {
        if bytes > CONTROL_OUTPUT_BYTES {
            lock(&self.state).rejected += 1;
            return None;
        }
        self.reserve_with_ceiling(bytes, self.limit)
    }

    pub fn usage(&self) -> usize {
        lock(&self.state).used
    }

    pub fn high_water(&self) -> usize {
        lock(&self.state).high_water
    }

    pub fn rejected(&self) -> u64 {
        lock(&self.state).rejected
    }

    pub fn limit(&self) -> usize {
        self.limit
    }

    pub fn headroom(&self) -> usize {
        self.headroom
    }
}

impl OutputPermit {
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// Releases capacity that a completed representation no longer needs.
    /// Admission is the sole point where capacity can grow: callers cannot
    /// allocate first and enlarge an existing permit afterwards.
    pub fn shrink_to(&mut self, bytes: usize) -> Result<(), OutputPermitError> {
        if bytes > self.bytes {
            return Err(OutputPermitError::WouldGrow {
                reserved: self.bytes,
                requested: bytes,
            });
        }
        let mut state = lock(&self.state);
        state.used -= self.bytes - bytes;
        self.bytes = bytes;
        Ok(())
    }
}

impl Drop for OutputPermit {
    fn drop(&mut self) {
        let mut state = lock(&self.state);
        state.used -= self.bytes;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_outputs_leave_control_headroom_and_release_exactly_once() {
        let budget = OutputBudget::new(1024 * 1024, 256 * 1024);
        let large = budget
            .reserve_data(700 * 1024)
            .expect("first large fits below headroom");
        assert!(
            budget.reserve_data(100 * 1024).is_none(),
            "a second large output cannot enter the headroom"
        );
        let control = budget
            .reserve_control(32 * 1024)
            .expect("control output uses headroom");
        assert_eq!(budget.usage(), 732 * 1024);
        drop(control);
        drop(large);
        assert_eq!(budget.usage(), 0);
        assert_eq!(budget.rejected(), 1);
        assert_eq!(budget.high_water(), 732 * 1024);
    }

    #[test]
    fn admitted_representation_can_only_release_surplus_capacity() {
        let budget = OutputBudget::new(1024, 0);
        let mut permit = budget.reserve_data(1000).unwrap();
        permit.shrink_to(200).unwrap();
        assert_eq!(budget.usage(), 200);
        let other = budget.reserve_data(800).unwrap();
        assert_eq!(
            permit.shrink_to(300),
            Err(OutputPermitError::WouldGrow {
                reserved: 200,
                requested: 300,
            }),
            "post-admission growth is forbidden even when another owner drops"
        );
        assert_eq!(permit.bytes(), 200);
        drop(other);
        assert_eq!(
            permit.shrink_to(300),
            Err(OutputPermitError::WouldGrow {
                reserved: 200,
                requested: 300,
            })
        );
        assert_eq!(budget.usage(), 200);
        drop(permit);
        assert_eq!(budget.usage(), 0);
    }

    #[test]
    fn aggregate_high_water_tracks_simultaneous_request_and_output_owners() {
        let budget = OutputBudget::new(4096, 512);
        let request = budget.reserve_data(768).expect("decoded request admitted");
        let output = budget
            .reserve_data(2048)
            .expect("response representation admitted");
        assert_eq!(budget.usage(), 2816);
        assert_eq!(budget.high_water(), 2816);
        assert!(
            budget.reserve_data(1024).is_none(),
            "a third large representation cannot consume control headroom"
        );
        drop(request);
        assert_eq!(budget.usage(), 2048);
        drop(output);
        assert_eq!(
            budget.usage(),
            0,
            "the last owner returns the exact aggregate charge"
        );
        assert_eq!(budget.high_water(), 2816);
        assert_eq!(budget.rejected(), 1);
    }

    #[test]
    fn control_admission_is_explicit_and_bounded() {
        let budget = OutputBudget::new(1024 * 1024, 256 * 1024);
        let data = budget.reserve_data(768 * 1024).unwrap();
        let control = budget.reserve_control(CONTROL_OUTPUT_BYTES).unwrap();
        assert_eq!(budget.usage(), 768 * 1024 + CONTROL_OUTPUT_BYTES);
        assert!(budget.reserve_control(CONTROL_OUTPUT_BYTES + 1).is_none());
        drop(control);
        drop(data);
        assert_eq!(budget.usage(), 0);
    }
}
