use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

const MAX_RECOVERY_SNAPSHOTS: usize = 16;

#[derive(Clone, Default)]
pub struct SessionOperationLocks {
    locks: Arc<Mutex<HashMap<SessionKey, Arc<AsyncMutex<()>>>>>,
}

pub struct SessionOperationGuard {
    key: SessionKey,
    lock: Arc<AsyncMutex<()>>,
    registry: Arc<Mutex<HashMap<SessionKey, Arc<AsyncMutex<()>>>>>,
    guard: Option<OwnedMutexGuard<()>>,
}

impl SessionOperationLocks {
    pub async fn acquire(&self, key: SessionKey) -> SessionOperationGuard {
        let lock = {
            let mut locks = self.locks.lock().unwrap();
            locks.retain(|_, lock| Arc::strong_count(lock) > 1);
            locks.entry(key.clone()).or_insert_with(|| Arc::new(AsyncMutex::new(()))).clone()
        };
        let guard = lock.clone().lock_owned().await;
        SessionOperationGuard { key, lock, registry: self.locks.clone(), guard: Some(guard) }
    }
}

impl Drop for SessionOperationGuard {
    fn drop(&mut self) {
        drop(self.guard.take());
        let mut locks = self.registry.lock().unwrap();
        if Arc::strong_count(&self.lock) == 2 && locks.get(&self.key).is_some_and(|current| Arc::ptr_eq(current, &self.lock)) {
            locks.remove(&self.key);
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct SessionKey {
    pub app_id: String,
    pub capability_id: String,
    pub session_id: String,
}

impl SessionKey {
    pub fn new(app_id: &str, capability_id: &str, session_id: &str) -> Self {
        Self { app_id: app_id.to_owned(), capability_id: capability_id.to_owned(), session_id: session_id.to_owned() }
    }
}

pub struct SessionStore<T> {
    sessions: BTreeMap<SessionKey, T>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartingHost {
    pub app_id: String,
    pub owner_instance_id: String,
    pub capability_id: String,
    pub generic: bool,
    pub token: String,
}

/// Generic state shared by remote application adapters. It stores live host
/// sessions, an in-progress host handshake token, and optional recovery snapshots;
/// it does not interpret the snapshot or own application-specific lifecycle rules.
pub struct RemoteSessionBroker<T, Snapshot> {
    pub active: SessionStore<T>,
    pub starting_hosts: BTreeMap<String, StartingHost>,
    pub snapshots: BTreeMap<SessionKey, Snapshot>,
    snapshot_order: VecDeque<SessionKey>,
}

impl<T, Snapshot> Default for RemoteSessionBroker<T, Snapshot> {
    fn default() -> Self {
        Self { active: SessionStore::default(), starting_hosts: BTreeMap::new(), snapshots: BTreeMap::new(), snapshot_order: VecDeque::new() }
    }
}

impl<T, Snapshot> RemoteSessionBroker<T, Snapshot> {
    pub fn remember_snapshot(&mut self, key: SessionKey, snapshot: Snapshot) {
        self.snapshots.remove(&key);
        self.snapshot_order.retain(|existing| existing != &key);
        self.snapshots.insert(key.clone(), snapshot);
        self.snapshot_order.push_back(key);
        while self.snapshot_order.len() > MAX_RECOVERY_SNAPSHOTS {
            if let Some(expired) = self.snapshot_order.pop_front() { self.snapshots.remove(&expired); }
        }
    }

    pub fn forget_snapshot(&mut self, key: &SessionKey) {
        self.snapshots.remove(key);
        self.snapshot_order.retain(|existing| existing != key);
    }

    pub fn begin_host(&mut self, host: StartingHost) -> Result<(), &'static str> {
        if self.starting_hosts.contains_key(&host.token) { return Err("remote_already_active"); }
        self.starting_hosts.insert(host.token.clone(), host);
        Ok(())
    }

    pub fn starting_host(&self, token: &str) -> Option<&StartingHost> { self.starting_hosts.get(token) }

    pub fn finish_host(&mut self, token: &str) -> Option<StartingHost> { self.starting_hosts.remove(token) }

    /// Atomically promotes a handshake to a live session only while the
    /// originating plugin instance still owns that handshake.
    pub fn promote_host(&mut self, token: &str, owner_instance_id: &str, key: SessionKey, value: T) -> Result<(), T> {
        let owned = self.starting_hosts.get(token).is_some_and(|host| host.owner_instance_id == owner_instance_id);
        if !owned || self.active.get(&key).is_some() { return Err(value); }
        self.finish_host(token);
        match self.active.insert(key, value) {
            Ok(()) => Ok(()),
            Err(_) => unreachable!("session key was checked while holding the broker lock"),
        }
    }
}

impl<T> Default for SessionStore<T> {
    fn default() -> Self { Self { sessions: BTreeMap::new() } }
}

impl<T> SessionStore<T> {
    pub fn get(&self, key: &SessionKey) -> Option<&T> { self.sessions.get(key) }
    pub fn insert(&mut self, key: SessionKey, value: T) -> Result<(), &'static str> {
        if self.sessions.contains_key(&key) { return Err("remote_already_active"); }
        self.sessions.insert(key, value);
        Ok(())
    }
    pub fn remove(&mut self, key: &SessionKey) -> Option<T> { self.sessions.remove(key) }
    pub fn values(&self) -> impl Iterator<Item = &T> { self.sessions.values() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn operation_locks_serialize_same_session_without_blocking_other_sessions() {
        let locks = SessionOperationLocks::default();
        let key_a = SessionKey::new("city", "mecha:v4", "a");
        let key_b = SessionKey::new("city", "mecha:v4", "b");
        let first = locks.acquire(key_a.clone()).await;
        let other = tokio::time::timeout(std::time::Duration::from_millis(20), locks.acquire(key_b.clone())).await;
        assert!(other.is_ok(), "another session should acquire independently");
        let waiting_locks = locks.clone();
        let waiting_key = key_a.clone();
        let waiting = tokio::spawn(async move { waiting_locks.acquire(waiting_key).await });
        assert!(tokio::time::timeout(std::time::Duration::from_millis(20), async {
            while !waiting.is_finished() { tokio::task::yield_now().await; }
        }).await.is_err(), "same session should remain serialized");
        drop(first);
        let guard = tokio::time::timeout(std::time::Duration::from_secs(1), waiting).await.unwrap().unwrap();
        drop(guard);
    }

    #[tokio::test]
    async fn cancelled_waiters_do_not_leave_permanent_lock_entries() {
        let locks = SessionOperationLocks::default();
        let key = SessionKey::new("city", "mecha:v4", "cancelled");
        let active = locks.acquire(key.clone()).await;
        let waiting_locks = locks.clone();
        let waiting_key = key.clone();
        let waiter = tokio::spawn(async move { waiting_locks.acquire(waiting_key).await });
        tokio::task::yield_now().await;
        waiter.abort();
        let _ = waiter.await;
        drop(active);
        let next = locks.acquire(SessionKey::new("city", "mecha:v4", "next")).await;
        assert!(!locks.locks.lock().unwrap().contains_key(&key));
        drop(next);
    }

    #[test]
    fn lifecycle_is_scoped_to_app_and_capability() {
        let mut sessions = SessionStore::default();
        let city = SessionKey::new("city", "mecha:v1", "match-1");
        let island = SessionKey::new("island", "island:v1", "scene-1");
        assert_eq!(sessions.insert(city.clone(), "city-session"), Ok(()));
        assert_eq!(sessions.insert(city.clone(), "replacement"), Err("remote_already_active"));
        assert_eq!(sessions.insert(island.clone(), "island-session"), Ok(()));
        assert_eq!(sessions.remove(&city), Some("city-session"));
        assert_eq!(sessions.get(&island), Some(&"island-session"));
        assert_eq!(sessions.remove(&city), None);
    }

    #[test]
    fn different_capabilities_of_one_app_have_independent_lifecycles() {
        let mut sessions = SessionStore::default();
        let mecha = SessionKey::new("city", "mecha:v4", "match-1");
        let dream = SessionKey::new("city", "city-dream:v1", "dream-1");
        assert_eq!(sessions.insert(mecha.clone(), "match"), Ok(()));
        assert_eq!(sessions.insert(dream.clone(), "dream"), Ok(()));
        assert_eq!(sessions.get(&mecha), Some(&"match"));
        assert_eq!(sessions.get(&dream), Some(&"dream"));
        assert_eq!(sessions.remove(&dream), Some("dream"));
        assert_eq!(sessions.get(&mecha), Some(&"match"));
    }

    #[test]
    fn broker_keeps_snapshots_scoped_to_the_session_key() {
        let mut broker = RemoteSessionBroker::<&str, &str>::default();
        let match_key = SessionKey::new("city", "mecha:v4", "match-1");
        let dream_key = SessionKey::new("city", "city-dream:v1", "dream-1");
        broker.remember_snapshot(match_key.clone(), "frozen-match");
        broker.remember_snapshot(dream_key.clone(), "dream-scene");
        broker.begin_host(StartingHost { app_id: "city".into(), owner_instance_id: "plugin-city-1".into(), capability_id: "mecha:v4".into(), generic: true, token: "pending-host".into() }).unwrap();
        broker.begin_host(StartingHost { app_id: "island".into(), owner_instance_id: "plugin-island-1".into(), capability_id: "island:v1".into(), generic: true, token: "pending-scene".into() }).unwrap();
        assert_eq!(broker.snapshots.get(&match_key), Some(&"frozen-match"));
        assert_eq!(broker.snapshots.get(&dream_key), Some(&"dream-scene"));
        assert_eq!(broker.starting_host("pending-host").map(|host| host.app_id.as_str()), Some("city"));
        assert_eq!(broker.starting_host("pending-scene").map(|host| host.app_id.as_str()), Some("island"));
        assert_eq!(broker.finish_host("pending-host").map(|host| host.capability_id), Some("mecha:v4".into()));
        assert!(broker.starting_host("pending-scene").is_some());
    }

    #[test]
    fn same_capability_can_hold_multiple_sessions() {
        let mut sessions = SessionStore::default();
        let first = SessionKey::new("city", "mecha:v4", "match-1");
        let second = SessionKey::new("city", "mecha:v4", "match-2");
        assert_eq!(sessions.insert(first.clone(), "first"), Ok(()));
        assert_eq!(sessions.insert(second.clone(), "second"), Ok(()));
        assert_eq!(sessions.get(&first), Some(&"first"));
        assert_eq!(sessions.get(&second), Some(&"second"));
        assert_eq!(sessions.remove(&first), Some("first"));
        assert_eq!(sessions.get(&second), Some(&"second"));
    }

    #[test]
    fn recovery_snapshot_cache_is_bounded_and_refreshes_recency() {
        let mut broker = RemoteSessionBroker::<(), usize>::default();
        let keys: Vec<_> = (0..MAX_RECOVERY_SNAPSHOTS + 1).map(|index| SessionKey::new("city", "mecha:v4", &format!("match-{index}"))).collect();
        for (index, key) in keys.iter().enumerate() { broker.remember_snapshot(key.clone(), index); }
        assert_eq!(broker.snapshots.len(), MAX_RECOVERY_SNAPSHOTS);
        assert!(!broker.snapshots.contains_key(&keys[0]));
        broker.remember_snapshot(keys[1].clone(), 99);
        broker.remember_snapshot(keys[0].clone(), 100);
        assert!(!broker.snapshots.contains_key(&keys[2]));
        assert_eq!(broker.snapshots.get(&keys[0]), Some(&100));
        broker.forget_snapshot(&keys[0]);
        assert!(!broker.snapshots.contains_key(&keys[0]));
    }

    #[test]
    fn host_promotion_requires_the_same_live_owner_instance() {
        let mut broker = RemoteSessionBroker::<&str, &str>::default();
        let key = SessionKey::new("city", "mecha:v4", "match-1");
        broker.begin_host(StartingHost { app_id: "city".into(), owner_instance_id: "plugin-city-1".into(), capability_id: "mecha:v4".into(), generic: true, token: "token-1".into() }).unwrap();
        assert_eq!(broker.promote_host("token-1", "plugin-city-2", key.clone(), "session"), Err("session"));
        assert!(broker.starting_host("token-1").is_some());
        assert_eq!(broker.promote_host("token-1", "plugin-city-1", key.clone(), "session"), Ok(()));
        assert!(broker.starting_host("token-1").is_none());
        assert_eq!(broker.active.get(&key), Some(&"session"));
    }

    #[test]
    fn removed_handshake_cannot_be_promoted_to_a_live_session() {
        let mut broker = RemoteSessionBroker::<&str, &str>::default();
        let key = SessionKey::new("city", "mecha:v4", "match-1");
        broker.begin_host(StartingHost { app_id: "city".into(), owner_instance_id: "plugin-city-1".into(), capability_id: "mecha:v4".into(), generic: true, token: "token-1".into() }).unwrap();
        broker.finish_host("token-1");
        assert_eq!(broker.promote_host("token-1", "plugin-city-1", key.clone(), "session"), Err("session"));
        assert!(broker.active.get(&key).is_none());
    }
}
