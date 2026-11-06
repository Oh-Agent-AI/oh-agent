import copy
import json
import pathlib
import re
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'packages/agent-vitals-python'))
from agent_vitals.agent.catalog_index import local_allowed, parse_catalog, validate_catalog


class CatalogIndexTests(unittest.TestCase):
    def setUp(self):
        self.index = json.loads((ROOT / 'fixtures/catalog-index-v1.json').read_text())
        self.support = {'harness_manifest': {'schemas': [1], 'capabilities': ['recipe:message']}}

    def check(self, index=None, highest=None):
        return validate_catalog(index or self.index, self.support, '1.4.0', 'c' * 64, highest)

    def test_shared_cases(self):
        self.check()
        for case in json.loads((ROOT / 'fixtures/catalog-index-invalid-cases.json').read_text()):
            with self.subTest(case=case):
                index = copy.deepcopy(self.index)
                index['entries'][0][case['field']] = case['value']
                with self.assertRaisesRegex(ValueError, '^' + case['error'] + '$'):
                    self.check(index)

    def test_dependencies_and_sequence(self):
        with self.assertRaisesRegex(ValueError, 'sequence_conflict'):
            self.check(highest=(8, 'c' * 64))
        with self.assertRaisesRegex(ValueError, 'sequence_conflict'):
            self.check(highest=(7, 'd' * 64))
        self.check(highest=(7, 'c' * 64))
        entry = self.index['entries'][0]
        dep = {k: entry[k] for k in ('slot_type', 'slot_id', 'revision', 'sha256')}
        entry['dependencies'] = [dep]
        with self.assertRaisesRegex(ValueError, 'dependency_cycle'):
            self.check()
        dep['sha256'] = 'd' * 64
        with self.assertRaisesRegex(ValueError, 'dependency_missing'):
            self.check()
        entry['dependencies'] = []
        self.index['entries'].append(copy.deepcopy(entry))
        with self.assertRaisesRegex(ValueError, 'identity_conflict'):
            self.check()

    def test_permissions_and_limits(self):
        self.assertTrue(local_allowed('harness_manifest'))
        self.assertFalse(local_allowed('subscription_scope'))
        self.index['entries'] *= 1025
        with self.assertRaisesRegex(ValueError, 'entries_limit'):
            self.check()

    def test_dependency_diamond_and_cycle(self):
        template = self.index['entries'][0]
        self.index['entries'] = [dict(copy.deepcopy(template), slot_id=name) for name in ('a', 'b', 'c', 'd')]
        entries = self.index['entries']
        def dep(n):
            return {k: entries[n][k] for k in ('slot_type', 'slot_id', 'revision', 'sha256')}
        entries[0]['dependencies'] = [dep(1), dep(2)]
        entries[1]['dependencies'] = [dep(3)]
        entries[2]['dependencies'] = [dep(3)]
        self.check()
        entries[3]['dependencies'] = [dep(1)]
        with self.assertRaisesRegex(ValueError, 'dependency_cycle'):
            self.check()
        entries[3]['dependencies'] = []
        entries[0]['dependencies'] = [dep(1), dep(1)]
        with self.assertRaisesRegex(ValueError, 'dependency_duplicate'):
            self.check()
        entries[0]['dependencies'] = [dict(dep(1), slot_id='absent')]
        with self.assertRaisesRegex(ValueError, 'dependency_missing'):
            self.check()

    def test_shared_timestamps(self):
        for case in json.loads((ROOT / 'fixtures/catalog-index-timestamps.json').read_text()):
            self.index['published_at'] = case['value']
            if case['valid']:
                self.check()
            else:
                with self.assertRaisesRegex(ValueError, 'published_at'):
                    self.check()

    def test_parser_and_huge_version(self):
        for payload in (b'NaN', b'Infinity', b'{', b'x' * (4 * 1024 * 1024 + 1)):
            with self.assertRaises(ValueError):
                parse_catalog(payload)
        self.index['entries'][0]['min_app_version'] = '9' * 5000 + '.0.0'
        with self.assertRaisesRegex(ValueError, '^version$'):
            self.check()

    def test_schema_search_bounds(self):
        schema = json.loads((ROOT / 'docs/schemas/catalog-index-v1.json').read_text())
        fields = schema['$defs']
        for name, valid in (('id', 'example'), ('revision', 'a' * 40), ('sha256', 'b' * 64), ('version', '1.4.0')):
            self.assertIsNotNone(re.search(fields[name]['pattern'], valid))
            self.assertIsNone(re.search(fields[name]['pattern'], valid + '\n'))
        ver = fields['version']
        for value in ('4294967295.0.0', '0.4294967295.0', '0.0.4294967295'):
            self.assertIsNotNone(re.search(ver['pattern'], value))
            self.assertIsNone(re.search(ver['not']['pattern'], value))
        for value in ('4294967296.0.0', '0.5000000000.0', '0.0.9999999999'):
            self.assertIsNotNone(re.search(ver['not']['pattern'], value))
        for spec, value in ((schema['properties']['published_at'], '2026-10-01T00:00:00Z'), (fields['entry']['properties']['payload_path'], 'catalog/harness.json')):
            self.assertIsNotNone(re.search(spec['pattern'], value))
            self.assertIsNone(re.search(spec['pattern'], value + '\n'))
