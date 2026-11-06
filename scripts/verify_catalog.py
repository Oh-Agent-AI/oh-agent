#!/usr/bin/env python3
"""Offline publish gate: legacy price mirrors and commit-pinned harness payloads."""
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "packages/agent-vitals-python"))
from scripts.catalog_mirror import synchronize
from agent_vitals.agent import catalog_index, generic_manifest

MAX_PAYLOAD_BYTES = 8 * 1024 * 1024
MAX_GROUP_BYTES = 32 * 1024 * 1024
MAX_GROUP_ENTRIES = 64


def _git(root, *args):
    result = subprocess.run(["git", "--no-pager", "-C", str(root)] + list(args),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise ValueError("catalog revision/path unavailable in Git: %s" % " ".join(args))
    return result.stdout


def committed_payload(root, entry):
    commit, path = entry["revision"], entry["payload_path"]
    if _git(root, "cat-file", "-t", commit).strip() != b"commit":
        raise ValueError("catalog revision must identify a commit")
    spec = commit + ":" + path
    listing = _git(root, "ls-tree", commit, "--", path).split(b"\t", 1)[0].split()
    if len(listing) != 3 or listing[0] not in (b"100644", b"100755") or listing[1] != b"blob":
        raise ValueError("catalog payload must be a regular committed blob")
    size = int(_git(root, "cat-file", "-s", spec).strip())
    if size > MAX_PAYLOAD_BYTES:
        raise ValueError("catalog payload bytes limit")
    # The immutable blob's size is checked before capturing its content.
    raw = _git(root, "show", spec)
    if len(raw) != size or hashlib.sha256(raw).hexdigest() != entry["sha256"]:
        raise ValueError("catalog payload hash mismatch: %s" % path)
    return raw


def verify_harnesses(root, index_bytes):
    index = catalog_index.parse_catalog(index_bytes)
    supported = {"harness_manifest": {"schemas": [1], "capabilities":
                 ["recipe:" + value for value in generic_manifest.RECIPE_IDS] +
                 ["feature:" + value for value in generic_manifest.FEATURE_IDS]}}
    catalog_index.validate_catalog(index, supported, generic_manifest.APP_VERSION,
                                   hashlib.sha256(index_bytes).hexdigest())
    sizes = {}
    entries = {entry["slot_id"]: entry for entry in index["entries"]}
    for entry in index["entries"]:
        if entry["payload_path"] != "catalog/harnesses/%s.json" % entry["slot_id"]:
            raise ValueError("harness payload must use catalog/harnesses/<slug>.json")
        raw = committed_payload(root, entry)
        sizes[entry["slot_id"]] = len(raw)
        def reject_constant(value):
            raise ValueError("catalog payload contains non-JSON constant: %s" % value)
        value = json.loads(raw.decode("utf-8"), parse_constant=reject_constant)
        manifest = generic_manifest.parse_manifest(value)
        if (manifest.slug != entry["slot_id"] or value["manifest_version"] != entry["schema_version"]
                or value.get("requires") != entry["requires"]
                or value.get("min_app_version") != entry["min_app_version"]
                or manifest.recipe not in entry["requires"]["recipes"]):
            raise ValueError("catalog/payload contract mismatch: %s" % entry["slot_id"])
    for ident in entries:
        pending, selected = [ident], set()
        while pending:
            current = pending.pop()
            if current in selected:
                continue
            selected.add(current)
            if len(selected) > MAX_GROUP_ENTRIES or sum(sizes[key] for key in selected) > MAX_GROUP_BYTES:
                raise ValueError("catalog dependency group limit")
            pending.extend(dependency["slot_id"] for dependency in entries[current]["dependencies"])
    return len(index["entries"])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args(argv)
    try:
        synchronize(args.root)
        with (args.root / "catalog/index.json").open("rb") as stream:
            index_bytes = stream.read(4 * 1024 * 1024 + 1)
        count = verify_harnesses(args.root, index_bytes)
        print("catalog publish check: price mirrors identical; %d commit-pinned harness payloads verified" % count)
        return 0
    except (ValueError, OSError, generic_manifest.ManifestError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
