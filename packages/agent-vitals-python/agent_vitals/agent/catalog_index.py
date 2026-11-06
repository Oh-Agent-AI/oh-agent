"""Pure catalog validation. No transport, activation or provenance authority."""
import json
import re
from datetime import datetime

LOCAL_SLOTS = frozenset(('harness_manifest', 'price_card', 'model_alias', 'endpoint_pattern', 'trust_profile'))
VENDOR_SLOTS = LOCAL_SLOTS | frozenset(('error_taxonomy', 'behavior_patterns', 'subscription_scope', 'fx_reference', 'quota_window', 'duration_threshold', 'slow_call_threshold', 'attribution_signatures'))


def parse_catalog(payload):
    """Bound raw index input before JSON parsing (4 MiB)."""
    if not isinstance(payload, bytes) or len(payload) > 4 * 1024 * 1024:
        raise ValueError('index_bytes_limit')
    try:
        def reject_constant(value):
            raise ValueError('index_json')
        return json.loads(payload, parse_constant=reject_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise ValueError('index_json') from None


def validate_catalog(index, supported, app_version, index_sha256, highest=None):
    """supported maps slot -> {schemas, capabilities}; highest is (sequence, hash).

    Return the validated index; raise ValueError with stable cross-language codes.
    The caller must compute index_sha256 over the exact input bytes.
    """
    def fail(code):
        raise ValueError(code)

    def hex_value(value, size):
        return isinstance(value, str) and re.fullmatch('[0-9a-f]{%d}' % size, value) is not None

    def version(value):
        if not isinstance(value, str) or not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', value):
            fail('version')
        if any(len(p) > 10 for p in value.split('.')):
            fail('version')
        parts = tuple(int(p) for p in value.split('.'))
        if any(p > 4294967295 for p in parts):
            fail('version')
        return parts

    if not isinstance(index, dict) or set(index) != {'index_schema_version', 'catalog_sequence', 'published_at', 'entries'}:
        fail('index_shape')
    if type(index['index_schema_version']) is not int or index['index_schema_version'] != 1:
        fail('index_schema')
    seq = index['catalog_sequence']
    if type(seq) is not int or not 0 <= seq <= 18446744073709551615 or not hex_value(index_sha256, 64):
        fail('sequence')
    if highest is not None and (seq < highest[0] or (seq == highest[0] and index_sha256 != highest[1])):
        fail('sequence_conflict')
    if not isinstance(index['published_at'], str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z', index['published_at']):
        fail('published_at')
    try:
        datetime.strptime(index['published_at'], '%Y-%m-%dT%H:%M:%SZ')
    except ValueError:
        fail('published_at')
    entries = index['entries']
    if not isinstance(entries, list) or len(entries) > 1024:
        fail('entries_limit')
    app = version(app_version)
    nodes = {}
    fields = {'slot_type', 'slot_id', 'revision', 'payload_path', 'sha256', 'schema_version', 'requires', 'min_app_version', 'display', 'dependencies'}
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != fields:
            fail('entry_shape')
        slot = entry['slot_type']
        if not isinstance(slot, str) or slot not in VENDOR_SLOTS or slot not in supported:
            fail('slot_unsupported')
        ident = entry['slot_id']
        if not isinstance(ident, str) or not re.fullmatch('[a-z0-9][a-z0-9_-]{0,63}', ident):
            fail('identity')
        if not hex_value(entry['revision'], 40) or not hex_value(entry['sha256'], 64):
            fail('digest')
        path = entry['payload_path']
        if not isinstance(path, str) or len(path) > 512 or not re.fullmatch('[A-Za-z0-9_./-]+', path) or any(p in ('', '.', '..') for p in path.split('/')):
            fail('payload_path')
        if type(entry['schema_version']) is not int or not 1 <= entry['schema_version'] <= 4294967295 or entry['schema_version'] not in supported[slot]['schemas']:
            fail('entry_schema')
        req = entry['requires']
        if not isinstance(req, dict) or set(req) != {'recipes', 'features'}:
            fail('capability')
        for category, prefix in (('recipes', 'recipe:'), ('features', 'feature:')):
            names = req[category]
            if not isinstance(names, list) or len(names) > 64 or any(not isinstance(v, str) or not v or len(v) > 128 or prefix + v not in supported[slot]['capabilities'] for v in names) or len(set(names)) != len(names):
                fail('capability')
        if version(entry['min_app_version']) > app:
            fail('app_version')
        if not isinstance(entry['display'], str) or not 1 <= len(entry['display']) <= 256:
            fail('display')
        if not isinstance(entry['dependencies'], list) or len(entry['dependencies']) > 64:
            fail('dependencies_limit')
        key = (slot, ident)
        if key in nodes:
            fail('identity_conflict')
        nodes[key] = entry
    edges = {}
    for key in sorted(nodes):
        entry = nodes[key]
        edges[key] = []
        for dep in entry['dependencies']:
            if not isinstance(dep, dict) or set(dep) != {'slot_type', 'slot_id', 'revision', 'sha256'} or not isinstance(dep['slot_type'], str) or not isinstance(dep['slot_id'], str):
                fail('dependency_shape')
            target = (dep['slot_type'], dep['slot_id'])
            found = nodes.get(target)
            if found is None or dep['revision'] != found['revision'] or dep['sha256'] != found['sha256']:
                fail('dependency_missing')
            if target in edges[key]:
                fail('dependency_duplicate')
            edges[key].append(target)
    # Iterative DFS bounds stack use even for an adversarial 1024-entry chain.
    done = set()
    for key in sorted(nodes):
        stack = [(key, False)]
        visiting = set()
        while stack:
            node, leaving = stack.pop()
            if leaving:
                visiting.remove(node)
                done.add(node)
            elif node not in done:
                if node in visiting:
                    fail('dependency_cycle')
                visiting.add(node)
                stack.append((node, True))
                stack.extend((child, False) for child in reversed(edges[node]))
    return index


def local_allowed(slot):
    """Permissions are compiled policy, never catalog-supplied metadata."""
    return slot in LOCAL_SLOTS
