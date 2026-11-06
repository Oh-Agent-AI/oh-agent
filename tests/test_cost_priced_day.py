#!/usr/bin/env python3
"""`cost.py::priced_day` 的交叉锁定测试 —— 与 Rust `cost.rs::priced_day` 对守。

`priced_day` 是「一份日桶 → 精确/部分计价」的**唯一覆盖率校验入口**（8 月账目
回归的教训：覆盖不全被当精算报出去，剩余 token 静默消失）。这里把 Python 侧的
输出钉到**具体数值**，与 `crates/agent-vitals-domain/src/domain/cost/mod.rs` 里三条
`priced_day_*` 单测的期望值逐一对应——同一份夹具、同一组数字，两边各自断言，
docstring 互相指认。Rust 侧多一个 `partial` 时 `coverage == covered/day` 的
分式断言，这里用浮点近似对齐（Python 的除法与 Rust f64 除法逐位一致，但
`assertEqual` 的浮点比较语义不同，统一用 `assertAlmostEqual` 容差）。

跑法：
    python3 -m unittest tests.test_cost_priced_day -v
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))

from agent_vitals.agent.cost import load_pricing, priced_day  # noqa: E402

PRICING = load_pricing()

# 与 Rust `cost.rs` 三条 priced_day 单测**逐字同一份夹具**。改数字 = 两边一起改，
# 任何一边单独漂移都会让另一侧的测试失去参照。
DAY_EXACT = {
    "uncached_input_tokens": 1000000, "output_tokens": 0,
    "cache_read_tokens": 0, "cache_write_tokens": 0,
    "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
    "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
    "by_model": {"deepseek-v4-flash": {
        "uncached_input_tokens": 1000000, "output_tokens": 0,
        "cache_read_tokens": 0, "cache_write_tokens": 0,
        "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
        "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
    }},
}

DAY_PARTIAL = {
    "uncached_input_tokens": 1000000, "output_tokens": 0,
    "cache_read_tokens": 0, "cache_write_tokens": 0,
    "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
    "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
    "by_model": {"deepseek-v4-flash": {
        "uncached_input_tokens": 300000, "output_tokens": 0,
        "cache_read_tokens": 0, "cache_write_tokens": 0,
        "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
        "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
    }},
}

DAY_NO_BY_MODEL = {
    "uncached_input_tokens": 1000000, "output_tokens": 0,
    "cache_read_tokens": 0, "cache_write_tokens": 0,
    "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
    "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
}


class PricedDayLockstepTests(unittest.TestCase):
    def test_exact_when_by_model_covers_all(self):
        """对应 Rust `priced_day_exact_when_by_model_covers_all`：by_model 覆盖
        完整 → `exact` + coverage 1.0，100 万 uncached 全空闲按 flash 1.5 元/百万
        → total 1.5。"""
        out = priced_day(DAY_EXACT, PRICING)
        self.assertIsNotNone(out)
        self.assertEqual(out["pricing_basis"], "exact")
        self.assertAlmostEqual(out["coverage"], 1.0)
        self.assertAlmostEqual(out["total"], 1.5)
        self.assertEqual(out["peak_total"], 0.0)

    def test_partial_when_by_model_covers_only_part(self):
        """对应 Rust `priced_day_partial_when_by_model_covers_only_part`：by_model
        只覆盖 30 万 → `partial` + coverage 0.3，剩余 70 万按 fallback（原厂 flash）
        补齐，total 仍等于全量 1.5（fallback 落的就是 flash 这张卡）。"""
        out = priced_day(DAY_PARTIAL, PRICING)
        self.assertIsNotNone(out)
        self.assertEqual(out["pricing_basis"], "partial")
        self.assertAlmostEqual(out["coverage"], 0.3)
        self.assertAlmostEqual(out["total"], 1.5)

    def test_none_without_by_model(self):
        """对应 Rust `priced_day_none_without_by_model`：无 by_model → None，调用方
        自己决定退回哪种近似，本函数不摆全零结构。"""
        self.assertIsNone(priced_day(DAY_NO_BY_MODEL, PRICING))


if __name__ == "__main__":
    unittest.main()
