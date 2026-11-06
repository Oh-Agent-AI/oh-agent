use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use agent_vitals_runtime_core::core::extension_objects::{ObjectStore, MAX_PAYLOAD_BYTES};
use sha2::{Digest, Sha256};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temporary(PathBuf);
impl Temporary {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("agent-vitals-objects-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temporary { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

#[test]
fn concurrent_publication_and_tampering() {
    let temp = Temporary::new();
    let store = ObjectStore::open(&temp.0).unwrap();
    let bytes = br#"{"hello":"offline"}"#;
    let hash = digest(bytes);
    fs::write(temp.0.join("staging/input.json"), bytes).unwrap();
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8).map(|_| scope.spawn(|| store.install(Path::new("input.json"), &hash))).collect();
        for handle in handles { assert_eq!(handle.join().unwrap().unwrap(), serde_json::json!({"hello":"offline"})); }
    });
    assert_eq!(store.load(&hash).unwrap(), serde_json::json!({"hello":"offline"}));
    let target = temp.0.join("objects").join(&hash).join("payload.json");
    fs::write(&target, b"{}").unwrap();
    assert_eq!(store.load(&hash), Err("object_hash"));
    assert_eq!(store.install(Path::new("input.json"), &hash), Err("object_hash"));
    assert_eq!(fs::read(target).unwrap(), b"{}");
}
#[test]
fn invalid_inputs_do_not_publish() {
    let temp = Temporary::new();
    let store = ObjectStore::open(&temp.0).unwrap();
    let hash = digest(b"{}");
    fs::write(temp.0.join("staging/input.json"), b"{}").unwrap();
    for name in ["../input.json", "/input.json", "a\\b", ".", ""] {
        assert_eq!(store.install(Path::new(name), &hash), Err("object_path"));
    }
    assert_eq!(store.install(Path::new("input.json"), &"c".repeat(64)), Err("object_hash"));
    for (bytes, error) in [(b"NaN".to_vec(), "object_json"), (b"{".to_vec(), "object_json"), (vec![b'x'; MAX_PAYLOAD_BYTES + 1], "object_bytes_limit")] {
        fs::write(temp.0.join("staging/input.json"), &bytes).unwrap();
        assert_eq!(store.install(Path::new("input.json"), &digest(&bytes)), Err(error));
    }
    assert_eq!(fs::read_dir(temp.0.join("objects")).unwrap().count(), 0);
}
#[cfg(unix)]
#[test]
fn symlinks_and_missing_staging_fail_closed() {
    use std::os::unix::fs::symlink;
    let temp = Temporary::new();
    let store = ObjectStore::open(&temp.0).unwrap();
    fs::write(temp.0.join("staging/input.json"), b"{}").unwrap();
    symlink(temp.0.join("staging/input.json"), temp.0.join("staging/link.json")).unwrap();
    assert_eq!(store.install(Path::new("link.json"), &digest(b"{}")), Err("object_path"));
    assert_eq!(store.install(Path::new("missing.json"), &digest(b"{}")), Err("object_io"));
    fs::remove_dir(temp.0.join("objects")).unwrap();
    symlink(temp.0.join("staging"), temp.0.join("objects")).unwrap();
    assert!(matches!(ObjectStore::open(&temp.0), Err("object_path")));
}
#[test]
fn stage_roundtrip_is_unique_and_discard_is_scoped() {
    let temp = Temporary::new();
    let store = ObjectStore::open(&temp.0).unwrap();
    let bytes = br#"{"candidate":1}"#;
    let first = store.stage(bytes).unwrap();
    let second = store.stage(bytes).unwrap();
    assert_ne!(first, second);
    // Staged bytes publish through the same verified path as external input.
    assert_eq!(store.install(Path::new(&first), &digest(bytes)).unwrap(), serde_json::json!({"candidate":1}));
    assert_eq!(store.load(&digest(bytes)).unwrap(), serde_json::json!({"candidate":1}));
    // Discard removes only the named staging file; objects stay intact.
    store.discard(&second).unwrap();
    assert_eq!(store.discard(&second), Err("object_io"));
    for name in ["../x", "/x", "a\\b", ".", "", "sub/x"] {
        assert_eq!(store.discard(name), Err("object_path"));
    }
    assert!(store.load(&digest(bytes)).is_ok());
    assert_eq!(store.stage(&vec![b'x'; MAX_PAYLOAD_BYTES + 1]), Err("object_bytes_limit"));
}
