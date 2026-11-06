//! Local-only HMAC identities for Trust evidence joins.
//!
//! The key never enters the authority database, logs, MCP, exports, or
//! diagnostics.  Trust producers hash their native path/process identity in
//! memory and persist only the domain-separated HMAC reference.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};

const KEY_FILE: &str = ".trust-identity-key";
const KEY_LEN: usize = 32;
const REF_BYTES: usize = 16;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub struct TrustIdentity {
    key: [u8; KEY_LEN],
}

impl TrustIdentity {
    /// Load the per-install key, creating it atomically on first use.
    ///
    /// There is intentionally no time/hostname fallback: without a random
    /// key, a Trust identity is not safe to use for cross-surface joins.
    pub fn load_or_create(data_home: &Path) -> Result<Self, String> {
        let path = key_path(data_home);
        match std::fs::symlink_metadata(&path) {
            Ok(_) => {
                validate_key_file(&path)?;
                let bytes = std::fs::read(&path).map_err(|error| format!("read trust identity key: {error}"))?;
                return Self::from_bytes(&bytes).ok_or_else(|| "trust identity key is invalid".to_string());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("inspect trust identity key: {error}")),
        }
        let key = random_key()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("create trust identity directory: {error}"))?;
        }
        let temp = path.with_file_name(format!(".{KEY_FILE}.tmp-{}-{}", std::process::id(), TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).read(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&temp) {
            Ok(mut file) => {
                let result = (|| {
                    file.write_all(&key).map_err(|error| format!("write trust identity key: {error}"))?;
                    file.flush().map_err(|error| format!("flush trust identity key: {error}"))?;
                    file.sync_all().map_err(|error| format!("sync trust identity key: {error}"))?;
                    // A hard link is an atomic create-if-absent on the target,
                    // unlike rename which could overwrite a racing install.
                    match std::fs::hard_link(&temp, &path) {
                        Ok(()) => Ok(Self { key }),
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                            validate_key_file(&path)?;
                            let bytes = std::fs::read(&path).map_err(|read_error| format!("read trust identity key: {read_error}"))?;
                            Self::from_bytes(&bytes).ok_or_else(|| "trust identity key is invalid".to_string())
                        }
                        Err(error) => Err(format!("install trust identity key: {error}")),
                    }
                })();
                drop(file);
                let _ = std::fs::remove_file(&temp);
                result
            }
            Err(error) => Err(format!("create trust identity key: {error}")),
        }
    }

    fn from_bytes(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != KEY_LEN { return None; }
        let mut key = [0_u8; KEY_LEN];
        key.copy_from_slice(bytes);
        Some(Self { key })
    }

    /// Return a domain-separated opaque reference. `raw` is never persisted.
    pub fn reference(&self, domain: &str, raw: &str) -> String {
        let mac = hmac_sha256(&self.key, format!("{domain}:{raw}").as_bytes());
        let mut out = String::with_capacity(3 + REF_BYTES * 2);
        out.push_str("tr_");
        for byte in &mac[..REF_BYTES] { out.push_str(&format!("{byte:02x}")); }
        out
    }

    pub fn actor_ref(&self, raw: &str) -> String { self.reference("actor", raw) }
    pub fn workspace_ref(&self, raw: &Path) -> String {
        self.reference("workspace", &raw.to_string_lossy())
    }
    pub fn event_ref(&self, raw: &str) -> String { self.reference("event", raw) }
}

fn key_path(data_home: &Path) -> PathBuf { data_home.join(KEY_FILE) }

fn validate_key_file(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| format!("inspect trust identity key: {error}"))?;
    if !metadata.file_type().is_file() { return Err("trust identity key is not a regular file".to_string()); }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode();
        if mode & 0o077 != 0 || mode & 0o400 == 0 {
            return Err("trust identity key permissions are not private".to_string());
        }
    }
    Ok(())
}

fn random_key() -> Result<[u8; KEY_LEN], String> {
    let mut key = [0_u8; KEY_LEN];
    let mut file = std::fs::File::open("/dev/urandom")
        .map_err(|_| "secure random source unavailable for Trust identity".to_string())?;
    file.read_exact(&mut key)
        .map_err(|_| "secure random source unavailable for Trust identity".to_string())?;
    Ok(key)
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut normalized = [0_u8; BLOCK];
    if key.len() > BLOCK {
        normalized[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        normalized[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36_u8; BLOCK];
    let mut outer_pad = [0x5c_u8; BLOCK];
    for index in 0..BLOCK {
        inner_pad[index] ^= normalized[index];
        outer_pad[index] ^= normalized[index];
    }
    let inner = Sha256::new().chain_update(inner_pad).chain_update(message).finalize();
    let mut output = [0_u8; 32];
    output.copy_from_slice(&Sha256::new().chain_update(outer_pad).chain_update(inner).finalize());
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn references_are_domain_separated_and_do_not_leak_raw_identity() {
        let identity = TrustIdentity { key: [7_u8; KEY_LEN] };
        let actor = identity.actor_ref("/private/process");
        let workspace = identity.workspace_ref(Path::new("/private/process"));
        assert!(actor.starts_with("tr_") && workspace.starts_with("tr_"));
        assert_ne!(actor, workspace);
        assert!(!actor.contains("private"));
        assert_eq!(actor, identity.actor_ref("/private/process"));
    }

    #[test]
    fn key_is_random_persistent_and_private() {
        let home = std::env::temp_dir().join(format!("av-trust-identity-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let first = TrustIdentity::load_or_create(&home).unwrap();
        let second = TrustIdentity::load_or_create(&home).unwrap();
        assert_eq!(first.actor_ref("actor"), second.actor_ref("actor"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(key_path(&home)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn malformed_key_fails_closed() {
        let home = std::env::temp_dir().join(format!("av-trust-identity-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(key_path(&home), b"short").unwrap();
        assert!(TrustIdentity::load_or_create(&home).is_err());
        let _ = std::fs::remove_dir_all(home);
    }

    #[cfg(unix)]
    #[test]
    fn existing_key_with_wide_permissions_fails_closed() {
        use std::os::unix::fs::PermissionsExt;
        let home = std::env::temp_dir().join(format!("av-trust-identity-wide-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let path = key_path(&home);
        std::fs::write(&path, [1_u8; KEY_LEN]).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(TrustIdentity::load_or_create(&home).is_err());
        let _ = std::fs::remove_dir_all(home);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_key_fails_closed() {
        let home = std::env::temp_dir().join(format!("av-trust-identity-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let target = home.join("target");
        std::fs::write(&target, [1_u8; KEY_LEN]).unwrap();
        std::os::unix::fs::symlink(&target, key_path(&home)).unwrap();
        assert!(TrustIdentity::load_or_create(&home).is_err());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn concurrent_initialization_converges_on_one_key() {
        let home = std::env::temp_dir().join(format!("av-trust-identity-race-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let mut threads = Vec::new();
        for _ in 0..8 {
            let home = home.clone();
            threads.push(std::thread::spawn(move || TrustIdentity::load_or_create(&home).unwrap().actor_ref("actor")));
        }
        let refs: Vec<_> = threads.into_iter().map(|thread| thread.join().unwrap()).collect();
        assert!(refs.iter().all(|item| item == &refs[0]));
        let _ = std::fs::remove_dir_all(home);
    }
}
