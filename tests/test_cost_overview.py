#!/usr/bin/env python3
"""`budget.py` 的月/日成本聚合 与 Rust `cost.rs::month_cost/today_cost/bucket_cost`
的交叉锁定 —— Tauri 菜单栏的消费面。

菜单栏（Rust-Tauri）要展示「今日 / 本月成本 + 预算」，它读的是同一份
month.json/today.json。CLAUDE.md 的教训：同一份数据在两个投影上算出不同的钱
（¥4.50 vs ¥18.00）就是因为各写一份「有没有 by_model 就……」的判断。这里把
Rust 侧 `cost.rs` 三个纯函数的期望值钉到**具体数值**，与 Python 侧
`budget._bucket_cost` + `cost.priced_day` 的组合对同一份夹具逐一对应——
同一夹具、同一组数字，两边各自断言，docstring 互相指认（Rust 侧单测见
`crates/agent-vitals-domain/src/domain/cost/mod.rs` 的 `bucket_cost_*`/`month_cost_*`/
`today_cost_*`）。

跑法：
    python3 -m unittest tests.test_cost_overview -v
"""

import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))

from agent_vitals.agent import budget  # noqa: E402
from agent_vitals.agent.cost import load_pricing  # noqa: E402

PRICING = load_pricing()

# 与 Rust `cost.rs` 单测**逐字同一份夹具**。改数字 = 两边一起改，任何一边单独
# 漂移都会让另一侧的测试失去参照。
LEGACY_BUCKET = {
    "uncached_input_tokens": 1000000, "output_tokens": 0,
    "cache_read_tokens": 0, "cache_write_tokens": 0,
    "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
    "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
}

EXACT_DAY = dict(LEGACY_BUCKET, by_model={"deepseek-v4-flash": dict(LEGACY_BUCKET)})

MONTH_DAYS = {
    "2026-08-01": dict(LEGACY_BUCKET, by_model={"deepseek-v4-flash": dict(LEGACY_BUCKET)}),
    "2026-08-02": dict(LEGACY_BUCKET, uncached_input_tokens=2000000),
}

TODAY_BY_MODEL = {"date": "2026-08-27", "by_model": {"deepseek-v4-flash": dict(LEGACY_BUCKET)}}
TODAY_STALE = {"date": "2026-08-26", "by_model": {"deepseek-v4-flash": dict(LEGACY_BUCKET)}}
TODAY_BUCKETS = {"date": "2026-08-27", "buckets": {"h:07": dict(LEGACY_BUCKET)}}


class CostOverviewLockstepTests(unittest.TestCase):
    def test_bucket_cost_prices_legacy_day_via_fallback_flash(self):
        """对应 Rust `bucket_cost_prices_legacy_day_via_fallback_flash`：legacy 桶
        走 fallback flash，1M uncached 全空闲 → 1.5。"""
        out = budget._bucket_cost(LEGACY_BUCKET, PRICING)
        self.assertAlmostEqual(out["total"], 1.5)
        self.assertEqual(out["peak_total"], 0.0)

    def test_month_cost_sums_exact_and_legacy_days(self):
        """对应 Rust `month_cost_sums_exact_and_legacy_days`：exact 日 1.5 + legacy
        日（2M→3.0）→ total 4.5。与 `budget.compute_month_cost` 的定价段同套判断。"""
        total = 0.0
        peak = 0.0
        for day in MONTH_DAYS.values():
            c = budget.cost_module.priced_day(day, PRICING) or budget._bucket_cost(day, PRICING)
            total += c["total"]
            peak += c.get("peak_total", 0.0)
        self.assertAlmostEqual(total, 4.5)
        self.assertEqual(peak, 0.0)

    def test_today_cost_stale_date_is_none_not_wrong_number(self):
        """对应 Rust `today_cost_stale_date_is_none_not_wrong_number`：date 停在昨天
        → None，不把昨天的账当今天的报（真机回归：2026-08-27 没用过 DSH，仍报
        08-26 的 ¥3.09）。端到端验证 `compute_today_cost` 的 date 分支——用临时
        `$AGENT_VITALS_HOME` 放一份 date=昨天的 today.json，读路径必须判 None，
        而不是把昨天的花费当今天的报出去。"""
        import json as _json
        import tempfile
        from unittest import mock as _mock

        tmpdir = tempfile.mkdtemp(prefix="sv-cost-overview-test-")
        try:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir(parents=True)
            (state_dir / "today.json").write_text(
                _json.dumps(TODAY_STALE), encoding="utf-8")
            with _mock.patch.dict(os.environ, {"AGENT_VITALS_HOME": tmpdir}, clear=False):
                from agent_vitals import state as st
                # 锚：today.json 的 date 是昨天（相对 state._today_key 必不等）。
                self.assertNotEqual(TODAY_STALE["date"], st._today_key())
                self.assertIsNone(budget.compute_today_cost())
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_today_cost_prices_by_model_when_present(self):
        """对应 Rust `today_cost_prices_by_model_when_present`：顶层 by_model 按实际
        模型定价（1M flash 全空闲 → 1.5）。"""
        out = budget._price_by_model(TODAY_BY_MODEL["by_model"], PRICING)
        self.assertAlmostEqual(out["total"], 1.5)
        self.assertEqual(out["peak_total"], 0.0)

    def test_today_cost_falls_back_to_bucket_cost_without_by_model(self):
        """对应 Rust `today_cost_falls_back_to_bucket_cost_without_by_model`：无
        by_model 的 buckets 逐桶 `_bucket_cost` 求和（1M → 1.5）。"""
        total = 0.0
        peak = 0.0
        for b in TODAY_BUCKETS["buckets"].values():
            c = budget._bucket_cost(b, PRICING)
            total += c["total"]
            peak += c.get("peak_total", 0.0)
        self.assertAlmostEqual(total, 1.5)
        self.assertEqual(peak, 0.0)


if __name__ == "__main__":
    unittest.main()
