#!/usr/bin/env python3
"""`cost.py::cost_series` 的交叉锁定测试 —— 与 Rust `cost.rs::cost_series` 对守。

`cost_series` 是逐请求费用序列（工作台单会话图的「费用」纵轴读它，dsh-client 审计
tab 读的是同一规则的 TS 镜像 `costSeriesFrom`）。这里把 Python 侧的输出钉到**具体
数值**，与 `crates/agent-vitals-domain/src/domain/cost/mod.rs` 里三条 `cost_series_*` 单测的期望值
逐一对应——同一份夹具、同一组数字，两边各自断言，docstring 互相指认。CLI 差分
（`tests/test_cli_matrix.py` 的 `both()`）另从 `behavior --json` 信封里逐字节比对
`cost_series` 键，这里负责把语义钉死（曲线终值 == `cost_report.total`、null_peak
carry 而非归零、未知模型不计价）。

跑法：
    python3 -m unittest tests.test_cost_series -v
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))

from agent_vitals.agent.cost import cost_report, cost_series, load_pricing  # noqa: E402

PRICING = load_pricing()

# 与 Rust `cost.rs` 三条 cost_series 单测**逐字同一份夹具**。改数字 = 两边一起改，
# 任何一边单独漂移都会让另一侧的测试失去参照。
REQUESTS_PRICE = [
    {"request_seq": 1, "model": "deepseek/deepseek-v4-flash",
     "uncached_input_tokens": 1000000, "cache_read_tokens": 0,
     "output_tokens": 0, "is_peak": False},
    {"request_seq": 2, "model": "deepseek/deepseek-v4-pro-0813",
     "uncached_input_tokens": 2000000, "cache_read_tokens": 0,
     "output_tokens": 1000000, "is_peak": True},
    {"request_seq": 3, "model": "deepseek/deepseek-v4-flash",
     "uncached_input_tokens": 1000000, "cache_read_tokens": 0,
     "output_tokens": 1000000, "is_peak": True},
]

PROVIDERS = {
    "deepseek/deepseek-v4-flash": "deepseek-official",
    "deepseek/deepseek-v4-pro-0813": "deepseek-official",
}

# REQUESTS_PRICE 同批 token 折成 by_model（is_peak → peak_* 子桶）。
USAGE_PRICE = {
    "by_model": {
        "deepseek/deepseek-v4-flash": {
            "uncached_input_tokens": 2000000, "cache_read_tokens": 0,
            "output_tokens": 1000000, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 1000000, "peak_output_tokens": 1000000,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
        "deepseek/deepseek-v4-pro-0813": {
            "uncached_input_tokens": 2000000, "cache_read_tokens": 0,
            "output_tokens": 1000000, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 2000000, "peak_output_tokens": 1000000,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
    },
    "providers": PROVIDERS,
    "sequence": [],
}

REQUESTS_NULL_PEAK = [
    {"request_seq": 1, "model": "deepseek-v4-flash",
     "uncached_input_tokens": 1000000, "cache_read_tokens": 0,
     "output_tokens": 0, "is_peak": False},
    {"request_seq": 2, "model": "deepseek-v4-flash",
     "uncached_input_tokens": 1000000, "cache_read_tokens": 0,
     "output_tokens": 0, "is_peak": None},
    {"request_seq": 3, "model": "deepseek-v4-flash",
     "uncached_input_tokens": 1000000, "cache_read_tokens": 0,
     "output_tokens": 0},  # 没有 is_peak 键 = None，同第二条
]

REQUESTS_UNKNOWN = [
    {"request_seq": 1, "model": "some/unknown-model",
     "uncached_input_tokens": 1000000, "cache_read_tokens": 0,
     "output_tokens": 0, "is_peak": False},
]


class CostSeriesLockstepTests(unittest.TestCase):
    def test_prices_per_request_and_matches_cost_report_total(self):
        """对应 Rust `cost_series_prices_per_request_and_matches_cost_report_total`：
        r1 flash 空闲 uncached 1.5 → r2 pro 高峰 18+27=45 → r3 flash 高峰 3+9=12，
        累计 1.5 / 46.5 / 58.5；曲线终值 == cost_report.total（同一批 token）。"""
        out = cost_series(REQUESTS_PRICE, PROVIDERS, PRICING)
        self.assertEqual(out["priced"], 3)
        self.assertEqual(out["total"], 3)
        cum = [s["cumulative"] for s in out["series"]]
        self.assertAlmostEqual(cum[0], 1.5)
        self.assertAlmostEqual(cum[1], 46.5)
        self.assertAlmostEqual(cum[2], 58.5)
        report = cost_report(USAGE_PRICE, PRICING)
        self.assertAlmostEqual(report["total"], cum[2],
                               msg="曲线终值必须等于 cost_report.total")

    def test_carries_unpriced_on_null_peak(self):
        """对应 Rust `cost_series_carries_unpriced_on_null_peak`：is_peak 为 None（执行环境
        没上报时间戳）→ 这笔不计价，累计保持、priced 不增——不是按空闲价猜一档，
        也不是归零。缺 is_peak 键同 None。"""
        out = cost_series(REQUESTS_NULL_PEAK, {}, PRICING)
        self.assertEqual(out["priced"], 1)
        self.assertEqual(out["total"], 3)
        cum = [s["cumulative"] for s in out["series"]]
        self.assertAlmostEqual(cum[0], 1.5)
        self.assertAlmostEqual(cum[1], 1.5, msg="is_peak=None 必须 carry 而非归零")
        self.assertAlmostEqual(cum[2], 1.5, msg="缺 is_peak 键同 None")

    def test_unknown_model_is_unpriced_not_zero(self):
        """对应 Rust `cost_series_unknown_model_is_unpriced_not_zero`：未知模型 →
        不计价、priced 不增、累计保持 0——不是「查不到价按 0 元计」然后计入 priced。"""
        out = cost_series(REQUESTS_UNKNOWN, {}, PRICING)
        self.assertEqual(out["priced"], 0)
        self.assertEqual(out["total"], 1)
        self.assertEqual(out["series"][0]["cumulative"], 0.0)


if __name__ == "__main__":
    unittest.main()
