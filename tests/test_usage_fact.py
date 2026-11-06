#!/usr/bin/env python3
"""v0.7 spec §2/§4：`UsageFact` 序列化契约（候选 #3）+ 迁移链骨架（候选 #4）。

纯函数钉测——`usage_fact.py` 没有任何 I/O、没有任何持久化调用点，与
`crates/agent-vitals-domain/src/contracts/usage_fact.rs` 的 inline 测试同一组夹具同一
组期望值互守（`fact_id` 的跨语言 pinned 值尤其关键：两侧必须对同一组入参
产出同一个字符串，否则"共享序列化契约"这个说法就是假的）。

见该模块 docstring 里"明确没做的"清单——这不是数据平面迁移，只是候选 #3/#4
描述的机制骨架，没有任何 harness adapter 被接上。
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))

from agent_vitals.agent.usage_fact import (  # noqa: E402
    CURRENT_SCHEMA_VERSION,
    USAGE_FACT_FIELDS,
    build_usage_fact,
    fact_id,
    migrate_chain,
)

_IDENTITY = {
    "machine_namespace": "m1", "harness": "claude-code", "source_profile": "default",
    "native_session_id": "sess-1", "source_event_id": "evt-1",
    "observation_kind": "message",
}


class FactIdCase(unittest.TestCase):
    def test_deterministic_and_order_sensitive(self):
        a = fact_id("ns", "claude-code", "default", "sess-1", "evt-1", "message")
        b = fact_id("ns", "claude-code", "default", "sess-1", "evt-1", "message")
        self.assertEqual(a, b, "同输入必须同输出")
        c = fact_id("ab", "c", "default", "sess-1", "evt-1", "message")
        d = fact_id("a", "bc", "default", "sess-1", "evt-1", "message")
        self.assertNotEqual(c, d, "unit separator 分隔失效会让不同身份撞出同一个 fact_id")

    def test_matches_rust_mirror_pinned_value(self):
        """与 `usage_fact.rs::fact_id_matches_python_mirror_pinned_value`
        同一组入参、同一个钉死值——跨语言字节相同是"共享契约"这个说法成立
        的前提。"""
        self.assertEqual(
            fact_id("m1", "claude-code", "default", "sess-1", "evt-1", "message"),
            "uf1-6831c1133defe99f")


class BuildUsageFactCase(unittest.TestCase):
    def test_fills_all_fields_and_stamps_identity(self):
        out = build_usage_fact(dict(_IDENTITY, uncached_input_tokens=100))
        self.assertEqual(out["schema_version"], CURRENT_SCHEMA_VERSION)
        self.assertEqual(out["identity_basis"], "native")
        self.assertEqual(out["fact_id"], fact_id(*_IDENTITY.values()))
        self.assertEqual(out["uncached_input_tokens"], 100)
        self.assertIn("cache_read_tokens", out)
        self.assertIsNone(out["cache_read_tokens"])
        self.assertEqual(len(out), len(USAGE_FACT_FIELDS) + 1)

    def test_identity_tuple_written_to_doc(self):
        """P1-1 修订：`machine_namespace` 与 `native_session_id` 是 `fact_id`
        入参，必须写入文档；持久化后能从文档独立复算主键。两字段同时是
        IDENTITY_INPUT_FIELDS（必填）与 USAGE_FACT_FIELDS（必出）。
        """
        out = build_usage_fact(dict(_IDENTITY, uncached_input_tokens=1))
        self.assertEqual(out["machine_namespace"], "m1")
        self.assertEqual(out["native_session_id"], "sess-1")
        # 文档必须能独立复算 fact_id——从文档字段拼回 6 元组 → fact_id 字节相等。
        reconstructed = (
            out["machine_namespace"], out["harness"], out["source_profile"],
            out["native_session_id"], out["source_event_id"], out["observation_kind"],
        )
        self.assertEqual(out["fact_id"], fact_id(*reconstructed),
                         "fact_id 必须能从文档字段独立复算")

    def test_rejects_missing_identity_fields_by_name(self):
        with self.assertRaises(ValueError) as cm:
            build_usage_fact({"harness": "claude-code"})
        problems = cm.exception.args[0]
        for k in ("machine_namespace", "source_profile", "native_session_id",
                  "source_event_id", "observation_kind"):
            self.assertTrue(any(k in p for p in problems), k)
        self.assertFalse(any(p.endswith(" harness") for p in problems))

    def test_rejects_negative_token_fields(self):
        with self.assertRaises(ValueError) as cm:
            build_usage_fact(dict(_IDENTITY, output_tokens=-5))
        self.assertTrue(any("output_tokens" in p for p in cm.exception.args[0]))

    def test_respects_explicit_derived_hash_basis(self):
        out = build_usage_fact(dict(_IDENTITY, identity_basis="derived-hash"))
        self.assertEqual(out["identity_basis"], "derived-hash")

    def test_none_fields_dict_does_not_crash(self):
        with self.assertRaises(ValueError):
            build_usage_fact(None)


class MigrateChainCase(unittest.TestCase):
    @staticmethod
    def _bump(doc):
        doc = dict(doc)
        doc["schema_version"] += 1
        doc["migrated_through"] = doc.get("migrated_through", 0) + 1
        return doc

    def test_walks_sequential_versions_not_a_jump(self):
        out = migrate_chain({"schema_version": 1},
                            {1: self._bump, 2: self._bump}, 3)
        self.assertEqual(out["status"], "migrated")
        self.assertEqual(out["doc"]["schema_version"], 3)
        self.assertEqual(out["doc"]["migrated_through"], 2)

    def test_current_version_is_a_noop(self):
        doc = {"schema_version": 2, "x": 1}
        out = migrate_chain(doc, {}, 2)
        self.assertEqual(out["status"], "current")
        self.assertEqual(out["doc"], doc)

    def test_future_version_is_readonly_not_an_error(self):
        out = migrate_chain({"schema_version": 5}, {}, 2)
        self.assertEqual(out["status"], "future-readonly")
        self.assertEqual(out["doc"]["schema_version"], 5)
        self.assertIn("read-only", out["warning"])

    def test_missing_migration_step_is_an_honest_error(self):
        out = migrate_chain({"schema_version": 1}, {1: self._bump}, 3)
        self.assertEqual(out["status"], "error")
        self.assertEqual(out["doc"]["schema_version"], 2, "已完成的那一步保留")

    def test_missing_schema_version_is_an_honest_error(self):
        out = migrate_chain({"x": 1}, {}, 1)
        self.assertEqual(out["status"], "error")
        self.assertEqual(out["error"], "missing schema_version")

    def test_is_idempotent_at_target_version(self):
        once = migrate_chain({"schema_version": 1}, {1: self._bump}, 2)
        self.assertEqual(once["status"], "migrated")
        twice = migrate_chain(once["doc"], {1: self._bump}, 2)
        self.assertEqual(twice["status"], "current")
        self.assertEqual(twice["doc"], once["doc"])

    def test_schema_version_exceeding_u32_max_is_an_honest_error(self):
        """P1-2 修订：`schema_version` 超出 u32::MAX (=4294967295) → 显式
        报错。Rust 侧 `as u32` 会截断成 1（4294967297→1），Python int 是任意
        精度会保留原值——显式校验保证跨语言字节一致。
        """
        # 4294967297 = u32::MAX + 2 → Rust 截断后是 1、Python 是 4294967297。
        out = migrate_chain({"schema_version": 4_294_967_297}, {1: self._bump}, 2)
        self.assertEqual(out["status"], "error")
        self.assertIn("exceeds u32::MAX", out["error"])
        # 边界：u32::MAX 本身仍合法。比 target_version=2 大得多，正确分支是
        # future-readonly——关键是**不**是 migrated（如果被截断成 1→走迁移分支）。
        out_max = migrate_chain({"schema_version": 0xFFFFFFFF}, {1: self._bump}, 2)
        self.assertNotEqual(out_max["status"], "migrated",
                            "u32::MAX 边界必须不被截断——错误地当成 1 会进入 migrated 分支")
        self.assertEqual(out_max["status"], "future-readonly")

    def test_migration_step_must_advance_schema_version(self):
        """P1-3 修订：迁移步必须实际把 schema_version 抬到下一档。坏迁移
        （忘记升版本）→ 立即报错，不让写链拿到旧格式当新格式。
        """
        # 坏迁移：返回 doc 但不动 schema_version。
        def bad_step(doc):
            return dict(doc)  # 原样返回，schema_version 不变
        out = migrate_chain({"schema_version": 1}, {1: bad_step}, 2)
        self.assertEqual(out["status"], "error")
        self.assertIn("did not advance version", out["error"])
        # 另一个坏迁移：把 schema_version 抬到错误档位（v+2 而非 v+1）。
        def skip_step(doc):
            d = dict(doc)
            d["schema_version"] = 3
            return d
        out2 = migrate_chain({"schema_version": 1}, {1: skip_step}, 2)
        self.assertEqual(out2["status"], "error")
        # 还有一个坏迁移：把 schema_version 字段直接删了。
        def remove_step(doc):
            d = dict(doc)
            d.pop("schema_version", None)
            return d
        out3 = migrate_chain({"schema_version": 1}, {1: remove_step}, 2)
        self.assertEqual(out3["status"], "error")
        self.assertIn("removed schema_version", out3["error"])


class FieldVocabCase(unittest.TestCase):
    def test_no_duplicates(self):
        self.assertEqual(len(USAGE_FACT_FIELDS), len(set(USAGE_FACT_FIELDS)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
