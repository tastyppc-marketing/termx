//! Hard-capped byte ring buffer. Memory bounded BY DESIGN — this cap is the
//! stability guarantee, not an optimization. Offsets are absolute stream
//! positions so replay and live frames can be deduped after reattach.

use std::collections::VecDeque;

pub struct RingBuffer {
    buf: VecDeque<u8>,
    cap: usize,
    total_written: u64,
}

impl RingBuffer {
    pub fn new(cap: usize) -> Self {
        assert!(cap > 0, "ring cap must be positive");
        Self {
            buf: VecDeque::with_capacity(cap.min(64 * 1024)),
            cap,
            total_written: 0,
        }
    }

    pub fn push(&mut self, data: &[u8]) {
        self.push_evicting(data, None);
    }

    /// `push`, but handing the bytes that fall out of the window to `evicted`
    /// in stream order — the disk-spill path (`crate::history`) needs them, and
    /// only the ring knows exactly which bytes left the window.
    ///
    /// Both eviction sources are reported: the front of the buffer, and (for a
    /// push larger than the whole ring) the prefix of `data` that never fits.
    /// The buffer is strictly older than that prefix, so appending in this
    /// order keeps the spill file in stream order.
    pub fn push_evicting(&mut self, data: &[u8], evicted: Option<&mut Vec<u8>>) {
        self.total_written += data.len() as u64;
        // Only the last `cap` bytes of `data` can survive; skip the rest cheaply.
        let skipped = data.len().saturating_sub(self.cap);
        let keep = &data[skipped..];
        let overflow = (self.buf.len() + keep.len()).saturating_sub(self.cap);
        if let Some(sink) = evicted {
            sink.extend(self.buf.iter().take(overflow).copied());
            sink.extend_from_slice(&data[..skipped]);
        }
        self.buf.drain(..overflow);
        self.buf.extend(keep);
    }

    pub fn snapshot(&self) -> (u64, Vec<u8>) {
        let start = self.total_written - self.buf.len() as u64;
        (start, self.buf.iter().copied().collect())
    }

    pub fn end_offset(&self) -> u64 {
        self.total_written
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_under_cap_verbatim() {
        let mut r = RingBuffer::new(10);
        r.push(b"hello");
        let (start, bytes) = r.snapshot();
        assert_eq!(start, 0);
        assert_eq!(bytes, b"hello");
        assert_eq!(r.end_offset(), 5);
    }

    #[test]
    fn evicts_oldest_beyond_cap() {
        let mut r = RingBuffer::new(5);
        r.push(b"abcdefgh"); // 8 bytes into cap 5 -> keep "defgh"
        let (start, bytes) = r.snapshot();
        assert_eq!(start, 3);
        assert_eq!(bytes, b"defgh");
        assert_eq!(r.len(), 5);
        assert_eq!(r.end_offset(), 8);
    }

    #[test]
    fn eviction_spans_multiple_pushes() {
        let mut r = RingBuffer::new(4);
        r.push(b"ab");
        r.push(b"cd");
        r.push(b"ef"); // total 6, cap 4 -> keep "cdef"
        let (start, bytes) = r.snapshot();
        assert_eq!(start, 2);
        assert_eq!(bytes, b"cdef");
    }

    #[test]
    fn push_larger_than_cap_keeps_tail() {
        let mut r = RingBuffer::new(3);
        r.push(b"0123456789");
        let (start, bytes) = r.snapshot();
        assert_eq!(start, 7);
        assert_eq!(bytes, b"789");
        assert_eq!(r.end_offset(), 10);
    }

    /// The spill file is built from these bytes, so what leaves the window must
    /// come out contiguous, in order, and exactly once.
    #[test]
    fn evicted_bytes_are_handed_out_in_stream_order() {
        let mut r = RingBuffer::new(4);
        let mut evicted = Vec::new();
        r.push_evicting(b"abc", Some(&mut evicted));
        assert!(evicted.is_empty(), "nothing has left the window yet");
        r.push_evicting(b"def", Some(&mut evicted));
        assert_eq!(evicted, b"ab", "the oldest two bytes fell out");
        let (start, kept) = r.snapshot();
        assert_eq!((start, kept), (2, b"cdef".to_vec()));
    }

    /// A push bigger than the whole ring evicts the entire buffer AND the part
    /// of the push that never fit — both belong in history, in that order.
    #[test]
    fn a_push_larger_than_the_ring_evicts_buffer_then_unfitting_prefix() {
        let mut r = RingBuffer::new(3);
        let mut evicted = Vec::new();
        r.push_evicting(b"AB", Some(&mut evicted));
        r.push_evicting(b"0123456789", Some(&mut evicted));
        assert_eq!(evicted, b"AB0123456");
        let (start, kept) = r.snapshot();
        assert_eq!((start, kept.as_slice()), (9, b"789".as_slice()));
        assert_eq!(
            evicted.len() as u64 + kept.len() as u64,
            r.end_offset(),
            "every byte ever written is either retained or evicted, never both"
        );
    }

    #[test]
    fn memory_never_exceeds_cap_under_firehose() {
        let mut r = RingBuffer::new(64 * 1024);
        for i in 0..100_000u64 {
            r.push(format!("line {i}\r\n").as_bytes());
        }
        assert!(r.len() <= 64 * 1024);
        assert!(r.end_offset() > 64 * 1024);
    }
}
