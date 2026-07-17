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
        self.total_written += data.len() as u64;
        // Only the last `cap` bytes of `data` can survive; skip the rest cheaply.
        let keep = if data.len() > self.cap {
            &data[data.len() - self.cap..]
        } else {
            data
        };
        let overflow = (self.buf.len() + keep.len()).saturating_sub(self.cap);
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
