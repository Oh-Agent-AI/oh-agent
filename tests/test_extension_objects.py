import concurrent.futures
import hashlib
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'packages/agent-vitals-python'))
from agent_vitals.agent.extension_objects import MAX_PAYLOAD_BYTES, ObjectStore


class ObjectStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.store = ObjectStore(self.root)
        self.payload = b'{"hello":"offline"}'
        self.digest = hashlib.sha256(self.payload).hexdigest()
        (self.root / 'staging/input.json').write_bytes(self.payload)

    def test_concurrent_install_and_tamper(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.store.install('input.json', self.digest), range(8)))
        self.assertEqual(results, [{'hello': 'offline'}] * 8)
        self.assertEqual(self.store.load(self.digest), results[0])
        object_path = self.root / 'objects' / self.digest / 'payload.json'
        object_path.write_bytes(b'{}')
        for operation in (lambda: self.store.load(self.digest), lambda: self.store.install('input.json', self.digest)):
            with self.assertRaisesRegex(ValueError, 'object_hash'):
                operation()
        self.assertEqual(object_path.read_bytes(), b'{}')

    def test_invalid_path_hash_json_size_and_symlink(self):
        for name in ('../input.json', '/input.json', 'a\\b', '.', ''):
            with self.assertRaisesRegex(ValueError, 'object_path'):
                self.store.install(name, self.digest)
        with self.assertRaisesRegex(ValueError, 'object_hash'):
            self.store.install('input.json', 'c' * 64)
        for payload, error in ((b'NaN', 'object_json'), (b'{' , 'object_json'), (b'x' * (MAX_PAYLOAD_BYTES + 1), 'object_bytes_limit')):
            (self.root / 'staging/input.json').write_bytes(payload)
            with self.assertRaisesRegex(ValueError, error):
                self.store.install('input.json', hashlib.sha256(payload).hexdigest())
        (self.root / 'staging/link.json').symlink_to(self.root / 'staging/input.json')
        with self.assertRaisesRegex(ValueError, 'object_path'):
            self.store.install('link.json', self.digest)
        self.assertEqual(list((self.root / 'objects').iterdir()), [])

    def test_failed_publication_retains_staging(self):
        with patch('agent_vitals.agent.extension_objects.os.rename', side_effect=OSError('fault')):
            with self.assertRaises(OSError):
                self.store.install('input.json', self.digest)
        self.assertEqual((self.root / 'staging/input.json').read_bytes(), self.payload)
        self.assertEqual(list((self.root / 'objects').iterdir()), [])

    def test_symlink_store_directory_rejected(self):
        (self.root / 'objects').rmdir()
        (self.root / 'objects').symlink_to(self.root / 'staging', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'object_path'):
            ObjectStore(self.root)

    def test_stage_roundtrip_and_scoped_discard(self):
        payload = b'{"candidate":1}'
        first = self.store.stage(payload)
        second = self.store.stage(payload)
        self.assertNotEqual(first, second)
        # Staged bytes publish through the same verified path.
        self.assertEqual(self.store.install(first, hashlib.sha256(payload).hexdigest()), {'candidate': 1})
        self.assertEqual(self.store.load(hashlib.sha256(payload).hexdigest()), {'candidate': 1})
        # Discard only removes the named staging file; objects stay intact.
        self.store.discard(second)
        with self.assertRaisesRegex(ValueError, 'object_io'):
            self.store.discard(second)
        for name in ('../x', '/x', 'a\\b', '.', '', 'sub/x'):
            with self.assertRaisesRegex(ValueError, 'object_path'):
                self.store.discard(name)
        self.assertIsNotNone(self.store.load(hashlib.sha256(payload).hexdigest()))
        with self.assertRaisesRegex(ValueError, 'object_bytes_limit'):
            self.store.stage(b'x' * (MAX_PAYLOAD_BYTES + 1))
