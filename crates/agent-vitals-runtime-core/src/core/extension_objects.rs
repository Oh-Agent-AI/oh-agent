//! Immutable, offline extension objects. No activation, transport or garbage collection.
use std::fs::{self, OpenOptions};
#[cfg(not(windows))]
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use sha2::{Digest, Sha256};
use serde_json::Value;

pub const MAX_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(0);

fn io<T>(result: std::io::Result<T>) -> Result<T, &'static str> { result.map_err(|_| "object_io") }
fn directory(path: &Path) -> Result<(), &'static str> {
    let meta = io(fs::symlink_metadata(path))?;
    if !meta.is_dir() || meta.file_type().is_symlink() { return Err("object_path"); }
    Ok(())
}
fn hash_valid(hash: &str) -> bool { hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) }
fn read(path: &Path, hash: &str) -> Result<(Vec<u8>, Value), &'static str> {
    let before = io(fs::symlink_metadata(path))?;
    if !before.is_file() || before.file_type().is_symlink() { return Err("object_path"); }
    if before.len() > MAX_PAYLOAD_BYTES as u64 { return Err("object_bytes_limit"); }
    let mut options = OpenOptions::new();
    options.read(true);
    let file = io(options.open(path))?;
    let opened = io(file.metadata())?;
    let after = io(fs::symlink_metadata(path))?;
    if !opened.is_file() || !after.is_file() || after.file_type().is_symlink() { return Err("object_path"); }
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != opened.dev() || before.ino() != opened.ino() || after.dev() != opened.dev() || after.ino() != opened.ino() { return Err("object_path"); }
    }
    let mut bytes = Vec::new();
    io(file.take((MAX_PAYLOAD_BYTES + 1) as u64).read_to_end(&mut bytes))?;
    if bytes.len() > MAX_PAYLOAD_BYTES { return Err("object_bytes_limit"); }
    if format!("{:x}", Sha256::digest(&bytes)) != hash { return Err("object_hash"); }
    let value = serde_json::from_slice(&bytes).map_err(|_| "object_json")?;
    Ok((bytes, value))
}
// Call sites pass directories only. POSIX permits fsync on a directory handle;
// Windows does not support FlushFileBuffers-style syncing for directory handles
// through std::fs::File, so payload files remain flushed but directory metadata
// durability is left to the filesystem there.
#[cfg(not(windows))]
fn sync(path: &Path) -> Result<(), &'static str> { io(io(File::open(path))?.sync_all()) }
#[cfg(windows)]
fn sync(_path: &Path) -> Result<(), &'static str> { Ok(()) }

pub struct ObjectStore { root: PathBuf }
impl ObjectStore {
    /// Query faces must not create directories or repair storage on read.
    pub fn open_readonly(root: &Path) -> Result<Self, &'static str> {
        directory(root)?;
        let root = io(root.canonicalize())?;
        directory(&root.join("objects"))?;
        Ok(Self { root })
    }

    /// Root must already exist and be a dedicated application-owned directory.
    pub fn open(root: &Path) -> Result<Self, &'static str> {
        directory(root)?;
        let root = io(root.canonicalize())?;
        for name in ["objects", "staging"] {
            let path = root.join(name);
            match fs::create_dir(&path) {
                Ok(()) => sync(&root)?,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {},
                Err(_) => return Err("object_io"),
            }
            directory(&path)?;
        }
        Ok(Self { root })
    }
    pub fn load(&self, hash: &str) -> Result<Value, &'static str> {
        if !hash_valid(hash) { return Err("object_hash_id"); }
        directory(&self.root)?;
        directory(&self.root.join("objects"))?;
        let target = self.root.join("objects").join(hash);
        directory(&target)?;
        Ok(read(&target.join("payload.json"), hash)?.1)
    }
    /// Read one staging filename, verifying and parsing those exact bytes.
    /// This proves storage integrity only; activation also needs slot-handler schema approval.
    pub fn install(&self, staging_name: &Path, hash: &str) -> Result<Value, &'static str> {
        if !hash_valid(hash) { return Err("object_hash_id"); }
        let mut components = staging_name.components();
        if staging_name.to_str().map(|s| s.contains('\\') || s.contains('/')).unwrap_or(true) || !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() { return Err("object_path"); }
        directory(&self.root)?;
        directory(&self.root.join("staging"))?;
        let objects = self.root.join("objects");
        directory(&objects)?;
        let (bytes, parsed) = read(&self.root.join("staging").join(staging_name), hash)?;
        let target = objects.join(hash);
        if fs::symlink_metadata(&target).is_ok() { return self.load(hash); }
        let temporary = objects.join(format!(".stage-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        io(fs::create_dir(&temporary))?;
        let result = (|| {
            let payload = temporary.join("payload.json");
            let mut file = io(OpenOptions::new().write(true).create_new(true).open(payload))?;
            io(file.write_all(&bytes))?;
            io(file.sync_all())?;
            // Windows refuses to rename a directory while a child file handle
            // is still open without FILE_SHARE_DELETE. Close the flushed
            // payload before publishing the containing directory.
            drop(file);
            sync(&temporary)?;
            match fs::rename(&temporary, &target) {
                Ok(()) => { sync(&objects)?; Ok(parsed) },
                Err(_) if fs::symlink_metadata(&target).is_ok() => self.load(hash),
                Err(_) => Err("object_io"),
            }
        })();
        // Only this call's private staging directory is removed; published objects stay intact.
        if temporary.exists() {
            let _ = fs::remove_file(temporary.join("payload.json"));
            let _ = fs::remove_dir(&temporary);
        }
        result
    }
    /// Write candidate bytes into staging under a fresh unique name (fsynced).
    /// Staging is untrusted input: publication still goes through install().
    pub fn stage(&self, bytes: &[u8]) -> Result<String, &'static str> {
        if bytes.len() > MAX_PAYLOAD_BYTES { return Err("object_bytes_limit"); }
        directory(&self.root)?;
        let staging = self.root.join("staging");
        directory(&staging)?;
        let name = format!("stage-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
        let mut file = io(OpenOptions::new().write(true).create_new(true).open(staging.join(&name)))?;
        io(file.write_all(bytes))?;
        io(file.sync_all())?;
        sync(&staging)?;
        Ok(name)
    }
    /// Remove one staging file; published objects are never touched.
    pub fn discard(&self, staging_name: &str) -> Result<(), &'static str> {
        let mut components = Path::new(staging_name).components();
        if staging_name.contains('\\') || staging_name.contains('/')
            || !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() { return Err("object_path"); }
        directory(&self.root)?;
        directory(&self.root.join("staging"))?;
        match fs::remove_file(self.root.join("staging").join(staging_name)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err("object_io"),
            Err(_) => Err("object_io"),
        }
    }
}
