use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct SessionKey {
    pub app_id: String,
    pub capability_id: String,
}

impl SessionKey {
    pub fn new(app_id: &str, capability_id: &str) -> Self {
        Self { app_id: app_id.to_owned(), capability_id: capability_id.to_owned() }
    }
}

pub struct SessionStore<T> {
    sessions: BTreeMap<SessionKey, T>,
}

impl<T> Default for SessionStore<T> {
    fn default() -> Self { Self { sessions: BTreeMap::new() } }
}

impl<T> SessionStore<T> {
    pub fn get(&self, key: &SessionKey) -> Option<&T> { self.sessions.get(key) }
    pub fn get_mut(&mut self, key: &SessionKey) -> Option<&mut T> { self.sessions.get_mut(key) }
    pub fn insert(&mut self, key: SessionKey, value: T) -> Result<(), &'static str> {
        if self.sessions.contains_key(&key) { return Err("remote_already_active"); }
        self.sessions.insert(key, value);
        Ok(())
    }
    pub fn remove(&mut self, key: &SessionKey) -> Option<T> { self.sessions.remove(key) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_is_scoped_to_app_and_capability() {
        let mut sessions = SessionStore::default();
        let city = SessionKey::new("city", "mecha:v1");
        let island = SessionKey::new("island", "island:v1");
        assert_eq!(sessions.insert(city.clone(), "city-session"), Ok(()));
        assert_eq!(sessions.insert(city.clone(), "replacement"), Err("remote_already_active"));
        assert_eq!(sessions.insert(island.clone(), "island-session"), Ok(()));
        assert_eq!(sessions.remove(&city), Some("city-session"));
        assert_eq!(sessions.get(&island), Some(&"island-session"));
        assert_eq!(sessions.remove(&city), None);
    }
}
