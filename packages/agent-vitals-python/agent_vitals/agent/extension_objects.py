"""Offline immutable extension storage; schema approval and activation are separate."""
import hashlib
import json
import os
import re
import stat
import tempfile
from pathlib import Path

MAX_PAYLOAD_BYTES = 8 * 1024 * 1024


def _directory(path):
    metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode):
        raise ValueError('object_path')


def _sync(path):
    if os.name == 'nt' and path.is_dir():
        # Windows cannot open directory handles with os.open; files are still
        # fsynced before immutable publication.
        return
    fd = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _hash_id(digest):
    if not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest):
        raise ValueError('object_hash_id')


def _read(path, digest):
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise ValueError('object_path')
    if before.st_size > MAX_PAYLOAD_BYTES:
        raise ValueError('object_bytes_limit')
    with path.open('rb') as file:
        opened, after = os.fstat(file.fileno()), path.lstat()
        if not stat.S_ISREG(opened.st_mode) or not stat.S_ISREG(after.st_mode) or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino) or (after.st_dev, after.st_ino) != (opened.st_dev, opened.st_ino):
            raise ValueError('object_path')
        payload = file.read(MAX_PAYLOAD_BYTES + 1)
    if len(payload) > MAX_PAYLOAD_BYTES:
        raise ValueError('object_bytes_limit')
    if hashlib.sha256(payload).hexdigest() != digest:
        raise ValueError('object_hash')
    def reject_constant(value):
        raise ValueError('object_json')
    try:
        parsed = json.loads(payload, parse_constant=reject_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise ValueError('object_json') from None
    return payload, parsed


class ObjectStore:
    def __init__(self, root):
        root = Path(root)
        _directory(root)
        self.root = root.resolve()
        for name in ('objects', 'staging'):
            path = self.root / name
            try:
                path.mkdir()
                _sync(self.root)
            except FileExistsError:
                pass
            _directory(path)

    def load(self, digest):
        _hash_id(digest)
        _directory(self.root)
        _directory(self.root / 'objects')
        target = self.root / 'objects' / digest
        _directory(target)
        return _read(target / 'payload.json', digest)[1]

    def install(self, staging_name, digest):
        """Store validated bytes; returned JSON has no activation authority."""
        _hash_id(digest)
        name = str(staging_name)
        if not name or name in ('.', '..') or '/' in name or '\\' in name:
            raise ValueError('object_path')
        _directory(self.root)
        _directory(self.root / 'staging')
        objects = self.root / 'objects'
        _directory(objects)
        payload, parsed = _read(self.root / 'staging' / name, digest)
        target = objects / digest
        if target.exists() or target.is_symlink():
            return self.load(digest)
        temporary = Path(tempfile.mkdtemp(prefix='.stage-', dir=str(objects)))
        try:
            with (temporary / 'payload.json').open('xb') as file:
                file.write(payload)
                file.flush()
                os.fsync(file.fileno())
            _sync(temporary)
            try:
                os.rename(str(temporary), str(target))
            except OSError:
                if target.exists() or target.is_symlink():
                    return self.load(digest)
                raise
            _sync(objects)
            return parsed
        finally:
            if temporary.exists():
                (temporary / 'payload.json').unlink(missing_ok=True)
                temporary.rmdir()

    def stage(self, payload):
        """Write candidate bytes into staging under a fresh name (fsynced)."""
        if not isinstance(payload, (bytes, bytearray)) or len(payload) > MAX_PAYLOAD_BYTES:
            raise ValueError('object_bytes_limit')
        _directory(self.root)
        staging = self.root / 'staging'
        _directory(staging)
        descriptor, name = tempfile.mkstemp(prefix='stage-', dir=str(staging))
        with os.fdopen(descriptor, 'wb') as file:
            file.write(payload)
            file.flush()
            os.fsync(file.fileno())
        _sync(staging)
        return Path(name).name

    def discard(self, staging_name):
        """Remove one staging file; published objects are never touched."""
        name = str(staging_name)
        if not name or name in ('.', '..') or '/' in name or '\\' in name:
            raise ValueError('object_path')
        _directory(self.root)
        _directory(self.root / 'staging')
        try:
            (self.root / 'staging' / name).unlink()
        except (FileNotFoundError, NotADirectoryError):
            raise ValueError('object_io') from None
        except OSError:
            raise ValueError('object_io') from None
