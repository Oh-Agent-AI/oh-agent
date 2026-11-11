"""generic 插件执行环境 Python twin 的行为测试（HARNESS_MANIFEST_DSL_SPEC §8）。

与 Rust 的跨语言字节对齐由 golden case `harness-generic-zcode` 钉（双拍）；
本文件钉 Python 侧行为不变量本身：三态边界、bool/int 纪律、event key
编码、门禁拒绝。
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent
                       / "packages" / "agent-vitals-python"))

from agent_vitals.agent.generic_manifest import ManifestError, parse_manifest  # noqa: E402
from agent_vitals.agent.generic_plugin import (  # noqa: E402
    plugin_validate_payload, run_plugin, validate_gate)
from agent_vitals.agent.generic_recipe import (  # noqa: E402
    extract_line, glob_match, recipe_def)


def zcode_manifest():
    return {
        "manifest_version": 1, "slug": "zcode", "display": {"name": "ZCode"},
        "discovery": {"roots": ["~/data"], "include": ["model-io-sess_*.jsonl"]},
        "source": {"format": "jsonl"},
        "session": {"from": "filename",
                    "pattern": "^model-io-sess_(?P<id>.+)\\.jsonl$"},
        "recipe": "request-usage-anthropic-v1",
        "overrides": {
            "event_ts": "completedAt", "model_raw": "model.modelId",
            "provider_raw": "model.providerId",
            "uncached_input_tokens": "response.providerMetadata.anthropic.usage.input_tokens",
            "cache_read_tokens": "response.providerMetadata.anthropic.usage.cache_read_input_tokens",
            "output_tokens": "response.providerMetadata.anthropic.usage.output_tokens",
            "provider_request_id": "requestId",
        },
        "event_key": {"paths": ["requestId", "attempt"]},
        "billing": {"policy": "lock:metered_estimate"},
    }


def row(request_id, attempt, input_tokens, **extra):
    rec = {
        "requestId": request_id, "attempt": attempt,
        "completedAt": "2026-09-19T15:18:41.337Z",
        "model": {"modelId": "GLM-5.3",
                  "providerId": "builtin:bigmodel-coding-plan"},
        "response": {
            "usage": {"inputTokens": input_tokens + 5},
            "providerMetadata": {"anthropic": {"usage": {
                "input_tokens": input_tokens,
                "cache_read_input_tokens": 5, "output_tokens": 99}}},
        },
    }
    rec.update(extra)
    return rec


class GlobSemanticsTest(unittest.TestCase):
    def test_star_does_not_cross_slash(self):
        self.assertTrue(glob_match("model-io-sess_*.jsonl",
                                   "model-io-sess_a.jsonl"))
        self.assertFalse(glob_match("*.jsonl", "sub/a.jsonl"))

    def test_doublestar_crosses_and_absorbs_zero(self):
        self.assertTrue(glob_match("**/a.jsonl", "x/y/a.jsonl"))
        self.assertTrue(glob_match("**/a.jsonl", "a.jsonl"))

    def test_question_is_exactly_one(self):
        self.assertTrue(glob_match("sess_?.jsonl", "sess_a.jsonl"))
        self.assertFalse(glob_match("sess_?.jsonl", "sess_ab.jsonl"))


class ManifestRulesTest(unittest.TestCase):
    def test_zstd_is_an_optional_source_encoding(self):
        v = zcode_manifest()
        self.assertEqual(parse_manifest(v).compression, "none")
        v["source"]["compression"] = "zstd"
        self.assertEqual(parse_manifest(v).compression, "zstd")
        v["source"]["compression"] = "gzip"
        with self.assertRaises(ManifestError) as ctx:
            parse_manifest(v)
        self.assertEqual(ctx.exception.field, "source.compression")

    def test_schema_version_bounds_match_runtime_grammar(self):
        import re
        from agent_vitals.agent.generic_manifest import _release_version
        schema_path = Path(__file__).resolve().parent.parent / "docs" / "schemas" / "harness-manifest-v1.json"
        rule = json.loads(schema_path.read_text(encoding="utf-8"))["properties"]["min_app_version"]
        for version in ("0.0.0", "1.4.0", "4294967295.4294967295.4294967295",
                        "4294967296.0.0", "1.4294967296.0", "1.0.4294967296",
                        "1.4.0\n", "01.4.0", "1.4.0-rc.1", "1.4.0+build"):
            with self.subTest(version=version):
                accepted = bool(re.search(rule["pattern"], version)) and not re.search(rule["not"]["pattern"], version)
                self.assertEqual(bool(accepted), _release_version(version) is not None)

    def test_shared_capability_fixtures(self):
        fixture = Path(__file__).resolve().parent.parent / "fixtures" / "harness-manifest-capabilities.json"
        for case in json.loads(fixture.read_text(encoding="utf-8")):
            with self.subTest(case=case):
                value = zcode_manifest()
                value.update(case["extension"])
                if "repeat_features" in case:
                    value["requires"] = {"features": ["future"] * case["repeat_features"]}
                if case["error_field"] is None:
                    parse_manifest(value)
                else:
                    with self.assertRaises(ManifestError) as caught:
                        parse_manifest(value)
                    self.assertEqual(caught.exception.field, case["error_field"])
                    self.assertEqual(caught.exception.problem, case["problem"])

    def test_negotiation_uses_injected_runtime_capabilities(self):
        from agent_vitals.agent.generic_manifest import CapabilitySet, negotiate_capabilities
        v = {"min_app_version": "1.10.0", "requires": {"features": ["fixture-feature"]}}
        negotiate_capabilities(v, CapabilitySet("1.10.0", (), ("fixture-feature",)))
        with self.assertRaises(ManifestError) as caught:
            negotiate_capabilities({"recipe": "request-usage-anthropic-v1"}, CapabilitySet(recipes=()))
        self.assertEqual(caught.exception.field, "recipe")
        with self.assertRaises(ManifestError) as caught:
            negotiate_capabilities(v, CapabilitySet("1.9.0", (), ("fixture-feature",)))
        self.assertEqual(caught.exception.field, "min_app_version")

    def test_capabilities_and_release_versions_gate_real_parser(self):
        from agent_vitals.agent.generic_manifest import APP_VERSION, RECIPE_IDS
        for minimum in ("0.0.0", APP_VERSION):
            v = zcode_manifest()
            v.update(min_app_version=minimum, requires={"recipes": list(RECIPE_IDS), "features": []})
            self.assertEqual(parse_manifest(v).facts_harness, "harness:zcode")
        cases = [
            ({"min_app_version": "4294967295.0.0"}, "min_app_version"),
            ({"min_app_version": "01.0.0"}, "min_app_version"),
            ({"min_app_version": "1.0.0-rc.1"}, "min_app_version"),
            ({"min_app_version": "1.0.0+build"}, "min_app_version"),
            ({"min_app_version": "1.0"}, "min_app_version"),
            ({"min_app_version": "4294967296.0.0"}, "min_app_version"),
            ({"min_app_version": None}, "min_app_version"),
            ({"requires": None}, "requires"),
            ({"requires": {"unknown": []}}, "requires.unknown"),
            ({"requires": {"features": ["trust"]}}, "requires.features[0]"),
            ({"requires": {"recipes": ["future-v2"]}}, "requires.recipes[0]"),
            ({"requires": {"recipes": [RECIPE_IDS[0]] * 2}}, "requires.recipes[1]"),
            ({"requires": {"features": "records"}}, "requires.features"),
        ]
        for extension, field in cases:
            with self.subTest(extension=extension):
                v = zcode_manifest()
                v.update(extension)
                with self.assertRaises(ManifestError) as caught:
                    parse_manifest(v)
                self.assertEqual(caught.exception.field, field)

    def test_reserved_slug_and_future_capabilities_rejected(self):
        for bad in ("claude-code", "plugin-x", "ZCode"):
            v = zcode_manifest()
            v["slug"] = bad
            with self.assertRaises(ManifestError):
                parse_manifest(v)
        v = zcode_manifest()
        v["adapter"] = {"command": ["x"]}
        with self.assertRaises(ManifestError) as ctx:
            parse_manifest(v)
        self.assertIn("P1.5", str(ctx.exception))

    def test_session_pattern_subset_is_explicit(self):
        v = zcode_manifest()
        v["session"]["pattern"] = "^s_(?P<id>a)(?P=id)$"
        with self.assertRaises(ManifestError):
            parse_manifest(v)


class TriStateTest(unittest.TestCase):
    def setUp(self):
        self.manifest = parse_manifest(zcode_manifest())
        self.defn = recipe_def(self.manifest.recipe)

    def test_emit_with_native_buckets(self):
        verdict = extract_line(self.defn, self.manifest, row("r1", 1, 886))
        self.assertEqual(verdict[0], "emit")
        cand = verdict[1]
        self.assertEqual(cand["uncached_input_tokens"], 886)
        self.assertEqual(cand["cache_read_tokens"], 5)
        self.assertEqual(cand["source_event_id"], "s2:r1;i1:1;")

    def test_missing_container_is_skip(self):
        rec = {"requestId": "x", "attempt": 1,
               "completedAt": "2026-09-19T15:18:41Z"}
        self.assertEqual(extract_line(self.defn, self.manifest, rec)[0], "skip")

    def test_drift_is_invalid_not_skip(self):
        rec = row("d1", 1, 100)
        del rec["response"]["providerMetadata"]["anthropic"]["usage"]["input_tokens"]
        verdict = extract_line(self.defn, self.manifest, rec)
        self.assertEqual((verdict[0], verdict[1]), ("invalid", "required_field_missing"))

    def test_bool_never_integer(self):
        rec = row("d2", 1, 100)
        rec["response"]["providerMetadata"]["anthropic"]["usage"]["input_tokens"] = True
        verdict = extract_line(self.defn, self.manifest, rec)
        self.assertEqual((verdict[0], verdict[1]), ("invalid", "type_mismatch"))

    def test_over_u64_int_is_rejected_like_serde_f64(self):
        rec = row("d3", 1, 100)
        rec["response"]["providerMetadata"]["anthropic"]["usage"]["input_tokens"] = 2 ** 64
        verdict = extract_line(self.defn, self.manifest, rec)
        self.assertEqual((verdict[0], verdict[1]), ("invalid", "token_type_mismatch"))

    def test_timestamp_without_offset_rejected(self):
        rec = row("d4", 1, 100)
        rec["completedAt"] = "2026-09-19T15:18:41"
        verdict = extract_line(self.defn, self.manifest, rec)
        self.assertEqual((verdict[0], verdict[1]),
                         ("invalid", "timestamp_without_offset"))


class GateAndE2ETest(unittest.TestCase):
    def test_unsupported_capability_refuses_file_loading_before_fact_emission(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = self._setup(tmp)
            value = zcode_manifest()
            value["requires"] = {"features": ["records"]}
            manifest.write_text(json.dumps(value), encoding="utf-8")
            before = sorted(str(p.relative_to(tmp)) for p in Path(tmp).rglob("*"))
            with self.assertRaisesRegex(Exception, r"manifest 校验失败：requires.features\[0\]"):
                run_plugin(str(manifest), [], "m1", tmp)
            payload = plugin_validate_payload(str(manifest), [], "m1", tmp)
            self.assertNotIn("facts", payload)
            self.assertIn("error", payload)
            self.assertIn("requires.features[0]", json.dumps(payload, ensure_ascii=False))
            self.assertEqual(before, sorted(str(p.relative_to(tmp)) for p in Path(tmp).rglob("*")))

    def _setup(self, tmp):
        manifest_dir = Path(tmp) / "harnesses.d" / "zcode"
        manifest_dir.mkdir(parents=True)
        (manifest_dir / "manifest.json").write_text(
            json.dumps(zcode_manifest(), ensure_ascii=False), encoding="utf-8")
        data = Path(tmp) / "data"
        data.mkdir()
        (data / "model-io-sess_aaa.jsonl").write_text(
            "\n".join(json.dumps(r, separators=(",", ":"))
                      for r in (row("r1", 1, 100), row("r2", 1, 200))) + "\n",
            encoding="utf-8")
        return manifest_dir / "manifest.json"

    def test_validate_payload_gate_pass_and_write_face_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = self._setup(tmp)
            payload = plugin_validate_payload(str(manifest), [], "golden", tmp)
            self.assertEqual(payload["mode"], "validate")
            self.assertEqual(payload["gate"], "pass")
            self.assertEqual(payload["report"]["emitted"], 2)
            self.assertTrue(payload["report"]["fact_id_stable"])
            self.assertEqual(payload["facts"][0]["billing_mode"], "metered")
            self.assertEqual(payload["facts"][0]["pricing_basis"],
                             "metered_estimate")
            # 无任何绝对路径进入负载（§6.3）。
            self.assertNotIn(str(tmp), json.dumps(payload))

    def test_zero_corpus_emit_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = self._setup(tmp)
            (Path(tmp) / "data" / "model-io-sess_aaa.jsonl").write_text(
                '{"foo": 1}\n', encoding="utf-8")
            payload = plugin_validate_payload(str(manifest), [], "golden", tmp)
            self.assertEqual(payload["gate"], "refuse")
            self.assertIn("零 emit", payload["gate_problem"])

    def test_run_plugin_end_to_end_counts(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = self._setup(tmp)
            report, facts = run_plugin(str(manifest), [], "m1", tmp)
            self.assertEqual(report["emitted"], 2)
            self.assertEqual(report["models"], ["GLM-5.3"])
            self.assertEqual(facts[0]["fact_id"][:4], "uf1-")
            self.assertEqual(facts[0]["harness"], "harness:zcode")


if __name__ == "__main__":
    unittest.main()


class ErrorStringEncodingTest(unittest.TestCase):
    """负路径错误串与 Rust 逐字对齐（验收修复：golden 不覆盖这些分支，
    用单测钉住，防止 twin 漂移）。"""

    def test_unknown_recipe_uses_rust_debug_shape(self):
        v = zcode_manifest()
        v["recipe"] = "nope"
        with self.assertRaises(ManifestError) as ctx:
            parse_manifest(v)
        self.assertIn(
            '已知：["request-usage-anthropic-v1", '
            '"request-usage-openai-total-input-v1", '
            '"request-usage-four-bucket-v1"]',
            str(ctx.exception))

    def test_negative_version_hits_integer_gate(self):
        v = zcode_manifest()
        v["manifest_version"] = -1
        with self.assertRaises(ManifestError) as ctx:
            parse_manifest(v)
        self.assertIn("必须是整数 1", str(ctx.exception))
        v = zcode_manifest()
        v["manifest_version"] = 2 ** 64
        with self.assertRaises(ManifestError) as ctx:
            parse_manifest(v)
        self.assertIn("必须是整数 1", str(ctx.exception))

    def test_unknown_override_slot_uses_rust_debug_shape(self):
        v = zcode_manifest()
        v["overrides"]["nope"] = "a.b"
        with self.assertRaises(ManifestError) as ctx:
            parse_manifest(v)
        self.assertIn("未知槽位", str(ctx.exception))
