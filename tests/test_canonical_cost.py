#!/usr/bin/env python3
"""canonical 归一层（吸收项 #1）的 Python 侧锁定测试。

per-source 拆账（by_source 轴）只认 DSH 形状的 4 桶，Codex 是独立管线
（codex_fold_file，5 桶 + speed 维），两种线格式永远进不了同一张表。canonical
层在**折叠之上**再加一层归一：把各来源自己折好的桶映射成统一维（FRESH/TOTAL/
cache_read/cache_write/reasoning/legacy），让 #6 事件桥能把 DSH 与 Codex 的
用量排进同一行。

与 Rust 侧对守（单一真相源 `crates/agent-vitals-domain/src/domain/usage.rs` 的 canonical
段，逐字节锁步）：
- `canonical_from_dsh` / `canonical_from_codex` / `canonical_total_delta` /
  `canonical_tokens` 一一对应；
- `test_parity_string_byte_locks_rust` 用**同一条硬编码串**钉死两边输出；
  Rust 侧 `usage.rs::canonical_tokens_python_rust_byte_for_byte_parity` 断言
  同一个串——任何一侧改了归一语义或输出顺序立刻红。

诚实性契约（每条维）：量不到 → null + 进 unavailable，绝不摆 0。整批没有
usage 样本 → 全部维 null；某维源字段整批没上报 → 该维 null；来源 schema 本来
就没有的维（DSH 没有 reasoning、非 total 形状没有 legacy）→ 恒 null。守卫：
任何维 >= 0、fresh <= total（FRESH 是 TOTAL 的真子集）；累计快照回退 → 不产
负数。

跑法：
    python3 -m unittest tests.test_canonical_cost -v
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))
from agent_vitals.agent.usage import (  # noqa: E402
    CANONICAL_DIMS,
    SOURCE_CLI,
    SOURCE_CODEX,
    SOURCE_DSH_LIVE,
    SOURCE_UNSPECIFIED,
    SHAPE_CODEX,
    SHAPE_CODEX_TOTAL,
    SHAPE_DSH,
    SHAPE_UNKNOWN,
    canonical_total_delta,
    canonical_tokens,
)

# 与 Rust `reconcile_fixture()` **逐字同一份夹具**（也是
# `tests/test_per_source_breakdown.py::RECONCILE_FIXTURE` 的同一份）：跨午夜 +
# 同 (turn,step) 替换（8/25 的贡献被 8/26 的同 step 扣光）+ 换模型 + 末条
# 缺 cache 字段。改数字 = 两边一起改。
RECONCILE_FIXTURE = [
    {"type": "request/header", "seq": 1, "time": 1787673000000,
     "data": {"header": {"config": {"model": "pro"}}}},
    # 8/25 23:50
    {"type": "assistant/chunk", "seq": 2, "time": 1787673000000,
     "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
              "usage": {"inputTokens": 1000, "outputTokens": 100,
                        "cacheReadTokens": 50, "cacheWriteTokens": 0}}}},
    # 同 (1,1) 但落到 8/26 00:10 —— 必须把 8/25 的贡献扣掉再记到 8/26
    {"type": "assistant/message", "seq": 3, "time": 1787674200000,
     "data": {"turn": 1, "step": 1,
              "usage": {"inputTokens": 1200, "outputTokens": 120,
                        "cacheReadTokens": 60, "cacheWriteTokens": 0}}},
    # 换模型，仍在 8/26
    {"type": "request/header", "seq": 4, "time": 1787674200000,
     "data": {"header": {"config": {"model": "flash"}}}},
    {"type": "assistant/chunk", "seq": 5, "time": 1787674200000,
     "data": {"turn": 2, "step": 1, "chunk": {"type": "usage",
              "usage": {"inputTokens": 500, "outputTokens": 50}}}},
]

# 与 Rust `canonical_codex_measures_fresh_and_total` 逐字同一份夹具。
CODEX_FIXTURE = [
    {"type": "turn_context", "payload": {"model": "codex-1"}},
    {"type": "event_msg", "payload": {"type": "token_count", "info": {
        "last_token_usage": {"input_tokens": 100, "output_tokens": 30,
                             "cached_input_tokens": 40,
                             "cache_write_input_tokens": 10,
                             "reasoning_output_tokens": 5}}}},
]

# Rust `usage.rs::canonical_tokens_python_rust_byte_for_byte_parity` 硬编码的
# 同一个串。Python 侧生成后硬编码于此，Rust 侧断言同值——双向锁死。
PARITY_JSON = ('{"source":"cli","shape":"dsh","fresh_input_tokens":1700,'
               '"total_tokens":1930,"cache_read_tokens":60,'
               '"cache_write_tokens":0,"reasoning_tokens":null,'
               '"legacy_total_tokens":null,'
               '"unavailable":["reasoning_tokens","legacy_total_tokens"]}')


def _dump(v):
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


class CanonicalDshTests(unittest.TestCase):
    def test_measures_fresh_and_total(self):
        out = canonical_tokens(RECONCILE_FIXTURE, SOURCE_CLI)
        self.assertEqual(out["source"], "cli")
        self.assertEqual(out["shape"], SHAPE_DSH)
        # input = 1200 + 500 = 1700；output = 120 + 50 = 170；cacheRead = 60；
        # cacheWrite 显式报了 0 → 测到 0（不是没测到）。
        self.assertEqual(out["fresh_input_tokens"], 1700)
        self.assertEqual(out["total_tokens"], 1700 + 170 + 60 + 0)
        self.assertEqual(out["cache_read_tokens"], 60)
        self.assertEqual(out["cache_write_tokens"], 0)
        # DSH schema 没有 reasoning 维；legacy 槽只给 codex-total 形状。
        self.assertIsNone(out["reasoning_tokens"])
        self.assertIsNone(out["legacy_total_tokens"])
        self.assertEqual(out["unavailable"],
                         ["reasoning_tokens", "legacy_total_tokens"])

    def test_zero_samples_is_all_unavailable(self):
        out = canonical_tokens([], SOURCE_DSH_LIVE)
        self.assertEqual(out["shape"], SHAPE_DSH)
        for dim in CANONICAL_DIMS:
            self.assertIsNone(out[dim], f"{dim} 无样本必须 null")
        self.assertEqual(out["unavailable"], list(CANONICAL_DIMS))

    def test_unknown_source_is_all_unavailable(self):
        out = canonical_tokens(RECONCILE_FIXTURE, "some-future-source")
        self.assertEqual(out["source"], "some-future-source")
        self.assertEqual(out["shape"], SHAPE_UNKNOWN)
        self.assertIsNone(out["fresh_input_tokens"])
        self.assertIsNone(out["total_tokens"])
        self.assertEqual(out["unavailable"], list(CANONICAL_DIMS))


class CanonicalCodexTests(unittest.TestCase):
    def test_measures_fresh_and_total(self):
        out = canonical_tokens(CODEX_FIXTURE, SOURCE_CODEX)
        self.assertEqual(out["source"], SOURCE_CODEX)
        self.assertEqual(out["shape"], SHAPE_CODEX)
        # uncached = input - cached - cache_write = 100 - 40 - 10 = 50。
        self.assertEqual(out["fresh_input_tokens"], 50)
        self.assertEqual(out["total_tokens"], 50 + 30 + 40 + 10)
        self.assertEqual(out["cache_read_tokens"], 40)
        self.assertEqual(out["cache_write_tokens"], 10)
        self.assertEqual(out["reasoning_tokens"], 5)
        # 5 桶同一份 last_token_usage 全测到；legacy 槽只给 total 形状。
        self.assertEqual(out["unavailable"], ["legacy_total_tokens"])


class CanonicalTotalDeltaTests(unittest.TestCase):
    def test_first_snapshot_is_legacy_only(self):
        cur = {"input_tokens": 100, "output_tokens": 30,
               "cached_input_tokens": 40, "cache_write_input_tokens": 10,
               "reasoning_output_tokens": 5, "total_tokens": 130}
        out = canonical_total_delta(None, cur, SOURCE_CODEX)
        self.assertEqual(out["shape"], SHAPE_CODEX_TOTAL)
        self.assertIsNone(out["fresh_input_tokens"])
        self.assertIsNone(out["total_tokens"])
        self.assertEqual(out["legacy_total_tokens"], 130)
        self.assertEqual(out["unavailable"], [
            "fresh_input_tokens", "total_tokens", "cache_read_tokens",
            "cache_write_tokens", "reasoning_tokens"])

    def test_repeated_snapshot_is_measured_zero(self):
        cur = {"input_tokens": 100, "output_tokens": 30,
               "cached_input_tokens": 40, "cache_write_input_tokens": 10,
               "reasoning_output_tokens": 5, "total_tokens": 130}
        out = canonical_total_delta(cur, cur, SOURCE_CODEX)
        self.assertEqual(out["shape"], SHAPE_CODEX_TOTAL)
        self.assertEqual(out["fresh_input_tokens"], 0)
        self.assertEqual(out["total_tokens"], 0)
        self.assertEqual(out["reasoning_tokens"], 0)
        self.assertEqual(out["unavailable"], [])
        self.assertEqual(out["legacy_total_tokens"], 130)

    def test_measures_the_delta(self):
        prev = {"input_tokens": 100, "output_tokens": 30,
                "cached_input_tokens": 40, "cache_write_input_tokens": 10,
                "reasoning_output_tokens": 5, "total_tokens": 130}
        cur = {"input_tokens": 160, "output_tokens": 50,
               "cached_input_tokens": 60, "cache_write_input_tokens": 20,
               "reasoning_output_tokens": 8, "total_tokens": 210}
        out = canonical_total_delta(prev, cur, SOURCE_CODEX)
        # d_input=60, d_output=20, d_cached=20, d_cw=10, d_reasoning=3
        # d_uncached = 60 - 20 - 10 = 30。
        self.assertEqual(out["fresh_input_tokens"], 30)
        self.assertEqual(out["total_tokens"], 30 + 20 + 20 + 10)
        self.assertEqual(out["cache_read_tokens"], 20)
        self.assertEqual(out["cache_write_tokens"], 10)
        self.assertEqual(out["reasoning_tokens"], 3)
        self.assertEqual(out["unavailable"], [])
        self.assertEqual(out["legacy_total_tokens"], 210)

    def test_cumulative_regression_is_unavailable_not_negative(self):
        # prev 累计比 cur 高（跨会话/畸形数据）→ 不产负数，fresh/total null，
        # raw 累计照放。naive 会 clamp 到 0——那是把「回退」编造成「用了 0」。
        prev = {"input_tokens": 160, "output_tokens": 50,
                "cached_input_tokens": 60, "cache_write_input_tokens": 20,
                "reasoning_output_tokens": 8, "total_tokens": 210}
        cur = {"input_tokens": 100, "output_tokens": 30,
               "cached_input_tokens": 40, "cache_write_input_tokens": 10,
               "reasoning_output_tokens": 5, "total_tokens": 130}
        out = canonical_total_delta(prev, cur, SOURCE_CODEX)
        self.assertIsNone(out["fresh_input_tokens"])
        self.assertIsNone(out["total_tokens"])
        self.assertEqual(out["legacy_total_tokens"], 130)
        self.assertEqual(out["unavailable"], [
            "fresh_input_tokens", "total_tokens", "cache_read_tokens",
            "cache_write_tokens", "reasoning_tokens"])

    def test_fresh_never_exceeds_total(self):
        # 形状各验一遍：FRESH 是 TOTAL 的真子集，永不反超。
        dsh = canonical_tokens(RECONCILE_FIXTURE, SOURCE_CLI)
        codex = canonical_tokens(CODEX_FIXTURE, SOURCE_CODEX)
        for out in (dsh, codex):
            f, t = out["fresh_input_tokens"], out["total_tokens"]
            if f is not None and t is not None:
                self.assertLessEqual(f, t)


class CanonicalParityTests(unittest.TestCase):
    def test_parity_string_byte_locks_rust(self):
        """与 Rust `canonical_tokens_python_rust_byte_for_byte_parity` 用同一条
        硬编码串钉死两边输出。`ensure_ascii=False` + `separators=(",", ":")` 与
        serde_json 的默认序列化逐字节对齐；`preserve_order` 下 Map 插入序 = 输出
        序，Python dict 同序——这是双向锁步的前提。
        """
        out = canonical_tokens(RECONCILE_FIXTURE, SOURCE_CLI)
        self.assertEqual(_dump(out), PARITY_JSON)
        self.assertEqual(PARITY_JSON, json.loads(PARITY_JSON) and PARITY_JSON)
        # 同一串喂回 JSON 语义再序列化，保证硬编码串本身就是合法紧凑 JSON。
        self.assertEqual(_dump(json.loads(PARITY_JSON)), PARITY_JSON)

    def test_unspecified_source_uses_dsh_shape(self):
        # SOURCE_UNSPECIFIED 与 cli 同走 dsh 翻译表——canonical 只按来源标签
        # 声明 shape，不猜。
        out = canonical_tokens(RECONCILE_FIXTURE, SOURCE_UNSPECIFIED)
        self.assertEqual(out["shape"], SHAPE_DSH)
        self.assertEqual(out["fresh_input_tokens"], 1700)


if __name__ == "__main__":
    unittest.main()
