"""归因签名目录（`assets/attribution_signatures.json`）的 Python 侧规则测试 +
claude-code emitter 在 L1 路由证据上的双实现 byte-parity。

规格：docs/v1.0.0/BETA_1_AUTO_ATTRIBUTION_SPEC.md §1.2/§2。Rust 镜像：
`crates/agent-vitals-domain/src/domain/attribution.rs` 的同名测试
（`real_machine_model_names_all_resolve_to_a_vendor` /
`route_shapes_follow_the_measured_id_formats`）。两边的期望表必须逐条相同。
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))

_BIN = os.environ.get("AGENT_VITALS_BIN")
PY_CMD = [sys.executable, str(ROOT / "scripts" / "scan.py")]

from agent_vitals.agent.attribution import (  # noqa: E402
    GATEWAY, OFFICIAL_VENDOR, UNKNOWN, VENDOR_SHAPE, evidence_basis_of, model_vendor,
    official_endpoint_of, route_shape, signatures,
)


class SignatureCatalogTests(unittest.TestCase):
    def test_catalog_shape(self):
        catalog = signatures()
        for vendor, spec in catalog["vendors"].items():
            self.assertTrue(spec.get("model_prefixes") or spec.get("official_endpoints"), vendor)

    def test_real_machine_model_names_all_resolve_to_a_vendor(self):
        cases = [
            ("claude-sonnet-5", "anthropic", False), ("claude-opus-5", "anthropic", False),
            ("claude-haiku-4-5-20251001", "anthropic", False), ("anthropic/claude-opus-5", "anthropic", True),
            ("gpt-5.6-luna", "openai", False), ("gpt-6-astra", "openai", False), ("openai/gpt-5.6-sol", "openai", True),
            ("deepseek-v4-flash", "deepseek", False), ("deepseek/deepseek-v4.1-flash", "deepseek", True),
            ("MiniMax-M3", "minimax", False), ("MiniMax-M2.7", "minimax", False),
            ("glm-5.3-flash", "zhipu-glm", False), ("bigmodel/glm-5.3-flash", "zhipu-glm", True),
            ("moonshot/kimi-k3", "moonshot", True), ("hy4-preview-f", "hunyuan", False),
        ]
        for model, vendor, gateway in cases:
            match = model_vendor(model)
            self.assertIsNotNone(match, model)
            self.assertEqual((match.vendor, match.gateway_named), (vendor, gateway), model)
        two_level = model_vendor("openrouter/anthropic/claude-opus-5")
        self.assertEqual((two_level.vendor, two_level.gateway_named), ("anthropic", True))
        self.assertEqual(route_shape("claude-opus-5", "req_011Cf5wHSjBXJbBc7FLDugfD", "msg_01ABCDEFGHJKLMNPQRSTUVWX\n"), (GATEWAY, None),
                         "an id with trailing whitespace never counts as official")
        for sentinel in ("<synthetic>", "fast-model", "totally-unknown-model", ""):
            self.assertIsNone(model_vendor(sentinel), sentinel)

    def test_route_shapes_follow_the_measured_id_formats(self):
        req = "req_011Cf5wHSjBXJbBc7FLDugfD"
        self.assertEqual(route_shape("claude-opus-5", req, "msg_01ABCDEFGHJKLMNPQRSTUVWX"), (OFFICIAL_VENDOR, "anthropic"))
        self.assertEqual(route_shape("claude-opus-5", None, "msg_bd1234567890abcdef"), (GATEWAY, None))
        self.assertEqual(route_shape("anthropic/claude-opus-5", req, "msg_01ABCDEFGHJKLMNPQRSTUVWX"), (GATEWAY, None))
        self.assertEqual(route_shape("claude-opus-5", None, None), (UNKNOWN, None))
        self.assertEqual(route_shape("MiniMax-M3", None, "06eed8a1b2c3d4e5f60718293a4b5c6d"), (VENDOR_SHAPE, "minimax"))
        self.assertEqual(route_shape("glm-5.3-flash", None, "msg_20260915123456789"), (VENDOR_SHAPE, "zhipu-glm"))
        self.assertEqual(route_shape("deepseek-v4-flash", None, "chatcmpl-abc123"), (GATEWAY, None))
        self.assertEqual(route_shape("deepseek-v4-flash", None, None), (UNKNOWN, None))
        self.assertEqual(route_shape("<synthetic>", None, "09c007aa"), (UNKNOWN, None))
        self.assertEqual(evidence_basis_of(OFFICIAL_VENDOR), "session-native")
        self.assertEqual(evidence_basis_of(GATEWAY), "inferred")
        self.assertEqual(evidence_basis_of(UNKNOWN), "missing")
        self.assertEqual(official_endpoint_of("anthropic"), "api.anthropic.com")


def _record(model, request_id, message_id, ts, tokens=100):
    rec = {"type": "assistant", "timestamp": ts,
           "message": {"model": model, "usage": {"input_tokens": tokens, "output_tokens": 10,
                                                 "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}}
    if message_id is not None:
        rec["message"]["id"] = message_id
    else:
        rec["uuid"] = "uuid-" + model.replace("/", "_") + "-" + ts
    if request_id is not None:
        rec["requestId"] = request_id
    return rec


def _route_corpus():
    """一条一种形状：官方 Anthropic / 网关式命名 / 厂商形状一致 / OpenAI 兼容形状打
    在 deepseek 上 / 没有任何 ID。"""
    return [
        _record("claude-opus-5", "req_011Cf5wHSjBXJbBc7FLDugfD", "msg_01ABCDEFGHJKLMNPQRSTUVWX", "2026-09-10T01:00:00.000Z"),
        _record("anthropic/claude-opus-5", None, "msg_bd1234567890abcdef", "2026-09-10T01:01:00.000Z"),
        _record("MiniMax-M3", None, "06eed8a1b2c3d4e5f60718293a4b5c6d", "2026-09-10T01:02:00.000Z"),
        _record("deepseek-v4-flash", None, "chatcmpl-abc123", "2026-09-10T01:03:00.000Z"),
        _record("glm-5.3-flash", None, None, "2026-09-10T01:04:00.000Z"),
    ]


class ClaudeRouteEvidenceTests(unittest.TestCase):
    """Python emitter 单侧：每种形状落到规格 §2 说的字段组合。"""

    def test_python_emitter_route_fields(self):
        from agent_vitals.agent.claude_usage_fact import claude_jsonl_to_usage_facts
        tmp = Path(tempfile.mkdtemp())
        session = tmp / "sid-route.jsonl"
        session.write_text("".join(json.dumps(r) + "\n" for r in _route_corpus()), encoding="utf-8")
        result = claude_jsonl_to_usage_facts(session, machine_namespace="ns", source_profile="default")
        by_model = {f["model_raw"]: f for f in result.facts}
        official = by_model["claude-opus-5"]
        self.assertEqual((official["provider_id"], official["provider_raw"], official["endpoint_host"],
                          official["evidence_basis"], official["pricing_basis"]),
                         ("anthropic", "anthropic", "api.anthropic.com", "session-native", "route-observed"))
        self.assertTrue(official["route_evidence_id"].startswith("route:"))
        for model in ("anthropic/claude-opus-5", "MiniMax-M3", "deepseek-v4-flash"):
            fact = by_model[model]
            self.assertIsNone(fact["provider_id"], model)
            self.assertEqual(fact["evidence_basis"], "inferred", model)
            self.assertEqual(fact["pricing_basis"], "metered_estimate", model)
            self.assertTrue(fact["route_evidence_id"].startswith("route:"), model)
        unknown = by_model["glm-5.3-flash"]
        self.assertEqual(unknown["evidence_basis"], "missing")
        self.assertIsNone(unknown["route_evidence_id"])
        for fact in result.facts:
            self.assertEqual(fact["attribution_version"], "provider-v1.0-beta.1")
            self.assertEqual(fact["billing_mode"], "metered", "inferred/official 都不能单独判成订阅")


@unittest.skipUnless(_BIN, "未设 AGENT_VITALS_BIN，跳过双实现比对")
class ClaudeRouteEvidenceBothTests(unittest.TestCase):
    """Python ↔ Rust：同一份形状语料，`claude-usage-facts --json -` stdout 逐字节相等。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.fixture = self.tmp / "fixture"
        self.fixture.mkdir()
        self.session = self.fixture / "sid-route.jsonl"
        self.session.write_text("".join(json.dumps(r) + "\n" for r in _route_corpus()), encoding="utf-8")

    def _run(self, cmd):
        env = dict(os.environ)
        env["HOME"] = str(self.fixture)
        env["USERPROFILE"] = str(self.fixture)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env.pop("AGENT_VITALS_BIN", None)
        return subprocess.run(cmd, env=env, capture_output=True, text=True, cwd=str(self.fixture))

    def test_python_rust_route_evidence_byte_equal(self):
        args = ["claude-usage-facts", str(self.session), "--machine-namespace", "ns-parity",
                "--source-profile", "default", "--json", "-"]
        py = self._run(PY_CMD + args)
        rs = self._run([_BIN] + args)
        self.assertEqual(py.returncode, 0, py.stderr)
        self.assertEqual(rs.returncode, 0, rs.stderr)
        self.assertEqual(py.stdout, rs.stdout, "route evidence fields diverge:\npy:\n%s\nrs:\n%s" % (py.stdout, rs.stdout))
        doc = json.loads(py.stdout)
        bases = sorted(f["evidence_basis"] for f in doc["facts"])
        self.assertEqual(bases, ["inferred", "inferred", "inferred", "missing", "session-native"])


if __name__ == "__main__":
    unittest.main()
