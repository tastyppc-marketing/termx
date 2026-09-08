//! Drives a page's serialized prefix to an exact byte target so that the
//! declared bound is exercised within one continuation-token width.
//!
//! The prefix is the first `max_items` entries of a page; one more entry
//! always exists beyond it, so the store must emit a continuation token. The
//! target is the bound plus a few bytes: the prefix without a token fits, the
//! prefix with a token does not. A correct sizer therefore excludes the last
//! prefix entry; a sizer that adds the token after sizing returns an oversized
//! envelope.

use termx_swarm_core::store::Store;

/// Escape-heavy knob content: each NUL serializes as six bytes.
pub const COARSE_MAX_CHARS: usize = 4096;
/// Fine knob content: plain ASCII, one byte per character.
pub const FINE_MAX_BYTES: usize = 4000;

/// A mutation that adds one fixed chunk to the prefix.
pub type Fill<'a> = Box<dyn FnMut(&mut Store) + 'a>;
/// A mutation that sets one sized value in the prefix.
pub type Knob<'a> = Box<dyn FnMut(&mut Store, usize) + 'a>;
/// Serialized size of the current prefix page including its token.
pub type Measure<'a> = Box<dyn FnMut(&mut Store) -> usize + 'a>;

pub struct Tuner<'a> {
    /// Bound plus a few bytes (the serialized prefix plus its token).
    pub target: usize,
    /// Each fill adds one large fixed chunk (a maximal escape-heavy value).
    pub fills: Vec<Fill<'a>>,
    /// Coarse knobs receive a NUL count in `1..=COARSE_MAX_CHARS`.
    pub coarse: Vec<Knob<'a>>,
    /// The fine knob receives an ASCII length in `1..=FINE_MAX_BYTES + 1`.
    pub fine: Knob<'a>,
    /// Serialized size of the current prefix page including its token.
    pub measure: Measure<'a>,
}

pub fn nul(chars: usize) -> String {
    "\u{0}".repeat(chars)
}

pub fn tune(store: &mut Store, mut tuner: Tuner<'_>) {
    let coarse_capacity = tuner.coarse.len() * 6 * (COARSE_MAX_CHARS - 1);
    for knob in tuner.coarse.iter_mut() {
        knob(store, 1);
    }
    (tuner.fine)(store, 1);
    let mut size = (tuner.measure)(store);
    for fill in tuner.fills.iter_mut() {
        let remaining = tuner
            .target
            .checked_sub(size)
            .expect("prefix already over target");
        if remaining <= coarse_capacity + FINE_MAX_BYTES {
            break;
        }
        fill(store);
        size = (tuner.measure)(store);
    }
    let mut remaining = tuner
        .target
        .checked_sub(size)
        .expect("prefix already over target");
    assert!(
        remaining <= coarse_capacity + FINE_MAX_BYTES,
        "fill phase overshot the tuning window: {remaining} bytes remain"
    );
    for knob in tuner.coarse.iter_mut() {
        let available = remaining.saturating_sub(FINE_MAX_BYTES / 2);
        let take = (available / 6).min(COARSE_MAX_CHARS - 1);
        if take == 0 {
            continue;
        }
        knob(store, 1 + take);
        remaining -= take * 6;
    }
    size = (tuner.measure)(store);
    let remaining = tuner
        .target
        .checked_sub(size)
        .expect("coarse phase overshot");
    assert!(
        (16..=FINE_MAX_BYTES).contains(&remaining),
        "coarse phase missed the fine window: {remaining} bytes remain"
    );
    (tuner.fine)(store, 1 + remaining);
}
