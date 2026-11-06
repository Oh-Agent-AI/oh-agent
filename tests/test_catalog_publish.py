"""Offline catalog release contracts; Git evidence uses isolated synthetic repos."""
import contextlib
import copy
import hashlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import catalog_mirror, pricing_sync, verify_catalog
from tests.test_generic_plugin import zcode_manifest
from tests.test_pricing_sync import BASE_PRICING, BASE_CODEX, sources, md_model, ll_entry

ROOT = Path(__file__).resolve().parents[1]


class CatalogMirrorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="vitals-catalog-publish-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "catalog/pricing").mkdir(parents=True)
        (self.root / "assets").mkdir()
        for name in catalog_mirror.FILES:
            content = (ROOT / "catalog/pricing" / name).read_bytes()
            (self.root / "catalog/pricing" / name).write_bytes(content)
            (self.root / "assets" / name).write_bytes(content)

    def test_repo_mirrors_identical_and_drift_check_does_not_write(self):
        self.assertEqual(catalog_mirror.synchronize(ROOT), [])
        target = self.root / "assets/pricing.json"
        target.write_bytes(b"old content\n")
        with self.assertRaisesRegex(ValueError, "mirror drift"):
            catalog_mirror.synchronize(self.root)
        self.assertEqual(target.read_bytes(), b"old content\n")
        self.assertEqual(catalog_mirror.synchronize(self.root, write=True), ["assets/pricing.json"])
        self.assertEqual(target.read_bytes(), (self.root / "catalog/pricing/pricing.json").read_bytes())

    def test_missing_authority_cannot_be_reconstructed_from_mirror(self):
        source = self.root / "catalog/pricing/pricing.json"
        source.unlink()
        before = (self.root / "assets/pricing.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "missing regular file"):
            catalog_mirror.synchronize(self.root, write=True)
        self.assertEqual((self.root / "assets/pricing.json").read_bytes(), before)

    def test_symlink_mirror_cannot_overwrite_its_target(self):
        target = self.root / "assets/pricing.json"
        target.unlink()
        outside = self.root / "unrelated.json"
        outside.write_bytes(b"preserve")
        try:
            target.symlink_to(outside)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        with self.assertRaisesRegex(ValueError, "symlink"):
            catalog_mirror.synchronize(self.root, write=True)
        source = self.root / "catalog/pricing/pricing-sync.json"
        before = source.read_bytes()
        with self.assertRaisesRegex(ValueError, "symlink"):
            pricing_sync.main(["--root", str(self.root), "--write", "--sources-dir", str(self.root / "not-read")])
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(outside.read_bytes(), b"preserve")

    def test_offline_daily_sync_updates_both_paths_and_keeps_unchanged_date(self):
        for name, value in [("pricing.json", BASE_PRICING), ("codex_pricing.json", BASE_CODEX),
                            ("pricing-sync.json", {})]:
            raw = json.dumps(value).encode("utf-8")
            (self.root / "catalog/pricing" / name).write_bytes(raw)
            (self.root / "assets" / name).write_bytes(raw)
        source_dir = self.root / "sources"
        source_dir.mkdir()
        source_data = sources(md={"anthropic": {"models": {"claude-sonnet-5": md_model(2, .2, 10)}}},
                              ll={"claude-sonnet-5": ll_entry("anthropic", 2, .2, 10)})
        for name, value in source_data.items():
            (source_dir / (name + ".json")).write_text(json.dumps(value), encoding="utf-8")
        args = ["--root", str(self.root), "--sources-dir", str(source_dir), "--write"]
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(pricing_sync.main(args + ["--today", "2026-10-02"]), 0)
        path = self.root / "catalog/pricing/pricing-sync.json"
        raw = path.read_bytes()
        self.assertEqual(json.loads(raw)["catalog"]["anthropic"]["models"]["claude-sonnet-5"]["output"], 10)
        self.assertEqual(raw, (self.root / "assets/pricing-sync.json").read_bytes())
        stamp = path.stat().st_mtime_ns
        with contextlib.redirect_stdout(io.StringIO()):
            pricing_sync.main(args + ["--today", "2026-10-03"])
        self.assertEqual(path.read_bytes(), raw)
        self.assertEqual(path.stat().st_mtime_ns, stamp)


class CatalogPinnedPayloadTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="vitals-catalog-git-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.git("init", "--quiet")
        self.path = self.root / "catalog/harnesses/zcode.json"
        self.path.parent.mkdir(parents=True)
        self.payload = zcode_manifest()
        self.payload["requires"] = {"recipes": [self.payload["recipe"]], "features": []}
        self.payload["min_app_version"] = "1.0.0"
        self.raw = json.dumps(self.payload).encode("utf-8")
        self.path.write_bytes(self.raw)
        self.git("add", "catalog")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "--quiet", "-m", "synthetic payload")
        self.commit = self.git("rev-parse", "HEAD").strip().decode("ascii")
        self.entry = {"slot_type": "harness_manifest", "slot_id": "zcode", "revision": self.commit,
                      "payload_path": "catalog/harnesses/zcode.json", "sha256": hashlib.sha256(self.raw).hexdigest(),
                      "schema_version": 1, "requires": self.payload["requires"], "min_app_version": "1.0.0",
                      "display": "Synthetic ZCode", "dependencies": []}

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root)] + list(args), check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout

    def verify(self, entry=None):
        index = {"index_schema_version": 1, "catalog_sequence": 1,
                 "published_at": "2026-10-02T00:00:00Z", "entries": [entry or self.entry]}
        return verify_catalog.verify_harnesses(self.root, json.dumps(index).encode("utf-8"))

    def test_exact_committed_payload_passes_but_new_worktree_cannot_fake_old_commit(self):
        self.assertEqual(self.verify(), 1)
        self.path.write_bytes(self.raw + b" ")
        self.assertEqual(self.verify(), 1, "the valid pinned commit is independent of working-tree edits")
        entry = copy.deepcopy(self.entry)
        entry["sha256"] = hashlib.sha256(self.path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            self.verify(entry)

    def test_missing_commit_path_and_oversized_blob_are_rejected(self):
        entry = copy.deepcopy(self.entry)
        entry["revision"] = "f" * 40
        with self.assertRaisesRegex(ValueError, "unavailable in Git"):
            self.verify(entry)
        entry = copy.deepcopy(self.entry)
        entry["slot_id"] = "missing"
        entry["payload_path"] = "catalog/harnesses/missing.json"
        with self.assertRaisesRegex(ValueError, "regular committed blob"):
            self.verify(entry)
        with mock.patch.object(verify_catalog, "MAX_PAYLOAD_BYTES", len(self.raw) - 1):
            with self.assertRaisesRegex(ValueError, "bytes limit"):
                self.verify()

    def test_payload_requirements_and_version_must_match_index(self):
        for field, value in [("requires", {"recipes": [], "features": []}), ("min_app_version", "1.1.0")]:
            entry = copy.deepcopy(self.entry)
            entry[field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "contract mismatch"):
                self.verify(entry)

    def test_dependency_closure_matches_client_group_limits(self):
        helper = copy.deepcopy(self.payload)
        helper["slug"] = "helper"
        helper_raw = json.dumps(helper).encode("utf-8")
        (self.root / "catalog/harnesses/helper.json").write_bytes(helper_raw)
        self.git("add", "catalog")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "--quiet", "-m", "synthetic dependency")
        entry = copy.deepcopy(self.entry)
        entry.update(slot_id="helper", revision=self.git("rev-parse", "HEAD").strip().decode("ascii"),
                     payload_path="catalog/harnesses/helper.json", sha256=hashlib.sha256(helper_raw).hexdigest())
        parent = copy.deepcopy(self.entry)
        parent["dependencies"] = [{key: entry[key] for key in ("slot_type", "slot_id", "revision", "sha256")}]
        index = {"index_schema_version": 1, "catalog_sequence": 1,
                 "published_at": "2026-10-02T00:00:00Z", "entries": [parent, entry]}
        raw = json.dumps(index).encode("utf-8")
        self.assertEqual(verify_catalog.verify_harnesses(self.root, raw), 2)
        with mock.patch.object(verify_catalog, "MAX_GROUP_BYTES", len(self.raw) + len(helper_raw) - 1):
            with self.assertRaisesRegex(ValueError, "dependency group limit"):
                verify_catalog.verify_harnesses(self.root, raw)
        with mock.patch.object(verify_catalog, "MAX_GROUP_ENTRIES", 1):
            with self.assertRaisesRegex(ValueError, "dependency group limit"):
                verify_catalog.verify_harnesses(self.root, raw)

    def test_committed_symlink_is_not_a_payload(self):
        self.path.unlink()
        try:
            self.path.symlink_to("../../unrelated.json")
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        self.git("add", "catalog")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "--quiet", "-m", "synthetic symlink")
        entry = copy.deepcopy(self.entry)
        entry["revision"] = self.git("rev-parse", "HEAD").strip().decode("ascii")
        with self.assertRaisesRegex(ValueError, "regular committed blob"):
            self.verify(entry)

    def test_payload_encoding_matches_the_rust_utf8_contract(self):
        raw = json.dumps(self.payload).encode("utf-16")
        self.path.write_bytes(raw)
        self.git("add", "catalog")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "--quiet", "-m", "synthetic incompatible encoding")
        entry = copy.deepcopy(self.entry)
        entry.update(revision=self.git("rev-parse", "HEAD").strip().decode("ascii"),
                     sha256=hashlib.sha256(raw).hexdigest())
        with self.assertRaises(UnicodeDecodeError):
            self.verify(entry)


if __name__ == "__main__":
    unittest.main()
