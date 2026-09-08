//! Bounded, lossy revision hints for owner subscribers.
//!
//! A hint carries the broker boot identifier and the full durable revision
//! tuple. Hints are advisory: a subscriber that observes a lag/overflow, a
//! different boot identifier or any revision it cannot reconcile must take a
//! fresh snapshot. Nothing here reads the store or blocks the SQLite writer.

use std::sync::atomic::{AtomicU64, Ordering};
use termx_swarm_core::model::StateRevisions;
use tokio::sync::broadcast;

/// Default number of hints retained per subscriber before overflow.
pub const DEFAULT_EVENT_CAPACITY: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventHint {
    pub boot_id: String,
    pub revisions: StateRevisions,
}

pub struct EventHub {
    boot_id: String,
    sender: broadcast::Sender<EventHint>,
    published: AtomicU64,
}

impl EventHub {
    pub fn new(boot_id: impl Into<String>, capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity.max(1));
        Self {
            boot_id: boot_id.into(),
            sender,
            published: AtomicU64::new(0),
        }
    }

    pub fn boot_id(&self) -> &str {
        &self.boot_id
    }

    /// Subscribe first, then snapshot: every hint published after this call
    /// is observed or reported as overflow.
    pub fn subscribe(&self) -> broadcast::Receiver<EventHint> {
        self.sender.subscribe()
    }

    /// Publishes one hint. Never blocks; with no subscribers the hint is
    /// dropped, and a lagging subscriber sees an overflow on its next read.
    pub fn publish(&self, revisions: StateRevisions) {
        self.published.fetch_add(1, Ordering::Relaxed);
        let _ = self.sender.send(EventHint {
            boot_id: self.boot_id.clone(),
            revisions,
        });
    }

    pub fn published(&self) -> u64 {
        self.published.load(Ordering::Relaxed)
    }

    pub fn subscribers(&self) -> usize {
        self.sender.receiver_count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use termx_swarm_core::model::Revision;

    fn revisions(n: u64) -> StateRevisions {
        StateRevisions {
            inventory_revision: Revision::new(n).unwrap(),
            delivery_revision: Revision::new(n).unwrap(),
            run_revision: None,
        }
    }

    #[tokio::test]
    async fn lagging_subscriber_observes_overflow_and_keeps_newest_hints() {
        let hub = EventHub::new("boot-a", 2);
        let mut subscriber = hub.subscribe();
        for n in 1..=5 {
            hub.publish(revisions(n));
        }
        assert!(matches!(
            subscriber.recv().await,
            Err(broadcast::error::RecvError::Lagged(3))
        ));
        assert_eq!(
            subscriber.recv().await.unwrap(),
            EventHint {
                boot_id: "boot-a".into(),
                revisions: revisions(4)
            }
        );
        assert_eq!(subscriber.recv().await.unwrap().revisions, revisions(5));
        assert_eq!(hub.published(), 5);
    }

    #[test]
    fn publishing_without_subscribers_never_blocks_or_retains() {
        let hub = EventHub::new("boot-b", 1);
        for n in 1..=10 {
            hub.publish(revisions(n));
        }
        assert_eq!(hub.subscribers(), 0);
        assert_eq!(hub.published(), 10);
    }
}
